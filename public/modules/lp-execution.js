// ===========================================================================
// STEP 4: Create token
// ===========================================================================

bind('createTokenBtn', 'click', async () => {
  const btn = document.getElementById('createTokenBtn');
  await withRunState(async () => {
    setLoading(btn, true);
    markLaunchActiveForRpcHealth(true);
    try {
      log('Creating token...');
      const formData = new FormData();
      // F5: send the public key; the server resolves the secret from its
      // encrypted store for real launches. Demo has no server-side secret,
      // so it still appends the throwaway secret inline.
      formData.append('walletPublicKey', tempWallet.publicKey);
      if (demoModeActive) {
        formData.append('tempWalletSecretKey', JSON.stringify(tempWallet.secretKey));
      }
      formData.append('name', document.getElementById('tokenName').value.trim());
      formData.append('symbol', document.getElementById('tokenSymbol').value.trim());
      formData.append('description', document.getElementById('tokenDescription').value.trim());
      // Strip thousand-separator commas before sending. Keep this as a
      // string so large but valid SPL supplies do not lose integer precision
      // in JavaScript before the server converts to BigInt.
      const totalSupplyRaw = getIntegerInputString(document.getElementById('tokenSupply'));
      formData.append('totalSupply', totalSupplyRaw);
      // Vanity CA: if we pre-ground a keypair, send it. Otherwise
      // fall back to prefix/suffix for server-side grinding.
      if (selectedVanityCA !== null && vanityCAKeypairs[selectedVanityCA]) {
        const selected = vanityCAKeypairs[selectedVanityCA];
        if (Array.isArray(selected.secretKey)) {
          formData.append('vanityCAKeypair', JSON.stringify(selected.secretKey));
        } else if (selected.publicKey) {
          formData.append('vanityCAPublicKey', selected.publicKey);
        }
      } else {
        const vanityMode = document.getElementById('vanityCAMode')?.value || 'suffix';
        const vanityStart = document.getElementById('vanityCATarget')?.value.trim() || '';
        const vanityEnd = document.getElementById('vanityCAEndTarget')?.value.trim() || '';
        if (vanityMode === 'both') {
          if (vanityStart && vanityEnd) {
            formData.append('vanityPrefix', vanityStart);
            formData.append('vanitySuffix', vanityEnd);
          }
        } else if (vanityStart) {
          if (vanityMode === 'prefix') formData.append('vanityPrefix', vanityStart);
          else formData.append('vanitySuffix', vanityStart);
        }
      }
      const logoFile = document.getElementById('tokenLogo').files[0];
      if (logoFile) formData.append('logo', logoFile);

      const resp = await fetch('/api/create-token', { method: 'POST', body: formData });
      const data = await resp.json();
      if (resp.status === 409 && data.code === 'OP_IN_FLIGHT') {
        // A prior token creation (or other launch operation) is still
        // running for this wallet — likely a double-click or a UI reload
        // mid-creation. Not a failure; just wait for it to finish.
        log(data.error, 'warning');
        return;
      }
      if (!data.success) throw new Error(data.error);

      createdTokenInfo = {
        mint: data.tokenMint,
        mintFormat: data.mintFormat || 'token-2022',
        tokenProgram: data.tokenProgram || 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
        metadataStandard: data.metadataStandard || 'token-2022-inline',
        decimals: data.decimals || 9,
        totalSupply: totalSupplyRaw,
        name: data.name || document.getElementById('tokenName').value.trim(),
        symbol: data.symbol || document.getElementById('tokenSymbol').value.trim(),
        // Token-safety facts for the launch report / Arweave audit record.
        // The create-token endpoint spreads createTokenWithMetaplex's result
        // into the response, so these ride along on the same payload. They
        // let the permanent report assert (and a verifier confirm against
        // the mint account) that supply, freezing, and metadata are locked.
        metadataUri: data.metadataUri || null,
        imageUri: data.imageUri || null,
        mintAuthorityRenounced: data.mintAuthorityRenounced === true,
        freezeAuthorityDisabled: data.freezeAuthorityDisabled === true,
        metadataUpdateAuthorityRevoked: data.metadataUpdateAuthorityRevoked === true,
        metadataImmutable: data.metadataImmutable === true,
        metadataPointerAuthorityRevoked: data.metadataPointerAuthorityRevoked === true,
      };

      document.getElementById('tokenMintAddress').textContent = data.tokenMint;
      document.getElementById('tokenSolscanLink').href =
        `https://solscan.io/token/${data.tokenMint}`;
      document.getElementById('tokenCreatedInfo').classList.remove('hidden');
      // Hide the Create button after success — clicking it again would mint
      // a second token and overwrite createdTokenInfo, abandoning the first.
      document.getElementById('createTokenBtn').classList.add('hidden');
      log(`Token created: ${data.tokenMint}`, 'success');
    } catch (e) {
      log(`Token creation failed: ${e.message}`, 'danger');
      markLaunchActiveForRpcHealth(false);
    } finally {
      setLoading(btn, false);
    }
  });
});

bind('continueToLpBtn', 'click', () => {
  setStepSummary(4, `${createdTokenInfo.symbol} — ${createdTokenInfo.mint.slice(0, 8)}…`);
  renderLpSummary();
  activateStep(5);
});

// ===========================================================================
// STEP 5: Create LP
// ===========================================================================

function renderLpSummary() {
  const summary = document.getElementById('lpSummary');
  const targetMc = parseNumberInput(document.getElementById('targetMarketCap'));
  // Guard against zero / NaN total supply — the form field should never
  // accept that, but if something upstream produced a degenerate value
  // we surface a clear error instead of rendering "Infinity" or "NaN"
  // and proceeding into a broken launch.
  const totalSupply = Number(createdTokenInfo.totalSupply);
  if (!isFinite(totalSupply) || totalSupply <= 0) {
    summary.innerHTML =
      '<p class="has-text-danger"><strong>Invalid token supply.</strong> ' +
      'Please go back to Step 4, fix the total supply, and recreate the token.</p>';
    return;
  }
  const launchedTokenUsd = targetMc / totalSupply;

  // Escape every interpolation that includes user-provided or indexer-
  // sourced text. Token symbols, names, and quote symbols can contain
  // anything (the symbol field is free-form user input; resolvedSymbol
  // comes from on-chain metadata or third-party indexers and is not
  // sanitized at the source).
  const symSafe = escapeHtml(createdTokenInfo.symbol || '');

  let html = `
    <p>Ready to create <strong>${pools.length}</strong> pool${pools.length === 1 ? '' : 's'}
    for <strong>${symSafe}</strong> at <strong>$${launchedTokenUsd.toFixed(8)}</strong>
    per token (${targetMc.toLocaleString()} USD market cap).</p>
    <ul>
  `;
  for (const p of pools) {
    const quoteSafe = escapeHtml(p.resolvedSymbol || p.quoteToken || '');
    const sliceCount = p.distribution.length;
    const externalCount = p.distribution.filter((s) => s.useExternalRecipient && s.recipient).length;
    html += `<li><strong>${quoteSafe}</strong> pool — ${p.supplyPercent}% of supply, `;
    html += `${sliceCount} slice${sliceCount === 1 ? '' : 's'}`;
    if (externalCount > 0) html += ` (${externalCount} to external wallet${externalCount === 1 ? '' : 's'})`;
    html += `</li>`;
  }
  html += `</ul>`;
  html += `<p>Lock liquidity (Burn &amp; Earn): <strong>${document.getElementById('lockPositions').checked ? 'Yes' : 'No'}</strong></p>`;
  summary.innerHTML = html;
}

// ---------------------------------------------------------------------------
// Pre-commit confirmation flow (Milestone C from the price-safety plan)
// ---------------------------------------------------------------------------
//
// Before /api/create-lp runs, we call /api/preflight-create-lp which
// resolves the just-in-time Raydium price for every quote token and
// applies the drift guard against what the user committed to at
// funding time. The user sees the actual initialPrice each pool will
// be created at, and either confirms or cancels.
//
// Two things this gives us beyond Milestone A's server-side safety
// net:
//
//   1. Visibility. The user gets to look at the price before the
//      irreversible click, not just trust that Trebuchet is using
//      the right number.
//
//   2. Tight drift window. The actual /api/create-lp re-probes
//      Raydium (Milestone A), and uses the prices we resolved here
//      as the override reference for its drift guard. So the
//      guard measures movement during the confirmation window
//      (seconds, not minutes), not movement since funding-estimate
//      (which could be hours stale). That's how the drift guard
//      becomes useful for both the long-funding-gap case AND the
//      modal-was-open-too-long case.

// Show the pre-commit confirmation modal. Returns a Promise that
// resolves to the confirmed resolved-prices array (proceed) or null
// (cancel). The body argument is the per-pool list rendered into the
// modal body.
//
// Modal is shown and torn down here; on Confirm we resolve with the
// passed-in prices unchanged (the modal doesn't modify them), on
// Cancel we resolve null.
function showPreflightModal(resolvedPrices) {
  const modal = document.getElementById('createLpConfirmModal');
  const proceedBtn = document.getElementById('createLpConfirmProceedBtn');
  const cancelBtn = document.getElementById('createLpConfirmCancelBtn');
  if (!modal || !proceedBtn || !cancelBtn) {
    // Modal markup missing. The plan's safety-first principle is: when
    // in doubt, REFUSE to launch — silently bypassing the confirmation
    // step would defeat the whole purpose of Milestone C. Resolve null
    // (same as user-cancel) so the launch aborts cleanly without
    // touching chain. The user can fix or reload and retry.
    console.error(
      'createLpConfirmModal markup missing — aborting launch as a safety ' +
      'precaution. This is a bug; please report.',
    );
    log(
      'Cannot launch: confirmation modal is missing. This is a bug ' +
      '— please report it. No SOL was spent.',
      'danger',
    );
    return Promise.resolve(null);
  }

  renderPreflightModalBody(resolvedPrices);

  return new Promise((resolve) => {
    let resolved = false;
    const finish = (val) => {
      if (resolved) return;
      resolved = true;
      modal.classList.remove('is-active');
      proceedBtn.removeEventListener('click', onProceed);
      cancelBtn.removeEventListener('click', onCancel);
      const bg = modal.querySelector('.modal-background');
      if (bg) bg.removeEventListener('click', onCancel);
      resolve(val);
    };
    const onProceed = () => finish(resolvedPrices);
    const onCancel = () => finish(null);
    proceedBtn.addEventListener('click', onProceed);
    cancelBtn.addEventListener('click', onCancel);
    const bg = modal.querySelector('.modal-background');
    if (bg) bg.addEventListener('click', onCancel);
    modal.classList.add('is-active');
  });
}

