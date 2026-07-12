// demoChainService.js
//
// Demo mode: lets a user walk the entire Trebuchet launch flow — every
// step, option, and state transition — WITHOUT spending SOL or sending a
// single transaction to the Solana network. The flow looks and feels like
// a real launch so the resulting screenshots and recordings are
// tutorial-quality.
//
// HOW IT FITS IN
// --------------
// server.js checks a single isDemoMode() predicate at the top of each
// chain-touching /api/* handler. When demo mode is on, the handler returns
// early by delegating to one of the handleX() functions here. The real
// service modules (tokenService.js, lpService.js, swapService.js,
// walletHelpers.js, lpEstimate.js) are NEVER touched by this file, so
// real-mode behaviour cannot regress from any of this work.
//
// We intercept HIGH — at the half-dozen high-level service endpoints the
// frontend calls — rather than mocking the @solana/web3.js Connection.
// Faking getAccountInfo / getMultipleAccounts / simulateTransaction / ...
// with response shapes that keep the Raydium and Metaplex SDKs happy is a
// far bigger surface than faking the endpoints the UI actually hits.
//
// THE LEDGER
// ----------
// A module-level Map simulates on-chain state. Its shape mirrors what the
// real chain calls return so the response shapes the frontend consumes
// match exactly. State lives only in RAM: it resets when the app restarts,
// and a fresh WalletState is created whenever a wallet is generated.
//
// WHAT DEMO MODE IS NOT
// ---------------------
// Happy path only. Demo mode always succeeds — no failure injection, no
// RPC drift, no slippage. It does not verify SDK calls, funding math
// against live mainnet, or on-chain instruction building, and it does not
// exercise the failure-recovery paths (resume, partial-failure banners).
// It verifies UI flow, the state machine, conditional rendering, the
// report generator, and the visual coherence of every screen.

import { Keypair } from '@solana/web3.js';

// ===========================================================================
// Constants — the well-known quote mints, so SOL/USDC/USDT pools resolve to
// recognizable symbols and the right decimals in the fake result/ledger.
// ===========================================================================

const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
// Classic SPL token program id — the only programId the demo ledger ever
// reports. Token-2022 specifics don't matter for a UI walkthrough.
const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

// Known quote-token metadata, keyed by both symbol and mint so a pool
// configured either way resolves cleanly.
const KNOWN = {
  SOL: { symbol: 'SOL', address: WSOL_MINT, decimals: 9 },
  WSOL: { symbol: 'SOL', address: WSOL_MINT, decimals: 9 },
  USDC: { symbol: 'USDC', address: USDC_MINT, decimals: 6 },
  USDT: { symbol: 'USDT', address: USDT_MINT, decimals: 6 },
  [WSOL_MINT]: { symbol: 'SOL', address: WSOL_MINT, decimals: 9 },
  [USDC_MINT]: { symbol: 'USDC', address: USDC_MINT, decimals: 6 },
  [USDT_MINT]: { symbol: 'USDT', address: USDT_MINT, decimals: 6 },
};

// ===========================================================================
// Time scaling
// ===========================================================================
//
// Each fake step sleeps for roughly as long as its real-world counterpart
// so the progress UI lights up at familiar intervals. DEMO_TIME_SCALE
// scales every sleep: 1.0 = realistic (default), 0.3 = fast capture
// sessions that still show progress, 0 = instant (handy for automated UI
// tests). Read once at module load — restart to change it.

const TIME_SCALE = (() => {
  const raw = Number(process.env.DEMO_TIME_SCALE);
  if (!Number.isFinite(raw) || raw < 0) return 1.0;
  return raw;
})();

function sleep(ms) {
  const scaled = Math.round(ms * TIME_SCALE);
  if (scaled <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, scaled));
}

// ===========================================================================
// Synthetic address / signature generation
// ===========================================================================
//
// Demo addresses carry a "Demo" prefix so they're instantly recognizable
// in screenshots and can never be confused with a real address. They're
// still base58 and 32 characters long, so they look like a Solana address
// in every UI surface. Solscan links for them 404 — that's fine, they're
// synthetic; the launch report still renders the links so the UX matches
// a real launch.
//
// Note: a "Demo"-prefixed 32-char base58 string does NOT decode to 32
// bytes, so it would fail new PublicKey() validation. That's a feature,
// not a bug — it means a demo address can never accidentally be used in a
// real on-chain call.

// base58 alphabet (Bitcoin/Solana) — no 0, O, I, or l.
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function randomBase58(len) {
  let out = '';
  for (let i = 0; i < len; i++) {
    out += BASE58[Math.floor(Math.random() * BASE58.length)];
  }
  return out;
}

// 'Demo' + 28 random chars = 32 chars total, address-shaped.
function demoAddress() {
  return 'Demo' + randomBase58(28);
}

// 'Demo' + 84 random chars = 88 chars total, signature-shaped.
function demoSignature() {
  return 'Demo' + randomBase58(84);
}

// ===========================================================================
// The ledger
// ===========================================================================

/** @type {Map<string, object>} publicKey -> WalletState */
const demoLedger = new Map();

/**
 * Create (or reset) the WalletState for a freshly-generated demo wallet.
 * Called from the /api/generate-wallet demo branch right after the real
 * keypair is produced. A demo wallet starts empty — 0 SOL, no tokens —
 * exactly like a real freshly-generated launch wallet before funding.
 */
export function registerWallet(publicKey) {
  demoLedger.set(publicKey, {
    solBalance: 0, // SOL, float
    tokenBalances: {}, // mint -> { amountRaw, amountUi, decimals, programId }
    nfts: [], // [{ mint, name, symbol, programName }]
    createdTokens: [], // [{ mint, name, symbol, decimals, totalSupply }]
    pools: [], // [{ poolId, baseMint, quoteMint, ... }]
    positions: [], // [{ positionNftMint, poolId, locked, kind, externalRecipient }]
  });
  console.log(`[demo] registered wallet ${publicKey} in demo ledger`);
}

/**
 * Fetch a wallet's state, creating an empty one on the fly if we've never
 * seen it. The on-the-fly creation matters because the app can be restarted
 * mid-launch (which clears the ledger) while the renderer still holds a
 * wallet from before the restart; we'd rather show an empty wallet than
 * throw.
 */
