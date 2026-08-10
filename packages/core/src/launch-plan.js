import crypto from 'node:crypto';
import {
  COST_BS_QUOTE_SOL,
  COST_LAUNCH_REPORT_SOL,
  COST_LOCK_SOL,
  COST_POOL_RENT_SOL,
  COST_POSITION_SOL,
  COST_TOKEN_CREATE_SOL,
  COST_TRANSFER_SOL,
  COST_TX_BUFFER_SOL,
  estimateAirdropExecutionCostSol,
} from './lp-constants.js';
import {
  detectLogoImageDimensions,
  normalizeLogoImageMime,
  normalizeTokenDescription,
  normalizeTokenName,
  normalizeTokenSymbol,
  normalizeVanityTargetBase58,
  normalizeWholeTokenSupply,
} from './validators.js';

const CONTRACT_VERSION = 1;
export const TREBUCHET_PLAN_SCHEMA = 'trebuchet-launch-plan/v1';
export const TREBUCHET_CORE_PROTOCOL_VERSION = 1;
const TOKEN_DECIMALS = 9;
const VALID_MODES = new Set(['guarded', 'operator', 'dry-run']);
const DEFAULT_SOL_MINT = 'So11111111111111111111111111111111111111112';
const DEFAULT_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const DEFAULT_MEME_FLYWHEEL_MINT = 'HipYKXiDh3Kjd1jb7ji6jCEsKQMSGWiFJMdtvH8yb5r';
const DEFAULT_RESERVE_FLYWHEEL_MINT = 'J1bZFRAFC8ALqAN7ktkcCpobgoeTGfP5Xh1BwCP1oqoj';
const CLASSIC_LADDER_DEFAULT_SUPPLY_PERCENT = 50;
const CLASSIC_LADDER_DEFAULT_CEILING_MULTIPLIER = 1000;
const CLASSIC_LADDER_MAX_BANDS = 20;
const CLASSIC_MAX_WHOLE_TOKEN_SUPPLY = 10_000_000_000n;
const PUBLIC_RPC_HOSTS = new Set([
  'api.mainnet-beta.solana.com',
  'solana-api.projectserum.com',
  'rpc.ankr.com',
  'solana.public-rpc.com',
]);
const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const LOGO_DATA_URL_RE = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/=]+)$/;
const MAX_LOGO_BYTES = 100 * 1024;
const MIN_LOGO_DIMENSION = 64;
const MAX_LOGO_DIMENSION = 1024;
const KNOWN_CLASSIC_QUOTE_MINTS = new Set([
  DEFAULT_SOL_MINT,
  DEFAULT_USDC_MINT,
  DEFAULT_MEME_FLYWHEEL_MINT,
  DEFAULT_RESERVE_FLYWHEEL_MINT,
]);
const CLASSIC_ENDPOINTS = {
  createToken: '/api/create-token',
  estimateFunding: '/api/estimate-lp-funding',
  preflightCreateLp: '/api/preflight-create-lp',
  createLp: '/api/create-lp',
  resumeLaunch: '/api/resume-launch',
  transferAssets: '/api/transfer-assets',
};
const REQUIRED_OPERATION_IDS = Object.freeze([
  'v2-wallet-and-ca',
  'v2-funding-check',
  'v2-mint-metadata',
  'v2-revoke-authorities',
  'v2-create-liquidity-pools',
  'v2-lock-liquidity',
  'v2-report-sweep',
]);

function transferSweepErrorCount(transfer = {}) {
  const tokenErrors = Array.isArray(transfer.tokenTransferErrors)
    ? transfer.tokenTransferErrors
    : Array.isArray(transfer.tokenSweep?.errors) ? transfer.tokenSweep.errors : [];
  const nftErrors = Array.isArray(transfer.nftTransferErrors)
    ? transfer.nftTransferErrors
    : Array.isArray(transfer.nftSweep?.errors) ? transfer.nftSweep.errors : [];
  return tokenErrors.length + nftErrors.length + (transfer.solSweepError ? 1 : 0);
}

function transferHasWalletEmptyFinalSweepEvidence(transfer = null) {
  return Boolean(
    transfer
    && typeof transfer === 'object'
    && String(transfer.destinationWallet || '').trim()
    && transfer.status !== 'planned-before-sweep'
    && transfer.walletEmpty === true
    && transferSweepErrorCount(transfer) === 0
  );
}

function roundSol(value) {
  return Number(Number(value || 0).toFixed(6));
}

function normalizeLaunchSol(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) {
    throw new Error('Launch SOL must be a non-negative number');
  }
  return roundSol(amount);
}

function normalizeMode(value) {
  const mode = String(value || 'guarded').trim();
  return VALID_MODES.has(mode) ? mode : 'guarded';
}

function numeric(value, fallback = 0) {
  const parsed = Number(String(value ?? '').replace(/[$,\s]/g, ''));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizePercent(value, fallback = 0) {
  return roundSol(clamp(numeric(value, fallback), 0, 100));
}

function optionalPositiveNumber(value) {
  if (value === undefined || value === null || String(value).trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function optionalQuoteDecimals(value) {
  if (value === undefined || value === null || String(value).trim() === '') return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.max(0, Math.floor(parsed));
}

function normalizeV2TokenSupply(value) {
  const supply = normalizeWholeTokenSupply(value);
  if (BigInt(supply) > CLASSIC_MAX_WHOLE_TOKEN_SUPPLY) {
    throw new Error('Total supply must not exceed 10,000,000,000');
  }
  return supply;
}

function normalizeSliceDistribution(input) {
  const raw = Array.isArray(input) && input.length
    ? input.map((item) => ({
      sharePercent: normalizePercent(item?.sharePercent ?? item, 0),
      recipient: typeof item?.recipient === 'string' && item.recipient.trim() ? item.recipient.trim() : null,
    })).filter((item) => item.sharePercent > 0)
    : [{ sharePercent: 100, recipient: null }];
  const total = raw.reduce((sum, item) => sum + item.sharePercent, 0);
  if (total <= 0) return [{ sharePercent: 100, recipient: null }];
  const normalized = raw.map((item) => ({
    ...item,
    sharePercent: Number(((item.sharePercent / total) * 100).toFixed(2)),
  }));
  const drift = Number((100 - normalized.reduce((sum, item) => sum + item.sharePercent, 0)).toFixed(2));
  normalized[normalized.length - 1].sharePercent = Number((normalized[normalized.length - 1].sharePercent + drift).toFixed(2));
  return normalized;
}

function normalizeLadder(input = {}) {
  if (input.mode === 'manual' && Array.isArray(input.bands) && input.bands.length) {
    return {
      mode: 'manual',
      bands: input.bands.map((band) => ({
        supplyPercent: normalizePercent(band.supplyPercent, 0),
        lowerMultiplier: numeric(band.lowerMultiplier, 1.1),
        upperMultiplier: numeric(band.upperMultiplier, 2),
      })),
    };
  }
  const bandCount = Math.floor(clamp(numeric(input.bandCount, 0), 0, CLASSIC_LADDER_MAX_BANDS));
  if (bandCount <= 0 || input.mode === 'off') return { mode: 'off' };
  const supplyPercentInput = String(input.supplyPercent ?? '').trim()
    ? input.supplyPercent
    : CLASSIC_LADDER_DEFAULT_SUPPLY_PERCENT;
  const ceilingMultiplierInput = String(input.ceilingMultiplier ?? '').trim()
    ? input.ceilingMultiplier
    : CLASSIC_LADDER_DEFAULT_CEILING_MULTIPLIER;
  return {
    mode: 'simple',
    bandCount,
    supplyPercent: normalizePercent(supplyPercentInput, CLASSIC_LADDER_DEFAULT_SUPPLY_PERCENT),
    ceilingMultiplier: numeric(ceilingMultiplierInput, CLASSIC_LADDER_DEFAULT_CEILING_MULTIPLIER),
  };
}

function normalizeSupport(input = {}) {
  const solValue = Math.max(0, numeric(input.solValue, 0));
  if (input.mode !== 'custom' || solValue <= 0) return { mode: 'off' };
  return {
    mode: 'custom',
    solValue: roundSol(solValue),
    depthPct: clamp(numeric(input.depthPct, 12), 1, 50),
  };
}

function normalizeAirdropRows(rows = []) {
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => {
    const wallet = String(row?.wallet || row?.recipient || '').trim();
    if (!wallet) return null;
    const tokens = numeric(row.tokens ?? row.amount, 0);
    return {
      ...row,
      wallet,
      tokens: Number.isFinite(tokens) ? tokens : row.tokens,
    };
  }).filter(Boolean);
}

function hasClassicFundingEstimate(estimate) {
  if (!estimate || typeof estimate !== 'object') return false;
  const totalSol = Number(estimate.totalSol);
  if (Number.isFinite(totalSol) && totalSol > 0) return true;
  const solLamports = Number(estimate.solLamports);
  if (Number.isFinite(solLamports) && solLamports > 0) return true;
  return false;
}

function stableFundingFingerprintValue(value) {
  if (Array.isArray(value)) return value.map(stableFundingFingerprintValue);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((record, key) => {
      const stable = stableFundingFingerprintValue(value[key]);
      if (stable !== undefined) record[key] = stable;
      return record;
    }, {});
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' || typeof value === 'boolean' || value === null) return value;
  if (value === undefined) return undefined;
  return String(value);
}

function planIntegrityPayload(plan = {}) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return {};
  const { integrity: _integrity, ...payload } = plan;
  return stableFundingFingerprintValue(payload);
}

export function launchPlanIntegrityDigest(plan = {}) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(planIntegrityPayload(plan)))
    .digest('hex');
}

function launchPlanLogoFingerprint(logo = null) {
  if (!logo || typeof logo !== 'object') return null;
  return {
    name: logo.name || null,
    mimeType: logo.mimeType || logo.type || null,
    sizeBytes: Number.isFinite(Number(logo.sizeBytes ?? logo.size))
      ? Number(logo.sizeBytes ?? logo.size)
      : null,
  };
}

export function launchPlanConfigFingerprint(input = {}) {
  const token = input?.token || {};
  const topology = input?.poolTopology || {};
  return JSON.stringify(stableFundingFingerprintValue({
    experience: input?.experience || null,
    token: {
      name: token.name || null,
      symbol: token.symbol || null,
      supply: normalizeV2TokenSupply(token.supply ?? input.tokenSupply ?? '1000000000'),
      description: token.description || null,
      decimals: token.decimals ?? TOKEN_DECIMALS,
      logo: launchPlanLogoFingerprint(token.logo),
    },
    launchSol: Number.isFinite(Number(input?.launchSol)) ? Number(input.launchSol) : null,
    mode: input?.mode || null,
    vanity: input?.vanity || null,
    poolTopology: topology,
    funding: {
      launchSol: Number.isFinite(Number(input?.funding?.launchSol ?? input?.launchSol))
        ? Number(input.funding?.launchSol ?? input.launchSol)
        : null,
      targetMarketCapUsd: Number.isFinite(Number(input?.funding?.targetMarketCapUsd ?? topology.targetMarketCapUsd))
        ? Number(input?.funding?.targetMarketCapUsd ?? topology.targetMarketCapUsd)
        : null,
    },
  }));
}

