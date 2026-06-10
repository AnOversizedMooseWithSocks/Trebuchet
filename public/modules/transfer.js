// ===========================================================================
// STEP 6: Transfer assets
// ===========================================================================

bind('transferAssetsBtn', 'click', () => {
  const dest = document.getElementById('destinationWallet').value.trim();
  if (!dest) {
    log('Destination wallet required', 'warning');
    return;
  }
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(dest)) {
    log("Destination address doesn't look like a valid Solana address", 'danger');
    return;
  }
  showTransferConfirmModal(dest);
});

function showTransferConfirmModal(dest) {
  const modal = document.getElementById('transferConfirmModal');
  const chunked = dest.match(/.{1,8}/g).join(' ');
  document.getElementById('transferConfirmAddress').textContent = chunked;

  const confirmCheckbox = document.getElementById('transferConfirmCheckbox');
  const confirmBtn = document.getElementById('transferConfirmBtn');
  confirmCheckbox.checked = false;
  confirmBtn.disabled = true;

  modal.classList.add('is-active');
}

bind('transferConfirmCheckbox', 'change', (e) => {
  document.getElementById('transferConfirmBtn').disabled = !e.target.checked;
});

bind('transferConfirmCancelBtn', 'click', () => {
  document.getElementById('transferConfirmModal').classList.remove('is-active');
});

bind('transferConfirmBtn', 'click', async () => {
  document.getElementById('transferConfirmModal').classList.remove('is-active');
  await runTransfer();
});

// ===========================================================================
// Live airdrop progress polling
// ---------------------------------------------------------------------------
// When /api/transfer-assets is in flight with an airdrop payload (or when
// /api/retry-airdrop is running), the server populates an in-memory progress
// tracker as it processes each recipient. These helpers poll /api/airdrop-
// progress every 500ms during the transfer so the user sees a live "X / N
// recipients" panel ticking forward — without this, the user stares at an
// unmoving button for 20-30 seconds with no feedback that anything is
// happening.
//
// Both real and demo modes write to the same tracker (server.js owns it),
// so this UI works identically across modes.
// ===========================================================================

let _airdropProgressPollHandle = null;

