// tokenInfoService.js
//
// Resolves an SPL token mint to its display info: { symbol, decimals,
// priceUsd, programId }.
//
// Architecture: on-chain first for everything that's available on-chain,
// external indexers only for what isn't.
//
//   decimals → SPL mint account (immutable, always available, RPC call)
//   symbol   → Metaplex Metadata account (almost always present, RPC call)
//   priceUsd → external indexer (off-chain market data, cannot be read on-chain)
//
// External-call budget for prices: at most one GeckoTerminal call,
// then at most one Jupiter call as fallback if Gecko didn't produce a
// usable price. Results are cached so repeat lookups during the same
// session don't re-hit the APIs.
//
// Why this order: GeckoTerminal is the original (and stricter) source
// the app already relied on, so we keep it primary and treat any change
// in its output as the "expected" behaviour. Jupiter is the fallback
// because its pricing model can produce a price for thinly-traded
// tokens that GeckoTerminal hasn't indexed — important for the
// flywheel use case, where the whole point of the quote token is that
// it's not heavily traded yet.
//
//   GeckoTerminal free-tier rate limit: 30 req/min.
//   Jupiter (lite-api.jup.ag): higher, but we treat it as scarce too.
//
// Caching + the "Gecko first, Jupiter only on miss" ordering mean we
// stay well under both limits even if the user is configuring 6+ pools
// and toggling quote tokens repeatedly.

import { Connection, PublicKey } from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  unpackMint,
} from '@solana/spl-token';
import Decimal from 'decimal.js';
import { getRpcUrl } from './rpcConfig.js';
import {
  parseMetaplexName,
  parseMetaplexSymbol,
  parseMetaplexUri,
} from './tokenMetadataLayout.js';

// Metaplex Token Metadata program ID. Hardcoded rather than imported
// from @metaplex-foundation/mpl-token-metadata to keep this module's
// dependency surface minimal — we only need to derive the metadata PDA.
const METADATA_PROGRAM_ID = new PublicKey(
  'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s',
);

const GECKO_BASE = 'https://api.geckoterminal.com/api/v2/networks/solana';

// DexScreener Solana token endpoint. Used as a final fallback after
// GeckoTerminal and Jupiter both miss. DexScreener tracks a much wider
// long tail of tokens than Gecko's indexed pool set — particularly newer
// or lower-volume tokens that haven't propagated to other aggregators.
// 60 req/min rate limit, no API key required.
const DEXSCREENER_BASE = 'https://api.dexscreener.com/tokens/v1/solana';

// Jupiter's free pricing endpoint. lite-api.jup.ag is the public,
// API-key-free tier; the api.jup.ag domain has paid tiers and stricter
// access patterns we don't need.
//
// V3 replaced V2 in late 2025/early 2026. V2 is deprecated and may
// start returning 401 without an API key. The migration was small in
// terms of URL (just /v3 instead of /v2) but the response shape and
// the price field name both changed — see fetchPriceFromJupiter below.
const JUPITER_PRICE_BASE = 'https://lite-api.jup.ag/price/v3';

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------
//
// Two TTLs — static fields (symbol, decimals, programId) effectively
// never change for a given mint, so we keep them long. Price is real-time
// market data; 60s strikes a balance between freshness for the user and
// not hitting the API every time they flip between dropdown options.
//
// One Map keyed by mint, with two timestamps for the two TTL classes.
// Simpler than maintaining two separate Maps and easier to inspect.

const STATIC_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const PRICE_TTL_MS  = 60 * 1000;            // 60s

// Soft cap on cache entries. Map preserves insertion order, so removing
// the first key on overflow gives us FIFO eviction. Set well above any
// realistic session — typical use sees fewer than ten unique mints —
// so this only ever kicks in for pathological cases. Better to cap at a
// known number than to risk slow memory growth in a long-running app.
const CACHE_MAX_ENTRIES = 200;

const cache = new Map();

function trimCache() {
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    cache.delete(oldestKey);
  }
}

function readCache(mint) {
  const e = cache.get(mint);
  if (!e) return null;
  const now = Date.now();
  return {
    symbol:    now < e.staticExpiresAt  ? e.symbol    : undefined,
    decimals:  now < e.staticExpiresAt  ? e.decimals  : undefined,
    programId: now < e.staticExpiresAt  ? e.programId : undefined,
    // On-chain Metaplex name and uri — same TTL as the rest of the static
    // fields since they all come from the same metadata account read.
    name:      now < e.staticExpiresAt  ? e.onChainName : undefined,
    uri:       now < e.staticExpiresAt  ? e.onChainUri  : undefined,
    // Display meta (imageUrl, friendlyName) shares a separate TTL slot
    // since it's populated lazily after possibly multiple network calls
    // (Metaplex URI fetch, Gecko /info, DexScreener) — we don't want to
    // re-trigger that whole chain on every getTokenInfo call.
    imageUrl:      now < e.displayExpiresAt ? e.imageUrl     : undefined,
    friendlyName:  now < e.displayExpiresAt ? e.friendlyName : undefined,
    priceUsd:      now < e.priceExpiresAt   ? e.priceUsd     : undefined,
  };
}

