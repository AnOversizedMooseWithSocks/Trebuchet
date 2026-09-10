// swapService.js
//
// Acquires bootstrap-side quote tokens for the ephemeral launch wallet by
// swapping SOL → quote token on Raydium.
//
// IMPLEMENTATION NOTE
// -------------------
// We use Raydium's canonical Trade API (transaction-v1.raydium.io) rather
// than direct SDK pool-type-specific swap calls. Why:
//
//   - The Trade API auto-routes across all Raydium pool types (CLMM, CPMM,
//     AMM v4) AND can build multi-hop routes (e.g. SOL → USDC → TOKEN
//     when no direct pool exists). One code path covers everything.
//
//   - The SDK's pool-type-specific swap method signatures have drifted
//     between minor versions (CurveCalculator.swap → swapBaseInput,
//     PoolUtils.computeAmountOutFormat changes, etc.). Pinning to one
//     signature means future SDK upgrades could silently break our code.
//     The HTTP API has been a stable contract for over a year.
//
//   - It's the same API powering raydium.io/swap itself — battle-tested
//     by orders of magnitude more volume than any custom integration.
//
//   - No API key required. It's a public Raydium endpoint, the same
//     organization whose API we already call for getClmmConfigs and
//     fetchPoolByMints elsewhere in this app.
//
// Reference: https://docs.raydium.io/raydium/build/developer-guides/overview
//
// FAILURE-HANDLING STRATEGY
// -------------------------
// Bulletproof reliability is the main requirement here — if swaps fail,
// users go back to disabling the flywheel to avoid the friction.
//
//   1. RETRY LADDER. Each attempt widens slippage and bumps priority
//      fees. Most "swap failed" cases in practice are transient
//      fee-market congestion or price drift between quote and execute;
//      both clear within a few retries.
//
//   2. IDEMPOTENT BALANCE RE-READ. At the top of every retry we re-read
//      the wallet's quote-token balance. If a previous attempt's tx
//      actually landed but the response was lost (RPC blip, network
//      drop), the next iteration sees the satisfied balance and
//      short-circuits — no double-spend.
//
//   3. ERROR CLASSIFICATION:
//      - 'balance'   → wallet is short on SOL. ABORT, surface immediately.
//      - 'no_route'  → Trade API can't route this pair. Terminal.
//      - 'transient' → HTTP/RPC/blockhash issue. Retry.
//      - 'unknown'   → treat as transient with bounded retry budget.
//
//   4. PRE-FLIGHT CHECK. Verify wallet has enough SOL before attempting,
//      so we fail fast on doomed swaps and don't burn retry budget.
//
//   5. TERMINAL FAILURE → MANUAL FALLBACK. Throw messages tagged
//      INSUFFICIENT_SOL / NO_USABLE_POOL / ALL_ATTEMPTS_FAILED so the
//      frontend can convert the row into a manual-prefund row inline.
//      User always has a working path forward without restarting.
//
// Public API:
//   discoverRaydiumRoute(opts) → { available, effectiveQuoteUsd } | null
//   swapSolForQuote(opts) → { txId, swappedRaw, alreadyHadRaw,
//                              finalBalanceRaw, attemptsTried, succeeded }

import {
  Connection,
  PublicKey,
  LAMPORTS_PER_SOL,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  getAccount,
} from '@solana/spl-token';
import BN from 'bn.js';
import Decimal from 'decimal.js';
import { getRpcUrl } from './rpcConfig.js';
import {
  classifySwapError,
  computeSwapSpendLamports,
} from './swapMath.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WSOL_MINT = 'So11111111111111111111111111111111111111112';

// Raydium Trade API base URL. Public, keyless, the same endpoint that
// powers raydium.io/swap. See module header comment for why we use this
// instead of per-pool-type SDK swap methods.
const RAYDIUM_SWAP_API = 'https://transaction-v1.raydium.io';

// Probe amount used to verify Raydium can route a SOL→token swap and
// to derive an effective price. 0.01 SOL — small enough to be cheap,
// large enough to clear any "amount too small" floor in the routing
// engine.
const ROUTE_PROBE_LAMPORTS = '10000000'; // 0.01 SOL

// Retry ladder for the Trade API swap. Each rung widens slippage and
// bumps priority fee. Sized for the cents-of-USD swaps we do — over-
// budgeting priority is essentially free at this scale and dramatically
// improves landing probability under fee-market congestion.
//
//   slippageBps: 100 = 1%, 300 = 3%, 1000 = 10%
//   priorityFee: micro-lamports per CU
const RETRY_LADDER = [
  { slippageBps:  100, priorityFeeMicroLamports:  50_000 },
  { slippageBps:  300, priorityFeeMicroLamports: 200_000 },
  { slippageBps: 1000, priorityFeeMicroLamports: 500_000 },
];