// Render the body of the pre-commit confirmation modal. One row per
// allocation, showing quote symbol, resolved initialPrice (quote token
// per launched token, e.g. "5e-6 SOL per FROG"), source label, and
// drift indicator when the price moved noticeably from the user's
// funding-estimate value.
function renderPreflightModalBody(resolvedPrices) {
  const list = document.getElementById('createLpConfirmList');
  if (!list) return;

  // Find the user-typed targetMarketCap and total supply to compute
  // the launched-token USD value (same as renderLpSummary). We render
  // the initial price as quote-per-launched-token to match how
  // Raydium presents prices (the user's "1 of my tokens costs X SOL"
  // mental model).
  const targetMc = parseNumberInput(document.getElementById('targetMarketCap'));
  const totalSupply = Number(createdTokenInfo?.totalSupply || 0);
  const launchedTokenUsd =
    isFinite(totalSupply) && totalSupply > 0 && isFinite(targetMc)
      ? targetMc / totalSupply
      : null;

  let html = '';
  for (const rp of resolvedPrices) {
    const symbol = escapeHtml(rp.quoteSymbol || rp.quoteMint || '?');
    const quoteUsdNum = Number(rp.quoteUsd);
    const initialPriceNum = Number(rp.initialPrice);

    // Format both prices reasonably — too many digits is noise, too
    // few hides meaningful precision for low-priced tokens.
    const fmtUsd = (n) =>
      isFinite(n) && n > 0
        ? '$' + n.toLocaleString(undefined, { maximumSignificantDigits: 6 })
        : '—';
    const fmtRatio = (n) =>
      isFinite(n) && n > 0
        ? n.toLocaleString(undefined, { maximumSignificantDigits: 6 })
        : '—';

    // Source label, in plain English. Source vocabulary (matches the
    // funding-estimate + Step-2-cache convention):
    //   'sol'           → SOL/USD oracle
    //   'raydium-probe' → live Raydium swap probe (the canonical answer)
    //   'oracle'        → aggregator (gecko/dexscreener). Several causes
    //                      lead here (probe skipped for known-safe quotes,
    //                      Raydium genuinely has no pool, transient probe
    //                      failure). The honest advice for the user is the
    //                      same in all cases: verify the price. We render
    //                      this as a clickable GeckoTerminal link so the
    //                      user can verify in one click.
    //   'user-override' → user typed a value in customize mode
    //   'unresolved'    → couldn't get any price (shouldn't reach modal)
    //
    // sourceHtml is interpolated raw (not via escapeHtml) so the link can
    // render — non-link branches escape their own content where needed.
    let sourceHtml;
    if (rp.source === 'raydium-probe') {
      sourceHtml = 'verified from Raydium';
    } else if (rp.source === 'sol') {
      sourceHtml = 'SOL/USD oracle';
    } else if (rp.source === 'user-override') {
      sourceHtml = 'user-set price';
    } else if (rp.source === 'oracle') {
      // Render as a clickable GeckoTerminal link. Use the quoteMint
      // from the preflight response (always set for non-SOL pools
      // that reach this branch).
      const mint = rp.quoteMint || '';
      if (mint) {
        const safeMint = encodeURIComponent(mint);
        sourceHtml =
          '<a href="https://www.geckoterminal.com/solana/tokens/' +
          safeMint +
          '" target="_blank" rel="noopener noreferrer" ' +
          'title="Open this token\'s GeckoTerminal page in a new tab">' +
          'verify price ' +
          '<i class="fas fa-external-link-alt is-size-7"></i></a>';
      } else {
        sourceHtml = 'verify price';
      }
    } else {
      sourceHtml = escapeHtml(rp.source || 'unknown source');
    }

    // Drift indicator. driftPct is signed (positive = probe higher
    // than what the user committed at funding). >5% absolute is
    // worth showing; small movements aren't. Wording names the quote
    // symbol explicitly because "Price" alone is ambiguous: the
    // launched token's USD-denominated price is invariant to quote
    // drift (we adjust the pool ratio accordingly), so the only
    // thing actually drifting here is the quote token's USD value.
    let driftLine = '';
    if (rp.driftPct !== null && rp.driftPct !== undefined && Math.abs(rp.driftPct) >= 5) {
      const direction = rp.driftPct > 0 ? 'higher' : 'lower';
      driftLine =
        `<div class="is-size-7 has-text-warning-dark mt-1">` +
          `<i class="fas fa-exclamation-circle"></i> ` +
          `${symbol} price is ${Math.abs(rp.driftPct).toFixed(1)}% ${direction} than ` +
          `the funding estimate — within tolerance, but worth a glance.` +
        `</div>`;
    }

    html += `
      <div class="box p-3 mb-2">
        <div class="is-flex is-justify-content-space-between is-align-items-center">
          <div>
            <strong>${symbol} pool</strong>
            <span class="has-text-grey is-size-7"> · ${sourceHtml}</span>
          </div>
          <div class="has-text-right">
            <div class="is-size-7 has-text-grey">Initial price</div>
            <div><strong>${fmtRatio(initialPriceNum)}</strong>
              <span class="has-text-grey is-size-7"> ${symbol} per token</span></div>
            <div class="is-size-7 has-text-grey">
              ${symbol} ≈ ${fmtUsd(quoteUsdNum)}${
                launchedTokenUsd
                  ? ` · launch ≈ $${launchedTokenUsd.toLocaleString(undefined, { maximumSignificantDigits: 4 })}`
                  : ''
              }
            </div>
          </div>
        </div>
        ${driftLine}
      </div>
    `;
  }
  list.innerHTML = html;
}

// Run /api/preflight-create-lp and show the confirmation modal on
// success. Returns the resolved prices on user-confirm, null on
// user-cancel, or throws on preflight failure (network / pre_flight
// validation / drift guard / no Raydium route / etc).
//
// The caller wraps this in the same withRunState + try/catch as the
// actual create-lp call, so preflight failures route to the same
// failure-rendering code that handles pre_flight from /api/create-lp.
async function runPreflightAndConfirm(allocations, targetMc) {
  log('Verifying current prices…', 'info');
  let resp;
  try {
    resp = await fetch('/api/preflight-create-lp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tokenTotalSupply: createdTokenInfo.totalSupply,
        targetMarketCapUsd: targetMc,
        allocations,
      }),
    });
  } catch (fetchErr) {
    // Network failure (offline, DNS, etc.). Tag as pre_flight so the
    // caller routes us through the proper failure UI, not log-only.
    const err = new Error(
      `Could not reach the Trebuchet server (${fetchErr.message}). ` +
      `Check your internet connection and try again. No SOL was spent.`,
    );
    err.failedPhase = 'pre_flight';
    err.cause = fetchErr;
    throw err;
  }
  let data;
  try {
    data = await resp.json();
  } catch (parseErr) {
    const err = new Error(
      `Preflight returned a non-JSON response (HTTP ${resp.status}). ` +
      `This usually means the server is having trouble. Try again in ` +
      `a moment. No SOL was spent.`,
    );
    err.failedPhase = 'pre_flight';
    err.cause = parseErr;
    throw err;
  }
  if (!data.success) {
    // The server already tagged this as pre_flight. Throw with the
    // same shape so the caller's existing failure-rendering code
    // surfaces it correctly.
    const err = new Error(data.error || 'Preflight failed');
    err.failedPhase = data.failedPhase || 'pre_flight';
    err.failedAllocationIndex = data.failedAllocationIndex;
    err.failedAllocation = data.failedAllocation;
    err.probeCode = data.probeCode;
    throw err;
  }

  if (!data.preflight || !Array.isArray(data.preflight.resolvedPrices)) {
    // Server returned success:true but a malformed payload. Shouldn't
    // happen, but guard against it cleanly so the user gets a tagged
    // error and proper UI rather than a TypeError dropped into log.
    const err = new Error(
      'Preflight returned an unexpected response shape. This is a bug; ' +
      'please report it. No SOL was spent.',
    );
    err.failedPhase = 'pre_flight';
    throw err;
  }
  if (data.preflight.resolvedPrices.length === 0) {
    // Empty resolvedPrices means there were no allocations. The
    // frontend gates against this in updateContinueToFundingState
    // already (Continue button is disabled with no pools), so this
    // shouldn't be reachable — but guard against it anyway.
    const err = new Error(
      'No pools to confirm. Add at least one pool and try again.',
    );
    err.failedPhase = 'pre_flight';
    throw err;
  }

  return await showPreflightModal(data.preflight.resolvedPrices);
}