function fmtTokensShort(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  return v.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

function updateAirdropProgressUi(state, expectedTotal) {
  const panel = document.getElementById('airdropProgressPanel');
  if (!panel) return;
  panel.classList.remove('hidden');
  // total comes from the server's tracker; fall back to expectedTotal
  // (what the frontend KNOWS we sent) until the server's first write
  // lands. Avoids a "0 / 0" flash on the very first poll.
  const total = (state && Number.isFinite(state.total) && state.total > 0)
    ? state.total
    : (expectedTotal || 0);
  const done = state ? (state.completed + state.failedCount) : 0;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const tokens = state ? state.totalTokens : 0;
  const lastWallet = state && state.lastWallet ? state.lastWallet : null;
  const lastTokens = state && state.lastTokens != null ? state.lastTokens : null;

  const countEl = document.getElementById('airdropProgressCount');
  if (countEl) countEl.textContent = `${done} / ${total}`;
  const pctEl = document.getElementById('airdropProgressPct');
  if (pctEl) pctEl.textContent = total > 0 ? `(${pct}%)` : '';
  const bar = document.getElementById('airdropProgressBar');
  if (bar) bar.value = pct;
  const tokensEl = document.getElementById('airdropProgressTokens');
  if (tokensEl) tokensEl.textContent = fmtTokensShort(tokens);
  const lastEl = document.getElementById('airdropProgressLast');
  if (lastEl) {
    if (lastWallet) {
      // Full address (no truncation) — there's a full-width row for
      // this and showing the entire wallet is more verifiable than a
      // shortened form that can collide between similar-prefix wallets.
      lastEl.style.wordBreak = 'break-all';
      lastEl.textContent = `Last delivered: ${lastWallet}`
        + (lastTokens != null ? ` (${fmtTokensShort(lastTokens)} tokens)` : '');
    } else {
      lastEl.style.wordBreak = '';
      lastEl.textContent = 'Starting…';
    }
  }
}

// Start the polling loop for a given launch-wallet pubkey. expectedTotal
// is the recipient count the frontend already knows from the airdrop
// payload; passing it lets us show a coherent "0 / N" initial state
// before the server's first progress write lands.
function startAirdropProgressPoll(walletPublicKey, expectedTotal) {
  stopAirdropProgressPoll(); // defensive — never double-poll
  // Render an initial frame so the panel doesn't feel laggy at start.
  updateAirdropProgressUi(null, expectedTotal);
  let cancelled = false;
  const tick = async () => {
    if (cancelled) return;
    try {
      const resp = await fetch(
        `/api/airdrop-progress?wallet=${encodeURIComponent(walletPublicKey)}`,
      );
      if (resp.ok) {
        const data = await resp.json();
        if (cancelled) return;
        if (data && data.state) {
          updateAirdropProgressUi(data.state, expectedTotal);
          // Server-side self-stop: status='done' means the airdrop is
          // finished. The runTransfer success path also calls stop on
          // its way out, so this is just belt-and-suspenders.
          if (data.state.status === 'done') {
            // One more tick so the user sees the final 100% state for
            // a moment before the result panel takes over.
            return;
          }
        }
      }
    } catch (_) {
      // Transient network blip — try again on next interval.
    }
    if (!cancelled) {
      _airdropProgressPollHandle = setTimeout(tick, 500);
    }
  };
  // Use setTimeout chain rather than setInterval so a slow response can't
  // cause overlapping in-flight requests.
  _airdropProgressPollHandle = setTimeout(tick, 500);
  return () => { cancelled = true; stopAirdropProgressPoll(); };
}

function stopAirdropProgressPoll() {
  if (_airdropProgressPollHandle) {
    clearTimeout(_airdropProgressPollHandle);
    _airdropProgressPollHandle = null;
  }
}

function hideAirdropProgressPanel() {
  const panel = document.getElementById('airdropProgressPanel');
  if (panel) panel.classList.add('hidden');
}

// ===========================================================================
// Live LP progress polling
// ---------------------------------------------------------------------------
// During /api/create-lp the server (currently only in demo mode) writes an
// event log of per-step completions: pool_create_done, main_open_done,
// ladder_open_done, support_open_done, bootstrap_open_done, *_lock_done,
// transfer_done. Each event includes allocationIndex + sliceIndex /
// bandIndex where relevant.
//
// This polls /api/lp-progress with a `since` cursor every 500ms and
// translates each new event into a row marking. Without it, every row in
// the phase progress tree stays pending until the single create-lp
// response lands — which is fine for a 30-second real launch but feels
// frozen during a 60-second demo with many rows.
// ===========================================================================

let _lpProgressPollHandle = null;
let _lpProgressSeenCount = 0;

// Map a single progress event to its corresponding row in the phase
// progress tree, plus a 'kind' field indicating done vs failed. Returns
// null when no row matches (e.g. a stage we don't render rows for —
// phase1_pool_done, phase3_start, etc., which are bookkeeping events
// that exist only for the journal).
//
// Selector strings must match the data-stage attribute scheme used in
// buildPhaseProgressTree. Failed events use the same data-stage as
// their _done counterparts — they're different "kinds" of the same
// underlying row, not separate rows.
function _lpEventToRow(event) {
  if (!event || event.allocationIndex == null) return null;
  const idx = event.allocationIndex;
  let stage = null;
  let kind = 'done';
  switch (event.stage) {
    // Success events.
    case 'pool_create_done':       stage = 'pool'; break;
    case 'main_open_done':         stage = `slice-${event.sliceIndex}`; break;
    case 'ladder_open_done':       stage = `ladder-${event.bandIndex}`; break;
    case 'support_open_done':      stage = 'support-open'; break;
    case 'bootstrap_open_done':    stage = 'bs-open'; break;
    case 'main_lock_done':         stage = `lock-${event.sliceIndex}`; break;
    case 'ladder_lock_done':       stage = `ladder-lock-${event.bandIndex}`; break;
    case 'support_lock_done':      stage = 'support-lock'; break;
    case 'bootstrap_lock_done':    stage = 'bs-lock'; break;
    case 'main_transfer_done':     stage = `xfer-${event.sliceIndex}`; break;
    // Failure events. Same row, different kind.
    case 'main_lock_failed':       stage = `lock-${event.sliceIndex}`; kind = 'failed'; break;
    case 'ladder_lock_failed':     stage = `ladder-lock-${event.bandIndex}`; kind = 'failed'; break;
    case 'support_lock_failed':    stage = 'support-lock'; kind = 'failed'; break;
    case 'bootstrap_lock_failed':  stage = 'bs-lock'; kind = 'failed'; break;
    case 'bootstrap_failed':       stage = 'bs-open'; kind = 'failed'; break;
    case 'main_transfer_failed':   stage = `xfer-${event.sliceIndex}`; kind = 'failed'; break;
    default:                       return null;
  }
  const row = document.querySelector(
    `#lpProgressTree [data-pool-idx="${idx}"][data-stage="${stage}"]`,
  );
  if (!row) return null;
  return { row, kind, error: event.error };
}

// Start the poll for a given launch wallet. Resets the seen-count so a
// fresh poll session starts from event 0. Self-stops on status='done'
// or when the parent fetch tears it down.
function startLpProgressPoll(walletPublicKey) {
  stopLpProgressPoll();
  _lpProgressSeenCount = 0;
  let cancelled = false;
  const tick = async () => {
    if (cancelled) return;
    try {
      const resp = await fetch(
        `/api/lp-progress?wallet=${encodeURIComponent(walletPublicKey)}`
        + `&since=${_lpProgressSeenCount}`,
      );
      if (resp.ok) {
        const data = await resp.json();
        if (cancelled) return;
        if (data && data.state && Array.isArray(data.state.events)) {
          // Walk new events in order, marking each row done or failed
          // based on the event kind returned by the translator.
          for (const ev of data.state.events) {
            const mapped = _lpEventToRow(ev);
            if (!mapped) continue;
            if (mapped.kind === 'failed') {
              markRowFailed(mapped.row, mapped.error);
            } else {
              markRowDone(mapped.row);
            }
          }
          _lpProgressSeenCount = data.state.totalEvents || _lpProgressSeenCount;
          // Server marks the run done shortly after handleCreateLp
          // returns; stop polling early so we don't keep hitting the
          // endpoint after the tracker has frozen.
          if (data.state.status === 'done') return;
        }
      }
    } catch (_) {
      // Transient blip — retry on next interval.
    }
    if (!cancelled) {
      _lpProgressPollHandle = setTimeout(tick, 500);
    }
  };
  _lpProgressPollHandle = setTimeout(tick, 500);
  return () => { cancelled = true; stopLpProgressPoll(); };
}

function stopLpProgressPoll() {
  if (_lpProgressPollHandle) {
    clearTimeout(_lpProgressPollHandle);
    _lpProgressPollHandle = null;
  }
}

// Render the per-token sweep breakdown into #tokenSweepBreakdown. Reads
// from data.tokenSweep.transferred which is an array of
// { mint, amount, decimals, txId }. The launched-token row is labeled
// "preallocation leftover" so the user can see the held-back-from-LP
// portion (the "Launch wallet (unallocated)" slice from the tokenomics
// chart) actually moved to the destination wallet. Other tokens get
// labeled by mint only — typically these are quote-token leftovers from
// auto-swap or bootstrap residue.
function renderTokenSweepBreakdown(tokenSweep) {
  const container = document.getElementById('tokenSweepBreakdown');
  if (!container) return;
  const transferred = (tokenSweep && Array.isArray(tokenSweep.transferred))
    ? tokenSweep.transferred
    : [];
  if (transferred.length === 0) {
    container.innerHTML = '';
    return;
  }
  const launchedMint = createdTokenInfo && createdTokenInfo.mint
    ? String(createdTokenInfo.mint)
    : null;
  const launchedSymbol = createdTokenInfo && createdTokenInfo.symbol
    ? String(createdTokenInfo.symbol)
    : 'launched token';
  const fmt = (v) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return '—';
    return n.toLocaleString(undefined, { maximumFractionDigits: 6 });
  };
  const rows = transferred.map((t) => {
    const mint = String(t.mint || '');
    const isLaunched = launchedMint && mint === launchedMint;
    const label = isLaunched
      ? `${escapeHtml(launchedSymbol)} (preallocation leftover)`
      : (mint
        ? `<code style="font-size: 11px;">${escapeHtml(mint.slice(0, 6) + '…' + mint.slice(-4))}</code>`
        : 'token');
    const amount = fmt(t.amount);
    return `<div style="margin: 0.1rem 0;">
      <span class="has-text-grey">→</span>
      ${label}
      <span class="has-text-grey"> · </span>
      <strong>${amount}</strong>
    </div>`;
  }).join('');
  container.innerHTML = rows;
}

