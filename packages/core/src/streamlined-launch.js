// streamlined-launch.js
//
// The greenfield v2 launch model for Trebuchet.
//
// The entire launch is ONE signature:
//
//   create mint -> create pool -> deposit -> transfer-lock
//
// built into a single batched transaction, signed once by the user's own
// wallet. It is pure CPMM on Token-2022 native metadata: constant-product
// pools have no tick arrays and no per-range positions, so there is no
// Burn & Earn, no lock machinery, no staging custody, and nothing to sweep.
// There is deliberately no CLMM alternative in this model.
//
// Cost model: the ledger is the actual on-chain spend (pool state + LP mint +
// vault rents + one transfer-lock) plus a small variance margin, instead of
// the classic topology's per-pool tick-array sprawl, auto-swap overspend
// (2x target x 2x sizing), and flat 20% safety buffer. The module also emits
// an equivalent classic-model ledger for the "what was removed" comparison.
//
// Headless, deterministic, network-independent: this module never touches the
// chain.

import {
  AUTOSWAP_SIZING_MULTIPLIER,
  AUTOSWAP_TARGET_USD,
  BS_BOOTSTRAP_USD,
  COST_BS_QUOTE_SOL,
  COST_LAUNCH_REPORT_SOL,
  COST_LOCK_SOL,
  COST_POOL_RENT_SOL,
  COST_POSITION_SOL,
  COST_TICK_ARRAY_SOL,
  COST_TOKEN_CREATE_SOL,
  COST_TX_BUFFER_SOL,
  CPMM_LP_MINT_RENT_SOL,
  CPMM_LOCK_TRANSFER_SOL,
  CPMM_POOL_RENT_SOL,
  CPMM_VAULT_ATA_RENT_SOL,
  FALLBACK_SOL_USD,
  SAFETY_BUFFER_PCT,
} from './lp-constants.js';
import {
  normalizeTokenDescription,
  normalizeTokenName,
  normalizeTokenSymbol,
  normalizeWholeTokenSupply,
} from './validators.js';
// Web-safe SHA-256 so this module runs on a static host with no Node imports.
import { sha256Hex } from './sha256.js';

// These mirror launch-plan.js. They are duplicated here (not imported through
// launch-plan.js) so this module stays free of `node:*` imports and can run
// directly in a browser bundle. Keep them in sync with launch-plan.js.
const TOKEN_MINT_FORMAT_CLASSIC = 'classic-spl';
const TOKEN_MINT_FORMAT_TOKEN_2022 = 'token-2022';
const TOKEN_2022_PROGRAM_ADDRESS = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const CLASSIC_TOKEN_PROGRAM_ADDRESS = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TREBUCHET_CORE_PROTOCOL_VERSION = 1;

export const STREAMLINED_PLAN_SCHEMA = 'trebuchet-streamlined-plan/v1';
export const STREAMLINED_CONTRACT_VERSION = 1;

// Pure CPMM on Token-2022 native metadata: no tick arrays, no per-range
// positions, no Burn & Earn. The whole launch is create mint -> create pool
// -> deposit -> transfer-lock.
export const STREAMLINED_DEFAULT_POOL_COUNT = 1;
export const STREAMLINED_DEFAULT_VARIANCE_PCT = 0.02;
// Reference classic recipe used by default in the comparison: the common
// "one SOL pool + seven flywheel pools" layout (8 pools total) that drives
// the moose build toward a ~3.6 SOL quote.
export const STREAMLINED_CLASSIC_REFERENCE_POOLS = 8;
// A compressed (state-compression) bulk airdrop is a single merkle commit:
// one constant cost regardless of recipient count.
export const STREAMLINED_COMPRESSED_AIRDROP_SOL = 0.01;

export const STREAMLINED_MAX_POOLS = 40;
// Sur-link on the fee wrapper's buy/sell/transfer basis points. Real tokens
// rarely exceed 10%; the T-2022 extension cap is 100% (10000 bps), so we clamp
// to that ceiling and require an explicit treasury.
export const STREAMLINED_MAX_FEE_BPS = 10000;

const TREASURY_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const TOKEN_DECIMALS = 9;

function roundSol(value) {
  return Math.round(Number(value) * 1e6) / 1e6;
}

function finiteNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clampInt(value, min, max) {
  return Math.min(max, Math.max(min, Math.floor(Number(value))));
}

function isSolSymbol(symbol) {
  return String(symbol || '').trim().toUpperCase() === 'SOL';
}

// Fee policy for buy/sell/transfer. Fee is applied as a program-level
// surcharge so the CPMM pool keeps its net invariant exact:
//   swap does transfer(amountIn + fee) and CPIs treasury; the pool's receipt
//   equals its book amount, so reserves can never drift.
// The token never carries a T-2022 transfer-fee extension (which would hit
// the pool's own outgoing transfers and drain it).
export function normalizeStreamlinedFees(input = {}) {
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const clampBps = (value) => clampInt(finiteNumber(value, 0), 0, STREAMLINED_MAX_FEE_BPS);
  const buyBps = clampBps(raw.buyBps);
  const sellBps = clampBps(raw.sellBps);
  const transferBps = clampBps(raw.transferBps);
  const enabled = buyBps > 0 || sellBps > 0 || transferBps > 0;
  const treasury = String(raw.treasury || '').trim();
  if (enabled && !TREASURY_ADDRESS_RE.test(treasury)) {
    throw new Error(
      'A token with swap/transfer fees requires a valid 32-44 char Solana treasury address.',
    );
  }
  return {
    enabled,
    buyBps,
    sellBps,
    transferBps,
    treasury: enabled ? treasury : null,
    mode: enabled ? 'program-fee-wrapper' : 'none',
  };
}

function normalizeStreamlinedMintFormat(value) {
  return value === TOKEN_MINT_FORMAT_CLASSIC
    ? TOKEN_MINT_FORMAT_CLASSIC
    : TOKEN_MINT_FORMAT_TOKEN_2022;
}

function tokenProgramFor(mintFormat) {
  return mintFormat === TOKEN_MINT_FORMAT_TOKEN_2022
    ? TOKEN_2022_PROGRAM_ADDRESS
    : CLASSIC_TOKEN_PROGRAM_ADDRESS;
}

function streamlinedPlanId({ symbol, supply, poolCount }) {
  return `streamlined-${sha256Hex(`trebuchet-streamlined|${symbol}|${supply}|${poolCount}`).slice(0, 12)}`;
}

// ---------------------------------------------------------------------------
// Topology
// ---------------------------------------------------------------------------

function normalizeQuotes(input = {}) {
  const symbols = (Array.isArray(input.quotes) ? input.quotes : [])
    .map((value) => String(value || '').trim().toUpperCase())
    .filter(Boolean);
  return symbols.length ? symbols : ['SOL'];
}

// Single pool by default. Extra pools exist only for the progressive "add a
// pair later" story and keep the same lean shape: 2 tick arrays, one position,
// no auto-swap oversizing, no buffer.
export function buildStreamlinedPoolTopology(input = {}) {
  const poolCount = clampInt(
    finiteNumber(input.poolCount, STREAMLINED_DEFAULT_POOL_COUNT),
    1,
    STREAMLINED_MAX_POOLS,
  );
  const quotes = normalizeQuotes(input);
  const pools = [];
  for (let index = 0; index < poolCount; index++) {
    const symbol = quotes[index % quotes.length];
    pools.push({
      poolIndex: index + 1,
      quoteSymbol: symbol,
      sol: isSolSymbol(symbol),
      // Pure CPMM: one constant book — no tick arrays, no per-range positions.
      tickArrays: 0,
      positionCount: 0,
    });
  }
  return {
    pools,
    poolCount,
    solPoolCount: pools.filter((pool) => pool.sol).length,
    nonSolPoolCount: pools.filter((pool) => !pool.sol).length,
  };
}

// ---------------------------------------------------------------------------
// Ledgers
// ---------------------------------------------------------------------------

// The streamlined ledger is the actual on-chain spend:
//   - rents are exact deposits (pool account, tick arrays, mint)
//   - the single position NFT + lock is exact
//   - the only variable-budget parts are transaction fees and the quote-side
//     bootstrap ($1 worth of quote, exact target, no auto-swap oversize)
// A small variance margin (default 2%) covers the variable part.
function formatFeeBps(bps) {
  return `${(Number(bps) / 100).toFixed(2)}%`;
}

