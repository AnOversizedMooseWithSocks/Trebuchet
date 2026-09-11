import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LAUNCH_REPORT_APP_NAME,
  LAUNCH_REPORT_DATA_PROTOCOL,
  LAUNCH_REPORT_SCHEMA_VERSION,
  LAUNCH_REPORT_TYPE_JSON,
  LAUNCH_REPORT_TYPE_HTML,
  buildReportTags,
  buildReportEnvelope,
  publishLaunchReport,
} from '../launchReportService.js';

// A network-free umi double. uploader.upload() records every generic file it
// receives and returns a deterministic URI based on the artifact's
// Content-Type tag, so a test can tell the HTML and JSON uploads apart.
function makeUmi({ reject } = {}) {
  const uploads = [];
  return {
    uploads,
    uploader: {
      async upload(files) {
        if (reject) throw (reject instanceof Error ? reject : new Error(String(reject)));
        const file = files[0];
        uploads.push(file);
        const ct = file.tags.find((t) => t.name === 'Content-Type')?.value;
        return [ct === 'text/html' ? 'https://arweave.test/report-html' : 'https://arweave.test/report-json'];
      },
    },
  };
}

function tagMap(tags) {
  const m = {};
  for (const { name, value } of tags) {
    if (m[name] === undefined) m[name] = value;
  }
  return m;
}

test('buildReportTags: JSON variant carries the discovery tag set', () => {
  const tags = buildReportTags({
    kind: 'json',
    mint: 'MINT111',
    quoteMint: 'QUOTE222',
    poolIds: ['POOLA', 'POOLB'],
    appVersion: '1.2.3',
    unixTime: 1700000000,
  });
  const m = tagMap(tags);
  assert.equal(m['App-Name'], LAUNCH_REPORT_APP_NAME);
  assert.equal(m['Data-Protocol'], LAUNCH_REPORT_DATA_PROTOCOL);
  assert.equal(m['Schema-Version'], String(LAUNCH_REPORT_SCHEMA_VERSION));
  assert.equal(m['Type'], LAUNCH_REPORT_TYPE_JSON);
  assert.equal(m['Content-Type'], 'application/json');
  assert.equal(m['Mint'], 'MINT111');
  assert.equal(m['Quote-Mint'], 'QUOTE222');
  assert.equal(m['App-Version'], '1.2.3');
  assert.equal(m['Unix-Time'], '1700000000');
  const poolTags = tags.filter((t) => t.name === 'Pool-Id').map((t) => t.value);
  assert.deepEqual(poolTags, ['POOLA', 'POOLB']);
});

test('buildReportTags: HTML variant flips Type and Content-Type', () => {
  const m = tagMap(buildReportTags({ kind: 'html', mint: 'MINT111', poolIds: [] }));
  assert.equal(m['Type'], LAUNCH_REPORT_TYPE_HTML);
  assert.equal(m['Content-Type'], 'text/html');
});

test('buildReportTags: omits optional tags and requires a mint', () => {
  const m = tagMap(buildReportTags({ kind: 'json', mint: 'M', poolIds: [] }));
  assert.equal(m['Quote-Mint'], undefined);
  assert.equal(m['App-Version'], undefined);
  assert.throws(() => buildReportTags({ kind: 'json', mint: '' }), /requires a mint/);
});

test('buildReportTags: caps Pool-Id tags', () => {
  const many = Array.from({ length: 50 }, (_, i) => 'P' + i);
  const tags = buildReportTags({ kind: 'json', mint: 'M', poolIds: many });
  assert.equal(tags.filter((t) => t.name === 'Pool-Id').length, 24);
});

test('buildReportEnvelope: wraps launch data in a versioned envelope', () => {
  const launchData = {
    mint: 'M',
    pools: [{ id: 'P' }],
    destinationWallet: 'Dest111',
    transfer: { status: 'planned-before-sweep', destinationWallet: 'Dest111' },
    airdrop: { plannedRecipientCount: 1, transferred: [{ wallet: 'Wallet111', txId: 'Tx111' }] },
  };
  const env = buildReportEnvelope(launchData, {
    htmlUri: 'https://arweave.test/report-html',
    appVersion: '1.2.3',
    generatedAt: '2024-01-01T00:00:00.000Z',
  });
  assert.equal(env.schema, LAUNCH_REPORT_DATA_PROTOCOL);
  assert.equal(env.version, LAUNCH_REPORT_SCHEMA_VERSION);
  assert.deepEqual(env.app, { name: LAUNCH_REPORT_APP_NAME, version: '1.2.3' });
  assert.equal(env.generatedAt, '2024-01-01T00:00:00.000Z');
  assert.equal(env.htmlReportUri, 'https://arweave.test/report-html');
  assert.deepEqual(env.launch, launchData);
});