// Backoff between retry attempts, in ms. Linear is fine — we're not
// hammering anything, just spacing for the fee market / RPC to settle.
const RETRY_BACKOFF_MS = 1000;

// Wait between submitting a tx and re-reading the balance to verify.
const POST_SWAP_SETTLE_MS = 2000;

// Time budget (ms) for Trade API HTTP calls before we treat them as
// transient failures. Both endpoints normally respond in <1s.
const TRADE_API_TIMEOUT_MS = 15_000;

// Time budget (ms) for tx confirmation. Longer than RPC sendTransaction
// usually needs — designed to tolerate moderate network congestion.
const CONFIRM_TIMEOUT_MS = 60_000;

// Route discovery cache. Keyed by quote mint. Process-lifetime —
// avoids re-probing the Trade API on every estimate refresh.
const routeDiscoveryCache = new Map();

// ---------------------------------------------------------------------------
// Test-only DI seams
// ---------------------------------------------------------------------------
//
// Optional overrides for the external boundaries swapService touches:
//   - the Connection factory (RPC client construction)
//   - the Trade API client (Raydium quote / transaction endpoints)
//   - the balance reader (SPL token + native SOL balance lookups)
//
// Production code uses the real implementations when these are null,
// which is the default and the only state at app start. Tests inject
// network-free fakes via the set*ForTests exports and clear them in
// afterEach() via resetTestFactories() / resetBalanceReaderForTests().
//
// Module-level state is fine here because the node:test runner runs
// tests serially by default. If a test ever turned on concurrency via
// test.concurrency, we'd need to move this into AsyncLocalStorage so
// concurrent tests don't trample each other's overrides — but no test
// currently uses concurrency, so the simple module-let approach is
// adequate and keeps the override-check fast (single null comparison).

let __connectionFactoryOverride = null;
let __tradeApiOverride = null;
let __balanceReaderOverride = null;

/**
 * Replace the function used to construct the Connection inside
 * swapSolForQuote. The override is called with no arguments and must
 * return a Connection-shaped object (sendTransaction, confirmTransaction,
 * getLatestBlockhash, etc.).
 */
export function setConnectionFactoryForTests(factory) {
  __connectionFactoryOverride = factory;
}

/**
 * Replace the Trade API client used inside swapSolForQuote. The
 * override must expose two methods matching the real call shape:
 *   fetchQuote({ inputMint, outputMint, amountLamports, slippageBps })
 *   fetchTransactions({ swapResponse, walletPubkey, priorityFeeMicroLamports })
 */
export function setTradeApiForTests(api) {
  __tradeApiOverride = api;
}

/**
 * Replace the token / SOL balance reader used inside swapSolForQuote.
 * The override must expose two methods:
 *   readTokenBalanceRaw(connection, ownerPk, mintPk) -> BN
 *   readSolBalanceLamports(connection, ownerPk) -> BN
 */
export function setBalanceReaderForTests(reader) {
  __balanceReaderOverride = reader;
}

/**
 * Clear all test overrides — returns the module to its production
 * behavior. Always safe to call (idempotent, no-throw).
 */
export function resetTestFactories() {
  __connectionFactoryOverride = null;
  __tradeApiOverride = null;
  __balanceReaderOverride = null;
}

/**
 * Clear ONLY the balance-reader override. Exists for tests that want
 * to keep a fake connection / trade API but swap balance behaviors
 * between sub-cases. Called as `swapService.resetBalanceReaderForTests?.()`
 * by the existing afterEach hook in test/swap-lifecycle.test.mjs.
 */
export function resetBalanceReaderForTests() {
  __balanceReaderOverride = null;
}

// Dispatcher helpers — return the override's result when one is set,
// otherwise call the real implementation. Kept as separate functions
// so swapSolForQuote stays readable: every override-aware call site
// reads as one of these obtain*() calls rather than an inline ternary.

function obtainConnection() {
  if (__connectionFactoryOverride) return __connectionFactoryOverride();
  return new Connection(getRpcUrl(), {
    commitment: 'confirmed',
    confirmTransactionInitialTimeout: 60_000,
  });
}

function obtainTokenBalance(connection, ownerPk, mintPk) {
  if (__balanceReaderOverride) {
    return __balanceReaderOverride.readTokenBalanceRaw(connection, ownerPk, mintPk);
  }
  return readTokenBalanceRaw(connection, ownerPk, mintPk);
}

function obtainSolBalance(connection, ownerPk) {
  if (__balanceReaderOverride) {
    return __balanceReaderOverride.readSolBalanceLamports(connection, ownerPk);
  }
  return readSolBalanceLamports(connection, ownerPk);
}

function obtainTradeApiQuote(args) {
  if (__tradeApiOverride) return __tradeApiOverride.fetchQuote(args);
  return fetchTradeApiQuote(args);
}

