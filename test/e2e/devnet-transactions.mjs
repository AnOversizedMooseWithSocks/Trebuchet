#!/usr/bin/env node
// Secret-gated Solana devnet transaction smoke.
//
// The long-lived GitHub Actions wallet is used only to fund a fresh ephemeral
// child wallet. Every operation after that funding transfer is signed by the
// child, and remaining SOL is swept back when the test finishes.

import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  AuthorityType,
  TOKEN_PROGRAM_ID,
  burn,
  closeAccount,
  createMint,
  getAccount,
  getMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  setAuthority,
} from '@solana/spl-token';
import { redactSensitiveText } from '../../logRedaction.js';

export const DEVNET_GENESIS_HASH = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
export const DEFAULT_MAX_SPEND_SOL = 0.03;
export const ABSOLUTE_MAX_SPEND_SOL = 0.1;
export const MIN_MAX_SPEND_SOL = 0.01;

const CONFIRM_OPTIONS = Object.freeze({
  commitment: 'confirmed',
  preflightCommitment: 'confirmed',
  maxRetries: 5,
});

export function decodeWalletSecret(secretB64) {
  assert.equal(typeof secretB64, 'string', 'devnet wallet secret must be a base64 string');
  assert.ok(secretB64.trim(), 'devnet wallet secret is empty');

  let parsed;
  try {
    const decoded = Buffer.from(secretB64.trim(), 'base64').toString('utf8');
    parsed = JSON.parse(decoded);
  } catch {
    throw new Error('devnet wallet secret must be base64-encoded JSON');
  }

  assert.ok(Array.isArray(parsed), 'decoded devnet wallet secret must be a JSON array');
  assert.equal(parsed.length, 64, 'decoded devnet wallet secret must contain 64 bytes');
  assert.ok(
    parsed.every((value) => Number.isInteger(value) && value >= 0 && value <= 255),
    'decoded devnet wallet secret contains an invalid byte',
  );
  return Uint8Array.from(parsed);
}

export function parseMaxSpendSol(value = DEFAULT_MAX_SPEND_SOL) {
  const amount = Number(value);
  assert.ok(Number.isFinite(amount), 'devnet max spend must be a finite number');
  assert.ok(
    amount >= MIN_MAX_SPEND_SOL && amount <= ABSOLUTE_MAX_SPEND_SOL,
    `devnet max spend must be between ${MIN_MAX_SPEND_SOL} and ${ABSOLUTE_MAX_SPEND_SOL} SOL`,
  );
  return amount;
}

export function assertDevnetGenesisHash(genesisHash) {
  assert.equal(
    genesisHash,
    DEVNET_GENESIS_HASH,
    `refusing transactions: RPC genesis hash ${genesisHash || '(missing)'} is not Solana devnet`,
  );
}

function safeMessage(error, rpcUrl = '') {
  let message = redactSensitiveText(error?.message || String(error));
  if (rpcUrl) message = message.replaceAll(rpcUrl, '[DEVNET_RPC]');
  return message;
}

async function sweepChildBalance(connection, child, destination) {
  const balance = await connection.getBalance(child.publicKey, 'confirmed');
  if (balance <= 0) return null;

  const latest = await connection.getLatestBlockhash('confirmed');
  const probe = new Transaction({
    feePayer: child.publicKey,
    recentBlockhash: latest.blockhash,
  }).add(SystemProgram.transfer({
    fromPubkey: child.publicKey,
    toPubkey: destination,
    lamports: 1,
  }));
  const feeResponse = await connection.getFeeForMessage(probe.compileMessage(), 'confirmed');
  const fee = feeResponse.value ?? 5_000;
  const sweepAmount = balance - fee;
  if (sweepAmount <= 0) return null;

  const transaction = new Transaction({
    feePayer: child.publicKey,
    recentBlockhash: latest.blockhash,
  }).add(SystemProgram.transfer({
    fromPubkey: child.publicKey,
    toPubkey: destination,
    lamports: sweepAmount,
  }));
  transaction.sign(child);
  const signature = await connection.sendRawTransaction(transaction.serialize(), {
    maxRetries: 5,
    skipPreflight: false,
  });
  await connection.confirmTransaction({ signature, ...latest }, 'confirmed');
  return signature;
}

