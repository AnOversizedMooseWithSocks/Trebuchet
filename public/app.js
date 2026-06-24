// app.js — frontend logic for Trebuchet
//
// Six-step launcher with collapsible step cards. Each step is in one of
// three states:
//
//   pending   — collapsed, dimmed, header non-clickable. Default for
//               all steps after the active one.
//   active    — expanded, full opacity. Exactly one step at a time.
//   completed — collapsed, full opacity, header clickable to re-expand
//               for review. Body is hidden but accessible.
//
// The sticky bar at the top of the page shows the current step number/
// title and a Cancel & Refund button. Cancel is available at any time
// after the wallet is generated, but is disabled while an in-flight
// operation (token creation, pool creation, etc.) is running. Cancel
// uses the same /api/transfer-assets endpoint as the normal final
// transfer — the difference is just the destination defaults to the
// detected funding wallet.

// ===========================================================================
// Defensive listener helper
// ===========================================================================
//
// Wraps document.getElementById + addEventListener so a single missing
// element doesn't crash the entire script and prevent other listeners from
// attaching. Without this, one bad reference can stop the whole page from
// working.
function bind(id, event, handler) {
  const el = document.getElementById(id);
  if (el) {
    el.addEventListener(event, handler);
  } else {
    console.warn(`Element #${id} not found — listener for "${event}" not attached.`);
  }
}

// ===========================================================================
// Local API session header
// ===========================================================================
//
// The backend requires an x-trebuchet-session header on every /api request
// except /api/session. Same-origin code can read that token; cross-origin
// pages cannot read it because the server does not opt into CORS.
const originalFetch = window.fetch.bind(window);
let apiSessionTokenPromise = null;

function isLocalApiRequest(input) {
  const raw = typeof input === 'string' ? input : input?.url;
  if (!raw) return false;
  const url = new URL(raw, window.location.href);
  return (
    url.origin === window.location.origin &&
    url.pathname.startsWith('/api/') &&
    url.pathname !== '/api/session'
  );
}

async function getApiSessionToken() {
  if (!apiSessionTokenPromise) {
    apiSessionTokenPromise = originalFetch('/api/session', {
      credentials: 'same-origin',
    })
      .then((r) => {
        if (!r.ok) throw new Error(`API session failed: HTTP ${r.status}`);
        return r.json();
      })
      .then((data) => {
        if (!data?.token) throw new Error('API session response missing token');
        return data.token;
      });
  }
  return apiSessionTokenPromise;
}

window.fetch = async (input, init = {}) => {
  if (!isLocalApiRequest(input)) return originalFetch(input, init);

  const headers = new Headers(
    init.headers || (input instanceof Request ? input.headers : undefined),
  );
  headers.set('x-trebuchet-session', await getApiSessionToken());
  return originalFetch(input, { ...init, headers });
};

// ===========================================================================
// Global state
// ===========================================================================

let tempWallet = null;
let createdTokenInfo = null;       // { mint, decimals, totalSupply, name, symbol }
let fundingWallet = null;
let balancePollHandle = null;
let lpResult = null;
let pools = [];
let fundingRequirement = { solLamports: 0, byQuote: {}, autoSwapPlan: [] };
// Airdrop execution result, populated by runTransfer() from the
// transfer-assets response (and updated by the retry path). Carries
// the per-recipient transferred/failed lists so the retry button has
// the data to resubmit, and the launch report can include an Airdrop
// section showing where the tokens went. Null when no airdrop ran or
// step 6 hasn't been reached.
//   { transferred: [{wallet, tokens, amountRaw, txId}, ...],
//     failed:      [{wallet, tokens, amountRaw, error}, ...] }
let lastAirdropResult = null;
// Airdrop plan restored from a launch journal (poolPlan.airdropPlan) when
// resuming a launch after an app restart. buildAirdropTransferPayload()
// falls back to this when the live simple-mode config can't produce a
// payload (it lives only in frontend memory and didn't survive the
// restart). Null in normal sessions.
let restoredAirdropPayload = null;

// Cache of resolved quote-token info, keyed by the canonical input the
// user typed/picked (e.g. 'SOL', 'USDC', or a base58 mint address). Each
// entry is the full info payload that resolvePoolQuote would otherwise
// fetch from /api/quote-token-info, plus a fetchedAt timestamp for
// price-staleness logic.
//
// Why we cache: rebuildPoolsFromSimple() (called on every simple-mode
// input event) clears pools[] and re-adds them, which without this cache
// would re-fire one network round-trip per pool per keystroke. That
// hammers the server's compat check (which calls Solana RPC and gets
// rate-limited) for no benefit — the user didn't change the quote token,
// the same mint resolves to the same metadata.
//
// Two TTLs:
//   - METADATA never expires for a given mint. Symbol, decimals, name,
//     image URL, Token-2022 status, and Raydium-CLMM compatibility don't
//     change for a given mint. Once we've successfully resolved them
//     they're permanent for the page session.
//   - PRICE expires after 60s. We re-fetch the price (and only the price)
//     after the TTL elapses. This is hit only on the next actual resolve
//     call, not on a timer — we don't want to drive RPC traffic from a
//     background loop.
//
// Cache survives across rebuildPoolsFromSimple() calls because it lives
// at module scope, not on the pool objects themselves.
const quoteInfoCache = new Map();
const QUOTE_PRICE_TTL_MS = 60_000;

// localStorage key for the persisted metadata cache. Versioned (v1) so
// if we ever change the metadata shape we can bump the version and
// gracefully ignore the older payload rather than crash on a
// schema-mismatched entry.
const QUOTE_META_LS_KEY = 'trebuchet:quote-meta-v1';

// Fields that are SAFE to persist long-term. These are properties of
// the on-chain mint itself — they don't change once the token is
// created — so caching them across sessions is correct and helpful.
// Anything not in this list (notably priceUsd) is volatile and gets
// refetched every session.
//
// If you add a new resolved field to the server payload, decide
// whether it belongs here (immutable mint property) or is volatile
// (changes with market/network state) and route accordingly.
const QUOTE_META_PERSISTENT_FIELDS = [
  'symbol',
  'decimals',
  'name',
  'imageUrl',
  'address',
  'compatible',
  'isToken2022',
  'disallowedNames',
  // Authority audit fields. These are properties of the on-chain mint
  // and only transition in one direction (authority can be renounced,
  // never re-added). Stale "freeze authority still active" would self-
  // heal on the next refetch; stale "renounced" can never happen
  // (one-way transition) so persistence is safe.
  'freezeAuthorityDisabled',
  'mintAuthorityRenounced',
  'freezeAuthorityBlock',
  'mintAuthorityWarning',
  // Intentionally NOT persisted:
  //   compatError — a transient string from the compat check (e.g.
  //   "RPC failure"). Persisting it would survive across sessions
  //   and, because the cache-merge "non-null wins, null falls back"
  //   rule preserves prior non-null values, a successful retry
  //   (compatError: null) wouldn't clear the stale error string.
  //   The pool would carry a phantom warning the user can't dismiss.
  //   raydiumTradeable — Raydium pools can come and go. We want
  //   a fresh probe per session, not a stale cached "yes" from a
  //   prior session when the pool may have been retired.
  //   raydiumProbeError — transient string, same logic as compatError.
  //   priceSource — display-only string about the price origin;
  //   re-derives every time priceUsd is updated.
  //
  //   Other compat fields (compatible, isToken2022, disallowedNames)
  //   are properties of the on-chain mint itself and self-heal across
  //   refetches.
];

// Read the persisted metadata map from localStorage. Returns a plain
// object keyed by quoteToken (mint address or canonical string).
// Returns an empty object on any error — corrupted storage shouldn't
// break the app, the worst case is we re-fetch metadata once.
function readPersistedQuoteMeta() {
  try {
    const raw = localStorage.getItem(QUOTE_META_LS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (e) {
    console.warn(`[quote-meta-cache] read failed: ${e.message}`);
    return {};
  }
}

// Write the persisted metadata map. Best-effort — localStorage can be
// disabled, full, or unavailable (e.g. private browsing in some
// browsers). On failure we log and continue; the in-memory cache
// still works for the current session.
function writePersistedQuoteMeta(map) {
  try {
    localStorage.setItem(QUOTE_META_LS_KEY, JSON.stringify(map));
  } catch (e) {
    console.warn(`[quote-meta-cache] write failed: ${e.message}`);
  }
}

// Persist one mint's metadata. Reads the existing map, sets/replaces
// the entry, writes back. We do this on every successful fetch so the
// cache stays current as new mints are encountered.
function persistQuoteMeta(quoteToken, info) {
  if (!info) return;
  const meta = {};
  for (const field of QUOTE_META_PERSISTENT_FIELDS) {
    if (info[field] !== undefined) meta[field] = info[field];
  }
  // Skip persisting if we don't have enough to be useful — a payload
  // with no symbol and no decimals is a failed resolution we shouldn't
  // pin to disk.
  if (meta.symbol == null && meta.decimals == null) return;
  const map = readPersistedQuoteMeta();
  map[quoteToken] = meta;
  writePersistedQuoteMeta(map);
}

// On startup, hydrate the in-memory cache with persisted metadata.
// Each hydrated entry is marked with priceFetchedAt = 0 so the next
// fetchQuoteInfoCached call for that mint goes to the server for a
// fresh price (priceUsd null → cache miss on TTL check). The merge
// logic then preserves the persisted metadata as the fresh response
// augments the cached entry.
//
// IIFE-wrapped so the hydration logic doesn't pollute module scope
// with temporary variables. Runs once at module load.
(function hydrateQuoteMetaFromStorage() {
  const map = readPersistedQuoteMeta();
  for (const [quoteToken, meta] of Object.entries(map)) {
    if (!meta || typeof meta !== 'object') continue;
    quoteInfoCache.set(quoteToken, {
      info: { ...meta, priceUsd: null },
      fetchedAt: 0, // 0 = always-stale, forces a price refresh on first use
    });
  }
})();

// In-flight fetch promises keyed by the same quoteToken string. Used to
// coalesce simultaneous resolve calls for the same mint — without this,
// the first render storm after a wallet generation could fire N parallel
// fetches for SOL before the first one returns, defeating the cache.
// Each entry is a Promise; subsequent callers await the same promise
// rather than starting a new fetch.
const quoteInfoInFlight = new Map();

// Demo mode flag. Set once on app load from /api/demo/status (see
// startup.js). When true, the demo banner and the "Pretend funding
// arrived" button are shown, and the server simulates all chain calls.
let demoModeActive = false;

// One-shot bypass for the beforeunload "launch in progress" guard. The demo
// toggle reloads the page to reset state, but it has ALREADY warned and
// confirmed with the user via the HTML confirm dialog. Without this flag the
// reload would also trip Electron's native "Launch in progress" dialog (a
// second, non-HTML prompt). setDemoMode sets this true just before reloading;
// the beforeunload handler checks it and lets the reload through silently.
let demoModeReloading = false;

// ---------------------------------------------------------------------------
// Flywheel presets
// ---------------------------------------------------------------------------
//
// The simple-config UI offers a flywheel pool alongside the SOL pool.
// Each entry below is one option in the flywheel dropdown. Edit this
// list to add/rename/disable flywheels — no other code needs to change
// since renderSimpleConfig() and rebuildPoolsFromSimple() drive purely
// off this object.
//
// Fields:
//   key          — internal identifier, used in simpleConfig.flywheelKey
//                  and never shown to the user
//   label        — short text shown in the dropdown
//   mint         — quote-token mint address; passed to addPool() exactly
//                  as the existing dropdown options do
//   description  — optional short tagline shown next to the dropdown
//   available    — when false, the option is shown grayed out as a hint
//                  that this flywheel exists but isn't launched yet
const FLYWHEELS = {
  reserve: {
    key: 'reserve',
    label: 'Reserve',
    mint: 'J1bZFRAFC8ALqAN7ktkcCpobgoeTGfP5Xh1BwCP1oqoj',
    description: 'wBTC + ETH reserve flywheel',
    available: true,
  },
  meme: {
    key: 'meme',
    label: 'Meme',
    mint: 'HipYKXiDh3Kjd1jb7ji6jCEsKQMSGWiFJMdtvH8yb5r',
    description: 'Meme-token flywheel',
    available: true,
  },
};

// Flywheel allocation bounds and default. The slider in the simple-config
// UI lets users dial this between MIN and MAX; default is the value the
// PRESETS_PLAN.md called for (90% SOL is the main trading venue, 10%
// flywheel siphons accumulation into the chosen reserve token). The 30%
// upper bound matches the design-decision guidance "users who want
// heavier flywheel exposure" — beyond that, customize-mode is the right
// place since they're really designing a different launch shape.
const DEFAULT_FLYWHEEL_PERCENT = 10;
const FLYWHEEL_MIN_PERCENT = 10;
const FLYWHEEL_MAX_PERCENT = 30;

// LP-split bounds for the "Split the LP" simple-config toggle. Each
// position in a pool's distribution mints its own Fee Key NFT, so
// splitCount = N means N transferable fee streams per pool. We cap at
// 10 to avoid runaway position counts (a flywheel-on launch already
// has 2 pools, so split=10 means 20 NFTs to track).
const SPLIT_MIN_COUNT = 1;
const SPLIT_MAX_COUNT = 10;

// Ladder bounds for the "Ladder positions" simple-config toggle. Sliders
// control how much supply goes to ladder bands (20-80% default 50%) and
// how many bands the supply is split across (3-10 default 5). The
// ceiling is hardcoded at 1000× launch price — wide enough that the
// last band doesn't act as an artificial cap for any realistic
// price trajectory but small enough to keep bands meaningfully sized.
const LADDER_DEFAULT_PERCENT = 50;
const LADDER_MIN_PERCENT = 20;
const LADDER_MAX_PERCENT = 80;
const LADDER_DEFAULT_BANDS = 5;
const LADDER_MIN_BANDS = 3;
const LADDER_MAX_BANDS = 10;
const LADDER_CEILING_MULTIPLIER = 1000;

// Custom Positions ladder — strategy picker controls (the per-pool advanced
// editor). The simple-config sliders above still use LADDER_DEFAULT_* /
// LADDER_CEILING_MULTIPLIER; these drive the strategy-based generator instead.
//
//   Gap     — the empty "air-pocket" multiplier before the first band. The
//             ladder lays out over [gap×, ceiling×]. A wider gap leaves more
//             room for early price discovery before resistance kicks in;
//             lower-mcap launches tend to want a wider gap. Default 4×.
//   Ceiling — the top of the ladder. Default 100,000×; adjustable up to the
//             multiplier that reaches a $1B fully-diluted market cap
//             (CEILING_MAX_MCAP_USD ÷ launch market cap — see
//             poolMaxCeilingMultiplier). Above ~$1B FDV isn't an honest place
//             to park ladder supply, so that's the cap we expose.
//   Strategy — which volatility shape generates the bands. Default 'dbl'
//             (Doubling): thin near launch, supply fanned toward the ceiling.
const LADDER_GAP_DEFAULT = 4;
const LADDER_GAP_MIN = 1;
const LADDER_GAP_MAX = 10;
const LADDER_CEILING_DEFAULT = 100000;
const LADDER_DEFAULT_STRATEGY = 'dbl';

// Minimum width of a ladder band, as a price ratio (upper ÷ lower). The
// widening shapes (Doubling, Gapped Doubling) floor their first band at this so
// it can't collapse into a hair-thin sliver right at launch — strict log-width
// doubling otherwise makes the first band span/(2^bands − 1) wide, which is
// near-zero for large band counts. The first band is at least this wide; the
// rest widen from there.
const LADDER_MIN_BAND_RATIO = 1.5;

// Honest upper bound for the ladder ceiling: a $1B fully-diluted market cap.
// The ceiling is a multiple of the launch price, and market cap scales linearly
// with price (supply is fixed), so the max ceiling multiplier is simply
// CEILING_MAX_MCAP_USD ÷ launch market cap. The tick range allows absurd
// (~1e25×) multiples, and nobody ladders supply above a $1B FDV, so this is the
// cap we actually expose. See poolMaxCeilingMultiplier.
const CEILING_MAX_MCAP_USD = 1_000_000_000;

// Fallback ceiling cap (a multiplier) used only before the market cap is set,
// when the $1B-equivalent multiple can't be computed yet.
const LADDER_CEILING_FALLBACK_MAX = 1_000_000;

// Support position depth bounds (in % below launch price).
//   Default 10% — covers typical post-launch dip range without
//   over-spreading the deposited SOL across too many ticks.
//   Min 1%     — below this, computeSupportTicks collapses on
//                high-tickSpacing fee tiers (the position would span
//                a single tickSpacing, making it nearly useless).
//   Max 50%    — below this, the per-tick density gets too thin for
//                the support to actually backstop sells in any
//                meaningful way; user might as well place liquidity
//                via the normal main/ladder system.
const SUPPORT_DEFAULT_DEPTH_PCT = 10;
const SUPPORT_MIN_DEPTH_PCT = 1;
const SUPPORT_MAX_DEPTH_PCT = 50;

// Hard upper bound on the whole-token total supply the user can enter.
//
// The on-chain ceiling at 9 decimals is actually ~18.4 billion — that's
// floor((2^64 - 1) / 10^9), the largest whole-token value whose raw u64
// representation fits in the SPL mint. We cap at 10 billion instead,
// well below that hard limit, for two reasons:
//
//   1. Operator policy. Launches with absurd supplies (1 trillion+) tend
//      to be users who haven't thought about per-token price implications
//      and will end up with a launch that fails downstream regardless —
//      either at the mint (over the u64 ceiling) or at the LP-creation
//      math, where extreme supplies push tick spacing and pool prices
//      into floating-point precision danger zones.
//   2. A round limit that's clearly below the hard ceiling makes the
//      error message actionable. "Max is 10,000,000,000" is something
//      a user can act on; "Max is 18,446,744,073" is a number that begs
//      questions about where it came from.
//
// If the decimals constant in tokenService.js ever changes from 9,
// the on-chain ceiling shifts accordingly but this policy cap stays
// where it is (it's user-experience policy, not a chain limit).
const MAX_TOKEN_SUPPLY = 10_000_000_000;

// Logo upload constraints.
//
// MAX_LOGO_BYTES mirrors the server-side multer cap (server.js: 100KB)
// so the client rejects oversized files immediately rather than the
// user clicking Create Token, waiting through the upload, and getting
// an opaque error. Keeping these two numbers in sync is a manual
// concern — if the server cap ever moves, this one needs to move too.
//
// MAX_LOGO_DIMENSION caps the resolution. The chain doesn't care, but:
//   - Token logo displays in wallets/explorers downsize aggressively;
//     anything over 1024 is wasted bytes that bloat the Arweave upload.
//   - A 4096×4096 PNG that compresses well can sneak under the byte
//     cap and still be a bad upload — pure size isn't sufficient.
//   - 1024 matches what Solscan, Jupiter, and Phantom recommend.
//
// MIN_LOGO_DIMENSION rejects accidentally-tiny pickups (favicons, etc.)
// that would look terrible on the launched token's listings. 64 is
// small enough to allow simple pixel-art logos while catching the
// common "I picked the wrong file" case.
const MAX_LOGO_BYTES = 100 * 1024;
const MAX_LOGO_DIMENSION = 1024;
const MIN_LOGO_DIMENSION = 64;

// State for the simple-config UI. `mode` is the master switch:
//   'default'   — show the simple toggle+dropdown UI; pool list hidden
//                 (rebuilt automatically on every config change)
//   'customize' — show the full pool list editor; simple controls hidden
//                 (user has manual control over pool composition)
//
// Switching from default → customize preserves the currently-rendered
// pools (so the user keeps whatever they were about to launch with).
// Switching back wipes pools and rebuilds defaults — confirmation
// prompt handles the "lose customizations" case.
//
// flywheelPercent is the slider value. Persists across toggle off→on
// cycles so users don't lose their chosen allocation by accidentally
// toggling.
//
// splitEnabled + splitCount control the "Split the LP" feature: when
// enabled with count > 1, each pool's distribution is N equal slices,
// producing N transferable Fee Key NFTs per pool. When disabled or at
// 1, each pool has a single 100% slice (the historical default).
//
// bootstrapMode + bootstrapSolValue control the bootstrap position
// thickness. Default mode 'minimal' preserves the historical 1-whole-
// token-and-narrow-band behavior; 'custom' deposits bootstrapSolValue
// SOL worth of total starting liquidity, split evenly across all pools
// and using full-range positions so the support is visible across every
// price level. The split is computed at submit time from the number of
// pools in the current configuration.
let simpleConfig = {
  mode: 'default',
  flywheelEnabled: true,
  // Default flywheel: meme. The marketing site documents that the meme
  // flywheel's pair set includes the reserve flywheel itself, so picking
  // meme by default gets users into BOTH networks at once — reserve-pair
  // arbitrage cascades reach meme-launched tokens automatically through
  // the meme↔reserve pool, while reserve-launched tokens only see the
  // reserve network. Users launching serious / utility tokens can still
  // pick Reserve manually; the in-app flywheel explainer modal still
  // documents both use cases.
  flywheelKey: 'meme',
  flywheelPercent: DEFAULT_FLYWHEEL_PERCENT,
  splitEnabled: false,
  splitCount: 1,
  bootstrapMode: 'minimal',
  bootstrapSolValue: 1, // total SOL to commit, when bootstrapMode === 'custom'
  // Ladder positions: when enabled, splits each pool's main allocation
  // into a wide remainder plus N single-sided bands at log-spaced price
  // ranges going from launch up to a 1000× ceiling. Distributes supply
  // more evenly across mcap levels and creates natural support/resistance
  // zones. Off by default for backward compatibility.
  ladderEnabled: false,
  ladderPercent: LADDER_DEFAULT_PERCENT,
  ladderBandCount: LADDER_DEFAULT_BANDS,
  // Which volatility shape the simple-mode ladder uses. Mirrors the
  // strategy picker in customize mode; the bands the simple config
  // generates now come from generateLadderStrategyBands with this shape
  // (Doubling by default) rather than the old equal log-spaced layout.
  ladderStrategy: LADDER_DEFAULT_STRATEGY,
  // Preallocation: % of total token supply that's held BACK from LP. Used
  // for team/VC/presale tokens, staking rewards, utility reserves, etc.
  // The pool allocations scale down proportionally so the sum of all
  // pool.supplyPercent values equals (100 - preallocationPercent).
  //
  // Preallocation by itself is purely a UI/budget concept — the tokens
  // simply stay in the launch wallet (or get distributed by the user
  // post-launch). Backing for that supply is provided via the SUPPORT
  // position (see supportEnabled below).
  preallocationEnabled: false,
  preallocationPercent: 1, // % of total supply; default if user enables
  // The user's *typed* value for prealloc %. When auto-fit is on, the
  // effective preallocationPercent is max(this, airdrop_required_pct).
  // Stored separately so the user's typed value survives airdrop edits
  // that bump the effective percent up; lowering the airdrop later
  // returns the effective percent to the user's typed value.
  preallocationPercentInput: 1,
  // Auto-fit airdrop: when on, the preallocation % is automatically
  // raised (but never lowered) to fit the airdrop list's required
  // tokens. The user's typed % acts as a minimum floor. Off means
  // the over-budget red error fires when the airdrop exceeds the
  // typed %, leaving the fix to the user.
  preallocationAutoFit: true,
  // Support position: a single-sided QUOTE position sitting just below
  // launch price (down to -supportDepthPct), funded by the user as SOL.
  // It backs preallocated supply by giving the holders a buy wall to
  // sell into. Quote-only — no token supply consumed, so this is
  // orthogonal to the pool allocation math. The simple-UI toggle puts
  // support on the SOL pool only; customize mode lets each pool
  // configure its own.
  //
  // supportDepthPct is the % below launch that the position covers.
  // Default of 10% balances coverage (catches typical post-launch dips)
  // with per-tick liquidity density (deeper ranges spread the same SOL
  // across more ticks, thinning each tick's depth).
  supportEnabled: false,
  supportSolValue: 1, // SOL committed to the support position
  supportDepthPct: 10, // % depth below launch price, in [1, 50]
  // When true, the support SOL value is kept in sync with the
  // preallocation's USD-equivalent (the "honest backing" amount). When
  // false, the user has manual control over the SOL value. Surfaced
  // as an "Auto" checkbox next to the support SOL input. When ON the
  // SOL input is disabled and shows the computed value; when OFF the
  // user can type freely.
  //
  // Default true — the natural pairing of preallocation + support is
  // equal-value backing, and starting with auto on makes that the
  // path of least resistance. The user can switch to manual any time.
  supportAutoSize: true,
  // UI-only: whether the collapsible "Advanced options" section in
  // simple mode is currently expanded. Persists across re-renders so
  // the section doesn't snap shut when the user types in one of its
  // inputs. Default closed because the advanced section is for users
  // who specifically want it — most launches use the headline controls
  // (flywheel, preallocation, support) and never touch the advanced
  // ones (starting liquidity, split LP, ladder).
  _advancedExpanded: false,
  // Airdrop config — a sub-feature of preallocation that lets the user
  // upload a CSV of {wallet, sol_contributed} rows and have the launcher
  // calculate token amounts per recipient based on the launch starting
  // price. Each row's token count = (sol × SOL_USD × supply) / market_cap
  // — the same "fair value at launch" rate the launch itself uses, so a
  // contributor receives tokens worth the same USD as they sent.
  //
  // Disabled (and the toggle/inputs greyed) when preallocation is off,
  // since the preallocation supply is the budget for the airdrop —
  // without preallocation there's nothing to distribute.
  //
  // csvText is the raw user input (file upload or pasted). parsedRows
  // is what the parser produced; parseError and budgetError carry
  // user-facing error strings. Re-parsing is keystroke-driven from the
  // textarea so the preview / errors update live. The actual on-chain
  // distribution is performed during the Transfer Assets step (Step 6),
  // alongside the NFT/token/SOL sweep. The recipient list and per-row
  // token amounts are assembled by buildAirdropTransferPayload() and
  // POSTed with the transfer-assets request; the server executes each
  // recipient as its own classic-SPL transferChecked transaction so
  // failures are isolated per-recipient. Partial failures surface in
  // the transfer result UI with a Retry button.
  airdrop: {
    enabled: false,
    csvText: '',
    parsedRows: [],
    parseError: null,
    budgetError: null,
    // _expanded: collapse state for the AIRDROP <details> sub-section
    // (CSV upload UI). _breakdownExpanded: collapse state for the
    // per-wallet rows nested inside the preallocation breakdown table.
    // Both persist across re-renders so a render triggered by typing
    // doesn't snap the section shut.
    _expanded: false,
    _breakdownExpanded: false,
  },
};

// Build a distribution array of N equal slices that sum to exactly 100%.
// We round each slice to 2 decimal places (10000/N / 100) and assign the
// rounding remainder to the last slice, so:
//   N=3  → 33.33, 33.33, 33.34   (sum 100.00)
//   N=7  → 14.28 × 6, 14.32      (sum 100.00)
//   N=10 → 10.00 × 10            (sum 100.00)
// Build N equal slices that sum to a target total (default 100). Used by:
//   - The simple-UI "Split the LP" toggle which produces N slices that
//     subdivide the wide portion of a pool.
//   - The customize-mode "Add slice" button which expands the slice count.
//
// totalPct is the sum these slices should add to. When the pool has no
// bootstrap or ladder, the wide gets the full 100% of pool and slices
// sum to 100. When bootstrap is custom (say 2% of pool) and ladder
// takes 50% of pool, wide gets 48%, so slices sum to 48 (not 100).
// Each slice gets totalPct / count, with rounding remainder absorbed
// into the last slice so the sum is exact.
//
// Stays within the backend's 0.01 tolerance and keeps every share > 0,
// which normalizeDistribution() requires.
//
// For count <= 1, returns a single slice at the full totalPct — same
// shape as the addPool default, so callers can use this unconditionally
// without special-casing.
function buildEqualSplitDistribution(count, totalPct = 100) {
  if (!Number.isFinite(totalPct) || totalPct < 0) totalPct = 100;
  if (!count || count <= 1) {
    return [{ sharePercent: totalPct, recipient: null, useExternalRecipient: false }];
  }
  const each = Math.floor((totalPct * 10000 / count)) / 10000;
  const slices = [];
  let assigned = 0;
  for (let i = 0; i < count - 1; i++) {
    slices.push({ sharePercent: each, recipient: null, useExternalRecipient: false });
    assigned += each;
  }
  // Last slice picks up any rounding remainder so total is exactly totalPct.
  slices.push({
    sharePercent: Number((totalPct - assigned).toFixed(4)),
    recipient: null,
    useExternalRecipient: false,
  });
  return slices;
}

// CLMM fee tiers populated at startup from /api/clmm-fee-tiers, which in
// turn pulls from Raydium's published config endpoint. The hardcoded list
// here is a fallback used while the fetch is in flight (so adding the
// first pool before the network call returns doesn't blow up) and as a
// last resort if the fetch fails entirely. Each entry is { index,
// tradeFeeRate, tickSpacing }; tradeFeeRate is in 1e-6 units, so 10000
// = 1%.
let feeTiers = [
  { index: 2, tradeFeeRate:   100, tickSpacing:   1 }, // 0.01%
  { index: 1, tradeFeeRate:   500, tickSpacing:  10 }, // 0.05%
  { index: 0, tradeFeeRate:  2500, tickSpacing:  60 }, // 0.25%
  { index: 3, tradeFeeRate: 10000, tickSpacing: 120 }, // 1%
];

// Run state — when an operation is in flight, disable cancel and step toggles
// to avoid sending a cancel sweep mid-transaction
let isRunningOperation = false;

// Current active step (1-6)
let currentStep = 1;

// Step titles for the sticky bar
const STEP_TITLES = {
  1: 'Generate Wallet',
  2: 'Token & Pool Configuration',
  3: 'Fund Wallet',
  4: 'Create Token',
  5: 'Create Pools',
  6: 'Transfer Assets',
};

// ===========================================================================
// Logging
// ===========================================================================
const activityLog = document.getElementById('activityLog');

// Maximum number of entries to keep in the activity log. The server-log
// streamer polls every 2s and appends any new server-side entries — over
// a long-running session (hours, especially with active RPC chatter
// during pool creation or auto-swap retries), the log can accumulate
// thousands of <div> nodes. Each entry stays in the DOM, participates in
// layout, and slows down scrolling, append, and the rest of the page as
// it grows. Symptoms include progressively laggy UI that "feels like a
// freeze" but is really just death-by-DOM-size.
//
// 1500 chosen as a balance: a typical clean launch generates 30-80
// entries, a launch with retries 100-200, and a long session with lots
// of server chatter might approach 1000 — so 1500 gives comfortable
// headroom while still capping the absolute worst case.
//
// trimActivityLog() drops oldest entries when over cap, called from
// both log() and appendServerLogEntry() after each append. Trim cost is
// O(1) per call in steady state (one removal at most once cap is hit).
const MAX_LOG_ENTRIES = 1500;
function trimActivityLog() {
  // Use childElementCount rather than .length on a stale childNodes
  // collection — children can include text nodes from whitespace and
  // we only want to count actual entry divs.
  while (activityLog.childElementCount > MAX_LOG_ENTRIES) {
    activityLog.removeChild(activityLog.firstElementChild);
  }
}

function log(message, type = 'info') {
  // Accept 'error' as a backwards-compatible alias for 'danger' — the CSS
  // class is .danger (Bulma convention), but a lot of older / muscle-
  // memory code calls log(msg, 'danger'). Without this normalization the
  // 'error'-labeled entries would render as default (green) text, hiding
  // real errors from the user.
  if (type === 'error') type = 'danger';

  // Escape HTML in the message — `message` is rendered via innerHTML
  // so that we can include the timestamp span, and callers do frequently
  // pass error messages that come from third-party indexers or RPC
  // responses (potentially attacker-controlled). Without escaping, a
  // crafted error string could inject script or break the layout.
  // Doing it here means every log site is safe by construction; we
  // don't have to audit every caller.
  const safe = String(message)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
  const entry = document.createElement('div');
  entry.className = `log-entry ${type}`;
  entry.innerHTML = `<span class="timestamp">[${ts}]</span><span>${safe}</span>`;
  activityLog.appendChild(entry);
  trimActivityLog();
  activityLog.scrollTop = activityLog.scrollHeight;
}

// ===========================================================================
// Structured error display — categorization and "What happened?" explainers
// ===========================================================================
//
// Categorises error messages into types so the UI can show category-specific
// recovery suggestions and plain-language explanations. Categories:
//   rpc        — RPC endpoint errors (rate limiting, connection refused, etc.)
//   onchain    — On-chain transaction failures (instruction errors, etc.)
//   validation — User input / config errors (invalid addresses, bad amounts)
//   network    — HTTP / fetch errors from our own server or third-parties
//   unknown    — Anything that doesn\'t match a known pattern

const ERROR_CATEGORIES = {
  rpc: {
    label: 'RPC',
    cssClass: 'cat-rpc',
    patterns: [
      /rate.?limit/i, /429/i, /too many requests/i, /throttl/i,
      /sendTransaction.*failed/i, /getHealth/i, /rpc.*error/i,
      /Couldn\'t verify the wallet balance.*RPC/i, /RPC.*down/i,
      /RPC.*unreachable/i, /Balance polling is failing/i,
      /Connection.*refused/i, /ECONNREFUSED/i,
      /getVersion.*error/i, /getBlockHeight.*error/i,
    ],
    suggestion: 'Try switching to a dedicated RPC endpoint (Helius, QuickNode, Triton). '
      + 'Open the RPC settings panel above to add one — free tiers are plenty '
      + 'for a launch. Public endpoints get rate-limited mid-flow.',
    explainer: 'Solana RPC nodes have rate limits that can throttle or reject '
      + 'transactions when they receive too many requests in a short window. '
      + 'Pool creation sends dozens of transactions in rapid succession, which '
      + 'is exactly the pattern that triggers these limits on shared/public endpoints. '
      + 'A dedicated endpoint (even a free tier) has a much higher limit.',
  },
  onchain: {
    label: 'On-chain',
    cssClass: 'cat-onchain',
    patterns: [
      /instruction.?error/i, /custom.*program.*error/i, /0x[0-9a-f]{1,4}\b/i,
      /insufficient.*lamports/i, /insufficient.*funds/i,
      /ConstraintMintTokenProgram/i, /Token.*2022/i,
      /Anchor.*constraint/i, /program.*failed/i,
      /blockhash.*not found/i, /transaction.*expired/i,
      /comput.*budget/i, /exceeded.*limit/i,
    ],
    suggestion: 'If this is a Token-2022 mint issue, use a standard SPL Token mint. '
      + 'If it\'s a funds issue, your ephemeral wallet may need more SOL — add extra '
      + 'SOL to the launch wallet and use Resume Launch. For compute-budget errors, '
      + 'try reducing the number of pools or increasing the priority fee.',
    explainer: 'This error means the Solana network rejected an on-chain transaction '
      + 'during pool creation. Common causes: the token uses Token-2022 extensions that '
      + 'Raydium CLMM pools don\'t support; the ephemeral wallet ran out of SOL for fees; '
      + 'or the transaction hit a compute budget limit. Your assets remain safe in the '
      + 'ephemeral wallet and can be recovered via Cancel & Refund or Resume Launch.',
  },
  validation: {
    label: 'Validation',
    cssClass: 'cat-validation',
    patterns: [
      /invalid.*(address|mint|token)/i, /(address|mint).*invalid/i,
      /not.*valid/i, /must be/i, /required/i, /missing/i,
      /unsupported.*(token|extension|program)/i,
      /can\'t.*(be|use|create)/i, /cannot/i,
      /token.*not found/i, /mint.*not found/i,
      /no.*pool/i, /empty/i, /undefined/i,
    ],
    suggestion: 'Check your token details — the mint address, decimals, or symbol '
      + 'may be incorrect. If you\'re using a pump.fun or other Token-2022 token, '
      + 'those aren\'t directly supported for CLMM pools. Consider wrapping or '
      + 'using a standard SPL Token instead.',
    explainer: 'This error means something in your launch configuration doesn\'t '
      + 'meet the requirements. It could be an invalid token address, unsupported '
      + 'token format, or a missing required field. No on-chain actions have been '
      + 'performed — you can fix the config and try again without losing any SOL.',
  },
  network: {
    label: 'Network',
    cssClass: 'cat-network',
    patterns: [
      /fetch.*fail/i, /network.*error/i, /timeout/i, /abort/i,
      /ENOTFOUND/i, /EAI_AGAIN/i, /ECONNRESET/i, /ETIMEDOUT/i,
      /Couldn\'t.*reach/i, /Couldn\'t.*connect/i, /unreachable/i,
      /HTTP.*\d{3}/i, /response.*error/i, /server.*error/i,
      /5\d\d/i, /internal.*server/i,
    ],
    suggestion: 'Check your internet connection and try again. If this persists, '
      + 'the Trebuchet server or a third-party service (Jupiter, Raydium API) '
      + 'may be temporarily down. Wait a minute and retry — on-chain state '
      + 'from partial progress is preserved.',
    explainer: 'A network request failed — either to your RPC endpoint, to the '
      + 'Trebuchet server itself, or to an external service called during the '
      + 'launch. Transient network issues are common on Solana mainnet. Your '
      + 'on-chain state (created tokens, partially-created pools) is not affected '
      + 'by network errors between requests.',
  },
};

function categorizeError(message) {
  if (!message || typeof message !== 'string') return 'unknown';
  // Check categories in priority order: rpc > onchain > network > validation
  // RPC errors should be caught first because many on-chain errors are
  // actually downstream of RPC failures.
  const order = ['rpc', 'onchain', 'network', 'validation'];
  for (const cat of order) {
    for (const pat of ERROR_CATEGORIES[cat].patterns) {
      if (pat.test(message)) return cat;
    }
  }
  return 'unknown';
}

function getErrorCategoryInfo(category) {
  return ERROR_CATEGORIES[category] || null;
}

// Render a structured error block into a container element. Adds a category
// badge, the error message, a "What happened?" expandable section, and a
// recovery suggestion. Leaves existing content below the injected block
// intact (e.g. the Resume Launch / Skip buttons in lpFailInfo).
function renderStructuredError(container, message, category) {
  if (!container || !message) return;
  const cat = category || categorizeError(message);
  const info = getErrorCategoryInfo(cat);

  // Build the structured error block
  let html = '<div class="error-banner">';
  if (info && info.label) {
    html += `<span class="error-banner-category ${info.cssClass}">${info.label}</span>`;
  }
  html += `<span class="has-text-weight-semibold">${escapeHtml(String(message))}</span>`;

  if (info) {
    html += '<details class="error-what-happened">';
    html += '<summary>What happened?</summary>';
    html += `<div class="what-happened-body"><p>${escapeHtml(info.explainer)}</p></div>`;
    html += '</details>';
    html += `<div class="error-recovery-suggestion">${escapeHtml(info.suggestion)}</div>`;
  }

  html += '</div>';
  container.insertAdjacentHTML('afterbegin', html);
}


// ===========================================================================
// Server log streaming
// ===========================================================================
//
// The packaged Electron app hides server.js's console output — only the
// browser DevTools console and this activity log are visible to the user.
// To make backend activity visible (especially during the auto-swap flow),
// we continuously poll /api/server-logs and dump new entries here with a
// [server] prefix.
//
// State:
//   _lastSeenServerLogSeq — highest server log sequence number we've
//     already shown. Sent as `since` on each poll so the server only
//     returns new entries.
//   _serverLogStreamStarted — guard so the streamer is only started once.
//
// The streamer runs forever (no abort path) — it just keeps polling until
// the page is closed. Each poll is one cheap HTTP round-trip every 2s,
// and returns nothing when the server is idle, so it's not chatty.

let _lastSeenServerLogSeq = 0;
let _serverLogStreamStarted = false;

/**
 * Append a single server log entry to the activity log. Uses a [server]
 * prefix and dimmer styling (info -> grey color, warn -> warning, error
 * -> danger) so server logs are visually distinguishable from frontend
 * action logs.
 */
function appendServerLogEntry(entry) {
  // Map server log levels to the activity log's CSS types.
  let type;
  if (entry.level === 'error') type = 'danger';
  else if (entry.level === 'warn') type = 'warning';
  else type = 'info';
  // Use the entry's original server-side timestamp (not new Date()) so
  // entries that arrive in a single poll preserve their actual ordering
  // relative to one another, and the user can tell when a server event
  // really happened. Format as HH:MM:SS to match the rest of the log.
  const ts = new Date(entry.ts).toLocaleTimeString('en-US', { hour12: false });
  const el = document.createElement('div');
  el.className = `log-entry ${type} server-log`;
  // escapeHtml is defined later in this file; use a small inline escape
  // just in case the function isn't hoisted in some weird load order.
  const safe = String(entry.msg)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  el.innerHTML =
    `<span class="timestamp">[${ts}]</span>` +
    `<span><span class="has-text-grey">[server]</span> ${safe}</span>`;
  activityLog.appendChild(el);
  trimActivityLog();
  activityLog.scrollTop = activityLog.scrollHeight;
}

/**
 * Start a continuous polling loop that fetches new server logs every 2s
 * and appends them to the activity log. Idempotent — calling more than
 * once is a no-op.
 */
async function startServerLogStream() {
  if (_serverLogStreamStarted) return;
  _serverLogStreamStarted = true;

  // Initial seed: fetch the last 30 entries so the user sees recent
  // backend history immediately (boot logs, any prior activity). Capped
  // at 30 so we don't drown the activity log on first load if the
  // server has been running a while.
  try {
    const resp = await fetch('/api/server-logs?limit=30');
    if (resp.ok) {
      const data = await resp.json();
      for (const entry of data.entries || []) {
        appendServerLogEntry(entry);
        if (entry.seq > _lastSeenServerLogSeq) _lastSeenServerLogSeq = entry.seq;
      }
    }
  } catch (_) {
    // Network error on initial seed — just continue to the polling loop,
    // it'll catch up on next poll.
  }

  // Continuous poll. Every 2s, fetch entries with seq > our last seen.
  // No error escalation: a single failed poll is silent, and we just
  // try again on the next interval. The page-unload kills this loop.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const resp = await fetch(`/api/server-logs?since=${_lastSeenServerLogSeq}`);
      if (resp.ok) {
        const data = await resp.json();
        for (const entry of data.entries || []) {
          appendServerLogEntry(entry);
          if (entry.seq > _lastSeenServerLogSeq) _lastSeenServerLogSeq = entry.seq;
        }
      }
    } catch (_) {
      // Ignore — try again on next poll.
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

// Kick off the streamer at module load. It runs for the lifetime of
// the page, polling every 2s. No-op when the server has nothing new
// to report.
startServerLogStream();

function setLoading(btn, loading) {
  if (!btn) return;
  if (loading) {
    btn.classList.add('is-loading');
    btn.disabled = true;
  } else {
    btn.classList.remove('is-loading');
    btn.disabled = false;
  }
}

// Wrap an async operation in run-state handling. While `isRunningOperation`
// is true, the cancel button is disabled — don't sweep mid-transaction.
// Depth counter for the data-treb-busy DOM signal below. withRunState
// can nest (a balance poll can overlap a user action); the flag must
// only clear when the LAST operation finishes.
let _runStateDepth = 0;

async function withRunState(fn) {
  isRunningOperation = true;
  updateCancelButtonState();
  // Automation/readiness signal: <body data-treb-busy="1"> while any
  // wrapped operation is in flight. The screenshot harness (and any
  // future e2e tooling) waits on this instead of guessing from side
  // effects — e.g. "Continue to Funding" runs a full estimate
  // round-trip against live price APIs BEFORE the step advances, and
  // without a signal the only observable is a button that was clicked
  // and a step that hasn't changed yet.
  _runStateDepth += 1;
  document.body.dataset.trebBusy = '1';
  try {
    return await fn();
  } finally {
    isRunningOperation = false;
    updateCancelButtonState();
    _runStateDepth = Math.max(0, _runStateDepth - 1);
    if (_runStateDepth === 0) {
      delete document.body.dataset.trebBusy;
    }
  }
}



// RPC health polling state (used by rpc-panel.js)
let _rpcHealthPollTimer = null;
let _rpcHealthLastResult = null;
let _rpcHealthLaunchActive = false;
const RPC_HEALTH_INTERVAL_MS = 30000;
const RPC_HEALTH_SLOW_THRESHOLD_MS = 400;


// ===========================================================================
// HTML confirm dialog
// ===========================================================================
//
// Drop-in replacement for window.confirm(). Returns a Promise<boolean>:
// resolves to true on OK, false on Cancel or Esc or background click.
//
// Why we have this: window.confirm() on Windows triggers a Chromium
// compositor hit-testing bug — after the dialog dismisses, text inputs
// in the app become un-clickable (single-clicks don't focus, double-
// clicks can still select) until the user switches windows away and
// back. HTML modals don't trigger the bug because they never leave
// Chromium's compositor — they're just DOM elements styled as a modal.
//
// The dialog uses Bulma's .modal classes the same way the existing
// cancelConfirmModal does. opts:
//   title         — header text (default: "Confirm")
//   body          — body content; can include <strong>, <p>, etc.
//   confirmLabel  — text on the OK button (default: "OK")
//   danger        — if true, OK button is styled red as is-danger
//                   instead of is-primary blue
//   hideCancel    — if true, the Cancel button is hidden so the
//                   modal acts as an info-only dialog with a single
//                   OK action. ESC / background click still resolve
//                   to false (treat as "dismiss"); for an info dialog
//                   callers usually ignore the return value.
async function confirmDialog(opts = {}) {
  const {
    title = 'Confirm',
    body = '',
    confirmLabel = 'OK',
    danger = false,
    hideCancel = false,
  } = opts;

  const modal     = document.getElementById('genericConfirmModal');
  const titleEl   = document.getElementById('genericConfirmTitle');
  const bodyEl    = document.getElementById('genericConfirmBody');
  const okBtn     = document.getElementById('genericConfirmOk');
  const cancelBtn = document.getElementById('genericConfirmCancel');
  const bgEl      = modal.querySelector('.modal-background');

  titleEl.textContent = title;
  // Use innerHTML so callers can pass <p>, <strong>, etc. Callers
  // are responsible for escaping any user-supplied data they
  // include — same trust model as the rest of the codebase.
  bodyEl.innerHTML = body;
  okBtn.textContent = confirmLabel;
  okBtn.classList.remove('is-primary', 'is-danger');
  okBtn.classList.add(danger ? 'is-danger' : 'is-primary');

  // Toggle Cancel visibility. Setting style.display directly (rather
  // than via a class) keeps this self-contained — we don't need to
  // remember to reset a class on every other code path.
  cancelBtn.style.display = hideCancel ? 'none' : '';

  modal.classList.add('is-active');
  okBtn.focus();

  return new Promise((resolve) => {
    const cleanup = (result) => {
      modal.classList.remove('is-active');
      // Restore the cancel button's display so the next caller starts
      // from a known state. Without this, a subsequent confirmDialog
      // without hideCancel would inherit the hidden cancel button.
      cancelBtn.style.display = '';
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      bgEl.removeEventListener('click', onCancel);
      document.removeEventListener('keydown', onKey);
      resolve(result);
    };
    const onOk     = () => cleanup(true);
    const onCancel = () => cleanup(false);
    const onKey    = (e) => {
      if (e.key === 'Escape') onCancel();
      else if (e.key === 'Enter') onOk();
    };

    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    bgEl.addEventListener('click', onCancel);
    document.addEventListener('keydown', onKey);
  });
}

// ===========================================================================
// Update-check result handler
// ===========================================================================
//
// Called from the main process (main.js → checkForUpdates) via
// webContents.executeJavaScript when the user picks Help → Check for
// Updates and the GitHub API call finishes. Lives on `window` so it's
// reachable from outside this module's scope — that's how main can
// invoke it without an IPC channel.
//
// The `info` object always has a `status` field. Other fields depend
// on the status:
//   status: 'current'   — { current }
//   status: 'available' — { current, latest, downloadUrl,
//                           downloadFilename, releaseUrl, notes }
//   status: 'no-asset'  — { current, latest, releaseUrl }
//   status: 'error'     — { message, releasesUrl }
//
// "Download" buttons use window.open(), which Electron's
// setWindowOpenHandler intercepts and routes to the system's default
// browser via shell.openExternal. So clicking Download starts the
// download in Chrome/Firefox/Safari/etc., not inside the Electron
// renderer.

window.__showUpdateResult = async function (info) {
  // Defensive: if main pushes a result before app.js finishes parsing
  // (extremely unlikely — the menu can't even be clicked before the
  // window has shown — but the cost of a guard is zero), bail rather
  // than throwing.
  if (typeof confirmDialog !== 'function') return;
  if (!info || typeof info !== 'object') return;

  // The "Don't check automatically" toggle. We include it on every
  // result modal so the user can change their mind from any path:
  //   - "Update available"  → opt out before downloading
  //   - "You're up to date" → review/change the setting after a
  //                            manual check
  //   - "Update check failed" → ditto
  //   - "No asset for OS"    → ditto
  //
  // info.checkOnStartup is the current persisted value (passed in by
  // main.js — it loaded the pref before sending the result). We render
  // the checkbox so that:
  //   - checked  = auto-check is OFF (user has opted out)
  //   - unchecked = auto-check is ON (the default)
  // i.e. checkbox semantics match its label: "Don't check automatically".
  //
  // The checkbox uses a stable id so we can wire up its onChange after
  // confirmDialog injects the body HTML. Bound below via setTimeout(0)
  // to guarantee the element exists in the DOM before we attach.
  const dontCheckCheckedNow = info.checkOnStartup === false;
  const checkboxHtml =
    `<div style="margin-top: 0.75rem; padding-top: 0.6rem; border-top: 1px solid rgba(0,0,0,0.08);">` +
      `<label class="checkbox is-size-7" style="display: flex; align-items: center; gap: 0.4rem; user-select: none;">` +
        `<input type="checkbox" id="updatePrefCheckbox"${dontCheckCheckedNow ? ' checked' : ''}>` +
        `<span>Don't check for updates automatically</span>` +
      `</label>` +
    `</div>`;

  // Schedule the checkbox wire-up. Runs on the next tick, by which
  // time confirmDialog has set bodyEl.innerHTML and the new checkbox
  // is in the DOM. Posting to /api/user-prefs fire-and-forget — if it
  // fails (e.g. server transiently slow), the checkbox toggle visually
  // succeeded but the pref didn't persist; the user can toggle again
  // next time. That's preferable to blocking the modal on a server
  // round-trip.
  setTimeout(() => {
    const cb = document.getElementById('updatePrefCheckbox');
    if (!cb) return;
    cb.addEventListener('change', () => {
      // Checkbox checked = don't auto-check = pref is false.
      const newValue = !cb.checked;
      fetch('/api/user-prefs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ checkForUpdatesOnStartup: newValue }),
      }).catch((err) => {
        console.warn('Failed to persist update-check preference:', err);
      });
    });
  }, 0);

  if (info.status === 'current') {
    await confirmDialog({
      title: "You're up to date",
      body:
        `<p>You're running the latest version (<strong>v${escapeHtml(info.current)}</strong>).</p>` +
        checkboxHtml,
      confirmLabel: 'OK',
      hideCancel: true,
    });
    return;
  }

  if (info.status === 'error') {
    // The check failed — typically a network blip, GitHub rate limit,
    // or the user is offline. Give them a path forward (link to the
    // releases page) so they can check manually if they want to.
    const releasesUrl = info.releasesUrl || 'https://github.com/AnOversizedMooseWithSocks/trebuchet/releases';
    await confirmDialog({
      title: 'Update check failed',
      body:
        `<p>${escapeHtml(info.message || 'Unknown error.')}</p>` +
        `<p class="is-size-7" style="color: var(--ink-soft); margin-top: 0.75rem;">` +
        `You can check manually at <a href="${escapeHtml(releasesUrl)}" target="_blank" rel="noopener">the releases page</a>.</p>` +
        checkboxHtml,
      confirmLabel: 'OK',
      hideCancel: true,
    });
    return;
  }

  if (info.status === 'no-asset') {
    // An update exists but main couldn't find a binary for this OS in
    // the release. Send the user to the release page where they can
    // pick something themselves.
    const wantOpen = await confirmDialog({
      title: 'Update available',
      body:
        `<p>Version <strong>v${escapeHtml(info.latest)}</strong> is available ` +
        `(you have v${escapeHtml(info.current)}).</p>` +
        `<p>I couldn't find a download for your operating system in this ` +
        `release. Open the release page to choose one?</p>` +
        checkboxHtml,
      confirmLabel: 'Open release page',
    });
    if (wantOpen) window.open(info.releaseUrl, '_blank');
    return;
  }

  if (info.status === 'available') {
    // Truncate release notes so the modal stays a reasonable size.
    // For long changelogs we keep the first ~600 chars and link out
    // to the full release page.
    const rawNotes = (info.notes || '').trim();
    let notesForDisplay = rawNotes;
    let truncated = false;
    if (notesForDisplay.length > 600) {
      // Trim at the last whitespace before the limit so we don't cut
      // a word in half.
      notesForDisplay = notesForDisplay.slice(0, 600).replace(/\s+\S*$/, '');
      truncated = true;
    }
    const notesHtml = notesForDisplay
      ? renderReleaseNotes(notesForDisplay)
      : '<p style="color: var(--ink-soft); font-style: italic; margin: 0;">No release notes provided.</p>';

    const wantDownload = await confirmDialog({
      title: 'Update available',
      body:
        `<p>Version <strong>v${escapeHtml(info.latest)}</strong> is available ` +
        `(you have v${escapeHtml(info.current)}).</p>` +
        `<div style="margin: 0.75rem 0; padding: 0.75rem; background: rgba(0,0,0,0.04); border-radius: 4px;">` +
          notesHtml +
          (truncated
            ? `<p style="margin-top: 0.5rem; margin-bottom: 0;"><a href="${escapeHtml(info.releaseUrl)}" target="_blank" rel="noopener">See full release notes →</a></p>`
            : '') +
        `</div>` +
        `<p class="is-size-7" style="color: var(--ink-soft);">` +
        `Clicking Download will open <code>${escapeHtml(info.downloadFilename)}</code> ` +
        `in your default browser.</p>` +
        checkboxHtml,
      confirmLabel: 'Download',
    });
    if (wantDownload) window.open(info.downloadUrl, '_blank');
    return;
  }

  // Unrecognised status — shouldn't happen, but don't silently swallow.
  // Show a generic failure rather than throwing.
  await confirmDialog({
    title: 'Update check failed',
    body:
      `<p>Unexpected response from the update check.</p>` +
      checkboxHtml,
    confirmLabel: 'OK',
    hideCancel: true,
  });
};

// Tiny release-notes renderer for the update modal. Handles just the
// patterns we actually use in our release bodies:
//   - lines starting with "- " or "* " become <li> in a <ul>
//   - blank lines separate paragraphs
//   - everything else is wrapped in <p>
// Anything richer (links, bold, headings) is left as plain escaped
// text. Keeping this dumb is deliberate — release notes are author-
// controlled but pulled from a network response, so the smaller the
// rendering surface area, the smaller the attack surface.
function renderReleaseNotes(text) {
  const lines = String(text).split(/\r?\n/);
  const out = [];
  let inList = false;
  for (const raw of lines) {
    const line = raw.trim();
    const bullet = /^[-*]\s+(.*)/.exec(line);
    if (bullet) {
      if (!inList) {
        out.push('<ul style="margin: 0; padding-left: 1.2rem;">');
        inList = true;
      }
      out.push(`<li>${escapeHtml(bullet[1])}</li>`);
    } else if (line === '') {
      if (inList) { out.push('</ul>'); inList = false; }
    } else {
      if (inList) { out.push('</ul>'); inList = false; }
      out.push(`<p style="margin: 0 0 0.4rem;">${escapeHtml(line)}</p>`);
    }
  }
  if (inList) out.push('</ul>');
  return out.join('');
}

// ===========================================================================
// Step state machine
// ===========================================================================
//
// A step's state is reflected by a CSS class on its card (.is-pending,
// .is-active, .is-completed). The is-active card has its body visible;
// the others have it hidden via CSS. setStepState() handles all the
// class manipulation plus the sticky-bar update.

function setStepState(num, state, summaryText) {
  const card = document.getElementById(`step${num}-card`);
  if (!card) return;
  card.classList.remove('is-pending', 'is-active', 'is-completed');
  card.classList.add(`is-${state}`);
  // is-peeking is a sub-state of is-active managed only by the peek-mode
  // logic in bindStepHeaders. Any other caller of setStepState is making
  // a workflow-level state change (activateStep moving the user forward,
  // a cancel flow finalising on step 6, resetForNewLaunch handing control
  // back to step 2, etc.) and those callers should not inherit a stale
  // peek class from whatever the previous interaction left behind.
  //
  // Without this clear, the class survives every code path except the
  // bindStepHeaders collapse logic — so e.g. peek step 2 from step 3,
  // hit Cancel & Refund, then Start Over: activateStep(2) makes step 2
  // the active step but is-peeking is still set, and the CSS
  // pointer-events:none rule on .step-card.is-peeking input/button/etc.
  // locks every field. The user can't edit pool config, can't click
  // Continue to Funding, and the step header click bails out early
  // because step 2 is also the current step. No way out except a full
  // reload.
  //
  // The peek-open branch in bindStepHeaders adds is-peeking AFTER calling
  // setStepState, so it still ends up with the right combination
  // (is-active + is-peeking). The two explicit remove calls in the
  // collapse branches become redundant but are kept for clarity.
  card.classList.remove('is-peeking');
  // Also tear down the peek banner DOM element if one was injected.
  // Same rationale as the class clear above — any state change means
  // the banner doesn't belong to this card anymore. injectPeekBanner
  // adds it back when peek starts again.
  card.querySelectorAll('.peek-banner').forEach((el) => el.remove());

  const summaryEl = document.getElementById(`step${num}-summary`);
  if (summaryEl && summaryText !== undefined) {
    summaryEl.textContent = summaryText ? `  —  ${summaryText}` : '';
  }
}

// Build and insert the peek banner at the top of a step body. Called
// when entering peek mode. The banner explains the read-only state
// and — more importantly — contains an explicit "Done reviewing" button
// so the user has a discoverable way back out. Without it, the only
// way to exit peek was to click the same step header again, which is
// not obviously interactive once the body is already expanded.
//
// The banner element is plain DOM (not a CSS ::before pseudo) so it
// can contain a real clickable button. setStepState removes the banner
// alongside clearing the is-peeking class, so any state transition
// cleans it up automatically — no separate teardown required from the
// callers in bindStepHeaders.
function injectPeekBanner(card, stepNum) {
  const body = card.querySelector('.step-body');
  if (!body) return;
  // Defensive: drop any existing banner before adding a new one so we
  // can't accidentally end up with duplicates if this is somehow
  // called twice without an intervening teardown.
  body.querySelectorAll('.peek-banner').forEach((el) => el.remove());

  const banner = document.createElement('div');
  banner.className = 'peek-banner';

  const text = document.createElement('span');
  text.className = 'peek-banner-text';
  text.textContent = 'Reviewing completed step — fields are read-only.';
  banner.appendChild(text);

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'peek-banner-close';
  closeBtn.textContent = 'Done reviewing';
  // Collapse the peek. setStepState handles all the cleanup —
  // removes is-peeking, removes this banner element, sets the
  // is-completed class — so we don't need to do anything else here.
  closeBtn.addEventListener('click', () => {
    setStepState(stepNum, 'completed');
    // Closing a peek of step 2: the card was moved into the config slot for
    // the peek, so move it back to wherever the active step keeps it. The
    // coin now travels through steps 2–6, so we relocate rather than tear it
    // down.
    if (stepNum === 2 && currentStep !== 2) {
      relocateTokenPreview(slotKeyForStep(currentStep));
      if (typeof renderTokenPreview === 'function') renderTokenPreview();
    }
  });
  banner.appendChild(closeBtn);

  // Insert at the very top of the body so it's the first thing the
  // user sees inside the expanded step.
  body.insertBefore(banner, body.firstChild);
}

// Activate a specific step. Marks all earlier steps as completed (preserving
// any summary set on them), the target step as active, and any later steps
// as pending. Scrolls the active step into view.
function activateStep(num) {
  currentStep = num;
  for (let i = 1; i <= 6; i++) {
    const card = document.getElementById(`step${i}-card`);
    if (!card) continue;
    if (i < num) {
      // Only set to completed if not already (preserves the summary)
      if (!card.classList.contains('is-completed')) {
        setStepState(i, 'completed');
      }
    } else if (i === num) {
      setStepState(i, 'active');
    } else {
      setStepState(i, 'pending');
    }
  }

  // Update sticky bar
  document.getElementById('stickyStepNum').textContent = String(num);
  // #8: total step count, derived from STEP_TITLES so the "/ N" stays
  // correct on its own if the flow ever gains or loses a step.
  const stepTotalEl = document.getElementById('stickyStepTotal');
  if (stepTotalEl) stepTotalEl.textContent = String(Object.keys(STEP_TITLES).length);
  document.getElementById('stickyStepTitle').textContent = STEP_TITLES[num];
  document.getElementById('stickyBar').classList.add('is-visible');

  // Demo mode folds its badge + Disable into the sticky bar (rather than a
  // second fixed banner that would cover it). Now that the bar is visible,
  // sync that chrome. Guarded for load-order safety.
  if (typeof syncDemoChrome === 'function') syncDemoChrome();

  // #9: the cost echo belongs only on step 2 (the config stage). The cost
  // preview already hides itself off step 2, but clear the echo explicitly
  // here too so it can never linger if a step change races the preview's
  // own update.
  if (num !== 2) {
    const stickyCost = document.getElementById('stickyCost');
    if (stickyCost) stickyCost.classList.add('hidden');
  }

  // Scroll the active card into view (with a small delay to let CSS settle)
  setTimeout(() => {
    document.getElementById(`step${num}-card`)?.scrollIntoView({
      behavior: 'smooth',
      block: 'start',
    });
  }, 50);

  // Sync the cost preview with the new step. Transitioning INTO step 2
  // schedules a fresh preview compute (after the 500ms debounce);
  // transitioning OUT of it hides the preview since the user is past
  // the config stage. requestCostPreviewUpdate handles both directions
  // based on the now-updated currentStep value, so a single call here
  // covers transitions in either direction.
  if (typeof requestCostPreviewUpdate === 'function') {
    requestCostPreviewUpdate();
  }

  // When entering step 6, surface the pre-transfer airdrop summary so
  // the user sees what's about to happen before clicking Transfer
  // Assets. No-op when no airdrop is configured. typeof guards the
  // hoisting order — renderAirdropPreTransferSummary is defined further
  // down in this file.
  if (num === 6 && typeof renderAirdropPreTransferSummary === 'function') {
    renderAirdropPreTransferSummary();
  }

  // The token preview block (with its 3D coin) is a singleton DOM element
  // that travels with the active step. It lives in the config slot on step 2,
  // moves beside the QR on step 3, and now follows through steps 4–6 into
  // their per-step slots so the coin and the launch-progress bar stay visible
  // for the whole flow. The WebGL context survives each relocation because
  // we move the same DOM node — appendChild() doesn't destroy its canvas.
  //
  // Only step 1 (the wallet-generation stage, before a token is configured)
  // and a reset tear the coin down to free its WebGL context.
  if (num >= 2 && num <= 6) {
    relocateTokenPreview(slotKeyForStep(num));
    // Re-render so the card reflects the current config and its stat tiles
    // re-layout in the new slot. updateCoinPreview() (called from within)
    // reattaches the live canvas rather than spinning up a second context.
    if (typeof renderTokenPreview === 'function') renderTokenPreview();
  } else {
    relocateTokenPreview('config');
    if (typeof destroyCoinPreview === 'function') destroyCoinPreview();
  }

  // Refresh the overall launch-progress bar for the new step position.
  if (typeof updateLaunchProgress === 'function') updateLaunchProgress();
}

// Move the singleton #tokenPreviewBlock between its config-stage slot
// and its funding-stage slot. The card uses its full size in both
// locations — the funding stage's column layout gives it room to
// render alongside the QR code without needing a compact variant.
//
// where: 'config' | 'funding'
//
// Safe to call when the block isn't currently in either slot (e.g.
// during early init) — querySelector returns null and the function
// bails. Idempotent: calling with the same destination twice is a
// no-op (appendChild a node already in the target is harmless).
// Slot-id map for the singleton preview card. Steps 4–6 each have their own
// slot so the card (and its 3D coin) travels with the active step.
const TOKEN_PREVIEW_SLOTS = {
  config:  'tokenPreviewSlotConfig',
  funding: 'tokenPreviewSlotFunding',
  step4:   'tokenPreviewSlotStep4',
  step5:   'tokenPreviewSlotStep5',
  step6:   'tokenPreviewSlotStep6',
};

// Which slot the preview card belongs in for a given step: step 2 → config,
// step 3 → funding (beside the QR), steps 4–6 → their own per-step slot.
// Anything outside 2–6 has no card and defaults to config.
function slotKeyForStep(num) {
  if (num === 2) return 'config';
  if (num === 3) return 'funding';
  if (num >= 4 && num <= 6) return 'step' + num;
  return 'config';
}

function relocateTokenPreview(where) {
  const block = document.getElementById('tokenPreviewBlock');
  if (!block) return;
  const slotId = TOKEN_PREVIEW_SLOTS[where] || TOKEN_PREVIEW_SLOTS.config;
  const slot = document.getElementById(slotId);
  if (!slot) return;
  // appendChild moves the same DOM node (and the live coin canvas inside it)
  // without destroying it — the WebGL context survives the relocation.
  slot.appendChild(block);
}

// ---------------------------------------------------------------------------
// Overall launch progress
// ---------------------------------------------------------------------------
// The preview card carries a progress bar that fills as the launch advances
// through its six steps and reaches 100% when the final transfer completes.
// We base the in-flight percentage on currentStep (stable across "peeking" a
// completed step, which momentarily toggles the is-completed classes) rather
// than counting completed-step classes. The transfer-complete flag forces the
// bar to 100% on the final sweep, since step 6 isn't marked is-completed.
let _launchTransferComplete = false;

function updateLaunchProgress() {
  const fill = document.getElementById('tokenPreviewProgressFill');
  const label = document.getElementById('tokenPreviewProgressLabel');
  if (!fill || !label) return;
  let pct;
  if (_launchTransferComplete) {
    pct = 100;
  } else {
    const step = (typeof currentStep === 'number') ? currentStep : 1;
    // Steps before the active one are done; six steps total.
    pct = Math.max(0, Math.min(100, Math.round(((step - 1) / 6) * 100)));
  }
  fill.style.width = pct + '%';
  fill.classList.toggle('is-complete', pct >= 100);
  label.textContent = pct >= 100 ? 'Launch complete' : `Launch progress · ${pct}%`;
}

// Set a step's completion summary (one-line text shown next to the title
// when collapsed). Optional; helps the user see at a glance what was done.
function setStepSummary(num, text) {
  const summaryEl = document.getElementById(`step${num}-summary`);
  if (summaryEl) summaryEl.textContent = text ? `  —  ${text}` : '';
}

// Click on a completed step's header — re-expand it for review, or
// collapse if currently peeked. Pending and active-current steps are
// non-interactive via this handler (the early return below handles them).
function bindStepHeaders() {
  for (let i = 1; i <= 6; i++) {
    const header = document.querySelector(`#step${i}-card .step-header`);
    if (!header) continue;
    header.addEventListener('click', () => {
      const card = document.getElementById(`step${i}-card`);
      const isCurrentStep = i === currentStep;
      const isCompleted = card.classList.contains('is-completed');
      // A peeked step is one that has been temporarily expanded for
      // review via this handler. We detect this as "is-active but not
      // the actual current step" — setStepState() removes is-completed
      // when applying is-active, so we can't rely on is-completed alone
      // to identify peekable steps once they've been peeked once.
      const isPeeking = card.classList.contains('is-active') && !isCurrentStep;

      // Pending or active-current steps don't respond to header clicks —
      // they're navigated via the action buttons inside their body.
      if (!isCompleted && !isPeeking) return;

      if (isPeeking) {
        // Currently peeked → collapse back to completed.
        setStepState(i, 'completed');
        card.classList.remove('is-peeking');
        // If we just closed a peek of step 2, the preview block is
        // currently in step 2's config slot (we moved it there when the
        // peek opened — see below). Move it back to the slot that matches
        // the actual current step (funding on step 3, the per-step slot on
        // steps 4–6). The coin travels with it; no teardown.
        if (i === 2 && currentStep !== 2) {
          relocateTokenPreview(slotKeyForStep(currentStep));
          if (typeof renderTokenPreview === 'function') renderTokenPreview();
        }
        return;
      }

      // is-completed and not currently peeked → open for peek. First
      // collapse any OTHER peeked step so only one peek is visible at
      // a time (avoids visual confusion with multiple expanded cards).
      for (let j = 1; j <= 6; j++) {
        if (j === i) continue;
        if (j === currentStep) continue; // never collapse the active step
        const otherCard = document.getElementById(`step${j}-card`);
        if (otherCard && otherCard.classList.contains('is-active')) {
          setStepState(j, 'completed');
          otherCard.classList.remove('is-peeking');
        }
      }
      // Open this completed step for peek. Marker class `is-peeking`
      // additionally lets CSS disable form fields inside (see
      // peek-readonly fix below) so the user doesn't silently
      // invalidate downstream state by editing a completed step.
      setStepState(i, 'active');
      card.classList.add('is-peeking');
      // Inject the read-only banner with the Done button. Has to run
      // after setStepState because setStepState tears down any prior
      // banner as part of its general state-change cleanup.
      injectPeekBanner(card, i);
      // The token preview block is a singleton. While the user is on
      // step 3 it sits next to the QR in the funding slot. Peeking
      // step 2 needs to show the preview INSIDE step 2 again, so move
      // it back to the config slot for the duration of the peek. The
      // peek-close handler above moves it back to wherever it should
      // live afterwards.
      if (i === 2) {
        relocateTokenPreview('config');
        if (typeof renderTokenPreview === 'function') renderTokenPreview();
      }
    });
  }
}

// ===========================================================================
// Cancel & refund
// ===========================================================================

function updateCancelButtonState() {
  const btn = document.getElementById('cancelBtn');
  if (!btn) return;
  // Disabled while an operation is in flight, or before wallet is generated,
  // or after the user is on step 6 (use the regular transfer button there)
  const shouldDisable = isRunningOperation || !tempWallet || currentStep === 6;
  btn.disabled = shouldDisable;
  btn.title = isRunningOperation
    ? 'Wait for the current operation to finish before cancelling'
    : (currentStep === 6 ? 'Use the Transfer Assets button at this stage' : 'Cancel and refund leftover funds');
}

// Tracks which mode the cancel modal is currently in. Set by
// openCancelConfirm() based on the on-chain wallet balance; consumed
// by the proceed-button handler so it knows whether to do a sweep or
// just close the launch UI.
//   'end_launch' — wallet is empty (no SOL, nothing to sweep). The
//                  proceed action just locks the UI and logs, no
//                  /api/transfer-assets call. The pending-wallets
//                  recovery cache entry stays alive in case a delayed
//                  deposit arrives later (user can claim via the
//                  recovery panel).
//   'refund'     — wallet has funds. Existing refund flow: require
//                  destination address, call transfer-assets, sweep.
let cancelMode = 'refund';

async function openCancelConfirm() {
  if (isRunningOperation) {
    log('Wait for the current operation to finish before cancelling', 'warning');
    return;
  }

  const titleEl = document.getElementById('cancelConfirmTitle');
  const intro = document.getElementById('cancelConfirmIntro');
  const destSection = document.getElementById('cancelDestSection');
  const destInput = document.getElementById('cancelDestInput');
  const destHelp = document.getElementById('cancelDestHelp');
  const finePrint = document.getElementById('cancelConfirmFinePrint');
  const proceedBtn = document.getElementById('cancelConfirmProceedBtn');
  const proceedLabel = document.getElementById('cancelConfirmProceedLabel');

  // Fetch the wallet's current SOL balance so we can decide whether
  // there's anything to refund. If the wallet has nothing, the whole
  // refund-destination flow is unnecessary and the user just wants to
  // end the launch and clean up the UI.
  //
  // Use the cached value from pollBalances if we have one; otherwise
  // hit the balance endpoint directly. Falls back to assuming "funded"
  // on RPC error — safer to show the refund flow than to silently let
  // the user end-launch a wallet that might actually have funds.
  let solBalance = 0;
  let balanceCheckFailed = false;
  if (tempWallet) {
    try {
      const resp = await fetch('/api/check-balance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ publicKey: tempWallet.publicKey }),
      });
      const data = await resp.json();
      if (data.success) {
        solBalance = Number(data.balance) || 0;
      } else {
        balanceCheckFailed = true;
      }
    } catch (e) {
      balanceCheckFailed = true;
    }
  }

  // Dust threshold: 0.0001 SOL. Below this is too little to cover even
  // a single transfer's fee (~5000 lamports), so there's effectively
  // nothing to sweep anyway. Treat as empty.
  const DUST_SOL = 0.0001;
  const isEmpty = !balanceCheckFailed && solBalance < DUST_SOL;

  if (isEmpty) {
    // ---------- End-launch mode ----------
    cancelMode = 'end_launch';
    titleEl.textContent = 'End launch?';
    let stepMsg;
    if (currentStep <= 3) {
      stepMsg =
        'The ephemeral wallet hasn\'t been funded yet. Nothing has been ' +
        'spent and there\'s nothing to refund — cancelling just ends the ' +
        'launch flow and resets the UI.';
    } else {
      stepMsg =
        'The ephemeral wallet is empty. Nothing to sweep. Anything created ' +
        'on-chain so far (token, pools) stays on-chain. Cancelling just ends ' +
        'the launch flow.';
    }
    intro.textContent = stepMsg;
    destSection.classList.add('hidden');
    finePrint.innerHTML =
      '<p>The wallet\'s secret key stays in the recovery panel above so you ' +
      'can claim any delayed deposits that may arrive later. To remove it ' +
      'permanently, use Discard in that panel.</p>';
    proceedLabel.textContent = 'End Launch';
    proceedBtn.disabled = false;
  } else {
    // ---------- Refund mode (existing flow) ----------
    cancelMode = 'refund';
    titleEl.textContent = 'Cancel and Refund?';
    destSection.classList.remove('hidden');
    finePrint.innerHTML =
      '<p>This will sweep everything currently in the ephemeral wallet to ' +
      'that destination, then end the launch. Anything created on-chain so ' +
      'far (e.g., the SPL token if step 4 completed, or any pools created ' +
      'in step 5) stays on-chain — only the wallet\'s contents move.</p>';
    proceedLabel.textContent = 'Cancel and Refund';

    // Tailor the lead message to the current step so the user knows
    // what's at stake. (Now that we only reach this branch when the
    // wallet actually has funds, "you have funded" is no longer a lie
    // at step 3.)
    let message;
    if (currentStep <= 2) {
      message = 'You have SOL in the ephemeral wallet. Cancelling will sweep it back to you.';
    } else if (currentStep === 3) {
      message = 'You have funded the ephemeral wallet but no on-chain operations have run yet. Cancelling will refund the SOL.';
    } else if (currentStep === 4) {
      message = 'The token may have been created already. Cancelling will refund SOL and any leftover token supply, but the token itself stays on-chain (you cannot un-mint).';
    } else if (currentStep === 5) {
      message = 'The token exists. Some pools may have been created. Cancelling will sweep everything currently in the wallet (tokens, SOL, any Fee Key NFTs from completed pools), but already-created pools stay on-chain.';
    } else {
      message = 'This will sweep everything in the ephemeral wallet to your destination.';
    }
    if (balanceCheckFailed) {
      message =
        'Couldn\'t verify the wallet balance — RPC may be down. ' +
        'Defaulting to the refund flow. ' + message;
    }
    intro.textContent = message;

    // Pre-fill destination with the detected funding wallet if available
    if (fundingWallet) {
      destInput.value = fundingWallet;
      destHelp.textContent = 'Pre-filled with the detected funding wallet. Verify before proceeding.';
      proceedBtn.disabled = false;
    } else {
      destInput.value = '';
      destHelp.textContent = 'No funding wallet detected — paste your destination address.';
      proceedBtn.disabled = true;
    }
  }

  document.getElementById('cancelConfirmModal').classList.add('is-active');
}

bind('cancelDestInput', 'input', (e) => {
  // Only relevant in refund mode (in end-launch mode the input is
  // hidden and the proceed button is enabled unconditionally).
  if (cancelMode !== 'refund') return;
  const v = e.target.value.trim();
  const looksValid = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v);
  document.getElementById('cancelConfirmProceedBtn').disabled = !looksValid;
});

bind('cancelConfirmDismissBtn', 'click', () => {
  document.getElementById('cancelConfirmModal').classList.remove('is-active');
});

// Show the step-6 cancelled panel and decide whether to offer the
// "Start over with the same wallet" affordance. We only offer start-
// over when nothing was created on-chain — i.e., the cancel happened
// before step 4 (token creation). For step-4+ cancels, the token (and
// possibly pools) exist on-chain; starting over would silently create
// a SECOND set, leaving the first one stranded. Better UX is to
// require the user to consciously launch a new instance for that case.
//
// `cancelStep` is the step the user was on when they hit cancel (not
// the post-cancel step, which is always 6). `panelBodyText` is the
// "what happened" message — varies by cancel mode (empty vs refunded).
function showCancelledPanel(cancelStep, panelBodyText) {
  document.getElementById('step6NormalBody').classList.add('hidden');
  document.getElementById('step6CancelledPanel').classList.remove('hidden');

  const bodyEl = document.getElementById('step6CancelledPanelBody');
  if (bodyEl) bodyEl.textContent = panelBodyText;

  // Only safe to start over if no on-chain ops have run yet. Steps 1-3
  // are pre-mint; step 4+ creates the token / pools.
  const canStartOver = cancelStep <= 3;
  const startOverWrap = document.getElementById('step6StartOverWrap');
  const closeHint = document.getElementById('step6CancelledCloseHint');
  if (canStartOver) {
    startOverWrap.classList.remove('hidden');
    // Hide the "close and reopen" hint — that's the fallback advice
    // for when start-over isn't available.
    closeHint.classList.add('hidden');
  } else {
    startOverWrap.classList.add('hidden');
    closeHint.classList.remove('hidden');
  }
}

bind('cancelConfirmProceedBtn', 'click', async () => {
  // ---------- End-launch path ----------
  // Wallet is empty — nothing to sweep, nothing to refund. Just stop
  // polling, lock the UI at step 6, and log it. The wallet's secret
  // key stays in the pending-wallets recovery cache server-side so
  // a delayed deposit (one the user sent right before clicking
  // cancel, say) can still be claimed via that panel later.
  if (cancelMode === 'end_launch') {
    document.getElementById('cancelConfirmModal').classList.remove('is-active');

    if (balancePollHandle) {
      clearInterval(balancePollHandle);
      balancePollHandle = null;
    }

    log('Launch ended. The ephemeral wallet was empty — no sweep needed.', 'info');
    // Mark the user's CURRENT step (before activateStep flips it) as
    // cancelled so its summary reflects that context. activateStep(6)
    // below will mark every step 1..5 as completed/preserved and make
    // step 6 the active terminal step.
    setStepSummary(currentStep, 'cancelled — wallet was empty');

    // Swap Step 6's body: hide the normal transfer form (destination
    // wallet input + Transfer Assets button), show the cancellation
    // notice instead. Without this, the user sees a form prompting
    // them for a destination address even though there's nothing in
    // the wallet to transfer — confusing and dead-ends them because
    // we also hide the Transfer Assets button (no submit affordance).
    // showCancelledPanel also decides whether to offer "Start over"
    // based on whether on-chain ops have run.
    showCancelledPanel(
      currentStep,
      'The ephemeral wallet was empty, so there was nothing to refund. ' +
      'Nothing was spent on-chain, and no token or pools were created.',
    );

    // Mark Step 6's summary too, so the collapsed/peek view of the
    // terminal step also makes the cancellation context obvious
    // (without this, the user could glance at Step 6 in the step
    // overview and not realize it was reached via cancel rather
    // than normal completion).
    setStepSummary(6, 'launch cancelled');

    activateStep(6);

    // Refresh the pending-wallets panel — server kept this wallet
    // in the recovery cache (we didn't dismiss), so the user can
    // see it there if they want to claim a delayed deposit later or
    // discard the entry permanently.
    loadPendingWallets();
    return;
  }

  // ---------- Refund path (existing flow) ----------
  const dest = document.getElementById('cancelDestInput').value.trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(dest)) {
    log('Invalid destination address', 'danger');
    return;
  }
  document.getElementById('cancelConfirmModal').classList.remove('is-active');

  // Stop balance polling so we don't fight with the sweep
  if (balancePollHandle) {
    clearInterval(balancePollHandle);
    balancePollHandle = null;
  }

  await withRunState(async () => {
    log(`Cancelling: sweeping wallet to ${dest}...`, 'warning');
    try {
      const resp = await fetch('/api/transfer-assets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          walletPublicKey: tempWallet.publicKey,
          // F5: the server resolves the secret from its encrypted store using
          // the public key for real launches; only demo mode (in-memory
          // ledger, no server-side secret) still sends the key inline.
          ...(demoModeActive ? { tempWalletSecretKey: tempWallet.secretKey } : {}),
          destinationWallet: dest,
          tokenMint: createdTokenInfo ? createdTokenInfo.mint : '',
        }),
      });
      const data = await resp.json();
      if (resp.status === 409 && data.code === 'OP_IN_FLIGHT') {
        // Another launch operation is still running for this wallet.
        // Cancelling means sweeping, and sweeping mid-operation would
        // strand the launch — the server refused for good reason. Wait
        // for the running operation to finish, then cancel.
        log(data.error, 'warning');
        return;
      }
      if (!data.success) throw new Error(data.error);

      const swept = [
        data.tokensTransferred ? `${data.tokensTransferred} tokens` : null,
        data.solTransferred ? `${data.solTransferred} SOL` : null,
        data.nftSweep?.transferred?.length ? `${data.nftSweep.transferred.length} NFT(s)` : null,
      ].filter(Boolean).join(', ');

      // Surface partial-failure modes — same detection logic as runTransfer().
      // The cancel path uses the same /api/transfer-assets endpoint, so it
      // has identical sub-step failure modes (SOL sweep failure with
      // tokens already moved, individual token/NFT transfer errors).
      // Without these warnings the user might think the cancel completed
      // cleanly when SOL is actually stranded in the ephemeral wallet.
      const tokenErrors = data.tokenSweep?.errors || [];
      const nftErrors = data.nftSweep?.errors || [];
      const hasPartialFailure =
        data.solSweepError || tokenErrors.length > 0 || nftErrors.length > 0;

      if (data.solSweepError) {
        log(`Cancel: SOL sweep failed: ${data.solSweepError}`, 'warning');
        log(
          'Tokens and NFTs were moved, but SOL remained in the ephemeral wallet. ' +
          'Use the pending-wallets panel above to recover the SOL with the wallet\'s ' +
          'secret key.',
          'warning',
        );
      }
      for (const e of tokenErrors) {
        log(`Cancel: token sweep error (${e.mint?.slice(0, 8) || 'unknown'}…): ${e.error}`, 'warning');
      }
      for (const e of nftErrors) {
        log(`Cancel: NFT sweep error (${e.mint?.slice(0, 8) || 'unknown'}…): ${e.error}`, 'warning');
      }

      if (hasPartialFailure) {
        log(`Cancel partially complete. Swept: ${swept || 'nothing'} — see warnings`, 'warning');
        setStepSummary(currentStep, `cancelled — partial sweep, see warnings`);
      } else {
        log(`Cancel complete. Swept: ${swept || 'nothing'}`, 'success');
        setStepSummary(currentStep, `cancelled — funds returned`);
      }

      // Show the cancelled panel with the swept summary, and offer
      // start-over when no on-chain ops have run (cancel happened
      // before step 4). showCancelledPanel hides the normal transfer
      // body so the user doesn't see a stale form prompting for a
      // destination they've already used.
      const partialNote = hasPartialFailure
        ? ' Some sub-steps failed — see the activity log for details and use the pending-wallets panel to recover anything stranded.'
        : '';
      const sweptText = swept ? `Swept ${swept} back to ${dest}.` : 'Wallet was already empty.';
      showCancelledPanel(
        currentStep,
        `${sweptText}${partialNote}`,
      );
      setStepSummary(6, 'launch cancelled');
      activateStep(6);

      // Refresh pending-wallets panel — server retains a recovery
      // entry in case of partial-failure or delayed deposits.
      loadPendingWallets();
      markLaunchActiveForRpcHealth(false);
    } catch (e) {
      log(`Cancel failed: ${e.message}`, 'danger');
      markLaunchActiveForRpcHealth(false);
    }
  });
});

bind('cancelBtn', 'click', openCancelConfirm);

// ===========================================================================
// Activity log toggle
// ===========================================================================

bind('activityLogHeader', 'click', () => {
  const container = document.getElementById('activityLogContainer');
  const chevron = document.getElementById('activityLogChevron');
  container.classList.toggle('is-expanded');
  document.body.classList.toggle('log-expanded', container.classList.contains('is-expanded'));
  chevron.classList.toggle('fa-chevron-up');
  chevron.classList.toggle('fa-chevron-down');
});

// ===========================================================================
// CLMM fee tier list — fetched at startup and used to populate the per-pool
// Fee Tier dropdown in Step 2.
// ===========================================================================

// Fetch the canonical CLMM fee tier list from the server (which in turn
// pulls from Raydium's published config endpoint, with its own fallback).
// On success, replaces the hardcoded fallback in feeTiers with the live
// list. If pools are already rendered when the call returns, re-render
// them so the dropdown picks up newly-available tiers — this matters
// only on the rare path where the user manages to add a pool faster than
// the network call returns; usual case is the call completes first.
async function loadFeeTiers() {
  try {
    const resp = await fetch('/api/clmm-fee-tiers').then((r) => r.json());
    if (resp.success && Array.isArray(resp.tiers) && resp.tiers.length > 0) {
      feeTiers = resp.tiers;
      // If pools have already been rendered, the dropdowns were built
      // from the fallback list. Re-render to pick up the live list.
      if (pools.length > 0) renderPools();
    }
  } catch (e) {
    console.error('Failed to load CLMM fee tiers, using fallback:', e);
  }
}

// ===========================================================================
// RPC settings (top of page) — unchanged from previous version
// ===========================================================================

async function loadRpcConfig() {
  try {
    const resp = await fetch('/api/rpc-config').then((r) => r.json());
    if (resp.success) renderRpcConfig(resp.config);
  } catch (e) {
    console.error('Failed to load RPC config:', e);
  }
}

// ===========================================================================
// RPC health polling
// ===========================================================================
//
// Polls /api/rpc-health every 30s during active use and updates a small
// coloured dot next to the RPC display. The dot is green (healthy, fast),
// yellow (healthy but slow), red (errors), or grey (unknown / not yet
// polled). If the RPC returns errors during an active launch flow, a
// warning banner appears with a one-click "Open RPC settings" link.

function updateRpcHealthDot(health) {
  const dot = document.getElementById('rpcHealthDot');
  if (!dot) return;
  dot.className = 'rpc-health-dot health-' + health;
  const labels = {
    good: 'RPC healthy, low latency',
    slow: 'RPC healthy, high latency',
    error: 'RPC returning errors',
    unknown: 'RPC health unknown',
  };
  dot.title = labels[health] || labels.unknown;
}

function showRpcHealthWarning(detail) {
  const banner = document.getElementById('rpcHealthWarning');
  const detailEl = document.getElementById('rpcHealthWarningDetail');
  if (!banner || !detailEl) return;
  detailEl.textContent = detail;
  banner.classList.remove('hidden');
}

function hideRpcHealthWarning() {
  const banner = document.getElementById('rpcHealthWarning');
  if (banner) banner.classList.add('hidden');
}

async function pollRpcHealth() {
  try {
    const resp = await fetch('/api/rpc-health').then(r => r.json());
    if (!resp.success) return;
    _rpcHealthLastResult = resp;
    updateRpcHealthDot(resp.health);

    // Show warning only during active launch flow + when RPC is erroring
    if (_rpcHealthLaunchActive && resp.health === 'error') {
      const detail = resp.error
        ? `The RPC returned: ${resp.error}. Launches may fail mid-flow.`
        : 'The RPC is not responding. Launches will likely fail.';
      showRpcHealthWarning(detail);
    } else if (resp.health !== 'error') {
      hideRpcHealthWarning();
    }
  } catch {
    // Network error from our own server — don't spam the activity log
    // since this runs every 30s. Just mark unknown and move on.
    updateRpcHealthDot('unknown');
    _rpcHealthLastResult = { health: 'unknown', latencyMs: null, error: 'Could not reach health endpoint' };
  }
}

function startRpcHealthPolling() {
  if (_rpcHealthPollTimer) return; // already running
  pollRpcHealth(); // immediate first check
  _rpcHealthPollTimer = setInterval(pollRpcHealth, RPC_HEALTH_INTERVAL_MS);
}

function stopRpcHealthPolling() {
  if (_rpcHealthPollTimer) {
    clearInterval(_rpcHealthPollTimer);
    _rpcHealthPollTimer = null;
  }
  hideRpcHealthWarning();
  updateRpcHealthDot('unknown');
}

function markLaunchActiveForRpcHealth(active) {
  _rpcHealthLaunchActive = active;
  if (!active) hideRpcHealthWarning();
}

// RPC health warning: "Open RPC settings" link handler
bind('rpcHealthWarningSwitch', 'click', (e) => {
  e.preventDefault();
  const panel = document.getElementById('rpcSettingsPanel');
  const chevron = document.getElementById('rpcSettingsChevron');
  panel.classList.remove('hidden');
  chevron.classList.remove('fa-chevron-down');
  chevron.classList.add('fa-chevron-up');
});


// Render an RPC URL safely for display. Keeps just the scheme and host
// — everything else (path, query string) is redacted, because that's
// where API keys typically live. Helius URLs look like
// https://mainnet.helius-rpc.com/?api-key=<secret>; QuickNode/Triton
// embed the key in the path. Showing the host only is enough for the
// user to recognise which RPC is active without exposing their key in
// screenshots, screen-shares, or tutorial videos.
//
// `host` mode returns just "https://mainnet.helius-rpc.com".
// `hostWithIndicator` mode appends "/…" if the original had a path or
// query, as a subtle hint that there's more in the URL the user just
// can't see. That's the default — it makes it obvious the display is
// truncated, not that the URL itself is bare.
function safeRpcUrl(url, mode = 'hostWithIndicator') {
  if (typeof url !== 'string' || url.length === 0) return '';
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    // Malformed input — return a generic placeholder rather than
    // leaking whatever raw text was passed in.
    return '(invalid url)';
  }
  const base = `${parsed.protocol}//${parsed.host}`;
  if (mode === 'host') return base;
  const hasMore = parsed.pathname !== '/' || parsed.search.length > 0;
  return hasMore ? `${base}/…` : base;
}

function renderRpcConfig(config) {
  const active = config.saved.find((r) => r.url === config.active);
  const display = active
    ? `${active.name} — ${safeRpcUrl(active.url)}`
    : safeRpcUrl(config.active);
  document.getElementById('rpcCurrentDisplay').textContent = display;

  // Toggle the public-RPC warning. Anything matching the well-known
  // public mainnet hosts is a launch hazard; dedicated RPCs (custom
  // URLs the user has added — Helius, QuickNode, etc., free tier or
  // otherwise) are fine. We match on hostname rather than exact URL
  // so query-string variants and minor formatting differences all
  // get caught.
  togglePublicRpcWarning(config.active);

  const list = document.getElementById('rpcSavedList');
  list.innerHTML = '';
  config.saved.forEach((rpc) => {
    const isActive = rpc.url === config.active;
    const row = document.createElement('div');
    row.className = 'rpc-row';
    const info = document.createElement('div');
    info.className = 'rpc-info';
    info.innerHTML = `
      <strong>${escapeHtml(rpc.name)}</strong>
      ${isActive ? '<span class="tag is-success is-light is-small">active</span>' : ''}
      <br>
      <span class="is-family-monospace is-size-7">${escapeHtml(safeRpcUrl(rpc.url))}</span>
    `;
    const actions = document.createElement('div');
    actions.className = 'rpc-actions';
    if (!isActive) {
      const useBtn = document.createElement('button');
      useBtn.className = 'button is-small is-primary';
      useBtn.textContent = 'Use';
      useBtn.addEventListener('click', () => selectRpc(rpc.url));
      actions.appendChild(useBtn);
    }
    if (config.saved.length > 1) {
      const rmBtn = document.createElement('button');
      rmBtn.className = 'button is-danger is-light';
      rmBtn.innerHTML = '<span class="icon"><i class="fas fa-times"></i></span>';
      rmBtn.title = 'Remove';
      rmBtn.addEventListener('click', () => removeRpc(rpc.url));
      actions.appendChild(rmBtn);
    }
    row.appendChild(info);
    row.appendChild(actions);
    list.appendChild(row);
  });
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Format a token amount in whole units for display in a balance row.
// Uses Math.floor to avoid the rounding hazard where displayed >
// actual — polling reads this text back as Number to compare against
// the wallet balance, so wallet >= displayed must imply wallet >=
// actual on-chain target. For small amounts (<10), keeps decimals so
// USDC-like rows still display "1" not "0".
function formatTokenDisplay(whole) {
  const n = Number(whole);
  if (!isFinite(n) || n <= 0) return '0';
  if (n >= 10) {
    // Big amounts: floor to integer for readability.
    return String(Math.floor(n));
  }
  // Small amounts: keep up to 4 sig figs, floored.
  // (toPrecision rounds — fine for display since the actual auto-swap
  // target is already buffered with the 2x sizing multiplier.)
  return Number(n.toPrecision(4)).toString();
}

// ---------------------------------------------------------------------------
// Numeric input formatting (thousands separators)
// ---------------------------------------------------------------------------
//
// We display large numbers in inputs with comma thousand-separators
// (e.g. "1,000,000,000") because long runs of zeros are hard to
// distinguish at a glance. The inputs themselves are <input type="text"
// inputmode="numeric"> — type="number" won't store commas and the native
// number stepper would conflict with our formatting.
//
// At submit time, every read site uses parseNumberInput() to strip
// the commas and produce a plain number. Server-side sees raw digits
// only.

// Format an input's current value as a comma-grouped integer string,
// preserving the user's cursor position. Called from the input
// element's `input` event so the value re-formats live as the user
// types — but without the cursor jumping to the end on every keystroke
// (which is what naive innerHTML rewrites would cause).
//
// Cursor preservation works by counting how many commas sit before
// the cursor in the OLD value, computing the same count after the
// reformat, and shifting the cursor by the difference. That handles
// every case I can think of: typing in the middle of a number, deleting
// a digit which removes a comma, pasting a long number, etc.
//
// Allows a leading minus sign and decimals — the integer portion gets
// commas, the decimal portion doesn't. Empty input stays empty (no
// leading "0"). Multiple decimals or non-digit junk gets stripped.
function formatNumberInput(input) {
  if (!input) return;
  const oldValue = input.value;
  const oldCursor = input.selectionStart ?? oldValue.length;

  // Count commas before the cursor in the old value — we'll use this
  // to compute where the cursor should sit after re-formatting.
  const oldCommasBeforeCursor = (oldValue.slice(0, oldCursor).match(/,/g) || []).length;

  // Strip everything except digits, the leading minus, and a single
  // decimal point. Order: minus first (if present), then digits, then
  // optional decimal + more digits.
  const cleaned = oldValue
    .replace(/[^\d.\-]/g, '')         // drop everything but digits, dot, minus
    .replace(/(?!^)-/g, '')           // minus only at start
    .replace(/(\..*)\./g, '$1');      // collapse multiple dots into one

  if (cleaned === '' || cleaned === '-' || cleaned === '.') {
    // Edge case: user is mid-typing something that isn't yet a number
    // (just typed "-" or "."). Keep the literal value, no commas yet.
    input.value = cleaned;
    return;
  }

  // Split integer and decimal portions; comma-format the integer only.
  const negative = cleaned.startsWith('-');
  const body = negative ? cleaned.slice(1) : cleaned;
  const dotIdx = body.indexOf('.');
  const intPart = dotIdx === -1 ? body : body.slice(0, dotIdx);
  const decPart = dotIdx === -1 ? '' : body.slice(dotIdx); // includes the dot

  // Strip leading zeros from the integer part (but keep a single zero
  // if the whole integer is zero, e.g. "0.5").
  const intStripped = intPart.replace(/^0+(?=\d)/, '') || '0';
  const intWithCommas = intStripped.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

  const newValue = (negative ? '-' : '') + intWithCommas + decPart;
  input.value = newValue;

  // Reposition cursor: walk from the start of the new value, counting
  // non-comma characters, and stop when we've walked past the same
  // count as came before the cursor in the old value. This handles
  // every case I tested: typing in the middle, deleting a digit that
  // collapses a comma, pasting a long number, etc.
  const oldNonCommasBeforeCursor = oldCursor - oldCommasBeforeCursor;
  let walked = 0;
  let cursor = 0;
  while (cursor < newValue.length && walked < oldNonCommasBeforeCursor) {
    if (newValue[cursor] !== ',') walked++;
    cursor++;
  }
  input.setSelectionRange(cursor, cursor);
}

// Read a numeric input's current value as a plain number, stripping
// any thousand-separator commas. Returns NaN for empty / unparseable
// inputs — same as Number() on a malformed string. Callers that need
// a non-NaN fallback should provide one explicitly (e.g. `?? 0`).
function parseNumberInput(input) {
  if (!input) return NaN;
  const raw = String(input.value).replace(/,/g, '');
  if (raw === '' || raw === '-' || raw === '.') return NaN;
  return Number(raw);
}

function getIntegerInputString(input) {
  if (!input) return '';
  return String(input.value).replace(/,/g, '').trim();
}

// Show a warning banner whenever the active RPC is one of the well-known
// public mainnet endpoints. The list is matched by hostname so all the
// quirky variants (with/without trailing slashes, query strings, etc.)
// still get caught. If a new public alias appears in the wild, just add
// its hostname here.
const PUBLIC_RPC_HOSTS = new Set([
  'api.mainnet-beta.solana.com',
  'solana-api.projectserum.com',
  'rpc.ankr.com',                    // free tier shows up here
  'solana.public-rpc.com',
]);

function togglePublicRpcWarning(activeUrl) {
  const banner = document.getElementById('publicRpcWarning');
  if (!banner) return;

  let isPublic = false;
  try {
    const host = new URL(activeUrl).hostname.toLowerCase();
    isPublic = PUBLIC_RPC_HOSTS.has(host);
  } catch {
    // Malformed URL — treat as not-public (the existing test/validate
    // flow will surface URL problems separately).
    isPublic = false;
  }

  banner.classList.toggle('hidden', !isPublic);
}

async function selectRpc(url) {
  try {
    const resp = await fetch('/api/rpc-config/select', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    }).then((r) => r.json());
    if (resp.success) {
      renderRpcConfig(resp.config);
      log(`Switched RPC to ${safeRpcUrl(url)}`, 'success');
    }
  } catch (e) {
    log(`Failed to switch RPC: ${e.message}`, 'danger');
  }
}

async function removeRpc(url) {
  // The confirm dialog should identify which RPC is being removed
  // without exposing the API key in the URL. Hostname is plenty for
  // the user to recognise. escapeHtml because the URL goes into
  // innerHTML; we don't trust user-supplied URL bytes.
  const ok = await confirmDialog({
    title: 'Remove RPC?',
    body: `<p>Remove this RPC from your saved list?</p>
           <p class="is-family-monospace is-size-7">${escapeHtml(safeRpcUrl(url))}</p>`,
    confirmLabel: 'Remove',
    danger: true,
  });
  if (!ok) return;
  try {
    const resp = await fetch('/api/rpc-config/remove', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    }).then((r) => r.json());
    if (resp.success) renderRpcConfig(resp.config);
  } catch (e) {
    log(`Failed to remove RPC: ${e.message}`, 'danger');
  }
}

function toggleSettingsPanel() {
  const toggle = document.getElementById('rpcSettingsToggle');
  const panel = document.getElementById('rpcSettingsPanel');
  const chevron = document.getElementById('rpcSettingsChevron');
  if (!panel) return;
  // classList.toggle returns true when the class is now present, i.e. the
  // panel is now hidden — so aria-expanded is the negation.
  const nowHidden = panel.classList.toggle('hidden');
  if (chevron) {
    chevron.classList.toggle('fa-chevron-down');
    chevron.classList.toggle('fa-chevron-up');
  }
  if (toggle) toggle.setAttribute('aria-expanded', String(!nowHidden));
}
bind('rpcSettingsToggle', 'click', toggleSettingsPanel);
// The header is role="button" with tabindex=0, so support keyboard
// activation the way a native button would: Enter and Space toggle it
// (Space is prevented from scrolling the page).
bind('rpcSettingsToggle', 'keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    toggleSettingsPanel();
  }
});

bind('testRpcBtn', 'click', async () => {
  const url = document.getElementById('newRpcUrl').value.trim();
  const result = document.getElementById('rpcTestResult');
  if (!url) {
    result.textContent = 'Enter a URL first';
    result.className = 'help is-warning';
    return;
  }
  result.textContent = 'Testing...';
  result.className = 'help';
  try {
    const resp = await fetch('/api/rpc-config/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    }).then((r) => r.json());
    if (resp.result.ok) {
      result.textContent = `OK — Solana ${resp.result.version}, ${resp.result.latencyMs}ms`;
      result.className = 'help is-success';
    } else {
      result.textContent = `Failed: ${resp.result.error}`;
      result.className = 'help is-danger';
    }
  } catch (e) {
    result.textContent = `Failed: ${e.message}`;
    result.className = 'help is-danger';
  }
});

bind('addRpcBtn', 'click', async () => {
  const name = document.getElementById('newRpcName').value.trim();
  const url = document.getElementById('newRpcUrl').value.trim();
  const result = document.getElementById('rpcTestResult');
  if (!name || !url) {
    result.textContent = 'Both name and URL are required';
    result.className = 'help is-warning';
    return;
  }
  try {
    const resp = await fetch('/api/rpc-config/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, url, setActive: true }),
    }).then((r) => r.json());
    if (resp.success) {
      document.getElementById('newRpcName').value = '';
      document.getElementById('newRpcUrl').value = '';
      result.textContent = '';
      renderRpcConfig(resp.config);
      log(`RPC added: ${name}`, 'success');
    } else {
      result.textContent = `Failed: ${resp.error}`;
      result.className = 'help is-danger';
    }
  } catch (e) {
    result.textContent = `Failed: ${e.message}`;
    result.className = 'help is-danger';
  }
});

// ===========================================================================
// STEP 1: Generate wallet
// ===========================================================================

bind('generateWalletBtn', 'click', async () => {
  const btn = document.getElementById('generateWalletBtn');
  // If a wallet already exists, this is a regenerate. Confirm to avoid
  // accidentally wiping a launch in progress. Tailor the warning to how
  // far along the user is — past step 3 they may have funded the wallet.
  if (tempWallet && currentStep > 1) {
    const pastFunding = currentStep > 3;
    const body = pastFunding
      ? '<p>You are mid-launch. Generating a new wallet will <strong>not</strong> ' +
        'recover any funds, tokens, or NFTs already in the current ephemeral ' +
        'wallet — those will be stranded unless you save the private key ' +
        '(currently visible above) <strong>first</strong>.</p>' +
        '<p>Cancel this dialog, click "Show Private Key", copy the key somewhere ' +
        'safe, <strong>then</strong> regenerate.</p>' +
        '<p>Proceed anyway?</p>'
      : '<p>You already have a wallet from this session. Generating a new one will ' +
        'discard it. If you sent any SOL to it, you will lose access unless you ' +
        'saved the private key first.</p>' +
        '<p>Proceed?</p>';
    const ok = await confirmDialog({
      title: 'Discard current wallet?',
      body,
      confirmLabel: 'Generate new wallet',
      danger: true,
    });
    if (!ok) return;
  }

  await withRunState(async () => {
    setLoading(btn, true);
    try {
      log('Generating temporary wallet...');
      if (balancePollHandle) {
        clearInterval(balancePollHandle);
        balancePollHandle = null;
      }
      const resp = await fetch('/api/generate-wallet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const data = await resp.json();
      if (!data.success) throw new Error(data.error);

      // Reset all per-launch state so a regenerate starts truly fresh
      tempWallet = data.wallet;
      fundingWallet = null;
      fundingDetectionExhausted = false;
      lastSolBalance = 0;
      createdTokenInfo = null;
      lpResult = null;
      lastAirdropResult = null;
      fundingRequirement = { solLamports: 0, byQuote: {}, autoSwapPlan: [] };

      // Reset UI panels that may carry stale info from a previous attempt
      document.getElementById('walletInfo').classList.remove('hidden');
      document.getElementById('qrCode').src = data.wallet.qrCode;
      document.getElementById('walletAddress').value = data.wallet.publicKey;
      document.getElementById('privateKeyContainer').classList.add('hidden');
      document.getElementById('tokenCreatedInfo').classList.add('hidden');
      document.getElementById('createTokenBtn').classList.remove('hidden');
      document.getElementById('createLpBtn').classList.remove('hidden');
      document.getElementById('transferAssetsBtn').classList.remove('hidden');
      setLpDoneVisible(false);
      document.getElementById('lpFailInfo').classList.add('hidden');
      document.getElementById('lpProgress').classList.add('hidden');
      document.getElementById('lpProgressTree').innerHTML = '';
      document.getElementById('transferResult').classList.add('hidden');
      document.getElementById('fundingWalletInfo').classList.add('hidden');
      document.getElementById('destinationWallet').value = '';
      // In demo mode, immediately re-fill with the synthetic destination
      // address so the user doesn't have to re-enter anything to finish
      // a second demo run after a reset. No-op in real mode.
      applyDemoDestinationWallet();

      // Reset step summaries from any prior attempt
      for (let i = 2; i <= 6; i++) setStepSummary(i, '');

      document.body.classList.add('has-log');

      log(`Wallet generated: ${data.wallet.publicKey}`, 'success');
      markLaunchActiveForRpcHealth(false);

      if (pools.length === 0) {
        // Build pools from simpleConfig defaults — produces 90/10
        // SOL+XLRT (or whatever the user has selected in the simple
        // toggle) instead of the old single SOL pool. The simple-config
        // UI may have been rendered already (see init at the bottom of
        // this file); we re-apply the mode here to make sure the right
        // container is visible after step 2 activates.
        rebuildPoolsFromSimple();
      }
      applySimpleConfigMode();

      setStepSummary(1, `${data.wallet.publicKey.slice(0, 8)}…${data.wallet.publicKey.slice(-6)}`);
      activateStep(2);
      updateContinueToFundingState();
      updateCancelButtonState();
    } catch (e) {
      log(`Error: ${e.message}`, 'danger');
    } finally {
      setLoading(btn, false);
    }
  });
});

bind('showPrivateKeyBtn', 'click', () => {
  const cont = document.getElementById('privateKeyContainer');
  const target = document.getElementById('privateKey');
  if (!tempWallet) return;
  if (cont.classList.contains('hidden')) {
    // New wallets always have a mnemonic; the base58 fallback is only
    // here in case something upstream changes and we end up without one.
    if (tempWallet.mnemonic) {
      target.innerHTML = '';
      target.appendChild(buildMnemonicGrid(tempWallet.mnemonic));
    } else {
      target.className = 'secret-key-container';
      target.textContent = tempWallet.secretKeyB58 || '(secret unavailable)';
    }
    cont.classList.remove('hidden');
  } else {
    cont.classList.add('hidden');
  }
});

// Build a numbered 12-word grid for displaying a BIP39 mnemonic. Reads
// nicely on screen, easy to copy down accurately on paper.
function buildMnemonicGrid(mnemonic) {
  const wrap = document.createElement('div');
  wrap.className = 'mnemonic-grid';
  const words = mnemonic.trim().split(/\s+/);
  words.forEach((word, i) => {
    const cell = document.createElement('div');
    cell.innerHTML = `<span class="num">${i + 1}.</span>${word}`;
    wrap.appendChild(cell);
  });
  return wrap;
}

// ===========================================================================
// STEP 2: Token + Pool config
// ===========================================================================

// Validate a picked logo file against the size and dimension limits.
// Returns a Promise<string|null>: null on success, an error message on
// failure. Loads the file as an image to read its natural dimensions —
// we can't trust the file metadata or filename extension for this; the
// only reliable read is "actually decode the image and ask."
//
// The Image decode is wrapped in a same-document objectURL that we
// revoke immediately after, regardless of outcome, so this validation
// path doesn't leak object URLs even on rapid file changes.
async function validateLogoFile(file) {
  if (file.size > MAX_LOGO_BYTES) {
    const kb = (file.size / 1024).toFixed(1);
    const maxKb = (MAX_LOGO_BYTES / 1024).toFixed(0);
    return `Logo is ${kb}KB; max is ${maxKb}KB. ` +
      `Compress the image or pick a smaller file.`;
  }
  // accept attribute on the input already restricts the picker to
  // image/png and image/jpeg, but the browser's filter isn't a hard
  // gate (drag-and-drop, devtools, OS file dialogs that ignore filters
  // on some platforms). Re-check the MIME explicitly so we surface a
  // useful message instead of letting the image decode fail opaquely.
  if (file.type !== 'image/png' && file.type !== 'image/jpeg') {
    return 'Logo must be a PNG or JPG image.';
  }

  // Image-decode dimension check. We have to actually load the file as
  // an image — there's no synchronous way to get pixel dimensions from
  // a File object. createObjectURL + new Image() is the standard idiom.
  const url = URL.createObjectURL(file);
  try {
    const dims = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
      img.onerror = () => reject(new Error('Could not decode image — file may be corrupt'));
      img.src = url;
    });
    if (dims.w > MAX_LOGO_DIMENSION || dims.h > MAX_LOGO_DIMENSION) {
      return `Logo is ${dims.w}×${dims.h}px; max is ` +
        `${MAX_LOGO_DIMENSION}×${MAX_LOGO_DIMENSION}px. Resize the image and try again.`;
    }
    if (dims.w < MIN_LOGO_DIMENSION || dims.h < MIN_LOGO_DIMENSION) {
      return `Logo is ${dims.w}×${dims.h}px; minimum is ` +
        `${MIN_LOGO_DIMENSION}×${MIN_LOGO_DIMENSION}px. Pick a larger image.`;
    }
    return null;
  } catch (e) {
    return e.message || 'Could not read the image.';
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Show or clear the inline logo error message under the file picker.
// Passing null hides the element; passing a string reveals it with the
// message. Encapsulates the .hidden toggle so the call sites read
// clearly as "set the error" vs "clear the error."
function setLogoError(message) {
  const el = document.getElementById('tokenLogoError');
  if (!el) return;
  if (message) {
    el.textContent = message;
    el.classList.remove('hidden');
  } else {
    el.textContent = '';
    el.classList.add('hidden');
  }
}

bind('tokenLogo', 'change', async (e) => {
  const f = e.target.files[0];
  const filenameEl = document.getElementById('logoFileName');
  // No file selected (user cancelled out of the picker, or cleared the
  // selection). Reset displayed state and any prior error.
  if (!f) {
    filenameEl.textContent = 'No file selected';
    setLogoError(null);
    return;
  }
  // Show the picked filename immediately so the UI feels responsive
  // even while we're decoding the image to check dimensions. We'll
  // overwrite this with "No file selected" if validation fails.
  filenameEl.textContent = f.name;
  setLogoError(null);

  const err = await validateLogoFile(f);
  if (err) {
    // Reject the file: clear the input so subsequent code paths
    // (renderTokenPreview, the create-token submit) see no logo at
    // all, rather than seeing a logo that's about to be rejected by
    // the server. Setting .value = '' is the cross-browser way to
    // programmatically clear a file input.
    e.target.value = '';
    filenameEl.textContent = 'No file selected';
    setLogoError(err);
    // Trigger a preview re-render so the thumbnail and live preview
    // card both drop back to their no-logo state.
    if (typeof renderTokenPreview === 'function') renderTokenPreview();
    return;
  }
  // Valid file — leave the filename as set above. The separate
  // change-handler binding (see bind('tokenLogo', 'change', renderTokenPreview)
  // below in this file) handles updating the preview thumbnail and
  // live card. We don't trigger it directly from here; the browser
  // fires `change` once and both listeners receive it.
});

const poolList = document.getElementById('poolList');

function addPool(initial = {}) {
  // Default supplyPercent to whatever's left of the 100% budget so we never
  // create a new pool that pushes the total over 100. Callers that pass an
  // explicit supplyPercent (wallet-generation passes 100, future presets
  // will pass their own) bypass this default unchanged. If the budget is
  // already full the new pool comes up at 0% and the validation surfaces a
  // "set an allocation" hint inline.
  const sumExisting = pools.reduce((s, p) => s + (Number(p.supplyPercent) || 0), 0);
  const defaultPct = Math.max(0, 100 - sumExisting);
  pools.push({
    quoteToken: initial.quoteToken || 'SOL',
    supplyPercent: initial.supplyPercent ?? defaultPct,
    ammConfigIndex: 3,
    quoteUsdOverride: null,
    quoteDecimalsOverride: null,
    quoteSymbolOverride: null,
    resolvedSymbol: null,
    resolvedDecimals: null,
    resolvedPriceUsd: null,
    resolvedMint: null,
    // Optional display-only fields populated by /api/quote-token-info.
    // Either may be null if no indexer (Gecko, DexScreener) had the
    // token — the UI just hides the logo or falls back to the symbol.
    resolvedName: null,
    resolvedImageUrl: null,
    // Raydium CLMM compatibility info, set by resolvePoolQuote():
    //   resolvedCompatible: true | false | null (null = couldn't check)
    //   resolvedIsToken2022: bool — true when the mint is owned by the
    //                        Token-2022 program (vs the classic SPL Token
    //                        program). Token-2022 mints with allowlisted
    //                        extensions are still compatible.
    //   resolvedDisallowedNames: [string] — friendly names of any Token-2022
    //                        extensions this mint has that Raydium CLMM
    //                        doesn't accept. Empty when compatible.
    //   resolvedCompatError: string | null — populated when the on-chain
    //                        check failed (RPC issue / mint missing).
    resolvedCompatible: null,
    resolvedIsToken2022: false,
    resolvedDisallowedNames: [],
    resolvedCompatError: null,
    // Step 2 Raydium-route probe result. Server runs a swap probe at
    // /api/quote-token-info time (per the price-safety plan's
    // Milestone D) so the user finds out early whether their chosen
    // quote token is Raydium-tradeable.
    //   'yes'      → probe succeeded, route exists. Safe to continue.
    //   'no'       → probe ran, Trade API said no route. Block continue.
    //   'unknown'  → probe couldn't run (Trade API unreachable, etc).
    //                Allow continue but warn — Step 5 will check again.
    //   null       → not yet checked (initial state before any fetch).
    resolvedRaydiumTradeable: null,
    resolvedRaydiumProbeError: null,
    // Authority audit fields from the on-chain mint read.
    //   resolvedFreezeAuthorityBlock: true means deployer can freeze
    //                                 wallet balances; hard block.
    //   resolvedMintAuthorityWarning: true means deployer can inflate
    //                                 supply; soft warning.
    //   Either may be null when the audit didn't run (RPC down, mint
    //   missing).
    resolvedFreezeAuthorityBlock: null,
    resolvedMintAuthorityWarning: null,
    // Track the provenance of resolvedPriceUsd so the UI can label
    // it appropriately ("from Raydium" is more trustworthy than
    // "from external indexer" and we want the user to know which).
    resolvedPriceSource: null,
    // Initial distribution. Defaults to a single 100% slice (one
    // position, one Fee Key NFT). The simple-config "Split the LP"
    // toggle passes a multi-slice distribution here for users who
    // want N positions, each minting its own transferable NFT.
    distribution: initial.distribution || [
      { sharePercent: 100, recipient: null, useExternalRecipient: false },
    ],
    // Per-pool bootstrap configuration.
    //   { mode: 'minimal' } — 1-whole-token reserve, narrow tick range
    //   { mode: 'custom', solValue: N, supplyPercent: M } — user-funded
    //
    // Under "user thinks in SOL" semantics, solValue is the canonical
    // input — the absolute SOL value of starting liquidity the user
    // wants on this pool. supplyPercent is DERIVED from solValue,
    // pool.supplyPercent, the target market cap, and the SOL/USD price.
    // It's recomputed any time those inputs change (the user types SOL,
    // the target mcap input is edited, the SOL price resolves), and
    // the wide slices auto-rebalance to absorb the delta so positions
    // total stays at 100%.
    //
    // supplyPercent is stored alongside solValue (rather than recomputed
    // every read) so the positions-total indicator and the wire-format
    // conversion don't have to redo the derivation logic on every paint.
    // Whenever solValue or any input it depends on changes, we call
    // recomputePoolBootstrapAndRebalance() to refresh supplyPercent and
    // rebalance slices in one shot.
    bootstrapConfig: initial.bootstrapConfig || { mode: 'minimal' },
    // Per-pool ladder configuration.
    //   { mode: 'off' } — no ladder positions
    //   { mode: 'manual', bands: [...] } — explicit list of bands
    // Each band: { supplyPercent, lowerMultiplier, upperMultiplier }
    // where multipliers are relative to launch price (e.g., 1.5–2.5 =
    // a band spanning 1.5× to 2.5× of launch price). The simple-UI
    // ladder toggle populates manual-mode bands using the log-spaced
    // preset; customize mode lets the user edit, add, or remove
    // individual bands. The wire format the backend receives is
    // always 'off' or 'manual' from the trebuchet frontend; the
    // backend's older 'simple' mode is preserved for direct API
    // users (scripts) but unused here.
    ladderConfig: initial.ladderConfig || { mode: 'off', bands: [] },
    // Per-pool support configuration.
    //   { mode: 'off' } — no support position
    //   { mode: 'custom', solValue: N } — single-sided quote position
    //                                     funded with N SOL of value
    //
    // Support is quote-only (no token supply required), so it's
    // orthogonal to the pool's supplyPercent budget and to the bootstrap
    // and ladder allocations. It exists purely as a buy wall sitting
    // just below launch price (covering down to depthPct% below, default
    // 10%), backing any preallocated supply held outside LP. Modeled with
    // the same shape as bootstrap (mode + solValue + per-position config)
    // for consistency, even though support has no derived supplyPercent
    // — it doesn't carve from anything.
    supportConfig: initial.supportConfig || { mode: 'off' },
    // UI-only: whether this pool's body is expanded in the editor. Set
    // by initialIsExpanded() at construction; the user can flip it via
    // the header click or via auto-expansion when the pool needs
    // attention. Buildmode/render code never reads this on a collapsed
    // pool, since collapsed pools only render the header strip.
    _isExpanded: initial._isExpanded ?? false,
  });
  renderPools();
  // Pool quote resolution kicks off async. For mints we've already
  // resolved this session (cached in quoteInfoCache), apply the cached
  // info SYNCHRONOUSLY first so the pool starts with resolved fields
  // populated and downstream renders don't see a transient empty
  // state. The async resolvePoolQuote still runs — it handles TTL
  // refresh and the uncached case — but the synchronous pre-fill
  // closes the race window that produced missing logos in the
  // funding step (Continue → flushRebuildPoolsFromSimple clears
  // pools → addPool creates fresh empty pools → renderFundingRequirements
  // ran before resolvePoolQuote's async microtask fired).
  const newPoolIdx = pools.length - 1;
  const newPool = pools[newPoolIdx];
  const cachedQuoteInfo = quoteInfoCache.get(newPool.quoteToken);
  if (cachedQuoteInfo && cachedQuoteInfo.info
      && typeof applyResolvedInfoToPool === 'function') {
    applyResolvedInfoToPool(newPool, cachedQuoteInfo.info);
  }
  resolvePoolQuote(newPoolIdx);
}

function removePool(idx) {
  pools.splice(idx, 1);
  renderPools();
  updateContinueToFundingState();
}

// Add a slice to a pool's distribution. Splits the last existing slice
// in half so the total wide allocation doesn't change — the user is
// subdividing for ownership splitting, not reallocating supply. The
// new slice arrives with no recipient set; user can wire one up via
// "Send to a different wallet" checkbox in the row.
function addSlice(poolIdx) {
  const p = pools[poolIdx];
  // Adding a slice always splits the LAST existing slice in half.
  // This keeps the positions total invariant — the wide bucket's
  // size doesn't change, we just subdivide it further for ownership
  // splitting.
  //
  // If there are no existing slices (edge case — distribution was
  // emptied), seed with what's left of the wide bucket after bs +
  // bands. Should never happen in practice since addPool seeds one
  // slice, but we guard so a corrupt state can still recover.
  if (p.distribution.length === 0) {
    const bsPct = (p.bootstrapConfig?.mode === 'custom')
      ? Number(p.bootstrapConfig.supplyPercent) || 0 : 0;
    const bandsPct = (p.ladderConfig?.mode === 'manual' && Array.isArray(p.ladderConfig.bands))
      ? p.ladderConfig.bands.reduce((s, b) => s + (Number(b.supplyPercent) || 0), 0) : 0;
    const widePct = Math.max(0, 100 - bsPct - bandsPct);
    p.distribution.push({ sharePercent: widePct, recipient: null, useExternalRecipient: false });
  } else {
    const last = p.distribution[p.distribution.length - 1];
    const lastShare = Number(last.sharePercent) || 0;
    const half = Number((lastShare / 2).toFixed(4));
    last.sharePercent = half;
    p.distribution.push({ sharePercent: half, recipient: null, useExternalRecipient: false });
  }
  renderPools();
}

function removeSlice(poolIdx, sliceIdx) {
  const p = pools[poolIdx];
  if (p.distribution.length <= 1) return;
  // Absorb the removed slice's share into the last remaining slice so
  // the positions total stays at whatever it was. Without this, removing
  // a slice would silently shrink the wide bucket and the user would
  // see a confusing "now total is 75%" warning that they didn't trigger
  // intentionally. The remaining slice grows to take back the freed
  // share.
  const removedShare = Number(p.distribution[sliceIdx].sharePercent) || 0;
  p.distribution.splice(sliceIdx, 1);
  if (p.distribution.length > 0) {
    const last = p.distribution[p.distribution.length - 1];
    last.sharePercent = Number(
      ((Number(last.sharePercent) || 0) + removedShare).toFixed(4),
    );
  }
  renderPools();
}

// ---------------------------------------------------------------------------
// Simple-config rendering and pool rebuild
// ---------------------------------------------------------------------------

// Rebuild the pools array from the current simpleConfig state. Always
// produces either one pool (SOL at 100%) or two pools (SOL at 90% +
// flywheel at 10%). Wipes any existing pools — this function is the
// authority on what pools look like when in default mode.
//
// Pools come up collapsed by default (since they're at trivial defaults
// with no user customization). Resolution kicks off automatically per
// the existing addPool() behavior.
//
// This is a thin wrapper around rebuildPoolsFromSimpleCore so the
// simple-mode ladder depth-chart preview refreshes after EVERY rebuild,
// no matter which input triggered it — support edits, preallocation
// auto-back, flywheel split, market cap, ladder controls. The core has
// more than one exit (the flywheel branch returns early), so centralising
// the refresh here means no exit path can forget it. updateSimpleLadderPreview
// is a no-op when the preview isn't on screen (e.g. during the init rebuild
// before the simple UI renders, or while in customize mode).
function rebuildPoolsFromSimple() {
  rebuildPoolsFromSimpleCore();
  updateSimpleLadderPreview();
}

function rebuildPoolsFromSimpleCore() {
  // Wipe the existing pool list. We assume the caller knows what they're
  // doing — switching from customize → default mode should confirm
  // before calling this.
  pools.length = 0;

  // Before deriving any pool config, ensure simpleConfig.supportSolValue
  // is at or above the auto-back floor. Without this sync, every rebuild
  // path would have to remember to seed the floor explicitly — and the
  // ones that forget (initial page load, anywhere a rebuild fires
  // without first running through a write handler) produce pools with
  // stale support values. The auto-back floor depends on SOL price; if
  // the price isn't resolved yet the floor is null and we leave stored
  // alone (the next rebuild after SOL resolves will catch up).
  //
  // We only WRITE when the floor is strictly higher than stored — the
  // auto-back promise is "no less than the floor," not "exactly the
  // floor." A user who typed a deeper-than-required wall keeps their
  // typed value.
  if (simpleConfig.supportAutoSize && simpleConfig.preallocationEnabled) {
    const rec = recommendedSupportSolForPreallocation(
      Number(simpleConfig.preallocationPercent) || 0,
    );
    if (Number.isFinite(rec) && rec > 0
        && rec > (Number(simpleConfig.supportSolValue) || 0)) {
      simpleConfig.supportSolValue = rec;
    }
  }

  // Preallocation reduces the total LP budget by that %. Pool allocations
  // (SOL + optional flywheel) get scaled proportionally to fit inside the
  // remaining LP budget so the user's intended flywheel split is preserved.
  // Default (no preallocation) is 100% to LP. When the user enables a 20%
  // preallocation with a 90/10 SOL/flywheel split, pools end up at 72%/18%
  // (sum = 80%), leaving 20% outside LP for the user to distribute as they
  // see fit (airdrop, presale, team allocation, etc.).
  const preallocPct = simpleConfig.preallocationEnabled
    ? Math.max(0, Math.min(99, Number(simpleConfig.preallocationPercent) || 0))
    : 0;
  const lpBudget = 100 - preallocPct;

  // Helper: compute the wide-bucket total for a pool given its bs + ladder
  // configs. With unified semantics, bs + sum(ladder) + sum(wide slices)
  // = 100% of pool. So wide total = 100 - bs - sum(bands). Slices then
  // split this wide total equally.
  function widePctForPool(bsCfg, ladderCfg) {
    const bsPct = bsCfg && bsCfg.mode === 'custom' ? Number(bsCfg.supplyPercent) : 0;
    const ladderTotal = ladderCfg && Array.isArray(ladderCfg.bands)
      ? ladderCfg.bands.reduce((s, b) => s + Number(b.supplyPercent || 0), 0)
      : 0;
    return Math.max(0, 100 - bsPct - ladderTotal);
  }

  if (simpleConfig.flywheelEnabled) {
    const fw = FLYWHEELS[simpleConfig.flywheelKey];
    if (fw && fw.available && fw.mint) {
      const flywheelPct = Math.max(
        FLYWHEEL_MIN_PERCENT,
        Math.min(FLYWHEEL_MAX_PERCENT, Number(simpleConfig.flywheelPercent) || DEFAULT_FLYWHEEL_PERCENT),
      );
      // Scale the SOL/flywheel split to fit inside the LP budget. The
      // user's intended ratio (flywheelPct of the LP slice) is preserved
      // — preallocation just shrinks the total they share. So if the
      // user wants 20% flywheel and 80% SOL with a 10% preallocation,
      // pools end up at 72% SOL / 18% flywheel (sum 90%) leaving 10%
      // preallocated.
      const solSharePct = 100 - flywheelPct; // share of LP budget for SOL
      const solPoolPct = solSharePct * lpBudget / 100;
      const fwPoolPct = flywheelPct * lpBudget / 100;

      // Compute bootstrap and ladder for each pool. Bootstrap is derived
      // per-pool (since the pool's supplyPercent matters for converting
      // dollar value to % of pool); ladder is the same shape on both.
      const solBs = deriveBootstrapConfigFromSimple(solPoolPct, 2);
      const solLadder = deriveLadderConfigFromSimple();
      const fwBs = deriveBootstrapConfigFromSimple(fwPoolPct, 2);
      const fwLadder = deriveLadderConfigFromSimple();

      // Support config: simple mode spreads the total support SOL
      // equally across both pools (SOL and flywheel). Each pool gets
      // totalSupportSol / 2 SOL of buy-side support — same equal-split
      // pattern as starting liquidity. This matches the spec: "spread
      // across the various pools similar to how the starting liquidity
      // feature works."
      //
      // We clone the derived config for each pool so the two pools
      // don't share the same object reference. Without this, a later
      // mutation in customize mode (e.g. user toggles support off on
      // one pool) would affect both pools. Cloning is cheap — the
      // config is a flat object with 2-3 primitive fields.
      const sharedSupport = deriveSupportConfigFromSimple(2);
      const solSupport = { ...sharedSupport };
      const fwSupport = { ...sharedSupport };

      // Distribution slices share the wide bucket. Split-the-LP applies
      // only to the SOL pool in simple mode; flywheel pool always gets
      // one slice. Each slice's sharePercent is "% of pool" (new unified
      // semantics).
      const solSplitCount = simpleConfig.splitEnabled ? simpleConfig.splitCount : 1;
      const solDistribution = buildEqualSplitDistribution(
        solSplitCount, widePctForPool(solBs, solLadder),
      );
      const fwDistribution = buildEqualSplitDistribution(
        1, widePctForPool(fwBs, fwLadder),
      );
      addPool({
        quoteToken: 'SOL',
        supplyPercent: solPoolPct,
        distribution: solDistribution,
        bootstrapConfig: solBs,
        ladderConfig: solLadder,
        supportConfig: solSupport,
      });
      addPool({
        quoteToken: fw.mint,
        supplyPercent: fwPoolPct,
        distribution: fwDistribution,
        bootstrapConfig: fwBs,
        ladderConfig: fwLadder,
        supportConfig: fwSupport,
      });
      return;
    }
    // Selected flywheel is not available (e.g. user picked it before
    // it launches, or the entry got removed); fall through to single-
    // SOL-pool default. The dropdown should prevent this in normal use.
  }

  // Default / flywheel-disabled / unavailable-flywheel case. Only one
  // pool (SOL), so splitting that pool is the only kind of split that
  // makes sense here. Preallocation still applies — the single pool's
  // allocation shrinks to the LP budget, with the remainder held back.
  const bsCfg = deriveBootstrapConfigFromSimple(lpBudget, 1);
  const ladderCfg = deriveLadderConfigFromSimple();
  const supportCfg = deriveSupportConfigFromSimple(1);
  const distribution = buildEqualSplitDistribution(
    simpleConfig.splitEnabled ? simpleConfig.splitCount : 1,
    widePctForPool(bsCfg, ladderCfg),
  );
  addPool({
    quoteToken: 'SOL',
    supplyPercent: lpBudget,
    distribution,
    bootstrapConfig: bsCfg,
    ladderConfig: ladderCfg,
    supportConfig: supportCfg,
  });
}

// Translate the simple-UI bootstrap config into a per-pool bootstrapConfig.
//
// As of the support-consolidation change, simple mode never exposes a
// custom-bootstrap control to the user — the bootstrap is always a
// minimal ~$1 reservation. Real quote-side starting liquidity is now
// added via the Support position feature (single-sided, no token-side
// thickening). Token-side density near launch is the job of the
// Ladder feature.
//
// The custom-bootstrap path is preserved in code for two reasons:
//   1. customize mode still supports per-pool bootstrap overrides
//      (the per-pool UI doesn't expose it anymore, but the data
//      pipeline still works end-to-end for any future re-introduction)
//   2. Saved configs that pre-date this change might still carry
//      bootstrapMode='custom' in their state; the existing pre-flight
//      and wire-format code handles those without regression.
//
// supplyPercent (when in custom mode) uses the live SOL price when
// available (read from the SOL pool's resolvedPriceUsd), falling back
// to $200 when no pool has resolved yet — same fallback the funding
// estimator uses. The post-resolution refresh in resolvePoolQuote
// re-runs this and updates each pool's supplyPercent + rebalances
// slices when the live price arrives.
//
// If any input is missing or invalid, we return minimal mode. That's
// the safe default — the pool will just spawn with a tradable ~$1
// reserve and the user can recover by switching to customize.
function deriveBootstrapConfigFromSimple(poolSupplyPercent, poolCount) {
  if (simpleConfig.mode !== 'default') return { mode: 'minimal' };
  if (simpleConfig.bootstrapMode !== 'custom') return { mode: 'minimal' };
  const totalSol = Number(simpleConfig.bootstrapSolValue);
  if (!Number.isFinite(totalSol) || totalSol <= 0) return { mode: 'minimal' };
  if (!Number.isFinite(poolCount) || poolCount <= 0) return { mode: 'minimal' };
  if (!Number.isFinite(poolSupplyPercent) || poolSupplyPercent <= 0) return { mode: 'minimal' };

  // Each pool gets an equal share of the total bootstrap SOL.
  const perPoolSol = totalSol / poolCount;
  // Derive supplyPercent for initial display. The on-input handlers
  // and the targetMarketCap/resolvePoolQuote hooks all recompute this
  // via computeBootstrapSupplyPercent() which uses the same logic.
  const supplyPercent = computeBootstrapSupplyPercent(perPoolSol, poolSupplyPercent);
  if (supplyPercent == null) return { mode: 'minimal' };
  return { mode: 'custom', solValue: perPoolSol, supplyPercent };
}

// Compute the supplyPercent (% of pool) for a bootstrap given:
//   solValue        — absolute SOL of starting liquidity for THIS pool
//   poolSupplyPct   — pool's allocation as % of total token supply
//
// Reads targetMarketCap from the DOM and the SOL price from the SOL
// pool's resolvedPriceUsd (falls back to $200 if unresolved). Returns
// null if any input is missing/invalid; callers treat null as "leave
// the supplyPercent alone."
function computeBootstrapSupplyPercent(solValue, poolSupplyPct) {
  const sol = Number(solValue);
  if (!Number.isFinite(sol) || sol <= 0) return null;
  if (!Number.isFinite(poolSupplyPct) || poolSupplyPct <= 0) return null;
  const targetMc = parseNumberInput(document.getElementById('targetMarketCap'));
  if (!Number.isFinite(targetMc) || targetMc <= 0) return null;
  const solPool = pools.find((p) => (p.quoteToken || '').toUpperCase() === 'SOL');
  const solUsd = solPool && Number(solPool.resolvedPriceUsd) > 0
    ? Number(solPool.resolvedPriceUsd) : 200;
  const bsUsd = sol * solUsd;
  const poolUsd = targetMc * poolSupplyPct / 100;
  if (poolUsd <= 0) return null;
  const pct = (bsUsd / poolUsd) * 100;
  if (!Number.isFinite(pct) || pct <= 0) return null;
  return pct;
}

// Refresh one pool's bootstrap supplyPercent from its stored solValue,
// then absorb the delta into the wide slices so positions total stays
// at 100%. Called from any path that can change the derived supplyPercent
// without changing user intent: targetMarketCap input, SOL price
// resolution, and the SOL input in customize mode itself.
//
// No-op when bootstrap is in minimal mode (no solValue to recompute)
// or when the recompute fails (missing mcap/price). In both cases the
// supplyPercent stays at whatever it was, so the total may drift —
// the warning indicator surfaces that to the user.
function recomputePoolBootstrapAndRebalance(pool) {
  if (!pool || !pool.bootstrapConfig || pool.bootstrapConfig.mode !== 'custom') return;
  const oldPct = Number(pool.bootstrapConfig.supplyPercent) || 0;
  const newPct = computeBootstrapSupplyPercent(
    pool.bootstrapConfig.solValue,
    Number(pool.supplyPercent),
  );
  if (newPct == null) return;
  pool.bootstrapConfig.supplyPercent = newPct;
  rebalanceWideSlicesByDelta(pool, newPct - oldPct);
}

// Translate the simple-UI support toggle into a per-pool supportConfig.
//
// Simple mode spreads the total support SOL equally across all pools —
// each pool gets totalSol / poolCount SOL of buy-side support sitting
// just below its launch price. This matches the bootstrap pattern (one
// launch-level SOL value, equal split per pool) and gives every pool a
// proportional buy wall so sellers routing into any pool find liquidity
// to land on.
//
// Customize mode reads per-pool support configs directly — users can
// tune each pool's solValue and depth independently from this simple
// derivation.
//
// Returns { mode: 'off' } when the toggle is off or any input is
// invalid. Returns the same mode/solValue/depthPct shape that
// customize-mode would produce, so rebuildPoolsFromSimple can use the
// result as-is without per-call special casing.
function deriveSupportConfigFromSimple(poolCount) {
  if (simpleConfig.mode !== 'default') return { mode: 'off' };
  if (!simpleConfig.supportEnabled) return { mode: 'off' };
  // Read the EFFECTIVE value (stored, clamped up to the auto-back
  // floor when applicable). Centralizing the clamp in
  // effectiveSupportSolValue() ensures the wire format and the inline
  // display always agree, regardless of render timing.
  const totalSol = effectiveSupportSolValue();
  if (!Number.isFinite(totalSol) || totalSol <= 0) return { mode: 'off' };
  // Defensive: callers should always pass a positive pool count, but
  // guarding here keeps the function safe if a refactor ever drops the
  // arg. Fallback to 1 pool (no division) so the user's intended SOL
  // value still lands somewhere rather than vanishing.
  const count = (Number.isFinite(poolCount) && poolCount > 0) ? poolCount : 1;
  const perPoolSol = totalSol / count;
  // Depth applies uniformly across all pools when derived from simple
  // mode. customize-mode users can edit each pool's depth separately.
  const depth = clampSupportDepth(simpleConfig.supportDepthPct);
  return { mode: 'custom', solValue: perPoolSol, depthPct: depth };
}

// Clamp a depth value into the supported [min, max] range, falling
// back to the default when the input is missing or non-finite. Used
// at every write/read site so an out-of-range value never reaches the
// backend (which has its own validation, but consistent UI defense
// keeps the user from seeing pre-flight errors for what should be a
// simple clamp).
function clampSupportDepth(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return SUPPORT_DEFAULT_DEPTH_PCT;
  return Math.max(SUPPORT_MIN_DEPTH_PCT, Math.min(SUPPORT_MAX_DEPTH_PCT, n));
}

// Compute the SOL value that would back a given preallocation percent at
// equal USD value. This is the "honest" support sizing — the buy wall
// can absorb exactly as much selling pressure as the preallocation
// could create if every preallocated token tried to dump at launch.
//
// Returns null when either input we need isn't available (no market cap
// entered yet, or no live SOL price). Callers should treat null as
// "can't recommend a value yet" and fall back to a sensible default
// (typically 1 SOL).
//
// Formula:
//   preallocUsd = (preallocPct / 100) × marketCapUsd
//   supportSol  = preallocUsd / solUsd
//
// Used both when auto-enabling support alongside preallocation, and
// when displaying the "recommended: X SOL" hint next to the support
// input so the user knows what would fully back their preallocation.
function recommendedSupportSolForPreallocation(preallocPct) {
  if (!Number.isFinite(preallocPct) || preallocPct <= 0) return null;
  const mcap = parseNumberInput(document.getElementById('targetMarketCap'));
  if (!Number.isFinite(mcap) || mcap <= 0) return null;
  // Live SOL price comes from the SOL pool's resolved info; falls back
  // to nothing rather than guessing, so we don't end up with a wildly
  // wrong recommendation when prices haven't resolved yet.
  const solPool = pools.find((p) => (p.quoteToken || '').toUpperCase() === 'SOL');
  const solUsd = solPool && Number(solPool.resolvedPriceUsd) > 0
    ? Number(solPool.resolvedPriceUsd) : null;
  if (!solUsd) return null;
  const preallocUsd = mcap * preallocPct / 100;
  return preallocUsd / solUsd;
}

// ============================================================================
// Airdrop helpers
// ============================================================================
//
// The airdrop sub-feature of preallocation lets the user supply a CSV of
// {wallet, sol_contributed} rows; we compute the token amount each
// wallet should receive at the launch starting price (= same USD value
// in tokens as they contributed in SOL).
//
// This whole feature is configured but not yet executed during a launch
// — the parsed list lives in simpleConfig.airdrop.parsedRows. A future
// step (after Burn & Earn) will perform the actual SPL transfers using
// this data; that work isn't in this file yet.

// Base58 alphabet check + length range. Real cryptographic validation
// (decode + ed25519 curve point check) requires @solana/web3.js, which
// isn't loaded in the browser. This regex catches typos and rejects
// any input with disallowed chars (most importantly the easy mix-ups:
// 0/O, I/l). The server will do full validation when the airdrop
// runs; this check is for catching obvious errors at config time.
//
// Solana addresses are 32-byte ed25519 public keys; in base58 that's
// almost always 43-44 chars, occasionally 42 if the key happens to
// start with leading zero bytes. We allow 32-44 to be generous — any
// shorter than 32 is definitely not a real key.
const SOL_BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
function isPlausibleSolAddress(s) {
  if (typeof s !== 'string') return false;
  return SOL_BASE58_RE.test(s.trim());
}

// Parse the user's airdrop CSV into structured rows. Format:
//   - First non-comment, non-blank line is the header: wallet,sol
//   - Subsequent rows are data: <address>,<sol_amount>
//   - Lines starting with # are comments (ignored)
//   - Blank lines are ignored
//   - Leading BOM (UTF-8) stripped
//   - Values may be quoted ("...") to allow commas inside (we strip)
//
// Returns { rows, error }:
//   rows: array of { wallet, sol, lineNumber } when successful
//   error: string when parsing failed; rows is empty in that case
//
// Errors include the 1-indexed line number where the problem occurred,
// so the user can locate the bad line in their source CSV.
function parseAirdropCsv(text) {
  if (!text || typeof text !== 'string') {
    return { rows: [], error: null }; // empty input isn't an error
  }
  // Strip BOM, normalize line endings.
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  const rows = [];
  const seenAddresses = new Set();
  let headerSeen = false;
  for (let i = 0; i < lines.length; i++) {
    const lineNumber = i + 1;
    const raw = lines[i];
    const trimmed = raw.trim();
    if (!trimmed) continue;                      // blank line
    if (trimmed.startsWith('#')) continue;       // comment

    // Split on the first comma only — addresses don't contain commas
    // but quoted SOL values theoretically could, and we'll strip quotes.
    const commaIdx = trimmed.indexOf(',');
    if (commaIdx < 0) {
      return {
        rows: [],
        error: `Line ${lineNumber}: missing comma (expected "wallet,sol")`,
      };
    }
    const left = trimmed.slice(0, commaIdx).trim().replace(/^"|"$/g, '');
    const right = trimmed.slice(commaIdx + 1).trim().replace(/^"|"$/g, '');

    if (!headerSeen) {
      // First content line should be the header. We're lenient about
      // exact wording — accept anything that looks like a header
      // (non-numeric right side) and use it as the header marker. This
      // way users who paste data directly without a header get a
      // helpful error rather than silent first-row consumption.
      const rightLooksNumeric = /^\d*\.?\d+$/.test(right);
      if (rightLooksNumeric) {
        return {
          rows: [],
          error: `Line ${lineNumber}: missing header row (expected "wallet,sol" as the first line)`,
        };
      }
      headerSeen = true;
      continue;
    }

    // Data row. Validate address and SOL amount.
    if (!isPlausibleSolAddress(left)) {
      return {
        rows: [],
        error: `Line ${lineNumber}: "${left.slice(0, 12)}${left.length > 12 ? '…' : ''}" is not a valid Solana address`,
      };
    }
    if (seenAddresses.has(left)) {
      return {
        rows: [],
        error: `Line ${lineNumber}: duplicate address (${left.slice(0, 8)}…) — each wallet must appear at most once`,
      };
    }
    seenAddresses.add(left);

    const sol = Number(right);
    if (!Number.isFinite(sol) || sol <= 0) {
      return {
        rows: [],
        error: `Line ${lineNumber}: "${right}" is not a positive SOL amount`,
      };
    }

    rows.push({ wallet: left, sol, lineNumber });
  }

  // A CSV with only a header (no data rows) isn't an error per se, but
  // it's almost certainly not what the user wanted. Surface that as a
  // soft message via parseError so they don't get a silent "0 rows"
  // preview.
  if (headerSeen && rows.length === 0) {
    return {
      rows: [],
      error: 'No data rows found (the CSV has a header but no wallet entries below it)',
    };
  }
  if (!headerSeen) {
    return {
      rows: [],
      error: 'No header row found (expected "wallet,sol" as the first line)',
    };
  }

  return { rows, error: null };
}

// Compute the token amount each parsed CSV row maps to, plus the USD
// equivalent of that token amount. Uses launch starting price:
//   start_price_usd_per_token = market_cap_usd / total_supply
//   tokens = (sol × SOL_USD) / start_price_usd_per_token
//          = (sol × SOL_USD × total_supply) / market_cap_usd
//
// usd is the USD value the contributor sent (sol × SOL_USD). At launch
// price, the token allocation is worth the same USD — the "fair value"
// rate. This is shown alongside the token count so the user can sanity-
// check the per-row magnitude.
//
// Returns { rows, totalTokens, totalUsd } where rows is the input with
// { tokens, usd } added. If marketCap, supply, or solUsd is missing/
// invalid, returns the input rows unchanged (tokens and usd are null)
// and the caller can show a "fill in supply / market cap first" hint.
function annotateAirdropRowsWithTokens(parsedRows) {
  const supply = parseNumberInput(document.getElementById('tokenSupply'));
  const mcap = parseNumberInput(document.getElementById('targetMarketCap'));
  const solPool = pools.find((p) => (p.quoteToken || '').toUpperCase() === 'SOL');
  const solUsd = solPool && Number(solPool.resolvedPriceUsd) > 0
    ? Number(solPool.resolvedPriceUsd) : null;

  // Without complete inputs we can still show the rows (wallet + sol)
  // but can't compute token allocations. annotate with null fields.
  const ready = Number.isFinite(supply) && supply > 0
    && Number.isFinite(mcap) && mcap > 0
    && solUsd != null;

  let totalTokens = 0;
  let totalUsd = 0;
  const rows = parsedRows.map((r) => {
    if (!ready) {
      return { ...r, tokens: null, usd: null };
    }
    const usd = r.sol * solUsd;
    const tokens = (r.sol * solUsd * supply) / mcap;
    totalTokens += tokens;
    totalUsd += usd;
    return { ...r, tokens, usd };
  });

  return { rows, totalTokens: ready ? totalTokens : null, totalUsd: ready ? totalUsd : null, ready };
}

// Check the airdrop against the preallocation supply budget.
//   budget tokens = total_supply × prealloc_pct / 100
// Returns a user-facing error string if over budget, or null if OK.
// Returns null too when we don't have enough inputs to compute the
// budget (caller handles "incomplete inputs" separately via annotate).
function airdropBudgetError(totalTokens) {
  if (totalTokens == null) return null;
  if (!simpleConfig.preallocationEnabled) {
    return 'Preallocation must be enabled to airdrop supply';
  }
  const supply = parseNumberInput(document.getElementById('tokenSupply'));
  const preallocPct = Number(simpleConfig.preallocationPercent) || 0;
  if (!Number.isFinite(supply) || supply <= 0 || preallocPct <= 0) return null;
  const budget = supply * preallocPct / 100;
  if (totalTokens > budget) {
    const overshoot = totalTokens - budget;
    const overshootPct = (overshoot / budget) * 100;
    return `Airdrop list needs ${formatTokenDisplay(totalTokens)} tokens but preallocation only holds ${formatTokenDisplay(budget)} ` +
           `(over by ${formatTokenDisplay(overshoot)}, ${overshootPct.toFixed(1)}%). ` +
           `Raise the preallocation % or reduce SOL amounts in the list.`;
  }
  return null;
}

// SOL cost to execute the airdrop transfers, in SOL. Returns 0 when
// airdrop is disabled or empty, so callers can always add this to the
// launch total without a special case.
//
// Cost model (per recipient):
//   - ATA rent exemption: ~0.00203928 SOL (canonical value for an
//     SPL token account; we assume creation since the launched token
//     is brand new so no recipient already has an ATA for it).
//   - Tx fee: 5000 lamports = 0.000005 SOL, amortized over the batch.
//
// Batching: we conservatively assume ~10 ATA-create + transfer pairs
// per transaction (the practical limit is higher but depends on
// instruction size; 10 is safely below the Solana transaction size
// cap of 1232 bytes for the typical ATA-create + transfer pattern).
//
// The actual on-chain execution uses per-recipient transactions (each
// recipient gets one tx with an idempotent ATA create + transferChecked).
// That's more conservative than the 10-per-tx batching modeled here:
// in practice the per-recipient SOL cost is the same (one ATA rent per
// recipient either way), but we pay one tx fee per recipient instead
// of one per batch. The estimate above is fractionally low by that
// margin; we leave it as-is because the safety buffer (10% on
// slippage/fee variance applied in the lpService cost estimator)
// already covers small overruns of this kind.
const AIRDROP_ATA_RENT_SOL = 0.00203928;
const AIRDROP_TX_FEE_SOL = 0.000005;
const AIRDROP_RECIPIENTS_PER_TX = 10;
function computeAirdropExecutionCostSol() {
  const airdrop = simpleConfig.airdrop;
  if (!airdrop || !airdrop.enabled || !simpleConfig.preallocationEnabled) return 0;
  const n = airdrop.parsedRows.length;
  if (n === 0) return 0;
  const numTxs = Math.ceil(n / AIRDROP_RECIPIENTS_PER_TX);
  return n * AIRDROP_ATA_RENT_SOL + numTxs * AIRDROP_TX_FEE_SOL;
}

// Build the airdrop payload to attach to the /api/transfer-assets POST.
// Returns null when no airdrop should run — caller can omit the field
// from the request body in that case and the server short-circuits.
//
// Conditions for an airdrop to run at transfer time:
//   1. We have a created-token mint to send (Step 4 completed).
//   2. Preallocation is enabled in simpleConfig.
//   3. Airdrop sub-feature is enabled with at least one parsed row.
//   4. We're in simple mode — customize mode has no airdrop UI, so
//      simpleConfig.airdrop state from a prior simple-mode session
//      shouldn't fire when the user is now configuring per-pool.
//
// All four conditions are needed: any one failing means there's
// nothing legitimate to airdrop.
function buildAirdropTransferPayload() {
  const live = buildLiveAirdropTransferPayload();
  if (live) return live;
  // Journal-restored fallback: when resuming a launch after an app
  // restart, the simple-mode airdrop config that feeds the live builder
  // is gone, but the plan was journaled at create-lp time and restored
  // by prepareRecoveredSessionFromJournal. The mint check pins the plan
  // to this exact token. The server independently skips any recipients
  // its journal already records as delivered, so replaying the full
  // plan here is safe even when the airdrop partially (or fully) ran
  // before the restart.
  if (restoredAirdropPayload
      && createdTokenInfo
      && createdTokenInfo.mint
      && restoredAirdropPayload.tokenMint === createdTokenInfo.mint
      && Array.isArray(restoredAirdropPayload.recipients)
      && restoredAirdropPayload.recipients.length > 0) {
    return restoredAirdropPayload;
  }
  return null;
}

// The live builder: reads the CURRENT simple-mode config. Split out so the
// journal-restored fallback above can wrap it without touching the logic.
function buildLiveAirdropTransferPayload() {
  if (!createdTokenInfo || !createdTokenInfo.mint) return null;
  if (simpleConfig.mode === 'customize') return null;
  if (!simpleConfig.preallocationEnabled) return null;
  const airdrop = simpleConfig.airdrop;
  if (!airdrop || !airdrop.enabled) return null;
  const rows = Array.isArray(airdrop.parsedRows) ? airdrop.parsedRows : [];
  if (rows.length === 0) return null;

  // Filter to rows with positive token amounts. annotateAirdropRowsWithTokens
  // sets tokens=null when inputs are incomplete (supply/mcap/SOL price
  // not ready); we skip those — they wouldn't be sent regardless and
  // including them would confuse the per-recipient retry logic later.
  const recipients = rows
    .filter((r) => Number.isFinite(Number(r.tokens)) && Number(r.tokens) > 0
      && typeof r.wallet === 'string' && r.wallet.length > 0)
    .map((r) => ({
      wallet: r.wallet,
      tokens: Number(r.tokens),
    }));
  if (recipients.length === 0) return null;

  return {
    tokenMint: createdTokenInfo.mint,
    tokenDecimals: createdTokenInfo.decimals,
    // Launched tokens are classic SPL (tokenService.js creates them with
    // TOKEN_PROGRAM_ID). The server defaults to false anyway but we
    // pass it explicitly so the wire format is self-describing.
    isToken2022: false,
    recipients,
  };
}

// Compute the preallocation percent the airdrop list NEEDS to fit. This
// is the airdrop's total tokens as a percent of total supply, ceil'd
// to one decimal so the % input doesn't show fiddly values like
// "12.5934567%". Returns null when we can't compute (airdrop off /
// empty / token amounts not yet ready / supply not entered).
//
// Used as the floor for auto-fit: the effective preallocation % is
// max(user_typed_percent, airdropRequiredPreallocationPercent()) when
// auto-fit is on.
function airdropRequiredPreallocationPercent() {
  const airdrop = simpleConfig.airdrop;
  if (!airdrop || !airdrop.enabled || !simpleConfig.preallocationEnabled) return null;
  if (!airdrop.parsedRows || airdrop.parsedRows.length === 0) return null;
  const supply = parseNumberInput(document.getElementById('tokenSupply'));
  if (!Number.isFinite(supply) || supply <= 0) return null;
  let totalTokens = 0;
  for (const r of airdrop.parsedRows) {
    if (r.tokens == null) return null; // inputs incomplete, can't compute
    totalTokens += r.tokens;
  }
  const requiredPct = (totalTokens / supply) * 100;
  if (!Number.isFinite(requiredPct) || requiredPct <= 0) return null;
  // Round UP to one decimal so we definitely cover the airdrop. The
  // percent input visually accepts integers but tolerates decimals
  // numerically; clamping to 99% (the input's max) prevents a runaway
  // airdrop from setting the prealloc above the input bound.
  const ceiled = Math.ceil(requiredPct * 10) / 10;
  return Math.min(99, ceiled);
}

// Recompute simpleConfig.preallocationPercent from the user's typed
// value (preallocationPercentInput) and the airdrop's required floor.
// This is the single chokepoint for the auto-fit logic — call it from
// every handler that could change either the typed value or the
// airdrop's required percentage:
//   - prealloc-% input keystrokes
//   - airdrop CSV changes
//   - token supply / market cap changes (affect airdrop required %)
//   - auto-fit toggle on/off
//   - airdrop enabled/disabled toggle
//
// Returns true if the effective percent changed, false if not (so
// callers can skip downstream refreshes when nothing changed). The
// effective percent is what every read site uses; the typed input
// is preserved separately on simpleConfig.preallocationPercentInput.
function recomputeEffectivePreallocationPercent() {
  // Fall back to the legacy preallocationPercent field when
  // preallocationPercentInput hasn't been initialized (e.g. older
  // saved configs, or first-render before the user has typed). This
  // ensures recompute doesn't silently zero out the user's value.
  const rawTyped = simpleConfig.preallocationPercentInput != null
    ? simpleConfig.preallocationPercentInput
    : simpleConfig.preallocationPercent;
  const typed = Number(rawTyped);
  const typedClamped = Math.max(0, Math.min(99,
    Number.isFinite(typed) ? typed : 0,
  ));
  // Also write back the clamped typed value so the field stays
  // canonical (next read sees the validated number).
  simpleConfig.preallocationPercentInput = typedClamped;
  let effective = typedClamped;
  if (simpleConfig.preallocationAutoFit) {
    const required = airdropRequiredPreallocationPercent();
    if (required != null && required > effective) {
      effective = required;
    }
  }
  const prev = Number(simpleConfig.preallocationPercent) || 0;
  simpleConfig.preallocationPercent = effective;
  return Math.abs(effective - prev) > 0.001;
}

// Mirror of recomputePoolBootstrapAndRebalance for support. Support has
// no derived supplyPercent (it's quote-only and doesn't carve from the
// pool's token supply), so this is purely a hook for UI refresh — it
// updates any cached display values that depend on the live SOL price.
// Currently a no-op at the data level since supportConfig only stores
// the user's canonical solValue input; the UI computes the USD-equivalent
// display value on each render.
function recomputePoolSupportAndRebalance(_pool) {
  // No-op. Reserved for future use if support gains derived state.
}

// Translate the simple-UI ladder controls into a per-pool ladderConfig.
//
// When the toggle is off (or we're in customize mode but
// rebuildPoolsFromSimple is somehow called), return { mode: 'off' }.
// When on, generate the bands for the user's chosen strategy using the
// SAME generator, gap, and ceiling-clamp that customize mode uses. The
// returned config is fully initialized — strategy, gap, ceiling,
// bandCount, and ladderPercent are all set — so switching into customize
// carries the bands through unchanged (ensureLadderStrategyConfig sees an
// initialized config and does not regenerate). That keeps the simple-mode
// depth-chart preview identical to what the user sees after customizing.
//
// Gap and ceiling are not exposed in the simple UI, so they take the
// design defaults: gap = LADDER_GAP_DEFAULT (the same 4× customize starts
// at) and ceiling = LADDER_CEILING_DEFAULT clamped down to the pool's
// honest max (CEILING_MAX_MCAP_USD / target market cap), exactly as
// poolMaxCeilingMultiplier does for customize. Reading the live market cap
// here is what keeps the clamp — and therefore the band ranges — in sync
// with customize; pools are rebuilt whenever the market cap changes, so
// the drift check stays accurate.
function deriveLadderConfigFromSimple() {
  if (simpleConfig.mode !== 'default') return { mode: 'off', bands: [] };
  if (!simpleConfig.ladderEnabled) return { mode: 'off', bands: [] };
  const supplyPercent = Math.max(
    LADDER_MIN_PERCENT,
    Math.min(LADDER_MAX_PERCENT, Number(simpleConfig.ladderPercent) || LADDER_DEFAULT_PERCENT),
  );
  const bandCount = Math.max(
    LADDER_MIN_BANDS,
    Math.min(LADDER_MAX_BANDS, Number(simpleConfig.ladderBandCount) || LADDER_DEFAULT_BANDS),
  );
  // Chosen volatility shape, falling back to the default if the stored
  // value is somehow not a known strategy id.
  const strategy = LADDER_STRATEGY_IDS.includes(simpleConfig.ladderStrategy)
    ? simpleConfig.ladderStrategy
    : LADDER_DEFAULT_STRATEGY;
  // Ceiling clamped to the pool's honest max, same as customize. We call
  // poolMaxCeilingMultiplier (which reads the live #targetMarketCap and
  // ignores its pool argument) when it's available; before it's defined
  // (it lives in a later module, so only at runtime) we fall back to the
  // raw default. Math.min means a low market cap pulls the ceiling down
  // and a high one leaves it at the default.
  const poolMax = (typeof poolMaxCeilingMultiplier === 'function')
    ? poolMaxCeilingMultiplier(null)
    : LADDER_CEILING_DEFAULT;
  const ceiling = Math.min(LADDER_CEILING_DEFAULT, poolMax);
  const gap = LADDER_GAP_DEFAULT;
  return {
    mode: 'manual',
    // Fully initialized so customize carries it through without
    // regenerating. ladderPercent is the authoritative share (customize
    // reads it directly rather than inferring it from the band sum).
    strategy,
    gap,
    ceiling,
    bandCount,
    ladderPercent: supplyPercent,
    bands: generateLadderStrategyBands({
      strategy,
      ladderPercent: supplyPercent,
      bandCount,
      gap,
      ceiling,
    }),
  };
}

// Render the simple-mode ladder depth-chart preview into #simpleLadderPreview.
//
// This is the simple-UI counterpart to updatePoolDepthChart: it charts the
// representative pool (the SOL pool, or the first pool if there's no SOL pool)
// using the same USD-notional and support scaling, so the preview is identical
// to what the user sees on that pool after switching to customize. Called after
// the pools are rebuilt (strategy / percent / band-count changes) and once on
// every simple-config render. Safe to call when the ladder is off, the
// container is absent, or no pool exists yet — in those cases it just empties
// and hides the container so it leaves no gap.
//
// computeDepthProfile and renderDepthChartSvg live in the depth-chart module,
// which is concatenated after this one; they're only referenced here at call
// time (runtime), so the forward reference is fine.
function updateSimpleLadderPreview() {
  const wrap = document.getElementById('simpleLadderPreview');
  if (!wrap) return;

  const hide = () => { wrap.innerHTML = ''; wrap.style.display = 'none'; };
  if (!simpleConfig.ladderEnabled) { hide(); return; }

  const pool = pools.find((p) => (p.quoteToken || '').toUpperCase() === 'SOL') || pools[0];
  if (!pool) { hide(); return; }
  if (typeof computeDepthProfile !== 'function' || typeof renderDepthChartSvg !== 'function') {
    hide();
    return;
  }

  // USD scaling so the quote-side support wall is comparable to the token-side
  // bands — the pool's notional is its share of the target market cap; support's
  // value is its SOL converted through the SOL pool's resolved price. Mirrors
  // updatePoolDepthChart exactly.
  const targetMc = parseNumberInput(document.getElementById('targetMarketCap'));
  const poolNotionalUsd = (Number(targetMc) > 0 && Number(pool.supplyPercent) > 0)
    ? (Number(pool.supplyPercent) / 100) * Number(targetMc)
    : 0;

  let support = null;
  const sc = pool.supportConfig;
  if (sc && sc.mode === 'custom' && Number(sc.solValue) > 0) {
    const solPool = pools.find((p) => (p.quoteToken || '').toUpperCase() === 'SOL');
    const solUsd = solPool && Number(solPool.resolvedPriceUsd) > 0 ? Number(solPool.resolvedPriceUsd) : null;
    if (solUsd) {
      support = {
        usd: Number(sc.solValue) * solUsd,
        depthPct: (typeof clampSupportDepth === 'function') ? clampSupportDepth(sc.depthPct) : (Number(sc.depthPct) || 30),
      };
    }
  }

  const profile = computeDepthProfile(pool, { poolNotionalUsd, support });
  // renderDepthChartSvg returns '' unless there's a ladder or a placeable
  // support wall; hide the empty container so it leaves no gap. compact trims
  // the caption and labels — the full explanation lives in customize mode.
  const html = profile ? renderDepthChartSvg(profile, { compact: true }) : '';
  wrap.innerHTML = html;
  wrap.style.display = html ? '' : 'none';
}

// Build the HTML body for the "Ladder strategies" info dialog — one entry per
// strategy (name, scenario tag, description), drawn from LADDER_STRATEGY_META
// so it stays in lockstep with the dropdown and the customize-mode picker.
// LADDER_STRATEGY_META lives in a later module but is only read here at call
// time, so the forward reference is fine.
function buildLadderStrategiesInfoHtml() {
  const intro = '<p style="margin-bottom: 0.75rem;">Each strategy is a different volatility shape — it spreads the same ladder supply across a different set of price ranges above launch. They all use the same allocation, band count, gap, and ceiling; only the placement and overlap of the bands changes. Pick the resistance / accumulation profile that fits your launch.</p>';
  const items = LADDER_STRATEGY_IDS.map((id) => {
    const meta = LADDER_STRATEGY_META[id] || { name: id, note: '' };
    const tag = meta.tag ? ` <span style="opacity: 0.7;">(${escapeHtml(meta.tag)})</span>` : '';
    return `<p style="margin-bottom: 0.6rem;"><strong>${escapeHtml(meta.name)}</strong>${tag}<br>${escapeHtml(meta.note || '')}</p>`;
  }).join('');
  return intro + items;
}

// Generate N log-spaced ladder bands covering [1×, ceiling×] with equal
// gap widths between bands. Each band is given an equal share of the
// total ladder supply. This is the math the backend's 'simple' mode
// used to do server-side; we do it client-side now so the bands are
// editable as manual-mode bands.
//
// Math: total log span = ln(ceiling), per-unit log = total/(2N-1)
// (N bands + N-1 gaps). Band i (0-indexed) covers
// [e^(2i × perUnit), e^((2i+1) × perUnit)].
function generateLogSpacedBands({ supplyPercent, bandCount, ceilingMultiplier }) {
  const perBandPct = supplyPercent / bandCount;
  const totalLog = Math.log(ceilingMultiplier);
  const perUnitLog = totalLog / (2 * bandCount - 1);
  const bands = [];
  for (let i = 0; i < bandCount; i++) {
    const lowerMul = Math.exp(2 * i * perUnitLog);
    const upperMul = Math.exp((2 * i + 1) * perUnitLog);
    bands.push({
      // toFixed → Number to bound trailing precision (the slider step
      // is 0.01, so 4 decimals is plenty for our needs).
      supplyPercent: Number(perBandPct.toFixed(4)),
      lowerMultiplier: Number(lowerMul.toFixed(4)),
      upperMultiplier: Number(upperMul.toFixed(4)),
    });
  }
  return bands;
}

// Strategy-based ladder generators for the Custom Positions editor. Each
// strategy is a "volatility shape": it lays single-sided token bands over
// [gap×, ceiling×] above launch, expressing where the ladder's supply should
// sit. Supply is NOT split equally across bands — each band's share is weighted
// to realise a rising depth profile (see the allocation block in
// generateLadderStrategyBands), which keeps supply out of the cheap near-launch
// range. The shapes differ in where the bands are placed and whether they
// overlap. Overlap is intentional for some shapes (inverse ramp, pyramid,
// multi-peak): the backend converts each band to ticks independently, and
// overlapping ranges stack into deeper, smoother resistance.
//
// All placement math is in log10(multiplier) space, since price ranges read
// naturally in decades (1×, 10×, 100×, …). The output is shaped exactly like
// generateLogSpacedBands so it drops straight into pool.ladderConfig.bands.
// Band widths (in log10 decades) for a "widening" ladder: `cnt` bands tiling
// `span` decades, each at least `minW` wide and each wider than the one below
// it. The widths grow geometrically by a factor chosen so they sum to `span`:
//   - Roomy span (few bands / wide ceiling): a true 2× per band (doubling),
//     because the first band is already ≥ minW.
//   - Tight span: relax the factor below 2 (bisection) so the first band still
//     clears minW while the bands still tile the span.
//   - Too tight to fit `cnt` bands even at the minimum: fall back to equal
//     widths (the gentlest fan we can manage for that many bands).
// This keeps the first band a sensible size instead of the hair-thin sliver
// that strict log-width doubling produces near launch for large band counts.
function wideningWidths(span, cnt, minW) {
  if (cnt <= 1) return [span];
  const wDbl = span / (Math.pow(2, cnt) - 1);
  if (wDbl >= minW) {
    const out = [];
    let w = wDbl;
    for (let i = 0; i < cnt; i++) { out.push(w); w *= 2; }
    return out;
  }
  if (minW * cnt >= span) return new Array(cnt).fill(span / cnt);
  // Solve (g^cnt − 1)/(g − 1) = span/minW for the growth factor g in (1, 2).
  const target = span / minW;
  const f = (g) => (Math.pow(g, cnt) - 1) / (g - 1);
  let lo = 1 + 1e-7;
  let hi = 2;
  for (let it = 0; it < 80; it++) { const g = (lo + hi) / 2; if (f(g) < target) lo = g; else hi = g; }
  const g = (lo + hi) / 2;
  const out = [];
  let w = minW;
  for (let i = 0; i < cnt; i++) { out.push(w); w *= g; }
  // Rescale away the tiny bisection drift so the widths sum to span exactly.
  const sum = out.reduce((a, b) => a + b, 0);
  return out.map((x) => (x * span) / sum);
}

// Layout for the Gapped Doubling shape: `cnt` widening bands tiling `span`
// decades with an air-pocket before each (gap = `gamma` × the preceding band's
// width). Same widening principle as wideningWidths, but the gaps consume part
// of the span, so the bands grow a little slower than they would with no gaps.
// First band floored at `minW`; growth fitted so bands + gaps fill the span.
// Returns { bands, gaps } in decades. Keeping the gap a fraction (not a full
// band width) leaves the bands enough room to visibly widen.
function gappedDoublingWidths(span, cnt, minW, gamma) {
  if (cnt <= 1) return { bands: [span], gaps: [] };
  // H(g) = total span (in units of the first band) consumed by bands + gaps
  // when widths grow by factor g.
  const H = (g) => {
    if (Math.abs(g - 1) < 1e-9) return cnt + gamma * (cnt - 1);
    return (Math.pow(g, cnt) - 1) / (g - 1) + (gamma * (Math.pow(g, cnt - 1) - 1)) / (g - 1);
  };
  const target = span / minW;
  let rho;
  let w0;
  if (H(2) <= target) { rho = 2; w0 = span / H(2); }       // roomy: doubling fits, first band ≥ minW
  else if (H(1) >= target) { rho = 1; w0 = span / H(1); }   // too tight: equal bands, first band < minW
  else {
    let lo = 1 + 1e-7;
    let hi = 2;
    for (let it = 0; it < 80; it++) { const g = (lo + hi) / 2; if (H(g) < target) lo = g; else hi = g; }
    rho = (lo + hi) / 2;
    w0 = minW;
  }
  const bands = [];
  const gaps = [];
  let w = w0;
  for (let i = 0; i < cnt; i++) { bands.push(w); if (i < cnt - 1) gaps.push(gamma * w); w *= rho; }
  // Rescale away drift so bands + gaps sum to span exactly.
  const totalW = bands.reduce((a, b) => a + b, 0) + gaps.reduce((a, b) => a + b, 0);
  const k = totalW > 0 ? span / totalW : 1;
  return { bands: bands.map((b) => b * k), gaps: gaps.map((g) => g * k) };
}

function generateLadderStrategyBands({ strategy, ladderPercent, bandCount, gap, ceiling }) {
  const n = Math.max(1, Math.round(Number(bandCount) || LADDER_DEFAULT_BANDS));
  const G = Math.max(1, Number(gap) || LADDER_GAP_DEFAULT);
  // Ceiling must sit comfortably above the gap or the ladder has no room to lay
  // out — clamp it up if the caller passed something too tight.
  const C = Math.max(G * 1.5, Number(ceiling) || LADDER_CEILING_DEFAULT);
  const pctIn = Number(ladderPercent);
  const ladderPct = Number.isFinite(pctIn) && pctIn > 0 ? pctIn : LADDER_DEFAULT_PERCENT;

  const log10 = (x) => Math.log(x) / Math.LN10;
  const pow10 = (e) => Math.pow(10, e);
  const s = log10(G);     // start of the ladder, in decades above launch
  const top = log10(C);   // ceiling, in decades
  const span = top - s;   // total decades the ladder spans

  // Each shape returns [{ lo, hi }] in multiplier units, always n bands total.
  const shapes = {
    // Doubling — discrete, non-overlapping bands that widen toward the ceiling.
    // Widths grow geometrically (a true 2× when the span allows it), but the
    // first band is floored to a sensible width rather than the hair-thin
    // sliver strict doubling would put at launch. Thin near launch, supply
    // fanned out toward the ceiling.
    dbl() {
      const widths = wideningWidths(span, n, log10(LADDER_MIN_BAND_RATIO));
      const out = [];
      let x = s;
      for (let i = 0; i < n; i++) { out.push({ lo: pow10(x), hi: pow10(x + widths[i]) }); x += widths[i]; }
      return out;
    },
    // Gapped Doubling — Doubling's widening bands, spaced out with an air-pocket
    // before each. The bands still widen toward the ceiling; the gaps (half a
    // band wide) sit between them as room for capitulation and fresh floors.
    gapdbl() {
      const { bands, gaps } = gappedDoublingWidths(span, n, log10(LADDER_MIN_BAND_RATIO), 0.5);
      const out = [];
      let x = s;
      for (let i = 0; i < n; i++) {
        out.push({ lo: pow10(x), hi: pow10(x + bands[i]) });
        x += bands[i];
        if (i < n - 1) x += gaps[i]; // air-pocket before the next band
      }
      return out;
    },
    // Inverse Ramp — overlapping bands that all reach the ceiling; lo steps up.
    // Depth builds toward the top, parking the most supply high.
    invramp() {
      const out = [];
      for (let i = 0; i < n; i++) out.push({ lo: pow10(s + (i * span) / n), hi: C });
      return out;
    },
    // Pyramid — staggered overlapping bands of equal width; depth peaks mid-range.
    pyr() {
      const st = span / (2 * n - 1);
      const W = n * st;
      const out = [];
      for (let i = 0; i < n; i++) out.push({ lo: pow10(s + i * st), hi: pow10(s + i * st + W) });
      return out;
    },
    // Multi-Peak — several humps spread across the full range. We split
    // [gap, ceiling] into `pk` equal sub-ranges and lay a small pyramid across
    // each, so depth peaks in pk places rather than one. Spanning the full range
    // (rather than a recentred slice) means the lowest band starts at the gap
    // and the highest reaches the ceiling — exactly like every other strategy.
    multi() {
      const pk = n >= 7 ? 3 : 2;
      const sizes = [];
      for (let p = 0; p < pk; p++) sizes.push(Math.floor(n / pk) + (p < (n % pk) ? 1 : 0));
      const subW = span / pk;
      const out = [];
      for (let p = 0; p < pk; p++) {
        const m = sizes[p];
        const a = s + p * subW;          // sub-range start
        const st = subW / (2 * m - 1);   // m=1 → st = subW (single full-width band)
        const W = m * st;
        for (let j = 0; j < m; j++) out.push({ lo: pow10(a + j * st), hi: pow10(a + j * st + W) });
      }
      return out;
    },
  };

  const shapeFn = shapes[strategy] || shapes[LADDER_DEFAULT_STRATEGY];
  const raw = shapeFn();
  const cnt = raw.length;

  // Guard each range first: lo ≥ 1 and hi strictly above lo (degenerate bands
  // get a hair of width), same bounds generateLogSpacedBands uses.
  const guarded = raw.map((b) => {
    const lo = Math.max(1, b.lo);
    const hi = b.hi > lo ? b.hi : lo * 1.0001;
    return { lo, hi };
  });

  // Per-band supply allocation. We deliberately do NOT split supply equally
  // across the bands. Equal supply over these ranges piles tradeable supply
  // just above launch — the bottom bands sit in a tiny price window, so a buyer
  // can sweep the majority of the ladder cheaply (the exact failure we're
  // guarding against), and the depth chart spikes into thin towers near launch.
  //
  // Instead we target a RISING liquidity-depth profile and back out the supply
  // each band needs to realise it. A position's chart depth over [lo,hi] is
  // supply ÷ (1/√lo − 1/√hi); so to place a relative depth d on a band we give
  // it supply ∝ d × (1/√lo − 1/√hi). Choosing d that rises with the band index
  // moves supply up into the higher, expensive-to-acquire ranges and flattens
  // the spikes. The rise is steeper for the supply-control strategies (inverse
  // ramp) and gentler for the easy-to-pump one (doubling); the others sit in
  // between and lean on their range geometry for their distinctive shape.
  const RISE = { dbl: 1, gapdbl: 1, invramp: 2, pyr: 1, multi: 1 };
  const exp = RISE[strategy] != null ? RISE[strategy] : 1;
  const depthCoef = (b) => (1 / Math.sqrt(b.lo) - 1 / Math.sqrt(b.hi)) || 1e-9;
  const weights = guarded.map((b, i) => Math.pow(i + 1, exp) * depthCoef(b));
  const wSum = weights.reduce((a, w) => a + w, 0) || 1;

  // Per-band floor so the weighting can never starve a band down to a dead,
  // not-worth-opening position. Capped at a third of the equal-split share so
  // the floors always leave the weighting room to work (and never sum above the
  // ladder's own share). With the floor reserved, the remainder is distributed
  // by weight — the two together always sum back to ladderPct.
  const sMin = Math.min(0.5, ladderPct / (3 * cnt));
  const distributable = Math.max(0, ladderPct - sMin * cnt);

  return guarded.map((b, i) => ({
    supplyPercent: Number((sMin + (distributable * weights[i]) / wSum).toFixed(4)),
    lowerMultiplier: Number(b.lo.toFixed(4)),
    upperMultiplier: Number(b.hi.toFixed(4)),
  }));
}

// Valid strategy ids in display order (Doubling is the default and first).
const LADDER_STRATEGY_IDS = ['dbl', 'gapdbl', 'invramp', 'pyr', 'multi'];
// otherwise re-render the simple config (and destroy the focused
// element) — typing into a numeric input fires that input's handler
// AND any async work (resolvePoolQuote completing, etc.) that wants
// to re-render. We suppress the re-render when focus is in the body
// so the user's typing isn't interrupted; the next render (triggered
// by blur or by a structural change like toggling a feature) catches
// up the displays.
//
// Implementation note: document.activeElement is a stable read in
// every browser; checking `body.contains(activeElement)` correctly
// returns false when focus is anywhere else on the page, including
// the page-level mcap/tokenSupply/lockPositions inputs (which live
// outside simpleConfigBody).
function isFocusInsideSimpleConfigBody() {
  const body = document.getElementById('simpleConfigBody');
  if (!body) return false;
  const focused = document.activeElement;
  if (!focused || focused === document.body) return false;
  return body.contains(focused);
}

// Debounce for rebuildPoolsFromSimple. Numeric inputs (preallocation %,
// support SOL, support depth) fire their handler on EVERY keystroke,
// and each rebuild fires resolvePoolQuote for each pool — which is
// cheap (cache hits) but pegs the event loop and produces visible
// work flicker (pool list re-renders, brief "resolving" states). A
// 250ms debounce collapses rapid typing into a single rebuild after
// the user pauses. We still call it synchronously on blur and on
// non-typing events (toggle changes, dropdown selects) so structural
// updates remain instant.
//
// The flush helper runs a rebuild immediately and clears any pending
// debounce — it's called from blur handlers and the Continue click
// to guarantee the pools reflect the user's latest input before any
// follow-on action (estimator call, mode switch, etc.).
let _rebuildDebounceHandle = null;
function rebuildPoolsFromSimpleDebounced() {
  if (_rebuildDebounceHandle != null) {
    clearTimeout(_rebuildDebounceHandle);
  }
  _rebuildDebounceHandle = setTimeout(() => {
    _rebuildDebounceHandle = null;
    rebuildPoolsFromSimple();
  }, 250);
}
function flushRebuildPoolsFromSimple() {
  if (_rebuildDebounceHandle != null) {
    clearTimeout(_rebuildDebounceHandle);
    _rebuildDebounceHandle = null;
  }
  // Always run the rebuild on flush, even if no debounce was pending.
  // Blur handlers and Continue clicks call flush as a "commit now"
  // signal — they need the pool state current, and a no-op flush
  // would let stale state slip through if (e.g.) the user typed and
  // then waited >250ms before blurring (debounce fired, no-op flush
  // is fine) versus typed and blurred immediately (debounce pending,
  // flush triggers it). The unconditional rebuild covers both paths.
  rebuildPoolsFromSimple();
}

// =============================================================
// Mode-aware prealloc/airdrop refresh helpers.
//
// The preallocation and airdrop handlers fire from BOTH modes —
// the same #preallocationBlock DOM is relocated between simple
// and customize containers, so the same handlers run regardless.
// But the right follow-on behavior differs:
//
//   SIMPLE mode: pool sizes are DERIVED from simpleConfig (the
//   flywheel split slider + preallocation %). A change to the
//   prealloc % means pool sizes change. rebuildPoolsFromSimple
//   regenerates pools from the new simpleConfig and renderSimpleConfig
//   rebuilds the whole config DOM to reflect derived state.
//
//   CUSTOMIZE mode: pool sizes are USER-SET. Each pool's
//   supplyPercent, fee tier, slice splits, ladder bands, etc. are
//   things the user typed. rebuildPoolsFromSimple here would
//   `pools.length = 0` and rebuild from the simple defaults —
//   destroying every customization. We must NOT do that. The
//   preallocation % is independent: it just tells the allocator
//   "hold back X% of total supply for the launch wallet" and
//   leaves the user's per-pool config alone.
//
// preallocRebuildIfApplicable: replaces rebuildPoolsFromSimple()
//   in prealloc/airdrop handlers. No-op in customize mode.
// preallocRerenderIfApplicable: replaces renderSimpleConfig() in
//   prealloc/airdrop handlers. In customize mode it refreshes the
//   inline prealloc displays (breakdown table, auto-fit hint,
//   in-place prealloc input value) without a full DOM rebuild,
//   which would lose focus and pool DOM state.
// =============================================================
function preallocRebuildIfApplicable() {
  if (simpleConfig.mode === 'customize') {
    // In customize mode pool sizes are user-controlled, not derived.
    // Skip the rebuild entirely.
    return;
  }
  rebuildPoolsFromSimple();
}
function preallocRebuildDebouncedIfApplicable() {
  if (simpleConfig.mode === 'customize') return;
  rebuildPoolsFromSimpleDebounced();
}
function preallocRerenderIfApplicable() {
  if (simpleConfig.mode === 'customize') {
    // Customize mode: refresh ONLY the parts of the page that depend
    // on preallocation/airdrop state. Don't call renderSimpleConfig
    // (which rebuilds the whole simple-config DOM and would force the
    // preallocation block to be re-built and re-relocated — losing
    // input focus and forcing a paint flash).
    //
    // The pool list itself stays put — user pool config is unaffected
    // by prealloc changes in this mode.
    if (typeof refreshSimplePreallocDisplayInline === 'function') {
      refreshSimplePreallocDisplayInline();
    }
    if (typeof refreshSimplePreallocAutoFitHint === 'function') {
      refreshSimplePreallocAutoFitHint();
    }
    if (typeof refreshAirdropDisplayInline === 'function') {
      refreshAirdropDisplayInline();
    }
    if (typeof refreshAirdropCostDisplays === 'function') {
      refreshAirdropCostDisplays();
    }
    if (typeof updateAllocationSummary === 'function') {
      updateAllocationSummary();
    }
    return;
  }
  renderSimpleConfig();
}

// Effective support SOL value — the stored value, clamped up to the
// auto-back floor when Auto-back is on and preallocation is enabled.
// This is the single source of truth for "what SOL value should we
// actually use right now?". Used by the inline display refresh, by
// deriveSupportConfigFromSimple (for the wire format), and by the
// render-time display computation in renderSimpleConfig. Keeping the
// clamp logic in one place avoids the prior bug where the floor was
// only applied at render time, leaving the wire format and inline
// displays stale during typing (when the focus guard skips render).
//
// Returns the stored value as-is if Auto-back is off, preallocation
// is off, or the recommended floor can't be computed (e.g. cold SOL
// price cache, no market cap entered yet).
function effectiveSupportSolValue() {
  const stored = Number(simpleConfig.supportSolValue) || 0;
  if (!simpleConfig.supportAutoSize || !simpleConfig.preallocationEnabled) {
    return stored;
  }
  const rec = recommendedSupportSolForPreallocation(
    Number(simpleConfig.preallocationPercent) || 0,
  );
  if (!Number.isFinite(rec) || rec <= 0) return stored;
  return rec > stored ? rec : stored;
}

// Standalone version of the in-render refreshSimpleSupportDisplay
// helper. Re-queries the DOM each call rather than closing over the
// element references, so it can be invoked from anywhere (e.g. from
// resolvePoolQuote's completion path when we want to refresh the
// display without doing a full re-render that would steal input
// focus). Safe to call when the simple config isn't rendered (the
// querySelector returns null and the function bails).
function refreshSimpleSupportDisplayInline() {
  const supportDisplay = document.getElementById('simpleSupportDisplay');
  if (!supportDisplay) return;
  const sp = pools.find((p) => (p.quoteToken || '').toUpperCase() === 'SOL');
  const solUsd = sp && Number(sp.resolvedPriceUsd) > 0 ? Number(sp.resolvedPriceUsd) : null;
  // Read the EFFECTIVE value (clamped to floor) so the display reflects
  // what's actually going to land in the wire format — not just what
  // the user has typed. During typing with Auto-back on, a value below
  // the floor still shows the floor's USD figure here, so the user
  // sees the honest buy-wall size.
  const sv = effectiveSupportSolValue();
  const dp = clampSupportDepth(simpleConfig.supportDepthPct);
  const usd = solUsd && sv > 0 ? sv * solUsd : null;

  let text;
  if (usd != null) {
    text = `≈ $${formatUsdRoughly(usd)} buy wall, launch to -${dp}%`;
  } else if (sv > 0) {
    text = `(USD value will show once SOL price resolves; range -${dp}%)`;
  } else {
    text = `single-sided quote liquidity covering -${dp}% below launch`;
  }

  if (simpleConfig.preallocationEnabled && usd != null) {
    const mcap = parseNumberInput(document.getElementById('targetMarketCap'));
    const pp = Number(simpleConfig.preallocationPercent) || 0;
    if (Number.isFinite(mcap) && mcap > 0 && pp > 0) {
      const preallocUsd = mcap * pp / 100;
      const coverage = preallocUsd > 0 ? usd / preallocUsd : 1;
      if (coverage >= 1) {
        text += ` · fully backs preallocation ✓`;
      } else {
        const pct = Math.round(coverage * 100);
        text += ` · backs ${pct}% of preallocation`;
      }
    }
  }
  supportDisplay.textContent = text;
}

// Same idea for the preallocation display — refresh the inline text
// values (token count, USD figure) without touching the input element
// the user is typing into. Reads target market cap and token supply
// from their page-level input elements; both live outside the simple
// config body so they survive any render.
function refreshSimplePreallocDisplayInline() {
  const preallocDisplay = document.getElementById('simplePreallocDisplay');
  if (!preallocDisplay) return;
  const tsi = parseNumberInput(document.getElementById('tokenSupply'));
  const tmi = parseNumberInput(document.getElementById('targetMarketCap'));
  const pp = Number(simpleConfig.preallocationPercent) || 0;
  const tk = Number.isFinite(tsi) && tsi > 0 && pp > 0 ? tsi * pp / 100 : null;
  const us = Number.isFinite(tmi) && tmi > 0 && pp > 0 ? tmi * pp / 100 : null;
  preallocDisplay.textContent = (tk != null && us != null)
    ? `≈ ${tk.toLocaleString(undefined, { maximumFractionDigits: 0 })} tokens · $${formatUsdRoughly(us)}`
    : (tk != null
        ? `≈ ${tk.toLocaleString(undefined, { maximumFractionDigits: 0 })} tokens`
        : (us != null
            ? `≈ $${formatUsdRoughly(us)}`
            : 'enter supply and market cap above to see values'));
}

// Update the auto-fit hint annotation next to the preallocation display.
// Shows "⇡ auto-fit: 10% → 20.1% to cover airdrop" when the effective
// preallocation % is higher than what the user typed (because the
// airdrop list demanded more). The input itself displays the effective
// value; this hint exists so the user understands that the input value
// is NOT their last-typed value but a transient auto-fit bump. Hidden
// when typed == effective or auto-fit is off.
function refreshSimplePreallocAutoFitHint() {
  const hint = document.getElementById('simplePreallocAutoFitHint');
  if (!hint) return;
  const autoFitOn = simpleConfig.preallocationAutoFit !== false;
  const typed = Number(simpleConfig.preallocationPercentInput) || 0;
  const eff = Number(simpleConfig.preallocationPercent) || 0;
  const raised = autoFitOn && simpleConfig.preallocationEnabled
    && Math.abs(eff - typed) > 0.05;
  if (raised) {
    // Tell the user the input value isn't their typed value — auto-fit
    // raised it. Showing both numbers (`from X% to Y%`) makes the gap
    // visible at a glance and signals "this is a transient bump; your
    // typed floor is preserved."
    hint.textContent = `⇡ auto-fit: ${typed}% → ${eff.toFixed(eff % 1 === 0 ? 0 : 1)}% to cover airdrop`;
    hint.style.display = '';
  } else {
    hint.style.display = 'none';
  }
}

// Format a SOL total with magnitude-appropriate precision. Avoids
// float-tail noise on small contributions (1.0000000001 SOL) and
// useless decimals on large totals (1,234.567 SOL).
function formatSolTotal(s) {
  if (!Number.isFinite(s) || s <= 0) return '0';
  if (s < 1) return s.toFixed(4);
  if (s < 1000) return s.toFixed(2);
  return s.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

// Truncate a base58 address with a middle ellipsis: first 6 chars,
// ellipsis, last 6 chars. Short enough to fit a table cell, distinctive
// enough that the user can verify against their CSV. The full address
// remains in simpleConfig.airdrop.parsedRows for execution.
function truncateAddressMiddle(s, head = 6, tail = 6) {
  if (typeof s !== 'string') return '';
  return s.length <= head + tail + 1 ? s : `${s.slice(0, head)}…${s.slice(-tail)}`;
}

// Build the airdrop sub-section's content (error notification + wallet/
// SOL totals line). NO per-wallet table — that lives in the unified
// preallocation breakdown table outside the airdrop panel. This helper
// is for the contents of [data-airdrop-results].
//
// Reads from simpleConfig.airdrop (parsedRows, parseError, budgetError)
// which the caller is responsible for populating before invoking.
function buildAirdropResultsHtml() {
  const airdrop = simpleConfig.airdrop;
  let totalTokens = 0;
  let totalReady = true;
  let totalSol = 0;
  for (const r of airdrop.parsedRows) {
    totalSol += r.sol;
    if (r.tokens == null) { totalReady = false; continue; }
    totalTokens += r.tokens;
  }
  const supply = parseNumberInput(document.getElementById('tokenSupply'));
  const pPct = Number(simpleConfig.preallocationPercent) || 0;
  const budgetTokens = (Number.isFinite(supply) && supply > 0 && pPct > 0)
    ? supply * pPct / 100 : null;
  const walletCountText = `${airdrop.parsedRows.length} wallet${airdrop.parsedRows.length === 1 ? '' : 's'}`;
  const solTotalText = `${formatSolTotal(totalSol)} SOL contributed`;
  const summaryLineHtml = (() => {
    if (airdrop.parsedRows.length === 0) return '';
    if (budgetTokens == null || !totalReady) {
      return `<p class="is-size-7 has-text-grey mt-2 mb-0">${walletCountText} · ${solTotalText} (enter supply, market cap, and let SOL price resolve to see token amounts)</p>`;
    }
    const usedPct = (totalTokens / budgetTokens) * 100;
    const colorClass = airdrop.budgetError ? 'has-text-danger' : 'has-text-success';
    return `<p class="is-size-7 mt-2 mb-0 ${colorClass}">
      ${walletCountText} · ${solTotalText} · ${formatTokenDisplay(totalTokens)} of ${formatTokenDisplay(budgetTokens)} budget tokens (${usedPct.toFixed(1)}%)
    </p>`;
  })();
  const errorHtml = (() => {
    const err = airdrop.parseError || airdrop.budgetError;
    if (!err) return '';
    return `<div class="notification is-danger is-light py-2 px-3 mt-2 mb-0 is-size-7">
      <strong>⚠</strong> ${escapeHtml(err)}
    </div>`;
  })();
  // Soft duration warning for very large lists. No cap — the airdrop runs
  // sequentially (pacing + per-tx confirmation), so a big list is purely a
  // time commitment, and that's the user's call. ~4s/recipient matches the
  // estimate runTransfer logs at execution time.
  const sizeWarningHtml = (() => {
    const n = airdrop.parsedRows.length;
    if (n <= 1000) return '';
    const estMinutes = Math.ceil((n * 4) / 60);
    return `<div class="notification is-warning is-light py-2 px-3 mt-2 mb-0 is-size-7">
      <strong>⚠</strong> ${n.toLocaleString()} recipients is a lot — the airdrop sends
      one transaction per wallet and will take roughly ${estMinutes} minutes during the
      final transfer. The app must stay open the whole time. Delivery is tracked
      per-recipient, so if anything interrupts it, a retry only sends to wallets
      that haven't received theirs yet.
    </div>`;
  })();
  return errorHtml + sizeWarningHtml + summaryLineHtml;
}

// Render (or hide) the pre-transfer airdrop summary panel in step 6.
// Shows BEFORE the user clicks Transfer Assets so the airdrop step isn't
// a surprise. Safe to call anytime — it derives state from
// buildAirdropTransferPayload() and bails to "hidden" when no airdrop
// payload is currently warranted (no preallocation, customize mode,
// empty CSV, etc).
//
// Triggered from activateStep when entering step 6 and from runTransfer
// after a successful sweep clears the panel out of the way.
function renderAirdropPreTransferSummary() {
  const panel = document.getElementById('airdropPreTransferSummary');
  if (!panel) return;
  const payload = buildAirdropTransferPayload();
  if (!payload || !payload.recipients || payload.recipients.length === 0) {
    panel.classList.add('hidden');
    return;
  }
  panel.classList.remove('hidden');
  const n = payload.recipients.length;
  const totalTokens = payload.recipients.reduce(
    (s, r) => s + (Number(r.tokens) || 0), 0,
  );
  const fmtTokens = (v) => Number(v).toLocaleString(
    undefined, { maximumFractionDigits: 4 },
  );

  const countEl = document.getElementById('airdropPreCount');
  if (countEl) countEl.textContent = String(n);
  const sEl = document.getElementById('airdropPreCountS');
  if (sEl) sEl.textContent = n === 1 ? '' : 's';
  const tokensEl = document.getElementById('airdropPreTokens');
  if (tokensEl) tokensEl.textContent = fmtTokens(totalTokens);

  const list = document.getElementById('airdropPreRecipientList');
  if (list) {
    list.innerHTML = payload.recipients.map((r) => {
      const wAddr = String(r.wallet || '');
      const tokens = fmtTokens(r.tokens);
      // <code> for semantic correctness — wallet addresses are
      // code-like identifiers. The global CSS gives <code> a subtle
      // parchment-tinted background (not Bulma's default stark white)
      // that fits the theme. Full address (no truncation): there's
      // plenty of room here, and showing 44 chars lets the user
      // visually verify rather than trusting a 6+6 truncation that
      // can collide between similar-prefix wallets.
      return `<div class="is-size-7" style="margin: 0.15rem 0; word-break: break-all;">
        <code style="font-size: 11px;">${escapeHtml(wAddr || '—')}</code>
        <span class="has-text-grey"> · </span>
        ${escapeHtml(tokens)} tokens
      </div>`;
    }).join('');
  }
}

function hideAirdropPreTransferSummary() {
  const panel = document.getElementById('airdropPreTransferSummary');
  if (panel) panel.classList.add('hidden');
}

// Build the unified "Where does the preallocation go?" breakdown table.
// Lives directly under the preallocation row, ABOVE the airdrop sub-
// section. Three render variants:
//
//   - Preallocation OFF: returns empty string (table not shown).
//   - Preallocation ON, no airdrop (or airdrop disabled / empty rows):
//     single "Launch wallet" row holding the entire preallocation, plus
//     the total row.
//   - Preallocation ON, airdrop enabled with rows:
//     "Airdrop (N wallets)" collapsible row showing the airdrop total,
//     "Launch wallet" row with the leftover, and the total row. When the
//     airdrop row is expanded (controlled by simpleConfig.airdrop
//     ._breakdownExpanded), the per-wallet rows render beneath it.
//
// Returns just the inner <table> contents — caller wraps in any
// container needed. Empty string when there's nothing to show.
function buildPreallocationBreakdownHtml() {
  if (!simpleConfig.preallocationEnabled) return '';

  const supply = parseNumberInput(document.getElementById('tokenSupply'));
  const mcap = parseNumberInput(document.getElementById('targetMarketCap'));
  const pPct = Number(simpleConfig.preallocationPercent) || 0;
  if (!Number.isFinite(supply) || supply <= 0 || pPct <= 0) {
    // Without supply / prealloc%, we can't compute concrete numbers.
    // Show a gentle prompt rather than an empty section.
    return `<p class="is-size-7 has-text-grey mt-2 mb-0">
      Enter supply above to see the preallocation breakdown.
    </p>`;
  }
  const totalTokens = supply * pPct / 100;
  const totalUsd = Number.isFinite(mcap) && mcap > 0 ? mcap * pPct / 100 : null;

  // Format helpers used in every row, hoisted here so we don't re-define
  // them across the branches below.
  const fmtTokens = (n) => n.toLocaleString(undefined, { maximumFractionDigits: 0 });
  const fmtPct = (n) => n.toFixed(2) + '%';
  const fmtUsd = (n) => n != null ? `$${formatUsdRoughly(n)}` : '<span class="has-text-grey">—</span>';

  const airdrop = simpleConfig.airdrop;
  const airdropActive = airdrop.enabled && airdrop.parsedRows.length > 0;

  // Compute airdrop totals only when actually active. Otherwise the
  // whole preallocation is "leftover" sitting in the launch wallet.
  let airdropTokens = 0;
  let airdropTokensReady = true;
  let airdropSol = 0;
  if (airdropActive) {
    for (const r of airdrop.parsedRows) {
      airdropSol += r.sol;
      if (r.tokens == null) { airdropTokensReady = false; continue; }
      airdropTokens += r.tokens;
    }
  }

  // When over-budget, the displayed table clamps the airdrop row to
  // the budget (per UX decision — show what would actually happen,
  // not a negative leftover row). The error message above the table
  // surfaces the overage. When the airdrop row's token total is
  // unknown (incomplete inputs), the leftover can't be computed
  // either — show "—" for both.
  const airdropTokensDisplay = airdropTokensReady
    ? Math.min(airdropTokens, totalTokens)
    : null;
  const leftoverTokens = airdropTokensReady
    ? Math.max(0, totalTokens - airdropTokens)
    : null;
  const airdropPct = (airdropTokensDisplay != null && totalTokens > 0)
    ? (airdropTokensDisplay / supply) * 100 : null;
  const leftoverPct = (leftoverTokens != null && supply > 0)
    ? (leftoverTokens / supply) * 100 : null;
  const airdropUsd = (airdropPct != null && Number.isFinite(mcap) && mcap > 0)
    ? mcap * airdropPct / 100 : null;
  const leftoverUsd = (leftoverPct != null && Number.isFinite(mcap) && mcap > 0)
    ? mcap * leftoverPct / 100 : null;

  // Build per-wallet rows for the expanded airdrop section. Each row is
  // a <tr> with a leading indent (left padding) to visually nest under
  // the airdrop summary row. Initial visibility tracks the persisted
  // _breakdownExpanded state so re-renders don't collapse a row group
  // the user just opened. The click handler toggles both the state
  // and the display style.
  const initialWalletRowDisplay = airdrop._breakdownExpanded ? '' : 'none';
  const MAX_WALLET_ROWS = 10;
  const walletRowsHtml = airdropActive
    ? airdrop.parsedRows.slice(0, MAX_WALLET_ROWS).map((r) => {
        const tokensCell = r.tokens != null ? fmtTokens(r.tokens) : '<span class="has-text-grey">—</span>';
        const pctCell = (r.tokens != null && supply > 0)
          ? fmtPct((r.tokens / supply) * 100)
          : '<span class="has-text-grey">—</span>';
        const usdCell = r.usd != null ? `$${formatUsdRoughly(r.usd)}` : '<span class="has-text-grey">—</span>';
        return `<tr data-airdrop-wallet-row style="display: ${initialWalletRowDisplay};">
          <td class="is-family-monospace is-size-7" style="padding-left: 2.25rem;">${escapeHtml(truncateAddressMiddle(r.wallet))}
            <span class="has-text-grey is-size-7 ml-2">${r.sol} SOL</span></td>
          <td class="has-text-right">${tokensCell}</td>
          <td class="has-text-right has-text-grey is-size-7">${pctCell}</td>
          <td class="has-text-right has-text-grey is-size-7">${usdCell}</td>
        </tr>`;
      }).join('')
    : '';
  const moreRowsCount = airdropActive
    ? Math.max(0, airdrop.parsedRows.length - MAX_WALLET_ROWS)
    : 0;
  const moreRowsHtml = moreRowsCount > 0
    ? `<tr data-airdrop-wallet-row style="display: ${initialWalletRowDisplay};">
        <td colspan="4" class="has-text-grey has-text-centered is-size-7" style="padding-left: 2.25rem;">
          <em>… and ${moreRowsCount} more recipient${moreRowsCount === 1 ? '' : 's'} (full list will be processed at distribution time)</em>
        </td>
      </tr>`
    : '';

  // Airdrop summary row — clickable, with a chevron that rotates when
  // expanded. The chevron's state is tracked via
  // simpleConfig.airdrop._breakdownExpanded so it survives re-renders.
  // Click handler in renderSimpleConfig toggles the data-* attribute
  // and the wallet-row display.
  const chevronClass = airdrop._breakdownExpanded ? 'fa-chevron-down' : 'fa-chevron-right';
  const airdropSummaryRowHtml = airdropActive
    ? `<tr data-airdrop-summary-row class="is-clickable" style="cursor: pointer;">
        <td>
          <span class="icon is-small mr-1" style="transition: transform 0.15s;"><i class="fas ${chevronClass}"></i></span>
          <strong>Airdrop</strong>
          <span class="has-text-grey is-size-7 ml-1">(${airdrop.parsedRows.length} wallet${airdrop.parsedRows.length === 1 ? '' : 's'} · ${formatSolTotal(airdropSol)} SOL)</span>
        </td>
        <td class="has-text-right">${airdropTokensDisplay != null ? fmtTokens(airdropTokensDisplay) : '<span class="has-text-grey">—</span>'}</td>
        <td class="has-text-right has-text-grey is-size-7">${airdropPct != null ? fmtPct(airdropPct) : '<span class="has-text-grey">—</span>'}</td>
        <td class="has-text-right has-text-grey is-size-7">${fmtUsd(airdropUsd)}</td>
      </tr>`
    : '';

  // Launch wallet row — shows the leftover (or the full preallocation
  // when airdrop isn't active). The hint text differs by case so the
  // user understands what these tokens are for.
  const launchWalletTokens = airdropActive ? leftoverTokens : totalTokens;
  const launchWalletPct = airdropActive ? leftoverPct : pPct;
  const launchWalletUsd = airdropActive ? leftoverUsd : totalUsd;
  const launchWalletHint = airdropActive
    ? 'unallocated — held in launch wallet for manual distribution after launch'
    : 'held in launch wallet for manual distribution after launch';
  const launchWalletRowHtml = `
    <tr>
      <td>
        <strong>Launch wallet</strong>
        <span class="has-text-grey is-size-7 ml-2">${launchWalletHint}</span>
      </td>
      <td class="has-text-right">${launchWalletTokens != null ? fmtTokens(launchWalletTokens) : '<span class="has-text-grey">—</span>'}</td>
      <td class="has-text-right has-text-grey is-size-7">${launchWalletPct != null ? fmtPct(launchWalletPct) : '<span class="has-text-grey">—</span>'}</td>
      <td class="has-text-right has-text-grey is-size-7">${fmtUsd(launchWalletUsd)}</td>
    </tr>
  `;

  // Total row — boldface, no hint text. Matches the funding breakdown
  // table style on step 3 (`has-text-weight-bold` plus monospace
  // numbers via the existing td styling).
  const totalRowHtml = `
    <tr class="has-text-weight-bold" style="border-top: 1px solid var(--rule, rgba(28,22,16,0.15));">
      <td>Total preallocation</td>
      <td class="has-text-right">${fmtTokens(totalTokens)}</td>
      <td class="has-text-right">${fmtPct(pPct)}</td>
      <td class="has-text-right">${fmtUsd(totalUsd)}</td>
    </tr>
  `;

  return `
    <table class="table is-narrow is-fullwidth is-size-7 mt-2 mb-0" style="background: transparent;">
      <thead>
        <tr>
          <th>Recipient</th>
          <th class="has-text-right">Tokens</th>
          <th class="has-text-right">% of supply</th>
          <th class="has-text-right">≈ USD</th>
        </tr>
      </thead>
      <tbody>
        ${airdropSummaryRowHtml}
        ${walletRowsHtml}
        ${moreRowsHtml}
        ${launchWalletRowHtml}
        ${totalRowHtml}
      </tbody>
    </table>
  `;
}

// Re-parse the airdrop CSV and re-render the results area in place
// (without re-rendering the whole simple-config — that would steal
// focus from the textarea). Called from the textarea/file/clear
// handlers, and also from the prealloc-% input handler since changing
// the prealloc % changes the budget and may flip the budget verdict.
function refreshAirdropDisplayInline() {
  const details = document.getElementById('simpleAirdropDetails');
  if (!details) return;
  const airdrop = simpleConfig.airdrop;

  // Step 1: parse + annotate. parsedRows feeds both the budget check
  // and the auto-fit floor calculation. Annotation adds per-row token
  // amounts based on supply / market cap / SOL price; rows without
  // those inputs land as { tokens: null, usd: null }.
  const parse = parseAirdropCsv(airdrop.csvText || '');
  const annotated = annotateAirdropRowsWithTokens(parse.rows);
  airdrop.parsedRows = annotated.rows;
  airdrop.parseError = parse.error;

  // Step 2: recompute the effective preallocation %. Auto-fit reads
  // parsedRows we just populated above; without this step running
  // BEFORE the budget check, the budget would test against the stale
  // pre-CSV percentage and fire a false "over budget" error even when
  // auto-fit has already raised the budget to accommodate.
  const effChanged = recomputeEffectivePreallocationPercent();

  // Step 3: now check the budget against the freshly-computed
  // effective %. With auto-fit on this almost never fires; with
  // auto-fit off it surfaces the over-budget condition for the user
  // to fix manually.
  airdrop.budgetError = airdropBudgetError(annotated.totalTokens);

  // Step 4: cascade auto-fit side-effects (support SOL, prealloc
  // display, hint, pool rebuild) if the effective % moved.
  if (effChanged) {
    // Cascade auto-fit side-effects (support SOL, prealloc display,
    // hint, pool rebuild). Customize-mode guard: skip the simple-mode
    // support-side-effects and the destructive pool rebuild. The
    // inline display refreshers (support display, prealloc display)
    // are safe no-ops when their target elements aren't visible.
    if (simpleConfig.mode !== 'customize') {
      if (simpleConfig.preallocationEnabled && simpleConfig.supportAutoSize) {
        const recommendedSol = recommendedSupportSolForPreallocation(
          simpleConfig.preallocationPercent,
        );
        if (recommendedSol != null && recommendedSol > 0
            && recommendedSol > (Number(simpleConfig.supportSolValue) || 0)) {
          simpleConfig.supportSolValue = recommendedSol;
        }
      }
    }
    // Push the new effective percent into the % input element itself
    // so the user sees the value that's actually in use. We preserve
    // the user's last-typed value separately on
    // simpleConfig.preallocationPercentInput — when the airdrop is
    // trimmed and the effective drops back below the typed floor,
    // the input will display the typed floor again.
    //
    // Guard: don't write the input value if the user is currently
    // focused there typing. Clobbering a focused field would steal
    // their input mid-keystroke. The auto-fit hint annotation gives
    // them a separate signal in that case.
    const pctInputEl = document.getElementById('simplePreallocPctInput');
    if (pctInputEl && document.activeElement !== pctInputEl) {
      const eff = Number(simpleConfig.preallocationPercent) || 0;
      pctInputEl.value = eff.toFixed(eff % 1 === 0 ? 0 : 1);
    }
    // Same trick for the support SOL input — the cascade may have bumped
    // simpleConfig.supportSolValue (auto-back raising the floor to back
    // the new preallocation %). Without pushing the new value back to
    // the input element here, the user sees a stale number in the
    // support field while the "$X buy wall" display text correctly
    // reflects the new value — a confusing contradiction.
    //
    // Same focus guard as above: don't clobber the user's in-progress
    // typing. The refreshSimpleSupportDisplayInline call below updates
    // the secondary "$X buy wall" text either way.
    if (simpleConfig.mode !== 'customize') {
      const supportSolEl = document.getElementById('simpleSupportSolInput');
      if (supportSolEl && simpleConfig.supportAutoSize
          && document.activeElement !== supportSolEl) {
        const sv = Number(simpleConfig.supportSolValue) || 0;
        supportSolEl.value = sv.toFixed(Math.abs(sv) >= 10 ? 1 : 3);
      }
    }
    refreshSimplePreallocDisplayInline();
    refreshSimplePreallocAutoFitHint();
    refreshSimpleSupportDisplayInline();
    // Customize-mode guard: rebuildPoolsFromSimpleDebounced would
    // schedule a destructive rebuild that wipes user pool customizations
    // when it fires 250ms later. Use the mode-aware helper instead.
    preallocRebuildDebouncedIfApplicable();
    // Auto-fit raised the effective preallocation %, which raised the
    // auto-back support SOL, which raises the server-side cost estimate
    // (more SOL committed to the support position = more SOL the user
    // must fund). The pool-rebuild above schedules in 250ms; we also
    // need to schedule a fresh cost-preview fetch so _lastCostEstimate
    // updates. Without this, refreshAirdropCostDisplays at the bottom
    // of this function would refresh the displayed total using the
    // STALE _lastCostEstimate.totalSol, and the user wouldn't see the
    // support bump until something else triggered a fetch (toggling
    // prealloc — which is exactly the workaround the user reported).
    if (typeof requestCostPreviewUpdate === 'function') {
      requestCostPreviewUpdate();
    }
  }

  // Step 5: render the file name placeholder + clear button state.
  const fileName = document.getElementById('simpleAirdropFileName');
  if (fileName) {
    fileName.textContent = airdrop.csvText
      ? `${airdrop.parsedRows.length} row${airdrop.parsedRows.length === 1 ? '' : 's'} loaded`
      : 'no file chosen';
  }
  const clearBtn = document.getElementById('simpleAirdropClearBtn');
  if (clearBtn) {
    clearBtn.disabled = !airdrop.csvText;
  }

  // Step 6: render the airdrop results panel (error + summary line).
  // Reads airdrop.budgetError which we set in step 3 against the
  // post-auto-fit effective %.
  const interior = details.querySelector('[data-airdrop-results]');
  if (interior) {
    interior.innerHTML = buildAirdropResultsHtml();
  }

  // Step 7: render the breakdown table. Reads the effective preallo­
  // cation % and the parsed airdrop rows; both have been updated by
  // the steps above.
  const breakdownContainer = document.querySelector('[data-prealloc-breakdown]');
  if (breakdownContainer) {
    breakdownContainer.innerHTML = buildPreallocationBreakdownHtml();
  }

  // Step 8: refresh the displayed cost. Airdrop execution cost (ATA
  // rent + tx fees) rolls into the Est. Cost shown on the token
  // preview card AND the cost preview card. Both surfaces need to
  // track row-count changes.
  refreshAirdropCostDisplays();
}

// Push the current airdrop execution cost into the two on-screen cost
// surfaces (preview card's Est. Cost tile, and the cost preview card
// below the form). Both add the airdrop cost on top of the server's
// launch funding estimate. Safe to call any time — no-op when
// _lastCostEstimate hasn't arrived yet (cost preview card stays in
// whatever state it was; updatePreviewStats handles its own missing-
// data case).
//
// Used as the single chokepoint for "airdrop changed, refresh displayed
// cost" so the airdrop toggle, CSV edits, and any future trigger can
// all funnel through the same path. Without this, each new trigger
// would need to remember to call both updatePreviewStats and
// setCostPreviewState individually.
function refreshAirdropCostDisplays() {
  if (typeof updatePreviewStats === 'function') {
    updatePreviewStats();
  }
  if (_lastCostEstimate && Number.isFinite(_lastCostEstimate.totalSol)
      && typeof setCostPreviewState === 'function') {
    const airdropExecutionSol = computeAirdropExecutionCostSol();
    setCostPreviewState('ready', _lastCostEstimate.totalSol + airdropExecutionSol);
  }
}

// Paint the simple-config UI into #simpleConfigBody. Called whenever
// simpleConfig changes or when switching mode. Uses textContent /
// dataset on the elements we listen to, but constructs them with
// innerHTML for terseness — none of the values are user-controlled
// strings, so injection isn't a concern.
function renderSimpleConfig() {
  const body = document.getElementById('simpleConfigBody');
  if (!body) return;

  // Preserve the page scroll position across the full innerHTML rebuild
  // below. This section is wiped and rebuilt on every toggle; while
  // body.innerHTML is momentarily empty the page collapses to a shorter
  // height, the browser clamps the scroll offset to the new (smaller)
  // maximum, and it is not restored when the content re-expands — so the
  // page lurches. It's most visible with a tall section (preallocation +
  // airdrop loaded) and a control toggled near the bottom (ladder, split).
  // Capturing the offset here and restoring it at the end of this function
  // pins the view so the control the user just clicked stays put.
  const _scroller = document.scrollingElement || document.documentElement;
  const _savedScrollTop = _scroller.scrollTop;

  // Detach the Lock-liquidity field (if it's currently inside body
  // from a prior render) before we wipe body.innerHTML. The field is
  // a single canonical DOM element that lives at #lockPositionsField,
  // physically moved between simple-mode and customize-mode slots by
  // applySimpleConfigMode + relocateLockPositionsField. Without this
  // detach, body.innerHTML='...' would destroy the element along with
  // its event listeners and state, breaking the toggle.
  //
  // We move it temporarily to its page-level home; the post-render
  // relocateLockPositionsField call moves it back into the new slot
  // inside the freshly-rendered Advanced details.
  const lockField = document.getElementById('lockPositionsField');
  const pageHome = document.getElementById('lockPositionsSlotPage');
  if (lockField && pageHome && lockField.parentElement !== pageHome) {
    pageHome.appendChild(lockField);
  }

  // Defensive: remove any existing #preallocationBlock from the DOM
  // before rebuilding. Unlike lockField (which is a long-lived element
  // with persistent state we want to preserve), the preallocation
  // block's contents are entirely state-driven — renderSimpleConfig
  // will build a fresh block with fresh handlers as part of the
  // innerHTML below. Without this cleanup, a previously-relocated
  // block (e.g. moved to #customizePreallocSlot when the user was in
  // customize mode) would persist after the rebuild and create
  // duplicate IDs, breaking getElementById calls in refresh paths.
  document.querySelectorAll('#preallocationBlock').forEach((b) => b.remove());

  // Defensive: if simpleConfig.flywheelKey points at an unavailable
  // flywheel (e.g. someone re-flagged 'reserve' as unavailable, or a
  // future session-restore path loaded a stale key), fall back to the
  // first available one. Without this, the dropdown would render with
  // a disabled option pre-selected, which is awkward and confusing.
  const currentFw = FLYWHEELS[simpleConfig.flywheelKey];
  if (!currentFw || !currentFw.available) {
    const firstAvailable = Object.values(FLYWHEELS).find((fw) => fw.available);
    if (firstAvailable) {
      simpleConfig.flywheelKey = firstAvailable.key;
    }
  }

  // Build the list of <option> entries from FLYWHEELS, marking
  // unavailable ones as disabled so users see them but can't pick them.
  const options = Object.values(FLYWHEELS).map((fw) => {
    const selected = fw.key === simpleConfig.flywheelKey ? 'selected' : '';
    const disabled = !fw.available ? 'disabled' : '';
    return `<option value="${escapeHtml(fw.key)}" ${selected} ${disabled}>${escapeHtml(fw.label)}</option>`;
  }).join('');

  const dropdownDisabled = !simpleConfig.flywheelEnabled ? 'disabled' : '';
  const checked = simpleConfig.flywheelEnabled ? 'checked' : '';
  // Slider value — clamp at render time too, in case anything pushed it
  // out of range. The defensive clamp in rebuildPoolsFromSimple is the
  // ultimate authority but it's nicer if the UI shows the right number.
  const sliderValue = Math.max(
    FLYWHEEL_MIN_PERCENT,
    Math.min(FLYWHEEL_MAX_PERCENT, Number(simpleConfig.flywheelPercent) || DEFAULT_FLYWHEEL_PERCENT),
  );

  // Split-LP state. Slider value clamped here too — same belt-and-
  // suspenders rationale as the flywheel slider above.
  const splitChecked = simpleConfig.splitEnabled ? 'checked' : '';
  const splitSliderDisabled = !simpleConfig.splitEnabled ? 'disabled' : '';
  const splitValue = Math.max(
    SPLIT_MIN_COUNT,
    Math.min(SPLIT_MAX_COUNT, Number(simpleConfig.splitCount) || 1),
  );
  const splitReadoutText = `${splitValue} ${splitValue === 1 ? 'position' : 'positions'}`;

  // Help text varies based on toggle state. When on, describe what the
  // flywheel does. When off, describe what the simple SOL launch does.
  const helpText = simpleConfig.flywheelEnabled
    ? 'A flywheel routes a portion of trade fees into a reserve token like XLRT, building accumulation pressure on it. Recommended for most launches.'
    : 'Your token will launch in a single SOL pool with all supply allocated. No flywheel mechanic — simple and standard.';

  // Ladder state. Disabled sliders when toggle is off — keeps the visible
  // values but conveys "this isn't doing anything" to the user.
  const ladderChecked = simpleConfig.ladderEnabled ? 'checked' : '';
  const ladderSlidersDisabled = simpleConfig.ladderEnabled ? '' : 'disabled';
  const ladderPercent = Math.max(
    LADDER_MIN_PERCENT,
    Math.min(LADDER_MAX_PERCENT, Number(simpleConfig.ladderPercent) || LADDER_DEFAULT_PERCENT),
  );
  const ladderBandCount = Math.max(
    LADDER_MIN_BANDS,
    Math.min(LADDER_MAX_BANDS, Number(simpleConfig.ladderBandCount) || LADDER_DEFAULT_BANDS),
  );
  // Selected ladder strategy (volatility shape), defaulting to Doubling
  // if the stored value isn't a known strategy id. LADDER_STRATEGY_IDS
  // and LADDER_STRATEGY_META are resolved at render time (runtime), so
  // referencing them here is safe even though META lives in a later
  // module.
  const ladderStrategy = LADDER_STRATEGY_IDS.includes(simpleConfig.ladderStrategy)
    ? simpleConfig.ladderStrategy
    : LADDER_DEFAULT_STRATEGY;

  // Preallocation state. Inputs only matter when the toggle is on; we
  // still render their values (just disabled) so the user can see what
  // would happen at re-enable. Clamp the percent input to (0, 99] —
  // 100% preallocation means no LP at all, which isn't a launch.
  //
  // Refresh the effective preallocation percent before reading: that
  // way handlers that mutated csvText or other inputs since the last
  // render see their effects propagate to the displayed values here.
  // (No-op when the value is already current.)
  recomputeEffectivePreallocationPercent();
  const preallocChecked = simpleConfig.preallocationEnabled ? 'checked' : '';
  const preallocDisabled = simpleConfig.preallocationEnabled ? '' : 'disabled';
  // EFFECTIVE percent — what every downstream computation should use.
  // Includes the auto-fit floor.
  const preallocPct = Math.max(0, Math.min(
    99, Number(simpleConfig.preallocationPercent) || 1,
  ));
  // TYPED percent — what the user last typed into the input. Shown in
  // the input itself so auto-fit's bumps don't clobber what the user
  // typed. When auto-fit is off these are the same value.
  const preallocPctInputValue = Math.max(0, Math.min(
    99, Number(simpleConfig.preallocationPercentInput) || preallocPct,
  ));
  // Auto-fit state and a hint string for when auto-fit raised the
  // effective above the typed. We only show the hint when there's an
  // actual discrepancy and the user might wonder where the bump came
  // from — otherwise it'd just be visual noise.
  const autoFitChecked = simpleConfig.preallocationAutoFit !== false ? 'checked' : '';
  const autoFitRaised = simpleConfig.preallocationAutoFit !== false
    && Math.abs(preallocPct - preallocPctInputValue) > 0.05;

  // Compute display values for the preallocation row. Token amount uses
  // the total supply input (or 0 if unset). USD value uses the
  // targetMarketCap input. Both gracefully degrade to a dash when the
  // user hasn't entered the relevant input yet — the row stays readable.
  const totalSupplyInput = parseNumberInput(document.getElementById('tokenSupply'));
  const targetMcInput = parseNumberInput(document.getElementById('targetMarketCap'));
  const preallocTokens = preallocChecked && Number.isFinite(totalSupplyInput) && totalSupplyInput > 0
    ? totalSupplyInput * preallocPct / 100
    : null;
  const preallocUsd = preallocChecked && Number.isFinite(targetMcInput) && targetMcInput > 0
    ? targetMcInput * preallocPct / 100
    : null;
  const preallocDisplayText = (preallocTokens != null && preallocUsd != null)
    ? `≈ ${preallocTokens.toLocaleString(undefined, { maximumFractionDigits: 0 })} tokens · $${formatUsdRoughly(preallocUsd)}`
    : (preallocTokens != null
        ? `≈ ${preallocTokens.toLocaleString(undefined, { maximumFractionDigits: 0 })} tokens`
        : (preallocUsd != null
            ? `≈ $${formatUsdRoughly(preallocUsd)}`
            : 'enter supply and market cap above to see values'));

  // Support state. The SOL input is independent of preallocation in
  // shape (you can technically have support without preallocation —
  // it's just extra buy-side liquidity below launch), but it's most
  // useful when there IS preallocation to back. The help text spells
  // that out. We disable the input when the toggle is off (consistent
  // with how the bootstrap row works) but don't gate enabling support
  // on preallocation being on — let the user combine them as they like.
  const supportChecked = simpleConfig.supportEnabled ? 'checked' : '';
  // Depth is clamped to the supported range at render time, same belt-
  // and-suspenders pattern as the other percent sliders. The input
  // accepts integers between the min and max constants.
  const supportDepthPct = clampSupportDepth(simpleConfig.supportDepthPct);

  // Auto-back state: when on AND preallocation is also on, the SOL
  // input value is clamped to a floor equal to the preallocation USD
  // value (the user can still type a larger value for a deeper wall).
  // Without preallocation enabled there's nothing to back, so the
  // Auto-back checkbox is disabled.
  const supportAutoChecked = simpleConfig.supportAutoSize ? 'checked' : '';
  // SOL input is enabled whenever support is on. Auto-back doesn't
  // lock the input — it only enforces a MINIMUM. The clamp happens
  // at write-time in the input handler. Depth input follows the
  // toggle only; user-tunable regardless of auto-back state.
  const supportSolDisabled = simpleConfig.supportEnabled ? '' : 'disabled';
  const supportDepthDisabled = simpleConfig.supportEnabled ? '' : 'disabled';

  // Compute the displayed SOL value via the shared helper, which
  // applies the auto-back floor when applicable. Mirror the clamped
  // value into stored state so subsequent reads from
  // simpleConfig.supportSolValue (other UI paths, customize-mode
  // switch) see the same value the user is seeing.
  const displayedSupportSol = effectiveSupportSolValue();
  if (simpleConfig.supportAutoSize
      && simpleConfig.preallocationEnabled
      && displayedSupportSol > (Number(simpleConfig.supportSolValue) || 0)) {
    simpleConfig.supportSolValue = displayedSupportSol;
  }
  // USD-equivalent of the support SOL value, using the live SOL price
  // from the SOL pool if available. Falls back to no display when
  // nothing's resolved yet — better to show nothing than show a wrong
  // number.
  const solPoolForSupport = pools.find((p) => (p.quoteToken || '').toUpperCase() === 'SOL');
  const solUsdForSupport = solPoolForSupport && Number(solPoolForSupport.resolvedPriceUsd) > 0
    ? Number(solPoolForSupport.resolvedPriceUsd)
    : null;
  const supportUsd = supportChecked && solUsdForSupport && displayedSupportSol > 0
    ? displayedSupportSol * solUsdForSupport
    : null;
  // Build the static display text — same logic as refreshSimpleSupportDisplay
  // (which runs on subsequent input events) so the initial render matches
  // what the user sees after typing. Includes the preallocation-coverage
  // indicator when both features are on, so the rug-resistance link is
  // visible at first paint.
  let supportDisplayText;
  if (supportUsd != null) {
    supportDisplayText = `≈ $${formatUsdRoughly(supportUsd)} buy wall, launch to -${supportDepthPct}%`;
  } else if (supportChecked && displayedSupportSol > 0) {
    supportDisplayText = `(USD value will show once SOL price resolves; range -${supportDepthPct}%)`;
  } else {
    supportDisplayText = `single-sided quote liquidity covering -${supportDepthPct}% below launch`;
  }
  if (simpleConfig.preallocationEnabled && supportUsd != null) {
    const _mcap = parseNumberInput(document.getElementById('targetMarketCap'));
    const _pp = Number(simpleConfig.preallocationPercent) || 0;
    if (Number.isFinite(_mcap) && _mcap > 0 && _pp > 0) {
      const _preallocUsd = _mcap * _pp / 100;
      const _coverage = _preallocUsd > 0 ? supportUsd / _preallocUsd : 1;
      if (_coverage >= 1) {
        supportDisplayText += ` · fully backs preallocation ✓`;
      } else {
        supportDisplayText += ` · backs ${Math.round(_coverage * 100)}% of preallocation`;
      }
    }
  }

  // ---- Airdrop sub-section state ---------------------------------------
  // The airdrop UI sits inside the preallocation block — disabled when
  // preallocation is off. Re-parse the user's CSV every render so the
  // preview/errors stay in sync with simpleConfig.airdrop.csvText.
  // (The textarea handler keeps csvText in sync with the user's typing,
  // then triggers a render; render does the parse from there.)
  const airdrop = simpleConfig.airdrop;
  const airdropEnabled = airdrop.enabled && simpleConfig.preallocationEnabled;
  const airdropParse = parseAirdropCsv(airdrop.csvText || '');
  const airdropAnnotated = annotateAirdropRowsWithTokens(airdropParse.rows);
  const airdropBudgetErr = airdropBudgetError(airdropAnnotated.totalTokens);
  // Persist computed results on the airdrop state so other code paths
  // (e.g. a future "execute airdrop" step) can read them without re-
  // parsing. parsedRows holds the token-annotated rows; parseError
  // carries any CSV-format problem; budgetError flags over-budget.
  airdrop.parsedRows = airdropAnnotated.rows;
  airdrop.parseError = airdropParse.error;
  airdrop.budgetError = airdropBudgetErr;

  // Build the airdrop results HTML once via the same helper the
  // in-place refresh path uses, so first-paint and subsequent updates
  // produce identical markup. Reads simpleConfig.airdrop which we just
  // populated above (parsedRows, parseError, budgetError).
  const airdropResultsHtml = buildAirdropResultsHtml();

  body.innerHTML = `
    <div class="simple-config-row">
      <label class="simple-config-toggle">
        <input type="checkbox" id="simpleFlywheelToggle" ${checked}>
        <strong>Use a flywheel</strong>
      </label>
      <a class="is-size-7 ml-2" id="simpleFlywheelLearnMore" href="#" role="button"
         aria-haspopup="dialog" aria-controls="flywheelInfoModal">Learn more</a>
      <div class="select is-small simple-config-dropdown" ${dropdownDisabled}>
        <select id="simpleFlywheelSelect" ${dropdownDisabled}>
          ${options}
        </select>
      </div>
      <div class="simple-config-slider" ${dropdownDisabled}>
        <input type="range" id="simpleFlywheelSlider"
               min="${FLYWHEEL_MIN_PERCENT}" max="${FLYWHEEL_MAX_PERCENT}" step="1"
               value="${sliderValue}" ${dropdownDisabled}>
        <span class="simple-config-slider-value" id="simpleFlywheelSliderValue">${sliderValue}%</span>
      </div>
    </div>
    <p class="simple-config-help-text">${escapeHtml(helpText)}</p>

    <details id="simpleAdvancedDetails"${simpleConfig._advancedExpanded ? ' open' : ''} style="margin-top: 1rem; border-top: 1px dashed var(--rule, rgba(28,22,16,0.15)); padding-top: 0.75rem;">
      <summary style="font-weight: 600; user-select: none; padding: 0.25rem 0;">
        <span class="icon is-small" style="margin-right: 0.25rem;"><i class="fas fa-cog"></i></span>
        Advanced options
        ${(simpleConfig.splitEnabled
            || simpleConfig.ladderEnabled
            || simpleConfig.preallocationEnabled
            || simpleConfig.supportEnabled)
          // Render each active feature as its own pill with a real
          // gap between them. Earlier the names were joined with " · "
          // into a SINGLE pill, which read as one long label rather
          // than a list of independent toggles. Separate pills make
          // it visually obvious that each is its own switch — turning
          // one off should make one pill disappear.
          ? [
              simpleConfig.preallocationEnabled ? 'preallocation' : null,
              simpleConfig.supportEnabled ? 'support' : null,
              simpleConfig.splitEnabled ? 'split LP' : null,
              simpleConfig.ladderEnabled ? 'ladder' : null,
            ].filter(Boolean).map((label) =>
              `<span style="font-weight: normal; font-size: 0.85em; margin-left: 0.4rem; color: var(--ink-soft, #4a3b27); background: var(--gold-soft, #cda14a); padding: 0.15rem 0.55rem; border-radius: 999px; border: 1px solid var(--gold, #b88a2a);">${label}</span>`
            ).join('')
          : `<span class="is-size-7 has-text-grey" style="font-weight: normal; margin-left: 0.5rem;">— preallocation, support, LP splitting, ladder, pool customization</span>`}
      </summary>
      <div style="margin-top: 0.75rem;">
        <!--
          Preallocation block — wrapped in a single #preallocationBlock
          div so the entire section (toggle row, warning, help text,
          airdrop sub-section, breakdown table) can be relocated as a
          unit between this simple-mode Advanced slot and the
          customize-mode #customizePreallocSlot above the pool list.
          Handlers wired on its children survive the move via
          appendChild — that's the same pattern lockPositionsField uses.
          See renderSimpleConfig's tail and applySimpleConfigMode for
          the relocation calls.
        -->
        <div id="preallocationBlock">
        <div class="simple-config-row">
          <label class="simple-config-toggle">
            <input type="checkbox" id="simplePreallocToggle" ${preallocChecked}>
            <strong>Preallocate supply</strong>
          </label>
          <div class="simple-config-slider">
            <input class="input is-small" type="number" min="0" max="99" step="1"
                   id="simplePreallocPctInput"
                   style="width: 6rem;"
                   value="${preallocPct.toFixed(preallocPct % 1 === 0 ? 0 : 1)}" ${preallocDisabled}>
            <span class="simple-config-slider-value" id="simplePreallocPctUnit">% of supply</span>
          </div>
          <label class="simple-config-toggle" style="margin-left:0.5rem;" title="When on, the preallocation % is automatically raised (never lowered) to fit the airdrop list. Your typed value acts as a minimum. If the airdrop changes, the floor follows.">
            <input type="checkbox" id="simplePreallocAutoFitToggle" ${autoFitChecked} ${preallocChecked ? '' : 'disabled'}>
            <span class="is-size-7">Auto-fit airdrop</span>
          </label>
          ${simpleConfig.mode === 'customize' ? '' : `
          <label class="simple-config-toggle" style="margin-left:0.5rem;" title="When on, the Support position's SOL value is automatically pinned to a minimum that fully backs the preallocated supply. You can still set a larger Support value for a deeper buy wall.">
            <input type="checkbox" id="simplePreallocAutoBackToggle" ${supportAutoChecked} ${preallocChecked ? '' : 'disabled'}>
            <span class="is-size-7">Auto-back with support</span>
          </label>`}
          <div class="simple-config-slider-value" id="simplePreallocDisplay" style="font-style: italic; color: var(--text-muted, #666);">${escapeHtml(preallocDisplayText)}</div>
          <span class="is-size-7 has-text-warning-dark ml-2" id="simplePreallocAutoFitHint" style="font-style: normal;${autoFitRaised ? '' : ' display: none;'}">⇡ auto-fit: ${preallocPctInputValue}% → ${preallocPct.toFixed(preallocPct % 1 === 0 ? 0 : 1)}% to cover airdrop</span>
        </div>
        <div id="simplePreallocWarning" class="notification is-warning is-light py-2 px-3 mt-2 mb-0 is-size-7${preallocChecked && !simpleConfig.supportEnabled ? '' : ' hidden'}">
          <strong>⚠ Preallocation is unbacked.</strong>
          Without a Support position, holders of preallocated supply have no buy-side liquidity to sell into — this is the textbook rug shape.
          ${simpleConfig.mode === 'customize'
            ? 'Add a support position to one of your pools to provide an honest exit.'
            : '<a href="#" id="simplePreallocEnableSupport"><strong>Enable Support position</strong></a> to add an honest exit.'}
        </div>
        <p class="simple-config-help-text">Holds back a percentage of total supply from LP — for team/VC tokens, presales, airdrops, staking rewards, or any utility reserve. ${simpleConfig.mode === 'customize'
          ? 'You control pool allocations directly; the preallocation simply sits outside your pools.'
          : 'Pool allocations scale down to fit the remaining budget, preserving your flywheel split.'} The preallocated tokens stay in the launch wallet for you to distribute after launch.${simpleConfig.mode === 'customize' ? '' : ' With <strong>Auto-back with support</strong> on, the Support position below is pinned to a minimum SOL value that equals the preallocation\'s USD value — preventing an unbacked-supply rug.'}</p>

        <!--
          Airdrop sub-section. Nested under preallocation because it
          consumes preallocated supply; disabled (and visually muted)
          when preallocation is off. The collapsible <details> remembers
          its expand/collapse state via simpleConfig.airdrop._expanded so
          a render triggered by typing (e.g. CSV textarea input event)
          doesn't snap the section shut.

          When enabled, the user uploads or pastes a CSV with header
          "wallet,sol". We parse on every keystroke, validate addresses
          and amounts, compute per-row token allocations at the launch
          starting price, and check the total against the preallocation
          budget. Errors render in a red notification; the rows render
          in a preview table with the budget verdict line below.

          Sits ABOVE the breakdown table because the user's action
          (configuring the airdrop) flows naturally into the result
          (the table showing how preallocation gets split). Reversed
          order would be backwards — table first then the inputs that
          produced it.
        -->
        <details id="simpleAirdropDetails"${airdrop._expanded ? ' open' : ''} class="mt-2"
                 style="${simpleConfig.preallocationEnabled ? '' : 'opacity: 0.55; pointer-events: none;'} background: var(--paper-card, #e9dcbf); border: 1px solid var(--rule, rgba(28,22,16,0.15)); border-radius: 4px; padding: 0.6rem 0.85rem;">
          <summary style="user-select: none; padding: 0.15rem 0;">
            <label class="simple-config-toggle" style="display: inline-flex;">
              <input type="checkbox" id="simpleAirdropToggle" ${airdropEnabled ? 'checked' : ''} ${simpleConfig.preallocationEnabled ? '' : 'disabled'}>
              <strong>Airdrop to wallet list</strong>
            </label>
            <span class="is-size-7 has-text-grey ml-2">distribute preallocated supply to contributors based on SOL sent</span>
          </summary>
          <div class="mt-2" style="${airdropEnabled ? '' : 'opacity: 0.55; pointer-events: none;'}">
            <p class="is-size-7 has-text-grey mb-2">
              CSV format: first line <code>wallet,sol</code>, then one row per recipient. Each wallet's token allocation is computed at the launch starting price (the USD value of the SOL they sent, converted to tokens at <em>market cap ÷ supply</em>). Lines starting with <code>#</code> are treated as comments.
              <a href="#" id="simpleAirdropSampleLink"><strong>Download sample CSV</strong></a>
            </p>
            <div class="field is-grouped is-align-items-flex-start">
              <div class="control">
                <div class="file is-small has-name">
                  <label class="file-label">
                    <input class="file-input" type="file" id="simpleAirdropFileInput" accept=".csv,text/csv,text/plain" ${airdropEnabled ? '' : 'disabled'}>
                    <span class="file-cta">
                      <span class="file-icon"><i class="fas fa-upload"></i></span>
                      <span class="file-label">Upload CSV</span>
                    </span>
                    <span class="file-name" id="simpleAirdropFileName">${airdrop.csvText ? `${airdrop.parsedRows.length} row${airdrop.parsedRows.length === 1 ? '' : 's'} loaded` : 'no file chosen'}</span>
                  </label>
                </div>
              </div>
              <div class="control">
                <button class="button is-small is-light" id="simpleAirdropClearBtn" ${airdrop.csvText ? '' : 'disabled'}>
                  <span class="icon is-small"><i class="fas fa-times"></i></span>
                  <span>Clear</span>
                </button>
              </div>
            </div>
            <textarea class="textarea is-small is-family-monospace" id="simpleAirdropCsvText"
                      placeholder="wallet,sol&#10;FSfR6uRBJPbGiBSAtR7b7LrgAVu77WrTe7HT7J3afWdz,0.5&#10;CVeDKELHaC76REcBnkrQGV5XX6wJKoYpdLu6E8vEHiPS,1.25"
                      rows="4"
                      style="font-size: 0.8em; background-color: var(--paper-deep, #e4d6b3); border-color: var(--rule, rgba(28,22,16,0.15));"
                      ${airdropEnabled ? '' : 'disabled'}>${escapeHtml(airdrop.csvText || '')}</textarea>
            <!--
              Results container — the error notification, preview table,
              and budget-line are rendered here. Marked with a data
              attribute so refreshAirdropDisplayInline() can target it
              for in-place updates without re-rendering the whole
              section (which would steal focus from the textarea).
              The same buildAirdropResultsHtml() helper produces this
              markup both at first paint and on every subsequent
              keystroke, so the rendering stays consistent.
            -->
            <div data-airdrop-results>${airdropResultsHtml}</div>
          </div>
        </details>

        <!--
          Preallocation breakdown table. Shows where the preallocation
          goes: airdrop recipients (when enabled) and the launch wallet
          (everything not airdropped). When airdrop is active, the
          "Airdrop" row is clickable to expand the full per-wallet list
          beneath it; collapsed by default since wallet lists can be
          long.

          Always rendered when preallocation is on, regardless of
          whether airdrop is enabled — so a user with a 10% prealloc
          and no airdrop sees a single "Launch wallet: 100% of preallo­
          cation" row, which is the right answer for that case.

          Sits BELOW the airdrop sub-section: the user configures the
          airdrop above, then sees the resulting allocation summarised
          in this table.

          buildPreallocationBreakdownHtml() handles all the rendering
          logic (preallocation OFF returns ''); refresh-paths update
          the [data-prealloc-breakdown] container in place.
        -->
        <div data-prealloc-breakdown class="mt-2"${preallocChecked ? '' : ' style="display: none;"'}>${buildPreallocationBreakdownHtml()}</div>
        </div><!-- /#preallocationBlock -->

        <div class="simple-config-row" id="simpleSupportRow"${preallocChecked && !simpleConfig.supportEnabled ? ' style="outline:2px solid #f5d76e; border-radius:4px; padding:0.25rem 0.5rem; margin-left:-0.5rem;"' : ''}>
          <label class="simple-config-toggle">
            <input type="checkbox" id="simpleSupportToggle" ${supportChecked}>
            <strong>Add support position</strong>
          </label>
          <div class="simple-config-slider">
            <input class="input is-small" type="number" min="0" step="0.1"
                   id="simpleSupportSolInput"
                   style="width: 7rem;"
                   value="${Number(displayedSupportSol).toFixed(Math.abs(displayedSupportSol) >= 10 ? 1 : 3)}" ${supportSolDisabled}>
            <span class="simple-config-slider-value" id="simpleSupportSolUnit">SOL</span>
          </div>
          <div class="simple-config-slider">
            <span class="simple-config-slider-value" style="line-height:30px;">depth</span>
            <input class="input is-small" type="number"
                   min="${SUPPORT_MIN_DEPTH_PCT}" max="${SUPPORT_MAX_DEPTH_PCT}" step="1"
                   id="simpleSupportDepthInput"
                   style="width: 4.5rem;"
                   value="${supportDepthPct}" ${supportDepthDisabled}>
            <span class="simple-config-slider-value">%</span>
          </div>
          <div class="simple-config-slider-value" id="simpleSupportDisplay" style="font-style: italic; color: var(--text-muted, #666);">${escapeHtml(supportDisplayText)}</div>
        </div>
        <p class="simple-config-help-text">Single-sided buy-side liquidity sitting just below launch price — quote-only, so it doesn't carve from your token-side allocation. The depth setting controls how far the buy wall extends. The SOL you commit gets split evenly across every pool (SOL pool plus any flywheel pools). When <strong>Auto-back with support</strong> is on in the Preallocate row above, this SOL value is silently bumped up to whatever's needed to fully back the preallocation — type more if you want a deeper wall, but the minimum holds. For token-side density near launch price (resistance / accumulation bands), see Ladder positions below. Customize mode lets you tune each pool independently with per-pool depth.</p>
        <div class="simple-config-row">
          <label class="simple-config-toggle">
            <input type="checkbox" id="simpleSplitToggle" ${splitChecked}>
            <strong>Split the LP</strong>
          </label>
          <div class="simple-config-slider" ${splitSliderDisabled}>
            <input type="range" id="simpleSplitSlider"
                   min="${SPLIT_MIN_COUNT}" max="${SPLIT_MAX_COUNT}" step="1"
                   value="${splitValue}" ${splitSliderDisabled}>
            <span class="simple-config-slider-value" id="simpleSplitSliderValue">${splitReadoutText}</span>
          </div>
        </div>
        <p class="simple-config-help-text">Splits the SOL pool into multiple positions, each minting its own transferable Fee Key NFT (when Lock liquidity is enabled below) — useful if you want to give away or sell partial fee streams. To split the flywheel pool too, use Customize.</p>
        <div class="simple-config-row">
          <label class="simple-config-toggle">
            <input type="checkbox" id="simpleLadderToggle" ${ladderChecked}>
            <strong>Ladder positions</strong>
          </label>
          <div class="simple-config-slider" ${ladderSlidersDisabled}>
            <input type="range" id="simpleLadderPercentSlider"
                   min="${LADDER_MIN_PERCENT}" max="${LADDER_MAX_PERCENT}" step="5"
                   value="${ladderPercent}" ${ladderSlidersDisabled}>
            <span class="simple-config-slider-value" id="simpleLadderPercentValue">${ladderPercent}% supply</span>
          </div>
          <div class="simple-config-slider" ${ladderSlidersDisabled}>
            <input type="range" id="simpleLadderBandsSlider"
                   min="${LADDER_MIN_BANDS}" max="${LADDER_MAX_BANDS}" step="1"
                   value="${ladderBandCount}" ${ladderSlidersDisabled}>
            <span class="simple-config-slider-value" id="simpleLadderBandsValue">${ladderBandCount} bands</span>
          </div>
          <div id="simpleLadderStrategyRow" style="flex: 0 0 100%; display: ${simpleConfig.ladderEnabled ? 'flex' : 'none'}; gap: 1.25rem; flex-wrap: wrap; align-items: flex-start; margin-top: 0.25rem;">
            <div style="flex: 1 1 17rem; min-width: 15rem;">
              <div style="display: flex; align-items: center; gap: 0.4rem; margin-bottom: 0.4rem;">
                <strong style="font-size: 0.9rem;">Strategy</strong>
                <button type="button" class="button is-small" id="simpleLadderInfo"
                        title="Explain the ladder strategies" aria-label="Explain the ladder strategies"
                        style="padding: 0 0.4rem; height: 1.5rem; line-height: 1; font-size: 0.9rem;">&#9432;</button>
              </div>
              <div class="select is-small simple-config-dropdown">
                <select id="simpleLadderStrategy">
                  ${LADDER_STRATEGY_IDS.map((id) => {
                    const meta = LADDER_STRATEGY_META[id] || { name: id };
                    const selected = id === ladderStrategy ? 'selected' : '';
                    const label = meta.tag ? `${meta.name} \u2014 ${meta.tag}` : meta.name;
                    return `<option value="${id}" ${selected}>${escapeHtml(label)}</option>`;
                  }).join('')}
                </select>
              </div>
              <p class="simple-config-help-text" id="simpleLadderStrategyNote" style="margin: 0.5rem 0 0 0;">${escapeHtml((LADDER_STRATEGY_META[ladderStrategy] || {}).note || '')}</p>
            </div>
            <div id="simpleLadderPreview" style="flex: 2 1 20rem; min-width: 16rem;"></div>
          </div>
        </div>
        <p class="simple-config-help-text">Splits a portion of each pool's supply across discrete price bands following your chosen strategy (see the info button by the Strategy dropdown), climbing toward a high-multiple ceiling with gaps between bands for breakouts. Each band acts as resistance on the way up and support on the way back down. Smooths supply distribution so 90% isn't gobbled up by the time you hit 10× — leaves room for higher-mcap accumulation. The rest of the pool stays in a wide position covering all prices.</p>
        <div class="simple-config-customize-row" style="margin-top: 0.75rem;">
          <button type="button" class="button is-link is-light" id="simpleCustomizeBtn">
            <span class="icon"><i class="fas fa-sliders-h"></i></span>
            <span>Customize pools manually</span>
          </button>
          <p class="simple-config-help-text" style="margin-top: 0.5rem;">Switches to per-pool editing — pick the quote token, fee tier, and allocation for each pool individually, and configure support/ladder positions per-pool. The current simple-mode settings carry over as the starting point.</p>
        </div>
        <!--
          Slot for the Lock-liquidity checkbox. The element lives at the
          page level in index.html (#lockPositionsField) so customize
          mode can also access it; applySimpleConfigMode() relocates
          the element here when simple mode is active, and moves it
          back to its page-level home when switching to customize mode.
          Single source of truth, no duplicated state.
        -->
        <div id="lockPositionsSlotSimple" style="margin-top: 0.75rem; border-top: 1px dashed var(--rule, rgba(28,22,16,0.08)); padding-top: 0.5rem;"></div>
      </div>
    </details>
  `;

  // Wire up listeners. These elements are recreated on every render,
  // so attaching directly is fine — they're discarded along with the
  // innerHTML on the next render.
  const toggle = body.querySelector('#simpleFlywheelToggle');
  const select = body.querySelector('#simpleFlywheelSelect');
  const slider = body.querySelector('#simpleFlywheelSlider');
  const sliderReadout = body.querySelector('#simpleFlywheelSliderValue');
  const learnMoreLink = body.querySelector('#simpleFlywheelLearnMore');
  const splitToggle = body.querySelector('#simpleSplitToggle');
  const splitSlider = body.querySelector('#simpleSplitSlider');
  const splitReadout = body.querySelector('#simpleSplitSliderValue');
  const ladderToggle = body.querySelector('#simpleLadderToggle');
  const ladderPctSlider = body.querySelector('#simpleLadderPercentSlider');
  const ladderPctReadout = body.querySelector('#simpleLadderPercentValue');
  const ladderBandsSlider = body.querySelector('#simpleLadderBandsSlider');
  const ladderBandsReadout = body.querySelector('#simpleLadderBandsValue');
  const ladderStrategySelect = body.querySelector('#simpleLadderStrategy');
  const ladderInfoBtn = body.querySelector('#simpleLadderInfo');
  const ladderStrategyNote = body.querySelector('#simpleLadderStrategyNote');
  const customizeBtn = body.querySelector('#simpleCustomizeBtn');

  // Learn-more link — opens the static flywheel explainer modal. The link
  // sits next to the toggle so the user can discover what flywheels do
  // before deciding to enable one. preventDefault on the click so the
  // href="#" doesn't scroll the page or change the URL hash.
  if (learnMoreLink) {
    learnMoreLink.addEventListener('click', (e) => {
      e.preventDefault();
      openFlywheelInfoModal();
    });
  }

  toggle.addEventListener('change', (e) => {
    simpleConfig.flywheelEnabled = e.target.checked;
    rebuildPoolsFromSimple();
    renderSimpleConfig();
    // No explicit renderPools() — rebuildPoolsFromSimple invokes
    // addPool which already paints the pool list.
  });

  select.addEventListener('change', (e) => {
    simpleConfig.flywheelKey = e.target.value;
    rebuildPoolsFromSimple();
    renderSimpleConfig();
  });

  // Slider has two events:
  //   - `input` fires continuously as the user drags. We update the
  //     readout live so they see the value moving with the thumb, but
  //     don't rebuild pools on every pixel — that would fire a quote
  //     resolution per pixel.
  //   - `change` fires on mouseup / keyboard commit. We rebuild pools
  //     here, once per drag.
  slider.addEventListener('input', (e) => {
    sliderReadout.textContent = `${e.target.value}%`;
  });
  slider.addEventListener('change', (e) => {
    simpleConfig.flywheelPercent = Number(e.target.value);
    rebuildPoolsFromSimple();
    // Don't re-render the simple-config UI on slider change — that
    // would destroy the slider element mid-drag-cycle on some browsers
    // and feels jumpy. The readout is already in sync from the input
    // handler above; pool list (hidden in default mode anyway) is
    // refreshed by addPool calls inside rebuildPoolsFromSimple.
  });

  // Split-LP toggle: enable/disable splitting. State persists so the
  // slider value sticks across uncheck→check cycles. Any change here
  // requires re-rendering the simple-config UI to flip the slider's
  // disabled visual state.
  splitToggle.addEventListener('change', (e) => {
    simpleConfig.splitEnabled = e.target.checked;
    rebuildPoolsFromSimple();
    renderSimpleConfig();
  });

  // Split slider follows the same input/change split as the flywheel
  // slider — live readout on input, pool rebuild on commit.
  splitSlider.addEventListener('input', (e) => {
    const v = Number(e.target.value);
    splitReadout.textContent = `${v} ${v === 1 ? 'position' : 'positions'}`;
  });
  splitSlider.addEventListener('change', (e) => {
    simpleConfig.splitCount = Number(e.target.value);
    rebuildPoolsFromSimple();
  });

  // Bootstrap mode toggle: switch between minimal and custom. State
  // persists across toggle off/on cycles (the SOL value is kept), so a
  // user who accidentally untoggles doesn't lose their entered amount.
  // Ladder toggle: enable/disable the ladder feature. State persists
  // (percent + band count are kept), and the sliders flip between
  // enabled/disabled via re-render. rebuildPoolsFromSimple regenerates
  // each pool's ladderConfig so the bands are populated/cleared.
  ladderToggle.addEventListener('change', (e) => {
    simpleConfig.ladderEnabled = e.target.checked;
    rebuildPoolsFromSimple();
    renderSimpleConfig();
  });

  // Ladder slider handlers update state on each tick and refresh just
  // the readout text — no full re-render needed for the simple UI
  // (rest of it is invariant under these changes). We do rebuild pools
  // so each pool's ladderConfig gets fresh bands sized for the new value
  // (in case the user switches to customize); rebuildPoolsFromSimple also
  // refreshes the depth-chart preview, so it tracks the change live.
  ladderPctSlider.addEventListener('input', (e) => {
    const v = Number(e.target.value);
    simpleConfig.ladderPercent = Number.isFinite(v) ? v : LADDER_DEFAULT_PERCENT;
    ladderPctReadout.textContent = `${simpleConfig.ladderPercent}% supply`;
    rebuildPoolsFromSimple();
  });
  ladderBandsSlider.addEventListener('input', (e) => {
    const v = Number(e.target.value);
    simpleConfig.ladderBandCount = Number.isInteger(v) ? v : LADDER_DEFAULT_BANDS;
    ladderBandsReadout.textContent = `${simpleConfig.ladderBandCount} bands`;
    rebuildPoolsFromSimple();
  });

  // Strategy dropdown: store the chosen shape, update the inline note, then
  // rebuild the pools so their ladderConfigs carry the new strategy's bands
  // (the rebuild also refreshes the preview). Like the sliders, no full
  // re-render — the rest of the simple UI is invariant under a strategy change.
  if (ladderStrategySelect) {
    ladderStrategySelect.addEventListener('change', (e) => {
      const id = LADDER_STRATEGY_IDS.includes(e.target.value)
        ? e.target.value : LADDER_DEFAULT_STRATEGY;
      simpleConfig.ladderStrategy = id;
      if (ladderStrategyNote) {
        ladderStrategyNote.textContent = (LADDER_STRATEGY_META[id] || {}).note || '';
      }
      rebuildPoolsFromSimple();
    });
  }

  // Info button: open a read-only dialog explaining every strategy. Reuses
  // the generic confirm modal in info-only mode (no Cancel). Always
  // enabled — it's purely educational, useful even before the ladder is on.
  if (ladderInfoBtn) {
    ladderInfoBtn.addEventListener('click', () => {
      confirmDialog({
        title: 'Ladder strategies',
        body: buildLadderStrategiesInfoHtml(),
        confirmLabel: 'Got it',
        hideCancel: true,
      });
    });
  }

  // Populate the preview now (and on every re-render this wiring runs).
  // Safe to call when the ladder is off — it just clears and hides.
  updateSimpleLadderPreview();

  // Preallocation toggle: enable/disable the preallocation feature.
  // When enabled, the % value (kept in state) determines how much of
  // total supply is held back from LP — pools scale down proportionally.
  // Full re-render so the input enables/disables and the help text
  // updates. rebuildPoolsFromSimple regenerates each pool with the new
  // scaling.
  const preallocToggle = body.querySelector('#simplePreallocToggle');
  const preallocPctInput = body.querySelector('#simplePreallocPctInput');
  const preallocDisplay = body.querySelector('#simplePreallocDisplay');
  if (preallocToggle) {
    preallocToggle.addEventListener('change', (e) => {
      simpleConfig.preallocationEnabled = e.target.checked;
      // When the user turns preallocation ON, auto-enable support and
      // pre-size its SOL value to match the preallocation's USD value.
      // This is the rug-resistance link: preallocation without support
      // is a rug, so the natural default is "both on, sized to match."
      //
      // The user can still disable support manually after this (we
      // warn but don't block — same posture as the spec says: "We
      // should not prevent people from doing what they want, and just
      // warn"). They can also override the SOL value if they want a
      // deeper or shallower buy wall than the equal-value default.
      //
      // When preallocation is turned OFF, we don't touch support —
      // support-only is a legitimate configuration (extra buy-side
      // liquidity below launch, no preallocation to back). Leaving the
      // user's prior support state alone respects their choice.
      if (simpleConfig.preallocationEnabled && simpleConfig.mode !== 'customize') {
        // Simple-mode-only support-seeding cascade. In customize mode
        // support is configured per-pool and simpleConfig.supportSolValue
        // / supportEnabled aren't read by the customize-mode pool
        // configuration. Skipping this avoids silently mutating
        // simple-mode state from a customize-mode action.
        //
        // Refresh the effective preallocation percent before reading it
        // — auto-fit may want to bump it based on an airdrop CSV that
        // was entered while preallocation was off. Without this, the
        // support SOL would size to the stale percent.
        recomputeEffectivePreallocationPercent();
        const recommendedSol = recommendedSupportSolForPreallocation(
          Number(simpleConfig.preallocationPercent) || 0,
        );
        // Seed the SOL value to at least the recommended floor when:
        //   (a) support was off (fresh enable — natural to seed it)
        //   (b) support was on but at a value below the new floor —
        //       Auto-back's promise is "no less than required to back"
        // If the user had support on with a value already at or above
        // the floor, leave it alone. We never DECREASE a user's value
        // — Auto-back is a minimum, not an assignment.
        const currentSol = Number(simpleConfig.supportSolValue) || 0;
        const needsSeed = recommendedSol != null && recommendedSol > 0
          && (!simpleConfig.supportEnabled || recommendedSol > currentSol);
        if (needsSeed) {
          simpleConfig.supportSolValue = recommendedSol;
        }
        // Auto-back defaults ON when enabling preallocation — the
        // standard backed configuration. The user can untick the
        // Auto-back box if they want to set a smaller (or zero) value.
        simpleConfig.supportAutoSize = true;
        // Auto-enable support regardless — even if we couldn't compute
        // a value, the user gets the toggle on so they see the section
        // and understand support is the way to make preallocation
        // honest. They can adjust the SOL value manually.
        simpleConfig.supportEnabled = true;
      } else if (simpleConfig.preallocationEnabled) {
        // Customize mode: still recompute the effective percent so the
        // airdrop auto-fit math has a fresh number to work from, but
        // skip every simple-mode-support side-effect.
        recomputeEffectivePreallocationPercent();
      }
      preallocRebuildIfApplicable();
      preallocRerenderIfApplicable();
      // Allocation summary depends on preallocation; refresh it so the
      // user sees the new breakdown without having to switch modes.
      if (typeof updateAllocationSummary === 'function') updateAllocationSummary();
      if (typeof updateContinueToFundingState === 'function') updateContinueToFundingState();
      // Airdrop execution cost contributes to Est. Cost only when
      // preallocation is enabled (computeAirdropExecutionCostSol
      // returns 0 when prealloc is off). When the user toggles prealloc
      // off with airdrop on, the airdrop cost portion of Est. Cost
      // should disappear immediately rather than waiting for the
      // server cost re-estimate to come back.
      refreshAirdropCostDisplays();
      // Toggle changes are definitive; bypass the cost-preview debounce
      // so the user sees the support-inclusive total immediately rather
      // than waiting 500ms (prealloc enable auto-enables support too).
      requestCostPreviewUpdate({ immediate: true });
    });
  }
  if (preallocPctInput) {
    preallocPctInput.addEventListener('input', (e) => {
      const v = Number(e.target.value);
      // Clamp at write-time so the state never holds a value outside
      // the displayed range. 99% is the practical upper bound — 100%
      // means no LP at all, which isn't a launch.
      //
      // The typed value goes into preallocationPercentInput; the
      // EFFECTIVE percent (which auto-fit may raise) is computed
      // separately by recomputeEffectivePreallocationPercent. That
      // way the user's typed value survives airdrop bumps and is
      // visible if they ever turn auto-fit off.
      simpleConfig.preallocationPercentInput = Math.max(0, Math.min(99,
        Number.isFinite(v) ? v : 0,
      ));
      recomputeEffectivePreallocationPercent();
      // Keep the support SOL value at or above the preallocation floor
      // as long as Auto-back is on. Auto-back enforces a MINIMUM — if
      // the user typed a higher value manually (deeper wall than the
      // preallocation requires), we leave their value alone. If the
      // floor rises above what they typed (preallocation % increased),
      // we silently bump it up to the new floor.
      //
      // Customize-mode guard: simple-mode support is not the customize-
      // mode support (which is per-pool). Skip this side-effect in
      // customize mode to avoid silently mutating unused state.
      if (simpleConfig.mode !== 'customize'
          && simpleConfig.preallocationEnabled
          && simpleConfig.supportAutoSize) {
        const recommendedSol = recommendedSupportSolForPreallocation(
          simpleConfig.preallocationPercent,
        );
        if (recommendedSol != null && recommendedSol > 0
            && recommendedSol > (Number(simpleConfig.supportSolValue) || 0)) {
          simpleConfig.supportSolValue = recommendedSol;
        }
      }
      preallocRebuildDebouncedIfApplicable();
      // Refresh inline displays without re-rendering. Using the
      // standalone helpers (rather than the in-render closures) so
      // this code path is identical whether we re-render or not.
      refreshSimplePreallocDisplayInline();
      // Also refresh the support displays since the SOL value may have
      // changed in sync (Auto-back floor bump). We have to touch the
      // input element's value directly because that element is what
      // the user sees — not just the textContent span.
      const supportSolEl = body.querySelector('#simpleSupportSolInput');
      if (supportSolEl && simpleConfig.supportAutoSize) {
        // Only overwrite the input value if the user isn't currently
        // focused there. Writing to an unfocused input is safe; writing
        // to a focused one would clobber whatever they're typing.
        if (document.activeElement !== supportSolEl) {
          supportSolEl.value = Number(simpleConfig.supportSolValue).toFixed(
            Math.abs(simpleConfig.supportSolValue) >= 10 ? 1 : 3,
          );
        }
      }
      refreshSimpleSupportDisplayInline();
      // Budget verdict for the airdrop depends on the prealloc %.
      // Refresh in-place so the verdict color/text updates without
      // re-rendering the simple-config (which would steal focus
      // from the prealloc input).
      refreshAirdropDisplayInline();
      if (typeof updateAllocationSummary === 'function') updateAllocationSummary();
      if (typeof updateContinueToFundingState === 'function') updateContinueToFundingState();
    });
    // On blur, flush any pending debounced rebuild so the pool state
    // is current before the user can interact with the rest of the
    // form (Continue button, customize switch, etc.). Without the
    // flush, the user could click Continue during the 250ms debounce
    // window and the funding estimator would see stale pool state.
    //
    // Customize-mode guard: no debounced rebuild was scheduled in
    // customize mode (preallocRebuildDebouncedIfApplicable was a
    // no-op), so we must skip the flush — flushRebuildPoolsFromSimple
    // unconditionally calls rebuildPoolsFromSimple, which would wipe
    // user pool customizations.
    preallocPctInput.addEventListener('blur', () => {
      if (simpleConfig.mode === 'customize') return;
      flushRebuildPoolsFromSimple();
    });
  }

  // ---- Airdrop handlers ---------------------------------------------------
  //
  // The airdrop toggle, file upload, textarea, and clear button all live
  // inside the preallocation block. The textarea handler is the hot path
  // (fires on every keystroke), so it does an IN-PLACE refresh of just
  // the airdrop interior — no full re-render, which would steal focus
  // and reset caret position. The toggle and clear paths go through
  // renderSimpleConfig() since they change the section's overall
  // enabled state.
  const airdropToggle = body.querySelector('#simpleAirdropToggle');
  const airdropDetails = body.querySelector('#simpleAirdropDetails');
  const airdropCsvText = body.querySelector('#simpleAirdropCsvText');
  const airdropFileInput = body.querySelector('#simpleAirdropFileInput');
  const airdropFileName = body.querySelector('#simpleAirdropFileName');
  const airdropClearBtn = body.querySelector('#simpleAirdropClearBtn');
  const airdropSampleLink = body.querySelector('#simpleAirdropSampleLink');

  // Toggle the <details> expanded state and keep it in sync with stored
  // simpleConfig so re-renders preserve it. The native toggle event
  // fires AFTER the open attr changes, so we read it directly here.
  if (airdropDetails) {
    airdropDetails.addEventListener('toggle', () => {
      simpleConfig.airdrop._expanded = airdropDetails.open;
    });
  }

  // The airdrop checkbox sits inside a <label> inside the <summary>.
  // Native <summary> behavior toggles the parent <details> on any
  // click within the summary — including clicks on the checkbox.
  // Without intervention, clicking the checkbox would both flip the
  // checkbox AND toggle the details panel, doing two things at once.
  // Stop click propagation at the label so the summary's default
  // toggle handler never sees the event.
  //
  // Previously achieved with an inline onclick attribute; moved here
  // so the security-hygiene test (which forbids inline event handlers
  // for CSP cleanliness) stays green.
  if (airdropToggle) {
    const wrappingLabel = airdropToggle.closest('label');
    if (wrappingLabel) {
      wrappingLabel.addEventListener('click', (e) => e.stopPropagation());
    }
  }

  // Enable/disable the airdrop. When enabling, expand the section
  // automatically (otherwise the user clicks the toggle then has to
  // click again to expand — annoying). Disable doesn't auto-collapse.
  if (airdropToggle) {
    airdropToggle.addEventListener('change', (e) => {
      simpleConfig.airdrop.enabled = e.target.checked;
      if (simpleConfig.airdrop.enabled) {
        simpleConfig.airdrop._expanded = true;
      }
      preallocRerenderIfApplicable();
      // Airdrop execution cost contributes to the displayed Est. Cost.
      // Toggling airdrop on/off changes whether that contribution
      // counts (computeAirdropExecutionCostSol returns 0 when off).
      // renderSimpleConfig doesn't touch the cost displays itself, so
      // refresh them here.
      refreshAirdropCostDisplays();
    });
  }

  // Preallocation breakdown table — the airdrop summary row is
  // clickable to expand/collapse the per-wallet rows beneath it.
  // Delegation lets us survive renderSimpleConfig rebuilds (the block
  // itself is rebuilt, but document persists). We bind on document
  // rather than body because the preallocation block can be relocated
  // OUTSIDE of body (into #customizePreallocSlot) in customize mode —
  // a body-bound listener would miss clicks once the block has moved.
  //
  // Bind ONCE across the app's lifetime via a dataset flag on
  // documentElement (which is stable). The flag prevents listener
  // accumulation across re-renders.
  if (!document.documentElement.dataset.airdropBreakdownBound) {
    document.documentElement.dataset.airdropBreakdownBound = '1';
    document.addEventListener('click', (e) => {
      const summaryRow = e.target.closest('[data-airdrop-summary-row]');
      if (!summaryRow) return;
      // Don't toggle if the user clicked a link/button inside the row.
      if (e.target.closest('a, button')) return;
      const willExpand = !simpleConfig.airdrop._breakdownExpanded;
      simpleConfig.airdrop._breakdownExpanded = willExpand;
      // Toggle each wallet row's visibility. Scope to the breakdown's
      // immediate container so we only affect rows in the SAME table
      // the user clicked — if (somehow) multiple breakdown tables
      // existed concurrently we wouldn't toggle the wrong one.
      const breakdownContainer = summaryRow.closest('[data-prealloc-breakdown]') || document;
      breakdownContainer.querySelectorAll('[data-airdrop-wallet-row]').forEach((row) => {
        row.style.display = willExpand ? '' : 'none';
      });
      // Rotate the chevron icon. The icon is the first <i> inside the
      // first <span class="icon"> in the row.
      const icon = summaryRow.querySelector('.icon i');
      if (icon) {
        icon.classList.toggle('fa-chevron-right', !willExpand);
        icon.classList.toggle('fa-chevron-down', willExpand);
      }
    });
  }

  // The airdrop refresh + results-builder helpers are top-level
  // functions (defined alongside refreshSimplePreallocDisplayInline)
  // so the prealloc-% input handler can call them when the budget
  // changes. Handlers below reference them directly.

  // Textarea input handler — fires per-keystroke. Update state, refresh
  // the display in-place. No full re-render: the textarea must keep
  // focus and caret position.
  if (airdropCsvText) {
    airdropCsvText.addEventListener('input', (e) => {
      simpleConfig.airdrop.csvText = e.target.value;
      refreshAirdropDisplayInline();
    });
  }

  // File upload handler — read the file, push contents into the
  // textarea, then refresh in-place. We intentionally update the
  // textarea (rather than just the stored csvText) so the user can
  // see/edit the uploaded content.
  if (airdropFileInput) {
    airdropFileInput.addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      // Guard against huge files — a presale with 100k contributors is
      // ~5MB at 50 bytes/line. Larger than that is almost certainly a
      // mistake (wrong file selected) and would freeze the parser.
      if (file.size > 5 * 1024 * 1024) {
        simpleConfig.airdrop.parseError = `File too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Maximum is 5 MB — split into smaller batches if needed.`;
        refreshAirdropDisplayInline();
        return;
      }
      try {
        const text = await file.text();
        simpleConfig.airdrop.csvText = text;
        if (airdropCsvText) airdropCsvText.value = text;
        refreshAirdropDisplayInline();
      } catch (err) {
        simpleConfig.airdrop.parseError = `Couldn't read file: ${err.message}`;
        refreshAirdropDisplayInline();
      }
    });
  }

  // Clear button — wipe csvText and parsed state, refresh in-place.
  if (airdropClearBtn) {
    airdropClearBtn.addEventListener('click', () => {
      simpleConfig.airdrop.csvText = '';
      simpleConfig.airdrop.parsedRows = [];
      simpleConfig.airdrop.parseError = null;
      simpleConfig.airdrop.budgetError = null;
      if (airdropCsvText) airdropCsvText.value = '';
      if (airdropFileInput) airdropFileInput.value = '';
      refreshAirdropDisplayInline();
    });
  }

  // Sample-CSV download link. We construct a data: URL with a small
  // example so users can see the format without hunting through docs.
  // The wallet addresses in the sample are real-but-arbitrary Solana
  // addresses (just for format demonstration — they're not associated
  // with this app or the user).
  if (airdropSampleLink) {
    airdropSampleLink.addEventListener('click', (e) => {
      e.preventDefault();
      const sample =
        '# Airdrop CSV — first line is the header, then one row per recipient.\n' +
        '# Comments (lines starting with #) and blank lines are ignored.\n' +
        '# The SOL column is what each wallet contributed; token allocation\n' +
        '# is computed at the launch starting price (market cap / supply).\n' +
        'wallet,sol\n' +
        'FSfR6uRBJPbGiBSAtR7b7LrgAVu77WrTe7HT7J3afWdz,0.5\n' +
        'CVeDKELHaC76REcBnkrQGV5XX6wJKoYpdLu6E8vEHiPS,1.25\n' +
        '8i2NtsSoJqZDMCpe9fV5gbRdDQkGMQFMtLttuB2Z2gdw,0.1\n';
      const blob = new Blob([sample], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'trebuchet-airdrop-sample.csv';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      // Free the object URL after the click handler runs — the
      // download will already have started.
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
  }

  // Support toggle: enable/disable the support position. Like the
  // bootstrap toggle, just flipping this on/off swaps the per-pool
  // supportConfig between { mode: 'off' } and { mode: 'custom', solValue }.
  // Full re-render so the SOL input enables/disables.
  const supportToggle = body.querySelector('#simpleSupportToggle');
  const supportSolInput = body.querySelector('#simpleSupportSolInput');
  const supportDepthInput = body.querySelector('#simpleSupportDepthInput');
  const supportDisplay = body.querySelector('#simpleSupportDisplay');

  // Shared in-place refresh for the support hint text. Reads the latest
  // simpleConfig values and the live SOL price; writes a context-appropriate
  // string into the hint span. Keeps the depth value in the display synced
  // with whichever input the user just touched. Avoiding a full re-render
  // here lets the user keep typing in the SOL or depth input without
  // losing focus or caret position.
  //
  // When preallocation is also enabled, the hint additionally calls out
  // whether the current SOL value backs the preallocation fully (≥ 100%),
  // partially (1-99%), or not at all (0). This gives the user immediate
  // feedback on whether they've sized support honestly without having to
  // wait for the Continue-button warning to fire.
  function refreshSimpleSupportDisplay() {
    if (!supportDisplay) return;
    const sp = pools.find((p) => (p.quoteToken || '').toUpperCase() === 'SOL');
    const solUsd = sp && Number(sp.resolvedPriceUsd) > 0 ? Number(sp.resolvedPriceUsd) : null;
    // Use the effective value (with auto-back floor applied) so the
    // displayed USD and coverage match what the wire format will send.
    const sv = effectiveSupportSolValue();
    const dp = clampSupportDepth(simpleConfig.supportDepthPct);
    const usd = solUsd && sv > 0 ? sv * solUsd : null;

    // Base hint (always shown when support is on).
    let text;
    if (usd != null) {
      text = `≈ $${formatUsdRoughly(usd)} buy wall, launch to -${dp}%`;
    } else if (sv > 0) {
      text = `(USD value will show once SOL price resolves; range -${dp}%)`;
    } else {
      text = `single-sided quote liquidity covering -${dp}% below launch`;
    }

    // Backing indicator (only shown when preallocation is also enabled).
    // Surfaces the coverage ratio inline so the user sees right away
    // whether they're fully backing the preallocation.
    if (simpleConfig.preallocationEnabled && usd != null) {
      const mcap = parseNumberInput(document.getElementById('targetMarketCap'));
      const pp = Number(simpleConfig.preallocationPercent) || 0;
      if (Number.isFinite(mcap) && mcap > 0 && pp > 0) {
        const preallocUsd = mcap * pp / 100;
        const coverage = preallocUsd > 0 ? usd / preallocUsd : 1;
        if (coverage >= 1) {
          text += ` · fully backs preallocation ✓`;
        } else {
          const pct = Math.round(coverage * 100);
          text += ` · backs ${pct}% of preallocation`;
        }
      }
    }
    supportDisplay.textContent = text;
  }

  if (supportToggle) {
    supportToggle.addEventListener('change', (e) => {
      simpleConfig.supportEnabled = e.target.checked;
      // When the user re-enables support after disabling it (with
      // preallocation still on), restore the auto-link by default —
      // they presumably want the support to back the preallocation,
      // which is what the toggle is for. This mirrors the
      // preallocation-toggle behavior (re-enable seeds a clean state).
      if (simpleConfig.supportEnabled && simpleConfig.preallocationEnabled) {
        simpleConfig.supportAutoSize = true;
      }
      rebuildPoolsFromSimple();
      renderSimpleConfig();
      if (typeof updateContinueToFundingState === 'function') updateContinueToFundingState();
      // Toggle changes are definitive (not per-keystroke), so bypass
      // the cost-preview debounce — the user sees the updated number
      // immediately rather than waiting 500ms.
      requestCostPreviewUpdate({ immediate: true });
    });
  }

  // Auto-back-with-support toggle. Lives on the Preallocate row but
  // controls the support sizing: when on, the support SOL value is
  // clamped to a minimum equal to the preallocation USD value. The
  // user can still set a LARGER value (deeper wall) — the clamp only
  // prevents going below the floor. Disabled when preallocation is off,
  // since there's no preallocation USD to back. State name kept as
  // `supportAutoSize` for backward compat with saved configs and the
  // existing derive/wire-format code.
  const preallocAutoBackToggle = body.querySelector('#simplePreallocAutoBackToggle');
  if (preallocAutoBackToggle) {
    preallocAutoBackToggle.addEventListener('change', (e) => {
      simpleConfig.supportAutoSize = e.target.checked;
      // Enabling auto-back: bump the support SOL value up to the
      // required minimum if it's currently below. Also flip support
      // on if it was off — auto-back without support enabled is a
      // no-op and confuses the user.
      if (e.target.checked) {
        if (!simpleConfig.supportEnabled) {
          simpleConfig.supportEnabled = true;
        }
        const rec = recommendedSupportSolForPreallocation(
          Number(simpleConfig.preallocationPercent) || 0,
        );
        if (Number.isFinite(rec) && rec > (Number(simpleConfig.supportSolValue) || 0)) {
          simpleConfig.supportSolValue = rec;
        }
      }
      rebuildPoolsFromSimple();
      renderSimpleConfig();
      if (typeof updateContinueToFundingState === 'function') updateContinueToFundingState();
    });
  }

  // Auto-fit airdrop toggle. When on, the effective preallocation %
  // is automatically raised (but never lowered) to fit the airdrop
  // list. The typed % acts as a minimum floor. Toggling this triggers
  // a full re-render so the prealloc display and breakdown reflect
  // the change immediately.
  const preallocAutoFitToggle = body.querySelector('#simplePreallocAutoFitToggle');
  if (preallocAutoFitToggle) {
    preallocAutoFitToggle.addEventListener('change', (e) => {
      simpleConfig.preallocationAutoFit = e.target.checked;
      // Recompute the effective percent now — this either bumps it
      // up (auto-fit turned ON with an airdrop demand above the typed
      // floor) or returns it to the typed value (auto-fit turned OFF
      // with auto-fit previously holding a higher value).
      recomputeEffectivePreallocationPercent();
      // Auto-back sizing depends on the effective preallocation %.
      // If auto-back is also on, bump the support SOL to track the
      // new effective preallocation USD value. Customize mode skips
      // this — simple-mode support is irrelevant when each pool has
      // its own support.
      if (simpleConfig.mode !== 'customize'
          && simpleConfig.preallocationEnabled
          && simpleConfig.supportAutoSize) {
        const rec = recommendedSupportSolForPreallocation(
          simpleConfig.preallocationPercent,
        );
        if (Number.isFinite(rec) && rec > (Number(simpleConfig.supportSolValue) || 0)) {
          simpleConfig.supportSolValue = rec;
        }
      }
      preallocRebuildIfApplicable();
      preallocRerenderIfApplicable();
      if (typeof updateContinueToFundingState === 'function') updateContinueToFundingState();
    });
  }
  // Preallocation-warning "Enable Support position" link: a one-click
  // fix for the most common case where the warning fires. Turning
  // support on here also re-establishes the auto-link by default,
  // since the user is asking for the standard backed configuration.
  const preallocEnableSupportLink = body.querySelector('#simplePreallocEnableSupport');
  if (preallocEnableSupportLink) {
    preallocEnableSupportLink.addEventListener('click', (e) => {
      e.preventDefault();
      simpleConfig.supportEnabled = true;
      simpleConfig.supportAutoSize = true;
      rebuildPoolsFromSimple();
      renderSimpleConfig();
      if (typeof updateContinueToFundingState === 'function') updateContinueToFundingState();
    });
  }
  if (supportSolInput) {
    supportSolInput.addEventListener('input', (e) => {
      const typed = Number(e.target.value);
      const safeTyped = Number.isFinite(typed) && typed >= 0 ? typed : 0;
      // When Auto-back is on with preallocation enabled, clamp the
      // typed value to the required minimum. We silently bump UP (the
      // user can always go higher for a deeper wall, but not below
      // what's needed to back the preallocation). When Auto-back is
      // off, the user has full control — accept whatever they typed.
      //
      // Note: we don't write the clamped value back to the input
      // element here (would fight the user's typing). The clamp is
      // applied to stored state only; the displayed input will catch
      // up on blur or any subsequent render. refreshSimpleSupportDisplay
      // is called below to update the inline USD/coverage display so
      // the user immediately sees the effective value at work.
      let effective = safeTyped;
      if (simpleConfig.supportAutoSize && simpleConfig.preallocationEnabled) {
        const rec = recommendedSupportSolForPreallocation(
          Number(simpleConfig.preallocationPercent) || 0,
        );
        if (Number.isFinite(rec) && rec > safeTyped) {
          effective = rec;
        }
      }
      simpleConfig.supportSolValue = effective;
      rebuildPoolsFromSimpleDebounced();
      refreshSimpleSupportDisplay();
      if (typeof updateContinueToFundingState === 'function') updateContinueToFundingState();
    });
    // On blur, snap the visible input value to whatever was actually
    // stored. If Auto-back clamped the user's input upward, this is
    // when we honestly show them the value we're using. Without this,
    // a user who typed "1" with a required minimum of "5" would see
    // their "1" sitting in the field even though the stored value is
    // "5" — confusing. Also flushes any pending debounced rebuild.
    supportSolInput.addEventListener('blur', () => {
      flushRebuildPoolsFromSimple();
      const stored = Number(simpleConfig.supportSolValue) || 0;
      const typed = Number(supportSolInput.value);
      if (Number.isFinite(typed) && Math.abs(typed - stored) > 1e-9) {
        // Match the same formatting used at render time.
        supportSolInput.value = stored.toFixed(Math.abs(stored) >= 10 ? 1 : 3);
      }
    });
  }
  if (supportDepthInput) {
    supportDepthInput.addEventListener('input', (e) => {
      // Clamp at write-time so state never holds an out-of-range value.
      // We don't snap the input itself back to the clamped value during
      // typing — that would fight the user mid-keystroke (e.g. clearing
      // "1" to retype "20" would briefly read as out-of-range). The
      // clamp happens at use-sites (rebuildPoolsFromSimple, wire format,
      // display refresh), so storage is always safe.
      const v = Number(e.target.value);
      simpleConfig.supportDepthPct = Number.isFinite(v) ? v : SUPPORT_DEFAULT_DEPTH_PCT;
      rebuildPoolsFromSimpleDebounced();
      refreshSimpleSupportDisplay();
      if (typeof updateContinueToFundingState === 'function') updateContinueToFundingState();
    });
    // On blur, snap a clamped-but-out-of-range value back into the
    // visible input. This is the right time to "correct" what the user
    // typed — they've finished and we're showing them the value we'll
    // actually use. Keeps the displayed value honest without interrupting
    // their typing flow. flushRebuildPoolsFromSimple runs an immediate
    // rebuild so the clamped value lands in pool state before any
    // follow-on action (e.g. Continue click).
    supportDepthInput.addEventListener('blur', (e) => {
      const v = clampSupportDepth(e.target.value);
      simpleConfig.supportDepthPct = v;
      e.target.value = v;
      flushRebuildPoolsFromSimple();
      refreshSimpleSupportDisplay();
    });
  }

  // Persist the open/closed state of the Advanced options section
  // across re-renders. Without this, any input event that triggers a
  // re-render (e.g. typing in the support SOL input) would snap the
  // section closed mid-interaction. The toggle event fires whenever
  // the user opens or closes the <details> element.
  const advancedDetails = body.querySelector('#simpleAdvancedDetails');
  if (advancedDetails) {
    advancedDetails.addEventListener('toggle', () => {
      simpleConfig._advancedExpanded = advancedDetails.open;
    });
  }

  customizeBtn.addEventListener('click', () => {
    // Switch into customize mode. Pools stay as they are — user starts
    // tuning from the current state. The Customize button (now hidden)
    // is replaced by a "Use a preset instead" affordance in
    // the customize-mode container that switches back.
    simpleConfig.mode = 'customize';
    applySimpleConfigMode();
  });

  // Move the Lock-liquidity field into the Advanced slot. We detached
  // it at the top of this function (before the innerHTML rebuild) and
  // parked it at the page-level home; now that the new Advanced slot
  // exists in the DOM, move it there. This keeps the field visible
  // inside Advanced in simple mode while preserving its identity as
  // a single DOM element.
  relocateLockPositionsField('simple');

  // Relocate the preallocation block based on mode. In simple mode it
  // stays where renderSimpleConfig just rendered it (inside the
  // Advanced details). In customize mode we move it to the slot above
  // the pool list. Same appendChild move pattern as lockPositionsField:
  // handlers wired by the prealloc/airdrop setup above are attached
  // directly to the block's children, so they survive the move.
  relocatePreallocationBlock();

  // Restore the scroll offset captured at the top, now that every DOM
  // mutation (the innerHTML rebuild plus the relocate moves above) has
  // settled. Done synchronously inside the change handler, so the view is
  // pinned before the browser paints — no visible jump.
  _scroller.scrollTop = _savedScrollTop;
}

// Move the #preallocationBlock element between its two homes:
//
//   simpleConfig.mode === 'default'   → leave it inside the simple
//                                        container's Advanced section
//                                        (its natural location after
//                                        renderSimpleConfig)
//   simpleConfig.mode === 'customize' → into #customizePreallocSlot,
//                                        which lives above the pool
//                                        list in customize mode
//
// Idempotent: re-running with the same mode is a no-op (appendChild
// of an already-correct parent does nothing). Safe to call whenever
// the mode might have changed without tracking previous mode.
function relocatePreallocationBlock() {
  const block = document.getElementById('preallocationBlock');
  if (!block) return;
  if (simpleConfig.mode === 'customize') {
    const slot = document.getElementById('customizePreallocSlot');
    if (slot && block.parentElement !== slot) {
      slot.appendChild(block);
    }
  }
  // Simple mode: block already sits in the simple container's Advanced
  // section where renderSimpleConfig placed it. No move needed.
}

// ===========================================================================
// Flywheel explainer modal
// ===========================================================================
//
// Static content — no per-instance data, just an explanation of what
// flywheels are and which one the user should pick. Triggered by the
// "Learn more" link next to the flywheel toggle in the simple-config
// block. Modal markup lives in index.html; this just toggles visibility
// and wires up the close handlers.
//
// The close handlers are attached lazily on first open rather than at
// module load. Reason: the <script src="app.js"> tag appears in
// index.html BEFORE the modal markup, so the modal's elements don't
// exist when the script first runs — a top-level attachment would
// silently no-op (document.getElementById returns null). Same pattern
// the token-info modal uses; the dataset.closeHandlersWired flag
// prevents duplicate listeners on repeat opens.

function openFlywheelInfoModal() {
  const modal = document.getElementById('flywheelInfoModal');
  if (!modal) return;

  // Wire up close affordances on first open. Three ways to dismiss:
  // the X in the header, the "Got it" button in the footer, and
  // clicking the background overlay. The dataset flag makes this
  // idempotent across reopens.
  if (!modal.dataset.closeHandlersWired) {
    const close = () => modal.classList.remove('is-active');
    ['flywheelInfoCloseBtn', 'flywheelInfoDismissBtn', 'flywheelInfoBackground']
      .forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('click', close);
      });
    modal.dataset.closeHandlersWired = '1';
  }

  modal.classList.add('is-active');
}

// Apply the current simpleConfig.mode to the page: hides one container,
// shows the other, and re-renders the appropriate side. Called once on
// page init and on every mode change. Uses the existing .hidden class
// so the visibility toggle is purely CSS, no display-juggling needed.
function applySimpleConfigMode() {
  const simpleC = document.getElementById('simpleConfigContainer');
  const customC = document.getElementById('customizeConfigContainer');
  if (!simpleC || !customC) return;

  if (simpleConfig.mode === 'default') {
    simpleC.classList.remove('hidden');
    customC.classList.add('hidden');
    renderSimpleConfig();
    // Move the Lock-liquidity field into the Advanced details slot
    // inside simple mode. This is done AFTER renderSimpleConfig so the
    // slot element exists. The field is the same DOM element that
    // lives at #lockPositionsSlotPage in customize mode — we physically
    // relocate it between modes rather than duplicating, so the
    // checkbox state and any external listeners stay attached to a
    // single canonical element.
    relocateLockPositionsField('simple');
  } else {
    simpleC.classList.add('hidden');
    customC.classList.remove('hidden');
    // renderSimpleConfig still needs to run in customize mode — it
    // builds the preallocation block (and wires its handlers), which
    // relocatePreallocationBlock (called inside renderSimpleConfig)
    // then moves into #customizePreallocSlot above the pool list.
    // The simple container itself stays hidden; we only need its DOM
    // contents to exist so the block can be detached from it. The
    // mode-aware HTML in the prealloc block hides the auto-back toggle
    // and the "Enable Support position" link in customize mode (those
    // refer to the simple-mode support row which isn't visible here).
    renderSimpleConfig();
    renderPools();
    // Move the Lock-liquidity field back to its page-level home so
    // customize-mode users can access it.
    relocateLockPositionsField('customize');
  }
}

// Move the #lockPositionsField element between its two homes:
//
//   target='simple'    → into the Advanced options slot inside simple mode
//   target='customize' → back to the page-level slot (below the customize
//                        container, where it lives by default)
//
// No-ops if the field or the target slot can't be found (e.g. called
// before the DOM is built, or with an unknown target). The same single
// DOM element moves between locations; its state (checked/unchecked)
// and any attached listeners are preserved by appendChild.
function relocateLockPositionsField(target) {
  const field = document.getElementById('lockPositionsField');
  if (!field) return;
  let slot;
  if (target === 'simple') {
    slot = document.getElementById('lockPositionsSlotSimple');
  } else {
    slot = document.getElementById('lockPositionsSlotPage');
  }
  if (!slot) return;
  // appendChild moves the element if it has a parent; no need to
  // detach first. Re-appending into the same slot is a no-op (the
  // element is already a child).
  if (field.parentElement !== slot) {
    slot.appendChild(field);
  }
}

// ---------------------------------------------------------------------------
// Live token preview card
// ---------------------------------------------------------------------------
//
// Mirrors the per-pool resolved-info card shape. Updates on every input
// event from the token-details fields so the user sees their token
// take shape as they type.
//
// We hold a single object URL for the user-selected logo. Each new file
// selection revokes the previous URL before creating a new one — keeps
// memory tidy and avoids leaking blob handles. Revoking is also done
// when the file is cleared (length 0) and on logo-not-set fallback.
let _tokenPreviewLogoObjectUrl = null;

// Set once we've attached the capture-phase image-error listener to the
// preview block (so a broken pool-logo URL in a chip degrades to the letter
// fallback). Guards against re-adding the listener on every re-render.
let _previewLogoFailBound = false;

// ===========================================================================
// 3D coin preview lifecycle
// ---------------------------------------------------------------------------
// The coin (coinRenderer.js, backed by vendored three.js) replaces the flat
// logo circle in the preview card. Front face = the uploaded token logo
// (same-origin blob); back face = the largest pool's quote-token logo (remote
// https, with a symbol fallback on CORS failure). We init the WebGL context
// once and then only swap face textures — never tear down and rebuild per
// keystroke. The whole thing is feature-flagged so it can be disabled for
// weak hardware or when WebGL/the script isn't available.
// ===========================================================================

// 3D coin preferences. Both persist in userPrefs.json and have settings-
// panel toggles:
//   coinPreview       — show the 3D coin at all (off → flat logo fallback).
//   coinPreviewParked — hold a fixed pose (logo forward, yawed ~30° so the
//                       relief and reeded edge still read as 3D) instead of
//                       spinning. Deterministic pixels for screenshots, and
//                       the renderer idles its loop when parked.
// Defaults match userPrefs.js; values load async below, and the coin only
// attaches at step 2 — long after the boot-time prefs fetch resolves — so
// the first attach sees real values.
let coinPreviewEnabled = true;
let coinParked = false;
// Remembers the last front URL and back signature we pushed, so we only
// rebuild a face texture when its source actually changed (texture uploads
// are the expensive part; debounce-by-equality avoids thrashing them).
let _coinFrontUrl = null;
let _coinBackSig = null;
let _coinBackUpdateTimer = null;

// The pool whose quote token shows on the back of the coin: the one holding
// the most of the token's supply (highest supplyPercent). Usually the SOL
// pool. Returns null when there are no pools yet.
function largestPool(poolList) {
  if (!Array.isArray(poolList) || poolList.length === 0) return null;
  return poolList.reduce(
    (best, p) => (Number(p.supplyPercent) > Number(best ? best.supplyPercent : -1) ? p : best),
    null,
  );
}

// Can the coin run right now? Needs: the feature flag on, the global present
// (script loaded), and a usable WebGL context. We probe WebGL once.
let _webglOk = null;
function webglAvailable() {
  if (_webglOk !== null) return _webglOk;
  try {
    const c = document.createElement('canvas');
    _webglOk = !!(window.WebGLRenderingContext &&
      (c.getContext('webgl') || c.getContext('experimental-webgl')));
  } catch (e) {
    _webglOk = false;
  }
  return _webglOk;
}
function coinCanRun() {
  return coinPreviewEnabled &&
    typeof window.coinRenderer !== 'undefined' &&
    typeof THREE !== 'undefined' &&
    webglAvailable();
}

// Wrap a remote logo URL so it loads from our own origin. The 3D coin draws
// the back-face logo into a WebGL texture, which needs CORS-clean pixels;
// many logo hosts don't send CORS headers, so we route through the local
// /api/proxy-image passthrough (same-origin → no CORS, canvas not tainted).
// Same-origin/blob URLs are returned unchanged. This is only needed for the
// canvas/WebGL path — plain <img> tags (pool rows, preview chips) display any
// URL directly, which is why those already work.
function proxiedImageUrl(url) {
  if (!url) return null;
  if (/^(blob:|data:)/i.test(url)) return url;
  if (url.startsWith('/')) return url; // already same-origin
  return '/api/proxy-image?url=' + encodeURIComponent(url);
}

// Compute the back face source from the current pools. Returns
// { url, symbol } — url may be null (then the symbol is embossed instead).
function coinBackSource() {
  const pool = largestPool(pools);
  if (!pool) return { url: null, symbol: 'SOL' };
  return {
    // Proxy the remote logo so the coin's WebGL texture can read it (CORS).
    url: proxiedImageUrl(pool.resolvedImageUrl) || null,
    symbol: pool.resolvedSymbol || pool.quoteSelect || 'SOL',
  };
}

// Main entry, called from renderTokenPreview() after the card markup exists.
// Initialises the coin on first use, then updates faces only as needed.
function updateCoinPreview(frontUrl, symbol) {
  if (!coinCanRun()) return;
  const mount = document.getElementById('tokenPreviewCoin');
  if (!mount) return;

  // Init once. coinRenderer.init() is a no-op if already initialised.
  if (!window.coinRenderer.isActive()) {
    window.coinRenderer.init(mount);
    // Force a fresh push of both faces after init.
    _coinFrontUrl = undefined;
    _coinBackSig = undefined;
    window.coinRenderer.setParked(coinParked);
  } else if (!mount.querySelector('canvas')) {
    // Already initialised, but this mount has no canvas — the surrounding DOM
    // was re-rendered (e.g. entering "review completed step" rebuilds the
    // step), detaching our canvas. Move the live canvas into the new mount
    // instead of spinning up a second WebGL context.
    window.coinRenderer.reattach(mount);
  }

  // The live 3D coin is mounted, so hide the flat fallback logo that sits
  // behind the canvas — otherwise it shows through when the coin spins
  // edge-on (the canvas is transparent there). CSS keys off this class.
  mount.classList.add('coin-live');

  // Front face: rebuild only when the logo URL changed.
  if (frontUrl !== _coinFrontUrl) {
    _coinFrontUrl = frontUrl;
    const back = coinBackSource();
    // setFaces pushes both; the back rebuild is cheap relative to gating.
    window.coinRenderer.setFaces(frontUrl || null, back.url, back.symbol);
    _coinBackSig = back.url + '|' + back.symbol;
  }
}

// Back-face refresh, called after resolvePoolQuote() updates pool data.
// Debounced so a burst of pool edits doesn't thrash texture uploads.
function refreshCoinBackFace() {
  if (!coinCanRun()) return;
  if (!window.coinRenderer.isActive()) return;
  if (_coinBackUpdateTimer) clearTimeout(_coinBackUpdateTimer);
  _coinBackUpdateTimer = setTimeout(() => {
    _coinBackUpdateTimer = null;
    const back = coinBackSource();
    const sig = back.url + '|' + back.symbol;
    if (sig === _coinBackSig) return; // no change
    _coinBackSig = sig;
    if (back.url) {
      window.coinRenderer.setFaces(_coinFrontUrl || null, back.url, back.symbol);
    } else {
      window.coinRenderer.setBackSymbol(back.symbol);
    }
  }, 250);
}

// Tear the coin down (frees the WebGL context). Called when leaving the
// create-token screen / on reset.
function destroyCoinPreview() {
  if (typeof window.coinRenderer === 'undefined') return;
  if (window.coinRenderer.isActive()) window.coinRenderer.destroy();
  _coinFrontUrl = null;
  _coinBackSig = null;
  if (_coinBackUpdateTimer) {
    clearTimeout(_coinBackUpdateTimer);
    _coinBackUpdateTimer = null;
  }
  // Drop the coin-live marker so that if the mount is visible without a live
  // coin (e.g. the canvas was torn down while step 2 is still on screen) the
  // flat fallback logo shows through instead of a blank circle.
  const mount = document.getElementById('tokenPreviewCoin');
  if (mount) mount.classList.remove('coin-live');
}

// Build the live stat grid shown in the preview card: token facts (supply,
// market cap, start price, decimals) plus pool configuration (how many pools,
// which quote tokens, what share of supply goes to liquidity) and the running
// launch-cost estimate. Reads straight from the inputs, the live `pools`
// array, and the cached `_lastCostEstimate`, so it always reflects the
// current config. Returns a self-contained #tokenPreviewStats element.
function buildPreviewStatsHtml() {
  const supplyEl = document.getElementById('tokenSupply');
  const mcEl = document.getElementById('targetMarketCap');
  const supply = supplyEl ? parseNumberInput(supplyEl) : NaN;
  const mc = mcEl ? parseNumberInput(mcEl) : NaN;
  const supplyValid = Number.isFinite(supply) && supply > 0;
  const mcValid = Number.isFinite(mc) && mc > 0;

  // --- Hero tiles: the few numbers worth reading at a glance. Each is
  //     shown only when we actually have it; they flex to share the row. ---
  const tiles = [];
  const addTile = (label, value, valueClass) => {
    tiles.push(
      `<div class="tps-tile">` +
        `<div class="tps-tile-label">${escapeHtml(label)}</div>` +
        `<div class="tps-tile-value${valueClass ? ' ' + valueClass : ''}">` +
        `${escapeHtml(value)}</div>` +
      `</div>`
    );
  };
  if (mcValid) addTile('Market cap', '$' + mc.toLocaleString());
  if (supplyValid && mcValid) {
    const priceText = formatPreviewPrice(mc / supply);
    if (priceText) addTile('Start price', priceText);
  }
  if (_lastCostEstimate && Number.isFinite(_lastCostEstimate.totalSol)) {
    // Airdrop execution (ATA rent + tx fees per recipient) is computed
    // client-side and added on top of the server's launch-funding total
    // since the server doesn't yet know about the airdrop list. When
    // airdrop is disabled or empty this returns 0.
    const airdropExecutionSol = computeAirdropExecutionCostSol();
    const grandTotal = _lastCostEstimate.totalSol + airdropExecutionSol;
    addTile('Est. cost', `≈ ${grandTotal.toFixed(3)} SOL`, 'is-cost');
  }
  const tilesHtml = tiles.length ? `<div class="tps-tiles">${tiles.join('')}</div>` : '';

  // --- Meta line: supporting facts that don't need their own tile. ---
  const meta = [];
  if (supplyValid) meta.push(`${supply.toLocaleString()} supply`);
  if (Array.isArray(pools) && pools.length) {
    const alloc = pools.reduce((s, p) => s + (Number(p.supplyPercent) || 0), 0);
    if (alloc > 0) {
      const allocText = (alloc % 1 === 0) ? alloc.toFixed(0) : alloc.toFixed(1);
      meta.push(`${allocText}% to liquidity`);
    }
    // When the pool allocations leave some supply uncommitted (sum < 100),
    // call out the gap explicitly as "preallocated". Works in both
    // simple-mode (where the user enables preallocation via the toggle)
    // and customize-mode (where they manually set lower pool percentages).
    // We surface the larger of (100 - alloc) and the simpleConfig pct so
    // the display stays consistent across mode switches.
    const gap = Math.max(0, 100 - alloc);
    if (gap > 0.01) {
      const gapText = (gap % 1 === 0) ? gap.toFixed(0) : gap.toFixed(1);
      meta.push(`${gapText}% preallocated`);
    }
  }
  const metaHtml = `<div class="tps-meta">${meta.map(escapeHtml).join(' &middot; ')}</div>`;

  // --- Pool chips: one pill per unique quote token, with friendly labels
  //     (resolved symbol, override, or a shortened mint — never a raw
  //     44-char address). Updates live as pools are configured. ---
  let chipsHtml = '';
  if (Array.isArray(pools) && pools.length) {
    const seen = new Set();
    const chips = [];
    for (const p of pools) {
      const label = poolQuoteLabel(p);
      const key = label.toUpperCase();
      if (seen.has(key)) continue;
      seen.add(key);
      // Round logo when we have an image URL, otherwise a coloured initial
      // circle — mirrors the pool-editor logos (updatePoolLogo) so the
      // preview reads consistently. Logo-only (no ticker text); the symbol is
      // kept as a hover title for accessibility. A plain <img> displays any
      // remote URL directly (no CORS needed for display — same as the pool
      // rows), with a fail-to-initial fallback for broken/blocked URLs.
      const initial = (label.charAt(0) || '?').toUpperCase();
      const safeLabel = escapeHtml(label);
      const safeInitial = escapeHtml(initial);
      if (p.resolvedImageUrl) {
        chips.push(
          `<span class="tps-pool-logo" title="${safeLabel}" ` +
                `data-fallback-initial="${safeInitial}">` +
            `<img src="${escapeHtml(p.resolvedImageUrl)}" alt="${safeLabel}" ` +
                 `loading="lazy" data-action="preview-pool-logo-fail">` +
          `</span>`
        );
      } else {
        chips.push(
          `<span class="tps-pool-logo tps-pool-logo-fallback" title="${safeLabel}">` +
            safeInitial +
          `</span>`
        );
      }
    }
    chipsHtml =
      `<div class="tps-pools">` +
        `<span class="tps-pools-label">${pools.length === 1 ? 'Pool' : 'Pools'}</span>` +
        chips.join('') +
      `</div>`;
  }

  return `<div class="token-preview-stats" id="tokenPreviewStats">` +
    tilesHtml + metaHtml + chipsHtml +
  `</div>`;
}

// Lightweight refresh of just the stat grid — no logo/coin work — so it's
// cheap to call on every pool edit and cost-estimate update without
// thrashing the WebGL coin texture. No-ops until renderTokenPreview() has
// built the card (then it just swaps the grid in place).
function updatePreviewStats() {
  const existing = document.getElementById('tokenPreviewStats');
  if (!existing) return;
  existing.outerHTML = buildPreviewStatsHtml();
}


// ===========================================================================
// 3D coin preference wiring — mirrors the audio module's pattern: read
// persisted prefs once at boot, reflect them into the settings-panel
// checkboxes, persist changes fire-and-forget.
// ===========================================================================

function _persistCoinPref(key, value) {
  fetch('/api/user-prefs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ [key]: value }),
  }).catch((err) => {
    console.warn(`coin: failed to persist ${key}:`, err);
  });
}

function _loadCoinPrefs() {
  fetch('/api/user-prefs')
    .then((r) => r.json())
    .then((data) => {
      if (data && data.prefs) {
        coinPreviewEnabled = data.prefs.coinPreview !== false;
        coinParked = data.prefs.coinPreviewParked === true;
      }
      const showToggle = document.getElementById('coinPreviewToggle');
      if (showToggle) showToggle.checked = coinPreviewEnabled;
      const parkToggle = document.getElementById('coinParkedToggle');
      if (parkToggle) parkToggle.checked = coinParked;
      // If the coin somehow attached before prefs resolved, apply now.
      if (window.coinRenderer && window.coinRenderer.isActive()) {
        window.coinRenderer.setParked(coinParked);
      }
    })
    .catch((err) => {
      console.warn('coin: failed to read preferences, using defaults:', err);
    });
}

function _wireCoinSettingsToggles() {
  const showToggle = document.getElementById('coinPreviewToggle');
  if (showToggle) {
    showToggle.addEventListener('change', () => {
      coinPreviewEnabled = showToggle.checked;
      _persistCoinPref('coinPreview', coinPreviewEnabled);
      if (!coinPreviewEnabled && window.coinRenderer && window.coinRenderer.isActive()) {
        // Tear the context down (browsers cap live WebGL contexts) — the
        // re-render below falls back to the flat logo via coinCanRun().
        window.coinRenderer.destroy();
      }
      // Rebuild the preview card so the change applies immediately. The
      // modules share one scope after concatenation, but stay defensive
      // in case the preview hasn't been built yet.
      if (typeof renderTokenPreview === 'function') renderTokenPreview();
    });
  }

  const parkToggle = document.getElementById('coinParkedToggle');
  if (parkToggle) {
    parkToggle.addEventListener('change', () => {
      coinParked = parkToggle.checked;
      _persistCoinPref('coinPreviewParked', coinParked);
      if (window.coinRenderer && window.coinRenderer.isActive()) {
        window.coinRenderer.setParked(coinParked);
      }
    });
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    _loadCoinPrefs();
    _wireCoinSettingsToggles();
  });
} else {
  _loadCoinPrefs();
  _wireCoinSettingsToggles();
}
// depth-chart.js
//
// A small, dependency-free liquidity-depth chart for a SINGLE pool. Shared by
// two places:
//   - the pool editor, drawn live near the top of each pool as the user tweaks
//     bootstrap / ladder / distribution, and
//   - the launch report, drawn per pool.
//
// It shows where a pool's token-side liquidity sits across price: a flat
// baseline from the wide band, with taller "teeth" where ladder bands add
// depth, and valleys (or true empty gaps) in between. Thicker = price moves
// slower there; valleys = price runs faster. It's the same comb the buy
// simulator integrates over, drawn as a picture.
//
// Important shape facts that keep this simple:
//   - The comb's SHAPE is invariant to launch price AND total supply — those
//     just scale everything together. So we work in "× launch" price units
//     (launch = 1) and pool-relative liquidity. The chart only needs the pool's
//     own config and re-draws only when that pool changes.
//   - The UI carries ladder bands in manual form with "% of pool" semantics
//     (see buildAllocationsForApi), and each band's price range is its
//     lower/upper multiplier — no tick math required for a picture.
//
// Colors are hardcoded to the parchment palette (rather than CSS variables) so
// the SVG renders identically inside the app and inside the standalone,
// downloadable launch report, which doesn't carry the app's :root tokens.

// (Liquidity helpers live inside computeDepthProfile, since token-side and
// quote-side positions use different formulas.)

// Build the depth profile for one pool from its UI config.
//
// Token-side bands (wide + ladder, above launch) are denominated in tokens;
// the optional support position (below launch) is denominated in quote. To draw
// them on one comparable axis we work in USD value: a token band's value is its
// token fraction × the pool's notional (supplyPercent% × target market cap), and
// support's value is its SOL × the SOL price. CLMM liquidity L scaled this way
// is unit-consistent across the two sides, so heights are directly comparable.
//
// When the USD scaling inputs aren't available (no market cap / SOL price yet)
// we fall back to pool-relative token-side only — support is simply omitted.
//
// @param {object} opts  { poolNotionalUsd, support: { usd, depthPct } } — all
//   optional. Without poolNotionalUsd the token side is drawn in relative terms
//   and support is skipped.
// @returns {{ segments, minX, maxX, maxL, bands, hasWide, hasBootstrap,
//             hasLadder, hasSupport }}
function computeDepthProfile(pool, opts = {}) {
  if (!pool) return null;
  const pct = (v) => (Number(v) || 0) / 100;

  const bs = pool.bootstrapConfig || { mode: 'minimal' };
  const bootstrapFrac = bs.mode === 'custom' ? pct(bs.supplyPercent) : 0;

  const ld = pool.ladderConfig || { mode: 'off', bands: [] };
  const ladderBands = (ld.mode === 'manual' && Array.isArray(ld.bands))
    ? ld.bands
        .map((b) => ({ frac: pct(b.supplyPercent), lo: Number(b.lowerMultiplier), hi: Number(b.upperMultiplier) }))
        .filter((b) => b.frac > 0 && b.lo >= 1 && b.hi > b.lo)
    : [];
  const ladderTotal = ladderBands.reduce((s, b) => s + b.frac, 0);
  const wideFrac = Math.max(0, 1 - bootstrapFrac - ladderTotal);

  const ladderTop = ladderBands.length ? Math.max(...ladderBands.map((b) => b.hi)) : 0;
  const capX = ladderTop > 1 ? ladderTop : 10;

  // Token-side amount -> USD value when we have a pool notional; otherwise the
  // bare fraction (relative shape only). The choice is consistent across all
  // token bands, so their relative shape is identical either way.
  const notional = Number(opts.poolNotionalUsd) > 0 ? Number(opts.poolNotionalUsd) : 0;
  const tokenValue = (frac) => notional > 0 ? frac * notional : frac;

  // Liquidity L for a token-side (base) position over [lo, hi] above launch.
  const Ltoken = (value, lo, hi) => {
    const d = 1 / Math.sqrt(lo) - 1 / Math.sqrt(hi);
    return d > 0 ? value / d : 0;
  };
  // Liquidity L for a quote-side position over [lo, hi] below launch.
  const Lquote = (value, lo, hi) => {
    const d = Math.sqrt(hi) - Math.sqrt(lo);
    return d > 0 ? value / d : 0;
  };

  // Support: only placeable on the shared axis when we can value it (needs the
  // pool notional to compare against, plus the support USD and a depth).
  const support = opts.support || null;
  const supportUsd = support ? Number(support.usd) : 0;
  const supportDepthPct = support ? Number(support.depthPct) : 0;
  const canPlaceSupport = notional > 0 && supportUsd > 0 && supportDepthPct > 0;
  const supportLo = canPlaceSupport ? Math.max(0.05, 1 - supportDepthPct / 100) : 1;

  // Components in stacking order: support (below launch), wide, bootstrap,
  // ladder bands. Each carries its identity so the chart can colour and label.
  const comps = [];
  if (canPlaceSupport) comps.push({ kind: 'support', lo: supportLo, hi: 1, L: Lquote(supportUsd, supportLo, 1) });
  if (wideFrac > 0) comps.push({ kind: 'wide', lo: 1, hi: capX, L: Ltoken(tokenValue(wideFrac), 1, capX) });
  if (bootstrapFrac > 0) comps.push({ kind: 'bootstrap', lo: 1, hi: 1.15, L: Ltoken(tokenValue(bootstrapFrac), 1, 1.15) });
  ladderBands.forEach((b, i) => comps.push({ kind: 'ladder', index: i, lo: b.lo, hi: b.hi, L: Ltoken(tokenValue(b.frac), b.lo, b.hi) }));
  if (comps.length === 0) return null;

  const minX = canPlaceSupport ? supportLo : 1;

  // Merge into segments; each records the stacked components present.
  const edges = new Set([minX, 1, capX]);
  for (const c of comps) { edges.add(c.lo); edges.add(c.hi); }
  const xs = Array.from(edges).filter((x) => x >= minX - 1e-9 && x <= capX * 1.0001).sort((a, b) => a - b);

  const segments = [];
  let maxL = 0;
  for (let i = 0; i < xs.length - 1; i++) {
    const lo = xs[i];
    const hi = xs[i + 1];
    if (hi <= lo) continue;
    const parts = [];
    let total = 0;
    for (const c of comps) {
      if (c.lo <= lo + 1e-9 && c.hi >= hi - 1e-9) { parts.push({ kind: c.kind, index: c.index, L: c.L }); total += c.L; }
    }
    segments.push({ loX: lo, hiX: hi, parts, total });
    if (total > maxL) maxL = total;
  }

  return {
    segments,
    minX,
    maxX: capX,
    maxL: maxL || 1,
    bands: ladderBands.map((b, i) => ({ index: i, lo: b.lo, hi: b.hi })),
    hasWide: wideFrac > 0,
    hasBootstrap: bootstrapFrac > 0,
    hasLadder: ladderBands.length > 0,
    hasSupport: canPlaceSupport,
    supportDepthPct: canPlaceSupport ? supportDepthPct : 0,
  };
}

// Render a depth profile as a self-contained inline SVG + HTML legend string.
// Each position (wide band, optional bootstrap, each ladder band) is a distinct
// colour, stacked so the total height is the real (additive) liquidity, with a
// crisp outline over the top and a legend tying colours to band numbers and
// price ranges. Returns '' when there's no ladder (nothing worth showing).
//
// opts.compact (default false) trims the chart for the simple-mode strategy
// preview: it drops the explanatory caption and shortens the legend labels.
// Customize mode and the launch report call it without compact, so they keep
// the full caption and labels.
function renderDepthChartSvg(profile, opts = {}) {
  const INK = '#1c1610';
  const compact = opts && opts.compact === true;
  if (!profile || !profile.segments || !profile.segments.length || (!profile.hasLadder && !profile.hasSupport)) return '';

  // Earthy, parchment-friendly palette. Support (buy wall, below launch) = a
  // muted green; wide baseline = tan; bootstrap = soft brown; ladder bands
  // cycle a categorical set.
  const SUPPORT = '#4f8a5a';
  const WIDE = '#d8c39a';
  const BOOTSTRAP = '#b39a72';
  const PALETTE = ['#9a2424', '#2f6f5e', '#c0871f', '#3f5a8a', '#8a3f6a', '#5f6a2a', '#7a4a2a'];
  const colorOf = (p) => p.kind === 'support' ? SUPPORT
    : (p.kind === 'wide' ? WIDE : (p.kind === 'bootstrap' ? BOOTSTRAP : PALETTE[p.index % PALETTE.length]));
  // Compact, consistent multiplier labels for the axis ticks and the legend's
  // band ranges. Bands land on log-spaced boundaries (1.56×, 3.81×, …), so we
  // keep one decimal below 10 (trailing .0 stripped) and whole numbers from 10
  // up, with k/M/B/T grouping above a thousand and scientific past 1e15 — so
  // the legend stops mixing "1.56" with "23".
  const fmtMult = (m) => {
    if (!Number.isFinite(m) || m <= 0) return '0';
    if (m >= 1e15) return m.toExponential(1).replace('e+', 'e');
    let v = m;
    let suffix = '';
    if (m >= 1e12) { v = m / 1e12; suffix = 'T'; }
    else if (m >= 1e9) { v = m / 1e9; suffix = 'B'; }
    else if (m >= 1e6) { v = m / 1e6; suffix = 'M'; }
    else if (m >= 1e3) { v = m / 1e3; suffix = 'k'; }
    const s = v < 10 ? v.toFixed(1).replace(/\.0$/, '') : String(Math.round(v));
    return s + suffix;
  };

  const W = 560, H = 184;
  const padL = 14, padR = 14, padT = 24, padB = 30;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const x0 = padL;
  const yBase = H - padB;
  const yTopPlot = padT;

  // Log x over the full range, which can dip below 1× when support is present.
  const lmin = Math.log(profile.minX);
  const lspan = (Math.log(profile.maxX) - lmin) || 1;
  const X = (x) => x0 + ((Math.log(x) - lmin) / lspan) * plotW;
  const hAt = (L) => (L / profile.maxL) * plotH;

  // Stacked fills (bottom -> top); no per-rect stroke so same-colour neighbours
  // read as one block.
  let fills = '';
  for (const s of profile.segments) {
    const xa = X(s.loX);
    const w = X(s.hiX) - xa;
    if (w <= 0) continue;
    let cum = 0;
    for (const p of s.parts) {
      const h = hAt(p.L);
      if (h <= 0) continue;
      fills += `<rect x="${xa.toFixed(1)}" y="${(yBase - cum - h).toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" fill="${colorOf(p)}" fill-opacity="0.92"/>`;
      cum += h;
    }
  }

  // Crisp outline along the top of the total stack.
  let d = `M ${X(profile.segments[0].loX).toFixed(1)} ${yBase.toFixed(1)}`;
  for (const s of profile.segments) {
    const y = (yBase - hAt(s.total)).toFixed(1);
    d += ` L ${X(s.loX).toFixed(1)} ${y} L ${X(s.hiX).toFixed(1)} ${y}`;
  }
  d += ` L ${X(profile.segments[profile.segments.length - 1].hiX).toFixed(1)} ${yBase.toFixed(1)}`;

  // The launch line (1×) — the divider between the support buy-wall (left) and
  // the token-side resistance (right).
  const launchX = X(1);
  // Divider line only. The "launch" wording now lives on the 1× tick label
  // below the axis ("1× launch"); the old floating word up here collided with
  // the LIQUIDITY DEPTH title, so it's gone.
  const launchMark = `<line x1="${launchX.toFixed(1)}" y1="${(yTopPlot - 2).toFixed(1)}" x2="${launchX.toFixed(1)}" y2="${yBase}" stroke="${INK}" stroke-width="0.8" stroke-dasharray="3 3" opacity="0.55"/>`;

  // x ticks. The left of the axis is anchored at the launch line with a single
  // "1× launch" label — we no longer tick the support floor (its depth is
  // already stated in the legend), which is what used to crowd the near-1×
  // region. Powers of ten fill in above launch; the ends always get a tick;
  // anything that would collide is dropped.
  const candidatesSet = new Set([1, profile.maxX]);
  for (let p = 1; p <= profile.maxX * 1.0001; p *= 10) candidatesSet.add(p);
  const candidates = Array.from(candidatesSet).filter((t) => t >= 1 && t <= profile.maxX * 1.0001).sort((a, b) => a - b);
  const ticks = [];
  let lastX = -Infinity;
  candidates.forEach((t, i) => {
    const xx = X(t);
    const isEnd = i === 0 || i === candidates.length - 1;
    if (isEnd || xx - lastX >= 44) { ticks.push(t); lastX = xx; }
  });
  const tickMarks = ticks.map((t) => {
    const x = X(t);
    const isLaunch = Math.abs(t - 1) < 1e-9;
    const label = isLaunch ? '1× launch' : `${fmtMult(t)}×`;
    // Launch label starts at the line (not centered) so it doesn't clip the
    // left edge — X(1) sits close to x0 when a support wall pushes minX < 1×.
    const anchor = isLaunch ? 'start' : (x >= x0 + plotW - 2 ? 'end' : 'middle');
    return `<line x1="${x.toFixed(1)}" y1="${yBase}" x2="${x.toFixed(1)}" y2="${(yBase + 4).toFixed(1)}" stroke="${INK}" stroke-width="0.75" opacity="0.45"/>`
      + `<text x="${x.toFixed(1)}" y="${(yBase + 16).toFixed(1)}" text-anchor="${anchor}" font-family="'JetBrains Mono',monospace" font-size="10" fill="${INK}" opacity="0.7">${label}</text>`;
  }).join('');

  const svg = `
<svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Stacked liquidity depth across price: a support buy wall below launch, then the wide band and ladder bands stacked above launch.">
  ${fills}
  ${launchMark}
  <path d="${d}" fill="none" stroke="${INK}" stroke-width="1.1" stroke-linejoin="round" opacity="0.85"/>
  <line x1="${x0}" y1="${yBase}" x2="${(x0 + plotW).toFixed(1)}" y2="${yBase}" stroke="${INK}" stroke-width="0.9" opacity="0.65"/>
  <text x="${x0}" y="14" font-family="'JetBrains Mono',monospace" font-size="10" letter-spacing="0.5" fill="${INK}" opacity="0.75">LIQUIDITY DEPTH</text>
  <text x="${(x0 + plotW).toFixed(1)}" y="14" text-anchor="end" font-family="'JetBrains Mono',monospace" font-size="10" fill="${INK}" opacity="0.5">price × launch &#8594;</text>
  ${tickMarks}
</svg>`;

  // HTML legend.
  const swatch = (c) => `<span style="display:inline-block;width:11px;height:11px;background:${c};border:0.5px solid rgba(28,22,16,0.35);border-radius:2px;vertical-align:-1px;margin-right:5px;"></span>`;
  const items = [];
  if (profile.hasSupport) {
    const supportLabel = compact
      ? 'Support'
      : `Support &middot; buy wall to &minus;${Math.round(profile.supportDepthPct)}%`;
    items.push(`<span style="white-space:nowrap;">${swatch(SUPPORT)}${supportLabel}</span>`);
  }
  if (profile.hasWide) items.push(`<span style="white-space:nowrap;">${swatch(WIDE)}Wide band</span>`);
  if (profile.hasBootstrap) items.push(`<span style="white-space:nowrap;">${swatch(BOOTSTRAP)}Bootstrap</span>`);
  for (const b of profile.bands) {
    // Bare band number — the swatch colour and the "1× launch / 10× / …" axis
    // already make clear these are the ladder bands; the "Band" prefix was
    // just noise.
    items.push(`<span style="white-space:nowrap;">${swatch(PALETTE[b.index % PALETTE.length])}${b.index + 1}</span>`);
  }
  const legend = `<div style="display:flex;flex-wrap:wrap;gap:5px 14px;margin-top:7px;font-family:'JetBrains Mono',monospace;font-size:11px;color:${INK};opacity:0.9;">${items.join('')}</div>`;
  const caption = `<p style="margin:6px 0 0;font-family:'JetBrains Mono',monospace;font-size:11px;line-height:1.4;color:${INK};opacity:0.6;">Each colour is one position. Height is <em>liquidity depth</em> &mdash; how hard it is to move price through that range (taller = price moves slower), <em>not</em> dollar value, market cap, or token count. Depth is constant across a position's range, so each block is flat; the same supply sits deeper when placed higher or in a tighter range. Left of <em>launch</em> is the support buy wall; right of it is token-side resistance.</p>`;

  // Compact (simple-mode preview) drops the caption; the full explanation
  // lives in customize mode where there's room for it.
  return `<div style="width:100%;">${svg}${legend}${compact ? '' : caption}</div>`;
}
function renderTokenPreview() {
  const block = document.getElementById('tokenPreviewBlock');
  if (!block) return;

  // Read all the inputs. parseNumberInput strips commas from the
  // number-formatted ones; trim whitespace from text fields.
  const nameEl = document.getElementById('tokenName');
  const symbolEl = document.getElementById('tokenSymbol');
  const descEl = document.getElementById('tokenDescription');
  const logoEl = document.getElementById('tokenLogo');

  const name = nameEl ? nameEl.value.trim() : '';
  const symbol = symbolEl ? symbolEl.value.trim() : '';
  const description = descEl ? descEl.value.trim() : '';
  const logoFile = logoEl && logoEl.files && logoEl.files[0] ? logoEl.files[0] : null;

  // Manage the object URL lifecycle. Revoke any prior URL whenever we
  // replace or clear it. createObjectURL returns a new URL each call
  // so we must store the last one to know what to revoke.
  let logoUrl = null;
  if (logoFile) {
    if (_tokenPreviewLogoObjectUrl) URL.revokeObjectURL(_tokenPreviewLogoObjectUrl);
    logoUrl = URL.createObjectURL(logoFile);
    _tokenPreviewLogoObjectUrl = logoUrl;
  } else if (_tokenPreviewLogoObjectUrl) {
    URL.revokeObjectURL(_tokenPreviewLogoObjectUrl);
    _tokenPreviewLogoObjectUrl = null;
  }

  // Logo fallback letter — shown inside the flat logo circle that sits
  // UNDER the coin canvas. With the 3D coin active the canvas covers it;
  // it's the graceful fallback when WebGL/coin is unavailable.
  const initial = (symbol.charAt(0) || name.charAt(0) || '?').toUpperCase();
  let logoHtml;
  if (logoUrl) {
    logoHtml =
      `<span class="token-preview-logo token-preview-logo-fallback">` +
      `${escapeHtml(initial)}` +
      `<img src="${escapeHtml(logoUrl)}" alt="">` +
      `</span>`;
  } else {
    logoHtml = `<span class="token-preview-logo token-preview-logo-fallback">${escapeHtml(initial)}</span>`;
  }

  // Symbol line. Shown as a ticker with a leading "$" (e.g. $TEST), the
  // convention crypto tokens use. Placeholder italic-grey when empty;
  // keeps the same vertical space so the layout doesn't jump as the user
  // fills in.
  const symbolLine = symbol
    ? `<div class="token-preview-symbol">$${escapeHtml(symbol)}</div>`
    : `<div class="token-preview-symbol is-placeholder">Your token preview</div>`;

  // Name line. Only shown when distinct from symbol — same logic the
  // resolved-info card uses for resolved tokens. Empty string kept as
  // empty markup so spacing stays consistent (margin-top on the next
  // line handles separation regardless).
  const nameLine = (name && name !== symbol)
    ? `<div class="token-preview-name">${escapeHtml(name)}</div>`
    : '';

  // Tech facts (supply, market cap, start price, decimals) plus live pool
  // config and the running launch-cost estimate are all rendered by the
  // shared stat-grid builder, so this card and the lightweight pool/cost
  // refresh path (updatePreviewStats) always agree.
  const statsHtml = buildPreviewStatsHtml();

  // Description line — only when present; truncated to 2 lines via CSS.
  const descLine = description
    ? `<div class="token-preview-desc">${escapeHtml(description)}</div>`
    : '';

  // Header (symbol + name) divided from the stat grid; then the grid and
  // the optional description.
  const stackHtml =
    `<div class="token-preview-stack">` +
      `<div class="token-preview-head">` +
        symbolLine +
        nameLine +
      `</div>` +
      statsHtml +
      descLine +
    `</div>`;

  // Structure-preserving update. The card holds a persistent coin mount
  // (.token-preview-coin) and a persistent progress bar
  // (.token-preview-progress), plus a text stack that gets swapped. We must
  // NOT blow away the coin mount on every render — its <canvas> holds a live
  // WebGL context, and recreating it per keystroke would thrash GL contexts
  // (and hit the browser's context cap). So: build the mount + progress bar
  // once, and thereafter only replace the fallback-logo letter and the stack.
  const progressHtml =
    `<div class="token-preview-progress" id="tokenPreviewProgress">` +
      `<div class="tpp-track"><div class="tpp-fill" id="tokenPreviewProgressFill"></div></div>` +
      `<div class="tpp-label" id="tokenPreviewProgressLabel">Launch progress</div>` +
    `</div>`;

  let coinMount = block.querySelector('.token-preview-coin');
  if (!coinMount) {
    // First render: [main row: coin mount + text stack][progress bar]. The
    // fallback flat logo lives inside the mount, under where the canvas
    // attaches; the progress bar spans the full card width below the row.
    block.innerHTML =
      `<div class="token-preview-main">` +
        `<div class="token-preview-coin" id="tokenPreviewCoin">${logoHtml}</div>` +
        stackHtml +
      `</div>` +
      progressHtml;
    coinMount = block.querySelector('.token-preview-coin');
  } else {
    // Subsequent renders: update the fallback logo (preserving any canvas
    // the coin renderer attached) and swap the text stack. The coin mount
    // and progress bar persist.
    const existingCanvas = coinMount.querySelector('canvas');
    coinMount.innerHTML = logoHtml;
    if (existingCanvas) coinMount.appendChild(existingCanvas);
    const oldStack = block.querySelector('.token-preview-stack');
    if (oldStack) {
      oldStack.outerHTML = stackHtml;
    } else {
      const main = block.querySelector('.token-preview-main') || block;
      main.insertAdjacentHTML('beforeend', stackHtml);
    }
    // Guard for older markup that predates the progress bar.
    if (!block.querySelector('.token-preview-progress')) {
      block.insertAdjacentHTML('beforeend', progressHtml);
    }
  }

  // Reflect the current overall launch progress into the (re)built bar.
  if (typeof updateLaunchProgress === 'function') updateLaunchProgress();

  // Pool-chip logos can fail to load (dead/blocked URL). Image 'error' events
  // don't bubble, so we listen in the capture phase on the stable block — once
  // — and swap a failed chip logo for its letter fallback. This mirrors the
  // pool-editor's pool-logo-fail handling so the preview degrades the same way.
  if (!_previewLogoFailBound) {
    _previewLogoFailBound = true;
    block.addEventListener('error', (e) => {
      const img = e.target;
      if (!img || img.tagName !== 'IMG') return;
      if (img.dataset.action !== 'preview-pool-logo-fail') return;
      const wrapper = img.closest('.tps-pool-logo');
      if (!wrapper) return;
      wrapper.textContent = wrapper.dataset.fallbackInitial || '?';
      wrapper.classList.add('tps-pool-logo-fallback');
    }, true);
  }

  // Drive the 3D coin. Initialise once when the mount first exists, then
  // update the front face whenever the uploaded logo changes. Guarded by
  // coinPreviewEnabled and by the presence of the global (script load order
  // / WebGL availability). updateCoinPreview() handles the rest.
  updateCoinPreview(logoUrl, symbol);

  // Also paint the small standalone logo thumbnail that sits next to
  // the file-picker. Same pattern as the preview card's logo: the
  // initial letter is the parent's text content, and the img — when
  // a file is selected — sits on top via CSS. Failure to decode the
  // image reveals the letter underneath. We always set both classes
  // so the grey fallback background is the baseline; with an image
  // loaded successfully, the img covers it.
  const thumb = document.getElementById('tokenLogoThumb');
  if (thumb) {
    if (logoUrl) {
      thumb.innerHTML =
        `${escapeHtml(initial)}` +
        `<img src="${escapeHtml(logoUrl)}" alt="">`;
    } else {
      thumb.innerHTML = escapeHtml(initial);
    }
  }
}

// Format a per-token USD price for the live preview. Crypto launches
// span a huge range (from $1+ "blue chip" launches to nano-cent
// memecoins) so a single fixed-decimals format doesn't cut it. We use
// a tiered approach plus parseFloat to strip any trailing zeros that
// toFixed leaves behind:
//   ≥ $1            → 2 decimals with locale commas ($1,234.56)
//   $0.01–$1        → up to 4 significant decimals ($0.5, $0.0123)
//   $0.000001–$0.01 → up to 8 significant decimals ($0.0001, $0.00012345)
//   anything tinier → scientific notation ($1.23e-10)
// Returns null for invalid/zero/negative inputs so the caller can fall
// back to a "decimals only" line.
function formatPreviewPrice(p) {
  if (!Number.isFinite(p) || p <= 0) return null;
  if (p >= 1) {
    return '$' + p.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }
  if (p >= 0.01) {
    return '$' + parseFloat(p.toFixed(4)).toString();
  }
  if (p >= 0.000001) {
    return '$' + parseFloat(p.toFixed(8)).toString();
  }
  return '$' + p.toExponential(2);
}

function renderPools() {
  // Auto-expand any pool that needs attention before painting. Without
  // this, errors that develop mid-flow (resolution fails, allocation
  // gets bumped to 0%, slices stop summing to 100%) would be hidden
  // inside a collapsed card. The user can still manually re-collapse
  // a pool after fixing it; we only force-open here, never force-close.
  for (const pool of pools) {
    if (poolNeedsAttention(pool)) pool._isExpanded = true;
  }
  poolList.innerHTML = '';
  pools.forEach((pool, idx) => {
    poolList.appendChild(buildPoolNode(pool, idx));
    // Node is now in the DOM, so its depth-chart container can be found and
    // filled. Covers the initial paint and every structural re-render.
    updatePoolDepthChart(idx);
  });
  updateAllocationSummary();
  updateContinueToFundingState();
}

// ---------------------------------------------------------------------------
// Pool-rendering helpers
// ---------------------------------------------------------------------------

// Friendly label for a pool's quote token: the resolved symbol, then a
// user-supplied override, then a shortened mint address (so a raw 44-char
// address never lands in the UI), then '?'. Shared by the pool list title
// and the preview card so the two always read the same.
function poolQuoteLabel(pool) {
  if (pool.resolvedSymbol) return pool.resolvedSymbol;
  if (pool.quoteSymbolOverride) return pool.quoteSymbolOverride;
  const t = pool.quoteToken;
  if (t) return t.length > 12 ? `${t.slice(0, 4)}…${t.slice(-4)}` : t;
  return '?';
}

// Build the inner HTML of a pool's title, e.g. "Pool 1 · SOL · 90% of supply".
//
// The title carries enough info to scan a stack of pools without opening
// any of them: quote-token symbol (resolved if available, falling back to
// the user's input or a truncated mint address), and the supply allocation.
//
// When the pool has a 0% allocation, the title surfaces that inline as a
// warning rather than just sitting on the validation reasons box at the
// bottom of the step. New pools added to a fully-allocated budget land
// here and must catch the user's eye.

// Render the pool's title text (no logo — that's a sibling element in
// the header, painted separately by updatePoolLogo). The title carries
// pool number, symbol, and allocation percent, with the "Pool N" prefix
// dropped when there's only one pool (noise, not signal).
function renderPoolTitle(pool, idx) {
  const label = poolQuoteLabel(pool);
  const pct = Number(pool.supplyPercent);
  const pctNum = Number.isFinite(pct) ? pct : 0;
  const safeLabel = escapeHtml(String(label));

  // "Pool N" prefix is only useful when there are multiple pools — for
  // a single-pool launch (the most common case) it's noise, since
  // there's nothing to disambiguate against.
  const showPoolNum = pools.length > 1;
  const prefix = showPoolNum
    ? `<span class="has-text-weight-bold">Pool ${idx + 1}</span> &middot; `
    : '';

  if (pctNum === 0) {
    return prefix +
           `<span class="has-text-weight-bold">${safeLabel}</span>` +
           ` &middot; <span class="has-text-warning-dark">0% of supply — set an allocation</span>`;
  }
  return prefix +
         `<span class="has-text-weight-bold">${safeLabel}</span>` +
         ` &middot; <span class="has-text-grey">${pctNum}% of supply</span>`;
}

// Update the small logo element in a pool's header. Separate from
// renderPoolTitle so we can update logo and title independently and
// because the logo is a sibling element in the new header layout, not
// embedded in the title span. Falls back to a coloured initial-style
// circle when no image URL is available — keeps the visual rhythm
// stable rather than leaving an empty space.
function updatePoolLogo(node, pool) {
  const el = node.querySelector('[data-field="poolLogo"]');
  if (!el) return;
  const sym = pool.resolvedSymbol || pool.quoteSymbolOverride || '?';
  const initial = sym.charAt(0).toUpperCase() || '?';
  if (pool.resolvedImageUrl) {
    const safeUrl = escapeHtml(pool.resolvedImageUrl);
    el.innerHTML =
      `<img src="${safeUrl}" alt="" loading="lazy" data-action="pool-logo-fail">`;
    el.dataset.fallbackInitial = initial;
    el.classList.remove('pool-row-logo-fallback');
  } else {
    delete el.dataset.fallbackInitial;
    el.textContent = initial;
    el.classList.add('pool-row-logo-fallback');
  }
}

// Update the small "▸ configure" / "▾ collapse" / "needs attention"
// affordance on the right side of the pool header. Reflects whether
// the pool is currently expanded and whether it needs user attention.
// In the warning case, the affordance becomes a clickable hint so users
// can see at a glance what's pending without opening the pool.
function updatePoolAffordance(node, pool) {
  const el = node.querySelector('[data-field="poolAffordance"]');
  if (!el) return;
  const attention = poolNeedsAttention(pool);
  if (attention) {
    // Showing a warning takes priority — even if expanded, we want the
    // user to know there's something pending. The exact message is
    // already encoded in the pool title via renderPoolTitle()'s 0% case
    // and the resolved-info block's error states; this is just a
    // pointer to draw attention.
    el.className = 'pool-row-affordance pool-row-affordance-warn';
    el.textContent = '⚠ needs attention';
  } else if (pool._isExpanded) {
    el.className = 'pool-row-affordance';
    el.textContent = '▾ collapse';
  } else {
    el.className = 'pool-row-affordance';
    el.textContent = '▸ configure';
  }
}

// Single source of truth for "this pool needs the user to do something
// before they can launch." Used both by the new collapsed-header chrome
// (to show a warning state and label) and by the auto-expansion logic
// (to force a pool open when a collapsed view would hide the problem).
//
// Returns one of:
//   null              — pool is fine, can stay collapsed
//   'unresolved'      — resolution failed (no decimals); user must fix
//                       the address or fill in overrides
//   'price-missing'   — resolution succeeded but no USD price; user
//                       must enter one in overrides
//   'no-allocation'   — supplyPercent is 0; the pool would create with
//                       no liquidity allocation, almost always wrong
//   'slice-mismatch'  — legacy name; replaced by 'positions-mismatch'
//   'positions-mismatch' — bootstrap + slices + ladder bands don't sum
//                          to 100% of pool
//
// This intentionally doesn't account for "the user has opened the
// override section but not filled in all values" — that's a finer-
// grained validation handled by updateContinueToFundingState().
function poolNeedsAttention(pool) {
  if (!pool) return null;
  if (Number(pool.supplyPercent) === 0) return 'no-allocation';
  if (pool.resolvedSymbol && pool.resolvedDecimals == null) return 'unresolved';
  if (pool.resolvedSymbol &&
      pool.resolvedDecimals != null &&
      pool.resolvedPriceUsd == null &&
      pool.quoteUsdOverride == null) {
    return 'price-missing';
  }
  // Positions total check: under unified semantics, the sum of
  // bootstrap (if custom) + slice sharePercents + ladder band
  // supplyPercents must equal 100% of pool. If not, the pool is
  // misconfigured and we can't safely send it to the backend.
  if (Math.abs(computePoolPositionsTotal(pool) - 100) > 0.01) return 'positions-mismatch';
  return null;
}

// Compute the sum of all position percentages in a pool: bootstrap
// (if custom), all wide slices, and all ladder bands. Each is "% of
// pool" under unified semantics. The total should be 100%.
function computePoolPositionsTotal(pool) {
  const bsPct = (pool.bootstrapConfig && pool.bootstrapConfig.mode === 'custom')
    ? Number(pool.bootstrapConfig.supplyPercent) || 0
    : 0;
  const slicePct = Array.isArray(pool.distribution)
    ? pool.distribution.reduce((s, x) => s + (Number(x.sharePercent) || 0), 0)
    : 0;
  const bandPct = (pool.ladderConfig && pool.ladderConfig.mode === 'manual' && Array.isArray(pool.ladderConfig.bands))
    ? pool.ladderConfig.bands.reduce((s, b) => s + (Number(b.supplyPercent) || 0), 0)
    : 0;
  return bsPct + slicePct + bandPct;
}

// Absorb a delta into the wide-slices bucket to keep positions total
// at 100% after a structural toggle (bs on/off, ladder on/off). When
// delta > 0, slices need to shrink to make room. When delta < 0,
// slices need to grow to absorb. The adjustment lands on the LAST
// slice — simplest and most predictable for the user (they can see
// at a glance what changed). If absorbing fully would push the last
// slice below 0, it clamps at 0 and the user gets a positions-total
// warning to manually rebalance.
//
// Edge case: pool has no slices at all (distribution empty). Then we
// can't rebalance through slices; total just drifts and the warning
// fires. Should never happen in practice since addPool seeds one
// slice, but we guard anyway.
function rebalanceWideSlicesByDelta(pool, delta) {
  if (!Array.isArray(pool.distribution) || pool.distribution.length === 0) return;
  const lastIdx = pool.distribution.length - 1;
  const newVal = Number(pool.distribution[lastIdx].sharePercent || 0) - delta;
  pool.distribution[lastIdx].sharePercent = Math.max(0, Number(newVal.toFixed(4)));
}

// Update one pool's title in place.
//
// Called from every input/state change that affects the displayed title:
// supplyPercent typing, quote-dropdown change, custom-mint typing, and
// the async resolution callback. Touches only the title element so we
// don't lose focus on whatever input the user is currently in.
// Refresh a pool's header chrome in place: title, logo, and the
// affordance hint. All three depend on overlapping fields (symbol,
// allocation, resolution status, expanded state, attention status) so
// it's simpler to update them together than to track which-affects-what.
//
// Called from every input/state change that affects the displayed
// header: supplyPercent typing, quote-dropdown change, custom-mint
// typing, and the async resolution callback. Touches only header
// elements so we don't lose focus on whatever input the user is
// currently in.
//
// (Function still named updatePoolTitle for backward compatibility with
// existing call sites — its scope grew but the name stuck.)
// Redraw one pool's liquidity depth chart in place. Cheap and idempotent:
// recomputes the profile from the pool's current config and swaps the SVG.
// Safe to call when the pool is collapsed (no container) — it just no-ops.
function updatePoolDepthChart(poolIdx) {
  const pool = pools[poolIdx];
  if (!pool) return;
  const node = poolList.children[poolIdx];
  if (!node) return;
  const wrap = node.querySelector('[data-field="depthChart"]');
  if (!wrap) return;

  // USD scaling so the quote-side support wall is comparable to the token-side
  // bands. The pool's notional is its share of the target market cap; support's
  // value is its SOL converted through the SOL pool's resolved price.
  const targetMc = parseNumberInput(document.getElementById('targetMarketCap'));
  const poolNotionalUsd = (Number(targetMc) > 0 && Number(pool.supplyPercent) > 0)
    ? (Number(pool.supplyPercent) / 100) * Number(targetMc)
    : 0;

  let support = null;
  const sc = pool.supportConfig;
  if (sc && sc.mode === 'custom' && Number(sc.solValue) > 0) {
    const solPool = pools.find((p) => (p.quoteToken || '').toUpperCase() === 'SOL');
    const solUsd = solPool && Number(solPool.resolvedPriceUsd) > 0 ? Number(solPool.resolvedPriceUsd) : null;
    if (solUsd) {
      support = {
        usd: Number(sc.solValue) * solUsd,
        depthPct: (typeof clampSupportDepth === 'function') ? clampSupportDepth(sc.depthPct) : (Number(sc.depthPct) || 30),
      };
    }
  }

  const profile = computeDepthProfile(pool, { poolNotionalUsd, support });
  // renderDepthChartSvg returns '' unless there's a ladder or a (placeable)
  // support wall — a lone wide band says nothing useful. Hide the empty
  // container so it leaves no gap.
  const html = profile ? renderDepthChartSvg(profile) : '';
  wrap.innerHTML = html;
  wrap.style.display = html ? '' : 'none';
}

function updatePoolTitle(poolIdx) {
  const pool = pools[poolIdx];
  if (!pool) return;
  const node = poolList.children[poolIdx];
  if (!node) return;
  const titleEl = node.querySelector('[data-field="poolTitle"]');
  if (titleEl) titleEl.innerHTML = renderPoolTitle(pool, poolIdx);
  updatePoolLogo(node, pool);
  updatePoolAffordance(node, pool);
  // The depth chart's shape depends on the supply split, which several live
  // edits change; refreshing here covers supplyPercent, ladder %, and
  // distribution edits (which all route through here via
  // updatePoolPositionsTotal).
  updatePoolDepthChart(poolIdx);
}

// Apply visibility rules for the per-pool override section ("manual quote
// token info"). Auto-shown when:
//   - resolution came back but with missing fields (the user has to fill
//     them in to continue), or
//   - the user already has any override value typed in (so editing stays
//     accessible without forcing them to find a toggle), or
//   - the user has explicitly opened the section via the toggle link
//     (`_overrideForceOpen`).
//
// Otherwise the section is hidden behind a small "Override resolved
// values" link — the override path stays available for power users but
// doesn't clutter the default view when resolution succeeded.
function applyOverrideVisibility(node, pool) {
  const toggle = node.querySelector('[data-action="toggle-override"]');
  const section = node.querySelector('[data-field="overrideSection"]');
  if (!toggle || !section) return;

  const hasUserOverride =
    !!pool.quoteSymbolOverride ||
    pool.quoteDecimalsOverride != null ||
    pool.quoteUsdOverride != null;
  const resolutionIncomplete =
    !!pool.resolvedSymbol &&
    (pool.resolvedDecimals == null || pool.resolvedPriceUsd == null);
  // Resolution is "fully complete" when we have all three pieces of
  // info (symbol + decimals + price) from the indexer. In that state
  // there's nothing for the user to override, so the toggle button is
  // pure clutter — hide it entirely. The button comes back the moment
  // anything's missing, or the moment the user types an override.
  const resolutionComplete =
    !!pool.resolvedSymbol &&
    pool.resolvedDecimals != null &&
    pool.resolvedPriceUsd != null;

  // When Raydium has no pool for this token, the price comes from
  // GeckoTerminal/DexScreener instead. The price IS usable (the
  // aggregators index Meteora and other DEXes) but the user may
  // reasonably want to override it — they may have better info than
  // the aggregator, especially for low-volume tokens. We make the
  // toggle BUTTON visible so the user has easy access to override,
  // but we DON'T auto-expand the section — the user trusted the
  // aggregator enough to pick this token; we shouldn't nag them by
  // shoving the override panel open by default.
  const raydiumHasNoPool = pool.resolvedRaydiumTradeable === 'no';

  const shouldShow =
    resolutionIncomplete ||
    hasUserOverride ||
    pool._overrideForceOpen === true;

  if (shouldShow) {
    section.classList.remove('hidden');
    toggle.classList.remove('hidden');
    toggle.textContent = '▾ Hide override fields';
  } else {
    section.classList.add('hidden');
    // Hide the toggle too when there's nothing to fix. Keeping it
    // visible was making the resolved-info card look cluttered with a
    // button for an action the user almost never needs to take.
    //
    // EXCEPTION: when Raydium has no pool, keep the toggle visible
    // even though resolution is technically complete via aggregator —
    // the user may want to override the aggregator price, and they
    // shouldn't have to discover a hidden control to do it.
    if (resolutionComplete && !hasUserOverride && !pool._overrideForceOpen && !raydiumHasNoPool) {
      toggle.classList.add('hidden');
    } else {
      toggle.classList.remove('hidden');
      toggle.textContent = 'Override resolved values';
    }
  }
}

// Render the resolved-info content as a multi-line block. Layout:
//
//   ┌──────────────────────────────────────────────────┐
//   │ [logo]   WETH                          ⓘ details │
//   │          Wrapped Ether (Wormhole)                │
//   │          8 decimals · $2,286.35                  │
//   └──────────────────────────────────────────────────┘
//
// Three render states match the original logic exactly:
//   - decimals missing: "Couldn't resolve" red message (hard stop, no
//     logo since there's nothing to show in the modal anyway).
//   - price missing: same layout but with a red "no USD price" line
//     in place of the price (recoverable via override fields).
//   - everything resolved: the full layout above.
//
// Used both from the initial buildPoolNode render and from the in-place
// updateQuoteResolvedDisplay() that runs after async resolution returns,
// to keep both rendering paths consistent.
function renderResolvedInfoHtml(pool) {
  // Resolution-failure case: show a clear error with a retry button.
  // This is distinct from "haven't resolved yet" (pool.resolvedSymbol
  // is null because the resolve call hasn't returned) and from "couldn't
  // read from chain" (pool.resolvedDecimals is null). pool.resolvedFailed
  // is the marker set by resolvePoolQuote when the fetch itself threw —
  // typically a network/server issue where a retry is appropriate.
  if (pool.resolvedFailed) {
    const err = escapeHtml(pool.resolvedFailedError || 'unknown error');
    return (
      `<div class="has-text-danger is-size-7">` +
      `<i class="fas fa-exclamation-circle"></i> ` +
      `Couldn't fetch quote-token info (${err}). ` +
      `<a data-action="retry-resolve" class="has-text-weight-bold">Retry</a>` +
      `</div>`
    );
  }
  if (!pool.resolvedSymbol) return '';

  const safeSym = escapeHtml(pool.resolvedSymbol);

  // Hard-stop case: on-chain read failed entirely. Single-line error,
  // no logo / name / icon. Returns flat text since the parent block
  // is a flex container — single-child works fine.
  if (pool.resolvedDecimals == null) {
    return `<div class="has-text-danger">Couldn't resolve ${safeSym} on-chain — check the address and your RPC.</div>`;
  }

  // Logo (36px circle, left column). Falls back to an initial-letter
  // circle when the image fails to load. Implemented with a structural
  // sibling fallback (the initial-letter is always in the DOM, hidden
  // behind the img) rather than an inline image-error handler with
  // interpolated content. The old approach worked but mixed HTML/JS
  // contexts in a way that's hard to audit for injection — better to
  // build it with regular HTML and CSS.
  const initial = escapeHtml((pool.resolvedSymbol.charAt(0) || '?').toUpperCase());
  let logoHtml;
  if (pool.resolvedImageUrl) {
    const safeUrl = escapeHtml(pool.resolvedImageUrl);
    // The img sits on top of the fallback span. If the img's load fails,
    // the data-action="logo-fail" listener (set up below) hides the img
    // and reveals the fallback. The initial-letter is already in the
    // markup, so the fallback content can't be injection-influenced.
    logoHtml =
      `<span class="resolved-logo resolved-logo-with-image">` +
      `<span class="resolved-logo-initial">${initial}</span>` +
      `<img src="${safeUrl}" alt="" loading="lazy" data-action="logo-fail">` +
      `</span>`;
  } else {
    logoHtml = `<span class="resolved-logo resolved-logo-fallback">${initial}</span>`;
  }

  // Name line — only shown when distinct from symbol. For a token like
  // SOL with name "Solana" we render both; for a token whose metadata
  // has identical name/symbol, we skip the line entirely.
  let nameLine = '';
  if (pool.resolvedName && pool.resolvedName !== pool.resolvedSymbol) {
    nameLine = `<div class="resolved-info-name">${escapeHtml(pool.resolvedName)}</div>`;
  }

  // Technicals line: decimals + price, OR decimals + the no-price hint.
  // Includes a small source-provenance label after the price so the user
  // knows whether the displayed number is verified against Raydium (the
  // canonical answer for pool creation) or just an aggregator estimate
  // (informational only until funding-estimate runs). Per the price-
  // safety plan's Milestone B principle: the user should see the same
  // number throughout the flow, and know where it came from.
  let techLine;
  if (pool.resolvedPriceUsd) {
    const priceTxt = `$${Number(pool.resolvedPriceUsd).toLocaleString(
      undefined,
      { maximumFractionDigits: 6 },
    )}`;
    // Translate the source label into something human-readable. Source
    // vocabulary (matches the funding-estimate + Step-2-cache convention):
    //   'sol'                    → from the SOL/USD oracle
    //   'raydium-probe'          → live Raydium swap probe (best)
    //   'raydium-probe (cached)' → recent (≤ 3 min) Step-2 probe result
    //   'user-override'          → user typed it manually
    //   'oracle'                 → aggregator (gecko/dexscreener) — used
    //                              when Raydium has no pool for this token
    //                              and we trust the aggregators (which
    //                              index Meteora/Orca/etc.) for the price
    //   (null/anything else)     → no provenance known
    let sourceLabel = '';
    const src = pool.resolvedPriceSource;
    if (src === 'raydium-probe' || src === 'raydium-probe (cached)') {
      sourceLabel = ' <span class="has-text-success is-size-7">· verified from Raydium</span>';
    } else if (src === 'sol') {
      sourceLabel = ' <span class="has-text-grey is-size-7">· from SOL/USD oracle</span>';
    } else if (src === 'user-override') {
      sourceLabel = ' <span class="has-text-grey is-size-7">· user-set</span>';
    } else if (src === 'oracle') {
      // Price came from an aggregator (GeckoTerminal/DexScreener) rather
      // than a direct Raydium probe. This can happen because:
      //   1. The quote is in KNOWN_SAFE_QUOTES (flywheels, USDC, USDT) and
      //      we deliberately skipped the probe — the aggregator price IS
      //      from the Raydium pool, just routed through Gecko.
      //   2. Raydium has no pool for this token (Meteora-only, etc.) and
      //      the aggregator picked up the price from another DEX.
      //   3. The probe was unreachable transiently.
      // We can't easily distinguish these from priceSource alone, and the
      // honest advice is the same in all three cases: the user should
      // verify the price matches their expectation before launching.
      //
      // The "verify price" label is a clickable link to the token's
      // GeckoTerminal page so the user can compare in one click. We use
      // the resolved mint (always present for non-SOL pools that reach
      // this branch); fall back to the typed quoteToken if for some
      // reason resolvedMint is null, so the link still works.
      const mint = pool.resolvedMint || pool.quoteToken || '';
      if (mint) {
        const safeMint = encodeURIComponent(mint);
        sourceLabel =
          ' <a href="https://www.geckoterminal.com/solana/tokens/' +
          safeMint +
          '" target="_blank" rel="noopener noreferrer" ' +
          'class="has-text-warning-dark is-size-7" ' +
          'title="Open this token\'s GeckoTerminal page in a new tab">' +
          '· verify price ' +
          '<i class="fas fa-external-link-alt is-size-7"></i></a>';
      } else {
        // No mint to build a URL with — fall back to bare text. Hitting
        // this branch shouldn't happen in practice (you can't reach this
        // code path without a resolved address), but defensive.
        sourceLabel = ' <span class="has-text-warning-dark is-size-7">· verify price</span>';
      }
    }
    techLine = `<div class="resolved-info-tech">${pool.resolvedDecimals} decimals · ${priceTxt}${sourceLabel}</div>`;
  } else {
    // Symbol+decimals came back from on-chain reads but neither
    // GeckoTerminal nor Jupiter could give us a USD price. Common for
    // very-low-volume tokens, including the flywheel tokens this app
    // is designed around. Tell the user clearly and point them at the
    // override fields below — applyOverrideVisibility() auto-shows
    // them when the price is missing, so the user doesn't need to
    // hunt for a toggle.
    techLine =
      `<div class="resolved-info-tech">${pool.resolvedDecimals} decimals · ` +
      `<span class="has-text-danger">no USD price — set one in the override fields below</span></div>`;
  }

  // Info icon — opens the token info modal on click. Wired via delegated
  // event handling on the pool node so this helper just emits HTML.
  const infoIcon =
    `<a class="resolved-info-icon" data-action="show-token-info" title="Token info">` +
    `<i class="fas fa-info-circle"></i> details</a>`;

  // Raydium CLMM compatibility line. We surface three states:
  //   - hard incompatible: red text, names the disallowed extensions.
  //     updateContinueToFundingState also blocks "Continue" in this case.
  //   - unknown (compatible === null): yellow note ("couldn't verify").
  //     Continue is not blocked; user can override via Advanced settings
  //     or fix RPC and retry.
  //   - compatible: nothing (silent), OR a small "Token-2022" pill when
  //     the user is dealing with a Token-2022 mint, so they know the
  //     pool will involve transfer fees / extension semantics.
  let compatLine = '';
  if (pool.resolvedCompatible === false) {
    const exts = (pool.resolvedDisallowedNames || []).join(', ');
    compatLine =
      `<div class="resolved-info-tech has-text-danger">` +
        `<i class="fas fa-exclamation-triangle"></i> ` +
        `Not compatible with Raydium CLMM — ` +
        `unsupported Token-2022 extension${exts.split(',').length === 1 ? '' : 's'}: ` +
        `${escapeHtml(exts)}` +
      `</div>`;
  } else if (pool.resolvedCompatible === null) {
    compatLine =
      `<div class="resolved-info-tech has-text-warning-dark">` +
        `<i class="fas fa-question-circle"></i> ` +
        `Couldn't verify Raydium compatibility ` +
        `(${escapeHtml(pool.resolvedCompatError || 'RPC error')})` +
      `</div>`;
  } else if (pool.resolvedIsToken2022) {
    // Compatible Token-2022. Quiet informational marker so the user
    // knows this isn't a vanilla SPL token — relevant for understanding
    // transfer fee behavior, metadata via on-chain extensions, etc.
    compatLine =
      `<div class="resolved-info-tech has-text-info">` +
        `<i class="fas fa-shield-alt"></i> ` +
        `Token-2022 (compatible)` +
      `</div>`;
  }

  // ──── Safety warning lines (per the price-safety plan, Milestone D) ────
  //
  // Three independent checks the user should see at Step 2, BEFORE
  // they invest time and SOL in funding. Each is rendered inline
  // alongside the compat info so a glance at the quote token tells
  // the whole safety story.

  // 1. Freeze authority — hard block. The token deployer can freeze
  //    the launch wallet's quote-token balance mid-launch, bricking
  //    the entire process. updateContinueToFundingState() also blocks
  //    the Continue button when this is true.
  let freezeAuthLine = '';
  if (pool.resolvedFreezeAuthorityBlock === true) {
    freezeAuthLine =
      `<div class="resolved-info-tech has-text-danger">` +
        `<i class="fas fa-exclamation-triangle"></i> ` +
        `This token has an active freeze authority. The token deployer ` +
        `can freeze your wallet's holdings, which would brick the launch.` +
      `</div>`;
  }

  // 2. Mint authority — soft warning. Supply can be inflated by the
  //    deployer at any time, which would devalue pool contents.
  //    Doesn't block the launch but the user should be cautious.
  let mintAuthLine = '';
  if (pool.resolvedMintAuthorityWarning === true) {
    mintAuthLine =
      `<div class="resolved-info-tech has-text-warning-dark">` +
        `<i class="fas fa-exclamation-circle"></i> ` +
        `This token's supply can be increased by its deployer. Be ` +
        `cautious — supply inflation could devalue the token before ` +
        `your pool is created.` +
      `</div>`;
  }

  // 3. Raydium tradeability — informational. When 'no', Trebuchet falls
  //    back to GeckoTerminal/DexScreener for the price (which index
  //    Meteora and other DEXes). When 'unknown', the probe couldn't
  //    run right now; the launch may still succeed at Step 5 with a
  //    fresh probe or aggregator fallback.
  // 3. Raydium tradeability — informational. When 'no', the price comes
  //    from aggregators instead of Raydium (we already labeled that in
  //    the techLine). When 'unknown', Raydium was unreachable at Step 2
  //    and the launch will probe again at Step 5.
  let raydiumLine = '';
  if (pool.resolvedRaydiumTradeable === 'no') {
    raydiumLine =
      `<div class="resolved-info-tech has-text-warning-dark">` +
        `<i class="fas fa-info-circle"></i> ` +
        `Raydium has no pool for this token. Please verify the price ` +
        `is accurate before launching.` +
      `</div>`;
  } else if (pool.resolvedRaydiumTradeable === 'unknown') {
    raydiumLine =
      `<div class="resolved-info-tech has-text-warning-dark">` +
        `<i class="fas fa-question-circle"></i> ` +
        `Couldn't reach the Raydium Trade API right now ` +
        `(${escapeHtml(pool.resolvedRaydiumProbeError || 'API unreachable')}). ` +
        `Trebuchet will try again at Step 5; if Raydium is still ` +
        `unreachable, you'll need to retry or set an explicit override.` +
      `</div>`;
  }

  return `${logoHtml}` +
         `<div class="resolved-info-stack">` +
         `<div class="resolved-info-top">` +
           `<span class="resolved-info-symbol">${safeSym}</span>` +
           infoIcon +
         `</div>` +
         nameLine +
         techLine +
         compatLine +
         freezeAuthLine +
         mintAuthLine +
         raydiumLine +
         `</div>`;
}

// Populate and show the token info modal for a given pool. The modal
// markup lives in index.html alongside the other modals; this just
// fills in its slots and flips the .is-active class to show it.
//
// Re-uses the same pattern as confirmDialog/cancelConfirmModal — no new
// modal infrastructure. External links are constructed from the resolved
// mint, which is the canonical address for any of the explorers.
function showTokenInfoModal(pool) {
  const modal = document.getElementById('tokenInfoModal');
  if (!modal) return;
  const body = document.getElementById('tokenInfoBody');
  if (!body) return;
  const mint = pool.resolvedMint || pool.quoteToken || '';
  const symbol = pool.resolvedSymbol || pool.quoteSymbolOverride || '?';
  const name = pool.resolvedName || symbol;
  const decimals = pool.resolvedDecimals ?? pool.quoteDecimalsOverride ?? '—';
  const priceUsd = pool.resolvedPriceUsd ?? pool.quoteUsdOverride;
  const priceTxt = priceUsd
    ? `$${Number(priceUsd).toLocaleString(undefined, { maximumFractionDigits: 8 })}`
    : '<span class="has-text-grey">unavailable</span>';

  const logoHtml = pool.resolvedImageUrl
    ? `<img src="${escapeHtml(pool.resolvedImageUrl)}" alt="" class="token-info-logo" data-action="token-info-logo-fail">`
    : '';

  const safeMint = escapeHtml(mint);
  // External explorer links. We just need the mint — every explorer
  // uses it as the canonical identifier in the URL path.
  const solscanUrl = `https://solscan.io/token/${encodeURIComponent(mint)}`;
  const geckoUrl = `https://www.geckoterminal.com/solana/tokens/${encodeURIComponent(mint)}`;
  const dexscreenerUrl = `https://dexscreener.com/solana/${encodeURIComponent(mint)}`;

  body.innerHTML = `
    <div class="token-info-header">
      ${logoHtml}
      <div class="token-info-titles">
        <div class="token-info-name">${escapeHtml(name)}</div>
        <div class="token-info-symbol">${escapeHtml(symbol)}</div>
      </div>
    </div>

    <table class="table is-narrow is-fullwidth is-size-7 mt-3 mb-3">
      <tbody>
        <tr>
          <td class="has-text-grey" style="width: 30%;">Mint</td>
          <td>
            <span class="is-family-monospace" style="word-break: break-all;">${safeMint}</span>
            <button class="button is-small is-light ml-2" data-action="copy-mint" title="Copy mint address">
              <span class="icon is-small"><i class="fas fa-copy"></i></span>
            </button>
          </td>
        </tr>
        <tr>
          <td class="has-text-grey">Decimals</td>
          <td>${escapeHtml(String(decimals))}</td>
        </tr>
        <tr>
          <td class="has-text-grey">USD price</td>
          <td>${priceTxt}</td>
        </tr>
      </tbody>
    </table>

    <p class="is-size-7 has-text-grey mb-2">View on:</p>
    <div class="buttons are-small">
      <a class="button is-light" href="${escapeHtml(solscanUrl)}" target="_blank" rel="noopener noreferrer">Solscan</a>
      <a class="button is-light" href="${escapeHtml(geckoUrl)}" target="_blank" rel="noopener noreferrer">GeckoTerminal</a>
      <a class="button is-light" href="${escapeHtml(dexscreenerUrl)}" target="_blank" rel="noopener noreferrer">DexScreener</a>
    </div>
  `;

  body.querySelectorAll('[data-action="token-info-logo-fail"]').forEach((img) => {
    img.addEventListener('error', () => {
      img.remove();
    }, { once: true });
  });

  // Wire up the copy-mint button. Clipboard write is async but we don't
  // need to await — just fire and forget, log on success.
  const copyBtn = body.querySelector('[data-action="copy-mint"]');
  if (copyBtn && mint) {
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(mint);
        log(`Mint address copied: ${mint.slice(0, 8)}…${mint.slice(-6)}`, 'info');
      } catch (e) {
        log(`Couldn't copy mint: ${e.message}`, 'warning');
      }
    });
  }

  // Wire up close handlers — close button, background click, and Esc.
  // We do this on first open rather than at init time because app.js
  // runs synchronously and is loaded before the modal markup later in
  // the body, so the elements don't exist yet when init runs. Guarded
  // with a dataset flag so we don't accumulate duplicate listeners on
  // repeat opens of the modal.
  if (!modal.dataset.closeHandlersWired) {
    const close = () => modal.classList.remove('is-active');
    const closeBtn = document.getElementById('tokenInfoCloseBtn');
    if (closeBtn) closeBtn.addEventListener('click', close);
    const bg = document.getElementById('tokenInfoBackground');
    if (bg) bg.addEventListener('click', close);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && modal.classList.contains('is-active')) close();
    });
    modal.dataset.closeHandlersWired = 'true';
  }

  modal.classList.add('is-active');
}

function buildPoolNode(pool, idx) {
  const node = document.createElement('div');
  node.className = 'pool-row';

  // Delegated click handler for the resolved-info row. Handles both the
  // info-modal icon and the retry-resolve link, since both live inside
  // the resolved-info block and may be re-rendered as state changes.
  // Using delegation on the pool node means we don't need to re-attach
  // these listeners each time the inner HTML rebuilds.
  node.addEventListener('click', (e) => {
    // Info icon → open the details modal.
    if (e.target.closest('[data-action="show-token-info"]')) {
      e.preventDefault();
      showTokenInfoModal(pool);
      return;
    }
    // Retry-resolve link (shown only when a prior resolve attempt failed)
    // → re-run resolvePoolQuote. Clears the failure marker so the UI
    // shows "resolving…" again, then the resolve call either succeeds
    // (clearing resolvedFailed in its success path) or fails again
    // (re-setting it in the catch).
    if (e.target.closest('[data-action="retry-resolve"]')) {
      e.preventDefault();
      // Provisionally clear the failure state so the UI re-paints to a
      // clean "resolving" state. If the retry fails too, resolvePoolQuote
      // re-sets resolvedFailed in its catch block.
      pool.resolvedFailed = false;
      pool.resolvedFailedError = null;
      updateQuoteResolvedDisplay(idx);
      resolvePoolQuote(idx);
      return;
    }
  });

  // Logo image error handler. Uses event capture (third argument true)
  // because the `error` event doesn't bubble through normal DOM
  // propagation — listeners attached to a parent see it only on the
  // capture phase. When the img fails to load (404, CORS, etc), we add
  // .resolved-logo-img-failed to the wrapping span, which CSS uses to
  // hide the img and reveal the initial-letter fallback that's already
  // sitting underneath it. Same delegation pattern as the click handler
  // above: works across renders without re-attaching.
  node.addEventListener('error', (e) => {
    const img = e.target;
    if (!img || img.tagName !== 'IMG') return;
    if (img.dataset.action === 'logo-fail') {
      const wrapper = img.closest('.resolved-logo-with-image');
      if (wrapper) wrapper.classList.add('resolved-logo-img-failed');
      return;
    }
    if (img.dataset.action === 'pool-logo-fail') {
      const wrapper = img.closest('[data-field="poolLogo"]');
      if (!wrapper) return;
      wrapper.textContent = wrapper.dataset.fallbackInitial || '?';
      delete wrapper.dataset.fallbackInitial;
      wrapper.classList.add('pool-row-logo-fallback');
    }
  }, true);

  const header = document.createElement('div');
  header.className = 'pool-row-header';
  // Header is interactive: clicking anywhere except the trash toggles
  // the body's collapsed/expanded state. We attach the toggle to the
  // entire header (not just the left zone) so the affordance hint on
  // the right side ("▸ configure" / "▾ collapse") is also clickable —
  // it looks like a button, so it should act like one. The trash
  // button stops propagation to avoid double-firing.
  header.innerHTML = `
    <div class="pool-row-header-left">
      <span class="pool-row-logo" data-field="poolLogo"></span>
      <span data-field="poolTitle">${renderPoolTitle(pool, idx)}</span>
    </div>
    <div class="pool-row-header-right">
      <span class="pool-row-affordance" data-field="poolAffordance"></span>
      <button class="button is-danger is-small is-light" data-action="remove-pool">
        <span class="icon"><i class="fas fa-trash"></i></span>
      </button>
    </div>
  `;
  header.querySelector('[data-action="remove-pool"]').addEventListener('click', (e) => {
    e.stopPropagation(); // don't also toggle expand
    removePool(idx);
  });
  header.addEventListener('click', () => {
    pool._isExpanded = !pool._isExpanded;
    renderPools();
  });
  node.appendChild(header);

  // Populate the header's logo and affordance text. These depend on
  // resolved data plus the expansion state, so we set them after the
  // header element is in place. Both code paths below (collapsed
  // early-return and the expanded body build) need this — without it,
  // the header's logo span stays empty and the user sees just a blank
  // white circle next to the pool title.
  updatePoolLogo(node, pool);
  updatePoolAffordance(node, pool);

  // Body wrapper. Holds the form grid, resolved-info block, override
  // section, and distribution section. When the pool is collapsed,
  // we simply skip building this entirely — everything inside it is
  // unnecessary DOM. The body is rebuilt fresh on each renderPools()
  // anyway, so there's no state lost by skipping it.
  if (!pool._isExpanded) {
    return node;
  }

  const body = document.createElement('div');
  body.className = 'pool-row-body';
  node.appendChild(body);

  const row1 = document.createElement('div');
  row1.className = 'columns is-mobile is-multiline pool-row-form';
  row1.innerHTML = `
    <div class="column is-half-mobile">
      <label class="label is-small">Quote Token</label>
      <div class="select is-small is-fullwidth">
        <select data-field="quoteSelect">
          <optgroup label="Native">
            <option value="SOL">SOL</option>
          </optgroup>
          <optgroup label="Flywheels">
            <option value="HipYKXiDh3Kjd1jb7ji6jCEsKQMSGWiFJMdtvH8yb5r">$seige (Meme flywheel — recommended)</option>
            <option value="J1bZFRAFC8ALqAN7ktkcCpobgoeTGfP5Xh1BwCP1oqoj">XLRT (Reserve flywheel)</option>
          </optgroup>
          <optgroup label="Majors">
            <option value="3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh">wBTC (Wormhole)</option>
            <option value="7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs">ETH (Wormhole)</option>
          </optgroup>
          <optgroup label="Stables">
            <option value="USDC">USDC</option>
            <option value="USDT">USDT</option>
            <option value="USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB">USD1 (World Liberty Financial)</option>
          </optgroup>
          <optgroup label="Other">
            <option value="__custom">Custom mint…</option>
          </optgroup>
        </select>
      </div>
      <input class="input is-small mt-1 hidden" type="text" data-field="quoteCustom" placeholder="SPL mint address">
    </div>
    <div class="column is-narrow pool-row-allocation">
      <label class="label is-small">Allocation</label>
      <div class="field has-addons">
        <div class="control">
          <input class="input is-small" type="number" min="0" max="100" step="0.01" data-field="supplyPercent" value="${pool.supplyPercent}">
        </div>
        <div class="control"><a class="button is-small is-static">%</a></div>
      </div>
    </div>
    <div class="column">
      <label class="label is-small">Fee Tier</label>
      <div class="select is-small is-fullwidth">
        <select data-field="ammConfig">
          ${feeTiers.map((t) => {
            const pct = (t.tradeFeeRate / 10000).toString();
            const isDefault = t.index === 3;
            const isSelected = pool.ammConfigIndex === t.index;
            return `<option value="${t.index}" ${isSelected ? 'selected' : ''}>${pct}% / spacing ${t.tickSpacing}${isDefault ? ' (default)' : ''}</option>`;
          }).join('')}
        </select>
      </div>
    </div>
  `;
  body.appendChild(row1);

  const quoteSelect = row1.querySelector('[data-field="quoteSelect"]');
  const quoteCustom = row1.querySelector('[data-field="quoteCustom"]');

  // The dropdown contains a mix of uppercase symbols (SOL/USDC/USDT — these
  // are the tokens the server knows about via KNOWN_QUOTES) and raw mint
  // addresses (the curated tokens in Flywheels/Majors/Stables — these go
  // through the GeckoTerminal lookup path on resolve, same as any custom
  // mint). To decide whether the saved pool.quoteToken matches a dropdown
  // option, we collect all option values from the live <select> rather
  // than maintaining a separate hardcoded list.
  const dropdownValues = new Set(
    Array.from(quoteSelect.querySelectorAll('option'))
      .map((o) => o.value)
      .filter((v) => v && v !== '__custom')
  );

  // Match symbols case-insensitively (SOL/USDC/USDT) and mint addresses
  // case-sensitively (base58 is case-sensitive on Solana).
  const isInDropdown = (() => {
    const t = pool.quoteToken || '';
    if (dropdownValues.has(t)) return true;
    const upper = t.toUpperCase();
    if (dropdownValues.has(upper)) return true;
    return false;
  })();

  if (isInDropdown) {
    // Snap to whichever case matches the option (symbols are uppercase in
    // the dropdown; mint addresses are stored as-is).
    quoteSelect.value = dropdownValues.has(pool.quoteToken)
      ? pool.quoteToken
      : pool.quoteToken.toUpperCase();
    quoteCustom.classList.add('hidden');
  } else {
    quoteSelect.value = '__custom';
    quoteCustom.classList.remove('hidden');
    quoteCustom.value = pool.quoteToken;
  }

  // Initial resolved-info content is populated when resolvedBlock is
  // constructed below (via renderResolvedInfoHtml). No need to set it
  // here.

  // Clear every resolved-state field on the pool. Called whenever the
  // quote-token identity changes (dropdown change OR custom-address
  // change) so stale info from the prior token doesn't bleed through
  // until the new resolution returns.
  //
  // The compat fields (resolvedCompatible, resolvedIsToken2022, etc) are
  // particularly important to reset: if the previous token was flagged
  // incompatible, the red warning would persist on the new token until
  // resolvePoolQuote() returned, AND updateContinueToFundingState() would
  // keep blocking the Continue button on the stale compatible=false. By
  // resetting to compatible=null (unknown), the UI cleanly transitions
  // through "unknown" → "compatible/incompatible" as resolution
  // completes, with no stale-state lockout.
  function clearResolvedFields() {
    pool.resolvedSymbol = null;
    pool.resolvedDecimals = null;
    pool.resolvedPriceUsd = null;
    pool.resolvedMint = null;
    pool.resolvedName = null;
    pool.resolvedImageUrl = null;
    pool.resolvedCompatible = null;
    pool.resolvedIsToken2022 = false;
    pool.resolvedDisallowedNames = [];
    pool.resolvedCompatError = null;
  }

  quoteSelect.addEventListener('change', () => {
    const v = quoteSelect.value;
    if (v === '__custom') {
      quoteCustom.classList.remove('hidden');
      pool.quoteToken = quoteCustom.value || '';
    } else {
      quoteCustom.classList.add('hidden');
      pool.quoteToken = v;
    }
    clearResolvedFields();
    // Refresh the resolved-info block (now empty) and header chrome.
    updateQuoteResolvedDisplay(idx);
    // Also refresh the continue-state immediately — the previous quote
    // may have been blocking via compatible=false; clearing it should
    // unblock the button right away (subject to other pool validations).
    updateContinueToFundingState();
    resolvePoolQuote(idx);
  });
  quoteCustom.addEventListener('change', () => {
    pool.quoteToken = quoteCustom.value;
    clearResolvedFields();
    updateQuoteResolvedDisplay(idx);
    updateContinueToFundingState();
    resolvePoolQuote(idx);
  });

  row1.querySelector('[data-field="supplyPercent"]').addEventListener('input', (e) => {
    pool.supplyPercent = Number(e.target.value);
    // Pool's allocation as % of total supply is one of the inputs to
    // the bootstrap's derived supplyPercent (bs_pct = bs_usd / pool_usd
    // × 100, and pool_usd = targetMc × pool.supplyPercent / 100). If we
    // don't recompute on a pool-size change, positions total drifts and
    // the bootstrap row's hint shows stale numbers.
    recomputePoolBootstrapAndRebalance(pool);
    refreshBootstrapHint(idx);
    refreshWideSliceInputs(idx);
    updateAllocationSummary();
    updatePoolTitle(idx);
    updatePoolPositionsTotal(idx);
    updateContinueToFundingState();
  });

  row1.querySelector('[data-field="ammConfig"]').addEventListener('change', (e) => {
    pool.ammConfigIndex = Number(e.target.value);
  });

  // Resolved-info block. Multi-line layout that gives token info room
  // to breathe instead of cramming logo, name, decimals, and price onto
  // a single overflowing line. Appended after the form grid so it sits
  // between the inputs and the tier-3 action buttons. Filled by
  // renderResolvedInfoHtml() — same renderer used by the in-place
  // updateQuoteResolvedDisplay() so initial paint and post-resolution
  // refresh look identical.
  const resolvedBlock = document.createElement('div');
  resolvedBlock.className = 'resolved-info-block';
  resolvedBlock.dataset.field = 'resolvedBlock';
  resolvedBlock.innerHTML = renderResolvedInfoHtml(pool);
  // Hide the block entirely until resolution returns something — empty
  // grey card looks like a layout bug otherwise.
  if (!pool.resolvedSymbol) resolvedBlock.classList.add('hidden');
  body.appendChild(resolvedBlock);

  // Override section (manual quote token info).
  //
  // Always rendered in the DOM but visibility is controlled by the .hidden
  // class via applyOverrideVisibility() — that lets the async resolution
  // callback toggle visibility without re-rendering anything (and without
  // losing focus on whatever input the user is in). The default is hidden
  // when resolution succeeded fully, auto-shown when something failed or
  // when the user has typed an override.
  //
  // The toggle is a real button now (was a text link); same applies to
  // the distribution-section split toggle below. Tier-3 actions shouldn't
  // look like article hyperlinks.
  const actionRow = document.createElement('div');
  actionRow.className = 'pool-row-actions';
  body.appendChild(actionRow);

  const advToggle = document.createElement('button');
  advToggle.type = 'button';
  advToggle.className = 'button is-small is-light';
  advToggle.dataset.action = 'toggle-override';
  // textContent is set by applyOverrideVisibility() below
  actionRow.appendChild(advToggle);

  const adv = document.createElement('div');
  adv.className = 'advanced-section';
  adv.dataset.field = 'overrideSection';
  adv.innerHTML = `
    <p class="help mb-2">Override the auto-detected info for this quote token. Decimals are read on-chain so they should always be present; symbol comes from Metaplex metadata if available; USD price tries GeckoTerminal then Jupiter. Set anything here to override what the app found, or fill in a price if neither indexer had one.</p>
    <div class="columns is-mobile is-multiline">
      <div class="column">
        <label class="label is-small">Symbol override</label>
        <input class="input is-small" type="text" data-field="symOverride" value="${escapeAttr(pool.quoteSymbolOverride || '')}">
      </div>
      <div class="column">
        <label class="label is-small">Decimals override</label>
        <input class="input is-small" type="number" min="0" max="18" data-field="decOverride" value="${pool.quoteDecimalsOverride ?? ''}">
      </div>
      <div class="column">
        <label class="label is-small">USD price override</label>
        <input class="input is-small" type="number" min="0" step="any" data-field="usdOverride" value="${pool.quoteUsdOverride ?? ''}">
      </div>
    </div>
  `;
  body.appendChild(adv);

  // Set initial visibility + toggle text based on current resolution state.
  applyOverrideVisibility(node, pool);

  advToggle.addEventListener('click', () => {
    // Manual user toggle. Only meaningful when the section would otherwise
    // be hidden (resolution succeeded, no overrides set) — but flipping the
    // flag is harmless when conditions auto-show the section anyway.
    pool._overrideForceOpen = !pool._overrideForceOpen;
    applyOverrideVisibility(node, pool);
  });
  adv.querySelector('[data-field="symOverride"]').addEventListener('change', (e) => {
    pool.quoteSymbolOverride = e.target.value.trim() || null;
    updatePoolTitle(idx);
  });
  adv.querySelector('[data-field="decOverride"]').addEventListener('change', (e) => {
    const v = e.target.value;
    pool.quoteDecimalsOverride = v === '' ? null : Number(v);
    // Override may resolve a "price-missing" attention state; refresh
    // the header's title + affordance accordingly.
    updatePoolTitle(idx);
    updateContinueToFundingState();
  });
  adv.querySelector('[data-field="usdOverride"]').addEventListener('change', (e) => {
    const v = e.target.value;
    pool.quoteUsdOverride = v === '' ? null : Number(v);
    // Same — typing a USD override clears the price-missing warning.
    updatePoolTitle(idx);
    updateContinueToFundingState();
  });

  // Distribution section. Under the unified-positions model, slices
  // are first-class wide LP positions sharing the pool's allocation
  // alongside bootstrap and ladder bands. We always show the slice
  // row(s) — even when there's just one — so the user can see how
  // much of the pool is going to the main LP. Hiding this behind a
  // collapsed "Split fee distribution" button was confusing because
  // the user had no way to see the main LP's % allocation without
  // first expanding.
  //
  // The single-slice case is the common one and that single row
  // serves as "the main LP position." If the user wants to split fee
  // ownership across multiple wallets, they click "Add slice" and
  // the existing slice splits in half. Multiple slices = multiple
  // positions at the same wide range, each with its own Fee Key NFT.
  const distSection = document.createElement('div');
  distSection.className = 'distribution-section';
  body.appendChild(distSection);

  // Header. Text is gentler in the single-slice case (where "slice"
  // doesn't really describe anything — it's just the main LP) vs the
  // multi-slice case (where the split-into-pieces framing is accurate).
  const isSingleSlice = pool.distribution.length <= 1;
  const expandedHeader = document.createElement('div');
  expandedHeader.className = 'distribution-expanded-header';
  expandedHeader.innerHTML = isSingleSlice
    ? `<label class="label is-small mb-0">Main LP position <span class="has-text-grey has-text-weight-normal is-size-7">— wide position above launch; "Add slice" splits fee ownership across recipients</span></label>`
    : `<label class="label is-small mb-0">Main LP positions <span class="has-text-grey has-text-weight-normal is-size-7">— each is a wide position above launch with its own Fee Key</span></label>`;
  distSection.appendChild(expandedHeader);

  const sliceContainer = document.createElement('div');
  sliceContainer.className = 'distribution-slices';
  distSection.appendChild(sliceContainer);

  pool.distribution.forEach((slice, sliceIdx) => {
    sliceContainer.appendChild(buildSliceNode(pool, idx, slice, sliceIdx));
  });

  const addSliceBtn = document.createElement('button');
  addSliceBtn.className = 'button is-light is-small mt-1';
  addSliceBtn.innerHTML = '<span class="icon"><i class="fas fa-plus"></i></span><span>Add slice</span>';
  addSliceBtn.addEventListener('click', () => addSlice(idx));
  distSection.appendChild(addSliceBtn);

  // Custom Positions area. The mockup-approved order puts the whole-pool
  // liquidity depth chart at the TOP (it's the source of truth for the shape),
  // then the Ladder strategy picker, then the Support position at the bottom.
  //
  // Liquidity depth chart — a whole-pool view spanning the support buy wall
  // (below launch) and the wide + ladder positions (above launch). It sits
  // above the controls that feed it so the user reads the shape first, then
  // adjusts. updatePoolDepthChart fills it (and hides it when there's neither
  // a ladder nor support to show, so an unconfigured pool shows no empty chart).
  const depthWrap = document.createElement('div');
  depthWrap.className = 'pool-depth-chart';
  depthWrap.dataset.field = 'depthChart';
  depthWrap.style.cssText = 'margin: 18px 0 6px;';
  body.appendChild(depthWrap);

  // Ladder section: the volatility-strategy picker generates single-sided
  // bands above launch (supplyPercent of pool, lowerMultiplier, upperMultiplier
  // relative to launch). Bands are independent — they can overlap or have gaps,
  // and order doesn't matter to the backend math.
  //
  // Note: the per-pool bootstrap section used to render here too, but was
  // removed as part of the support-consolidation change. The bootstrap is now
  // always a minimal ~$1 reservation; real quote-side starting liquidity is
  // added via the Support position (below). Token-side density near launch
  // price is the Ladder's job.
  body.appendChild(buildLadderNode(pool, idx));

  // Support section: a single-sided quote-only position just below launch
  // price, backing any preallocated supply. Quote-only — does not affect
  // supplyPercent or the positions-total calculation, so it sits at the bottom
  // of the custom-positions area without participating in that math.
  body.appendChild(buildSupportNode(pool, idx));

  // Positions total indicator. Under unified semantics, bootstrap
  // (if custom) + sum(slice sharePercents) + sum(band supplyPercents)
  // must equal 100% of the pool's allocation. Rendered as a paragraph
  // at the bottom of the pool body with a stable data-attribute so
  // updatePoolPositionsTotal() can find and update it in place.
  const positionsTotal = document.createElement('p');
  positionsTotal.className = 'has-text-weight-semibold mt-3';
  positionsTotal.dataset.positionsTotal = '';
  body.appendChild(positionsTotal);

  // Paint the initial state.
  refreshPoolPositionsTotalNode(positionsTotal, pool);

  return node;
}

// Refresh a positions-total <p> in place with the latest sum and a
// pass/fail visual. Extracted out so both the initial render (above)
// and the in-place update from input handlers (updatePoolPositionsTotal
// below) share the same formatting logic.
function refreshPoolPositionsTotalNode(el, pool) {
  const total = computePoolPositionsTotal(pool);
  const ok = Math.abs(total - 100) <= 0.01;
  el.textContent = `Positions total: ${total.toFixed(2)}% of pool` + (ok ? ' ✓' : ' — must be 100%');
  el.classList.toggle('has-text-success', ok);
  el.classList.toggle('has-text-danger', !ok);
}

// In-place update of the positions-total indicator for one pool.
// Called from every input that changes a position's supply share:
// bootstrap supply input + SOL input, slice-share input, band supply
// input, plus add/remove operations on bands and slices.
//
// We rely on the pool's DOM node being the corresponding index'th
// child of poolList (renderPools paints them in order), and look up
// the indicator inside it via the stable data-attribute selector.
function updatePoolPositionsTotal(poolIdx) {
  const pool = pools[poolIdx];
  if (!pool) return;
  const poolNode = poolList.children[poolIdx];
  if (!poolNode) return;
  const el = poolNode.querySelector('[data-positions-total]');
  if (!el) return;
  refreshPoolPositionsTotalNode(el, pool);
  // The positions-total state also drives the pool's "needs attention"
  // affordance, so refresh that. updatePoolTitle paints the title
  // + affordance together.
  updatePoolTitle(poolIdx);
  updateContinueToFundingState();
}

// Update one pool's bootstrap-hint text in place. Reads the live
// targetMarketCap and the pool's current bs supplyPercent + pool size
// to render "≈ X% of pool · $Y of token supply". Safe to call when
// bootstrap is in minimal mode (clears the hint) or when target mcap
// is missing (clears the hint). Used by every input handler that can
// change inputs to the derivation (the bs SOL input, the pool's
// supplyPercent input) so we keep the hint accurate without a full
// renderPools() that would lose focus.
function refreshBootstrapHint(poolIdx) {
  const pool = pools[poolIdx];
  if (!pool) return;
  const node = poolList.children[poolIdx];
  if (!node) return;
  const hint = node.querySelector('[data-bs-hint]');
  if (!hint) return;
  const isCustom = pool.bootstrapConfig?.mode === 'custom';
  if (!isCustom) { hint.textContent = ''; return; }
  const pct = Number(pool.bootstrapConfig.supplyPercent) || 0;
  const targetMc = parseNumberInput(document.getElementById('targetMarketCap'));
  if (!Number.isFinite(targetMc) || targetMc <= 0 || pct <= 0) {
    hint.textContent = '';
    return;
  }
  const poolUsd = targetMc * (Number(pool.supplyPercent) / 100);
  const bsUsd = (pct / 100) * poolUsd;
  hint.textContent = `≈ ${pct.toFixed(3)}% of pool · $${formatUsdRoughly(bsUsd)} of token supply`;
}

// Refresh wide slice input values in place after a rebalance, without
// touching whichever input the user is currently typing in. Used by
// any handler that calls rebalanceWideSlicesByDelta without doing a
// full renderPools() (typically because the user is mid-keystroke in
// an input we'd destroy on re-render).
function refreshWideSliceInputs(poolIdx) {
  const pool = pools[poolIdx];
  if (!pool) return;
  const node = poolList.children[poolIdx];
  if (!node) return;
  const inputs = node.querySelectorAll('.distribution-slices .slice-share');
  inputs.forEach((inp, i) => {
    if (pool.distribution[i] && document.activeElement !== inp) {
      inp.value = pool.distribution[i].sharePercent;
    }
  });
}

// Build the per-pool support section shown in customize mode. Mirrors
// the bootstrap section in shape: a toggle to enable/disable, plus a
// SOL input as the canonical user-intent value. Unlike bootstrap,
// support is quote-only — it doesn't carve from supplyPercent, so the
// section has no slice-rebalancing or positions-total hooks. It's a
// pure cost-addition position.
//
// Storage: pool.supportConfig = {
//   mode: 'off' | 'custom',
//   solValue: number   (custom only; user's input — SOL value of the
//                       support deposit. Converted to USD-equivalent
//                       quote tokens by the orchestrator.)
// }
function buildSupportNode(pool, poolIdx) {
  const node = document.createElement('div');
  node.className = 'pool-support-section';

  const cfg = pool.supportConfig || { mode: 'off' };
  const isCustom = cfg.mode === 'custom';
  const solValue = Number(cfg.solValue) || 0;
  // Depth: defaults to the module default when the pool was created
  // before depth became configurable, or when mode is 'off' (in which
  // case the value is preserved but not used). Clamped for display.
  const depthPct = clampSupportDepth(
    cfg.depthPct != null ? cfg.depthPct : SUPPORT_DEFAULT_DEPTH_PCT,
  );

  // USD-equivalent display: convert SOL value through the SOL pool's
  // resolved price, if available. Falls back to no display when nothing
  // has resolved yet — same pattern as the simple-config support row.
  const solPool = pools.find((p) => (p.quoteToken || '').toUpperCase() === 'SOL');
  const solUsd = solPool && Number(solPool.resolvedPriceUsd) > 0
    ? Number(solPool.resolvedPriceUsd) : null;
  const initialHint = isCustom && solUsd && solValue > 0
    ? `≈ $${formatUsdRoughly(solValue * solUsd)} buy wall (launch to -${depthPct}%)`
    : (isCustom
        ? `(USD value will show once SOL price resolves; range -${depthPct}%)`
        : '');

  node.innerHTML = `
    <label class="label is-small mb-1 mt-3">
      <input type="checkbox" data-support-toggle ${isCustom ? 'checked' : ''}>
      Support position
    </label>
    <p class="is-size-7 has-text-grey mb-1">
      Single-sided buy-side liquidity that backs preallocated supply with an honest exit.
      The position sits just below launch price (covering down to the configured depth)
      and gives holders of preallocated tokens — team, VCs, presale contributors,
      staking rewards, utility reserves — a buy wall to sell into.
      Quote-only: doesn't carve from this pool's supply allocation.
    </p>
    <div class="slice-row support-row" ${isCustom ? '' : 'style="opacity:0.5;pointer-events:none;"'}>
      <span class="slice-label">Support</span>
      <input class="input is-small" type="number" min="0" step="0.01"
             data-support-sol-value value="${solValue}" ${isCustom ? '' : 'disabled'}
             style="width: 8rem;">
      <span style="line-height:30px;">SOL, down to&nbsp;-</span>
      <input class="input is-small" type="number"
             min="${SUPPORT_MIN_DEPTH_PCT}" max="${SUPPORT_MAX_DEPTH_PCT}" step="1"
             data-support-depth value="${depthPct}" ${isCustom ? '' : 'disabled'}
             style="width: 4.5rem;">
      <span style="line-height:30px;">% below launch</span>
      <span class="is-size-7 has-text-grey-dark" data-support-hint
            style="margin-left:0.5rem;line-height:30px;flex:1;">${escapeHtml(initialHint)}</span>
    </div>
  `;

  const toggle = node.querySelector('[data-support-toggle]');
  const solInput = node.querySelector('[data-support-sol-value]');
  const depthInput = node.querySelector('[data-support-depth]');
  const hint = node.querySelector('[data-support-hint]');

  // Helper: refresh the hint text from current config. Called after any
  // change so the display tracks state without a full re-render.
  function refreshHint() {
    const cur = pool.supportConfig || { mode: 'off' };
    if (cur.mode !== 'custom') {
      hint.textContent = '';
      return;
    }
    const sv = Number(cur.solValue) || 0;
    const dp = clampSupportDepth(cur.depthPct);
    const sp = pools.find((p) => (p.quoteToken || '').toUpperCase() === 'SOL');
    const su = sp && Number(sp.resolvedPriceUsd) > 0 ? Number(sp.resolvedPriceUsd) : null;
    if (su && sv > 0) {
      hint.textContent = `≈ $${formatUsdRoughly(sv * su)} buy wall (launch to -${dp}%)`;
    } else if (sv > 0) {
      hint.textContent = `(USD value will show once SOL price resolves; range -${dp}%)`;
    } else {
      hint.textContent = '';
    }
  }

  // Toggle: flip between off and custom. When flipping ON, restore the
  // last-known solValue + depthPct (or defaults for a fresh enable).
  // When flipping OFF, preserve both fields on the object so a re-toggle
  // restores the user's input — wire format ignores them in off-mode.
  toggle.addEventListener('change', (e) => {
    if (e.target.checked) {
      const restoredSol = Number(pool.supportConfig?.solValue) > 0
        ? Number(pool.supportConfig.solValue) : 1.0;
      const restoredDepth = clampSupportDepth(pool.supportConfig?.depthPct);
      pool.supportConfig = {
        mode: 'custom',
        solValue: restoredSol,
        depthPct: restoredDepth,
      };
    } else {
      pool.supportConfig = {
        mode: 'off',
        solValue: Number(pool.supportConfig?.solValue) || 0,
        depthPct: clampSupportDepth(pool.supportConfig?.depthPct),
      };
    }
    renderPools();
    // Allocation summary doesn't change (support is orthogonal), but
    // the continue-to-funding check might surface a related warning.
    if (typeof updateContinueToFundingState === 'function') updateContinueToFundingState();
  });

  // SOL input: canonical user-intent value. No supplyPercent to compute
  // or rebalance — support is quote-only. Just update state and the
  // hint, in place, so focus stays on the input the user is typing in.
  solInput.addEventListener('input', (e) => {
    const v = Number(e.target.value);
    if (!Number.isFinite(v) || v < 0) return;
    pool.supportConfig = {
      mode: 'custom',
      solValue: v,
      depthPct: clampSupportDepth(pool.supportConfig?.depthPct),
    };
    refreshHint();
    updatePoolDepthChart(poolIdx);
    if (typeof updateContinueToFundingState === 'function') updateContinueToFundingState();
  });

  // Depth input: percent below launch the position covers. Same in-place
  // refresh pattern as the SOL input — don't snap the input value
  // during typing (would interrupt the user mid-keystroke); snap on blur.
  depthInput.addEventListener('input', (e) => {
    const v = Number(e.target.value);
    if (!Number.isFinite(v)) return;
    pool.supportConfig = {
      mode: 'custom',
      solValue: Number(pool.supportConfig?.solValue) || 0,
      depthPct: v, // un-clamped during typing; clamped at use-sites
    };
    refreshHint();
    updatePoolDepthChart(poolIdx);
    if (typeof updateContinueToFundingState === 'function') updateContinueToFundingState();
  });
  depthInput.addEventListener('blur', (e) => {
    const v = clampSupportDepth(e.target.value);
    pool.supportConfig = {
      mode: 'custom',
      solValue: Number(pool.supportConfig?.solValue) || 0,
      depthPct: v,
    };
    e.target.value = v;
    refreshHint();
    updatePoolDepthChart(poolIdx);
  });

  return node;
}

function buildBootstrapNode(pool, poolIdx) {
  // Bootstrap is one of three position types (alongside wide slices
  // and ladder bands). Two states:
  //   minimal — 1-whole-token reserve, no user funds, no slot in 100%
  //   custom  — user-funded position, sized by an absolute SOL value
  //
  // The user thinks in terms of "how much starting liquidity do I want
  // to put down", not "what % of supply." So this row has a single SOL
  // input as the canonical control; the supplyPercent (% of pool) is
  // derived live and shown in the hint. Whenever solValue changes, or
  // target mcap changes, or SOL price resolves, supplyPercent is
  // recomputed and the wide slices auto-rebalance so positions total
  // stays at 100%.
  //
  // Storage: pool.bootstrapConfig = {
  //   mode: 'minimal' | 'custom',
  //   solValue: number   (custom only; user's input)
  //   supplyPercent: number   (custom only; derived from solValue)
  // }
  // The wire format conversion in buildAllocationsForApi uses
  // supplyPercent directly — solValue stays on the UI side.
  const node = document.createElement('div');
  node.className = 'pool-bootstrap-section';

  const cfg = pool.bootstrapConfig || { mode: 'minimal' };
  const isCustom = cfg.mode === 'custom';
  const solValue = Number(cfg.solValue) || 0;

  node.innerHTML = `
    <label class="label is-small mb-1 mt-3">
      <input type="checkbox" data-bs-toggle ${isCustom ? 'checked' : ''}>
      Bootstrap support liquidity
    </label>
    <p class="is-size-7 has-text-grey mb-1">
      Single full-range position centered on launch price.
      Off: a tiny ~$1 reserve that just makes the pool tradable.
      On: a meaningful starting-liquidity position. Token-side carves from this pool's allocation;
      quote-side is funded during the next step.
    </p>
    <div class="slice-row bootstrap-row" ${isCustom ? '' : 'style="opacity:0.5;pointer-events:none;"'}>
      <span class="slice-label">Bootstrap</span>
      <input class="input is-small" type="number" min="0" step="0.001"
             data-bs-sol-value value="${solValue}" ${isCustom ? '' : 'disabled'}
             style="width: 8rem;">
      <span style="line-height:30px;">SOL of starting liquidity</span>
      <span class="is-size-7 has-text-grey-dark" data-bs-hint style="margin-left:0.5rem;line-height:30px;flex:1;"></span>
    </div>
  `;

  const toggle = node.querySelector('[data-bs-toggle]');
  const solInput = node.querySelector('[data-bs-sol-value]');

  // Render the initial hint via the shared helper. Subsequent refreshes
  // also go through the helper so the rendering stays consistent.
  refreshBootstrapHint(poolIdx);

  // Toggle: flip between minimal and custom.
  //   custom default: 0.5 SOL of starting liquidity (matches simple-UI
  //   default). When flipping back to minimal, preserve solValue so
  //   re-toggling restores it without losing user input.
  // After flipping, the bs supplyPercent (derived) changes by the
  // full bs amount; rebalance wide slices accordingly so positions
  // total stays at 100%.
  toggle.addEventListener('change', (e) => {
    const oldPct = (pool.bootstrapConfig && pool.bootstrapConfig.mode === 'custom')
      ? Number(pool.bootstrapConfig.supplyPercent) || 0
      : 0;
    if (e.target.checked) {
      // Restore prior solValue if any; default to 0.5 SOL.
      const restoredSol = Number(pool.bootstrapConfig?.solValue) > 0
        ? Number(pool.bootstrapConfig.solValue) : 0.5;
      const newPct = computeBootstrapSupplyPercent(restoredSol, Number(pool.supplyPercent)) || 0;
      pool.bootstrapConfig = { mode: 'custom', solValue: restoredSol, supplyPercent: newPct };
    } else {
      // Preserve solValue on the object so re-toggle restores it. Wire
      // format ignores solValue/supplyPercent in minimal mode.
      pool.bootstrapConfig = {
        mode: 'minimal',
        solValue: Number(pool.bootstrapConfig?.solValue) || 0,
        supplyPercent: 0,
      };
    }
    const newPct = (pool.bootstrapConfig.mode === 'custom')
      ? Number(pool.bootstrapConfig.supplyPercent) || 0 : 0;
    rebalanceWideSlicesByDelta(pool, newPct - oldPct);
    renderPools();
  });

  // SOL input: canonical value. Compute new supplyPercent and rebalance
  // slices so positions total stays at 100%. We update only the hint
  // text and the positions-total indicator in place — full re-render
  // would lose focus on the input the user is typing in.
  solInput.addEventListener('input', (e) => {
    const v = Number(e.target.value);
    if (!Number.isFinite(v) || v < 0) return;
    const oldPct = Number(pool.bootstrapConfig?.supplyPercent) || 0;
    const newPct = computeBootstrapSupplyPercent(v, Number(pool.supplyPercent)) || 0;
    pool.bootstrapConfig = { mode: 'custom', solValue: v, supplyPercent: newPct };
    rebalanceWideSlicesByDelta(pool, newPct - oldPct);
    refreshBootstrapHint(poolIdx);
    refreshWideSliceInputs(poolIdx);
    updatePoolPositionsTotal(poolIdx);
  });

  return node;
}

// ---------------------------------------------------------------------------
// Custom Positions — Ladder strategy support
// ---------------------------------------------------------------------------

// Compact multiplier label for the ladder controls and chips. Mirrors the
// depth chart's formatter (k/M/B/T, scientific past a trillion) so the numbers
// read the same in the controls as on the axis.
function formatMultiplierLabel(m) {
  if (!Number.isFinite(m) || m <= 0) return '0';
  if (m >= 1e15) return m.toExponential(1).replace('e+', 'e');
  if (m >= 1e12) return `${+(m / 1e12).toFixed(1)}T`;
  if (m >= 1e9) return `${+(m / 1e9).toFixed(1)}B`;
  if (m >= 1e6) return `${+(m / 1e6).toFixed(1)}M`;
  if (m >= 1000) return `${+(m / 1000).toFixed(m < 10000 ? 1 : 0)}k`;
  return String(Math.round(m));
}

// The pool's maximum ladder ceiling, as a multiple of the launch price. We cap
// it at an honest $1B fully-diluted market cap rather than the tick range's
// true limit (which is absurd — a cheap launch has ~1e25× of tick headroom).
// Market cap scales linearly with price (supply is fixed), so the multiplier
// that reaches a $1B FDV is just CEILING_MAX_MCAP_USD ÷ launch market cap —
// needing only the market cap input, no quote price, decimals, or tick math.
// Rounded down to two significant figures for a clean cap. The backend still
// clamps any band to the real tick bound at execution, so this is purely the
// editor's ceiling.
//
// (The `pool` argument is unused — market cap is a token-level figure shared
// across pools — but kept for call-site symmetry with the other pool helpers.)
function poolMaxCeilingMultiplier(pool) {
  const mcap = parseNumberInput(document.getElementById('targetMarketCap'));
  if (!(mcap > 0)) return LADDER_CEILING_FALLBACK_MAX;
  const mult = CEILING_MAX_MCAP_USD / mcap;
  if (!(mult > 0) || !Number.isFinite(mult)) return LADDER_CEILING_FALLBACK_MAX;
  // Round down to two significant figures: clean to show, and never above $1B.
  const e = Math.floor(Math.log10(mult));
  const f = Math.pow(10, e - 1);
  return Math.max(1, Math.floor(mult / f) * f);
}

// Build the controls-help line under the ladder's Bands/Gap/Ceiling inputs.
// Shared by buildLadderNode's render and refreshLadderMcapDisplays so the
// wording lives in one place. The trailing sentence translates the current
// ceiling multiplier into the market cap it tops out at (mcap × ceiling, since
// mcap scales linearly with price) — making a bare "100,000×" legible in
// dollars and tying it to the $1B cap. Omitted until market cap is set.
function ladderControlsHelpHtml(pool, poolMax) {
  const cfg = (pool && pool.ladderConfig) || {};
  const base = `Gap is the air-pocket before the first band. Ceiling tops the ladder — default ${formatMultiplierLabel(LADDER_CEILING_DEFAULT)}×, up to a $1B market cap (${formatMultiplierLabel(poolMax)}×).`;
  const mcap = parseNumberInput(document.getElementById('targetMarketCap'));
  if (Number.isFinite(mcap) && mcap > 0 && Number(cfg.ceiling) > 0) {
    // Use the effective ceiling (clamped to the cap) for the dollar figure. In
    // steady state cfg.ceiling is already ≤ poolMax so this is a no-op; it only
    // bites while the user is typing mcap upward, before the blur-time re-clamp
    // — without it the readout would briefly show a market cap above $1B and
    // contradict the cap stated in the same sentence.
    const eff = Math.min(Number(cfg.ceiling), poolMax);
    return `${base} At ${formatMultiplierLabel(eff)}× the ladder tops out near ${formatUsdShort(mcap * eff)} market cap.`;
  }
  return base;
}

// Refresh the market-cap-derived bits of every visible ladder section in place:
// the ceiling dollar readout in the controls-help line and the ceiling input's
// max attribute (both derive from $1B ÷ mcap). Called live as the target market
// cap changes so the ladder stays honest without a full renderPools — which
// would reflow the whole pool list and could eat an in-flight click. This does
// NOT mutate band data or the stored ceiling; an over-cap ceiling is re-clamped
// on blur (see the targetMarketCap blur handler), not mid-keystroke.
function refreshLadderMcapDisplays() {
  for (let i = 0; i < pools.length; i++) {
    const pool = pools[i];
    const node = poolList.children[i];
    if (!node) continue;
    const help = node.querySelector('[data-ladder-controls-help]');
    const ceilingInput = node.querySelector('[data-ladder-ceiling]');
    if (!help && !ceilingInput) continue; // ladder off or pool collapsed
    const poolMax = poolMaxCeilingMultiplier(pool);
    if (ceilingInput) ceilingInput.max = String(Math.round(poolMax));
    if (help) help.innerHTML = ladderControlsHelpHtml(pool, poolMax);
  }
}

// Format a band multiplier for DISPLAY in the editable band-table inputs. The
// strategy generator stores precise values (e.g. 1.5613) so the band geometry
// and tick math stay exact; rendering all four decimals just makes the table
// noisy. We round only what's shown — the stored value is untouched and the
// input handlers write back only on a real user edit — so this cannot drift the
// bands or collapse a tight one. Faithful enough to edit against: two decimals
// under 10×, one decimal under 1000×, whole numbers above.
function formatBandMultiplierValue(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '';
  if (n < 10) return String(+n.toFixed(2));
  if (n < 1000) return String(+n.toFixed(1));
  return String(Math.round(n));
}

// Strategy display metadata (name, scenario tag, and the descriptive note shown
// under the picker). The shapes themselves live in generateLadderStrategyBands.
const LADDER_STRATEGY_META = {
  dbl: { name: 'Doubling', tag: 'easy to pump', note: 'Discrete bands that double in width past the gap — thin near launch for fast early movement, with supply fanned out toward the ceiling.' },
  gapdbl: { name: 'Gapped Doubling', tag: 'stepwise', note: 'Doubling\u2019s widening bands, spaced out with an air-pocket before each — supply climbs in widening steps, leaving room between for capitulation and fresh floors.' },
  invramp: { name: 'Inverse Ramp', tag: 'locks supply high', note: 'Overlapping bands all reaching the ceiling — depth builds upward, parking the most supply high where it cannot be dumped near launch. The strongest supply-control shape.' },
  pyr: { name: 'Pyramid', tag: 'mid concentration', note: 'Overlapping bands peak in the middle of the range — supply concentrated at mid multiples, lighter at both ends.' },
  multi: { name: 'Multi-Peak', tag: 'several peaks', note: 'Several humps spread across the range — supply distributed over multiple resistance shelves rather than piled at one point, with the lowest band at the gap and the highest reaching the ceiling.' },
};

// Backfill the strategy-config fields on a pool's ladderConfig. Pools created
// before the strategy picker existed (e.g. by the simple-config sliders, which
// use generateLogSpacedBands and lay their first band at 1×) carry only
// { mode, bands }. We set sensible defaults — notably the gap and ceiling come
// from the design defaults, NOT inferred from the seeded bands, so the gap
// lands on its intended 4× rather than the 1× those bands happen to start at.
// Band count and ladder share ARE carried over from the existing bands (the
// share has to be, or the positions total would shift). Idempotent.
function ensureLadderStrategyConfig(pool) {
  if (!pool.ladderConfig) pool.ladderConfig = { mode: 'off', bands: [] };
  const cfg = pool.ladderConfig;
  const bands = Array.isArray(cfg.bands) ? cfg.bands : [];

  // True only the first time the strategy system touches this pool.
  const wasUninitialized = !LADDER_STRATEGY_IDS.includes(cfg.strategy);
  if (wasUninitialized) cfg.strategy = LADDER_DEFAULT_STRATEGY;

  if (cfg.bandCount == null) {
    cfg.bandCount = bands.length >= LADDER_MIN_BANDS ? bands.length : LADDER_DEFAULT_BANDS;
  }
  cfg.bandCount = Math.min(LADDER_MAX_BANDS, Math.max(LADDER_MIN_BANDS, Math.round(cfg.bandCount)));

  // Gap and ceiling default to the design defaults rather than being read back
  // from the seeded bands (which start at 1×, which would otherwise pin the gap
  // at 1× instead of 4×).
  if (cfg.gap == null) cfg.gap = LADDER_GAP_DEFAULT;
  cfg.gap = Math.min(LADDER_GAP_MAX, Math.max(LADDER_GAP_MIN, cfg.gap));

  if (cfg.ceiling == null) {
    const maxHi = bands.length ? Math.max(...bands.map((b) => Number(b.upperMultiplier) || 0)) : 0;
    cfg.ceiling = maxHi > 0 ? maxHi : LADDER_CEILING_DEFAULT;
  }

  // Ladder share MUST be carried over from the existing bands — defaulting it
  // would shift the pool's positions total off 100%.
  if (cfg.ladderPercent == null) {
    const sum = bands.reduce((s, b) => s + (Number(b.supplyPercent) || 0), 0);
    cfg.ladderPercent = sum > 0 ? sum : LADDER_DEFAULT_PERCENT;
  }

  // Never let the ceiling exceed the pool's honest max ($1B market cap). This
  // clamps both the default (100,000×, which is above the cap for launches over
  // ~$10k FDV) and any inferred value, so the control, the cap, and the
  // generated bands all stay consistent.
  const capMax = poolMaxCeilingMultiplier(pool);
  if (Number(cfg.ceiling) > capMax) cfg.ceiling = capMax;

  // First time the strategy system takes over a pool whose bands were seeded
  // elsewhere (the simple-config ladder, laid from 1×): regenerate them from
  // the strategy defaults so the displayed ladder matches the controls — the
  // gap moves to 4×, etc. The ladder share is unchanged, so the positions total
  // stays put and no wide-slice rebalance is needed.
  if (wasUninitialized && bands.length > 0) {
    cfg.bands = generateLadderStrategyBands({
      strategy: cfg.strategy,
      ladderPercent: cfg.ladderPercent,
      bandCount: cfg.bandCount,
      gap: cfg.gap,
      ceiling: cfg.ceiling,
    });
  }

  return cfg;
}

// Regenerate the ladder bands from the pool's current strategy config, keeping
// the pool's positions total at 100% by absorbing the band-total delta into
// the wide slices (same rebalance the toggle/add/remove paths use). Caller is
// responsible for re-rendering (renderPools) afterwards.
function regenerateLadderBands(pool) {
  const cfg = ensureLadderStrategyConfig(pool);
  const oldTotal = (cfg.mode === 'manual' && Array.isArray(cfg.bands))
    ? cfg.bands.reduce((s, b) => s + (Number(b.supplyPercent) || 0), 0)
    : 0;
  cfg.mode = 'manual';
  cfg.bands = generateLadderStrategyBands({
    strategy: cfg.strategy,
    ladderPercent: cfg.ladderPercent,
    bandCount: cfg.bandCount,
    gap: cfg.gap,
    ceiling: cfg.ceiling,
  });
  const newTotal = cfg.bands.reduce((s, b) => s + (Number(b.supplyPercent) || 0), 0);
  rebalanceWideSlicesByDelta(pool, newTotal - oldTotal);
}

// Tiny stacked depth thumbnail for a strategy chip. Same liquidity math and
// palette as the per-pool depth chart (so a chip previews the shape the chart
// will draw): a tan wide-band baseline plus the ladder bands, each band an
// equal share of the ladder supply, stacked where they overlap.
function renderLadderThumbSvg(bands, ceiling) {
  const PALETTE = ['#9a2424', '#2f6f5e', '#c0871f', '#3f5a8a', '#8a3f6a', '#5f6a2a', '#7a4a2a'];
  const WIDE = '#d8c39a';
  const NOTIONAL = 250000;
  const Lt = (v, lo, hi) => { const d = 1 / Math.sqrt(lo) - 1 / Math.sqrt(hi); return d > 0 ? v / d : 0; };

  const bs = Array.isArray(bands) ? bands : [];
  const sumW = bs.reduce((s, b) => s + (Number(b.supplyPercent) || 0), 0);
  const wideW = Math.max(0, 100 - sumW);
  const C = Math.max(Number(ceiling) || 10, ...bs.map((b) => Number(b.upperMultiplier) || 1), 10);

  const comps = [];
  if (wideW > 0) comps.push({ c: WIDE, lo: 1, hi: C, L: Lt((wideW / 100) * NOTIONAL, 1, C) });
  bs.forEach((b, i) => {
    const lo = Math.max(1, Number(b.lowerMultiplier) || 1);
    const hi = Math.max(lo * 1.0001, Number(b.upperMultiplier) || 1);
    comps.push({ c: PALETTE[i % PALETTE.length], lo, hi, L: Lt(((Number(b.supplyPercent) || 0) / 100) * NOTIONAL, lo, hi) });
  });

  const edges = new Set([1, C]);
  comps.forEach((c) => { edges.add(c.lo); edges.add(c.hi); });
  const xs = Array.from(edges).filter((x) => x >= 1 && x <= C * 1.0001).sort((a, b) => a - b);

  const W = 120; const H = 34; const plotH = H - 4; const yB = H - 2;
  const lmin = Math.log(1); const lspan = (Math.log(C) - lmin) || 1;
  const X = (x) => ((Math.log(x) - lmin) / lspan) * W;

  let maxL = 0; const segs = [];
  for (let i = 0; i < xs.length - 1; i++) {
    const lo = xs[i]; const hi = xs[i + 1];
    if (hi <= lo) continue;
    let tot = 0; const parts = [];
    comps.forEach((c) => { if (c.lo <= lo + 1e-9 && c.hi >= hi - 1e-9) { parts.push(c); tot += c.L; } });
    segs.push({ lo, hi, parts });
    if (tot > maxL) maxL = tot;
  }
  maxL = maxL || 1;

  let f = '';
  for (const sgmt of segs) {
    const xa = X(sgmt.lo); const w = X(sgmt.hi) - xa;
    if (w <= 0) continue;
    let cum = 0;
    for (const p of sgmt.parts) {
      const h = (p.L / maxL) * plotH;
      if (h <= 0) continue;
      f += `<rect x="${xa.toFixed(1)}" y="${(yB - cum - h).toFixed(1)}" width="${Math.max(0.6, w).toFixed(1)}" height="${h.toFixed(1)}" fill="${p.c}" fill-opacity="0.9"/>`;
      cum += h;
    }
  }
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block;" aria-hidden="true">${f}</svg>`;
}

function buildLadderNode(pool, poolIdx) {
  // Custom Positions — Ladder. A "volatility strategy" picker generates the
  // ladder bands: pick a shape, set how many bands, the gap before the first
  // band, and the ceiling, and the bands are laid out for you. The bands stay
  // fully editable in the collapsed "Ladder positions" table — but those manual
  // edits are ephemeral: changing the strategy, band count, gap, or ceiling
  // regenerates the bands and discards them.
  //
  // The ladder's job is supply control: it relocates a slice of the pool's
  // supply to higher price ranges so it can't be dumped near launch. The depth
  // chart at the top of the pool is the source of truth for the shape.
  const node = document.createElement('div');
  node.className = 'pool-ladder-section box has-background-light p-3 mt-3 mb-0';

  const cfg = ensureLadderStrategyConfig(pool);
  const enabled = cfg.mode === 'manual';
  const poolMax = poolMaxCeilingMultiplier(pool);
  const tableOpen = !!cfg._uiTableOpen;

  node.innerHTML = `
    <label class="label is-small mb-1">
      <input type="checkbox" data-ladder-toggle ${enabled ? 'checked' : ''}>
      Ladder positions
    </label>
    <p class="is-size-7 has-text-grey mb-2">
      Single-sided positions above launch that relocate a slice of this pool's
      supply to higher price ranges — resistance going up, and supply that can't
      be dumped near launch. Pick a strategy to lay out the bands; they stay
      fully editable. Bands can overlap or leave gaps — both are valid.
    </p>
    <div class="ladder-bands-container" ${enabled ? '' : 'style="display:none;"'}>

      <div class="ladder-strategy-controls" style="display:flex;flex-wrap:wrap;gap:0.5rem 1.25rem;align-items:flex-end;margin-bottom:0.35rem;">
        <div class="field mb-0">
          <label class="label is-small mb-1">Bands</label>
          <div class="field has-addons mb-0">
            <div class="control"><button type="button" class="button is-small" data-ladder-band-dec>&minus;</button></div>
            <div class="control"><span class="button is-small is-static" data-ladder-band-count style="min-width:2.4rem;">${cfg.bandCount}</span></div>
            <div class="control"><button type="button" class="button is-small" data-ladder-band-inc>+</button></div>
          </div>
        </div>
        <div class="field mb-0">
          <label class="label is-small mb-1">Gap</label>
          <div class="field has-addons mb-0">
            <div class="control"><input class="input is-small" type="number" min="${LADDER_GAP_MIN}" max="${LADDER_GAP_MAX}" step="0.5" data-ladder-gap value="${cfg.gap}" style="width:4.5rem;"></div>
            <div class="control"><a class="button is-small is-static">× from launch</a></div>
          </div>
        </div>
        <div class="field mb-0">
          <label class="label is-small mb-1">Ceiling</label>
          <div class="field has-addons mb-0">
            <div class="control"><input class="input is-small" type="number" min="10" max="${Math.round(poolMax)}" step="1000" data-ladder-ceiling value="${cfg.ceiling}" style="width:8rem;"></div>
            <div class="control"><a class="button is-small is-static">× launch</a></div>
            <div class="control"><button type="button" class="button is-small is-light" data-ladder-ceiling-max title="Set to the max ($1B market cap)">max</button></div>
          </div>
        </div>
      </div>
      <p class="help has-text-grey mb-2" data-ladder-controls-help></p>

      <div class="ladder-strategy-chips" data-ladder-chips
           style="display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:0.4rem;margin-bottom:0.4rem;"></div>
      <p class="is-size-7 has-text-grey mb-2" data-ladder-strategy-note></p>

      <div class="ladder-positions-disclosure" data-ladder-disclosure role="button" tabindex="0"
           style="display:flex;align-items:center;gap:0.4rem;cursor:pointer;padding:0.45rem 0;border-top:1px solid rgba(0,0,0,0.08);">
        <span class="icon is-small"><i class="fas fa-chevron-${tableOpen ? 'down' : 'right'}" data-ladder-chevron></i></span>
        <span class="has-text-weight-semibold is-size-7">Ladder positions</span>
        <span class="is-size-7 has-text-grey" data-ladder-summary></span>
        <span class="is-size-7 has-text-grey" style="margin-left:auto;">tap to customize</span>
      </div>

      <div class="ladder-bands-detail" data-ladder-detail ${tableOpen ? '' : 'style="display:none;"'}>
        <div class="ladder-bands-list" data-ladder-bands></div>
        <div class="ladder-bands-actions" style="margin-top:0.5rem;">
          <button type="button" class="button is-small is-light" data-ladder-add>
            <span class="icon"><i class="fas fa-plus"></i></span><span>Add band</span>
          </button>
        </div>
        <p class="help has-text-grey mt-1">
          Manual edits here are temporary — changing the strategy, band count,
          gap, or ceiling above regenerates the bands and discards them.
        </p>
        <p class="help is-danger mt-1 hidden" data-ladder-warning></p>
      </div>

    </div>
  `;

  const toggle = node.querySelector('[data-ladder-toggle]');
  const chips = node.querySelector('[data-ladder-chips]');
  const noteEl = node.querySelector('[data-ladder-strategy-note]');
  const summaryEl = node.querySelector('[data-ladder-summary]');
  const controlsHelp = node.querySelector('[data-ladder-controls-help]');
  const bandsList = node.querySelector('[data-ladder-bands]');
  const addBtn = node.querySelector('[data-ladder-add]');
  const warning = node.querySelector('[data-ladder-warning]');
  const disclosure = node.querySelector('[data-ladder-disclosure]');
  const detail = node.querySelector('[data-ladder-detail]');
  const chevron = node.querySelector('[data-ladder-chevron]');

  // Render the current band rows (unchanged behaviour — editing a band updates
  // state in place; those edits persist until the next strategy regeneration).
  function renderBands() {
    bandsList.innerHTML = '';
    const bands = Array.isArray(pool.ladderConfig?.bands) ? pool.ladderConfig.bands : [];
    bands.forEach((band, bandIdx) => {
      bandsList.appendChild(buildBandRow(pool, poolIdx, band, bandIdx, renderBands, updateWarning));
    });
    updateWarning();
  }

  // Validate the band list and surface a warning when the total supplyPercent
  // exceeds 100% or any band has bad geometry. Backend pre-flight catches the
  // same conditions, but inline feedback during editing is friendlier.
  function updateWarning() {
    const bands = Array.isArray(pool.ladderConfig?.bands) ? pool.ladderConfig.bands : [];
    let msg = '';
    const totalPct = bands.reduce((s, b) => s + (Number(b.supplyPercent) || 0), 0);
    if (totalPct > 100) {
      msg = `Band supply totals ${totalPct.toFixed(2)}% — must be ≤ 100%.`;
    } else {
      for (let i = 0; i < bands.length; i++) {
        const b = bands[i];
        const lo = Number(b.lowerMultiplier);
        const hi = Number(b.upperMultiplier);
        if (!(lo >= 1)) { msg = `Band ${i + 1}: lower multiplier must be ≥ 1× launch price.`; break; }
        if (!(hi > lo)) { msg = `Band ${i + 1}: upper multiplier must be greater than lower.`; break; }
        if (!(b.supplyPercent > 0)) { msg = `Band ${i + 1}: supply % must be greater than 0.`; break; }
      }
    }
    if (msg) { warning.textContent = msg; warning.classList.remove('hidden'); }
    else { warning.classList.add('hidden'); }
  }

  // Render the five strategy chips, each previewing its shape with the current
  // band count / gap / ceiling. Clicking one switches the strategy and
  // regenerates the bands.
  function renderChips() {
    const lc = pool.ladderConfig;
    chips.innerHTML = '';
    LADDER_STRATEGY_IDS.forEach((id) => {
      const meta = LADDER_STRATEGY_META[id];
      const bands = generateLadderStrategyBands({ strategy: id, ladderPercent: lc.ladderPercent, bandCount: lc.bandCount, gap: lc.gap, ceiling: lc.ceiling });
      const selected = lc.strategy === id;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'button ladder-strategy-chip';
      btn.dataset.strategy = id;
      btn.style.cssText = 'height:auto;display:block;text-align:left;padding:0.4rem 0.45rem;white-space:normal;'
        + (selected ? 'border-color:#9a2424;box-shadow:inset 0 0 0 1px #9a2424;' : '');
      btn.innerHTML = renderLadderThumbSvg(bands, lc.ceiling)
        + `<div class="is-size-7 has-text-weight-semibold" style="line-height:1.1;margin-top:0.2rem;">${meta.name}</div>`
        + `<div class="has-text-grey" style="font-size:0.65rem;line-height:1.1;">${meta.tag}</div>`;
      btn.addEventListener('click', () => {
        pool.ladderConfig.strategy = id;
        regenerateLadderBands(pool);
        renderPools();
      });
      chips.appendChild(btn);
    });
  }

  // Refresh the selected-strategy note, the disclosure summary, and the
  // controls help line from current config.
  function updateMeta() {
    const lc = pool.ladderConfig;
    const meta = LADDER_STRATEGY_META[lc.strategy] || LADDER_STRATEGY_META[LADDER_DEFAULT_STRATEGY];
    noteEl.innerHTML = `<strong>${meta.name}</strong> — ${meta.note}`;
    summaryEl.textContent = `${lc.bandCount} bands · ${meta.name} · gap ${lc.gap}× · to ${formatMultiplierLabel(lc.ceiling)}×`;
    controlsHelp.innerHTML = ladderControlsHelpHtml(pool, poolMax);
  }

  // Toggle ladder on/off. Same wide-slice rebalance as before so positions
  // total stays at 100%. Turning on with no existing bands seeds them from the
  // current strategy; existing bands are preserved across an off/on cycle.
  toggle.addEventListener('change', (e) => {
    const lc = ensureLadderStrategyConfig(pool);
    const oldTotal = (lc.mode === 'manual' && Array.isArray(lc.bands))
      ? lc.bands.reduce((s, b) => s + (Number(b.supplyPercent) || 0), 0)
      : 0;
    if (e.target.checked) {
      lc.mode = 'manual';
      if (!Array.isArray(lc.bands) || lc.bands.length === 0) {
        lc.bands = generateLadderStrategyBands({ strategy: lc.strategy, ladderPercent: lc.ladderPercent, bandCount: lc.bandCount, gap: lc.gap, ceiling: lc.ceiling });
      }
    } else {
      lc.mode = 'off'; // keep bands on the object for restoration on re-toggle
    }
    const newTotal = (lc.mode === 'manual' && Array.isArray(lc.bands))
      ? lc.bands.reduce((s, b) => s + (Number(b.supplyPercent) || 0), 0)
      : 0;
    rebalanceWideSlicesByDelta(pool, newTotal - oldTotal);
    renderPools();
  });

  // Band-count stepper.
  node.querySelector('[data-ladder-band-dec]').addEventListener('click', () => {
    const lc = pool.ladderConfig;
    if (lc.bandCount > LADDER_MIN_BANDS) { lc.bandCount -= 1; regenerateLadderBands(pool); renderPools(); }
  });
  node.querySelector('[data-ladder-band-inc]').addEventListener('click', () => {
    const lc = pool.ladderConfig;
    if (lc.bandCount < LADDER_MAX_BANDS) { lc.bandCount += 1; regenerateLadderBands(pool); renderPools(); }
  });

  // Gap and ceiling commit on change (blur/enter), not every keystroke, so
  // typing isn't interrupted by the regenerate-and-rerender.
  node.querySelector('[data-ladder-gap]').addEventListener('change', (e) => {
    let v = Number(e.target.value);
    if (!Number.isFinite(v)) v = LADDER_GAP_DEFAULT;
    v = Math.min(LADDER_GAP_MAX, Math.max(LADDER_GAP_MIN, v));
    pool.ladderConfig.gap = v;
    regenerateLadderBands(pool);
    renderPools();
  });
  node.querySelector('[data-ladder-ceiling]').addEventListener('change', (e) => {
    let v = Number(e.target.value);
    if (!Number.isFinite(v)) v = LADDER_CEILING_DEFAULT;
    const floor = Math.max(10, pool.ladderConfig.gap * 1.5);
    v = Math.min(poolMax, Math.max(floor, v));
    pool.ladderConfig.ceiling = v;
    regenerateLadderBands(pool);
    renderPools();
  });
  node.querySelector('[data-ladder-ceiling-max]').addEventListener('click', () => {
    pool.ladderConfig.ceiling = poolMax;
    regenerateLadderBands(pool);
    renderPools();
  });

  // Collapsed band table disclosure — toggled in place so we don't lose scroll
  // position; the open/closed state lives on the config so it survives the
  // full re-renders that control changes trigger.
  function setTableOpen(open) {
    pool.ladderConfig._uiTableOpen = open;
    detail.style.display = open ? '' : 'none';
    if (chevron) {
      chevron.classList.toggle('fa-chevron-down', open);
      chevron.classList.toggle('fa-chevron-right', !open);
    }
  }
  disclosure.addEventListener('click', () => setTableOpen(!pool.ladderConfig._uiTableOpen));
  disclosure.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setTableOpen(!pool.ladderConfig._uiTableOpen); }
  });

  // Add a manual band. Diverges the table from the strategy's band count until
  // the next regeneration — that's the intended ephemeral-edit behaviour. Opens
  // the table so the user sees the row they just added.
  addBtn.addEventListener('click', () => {
    const lc = ensureLadderStrategyConfig(pool);
    if (!Array.isArray(lc.bands)) lc.bands = [];
    lc.mode = 'manual';
    const newBand = { supplyPercent: 5, lowerMultiplier: 1.5, upperMultiplier: 2.0 };
    lc.bands.push(newBand);
    lc._uiTableOpen = true;
    rebalanceWideSlicesByDelta(pool, newBand.supplyPercent);
    renderPools();
  });

  // Initial paint.
  renderChips();
  updateMeta();
  renderBands();

  return node;
}

// Build a single band-row editor. Each band has three numeric inputs
// (supplyPercent of pool, lowerMultiplier, upperMultiplier) plus a
// remove button. The mcap hint below shows the dollar-value range
// based on the current target market cap input.
//
// Uses the same slice-row CSS class as wide slices and the bootstrap
// row so all positions in the pool look visually consistent.
function buildBandRow(pool, poolIdx, band, bandIdx, rerenderBands, updateWarning) {
  const row = document.createElement('div');
  row.className = 'slice-row band-row';

  row.innerHTML = `
    <span class="slice-label">Band ${bandIdx + 1}</span>
    <input class="input is-small slice-share" type="number" min="0" max="100" step="0.01"
           data-field="supplyPercent" value="${Number(band.supplyPercent)}">
    <span style="line-height:30px;">% of pool</span>
    <span class="is-size-7 has-text-grey" style="line-height:30px;">Range:</span>
    <input class="input is-small" type="number" min="1" step="0.01"
           data-field="lowerMultiplier" value="${formatBandMultiplierValue(band.lowerMultiplier)}" style="width: 5rem;">
    <span class="is-size-7" style="line-height:30px;">× to</span>
    <input class="input is-small" type="number" min="1" step="0.01"
           data-field="upperMultiplier" value="${formatBandMultiplierValue(band.upperMultiplier)}" style="width: 5rem;">
    <span class="is-size-7" style="line-height:30px;">× launch</span>
    <span class="is-size-7 has-text-grey-dark" data-mcap-hint style="line-height:30px;margin-left:0.4rem;flex:1;"></span>
    <button class="button is-danger is-small is-light" data-action="remove-band" title="Remove band">
      <span class="icon is-small"><i class="fas fa-times"></i></span>
    </button>
  `;

  const hint = row.querySelector('[data-mcap-hint]');

  // Refresh the mcap hint based on current targetMarketCap input. Called
  // on initial render and whenever the lower/upper multipliers change.
  function updateMcapHint() {
    const targetMc = parseNumberInput(document.getElementById('targetMarketCap'));
    const lo = Number(band.lowerMultiplier);
    const hi = Number(band.upperMultiplier);
    if (Number.isFinite(targetMc) && targetMc > 0 && lo > 0 && hi > 0) {
      hint.textContent = `≈ $${formatUsdRoughly(lo * targetMc)} – $${formatUsdRoughly(hi * targetMc)} mcap`;
    } else {
      hint.textContent = '';
    }
  }

  // Wire the three numeric inputs. Each updates the band object in
  // place and re-runs the cross-band validation that lights up the
  // warning paragraph below the row list. Also re-runs the pool-level
  // positions-total recompute, since changing a band's % of pool
  // changes what's left for the wide bucket.
  row.querySelector('[data-field="supplyPercent"]').addEventListener('input', (e) => {
    const v = Number(e.target.value);
    if (Number.isFinite(v) && v >= 0) {
      band.supplyPercent = v;
      updateWarning();
      updatePoolPositionsTotal(poolIdx);
    }
  });
  row.querySelector('[data-field="lowerMultiplier"]').addEventListener('input', (e) => {
    const v = Number(e.target.value);
    if (Number.isFinite(v) && v >= 1) {
      band.lowerMultiplier = v;
      updateMcapHint();
      updateWarning();
      updatePoolDepthChart(poolIdx);
    }
  });
  row.querySelector('[data-field="upperMultiplier"]').addEventListener('input', (e) => {
    const v = Number(e.target.value);
    if (Number.isFinite(v) && v >= 1) {
      band.upperMultiplier = v;
      updateMcapHint();
      updateWarning();
      updatePoolDepthChart(poolIdx);
    }
  });

  row.querySelector('[data-action="remove-band"]').addEventListener('click', () => {
    // Removing a band frees up its share back to the wide bucket so
    // positions total stays at 100%. Same pattern as remove-slice and
    // the bs/ladder toggles.
    const removedShare = Number(pool.ladderConfig.bands[bandIdx].supplyPercent) || 0;
    pool.ladderConfig.bands.splice(bandIdx, 1);
    rebalanceWideSlicesByDelta(pool, -removedShare);
    renderPools();
  });

  // Initial mcap hint.
  updateMcapHint();

  return row;
}

// Format a USD number for compact display: $1.2k, $35k, $1.2M, etc.
// Used by the ladder + bootstrap dollar hints next to multiplier-based
// inputs, so user can see the absolute mcap each input maps to.
function formatUsdRoughly(value) {
  if (!Number.isFinite(value) || value <= 0) return '0';
  if (value < 1000) return value.toFixed(0);
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10000 ? 1 : 0)}k`;
  if (value < 1_000_000_000) return `${(value / 1_000_000).toFixed(value < 10_000_000 ? 1 : 0)}M`;
  return `${(value / 1_000_000_000).toFixed(1)}B`;
}

// USD formatter for the funding-step auto-swap rows. Returns a $-prefixed
// short form that handles the wide value range we see there:
//   $0.0001 / $0.05 / $1.23 / $42 / $1.2k / $5M
// Differs from formatUsdRoughly above (which omits the $ and treats
// sub-dollar as "0") because the auto-swap context routinely shows
// fractional-dollar values (memecoin acquire targets are often a few
// cents). Returns '<$0.01' rather than "$0" for the truly tiny case so
// the user knows the figure is meaningful but small.
function formatUsdShort(value) {
  if (!Number.isFinite(value) || value <= 0) return '$0';
  if (value < 0.01) return '<$0.01';
  if (value < 1) return `$${value.toFixed(2)}`;
  if (value < 1000) return `$${value.toFixed(value < 10 ? 2 : 0)}`;
  if (value < 1_000_000) return `$${(value / 1000).toFixed(value < 10000 ? 1 : 0)}k`;
  if (value < 1_000_000_000) return `$${(value / 1_000_000).toFixed(value < 10_000_000 ? 1 : 0)}M`;
  return `$${(value / 1_000_000_000).toFixed(1)}B`;
}

function buildSliceNode(pool, poolIdx, slice, sliceIdx) {
  const node = document.createElement('div');
  node.className = 'slice-row';
  // Hide the remove button when this is the only slice — removeSlice
  // short-circuits in that case anyway, and a non-functional X button
  // is more confusing than just not showing it.
  const isOnlySlice = pool.distribution.length === 1;
  // Label is "Slice N/M" only when there's more than one; for a single
  // slice the "Main LP position" header above already provides context
  // and "Slice 1/1" reads oddly.
  const labelText = isOnlySlice ? 'Slice' : `Slice ${sliceIdx + 1}/${pool.distribution.length}`;
  node.innerHTML = `
    <span class="slice-label">${labelText}</span>
    <input class="input is-small slice-share" type="number" min="0" max="100" step="0.01" value="${slice.sharePercent}">
    <span style="line-height:30px;">% of pool</span>
    <label class="checkbox is-small" style="line-height:30px;">
      <input type="checkbox" data-field="useExternal" ${slice.useExternalRecipient ? 'checked' : ''}>
      &nbsp;Send to a different wallet
    </label>
    <input class="input is-small ${slice.useExternalRecipient ? '' : 'hidden'}" type="text" data-field="recipient" placeholder="Recipient address" value="${slice.recipient || ''}" style="flex: 1; min-width: 200px;">
    ${isOnlySlice ? '' : `<button class="button is-danger is-small is-light" data-action="remove-slice"><span class="icon is-small"><i class="fas fa-times"></i></span></button>`}
  `;

  const shareInput = node.querySelector('.slice-share');
  shareInput.addEventListener('input', (e) => {
    slice.sharePercent = Number(e.target.value);
    // Targeted update only — we used to call renderPools() here, which
    // destroyed and recreated *every* input element in *every* pool on
    // every keystroke. The browser would lose focus on the input you were
    // typing in, the cursor would reset, and typing felt broken.
    //
    // Under unified semantics, slice sharePercent is "% of pool" and
    // the constraint is at the pool level (bs + slices + bands = 100%).
    // updatePoolPositionsTotal refreshes the pool-level indicator, the
    // title affordance, and the continue button state in one shot.
    updatePoolPositionsTotal(poolIdx);
  });

  const useExt = node.querySelector('[data-field="useExternal"]');
  const recipientInput = node.querySelector('[data-field="recipient"]');

  useExt.addEventListener('change', (e) => {
    slice.useExternalRecipient = e.target.checked;
    if (e.target.checked) {
      recipientInput.classList.remove('hidden');
    } else {
      recipientInput.classList.add('hidden');
      slice.recipient = null;
      recipientInput.value = '';
    }
    updateContinueToFundingState();
  });
  recipientInput.addEventListener('change', (e) => {
    slice.recipient = e.target.value.trim() || null;
    updateContinueToFundingState();
  });

  // Remove button only rendered when there's more than one slice;
  // guard the lookup so single-slice rows don't throw.
  const removeBtn = node.querySelector('[data-action="remove-slice"]');
  if (removeBtn) {
    removeBtn.addEventListener('click', () => {
      removeSlice(poolIdx, sliceIdx);
    });
  }

  return node;
}

// Apply a resolved-info payload to a pool object. Used by both the
// fresh-fetch path and the cache-hit path so behavior is consistent.
// Mutates the pool in place; doesn't trigger any rendering.
function applyResolvedInfoToPool(pool, info) {
  if (!info) return;
  // For each field, prefer the new value when it's non-null, else
  // keep whatever's already on the pool. This protects against two
  // failure modes:
  //   1. Persisted metadata hydration (priceUsd: null in the cached
  //      entry) overwriting a fresh price that was already fetched
  //      since the page loaded.
  //   2. A partial server response (e.g. price oracle briefly down,
  //      priceUsd comes back null) clobbering a value we had.
  // For metadata fields the new value is usually the same as the
  // stored one anyway; the guard only matters for the volatile price.
  const setIfPresent = (field, value) => {
    if (value !== null && value !== undefined) pool[field] = value;
  };
  setIfPresent('resolvedSymbol', info.symbol);
  setIfPresent('resolvedDecimals', info.decimals);
  setIfPresent('resolvedPriceUsd', info.priceUsd);
  // Save the resolved on-chain mint too. Used as a display/link fallback
  // (e.g. when building Solscan or Birdeye URLs in the pool header) —
  // see the `pool.resolvedMint || pool.quoteToken` pattern elsewhere.
  setIfPresent('resolvedMint', info.address);
  // Display-only fields. Either may be null if no indexer had the
  // token; the UI handles that by hiding the logo and falling back
  // on the symbol where the name would have appeared.
  setIfPresent('resolvedName', info.name);
  setIfPresent('resolvedImageUrl', info.imageUrl);
  // Raydium CLMM compatibility info. Server-side we check whether the
  // quote token's mint program + Token-2022 extensions are allowed by
  // Raydium's on-chain `is_supported_mint` rules. The values here:
  //   compatible === true    → safe to use (either classic SPL, or
  //                            Token-2022 with allowlisted extensions,
  //                            or Token-2022 in Raydium's hardcoded
  //                            mint whitelist like PYUSD/AUSD)
  //   compatible === false   → pool creation WILL fail; we warn loudly
  //                            and disable the Continue button
  //   compatible === null    → couldn't check (mint missing on chain,
  //                            RPC down). Treat as unknown — surface
  //                            a note, don't block.
  setIfPresent('resolvedCompatible', info.compatible);
  // Boolean: a non-null incoming value wins, null/undef leaves prior.
  if (info.isToken2022 !== null && info.isToken2022 !== undefined) {
    pool.resolvedIsToken2022 = !!info.isToken2022;
  }
  // Arrays: empty array is a real value (means "no disallowed names")
  // so we update unconditionally when the response carries one.
  if (Array.isArray(info.disallowedNames)) {
    pool.resolvedDisallowedNames = info.disallowedNames;
  }
  setIfPresent('resolvedCompatError', info.compatError);

  // Step 2 Raydium-route probe results from /api/quote-token-info.
  // All three of these can legitimately be null in a fresh response
  // (server couldn't run the probe), so we use direct assignment for
  // the verdict — we WANT to clear stale values when a re-fetch finds
  // the probe couldn't run this time.
  if (info.raydiumTradeable !== undefined) {
    pool.resolvedRaydiumTradeable = info.raydiumTradeable;
  }
  // raydiumProbeError is transient — always overwrite so a successful
  // retry clears the prior error rather than leaving a phantom one.
  pool.resolvedRaydiumProbeError = info.raydiumProbeError ?? null;

  // Authority audit. Boolean true/false/null all carry meaning so we
  // pass them through directly. null = "couldn't verify" and is
  // distinct from false ("verified safe").
  if (info.freezeAuthorityBlock !== undefined) {
    pool.resolvedFreezeAuthorityBlock = info.freezeAuthorityBlock;
  }
  if (info.mintAuthorityWarning !== undefined) {
    pool.resolvedMintAuthorityWarning = info.mintAuthorityWarning;
  }

  // Price source label, so the UI can render "from Raydium" vs
  // "from external indexer" alongside the price.
  if (info.priceSource !== undefined) {
    pool.resolvedPriceSource = info.priceSource;
  }

  // Mark resolution as succeeded so the retry hint goes away.
  pool.resolvedFailed = false;
  pool.resolvedFailedError = null;
}

// Fetch quote-token info from the server, with two layers of protection
// against redundant calls:
//   1. Hard cache (quoteInfoCache) — once we've successfully fetched a
//      mint's metadata, subsequent calls within the price TTL return
//      from cache. After the price TTL, we re-fetch (and re-cache);
//      metadata never expires so it stays correct across re-fetches.
//   2. In-flight dedup (quoteInfoInFlight) — if multiple callers ask
//      for the same mint while a fetch is already pending, they all
//      await the same Promise rather than firing parallel requests.
//
// Returns the info payload (same shape the server returns), or throws
// on hard failure. Caller decides what to do on failure.
async function fetchQuoteInfoCached(quoteToken) {
  // Cache hit with fresh price → return immediately.
  const cached = quoteInfoCache.get(quoteToken);
  if (cached && (Date.now() - cached.fetchedAt) < QUOTE_PRICE_TTL_MS) {
    return cached.info;
  }
  // Another caller is already fetching this mint → await their promise.
  if (quoteInfoInFlight.has(quoteToken)) {
    return quoteInfoInFlight.get(quoteToken);
  }
  // Fresh fetch. Wrap in a promise we store so concurrent callers wait
  // on it. Clear the in-flight entry in finally{} so a failed fetch
  // doesn't poison subsequent attempts (the user can retry).
  const promise = (async () => {
    try {
      const resp = await fetch('/api/quote-token-info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quoteToken }),
      });
      const data = await resp.json();
      if (!data.success) {
        throw new Error(data.error || 'quote-token-info failed');
      }
      // Cache the new payload. When we had a prior cached entry
      // (stale-price refresh case), merge so the fresh response augments
      // the prior data rather than wholesale replacing it. Specifically:
      //
      // - Fields the server returned with a real (non-null) value
      //   overwrite the prior value (fresh data wins).
      // - Fields the server returned as null/undefined fall back to the
      //   prior value (we trust our cached "I know this" over a fresh
      //   "I don't know right now").
      //
      // This matters most for priceUsd. If the price oracle is briefly
      // down on a refresh, we want to keep showing the user the last
      // known price — not switch to null and break the UI. Metadata
      // fields (symbol/decimals/name/etc.) are almost always present
      // on a successful response, but the same fallback protects us
      // against any future server-side path that might return them as
      // null transiently.
      let merged;
      if (cached) {
        merged = { ...cached.info };
        for (const [k, v] of Object.entries(data.info)) {
          if (v !== null && v !== undefined) {
            merged[k] = v;
          }
        }
      } else {
        merged = data.info;
      }
      // Only cache successful resolutions — ones where we actually read
      // the mint on-chain. A response with decimals=null means the mint
      // wasn't on-chain at fetch time (transient RPC failure, or the
      // mint will exist soon). Caching that placeholder would lock the
      // user into the failure state for 60s, preventing legitimate
      // retries from going through. Without the cache write here, the
      // user retrying immediately fires a fresh network call which can
      // succeed once the chain catches up.
      //
      // Note: this guard intentionally does NOT clear the in-flight
      // map (the finally block at function end does that); we let the
      // current pending callers all receive this placeholder result so
      // they each render the failure UI, but subsequent calls don't
      // get short-circuited by a cache hit.
      if (merged && merged.decimals != null) {
        quoteInfoCache.set(quoteToken, {
          info: merged,
          fetchedAt: Date.now(),
        });
        // Mirror the static metadata fields to localStorage so the
        // next session starts with logos/symbols/decimals already
        // known. Price isn't persisted — it's always re-fetched.
        persistQuoteMeta(quoteToken, merged);
      }
      return merged;
    } finally {
      quoteInfoInFlight.delete(quoteToken);
    }
  })();
  quoteInfoInFlight.set(quoteToken, promise);
  return promise;
}

async function resolvePoolQuote(idx) {
  const pool = pools[idx];
  if (!pool || !pool.quoteToken) return;
  // Capture the quote token at call time. If pools[] gets rebuilt while
  // we're awaiting the fetch (e.g. user types in support input), the
  // pool reference here might be orphaned by the time we return. We
  // re-look-up the pool by index after the await and only apply the
  // result if the pool at that index still has the same quote token.
  const requestedQuote = pool.quoteToken;
  // Read the SOL price from the cache BEFORE we await — this is the
  // baseline we compare against to detect a "first-time" or "after-TTL"
  // SOL price arrival. We compare against the cache (not pool state)
  // because pool state gets reset to null on every rebuildPoolsFromSimple
  // call, which would otherwise make every cache-hit resolve look like
  // "SOL price just appeared" and trigger spurious rebuilds.
  //
  // The cache survives across rebuilds, so it gives a stable reference
  // point: only when the cache itself changes (cold load brings in new
  // data, or 60s TTL expires and re-fetch returns a different price)
  // do we count this as a real SOL price change worth cascading.
  const solCachedBefore = quoteInfoCache.get('SOL');
  const solUsdBefore = solCachedBefore && solCachedBefore.info && Number(solCachedBefore.info.priceUsd) > 0
    ? Number(solCachedBefore.info.priceUsd) : null;
  try {
    const info = await fetchQuoteInfoCached(requestedQuote);
    // Re-check: is the pool at this index still the one we resolved for?
    // If the user changed the quote token or pools[] was rebuilt and the
    // index now refers to a different mint, applying our stale resolution
    // would corrupt the new pool's state.
    const currentPool = pools[idx];
    if (!currentPool || currentPool.quoteToken !== requestedQuote) {
      return;
    }
    applyResolvedInfoToPool(currentPool, info);

    // Post-resolution refresh of derived values that depend on the
    // live SOL price. Bootstrap supplyPercent is derived from
    // solValue × solUsd / poolUsd, so a SOL price update changes
    // the % each pool's bootstrap takes — without this refresh,
    // the positions total would drift away from 100% (the classic
    // "99.94% on initial load with default settings" bug). The
    // rebalance helper absorbs the delta into the wide slices.
    //
    // Runs in both simple AND customize mode because in both, the
    // user's intent is the SOL value they typed; the % is derived.
    // The only path we skip is when bootstrap is in minimal mode
    // (no solValue to recompute) — handled inside the helper.
    for (const p of pools) {
      recomputePoolBootstrapAndRebalance(p);
    }
    renderPools();

    // Simple-mode follow-up: rebuild pools when the SOL price changed
    // in the CACHE (not pool state). Cache-vs-cache comparison avoids
    // the false-positive that would fire on every cache-hit resolve
    // following a rebuildPoolsFromSimple() — without this guard, every
    // user keystroke would trigger a feedback loop of rebuilds.
    //
    // Real cases this fires on:
    //   - Cold load: cache had no SOL entry, now it does
    //   - 60s TTL expiry refetch returned a different SOL price
    //
    // False cases it correctly skips:
    //   - Cache hit after rebuild: SOL price in cache is the same
    //     value as it was when we entered this function
    //   - Any non-SOL resolve: SOL cache unchanged
    if (simpleConfig.mode === 'default') {
      const solCachedAfter = quoteInfoCache.get('SOL');
      const solUsdAfter = solCachedAfter && solCachedAfter.info && Number(solCachedAfter.info.priceUsd) > 0
        ? Number(solCachedAfter.info.priceUsd) : null;
      const solPriceChanged = solUsdBefore !== solUsdAfter;
      if (solPriceChanged) {
        // Rebuild so any auto-sized derived values (support SOL value
        // when auto+preallocation are on) get a fresh computation
        // against the new SOL price and propagate to every pool.
        rebuildPoolsFromSimple();
      }
      // Skip the simple-config re-render when the user is actively
      // typing into one of its inputs. Re-rendering destroys the
      // input element they're focused on, snapping their cursor out
      // of the field mid-keystroke. The resolve's data is still
      // applied to pool state above; the next render (triggered by
      // blur or any structural change) will catch up the displays.
      //
      // Inline display updates that don't depend on a full re-render
      // (USD figures, coverage indicator) are handled by their own
      // refresh helpers — see refreshSimpleSupportDisplay / the
      // inline patches in the prealloc-pct-input handler.
      if (!isFocusInsideSimpleConfigBody()) {
        renderSimpleConfig();
      } else {
        // Lightweight refresh of the displays that depend on resolved
        // prices, without destroying the input elements. Keeps the
        // user's typing focus intact while still reflecting that
        // (e.g.) the SOL price just arrived and we now know the
        // USD value of their typed support SOL.
        refreshSimpleSupportDisplayInline();
        refreshSimplePreallocDisplayInline();
      }
    }

    // Targeted update for the per-pool resolved-info block and the
    // continue-button validation state.
    updateQuoteResolvedDisplay(idx);
    updateContinueToFundingState();

    // The largest pool's quote logo is the coin's back face. Now that
    // this pool's resolvedImageUrl/resolvedSymbol may have changed,
    // refresh the back face (debounced, no-ops if unchanged or if the
    // coin isn't running).
    refreshCoinBackFace();
  } catch (e) {
    // Resolution failed (network blip, RPC error, server error). Surface
    // this in the resolved-info block with a retry affordance, instead
    // of just logging silently. Without this, the user sees an empty
    // resolved-info area and has no obvious recovery — they'd have to
    // edit the address field and tab away to re-trigger resolution.
    //
    // Re-check the pool still exists at this index before writing the
    // failure marker — same robustness as the success path. If pools[]
    // was rebuilt mid-fetch, our failure was for an obsolete request.
    const currentPool = pools[idx];
    if (!currentPool || currentPool.quoteToken !== requestedQuote) return;
    currentPool.resolvedFailed = true;
    currentPool.resolvedFailedError = e.message || 'unknown error';
    log(`Couldn't resolve quote info for ${requestedQuote}: ${e.message}`, 'warning');
    updateQuoteResolvedDisplay(idx);
    updateContinueToFundingState();
  }
}

function updateAllocationSummary() {
  const total = pools.reduce((s, p) => s + p.supplyPercent, 0);
  document.getElementById('totalAllocPct').textContent = total.toFixed(2);
  document.getElementById('unallocatedPct').textContent = Math.max(0, 100 - total).toFixed(2);
  const note = document.getElementById('allocationSummary');
  note.classList.toggle('is-danger', total > 100);
  note.classList.toggle('is-info', total <= 100);
}

// Update one pool's resolved-quote-info display in place.
//
// Used after resolvePoolQuote() finishes its async lookup and we've
// updated pool.resolvedSymbol / decimals / priceUsd / name / imageUrl.
// Touches only the resolved-info block below the form grid, the pool
// header (which carries logo + title + affordance), and the
// override-section visibility (which depends on whether resolution
// came back complete). Everything else in the pool's DOM (including
// any input the user might be typing in) stays untouched.
//
// Also handles the empty-state case: when no resolution data is
// present (typical right after the user changes the quote-token
// dropdown), the block is hidden entirely so we don't render an
// empty grey card that looks like a layout glitch.
function updateQuoteResolvedDisplay(poolIdx) {
  const pool = pools[poolIdx];
  if (!pool) return;
  const node = poolList.children[poolIdx];
  if (!node) return;
  const block = node.querySelector('[data-field="resolvedBlock"]');
  if (block) {
    if (pool.resolvedSymbol) {
      block.innerHTML = renderResolvedInfoHtml(pool);
      block.classList.remove('hidden');
    } else {
      block.innerHTML = '';
      block.classList.add('hidden');
    }
  }
  // Refresh the title (now shows the resolved symbol and logo) and the
  // override section visibility (auto-shown when resolution came back
  // incomplete). updatePoolTitle covers logo + affordance too.
  updatePoolTitle(poolIdx);
  applyOverrideVisibility(node, pool);
}

function updateContinueToFundingState() {
  const btn = document.getElementById('continueToFundingBtn');
  if (!btn) return;
  const reasons = [];
  // Warnings are non-blocking — they surface a real concern but don't
  // disable the Continue button. The user explicitly said they want to
  // be allowed to launch with supply outside LP (presale, team alloc,
  // etc.); we just call out the choice so it isn't accidental.
  const warnings = [];

  if (pools.length === 0) reasons.push('No pools configured');
  const totalAlloc = pools.reduce((s, p) => s + p.supplyPercent, 0);
  if (totalAlloc > 100) reasons.push('Allocations exceed 100%');
  // Under-allocation: supply held outside LP. Per the spec, this is
  // allowed — "We should not prevent people from doing what they want,
  // and just warn." We do compute whether the existing support across
  // all pools covers the USD value of the preallocated supply, so the
  // warning text can be specific about what's actually risky:
  //
  //   - Preallocation with NO support → "rug risk, no backing"
  //   - Preallocation with PARTIAL support → "underbacked, support
  //     covers ~X% of preallocated value"
  //   - Preallocation with FULL support → no warning (the user has
  //     explicitly backed the held-back supply with equal-or-greater
  //     liquidity, which is the honest configuration)
  //
  // Computation:
  //   gapUsd      = (100 - totalAlloc) / 100 × marketCap
  //   supportUsd  = sum over pools of (supportConfig.solValue × solUsd)
  //   coverage    = supportUsd / gapUsd  (clamped to [0, 1] for the warning)
  //
  // When market cap or SOL price isn't available yet, we fall back to
  // the original "consider adding support" wording — we can't compute
  // coverage without prices, but we still want to surface the gap.
  if (totalAlloc < 99.99 && pools.length > 0) {
    const gap = 100 - totalAlloc;
    const gapText = (gap % 1 === 0) ? gap.toFixed(0) : gap.toFixed(1);
    const mcap = parseNumberInput(document.getElementById('targetMarketCap'));
    const solPool = pools.find((p) => (p.quoteToken || '').toUpperCase() === 'SOL');
    const solUsd = solPool && Number(solPool.resolvedPriceUsd) > 0
      ? Number(solPool.resolvedPriceUsd) : null;
    // Sum support USD across all pools that have support enabled. Each
    // pool's support is in SOL, so we multiply by the live SOL price to
    // get USD (consistent with how the funding estimate sizes it).
    let totalSupportUsd = 0;
    for (const p of pools) {
      const sc = p.supportConfig;
      if (sc && sc.mode === 'custom' && Number(sc.solValue) > 0 && solUsd) {
        totalSupportUsd += Number(sc.solValue) * solUsd;
      }
    }
    if (Number.isFinite(mcap) && mcap > 0 && solUsd) {
      const gapUsd = mcap * gap / 100;
      const coverage = gapUsd > 0 ? totalSupportUsd / gapUsd : 1;
      // Treat coverage ≥ 99.5% as "fully backed". Without this tolerance,
      // float drift between the auto-back floor calculation and this
      // check (different rounding moments, SOL price ticks between
      // reads, etc.) causes a 99.9%-coverage warning that asks the user
      // to add ~$0 / ~0.00 SOL — confusing and actionable in name only.
      // Math.round(coverage * 100) below would round 0.999 to "100%"
      // anyway, producing a "Support only backs ~100%" message that
      // contradicts itself.
      if (coverage >= 0.995) {
        // Fully backed — no warning. The preallocation is honest.
      } else if (totalSupportUsd <= 0) {
        warnings.push(
          `${gapText}% of supply (~$${formatUsdRoughly(gapUsd)}) is allocated outside LP ` +
            `with no support position backing it. This is a rug risk — add a Support ` +
            `position sized to ~$${formatUsdRoughly(gapUsd)} so holders of the preallocated ` +
            `supply have a buy wall to sell into.`,
        );
      } else {
        const coveragePct = Math.round(coverage * 100);
        const shortfallUsd = gapUsd - totalSupportUsd;
        warnings.push(
          `${gapText}% of supply (~$${formatUsdRoughly(gapUsd)}) is allocated outside LP, ` +
            `but Support only backs ~${coveragePct}% of it. Consider increasing Support ` +
            `by ~$${formatUsdRoughly(shortfallUsd)} (or in SOL terms, ` +
            `~${(shortfallUsd / solUsd).toFixed(2)} SOL) to fully back the preallocation.`,
        );
      }
    } else {
      // Fallback for when prices aren't available — generic warning.
      // No coverage math possible, so we can't be specific about how
      // much support is needed. The user will see this update once
      // prices resolve.
      warnings.push(
        `${gapText}% of supply is allocated outside LP (preallocation). ` +
          `Add a Support position to back it — without one, holders of the preallocated ` +
          `supply have no buy-side liquidity to sell into.`,
      );
    }
  }

  for (const [i, p] of pools.entries()) {
    if (!p.quoteToken) reasons.push(`Pool ${i + 1}: no quote token`);
    if (p.supplyPercent <= 0) reasons.push(`Pool ${i + 1}: 0% allocation`);
    if ((p.quoteToken || '').toUpperCase() === 'SOL' && p.supplyPercent < 1) {
      reasons.push(`Pool ${i + 1}: SOL allocation must be ≥ 1%`);
    }
    // Decimals must be resolved before we can do any launch math. If the
    // mint isn't on-chain or the user's RPC failed, p.resolvedDecimals is
    // null and the Advanced override is the only escape hatch — but if
    // they haven't supplied an override either, we can't continue.
    const hasDecimals = p.resolvedDecimals != null || p.quoteDecimalsOverride != null;
    if (!hasDecimals) {
      reasons.push(`Pool ${i + 1}: couldn't resolve decimals for ${p.resolvedSymbol || p.quoteToken}`);
    }
    const hasPrice = p.resolvedPriceUsd != null || p.quoteUsdOverride != null;
    if (!hasPrice) {
      reasons.push(`Pool ${i + 1}: no USD price for ${p.resolvedSymbol || p.quoteToken}`);
    }
    // Hard-block on known Raydium-CLMM incompatibility. We do NOT block on
    // resolvedCompatible === null (couldn't verify) — that's a soft warning,
    // user might be on a flaky RPC or the mint is new. Only resolvedCompatible
    // === false (we positively read the mint and found unsupported extensions)
    // gets blocked here. The pre-flight on the server side is a belt-and-
    // suspenders catch if this somehow gets bypassed.
    if (p.resolvedCompatible === false) {
      const exts = (p.resolvedDisallowedNames || []).join(', ');
      reasons.push(
        `Pool ${i + 1}: ${p.resolvedSymbol || p.quoteToken} is not Raydium-CLMM ` +
          `compatible (Token-2022 extensions: ${exts})`,
      );
    }

    // ──── Safety checks from price-safety-plan Milestone D ────
    //
    // Hard blocks (disable Continue button entirely):
    //   - Active freeze authority: deployer can freeze the launch
    //     wallet's quote-token balance mid-launch, bricking the
    //     process. Funds become unrecoverable through normal sweep.
    //   - Raydium has no route: pool creation will hard-fail at
    //     Step 5 anyway. Catching it here saves the user from going
    //     through Steps 3-4 (which costs SOL on fees) just to fail
    //     at the irreversible click.
    //
    // Soft warnings (allow Continue but flag the concern):
    //   - Active mint authority: supply can be inflated, devaluing
    //     pool contents. Doesn't brick the launch.
    //   - Couldn't verify Raydium liquidity: maybe Trade API is
    //     down right now; user can retry. Step 5 will hard-check.
    if (p.resolvedFreezeAuthorityBlock === true) {
      reasons.push(
        `Pool ${i + 1}: ${p.resolvedSymbol || p.quoteToken} has an active ` +
          `freeze authority. Its deployer could freeze your launch wallet's ` +
          `holdings mid-launch and brick the process.`,
      );
    }
    if (p.resolvedRaydiumTradeable === 'no') {
      // No Raydium liquidity for this token. NOT a hard block — we fall
      // back to GeckoTerminal/DexScreener which index Meteora and other
      // DEXes, so we can still get a real market price. Warn the user
      // so they're not surprised about the source. (The hasPrice check
      // above is the actual hard floor — if NO source produced a price,
      // that catches it.)
      warnings.push(
        `Pool ${i + 1}: Raydium has no pool for ${p.resolvedSymbol || p.quoteToken}. ` +
          `Verify the price is accurate before launching, or set an Advanced ` +
          `override if you know the correct value.`,
      );
    }
    if (p.resolvedMintAuthorityWarning === true) {
      warnings.push(
        `Pool ${i + 1}: ${p.resolvedSymbol || p.quoteToken}'s supply can be ` +
          `inflated by its deployer. Be aware that supply inflation could ` +
          `devalue the token before your pool is created.`,
      );
    }
    if (p.resolvedRaydiumTradeable === 'unknown') {
      warnings.push(
        `Pool ${i + 1}: couldn't reach the Raydium Trade API for ` +
          `${p.resolvedSymbol || p.quoteToken} right now. Trebuchet will ` +
          `retry at Step 5; if that also fails, you'll be asked to retry ` +
          `or set an override.`,
      );
    }
    // Pool-level positions total. Under the unified model, bootstrap
    // (if custom) + sum(slice sharePercents) + sum(band supplyPercents)
    // must equal 100% of pool. Failing this means the user has either
    // over- or under-allocated and the launch can't proceed.
    const positionsTotal = computePoolPositionsTotal(p);
    if (Math.abs(positionsTotal - 100) > 0.01) {
      reasons.push(
        `Pool ${i + 1}: positions total ${positionsTotal.toFixed(2)}% — ` +
          `bootstrap + slices + ladder must sum to 100%`,
      );
    }
    // Per-slice checks. We no longer flag a 0% slice as an error because
    // buildAllocationsForApi filters those out automatically (they
    // contribute nothing to the pool's allocation). A slice with an
    // external recipient configured but no address is still a real
    // mistake — flag it. An address that's filled in but doesn't even
    // look like base58 is also flagged here so the user sees the
    // problem on the same screen they entered it (without this check
    // the server's `normalizeDistribution` rejects with "Invalid
    // recipient address" only AFTER funding is committed).
    for (const [si, slice] of p.distribution.entries()) {
      if (slice.useExternalRecipient && !slice.recipient) {
        reasons.push(`Pool ${i + 1} slice ${si + 1}: recipient address required`);
      } else if (
        slice.useExternalRecipient &&
        slice.recipient &&
        !isPlausibleSolAddress(slice.recipient)
      ) {
        reasons.push(
          `Pool ${i + 1} slice ${si + 1}: recipient doesn't look like a valid ` +
            `Solana address`,
        );
      }
    }
  }

  // Duplicate-pool detection. Raydium derives the CLMM pool PDA from
  // (ammConfig, mintA, mintB), so two pools with the same quote token
  // AND the same fee tier collide at the on-chain account address. The
  // first createPool succeeds; the second fails at simulation with an
  // opaque "account already in use" error. No SOL is lost, but the
  // user gets a mid-launch failure with a confusing diagnostic.
  // Catching it here keeps the failure local to the form.
  //
  // Distinct fee tiers on the same quote are legitimately separate
  // pools — keyed by (normalized quote, ammConfigIndex) so they don't
  // collide here.
  const seenPoolKeys = new Map();
  for (const [i, p] of pools.entries()) {
    if (!p.quoteToken) continue;
    const quoteKey =
      (p.quoteToken || '').toUpperCase() === 'SOL' ? 'SOL' : p.quoteToken;
    const key = `${quoteKey}|${p.ammConfigIndex}`;
    if (seenPoolKeys.has(key)) {
      const firstIdx = seenPoolKeys.get(key);
      const label = p.resolvedSymbol || p.quoteToken;
      reasons.push(
        `Pool ${i + 1} duplicates Pool ${firstIdx + 1} (same ${label} ` +
          `quote at the same fee tier). Pick a different quote or a ` +
          `different fee tier — Raydium uses both to identify a pool.`,
      );
    } else {
      seenPoolKeys.set(key, i);
    }
  }

  const name = document.getElementById('tokenName')?.value.trim();
  const symbol = document.getElementById('tokenSymbol')?.value.trim();
  const supply = parseNumberInput(document.getElementById('tokenSupply'));
  const mc = parseNumberInput(document.getElementById('targetMarketCap'));
  if (!name) reasons.push('Token name required');
  if (!symbol) reasons.push('Token symbol required');
  if (!supply || supply <= 0) {
    reasons.push('Token supply must be > 0');
  } else if (supply > MAX_TOKEN_SUPPLY) {
    // Sanity cap below the on-chain u64 ceiling — see MAX_TOKEN_SUPPLY
    // definition for rationale. Surface the actual cap in the message so
    // the user can adjust without guessing what an acceptable value is.
    reasons.push(`Token supply must not exceed ${MAX_TOKEN_SUPPLY.toLocaleString()}`);
  }
  if (!mc || mc <= 0) reasons.push('Target market cap must be > 0');

  btn.disabled = reasons.length > 0;
  btn.title = reasons.join('; ');

  // Also surface reasons inline. The empty-state takes the user further than
  // a tooltip-only hint they may not even hover over.
  const reasonBox = document.getElementById('continueReasons');
  if (reasonBox) {
    // Build the blocking-reasons block (if any), then the warnings block
    // (if any). Warnings render even when reasons is empty, so a clean
    // launch with preallocation still surfaces the heads-up.
    let inner = '';
    if (reasons.length > 0) {
      const hasPoolReason = reasons.some((r) => /^Pool \d/.test(r));
      const hint = (simpleConfig.mode === 'default' && hasPoolReason)
        ? '<p class="is-size-7 mt-2 mb-0"><em>Click <strong>Customize pools manually</strong> to access pool-level controls.</em></p>'
        : '';
      inner +=
        '<strong>Cannot continue yet:</strong><ul style="margin-top: 0.25rem; margin-bottom: 0;">' +
        reasons.map((r) => `<li>${escapeHtml(r)}</li>`).join('') +
        '</ul>' + hint;
    }
    if (warnings.length > 0) {
      // Soft warnings — different prefix and styling so the user can
      // tell at a glance whether something is blocking vs informational.
      // Margin separates from the blocking-reasons block when both are
      // present.
      const sep = reasons.length > 0 ? 'margin-top: 0.75rem;' : '';
      inner += `<div style="${sep}"><strong>Heads up:</strong><ul style="margin-top: 0.25rem; margin-bottom: 0;">` +
        warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('') +
        '</ul></div>';
    }
    if (inner === '') {
      reasonBox.classList.add('hidden');
      reasonBox.innerHTML = '';
    } else {
      reasonBox.classList.remove('hidden');
      reasonBox.innerHTML = inner;
    }
  }

  // Rolling cost preview. Piggybacking on this function's existing role as
  // the central "config changed, recheck" chokepoint means we automatically
  // pick up every config-mutation site without having to thread cost-update
  // calls through 17 separate handlers. The debounce inside
  // requestCostPreviewUpdate() handles per-keystroke firing.
  requestCostPreviewUpdate();
}

// ---------------------------------------------------------------------------
// Step 2 cost preview
// ---------------------------------------------------------------------------
//
// Shows an approximate SOL cost in step 2 so users see the price impact of
// their pool/config choices BEFORE they commit to step 3 funding. Addresses
// the "sticker shock at the funding stage" complaint: users who configured
// without any cost feedback would land at step 3 surprised by how much SOL
// they needed to send.
//
// Approach: call the same /api/estimate-lp-funding endpoint that step 3
// uses, but only display the total SOL (not the full breakdown — that's
// reserved for step 3 to avoid duplicating UI). Debounced 500ms so rapid
// keystrokes don't hammer the endpoint, with a sequence number so an
// in-flight stale response can't overwrite a newer one.
//
// Hidden on steps other than 2 — step 3+ already shows the real estimate,
// and showing the preview would just add confusion.

let _costPreviewDebounceHandle = null;
let _costPreviewRequestSeq = 0;
// The most recent funding estimate, cached so the preview card can show the
// running launch cost. Set by runCostPreview() on success; cleared when the
// config can't be estimated. updatePreviewStats() reads it.
let _lastCostEstimate = null;

function setCostPreviewState(state, value) {
  const card = document.getElementById('costPreview');
  if (!card) return;
  const valueEl = document.getElementById('costPreviewValue');
  const labelEl = document.getElementById('costPreviewLabel');
  const hintEl = document.getElementById('costPreviewHint');
  if (!valueEl || !labelEl || !hintEl) return;

  // #9: the sticky-bar cost echo mirrors this card's value so the running
  // estimate stays visible after the user scrolls the inline preview away.
  // These may be absent in some embeds, so every write below is guarded.
  const stickyCost = document.getElementById('stickyCost');
  const stickyCostValue = document.getElementById('stickyCostValue');

  if (state === 'hidden') {
    card.classList.add('hidden');
    if (stickyCost) stickyCost.classList.add('hidden');
    return;
  }
  card.classList.remove('hidden');
  if (state === 'loading') {
    // Keep the previously-displayed value if we have one — clearing
    // it to "…" causes visible flicker every time the cost preview
    // re-fetches (which can happen multiple times in quick succession
    // as multiple pool resolves complete). The label changes subtly
    // to signal a refresh is in progress without removing the number
    // the user was reading.
    if (!valueEl.textContent || !valueEl.textContent.includes('SOL')) {
      // First-ever load (or post-error) — show the spinner-like
      // placeholder since there's nothing to keep displayed.
      labelEl.textContent = 'Estimating cost: ';
      valueEl.textContent = '…';
      hintEl.textContent = '(computing)';
    } else {
      // Subsequent refresh — leave the value alone, just dim the hint
      // text to a subtle "(updating…)" so the user knows a refresh is
      // in flight without losing the value they were reading.
      hintEl.textContent = '(updating…)';
    }
    return;
  }
  if (state === 'ready') {
    labelEl.textContent = 'Estimated cost: ';
    // 3 decimals matches the breakdown in step 3. Use ≈ rather than = so
    // the user reads it as "approximate" — the actual number can shift
    // slightly between this preview and step 3's estimate because the
    // server may pick up fresher SOL/quote-token prices in the interim.
    valueEl.textContent = `≈ ${Number(value).toFixed(3)} SOL`;
    hintEl.textContent = '(approximate; full breakdown shows on next step)';
    // Mirror the same value into the sticky echo and reveal it. Identical
    // formatting so the two displays never appear to disagree.
    if (stickyCostValue) stickyCostValue.textContent = `≈ ${Number(value).toFixed(3)} SOL`;
    if (stickyCost) stickyCost.classList.remove('hidden');
    return;
  }
  if (state === 'error') {
    labelEl.textContent = '';
    valueEl.textContent = "Couldn't compute preview";
    hintEl.textContent = '(full estimate will run when you click Continue)';
    // No valid number to echo — hide the sticky copy rather than leave a
    // stale value next to the step label.
    if (stickyCost) stickyCost.classList.add('hidden');
    return;
  }
}

// Decide whether the preview should run at all. We only want it on step 2
// (config stage), and only when pools are configured to a state the
// estimator can actually handle. Trying to estimate an incomplete config
// would either fail server-side (noisy) or return a misleading number
// (worse — gives the user a wrong sense of cost).
function shouldShowCostPreview() {
  if (typeof currentStep === 'number' && currentStep !== 2) return false;
  if (!Array.isArray(pools) || pools.length === 0) return false;
  // Allocation total semantics differ by mode:
  //
  //   SIMPLE mode: pool % is driven by the flywheel split slider; it
  //   always sums to (100 - preallocationPercent) exactly. Deviating
  //   from that means something is mid-rebuild and an estimate would
  //   be wrong. We check equality within a small floating-point fuzz.
  //
  //   CUSTOMIZE mode: the user freely types per-pool %. Any sum from
  //   0% up to and including 100% is a valid configuration — the gap
  //   between the sum and 100% is implicit preallocation, held back in
  //   the launch wallet with no LP cost. We only bail if the sum
  //   EXCEEDS 100% (server-side validation would reject it anyway, so
  //   no point estimating).
  //
  // Under-allocated pools in simple mode would estimate a cost for
  // missing liquidity, over-allocated in any mode would double-count.
  const isSimpleMode = !simpleConfig.mode || simpleConfig.mode === 'default';
  const total = pools.reduce((s, p) => s + (Number(p.supplyPercent) || 0), 0);
  if (isSimpleMode) {
    const preallocPct = simpleConfig.preallocationEnabled
      ? Math.max(0, Math.min(99, Number(simpleConfig.preallocationPercent) || 0))
      : 0;
    const expectedTotal = 100 - preallocPct;
    if (Math.abs(total - expectedTotal) > 0.5) return false;
  } else {
    // Customize mode — only fail on overflow. A small +0.5 tolerance
    // matches the simple-mode fuzz so rounding doesn't cause false
    // negatives right at 100%.
    if (total > 100.5) return false;
  }
  // Bail if any pool's quote isn't resolved yet. The estimator's
  // bootstrap-cost math needs the quote token's USD price, and an
  // unresolved quote produces a worst-case estimate that scares users
  // unnecessarily.
  for (const p of pools) {
    if (p.resolvedPriceUsd == null && p.quoteUsdOverride == null) {
      const sym = (p.quoteToken || '').toUpperCase();
      const isSol = sym === 'SOL';
      if (!isSol) return false;
    }
  }
  return true;
}

async function runCostPreview() {
  if (!shouldShowCostPreview()) {
    _lastCostEstimate = null;
    updatePreviewStats();
    setCostPreviewState('hidden');
    return;
  }
  const seq = ++_costPreviewRequestSeq;
  setCostPreviewState('loading');
  try {
    const allocations = buildAllocationsForApi();
    const targetMc = parseNumberInput(document.getElementById('targetMarketCap'));

    const resp = await fetch('/api/estimate-lp-funding', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ allocations, targetMarketCapUsd: targetMc, publishLaunchReport: isLaunchReportEnabled() }),
    });
    // If a newer request started while this one was in flight, drop
    // our result. Without this guard, an out-of-order response could
    // overwrite a fresher one and the user sees the wrong number.
    if (seq !== _costPreviewRequestSeq) return;
    const data = await resp.json();

    if (!data.success || !data.estimate) {
      _lastCostEstimate = null;
      updatePreviewStats();
      setCostPreviewState('error');
      return;
    }
    _lastCostEstimate = data.estimate;
    updatePreviewStats();
    // Surface the grand total (launch + airdrop execution) in the
    // cost preview card. updatePreviewStats above also adds airdrop
    // cost to its own Est. Cost tile, so the two displays agree.
    const airdropExecutionSol = computeAirdropExecutionCostSol();
    setCostPreviewState('ready', data.estimate.totalSol + airdropExecutionSol);
  } catch (e) {
    if (seq !== _costPreviewRequestSeq) return;
    // Don't surface the error message — the user will see a real one
    // when they click Continue. This preview is best-effort.
    _lastCostEstimate = null;
    updatePreviewStats();
    setCostPreviewState('error');
  }
}

function requestCostPreviewUpdate(options) {
  // Reflect pool/allocation edits in the preview card immediately (the
  // cost number itself updates a moment later when the debounced fetch
  // returns). Cheap — touches only the stat grid, not the coin.
  updatePreviewStats();

  // Hidden on non-step-2 contexts. Cancel any pending fetch and stop
  // here so a freshly-arrived step-2 view sees a clean state.
  if (!shouldShowCostPreview()) {
    if (_costPreviewDebounceHandle) {
      clearTimeout(_costPreviewDebounceHandle);
      _costPreviewDebounceHandle = null;
    }
    setCostPreviewState('hidden');
    return;
  }
  if (_costPreviewDebounceHandle) clearTimeout(_costPreviewDebounceHandle);
  // immediate=true bypasses the debounce for definitive config changes
  // (toggle changes, full re-renders) where the user expects to see the
  // new total right away — not 500ms later. Per-keystroke typing still
  // uses the debounce so we don't hammer the server.
  if (options && options.immediate) {
    runCostPreview();
  } else {
    _costPreviewDebounceHandle = setTimeout(runCostPreview, 500);
  }
}

['tokenName', 'tokenSymbol', 'tokenSupply', 'targetMarketCap'].forEach((id) => {
  bind(id, 'input', updateContinueToFundingState);
});

// targetMarketCap also drives the bootstrap supplyPercent math (the
// derived % depends on the pool's USD allocation, which is target mcap
// × pool's supplyPercent). When the user changes it on step 2, recompute
// each pool's bootstrap supplyPercent from its solValue, and rebalance
// the wide slices to absorb the delta so positions total stays at 100%.
//
// Runs in both simple AND customize mode — customize-mode users still
// have solValue as canonical, and a mcap change updates the derived %
// just like for simple-mode users. The recompute helper is a no-op when
// bootstrap is in minimal mode (no solValue to recompute).
bind('targetMarketCap', 'input', () => {
  let anyChange = false;
  for (const p of pools) {
    if (p.bootstrapConfig && p.bootstrapConfig.mode === 'custom') {
      recomputePoolBootstrapAndRebalance(p);
      anyChange = true;
    }
  }
  if (anyChange) {
    // The bootstrap dollar hint, the band mcap hints, and the positions-
    // total indicator all depend on mcap; re-render to refresh them.
    renderPools();
  } else if (simpleConfig.mode === 'customize') {
    // Customize mode with no custom-bootstrap pool: renderPools didn't fire,
    // but the depth chart's USD scaling (token-side bands vs the quote-side
    // support wall) tracks target mcap. Redraw each pool's chart live so the
    // support-vs-token balance stays honest as mcap changes. This is a pure
    // SVG redraw — it does NOT touch band supply or the ceiling cap, so it
    // can't disturb the user's configured positions mid-edit. The ceiling
    // cap (which also derives from mcap) is re-clamped on the next ladder
    // interaction via ensureLadderStrategyConfig.
    for (let i = 0; i < pools.length; i++) updatePoolDepthChart(i);
    // The ceiling cap ($1B ÷ mcap) and its dollar readout also track mcap;
    // refresh them in place too, so the whole ladder section stays honest as
    // the user types — without a reflowing renderPools.
    refreshLadderMcapDisplays();
  }
  // Preallocation display in the simple config also depends on mcap
  // (USD value of the held-back tokens). The auto-sized support value
  // also depends on mcap (preallocation USD ÷ SOL price), so we run
  // rebuildPoolsFromSimple — debounced so rapid typing doesn't fire
  // a rebuild per keystroke. The inline display helpers patch the
  // visible figures (USD, token count, coverage indicator) in place,
  // so the user sees their input reflected immediately without us
  // having to destroy and rebuild the simple-config body.
  if (simpleConfig.mode === 'default') {
    rebuildPoolsFromSimpleDebounced();
    refreshSimplePreallocDisplayInline();
    refreshSimpleSupportDisplayInline();
    // Airdrop token allocations depend on launch starting price
    // (market cap / supply), so mcap changes shift every row's
    // tokens and may flip the budget verdict.
    refreshAirdropDisplayInline();
    // Continue-state check too, since the coverage warning depends on
    // the latest support → preallocation USD comparison.
    if (typeof updateContinueToFundingState === 'function') updateContinueToFundingState();
  }
});

// Token supply input also feeds the preallocation token-count display
// (% × supply = preallocated tokens). Refresh the simple config so the
// display tracks the user's input. Token supply doesn't affect support
// sizing (support is USD-denominated via market cap, not supply), so a
// rebuild isn't strictly necessary — but we call it anyway for symmetry
// and to handle any future supply-dependent derived values cleanly.
// Debounced + inline-display approach matches the mcap handler above
// so typing into supply doesn't cost a full simple-config rebuild
// per keystroke.
bind('tokenSupply', 'input', () => {
  if (simpleConfig.mode === 'default') {
    rebuildPoolsFromSimpleDebounced();
    refreshSimplePreallocDisplayInline();
    // Total-supply directly affects the preallocation budget AND each
    // airdrop row's token count (tokens = sol × SOL_USD × supply / mcap).
    refreshAirdropDisplayInline();
  }
});

// Blur handlers: flush any pending debounced rebuild so the pools
// reflect the user's latest input before they interact with the
// rest of the form (Continue button, customize switch, etc.).
//
// Customize-mode guard: no debounced rebuild was scheduled in
// customize mode (the input handlers above gate on simple mode), so
// flushing here would unconditionally call rebuildPoolsFromSimple
// and wipe user pool customizations. Skip when in customize mode.
bind('targetMarketCap', 'blur', () => {
  if (simpleConfig.mode === 'customize') {
    // mcap drives the ladder ceiling cap ($1B ÷ mcap). If raising mcap pulled
    // the cap below a pool's configured ceiling, clamp it down and regenerate
    // that pool's bands so the chart and positions match the tighter ceiling.
    // (Lowering mcap raises the cap and never forces a clamp.) regenerate runs
    // through ensureLadderStrategyConfig, which does the clamp, and preserves
    // the positions total via its delta rebalance. Re-render only when a clamp
    // actually fired, so we don't reflow the pool list — the dollar readout and
    // cap were already refreshed live by the input handler. We must NOT rebuild
    // from simple here; that would wipe the user's customizations.
    let changed = false;
    for (const p of pools) {
      const cfg = p.ladderConfig;
      if (cfg && cfg.mode === 'manual' && Number(cfg.ceiling) > poolMaxCeilingMultiplier(p)) {
        regenerateLadderBands(p);
        changed = true;
      }
    }
    if (changed) renderPools();
    return;
  }
  flushRebuildPoolsFromSimple();
});
bind('tokenSupply', 'blur', () => {
  if (simpleConfig.mode === 'customize') return;
  flushRebuildPoolsFromSimple();
});

// Live token-preview card. The same five fields that drive the
// continue-button state (above) plus description and logo all feed
// renderTokenPreview() so the card on the right updates as the user
// types/selects. Logo uses `change` since file inputs don't fire
// `input`. Multiple listeners on tokenLogo coexist with the existing
// filename-display handler bound earlier.
['tokenName', 'tokenSymbol', 'tokenSupply', 'targetMarketCap', 'tokenDescription'].forEach((id) => {
  bind(id, 'input', renderTokenPreview);
});
bind('tokenLogo', 'change', renderTokenPreview);

// Format the two numeric inputs with thousand-separator commas as the
// user types. The format on every input event preserves the user's
// cursor position. Read sites use parseNumberInput() to strip commas
// before passing the value to Number() or the server.
['tokenSupply', 'targetMarketCap'].forEach((id) => {
  const el = document.getElementById(id);
  if (el) {
    el.addEventListener('input', () => formatNumberInput(el));
    // The HTML default values are pre-formatted, but if a user has
    // browser autofill or any other source pushes a raw number into
    // the input, run the formatter once on focus too. Cheap insurance.
    el.addEventListener('focus', () => formatNumberInput(el));
  }
});

bind('addPoolBtn', 'click', () => {
  // Suggest a useful default quote for the second/third pool: USDC if a
  // SOL pool already exists, otherwise SOL. The supplyPercent default is
  // now computed inside addPool() from the remaining budget. Open
  // expanded since the user is explicitly configuring something.
  const hasSol = pools.some((p) => (p.quoteToken || '').toUpperCase() === 'SOL');
  addPool({ quoteToken: hasSol ? 'USDC' : 'SOL', _isExpanded: true });
});

// Return-to-simple-mode button: switches from customize mode back to
// the simple toggle+dropdown UI. Wipes any pool customizations and
// rebuilds defaults from simpleConfig — but only after confirming
// with the user, since they could lose meaningful customization.
//
// Uses the HTML confirmDialog rather than window.confirm because the
// rest of the codebase does — see the Chromium-on-Windows note in
// the genericConfirmModal markup. Native confirm leaves inputs in
// the page un-clickable until the next focus cycle on some Windows
// builds.
bind('returnToSimpleBtn', 'click', async () => {
  // Detect "meaningful customization" — anything beyond the defaults
  // simpleConfig would produce. If the current pools already match
  // what rebuildPoolsFromSimple would produce, skip the confirm.
  const currentMatchesSimple = poolsMatchSimpleDefaults();
  if (!currentMatchesSimple) {
    const ok = await confirmDialog({
      title: 'Discard custom pool configuration?',
      body: '<p>Your custom pool configuration changes will be discarded and your simple-mode settings restored. Any allocations, fee tier choices, slice splits, ladder bands, or per-pool overrides you set in customize mode will be lost.</p>',
      confirmLabel: 'Switch to simple mode',
      danger: true,
    });
    if (!ok) return;
  }
  simpleConfig.mode = 'default';
  rebuildPoolsFromSimple();
  applySimpleConfigMode();
});

// Compare the current pools[] to what rebuildPoolsFromSimple() would
// produce given the current simpleConfig. Used to skip the confirm
// dialog when switching back to simple mode wouldn't actually lose
// anything (e.g. user clicked Customize but didn't change anything).
//
// Compares the things that matter for the lossiness check: pool count,
// quote tokens, allocations, fee tiers, and slice configuration.
// Resolved-info fields and underscored UI-state fields are ignored.
function poolsMatchSimpleDefaults() {
  // Build what the defaults *would* look like by simulating in a
  // throwaway array. We can't just call rebuildPoolsFromSimple()
  // because that has the side effect of mutating pools[].
  //
  // The expected distribution is per-pool: the SOL pool gets the split
  // (when split is enabled) but the flywheel pool always gets a single
  // 100% slice — matching rebuildPoolsFromSimple's behavior. Splitting
  // the flywheel side requires customize mode.
  const splitDist = buildEqualSplitDistribution(
    simpleConfig.splitEnabled ? simpleConfig.splitCount : 1,
  );
  const singleDist = buildEqualSplitDistribution(1);

  // Mirror rebuildPoolsFromSimple's preallocation scaling so the
  // expected pool sizes match what a fresh rebuild would actually
  // produce. Without this, enabling preallocation in simple mode would
  // be perpetually flagged as "drift from defaults" even though
  // customize-mode state matches it exactly.
  const preallocPct = simpleConfig.preallocationEnabled
    ? Math.max(0, Math.min(99, Number(simpleConfig.preallocationPercent) || 0))
    : 0;
  const lpBudget = 100 - preallocPct;

  let expected;
  if (simpleConfig.flywheelEnabled) {
    const fw = FLYWHEELS[simpleConfig.flywheelKey];
    if (fw && fw.available && fw.mint) {
      // Match rebuildPoolsFromSimple's clamp so the comparison uses the
      // same effective value the rebuild would produce.
      const flywheelPct = Math.max(
        FLYWHEEL_MIN_PERCENT,
        Math.min(FLYWHEEL_MAX_PERCENT, Number(simpleConfig.flywheelPercent) || DEFAULT_FLYWHEEL_PERCENT),
      );
      const solShare = 100 - flywheelPct;
      expected = [
        {
          quoteToken: 'SOL',
          supplyPercent: solShare * lpBudget / 100,
          distribution: splitDist,
        },
        {
          quoteToken: fw.mint,
          supplyPercent: flywheelPct * lpBudget / 100,
          distribution: singleDist,
        },
      ];
    } else {
      expected = [{ quoteToken: 'SOL', supplyPercent: lpBudget, distribution: splitDist }];
    }
  } else {
    expected = [{ quoteToken: 'SOL', supplyPercent: lpBudget, distribution: splitDist }];
  }

  if (pools.length !== expected.length) return false;
  for (let i = 0; i < pools.length; i++) {
    const p = pools[i];
    const e = expected[i];
    if (p.quoteToken !== e.quoteToken) return false;
    // Tolerance compare on supplyPercent — preallocation scaling can
    // produce non-integer values (e.g. 80 × 80/100 = 64) but rounding
    // through the user's last input vs. the canonical math can diverge
    // by 1 ULP. 0.01% is well below any user-visible difference.
    if (Math.abs(Number(p.supplyPercent) - e.supplyPercent) > 0.01) return false;
    if (p.ammConfigIndex !== 3) return false; // 1% is the simple default
    // Distribution shape match. Compare slice count and each slice's
    // sharePercent within a small tolerance to absorb floating-point
    // drift. recipient/useExternalRecipient must be at defaults too —
    // any user-set recipient is meaningful customization that we don't
    // want to silently lose.
    if (p.distribution.length !== e.distribution.length) return false;
    for (let j = 0; j < p.distribution.length; j++) {
      const ps = p.distribution[j];
      const es = e.distribution[j];
      if (Math.abs(Number(ps.sharePercent) - es.sharePercent) > 0.01) return false;
      if (ps.useExternalRecipient) return false;
      if (ps.recipient) return false;
    }
    // User-typed overrides count as "meaningful customization" — losing
    // a price override the user manually entered (because resolution
    // failed for their token) would be a real regression. Trigger the
    // confirm if any override is set.
    if (p.quoteSymbolOverride) return false;
    if (p.quoteDecimalsOverride != null) return false;
    if (p.quoteUsdOverride != null) return false;

    // Bootstrap and ladder customizations: compare each pool's current
    // config against what deriveBootstrapConfigFromSimple and
    // deriveLadderConfigFromSimple would produce from the current
    // simpleConfig. Any drift means the user changed something in
    // customize mode and would lose it if we silently rebuilt.
    //
    // Both helpers are pure functions of simpleConfig + pool count, so
    // calling them here is safe — no side effects, no state mutation.
    const expectedBs = deriveBootstrapConfigFromSimple(Number(p.supplyPercent), pools.length);
    const actualBs = p.bootstrapConfig || { mode: 'minimal' };
    if (actualBs.mode !== expectedBs.mode) return false;
    if (actualBs.mode === 'custom') {
      // Compare solValue (canonical user intent) rather than supplyPercent
      // (which is derived from solValue + live SOL price + mcap). A
      // supplyPercent mismatch can happen when the user hasn't touched
      // anything but the SOL price refreshed — we don't want that to
      // count as a customization.
      if (Math.abs(Number(actualBs.solValue) - Number(expectedBs.solValue)) > 0.0001) {
        return false;
      }
    }

    const expectedLd = deriveLadderConfigFromSimple();
    const actualLd = p.ladderConfig || { mode: 'off', bands: [] };
    if (actualLd.mode !== expectedLd.mode) return false;
    if (actualLd.mode === 'manual') {
      const actualBands = Array.isArray(actualLd.bands) ? actualLd.bands : [];
      const expectedBands = Array.isArray(expectedLd.bands) ? expectedLd.bands : [];
      if (actualBands.length !== expectedBands.length) return false;
      for (let bi = 0; bi < actualBands.length; bi++) {
        const ab = actualBands[bi];
        const eb = expectedBands[bi];
        if (Math.abs(Number(ab.supplyPercent) - Number(eb.supplyPercent)) > 0.01) return false;
        if (Math.abs(Number(ab.lowerMultiplier) - Number(eb.lowerMultiplier)) > 0.001) return false;
        if (Math.abs(Number(ab.upperMultiplier) - Number(eb.upperMultiplier)) > 0.001) return false;
      }
    }

    // Support config comparison. Mirrors rebuildPoolsFromSimple:
    // simple mode applies the same derived supportConfig to every
    // pool — the totalSupportSol gets split equally, so each pool's
    // expected solValue is totalSupportSol / poolCount. We compute the
    // expected config once with the actual pool count and compare it
    // against every pool's stored config (they should all be identical
    // in simple mode).
    //
    // We compare solValue (canonical) and depthPct (canonical) rather
    // than anything derived. depthPct comparison goes through
    // clampSupportDepth on both sides so an out-of-range raw value
    // (e.g. user typed 75 then it was clamped to 50) still matches.
    const expectedSupport = deriveSupportConfigFromSimple(pools.length);
    const actualSupport = p.supportConfig || { mode: 'off' };
    if (actualSupport.mode !== expectedSupport.mode) return false;
    if (actualSupport.mode === 'custom') {
      if (Math.abs(Number(actualSupport.solValue) - Number(expectedSupport.solValue)) > 0.0001) {
        return false;
      }
      if (clampSupportDepth(actualSupport.depthPct) !== clampSupportDepth(expectedSupport.depthPct)) {
        return false;
      }
    }
  }
  return true;
}

bind('continueToFundingBtn', 'click', async () => {
  // Flush any pending debounced pool rebuild so the estimator sees
  // the user's latest input. Without this, a Continue click during
  // the 250ms debounce window would send stale allocations to the
  // server and the funding estimate would be wrong.
  //
  // Customize-mode guard: no debounced rebuild was scheduled (the
  // rebuild helpers short-circuit on customize mode). The pools
  // array IS the user's source of truth here — flushing would call
  // rebuildPoolsFromSimple and silently wipe every customization
  // right before sending allocations to the server.
  if (simpleConfig.mode !== 'customize') {
    flushRebuildPoolsFromSimple();
  }
  await withRunState(async () => {
    try {
      const allocations = buildAllocationsForApi();
      const targetMc = parseNumberInput(document.getElementById('targetMarketCap'));
      const resp = await fetch('/api/estimate-lp-funding', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // targetMarketCapUsd is only used by the estimator when a custom-
        // mode bootstrap is present, but we send it unconditionally so the
        // server has it available regardless. All-minimal launches ignore it.
        body: JSON.stringify({ allocations, targetMarketCapUsd: targetMc, publishLaunchReport: isLaunchReportEnabled() }),
      });
      const data = await resp.json();
      if (!data.success) throw new Error(data.error);

      fundingRequirement = data.estimate;

      // Apply the funding-estimate's resolvedPrices back to each pool's
      // resolvedPriceUsd. Per the price-safety plan (Milestone B): the
      // user should see the same quote-token USD value everywhere —
      // Step 2 display, Step 3 cost preview, Step 5 pool creation.
      //
      // Whichever source funding-estimate used to size the bootstrap
      // and the auto-swap targets (raydium-probe, oracle, user-override,
      // or sol/USD), THAT is the price the user is implicitly
      // committing to when they click "Continue to Funding." Propagating
      // it back to the pool state means:
      //   - Step 3's renderFundingRequirements shows the right number
      //   - Step 5's drift guard compares against the right reference
      //     (it sees the override == funding-estimate price, so it
     //      detects movement SINCE funding committed, not movement
     //      between aggregator and probe at the same moment)
      //
      // We only update pools whose source isn't 'unresolved' — leaving
      // the pool's existing resolvedPriceUsd alone if funding-estimate
      // couldn't resolve a price (rare, but we don't want to clear a
      // valid Step 2 value with null).
      if (Array.isArray(fundingRequirement.resolvedPrices)) {
        for (const rp of fundingRequirement.resolvedPrices) {
          if (rp.source === 'unresolved') continue;
          if (rp.quoteUsd === null || rp.quoteUsd === undefined) continue;
          const pool = pools[rp.allocationIndex];
          if (!pool) continue;
          pool.resolvedPriceUsd = rp.quoteUsd;
          pool.resolvedPriceSource = rp.source;
        }
      }

      // Track how much of the SOL requirement has been "consumed" by
      // completed auto-swaps. The original solLamports requirement
      // includes budgeted SOL for all auto-swaps; once a swap finishes,
      // that portion is already spent, so we need to subtract its
      // estSolSpend from the effective requirement. Without this, the
      // SOL row stays red after auto-swaps complete (because the wallet
      // balance has gone down by ~$4 per swap) even though the launch
      // can proceed. See decrementSolRequirementForSwap() below.
      fundingRequirement.solCreditedForCompletedSwaps = 0;
      const manualCount = Object.keys(fundingRequirement.byQuote).length;
      const autoCount = (fundingRequirement.autoSwapPlan || []).length;
      const extras = [];
      if (autoCount) extras.push(`${autoCount} auto-swap`);
      if (manualCount) extras.push(`${manualCount} manual`);
      log(
        `Funding estimate: ${fundingRequirement.totalSol.toFixed(3)} SOL` +
        (extras.length ? ` + ${extras.join(', ')} token row${(autoCount + manualCount) === 1 ? '' : 's'}` : ''),
        'info',
      );

      const symbol = document.getElementById('tokenSymbol').value.trim() || 'token';
      const poolCount = pools.length;
      setStepSummary(2, `${symbol}, ${poolCount} pool${poolCount === 1 ? '' : 's'}`);

      renderFundingRequirements();
      activateStep(3);
      startBalancePolling();
    } catch (e) {
      log(`Funding estimation failed: ${e.message}`, 'danger');
    }
  });
});

// Back-to-configuration button on step 3 (Funding). The user has seen the
// SOL requirement and wants to adjust pool config / target mcap / etc.
// before committing funds. We just stop polling and reactivate step 2 —
// all token form values and pool state are still in memory, so the user
// picks up exactly where they left off. When they click Continue to
// Funding again, the estimate is recomputed (with their changes) and
// step 3 re-enters fresh.
//
// Funding deposits that may have already arrived in the wallet are NOT
// touched here — they're refundable through Cancel & Refund if the user
// decides to abandon the launch entirely. For a normal "re-estimate after
// edit" flow, leaving them in place is fine; they count toward the new
// estimate when the user comes back to step 3.
bind('backToConfigBtn', 'click', () => {
  // Don't allow navigation while an operation is running (e.g., an
  // auto-swap is mid-flight). The cancel button has the same guard via
  // updateCancelButtonState; mirror that here so the user can't yank
  // the rug out from under a running operation. Reuses the activity log
  // for user-facing feedback rather than a modal — operations are
  // typically short and the user will get a chance again soon.
  if (isRunningOperation) {
    log('Wait for the running operation to finish before editing the configuration.', 'warning');
    return;
  }
  if (balancePollHandle) {
    clearInterval(balancePollHandle);
    balancePollHandle = null;
  }
  // Clear step 3's summary so it doesn't read "ready" or similar when the
  // user collapses it to look at step 2.
  setStepSummary(3, '');
  // Also clear step 2's summary — the user is about to re-edit, and the
  // old "TOKEN, N pools" line would be misleading mid-edit. activateStep
  // will reset visual states; the summary needs an explicit clear.
  setStepSummary(2, '');
  log('Returned to configuration. Edit and click Continue to Funding when ready.', 'info');
  activateStep(2);
});

// Copy-wallet-address button on the funding step. The address is the
// destination for the user's manual SOL transfer; QR scanning works
// for mobile wallets but desktop wallet users typically copy-paste.
// Uses navigator.clipboard.writeText with a 1.4s visual confirmation
// (checkmark icon swap + 'Copied!' label) so the user knows it worked
// without needing a separate toast. Falls back gracefully if the
// clipboard API is unavailable (logs to activity log instead).
bind('step3WalletAddrCopyBtn', 'click', async () => {
  // Read from tempWallet rather than from the DOM textContent, since
  // the DOM string is what's displayed (potentially wrapped, with no
  // formatting differences here, but it's still cleaner to copy the
  // source of truth). tempWallet is populated by step 1's generate-
  // wallet flow and remains valid throughout the launch.
  if (!tempWallet || !tempWallet.publicKey) {
    log('No wallet address available to copy', 'warning');
    return;
  }
  const btn = document.getElementById('step3WalletAddrCopyBtn');
  const icon = btn && btn.querySelector('i');
  try {
    await navigator.clipboard.writeText(tempWallet.publicKey);
    log('Wallet address copied to clipboard', 'info');
    // Visual confirmation: swap the copy icon for a check, change the
    // button color to the "ok" tone, and revert after 1.4s. Mirrors
    // the .copy-btn.copied pattern used in the recovery-flow report.
    if (icon) {
      icon.classList.remove('fa-copy');
      icon.classList.add('fa-check');
    }
    if (btn) btn.classList.add('is-success');
    setTimeout(() => {
      if (icon) {
        icon.classList.remove('fa-check');
        icon.classList.add('fa-copy');
      }
      if (btn) btn.classList.remove('is-success');
    }, 1400);
  } catch (e) {
    log(`Couldn't copy address (${e.message})`, 'warning');
  }
});

// Reset all token/pool state to defaults so the user can start a fresh
// launch. The wallet (tempWallet) is intentionally preserved — that's the
// whole point of "start over with the same wallet." Everything else gets
// wiped: form values, pool config, simpleConfig, created-token info,
// funding state, step summaries, the cancelled-panel itself, and all the
// downstream-step DOM panels that may carry stale display data.
//
// Called by the Start Over affordance on the step-6 cancelled panel.
// Safe to call from a clean cancelled state (wallet empty / refunded);
// not intended for use mid-launch.
//
// Mirrors the per-launch state reset that happens in the generate-wallet
// handler — we want "Start Over with same wallet" to leave the UI in
// the same state as "Generate Wallet" minus the wallet itself.
function resetForNewLaunch() {
  // 1. Defensive: stop any background polling that might still be alive.
  //    The cancel paths normally clear this before showing the cancelled
  //    panel, but a future code path could land here without going
  //    through cancel; better to be idempotent.
  if (balancePollHandle) {
    clearInterval(balancePollHandle);
    balancePollHandle = null;
  }

  // 2. Wipe in-memory launch state.
  createdTokenInfo = null;
  lpResult = null;
  lastAirdropResult = null;
  restoredAirdropPayload = null;
  if (typeof _resetCachedReport === 'function') _resetCachedReport();
  fundingRequirement = { solLamports: 0, byQuote: {}, autoSwapPlan: [] };
  fundingWallet = null;
  lastSolBalance = 0;
  consecutivePollFailures = 0;
  fundingDetectionExhausted = false;
  // Auto-swap interlock — defensive reset. Cancel completion runs under
  // withRunState which would have failed if an auto-swap was mid-flight,
  // so reaching here with this flag set shouldn't be possible. Resetting
  // unconditionally keeps the state machine clean if a future code path
  // arrives here through a different route.
  isAcquireFlowRunning = false;

  // 3. Reset simpleConfig to its initial defaults so the simple-UI shows
  //    the "fresh launch" state. Mirror of the let-initializer at file top.
  //    When adding new fields to the initializer, mirror them here too —
  //    otherwise a Start Over will carry over stale values from the
  //    previous launch and the user gets a "fresh" form that isn't fresh.
  simpleConfig = {
    mode: 'default',
    flywheelEnabled: true,
    flywheelKey: 'meme',
    flywheelPercent: DEFAULT_FLYWHEEL_PERCENT,
    splitEnabled: false,
    splitCount: 1,
    bootstrapMode: 'minimal',
    bootstrapSolValue: 1,
    ladderEnabled: false,
    ladderPercent: LADDER_DEFAULT_PERCENT,
    ladderBandCount: LADDER_DEFAULT_BANDS,
    ladderStrategy: LADDER_DEFAULT_STRATEGY,
    // Preallocation defaults — disabled by default, 1% if the user
    // enables it. Auto-fit defaults on so the airdrop CSV automatically
    // raises the floor as needed. Both effective and typed values seed
    // to 1 so a fresh enable shows 1% in the input.
    preallocationEnabled: false,
    preallocationPercent: 1,
    preallocationPercentInput: 1,
    preallocationAutoFit: true,
    // Support position defaults — disabled by default. Auto-back ties
    // the SOL value to whatever fully backs the preallocation; on by
    // default so the natural "preallocation + backing" pairing is the
    // path of least resistance when the user enables both.
    supportEnabled: false,
    supportSolValue: 1,
    supportDepthPct: 10,
    supportAutoSize: true,
    // UI-only: advanced section collapsed by default so Start Over
    // produces the same minimal landing view as a fresh page load.
    _advancedExpanded: false,
    // Airdrop state — mirror of the top-of-file defaults. Without
    // resetting this, the next launch would carry over the previous
    // launch's csvText and parsed rows, which is wrong (each launch
    // has its own recipient list).
    airdrop: {
      enabled: false,
      csvText: '',
      parsedRows: [],
      parseError: null,
      budgetError: null,
      _expanded: false,
      _breakdownExpanded: false,
    },
  };

  // 4. Reset token form inputs back to their HTML defaults. These hold
  //    whatever the user typed last time; leaving them prefilled with
  //    that data would imply "we'll use this again" when in fact the
  //    user explicitly chose to start over.
  //
  //    We read each input's `defaultValue` rather than hardcoding the
  //    values here. defaultValue is the string from the HTML `value="..."`
  //    attribute — empty for inputs that don't declare one (tokenName,
  //    tokenSymbol, tokenDescription), and the displayed default for the
  //    two that do (tokenSupply = "1,000,000,000", targetMarketCap =
  //    "100,000"). This keeps the reset behaviour in sync with the HTML
  //    automatically: if those defaults are ever changed in index.html,
  //    the reset still does the right thing without needing to update
  //    this list.
  //
  //    Prior version blindly cleared targetMarketCap to '' alongside the
  //    text fields, which produced an empty market-cap field after Start
  //    Over even though a fresh app open shows "100,000" — the bug Moose
  //    flagged. The supply fix is a related tidy-up: prior code set it
  //    to '1000000000' (no commas), which display-mismatches the HTML
  //    default of '1,000,000,000'; the numeric value is identical after
  //    parseNumberInput strips commas, but visually they differ.
  const formIds = [
    'tokenName',
    'tokenSymbol',
    'tokenSupply',
    'targetMarketCap',
    'tokenDescription',
  ];
  for (const id of formIds) {
    const el = document.getElementById(id);
    if (el) el.value = el.defaultValue;
  }
  // Logo: clear both the file input and any preview thumbnail.
  // File inputs always have an empty defaultValue, so we set value=''
  // explicitly to make the intent obvious at the call site rather than
  // relying on the defaultValue happening to be empty.
  const logoEl = document.getElementById('tokenLogo');
  if (logoEl) logoEl.value = '';
  if (_tokenPreviewLogoObjectUrl) {
    URL.revokeObjectURL(_tokenPreviewLogoObjectUrl);
    _tokenPreviewLogoObjectUrl = null;
  }
  // Tear down the 3D coin's WebGL context. renderTokenPreview() will
  // re-init it lazily if the user returns to the create-token screen.
  destroyCoinPreview();
  // Reset the overall launch-progress flag so the preview card's bar starts
  // fresh for the new launch (it repaints when the card next renders).
  _launchTransferComplete = false;
  if (typeof updateLaunchProgress === 'function') updateLaunchProgress();
  const logoThumb = document.getElementById('tokenLogoThumb');
  if (logoThumb) logoThumb.classList.add('hidden');
  // Clear any stale logo validation error from a previous launch. The
  // setLogoError helper handles the hidden-class toggle so the help
  // text doesn't reserve vertical space when there's no message.
  setLogoError(null);

  // 5. Wipe pools and rebuild from the (now reset) simpleConfig defaults.
  //    rebuildPoolsFromSimple wipes pools.length=0 and re-adds the default
  //    SOL+flywheel pool split.
  pools.length = 0;
  rebuildPoolsFromSimple();
  // applySimpleConfigMode flips the visible config panel (simple vs
  // customize) based on simpleConfig.mode and re-runs the appropriate
  // renderer. We need this in case the user was in customize mode before
  // — without it the customize panel would still be visible while
  // simpleConfig says we're in default mode.
  applySimpleConfigMode();

  // 6. Reset step-2-through-6 DOM panels that may carry display state from
  //    the previous attempt. Mirror what the generate-wallet handler does
  //    so Start Over leaves the UI in the same shape as Generate Wallet.
  document.getElementById('tokenCreatedInfo')?.classList.add('hidden');
  document.getElementById('createTokenBtn')?.classList.remove('hidden');
  document.getElementById('createLpBtn')?.classList.remove('hidden');
  document.getElementById('transferAssetsBtn')?.classList.remove('hidden');
  setLpDoneVisible(false);
  document.getElementById('lpFailInfo')?.classList.add('hidden');
  document.getElementById('lpProgress')?.classList.add('hidden');
  const lpTree = document.getElementById('lpProgressTree');
  if (lpTree) lpTree.innerHTML = '';
  document.getElementById('transferResult')?.classList.add('hidden');
  document.getElementById('fundingWalletInfo')?.classList.add('hidden');
  const destWalletEl = document.getElementById('destinationWallet');
  if (destWalletEl) destWalletEl.value = '';
  // Re-hide the "View launch summary" button — runTransfer's success
  // branch reveals it, so a Start Over after a complete launch would
  // leave it visible on the fresh attempt's empty step 6 otherwise.
  document.getElementById('viewLaunchSummaryBtn')?.classList.add('hidden');
  // Defensive close of the launch-success modal. The modal is normally
  // open only after a successful step-6 transfer (after which Start
  // Over isn't typically reachable since step 6 is the terminal step),
  // but a future flow could open Start Over while the modal is up and
  // we'd want to clean up its WebGL coin context regardless. Safe to
  // call when the modal is already closed.
  if (typeof hideLaunchSuccessModal === 'function') hideLaunchSuccessModal();
  // Step 6 cancelled panel: restore normal body, hide cancelled.
  document.getElementById('step6NormalBody')?.classList.remove('hidden');
  document.getElementById('step6CancelledPanel')?.classList.add('hidden');

  // 7. Clear step summaries for steps 2-6. Step 1 stays — its summary
  //    shows the wallet abbreviation, which is still accurate.
  for (let i = 2; i <= 6; i++) setStepSummary(i, '');

  // 8. Re-render the live token preview card (now empty since form is
  //    cleared) and recompute the continue-button enabled state.
  renderTokenPreview();
  updateContinueToFundingState();
  updateCancelButtonState();

  // 9. Hand control back to step 2 and log a clear separator so the
  //    activity log makes the boundary obvious.
  log('— Started over. Configure your token and pools, then continue. —', 'info');
  activateStep(2);
}

bind('startOverBtn', 'click', resetForNewLaunch);

// ===========================================================================
// Tokenomics Preview Modal
// ===========================================================================
//
// Opened from "Visualize tokenomics" on step 2. Renders a donut chart of the
// planned token-supply distribution across pools + positions, plus a textual
// breakdown. Reads live pool state (so it reflects whatever the user has
// currently configured, including unsaved customize-mode edits) — no
// snapshot/copy of state is taken; close-and-reopen always shows current.

// Color palette for pool-level grouping. Each pool gets a base hue, and
// position types within that pool are shaded variants (bootstrap = darker,
// slices = base, ladder bands = progressively lighter). Wraps around if
// there are >5 pools (unusual but possible).
//
// Hues are drawn from the app/website parchment palette rather than the
// default chart blue/orange/etc., so the donut reads as part of the
// manuscript theme: rubric red, gold, olive-green, warm sienna, ink-brown.
const POOL_COLOR_BASES = [
  { name: 'rubric', h: 0,   s: 62 },   // manuscript red (primary)
  { name: 'gold',   h: 38,  s: 58 },   // gold highlight
  { name: 'olive',  h: 82,  s: 38 },   // olive-forest green
  { name: 'sienna', h: 22,  s: 50 },   // warm sienna/brown
  { name: 'umber',  h: 30,  s: 28 },   // muted ink-brown
];

// Position-type shades within a pool's hue. Returns an HSL string.
// `kind` is 'bootstrap', 'slice', or 'band'. `variant` is the per-kind
// index (e.g., band 0, band 1, ...) used to vary band brightness so the
// arcs are distinguishable from each other.
function poolPositionColor(poolIdx, kind, variant) {
  const base = POOL_COLOR_BASES[poolIdx % POOL_COLOR_BASES.length];
  let l; // lightness
  if (kind === 'bootstrap') {
    // Dark variant — bootstrap is the conceptual "anchor" of the pool.
    l = 32;
  } else if (kind === 'slice') {
    // Mid variant — the wide main LP.
    l = 50;
  } else {
    // band — progressively lighter for each subsequent band so adjacent
    // arcs read as distinct. Cap at 75 lightness so the colors don't
    // become unreadably pale.
    l = Math.min(75, 58 + (variant || 0) * 4);
  }
  return `hsl(${base.h}, ${base.s}%, ${l}%)`;
}

// Build the flat list of arcs from the live pool state. Each arc has:
//   poolIdx, kind ('bootstrap' | 'slice' | 'band'), variant, label,
//   share (fraction of total token supply, 0..1), color
//
// Iteration order matters: arcs in the same pool stay adjacent in the
// donut, with bootstrap first, slices next, bands last. That ordering
// makes the chart read left-to-right within each pool: anchor →
// distribution → ladder.
function buildTokenomicsArcs() {
  const arcs = [];
  pools.forEach((pool, poolIdx) => {
    const poolFraction = Number(pool.supplyPercent) / 100; // 0..1 of total
    // Bootstrap (% of pool → % of total)
    const bsCfg = pool.bootstrapConfig;
    if (bsCfg && bsCfg.mode === 'custom') {
      const bsPctOfPool = Number(bsCfg.supplyPercent) || 0;
      if (bsPctOfPool > 0) {
        arcs.push({
          poolIdx,
          kind: 'bootstrap',
          variant: 0,
          label: 'Bootstrap',
          share: (bsPctOfPool / 100) * poolFraction,
          color: poolPositionColor(poolIdx, 'bootstrap', 0),
        });
      }
    }
    // Wide slices (% of pool → % of total)
    (pool.distribution || []).forEach((s, i) => {
      const slicePctOfPool = Number(s.sharePercent) || 0;
      if (slicePctOfPool > 0) {
        arcs.push({
          poolIdx,
          kind: 'slice',
          variant: i,
          label: pool.distribution.length === 1
            ? 'Main LP'
            : `Slice ${i + 1}/${pool.distribution.length}`,
          share: (slicePctOfPool / 100) * poolFraction,
          color: poolPositionColor(poolIdx, 'slice', i),
        });
      }
    });
    // Ladder bands (% of pool → % of total)
    const ladder = pool.ladderConfig;
    if (ladder && ladder.mode === 'manual' && Array.isArray(ladder.bands)) {
      ladder.bands.forEach((b, i) => {
        const bandPctOfPool = Number(b.supplyPercent) || 0;
        if (bandPctOfPool > 0) {
          arcs.push({
            poolIdx,
            kind: 'band',
            variant: i,
            label: `Band ${i + 1} (${Number(b.lowerMultiplier).toFixed(2)}×–${Number(b.upperMultiplier).toFixed(2)}×)`,
            share: (bandPctOfPool / 100) * poolFraction,
            color: poolPositionColor(poolIdx, 'band', i),
          });
        }
      });
    }
  });
  // Preallocation arcs — render AFTER pool arcs so the donut reads
  // "LP positions clockwise, then preallocation holdback" with a
  // visual break at the boundary.
  //
  // The gap is purely a function of how much supply isn't allocated
  // to LP. Both modes contribute here:
  //   - SIMPLE mode with preallocation on: the user dialed the
  //     simple-mode prealloc slider; pools sum to (100 - prealloc%).
  //   - CUSTOMIZE mode: the user freely sized pools; whatever's left
  //     between the sum and 100% is implicit preallocation, held in
  //     the launch wallet.
  // Either way, the gap is preallocation and the donut should show
  // it explicitly so the user sees the full 100% of supply broken
  // down. Without this, customize-mode under-allocation produced a
  // visual gap in the donut that read as "missing config" rather
  // than "deliberately held back."
  //
  // The airdrop split — separating the airdrop's covered portion
  // from the launch-wallet remainder — only applies in simple mode,
  // since customize mode has no airdrop UI. In customize mode the
  // whole gap is a single "launch wallet (held back)" slice.
  //
  // Each arc carries a `poolIdx: -1` sentinel so renderTokenomicsBreakdownHtml
  // knows to render them in their own non-pool section. Coloring uses
  // a separate palette (slate/grey) so the preallocation slices are
  // visually distinct from any pool's color family.
  const poolsTotalPct = pools.reduce((s, p) => s + (Number(p.supplyPercent) || 0), 0);
  const gapPct = Math.max(0, 100 - poolsTotalPct);
  if (gapPct > 0.01) {
    const isSimpleMode = !simpleConfig.mode || simpleConfig.mode === 'default';
    const totalSupply = parseNumberInput(document.getElementById('tokenSupply'));
    // Airdrop only applies in simple mode (no airdrop UI in customize).
    const airdropOn = isSimpleMode
      && simpleConfig.preallocationEnabled
      && simpleConfig.airdrop && simpleConfig.airdrop.enabled
      && Array.isArray(simpleConfig.airdrop.parsedRows)
      && simpleConfig.airdrop.parsedRows.length > 0;
    // Airdrop's covered token amount as a fraction of total supply.
    let airdropFraction = 0;
    if (airdropOn && Number.isFinite(totalSupply) && totalSupply > 0) {
      const totalAirdropTokens = simpleConfig.airdrop.parsedRows
        .reduce((s, r) => s + (Number(r.tokens) || 0), 0);
      airdropFraction = totalAirdropTokens / totalSupply;
      // Clamp to the gap fraction — airdrop can never exceed the
      // preallocation. The budget gate normally blocks an over-budget
      // CSV before it reaches here; this cap is a defensive sanity
      // bound against any transient bookkeeping mismatch.
      airdropFraction = Math.min(airdropFraction, gapPct / 100);
    }
    const launchWalletFraction = (gapPct / 100) - airdropFraction;
    if (airdropFraction > 0) {
      arcs.push({
        poolIdx: -1,
        kind: 'prealloc-airdrop',
        variant: 0,
        label: 'Airdrop',
        share: airdropFraction,
        color: 'hsl(210, 22%, 48%)', // slate-blue, distinct from any pool hue
      });
    }
    if (launchWalletFraction > 0.0001) {
      arcs.push({
        poolIdx: -1,
        kind: 'prealloc-launch',
        variant: 0,
        label: airdropOn ? 'Launch wallet (unallocated)' : 'Launch wallet (held back)',
        share: launchWalletFraction,
        color: 'hsl(210, 14%, 65%)', // lighter slate for the leftover
      });
    }
  }
  return arcs;
}

// Compute the SVG path string for a donut-segment arc spanning [startA, endA]
// radians, with the given outer and inner radii, centered at (cx, cy).
// Handles the angle-wrap and large-arc flag correctly for any arc <2π.
function donutArcPath(cx, cy, rOuter, rInner, startA, endA) {
  // Avoid 0-width arcs producing degenerate paths.
  if (Math.abs(endA - startA) < 1e-6) return '';
  // Use the "large arc" flag when the arc spans more than half a circle.
  const large = (endA - startA) > Math.PI ? 1 : 0;
  // Cartesian conversion. SVG y axis is flipped — but our trig is
  // standard (anti-clockwise from +x), so we negate the sin term to
  // make the chart read clockwise as users expect.
  const x1 = cx + rOuter * Math.cos(startA);
  const y1 = cy + rOuter * Math.sin(startA);
  const x2 = cx + rOuter * Math.cos(endA);
  const y2 = cy + rOuter * Math.sin(endA);
  const x3 = cx + rInner * Math.cos(endA);
  const y3 = cy + rInner * Math.sin(endA);
  const x4 = cx + rInner * Math.cos(startA);
  const y4 = cy + rInner * Math.sin(startA);
  return [
    `M ${x1} ${y1}`,
    `A ${rOuter} ${rOuter} 0 ${large} 1 ${x2} ${y2}`,
    `L ${x3} ${y3}`,
    `A ${rInner} ${rInner} 0 ${large} 0 ${x4} ${y4}`,
    'Z',
  ].join(' ');
}

// Render the donut chart as SVG markup. Arcs share a starting angle of
// -π/2 (12 o'clock) and go clockwise. Returns an SVG string ready to
// drop into innerHTML.
function renderTokenomicsDonutSvg(arcs, { size = 360, logoDataUrl = null } = {}) {
  const cx = size / 2;
  const cy = size / 2;
  const rOuter = size * 0.45;
  const rInner = size * 0.28;

  // Total share covered. Should be ~1 if positions sum to 100% per pool
  // and pool supplyPercents sum to 100% of total supply. Defensive
  // normalization avoids gaps/overshoot if the math drifts.
  const total = arcs.reduce((s, a) => s + a.share, 0);
  if (total <= 0) {
    return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
      <text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="middle"
            fill="#888" font-size="13">No positions configured</text>
    </svg>`;
  }

  let startA = -Math.PI / 2;
  let segments = '';
  for (const arc of arcs) {
    const sweep = (arc.share / total) * (2 * Math.PI);
    const endA = startA + sweep;
    const path = donutArcPath(cx, cy, rOuter, rInner, startA, endA);
    // title element gives hover tooltips in the browser (Electron's
    // Chromium supports them natively).
    const titleText = `${arc.label}: ${(arc.share * 100).toFixed(2)}% of total supply`;
    segments += `<path d="${path}" fill="${arc.color}" stroke="white" stroke-width="1">
      <title>${escapeHtml(titleText)}</title>
    </path>`;
    startA = endA;
  }

  // Center fill: if a logo data URL is available, embed it as a circular
  // image filling the donut hole. Otherwise fall back to the pool-count
  // summary text. This makes the chart strongly identity-anchored when a
  // logo exists — the chart reads as "the supply breakdown of THIS
  // specific token" rather than as a generic distribution diagram.
  //
  // Implementation: we draw a white circle behind the image as a clean
  // backdrop, clip the image to a circle via SVG <clipPath>, and inset
  // the image slightly from the inner radius so there's a small ring of
  // white between the logo edge and the innermost arc — that ring keeps
  // the logo from visually merging into the arcs at the boundary.
  let centerContent;
  if (logoDataUrl) {
    // Inset by 6% of inner radius to leave a clean ring of backdrop.
    // Cap the inset at a sensible minimum so very small charts don't
    // produce zero-pixel inset.
    const inset = Math.max(2, rInner * 0.06);
    const logoR = rInner - inset;
    const logoX = cx - logoR;
    const logoY = cy - logoR;
    const logoSize = logoR * 2;
    // clipPath ID is suffixed with the chart size so multiple charts on
    // one page (the modal AND the report-preview, if ever rendered side
    // by side) don't share a clip definition.
    const clipId = `donut-logo-clip-${size}`;
    centerContent = `
      <defs>
        <clipPath id="${clipId}">
          <circle cx="${cx}" cy="${cy}" r="${logoR}"/>
        </clipPath>
      </defs>
      <circle cx="${cx}" cy="${cy}" r="${rInner}" fill="white"/>
      <image href="${escapeAttr(logoDataUrl)}" x="${logoX}" y="${logoY}"
             width="${logoSize}" height="${logoSize}"
             preserveAspectRatio="xMidYMid slice"
             clip-path="url(#${clipId})"/>`;
  } else {
    const poolCount = pools.length;
    const positionCount = arcs.length;
    const centerLine1 = `${poolCount} pool${poolCount === 1 ? '' : 's'}`;
    const centerLine2 = `${positionCount} position${positionCount === 1 ? '' : 's'}`;
    centerContent = `
      <circle cx="${cx}" cy="${cy}" r="${rInner}" fill="white"/>
      <text x="${cx}" y="${cy - 8}" text-anchor="middle" dominant-baseline="middle"
            fill="#333" font-size="15" font-weight="600">${centerLine1}</text>
      <text x="${cx}" y="${cy + 12}" text-anchor="middle" dominant-baseline="middle"
            fill="#666" font-size="12">${centerLine2}</text>`;
  }

  return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" style="display:block;margin:0 auto;">
    ${segments}
    ${centerContent}
  </svg>`;
}

// Render the textual breakdown panel next to the chart. Groups arcs by
// pool and lists each position with its supplyPercent and (for bands)
// the multiplier range. Uses small colored swatches that match the
// chart's arc colors so the user can correlate visual ↔ text.
function renderTokenomicsBreakdownHtml(arcs) {
  const name = document.getElementById('tokenName')?.value.trim() || '(unnamed)';
  const symbol = document.getElementById('tokenSymbol')?.value.trim() || '?';
  const supply = parseNumberInput(document.getElementById('tokenSupply'));
  const targetMc = parseNumberInput(document.getElementById('targetMarketCap'));
  const supplyStr = Number.isFinite(supply) && supply > 0
    ? supply.toLocaleString() : '—';
  const mcStr = Number.isFinite(targetMc) && targetMc > 0
    ? `$${targetMc.toLocaleString()}` : '—';

  let html = `
    <p class="is-size-6 mb-2"><strong>${escapeHtml(name)}</strong> · ${escapeHtml(symbol)}</p>
    <p class="is-size-7 has-text-grey mb-3">
      Supply: ${supplyStr} &nbsp;·&nbsp; Target market cap: ${mcStr}
    </p>
  `;

  pools.forEach((pool, poolIdx) => {
    const poolArcs = arcs.filter((a) => a.poolIdx === poolIdx);
    if (poolArcs.length === 0) return; // pool has no real positions
    const poolPct = Number(pool.supplyPercent).toFixed(2);
    const sym = pool.resolvedSymbol || pool.quoteSymbolOverride
      || (pool.quoteToken === 'SOL' ? 'SOL' : pool.quoteToken?.slice(0, 6) + '…');
    const sliceCount = (pool.distribution || []).filter((s) => Number(s.sharePercent) > 0).length;
    const bandCount = (pool.ladderConfig?.mode === 'manual'
      ? (pool.ladderConfig.bands || []).filter((b) => Number(b.supplyPercent) > 0).length
      : 0);
    const bsActive = pool.bootstrapConfig?.mode === 'custom'
      && Number(pool.bootstrapConfig.supplyPercent) > 0;
    const bsSol = bsActive ? Number(pool.bootstrapConfig.solValue) : 0;

    // Per-pool summary line.
    html += `
      <div class="mb-3">
        <p class="is-size-7 mb-1">
          <strong>${escapeHtml(sym)} pool</strong> &nbsp;·&nbsp; ${poolPct}% of supply
          &nbsp;·&nbsp;
          ${bsActive ? `${bsSol} SOL bootstrap, ` : 'no bootstrap, '}${sliceCount} LP slice${sliceCount === 1 ? '' : 's'}${bandCount > 0 ? `, ${bandCount} ladder band${bandCount === 1 ? '' : 's'}` : ''}
        </p>
        <div style="margin-left:1rem;">
    `;
    poolArcs.forEach((arc) => {
      html += `
        <div class="is-size-7" style="display:flex;align-items:center;gap:0.4rem;margin:0.15rem 0;">
          <span style="display:inline-block;width:10px;height:10px;background:${arc.color};border-radius:2px;flex-shrink:0;"></span>
          <span style="flex:1;">${escapeHtml(arc.label)}</span>
          <span class="has-text-grey">${(arc.share * 100).toFixed(2)}% of supply</span>
        </div>
      `;
    });
    html += '</div></div>';
  });

  // Preallocation section — listed AFTER pools since it's the holdback
  // portion that wasn't allocated to LP. Only renders when there are
  // preallocation arcs in the chart (poolIdx === -1 sentinel). The
  // header line summarizes the total holdback %; sub-lines split it
  // into airdrop / launch-wallet portions matching the chart slices.
  const preallocArcs = arcs.filter((a) => a.poolIdx === -1);
  if (preallocArcs.length > 0) {
    const preallocTotalShare = preallocArcs.reduce((s, a) => s + a.share, 0);
    const preallocTotalPct = (preallocTotalShare * 100).toFixed(2);
    html += `
      <div class="mb-3">
        <p class="is-size-7 mb-1">
          <strong>Preallocation</strong> &nbsp;·&nbsp; ${preallocTotalPct}% of supply
          &nbsp;·&nbsp; held back from LP
        </p>
        <div style="margin-left:1rem;">
    `;
    preallocArcs.forEach((arc) => {
      html += `
        <div class="is-size-7" style="display:flex;align-items:center;gap:0.4rem;margin:0.15rem 0;">
          <span style="display:inline-block;width:10px;height:10px;background:${arc.color};border-radius:2px;flex-shrink:0;"></span>
          <span style="flex:1;">${escapeHtml(arc.label)}</span>
          <span class="has-text-grey">${(arc.share * 100).toFixed(2)}% of supply</span>
        </div>
      `;
    });
    html += '</div></div>';
  }

  // Totals footer. The chart shows 100% when (pool allocations) +
  // (preallocation) sums to the full supply. Both are real arcs in
  // the `arcs` array, so the existing sum already covers this case
  // — but we need the warning text to actually be readable, so we
  // swap the unreadable yellow Bulma class for a darker amber tone
  // that has enough contrast against the parchment background.
  const totalShare = arcs.reduce((s, a) => s + a.share, 0);
  const totalPct = (totalShare * 100).toFixed(2);
  const allocated = totalPct === '100.00';
  // Use explicit colors instead of has-text-warning (a pale yellow
  // that disappears against the parchment background). Success stays
  // as the green class (good contrast). The warning case gets a deep
  // amber that reads clearly on the cream/parchment surface.
  const footerStyle = allocated
    ? 'color: #2c8a52;'  // ok-green, same family as has-text-success but tuned for parchment
    : 'color: #b8821a;'; // deep amber — readable on parchment, still clearly "caution"
  html += `
    <p class="is-size-7 mt-3" style="${footerStyle} font-weight: 600;">
      <strong>${allocated ? '✓' : '⚠'}</strong>
      &nbsp;${totalPct}% of supply allocated across all positions${allocated ? '' : ' — should be 100%'}
    </p>
  `;
  return html;
}

// Open the tokenomics modal. Called from the "Visualize tokenomics" button
// on step 2. Rebuilds the body content from live state on every open so
// the user always sees their current configuration.
//
// If the user has selected a token logo, we embed it in the donut's
// center as a strong identity anchor. The logo is read async via
// FileReader; to keep the modal opening feel instant we render the
// "text fallback" chart first, then swap in the logo-centered version
// as soon as the file is ready. On a fast disk this swap is invisible
// (the modal animates open during the read); on a slow disk the user
// sees the count-text chart briefly before it morphs.
function showTokenomicsModal() {
  const modal = document.getElementById('tokenomicsModal');
  if (!modal) return;

  // Wire close handlers on first open. Can't do this at module load via
  // bind() because the modal markup lives later in the HTML body and
  // app.js runs synchronously before the DOM finishes parsing — bind()
  // would silently fail (the "Element not found" console.warn case).
  // The dataset flag guards against duplicate listeners on repeat opens.
  // Same pattern showTokenInfoModal() uses for the same reason.
  if (!modal.dataset.closeHandlersWired) {
    const close = () => modal.classList.remove('is-active');
    const closeBtn = document.getElementById('tokenomicsModalCloseBtn');
    if (closeBtn) closeBtn.addEventListener('click', close);
    const bg = document.getElementById('tokenomicsModalBackground');
    if (bg) bg.addEventListener('click', close);
    // Escape key closes too, but only when this modal is the one open.
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && modal.classList.contains('is-active')) close();
    });
    modal.dataset.closeHandlersWired = 'true';
  }

  const arcs = buildTokenomicsArcs();
  const breakdownHtml = renderTokenomicsBreakdownHtml(arcs);
  const body = document.getElementById('tokenomicsModalBody');

  // First paint: render the count-text chart and show the modal so it
  // opens instantly. The chart goes into a slot div we can re-render in
  // place once the logo loads.
  const initialSvg = renderTokenomicsDonutSvg(arcs);
  body.innerHTML = `
    <div class="columns is-vcentered">
      <div class="column is-narrow" id="tokenomicsChartSlot">${initialSvg}</div>
      <div class="column">${breakdownHtml}</div>
    </div>
  `;
  modal.classList.add('is-active');

  // Second paint (async): if a logo is selected, swap the chart for a
  // logo-centered version. Fire-and-forget — failures fall back to the
  // initial chart already on screen. We also re-check the modal is still
  // open so a quick close-then-reopen doesn't overwrite the second open's
  // chart with stale data from the first.
  readLogoAsDataUrl().then((logoDataUrl) => {
    if (!logoDataUrl) return;
    if (!modal.classList.contains('is-active')) return;
    const slot = document.getElementById('tokenomicsChartSlot');
    if (!slot) return;
    slot.innerHTML = renderTokenomicsDonutSvg(arcs, { logoDataUrl });
  }).catch(() => { /* ignore — fallback chart is already visible */ });
}

bind('visualizeTokenomicsBtn', 'click', showTokenomicsModal);

// ===========================================================================
// Launch Report Download
// ===========================================================================
//
// Generates a markdown report covering the just-completed launch:
// addresses for the token mint, pools, and every position; lock-status
// transactions; transfer txs for any Fee Keys sent to external recipients;
// and a tokenomics summary mirroring the visualization modal's content.
//
// Triggered from step 5 (after all pools created) or step 6 (after
// transfer). Both bindings call the same generator; the report content
// doesn't change between those two stages because all on-chain ops
// commit by step 5 — step 6 just sweeps the ephemeral wallet.

// Build an explorer URL for an address or transaction signature. Solscan
// is the de facto standard; users can change cluster via the UI if they
// need devnet/testnet view. Leaving cluster off defaults to mainnet,
// which matches what Trebuchet always launches on.
function solscanAddrUrl(addr) {
  return `https://solscan.io/account/${encodeURIComponent(addr)}`;
}
function solscanTxUrl(sig) {
  return `https://solscan.io/tx/${encodeURIComponent(sig)}`;
}

// Format an ISO timestamp as a human-readable local date+time string.
// Used for the report header so the user has a record of when this
// launch happened.
function formatReportTimestamp(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// Generate the HTML report — a self-contained .html document the team
// can open offline, share, or print to PDF. Includes:
//   - Token name/symbol/mint/decimals/supply/target mcap
//   - Embedded SVG donut chart (same chart the preview modal shows)
//   - Per-pool sections with bootstrap/main/ladder positions
//   - Per-row copy buttons for every address and TX signature
//   - Solscan links for everything
//   - Lock-status summary roll-up at the top
//
// Reads from createdTokenInfo, lpResult, pools (user's UI config — used
// for fee tiers, supply percentages, and ladder band ranges), tempWallet,
// and the token form fields. Defensive on every field: a partial-failure
// resume path may produce results where individual positions don't have
// a `txIds.lock` or `transferredTo`. Missing fields render as "—".

// Escape a value for safe inclusion in an HTML attribute. Used for the
// data attributes that drive the copy buttons. Same set as escapeHtml
// but called out separately so the intent reads clearly at call sites.
function escapeAttr(s) {
  return escapeHtml(String(s));
}

// Render one "address row": label, monospace value, copy button, optional
// explorer link. Used throughout the report for any address or tx sig.
// `kind` is 'addr' or 'tx' — only affects the explorer URL builder.
function renderAddressRow(label, value, kind = 'addr') {
  if (!value) {
    return `<div class="addr-row">
      <span class="addr-label">${escapeHtml(label)}</span>
      <span class="addr-value addr-missing">—</span>
    </div>`;
  }
  const url = kind === 'tx' ? solscanTxUrl(value) : solscanAddrUrl(value);
  return `<div class="addr-row">
    <span class="addr-label">${escapeHtml(label)}</span>
    <code class="addr-value">${escapeHtml(value)}</code>
    <button class="copy-btn" data-copy="${escapeAttr(value)}" title="Copy to clipboard">Copy</button>
    <a class="explorer-link" href="${escapeAttr(url)}" target="_blank" rel="noopener" title="Open on Solscan">↗</a>
  </div>`;
}

// Render a fact-line: "Label: value" with no copy button. For non-address
// fields like fee tier, decimals, range multipliers.
function renderFactRow(label, value) {
  return `<div class="fact-row">
    <span class="fact-label">${escapeHtml(label)}</span>
    <span class="fact-value">${escapeHtml(String(value))}</span>
  </div>`;
}

// Render a lock badge — green pill for locked, gray pill for not.
function renderLockBadge(locked) {
  return locked
    ? `<span class="badge badge-locked">🔒 Locked</span>`
    : `<span class="badge badge-unlocked">Not locked</span>`;
}

// Compute the lock-status roll-up across every position in every pool.
// Returns { total, locked, transferred, totalRecipient, allLocked }.
function computeLockSummary(results) {
  let total = 0, locked = 0, transferred = 0, totalRecipient = 0;
  for (const r of results) {
    const mains = Array.isArray(r.mainPositions) ? r.mainPositions : [];
    const ladder = Array.isArray(r.ladderPositions) ? r.ladderPositions : [];
    // Support positions carry the same locked-or-not lifecycle as
    // ladder bands. They never have recipients (Fee Keys stay with
    // the launch wallet), so they only contribute to total + locked
    // counts, never to totalRecipient/transferred. Defensive against
    // older result entries that pre-date the field.
    const support = Array.isArray(r.supportPositions) ? r.supportPositions : [];
    const all = [...mains, ...ladder, ...support, ...(r.bootstrap ? [r.bootstrap] : [])];
    for (const p of all) {
      total++;
      if (p.locked) locked++;
    }
    for (const p of mains) {
      if (p.recipient) {
        totalRecipient++;
        if (p.transferredTo) transferred++;
      }
    }
  }
  return { total, locked, transferred, totalRecipient, allLocked: total > 0 && locked === total };
}

// Build the entire HTML report as a string. Self-contained — inlines
// CSS and JS, includes the SVG chart directly, and embeds the token
// logo as a base64 data URL so the file works offline and survives
// email forwarding without breaking image refs.
//
// Visual theme matches the makesometokens.com marketing site:
// parchment background (#efe5cd theme color), Trebuchet MS body font
// (deliberately on-brand — the typeface is literally named after a
// trebuchet), engineering-manuscript flourishes (FIG. NN callouts,
// bracketed enumerators, "STEP NN · LABEL" headers, blueprint-style
// border treatments).
//
// Optional `logoDataUrl` parameter: if provided, embedded as the report's
// hero image. The downloadLaunchReport caller reads the user's selected
// logo file and converts it to a data URL before calling this.
// Build the Airdrop section of the launch report. Returns an empty
// string when no airdrop ran (lastAirdropResult is null) so the call
// site can render unconditionally — the section just disappears in
// the no-airdrop case. Called from buildLaunchReportHtml.
//
// The section follows the same visual treatment as the other
// numbered sections: [ NN ] enum-badge, section-title, content. Each
// recipient row shows the wallet (with copy + Solscan link via the
// existing addr-row pattern), the tokens delivered, and either the
// transaction signature (for delivered) or the failure reason (for
// failed). Delivered and failed lists are visually distinguished by
// a small color accent on the count badge in each subsection header.
function buildAirdropReportSection() {
  // Two rendering paths share most of the visual treatment (enum badge,
  // section title, recipient table). They diverge on:
  //   - title suffix and intro paragraph (pending vs delivered language)
  //   - row contents (planned amount + "pending" badge vs delivered amount
  //     + tx signature)
  //   - subsection counts and pluralization
  //
  // Pending mode runs when no airdrop result exists yet AND the user has
  // configured a non-empty airdrop. Both Step 5's preview and any
  // pre-transfer Download Launch Report click pick this up so the user
  // never sees a confusing "I configured an airdrop but the report doesn't
  // mention it" state.

  const fmtTokens = (n) => {
    const num = Number(n);
    if (!Number.isFinite(num)) return '—';
    return num.toLocaleString(undefined, { maximumFractionDigits: 6 });
  };
  // Max rows rendered per recipient table (pending / delivered / failed).
  // Keeps very large airdrops from blowing the published report past the
  // Arweave free-upload size cap; the overflow collapses into a count row.
  const MAX_REPORT_AIRDROP_ROWS = 100;
  const overflowRowHtml = (hidden, colSpan, noun) => (hidden > 0
    ? `<tr><td colspan="${colSpan}" style="color: var(--ink-muted, #6a4f2a); font-style: italic;">…and ${hidden.toLocaleString()} more ${noun} — every transfer is verifiable on-chain from the launch wallet.</td></tr>`
    : '');

  // ---- Pending path: airdrop configured but not yet executed ----
  // Triggered when no result exists yet but the configured payload has
  // recipients. buildAirdropTransferPayload returns null when:
  //   - no token created yet (so we can't possibly have run)
  //   - mode is customize (preallocation/airdrop is a simple-mode feature)
  //   - preallocation disabled
  //   - airdrop disabled or empty
  // …so falling through to '' below is the right outcome in all those
  // cases — there genuinely is no airdrop section to render.
  if (!lastAirdropResult) {
    const pending = buildAirdropTransferPayload();
    if (!pending || !Array.isArray(pending.recipients) || pending.recipients.length === 0) {
      return '';
    }
    const recipients = pending.recipients;
    const totalPending = recipients.reduce(
      (s, r) => s + (Number(r.tokens) || 0), 0,
    );

    // Recipient table — same structure as the delivered table but the
    // third column reads "pending" instead of a tx link. Amber tint
    // mirrors the failed-row treatment so "not yet done" is visually
    // distinct from delivered/success.
    const pendingRows = recipients.slice(0, MAX_REPORT_AIRDROP_ROWS).map((r) => {
      const wAddr = String(r.wallet || '');
      const tokensTxt = fmtTokens(r.tokens);
      return `<tr>
        <td>
          <code style="font-family: 'JetBrains Mono', monospace; font-size: 11px; word-break: break-all;">${escapeHtml(wAddr || '—')}</code>
          ${wAddr ? `<a class="explorer-link" href="${escapeAttr(solscanAddrUrl(wAddr))}" target="_blank" rel="noopener" title="View address on Solscan" style="margin-left: 4px;">↗</a>` : ''}
        </td>
        <td style="text-align: right;">${tokensTxt}</td>
        <td style="color: #b8821a; font-style: italic;">pending</td>
      </tr>`;
    }).join('') + overflowRowHtml(recipients.length - MAX_REPORT_AIRDROP_ROWS, 3, 'pending recipients');

    return `
      <hr class="section-rule">
      <div class="enum-badge">[ 04 ] &nbsp; Airdrop</div>
      <h2 class="section-title">
        Airdrop distribution
        <span style="font-size: 13px; color: #b8821a; font-weight: normal; margin-left: 8px;">— pending</span>
      </h2>
      <p style="font-size: 13px; color: var(--ink-muted, #6a4f2a); margin-bottom: 1rem;">
        ${recipients.length} recipient${recipients.length === 1 ? '' : 's'} will receive
        <strong>${fmtTokens(totalPending)}</strong> tokens from the preallocation budget
        when the Step 6 transfer is executed. The list and amounts below are the
        planned distribution.
      </p>
      <h3 class="subsection">
        To be delivered &middot;
        <span style="color: #b8821a;">${recipients.length} recipient${recipients.length === 1 ? '' : 's'}</span> &middot;
        ${fmtTokens(totalPending)} tokens
      </h3>
      <table style="width: 100%; border-collapse: collapse; font-size: 12px; margin-bottom: 1rem;">
        <thead>
          <tr style="border-bottom: 1px solid var(--rule, rgba(28,22,16,0.15));">
            <th style="text-align: left; padding: 4px 8px 4px 0;">Recipient</th>
            <th style="text-align: right; padding: 4px 8px;">Tokens</th>
            <th style="text-align: left; padding: 4px 0;">Status</th>
          </tr>
        </thead>
        <tbody>${pendingRows}</tbody>
      </table>
    `;
  }

  // ---- Post-run path: airdrop has executed; render delivered + failed ----
  const delivered = lastAirdropResult.transferred || [];
  const failed = lastAirdropResult.failed || [];
  if (delivered.length === 0 && failed.length === 0) return '';

  // Total tokens delivered — sum across the transferred list. Useful
  // summary stat at the top so the user has a single number for "how
  // much actually went out" without scanning every row.
  const totalDelivered = delivered.reduce(
    (s, r) => s + (Number(r.tokens) || 0), 0,
  );
  const totalFailed = failed.reduce(
    (s, r) => s + (Number(r.tokens) || 0), 0,
  );

  // Delivered rows — each shows wallet + tokens + tx signature with
  // Solscan link. Pattern matches the per-pool position rows so the
  // report reads consistently end-to-end.
  let deliveredRows = '';
  if (delivered.length > 0) {
    deliveredRows = delivered.slice(0, MAX_REPORT_AIRDROP_ROWS).map((r) => {
      const wAddr = String(r.wallet || '');
      const tokensTxt = fmtTokens(r.tokens);
      const txCell = r.txId
        ? `<a class="explorer-link" href="${escapeAttr(solscanTxUrl(r.txId))}" target="_blank" rel="noopener" title="View transaction on Solscan">${escapeHtml(r.txId.slice(0, 8))}…↗</a>`
        : '—';
      return `<tr>
        <td>
          <code style="font-family: 'JetBrains Mono', monospace; font-size: 11px; word-break: break-all;">${escapeHtml(wAddr || '—')}</code>
          ${wAddr ? `<a class="explorer-link" href="${escapeAttr(solscanAddrUrl(wAddr))}" target="_blank" rel="noopener" title="View address on Solscan" style="margin-left: 4px;">↗</a>` : ''}
        </td>
        <td style="text-align: right;">${tokensTxt}</td>
        <td>${txCell}</td>
      </tr>`;
    }).join('') + overflowRowHtml(delivered.length - MAX_REPORT_AIRDROP_ROWS, 3, 'delivered recipients');
  }

  // Failed rows — each shows wallet + tokens + the failure reason
  // (truncated if very long; the on-screen result panel and the
  // downloadable CSV both have the full text). Color-tinted in muted
  // amber to distinguish from delivered rows at a glance.
  let failedRows = '';
  if (failed.length > 0) {
    failedRows = failed.slice(0, MAX_REPORT_AIRDROP_ROWS).map((r) => {
      const wAddr = String(r.wallet || '');
      const tokensTxt = fmtTokens(r.tokens);
      let reasonRaw = String(r.error || 'unknown error');
      if (reasonRaw.length > 140) reasonRaw = reasonRaw.slice(0, 137) + '…';
      const verifyLinkHtml = r.signature
        ? ` <a class="explorer-link" href="${escapeAttr(solscanTxUrl(r.signature))}" target="_blank" rel="noopener" title="View transaction on Solscan to verify whether it landed">verify ↗</a>`
        : '';
      return `<tr>
        <td>
          <code style="font-family: 'JetBrains Mono', monospace; font-size: 11px; word-break: break-all;">${escapeHtml(wAddr || '—')}</code>
          ${wAddr ? `<a class="explorer-link" href="${escapeAttr(solscanAddrUrl(wAddr))}" target="_blank" rel="noopener" title="View address on Solscan" style="margin-left: 4px;">↗</a>` : ''}
        </td>
        <td style="text-align: right;">${tokensTxt}</td>
        <td style="color: #b8821a;">${escapeHtml(reasonRaw)}${verifyLinkHtml}</td>
      </tr>`;
    }).join('') + overflowRowHtml(failed.length - MAX_REPORT_AIRDROP_ROWS, 3, 'failed recipients');
  }

  // Compose the two subsections. We only render a subsection when
  // there's something to put in it, so a clean airdrop produces just
  // the "Delivered" subsection and a fully-failed airdrop (rare)
  // produces just the "Failed" subsection.
  let deliveredBlock = '';
  if (delivered.length > 0) {
    deliveredBlock = `
      <h3 class="subsection">
        Delivered &middot;
        <span style="color: #2c8a52;">${delivered.length} recipient${delivered.length === 1 ? '' : 's'}</span> &middot;
        ${fmtTokens(totalDelivered)} tokens
      </h3>
      <table style="width: 100%; border-collapse: collapse; font-size: 12px; margin-bottom: 1rem;">
        <thead>
          <tr style="border-bottom: 1px solid var(--rule, rgba(28,22,16,0.15));">
            <th style="text-align: left; padding: 4px 8px 4px 0;">Recipient</th>
            <th style="text-align: right; padding: 4px 8px;">Tokens</th>
            <th style="text-align: left; padding: 4px 0;">Transaction</th>
          </tr>
        </thead>
        <tbody>${deliveredRows}</tbody>
      </table>
    `;
  }
  let failedBlock = '';
  if (failed.length > 0) {
    failedBlock = `
      <h3 class="subsection">
        Failed &middot;
        <span style="color: #b8821a;">${failed.length} recipient${failed.length === 1 ? '' : 's'}</span> &middot;
        ${fmtTokens(totalFailed)} tokens un-delivered
      </h3>
      <p style="font-size: 12px; color: var(--ink-muted, #6a4f2a); margin-bottom: 0.5rem;">
        These recipients did not receive their share during the launch.
        Their portion of the supply remained in the ephemeral wallet and
        was swept to the destination wallet alongside the rest. To
        distribute manually, use the recipient list below or the
        downloadable CSV from the Step 6 result panel.
      </p>
      <table style="width: 100%; border-collapse: collapse; font-size: 12px; margin-bottom: 1rem;">
        <thead>
          <tr style="border-bottom: 1px solid var(--rule, rgba(28,22,16,0.15));">
            <th style="text-align: left; padding: 4px 8px 4px 0;">Recipient</th>
            <th style="text-align: right; padding: 4px 8px;">Tokens</th>
            <th style="text-align: left; padding: 4px 0;">Reason</th>
          </tr>
        </thead>
        <tbody>${failedRows}</tbody>
      </table>
    `;
  }

  return `
    <hr class="section-rule">
    <div class="enum-badge">[ 04 ] &nbsp; Airdrop</div>
    <h2 class="section-title">Airdrop distribution</h2>
    <p style="font-size: 13px; color: var(--ink-muted, #6a4f2a); margin-bottom: 1rem;">
      The launched token was distributed to ${delivered.length + failed.length}
      recipient${(delivered.length + failed.length) === 1 ? '' : 's'} from the
      preallocation budget as part of the Step 6 transfer.
      ${failed.length > 0 ? `<strong style="color: #b8821a;">${failed.length} did not deliver successfully.</strong>` : ''}
    </p>
    ${deliveredBlock}
    ${failedBlock}
  `;
}

function buildLaunchReportHtml({ logoDataUrl = null } = {}) {
  const now = new Date();
  const tokenInfo = createdTokenInfo || {};
  const results = (lpResult && Array.isArray(lpResult.results)) ? lpResult.results : [];
  const tokenName = document.getElementById('tokenName')?.value.trim() || tokenInfo.name || '(unnamed)';
  const tokenSymbol = document.getElementById('tokenSymbol')?.value.trim() || tokenInfo.symbol || '?';
  const tokenDescription = document.getElementById('tokenDescription')?.value.trim() || '';
  const supply = parseNumberInput(document.getElementById('tokenSupply'));
  const targetMc = parseNumberInput(document.getElementById('targetMarketCap'));
  const summary = computeLockSummary(results);

  // Reuse the same chart and breakdown the preview modal uses, so the
  // report's tokenomics view matches what the user saw at launch time.
  // Slightly smaller in the report so the chart and breakdown fit
  // side-by-side comfortably at the parchment-page width. If the user
  // provided a logo we pass it through so the chart center shows the
  // logo — same treatment as the hero block at the top of the report.
  const arcs = buildTokenomicsArcs();
  const chartSvg = renderTokenomicsDonutSvg(arcs, { size: 300, logoDataUrl });

  // ---- Per-pool sections ----
  let poolSections = '';
  results.forEach((r, idx) => {
    const userPool = pools[r.allocationIndex ?? idx] || pools[idx] || {};
    const sym = r.quoteSymbol || userPool.resolvedSymbol || '?';
    const supplyPct = Number(r.supplyPercent ?? userPool.supplyPercent ?? 0).toFixed(2);
    const feeTierIdx = userPool.ammConfigIndex;
    const feeTier = feeTiers.find((t) => t.index === feeTierIdx);
    const feeTierLabel = feeTier
      ? `${(feeTier.tradeFeeRate / 10000).toFixed(2)}% / spacing ${feeTier.tickSpacing}`
      : (feeTierIdx != null ? `index ${feeTierIdx}` : '—');

    // Pool's own colour from the chart palette — used for the section
    // accent so the report visually ties pools to their arcs.
    const poolHue = POOL_COLOR_BASES[idx % POOL_COLOR_BASES.length].h;
    const poolSat = POOL_COLOR_BASES[idx % POOL_COLOR_BASES.length].s;

    let positionsHtml = '';

    // Bootstrap position (if present)
    if (r.bootstrap) {
      positionsHtml += `
        <div class="position-card">
          <div class="position-header">
            <span class="position-kind">Bootstrap position</span>
            ${renderLockBadge(r.bootstrap.locked)}
          </div>
          ${renderAddressRow('Position NFT', r.bootstrap.nftMint)}
          ${r.bootstrap.feeKeyNftMint ? renderAddressRow('Fee Key NFT', r.bootstrap.feeKeyNftMint) : ''}
          ${renderAddressRow('Open TX', r.bootstrap.txIds?.open, 'tx')}
          ${renderAddressRow('Lock TX', r.bootstrap.txIds?.lock, 'tx')}
        </div>`;
    }

    // Main LP positions / slices
    const mains = Array.isArray(r.mainPositions) ? r.mainPositions : [];
    mains.forEach((pos, si) => {
      const sliceLabel = mains.length === 1
        ? 'Main LP position'
        : `Main LP slice ${si + 1}/${mains.length}`;
      const shareText = pos.sharePercent != null
        ? `${Number(pos.sharePercent).toFixed(2)}% of wide bucket`
        : null;

      let recipientBlock = '';
      if (pos.recipient) {
        recipientBlock = `
          ${renderAddressRow('Fee Key recipient', pos.recipient)}
          <div class="fact-row">
            <span class="fact-label">Transferred to recipient</span>
            <span class="fact-value">${pos.transferredTo ? 'Yes' : 'No (Fee Key NFT stayed with launch wallet)'}</span>
          </div>
          ${pos.txIds?.transfer ? renderAddressRow('Fee Key transfer TX', pos.txIds.transfer, 'tx') : ''}`;
      }

      positionsHtml += `
        <div class="position-card">
          <div class="position-header">
            <span class="position-kind">${escapeHtml(sliceLabel)}</span>
            ${renderLockBadge(pos.locked)}
          </div>
          ${shareText ? renderFactRow('Share', shareText) : ''}
          ${Number.isFinite(pos.tickLower) && Number.isFinite(pos.tickUpper) ? renderFactRow('Range', `tick ${pos.tickLower} \u2192 ${pos.tickUpper} (single-sided, above launch)`) : ''}
          ${renderAddressRow('Position NFT', pos.nftMint)}
          ${pos.feeKeyNftMint ? renderAddressRow('Fee Key NFT', pos.feeKeyNftMint) : ''}
          ${renderAddressRow('Open TX', pos.txIds?.open, 'tx')}
          ${renderAddressRow('Lock TX', pos.txIds?.lock, 'tx')}
          ${recipientBlock}
        </div>`;
    });

    // Ladder bands
    const ladder = Array.isArray(r.ladderPositions) ? r.ladderPositions : [];
    ladder.forEach((pos, bi) => {
      const userBand = userPool.ladderConfig?.bands?.[bi];
      const rangeLabel = userBand
        ? `${Number(userBand.lowerMultiplier).toFixed(2)}× – ${Number(userBand.upperMultiplier).toFixed(2)}× launch price`
        : `tick ${pos.tickLower} → ${pos.tickUpper}`;
      const supplyText = userBand
        ? `${Number(userBand.supplyPercent).toFixed(2)}% of pool`
        : null;

      positionsHtml += `
        <div class="position-card">
          <div class="position-header">
            <span class="position-kind">Ladder band ${bi + 1}/${ladder.length}</span>
            ${renderLockBadge(pos.locked)}
          </div>
          ${renderFactRow('Range', rangeLabel)}
          ${supplyText ? renderFactRow('Token-supply share', supplyText) : ''}
          ${renderAddressRow('Position NFT', pos.nftMint)}
          ${pos.feeKeyNftMint ? renderAddressRow('Fee Key NFT', pos.feeKeyNftMint) : ''}
          ${renderAddressRow('Open TX', pos.txIds?.open, 'tx')}
          ${renderAddressRow('Lock TX', pos.txIds?.lock, 'tx')}
        </div>`;
    });

    // Support positions. Single-sided quote position(s) sitting below
    // launch price (above for mintB-side launches). Backs preallocated
    // supply with a quote-side buy wall. No recipient — Fee Keys stay
    // with the launch wallet. Currently always 0 or 1 entries per pool,
    // but rendered as a loop in case future iterations open multiple
    // support bands at different depths.
    const support = Array.isArray(r.supportPositions) ? r.supportPositions : [];
    support.forEach((pos, si) => {
      const depthLabel = pos.depthPct != null
        ? `launch price down to -${Number(pos.depthPct).toFixed(0)}% (single-sided quote)`
        : `tick ${pos.tickLower} → ${pos.tickUpper}`;
      positionsHtml += `
        <div class="position-card">
          <div class="position-header">
            <span class="position-kind">Support position${support.length > 1 ? ` ${si + 1}/${support.length}` : ''}</span>
            ${renderLockBadge(pos.locked)}
          </div>
          ${renderFactRow('Range', depthLabel)}
          ${renderAddressRow('Position NFT', pos.nftMint)}
          ${pos.feeKeyNftMint ? renderAddressRow('Fee Key NFT', pos.feeKeyNftMint) : ''}
          ${renderAddressRow('Open TX', pos.txIds?.open, 'tx')}
          ${renderAddressRow('Lock TX', pos.txIds?.lock, 'tx')}
        </div>`;
    });

    const poolEnum = String(idx + 1).padStart(2, '0');
    poolSections += `
      <section class="pool-section">
        <div class="pool-section-header">
          <div class="enum-badge">POOL · ${poolEnum}</div>
          <h2 class="pool-title">
            <span class="pool-swatch" style="background: hsl(${poolHue}, ${poolSat}%, 45%);"></span>
            ${escapeHtml(sym)} pool
          </h2>
          <div class="pool-meta">${supplyPct}% of token supply &nbsp;·&nbsp; Fee tier ${escapeHtml(feeTierLabel)}</div>
        </div>
        <div class="pool-addresses">
          ${renderAddressRow('Pool ID', r.poolId)}
          ${(() => {
            // Quote mint: the result records the resolved address; the
            // config carries the user's raw entry (symbol or address).
            // Skip the row for native SOL — its mint is implied.
            const qm = r.quoteAddress || userPool.quoteToken;
            const isSol = (r.quoteSymbol || userPool.quoteToken || '').toUpperCase() === 'SOL';
            return (qm && !isSol) ? renderAddressRow('Quote token mint', qm) : '';
          })()}
          ${renderAddressRow('Create-pool TX', r.txIds?.createPool, 'tx')}
        </div>
        ${(() => {
          // Per-pool liquidity depth chart, baked in as static SVG so the
          // standalone report needs no scripts. Two-sided: support buy wall
          // below launch + wide/ladder above. Shown when there's a ladder or a
          // (placeable) support wall; omitted for a lone flat band.
          if (typeof computeDepthProfile !== 'function') return '';
          const effSupplyPct = Number(r.supplyPercent ?? userPool.supplyPercent);
          const poolNotionalUsd = (Number(targetMc) > 0 && effSupplyPct > 0)
            ? (effSupplyPct / 100) * Number(targetMc) : 0;
          let support = null;
          const sc = userPool.supportConfig;
          if (sc && sc.mode === 'custom' && Number(sc.solValue) > 0) {
            const solPool = (Array.isArray(pools) ? pools : []).find((p) => (p.quoteToken || '').toUpperCase() === 'SOL');
            const solUsd = solPool && Number(solPool.resolvedPriceUsd) > 0 ? Number(solPool.resolvedPriceUsd) : null;
            if (solUsd) support = { usd: Number(sc.solValue) * solUsd, depthPct: Number(sc.depthPct) || 30 };
          }
          const prof = computeDepthProfile(userPool, { poolNotionalUsd, support });
          const html = prof ? renderDepthChartSvg(prof) : '';
          return html ? `<div class="pool-depth-chart" style="margin: 12px 0 4px;">${html}</div>` : '';
        })()}
        <div class="positions-grid">${positionsHtml}</div>
      </section>`;
  });

  // ---- Status banner (top of report) ----
  // Status banner. Two information dimensions: position locks (everything
  // locked? partial?) and Fee Key transfers (any external recipients
  // configured? did they all receive their NFTs?). The lock dimension is
  // always shown; the transfer dimension only when relevant.
  let statusBanner;
  if (results.length === 0) {
    statusBanner = `<div class="banner banner-warn">
      <strong>No pool results captured.</strong>
      This may indicate the launch did not reach the create-pool phase.
    </div>`;
  } else if (summary.allLocked) {
    // Lock all good. Surface transfer status only when external recipients
    // existed AND some failed — otherwise that line would be either "0/0"
    // (uninformative) or "all delivered" (already implicit in the green
    // banner). Failed transfers are the case the user genuinely needs to
    // know about, because the Fee Key NFTs sweep to the destination wallet
    // on transfer and the user has to forward them manually.
    const transferIssue = summary.totalRecipient > 0
      && summary.transferred < summary.totalRecipient;
    statusBanner = `<div class="banner banner-${transferIssue ? 'warn' : 'ok'}">
      <strong>All ${summary.total} positions locked.</strong>
      The liquidity is permanently committed via Burn &amp; Earn. Fees accrue to the Fee Key NFT holders.
      ${transferIssue ? `<br><strong>${summary.transferred} / ${summary.totalRecipient} Fee Key NFTs reached their external recipients</strong> — the remaining ones swept back to the launch wallet and were transferred to the destination wallet on step 6. Forward them manually to complete delivery.` : ''}
    </div>`;
  } else {
    statusBanner = `<div class="banner banner-warn">
      <strong>${summary.locked} / ${summary.total} positions locked.</strong>
      Any unlocked position is still controlled by the ephemeral launch wallet. If you ran the transfer step, those NFTs were swept to your destination wallet — you can re-lock them via Raydium's Burn &amp; Earn UI.
      ${summary.totalRecipient > 0 && summary.transferred < summary.totalRecipient ? `<br><strong>${summary.transferred} / ${summary.totalRecipient} Fee Key NFTs reached their external recipients.</strong>` : ''}
    </div>`;
  }

  // ---- Demo banner (top of report) ----
  // Detect a demo launch by its synthetic Demo-prefixed addresses rather
  // than re-reading the live demoModeActive flag — that way the banner is
  // correct even for a report regenerated later, and it keys off the actual
  // content. A demo launch always has a Demo-prefixed token mint and pool
  // ids; checking a couple of representative addresses is enough.
  const isDemoReport =
    (tokenInfo.mint || '').startsWith('Demo') ||
    results.some((r) => (r.poolId || '').startsWith('Demo'));
  const demoBanner = isDemoReport
    ? `<div class="banner banner-demo">
        <strong>⚠ DEMO LAUNCH REPORT</strong>
        Synthetic addresses, no real transactions. This report was generated in
        demo mode — the addresses below are not real and their explorer links
        will not resolve.
      </div>`
    : '';

  // ---- Tokenomics breakdown (textual, matches the chart) ----
  let breakdownHtml = '';
  pools.forEach((pool, poolIdx) => {
    const poolArcs = arcs.filter((a) => a.poolIdx === poolIdx);
    if (poolArcs.length === 0) return;
    const sym = pool.resolvedSymbol || (pool.quoteToken === 'SOL' ? 'SOL' : pool.quoteToken?.slice(0, 6) + '…');
    breakdownHtml += `<div class="breakdown-pool"><div class="breakdown-pool-name">${escapeHtml(sym)} pool — ${Number(pool.supplyPercent).toFixed(2)}%</div>`;
    poolArcs.forEach((arc) => {
      breakdownHtml += `<div class="breakdown-arc">
        <span class="breakdown-swatch" style="background:${arc.color};"></span>
        <span class="breakdown-arc-label">${escapeHtml(arc.label)}</span>
        <span class="breakdown-arc-share">${(arc.share * 100).toFixed(2)}%</span>
      </div>`;
    });
    breakdownHtml += '</div>';
  });

  // Preallocation section (Airdrop + Launch-wallet holdback) — these arcs
  // already exist in the donut chart with poolIdx === -1, but without an
  // entry in the textual breakdown the legend's percentages sum to less
  // than 100% with no explanation of where the rest of the supply went.
  // Mirrors the in-app renderTokenomicsBreakdownHtml preallocation
  // section so the report and the in-app preview present the same info.
  const preallocArcs = arcs.filter((a) => a.poolIdx === -1);
  if (preallocArcs.length > 0) {
    const preallocTotalPct = preallocArcs
      .reduce((s, a) => s + a.share, 0) * 100;
    breakdownHtml += `<div class="breakdown-pool">
      <div class="breakdown-pool-name">Preallocation — ${preallocTotalPct.toFixed(2)}%</div>`;
    preallocArcs.forEach((arc) => {
      breakdownHtml += `<div class="breakdown-arc">
        <span class="breakdown-swatch" style="background:${arc.color};"></span>
        <span class="breakdown-arc-label">${escapeHtml(arc.label)}</span>
        <span class="breakdown-arc-share">${(arc.share * 100).toFixed(2)}%</span>
      </div>`;
    });
    breakdownHtml += '</div>';
  }

  // ---- Logo hero block ----
  // Embedded as a data URL so the report is fully portable. The user
  // didn't have to provide one — we render a placeholder block with
  // the token symbol instead so the layout reads consistently.
  const logoBlock = logoDataUrl
    ? `<img class="hero-logo" src="${escapeHtml(logoDataUrl)}" alt="${escapeHtml(tokenName)} logo">`
    : `<div class="hero-logo hero-logo-placeholder">${escapeHtml((tokenSymbol || '?').slice(0, 3).toUpperCase())}</div>`;

  // ---- Final HTML document ----
  // Inline CSS so the file works offline and survives email forwarding.
  // Inline JS for the clipboard behavior. The aesthetic mirrors the
  // makesometokens.com marketing site — parchment background, ink
  // typography, engineering-manuscript flourishes.
  const safeName = escapeHtml(tokenName);
  const safeSymbol = escapeHtml(tokenSymbol);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${safeName} (${safeSymbol}) — Launch Dossier</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#efe5cd">
  <style>
    /* ============================================================
       Theme — matches makesometokens.com
       Parchment background, ink typography, engineering-manuscript
       flourishes. Trebuchet MS body font (literally on-brand —
       the typeface is named after a trebuchet).
       ============================================================ */
    :root {
      --parchment: #efe5cd;
      --parchment-deep: #e6dab9;
      --parchment-edge: #d6c8a3;
      --ink: #1a1a1a;
      --ink-soft: #3d3a32;
      --ink-muted: #6b6657;
      --rule: #1a1a1a;
      --rule-soft: #b8ad8a;
      --accent: #8a3a1a;        /* sienna red — matches the manuscript ink-stamp feel */
      --ok: #2d5016;
      --ok-bg: #d9e6c8;
      --ok-edge: #8aa466;
      --warn: #7a3a0a;
      --warn-bg: #eed9b0;
      --warn-edge: #c89860;
      --mono: "Courier New", Courier, ui-monospace, monospace;
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; }
    body {
      font-family: "Trebuchet MS", "Lucida Sans Unicode", "Lucida Grande", Tahoma, sans-serif;
      background: var(--parchment);
      color: var(--ink);
      line-height: 1.55;
      font-size: 14.5px;
      /* Subtle paper texture — radial gradient gives a hint of vignette
         without requiring an external image. */
      background-image:
        radial-gradient(ellipse at center, transparent 0%, transparent 70%, rgba(110, 90, 50, 0.08) 100%),
        repeating-linear-gradient(0deg, transparent 0 28px, rgba(110, 90, 50, 0.012) 28px 29px);
      background-attachment: fixed;
    }
    .wrap {
      max-width: 1100px;
      margin: 0 auto;
      padding: 36px 32px 80px;
    }
    a { color: var(--accent); text-decoration: underline; text-decoration-thickness: 1px; text-underline-offset: 2px; }
    a:hover { text-decoration-thickness: 2px; }
    code { font-family: var(--mono); font-size: 0.92em; }

    /* ---------- Top masthead ---------- */
    .masthead {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 16px;
      padding-bottom: 12px;
      margin-bottom: 8px;
      border-bottom: 2px solid var(--rule);
      font-family: var(--mono);
      font-size: 11px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: var(--ink-soft);
    }
    .masthead-left { display: flex; align-items: center; gap: 18px; }
    .masthead-brand { font-weight: 700; letter-spacing: 0.35em; color: var(--ink); }
    .masthead-right { text-align: right; }

    /* ---------- Document title block ---------- */
    .title-block {
      display: grid;
      grid-template-columns: 120px 1fr;
      gap: 32px;
      align-items: center;
      margin: 32px 0 24px;
      padding-bottom: 24px;
      border-bottom: 1px solid var(--rule-soft);
    }
    @media (max-width: 600px) {
      .title-block { grid-template-columns: 1fr; text-align: center; }
    }
    .hero-logo {
      width: 120px;
      height: 120px;
      object-fit: contain;
      border-radius: 50%;
      background: var(--parchment-deep);
      border: 2px solid var(--rule);
      box-shadow: 0 2px 0 var(--rule-soft);
    }
    .hero-logo-placeholder {
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: var(--mono);
      font-size: 34px;
      font-weight: 700;
      color: var(--ink-soft);
      letter-spacing: 0.1em;
    }
    .doc-fig {
      font-family: var(--mono);
      font-size: 11px;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      color: var(--ink-muted);
      margin: 0 0 8px;
    }
    .doc-title {
      margin: 0;
      font-size: 44px;
      font-weight: 700;
      line-height: 1.05;
      letter-spacing: -0.01em;
    }
    .doc-title .doc-symbol {
      color: var(--ink-muted);
      font-weight: 500;
      font-size: 0.6em;
      letter-spacing: 0.02em;
      margin-left: 0.4em;
    }
    .doc-subtitle {
      margin: 10px 0 0;
      color: var(--ink-soft);
      font-size: 15px;
      font-style: italic;
      max-width: 60ch;
    }

    /* ---------- Section enumeration / headers ---------- */
    .enum-badge {
      display: inline-block;
      font-family: var(--mono);
      font-size: 10.5px;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      color: var(--ink-muted);
      padding: 3px 10px;
      border: 1px solid var(--rule-soft);
      background: var(--parchment-deep);
      margin-bottom: 12px;
    }
    .section-rule {
      margin: 36px 0 24px;
      border: 0;
      border-top: 2px solid var(--rule);
      position: relative;
    }
    .section-rule::after {
      content: "";
      position: absolute;
      top: 4px;
      left: 0;
      right: 0;
      border-top: 1px solid var(--rule);
    }
    h2.section-title {
      margin: 0 0 18px;
      font-size: 22px;
      font-weight: 700;
      letter-spacing: -0.005em;
    }
    h3.subsection {
      margin: 18px 0 8px;
      font-family: var(--mono);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.15em;
      color: var(--ink-muted);
      font-weight: 600;
    }

    /* ---------- Banner ---------- */
    .banner {
      padding: 12px 16px;
      margin: 20px 0 28px;
      font-size: 13.5px;
      border: 1px solid;
      background: var(--parchment-deep);
      position: relative;
    }
    .banner::before {
      content: "";
      position: absolute;
      left: 0; top: 0; bottom: 0;
      width: 4px;
    }
    .banner strong { display: inline-block; margin-right: 6px; }
    .banner-ok { border-color: var(--ok-edge); color: var(--ok); background: var(--ok-bg); }
    .banner-ok::before { background: var(--ok); }
    .banner-warn { border-color: var(--warn-edge); color: var(--warn); background: var(--warn-bg); }
    .banner-warn::before { background: var(--warn); }
    /* Demo report banner — bright amber, hard to miss, so a demo report
       received out of context is instantly recognizable as synthetic. */
    .banner-demo { border-color: #f0c040; color: #6b4b00; background: #fef3c7; }
    .banner-demo::before { background: #f0c040; }

    /* ---------- Token summary stat-grid ---------- */
    .token-summary-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
      gap: 0;
      border: 1px solid var(--rule);
      background: var(--parchment-deep);
    }
    .token-stat {
      padding: 14px 18px;
      border-right: 1px solid var(--rule-soft);
    }
    .token-stat:last-child { border-right: none; }
    .token-stat-label {
      font-family: var(--mono);
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.15em;
      color: var(--ink-muted);
      margin-bottom: 6px;
    }
    .token-stat-value {
      font-size: 18px;
      font-weight: 700;
      letter-spacing: -0.01em;
    }

    /* ---------- Tokenomics block ---------- */
    .tokenomics {
      display: grid;
      grid-template-columns: 320px 1fr;
      gap: 36px;
      align-items: start;
      margin-top: 16px;
    }
    @media (max-width: 720px) {
      .tokenomics { grid-template-columns: 1fr; }
    }
    .tokenomics svg { display: block; margin: 0 auto; }
    .chart-caption {
      font-family: var(--mono);
      font-size: 10px;
      letter-spacing: 0.15em;
      text-transform: uppercase;
      text-align: center;
      color: var(--ink-muted);
      margin-top: 4px;
    }
    .breakdown-pool { margin-bottom: 18px; }
    .breakdown-pool:last-child { margin-bottom: 0; }
    .breakdown-pool-name {
      font-weight: 700;
      font-size: 13px;
      margin-bottom: 8px;
      padding-bottom: 4px;
      border-bottom: 1px dashed var(--rule-soft);
      font-family: var(--mono);
      letter-spacing: 0.05em;
      text-transform: uppercase;
      color: var(--ink-soft);
    }
    .breakdown-arc {
      display: grid;
      grid-template-columns: 14px 1fr auto;
      gap: 10px;
      align-items: center;
      font-size: 13px;
      padding: 3px 0;
    }
    .breakdown-swatch {
      width: 12px; height: 12px; border-radius: 2px;
      border: 1px solid rgba(0,0,0,0.15);
    }
    .breakdown-arc-share {
      color: var(--ink-soft);
      font-variant-numeric: tabular-nums;
      font-family: var(--mono);
      font-size: 12px;
    }

    /* ---------- Pool section ---------- */
    .pool-section {
      margin: 28px 0;
      padding-top: 6px;
      border-top: 2px solid var(--rule);
    }
    .pool-section-header {
      margin-bottom: 18px;
    }
    .pool-title {
      margin: 0 0 4px;
      font-size: 24px;
      font-weight: 700;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .pool-swatch {
      display: inline-block;
      width: 16px; height: 16px;
      border-radius: 2px;
      border: 1px solid var(--rule);
    }
    .pool-meta {
      font-family: var(--mono);
      font-size: 11px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--ink-muted);
    }
    .pool-addresses {
      margin-bottom: 20px;
      padding: 14px 16px;
      background: var(--parchment-deep);
      border: 1px solid var(--rule-soft);
    }

    /* ---------- Position cards ---------- */
    .positions-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(440px, 1fr));
      gap: 14px;
    }
    .position-card {
      background: var(--parchment-deep);
      border: 1px solid var(--rule-soft);
      padding: 14px 16px;
      position: relative;
    }
    /* Top-left corner notch — engineering-drawing accent */
    .position-card::before {
      content: "";
      position: absolute;
      top: 0; left: 0;
      width: 8px; height: 8px;
      border-top: 2px solid var(--rule);
      border-left: 2px solid var(--rule);
    }
    .position-card::after {
      content: "";
      position: absolute;
      bottom: 0; right: 0;
      width: 8px; height: 8px;
      border-bottom: 2px solid var(--rule);
      border-right: 2px solid var(--rule);
    }
    .position-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 10px;
      padding-bottom: 8px;
      border-bottom: 1px dashed var(--rule-soft);
    }
    .position-kind {
      font-weight: 700;
      font-size: 13.5px;
      letter-spacing: 0.01em;
    }

    /* ---------- Address rows ---------- */
    .addr-row {
      display: grid;
      grid-template-columns: 140px 1fr auto auto;
      gap: 8px;
      align-items: center;
      padding: 5px 0;
      font-size: 12.5px;
    }
    .addr-label {
      font-family: var(--mono);
      color: var(--ink-muted);
      font-size: 10.5px;
      letter-spacing: 0.1em;
      text-transform: uppercase;
    }
    .addr-value {
      font-family: var(--mono);
      font-size: 11.5px;
      background: var(--parchment);
      padding: 4px 8px;
      border: 1px solid var(--rule-soft);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .addr-missing {
      background: transparent;
      border: none;
      color: var(--ink-muted);
      font-style: italic;
      padding-left: 0;
    }
    .copy-btn {
      font: inherit;
      font-family: var(--mono);
      font-size: 10px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      padding: 4px 10px;
      background: var(--parchment);
      border: 1px solid var(--rule);
      cursor: pointer;
      color: var(--ink);
      transition: all 120ms ease;
    }
    .copy-btn:hover {
      background: var(--ink);
      color: var(--parchment);
    }
    .copy-btn.copied {
      background: var(--ok);
      border-color: var(--ok);
      color: var(--parchment);
    }
    .explorer-link {
      color: var(--ink-soft);
      font-size: 14px;
      text-decoration: none;
      padding: 2px 6px;
      border: 1px solid var(--rule-soft);
      background: var(--parchment);
      font-family: var(--mono);
    }
    .explorer-link:hover {
      background: var(--ink);
      color: var(--parchment);
      border-color: var(--ink);
      text-decoration: none;
    }

    /* ---------- Fact rows ---------- */
    .fact-row {
      display: grid;
      grid-template-columns: 140px 1fr;
      gap: 8px;
      padding: 4px 0;
      font-size: 12.5px;
    }
    .fact-label {
      font-family: var(--mono);
      color: var(--ink-muted);
      font-size: 10.5px;
      letter-spacing: 0.1em;
      text-transform: uppercase;
    }
    .fact-value { color: var(--ink); }

    /* ---------- Badges ---------- */
    .badge {
      display: inline-block;
      padding: 3px 10px;
      font-family: var(--mono);
      font-size: 10px;
      letter-spacing: 0.15em;
      text-transform: uppercase;
      font-weight: 700;
      border: 1px solid;
    }
    .badge-locked {
      background: var(--ok-bg);
      color: var(--ok);
      border-color: var(--ok-edge);
    }
    .badge-unlocked {
      background: var(--warn-bg);
      color: var(--warn);
      border-color: var(--warn-edge);
    }

    /* ---------- Footer ---------- */
    .doc-footer {
      margin-top: 48px;
      padding-top: 24px;
      border-top: 2px solid var(--rule);
      font-family: var(--mono);
      font-size: 11px;
      letter-spacing: 0.08em;
      color: var(--ink-muted);
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 16px;
      flex-wrap: wrap;
    }
    .doc-footer a {
      color: var(--ink);
      text-decoration: none;
      font-weight: 700;
      letter-spacing: 0.12em;
      text-transform: uppercase;
    }
    .doc-footer a:hover { color: var(--accent); }

    /* ---------- Toast (copied confirmation) ---------- */
    .toast {
      position: fixed;
      bottom: 32px;
      left: 50%;
      transform: translateX(-50%) translateY(20px);
      background: var(--ink);
      color: var(--parchment);
      padding: 10px 22px;
      font-family: var(--mono);
      font-size: 12px;
      letter-spacing: 0.15em;
      text-transform: uppercase;
      border: 2px solid var(--ink);
      opacity: 0;
      pointer-events: none;
      transition: opacity 180ms ease, transform 180ms ease;
      z-index: 1000;
    }
    .toast.show {
      opacity: 1;
      transform: translateX(-50%) translateY(0);
    }

    /* ---------- Print ---------- */
    @media print {
      body {
        background: white;
        background-image: none;
        font-size: 11px;
      }
      .wrap { padding: 0; max-width: none; }
      .copy-btn { display: none; }
      .positions-grid { grid-template-columns: 1fr; }
      a { color: inherit; text-decoration: none; }
      .pool-section { page-break-inside: avoid; }
      .position-card { page-break-inside: avoid; }
      .doc-footer { page-break-inside: avoid; }
    }
  </style>
</head>
<body>
<div class="wrap">

  <!--
    Masthead — manuscript-style figure callout at the top of the page.
    Mirrors the makesometokens.com header strip pattern ("FIG. 1 · Solana
    Token Launcher · v1.0") so a team that's seen the marketing site
    immediately recognizes the document as part of the same family.
  -->
  <div class="masthead">
    <div class="masthead-left">
      <span class="masthead-brand">T R E B U C H E T</span>
      <span>FIG. 01 · Launch Dossier</span>
    </div>
    <div class="masthead-right">
      ${formatReportTimestamp(now)}
    </div>
  </div>

  <header class="title-block">
    ${logoBlock}
    <div>
      <p class="doc-fig">Token launch report · permanent record</p>
      <h1 class="doc-title">${safeName} <span class="doc-symbol">· ${safeSymbol}</span></h1>
      ${tokenDescription ? `<p class="doc-subtitle">${escapeHtml(tokenDescription)}</p>` : ''}
    </div>
  </header>

  ${demoBanner}
  ${statusBanner}

  <hr class="section-rule">
  <div class="enum-badge">[ 01 ] &nbsp; Token</div>
  <h2 class="section-title">Token specification</h2>

  <div class="token-summary-grid">
    <div class="token-stat">
      <div class="token-stat-label">Total supply</div>
      <div class="token-stat-value">${Number.isFinite(supply) && supply > 0 ? supply.toLocaleString() : '—'}</div>
    </div>
    <div class="token-stat">
      <div class="token-stat-label">Decimals</div>
      <div class="token-stat-value">${Number.isFinite(tokenInfo.decimals) ? tokenInfo.decimals : '—'}</div>
    </div>
    <div class="token-stat">
      <div class="token-stat-label">Launch market cap</div>
      <div class="token-stat-value">${Number.isFinite(targetMc) && targetMc > 0 ? '$' + targetMc.toLocaleString() : '—'}</div>
    </div>
    <div class="token-stat">
      <div class="token-stat-label">Pools</div>
      <div class="token-stat-value">${results.length}</div>
    </div>
  </div>

  <h3 class="subsection">Mint &amp; launch wallet</h3>
  ${renderAddressRow('Token mint', tokenInfo.mint)}
  ${tempWallet?.publicKey ? renderAddressRow('Launch wallet', tempWallet.publicKey) : ''}
  ${tokenInfo.metadataUri ? renderAddressRow('Metadata URI', tokenInfo.metadataUri) : ''}

  ${(tokenInfo.mintAuthorityRenounced || tokenInfo.freezeAuthorityDisabled || tokenInfo.metadataUpdateAuthorityRevoked) ? `
  <h3 class="subsection">Contract safety</h3>
  <!-- Authority-renunciation facts recorded at token creation. Each is
       independently verifiable on-chain: mint/freeze from the mint account
       (both authority options unset), metadata immutability from the
       Metaplex metadata account. Listed so auditors and listing reviewers
       know exactly what to check. -->
  ${renderFactRow('Mint authority', tokenInfo.mintAuthorityRenounced ? 'Renounced — supply is permanently capped' : 'NOT renounced')}
  ${renderFactRow('Freeze authority', tokenInfo.freezeAuthorityDisabled ? 'Disabled — holders can never be frozen' : 'NOT disabled')}
  ${renderFactRow('Metadata update authority', tokenInfo.metadataUpdateAuthorityRevoked ? 'Revoked — name/symbol/logo are permanent' : 'NOT revoked')}
  ${renderFactRow('Token program', 'SPL Token (classic) — no Token-2022 extensions')}
  ` : ''}

  <hr class="section-rule">
  <div class="enum-badge">[ 02 ] &nbsp; Tokenomics</div>
  <h2 class="section-title">Supply distribution</h2>

  <div class="tokenomics">
    <div>
      ${chartSvg}
      <div class="chart-caption">FIG. 02 · Token supply across pools &amp; positions</div>
    </div>
    <div>${breakdownHtml || '<p style="color:var(--ink-muted);">No positions configured.</p>'}</div>
  </div>

  <hr class="section-rule">
  <div class="enum-badge">[ 03 ] &nbsp; Pools &amp; Positions</div>
  <h2 class="section-title">Liquidity pool breakdown</h2>

  ${poolSections}

  ${buildAirdropReportSection()}

  <hr class="section-rule">
  <div class="enum-badge">[ 05 ] &nbsp; Verification</div>
  <h2 class="section-title">Auditing this launch</h2>
  <p style="font-size: 13px; color: var(--ink-muted, #6a4f2a);">
    Every claim in this report is verifiable on-chain. To audit the launch
    against the principles Trebuchet enforces:
  </p>
  <p style="font-size: 13px; color: var(--ink-muted, #6a4f2a);">
    <strong>Safe token contract</strong> — fetch the token mint account: the
    mint and freeze authority options must both be unset (renounced), and the
    Metaplex metadata account must show the update authority revoked. The
    mint must be owned by the classic SPL Token program (no Token-2022
    extensions such as transfer hooks or pausable supply).
  </p>
  <p style="font-size: 13px; color: var(--ink-muted, #6a4f2a);">
    <strong>Locked liquidity</strong> — each position above lists its lock
    transaction and Fee Key NFT. The lock (Raydium Burn &amp; Earn) moves the
    position NFT into the lock program's escrow and mints the Fee Key in its
    place; the on-chain locked-position account links the two. Locked
    liquidity can never be withdrawn — only its trading fees can be claimed,
    by whoever holds the Fee Key.
  </p>
  <p style="font-size: 13px; color: var(--ink-muted, #6a4f2a);">
    <strong>Concentrated LP shape</strong> — the tick ranges above define
    each position's price band; fetch each position account (via its NFT
    mint) to confirm the recorded bounds and liquidity.
  </p>
  <p style="font-size: 13px; color: var(--ink-muted, #6a4f2a);">
    <strong>Report authenticity</strong> — the permanent copy of this report
    is published to Arweave tagged with
    <code>Data-Protocol: trebuchet-launch-report</code> and
    <code>Mint: &lt;token mint&gt;</code>, uploaded and signed by the launch
    wallet — the same key that minted the token and created the pools. When
    querying Arweave for reports about a mint, ignore any item whose owner
    is not the mint's on-chain creator; only the creator-signed report is
    genuine.
  </p>

  <footer class="doc-footer">
    <div>
      <div>Trebuchet — launch Solana tokens, no middleman.</div>
      <div style="margin-top: 4px; text-transform: none; letter-spacing: 0.04em; font-size: 10px;">
        Solscan links use mainnet-beta. Tap any address or transaction signature to copy.
      </div>
    </div>
    <div>
      <a href="https://makesometokens.com/" target="_blank" rel="noopener">makesometokens.com</a>
    </div>
  </footer>

</div>

<div id="toast" class="toast" role="status" aria-live="polite">Copied</div>

<script>
  // Copy-button behavior. Single delegated listener on the body — simpler
  // than attaching one per button and survives any future re-renders
  // (though this is a static report, so re-renders don't happen).
  document.body.addEventListener('click', (e) => {
    const btn = e.target.closest('.copy-btn');
    if (!btn) return;
    const value = btn.dataset.copy;
    if (!value) return;

    const showCopied = () => {
      btn.classList.add('copied');
      const original = btn.textContent;
      btn.textContent = 'Copied';
      const toast = document.getElementById('toast');
      toast.classList.add('show');
      setTimeout(() => {
        btn.classList.remove('copied');
        btn.textContent = original;
        toast.classList.remove('show');
      }, 1400);
    };

    // Modern Clipboard API first; fall back to execCommand for older
    // browsers and odd security contexts (some local-file openings
    // disable the modern API).
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(value).then(showCopied).catch(() => {
        legacyCopy(value, showCopied);
      });
    } else {
      legacyCopy(value, showCopied);
    }
  });

  function legacyCopy(value, onSuccess) {
    const ta = document.createElement('textarea');
    ta.value = value;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      onSuccess();
    } catch (e) {
      console.error('Copy failed:', e);
    }
    document.body.removeChild(ta);
  }
</script>
</body>
</html>`;
}

// Read the user-selected token logo file as a data URL (base64-encoded
// with the correct MIME prefix). Used to embed the logo directly into
// the downloadable HTML report so the report is self-contained — the
// team can open it offline or forward it without breaking image refs.
// Returns null if no logo is selected or the read fails; the report
// gracefully falls back to a text-only header in that case.
async function readLogoAsDataUrl() {
  const logoEl = document.getElementById('tokenLogo');
  const file = logoEl?.files?.[0];
  if (!file) return null;
  return await new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
    reader.onerror = () => {
      // Don't surface this as an error log — the rest of the report is
      // perfectly usable without the logo. Quietly fall back.
      console.warn('Failed to read logo file for report embedding', reader.error);
      resolve(null);
    };
    reader.readAsDataURL(file);
  });
}

// Trigger a download of the HTML report. Filename includes the token
// symbol (sanitized) and a date stamp so multiple reports from the
// same machine don't collide. Reads the logo file first so we can
// embed it; falls back to text-only header on failure.
async function downloadLaunchReport() {
  if (!createdTokenInfo && (!lpResult || !lpResult.results || lpResult.results.length === 0)) {
    log('No launch results available yet — try again after pools are created.', 'warning');
    return;
  }
  try {
    const logoDataUrl = await readLogoAsDataUrl();
    const html = buildLaunchReportHtml({ logoDataUrl });
    const symbol = (document.getElementById('tokenSymbol')?.value.trim() || createdTokenInfo?.symbol || 'token')
      .replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 24) || 'token';
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const datePart = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
    const filename = `trebuchet-launch-${symbol}-${datePart}.html`;

    // Use a Blob + anchor click for the download. Works in Electron's
    // Chromium without main-process file-system plumbing.
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 100);
    log(`Launch report saved: ${filename}`, 'success');
  } catch (err) {
    // Catch-all: a thrown error from any step in the report-build/download
    // pipeline shouldn't leave the user with no feedback. Surface via the
    // activity log and console; the launch itself is unaffected since this
    // is post-launch reporting.
    console.error('Launch report generation failed:', err);
    log(`Failed to generate launch report: ${err.message || err}`, 'danger');
  }
}

bind('downloadReportBtnStep6', 'click', downloadLaunchReport);

// ===========================================================================
// Permanent launch report — publish to Arweave
// ===========================================================================
//
// After step 5 completes (all pools created, positions locked) we optionally
// publish the launch report to Arweave so anyone holding the token mint can
// find it — without anything being written onto the token's own metadata. Two
// artifacts go up: the rendered HTML (the same document the Download button
// produces) and a machine-readable JSON record. The SERVER signs both with the
// launch wallet, which is why this runs at step 5: that wallet is swept at
// step 6 and is gone by the time the success modal opens.
//
// Opt-out (userPrefs.publishLaunchReport) and any failure are handled by the
// server; this is fire-and-forget. The result is stashed in _publishedReport
// for the success modal's renderPublishedReportCard() to display.

function getPublishedReport() {
  return _publishedReport;
}

// Compact machine-readable launch record. Mirrors the data the HTML report
// shows but as structured JSON for querying/verification. Small (well under
// the Arweave free-tier limit) and never includes secrets.
function buildLaunchReportData(lp) {
  const results = (lp && Array.isArray(lp.results)) ? lp.results : [];

  // Map one position record into the audit shape. Every field here exists
  // to let a third party verify a Trebuchet launch principle on-chain:
  //   - tickLower/tickUpper prove the position's range (concentrated LP);
  //   - locked + the lock tx + feeKeyNftMint prove the Burn & Earn lock
  //     (the position NFT is escrowed by the lock program and the Fee Key
  //     NFT is minted in its place — the lock account on-chain links the
  //     two, so a verifier can confirm the liquidity can never be pulled);
  //   - recipient/transferredTo + the transfer tx prove where each fee
  //     stream went.
  // Older journals (pre-feeKeyNftMint / pre-tick-recording) yield nulls for
  // the missing fields rather than failing.
  const mapPosition = (pos, type, extra) => ({
    type,
    ...(extra || {}),
    tickLower: Number.isFinite(pos.tickLower) ? pos.tickLower : null,
    tickUpper: Number.isFinite(pos.tickUpper) ? pos.tickUpper : null,
    positionNftMint: pos.nftMint || null,
    feeKeyNftMint: pos.feeKeyNftMint || null,
    locked: pos.locked === true,
    openTx: pos.txIds?.open || null,
    lockTx: pos.txIds?.lock || null,
    transferTx: pos.txIds?.transfer || null,
  });

  return {
    // Version of this inner payload. The Arweave envelope's Schema-Version
    // tag (owned by launchReportService) describes the envelope; this field
    // tracks the launch payload itself. v1 was the original thin shape
    // (mint + pool ids); v2 adds the per-position audit records and the
    // token-safety facts.
    dataVersion: 2,
    launchWallet: tempWallet ? String(tempWallet.publicKey) : null,
    // Flat token identity fields kept from v1 for any reader already
    // consuming them; the structured facts live under token.
    mint: createdTokenInfo?.mint || null,
    name: createdTokenInfo?.name || null,
    symbol: createdTokenInfo?.symbol || null,
    decimals: createdTokenInfo?.decimals ?? null,
    totalSupply: createdTokenInfo?.totalSupply ?? null,
    supply: (() => {
      const allocated = results.reduce(
        (s, r) => s + (Number.isFinite(r.supplyPercent) ? r.supplyPercent : 0),
        0,
      );
      return {
        allocatedToPoolsPercent: Number(allocated.toFixed(4)),
        preallocationPercent: Number(Math.max(0, 100 - allocated).toFixed(4)),
      };
    })(),
    token: {
      mint: createdTokenInfo?.mint || null,
      // Trebuchet mints classic SPL tokens; recording the program id lets a
      // verifier confirm there are no Token-2022 extensions (transfer
      // hooks, pausable, etc.) without guessing.
      tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      metadataUri: createdTokenInfo?.metadataUri || null,
      // Safety facts recorded at creation time. Each is independently
      // verifiable on-chain: mint/freeze authority from the mint account
      // (both authority options must be unset), metadata mutability from
      // the Metaplex metadata account (isMutable false, update authority
      // revoked). A verifier should treat the on-chain state as truth and
      // these flags as the launch's claim.
      authorities: {
        mintAuthorityRenounced: createdTokenInfo?.mintAuthorityRenounced === true,
        freezeAuthorityDisabled: createdTokenInfo?.freezeAuthorityDisabled === true,
        metadataUpdateAuthorityRevoked: createdTokenInfo?.metadataUpdateAuthorityRevoked === true,
        metadataImmutable: createdTokenInfo?.metadataImmutable === true,
      },
    },
    pools: results.map((r) => ({
      poolId: r.poolId || null,
      quote: r.quoteSymbol || null,
      quoteMint: r.quoteAddress || null,
      supplyPercent: Number.isFinite(r.supplyPercent) ? r.supplyPercent : null,
      launchedSide: r.launchedSide || null,
      // Pool parameters: tickSpacing identifies the CLMM fee-tier config
      // the pool was created with; initialPrice is the launch price (in
      // quote per launched token) the pool opened at.
      tickSpacing: Number.isFinite(r.tickSpacing) ? r.tickSpacing : null,
      initialPrice: r.initialPrice || null,
      createPoolTx: r.txIds?.createPool || null,
      positions: [
        ...(r.mainPositions || []).map((p) => mapPosition(p, 'main', {
          sliceIndex: p.sliceIndex ?? null,
          sharePercent: Number.isFinite(p.sharePercent) ? p.sharePercent : null,
          recipient: p.recipient || null,
          transferredTo: p.transferredTo || null,
        })),
        ...(r.ladderPositions || []).map((p) => mapPosition(p, 'ladder', {
          bandIndex: p.bandIndex ?? null,
        })),
        ...(r.supportPositions || []).map((p) => mapPosition(p, 'support', {
          depthPct: Number.isFinite(p.depthPct) ? p.depthPct : null,
          quoteRaw: p.quoteRaw || null,
        })),
        ...(r.bootstrap ? [mapPosition(r.bootstrap, 'bootstrap')] : []),
      ],
    })),
  };
}

// Kick off (or retry) the Arweave publish. Reads shared launch state
// (createdTokenInfo, lpResult, tempWallet). Never throws; updates
// _publishedReport and refreshes the success-modal card if it's open.
// Is launch-report publishing currently enabled? Reads the in-context step-5
// toggle if present, else the Settings toggle; both reflect the same pref.
// Defaults to on if neither is in the DOM yet.
function isLaunchReportEnabled() {
  const t = document.getElementById('configPublishReportToggle')
    || document.getElementById('lpPublishReportToggle')
    || document.getElementById('publishReportToggle');
  return t ? t.checked : true;
}

// Step-5 status line (#lpReportStatus, under the Create Pools button). Shows an
// idle hint before completion, then live publish status. Kept in sync with the
// success-modal card by refreshLaunchReportUi().
function renderLaunchReportStep5Status() {
  const el = document.getElementById('lpReportStatus');
  if (!el) return;
  el.innerHTML = '';
  const rep = _publishedReport;

  if (!rep) {
    el.textContent = isLaunchReportEnabled()
      ? 'A permanent launch report will be published to Arweave when this launch completes.'
      : 'Launch report publishing is off — your launch stays private.';
    return;
  }
  if (rep.status === 'skipped') {
    el.textContent = 'Launch report publishing is off — your launch stays private.';
    return;
  }
  if (rep.status === 'pending') {
    el.textContent = 'Publishing the permanent launch report to Arweave…';
    return;
  }
  if (rep.status === 'done') {
    el.append('Permanent launch report published — ');
    const a = document.createElement('a');
    a.href = rep.htmlUri || rep.jsonUri || '#';
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = 'view on Arweave';
    el.append(a);
    return;
  }
  // failed
  el.append('Couldn’t publish the launch report. ');
  const retry = document.createElement('a');
  retry.href = '#';
  retry.textContent = 'Retry';
  retry.addEventListener('click', (e) => { e.preventDefault(); publishLaunchReportToArweave(); });
  el.append(retry);
  el.append(' — the launch itself is unaffected.');
}

// Refresh every launch-report surface from the current _publishedReport state:
// the step-5 status line and the success-modal card. Each renderer no-ops if
// its DOM isn't present, so this is safe to call any time.
function refreshLaunchReportUi() {
  try { renderLaunchReportStep5Status(); } catch (e) { console.warn('step-5 report status render failed', e); }
  try { renderPublishedReportCard(); } catch (e) { /* modal may not be open */ }
}

async function publishLaunchReportToArweave(lp) {
  const data = lp || lpResult;
  const mint = createdTokenInfo?.mint;
  if (!mint) return; // nothing to key discovery off — skip silently

  // Idempotency: skip if a publish is already in flight or has succeeded, so a
  // second completion trigger can't double-publish. A FAILED publish can still
  // be retried — status would be 'failed' here, which isn't caught.
  if (_publishedReport && (_publishedReport.status === 'pending' || _publishedReport.status === 'done')) {
    return;
  }
  // Opt-out: respect the launch-report toggle (same pref as Settings). When
  // off, record a 'skipped' state and don't publish.
  if (!isLaunchReportEnabled()) {
    _publishedReport = { status: 'skipped', reason: 'opted-out' };
    refreshLaunchReportUi();
    return;
  }
  _publishedReport = { status: 'pending' };
  refreshLaunchReportUi();

  try {
    const reportHtml = await _getReportHtml();
    const launchData = buildLaunchReportData(data);
    const poolIds = launchData.pools.map((p) => p.poolId).filter(Boolean);

    const resp = await fetch('/api/publish-launch-report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        walletPublicKey: tempWallet ? String(tempWallet.publicKey) : undefined,
        mint,
        poolIds,
        reportHtml,
        launchData,
      }),
    });
    const out = await resp.json();

    if (out && out.skipped) {
      _publishedReport = { status: 'skipped', reason: out.reason };
    } else if (out && out.failed) {
      _publishedReport = { status: 'failed', error: out.error };
      log(`Launch report publish failed: ${out.error || 'unknown error'}`, 'warning');
    } else if (out && out.success) {
      _publishedReport = { status: 'done', jsonUri: out.jsonUri, htmlUri: out.htmlUri };
      log('Permanent launch report published to Arweave', 'success');
    } else {
      _publishedReport = { status: 'failed', error: 'unexpected response' };
    }
  } catch (err) {
    _publishedReport = { status: 'failed', error: err?.message || String(err) };
    console.error('publishLaunchReportToArweave failed:', err);
  }

  refreshLaunchReportUi();
}

// ===========================================================================
// Inline Launch Report Preview
// ===========================================================================
//
// Renders the launch report HTML inline in a sandboxed iframe so the user
// can inspect addresses, pool IDs, and TX signatures before the final sweep
// (step 5) or after transfer (step 6 / success modal). Collapsed by default;
// the toggle button expands it. The download button remains the primary action.

// Memoized report HTML — build once per launch, reuse across all three
// containers. Reset by the lpDoneInfo/transferResult hide paths.
let _cachedReportHtml = null;
// Result of the Arweave publish kicked off during step 6's transfer flow,
// after the airdrop and before the sweep (see publishLaunchReportToArweave
// and runTransfer's step 6b). Shape:
//   { status: 'pending' | 'done' | 'failed' | 'skipped', jsonUri?, htmlUri?, error?, reason? }
// Read by the success modal's renderPublishedReportCard(). null = not started.
// Reset per-launch at the start of an LP run (see lp-execution.js), NOT here.
// _resetCachedReport() runs mid-transfer to rebuild the HTML with airdrop
// results — wiping the published record there would erase the step-5 publish
// before the success modal can show it.
let _publishedReport = null;
function _resetCachedReport() {
  _cachedReportHtml = null;
  // Also clear every preview iframe's srcdoc. renderLaunchReportPreview
  // only sets srcdoc when it's empty (so the iframe doesn't reload on
  // every step transition); without this, a preview iframe that was
  // already shown keeps its OLD HTML even after the cache is rebuilt
  // with fresh data. Most visible failure: step 5's preview was rendered
  // before the airdrop step ran, so it has airdrop-less HTML; without
  // clearing the iframe srcdoc, even reaching step 6 and rebuilding the
  // cache leaves step 5 stuck on the old report.
  for (const prefix of ['step5', 'step6', 'modal']) {
    const iframe = document.getElementById(prefix + 'ReportIframe');
    if (iframe && iframe.srcdoc) iframe.srcdoc = '';
  }
}

// Build (or retrieve cached) report HTML document string.
async function _getReportHtml() {
  if (_cachedReportHtml) return _cachedReportHtml;
  try {
    const logoSrc = (createdTokenInfo && createdTokenInfo.imageUri)
      ? createdTokenInfo.imageUri
      : await readLogoAsDataUrl();
    _cachedReportHtml = buildLaunchReportHtml({ logoDataUrl: logoSrc });
  } catch (e) {
    console.error('Failed to build report HTML for preview:', e);
    _cachedReportHtml = '<html><body><p>Failed to generate preview.</p></body></html>';
  }
  return _cachedReportHtml;
}

// Render the launch report preview for a given container prefix.
//   prefix: 'step5', 'step6', or 'modal'
async function renderLaunchReportPreview(prefix) {
  const container = document.getElementById(prefix + 'ReportPreview');
  const toggleBtn = document.getElementById(prefix + 'ReportToggle');
  const body = container?.querySelector('.launch-report-preview-body');
  const iframe = document.getElementById(prefix + 'ReportIframe');
  const copyAddrsBtn = document.getElementById(prefix + 'CopyAllAddrs');
  const copyTxsBtn = document.getElementById(prefix + 'CopyAllTxs');

  if (!container || !toggleBtn || !body || !iframe) return;

  // Reveal the preview container AND the toggle button. The step-6 and
  // modal toggles are standalone buttons outside the container (next to /
  // above it), initially hidden because the report doesn't exist until the
  // launch reaches this point; for step 5 the un-hide is a no-op since that
  // toggle lives in the action row shown by setLpDoneVisible().
  container.classList.remove('hidden');
  toggleBtn.classList.remove('hidden');

  // Load the report into the iframe (only if not already loaded)
  if (!iframe.srcdoc) {
    const html = await _getReportHtml();
    iframe.srcdoc = html;
  }

  // ---- Toggle expand/collapse ----
  // _wired guards against re-attaching listeners on repeated calls to
  // renderLaunchReportPreview (e.g. the initial LP success + the resume
  // path both call it). Safe because this codebase uses static HTML —
  // no virtual DOM that would replace the element and lose the flag.
  toggleBtn._wired = toggleBtn._wired || false;
  if (!toggleBtn._wired) {
    toggleBtn._wired = true;
    toggleBtn.addEventListener('click', () => {
      const expanded = !body.classList.contains('hidden');
      if (expanded) {
        body.classList.add('hidden');
        toggleBtn.classList.remove('is-expanded');
        toggleBtn.querySelector('span:last-child').textContent = 'Show launch report preview';
      } else {
        body.classList.remove('hidden');
        toggleBtn.classList.add('is-expanded');
        toggleBtn.querySelector('span:last-child').textContent = 'Hide launch report preview';
        iframe.style.height = Math.max(400, Math.min(window.innerHeight * 0.6, 700)) + 'px';
      }
    });
  }

  // ---- Bulk-copy: all addresses ----
  if (copyAddrsBtn && !copyAddrsBtn._wired) {
    copyAddrsBtn._wired = true;
    copyAddrsBtn.addEventListener('click', () => {
      _copyFromIframe(iframe, 'addrs');
    });
  }

  // ---- Bulk-copy: all TX signatures ----
  if (copyTxsBtn && !copyTxsBtn._wired) {
    copyTxsBtn._wired = true;
    copyTxsBtn.addEventListener('click', () => {
      _copyFromIframe(iframe, 'txs');
    });
  }
}

// Extract addresses or TX signatures from the iframe's rendered DOM.
function _copyFromIframe(iframe, mode) {
  try {
    const doc = iframe.contentDocument || iframe.contentWindow?.document;
    if (!doc) {
      log('Cannot access report preview — the iframe may not be loaded yet.', 'warning');
      return;
    }

    const codes = doc.querySelectorAll('code.addr-value');
    const values = [];
    const ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

    codes.forEach((code) => {
      const text = code.textContent.trim();
      if (!text || text === '\u2014') return;

      const row = code.closest('.addr-row');
      const label = row ? row.querySelector('.addr-label') : null;
      const labelText = label ? label.textContent.trim().toUpperCase() : '';

      const isTx = labelText.includes('TX');
      const isAddr = !isTx && ADDR_RE.test(text);

      if (mode === 'txs' && isTx && text.length >= 85) {
        values.push(text);
      } else if (mode === 'addrs' && isAddr) {
        values.push(text);
      }
    });

    if (values.length === 0) {
      log('No ' + (mode === 'txs' ? 'TX signatures' : 'addresses') + ' found in report.', 'warning');
      return;
    }

    const joined = values.join('\n');
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(joined).then(() => {
        log('Copied ' + values.length + ' ' + (mode === 'txs' ? 'TX signature(s)' : 'address(es)') + ' to clipboard.', 'success');
      }).catch(() => {
        _legacyCopyReport(joined, values.length, mode);
      });
    } else {
      _legacyCopyReport(joined, values.length, mode);
    }
  } catch (e) {
    console.error('Bulk copy failed:', e);
    log('Failed to copy from report preview.', 'danger');
  }
}

function _legacyCopyReport(text, count, mode) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
    log('Copied ' + count + ' ' + (mode === 'txs' ? 'TX signature(s)' : 'address(es)') + ' to clipboard.', 'success');
  } catch (e) {
    log('Copy to clipboard failed — try selecting and copying manually.', 'warning');
  }
  document.body.removeChild(ta);
}




// ===========================================================================
// Launch Success Modal
// ---------------------------------------------------------------------------
// Pops automatically after a successful step-6 transfer (the only place
// runTransfer() considers the launch "fully done"). Shows the live 3D
// coin, the token identity, a short summary of what was created, and
// a list of next-step actions: download the launch report, submit to
// Jupiter VRFD, request a CoinGecko listing, update DexScreener
// Enhanced Info, set up a community.
//
// Coin lifecycle:
//   - coinRenderer is a page-wide singleton (one WebGL context at a time),
//     and the token preview card it lives in TRAVELS with the active step
//     (steps 2-6, see relocateTokenPreview). So when this modal opens at
//     the end of step 6, the renderer is typically ALIVE and owned by the
//     step-6 preview card — the modal borrows it.
//   - showLaunchSuccessModal() destroys the live context (one context at a
//     time) and init()s on the modal's own mount, then setFaces() with the
//     user's logo (data URL) and the largest pool's quote-token logo. Same
//     data-URL trick the launch report uses, so we don't need a CORS proxy
//     for the front face; the back face goes through /api/proxy-image
//     (via proxiedImageUrl) like the step-2 preview does.
//   - hideLaunchSuccessModal() destroys the modal's context AND HANDS THE
//     COIN BACK to the step preview card via renderTokenPreview() — the
//     card is still on screen behind the modal, and without the hand-back
//     its coin stays gone after dismissal.
// ===========================================================================

// Show the launch success modal. Populates token identity, the summary
// line, and (re)initialises the 3D coin in the modal's mount.
// Reflect the permanent-report publish state in the success modal. The publish
// is kicked off during step 6, between airdrop and sweep
// (publishLaunchReportToArweave), and may still be in
// flight when this modal opens, so this is called on open and again when the
// publish settles. Reads getPublishedReport() from launch-report.js.
function renderPublishedReportCard() {
  const el = document.getElementById('launchSuccessReportLink');
  if (!el) return;
  const title = document.getElementById('launchSuccessReportLinkTitle');
  const desc = document.getElementById('launchSuccessReportLinkDesc');
  const icon = document.getElementById('launchSuccessReportLinkIcon');
  const rep = (typeof getPublishedReport === 'function') ? getPublishedReport() : null;

  // Hidden when publishing is off, was skipped, or hasn't started.
  if (!rep || rep.status === 'skipped') {
    el.classList.add('hidden');
    el.onclick = null;
    return;
  }
  el.classList.remove('hidden');

  if (rep.status === 'pending') {
    if (icon) icon.className = 'fas fa-spinner fa-spin';
    if (title) title.textContent = 'Publishing permanent report…';
    if (desc) desc.textContent = 'Writing a permanent copy to Arweave — this finishes on its own.';
    el.disabled = true;
    el.onclick = null;
  } else if (rep.status === 'done') {
    if (icon) icon.className = 'fas fa-globe';
    if (title) title.textContent = 'View the permanent report (Arweave)';
    if (desc) desc.textContent = 'A permanent, public copy of this launch, findable from the token address.';
    el.disabled = false;
    el.onclick = () => {
      try { window.open(rep.htmlUri || rep.jsonUri, '_blank', 'noopener,noreferrer'); }
      catch (err) { console.warn('Failed to open report URL:', err); }
    };
  } else {
    if (icon) icon.className = 'fas fa-rotate-right';
    if (title) title.textContent = "Report didn't publish — retry";
    if (desc) desc.textContent = 'Publishing to Arweave failed. The launch itself is unaffected; you can try again.';
    el.disabled = false;
    el.onclick = () => {
      if (typeof publishLaunchReportToArweave === 'function') publishLaunchReportToArweave();
    };
  }
}

async function showLaunchSuccessModal() {
  const modal = document.getElementById('launchSuccessModal');
  if (!modal) return;

  // ---- Lazy-wire close handlers on first open ----
  // The launch-success modal markup lives later in index.html than the
  // <script src="app.js"> tag, so any bind() called at module load gets
  // null from getElementById and silently warns "Element not found" —
  // the X, Done, backdrop-click, and Esc paths would all fail to close
  // the modal. Same lazy-init pattern showTokenomicsModal() uses (see
  // the comment around line ~9970). Guarded by a dataset flag so a
  // re-open from the step-6 "View launch summary" button doesn't stack
  // duplicate listeners.
  if (!modal.dataset.closeHandlersWired) {
    const closeBtn = document.getElementById('launchSuccessCloseBtn');
    if (closeBtn) closeBtn.addEventListener('click', hideLaunchSuccessModal);
    const doneBtn = document.getElementById('launchSuccessDoneBtn');
    if (doneBtn) doneBtn.addEventListener('click', hideLaunchSuccessModal);
    const bg = modal.querySelector('.modal-background');
    if (bg) bg.addEventListener('click', hideLaunchSuccessModal);
    // External-action delegation (Jupiter / CoinGecko / DexScreener /
    // CoinCommunities buttons). Same reason this needs to be lazy:
    // the .launch-success-actions container also lives after the
    // script tag.
    const actions = modal.querySelector('.launch-success-actions');
    if (actions) {
      actions.addEventListener('click', (e) => {
        const btn = e.target.closest('.launch-success-action[data-action="external"]');
        if (!btn) return;
        const url = btn.getAttribute('data-url');
        if (!url) return;
        try {
          window.open(url, '_blank', 'noopener,noreferrer');
        } catch (err) {
          console.warn('Failed to open external URL:', url, err);
          log(`Could not open ${url} — please copy and open it manually.`, 'warning');
        }
      });
    }
    // Download-report button. Doesn't close the modal — user may want
    // to click multiple actions in one sitting.
    const reportBtn = document.getElementById('launchSuccessReportBtn');
    if (reportBtn) reportBtn.addEventListener('click', () => downloadLaunchReport());
    modal.dataset.closeHandlersWired = 'true';
  }

  // Reflect the permanent-report publish state (kicked off at step 5). Safe to
  // call on every open; re-invoked by publishLaunchReportToArweave when the
  // async publish settles.
  renderPublishedReportCard();

  // ---- Populate identity & summary ----
  // Prefer the resolved on-chain info (createdTokenInfo, set by
  // createToken), fall back to the live form values for any field
  // that's missing — should never happen by step 6, but the safety
  // net costs nothing.
  const tokenInfo = createdTokenInfo || {};
  const symbol = tokenInfo.symbol
    || document.getElementById('tokenSymbol')?.value.trim()
    || '?';
  const name = tokenInfo.name
    || document.getElementById('tokenName')?.value.trim()
    || '';
  const mint = tokenInfo.mint || '';

  document.getElementById('launchSuccessSymbol').textContent = symbol;
  // Only show the "$SYMBOL · Name" suffix when name differs from symbol
  // (many memecoin launches have symbol === name; doubling it reads as
  // a typo).
  const nameWrap = document.getElementById('launchSuccessNameWrap');
  if (name && name !== symbol) {
    document.getElementById('launchSuccessName').textContent = name;
    nameWrap.classList.remove('hidden');
  } else {
    nameWrap.classList.add('hidden');
  }
  document.getElementById('launchSuccessMint').textContent = mint
    ? mint
    : '(mint address not available)';

  // Coin fallback letter — shown if WebGL is unavailable or the renderer
  // fails to come up. Uses the same single-letter trick as the step-2
  // preview's flat fallback.
  const initial = (symbol.charAt(0) || name.charAt(0) || '?').toUpperCase();
  const fallback = document.getElementById('launchSuccessCoinFallback');
  if (fallback) fallback.textContent = initial;

  // Summary line: pool count, locked-position count, transferred Fee
  // Keys. Computed from lpResult exactly like the launch report does
  // so the two stay consistent.
  const results = (lpResult && Array.isArray(lpResult.results)) ? lpResult.results : [];
  const summary = (typeof computeLockSummary === 'function')
    ? computeLockSummary(results)
    : { total: 0, locked: 0, totalRecipient: 0, transferred: 0, allLocked: false };
  const poolCount = results.length;
  const summaryParts = [
    `${poolCount} pool${poolCount === 1 ? '' : 's'} created`,
  ];
  if (summary.total > 0) {
    summaryParts.push(`${summary.locked} / ${summary.total} positions locked`);
  }
  if (summary.totalRecipient > 0) {
    summaryParts.push(`${summary.transferred} / ${summary.totalRecipient} Fee Key NFTs delivered`);
  }
  document.getElementById('launchSuccessSummary').textContent =
    summaryParts.join(' · ') + '. Liquidity is live; the launch is committed on-chain.';

  // ---- Activate the modal ----
  // Add is-active first so the mount has dimensions before the coin
  // renderer attaches (ResizeObserver in coinRenderer reads the mount's
  // computed size on init; a 0×0 mount would size the canvas to nothing).
  modal.classList.add('is-active');

  // ---- Spin up the 3D coin in the modal ----
  // Read the uploaded logo as a data URL so the renderer doesn't need
  // CORS proxying for the front face. Falls back to null if the user
  // didn't upload one or the read fails — setFaces handles a null URL
  // by leaving the front blank.
  let frontUrl = null;
  try {
    frontUrl = await readLogoAsDataUrl();
  } catch (e) {
    console.warn('Launch success modal: failed to read logo for coin:', e);
  }

  // The user may have dismissed the modal during the await above (clicked
  // close before the logo finished reading, hit Esc, or clicked the
  // backdrop). hideLaunchSuccessModal already ran in that case but found
  // no live coin to tear down — if we proceed here we'd init a WebGL
  // context inside a now-hidden modal, leaking it until the modal is
  // reopened or the page reloaded. Bailing keeps the coin lifecycle
  // honest: it only ever runs while the modal is actually visible.
  if (!modal.classList.contains('is-active')) return;

  if (typeof coinCanRun === 'function' && coinCanRun()) {
    const mount = document.getElementById('launchSuccessCoin');
    if (mount) {
      try {
        // Destroy any prior coin context first — one WebGL context at a
        // time. This is normally the step-6 preview card's LIVE coin
        // (the travelling preview card owns the renderer through steps
        // 2-6); on a re-open via "View launch summary" it's the modal's
        // own coin from the previous open. Either way init() needs the
        // singleton free. hideLaunchSuccessModal gives the coin back to
        // the preview card on close.
        if (window.coinRenderer.isActive()) {
          window.coinRenderer.destroy();
        }
        window.coinRenderer.init(mount);
        mount.classList.add('coin-live');

        // Back face: largest pool's quote-token logo, computed the same
        // way the step-2 preview does (coinBackSource → largestPool).
        const back = (typeof coinBackSource === 'function')
          ? coinBackSource()
          : { url: null, symbol: 'SOL' };

        if (back.url) {
          window.coinRenderer.setFaces(frontUrl || null, back.url, back.symbol);
        } else {
          // No back-face logo URL available — emboss the symbol text.
          // (Happens when the only pool is SOL with the default fallback
          // and resolvedImageUrl was never set, or when proxiedImageUrl
          // returns null for a non-http source.)
          window.coinRenderer.setFaces(frontUrl || null, null, back.symbol);
        }
      } catch (e) {
        // Surface to the console only — the modal still shows the
        // fallback letter, so the user isn't blocked. The launch is
        // already complete; this is pure decoration.
        console.warn('Launch success modal: failed to start 3D coin:', e);
      }
    }
  }

  // Populate the inline launch report preview inside the modal.
  renderLaunchReportPreview('modal');
}

// Hide the launch success modal and free the coin's WebGL context. Safe
// to call when the modal is already closed (no-op in that case).
function hideLaunchSuccessModal() {
  const modal = document.getElementById('launchSuccessModal');
  if (!modal) return;
  modal.classList.remove('is-active');

  // Tear down the coin. Browsers cap live WebGL contexts, so leaving
  // one alive in a hidden modal is bad citizenship. The renderer is a
  // page-wide singleton; destroying it here is safe because nothing
  // else owns it at this point in the flow (step 2's coin was already
  // destroyed when the user moved past step 2).
  try {
    if (typeof window.coinRenderer !== 'undefined' &&
        window.coinRenderer.isActive()) {
      window.coinRenderer.destroy();
    }
  } catch (e) {
    console.warn('Launch success modal: failed to tear down coin:', e);
  }

  // Drop the coin-live marker so the flat fallback shows if the modal
  // is reopened before the coin reinits (briefly visible during the
  // async showLaunchSuccessModal flow on re-open).
  const mount = document.getElementById('launchSuccessCoin');
  if (mount) mount.classList.remove('coin-live');

  // Hand the coin back to the step preview card. The modal borrowed the
  // singleton renderer from the travelling preview card (visible behind
  // the modal on step 6); without this the card's coin area stays empty
  // after dismissal — its mount still carries coin-live (hiding the flat
  // fallback) but holds no canvas. renderTokenPreview() re-renders the
  // card and its updateCoinPreview() call re-init()s the renderer into
  // the card's mount, exactly like a step relocation does. Guarded: on
  // any path where the preview card isn't rendered (coinCanRun false,
  // mount missing), updateCoinPreview is a safe no-op.
  if (typeof renderTokenPreview === 'function') {
    try {
      renderTokenPreview();
    } catch (e) {
      console.warn('Launch success modal: failed to restore preview coin:', e);
    }
  }
}

// ---- Modal close handlers wired lazily in showLaunchSuccessModal() ----
// The X button, Done button, backdrop click, report-download button, and
// external-action delegation are all wired on first open inside
// showLaunchSuccessModal rather than at module load. The reason is in the
// comment at the top of that function: the modal markup lives later in
// index.html than the <script src="app.js"> tag, so a top-level bind()
// would silently fail. Same pattern showTokenomicsModal() uses.

// Esc-to-close. This one CAN live at top level because the listener is
// attached to `document` (always exists at script parse time) and the
// modal lookup happens at runtime each time Esc is pressed. Separate
// from the EXTRA_CLOSE_MODAL_IDS list further down because that list's
// generic close just removes is-active — it doesn't tear down the coin.
// Adding our own keydown listener keeps the coin lifecycle correct
// regardless of how the modal is dismissed. Idempotency:
// hideLaunchSuccessModal is safe to call when already closed.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const modal = document.getElementById('launchSuccessModal');
  if (modal && modal.classList.contains('is-active')) {
    hideLaunchSuccessModal();
  }
});

// Re-open from the step-6 "View launch summary" button. Same path as
// the auto-open after a successful transfer — re-runs showLaunchSuccessModal,
// which re-inits the coin in the modal's mount. The button itself is
// only revealed (via classList.remove('hidden') in runTransfer) after
// a successful transfer, so clicking before then is impossible.
bind('viewLaunchSummaryBtn', 'click', () => {
  showLaunchSuccessModal();
});

function buildAllocationsForApi() {
  return pools.map((p) => {
    // Pass our resolved price through to the server as quoteUsdOverride.
    //
    // Per the price-safety plan (Milestones A + B), this no longer means
    // "skip server-side price lookup" the way it used to. The server
    // ALWAYS runs a fresh just-in-time Raydium swap probe at pool-create
    // time for non-SOL quotes. What it does with the override:
    //
    //   1. Treats it as the drift-guard reference. After the probe runs,
    //      it compares the probe value against this override. If they
    //      differ by more than the configured threshold (default 25%),
    //      it aborts the launch with a pre_flight error telling the user
    //      to refresh the funding estimate.
    //
    //   2. For SOL pools, the override is checked against the live
    //      SOL/USD oracle reading the same way. SOL rarely drifts that
    //      much in a normal funding-to-create window, but the guard is
    //      symmetric.
    //
    // What value to send: whatever the user committed to at funding time.
    // The funding-estimate response (Milestone B) propagates its
    // resolvedPrices back into pool.resolvedPriceUsd, so by the time the
    // user clicks "Create Pools" the resolvedPriceUsd holds the canonical
    // funding-estimate price. That's the price the launch math sized
    // against; that's the right drift reference.
    //
    // If the user typed an explicit override in customize mode, that
    // wins — the user is opting into a price they chose deliberately,
    // and the drift guard checks the live probe against THEIR number.
    const effectiveUsdOverride =
      p.quoteUsdOverride != null
        ? p.quoteUsdOverride
        : (p.resolvedPriceUsd != null ? Number(p.resolvedPriceUsd) : null);
    // Symbol-override resolution priority:
    //   1. User-typed override in customize mode (explicit user intent)
    //   2. Resolved symbol from tokenInfoService (GeckoTerminal / Jupiter
    //      / DexScreener) — usually present for liquid tokens
    //   3. Flywheel label — bespoke flywheel tokens may not be in price
    //      APIs yet; the label ("Reserve" / "Meme" / etc.) is a much
    //      better display string than the first 6 chars of the mint
    //   4. null — server falls back to mint.slice(0,6), which is the
    //      "we genuinely don't know" surface for arbitrary tokens
    let effectiveSymbolOverride;
    if (p.quoteSymbolOverride != null && p.quoteSymbolOverride !== '') {
      effectiveSymbolOverride = p.quoteSymbolOverride;
    } else if (p.resolvedSymbol) {
      effectiveSymbolOverride = p.resolvedSymbol;
    } else {
      const fw = Object.values(FLYWHEELS).find((f) => f.mint === p.quoteToken);
      effectiveSymbolOverride = fw ? fw.label : null;
    }
    const effectiveDecimalsOverride =
      p.quoteDecimalsOverride != null
        ? p.quoteDecimalsOverride
        : (p.resolvedDecimals != null ? Number(p.resolvedDecimals) : null);

    // Unified "% of pool" semantics in the UI: bootstrap.supplyPercent,
    // ladder band.supplyPercent, and slice.sharePercent all express
    // each position's fraction of THIS pool's allocation. They sum to
    // 100% (validated). Backend wire format uses different denominators
    // (bootstrap = % of total; ladder band = % of main; slice = % of
    // wide), so we convert here.
    const uiBsPct = (p.bootstrapConfig && p.bootstrapConfig.mode === 'custom')
      ? Number(p.bootstrapConfig.supplyPercent) || 0
      : 0;
    const ldCfg = p.ladderConfig || { mode: 'off', bands: [] };
    const uiBandPcts = (ldCfg.mode === 'manual' && Array.isArray(ldCfg.bands))
      ? ldCfg.bands.map((b) => Number(b.supplyPercent) || 0)
      : [];

    // Wire bootstrap.supplyPercent is % of TOTAL token supply. With
    // pool at X% of total and bs at Y% of pool, bs of total = X × Y / 100.
    const bootstrap = uiBsPct > 0
      ? { mode: 'custom', supplyPercent: uiBsPct * Number(p.supplyPercent) / 100 }
      : { mode: 'minimal' };

    // Wire ladder band.supplyPercent is % of MAIN (pool − bootstrap).
    // Main fraction of pool = (1 − bs/100). So wire_band_pct = ui /
    // (1 − bs/100). Clamp the divisor to avoid divide-by-zero when bs
    // is 100% (edge case: user gave the entire pool to bootstrap).
    let ladder;
    if (uiBandPcts.length > 0) {
      const mainFraction = Math.max(0.0001, 1 - uiBsPct / 100);
      ladder = {
        mode: 'manual',
        bands: ldCfg.bands.map((b) => ({
          supplyPercent: Number(b.supplyPercent) / mainFraction,
          lowerMultiplier: Number(b.lowerMultiplier),
          upperMultiplier: Number(b.upperMultiplier),
        })),
      };
    } else {
      ladder = { mode: 'off' };
    }

    // Wire distribution[].sharePercent is share of WIDE (slices among
    // themselves sum to 100). UI slice sharePercent is % of pool;
    // normalize within the slices array.
    //
    // Filter out 0% slices first — they contribute nothing to the wide
    // bucket, would normalize to 0 on the wire, and the backend's
    // normalizeDistribution() rejects sharePercent <= 0. Dropping them
    // is a no-op since they don't represent any liquidity allocation.
    // If filtering leaves the array empty (everything is in bs + bands,
    // wide is 0), we send a single placeholder 100% slice; the backend's
    // wide loop is skipped when wideBaseRaw = 0, so the value is unused.
    const nonZeroSlices = p.distribution.filter((s) => (Number(s.sharePercent) || 0) > 0);
    const totalSliceUi = nonZeroSlices.reduce((s, x) => s + (Number(x.sharePercent) || 0), 0);
    let distribution;
    if (totalSliceUi > 0) {
      distribution = nonZeroSlices.map((s) => ({
        sharePercent: (Number(s.sharePercent) || 0) / totalSliceUi * 100,
        recipient: s.useExternalRecipient ? s.recipient : null,
      }));
    } else {
      distribution = [{ sharePercent: 100, recipient: null }];
    }

    // Wire support config: { mode: 'off' } or { mode: 'custom', solValue, depthPct }.
    // The solValue is the user's canonical input in SOL; the orchestrator
    // converts to USD-equivalent raw quote units at LP-creation time
    // using the live SOL price. depthPct controls how far below launch
    // the position covers (range [1, 50], default 10). Support is
    // quote-only — no supplyPercent conversion needed since it doesn't
    // carve from token supply.
    const supportCfg = p.supportConfig || { mode: 'off' };
    const support = (supportCfg.mode === 'custom' && Number(supportCfg.solValue) > 0)
      ? {
          mode: 'custom',
          solValue: Number(supportCfg.solValue),
          // Clamp at wire-time so a transient out-of-range UI value (e.g.
          // mid-keystroke typing) never gets sent to pre-flight. Pre-flight
          // validates again with the same bounds; clamping here gives a
          // cleaner UX (user doesn't see "invalid depthPct" errors from
          // a value the UI will eventually correct on blur).
          depthPct: clampSupportDepth(supportCfg.depthPct),
        }
      : { mode: 'off' };

    return {
      quoteToken: p.quoteToken,
      supplyPercent: p.supplyPercent,
      ammConfigIndex: p.ammConfigIndex,
      quoteUsdOverride: effectiveUsdOverride,
      quoteDecimalsOverride: effectiveDecimalsOverride,
      quoteSymbolOverride: effectiveSymbolOverride,
      distribution,
      bootstrap,
      ladder,
      support,
    };
  });
}

// ===========================================================================
// STEP 3: Funding
// ===========================================================================

/**
 * Find the pool config object for a given quote mint, so we can pull
 * resolved metadata (symbol, logo, decimals) for the funding-step rows.
 * The KNOWN_QUOTES (USDC/USDT/SOL) need explicit handling because their
 * pool entries store the symbol ('USDC') in quoteToken rather than the
 * mint address.
 */
function findPoolByMint(mint) {
  return pools.find((p) => {
    const upper = (p.quoteToken || '').toUpperCase();
    if (upper === 'SOL') return false;
    if (upper === 'USDC' && mint === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v') return true;
    if (upper === 'USDT' && mint === 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB') return true;
    return p.quoteToken === mint;
  });
}

/**
 * Build the inline-logo HTML for a pool's resolved image. Falls back
 * to a neutral placeholder when no image is available so the row
 * layout stays consistent.
 *
 * Broken URLs are handled by attachRowLogoFallbacks(), which swaps
 * failed images for placeholders without inline event handlers.
 */
function rowLogoHtml(pool) {
  if (pool && pool.resolvedImageUrl) {
    return `<img src="${escapeHtml(pool.resolvedImageUrl)}" alt="" class="row-logo" data-action="row-logo-fail">`;
  }
  return '<span class="row-logo-placeholder"></span>';
}

function replaceRowLogoWithPlaceholder(img) {
  if (!img || !img.parentNode) return;
  const placeholder = document.createElement('span');
  placeholder.className = 'row-logo-placeholder';
  img.parentNode.replaceChild(placeholder, img);
}

function attachRowLogoFallbacks(root) {
  root.querySelectorAll('[data-action="row-logo-fail"]').forEach((img) => {
    img.addEventListener('error', () => {
      replaceRowLogoWithPlaceholder(img);
    }, { once: true });
  });
}

function renderFundingRequirements() {
  document.getElementById('step3WalletAddr').textContent = tempWallet.publicKey;
  // The QR data URL was generated server-side when the wallet was created
  // and stashed on tempWallet alongside publicKey/secretKey. Reuse it here
  // so users on mobile can scan rather than copy-paste the address.
  const step3Qr = document.getElementById('step3QrCode');
  if (step3Qr && tempWallet.qrCode) step3Qr.src = tempWallet.qrCode;

  // ---- Section 1: things the user must send themselves ------------------
  // SOL is always present. Manual-prefund tokens (no auto-swap route, or
  // an auto-swap row that converted after a terminal failure) live here
  // alongside SOL so the user has a single "what do I need to send?" list.
  const sendContainer = document.getElementById('balanceRows');
  sendContainer.innerHTML = '';

  // Initial "needed" display shows the RECOMMENDED total (subtotal +
  // safety buffer). This is what users should aim for when funding —
  // landing exactly on the bare minimum leaves no margin for cost
  // variance, so we encourage depositing the full recommended amount.
  //
  // pollBalances handles the green/red transition: it uses the bare
  // minimum (subtotal - credits) as the "can proceed" threshold, so the
  // row will go green once wallet >= subtotal even if below recommended.
  // When that happens, a small grey/yellow note appears next to the
  // numbers indicating the buffer is below recommended but the launch
  // can still proceed.
  // The launch's funding requirement comes from the server. The
  // airdrop execution cost (ATA rent + tx fees for the recipient
  // transfers) is computed client-side and added on top so the user
  // funds enough for the entire flow including the post-launch
  // distribution. When airdrop is disabled or empty this adds 0.
  const airdropExecutionSol = computeAirdropExecutionCostSol();
  const solReqSol = (fundingRequirement.totalSol
    || fundingRequirement.solLamports / 1e9)
    + airdropExecutionSol;
  const solRow = document.createElement('div');
  solRow.className = 'balance-row';
  solRow.dataset.kind = 'sol';
  solRow.innerHTML = `
    <span><span class="status-dot"></span><strong>SOL</strong></span>
    <span>
      <span data-field="actual">0</span> /
      <span data-field="needed">${solReqSol.toFixed(3)}</span>
      <span data-field="buffer-note" class="is-size-7 has-text-grey ml-2"></span>
    </span>
  `;
  sendContainer.appendChild(solRow);

  Object.entries(fundingRequirement.byQuote).forEach(([mint, rawAmt]) => {
    const pool = findPoolByMint(mint);
    const decimals = pool?.resolvedDecimals ?? pool?.quoteDecimalsOverride ?? 6;
    // Symbol resolution — same priority as buildAllocationsForApi:
    // user override > resolved symbol > flywheel label > mint prefix.
    // The mint-prefix fallback only fires for truly unknown tokens
    // (no price-API coverage, not a flywheel, no user override) and
    // even then is a worst-case display rather than a stable ticker.
    let symbol = pool?.resolvedSymbol ?? pool?.quoteSymbolOverride;
    if (!symbol) {
      const fw = Object.values(FLYWHEELS).find((f) => f.mint === mint);
      symbol = fw ? fw.label : mint.slice(0, 6);
    }
    // neededWhole is the precise target (what the bootstrap actually
    // needs on-chain). displayNeeded is the user-facing rounded form;
    // displayed value may have lost precision via toPrecision/floor in
    // formatTokenDisplay. Polling MUST compare against the precise
    // value (stashed on dataset) — comparing against the rounded text
    // would produce false "met" states for small fractional targets.
    const neededWhole = rawAmt / Math.pow(10, decimals);
    const displayNeeded = formatTokenDisplay(neededWhole);
    // Approximate USD value of this manual-prefund target. Uses the
    // pool's resolved price for the conversion — same source the
    // estimator and cost-preview use. Hidden when we don't have a
    // price (genuinely unpriced token).
    const priceUsd = Number(pool?.resolvedPriceUsd ?? pool?.quoteUsdOverride);
    const usdValue = Number.isFinite(priceUsd) && priceUsd > 0
      ? neededWhole * priceUsd
      : null;
    const usdChip = usdValue != null
      ? ` <span class="is-size-7 has-text-grey">(${formatUsdShort(usdValue)})</span>`
      : '';

    const row = document.createElement('div');
    row.className = 'balance-row';
    row.dataset.kind = 'token';
    row.dataset.mint = mint;
    row.dataset.decimals = decimals;
    row.dataset.target = String(neededWhole);
    row.innerHTML = `
      <span><span class="status-dot"></span>${rowLogoHtml(pool)}<strong>${escapeHtml(symbol)}</strong>${usdChip}</span>
      <span><span data-field="actual">0</span> / <span data-field="needed">${displayNeeded}</span></span>
    `;
    sendContainer.appendChild(row);
  });

  // ---- Section 2: things the system will acquire on the user's behalf ----
  // Each row shows the target amount and a status indicator. No "0 / X"
  // ratio here — it'd read as "you need to send X" which is the opposite
  // of what auto-swap means. The status text walks: Pending → Swapping…
  // → Acquired ✓ → (or, on terminal failure, the row gets converted to
  // a Section-1 manual row by convertAutoSwapRowToManual).
  const autoContainer = document.getElementById('autoSwapRows');
  const autoSection = document.getElementById('autoSwapSection');
  autoContainer.innerHTML = '';
  const autoPlan = fundingRequirement.autoSwapPlan || [];
  if (autoPlan.length > 0) {
    autoSection.style.display = '';
    for (const item of autoPlan) {
      const pool = findPoolByMint(item.quoteMint);
      // Two different "target" concepts for an auto-swap row:
      //   - acquireWhole: what the swap aims for (oversize, $2). This is
      //     what we DISPLAY ("≈ 1000") so the user sees how much we're
      //     trying to obtain.
      //   - minWhole: the actual bootstrap on-chain need ($1). This is
      //     what we use for the "met" check — a 50% partial fill of the
      //     acquire target still meets minWhole, so the row marks green
      //     and the user can proceed.
      const acquireWhole = Number(item.targetRaw) / Math.pow(10, item.quoteDecimals);
      const minWhole = Number(item.minRaw || item.targetRaw) / Math.pow(10, item.quoteDecimals);
      const displayTarget = formatTokenDisplay(acquireWhole);
      // Approximate USD value of the acquire target. item.quoteUsd is a
      // string-encoded Decimal from the server estimator (the same price
      // the swap budget was sized against). Multiplying by acquireWhole
      // gives the dollar amount the user should expect to see swapped.
      // Shown in parentheses next to the token count so the user can
      // sanity-check magnitude — "3149 tokens" is meaningless without
      // knowing each is worth $0.001, but "$3.15" is universally
      // understood. Falls back to no USD chip when price is missing.
      const quoteUsdPrice = Number(item.quoteUsd);
      const usdValue = Number.isFinite(quoteUsdPrice) && quoteUsdPrice > 0
        ? acquireWhole * quoteUsdPrice
        : null;
      const usdChip = usdValue != null
        ? ` <span class="is-size-7 has-text-grey">(${formatUsdShort(usdValue)})</span>`
        : '';

      const row = document.createElement('div');
      row.className = 'balance-row';
      row.dataset.kind = 'token-autoswap';
      row.dataset.mint = item.quoteMint;
      row.dataset.decimals = item.quoteDecimals;
      // data-target is what polling compares wallet balance against
      // for the "met" state — use the actual bootstrap need.
      row.dataset.target = String(minWhole);
      row.dataset.allocationIndex = item.allocationIndex;
      // Initial status: 'pending' (waiting for SOL + Acquire click). The
      // poll loop and Acquire handler update this as the row progresses.
      // The retry button stays hidden via CSS (.row-retry-btn) until the
      // row enters a retryable failed state — then setRowStatus reveals
      // it. Clicking it re-runs Acquire for just this one row.
      row.innerHTML = `
        <span><span class="status-dot"></span>${rowLogoHtml(pool)}<strong>${escapeHtml(item.quoteSymbol)}</strong>
          <span class="is-size-7 has-text-grey ml-2">≈ ${displayTarget}</span>${usdChip}</span>
        <span class="row-status-cell">
          <span data-field="status" class="is-size-7 has-text-grey">Pending</span>
          <button class="row-retry-btn" type="button" title="Retry this swap" aria-label="Retry">
            <i class="fas fa-redo"></i>
          </button>
        </span>
      `;
      autoContainer.appendChild(row);
    }
  } else {
    autoSection.style.display = 'none';
  }

  // Show the Acquire-quote-tokens button only if there's anything to swap.
  const acquireWrap = document.getElementById('acquireQuoteTokensWrap');
  if (acquireWrap) {
    acquireWrap.style.display = autoPlan.length > 0 ? '' : 'none';
  }

  attachRowLogoFallbacks(document.getElementById('step3-card') || document);
  renderFundingBreakdown();
}

function renderFundingBreakdown() {
  const container = document.getElementById('fundingBreakdown');
  if (!container) return;
  if (!fundingRequirement.solBreakdown && !fundingRequirement.quoteBreakdown) {
    container.innerHTML = '';
    return;
  }

  let html = '<table class="table is-narrow is-fullwidth is-size-7"><tbody>';
  for (const item of fundingRequirement.solBreakdown || []) {
    const isBuffer = /safety buffer/i.test(item.label);
    html += `<tr${isBuffer ? ' class="has-text-grey"' : ''}>
      <td>${escapeHtml(item.label)}</td>
      <td class="has-text-right is-family-monospace">${item.sol > 0 && item.sol < 0.0001 ? '< 0.0001' : item.sol.toFixed(4)} SOL</td>
    </tr>`;
  }
  for (const item of fundingRequirement.quoteBreakdown || []) {
    html += `<tr>
      <td>${escapeHtml(item.label)}</td>
      <td class="has-text-right is-family-monospace">${item.amount} ${escapeHtml(item.symbol)}</td>
    </tr>`;
  }
  // Airdrop execution cost (ATA rent + tx fees) is calculated client-
  // side since the server estimator doesn't know about the airdrop
  // list. Show as a separate line item so the user understands where
  // the SOL goes, then include in the displayed total below.
  const airdropExecutionSol = computeAirdropExecutionCostSol();
  if (airdropExecutionSol > 0) {
    const n = simpleConfig.airdrop.parsedRows.length;
    html += `<tr>
      <td>Airdrop execution (${n} recipient${n === 1 ? '' : 's'}: ATA rent + tx fees)</td>
      <td class="has-text-right is-family-monospace">${airdropExecutionSol.toFixed(4)} SOL</td>
    </tr>`;
  }
  const displayedTotal = (fundingRequirement.totalSol || 0) + airdropExecutionSol;
  html += `<tr class="has-text-weight-bold">
    <td>Total SOL</td>
    <td class="has-text-right is-family-monospace">${displayedTotal.toFixed(4)} SOL</td>
  </tr>`;
  html += '</tbody></table>';
  container.innerHTML = html;
}

function startBalancePolling() {
  if (balancePollHandle) clearInterval(balancePollHandle);
  pollBalances();
  balancePollHandle = setInterval(pollBalances, 5000);
}

async function pollBalances() {
  if (!tempWallet) return;
  try {
    const resp = await fetch('/api/check-balance-detailed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ publicKey: tempWallet.publicKey }),
    });
    const data = await resp.json();
    if (!data.success) return;

    const { sol, tokens } = data.balance;
    // -------------------------------------------------------------------
    // SOL requirement: two-threshold model.
    //
    // The funding estimate exposes three numbers:
    //   - subtotalSol: the sum of actual costs (pool creation, positions,
    //                  Arweave, token mint, plus budgeted auto-swap spend).
    //                  This is the BARE MINIMUM needed to complete the
    //                  launch successfully if every step costs exactly
    //                  what we expected.
    //   - bufferSol:   a 20% safety margin layered on top of subtotal,
    //                  to absorb variance (priority-fee spikes, slippage
    //                  overshoots on auto-swaps, etc).
    //   - totalSol:    subtotal + buffer. The "recommended" deposit
    //                  amount, shown in the cost breakdown.
    //
    // Earlier we used totalSol as a hard floor for the "met" check,
    // meaning if you'd eaten into the buffer (even by a tiny amount) the
    // launch was blocked. That's wrong — the buffer is SAFETY MARGIN,
    // not a fixed required reserve. As long as you still have enough for
    // the actual costs, you can proceed; the buffer just gives you
    // breathing room for unexpected variance.
    //
    // Now:
    //   - solMet (can proceed):    wallet >= subtotal - swapCreditApplied
    //   - solHasFullBuffer:        wallet >= total - swapCreditApplied
    //
    // The "needed" display shows the bare minimum (subtotal-credit). If
    // we're between minimum and full-recommended, a small "buffer below
    // recommended — launch may fail on cost overruns" hint shows beside
    // the row but does NOT block proceeding.
    //
    // swapCreditApplied accumulates each completed auto-swap's
    // estSolSpend (the SOL we budgeted to acquire that quote token). Once
    // a swap has actually happened, that SOL is gone from the wallet and
    // doesn't need to be reserved anymore — the credit subtracts the
    // budget from both thresholds so the user sees the requirement
    // shrink as the work completes.
    const subtotalSol = fundingRequirement.subtotalSol || 0;
    const totalSol = fundingRequirement.totalSol || (fundingRequirement.solLamports / 1e9);
    const solCredit = fundingRequirement.solCreditedForCompletedSwaps || 0;
    // Airdrop execution cost is real SOL the wallet must hold even
    // though it won't be spent until after the launch completes. Both
    // the bare-minimum threshold and the recommended threshold get
    // bumped by this — under-funding would leave the airdrop step
    // stranded after the launch finishes, with the user having to
    // top-up to complete the flow.
    const airdropExecutionSol = computeAirdropExecutionCostSol();
    const solMinNeeded = Math.max(0, subtotalSol - solCredit) + airdropExecutionSol;
    const solRecommended = Math.max(0, totalSol - solCredit) + airdropExecutionSol;
    const solMet = sol >= solMinNeeded;
    const solHasFullBuffer = sol >= solRecommended;
    // The displayed "needed" is the bare minimum — the threshold that
    // actually gates proceeding. The recommended figure is shown to the
    // side when the user is below it but above the minimum.
    const solNeeded = solMinNeeded;

    let allMet = true;
    let anyAutoSwapPending = false;

    // ---- Section 1 (Send to wallet): SOL + manual-prefund tokens. -----
    // Each row needs to be 'met' for the launch to proceed.
    document.querySelectorAll('#balanceRows .balance-row').forEach((row) => {
      const kind = row.dataset.kind;

      if (kind === 'sol') {
        row.querySelector('[data-field="actual"]').textContent = sol.toFixed(4);
        // "Needed" shows the RECOMMENDED total (with buffer), even after
        // swap credits are applied. This is what the user should aim for
        // when funding — landing exactly at the bare minimum would mean
        // any unexpected cost variance fails the launch.
        //
        // The row turns green when wallet >= bare minimum (subtotal - credit)
        // so the user can still proceed if they've slightly eaten into the
        // buffer post-funding (e.g. swaps cost a touch more than budgeted).
        // The buffer-note span surfaces the situation when this happens.
        row.querySelector('[data-field="needed"]').textContent = solRecommended.toFixed(3);
        const bufferNote = row.querySelector('[data-field="buffer-note"]');
        if (bufferNote) {
          if (!solMet) {
            // Below bare minimum — can't proceed. Show how much more SOL
            // is actually needed for the launch to be viable (not the
            // buffered amount, just enough to complete the work). This
            // gives the user a clear "send me at least X more SOL" number.
            const short = (solMinNeeded - sol).toFixed(4);
            bufferNote.textContent = `(at least ${short} more SOL needed)`;
            bufferNote.className = 'is-size-7 has-text-danger ml-2';
          } else if (!solHasFullBuffer) {
            // Above minimum, below recommended-with-buffer. Soft hint —
            // launch will work but variance has eaten into the safety
            // margin. Inform the user how much they're short of the
            // recommended buffer so they can top up if they want full safety.
            const short = (solRecommended - sol).toFixed(4);
            bufferNote.textContent = `(below recommended +${short} SOL buffer — can proceed but launch may fail on cost overruns)`;
            bufferNote.className = 'is-size-7 has-text-warning ml-2';
          } else {
            // Above recommended — full buffer intact. No annotation.
            bufferNote.textContent = '';
            bufferNote.className = 'is-size-7 has-text-grey ml-2';
          }
        }
        row.classList.toggle('met', solMet);
        if (!solMet) allMet = false;
        return;
      }

      // Manual-prefund token row: balance goes up only when the user
      // sends tokens themselves. Compares against data-target (precise)
      // not the displayed text (may be rounded by formatTokenDisplay).
      const mint = row.dataset.mint;
      const have = tokens[mint] ? tokens[mint].amountUi : 0;
      const neededWhole = Number(row.dataset.target);
      row.querySelector('[data-field="actual"]').textContent = formatTokenDisplay(have);
      const met = have >= neededWhole;
      row.classList.toggle('met', met);
      if (!met) allMet = false;
    });

    // ---- Section 2 (We'll acquire for you): auto-swap tokens. -----
    // Status text drives the visible state. Possible states:
    //   Pending          → waiting for SOL funding (or click Acquire)
    //   Ready to acquire → SOL is funded, click Acquire button
    //   Swapping…        → set by the Acquire handler during the call
    //   Acquired ✓       → balance >= target
    //   needs more SOL   → set by the Acquire handler on INSUFFICIENT_SOL
    //   failed           → set by the Acquire handler on transient errors
    //
    // Polling only updates status when the row hasn't been explicitly
    // set to a non-default state by the Acquire handler. We detect that
    // by checking for a 'sticky' marker the handler sets — anything
    // marked sticky is left alone here so we don't clobber a user-
    // facing message with a generic 'Pending'.
    document.querySelectorAll('#autoSwapRows .balance-row').forEach((row) => {
      const mint = row.dataset.mint;
      const target = Number(row.dataset.target);
      const have = tokens[mint] ? tokens[mint].amountUi : 0;
      const met = have >= target;
      row.classList.toggle('met', met);
      const status = row.querySelector('[data-field="status"]');
      const sticky = row.dataset.statusSticky === '1';

      if (met) {
        // Acquired — overrides any sticky state since we're done.
        // Also clear the retry button (the row was acquired, no need
        // to retry).
        status.textContent = 'Acquired ✓';
        status.className = 'is-size-7 has-text-success';
        row.dataset.statusSticky = '';
        row.classList.remove('row-can-retry');
        // Belt-and-suspenders SOL credit: if the row is met but its
        // plan item's credit hasn't been applied yet (e.g. swap landed
        // before our polling caught the result, or page state somehow
        // missed the onResult call), apply it here. Idempotent via the
        // _solCredited flag on the plan item.
        const planItem = (fundingRequirement.autoSwapPlan || [])
          .find((p) => p.quoteMint === mint);
        if (planItem && !planItem._solCredited && planItem.estSolSpend) {
          fundingRequirement.solCreditedForCompletedSwaps =
            (fundingRequirement.solCreditedForCompletedSwaps || 0) + planItem.estSolSpend;
          planItem._solCredited = true;
        }
      } else {
        anyAutoSwapPending = true;
        allMet = false;
        if (!sticky) {
          // Row isn't in a user-set state (failure message etc.) — write
          // the default status. Also clear retry button since these are
          // non-failure states.
          row.classList.remove('row-can-retry');
          if (solMet) {
            status.textContent = 'Ready to acquire';
            status.className = 'is-size-7 has-text-info';
          } else {
            status.textContent = 'Pending';
            status.className = 'is-size-7 has-text-grey';
          }
        }
      }
    });

    document.getElementById('continueToTokenBtn').disabled = !allMet;

    // Next-action hint: say WHY continue is disabled and what to do
    // next. A disabled button with no stated reason is a dead end — the
    // only prior cue was the small per-row status text, which is easy to
    // miss (especially "Ready to acquire", which needs a button click
    // the user may not connect to the disabled continue).
    const nextHint = document.getElementById('fundingNextHint');
    if (nextHint) {
      if (allMet) {
        nextHint.classList.add('hidden');
      } else if (!solMet) {
        nextHint.textContent = 'Waiting for SOL — send the recommended amount to the launch wallet above, then the checks update automatically.';
        nextHint.classList.remove('hidden');
      } else if (anyAutoSwapPending) {
        nextHint.textContent = 'SOL funded ✓ — click “Acquire quote tokens” to swap for the remaining pool tokens, then Continue unlocks.';
        nextHint.classList.remove('hidden');
      } else {
        nextHint.textContent = 'Waiting for the remaining token balances to arrive — the checks above update automatically.';
        nextHint.classList.remove('hidden');
      }
    }

    // Acquire-quote-tokens button: enabled when SOL is funded AND
    // there are still pending auto-swaps. Disabled-but-visible when
    // SOL is short so the user sees the button is there waiting.
    const acquireBtn = document.getElementById('acquireQuoteTokensBtn');
    if (acquireBtn) {
      acquireBtn.disabled = !solMet || !anyAutoSwapPending;
    }

    // Funder detection: re-attempt whenever SOL goes up (new deposit
    // arrived since last check) AND we don't already have a funder.
    // Previously this used a one-shot exhausted flag that, once set,
    // never tried again — so a transient RPC failure on the first
    // attempt could permanently disable detection. Now we reset the
    // flag on any balance increase, which is the only condition under
    // which a new funder could appear anyway.
    if (sol > lastSolBalance) {
      fundingDetectionExhausted = false;
    }
    if (!fundingWallet && sol > 0 && !fundingDetectionExhausted) {
      detectFundingWallet();
    }
    lastSolBalance = sol;

    // Reset the consecutive-failure counter on any successful poll.
    // (See catch block below.)
    consecutivePollFailures = 0;
  } catch (e) {
    // Polling errors mean we don't have fresh balance data. We don't
    // want to spam the log with every failed poll, but staying silent
    // forever is worse — if the user's RPC is down or the server has
    // crashed, they'd see frozen balances with no indication of why.
    // Compromise: log once at the 3rd consecutive failure (about 15s in)
    // and stay quiet after that.
    consecutivePollFailures++;
    if (consecutivePollFailures === 3) {
      log(
        'Balance polling is failing — RPC or server may be unreachable. ' +
        'Balances shown may be stale.',
        'warning',
      );
    }
  }
}

// Module-scope counter so failure logs throttle across polls.
// Reset in pollBalances() on any successful round-trip.
let consecutivePollFailures = 0;

// Tracks the SOL balance reading from the previous pollBalances cycle.
// Used to detect deposits — when sol > lastSolBalance, a new deposit
// landed and we should re-attempt funder detection (in case the first
// attempt failed with no funder and got marked exhausted).
let lastSolBalance = 0;

// Per-attempt guard so we don't keep firing detection RPC every 5s
// while the user is funding gradually. Reset when:
//   - the wallet is regenerated (entirely new session)
//   - the SOL balance goes up (new deposit, possibly from a new funder)
// Set when:
//   - detection returned no funder (the answer isn't going to change
//     without a new deposit)
let fundingDetectionExhausted = false;

async function detectFundingWallet() {
  try {
    const resp = await fetch('/api/find-funder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ publicKey: tempWallet.publicKey }),
    });
    const data = await resp.json();
    if (data.success && data.result && data.result.funder) {
      fundingWallet = data.result.funder;
      document.getElementById('fundingWalletInfo').classList.remove('hidden');
      document.getElementById('detectedFundingWallet').textContent = fundingWallet;
      log(`Funding wallet identified: ${fundingWallet} (${data.result.amount} SOL)`, 'info');
    } else {
      // No funder found — stop retrying. The detection looks at recent
      // inbound transfers; if there isn't a clear single funder, we
      // shouldn't keep asking. The user can paste their destination
      // address manually in Step 6 anyway.
      fundingDetectionExhausted = true;
    }
  } catch (e) {
    // Network/RPC failure — let the next pollBalances cycle try again
    // (don't set fundingDetectionExhausted). One failure shouldn't
    // permanently disable detection.
  }
}

bind('refreshBalanceBtn', 'click', pollBalances);

// "Pretend funding arrived (DEMO)" button. Demo mode only — the button is
// hidden in real mode (see setupDemoMode in startup.js). Sends the funding
// amounts the UI already computed (recommended SOL with a small buffer,
// plus every manual-prefund token's target) to the demo ledger, then
// refreshes balances so the green checkmarks light up. Auto-swap tokens
// are intentionally left out — those are acquired via the demo Acquire
// flow so that step stays demonstrable.
bind('demoFundBtn', 'click', async () => {
  if (!tempWallet) return;
  const btn = document.getElementById('demoFundBtn');
  setLoading(btn, true);
  try {
    // Recommended SOL (subtotal + buffer), with a little extra on top so
    // the row lands above the recommended threshold (fully green, no
    // "below recommended buffer" note).
    const recommendedSol = fundingRequirement.totalSol
      || (fundingRequirement.solLamports / 1e9)
      || 0;
    const sol = recommendedSol > 0 ? recommendedSol * 1.05 : 1;

    // Manual-prefund token rows (Section 1) carry their mint, decimals,
    // and whole-token target as data attributes.
    const tokens = [];
    document.querySelectorAll('#balanceRows .balance-row').forEach((row) => {
      if (row.dataset.kind === 'sol') return;
      const mint = row.dataset.mint;
      if (!mint) return;
      tokens.push({
        mint,
        amountUi: Number(row.dataset.target) || 0,
        decimals: Number(row.dataset.decimals) || 9,
      });
    });

    const resp = await fetch('/api/demo/inject-funds', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ publicKey: tempWallet.publicKey, sol, tokens }),
    });
    const data = await resp.json();
    if (!data.success) throw new Error(data.error || 'inject-funds failed');
    log('Demo funding injected — balances updated', 'success');
    // Pick up the new balances right away.
    pollBalances();
  } catch (e) {
    log(`Demo funding failed: ${e.message}`, 'danger');
  } finally {
    setLoading(btn, false);
  }
});

// Acquire-quote-tokens button: triggers SOL → quote-token swaps for
// every allocation the funding-estimate flagged as auto-swappable.
//
// Failure handling:
//   - The backend retries internally (multiple pools × retry ladder).
//     We don't retry from here; we just present results.
//   - SUCCESS  → row goes green, user proceeds.
//   - INSUFFICIENT_SOL → row stays auto-swap, message asks user to fund
//     more SOL. (Once they do, click Acquire again — idempotent.)
//   - NO_USABLE_POOL / ALL_ATTEMPTS_FAILED → row CONVERTS to manual-
//     prefund. The user sees the same wallet address + required amount
//     they would have seen if the estimate had routed manual upfront.
//     This is the "no friction" guarantee: even if the auto path
//     completely fails, the user has a working path forward without
//     restarting.
//   - Any other error → treated as transient, row shows retry hint.
// Set a row's status text/color/title and (optionally) mark it sticky
// so the 5s balance-poll doesn't overwrite the message. `canRetry`
// toggles the .row-can-retry class which reveals the per-row retry
// button via CSS; pass true for failure states that the user can
// recover from with another click.
//
// Module-scope (not closure-scoped to the Acquire handler) because the
// per-row retry button needs to call it too.
function setAutoSwapRowStatus(mint, text, color, { sticky = false, title = '', canRetry = false } = {}) {
  const row = document.querySelector(
    `#autoSwapRows .balance-row[data-kind="token-autoswap"][data-mint="${CSS.escape(mint)}"]`,
  );
  const status = row?.querySelector('[data-field="status"]');
  if (!row || !status) return;
  status.textContent = text;
  status.className = `is-size-7 has-text-${color}`;
  status.title = title;
  row.dataset.statusSticky = sticky ? '1' : '';
  row.classList.toggle('row-can-retry', !!canRetry);
}

// Guards against concurrent calls to runAcquireFlow. Both the bulk
// Acquire button and per-row retry buttons consult this — running two
// in parallel against the same wallet causes SOL-balance races (one
// run depletes the funded SOL faster than the other can read it).
// Backend would classify the loser as INSUFFICIENT_SOL, which is
// recoverable but noisy. Avoiding the race entirely is cleaner.
let isAcquireFlowRunning = false;

/**
 * Run the acquire-quote-tokens flow for a given subset of the plan.
 * Used by both the global Acquire button (passing all pending rows)
 * and the per-row retry button (passing just one row's plan item).
 *
 * Drives the UI state machine: Queued → Swapping → Acquired/Failed,
 * updates the top-line progress label, and emits log lines.
 *
 * Returns nothing — failures are surfaced via row states and the log,
 * not via thrown exceptions, so a single bad swap doesn't break the
 * batch. If another acquire flow is already in flight, this returns
 * immediately without doing anything (caller is expected to gate
 * its UI affordance before calling, but we double-check here).
 */
async function runAcquireFlow(planSubset, btn) {
  if (!planSubset.length) return;
  if (isAcquireFlowRunning) {
    log('Another acquire is in progress; please wait for it to finish.', 'warning');
    return;
  }
  // Set the global guard and button-loading state INSIDE try so the
  // finally block can reliably clean them up even if something between
  // here and the network call throws. Without this wrapper, an
  // unexpected exception in setLoading() or row-status-setup code
  // would leave isAcquireFlowRunning permanently true and lock out
  // future acquire attempts.
  isAcquireFlowRunning = true;
  if (btn) setLoading(btn, true);

  const counts = { success: 0, solShort: 0, converted: 0, retryable: 0 };
  let completed = 0;
  const totalPlanned = planSubset.length;

  const updateProgressLabel = () => {
    const label = document.getElementById('autoSwapProgressLabel');
    if (!label) return;
    if (completed >= totalPlanned) {
      label.textContent = `${completed} of ${totalPlanned} processed.`;
    } else {
      label.textContent = `Acquiring — ${completed} of ${totalPlanned} complete…`;
    }
  };

  // Track which rows received a `result` event from the backend. Any
  // rows still missing one after the stream closes are stragglers —
  // either the swap was still running when the connection dropped, or
  // it never got scheduled, or the response stream truncated. Either
  // way we mark them as failed-retryable so the user can recover.
  const resultsReceived = new Set();

  // Mark every selected row as "Queued" so the user sees something
  // happen immediately, even though only 4 workers are running at a
  // time on the backend. Clears any previous retry button.
  for (const item of planSubset) {
    setAutoSwapRowStatus(item.quoteMint, 'Queued', 'grey', { sticky: true });
  }
  updateProgressLabel();

  log(
    `Acquiring ${totalPlanned} quote token${totalPlanned === 1 ? '' : 's'} via Raydium swap…`,
  );

  // Per-event handlers, defined here so they close over counts/progress.
  // (We used to also have an onAttempt handler that flipped a row to
  // "Swapping…" — now done inline in the polling loop based on the
  // server's inProgressMints list, which is more accurate.)
  const onResult = (r) => {
    completed++;
    resultsReceived.add(r.quoteMint);
    if (r.success) {
      counts.success++;
      // Credit this swap's budgeted SOL against the requirement. The
      // original solLamports estimate reserved ~$4 of SOL per auto-swap;
      // now that the swap has completed (the SOL is gone), we subtract
      // that reserve so the SOL row's "needed" reflects only what's
      // still ahead (pool creation, positions, Arweave, headroom).
      //
      // We use estSolSpend from the plan item, not the swap's actual
      // SOL consumption (which we don't have a precise measurement of).
      // Slight over- or under-shoot from the actual cost is absorbed by
      // the original estimate's safety buffer.
      //
      // Guard: only credit ONCE per row. The polling loop replays the
      // full results array on every poll, so onResult might be called
      // for the same mint multiple times across retries; resultsReceived
      // catches that upstream (early-return at the top), but it's worth
      // making the credit explicitly idempotent via the plan item's
      // own flag.
      const planItem = (fundingRequirement.autoSwapPlan || [])
        .find((p) => p.quoteMint === r.quoteMint);
      if (planItem && !planItem._solCredited && planItem.estSolSpend) {
        fundingRequirement.solCreditedForCompletedSwaps =
          (fundingRequirement.solCreditedForCompletedSwaps || 0) + planItem.estSolSpend;
        planItem._solCredited = true;
      }
      setAutoSwapRowStatus(r.quoteMint, 'Acquired ✓', 'success', {
        sticky: false,
        title: r.txId ? `tx: ${r.txId}` : '',
      });
      log(
        `Acquired ${r.quoteSymbol}` +
          (r.txId ? ` (tx ${r.txId.slice(0, 8)}…)` : ' (already had enough)'),
        'success',
      );
      updateProgressLabel();
      return;
    }
    const err = String(r.error || '');
    if (err.startsWith('INSUFFICIENT_SOL')) {
      counts.solShort++;
      setAutoSwapRowStatus(r.quoteMint, 'Needs more SOL — top up & retry', 'warning', {
        sticky: true,
        title: err,
        canRetry: true,
      });
      log(`${r.quoteSymbol}: ${err}`, 'warning');
    } else if (err.startsWith('NO_USABLE_POOL') || err.startsWith('ALL_ATTEMPTS_FAILED')) {
      counts.converted++;
      convertAutoSwapRowToManual(r.quoteMint, r.quoteSymbol);
      log(
        `${r.quoteSymbol}: auto-swap unavailable, switched to manual ` +
          `(send ${r.quoteSymbol} to the wallet address above). Reason: ${err}`,
        'warning',
      );
    } else {
      counts.retryable++;
      setAutoSwapRowStatus(r.quoteMint, 'Failed — click retry', 'danger', {
        sticky: true,
        title: err,
        canRetry: true,
      });
      log(`${r.quoteSymbol}: ${err}`, 'danger');
    }
    updateProgressLabel();
  };

  // Now safe to enter the network phase — guard and loading state are
  // both set, finally will clean them up.
  try {
    // 1. POST to kick off the job. Returns immediately with { jobId }.
    //    The actual swap work runs in the background on the server.
    const resp = await fetch('/api/acquire-quote-tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        walletPublicKey: tempWallet.publicKey,
        // F5: the server resolves the secret from its encrypted store using
        // the public key for real launches; only demo mode (in-memory
        // ledger, no server-side secret) still sends the key inline.
        ...(demoModeActive ? { tempWalletSecretKey: tempWallet.secretKey } : {}),
        autoSwapPlan: planSubset,
      }),
    });
    if (!resp.ok) {
      // Pull the structured body if there is one — a 409 OP_IN_FLIGHT
      // means another launch operation (a still-running acquire, or a
      // launch in progress) holds the wallet; the server's message
      // explains what to do. Anything else surfaces its error text.
      const body = await resp.json().catch(() => ({}));
      if (resp.status === 409 && body.code === 'OP_IN_FLIGHT') {
        log(body.error, 'warning');
      } else {
        log(`Acquire failed: ${body.error || `HTTP ${resp.status}`}`, 'danger');
      }
      return;
    }
    const { jobId } = await resp.json();
    if (!jobId) {
      log('Acquire failed: no jobId returned', 'danger');
      return;
    }

    // 2. Poll the job until it's done. Each poll is a fresh HTTP round-
    //    trip, naturally robust against network blips: a failed poll
    //    just retries on the next interval. Replaces our old SSE setup
    //    which was unreliable in Electron's fetch+ReadableStream layer.
    //
    //    Update strategy: on each poll, we compute the diff between the
    //    server's reported results and our local resultsReceived set,
    //    and call onResult for each newly-finished swap. Rows shown as
    //    "in progress" by the server get the "Swapping…" status, rows
    //    listed as pending stay "Queued". On a 404 (job expired), we
    //    fall back to polling on-chain balances and flagging stragglers.
    const POLL_INTERVAL_MS = 2000;
    const POLL_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes, matches server-side JOB_EXPIRY_MS
    const pollStartedAt = Date.now();
    let consecutivePollFailures = 0;
    const MAX_POLL_FAILURES = 5; // ~10 seconds of failures before giving up

    while (true) {
      // Bail out if we've been polling forever — defensive guard
      // against a runaway loop if the server gets into an odd state.
      if (Date.now() - pollStartedAt > POLL_TIMEOUT_MS) {
        log('Acquire polling timed out after 10 minutes', 'warning');
        break;
      }

      let pollResp;
      try {
        pollResp = await fetch(`/api/acquire-quote-tokens/${jobId}`);
      } catch (netErr) {
        // Network blip — retry on next interval. Only give up after
        // MAX_POLL_FAILURES consecutive failures.
        consecutivePollFailures++;
        if (consecutivePollFailures >= MAX_POLL_FAILURES) {
          log(
            `Acquire polling failed ${consecutivePollFailures} times in a row — giving up`,
            'warning',
          );
          break;
        }
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        continue;
      }

      if (pollResp.status === 404) {
        // Job is gone (expired or invalid). Could happen if the user
        // hit Acquire again, getting a new jobId, while a previous
        // poll loop is still running with the old one. Just exit
        // cleanly — the finally block will sync row states from
        // on-chain balances.
        log('Acquire job no longer tracked by server', 'info');
        break;
      }
      if (!pollResp.ok) {
        consecutivePollFailures++;
        if (consecutivePollFailures >= MAX_POLL_FAILURES) {
          log(`Acquire polling HTTP ${pollResp.status} — giving up`, 'warning');
          break;
        }
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        continue;
      }

      consecutivePollFailures = 0;
      const job = await pollResp.json();

      // Apply new results that we haven't already processed. The job's
      // results array is append-only on the server, so any entry we
      // haven't seen yet is new since our last poll.
      for (const r of job.results) {
        if (resultsReceived.has(r.quoteMint)) continue;
        // r might be the same shape as the old SSE result events —
        // onResult handles success/failure/conversion routing.
        onResult(r);
      }

      // Update in-progress rows to "Swapping…". Server reports
      // inProgressMints as an array; loop through and set status on
      // any row that isn't already met or already processed.
      //
      // The check for the `met` class is important: wallet-balance
      // polling runs on a separate ~5s interval and may have already
      // marked a row green because its on-chain balance reflects the
      // new tokens. We don't want to flip such a row back to
      // "Swapping…" — that's confusing and triggers a visible flicker.
      // The race is real because swapSolForQuote waits POST_SWAP_SETTLE_MS
      // after the tx confirms before returning, so for ~2 seconds the
      // mint is still in inProgressMints even though the on-chain
      // balance shows it's done.
      const inProgress = new Set(job.inProgressMints || []);
      for (const mint of inProgress) {
        if (resultsReceived.has(mint)) continue;
        const row = document.querySelector(
          `#autoSwapRows .balance-row[data-kind="token-autoswap"][data-mint="${CSS.escape(mint)}"]`,
        );
        if (!row || row.classList.contains('met')) continue;
        setAutoSwapRowStatus(mint, 'Swapping…', 'info', { sticky: true });
      }

      if (job.status === 'done') {
        if (job.error) {
          log(`Acquire job error: ${job.error}`, 'danger');
        }
        // Optimistically clean up the job server-side. Fire-and-forget;
        // if it fails, the server's auto-expiry will catch it in 10 min.
        fetch(`/api/acquire-quote-tokens/${jobId}`, { method: 'DELETE' })
          .catch(() => { /* ignore */ });
        break;
      }

      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }

    // Polling finished. The finally block runs the post-flow cleanup
    // pass (poll balances, flag any leftover stragglers, log summary).
  } catch (e) {
    log(`Acquire error: ${e.message}`, 'danger');
  } finally {
    // Cleanup pass. Runs in finally so it executes regardless of how
    // the try block exited (normal completion, polling timeout, network
    // error, or thrown exception). The three things we need to do
    // unconditionally on exit:
    //
    //   1. Re-poll on-chain balances first. The job's result list might
    //      have missed a swap that landed at the last moment (between
    //      the swap's confirmation and the job-state read). On-chain
    //      balance is the source of truth — polling will mark such rows
    //      Acquired ✓ via the met-class override.
    //
    //   2. Flag any leftover unresolved rows — anything in planSubset
    //      that didn't produce a result AND isn't met on-chain. These
    //      are rare with the polling architecture (only happens if the
    //      polling loop bailed early via timeout or connection failure)
    //      but we still need to give the user a recovery path.
    //
    //   3. Reset button state. setLoading(false) re-enables the button
    //      and removes the spinner. isAcquireFlowRunning=false unlocks
    //      the global guard so the user can click Acquire again.
    try {
      await pollBalances();
      let unresolvedCount = 0;
      for (const item of planSubset) {
        if (resultsReceived.has(item.quoteMint)) continue;
        const row = document.querySelector(
          `#autoSwapRows .balance-row[data-kind="token-autoswap"][data-mint="${CSS.escape(item.quoteMint)}"]`,
        );
        if (!row || row.classList.contains('met')) continue;
        unresolvedCount++;
        setAutoSwapRowStatus(item.quoteMint, 'Unresolved — click retry', 'danger', {
          sticky: true,
          title: 'No final status was received for this swap. Click retry to try again, or click "Acquire quote tokens" to retry all unresolved swaps at once.',
          canRetry: true,
        });
      }
      if (unresolvedCount > 1) {
        // Helpful hint: bulk retry is faster than clicking each row.
        log(
          `${unresolvedCount} swap${unresolvedCount === 1 ? '' : 's'} didn't complete cleanly — ` +
            `click "Acquire quote tokens" to retry all at once, or use the per-row retry buttons.`,
          'warning',
        );
      }

      const parts = [];
      if (counts.success) parts.push(`${counts.success} acquired`);
      if (counts.solShort) parts.push(`${counts.solShort} need more SOL`);
      if (counts.converted) parts.push(`${counts.converted} switched to manual`);
      if (counts.retryable) parts.push(`${counts.retryable} retryable`);
      if (unresolvedCount) parts.push(`${unresolvedCount} unresolved`);
      if (parts.length > 0) {
        log(
          `Done — ${parts.join(', ')}.`,
          counts.retryable || counts.solShort || unresolvedCount ? 'warning' : 'success',
        );
      }
    } catch (cleanupErr) {
      // Cleanup itself failed. Log but don't re-throw — we still want
      // to reset button state below so the user isn't stuck.
      console.error('Acquire flow cleanup failed:', cleanupErr);
    }

    if (btn) setLoading(btn, false);
    isAcquireFlowRunning = false;
  }
}

bind('acquireQuoteTokensBtn', 'click', async () => {
  const btn = document.getElementById('acquireQuoteTokensBtn');
  const plan = fundingRequirement.autoSwapPlan || [];
  if (plan.length === 0) return;

  // Filter to rows that aren't already satisfied. The backend handles
  // idempotency too, but skipping here saves work and avoids blinking
  // through "Queued" for rows that don't need anything.
  const pendingMints = new Set();
  document.querySelectorAll('#autoSwapRows .balance-row[data-kind="token-autoswap"]')
    .forEach((row) => {
      if (!row.classList.contains('met')) {
        pendingMints.add(row.dataset.mint);
      }
    });
  const pendingPlan = plan.filter((p) => pendingMints.has(p.quoteMint));
  if (pendingPlan.length === 0) {
    log('All auto-swap rows already satisfied — nothing to do.', 'info');
    return;
  }

  await withRunState(async () => {
    await runAcquireFlowWithAutoRetry(pendingPlan, btn);
  });
});

/**
 * Run the acquire flow, then if any stragglers remain (rows whose
 * result events never arrived even though the stream closed),
 * automatically re-run for just those rows ONCE before giving up.
 *
 * Rationale: the stream-disconnect bug we see in practice tends to be
 * transient — a second pass through the same rows usually completes
 * cleanly because the wallet's balance has stabilized (no more parallel
 * RPC contention) and the SSE stream is starting fresh. Auto-retrying
 * once handles 90%+ of these cases without making the user click anything.
 *
 * If auto-retry still leaves stragglers, the per-row retry buttons
 * and the bulk Acquire button are the remaining recovery paths.
 */
async function runAcquireFlowWithAutoRetry(planSubset, btn) {
  await runAcquireFlow(planSubset, btn);

  // Find stragglers: rows in the original plan that didn't make it
  // through. We have to look at the DOM here because runAcquireFlow
  // returns void — the row state IS the source of truth.
  const stragglers = [];
  for (const item of planSubset) {
    const row = document.querySelector(
      `#autoSwapRows .balance-row[data-kind="token-autoswap"][data-mint="${CSS.escape(item.quoteMint)}"]`,
    );
    // Skip rows that:
    //   - Don't exist anymore (converted to manual by a NO_USABLE_POOL error)
    //   - Are already met (acquired successfully)
    //   - Are in a non-retryable failure state (INSUFFICIENT_SOL, etc.)
    //     We detect this via the "Needs more SOL" status text — retrying
    //     won't help if the wallet is still short.
    if (!row) continue;
    if (row.classList.contains('met')) continue;
    const statusText = row.querySelector('[data-field="status"]')?.textContent || '';
    if (statusText.includes('Needs more SOL')) continue;
    stragglers.push(item);
  }

  if (stragglers.length === 0) return; // Clean run, nothing to retry.

  log(
    `Auto-retrying ${stragglers.length} unresolved swap${stragglers.length === 1 ? '' : 's'}…`,
    'info',
  );
  // Brief pause so the user notices the state change and so any
  // in-flight RPC operations have a moment to settle.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  await runAcquireFlow(stragglers, btn);
}

// Per-row retry: delegated click handler on the auto-swap section.
// Lives at module scope so it survives row re-renders and works on
// rows added after page load. Looks up the row's mint, finds the
// corresponding plan item, and calls runAcquireFlow with just that one.
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('.row-retry-btn');
  if (!btn) return;
  const row = btn.closest('.balance-row[data-kind="token-autoswap"]');
  if (!row) return;
  const mint = row.dataset.mint;
  const planItem = (fundingRequirement.autoSwapPlan || [])
    .find((p) => p.quoteMint === mint);
  if (!planItem) {
    log('Retry: could not find plan item for this row', 'danger');
    return;
  }

  // If another acquire is already running, give the user clear visual
  // feedback rather than silently ignoring the click. Without this, the
  // user can click multiple retry buttons in a row and have no idea why
  // nothing's happening — the guard kicks in inside runAcquireFlow but
  // the rejection message only goes to the log (which most users don't
  // watch). Flash the row's status and shake the button briefly.
  if (isAcquireFlowRunning) {
    const status = row.querySelector('[data-field="status"]');
    if (status) {
      const original = { text: status.textContent, className: status.className };
      status.textContent = 'Wait — another swap is running…';
      status.className = 'is-size-7 has-text-warning';
      setTimeout(() => {
        // Only restore if nothing else has touched it (e.g. the running
        // flow finished and polling overwrote the status to Acquired ✓).
        if (status.textContent === 'Wait — another swap is running…') {
          status.textContent = original.text;
          status.className = original.className;
        }
      }, 2500);
    }
    return;
  }

  // Disable the row's button while running so the user can't fire
  // multiple parallel retries on the same row. setLoading would dim
  // the whole row visually; a simple disabled flag is less intrusive.
  btn.disabled = true;
  try {
    await withRunState(async () => {
      await runAcquireFlow([planItem], null);
    });
  } finally {
    btn.disabled = false;
  }
});

/**
 * Convert an auto-swap row to a manual-prefund row. Used when the
 * backend reports a terminal failure (no Raydium route available, or
 * all swap attempts exhausted). We move the requirement from the
 * "We'll acquire for you" section to the "Send to wallet" section so
 * the user sees exactly what they need to send themselves, with the
 * same address shown above. Polling picks up the new manual row by
 * its data-kind on the next cycle.
 *
 * After conversion:
 *   - The auto-swap section's row is removed entirely (not modified in
 *     place — fresh element created in #balanceRows).
 *   - autoSwapPlan and byQuote are updated to match the new layout.
 *   - The Acquire button hides itself if no auto rows remain.
 *   - The "send manually" tag distinguishes converted rows from the
 *     manual rows the user saw from the start (visual cue that this
 *     wasn't part of the original plan).
 */
function convertAutoSwapRowToManual(quoteMint, quoteSymbol) {
  const oldRow = document.querySelector(
    `#autoSwapRows .balance-row[data-kind="token-autoswap"][data-mint="${quoteMint}"]`,
  );
  if (!oldRow) return;
  const decimals = Number(oldRow.dataset.decimals);
  // data-target is already the actual bootstrap need (minWhole, not the
  // ambitious acquire target). The auto-swap row was DISPLAYING a higher
  // ≈ amount, but the underlying need is what we ask the user to send.
  const manualTarget = Number(oldRow.dataset.target);

  // Remove from the auto-swap section. If the section becomes empty,
  // hide it entirely so the user doesn't see a stranded header.
  oldRow.remove();
  const autoSection = document.getElementById('autoSwapSection');
  if (autoSection && document.querySelectorAll('#autoSwapRows .balance-row').length === 0) {
    autoSection.style.display = 'none';
  }

  // Build the equivalent manual-prefund row in the send section. Same
  // shape as a row created by renderFundingRequirements' Section 1
  // loop, so polling treats it identically. data-target carries the
  // precise value; the displayed text is formatted for readability.
  const pool = findPoolByMint(quoteMint);
  const displayTarget = formatTokenDisplay(manualTarget);
  // USD chip for consistency with the original Section-1 manual rows.
  // Same source-of-truth (pool's resolved price) and same formatter.
  const priceUsd = Number(pool?.resolvedPriceUsd ?? pool?.quoteUsdOverride);
  const usdValue = Number.isFinite(priceUsd) && priceUsd > 0
    ? manualTarget * priceUsd
    : null;
  const usdChip = usdValue != null
    ? ` <span class="is-size-7 has-text-grey">(${formatUsdShort(usdValue)})</span>`
    : '';
  const newRow = document.createElement('div');
  newRow.className = 'balance-row';
  newRow.dataset.kind = 'token';
  newRow.dataset.mint = quoteMint;
  newRow.dataset.decimals = decimals;
  newRow.dataset.target = String(manualTarget);
  newRow.innerHTML = `
    <span><span class="status-dot"></span>${rowLogoHtml(pool)}<strong>${escapeHtml(quoteSymbol)}</strong>${usdChip}
      <span class="tag is-warning is-light is-small ml-2">send manually</span></span>
    <span><span data-field="actual">0</span> / <span data-field="needed">${displayTarget}</span></span>
  `;
  document.getElementById('balanceRows').appendChild(newRow);
  attachRowLogoFallbacks(newRow);

  // Update fundingRequirement state to match the new layout. Also
  // credit this row's budgeted SOL back: it was reserved for the
  // auto-swap, but the swap isn't happening anymore (the user will
  // manually send the token instead). Without this, the SOL row
  // would falsely report we need extra ~$4 of SOL we no longer do.
  const removedPlanItem = (fundingRequirement.autoSwapPlan || [])
    .find((p) => p.quoteMint === quoteMint);
  if (removedPlanItem && !removedPlanItem._solCredited && removedPlanItem.estSolSpend) {
    fundingRequirement.solCreditedForCompletedSwaps =
      (fundingRequirement.solCreditedForCompletedSwaps || 0) + removedPlanItem.estSolSpend;
    // No need to mark _solCredited on a plan item we're about to drop
    // from the array, but it's cheap consistency.
    removedPlanItem._solCredited = true;
  }
  fundingRequirement.autoSwapPlan = (fundingRequirement.autoSwapPlan || [])
    .filter((p) => p.quoteMint !== quoteMint);
  if (!fundingRequirement.byQuote) fundingRequirement.byQuote = {};
  fundingRequirement.byQuote[quoteMint] = Math.ceil(manualTarget * Math.pow(10, decimals));

  // Hide the Acquire button if no auto rows remain.
  const acquireWrap = document.getElementById('acquireQuoteTokensWrap');
  if (acquireWrap && fundingRequirement.autoSwapPlan.length === 0) {
    acquireWrap.style.display = 'none';
  }
}

bind('continueToTokenBtn', 'click', () => {
  if (balancePollHandle) {
    clearInterval(balancePollHandle);
    balancePollHandle = null;
  }
  setStepSummary(3, `funded`);
  activateStep(4);
});

// ===========================================================================
// STEP 4: Create token
// ===========================================================================

bind('createTokenBtn', 'click', async () => {
  const btn = document.getElementById('createTokenBtn');
  await withRunState(async () => {
    setLoading(btn, true);
    markLaunchActiveForRpcHealth(true);
    try {
      log('Creating token...');
      const formData = new FormData();
      // F5: send the public key; the server resolves the secret from its
      // encrypted store for real launches. Demo has no server-side secret,
      // so it still appends the throwaway secret inline.
      formData.append('walletPublicKey', tempWallet.publicKey);
      if (demoModeActive) {
        formData.append('tempWalletSecretKey', JSON.stringify(tempWallet.secretKey));
      }
      formData.append('name', document.getElementById('tokenName').value.trim());
      formData.append('symbol', document.getElementById('tokenSymbol').value.trim());
      formData.append('description', document.getElementById('tokenDescription').value.trim());
      // Strip thousand-separator commas before sending. Keep this as a
      // string so large but valid SPL supplies do not lose integer precision
      // in JavaScript before the server converts to BigInt.
      const totalSupplyRaw = getIntegerInputString(document.getElementById('tokenSupply'));
      formData.append('totalSupply', totalSupplyRaw);
      // Vanity CA: if we pre-ground a keypair, send it. Otherwise
      // fall back to prefix/suffix for server-side grinding.
      if (selectedVanityCA !== null && vanityCAKeypairs[selectedVanityCA]) {
        formData.append('vanityCAKeypair', JSON.stringify(vanityCAKeypairs[selectedVanityCA].secretKey));
      } else {
        const vanityTarget = document.getElementById('vanityCATarget')?.value.trim();
        if (vanityTarget) {
          const vanityMode = document.getElementById('vanityCAMode')?.value || 'suffix';
          if (vanityMode === 'prefix') {
            formData.append('vanityPrefix', vanityTarget);
          } else {
            formData.append('vanitySuffix', vanityTarget);
          }
        }
      }
      const logoFile = document.getElementById('tokenLogo').files[0];
      if (logoFile) formData.append('logo', logoFile);

      const resp = await fetch('/api/create-token', { method: 'POST', body: formData });
      const data = await resp.json();
      if (resp.status === 409 && data.code === 'OP_IN_FLIGHT') {
        // A prior token creation (or other launch operation) is still
        // running for this wallet — likely a double-click or a UI reload
        // mid-creation. Not a failure; just wait for it to finish.
        log(data.error, 'warning');
        return;
      }
      if (!data.success) throw new Error(data.error);

      createdTokenInfo = {
        mint: data.tokenMint,
        decimals: data.decimals || 9,
        totalSupply: totalSupplyRaw,
        name: data.name || document.getElementById('tokenName').value.trim(),
        symbol: data.symbol || document.getElementById('tokenSymbol').value.trim(),
        // Token-safety facts for the launch report / Arweave audit record.
        // The create-token endpoint spreads createTokenWithMetaplex's result
        // into the response, so these ride along on the same payload. They
        // let the permanent report assert (and a verifier confirm against
        // the mint account) that supply, freezing, and metadata are locked.
        metadataUri: data.metadataUri || null,
        imageUri: data.imageUri || null,
        mintAuthorityRenounced: data.mintAuthorityRenounced === true,
        freezeAuthorityDisabled: data.freezeAuthorityDisabled === true,
        metadataUpdateAuthorityRevoked: data.metadataUpdateAuthorityRevoked === true,
        metadataImmutable: data.metadataImmutable === true,
      };

      document.getElementById('tokenMintAddress').textContent = data.tokenMint;
      document.getElementById('tokenSolscanLink').href =
        `https://solscan.io/token/${data.tokenMint}`;
      document.getElementById('tokenCreatedInfo').classList.remove('hidden');
      // Hide the Create button after success — clicking it again would mint
      // a second token and overwrite createdTokenInfo, abandoning the first.
      document.getElementById('createTokenBtn').classList.add('hidden');
      log(`Token created: ${data.tokenMint}`, 'success');
    } catch (e) {
      log(`Token creation failed: ${e.message}`, 'danger');
      markLaunchActiveForRpcHealth(false);
    } finally {
      setLoading(btn, false);
    }
  });
});

bind('continueToLpBtn', 'click', () => {
  setStepSummary(4, `${createdTokenInfo.symbol} — ${createdTokenInfo.mint.slice(0, 8)}…`);
  renderLpSummary();
  activateStep(5);
});

// ===========================================================================
// STEP 5: Create LP
// ===========================================================================

function renderLpSummary() {
  const summary = document.getElementById('lpSummary');
  const targetMc = parseNumberInput(document.getElementById('targetMarketCap'));
  // Guard against zero / NaN total supply — the form field should never
  // accept that, but if something upstream produced a degenerate value
  // we surface a clear error instead of rendering "Infinity" or "NaN"
  // and proceeding into a broken launch.
  const totalSupply = Number(createdTokenInfo.totalSupply);
  if (!isFinite(totalSupply) || totalSupply <= 0) {
    summary.innerHTML =
      '<p class="has-text-danger"><strong>Invalid token supply.</strong> ' +
      'Please go back to Step 4, fix the total supply, and recreate the token.</p>';
    return;
  }
  const launchedTokenUsd = targetMc / totalSupply;

  // Escape every interpolation that includes user-provided or indexer-
  // sourced text. Token symbols, names, and quote symbols can contain
  // anything (the symbol field is free-form user input; resolvedSymbol
  // comes from on-chain metadata or third-party indexers and is not
  // sanitized at the source).
  const symSafe = escapeHtml(createdTokenInfo.symbol || '');

  let html = `
    <p>Ready to create <strong>${pools.length}</strong> pool${pools.length === 1 ? '' : 's'}
    for <strong>${symSafe}</strong> at <strong>$${launchedTokenUsd.toFixed(8)}</strong>
    per token (${targetMc.toLocaleString()} USD market cap).</p>
    <ul>
  `;
  for (const p of pools) {
    const quoteSafe = escapeHtml(p.resolvedSymbol || p.quoteToken || '');
    const sliceCount = p.distribution.length;
    const externalCount = p.distribution.filter((s) => s.useExternalRecipient && s.recipient).length;
    html += `<li><strong>${quoteSafe}</strong> pool — ${p.supplyPercent}% of supply, `;
    html += `${sliceCount} slice${sliceCount === 1 ? '' : 's'}`;
    if (externalCount > 0) html += ` (${externalCount} to external wallet${externalCount === 1 ? '' : 's'})`;
    html += `</li>`;
  }
  html += `</ul>`;
  html += `<p>Lock liquidity (Burn &amp; Earn): <strong>${document.getElementById('lockPositions').checked ? 'Yes' : 'No'}</strong></p>`;
  summary.innerHTML = html;
}

// ---------------------------------------------------------------------------
// Pre-commit confirmation flow (Milestone C from the price-safety plan)
// ---------------------------------------------------------------------------
//
// Before /api/create-lp runs, we call /api/preflight-create-lp which
// resolves the just-in-time Raydium price for every quote token and
// applies the drift guard against what the user committed to at
// funding time. The user sees the actual initialPrice each pool will
// be created at, and either confirms or cancels.
//
// Two things this gives us beyond Milestone A's server-side safety
// net:
//
//   1. Visibility. The user gets to look at the price before the
//      irreversible click, not just trust that Trebuchet is using
//      the right number.
//
//   2. Tight drift window. The actual /api/create-lp re-probes
//      Raydium (Milestone A), and uses the prices we resolved here
//      as the override reference for its drift guard. So the
//      guard measures movement during the confirmation window
//      (seconds, not minutes), not movement since funding-estimate
//      (which could be hours stale). That's how the drift guard
//      becomes useful for both the long-funding-gap case AND the
//      modal-was-open-too-long case.

// Show the pre-commit confirmation modal. Returns a Promise that
// resolves to the confirmed resolved-prices array (proceed) or null
// (cancel). The body argument is the per-pool list rendered into the
// modal body.
//
// Modal is shown and torn down here; on Confirm we resolve with the
// passed-in prices unchanged (the modal doesn't modify them), on
// Cancel we resolve null.
function showPreflightModal(resolvedPrices) {
  const modal = document.getElementById('createLpConfirmModal');
  const proceedBtn = document.getElementById('createLpConfirmProceedBtn');
  const cancelBtn = document.getElementById('createLpConfirmCancelBtn');
  if (!modal || !proceedBtn || !cancelBtn) {
    // Modal markup missing. The plan's safety-first principle is: when
    // in doubt, REFUSE to launch — silently bypassing the confirmation
    // step would defeat the whole purpose of Milestone C. Resolve null
    // (same as user-cancel) so the launch aborts cleanly without
    // touching chain. The user can fix or reload and retry.
    console.error(
      'createLpConfirmModal markup missing — aborting launch as a safety ' +
      'precaution. This is a bug; please report.',
    );
    log(
      'Cannot launch: confirmation modal is missing. This is a bug ' +
      '— please report it. No SOL was spent.',
      'danger',
    );
    return Promise.resolve(null);
  }

  renderPreflightModalBody(resolvedPrices);

  return new Promise((resolve) => {
    let resolved = false;
    const finish = (val) => {
      if (resolved) return;
      resolved = true;
      modal.classList.remove('is-active');
      proceedBtn.removeEventListener('click', onProceed);
      cancelBtn.removeEventListener('click', onCancel);
      const bg = modal.querySelector('.modal-background');
      if (bg) bg.removeEventListener('click', onCancel);
      resolve(val);
    };
    const onProceed = () => finish(resolvedPrices);
    const onCancel = () => finish(null);
    proceedBtn.addEventListener('click', onProceed);
    cancelBtn.addEventListener('click', onCancel);
    const bg = modal.querySelector('.modal-background');
    if (bg) bg.addEventListener('click', onCancel);
    modal.classList.add('is-active');
  });
}

// Render the body of the pre-commit confirmation modal. One row per
// allocation, showing quote symbol, resolved initialPrice (quote token
// per launched token, e.g. "5e-6 SOL per FROG"), source label, and
// drift indicator when the price moved noticeably from the user's
// funding-estimate value.
function renderPreflightModalBody(resolvedPrices) {
  const list = document.getElementById('createLpConfirmList');
  if (!list) return;

  // Find the user-typed targetMarketCap and total supply to compute
  // the launched-token USD value (same as renderLpSummary). We render
  // the initial price as quote-per-launched-token to match how
  // Raydium presents prices (the user's "1 of my tokens costs X SOL"
  // mental model).
  const targetMc = parseNumberInput(document.getElementById('targetMarketCap'));
  const totalSupply = Number(createdTokenInfo?.totalSupply || 0);
  const launchedTokenUsd =
    isFinite(totalSupply) && totalSupply > 0 && isFinite(targetMc)
      ? targetMc / totalSupply
      : null;

  let html = '';
  for (const rp of resolvedPrices) {
    const symbol = escapeHtml(rp.quoteSymbol || rp.quoteMint || '?');
    const quoteUsdNum = Number(rp.quoteUsd);
    const initialPriceNum = Number(rp.initialPrice);

    // Format both prices reasonably — too many digits is noise, too
    // few hides meaningful precision for low-priced tokens.
    const fmtUsd = (n) =>
      isFinite(n) && n > 0
        ? '$' + n.toLocaleString(undefined, { maximumSignificantDigits: 6 })
        : '—';
    const fmtRatio = (n) =>
      isFinite(n) && n > 0
        ? n.toLocaleString(undefined, { maximumSignificantDigits: 6 })
        : '—';

    // Source label, in plain English. Source vocabulary (matches the
    // funding-estimate + Step-2-cache convention):
    //   'sol'           → SOL/USD oracle
    //   'raydium-probe' → live Raydium swap probe (the canonical answer)
    //   'oracle'        → aggregator (gecko/dexscreener). Several causes
    //                      lead here (probe skipped for known-safe quotes,
    //                      Raydium genuinely has no pool, transient probe
    //                      failure). The honest advice for the user is the
    //                      same in all cases: verify the price. We render
    //                      this as a clickable GeckoTerminal link so the
    //                      user can verify in one click.
    //   'user-override' → user typed a value in customize mode
    //   'unresolved'    → couldn't get any price (shouldn't reach modal)
    //
    // sourceHtml is interpolated raw (not via escapeHtml) so the link can
    // render — non-link branches escape their own content where needed.
    let sourceHtml;
    if (rp.source === 'raydium-probe') {
      sourceHtml = 'verified from Raydium';
    } else if (rp.source === 'sol') {
      sourceHtml = 'SOL/USD oracle';
    } else if (rp.source === 'user-override') {
      sourceHtml = 'user-set price';
    } else if (rp.source === 'oracle') {
      // Render as a clickable GeckoTerminal link. Use the quoteMint
      // from the preflight response (always set for non-SOL pools
      // that reach this branch).
      const mint = rp.quoteMint || '';
      if (mint) {
        const safeMint = encodeURIComponent(mint);
        sourceHtml =
          '<a href="https://www.geckoterminal.com/solana/tokens/' +
          safeMint +
          '" target="_blank" rel="noopener noreferrer" ' +
          'title="Open this token\'s GeckoTerminal page in a new tab">' +
          'verify price ' +
          '<i class="fas fa-external-link-alt is-size-7"></i></a>';
      } else {
        sourceHtml = 'verify price';
      }
    } else {
      sourceHtml = escapeHtml(rp.source || 'unknown source');
    }

    // Drift indicator. driftPct is signed (positive = probe higher
    // than what the user committed at funding). >5% absolute is
    // worth showing; small movements aren't. Wording names the quote
    // symbol explicitly because "Price" alone is ambiguous: the
    // launched token's USD-denominated price is invariant to quote
    // drift (we adjust the pool ratio accordingly), so the only
    // thing actually drifting here is the quote token's USD value.
    let driftLine = '';
    if (rp.driftPct !== null && rp.driftPct !== undefined && Math.abs(rp.driftPct) >= 5) {
      const direction = rp.driftPct > 0 ? 'higher' : 'lower';
      driftLine =
        `<div class="is-size-7 has-text-warning-dark mt-1">` +
          `<i class="fas fa-exclamation-circle"></i> ` +
          `${symbol} price is ${Math.abs(rp.driftPct).toFixed(1)}% ${direction} than ` +
          `the funding estimate — within tolerance, but worth a glance.` +
        `</div>`;
    }

    html += `
      <div class="box p-3 mb-2">
        <div class="is-flex is-justify-content-space-between is-align-items-center">
          <div>
            <strong>${symbol} pool</strong>
            <span class="has-text-grey is-size-7"> · ${sourceHtml}</span>
          </div>
          <div class="has-text-right">
            <div class="is-size-7 has-text-grey">Initial price</div>
            <div><strong>${fmtRatio(initialPriceNum)}</strong>
              <span class="has-text-grey is-size-7"> ${symbol} per token</span></div>
            <div class="is-size-7 has-text-grey">
              ${symbol} ≈ ${fmtUsd(quoteUsdNum)}${
                launchedTokenUsd
                  ? ` · launch ≈ $${launchedTokenUsd.toLocaleString(undefined, { maximumSignificantDigits: 4 })}`
                  : ''
              }
            </div>
          </div>
        </div>
        ${driftLine}
      </div>
    `;
  }
  list.innerHTML = html;
}

// Run /api/preflight-create-lp and show the confirmation modal on
// success. Returns the resolved prices on user-confirm, null on
// user-cancel, or throws on preflight failure (network / pre_flight
// validation / drift guard / no Raydium route / etc).
//
// The caller wraps this in the same withRunState + try/catch as the
// actual create-lp call, so preflight failures route to the same
// failure-rendering code that handles pre_flight from /api/create-lp.
async function runPreflightAndConfirm(allocations, targetMc) {
  log('Verifying current prices…', 'info');
  let resp;
  try {
    resp = await fetch('/api/preflight-create-lp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tokenTotalSupply: createdTokenInfo.totalSupply,
        targetMarketCapUsd: targetMc,
        allocations,
      }),
    });
  } catch (fetchErr) {
    // Network failure (offline, DNS, etc.). Tag as pre_flight so the
    // caller routes us through the proper failure UI, not log-only.
    const err = new Error(
      `Could not reach the Trebuchet server (${fetchErr.message}). ` +
      `Check your internet connection and try again. No SOL was spent.`,
    );
    err.failedPhase = 'pre_flight';
    err.cause = fetchErr;
    throw err;
  }
  let data;
  try {
    data = await resp.json();
  } catch (parseErr) {
    const err = new Error(
      `Preflight returned a non-JSON response (HTTP ${resp.status}). ` +
      `This usually means the server is having trouble. Try again in ` +
      `a moment. No SOL was spent.`,
    );
    err.failedPhase = 'pre_flight';
    err.cause = parseErr;
    throw err;
  }
  if (!data.success) {
    // The server already tagged this as pre_flight. Throw with the
    // same shape so the caller's existing failure-rendering code
    // surfaces it correctly.
    const err = new Error(data.error || 'Preflight failed');
    err.failedPhase = data.failedPhase || 'pre_flight';
    err.failedAllocationIndex = data.failedAllocationIndex;
    err.failedAllocation = data.failedAllocation;
    err.probeCode = data.probeCode;
    throw err;
  }

  if (!data.preflight || !Array.isArray(data.preflight.resolvedPrices)) {
    // Server returned success:true but a malformed payload. Shouldn't
    // happen, but guard against it cleanly so the user gets a tagged
    // error and proper UI rather than a TypeError dropped into log.
    const err = new Error(
      'Preflight returned an unexpected response shape. This is a bug; ' +
      'please report it. No SOL was spent.',
    );
    err.failedPhase = 'pre_flight';
    throw err;
  }
  if (data.preflight.resolvedPrices.length === 0) {
    // Empty resolvedPrices means there were no allocations. The
    // frontend gates against this in updateContinueToFundingState
    // already (Continue button is disabled with no pools), so this
    // shouldn't be reachable — but guard against it anyway.
    const err = new Error(
      'No pools to confirm. Add at least one pool and try again.',
    );
    err.failedPhase = 'pre_flight';
    throw err;
  }

  return await showPreflightModal(data.preflight.resolvedPrices);
}

bind('createLpBtn', 'click', async () => {
  const btn = document.getElementById('createLpBtn');
  await withRunState(async () => {
    setLoading(btn, true);
    markLaunchActiveForRpcHealth(true);
    try {
      // Hide any stale failure banner from a prior attempt. This matters
      // for the pre-flight-retry case: if the previous attempt failed in
      // pre-flight and the user fixed their allocation, the failure
      // notification needs to go away when they re-click Create Pools so
      // they don't see "Validation failed..." next to a now-running launch.
      document.getElementById('lpFailInfo').classList.add('hidden');

      const allocations = buildAllocationsForApi();
      const targetMc = parseNumberInput(document.getElementById('targetMarketCap'));
      const lockPositions = document.getElementById('lockPositions').checked;

      // Pre-commit confirmation flow (Milestone C). Runs the just-in-time
      // Raydium probe + drift guard on the server, shows the user the
      // resolved initialPrice for each pool, and asks them to confirm.
      // The preflight throws on any pre_flight failure (no route, network,
      // drift > threshold), which the outer catch handles the same way
      // it handles pre_flight failures from /api/create-lp.
      //
      // We DON'T reveal lpProgress until after the user confirms — showing
      // an empty progress panel beneath the modal while they're reading
      // prices is confusing. If the user cancels or preflight throws, we
      // never reveal it.
      let confirmedPrices;
      try {
        confirmedPrices = await runPreflightAndConfirm(allocations, targetMc);
      } catch (preflightErr) {
        // Re-throw so the outer catch in this handler routes the
        // failure to the pre_flight UI branch. The preflightErr
        // already has failedPhase='pre_flight'.
        throw preflightErr;
      }

      if (confirmedPrices === null) {
        // User clicked Cancel. lpProgress was never revealed (we wait
        // until after confirmation to show it), so there's nothing to
        // clean up — just log and return.
        log('Pool creation cancelled — no SOL spent.', 'info');
        return;
      }

      // Override each allocation's quoteUsdOverride with the exact
      // price the user just confirmed in the modal. This pins what
      // the user saw to what the launch will use, and means the
      // create-lp probe's drift guard measures movement during the
      // confirmation window (seconds), not since funding-estimate
      // (potentially hours).
      for (const cp of confirmedPrices) {
        // Validate allocationIndex strictly — Number.isInteger rejects
        // undefined/null/NaN/strings, which would otherwise slip through
        // the bounds check (NaN comparisons return false in both
        // directions) and crash on the property write below.
        if (!Number.isInteger(cp.allocationIndex)) continue;
        if (cp.allocationIndex < 0 || cp.allocationIndex >= allocations.length) continue;
        // Only overwrite if the preflight successfully resolved a
        // price for this allocation. (It should — preflight throws
        // otherwise.)
        if (cp.quoteUsd !== null && cp.quoteUsd !== undefined) {
          allocations[cp.allocationIndex].quoteUsdOverride = Number(cp.quoteUsd);
        }
      }

      // User confirmed — reveal the progress panel and clear any stale
      // tree content from a prior attempt.
      document.getElementById('lpProgress').classList.remove('hidden');
      document.getElementById('lpProgressTree').innerHTML = '';

      log(`Starting pool creation for ${pools.length} pool(s)...`);
      addProgressIntro();
      buildPhaseProgressTree(pools, lockPositions);
      // Fresh launch: clear any published-report record from a prior run so the
      // step-5 publish fires (its idempotency guard skips 'pending'/'done') and
      // the success modal shows THIS launch's report rather than a stale one.
      _publishedReport = null;

      // Start the LP progress poll just before the fetch so per-step
      // events translate to row checkmarks in real time (instead of all
      // rows flipping at once when the response lands). Both demo and
      // real launches feed the server-side tracker now.
      if (tempWallet && tempWallet.publicKey) {
        startLpProgressPoll(tempWallet.publicKey);
      }
      let resp;
      try {
        resp = await fetch('/api/create-lp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            walletPublicKey: tempWallet.publicKey,
            // F5: the server resolves the secret from its encrypted store using
            // the public key for real launches; only demo mode (in-memory
            // ledger, no server-side secret) still sends the key inline.
            ...(demoModeActive ? { tempWalletSecretKey: tempWallet.secretKey } : {}),
            tokenMint: createdTokenInfo.mint,
            tokenDecimals: createdTokenInfo.decimals,
            tokenTotalSupply: createdTokenInfo.totalSupply,
            targetMarketCapUsd: targetMc,
            allocations,
            lockPositions,
            // Airdrop plan (or absent when none configured). The server
            // doesn't act on it here — it journals it under
            // poolPlan.airdropPlan so a launch resumed after an app
            // restart still carries the configured airdrop into the
            // final transfer. Without this, the airdrop config would be
            // lost with the frontend's memory and the resumed transfer
            // would silently skip it.
            ...((() => {
              const plan = buildAirdropTransferPayload();
              return plan ? { airdrop: plan } : {};
            })()),
          }),
        });
      } finally {
        // Always tear down the poll — even on a fetch failure, leaving
        // the poll running would just pile up empty responses.
        stopLpProgressPoll();
      }
      // The /api/create-lp endpoint returns JSON for both success (200)
      // and structured failure (500 with body). A non-JSON 5xx response
      // means something upstream of the route handler died (express
      // crashed, proxy returned an error page, etc) and the user
      // shouldn't see the cryptic "Unexpected token < in JSON" they'd
      // get from a blind resp.json().
      let data;
      try {
        data = await resp.json();
      } catch (parseErr) {
        if (!resp.ok) {
          throw new Error(
            `Server returned HTTP ${resp.status} with non-JSON body. ` +
            `This usually means the server crashed or a proxy intervened. ` +
            `Check the server console for details.`,
          );
        }
        throw new Error(`Unexpected response: ${parseErr.message}`);
      }

      if (resp.status === 409 && data.code === 'OP_IN_FLIGHT') {
        // Another launch operation is already running for this wallet —
        // usually a prior create-lp that survived a UI reload (the server
        // runs in-process with Electron main, so the launch keeps going
        // even if the page reloads). Do NOT render this as a launch
        // failure; the launch isn't failed, it's running. Reattach the
        // progress poll so the user can watch it, and keep them away
        // from the retry buttons.
        log(data.error, 'warning');
        log(
          'Reattached to the running operation — progress will update ' +
          'below as it proceeds. Do not close the app.',
          'warning',
        );
        if (tempWallet && tempWallet.publicKey) {
          startLpProgressPoll(tempWallet.publicKey);
        }
        return;
      }

      if (data.success) {
        lpResult = data;
        data.results.forEach((r, i) => markPoolDone(i, r));
        markAllBootstrapsDone();
        log(`All ${data.results.length} pool(s) created and bootstrapped`, 'success');
        setLpDoneVisible(true);
        document.getElementById('lpDoneSummary').innerHTML = buildLpDoneSummary(data.results);
        renderLaunchReportPreview('step5');
        // NOTE: the permanent launch report is NOT published here anymore.
        // It publishes during step 6 (runTransfer), after the airdrop and
        // before the sweep — at that point every on-chain token-setup
        // transaction has landed, so the permanent record includes the
        // actual airdrop delivery results instead of a forever-"pending"
        // section. The step-5 preview below still shows the report;
        // pending sections render as pending until then.
        // Hide the Create Pools button — re-clicking would attempt to create
        // duplicate pools for the same token, which is wasteful and confusing.
        document.getElementById('createLpBtn').classList.add('hidden');
      } else {
        // Phase-aware partial-failure rendering. The orchestrator returns
        // failedPhase = 'pre_flight', 'main_positions', 'bootstrap', 'locks',
        // or 'transfers' so we can mark the right rows as failed without
        // misrepresenting what completed.
        //
        // Under the deferred-lock model:
        //   - 'main_positions': pool may have been created, slice opens failed
        //   - 'bootstrap': mains opened in every pool, some bootstraps failed
        //   - 'locks': all opens succeeded across all pools, some locks failed
        //   - 'transfers': all opens + locks succeeded, some Fee Key transfers
        //     failed (non-blocking — leftover NFTs sweep back to user)
        lpResult = { results: data.partialResults || [] };
        const failedPhase = data.failedPhase || 'main_positions';

        if (failedPhase === 'pre_flight') {
          // Validation failed BEFORE any pool was created — nothing is on
          // chain yet. Mark only the offending allocation as failed; the
          // others stay as "pending" since they were never attempted.
          // The lpFailInfo notification surfaces the reason (typically a
          // Token-2022 mint with extensions Raydium doesn't support).
          if (data.failedAllocationIndex != null) {
            markPoolFailed(data.failedAllocationIndex, data.error);
          }
        } else if (failedPhase === 'main_positions') {
          // Pools whose main positions completed successfully; the failed
          // pool's main row gets the failure marker. No bootstraps ran yet.
          (data.partialResults || []).forEach((r) => {
            markPoolDone(r.allocationIndex, r);
          });
          if (data.failedAllocationIndex != null) {
            markPoolFailed(data.failedAllocationIndex, data.error);
          }
        } else if (failedPhase === 'bootstrap') {
          // All main positions completed; bootstrapping failed partway.
          // Mark every pool's main rows as done, then mark each bootstrap
          // row done if its result entry has a populated bootstrap field,
          // and mark every failed pool's bootstrap as failed.
          (data.partialResults || []).forEach((r) => {
            markPoolDone(r.allocationIndex, r);
            if (r.bootstrap) markBootstrapDoneForPool(r.allocationIndex, r.bootstrap);
          });
          // bootstrapFailures is an array of { allocationIndex, quoteSymbol, error }
          // for each bootstrap that failed. Falls back to failedAllocationIndex
          // for backward compatibility with older error shapes that didn't carry
          // the array.
          const failures = data.bootstrapFailures
            || (data.failedAllocationIndex != null
              ? [{ allocationIndex: data.failedAllocationIndex, error: data.error }]
              : []);
          for (const f of failures) {
            markBootstrapFailedForPool(f.allocationIndex, f.error);
          }
        } else if (failedPhase === 'locks' || failedPhase === 'transfers') {
          // All pools, mains, and bootstraps are open on-chain. The failure
          // is in the post-open lock or transfer phase. Mark every pool's
          // main and bootstrap rows as done (they did open successfully),
          // but leave the per-position lock/transfer markers in their
          // current state — the partialResults entries carry per-position
          // `locked` and `transferredTo` flags that the progress tree could
          // be enhanced to read from later. For now the user sees a clear
          // recovery message via lpFailInfo below.
          (data.partialResults || []).forEach((r) => {
            markPoolDone(r.allocationIndex, r);
            if (r.bootstrap) markBootstrapDoneForPool(r.allocationIndex, r.bootstrap);
          });
        }

        log(`Pool creation failed (phase: ${failedPhase}): ${data.error}`, 'danger');
        document.getElementById('lpFailInfo').classList.remove('hidden');

        // Friendlier error summary. The raw on-chain error message is often
        // an opaque JSON blob ("InstructionError: [2, {Custom: 2022}]"); if
        // we recognize a known pattern, translate it into something a human
        // can act on. Otherwise pass through the original.
        const rawErr = String(data.error || 'unknown error');
        let friendly = rawErr;
        if (failedPhase === 'pre_flight') {
          // Pre-flight errors are already human-readable (we wrote them).
          // Pass through verbatim — they typically explain exactly which
          // unsupported Token-2022 extensions were detected.
          friendly = rawErr;
        } else if (/Custom["':]\s*2022/.test(rawErr)) {
          friendly =
            'Anchor constraint violation (code 2022, ConstraintMintTokenProgram) — ' +
            'this means a Token-2022 mint was passed where the SPL Token program was ' +
            'expected. This commonly happens with pump.fun tokens and other Token-2022 ' +
            'mints. The latest build should detect these automatically; if you\'re ' +
            'still seeing this, the quote token may have an unusual extension that\'s ' +
            'not yet supported.';
        } else if (/insufficient.*lamports|0x1.*lamports/i.test(rawErr)) {
          friendly =
            'The ephemeral wallet ran out of SOL partway through. Cost variance ' +
            'on this launch exceeded the safety buffer.';
        }
        document.getElementById('lpFailSummary').textContent = friendly;

        // Render structured error with category badge + "What happened?"
        const lpFailContainer = document.getElementById('lpFailInfo').querySelector('.notification');
        if (lpFailContainer) {
          // Clear any previous structured error block
          const prevBanner = lpFailContainer.querySelector('.error-banner');
          if (prevBanner) prevBanner.remove();
          renderStructuredError(lpFailContainer, friendly, categorizeError(friendly));
        }

        // Show counts so the user knows what state things are in. These are
        // useful for understanding what they're recovering vs what they've
        // permanently put on-chain.
        const successCount = (data.partialResults || []).length;
        const totalCount = pools.length;
        const failedAlloc = data.failedAllocation;
        const failedSymbol = failedAlloc?.quoteSymbol
          || failedAlloc?.quoteToken
          || `allocation ${data.failedAllocationIndex}`;

        if (failedPhase === 'pre_flight') {
          // Nothing was attempted on chain. Tell the user this is a clean
          // abort — no SOL spent, no on-chain artifacts to clean up. The
          // "Skip to Transfer Assets" path is still available (they may
          // want to abandon and try over) but the primary recovery is
          // just to fix the allocation and re-click Create Pools.
          document.getElementById('lpFailHeading').textContent =
            'Validation failed before pool creation started.';
          document.getElementById('lpFailSucceededCount').innerHTML =
            `Nothing has been created on-chain yet — the failure is in ` +
            `the pre-launch validation of <strong>${escapeHtml(failedSymbol)}</strong>. ` +
            `Fix or remove this allocation and click Create Pools again; no SOL was spent.`;
          document.getElementById('lpFailReassurance').innerHTML =
            `<strong>No on-chain side effects.</strong> The ephemeral wallet still holds ` +
            `everything it did before you clicked Create Pools (SOL, any auto-swapped ` +
            `quote tokens). You can either fix the failing allocation above and retry, ` +
            `or sweep everything back to your destination wallet.`;
          document.getElementById('continueToTransferAfterFailBtnLabel').textContent =
            'Or sweep wallet to destination';
        } else {
          // Mid-launch failure — at least one pool was created and the
          // on-chain state can't be rolled back. Distinguish by phase:
          //   - 'bootstrap':  pools created, missing bootstraps. Recoverable
          //                   in place via Retry bootstraps.
          //   - 'locks':      all opens done across every pool, some locks
          //                   failed. Resume retries just the unlocked.
          //   - 'transfers':  all locks done, some Fee Key transfers failed.
          //                   Non-blocking — leftover NFTs sweep back to user.
          //   - 'main_positions' (default fallback): a slice open failed.
          //                   Not recoverable in place; must sweep and start
          //                   over (mid-Phase-1 partial recovery is a wider
          //                   refactor not done yet).
          let heading;
          if (failedPhase === 'bootstrap') {
            heading = 'Some pools couldn\'t be bootstrapped.';
          } else if (failedPhase === 'locks') {
            heading = 'Some positions couldn\'t be locked.';
          } else if (failedPhase === 'transfers') {
            heading = 'Some Fee Key transfers couldn\'t be delivered.';
          } else {
            heading = 'Pool creation failed partway through.';
          }
          document.getElementById('lpFailHeading').textContent = heading;
          document.getElementById('lpFailSucceededCount').innerHTML =
            `<strong>${successCount} of ${totalCount}</strong> pool${successCount === 1 ? '' : 's'} ` +
            `created successfully before the failure on <strong>${escapeHtml(failedSymbol)}</strong>. ` +
            `The created pools are permanent on-chain; their LP NFTs are in your ephemeral wallet.`;
          if (failedPhase === 'bootstrap') {
            // Bootstrap-only failures: pools and main positions are all
            // good, just the bootstrap leg is missing on some. Retrying
            // is safe and the typical fix.
            document.getElementById('lpFailReassurance').innerHTML =
              `<strong>Main positions are in place for every pool.</strong> Only the bootstrap ` +
              `leg failed for the pools listed above — these pools won't be tradable at the ` +
              `intended price until their bootstraps land. Click <strong>Retry bootstraps</strong> ` +
              `to try again (most bootstrap failures are transient RPC issues). If retrying ` +
              `keeps failing, sweep the wallet to your destination and manually add bootstrap ` +
              `liquidity in the Raydium UI later.`;
          } else if (failedPhase === 'locks') {
            // Lock-phase failures: every pool's main and bootstrap positions
            // are open on-chain (and the bootstraps make the pools tradable).
            // The positions just haven't been locked yet, which means the
            // ephemeral wallet can still close them — assets are recoverable
            // either by completing the locks or by sweeping the wallet back
            // (which would also close the open positions).
            document.getElementById('lpFailReassurance').innerHTML =
              `<strong>Every pool is open and tradable.</strong> The missing step is the lock — ` +
              `until locks finish, the LP'd tokens are still recoverable by the launch wallet. ` +
              `Click <strong>Resume launch</strong> to try the remaining locks again (most lock ` +
              `failures are transient RPC issues). If locks keep failing and you'd rather walk ` +
              `away, sweep the wallet to your destination — the open positions get closed and ` +
              `their LP tokens come back with the sweep.`;
          } else if (failedPhase === 'transfers') {
            // Transfer-phase failures are non-blocking conceptually: every
            // pool is locked successfully, only the courtesy of delivering
            // Fee Key NFTs to recipient addresses didn't complete. The
            // un-transferred NFTs are in the launch wallet and will sweep
            // to the user's destination wallet.
            document.getElementById('lpFailReassurance').innerHTML =
              `<strong>The launch itself succeeded.</strong> Every pool is created, tradable, and ` +
              `locked. The only thing that didn't finish was the delivery of Fee Key NFTs to ` +
              `recipient addresses you specified. Those NFTs are in your launch wallet and will ` +
              `come along with the final sweep to your destination wallet, so nothing is lost. ` +
              `You can manually send them to the intended recipients afterward, or click ` +
              `<strong>Resume launch</strong> to try the deliveries again.`;
          } else {
            // Main-positions failure: at least one pool was created but
            // its main positions couldn't be opened (or the next pool
            // couldn't be created). The resume endpoint can pick up
            // from where the failure happened — completed pools are
            // skipped, only the missing work is retried.
            document.getElementById('lpFailReassurance').innerHTML =
              `<strong>Your assets are safe</strong> — they're still in the ephemeral wallet ` +
              `(SOL, any auto-swapped quote tokens, and the LP NFTs from pools that did succeed). ` +
              `Click <strong>Resume launch</strong> to retry just the missing pools — already-` +
              `created pools will be skipped. If retrying keeps failing, you can sweep the wallet ` +
              `back to your destination as a last resort; the pools that succeeded above are ` +
              `permanent on-chain.`;
          }
          // Continue/sweep button label. For 'bootstrap' and 'locks',
          // the user has unfinished work that retry can fix in place,
          // so the sweep alternative reads as a secondary "give up"
          // option ("Or sweep to destination instead"). For 'transfers'
          // and the default main_positions case, the alternative IS
          // the primary recovery path (sweep collects everything),
          // so it reads as "Skip to Transfer Assets".
          document.getElementById('continueToTransferAfterFailBtnLabel').textContent =
            (failedPhase === 'bootstrap' || failedPhase === 'locks')
              ? 'Or sweep to destination instead'
              : 'Skip to Transfer Assets';
        }

        // Resume button visibility: meaningful for any post-pre-flight
        // failure (main_positions, bootstrap, locks, transfers). The
        // button calls a unified /api/resume-launch endpoint that
        // inspects per-position state in priorResults and skips any
        // operation already done. Pre-flight failures don't need the
        // button — the user fixes the config and re-clicks Create Pools.
        const retryBtn = document.getElementById('retryBootstrapsBtn');
        const retryLabel = retryBtn.querySelector('span:last-child');
        if (failedPhase !== 'pre_flight') {
          retryBtn.classList.remove('hidden');
          // Phase-specific label. Bootstrap gets its own verb ("Retry
          // bootstraps") because that's the established muscle memory
          // for that case; everything else uses the generic "Resume launch"
          // since the resume endpoint will figure out what to do.
          if (retryLabel) {
            retryLabel.textContent = failedPhase === 'bootstrap'
              ? 'Retry bootstraps'
              : 'Resume launch';
          }
          // Stash the data the retry endpoint needs. We pull it back out
          // in the click handler instead of closing over it — the click
          // handler is registered once at module load and shouldn't
          // capture stale state from a specific failure.
          retryBtn.dataset.lockPositions = String(lockPositions);
        } else {
          retryBtn.classList.add('hidden');
        }

        // For mid-launch failures, hide the Create Pools button — pools
        // that were created already are immutable, and re-clicking would
        // attempt to create duplicate pools for the same token (wasteful
        // and confusing). Recovery is via "Skip to Transfer Assets".
        //
        // For pre-flight failures, KEEP the button visible — nothing was
        // attempted on chain. The user just needs to fix their allocation
        // (remove the incompatible quote, swap to a different mint, or
        // fix RPC settings) and click Create Pools again. Hiding the
        // button here would force them into "Skip to Transfer Assets",
        // wasting the SOL they already spent on token creation.
        if (failedPhase !== 'pre_flight') {
          document.getElementById('createLpBtn').classList.add('hidden');
        }
      }
    } catch (e) {
      // Mark the launch as no-longer-active for RPC health tracking,
      // regardless of which error path we take. The price-safety
      // pre_flight UI routing below decides how to surface the error
      // to the user; this is bookkeeping that runs either way.
      markLaunchActiveForRpcHealth(false);

      // If runPreflightAndConfirm threw a preflight-tagged error, route
      // it to the lpFailInfo panel with the standard pre_flight UI
      // treatment. Without this, preflight failures (NO_ROUTE,
      // NETWORK_ERROR, drift > 25%) would only surface as a log line —
      // losing the "no SOL spent, fix and retry" guidance and leaving
      // the progress UI in a half-rendered state.
      //
      // We detect the case via e.failedPhase, which only the preflight
      // throw sets (a generic JS throw won't have it). All preflight
      // throws are 'pre_flight' by definition (no on-chain action has
      // happened yet), so the rendering is much simpler than the
      // /api/create-lp branch which handles many phases.
      if (e && e.failedPhase === 'pre_flight') {
        // lpProgress was never revealed (we wait until after user
        // confirms), so there's nothing to hide.

        // Mark the offending allocation as failed in the pool list.
        // Other allocations stay in their pre-launch state since they
        // were never attempted.
        if (e.failedAllocationIndex != null) {
          markPoolFailed(e.failedAllocationIndex, e.message);
        }

        // Populate the lpFailInfo panel with the same messaging the
        // /api/create-lp pre_flight branch uses, then reveal it.
        const failedSymbol =
          e.failedAllocation?.quoteSymbolOverride
          || e.failedAllocation?.quoteToken
          || (e.failedAllocationIndex != null
              ? `allocation ${e.failedAllocationIndex + 1}`
              : 'an allocation');

        document.getElementById('lpFailSummary').textContent = e.message;
        document.getElementById('lpFailHeading').textContent =
          'Validation failed before pool creation started.';
        document.getElementById('lpFailSucceededCount').innerHTML =
          `Nothing has been created on-chain yet — the failure is in ` +
          `the pre-launch validation of <strong>${escapeHtml(failedSymbol)}</strong>. ` +
          `Fix or remove this allocation and click Create Pools again; no SOL was spent.`;
        // The reassurance block normally explains sweep / recovery. For
        // pre_flight there's nothing to sweep — surface that explicitly.
        const reassuranceEl = document.getElementById('lpFailReassurance');
        if (reassuranceEl) {
          reassuranceEl.innerHTML =
            '<strong>No SOL was spent.</strong> The ephemeral wallet has not been touched. ' +
            'Edit the pool configuration above and try again.';
        }
        document.getElementById('lpFailInfo').classList.remove('hidden');

        // Keep the Create Pools button visible. The user just needs to
        // fix the allocation (refresh funding estimate, pick a different
        // quote token, retry on transient network) and re-click. Hiding
        // it would force them into "Skip to Transfer Assets," which is
        // the wrong recovery for a failure that didn't touch chain.

        log(`Pre-flight check failed: ${e.message}`, 'danger');
      } else {
        log(`LP creation failed: ${e.message}`, 'danger');
      }
    } finally {
      setLoading(btn, false);
    }
  });
});

// Build the entire progress tree as four phase blocks, matching the
// orchestrator's execution order:
//
//   Phase 1 — Create pools and open main positions
//   Phase 2 — Open bootstrap positions
//   Phase 3 — Lock positions (only when lockPositions=true)
//   Phase 4 — Transfer Fee Keys to recipients (only when at least one
//             slice has an external recipient AND lockPositions=true,
//             since Fee Keys only exist for locked positions)
//
// Within each phase, rows are listed pool-by-pool (Pool 1 things, then
// Pool 2 things, etc.). This is the structure that matches what the
// orchestrator actually does and produces a coherent narrative when the
// user reads top-to-bottom after a launch completes.
//
// Rows are uniquely identified by data-pool-idx + data-stage attributes
// rather than per-pool container IDs, so marker functions can query each
// row independently regardless of which phase block it lives in.
// Step 5's "pools created" UI is split across the two columns: the result
// summary notification sits under the preview card on the right, while the
// action buttons (Continue to Final Transfer, report preview) live in the
// left column where the primary action sits on every other step. They must
// appear and disappear together, so every show/hide goes through here.
function setLpDoneVisible(visible) {
  document.getElementById('lpDoneInfo')?.classList.toggle('hidden', !visible);
  document.getElementById('lpDoneActions')?.classList.toggle('hidden', !visible);
  // The report preview now lives full-width below the two-column layout
  // (outside #lpDoneActions), so include it here to hide on reset.
  document.getElementById('step5ReportPreview')?.classList.toggle('hidden', !visible);
}

function buildPhaseProgressTree(pools, lockPositions) {
  const tree = document.getElementById('lpProgressTree');

  // Wrap a phase's rows in a collapsible block: clickable header (with
  // toggle chevron + title + "done / total" counter) and a slim progress
  // bar that stay visible, plus a body div — holding the description line
  // and the actual .progress-step rows — that starts collapsed. Keeping
  // the description inside the collapsed body (rather than always-on)
  // keeps the at-a-glance view to just headers + bars, so a multi-pool
  // launch isn't a tall wall of prose and rows before anything happens.
  // Clicking the header expands it; any failure auto-expands via markPoolFailed.
  //
  // total is derived from rowsHtml by counting "progress-step" markers
  // in the string. Stable because the row HTML is built from fixed
  // template literals just above each call to this helper.
  const wrapPhase = (id, title, description, rowsHtml) => {
    const total = (rowsHtml.match(/class="progress-step/g) || []).length;
    return `
      <button class="phase-header" type="button" data-phase-target="${id}-body">
        <span class="phase-toggle">▶</span>
        <span class="phase-title">${title}</span>
        <span class="phase-counter" id="${id}-counter">0 / ${total}</span>
      </button>
      <progress class="phase-bar" id="${id}-bar" value="0" max="${total || 1}"></progress>
      <div class="phase-body collapsed" id="${id}-body">
        <p class="phase-desc">${description}</p>
        ${rowsHtml}
      </div>
    `;
  };

  // Ladder context — same for every pool in the simple-UI flow (ladder
  // is currently a global toggle, not per-pool). Read from simpleConfig
  // rather than threading it through from the caller; the tree is built
  // at click time when the config is current. In customize mode the
  // ladder is always off (no per-pool ladder UI yet).
  const ladderEnabled =
    simpleConfig.mode === 'default' && simpleConfig.ladderEnabled;
  const ladderBandCount = ladderEnabled
    ? Number(simpleConfig.ladderBandCount) || LADDER_DEFAULT_BANDS
    : 0;

  // --- Phase 1: pool creates + main opens + ladder opens + support opens
  const phase1 = document.createElement('div');
  phase1.className = 'progress-pool';
  phase1.id = 'pp-phase1';
  let phase1Rows = '';
  pools.forEach((p, i) => {
    const label = `Pool ${i + 1} (${p.resolvedSymbol || p.quoteToken})`;
    const sliceCount = p.distribution.length;
    // Per-pool ladder band count: in customize mode each pool has its
    // own ladder config; in simple mode the simpleConfig values apply
    // uniformly. The progress tree always uses the per-pool value so
    // it matches what createSinglePool will actually do.
    const poolLadderBandCount = (p.ladderConfig?.mode === 'manual'
      && Array.isArray(p.ladderConfig.bands))
      ? p.ladderConfig.bands.length
      : ladderBandCount;
    // Per-pool support presence: support adds one progress row per
    // pool that has it configured. In simple mode the user's launch-
    // level total SOL is split equally across pools (same pattern as
    // bootstrap) so every pool typically gets a row. In customize
    // mode the user controls support per-pool. Either way, we read
    // each pool's supportConfig and add the row when needed.
    const poolHasSupport = p.supportConfig?.mode === 'custom'
      && Number(p.supportConfig.solValue) > 0;
    phase1Rows += `<div class="progress-step pending" data-pool-idx="${i}" data-stage="pool"><span class="icon">◯</span>${label} — Create pool</div>`;
    for (let s = 0; s < sliceCount; s++) {
      phase1Rows += `<div class="progress-step pending" data-pool-idx="${i}" data-stage="slice-${s}"><span class="icon">◯</span>${label} — Open slice ${s + 1} of ${sliceCount}</div>`;
    }
    // Ladder bands per pool, ordered low-to-high (band 1 = closest to launch)
    for (let b = 0; b < poolLadderBandCount; b++) {
      phase1Rows += `<div class="progress-step pending" data-pool-idx="${i}" data-stage="ladder-${b}"><span class="icon">◯</span>${label} — Open ladder band ${b + 1} of ${poolLadderBandCount}</div>`;
    }
    if (poolHasSupport) {
      phase1Rows += `<div class="progress-step pending" data-pool-idx="${i}" data-stage="support-open"><span class="icon">◯</span>${label} — Open support position</div>`;
    }
  });
  phase1.innerHTML = wrapPhase(
    'pp-phase1',
    'Phase 1 — Open main positions',
    'Pools are created and main positions opened (single-sided in your token). Positions are recoverable by the launch wallet until Phase 3 locks them.',
    phase1Rows,
  );
  tree.appendChild(phase1);

  // SOL-paired pools are processed LAST in Phase 2 (bootstrap opens) and
  // Phase 3 (locks) — see lpService.js for the launch-economics reasoning
  // (we want every flywheel tradable before the SOL pool flips). The
  // frontend phase-tree display must mirror that order so the visual
  // plan matches the actual execution order; otherwise the progress
  // checkmarks would tick on in a different order than the rows
  // appear, which is jarring. Stable sort preserves user-config order
  // within each group (non-SOL pools keep their order, SOL pools go to
  // the end in their original relative order).
  //
  // Phase 1 (main opens) and Phase 4 (fee key transfers) are NOT
  // reordered — the server doesn't reorder them either, so their
  // user-config order already matches execution.
  const isSolPool = (p) => (p.quoteToken || '').toUpperCase() === 'SOL';
  const solLastOrder = pools
    .map((_, idx) => idx)
    .sort((a, b) => Number(isSolPool(pools[a])) - Number(isSolPool(pools[b])));

  // --- Phase 2: bootstrap opens
  const phase2 = document.createElement('div');
  phase2.className = 'progress-pool';
  phase2.id = 'pp-phase2';
  let phase2Rows = '';
  solLastOrder.forEach((i) => {
    const p = pools[i];
    const label = `Pool ${i + 1} (${p.resolvedSymbol || p.quoteToken})`;
    phase2Rows += `<div class="progress-step pending" data-pool-idx="${i}" data-stage="bs-open"><span class="icon">◯</span>${label} — Open bootstrap</div>`;
  });
  phase2.innerHTML = wrapPhase(
    'pp-phase2',
    'Phase 2 — Open bootstrap positions',
    'Each pool becomes tradable as its bootstrap lands. SOL-paired pools are bootstrapped last so every flywheel pool is already tradable when the SOL pool flips — that way the first SOL-paired swap activates the flywheel as designed.',
    phase2Rows,
  );
  tree.appendChild(phase2);

  // --- Phase 3: locks (mains, then ladder bands, then bootstrap — per pool)
  // Skipped entirely when lockPositions=false — there will be no locked
  // positions and so no Phase 3 work; rendering the rows would mislead
  // the user into thinking Phase 3 runs when the orchestrator actually
  // bypasses it.
  if (lockPositions) {
    const phase3 = document.createElement('div');
    phase3.className = 'progress-pool';
    phase3.id = 'pp-phase3';
    let phase3Rows = '';
    solLastOrder.forEach((i) => {
      const p = pools[i];
      const label = `Pool ${i + 1} (${p.resolvedSymbol || p.quoteToken})`;
      const sliceCount = p.distribution.length;
      // Same per-pool ladder count + support detection as Phase 1, so
      // the phase rows are perfectly symmetric and the lock progress
      // matches what got opened.
      const poolLadderBandCount = (p.ladderConfig?.mode === 'manual'
        && Array.isArray(p.ladderConfig.bands))
        ? p.ladderConfig.bands.length
        : ladderBandCount;
      const poolHasSupport = p.supportConfig?.mode === 'custom'
        && Number(p.supportConfig.solValue) > 0;
      for (let s = 0; s < sliceCount; s++) {
        phase3Rows += `<div class="progress-step pending" data-pool-idx="${i}" data-stage="lock-${s}"><span class="icon">◯</span>${label} — Lock slice ${s + 1}</div>`;
      }
      for (let b = 0; b < poolLadderBandCount; b++) {
        phase3Rows += `<div class="progress-step pending" data-pool-idx="${i}" data-stage="ladder-lock-${b}"><span class="icon">◯</span>${label} — Lock ladder band ${b + 1}</div>`;
      }
      if (poolHasSupport) {
        phase3Rows += `<div class="progress-step pending" data-pool-idx="${i}" data-stage="support-lock"><span class="icon">◯</span>${label} — Lock support position</div>`;
      }
      phase3Rows += `<div class="progress-step pending" data-pool-idx="${i}" data-stage="bs-lock"><span class="icon">◯</span>${label} — Lock bootstrap</div>`;
    });
    phase3.innerHTML = wrapPhase(
      'pp-phase3',
      'Phase 3 — Lock positions',
      "Locks burn the position NFTs and mint Fee Key NFTs. After this, the LP'd tokens are committed for life and only fees can be claimed. Failures are retryable in place.",
      phase3Rows,
    );
    tree.appendChild(phase3);

    // --- Phase 4: transfers — only render if at least one slice has a recipient
    const anyRecipient = pools.some((p) =>
      p.distribution.some((d) => d.useExternalRecipient && d.recipient),
    );
    if (anyRecipient) {
      const phase4 = document.createElement('div');
      phase4.className = 'progress-pool';
      phase4.id = 'pp-phase4';
      let phase4Rows = '';
      pools.forEach((p, i) => {
        const label = `Pool ${i + 1} (${p.resolvedSymbol || p.quoteToken})`;
        const sliceCount = p.distribution.length;
        for (let s = 0; s < sliceCount; s++) {
          if (p.distribution[s].useExternalRecipient && p.distribution[s].recipient) {
            phase4Rows += `<div class="progress-step pending" data-pool-idx="${i}" data-stage="xfer-${s}"><span class="icon">◯</span>${label} — Transfer slice ${s + 1} Fee Key to recipient</div>`;
          }
        }
      });
      phase4.innerHTML = wrapPhase(
        'pp-phase4',
        'Phase 4 — Transfer Fee Keys to recipients',
        'Sends the Fee Key NFTs for slices with external recipients to those recipient addresses. Transfer failures are non-blocking — any undelivered Fee Keys sweep back to your destination wallet at the end.',
        phase4Rows,
      );
      tree.appendChild(phase4);
    }
  }

  // Wire click-to-toggle on every phase header we just rendered. Single
  // pass at the end keeps the build linear and lets the helper handle
  // all four phases (plus any future ones) uniformly.
  _wirePhaseHeaders();
}

// Toggle a phase block expanded/collapsed. Idempotent: clicking a
// header on an already-expanded phase collapses it; safe to call from
// auto-expand-on-failure too (calling it when already expanded is a no-op
// via the explicit add/remove pattern).
function _wirePhaseHeaders() {
  const headers = document.querySelectorAll('#lpProgressTree .phase-header');
  headers.forEach((h) => {
    if (h._wired) return;
    h._wired = true;
    h.addEventListener('click', () => {
      const targetId = h.getAttribute('data-phase-target');
      const body = document.getElementById(targetId);
      if (!body) return;
      const isCollapsed = body.classList.contains('collapsed');
      if (isCollapsed) {
        body.classList.remove('collapsed');
        h.classList.add('is-expanded');
      } else {
        body.classList.add('collapsed');
        h.classList.remove('is-expanded');
      }
    });
  });
}

// Force a phase block expanded — used by failure handlers so the user
// can immediately see what failed without having to click. Idempotent.
function _expandPhase(phaseElement) {
  if (!phaseElement) return;
  const header = phaseElement.querySelector('.phase-header');
  const body = phaseElement.querySelector('.phase-body');
  if (header && body) {
    body.classList.remove('collapsed');
    header.classList.add('is-expanded');
  }
}

// Recount a phase's done/failed/total rows and update its header
// counter and progress bar. Called after every row state change so
// the summary stays in sync with the detail. The phaseElement is the
// outer .progress-pool div containing the rows.
function _updatePhaseProgress(phaseElement) {
  if (!phaseElement) return;
  const rows = phaseElement.querySelectorAll('.progress-step');
  const total = rows.length;
  let done = 0;
  let failed = 0;
  rows.forEach((r) => {
    if (r.classList.contains('done')) done += 1;
    else if (r.classList.contains('failed')) failed += 1;
  });
  const completed = done + failed;
  const counter = phaseElement.querySelector('.phase-counter');
  const bar = phaseElement.querySelector('.phase-bar');
  if (counter) {
    counter.textContent = `${completed} / ${total}`;
    counter.classList.toggle('is-done', completed === total && failed === 0 && total > 0);
    counter.classList.toggle('has-failures', failed > 0);
  }
  if (bar) {
    bar.value = completed;
    bar.max = total || 1;
    bar.classList.toggle('is-done', completed === total && failed === 0 && total > 0);
    bar.classList.toggle('has-failures', failed > 0);
  }
}

// One-time note added to the progress tree at the start of LP creation, to
// prevent the user from worrying that nothing is happening. Per-step progress
// tracking would require server-side streaming (SSE/WS) — for now the user
// just sees pending → done at the end. Server console shows the live progress.
function addProgressIntro() {
  const tree = document.getElementById('lpProgressTree');
  const note = document.createElement('div');
  note.className = 'notification is-info is-light is-size-7 py-2 px-3 mb-3';
  note.innerHTML =
    '<i class="fas fa-info-circle"></i>&nbsp;Creating pools and positions can take several minutes. ' +
    'Each step submits a transaction and waits for confirmation. ' +
    'Live progress is logged to the server console. ' +
    'The checkmarks below will populate when the operation completes.';
  tree.appendChild(note);
}

// Mark progress rows for a pool based on what actually completed.
//
// Under the phase-organized tree, each pool's rows are distributed
// across the four phase blocks (pp-phase1..pp-phase4). We find each
// row by its data-pool-idx + data-stage attribute combination, and
// inspect the corresponding piece of state on poolResult to decide
// whether to mark the row done.
//
// Per-position state we look at:
//   - poolResult.poolId               → "Create pool" row
//   - mainPositions[i].nftMint        → "Open slice i" row
//   - mainPositions[i].locked         → "Lock slice i" row
//   - mainPositions[i].transferredTo  → "Transfer slice i to recipient" row
//
// Bootstrap rows for this pool live in pp-phase2 (bs-open) and
// pp-phase3 (bs-lock); markBootstrapDoneForPool handles those.
//
// For full-success results (every state field populated), every row
// for the pool ends up green — matching what the user expects.
// For partial-failure results, rows whose underlying operation didn't
// finish stay in their pending/failed state. The user sees an honest
// picture of what's done vs. what isn't.
function markPoolDone(idx, poolResult) {
  // Pool creation row.
  if (poolResult && poolResult.poolId) {
    const poolRow = document.querySelector(
      `#lpProgressTree [data-pool-idx="${idx}"][data-stage="pool"]`,
    );
    if (poolRow) markRowDone(poolRow);
  }

  // Per-slice rows.
  const mp = Array.isArray(poolResult && poolResult.mainPositions)
    ? poolResult.mainPositions
    : [];
  for (let i = 0; i < mp.length; i++) {
    const pos = mp[i];
    if (pos && pos.nftMint) {
      const openRow = document.querySelector(
        `#lpProgressTree [data-pool-idx="${idx}"][data-stage="slice-${i}"]`,
      );
      if (openRow) markRowDone(openRow);
    }
    if (pos && pos.locked) {
      const lockRow = document.querySelector(
        `#lpProgressTree [data-pool-idx="${idx}"][data-stage="lock-${i}"]`,
      );
      if (lockRow) markRowDone(lockRow);
    }
    if (pos && pos.transferredTo) {
      const xferRow = document.querySelector(
        `#lpProgressTree [data-pool-idx="${idx}"][data-stage="xfer-${i}"]`,
      );
      if (xferRow) markRowDone(xferRow);
    }
  }

  // Per-ladder-band rows. Ladder bands have open and lock rows; no
  // transfer rows because ladder Fee Keys always sweep with the launch
  // wallet, never to external recipients.
  const lp = Array.isArray(poolResult && poolResult.ladderPositions)
    ? poolResult.ladderPositions
    : [];
  for (let b = 0; b < lp.length; b++) {
    const pos = lp[b];
    if (pos && pos.nftMint) {
      const openRow = document.querySelector(
        `#lpProgressTree [data-pool-idx="${idx}"][data-stage="ladder-${b}"]`,
      );
      if (openRow) markRowDone(openRow);
    }
    if (pos && pos.locked) {
      const lockRow = document.querySelector(
        `#lpProgressTree [data-pool-idx="${idx}"][data-stage="ladder-lock-${b}"]`,
      );
      if (lockRow) markRowDone(lockRow);
    }
  }

  // Support position rows. Same shape as ladder bands but currently
  // capped at one support per pool, so the progress tree only has one
  // "support-open" and one "support-lock" row per pool. If a pool
  // has multiple support positions in the future, this would need
  // per-index data-stage attributes ("support-open-0" etc) like ladder
  // — for now the one-position case keeps the row IDs simpler.
  const sp = Array.isArray(poolResult && poolResult.supportPositions)
    ? poolResult.supportPositions
    : [];
  // We mark the row done as soon as ANY support position has the field
  // populated. With more than one support position this would mismark,
  // but the current data model has 0 or 1. The defensive `.some` form
  // makes adding multi-band support later just a matter of extending
  // the row builder; this check would still flip when the first one
  // lands.
  if (sp.some((pos) => pos && pos.nftMint)) {
    const openRow = document.querySelector(
      `#lpProgressTree [data-pool-idx="${idx}"][data-stage="support-open"]`,
    );
    if (openRow) markRowDone(openRow);
  }
  if (sp.some((pos) => pos && pos.locked)) {
    const lockRow = document.querySelector(
      `#lpProgressTree [data-pool-idx="${idx}"][data-stage="support-lock"]`,
    );
    if (lockRow) markRowDone(lockRow);
  }
}

// Helper: flip a single row from pending/running to done.
function markRowDone(row) {
  row.classList.remove('pending', 'running');
  row.classList.add('done');
  const icon = row.querySelector('.icon');
  if (icon) icon.textContent = '✓';
  // Bubble up the row's state change to its phase block so the header
  // counter and progress bar reflect the new completion count.
  _updatePhaseProgress(row.closest('.progress-pool'));
}

// Mark a specific row as failed. Same visual treatment as the pending-row
// branch in markPoolFailed (red ✗, tooltip, header counter update, phase
// auto-expanded) but targets a known row rather than "first pending in
// this pool". Used by the live progress poll to flip individual rows red
// as Phase 3/4 per-position failures arrive — where one position can
// fail while sibling positions in the same pool keep succeeding, so the
// first-pending heuristic would be wrong.
function markRowFailed(row, err) {
  if (!row) return;
  row.classList.remove('pending', 'running', 'done');
  row.classList.add('failed');
  const icon = row.querySelector('.icon');
  if (icon) icon.textContent = '✗';
  if (err) row.title = err;
  const phase = row.closest('.progress-pool');
  _updatePhaseProgress(phase);
  _expandPhase(phase);
}

function markPoolFailed(idx, err) {
  // Find the first pending row for this pool. Under the phase-organized
  // tree, that's the first row anywhere in lpProgressTree with the
  // matching data-pool-idx that hasn't transitioned to done yet. The
  // first such row is by definition the operation that failed (the
  // orchestrator's sequential execution means failures stop progress
  // at that point).
  const pending = document.querySelector(
    `#lpProgressTree [data-pool-idx="${idx}"].pending`,
  );
  if (pending) {
    pending.classList.remove('pending');
    pending.classList.add('failed');
    const icon = pending.querySelector('.icon');
    if (icon) icon.textContent = '✗';
    pending.title = err;
    // Update the phase header's counter + bar AND auto-expand the
    // containing phase so the user can see what failed without having
    // to click. Failure rows are uncommon, so auto-expanding here is
    // less noisy than leaving the user to hunt through collapsed
    // phases for the red row.
    const phase = pending.closest('.progress-pool');
    _updatePhaseProgress(phase);
    _expandPhase(phase);
  }
}

// Mark all bootstrap rows as done. Called after the orchestrator returns
// full success — phase 2 (bs-open) and phase 3 (bs-lock) are both
// completed by definition, so every bootstrap row transitions to ✓.
//
// Under the phase-organized tree, bootstrap rows live in pp-phase2 (for
// bs-open) and pp-phase3 (for bs-lock). We select by stage attribute so
// the lookup is independent of which phase block hosts the rows.
function markAllBootstrapsDone() {
  document.querySelectorAll(
    '#lpProgressTree [data-stage="bs-open"], #lpProgressTree [data-stage="bs-lock"]',
  ).forEach((row) => markRowDone(row));
}

// Mark a specific pool's bootstrap rows based on actual state. Each pool
// has up to TWO bootstrap rows (bs-open in phase 2, bs-lock in phase 3);
// under the deferred-lock model, the open happens in Phase 2 and the lock
// in Phase 3, so a pool's bootstrap can be open-but-not-locked between
// those phases.
//
// Callers may pass a bootstrap result object via the second arg; if
// omitted, we default to "everything done" (the historical behavior used
// from the success path). Partial-failure callers should pass the actual
// bootstrap result to get accurate per-row marking.
function markBootstrapDoneForPool(allocationIndex, bootstrapResult) {
  const rows = document.querySelectorAll(
    `#lpProgressTree [data-pool-idx="${allocationIndex}"][data-stage^="bs-"]`,
  );
  rows.forEach((row) => {
    const stage = row.dataset.stage;
    if (!bootstrapResult) {
      markRowDone(row);
      return;
    }
    if (stage === 'bs-open' && bootstrapResult.nftMint) {
      markRowDone(row);
    } else if (stage === 'bs-lock' && bootstrapResult.locked) {
      markRowDone(row);
    }
  });
}

// Mark a specific pool's bootstrap rows as failed. Each pool has up to
// TWO bootstrap rows; we mark every pending one as failed because the
// bootstrap step is atomic from the user's perspective. If we only
// marked the first match, the bs-lock row would stay pending even
// though the work is unreachable until the open succeeds.
function markBootstrapFailedForPool(allocationIndex, err) {
  const rows = document.querySelectorAll(
    `#lpProgressTree [data-pool-idx="${allocationIndex}"][data-stage^="bs-"].pending`,
  );
  const phasesToUpdate = new Set();
  rows.forEach((row) => {
    row.classList.remove('pending');
    row.classList.add('failed');
    const icon = row.querySelector('.icon');
    if (icon) icon.textContent = '✗';
    row.title = err;
    const phase = row.closest('.progress-pool');
    if (phase) phasesToUpdate.add(phase);
  });
  // Update header counter + auto-expand for every phase touched. The
  // bs-open and bs-lock rows live in Phase 2 and Phase 3 respectively,
  // so this typically updates both phase headers in one fail path.
  phasesToUpdate.forEach((phase) => {
    _updatePhaseProgress(phase);
    _expandPhase(phase);
  });
}

function buildLpDoneSummary(results) {
  // Build the success summary shown after all pools land. Note we escape
  // quoteSymbol — for known quotes (SOL/USDC/etc) it's hard-coded safe,
  // but for user-supplied custom mints the symbol may have been read from
  // on-chain metadata or an indexer, which could contain anything. Better
  // to be paranoid than to allow a malicious token symbol to inject
  // markup into our success banner.
  //
  // Defensive on every field: mainPositions should always be populated
  // on the success path (orchestrator guarantees it), but if the result
  // shape ever changes or a partial result somehow lands here, we
  // shouldn't throw inside an HTML-building function and leave the
  // summary blank. A missing field renders as "0 main slices" — visibly
  // odd but doesn't break the page.
  let s = '';
  for (const r of results) {
    const sym = escapeHtml(r.quoteSymbol || '');
    const idShort = escapeHtml(r.poolId?.slice(0, 8) || '');
    const slices = Array.isArray(r.mainPositions) ? r.mainPositions : [];
    const ladder = Array.isArray(r.ladderPositions) ? r.ladderPositions : [];
    s += `<strong>${sym}</strong> pool: ${idShort}…, `;
    s += `${slices.length} main slice${slices.length === 1 ? '' : 's'}`;
    if (ladder.length > 0) {
      s += `, ${ladder.length} ladder band${ladder.length === 1 ? '' : 's'}`;
    }
    const ext = slices.filter((p) => p.transferredTo).length;
    if (ext > 0) s += ` (${ext} sent to external wallets)`;
    s += '<br>';
  }
  return s;
}

bind('continueToTransferBtn', 'click', () => {
  setStepSummary(5, `${lpResult.results.length} pool${lpResult.results.length === 1 ? '' : 's'} created`);
  prefillDestinationFromFunder();
  activateStep(6);
});

bind('continueToTransferAfterFailBtn', 'click', () => {
  setStepSummary(5, `partial — proceed to refund`);
  prefillDestinationFromFunder();
  activateStep(6);
});

bind('retryBootstrapsBtn', 'click', async () => {
  const btn = document.getElementById('retryBootstrapsBtn');
  const lockPositions = btn.dataset.lockPositions === 'true';
  const priorResults = lpResult?.results || [];

  if (!createdTokenInfo) {
    log('Token info missing — cannot resume launch.', 'danger');
    return;
  }

  await withRunState(async () => {
    setLoading(btn, true);
    markLaunchActiveForRpcHealth(true);
    try {
      log(`Resuming launch (${priorResults.length} pool${priorResults.length === 1 ? '' : 's'} carried over)…`);
      // Hide the fail banner while the resume runs so the user sees a
      // clean "in progress" state rather than the stale failure copy.
      document.getElementById('lpFailInfo').classList.add('hidden');

      // Reset any failed rows back to pending so progress is reflected.
      // We don't know exactly which rows will run this attempt (depends
      // on what got done last time), so we reset everything that's
      // currently marked failed.
      document.querySelectorAll('#lpProgressTree .progress-step.failed')
        .forEach((row) => {
          row.classList.remove('failed');
          row.classList.add('pending');
          const icon = row.querySelector('.icon');
          if (icon) icon.textContent = '◯';
          row.title = '';
        });

      const allocations = buildAllocationsForApi();
      const targetMc = parseNumberInput(document.getElementById('targetMarketCap'));
      const resp = await fetch('/api/resume-launch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          walletPublicKey: tempWallet.publicKey,
          // F5: the server resolves the secret from its encrypted store using
          // the public key for real launches; only demo mode (in-memory
          // ledger, no server-side secret) still sends the key inline.
          ...(demoModeActive ? { tempWalletSecretKey: tempWallet.secretKey } : {}),
          tokenMint: createdTokenInfo.mint,
          tokenDecimals: createdTokenInfo.decimals,
          tokenTotalSupply: createdTokenInfo.totalSupply,
          targetMarketCapUsd: targetMc,
          allocations,
          lockPositions,
          priorResults,
        }),
      });
      let data;
      try {
        data = await resp.json();
      } catch (parseErr) {
        if (!resp.ok) {
          throw new Error(
            `Server returned HTTP ${resp.status} with non-JSON body. ` +
            `Check the server console for details.`,
          );
        }
        throw new Error(`Unexpected response: ${parseErr.message}`);
      }

      if (resp.status === 409 && data.code === 'OP_IN_FLIGHT') {
        // Another launch operation (likely the original create-lp, or a
        // previous resume click) is still running for this wallet. The
        // resume was rejected to prevent two orchestrators racing over
        // the same positions. Reattach the progress poll and wait.
        log(data.error, 'warning');
        log(
          'Reattached to the running operation — wait for it to finish ' +
          'before resuming. Do not close the app.',
          'warning',
        );
        if (tempWallet && tempWallet.publicKey) {
          startLpProgressPoll(tempWallet.publicKey);
        }
        return;
      }

      if (data.success) {
        // Full success — every pool now has main positions + bootstrap.
        // Replace lpResult with the canonical full result so downstream
        // flows (transfer) see the up-to-date state.
        lpResult = data;
        data.results.forEach((r) => {
          markPoolDone(r.allocationIndex, r);
          markBootstrapDoneForPool(r.allocationIndex, r.bootstrap);
        });
        log(`All ${data.results.length} pool(s) created and bootstrapped`, 'success');
        setLpDoneVisible(true);
        document.getElementById('lpDoneSummary').innerHTML = buildLpDoneSummary(data.results);
        renderLaunchReportPreview('step5');
        markLaunchActiveForRpcHealth(false);
        return;
      }

      // Partial: at least one allocation still couldn't be completed.
      // The data has the same shape as a fresh create-lp failure:
      // partialResults, failedAllocationIndex, failedPhase, bootstrapFailures.
      // Update our lpResult so the next retry sees the latest state.
      lpResult = { results: data.partialResults || [] };
      const newPhase = data.failedPhase || 'main_positions';
      log(
        `Resume: ${(data.partialResults || []).length} pool(s) done, ` +
        `still failing (phase: ${newPhase}): ${data.error}`,
        'warning',
      );

      // Repaint progress tree to reflect new state. Mark every entry in
      // partialResults as done (both main and bootstrap rows depending
      // on what's populated), and mark the still-failing ones.
      (data.partialResults || []).forEach((r) => {
        markPoolDone(r.allocationIndex, r);
        if (r.bootstrap) markBootstrapDoneForPool(r.allocationIndex, r.bootstrap);
      });
      if (newPhase === 'bootstrap') {
        const failures = data.bootstrapFailures
          || (data.failedAllocationIndex != null
            ? [{ allocationIndex: data.failedAllocationIndex, error: data.error }]
            : []);
        for (const f of failures) {
          markBootstrapFailedForPool(f.allocationIndex, f.error);
        }
      } else if (newPhase === 'locks' || newPhase === 'transfers') {
        // Lock/transfer phase failures don't map to a single failing
        // allocation row — the failures are per-position and don't
        // belong on the pool-level progress markers. We've already
        // marked pools and bootstraps as done above; the per-position
        // detail lives in data.lockFailures / data.transferFailures
        // and gets surfaced via the lpFailInfo banner below.
      } else if (data.failedAllocationIndex != null) {
        markPoolFailed(data.failedAllocationIndex, data.error);
      }

      // Re-show the fail banner with updated counts so the user can
      // either retry again or give up via sweep. Heading + reassurance
      // copy mirrors the initial-failure branches so the UX stays
      // consistent whether the user is on attempt 1 or attempt N.
      document.getElementById('lpFailInfo').classList.remove('hidden');
      let resumeHeading;
      if (newPhase === 'bootstrap') {
        resumeHeading = 'Bootstraps still failing.';
      } else if (newPhase === 'locks') {
        resumeHeading = 'Some position locks still failing.';
      } else if (newPhase === 'transfers') {
        resumeHeading = 'Some Fee Key transfers still failing.';
      } else {
        resumeHeading = 'Pool creation still failing.';
      }
      document.getElementById('lpFailHeading').textContent = resumeHeading;
      document.getElementById('lpFailSummary').textContent = data.error;

      // Render structured error with category badge + "What happened?"
      const lpFailCtr = document.getElementById('lpFailInfo').querySelector('.notification');
      if (lpFailCtr) {
        const prevB = lpFailCtr.querySelector('.error-banner');
        if (prevB) prevB.remove();
        renderStructuredError(lpFailCtr, data.error, categorizeError(data.error));
      }

      const successCount = (data.partialResults || []).length;
      const totalCount = allocations.length;
      document.getElementById('lpFailSucceededCount').innerHTML =
        `<strong>${successCount}</strong> of ${totalCount} pool${totalCount === 1 ? '' : 's'} ` +
        `completed; the rest are still failing. Click <strong>${newPhase === 'bootstrap' ? 'Retry bootstraps' : 'Resume launch'}</strong> ` +
        `to try again, or sweep the wallet to start over.`;
      // Resume button stays visible for another attempt. Update its
      // label too — a retry can shift phases (e.g. main-positions
      // failure resolves but uncovers a bootstrap-only failure), and
      // the button label should reflect that. For locks/transfers we
      // keep the generic "Resume launch" label since those don't have
      // a dedicated retry verb.
      const retryLabel = btn.querySelector('span:last-child');
      if (retryLabel) {
        retryLabel.textContent = newPhase === 'bootstrap'
          ? 'Retry bootstraps'
          : 'Resume launch';
      }
      // Phase-specific reassurance copy (mirrors the initial-failure
      // path's branches so retry messaging stays consistent).
      if (newPhase === 'bootstrap') {
        document.getElementById('lpFailReassurance').innerHTML =
          `<strong>Main positions are in place for every pool.</strong> Only the bootstrap ` +
          `leg failed for the pools listed above — these pools won't be tradable at the ` +
          `intended price until their bootstraps land. Click <strong>Retry bootstraps</strong> ` +
          `to try again (most bootstrap failures are transient RPC issues). If retrying ` +
          `keeps failing, sweep the wallet to your destination and manually add bootstrap ` +
          `liquidity in the Raydium UI later.`;
        document.getElementById('continueToTransferAfterFailBtnLabel').textContent =
          'Or sweep to destination instead';
      } else if (newPhase === 'locks') {
        document.getElementById('lpFailReassurance').innerHTML =
          `<strong>Every pool is open and tradable.</strong> The missing step is the lock — ` +
          `until locks finish, the LP'd tokens are still recoverable by the launch wallet. ` +
          `Click <strong>Resume launch</strong> to try the remaining locks again. If locks ` +
          `keep failing and you'd rather walk away, sweep the wallet to your destination — ` +
          `the open positions get closed and their LP tokens come back with the sweep.`;
        document.getElementById('continueToTransferAfterFailBtnLabel').textContent =
          'Or sweep to destination instead';
      } else if (newPhase === 'transfers') {
        document.getElementById('lpFailReassurance').innerHTML =
          `<strong>The launch itself succeeded.</strong> Every pool is created, tradable, and ` +
          `locked. The only thing that didn't finish was the delivery of Fee Key NFTs to ` +
          `recipient addresses. Those NFTs are in your launch wallet and will sweep to your ` +
          `destination wallet, so nothing is lost. You can manually send them to the intended ` +
          `recipients afterward, or click <strong>Resume launch</strong> to try the deliveries ` +
          `again.`;
        document.getElementById('continueToTransferAfterFailBtnLabel').textContent =
          'Skip to Transfer Assets';
      } else {
        document.getElementById('lpFailReassurance').innerHTML =
          `<strong>Your assets are safe</strong> — they're still in the ephemeral wallet ` +
          `(SOL, any auto-swapped quote tokens, and the LP NFTs from pools that did succeed). ` +
          `Click <strong>Resume launch</strong> to retry just the missing pools — already-` +
          `created pools will be skipped. If retrying keeps failing, you can sweep the wallet ` +
          `back to your destination as a last resort; the pools that succeeded above are ` +
          `permanent on-chain.`;
        document.getElementById('continueToTransferAfterFailBtnLabel').textContent =
          'Skip to Transfer Assets';
      }
    } catch (e) {
      log(`Resume failed: ${e.message}`, 'danger');
      markLaunchActiveForRpcHealth(false);
      // Show the fail banner again so the user can see what to do next.
      document.getElementById('lpFailInfo').classList.remove('hidden');
    } finally {
      setLoading(btn, false);
    }
  });
});

// Pre-fill the Step 6 destination input with the detected funding wallet,
// IF the user hasn't already typed something there. This is a convenience —
// the user still has to click through the confirmation modal that displays
// the full address before any transfer actually runs.
function prefillDestinationFromFunder() {
  const dest = document.getElementById('destinationWallet');
  if (!dest) return;
  if (!dest.value && fundingWallet) {
    dest.value = fundingWallet;
    log(`Pre-filled destination with detected funder. Verify before transferring.`, 'warning');
  }
}


// Vanity CA grind — pre-grinds the token mint address before token creation
let vanityCAKeypairs = []; // [{ publicKey, secretKey, rarity, epochs, attempts }]
let selectedVanityCA = null; // index into vanityCAKeypairs

// ---- Vanity CA epoch tiers (authoritative from C binary) ----
// Rarity colors: Common=blue, Rare=green, Legendary=orange, Mythic=purple
const VANITY_TIERS = [
  { name: 'Common',    max: 1, color: '#3e8ed0' },
  { name: 'Rare',      max: 2, color: '#48c774' },
  { name: 'Legendary', max: 3, color: '#f4a236' },
  { name: 'Mythic',    max: Infinity, color: '#9b59b6' },
];

// Get the tier index for a given epoch value
function tierForEpoch(epoch) {
  for (let i = 0; i < VANITY_TIERS.length; i++) {
    if (epoch <= VANITY_TIERS[i].max) return i;
  }
  return VANITY_TIERS.length - 1;
}

// Reset the single progress bar for a new grind
function setupGrindBar() {
  const bar = document.getElementById('vanityCAProgressBar');
  const label = document.getElementById('vanityCAProgressText');
  if (bar) {
    bar.style.width = '0%';
    bar.style.background = '#e0d6c2';
  }
  if (label) label.textContent = 'Grinding...';
}

// Update the single progress bar with epoch data
function updateGrindBar(epoch, attempts) {
  const bar = document.getElementById('vanityCAProgressBar');
  const label = document.getElementById('vanityCAProgressText');
  if (!bar || !label) return;

  const tierIdx = tierForEpoch(epoch);
  const tier = VANITY_TIERS[tierIdx];
  const prevMax = tierIdx === 0 ? 0 : VANITY_TIERS[tierIdx - 1].max;
  const tierPct = Math.min(100, ((epoch - prevMax) / (tier.max - prevMax)) * 100);
  const colors = VANITY_TIERS.map(t => t.color);

  // Bar width = current tier progress (0-100% within the tier)
  bar.style.width = tierPct + '%';

  // Background: completed tiers shown as gradient, current tier solid
  if (tierIdx === 0) {
    bar.style.background = colors[0];
  } else {
    // Completed tiers each get a fixed portion of the bar's background
    let gradient = 'linear-gradient(to right';
    const segPct = 20; // each completed tier takes 20% of the current bar
    for (let i = 0; i < tierIdx; i++) {
      const start = i * segPct;
      const end = (i + 1) * segPct;
      gradient += ', ' + colors[i] + ' ' + start + '%, ' + colors[i] + ' ' + end + '%';
    }
    gradient += ', ' + colors[tierIdx] + ' ' + (tierIdx * segPct) + '%, ' + colors[tierIdx] + ' 100%';
    gradient += ')';
    bar.style.background = gradient;
  }

  label.textContent = tier.name + ' · Epoch ' + epoch.toFixed(2) + ' · ' + attempts.toLocaleString() + ' attempts';
}

// ---- Live key display below the grind bar ----
// Shows the most recent tested key when it has prefix/suffix matches.
// Match chars are colored by rarity tier: blue(1) green(2) orange(3) purple(4+)
const MATCH_COLORS = [
  null,          // 0 matches — not shown
  '#3e8ed0',     // 1-char: Common blue
  '#48c774',     // 2-char: Rare green
  '#f4a236',     // 3-char: Legendary orange
  '#9b59b6',     // 4-char: Mythic purple
  '#9b59b6',     // 5+
  '#9b59b6',     // 6+
  '#9b59b6',     // 7+
  '#9b59b6',     // 8+
  '#9b59b6',     // 9+
  '#9b59b6',     // 10+
];

let _keyDisplayTarget = '';
let _lastKeyShown = '';

function countMatchChars(key, target) {
  // Count how many distinct chars of target appear anywhere in key.
  if (!target || !key) return 0;
  const keySet = new Set(key);
  let n = 0;
  for (const ch of target) {
    if (keySet.has(ch)) n++;
  }
  return n;
}

function updateKeyDisplay(key, target) {
  if (!key || key === _lastKeyShown) return;
  const matchCount = countMatchChars(key, target);
  if (matchCount === 0) return;
  _lastKeyShown = key;

  const el = document.getElementById('vanityCAKeyDisplay');
  if (!el || el.offsetParent === null) return;

  const targetSet = new Set(target);
  const color = MATCH_COLORS[Math.min(matchCount, MATCH_COLORS.length - 1)];
  let html = '<span class="is-family-monospace is-size-7" style="line-height:1.3;">';
  for (let i = 0; i < key.length; i++) {
    const isMatch = targetSet.has(key[i]);
    if (isMatch) {
      html += '<span class="vanity-char-match" style="color:' + color + ';display:inline-block;animation:vanityCharPop 0.3s ease-out;">' + key[i] + '</span>';
    } else {
      html += '<span style="color:#666">' + key[i] + '</span>';
    }
  }
  html += '</span>';
  el.innerHTML = html;
}

function setupKeyDisplay(target) {
  _keyDisplayTarget = target;
  _lastKeyShown = '';

  let container = document.getElementById('vanityCAKeyDisplay');
  if (!container) {
    container = document.createElement('div');
    container.id = 'vanityCAKeyDisplay';
    container.style.cssText = 'text-align:center;padding:6px 4px 2px;overflow:hidden;';
    const progressEl = document.getElementById('vanityCAProgress');
    if (progressEl) {
      const textEl = document.getElementById('vanityCAProgressText');
      if (textEl) textEl.parentNode.insertBefore(container, textEl);
      else progressEl.appendChild(container);
    }
  }
  container.innerHTML = '<span class="is-family-monospace is-size-7" style="color:#555;">waiting for matches…</span>';
}

function removeKeyDisplay() {
  const container = document.getElementById('vanityCAKeyDisplay');
  if (container) container.remove();
}

// Centralized state machine for the Grind/Cancel button. Three states
// driven by the data-mode attribute, so all transitions go through one
// place. Production code never reads data-mode externally — it's purely
// an internal flag the click handler reads to decide what to do.
function setGrindButtonState(state) {
  const btn = document.getElementById('grindCABtn');
  if (!btn) return;
  const icon = btn.querySelector('i');
  const label = btn.querySelector('span:last-child');
  const target = document.getElementById('vanityCATarget');
  const mode = document.getElementById('vanityCAMode');

  if (state === 'grind') {
    btn.dataset.mode = 'grind';
    btn.disabled = false;
    btn.classList.remove('is-danger', 'is-loading');
    btn.classList.add('is-primary');
    if (icon) icon.className = 'fas fa-star';
    if (label) label.textContent = 'Grind';
    if (target) target.disabled = false;
    if (mode) mode.disabled = false;
  } else if (state === 'cancel') {
    btn.dataset.mode = 'cancel';
    btn.disabled = false;
    btn.classList.remove('is-primary', 'is-loading');
    btn.classList.add('is-danger');
    if (icon) icon.className = 'fas fa-times';
    if (label) label.textContent = 'Cancel';
    // Lock the inputs while grinding — the prefix/suffix and mode
    // dropdown contribute to the grind that's already underway;
    // letting the user edit them mid-grind would create a confusing
    // mismatch between the visible target and what's actually being
    // ground.
    if (target) target.disabled = true;
    if (mode) mode.disabled = true;
  } else if (state === 'cancelling') {
    btn.dataset.mode = 'cancelling';
    btn.disabled = true;
    btn.classList.remove('is-primary');
    btn.classList.add('is-danger', 'is-loading');
    if (label) label.textContent = 'Cancelling...';
    if (target) target.disabled = true;
    if (mode) mode.disabled = true;
  }
}

bind('grindCABtn', 'click', async () => {
  const btn = document.getElementById('grindCABtn');
  const currentMode = btn.dataset.mode || 'grind';

  // CANCEL branch: button is showing "Cancel" because a grind is in
  // flight. POST to the cancel endpoint and transition into the
  // "Cancelling..." state. The actual UI cleanup happens when the SSE
  // stream emits {type:'cancelled'} — which fires once the child
  // process actually finishes terminating (usually a few ms).
  if (currentMode === 'cancel') {
    setGrindButtonState('cancelling');
    try {
      const resp = await fetch('/api/cancel-vanity-grind', { method: 'POST' });
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${resp.status}`);
      }
    } catch (e) {
      // Cancel request failed (network error, server gone, etc.). Don't
      // leave the user stuck in "Cancelling..." forever — restore the
      // button. If the grind is still actually running we'll see its
      // events come through the SSE stream and handle them normally.
      log('Cancel request failed: ' + e.message, 'warn');
      setGrindButtonState('cancel');
    }
    return;
  }

  // GRIND branch: standard new-grind flow.
  const target = document.getElementById('vanityCATarget').value.trim();
  if (!target) {
    log('Enter a vanity target first.', 'warn');
    return;
  }

  await withRunState(async () => {
    setGrindButtonState('cancel');
    try {
      const mode = document.getElementById('vanityCAMode').value;
      const isSuffix = mode === 'suffix';

      // Show single active progress bar
      const progressEl = document.getElementById('vanityCAProgress');
      if (progressEl) progressEl.classList.remove('hidden');

      // Hide any previously-displayed result card while the new grind
      // runs. The card re-appears via renderVanityCAList from either the
      // done handler (with the new CA's data) or the finally block
      // (restoring the previous CA if cancel/error left selection
      // intact). Avoids the confusing "old result + new progress bar
      // visible at the same time" state, especially when the previous
      // result was in the yellow warning state.
      const resultEl = document.getElementById('vanityCAResult');
      if (resultEl) resultEl.classList.add('hidden');

      // Ensure original bar is visible, remove any old epoch bars
      const barContainer = progressEl?.querySelector('.vanity-progress-bar');
      if (barContainer) barContainer.style.display = '';
      const oldEpochBars = document.getElementById('vanityCAEpochBars');
      if (oldEpochBars) oldEpochBars.remove();
      setupGrindBar();
      setupKeyDisplay(target);

      const params = new URLSearchParams();
      if (isSuffix) params.set('suffix', target);
      else params.set('prefix', target);
      // Pass the session token as a query param — EventSource can't set
      // custom headers, so the SSE endpoint validates it inline.
      try {
        const sessionToken = await window.getApiSessionToken();
        if (sessionToken) params.set('token', sessionToken);
      } catch (_) { /* proceed without token; server will reject if required */ }
      const es = new EventSource('/api/generate-vanity-wallet-stream?' + params.toString());

      es.onerror = () => { es.close(); };

      await new Promise((resolve, reject) => {
        es.addEventListener('message', (e) => {
          let data;
          try { data = JSON.parse(e.data); } catch { return; }
          if (data.type === 'start') {
            // Metadata received
          } else if (data.type === 'progress') {
            updateGrindBar(data.epoch, data.attempts);
            if (data.key) updateKeyDisplay(data.key, _keyDisplayTarget);
          } else if (data.type === 'done') {
            es.close();
            removeKeyDisplay();
            const entry = {
              publicKey: data.wallet.publicKey,
              secretKey: data.wallet.secretKey,
              rarity: data.wallet.rarity,
              epochs: data.wallet.epochs,
              attempts: data.wallet.attempts,
              seed: data.wallet.seed,
            };
            // Replace any previous grind with this one and auto-select
            // it. Without selectedVanityCA being set here, the launch
            // flow at the "vanityCAKeypair" form-append site would
            // silently skip the keypair and the pre-grind would be a
            // no-op. Most-recent-successful-grind wins; the user can
            // discard via the clear button on the result block.
            vanityCAKeypairs = [entry];
            selectedVanityCA = 0;
            if (progressEl) progressEl.classList.add('hidden');
            renderVanityCAList();
            log('Vanity CA: ' + data.wallet.publicKey + ' (' + data.wallet.rarity + ', ' + data.wallet.attempts.toLocaleString() + ' attempts)', 'success');
            resolve();
          } else if (data.type === 'cancelled') {
            // User clicked Cancel and the server confirmed the grind
            // was terminated. Treat as a clean stop — no error log,
            // just unwind the UI back to its idle state. The catch
            // block below resolves on its own without throwing for
            // this case because we resolve() here.
            es.close();
            removeKeyDisplay();
            if (progressEl) progressEl.classList.add('hidden');
            const epochBars = document.getElementById('vanityCAEpochBars');
            if (epochBars) epochBars.remove();
            log('Vanity grind cancelled.', 'info');
            resolve();
          } else if (data.type === 'error') {
            es.close();
            reject(new Error(data.error));
          }
        });
        es.addEventListener('error', () => {
          es.close();
          reject(new Error('SSE connection failed'));
        });
      });
    } catch (e) {
      log('Vanity CA grind failed: ' + e.message, 'danger');
      removeKeyDisplay();
      document.getElementById('vanityCAProgress')?.classList.add('hidden');
      // Clean up any extra elements
      const epochBars = document.getElementById('vanityCAEpochBars');
      if (epochBars) epochBars.remove();
    } finally {
      setGrindButtonState('grind');
      // Re-render the result card after every grind exit path so it
      // reflects the current state: the new CA on success (harmless
      // double-call after the done handler), the previously-selected
      // CA restored after cancel/error (if any), or stays hidden if no
      // selection persists. Without this the card stays hidden after
      // cancel even when there's a previous result the user expects
      // to see again.
      renderVanityCAList();
    }
  });
});

// Discard the active vanity CA (the result block's X button). Wipes
// the array and the selection, then re-renders the block so it hides.
// The user can then grind again from scratch. Uses the existing
// clearVanityCAs helper defined further down so wipe logic lives in
// one place.
bind('clearVanityCAResultBtn', 'click', () => {
  if (typeof clearVanityCAs === 'function') clearVanityCAs();
  log('Vanity CA discarded.', 'info');
});

// Render the active vanity CA into the result block in index.html.
//
// History: this used to be a multi-result list renderer, but the matching
// list elements (vanityCAList, vanityCAListContainer) were never added to
// the HTML — so the function ran no-ops every time and the user never saw
// their grind result. The function now updates the single-result block
// (vanityCAResult / vanityCAResultAddr / vanityCARarity) that DOES exist
// in the HTML and was sitting unused. The "list" semantics are preserved
// in the underlying array, but in practice we replace-on-success so the
// array has at most one entry at a time.
function renderVanityCAList() {
  const resultEl = document.getElementById('vanityCAResult');
  const addrEl = document.getElementById('vanityCAResultAddr');
  const rarityEl = document.getElementById('vanityCARarity');
  const metaEl = document.getElementById('vanityCAResultMeta');
  const iconEl = document.getElementById('vanityCAResultIcon');
  const headlineEl = document.getElementById('vanityCAResultHeadline');
  if (!resultEl) return;

  // No active CA → hide the block and we're done.
  if (selectedVanityCA === null || !vanityCAKeypairs[selectedVanityCA]) {
    resultEl.classList.add('hidden');
    return;
  }

  const ca = vanityCAKeypairs[selectedVanityCA];

  // Match the tier colors used elsewhere for consistency. Bulma tags
  // don't have a "Mythic" style natively; is-danger reads close enough.
  const tierColors = {
    Common: 'is-info',
    Rare: 'is-success',
    Legendary: 'is-warning',
    Mythic: 'is-danger',
  };
  const tagClass = tierColors[ca.rarity] || 'is-light';

  if (addrEl) addrEl.textContent = ca.publicKey;
  if (rarityEl) {
    // Replace the tag's color class so re-renders for different tiers
    // don't accumulate stale classes.
    rarityEl.className = `tag is-size-7 ${tagClass}`;
    rarityEl.textContent = ca.rarity;
  }
  if (metaEl) {
    metaEl.textContent =
      `${ca.attempts.toLocaleString()} attempts`
      + (typeof ca.epochs === 'number' ? ` · ${ca.epochs.toFixed(1)}× epoch` : '');
  }

  // The vanity CA is always usable — there is no pre-flight constraint
  // anymore. The launch pipeline accepts whichever mintA/mintB ordering
  // Raydium picks and branches every downstream calculation accordingly.
  if (iconEl) {
    iconEl.innerHTML = '<i class="fas fa-check-circle has-text-success"></i>';
  }
  if (headlineEl) {
    headlineEl.innerHTML =
      '<strong>Vanity CA ready</strong> '
      + '<span class="has-text-grey">&mdash; will be used as the token mint address</span>';
  }

  resultEl.classList.remove('hidden');
}

// Clear collected CAs (called on wallet regenerate / full reset)
function clearVanityCAs() {
  vanityCAKeypairs = [];
  selectedVanityCA = null;
  renderVanityCAList();
}

// ===========================================================================
// STEP 6: Transfer assets
// ===========================================================================

bind('transferAssetsBtn', 'click', () => {
  const dest = document.getElementById('destinationWallet').value.trim();
  if (!dest) {
    log('Destination wallet required', 'warning');
    return;
  }
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(dest)) {
    log("Destination address doesn't look like a valid Solana address", 'danger');
    return;
  }
  showTransferConfirmModal(dest);
});

function showTransferConfirmModal(dest) {
  const modal = document.getElementById('transferConfirmModal');
  const chunked = dest.match(/.{1,8}/g).join(' ');
  document.getElementById('transferConfirmAddress').textContent = chunked;

  const confirmCheckbox = document.getElementById('transferConfirmCheckbox');
  const confirmBtn = document.getElementById('transferConfirmBtn');
  confirmCheckbox.checked = false;
  confirmBtn.disabled = true;

  modal.classList.add('is-active');
}

bind('transferConfirmCheckbox', 'change', (e) => {
  document.getElementById('transferConfirmBtn').disabled = !e.target.checked;
});

bind('transferConfirmCancelBtn', 'click', () => {
  document.getElementById('transferConfirmModal').classList.remove('is-active');
});

bind('transferConfirmBtn', 'click', async () => {
  document.getElementById('transferConfirmModal').classList.remove('is-active');
  await runTransfer();
});

// ===========================================================================
// Live airdrop progress polling
// ---------------------------------------------------------------------------
// When /api/transfer-assets is in flight with an airdrop payload (or when
// /api/retry-airdrop is running), the server populates an in-memory progress
// tracker as it processes each recipient. These helpers poll /api/airdrop-
// progress every 500ms during the transfer so the user sees a live "X / N
// recipients" panel ticking forward — without this, the user stares at an
// unmoving button for 20-30 seconds with no feedback that anything is
// happening.
//
// Both real and demo modes write to the same tracker (server.js owns it),
// so this UI works identically across modes.
// ===========================================================================

let _airdropProgressPollHandle = null;

function fmtTokensShort(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  return v.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

function updateAirdropProgressUi(state, expectedTotal) {
  const panel = document.getElementById('airdropProgressPanel');
  if (!panel) return;
  panel.classList.remove('hidden');
  // total comes from the server's tracker; fall back to expectedTotal
  // (what the frontend KNOWS we sent) until the server's first write
  // lands. Avoids a "0 / 0" flash on the very first poll.
  const total = (state && Number.isFinite(state.total) && state.total > 0)
    ? state.total
    : (expectedTotal || 0);
  const done = state ? (state.completed + state.failedCount) : 0;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const tokens = state ? state.totalTokens : 0;
  const lastWallet = state && state.lastWallet ? state.lastWallet : null;
  const lastTokens = state && state.lastTokens != null ? state.lastTokens : null;

  const countEl = document.getElementById('airdropProgressCount');
  if (countEl) countEl.textContent = `${done} / ${total}`;
  const pctEl = document.getElementById('airdropProgressPct');
  if (pctEl) pctEl.textContent = total > 0 ? `(${pct}%)` : '';
  const bar = document.getElementById('airdropProgressBar');
  if (bar) bar.value = pct;
  const tokensEl = document.getElementById('airdropProgressTokens');
  if (tokensEl) tokensEl.textContent = fmtTokensShort(tokens);
  const lastEl = document.getElementById('airdropProgressLast');
  if (lastEl) {
    if (lastWallet) {
      // Full address (no truncation) — there's a full-width row for
      // this and showing the entire wallet is more verifiable than a
      // shortened form that can collide between similar-prefix wallets.
      lastEl.style.wordBreak = 'break-all';
      lastEl.textContent = `Last delivered: ${lastWallet}`
        + (lastTokens != null ? ` (${fmtTokensShort(lastTokens)} tokens)` : '');
    } else {
      lastEl.style.wordBreak = '';
      lastEl.textContent = 'Starting…';
    }
  }
}

// Start the polling loop for a given launch-wallet pubkey. expectedTotal
// is the recipient count the frontend already knows from the airdrop
// payload; passing it lets us show a coherent "0 / N" initial state
// before the server's first progress write lands.
function startAirdropProgressPoll(walletPublicKey, expectedTotal) {
  stopAirdropProgressPoll(); // defensive — never double-poll
  // Render an initial frame so the panel doesn't feel laggy at start.
  updateAirdropProgressUi(null, expectedTotal);
  let cancelled = false;
  const tick = async () => {
    if (cancelled) return;
    try {
      const resp = await fetch(
        `/api/airdrop-progress?wallet=${encodeURIComponent(walletPublicKey)}`,
      );
      if (resp.ok) {
        const data = await resp.json();
        if (cancelled) return;
        if (data && data.state) {
          updateAirdropProgressUi(data.state, expectedTotal);
          // Server-side self-stop: status='done' means the airdrop is
          // finished. The runTransfer success path also calls stop on
          // its way out, so this is just belt-and-suspenders.
          if (data.state.status === 'done') {
            // One more tick so the user sees the final 100% state for
            // a moment before the result panel takes over.
            return;
          }
        }
      }
    } catch (_) {
      // Transient network blip — try again on next interval.
    }
    if (!cancelled) {
      _airdropProgressPollHandle = setTimeout(tick, 500);
    }
  };
  // Use setTimeout chain rather than setInterval so a slow response can't
  // cause overlapping in-flight requests.
  _airdropProgressPollHandle = setTimeout(tick, 500);
  return () => { cancelled = true; stopAirdropProgressPoll(); };
}

function stopAirdropProgressPoll() {
  if (_airdropProgressPollHandle) {
    clearTimeout(_airdropProgressPollHandle);
    _airdropProgressPollHandle = null;
  }
}

function hideAirdropProgressPanel() {
  const panel = document.getElementById('airdropProgressPanel');
  if (panel) panel.classList.add('hidden');
}

// ===========================================================================
// Live LP progress polling
// ---------------------------------------------------------------------------
// During /api/create-lp the server (currently only in demo mode) writes an
// event log of per-step completions: pool_create_done, main_open_done,
// ladder_open_done, support_open_done, bootstrap_open_done, *_lock_done,
// transfer_done. Each event includes allocationIndex + sliceIndex /
// bandIndex where relevant.
//
// This polls /api/lp-progress with a `since` cursor every 500ms and
// translates each new event into a row marking. Without it, every row in
// the phase progress tree stays pending until the single create-lp
// response lands — which is fine for a 30-second real launch but feels
// frozen during a 60-second demo with many rows.
// ===========================================================================

let _lpProgressPollHandle = null;
let _lpProgressSeenCount = 0;

// Map a single progress event to its corresponding row in the phase
// progress tree, plus a 'kind' field indicating done vs failed. Returns
// null when no row matches (e.g. a stage we don't render rows for —
// phase1_pool_done, phase3_start, etc., which are bookkeeping events
// that exist only for the journal).
//
// Selector strings must match the data-stage attribute scheme used in
// buildPhaseProgressTree. Failed events use the same data-stage as
// their _done counterparts — they're different "kinds" of the same
// underlying row, not separate rows.
function _lpEventToRow(event) {
  if (!event || event.allocationIndex == null) return null;
  const idx = event.allocationIndex;
  let stage = null;
  let kind = 'done';
  switch (event.stage) {
    // Success events.
    case 'pool_create_done':       stage = 'pool'; break;
    case 'main_open_done':         stage = `slice-${event.sliceIndex}`; break;
    case 'ladder_open_done':       stage = `ladder-${event.bandIndex}`; break;
    case 'support_open_done':      stage = 'support-open'; break;
    case 'bootstrap_open_done':    stage = 'bs-open'; break;
    case 'main_lock_done':         stage = `lock-${event.sliceIndex}`; break;
    case 'ladder_lock_done':       stage = `ladder-lock-${event.bandIndex}`; break;
    case 'support_lock_done':      stage = 'support-lock'; break;
    case 'bootstrap_lock_done':    stage = 'bs-lock'; break;
    case 'main_transfer_done':     stage = `xfer-${event.sliceIndex}`; break;
    // Failure events. Same row, different kind.
    case 'main_lock_failed':       stage = `lock-${event.sliceIndex}`; kind = 'failed'; break;
    case 'ladder_lock_failed':     stage = `ladder-lock-${event.bandIndex}`; kind = 'failed'; break;
    case 'support_lock_failed':    stage = 'support-lock'; kind = 'failed'; break;
    case 'bootstrap_lock_failed':  stage = 'bs-lock'; kind = 'failed'; break;
    case 'bootstrap_failed':       stage = 'bs-open'; kind = 'failed'; break;
    case 'main_transfer_failed':   stage = `xfer-${event.sliceIndex}`; kind = 'failed'; break;
    default:                       return null;
  }
  const row = document.querySelector(
    `#lpProgressTree [data-pool-idx="${idx}"][data-stage="${stage}"]`,
  );
  if (!row) return null;
  return { row, kind, error: event.error };
}

// Start the poll for a given launch wallet. Resets the seen-count so a
// fresh poll session starts from event 0. Self-stops on status='done'
// or when the parent fetch tears it down.
function startLpProgressPoll(walletPublicKey) {
  stopLpProgressPoll();
  _lpProgressSeenCount = 0;
  let cancelled = false;
  const tick = async () => {
    if (cancelled) return;
    try {
      const resp = await fetch(
        `/api/lp-progress?wallet=${encodeURIComponent(walletPublicKey)}`
        + `&since=${_lpProgressSeenCount}`,
      );
      if (resp.ok) {
        const data = await resp.json();
        if (cancelled) return;
        if (data && data.state && Array.isArray(data.state.events)) {
          // Walk new events in order, marking each row done or failed
          // based on the event kind returned by the translator.
          for (const ev of data.state.events) {
            const mapped = _lpEventToRow(ev);
            if (!mapped) continue;
            if (mapped.kind === 'failed') {
              markRowFailed(mapped.row, mapped.error);
            } else {
              markRowDone(mapped.row);
            }
          }
          _lpProgressSeenCount = data.state.totalEvents || _lpProgressSeenCount;
          // Server marks the run done shortly after handleCreateLp
          // returns; stop polling early so we don't keep hitting the
          // endpoint after the tracker has frozen.
          if (data.state.status === 'done') return;
        }
      }
    } catch (_) {
      // Transient blip — retry on next interval.
    }
    if (!cancelled) {
      _lpProgressPollHandle = setTimeout(tick, 500);
    }
  };
  _lpProgressPollHandle = setTimeout(tick, 500);
  return () => { cancelled = true; stopLpProgressPoll(); };
}

function stopLpProgressPoll() {
  if (_lpProgressPollHandle) {
    clearTimeout(_lpProgressPollHandle);
    _lpProgressPollHandle = null;
  }
}

// Render the per-token sweep breakdown into #tokenSweepBreakdown. Reads
// from data.tokenSweep.transferred which is an array of
// { mint, amount, decimals, txId }. The launched-token row is labeled
// "preallocation leftover" so the user can see the held-back-from-LP
// portion (the "Launch wallet (unallocated)" slice from the tokenomics
// chart) actually moved to the destination wallet. Other tokens get
// labeled by mint only — typically these are quote-token leftovers from
// auto-swap or bootstrap residue.
function renderTokenSweepBreakdown(tokenSweep) {
  const container = document.getElementById('tokenSweepBreakdown');
  if (!container) return;
  const transferred = (tokenSweep && Array.isArray(tokenSweep.transferred))
    ? tokenSweep.transferred
    : [];
  if (transferred.length === 0) {
    container.innerHTML = '';
    return;
  }
  const launchedMint = createdTokenInfo && createdTokenInfo.mint
    ? String(createdTokenInfo.mint)
    : null;
  const launchedSymbol = createdTokenInfo && createdTokenInfo.symbol
    ? String(createdTokenInfo.symbol)
    : 'launched token';
  const fmt = (v) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return '—';
    return n.toLocaleString(undefined, { maximumFractionDigits: 6 });
  };
  const rows = transferred.map((t) => {
    const mint = String(t.mint || '');
    const isLaunched = launchedMint && mint === launchedMint;
    const label = isLaunched
      ? `${escapeHtml(launchedSymbol)} (preallocation leftover)`
      : (mint
        ? `<code style="font-size: 11px;">${escapeHtml(mint.slice(0, 6) + '…' + mint.slice(-4))}</code>`
        : 'token');
    const amount = fmt(t.amount);
    return `<div style="margin: 0.1rem 0;">
      <span class="has-text-grey">→</span>
      ${label}
      <span class="has-text-grey"> · </span>
      <strong>${amount}</strong>
    </div>`;
  }).join('');
  container.innerHTML = rows;
}

// Log an airdrop outcome: success summary first (so the user sees what
// worked), then per-recipient failures with their reason. Capped at 5
// failures in the log to avoid spam — the result panel shows the full list.
function logAirdropOutcome(result) {
  if (!result) return;
  const delivered = (result.transferred || []).length;
  if (delivered > 0) {
    log(`Airdrop delivered to ${delivered} recipient${delivered === 1 ? '' : 's'}`, 'success');
  }
  const failed = result.failed || [];
  const failedToShow = failed.slice(0, 5);
  for (const f of failedToShow) {
    const wShort = f.wallet ? `${f.wallet.slice(0, 4)}…${f.wallet.slice(-4)}` : 'unknown';
    log(`Airdrop failed (${wShort}): ${f.error}`, 'warning');
  }
  if (failed.length > failedToShow.length) {
    log(`…and ${failed.length - failedToShow.length} more airdrop failure${failed.length - failedToShow.length === 1 ? '' : 's'}. See the panel above for details.`, 'warning');
  }
}

async function runTransfer() {
  const btn = document.getElementById('transferAssetsBtn');
  const dest = document.getElementById('destinationWallet').value.trim();
  await withRunState(async () => {
    setLoading(btn, true);
    try {
      log(`Transferring assets to ${dest}...`);
      // Build the airdrop payload (when applicable). buildAirdropTransferPayload
      // returns null when no airdrop is configured / customize mode / no parsed
      // rows etc.; in that case the server short-circuits the airdrop step.
      const airdropPayload = buildAirdropTransferPayload();
      if (airdropPayload) {
        // Conservative estimate: ~4 seconds per recipient (350ms pace +
        // 2-3s tx confirmation + occasional retry). Real-world is usually
        // faster but a high estimate sets expectations and avoids the
        // "is it frozen?" panic during long runs.
        const n = airdropPayload.recipients.length;
        const estSeconds = Math.ceil(n * 4);
        const estDuration = estSeconds < 60
          ? `~${estSeconds}s`
          : `~${Math.ceil(estSeconds / 60)} min`;
        log(
          `Airdrop included: ${n} recipient${n === 1 ? '' : 's'} of the launched `
          + `token will receive their share before the remaining tokens sweep `
          + `to your destination. This may take ${estDuration} — please don't `
          + `close the app until it completes.`,
        );
      }
      // ---- Step 6a: airdrop (when configured) --------------------------
      // Runs as its own server call BEFORE the report publish and the
      // sweep. The airdrop is the last on-chain token-setup work, so once
      // it lands the permanent launch report can be written with the real
      // delivery results instead of a forever-"pending" section.
      // /api/run-airdrop is per-recipient idempotent (it skips wallets the
      // server's journal already records as delivered), so a transfer
      // re-run after a partial failure can never double-pay.
      if (airdropPayload) {
        // Kick off the live progress poll BEFORE the fetch so the user
        // sees the "0 / N" initial frame the moment the request goes out.
        startAirdropProgressPoll(
          tempWallet.publicKey,
          airdropPayload.recipients.length,
        );
        try {
          let aResp;
          try {
            aResp = await fetch('/api/run-airdrop', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                walletPublicKey: tempWallet.publicKey,
                ...(demoModeActive ? { tempWalletSecretKey: tempWallet.secretKey } : {}),
                tokenMint: airdropPayload.tokenMint,
                tokenDecimals: airdropPayload.tokenDecimals,
                isToken2022: !!airdropPayload.isToken2022,
                recipients: airdropPayload.recipients,
              }),
            });
          } finally {
            stopAirdropProgressPoll();
            hideAirdropProgressPanel();
          }
          const aData = await aResp.json();
          if (aResp.status === 409) {
            // Another airdrop is already in flight for this wallet —
            // don't sweep out from under it. Not a failure: wait, retry.
            log(aData.error || 'Another airdrop is already running for this wallet.', 'warning');
            return;
          }
          if (!aData.success) {
            throw new Error(aData.error || `Airdrop failed with HTTP ${aResp.status}`);
          }
          // The server returns its merged journal record (prior delivered +
          // this run) — replace wholesale.
          lastAirdropResult = {
            transferred: aData.airdrop?.transferred || [],
            failed: aData.airdrop?.failed || [],
          };
        } catch (e) {
          // The airdrop endpoint failed outright (network blip, server
          // error before per-recipient handling). Mirror the server's
          // crash shape — every recipient marked failed — and continue
          // with the publish + sweep: the un-airdropped tokens still
          // reach the destination wallet, and the journal dedup means a
          // later retry can't double-pay anyone whose tx did land.
          log(`Airdrop step failed: ${e.message} — continuing with the sweep. Use the retry button afterwards.`, 'warning');
          lastAirdropResult = {
            transferred: [],
            failed: airdropPayload.recipients.map((r) => ({
              wallet: r.wallet,
              tokens: r.tokens,
              amountRaw: null,
              error: `Airdrop step failed: ${e.message}`,
            })),
          };
        }
        renderAirdropTransferResult(lastAirdropResult);
        hideAirdropPreTransferSummary();
        logAirdropOutcome(lastAirdropResult);
      }

      // ---- Step 6b: publish the permanent launch report ----------------
      // Every on-chain token-setup transaction has landed (pools, locks,
      // transfers, airdrop). Publish to Arweave NOW, before the sweep —
      // the report carries the airdrop outcome, and the only on-chain
      // work left afterwards is the sweep itself. Awaited because the
      // ordering is the point; a publish failure is logged inside and
      // never blocks the sweep (the success-modal card offers a retry,
      // and the launch wallet's key remains available server-side).
      _resetCachedReport();
      if (typeof _publishedReport === 'undefined' || !_publishedReport
          || (_publishedReport.status !== 'done' && _publishedReport.status !== 'skipped')) {
        if (typeof isLaunchReportEnabled !== 'function' || isLaunchReportEnabled()) {
          log('Publishing the permanent launch report to Arweave…');
        }
      }
      await publishLaunchReportToArweave();

      // ---- Step 6c: sweep everything to the destination ----------------
      const resp = await fetch('/api/transfer-assets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          walletPublicKey: tempWallet.publicKey,
          // F5: the server resolves the secret from its encrypted store using
          // the public key for real launches; only demo mode (in-memory
          // ledger, no server-side secret) still sends the key inline.
          ...(demoModeActive ? { tempWalletSecretKey: tempWallet.secretKey } : {}),
          destinationWallet: dest,
          tokenMint: createdTokenInfo ? createdTokenInfo.mint : '',
          // No airdrop payload: it already ran in step 6a. The server
          // keeps its in-process airdrop branch as a safety net for old
          // clients, but this client never exercises it.
        }),
      });
      const data = await resp.json();
      if (resp.status === 409 && data.code === 'OP_IN_FLIGHT') {
        // Another launch operation is still running for this wallet —
        // e.g. pool creation that survived a UI reload, or a previous
        // transfer click. Sweeping now would pull assets out from under
        // it, so the server refused. Not a failure: wait and retry.
        log(data.error, 'warning');
        return;
      }
      if (!data.success) throw new Error(data.error);

      document.getElementById('transferResult').classList.remove('hidden');
      document.getElementById('tokensTransferred').textContent = data.tokensTransferred ?? '—';
      document.getElementById('solTransferred').textContent = data.solTransferred ?? '—';
      document.getElementById('nftsTransferred').textContent =
        data.nftSweep?.transferred?.length ?? '0';
      // Per-token breakdown of the sweep, so the user can see how much
      // of each token actually went to the destination wallet — and
      // specifically that the launched-token preallocation leftover
      // moved (the answer to "did my held-back supply get swept?").
      renderTokenSweepBreakdown(data.tokenSweep);

      // The airdrop already ran in step 6a and lastAirdropResult holds the
      // merged record. data.airdrop is null in the new flow (no payload
      // sent with the sweep); only overwrite if the server's in-process
      // safety-net branch somehow ran (old-client compatibility).
      if (data.airdrop) {
        lastAirdropResult = data.airdrop;
        renderAirdropTransferResult(lastAirdropResult);
      }
      // Pre-transfer summary is no longer relevant — the airdrop has
      // either run (result panel above takes over) or was bypassed.
      hideAirdropPreTransferSummary();

      // Step 6b already rebuilt the cached report (with the airdrop
      // section) for the Arweave publish; this render just shows it in
      // the step-6 preview container.
      renderLaunchReportPreview('step6');

      // Detect partial-failure modes. The server's transfer endpoint can
      // succeed at the top level (tokens + NFTs moved) but still have
      // individual sub-steps fail. Without surfacing these the user thinks
      // the transfer completed cleanly and may not realize funds were
      // left behind in the ephemeral wallet:
      //
      //   solSweepError       — SOL sweep failed; tokens/NFTs succeeded.
      //                         Most common cause: ephemeral wallet didn't
      //                         have enough SOL left for the tx fee after
      //                         the earlier transfers ate into it.
      //   tokenSweep.errors[] — per-token transfer failures (e.g. an ATA
      //                         creation that ran out of lamports).
      //   nftSweep.errors[]   — per-NFT failures (e.g. a locked LP NFT
      //                         that the lock contract rejected releasing).
      //   airdrop.failed[]    — per-recipient airdrop failures (invalid
      //                         address, RPC blip mid-distribution, etc.).
      //                         Distinct from the other failure modes:
      //                         the un-airdropped tokens still got swept
      //                         to the destination wallet, so the funds
      //                         aren't stranded — but the recipients
      //                         didn't get their share, and the user may
      //                         want to retry (using the destination wallet
      //                         now that the tokens have moved there).
      //
      // Each gets a warning log line so the user can investigate. The
      // wallet's pending-recovery entry is also preserved server-side
      // when the post-sweep balance check finds anything left, so the
      // user can come back later with the secret key and try again.
      const tokenErrors = data.tokenSweep?.errors || [];
      const nftErrors = data.nftSweep?.errors || [];
      // From step 6a's run (or the journal-restored record on a resumed
      // session) — the sweep response no longer carries the airdrop.
      const airdropFailed = lastAirdropResult?.failed || [];
      const hasPartialFailure =
        data.solSweepError
        || tokenErrors.length > 0
        || nftErrors.length > 0
        || airdropFailed.length > 0;

      if (data.solSweepError) {
        log(`SOL sweep failed: ${data.solSweepError}`, 'warning');
        log(
          'Tokens and NFTs were transferred successfully, but SOL stayed in the ' +
          'ephemeral wallet. Use the pending-wallets panel above to recover the ' +
          'remaining SOL with the wallet\'s secret key.',
          'warning',
        );
      }
      for (const e of tokenErrors) {
        log(`Token sweep error (${e.mint?.slice(0, 8) || 'unknown'}…): ${e.error}`, 'warning');
      }
      for (const e of nftErrors) {
        log(`NFT sweep error (${e.mint?.slice(0, 8) || 'unknown'}…): ${e.error}`, 'warning');
      }

      // Hide the Transfer button — flow is complete. Re-clicking would attempt
      // to transfer from an empty wallet, which would error confusingly.
      // EXCEPTION: when there was a partial failure (some assets stuck), leave
      // the button visible so the user can retry. The server-side post-sweep
      // verification keeps the recovery cache entry alive in this case, so a
      // retry won't lose the wallet's secret key.
      if (!hasPartialFailure) {
        document.getElementById('transferAssetsBtn').classList.add('hidden');
        log('Transfer complete', 'success');
        setStepSummary(6, 'transferred');

        // Reveal the "View launch summary" button next to the report
        // download. The launch-success modal is about to auto-open, but
        // if the user dismisses it accidentally this button gets them
        // back to the listing / verification / community links. Markup
        // for it starts with .hidden and we only drop the class here,
        // on the fully-clean path that also auto-opens the modal — the
        // two stay in lock-step.
        document.getElementById('viewLaunchSummaryBtn')?.classList.remove('hidden');

        // Auto-open the launch-success modal. Async (reads the logo
        // as a data URL inside) but we don't need to await it — the
        // rest of this success branch is independent. Catch on the
        // promise so a coin-init failure doesn't surface as an
        // unhandled rejection; showLaunchSuccessModal already logs
        // its own warnings on internal failures.
        try {
          markLaunchActiveForRpcHealth(false);
          Promise.resolve(showLaunchSuccessModal()).catch((err) => {
            console.warn('showLaunchSuccessModal rejected:', err);
          });
        } catch (err) {
          console.warn('showLaunchSuccessModal threw synchronously:', err);
        }
      } else {
        log('Transfer partially complete — see warnings above', 'warning');
        setStepSummary(6, 'partial — see warnings');
      }

      // The transfer (final sweep) has run — mark the overall launch
      // progress complete so the preview card's bar reaches 100%. Applies to
      // both the clean and partial paths: the sweep to the destination
      // completed in both; partial only means some Fee Key NFTs need manual
      // forwarding, which is surfaced separately in the warnings above.
      _launchTransferComplete = true;
      if (typeof updateLaunchProgress === 'function') updateLaunchProgress();
      // The server has already removed this wallet from the recovery
      // cache (provided the on-chain balance check confirmed it's empty).
      // Refresh the panel so it reflects the new state.
      loadLaunchJournals();
      loadPendingWallets();
    } catch (e) {
      log(`Transfer failed: ${e.message}`, 'danger');
    } finally {
      setLoading(btn, false);
    }
  });
}

// Render the airdrop result block inside Step 6 — populates the
// #airdropTransferResult container with a per-recipient summary and a
// retry button when there are failures. Called from runTransfer after
// the transfer-assets response lands, and again after a retry to
// update the displayed counts.
//
// Hides the block entirely when no airdrop ran (no panel to show).
// Shows it with a green "all delivered" notice when delivery was 100%
// successful, or with a warning notice listing the failed recipients
// and a Retry button when there were partial failures.
function renderAirdropTransferResult(airdrop) {
  const container = document.getElementById('airdropTransferResult');
  if (!container) return;
  if (!airdrop) {
    container.classList.add('hidden');
    container.innerHTML = '';
    return;
  }
  const delivered = (airdrop.transferred || []).length;
  const failed = (airdrop.failed || []).length;
  if (delivered === 0 && failed === 0) {
    container.classList.add('hidden');
    container.innerHTML = '';
    return;
  }
  container.classList.remove('hidden');

  // Build the failure rows — short wallet, error message. Wrapped in a
  // small inset container so the warning notice doesn't sprawl when
  // there are lots of failures.
  let failureRowsHtml = '';
  if (failed > 0) {
    failureRowsHtml = (airdrop.failed || []).map((f) => {
      const wAddr = f.wallet ? escapeHtml(String(f.wallet)) : 'unknown';
      const tokensTxt = Number.isFinite(Number(f.tokens))
        ? Number(f.tokens).toLocaleString(undefined, { maximumFractionDigits: 4 })
        : '—';
      // When a tx signature is present on a failure, it means we sent
      // the tx but couldn't confirm it landed (confirmation timeout
      // with a negative balance check). Surface a Solscan link so the
      // user can inspect the chain — the tx may still land later, and
      // if it did, they can decide not to retry that recipient. The
      // attempts count is a useful diagnostic for transient-vs-permanent
      // errors so we show it inline.
      const sigLinkHtml = f.signature
        ? ` &nbsp;<a href="https://solscan.io/tx/${encodeURIComponent(f.signature)}" target="_blank" rel="noopener" style="color: #5a3e1a; font-weight: 600;" title="View transaction on Solscan to verify whether it landed">verify ↗</a>`
        : '';
      const attemptsHtml = Number.isFinite(Number(f.attempts)) && Number(f.attempts) > 1
        ? ` <span class="has-text-grey is-size-7">(${f.attempts} attempts)</span>`
        : '';
      // Full wallet address — users investigating a failure need to be
      // able to copy it, look it up on Solscan, or contact the
      // recipient. word-break lets the row reflow gracefully on
      // narrow viewports rather than pushing horizontally.
      return `<div class="is-size-7" style="margin: 0.2rem 0; word-break: break-all;">
        <code style="font-size: 11px;">${wAddr}</code>
        &nbsp;·&nbsp; ${tokensTxt} tokens
        &nbsp;·&nbsp; <span style="color: #b8821a;">${escapeHtml(f.error || 'unknown error')}</span>${attemptsHtml}${sigLinkHtml}
      </div>`;
    }).join('');
  }

  if (failed === 0) {
    // All-delivered path. Green notice with the delivered count.
    container.innerHTML = `
      <div class="notification is-success is-light is-size-7 py-2 px-3">
        <p>
          <strong>Airdrop delivered</strong> to ${delivered} recipient${delivered === 1 ? '' : 's'}.
          The launched token was sent to each address before the remaining
          balance swept to your destination wallet.
        </p>
      </div>
    `;
  } else {
    // Mixed-result path. Yellow notice with delivered + failed counts,
    // failure list, retry button. The retry button targets only the
    // failed recipients; the user can click it repeatedly until they
    // either get all deliveries through or give up.
    container.innerHTML = `
      <div class="notification is-warning is-light is-size-7 py-2 px-3">
        <p class="mb-2">
          <strong>Airdrop partial:</strong>
          ${delivered} delivered, ${failed} failed.
        </p>
        <p class="mb-2" style="color: #6a4f2a;">
          <strong>Important:</strong> The launched tokens have now swept to your
          destination wallet, so a retry from the ephemeral wallet won't have
          the supply to send. Retry only works if the ephemeral wallet still
          has tokens — typically this means clicking <strong>Retry failed</strong>
          before the wallet finishes emptying, or distributing manually from
          your destination wallet using the recipient list below.
        </p>
        <details class="mt-2 mb-2">
          <summary style="cursor: pointer; user-select: none;"><strong>Failed recipients (${failed})</strong></summary>
          <div style="margin-top: 0.3rem; padding-left: 0.5rem;">
            ${failureRowsHtml}
          </div>
        </details>
        <div class="field is-grouped mt-2">
          <div class="control">
            <button class="button is-small is-warning" id="retryAirdropBtn">
              <span class="icon is-small"><i class="fas fa-redo"></i></span>
              <span>Retry failed</span>
            </button>
          </div>
          <div class="control">
            <button class="button is-small is-light" id="downloadAirdropRecipientsBtn">
              <span class="icon is-small"><i class="fas fa-file-csv"></i></span>
              <span>Download failed recipients CSV</span>
            </button>
          </div>
        </div>
      </div>
    `;
    // Wire the retry and download handlers (have to re-bind on each
    // render since innerHTML rewrites destroy the previous DOM nodes).
    const retryBtn = document.getElementById('retryAirdropBtn');
    if (retryBtn) retryBtn.addEventListener('click', runAirdropRetry);
    const dlBtn = document.getElementById('downloadAirdropRecipientsBtn');
    if (dlBtn) dlBtn.addEventListener('click', downloadFailedAirdropRecipientsCsv);
  }
}

// Retry the failed airdrop recipients via /api/retry-airdrop. Sends the
// current lastAirdropResult.failed list as the new recipient set and
// merges the result back into lastAirdropResult.
//
// Behavior:
//   - Recipients newly-delivered move from failed[] into transferred[].
//   - Recipients still-failing stay in failed[] with the (possibly new)
//     error message.
//   - The render-result function is called again with the updated state
//     so the panel reflects the new counts and (if all delivered) flips
//     to the success notice.
async function runAirdropRetry() {
  if (!lastAirdropResult || !lastAirdropResult.failed
      || lastAirdropResult.failed.length === 0) {
    return;
  }
  if (!createdTokenInfo || !createdTokenInfo.mint) {
    log('Cannot retry airdrop: token info missing.', 'warning');
    return;
  }
  if (!tempWallet || !tempWallet.secretKey) {
    log('Cannot retry airdrop: launch wallet key not available.', 'warning');
    return;
  }
  const recipients = lastAirdropResult.failed.map((f) => ({
    wallet: f.wallet,
    tokens: f.tokens,
  }));
  const btn = document.getElementById('retryAirdropBtn');
  setLoading(btn, true);
  try {
    log(`Retrying airdrop to ${recipients.length} recipient${recipients.length === 1 ? '' : 's'}...`);
    // Kick off the live progress poll. Same pattern as runTransfer —
    // mirrors what the user sees during the initial airdrop step.
    startAirdropProgressPoll(tempWallet.publicKey, recipients.length);
    let resp;
    try {
      resp = await fetch('/api/retry-airdrop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          walletPublicKey: tempWallet.publicKey,
          // F5: the server resolves the secret from its encrypted store using
          // the public key for real launches; only demo mode (in-memory
          // ledger, no server-side secret) still sends the key inline.
          ...(demoModeActive ? { tempWalletSecretKey: tempWallet.secretKey } : {}),
          tokenMint: createdTokenInfo.mint,
          tokenDecimals: createdTokenInfo.decimals,
          isToken2022: false,
          recipients,
        }),
      });
    } finally {
      stopAirdropProgressPoll();
      hideAirdropProgressPanel();
    }
    const data = await resp.json();
    if (!data.success) throw new Error(data.error);
    // The server returns the MERGED per-recipient record (prior delivered +
    // this attempt's outcome, deduped against its journal) — replace our
    // copy wholesale rather than appending, which would double-count the
    // previously-delivered rows. Compute the log lines as deltas against
    // what we held before the call.
    const priorDeliveredCount = (lastAirdropResult.transferred || []).length;
    lastAirdropResult = {
      transferred: data.airdrop?.transferred || [],
      failed: data.airdrop?.failed || [],
    };
    renderAirdropTransferResult(lastAirdropResult);
    const delivered = Math.max(0, lastAirdropResult.transferred.length - priorDeliveredCount);
    const stillFailed = lastAirdropResult.failed.length;
    if (delivered > 0) {
      log(`Retry: ${delivered} additional recipient${delivered === 1 ? '' : 's'} delivered`, 'success');
    }
    if (stillFailed > 0) {
      log(`Retry: ${stillFailed} recipient${stillFailed === 1 ? '' : 's'} still failed`, 'warning');
    }
  } catch (e) {
    log(`Airdrop retry failed: ${e.message}`, 'danger');
  } finally {
    setLoading(btn, false);
  }
}

// Download the failed-recipients list as a CSV the user can use to
// manually distribute from their destination wallet (or hand off to
// another tool). Format matches the input airdrop CSV so the user
// could in principle re-upload it as a fresh launch — though that's
// not the typical use case.
function downloadFailedAirdropRecipientsCsv() {
  if (!lastAirdropResult || !lastAirdropResult.failed
      || lastAirdropResult.failed.length === 0) {
    return;
  }
  // wallet,tokens header matches the airdrop CSV input format. We add
  // a third "reason" column so the user has the failure context next
  // to each recipient, which is useful when triaging.
  const lines = ['wallet,tokens,reason'];
  for (const f of lastAirdropResult.failed) {
    const w = String(f.wallet || '');
    const t = Number.isFinite(Number(f.tokens)) ? String(f.tokens) : '';
    // Escape commas and quotes inside the reason field per RFC 4180.
    const reasonRaw = String(f.error || 'unknown');
    const reason = /[",\n]/.test(reasonRaw)
      ? '"' + reasonRaw.replace(/"/g, '""') + '"'
      : reasonRaw;
    lines.push(`${w},${t},${reason}`);
  }
  const csv = lines.join('\n') + '\n';
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const mintShort = (createdTokenInfo?.mint || 'launch').slice(0, 8);
  a.download = `airdrop-failed-${mintShort}-${Date.now()}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ===========================================================================
// Launch-journal recovery panel
// ---------------------------------------------------------------------------
// Launch journals are non-secret records of previous sessions: wallet public
// key, token mint, pool IDs, tx IDs, failed phase, and transfer outcome.
// They complement pending wallets, which hold the secret material needed for
// manual recovery.
// ===========================================================================

let launchJournalStartupIds = null;

async function loadLaunchJournals() {
  const panel = document.getElementById('launchJournalsPanel');
  const list = document.getElementById('launchJournalsList');
  if (!panel || !list) return;

  try {
    const [resp, walletResp] = await Promise.all([
      fetch('/api/launch-journals').then((r) => r.json()),
      fetch('/api/pending-wallets').then((r) => r.json()).catch(() => ({ wallets: [] })),
    ]);
    let journals = (resp && resp.journals) || [];
    const walletsByPublicKey = new Map(
      ((walletResp && walletResp.wallets) || []).map((wallet) => [wallet.publicKey, wallet]),
    );

    if (launchJournalStartupIds === null) {
      launchJournalStartupIds = new Set(journals.map((j) => j.id));
    }

    journals = journals.filter((j) => launchJournalStartupIds.has(j.id));

    if (journals.length === 0) {
      panel.classList.add('hidden');
      list.innerHTML = '';
      return;
    }

    list.innerHTML = '';
    for (const journal of journals) {
      list.appendChild(buildLaunchJournalRow(journal, walletsByPublicKey.get(journal.walletPublicKey)));
    }
    panel.classList.remove('hidden');
  } catch (e) {
    console.warn('Failed to load launch journals:', e);
    panel.classList.add('hidden');
  }
}

function shortAddress(value, prefix = 6, suffix = 6) {
  if (!value || typeof value !== 'string') return 'unknown';
  if (value.length <= prefix + suffix + 1) return value;
  return `${value.slice(0, prefix)}...${value.slice(-suffix)}`;
}

function launchJournalStageLabel(journal) {
  const stage = journal.stage || 'unknown';
  const labels = {
    wallet_generated: 'Wallet generated',
    token_create_started: 'Token creation started',
    logo_uploaded: 'Logo uploaded',
    metadata_uploaded: 'Metadata uploaded',
    mint_created: 'Mint created',
    metadata_account_created: 'Metadata account created',
    supply_minted: 'Supply minted',
    mint_authority_revoked: 'Mint authority revoked',
    metadata_update_authority_revoked: 'Metadata authority revoked',
    token_safety_verified: 'Token safety verified',
    token_created: 'Token created',
    token_create_failed: 'Token creation failed',
    lp_create_started: 'Pool creation started',
    lp_resume_started: 'Launch resume started',
    lp_recovered_for_transfer: 'Launch recovered for transfer',
    pool_create_done: 'Pool created',
    phase1_pool_done: 'Pool positions recorded',
    main_open_done: 'Main LP position opened',
    ladder_open_done: 'Ladder position opened',
    bootstrap_open_done: 'Bootstrap opened',
    main_lock_done: 'LP position locked',
    main_lock_failed: 'LP position lock failed',
    ladder_lock_done: 'Ladder position locked',
    ladder_lock_failed: 'Ladder position lock failed',
    bootstrap_lock_done: 'Bootstrap locked',
    bootstrap_lock_failed: 'Bootstrap lock failed',
    phase3_done: 'Lock phase completed',
    main_transfer_done: 'Fee Key transferred',
    main_transfer_failed: 'Fee Key transfer failed',
    phase4_done: 'Fee Key transfer phase completed',
    bootstrap_failed: 'Bootstrap failed',
    lp_created: 'Pools completed',
    lp_pre_flight_failed: 'Validation failed',
    lp_main_positions_failed: 'Pool creation failed',
    lp_bootstrap_failed: 'Bootstrap failed',
    lp_locks_failed: 'Locking failed',
    lp_transfers_failed: 'Fee Key transfer failed',
    transfer_started: 'Final sweep started',
    transfer_partial: 'Final sweep incomplete',
    transfer_completed: 'Final sweep completed',
    transfer_failed: 'Final sweep failed',
  };
  return labels[stage] || stage.replaceAll('_', ' ');
}

function launchJournalRecoveryText(journal) {
  // A funds shortfall is the one launch-stop with a clean fix: top up the
  // launch wallet and resume. Surface it ahead of the phase-specific messages
  // since the remedy is the same regardless of which phase ran short, and
  // resume adopts any already-created pool and continues from there.
  if (journal.lp?.failedKind === 'insufficient_funds') {
    return 'The launch stopped because the launch wallet ran low on SOL. Add SOL to the launch wallet (this entry shows its address), then use Resume \u2014 it will adopt any pool already created and continue from where it stopped.';
  }
  const orphanedPoolEvents = unsafeCreatedPoolEvents(journal);
  if (orphanedPoolEvents.length > 0) {
    return 'A pool was created and some positions opened before the launch stopped. The launch wallet still controls them \u2014 use Resume to adopt that pool and open the remaining positions automatically.';
  }
  if (journal.transfer?.walletEmpty === false || journal.stage === 'transfer_partial') {
    return 'Final sweep did not prove the launch wallet empty. Use this entry\u2019s recovery phrase to sweep or import the wallet manually.';
  }
  if (journal.lp?.failedPhase === 'bootstrap') {
    return 'Pools and main positions were recorded, but one or more bootstrap positions are missing. Created pools are permanent; sweep the wallet or retry bootstraps from the recorded plan.';
  }
  if (journal.lp?.failedPhase === 'locks') {
    return 'Pools and bootstraps were recorded, but one or more locks failed. Unlocked LP NFTs remain controlled by the launch wallet.';
  }
  if (journal.lp?.failedPhase === 'transfers') {
    return 'The launch reached locked positions, but some Fee Key deliveries failed. Remaining Fee Key NFTs should still be in the launch wallet for sweep or manual transfer.';
  }
  if (journal.lp?.partialResults?.length > 0) {
    return 'Some pool work landed on-chain before the launch stopped. Created pools are permanent; the launch wallet controls any unswept tokens and LP NFTs.';
  }
  if (journal.token?.mint && journal.token.mintAuthorityRenounced !== true && !journalHasCompletedLp(journal)) {
    return 'The token mint exists, but creating it didn\u2019t finish \u2014 some of metadata, supply, or authority-renounce didn\u2019t land. Use "Finish token creation" to complete only those steps for this mint; it will not create a new token.';
  }
  if (journal.token?.mint) {
    return 'The token mint was recorded. If the launch stopped before pools or transfer, the minted supply should still be controlled by the launch wallet.';
  }
  return 'A launch wallet was generated, but no token mint was recorded. If you funded this wallet, use this entry\u2019s recovery phrase to recover the funds.';
}

function launchJournalPoolRows(journal) {
  const lp = journal.lp || {};
  const results = Array.isArray(lp.results) && lp.results.length > 0
    ? lp.results
    : (Array.isArray(lp.partialResults) ? lp.partialResults : []);
  if (results.length === 0) return '';

  const rows = results.slice(0, 6).map((r) => {
    const positions = [
      ...(Array.isArray(r.mainPositions) ? r.mainPositions : []),
      ...(Array.isArray(r.ladderPositions) ? r.ladderPositions : []),
      ...(r.bootstrap ? [r.bootstrap] : []),
    ];
    const locked = positions.filter((p) => p.locked).length;
    const bootstrap = r.bootstrap?.nftMint ? 'bootstrap opened' : 'bootstrap missing';
    return `<li><strong>${escapeHtml(r.quoteSymbol || 'pool')}</strong>: ` +
      `${escapeHtml(shortAddress(r.poolId, 6, 6))}, ` +
      `${positions.length} position${positions.length === 1 ? '' : 's'}, ` +
      `${locked}/${positions.length} locked, ${bootstrap}</li>`;
  }).join('');
  const more = results.length > 6
    ? `<li>${results.length - 6} more pool${results.length - 6 === 1 ? '' : 's'} recorded</li>`
    : '';
  return `<ul class="mt-2 mb-0">${rows}${more}</ul>`;
}

function launchJournalTxRows(journal) {
  const events = Array.isArray(journal.events) ? journal.events : [];
  const txs = [];
  for (const event of events) {
    if (typeof event.txId === 'string' && !txs.includes(event.txId)) {
      txs.push(event.txId);
    }
  }
  if (txs.length === 0) return '';
  const shown = txs.slice(0, 5)
    .map((tx) => `<span class="tag is-light is-family-monospace mr-1 mb-1">${escapeHtml(shortAddress(tx, 8, 6))}</span>`)
    .join('');
  const more = txs.length > 5
    ? `<span class="tag is-light mr-1 mb-1">+${txs.length - 5} more</span>`
    : '';
  return `<div class="mt-2"><strong>Recorded txs:</strong> ${shown}${more}</div>`;
}

// Stored, structured LP results from the journal — authoritative for any
// allocation that finished Phase 1. Kept separate from the reconstructed view
// below so callers that need "what the structured results already record" (the
// orphaned-pool messaging) aren't confused by event-reconstructed entries.
function journalStoredResults(journal) {
  const lp = journal.lp || {};
  const source = Array.isArray(lp.results) && lp.results.length > 0
    ? lp.results
    : (Array.isArray(lp.partialResults) ? lp.partialResults : []);
  return source.filter((result) => result && result.poolId);
}

// Frontend mirror of launchRecovery.js (server). Reconstruct per-allocation LP
// results from the journal's granular Phase-1 events so a launch that died
// mid-Phase-1 (pool created, some positions open, no phase1_pool_done) still
// presents a resumable result. Must stay in sync with the server module; see
// its header for the full rationale.
function journalReconstructFromEvents(journal) {
  const events = Array.isArray(journal.events) ? journal.events : [];
  const byAlloc = new Map();
  const ensure = (ai) => {
    if (!byAlloc.has(ai)) {
      byAlloc.set(ai, {
        allocationIndex: ai,
        poolId: null,
        txIds: { createPool: null },
        mainPositions: [],
        ladderPositions: [],
        supportPositions: [],
        bootstrap: null,
      });
    }
    return byAlloc.get(ai);
  };
  const upsertIndexed = (list, key, value, nftMint, openTxId) => {
    let entry = list.find((p) => p[key] === value);
    if (!entry) {
      entry = { [key]: value, nftMint: null, locked: false, txIds: { open: null } };
      list.push(entry);
    }
    if (nftMint) entry.nftMint = nftMint;
    entry.txIds.open = openTxId || entry.txIds.open || null;
  };

  for (const event of events) {
    if (!event || typeof event.stage !== 'string') continue;
    const ai = event.allocationIndex;
    if (!Number.isInteger(ai)) continue;
    if (event.stage === 'pool_create_done' || event.stage === 'pool_adopted') {
      const a = ensure(ai);
      if (event.poolId) a.poolId = event.poolId;
      a.txIds.createPool = event.txId || a.txIds.createPool || null;
    } else if (event.stage === 'main_open_done' || event.stage === 'main_open_skip') {
      if (Number.isInteger(event.sliceIndex)) {
        upsertIndexed(ensure(ai).mainPositions, 'sliceIndex', event.sliceIndex, event.nftMint, event.txId);
      }
    } else if (event.stage === 'ladder_open_done' || event.stage === 'ladder_open_skip') {
      if (Number.isInteger(event.bandIndex)) {
        upsertIndexed(ensure(ai).ladderPositions, 'bandIndex', event.bandIndex, event.nftMint, event.txId);
      }
    } else if (event.stage === 'support_open_done' || event.stage === 'support_open_skip') {
      if (event.nftMint) {
        const list = ensure(ai).supportPositions;
        let entry = list.find((p) => p.nftMint === event.nftMint);
        if (!entry) {
          entry = { nftMint: event.nftMint, locked: false, txIds: { open: null } };
          list.push(entry);
        }
        entry.txIds.open = event.txId || entry.txIds.open || null;
      }
    } else if (event.stage === 'bootstrap_open_done') {
      ensure(ai).bootstrap = {
        nftMint: event.nftMint || null,
        locked: false,
        tickLower: Number.isFinite(event.tickLower) ? event.tickLower : null,
        tickUpper: Number.isFinite(event.tickUpper) ? event.tickUpper : null,
        txIds: { open: event.txId || null, lock: null },
      };
    }
  }

  const out = [];
  for (const a of byAlloc.values()) {
    if (!a.poolId) continue;
    a.mainPositions.sort((x, y) => x.sliceIndex - y.sliceIndex);
    a.ladderPositions.sort((x, y) => x.bandIndex - y.bandIndex);
    out.push(a);
  }
  out.sort((x, y) => x.allocationIndex - y.allocationIndex);
  return out;
}

// Stored results win per allocation; reconstruction only fills allocations the
// stored results don't cover. Mirrors mergePriorResults in launchRecovery.js.
function journalMergePriorResults(stored, reconstructed) {
  const byAlloc = new Map();
  for (const r of reconstructed) {
    if (r && Number.isInteger(r.allocationIndex)) byAlloc.set(r.allocationIndex, r);
  }
  for (const r of stored) {
    if (r && Number.isInteger(r.allocationIndex)) byAlloc.set(r.allocationIndex, r);
  }
  return [...byAlloc.values()]
    .filter((r) => r && r.poolId)
    .sort((x, y) => (x.allocationIndex ?? 0) - (y.allocationIndex ?? 0));
}

// The resume payload preview / step-5 summary view: stored results plus any
// allocation reconstructed from events (the mid-Phase-1 failure case). Matches
// what the server hands the orchestrator on resume.
function journalPriorResults(journal) {
  return journalMergePriorResults(
    journalStoredResults(journal),
    journalReconstructFromEvents(journal),
  );
}

function journalHasCompletedLp(journal) {
  const lp = journal.lp || {};
  return (
    ['lp_created', 'transfer_started', 'transfer_partial', 'transfer_failed'].includes(journal.stage) &&
    Array.isArray(lp.results) &&
    lp.results.length > 0 &&
    !lp.failedPhase
  );
}

// Pools the journal recorded as created whose allocation never made it into
// the STORED structured results — i.e. a launch that died mid-Phase-1. This no
// longer blocks resume (the server adopts such pools after verifying them
// on-chain); it only drives the recovery guidance text below.
function unsafeCreatedPoolEvents(journal) {
  const stored = new Set(journalStoredResults(journal).map((r) => r.allocationIndex));
  return (journal.events || []).filter(
    (event) =>
      event.stage === 'pool_create_done' &&
      !stored.has(event.allocationIndex),
  );
}

function canFinishTokenJournal(journal) {
  // The mint exists but its mint authority was never renounced: token creation
  // stopped after the mint was created. Offer to finish it in place rather than
  // mint a brand-new token (which would waste a vanity address). A journal that
  // has moved on to LP already has its mint authority renounced, so this
  // naturally excludes LP-stage entries.
  return !!(
    journal.token?.mint &&
    journal.token.mintAuthorityRenounced !== true &&
    !journalHasCompletedLp(journal)
  );
}

function canResumeLaunchJournal(journal, wallet) {
  // Client-side preconditions only: the plan exists and a recoverable wallet
  // secret is present. A pool created mid-Phase-1 is NO LONGER a block — the
  // server reconstructs the orphaned pool from the event log, verifies it
  // on-chain, and adopts it. The server stays the authority and refuses safely
  // if verification fails, so offering the button here can't strand the user.
  return !!(
    journal.token?.mint &&
    journal.poolPlan?.tokenTotalSupply &&
    journal.poolPlan?.targetMarketCapUsd &&
    Array.isArray(journal.poolPlan?.allocations) &&
    wallet &&
    Array.isArray(wallet.secretKey)
  );
}

function prepareRecoveredSessionFromJournal(journal, wallet) {
  tempWallet = {
    publicKey: wallet.publicKey,
    secretKey: wallet.secretKey,
    secretKeyB58: wallet.secretKeyB58,
    mnemonic: wallet.mnemonic,
  };
  fundingWallet = null;
  fundingDetectionExhausted = false;
  createdTokenInfo = {
    mint: journal.token.mint,
    decimals: journal.token.decimals || journal.poolPlan?.tokenDecimals || 9,
    totalSupply: journal.token.totalSupply || journal.poolPlan?.tokenTotalSupply,
    name: journal.token.name || '',
    symbol: journal.token.symbol || 'TOKEN',
    // Token-safety facts restored from the journal (recorded there at
    // token-creation time) so a resumed launch still publishes a complete
    // audit record to Arweave.
    metadataUri: journal.token.metadataUri || null,
    imageUri: journal.token.imageUri || null,
    mintAuthorityRenounced: journal.token.mintAuthorityRenounced === true,
    freezeAuthorityDisabled: journal.token.freezeAuthorityDisabled === true,
    metadataUpdateAuthorityRevoked: journal.token.metadataUpdateAuthorityRevoked === true,
    metadataImmutable: journal.token.metadataImmutable === true,
  };
  lpResult = { results: journalPriorResults(journal) };

  // Airdrop state. The journal carries two complementary records:
  //   - journal.airdrop: the per-recipient result of any airdrop that
  //     already ran (written by transfer-assets / retry-airdrop). Restoring
  //     it brings back the report's delivered/failed section and the
  //     retry button after an app restart.
  //   - journal.poolPlan.airdropPlan: the configured plan, journaled at
  //     create-lp. Restoring it lets a resumed transfer still execute the
  //     airdrop even though the simple-mode config it was built from
  //     didn't survive the restart. The server filters out recipients its
  //     journal already records as delivered, so restoring the full plan
  //     is safe regardless of how far the airdrop got.
  lastAirdropResult = (journal.airdrop && typeof journal.airdrop === 'object')
    ? journal.airdrop
    : null;
  restoredAirdropPayload = journal.poolPlan?.airdropPlan || null;
  // Publish state: if the permanent report already went to Arweave in a
  // previous session, restore the recorded URIs so the UI shows the link
  // and runTransfer's publish step becomes a no-op (the server is also
  // idempotent on this, so the restore is belt-and-braces for the UI).
  if (journal.reportPublish && journal.reportPublish.jsonUri) {
    _publishedReport = {
      status: 'done',
      jsonUri: journal.reportPublish.jsonUri,
      htmlUri: journal.reportPublish.htmlUri || null,
    };
    if (typeof refreshLaunchReportUi === 'function') refreshLaunchReportUi();
  }

  document.body.classList.add('has-log');
  document.getElementById('walletInfo')?.classList.remove('hidden');
  const walletAddress = document.getElementById('walletAddress');
  if (walletAddress) walletAddress.value = wallet.publicKey;
  document.getElementById('privateKeyContainer')?.classList.add('hidden');
  document.getElementById('tokenCreatedInfo')?.classList.remove('hidden');
  const mintEl = document.getElementById('tokenMintAddress');
  if (mintEl) mintEl.textContent = journal.token.mint;
  const solscanLink = document.getElementById('tokenSolscanLink');
  if (solscanLink) solscanLink.href = `https://solscan.io/token/${journal.token.mint}`;

  document.getElementById('createTokenBtn')?.classList.add('hidden');
  document.getElementById('createLpBtn')?.classList.add('hidden');
  document.getElementById('transferAssetsBtn')?.classList.remove('hidden');
  document.getElementById('transferResult')?.classList.add('hidden');
  // The "View launch summary" button is revealed only on a fully clean
  // transfer (runTransfer success branch). When resuming a stale journal
  // in a session where a previous launch already completed successfully,
  // the button could still carry over visible from that earlier success.
  // Re-hide it here so the resumed launch's step 6 starts in the right
  // state — symmetrical with the transferResult reset right above.
  document.getElementById('viewLaunchSummaryBtn')?.classList.add('hidden');
  const dest = document.getElementById('destinationWallet');
  if (dest) dest.value = '';

  setStepSummary(1, `${wallet.publicKey.slice(0, 8)}...${wallet.publicKey.slice(-6)}`);
  setStepSummary(4, `${createdTokenInfo.symbol} - ${createdTokenInfo.mint.slice(0, 8)}...`);
  const count = lpResult.results.length;
  setStepSummary(5, count > 0 ? `${count} pool${count === 1 ? '' : 's'} recorded` : 'ready to resume');
}

async function resumeLaunchJournal(journal, wallet, btn) {
  const completedLp = journalHasCompletedLp(journal);
  const actionLabel = completedLp ? 'Continue transfer' : 'Resume launch';
  const ok = await confirmDialog({
    title: `${actionLabel}?`,
    body:
      `<p>${completedLp ? 'Recover the recorded launch session' : 'Resume the recorded launch'} for <strong>${escapeHtml(journal.token?.symbol || 'this token')}</strong>?</p>` +
      `<p>Trebuchet will use the recovered launch wallet ${completedLp ? 'and take you to the final transfer step.' : 'and retry only work that the journal does not show as complete. Review the activity log after it finishes.'}</p>`,
    confirmLabel: actionLabel,
  });
  if (!ok) return;

  await withRunState(async () => {
    setLoading(btn, true);
    try {
      prepareRecoveredSessionFromJournal(journal, wallet);
      log(`${completedLp ? 'Recovering' : 'Resuming'} launch journal for ${createdTokenInfo.symbol}...`, 'warning');

      const resp = await fetch('/api/launch-journals/resume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: journal.id }),
      });
      const data = await resp.json();
      if (!data.success) {
        if (Array.isArray(data.partialResults) && data.partialResults.length > 0) {
          lpResult = { results: data.partialResults };
          setStepSummary(5, `partial - sweep available`);
          activateStep(6);
        }
        throw new Error(data.error || `Resume failed with HTTP ${resp.status}`);
      }

      lpResult = data;
      const count = (data.results || []).length;
      setStepSummary(5, `${count} pool${count === 1 ? '' : 's'} completed`);
      log(`${completedLp ? 'Recovery' : 'Resume'} complete: ${count} pool${count === 1 ? '' : 's'} ready for final transfer`, 'success');
      activateStep(6);
      try {
        await detectFundingWallet();
      } catch {
        // Best-effort convenience only; destination remains manually editable.
      }
      prefillDestinationFromFunder();
      await loadLaunchJournals();
      await loadPendingWallets();
    } catch (e) {
      log(`Journal resume failed: ${e.message}`, 'danger');
    } finally {
      setLoading(btn, false);
    }
  });
}

function buildLaunchJournalRow(journal, wallet) {
  const wrap = document.createElement('div');
  wrap.className = 'box p-3 mb-2 is-size-7';

  const tokenLabel = journal.token?.symbol
    ? `${journal.token.symbol} (${shortAddress(journal.token.mint || '', 6, 6)})`
    : (journal.token?.mint ? shortAddress(journal.token.mint, 6, 6) : 'No token mint recorded');
  const walletShort = shortAddress(journal.walletPublicKey, 6, 6);
  const ageStr = formatAge(journal.updatedAt || journal.createdAt);
  const errorHtml = journal.error
    ? `<div class="notification is-danger is-light is-size-7 py-2 px-3 my-2">${escapeHtml(journal.error)}</div>`
    : '';
  const canResume = canResumeLaunchJournal(journal, wallet);
  const canFinish = canFinishTokenJournal(journal);
  const resumeLabel = journalHasCompletedLp(journal) ? 'Continue transfer' : 'Resume launch';
  const resumeHelp = !canResume && journal.token?.mint && journal.poolPlan?.allocations
    ? `<div class="has-text-grey mt-2">Automatic resume is unavailable${wallet?.decryptionFailed ? ': wallet secret could not be decrypted' : ': matching recoverable wallet is missing'}.</div>`
    : '';

  // Recovery material from the matching wallet, folded into this card so the
  // whole stalled launch is handled in one place (no second panel to
  // cross-reference). hasSecret is true only when the wallet exists and its
  // secret decrypted; secretIsMnemonic picks the recovery-phrase vs raw-key
  // wording. When a wallet is attached but can't be decrypted we show a note
  // instead of a copy button.
  const hasSecret = !!(wallet && !wallet.decryptionFailed && (wallet.mnemonic || wallet.secretKeyB58));
  const secretIsMnemonic = hasSecret && !!wallet.mnemonic;
  const recoverBtnHtml = hasSecret ? `
        <div class="control">
          <button class="button is-small is-info" data-action="copy-recovery">
            <span class="icon is-small"><i class="fas ${secretIsMnemonic ? 'fa-list-ol' : 'fa-key'}"></i></span>
            <span>${secretIsMnemonic ? 'Copy recovery phrase' : 'Copy secret key'}</span>
          </button>
        </div>` : '';
  const decryptNoteHtml = (wallet && wallet.decryptionFailed) ? `
    <div class="notification is-danger is-light is-size-7 py-2 px-3 my-2">
      The recoverable wallet for this launch can't be decrypted — the OS
      keychain key has likely changed (file copied to another account or
      machine, or the keychain was reset). If you backed up the recovery
      phrase elsewhere, use that.
    </div>` : '';
  // The removal action also discards the wallet secret when one is attached,
  // so the label and confirmation make that consequence explicit.
  const removeLabel = hasSecret ? 'Dismiss &amp; discard wallet' : 'Dismiss journal';

  wrap.innerHTML = `
    <div class="mb-1">
      <strong>${escapeHtml(tokenLabel)}</strong>
      <span class="tag is-warning is-light ml-1">${escapeHtml(launchJournalStageLabel(journal))}</span>
      <span class="has-text-grey ml-1">${escapeHtml(ageStr)}</span>
    </div>
    <div><strong>Launch wallet:</strong> <span class="is-family-monospace">${escapeHtml(walletShort)}</span></div>
    ${journal.token?.mint ? `<div><strong>Token mint:</strong> <span class="is-family-monospace">${escapeHtml(shortAddress(journal.token.mint, 8, 8))}</span></div>` : ''}
    ${errorHtml}
    <div class="notification is-warning is-light is-size-7 py-2 px-3 my-2">
      ${escapeHtml(launchJournalRecoveryText(journal))}
    </div>
    ${decryptNoteHtml}
    ${launchJournalPoolRows(journal)}
    ${launchJournalTxRows(journal)}
    ${resumeHelp}
    <div class="field is-grouped is-grouped-multiline mt-3">
      ${canResume ? `
        <div class="control">
          <button class="button is-small is-primary" data-action="resume">
            <span class="icon is-small"><i class="fas fa-redo"></i></span>
            <span>${resumeLabel}</span>
          </button>
        </div>
      ` : ''}
      ${canFinish ? `
        <div class="control">
          <button class="button is-small is-warning" data-action="finish-token">
            <span class="icon is-small"><i class="fas fa-flag-checkered"></i></span>
            <span>Finish token creation</span>
          </button>
        </div>
      ` : ''}
      ${hasSecret ? `
        <div class="control">
          <button class="button is-small is-success" data-action="use-wallet">
            <span class="icon is-small"><i class="fas fa-play"></i></span>
            <span>Use wallet for new launch</span>
          </button>
        </div>
      ` : ''}
      ${recoverBtnHtml}
      ${journal.token?.mint ? `
        <div class="control">
          <button class="button is-small" data-action="copy-token">
            <span class="icon is-small"><i class="fas fa-copy"></i></span>
            <span>Copy token mint</span>
          </button>
        </div>
      ` : ''}
      <div class="control">
        <button class="button is-small" data-action="copy-wallet">
          <span class="icon is-small"><i class="fas fa-copy"></i></span>
          <span>Copy launch wallet</span>
        </button>
      </div>
      <div class="control">
        <button class="button is-small is-danger is-light" data-action="dismiss">
          <span class="icon is-small"><i class="fas fa-trash"></i></span>
          <span>${removeLabel}</span>
        </button>
      </div>
    </div>
  `;

  const copyText = async (text, description) => {
    try {
      await navigator.clipboard.writeText(text);
      log(`${description} copied to clipboard`, 'info');
    } catch (e) {
      log(`Couldn't copy ${description}: ${e.message}`, 'warning');
    }
  };

  wrap.querySelector('[data-action="copy-token"]')?.addEventListener('click', async () => {
    await copyText(journal.token.mint, 'Token mint');
  });
  wrap.querySelector('[data-action="copy-wallet"]').addEventListener('click', async () => {
    await copyText(journal.walletPublicKey, 'Launch wallet public key');
  });

  // Finish-token button: complete an interrupted token creation (the mint
  // exists but post-mint steps did not all land). The server reads the recorded
  // token params + on-chain state and completes only what is missing.
  wrap.querySelector('[data-action="finish-token"]')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const ok = await confirmDialog({
      title: 'Finish token creation?',
      body: `<p>Complete the interrupted creation of <strong>${escapeHtml(journal.token?.symbol || 'this token')}</strong>? This finishes only the steps that did not land (metadata, supply, authority renounce) for the existing mint \u2014 it will not create a new token.</p>`,
      confirmLabel: 'Finish',
    });
    if (!ok) return;
    btn.classList.add('is-loading');
    btn.disabled = true;
    try {
      const resp = await fetch('/api/finish-token-creation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ walletPublicKey: journal.walletPublicKey }),
      });
      const data = await resp.json();
      if (!resp.ok || !data.success) {
        throw new Error(data.error || `Finish failed with HTTP ${resp.status}`);
      }
      if (data.steps?.length) log(`Token finish: ${data.steps.join('; ')}`, 'info');
      if (data.sanity?.length) data.sanity.forEach((msg) => log(`Token finish sanity: ${msg}`, 'warning'));
      log(
        data.isSafe
          ? 'Token creation finished \u2014 token is safe (authorities renounced)'
          : 'Token creation finished, but the metadata update authority could not be revoked; verify on Solscan',
        data.isSafe ? 'success' : 'warning',
      );
      await loadLaunchJournals();
    } catch (err) {
      log(`Finish token creation failed: ${err.message}`, 'error');
      btn.classList.remove('is-loading');
      btn.disabled = false;
    }
  });

  // Use-wallet button: load this wallet as active tempWallet for a fresh launch
  wrap.querySelector('[data-action="use-wallet"]')?.addEventListener('click', async () => {
    if (!wallet || !wallet.secretKey) return;
    if (tempWallet) {
      const ok = await confirmDialog({
        title: 'Switch wallet?',
        body: '<p>You already have a wallet from this session. Switching will discard it.</p><p>Proceed?</p>',
        confirmLabel: 'Switch',
        danger: true,
      });
      if (!ok) return;
    }
    fundingWallet = null;
    fundingDetectionExhausted = false;
    lastSolBalance = 0;
    createdTokenInfo = null;
    lpResult = null;
    fundingRequirement = { solLamports: 0, byQuote: {}, autoSwapPlan: [] };
    if (typeof clearVanityCAs === 'function') clearVanityCAs();

    tempWallet = {
      publicKey: wallet.publicKey,
      secretKey: wallet.secretKey,
      secretKeyB58: wallet.secretKeyB58,
      mnemonic: wallet.mnemonic || null,
    };

    document.getElementById('walletInfo').classList.remove('hidden');
    document.getElementById('walletAddress').value = wallet.publicKey;
    document.getElementById('qrCode').src = '';
    document.getElementById('privateKeyContainer').classList.add('hidden');
    document.getElementById('tokenCreatedInfo').classList.add('hidden');
    document.getElementById('createTokenBtn').classList.remove('hidden');
    document.getElementById('createLpBtn').classList.remove('hidden');
    document.getElementById('transferAssetsBtn').classList.remove('hidden');
    setLpDoneVisible(false);
    document.getElementById('lpFailInfo').classList.add('hidden');
    document.getElementById('lpProgress').classList.add('hidden');
    document.getElementById('lpProgressTree').innerHTML = '';
    document.getElementById('transferResult').classList.add('hidden');
    document.getElementById('fundingWalletInfo').classList.add('hidden');
    document.getElementById('destinationWallet').value = '';

    for (let i = 2; i <= 6; i++) setStepSummary(i, '');
    document.body.classList.add('has-log');
    log('Using wallet from incomplete launch: ' + wallet.publicKey, 'success');
    markLaunchActiveForRpcHealth(false);
    if (typeof rebuildPoolsFromSimple === 'function' && pools.length === 0) rebuildPoolsFromSimple();
    if (typeof applySimpleConfigMode === 'function') applySimpleConfigMode();
    setStepSummary(1, wallet.publicKey.slice(0, 8) + '…' + wallet.publicKey.slice(-6));
    if (typeof activateStep === 'function') activateStep(2);
    if (typeof updateContinueToFundingState === 'function') updateContinueToFundingState();
    if (typeof updateCancelButtonState === 'function') updateCancelButtonState();
  });
  wrap.querySelector('[data-action="copy-recovery"]')?.addEventListener('click', async () => {
    const text = wallet && (wallet.mnemonic || wallet.secretKeyB58);
    if (!text) {
      log(`No recovery secret available for ${walletShort}`, 'warning');
      return;
    }
    await copyText(text, wallet.mnemonic ? 'Recovery phrase' : 'Secret key');
  });
  wrap.querySelector('[data-action="resume"]')?.addEventListener('click', async (event) => {
    await resumeLaunchJournal(journal, wallet, event.currentTarget);
  });
  wrap.querySelector('[data-action="dismiss"]').addEventListener('click', async () => {
    // When a recoverable wallet is attached, removal clears both the journal
    // summary AND the wallet secret — so the confirmation spells out that the
    // recovery phrase is permanently deleted. With no wallet attached it's the
    // harmless journal-only dismiss.
    const ok = await confirmDialog({
      title: hasSecret ? 'Dismiss and discard wallet?' : 'Dismiss launch journal?',
      body: hasSecret
        ? `<p>Remove the recovery entry for <strong>${escapeHtml(tokenLabel)}</strong>?</p>` +
          `<p>This permanently deletes the recovery phrase / secret key for the launch wallet ` +
          `(<span class="is-family-monospace">${escapeHtml(walletShort)}</span>) and clears the ` +
          `journal summary. Make sure you've moved any funds out of this wallet, or are certain ` +
          `none were ever sent there — this cannot be undone.</p>`
        : `<p>Dismiss the journal for <strong>${escapeHtml(tokenLabel)}</strong>?</p>` +
          `<p>This hides the recovery summary but does not move funds or delete any on-chain assets. ` +
          `Only dismiss it after you have recovered, swept, or intentionally abandoned the launch wallet.</p>`,
      confirmLabel: hasSecret ? 'Discard wallet & dismiss' : 'Dismiss journal',
      danger: true,
    });
    if (!ok) return;
    try {
      await fetch('/api/launch-journals/dismiss', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: journal.id }),
      });
      // Also discard the matching wallet secret when one is attached, so the
      // whole entry is cleaned up in a single action.
      if (hasSecret) {
        await fetch('/api/pending-wallets/dismiss', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ publicKey: journal.walletPublicKey }),
        });
      }
      await loadLaunchJournals();
      await loadPendingWallets();
    } catch (e) {
      log(`Failed to dismiss launch journal: ${e.message}`, 'danger');
    }
  });

  return wrap;
}

// ===========================================================================
// Pending-wallet recovery panel
// ---------------------------------------------------------------------------
// The server caches the secret key of any temporary wallet it generates and
// only removes it once the final transfer step has confirmed the wallet is
// on-chain empty. So if the app crashed or was closed mid-launch on a
// previous session, those entries show up here and the user can copy the
// secret key out for manual recovery.
//
// Important: the panel only ever shows entries that existed *at startup*.
// Wallets generated during the current session are not surfaced here —
// the user can already see them in Step 1, and showing them in a "recover
// previous session" panel during the active flow is misleading and
// alarming. After a refresh or restart, anything still in the cache then
// becomes visible — which is exactly when the panel actually matters.
//
// `pendingWalletStartupKeys` is the snapshot taken on first load. Once
// it's set, refreshes filter the server's response down to only entries
// whose publicKey was in the snapshot.
// ===========================================================================

let pendingWalletStartupKeys = null;

async function loadPendingWallets() {
  const panel = document.getElementById('pendingWalletsPanel');
  const list = document.getElementById('pendingWalletsList');
  if (!panel || !list) return;

  try {
    // Fetch the journals too: any wallet that has a matching launch journal
    // is now shown — with its recovery phrase — inside that journal's card
    // (see buildLaunchJournalRow). So this panel only needs to surface
    // "orphan" wallets with no journal, which avoids showing the same
    // wallet in two places. Using the current journal set (not the startup
    // snapshot) means a wallet re-appears here if its journal is later
    // dismissed without discarding the wallet.
    const [resp, journalResp] = await Promise.all([
      fetch('/api/pending-wallets').then((r) => r.json()),
      fetch('/api/launch-journals').then((r) => r.json()).catch(() => ({ journals: [] })),
    ]);
    let wallets = (resp && resp.wallets) || [];
    const journalWalletKeys = new Set(
      ((journalResp && journalResp.journals) || [])
        .map((j) => j.walletPublicKey)
        .filter(Boolean),
    );

    // First call: capture the set of pubkeys present at startup. Anything
    // generated during this session is added to the server-side cache but
    // won't be in this set, so it'll be filtered out below.
    if (pendingWalletStartupKeys === null) {
      pendingWalletStartupKeys = new Set(wallets.map((w) => w.publicKey));
    }

    // Filter: only show entries that were in the startup snapshot, are
    // still present in the cache, AND have no matching journal (those are
    // handled by the journal card).
    wallets = wallets.filter(
      (w) => pendingWalletStartupKeys.has(w.publicKey) && !journalWalletKeys.has(w.publicKey),
    );

    if (wallets.length === 0) {
      panel.classList.add('hidden');
      list.innerHTML = '';
      return;
    }

    list.innerHTML = '';
    for (const w of wallets) {
      list.appendChild(buildPendingWalletRow(w));
    }
    panel.classList.remove('hidden');
  } catch (e) {
    console.warn('Failed to load pending wallets:', e);
    // Don't show the panel if we couldn't fetch — better silent than
    // misleading.
    panel.classList.add('hidden');
  }
}

// Construct one row in the recovery panel. Truncated public key, age,
// "Copy secret key" button, "Discard" button.
function buildPendingWalletRow(wallet) {
  const wrap = document.createElement('div');
  wrap.className = 'box p-3 mb-2 is-size-7';

  const pubShort = `${wallet.publicKey.slice(0, 6)}…${wallet.publicKey.slice(-6)}`;
  const ageStr = formatAge(wallet.createdAt);

  // Decryption-failed branch: the file is on disk but we can't read the
  // secret material. Most common cause is the OS keychain has rotated
  // (e.g. file was copied from another machine, user account changed).
  // We can't help recover it from the app — surface the situation, let
  // the user discard.
  if (wallet.decryptionFailed) {
    wrap.innerHTML = `
      <div class="mb-2">
        <strong>Public key:</strong>
        <span class="is-family-monospace">${pubShort}</span>
        &nbsp;<span class="has-text-grey">(${ageStr})</span>
      </div>
      <div class="notification is-danger is-light is-size-7 py-2 px-3 mb-2">
        <strong>Cannot decrypt this entry.</strong> The OS keychain key has
        likely changed since this wallet was generated (file was copied to a
        different user account or machine, or the keychain was reset). The
        secret material in this entry is unrecoverable from inside the app.
        If you have a backup of the recovery phrase elsewhere, use that.
      </div>
      <div class="field is-grouped">
        <div class="control">
          <button class="button is-small" data-action="copy-pubkey">
            <span class="icon is-small"><i class="fas fa-copy"></i></span>
            <span>Copy public key</span>
          </button>
        </div>
        <div class="control">
          <button class="button is-small is-danger is-light" data-action="dismiss">
            <span class="icon is-small"><i class="fas fa-trash"></i></span>
            <span>Discard</span>
          </button>
        </div>
      </div>
    `;
    wireRowButtons(wrap, wallet, pubShort, /*hasMnemonic=*/false);
    return wrap;
  }

  // Prefer the recovery phrase if this wallet was generated with one.
  // Older cached entries from before mnemonic support fall back to the
  // base58 secret key.
  const hasMnemonic = !!wallet.mnemonic;
  const copyLabel = hasMnemonic ? 'Copy recovery phrase' : 'Copy secret key';
  const copyIcon = hasMnemonic ? 'fa-list-ol' : 'fa-key';

  wrap.innerHTML = `
    <div class="mb-2">
      <strong>Public key:</strong>
      <span class="is-family-monospace">${pubShort}</span>
      &nbsp;<span class="has-text-grey">(${ageStr})</span>
    </div>
    <div class="field is-grouped">
      <div class="control">
        <button class="button is-small is-info" data-action="copy-secret">
          <span class="icon is-small"><i class="fas ${copyIcon}"></i></span>
          <span>${copyLabel}</span>
        </button>
      </div>
      <div class="control">
        <button class="button is-small" data-action="copy-pubkey">
          <span class="icon is-small"><i class="fas fa-copy"></i></span>
          <span>Copy public key</span>
        </button>
      </div>
      <div class="control">
        <button class="button is-small is-danger is-light" data-action="dismiss">
          <span class="icon is-small"><i class="fas fa-trash"></i></span>
          <span>Discard</span>
        </button>
      </div>
    </div>
  `;
  wireRowButtons(wrap, wallet, pubShort, hasMnemonic);
  return wrap;
}

// Wire the per-row buttons. Extracted so both the normal and the
// decryption-failed render paths share the same handler logic.
function wireRowButtons(wrap, wallet, pubShort, hasMnemonic) {
  // Centralised clipboard helper so we don't duplicate the try/catch
  // every time. navigator.clipboard.writeText can throw in non-secure
  // contexts (older Electron, http://), if the page doesn't have focus,
  // or if the user has denied clipboard permission. Without this guard
  // the rejection floats up as an unhandled promise rejection and the
  // user has no idea the copy didn't happen.
  const copyToClipboard = async (text, description) => {
    try {
      await navigator.clipboard.writeText(text);
      log(`${description} copied to clipboard`, 'info');
    } catch (e) {
      log(
        `Couldn't copy ${description} (${e.message}). ` +
        `Open the file at the pendingWallets path and copy the secret manually.`,
        'warning',
      );
    }
  };

  // copy-secret button only exists in the normal render path
  const copySecretBtn = wrap.querySelector('[data-action="copy-secret"]');
  if (copySecretBtn) {
    copySecretBtn.addEventListener('click', async () => {
      const text = hasMnemonic ? wallet.mnemonic : wallet.secretKeyB58;
      if (!text) {
        log(`No secret available for ${pubShort}`, 'warning');
        return;
      }
      const what = hasMnemonic ? 'Recovery phrase' : 'Secret key';
      await copyToClipboard(text, `${what} for ${pubShort}`);
    });
  }

  wrap.querySelector('[data-action="copy-pubkey"]').addEventListener('click', async () => {
    await copyToClipboard(wallet.publicKey, `Public key ${pubShort}`);
  });

  wrap.querySelector('[data-action="dismiss"]').addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: 'Discard recovery entry?',
      body:
        `<p>Discard recovery entry for <strong>${escapeHtml(pubShort)}</strong>?</p>` +
        `<p>Only do this if you've already moved any funds out of this wallet, ` +
        `or you're sure none were ever sent there. This action cannot be undone.</p>`,
      confirmLabel: 'Discard',
      danger: true,
    });
    if (!ok) return;
    try {
      await fetch('/api/pending-wallets/dismiss', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ publicKey: wallet.publicKey }),
      });
      await loadPendingWallets();
    } catch (e) {
      log(`Failed to dismiss recovery entry: ${e.message}`, 'danger');
    }
  });
}

// "3 hours ago" / "5 days ago" / etc. Plain-English age display.
function formatAge(isoString) {
  const then = new Date(isoString).getTime();
  if (!Number.isFinite(then)) return 'unknown age';

  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (seconds < 60)        return 'just now';
  if (seconds < 3600)      return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400)     return `${Math.floor(seconds / 3600)} hr ago`;
  if (seconds < 86400 * 7) return `${Math.floor(seconds / 86400)} days ago`;
  return new Date(isoString).toLocaleDateString();
}

// ===========================================================================
// Initial state
// ===========================================================================
log('Trebuchet is ready. Click "Generate Wallet" to begin.');
loadRpcConfig();
startRpcHealthPolling();
loadLaunchJournals();
loadPendingWallets();
loadFeeTiers();
bindStepHeaders();
updateCancelButtonState();
// Render the simple-config UI right away so it's visible from page load
// (even before the user generates a wallet). The pool list inside the
// customize-mode container starts empty and stays empty until pools[]
// gets populated — by wallet generation, by recovery, or by manual add.
applySimpleConfigMode();
// Initial paint of the token-preview card. With the default values
// pre-filled in the supply and market-cap inputs, the user sees the
// placeholder name + a populated tech line right away.
renderTokenPreview();

// ---------------------------------------------------------------------------
// Tab-close / reload guard
// ---------------------------------------------------------------------------
//
// Once the user has progressed past wallet generation, accidentally
// closing or reloading the window loses session context (tempWallet, the
// in-progress pools array, the funding-requirement estimate, etc).
// The wallet's secret key is still in the pending-wallets recovery
// cache server-side, so funds are never lost, but the user has to
// re-enter their config and re-derive the wallet — friction we can
// prevent with a confirmation prompt before the unload.
//
// We only fire the warning when there's genuine state worth preserving:
//   - currentStep > 1   → wallet has been generated
//   - currentStep < 6   → we're not on the terminal transfer step
//
// Behavior differs by host:
//   - In a regular browser: Chrome/Firefox show their own generic "Leave
//     site? Changes you made may not be saved" dialog. They ignore our
//     message text; we just need to call preventDefault + set returnValue.
//   - In Electron: the renderer's beforeunload preventDefault is reported
//     to the main process via the 'will-prevent-unload' event, which
//     main.js handles by showing a native dialog. The renderer doesn't
//     need to do anything different here — same preventDefault pattern.
//     See main.js for the dialog setup.
window.addEventListener('beforeunload', (e) => {
  // The demo-mode toggle reloads to reset state, but it has already shown
  // its own HTML confirmation. Let that reload through without also firing
  // the native "launch in progress" dialog.
  if (demoModeReloading) return;
  if (currentStep <= 1 || currentStep >= 6) return;
  e.preventDefault();
  // Some browsers (older Chrome, Edge) still read the return value;
  // newer ones ignore it. Set it for compatibility. Electron ignores
  // it too — the native dialog in main.js uses its own copy.
  e.returnValue = 'A launch is in progress. Leaving now will reset the UI; ' +
    'you\'ll need to recover the wallet from the pending-wallets panel.';
  return e.returnValue;
});

// ---------------------------------------------------------------------------
// Startup gate for the silent update-check
// ---------------------------------------------------------------------------
//
// The Electron main process runs the actual GitHub API call for the
// auto-update check, but we want the "Update available" modal to land
// ON TOP OF the main UI — not behind the splash video or the
// first-run disclaimer. Both of those mask the renderer at startup.
//
// To coordinate, we keep a tiny gate state here. The splash and
// disclaimer setups flip their gate to false when they're going to
// display something blocking, and back to true when the user has
// dismissed it. When both gates are true, we POST to a server
// endpoint that signals main to run the check.
//
// Default-true semantics handle the "didn't need to show anything"
// cases automatically:
//   - splash element missing → splash gate stays true
//   - disclaimer already agreed in a previous session → disclaimer
//     gate stays true
// In either case the gate never flips false, and the final
// _evaluateStartupGates() call at the bottom of this file picks up
// "both still true" and fires the trigger.

const _startupGates = {
  splash: true,
  disclaimer: true,
};
let _startupTriggerFired = false;

function _gateStartup(name) {
  _startupGates[name] = false;
}

function _releaseStartupGate(name) {
  _startupGates[name] = true;
  _evaluateStartupGates();
}

function _evaluateStartupGates() {
  if (_startupTriggerFired) return;
  if (!_startupGates.splash || !_startupGates.disclaimer) return;
  _startupTriggerFired = true;
  // Fire-and-forget. The server endpoint is local so this should
  // never fail in practice; if it somehow does, the user can still
  // run a manual check via Help → Check for Updates, so we don't
  // surface anything.
  fetch('/api/trigger-startup-update-check', { method: 'POST' })
    .catch((err) => {
      console.warn('Startup update-check trigger failed:', err);
    });
}

// ---------------------------------------------------------------------------
// First-run disclaimer
// ---------------------------------------------------------------------------
//
// Show a one-time risk-acknowledgement modal before anything else
// happens on the page. Acceptance is remembered in localStorage so
// returning users skip the dialog. The disclaimer is layered on top
// of the splash (higher z-index in CSS) so on first run the user
// reads and acknowledges before the intro video plays.
//
// Splash gating — implemented in setupSplashScreen() — already waits
// while any .modal.is-active is on the page, so adding the disclaimer
// modal naturally pauses splash playback. When the user clicks Agree,
// the modal class is removed and the splash detects no active modal
// and starts playing.
//
// On Cancel: attempt window.close(). In Electron this terminates the
// app since there's only one window. In plain web mode (npm run web
// served via a browser) window.close() may be blocked by the browser
// for windows not opened by JS — so we replace the modal contents
// with a "please close this tab" fallback message.
//
// Storage is keyed with a namespace prefix so it doesn't collide
// with anything else; we store an ISO timestamp rather than just
// "true" so future debugging can see when the agreement was given.
const DISCLAIMER_STORAGE_KEY = 'trebuchet:disclaimer-agreed';

function setupDisclaimer() {
  const modal = document.getElementById('disclaimerModal');
  if (!modal) return;

  // Check whether the user has already agreed in a previous session.
  // localStorage access can throw in some sandboxed contexts (private
  // browsing, disabled storage); on error, treat as "not agreed" and
  // show the dialog — better safe than skipping the warning.
  let alreadyAgreed = false;
  try {
    alreadyAgreed = !!localStorage.getItem(DISCLAIMER_STORAGE_KEY);
  } catch {
    alreadyAgreed = false;
  }

  if (alreadyAgreed) {
    return; // modal stays inert; splash and main app proceed normally
  }

  // First-run path: gate the silent update-check until the user has
  // acknowledged the disclaimer. Without this, the auto-check modal
  // would land behind this dialog. The agree handler below releases
  // the gate.
  _gateStartup('disclaimer');

  // First run (or storage cleared): show the modal.
  modal.classList.add('is-active');

  const checkbox = document.getElementById('disclaimerAgreeCheck');
  const agreeBtn = document.getElementById('disclaimerAgreeBtn');
  const cancelBtn = document.getElementById('disclaimerCancelBtn');

  // Checkbox gates the agree button. The user has to make the
  // explicit gesture before they can proceed — keeps the
  // acknowledgement intentional rather than muscle-memory clicking.
  if (checkbox && agreeBtn) {
    checkbox.addEventListener('change', () => {
      agreeBtn.disabled = !checkbox.checked;
    });
  }

  if (agreeBtn) {
    agreeBtn.addEventListener('click', () => {
      if (checkbox && !checkbox.checked) return; // safety: button shouldn't be enabled, but guard anyway
      try {
        localStorage.setItem(DISCLAIMER_STORAGE_KEY, new Date().toISOString());
      } catch {
        // Storage failed — proceed anyway. The user will just see the
        // disclaimer again on next launch. Annoying but not broken.
      }
      modal.classList.remove('is-active');
      // Disclaimer is dismissed — release the startup gate. If the
      // splash gate is also clear (returning user or splash already
      // dismissed), this fires the silent update check.
      _releaseStartupGate('disclaimer');
    });
  }

  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => {
      // Try to close the window. In Electron this terminates the app.
      // In plain web mode, browsers may block this — fall back to a
      // "please close" message that overwrites the modal body.
      window.close();
      // If we're still here ~50ms later, the close was blocked.
      setTimeout(() => {
        const body = modal.querySelector('.modal-card-body');
        const foot = modal.querySelector('.modal-card-foot');
        if (body) {
          body.innerHTML =
            '<div class="disclaimer-declined">' +
            '<p class="title is-5">You declined.</p>' +
            '<p>Please close this tab to exit Trebuchet.</p>' +
            '</div>';
        }
        if (foot) foot.style.display = 'none';
      }, 50);
    });
  }
}
setupDisclaimer();

// ---------------------------------------------------------------------------
// Universal modal close affordances
// ---------------------------------------------------------------------------
//
// Three modals in the app were originally wired only to their explicit
// footer buttons (Cancel / Keep Going / Got It / etc.) and lacked the
// click-outside-and-Esc-to-dismiss behaviour users expect from modal
// dialogs.  This block backfills both for them:
//
//   - cancelConfirmModal     (Cancel & Refund prompt from the sticky bar)
//   - transferConfirmModal   (final confirm before sweeping assets)
//   - flywheelInfoModal      (informational; already had background click,
//                             but no Esc handler)
//
// Click-outside is wired per-modal via each one's .modal-background
// element.  Esc is handled with a single delegated keydown listener on
// document — when Esc fires, we close whichever of the three modals is
// currently active.  A single listener avoids the listener-accumulation
// failure mode that bit us elsewhere, and avoids the subtle bug where
// every per-modal Esc listener would also fire even when its own modal
// isn't the topmost one.
//
// Note on stacking with confirmDialog(): confirmDialog adds its own
// ephemeral Esc handler when shown and removes it on dismiss.  In a
// stacked scenario (confirmDialog opened on top of one of these
// modals), pressing Esc would fire BOTH handlers, closing both modals.
// In practice the flows in this app never open confirmDialog while
// one of these three modals is showing (cancel/transfer modals close
// themselves before any subsequent confirm prompt; flywheel is purely
// informational and isn't a launching pad for other dialogs), so this
// is a theoretical issue, not a practical one.  Documenting it here so
// if a future flow tries to stack them, the developer knows the gotcha.
const EXTRA_CLOSE_MODAL_IDS = [
  'cancelConfirmModal',
  'transferConfirmModal',
  'flywheelInfoModal',
];
for (const modalId of EXTRA_CLOSE_MODAL_IDS) {
  const modal = document.getElementById(modalId);
  if (!modal) continue;
  const bg = modal.querySelector('.modal-background');
  if (bg) {
    bg.addEventListener('click', () => modal.classList.remove('is-active'));
  }
}
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  for (const modalId of EXTRA_CLOSE_MODAL_IDS) {
    const modal = document.getElementById(modalId);
    if (modal && modal.classList.contains('is-active')) {
      modal.classList.remove('is-active');
    }
  }
});

// ---------------------------------------------------------------------------
// Splash screen dismissal
// ---------------------------------------------------------------------------
//
// The splash markup is in index.html; this wires up:
//   - Gated playback: video only starts playing once the window has
//     focus AND no blocking modal is on the page. Without focus,
//     browsers reliably block unmuted autoplay, and starting playback
//     while a modal is up would mean audio plays under invisible UI.
//   - Dismiss on `ended` (video ran to completion), explicit user
//     skip (click backdrop, Skip button, Esc/Space/Enter), or a
//     `<video>` error (file missing, format unsupported).
//
// There's deliberately NO stall/timeout-based dismiss. If focus never
// arrives, the splash stays — but that's the right call because if the
// user isn't focused on this window, they aren't interacting with the
// app either. The moment they tab back, the video starts.
//
// Console is sprinkled with [splash] log lines so you can open dev
// tools and see what's happening if playback doesn't start.
//
// Idempotent: dismiss runs at most once. Triggers a CSS fade-out via
// the is-dismissing class, then removes the splash node entirely.
function setupSplashScreen() {
  const splash = document.getElementById('splashScreen');
  if (!splash) return; // nothing to do (e.g. someone removed the markup)

  // Gate the silent update-check until the splash is dismissed. The
  // dismiss() function below releases the gate.
  _gateStartup('splash');

  const video = document.getElementById('splashVideo');
  const skipBtn = document.getElementById('splashSkipBtn');

  document.body.classList.add('has-splash');

  let dismissed = false;
  let started = false;
  // Whether the intro-video preference allows playback. null = not yet
  // known (still reading the pref); true = allowed. We never set it false —
  // "disabled" takes the dismiss path below instead. tryStartPlayback() holds
  // off until this is true, so a disabled intro never flashes a frame.
  let playAllowed = null;

  function dismiss(reason, instant) {
    if (dismissed) return;
    dismissed = true;
    console.log('[splash] dismiss:', reason || 'unknown');
    document.body.classList.remove('has-splash');
    // Pause the video so audio stops immediately on dismiss.
    if (video) {
      try { video.pause(); } catch {}
    }
    if (instant) {
      // No fade — used when the intro is disabled in settings, so the
      // splash is removed before it ever really registers as visible.
      if (splash.parentNode) splash.parentNode.removeChild(splash);
    } else {
      splash.classList.add('is-dismissing');
      // Remove the node after the fade finishes so it isn't lingering in
      // the DOM as invisible chrome. The 500ms cushion is slightly longer
      // than the 0.4s CSS transition.
      setTimeout(() => {
        if (splash.parentNode) splash.parentNode.removeChild(splash);
      }, 500);
    }
    // Splash is dismissed — release the startup gate. If the
    // disclaimer gate is also clear, this fires the silent update
    // check.
    _releaseStartupGate('splash');
  }

  // Honour the "play intro video" preference. We optimise for the default
  // (on): the splash markup is already on screen, so we only need to bail
  // out when it's off. The read is a localhost round-trip; until it returns,
  // tryStartPlayback() holds (playAllowed === null) so the video can't start
  // under a splash we're about to remove. If it comes back disabled we
  // dismiss instantly (no fade); on any read error we fall through to
  // playing — failing toward the original behaviour.
  fetch('/api/user-prefs')
    .then((r) => r.json())
    .then((data) => {
      if (data && data.prefs && data.prefs.playIntroVideo === false) {
        dismiss('intro video disabled in settings', true);
      } else {
        playAllowed = true;
        tryStartPlayback();
      }
    })
    .catch(() => {
      playAllowed = true;
      tryStartPlayback();
    });

  // Conditions for starting playback. Both must be true:
  //   - document.hasFocus() — without focus, browsers reliably block
  //     unmuted autoplay. Even when not blocked, playing audio under
  //     a backgrounded tab is bad UX.
  //   - No .modal.is-active — a confirmation dialog or transfer modal
  //     is up. Audio playing under a dialog would be confusing.
  // Once both are true, call video.play() exactly once. If play()
  // rejects (browser still blocks autoplay despite focus, or some
  // other error), surface a click-to-play affordance: the splash
  // backdrop already accepts clicks to dismiss, but we attach a
  // one-shot click handler that retries play() instead.
  function tryStartPlayback() {
    if (started || dismissed || !video) return;
    if (playAllowed !== true) {
      // Still confirming the intro-video preference (or it's disabled and
      // a dismiss is already in flight) — don't start playback yet.
      console.log('[splash] waiting for intro-video preference');
      return;
    }
    if (!document.hasFocus()) {
      console.log('[splash] waiting for focus');
      return;
    }
    if (document.querySelector('.modal.is-active')) {
      console.log('[splash] waiting for modal to close');
      return;
    }
    started = true;
    console.log('[splash] calling play()');
    const playPromise = video.play();
    if (playPromise && typeof playPromise.then === 'function') {
      playPromise.then(() => {
        console.log('[splash] play() promise resolved');
      }).catch((err) => {
        // play() was blocked despite our gating. Common causes:
        // browser policy that requires user gesture even with focus,
        // or audio device unavailable. We let the user click the
        // splash to retry.
        console.warn('[splash] play() rejected:', err && err.message);
        started = false; // allow a click-driven retry
      });
    }
  }

  // Re-check the start condition whenever something might have
  // changed: window focus, page visibility, or after a short poll
  // interval (covers modal opens/closes that don't fire focus events).
  // Polling 4× per second is cheap and avoids hooking every modal
  // toggle code path.
  window.addEventListener('focus', tryStartPlayback);
  document.addEventListener('visibilitychange', tryStartPlayback);
  const pollHandle = setInterval(() => {
    if (dismissed) {
      clearInterval(pollHandle);
      return;
    }
    tryStartPlayback();
  }, 250);
  // Try once immediately too — if the page has focus and there are
  // no modals at load, we start right away without waiting for the
  // first poll tick.
  tryStartPlayback();

  // Lifecycle listeners — also useful for debugging.
  if (video) {
    // Track lifecycle for visibility into playback state.
    video.addEventListener('loadedmetadata', () => {
      console.log(`[splash] video metadata loaded: ${video.videoWidth}x${video.videoHeight}, ${video.duration.toFixed(1)}s`);
    });
    video.addEventListener('playing', () => {
      console.log('[splash] playback actually started');
    });
    // Auto-dismiss on natural end of playback.
    video.addEventListener('ended', () => dismiss('video ended'));
    // If the file is missing/corrupt or the format is unsupported,
    // dismiss immediately rather than leaving the user staring at a
    // broken splash. (Doesn't fire for autoplay-blocked — that's a
    // policy block, not a load error.)
    video.addEventListener('error', (e) => {
      console.warn('[splash] video error:', e && (e.message || e.type));
      dismiss('video error');
    });
  }

  // User-initiated skips. The click-on-backdrop handler does double
  // duty: if playback hasn't started yet (because play() was blocked),
  // retry play(); if it has started, dismiss. The retry path comes
  // first so a user click counts as the gesture browsers want.
  splash.addEventListener('click', () => {
    if (!started && !dismissed) {
      tryStartPlayback();
      return;
    }
    dismiss('backdrop click');
  });
  if (skipBtn) {
    skipBtn.addEventListener('click', (e) => {
      // Skip always dismisses, never retries — the user explicitly
      // chose to skip.
      e.stopPropagation();
      dismiss('skip button');
    });
  }

  // Keyboard escape hatches. Esc/Space/Enter dismiss outright. Skip
  // when there's an active modal on top of the splash (e.g. the
  // first-run disclaimer) — those keys belong to the modal in that
  // case, and dismissing the splash silently would mean the user
  // never sees the video once the modal is gone.
  function onKeydown(e) {
    if (dismissed) return;
    if (document.querySelector('.modal.is-active')) return;
    if (e.key === 'Escape' || e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      dismiss(`keydown: ${e.key}`);
    }
  }
  document.addEventListener('keydown', onKeydown);
}
setupSplashScreen();

// ===========================================================================
// User preferences (renderer side)
// ---------------------------------------------------------------------------
// The medieval gauntlet cursor theme and the 3D coin token preview are
// always-on features — not user-toggleable. We apply the cursor theme
// unconditionally here; the coin preview is gated by coinPreviewEnabled,
// which defaults to true. (No settings UI and no persisted pref for either.)
// ===========================================================================
(function setupAppearance() {
  // Cursor theme: always on.
  document.body.classList.add('medieval-cursor');

  // Global mousedown clench: a click ANYWHERE adds .cursor-clenched so the
  // gauntlet shows the fist even over non-interactive space, then relaxes on
  // release. Listeners are passive — we never preventDefault.
  document.addEventListener('mousedown', () => {
    document.body.classList.add('cursor-clenched');
  }, { passive: true });
  document.addEventListener('mouseup', () => {
    document.body.classList.remove('cursor-clenched');
  }, { passive: true });
  // If the pointer leaves the window mid-press, clear the clench so it
  // doesn't get stuck clenched when the mouse comes back.
  window.addEventListener('blur', () => {
    document.body.classList.remove('cursor-clenched');
  });
})();

// ===========================================================================
// Intro-video preference (renderer side)
// ---------------------------------------------------------------------------
// The startup splash plays by default; the "Play the intro video on startup"
// checkbox in the settings panel lets the user turn it off. We reflect the
// persisted value into the checkbox on load and write changes back via
// /api/user-prefs. The change takes effect on the NEXT launch — the splash
// for the current session has already been decided by setupSplashScreen().
// ===========================================================================
(function setupIntroVideoPref() {
  const toggle = document.getElementById('introVideoToggle');
  if (!toggle) return;

  // Reflect the stored value. Default is on, so we only uncheck when the
  // pref is explicitly false; any read error leaves the checkbox at its
  // default-checked markup state, matching the default-on behaviour.
  fetch('/api/user-prefs')
    .then((r) => r.json())
    .then((data) => {
      if (data && data.prefs) toggle.checked = data.prefs.playIntroVideo !== false;
    })
    .catch((err) => {
      console.warn('Failed to read intro-video preference:', err);
    });

  // Persist on change, fire-and-forget — same pattern as the update-check
  // preference. If the write fails the toggle still moved visually; the
  // user can toggle again. We don't touch the current session's splash.
  toggle.addEventListener('change', () => {
    fetch('/api/user-prefs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playIntroVideo: toggle.checked }),
    }).catch((err) => {
      console.warn('Failed to persist intro-video preference:', err);
    });
  });
})();

// ===========================================================================
// Launch-report preference + "What's this?" explainer (renderer side)
// ---------------------------------------------------------------------------
// The "Publish a permanent launch report to Arweave" checkbox mirrors the
// other settings toggles: reflect the persisted value on load, persist changes
// via /api/user-prefs. The "What's this?" link opens a plain-language modal.
// The actual publishing happens server-side at step 5; this only manages the
// on/off preference and the explainer UI.
// ===========================================================================
(function setupLaunchReportPref() {
  const settingsToggle = document.getElementById('publishReportToggle');
  const stepToggle = document.getElementById('lpPublishReportToggle');
  const configToggle = document.getElementById('configPublishReportToggle');
  const toggles = [settingsToggle, stepToggle, configToggle].filter(Boolean);

  // Reflect the persisted value into every launch-report toggle on load.
  fetch('/api/user-prefs')
    .then((r) => r.json())
    .then((data) => {
      if (data && data.prefs) {
        const on = data.prefs.publishLaunchReport !== false;
        toggles.forEach((t) => { t.checked = on; });
      }
    })
    .catch((err) => {
      console.warn('Failed to read launch-report preference:', err);
    })
    .finally(() => {
      // Paint the step-5 idle hint once the toggle state is known.
      if (typeof refreshLaunchReportUi === 'function') {
        try { refreshLaunchReportUi(); } catch (_) { /* DOM may not be ready */ }
      }
    });

  // A change on any toggle persists the pref, syncs the other toggle, refreshes
  // the status surfaces, and — if turned ON after the pools are already created
  // — publishes now (the idempotency guard prevents duplicates).
  const onToggleChange = (source) => {
    const on = source.checked;
    toggles.forEach((t) => { if (t !== source) t.checked = on; });
    fetch('/api/user-prefs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ publishLaunchReport: on }),
    }).catch((err) => {
      console.warn('Failed to persist launch-report preference:', err);
    });
    if (typeof refreshLaunchReportUi === 'function') {
      try { refreshLaunchReportUi(); } catch (_) { /* no-op */ }
    }
    // The launch-report line is part of the cost estimate, so re-run the cost
    // preview whenever the toggle changes.
    if (typeof requestCostPreviewUpdate === 'function') {
      try { requestCostPreviewUpdate(); } catch (_) { /* no-op */ }
    }
    if (on && typeof publishLaunchReportToArweave === 'function'
        && typeof lpResult !== 'undefined' && lpResult
        && typeof createdTokenInfo !== 'undefined' && createdTokenInfo && createdTokenInfo.mint
        // Only publish immediately when the step-6 publish point already
        // passed while the toggle was OFF (it recorded 'skipped'). Before
        // that, flipping the pref is enough — runTransfer publishes after
        // the airdrop and before the sweep, so the permanent record gets
        // the real delivery results.
        && typeof _publishedReport !== 'undefined' && _publishedReport
        && _publishedReport.status === 'skipped') {
      publishLaunchReportToArweave();
    }
  };
  toggles.forEach((t) => t.addEventListener('change', () => onToggleChange(t)));

  // "What's this?" explainer modal. Its markup lives LATER in index.html than
  // <script src="app.js">, so it is NOT in the DOM when this runs (while the
  // openers are). Binding directly here would silently no-op. Use document-level
  // event delegation and resolve the modal at click time, so open/close work
  // regardless of parse order — the same hazard the success modal documents.
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (!t || !t.closest) return;
    // Open: any launch-report "What's this?" link (Settings, step 5, or config).
    if (t.closest('#launchReportWhatsThis, #lpReportWhatsThis, #configReportWhatsThis')) {
      e.preventDefault();
      const m = document.getElementById('launchReportInfoModal');
      if (m) m.classList.add('is-active');
      return;
    }
    // Close: the X, the "Got it" button, or a click on the modal backdrop.
    if (t.closest('#launchReportInfoClose, #launchReportInfoDone')
        || (t.matches && t.matches('#launchReportInfoModal .modal-background'))) {
      const m = document.getElementById('launchReportInfoModal');
      if (m) m.classList.remove('is-active');
    }
  });
})();
// ===========================================================================
// Demo destination wallet
// ---------------------------------------------------------------------------
// In demo mode the Step 6 "Destination Wallet" input asks for a real Solana
// address — that's friction the user shouldn't have to deal with for a
// walk-through. Auto-fill a synthetic Demo-prefixed address so the user can
// just click Transfer Assets and watch the simulated sweep complete.
//
// Generated once per session (module-scope cache) so the same address shows
// up if the field is cleared and re-applied during the same session — e.g.
// after the user clicks Cancel and refund mid-launch and the reset path
// clears the input. The user sees a stable address rather than a new random
// one each time.
//
// Uses the same Demo-prefix convention demoChainService.js uses for its
// synthetic on-chain addresses — visually consistent with the rest of the
// demo data in screenshots and the launch report.
// ===========================================================================

const _DEMO_BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
let _demoDestinationWalletCached = null;

function getDemoDestinationWallet() {
  if (_demoDestinationWalletCached) return _demoDestinationWalletCached;
  // 'DemoDest' (8 chars, all valid base58) + 24 random = 32 chars total.
  // The 'DemoDest' prefix is recognizable in screenshots as the demo sweep
  // target without the user having to know what's behind it.
  let suffix = '';
  for (let i = 0; i < 24; i++) {
    suffix += _DEMO_BASE58[Math.floor(Math.random() * _DEMO_BASE58.length)];
  }
  _demoDestinationWalletCached = 'DemoDest' + suffix;
  return _demoDestinationWalletCached;
}

// Apply the demo destination address to the Step 6 input field, plus
// swap the placeholder so it doesn't read "Your real Solana wallet
// address" while sitting next to an auto-filled synthetic one.
//
// No-op in real mode — safe to call unconditionally from anywhere that
// might clear or re-render the destination input.
function applyDemoDestinationWallet() {
  if (!demoModeActive) return;
  const input = document.getElementById('destinationWallet');
  if (!input) return;
  input.value = getDemoDestinationWallet();
  input.placeholder = 'Demo destination wallet (auto-filled)';
}

// ===========================================================================
// Demo mode (renderer side)
// ---------------------------------------------------------------------------
// On load we ask the server whether demo mode is on (/api/demo/status) and
// reflect that in the UI. Toggling the setting (or clicking the banner's
// Disable button) persists the new value via /api/user-prefs, then VERIFIES
// the change by reading /api/demo/status back before touching any demo UI.
//
// Why verify instead of trusting the POST: userPrefs.persist() swallows
// disk-write errors — set() reports success even if the write never reached
// disk (e.g. a packaged build without write access to its config folder).
// isDemoMode() on the server reads the pref fresh per request, so if the
// write silently failed the server would still be in REAL mode. Showing the
// demo banner in that case would be dangerous — it would promise "no real
// transactions" over a live server. Reading the status back closes that gap:
// we only show demo UI once the server CONFIRMS it is in demo mode.
//
// Toggling always asks for confirmation first: switching mode discards any
// current launch progress and starts over. On confirm we persist, verify
// the server entered the new mode, then reload — the most reliable way to
// reset every in-memory launch variable and restart the flow from the
// beginning in the new mode.
// ===========================================================================
// ===========================================================================
// Demo chrome: fold the demo indicator into the sticky bar when both are up.
// ---------------------------------------------------------------------------
// The demo banner and the sticky progress bar are both position:sticky at
// top:0, so during a demo launch they fight for the same spot and the higher-
// z banner hides the step/cost/cancel controls. Instead of stacking two bars,
// fold the demo badge + Disable button INTO the sticky bar whenever the bar is
// visible, and fall back to the standalone top banner only when there is no
// sticky bar to fold into (e.g. before the flow starts). Top-level (not inside
// the IIFE) so step-orchestrator.js can call it the moment the bar appears.
// ===========================================================================
function syncDemoChrome() {
  const sticky = document.getElementById('stickyBar');
  const banner = document.getElementById('demoBanner');
  const badge = document.getElementById('stickyDemoBadge');
  const disableBtn = document.getElementById('stickyDemoDisable');
  const stickyVisible = !!(sticky && sticky.classList.contains('is-visible'));
  // Fold into the sticky bar only when demo is on AND a sticky bar is showing.
  const folded = demoModeActive && stickyVisible;

  // Standalone banner only when demo is on but there's no sticky bar yet.
  if (banner) banner.style.display = (demoModeActive && !stickyVisible) ? 'flex' : 'none';
  // Sticky bar adopts the amber demo treatment and reveals its in-bar controls.
  if (sticky) sticky.classList.toggle('demo-active', folded);
  if (badge) badge.style.display = folded ? 'inline-flex' : 'none';
  if (disableBtn) disableBtn.style.display = folded ? 'inline-flex' : 'none';

  // Modal offset (--demo-banner-height) only needs to clear the STANDALONE
  // banner (z-index 100). When folded, the demo lives in the sticky bar
  // (z-index 30, below the modal layer), so the offset collapses to 0.
  const px = (banner && banner.style.display !== 'none') ? banner.offsetHeight : 0;
  document.documentElement.style.setProperty('--demo-banner-height', px + 'px');
}

(function setupDemoMode() {
  // Single source of truth for demo-dependent UI: the top banner, the Step 3
  // "Pretend funding arrived" button, and the settings checkbox.
  function applyDemoModeUi(active) {
    demoModeActive = !!active;
    const toggle = document.getElementById('demoModeToggle');
    if (toggle) toggle.checked = demoModeActive;
    const fundWrap = document.getElementById('demoFundWrap');
    if (fundWrap) fundWrap.style.display = demoModeActive ? 'block' : 'none';
    // Publish the banner's height so modals can stay clear of it. The
    // banner we just toggled above is measured here; see the CSS rules
    // on .modal / .modal-card (keyed off --demo-banner-height) for why.
    syncDemoBannerHeight();
    // Pre-fill the Step 6 destination wallet input so the user doesn't
    // need a real address to finish the demo walkthrough. No-op in
    // real mode (the helper itself gates on demoModeActive).
    applyDemoDestinationWallet();
  }

  // Republish --demo-banner-height with the banner's live pixel height so
  // the modal layer can subtract it from its max-height and shift its
  // centred card down past the banner (otherwise a tall dialog like the
  // launch-complete one runs off the bottom of the screen in demo mode).
  // Reading offsetHeight forces a synchronous layout pass, so the value
  // reflects the banner exactly as it now renders — including the taller
  // two-line state it wraps into on narrow windows. When demo mode is off
  // we publish 0px, which collapses the modal rules back to Bulma defaults.
  // Superseded by the top-level syncDemoChrome(), which also decides whether
  // the demo shows as the standalone banner or folded into the sticky bar.
  // Kept as a thin delegator so the resize listener and callers stay valid.
  function syncDemoBannerHeight() { syncDemoChrome(); }

  // The banner can wrap to a second line as the window narrows, which
  // changes its height — re-measure on resize so the modal offset tracks
  // it. Harmless while demo mode is off (resolves to 0px).
  window.addEventListener('resize', syncDemoBannerHeight);

  // Persist a new demoMode value and switch the app into it. Switching mode
  // discards the current launch and starts over, so we always confirm first.
  async function setDemoMode(enabled) {
    const want = !!enabled;

    // If a REAL launch is mid-flight (steps 2..5, and we're currently in real
    // mode), the ephemeral wallet has been stashed for recovery — surface that
    // here, since this single HTML dialog now replaces the old native one.
    const launchInProgress =
      typeof currentStep === 'number' && currentStep > 1 && currentStep < 6;
    const recoveryNote =
      launchInProgress && !demoModeActive
        ? '<p>If you already created an on-chain wallet for this launch, you ' +
          'can still recover it from the pending-wallets panel.</p>'
        : '';

    // Always warn: changing mode resets the app to defaults and restarts the
    // launch from the beginning, discarding anything entered so far.
    const proceed = await confirmDialog({
      title: want ? 'Enable demo mode?' : 'Disable demo mode?',
      body:
        '<p>Switching demo mode resets the app to defaults and restarts the ' +
        'launch from the beginning, with demo mode ' +
        (want ? '<strong>enabled</strong>' : '<strong>disabled</strong>') +
        '.</p><p>Any wallet, token, or pool data you have entered for the ' +
        'current launch will be lost.</p>' +
        recoveryNote,
      confirmLabel: want ? 'Enable & restart' : 'Disable & restart',
      danger: true,
    });
    if (!proceed) {
      // User backed out — put the checkbox back the way it was.
      const toggle = document.getElementById('demoModeToggle');
      if (toggle) toggle.checked = !want;
      return;
    }

    try {
      const postResp = await fetch('/api/user-prefs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ demoMode: want }),
      });
      if (!postResp.ok) throw new Error('save failed (HTTP ' + postResp.status + ')');

      // Confirm the server actually entered the requested mode BEFORE we
      // reset/restart. persist() swallows disk-write errors, so a POST can
      // report success while the value never reached disk (e.g. a packaged
      // build without write access to its config folder). If it didn't take,
      // don't reload into a mismatched state — surface the reason instead.
      const statusResp = await fetch('/api/demo/status');
      const status = await statusResp.json();
      if (!!(status && status.active) !== want) {
        throw new Error(
          'the setting did not persist — the app may not have write access to ' +
          'its config folder. Demo mode was NOT changed.',
        );
      }

      // Reset to defaults and restart the launch from the beginning in the new
      // mode. A full reload is the most reliable reset: it clears every
      // in-memory launch variable and re-runs init, and the on-load path below
      // re-reads the (now-persisted) status to show or hide the demo banner.
      // Set the bypass first so the reload doesn't also trip the native
      // "launch in progress" dialog — we've already confirmed above.
      demoModeReloading = true;
      window.location.reload();
    } catch (e) {
      // Revert the checkbox to the real (unchanged) state and surface why.
      const toggle = document.getElementById('demoModeToggle');
      if (toggle) toggle.checked = !want;
      console.error('Failed to change demo mode:', e);
      log('Could not change demo mode: ' + e.message, 'danger');
    }
  }

  // Wire the settings toggle and the banner Disable button up front — they
  // exist in the DOM regardless of the current mode.
  bind('demoModeToggle', 'change', (e) => setDemoMode(e.target.checked));
  bind('demoBannerDisable', 'click', () => setDemoMode(false));
  bind('stickyDemoDisable', 'click', () => setDemoMode(false));

  // Reflect the current server state on load.
  fetch('/api/demo/status')
    .then((r) => r.json())
    .then((data) => {
      applyDemoModeUi(data && data.active);
      // Apply vanity availability — disables the Vanity CA UI when the
      // server reports the binary isn't built. CI handles release builds,
      // so end-user installs always show vanity enabled; this only
      // affects dev environments without a C toolchain.
      const vanity = data && data.vanity;
      applyVanityAvailabilityUi(vanity);
    })
    .catch((err) => {
      // If the status check fails, assume real mode (the safe default)
      // AND assume vanity is unavailable. Disabling a feature that
      // would have worked is a smaller cost than letting a request
      // fail mid-grind without an explanation.
      console.warn('Status check failed; assuming real mode + vanity disabled:', err);
      applyDemoModeUi(false);
      applyVanityAvailabilityUi({ available: false, reason: 'status check failed' });
    });
})();

// Disable Vanity CA controls and surface a friendly explanation when the
// server reports the vanity_keygen binary isn't built. Idempotent and
// safe to call before the relevant DOM elements exist — every lookup
// guards with a null check so partial DOM during startup doesn't throw.
function applyVanityAvailabilityUi(vanity) {
  const available = vanity && vanity.available;
  const target = document.getElementById('vanityCATarget');
  const mode = document.getElementById('vanityCAMode');
  const btn = document.getElementById('grindCABtn');
  if (available) {
    // Make sure controls are enabled (in case a prior call disabled them
    // and a later status check showed the feature came back). Rare but
    // cheap to handle.
    if (target) { target.disabled = false; target.title = ''; }
    if (mode) { mode.disabled = false; }
    if (btn) { btn.disabled = false; btn.title = ''; }
    const note = document.getElementById('vanityCAUnavailableNote');
    if (note) note.remove();
    return;
  }
  // Disabled state. Tooltip + visible help line so the user understands
  // why the button is dead. Reason comes from the server when available.
  const reason = (vanity && vanity.reason) || 'vanity address generation is not available in this build';
  if (target) { target.disabled = true; target.title = reason; }
  if (mode) { mode.disabled = true; }
  if (btn) { btn.disabled = true; btn.title = reason; }
  // Insert a help line below the existing description, so the user sees
  // an explanation in context rather than only when they hover the
  // greyed-out button. Idempotent: skip if already present.
  if (btn && !document.getElementById('vanityCAUnavailableNote')) {
    const note = document.createElement('p');
    note.id = 'vanityCAUnavailableNote';
    // Use the theme's rubric red (--rubric, #9a2424). Bulma's is-warning
    // would be yellow on the parchment background and basically illegible;
    // is-danger would work but the theme reserves stronger red for errors.
    // Rubric is the manuscript red used for accents and links throughout
    // the app, which is the right "needs attention but not catastrophic"
    // tone for a feature toggle.
    note.className = 'help is-size-7 mt-1';
    note.style.color = 'var(--rubric, #9a2424)';
    note.textContent = `Unavailable: ${reason}`;
    // Insert after the field container (the has-addons div that contains
    // the mode select, target input, and Grind button).
    const field = btn.closest('.field');
    if (field && field.parentNode) {
      field.parentNode.insertBefore(note, field.nextSibling);
    }
  }
}

// Final gate evaluation. Both setupDisclaimer() and setupSplashScreen()
// have run by this point. If either gated itself (showed a modal or
// played the splash), the gate is currently false and this call is a
// no-op — the trigger will fire later when the user dismisses
// whichever is still blocking. If NEITHER gated (returning user +
// splash element missing), both gates are still default-true and this
// is the only place the trigger ever fires.
_evaluateStartupGates();

// audio.js — sound effects and looping background music
//
// All sound here is built on plain HTMLAudioElement. There is deliberately NO
// Web Audio graph: a small pool of <audio> elements per sound is far easier to
// read and maintain, and most of our effects are triggered by a user gesture
// (a click, a checkbox, a menu pick), so the browser autoplay policy never
// gets in our way for them.
//
// Sound effects (all gated by the single playSoundEffects preference):
//   - click    (audio/click.flac)      a button or other clickable control
//   - menu     (audio/menuSelect.wav)  a <select> dropdown item is chosen
//   - checkbox (audio/checkbox.wav)    a checkbox is ticked or unticked
//   - coins    (audio/coins.wav)       the running SOL launch-cost estimate
//                                       changes to a new value
//   - expand       (audio/expand.wav)        a <details> panel opens
//   - collapse     (audio/collapse.ogg)      a <details> panel closes
//   - expandStep   (audio/expandStep.ogg)    a step card is opened for review
//   - collapseStep (audio/collapseStep.ogg)  a step card is collapsed again
//
// Background music (gated by the playBackgroundMusic preference):
//   - warTheme.mp3, looped. We try to start it the moment the app loads — in
//     the packaged Electron build the autoplay policy is relaxed, so it begins
//     immediately, playing under the first startup dialog. In a plain browser
//     (the `npm run web` build) the first play() is blocked until a gesture, so
//     we also retry on focus and on the first interaction. It fades in rather
//     than slamming on at full volume, and pauses while the window is hidden.
//
// Each sound effect keeps a POOL of preloaded elements so repeated triggers
// overlap cleanly instead of cutting each other off — a single <audio> can
// only play one instance of itself at a time.
//
// Everything here is defensive. A missing file, a blocked play() call, or an
// absent DOM element all degrade silently to "no sound" rather than throwing
// and taking the rest of the page down with them.
(function setupAudio() {
  // ---- Sound effect catalogue -------------------------------------------
  // One entry per effect. `volume` is 0..1; `poolSize` is how many overlapping
  // copies to keep ready (more for sounds that can fire in fast succession).
  // Paths are relative to the page (served from public/ by express.static).
  const SOUNDS = {
    click:    { url: 'audio/click.flac',     volume: 0.5, poolSize: 4 },
    menu:     { url: 'audio/menuSelect.wav', volume: 0.5, poolSize: 3 },
    checkbox: { url: 'audio/checkbox.wav',   volume: 0.5, poolSize: 3 },
    coins:    { url: 'audio/coins.wav',      volume: 0.5, poolSize: 2 },
    // Panel (a <details> disclosure) and whole-step expand/collapse.
    expand:       { url: 'audio/expand.wav',       volume: 0.5, poolSize: 2 },
    collapse:     { url: 'audio/collapse.ogg',     volume: 0.5, poolSize: 2 },
    expandStep:   { url: 'audio/expandStep.ogg',   volume: 0.5, poolSize: 2 },
    collapseStep: { url: 'audio/collapseStep.ogg', volume: 0.5, poolSize: 2 },
    // Played when the launch-success modal appears — the payoff moment of
    // the whole flow, so it sits a notch above the UI ticks.
    launch:       { url: 'audio/launch.ogg',       volume: 0.6, poolSize: 1 },
  };

  // What counts as "a clickable control" for the click sound. We match the
  // element itself OR any ancestor (via closest), so a click on the <span>/<i>
  // inside a Bulma button still ticks. Inputs, checkboxes, and <select>s are
  // intentionally absent — those get their own dedicated sounds below, so they
  // must not also fire the generic click.
  const CLICKABLE_SELECTOR = [
    'button',
    '.button',
    '[role="button"]',
    'a.button',
  ].join(',');

  // The element whose text shows the running launch-cost estimate. It is only
  // ever written with the actual SOL figure (the loading/error states live on
  // other elements), so watching its text for changes is a clean signal that
  // the total estimate moved.
  const COST_ELEMENT_ID = 'stickyCostValue';

  const MUSIC_URL = 'audio/warTheme.mp3';
  const MUSIC_VOLUME = 0.3;     // sits underneath the UI, ambient not loud
  const MUSIC_FADE_MS = 1500;   // fade-in (and fade-out on toggle/hide)

  // ---- State -------------------------------------------------------------
  // Preference flags. Default ON; we only flip them off when the persisted
  // value is explicitly false (mirrors how the intro-video pref is read).
  let sfxEnabled = true;
  let musicEnabled = true;

  // name -> { pool: [HTMLAudioElement], index: roundRobinCursor }
  const sfxBank = {};

  // The single looping music element, its fade timer, and whether playback has
  // actually begun (so we only fade-in once and don't fight ourselves).
  let musicEl = null;
  let musicFadeTimer = null;
  let musicStarted = false;

  // Last cost text we played the coins sound for, so re-rendering the same
  // value (which happens as multiple pools resolve) doesn't re-trigger it.
  let lastCostText = '';

  // ---- Sound effect engine ----------------------------------------------
  // Build the pool for one named sound. Each element is a detached <audio>
  // (an HTMLAudioElement plays fine without being in the DOM) with the source
  // assigned and preload hinted so the file is ready before the first trigger.
  function buildPool(name) {
    const def = SOUNDS[name];
    const pool = [];
    for (let i = 0; i < def.poolSize; i++) {
      const a = new Audio(def.url);
      a.preload = 'auto';
      a.volume = def.volume;
      pool.push(a);
    }
    sfxBank[name] = { pool, index: 0 };
  }

  // Play one instance of a named sound. We grab the next element in its pool,
  // rewind it to the start (in case it's mid-play from a very recent trigger),
  // and play. play() returns a promise that can reject (e.g. the file failed
  // to load); we swallow that — a missing effect shouldn't surface an error.
  function playSfx(name) {
    if (!sfxEnabled) return;
    const bank = sfxBank[name];
    if (!bank || bank.pool.length === 0) return;
    const el = bank.pool[bank.index];
    bank.index = (bank.index + 1) % bank.pool.length;
    try {
      el.currentTime = 0;
      const p = el.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch (_) {
      // Ignore — never let a sound effect break a real interaction.
    }
  }

  // ---- Delegated input listeners ----------------------------------------
  // One click listener for the whole page, in the CAPTURE phase so it still
  // fires for handlers that stopPropagation() on the way up. Skips disabled
  // and static controls so a greyed-out button stays silent.
  function onDocumentClick(e) {
    const target = e.target;
    if (!target || typeof target.closest !== 'function') return;
    const control = target.closest(CLICKABLE_SELECTOR);
    if (!control) return;
    if (control.disabled || control.classList.contains('is-static')) return;
    playSfx('click');
    // A click is a user gesture — a good moment to (re)try music if the web
    // build is still waiting for one.
    tryStartMusic();
  }

  // The change event is the precise "value committed" signal for both form
  // controls: a <select> fires it when the user picks a different option, and
  // a checkbox fires it when toggled. We listen once on the document so this
  // covers controls that are injected later, not just those present at load.
  function onDocumentChange(e) {
    const el = e.target;
    if (!el || !el.tagName) return;
    const tag = el.tagName.toLowerCase();
    if (tag === 'select') {
      playSfx('menu');
    } else if (tag === 'input' && el.type === 'checkbox') {
      playSfx('checkbox');
    }
    tryStartMusic();
  }

  // ---- Launch-cost watcher ----------------------------------------------
  // Watch the cost readout's text. When it changes to a new, non-placeholder
  // value, play the coins sound. Using a MutationObserver keeps this fully
  // decoupled from whatever code computes and writes the estimate.
  function watchCostEstimate() {
    const el = document.getElementById(COST_ELEMENT_ID);
    if (!el || typeof MutationObserver === 'undefined') return;

    // Seed with the current text so the initial placeholder (an em-dash)
    // doesn't count as a change the first time the observer fires.
    lastCostText = (el.textContent || '').trim();

    const isRealCost = (txt) => /\d/.test(txt); // must contain a digit

    const observer = new MutationObserver(() => {
      const txt = (el.textContent || '').trim();
      if (txt === lastCostText) return;       // no actual change
      const changed = txt;
      lastCostText = txt;
      if (isRealCost(changed)) playSfx('coins');
    });
    observer.observe(el, { childList: true, characterData: true, subtree: true });
  }

  // ---- Panel and step expand/collapse -----------------------------------
  // The native <details>/<summary> disclosure is this app's standard
  // collapsible panel (Advanced options, the airdrop section, the per-phase
  // descriptions, and so on). Each fires a `toggle` event whose .open tells
  // us which way it went. `toggle` does not bubble, but the capture phase
  // still reaches the document, so one capture-phase listener covers every
  // <details> on the page, including those injected into the DOM later.
  function watchDetailsPanels() {
    document.addEventListener('toggle', (e) => {
      const el = e.target;
      if (!el || el.tagName !== 'DETAILS') return;
      playSfx(el.open ? 'expand' : 'collapse');
    }, true);
  }

  // The six step cards expand/collapse for review via the `is-peeking` marker
  // class: the step-header click handler adds it when the user opens a
  // completed step, and setStepState() clears it when the step closes again.
  // Normal forward progression through the flow never sets it, so watching
  // that one class gives a clean "user expanded / collapsed a step" signal
  // with no false positives from advancing the launcher.
  function watchStepCards() {
    if (typeof MutationObserver === 'undefined') return;
    for (let i = 1; i <= 6; i++) {
      const card = document.getElementById(`step${i}-card`);
      if (!card) continue;
      let wasPeeking = card.classList.contains('is-peeking');
      const observer = new MutationObserver(() => {
        const now = card.classList.contains('is-peeking');
        if (now === wasPeeking) return;
        wasPeeking = now;
        playSfx(now ? 'expandStep' : 'collapseStep');
      });
      observer.observe(card, { attributes: true, attributeFilter: ['class'] });
    }
  }

  // ---- Launch-success fanfare ---------------------------------------------
  // Play the launch sound whenever the launch-success modal appears. Watching
  // the modal's class (Bulma modals show via is-active) keeps this module
  // self-contained — no call site needed in the modal-opening code, same as
  // every other trigger in this file.
  //
  // Wrinkle: the modal markup lives LATER in index.html than the app.js
  // script tag (see the lazy-wire comment in showLaunchSuccessModal), so the
  // element isn't in the DOM yet when this module boots. Try immediately for
  // safety, and fall back to wiring at DOMContentLoaded.
  function watchLaunchSuccessModal() {
    if (typeof MutationObserver === 'undefined') return;
    const wire = () => {
      const modal = document.getElementById('launchSuccessModal');
      if (!modal) return false;
      let wasActive = modal.classList.contains('is-active');
      const observer = new MutationObserver(() => {
        const now = modal.classList.contains('is-active');
        if (now === wasActive) return;
        wasActive = now;
        if (now) playSfx('launch');
      });
      observer.observe(modal, { attributes: true, attributeFilter: ['class'] });
      return true;
    };
    if (wire()) return;
    document.addEventListener('DOMContentLoaded', wire, { once: true });
  }

  // ---- Background music --------------------------------------------------
  // Create the looping music element on demand. Starts silent (volume 0) so
  // the fade-in has somewhere to climb from.
  function ensureMusicEl() {
    if (musicEl) return musicEl;
    musicEl = new Audio(MUSIC_URL);
    musicEl.loop = true;
    musicEl.preload = 'auto';
    musicEl.volume = 0;
    return musicEl;
  }

  // Linear volume fade on the music element. Clears any in-flight fade first so
  // toggling quickly doesn't leave two timers fighting over the volume.
  function fadeMusicTo(targetVolume, durationMs, onDone) {
    if (!musicEl) return;
    if (musicFadeTimer) {
      clearInterval(musicFadeTimer);
      musicFadeTimer = null;
    }
    const stepMs = 50;
    const steps = Math.max(1, Math.round(durationMs / stepMs));
    const start = musicEl.volume;
    const delta = targetVolume - start;
    let i = 0;
    musicFadeTimer = setInterval(() => {
      i++;
      const v = start + (delta * i) / steps;
      // Clamp — floating-point drift could otherwise push slightly past the
      // 0..1 range that .volume requires.
      musicEl.volume = Math.min(1, Math.max(0, v));
      if (i >= steps) {
        clearInterval(musicFadeTimer);
        musicFadeTimer = null;
        if (typeof onDone === 'function') onDone();
      }
    }, stepMs);
  }

  // Try to start the music. Idempotent: the musicStarted guard means repeated
  // calls (from boot, focus, first gesture, etc.) are harmless. If play() is
  // rejected — the plain-browser autoplay block before any gesture — we leave
  // musicStarted false so the next trigger retries.
  function tryStartMusic() {
    if (musicStarted || !musicEnabled) return;
    const el = ensureMusicEl();
    const p = el.play();
    if (p && typeof p.then === 'function') {
      p.then(() => {
        musicStarted = true;
        fadeMusicTo(MUSIC_VOLUME, MUSIC_FADE_MS);
      }).catch(() => {
        musicStarted = false; // blocked — a later gesture will retry
      });
    } else {
      // Older engines: play() returned no promise. Assume it started.
      musicStarted = true;
      fadeMusicTo(MUSIC_VOLUME, MUSIC_FADE_MS);
    }
  }

  // Fade out, then pause. Used when the user turns music off.
  function fadeOutAndPause() {
    if (!musicEl) return;
    fadeMusicTo(0, MUSIC_FADE_MS, () => {
      try { musicEl.pause(); } catch (_) {}
    });
  }

  // ---- Preference wiring -------------------------------------------------
  // Read persisted prefs once on load. Default-on: a value is only treated as
  // off when it's explicitly false. On any read error we keep the defaults,
  // matching the rest of the renderer's "fail toward the nice behaviour" style.
  function loadPrefs() {
    fetch('/api/user-prefs')
      .then((r) => r.json())
      .then((data) => {
        if (data && data.prefs) {
          sfxEnabled = data.prefs.playSoundEffects !== false;
          musicEnabled = data.prefs.playBackgroundMusic !== false;
        }
        const sfxToggle = document.getElementById('soundEffectsToggle');
        if (sfxToggle) sfxToggle.checked = sfxEnabled;
        const musicToggle = document.getElementById('backgroundMusicToggle');
        if (musicToggle) musicToggle.checked = musicEnabled;
        // If music is allowed, try to start now (the prefs round-trip may have
        // resolved after our initial boot attempt).
        tryStartMusic();
      })
      .catch((err) => {
        console.warn('audio: failed to read preferences, using defaults:', err);
      });
  }

  // Persist a single pref, fire-and-forget — same pattern as the intro-video
  // and update-check toggles. If the write fails the checkbox still moved
  // visually and the in-memory flag is already updated, so the current session
  // behaves as the user expects; only persistence across restarts is at risk.
  function persistPref(key, value) {
    fetch('/api/user-prefs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [key]: value }),
    }).catch((err) => {
      console.warn(`audio: failed to persist ${key}:`, err);
    });
  }

  function wireSettingsToggles() {
    const sfxToggle = document.getElementById('soundEffectsToggle');
    if (sfxToggle) {
      sfxToggle.addEventListener('change', () => {
        sfxEnabled = sfxToggle.checked;
        persistPref('playSoundEffects', sfxEnabled);
      });
    }

    const musicToggle = document.getElementById('backgroundMusicToggle');
    if (musicToggle) {
      musicToggle.addEventListener('change', () => {
        musicEnabled = musicToggle.checked;
        persistPref('playBackgroundMusic', musicEnabled);
        if (musicEnabled) {
          tryStartMusic();        // the checkbox click is itself a gesture
        } else if (musicStarted) {
          fadeOutAndPause();
          musicStarted = false;
        }
      });
    }
  }

  // ---- Lifecycle ---------------------------------------------------------
  // First-gesture retry for the plain-browser build, where the initial boot
  // play() is blocked until the user interacts. pointerdown/keydown cover
  // mouse, touch, and keyboard. Once music has started we stop listening.
  function onFirstGesture() {
    tryStartMusic();
    if (musicStarted) {
      window.removeEventListener('pointerdown', onFirstGesture, true);
      window.removeEventListener('keydown', onFirstGesture, true);
    }
  }

  // Be a good neighbour: pause when the tab/window is hidden, resume when it
  // comes back (only if the user still wants music). When it hasn't started
  // yet, a return-to-visible is also a fine moment to try.
  function onVisibilityChange() {
    if (document.hidden) {
      if (musicEl && musicStarted) {
        try { musicEl.pause(); } catch (_) {}
      }
      return;
    }
    if (musicStarted && musicEl) {
      const p = musicEl.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } else {
      tryStartMusic();
    }
  }

  // ---- Boot --------------------------------------------------------------
  for (const name of Object.keys(SOUNDS)) buildPool(name);
  document.addEventListener('click', onDocumentClick, true);
  document.addEventListener('change', onDocumentChange, true);
  window.addEventListener('pointerdown', onFirstGesture, true);
  window.addEventListener('keydown', onFirstGesture, true);
  window.addEventListener('focus', tryStartMusic);
  document.addEventListener('visibilitychange', onVisibilityChange);
  watchCostEstimate();
  watchDetailsPanels();
  watchStepCards();
  watchLaunchSuccessModal();
  // Start music as early as possible. In Electron this begins immediately,
  // under the first startup dialog; in a browser it's a no-op until a gesture.
  tryStartMusic();
  loadPrefs();
  wireSettingsToggles();
})();
