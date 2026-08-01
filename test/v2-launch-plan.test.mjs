import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

import {
  buildV2ExecutionReadiness,
  buildV2LaunchPlan,
  launchPlanConfigFingerprint,
  launchPlanWalletFingerprint,
  v2FundingEstimateFingerprint,
} from '../v2LaunchPlan.js';

const serverSource = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const VALID_SWEEP_DESTINATION = '11111111111111111111111111111115';
const VALID_ROUND_TRIP_DESTINATION = '11111111111111111111111111111116';
const VALID_AIRDROP_WALLET_ONE = '11111111111111111111111111111117';
const VALID_AIRDROP_WALLET_TWO = '11111111111111111111111111111118';
const VALID_VANITY_PUBLIC_KEY = `MKT${'1'.repeat(26)}K1T`;

function attachFundingFingerprint(input, estimate = { totalSol: 2.4 }) {
  return {
    ...estimate,
    v2FundingFingerprint: v2FundingEstimateFingerprint(input),
  };
}

function pngLogoBytes(width, height) {
  const buffer = Buffer.alloc(33);
  buffer.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  buffer[24] = 8;
  buffer[25] = 6;
  return buffer;
}

function jpegLogoBytes(width, height) {
  return Buffer.from([
    0xff, 0xd8,
    0xff, 0xc0,
    0x00, 0x11,
    0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x03,
    0x01, 0x11, 0x00,
    0x02, 0x11, 0x00,
    0x03, 0x11, 0x00,
    0xff, 0xd9,
  ]);
}

function logoDataUrl(mimeType, bytes) {
  return `data:${mimeType};base64,${bytes.toString('base64')}`;
}

const VALID_PNG_LOGO_BYTES = pngLogoBytes(64, 64);
const VALID_PNG_LOGO_DATA_URL = logoDataUrl('image/png', VALID_PNG_LOGO_BYTES);
const VALID_JPEG_LOGO_BYTES = jpegLogoBytes(64, 64);
const VALID_JPEG_LOGO_DATA_URL = logoDataUrl('image/jpeg', VALID_JPEG_LOGO_BYTES);

test('buildV2LaunchPlan returns a normalized local-wallet run contract', () => {
  const input = {
    walletPublicKey: VALID_ROUND_TRIP_DESTINATION,
    token: {
      name: '  MoonKit  ',
      symbol: ' mkt ',
      supply: '1,000,000,000',
      description: 'Community token launch',
      logo: {
        name: 'moon.png',
        mimeType: 'image/png',
        sizeBytes: VALID_PNG_LOGO_BYTES.length,
        dataUrl: VALID_PNG_LOGO_DATA_URL,
      },
    },
    launchSol: 3.5,
    mode: 'guarded',
    vanity: {
      prefix: 'MKT',
      suffix: 'K1T',
      candidateCount: 2,
    },
    poolTopology: {
      targetMarketCapUsd: '250,000',
      pools: [
        {
          id: 'sol-main',
          quoteToken: 'SOL',
          quoteSymbol: 'SOL',
          supplyPercent: 70,
          distribution: [{ sharePercent: 48 }, { sharePercent: 1 }, { sharePercent: 1 }],
          ladder: { mode: 'simple', bandCount: 5 },
          support: { mode: 'custom', solValue: 0.35, depthPct: 12 },
        },
        {
          id: 'usdc-flywheel',
          quoteToken: 'USDC',
          quoteSymbol: 'USDC',
          supplyPercent: 10,
          distribution: [{ sharePercent: 100 }],
        },
      ],
      preallocation: { enabled: true, supplyPercent: 3, source: 'team-reserve' },
      airdrop: { enabled: true, recipientCount: 24, supplyPercent: 2 },
      sweepDestination: VALID_SWEEP_DESTINATION,
    },
    recovery: {
      activeJournalCount: 1,
      failedJournalCount: 0,
      pendingWalletCount: 1,
    },
  };
  const plan = buildV2LaunchPlan(input, { demoMode: true, now: '2026-06-20T12:00:00.000Z' });

  assert.equal(plan.contractVersion, 1);
  assert.equal(plan.source, 'local-api');
  assert.equal(plan.runtime, 'demo');
  assert.equal(plan.generatedAt, '2026-06-20T12:00:00.000Z');
  assert.equal(plan.v2LaunchConfigFingerprint, launchPlanConfigFingerprint(input));
  assert.equal(plan.v2LaunchWalletFingerprint, launchPlanWalletFingerprint(input.walletPublicKey));
  assert.deepEqual(plan.token, {
    name: 'MoonKit',
    symbol: 'MKT',
    supply: '1000000000',
    decimals: 9,
    description: 'Community token launch',
    logo: {
      name: 'moon.png',
      mimeType: 'image/png',
      sizeBytes: VALID_PNG_LOGO_BYTES.length,
      dataUrl: VALID_PNG_LOGO_DATA_URL,
    },
  });
  assert.deepEqual(plan.vanity, {
    mode: 'both',
    prefix: 'MKT',
    suffix: 'K1T',
    selectedPublicKey: null,
    candidateCount: 2,
  });
  assert.equal(plan.poolTopology.pools.length, 2);
  assert.equal(plan.poolTopology.targetMarketCapUsd, 250000);
  assert.equal(plan.poolTopology.pools[0].quoteSymbol, 'SOL');
  assert.deepEqual(
    plan.poolTopology.pools[0].distribution.map((item) => item.sharePercent),
    [96, 2, 2],
  );
  assert.equal(plan.poolTopology.pools[0].ladder.bandCount, 5);
  assert.equal(plan.poolTopology.pools[0].ladder.supplyPercent, 50);
  assert.equal(plan.poolTopology.pools[0].ladder.ceilingMultiplier, 1000);
  assert.equal(plan.poolTopology.pools[0].support.solValue, 0.35);
  assert.deepEqual(plan.poolTopology.preallocation, {
    enabled: true,
    supplyPercent: 3,
    source: 'team-reserve',
  });
  assert.equal(plan.poolTopology.reservePercent, 15);
  assert.equal(plan.poolTopology.airdrop.recipientCount, 24);
  assert.equal(plan.poolTopology.sweepDestination, VALID_SWEEP_DESTINATION);
  assert.deepEqual(plan.recovery, {
    activeJournalCount: 1,
    failedJournalCount: 0,
    pendingWalletCount: 1,
  });
  assert.equal(Object.hasOwn(plan, 'avatarCollection'), false);
  assert.equal(plan.funding.launchSol, 3.5);
  assert.ok(plan.funding.estimatedSolCost > 3.5);
  assert.ok(plan.funding.estimatedSolCost < 7, 'launch SOL must not be counted twice');
  assert.equal(plan.operations.length, 7);
  assert.equal(plan.operations.find((item) => item.id === 'v2-funding-check')?.costSol, 0);
  assert.ok(
    plan.operations.find((item) => item.id === 'v2-report-sweep')?.costSol
      >= plan.poolTopology.airdrop.executionCostSol,
    'the staged envelope includes airdrop execution cost',
  );
  assert.equal(
    plan.funding.estimatedSolCost,
    Number(plan.operations.reduce((sum, item) => sum + item.costSol, 0).toFixed(6)),
  );
  assert.ok(plan.operations.every((item) => item.kind === 'local-wallet-operation'));
  assert.ok(plan.operations.every((item) => item.source === 'v2-launch-plan'));
  assert.ok(plan.operations.every((item) => item.signer === 'trebuchet-managed-launch-wallet'));
  assert.ok(plan.operations.every((item) => item.authorization?.requiredUserAction === 'fund-and-arm'));
  assert.ok(plan.operations.every((item) => item.simulation?.decoded === true));
  assert.deepEqual(
    plan.operations.map((item) => item.id),
    [
      'v2-wallet-and-ca',
      'v2-funding-check',
      'v2-mint-metadata',
      'v2-revoke-authorities',
      'v2-create-liquidity-pools',
      'v2-lock-liquidity',
      'v2-report-sweep',
    ],
  );
  assert.match(plan.guardrails.map((item) => item.id).join(','), /metadata-valid/);
  assert.match(plan.guardrails.map((item) => item.id).join(','), /classic-pool-model/);
  assert.match(plan.guardrails.map((item) => item.id).join(','), /vanity-ca-options/);
});

test('removed collection configuration is ignored by the v2 launch contract', () => {
  const input = {
    token: { name: 'MoonKit', symbol: 'MKT', supply: '1000000' },
    launchSol: 2.5,
    poolTopology: {
      pools: [{ quoteToken: 'SOL', quoteSymbol: 'SOL', supplyPercent: 80 }],
    },
  };
  const legacyInput = {
    ...input,
    avatarCollection: {
      enabled: true,
      name: 'MoonKit Crew',
      editionSupply: 777,
    },
  };

  assert.equal(launchPlanConfigFingerprint(legacyInput), launchPlanConfigFingerprint(input));
  const plan = buildV2LaunchPlan(legacyInput, { demoMode: true });
  assert.equal(Object.hasOwn(plan, 'avatarCollection'), false);
  assert.equal(plan.operations.some((operation) => operation.id.includes('avatar')), false);
});

test('buildV2LaunchPlan rejects invalid launch config before staging', () => {
  assert.throws(
    () => buildV2LaunchPlan({ token: { name: '', symbol: 'TOK', supply: '1000' } }),
    /Token name is required/,
  );
  assert.throws(
    () => buildV2LaunchPlan({ token: { name: 'Token', symbol: 'TOOLONGSYMBOL', supply: '1000' } }),
    /10 UTF-8 bytes/,
  );
  assert.throws(
    () => buildV2LaunchPlan({ token: { name: 'Token', symbol: 'TOK', supply: '1.5' } }),
    /positive whole number/,
  );
  assert.throws(
    () => buildV2LaunchPlan({
      token: {
        name: 'Token',
        symbol: 'TOK',
        supply: '1000',
        description: 'x'.repeat(1001),
      },
    }),
    /Token description must be 1000 UTF-8 bytes or fewer/,
  );
  assert.throws(
    () => buildV2LaunchPlan({ token: { name: 'Token', symbol: 'TOK', supply: '10000000001' } }),
    /10,000,000,000/,
  );
  assert.throws(
    () => buildV2LaunchPlan({ token: { name: 'Token', symbol: 'TOK', supply: '1000' }, launchSol: -1 }),
    /Launch SOL must be a non-negative number/,
  );
  assert.throws(
    () => buildV2LaunchPlan({
      token: {
        name: 'Token',
        symbol: 'TOK',
        supply: '1000',
        logo: { dataUrl: 'data:text/plain;base64,SGVsbG8=', sizeBytes: 5 },
      },
    }),
    /Token logo must be a PNG or JPG data URL/,
  );
  assert.throws(
    () => buildV2LaunchPlan({
      token: {
        name: 'Token',
        symbol: 'TOK',
        supply: '1000',
        logo: { dataUrl: 'data:image/webp;base64,AAAAAAA=', sizeBytes: 5 },
      },
    }),
    /Token logo must be a PNG or JPG data URL/,
  );
  assert.throws(
    () => buildV2LaunchPlan({
      token: {
        name: 'Token',
        symbol: 'TOK',
        supply: '1000',
        logo: { dataUrl: 'data:image/png;base64,aGVsbG8=', sizeBytes: 5 },
      },
    }),
    /Logo must be a PNG or JPG image/,
  );
  const tinyPng = logoDataUrl('image/png', pngLogoBytes(1, 1));
  assert.throws(
    () => buildV2LaunchPlan({
      token: {
        name: 'Token',
        symbol: 'TOK',
        supply: '1000',
        logo: { dataUrl: tinyPng, sizeBytes: 33 },
      },
    }),
    /minimum is 64x64px/,
  );
  const oversizedPng = logoDataUrl('image/png', pngLogoBytes(2048, 1024));
  assert.throws(
    () => buildV2LaunchPlan({
      token: {
        name: 'Token',
        symbol: 'TOK',
        supply: '1000',
        logo: { dataUrl: oversizedPng, sizeBytes: 33 },
      },
    }),
    /max is 1024x1024px/,
  );
  const dimensionlessJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xda]).toString('base64');
  assert.throws(
    () => buildV2LaunchPlan({
      token: {
        name: 'Token',
        symbol: 'TOK',
        supply: '1000',
        logo: { dataUrl: `data:image/jpeg;base64,${dimensionlessJpeg}`, sizeBytes: 4 },
      },
    }),
    /dimensions could not be read/,
  );
  const oversizedJpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0x00]), Buffer.alloc(100 * 1024)])
    .toString('base64');
  assert.throws(
    () => buildV2LaunchPlan({
      token: {
        name: 'Token',
        symbol: 'TOK',
        supply: '1000',
        logo: { dataUrl: `data:image/jpeg;base64,${oversizedJpeg}`, sizeBytes: 1 },
      },
    }),
    /100KB or smaller/,
  );
  assert.throws(
    () => buildV2LaunchPlan({
      token: { name: 'Token', symbol: 'TOK', supply: '1000' },
      vanity: { prefix: 'MOON' },
    }),
    /invalid Base58/,
  );
  assert.throws(
    () => buildV2LaunchPlan({
      token: { name: 'Token', symbol: 'TOK', supply: '1000' },
      vanity: { selectedPublicKey: 'Vanity111' },
    }),
    /valid Solana address/,
  );
  assert.throws(
    () => buildV2LaunchPlan({
      token: { name: 'Token', symbol: 'TOK', supply: '1000' },
      vanity: { prefix: 'MKT', suffix: 'K1T', selectedPublicKey: `MKT${'1'.repeat(26)}BAD` },
    }),
    /does not end with K1T/,
  );
});

test('v2FundingEstimateFingerprint changes when held preallocation changes', () => {
  const baseInput = {
    token: { name: 'MoonKit', symbol: 'MKT', supply: '1000000' },
    poolTopology: {
      targetMarketCapUsd: 250000,
      pools: [{ quoteToken: 'SOL', quoteSymbol: 'SOL', supplyPercent: 80 }],
      preallocation: { enabled: true, supplyPercent: 5, source: 'team-reserve' },
      airdrop: { enabled: false, recipientCount: 0 },
    },
  };
  const changedInput = {
    ...baseInput,
    poolTopology: {
      ...baseInput.poolTopology,
      preallocation: { enabled: true, supplyPercent: 6, source: 'team-reserve' },
    },
  };

  assert.notEqual(v2FundingEstimateFingerprint(baseInput), v2FundingEstimateFingerprint(changedInput));
});

test('buildV2LaunchPlan marks non-demo runtime as preview-only', () => {
  const plan = buildV2LaunchPlan(
    { token: { name: 'Token', symbol: 'TOK', supply: '1000' }, launchSol: 0 },
    { demoMode: false, now: '2026-06-20T12:00:00.000Z' },
  );

  assert.equal(plan.runtime, 'local');
  assert.equal(plan.guardrails.find((item) => item.id === 'demo-runtime')?.state, 'warn');
  assert.match(
    plan.guardrails.find((item) => item.id === 'demo-runtime')?.detail,
    /encrypted local launch wallet/,
  );
});

test('buildV2LaunchPlan keeps maximum-length token symbols inside Solana metadata limits', () => {
  const plan = buildV2LaunchPlan(
    { token: { name: 'Ten Bytes', symbol: 'TENBYTES10', supply: '1000' } },
    { demoMode: true, now: '2026-06-20T12:00:00.000Z' },
  );

  assert.equal(plan.token.symbol, 'TENBYTES10');
  assert.equal(Object.hasOwn(plan, 'avatarCollection'), false);
  assert.equal(plan.poolTopology.pools[1].id, 'meme-flywheel');
  assert.equal(plan.poolTopology.pools[1].quoteToken, 'HipYKXiDh3Kjd1jb7ji6jCEsKQMSGWiFJMdtvH8yb5r');
  assert.equal(plan.poolTopology.pools[1].quoteMint, 'HipYKXiDh3Kjd1jb7ji6jCEsKQMSGWiFJMdtvH8yb5r');
  assert.equal(plan.poolTopology.pools[1].quoteSymbol, 'MEME');
});

