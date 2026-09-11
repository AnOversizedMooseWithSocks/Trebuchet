// chainRetry.js
//
// Shared resilience primitives for the money-spending steps of a launch.
//
// Two concerns live here, deliberately kept tiny and dependency-free so they
// can be unit-tested without a chain or the Raydium SDK:
//
//   classifyChainError(err)  — decide whether a failed transaction is worth
//                              retrying. Three buckets:
//                                'transient'          — RPC hiccup, dropped
//                                                       blockhash, confirm
//                                                       timeout, rate limit.
//                                                       Retrying is the right
//                                                       move.
//                                'insufficient_funds' — the launch wallet ran
//                                                       short. Retrying can
//                                                       never help; the only
//                                                       fix is more SOL, so
//                                                       landTxWithRetry stops
//                                                       immediately rather than
//                                                       spending its retry budget.
//                                'deterministic'      — anything else that a
//                                                       blind retry won't fix
//                                                       (bad config, an already
//                                                       -initialized account,
//                                                       a program assertion).
//                                                       Stop and let the caller
//                                                       route to diagnosis.
//
//   landTxWithRetry({...})   — run a send-a-transaction closure with bounded
//                              retry, but ONLY for 'transient' failures, and
//                              with an idempotency guard so a transaction that
//                              actually landed (and then threw on a confirm
//                              timeout) is never re-sent. The guard matters
//                              most for non-idempotent operations like minting
//                              supply, where a blind re-send would double-mint.
//
// Why this exists: finishTokenCreation resumes a token whose mint exists but
// whose post-mint steps (metadata, supply, mint-authority renounce) did not all
// land. Each is a money- or state-changing transaction that a single transient
// blip could strand — worst case, a freshly-minted vanity token left half-built.
// landTxWithRetry gives those steps bounded retry plus an idempotency guard so a
// re-run never re-applies a step that already landed.

// Substring/regex signatures, matched case-insensitively against the error
// message (and a few common nested fields). Kept as data so the classifier
// stays readable and the test can assert each bucket directly.

// Unambiguous "the payer/owner did not have enough lamports" signals. We avoid
// matching a bare "0x1" custom-program code here: error 1 means different
// things in different programs, so keying off it would mislabel deterministic
// program errors as fundable. Only phrases that specifically denote a lamport
// shortfall qualify.
const INSUFFICIENT_FUNDS_SIGNS = [
  /insufficient\s+lamports/i,
  /insufficient\s+funds/i,
  /debit an account but found no record of a prior credit/i, // empty fee payer / source
  /insufficient\s+funds\s+for\s+rent/i,
  /Transfer:\s*insufficient\s+lamports/i,
  /custom program error:\s*0x1771/i, // SPL Token: insufficient funds (0x1=1? -> 0x1771 is the token-prog insufficient-funds code in practice)
];

// Things that are worth another attempt: the transaction didn't land (or we
// can't tell), and the cause is cluster/RPC weather rather than our request.
const TRANSIENT_SIGNS = [
  /blockhash not found/i,
  /block height exceeded/i,
  /TransactionExpiredBlockheightExceededError/i,
  /TransactionExpiredTimeoutError/i,
  /was not confirmed/i,
  /timed?\s*out/i,
  /timeout/i,
  /node is behind/i,
  /-32005/, // RPC: node is behind / long-term storage query
  /-32004/, // RPC: block not available yet
  /rate.?limit/i,
  /too many requests/i,
  /\b429\b/,
  /\b50[234]\b/, // 502/503/504 gateway
  /ECONNRESET/i,
  /ETIMEDOUT/i,
  /EAI_AGAIN/i,
  /socket hang ?up/i,
  /fetch failed/i,
  /network (request )?failed/i,
  /connection (closed|reset|refused)/i,
  /failed to (get|fetch|query)/i, // transient RPC read failures used by pre-checks
  /service unavailable/i,
];

// Pull a searchable string out of whatever was thrown. Solana/web3 errors put
// useful detail in .message, but RPC errors often bury it in .logs, a nested
// .cause, or an .error.message, so we fold those in too.
function errorText(err) {
  if (err == null) return '';
  if (typeof err === 'string') return err;
  const parts = [];
  if (err.message) parts.push(String(err.message));
  if (err.name) parts.push(String(err.name));
  if (err.code != null) parts.push(String(err.code));
  if (err.error && err.error.message) parts.push(String(err.error.message));
  if (err.cause) parts.push(errorText(err.cause));
  if (Array.isArray(err.logs)) parts.push(err.logs.join(' '));
  // transactionLogs / getLogs() shapes some SDK errors carry
  if (typeof err.getLogs === 'function') {
    try { const l = err.getLogs(); if (Array.isArray(l)) parts.push(l.join(' ')); } catch (_) { /* ignore */ }
  }
  return parts.join(' \n ');
}

