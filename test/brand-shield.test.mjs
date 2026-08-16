import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Keypair } from '@solana/web3.js';

import {
  assessBrandRisk,
  buildBrandFingerprint,
  fetchMetadataFingerprint,
  findDexScreenerBrandCandidates,
  metadataDocumentHash,
  signLaunchAttestation,
  verifyLaunchAttestation,
} from '../brandShieldService.js';
import {
  listLaunches,
  publicState,
  recordAlert,
  recordObservation,
  registerLaunch,
} from '../brandShieldStore.js';

const MINT = '11111111111111111111111111111111';
const COPY_MINT = '11111111111111111111111111111112';

function officialLaunch() {
  const wallet = Keypair.generate();
  const metadata = {
    name: 'XRAT',
    symbol: 'XRAT',
    description: 'Official test launch',
    image: 'https://arweave.net/xrat-image',
  };
  const fingerprint = buildBrandFingerprint({
    mint: MINT,
    name: metadata.name,
    symbol: metadata.symbol,
    metadataUri: 'https://arweave.net/xrat-metadata',
    metadataHash: metadataDocumentHash(metadata),
    imageUri: metadata.image,
    supply: '1000000000',
    decimals: 9,
    launchWallet: wallet.publicKey.toBase58(),
    journalId: 'launch-xrat',
    createdAt: '2026-08-13T00:00:00.000Z',
    sealedLaunch: true,
  });
  return { wallet, fingerprint };
}

test('signed launch provenance verifies only for its fingerprint and launch wallet', () => {
  const { wallet, fingerprint } = officialLaunch();
  const attestation = signLaunchAttestation(fingerprint, [...wallet.secretKey], {
    signedAt: '2026-08-13T00:01:00.000Z',
  });

  assert.equal(verifyLaunchAttestation(fingerprint, attestation), true);
  assert.equal(verifyLaunchAttestation({ ...fingerprint, launchWallet: Keypair.generate().publicKey.toBase58() }, attestation), false);
  assert.equal(verifyLaunchAttestation({ ...fingerprint, fingerprintHash: '0'.repeat(64) }, attestation), false);
});

test('Brand Shield separates official mint, exact counterfeit, and identity lookalike', () => {
  const { wallet, fingerprint } = officialLaunch();
  const launch = {
    fingerprint,
    attestation: signLaunchAttestation(fingerprint, [...wallet.secretKey]),
  };

  const official = assessBrandRisk({ mint: MINT, metadata: {}, launches: [launch] });
  const counterfeit = assessBrandRisk({
    mint: COPY_MINT,
    metadata: {
      name: 'XRAT',
      symbol: 'XRAT',
      metadataUri: fingerprint.metadataUri,
      metadataHash: fingerprint.metadataHash,
    },
    launches: [launch],
  });
  const lookalike = assessBrandRisk({
    mint: COPY_MINT,
    metadata: { name: 'XRAT', symbol: 'XRAT', metadataUri: 'https://example.test/different' },
    launches: [launch],
  });

  assert.equal(official.classification, 'Official');
  assert.equal(official.provenanceVerified, true);
  assert.equal(counterfeit.classification, 'Counterfeit');
  assert.equal(counterfeit.scoreCap, 15);
  assert.equal(counterfeit.matchedMint, MINT);
  assert.equal(lookalike.classification, 'Suspected copy');
  assert.equal(lookalike.scoreCap, 35);
});

test('Brand Shield flags heavy capital motion during an official launch hour', () => {
  const { wallet, fingerprint } = officialLaunch();
  const assessment = assessBrandRisk({
    mint: MINT,
    metadata: {},
    launches: [{ fingerprint, attestation: signLaunchAttestation(fingerprint, [...wallet.secretKey]) }],
    liquidity: { earlyVolume1hUsd: 25_000, earlyBuys1h: 14 },
  });

  assert.equal(assessment.classification, 'Official');
  assert.equal(assessment.activityAlert, true);
  assert.equal(assessment.activityClassification, 'Early launch capital motion');
  assert.equal(assessment.risk, 'high');
  assert.equal(assessment.evidence.some((row) => row.id === 'early-capital-motion'), true);
});

test('liquidity-collapse alerts outrank early-motion labels', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'trebuchet-brand-priority-'));
  const originalConfigDir = process.env.TREBUCHET_CONFIG_DIR;
  process.env.TREBUCHET_CONFIG_DIR = directory;
  try {
    const alert = recordAlert({
      mint: MINT,
      assessment: {
        classification: 'Liquidity withdrawn',
        activityAlert: true,
        activityClassification: 'Early launch capital motion',
        risk: 'critical',
        evidence: [],
      },
    });
    assert.equal(alert.classification, 'Liquidity withdrawn');
    assert.equal(alert.risk, 'critical');
  } finally {
    if (originalConfigDir == null) delete process.env.TREBUCHET_CONFIG_DIR;
    else process.env.TREBUCHET_CONFIG_DIR = originalConfigDir;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('DexScreener scan keeps official pools and their short-window motion metrics', async () => {
  const { fingerprint } = officialLaunch();
  const rows = await findDexScreenerBrandCandidates([{ fingerprint }], {
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        pairs: [{
          chainId: 'solana',
          pairAddress: 'Pool111',
          dexId: 'raydium',
          pairCreatedAt: Date.parse('2026-08-13T00:00:00.000Z'),
          baseToken: { address: MINT, name: 'XRAT', symbol: 'XRAT' },
          quoteToken: { address: COPY_MINT, name: 'SOL', symbol: 'SOL' },
          liquidity: { usd: 12_000 },
          volume: { m5: 4_000, h1: 25_000 },
          txns: { m5: { buys: 4, sells: 1 }, h1: { buys: 14, sells: 3 } },
        }],
      }),
    }),
  });
  const official = rows.find((row) => row.mint === MINT);
  assert.equal(official.officialMint, true);
  assert.equal(official.pools[0].volume1hUsd, 25_000);
  assert.equal(official.pools[0].buys1h, 14);
});