function writeCacheStatic(mint, { symbol, decimals, programId, name, uri }) {
  const existing = cache.get(mint) || {};
  cache.set(mint, {
    ...existing,
    symbol,
    decimals,
    programId,
    onChainName: name ?? null,
    onChainUri: uri ?? null,
    staticExpiresAt: Date.now() + STATIC_TTL_MS,
  });
  trimCache();
}

// Cache display metadata (logo URL, friendly name) sourced from external
// indexers (GeckoTerminal, DexScreener) or the off-chain Metaplex JSON.
// Same TTL as static fields. Either field may be null — we cache the
// negative result too so we don't keep retrying for tokens that just
// don't have an image anywhere.
//
// Stored under separate keys (friendlyName / imageUrl) to avoid colliding
// with the on-chain name/uri tracked by writeCacheStatic.
function writeCacheDisplayMeta(mint, { imageUrl, name }) {
  const existing = cache.get(mint) || {};
  cache.set(mint, {
    ...existing,
    imageUrl: imageUrl ?? null,
    friendlyName: name ?? null,
    displayExpiresAt: Date.now() + STATIC_TTL_MS,
  });
  trimCache();
}

function writeCachePrice(mint, priceUsd) {
  const existing = cache.get(mint) || {};
  cache.set(mint, {
    ...existing,
    priceUsd,
    priceExpiresAt: Date.now() + PRICE_TTL_MS,
  });
  trimCache();
}

// In-flight de-duplication (singleflight). The TTL cache above handles repeat
// lookups across time; this collapses *concurrent* lookups for the same key,
// while the cache is cold or expired, into a single network round-trip.
// Without it, N simultaneous callers for one mint each fire their own request.
// Keyed by `${kind}:${mint}` so a price fetch and a metadata fetch for the
// same mint don't share a slot. The promise is removed in finally() so a
// rejected fetch doesn't poison the next attempt. Cheaper than a global rate
// limiter and, unlike one, it adds no latency to the common cached path.
const _inflight = new Map();
function singleflight(key, fn) {
  const existing = _inflight.get(key);
  if (existing) return existing;
  const p = Promise.resolve().then(fn).finally(() => _inflight.delete(key));
  _inflight.set(key, p);
  return p;
}

// ---------------------------------------------------------------------------
// On-chain reads (decimals + symbol)
// ---------------------------------------------------------------------------

// Fetch the mint account and the Metaplex metadata account in a single
// RPC call. Returns { decimals, symbol, programId } where symbol is null
// if no Metaplex metadata exists for the mint.
async function readOnChainBasics(mintAddress, rpcUrl = getRpcUrl()) {
  const connection = new Connection(rpcUrl, 'confirmed');
  const mintPubkey = new PublicKey(mintAddress);

  const [metadataPDA] = PublicKey.findProgramAddressSync(
    [
      Buffer.from('metadata'),
      METADATA_PROGRAM_ID.toBuffer(),
      mintPubkey.toBuffer(),
    ],
    METADATA_PROGRAM_ID,
  );

  // Single RPC call for both accounts. Saves a round-trip vs calling
  // getMint and getAccountInfo separately.
  const [mintInfo, metadataInfo] = await connection.getMultipleAccountsInfo(
    [mintPubkey, metadataPDA],
  );

  if (!mintInfo) {
    throw new Error(`Mint ${mintAddress} not found on-chain`);
  }

  // The mint account's owner tells us which token program it belongs to —
  // either the classic SPL Token program or Token-2022. We need to know
  // this both to unpack the mint and so callers (the Raydium SDK in
  // particular) can build the correct instructions.
  const programIdPk = mintInfo.owner;
  if (
    !programIdPk.equals(TOKEN_PROGRAM_ID) &&
    !programIdPk.equals(TOKEN_2022_PROGRAM_ID)
  ) {
    throw new Error(
      `Mint ${mintAddress} is owned by an unexpected program: ` +
        `${programIdPk.toBase58()}`,
    );
  }

  const mintData = unpackMint(mintPubkey, mintInfo, programIdPk);

  // Metaplex metadata is optional. Most well-known tokens have it; some
  // very-low-effort or programmatically-minted ones don't. When it's
  // missing we'll fall back to a truncated mint as the display symbol.
  // We pull name and uri out of the same data — both are free since the
  // metadata account is already loaded. The uri points to an off-chain
  // JSON document with the canonical logo URL (see fetchDisplayMeta-
  // FromMetaplexUri).
  let symbol = null;
  let name = null;
  let uri = null;
  if (metadataInfo) {
    try {
      symbol = parseMetaplexSymbol(metadataInfo.data);
      name = parseMetaplexName(metadataInfo.data);
      uri = parseMetaplexUri(metadataInfo.data);
    } catch (e) {
      console.warn(
        `tokenInfoService: failed to parse Metaplex metadata for ${mintAddress}: ${e.message}`,
      );
    }
  }

  return {
    decimals: mintData.decimals,
    symbol,
    name,
    uri,
    programId: programIdPk.toBase58(),
  };
}