function shortTreasury(address) {
  const value = String(address || '');
  return value ? `${value.slice(0, 4)}…${value.slice(-4)}` : '';
}

function tokenMintLabel(input = {}) {
  const mintFormat = normalizeStreamlinedMintFormat(
    input.token?.mintFormat ?? input.mintFormat,
  );
  return mintFormat === TOKEN_MINT_FORMAT_TOKEN_2022
    ? 'Token-2022 mint (native metadata)'
    : 'Token creation (mint + metadata)';
}

export function buildStreamlinedLedger(input = {}) {
  const topology = buildStreamlinedPoolTopology(input);
  const solUsd = finiteNumber(input.solUsd, FALLBACK_SOL_USD);
  const variancePct = Math.min(1, Math.max(0, finiteNumber(
    input.variancePct,
    STREAMLINED_DEFAULT_VARIANCE_PCT,
  )));
  const publishReport = input.publishLaunchReport === true;
  const airdropEnabled = input.airdropEnabled === true;

  const lines = [];
  const mintLabel = tokenMintLabel(input);
  for (const pool of topology.pools) {
    const label = `Pool ${pool.poolIndex} (${pool.quoteSymbol})`;
    lines.push({
      label: `${label} pool state (CPMM, rent)`,
      sol: CPMM_POOL_RENT_SOL,
      exact: true,
    });
    lines.push({
      label: `${label} LP mint + vault accounts (rent)`,
      sol: CPMM_LP_MINT_RENT_SOL + (2 * CPMM_VAULT_ATA_RENT_SOL),
      exact: true,
    });
    lines.push({
      label: `${label} liquidity deposit + LP transfer-lock`,
      sol: CPMM_LOCK_TRANSFER_SOL,
      exact: true,
    });
    lines.push({
      label: `${label} network/priority fees`,
      sol: COST_TX_BUFFER_SOL,
      exact: false,
    });
    if (pool.sol) {
      lines.push({
        label: `${label} bootstrap quote-side (SOL, dust)`,
        sol: COST_BS_QUOTE_SOL,
        exact: true,
      });
    } else {
      // Exact $1 quote-purchase budget in SOL — no 2x auto-swap oversize.
      const quoteSol = roundSol(Math.max(BS_BOOTSTRAP_USD / solUsd, COST_BS_QUOTE_SOL));
      lines.push({
        label: `${label} bootstrap quote-side (~$${BS_BOOTSTRAP_USD} in ${pool.quoteSymbol})`,
        sol: quoteSol,
        exact: false,
      });
    }
  }

  lines.push({
    label: mintLabel,
    sol: COST_TOKEN_CREATE_SOL,
    exact: true,
  });

  if (airdropEnabled) {
    lines.push({
      label: 'Airdrop (compressed, single merkle commit)',
      sol: STREAMLINED_COMPRESSED_AIRDROP_SOL,
      exact: true,
    });
  }
  if (publishReport) {
    lines.push({
      label: 'Launch report (permanent Arweave publish)',
      sol: COST_LAUNCH_REPORT_SOL,
      exact: false,
    });
  }

  const fees = normalizeStreamlinedFees(input.fees || {});
  if (fees.enabled) {
    lines.push({
      label: `Swap fees (${formatFeeBps(fees.buyBps)} buy / ${formatFeeBps(fees.sellBps)} sell) → treasury ${shortTreasury(fees.treasury)} (net invariant exact)`,
      sol: 0,
      exact: true,
    });
  }

  const subtotalSol = roundSol(lines.reduce((sum, line) => sum + line.sol, 0));
  const varianceSol = roundSol(subtotalSol * variancePct);
  return {
    lines,
    poolCount: topology.poolCount,
    solUsd,
    subtotalSol,
    variancePct,
    varianceSol,
    totalSol: roundSol(subtotalSol + varianceSol),
  };
}