// Log an airdrop outcome: success summary first (so the user sees what
// worked), then per-recipient failures with their reason. Capped at 5
// failures in the log to avoid spam — the result panel shows the full list.
function logAirdropOutcome(result) {
  if (!result) return;
  const delivered = (result.transferred || []).length;
  if (delivered > 0) {
    log(`Airdrop delivered to ${delivered} recipient${delivered === 1 ? '' : 's'}`, 'success');
  }
  const failed = result.failed || [];
  const failedToShow = failed.slice(0, 5);
  for (const f of failedToShow) {
    const wShort = f.wallet ? `${f.wallet.slice(0, 4)}…${f.wallet.slice(-4)}` : 'unknown';
    log(`Airdrop failed (${wShort}): ${f.error}`, 'warning');
  }
  if (failed.length > failedToShow.length) {
    log(`…and ${failed.length - failedToShow.length} more airdrop failure${failed.length - failedToShow.length === 1 ? '' : 's'}. See the panel above for details.`, 'warning');
  }
}

async function runTransfer() {
  const btn = document.getElementById('transferAssetsBtn');
  const dest = document.getElementById('destinationWallet').value.trim();
  await withRunState(async () => {
    setLoading(btn, true);
    try {
      log(`Transferring assets to ${dest}...`);
      // Build the airdrop payload (when applicable). buildAirdropTransferPayload
      // returns null when no airdrop is configured / customize mode / no parsed
      // rows etc.; in that case the server short-circuits the airdrop step.
      const airdropPayload = buildAirdropTransferPayload();
      if (airdropPayload) {
        // Conservative estimate: ~4 seconds per recipient (350ms pace +
        // 2-3s tx confirmation + occasional retry). Real-world is usually
        // faster but a high estimate sets expectations and avoids the
        // "is it frozen?" panic during long runs.
        const n = airdropPayload.recipients.length;
        const estSeconds = Math.ceil(n * 4);
        const estDuration = estSeconds < 60
          ? `~${estSeconds}s`
          : `~${Math.ceil(estSeconds / 60)} min`;
        log(
          `Airdrop included: ${n} recipient${n === 1 ? '' : 's'} of the launched `
          + `token will receive their share before the remaining tokens sweep `
          + `to your destination. This may take ${estDuration} — please don't `
          + `close the app until it completes.`,
        );
      }
      // ---- Step 6a: airdrop (when configured) --------------------------
      // Runs as its own server call BEFORE the report publish and the
      // sweep. The airdrop is the last on-chain token-setup work, so once
      // it lands the permanent launch report can be written with the real
      // delivery results instead of a forever-"pending" section.
      // /api/run-airdrop is per-recipient idempotent (it skips wallets the
      // server's journal already records as delivered), so a transfer
      // re-run after a partial failure can never double-pay.
      if (airdropPayload) {
        // Kick off the live progress poll BEFORE the fetch so the user
        // sees the "0 / N" initial frame the moment the request goes out.
        startAirdropProgressPoll(
          tempWallet.publicKey,
          airdropPayload.recipients.length,
        );
        try {
          let aResp;
          try {
            aResp = await fetch('/api/run-airdrop', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                walletPublicKey: tempWallet.publicKey,
                ...(demoModeActive ? { tempWalletSecretKey: tempWallet.secretKey } : {}),
                tokenMint: airdropPayload.tokenMint,
                tokenDecimals: airdropPayload.tokenDecimals,
                isToken2022: !!airdropPayload.isToken2022,
                recipients: airdropPayload.recipients,
              }),
            });
          } finally {
            stopAirdropProgressPoll();
            hideAirdropProgressPanel();
          }
          const aData = await aResp.json();
          if (aResp.status === 409) {
            // Another airdrop is already in flight for this wallet —
            // don't sweep out from under it. Not a failure: wait, retry.
            log(aData.error || 'Another airdrop is already running for this wallet.', 'warning');
            return;
          }
          if (!aData.success) {
            throw new Error(aData.error || `Airdrop failed with HTTP ${aResp.status}`);
          }
          // The server returns its merged journal record (prior delivered +
          // this run) — replace wholesale.
          lastAirdropResult = {
            transferred: aData.airdrop?.transferred || [],
            failed: aData.airdrop?.failed || [],
          };
        } catch (e) {
          // The airdrop endpoint failed outright (network blip, server
          // error before per-recipient handling). Mirror the server's
          // crash shape — every recipient marked failed — and continue
          // with the publish + sweep: the un-airdropped tokens still
          // reach the destination wallet, and the journal dedup means a
          // later retry can't double-pay anyone whose tx did land.
          log(`Airdrop step failed: ${e.message} — continuing with the sweep. Use the retry button afterwards.`, 'warning');
          lastAirdropResult = {
            transferred: [],
            failed: airdropPayload.recipients.map((r) => ({
              wallet: r.wallet,
              tokens: r.tokens,
              amountRaw: null,
              error: `Airdrop step failed: ${e.message}`,
            })),
          };
        }
        renderAirdropTransferResult(lastAirdropResult);
        hideAirdropPreTransferSummary();
        logAirdropOutcome(lastAirdropResult);
      }

      // ---- Step 6b: publish the permanent launch report ----------------
      // Every on-chain token-setup transaction has landed (pools, locks,
      // transfers, airdrop). Publish to Arweave NOW, before the sweep —
      // the report carries the airdrop outcome, and the only on-chain
      // work left afterwards is the sweep itself. Awaited because the
      // ordering is the point; a publish failure is logged inside and
      // never blocks the sweep (the success-modal card offers a retry,
      // and the launch wallet's key remains available server-side).
      _resetCachedReport();
      if (typeof _publishedReport === 'undefined' || !_publishedReport
          || (_publishedReport.status !== 'done' && _publishedReport.status !== 'skipped')) {
        if (typeof isLaunchReportEnabled !== 'function' || isLaunchReportEnabled()) {
          log('Publishing the permanent launch report to Arweave…');
        }
      }
      await publishLaunchReportToArweave();

      // ---- Step 6c: sweep everything to the destination ----------------
      const resp = await fetch('/api/transfer-assets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          walletPublicKey: tempWallet.publicKey,
          // F5: the server resolves the secret from its encrypted store using
          // the public key for real launches; only demo mode (in-memory
          // ledger, no server-side secret) still sends the key inline.
          ...(demoModeActive ? { tempWalletSecretKey: tempWallet.secretKey } : {}),
          destinationWallet: dest,
          tokenMint: createdTokenInfo ? createdTokenInfo.mint : '',
          // No airdrop payload: it already ran in step 6a. The server
          // keeps its in-process airdrop branch as a safety net for old
          // clients, but this client never exercises it.
        }),
      });
      const data = await resp.json();
      if (resp.status === 409 && data.code === 'OP_IN_FLIGHT') {
        // Another launch operation is still running for this wallet —
        // e.g. pool creation that survived a UI reload, or a previous
        // transfer click. Sweeping now would pull assets out from under
        // it, so the server refused. Not a failure: wait and retry.
        log(data.error, 'warning');
        return;
      }
      if (!data.success) throw new Error(data.error);

      document.getElementById('transferResult').classList.remove('hidden');
      document.getElementById('tokensTransferred').textContent = data.tokensTransferred ?? '—';
      document.getElementById('solTransferred').textContent = data.solTransferred ?? '—';
      document.getElementById('nftsTransferred').textContent =
        data.nftSweep?.transferred?.length ?? '0';
      // Per-token breakdown of the sweep, so the user can see how much
      // of each token actually went to the destination wallet — and
      // specifically that the launched-token preallocation leftover
      // moved (the answer to "did my held-back supply get swept?").
      renderTokenSweepBreakdown(data.tokenSweep);

      // The airdrop already ran in step 6a and lastAirdropResult holds the
      // merged record. data.airdrop is null in the new flow (no payload
      // sent with the sweep); only overwrite if the server's in-process
      // safety-net branch somehow ran (old-client compatibility).
      if (data.airdrop) {
        lastAirdropResult = data.airdrop;
        renderAirdropTransferResult(lastAirdropResult);
      }
      // Pre-transfer summary is no longer relevant — the airdrop has
      // either run (result panel above takes over) or was bypassed.
      hideAirdropPreTransferSummary();

      // Step 6b already rebuilt the cached report (with the airdrop
      // section) for the Arweave publish; this render just shows it in
      // the step-6 preview container.
      renderLaunchReportPreview('step6');

      // Detect partial-failure modes. The server's transfer endpoint can
      // succeed at the top level (tokens + NFTs moved) but still have
      // individual sub-steps fail. Without surfacing these the user thinks
      // the transfer completed cleanly and may not realize funds were
      // left behind in the ephemeral wallet:
      //
      //   solSweepError       — SOL sweep failed; tokens/NFTs succeeded.
      //                         Most common cause: ephemeral wallet didn't
      //                         have enough SOL left for the tx fee after
      //                         the earlier transfers ate into it.
      //   tokenSweep.errors[] — per-token transfer failures (e.g. an ATA
      //                         creation that ran out of lamports).
      //   nftSweep.errors[]   — per-NFT failures (e.g. a locked LP NFT
      //                         that the lock contract rejected releasing).
      //   airdrop.failed[]    — per-recipient airdrop failures (invalid
      //                         address, RPC blip mid-distribution, etc.).
      //                         Distinct from the other failure modes:
      //                         the un-airdropped tokens still got swept
      //                         to the destination wallet, so the funds
      //                         aren't stranded — but the recipients
      //                         didn't get their share, and the user may
      //                         want to retry (using the destination wallet
      //                         now that the tokens have moved there).
      //
      // Each gets a warning log line so the user can investigate. The
      // wallet's pending-recovery entry is also preserved server-side
      // when the post-sweep balance check finds anything left, so the
      // user can come back later with the secret key and try again.
      const tokenErrors = data.tokenSweep?.errors || [];
      const nftErrors = data.nftSweep?.errors || [];
      // From step 6a's run (or the journal-restored record on a resumed
      // session) — the sweep response no longer carries the airdrop.
      const airdropFailed = lastAirdropResult?.failed || [];
      const hasPartialFailure =
        data.solSweepError
        || tokenErrors.length > 0
        || nftErrors.length > 0
        || airdropFailed.length > 0;

      if (data.solSweepError) {
        log(`SOL sweep failed: ${data.solSweepError}`, 'warning');
        log(
          'Tokens and NFTs were transferred successfully, but SOL stayed in the ' +
          'ephemeral wallet. Use the pending-wallets panel above to recover the ' +
          'remaining SOL with the wallet\'s secret key.',
          'warning',
        );
      }
      for (const e of tokenErrors) {
        log(`Token sweep error (${e.mint?.slice(0, 8) || 'unknown'}…): ${e.error}`, 'warning');
      }
      for (const e of nftErrors) {
        log(`NFT sweep error (${e.mint?.slice(0, 8) || 'unknown'}…): ${e.error}`, 'warning');
      }

      // Hide the Transfer button — flow is complete. Re-clicking would attempt
      // to transfer from an empty wallet, which would error confusingly.
      // EXCEPTION: when there was a partial failure (some assets stuck), leave
      // the button visible so the user can retry. The server-side post-sweep
      // verification keeps the recovery cache entry alive in this case, so a
      // retry won't lose the wallet's secret key.
      if (!hasPartialFailure) {
        document.getElementById('transferAssetsBtn').classList.add('hidden');
        log('Transfer complete', 'success');
        setStepSummary(6, 'transferred');

        // Reveal the "View launch summary" button next to the report
        // download. The launch-success modal is about to auto-open, but
        // if the user dismisses it accidentally this button gets them
        // back to the listing / verification / community links. Markup
        // for it starts with .hidden and we only drop the class here,
        // on the fully-clean path that also auto-opens the modal — the
        // two stay in lock-step.
        document.getElementById('viewLaunchSummaryBtn')?.classList.remove('hidden');

        // Auto-open the launch-success modal. Async (reads the logo
        // as a data URL inside) but we don't need to await it — the
        // rest of this success branch is independent. Catch on the
        // promise so a coin-init failure doesn't surface as an
        // unhandled rejection; showLaunchSuccessModal already logs
        // its own warnings on internal failures.
        try {
          markLaunchActiveForRpcHealth(false);
          Promise.resolve(showLaunchSuccessModal()).catch((err) => {
            console.warn('showLaunchSuccessModal rejected:', err);
          });
        } catch (err) {
          console.warn('showLaunchSuccessModal threw synchronously:', err);
        }
      } else {
        log('Transfer partially complete — see warnings above', 'warning');
        setStepSummary(6, 'partial — see warnings');
      }

      // The transfer (final sweep) has run — mark the overall launch
      // progress complete so the preview card's bar reaches 100%. Applies to
      // both the clean and partial paths: the sweep to the destination
      // completed in both; partial only means some Fee Key NFTs need manual
      // forwarding, which is surfaced separately in the warnings above.
      _launchTransferComplete = true;
      if (typeof updateLaunchProgress === 'function') updateLaunchProgress();
      // The server has already removed this wallet from the recovery
      // cache (provided the on-chain balance check confirmed it's empty).
      // Refresh the panel so it reflects the new state.
      loadLaunchJournals();
      loadPendingWallets();
    } catch (e) {
      log(`Transfer failed: ${e.message}`, 'danger');
    } finally {
      setLoading(btn, false);
    }
  });
}