bind('createLpBtn', 'click', async () => {
  const btn = document.getElementById('createLpBtn');
  await withRunState(async () => {
    setLoading(btn, true);
    markLaunchActiveForRpcHealth(true);
    try {
      // Hide any stale failure banner from a prior attempt. This matters
      // for the pre-flight-retry case: if the previous attempt failed in
      // pre-flight and the user fixed their allocation, the failure
      // notification needs to go away when they re-click Create Pools so
      // they don't see "Validation failed..." next to a now-running launch.
      document.getElementById('lpFailInfo').classList.add('hidden');

      const allocations = buildAllocationsForApi();
      const targetMc = parseNumberInput(document.getElementById('targetMarketCap'));
      const lockPositions = document.getElementById('lockPositions').checked;

      // Pre-commit confirmation flow (Milestone C). Runs the just-in-time
      // Raydium probe + drift guard on the server, shows the user the
      // resolved initialPrice for each pool, and asks them to confirm.
      // The preflight throws on any pre_flight failure (no route, network,
      // drift > threshold), which the outer catch handles the same way
      // it handles pre_flight failures from /api/create-lp.
      //
      // We DON'T reveal lpProgress until after the user confirms — showing
      // an empty progress panel beneath the modal while they're reading
      // prices is confusing. If the user cancels or preflight throws, we
      // never reveal it.
      let confirmedPrices;
      try {
        confirmedPrices = await runPreflightAndConfirm(allocations, targetMc);
      } catch (preflightErr) {
        // Re-throw so the outer catch in this handler routes the
        // failure to the pre_flight UI branch. The preflightErr
        // already has failedPhase='pre_flight'.
        throw preflightErr;
      }

      if (confirmedPrices === null) {
        // User clicked Cancel. lpProgress was never revealed (we wait
        // until after confirmation to show it), so there's nothing to
        // clean up — just log and return.
        log('Pool creation cancelled — no SOL spent.', 'info');
        return;
      }

      // Override each allocation's quoteUsdOverride with the exact
      // price the user just confirmed in the modal. This pins what
      // the user saw to what the launch will use, and means the
      // create-lp probe's drift guard measures movement during the
      // confirmation window (seconds), not since funding-estimate
      // (potentially hours).
      for (const cp of confirmedPrices) {
        // Validate allocationIndex strictly — Number.isInteger rejects
        // undefined/null/NaN/strings, which would otherwise slip through
        // the bounds check (NaN comparisons return false in both
        // directions) and crash on the property write below.
        if (!Number.isInteger(cp.allocationIndex)) continue;
        if (cp.allocationIndex < 0 || cp.allocationIndex >= allocations.length) continue;
        // Only overwrite if the preflight successfully resolved a
        // price for this allocation. (It should — preflight throws
        // otherwise.)
        if (cp.quoteUsd !== null && cp.quoteUsd !== undefined) {
          allocations[cp.allocationIndex].quoteUsdOverride = Number(cp.quoteUsd);
        }
      }

      // User confirmed — reveal the progress panel and clear any stale
      // tree content from a prior attempt.
      document.getElementById('lpProgress').classList.remove('hidden');
      document.getElementById('lpProgressTree').innerHTML = '';

      log(`Starting pool creation for ${pools.length} pool(s)...`);
      addProgressIntro();
      buildPhaseProgressTree(pools, lockPositions);
      // Fresh launch: clear any published-report record from a prior run so the
      // step-5 publish fires (its idempotency guard skips 'pending'/'done') and
      // the success modal shows THIS launch's report rather than a stale one.
      _publishedReport = null;

      // Start the LP progress poll just before the fetch so per-step
      // events translate to row checkmarks in real time (instead of all
      // rows flipping at once when the response lands). Both demo and
      // real launches feed the server-side tracker now.
      if (tempWallet && tempWallet.publicKey) {
        startLpProgressPoll(tempWallet.publicKey);
      }
      let resp;
      try {
        resp = await fetch('/api/create-lp', {
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
            tokenTotalSupply: createdTokenInfo.totalSupply,
            targetMarketCapUsd: targetMc,
            allocations,
            lockPositions,
            // Airdrop plan (or absent when none configured). The server
            // doesn't act on it here — it journals it under
            // poolPlan.airdropPlan so a launch resumed after an app
            // restart still carries the configured airdrop into the
            // final transfer. Without this, the airdrop config would be
            // lost with the frontend's memory and the resumed transfer
            // would silently skip it.
            ...((() => {
              const plan = buildAirdropTransferPayload();
              return plan ? { airdrop: plan } : {};
            })()),
          }),
        });
      } finally {
        // Always tear down the poll — even on a fetch failure, leaving
        // the poll running would just pile up empty responses.
        stopLpProgressPoll();
      }
      // The /api/create-lp endpoint returns JSON for both success (200)
      // and structured failure (500 with body). A non-JSON 5xx response
      // means something upstream of the route handler died (express
      // crashed, proxy returned an error page, etc) and the user
      // shouldn't see the cryptic "Unexpected token < in JSON" they'd
      // get from a blind resp.json().
      let data;
      try {
        data = await resp.json();
      } catch (parseErr) {
        if (!resp.ok) {
          throw new Error(
            `Server returned HTTP ${resp.status} with non-JSON body. ` +
            `This usually means the server crashed or a proxy intervened. ` +
            `Check the server console for details.`,
          );
        }
        throw new Error(`Unexpected response: ${parseErr.message}`);
      }

      if (resp.status === 409 && data.code === 'OP_IN_FLIGHT') {
        // Another launch operation is already running for this wallet —
        // usually a prior create-lp that survived a UI reload (the server
        // runs in-process with Electron main, so the launch keeps going
        // even if the page reloads). Do NOT render this as a launch
        // failure; the launch isn't failed, it's running. Reattach the
        // progress poll so the user can watch it, and keep them away
        // from the retry buttons.
        log(data.error, 'warning');
        log(
          'Reattached to the running operation — progress will update ' +
          'below as it proceeds. Do not close the app.',
          'warning',
        );
        if (tempWallet && tempWallet.publicKey) {
          startLpProgressPoll(tempWallet.publicKey);
        }
        return;
      }

      if (data.success) {
        lpResult = data;
        data.results.forEach((r, i) => markPoolDone(i, r));
        markAllBootstrapsDone();
        log(`All ${data.results.length} pool(s) created and bootstrapped`, 'success');
        setLpDoneVisible(true);
        document.getElementById('lpDoneSummary').innerHTML = buildLpDoneSummary(data.results);
        renderLaunchReportPreview('step5');
        // NOTE: the permanent launch report is NOT published here anymore.
        // It publishes during step 6 (runTransfer), after the airdrop and
        // before the sweep — at that point every on-chain token-setup
        // transaction has landed, so the permanent record includes the
        // actual airdrop delivery results instead of a forever-"pending"
        // section. The step-5 preview below still shows the report;
        // pending sections render as pending until then.
        // Hide the Create Pools button — re-clicking would attempt to create
        // duplicate pools for the same token, which is wasteful and confusing.
        document.getElementById('createLpBtn').classList.add('hidden');
      } else {
        // Phase-aware partial-failure rendering. The orchestrator returns
        // failedPhase = 'pre_flight', 'main_positions', 'bootstrap', 'locks',
        // or 'transfers' so we can mark the right rows as failed without
        // misrepresenting what completed.
        //
        // Under the deferred-lock model:
        //   - 'main_positions': pool may have been created, slice opens failed
        //   - 'bootstrap': mains opened in every pool, some bootstraps failed
        //   - 'locks': all opens succeeded across all pools, some locks failed
        //   - 'transfers': all opens + locks succeeded, some Fee Key transfers
        //     failed (non-blocking — leftover NFTs sweep back to user)
        lpResult = { results: data.partialResults || [] };
        const failedPhase = data.failedPhase || 'main_positions';

        if (failedPhase === 'pre_flight') {
          // Validation failed BEFORE any pool was created — nothing is on
          // chain yet. Mark only the offending allocation as failed; the
          // others stay as "pending" since they were never attempted.
          // The lpFailInfo notification surfaces the reason (typically a
          // Token-2022 mint with extensions Raydium doesn't support).
          if (data.failedAllocationIndex != null) {
            markPoolFailed(data.failedAllocationIndex, data.error);
          }
        } else if (failedPhase === 'main_positions') {
          // Pools whose main positions completed successfully; the failed
          // pool's main row gets the failure marker. No bootstraps ran yet.
          (data.partialResults || []).forEach((r) => {
            markPoolDone(r.allocationIndex, r);
          });
          if (data.failedAllocationIndex != null) {
            markPoolFailed(data.failedAllocationIndex, data.error);
          }
        } else if (failedPhase === 'bootstrap') {
          // All main positions completed; bootstrapping failed partway.
          // Mark every pool's main rows as done, then mark each bootstrap
          // row done if its result entry has a populated bootstrap field,
          // and mark every failed pool's bootstrap as failed.
          (data.partialResults || []).forEach((r) => {
            markPoolDone(r.allocationIndex, r);
            if (r.bootstrap) markBootstrapDoneForPool(r.allocationIndex, r.bootstrap);
          });
          // bootstrapFailures is an array of { allocationIndex, quoteSymbol, error }
          // for each bootstrap that failed. Falls back to failedAllocationIndex
          // for backward compatibility with older error shapes that didn't carry
          // the array.
          const failures = data.bootstrapFailures
            || (data.failedAllocationIndex != null
              ? [{ allocationIndex: data.failedAllocationIndex, error: data.error }]
              : []);
          for (const f of failures) {
            markBootstrapFailedForPool(f.allocationIndex, f.error);
          }
        } else if (failedPhase === 'locks' || failedPhase === 'transfers') {
          // All pools, mains, and bootstraps are open on-chain. The failure
          // is in the post-open lock or transfer phase. Mark every pool's
          // main and bootstrap rows as done (they did open successfully),
          // but leave the per-position lock/transfer markers in their
          // current state — the partialResults entries carry per-position
          // `locked` and `transferredTo` flags that the progress tree could
          // be enhanced to read from later. For now the user sees a clear
          // recovery message via lpFailInfo below.
          (data.partialResults || []).forEach((r) => {
            markPoolDone(r.allocationIndex, r);
            if (r.bootstrap) markBootstrapDoneForPool(r.allocationIndex, r.bootstrap);
          });
        }

        log(`Pool creation failed (phase: ${failedPhase}): ${data.error}`, 'danger');
        document.getElementById('lpFailInfo').classList.remove('hidden');

        // Friendlier error summary. The raw on-chain error message is often
        // an opaque JSON blob ("InstructionError: [2, {Custom: 2022}]"); if
        // we recognize a known pattern, translate it into something a human
        // can act on. Otherwise pass through the original.
        const rawErr = String(data.error || 'unknown error');
        let friendly = rawErr;
        if (failedPhase === 'pre_flight') {
          // Pre-flight errors are already human-readable (we wrote them).
          // Pass through verbatim — they typically explain exactly which
          // unsupported Token-2022 extensions were detected.
          friendly = rawErr;
        } else if (/Custom["':]\s*2022/.test(rawErr)) {
          friendly =
            'Anchor constraint violation (code 2022, ConstraintMintTokenProgram) — ' +
            'this means a Token-2022 mint was passed where the SPL Token program was ' +
            'expected. This commonly happens with pump.fun tokens and other Token-2022 ' +
            'mints. The latest build should detect these automatically; if you\'re ' +
            'still seeing this, the quote token may have an unusual extension that\'s ' +
            'not yet supported.';
        } else if (/insufficient.*lamports|0x1.*lamports/i.test(rawErr)) {
          friendly =
            'The ephemeral wallet ran out of SOL partway through. Cost variance ' +
            'on this launch exceeded the safety buffer.';
        }
        document.getElementById('lpFailSummary').textContent = friendly;

        // Render structured error with category badge + "What happened?"
        const lpFailContainer = document.getElementById('lpFailInfo').querySelector('.notification');
        if (lpFailContainer) {
          // Clear any previous structured error block
          const prevBanner = lpFailContainer.querySelector('.error-banner');
          if (prevBanner) prevBanner.remove();
          renderStructuredError(lpFailContainer, friendly, categorizeError(friendly));
        }

        // Show counts so the user knows what state things are in. These are
        // useful for understanding what they're recovering vs what they've
        // permanently put on-chain.
        const successCount = (data.partialResults || []).length;
        const totalCount = pools.length;
        const failedAlloc = data.failedAllocation;
        const failedSymbol = failedAlloc?.quoteSymbol
          || failedAlloc?.quoteToken
          || `allocation ${data.failedAllocationIndex}`;

        if (failedPhase === 'pre_flight') {
          // Nothing was attempted on chain. Tell the user this is a clean
          // abort — no SOL spent, no on-chain artifacts to clean up. The
          // "Skip to Transfer Assets" path is still available (they may
          // want to abandon and try over) but the primary recovery is
          // just to fix the allocation and re-click Create Pools.
          document.getElementById('lpFailHeading').textContent =
            'Validation failed before pool creation started.';
          document.getElementById('lpFailSucceededCount').innerHTML =
            `Nothing has been created on-chain yet — the failure is in ` +
            `the pre-launch validation of <strong>${escapeHtml(failedSymbol)}</strong>. ` +
            `Fix or remove this allocation and click Create Pools again; no SOL was spent.`;
          document.getElementById('lpFailReassurance').innerHTML =
            `<strong>No on-chain side effects.</strong> The ephemeral wallet still holds ` +
            `everything it did before you clicked Create Pools (SOL, any auto-swapped ` +
            `quote tokens). You can either fix the failing allocation above and retry, ` +
            `or sweep everything back to your destination wallet.`;
          document.getElementById('continueToTransferAfterFailBtnLabel').textContent =
            'Or sweep wallet to destination';
        } else {
          // Mid-launch failure — at least one pool was created and the
          // on-chain state can't be rolled back. Distinguish by phase:
          //   - 'bootstrap':  pools created, missing bootstraps. Recoverable
          //                   in place via Retry bootstraps.
          //   - 'locks':      all opens done across every pool, some locks
          //                   failed. Resume retries just the unlocked.
          //   - 'transfers':  all locks done, some Fee Key transfers failed.
          //                   Non-blocking — leftover NFTs sweep back to user.
          //   - 'main_positions' (default fallback): a slice open failed.
          //                   Not recoverable in place; must sweep and start
          //                   over (mid-Phase-1 partial recovery is a wider
          //                   refactor not done yet).
          let heading;
          if (failedPhase === 'bootstrap') {
            heading = 'Some pools couldn\'t be bootstrapped.';
          } else if (failedPhase === 'locks') {
            heading = 'Some positions couldn\'t be locked.';
          } else if (failedPhase === 'transfers') {
            heading = 'Some Fee Key transfers couldn\'t be delivered.';
          } else {
            heading = 'Pool creation failed partway through.';
          }
          document.getElementById('lpFailHeading').textContent = heading;
          document.getElementById('lpFailSucceededCount').innerHTML =
            `<strong>${successCount} of ${totalCount}</strong> pool${successCount === 1 ? '' : 's'} ` +
            `created successfully before the failure on <strong>${escapeHtml(failedSymbol)}</strong>. ` +
            `The created pools are permanent on-chain; their LP NFTs are in your ephemeral wallet.`;
          if (failedPhase === 'bootstrap') {
            // Bootstrap-only failures: pools and main positions are all
            // good, just the bootstrap leg is missing on some. Retrying
            // is safe and the typical fix.
            document.getElementById('lpFailReassurance').innerHTML =
              `<strong>Main positions are in place for every pool.</strong> Only the bootstrap ` +
              `leg failed for the pools listed above — these pools won't be tradable at the ` +
              `intended price until their bootstraps land. Click <strong>Retry bootstraps</strong> ` +
              `to try again (most bootstrap failures are transient RPC issues). If retrying ` +
              `keeps failing, sweep the wallet to your destination and manually add bootstrap ` +
              `liquidity in the Raydium UI later.`;
          } else if (failedPhase === 'locks') {
            // Lock-phase failures: every pool's main and bootstrap positions
            // are open on-chain (and the bootstraps make the pools tradable).
            // The positions just haven't been locked yet, which means the
            // ephemeral wallet can still close them — assets are recoverable
            // either by completing the locks or by sweeping the wallet back
            // (which would also close the open positions).
            document.getElementById('lpFailReassurance').innerHTML =
              `<strong>Every pool is open and tradable.</strong> The missing step is the lock — ` +
              `until locks finish, the LP'd tokens are still recoverable by the launch wallet. ` +
              `Click <strong>Resume launch</strong> to try the remaining locks again (most lock ` +
              `failures are transient RPC issues). If locks keep failing and you'd rather walk ` +
              `away, sweep the wallet to your destination — the open positions get closed and ` +
              `their LP tokens come back with the sweep.`;
          } else if (failedPhase === 'transfers') {
            // Transfer-phase failures are non-blocking conceptually: every
            // pool is locked successfully, only the courtesy of delivering
            // Fee Key NFTs to recipient addresses didn't complete. The
            // un-transferred NFTs are in the launch wallet and will sweep
            // to the user's destination wallet.
            document.getElementById('lpFailReassurance').innerHTML =
              `<strong>The launch itself succeeded.</strong> Every pool is created, tradable, and ` +
              `locked. The only thing that didn't finish was the delivery of Fee Key NFTs to ` +
              `recipient addresses you specified. Those NFTs are in your launch wallet and will ` +
              `come along with the final sweep to your destination wallet, so nothing is lost. ` +
              `You can manually send them to the intended recipients afterward, or click ` +
              `<strong>Resume launch</strong> to try the deliveries again.`;
          } else {
            // Main-positions failure: at least one pool was created but
            // its main positions couldn't be opened (or the next pool
            // couldn't be created). Complete prior pools are resumable,
            // but a pool that was created without a completed allocation
            // result is not safe to auto-resume yet.
            document.getElementById('lpFailReassurance').innerHTML =
              `<strong>Your assets are safe</strong> — they're still in the ephemeral wallet ` +
              `(SOL, any auto-swapped quote tokens, and the LP NFTs from pools that did succeed). ` +
              `Click <strong>Resume launch</strong> to continue only if Trebuchet has enough ` +
              `journaled state to skip completed pools safely. If the journal shows a pool was ` +
              `created before a completed LP result was recorded, automatic resume will stop and ` +
              `you should sweep the wallet or recover the existing LP positions manually.`;
          }
          // Continue/sweep button label. For 'bootstrap' and 'locks',
          // the user has unfinished work that retry can fix in place,
          // so the sweep alternative reads as a secondary "give up"
          // option ("Or sweep to destination instead"). For 'transfers'
          // and the default main_positions case, the alternative IS
          // the primary recovery path (sweep collects everything),
          // so it reads as "Skip to Transfer Assets".
          document.getElementById('continueToTransferAfterFailBtnLabel').textContent =
            (failedPhase === 'bootstrap' || failedPhase === 'locks')
              ? 'Or sweep to destination instead'
              : 'Skip to Transfer Assets';
        }

        // Resume button visibility: meaningful for any post-pre-flight
        // failure (main_positions, bootstrap, locks, transfers). The
        // button calls a unified /api/resume-launch endpoint that
        // inspects per-position state in priorResults and skips any
        // operation already done. Pre-flight failures don't need the
        // button — the user fixes the config and re-clicks Create Pools.
        const retryBtn = document.getElementById('retryBootstrapsBtn');
        const retryLabel = retryBtn.querySelector('span:last-child');
        if (failedPhase !== 'pre_flight') {
          retryBtn.classList.remove('hidden');
          // Phase-specific label. Bootstrap gets its own verb ("Retry
          // bootstraps") because that's the established muscle memory
          // for that case; everything else uses the generic "Resume launch"
          // since the resume endpoint will figure out what to do.
          if (retryLabel) {
            retryLabel.textContent = failedPhase === 'bootstrap'
              ? 'Retry bootstraps'
              : 'Resume launch';
          }
          // Stash the data the retry endpoint needs. We pull it back out
          // in the click handler instead of closing over it — the click
          // handler is registered once at module load and shouldn't
          // capture stale state from a specific failure.
          retryBtn.dataset.lockPositions = String(lockPositions);
        } else {
          retryBtn.classList.add('hidden');
        }

        // For mid-launch failures, hide the Create Pools button — pools
        // that were created already are immutable, and re-clicking would
        // attempt to create duplicate pools for the same token (wasteful
        // and confusing). Recovery is via "Skip to Transfer Assets".
        //
        // For pre-flight failures, KEEP the button visible — nothing was
        // attempted on chain. The user just needs to fix their allocation
        // (remove the incompatible quote, swap to a different mint, or
        // fix RPC settings) and click Create Pools again. Hiding the
        // button here would force them into "Skip to Transfer Assets",
        // wasting the SOL they already spent on token creation.
        if (failedPhase !== 'pre_flight') {
          document.getElementById('createLpBtn').classList.add('hidden');
        }
      }
    } catch (e) {
      // Mark the launch as no-longer-active for RPC health tracking,
      // regardless of which error path we take. The price-safety
      // pre_flight UI routing below decides how to surface the error
      // to the user; this is bookkeeping that runs either way.
      markLaunchActiveForRpcHealth(false);

      // If runPreflightAndConfirm threw a preflight-tagged error, route
      // it to the lpFailInfo panel with the standard pre_flight UI
      // treatment. Without this, preflight failures (NO_ROUTE,
      // NETWORK_ERROR, drift > 25%) would only surface as a log line —
      // losing the "no SOL spent, fix and retry" guidance and leaving
      // the progress UI in a half-rendered state.
      //
      // We detect the case via e.failedPhase, which only the preflight
      // throw sets (a generic JS throw won't have it). All preflight
      // throws are 'pre_flight' by definition (no on-chain action has
      // happened yet), so the rendering is much simpler than the
      // /api/create-lp branch which handles many phases.
      if (e && e.failedPhase === 'pre_flight') {
        // lpProgress was never revealed (we wait until after user
        // confirms), so there's nothing to hide.

        // Mark the offending allocation as failed in the pool list.
        // Other allocations stay in their pre-launch state since they
        // were never attempted.
        if (e.failedAllocationIndex != null) {
          markPoolFailed(e.failedAllocationIndex, e.message);
        }

        // Populate the lpFailInfo panel with the same messaging the
        // /api/create-lp pre_flight branch uses, then reveal it.
        const failedSymbol =
          e.failedAllocation?.quoteSymbolOverride
          || e.failedAllocation?.quoteToken
          || (e.failedAllocationIndex != null
              ? `allocation ${e.failedAllocationIndex + 1}`
              : 'an allocation');

        document.getElementById('lpFailSummary').textContent = e.message;
        document.getElementById('lpFailHeading').textContent =
          'Validation failed before pool creation started.';
        document.getElementById('lpFailSucceededCount').innerHTML =
          `Nothing has been created on-chain yet — the failure is in ` +
          `the pre-launch validation of <strong>${escapeHtml(failedSymbol)}</strong>. ` +
          `Fix or remove this allocation and click Create Pools again; no SOL was spent.`;
        // The reassurance block normally explains sweep / recovery. For
        // pre_flight there's nothing to sweep — surface that explicitly.
        const reassuranceEl = document.getElementById('lpFailReassurance');
        if (reassuranceEl) {
          reassuranceEl.innerHTML =
            '<strong>No SOL was spent.</strong> The ephemeral wallet has not been touched. ' +
            'Edit the pool configuration above and try again.';
        }
        document.getElementById('lpFailInfo').classList.remove('hidden');

        // Keep the Create Pools button visible. The user just needs to
        // fix the allocation (refresh funding estimate, pick a different
        // quote token, retry on transient network) and re-click. Hiding
        // it would force them into "Skip to Transfer Assets," which is
        // the wrong recovery for a failure that didn't touch chain.

        log(`Pre-flight check failed: ${e.message}`, 'danger');
      } else {
        log(`LP creation failed: ${e.message}`, 'danger');
      }
    } finally {
      setLoading(btn, false);
    }
  });
});