function obtainTradeApiTransactions(args) {
  if (__tradeApiOverride) return __tradeApiOverride.fetchTransactions(args);
  return fetchTradeApiTransactions(args);
}

// ---------------------------------------------------------------------------
// Route discovery (used at funding-estimate time)
// ---------------------------------------------------------------------------
//
// We use Raydium's Trade API /compute/swap-base-in endpoint as the
// authoritative "can we swap this?" check. Two big advantages over
// hitting api-v3.raydium.io's pool listing:
//
//   1. The Trade API auto-routes including multi-hop (SOL→USDC→TOKEN
//      when no direct SOL pair exists), so we discover everything the
//      actual swap can use, not just direct-pair pools.
//
//   2. The probe quote returns the effective price, which works for
//      low-volume tokens whose USD oracles (Coingecko/Jupiter pricing)
//      typically have no data. Critical for flywheel tokens.
//
// Discovery and the swap itself use the same routing engine, so
// "discovered" → "swappable" is a tight equivalence.

/**
 * Probe the Raydium Trade API to check if SOL→quoteMint is routable.
 * Returns the effective price (USD per whole quote token) derived from
 * the probe quote, or null if no route exists.
 *
 * @param quoteMint        Output token mint
 * @param quoteDecimals    Decimals of the output token
 * @param solUsd           Decimal of USD per whole SOL (used to convert
 *                         the SOL→token rate from the probe into a
 *                         USD-per-token number)
 * @param forceFresh       Default false. When true, bypasses the
 *                         in-memory route cache entirely — both on read
 *                         (always hits Trade API) and on write (cache
 *                         isn't disturbed). Used by pool creation to
 *                         get a just-in-time price right before the
 *                         pool is created, since pool creation may run
 *                         many minutes after the funding-estimate that
 *                         populated the cache, and on thin pools the
 *                         price can drift meaningfully in that window.
 * @returns { available: true, effectiveQuoteUsd: Decimal } on success,
 *          null if Raydium can't route the pair
 */