export function launchPlanWalletFingerprint(walletPublicKey) {
  return String(walletPublicKey || '').trim() || null;
}

function v2FundingEstimateRequest(input = {}) {
  const rawTopology = input.poolTopology && typeof input.poolTopology === 'object'
    ? input.poolTopology
    : {};
  const topology = normalizePoolTopology(rawTopology);
  const token = input.token && typeof input.token === 'object'
    ? input.token
    : {};
  return {
    allocations: stableFundingFingerprintValue(classicAllocations(topology)),
    targetMarketCapUsd: Number(topology.targetMarketCapUsd || 0),
    publishLaunchReport: topology.report?.publish !== false,
    token: {
      supply: normalizeV2TokenSupply(token.supply ?? input.tokenSupply ?? '1000000000'),
      decimals: TOKEN_DECIMALS,
    },
    preallocation: {
      enabled: topology.preallocation.enabled === true,
      supplyPercent: Number(topology.preallocation.supplyPercent || 0),
      source: topology.preallocation.source || null,
    },
    airdrop: {
      enabled: topology.airdrop.enabled === true,
      recipientCount: Number(topology.airdrop.recipientCount || 0),
      supplyPercent: Number(topology.airdrop.supplyPercent || 0),
      executionCostSol: Number(topology.airdrop.executionCostSol || 0),
    },
  };
}

export function v2FundingEstimateFingerprint(input = {}) {
  return JSON.stringify(stableFundingFingerprintValue(v2FundingEstimateRequest(input)));
}

function v2FundingEstimateMatchesLaunchInput(input = {}, estimate = {}) {
  if (!hasClassicFundingEstimate(estimate)) return false;
  const actual = String(estimate.v2FundingFingerprint || '').trim();
  return Boolean(actual && actual === v2FundingEstimateFingerprint(input));
}

function positiveFinite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function fundingEstimateTotalSol(estimate = {}) {
  const totalSol = positiveFinite(estimate.totalSol, 0);
  if (totalSol > 0) return totalSol;
  const solLamports = positiveFinite(estimate.solLamports, 0);
  return solLamports > 0 ? solLamports / 1_000_000_000 : 0;
}

function parseRawTokenAmount(value) {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) return null;
  try {
    return BigInt(text);
  } catch {
    return null;
  }
}

function addRawRequirement(requirements, mint, amount) {
  const key = String(mint || '').trim();
  const raw = parseRawTokenAmount(amount);
  if (!key || raw == null || raw <= 0n) return;
  requirements.set(key, (requirements.get(key) || 0n) + raw);
}

function walletTokenRawAmount(walletBalance, mint) {
  const key = String(mint || '').trim();
  if (!key) return 0n;
  const raw = parseRawTokenAmount(walletBalance?.tokens?.[key]?.amountRaw);
  return raw == null ? 0n : raw;
}

function fundingQuoteSymbol(estimate = {}, mint) {
  const breakdown = Array.isArray(estimate.quoteBreakdown) ? estimate.quoteBreakdown : [];
  const byBreakdown = breakdown.find((row) => String(row?.mint || '').trim() === mint)?.symbol;
  if (byBreakdown) return byBreakdown;
  const autoPlan = Array.isArray(estimate.autoSwapPlan) ? estimate.autoSwapPlan : [];
  return autoPlan.find((row) => String(row?.quoteMint || '').trim() === mint)?.quoteSymbol || mint.slice(0, 6);
}

function fundingEstimateSolUsd(estimate = {}) {
  return positiveFinite(estimate.solUsd, 0);
}

function solBreakdownAmount(estimate = {}, pattern) {
  const breakdown = Array.isArray(estimate.solBreakdown) ? estimate.solBreakdown : [];
  const row = breakdown.find((item) => pattern.test(String(item?.label || '')));
  return positiveFinite(row?.sol, 0);
}

function completedFundingCreditSol({ estimate, tokenCreated }) {
  if (!tokenCreated) return 0;
  return solBreakdownAmount(estimate, /token creation/i) || COST_TOKEN_CREATE_SOL;
}

function fundingBalanceIssues({
  estimate,
  walletBalance,
  plan,
  tokenCreated = false,
}) {
  if (!walletBalance || typeof walletBalance !== 'object') {
    return [{
      id: 'funding-balance-unverified',
      phase: 'funding',
      title: 'Funding balance not checked',
      detail: 'Trebuchet could not verify the launch wallet balance before live execution.',
    }];
  }

  const walletSol = Number(walletBalance.sol);
  if (!Number.isFinite(walletSol)) {
    return [{
      id: 'funding-balance-unverified',
      phase: 'funding',
      title: 'Funding balance not checked',
      detail: 'The launch wallet balance response did not include a usable SOL balance.',
    }];
  }

  const issues = [];
  const quoteRequirements = new Map();
  const byQuote = estimate?.byQuote && typeof estimate.byQuote === 'object' ? estimate.byQuote : {};
  Object.entries(byQuote).forEach(([mint, rawAmount]) => {
    addRawRequirement(quoteRequirements, mint, rawAmount);
  });

  const autoPlan = Array.isArray(estimate?.autoSwapPlan) ? estimate.autoSwapPlan : [];
  autoPlan.forEach((item) => {
    addRawRequirement(quoteRequirements, item?.quoteMint, item?.minRaw || item?.targetRaw);
  });

  let acquiredAutoSwapCreditSol = 0;
  const remainingAutoRawByMint = new Map();
  autoPlan.forEach((item) => {
    const mint = String(item?.quoteMint || '').trim();
    const minRaw = parseRawTokenAmount(item?.minRaw || item?.targetRaw);
    if (!mint || minRaw == null || minRaw <= 0n) return;
    const available = remainingAutoRawByMint.has(mint)
      ? remainingAutoRawByMint.get(mint)
      : walletTokenRawAmount(walletBalance, mint);
    if (available >= minRaw) {
      remainingAutoRawByMint.set(mint, available - minRaw);
      acquiredAutoSwapCreditSol += positiveFinite(item?.estSolSpend, 0);
    } else {
      remainingAutoRawByMint.set(mint, available);
    }
  });

  const subtotalSol = positiveFinite(estimate?.subtotalSol, 0);
  const baseSolNeeded = subtotalSol > 0 ? subtotalSol : fundingEstimateTotalSol(estimate);
  const completedSol = completedFundingCreditSol({ estimate, tokenCreated });
  const creditedSwapSol = Math.max(
    positiveFinite(estimate?.solCreditedForCompletedSwaps, 0),
    acquiredAutoSwapCreditSol,
  );
  const estimateIncludesAirdrop = estimate?.includesAirdropExecutionCost === true;
  const airdropExecutionSol = estimateIncludesAirdrop
    ? 0
    : positiveFinite(plan?.poolTopology?.airdrop?.executionCostSol, 0);
  const solNeeded = Math.max(0, baseSolNeeded - completedSol - creditedSwapSol) + airdropExecutionSol;
  if (solNeeded > 0 && walletSol + 0.000000001 < solNeeded) {
    issues.push({
      id: 'funding-sol-short',
      phase: 'funding',
      title: 'Launch wallet needs SOL',
      detail: `Wallet has ${walletSol.toFixed(4)} SOL; Classic needs at least ${solNeeded.toFixed(4)} SOL before live execution.`,
    });
  }

  [...quoteRequirements.entries()].forEach(([mint, requiredRaw], index) => {
    const currentRaw = walletTokenRawAmount(walletBalance, mint);
    if (currentRaw >= requiredRaw) return;
    const symbol = fundingQuoteSymbol(estimate, mint);
    issues.push({
      id: `funding-quote-short-${index + 1}`,
      phase: 'funding',
      title: `${symbol} funding short`,
      detail: `Wallet has ${currentRaw.toString()} raw ${symbol}; Classic needs ${requiredRaw.toString()} raw for ${mint}.`,
    });
  });

  return issues;
}