test('complex pool topology round-trips into classic execution payloads', () => {
  const input = {
    token: { name: 'Round Trip', symbol: 'RTP', supply: '1000000' },
    launchSol: 4.25,
    poolTopology: {
      targetMarketCapUsd: 777000,
      feeKeyRecipient: 'DefaultFeeKey111',
      sweepDestination: VALID_ROUND_TRIP_DESTINATION,
      pools: [
        {
          id: 'sol-main',
          quoteToken: 'SOL',
          quoteSymbol: 'SOL',
          supplyPercent: 62.5,
          ammConfigIndex: 8,
          distribution: [
            { sharePercent: 48, recipient: '11111111111111111111111111111112' },
            { sharePercent: 1 },
            { sharePercent: 1, recipient: '11111111111111111111111111111113' },
          ],
          bootstrap: { mode: 'custom', supplyPercent: 0.75 },
          ladder: {
            mode: 'manual',
            bands: [
              { supplyPercent: 2.5, lowerMultiplier: 1.1, upperMultiplier: 1.4 },
              { supplyPercent: 1.25, lowerMultiplier: 1.4, upperMultiplier: 2.2 },
            ],
          },
          support: { mode: 'custom', solValue: 0.42, depthPct: 18 },
        },
        {
          id: 'bonk-flywheel',
          quoteToken: 'BonkMint111',
          quoteMint: 'BonkMint111',
          quoteSymbolOverride: 'BONK',
          quoteDecimals: 5,
          quotePriceUsd: 0.00002,
          quotePriceSource: 'geckoterminal',
          quoteCompatibility: {
            compatible: true,
            raydiumTradeable: 'yes',
            freezeAuthorityBlock: false,
            mintAuthorityWarning: true,
            isToken2022: false,
          },
          supplyPercent: 7.25,
          ammConfigIndex: 12,
          distribution: [
            { sharePercent: 70 },
            { sharePercent: 30, recipient: '11111111111111111111111111111114' },
          ],
          ladder: { mode: 'simple', bandCount: 3, supplyPercent: 55, ceilingMultiplier: 1200 },
          support: { mode: 'custom', solValue: 0.25, depthPct: 22 },
        },
      ],
      airdrop: {
        enabled: true,
        recipientCount: 2,
        supplyPercent: 3.5,
        requestedSupplyPercent: 2,
        requiredSupplyPercent: 3.5,
        autoFit: true,
        budgetTokens: 35000,
        explicitTokens: 30000,
        remainingTokens: 5000,
        executionCostSol: 0.0042,
        source: 'csv',
        recipients: [
          { wallet: VALID_AIRDROP_WALLET_ONE, tokens: 12345 },
          { recipient: VALID_AIRDROP_WALLET_TWO, amount: 6789 },
        ],
      },
    },
    funding: { estimate: { totalSol: 4.2 } },
  };
  const plan = buildV2LaunchPlan(input, { demoMode: false, now: '2026-06-20T12:00:00.000Z' });
  const readiness = buildV2ExecutionReadiness(input, {
    demoMode: false,
    walletPublicKey: '11111111111111111111111111111111',
    walletAvailable: true,
    secretAvailable: true,
    secretPinLocked: false,
    tokenMint: 'MintRoundTrip111',
    priorResults: [{ allocationIndex: 0, poolId: 'PoolExisting111' }],
    now: '2026-06-20T12:00:00.000Z',
  });

  assert.equal(plan.poolTopology.pools.length, 2);
  assert.equal(plan.poolTopology.pools[1].quoteSymbol, 'BONK');
  assert.equal(plan.poolTopology.pools[1].quoteMint, 'BonkMint111');
  assert.equal(plan.poolTopology.pools[1].quoteDecimalsOverride, 5);
  assert.equal(plan.poolTopology.pools[1].quoteUsdOverride, 0.00002);
  assert.equal(plan.poolTopology.pools[1].quotePriceSource, 'geckoterminal');
  assert.deepEqual(plan.poolTopology.pools[1].quoteCompatibility, {
    compatible: true,
    raydiumTradeable: 'yes',
    freezeAuthorityBlock: false,
    mintAuthorityWarning: true,
    isToken2022: false,
  });
  assert.equal(plan.poolTopology.pools[1].ammConfigIndex, 12);
  assert.deepEqual(plan.poolTopology.pools[0].distribution.map((row) => row.sharePercent), [96, 2, 2]);
  assert.equal(plan.poolTopology.pools[0].distribution[0].recipient, '11111111111111111111111111111112');
  assert.equal(plan.poolTopology.pools[0].bootstrap.supplyPercent, 0.75);
  assert.deepEqual(plan.poolTopology.pools[0].ladder.bands, [
    { supplyPercent: 2.5, lowerMultiplier: 1.1, upperMultiplier: 1.4 },
    { supplyPercent: 1.25, lowerMultiplier: 1.4, upperMultiplier: 2.2 },
  ]);
  assert.deepEqual(plan.poolTopology.pools[1].ladder, {
    mode: 'simple',
    bandCount: 3,
    supplyPercent: 55,
    ceilingMultiplier: 1200,
  });
  assert.deepEqual(plan.poolTopology.pools[1].support, { mode: 'custom', solValue: 0.25, depthPct: 22 });
  assert.equal(plan.poolTopology.airdrop.requestedSupplyPercent, 2);
  assert.equal(plan.poolTopology.airdrop.requiredSupplyPercent, 3.5);
  assert.equal(plan.poolTopology.airdrop.budgetTokens, 35000);
  assert.equal(plan.poolTopology.airdrop.recipients[1].wallet, VALID_AIRDROP_WALLET_TWO);
  assert.deepEqual(plan.poolTopology.allocations, readiness.classicPayloads.createLp.allocations);

  const [solAlloc, bonkAlloc] = readiness.classicPayloads.createLp.allocations;
  assert.equal(readiness.nextEndpoint, '/api/resume-launch');
  assert.equal(readiness.classicPayloads.resumeLaunch.priorResults[0].poolId, 'PoolExisting111');
  assert.equal(readiness.classicPayloads.preflightCreateLp.targetMarketCapUsd, 777000);
  assert.equal(solAlloc.quoteToken, 'SOL');
  assert.equal(solAlloc.supplyPercent, 62.5);
  assert.equal(solAlloc.distribution[2].recipient, '11111111111111111111111111111113');
  assert.equal(solAlloc.bootstrap.supplyPercent, 0.75);
  assert.equal(solAlloc.ladder.bands[1].upperMultiplier, 2.2);
  assert.equal(solAlloc.support.depthPct, 18);
  assert.equal(bonkAlloc.quoteToken, 'BonkMint111');
  assert.equal(bonkAlloc.quoteMint, 'BonkMint111');
  assert.equal(bonkAlloc.quoteSymbolOverride, 'BONK');
  assert.equal(bonkAlloc.quoteDecimalsOverride, 5);
  assert.equal(bonkAlloc.quoteUsdOverride, 0.00002);
  assert.equal(readiness.classicPayloads.estimateFunding.allocations[1].quoteDecimalsOverride, 5);
  assert.equal(readiness.classicPayloads.estimateFunding.allocations[1].quoteUsdOverride, 0.00002);
  assert.equal(readiness.classicPayloads.preflightCreateLp.allocations[1].quoteDecimalsOverride, 5);
  assert.equal(readiness.classicPayloads.preflightCreateLp.allocations[1].quoteUsdOverride, 0.00002);
  assert.equal(bonkAlloc.ammConfigIndex, 12);
  assert.equal(bonkAlloc.distribution[1].recipient, '11111111111111111111111111111114');
  assert.equal(bonkAlloc.ladder.bandCount, 3);
  assert.equal(bonkAlloc.ladder.supplyPercent, 55);
  assert.equal(bonkAlloc.ladder.ceilingMultiplier, 1200);
  assert.equal(bonkAlloc.support.solValue, 0.25);
  assert.deepEqual(readiness.classicPayloads.createLp.airdrop, {
    tokenMint: 'MintRoundTrip111',
    tokenDecimals: 9,
    recipientCount: 2,
    recipients: [
      { wallet: VALID_AIRDROP_WALLET_ONE, tokens: 12345 },
      { recipient: VALID_AIRDROP_WALLET_TWO, amount: 6789, wallet: VALID_AIRDROP_WALLET_TWO, tokens: 6789 },
    ],
  });
});

test('buildV2ExecutionReadiness blocks execution without a managed wallet secret', () => {
  const readiness = buildV2ExecutionReadiness(
    { token: { name: 'MoonKit', symbol: 'MKT', supply: '1000' } },
    { demoMode: false, now: '2026-06-20T12:00:00.000Z' },
  );

  assert.equal(readiness.status, 'blocked');
  assert.equal(readiness.nextEndpoint, null);
  assert.match(readiness.blockers.map((item) => item.id).join(','), /wallet-missing/);
  assert.equal(readiness.phases.find((phase) => phase.id === 'wallet')?.state, 'blocked');
});

test('buildV2ExecutionReadiness blocks live execution until classic funding is estimated', () => {
  const readiness = buildV2ExecutionReadiness(
    {
      token: { name: 'MoonKit', symbol: 'MKT', supply: '1000' },
      poolTopology: { targetMarketCapUsd: 250000 },
    },
    {
      demoMode: false,
      walletPublicKey: '11111111111111111111111111111111',
      walletAvailable: true,
      secretAvailable: true,
      secretPinLocked: false,
      now: '2026-06-20T12:00:00.000Z',
    },
  );

  assert.equal(readiness.status, 'blocked');
  assert.equal(readiness.nextEndpoint, null);
  assert.match(readiness.blockers.map((item) => item.id).join(','), /funding-not-estimated/);
  assert.equal(readiness.phases.find((phase) => phase.id === 'funding')?.state, 'blocked');
});

test('buildV2ExecutionReadiness rejects stale funding estimates when server enforcement is enabled', () => {
  const input = {
    token: { name: 'MoonKit', symbol: 'MKT', supply: '1000000', decimals: 9 },
    poolTopology: {
      targetMarketCapUsd: 250000,
      sweepDestination: VALID_SWEEP_DESTINATION,
      report: { publish: true },
      pools: [{
        id: 'sol-main',
        quoteToken: 'SOL',
        quoteSymbol: 'SOL',
        supplyPercent: 100,
        ammConfigIndex: 8,
        distribution: [{ sharePercent: 100 }],
        bootstrap: { mode: 'minimal' },
        ladder: { mode: 'off' },
        support: { mode: 'off' },
      }],
      allocations: [{
        quoteToken: 'SOL',
        quoteSymbolOverride: 'SOL',
        supplyPercent: 100,
        ammConfigIndex: 8,
        distribution: [{ sharePercent: 100 }],
        bootstrap: { mode: 'minimal' },
        ladder: { mode: 'off' },
        support: { mode: 'off' },
      }],
      airdrop: {
        enabled: false,
        recipientCount: 0,
        supplyPercent: 0,
        executionCostSol: 0,
      },
    },
  };
  const context = {
    demoMode: false,
    walletPublicKey: '11111111111111111111111111111111',
    walletAvailable: true,
    secretAvailable: true,
    secretPinLocked: false,
    requireCurrentFundingEstimate: true,
    rpc: { activeUrl: 'https://mainnet.helius-rpc.com/?api-key=test' },
    now: '2026-06-20T12:00:00.000Z',
  };

  const unstamped = buildV2ExecutionReadiness({
    ...input,
    funding: { estimate: { totalSol: 2.4 } },
  }, context);
  assert.equal(unstamped.status, 'blocked');
  assert.match(unstamped.blockers.map((item) => item.id).join(','), /funding-estimate-stale/);
  assert.match(unstamped.phases.find((phase) => phase.id === 'funding')?.detail || '', /stale/);

  const current = buildV2ExecutionReadiness({
    ...input,
    funding: { estimate: attachFundingFingerprint(input, { totalSol: 2.4 }) },
  }, context);
  assert.equal(current.status, 'ready');
  assert.doesNotMatch(current.blockers.map((item) => item.id).join(','), /funding-estimate-stale/);
  assert.equal(current.nextEndpoint, '/api/create-token');

  const changedInput = {
    ...input,
    token: { ...input.token, supply: '2000000' },
    funding: { estimate: attachFundingFingerprint(input, { totalSol: 2.4 }) },
  };
  const staleAfterEdit = buildV2ExecutionReadiness(changedInput, context);
  assert.equal(staleAfterEdit.status, 'blocked');
  assert.match(staleAfterEdit.blockers.map((item) => item.id).join(','), /funding-estimate-stale/);

  const staleAllocationSummaryInput = {
    ...input,
    poolTopology: {
      ...input.poolTopology,
      pools: [{
        ...input.poolTopology.pools[0],
        supplyPercent: 60,
      }],
      // This stale summary used to be enough to make a stale estimate look current.
      allocations: input.poolTopology.allocations,
    },
    funding: { estimate: attachFundingFingerprint(input, { totalSol: 2.4 }) },
  };
  const staleAllocationSummary = buildV2ExecutionReadiness(staleAllocationSummaryInput, context);
  assert.equal(staleAllocationSummary.status, 'blocked');
  assert.match(staleAllocationSummary.blockers.map((item) => item.id).join(','), /funding-estimate-stale/);
});

test('buildV2ExecutionReadiness requires a live balance check when server-enforced', () => {
  const readiness = buildV2ExecutionReadiness(
    {
      token: { name: 'MoonKit', symbol: 'MKT', supply: '1000' },
      poolTopology: { targetMarketCapUsd: 250000 },
      funding: { estimate: { totalSol: 2.4 } },
    },
    {
      demoMode: false,
      walletPublicKey: '11111111111111111111111111111111',
      walletAvailable: true,
      secretAvailable: true,
      secretPinLocked: false,
      requireFundingBalance: true,
      now: '2026-06-20T12:00:00.000Z',
    },
  );

  assert.equal(readiness.status, 'blocked');
  assert.equal(readiness.nextEndpoint, null);
  assert.match(readiness.blockers.map((item) => item.id).join(','), /funding-balance-unverified/);
  assert.equal(readiness.phases.find((phase) => phase.id === 'funding')?.state, 'blocked');
});

test('buildV2ExecutionReadiness blocks fresh live execution on public RPC', () => {
  const readiness = buildV2ExecutionReadiness(
    {
      token: { name: 'MoonKit', symbol: 'MKT', supply: '1000000' },
      poolTopology: {
        targetMarketCapUsd: 250000,
        sweepDestination: VALID_SWEEP_DESTINATION,
      },
      funding: { estimate: { totalSol: 2.4 } },
    },
    {
      demoMode: false,
      walletPublicKey: '11111111111111111111111111111111',
      walletAvailable: true,
      secretAvailable: true,
      secretPinLocked: false,
      rpc: { activeUrl: 'https://api.mainnet-beta.solana.com' },
      now: '2026-06-20T12:00:00.000Z',
    },
  );

  assert.equal(readiness.status, 'blocked');
  assert.equal(readiness.nextEndpoint, null);
  assert.match(readiness.blockers.map((item) => item.id).join(','), /rpc-public-endpoint/);
  assert.match(readiness.blockers.map((item) => item.detail).join(' '), /public Solana endpoint/);
  assert.equal(readiness.phases.find((phase) => phase.id === 'funding')?.state, 'blocked');
  assert.equal(readiness.plan.guardrails.find((item) => item.id === 'rpc-posture')?.state, 'danger');
});

test('buildV2ExecutionReadiness allows dedicated RPC for fresh live execution', () => {
  const readiness = buildV2ExecutionReadiness(
    {
      token: { name: 'MoonKit', symbol: 'MKT', supply: '1000000' },
      poolTopology: {
        targetMarketCapUsd: 250000,
        sweepDestination: VALID_SWEEP_DESTINATION,
      },
      funding: { estimate: { totalSol: 2.4 } },
    },
    {
      demoMode: false,
      walletPublicKey: '11111111111111111111111111111111',
      walletAvailable: true,
      secretAvailable: true,
      secretPinLocked: false,
      rpc: { activeUrl: 'https://mainnet.helius-rpc.com/?api-key=test' },
      now: '2026-06-20T12:00:00.000Z',
    },
  );

  assert.equal(readiness.status, 'ready');
  assert.equal(readiness.nextEndpoint, '/api/create-token');
  assert.doesNotMatch(readiness.blockers.map((item) => item.id).join(','), /rpc-public-endpoint/);
  assert.equal(readiness.plan.guardrails.find((item) => item.id === 'rpc-posture')?.state, 'pass');
});