test('publishLaunchReport: opt-out short-circuits without touching the uploader', async () => {
  const progress = [];
  const umi = makeUmi();
  const result = await publishLaunchReport({
    enabled: false,
    umi,
    reportHtml: '<html></html>',
    launchData: { mint: 'M' },
    mint: 'M',
    onProgress: (e) => progress.push(e),
    logger: { log() {}, error() {} },
  });
  assert.deepEqual(result, { skipped: true, reason: 'opted-out' });
  assert.equal(umi.uploads.length, 0);
  assert.deepEqual(progress, [{ stage: 'report_skipped', reason: 'opted-out' }]);
});

test('publishLaunchReport: missing mint is a non-fatal skip', async () => {
  const umi = makeUmi();
  const result = await publishLaunchReport({
    enabled: true,
    umi,
    reportHtml: '<html></html>',
    launchData: {},
    mint: '',
    logger: { log() {}, error() {} },
  });
  assert.deepEqual(result, { skipped: true, reason: 'missing-mint' });
  assert.equal(umi.uploads.length, 0);
});

test('publishLaunchReport: publishes HTML then JSON with correct tags and body', async () => {
  const progress = [];
  const umi = makeUmi();
  const result = await publishLaunchReport({
    enabled: true,
    umi,
    reportHtml: '<!DOCTYPE html><html><body>report</body></html>',
    launchData: { mint: 'MINT111', pools: [{ id: 'POOLA' }] },
    mint: 'MINT111',
    quoteMint: 'QUOTE222',
    poolIds: ['POOLA', 'POOLB'],
    appVersion: '2.0.0',
    onProgress: (e) => progress.push(e),
    logger: { log() {}, error() {} },
  });

  assert.equal(result.skipped, false);
  assert.equal(result.failed, false);
  assert.equal(result.htmlUri, 'https://arweave.test/report-html');
  assert.equal(result.jsonUri, 'https://arweave.test/report-json');

  // Two artifacts uploaded, HTML first.
  assert.equal(umi.uploads.length, 2);
  const htmlTags = tagMap(umi.uploads[0].tags);
  const jsonTags = tagMap(umi.uploads[1].tags);
  assert.equal(htmlTags['Content-Type'], 'text/html');
  assert.equal(htmlTags['Type'], LAUNCH_REPORT_TYPE_HTML);
  assert.equal(jsonTags['Content-Type'], 'application/json');
  assert.equal(jsonTags['Type'], LAUNCH_REPORT_TYPE_JSON);
  assert.equal(jsonTags['Mint'], 'MINT111');

  // The two artifacts share one Unix-Time (correlated in queries).
  assert.equal(htmlTags['Unix-Time'], jsonTags['Unix-Time']);

  // The HTML bytes round-trip and the JSON envelope embeds the html URI.
  assert.equal(umi.uploads[0].buffer.toString('utf8'), '<!DOCTYPE html><html><body>report</body></html>');
  const envelope = JSON.parse(umi.uploads[1].buffer.toString('utf8'));
  assert.equal(envelope.schema, LAUNCH_REPORT_DATA_PROTOCOL);
  assert.equal(envelope.htmlReportUri, 'https://arweave.test/report-html');
  assert.deepEqual(envelope.launch, { mint: 'MINT111', pools: [{ id: 'POOLA' }] });
  assert.equal(typeof envelope.generatedAt, 'string');

  assert.deepEqual(progress, [
    { stage: 'report_html_published', htmlUri: 'https://arweave.test/report-html' },
    { stage: 'report_json_published', jsonUri: 'https://arweave.test/report-json', htmlUri: 'https://arweave.test/report-html' },
  ]);
});

test('publishLaunchReport: publishes JSON only when no HTML supplied', async () => {
  const umi = makeUmi();
  const result = await publishLaunchReport({
    enabled: true,
    umi,
    launchData: { mint: 'M' },
    mint: 'M',
    logger: { log() {}, error() {} },
  });
  assert.equal(result.htmlUri, null);
  assert.equal(result.jsonUri, 'https://arweave.test/report-json');
  assert.equal(umi.uploads.length, 1);
  assert.equal(tagMap(umi.uploads[0].tags)['Content-Type'], 'application/json');
});

test('publishLaunchReport: upload failure is non-fatal and does not throw', async () => {
  const progress = [];
  const umi = makeUmi({ reject: 'Irys unavailable' });
  const result = await publishLaunchReport({
    enabled: true,
    umi,
    reportHtml: '<html></html>',
    launchData: { mint: 'M' },
    mint: 'M',
    onProgress: (e) => progress.push(e),
    logger: { log() {}, error() {} },
  });
  assert.equal(result.skipped, false);
  assert.equal(result.failed, true);
  assert.equal(result.error, 'Irys unavailable');
  assert.deepEqual(progress, [{ stage: 'report_publish_failed', error: 'Irys unavailable' }]);
});