// ---------------------------------------------------------------------------
// Price lookup
// ---------------------------------------------------------------------------

// Try GeckoTerminal first. Returns null on any kind of miss — token
// not indexed, no price_usd available, network error. Caller treats
// null as "try the next source."
//
// Two-step lookup. The /tokens/{mint} endpoint is the obvious one and
// returns price_usd in attributes for most tokens, but for stablecoins
// and some lower-volume tokens the field is absent from the top-level
// response (per Gecko's own FAQ, that field is derived from the token's
// top pool, and the derivation isn't always done inline). When we don't
// see a price there, we fall through to /tokens/{mint}/pools, which
// returns the list of pools containing this token; each pool's
// attributes include base_token_price_usd or quote_token_price_usd
// directly. Picking the first pool gives us the price Gecko's own UI
// would display.
// Pure helper: given a parsed GeckoTerminal /tokens/{mint}/pools
// response body and the mint address we asked about, return the USD
// price of that mint or null if we can't safely derive one.
//
// Exposed as a named export so the disambiguation logic can be unit
// tested with synthetic fixtures (no network), AND so anyone debugging
// a future "wrong price" report can paste the raw API response and
// call this helper directly to see what it returns.
//
// Decision tree per pool, walking pools in liquidity order (Gecko
// already orders the response that way):
//   1. Read relationships.base_token.data.id and
//      relationships.quote_token.data.id. Both have format
//      `solana_<MINT>`. Match against `solana_${mintAddress}` to
//      decide which side we're on.
//   2. If neither side matches our mint, SKIP this pool. (Malformed
//      response; arbitrary guessing was the historical bug.)
//   3. Read our-side's direct USD price. If present and positive,
//      return it.
//   4. Otherwise, derive from the other side: our_usd = other_usd *
//      (our per other ratio). Both base_token_price_quote_token and
//      quote_token_price_base_token are present in the response with
//      complementary semantics.
//   5. If all pools fail, return null.
export function extractPriceFromGeckoPools(mintAddress, responseJson) {
  const pools = Array.isArray(responseJson?.data) ? responseJson.data : [];
  const expectedId = `solana_${mintAddress}`;

  for (const pool of pools) {
    const a = pool?.attributes;
    const rels = pool?.relationships;
    if (!a) continue;

    const baseId = rels?.base_token?.data?.id;
    const quoteId = rels?.quote_token?.data?.id;
    let isBase;
    if (baseId === expectedId) {
      isBase = true;
    } else if (quoteId === expectedId) {
      isBase = false;
    } else {
      // Neither side matches — skip rather than guess.
      continue;
    }

    // Direct USD price for our side.
    const priceStr = isBase ? a.base_token_price_usd : a.quote_token_price_usd;
    if (priceStr) {
      try {
        const price = new Decimal(priceStr);
        if (price.gt(0)) return price;
      } catch (_) {}
    }

    // Derived USD price via the other side's USD + the per-other ratio.
    // ratio interpretation:
    //   base_token_price_quote_token: how many quote tokens per 1 base token
    //   quote_token_price_base_token: how many base tokens per 1 quote token
    // For our-token-is-base:  ratio = base/quote → our_usd = quote_usd * ratio
    //                                              (units check: quote_per_base × usd_per_quote = usd_per_base) ✓
    // For our-token-is-quote: ratio = quote/base → our_usd = base_usd * ratio
    //                                              (units check: base_per_quote × usd_per_base = usd_per_quote) ✓
    const otherPriceStr = isBase ? a.quote_token_price_usd : a.base_token_price_usd;
    const ratioStr = isBase ? a.base_token_price_quote_token : a.quote_token_price_base_token;
    if (otherPriceStr && ratioStr) {
      try {
        const otherPrice = new Decimal(otherPriceStr);
        const ratio = new Decimal(ratioStr);
        if (otherPrice.gt(0) && ratio.gt(0)) {
          const derived = otherPrice.mul(ratio);
          if (derived.gt(0)) return derived;
        }
      } catch (_) {}
    }
    // Neither direct nor derived worked — try the next pool.
  }
  return null;
}

