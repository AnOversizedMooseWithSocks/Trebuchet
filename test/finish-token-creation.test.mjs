// test/finish-token-creation.test.mjs
//
// Tests for finishTokenCreation — the resume path for a token whose creation
// was interrupted AFTER the mint already existed. Driven entirely through the
// tokenService DI seams: NO network, NO real RPC, NO Irys.
//
// The umi-based ops (createV1/updateV1) and the spl-token sends cannot complete
// against a fake connection, so these tests cover the parts that are decided by
// finishTokenCreation's own control flow:
//   - on-chain DETECTION of what is already done (mint supply, mint authority,
//     metadata existence, metadata update authority),
//   - the idempotency SKIP (nothing re-done when everything is already on-chain),
//   - the best-effort, non-fatal update-authority step,
//   - the JOURNAL-vs-CHAIN sanity cross-check,
//   - the guard that refuses to recreate metadata without a metadataUri.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';

// finishTokenCreation does not touch the launch journal (events are passed in),
// but tokenService pulls TREBUCHET_CONFIG_DIR transitively; point it at a tmp.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
process.env.TREBUCHET_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'treb-finish-'));

const tokenService = await import('../tokenService.js');
const { makeFakeConnection, makeFakeUmi } = await import('./helpers/mockSolana.mjs');

// A real (throwaway, never-funded) keypair: finishTokenCreation calls
// Keypair.fromSecretKey before any network step, so it must be valid key material.
const SECRET_KEY = Array.from(Keypair.generate().secretKey);

const TOKEN_METADATA_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
const TOTAL_SUPPLY = '1000000';
const TOTAL_RAW = BigInt(TOTAL_SUPPLY) * 10n ** 9n; // 1e15

function metaPda(mint) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('metadata'), TOKEN_METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    TOKEN_METADATA_PROGRAM_ID,
  )[0];
}

// Craft an 82-byte SPL mint account buffer so getMint() can unpack it.
// Layout: mintAuthorityOption(4) | mintAuthority(32) | supply(8 LE) |
//         decimals(1) | isInitialized(1) | freezeAuthorityOption(4) | freeze(32)
function makeMintAccount({ supplyRaw, mintAuthority }) {
  const buf = Buffer.alloc(82);
  if (mintAuthority) {
    buf.writeUInt32LE(1, 0);
    new PublicKey(mintAuthority).toBuffer().copy(buf, 4);
  } else {
    buf.writeUInt32LE(0, 0); // None == renounced
  }
  buf.writeBigUInt64LE(BigInt(supplyRaw), 36);
  buf.writeUInt8(9, 44); // decimals
  buf.writeUInt8(1, 45); // isInitialized
  buf.writeUInt32LE(0, 46); // freezeAuthorityOption = None
  return { data: buf, owner: TOKEN_PROGRAM_ID };
}

// Craft a metadata account buffer. Byte 0 is the key; bytes 1..33 are the
// update authority. Revoked == all-zero (System Program) address.
function makeMetadataAccount({ revoked }) {
  const buf = Buffer.alloc(679);
  buf.writeUInt8(4, 0); // MetadataV1 key
  if (!revoked) Keypair.generate().publicKey.toBuffer().copy(buf, 1);
  return { data: buf, owner: TOKEN_METADATA_PROGRAM_ID };
}

// Build a connection whose getAccountInfo answers for the mint + metadata PDA.
function connFor(mintB58, pdaB58, { mintAccount, metaAccount }) {
  return makeFakeConnection({
    getAccountInfo: async (pk) => {
      const b = pk.toBase58();
      if (b === mintB58) return mintAccount;
      if (b === pdaB58) return metaAccount; // may be null
      return { data: Buffer.alloc(0), owner: null };
    },
  });
}