function normalizePoolTopology(input = {}) {
  const fallbackDistribution = [{ sharePercent: 98 }, { sharePercent: 1 }, { sharePercent: 1 }];
  const rawPools = Array.isArray(input.pools) && input.pools.length
    ? input.pools
    : [
      {
        id: 'sol-main',
        quoteToken: 'SOL',
        quoteSymbol: 'SOL',
        supplyPercent: 70,
        ammConfigIndex: 8,
        distribution: fallbackDistribution,
        bootstrap: { mode: 'minimal' },
        ladder: {
          mode: 'simple',
          bandCount: 5,
          supplyPercent: CLASSIC_LADDER_DEFAULT_SUPPLY_PERCENT,
          ceilingMultiplier: CLASSIC_LADDER_DEFAULT_CEILING_MULTIPLIER,
        },
        support: { mode: 'custom', solValue: 0.35, depthPct: 12 },
      },
      {
        id: 'meme-flywheel',
        quoteToken: DEFAULT_MEME_FLYWHEEL_MINT,
        quoteMint: DEFAULT_MEME_FLYWHEEL_MINT,
        quoteSymbol: 'MEME',
        supplyPercent: 10,
        ammConfigIndex: 5,
        distribution: [{ sharePercent: 100 }],
        bootstrap: { mode: 'minimal' },
        ladder: { mode: 'off' },
        support: { mode: 'off' },
      },
    ];
  const pools = rawPools.map((pool, index) => {
    const quoteToken = String(pool.quoteToken || (index === 0 ? 'SOL' : 'USDC')).trim();
    const quoteSymbol = String(pool.quoteSymbol || pool.quoteSymbolOverride || quoteToken).trim().toUpperCase();
    const distribution = normalizeSliceDistribution(pool.distribution || fallbackDistribution);
    const bootstrap = pool.bootstrap?.mode === 'custom'
      ? { mode: 'custom', supplyPercent: normalizePercent(pool.bootstrap.supplyPercent, 0) }
      : { mode: 'minimal' };
    const quoteDecimalsOverride = optionalQuoteDecimals(pool.quoteDecimalsOverride ?? pool.quoteDecimals);
    const quoteUsdOverride = optionalPositiveNumber(pool.quoteUsdOverride ?? pool.quotePriceUsd);
    const quoteCompatibility = pool.quoteCompatibility && typeof pool.quoteCompatibility === 'object'
      ? { ...pool.quoteCompatibility }
      : undefined;
    return {
      id: String(pool.id || `pool-${index + 1}`),
      quoteToken,
      quoteMint: pool.quoteMint || (quoteSymbol === 'USDC' ? DEFAULT_USDC_MINT : null),
      quoteSymbol,
      ...(quoteDecimalsOverride !== undefined ? { quoteDecimalsOverride } : {}),
      ...(quoteUsdOverride !== undefined ? { quoteUsdOverride } : {}),
      ...(pool.quotePriceSource ? { quotePriceSource: String(pool.quotePriceSource) } : {}),
      ...(quoteCompatibility ? { quoteCompatibility } : {}),
      supplyPercent: normalizePercent(pool.supplyPercent, index === 0 ? 70 : 0),
      ammConfigIndex: Math.floor(numeric(pool.ammConfigIndex, quoteSymbol === 'USDC' ? 5 : 8)),
      distribution,
      bootstrap,
      ladder: normalizeLadder(pool.ladder || {}),
      support: normalizeSupport(pool.support || {}),
    };
  }).filter((pool) => pool.supplyPercent > 0);
  const totalPoolPercent = roundSol(pools.reduce((sum, pool) => sum + pool.supplyPercent, 0));
  const airdrop = input.airdrop && input.airdrop.enabled
    ? {
      enabled: true,
      recipientCount: Math.max(0, Math.floor(numeric(input.airdrop.recipientCount, 0))),
      supplyPercent: normalizePercent(input.airdrop.supplyPercent, 2),
      requestedSupplyPercent: normalizePercent(input.airdrop.requestedSupplyPercent ?? input.airdrop.supplyPercent, 2),
      requiredSupplyPercent: normalizePercent(input.airdrop.requiredSupplyPercent, 0),
      autoFit: input.airdrop.autoFit !== false,
      budgetTokens: Math.max(0, numeric(input.airdrop.budgetTokens, 0)),
      explicitTokens: Math.max(0, numeric(input.airdrop.explicitTokens, 0)),
      remainingTokens: Math.max(0, numeric(input.airdrop.remainingTokens, 0)),
      executionCostSol: roundSol(Math.max(
        Math.max(0, numeric(input.airdrop.executionCostSol, 0)),
        estimateAirdropExecutionCostSol(input.airdrop.recipientCount),
      )),
      budgetError: typeof input.airdrop.budgetError === 'string' && input.airdrop.budgetError.trim()
        ? input.airdrop.budgetError.trim()
        : null,
      parseError: typeof input.airdrop.parseError === 'string' && input.airdrop.parseError.trim()
        ? input.airdrop.parseError.trim()
        : null,
      parseErrorCount: Math.max(0, Math.floor(numeric(input.airdrop.parseErrorCount, 0))),
      source: String(input.airdrop.source || 'csv-or-manual'),
      recipients: normalizeAirdropRows(input.airdrop.recipients),
    }
    : { enabled: false, recipientCount: 0, supplyPercent: 0, source: 'off', recipients: [] };
  const preallocationSupplyPercent = normalizePercent(input.preallocation?.supplyPercent, 0);
  const preallocation = preallocationSupplyPercent > 0
    ? {
      enabled: true,
      supplyPercent: preallocationSupplyPercent,
      source: String(input.preallocation?.source || 'held-reserve'),
    }
    : { enabled: false, supplyPercent: 0, source: 'off' };
  const heldReservePercent = preallocation.supplyPercent + airdrop.supplyPercent;
  return {
    targetMarketCapUsd: Math.max(0, numeric(input.targetMarketCapUsd, 250000)),
    pools,
    allocations: classicAllocations({ pools }),
    totalPoolPercent,
    reservePercent: normalizePercent(input.reservePercent ?? (100 - totalPoolPercent - heldReservePercent), 0),
    preallocation,
    airdrop,
    feeKeyRecipient: typeof input.feeKeyRecipient === 'string' && input.feeKeyRecipient.trim() ? input.feeKeyRecipient.trim() : null,
    sweepDestination: typeof input.sweepDestination === 'string' && input.sweepDestination.trim() ? input.sweepDestination.trim() : null,
    report: {
      publish: input.report?.publish !== false,
      download: true,
    },
    roundTo100: input.roundTo100 !== false,
  };
}

function normalizeVanity(input = {}) {
  const { prefix, suffix } = normalizeVanityTargetBase58(input.prefix, input.suffix);
  const selectedPublicKey = String(input.selectedPublicKey || '').trim() || null;
  if (selectedPublicKey && !SOLANA_ADDRESS_RE.test(selectedPublicKey)) {
    throw new Error('Selected Vanity CA public key does not look like a valid Solana address');
  }
  if (selectedPublicKey && prefix && !selectedPublicKey.startsWith(prefix)) {
    throw new Error(`Selected Vanity CA does not start with ${prefix}`);
  }
  if (selectedPublicKey && suffix && !selectedPublicKey.endsWith(suffix)) {
    throw new Error(`Selected Vanity CA does not end with ${suffix}`);
  }
  return {
    mode: prefix && suffix ? 'both' : prefix ? 'prefix' : suffix ? 'suffix' : 'random',
    prefix,
    suffix,
    selectedPublicKey,
    candidateCount: Math.max(0, Math.floor(numeric(input.candidateCount, 0))),
  };
}

function normalizeTokenLogo(input = null) {
  if (!input || typeof input !== 'object') return null;
  const dataUrl = String(input.dataUrl || '').trim();
  const match = dataUrl.match(LOGO_DATA_URL_RE);
  if (!match) throw new Error('Token logo must be a PNG or JPG data URL');
  const decoded = Buffer.from(match[2], 'base64');
  const sizeBytes = decoded.length;
  if (sizeBytes <= 0 || sizeBytes > MAX_LOGO_BYTES) {
    throw new Error('Token logo must be 100KB or smaller');
  }
  const detectedMime = normalizeLogoImageMime(decoded);
  const dimensions = detectLogoImageDimensions(decoded);
  if (!dimensions) {
    throw new Error('Token logo dimensions could not be read');
  }
  if (dimensions.width > MAX_LOGO_DIMENSION || dimensions.height > MAX_LOGO_DIMENSION) {
    throw new Error(
      `Token logo is ${dimensions.width}x${dimensions.height}px; max is ` +
        `${MAX_LOGO_DIMENSION}x${MAX_LOGO_DIMENSION}px`,
    );
  }
  if (dimensions.width < MIN_LOGO_DIMENSION || dimensions.height < MIN_LOGO_DIMENSION) {
    throw new Error(
      `Token logo is ${dimensions.width}x${dimensions.height}px; minimum is ` +
        `${MIN_LOGO_DIMENSION}x${MIN_LOGO_DIMENSION}px`,
    );
  }
  return {
    name: String(input.name || 'token-logo').trim().slice(0, 120),
    mimeType: detectedMime,
    sizeBytes,
    dataUrl: `data:${detectedMime};base64,${decoded.toString('base64')}`,
  };
}

function normalizeAirdropRecipients(input = {}, context = {}) {
  if (Array.isArray(context.airdropRecipients)) return normalizeAirdropRows(context.airdropRecipients);
  if (Array.isArray(context.airdrop?.recipients)) return normalizeAirdropRows(context.airdrop.recipients);
  if (Array.isArray(input.poolTopology?.airdrop?.recipients)) return normalizeAirdropRows(input.poolTopology.airdrop.recipients);
  return [];
}

function classicAllocations(poolTopology) {
  return poolTopology.pools.map((pool) => ({
    quoteToken: pool.quoteToken,
    quoteMint: pool.quoteMint || undefined,
    supplyPercent: pool.supplyPercent,
    ammConfigIndex: pool.ammConfigIndex,
    quoteUsdOverride: pool.quoteUsdOverride,
    quoteDecimalsOverride: pool.quoteDecimalsOverride,
    quoteSymbolOverride: pool.quoteSymbol,
    distribution: pool.distribution,
    bootstrap: pool.bootstrap,
    ladder: pool.ladder,
    support: pool.support,
  }));
}

function poolQuoteIdentity(pool = {}) {
  const mint = String(pool.quoteMint || '').trim();
  const token = String(pool.quoteToken || '').trim();
  const symbol = String(pool.quoteSymbol || pool.quoteSymbolOverride || '').trim();
  const raw = mint || token || symbol;
  if (!raw) return '';
  const upper = raw.toUpperCase();
  if (raw === DEFAULT_SOL_MINT || upper === 'SOL') return 'SOL';
  if (raw === DEFAULT_USDC_MINT || upper === 'USDC') return 'USDC';
  if (upper === 'USDT') return 'USDT';
  if (!mint && symbol && token && symbol.toUpperCase() === token.toUpperCase()) {
    return symbol.toUpperCase();
  }
  if (!mint && !token && symbol) return symbol.toUpperCase();
  return raw;
}

function poolQuoteLabel(pool = {}) {
  return String(pool.quoteSymbol || pool.quoteToken || pool.quoteMint || 'quote').trim() || 'quote';
}

function duplicatePoolRouteIssues(pools = []) {
  const seen = new Map();
  const issues = [];
  pools.forEach((pool, index) => {
    if (Number(pool.supplyPercent || 0) <= 0) return;
    const quote = poolQuoteIdentity(pool);
    if (!quote) return;
    const feeTier = Math.floor(numeric(pool.ammConfigIndex, 0));
    const key = `${quote}|${feeTier}`;
    if (seen.has(key)) {
      const firstIndex = seen.get(key);
      const label = poolQuoteLabel(pool);
      issues.push({
        index,
        firstIndex,
        label,
        feeTier,
        detail: `Pool ${index + 1} duplicates Pool ${firstIndex + 1} (same ${label} quote at the same fee tier). Pick a different quote or a different fee tier - Raydium uses both to identify a pool.`,
      });
      return;
    }
    seen.set(key, index);
  });
  return issues;
}

function isKnownClassicQuote(pool = {}) {
  const identity = poolQuoteIdentity(pool);
  if (['SOL', 'USDC', 'USDT'].includes(identity)) return true;
  const mint = String(pool.quoteMint || '').trim();
  const token = String(pool.quoteToken || '').trim();
  return KNOWN_CLASSIC_QUOTE_MINTS.has(mint) || KNOWN_CLASSIC_QUOTE_MINTS.has(token);
}