export async function discoverRaydiumRoute({
  quoteMint,
  quoteDecimals,
  solUsd,
  forceFresh = false,
}) {
  if (quoteMint === WSOL_MINT) return null;

  // Cache lookup. Skipped when forceFresh is true. The cache stores
  // both `null` (no route) and result objects (route found), so
  // check via has() not value-truthiness.
  if (!forceFresh && routeDiscoveryCache.has(quoteMint)) {
    return routeDiscoveryCache.get(quoteMint);
  }

  const url = new URL(`${RAYDIUM_SWAP_API}/compute/swap-base-in`);
  url.searchParams.set('inputMint', WSOL_MINT);
  url.searchParams.set('outputMint', quoteMint);
  url.searchParams.set('amount', ROUTE_PROBE_LAMPORTS);
  url.searchParams.set('slippageBps', '500');
  url.searchParams.set('txVersion', 'V0');

  let result = null;
  try {
    const resp = await fetchWithTimeout(url.toString(), {
      headers: { Accept: 'application/json' },
    });
    if (resp.ok) {
      const json = await resp.json();
      if (json?.success === true && json.data) {
        // inputAmount is in lamports (SOL has 9 decimals).
        // outputAmount is in raw quote token units.
        const inputAmount = new Decimal(json.data.inputAmount || 0);
        const outputAmount = new Decimal(json.data.outputAmount || 0);
        if (inputAmount.gt(0) && outputAmount.gt(0)) {
          const solWhole = inputAmount.div(new Decimal(10).pow(9));
          const tokensWhole = outputAmount.div(new Decimal(10).pow(quoteDecimals));
          // Effective USD price per whole quote token: (SOL spent in USD) / tokens received.
          const effectiveQuoteUsd = solWhole.mul(solUsd).div(tokensWhole);
          result = { available: true, effectiveQuoteUsd };
        }
      } else {
        // Trade API said no route. Surface the message in logs to help
        // diagnose if a token we expected to be routable isn't.
        console.log(
          `discoverRaydiumRoute: ${quoteMint} -> no route (${json?.msg || 'unknown'})`,
        );
      }
    } else {
      console.warn(`discoverRaydiumRoute: ${quoteMint} -> HTTP ${resp.status}`);
    }
  } catch (e) {
    console.warn(`discoverRaydiumRoute: ${quoteMint} ->`, e.message);
  }

  // Only persist when not a forceFresh call. A forceFresh probe is a
  // point-in-time snapshot for pool creation; it shouldn't poison the
  // cache that other callers (funding-estimate refreshes) rely on.
  if (!forceFresh) {
    routeDiscoveryCache.set(quoteMint, result);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Strict variant of the route probe — used at pool-creation time to
// enforce the "Raydium probe must succeed or we abort" safety rule.
//
// Unlike discoverRaydiumRoute (which swallows failures and returns null
// so callers can fall back gracefully), this function throws on every
// failure with a structured `err.code` so the caller can produce a
// specific user-facing message. The reason we need a separate function
// is that the discovery semantics differ:
//
//   discoverRaydiumRoute: "did we find a route? (null is acceptable
//                          and means 'no route, oracle fallback ok')"
//   probeRaydiumPriceStrict: "give us the live price NOW, and tell us
//                             precisely what went wrong if you can't"
//
// Always bypasses the route cache. The point of this call is to get
// a just-in-time snapshot, never to use a stale value. Also never
// writes to the cache (so concurrent funding-estimate refreshes
// aren't perturbed by the strict probe).
//
// Throws with the following error.code values on failure:
//   'NO_ROUTE'        — Trade API returned success=false / data absent.
//                       Quote token has no Raydium liquidity.
//   'HTTP_ERROR'      — Trade API responded with non-2xx status.
//                       Likely a transient API problem.
//   'NETWORK_ERROR'   — fetch threw (DNS, connection reset, timeout).
//                       Likely transient infrastructure issue.
//   'BAD_RESPONSE'    — Trade API success but amounts are zero/missing.
//                       Indicates an API contract change or anomaly.
//
// On success returns { effectiveQuoteUsd: Decimal, inputLamports,
// outputRaw } so callers can log diagnostics if they want.
export async function probeRaydiumPriceStrict({
  quoteMint,
  quoteDecimals,
  solUsd,
}) {
  if (quoteMint === WSOL_MINT) {
    // SOL is the input side of the probe. There's no probe for SOL
    // itself; callers should resolve SOL/USD via the oracle chain
    // instead and treat oracle failure as the hard-stop condition.
    const err = new Error('Cannot probe SOL against itself');
    err.code = 'INVALID_USAGE';
    throw err;
  }

  const url = new URL(`${RAYDIUM_SWAP_API}/compute/swap-base-in`);
  url.searchParams.set('inputMint', WSOL_MINT);
  url.searchParams.set('outputMint', quoteMint);
  url.searchParams.set('amount', ROUTE_PROBE_LAMPORTS);
  url.searchParams.set('slippageBps', '500');
  url.searchParams.set('txVersion', 'V0');

  let resp;
  try {
    resp = await fetchWithTimeout(url.toString(), {
      headers: { Accept: 'application/json' },
    });
  } catch (e) {
    // AbortError (timeout) and network failures land here.
    const err = new Error(
      `Couldn't reach the Raydium Trade API to verify the price of ${quoteMint}: ${e.message}`,
    );
    err.code = 'NETWORK_ERROR';
    err.cause = e;
    throw err;
  }

  if (!resp.ok) {
    const err = new Error(
      `Raydium Trade API returned HTTP ${resp.status} when probing ${quoteMint}`,
    );
    err.code = 'HTTP_ERROR';
    err.status = resp.status;
    throw err;
  }

  let json;
  try {
    json = await resp.json();
  } catch (e) {
    const err = new Error(
      `Raydium Trade API returned malformed JSON when probing ${quoteMint}`,
    );
    err.code = 'BAD_RESPONSE';
    err.cause = e;
    throw err;
  }

  if (json?.success !== true || !json.data) {
    const err = new Error(
      `Raydium can't route a swap against ${quoteMint}: ${json?.msg || 'no route'}`,
    );
    err.code = 'NO_ROUTE';
    err.raydiumMsg = json?.msg || null;
    throw err;
  }

  // inputAmount is in lamports (SOL has 9 decimals).
  // outputAmount is in raw quote token units.
  const inputAmount = new Decimal(json.data.inputAmount || 0);
  const outputAmount = new Decimal(json.data.outputAmount || 0);
  if (!inputAmount.gt(0) || !outputAmount.gt(0)) {
    const err = new Error(
      `Raydium probe for ${quoteMint} returned zero amounts ` +
      `(inputAmount=${inputAmount.toString()}, outputAmount=${outputAmount.toString()})`,
    );
    err.code = 'BAD_RESPONSE';
    throw err;
  }

  const solWhole = inputAmount.div(new Decimal(10).pow(9));
  const tokensWhole = outputAmount.div(new Decimal(10).pow(quoteDecimals));
  // Effective USD price per whole quote token:
  //   (SOL spent in USD) / (tokens received)
  const effectiveQuoteUsd = solWhole.mul(solUsd).div(tokensWhole);

  if (!effectiveQuoteUsd.isFinite() || !effectiveQuoteUsd.gt(0)) {
    const err = new Error(
      `Raydium probe for ${quoteMint} computed a non-positive price: ${effectiveQuoteUsd.toString()}`,
    );
    err.code = 'BAD_RESPONSE';
    throw err;
  }

  // Price impact of the probe notional, in percent, as reported by the
  // Trade API. This is the depth signal the launch path needs: a real
  // market absorbs the probe with a fraction of a percent of impact; a
  // dust pool shows tens of percent, and its "price" is just the last
  // tiny trade. null when the API didn't report it.
  const rawImpact = json.data.priceImpactPct;
  const priceImpactPct =
    rawImpact !== undefined && rawImpact !== null && Number.isFinite(Number(rawImpact))
      ? Number(rawImpact)
      : null;

  return {
    effectiveQuoteUsd,
    inputLamports: inputAmount,
    outputRaw: outputAmount,
    priceImpactPct,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * fetch() wrapper with an AbortController-based timeout. Without this,
 * a hung Raydium API call could stall a swap attempt indefinitely.
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = TRADE_API_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read the wallet's current balance for `mintPk` in raw units. Returns
 * BN(0) if the ATA doesn't exist yet or the read fails.
 *
 * Tries classic SPL first, then Token-2022. Our flywheel quote tokens
 * are classic SPL but the fallback keeps us safe for any user-supplied
 * Token-2022 quote in customize mode.
 */
async function readTokenBalanceRaw(connection, ownerPk, mintPk) {
  for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    try {
      const ata = getAssociatedTokenAddressSync(mintPk, ownerPk, true, programId);
      const acct = await getAccount(connection, ata, 'confirmed', programId);
      return new BN(acct.amount.toString());
    } catch (e) {
      // ATA doesn't exist or wrong program — try the other.
      continue;
    }
  }
  return new BN(0);
}

async function readSolBalanceLamports(connection, ownerPk) {
  try {
    return new BN(await connection.getBalance(ownerPk));
  } catch (e) {
    // RPC issue — return 0 conservatively; pre-flight will treat as
    // insufficient and surface the error before consuming retry budget.
    return new BN(0);
  }
}

// ---------------------------------------------------------------------------
// Trade API integration
// ---------------------------------------------------------------------------

/**
 * Fetch a swap quote from Raydium's Trade API.
 *
 * GET /compute/swap-base-in?inputMint=...&outputMint=...&amount=...
 *     &slippageBps=...&txVersion=V0
 *
 * Returns the parsed `swapResponse` object that gets POSTed to the
 * /transaction/swap-base-in endpoint. Throws on HTTP error or when
 * the API reports `success: false` (e.g. no route available).
 */
async function fetchTradeApiQuote({ inputMint, outputMint, amountLamports, slippageBps }) {
  const url = new URL(`${RAYDIUM_SWAP_API}/compute/swap-base-in`);
  url.searchParams.set('inputMint', inputMint);
  url.searchParams.set('outputMint', outputMint);
  url.searchParams.set('amount', amountLamports.toString());
  url.searchParams.set('slippageBps', String(slippageBps));
  url.searchParams.set('txVersion', 'V0');

  const resp = await fetchWithTimeout(url.toString(), {
    headers: { Accept: 'application/json' },
  });
  if (!resp.ok) {
    throw new Error(`Trade API quote: HTTP ${resp.status}`);
  }
  const json = await resp.json();
  if (!json || json.success !== true) {
    // The API returns { success: false, msg: '...' } for routing failures.
    const msg = json?.msg || json?.message || 'unknown error';
    // Bubble up routing-specific phrasing so classifyError can tag it.
    throw new Error(`Trade API quote failed: ${msg}`);
  }
  return json;
}

/**
 * Build serialized swap transactions from a quote.
 *
 * POST /transaction/swap-base-in
 * Body: { swapResponse, wallet, txVersion: 'V0', wrapSol: true,
 *         unwrapSol: false, computeUnitPriceMicroLamports: '...' }
 *
 * Returns an array of base64-encoded versioned transactions ready to
 * sign and submit. Multiple txs are returned when the route requires
 * setup steps (ATA creation, etc.) that can't fit in one tx.
 */
async function fetchTradeApiTransactions({
  swapResponse,
  walletPubkey,
  priorityFeeMicroLamports,
}) {
  const url = `${RAYDIUM_SWAP_API}/transaction/swap-base-in`;
  const resp = await fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      computeUnitPriceMicroLamports: String(priorityFeeMicroLamports),
      swapResponse,
      txVersion: 'V0',
      wallet: walletPubkey,
      // Input is SOL, so wrap automatically; output is an SPL token,
      // so no unwrap needed.
      wrapSol: true,
      unwrapSol: false,
      // inputAccount/outputAccount intentionally omitted — when input
      // is SOL we let the API derive (or skip) the wSOL ATA itself,
      // and for outputs the API derives the destination ATA.
    }),
  });
  if (!resp.ok) {
    throw new Error(`Trade API build: HTTP ${resp.status}`);
  }
  const json = await resp.json();
  if (!json || json.success !== true || !Array.isArray(json.data)) {
    const msg = json?.msg || json?.message || 'unknown error';
    throw new Error(`Trade API build failed: ${msg}`);
  }
  return json.data.map((entry) => entry.transaction);
}