// Render the airdrop result block inside Step 6 — populates the
// #airdropTransferResult container with a per-recipient summary and a
// retry button when there are failures. Called from runTransfer after
// the transfer-assets response lands, and again after a retry to
// update the displayed counts.
//
// Hides the block entirely when no airdrop ran (no panel to show).
// Shows it with a green "all delivered" notice when delivery was 100%
// successful, or with a warning notice listing the failed recipients
// and a Retry button when there were partial failures.
function renderAirdropTransferResult(airdrop) {
  const container = document.getElementById('airdropTransferResult');
  if (!container) return;
  if (!airdrop) {
    container.classList.add('hidden');
    container.innerHTML = '';
    return;
  }
  const delivered = (airdrop.transferred || []).length;
  const failed = (airdrop.failed || []).length;
  if (delivered === 0 && failed === 0) {
    container.classList.add('hidden');
    container.innerHTML = '';
    return;
  }
  container.classList.remove('hidden');

  // Build the failure rows — short wallet, error message. Wrapped in a
  // small inset container so the warning notice doesn't sprawl when
  // there are lots of failures.
  let failureRowsHtml = '';
  if (failed > 0) {
    failureRowsHtml = (airdrop.failed || []).map((f) => {
      const wAddr = f.wallet ? escapeHtml(String(f.wallet)) : 'unknown';
      const tokensTxt = Number.isFinite(Number(f.tokens))
        ? Number(f.tokens).toLocaleString(undefined, { maximumFractionDigits: 4 })
        : '—';
      // When a tx signature is present on a failure, it means we sent
      // the tx but couldn't confirm it landed (confirmation timeout
      // with a negative balance check). Surface a Solscan link so the
      // user can inspect the chain — the tx may still land later, and
      // if it did, they can decide not to retry that recipient. The
      // attempts count is a useful diagnostic for transient-vs-permanent
      // errors so we show it inline.
      const sigLinkHtml = f.signature
        ? ` &nbsp;<a href="https://solscan.io/tx/${encodeURIComponent(f.signature)}" target="_blank" rel="noopener" style="color: #5a3e1a; font-weight: 600;" title="View transaction on Solscan to verify whether it landed">verify ↗</a>`
        : '';
      const attemptsHtml = Number.isFinite(Number(f.attempts)) && Number(f.attempts) > 1
        ? ` <span class="has-text-grey is-size-7">(${f.attempts} attempts)</span>`
        : '';
      // Full wallet address — users investigating a failure need to be
      // able to copy it, look it up on Solscan, or contact the
      // recipient. word-break lets the row reflow gracefully on
      // narrow viewports rather than pushing horizontally.
      return `<div class="is-size-7" style="margin: 0.2rem 0; word-break: break-all;">
        <code style="font-size: 11px;">${wAddr}</code>
        &nbsp;·&nbsp; ${tokensTxt} tokens
        &nbsp;·&nbsp; <span style="color: #b8821a;">${escapeHtml(f.error || 'unknown error')}</span>${attemptsHtml}${sigLinkHtml}
      </div>`;
    }).join('');
  }

  if (failed === 0) {
    // All-delivered path. Green notice with the delivered count.
    container.innerHTML = `
      <div class="notification is-success is-light is-size-7 py-2 px-3">
        <p>
          <strong>Airdrop delivered</strong> to ${delivered} recipient${delivered === 1 ? '' : 's'}.
          The launched token was sent to each address before the remaining
          balance swept to your destination wallet.
        </p>
      </div>
    `;
  } else {
    // Mixed-result path. Yellow notice with delivered + failed counts,
    // failure list, retry button. The retry button targets only the
    // failed recipients; the user can click it repeatedly until they
    // either get all deliveries through or give up.
    container.innerHTML = `
      <div class="notification is-warning is-light is-size-7 py-2 px-3">
        <p class="mb-2">
          <strong>Airdrop partial:</strong>
          ${delivered} delivered, ${failed} failed.
        </p>
        <p class="mb-2" style="color: #6a4f2a;">
          <strong>Important:</strong> The launched tokens have now swept to your
          destination wallet, so a retry from the ephemeral wallet won't have
          the supply to send. Retry only works if the ephemeral wallet still
          has tokens — typically this means clicking <strong>Retry failed</strong>
          before the wallet finishes emptying, or distributing manually from
          your destination wallet using the recipient list below.
        </p>
        <details class="mt-2 mb-2">
          <summary style="cursor: pointer; user-select: none;"><strong>Failed recipients (${failed})</strong></summary>
          <div style="margin-top: 0.3rem; padding-left: 0.5rem;">
            ${failureRowsHtml}
          </div>
        </details>
        <div class="field is-grouped mt-2">
          <div class="control">
            <button class="button is-small is-warning" id="retryAirdropBtn">
              <span class="icon is-small"><i class="fas fa-redo"></i></span>
              <span>Retry failed</span>
            </button>
          </div>
          <div class="control">
            <button class="button is-small is-light" id="downloadAirdropRecipientsBtn">
              <span class="icon is-small"><i class="fas fa-file-csv"></i></span>
              <span>Download failed recipients CSV</span>
            </button>
          </div>
        </div>
      </div>
    `;
    // Wire the retry and download handlers (have to re-bind on each
    // render since innerHTML rewrites destroy the previous DOM nodes).
    const retryBtn = document.getElementById('retryAirdropBtn');
    if (retryBtn) retryBtn.addEventListener('click', runAirdropRetry);
    const dlBtn = document.getElementById('downloadAirdropRecipientsBtn');
    if (dlBtn) dlBtn.addEventListener('click', downloadFailedAirdropRecipientsCsv);
  }
}

