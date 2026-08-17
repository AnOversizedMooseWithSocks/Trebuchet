// walletHelpers.js
//
// Helpers used alongside tokenService.js. Two responsibilities:
//   1. Multi-token balance checking — for the funding step UI, which now
//      needs to display SOL balance plus per-token balances (so the user
//      knows when they've deposited the right amount of USDC etc.).
//   2. NFT sweeping — at the end of a launch, all NFTs in the ephemeral
//      wallet (Fee Keys from Burn & Earn-locked positions, mostly) need
//      to flow back to the user's destination wallet alongside the leftover
//      SOL and any unallocated launched tokens.
//
// IMPORTANT: Solana has TWO token programs — the classic SPL Token program
// and the newer Token-2022 program. They have DIFFERENT program IDs and
// you have to query each one separately to enumerate all of a wallet's
// tokens. Raydium CLMM position NFTs (and the Fee Key NFTs minted when
// Burn & Earn locks them) are minted under Token-2022, NOT classic SPL.
// Earlier versions of this file only queried the classic program — Fee
// Keys silently disappeared from the sweep. This version handles both.
//
// These helpers don't replace tokenService.js — they sit alongside it. The
// server orchestrates the post-launch sweep as:
//   1. sweepNftsToDestination       — Fee Keys, position NFTs, etc.
//   2. sweepAllTokensToDestination  — launched token + any auto-swap tokens
//   3. sweepSolToDestination        — remaining SOL (must be last; the token
//                                     transfers above consume SOL for fees)

import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
  Transaction,
  SystemProgram,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAccount,
} from '@solana/spl-token';
import { getRpcUrl } from './rpcConfig.js';
import {
  samplePriorityFeeMicroLamports,
  computeBudgetIxs,
  priorityFeeLamports,
  CU_SOL_TRANSFER,
  CU_TOKEN_TRANSFER,
  PRIORITY_FEE_CEIL_MICROLAMPORTS,
  SWEEP_FEE_PAD_LAMPORTS,
} from './priorityFees.js';

// Both token programs we need to query. Order matters only for log readability.
const TOKEN_PROGRAMS = [
  { id: TOKEN_PROGRAM_ID, name: 'classic' },
  { id: TOKEN_2022_PROGRAM_ID, name: 'token-2022' },
];

function makeConnection() {
  if (__connectionFactoryForTests) return __connectionFactoryForTests();
  return new Connection(getRpcUrl(), {
    commitment: 'confirmed',
    confirmTransactionInitialTimeout: 60_000,
  });
}

// ---------------------------------------------------------------------------
// Multi-token balance check
// ---------------------------------------------------------------------------

/**
 * Returns SOL balance plus balances for every SPL token (classic AND
 * Token-2022) the wallet holds.
 *
 * Result shape:
 *   {
 *     sol: 1.234,
 *     tokens: {
 *       '<mintAddress>': {
 *         amountRaw: '12345678',
 *         amountUi: 12.345678,
 *         decimals: 6,
 *         programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' // or token-2022
 *       },
 *       ...
 *     }
 *   }
 */
export async function checkWalletBalanceMultiToken(publicKey) {
  const connection = makeConnection();
  const pubKey = new PublicKey(publicKey);

  // SOL balance
  const lamports = await connection.getBalance(pubKey);
  const sol = lamports / LAMPORTS_PER_SOL;

  // Token balances — query BOTH classic and Token-2022 programs and merge.
  // Done in parallel since the two RPC calls are independent.
  const respPairs = await Promise.all(
    TOKEN_PROGRAMS.map(async (prog) => ({
      programId: prog.id.toBase58(),
      resp: await connection.getParsedTokenAccountsByOwner(pubKey, {
        programId: prog.id,
      }),
    })),
  );

  const tokens = {};
  for (const { programId, resp } of respPairs) {
    for (const acc of resp.value) {
      const info = acc.account.data.parsed.info;
      const mint = info.mint;
      const amountRaw = info.tokenAmount.amount;
      const amountUi = info.tokenAmount.uiAmount;
      const decimals = info.tokenAmount.decimals;

      // Aggregate duplicate accounts for the same mint (rare but possible)
      if (tokens[mint]) {
        tokens[mint].amountRaw = (
          BigInt(tokens[mint].amountRaw) + BigInt(amountRaw)
        ).toString();
        tokens[mint].amountUi += amountUi || 0;
      } else {
        tokens[mint] = {
          amountRaw,
          amountUi: amountUi || 0,
          decimals,
          programId,
        };
      }
    }
  }

  return { sol, tokens };
}

// ---------------------------------------------------------------------------
// NFT enumeration and sweep
// ---------------------------------------------------------------------------

/**
 * Find all NFTs (token accounts where amount=1 and decimals=0) owned by
 * the wallet across BOTH classic SPL and Token-2022 programs, optionally
 * excluding specific mints.
 *
 * Returns an array of { mint, ata, programId, programName } objects. The
 * programId is critical — it's needed when building the transfer instruction,
 * since classic and Token-2022 use different program IDs.
 */
export async function findOwnedNfts(publicKey, excludeMints = []) {
  const connection = makeConnection();
  const pubKey = new PublicKey(publicKey);
  const excludeSet = new Set(excludeMints);

  // Query both token programs in parallel
  const respPairs = await Promise.all(
    TOKEN_PROGRAMS.map(async (prog) => ({
      programId: prog.id,
      programName: prog.name,
      resp: await connection.getParsedTokenAccountsByOwner(pubKey, {
        programId: prog.id,
      }),
    })),
  );

  const nfts = [];
  for (const { programId, programName, resp } of respPairs) {
    for (const acc of resp.value) {
      const info = acc.account.data.parsed.info;
      const mint = info.mint;
      const amount = info.tokenAmount.amount;
      const decimals = info.tokenAmount.decimals;

      // NFT signature: amount === '1' AND decimals === 0
      if (amount === '1' && decimals === 0 && !excludeSet.has(mint)) {
        nfts.push({
          mint,
          ata: acc.pubkey.toBase58(),
          programId,    // PublicKey instance — used directly for transfers
          programName,
        });
      }
    }
  }

  return nfts;
}