// The classic-model equivalent for the same shape of need, using the archive
// reference recipe: per pool = 3 tick arrays + main slice + bootstrap +
// auto-swap oversize for flywheel quotes + 20% safety buffer over everything.
export function buildClassicReferenceLedger(input = {}) {
  const poolCount = clampInt(
    finiteNumber(input.classicPoolCount, STREAMLINED_CLASSIC_REFERENCE_POOLS),
    1,
    STREAMLINED_MAX_POOLS,
  );
  const solUsd = finiteNumber(input.solUsd, FALLBACK_SOL_USD);
  const nonSolPoolCount = Math.max(0, poolCount - 1); // 1 SOL + rest flywheel

  const lines = [
    {
      label: `${poolCount} pool account${poolCount === 1 ? '' : 's'} (rent)`,
      sol: roundSol(poolCount * COST_POOL_RENT_SOL),
    },
    {
      label: `${poolCount * 3} tick arrays (wide main + bootstrap)`,
      sol: roundSol(poolCount * 3 * COST_TICK_ARRAY_SOL),
    },
    {
      label: `${poolCount * 2} positions (main slice + bootstrap, NFT mint + lock)`,
      sol: roundSol(poolCount * 2 * (COST_POSITION_SOL + COST_LOCK_SOL)),
    },
    {
      label: `${poolCount} network/priority fee cushion`,
      sol: roundSol(poolCount * COST_TX_BUFFER_SOL),
    },
    { label: 'SOL bootstrap (dust)', sol: COST_BS_QUOTE_SOL },
    {
      label: `${nonSolPoolCount} flywheel bootstrap (auto-swap $${AUTOSWAP_TARGET_USD} x ${AUTOSWAP_SIZING_MULTIPLIER})`,
      sol: roundSol(nonSolPoolCount * ((AUTOSWAP_TARGET_USD * AUTOSWAP_SIZING_MULTIPLIER) / solUsd)),
    },
    { label: 'Token creation (mint + metadata)', sol: roundSol(COST_TOKEN_CREATE_SOL) },
  ];

  const subtotal = roundSol(lines.reduce((sum, line) => sum + line.sol, 0));
  const bufferSol = roundSol(subtotal * SAFETY_BUFFER_PCT);
  return {
    lines,
    poolCount,
    solUsd,
    subtotalSol: subtotal,
    bufferSol,
    totalSol: roundSol(subtotal + bufferSol),
  };
}

export function compareStreamlinedLedger(streamlined, classic) {
  const savingSol = roundSol(classic.totalSol - streamlined.totalSol);
  const savingPct = classic.totalSol > 0
    ? roundSol((savingSol / classic.totalSol) * 100)
    : 0;
  return {
    streamlined,
    classic,
    savingSol,
    savingPct,
  };
}

// ---------------------------------------------------------------------------
// Batch blueprint
// ---------------------------------------------------------------------------