// Retry the failed airdrop recipients via /api/retry-airdrop. Sends the
// current lastAirdropResult.failed list as the new recipient set and
// merges the result back into lastAirdropResult.
//
// Behavior:
//   - Recipients newly-delivered move from failed[] into transferred[].
//   - Recipients still-failing stay in failed[] with the (possibly new)
//     error message.
//   - The render-result function is called again with the updated state
//     so the panel reflects the new counts and (if all delivered) flips
//     to the success notice.
async function runAirdropRetry() {
  if (!lastAirdropResult || !lastAirdropResult.failed
      || lastAirdropResult.failed.length === 0) {
    return;
  }
  if (!createdTokenInfo || !createdTokenInfo.mint) {
    log('Cannot retry airdrop: token info missing.', 'warning');
    return;
  }
  if (!tempWallet || !tempWallet.publicKey || (demoModeActive && !tempWallet.secretKey)) {
    log('Cannot retry airdrop: launch wallet key not available.', 'warning');
    return;
  }
  const recipients = lastAirdropResult.failed.map((f) => ({
    wallet: f.wallet,
    tokens: f.tokens,
  }));
  const btn = document.getElementById('retryAirdropBtn');
  setLoading(btn, true);
  try {
    log(`Retrying airdrop to ${recipients.length} recipient${recipients.length === 1 ? '' : 's'}...`);
    // Kick off the live progress poll. Same pattern as runTransfer —
    // mirrors what the user sees during the initial airdrop step.
    startAirdropProgressPoll(tempWallet.publicKey, recipients.length);
    let resp;
    try {
      resp = await fetch('/api/retry-airdrop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          walletPublicKey: tempWallet.publicKey,
          // F5: the server resolves the secret from its encrypted store using
          // the public key for real launches; only demo mode (in-memory
          // ledger, no server-side secret) still sends the key inline.
          ...(demoModeActive ? { tempWalletSecretKey: tempWallet.secretKey } : {}),
          tokenMint: createdTokenInfo.mint,
          tokenDecimals: createdTokenInfo.decimals,
          isToken2022: false,
          recipients,
        }),
      });
    } finally {
      stopAirdropProgressPoll();
      hideAirdropProgressPanel();
    }
    const data = await resp.json();
    if (!data.success) throw new Error(data.error);
    // The server returns the MERGED per-recipient record (prior delivered +
    // this attempt's outcome, deduped against its journal) — replace our
    // copy wholesale rather than appending, which would double-count the
    // previously-delivered rows. Compute the log lines as deltas against
    // what we held before the call.
    const priorDeliveredCount = (lastAirdropResult.transferred || []).length;
    lastAirdropResult = {
      transferred: data.airdrop?.transferred || [],
      failed: data.airdrop?.failed || [],
    };
    renderAirdropTransferResult(lastAirdropResult);
    const delivered = Math.max(0, lastAirdropResult.transferred.length - priorDeliveredCount);
    const stillFailed = lastAirdropResult.failed.length;
    if (delivered > 0) {
      log(`Retry: ${delivered} additional recipient${delivered === 1 ? '' : 's'} delivered`, 'success');
    }
    if (stillFailed > 0) {
      log(`Retry: ${stillFailed} recipient${stillFailed === 1 ? '' : 's'} still failed`, 'warning');
    }
  } catch (e) {
    log(`Airdrop retry failed: ${e.message}`, 'danger');
  } finally {
    setLoading(btn, false);
  }
}