test('buildV2ExecutionReadiness blocks server-enforced execution when wallet funding is short', () => {
  const readiness = buildV2ExecutionReadiness(
    {
      token: { name: 'MoonKit', symbol: 'MKT', supply: '1000' },
      poolTopology: {
        targetMarketCapUsd: 250000,
        sweepDestination: VALID_SWEEP_DESTINATION,
      },
      funding: {
        estimate: {
          totalSol: 2.4,
          subtotalSol: 2,
          byQuote: { ManualMint111: '2500000' },
          quoteBreakdown: [{ mint: 'ManualMint111', symbol: 'MAN', amount: 2.5 }],
          autoSwapPlan: [{
            quoteMint: 'AutoMint111',
            quoteSymbol: 'AUTO',
            minRaw: '1000',
            targetRaw: '2000',
            estSolSpend: 0.4,
          }],
        },
      },
    },
    {
      demoMode: false,
      walletPublicKey: '11111111111111111111111111111111',
      walletAvailable: true,
      secretAvailable: true,
      secretPinLocked: false,
      requireFundingBalance: true,
      walletBalance: {
        sol: 1,
        tokens: {
          ManualMint111: { amountRaw: '2499999', amountUi: 2.499999, decimals: 6 },
          AutoMint111: { amountRaw: '999', amountUi: 0.000999, decimals: 6 },
        },
      },
      now: '2026-06-20T12:00:00.000Z',
    },
  );

  const blockerIds = readiness.blockers.map((item) => item.id).join(',');
  assert.equal(readiness.status, 'blocked');
  assert.equal(readiness.nextEndpoint, null);
  assert.match(blockerIds, /funding-sol-short/);
  assert.match(blockerIds, /funding-quote-short-1/);
  assert.match(blockerIds, /funding-quote-short-2/);
  assert.match(readiness.blockers.map((item) => item.detail).join('\n'), /Classic needs/);
});

test('server funding gate does not add airdrop execution cost twice', () => {
  const input = {
    token: { name: 'MoonKit', symbol: 'MKT', supply: '1000' },
    poolTopology: {
      targetMarketCapUsd: 250000,
      sweepDestination: VALID_SWEEP_DESTINATION,
      airdrop: {
        enabled: true,
        recipientCount: 10,
        supplyPercent: 2,
        executionCostSol: 0.0204428,
        recipients: Array.from({ length: 10 }, (_, index) => ({
          wallet: index % 2 === 0 ? VALID_AIRDROP_WALLET_ONE : VALID_AIRDROP_WALLET_TWO,
          tokens: 1,
        })),
      },
    },
    funding: {
      estimate: {
        totalSol: 2.0204428,
        subtotalSol: 2.0204428,
        includesAirdropExecutionCost: true,
      },
    },
  };
  const readiness = buildV2ExecutionReadiness(input, {
    demoMode: false,
    walletPublicKey: '11111111111111111111111111111111',
    walletAvailable: true,
    secretAvailable: true,
    secretPinLocked: false,
    requireFundingBalance: true,
    walletBalance: { sol: 2.0204428, tokens: {} },
    now: '2026-06-20T12:00:00.000Z',
  });

  assert.doesNotMatch(readiness.blockers.map((item) => item.id).join(','), /funding-sol-short/);
});

test('buildV2ExecutionReadiness credits acquired quote swaps for the server funding gate', () => {
  const readiness = buildV2ExecutionReadiness(
    {
      token: { name: 'MoonKit', symbol: 'MKT', supply: '1000' },
      poolTopology: {
        targetMarketCapUsd: 250000,
        sweepDestination: VALID_SWEEP_DESTINATION,
      },
      funding: {
        estimate: {
          totalSol: 2.4,
          subtotalSol: 2,
          byQuote: { ManualMint111: '2500000' },
          quoteBreakdown: [{ mint: 'ManualMint111', symbol: 'MAN', amount: 2.5 }],
          autoSwapPlan: [{
            quoteMint: 'AutoMint111',
            quoteSymbol: 'AUTO',
            minRaw: '1000',
            targetRaw: '2000',
            estSolSpend: 0.4,
          }],
        },
      },
    },
    {
      demoMode: false,
      walletPublicKey: '11111111111111111111111111111111',
      walletAvailable: true,
      secretAvailable: true,
      secretPinLocked: false,
      requireFundingBalance: true,
      walletBalance: {
        sol: 1.61,
        tokens: {
          ManualMint111: { amountRaw: '2500000', amountUi: 2.5, decimals: 6 },
          AutoMint111: { amountRaw: '1000', amountUi: 0.001, decimals: 6 },
        },
      },
      now: '2026-06-20T12:00:00.000Z',
    },
  );

  assert.equal(readiness.status, 'ready');
  assert.equal(readiness.nextEndpoint, '/api/create-token');
  assert.doesNotMatch(readiness.blockers.map((item) => item.id).join(','), /funding-/);
  assert.equal(
    readiness.phases.find((phase) => phase.id === 'funding')?.detail,
    'Classic funding estimate and launch-wallet balance are verified.',
  );
});

test('buildV2ExecutionReadiness credits completed token creation before LP funding checks', () => {
  const readiness = buildV2ExecutionReadiness(
    {
      token: { name: 'MoonKit', symbol: 'MKT', supply: '1000' },
      poolTopology: {
        targetMarketCapUsd: 250000,
        sweepDestination: VALID_SWEEP_DESTINATION,
      },
      funding: {
        estimate: {
          totalSol: 1.2,
          subtotalSol: 1,
          solBreakdown: [
            { label: 'Token creation (mint + metadata)', sol: 0.08 },
            { label: 'Pool 1 (SOL): pool creation', sol: 0.92 },
          ],
          byQuote: {},
          autoSwapPlan: [],
        },
      },
    },
    {
      demoMode: false,
      walletPublicKey: '11111111111111111111111111111111',
      walletAvailable: true,
      secretAvailable: true,
      secretPinLocked: false,
      requireFundingBalance: true,
      tokenMint: 'Mint111',
      walletBalance: { sol: 0.921, tokens: {} },
      now: '2026-06-20T12:00:00.000Z',
    },
  );

  assert.equal(readiness.status, 'ready');
  assert.equal(readiness.nextEndpoint, '/api/create-lp');
  assert.doesNotMatch(readiness.blockers.map((item) => item.id).join(','), /funding-sol-short/);
});

test('buildV2ExecutionReadiness does not require a fresh funding estimate for resume or sweep recovery', () => {
  const baseInput = {
    token: { name: 'MoonKit', symbol: 'MKT', supply: '1000' },
    poolTopology: {
      targetMarketCapUsd: 250000,
      sweepDestination: VALID_SWEEP_DESTINATION,
    },
  };
  const baseContext = {
    demoMode: false,
    walletPublicKey: '11111111111111111111111111111111',
    walletAvailable: true,
    secretAvailable: true,
    secretPinLocked: false,
    requireFundingBalance: true,
    tokenMint: 'Mint111',
    now: '2026-06-20T12:00:00.000Z',
  };

  const resume = buildV2ExecutionReadiness(baseInput, {
    ...baseContext,
    priorResults: [{ allocationIndex: 0, poolId: 'Pool111' }],
  });
  const sweep = buildV2ExecutionReadiness(baseInput, {
    ...baseContext,
    liquidityComplete: true,
  });

  assert.equal(resume.status, 'ready');
  assert.equal(resume.nextEndpoint, '/api/resume-launch');
  assert.doesNotMatch(resume.blockers.map((item) => item.id).join(','), /funding-not-estimated/);
  assert.equal(sweep.status, 'ready');
  assert.equal(sweep.nextEndpoint, '/api/transfer-assets');
  assert.doesNotMatch(sweep.blockers.map((item) => item.id).join(','), /funding-not-estimated/);
});

test('buildV2ExecutionReadiness keeps public RPC recoverable for final sweep', () => {
  const readiness = buildV2ExecutionReadiness(
    {
      token: { name: 'MoonKit', symbol: 'MKT', supply: '1000000' },
      poolTopology: {
        targetMarketCapUsd: 250000,
        sweepDestination: VALID_SWEEP_DESTINATION,
      },
    },
    {
      demoMode: false,
      walletPublicKey: '11111111111111111111111111111111',
      walletAvailable: true,
      secretAvailable: true,
      secretPinLocked: false,
      tokenMint: 'Mint111',
      liquidityComplete: true,
      rpc: { activeUrl: 'https://solana.public-rpc.com' },
      now: '2026-06-20T12:00:00.000Z',
    },
  );

  assert.equal(readiness.status, 'ready');
  assert.equal(readiness.nextEndpoint, '/api/transfer-assets');
  assert.doesNotMatch(readiness.blockers.map((item) => item.id).join(','), /rpc-public-endpoint/);
  assert.match(readiness.warnings.map((item) => item.id).join(','), /rpc-public-endpoint/);
  assert.equal(readiness.plan.guardrails.find((item) => item.id === 'rpc-posture')?.state, 'danger');
});

test('buildV2ExecutionReadiness maps a ready setup to classic create-token payloads', () => {
  const readiness = buildV2ExecutionReadiness(
    {
      token: {
        name: 'MoonKit',
        symbol: 'MKT',
        supply: '1000',
        description: 'AI swarm launch',
        logo: {
          name: 'mkt.jpg',
          mimeType: 'image/jpeg',
          sizeBytes: VALID_JPEG_LOGO_BYTES.length,
          dataUrl: VALID_JPEG_LOGO_DATA_URL,
        },
      },
      vanity: {
        prefix: 'MKT',
        suffix: 'K1T',
        selectedPublicKey: VALID_VANITY_PUBLIC_KEY,
      },
      poolTopology: {
        targetMarketCapUsd: 250000,
        sweepDestination: VALID_SWEEP_DESTINATION,
      },
      funding: { estimate: { totalSol: 2.4 } },
    },
    {
      demoMode: false,
      walletPublicKey: '11111111111111111111111111111111',
      walletAvailable: true,
      secretAvailable: true,
      secretPinLocked: false,
      now: '2026-06-20T12:00:00.000Z',
    },
  );

  assert.equal(readiness.status, 'ready');
  assert.equal(readiness.nextEndpoint, '/api/create-token');
  assert.equal(readiness.nextAction, 'Create token');
  assert.deepEqual(readiness.classicPayloads.createToken, {
    walletPublicKey: '11111111111111111111111111111111',
    name: 'MoonKit',
    symbol: 'MKT',
    description: 'AI swarm launch',
    totalSupply: '1000',
    logo: {
      name: 'mkt.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: VALID_JPEG_LOGO_BYTES.length,
      dataUrl: VALID_JPEG_LOGO_DATA_URL,
    },
    vanityCAPublicKey: VALID_VANITY_PUBLIC_KEY,
    vanityPrefix: null,
    vanitySuffix: null,
  });
  assert.equal(readiness.classicPayloads.estimateFunding.targetMarketCapUsd, 250000);
  assert.equal(readiness.classicPayloads.createLp.tokenMint, null);
  assert.equal(readiness.phases.find((phase) => phase.id === 'token')?.endpoint, '/api/create-token');
  assert.equal(readiness.phases.find((phase) => phase.id === 'liquidity')?.state, 'waiting');
});

test('buildV2ExecutionReadiness advances from created token to create-lp, resume, and sweep endpoints', () => {
  const baseInput = {
    token: { name: 'MoonKit', symbol: 'MKT', supply: '1000' },
    poolTopology: {
      targetMarketCapUsd: 250000,
      sweepDestination: VALID_SWEEP_DESTINATION,
    },
    funding: { estimate: { totalSol: 2.4 } },
  };
  const context = {
    demoMode: false,
    walletPublicKey: '11111111111111111111111111111111',
    walletAvailable: true,
    secretAvailable: true,
    secretPinLocked: false,
    tokenMint: 'Mint111',
    now: '2026-06-20T12:00:00.000Z',
  };

  const createLp = buildV2ExecutionReadiness(baseInput, context);
  const resume = buildV2ExecutionReadiness(baseInput, {
    ...context,
    priorResults: [{ allocationIndex: 0, poolId: 'Pool111' }],
  });
  const sweep = buildV2ExecutionReadiness(baseInput, {
    ...context,
    liquidityComplete: true,
  });
  const complete = buildV2ExecutionReadiness(baseInput, {
    ...context,
    liquidityComplete: true,
    transfer: {
      destinationWallet: VALID_SWEEP_DESTINATION,
      walletEmpty: true,
      tokenSweep: { transferred: [], errors: [] },
      nftSweep: { transferred: [], errors: [] },
    },
  });
  const flagOnlyComplete = buildV2ExecutionReadiness(baseInput, {
    ...context,
    liquidityComplete: true,
    transferComplete: true,
  });

  assert.equal(createLp.nextEndpoint, '/api/create-lp');
  assert.equal(createLp.classicPayloads.createLp.tokenMint, 'Mint111');
  assert.equal(resume.nextEndpoint, '/api/resume-launch');
  assert.equal(resume.classicPayloads.resumeLaunch.priorResults.length, 1);
  assert.equal(sweep.nextEndpoint, '/api/transfer-assets');
  assert.equal(sweep.classicPayloads.transferAssets.destinationWallet, VALID_SWEEP_DESTINATION);
  assert.equal(complete.nextEndpoint, null);
  assert.equal(complete.nextAction, 'Launch complete');
  assert.equal(complete.completed, true);
  assert.equal(complete.completionStatus, 'complete');
  assert.equal(complete.completion.terminalSweepEvidence, true);
  assert.equal(complete.phases.find((phase) => phase.id === 'sweep')?.state, 'complete');
  assert.equal(flagOnlyComplete.nextEndpoint, '/api/transfer-assets');
  assert.equal(flagOnlyComplete.completed, false);
  assert.equal(flagOnlyComplete.completionStatus, 'pending');
  assert.equal(flagOnlyComplete.completion.terminalSweepEvidence, false);
  assert.equal(flagOnlyComplete.phases.find((phase) => phase.id === 'sweep')?.state, 'ready');
  assert.deepEqual(
    Object.values(sweep.classicEndpoints),
    [
      '/api/create-token',
      '/api/estimate-lp-funding',
      '/api/preflight-create-lp',
      '/api/create-lp',
      '/api/resume-launch',
      '/api/transfer-assets',
    ],
  );
});

test('buildV2ExecutionReadiness keeps sweep recoverable until terminal transfer evidence', () => {
  const baseInput = {
    token: { name: 'MoonKit', symbol: 'MKT', supply: '1000' },
    poolTopology: {
      targetMarketCapUsd: 250000,
      sweepDestination: VALID_SWEEP_DESTINATION,
    },
    funding: { estimate: { totalSol: 2.4 } },
  };
  const context = {
    demoMode: false,
    walletPublicKey: '11111111111111111111111111111111',
    walletAvailable: true,
    secretAvailable: true,
    secretPinLocked: false,
    tokenMint: 'Mint111',
    liquidityComplete: true,
    now: '2026-06-20T12:00:00.000Z',
  };

  const incompleteJournal = buildV2ExecutionReadiness(baseInput, {
    ...context,
    journal: {
      status: 'completed',
      stage: 'transfer_completed',
      transfer: {
        status: 'planned-before-sweep',
        destinationWallet: VALID_SWEEP_DESTINATION,
      },
    },
  });
  const terminalJournal = buildV2ExecutionReadiness(baseInput, {
    ...context,
    journal: {
      status: 'completed',
      stage: 'transfer_completed',
      transfer: {
        destinationWallet: VALID_SWEEP_DESTINATION,
        walletEmpty: true,
        tokenSweep: { transferred: [], errors: [] },
        nftSweep: { transferred: [], errors: [] },
      },
    },
  });
  const sweptAssetOnlyJournal = buildV2ExecutionReadiness(baseInput, {
    ...context,
    journal: {
      status: 'completed',
      stage: 'transfer_completed',
      transfer: {
        destinationWallet: VALID_SWEEP_DESTINATION,
        tokenSweep: { transferred: [{ mint: 'Mint111', txId: 'SweepTx111' }], errors: [] },
      },
    },
  });

  assert.equal(incompleteJournal.nextEndpoint, '/api/transfer-assets');
  assert.equal(incompleteJournal.nextAction, 'Sweep assets');
  assert.equal(incompleteJournal.completed, false);
  assert.equal(incompleteJournal.completionStatus, 'pending');
  assert.equal(incompleteJournal.completion.terminalSweepEvidence, false);
  assert.equal(incompleteJournal.phases.find((phase) => phase.id === 'sweep')?.state, 'ready');
  assert.equal(sweptAssetOnlyJournal.nextEndpoint, '/api/transfer-assets');
  assert.equal(sweptAssetOnlyJournal.completed, false);
  assert.equal(sweptAssetOnlyJournal.completionStatus, 'pending');
  assert.equal(sweptAssetOnlyJournal.completion.terminalSweepEvidence, false);
  assert.equal(sweptAssetOnlyJournal.phases.find((phase) => phase.id === 'sweep')?.state, 'ready');
  assert.equal(terminalJournal.nextEndpoint, null);
  assert.equal(terminalJournal.nextAction, 'Launch complete');
  assert.equal(terminalJournal.completed, true);
  assert.equal(terminalJournal.completionStatus, 'complete');
  assert.equal(terminalJournal.completion.terminalSweepEvidence, true);
  assert.equal(terminalJournal.phases.find((phase) => phase.id === 'sweep')?.state, 'complete');
});

