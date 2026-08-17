// launchReportService.js
//
// Publishes a permanent, queryable launch report to Arweave (via Irys) after
// a launch completes. Two artifacts are written:
//
//   1. A machine-readable JSON envelope (Type: launch-report)
//   2. The rendered HTML report (Type: launch-report-html)
//
// Both are tagged so anyone holding the token mint can find them by querying
// Arweave/Irys GraphQL — WITHOUT anything being written onto the token's own
// metadata. The binding is report -> mint, not mint -> report, so a token
// carries no Trebuchet stamp; the report simply references the mint it
// describes. This keeps the door open for users (e.g. a corporate launch) who
// don't want their token associated with the launchpad: the whole step is
// opt-out (see userPrefs.publishLaunchReport).
//
// AUTHENTICITY: the report is uploaded by whatever identity the supplied `umi`
// carries. createLaunchReportUmi() binds that identity to the LAUNCH WALLET —
// the same key that minted the token and created the pools. That signature is
// what makes a report trustworthy: genuine reports are owned by the on-chain
// creator, so a verifier can ignore any report whose Arweave owner doesn't
// match the mint's creator. Because the launch wallet is swept and discarded
// after the launch, publishing MUST happen while it can still sign (before the
// final sweep), or be signed by the destination wallet instead — either way an
// on-chain-verifiable participant.
//
// FAILURE MODE: publishing is best-effort. The launch itself is already
// complete and safe (supply capped, liquidity locked, authorities renounced)
// before this runs, so a failed Arweave write returns a non-fatal result and
// never throws into the launch flow. The caller can offer a retry.
//
// Modelled on metadataUploadService.js — same Irys uploader, same injected-umi
// DI seam so it can be unit-tested with no network (see
// test/launch-report-service.test.mjs).

import { createGenericFile } from '@metaplex-foundation/umi';
import { createMetadataUmi, setMetadataUploaderIdentity } from './metadataUploadService.js';

// Tag/protocol constants. Exported so the verifier, the explorer, and the
// tests all share one source of truth for the tag convention.
export const LAUNCH_REPORT_APP_NAME = 'Trebuchet';
export const LAUNCH_REPORT_DATA_PROTOCOL = 'trebuchet-launch-report';
export const LAUNCH_REPORT_SCHEMA_VERSION = 1;
export const LAUNCH_REPORT_TYPE_JSON = 'launch-report';
export const LAUNCH_REPORT_TYPE_HTML = 'launch-report-html';

// ANS-104 data items can carry many tags, but there's a per-item size budget
// for the tag set. Cap the number of Pool-Id tags so a pathological multi-pool
// launch can't blow that budget; the full pool list still lives in the JSON
// body regardless of how many get their own queryable tag.
const MAX_POOL_ID_TAGS = 24;

// Build the Arweave/Irys tag array for one report artifact. `kind` selects the
// JSON vs HTML variant (Type + Content-Type). The Mint tag is the primary
// discovery key; Quote-Mint and Pool-Id are secondary filters. Unix-Time is
// passed in (not read here) so the JSON and HTML artifacts of one launch share
// an identical timestamp.
export function buildReportTags({ kind, mint, quoteMint, poolIds, appVersion, unixTime }) {
  if (typeof mint !== 'string' || !mint) {
    throw new Error('buildReportTags requires a mint string');
  }
  const isHtml = kind === 'html';
  const tags = [
    { name: 'App-Name', value: LAUNCH_REPORT_APP_NAME },
    { name: 'Data-Protocol', value: LAUNCH_REPORT_DATA_PROTOCOL },
    { name: 'Schema-Version', value: String(LAUNCH_REPORT_SCHEMA_VERSION) },
    { name: 'Type', value: isHtml ? LAUNCH_REPORT_TYPE_HTML : LAUNCH_REPORT_TYPE_JSON },
    { name: 'Content-Type', value: isHtml ? 'text/html' : 'application/json' },
    { name: 'Mint', value: mint },
  ];
  if (appVersion) tags.push({ name: 'App-Version', value: String(appVersion) });
  if (quoteMint) tags.push({ name: 'Quote-Mint', value: String(quoteMint) });
  if (Array.isArray(poolIds)) {
    for (const id of poolIds.slice(0, MAX_POOL_ID_TAGS)) {
      if (id) tags.push({ name: 'Pool-Id', value: String(id) });
    }
  }
  tags.push({
    name: 'Unix-Time',
    value: String(Number.isFinite(unixTime) ? unixTime : Math.floor(Date.now() / 1000)),
  });
  return tags;
}