// ---------------------------------------------------------------------------
// Sweep retry infrastructure (used by both NFT sweep and fungible sweep)
// ---------------------------------------------------------------------------
//
// The per-item transfer calls inside the sweep loops could previously fail on
// a transient RPC blip — 429, gateway timeout, expired blockhash — and the
// user had to re-click Transfer to retry. With multi-pool launches that
// produce 15+ Fee Key NFTs, hitting a single transient error mid-sweep was
// likely enough to be annoying. These helpers wrap each transfer with the
// same bounded-retry + exponential-backoff pattern the airdrop uses, against
// the same generic transient-RPC classifier (isTransientAirdropError is a
// historical name; it's a pure RPC-transient check).
//
// The constants intentionally match the airdrop's tunables so a launch
// hitting flaky RPC sees consistent behaviour across the airdrop and the
// sweep — no surprising "the airdrop is patient but the sweep gives up
// after one try" pattern.
const SWEEP_MAX_ATTEMPTS = 3;
const SWEEP_BACKOFF_MS = [1000, 3000, 7000];
const SWEEP_TX_PACING_MS = 250;

// Wraps a single transfer call with bounded retries. Returns the txId on
// success; throws the last error (with .attempts attached) when every
// attempt fails. Only retries transient errors — a permanent error
// (insufficient funds, mismatched program ID, etc.) fails fast on the
// first attempt so we don't waste 11 seconds discovering the same thing
// 3 times. `label` is logged for traceability.
async function withSweepRetries(label, fn) {
  let lastErr;
  for (let attempt = 1; attempt <= SWEEP_MAX_ATTEMPTS; attempt++) {
    try {
      const result = await fn();
      if (attempt > 1) {
        console.log(`  ${label}: succeeded on attempt ${attempt}`);
      }
      return result;
    } catch (err) {
      lastErr = err;
      const transient = isTransientAirdropError(err);
      if (!transient || attempt === SWEEP_MAX_ATTEMPTS) {
        // Either a permanent error (fail fast) or we've exhausted
        // attempts. Attach attempts count for the caller's diagnostic.
        if (lastErr && typeof lastErr === 'object') lastErr.attempts = attempt;
        throw lastErr;
      }
      const backoff = SWEEP_BACKOFF_MS[attempt - 1] || 7000;
      console.warn(
        `  ${label}: transient error on attempt ${attempt}/${SWEEP_MAX_ATTEMPTS} `
        + `(${err.message || err}); retrying in ${backoff}ms`,
      );
      await sleep(backoff);
    }
  }
  // Defensive — the loop body always either returns or throws, but a
  // bare `throw lastErr` here keeps TypeScript happy and protects
  // against future refactors.
  throw lastErr;
}

/**
 * Transfer every NFT owned by the ephemeral wallet to the destination
 * wallet. Handles both classic SPL and Token-2022 NFTs correctly by using
 * the appropriate program ID for each transfer.
 *
 * Returns { transferred: [{ mint, txId, programName }, ...], errors: [...] }
 */
export async function sweepNftsToDestination({
  tempWalletSecretKey,
  destinationWallet,
  excludeMints = [],
}) {
  const connection = makeConnection();
  const ownerKeypair = Keypair.fromSecretKey(Uint8Array.from(tempWalletSecretKey));
  const destPk = new PublicKey(destinationWallet);

  const nfts = await findOwnedNfts(
    ownerKeypair.publicKey.toBase58(),
    excludeMints,
  );

  console.log(`Found ${nfts.length} NFT(s) to sweep to ${destinationWallet}`);
  for (const n of nfts) {
    console.log(`  - ${n.mint} (${n.programName})`);
  }

  const transferred = [];
  const errors = [];

  for (const nft of nfts) {
    try {
      const txId = await withSweepRetries(
        `nft ${nft.mint}`,
        () => transferTokenWithProgram({
          connection,
          ownerKeypair,
          mint: new PublicKey(nft.mint),
          destination: destPk,
          amount: 1n,        // NFTs always have amount=1
          decimals: 0,       // NFTs always have decimals=0
          programId: nft.programId,
        }),
      );
      console.log(`  swept ${nft.mint} (${nft.programName}): ${txId}`);
      transferred.push({ mint: nft.mint, txId, programName: nft.programName });
    } catch (err) {
      console.error(`  failed to sweep ${nft.mint}:`, err.message);
      errors.push({ mint: nft.mint, error: err.message });
    }
    // Inter-item pacing. Matches the lock/transfer phase pacing in
    // lpService.js — the natural per-tx wait keeps us safe on most
    // endpoints, but bursts of consecutive successes can still hit
    // per-second caps on free-tier RPCs.
    await sleep(SWEEP_TX_PACING_MS);
  }

  return { transferred, errors };
}

