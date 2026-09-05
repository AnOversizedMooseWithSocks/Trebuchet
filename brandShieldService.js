import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import { PublicKey } from '@solana/web3.js';

const BRAND_SCHEMA = 'trebuchet-brand-fingerprint/v1';
const ATTESTATION_SCHEMA = 'trebuchet-launch-attestation/v1';
const MAX_METADATA_BYTES = 512 * 1024;
const DEFAULT_FETCH_TIMEOUT_MS = 8000;

function normalizeText(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function normalizedUri(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

export function canonicalJson(value) {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`
  )).join(',')}}`;
}

export function sha256Hex(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

export function metadataDocument({ name, symbol, description, imageUri }) {
  return {
    name: String(name || '').trim(),
    symbol: String(symbol || '').trim(),
    description: String(description || '').trim(),
    image: String(imageUri || '').trim() || null,
  };
}

export function metadataDocumentHash(document) {
  return sha256Hex(canonicalJson(document || {}));
}

export function buildBrandFingerprint({
  mint,
  name,
  symbol,
  metadataUri,
  metadataHash,
  imageUri,
  supply,
  decimals,
  launchWallet,
  journalId,
  createdAt,
  sealedLaunch = false,
} = {}) {
  const address = String(mint || '').trim();
  if (!address) throw new Error('Brand fingerprint requires a mint address.');
  const fingerprint = {
    schema: BRAND_SCHEMA,
    mint: address,
    name: String(name || '').trim() || null,
    symbol: String(symbol || '').trim() || null,
    normalizedName: normalizeText(name),
    normalizedSymbol: normalizeText(symbol),
    metadataUri: normalizedUri(metadataUri) || null,
    metadataHash: String(metadataHash || '').trim().toLowerCase() || null,
    imageUri: normalizedUri(imageUri) || null,
    supply: supply == null ? null : String(supply),
    decimals: Number.isFinite(Number(decimals)) ? Number(decimals) : null,
    launchWallet: String(launchWallet || '').trim() || null,
    journalId: String(journalId || '').trim() || null,
    sealedLaunch: sealedLaunch === true,
    createdAt: Number.isFinite(Date.parse(createdAt || ''))
      ? new Date(createdAt).toISOString()
      : new Date().toISOString(),
  };
  fingerprint.fingerprintHash = sha256Hex(canonicalJson(fingerprint));
  return fingerprint;
}

export function buildLaunchAttestation(fingerprint, { signedAt = new Date().toISOString() } = {}) {
  return {
    schema: ATTESTATION_SCHEMA,
    signedAt,
    fingerprintHash: fingerprint?.fingerprintHash || null,
    mint: fingerprint?.mint || null,
    launchWallet: fingerprint?.launchWallet || null,
  };
}

function ed25519PrivateKeyFromSolanaSecret(secretKey) {
  const bytes = Uint8Array.from(secretKey || []);
  if (bytes.length < 32) throw new Error('A Solana secret key is required to sign launch provenance.');
  const seed = Buffer.from(bytes.slice(0, 32));
  const prefix = Buffer.from('302e020100300506032b657004220420', 'hex');
  return crypto.createPrivateKey({
    key: Buffer.concat([prefix, seed]),
    format: 'der',
    type: 'pkcs8',
  });
}

function ed25519PublicKeyFromBytes(publicKeyBytes) {
  const prefix = Buffer.from('302a300506032b6570032100', 'hex');
  return crypto.createPublicKey({
    key: Buffer.concat([prefix, Buffer.from(publicKeyBytes)]),
    format: 'der',
    type: 'spki',
  });
}

export function signLaunchAttestation(fingerprint, secretKey, options = {}) {
  const attestation = buildLaunchAttestation(fingerprint, options);
  const payload = canonicalJson(attestation);
  const signature = crypto.sign(null, Buffer.from(payload), ed25519PrivateKeyFromSolanaSecret(secretKey));
  const secretBytes = Uint8Array.from(secretKey || []);
  const publicKeyBytes = secretBytes.length >= 64 ? secretBytes.slice(32, 64) : null;
  return {
    ...attestation,
    algorithm: 'ed25519',
    signerPublicKeyHex: publicKeyBytes ? Buffer.from(publicKeyBytes).toString('hex') : null,
    signature: signature.toString('base64'),
  };
}

export function verifyLaunchAttestation(fingerprint, attestation) {
  try {
    if (!attestation || attestation.algorithm !== 'ed25519') return false;
    if (attestation.fingerprintHash !== fingerprint?.fingerprintHash) return false;
    const publicKeyBytes = Buffer.from(String(attestation.signerPublicKeyHex || ''), 'hex');
    if (publicKeyBytes.length !== 32) return false;
    if (fingerprint?.launchWallet && new PublicKey(publicKeyBytes).toBase58() !== fingerprint.launchWallet) {
      return false;
    }
    const payload = canonicalJson(buildLaunchAttestation(fingerprint, {
      signedAt: attestation.signedAt,
    }));
    return crypto.verify(
      null,
      Buffer.from(payload),
      ed25519PublicKeyFromBytes(publicKeyBytes),
      Buffer.from(String(attestation.signature || ''), 'base64'),
    );
  } catch {
    return false;
  }
}

function metadataUrl(uri) {
  const value = String(uri || '').trim();
  if (!value) return null;
  if (value.startsWith('ipfs://')) return `https://ipfs.io/ipfs/${value.slice(7)}`;
  if (value.startsWith('ar://')) return `https://arweave.net/${value.slice(5)}`;
  let parsed;
  try { parsed = new URL(value); } catch { return null; }
  if (!['https:', 'http:'].includes(parsed.protocol)) return null;
  const host = parsed.hostname.toLowerCase();
  if (
    host === 'localhost'
    || host.endsWith('.local')
    || /^127\./.test(host)
    || /^10\./.test(host)
    || /^192\.168\./.test(host)
    || /^169\.254\./.test(host)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    || host === '::1'
  ) return null;
  return parsed.toString();
}

function privateNetworkAddress(address) {
  const value = String(address || '').toLowerCase().split('%')[0];
  if (net.isIPv4(value)) {
    const [a, b] = value.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 198 && (b === 18 || b === 19));
  }
  if (net.isIPv6(value)) {
    if (value === '::' || value === '::1') return true;
    if (/^(fc|fd)/.test(value) || /^fe[89ab]/.test(value)) return true;
    if (value.startsWith('::ffff:')) return privateNetworkAddress(value.slice(7));
  }
  return false;
}

async function publicMetadataUrl(uri, lookupImpl) {
  const normalized = metadataUrl(uri);
  if (!normalized) return null;
  const parsed = new URL(normalized);
  if (net.isIP(parsed.hostname)) return privateNetworkAddress(parsed.hostname) ? null : normalized;
  try {
    const addresses = await lookupImpl(parsed.hostname, { all: true, verbatim: true });
    if (!Array.isArray(addresses) || !addresses.length) return null;
    return addresses.some((row) => privateNetworkAddress(row?.address)) ? null : normalized;
  } catch {
    return null;
  }
}

async function readBoundedMetadataText(response, maxBytes = MAX_METADATA_BYTES) {
  const declaredLengthHeader = response?.headers?.get?.('content-length');
  const declaredLength = declaredLengthHeader === null
    || declaredLengthHeader === undefined
    || String(declaredLengthHeader).trim() === ''
    ? null
    : Number(declaredLengthHeader);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error('Metadata document exceeds the download limit.');
  }
  const chunks = [];
  let totalBytes = 0;
  const append = (value) => {
    const chunk = Buffer.from(value || []);
    totalBytes += chunk.length;
    if (totalBytes > maxBytes) throw new Error('Metadata document exceeds the download limit.');
    chunks.push(chunk);
  };
  if (response?.body?.getReader) {
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        append(value);
      }
    } catch (error) {
      await reader.cancel?.().catch?.(() => null);
      throw error;
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  if (response?.body?.[Symbol.asyncIterator]) {
    for await (const chunk of response.body) append(chunk);
    return Buffer.concat(chunks).toString('utf8');
  }
  // Real fetch Responses always expose a stream. This narrow fallback exists
  // for deterministic test adapters and only accepts a declared bounded size.
  if (Number.isFinite(declaredLength) && declaredLength >= 0 && typeof response?.text === 'function') {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      throw new Error('Metadata document exceeds the download limit.');
    }
    return text;
  }
  throw new Error('Metadata response does not support bounded streaming.');
}