test('existing SPL mints use the metadata-only Metaplex instruction', () => {
  const source = fs.readFileSync(new URL('../tokenService.js', import.meta.url), 'utf8');
  assert.match(source, /createMetadataAccountV3/);
  assert.match(source, /function createMetadataForExistingMint/);
  assert.match(source, /mintAuthority:\s*umi\.identity/);
  assert.doesNotMatch(source, /\bcreateV1\s*\(/);
});

test('finish supply retries only the validated fresh-account propagation race', () => {
  const source = fs.readFileSync(new URL('../tokenService.js', import.meta.url), 'utf8');
  assert.match(source, /verifyMintSupplyAccounts/);
  assert.match(source, /retryIf:\s*\(error\)\s*=>\s*isFreshTokenAccountPropagationError\(error\)/);
  assert.match(source, /mintInfo\.supply\s*<\s*totalTokens/);
});

test.afterEach(() => {
  tokenService.resetConnectionFactoryForTests?.();
  tokenService.resetMetadataFactoriesForTests?.();
});

test('finishTokenCreation: everything already on-chain -> no-op, reports safe, no sanity flags', async () => {
  const mintKp = Keypair.generate();
  const mintB58 = mintKp.publicKey.toBase58();
  const pda = metaPda(mintKp.publicKey);

  tokenService.setConnectionFactoryForTests(() => connFor(mintB58, pda.toBase58(), {
    mintAccount: makeMintAccount({ supplyRaw: TOTAL_RAW, mintAuthority: null }),
    metaAccount: makeMetadataAccount({ revoked: true }),
  }));
  tokenService.setUmiFactoryForTests(() => makeFakeUmi());

  const status = await tokenService.finishTokenCreation({
    tempWalletSecretKey: SECRET_KEY,
    tokenMint: mintB58,
    name: 'T',
    symbol: 'T',
    totalSupply: TOTAL_SUPPLY,
    metadataUri: 'https://arweave.test/m',
    // journal claims match on-chain reality exactly -> no discrepancies
    journalEvents: [
      { stage: 'supply_minted', txId: 'sig-supply' },
      { stage: 'mint_authority_revoked', txId: 'sig-renounce' },
      { stage: 'metadata_update_authority_revoked' },
    ],
  });

  assert.equal(status.metadataExists, true);
  assert.equal(status.supplyMinted, true);
  assert.equal(status.mintAuthorityRenounced, true);
  assert.equal(status.updateAuthorityRevoked, true);
  assert.equal(status.isSafe, true);
  assert.deepEqual(status.steps, [], 'nothing should be re-done');
  assert.deepEqual(status.sanity, [], 'journal matches chain -> no flags');
});

test('liquidity gate rejects a zero-supply interrupted mint and accepts a finished token', async () => {
  const mintKp = Keypair.generate();
  const mintB58 = mintKp.publicKey.toBase58();
  const pda = metaPda(mintKp.publicKey);
  const launchAuthority = Keypair.generate().publicKey.toBase58();

  tokenService.setConnectionFactoryForTests(() => connFor(mintB58, pda.toBase58(), {
    mintAccount: makeMintAccount({ supplyRaw: 0n, mintAuthority: launchAuthority }),
    metaAccount: makeMetadataAccount({ revoked: false }),
  }));
  let status = await tokenService.inspectTokenCreationStatus({
    tokenMint: mintB58,
    totalSupply: TOTAL_SUPPLY,
    decimals: 9,
  });
  assert.equal(status.complete, false);
  assert.equal(status.supplyMatches, false);

  tokenService.setConnectionFactoryForTests(() => connFor(mintB58, pda.toBase58(), {
    mintAccount: makeMintAccount({ supplyRaw: TOTAL_RAW, mintAuthority: null }),
    metaAccount: makeMetadataAccount({ revoked: true }),
  }));
  status = await tokenService.inspectTokenCreationStatus({
    tokenMint: mintB58,
    totalSupply: TOTAL_SUPPLY,
    decimals: 9,
  });
  assert.equal(status.complete, true);
  assert.equal(status.actualSupply, TOTAL_RAW.toString());
});

test('finishTokenCreation: update authority not yet revoked -> best-effort step is non-fatal, sanity flags the journal claim', async () => {
  const mintKp = Keypair.generate();
  const mintB58 = mintKp.publicKey.toBase58();
  const pda = metaPda(mintKp.publicKey);

  tokenService.setConnectionFactoryForTests(() => connFor(mintB58, pda.toBase58(), {
    mintAccount: makeMintAccount({ supplyRaw: TOTAL_RAW, mintAuthority: null }),
    metaAccount: makeMetadataAccount({ revoked: false }), // still ours on-chain
  }));
  // Fake umi cannot build updateV1 -> the revoke attempt throws and is caught.
  tokenService.setUmiFactoryForTests(() => makeFakeUmi());

  const status = await tokenService.finishTokenCreation({
    tempWalletSecretKey: SECRET_KEY,
    tokenMint: mintB58,
    name: 'T',
    symbol: 'T',
    totalSupply: TOTAL_SUPPLY,
    metadataUri: 'https://arweave.test/m',
    // journal says update authority was revoked, but chain shows it is not
    journalEvents: [{ stage: 'metadata_update_authority_revoked' }],
  });

  assert.equal(status.metadataExists, true);
  assert.equal(status.supplyMinted, true);
  assert.equal(status.mintAuthorityRenounced, true);
  assert.equal(status.updateAuthorityRevoked, false, 'revoke could not complete with fake umi');
  assert.equal(status.isSafe, false);
  assert.ok(
    status.steps.some((s) => s.startsWith('could not revoke metadata update authority')),
    'best-effort failure is recorded, not thrown',
  );
  assert.ok(
    status.sanity.some((s) => s.includes('update-authority')),
    'sanity check flags the journal-vs-chain discrepancy',
  );
});

test('finishTokenCreation: metadata missing and no metadataUri -> refuses (cannot recreate metadata)', async () => {
  const mintKp = Keypair.generate();
  const mintB58 = mintKp.publicKey.toBase58();
  const pda = metaPda(mintKp.publicKey);
  const someAuthority = Keypair.generate().publicKey.toBase58();

  tokenService.setConnectionFactoryForTests(() => connFor(mintB58, pda.toBase58(), {
    mintAccount: makeMintAccount({ supplyRaw: 0n, mintAuthority: someAuthority }),
    metaAccount: null, // metadata account does not exist
  }));
  tokenService.setUmiFactoryForTests(() => makeFakeUmi());

  await assert.rejects(
    () => tokenService.finishTokenCreation({
      tempWalletSecretKey: SECRET_KEY,
      tokenMint: mintB58,
      name: 'T',
      symbol: 'T',
      totalSupply: TOTAL_SUPPLY,
      // metadataUri intentionally omitted
    }),
    /metadata account is missing and no metadataUri/,
  );
});

test('finishTokenCreation: unreadable mint -> clear error (cannot proceed without on-chain truth)', async () => {
  const mintKp = Keypair.generate();
  const mintB58 = mintKp.publicKey.toBase58();
  const pda = metaPda(mintKp.publicKey);

  // getAccountInfo for the mint returns an empty buffer -> getMint cannot unpack.
  tokenService.setConnectionFactoryForTests(() => connFor(mintB58, pda.toBase58(), {
    mintAccount: { data: Buffer.alloc(0), owner: TOKEN_PROGRAM_ID },
    metaAccount: null,
  }));
  tokenService.setUmiFactoryForTests(() => makeFakeUmi());

  await assert.rejects(
    () => tokenService.finishTokenCreation({
      tempWalletSecretKey: SECRET_KEY,
      tokenMint: mintB58,
      name: 'T',
      symbol: 'T',
      totalSupply: TOTAL_SUPPLY,
      metadataUri: 'https://arweave.test/m',
    }),
    /cannot read mint/,
  );
});