test('remote metadata fingerprinting refuses hostnames that resolve to private networks', async () => {
  let fetched = false;
  const blocked = await fetchMetadataFingerprint('https://metadata.example/token.json', {
    lookupImpl: async () => [{ address: '127.0.0.1', family: 4 }],
    fetchImpl: async () => {
      fetched = true;
      return { ok: true, status: 200, text: async () => '{}' };
    },
  });
  assert.equal(blocked, null);
  assert.equal(fetched, false);

  const allowed = await fetchMetadataFingerprint('https://metadata.example/token.json', {
    lookupImpl: async () => [{ address: '203.0.113.10', family: 4 }],
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: (name) => name === 'content-length' ? '92' : null },
      text: async () => JSON.stringify({ name: 'XRAT', symbol: 'XRAT', image: 'https://arweave.net/xrat' }),
    }),
  });
  assert.equal(allowed.name, 'XRAT');
  assert.equal(allowed.metadataHash.length, 64);
});

test('remote metadata fingerprinting rejects oversized documents before buffering them', async () => {
  let textRead = false;
  const oversized = await fetchMetadataFingerprint('https://metadata.example/large.json', {
    lookupImpl: async () => [{ address: '203.0.113.10', family: 4 }],
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: (name) => name === 'content-length' ? String((512 * 1024) + 1) : null },
      text: async () => {
        textRead = true;
        return '{}';
      },
    }),
  });

  assert.equal(oversized, null);
  assert.equal(textRead, false);
});

test('remote metadata fingerprinting cancels a stream that crosses the byte cap', async () => {
  let readCount = 0;
  let cancelled = false;
  const oversized = await fetchMetadataFingerprint('https://metadata.example/stream.json', {
    lookupImpl: async () => [{ address: '203.0.113.10', family: 4 }],
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: {
        getReader() {
          return {
            async read() {
              readCount += 1;
              if (readCount <= 2) return { done: false, value: Buffer.alloc(300 * 1024) };
              return { done: true };
            },
            async cancel() { cancelled = true; },
          };
        },
      },
    }),
  });

  assert.equal(oversized, null);
  assert.equal(readCount, 2);
  assert.equal(cancelled, true);
});

test('persistent Brand Shield registry records liquidity-collapse alerts', () => {
  const originalConfigDir = process.env.TREBUCHET_CONFIG_DIR;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'trebuchet-brand-shield-'));
  process.env.TREBUCHET_CONFIG_DIR = directory;
  try {
    const { fingerprint } = officialLaunch();
    registerLaunch({ fingerprint, source: 'test' });
    recordObservation(COPY_MINT, { liquidityUsd: 1000 });
    const liquidity = recordObservation(COPY_MINT, { liquidityUsd: 100 });
    const assessment = assessBrandRisk({ mint: COPY_MINT, metadata: {}, launches: [], liquidity });
    recordAlert({ mint: COPY_MINT, assessment });

    assert.equal(listLaunches().length, 1);
    assert.equal(liquidity.dropPercent, 90);
    assert.equal(assessment.classification, 'Liquidity withdrawn');
    assert.equal(publicState().criticalAlertCount, 1);

    const secondFingerprint = buildBrandFingerprint({
      ...fingerprint,
      mint: COPY_MINT,
      symbol: 'XRAT2',
      launchWallet: Keypair.generate().publicKey.toBase58(),
      journalId: 'launch-xrat-2',
    });
    registerLaunch({ fingerprint: secondFingerprint, source: 'test' });
    const repeatedHolder = Keypair.generate().publicKey.toBase58();
    recordObservation(MINT, { liquidityUsd: 500, topHolders: [{ owner: repeatedHolder, amount: '10' }] });
    recordObservation(COPY_MINT, { liquidityUsd: 500, topHolders: [{ owner: repeatedHolder, amount: '20' }] });
    const watcherState = publicState();
    assert.equal(watcherState.watcherCandidateCount, 1);
    assert.equal(watcherState.watcherCandidates[0].owner, repeatedHolder);
    assert.equal(watcherState.watcherCandidates[0].launchCount, 2);
  } finally {
    if (originalConfigDir == null) delete process.env.TREBUCHET_CONFIG_DIR;
    else process.env.TREBUCHET_CONFIG_DIR = originalConfigDir;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