test('buildV2ExecutionReadiness blocks invalid sweep destinations before transfer', () => {
  const readiness = buildV2ExecutionReadiness(
    {
      token: { name: 'MoonKit', symbol: 'MKT', supply: '1000' },
      poolTopology: {
        targetMarketCapUsd: 250000,
        sweepDestination: 'not-a-solana-wallet',
      },
      funding: { estimate: { totalSol: 2.4 } },
    },
    {
      demoMode: false,
      walletPublicKey: '11111111111111111111111111111111',
      walletAvailable: true,
      secretAvailable: true,
      secretPinLocked: false,
      tokenMint: 'Mint111',
      liquidityComplete: true,
      now: '2026-06-20T12:00:00.000Z',
    },
  );

  assert.equal(readiness.status, 'blocked');
  assert.equal(readiness.nextEndpoint, null);
  assert.match(readiness.blockers.map((item) => item.id).join(','), /invalid-sweep-destination-1/);
  assert.match(readiness.blockers[0].detail, /Sweep destination does not look like a valid Solana address/);
  assert.equal(readiness.phases.find((phase) => phase.id === 'sweep')?.state, 'blocked');
  assert.equal(readiness.plan.guardrails.find((item) => item.id === 'classic-sweep-destination')?.state, 'danger');
});

test('buildV2ExecutionReadiness blocks fresh live airdrops without executable rows', () => {
  const readiness = buildV2ExecutionReadiness(
    {
      token: { name: 'MoonKit', symbol: 'MKT', supply: '1000000' },
      poolTopology: {
        targetMarketCapUsd: 250000,
        sweepDestination: VALID_SWEEP_DESTINATION,
        pools: [
          {
            quoteToken: 'SOL',
            quoteSymbol: 'SOL',
            supplyPercent: 80,
            support: { mode: 'custom', solValue: 100, depthPct: 12 },
          },
        ],
        airdrop: {
          enabled: true,
          recipientCount: 3,
          supplyPercent: 2,
          recipients: [],
        },
      },
      funding: { estimate: { totalSol: 2.4, solUsd: 100 } },
    },
    {
      demoMode: false,
      walletPublicKey: '11111111111111111111111111111111',
      walletAvailable: true,
      secretAvailable: true,
      secretPinLocked: false,
      now: '2026-06-20T12:00:00.000Z',
    },
  );

  assert.equal(readiness.status, 'blocked');
  assert.equal(readiness.nextEndpoint, null);
  assert.match(readiness.blockers.map((item) => item.id).join(','), /airdrop-recipients-missing/);
  assert.equal(readiness.phases.find((phase) => phase.id === 'sweep')?.state, 'blocked');
  assert.equal(readiness.plan.guardrails.find((item) => item.id === 'classic-airdrop-recipients')?.state, 'danger');
});

test('buildV2ExecutionReadiness blocks fresh live airdrop recipient count mismatches', () => {
  const readiness = buildV2ExecutionReadiness(
    {
      token: { name: 'MoonKit', symbol: 'MKT', supply: '1000000' },
      poolTopology: {
        targetMarketCapUsd: 250000,
        sweepDestination: VALID_SWEEP_DESTINATION,
        pools: [
          {
            quoteToken: 'SOL',
            quoteSymbol: 'SOL',
            supplyPercent: 80,
            support: { mode: 'custom', solValue: 100, depthPct: 12 },
          },
        ],
        airdrop: {
          enabled: true,
          recipientCount: 3,
          supplyPercent: 2,
          recipients: [
            { wallet: VALID_AIRDROP_WALLET_ONE, tokens: 10000 },
            { wallet: VALID_AIRDROP_WALLET_TWO, tokens: 10000 },
          ],
        },
      },
      funding: { estimate: { totalSol: 2.4, solUsd: 100 } },
    },
    {
      demoMode: false,
      walletPublicKey: '11111111111111111111111111111111',
      walletAvailable: true,
      secretAvailable: true,
      secretPinLocked: false,
      now: '2026-06-20T12:00:00.000Z',
    },
  );

  assert.equal(readiness.status, 'blocked');
  assert.equal(readiness.nextEndpoint, null);
  assert.match(readiness.blockers.map((item) => item.id).join(','), /airdrop-recipient-count-mismatch/);
  assert.match(readiness.blockers.map((item) => item.detail).join(' '), /declares 3 recipients, but 2 executable rows/);
  assert.equal(readiness.phases.find((phase) => phase.id === 'sweep')?.state, 'blocked');
  assert.equal(readiness.plan.guardrails.find((item) => item.id === 'classic-airdrop-recipients')?.state, 'danger');
});

test('buildV2ExecutionReadiness warns but keeps resume recoverable on airdrop count mismatch', () => {
  const readiness = buildV2ExecutionReadiness(
    {
      token: { name: 'MoonKit', symbol: 'MKT', supply: '1000000' },
      poolTopology: {
        targetMarketCapUsd: 250000,
        sweepDestination: VALID_SWEEP_DESTINATION,
        pools: [
          {
            quoteToken: 'SOL',
            quoteSymbol: 'SOL',
            supplyPercent: 80,
          },
        ],
        airdrop: {
          enabled: true,
          recipientCount: 3,
          supplyPercent: 2,
          recipients: [
            { wallet: VALID_AIRDROP_WALLET_ONE, tokens: 10000 },
            { wallet: VALID_AIRDROP_WALLET_TWO, tokens: 10000 },
          ],
        },
      },
    },
    {
      demoMode: false,
      walletPublicKey: '11111111111111111111111111111111',
      walletAvailable: true,
      secretAvailable: true,
      secretPinLocked: false,
      tokenMint: 'TokenMint111111111111111111111111111111111',
      resume: true,
      priorResults: [{ allocationIndex: 0, poolId: 'Pool1111111111111111111111111111111111' }],
      now: '2026-06-20T12:00:00.000Z',
    },
  );

  assert.equal(readiness.status, 'ready');
  assert.equal(readiness.nextEndpoint, '/api/resume-launch');
  assert.doesNotMatch(readiness.blockers.map((item) => item.id).join(','), /airdrop-recipient-count-mismatch/);
  assert.match(readiness.warnings.map((item) => item.id).join(','), /airdrop-recipient-count-mismatch/);
  assert.equal(readiness.plan.guardrails.find((item) => item.id === 'classic-airdrop-recipients')?.state, 'warn');
});

test('buildV2ExecutionReadiness blocks underbacked airdrop support before fresh live execution', () => {
  const readiness = buildV2ExecutionReadiness(
    {
      token: { name: 'MoonKit', symbol: 'MKT', supply: '1000000' },
      poolTopology: {
        targetMarketCapUsd: 250000,
        sweepDestination: VALID_SWEEP_DESTINATION,
        pools: [
          {
            quoteToken: 'SOL',
            quoteSymbol: 'SOL',
            supplyPercent: 80,
            support: { mode: 'custom', solValue: 1, depthPct: 12 },
          },
        ],
        airdrop: {
          enabled: true,
          recipientCount: 1,
          supplyPercent: 2,
          recipients: [{ wallet: VALID_AIRDROP_WALLET_ONE, tokens: 20000 }],
        },
      },
      funding: { estimate: { totalSol: 2.4, solUsd: 100 } },
    },
    {
      demoMode: false,
      walletPublicKey: '11111111111111111111111111111111',
      walletAvailable: true,
      secretAvailable: true,
      secretPinLocked: false,
      now: '2026-06-20T12:00:00.000Z',
    },
  );

  assert.equal(readiness.status, 'blocked');
  assert.equal(readiness.nextEndpoint, null);
  assert.match(readiness.blockers.map((item) => item.id).join(','), /airdrop-support-underbacked/);
  assert.match(readiness.blockers.map((item) => item.detail).join(' '), /Add at least/);
  assert.equal(readiness.phases.find((phase) => phase.id === 'liquidity')?.state, 'blocked');
  assert.equal(readiness.plan.guardrails.find((item) => item.id === 'classic-airdrop-backing')?.state, 'danger');
});

test('buildV2ExecutionReadiness allows backed airdrop support before fresh live execution', () => {
  const readiness = buildV2ExecutionReadiness(
    {
      token: { name: 'MoonKit', symbol: 'MKT', supply: '1000000' },
      poolTopology: {
        targetMarketCapUsd: 250000,
        sweepDestination: VALID_SWEEP_DESTINATION,
        pools: [
          {
            quoteToken: 'SOL',
            quoteSymbol: 'SOL',
            supplyPercent: 80,
            support: { mode: 'custom', solValue: 51, depthPct: 12 },
          },
        ],
        airdrop: {
          enabled: true,
          recipientCount: 1,
          supplyPercent: 2,
          recipients: [{ wallet: VALID_AIRDROP_WALLET_ONE, tokens: 20000 }],
        },
      },
      funding: { estimate: { totalSol: 2.4, solUsd: 100 } },
    },
    {
      demoMode: false,
      walletPublicKey: '11111111111111111111111111111111',
      walletAvailable: true,
      secretAvailable: true,
      secretPinLocked: false,
      now: '2026-06-20T12:00:00.000Z',
    },
  );

  assert.equal(readiness.status, 'ready');
  assert.equal(readiness.nextEndpoint, '/api/create-token');
  assert.doesNotMatch(readiness.blockers.map((item) => item.id).join(','), /airdrop-support-underbacked/);
  assert.equal(readiness.plan.guardrails.find((item) => item.id === 'classic-airdrop-backing')?.state, 'pass');
});

test('buildV2ExecutionReadiness blocks underbacked held preallocation support before fresh live execution', () => {
  const readiness = buildV2ExecutionReadiness(
    {
      token: { name: 'MoonKit', symbol: 'MKT', supply: '1000000' },
      poolTopology: {
        targetMarketCapUsd: 250000,
        sweepDestination: VALID_SWEEP_DESTINATION,
        pools: [
          {
            quoteToken: 'SOL',
            quoteSymbol: 'SOL',
            supplyPercent: 80,
            support: { mode: 'custom', solValue: 1, depthPct: 12 },
          },
        ],
        preallocation: { enabled: true, supplyPercent: 5, source: 'team-reserve' },
        airdrop: { enabled: false, recipientCount: 0 },
      },
      funding: { estimate: { totalSol: 2.4, solUsd: 100 } },
    },
    {
      demoMode: false,
      walletPublicKey: '11111111111111111111111111111111',
      walletAvailable: true,
      secretAvailable: true,
      secretPinLocked: false,
      now: '2026-06-20T12:00:00.000Z',
    },
  );

  assert.equal(readiness.status, 'blocked');
  assert.match(readiness.blockers.map((item) => item.id).join(','), /airdrop-support-underbacked/);
  assert.match(readiness.blockers.map((item) => item.title).join(' '), /Held reserve support underbacked/);
  assert.match(readiness.blockers.map((item) => item.detail).join(' '), /Held reserves 5% of supply/);
  assert.equal(readiness.plan.guardrails.find((item) => item.id === 'classic-airdrop-backing')?.state, 'danger');
});

test('buildV2ExecutionReadiness blocks invalid airdrop rows before transfer', () => {
  const readiness = buildV2ExecutionReadiness(
    {
      token: { name: 'MoonKit', symbol: 'MKT', supply: '1000' },
      poolTopology: {
        targetMarketCapUsd: 250000,
        sweepDestination: VALID_SWEEP_DESTINATION,
        airdrop: {
          enabled: true,
          recipientCount: 2,
          supplyPercent: 2,
          parseError: 'line 2: wallet does not look like a Solana address',
          recipients: [
            { wallet: 'not-a-wallet', tokens: 100 },
            { wallet: VALID_AIRDROP_WALLET_ONE, tokens: 0 },
          ],
        },
      },
      funding: { estimate: { totalSol: 2.4 } },
    },
    {
      demoMode: false,
      walletPublicKey: '11111111111111111111111111111111',
      walletAvailable: true,
      secretAvailable: true,
      secretPinLocked: false,
      tokenMint: 'Mint111',
      liquidityComplete: true,
      now: '2026-06-20T12:00:00.000Z',
    },
  );

  assert.equal(readiness.status, 'blocked');
  assert.equal(readiness.nextEndpoint, null);
  assert.match(readiness.blockers.map((item) => item.id).join(','), /invalid-airdrop-recipient-config-1/);
  assert.match(readiness.blockers[0].detail, /Airdrop CSV has an error/);
  assert.match(readiness.blockers.map((item) => item.detail).join(' '), /token amount must be greater than 0/);
  assert.equal(readiness.phases.find((phase) => phase.id === 'sweep')?.state, 'blocked');
  assert.equal(readiness.plan.guardrails.find((item) => item.id === 'classic-airdrop-recipients')?.state, 'danger');
});

test('buildV2ExecutionReadiness blocks overallocated classic pool topology', () => {
  const readiness = buildV2ExecutionReadiness(
    {
      token: { name: 'MoonKit', symbol: 'MKT', supply: '1000' },
      poolTopology: {
        pools: [
          { quoteToken: 'SOL', quoteSymbol: 'SOL', supplyPercent: 70 },
          { quoteToken: 'USDC', quoteSymbol: 'USDC', supplyPercent: 40 },
        ],
      },
    },
    {
      demoMode: true,
      walletPublicKey: '11111111111111111111111111111111',
      now: '2026-06-20T12:00:00.000Z',
    },
  );

  assert.equal(readiness.status, 'blocked');
  assert.match(readiness.blockers.map((item) => item.id).join(','), /pool-overallocated/);
  assert.equal(readiness.phases.find((phase) => phase.id === 'liquidity')?.state, 'blocked');
});

test('buildV2ExecutionReadiness counts held preallocation in supply overallocations', () => {
  const readiness = buildV2ExecutionReadiness(
    {
      token: { name: 'MoonKit', symbol: 'MKT', supply: '1000' },
      poolTopology: {
        pools: [
          { quoteToken: 'SOL', quoteSymbol: 'SOL', supplyPercent: 70 },
          { quoteToken: 'USDC', quoteSymbol: 'USDC', supplyPercent: 20 },
        ],
        preallocation: { enabled: true, supplyPercent: 15, source: 'team-reserve' },
      },
    },
    {
      demoMode: true,
      walletPublicKey: '11111111111111111111111111111111',
      now: '2026-06-20T12:00:00.000Z',
    },
  );

  assert.equal(readiness.status, 'blocked');
  assert.match(readiness.blockers.map((item) => item.id).join(','), /pool-overallocated/);
  assert.match(readiness.blockers.map((item) => item.detail).join(' '), /preallocation/);
  assert.equal(readiness.phases.find((phase) => phase.id === 'liquidity')?.state, 'blocked');
});

test('buildV2ExecutionReadiness blocks ladder payloads that classic LP would reject', () => {
  const readiness = buildV2ExecutionReadiness(
    {
      token: { name: 'MoonKit', symbol: 'MKT', supply: '1000' },
      poolTopology: {
        pools: [
          {
            quoteToken: 'SOL',
            quoteSymbol: 'SOL',
            supplyPercent: 70,
            ladder: {
              mode: 'simple',
              bandCount: 1,
              supplyPercent: 50,
              ceilingMultiplier: 1000,
            },
          },
        ],
      },
      funding: { estimate: { totalSol: 2.4 } },
    },
    {
      demoMode: true,
      walletPublicKey: '11111111111111111111111111111111',
      now: '2026-06-20T12:00:00.000Z',
    },
  );

  assert.equal(readiness.status, 'blocked');
  assert.match(readiness.blockers.map((item) => item.id).join(','), /invalid-ladder-1-1/);
  assert.match(readiness.blockers[0].detail, /simple ladder needs 2-20 bands/);
  assert.equal(readiness.phases.find((phase) => phase.id === 'liquidity')?.state, 'blocked');
  assert.equal(readiness.plan.guardrails.find((item) => item.id === 'classic-ladder-contract')?.state, 'danger');
});