/**
 * Sweep ALL fungible SPL tokens (classic and Token-2022) from the temp
 * wallet to the destination wallet. Filters out NFTs (decimals=0 with
 * amount=1) since those are handled by sweepNftsToDestination, and
 * filters out any caller-specified exclude mints.
 *
 * This is the part of the post-launch cleanup that recovers tokens
 * acquired via auto-swap during funding (e.g. BITCOIN, GIGA, etc.) as
 * well as the launched token itself. The previous implementation only
 * handled the single launched-token mint, leaving any non-launched
 * tokens stranded in the ephemeral wallet.
 *
 * Returns { transferred: [{ mint, amount, decimals, txId }], errors: [...] }.
 * Per-token errors are isolated — one bad transfer doesn't abort the rest.
 *
 * IMPORTANT: this function does NOT touch SOL. Callers must invoke it
 * BEFORE the SOL sweep, because each token transfer here costs SOL for
 * tx fees and possibly destination-ATA rent (~0.002 SOL each). If SOL
 * is swept first, these transfers fail with insufficient lamports.
 */
export async function sweepAllTokensToDestination({
  tempWalletSecretKey,
  destinationWallet,
  excludeMints = [],
}) {
  const connection = makeConnection();
  const ownerKeypair = Keypair.fromSecretKey(Uint8Array.from(tempWalletSecretKey));
  const destPk = new PublicKey(destinationWallet);
  const excludeSet = new Set(excludeMints.filter(Boolean));

  // Read everything the wallet holds, then partition.
  const { tokens } = await checkWalletBalanceMultiToken(
    ownerKeypair.publicKey.toBase58(),
  );

  const fungibles = [];
  for (const [mint, info] of Object.entries(tokens)) {
    if (excludeSet.has(mint)) continue;
    // Skip NFTs — they're handled by sweepNftsToDestination. The signature
    // is decimals=0 with amount=1. Some pseudo-fungibles also have
    // decimals=0; we keep amount>1 here since position-NFTs always have
    // exactly 1 supply per holder.
    if (info.decimals === 0 && info.amountRaw === '1') continue;
    // Skip zero balances — common for ATAs that were created but never
    // received tokens (e.g. an auto-swap that failed before output landed).
    if (info.amountRaw === '0') continue;
    fungibles.push({ mint, ...info });
  }

  console.log(
    `Found ${fungibles.length} fungible token type(s) to sweep to ${destinationWallet}`,
  );
  for (const t of fungibles) {
    console.log(`  - ${t.mint} (${t.amountUi}, ${t.decimals}d)`);
  }

  const transferred = [];
  const errors = [];

  for (const t of fungibles) {
    try {
      const programId = t.programId === TOKEN_2022_PROGRAM_ID.toBase58()
        ? TOKEN_2022_PROGRAM_ID
        : TOKEN_PROGRAM_ID;
      const txId = await withSweepRetries(
        `token ${t.mint}`,
        () => transferTokenWithProgram({
          connection,
          ownerKeypair,
          mint: new PublicKey(t.mint),
          destination: destPk,
          amount: BigInt(t.amountRaw),
          decimals: t.decimals,
          programId,
        }),
      );
      console.log(`  swept ${t.mint} (${t.amountUi}): ${txId}`);
      transferred.push({
        mint: t.mint,
        amount: t.amountUi,
        decimals: t.decimals,
        txId,
      });
    } catch (err) {
      console.error(`  failed to sweep ${t.mint}:`, err.message);
      errors.push({ mint: t.mint, error: err.message });
    }
    // Inter-item pacing — same rationale as the NFT sweep loop above.
    await sleep(SWEEP_TX_PACING_MS);
  }

  return { transferred, errors };
}

/**
 * Transfer the wallet's remaining SOL to the destination, leaving only
 * the minimum required to keep the account alive plus a small fee
 * cushion. Returns 0 (no transfer needed) if the balance is too low.
 *
 * MUST be called AFTER all token/NFT sweeps. Each token transfer costs
 * tx fees in SOL; if SOL is moved first, the subsequent token transfers
 * fail with insufficient lamports.
 */
export async function sweepSolToDestination({
  tempWalletSecretKey,
  destinationWallet,
}) {
  const connection = makeConnection();
  const ownerKeypair = Keypair.fromSecretKey(Uint8Array.from(tempWalletSecretKey));
  const destPk = new PublicKey(destinationWallet);

  const solBalance = await connection.getBalance(ownerKeypair.publicKey);
  // The final sweep now pays a priority fee too — during congestion the
  // very last tx of a launch is not the one to leave un-prioritized. That
  // means the reserve must cover base fee (5000 lamports/signature) PLUS
  // the priority cost of this tx, or the sweep itself fails with
  // "insufficient lamports". The rent-exempt minimum keeps the account
  // alive after the sweep.
  const microLamports = await samplePriorityFeeMicroLamports(connection);
  const feeReserve = 5000
    + priorityFeeLamports(CU_SOL_TRANSFER, microLamports)
    + SWEEP_FEE_PAD_LAMPORTS; // never reserve exactly-enough; see priorityFees.js
  const minRentExemption = await connection.getMinimumBalanceForRentExemption(0);
  const transferAmount = solBalance - minRentExemption - feeReserve;

  console.log(`SOL sweep: balance=${solBalance / LAMPORTS_PER_SOL}, ` +
    `transferring=${transferAmount / LAMPORTS_PER_SOL}`);

  if (transferAmount <= 0) {
    return { solTransferred: 0 };
  }

  const tx = new Transaction().add(
    // ComputeBudget instructions FIRST (limit must be set before the app
    // instruction runs), then the transfer. See priorityFees.js.
    ...computeBudgetIxs({ units: CU_SOL_TRANSFER, microLamports }),
    SystemProgram.transfer({
      fromPubkey: ownerKeypair.publicKey,
      toPubkey: destPk,
      lamports: transferAmount,
    }),
  );

  const txId = await sendAndConfirmTransaction(connection, tx, [ownerKeypair], {
    commitment: 'confirmed',
  });
  console.log(`  SOL sweep tx: ${txId}`);

  return {
    solTransferred: transferAmount / LAMPORTS_PER_SOL,
    txId,
  };
}