// Build the entire progress tree as four phase blocks, matching the
// orchestrator's execution order:
//
//   Phase 1 — Create pools and open main positions
//   Phase 2 — Open bootstrap positions
//   Phase 3 — Lock positions (only when lockPositions=true)
//   Phase 4 — Transfer Fee Keys to recipients (only when at least one
//             slice has an external recipient AND lockPositions=true,
//             since Fee Keys only exist for locked positions)
//
// Within each phase, rows are listed pool-by-pool (Pool 1 things, then
// Pool 2 things, etc.). This is the structure that matches what the
// orchestrator actually does and produces a coherent narrative when the
// user reads top-to-bottom after a launch completes.
//
// Rows are uniquely identified by data-pool-idx + data-stage attributes
// rather than per-pool container IDs, so marker functions can query each
// row independently regardless of which phase block it lives in.
// Step 5's "pools created" UI is split across the two columns: the result
// summary notification sits under the preview card on the right, while the
// action buttons (Continue to Final Transfer, report preview) live in the
// left column where the primary action sits on every other step. They must
// appear and disappear together, so every show/hide goes through here.
function setLpDoneVisible(visible) {
  document.getElementById('lpDoneInfo')?.classList.toggle('hidden', !visible);
  document.getElementById('lpDoneActions')?.classList.toggle('hidden', !visible);
  // The report preview now lives full-width below the two-column layout
  // (outside #lpDoneActions), so include it here to hide on reset.
  document.getElementById('step5ReportPreview')?.classList.toggle('hidden', !visible);
}