async function fetchPriceFromGecko(mintAddress) {
  // Step 1: direct token endpoint. Returns price + name + symbol but
  // NOT image_url — that's on the separate /tokens/{addr}/info endpoint
  // (see fetchDisplayMetaFromGecko) which getTokenInfo handles.
  //
  // For this endpoint, attributes.price_usd is defined by Gecko docs
  // as "the USD price of the token in the first pool listed under
  // top_pools" — i.e., it's unambiguous about WHICH token it refers
  // to (the one we asked about). No disambiguation needed here.
  try {
    const resp = await fetch(`${GECKO_BASE}/tokens/${mintAddress}`, {
      headers: { Accept: 'application/json' },
    });
    if (resp.ok) {
      const json = await resp.json();
      const priceStr = json?.data?.attributes?.price_usd;
      if (priceStr) return new Decimal(priceStr);
      // Indexed but price_usd absent — fall through to pools endpoint.
    } else if (resp.status >= 500 || resp.status === 429) {
      console.warn(
        `tokenInfoService: GeckoTerminal /tokens HTTP ${resp.status} for ${mintAddress}`,
      );
      // Don't bother with the second call if the API is in trouble.
      return null;
    }
    // 404 falls through too — the /pools endpoint sometimes succeeds
    // for tokens that /tokens doesn't return.
  } catch (e) {
    console.warn(`tokenInfoService: GeckoTerminal /tokens error for ${mintAddress}:`, e.message);
    // Network error is rare and probably affects both endpoints; bail.
    return null;
  }

  // Step 2: pools endpoint, with relationships-based disambiguation.
  // The pure logic lives in extractPriceFromGeckoPools (exported so it
  // can be unit-tested with synthetic fixtures).
  try {
    const resp = await fetch(`${GECKO_BASE}/tokens/${mintAddress}/pools`, {
      headers: { Accept: 'application/json' },
    });
    if (!resp.ok) {
      if (resp.status >= 500 || resp.status === 429) {
        console.warn(
          `tokenInfoService: GeckoTerminal /pools HTTP ${resp.status} for ${mintAddress}`,
        );
      }
      return null;
    }
    const json = await resp.json();
    return extractPriceFromGeckoPools(mintAddress, json);
  } catch (e) {
    console.warn(`tokenInfoService: GeckoTerminal /pools error for ${mintAddress}:`, e.message);
    return null;
  }
}

// Fallback: Jupiter Price V3. Jupiter prices tokens by working outward
// from a small set of trusted base tokens, so it can produce a price
// for any token Jupiter can route a swap against — a much wider set
// than GeckoTerminal's indexed pools.
//
// Returns null on any kind of miss. Jupiter's V3 has heuristics that
// withhold prices for tokens flagged as illiquid or potentially
// manipulated; in those cases it omits the entry from the response
// rather than returning a misleading number. We propagate that as null
// and prompt the user for manual entry.
//
// V3 response shape: top-level object keyed by mint, with usdPrice,
// decimals, blockId, priceChange24h. No "data" wrapper, no "price"
// field — the V2 names. https://dev.jup.ag/docs/api/price-api/price
async function fetchPriceFromJupiter(mintAddress) {
  try {
    const url = `${JUPITER_PRICE_BASE}?ids=${mintAddress}`;
    const resp = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!resp.ok) {
      if (resp.status >= 500 || resp.status === 429 || resp.status === 401) {
        console.warn(
          `tokenInfoService: Jupiter returned HTTP ${resp.status} for ${mintAddress}`,
        );
      }
      return null;
    }
    const json = await resp.json();
    // V3: { "<mint>": { usdPrice, decimals, blockId, priceChange24h } }
    const entry = json?.[mintAddress];
    if (!entry || entry.usdPrice == null) return null;
    return new Decimal(entry.usdPrice);
  } catch (e) {
    console.warn(`tokenInfoService: Jupiter error for ${mintAddress}:`, e.message);
    return null;
  }
}