export async function fetchMetadataDocument(uri, {
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
  lookupImpl = dns.lookup,
} = {}) {
  let url = await publicMetadataUrl(uri, lookupImpl);
  if (!url || typeof fetchImpl !== 'function') return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    let response = null;
    for (let redirects = 0; redirects <= 3; redirects += 1) {
      response = await fetchImpl(url, {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
        redirect: 'manual',
      });
      if (![301, 302, 303, 307, 308].includes(Number(response.status))) break;
      const location = response.headers?.get?.('location');
      if (!location || redirects === 3) return null;
      url = await publicMetadataUrl(new URL(location, url).toString(), lookupImpl);
      if (!url) return null;
    }
    if (!response.ok) return null;
    const text = await readBoundedMetadataText(response);
    const json = JSON.parse(text);
    if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
    return json;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchMetadataFingerprint(uri, options = {}) {
  const json = await fetchMetadataDocument(uri, options);
  if (!json) return null;
  return {
    metadataHash: metadataDocumentHash(json),
    imageUri: normalizedUri(json.image) || null,
    name: String(json.name || '').trim() || null,
    symbol: String(json.symbol || '').trim() || null,
  };
}

function matchSignals(candidate, launch) {
  const exactUri = Boolean(
    candidate.metadataUri
    && launch.metadataUri
    && normalizedUri(candidate.metadataUri) === normalizedUri(launch.metadataUri),
  );
  const exactHash = Boolean(
    candidate.metadataHash
    && launch.metadataHash
    && candidate.metadataHash.toLowerCase() === launch.metadataHash.toLowerCase(),
  );
  const exactImage = Boolean(
    candidate.imageUri
    && launch.imageUri
    && normalizedUri(candidate.imageUri) === normalizedUri(launch.imageUri),
  );
  const sameName = Boolean(
    normalizeText(candidate.name)
    && normalizeText(candidate.name) === launch.normalizedName,
  );
  const sameSymbol = Boolean(
    normalizeText(candidate.symbol)
    && normalizeText(candidate.symbol) === launch.normalizedSymbol,
  );
  return { exactUri, exactHash, exactImage, sameName, sameSymbol };
}

export function assessBrandRisk({
  mint,
  metadata = {},
  launches = [],
  liquidity = null,
} = {}) {
  const address = String(mint || '').trim();
  const official = launches.find((entry) => entry?.fingerprint?.mint === address) || null;
  const candidate = {
    name: metadata?.name || metadata?.symbol || null,
    symbol: metadata?.symbol || null,
    metadataUri: metadata?.metadataUri || metadata?.uri || null,
    metadataHash: metadata?.metadataHash || null,
    imageUri: metadata?.imageUri || metadata?.imageUrl || null,
  };
  const evidence = [];
  let matchedLaunch = official;

  if (!matchedLaunch) {
    let best = null;
    for (const launch of launches) {
      const signals = matchSignals(candidate, launch.fingerprint || {});
      const weight = (signals.exactHash ? 100 : 0)
        + (signals.exactUri ? 90 : 0)
        + (signals.exactImage ? 35 : 0)
        + (signals.sameName ? 20 : 0)
        + (signals.sameSymbol ? 20 : 0);
      if (!best || weight > best.weight) best = { launch, signals, weight };
    }
    if (best?.weight > 0) matchedLaunch = best.launch;
    if (best?.signals?.exactHash) evidence.push({ id: 'metadata-hash-reuse', severity: 'critical', detail: 'Metadata content exactly matches an official Trebuchet launch.' });
    if (best?.signals?.exactUri) evidence.push({ id: 'metadata-uri-reuse', severity: 'critical', detail: 'Metadata URI exactly matches an official Trebuchet launch.' });
    if (best?.signals?.exactImage) evidence.push({ id: 'image-reuse', severity: 'high', detail: 'Token image matches an official Trebuchet launch.' });
    if (best?.signals?.sameName && best?.signals?.sameSymbol) evidence.push({ id: 'identity-reuse', severity: 'high', detail: 'Name and symbol match an official Trebuchet launch.' });
    else if (best?.signals?.sameSymbol) evidence.push({ id: 'symbol-reuse', severity: 'medium', detail: 'Symbol matches an official Trebuchet launch.' });
  }

  const dropPercent = Number(liquidity?.dropPercent);
  const liquidityWithdrawn = Number.isFinite(dropPercent)
    && dropPercent >= 80
    && Number(liquidity?.highWaterUsd) >= 100;
  if (liquidityWithdrawn) {
    evidence.push({
      id: 'liquidity-collapse',
      severity: 'critical',
      detail: `Observed liquidity fell ${dropPercent.toFixed(1)}% from its recorded high-water mark.`,
    });
  }

  const earlyVolumeUsd = Number(liquidity?.earlyVolume1hUsd);
  const earlyBuys = Number(liquidity?.earlyBuys1h);
  const earlyCapitalMotion = Boolean(
    official
    && Number.isFinite(earlyVolumeUsd)
    && Number.isFinite(earlyBuys)
    && earlyVolumeUsd >= 1_000
    && earlyBuys >= 3
  );
  if (earlyCapitalMotion) {
    evidence.push({
      id: 'early-capital-motion',
      severity: earlyVolumeUsd >= 10_000 ? 'high' : 'medium',
      detail: `${earlyBuys} indexed buys and about $${Math.round(earlyVolumeUsd).toLocaleString('en-US')} of volume appeared during the first launch hour.`,
    });
  }

  const hasExactCopy = evidence.some((item) => ['metadata-hash-reuse', 'metadata-uri-reuse'].includes(item.id));
  const hasIdentityCopy = evidence.some((item) => item.id === 'identity-reuse');
  let classification = official ? 'Official' : 'Unverified';
  let risk = official ? 'low' : 'unknown';
  let scoreCap = official ? 100 : 69;
  if (!official && hasExactCopy) {
    classification = 'Counterfeit';
    risk = 'critical';
    scoreCap = 15;
  } else if (!official && hasIdentityCopy) {
    classification = 'Suspected copy';
    risk = 'high';
    scoreCap = 35;
  }
  if (liquidityWithdrawn) {
    classification = 'Liquidity withdrawn';
    risk = 'critical';
    scoreCap = Math.min(scoreCap, 10);
  } else if (earlyCapitalMotion && official) {
    risk = earlyVolumeUsd >= 10_000 ? 'high' : 'medium';
  }

  return {
    classification,
    risk,
    official: Boolean(official),
    scoreCap,
    matchedMint: !official ? matchedLaunch?.fingerprint?.mint || null : null,
    matchedSymbol: !official ? matchedLaunch?.fingerprint?.symbol || null : null,
    provenanceVerified: Boolean(
      official
      && official.attestation
      && verifyLaunchAttestation(official.fingerprint, official.attestation),
    ),
    activityAlert: earlyCapitalMotion,
    activityClassification: earlyCapitalMotion ? 'Early launch capital motion' : null,
    evidence,
    liquidity: liquidity || null,
  };
}

export async function findDexScreenerBrandCandidates(launches = [], {
  fetchImpl = globalThis.fetch,
  maxLaunches = 20,
  maxCandidates = 100,
} = {}) {
  if (typeof fetchImpl !== 'function') return [];
  const candidates = new Map();
  for (const launch of launches.slice(0, maxLaunches)) {
    const symbol = String(launch?.fingerprint?.symbol || '').trim();
    if (!symbol) continue;
    try {
      const response = await fetchImpl(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(symbol)}`, {
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) continue;
      const payload = await response.json();
      for (const pair of Array.isArray(payload?.pairs) ? payload.pairs : []) {
        if (pair?.chainId !== 'solana') continue;
        for (const token of [pair.baseToken, pair.quoteToken]) {
          const mint = String(token?.address || '').trim();
          if (!mint) continue;
          const relevantIdentity = mint === launch.fingerprint.mint
            || normalizeText(token?.symbol) === launch.fingerprint.normalizedSymbol
            || normalizeText(token?.name) === launch.fingerprint.normalizedName;
          if (!relevantIdentity) continue;
          const row = candidates.get(mint) || {
            mint,
            name: token?.name || null,
            symbol: token?.symbol || null,
            officialMint: launches.some((entry) => entry?.fingerprint?.mint === mint),
            pools: [],
          };
          if (pair.pairAddress && !row.pools.some((pool) => pool.address === pair.pairAddress)) {
            row.pools.push({
              address: pair.pairAddress,
              dex: pair.dexId || null,
              liquidityUsd: Number(pair?.liquidity?.usd) || null,
              volume5mUsd: Number(pair?.volume?.m5) || 0,
              volume1hUsd: Number(pair?.volume?.h1) || 0,
              buys5m: Number(pair?.txns?.m5?.buys) || 0,
              sells5m: Number(pair?.txns?.m5?.sells) || 0,
              buys1h: Number(pair?.txns?.h1?.buys) || 0,
              sells1h: Number(pair?.txns?.h1?.sells) || 0,
              pairCreatedAt: pair?.pairCreatedAt != null && Number.isFinite(Number(pair.pairCreatedAt))
                ? new Date(Number(pair.pairCreatedAt)).toISOString()
                : null,
              url: pair.url || null,
            });
          }
          candidates.set(mint, row);
          if (candidates.size >= maxCandidates) return [...candidates.values()];
        }
      }
    } catch {
      // A market-indexer miss must not break local launch or Discovery work.
    }
  }
  return [...candidates.values()];
}