function buildPhaseProgressTree(pools, lockPositions) {
  const tree = document.getElementById('lpProgressTree');

  // Wrap a phase's rows in a collapsible block: clickable header (with
  // toggle chevron + title + "done / total" counter) and a slim progress
  // bar that stay visible, plus a body div — holding the description line
  // and the actual .progress-step rows — that starts collapsed. Keeping
  // the description inside the collapsed body (rather than always-on)
  // keeps the at-a-glance view to just headers + bars, so a multi-pool
  // launch isn't a tall wall of prose and rows before anything happens.
  // Clicking the header expands it; any failure auto-expands via markPoolFailed.
  //
  // total is derived from rowsHtml by counting "progress-step" markers
  // in the string. Stable because the row HTML is built from fixed
  // template literals just above each call to this helper.
  const wrapPhase = (id, title, description, rowsHtml) => {
    const total = (rowsHtml.match(/class="progress-step/g) || []).length;
    return `
      <button class="phase-header" type="button" data-phase-target="${id}-body">
        <span class="phase-toggle">▶</span>
        <span class="phase-title">${title}</span>
        <span class="phase-counter" id="${id}-counter">0 / ${total}</span>
      </button>
      <progress class="phase-bar" id="${id}-bar" value="0" max="${total || 1}"></progress>
      <div class="phase-body collapsed" id="${id}-body">
        <p class="phase-desc">${description}</p>
        ${rowsHtml}
      </div>
    `;
  };

  // Ladder context — same for every pool in the simple-UI flow (ladder
  // is currently a global toggle, not per-pool). Read from simpleConfig
  // rather than threading it through from the caller; the tree is built
  // at click time when the config is current. In customize mode the
  // ladder is always off (no per-pool ladder UI yet).
  const ladderEnabled =
    simpleConfig.mode === 'default' && simpleConfig.ladderEnabled;
  const ladderBandCount = ladderEnabled
    ? Number(simpleConfig.ladderBandCount) || LADDER_DEFAULT_BANDS
    : 0;

  // --- Phase 1: pool creates + main opens + ladder opens + support opens
  const phase1 = document.createElement('div');
  phase1.className = 'progress-pool';
  phase1.id = 'pp-phase1';
  let phase1Rows = '';
  pools.forEach((p, i) => {
    const label = `Pool ${i + 1} (${p.resolvedSymbol || p.quoteToken})`;
    const sliceCount = p.distribution.length;
    // Per-pool ladder band count: in customize mode each pool has its
    // own ladder config; in simple mode the simpleConfig values apply
    // uniformly. The progress tree always uses the per-pool value so
    // it matches what createSinglePool will actually do.
    const poolLadderBandCount = (p.ladderConfig?.mode === 'manual'
      && Array.isArray(p.ladderConfig.bands))
      ? p.ladderConfig.bands.length
      : ladderBandCount;
    // Per-pool support presence: support adds one progress row per
    // pool that has it configured. In simple mode the user's launch-
    // level total SOL is split equally across pools (same pattern as
    // bootstrap) so every pool typically gets a row. In customize
    // mode the user controls support per-pool. Either way, we read
    // each pool's supportConfig and add the row when needed.
    const poolHasSupport = p.supportConfig?.mode === 'custom'
      && Number(p.supportConfig.solValue) > 0;
    phase1Rows += `<div class="progress-step pending" data-pool-idx="${i}" data-stage="pool"><span class="icon">◯</span>${label} — Create pool</div>`;
    for (let s = 0; s < sliceCount; s++) {
      phase1Rows += `<div class="progress-step pending" data-pool-idx="${i}" data-stage="slice-${s}"><span class="icon">◯</span>${label} — Open slice ${s + 1} of ${sliceCount}</div>`;
    }
    // Ladder bands per pool, ordered low-to-high (band 1 = closest to launch)
    for (let b = 0; b < poolLadderBandCount; b++) {
      phase1Rows += `<div class="progress-step pending" data-pool-idx="${i}" data-stage="ladder-${b}"><span class="icon">◯</span>${label} — Open ladder band ${b + 1} of ${poolLadderBandCount}</div>`;
    }
    if (poolHasSupport) {
      phase1Rows += `<div class="progress-step pending" data-pool-idx="${i}" data-stage="support-open"><span class="icon">◯</span>${label} — Open support position</div>`;
    }
  });
  phase1.innerHTML = wrapPhase(
    'pp-phase1',
    'Phase 1 — Open main positions',
    'Pools are created and main positions opened (single-sided in your token). Positions are recoverable by the launch wallet until Phase 3 locks them.',
    phase1Rows,
  );
  tree.appendChild(phase1);

  // SOL-paired pools are processed LAST in Phase 2 (bootstrap opens) and
  // Phase 3 (locks) — see lpService.js for the launch-economics reasoning
  // (we want every flywheel tradable before the SOL pool flips). The
  // frontend phase-tree display must mirror that order so the visual
  // plan matches the actual execution order; otherwise the progress
  // checkmarks would tick on in a different order than the rows
  // appear, which is jarring. Stable sort preserves user-config order
  // within each group (non-SOL pools keep their order, SOL pools go to
  // the end in their original relative order).
  //
  // Phase 1 (main opens) and Phase 4 (fee key transfers) are NOT
  // reordered — the server doesn't reorder them either, so their
  // user-config order already matches execution.
  const isSolPool = (p) => (p.quoteToken || '').toUpperCase() === 'SOL';
  const solLastOrder = pools
    .map((_, idx) => idx)
    .sort((a, b) => Number(isSolPool(pools[a])) - Number(isSolPool(pools[b])));

  // --- Phase 2: bootstrap opens
  const phase2 = document.createElement('div');
  phase2.className = 'progress-pool';
  phase2.id = 'pp-phase2';
  let phase2Rows = '';
  solLastOrder.forEach((i) => {
    const p = pools[i];
    const label = `Pool ${i + 1} (${p.resolvedSymbol || p.quoteToken})`;
    phase2Rows += `<div class="progress-step pending" data-pool-idx="${i}" data-stage="bs-open"><span class="icon">◯</span>${label} — Open bootstrap</div>`;
  });
  phase2.innerHTML = wrapPhase(
    'pp-phase2',
    'Phase 2 — Open bootstrap positions',
    'Each pool becomes tradable as its bootstrap lands. SOL-paired pools are bootstrapped last so every flywheel pool is already tradable when the SOL pool flips — that way the first SOL-paired swap activates the flywheel as designed.',
    phase2Rows,
  );
  tree.appendChild(phase2);

  // --- Phase 3: locks (mains, then ladder bands, then bootstrap — per pool)
  // Skipped entirely when lockPositions=false — there will be no locked
  // positions and so no Phase 3 work; rendering the rows would mislead
  // the user into thinking Phase 3 runs when the orchestrator actually
  // bypasses it.
  if (lockPositions) {
    const phase3 = document.createElement('div');
    phase3.className = 'progress-pool';
    phase3.id = 'pp-phase3';
    let phase3Rows = '';
    solLastOrder.forEach((i) => {
      const p = pools[i];
      const label = `Pool ${i + 1} (${p.resolvedSymbol || p.quoteToken})`;
      const sliceCount = p.distribution.length;
      // Same per-pool ladder count + support detection as Phase 1, so
      // the phase rows are perfectly symmetric and the lock progress
      // matches what got opened.
      const poolLadderBandCount = (p.ladderConfig?.mode === 'manual'
        && Array.isArray(p.ladderConfig.bands))
        ? p.ladderConfig.bands.length
        : ladderBandCount;
      const poolHasSupport = p.supportConfig?.mode === 'custom'
        && Number(p.supportConfig.solValue) > 0;
      for (let s = 0; s < sliceCount; s++) {
        phase3Rows += `<div class="progress-step pending" data-pool-idx="${i}" data-stage="lock-${s}"><span class="icon">◯</span>${label} — Lock slice ${s + 1}</div>`;
      }
      for (let b = 0; b < poolLadderBandCount; b++) {
        phase3Rows += `<div class="progress-step pending" data-pool-idx="${i}" data-stage="ladder-lock-${b}"><span class="icon">◯</span>${label} — Lock ladder band ${b + 1}</div>`;
      }
      if (poolHasSupport) {
        phase3Rows += `<div class="progress-step pending" data-pool-idx="${i}" data-stage="support-lock"><span class="icon">◯</span>${label} — Lock support position</div>`;
      }
      phase3Rows += `<div class="progress-step pending" data-pool-idx="${i}" data-stage="bs-lock"><span class="icon">◯</span>${label} — Lock bootstrap</div>`;
    });
    phase3.innerHTML = wrapPhase(
      'pp-phase3',
      'Phase 3 — Lock positions',
      "Locks burn the position NFTs and mint Fee Key NFTs. After this, the LP'd tokens are committed for life and only fees can be claimed. Failures are retryable in place.",
      phase3Rows,
    );
    tree.appendChild(phase3);

    // --- Phase 4: transfers — only render if at least one slice has a recipient
    const anyRecipient = pools.some((p) =>
      p.distribution.some((d) => d.useExternalRecipient && d.recipient),
    );
    if (anyRecipient) {
      const phase4 = document.createElement('div');
      phase4.className = 'progress-pool';
      phase4.id = 'pp-phase4';
      let phase4Rows = '';
      pools.forEach((p, i) => {
        const label = `Pool ${i + 1} (${p.resolvedSymbol || p.quoteToken})`;
        const sliceCount = p.distribution.length;
        for (let s = 0; s < sliceCount; s++) {
          if (p.distribution[s].useExternalRecipient && p.distribution[s].recipient) {
            phase4Rows += `<div class="progress-step pending" data-pool-idx="${i}" data-stage="xfer-${s}"><span class="icon">◯</span>${label} — Transfer slice ${s + 1} Fee Key to recipient</div>`;
          }
        }
      });
      phase4.innerHTML = wrapPhase(
        'pp-phase4',
        'Phase 4 — Transfer Fee Keys to recipients',
        'Sends the Fee Key NFTs for slices with external recipients to those recipient addresses. Transfer failures are non-blocking — any undelivered Fee Keys sweep back to your destination wallet at the end.',
        phase4Rows,
      );
      tree.appendChild(phase4);
    }
  }

  // Wire click-to-toggle on every phase header we just rendered. Single
  // pass at the end keeps the build linear and lets the helper handle
  // all four phases (plus any future ones) uniformly.
  _wirePhaseHeaders();
}

// Toggle a phase block expanded/collapsed. Idempotent: clicking a
// header on an already-expanded phase collapses it; safe to call from
// auto-expand-on-failure too (calling it when already expanded is a no-op
// via the explicit add/remove pattern).
function _wirePhaseHeaders() {
  const headers = document.querySelectorAll('#lpProgressTree .phase-header');
  headers.forEach((h) => {
    if (h._wired) return;
    h._wired = true;
    h.addEventListener('click', () => {
      const targetId = h.getAttribute('data-phase-target');
      const body = document.getElementById(targetId);
      if (!body) return;
      const isCollapsed = body.classList.contains('collapsed');
      if (isCollapsed) {
        body.classList.remove('collapsed');
        h.classList.add('is-expanded');
      } else {
        body.classList.add('collapsed');
        h.classList.remove('is-expanded');
      }
    });
  });
}

// Force a phase block expanded — used by failure handlers so the user
// can immediately see what failed without having to click. Idempotent.
function _expandPhase(phaseElement) {
  if (!phaseElement) return;
  const header = phaseElement.querySelector('.phase-header');
  const body = phaseElement.querySelector('.phase-body');
  if (header && body) {
    body.classList.remove('collapsed');
    header.classList.add('is-expanded');
  }
}

// Recount a phase's done/failed/total rows and update its header
// counter and progress bar. Called after every row state change so
// the summary stays in sync with the detail. The phaseElement is the
// outer .progress-pool div containing the rows.
function _updatePhaseProgress(phaseElement) {
  if (!phaseElement) return;
  const rows = phaseElement.querySelectorAll('.progress-step');
  const total = rows.length;
  let done = 0;
  let failed = 0;
  rows.forEach((r) => {
    if (r.classList.contains('done')) done += 1;
    else if (r.classList.contains('failed')) failed += 1;
  });
  const completed = done + failed;
  const counter = phaseElement.querySelector('.phase-counter');
  const bar = phaseElement.querySelector('.phase-bar');
  if (counter) {
    counter.textContent = `${completed} / ${total}`;
    counter.classList.toggle('is-done', completed === total && failed === 0 && total > 0);
    counter.classList.toggle('has-failures', failed > 0);
  }
  if (bar) {
    bar.value = completed;
    bar.max = total || 1;
    bar.classList.toggle('is-done', completed === total && failed === 0 && total > 0);
    bar.classList.toggle('has-failures', failed > 0);
  }
}

// One-time note added to the progress tree at the start of LP creation, to
// prevent the user from worrying that nothing is happening. Per-step progress
// tracking would require server-side streaming (SSE/WS) — for now the user
// just sees pending → done at the end. Server console shows the live progress.
function addProgressIntro() {
  const tree = document.getElementById('lpProgressTree');
  const note = document.createElement('div');
  note.className = 'notification is-info is-light is-size-7 py-2 px-3 mb-3';
  note.innerHTML =
    '<i class="fas fa-info-circle"></i>&nbsp;Creating pools and positions can take several minutes. ' +
    'Each step submits a transaction and waits for confirmation. ' +
    'Live progress is logged to the server console. ' +
    'The checkmarks below will populate when the operation completes.';
  tree.appendChild(note);
}

// Mark progress rows for a pool based on what actually completed.
//
// Under the phase-organized tree, each pool's rows are distributed
// across the four phase blocks (pp-phase1..pp-phase4). We find each
// row by its data-pool-idx + data-stage attribute combination, and
// inspect the corresponding piece of state on poolResult to decide
// whether to mark the row done.
//
// Per-position state we look at:
//   - poolResult.poolId               → "Create pool" row
//   - mainPositions[i].nftMint        → "Open slice i" row
//   - mainPositions[i].locked         → "Lock slice i" row
//   - mainPositions[i].transferredTo  → "Transfer slice i to recipient" row
//
// Bootstrap rows for this pool live in pp-phase2 (bs-open) and
// pp-phase3 (bs-lock); markBootstrapDoneForPool handles those.
//
// For full-success results (every state field populated), every row
// for the pool ends up green — matching what the user expects.
// For partial-failure results, rows whose underlying operation didn't
// finish stay in their pending/failed state. The user sees an honest
// picture of what's done vs. what isn't.
function markPoolDone(idx, poolResult) {
  // Pool creation row.
  if (poolResult && poolResult.poolId) {
    const poolRow = document.querySelector(
      `#lpProgressTree [data-pool-idx="${idx}"][data-stage="pool"]`,
    );
    if (poolRow) markRowDone(poolRow);
  }

  // Per-slice rows.
  const mp = Array.isArray(poolResult && poolResult.mainPositions)
    ? poolResult.mainPositions
    : [];
  for (let i = 0; i < mp.length; i++) {
    const pos = mp[i];
    if (pos && pos.nftMint) {
      const openRow = document.querySelector(
        `#lpProgressTree [data-pool-idx="${idx}"][data-stage="slice-${i}"]`,
      );
      if (openRow) markRowDone(openRow);
    }
    if (pos && pos.locked) {
      const lockRow = document.querySelector(
        `#lpProgressTree [data-pool-idx="${idx}"][data-stage="lock-${i}"]`,
      );
      if (lockRow) markRowDone(lockRow);
    }
    if (pos && pos.transferredTo) {
      const xferRow = document.querySelector(
        `#lpProgressTree [data-pool-idx="${idx}"][data-stage="xfer-${i}"]`,
      );
      if (xferRow) markRowDone(xferRow);
    }
  }

  // Per-ladder-band rows. Ladder bands have open and lock rows; no
  // transfer rows because ladder Fee Keys always sweep with the launch
  // wallet, never to external recipients.
  const lp = Array.isArray(poolResult && poolResult.ladderPositions)
    ? poolResult.ladderPositions
    : [];
  for (let b = 0; b < lp.length; b++) {
    const pos = lp[b];
    if (pos && pos.nftMint) {
      const openRow = document.querySelector(
        `#lpProgressTree [data-pool-idx="${idx}"][data-stage="ladder-${b}"]`,
      );
      if (openRow) markRowDone(openRow);
    }
    if (pos && pos.locked) {
      const lockRow = document.querySelector(
        `#lpProgressTree [data-pool-idx="${idx}"][data-stage="ladder-lock-${b}"]`,
      );
      if (lockRow) markRowDone(lockRow);
    }
  }

  // Support position rows. Same shape as ladder bands but currently
  // capped at one support per pool, so the progress tree only has one
  // "support-open" and one "support-lock" row per pool. If a pool
  // has multiple support positions in the future, this would need
  // per-index data-stage attributes ("support-open-0" etc) like ladder
  // — for now the one-position case keeps the row IDs simpler.
  const sp = Array.isArray(poolResult && poolResult.supportPositions)
    ? poolResult.supportPositions
    : [];
  // We mark the row done as soon as ANY support position has the field
  // populated. With more than one support position this would mismark,
  // but the current data model has 0 or 1. The defensive `.some` form
  // makes adding multi-band support later just a matter of extending
  // the row builder; this check would still flip when the first one
  // lands.
  if (sp.some((pos) => pos && pos.nftMint)) {
    const openRow = document.querySelector(
      `#lpProgressTree [data-pool-idx="${idx}"][data-stage="support-open"]`,
    );
    if (openRow) markRowDone(openRow);
  }
  if (sp.some((pos) => pos && pos.locked)) {
    const lockRow = document.querySelector(
      `#lpProgressTree [data-pool-idx="${idx}"][data-stage="support-lock"]`,
    );
    if (lockRow) markRowDone(lockRow);
  }
}

// Helper: flip a single row from pending/running to done.
function markRowDone(row) {
  row.classList.remove('pending', 'running');
  row.classList.add('done');
  const icon = row.querySelector('.icon');
  if (icon) icon.textContent = '✓';
  // Bubble up the row's state change to its phase block so the header
  // counter and progress bar reflect the new completion count.
  _updatePhaseProgress(row.closest('.progress-pool'));
}

// Mark a specific row as failed. Same visual treatment as the pending-row
// branch in markPoolFailed (red ✗, tooltip, header counter update, phase
// auto-expanded) but targets a known row rather than "first pending in
// this pool". Used by the live progress poll to flip individual rows red
// as Phase 3/4 per-position failures arrive — where one position can
// fail while sibling positions in the same pool keep succeeding, so the
// first-pending heuristic would be wrong.
function markRowFailed(row, err) {
  if (!row) return;
  row.classList.remove('pending', 'running', 'done');
  row.classList.add('failed');
  const icon = row.querySelector('.icon');
  if (icon) icon.textContent = '✗';
  if (err) row.title = err;
  const phase = row.closest('.progress-pool');
  _updatePhaseProgress(phase);
  _expandPhase(phase);
}

function markPoolFailed(idx, err) {
  // Find the first pending row for this pool. Under the phase-organized
  // tree, that's the first row anywhere in lpProgressTree with the
  // matching data-pool-idx that hasn't transitioned to done yet. The
  // first such row is by definition the operation that failed (the
  // orchestrator's sequential execution means failures stop progress
  // at that point).
  const pending = document.querySelector(
    `#lpProgressTree [data-pool-idx="${idx}"].pending`,
  );
  if (pending) {
    pending.classList.remove('pending');
    pending.classList.add('failed');
    const icon = pending.querySelector('.icon');
    if (icon) icon.textContent = '✗';
    pending.title = err;
    // Update the phase header's counter + bar AND auto-expand the
    // containing phase so the user can see what failed without having
    // to click. Failure rows are uncommon, so auto-expanding here is
    // less noisy than leaving the user to hunt through collapsed
    // phases for the red row.
    const phase = pending.closest('.progress-pool');
    _updatePhaseProgress(phase);
    _expandPhase(phase);
  }
}

// Mark all bootstrap rows as done. Called after the orchestrator returns
// full success — phase 2 (bs-open) and phase 3 (bs-lock) are both
// completed by definition, so every bootstrap row transitions to ✓.
//
// Under the phase-organized tree, bootstrap rows live in pp-phase2 (for
// bs-open) and pp-phase3 (for bs-lock). We select by stage attribute so
// the lookup is independent of which phase block hosts the rows.
function markAllBootstrapsDone() {
  document.querySelectorAll(
    '#lpProgressTree [data-stage="bs-open"], #lpProgressTree [data-stage="bs-lock"]',
  ).forEach((row) => markRowDone(row));
}

// Mark a specific pool's bootstrap rows based on actual state. Each pool
// has up to TWO bootstrap rows (bs-open in phase 2, bs-lock in phase 3);
// under the deferred-lock model, the open happens in Phase 2 and the lock
// in Phase 3, so a pool's bootstrap can be open-but-not-locked between
// those phases.
//
// Callers may pass a bootstrap result object via the second arg; if
// omitted, we default to "everything done" (the historical behavior used
// from the success path). Partial-failure callers should pass the actual
// bootstrap result to get accurate per-row marking.
function markBootstrapDoneForPool(allocationIndex, bootstrapResult) {
  const rows = document.querySelectorAll(
    `#lpProgressTree [data-pool-idx="${allocationIndex}"][data-stage^="bs-"]`,
  );
  rows.forEach((row) => {
    const stage = row.dataset.stage;
    if (!bootstrapResult) {
      markRowDone(row);
      return;
    }
    if (stage === 'bs-open' && bootstrapResult.nftMint) {
      markRowDone(row);
    } else if (stage === 'bs-lock' && bootstrapResult.locked) {
      markRowDone(row);
    }
  });
}

// Mark a specific pool's bootstrap rows as failed. Each pool has up to
// TWO bootstrap rows; we mark every pending one as failed because the
// bootstrap step is atomic from the user's perspective. If we only
// marked the first match, the bs-lock row would stay pending even
// though the work is unreachable until the open succeeds.
function markBootstrapFailedForPool(allocationIndex, err) {
  const rows = document.querySelectorAll(
    `#lpProgressTree [data-pool-idx="${allocationIndex}"][data-stage^="bs-"].pending`,
  );
  const phasesToUpdate = new Set();
  rows.forEach((row) => {
    row.classList.remove('pending');
    row.classList.add('failed');
    const icon = row.querySelector('.icon');
    if (icon) icon.textContent = '✗';
    row.title = err;
    const phase = row.closest('.progress-pool');
    if (phase) phasesToUpdate.add(phase);
  });
  // Update header counter + auto-expand for every phase touched. The
  // bs-open and bs-lock rows live in Phase 2 and Phase 3 respectively,
  // so this typically updates both phase headers in one fail path.
  phasesToUpdate.forEach((phase) => {
    _updatePhaseProgress(phase);
    _expandPhase(phase);
  });
}

function buildLpDoneSummary(results) {
  // Build the success summary shown after all pools land. Note we escape
  // quoteSymbol — for known quotes (SOL/USDC/etc) it's hard-coded safe,
  // but for user-supplied custom mints the symbol may have been read from
  // on-chain metadata or an indexer, which could contain anything. Better
  // to be paranoid than to allow a malicious token symbol to inject
  // markup into our success banner.
  //
  // Defensive on every field: mainPositions should always be populated
  // on the success path (orchestrator guarantees it), but if the result
  // shape ever changes or a partial result somehow lands here, we
  // shouldn't throw inside an HTML-building function and leave the
  // summary blank. A missing field renders as "0 main slices" — visibly
  // odd but doesn't break the page.
  let s = '';
  for (const r of results) {
    const sym = escapeHtml(r.quoteSymbol || '');
    const idShort = escapeHtml(r.poolId?.slice(0, 8) || '');
    const slices = Array.isArray(r.mainPositions) ? r.mainPositions : [];
    const ladder = Array.isArray(r.ladderPositions) ? r.ladderPositions : [];
    s += `<strong>${sym}</strong> pool: ${idShort}…, `;
    s += `${slices.length} main slice${slices.length === 1 ? '' : 's'}`;
    if (ladder.length > 0) {
      s += `, ${ladder.length} ladder band${ladder.length === 1 ? '' : 's'}`;
    }
    const ext = slices.filter((p) => p.transferredTo).length;
    if (ext > 0) s += ` (${ext} sent to external wallets)`;
    s += '<br>';
  }
  return s;
}

bind('continueToTransferBtn', 'click', () => {
  setStepSummary(5, `${lpResult.results.length} pool${lpResult.results.length === 1 ? '' : 's'} created`);
  prefillDestinationFromFunder();
  activateStep(6);
});

bind('continueToTransferAfterFailBtn', 'click', () => {
  setStepSummary(5, `partial — proceed to refund`);
  prefillDestinationFromFunder();
  activateStep(6);
});

bind('retryBootstrapsBtn', 'click', async () => {
  const btn = document.getElementById('retryBootstrapsBtn');
  const lockPositions = btn.dataset.lockPositions === 'true';
  const priorResults = lpResult?.results || [];

  if (!createdTokenInfo) {
    log('Token info missing — cannot resume launch.', 'danger');
    return;
  }

  await withRunState(async () => {
    setLoading(btn, true);
    markLaunchActiveForRpcHealth(true);
    try {
      log(`Resuming launch (${priorResults.length} pool${priorResults.length === 1 ? '' : 's'} carried over)…`);
      // Hide the fail banner while the resume runs so the user sees a
      // clean "in progress" state rather than the stale failure copy.
      document.getElementById('lpFailInfo').classList.add('hidden');

      // Reset any failed rows back to pending so progress is reflected.
      // We don't know exactly which rows will run this attempt (depends
      // on what got done last time), so we reset everything that's
      // currently marked failed.
      document.querySelectorAll('#lpProgressTree .progress-step.failed')
        .forEach((row) => {
          row.classList.remove('failed');
          row.classList.add('pending');
          const icon = row.querySelector('.icon');
          if (icon) icon.textContent = '◯';
          row.title = '';
        });

      const allocations = buildAllocationsForApi();
      const targetMc = parseNumberInput(document.getElementById('targetMarketCap'));
      const resp = await fetch('/api/resume-launch', {
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
          tokenTotalSupply: createdTokenInfo.totalSupply,
          targetMarketCapUsd: targetMc,
          allocations,
          lockPositions,
          priorResults,
        }),
      });
      let data;
      try {
        data = await resp.json();
      } catch (parseErr) {
        if (!resp.ok) {
          throw new Error(
            `Server returned HTTP ${resp.status} with non-JSON body. ` +
            `Check the server console for details.`,
          );
        }
        throw new Error(`Unexpected response: ${parseErr.message}`);
      }

      if (resp.status === 409 && data.code === 'OP_IN_FLIGHT') {
        // Another launch operation (likely the original create-lp, or a
        // previous resume click) is still running for this wallet. The
        // resume was rejected to prevent two orchestrators racing over
        // the same positions. Reattach the progress poll and wait.
        log(data.error, 'warning');
        log(
          'Reattached to the running operation — wait for it to finish ' +
          'before resuming. Do not close the app.',
          'warning',
        );
        if (tempWallet && tempWallet.publicKey) {
          startLpProgressPoll(tempWallet.publicKey);
        }
        return;
      }

      if (data.success) {
        // Full success — every pool now has main positions + bootstrap.
        // Replace lpResult with the canonical full result so downstream
        // flows (transfer) see the up-to-date state.
        lpResult = data;
        data.results.forEach((r) => {
          markPoolDone(r.allocationIndex, r);
          markBootstrapDoneForPool(r.allocationIndex, r.bootstrap);
        });
        log(`All ${data.results.length} pool(s) created and bootstrapped`, 'success');
        setLpDoneVisible(true);
        document.getElementById('lpDoneSummary').innerHTML = buildLpDoneSummary(data.results);
        renderLaunchReportPreview('step5');
        markLaunchActiveForRpcHealth(false);
        return;
      }

      if (data.manualRecoveryRequired || data.code === 'UNSAFE_PARTIAL_POOL_STATE') {
        lpResult = { results: data.partialResults || [] };
        (data.partialResults || []).forEach((r) => {
          markPoolDone(r.allocationIndex, r);
          if (r.bootstrap) markBootstrapDoneForPool(r.allocationIndex, r.bootstrap);
        });
        (data.unsafePoolEvents || []).forEach((event) => {
          if (event.allocationIndex != null) {
            markPoolFailed(event.allocationIndex, data.error);
          }
        });

        document.getElementById('lpFailInfo').classList.remove('hidden');
        document.getElementById('lpFailHeading').textContent =
          'Automatic resume is unavailable.';
        document.getElementById('lpFailSummary').textContent = data.error;

        const lpFailCtr = document.getElementById('lpFailInfo').querySelector('.notification');
        if (lpFailCtr) {
          const prevB = lpFailCtr.querySelector('.error-banner');
          if (prevB) prevB.remove();
          renderStructuredError(lpFailCtr, data.error, categorizeError(data.error));
        }

        const successCount = (data.partialResults || []).length;
        const totalCount = allocations.length;
        document.getElementById('lpFailSucceededCount').innerHTML =
          `<strong>${successCount}</strong> of ${totalCount} pool${totalCount === 1 ? '' : 's'} ` +
          `have completed LP results in the journal. A later pool was created before its ` +
          `completed position state was recorded, so retrying automatically could duplicate work.`;
        document.getElementById('lpFailReassurance').innerHTML =
          `<strong>Your assets are still recoverable by the launch wallet.</strong> ` +
          `Use the sweep/recovery path to move remaining SOL, quote tokens, and LP NFTs back to ` +
          `your destination wallet, then handle any already-created positions manually in Raydium.`;
        document.getElementById('continueToTransferAfterFailBtnLabel').textContent =
          'Skip to Transfer Assets';
        btn.classList.add('hidden');
        markLaunchActiveForRpcHealth(false);
        return;
      }

      // Partial: at least one allocation still couldn't be completed.
      // The data has the same shape as a fresh create-lp failure:
      // partialResults, failedAllocationIndex, failedPhase, bootstrapFailures.
      // Update our lpResult so the next retry sees the latest state.
      lpResult = { results: data.partialResults || [] };
      const newPhase = data.failedPhase || 'main_positions';
      log(
        `Resume: ${(data.partialResults || []).length} pool(s) done, ` +
        `still failing (phase: ${newPhase}): ${data.error}`,
        'warning',
      );

      // Repaint progress tree to reflect new state. Mark every entry in
      // partialResults as done (both main and bootstrap rows depending
      // on what's populated), and mark the still-failing ones.
      (data.partialResults || []).forEach((r) => {
        markPoolDone(r.allocationIndex, r);
        if (r.bootstrap) markBootstrapDoneForPool(r.allocationIndex, r.bootstrap);
      });
      if (newPhase === 'bootstrap') {
        const failures = data.bootstrapFailures
          || (data.failedAllocationIndex != null
            ? [{ allocationIndex: data.failedAllocationIndex, error: data.error }]
            : []);
        for (const f of failures) {
          markBootstrapFailedForPool(f.allocationIndex, f.error);
        }
      } else if (newPhase === 'locks' || newPhase === 'transfers') {
        // Lock/transfer phase failures don't map to a single failing
        // allocation row — the failures are per-position and don't
        // belong on the pool-level progress markers. We've already
        // marked pools and bootstraps as done above; the per-position
        // detail lives in data.lockFailures / data.transferFailures
        // and gets surfaced via the lpFailInfo banner below.
      } else if (data.failedAllocationIndex != null) {
        markPoolFailed(data.failedAllocationIndex, data.error);
      }

      // Re-show the fail banner with updated counts so the user can
      // either retry again or give up via sweep. Heading + reassurance
      // copy mirrors the initial-failure branches so the UX stays
      // consistent whether the user is on attempt 1 or attempt N.
      document.getElementById('lpFailInfo').classList.remove('hidden');
      let resumeHeading;
      if (newPhase === 'bootstrap') {
        resumeHeading = 'Bootstraps still failing.';
      } else if (newPhase === 'locks') {
        resumeHeading = 'Some position locks still failing.';
      } else if (newPhase === 'transfers') {
        resumeHeading = 'Some Fee Key transfers still failing.';
      } else {
        resumeHeading = 'Pool creation still failing.';
      }
      document.getElementById('lpFailHeading').textContent = resumeHeading;
      document.getElementById('lpFailSummary').textContent = data.error;

      // Render structured error with category badge + "What happened?"
      const lpFailCtr = document.getElementById('lpFailInfo').querySelector('.notification');
      if (lpFailCtr) {
        const prevB = lpFailCtr.querySelector('.error-banner');
        if (prevB) prevB.remove();
        renderStructuredError(lpFailCtr, data.error, categorizeError(data.error));
      }

      const successCount = (data.partialResults || []).length;
      const totalCount = allocations.length;
      document.getElementById('lpFailSucceededCount').innerHTML =
        `<strong>${successCount}</strong> of ${totalCount} pool${totalCount === 1 ? '' : 's'} ` +
        `completed; the rest are still failing. Click <strong>${newPhase === 'bootstrap' ? 'Retry bootstraps' : 'Resume launch'}</strong> ` +
        `to try again, or sweep the wallet to start over.`;
      // Resume button stays visible for another attempt. Update its
      // label too — a retry can shift phases (e.g. main-positions
      // failure resolves but uncovers a bootstrap-only failure), and
      // the button label should reflect that. For locks/transfers we
      // keep the generic "Resume launch" label since those don't have
      // a dedicated retry verb.
      const retryLabel = btn.querySelector('span:last-child');
      if (retryLabel) {
        retryLabel.textContent = newPhase === 'bootstrap'
          ? 'Retry bootstraps'
          : 'Resume launch';
      }
      // Phase-specific reassurance copy (mirrors the initial-failure
      // path's branches so retry messaging stays consistent).
      if (newPhase === 'bootstrap') {
        document.getElementById('lpFailReassurance').innerHTML =
          `<strong>Main positions are in place for every pool.</strong> Only the bootstrap ` +
          `leg failed for the pools listed above — these pools won't be tradable at the ` +
          `intended price until their bootstraps land. Click <strong>Retry bootstraps</strong> ` +
          `to try again (most bootstrap failures are transient RPC issues). If retrying ` +
          `keeps failing, sweep the wallet to your destination and manually add bootstrap ` +
          `liquidity in the Raydium UI later.`;
        document.getElementById('continueToTransferAfterFailBtnLabel').textContent =
          'Or sweep to destination instead';
      } else if (newPhase === 'locks') {
        document.getElementById('lpFailReassurance').innerHTML =
          `<strong>Every pool is open and tradable.</strong> The missing step is the lock — ` +
          `until locks finish, the LP'd tokens are still recoverable by the launch wallet. ` +
          `Click <strong>Resume launch</strong> to try the remaining locks again. If locks ` +
          `keep failing and you'd rather walk away, sweep the wallet to your destination — ` +
          `the open positions get closed and their LP tokens come back with the sweep.`;
        document.getElementById('continueToTransferAfterFailBtnLabel').textContent =
          'Or sweep to destination instead';
      } else if (newPhase === 'transfers') {
        document.getElementById('lpFailReassurance').innerHTML =
          `<strong>The launch itself succeeded.</strong> Every pool is created, tradable, and ` +
          `locked. The only thing that didn't finish was the delivery of Fee Key NFTs to ` +
          `recipient addresses. Those NFTs are in your launch wallet and will sweep to your ` +
          `destination wallet, so nothing is lost. You can manually send them to the intended ` +
          `recipients afterward, or click <strong>Resume launch</strong> to try the deliveries ` +
          `again.`;
        document.getElementById('continueToTransferAfterFailBtnLabel').textContent =
          'Skip to Transfer Assets';
      } else {
        document.getElementById('lpFailReassurance').innerHTML =
          `<strong>Your assets are safe</strong> — they're still in the ephemeral wallet ` +
          `(SOL, any auto-swapped quote tokens, and the LP NFTs from pools that did succeed). ` +
          `Click <strong>Resume launch</strong> to continue only if Trebuchet has enough ` +
          `journaled state to skip completed pools safely. If the journal shows a pool was ` +
          `created before a completed LP result was recorded, automatic resume will stop and ` +
          `you should sweep the wallet or recover the existing LP positions manually.`;
        document.getElementById('continueToTransferAfterFailBtnLabel').textContent =
          'Skip to Transfer Assets';
      }
    } catch (e) {
      log(`Resume failed: ${e.message}`, 'danger');
      markLaunchActiveForRpcHealth(false);
      // Show the fail banner again so the user can see what to do next.
      document.getElementById('lpFailInfo').classList.remove('hidden');
    } finally {
      setLoading(btn, false);
    }
  });
});

