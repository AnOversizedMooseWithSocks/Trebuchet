import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STORE_VERSION = 1;
const MAX_LAUNCHES = 500;
const MAX_ALERTS = 1000;
const MAX_OBSERVATIONS_PER_MINT = 64;

function configDir() {
  return process.env.TREBUCHET_CONFIG_DIR || __dirname;
}

function storeFile() {
  return path.join(configDir(), 'brandShield.json');
}

function emptyStore() {
  return { version: STORE_VERSION, launches: [], alerts: [], observations: {} };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function load() {
  try {
    if (!fs.existsSync(storeFile())) return emptyStore();
    const parsed = JSON.parse(fs.readFileSync(storeFile(), 'utf8'));
    return {
      version: STORE_VERSION,
      launches: Array.isArray(parsed?.launches) ? parsed.launches.slice(-MAX_LAUNCHES) : [],
      alerts: Array.isArray(parsed?.alerts) ? parsed.alerts.slice(-MAX_ALERTS) : [],
      observations: parsed?.observations && typeof parsed.observations === 'object'
        ? parsed.observations
        : {},
    };
  } catch (error) {
    console.warn('brandShieldStore: failed to read, using an empty registry:', error.message);
    return emptyStore();
  }
}

function persist(store) {
  fs.mkdirSync(configDir(), { recursive: true });
  const target = storeFile();
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, target);
}

export function listLaunches() {
  return clone(load().launches);
}

export function getLaunch(mint) {
  const row = load().launches.find((entry) => entry?.fingerprint?.mint === mint);
  return row ? clone(row) : null;
}

export function registerLaunch({ fingerprint, attestation = null, source = 'launch-journal' } = {}) {
  if (!fingerprint?.mint) throw new Error('Official launch registration requires a fingerprint.');
  const store = load();
  const now = new Date().toISOString();
  const existingIndex = store.launches.findIndex((entry) => entry?.fingerprint?.mint === fingerprint.mint);
  const existing = existingIndex >= 0 ? store.launches[existingIndex] : null;
  const row = {
    fingerprint: clone(fingerprint),
    attestation: attestation ? clone(attestation) : existing?.attestation || null,
    source,
    registeredAt: existing?.registeredAt || now,
    updatedAt: now,
  };
  if (existingIndex >= 0) store.launches.splice(existingIndex, 1);
  store.launches.push(row);
  store.launches = store.launches.slice(-MAX_LAUNCHES);
  persist(store);
  return clone(row);
}

export function recordObservation(mint, market = {}, observedAt = new Date().toISOString()) {
  const address = String(mint || '').trim();
  if (!address) return null;
  const liquidityUsd = Number(market?.liquidityUsd);
  const hasLiquidity = Number.isFinite(liquidityUsd) && liquidityUsd >= 0;
  const topHolders = Array.isArray(market?.topHolders)
    ? market.topHolders.slice(0, 20).map((holder) => ({
      owner: String(holder?.owner || '').trim(),
      amount: String(holder?.amount || ''),
    })).filter((holder) => holder.owner)
    : [];
  if (!hasLiquidity && topHolders.length === 0) return liquidityState(address);
  const store = load();
  const rows = Array.isArray(store.observations[address]) ? store.observations[address] : [];
  rows.push({
    observedAt,
    liquidityUsd: hasLiquidity ? liquidityUsd : null,
    poolAddress: market?.pool?.address || market?.poolAddress || null,
    dex: market?.pool?.dex || market?.dex || null,
    volume5mUsd: Number(market?.volume5mUsd) || 0,
    volume1hUsd: Number(market?.volume1hUsd) || 0,
    buys5m: Number(market?.buys5m) || 0,
    sells5m: Number(market?.sells5m) || 0,
    buys1h: Number(market?.buys1h) || 0,
    sells1h: Number(market?.sells1h) || 0,
    pairCreatedAt: market?.pairCreatedAt || null,
    topHolders,
  });
  store.observations[address] = rows.slice(-MAX_OBSERVATIONS_PER_MINT);
  persist(store);
  return liquidityState(address, store);
}

