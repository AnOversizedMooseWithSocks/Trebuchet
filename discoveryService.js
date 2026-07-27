const DEFAULT_COLOR = '#6be2a2';
const PUBLIC_MAINNET_RPC = Object.freeze({
  name: 'Public mainnet',
  url: 'https://api.mainnet-beta.solana.com',
});
const GECKO_SOLANA_BASE = 'https://api.geckoterminal.com/api/v2/networks/solana';
const MARKET_CACHE_TTL_MS = 60 * 1000;
const MARKET_CACHE_MAX_ENTRIES = 100;
const marketCache = new Map();

function rpcClusterHint(entry = {}) {
  const hint = `${entry.name || ''} ${entry.url || ''}`.toLowerCase();
  if (/\b(devnet|testnet)\b/.test(hint)) return 'non-mainnet';
  if (/\b(mainnet|mainnet-beta)\b/.test(hint)) return 'mainnet';
  return 'unknown';
}

function uniqueRpcEntries(entries = []) {
  const seen = new Set();
  return entries.filter((entry) => {
    const url = String(entry?.url || '').trim();
    if (!url || seen.has(url)) return false;
    seen.add(url);
    return true;
  });
}

export function discoveryRpcCandidates(config = {}) {
  const saved = Array.isArray(config.saved)
    ? config.saved
      .map((entry) => ({ name: String(entry?.name || 'Saved RPC'), url: String(entry?.url || '').trim() }))
      .filter((entry) => entry.url)
    : [];
  const activeUrl = String(config.active || '').trim();
  const active = saved.find((entry) => entry.url === activeUrl)
    || (activeUrl ? { name: 'Configured RPC', url: activeUrl } : null);
  const activeCluster = rpcClusterHint(active);
  const savedMainnet = saved.filter((entry) => rpcClusterHint(entry) === 'mainnet');
  const savedUnknown = saved.filter((entry) => rpcClusterHint(entry) === 'unknown');

  if (active && activeCluster !== 'non-mainnet') {
    return uniqueRpcEntries([active, ...savedMainnet, ...savedUnknown, PUBLIC_MAINNET_RPC]);
  }

  const mainnetCandidates = savedMainnet.length ? savedMainnet : [PUBLIC_MAINNET_RPC];
  return uniqueRpcEntries([...mainnetCandidates, ...savedUnknown, active]);
}

export function isMissingMintRpcError(error) {
  const message = String(error?.message || error || '');
  return /could not find account|not found on-chain|does not exist on chain|account[^.]*not found|mint[^.]*not found/i.test(message);
}

function safeBigInt(value) {
  try {
    return BigInt(String(value ?? '0'));
  } catch {
    return 0n;
  }
}