// Pre-fill the Step 6 destination input with the detected funding wallet,
// IF the user hasn't already typed something there. This is a convenience —
// the user still has to click through the confirmation modal that displays
// the full address before any transfer actually runs.
function prefillDestinationFromFunder() {
  const dest = document.getElementById('destinationWallet');
  if (!dest) return;
  if (!dest.value && fundingWallet) {
    dest.value = fundingWallet;
    log(`Pre-filled destination with detected funder. Verify before transferring.`, 'warning');
  }
}


// Vanity CA grind — pre-grinds the token mint address before token creation
let vanityCAKeypairs = []; // [{ publicKey, secretKey, rarity, epochs, attempts, target, prefix, suffix, mode }]
let selectedVanityCA = null; // index into vanityCAKeypairs

// ---- Vanity CA epoch tiers (authoritative from C binary) ----
// Rarity colors: Common=blue, Rare=green, Legendary=orange, Mythic=purple
const VANITY_TIERS = [
  { name: 'Common',    max: 1, color: '#3e8ed0' },
  { name: 'Rare',      max: 2, color: '#48c774' },
  { name: 'Legendary', max: 3, color: '#f4a236' },
  { name: 'Mythic',    max: Infinity, color: '#9b59b6' },
];

// Get the tier index for a given epoch value
function tierForEpoch(epoch) {
  for (let i = 0; i < VANITY_TIERS.length; i++) {
    if (epoch <= VANITY_TIERS[i].max) return i;
  }
  return VANITY_TIERS.length - 1;
}