function quoteTokenSafetyIssues(pools = []) {
  const issues = [];
  pools.forEach((pool, index) => {
    if (Number(pool.supplyPercent || 0) <= 0) return;
    if (isKnownClassicQuote(pool)) return;
    const label = poolQuoteLabel(pool);
    const quoteRef = String(pool.quoteMint || pool.quoteToken || '').trim();
    const info = pool.quoteCompatibility && typeof pool.quoteCompatibility === 'object'
      ? pool.quoteCompatibility
      : null;

    if (!quoteRef) {
      issues.push({
        index,
        state: 'danger',
        blocksFreshLive: true,
        detail: `Pool ${index + 1} (${label}) needs a quote mint before Classic can verify Raydium compatibility.`,
      });
      return;
    }
    if (!info) {
      issues.push({
        index,
        state: 'warn',
        blocksFreshLive: true,
        detail: `Pool ${index + 1} (${label}) has not run the Classic quote-token safety check yet.`,
      });
      return;
    }
    if (info.compatible === false) {
      issues.push({
        index,
        state: 'danger',
        blocksFreshLive: true,
        detail: `Pool ${index + 1} (${label}) quote token is not compatible with Raydium CLMM launch requirements.`,
      });
    }
    if (info.freezeAuthorityBlock === true) {
      issues.push({
        index,
        state: 'danger',
        blocksFreshLive: true,
        detail: `Pool ${index + 1} (${label}) quote token has a freeze-authority risk that can strand launch-wallet balances.`,
      });
    }
    if (String(info.raydiumTradeable || '').toLowerCase() === 'no') {
      issues.push({
        index,
        state: 'danger',
        blocksFreshLive: true,
        detail: `Pool ${index + 1} (${label}) quote token did not pass the Raydium route probe.`,
      });
    }
    if (
      info.compatible == null
      || info.freezeAuthorityBlock == null
      || !info.raydiumTradeable
      || String(info.raydiumTradeable).toLowerCase() === 'unknown'
    ) {
      issues.push({
        index,
        state: 'warn',
        blocksFreshLive: true,
        detail: `Pool ${index + 1} (${label}) quote-token compatibility, authority, or route status is incomplete. Re-run Verify quote before live execution.`,
      });
    }
    if (info.mintAuthorityWarning === true) {
      issues.push({
        index,
        state: 'warn',
        blocksFreshLive: false,
        detail: `Pool ${index + 1} (${label}) quote token still has mint authority enabled; supply can be inflated.`,
      });
    }
  });
  return issues;
}

function isPlausibleSolanaAddress(value) {
  return SOLANA_ADDRESS_RE.test(String(value || '').trim());
}

function feeKeyRecipientIssues(pools = []) {
  const issues = [];
  pools.forEach((pool, poolIndex) => {
    const distribution = Array.isArray(pool.distribution) ? pool.distribution : [];
    distribution.forEach((slice, sliceIndex) => {
      const recipient = String(slice?.recipient || '').trim();
      if (!recipient) return;
      if (isPlausibleSolanaAddress(recipient)) return;
      issues.push({
        poolIndex,
        sliceIndex,
        recipient,
        detail: `Pool ${poolIndex + 1} slice ${sliceIndex + 1}: Fee Key recipient does not look like a valid Solana address.`,
      });
    });
  });
  return issues;
}

function sweepDestinationIssues(poolTopology = {}) {
  const destination = String(poolTopology.sweepDestination || '').trim();
  if (!destination || isPlausibleSolanaAddress(destination)) return [];
  return [{
    detail: 'Sweep destination does not look like a valid Solana address.',
  }];
}

function airdropRecipientIssues(airdrop = {}) {
  if (!airdrop.enabled) return [];
  const issues = [];
  if (airdrop.parseError) {
    issues.push({
      detail: `Airdrop CSV has an error: ${airdrop.parseError}`,
    });
  }
  if (airdrop.budgetError) {
    issues.push({
      detail: `Airdrop budget is invalid: ${airdrop.budgetError}`,
    });
  }
  const seen = new Set();
  const recipients = Array.isArray(airdrop.recipients) ? airdrop.recipients : [];
  recipients.forEach((row, index) => {
    const wallet = String(row?.wallet || row?.recipient || '').trim();
    const tokens = Number(row?.tokens ?? row?.amount);
    if (!wallet || !isPlausibleSolanaAddress(wallet)) {
      issues.push({
        index,
        detail: `Airdrop recipient ${index + 1}: wallet does not look like a valid Solana address.`,
      });
      return;
    }
    if (seen.has(wallet)) {
      issues.push({
        index,
        detail: `Airdrop recipient ${index + 1}: duplicate wallet ${wallet.slice(0, 8)}...`,
      });
    }
    seen.add(wallet);
    if (!Number.isFinite(tokens) || tokens <= 0) {
      issues.push({
        index,
        detail: `Airdrop recipient ${index + 1}: token amount must be greater than 0.`,
      });
    }
  });
  return issues;
}

function airdropRecipientCountIssue(airdrop = {}, recipients = []) {
  if (!airdrop.enabled) return null;
  const expected = Math.max(0, Math.floor(Number(airdrop.recipientCount || 0)));
  if (expected <= 0 || recipients.length === 0 || recipients.length === expected) return null;
  return {
    expected,
    actual: recipients.length,
    detail: `Airdrop declares ${expected} recipient${expected === 1 ? '' : 's'}, but ${recipients.length} executable row${recipients.length === 1 ? ' is' : 's are'} attached.`,
  };
}

function totalSupportSol(pools = []) {
  return pools.reduce((sum, pool) => {
    const support = pool.support || {};
    if (support.mode !== 'custom') return sum;
    return sum + positiveFinite(support.solValue, 0);
  }, 0);
}

function formatPlanUsd(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '$0';
  return `$${Math.round(number).toLocaleString('en-US')}`;
}

function formatPlanSol(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return '0 SOL';
  return `${number.toFixed(number >= 10 ? 2 : 3)} SOL`;
}

function formatPlanPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '0%';
  return `${number.toFixed(number % 1 === 0 ? 0 : 1)}%`;
}

function airdropSupportBackingStatus(plan = {}, estimate = {}) {
  const topology = plan.poolTopology || {};
  const preallocation = topology.preallocation || {};
  const preallocationPercent = Math.max(0, Number(preallocation.supplyPercent || 0));
  const airdrop = topology.airdrop || {};
  const airdropPercent = Math.max(
    0,
    Number(airdrop.supplyPercent || 0),
    Number(airdrop.requiredSupplyPercent || 0),
  );
  const heldReservePercent = preallocationPercent + (airdrop.enabled ? airdropPercent : 0);
  if (heldReservePercent <= 0) {
    return {
      required: false,
      state: 'pass',
      detail: 'No held reserve needs support backing.',
    };
  }

  const supportSol = totalSupportSol(topology.pools);
  const targetMarketCapUsd = positiveFinite(topology.targetMarketCapUsd, 0);
  const solUsd = fundingEstimateSolUsd(estimate);
  if (targetMarketCapUsd <= 0) {
    return {
      required: true,
      state: 'warn',
      detail: 'Target market cap is required before Trebuchet can size held-reserve support backing.',
      supportSol,
    };
  }
  if (solUsd <= 0) {
    return {
      required: true,
      state: supportSol > 0 ? 'warn' : 'danger',
      detail: supportSol > 0
        ? 'Run the Classic funding estimate so Trebuchet can verify the held reserve is backed by equal-value support liquidity.'
        : 'Held reserve has no support position backing it. Add support liquidity before live execution.',
      supportSol,
    };
  }

  const reserveUsd = targetMarketCapUsd * heldReservePercent / 100;
  const requiredSupportSol = reserveUsd / solUsd;
  const supportUsd = supportSol * solUsd;
  const coverage = requiredSupportSol > 0 ? supportSol / requiredSupportSol : 1;
  if (coverage >= 0.995) {
    return {
      required: true,
      state: 'pass',
      detail: `Held reserve ${formatPlanPercent(heldReservePercent)} (${formatPlanUsd(reserveUsd)}) is backed by ${formatPlanSol(supportSol)} of support liquidity.`,
      supportSol,
      supportUsd,
      requiredSupportSol,
      reserveUsd,
      coverage,
    };
  }

  const shortSol = Math.max(0, requiredSupportSol - supportSol);
  const supportDetail = supportSol > 0
    ? `support backs ${formatPlanSol(supportSol)} (${formatPlanUsd(supportUsd)})`
    : 'support is off';
  return {
    required: true,
    state: 'danger',
    detail: `Held reserves ${formatPlanPercent(heldReservePercent)} of supply (${formatPlanUsd(reserveUsd)}), but ${supportDetail}. Add at least ${formatPlanSol(shortSol)} total support or lower the prealloc/airdrop budget.`,
    supportSol,
    supportUsd,
    requiredSupportSol,
    reserveUsd,
    coverage,
  };
}

function setPlanGuardrail(plan, id, patch) {
  const guardrails = Array.isArray(plan.guardrails) ? plan.guardrails : [];
  const index = guardrails.findIndex((item) => item.id === id);
  if (index >= 0) {
    guardrails[index] = { ...guardrails[index], ...patch };
  } else {
    guardrails.push({ id, ...patch });
  }
  plan.guardrails = guardrails;
}

function rpcUrlFromContext(context = {}) {
  return String(
    context.rpc?.activeUrl
      || context.rpc?.url
      || context.rpcActiveUrl
      || context.rpcUrl
      || context.rpcConfig?.active
      || '',
  ).trim();
}

function isPublicRpcUrl(value) {
  try {
    const host = new URL(value).hostname.toLowerCase().replace(/^www\./, '');
    return PUBLIC_RPC_HOSTS.has(host);
  } catch {
    return false;
  }
}

function rpcPostureStatus(context = {}) {
  const activeUrl = rpcUrlFromContext(context);
  if (!activeUrl) {
    return {
      id: 'rpc-not-loaded',
      state: 'warn',
      title: 'RPC endpoint unknown',
      detail: 'Trebuchet could not verify the active RPC endpoint for this readiness pass.',
      activeUrl: null,
      isPublic: false,
    };
  }
  if (isPublicRpcUrl(activeUrl)) {
    return {
      id: 'rpc-public-endpoint',
      state: 'danger',
      title: 'Dedicated RPC required',
      detail: 'The active RPC is a public Solana endpoint. Save and select a dedicated mainnet RPC before starting fresh live execution.',
      activeUrl,
      isPublic: true,
    };
  }
  return {
    id: 'rpc-dedicated',
    state: 'pass',
    title: 'Dedicated RPC selected',
    detail: 'Active RPC is not one of the known public Solana endpoints.',
    activeUrl,
    isPublic: false,
  };
}