/**
 * Transfer a token (NFT or fungible) from the owner's wallet to a destination,
 * specifying the token program explicitly. Handles ATA creation on both sides
 * idempotently — safe to call repeatedly.
 *
 * Exposed for use from lpService.js (slice-recipient Fee Key transfers) and
 * the sweep above. Built manually rather than using @solana/spl-token's
 * `transfer()` helper because that helper hardcodes the classic program ID.
 */
export async function transferTokenWithProgram({
  connection,
  ownerKeypair,
  mint,
  destination,
  amount,        // bigint
  decimals,      // number
  programId,     // PublicKey — TOKEN_PROGRAM_ID or TOKEN_2022_PROGRAM_ID
}) {
  // Compute ATA addresses. getAssociatedTokenAddressSync takes the program ID
  // — important for Token-2022, which derives ATAs differently from classic.
  const ownerAta = getAssociatedTokenAddressSync(
    mint,
    ownerKeypair.publicKey,
    /* allowOwnerOffCurve */ false,
    programId,
  );
  const destAta = getAssociatedTokenAddressSync(
    mint,
    destination,
    /* allowOwnerOffCurve */ false,
    programId,
  );

  const tx = new Transaction();

  // Priority fee: sampled fresh per transfer so each tx reflects current
  // conditions. This path serves every token/NFT sweep and the Fee Key
  // slice transfers — all post-launch money movements that must land.
  const microLamports = await samplePriorityFeeMicroLamports(connection);
  tx.add(...computeBudgetIxs({ units: CU_TOKEN_TRANSFER, microLamports }));

  // Idempotent ATA creation for the destination — does nothing if the ATA
  // already exists, otherwise creates it. Owner pays rent.
  tx.add(
    createAssociatedTokenAccountIdempotentInstruction(
      ownerKeypair.publicKey, // payer
      destAta,
      destination,
      mint,
      programId,
    ),
  );

  // TransferChecked is preferred over plain Transfer because it verifies the
  // mint and decimals against what the caller specified — catches mismatches
  // before they cost SOL. It's also REQUIRED for Token-2022 transfers.
  tx.add(
    createTransferCheckedInstruction(
      ownerAta,
      mint,
      destAta,
      ownerKeypair.publicKey,
      amount,
      decimals,
      [],
      programId,
    ),
  );

  return sendAndConfirmTransaction(connection, tx, [ownerKeypair], {
    commitment: 'confirmed',
  });
}

// ---------------------------------------------------------------------------
// Airdrop distribution
// ---------------------------------------------------------------------------
//
// Distributes the launched token from the ephemeral wallet to a list of
// recipient wallets according to the airdrop CSV. Called from the
// /api/transfer-assets endpoint (during the post-launch sweep), inserted
// BEFORE sweepAllTokensToDestination so the launched tokens are still in
// the ephemeral wallet when this runs.
//
// HARDENING DESIGN
// ----------------
//
// The airdrop is critical functionality and a high-volume RPC consumer
// (each recipient costs ~4-8 RPC calls). The implementation handles
// real-world failure modes carefully:
//
// 1. Per-recipient single-tx strategy: each recipient gets its own
//    transaction (idempotent ATA create + transferChecked). One bad
//    recipient doesn't void others; failure modes isolate cleanly.
//
// 2. SEPARATE send + confirm phases: we call sendRawTransaction
//    explicitly to get the signature, then confirmTransaction
//    separately. This lets us distinguish:
//      - Pre-send error (no signature) → tx never went out → SAFE to
//        retry with a new tx.
//      - Confirmation timeout (signature in hand, status unknown) →
//        ambiguous; the tx may or may not have landed. We do an
//        on-chain BALANCE CHECK against the recipient's token account
//        to disambiguate before deciding to retry. Without this, a
//        confirmation timeout where the tx actually landed would lead
//        to either a false "failed" status (if we don't retry) OR
//        double-payment (if we naively re-send).
//      - Confirmation reports an explicit failure → tx ran on chain
//        and failed (e.g. insufficient lamports for rent) → not safe
//        to blindly retry the same tx; we surface the error.
//
// 3. Error classification: isTransientAirdropError() identifies RPC
//    rate-limit errors (429), gateway timeouts (502/503), network
//    errors (ECONNRESET, ETIMEDOUT), and Solana-specific transient
//    errors ("blockhash not found", "Node is behind"). These trigger
//    backoff + retry. Other errors (insufficient funds, invalid mint,
//    transaction failed on chain) are treated as permanent and not
//    retried.
//
// 4. Bounded retries: each recipient gets up to AIRDROP_MAX_ATTEMPTS
//    attempts with exponential backoff (AIRDROP_BACKOFF_MS). Total
//    worst-case time per recipient: ~11s + tx finalisation, so an
//    airdrop of 100 recipients with everything failing won't blow
//    past a few minutes before failing fast.
//
// 5. Adaptive pacing: starts with AIRDROP_PACE_MS_DEFAULT between
//    recipients (350ms = ~3 TPS, safely under most free-tier RPC
//    limits). On the first transient error, bumps PERMANENTLY to
//    AIRDROP_PACE_MS_SLOW (1500ms = ~0.7 TPS) for the rest of the
//    run. The pacing never decreases — once we know the endpoint
//    is slow, stay slow.
//
// 6. Circuit breaker: if AIRDROP_MAX_CONSECUTIVE_FAILS recipients
//    fail in a row (after retries), abort the remaining recipients
//    with a "circuit tripped" error rather than continue burning
//    SOL on more failures. The user retries from a clean baseline.
//
// 7. Periodic progress logging: every AIRDROP_LOG_EVERY_N recipients
//    (and at the end), log "N of M delivered, K failed" so the
//    operator can see progress in the server console for long runs.
//
// Return shape:
//   {
//     transferred: [ { wallet, tokens, amountRaw, txId, attempts }, ... ],
//     failed:      [ { wallet, tokens, amountRaw, error, signature?, attempts }, ... ],
//   }
// `signature` on a failed entry is present when the recipient hit a
// confirmation timeout that the balance check couldn't resolve — the
// caller can show this to the user for manual Solscan verification.
// `attempts` reports how many tries we made (1 = first-try success).