/**
 * Sign and submit a single Trade-API-built transaction, then wait for
 * confirmation under a bounded timeout. Throws on any failure.
 */
async function signAndSendTradeApiTx(connection, ownerKeypair, base64Tx) {
  const txBuf = Buffer.from(base64Tx, 'base64');
  const tx = VersionedTransaction.deserialize(txBuf);
  tx.sign([ownerKeypair]);

  const signature = await connection.sendTransaction(tx, {
    skipPreflight: true,           // matches Raydium docs example; the
    maxRetries: 0,                 // API has already validated the route
  });

  // Confirm via the blockheight strategy. We use a freshly-fetched
  // blockhash here rather than extracting the tx's actual recentBlockhash
  // because:
  //   1. VersionedTransaction.message.recentBlockhash gives us the
  //      blockhash but NOT its lastValidBlockHeight — getting that
  //      would require another RPC call to resolve the block.
  //   2. The Trade API built this tx a second or two ago, so its blockhash
  //      is fresh; our just-fetched blockhash's lastValidBlockHeight is
  //      within a handful of blocks of the actual tx's expiry.
  //   3. The Promise.race wall-clock timeout below is the real safety
  //      net — even if the strategy waits too long for an already-expired
  //      tx, the timeout caps the total wait at CONFIRM_TIMEOUT_MS.
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash({
    commitment: 'finalized',
  });
  // Capture the timeout id so it can be cleared once confirmTransaction
  // settles. Without the clear, the timer stays armed for the full
  // CONFIRM_TIMEOUT_MS after a successful confirm, and that waste compounds
  // across the retry ladder. The late rejection itself isn't unhandled
  // (Promise.race consumes the loser's settlement) — this is timer hygiene.
  let confirmTimer;
  const confirmation = await Promise.race([
    connection.confirmTransaction(
      { blockhash, lastValidBlockHeight, signature },
      'confirmed',
    ),
    new Promise((_, reject) => {
      confirmTimer = setTimeout(
        () => reject(new Error('confirm timed out')),
        CONFIRM_TIMEOUT_MS,
      );
    }),
  ]).finally(() => clearTimeout(confirmTimer));
  if (confirmation?.value?.err) {
    throw new Error(`tx error: ${JSON.stringify(confirmation.value.err)}`);
  }
  return signature;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Acquire `targetRaw` units of `quoteMint` on the wallet by swapping
 * SOL via Raydium's Trade API.
 *
 * Returns:
 *   {
 *     txId:           string | null,   // null for already-satisfied / re-read
 *     swappedRaw:     BN,               // total acquired this call
 *     alreadyHadRaw:  BN,               // pre-call wallet balance
 *     finalBalanceRaw:BN,               // post-call wallet balance
 *     attemptsTried:  number,           // diagnostic
 *     succeeded:      boolean,          // finalBalanceRaw >= targetRaw
 *   }
 *
 * Throws only on terminal failure. Throw messages start with a tag the
 * endpoint surfaces verbatim:
 *   - "INSUFFICIENT_SOL: ..."     → wallet shortfall
 *   - "NO_USABLE_POOL: ..."       → no Raydium route available
 *   - "ALL_ATTEMPTS_FAILED: ..."  → tried everything, none worked
 */
export async function swapSolForQuote({
  ownerKeypair,
  quoteMint,
  targetRaw,
  // minRaw is the actual on-chain requirement (e.g. $1 of bootstrap
  // liquidity), as distinct from targetRaw (the ambitious acquire
  // target, oversize for slippage buffer). If a swap's actual delivery
  // lands between minRaw and targetRaw, the bootstrap need is met and
  // we should stop retrying. Without this, partial fills that satisfy
  // the real requirement still get retried, often expiring blockhashes
  // along the way and ultimately failing the row entirely. If minRaw
  // is omitted (older callers), it falls back to targetRaw — same
  // strict behavior as before.
  minRaw,
  quoteUsd,
  solUsd,
  quoteDecimals,
  sizingMultiplier = 2,
  // maxSpendLamports caps how much SOL a single swap attempt is allowed
  // to send. Defaults to 0.05 SOL — sized for minimal-mode dust targets
  // ($1 actual need × 4 compound multiplier = ~$4 of SOL spend with
  // ~$10 of headroom). For custom-mode bootstraps where the user has
  // intentionally committed large sums of SOL, that cap must scale
  // with the target. Caller (server.js) should pass an estimator-derived
  // value here based on autoSwapPlan.estSolSpend so the actual swap can
  // execute at the budgeted scale. Without this override, a $2000
  // custom bootstrap silently floors to ~$10 of acquired quote token,
  // breaking the bootstrap deposit downstream.
  maxSpendLamports,
}) {
  const ownerPk = ownerKeypair.publicKey;
  const mintPk = new PublicKey(quoteMint);

  // Normalize: minRaw is what we ACTUALLY need on the wallet; targetRaw
  // is what we'd LIKE to acquire to leave a slippage buffer. Default to
  // strict-target mode if caller didn't specify.
  const effectiveMinRaw = minRaw ? new BN(String(minRaw)) : targetRaw;

  console.log(
    `swapSolForQuote: ${quoteMint} (target raw ${targetRaw.toString()}, ` +
      `min raw ${effectiveMinRaw.toString()})`,
  );

  // No upfront pool-existence check needed — the first retry rung's
  // /compute/swap-base-in call acts as discovery. If Raydium can't
  // route, classifyError tags it 'no_route' and we throw NO_USABLE_POOL
  // from the retry loop. Saves a redundant HTTP call when the route
  // exists (the common case).

  // 1. Set up RPC connection. Note: we use a fresh Connection here
  //    rather than reusing one from elsewhere — the launch flow may
  //    take long enough that a stale connection's TCP socket has
  //    timed out, and the cost of opening a new one is negligible.
  //    Tests can inject a fake Connection via setConnectionFactoryForTests;
  //    obtainConnection() handles the override / production split.
  const connection = obtainConnection();

  // 3. Idempotent fast-path: if already satisfied, return cleanly.
  //    Uses effectiveMinRaw (the on-chain bootstrap need), not targetRaw
  //    (the oversize swap ambition). A previous partial-fill swap that
  //    delivered enough to satisfy the bootstrap should NOT trigger
  //    another swap on a re-call.
  const initialQuoteRaw = await obtainTokenBalance(connection, ownerPk, mintPk);
  if (initialQuoteRaw.gte(effectiveMinRaw)) {
    console.log(
      `  already satisfied (${initialQuoteRaw.toString()} >= ${effectiveMinRaw.toString()})`,
    );
    return {
      txId: null,
      swappedRaw: new BN(0),
      alreadyHadRaw: initialQuoteRaw,
      finalBalanceRaw: initialQuoteRaw,
      attemptsTried: 0,
      succeeded: true,
    };
  }

  // 4. Compute SOL spend for the swap. ExactIn pattern:
  //    missing_raw → missing_whole → USD value → SOL → lamports
  //    multiplied by safety factor. Caller provides quoteUsd/solUsd
  //    from the same getUsdPrice oracle the rest of the app uses.
  const {
    missingWhole,
    spendLamports,
    requiredLamports: required,
    txFeeHeadroomLamports,
  } = computeSwapSpendLamports({
    targetRaw,
    initialQuoteRaw,
    quoteDecimals,
    quoteUsd,
    solUsd,
    sizingMultiplier,
    maxSpendLamports,
  });

  // 5. Pre-flight: wallet must have spend + tx-fee headroom. Fail fast
  //    if not, so we surface the actionable error to the user instead
  //    of burning retry budget.
  const walletSol = await obtainSolBalance(connection, ownerPk);
  if (walletSol.lt(required)) {
    throw new Error(
      `INSUFFICIENT_SOL: wallet has ${(walletSol.toNumber() / LAMPORTS_PER_SOL).toFixed(6)} SOL, ` +
        `need ${(required.toNumber() / LAMPORTS_PER_SOL).toFixed(6)} SOL ` +
        `(${(spendLamports.toNumber() / LAMPORTS_PER_SOL).toFixed(6)} swap + ` +
        `${(txFeeHeadroomLamports.toNumber() / LAMPORTS_PER_SOL).toFixed(6)} tx headroom)`,
    );
  }

  console.log(
    `  spending up to ${(spendLamports.toNumber() / LAMPORTS_PER_SOL).toFixed(6)} SOL ` +
      `to acquire ~${missingWhole.toFixed(6)} ${quoteMint.slice(0, 6)}...`,
  );

  // 6. Retry ladder against the Trade API.
  const attemptErrors = [];
  let attemptsTried = 0;

  for (let rungIdx = 0; rungIdx < RETRY_LADDER.length; rungIdx++) {
    const rung = RETRY_LADDER[rungIdx];
    attemptsTried++;

    // Idempotency check at every retry: re-read balance. If a prior
    // attempt's tx actually landed but we lost the confirmation
    // (RPC blip / network drop), we'll see the satisfied balance
    // here and return cleanly without spending more SOL.
    //
    // Uses effectiveMinRaw — once we have ENOUGH for the bootstrap
    // need (e.g. $1), there's no point retrying just to hit the
    // bigger acquire target (e.g. $2). The bigger target exists as a
    // slippage buffer, not a hard requirement.
    const currentRaw = await obtainTokenBalance(connection, ownerPk, mintPk);
    if (currentRaw.gte(effectiveMinRaw)) {
      console.log(
        `    balance now satisfies bootstrap need (${currentRaw.toString()} >= ${effectiveMinRaw.toString()}); finishing`,
      );
      return {
        txId: null,
        swappedRaw: currentRaw.sub(initialQuoteRaw),
        alreadyHadRaw: initialQuoteRaw,
        finalBalanceRaw: currentRaw,
        attemptsTried,
        succeeded: true,
      };
    }

    try {
      console.log(
        `    attempt ${attemptsTried}: slip=${rung.slippageBps}bps ` +
          `prio=${rung.priorityFeeMicroLamports}uL`,
      );

      // 6a. Fetch quote.
      const swapResponse = await obtainTradeApiQuote({
        inputMint: WSOL_MINT,
        outputMint: quoteMint,
        amountLamports: spendLamports,
        slippageBps: rung.slippageBps,
      });

      // 6b. Build serialized transaction(s).
      const txs = await obtainTradeApiTransactions({
        swapResponse,
        walletPubkey: ownerPk.toBase58(),
        priorityFeeMicroLamports: rung.priorityFeeMicroLamports,
      });
      console.log(`    Trade API returned ${txs.length} tx(s) to sign`);

      // 6c. Sign and send each tx in order. Multi-tx responses happen
      //     when the route needs setup (ATA creation) that can't fit
      //     in a single tx. Each must succeed for the swap to land.
      let lastTxId = null;
      for (const base64Tx of txs) {
        lastTxId = await signAndSendTradeApiTx(connection, ownerKeypair, base64Tx);
        console.log(`    sent: ${lastTxId}`);
      }

      // 6d. Verify on-chain delta against the bootstrap minimum, not
      //     the oversize acquire target. A partial fill that still
      //     covers minRaw is a SUCCESS — no need to retry. Only flag
      //     as partial-fill-retry when even the minimum wasn't met.
      await new Promise((r) => setTimeout(r, POST_SWAP_SETTLE_MS));
      const finalRaw = await obtainTokenBalance(connection, ownerPk, mintPk);
      const swappedRaw = finalRaw.sub(initialQuoteRaw);
      if (finalRaw.lt(effectiveMinRaw)) {
        // Even the bootstrap minimum wasn't covered. This is a real
        // partial-fill problem — usually means the spend was too small
        // for the slippage we accepted. Bump the rung and retry.
        console.warn(
          `    tx landed but balance ${finalRaw.toString()} < min ${effectiveMinRaw.toString()}; will retry`,
        );
        attemptErrors.push(
          `attempt ${attemptsTried}: partial fill (${finalRaw.toString()} < ${effectiveMinRaw.toString()})`,
        );
        if (rungIdx < RETRY_LADDER.length - 1) {
          await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS));
        }
        continue;
      }
      // finalRaw >= minRaw → bootstrap need satisfied. Log if we fell
      // short of the ambition target (useful diagnostic) but still
      // return success.
      if (finalRaw.lt(targetRaw)) {
        console.log(
          `    landed below ambition target (${finalRaw.toString()} < ${targetRaw.toString()}) ` +
            `but >= bootstrap min ${effectiveMinRaw.toString()} - accepting`,
        );
      }
      return {
        txId: lastTxId,
        swappedRaw,
        alreadyHadRaw: initialQuoteRaw,
        finalBalanceRaw: finalRaw,
        attemptsTried,
        succeeded: true,
      };
    } catch (e) {
      const kind = classifySwapError(e);
      const summary = `${kind}: ${e.message}`;
      attemptErrors.push(`attempt ${attemptsTried}: ${summary}`);
      console.warn(`    failed (${summary})`);

      if (kind === 'balance') {
        // Bail immediately — no point retrying.
        throw new Error(`INSUFFICIENT_SOL: ${e.message}`);
      }
      if (kind === 'no_route') {
        // Trade API said it can't route this. Climbing the slippage
        // ladder won't change that. Bail to manual fallback.
        throw new Error(
          `NO_USABLE_POOL: Raydium can't route SOL->${quoteMint.slice(0, 8)}... (${e.message})`,
        );
      }
      // 'transient' or 'unknown' — climb the retry ladder.
      if (rungIdx < RETRY_LADDER.length - 1) {
        await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS));
      }
    }
  }

  // All rungs exhausted.
  throw new Error(
    `ALL_ATTEMPTS_FAILED: tried ${attemptsTried} attempt(s); ${attemptErrors.join(' | ')}`,
  );
}