function ladderRouteIssues(pools = []) {
  const issues = [];
  pools.forEach((pool, index) => {
    if (Number(pool.supplyPercent || 0) <= 0) return;
    const ladder = pool.ladder || { mode: 'off' };
    const poolLabel = `Pool ${index + 1}`;
    if (ladder.mode === 'off' || !ladder.mode) return;
    if (ladder.mode === 'simple') {
      const bandCount = Number(ladder.bandCount);
      const supplyPercent = Number(ladder.supplyPercent);
      const ceilingMultiplier = Number(ladder.ceilingMultiplier);
      if (!Number.isInteger(bandCount) || bandCount < 2 || bandCount > CLASSIC_LADDER_MAX_BANDS) {
        issues.push({
          index,
          detail: `${poolLabel}: simple ladder needs 2-${CLASSIC_LADDER_MAX_BANDS} bands for the Classic LP executor.`,
        });
      }
      if (!Number.isFinite(supplyPercent) || supplyPercent <= 0 || supplyPercent > 100) {
        issues.push({
          index,
          detail: `${poolLabel}: simple ladder supply percent must be greater than 0 and no more than 100.`,
        });
      }
      if (!Number.isFinite(ceilingMultiplier) || ceilingMultiplier <= 1) {
        issues.push({
          index,
          detail: `${poolLabel}: simple ladder ceiling multiplier must be greater than 1.`,
        });
      }
      return;
    }
    if (ladder.mode === 'manual') {
      if (!Array.isArray(ladder.bands) || ladder.bands.length === 0) {
        issues.push({ index, detail: `${poolLabel}: manual ladder needs at least one band.` });
        return;
      }
      if (ladder.bands.length > CLASSIC_LADDER_MAX_BANDS) {
        issues.push({
          index,
          detail: `${poolLabel}: manual ladder has ${ladder.bands.length} bands; Classic supports at most ${CLASSIC_LADDER_MAX_BANDS}.`,
        });
      }
      const total = ladder.bands.reduce((sum, band) => sum + Number(band.supplyPercent || 0), 0);
      ladder.bands.forEach((band, bandIndex) => {
        const supplyPercent = Number(band.supplyPercent);
        const lowerMultiplier = Number(band.lowerMultiplier);
        const upperMultiplier = Number(band.upperMultiplier);
        if (!Number.isFinite(supplyPercent) || supplyPercent <= 0 || supplyPercent > 100) {
          issues.push({
            index,
            detail: `${poolLabel} ladder band ${bandIndex + 1}: supply percent must be greater than 0 and no more than 100.`,
          });
        }
        if (!Number.isFinite(lowerMultiplier) || lowerMultiplier < 1) {
          issues.push({
            index,
            detail: `${poolLabel} ladder band ${bandIndex + 1}: lower multiplier must be at least 1.`,
          });
        }
        if (!Number.isFinite(upperMultiplier) || upperMultiplier <= lowerMultiplier) {
          issues.push({
            index,
            detail: `${poolLabel} ladder band ${bandIndex + 1}: upper multiplier must be greater than lower multiplier.`,
          });
        }
      });
      if (total > 100.001) {
        issues.push({
          index,
          detail: `${poolLabel}: manual ladder bands sum to ${total.toFixed(2)}%; Classic requires 100% or less.`,
        });
      }
      return;
    }
    issues.push({
      index,
      detail: `${poolLabel}: ladder mode must be off, simple, or manual.`,
    });
  });
  return issues;
}

function readinessIssue({ id, phase, title, detail, severity = 'blocker' }) {
  return { id, phase, title, detail, severity };
}

function readinessPhase({
  id,
  title,
  endpoint,
  method = 'POST',
  state,
  detail,
  blockerIds = [],
}) {
  return {
    id,
    title,
    endpoint,
    method,
    state,
    detail,
    blockerIds,
  };
}

function airdropPayload({ enabled, recipientCount, recipients, tokenMint, tokenDecimals }) {
  if (!enabled || !tokenMint || !Array.isArray(recipients) || recipients.length === 0) {
    return null;
  }
  return {
    tokenMint,
    tokenDecimals,
    recipientCount: Math.max(0, Math.floor(Number(recipientCount || recipients.length))),
    recipients,
  };
}

function operation({
  id,
  stage,
  label,
  risk,
  costSol,
  effects,
  checks = [],
  requires = [],
}) {
  return {
    id,
    kind: 'local-wallet-operation',
    source: 'v2-launch-plan',
    signer: 'trebuchet-managed-launch-wallet',
    authorization: {
      type: 'run-envelope',
      requiredUserAction: 'fund-and-arm',
    },
    stage,
    label,
    risk,
    costSol: roundSol(costSol),
    state: 'pending',
    effects,
    checks,
    requires,
    simulation: {
      status: 'ready',
      balanceChanges: [],
      decoded: true,
    },
  };
}

function planId({ symbol, supply, mode }) {
  return `v2-${symbol.toLowerCase()}-${supply}-${mode}`;
}