// Tunable constants. Conservative defaults — paid RPC providers will
// tolerate much more, but hitting a free-tier 429 mid-airdrop is a
// real failure mode worth designing around.
const AIRDROP_PACE_MS_DEFAULT = 350;
const AIRDROP_PACE_MS_SLOW = 1500;
const AIRDROP_MAX_ATTEMPTS = 3;
const AIRDROP_BACKOFF_MS = [1000, 3000, 7000];
const AIRDROP_MAX_CONSECUTIVE_FAILS = 5;
const AIRDROP_LOG_EVERY_N = 10;
const AIRDROP_CONFIRM_TIMEOUT_MS = 30_000; // per-tx confirmation budget
const AIRDROP_BALANCE_CHECK_RETRIES = 2;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Classify an error as transient (worth retrying) or permanent. The
// distinction matters because we want fast feedback on permanent errors
// (don't waste retries) but persistent attempts on transient ones (rate
// limits clear up; nodes catch up).
//
// We check the error message and any embedded HTTP status. Solana's RPC
// client surfaces 429 / 502 / 503 with patterns like "429 Too Many
// Requests" or "Server responded with 429" or just a fetch failure;
// node-level transient state surfaces as "blockhash not found" or
// "Node is behind by N slots".
function isTransientAirdropError(err) {
  if (!err) return false;
  const msg = String(err.message || err || '').toLowerCase();
  const code = err.code || err.cause?.code || '';
  // Network-level errors. node-fetch and undici surface these via err.code
  // on the cause chain; the message often contains "fetch failed" too.
  if (code === 'ECONNRESET' || code === 'ETIMEDOUT'
      || code === 'ECONNREFUSED' || code === 'ENETUNREACH'
      || code === 'EAI_AGAIN' || code === 'UND_ERR_SOCKET') {
    return true;
  }
  // HTTP-status errors. RPC providers return 429 for rate limits and
  // 502/503/504 when overloaded or restarting. The Solana web3 client
  // bubbles these up in the error message.
  if (msg.includes('429') || msg.includes('too many requests')
      || msg.includes('rate limit') || msg.includes('rate-limit')) {
    return true;
  }
  if (msg.includes('502') || msg.includes('503') || msg.includes('504')
      || msg.includes('bad gateway') || msg.includes('service unavailable')
      || msg.includes('gateway timeout')) {
    return true;
  }
  // Generic fetch failure — node-fetch throws "fetch failed" for most
  // network-layer problems before they get a chance to surface as a
  // specific code.
  if (msg.includes('fetch failed') || msg.includes('network error')
      || msg.includes('socket hang up')) {
    return true;
  }
  // Solana-specific transient states. "blockhash not found" means the
  // blockhash we used expired or wasn't propagated yet — retrying with
  // a fresh one usually works. "Node is behind" means the RPC node
  // we hit is lagging; retrying often hits a caught-up node (or the
  // same node after it catches up).
  if (msg.includes('blockhash not found')
      || msg.includes('node is behind')
      || msg.includes('block height exceeded')
      || msg.includes('transactionexpiredblockheightexceeded')) {
    return true;
  }
  return false;
}

// Build the airdrop transaction for a single recipient. Returns a
// signed Transaction ready to send. Separated from the send/confirm
// logic so retries can rebuild the tx with a fresh blockhash without
// duplicating the instruction-construction logic.
function buildAirdropTx({
  ownerKeypair,
  ownerAta,
  recipientPk,
  recipientAta,
  mintPk,
  amountRaw,
  tokenDecimals,
  programId,
  recentBlockhash,
  priorityFeeMicroLamports,
}) {
  const tx = new Transaction();
  tx.feePayer = ownerKeypair.publicKey;
  tx.recentBlockhash = recentBlockhash;
  // Priority fee, sampled once per airdrop run by executeAirdrop and
  // escalated per retry attempt by deliverOneAirdropRecipient. Airdrop
  // txs used to ride at zero priority — the first thing dropped when the
  // network is busy, and with many small txs per run the failure odds
  // compound per recipient.
  tx.add(...computeBudgetIxs({
    units: CU_TOKEN_TRANSFER,
    microLamports: priorityFeeMicroLamports,
  }));
  // Idempotent ATA creation for the recipient. No-op if their ATA
  // already exists. Owner pays the rent either way.
  tx.add(
    createAssociatedTokenAccountIdempotentInstruction(
      ownerKeypair.publicKey,
      recipientAta,
      recipientPk,
      mintPk,
      programId,
    ),
  );
  // TransferChecked verifies mint + decimals on chain — catches client
  // mismatches before SOL is spent. Also required for Token-2022.
  tx.add(
    createTransferCheckedInstruction(
      ownerAta,
      mintPk,
      recipientAta,
      ownerKeypair.publicKey,
      amountRaw,
      tokenDecimals,
      [],
      programId,
    ),
  );
  tx.sign(ownerKeypair);
  return tx;
}