test('buildV2ExecutionReadiness blocks manual ladders above the Classic band cap', () => {
  const readiness = buildV2ExecutionReadiness(
    {
      token: { name: 'MoonKit', symbol: 'MKT', supply: '1000' },
      poolTopology: {
        pools: [
          {
            quoteToken: 'SOL',
            quoteSymbol: 'SOL',
            supplyPercent: 70,
            ladder: {
              mode: 'manual',
              bands: Array.from({ length: 21 }, (_, index) => ({
                supplyPercent: 1,
                lowerMultiplier: 1 + index,
                upperMultiplier: 2 + index,
              })),
            },
          },
        ],
      },
      funding: { estimate: { totalSol: 2.4 } },
    },
    {
      demoMode: true,
      walletPublicKey: '11111111111111111111111111111111',
      now: '2026-06-20T12:00:00.000Z',
    },
  );

  assert.equal(readiness.status, 'blocked');
  assert.match(readiness.blockers.map((item) => item.detail).join(' '), /manual ladder has 21 bands/);
  assert.equal(readiness.plan.poolTopology.pools[0].ladder.bands.length, 21);
});

test('buildV2ExecutionReadiness blocks invalid Fee Key recipient addresses before LP execution', () => {
  const readiness = buildV2ExecutionReadiness(
    {
      token: { name: 'MoonKit', symbol: 'MKT', supply: '1000' },
      poolTopology: {
        pools: [
          {
            quoteToken: 'SOL',
            quoteSymbol: 'SOL',
            supplyPercent: 70,
            distribution: [
              { sharePercent: 50, recipient: 'not-a-solana-wallet' },
              { sharePercent: 50 },
            ],
          },
        ],
      },
      funding: { estimate: { totalSol: 2.4 } },
    },
    {
      demoMode: true,
      walletPublicKey: '11111111111111111111111111111111',
      now: '2026-06-20T12:00:00.000Z',
    },
  );

  assert.equal(readiness.status, 'blocked');
  assert.match(readiness.blockers.map((item) => item.id).join(','), /invalid-fee-key-recipient-1-1-1/);
  assert.match(readiness.blockers[0].detail, /Fee Key recipient does not look like a valid Solana address/);
  assert.equal(readiness.phases.find((phase) => phase.id === 'liquidity')?.state, 'blocked');
  assert.equal(readiness.plan.guardrails.find((item) => item.id === 'classic-fee-key-recipients')?.state, 'danger');
});

test('buildV2ExecutionReadiness blocks duplicate quote and fee-tier pool routes', () => {
  const readiness = buildV2ExecutionReadiness(
    {
      token: { name: 'MoonKit', symbol: 'MKT', supply: '1000' },
      poolTopology: {
        pools: [
          {
            quoteToken: 'USDC',
            quoteSymbol: 'USDC',
            supplyPercent: 10,
            ammConfigIndex: 5,
          },
          {
            quoteToken: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
            quoteMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
            quoteSymbolOverride: 'USDC',
            supplyPercent: 5,
            ammConfigIndex: 5,
          },
        ],
      },
      funding: { estimate: { totalSol: 2.4 } },
    },
    {
      demoMode: true,
      walletPublicKey: '11111111111111111111111111111111',
      now: '2026-06-20T12:00:00.000Z',
    },
  );

  assert.equal(readiness.status, 'blocked');
  assert.equal(readiness.nextEndpoint, null);
  assert.match(readiness.blockers.map((item) => item.id).join(','), /duplicate-pool-route-2/);
  assert.match(readiness.blockers.find((item) => item.id === 'duplicate-pool-route-2')?.detail, /Raydium uses both to identify a pool/);
  assert.equal(readiness.phases.find((phase) => phase.id === 'liquidity')?.state, 'blocked');
  assert.equal(readiness.plan.guardrails.find((item) => item.id === 'classic-pool-identities')?.state, 'danger');
});

test('buildV2ExecutionReadiness blocks unverified custom quote tokens before fresh live execution', () => {
  const readiness = buildV2ExecutionReadiness(
    {
      token: { name: 'MoonKit', symbol: 'MKT', supply: '1000' },
      poolTopology: {
        targetMarketCapUsd: 250000,
        pools: [
          {
            quoteToken: 'RiskyMint111',
            quoteMint: 'RiskyMint111',
            quoteSymbol: 'RISK',
            supplyPercent: 20,
            ammConfigIndex: 12,
          },
        ],
      },
      funding: { estimate: { totalSol: 2.4 } },
    },
    {
      demoMode: false,
      walletPublicKey: '11111111111111111111111111111111',
      walletAvailable: true,
      secretAvailable: true,
      secretPinLocked: false,
      rpc: { activeUrl: 'https://mainnet.helius-rpc.com/?api-key=test' },
      now: '2026-06-20T12:00:00.000Z',
    },
  );

  assert.equal(readiness.status, 'blocked');
  assert.equal(readiness.nextEndpoint, null);
  assert.match(readiness.blockers.map((item) => item.id).join(','), /quote-token-safety-1-1/);
  assert.match(readiness.blockers.map((item) => item.detail).join(' '), /safety check/);
  assert.equal(readiness.phases.find((phase) => phase.id === 'liquidity')?.state, 'blocked');
  assert.equal(readiness.plan.guardrails.find((item) => item.id === 'classic-quote-safety')?.state, 'warn');
});

test('buildV2ExecutionReadiness blocks custom quote tokens with hard safety failures', () => {
  const readiness = buildV2ExecutionReadiness(
    {
      token: { name: 'MoonKit', symbol: 'MKT', supply: '1000' },
      poolTopology: {
        targetMarketCapUsd: 250000,
        pools: [
          {
            quoteToken: 'FrozenMint111',
            quoteMint: 'FrozenMint111',
            quoteSymbol: 'FRZ',
            supplyPercent: 20,
            ammConfigIndex: 12,
            quoteCompatibility: {
              compatible: true,
              raydiumTradeable: 'no',
              freezeAuthorityBlock: true,
              mintAuthorityWarning: false,
            },
          },
        ],
      },
      funding: { estimate: { totalSol: 2.4 } },
    },
    {
      demoMode: false,
      walletPublicKey: '11111111111111111111111111111111',
      walletAvailable: true,
      secretAvailable: true,
      secretPinLocked: false,
      rpc: { activeUrl: 'https://mainnet.helius-rpc.com/?api-key=test' },
      now: '2026-06-20T12:00:00.000Z',
    },
  );

  assert.equal(readiness.status, 'blocked');
  assert.match(readiness.blockers.map((item) => item.id).join(','), /quote-token-safety-1-/);
  assert.match(readiness.blockers.map((item) => item.detail).join(' '), /freeze-authority risk|route probe/);
  assert.equal(readiness.plan.guardrails.find((item) => item.id === 'classic-quote-safety')?.state, 'danger');
});

test('buildV2ExecutionReadiness warns but allows verified custom quote mint authority risk', () => {
  const readiness = buildV2ExecutionReadiness(
    {
      token: { name: 'MoonKit', symbol: 'MKT', supply: '1000' },
      poolTopology: {
        targetMarketCapUsd: 250000,
        pools: [
          {
            quoteToken: 'MintWarning111',
            quoteMint: 'MintWarning111',
            quoteSymbol: 'MWN',
            supplyPercent: 20,
            ammConfigIndex: 12,
            quoteCompatibility: {
              compatible: true,
              raydiumTradeable: 'yes',
              freezeAuthorityBlock: false,
              mintAuthorityWarning: true,
            },
          },
        ],
      },
      funding: { estimate: { totalSol: 2.4 } },
    },
    {
      demoMode: false,
      walletPublicKey: '11111111111111111111111111111111',
      walletAvailable: true,
      secretAvailable: true,
      secretPinLocked: false,
      rpc: { activeUrl: 'https://mainnet.helius-rpc.com/?api-key=test' },
      now: '2026-06-20T12:00:00.000Z',
    },
  );

  assert.equal(readiness.status, 'ready');
  assert.equal(readiness.nextEndpoint, '/api/create-token');
  assert.doesNotMatch(readiness.blockers.map((item) => item.id).join(','), /quote-token-safety/);
  assert.match(readiness.warnings.map((item) => item.id).join(','), /quote-token-safety-1-1/);
  assert.equal(readiness.plan.guardrails.find((item) => item.id === 'classic-quote-safety')?.state, 'warn');
});

test('buildV2ExecutionReadiness allows the same quote across different fee tiers', () => {
  const readiness = buildV2ExecutionReadiness(
    {
      token: { name: 'MoonKit', symbol: 'MKT', supply: '1000' },
      poolTopology: {
        targetMarketCapUsd: 250000,
        pools: [
          { quoteToken: 'SOL', quoteSymbol: 'SOL', supplyPercent: 40, ammConfigIndex: 8 },
          { quoteToken: 'SOL', quoteSymbol: 'SOL', supplyPercent: 10, ammConfigIndex: 5 },
        ],
      },
      funding: { estimate: { totalSol: 2.4 } },
    },
    {
      demoMode: true,
      walletPublicKey: '11111111111111111111111111111111',
      now: '2026-06-20T12:00:00.000Z',
    },
  );

  assert.equal(readiness.status, 'ready');
  assert.doesNotMatch(readiness.blockers.map((item) => item.id).join(','), /duplicate-pool-route/);
  assert.equal(readiness.plan.guardrails.find((item) => item.id === 'classic-pool-identities')?.state, 'pass');
});

test('server v2 proof snapshot prefers journal token and pool plan over submitted config', () => {
  const helperStart = serverSource.indexOf('function v2PoolTopologySnapshotFromPlan');
  const helperEnd = serverSource.indexOf('\nfunction v2ExecutionProofFromContext', helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, 'v2 snapshot helpers should be extractable');
  const sandbox = {
    cloneJson: (value) => JSON.parse(JSON.stringify(value)),
  };
  vm.runInNewContext(
    [
      serverSource.slice(helperStart, helperEnd),
      'globalThis.v2LaunchConfigSnapshotFromPlan = v2LaunchConfigSnapshotFromPlan;',
    ].join('\n'),
    sandbox,
    { filename: 'server.js v2 launch-config snapshot harness' },
  );

  const snapshot = sandbox.v2LaunchConfigSnapshotFromPlan({
    mode: 'guarded',
    token: {
      name: 'Typed Token',
      symbol: 'NEW',
      supply: '1',
      description: 'typed form',
      decimals: 9,
      logo: { name: 'typed.png', mimeType: 'image/png', sizeBytes: 128, dataUrl: 'data:image/png;base64,secret' },
    },
    poolTopology: {
      sweepDestination: VALID_SWEEP_DESTINATION,
      targetMarketCapUsd: 999,
      pools: [{ quoteToken: 'USDC', supplyPercent: 1 }],
      airdrop: { enabled: false, recipientCount: 0 },
    },
    funding: { launchSol: 3 },
  }, {
    token: {
      name: 'Journal Token',
      symbol: 'OLD',
      totalSupply: '5000',
      decimals: 9,
    },
    poolPlan: {
      tokenTotalSupply: '5000',
      targetMarketCapUsd: '12345',
      allocations: [{ quoteToken: 'SOL', supplyPercent: 80, distribution: [{ sharePercent: 100 }] }],
      airdropPlan: { enabled: true, recipientCount: 2, recipients: [{ wallet: VALID_AIRDROP_WALLET_ONE, tokens: 10 }] },
    },
  });

  assert.equal(snapshot.schema, 'trebuchet-v2-launch-config');
  assert.equal(snapshot.source, 'trebuchet-v2');
  assert.equal(snapshot.token.name, 'Journal Token');
  assert.equal(snapshot.token.symbol, 'OLD');
  assert.equal(snapshot.token.supply, '5000');
  assert.equal(snapshot.token.logo.dataUrl, undefined);
  assert.equal(snapshot.token.logo.type, 'image/png');
  assert.equal(snapshot.poolTopology.sweepDestination, VALID_SWEEP_DESTINATION);
  assert.equal(snapshot.poolTopology.targetMarketCapUsd, 12345);
  assert.equal(snapshot.poolTopology.pools[0].quoteToken, 'SOL');
  assert.equal(snapshot.poolTopology.pools[0].supplyPercent, 80);
  assert.equal(snapshot.poolTopology.airdrop.enabled, true);
  assert.equal(snapshot.poolTopology.airdrop.recipientCount, 2);
  assert.equal(snapshot.funding.targetMarketCapUsd, 12345);
});