// Wrap the caller's structured launch data in a versioned envelope. Keeping a
// stable, versioned outer shape (schema/version/app/generatedAt) means future
// readers can evolve the inner `launch` payload without breaking older
// verifiers. htmlUri links the machine-readable record to its rendered sibling.
export function buildReportEnvelope(launchData, { htmlUri = null, appVersion = null, generatedAt } = {}) {
  return {
    schema: LAUNCH_REPORT_DATA_PROTOCOL,
    version: LAUNCH_REPORT_SCHEMA_VERSION,
    app: { name: LAUNCH_REPORT_APP_NAME, version: appVersion ? String(appVersion) : null },
    generatedAt: typeof generatedAt === 'string' ? generatedAt : new Date().toISOString(),
    htmlReportUri: htmlUri || null,
    launch: launchData && typeof launchData === 'object' ? launchData : {},
  };
}

// Build a umi whose uploader identity IS the launch wallet, reusing the exact
// Irys configuration from metadataUploadService (same node, same timeout) so
// the report lands on the same Arweave network as the token metadata. Pass the
// launch wallet (the @solana/web3.js Keypair-shaped object with a secretKey)
// BEFORE it is swept. See the AUTHENTICITY note at the top of this file.
export function createLaunchReportUmi(launchWallet, options = {}) {
  return setMetadataUploaderIdentity(createMetadataUmi(options), launchWallet);
}

// Retry policy for the Irys uploads. Uploads are one-shot HTTP calls to a
// gateway; a transient failure (timeout, 5xx, connection reset) should not
// cost the user their permanent report when a second attempt lands fine.
// Duplicate-artifact note: if an attempt actually succeeded but the response
// was lost, the retry publishes a second identical artifact. That's benign —
// artifacts share the same Mint tag and signer, and any consumer picks the
// newest Unix-Time — and it's the right trade against losing the report.
const UPLOAD_RETRY_ATTEMPTS = 3;
const UPLOAD_RETRY_BASE_DELAY_MS = 2000;

// Overall wall-clock budget for the whole publish. The per-request Irys
// timeout (metadataUploadService.DEFAULT_IRYS_TIMEOUT_MS) bounds a single
// hung request, but retries multiply it; this caps the total so the step-6
// flow — which runs the SWEEP right after this — can never be stalled
// indefinitely by a misbehaving gateway. On expiry the publish reports
// failure (non-fatal, retryable later) and the launch proceeds.
const PUBLISH_DEADLINE_MS = 3 * 60 * 1000;

async function uploadWithRetry(umi, files, {
  label,
  attempts = UPLOAD_RETRY_ATTEMPTS,
  baseDelayMs = UPLOAD_RETRY_BASE_DELAY_MS,
  logger = console,
  onProgress,
} = {}) {
  let lastErr = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await umi.uploader.upload(files);
    } catch (err) {
      lastErr = err;
      logger.warn?.(
        `Launch report: ${label} upload attempt ${attempt}/${attempts} failed: ${err?.message || err}`,
      );
      onProgress?.({ stage: 'report_upload_retry', label, attempt, error: err?.message || String(err) });
      if (attempt < attempts) {
        // Simple doubling backoff (x1, x2, x4 of the base delay).
        await new Promise((r) => setTimeout(r, baseDelayMs * (2 ** (attempt - 1))));
      }
    }
  }
  throw lastErr;
}

// Publish the launch report. Returns one of:
//   { skipped: true,  reason }                       — opt-out or nothing to key on
//   { skipped: false, failed: true,  error }          — upload failed (non-fatal)
//   { skipped: false, failed: false, jsonUri, htmlUri } — published
//
// Never throws: a publish failure must not surface as a launch failure.
export async function publishLaunchReport(args) {
  const deadlineMs = Number.isFinite(args?.deadlineMs) ? args.deadlineMs : PUBLISH_DEADLINE_MS;
  let deadlineHandle = null;
  const deadline = new Promise((resolve) => {
    deadlineHandle = setTimeout(() => resolve({
      skipped: false,
      failed: true,
      error: `publish exceeded its ${Math.round(deadlineMs / 1000)}s deadline; `
        + 'the launch continues — the report can be retried afterwards',
      deadlineExceeded: true,
    }), deadlineMs);
    // Deliberately NOT unref'd: while an upload hangs, this timer is the
    // only thing guaranteed to keep the event loop alive long enough to
    // fire the deadline. The clearTimeout in the finally below stops it
    // from outliving a normal resolution.
  });
  try {
    return await Promise.race([publishLaunchReportInner(args), deadline]);
  } finally {
    clearTimeout(deadlineHandle);
  }
}