function getState(publicKey) {
  let st = demoLedger.get(publicKey);
  if (!st) {
    registerWallet(publicKey);
    st = demoLedger.get(publicKey);
  }
  return st;
}

// Derive a wallet public key from a secret-key array (as sent over the
// wire by the frontend). Uses the real Keypair so the derivation is
// genuine — the secret key is real, only the chain interaction is faked.
function pubkeyFromSecretArray(secretKeyArr) {
  const arr = typeof secretKeyArr === 'string'
    ? JSON.parse(secretKeyArr)
    : secretKeyArr;
  return Keypair.fromSecretKey(Uint8Array.from(arr)).publicKey.toBase58();
}

// Resolve a pool's quote-token config from an allocation's quoteToken plus
// any UI overrides, falling back to sensible defaults for unknown mints.
function resolveQuote(alloc) {
  const key = (alloc.quoteToken || '').toString();
  const known = KNOWN[key] || KNOWN[key.toUpperCase()];
  if (known) return { ...known };
  // Unknown mint (a custom flywheel / arbitrary quote token). Use whatever
  // the UI resolved and passed through as overrides.
  return {
    symbol: alloc.quoteSymbolOverride || 'TOKEN',
    address: key || demoAddress(),
    decimals: alloc.quoteDecimalsOverride != null
      ? Number(alloc.quoteDecimalsOverride)
      : 9,
  };
}

// Helpers for reading/writing raw token amounts on the ledger.
function rawFromWhole(whole, decimals) {
  // Use BigInt to avoid float precision loss on large supplies.
  const [intPart, fracPart = ''] = String(whole).split('.');
  const fracPadded = (fracPart + '0'.repeat(decimals)).slice(0, decimals);
  const combined = `${intPart}${fracPadded}`.replace(/^0+(?=\d)/, '');
  return BigInt(combined || '0');
}

function creditToken(st, mint, addRaw, decimals, programId = TOKEN_PROGRAM_ID) {
  const existing = st.tokenBalances[mint];
  const prevRaw = existing ? BigInt(existing.amountRaw) : 0n;
  const newRaw = prevRaw + BigInt(addRaw);
  const amountUi = Number(newRaw) / Math.pow(10, decimals);
  st.tokenBalances[mint] = {
    amountRaw: newRaw.toString(),
    amountUi,
    decimals,
    programId,
  };
}

function debitToken(st, mint, subRaw, decimals) {
  const existing = st.tokenBalances[mint];
  if (!existing) return;
  const prevRaw = BigInt(existing.amountRaw);
  let newRaw = prevRaw - BigInt(subRaw);
  if (newRaw < 0n) newRaw = 0n;
  existing.amountRaw = newRaw.toString();
  existing.amountUi = Number(newRaw) / Math.pow(10, decimals);
}

// ===========================================================================
// /api/check-balance — SOL only (Step 1 display)
// ===========================================================================
//
// Real handler returns SOL as a float (lamports / LAMPORTS_PER_SOL). Match
// that exactly. No sleep — balance polls happen every few seconds and
// shouldn't feel laggy.

export function handleCheckBalance(req, res) {
  const { publicKey } = req.body;
  const st = getState(publicKey);
  res.json({ success: true, balance: st.solBalance });
}

// ===========================================================================
// /api/check-balance-detailed — SOL + every SPL token (funding step)
// ===========================================================================
//
// Returns the same { sol, tokens } shape walletHelpers.checkWalletBalance
// MultiToken produces, where tokens is keyed by mint with
// { amountRaw, amountUi, decimals, programId }.

export function handleCheckBalanceDetailed(req, res) {
  const { publicKey } = req.body;
  const st = getState(publicKey);
  res.json({
    success: true,
    balance: {
      sol: st.solBalance,
      tokens: st.tokenBalances,
    },
  });
}

// ===========================================================================
// /api/demo/status — frontend asks "is demo mode on?" on app load
// ===========================================================================
//
// active is passed in by server.js (it owns isDemoMode()). The frontend
// uses the answer to decide whether to show the banner and the "Pretend
// funding arrived" button.

export function handleStatus(req, res, { active }) {
  res.json({ success: true, active: !!active });
}

// ===========================================================================
// /api/find-funder — "Possible funding wallet" detection (funding step)
// ===========================================================================
//
// The real endpoint scans the wallet's on-chain transaction history to
// guess which wallet funded it. A demo wallet has no real history, and we
// don't want demo mode making real RPC calls, so we report "no funder
// detected". The frontend handles a null result gracefully (it just hides
// the detected-funder hint and stops re-polling). This keeps the funding
// step fully self-contained in demo mode.

export function handleFindFunder(req, res) {
  res.json({ success: true, result: null });
}

// ===========================================================================
// /api/rpc-health — the periodic RPC health dot
// ===========================================================================
//
// Polled on a timer during active use. In demo mode there's no real RPC to
// check (and we don't want demo to make real network calls), so we report a
// healthy endpoint. This keeps the health dot green and prevents the
// "launches may fail" warning from ever appearing during a demo. Shape
// mirrors the real handler: { success, health, latencyMs }.

export function handleRpcHealth(req, res) {
  res.json({ success: true, health: 'good', latencyMs: 0 });
}

// ===========================================================================
// /api/demo/inject-funds — the "Pretend funding arrived (DEMO)" button
// ===========================================================================
//
// Sets the wallet's SOL balance and any manual-prefund quote-token
// balances to meet the current funding requirement. The funding
// requirement is computed client-side (from /api/estimate-lp-funding plus
// live prices), so the frontend posts the exact amounts it needs rather
// than us re-deriving the funding math server-side. The existing balance
// poll picks the new balances up on its next /api/check-balance-detailed
// call and the green checkmarks light up naturally — no special-case UI.
//
// Body shape (all optional, frontend sends what it has):
//   { publicKey, sol: <float>, tokens: [{ mint, amountUi, decimals }] }
//
// Note: auto-swap quote tokens are deliberately NOT granted here — those
// are acquired via the /api/acquire-quote-tokens demo flow so the acquire
// step stays demonstrable. inject-funds only covers what a real funder
// would actually send: SOL and any tokens the user must pre-fund manually.