// Last-resort fallback: DexScreener. Used after both Gecko and Jupiter
// miss. DexScreener tracks pairs across many DEXes and indexes the long
// tail more aggressively than the others — particularly useful for
// newer or lower-volume tokens, which is exactly the case where Gecko
// returns no `price_usd` and Jupiter's heuristics decline to price.
//
// Endpoint: GET /tokens/v1/solana/{tokenAddress}
// Returns a JSON array of pair objects, each with priceUsd, baseToken,
// quoteToken, liquidity, and so on. We pick the first pair (DexScreener
// orders by liquidity desc, like Gecko's pools endpoint), and read
// priceUsd from it. The priceUsd field is a string and is the USD price
// of whichever side of the pair the requested token is on, so we don't
// need to disambiguate base vs quote ourselves.
//
// Rate limit: 60 req/min, no API key required.
// Pure helper: given the parsed DexScreener /tokens/v1/solana/{addr}
// response (an array of pair objects) and the mint we asked about,
// return our token's USD price or null if we can't safely derive one.
//
// Two-pass scan:
//   Pass 1: prefer pairs where our token is the BASE — priceUsd is
//           directly correct.
//   Pass 2: pairs where our token is the QUOTE — derive our price
//           from the base's priceUsd and the priceNative ratio.
//
// We never fall back to "take any pair's priceUsd" — that was the
// historical bug. Returning the wrong token's price is worse than
// returning null and letting the next source try, because pool
// creation on a wrong price silently creates the pool at the wrong
// ratio (no error surface), whereas null surfaces cleanly.
//
// Exported for the same reasons as extractPriceFromGeckoPools.
export function extractPriceFromDexScreenerPairs(mintAddress, pairs) {
  if (!Array.isArray(pairs)) return null;

  // Pass 1: our token as base.
  for (const pair of pairs) {
    if (pair?.baseToken?.address === mintAddress && pair.priceUsd) {
      try {
        const price = new Decimal(pair.priceUsd);
        if (price.gt(0)) return price;
      } catch (_) {}
    }
  }

  // Pass 2: our token as quote — derive from base's priceUsd / priceNative.
  // priceNative on DexScreener is "how many quote tokens you'd get for 1
  // base token" (the pool's native rate). For a SOL/USDC pair that's
  // ~150 (150 USDC per SOL). So if we want our quote-side token's USD
  // price:
  //   one_base_usd       = priceUsd
  //   one_base_in_quote  = priceNative
  //   one_quote_usd      = priceUsd / priceNative
  for (const pair of pairs) {
    if (
      pair?.quoteToken?.address === mintAddress &&
      pair?.baseToken?.address &&
      pair.priceUsd &&
      pair.priceNative
    ) {
      try {
        const basePriceUsd = new Decimal(pair.priceUsd);
        const baseInQuoteUnits = new Decimal(pair.priceNative);
        if (basePriceUsd.gt(0) && baseInQuoteUnits.gt(0)) {
          const derived = basePriceUsd.div(baseInQuoteUnits);
          if (derived.gt(0)) return derived;
        }
      } catch (_) {}
    }
  }

  return null;
}

async function fetchPriceFromDexScreener(mintAddress) {
  try {
    const resp = await fetch(`${DEXSCREENER_BASE}/${mintAddress}`, {
      headers: { Accept: 'application/json' },
    });
    if (!resp.ok) {
      if (resp.status >= 500 || resp.status === 429) {
        console.warn(
          `tokenInfoService: DexScreener returned HTTP ${resp.status} for ${mintAddress}`,
        );
      }
      return null;
    }
    const json = await resp.json();
    const pairs = Array.isArray(json) ? json : [];
    return extractPriceFromDexScreenerPairs(mintAddress, pairs);
  } catch (e) {
    console.warn(`tokenInfoService: DexScreener error for ${mintAddress}:`, e.message);
    return null;
  }
}