// Reset the single progress bar for a new grind
function setupGrindBar() {
  const bar = document.getElementById('vanityCAProgressBar');
  const label = document.getElementById('vanityCAProgressText');
  if (bar) {
    bar.style.width = '0%';
    bar.style.background = '#e0d6c2';
  }
  if (label) label.textContent = 'Grinding...';
}

// Update the single progress bar with epoch data
function updateGrindBar(epoch, attempts) {
  const bar = document.getElementById('vanityCAProgressBar');
  const label = document.getElementById('vanityCAProgressText');
  if (!bar || !label) return;

  const tierIdx = tierForEpoch(epoch);
  const tier = VANITY_TIERS[tierIdx];
  const prevMax = tierIdx === 0 ? 0 : VANITY_TIERS[tierIdx - 1].max;
  const tierPct = Math.min(100, ((epoch - prevMax) / (tier.max - prevMax)) * 100);
  const colors = VANITY_TIERS.map(t => t.color);

  // Bar width = current tier progress (0-100% within the tier)
  bar.style.width = tierPct + '%';

  // Background: completed tiers shown as gradient, current tier solid
  if (tierIdx === 0) {
    bar.style.background = colors[0];
  } else {
    // Completed tiers each get a fixed portion of the bar's background
    let gradient = 'linear-gradient(to right';
    const segPct = 20; // each completed tier takes 20% of the current bar
    for (let i = 0; i < tierIdx; i++) {
      const start = i * segPct;
      const end = (i + 1) * segPct;
      gradient += ', ' + colors[i] + ' ' + start + '%, ' + colors[i] + ' ' + end + '%';
    }
    gradient += ', ' + colors[tierIdx] + ' ' + (tierIdx * segPct) + '%, ' + colors[tierIdx] + ' 100%';
    gradient += ')';
    bar.style.background = gradient;
  }

  label.textContent = tier.name + ' · Epoch ' + epoch.toFixed(2) + ' · ' + attempts.toLocaleString() + ' attempts';
}

// ---- Live key display below the grind bar ----
// Shows the most recent tested key when it has prefix/suffix matches.
// Match chars are colored by rarity tier: blue(1) green(2) orange(3) purple(4+)
const MATCH_COLORS = [
  null,          // 0 matches — not shown
  '#3e8ed0',     // 1-char: Common blue
  '#48c774',     // 2-char: Rare green
  '#f4a236',     // 3-char: Legendary orange
  '#9b59b6',     // 4-char: Mythic purple
  '#9b59b6',     // 5+
  '#9b59b6',     // 6+
  '#9b59b6',     // 7+
  '#9b59b6',     // 8+
  '#9b59b6',     // 9+
  '#9b59b6',     // 10+
];

let _keyDisplayTarget = '';
let _lastKeyShown = '';

function vanityCandidateTargetLabel(candidate) {
  const prefix = candidate.prefix || (candidate.mode === 'prefix' ? candidate.target : null);
  const suffix = candidate.suffix || (candidate.mode === 'suffix' ? candidate.target : null);
  if (prefix && suffix) return `starts ${prefix} / ends ${suffix}`;
  if (prefix) return `starts ${prefix}`;
  if (suffix) return `ends ${suffix}`;
  if (candidate.target) return candidate.target;
  return candidate.rarity || '';
}

function isVanityBothMode(mode) {
  return mode === 'both';
}

function applyVanityModeUi() {
  const mode = document.getElementById('vanityCAMode')?.value || 'suffix';
  const target = document.getElementById('vanityCATarget');
  const endControl = document.getElementById('vanityCAEndControl');
  const endTarget = document.getElementById('vanityCAEndTarget');
  const btn = document.getElementById('grindCABtn');
  const isBoth = isVanityBothMode(mode);
  const isIdle = !btn || (btn.dataset.mode || 'grind') === 'grind';
  if (target) {
    target.disabled = !isIdle;
    target.placeholder = isBoth ? 'start' : 'e.g. RATi';
  }
  if (endControl) {
    endControl.classList.toggle('hidden', !isBoth);
  }
  if (endTarget) {
    endTarget.disabled = !isBoth || !isIdle;
    endTarget.placeholder = 'end';
  }
}

function countMatchChars(key, target) {
  // Count how many distinct chars of target appear anywhere in key.
  if (!target || !key) return 0;
  const keySet = new Set(key);
  let n = 0;
  for (const ch of target) {
    if (keySet.has(ch)) n++;
  }
  return n;
}

function updateKeyDisplay(key, target) {
  if (!key || key === _lastKeyShown) return;
  const matchCount = countMatchChars(key, target);
  if (matchCount === 0) return;
  _lastKeyShown = key;

  const el = document.getElementById('vanityCAKeyDisplay');
  if (!el || el.offsetParent === null) return;

  const targetSet = new Set(target);
  const color = MATCH_COLORS[Math.min(matchCount, MATCH_COLORS.length - 1)];
  let html = '<span class="is-family-monospace is-size-7" style="line-height:1.3;">';
  for (let i = 0; i < key.length; i++) {
    const isMatch = targetSet.has(key[i]);
    if (isMatch) {
      html += '<span class="vanity-char-match" style="color:' + color + ';display:inline-block;animation:vanityCharPop 0.3s ease-out;">' + key[i] + '</span>';
    } else {
      html += '<span style="color:#666">' + key[i] + '</span>';
    }
  }
  html += '</span>';
  el.innerHTML = html;
}

function setupKeyDisplay(target) {
  _keyDisplayTarget = target;
  _lastKeyShown = '';

  let container = document.getElementById('vanityCAKeyDisplay');
  if (!container) {
    container = document.createElement('div');
    container.id = 'vanityCAKeyDisplay';
    container.style.cssText = 'text-align:center;padding:6px 4px 2px;overflow:hidden;';
    const progressEl = document.getElementById('vanityCAProgress');
    if (progressEl) {
      const textEl = document.getElementById('vanityCAProgressText');
      if (textEl) textEl.parentNode.insertBefore(container, textEl);
      else progressEl.appendChild(container);
    }
  }
  container.innerHTML = '<span class="is-family-monospace is-size-7" style="color:#555;">waiting for matches…</span>';
}

function removeKeyDisplay() {
  const container = document.getElementById('vanityCAKeyDisplay');
  if (container) container.remove();
}

// Centralized state machine for the Grind/Cancel button. Three states
// driven by the data-mode attribute, so all transitions go through one
// place. Production code never reads data-mode externally — it's purely
// an internal flag the click handler reads to decide what to do.
function setGrindButtonState(state) {
  const btn = document.getElementById('grindCABtn');
  if (!btn) return;
  const icon = btn.querySelector('i');
  const label = btn.querySelector('span:last-child');
  const target = document.getElementById('vanityCATarget');
  const endTarget = document.getElementById('vanityCAEndTarget');
  const mode = document.getElementById('vanityCAMode');

  if (state === 'grind') {
    btn.dataset.mode = 'grind';
    btn.disabled = false;
    btn.classList.remove('is-danger', 'is-loading');
    btn.classList.add('is-primary');
    if (icon) icon.className = 'fas fa-star';
    if (label) label.textContent = 'Grind';
    if (target) target.disabled = false;
    if (endTarget) endTarget.disabled = !isVanityBothMode(mode?.value || 'suffix');
    if (mode) mode.disabled = false;
  } else if (state === 'cancel') {
    btn.dataset.mode = 'cancel';
    btn.disabled = false;
    btn.classList.remove('is-primary', 'is-loading');
    btn.classList.add('is-danger');
    if (icon) icon.className = 'fas fa-times';
    if (label) label.textContent = 'Cancel';
    // Lock the inputs while grinding — the prefix/suffix and mode
    // dropdown contribute to the grind that's already underway;
    // letting the user edit them mid-grind would create a confusing
    // mismatch between the visible target and what's actually being
    // ground.
    if (target) target.disabled = true;
    if (endTarget) endTarget.disabled = true;
    if (mode) mode.disabled = true;
  } else if (state === 'cancelling') {
    btn.dataset.mode = 'cancelling';
    btn.disabled = true;
    btn.classList.remove('is-primary');
    btn.classList.add('is-danger', 'is-loading');
    if (label) label.textContent = 'Cancelling...';
    if (target) target.disabled = true;
    if (endTarget) endTarget.disabled = true;
    if (mode) mode.disabled = true;
  }
  if (state === 'grind') applyVanityModeUi();
}