export function handleInjectFunds(req, res) {
  const { publicKey, sol, tokens } = req.body || {};
  if (!publicKey) {
    return res.status(400).json({ success: false, error: 'publicKey required' });
  }
  const st = getState(publicKey);

  if (typeof sol === 'number' && Number.isFinite(sol) && sol > 0) {
    // Set (not add) so repeated clicks are idempotent and land exactly at
    // the requested amount.
    st.solBalance = sol;
  }

  if (Array.isArray(tokens)) {
    for (const t of tokens) {
      if (!t || !t.mint) continue;
      const decimals = Number.isFinite(Number(t.decimals)) ? Number(t.decimals) : 9;
      const whole = Number(t.amountUi) || 0;
      if (whole <= 0) continue;
      const raw = rawFromWhole(whole, decimals);
      // Set the balance to exactly the requested amount (idempotent).
      st.tokenBalances[t.mint] = {
        amountRaw: raw.toString(),
        amountUi: whole,
        decimals,
        programId: TOKEN_PROGRAM_ID,
      };
    }
  }

  console.log(
    `[demo] injected funds into ${publicKey}: ` +
      `${st.solBalance} SOL, ${Object.keys(st.tokenBalances).length} token type(s)`,
  );

  res.json({
    success: true,
    balance: { sol: st.solBalance, tokens: st.tokenBalances },
  });
}

// ===========================================================================
// /api/acquire-quote-tokens — auto-swap SOL -> quote tokens
// ===========================================================================
//
// The real endpoint kicks off a background job and the frontend polls
// GET /api/acquire-quote-tokens/:jobId for status. We mirror that exactly:
// create a job in the SAME acquireJobs Map the real endpoint uses (passed
// in by server.js) so the unchanged GET/DELETE poll endpoints serve demo
// jobs without needing their own demo branch.
//
// The fake "swap" sleeps, grants the target quote token to the ledger, and
// deducts the budgeted SOL spend — then reports success with a
// Demo-prefixed signature.

export function handleAcquireQuoteTokens(req, res, { acquireJobs, jobExpiryMs }) {
  const { tempWalletSecretKey, autoSwapPlan } = req.body;

  // No-op case: empty plan -> a synthetic "already done" job, same as real.
  if (!Array.isArray(autoSwapPlan) || autoSwapPlan.length === 0) {
    const jobId = `demojob_${Date.now()}_empty`;
    acquireJobs.set(jobId, {
      jobId,
      status: 'done',
      total: 0,
      completed: 0,
      results: [],
      pendingMints: [],
      inProgressMints: new Set(),
      startedAt: Date.now(),
      finishedAt: Date.now(),
      error: null,
    });
    return res.json({ jobId });
  }

  const publicKey = pubkeyFromSecretArray(tempWalletSecretKey);
  const jobId = `demojob_${Date.now()}_${randomBase58(8)}`;
  const job = {
    jobId,
    status: 'running',
    total: autoSwapPlan.length,
    completed: 0,
    results: [],
    pendingMints: autoSwapPlan.map((p) => p.quoteMint),
    inProgressMints: new Set(),
    startedAt: Date.now(),
    finishedAt: null,
    error: null,
  };
  acquireJobs.set(jobId, job);

  // Run in the background; POST returns immediately with the jobId.
  runDemoAcquireJob(job, { publicKey, autoSwapPlan }).catch((err) => {
    console.error(`[demo][acquire][${jobId}] unexpected error:`, err);
    job.status = 'done';
    job.finishedAt = Date.now();
    job.error = err.message;
  });

  // Auto-expire like real jobs so we don't leak memory.
  setTimeout(() => {
    if (acquireJobs.has(jobId)) {
      acquireJobs.delete(jobId);
      console.log(`[demo][acquire][${jobId}] expired and removed from store`);
    }
  }, jobExpiryMs);

  res.json({ jobId });
}

async function runDemoAcquireJob(job, { publicKey, autoSwapPlan }) {
  const { jobId } = job;
  const st = getState(publicKey);
  console.log(`[demo][acquire][${jobId}] starting: ${autoSwapPlan.length} item(s)`);

  // Demo acquires run one at a time so the per-row "Swapping…" states
  // appear sequentially in the UI, like a single-worker pool.
  for (const item of autoSwapPlan) {
    const {
      allocationIndex,
      quoteMint,
      quoteSymbol,
      quoteDecimals,
      targetRaw,
      estSolSpend,
    } = item;

    job.inProgressMints.add(quoteMint);
    console.log(`[demo][acquire][${jobId}] swapping for ${quoteSymbol} (${quoteMint})`);

    // Realistic-ish swap duration.
    await sleep(2500);

    // Grant the target amount of the quote token to the ledger.
    const decimals = Number(quoteDecimals) || 9;
    const targetRawBig = BigInt(String(targetRaw || '0'));
    creditToken(st, quoteMint, targetRawBig, decimals);

    // Deduct the budgeted SOL spend (mirrors real SOL leaving the wallet).
    if (estSolSpend != null && Number(estSolSpend) > 0) {
      st.solBalance = Math.max(0, st.solBalance - Number(estSolSpend));
    }

    job.results.push({
      allocationIndex,
      quoteMint,
      quoteSymbol,
      success: true,
      txId: demoSignature(),
      swappedRaw: targetRawBig.toString(),
      alreadyHadRaw: '0',
      finalBalanceRaw: st.tokenBalances[quoteMint]
        ? st.tokenBalances[quoteMint].amountRaw
        : targetRawBig.toString(),
    });

    job.completed++;
    job.inProgressMints.delete(quoteMint);
    job.pendingMints = job.pendingMints.filter((m) => m !== quoteMint);
    console.log(`[demo][acquire][${jobId}] ${quoteSymbol} acquired`);
  }

  job.status = 'done';
  job.finishedAt = Date.now();
  console.log(
    `[demo][acquire][${jobId}] done: ${job.results.length}/${job.total} acquired`,
  );
}

