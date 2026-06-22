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

function setWalletQrImages(qrCode) {
  ['qrCode', 'step3QrCode'].forEach((id) => {
    const img = document.getElementById(id);
    if (!img) return;
    if (qrCode) {
      img.src = qrCode;
      img.classList.remove('hidden');
    } else {
      img.removeAttribute('src');
      img.classList.add('hidden');
    }
  });
}

async function ensureWalletQrCode(wallet = tempWallet) {
  if (!wallet || !wallet.publicKey) {
    setWalletQrImages(null);
    return null;
  }
  if (wallet.qrCode) {
    setWalletQrImages(wallet.qrCode);
    return wallet.qrCode;
  }
  const resp = await fetch('/api/wallet-qr?publicKey=' + encodeURIComponent(wallet.publicKey));
  const data = await resp.json();
  if (!resp.ok || !data.success || !data.qrCode) {
    throw new Error(data.error || `QR generation failed with HTTP ${resp.status}`);
  }
  wallet.qrCode = data.qrCode;
  setWalletQrImages(wallet.qrCode);
  return wallet.qrCode;
}

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