bind('vanityCAMode', 'change', applyVanityModeUi);
applyVanityModeUi();

function getVanityRequestFromInputs() {
  const mode = document.getElementById('vanityCAMode')?.value || 'suffix';
  const startTarget = document.getElementById('vanityCATarget')?.value.trim() || '';
  const endTarget = document.getElementById('vanityCAEndTarget')?.value.trim() || '';
  if (mode === 'both') {
    return {
      mode,
      prefix: startTarget,
      suffix: endTarget,
      target: startTarget && endTarget ? `${startTarget}...${endTarget}` : '',
      highlightTarget: `${startTarget}${endTarget}`,
    };
  }
  if (mode === 'prefix') {
    return {
      mode,
      prefix: startTarget,
      suffix: '',
      target: startTarget,
      highlightTarget: startTarget,
    };
  }
  return {
    mode,
    prefix: '',
    suffix: startTarget,
    target: startTarget,
    highlightTarget: startTarget,
  };
}

bind('grindCABtn', 'click', async () => {
  const btn = document.getElementById('grindCABtn');
  const currentMode = btn.dataset.mode || 'grind';

  // CANCEL branch: button is showing "Cancel" because a grind is in
  // flight. POST to the cancel endpoint and transition into the
  // "Cancelling..." state. The actual UI cleanup happens when the SSE
  // stream emits {type:'cancelled'} — which fires once the child
  // process actually finishes terminating (usually a few ms).
  if (currentMode === 'cancel') {
    setGrindButtonState('cancelling');
    try {
      const resp = await fetch('/api/cancel-vanity-grind', { method: 'POST' });
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${resp.status}`);
      }
    } catch (e) {
      // Cancel request failed (network error, server gone, etc.). Don't
      // leave the user stuck in "Cancelling..." forever — restore the
      // button. If the grind is still actually running we'll see its
      // events come through the SSE stream and handle them normally.
      log('Cancel request failed: ' + e.message, 'warn');
      setGrindButtonState('cancel');
    }
    return;
  }

  // GRIND branch: standard new-grind flow.
  const vanityRequest = getVanityRequestFromInputs();
  if (vanityRequest.mode === 'both' && (!vanityRequest.prefix || !vanityRequest.suffix)) {
    log('Enter both start and end vanity targets.', 'warn');
    return;
  }
  if (!vanityRequest.prefix && !vanityRequest.suffix) {
    log('Enter a vanity target first.', 'warn');
    return;
  }

  await withRunState(async () => {
    setGrindButtonState('cancel');
    try {
      // Show single active progress bar
      const progressEl = document.getElementById('vanityCAProgress');
      if (progressEl) progressEl.classList.remove('hidden');

      // Ensure original bar is visible, remove any old epoch bars
      const barContainer = progressEl?.querySelector('.vanity-progress-bar');
      if (barContainer) barContainer.style.display = '';
      const oldEpochBars = document.getElementById('vanityCAEpochBars');
      if (oldEpochBars) oldEpochBars.remove();
      setupGrindBar();
      setupKeyDisplay(vanityRequest.highlightTarget);

      const params = new URLSearchParams();
      if (vanityRequest.prefix) params.set('prefix', vanityRequest.prefix);
      if (vanityRequest.suffix) params.set('suffix', vanityRequest.suffix);
      // Pass the session token as a query param — EventSource can't set
      // custom headers, so the SSE endpoint validates it inline.
      try {
        const sessionToken = await window.getApiSessionToken();
        if (sessionToken) params.set('token', sessionToken);
      } catch (_) { /* proceed without token; server will reject if required */ }
      const es = new EventSource('/api/generate-vanity-wallet-stream?' + params.toString());

      es.onerror = () => { es.close(); };

      await new Promise((resolve, reject) => {
        es.addEventListener('message', (e) => {
          let data;
          try { data = JSON.parse(e.data); } catch { return; }
          if (data.type === 'start') {
            // Metadata received
          } else if (data.type === 'progress') {
            updateGrindBar(data.epoch, data.attempts);
            if (data.key) updateKeyDisplay(data.key, _keyDisplayTarget);
          } else if (data.type === 'done') {
            es.close();
            removeKeyDisplay();
            const entry = {
              publicKey: data.wallet.publicKey,
              secretKey: data.wallet.secretKey,
              rarity: data.wallet.rarity,
              epochs: data.wallet.epochs,
              attempts: data.wallet.attempts,
              seed: data.wallet.seed,
              target: data.wallet.target || vanityRequest.target,
              prefix: data.wallet.prefix || vanityRequest.prefix || null,
              suffix: data.wallet.suffix || vanityRequest.suffix || null,
              mode: data.wallet.mode || vanityRequest.mode,
              persisted: data.wallet.persisted === true,
            };
            // Keep prior grinds as candidates and auto-select the new
            // one. The launch flow reads selectedVanityCA at submit time,
            // so the newest successful grind still wins by default while
            // earlier CAs remain one click away.
            addVanityCAEntry(entry);
            if (progressEl) progressEl.classList.add('hidden');
            renderVanityCAList();
            log('Vanity CA: ' + data.wallet.publicKey + ' (' + data.wallet.rarity + ', ' + data.wallet.attempts.toLocaleString() + ' attempts)', 'success');
            resolve();
          } else if (data.type === 'cancelled') {
            // User clicked Cancel and the server confirmed the grind
            // was terminated. Treat as a clean stop — no error log,
            // just unwind the UI back to its idle state. The catch
            // block below resolves on its own without throwing for
            // this case because we resolve() here.
            es.close();
            removeKeyDisplay();
            if (progressEl) progressEl.classList.add('hidden');
            const epochBars = document.getElementById('vanityCAEpochBars');
            if (epochBars) epochBars.remove();
            log('Vanity grind cancelled.', 'info');
            resolve();
          } else if (data.type === 'error') {
            es.close();
            reject(new Error(data.error));
          }
        });
        es.addEventListener('error', () => {
          es.close();
          reject(new Error('SSE connection failed'));
        });
      });
    } catch (e) {
      log('Vanity CA grind failed: ' + e.message, 'danger');
      removeKeyDisplay();
      document.getElementById('vanityCAProgress')?.classList.add('hidden');
      // Clean up any extra elements
      const epochBars = document.getElementById('vanityCAEpochBars');
      if (epochBars) epochBars.remove();
    } finally {
      setGrindButtonState('grind');
      // Re-render after every exit path so the selected CA and candidate
      // list stay in sync after success, cancellation, or failure.
      renderVanityCAList();
    }
  });
});

// Discard only the selected vanity CA. Other successful grinds stay available
// as launch candidates until a full wallet/session reset calls clearVanityCAs().
bind('clearVanityCAResultBtn', 'click', () => {
  if (typeof discardSelectedVanityCA === 'function') discardSelectedVanityCA();
  log('Vanity CA discarded.', 'info');
});

function addVanityCAEntry(entry, { select = true } = {}) {
  const existingIdx = vanityCAKeypairs.findIndex((ca) => ca.publicKey === entry.publicKey);
  if (existingIdx >= 0) {
    vanityCAKeypairs[existingIdx] = { ...vanityCAKeypairs[existingIdx], ...entry };
    if (select) selectedVanityCA = existingIdx;
    return;
  }
  vanityCAKeypairs.push(entry);
  if (select) selectedVanityCA = vanityCAKeypairs.length - 1;
}

function discardSelectedVanityCA() {
  if (selectedVanityCA === null || !vanityCAKeypairs[selectedVanityCA]) return;
  const removed = vanityCAKeypairs[selectedVanityCA];
  const oldIdx = selectedVanityCA;
  vanityCAKeypairs.splice(oldIdx, 1);
  selectedVanityCA = vanityCAKeypairs.length
    ? Math.min(oldIdx, vanityCAKeypairs.length - 1)
    : null;
  renderVanityCAList();
  if (removed?.publicKey) {
    fetch('/api/vanity-ca-candidates/remove', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ publicKey: removed.publicKey }),
    }).catch((err) => {
      console.warn('Failed to remove saved Vanity CA:', err);
    });
  }
}

async function loadSavedVanityCAs() {
  try {
    const resp = await fetch('/api/vanity-ca-candidates');
    const data = await resp.json();
    if (!resp.ok || !data.success) throw new Error(data.error || `HTTP ${resp.status}`);
    const candidates = Array.isArray(data.candidates) ? data.candidates : [];
    candidates.forEach((candidate) => {
      if (candidate && candidate.publicKey && !candidate.decryptionFailed) {
        addVanityCAEntry(candidate, { select: false });
      }
    });
    if (selectedVanityCA === null && vanityCAKeypairs.length > 0) {
      selectedVanityCA = vanityCAKeypairs.length - 1;
    }
    renderVanityCAList();
  } catch (e) {
    console.warn('Failed to load saved Vanity CAs:', e);
  }
}

// Render the selected vanity CA and the optional candidate history. The launch
// submit path uses selectedVanityCA, so the selected row here is authoritative.
function renderVanityCAList() {
  const resultEl = document.getElementById('vanityCAResult');
  const addrEl = document.getElementById('vanityCAResultAddr');
  const rarityEl = document.getElementById('vanityCARarity');
  const metaEl = document.getElementById('vanityCAResultMeta');
  const iconEl = document.getElementById('vanityCAResultIcon');
  const headlineEl = document.getElementById('vanityCAResultHeadline');
  const optionsEl = document.getElementById('vanityCAOptions');
  if (!resultEl) return;

  // No active CA → hide the block and we're done.
  if (selectedVanityCA === null || !vanityCAKeypairs[selectedVanityCA]) {
    resultEl.classList.add('hidden');
    if (optionsEl) {
      optionsEl.innerHTML = '';
      optionsEl.classList.add('hidden');
    }
    return;
  }

  const ca = vanityCAKeypairs[selectedVanityCA];

  // Match the tier colors used elsewhere for consistency. Bulma tags
  // don't have a "Mythic" style natively; is-danger reads close enough.
  const tierColors = {
    Common: 'is-info',
    Rare: 'is-success',
    Legendary: 'is-warning',
    Mythic: 'is-danger',
  };
  const tagClass = tierColors[ca.rarity] || 'is-light';

  if (addrEl) addrEl.textContent = ca.publicKey;
  if (rarityEl) {
    // Replace the tag's color class so re-renders for different tiers
    // don't accumulate stale classes.
    rarityEl.className = `tag is-size-7 ${tagClass}`;
    rarityEl.textContent = ca.rarity;
  }
  if (metaEl) {
    metaEl.textContent = [
      vanityCandidateTargetLabel(ca),
      `${ca.attempts.toLocaleString()} attempts`,
      typeof ca.epochs === 'number' ? `${ca.epochs.toFixed(1)}× epoch` : '',
    ].filter(Boolean).join(' · ');
  }

  // The vanity CA is always usable — there is no pre-flight constraint
  // anymore. The launch pipeline accepts whichever mintA/mintB ordering
  // Raydium picks and branches every downstream calculation accordingly.
  if (iconEl) {
    iconEl.innerHTML = '<i class="fas fa-check-circle has-text-success"></i>';
  }
  if (headlineEl) {
    headlineEl.innerHTML =
      '<strong>Vanity CA ready</strong> '
      + '<span class="has-text-grey">&mdash; will be used as the token mint address</span>';
  }

  if (optionsEl) {
    if (vanityCAKeypairs.length <= 1) {
      optionsEl.innerHTML = '';
      optionsEl.classList.add('hidden');
    } else {
      optionsEl.classList.remove('hidden');
      optionsEl.innerHTML = vanityCAKeypairs.map((candidate, idx) => {
        const selected = idx === selectedVanityCA;
        const label = shortAddress(candidate.publicKey, 5, 5);
        const targetLabel = vanityCandidateTargetLabel(candidate) || candidate.rarity;
        return `<button type="button" class="button is-small vanity-ca-option ${selected ? 'is-primary' : 'is-light'}" data-vanity-ca-index="${idx}" title="${escapeAttr(candidate.publicKey)}">`
          + `<span>${escapeHtml(label)}</span>`
          + `<span class="has-text-grey ml-1">${escapeHtml(targetLabel)}</span>`
          + `</button>`;
      }).join('');
      optionsEl.querySelectorAll('[data-vanity-ca-index]').forEach((btn) => {
        btn.addEventListener('click', () => {
          selectedVanityCA = Number(btn.dataset.vanityCaIndex);
          renderVanityCAList();
        });
      });
    }
  }

  resultEl.classList.remove('hidden');
}

// Clear collected CAs (called on wallet regenerate / full reset)
function clearVanityCAs() {
  vanityCAKeypairs = [];
  selectedVanityCA = null;
  renderVanityCAList();
}

renderVanityCAList();