// ===========================================================================
// /api/create-token — mint the launched token (Step 4)
// ===========================================================================
//
// Generates a Demo-prefixed mint, records the token in the ledger (credits
// the full supply to the launch wallet so it's available to deposit into
// LP positions in Step 5), and returns the same response shape the real
// createTokenWithMetaplex produces. The metadata URI is an Arweave-shaped
// synthetic URL — it won't resolve, but it shows up correctly in the
// launch report.
//
// Normalization is intentionally light here: the route's multer middleware
// already ran, so req.body is parsed. We trust the already-normalized
// values the UI sent; demo mode is about the flow, not input validation.

export async function handleCreateToken(req, res) {
  try {
    const {
      tempWalletSecretKey,
      name = 'Demo Token',
      symbol = 'DEMO',
      totalSupply = 1000000000,
      vanityCAKeypair: vanityCAKeypairRaw,
      vanityPrefix,
      vanitySuffix,
    } = req.body;

    const decimals = 9;
    const supplyNum = Number(totalSupply) || 1000000000;
    const publicKey = pubkeyFromSecretArray(tempWalletSecretKey);
    const st = getState(publicKey);

    console.log(`[demo] creating token "${name}" (${symbol}), supply ${supplyNum}`);

    // Token creation in a real launch is several transactions (mint init,
    // metadata, supply mint, authority renounce). Sleep ~4s to match.
    await sleep(4000);

    // Determine the mint address. Three cases, in priority order:
    //   1. Pre-ground vanity CA keypair — user grinded it client-side and
    //      selected it from the list. We derive the real public key and
    //      use that, honoring their selection exactly. The user sees the
    //      address they chose, not a generic Demo-prefixed string.
    //   2. Inline vanity grind (vanityPrefix/vanitySuffix) — user typed a
    //      target but didn't pre-grind. We synthesize a base58 address
    //      that satisfies the constraint. The 'Demo' marker is dropped
    //      here because the whole point of grinding is that the user
    //      chose the prefix — overriding with 'Demo' would defeat it.
    //   3. No vanity — generic Demo-prefixed address.
    let mint;
    if (vanityCAKeypairRaw) {
      try {
        const secretKeyArr = typeof vanityCAKeypairRaw === 'string'
          ? JSON.parse(vanityCAKeypairRaw)
          : vanityCAKeypairRaw;
        const kp = Keypair.fromSecretKey(Uint8Array.from(secretKeyArr));
        mint = kp.publicKey.toBase58();
        console.log(`[demo] honoring pre-ground vanity CA: ${mint}`);
      } catch (e) {
        // Malformed vanity keypair — fall back to a generic Demo address
        // rather than crashing the launch. The user would see their
        // vanity selection ignored, which is the same as before this
        // fix, so we haven't regressed anything.
        console.warn(`[demo] invalid vanityCAKeypair, falling back: ${e.message}`);
        mint = demoAddress();
      }
    } else if (vanityPrefix && vanitySuffix
        && typeof vanityPrefix === 'string'
        && typeof vanitySuffix === 'string'
        && vanityPrefix.length > 0
        && vanitySuffix.length > 0) {
      const px = vanityPrefix.slice(0, 15);
      const sx = vanitySuffix.slice(0, 15);
      const middle = Math.max(1, 32 - px.length - sx.length);
      mint = px + randomBase58(middle) + sx;
      console.log(`[demo] synthesizing start/end vanity CA: ${mint}`);
    } else if (vanityPrefix && typeof vanityPrefix === 'string' && vanityPrefix.length > 0) {
      // Construct a 32-char base58 string starting with the user's prefix.
      // Clamp prefix length to 31 so we always have at least one random
      // char — a prefix of exactly 32 would be a fully-specified address
      // (real grinders reject this; we'd just truncate).
      const px = vanityPrefix.slice(0, 31);
      mint = px + randomBase58(32 - px.length);
      console.log(`[demo] synthesizing prefix-vanity CA: ${mint}`);
    } else if (vanitySuffix && typeof vanitySuffix === 'string' && vanitySuffix.length > 0) {
      const sx = vanitySuffix.slice(0, 31);
      mint = randomBase58(32 - sx.length) + sx;
      console.log(`[demo] synthesizing suffix-vanity CA: ${mint}`);
    } else {
      mint = demoAddress();
    }
    const metadataUri = `https://arweave.net/${demoAddress()}`;

    // Record the token and credit the full supply to the launch wallet.
    st.createdTokens.push({ mint, name, symbol, decimals, totalSupply: supplyNum });
    creditToken(st, mint, rawFromWhole(supplyNum, decimals), decimals);

    console.log(`[demo] token created: ${mint}`);

    res.json({
      success: true,
      name,
      symbol,
      totalSupply: supplyNum,
      tokenMint: mint,
      decimals,
      metadataUri,
      isSafe: true,
      mintAndFreezeAuthoritiesSafe: true,
      mintAuthorityRenounced: true,
      freezeAuthorityDisabled: true,
      metadataUpdateAuthorityRevoked: true,
      metadataImmutable: true,
      warning: null,
    });
  } catch (error) {
    console.error('[demo] create-token error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
}

// ===========================================================================
// /api/create-lp — the big one: pools + positions + locks + transfers
// ===========================================================================
//
// Mirrors the real createPoolsAndPositions orchestration in four phases,
// sleeping per step and logging the same kind of phase lines the real flow
// emits. Those console.log lines are what the frontend's docked activity
// log shows during the wait (the server-log ring buffer is streamed to the
// UI), so the progress UI lights up at familiar intervals even though the
// phase-progress tree itself only completes when this single POST returns.
//
// Returns the same { success, results } shape createPoolsAndPositions
// returns. Everything downstream (Step 5 progress tree, the launch report)
// reads from results, so getting this shape right is what makes the rest
// of the UI work unchanged.

// Demo stub for /api/publish-launch-report. No Arweave write — returns
// Arweave-shaped URIs so the success modal's permanent-report card renders in
// a demo walkthrough exactly as it would after a real publish.
export function handlePublishLaunchReport(req, res) {
  const { mint } = req.body || {};
  if (!mint) {
    return res.json({ success: true, skipped: true, reason: 'missing-mint' });
  }
  const htmlUri = `https://arweave.net/${demoAddress()}`;
  const jsonUri = `https://arweave.net/${demoAddress()}`;
  console.log(`[demo] === Published launch report for ${mint} (simulated) ===`);
  return res.json({ success: true, skipped: false, failed: false, jsonUri, htmlUri });
}

export async function handleCreateLp(req, res, opts = {}) {
  try {
    const {
      tempWalletSecretKey,
      tokenMint,
      tokenDecimals = 9,
      tokenTotalSupply,
      allocations = [],
      lockPositions,
    } = req.body;

    const doLock = lockPositions !== false;
    const publicKey = pubkeyFromSecretArray(tempWalletSecretKey);
    const st = getState(publicKey);

    // Local progress emitter. The server's create-lp route wires opts.lpProgress
    // to its in-memory tracker; emitting here is what makes the frontend's
    // phase progress tree tick forward step-by-step instead of all-at-once
    // when this single POST returns. Safe to call unconditionally — the
    // hook is a no-op closure when the route didn't supply one.
    const lpProgress = opts.lpProgress || null;
    const emit = (event) => {
      if (lpProgress && typeof lpProgress.event === 'function') {
        try { lpProgress.event(event); }
        catch (_) { /* never let a progress hook break the run */ }
      }
    };

    console.log(`\n[demo] === Creating pools and positions for ${tokenMint} ===`);
    console.log(`[demo] allocations: ${allocations.length}, lock: ${doLock}`);

    const results = [];

    // -- Phase 1: main positions (+ ladder bands) for every pool ----------
    console.log('\n[demo] === Phase 1: creating pools and opening main positions ===');
    for (let allocIdx = 0; allocIdx < allocations.length; allocIdx++) {
      const alloc = allocations[allocIdx];
      const quote = resolveQuote(alloc);
      const poolId = demoAddress();

      console.log(`[demo] [${quote.symbol}] creating pool ${poolId}`);
      await sleep(2000);
      emit({ stage: 'pool_create_done', allocationIndex: allocIdx });

      // Record the pool in the ledger.
      st.pools.push({
        poolId,
        baseMint: tokenMint,
        quoteMint: quote.address,
      });

      // Main positions, one per distribution slice.
      const distribution = Array.isArray(alloc.distribution) && alloc.distribution.length > 0
        ? alloc.distribution
        : [{ sharePercent: 100, recipient: null }];
      const mainPositions = [];
      for (let i = 0; i < distribution.length; i++) {
        const slice = distribution[i];
        console.log(`[demo] [${quote.symbol}] opening main slice ${i + 1}/${distribution.length}`);
        await sleep(1500);
        mainPositions.push({
          sliceIndex: i,
          sharePercent: slice.sharePercent,
          // Plausible wide single-sided range above launch (parity with the
          // real result shape — the launch report renders these).
          tickLower: 60,
          tickUpper: 443580,
          nftMint: demoAddress(),
          locked: false,
          recipient: slice.recipient || null,
          transferredTo: null,
          txIds: { open: demoSignature(), lock: null, transfer: null },
        });
        emit({ stage: 'main_open_done', allocationIndex: allocIdx, sliceIndex: i });
      }

      // Ladder bands (the wire only ever sends mode 'off' or 'manual';
      // simple-mode ladders are expanded to manual bands client-side).
      const ladder = alloc.ladder || { mode: 'off', bands: [] };
      const ladderPositions = [];
      if (ladder.mode === 'manual' && Array.isArray(ladder.bands) && ladder.bands.length > 0) {
        console.log(`[demo] [${quote.symbol}] opening ${ladder.bands.length} ladder band(s)`);
        for (let bi = 0; bi < ladder.bands.length; bi++) {
          await sleep(1500);
          // Fake but plausible, monotonically-rising tick ranges.
          const lower = 1000 * (bi + 1);
          const upper = 1000 * (bi + 2);
          ladderPositions.push({
            bandIndex: bi,
            tickLower: lower,
            tickUpper: upper,
            nftMint: demoAddress(),
            locked: false,
            txIds: { open: demoSignature(), lock: null },
          });
          emit({ stage: 'ladder_open_done', allocationIndex: allocIdx, bandIndex: bi });
        }
      }

      // Support positions. Single-sided quote-side band below launch price
      // that backs preallocation by providing a buy wall the preallocation
      // holders can sell into. Modeled as an array (currently 0 or 1
      // entry) for symmetry with the real implementation. The orchestrator
      // signal is alloc.support === { mode: 'custom', solValue, depthPct };
      // anything else (mode 'off', missing, etc.) skips support entirely.
      const supportPositions = [];
      const supportCfg = alloc.support || { mode: 'off' };
      const supportEnabled = supportCfg.mode === 'custom'
        && Number(supportCfg.solValue) > 0;
      if (supportEnabled) {
        const solValue = Number(supportCfg.solValue) || 0;
        const depthPct = Number(supportCfg.depthPct) || 10;
        console.log(`[demo] [${quote.symbol}] opening support position (${solValue} SOL @ -${depthPct}%)`);
        await sleep(1500);
        // Fake but plausible tick range below currentTick — real ranges
        // depend on depth and spacing; the values here are illustrative.
        const tickLower = -3000;
        const tickUpper = -100;
        supportPositions.push({
          tickLower,
          tickUpper,
          depthPct,
          // Synthetic raw amount, just for display. Real value would be
          // (solValue * solUsd / quoteUsd) * 10^quoteDecimals; we don't
          // need that precision in demo since the launch report shows
          // the SOL-side budget which the user already knows.
          quoteRaw: '0',
          nftMint: demoAddress(),
          locked: false,
          txIds: { open: demoSignature(), lock: null },
        });
        // Deduct the SOL spend from the wallet. For SOL pools the support
        // is funded directly in SOL; for non-SOL pools the SOL has already
        // been swapped to the quote token by the acquire-quote-tokens
        // step, so we deduct from the quote-token ledger instead. We
        // approximate the deduction without exact USD math — the demo
        // doesn't need to be accurate to the satoshi for screenshots.
        if (quote.symbol === 'SOL') {
          st.solBalance = Math.max(0, st.solBalance - solValue);
        }
        emit({ stage: 'support_open_done', allocationIndex: allocIdx });
      }

      // Mirror Raydium's mintA/mintB assignment: the pubkey with the
      // smaller byte-wise representation becomes mintA. This is what real
      // lpService detects post-creation via `poolInfo.mintA.address ===
      // launchedToken.address`; doing the equivalent here keeps demo
      // launch reports and journal entries representative of either
      // outcome the user might see in production.
      //
      // We compare the address STRINGS directly rather than decoding them
      // to pubkey bytes. Demo addresses are deliberately NOT valid 32-byte
      // keys (see demoAddress above — the 'Demo' prefix makes them
      // undecodable so they can never be used in a real on-chain call), so
      // feeding them to new PublicKey() throws "Invalid public key input".
      // A lexicographic string comparison is deterministic and varied
      // enough to give demo reports either a mintA-side or mintB-side
      // launch, which is all this simulation needs.
      const launchedAddr = String(tokenMint);
      const quoteAddr = String(quote.address);
      const launchedSide = launchedAddr < quoteAddr ? 'mintA' : 'mintB';

      const resultEntry = {
        allocationIndex: allocIdx,
        quoteSymbol: quote.symbol,
        quoteAddress: quote.address,
        supplyPercent: alloc.supplyPercent,
        poolId,
        launchedSide,
        // Pool parameters mirrored from the real result shape for the
        // launch report / Arweave record.
        tickSpacing: 60,
        initialPrice: '0.0001',
        mainPositions,
        ladderPositions,
        supportPositions,
        txIds: { createPool: demoSignature() },
        // Populated in Phase 2.
        bootstrap: null,
      };
      results.push(resultEntry);

      // Deduct this pool's allocated supply from the launch wallet's
      // launched-token balance. Light accounting — enough that the Step 6
      // sweep shows a believable leftover rather than the entire supply.
      const allocRaw = rawFromWhole(
        (Number(tokenTotalSupply) || 0) * (Number(alloc.supplyPercent) || 0) / 100,
        tokenDecimals,
      );
      debitToken(st, tokenMint, allocRaw, tokenDecimals);
    }

    // -- Phase 2: bootstrap every pool ------------------------------------
    // SOL-paired pools are deferred to the end of the bootstrap queue,
    // matching the real-mode lpService.js ordering. The bootstrap is the
    // moment a pool becomes tradable at the launch price; SOL pools are
    // indexed most aggressively by bots and aggregators, so flipping the
    // SOL pool to tradable while flywheel pools are still being built
    // would let the first wave of SOL-paired trades miss the flywheel.
    // By bootstrapping every flywheel before SOL, the first SOL-paired
    // trade activates the flywheel as intended.
    //
    // Stable sort: non-SOL allocations stay in user-config order, SOL
    // allocations are appended at the end in their original relative
    // order. results[] itself is NOT reordered — the launch report, UI,
    // and downstream consumers all assume user-config ordering.
    const bootstrapIterOrder = results
      .map((_, idx) => idx)
      .sort((a, b) => {
        const aIsSol = results[a].quoteSymbol === 'SOL';
        const bIsSol = results[b].quoteSymbol === 'SOL';
        return Number(aIsSol) - Number(bIsSol);
      });

    console.log('\n[demo] === Phase 2: opening bootstrap positions ===');
    for (const idx of bootstrapIterOrder) {
      const r = results[idx];
      console.log(`[demo] [${r.quoteSymbol}] opening bootstrap position`);
      await sleep(1500);
      r.bootstrap = {
        nftMint: demoAddress(),
        locked: false,
        // Narrow straddle around the launch tick — parity with the real
        // bootstrap record (the launch report renders the range).
        tickLower: -60,
        tickUpper: 60,
        txIds: { open: demoSignature(), lock: null },
      };
      // A bootstrap consumes a tiny bit of the quote side. We don't track
      // a quote balance per pool precisely; the SOL pool's bootstrap eats a
      // little SOL, which keeps the sweep's SOL figure believable.
      if (r.quoteSymbol === 'SOL') {
        st.solBalance = Math.max(0, st.solBalance - 0.001);
      }
      emit({ stage: 'bootstrap_open_done', allocationIndex: idx });
    }

    // -- Phase 3: lock every position -------------------------------------
    // Same SOL-last ordering as Phase 2 — see above. Locks don't change
    // tradability (positions already hold their liquidity), but mirroring
    // the open order here keeps the on-chain action sequence and the
    // activity-log display coherent.
    if (doLock) {
      console.log('\n[demo] === Phase 3: locking positions ===');
      const lockIterOrder = results
        .map((_, idx) => idx)
        .sort((a, b) => {
          const aIsSol = results[a].quoteSymbol === 'SOL';
          const bIsSol = results[b].quoteSymbol === 'SOL';
          return Number(aIsSol) - Number(bIsSol);
        });
      for (const idx of lockIterOrder) {
        const r = results[idx];
        for (let i = 0; i < r.mainPositions.length; i++) {
          const pos = r.mainPositions[i];
          console.log(`[demo] [${r.quoteSymbol}] locking main slice ${i + 1}/${r.mainPositions.length}`);
          await sleep(1500);
          pos.locked = true;
          pos.txIds.lock = demoSignature();
          // The real lock mints a NEW Fee Key NFT (the position NFT goes
          // into the lock program's escrow); model that with a fresh mint.
          pos.feeKeyNftMint = demoAddress();
          st.nfts.push({
            mint: pos.feeKeyNftMint,
            name: `Fee Key (${r.quoteSymbol} main ${i + 1})`,
            symbol: 'FEEKEY',
            programName: 'Token Program',
          });
          emit({ stage: 'main_lock_done', allocationIndex: idx, sliceIndex: i });
        }
        for (let bi = 0; bi < r.ladderPositions.length; bi++) {
          const lp = r.ladderPositions[bi];
          console.log(`[demo] [${r.quoteSymbol}] locking ladder band ${bi + 1}/${r.ladderPositions.length}`);
          await sleep(1200);
          lp.locked = true;
          lp.txIds.lock = demoSignature();
          lp.feeKeyNftMint = demoAddress();
          st.nfts.push({
            mint: lp.feeKeyNftMint,
            name: `Fee Key (${r.quoteSymbol} ladder ${bi + 1})`,
            symbol: 'FEEKEY',
            programName: 'Token Program',
          });
          emit({ stage: 'ladder_lock_done', allocationIndex: idx, bandIndex: bi });
        }
        // Support positions, same lifecycle as ladder (no recipient,
        // Fee Key stays with launch wallet for the Step 6 sweep).
        const supportPos = Array.isArray(r.supportPositions) ? r.supportPositions : [];
        for (let si = 0; si < supportPos.length; si++) {
          const sp = supportPos[si];
          console.log(`[demo] [${r.quoteSymbol}] locking support position ${si + 1}/${supportPos.length}`);
          await sleep(1200);
          sp.locked = true;
          sp.txIds.lock = demoSignature();
          sp.feeKeyNftMint = demoAddress();
          st.nfts.push({
            mint: sp.feeKeyNftMint,
            name: `Fee Key (${r.quoteSymbol} support)`,
            symbol: 'FEEKEY',
            programName: 'Token Program',
          });
          emit({ stage: 'support_lock_done', allocationIndex: idx, supportIndex: si });
        }
        if (r.bootstrap && r.bootstrap.nftMint) {
          console.log(`[demo] [${r.quoteSymbol}] locking bootstrap`);
          await sleep(1200);
          r.bootstrap.locked = true;
          r.bootstrap.txIds.lock = demoSignature();
          r.bootstrap.feeKeyNftMint = demoAddress();
          st.nfts.push({
            mint: r.bootstrap.feeKeyNftMint,
            name: `Fee Key (${r.quoteSymbol} bootstrap)`,
            symbol: 'FEEKEY',
            programName: 'Token Program',
          });
          emit({ stage: 'bootstrap_lock_done', allocationIndex: idx });
        }
      }
    } else {
      console.log('\n[demo] === Phase 3 skipped (lock disabled) ===');
    }

    // -- Phase 4: transfer Fee Keys to external recipients ----------------
    // Only slices with a recipient AND a successful lock have a Fee Key to
    // transfer. We mark transferredTo and remove that Fee Key from the
    // launch wallet's NFTs (it went to the external recipient), so it won't
    // show up in the Step 6 sweep.
    const hasAnyRecipient = results.some((r) =>
      r.mainPositions.some((p) => p.recipient && p.locked && !p.transferredTo),
    );
    if (hasAnyRecipient) {
      console.log('\n[demo] === Phase 4: transferring Fee Key NFTs ===');
      for (const [allocIdx, r] of results.entries()) {
        for (let i = 0; i < r.mainPositions.length; i++) {
          const pos = r.mainPositions[i];
          if (!pos.recipient || !pos.locked || pos.transferredTo) continue;
          console.log(`[demo] [${r.quoteSymbol}] transferring Fee Key (slice ${i + 1}) to ${pos.recipient}`);
          await sleep(1000);
          pos.transferredTo = pos.recipient;
          pos.txIds.transfer = demoSignature();
          // Remove the transferred Fee Key from the launch wallet. Same
          // preference order as lpService: the lock NFT is the Fee Key.
          const demoFeeKeyMint = pos.feeKeyNftMint || pos.nftMint;
          st.nfts = st.nfts.filter((n) => n.mint !== demoFeeKeyMint);
          emit({ stage: 'main_transfer_done', allocationIndex: allocIdx, sliceIndex: i });
        }
      }
    } else {
      console.log('\n[demo] === Phase 4: no Fee Key transfers needed (skip) ===');
    }

    console.log(`\n[demo] === LP creation complete: ${results.length} pool(s) ===\n`);
    res.json({ success: true, results });
  } catch (error) {
    console.error('[demo] create-lp error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
}

// ===========================================================================
// /api/resume-launch — not exercised on the happy path
// ===========================================================================
//
// Demo mode is happy-path only and create-lp always completes, so a resume
// should never actually be needed. Stub it to return success immediately so
// nothing crashes if it's somehow called.

export function handleResumeLaunch(req, res) {
  console.log('[demo] resume-launch called — returning success (no-op in demo)');
  res.json({ success: true, results: [] });
}

// ===========================================================================
// /api/transfer-assets — the final sweep (Step 6)
// ===========================================================================
//
// Enumerates the launch wallet's NFTs, fungible tokens, and SOL from the
// ledger; sleeps per item; removes each as it "transfers"; and returns the
// same { tokensTransferred, solTransferred, destinationWallet, nftSweep,
// tokenSweep, solSweepError, walletEmpty } shape the real endpoint returns.
// After the sweep the wallet is empty in the ledger (everything moved to the
// destination, which we don't track).

// Shared airdrop simulator — used by both handleTransferAssets (the
// in-band airdrop step that runs as part of the Step 6 sweep) and
// handleRetryAirdrop (the "Retry failed airdrops" button). Mirrors
// executeAirdrop's return shape: { transferred: [...], failed: [...] }
// with the SAME per-recipient field set the real handler produces
// (wallet, tokens, amountRaw, txId, attempts) so the frontend's
// summary panel and per-recipient progress rendering work unchanged.
//
// In demo mode every recipient succeeds (happy path only — failure
// injection isn't a goal of demo mode). The 1.5s per-recipient sleep
// makes the progress UI light up at familiar intervals; the real
// airdrop paces at AIRDROP_PACE_MS_DEFAULT (~600ms) but the demo
// runs slower so each delivery is visible.
//
// Tokens leave the launch wallet's ledger as they "deliver." This
// matches the real flow: airdropped tokens reduce the balance before
// the token sweep runs, so the sweep only carries leftover
// preallocation (if any) plus any auto-swapped quote-token residue.
async function simulateAirdrop({ st, tokenMint, tokenDecimals, recipients, onProgress = null }) {
  const transferred = [];
  const failed = [];
  for (let i = 0; i < recipients.length; i++) {
    const r = recipients[i];
    // Convert UI token amount to raw mint-base units. Same math the
    // real executeAirdrop uses; Math.round absorbs frontend float noise.
    const amountRaw = BigInt(Math.round(Number(r.tokens) * 10 ** tokenDecimals));
    console.log(`[demo] airdrop ${i + 1}/${recipients.length} → ${r.wallet} (${r.tokens} tokens)`);
    await sleep(1500);
    // Deduct from launch wallet's launched-token balance so the token
    // sweep that runs after airdrop transfers only the leftover.
    debitToken(st, tokenMint, amountRaw, tokenDecimals);
    transferred.push({
      wallet: r.wallet,
      tokens: r.tokens,
      amountRaw: amountRaw.toString(),
      txId: demoSignature(),
      attempts: 1,
    });
    if (typeof onProgress === 'function') {
      try { onProgress({ recipient: r.wallet, tokens: r.tokens, success: true }); }
      catch (_) { /* never let a progress callback break the simulation */ }
    }
  }
  console.log(`[demo] airdrop complete: ${transferred.length} delivered, ${failed.length} failed`);
  return { transferred, failed };
}

export async function handleTransferAssets(req, res, opts = {}) {
  try {
    const { tempWalletSecretKey, destinationWallet } = req.body;
    const publicKey = pubkeyFromSecretArray(tempWalletSecretKey);
    const st = getState(publicKey);
    // Optional progress hooks: server.js passes these so the
    // /api/airdrop-progress endpoint can show live progress while
    // simulateAirdrop runs. No-op when not provided.
    const progressHooks = opts.airdropProgress || null;

    console.log(`[demo] transferring assets to: ${destinationWallet}`);

    // 1. NFTs first (Fee Keys are the most valuable items).
    const nftTransferred = [];
    for (const nft of [...st.nfts]) {
      console.log(`[demo] sweeping NFT ${nft.mint} (${nft.name})`);
      await sleep(1000);
      nftTransferred.push({
        mint: nft.mint,
        txId: demoSignature(),
        programName: nft.programName || 'Token Program',
      });
    }
    st.nfts = [];
    const nftSweep = { transferred: nftTransferred, errors: [] };

    // 1.5. Airdrop, if configured. Matches the real handler's ordering:
    //      airdrop runs AFTER NFT sweep but BEFORE the token sweep,
    //      because the airdrop ships launched tokens out of the launch
    //      wallet to recipient wallets, and we want those tokens still
    //      present in the ledger when the airdrop runs. The token
    //      sweep below then carries whatever the airdrop left behind
    //      (typically the remaining preallocation supply).
    //
    //      Skipped silently when the airdrop payload is absent or
    //      empty — that's the simple-mode-without-airdrop case and
    //      the customize-mode-without-airdrop case. The frontend's
    //      airdrop summary panel handles `airdrop: null` correctly
    //      (just doesn't render the section).
    let airdropResult = null;
    if (req.body.airdrop
        && Array.isArray(req.body.airdrop.recipients)
        && req.body.airdrop.recipients.length > 0
        && req.body.airdrop.tokenMint
        && Number.isFinite(req.body.airdrop.tokenDecimals)) {
      const recipientCount = req.body.airdrop.recipients.length;
      console.log(`[demo] airdrop step: ${recipientCount} recipient(s)`);
      if (progressHooks) progressHooks.begin(publicKey, recipientCount);
      try {
        airdropResult = await simulateAirdrop({
          st,
          tokenMint: req.body.airdrop.tokenMint,
          tokenDecimals: req.body.airdrop.tokenDecimals,
          recipients: req.body.airdrop.recipients,
          onProgress: progressHooks
            ? (s) => progressHooks.step(publicKey, s)
            : null,
        });
      } finally {
        if (progressHooks) progressHooks.end(publicKey);
      }
    }

    // 2. All fungible tokens (launched token + leftover quote tokens).
    const tokenTransferred = [];
    for (const [mint, info] of Object.entries({ ...st.tokenBalances })) {
      if (!info || info.amountRaw === '0') continue;
      console.log(`[demo] sweeping token ${mint} (${info.amountUi})`);
      await sleep(1000);
      tokenTransferred.push({
        mint,
        amount: info.amountUi,
        decimals: info.decimals,
        txId: demoSignature(),
      });
    }
    st.tokenBalances = {};
    const tokenSweep = { transferred: tokenTransferred, errors: [] };

    // 3. SOL last.
    console.log('[demo] sweeping SOL');
    await sleep(2000);
    // Leave nothing behind — mirror a clean sweep. (Real sweeps leave a few
    // lamports for rent; the demo just zeroes it for a tidy "empty" state.)
    const solTransferred = st.solBalance;
    st.solBalance = 0;

    console.log('[demo] transfer complete — wallet empty');

    res.json({
      success: true,
      tokensTransferred: tokenTransferred.length,
      solTransferred,
      destinationWallet,
      nftSweep,
      tokenSweep,
      solSweepError: null,
      walletEmpty: true,
      // Match the real handler: airdrop is null when not configured,
      // or { transferred: [...], failed: [...] } when run. The
      // frontend reads response.airdrop.transferred.length and
      // response.airdrop.failed.length to render the summary panel.
      airdrop: airdropResult,
    });
  } catch (error) {
    console.error('[demo] transfer-assets error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
}

// ===========================================================================
// /api/retry-airdrop — the "Retry failed airdrops" button
// ===========================================================================
//
// Demo mode is happy-path only, so retries always succeed. The real handler
// uses the same executeAirdrop primitive as the in-band airdrop step; we
// reuse simulateAirdrop here for the same reason. Returns the same shape
// the real handler does: { success, airdrop: { transferred, failed } }.

export async function handleRetryAirdrop(req, res, opts = {}) {
  try {
    const {
      tempWalletSecretKey,
      tokenMint,
      tokenDecimals,
      recipients,
    } = req.body;

    if (!tempWalletSecretKey || !tokenMint
        || !Number.isFinite(tokenDecimals)
        || !Array.isArray(recipients) || recipients.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'tempWalletSecretKey, tokenMint, tokenDecimals, and recipients are required',
      });
    }

    const publicKey = pubkeyFromSecretArray(tempWalletSecretKey);
    const st = getState(publicKey);
    const progressHooks = opts.airdropProgress || null;

    console.log(`[demo] retry-airdrop: ${recipients.length} recipient(s)`);
    if (progressHooks) progressHooks.begin(publicKey, recipients.length);
    let airdropResult;
    try {
      airdropResult = await simulateAirdrop({
        st,
        tokenMint,
        tokenDecimals,
        recipients,
        onProgress: progressHooks
          ? (s) => progressHooks.step(publicKey, s)
          : null,
      });
    } finally {
      if (progressHooks) progressHooks.end(publicKey);
    }

    res.json({
      success: true,
      airdrop: airdropResult,
    });
  } catch (error) {
    console.error('[demo] retry-airdrop error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
}