// Verify on-chain whether a recipient's token account already holds at
// LEAST the expected amount. Used to disambiguate confirmation timeouts
// — if the tx actually landed despite the confirmation failure, the
// balance reflects it and we mark as delivered without retrying.
//
// Returns true if the balance is >= expectedAmount, false otherwise.
// Errors during the check (ATA doesn't exist, RPC blip) return false
// conservatively — better to retry an actually-delivered recipient
// (causing a duplicate that will fail on sender balance) than to
// falsely mark an undelivered one as delivered.
//
// Retries the balance check itself a few times for transient RPC
// errors, since this is the safety mechanism we rely on.
async function recipientHasAtLeast(connection, recipientAta, expectedAmount, programId) {
  for (let attempt = 0; attempt < AIRDROP_BALANCE_CHECK_RETRIES; attempt++) {
    try {
      const acct = await getAccount(connection, recipientAta, 'confirmed', programId);
      return BigInt(acct.amount.toString()) >= expectedAmount;
    } catch (err) {
      const msg = String(err.message || '').toLowerCase();
      // "TokenAccountNotFoundError" means the ATA doesn't exist yet,
      // which means our tx definitely didn't land (creating the ATA is
      // the first instruction). Treat as "balance is zero".
      if (msg.includes('tokenaccountnotfound') || msg.includes('could not find account')) {
        return false;
      }
      // Other errors: retry the balance check a couple times in case
      // they're transient. Last attempt failing falls through to
      // "false" — conservative.
      if (attempt < AIRDROP_BALANCE_CHECK_RETRIES - 1 && isTransientAirdropError(err)) {
        await sleep(1000);
        continue;
      }
      return false;
    }
  }
  return false;
}

// Attempt to deliver tokens to one recipient with retry + balance-check
// disambiguation. Returns either:
//   { ok: true, txId, attempts }       — delivered (or already had the balance)
//   { ok: false, error, signature?, attempts } — failed after all retries
//
// The `signature` on a failed result is present when the failure was a
// confirmation timeout — the tx might still land later; the user can
// verify on Solscan with this signature.
async function deliverOneAirdropRecipient({
  connection,
  ownerKeypair,
  ownerAta,
  recipientPk,
  recipientAta,
  mintPk,
  amountRaw,
  tokenDecimals,
  programId,
  priorityFeeMicroLamports,
}) {
  let lastError = null;
  let lastSignature = null;

  for (let attempt = 1; attempt <= AIRDROP_MAX_ATTEMPTS; attempt++) {
    // Backoff before each attempt after the first. The backoff array is
    // sized to (MAX_ATTEMPTS - 1) values — index 0 used before attempt 2,
    // index 1 before attempt 3, etc.
    if (attempt > 1) {
      const delay = AIRDROP_BACKOFF_MS[attempt - 2] || AIRDROP_BACKOFF_MS[AIRDROP_BACKOFF_MS.length - 1];
      await sleep(delay);
    }

    // Fetch a fresh blockhash for each attempt. Reusing a stale one
    // would fail with "blockhash not found" — pointless retry.
    let blockhash;
    let lastValidBlockHeight;
    try {
      const latest = await connection.getLatestBlockhash('confirmed');
      blockhash = latest.blockhash;
      lastValidBlockHeight = latest.lastValidBlockHeight;
    } catch (err) {
      lastError = err;
      if (isTransientAirdropError(err) && attempt < AIRDROP_MAX_ATTEMPTS) continue;
      return { ok: false, error: `Blockhash fetch failed: ${err.message}`, attempts: attempt };
    }

    // Build + sign tx. Cheap and deterministic; doesn't touch RPC.
    //
    // Fee escalation on retry: double the bid each attempt (x1, x2, x4),
    // clamped at the global ceiling. If attempt 1 didn't land, current
    // conditions demand more than our sample said — the standard
    // retry-with-higher-fee pattern. The ceiling keeps the worst case
    // bounded (see priorityFees.js cost math).
    const escalatedFee = Math.min(
      PRIORITY_FEE_CEIL_MICROLAMPORTS,
      priorityFeeMicroLamports * (2 ** (attempt - 1)),
    );
    const tx = buildAirdropTx({
      ownerKeypair, ownerAta, recipientPk, recipientAta, mintPk,
      amountRaw, tokenDecimals, programId, recentBlockhash: blockhash,
      priorityFeeMicroLamports: escalatedFee,
    });

    // Phase 1: send. Pre-send errors are clean retries (the tx didn't
    // go out, no risk of double-pay). We use sendRawTransaction
    // explicitly so we get the signature back without coupling to
    // confirmation — important because confirmation timeouts are
    // handled separately below.
    let signature;
    try {
      signature = await connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: false,
        preflightCommitment: 'confirmed',
        // The web3 client retries within sendRawTransaction by default,
        // up to maxRetries. Cap it low so we control retry policy at
        // OUR level rather than letting the inner retry mask transient
        // errors that we want to surface for backoff.
        maxRetries: 2,
      });
    } catch (sendErr) {
      lastError = sendErr;
      // Permanent send-time errors typically include "insufficient
      // funds for rent", "Invalid mint", "Account in use" with
      // structured signature-conflict info. Non-transient → no retry.
      if (!isTransientAirdropError(sendErr) || attempt === AIRDROP_MAX_ATTEMPTS) {
        return { ok: false, error: sendErr.message, attempts: attempt };
      }
      continue;
    }
    lastSignature = signature;

    // Phase 2: confirm. We now have a signature — the tx is in flight.
    // From this point on, we MUST NOT just re-send (that risks
    // double-payment). On any confirmation problem we either succeed
    // via post-hoc balance check or give up with the signature in hand.
    try {
      const confResult = await connection.confirmTransaction(
        { signature, blockhash, lastValidBlockHeight },
        'confirmed',
      );
      if (confResult.value.err) {
        // Tx ran on chain and failed. Not retryable in any meaningful
        // sense — the failure mode is on-chain (insufficient SOL for
        // rent, etc.) and would just repeat. Surface the error and
        // move to the next recipient.
        return {
          ok: false,
          error: `Tx confirmed but failed on chain: ${JSON.stringify(confResult.value.err)}`,
          signature,
          attempts: attempt,
        };
      }
      // Clean success.
      return { ok: true, txId: signature, attempts: attempt };
    } catch (confErr) {
      lastError = confErr;
      // Confirmation failed/timed out. The tx may or may not have
      // landed. CHECK the recipient's balance to find out before
      // deciding to retry — otherwise we risk double-paying recipients
      // whose tx did land while we thought it didn't.
      const delivered = await recipientHasAtLeast(connection, recipientAta, amountRaw, programId);
      if (delivered) {
        // Tx landed despite the confirmation failure. Mark success
        // with the signature we have in hand.
        console.log(
          `  [retry] confirmation timed out but balance verified for `
          + `${recipientPk.toBase58().slice(0, 8)}...; treating as delivered`,
        );
        return { ok: true, txId: signature, attempts: attempt };
      }
      // Balance check confirms the tx didn't land. Retry the whole
      // send with a fresh blockhash if we have attempts left and the
      // error is transient.
      if (isTransientAirdropError(confErr) && attempt < AIRDROP_MAX_ATTEMPTS) {
        continue;
      }
      // Out of attempts or non-transient. Report failure with the
      // signature so the user can manually verify on Solscan.
      return {
        ok: false,
        error: `Confirmation failed (balance not credited): ${confErr.message}`,
        signature,
        attempts: attempt,
      };
    }
  }

  // Shouldn't reach here (the loop returns from every path), but
  // include a defensive fallback so we always return SOMETHING.
  return {
    ok: false,
    error: lastError?.message || 'Unknown failure',
    signature: lastSignature || undefined,
    attempts: AIRDROP_MAX_ATTEMPTS,
  };
}