// Download the failed-recipients list as a CSV the user can use to
// manually distribute from their destination wallet (or hand off to
// another tool). Format matches the input airdrop CSV so the user
// could in principle re-upload it as a fresh launch — though that's
// not the typical use case.
function downloadFailedAirdropRecipientsCsv() {
  if (!lastAirdropResult || !lastAirdropResult.failed
      || lastAirdropResult.failed.length === 0) {
    return;
  }
  // wallet,tokens header matches the airdrop CSV input format. We add
  // a third "reason" column so the user has the failure context next
  // to each recipient, which is useful when triaging.
  const lines = ['wallet,tokens,reason'];
  for (const f of lastAirdropResult.failed) {
    const w = String(f.wallet || '');
    const t = Number.isFinite(Number(f.tokens)) ? String(f.tokens) : '';
    // Escape commas and quotes inside the reason field per RFC 4180.
    const reasonRaw = String(f.error || 'unknown');
    const reason = /[",\n]/.test(reasonRaw)
      ? '"' + reasonRaw.replace(/"/g, '""') + '"'
      : reasonRaw;
    lines.push(`${w},${t},${reason}`);
  }
  const csv = lines.join('\n') + '\n';
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const mintShort = (createdTokenInfo?.mint || 'launch').slice(0, 8);
  a.download = `airdrop-failed-${mintShort}-${Date.now()}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