// Classify a thrown transaction error into one of the three buckets above.
// Insufficient-funds is checked first: it is the most consequential to get
// right (it must never be retried), and its signatures are specific enough
// not to collide with the transient set.
export function classifyChainError(err) {
  const text = errorText(err);
  if (!text) return 'deterministic';
  for (const re of INSUFFICIENT_FUNDS_SIGNS) if (re.test(text)) return 'insufficient_funds';
  for (const re of TRANSIENT_SIGNS) if (re.test(text)) return 'transient';
  return 'deterministic';
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Run `send` with bounded retry, retrying ONLY transient failures.
//
// Options:
//   send        — async () => result. Sends and confirms the transaction.
//   alreadyDone — async () => boolean (optional). Idempotency guard, evaluated
//                 BEFORE each attempt. If it returns true, the work is already
//                 on-chain (a prior attempt landed) and we return { skipped:true }
//                 WITHOUT sending again. Implementations should be defensive:
//                 if the check itself can't run (e.g. a test's mock connection
//                 doesn't support the read), throw or return false so the
//                 attempt proceeds normally rather than silently skipping.
//   onRetry     — async (attempt, err) => void (optional). Side effects between
//                 attempts, e.g. refreshing the SDK's cached token accounts so
//                 the rebuilt transaction is clean.
//   retryIf     — optional, narrowly-scoped override for a caller that has
//                 independently proved a normally-deterministic error is a
//                 temporary state-propagation race. It must return true to
//                 allow the retry. The idempotency guard is still re-checked
//                 before every subsequent send.
//   label       — string for log lines.
//   maxAttempts — default 3.
//   settleMs    — pause between attempts (default 1500). Lets cluster state
//                 settle so a retry doesn't race the prior attempt.
//   sleep       — injectable timer (tests pass a no-op).
//
// Returns { value, skipped, attempts }:
//   value    — whatever `send` returned (null when skipped).
//   skipped  — true if alreadyDone short-circuited the send.
//   attempts — how many sends were issued.
//
// On a non-transient failure (insufficient_funds / deterministic), or after
// exhausting retries, the original error is rethrown with `err.kind` set to the
// classification, and the failing attempt is logged with its bucket so a
// stranded finish is easy to diagnose.
export async function landTxWithRetry({
  send,
  alreadyDone = null,
  onRetry = null,
  retryIf = null,
  label = 'tx',
  maxAttempts = 3,
  settleMs = 1500,
  sleep = defaultSleep,
}) {
  let lastErr = null;
  let attempts = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Idempotency guard. A defensive implementation returns false (or throws)
    // when it can't determine state, so we proceed rather than wrongly skip.
    if (alreadyDone) {
      let done = false;
      try { done = await alreadyDone(); }
      catch (_) { done = false; }
      if (done) return { value: null, skipped: true, attempts };
    }

    try {
      attempts += 1;
      const value = await send();
      return { value, skipped: false, attempts };
    } catch (err) {
      lastErr = err;
      let kind = classifyChainError(err);
      if (kind === 'deterministic' && retryIf) {
        let allowRetry = false;
        try { allowRetry = await retryIf(err, attempt); } catch (_) { allowRetry = false; }
        if (allowRetry) kind = 'transient';
      }
      console.warn(`    ${label}: attempt ${attempt}/${maxAttempts} failed (${kind}): ${err && err.message}`);

      if (kind !== 'transient') {
        // Funds shortfall or a deterministic error — retrying cannot help.
        // Tag and rethrow immediately so the caller surfaces the right state
        // instead of burning the remaining attempts on a lost cause.
        try { err.kind = kind; } catch (_) { /* frozen error — caller can re-classify */ }
        throw err;
      }

      if (onRetry) { try { await onRetry(attempt, err); } catch (_) { /* best-effort */ } }
      if (attempt >= maxAttempts) break;
      await sleep(settleMs);
    }
  }
  if (lastErr) { try { lastErr.kind = lastErr.kind || 'transient'; } catch (_) { /* ignore */ } }
  throw lastErr;
}