export function liquidityState(mint, loadedStore = null) {
  const store = loadedStore || load();
  const rows = Array.isArray(store.observations[mint]) ? store.observations[mint] : [];
  if (!rows.length) return null;
  const liquidityRows = rows.filter((row) => Number.isFinite(Number(row.liquidityUsd)));
  const highWaterUsd = liquidityRows.length
    ? Math.max(...liquidityRows.map((row) => Number(row.liquidityUsd) || 0))
    : 0;
  const currentUsd = liquidityRows.length ? Number(liquidityRows.at(-1)?.liquidityUsd) || 0 : 0;
  const dropPercent = highWaterUsd > 0 ? ((highWaterUsd - currentUsd) / highWaterUsd) * 100 : 0;
  const earlyRows = rows.filter((row) => {
    const pairCreated = Date.parse(row?.pairCreatedAt || '');
    const observed = Date.parse(row?.observedAt || '');
    return Number.isFinite(pairCreated)
      && Number.isFinite(observed)
      && observed >= pairCreated
      && observed - pairCreated <= 90 * 60 * 1000;
  });
  const latest = rows.at(-1) || {};
  return {
    currentUsd,
    highWaterUsd,
    dropPercent: Math.max(0, Math.min(100, dropPercent)),
    observationCount: rows.length,
    observedAt: latest.observedAt || null,
    earlyVolume1hUsd: earlyRows.length
      ? Math.max(...earlyRows.map((row) => Number(row.volume1hUsd) || 0))
      : 0,
    earlyBuys1h: earlyRows.length
      ? Math.max(...earlyRows.map((row) => Number(row.buys1h) || 0))
      : 0,
    latestTopHolders: clone(latest.topHolders || []),
  };
}

export function recordAlert({ mint, assessment, observedAt = new Date().toISOString() } = {}) {
  if (!mint || !assessment) return null;
  const primaryClassification = !['Official', 'Unverified'].includes(assessment.classification)
    ? assessment.classification
    : null;
  const classification = primaryClassification
    || (assessment.activityAlert ? assessment.activityClassification : assessment.classification);
  if (!classification || (!assessment.activityAlert && ['Official', 'Unverified'].includes(classification))) return null;
  const store = load();
  const key = [mint, classification, assessment.matchedMint || ''].join(':');
  const existingIndex = store.alerts.findIndex((alert) => alert.key === key);
  const row = {
    key,
    mint,
    classification,
    risk: assessment.risk,
    matchedMint: assessment.matchedMint || null,
    evidence: clone(assessment.evidence || []),
    firstSeenAt: existingIndex >= 0 ? store.alerts[existingIndex].firstSeenAt : observedAt,
    lastSeenAt: observedAt,
  };
  if (existingIndex >= 0) store.alerts.splice(existingIndex, 1);
  store.alerts.push(row);
  store.alerts = store.alerts.slice(-MAX_ALERTS);
  persist(store);
  return clone(row);
}

export function publicState() {
  const store = load();
  const critical = store.alerts.filter((alert) => alert.risk === 'critical').length;
  const officialMints = new Set(store.launches.map((launch) => launch?.fingerprint?.mint).filter(Boolean));
  const excludedOwners = new Set(store.launches.map((launch) => launch?.fingerprint?.launchWallet).filter(Boolean));
  const ownerMints = new Map();
  for (const mint of officialMints) {
    const rows = Array.isArray(store.observations[mint]) ? store.observations[mint] : [];
    const holders = Array.isArray(rows.at(-1)?.topHolders) ? rows.at(-1).topHolders : [];
    for (const holder of holders) {
      if (!holder?.owner || excludedOwners.has(holder.owner)) continue;
      const mints = ownerMints.get(holder.owner) || new Set();
      mints.add(mint);
      ownerMints.set(holder.owner, mints);
    }
  }
  const watcherCandidates = [...ownerMints.entries()]
    .filter(([, mints]) => mints.size >= 2)
    .map(([owner, mints]) => ({ owner, launchCount: mints.size, mints: [...mints] }))
    .sort((a, b) => b.launchCount - a.launchCount || a.owner.localeCompare(b.owner))
    .slice(0, 50);
  return {
    schema: 'trebuchet-brand-shield/v1',
    officialLaunchCount: store.launches.length,
    alertCount: store.alerts.length,
    criticalAlertCount: critical,
    watcherCandidateCount: watcherCandidates.length,
    watcherCandidates,
    launches: clone(store.launches),
    alerts: clone(store.alerts.slice(-100).reverse()),
  };
}