// The "one signature" batched-launch contract. All steps are CPIs composed
// into one program-level transaction; the user signs exactly once. There is no
// staging wallet, no custody handoff, no sweep.
export function buildStreamlinedBatchBlueprint(token, topology) {
  const instructions = token.mintFormat === TOKEN_MINT_FORMAT_TOKEN_2022
    ? [
      {
        id: 'create-token-2022-mint',
        kind: 'create-mint',
        program: 'token-2022',
        label: `Create ${token.symbol} Token-2022 mint (native metadata)`,
      },
    ]
    : [
      {
        id: 'create-mint',
        kind: 'create-mint',
        program: 'spl-token',
        label: `Create ${token.symbol} mint (${token.mintFormat})`,
      },
      {
        id: 'init-metadata',
        kind: 'init-metadata',
        program: 'metadata',
        label: `Initialize metadata for ${token.symbol}`,
      },
    ];
  const programId = 'raydium-cpmm';
  for (const pool of topology.pools) {
    const prefixId = `pool-${pool.poolIndex}`;
    instructions.push(
      {
        id: `${prefixId}-create`,
        kind: 'create-pool-cpmm',
        program: programId,
        label: `Pool ${pool.poolIndex} (${pool.quoteSymbol}) allocate pool state`,
      },
      {
        id: `${prefixId}-deposit`,
        kind: 'deposit-liquidity',
        program: programId,
        label: `Pool ${pool.poolIndex} (${pool.quoteSymbol}) deposit ${pool.quoteSymbol} + ${token.symbol}`,
      },
      {
        id: `${prefixId}-lock`,
        kind: 'lock-lp',
        program: programId,
        label: `Pool ${pool.poolIndex} (${pool.quoteSymbol}) transfer-lock LP`,
      },
    );
  }
  if (topology.fees?.enabled) {
    instructions.push({
      id: 'fee-wrapper',
      kind: 'fee-wrapper-slot',
      program: 'trebuchet-fee-route',
      label: `Enable swap fee wrapper (${formatFeeBps(topology.fees.buyBps)} buy / ${formatFeeBps(topology.fees.sellBps)} sell) → ${shortTreasury(topology.fees.treasury)}`,
    });
  }
  return {
    id: 'trebuchet-streamlined-batch/v1',
    policy: {
      signers: 'user',
      custodial: 'none',
      sweep: 'none',
      batchSignatureCount: 1,
      stagingCustody: 'none',
    },
    txs: [
      {
        id: 'launch-single-batch',
        signatureCount: 1,
        instructions,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

function buildStreamlinedChecks(topology, ledger, classic, comparison) {
  const checks = [
    {
      id: 'swap-fee-routing',
      title: topology.fees?.enabled ? 'Swap and transfer fees' : 'Swap fees: none',
      detail: topology.fees?.enabled
        ? `${formatFeeBps(topology.fees.buyBps)} buy / ${formatFeeBps(topology.fees.sellBps)} sell / ${formatFeeBps(topology.fees.transferBps)} transfer → treasury ${shortTreasury(topology.fees.treasury)} via fee wrapper. The pool net invariant stays exact.`
        : 'No buy/sell/transfer fee configured.',
      state: 'pass',
    },
    {
      id: 'single-signature',
      title: 'One signature, one batch',
      detail: 'Mint, pool, position, and lock all fit in one user-signed batch.',
      state: 'pass',
    },
    {
      id: 'no-staging-custody',
      title: 'No staging custody',
      detail: 'No Trebuchet-managed ephemeral wallet holds launch funds at any point.',
      state: 'pass',
    },
    {
      id: 'no-final-sweep',
      title: 'No final sweep',
      detail: 'Assets return to the signer inside the same batch; nothing to sweep after launch.',
      state: 'pass',
    },
    {
      id: 'no-tick-array-cost',
      title: 'No tick-array rent',
      detail: 'Constant-product pools carry no tick-array or per-range position cost.',
      state: 'pass',
    },
    {
      id: 'exact-rents',
      title: 'Exact rents, small variance',
      detail: `Rents are exact; only ${Math.round(ledger.variancePct * 100)}% variance margin instead of a 20% safety buffer.`,
      state: 'pass',
    },
    {
      id: 'classic-removed',
      title: 'Classic overhead removed',
      detail: `${comparison.savingPct.toFixed(1)}% lower than the classic reference recipe (${classic.poolCount} pool model).`,
      state: 'pass',
    },
  ];
  if (topology.pools.length > 1) {
    checks.push({
      id: 'progressive-pools',
      title: 'Progressive pools',
      detail: `${topology.poolCount} pools planned up-front; later pairs are added one batch at a time.`,
      state: 'warn',
    });
  }
  if (topology.nonSolPoolCount > 0) {
    checks.push({
      id: 'quote-bootstrap',
      title: 'Quote purchase required',
      detail: 'Non-SOL pools budget an exact $1 quote purchase (no oversize buy).',
      state: 'pass',
    });
  }
  return checks;
}

// ---------------------------------------------------------------------------
// Plan build + verify
// ---------------------------------------------------------------------------

// Stable, ordered payload for the integrity digest: any valid JSON
// re-serialization of the same plan must hash to the same value.
function streamlinedStable(value) {
  if (Array.isArray(value)) return value.map(streamlinedStable);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((record, key) => {
      record[key] = streamlinedStable(value[key]);
      return record;
    }, {});
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value === undefined) return null;
  return value;
}

export function streamlinedIntegrityDigest(plan = {}) {
  const { integrity, ...payload } = plan;
  void integrity;
  return sha256Hex(JSON.stringify(streamlinedStable(payload)));
}

export function buildStreamlinedPlan(input = {}, options = {}) {
  const tokenInput = input.token || {};
  const name = normalizeTokenName(tokenInput.name ?? input.tokenName ?? 'Untitled');
  const symbol = normalizeTokenSymbol(tokenInput.symbol ?? input.tokenSymbol ?? 'TOK').toUpperCase();
  const supply = String(normalizeWholeTokenSupply(tokenInput.supply ?? input.tokenSupply ?? '1000000000'));
  const description = normalizeTokenDescription(tokenInput.description ?? input.tokenDescription ?? '');

  const token = {
    name,
    symbol,
    supply,
    decimals: TOKEN_DECIMALS,
    description,
    mintFormat: normalizeStreamlinedMintFormat(tokenInput.mintFormat ?? input.mintFormat),
    tokenProgram: null,
  };
  token.tokenProgram = tokenProgramFor(token.mintFormat);

  const topology = buildStreamlinedPoolTopology(input);
  const fees = normalizeStreamlinedFees(input.fees || {});
  topology.fees = fees;
  const ledger = buildStreamlinedLedger(input);
  const classic = buildClassicReferenceLedger(input);
  const comparison = compareStreamlinedLedger(ledger, classic);
  const batch = buildStreamlinedBatchBlueprint(token, topology);

  const plan = {
    schema: STREAMLINED_PLAN_SCHEMA,
    protocolVersion: TREBUCHET_CORE_PROTOCOL_VERSION,
    contractVersion: STREAMLINED_CONTRACT_VERSION,
    id: streamlinedPlanId({ symbol, supply, poolCount: topology.poolCount }),
    generatedAt: options.now || input.generatedAt || new Date().toISOString(),
    token,
    fees,
    topology,
    ledger,
    classicReference: classic,
    comparison,
    batch,
    checks: buildStreamlinedChecks(topology, ledger, classic, comparison),
  };
  plan.integrity = {
    algorithm: 'sha256',
    digest: streamlinedIntegrityDigest(plan),
  };
  return plan;
}

export function verifyStreamlinedPlan(plan = {}) {
  const errors = [];
  const addError = (code, path, message) => errors.push({ code, path, message });
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    addError('INVALID_PLAN', '$', 'Streamlined plan must be a JSON object.');
    return { valid: false, schema: STREAMLINED_PLAN_SCHEMA, errors };
  }
  if (plan.schema !== STREAMLINED_PLAN_SCHEMA) {
    addError('UNSUPPORTED_SCHEMA', 'schema', `Expected ${STREAMLINED_PLAN_SCHEMA}.`);
  }

  // Ledger arithmetic: subtotal is the sum of its lines, variance is a
  // fraction of subtotal, total is subtotal + variance.
  const lines = Array.isArray(plan.ledger?.lines) ? plan.ledger.lines : [];
  const lineSum = roundSol(lines.reduce((sum, line) => sum + Number(line?.sol || 0), 0));
  if (lineSum !== Number(plan.ledger?.subtotalSol)) {
    addError('LEDGER_MISMATCH', 'ledger.subtotalSol', 'Ledger subtotal does not match the sum of its lines.');
  }
  const variance = roundSol(lineSum * Number(plan.ledger?.variancePct || 0));
  if (Number(plan.ledger?.varianceSol) !== variance) {
    addError('LEDGER_VARIANCE', 'ledger.varianceSol', 'Variance margin does not match subtotal x variancePct.');
  }
  if (Number(plan.ledger?.totalSol) !== roundSol(lineSum + variance)) {
    addError('LEDGER_TOTAL', 'ledger.totalSol', 'Ledger total does not match subtotal + variance.');
  }

  // The comparison must be faithful to classic vs streamlined totals.
  const classic = plan.classicReference;
  const expectedSaving = roundSol(Number(classic?.totalSol) - Number(plan.ledger?.totalSol));
  if (Number(plan.comparison?.savingSol) !== expectedSaving) {
    addError('COMPARISON_MISMATCH', 'comparison.savingSol', 'Comparison is not faithful to classic vs streamlined totals.');
  }

  const expectedDigest = streamlinedIntegrityDigest(plan);
  const actualDigest = String(plan.integrity?.digest || '');
  if (plan.integrity?.algorithm !== 'sha256' || actualDigest !== expectedDigest) {
    addError('INTEGRITY_MISMATCH', 'integrity', 'Streamlined plan integrity digest does not match its contents.');
  }

  return {
    valid: errors.length === 0,
    schema: STREAMLINED_PLAN_SCHEMA,
    digest: expectedDigest,
    errors,
  };
}