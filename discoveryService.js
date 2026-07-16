const DEFAULT_COLOR = '#6be2a2';
const PUBLIC_MAINNET_RPC = Object.freeze({
  name: 'Public mainnet',
  url: 'https://api.mainnet-beta.solana.com',
});

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
    return uniqueRpcEntries([active, ...savedMainnet, ...savedUnknown]);
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
  const priceUsd = metadata?.priceUsd == null ? null : String(metadata.priceUsd);
  const decimals = Number.isFinite(Number(supply?.decimals))
    ? Number(supply.decimals)
    : Number.isFinite(Number(metadata?.decimals)) ? Number(metadata.decimals) : null;

  let score = 30;
  if (metadata?.symbol || metadata?.name) score += 10;
  if (mintAuthorityRenounced === true) score += 15;
  if (freezeAuthorityDisabled === true) score += 15;
  if (compatible === true) score += 10;
  if (priceUsd) score += 5;
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
    priceUsd,
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
      priceUsd,
    },
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
        value: priceUsd ? `$${priceUsd}` : 'No indexed price',
        state: priceUsd ? 'pass' : 'unknown',
      },
      {
        label: 'Trebuchet provenance',
        value: localJournal ? `${localJournal.status} local launch journal` : 'No matching local journal',
        state: localJournal ? 'pass' : 'unknown',
      },
    ],
  };
}