export async function executeAirdrop({
  tempWalletSecretKey,
  tokenMint,
  tokenDecimals,
  isToken2022 = false,
  recipients, // [{ wallet: 'addressStr', tokens: 12345 }, ...]
  // Optional progress callback. Invoked after each recipient as
  // onProgress({ recipient, tokens, success }). server.js passes a
  // callback that writes to the in-memory airdropProgress Map; the
  // frontend polls /api/airdrop-progress to render a live progress UI.
  // Backwards-compatible default — when not passed, no callback runs.
  onProgress = null,
}) {
  const connection = makeConnection();
  const ownerKeypair = Keypair.fromSecretKey(Uint8Array.from(tempWalletSecretKey));
  const mintPk = new PublicKey(tokenMint);
  const programId = isToken2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;

  console.log(
    `Airdrop start: ${recipients.length} recipient(s) of ${tokenMint} `
    + `(${isToken2022 ? 'Token-2022' : 'classic'})`,
  );

  const transferred = [];
  const failed = [];

  // Sample the priority fee ONCE for the whole run. Airdrops can span
  // minutes, but the clamp bounds any drift and the per-attempt doubling
  // in deliverOneAirdropRecipient absorbs a market that moves up mid-run.
  // One sample also spares the RPC ~1 call per recipient.
  const priorityFeeMicroLamports = await samplePriorityFeeMicroLamports(connection);
  console.log(`  airdrop priority fee: ${priorityFeeMicroLamports} microlamports/CU`);

  // Pre-compute the owner's launched-token ATA. Stable across the run;
  // doing it inside the loop would just repeat the same derivation.
  const ownerAta = getAssociatedTokenAddressSync(
    mintPk,
    ownerKeypair.publicKey,
    /* allowOwnerOffCurve */ false,
    programId,
  );

  // Adaptive pacing state. Starts fast; bumps permanently to slow on
  // any retry-triggering error. We never decrease the pace within a
  // single airdrop run — once the endpoint shows signs of strain,
  // stay strain-friendly for the rest of the deliveries.
  let paceMs = AIRDROP_PACE_MS_DEFAULT;

  // Circuit breaker state. Counts consecutive recipient-level failures.
  // Resets to 0 on any success. Trips when it hits the threshold,
  // short-circuiting remaining recipients with a clear error so we
  // don't keep burning SOL on a clearly-broken RPC connection.
  let consecutiveFailures = 0;
  let circuitTripped = false;

  for (let i = 0; i < recipients.length; i++) {
    const r = recipients[i];

    // Convert UI token amount to mint-base units (integer in mint
    // decimals). Math.round absorbs frontend floating-point noise.
    const amountRaw = BigInt(Math.round(Number(r.tokens) * 10 ** tokenDecimals));
    const amountRawStr = amountRaw.toString();

    // Validate recipient address before attempting the tx.
    let recipientPk;
    try {
      recipientPk = new PublicKey(r.wallet);
    } catch (e) {
      console.warn(`Airdrop: invalid recipient ${r.wallet}: ${e.message}`);
      failed.push({
        wallet: r.wallet,
        tokens: r.tokens,
        amountRaw: amountRawStr,
        error: `Invalid Solana address: ${e.message}`,
        attempts: 0,
      });
      if (typeof onProgress === 'function') {
        try { onProgress({ recipient: r.wallet, tokens: r.tokens, success: false }); }
        catch (_) { /* never let a progress callback break the airdrop */ }
      }
      // Invalid-address failures don't count toward the circuit
      // breaker — they're client-data problems, not RPC problems.
      continue;
    }

    // Skip zero-amount rows defensively.
    if (amountRaw <= 0n) {
      console.warn(`Airdrop: zero amount for ${r.wallet}, skipping`);
      failed.push({
        wallet: r.wallet,
        tokens: r.tokens,
        amountRaw: amountRawStr,
        error: 'Recipient amount rounds to zero',
        attempts: 0,
      });
      if (typeof onProgress === 'function') {
        try { onProgress({ recipient: r.wallet, tokens: r.tokens, success: false }); }
        catch (_) { /* never let a progress callback break the airdrop */ }
      }
      continue;
    }

    // Circuit breaker check: if too many recipients have failed in a
    // row, stop trying. Fail-fast the rest with a clear message so
    // the user knows what happened and can retry later when the RPC
    // is healthy. We still loop to push entries (the response shape
    // is "every recipient is accounted for"), but skip the actual
    // tx work.
    if (circuitTripped) {
      failed.push({
        wallet: r.wallet,
        tokens: r.tokens,
        amountRaw: amountRawStr,
        error: `Skipped: RPC circuit breaker tripped after `
          + `${AIRDROP_MAX_CONSECUTIVE_FAILS} consecutive failures. `
          + `Use the Retry failed button after the connection recovers.`,
        attempts: 0,
      });
      if (typeof onProgress === 'function') {
        try { onProgress({ recipient: r.wallet, tokens: r.tokens, success: false }); }
        catch (_) { /* never let a progress callback break the airdrop */ }
      }
      continue;
    }

    const recipientAta = getAssociatedTokenAddressSync(
      mintPk,
      recipientPk,
      /* allowOwnerOffCurve */ false,
      programId,
    );

    // Pace between recipients (except for the very first one). Adaptive
    // — see paceMs comment above.
    if (i > 0) await sleep(paceMs);

    const result = await deliverOneAirdropRecipient({
      connection,
      ownerKeypair,
      ownerAta,
      recipientPk,
      recipientAta,
      mintPk,
      amountRaw,
      tokenDecimals,
      programId,
      priorityFeeMicroLamports,
    });

    if (result.ok) {
      console.log(
        `  [ok] ${i + 1}/${recipients.length} airdropped `
        + `${r.tokens} to ${r.wallet} (${result.attempts} attempt${result.attempts === 1 ? '' : 's'}): `
        + `${result.txId}`,
      );
      transferred.push({
        wallet: r.wallet,
        tokens: r.tokens,
        amountRaw: amountRawStr,
        txId: result.txId,
        attempts: result.attempts,
      });
      if (typeof onProgress === 'function') {
        try { onProgress({ recipient: r.wallet, tokens: r.tokens, success: true }); }
        catch (_) { /* never let a progress callback break the airdrop */ }
      }
      consecutiveFailures = 0;
      // If we needed >1 attempt for THIS recipient, bump pacing to
      // slow for the rest. Even though this one succeeded, the retry
      // indicates the endpoint is under pressure — back off for
      // subsequent recipients to keep things stable.
      if (result.attempts > 1 && paceMs < AIRDROP_PACE_MS_SLOW) {
        paceMs = AIRDROP_PACE_MS_SLOW;
        console.log(
          `  [retry] pace bumped to ${paceMs}ms after retry on `
          + `${r.wallet} (endpoint appears under pressure)`,
        );
      }
    } else {
      console.error(
        `  [x] ${i + 1}/${recipients.length} airdrop to ${r.wallet} `
        + `failed after ${result.attempts} attempt${result.attempts === 1 ? '' : 's'}: `
        + `${result.error}`,
      );
      failed.push({
        wallet: r.wallet,
        tokens: r.tokens,
        amountRaw: amountRawStr,
        error: result.error,
        ...(result.signature ? { signature: result.signature } : {}),
        attempts: result.attempts,
      });
      if (typeof onProgress === 'function') {
        try { onProgress({ recipient: r.wallet, tokens: r.tokens, success: false }); }
        catch (_) { /* never let a progress callback break the airdrop */ }
      }
      consecutiveFailures += 1;
      // Bump pace too — a failed recipient is strongly suggestive of
      // RPC trouble.
      if (paceMs < AIRDROP_PACE_MS_SLOW) {
        paceMs = AIRDROP_PACE_MS_SLOW;
      }
      if (consecutiveFailures >= AIRDROP_MAX_CONSECUTIVE_FAILS) {
        console.error(
          `Airdrop circuit breaker tripped after `
          + `${AIRDROP_MAX_CONSECUTIVE_FAILS} consecutive failures. `
          + `Aborting remaining ${recipients.length - i - 1} recipient(s).`,
        );
        circuitTripped = true;
      }
    }

    // Periodic progress log so the server console is useful for long
    // runs. Final summary logged after the loop unconditionally.
    if ((i + 1) % AIRDROP_LOG_EVERY_N === 0) {
      console.log(
        `  - progress: ${i + 1}/${recipients.length} processed `
        + `(${transferred.length} delivered, ${failed.length} failed)`,
      );
    }
  }

  console.log(
    `Airdrop done: ${transferred.length} delivered, ${failed.length} failed `
    + `(out of ${recipients.length} total)`,
  );

  return { transferred, failed };
}

// ---------------------------------------------------------------------------
// Test-only DI seam — connection factory override
// ---------------------------------------------------------------------------
let __connectionFactoryForTests = null;
export function setConnectionFactoryForTests(factory) {
  __connectionFactoryForTests = factory;
}
export function resetTestFactories() {
  __connectionFactoryForTests = null;
}

export function resetConnectionFactoryForTests() {
  __connectionFactoryForTests = null;
}