test('server v2 report publish requires a complete launch-config snapshot', () => {
  const helperStart = serverSource.indexOf('function v2ProofPositionCount');
  const helperEnd = serverSource.indexOf('\nfunction v2AirdropCompletionStatus', helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, 'v2 launch-data config snapshot helper should be extractable');
  const sandbox = {};
  vm.runInNewContext(
    [
      serverSource.slice(helperStart, helperEnd),
      'globalThis.v2LaunchDataConfigSnapshotState = v2LaunchDataConfigSnapshotState;',
      'globalThis.v2LaunchDataProofFingerprint = v2LaunchDataProofFingerprint;',
      'globalThis.v2TransferEvidenceHash = v2TransferEvidenceHash;',
    ].join('\n'),
    sandbox,
    { filename: 'server.js v2 report launch-config snapshot harness' },
  );

  const missing = sandbox.v2LaunchDataConfigSnapshotState({});
  assert.equal(missing.state, 'missing');
  assert.equal(missing.complete, false);
  assert.deepEqual([...missing.missing], ['snapshot']);

  const incomplete = sandbox.v2LaunchDataConfigSnapshotState({
    launchConfig: {
      token: {},
      poolTopology: {},
    },
  });
  assert.equal(incomplete.state, 'incomplete');
  assert.equal(incomplete.complete, false);
  assert.deepEqual([...incomplete.missing], ['v2 snapshot marker', 'token identity', 'token supply', 'planned pools']);

  const unmarkedShapeComplete = sandbox.v2LaunchDataConfigSnapshotState({
    launchConfig: {
      token: { name: 'Report Token', symbol: 'RPT', supply: '1000000' },
      poolTopology: { pools: [{ quoteToken: 'SOL', supplyPercent: 80 }] },
    },
  });
  assert.equal(unmarkedShapeComplete.state, 'incomplete');
  assert.equal(unmarkedShapeComplete.complete, false);
  assert.deepEqual([...unmarkedShapeComplete.missing], ['v2 snapshot marker']);

  const complete = sandbox.v2LaunchDataConfigSnapshotState({
    launchConfig: {
      schema: 'trebuchet-v2-launch-config',
      source: 'trebuchet-v2',
      token: { name: 'Report Token', symbol: 'RPT', supply: '1000000' },
      poolTopology: { pools: [{ quoteToken: 'SOL', supplyPercent: 80 }] },
    },
  });
  assert.equal(complete.state, 'complete');
  assert.equal(complete.complete, true);
  assert.deepEqual([...complete.missing], []);

  const consistent = sandbox.v2LaunchDataConfigConsistencyState({
    name: 'Report Token',
    symbol: 'RPT',
    totalSupply: '1000000',
    decimals: 9,
    plannedPools: [{ quoteToken: 'SOL', supplyPercent: 80, ammConfigIndex: 8 }],
    launchConfig: {
      token: { name: 'Report Token', symbol: 'RPT', supply: '1000000', decimals: 9 },
      poolTopology: { pools: [{ quoteToken: 'SOL', supplyPercent: 80, ammConfigIndex: 8 }] },
    },
  }, {
    token: { name: 'Report Token', symbol: 'RPT', totalSupply: '1000000', decimals: 9 },
    poolPlan: { allocations: [{ quoteToken: 'SOL', supplyPercent: 80, ammConfigIndex: 8 }] },
  });
  assert.equal(consistent.consistent, true);
  assert.deepEqual([...consistent.mismatches], []);

  const strictMissingJournalIdentity = sandbox.v2LaunchDataConfigConsistencyState({
    name: 'Report Token',
    symbol: 'RPT',
    totalSupply: '1000000',
    decimals: 9,
    plannedPools: [{ quoteToken: 'SOL', supplyPercent: 80, ammConfigIndex: 8 }],
    launchConfig: {
      token: { name: 'Report Token', symbol: 'RPT', supply: '1000000', decimals: 9 },
      poolTopology: { pools: [{ quoteToken: 'SOL', supplyPercent: 80, ammConfigIndex: 8 }] },
    },
  }, {
    token: { mint: 'ReportMint1111111111111111111111111111111111' },
    poolPlan: {
      tokenTotalSupply: '1000000',
      tokenDecimals: 9,
      allocations: [{ quoteToken: 'SOL', supplyPercent: 80, ammConfigIndex: 8 }],
    },
  }, { requireJournalFields: true });
  assert.equal(strictMissingJournalIdentity.consistent, false);
  assert.match([...strictMissingJournalIdentity.mismatches].join(','), /journal token name/);
  assert.match([...strictMissingJournalIdentity.mismatches].join(','), /journal token symbol/);

  const strictMissingJournalPoolFields = sandbox.v2LaunchDataConfigConsistencyState({
    name: 'Report Token',
    symbol: 'RPT',
    totalSupply: '1000000',
    decimals: 9,
    plannedPools: [{ quoteToken: 'SOL', supplyPercent: 80, ammConfigIndex: 8 }],
    launchConfig: {
      token: { name: 'Report Token', symbol: 'RPT', supply: '1000000', decimals: 9 },
      poolTopology: { pools: [{ quoteToken: 'SOL', supplyPercent: 80, ammConfigIndex: 8 }] },
    },
  }, {
    token: { name: 'Report Token', symbol: 'RPT', totalSupply: '1000000', decimals: 9 },
    poolPlan: { allocations: [{ quoteToken: 'SOL' }] },
  }, { requireJournalFields: true });
  assert.equal(strictMissingJournalPoolFields.consistent, false);
  assert.match([...strictMissingJournalPoolFields.mismatches].join(','), /journal planned pool 1/);

  const backedJournal = sandbox.v2LaunchDataJournalState({
    launchWallet: 'ReportWallet111111111111111111111111111111111',
    mint: 'ReportMint1111111111111111111111111111111111',
    token: { mint: 'ReportMint1111111111111111111111111111111111' },
    recoveryAudit: { journalId: 'launch_report_1' },
  }, {
    id: 'launch_report_1',
    walletPublicKey: 'ReportWallet111111111111111111111111111111111',
    token: { mint: 'ReportMint1111111111111111111111111111111111' },
    poolPlan: { allocations: [{ quoteToken: 'SOL', supplyPercent: 80 }] },
  }, 'ReportWallet111111111111111111111111111111111');
  assert.equal(backedJournal.backed, true);
  assert.deepEqual([...backedJournal.missing], []);
  assert.deepEqual([...backedJournal.mismatches], []);

  const authorityLaunchData = {
    launchWallet: 'ReportWallet111111111111111111111111111111111',
    mint: 'ReportMint1111111111111111111111111111111111',
    token: {
      mint: 'ReportMint1111111111111111111111111111111111',
      authorities: {
        mintAuthorityRenounced: true,
        freezeAuthorityDisabled: true,
        metadataUpdateAuthorityRevoked: true,
        metadataImmutable: true,
      },
    },
    recoveryAudit: { journalId: 'launch_report_1' },
  };
  const authorityJournal = {
    id: 'launch_report_1',
    walletPublicKey: 'ReportWallet111111111111111111111111111111111',
    token: {
      mint: 'ReportMint1111111111111111111111111111111111',
      mintAuthorityRenounced: true,
      freezeAuthorityDisabled: true,
      metadataUpdateAuthorityRevoked: true,
      metadataImmutable: true,
    },
    poolPlan: { allocations: [{ quoteToken: 'SOL', supplyPercent: 80 }] },
  };
  const backedAuthorityJournal = sandbox.v2LaunchDataJournalState(
    authorityLaunchData,
    authorityJournal,
    'ReportWallet111111111111111111111111111111111',
  );
  assert.equal(backedAuthorityJournal.backed, true);
  assert.deepEqual([...backedAuthorityJournal.missing], []);
  assert.deepEqual([...backedAuthorityJournal.mismatches], []);

  const weakAuthorityJournal = sandbox.v2LaunchDataJournalState(
    authorityLaunchData,
    {
      ...authorityJournal,
      token: { mint: 'ReportMint1111111111111111111111111111111111' },
    },
    'ReportWallet111111111111111111111111111111111',
  );
  assert.equal(weakAuthorityJournal.backed, false);
  assert.match([...weakAuthorityJournal.missing].join(','), /journal token authority/);

  const mismatchedAuthorityJournal = sandbox.v2LaunchDataJournalState(
    authorityLaunchData,
    {
      ...authorityJournal,
      token: {
        ...authorityJournal.token,
        freezeAuthorityDisabled: false,
      },
    },
    'ReportWallet111111111111111111111111111111111',
  );
  assert.equal(mismatchedAuthorityJournal.backed, false);
  assert.match([...mismatchedAuthorityJournal.mismatches].join(','), /token authority/);

  const reportPosition = {
    type: 'main',
    sliceIndex: 0,
    sharePercent: 100,
    tickLower: -100,
    tickUpper: 100,
    positionNftMint: 'ReportPosition111111111111111111111111111111',
    feeKeyNftMint: 'ReportFeeKey1111111111111111111111111111111',
    locked: true,
    recipient: 'ReportRecipient111111111111111111111111111111',
    transferredTo: 'ReportRecipient111111111111111111111111111111',
    openTx: 'ReportOpenTx1111111111111111111111111111111',
    lockTx: 'ReportLockTx1111111111111111111111111111111',
    transferTx: 'ReportTransferTx11111111111111111111111111',
  };
  const reportPool = {
    poolId: 'ReportPool111111111111111111111111111111111',
    quoteMint: 'So11111111111111111111111111111111111111112',
    supplyPercent: 80,
    tickSpacing: 64,
    initialPrice: '0.01',
    launchedSide: 'base',
    createPoolTx: 'ReportCreatePoolTx11111111111111111111111111',
    positions: [reportPosition],
  };
  const journalPool = {
    poolId: reportPool.poolId,
    quoteMint: reportPool.quoteMint,
    supplyPercent: reportPool.supplyPercent,
    tickSpacing: reportPool.tickSpacing,
    initialPrice: reportPool.initialPrice,
    launchedSide: reportPool.launchedSide,
    txIds: { createPool: reportPool.createPoolTx },
    mainPositions: [{
      sliceIndex: reportPosition.sliceIndex,
      sharePercent: reportPosition.sharePercent,
      tickLower: reportPosition.tickLower,
      tickUpper: reportPosition.tickUpper,
      positionNftMint: reportPosition.positionNftMint,
      feeKeyNftMint: reportPosition.feeKeyNftMint,
      locked: true,
      recipient: reportPosition.recipient,
      transferredTo: reportPosition.transferredTo,
      txIds: {
        open: reportPosition.openTx,
        lock: reportPosition.lockTx,
        transfer: reportPosition.transferTx,
      },
    }],
  };
  const liquidityLaunchData = {
    launchWallet: 'ReportWallet111111111111111111111111111111111',
    mint: 'ReportMint1111111111111111111111111111111111',
    token: { mint: 'ReportMint1111111111111111111111111111111111' },
    recoveryAudit: { journalId: 'launch_report_1' },
    pools: [reportPool],
    liquidity: {
      poolCount: 1,
      positionCount: 1,
      lockedPositionCount: 1,
      feeKeyCount: 1,
    },
  };
  const liquidityJournal = {
    id: 'launch_report_1',
    walletPublicKey: 'ReportWallet111111111111111111111111111111111',
    token: { mint: 'ReportMint1111111111111111111111111111111111' },
    poolPlan: { allocations: [{ quoteToken: 'SOL', supplyPercent: 80 }] },
    lp: { results: [journalPool] },
  };
  const backedLiquidityJournal = sandbox.v2LaunchDataJournalState(
    liquidityLaunchData,
    liquidityJournal,
    'ReportWallet111111111111111111111111111111111',
  );
  assert.equal(backedLiquidityJournal.backed, true);
  assert.deepEqual([...backedLiquidityJournal.missing], []);
  assert.deepEqual([...backedLiquidityJournal.mismatches], []);

  const weakLiquidityJournal = sandbox.v2LaunchDataJournalState(
    liquidityLaunchData,
    {
      ...liquidityJournal,
      lp: {
        results: [{
          ...journalPool,
          mainPositions: [],
        }],
      },
    },
    'ReportWallet111111111111111111111111111111111',
  );
  assert.equal(weakLiquidityJournal.backed, false);
  assert.match([...weakLiquidityJournal.missing].join(','), /journal positions/);

  const wrongRecipientLiquidityJournal = sandbox.v2LaunchDataJournalState(
    liquidityLaunchData,
    {
      ...liquidityJournal,
      lp: {
        results: [{
          ...journalPool,
          mainPositions: [{
            ...journalPool.mainPositions[0],
            transferredTo: 'OtherReportRecipient111111111111111111111111',
          }],
        }],
      },
    },
    'ReportWallet111111111111111111111111111111111',
  );
  assert.equal(wrongRecipientLiquidityJournal.backed, false);
  assert.match([...wrongRecipientLiquidityJournal.missing].join(','), /journal Fee Key recipient delivery proof/);
  assert.match([...wrongRecipientLiquidityJournal.mismatches].join(','), /position records/);

  const mismatchedLiquidityJournal = sandbox.v2LaunchDataJournalState(
    liquidityLaunchData,
    {
      ...liquidityJournal,
      lp: {
        results: [{
          ...journalPool,
          mainPositions: [{
            ...journalPool.mainPositions[0],
            txIds: {
              ...journalPool.mainPositions[0].txIds,
              transfer: 'OtherReportTransferTx111111111111111111111',
            },
          }],
        }],
      },
    },
    'ReportWallet111111111111111111111111111111111',
  );
  assert.equal(mismatchedLiquidityJournal.backed, false);
  assert.match([...mismatchedLiquidityJournal.mismatches].join(','), /position records/);

  const airdropLaunchData = {
    launchWallet: 'ReportWallet111111111111111111111111111111111',
    mint: 'ReportMint1111111111111111111111111111111111',
    token: { mint: 'ReportMint1111111111111111111111111111111111' },
    recoveryAudit: { journalId: 'launch_report_1' },
    airdrop: {
      plannedRecipientCount: 1,
      deliveredCount: 1,
      failedCount: 0,
      recipients: [{ wallet: 'ReportAirdropWallet111111111111111111111111', tokens: 25 }],
      transferred: [{
        wallet: 'ReportAirdropWallet111111111111111111111111',
        tokens: 25,
        txId: 'ReportAirdropTx1111111111111111111111111111',
      }],
      failed: [],
    },
  };
  const airdropJournal = {
    id: 'launch_report_1',
    walletPublicKey: 'ReportWallet111111111111111111111111111111111',
    token: { mint: 'ReportMint1111111111111111111111111111111111' },
    poolPlan: { allocations: [{ quoteToken: 'SOL', supplyPercent: 80 }] },
    airdrop: {
      transferred: airdropLaunchData.airdrop.transferred,
      failed: [],
    },
  };
  const backedAirdropJournal = sandbox.v2LaunchDataJournalState(
    airdropLaunchData,
    airdropJournal,
    'ReportWallet111111111111111111111111111111111',
  );
  assert.equal(backedAirdropJournal.backed, true);
  assert.deepEqual([...backedAirdropJournal.missing], []);
  assert.deepEqual([...backedAirdropJournal.mismatches], []);

  const weakAirdropJournal = sandbox.v2LaunchDataJournalState(
    airdropLaunchData,
    {
      ...airdropJournal,
      airdrop: {
        transferred: [{ wallet: airdropLaunchData.airdrop.transferred[0].wallet, tokens: 25 }],
        failed: [],
      },
    },
    'ReportWallet111111111111111111111111111111111',
  );
  assert.equal(weakAirdropJournal.backed, false);
  assert.match([...weakAirdropJournal.missing].join(','), /journal airdrop transactions/);

  const mismatchedAirdropJournal = sandbox.v2LaunchDataJournalState(
    airdropLaunchData,
    {
      ...airdropJournal,
      airdrop: {
        transferred: [{
          wallet: 'OtherAirdropWallet11111111111111111111111',
          tokens: 25,
          txId: airdropLaunchData.airdrop.transferred[0].txId,
        }],
        failed: [],
      },
    },
    'ReportWallet111111111111111111111111111111111',
  );
  assert.equal(mismatchedAirdropJournal.backed, false);
  assert.match([...mismatchedAirdropJournal.mismatches].join(','), /airdrop recipients/);

  const terminalTransfer = {
    destinationWallet: 'ReportDestination11111111111111111111111111111',
    walletEmpty: true,
    tokenSweep: {
      transferred: [{
        mint: 'ReportMint1111111111111111111111111111111111',
        amount: '1',
        decimals: 9,
        txId: 'ReportSweepTx111111111111111111111111111111',
      }],
      errors: [],
    },
  };
  const draftTransferFingerprint = sandbox.v2LaunchDataProofFingerprint({
    ...liquidityLaunchData,
    destinationWallet: terminalTransfer.destinationWallet,
  });
  const terminalTransferFingerprint = sandbox.v2LaunchDataProofFingerprint({
    ...liquidityLaunchData,
    transfer: terminalTransfer,
  });
  const terminalTransferEvidenceHash = sandbox.v2TransferEvidenceHash(terminalTransfer);
  assert.ok(terminalTransferEvidenceHash);
  assert.notEqual(terminalTransferFingerprint, draftTransferFingerprint);
  assert.match(terminalTransferFingerprint, new RegExp(terminalTransferEvidenceHash));
  assert.match(terminalTransferFingerprint, /"terminalTransferEvidenceHash":/);
  assert.match(draftTransferFingerprint, /"terminalTransferEvidenceHash":null/);

  const backedTerminalTransferJournal = sandbox.v2LaunchDataJournalState({
    launchWallet: 'ReportWallet111111111111111111111111111111111',
    mint: 'ReportMint1111111111111111111111111111111111',
    token: { mint: 'ReportMint1111111111111111111111111111111111' },
    recoveryAudit: { journalId: 'launch_report_1' },
    transfer: terminalTransfer,
  }, {
    id: 'launch_report_1',
    walletPublicKey: 'ReportWallet111111111111111111111111111111111',
    token: { mint: 'ReportMint1111111111111111111111111111111111' },
    poolPlan: { allocations: [{ quoteToken: 'SOL', supplyPercent: 80 }] },
    transfer: terminalTransfer,
  }, 'ReportWallet111111111111111111111111111111111');
  assert.equal(backedTerminalTransferJournal.backed, true);
  assert.deepEqual([...backedTerminalTransferJournal.missing], []);
  assert.deepEqual([...backedTerminalTransferJournal.mismatches], []);

  const weakTransferJournal = sandbox.v2LaunchDataJournalState({
    launchWallet: 'ReportWallet111111111111111111111111111111111',
    mint: 'ReportMint1111111111111111111111111111111111',
    token: { mint: 'ReportMint1111111111111111111111111111111111' },
    recoveryAudit: { journalId: 'launch_report_1' },
    transfer: terminalTransfer,
  }, {
    id: 'launch_report_1',
    walletPublicKey: 'ReportWallet111111111111111111111111111111111',
    token: { mint: 'ReportMint1111111111111111111111111111111111' },
    poolPlan: { allocations: [{ quoteToken: 'SOL', supplyPercent: 80 }] },
    transfer: { destinationWallet: terminalTransfer.destinationWallet },
  }, 'ReportWallet111111111111111111111111111111111');
  assert.equal(weakTransferJournal.backed, false);
  assert.match([...weakTransferJournal.missing].join(','), /terminal journal sweep/);

  const mismatchedTransferJournal = sandbox.v2LaunchDataJournalState({
    launchWallet: 'ReportWallet111111111111111111111111111111111',
    mint: 'ReportMint1111111111111111111111111111111111',
    token: { mint: 'ReportMint1111111111111111111111111111111111' },
    recoveryAudit: { journalId: 'launch_report_1' },
    transfer: terminalTransfer,
  }, {
    id: 'launch_report_1',
    walletPublicKey: 'ReportWallet111111111111111111111111111111111',
    token: { mint: 'ReportMint1111111111111111111111111111111111' },
    poolPlan: { allocations: [{ quoteToken: 'SOL', supplyPercent: 80 }] },
    transfer: {
      ...terminalTransfer,
      tokenSweep: {
        transferred: [{
          mint: 'ReportMint1111111111111111111111111111111111',
          amount: '1',
          decimals: 9,
          txId: 'OtherReportSweepTx11111111111111111111111111',
        }],
        errors: [],
      },
    },
  }, 'ReportWallet111111111111111111111111111111111');
  assert.equal(mismatchedTransferJournal.backed, false);
  assert.match([...mismatchedTransferJournal.mismatches].join(','), /sweep evidence hash/);

  const missingJournal = sandbox.v2LaunchDataJournalState({
    launchWallet: 'ReportWallet111111111111111111111111111111111',
    mint: 'ReportMint1111111111111111111111111111111111',
    token: { mint: 'ReportMint1111111111111111111111111111111111' },
    recoveryAudit: { journalId: 'launch_report_1' },
  }, null, 'ReportWallet111111111111111111111111111111111');
  assert.equal(missingJournal.backed, false);
  assert.match([...missingJournal.missing].join(','), /launch journal/);

  const mismatchedJournal = sandbox.v2LaunchDataJournalState({
    launchWallet: 'OtherWallet1111111111111111111111111111111111',
    mint: 'OtherMint11111111111111111111111111111111111',
    token: { mint: 'OtherMint11111111111111111111111111111111111' },
    recoveryAudit: { journalId: 'launch_other' },
  }, {
    id: 'launch_report_1',
    walletPublicKey: 'ReportWallet111111111111111111111111111111111',
    token: { mint: 'ReportMint1111111111111111111111111111111111' },
    poolPlan: { allocations: [{ quoteToken: 'SOL', supplyPercent: 80 }] },
  }, 'ReportWallet111111111111111111111111111111111');
  assert.equal(mismatchedJournal.backed, false);
  assert.match([...mismatchedJournal.mismatches].join(','), /launch wallet/);
  assert.match([...mismatchedJournal.mismatches].join(','), /journal id/);
  assert.match([...mismatchedJournal.mismatches].join(','), /journal token mint/);

  const completeProof = sandbox.v2LaunchDataReportCompletenessState({
    launchWallet: 'ReportWallet111111111111111111111111111111111',
    mint: 'ReportMint1111111111111111111111111111111111',
    token: {
      mint: 'ReportMint1111111111111111111111111111111111',
      authorities: {
        mintAuthorityRenounced: true,
        freezeAuthorityDisabled: true,
        metadataUpdateAuthorityRevoked: true,
        metadataImmutable: true,
      },
    },
    plannedPools: [{ quoteToken: 'SOL', supplyPercent: 80, ammConfigIndex: 8, plannedPositionCount: 1 }],
    pools: [{
      poolId: 'ReportPool1111111111111111111111111111111111',
      createPoolTx: 'CreatePoolTx11111111111111111111111111111111',
      quoteMint: 'So11111111111111111111111111111111111111112',
      supplyPercent: 80,
      positions: [{
        type: 'main',
        positionNftMint: 'PositionNft111111111111111111111111111111',
        feeKeyNftMint: 'FeeKeyNft1111111111111111111111111111111',
        locked: true,
        openTx: 'OpenPositionTx11111111111111111111111111111',
        lockTx: 'LockPositionTx11111111111111111111111111111',
      }],
    }],
    liquidity: { positionCount: 1, lockedPositionCount: 1, feeKeyCount: 1 },
  });
  assert.equal(completeProof.complete, true);
  assert.deepEqual([...completeProof.missing], []);

  const thinProof = sandbox.v2LaunchDataReportCompletenessState({
    launchWallet: 'ReportWallet111111111111111111111111111111111',
    mint: 'ReportMint1111111111111111111111111111111111',
    token: {
      mint: 'ReportMint1111111111111111111111111111111111',
      authorities: {
        mintAuthorityRenounced: true,
        freezeAuthorityDisabled: true,
        metadataUpdateAuthorityRevoked: true,
        metadataImmutable: true,
      },
    },
    plannedPools: [{ quoteToken: 'SOL', supplyPercent: 80, ammConfigIndex: 8, plannedPositionCount: 1 }],
    pools: [],
    liquidity: { positionCount: 0, lockedPositionCount: 0, feeKeyCount: 0 },
  });
  assert.equal(thinProof.complete, false);
  assert.match([...thinProof.missing].join(','), /pool proof/);
  assert.match([...thinProof.missing].join(','), /position count/);

  const missingRecipientTransfer = sandbox.v2LaunchDataReportCompletenessState({
    launchWallet: 'ReportWallet111111111111111111111111111111111',
    mint: 'ReportMint1111111111111111111111111111111111',
    token: {
      mint: 'ReportMint1111111111111111111111111111111111',
      authorities: {
        mintAuthorityRenounced: true,
        freezeAuthorityDisabled: true,
        metadataUpdateAuthorityRevoked: true,
        metadataImmutable: true,
      },
    },
    plannedPools: [{ quoteToken: 'SOL', supplyPercent: 80, ammConfigIndex: 8, plannedPositionCount: 1 }],
    pools: [{
      poolId: 'ReportPool1111111111111111111111111111111111',
      createPoolTx: 'CreatePoolTx11111111111111111111111111111111',
      supplyPercent: 80,
      positions: [{
        positionNftMint: 'PositionNft111111111111111111111111111111',
        feeKeyNftMint: 'FeeKeyNft1111111111111111111111111111111',
        recipient: 'Recipient111111111111111111111111111111111',
        locked: true,
        openTx: 'OpenPositionTx11111111111111111111111111111',
        lockTx: 'LockPositionTx11111111111111111111111111111',
      }],
    }],
    liquidity: { positionCount: 1, lockedPositionCount: 1, feeKeyCount: 1 },
  });
  assert.equal(missingRecipientTransfer.complete, false);
  assert.match([...missingRecipientTransfer.missing].join(','), /fee key recipient transfer proof/);

  const mismatchedRecipientTransfer = sandbox.v2LaunchDataReportCompletenessState({
    launchWallet: 'ReportWallet111111111111111111111111111111111',
    mint: 'ReportMint1111111111111111111111111111111111',
    token: {
      mint: 'ReportMint1111111111111111111111111111111111',
      authorities: {
        mintAuthorityRenounced: true,
        freezeAuthorityDisabled: true,
        metadataUpdateAuthorityRevoked: true,
        metadataImmutable: true,
      },
    },
    plannedPools: [{ quoteToken: 'SOL', supplyPercent: 80, ammConfigIndex: 8, plannedPositionCount: 1 }],
    pools: [{
      poolId: 'ReportPool1111111111111111111111111111111111',
      createPoolTx: 'CreatePoolTx11111111111111111111111111111111',
      supplyPercent: 80,
      positions: [{
        positionNftMint: 'PositionNft111111111111111111111111111111',
        feeKeyNftMint: 'FeeKeyNft1111111111111111111111111111111',
        recipient: 'Recipient111111111111111111111111111111111',
        transferredTo: 'OtherRecipient1111111111111111111111111111',
        locked: true,
        openTx: 'OpenPositionTx11111111111111111111111111111',
        lockTx: 'LockPositionTx11111111111111111111111111111',
        transferTx: 'TransferPositionTx1111111111111111111111111',
      }],
    }],
    liquidity: { positionCount: 1, lockedPositionCount: 1, feeKeyCount: 1 },
  });
  assert.equal(mismatchedRecipientTransfer.complete, false);
  assert.match([...mismatchedRecipientTransfer.missing].join(','), /fee key recipient transfer proof/);

  const thinReport = sandbox.v2LaunchDataConfigConsistencyState({
    name: 'Report Token',
    symbol: 'RPT',
    totalSupply: '1000000',
    decimals: 9,
    launchConfig: {
      token: { name: 'Report Token', symbol: 'RPT', supply: '1000000', decimals: 9 },
      poolTopology: { pools: [{ quoteToken: 'SOL', supplyPercent: 80, ammConfigIndex: 8 }] },
    },
  });
  assert.equal(thinReport.consistent, false);
  assert.deepEqual([...thinReport.mismatches], ['planned pool count']);

  const missingReportFields = sandbox.v2LaunchDataConfigConsistencyState({
    symbol: 'RPT',
    totalSupply: '1000000',
    plannedPools: [{ quoteToken: 'SOL', supplyPercent: 80, ammConfigIndex: 8 }],
    launchConfig: {
      token: { name: 'Report Token', symbol: 'RPT', supply: '1000000', decimals: 9 },
      poolTopology: { pools: [{ quoteToken: 'SOL', supplyPercent: 80, ammConfigIndex: 8 }] },
    },
  });
  assert.equal(missingReportFields.consistent, false);
  assert.match([...missingReportFields.mismatches].join(','), /token name/);
  assert.match([...missingReportFields.mismatches].join(','), /token decimals/);

  const mismatched = sandbox.v2LaunchDataConfigConsistencyState({
    name: 'Report Token',
    symbol: 'RPT',
    totalSupply: '1000000',
    decimals: 9,
    plannedPools: [{ quoteToken: 'SOL', supplyPercent: 80, ammConfigIndex: 8 }],
    launchConfig: {
      token: { name: 'Stale Token', symbol: 'OLD', supply: '42', decimals: 6 },
      poolTopology: { pools: [{ quoteToken: 'USDC', supplyPercent: 20, ammConfigIndex: 5 }] },
    },
  }, {
    token: { name: 'Report Token', symbol: 'RPT', totalSupply: '1000000', decimals: 9 },
    poolPlan: { allocations: [{ quoteToken: 'SOL', supplyPercent: 80, ammConfigIndex: 8 }] },
  });
  assert.equal(mismatched.consistent, false);
  assert.match([...mismatched.mismatches].join(','), /token name/);
  assert.match([...mismatched.mismatches].join(','), /planned pool 1/);
  assert.match([...mismatched.mismatches].join(','), /journal token symbol/);
  assert.match([...mismatched.mismatches].join(','), /journal planned pool 1/);

  assert.match(serverSource, /const launchConfigSnapshot = v2LaunchDataConfigSnapshotState\(launchData\)/);
  assert.match(serverSource, /const reportJournal = launchJournalForReport\(walletPublicKey, launchData\)/);
  assert.match(serverSource, /const launchJournalBinding = v2LaunchDataJournalState\(launchData, reportJournal, walletPublicKey\)/);
  assert.match(serverSource, /const launchConfigConsistency = v2LaunchDataConfigConsistencyState\(launchData, reportJournal, \{/);
  assert.match(serverSource, /requireJournalFields: true/);
  assert.match(serverSource, /launchJournal\.update\(reportJournal\.id, reportPublishPatch, reportPublishEvent\)/);
  assert.match(serverSource, /const launchProofCompleteness = v2LaunchDataReportCompletenessState\(launchData\)/);
  assert.match(serverSource, /launch-journal-missing/);
  assert.match(serverSource, /launchJournalMissing: launchJournalBinding\.missing\.length > 0/);
  assert.match(serverSource, /launch-journal-mismatch/);
  assert.match(serverSource, /launchJournalMismatch: launchJournalBinding\.mismatches\.length > 0/);
  assert.match(serverSource, /launch-config-snapshot-incomplete/);
  assert.match(serverSource, /launchConfigIncomplete: true/);
  assert.match(serverSource, /launch-config-snapshot-mismatch/);
  assert.match(serverSource, /launchConfigMismatch: true/);
  assert.match(serverSource, /launch-proof-incomplete/);
  assert.match(serverSource, /launchProofIncomplete: true/);
});

test('server exposes the v2 launch-plan contract as an authenticated API route', () => {
  assert.match(serverSource, /app\.post\('\/api\/v2\/launch-plan'/);
  assert.match(serverSource, /app\.post\('\/api\/v2\/execution-readiness'/);
  assert.match(serverSource, /app\.post\('\/api\/v2\/demo-launch\/run'/);
  assert.match(serverSource, /app\.get\('\/api\/v2\/wallets'/);
  assert.match(serverSource, /app\.post\('\/api\/v2\/wallets\/generate'/);
  assert.match(serverSource, /app\.post\('\/api\/v2\/wallets\/import'/);
  assert.match(serverSource, /app\.post\('\/api\/v2\/run-envelope\/arm'/);
  assert.match(serverSource, /app\.post\('\/api\/v2\/run-envelope\/execute-next'/);
  assert.match(serverSource, /const v2RunEnvelopes = new Map\(\)/);
  assert.match(serverSource, /requireV2RunEnvelope\(/);
  assert.match(serverSource, /String\(req\.body\?\.runEnvelopeId \|\| ''\)\.trim\(\)/);
  assert.match(serverSource, /runEnvelope\.configFingerprint === readiness\.plan\?\.v2LaunchConfigFingerprint/);
  assert.match(serverSource, /runEnvelope\.fundingEstimateHash === v2RunEnvelopeFundingHash\(req\.body\?\.fundingEstimate\)/);
  assert.match(serverSource, /result\?\.walletEmpty === true/);
  assert.match(serverSource, /result\?\.hasPartialFailure !== true/);
  assert.match(serverSource, /v2RunEnvelopes\.delete\(runEnvelope\.id\)/);
  assert.match(serverSource, /app\.get\('\/api\/v2\/viewport-smoke-proof'/);
  assert.match(serverSource, /readV2ViewportSmokeProof/);
  assert.match(serverSource, /currentV2ViewportSmokeAssetHashes/);
  assert.match(serverSource, /viewport-smoke-proof\.json/);
  assert.match(serverSource, /const artifactVersion = parsed\?\.artifactVersion \?\? null/);
  assert.match(serverSource, /const kind = parsed\?\.kind \|\| null/);
  assert.match(serverSource, /const V2_VIEWPORT_SMOKE_REQUIRED_CHECKS = \[/);
  assert.match(serverSource, /function missingViewportSmokeChecks/);
  assert.match(serverSource, /function viewportSmokeRequiredChecksMatch/);
  assert.match(serverSource, /checks\[check\] !== true/);
  assert.match(serverSource, /requiredChecks: V2_VIEWPORT_SMOKE_REQUIRED_CHECKS/);
  assert.match(serverSource, /expectedRequiredChecks: V2_VIEWPORT_SMOKE_REQUIRED_CHECKS/);
  assert.match(serverSource, /stale required-check contract/);
  assert.match(serverSource, /Missing checks:/);
  assert.match(serverSource, /artifactVersion,/);
  assert.match(serverSource, /kind,/);
  assert.match(serverSource, /app\.get\('\/api\/app-version'/);
  assert.match(serverSource, /releaseTrust: \{/);
  assert.match(serverSource, /Unsigned test artifact/);
  assert.match(serverSource, /notarizationStatus: macos \? 'not-notarized' : 'not-applicable'/);
  assert.match(serverSource, /app\.post\('\/api\/check-for-updates'/);
  assert.match(serverSource, /updateCheckBridge\.triggerManual\(\)/);
  assert.match(serverSource, /buildV2LaunchPlan\(req\.body \|\| \{\}/);
  assert.match(
    serverSource,
    /const plan = buildV2LaunchPlan\(\{\s+\.\.\.config,\s+walletPublicKey,\s+\}, \{/,
  );
  assert.match(serverSource, /buildV2ExecutionReadiness\(config/);
  assert.match(serverSource, /requireCurrentFundingEstimate: true/);
  assert.match(serverSource, /invokeJsonHandler\(demoChainService\.handleCreateToken/);
  assert.match(serverSource, /const lpReadiness = buildV2ExecutionReadiness\(config,/);
  assert.match(serverSource, /lpReadiness\.classicPayloads\.createLp/);
  assert.match(serverSource, /invokeJsonHandler\(demoChainService\.handleCreateLp/);
  assert.match(serverSource, /invokeJsonHandler\(\s*demoChainService\.handleTransferAssets/);
  assert.match(serverSource, /transfer: transferResult/);
  assert.doesNotMatch(serverSource, /transferComplete: true/);
  assert.match(serverSource, /executeV2NextClassicOperation/);
  assert.match(serverSource, /v2WalletBalanceObservation/);
  assert.match(serverSource, /v2ObservedWalletDelta/);
  assert.match(serverSource, /observedWalletDelta/);
  assert.match(serverSource, /async function v2FundingBalanceContext/);
  assert.match(serverSource, /await checkWalletBalanceMultiToken\(walletPublicKey\)/);
  assert.match(serverSource, /requireFundingBalance: true/);
  assert.match(serverSource, /walletBalanceError/);
  assert.match(serverSource, /const \{ wallet, readiness \} = await v2ReadinessForManagedWallet/);
  assert.match(serverSource, /v2ExecutionProofFromContext/);
  assert.match(serverSource, /readiness\.proof = v2ExecutionProofFromContext/);
  assert.match(serverSource, /function v2PoolTopologySnapshotFromPlan/);
  assert.match(serverSource, /function v2LaunchConfigSnapshotFromPlan/);
  assert.match(serverSource, /schema: 'trebuchet-v2-launch-config'/);
  assert.match(serverSource, /source: 'trebuchet-v2'/);
  assert.match(serverSource, /const journalToken = journal\?\.token && typeof journal\.token === 'object'/);
  assert.match(serverSource, /const tokenSource = journalToken \|\| token/);
  assert.match(serverSource, /topology\.pools = cloneJson\(journalPoolPlan\.allocations\)/);
  assert.match(serverSource, /targetMarketCapUsd: Number\.isFinite\(Number\(topology\?\.targetMarketCapUsd\)\)/);
  assert.match(serverSource, /launchConfig: v2LaunchConfigSnapshotFromPlan\(plan, journal\)/);
  assert.match(serverSource, /const logo = token\.logo && typeof token\.logo === 'object'/);
  assert.doesNotMatch(serverSource, /dataUrl: token\.logo/);
  assert.match(serverSource, /rpc: \{ activeUrl: getRpcConfig\(\)\.active \}/);
  assert.match(serverSource, /const terminalTransfer = journal\?\.transfer \|\| body\.transfer \|\| null/);
  assert.match(serverSource, /function v2TransferHasWalletEmptyFinalSweepEvidence\(transfer = null\)/);
  assert.match(serverSource, /transferComplete: v2TransferHasWalletEmptyFinalSweepEvidence\(terminalTransfer\)/);
  assert.doesNotMatch(serverSource, /transferComplete: journal\?\.status === 'completed'/);
  assert.match(serverSource, /tokenSweep: tokenSweep \|\| \{ transferred: \[\], errors: \[\] \}/);
  assert.match(serverSource, /nftSweep: nftSweep \|\| \{ transferred: \[\], errors: \[\] \}/);
  assert.match(serverSource, /solSweep: solSweep \|\| \{ solTransferred: solTransferred \|\| 0 \}/);
  assert.match(serverSource, /solSweep,\s*\n\s*solSweepError,/);
  assert.match(serverSource, /const journalPoolPlan = journal\?\.poolPlan && typeof journal\.poolPlan === 'object'/);
  assert.match(serverSource, /poolPlan: journalPoolPlan/);
  assert.match(serverSource, /const destinationWallet =\s*transfer\?\.destinationWallet \|\|\s*readiness\?\.classicPayloads\?\.transferAssets\?\.destinationWallet \|\|/);
  assert.match(serverSource, /destinationWallet: v2ProofEffectiveDestination\(proof\)/);
  assert.match(serverSource, /const terminalTransferEvidenceHash = v2TransferHasWalletEmptyFinalSweepEvidence\(proof\?\.transfer\)/);
  assert.match(serverSource, /terminalTransferEvidenceHash,/);
  assert.match(serverSource, /function v2TransferFinalizationIssue/);
  assert.match(serverSource, /function v2LocalDossierFinalizationIssue/);
  assert.match(serverSource, /function v2ReportPublishFinalizationIssue/);
  assert.match(serverSource, /function v2ReportPublishUriHasPermanentScheme/);
  assert.match(serverSource, /function v2ReportPublishHasPermanentEvidence/);
  assert.match(serverSource, /report\.status === 'done'/);
  assert.match(serverSource, /report\.alreadyPublished === true/);
  assert.match(serverSource, /String\(report\.publishedAt \|\| ''\)\.trim\(\)/);
  assert.match(serverSource, /if \(!v2ReportPublishHasPermanentEvidence\(report\)\) return 'publish metadata missing'/);
  assert.match(serverSource, /v2LocalDossierFilenameMatchesKind\(filename, kind\)/);
  assert.match(serverSource, /const reportIssue = v2ReportPublishFinalizationIssue\(report, proof\)/);
  assert.match(serverSource, /proofFingerprint !== v2LaunchProofFingerprint\(proof\)/);
  assert.match(serverSource, /const proofMint = String\(proof\?\.token\?\.mint \|\| ''\)\.trim\(\)/);
  assert.match(serverSource, /const dossierMint = String\(dossier\.mint \|\| ''\)\.trim\(\)/);
  assert.match(serverSource, /if \(proofMint && !reportMint\) return 'token mint missing'/);
  assert.match(serverSource, /if \(proofMint && reportMint !== proofMint\) return 'token mint mismatch'/);
  assert.match(serverSource, /if \(proofMint && !dossierMint\) return 'token mint missing'/);
  assert.match(serverSource, /if \(proofMint && dossierMint !== proofMint\) return 'token mint mismatch'/);
  assert.match(serverSource, /Launch report is not bound to this token mint; republish before final sweep/);
  assert.match(serverSource, /terminal sweep evidence hash mismatch/);
  assert.match(serverSource, /if \(!airdropStatus\.complete\) \{/);
  assert.match(serverSource, /Airdrop proof is incomplete/);
  assert.doesNotMatch(serverSource, /if \(userPrefs\.get\(\)\.publishLaunchReport === false\) return null/);
  assert.match(serverSource, /Report publishing is off; attach the local dossier before final sweep/);
  assert.match(serverSource, /Publish or attach the launch report before final sweep/);
  assert.match(serverSource, /V2_AUTHORITY_COMPARISON_FIELDS/);
  assert.match(serverSource, /v2NormalizeAirdropForFingerprint\(proof\?\.airdrop \|\| \{\}\)/);
  assert.match(serverSource, /function v2LaunchDataConfigSnapshotState/);
  assert.match(serverSource, /function v2LaunchConfigSnapshotHasV2Envelope/);
  assert.match(serverSource, /missing\.push\('v2 snapshot marker'\)/);
  assert.match(serverSource, /v2TrimmedText\(position\?\.transferredTo\) === v2TrimmedText\(position\?\.recipient\)/);
  assert.match(serverSource, /v2TrimmedText\(position\?\.transferredTo\) !== v2TrimmedText\(position\?\.recipient\)/);
  assert.match(serverSource, /journal Fee Key recipient delivery proof/);
  assert.match(serverSource, /const launchConfigSnapshot = v2LaunchDataConfigSnapshotState\(launchData\)/);
  assert.match(serverSource, /launchConfigIncomplete: true/);
  assert.match(serverSource, /function v2LaunchDataConfigConsistencyState/);
  assert.match(serverSource, /function v2LaunchDataJournalState/);
  assert.match(serverSource, /function v2LaunchDataJournalId\(launchData = \{\}\)/);
  assert.match(serverSource, /function launchJournalForReport\(walletPublicKey, launchData = \{\}\)/);
  assert.match(serverSource, /const requestedId = v2LaunchDataJournalId\(launchData\)/);
  assert.match(serverSource, /const exact = launchJournal\.get\(requestedId\)/);
  assert.match(serverSource, /return exact && exact\.status !== 'archived' \? exact : null/);
  assert.match(serverSource, /const reportJournal = launchJournalForReport\(walletPublicKey, launchData\)/);
  assert.match(serverSource, /const launchJournalBinding = v2LaunchDataJournalState\(launchData, reportJournal, walletPublicKey\)/);
  assert.match(serverSource, /const launchConfigConsistency = v2LaunchDataConfigConsistencyState\(launchData, reportJournal, \{/);
  assert.match(serverSource, /requireJournalFields: true/);
  assert.match(serverSource, /launchJournal\.update\(reportJournal\.id, reportPublishPatch, reportPublishEvent\)/);
  assert.match(serverSource, /launchJournalMissing: launchJournalBinding\.missing\.length > 0/);
  assert.match(serverSource, /launchJournalMismatch: launchJournalBinding\.mismatches\.length > 0/);
  assert.match(serverSource, /launchConfigMismatch: true/);
  assert.match(serverSource, /function v2LaunchDataReportCompletenessState/);
  assert.match(serverSource, /const launchProofCompleteness = v2LaunchDataReportCompletenessState\(launchData\)/);
  assert.match(serverSource, /launchProofIncomplete: true/);
  assert.match(serverSource, /const plannedAirdropCount = Math\.max\(/);
  assert.match(serverSource, /plan\.poolTopology\.airdrop\.recipientCount/);
  assert.match(serverSource, /plannedRecipientCount: plannedAirdropCount/);
  assert.match(serverSource, /const reportablePoolIdentity = Boolean\(/);
  assert.match(serverSource, /poolIds\.length === plannedPoolCount/);
  assert.match(serverSource, /lpResults\.length === plannedPoolCount/);
  assert.match(serverSource, /const feeKeyRecipientSummary = v2ProofFeeKeyRecipientSummary\(lpResults\)/);
  assert.match(serverSource, /const poolCreateTxCount = v2ProofPoolCreateTxCount\(lpResults\)/);
  assert.match(serverSource, /const positionOpenTxCount = v2ProofPositionOpenTxCount\(lpResults\)/);
  assert.match(serverSource, /const positionLockTxCount = v2ProofPositionLockTxCount\(lpResults\)/);
  assert.match(serverSource, /const tokenAuthoritiesComplete = Boolean\(/);
  assert.match(serverSource, /const reportableExecutionProof = Boolean\(/);
  assert.match(serverSource, /poolCreateTxCount >= plannedPoolCount/);
  assert.match(serverSource, /positionOpenTxCount >= positionCount/);
  assert.match(serverSource, /lockCount >= positionCount/);
  assert.match(serverSource, /positionLockTxCount >= positionCount/);
  assert.match(serverSource, /feeKeyCount >= lockCount/);
  assert.match(serverSource, /feeKeyRecipientSummary\.delivered >= feeKeyRecipientSummary\.target/);
  assert.match(serverSource, /canPublishReport: reportableExecutionProof/);
  assert.match(serverSource, /function v2ProofPoolCreateTxCount\(results = \[\]\)/);
  assert.match(serverSource, /function v2ProofPositionOpenTxCount\(results = \[\]\)/);
  assert.match(serverSource, /function v2ProofPositionLockTxCount\(results = \[\]\)/);
  assert.match(serverSource, /function v2ProofFeeKeyRecipientSummary\(results = \[\]\)/);
  assert.match(serverSource, /v2ProofPoolsForFingerprint\(results\)/);
  assert.match(serverSource, /v2ProofPositionsForFingerprint\(results\)/);
  assert.match(serverSource, /recipient: position\.recipient \|\| null/);
  assert.match(serverSource, /transferredTo: position\.transferredTo \|\| null/);
  assert.match(serverSource, /lowerMultiplier: v2NumberOrNull\(position\.lowerMultiplier\)/);
  assert.match(serverSource, /upperMultiplier: v2NumberOrNull\(position\.upperMultiplier\)/);
  assert.match(serverSource, /depthPct: v2NumberOrNull\(position\.depthPct\)/);
  assert.match(serverSource, /transferTx: position\.transferTx \|\| position\.txIds\?\.transfer \|\| null/);
  assert.match(serverSource, /authorities: V2_AUTHORITY_COMPARISON_FIELDS\.reduce/);
  assert.match(serverSource, /v2AirdropCompletionStatus\(proof\)/);
  assert.match(serverSource, /v2LaunchProofFingerprint\(proof\)/);
  assert.match(serverSource, /!reportFingerprint \|\| reportFingerprint !== v2LaunchProofFingerprint\(proof\)/);
  assert.match(serverSource, /function v2TransferEvidenceHash\(transfer = \{\}\)/);
  assert.match(serverSource, /submittedTransferEvidenceHash/);
  assert.match(serverSource, /reason: 'transfer-evidence-hash-mismatch'/);
  assert.match(serverSource, /const finalizationIssue = v2TransferFinalizationIssue\(readiness, \{\s*localDossier: req\.body\?\.localDossier,\s*\}\)/);
  assert.match(serverSource, /code: 'V2_FINALIZATION_BLOCKED'/);
  assert.ok(
    serverSource.indexOf('const finalizationIssue = v2TransferFinalizationIssue(readiness, {') <
      serverSource.indexOf('const result = await executeV2NextClassicOperation(readiness)'),
    'v2 execute-next must block incomplete Step 6 finalization before transfer-assets',
  );
  assert.match(serverSource, /async function runV2ClassicLpPreflight/);
  assert.match(serverSource, /preflightCreatePoolsAndPositions\(\{/);
  assert.match(serverSource, /code = 'V2_LP_PREFLIGHT_FAILED'/);
  assert.match(serverSource, /error\?\.errorDetails/);
  assert.match(serverSource, /invokeJsonHandler\(createTokenHandler, readiness\.classicPayloads\.createToken\)/);
  assert.ok(
    serverSource.indexOf('runV2ClassicLpPreflight(readiness.classicPayloads.preflightCreateLp)') <
      serverSource.indexOf('invokeJsonHandler(createLpHandler, readiness.classicPayloads.createLp)'),
    'v2 execute-next must run Classic LP preflight before create-lp',
  );
  assert.match(serverSource, /v2Preflight: preflight/);
  assert.match(serverSource, /invokeJsonHandler\(createLpHandler, readiness\.classicPayloads\.createLp\)/);
  assert.match(serverSource, /invokeJsonHandler\(resumeLaunchHandler, readiness\.classicPayloads\.resumeLaunch\)/);
  assert.match(serverSource, /invokeJsonHandler\(transferAssetsHandler, readiness\.classicPayloads\.transferAssets\)/);
  assert.match(serverSource, /confirmNextEndpoint/);
  assert.match(serverSource, /parseImportedWalletSecret/);
  assert.match(serverSource, /pendingWallets\.add/);
  assert.match(serverSource, /demoManagedWallets/);
  assert.match(serverSource, /rememberDemoManagedWallet/);
  assert.match(serverSource, /secretAvailable: Array\.isArray\(wallet\?\.secretKey\)/);
  assert.match(serverSource, /app\.post\('\/api\/secret-pin\/reset'/);
  assert.match(serverSource, /pendingWallets\.removePinEncrypted\(\)/);
  assert.match(serverSource, /vanityCaStore\.removePinEncrypted\(\)/);
  assert.match(serverSource, /secretStore\.resetSecretPin\(\)/);
  assert.match(serverSource, /demoMode: isDemoMode\(\)/);
  assert.match(serverSource, /assertClassicLogoDimensions\(req\.file\.buffer\)/);
  assert.match(serverSource, /assertClassicLogoDimensions\(decoded\)/);
  assert.match(serverSource, /function validateTransferAirdropPayload/);
  assert.match(serverSource, /validateTransferAirdropPayload\(req\.body\.airdrop\)/);
  assert.match(serverSource, /let reportTransferEvidenceHash = null/);
  assert.match(serverSource, /sweepEvidenceHash: reportTransferEvidenceHash/);
  assert.match(serverSource, /priorMatchesTransferEvidence/);
  assert.ok(
    serverSource.indexOf('validateTransferAirdropPayload(req.body.airdrop)') <
      serverSource.indexOf('const nftSweep = await sweepNftsToDestination'),
    'transfer-assets must validate airdrop payload before any sweep work starts',
  );
  assert.ok(
    serverSource.indexOf("app.use('/api', apiSessionMiddleware)") <
      serverSource.indexOf("app.post('/api/v2/launch-plan'"),
    'v2 launch-plan route must be registered after API session middleware',
  );
});

test('server selects the proof-bound journal for v2 report publishing', () => {
  const helperStart = serverSource.indexOf('function latestLaunchJournalForWallet');
  const helperEnd = serverSource.indexOf('\nfunction v2ExecutionContextFromJournal', helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, 'report journal selector should be extractable');

  const journals = [
    {
      id: 'launch_old',
      walletPublicKey: 'ReportWallet111111111111111111111111111111111',
      status: 'completed',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    {
      id: 'launch_latest',
      walletPublicKey: 'ReportWallet111111111111111111111111111111111',
      status: 'completed',
      updatedAt: '2026-01-02T00:00:00.000Z',
    },
    {
      id: 'launch_archived',
      walletPublicKey: 'ReportWallet111111111111111111111111111111111',
      status: 'archived',
      updatedAt: '2026-01-03T00:00:00.000Z',
    },
  ];
  const sandbox = {
    launchJournal: {
      activeForWallet() {
        return null;
      },
      get(id) {
        return journals.find((journal) => journal.id === id) || null;
      },
      list() {
        return journals.filter((journal) => journal.status !== 'archived');
      },
    },
  };
  vm.runInNewContext(
    [
      serverSource.slice(helperStart, helperEnd),
      'globalThis.v2LaunchDataJournalId = v2LaunchDataJournalId;',
      'globalThis.launchJournalForReport = launchJournalForReport;',
    ].join('\n'),
    sandbox,
    { filename: 'server.js v2 report journal selector harness' },
  );

  assert.equal(
    sandbox.v2LaunchDataJournalId({
      journalId: '  launch_direct  ',
      recoveryAudit: { journalId: 'launch_audit' },
    }),
    'launch_direct',
  );
  assert.equal(
    sandbox.v2LaunchDataJournalId({ recoveryAudit: { journalId: '  launch_audit  ' } }),
    'launch_audit',
  );
  assert.equal(
    sandbox.launchJournalForReport('ReportWallet111111111111111111111111111111111', {
      recoveryAudit: { journalId: 'launch_old' },
    }).id,
    'launch_old',
  );
  assert.equal(
    sandbox.launchJournalForReport('ReportWallet111111111111111111111111111111111', {}).id,
    'launch_latest',
  );
  assert.equal(
    sandbox.launchJournalForReport('ReportWallet111111111111111111111111111111111', {
      journalId: 'launch_archived',
    }),
    null,
  );
  assert.equal(
    sandbox.launchJournalForReport('ReportWallet111111111111111111111111111111111', {
      journalId: 'launch_missing',
    }),
    null,
  );
});