export function buildV2LaunchPlan(input = {}, options = {}) {
  const tokenInput = input.token || {};
  const name = normalizeTokenName(tokenInput.name ?? input.tokenName ?? 'Untitled');
  const symbol = normalizeTokenSymbol(tokenInput.symbol ?? input.tokenSymbol ?? 'TOK').toUpperCase();
  const supply = normalizeV2TokenSupply(tokenInput.supply ?? input.tokenSupply ?? '1000000000');
  const description = normalizeTokenDescription(tokenInput.description ?? input.tokenDescription ?? '');
  const logo = normalizeTokenLogo(tokenInput.logo || input.logo || null);
  const launchSol = normalizeLaunchSol(input.launchSol ?? input.funding?.launchSol ?? 0);
  const mode = normalizeMode(input.mode);
  const vanity = normalizeVanity(input.vanity || {});
  const poolTopology = normalizePoolTopology(input.poolTopology || {});
  const recovery = {
    activeJournalCount: Math.max(0, Math.floor(numeric(input.recovery?.activeJournalCount, 0))),
    failedJournalCount: Math.max(0, Math.floor(numeric(input.recovery?.failedJournalCount, 0))),
    pendingWalletCount: Math.max(0, Math.floor(numeric(input.recovery?.pendingWalletCount, 0))),
  };
  const demoMode = options.demoMode === true;
  const now = options.now || new Date().toISOString();
  const poolCount = Math.max(1, poolTopology.pools.length);
  const sliceCount = poolTopology.pools.reduce((sum, pool) => sum + pool.distribution.length, 0);
  const ladderBandCount = poolTopology.pools.reduce((sum, pool) => {
    if (pool.ladder.mode === 'simple') return sum + pool.ladder.bandCount;
    if (pool.ladder.mode === 'manual') return sum + pool.ladder.bands.length;
    return sum;
  }, 0);
  const supportCount = poolTopology.pools.filter((pool) => pool.support.mode === 'custom').length;
  const feeKeyTransferCount = poolTopology.pools.reduce(
    (sum, pool) => sum + pool.distribution.filter((slice) => slice.recipient).length,
    0,
  );
  const nonSolPoolCount = poolTopology.pools.filter((pool) => pool.quoteSymbol !== 'SOL').length;
  const duplicatePoolRoutes = duplicatePoolRouteIssues(poolTopology.pools);
  const quoteSafetyRoutes = quoteTokenSafetyIssues(poolTopology.pools);
  const feeKeyRecipientRoutes = feeKeyRecipientIssues(poolTopology.pools);
  const sweepDestinationRoutes = sweepDestinationIssues(poolTopology);
  const airdropRecipientRoutes = airdropRecipientIssues(poolTopology.airdrop);
  const ladderRoutes = ladderRouteIssues(poolTopology.pools);
  const poolCost = (poolCount * COST_POOL_RENT_SOL) + COST_TX_BUFFER_SOL;
  const lockCost = launchSol
    + ((sliceCount + ladderBandCount + supportCount + poolCount) * (COST_POSITION_SOL + COST_LOCK_SOL))
    + (feeKeyTransferCount * COST_TRANSFER_SOL)
    + (nonSolPoolCount > 0 ? COST_BS_QUOTE_SOL : 0)
    + COST_TX_BUFFER_SOL;
  const reportCost = COST_LAUNCH_REPORT_SOL
    + COST_TX_BUFFER_SOL
    + poolTopology.airdrop.executionCostSol;
  const supplyUsed = roundSol(
    poolTopology.totalPoolPercent
      + poolTopology.preallocation.supplyPercent
      + poolTopology.airdrop.supplyPercent,
  );

  const operations = [
    operation({
      id: 'v2-wallet-and-ca',
      stage: 'config',
      label: 'Prepare wallet and Vanity CA',
      risk: 'Low',
      costSol: 0,
      effects: [
        'Uses Trebuchet-managed launch wallet as signer',
        vanity.mode === 'random'
          ? 'Uses random mint address unless a Vanity CA is selected'
          : `Targets Vanity CA ${vanity.mode} pattern ${vanity.prefix || '*'}...${vanity.suffix || '*'}`,
        `Keeps ${vanity.candidateCount} saved Vanity CA option${vanity.candidateCount === 1 ? '' : 's'} available`,
      ],
      checks: ['wallet', 'pin', 'vanity-ca'],
    }),
    operation({
      id: 'v2-funding-check',
      stage: 'fund',
      label: 'Estimate funding and quote acquire',
      risk: launchSol > 0 ? 'Medium' : 'Low',
      // Funding reserves capital in the managed wallet; that same launch SOL
      // is spent once when liquidity opens. Excluding it here prevents the
      // envelope maximum from counting the reserve twice.
      costSol: 0,
      effects: [
        `Reserves ${launchSol.toFixed(3)} SOL for launch liquidity`,
        `${poolCount} pool${poolCount === 1 ? '' : 's'} / ${nonSolPoolCount} quote-token acquire path${nonSolPoolCount === 1 ? '' : 's'}`,
        'Includes rent, transaction buffer, bootstrap, support, and report costs',
        demoMode ? 'Demo mode keeps all funding simulated' : 'Real launch requires funding the Trebuchet-managed launch wallet',
      ],
      checks: ['launch-sol', 'rent-buffer', 'rpc-health'],
    }),
    operation({
      id: 'v2-mint-metadata',
      stage: 'mint',
      label: 'Create mint and metadata',
      risk: 'Low',
      costSol: COST_TOKEN_CREATE_SOL + COST_TX_BUFFER_SOL,
      effects: [
        `Creates ${symbol} SPL mint`,
        description ? `Uploads metadata payload: ${description.slice(0, 80)}` : 'Uploads metadata payload',
        logo ? `Attaches token logo ${logo.name}` : 'Uses generated symbol mark until a logo is attached',
        'Creates launch vault token account',
      ],
      checks: ['metadata-uri', 'mint-rent', 'ata'],
      requires: ['v2-wallet-and-ca', 'v2-funding-check'],
    }),
    operation({
      id: 'v2-revoke-authorities',
      stage: 'mint',
      label: 'Revoke authorities',
      risk: 'Medium',
      costSol: COST_TX_BUFFER_SOL,
      effects: [
        'Revokes mint authority',
        'Revokes freeze authority',
        'Locks or discloses metadata authority posture',
      ],
      checks: ['mint-authority', 'freeze-authority', 'metadata-authority'],
      requires: ['v2-mint-metadata'],
    }),
    operation({
      id: 'v2-create-liquidity-pools',
      stage: 'liquidity',
      label: 'Create liquidity pools',
      risk: 'High',
      costSol: poolCost,
      effects: [
        'Creates Raydium CLMM pool accounts',
        `Plans ${poolTopology.pools.map((pool) => `${pool.quoteSymbol} ${pool.supplyPercent}%`).join(', ')}`,
        'Records pool checkpoint before positions open',
      ],
      checks: ['pool-rent', 'quote-venue', 'checkpoint'],
      requires: ['v2-revoke-authorities'],
    }),
    operation({
      id: 'v2-lock-liquidity',
      stage: 'liquidity',
      label: 'Open, lock, and transfer Fee Keys',
      risk: 'Medium',
      costSol: lockCost,
      effects: [
        `Opens ${sliceCount} main slice${sliceCount === 1 ? '' : 's'}, ${ladderBandCount} ladder band${ladderBandCount === 1 ? '' : 's'}, ${supportCount} support position${supportCount === 1 ? '' : 's'}`,
        'Locks positions with Burn & Earn',
        feeKeyTransferCount ? `Transfers ${feeKeyTransferCount} Fee Key mint${feeKeyTransferCount === 1 ? '' : 's'} to configured recipients` : 'Records Fee Key mints for local recovery',
      ],
      checks: ['price-band', 'burn-and-earn', 'fee-key-records'],
      requires: ['v2-create-liquidity-pools'],
    }),
    operation({
      id: 'v2-report-sweep',
      stage: 'sweep',
      label: 'Prepare report and sweep',
      risk: 'Low',
      costSol: reportCost,
      effects: [
        poolTopology.airdrop.enabled
          ? `Queues airdrop for ${poolTopology.airdrop.recipientCount} recipient${poolTopology.airdrop.recipientCount === 1 ? '' : 's'}`
          : 'Skips airdrop unless recipients are provided',
        'Builds launch report envelope',
        poolTopology.sweepDestination ? 'Queues final sweep to configured destination' : 'Requires destination verification before final sweep',
      ],
      checks: ['airdrop-plan', 'report-envelope', 'fee-key-records', 'sweep-destination'],
      requires: ['v2-lock-liquidity'],
    }),
  ];

  const estimatedSolCost = roundSol(
    operations.reduce((total, item) => total + item.costSol, 0),
  );
  const airdropBackingPreview = airdropSupportBackingStatus(
    { poolTopology },
    input.funding?.estimate || {},
  );

  const plan = {
    schema: TREBUCHET_PLAN_SCHEMA,
    protocolVersion: TREBUCHET_CORE_PROTOCOL_VERSION,
    contractVersion: CONTRACT_VERSION,
    id: planId({ symbol, supply, mode }),
    source: 'local-api',
    runtime: demoMode ? 'demo' : 'local',
    mode,
    experience: input?.experience || null,
    generatedAt: now,
    v2LaunchConfigFingerprint: launchPlanConfigFingerprint(input),
    v2LaunchWalletFingerprint: launchPlanWalletFingerprint(input.walletPublicKey),
    token: {
      name,
      symbol,
      supply,
      decimals: TOKEN_DECIMALS,
      description,
      logo,
    },
    vanity,
    poolTopology,
    recovery,
    funding: {
      launchSol,
      estimatedSolCost,
      publishReportCostSol: roundSol(COST_LAUNCH_REPORT_SOL),
    },
    guardrails: [
      {
        id: 'metadata-valid',
        title: 'Metadata valid',
        detail: `${name} / ${symbol} fits Solana metadata limits.`,
        state: 'pass',
      },
      {
        id: 'demo-runtime',
        title: demoMode ? 'Demo runtime' : 'Local runtime',
        detail: demoMode
          ? 'The staged bundle is safe to inspect without sending transactions.'
          : 'Trebuchet will sign from its encrypted local launch wallet after the user arms the run envelope.',
        state: demoMode ? 'pass' : 'warn',
      },
      {
        id: 'classic-pool-model',
        title: 'Classic pool topology',
        detail: supplyUsed > 100
          ? `Pools, preallocation, and airdrop reserve use ${supplyUsed.toFixed(2)}% of supply.`
          : `${poolCount} pool${poolCount === 1 ? '' : 's'}, ${sliceCount} main slice${sliceCount === 1 ? '' : 's'}, ${ladderBandCount} ladder band${ladderBandCount === 1 ? '' : 's'}, ${supportCount} support position${supportCount === 1 ? '' : 's'}.`,
        state: poolTopology.totalPoolPercent > 0 && supplyUsed <= 100 ? 'pass' : 'danger',
      },
      {
        id: 'classic-pool-identities',
        title: 'Pool identities',
        detail: duplicatePoolRoutes.length
          ? duplicatePoolRoutes[0].detail
          : 'Each pool has a unique quote token and CLMM fee tier route.',
        state: duplicatePoolRoutes.length ? 'danger' : 'pass',
      },
      {
        id: 'classic-quote-safety',
        title: 'Quote-token safety',
        detail: quoteSafetyRoutes.length
          ? quoteSafetyRoutes[0].detail
          : 'Quote tokens are built-in or have completed the Classic safety probe.',
        state: quoteSafetyRoutes.some((issue) => issue.state === 'danger')
          ? 'danger'
          : quoteSafetyRoutes.length ? 'warn' : 'pass',
      },
      {
        id: 'classic-fee-key-recipients',
        title: 'Fee Key recipients',
        detail: feeKeyRecipientRoutes.length
          ? feeKeyRecipientRoutes[0].detail
          : 'Any external Fee Key recipients are plausible Solana addresses.',
        state: feeKeyRecipientRoutes.length ? 'danger' : 'pass',
      },
      {
        id: 'classic-ladder-contract',
        title: 'Ladder contract',
        detail: ladderRoutes.length
          ? ladderRoutes[0].detail
          : 'Ladder payloads match the Classic LP executor wire contract.',
        state: ladderRoutes.length ? 'danger' : 'pass',
      },
      {
        id: 'classic-sweep-destination',
        title: 'Sweep destination',
        detail: sweepDestinationRoutes.length
          ? sweepDestinationRoutes[0].detail
          : poolTopology.sweepDestination
            ? 'Sweep destination is a plausible Solana address.'
            : 'Sweep destination can be set before final transfer.',
        state: sweepDestinationRoutes.length ? 'danger' : poolTopology.sweepDestination ? 'pass' : 'warn',
      },
      {
        id: 'classic-airdrop-recipients',
        title: 'Airdrop recipients',
        detail: airdropRecipientRoutes.length
          ? airdropRecipientRoutes[0].detail
          : poolTopology.airdrop.enabled
            ? `${poolTopology.airdrop.recipientCount} airdrop recipient${poolTopology.airdrop.recipientCount === 1 ? '' : 's'} configured.`
            : 'Airdrop is off.',
        state: airdropRecipientRoutes.length ? 'danger' : poolTopology.airdrop.enabled ? 'pass' : 'warn',
      },
      {
        id: 'classic-airdrop-backing',
        title: 'Held reserve support backing',
        detail: airdropBackingPreview.detail,
        state: airdropBackingPreview.state,
      },
      {
        id: 'vanity-ca-options',
        title: 'Vanity CA options',
        detail: vanity.mode === 'random'
          ? 'No Vanity CA pattern selected; random CA remains available.'
          : `${vanity.mode} pattern preserved with ${vanity.candidateCount} saved option${vanity.candidateCount === 1 ? '' : 's'}.`,
        state: vanity.mode === 'random' || vanity.candidateCount > 0 ? 'pass' : 'warn',
      },
      {
        id: 'recovery-inventory',
        title: 'Recovery inventory',
        detail: `${recovery.activeJournalCount} active journal${recovery.activeJournalCount === 1 ? '' : 's'}, ${recovery.failedJournalCount} failed, ${recovery.pendingWalletCount} pending wallet${recovery.pendingWalletCount === 1 ? '' : 's'}.`,
        state: recovery.failedJournalCount > 0 ? 'warn' : 'pass',
      },
      {
        id: 'funding-envelope',
        title: 'Funding envelope',
        detail: `Estimated staged envelope is ${estimatedSolCost.toFixed(3)} SOL.`,
        state: estimatedSolCost > 0 ? 'pass' : 'warn',
      },
    ],
    operations,
  };
  return {
    ...plan,
    integrity: {
      algorithm: 'sha256',
      digest: launchPlanIntegrityDigest(plan),
    },
  };
}

export function verifyLaunchPlan(plan = {}) {
  const errors = [];
  const addError = (code, path, message) => errors.push({ code, path, message });
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    addError('INVALID_PLAN', '$', 'Launch plan must be a JSON object.');
    return { valid: false, schema: TREBUCHET_PLAN_SCHEMA, errors };
  }
  if (plan.schema !== TREBUCHET_PLAN_SCHEMA) {
    addError('UNSUPPORTED_SCHEMA', 'schema', `Expected ${TREBUCHET_PLAN_SCHEMA}.`);
  }
  if (plan.protocolVersion !== TREBUCHET_CORE_PROTOCOL_VERSION) {
    addError('UNSUPPORTED_PROTOCOL', 'protocolVersion', `Expected protocol version ${TREBUCHET_CORE_PROTOCOL_VERSION}.`);
  }
  if (plan.contractVersion !== CONTRACT_VERSION) {
    addError('UNSUPPORTED_CONTRACT', 'contractVersion', `Expected contract version ${CONTRACT_VERSION}.`);
  }
  try {
    normalizeTokenName(plan.token?.name);
    normalizeTokenSymbol(plan.token?.symbol);
    normalizeV2TokenSupply(plan.token?.supply);
  } catch (error) {
    addError('INVALID_TOKEN', 'token', error.message);
  }

  const operations = Array.isArray(plan.operations) ? plan.operations : [];
  const operationIds = operations.map((operation) => String(operation?.id || ''));
  if (
    operationIds.length !== REQUIRED_OPERATION_IDS.length
    || REQUIRED_OPERATION_IDS.some((id, index) => operationIds[index] !== id)
  ) {
    addError('INVALID_OPERATIONS', 'operations', 'Launch operations are missing, reordered, or unsupported.');
  }
  const seen = new Set();
  operations.forEach((operation, index) => {
    const id = operationIds[index];
    if (!id || seen.has(id)) addError('DUPLICATE_OPERATION', `operations[${index}].id`, 'Operation IDs must be unique.');
    const unknownDependency = (Array.isArray(operation?.requires) ? operation.requires : [])
      .find((required) => !seen.has(required));
    if (unknownDependency) {
      addError('INVALID_DEPENDENCY', `operations[${index}].requires`, `Dependency ${unknownDependency} must appear earlier in the plan.`);
    }
    seen.add(id);
  });

  const operationCost = roundSol(operations.reduce((sum, operation) => {
    const cost = Number(operation?.costSol);
    return sum + (Number.isFinite(cost) ? cost : 0);
  }, 0));
  if (operationCost !== roundSol(plan.funding?.estimatedSolCost)) {
    addError('COST_MISMATCH', 'funding.estimatedSolCost', 'Estimated SOL cost does not match the operation total.');
  }

  const expectedDigest = launchPlanIntegrityDigest(plan);
  const actualDigest = String(plan.integrity?.digest || '');
  if (plan.integrity?.algorithm !== 'sha256' || actualDigest !== expectedDigest) {
    addError('INTEGRITY_MISMATCH', 'integrity', 'Launch plan integrity digest does not match its contents.');
  }

  return {
    valid: errors.length === 0,
    schema: TREBUCHET_PLAN_SCHEMA,
    protocolVersion: TREBUCHET_CORE_PROTOCOL_VERSION,
    digest: expectedDigest,
    errors,
  };
}

