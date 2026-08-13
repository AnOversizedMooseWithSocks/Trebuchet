import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

let importCounter = 0;

function makeTempConfigDir(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'trebuchet-launch-journal-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function importFreshLaunchJournal(configDir) {
  process.env.TREBUCHET_CONFIG_DIR = configDir;
  return import(new URL(`../launchJournal.js?case=${++importCounter}`, import.meta.url));
}

function journalFile(configDir) {
  return path.join(configDir, 'launchJournals.json');
}

async function withMutedConsole(fn) {
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    return await fn();
  } finally {
    console.warn = originalWarn;
  }
}

test('starts a non-secret launch journal idempotently', async (t) => {
  const configDir = makeTempConfigDir(t);
  const launchJournal = await importFreshLaunchJournal(configDir);

  const first = launchJournal.start({ walletPublicKey: 'Wallet1111111111111111111111111111111111' });
  const second = launchJournal.start({ walletPublicKey: 'Wallet1111111111111111111111111111111111' });

  assert.equal(second.id, first.id);
  assert.equal(launchJournal.get(first.id).id, first.id);
  assert.equal(launchJournal.activeForWallet(first.walletPublicKey).id, first.id);
  assert.equal(first.status, 'active');
  assert.equal(first.stage, 'wallet_generated');

  const disk = JSON.parse(readFileSync(journalFile(configDir), 'utf8'));
  assert.equal(disk.length, 1);
  assert.equal(disk[0].walletPublicKey, 'Wallet1111111111111111111111111111111111');
  assert.equal(disk[0].events[0].stage, 'wallet_generated');
});

test('updates token, pool, and transfer state while filtering secrets', async (t) => {
  const configDir = makeTempConfigDir(t);
  const launchJournal = await importFreshLaunchJournal(configDir);
  const walletPublicKey = 'Wallet2222222222222222222222222222222222';

  launchJournal.start({ walletPublicKey });
  launchJournal.upsertForWallet(
    walletPublicKey,
    {
      stage: 'token_created',
      token: {
        mint: 'Mint222222222222222222222222222222222222',
        symbol: 'TBT',
        metadataUri: 'https://arweave.net/metadata',
        tempWalletSecretKey: [1, 2, 3],
      },
    },
    {
      stage: 'token_created',
      tokenMint: 'Mint222222222222222222222222222222222222',
      secretKey: [4, 5, 6],
    },
  );
  launchJournal.upsertForWallet(walletPublicKey, {
    stage: 'lp_created',
    poolPlan: {
      allocations: [{ quoteToken: 'SOL', supplyPercent: 100 }],
      tempWalletSecretKey: [7, 8, 9],
    },
    lp: {
      results: [
        {
          poolId: 'Pool222222222222222222222222222222222222',
          txIds: { createPool: 'tx-create' },
          mainPositions: [{ nftMint: 'Nft222', txIds: { open: 'tx-open' } }],
        },
      ],
    },
  });
  launchJournal.upsertForWallet(walletPublicKey, {
    status: 'completed',
    stage: 'transfer_completed',
    transfer: { destinationWallet: 'Dest222', solTransferred: 1.23 },
  });

  assert.equal(launchJournal.list().length, 0);
  assert.equal(launchJournal.activeForWallet(walletPublicKey), null);
  const completed = launchJournal.list({ includeCompleted: true });
  assert.equal(completed.length, 1);
  assert.equal(completed[0].token.mint, 'Mint222222222222222222222222222222222222');
  assert.equal(completed[0].lp.results[0].txIds.createPool, 'tx-create');
  assert.equal(completed[0].transfer.destinationWallet, 'Dest222');
  assert.equal(completed[0].completedAt, completed[0].updatedAt);
  const updatedCompleted = launchJournal.update(
    completed[0].id,
    { reportPublish: { mint: completed[0].token.mint, jsonUri: 'ar://report-json' } },
    { stage: 'report_published', mint: completed[0].token.mint },
  );
  assert.equal(updatedCompleted.reportPublish.jsonUri, 'ar://report-json');
  assert.equal(launchJournal.activeForWallet(walletPublicKey), null);
  const completedAfterUpdate = launchJournal.list({ includeCompleted: true });
  assert.equal(completedAfterUpdate.length, 1);
  assert.equal(completedAfterUpdate[0].reportPublish.jsonUri, 'ar://report-json');
  assert.equal(completedAfterUpdate[0].events.at(-1).stage, 'report_published');

  const rawText = readFileSync(journalFile(configDir), 'utf8');
  assert.equal(rawText.includes('tempWalletSecretKey'), false);
  assert.equal(rawText.includes('secretKey'), false);
  assert.equal(rawText.includes('[1,2,3]'), false);
});

test('persists the armed launch recipe as one replaceable recovery snapshot', async (t) => {
  const configDir = makeTempConfigDir(t);
  const launchJournal = await importFreshLaunchJournal(configDir);
  const walletPublicKey = 'WalletPlan22222222222222222222222222222222';

  launchJournal.start({ walletPublicKey });
  launchJournal.upsertForWallet(walletPublicKey, {
    stage: 'launch_plan_armed',
    launchConfig: {
      schema: 'trebuchet-v2-launch-config',
      source: 'trebuchet-v2',
      token: { name: 'First plan', symbol: 'ONE', supply: '1000' },
      poolTopology: {
        sweepDestination: 'DestinationOne',
        pools: [{ id: 'sol-main', quoteToken: 'SOL', supplyPercent: 100 }],
      },
      privateSigningKey: 'never-write-this',
    },
  });
  launchJournal.upsertForWallet(walletPublicKey, {
    launchConfig: {
      schema: 'trebuchet-v2-launch-config',
      source: 'trebuchet-v2',
      token: { name: 'Replacement plan', symbol: 'TWO', supply: '2000' },
      poolTopology: {
        sweepDestination: 'DestinationTwo',
        pools: [{ id: 'usdc-main', quoteToken: 'USDC', supplyPercent: 80 }],
      },
    },
  });

  const restored = launchJournal.activeForWallet(walletPublicKey);
  assert.equal(restored.launchConfig.token.name, 'Replacement plan');
  assert.equal(restored.launchConfig.poolTopology.sweepDestination, 'DestinationTwo');
  assert.equal(restored.launchConfig.poolTopology.pools.length, 1);
  assert.equal(restored.launchConfig.poolTopology.pools[0].id, 'usdc-main');
  assert.equal('privateSigningKey' in restored.launchConfig, false);
});

test('archives journals without deleting history', async (t) => {
  const configDir = makeTempConfigDir(t);
  const launchJournal = await importFreshLaunchJournal(configDir);

  const journal = launchJournal.start({ walletPublicKey: 'Wallet3333333333333333333333333333333333' });
  assert.equal(launchJournal.archive(journal.id), true);
  assert.equal(launchJournal.list().length, 0);

  const archived = launchJournal.list({ includeArchived: true });
  assert.equal(archived.length, 1);
  assert.equal(archived[0].status, 'archived');
  assert.equal(archived[0].events.at(-1).stage, 'journal_archived');
});

test('treats malformed journal files as empty and non-fatal', async (t) => {
  await withMutedConsole(async () => {
    const configDir = makeTempConfigDir(t);
    writeFileSync(journalFile(configDir), '{not json');

    const launchJournal = await importFreshLaunchJournal(configDir);

    assert.deepEqual(launchJournal.list(), []);
    assert.equal(existsSync(journalFile(configDir)), true);
  });
});