function finiteNumber(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function positiveNumber(value) {
  const parsed = finiteNumber(value);
  return parsed != null && parsed > 0 ? parsed : null;
}

function relationshipMatchesMint(relationship, mint) {
  return relationship?.data?.id === `solana_${mint}`;
}

export function parseDiscoveryMarketPool(mint, payload) {
  const pools = Array.isArray(payload?.data) ? payload.data : [];
  for (const pool of pools) {
    const attributes = pool?.attributes;
    const relationships = pool?.relationships;
    if (!attributes) continue;

    const isBase = relationshipMatchesMint(relationships?.base_token, mint);
    const isQuote = relationshipMatchesMint(relationships?.quote_token, mint);
    if (!isBase && !isQuote) continue;

    const priceUsd = positiveNumber(
      isBase ? attributes.base_token_price_usd : attributes.quote_token_price_usd,
    );
    const priceChange = attributes.price_change_percentage || {};
    const volume = attributes.volume_usd || {};
    const transactions = attributes.transactions || {};
    const h24Transactions = transactions.h24 || {};
    const address = String(
      attributes.address
        || String(pool.id || '').replace(/^solana_/, ''),
    ).trim();

    return {
      source: 'GeckoTerminal',
      available: true,
      priceUsd,
      priceChange: {
        m5: finiteNumber(priceChange.m5),
        h1: finiteNumber(priceChange.h1),
        h6: finiteNumber(priceChange.h6),
        h24: finiteNumber(priceChange.h24),
      },
      liquidityUsd: finiteNumber(attributes.reserve_in_usd),
      volume24hUsd: finiteNumber(volume.h24),
      fdvUsd: finiteNumber(attributes.fdv_usd),
      marketCapUsd: finiteNumber(attributes.market_cap_usd),
      transactions24h: {
        buys: finiteNumber(h24Transactions.buys),
        sells: finiteNumber(h24Transactions.sells),
        buyers: finiteNumber(h24Transactions.buyers),
        sellers: finiteNumber(h24Transactions.sellers),
      },
      pool: {
        address: address || null,
        name: attributes.name || null,
        dex: relationships?.dex?.data?.id || null,
        createdAt: attributes.pool_created_at || null,
      },
      history: null,
    };
  }
  return null;
}

export function parseDiscoveryOhlcv(payload) {
  const rows = Array.isArray(payload?.data?.attributes?.ohlcv_list)
    ? payload.data.attributes.ohlcv_list
    : [];
  const points = rows
    .map((row) => {
      if (!Array.isArray(row) || row.length < 6) return null;
      const time = finiteNumber(row[0]);
      const open = positiveNumber(row[1]);
      const high = positiveNumber(row[2]);
      const low = positiveNumber(row[3]);
      const close = positiveNumber(row[4]);
      const volume = finiteNumber(row[5]);
      if (time == null || open == null || high == null || low == null || close == null) return null;
      return {
        time: new Date(time * 1000).toISOString(),
        open,
        high,
        low,
        close,
        volume: volume == null ? 0 : Math.max(0, volume),
      };
    })
    .filter(Boolean)
    .sort((a, b) => Date.parse(a.time) - Date.parse(b.time))
    .slice(-48);

  if (!points.length) return null;
  const first = points[0];
  const last = points.at(-1);
  const open = first.open;
  const changePercent = open > 0 ? ((last.close - open) / open) * 100 : null;

  return {
    timeframe: '7D',
    candle: '4H',
    points,
    highUsd: Math.max(...points.map((point) => point.high)),
    lowUsd: Math.min(...points.map((point) => point.low)),
    volumeUsd: points.reduce((total, point) => total + point.volume, 0),
    changePercent,
    asOf: last.time,
  };
}

function trimMarketCache() {
  while (marketCache.size > MARKET_CACHE_MAX_ENTRIES) {
    marketCache.delete(marketCache.keys().next().value);
  }
}

export async function fetchDiscoveryMarketData(mint, { fetchImpl = globalThis.fetch } = {}) {
  const cached = marketCache.get(mint);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  if (typeof fetchImpl !== 'function') throw new Error('Market data fetch is unavailable');

  const headers = {
    Accept: 'application/json',
    Version: '20230302',
  };
  const poolResponse = await fetchImpl(
    `${GECKO_SOLANA_BASE}/tokens/${encodeURIComponent(mint)}/pools?include=base_token,quote_token,dex&page=1`,
    { headers },
  );
  if (!poolResponse.ok) {
    if (poolResponse.status === 404) return null;
    throw new Error(`GeckoTerminal pool lookup returned HTTP ${poolResponse.status}`);
  }

  const market = parseDiscoveryMarketPool(mint, await poolResponse.json());
  if (!market?.pool?.address) return market;

  try {
    const historyUrl = new URL(
      `${GECKO_SOLANA_BASE}/pools/${encodeURIComponent(market.pool.address)}/ohlcv/hour`,
    );
    historyUrl.searchParams.set('aggregate', '4');
    historyUrl.searchParams.set('limit', '42');
    historyUrl.searchParams.set('currency', 'usd');
    historyUrl.searchParams.set('token', mint);
    historyUrl.searchParams.set('include_empty_intervals', 'true');
    const historyResponse = await fetchImpl(historyUrl, { headers });
    if (historyResponse.ok) {
      market.history = parseDiscoveryOhlcv(await historyResponse.json());
    }
  } catch {
    // The current market snapshot is still useful when OHLCV is unavailable.
  }

  market.url = `https://www.geckoterminal.com/solana/pools/${market.pool.address}`;
  marketCache.set(mint, {
    value: market,
    expiresAt: Date.now() + MARKET_CACHE_TTL_MS,
  });
  trimMarketCache();
  return market;
}

function decimalPercent(numerator, denominator) {
  if (denominator <= 0n) return null;
  return Number((numerator * 10000n) / denominator) / 100;
}

function normalizeJournal(journal) {
  if (!journal || typeof journal !== 'object') return null;
  return {
    id: journal.id || null,
    status: journal.status || 'unknown',
    updatedAt: journal.updatedAt || journal.completedAt || journal.createdAt || null,
    walletPublicKey: journal.walletPublicKey || null,
    reportJsonUri: journal.report?.jsonUri || journal.reportPublish?.jsonUri || null,
    reportHtmlUri: journal.report?.htmlUri || journal.reportPublish?.htmlUri || null,
  };
}

function authorityEvidence(label, value, safeLabel, unsafeLabel) {
  if (value === true) return { label, value: safeLabel, state: 'pass' };
  if (value === false) return { label, value: unsafeLabel, state: 'warn' };
  return { label, value: 'Not verified', state: 'unknown' };
}

export function buildDiscoveryRecord({
  mint,
  metadata = null,
  compatibility = null,
  supply = null,
  largestAccounts = null,
  market = null,
  journal = null,
  inspectedAt = new Date().toISOString(),
  rpcName = 'Configured RPC',
  warnings = [],
} = {}) {
  const address = String(mint || '').trim();
  if (!address) throw new Error('Discovery record requires a mint address');

  const totalRaw = safeBigInt(supply?.amount);
  const hasConcentrationEvidence = Array.isArray(largestAccounts);
  const topRows = hasConcentrationEvidence ? largestAccounts.slice(0, 10) : [];
  const topTenRaw = topRows.reduce((sum, row) => sum + safeBigInt(row?.amount), 0n);
  const topTenPercent = hasConcentrationEvidence ? decimalPercent(topTenRaw, totalRaw) : null;
  const localJournal = normalizeJournal(journal);
  const mintAuthorityRenounced = compatibility?.mintAuthorityRenounced;
  const freezeAuthorityDisabled = compatibility?.freezeAuthorityDisabled;
  const compatible = compatibility?.compatible;
  const indexedPriceUsd = positiveNumber(market?.priceUsd);
  const metadataPriceUsd = positiveNumber(metadata?.priceUsd);
  const priceUsd = indexedPriceUsd ?? metadataPriceUsd;
  const decimals = Number.isFinite(Number(supply?.decimals))
    ? Number(supply.decimals)
    : Number.isFinite(Number(metadata?.decimals)) ? Number(metadata.decimals) : null;

  let score = 30;
  if (metadata?.symbol || metadata?.name) score += 10;
  if (mintAuthorityRenounced === true) score += 15;
  if (freezeAuthorityDisabled === true) score += 15;
  if (compatible === true) score += 10;
  if (priceUsd != null) score += 5;
  if (topTenPercent != null) {
    if (topTenPercent <= 35) score += 10;
    else if (topTenPercent <= 50) score += 6;
    else if (topTenPercent <= 70) score += 2;
  }
  if (localJournal) score += 5;
  score = Math.max(0, Math.min(100, score));

  const verifiedSignals = [
    metadata?.symbol || metadata?.name,
    totalRaw > 0n,
    mintAuthorityRenounced != null,
    freezeAuthorityDisabled != null,
    compatible != null,
    topTenPercent != null,
  ].filter(Boolean).length;
  const confidence = verifiedSignals >= 5 ? 'High' : verifiedSignals >= 3 ? 'Medium' : 'Low';
  const status = score >= 80 ? 'Ready' : score >= 60 ? 'Review' : 'Watch';
  const symbol = String(metadata?.symbol || `${address.slice(0, 4)}…${address.slice(-4)}`);
  const name = String(metadata?.name || symbol);
  const authoritySummary = mintAuthorityRenounced === true && freezeAuthorityDisabled === true
    ? 'mint and freeze authorities are disabled'
    : 'authority posture needs review';
  const concentrationSummary = topTenPercent == null
    ? 'token-account concentration is unavailable'
    : `the ten largest token accounts hold ${topTenPercent.toFixed(2)}%`;

  return {
    id: address,
    mint: address,
    name,
    symbol,
    color: DEFAULT_COLOR,
    imageUrl: metadata?.imageUrl || null,
    decimals,
    priceUsd: priceUsd == null ? null : String(priceUsd),
    score,
    status,
    confidence,
    inspectedAt,
    source: rpcName,
    dataSource: 'Live RPC inspection',
    summary: `${name}: ${authoritySummary}; ${concentrationSummary}.`,
    metrics: {
      supply: supply?.uiAmountString || null,
      largestAccounts: topRows.length,
      topTenPercent,
      program: compatibility?.isToken2022 ? 'Token-2022' : compatibility ? 'SPL Token' : 'Unknown',
      priceUsd: priceUsd == null ? null : String(priceUsd),
      liquidityUsd: finiteNumber(market?.liquidityUsd),
      volume24hUsd: finiteNumber(market?.volume24hUsd),
      marketCapUsd: finiteNumber(market?.marketCapUsd),
      fdvUsd: finiteNumber(market?.fdvUsd),
      change24h: finiteNumber(market?.priceChange?.h24),
    },
    market: market ? {
      ...market,
      priceUsd: indexedPriceUsd,
    } : null,
    compatibility: compatibility ? {
      compatible: compatible ?? null,
      isToken2022: compatibility.isToken2022 === true,
      extensions: Array.isArray(compatibility.extensions) ? compatibility.extensions : [],
      disallowedNames: Array.isArray(compatibility.disallowedNames) ? compatibility.disallowedNames : [],
      mintAuthorityRenounced: mintAuthorityRenounced ?? null,
      freezeAuthorityDisabled: freezeAuthorityDisabled ?? null,
    } : null,
    journal: localJournal,
    warnings: Array.isArray(warnings) ? warnings.filter(Boolean).map(String) : [],
    evidence: [
      authorityEvidence('Mint authority', mintAuthorityRenounced, 'Renounced', 'Still active'),
      authorityEvidence('Freeze authority', freezeAuthorityDisabled, 'Disabled', 'Still active'),
      {
        label: 'Raydium CLMM compatibility',
        value: compatible === true ? 'Compatible' : compatible === false ? 'Blocked' : 'Not verified',
        state: compatible === true ? 'pass' : compatible === false ? 'warn' : 'unknown',
      },
      {
        label: 'Top 10 token accounts',
        value: topTenPercent == null ? 'Unavailable' : `${topTenPercent.toFixed(2)}% of supply`,
        state: topTenPercent == null ? 'unknown' : topTenPercent <= 50 ? 'pass' : 'warn',
      },
      {
        label: 'Market price',
        value: priceUsd != null ? `$${priceUsd}` : 'No indexed price',
        state: priceUsd != null ? 'pass' : 'unknown',
      },
      {
        label: 'Trebuchet provenance',
        value: localJournal ? `${localJournal.status} local launch journal` : 'No matching local journal',
        state: localJournal ? 'pass' : 'unknown',
      },
    ],
  };
}