export function buildV2ExecutionReadiness(input = {}, context = {}) {
  const demoMode = context.demoMode === true;
  const walletPublicKey = String(context.walletPublicKey || input.walletPublicKey || '').trim();
  const plan = buildV2LaunchPlan({
    ...input,
    walletPublicKey,
  }, {
    demoMode,
    now: context.now,
  });
  const walletAvailable = demoMode || context.walletAvailable === true;
  const secretAvailable = demoMode || context.secretAvailable === true;
  const secretPinLocked = !demoMode && context.secretPinLocked === true;
  const tokenMint = String(
    context.tokenMint
      || context.createdTokenInfo?.mint
      || context.createdTokenInfo?.mintAddress
      || context.createdTokenInfo?.tokenMint
      || '',
  ).trim();
  const tokenCreated = Boolean(tokenMint || context.tokenCreated === true);
  const priorResults = Array.isArray(context.priorResults) ? context.priorResults : [];
  const shouldResume = context.resume === true || context.failedLaunch === true || priorResults.length > 0;
  const liquidityComplete = context.liquidityComplete === true || context.lpComplete === true;
  const terminalTransfer = context.transfer || context.journal?.transfer || null;
  const terminalSweepEvidence = transferHasWalletEmptyFinalSweepEvidence(terminalTransfer);
  const transferComplete = terminalSweepEvidence;
  const setupSafetyGateRequired = !demoMode && !shouldResume && !liquidityComplete && !transferComplete;
  const recipients = normalizeAirdropRecipients(input, context);
  const allocations = classicAllocations(plan.poolTopology);
  const publishLaunchReport = plan.poolTopology.report.publish !== false;
  const targetMarketCapUsd = plan.poolTopology.targetMarketCapUsd;
  const supplyUsed = roundSol(
    plan.poolTopology.totalPoolPercent
      + plan.poolTopology.preallocation.supplyPercent
      + plan.poolTopology.airdrop.supplyPercent,
  );
  const walletBlockerIds = [];
  const tokenBlockerIds = [];
  const fundingBlockerIds = [];
  const liquidityBlockerIds = [];
  const sweepBlockerIds = [];
  const blockers = [];
  const warnings = [];

  function addBlocker(issue) {
    blockers.push(readinessIssue(issue));
    if (issue.phase === 'wallet') walletBlockerIds.push(issue.id);
    if (issue.phase === 'token') tokenBlockerIds.push(issue.id);
    if (issue.phase === 'funding') fundingBlockerIds.push(issue.id);
    if (issue.phase === 'liquidity') liquidityBlockerIds.push(issue.id);
    if (issue.phase === 'sweep') sweepBlockerIds.push(issue.id);
  }

  if (!walletPublicKey) {
    addBlocker({
      id: 'wallet-missing',
      phase: 'wallet',
      title: 'Launch wallet missing',
      detail: 'Generate or import a Trebuchet-managed launch wallet before execution.',
    });
  } else if (!walletAvailable) {
    addBlocker({
      id: 'wallet-not-managed',
      phase: 'wallet',
      title: 'Launch wallet not in local store',
      detail: 'The selected wallet is not present in Trebuchet managed-wallet storage.',
    });
  }

  if (secretPinLocked) {
    addBlocker({
      id: 'pin-locked',
      phase: 'wallet',
      title: 'Secret PIN locked',
      detail: 'Unlock the local secrets PIN before Trebuchet can sign classic launch calls.',
    });
  }

  if (walletPublicKey && walletAvailable && !secretAvailable) {
    addBlocker({
      id: 'wallet-secret-unavailable',
      phase: 'wallet',
      title: 'Wallet secret unavailable',
      detail: 'The managed wallet exists, but its secret key is unavailable or failed decryption.',
    });
  }

  if (plan.poolTopology.totalPoolPercent <= 0) {
    addBlocker({
      id: 'pool-empty',
      phase: 'liquidity',
      title: 'No liquidity allocation',
      detail: 'At least one classic pool must receive token supply.',
    });
  }

  if (supplyUsed > 100) {
    addBlocker({
      id: 'pool-overallocated',
      phase: 'liquidity',
      title: 'Supply overallocated',
      detail: `Pools, preallocation, and airdrop reserve ${supplyUsed.toFixed(2)}% of supply; reduce them to 100% or less.`,
    });
  }

  duplicatePoolRouteIssues(plan.poolTopology.pools).forEach((issue) => {
    addBlocker({
      id: `duplicate-pool-route-${issue.index + 1}`,
      phase: 'liquidity',
      title: 'Duplicate pool route',
      detail: issue.detail,
    });
  });

  quoteTokenSafetyIssues(plan.poolTopology.pools).forEach((issue, issueIndex) => {
    if (setupSafetyGateRequired && issue.blocksFreshLive !== false) {
      addBlocker({
        id: `quote-token-safety-${issue.index + 1}-${issueIndex + 1}`,
        phase: 'liquidity',
        title: 'Quote token safety',
        detail: issue.detail,
      });
      return;
    }
    warnings.push(readinessIssue({
      id: `quote-token-safety-${issue.index + 1}-${issueIndex + 1}`,
      phase: 'liquidity',
      title: 'Quote token safety',
      detail: issue.detail,
      severity: 'warning',
    }));
  });

  feeKeyRecipientIssues(plan.poolTopology.pools).forEach((issue, issueIndex) => {
    addBlocker({
      id: `invalid-fee-key-recipient-${issue.poolIndex + 1}-${issue.sliceIndex + 1}-${issueIndex + 1}`,
      phase: 'liquidity',
      title: 'Invalid Fee Key recipient',
      detail: issue.detail,
    });
  });

  ladderRouteIssues(plan.poolTopology.pools).forEach((issue, issueIndex) => {
    addBlocker({
      id: `invalid-ladder-${issue.index + 1}-${issueIndex + 1}`,
      phase: 'liquidity',
      title: 'Invalid ladder configuration',
      detail: issue.detail,
    });
  });

  if (targetMarketCapUsd <= 0) {
    addBlocker({
      id: 'target-market-cap-missing',
      phase: 'funding',
      title: 'Target market cap missing',
      detail: 'Classic funding estimation needs a positive target market cap.',
    });
  }

  if (plan.vanity.mode !== 'random' && !plan.vanity.selectedPublicKey) {
    warnings.push(readinessIssue({
      id: 'vanity-not-bound',
      phase: 'token',
      title: 'Vanity target not selected',
      detail: 'No saved Vanity CA is selected; classic token creation may need to grind at execution time.',
      severity: 'warning',
    }));
  }

  const candidateFundingEstimate = hasClassicFundingEstimate(context.fundingEstimate)
    ? context.fundingEstimate
    : input.funding?.estimate;
  const fundingEstimateAttached = hasClassicFundingEstimate(candidateFundingEstimate);
  const fundingGateRequired = !demoMode && !liquidityComplete && !transferComplete && !shouldResume;
  const fundingEstimateMatchesInput = fundingEstimateAttached
    && v2FundingEstimateMatchesLaunchInput(input, candidateFundingEstimate);
  const fundingEstimateStale = Boolean(
    context.requireCurrentFundingEstimate === true
    && fundingGateRequired
    && fundingEstimateAttached
    && !fundingEstimateMatchesInput
  );
  const fundingEstimateUsable = fundingEstimateAttached && !fundingEstimateStale;
  const fundingEstimate = fundingEstimateUsable ? candidateFundingEstimate : null;
  const rpcPosture = rpcPostureStatus(context);
  setPlanGuardrail(plan, 'rpc-posture', {
    title: rpcPosture.title,
    detail: rpcPosture.detail,
    state: rpcPosture.state,
  });
  if (rpcPosture.isPublic && setupSafetyGateRequired) {
    addBlocker({
      id: rpcPosture.id,
      phase: 'funding',
      title: rpcPosture.title,
      detail: rpcPosture.detail,
    });
  } else if (rpcPosture.state !== 'pass') {
    warnings.push(readinessIssue({
      id: rpcPosture.id,
      phase: 'funding',
      title: rpcPosture.title,
      detail: rpcPosture.detail,
      severity: 'warning',
    }));
  }

  if (!fundingEstimateAttached) {
    const issue = {
      id: 'funding-not-estimated',
      phase: 'funding',
      title: 'Funding not estimated',
      detail: 'Run the classic funding estimate before funding the launch wallet.',
    };
    if (demoMode || !fundingGateRequired) {
      warnings.push(readinessIssue({ ...issue, severity: 'warning' }));
    } else {
      addBlocker(issue);
    }
  } else if (fundingEstimateStale) {
    addBlocker({
      id: 'funding-estimate-stale',
      phase: 'funding',
      title: 'Funding estimate stale',
      detail: 'The attached Classic funding estimate is not bound to the current token, pool, report, and airdrop model. Rerun the funding estimate before fresh live execution.',
    });
  }

  if (fundingGateRequired && fundingEstimateUsable && context.requireFundingBalance === true) {
    if (context.walletBalanceError) {
      addBlocker({
        id: 'funding-balance-unverified',
        phase: 'funding',
        title: 'Funding balance not checked',
        detail: `Trebuchet could not verify the launch wallet balance: ${context.walletBalanceError}`,
      });
    } else {
      fundingBalanceIssues({
        estimate: fundingEstimate,
        walletBalance: context.walletBalance,
        plan,
        tokenCreated,
      }).forEach(addBlocker);
    }
  }

  if (!plan.poolTopology.sweepDestination) {
    warnings.push(readinessIssue({
      id: 'destination-missing',
      phase: 'sweep',
      title: 'Sweep destination missing',
      detail: 'Final asset sweep needs a destination wallet after LP work completes.',
      severity: 'warning',
    }));
  }

  sweepDestinationIssues(plan.poolTopology).forEach((issue, issueIndex) => {
    addBlocker({
      id: `invalid-sweep-destination-${issueIndex + 1}`,
      phase: 'sweep',
      title: 'Invalid sweep destination',
      detail: issue.detail,
    });
  });

  if (plan.poolTopology.airdrop.enabled && Number(plan.poolTopology.airdrop.recipientCount || 0) > 0 && recipients.length === 0) {
    const issue = {
      id: 'airdrop-recipients-missing',
      phase: 'sweep',
      title: 'Airdrop recipients not attached',
      detail: 'Airdrop count is configured, but executable recipient rows are not attached yet.',
    };
    setPlanGuardrail(plan, 'classic-airdrop-recipients', {
      state: setupSafetyGateRequired ? 'danger' : 'warn',
      detail: issue.detail,
    });
    if (setupSafetyGateRequired) {
      addBlocker(issue);
    } else {
      warnings.push(readinessIssue({ ...issue, severity: 'warning' }));
    }
  }

  const recipientCountIssue = airdropRecipientCountIssue(plan.poolTopology.airdrop, recipients);
  if (recipientCountIssue) {
    const issue = {
      id: 'airdrop-recipient-count-mismatch',
      phase: 'sweep',
      title: 'Airdrop recipient count mismatch',
      detail: recipientCountIssue.detail,
    };
    setPlanGuardrail(plan, 'classic-airdrop-recipients', {
      state: setupSafetyGateRequired ? 'danger' : 'warn',
      detail: issue.detail,
    });
    if (setupSafetyGateRequired) {
      addBlocker(issue);
    } else {
      warnings.push(readinessIssue({ ...issue, severity: 'warning' }));
    }
  }

  airdropRecipientIssues(plan.poolTopology.airdrop).forEach((issue, issueIndex) => {
    addBlocker({
      id: `invalid-airdrop-recipient-${issue.index == null ? 'config' : issue.index + 1}-${issueIndex + 1}`,
      phase: 'sweep',
      title: 'Invalid airdrop recipient',
      detail: issue.detail,
    });
  });

  const airdropBacking = airdropSupportBackingStatus(plan, fundingEstimate || {});
  setPlanGuardrail(plan, 'classic-airdrop-backing', {
    state: airdropBacking.state,
    detail: airdropBacking.detail,
  });
  if (
    airdropBacking.required
    && airdropBacking.state !== 'pass'
    && setupSafetyGateRequired
    && (fundingEstimateAttached || Number(airdropBacking.supportSol || 0) <= 0)
  ) {
    addBlocker({
      id: 'airdrop-support-underbacked',
      phase: 'liquidity',
      title: 'Held reserve support underbacked',
      detail: airdropBacking.detail,
    });
  } else if (airdropBacking.required && airdropBacking.state !== 'pass') {
    warnings.push(readinessIssue({
      id: 'airdrop-support-underbacked',
      phase: 'liquidity',
      title: 'Held reserve support underbacked',
      detail: airdropBacking.detail,
      severity: 'warning',
    }));
  }

  const hardBlocked = blockers.length > 0;
  let nextEndpoint = null;
  let nextAction = 'Resolve blockers';

  if (!hardBlocked && !tokenCreated) {
    nextEndpoint = CLASSIC_ENDPOINTS.createToken;
    nextAction = 'Create token';
  } else if (!hardBlocked && tokenCreated && !liquidityComplete && shouldResume) {
    nextEndpoint = CLASSIC_ENDPOINTS.resumeLaunch;
    nextAction = 'Resume launch';
  } else if (!hardBlocked && tokenCreated && !liquidityComplete) {
    nextEndpoint = CLASSIC_ENDPOINTS.createLp;
    nextAction = 'Create liquidity';
  } else if (!hardBlocked && tokenCreated && liquidityComplete && transferComplete) {
    nextAction = 'Launch complete';
  } else if (!hardBlocked && tokenCreated && liquidityComplete && plan.poolTopology.sweepDestination) {
    nextEndpoint = CLASSIC_ENDPOINTS.transferAssets;
    nextAction = 'Sweep assets';
  } else if (!hardBlocked && tokenCreated && liquidityComplete) {
    nextAction = 'Set sweep destination';
  }
  const completed = !hardBlocked && tokenCreated && liquidityComplete && transferComplete && !nextEndpoint;
  const completionStatus = hardBlocked ? 'blocked' : completed ? 'complete' : 'pending';

  const executableAirdrop = airdropPayload({
    enabled: plan.poolTopology.airdrop.enabled,
    recipientCount: plan.poolTopology.airdrop.recipientCount,
    recipients,
    tokenMint,
    tokenDecimals: plan.token.decimals,
  });
  const createLpPayload = {
    walletPublicKey,
    tokenMint: tokenMint || null,
    tokenDecimals: plan.token.decimals,
    tokenTotalSupply: plan.token.supply,
    targetMarketCapUsd,
    allocations,
    lockPositions: true,
    airdrop: executableAirdrop,
  };

  return {
    contractVersion: CONTRACT_VERSION,
    status: blockers.length ? 'blocked' : 'ready',
    completionStatus,
    completed,
    completion: {
      status: completionStatus,
      tokenCreated,
      liquidityComplete,
      transferComplete,
      terminalSweepEvidence,
      nextEndpoint,
    },
    nextEndpoint,
    nextAction,
    walletPublicKey: walletPublicKey || null,
    tokenMint: tokenMint || null,
    blockers,
    warnings,
    phases: [
      readinessPhase({
        id: 'wallet',
        title: 'Wallet',
        endpoint: '/api/v2/wallets/generate',
        state: walletBlockerIds.length ? 'blocked' : 'ready',
        detail: walletBlockerIds.length
          ? 'Trebuchet needs a managed local wallet with an available secret.'
          : 'Managed launch wallet can sign classic execution calls.',
        blockerIds: walletBlockerIds,
      }),
      readinessPhase({
        id: 'token',
        title: 'Create token',
        endpoint: CLASSIC_ENDPOINTS.createToken,
        state: tokenBlockerIds.length || walletBlockerIds.length
          ? 'blocked'
          : tokenCreated ? 'complete' : 'ready',
        detail: tokenCreated ? 'Token mint is already available.' : 'Classic token creation payload is ready.',
        blockerIds: [...walletBlockerIds, ...tokenBlockerIds],
      }),
      readinessPhase({
        id: 'funding',
        title: 'Funding estimate',
        endpoint: CLASSIC_ENDPOINTS.estimateFunding,
        state: fundingBlockerIds.length || liquidityBlockerIds.length ? 'blocked' : 'ready',
        detail: fundingEstimateStale
          ? 'Classic funding estimate is stale for this launch model; rerun the estimate before fresh live execution.'
          : fundingEstimateUsable
          ? context.requireFundingBalance === true && fundingGateRequired && !fundingBlockerIds.length
            ? 'Classic funding estimate and launch-wallet balance are verified.'
            : 'Classic funding estimate is attached.'
          : fundingGateRequired
            ? 'Run estimate before funding the managed wallet.'
            : 'Funding estimate is no longer required for this recovery or sweep step.',
        blockerIds: [...fundingBlockerIds, ...liquidityBlockerIds],
      }),
      readinessPhase({
        id: 'liquidity',
        title: 'Create pools',
        endpoint: CLASSIC_ENDPOINTS.createLp,
        state: walletBlockerIds.length || fundingBlockerIds.length || liquidityBlockerIds.length
          ? 'blocked'
          : tokenCreated ? (liquidityComplete ? 'complete' : 'ready') : 'waiting',
        detail: tokenCreated
          ? 'Classic LP payload can use the created token mint.'
          : 'Waiting for token mint from create-token.',
        blockerIds: [...walletBlockerIds, ...fundingBlockerIds, ...liquidityBlockerIds],
      }),
      readinessPhase({
        id: 'recover',
        title: 'Resume launch',
        endpoint: CLASSIC_ENDPOINTS.resumeLaunch,
        state: walletBlockerIds.length || fundingBlockerIds.length || liquidityBlockerIds.length
          ? 'blocked'
          : shouldResume && tokenCreated ? 'ready' : 'waiting',
        detail: shouldResume
          ? `${priorResults.length} prior result${priorResults.length === 1 ? '' : 's'} available for resume.`
          : 'No partial LP result selected.',
        blockerIds: [...walletBlockerIds, ...fundingBlockerIds, ...liquidityBlockerIds],
      }),
      readinessPhase({
        id: 'sweep',
        title: 'Sweep assets',
        endpoint: CLASSIC_ENDPOINTS.transferAssets,
        state: transferComplete
          ? 'complete'
          : walletBlockerIds.length || sweepBlockerIds.length
          ? 'blocked'
          : tokenCreated && plan.poolTopology.sweepDestination ? 'ready' : 'waiting',
        detail: plan.poolTopology.sweepDestination
          ? transferComplete
            ? 'Final sweep is recorded in the launch journal.'
            : 'Sweep destination is configured.'
          : 'Waiting for destination wallet before final sweep.',
        blockerIds: [...walletBlockerIds, ...sweepBlockerIds],
      }),
    ],
    classicEndpoints: CLASSIC_ENDPOINTS,
    classicPayloads: {
      createToken: {
        walletPublicKey,
        name: plan.token.name,
        symbol: plan.token.symbol,
        description: plan.token.description,
        totalSupply: plan.token.supply,
        logo: plan.token.logo,
        vanityCAPublicKey: plan.vanity.selectedPublicKey || null,
        vanityPrefix: plan.vanity.selectedPublicKey ? null : plan.vanity.prefix || null,
        vanitySuffix: plan.vanity.selectedPublicKey ? null : plan.vanity.suffix || null,
      },
      estimateFunding: {
        allocations,
        targetMarketCapUsd,
        publishLaunchReport,
      },
      preflightCreateLp: {
        tokenMint: tokenMint || null,
        tokenDecimals: plan.token.decimals,
        tokenTotalSupply: plan.token.supply,
        targetMarketCapUsd,
        allocations,
      },
      createLp: createLpPayload,
      resumeLaunch: {
        ...createLpPayload,
        priorResults,
      },
      transferAssets: {
        walletPublicKey,
        destinationWallet: plan.poolTopology.sweepDestination || null,
        tokenMint: tokenMint || null,
        tokenDecimals: plan.token.decimals,
        airdrop: executableAirdrop,
      },
    },
    plan,
  };
}