async function cleanupTokenAccount({
  connection,
  child,
  fundingWallet,
  mint,
  tokenAccount,
}) {
  if (!mint || !tokenAccount) return;
  try {
    const account = await getAccount(connection, tokenAccount, 'confirmed', TOKEN_PROGRAM_ID);
    if (account.amount > 0n) {
      await burn(
        connection,
        child,
        tokenAccount,
        mint,
        child,
        account.amount,
        [],
        CONFIRM_OPTIONS,
        TOKEN_PROGRAM_ID,
      );
    }
    await closeAccount(
      connection,
      child,
      tokenAccount,
      fundingWallet.publicKey,
      child,
      [],
      CONFIRM_OPTIONS,
      TOKEN_PROGRAM_ID,
    );
  } catch {
    // The primary test error is more useful than a best-effort cleanup error.
    // Any unclosed account is owned by the ephemeral child, not the treasury.
  }
}

export async function runDevnetTransactionE2E(env = process.env) {
  const rpcUrl = env.TREBUCHET_DEVNET_RPC_URL?.trim() || '';
  const secretB64 = env.TREBUCHET_DEVNET_FUNDING_WALLET_SECRET_B64?.trim() || '';
  const expectedPublicKey = env.TREBUCHET_DEVNET_FUNDING_WALLET_PUBLIC_KEY?.trim() || '';
  const required = env.TREBUCHET_DEVNET_REQUIRED === '1';

  if (!rpcUrl || !secretB64 || !expectedPublicKey) {
    const missing = [
      !rpcUrl && 'TREBUCHET_DEVNET_RPC_URL',
      !secretB64 && 'TREBUCHET_DEVNET_FUNDING_WALLET_SECRET_B64',
      !expectedPublicKey && 'TREBUCHET_DEVNET_FUNDING_WALLET_PUBLIC_KEY',
    ].filter(Boolean);
    if (required) throw new Error(`missing required devnet configuration: ${missing.join(', ')}`);
    console.log(`Devnet transaction E2E skipped: missing ${missing.join(', ')}`);
    return { skipped: true };
  }

  const maxSpendSol = parseMaxSpendSol(
    env.TREBUCHET_DEVNET_MAX_SPEND_SOL || DEFAULT_MAX_SPEND_SOL,
  );
  const maxSpendLamports = Math.floor(maxSpendSol * LAMPORTS_PER_SOL);
  const childFundingLamports = Math.min(
    20_000_000,
    Math.floor(maxSpendLamports * 0.75),
  );
  assert.ok(
    childFundingLamports >= 7_500_000,
    'devnet max spend is too small to cover mint rent and transaction fees',
  );

  const fundingWallet = Keypair.fromSecretKey(decodeWalletSecret(secretB64));
  assert.equal(
    fundingWallet.publicKey.toBase58(),
    expectedPublicKey,
    'configured devnet funding-wallet public key does not match its secret',
  );

  const connection = new Connection(rpcUrl, {
    commitment: 'confirmed',
    confirmTransactionInitialTimeout: 60_000,
  });
  assertDevnetGenesisHash(await connection.getGenesisHash());

  const initialFundingBalance = await connection.getBalance(
    fundingWallet.publicKey,
    'confirmed',
  );
  assert.ok(
    initialFundingBalance >= maxSpendLamports + 20_000_000,
    `devnet funding wallet needs at least ${(maxSpendSol + 0.02).toFixed(3)} SOL`,
  );

  const child = Keypair.generate();
  let mint = null;
  let tokenAccount = null;
  let fundingSignature = null;
  let sweepSignature = null;
  let primaryError = null;

  try {
    fundingSignature = await sendAndConfirmTransaction(
      connection,
      new Transaction().add(SystemProgram.transfer({
        fromPubkey: fundingWallet.publicKey,
        toPubkey: child.publicKey,
        lamports: childFundingLamports,
      })),
      [fundingWallet],
      CONFIRM_OPTIONS,
    );

    mint = await createMint(
      connection,
      child,
      child.publicKey,
      child.publicKey,
      9,
      undefined,
      CONFIRM_OPTIONS,
      TOKEN_PROGRAM_ID,
    );
    const associated = await getOrCreateAssociatedTokenAccount(
      connection,
      child,
      mint,
      child.publicKey,
      false,
      'confirmed',
      CONFIRM_OPTIONS,
      TOKEN_PROGRAM_ID,
    );
    tokenAccount = associated.address;

    const mintedAmount = 1_000_000_000n;
    await mintTo(
      connection,
      child,
      mint,
      tokenAccount,
      child,
      mintedAmount,
      [],
      CONFIRM_OPTIONS,
      TOKEN_PROGRAM_ID,
    );
    const fundedAccount = await getAccount(
      connection,
      tokenAccount,
      'confirmed',
      TOKEN_PROGRAM_ID,
    );
    assert.equal(fundedAccount.amount, mintedAmount, 'devnet mint-to amount did not land');

    await setAuthority(
      connection,
      child,
      mint,
      child,
      AuthorityType.MintTokens,
      null,
      [],
      CONFIRM_OPTIONS,
      TOKEN_PROGRAM_ID,
    );
    await setAuthority(
      connection,
      child,
      mint,
      child,
      AuthorityType.FreezeAccount,
      null,
      [],
      CONFIRM_OPTIONS,
      TOKEN_PROGRAM_ID,
    );
    const lockedMint = await getMint(connection, mint, 'confirmed', TOKEN_PROGRAM_ID);
    assert.equal(lockedMint.mintAuthority, null, 'mint authority was not revoked');
    assert.equal(lockedMint.freezeAuthority, null, 'freeze authority was not revoked');

    await burn(
      connection,
      child,
      tokenAccount,
      mint,
      child,
      mintedAmount,
      [],
      CONFIRM_OPTIONS,
      TOKEN_PROGRAM_ID,
    );
    await closeAccount(
      connection,
      child,
      tokenAccount,
      fundingWallet.publicKey,
      child,
      [],
      CONFIRM_OPTIONS,
      TOKEN_PROGRAM_ID,
    );
    tokenAccount = null;

    const emptiedMint = await getMint(connection, mint, 'confirmed', TOKEN_PROGRAM_ID);
    assert.equal(emptiedMint.supply, 0n, 'devnet mint supply was not burned back to zero');
  } catch (error) {
    primaryError = error;
  } finally {
    await cleanupTokenAccount({
      connection,
      child,
      fundingWallet,
      mint,
      tokenAccount,
    });
    try {
      sweepSignature = await sweepChildBalance(
        connection,
        child,
        fundingWallet.publicKey,
      );
    } catch (cleanupError) {
      if (!primaryError) primaryError = cleanupError;
    }
  }

  const finalFundingBalance = await connection.getBalance(
    fundingWallet.publicKey,
    'confirmed',
  );
  const spentLamports = Math.max(0, initialFundingBalance - finalFundingBalance);
  assert.ok(
    spentLamports <= maxSpendLamports,
    `devnet test spent ${spentLamports / LAMPORTS_PER_SOL} SOL, above the ${maxSpendSol} SOL cap`,
  );
  if (primaryError) throw primaryError;

  const result = {
    skipped: false,
    fundingWallet: fundingWallet.publicKey.toBase58(),
    childWallet: child.publicKey.toBase58(),
    mint: mint.toBase58(),
    fundingSignature,
    sweepSignature,
    spentSol: spentLamports / LAMPORTS_PER_SOL,
  };
  console.log(`Devnet transaction E2E passed: ${JSON.stringify(result)}`);
  return result;
}

const isMain = process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runDevnetTransactionE2E().catch((error) => {
    console.error(`Devnet transaction E2E failed: ${safeMessage(error, process.env.TREBUCHET_DEVNET_RPC_URL)}`);
    process.exitCode = 1;
  });
}