// Resolve the off-chain Metaplex metadata document for a token and pull
// its `image` field. The on-chain Metaplex account stores a `uri` that
// points at a JSON blob (Arweave, IPFS, or sometimes a centralized URL)
// following the standard schema:
//
//   { name, symbol, description, image, properties: {...}, ... }
//
// The `image` field is what the token creator declared as the canonical
// logo, so we treat it as more authoritative than what an indexer might
// have chosen later.
//
// Returns { imageUrl, name } or null. The name is taken from the off-chain
// JSON too — it's typically the same as the on-chain name but may be
// longer (the on-chain name is capped at 32 bytes).
//
// Failure modes that all return null cleanly:
//   - URI is empty or malformed
//   - Fetch times out (5s) or fails
//   - Response is not valid JSON
//   - JSON has no usable `image` field
async function fetchDisplayMetaFromMetaplexUri(uri) {
  if (!uri) return null;

  // Normalize the URI scheme. Most tokens use https://arweave.net/...
  // directly; some use ipfs://CID, which the browser/Node fetch can't
  // resolve. Rewrite IPFS to a public gateway so we don't have to teach
  // every client about IPFS.
  let url = uri.trim();
  if (url.startsWith('ipfs://')) {
    url = `https://ipfs.io/ipfs/${url.slice('ipfs://'.length)}`;
  }
  // Reject anything that didn't end up looking like an http(s) URL.
  // Tokens with bogus uri fields (typos, internal-only schemes) shouldn't
  // produce errors, just a clean null.
  if (!/^https?:\/\//i.test(url)) return null;

  // 5-second cap so a slow/down Arweave gateway doesn't block resolution.
  // The /info and DexScreener fallbacks are still cheap to try after.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);

  try {
    const resp = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!resp.ok) {
      console.warn(
        `tokenInfoService: Metaplex URI HTTP ${resp.status} for ${url}`,
      );
      return null;
    }
    const json = await resp.json();
    // Must be a plain object — defensive against URIs that point at
    // arrays, strings, or null (yes, real tokens have shipped each of
    // these by mistake).
    if (!json || typeof json !== 'object' || Array.isArray(json)) {
      return null;
    }
    const imageUrl = typeof json.image === 'string' && json.image.trim()
      ? json.image.trim()
      : null;
    const name = typeof json.name === 'string' && json.name.trim()
      ? json.name.trim()
      : null;
    if (!imageUrl && !name) return null;
    return { imageUrl, name };
  } catch (e) {
    // AbortError is the timeout case; everything else is network or
    // JSON-parse error. We treat all the same — fall through to indexers.
    if (e.name !== 'AbortError') {
      console.warn(`tokenInfoService: Metaplex URI fetch error for ${url}:`, e.message);
    } else {
      console.warn(`tokenInfoService: Metaplex URI timeout for ${url}`);
    }
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

// Dedicated DexScreener call solely for display meta (image + name).
// Used as a fallback in getTokenInfo when the price chain succeeded via
// Gecko or Jupiter but we never got an image_url out of the responses
// — DexScreener's curated `info.imageUrl` covers tokens that Gecko
// indexes without artwork. Same network shape as fetchPriceFromDexScreener
// but ignores price.
async function fetchDisplayMetaFromDexScreener(mintAddress) {
  try {
    const resp = await fetch(`${DEXSCREENER_BASE}/${mintAddress}`, {
      headers: { Accept: 'application/json' },
    });
    if (!resp.ok) {
      if (resp.status >= 500 || resp.status === 429) {
        console.warn(
          `tokenInfoService: DexScreener (display) HTTP ${resp.status} for ${mintAddress}`,
        );
      }
      return null;
    }
    const json = await resp.json();
    const pairs = Array.isArray(json) ? json : [];
    for (const pair of pairs) {
      if (pair?.baseToken?.address === mintAddress) {
        const imageUrl = pair.info?.imageUrl || null;
        const name = pair.baseToken?.name || null;
        if (imageUrl || name) return { imageUrl, name };
        break;
      }
    }
    return null;
  } catch (e) {
    console.warn(`tokenInfoService: DexScreener (display) error for ${mintAddress}:`, e.message);
    return null;
  }
}

// Dedicated GeckoTerminal call for display meta (image + name).
//
// Important: image_url is NOT on the basic /tokens/{addr} endpoint that
// fetchPriceFromGecko uses — it's only on /tokens/{addr}/info. The basic
// endpoint returns price + name + symbol; the /info endpoint is a
// separate "token profile" doc with image + description + socials.
//
// We hit this lazily from getTokenInfo only when the price chain didn't
// already populate an image — same pattern as the DexScreener fallback.
// Returns {imageUrl, name} or null.
async function fetchDisplayMetaFromGecko(mintAddress) {
  try {
    const resp = await fetch(`${GECKO_BASE}/tokens/${mintAddress}/info`, {
      headers: { Accept: 'application/json' },
    });
    if (!resp.ok) {
      if (resp.status >= 500 || resp.status === 429) {
        console.warn(
          `tokenInfoService: GeckoTerminal /info HTTP ${resp.status} for ${mintAddress}`,
        );
      }
      return null;
    }
    const json = await resp.json();
    const attrs = json?.data?.attributes;
    if (!attrs) return null;
    const imageUrl = attrs.image_url || null;
    const name = attrs.name || null;
    if (!imageUrl && !name) return null;
    return { imageUrl, name };
  } catch (e) {
    console.warn(`tokenInfoService: GeckoTerminal /info error for ${mintAddress}:`, e.message);
    return null;
  }
}

// Resolve just the USD price, going through Gecko → Jupiter → DexScreener.
// Returns a Decimal or null. Honours the cache.
// Resolve a token's USD price from external aggregators.
//
// IMPORTANT context: aggregators are NOT the source of truth. The LP
// (the on-chain pool) is. GeckoTerminal, Jupiter, and DexScreener all
// read pool state and republish it with different aggregation methods.
// When two of them disagree, it's because they aggregate across
// different pool sets or apply different liquidity filters — not
// because one of them has "the right answer." Treating them as
// independent oracles to cross-check would be a category error.
//
// For pool CREATION specifically, the caller in lpService.js bypasses
// this whole function and queries Raydium's swap quote directly. That
// IS the source of truth for the pool we're about to create (same
// liquidity universe). The aggregators here are used only for:
//   - The UI's quote-token info display (the "this token costs $X"
//     hint shown in Step 2 when the user picks a quote token)
//   - The funding-estimate cost preview before the user funds
//   - Fallback when Raydium has no route at all
//
// Priority order:
//   1. Jupiter Price V3 — uses Jupiter's router under the hood,
//      which routes the same pool universe Raydium does. Closest
//      proxy to "the price our pool will be measured against."
//   2. GeckoTerminal — alternative when Jupiter has no entry.
//   3. DexScreener — last resort for long-tail tokens.
//
// We try sequentially (not in parallel) because the chained-fallback
// pattern means we only need later sources when earlier ones fail.
// A successful Jupiter response saves the Gecko round-trip entirely.
async function resolvePriceUsd(mintAddress) {
  const cached = readCache(mintAddress);
  if (cached?.priceUsd !== undefined) {
    return cached.priceUsd; // may be a Decimal or null (cached negative)
  }
  // Cache miss: collapse concurrent callers for the same mint into one network
  // round-trip via singleflight. The TTL cache above handles repeats across
  // time; without this, N simultaneous price lookups for one mint each fire
  // the full Jupiter → Gecko → DexScreener fallback chain.
  return singleflight('price:' + mintAddress, () =>
    _resolvePriceUsdUncached(mintAddress),
  );
}

// Actual fetch path for resolvePriceUsd. Assumes the cache was already checked
// (and missed). Writes the result — including a null "negative" cache entry —
// back to the cache before returning.
async function _resolvePriceUsdUncached(mintAddress) {
  let price = null;
  let source = null;

  try {
    price = await fetchPriceFromJupiter(mintAddress);
    if (price != null) source = 'jupiter';
  } catch (e) {
    console.warn(`tokenInfoService: Jupiter threw for ${mintAddress}:`, e.message);
  }

  if (price == null) {
    try {
      price = await fetchPriceFromGecko(mintAddress);
      if (price != null) source = 'gecko';
    } catch (e) {
      console.warn(`tokenInfoService: Gecko threw for ${mintAddress}:`, e.message);
    }
  }

  if (price == null) {
    try {
      price = await fetchPriceFromDexScreener(mintAddress);
      if (price != null) source = 'dexscreener';
    } catch (e) {
      console.warn(`tokenInfoService: DexScreener threw for ${mintAddress}:`, e.message);
    }
  }

  if (price == null) {
    console.warn(
      `tokenInfoService: no USD price for ${mintAddress} from Jupiter, Gecko, or DexScreener`,
    );
  } else {
    // Log every successful price resolution with the source. Invaluable
    // for debugging "wrong price" reports — the launch journal captures
    // these via stdout, and the source tag tells us instantly whether
    // an aggregator was off (different from "the pool we'll create
    // against has a different price than the aggregators report").
    console.log(
      `tokenInfoService: ${mintAddress} → $${price.toString()} (source: ${source})`,
    );
  }

  writeCachePrice(mintAddress, price);
  return price;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve everything we know about a token mint.
 *
 * Returns:
 *   {
 *     symbol:    string (truncated mint as fallback when no Metaplex metadata)
 *     decimals:  number
 *     priceUsd:  Decimal | null   // null = no source could provide a price
 *     programId: string (base58)  // either classic SPL or Token-2022
 *     name:      string | null    // friendly name from Gecko, on-chain
 *                                 // Metaplex, or null if neither has one
 *     imageUrl:  string | null    // logo URL from Gecko or DexScreener,
 *                                 // null if no indexer has the token
 *   }
 *
 * Throws only on hard failures (mint doesn't exist on-chain, RPC down,
 * Token-2022 not handled, etc.). A missing price/name/image is NOT a
 * hard failure — the caller surfaces it as "enter manually" in the UI.
 */
export async function getTokenInfo(mintAddress, { rpcUrl = null } = {}) {
  const configuredRpcUrl = getRpcUrl();
  const selectedRpcUrl = rpcUrl || configuredRpcUrl;
  const useConfiguredRpcCache = selectedRpcUrl === configuredRpcUrl;
  const cached = useConfiguredRpcCache ? readCache(mintAddress) : null;

  // Static fields: read on-chain only when we don't have them in cache.
  // We track the on-chain Metaplex name and uri here as inputs to display
  // meta resolution — both are free since the metadata account is already
  // loaded. The uri is the canonical pointer to the off-chain JSON doc
  // that holds the logo URL (see fetchDisplayMetaFromMetaplexUri).
  let symbol, decimals, programId, onChainName, onChainUri;
  if (
    cached?.symbol !== undefined &&
    cached?.decimals !== undefined &&
    cached?.programId !== undefined
  ) {
    symbol = cached.symbol;
    decimals = cached.decimals;
    programId = cached.programId;
    onChainName = cached.name ?? null;
    onChainUri = cached.uri ?? null;
  } else {
    const onChain = await readOnChainBasics(mintAddress, selectedRpcUrl);
    symbol = onChain.symbol;
    decimals = onChain.decimals;
    programId = onChain.programId;
    onChainName = onChain.name;
    onChainUri = onChain.uri;
    if (useConfiguredRpcCache) {
      writeCacheStatic(mintAddress, {
        symbol,
        decimals,
        programId,
        name: onChainName,
        uri: onChainUri,
      });
    }
  }

  // Symbol fallback: if Metaplex metadata is missing, show a truncated
  // mint so the user has SOMETHING readable. Caller can override via
  // the Advanced section if they want the real symbol.
  const displaySymbol = symbol || `${mintAddress.slice(0, 4)}…${mintAddress.slice(-4)}`;

  // Price: separate cache & TTL.
  const priceUsd = await resolvePriceUsd(mintAddress);

  // Display meta (image + name) — composed from sources in descending
  // priority:
  //   1. Off-chain Metaplex JSON pointed to by the on-chain `uri` field.
  //      This is what the token creator declared canonical, so it's the
  //      most authoritative source for both image and name. Hosted on
  //      Arweave, IPFS, or sometimes a custom domain.
  //   2. GeckoTerminal /tokens/{addr}/info — the dedicated token profile
  //      endpoint. Useful for tokens where Metaplex metadata is missing,
  //      empty, or uses a dead gateway.
  //   3. DexScreener /tokens/v1/solana/{addr} — covers long-tail tokens
  //      that Gecko hasn't profiled yet.
  //   4. On-chain Metaplex `name` field (image stays null) — last-resort
  //      fallback for the friendly name.
  //
  // We avoid re-fetching when the display-meta cache slot is set — even
  // with null values. The cache entry's displayExpiresAt being set (vs
  // undefined) is the signal that a previous getTokenInfo call already
  // exhausted the resolution chain for this mint. Without this guard
  // we'd re-hit the metadata gateway, /info, and DexScreener every
  // single call for tokens that have no logo anywhere.
  const cacheEntry = cache.get(mintAddress);
  const alreadyResolved = cacheEntry && cacheEntry.displayExpiresAt
    && Date.now() < cacheEntry.displayExpiresAt;

  let imageUrl = cacheEntry?.imageUrl ?? null;
  let name = cacheEntry?.friendlyName ?? null;

  if (!alreadyResolved) {
    // Step 1: Metaplex URI. Most reliable when present and reachable;
    // skipped when the on-chain account has no uri at all.
    if (imageUrl == null && onChainUri) {
      const meta = await fetchDisplayMetaFromMetaplexUri(onChainUri);
      if (meta) {
        imageUrl = meta.imageUrl ?? imageUrl;
        name = name ?? meta.name ?? null;
      }
    }
    // Step 2: Gecko /info. Catches tokens with empty/dead Metaplex URIs.
    if (imageUrl == null) {
      const gecko = await fetchDisplayMetaFromGecko(mintAddress);
      if (gecko) {
        imageUrl = gecko.imageUrl ?? imageUrl;
        name = name ?? gecko.name ?? null;
      }
    }
    // Step 3: DexScreener fallback.
    if (imageUrl == null) {
      const ds = await fetchDisplayMetaFromDexScreener(mintAddress);
      if (ds) {
        imageUrl = ds.imageUrl ?? imageUrl;
        name = name ?? ds.name ?? null;
      }
    }
    // Cache whatever we ended up with — including null. Future calls
    // for the same mint within the TTL will short-circuit.
    writeCacheDisplayMeta(mintAddress, { imageUrl, name });
  }

  // Final fallback for name only — if no source had one, use whatever
  // Metaplex put on-chain. Kept separate from the indexer-meta cache so
  // it doesn't lock in the on-chain name as the friendly name forever.
  if (name == null && onChainName) {
    name = onChainName;
  }

  return {
    symbol: displaySymbol,
    decimals,
    priceUsd,
    programId,
    name,
    imageUrl,
  };
}

/**
 * Convenience wrapper that returns just the USD price as a Decimal or null.
 * Used by the launch flow when symbol/decimals are already known from
 * elsewhere (e.g. KNOWN_QUOTES) and only the price needs looking up.
 */
export async function getUsdPrice(mintAddress) {
  return resolvePriceUsd(mintAddress);
}

/**
 * Backwards-compatible export with the same shape lpService used to
 * provide. Existing callers (server.js /api/quote-token-info) keep
 * working unchanged. Now also exposes name and imageUrl, which existing
 * callers ignore (they cherry-pick fields).
 */
export async function getTokenMetadata(mintAddress, options = {}) {
  try {
    const info = await getTokenInfo(mintAddress, options);
    return {
      symbol: info.symbol,
      decimals: info.decimals,
      priceUsd: info.priceUsd,
      name: info.name,
      imageUrl: info.imageUrl,
    };
  } catch (e) {
    console.warn(`tokenInfoService: getTokenMetadata failed for ${mintAddress}:`, e.message);
    return null;
  }
}