async function publishLaunchReportInner({
  enabled,
  umi,
  reportHtml,
  launchData,
  mint,
  quoteMint = null,
  poolIds = [],
  appVersion = null,
  onProgress,
  logger = console,
  uploadRetry = {},
}) {
  // Opt-out short-circuit. No umi is touched, no network call is made.
  if (!enabled) {
    onProgress?.({ stage: 'report_skipped', reason: 'opted-out' });
    return { skipped: true, reason: 'opted-out' };
  }

  // Without a mint there's nothing to key discovery off. Treat as a non-fatal
  // skip rather than throwing into an already-complete launch.
  if (typeof mint !== 'string' || !mint) {
    onProgress?.({ stage: 'report_skipped', reason: 'missing-mint' });
    return { skipped: true, reason: 'missing-mint' };
  }

  // One timestamp shared by both artifacts so they're correlated in queries.
  const unixTime = Math.floor(Date.now() / 1000);

  try {
    // 1) HTML first, so its URI can be embedded in the JSON envelope below.
    //    Skipped cleanly if the caller didn't supply rendered HTML.
    //
    //    Size guard: Irys sponsors uploads under ~100KB; anything larger
    //    needs a funded Irys balance the launch wallet doesn't have, so an
    //    oversized HTML upload would fail — and take the whole publish
    //    (including the small JSON envelope) down with it. Degrade
    //    gracefully instead: skip just the HTML and still publish the
    //    machine-readable JSON record. The frontend already keeps the HTML
    //    small (remote logo URI, capped airdrop tables), so this guard is
    //    a backstop, not the expected path.
    const HTML_UPLOAD_MAX_BYTES = 95 * 1024;
    let htmlUri = null;
    let htmlSkippedReason = null;
    if (typeof reportHtml === 'string' && reportHtml.length > 0
        && Buffer.byteLength(reportHtml, 'utf8') > HTML_UPLOAD_MAX_BYTES) {
      htmlSkippedReason = `report HTML is ${Buffer.byteLength(reportHtml, 'utf8')} bytes — over the ${HTML_UPLOAD_MAX_BYTES}-byte sponsored-upload cap; publishing the JSON record only`;
      logger.warn?.(`Launch report: ${htmlSkippedReason}`);
      onProgress?.({ stage: 'report_html_skipped_oversize', bytes: Buffer.byteLength(reportHtml, 'utf8') });
    } else if (typeof reportHtml === 'string' && reportHtml.length > 0) {
      const htmlFile = createGenericFile(
        Buffer.from(reportHtml, 'utf8'),
        'launch-report.html',
        { tags: buildReportTags({ kind: 'html', mint, quoteMint, poolIds, appVersion, unixTime }) },
      );
      [htmlUri] = await uploadWithRetry(umi, [htmlFile], {
        label: 'HTML', logger, onProgress, ...uploadRetry,
      });
      logger.log?.('Launch report (HTML) published:', htmlUri);
      onProgress?.({ stage: 'report_html_published', htmlUri });
    }

    // 2) JSON envelope (machine-readable; references the HTML sibling).
    const envelope = buildReportEnvelope(launchData, { htmlUri, appVersion });
    const jsonFile = createGenericFile(
      Buffer.from(JSON.stringify(envelope), 'utf8'),
      'launch-report.json',
      { tags: buildReportTags({ kind: 'json', mint, quoteMint, poolIds, appVersion, unixTime }) },
    );
    const [jsonUri] = await uploadWithRetry(umi, [jsonFile], {
      label: 'JSON', logger, onProgress, ...uploadRetry,
    });
    logger.log?.('Launch report (JSON) published:', jsonUri);
    onProgress?.({ stage: 'report_json_published', jsonUri, htmlUri });

    return { skipped: false, failed: false, jsonUri, htmlUri, htmlSkippedReason };
  } catch (err) {
    const error = err?.message || String(err);
    logger.error?.('Launch report publish failed:', err);
    onProgress?.({ stage: 'report_publish_failed', error });
    return { skipped: false, failed: true, error };
  }
}
