// ===========================================================================
// Launch-journal recovery panel
// ---------------------------------------------------------------------------
// Launch journals are non-secret records of previous sessions: wallet public
// key, token mint, pool IDs, tx IDs, failed phase, and transfer outcome.
// They complement pending wallets, which hold the secret material needed for
// manual recovery.
// ===========================================================================

let launchJournalStartupIds = null;

async function loadLaunchJournals() {
  const panel = document.getElementById('launchJournalsPanel');
  const list = document.getElementById('launchJournalsList');
  if (!panel || !list) return;

  try {
    const [resp, walletResp] = await Promise.all([
      fetch('/api/launch-journals').then((r) => r.json()),
      fetch('/api/pending-wallets').then((r) => r.json()).catch(() => ({ wallets: [] })),
    ]);
    let journals = (resp && resp.journals) || [];
    const walletsByPublicKey = new Map(
      ((walletResp && walletResp.wallets) || []).map((wallet) => [wallet.publicKey, wallet]),
    );

    if (launchJournalStartupIds === null) {
      launchJournalStartupIds = new Set(journals.map((j) => j.id));
    }

    journals = journals.filter((j) => launchJournalStartupIds.has(j.id));

    if (journals.length === 0) {
      panel.classList.add('hidden');
      list.innerHTML = '';
      return;
    }

    list.innerHTML = '';
    for (const journal of journals) {
      list.appendChild(buildLaunchJournalRow(journal, walletsByPublicKey.get(journal.walletPublicKey)));
    }
    panel.classList.remove('hidden');
  } catch (e) {
    console.warn('Failed to load launch journals:', e);
    panel.classList.add('hidden');
  }
}

function shortAddress(value, prefix = 6, suffix = 6) {
  if (!value || typeof value !== 'string') return 'unknown';
  if (value.length <= prefix + suffix + 1) return value;
  return `${value.slice(0, prefix)}...${value.slice(-suffix)}`;
}

function launchJournalStageLabel(journal) {
  const stage = journal.stage || 'unknown';
  const labels = {
    wallet_generated: 'Wallet generated',
    token_create_started: 'Token creation started',
    logo_uploaded: 'Logo uploaded',
    metadata_uploaded: 'Metadata uploaded',
    mint_created: 'Mint created',
    metadata_account_created: 'Metadata account created',
    supply_minted: 'Supply minted',
    mint_authority_revoked: 'Mint authority revoked',
    metadata_update_authority_revoked: 'Metadata authority revoked',
    token_safety_verified: 'Token safety verified',
    token_created: 'Token created',
    token_create_failed: 'Token creation failed',
    lp_create_started: 'Pool creation started',
    lp_resume_started: 'Launch resume started',
    lp_recovered_for_transfer: 'Launch recovered for transfer',
    pool_create_done: 'Pool created',
    phase1_pool_done: 'Pool positions recorded',
    main_open_done: 'Main LP position opened',
    ladder_open_done: 'Ladder position opened',
    bootstrap_open_done: 'Bootstrap opened',
    main_lock_done: 'LP position locked',
    main_lock_failed: 'LP position lock failed',
    ladder_lock_done: 'Ladder position locked',
    ladder_lock_failed: 'Ladder position lock failed',
    bootstrap_lock_done: 'Bootstrap locked',
    bootstrap_lock_failed: 'Bootstrap lock failed',
    phase3_done: 'Lock phase completed',
    main_transfer_done: 'Fee Key transferred',
    main_transfer_failed: 'Fee Key transfer failed',
    phase4_done: 'Fee Key transfer phase completed',
    bootstrap_failed: 'Bootstrap failed',
    lp_created: 'Pools completed',
    lp_pre_flight_failed: 'Validation failed',
    lp_main_positions_failed: 'Pool creation failed',
    lp_bootstrap_failed: 'Bootstrap failed',
    lp_locks_failed: 'Locking failed',
    lp_transfers_failed: 'Fee Key transfer failed',
    transfer_started: 'Final sweep started',
    transfer_partial: 'Final sweep incomplete',
    transfer_completed: 'Final sweep completed',
    transfer_failed: 'Final sweep failed',
  };
  return labels[stage] || stage.replaceAll('_', ' ');
}

function launchJournalRecoveryText(journal) {
  const unsafeEvents = unsafeCreatedPoolEvents(journal);
  if (unsafeEvents.length > 0) {
    return 'A pool was created before Trebuchet recorded completed LP positions for it. Automatic resume is blocked to avoid duplicate pool work; use this entry\u2019s recovery phrase to sweep or handle the pool manually.';
  }
  if (journal.transfer?.walletEmpty === false || journal.stage === 'transfer_partial') {
    return 'Final sweep did not prove the launch wallet empty. Use this entry\u2019s recovery phrase to sweep or import the wallet manually.';
  }
  if (journal.lp?.failedPhase === 'bootstrap') {
    return 'Pools and main positions were recorded, but one or more bootstrap positions are missing. Created pools are permanent; sweep the wallet or retry bootstraps from the recorded plan.';
  }
  if (journal.lp?.failedPhase === 'locks') {
    return 'Pools and bootstraps were recorded, but one or more locks failed. Unlocked LP NFTs remain controlled by the launch wallet.';
  }
  if (journal.lp?.failedPhase === 'transfers') {
    return 'The launch reached locked positions, but some Fee Key deliveries failed. Remaining Fee Key NFTs should still be in the launch wallet for sweep or manual transfer.';
  }
  if (journal.lp?.partialResults?.length > 0) {
    return 'Some pool work landed on-chain before the launch stopped. Created pools are permanent; the launch wallet controls any unswept tokens and LP NFTs.';
  }
  if (journal.token?.mint) {
    return 'The token mint was recorded. If the launch stopped before pools or transfer, the minted supply should still be controlled by the launch wallet.';
  }
  return 'A launch wallet was generated, but no token mint was recorded. If you funded this wallet, use this entry\u2019s recovery phrase to recover the funds.';
}

function launchJournalPoolRows(journal) {
  const lp = journal.lp || {};
  const results = Array.isArray(lp.results) && lp.results.length > 0
    ? lp.results
    : (Array.isArray(lp.partialResults) ? lp.partialResults : []);
  if (results.length === 0) return '';

  const rows = results.slice(0, 6).map((r) => {
    const positions = [
      ...(Array.isArray(r.mainPositions) ? r.mainPositions : []),
      ...(Array.isArray(r.ladderPositions) ? r.ladderPositions : []),
      ...(r.bootstrap ? [r.bootstrap] : []),
    ];
    const locked = positions.filter((p) => p.locked).length;
    const bootstrap = r.bootstrap?.nftMint ? 'bootstrap opened' : 'bootstrap missing';
    return `<li><strong>${escapeHtml(r.quoteSymbol || 'pool')}</strong>: ` +
      `${escapeHtml(shortAddress(r.poolId, 6, 6))}, ` +
      `${positions.length} position${positions.length === 1 ? '' : 's'}, ` +
      `${locked}/${positions.length} locked, ${bootstrap}</li>`;
  }).join('');
  const more = results.length > 6
    ? `<li>${results.length - 6} more pool${results.length - 6 === 1 ? '' : 's'} recorded</li>`
    : '';
  return `<ul class="mt-2 mb-0">${rows}${more}</ul>`;
}

function launchJournalTxRows(journal) {
  const events = Array.isArray(journal.events) ? journal.events : [];
  const txs = [];
  for (const event of events) {
    if (typeof event.txId === 'string' && !txs.includes(event.txId)) {
      txs.push(event.txId);
    }
  }
  if (txs.length === 0) return '';
  const shown = txs.slice(0, 5)
    .map((tx) => `<span class="tag is-light is-family-monospace mr-1 mb-1">${escapeHtml(shortAddress(tx, 8, 6))}</span>`)
    .join('');
  const more = txs.length > 5
    ? `<span class="tag is-light mr-1 mb-1">+${txs.length - 5} more</span>`
    : '';
  return `<div class="mt-2"><strong>Recorded txs:</strong> ${shown}${more}</div>`;
}

function journalPriorResults(journal) {
  const lp = journal.lp || {};
  const source = Array.isArray(lp.results) && lp.results.length > 0
    ? lp.results
    : (Array.isArray(lp.partialResults) ? lp.partialResults : []);
  return source.filter((result) => result && result.poolId);
}

function journalHasCompletedLp(journal) {
  const lp = journal.lp || {};
  return (
    ['lp_created', 'transfer_started', 'transfer_partial', 'transfer_failed'].includes(journal.stage) &&
    Array.isArray(lp.results) &&
    lp.results.length > 0 &&
    !lp.failedPhase
  );
}

function unsafeCreatedPoolEvents(journal) {
  const completedAllocations = new Set(journalPriorResults(journal).map((r) => r.allocationIndex));
  return (journal.events || []).filter(
    (event) =>
      event.stage === 'pool_create_done' &&
      !completedAllocations.has(event.allocationIndex),
  );
}

function canResumeLaunchJournal(journal, wallet) {
  return !!(
    journal.token?.mint &&
    journal.poolPlan?.tokenTotalSupply &&
    journal.poolPlan?.targetMarketCapUsd &&
    Array.isArray(journal.poolPlan?.allocations) &&
    wallet &&
    wallet.hasSecretKey &&
    unsafeCreatedPoolEvents(journal).length === 0
  );
}

function prepareRecoveredSessionFromJournal(journal, wallet) {
  tempWallet = {
    publicKey: wallet.publicKey,
    ...(wallet.secretKey ? { secretKey: wallet.secretKey } : {}),
    ...(wallet.secretKeyB58 ? { secretKeyB58: wallet.secretKeyB58 } : {}),
    ...(wallet.mnemonic ? { mnemonic: wallet.mnemonic } : {}),
  };
  fundingWallet = null;
  fundingDetectionExhausted = false;
  createdTokenInfo = {
    mint: journal.token.mint,
    decimals: journal.token.decimals || journal.poolPlan?.tokenDecimals || 9,
    totalSupply: journal.token.totalSupply || journal.poolPlan?.tokenTotalSupply,
    name: journal.token.name || '',
    symbol: journal.token.symbol || 'TOKEN',
    // Token-safety facts restored from the journal (recorded there at
    // token-creation time) so a resumed launch still publishes a complete
    // audit record to Arweave.
    metadataUri: journal.token.metadataUri || null,
    imageUri: journal.token.imageUri || null,
    mintAuthorityRenounced: journal.token.mintAuthorityRenounced === true,
    freezeAuthorityDisabled: journal.token.freezeAuthorityDisabled === true,
    metadataUpdateAuthorityRevoked: journal.token.metadataUpdateAuthorityRevoked === true,
    metadataImmutable: journal.token.metadataImmutable === true,
  };
  lpResult = { results: journalPriorResults(journal) };

  // Airdrop state. The journal carries two complementary records:
  //   - journal.airdrop: the per-recipient result of any airdrop that
  //     already ran (written by transfer-assets / retry-airdrop). Restoring
  //     it brings back the report's delivered/failed section and the
  //     retry button after an app restart.
  //   - journal.poolPlan.airdropPlan: the configured plan, journaled at
  //     create-lp. Restoring it lets a resumed transfer still execute the
  //     airdrop even though the simple-mode config it was built from
  //     didn't survive the restart. The server filters out recipients its
  //     journal already records as delivered, so restoring the full plan
  //     is safe regardless of how far the airdrop got.
  lastAirdropResult = (journal.airdrop && typeof journal.airdrop === 'object')
    ? journal.airdrop
    : null;
  restoredAirdropPayload = journal.poolPlan?.airdropPlan || null;
  // Publish state: if the permanent report already went to Arweave in a
  // previous session, restore the recorded URIs so the UI shows the link
  // and runTransfer's publish step becomes a no-op (the server is also
  // idempotent on this, so the restore is belt-and-braces for the UI).
  if (journal.reportPublish && journal.reportPublish.jsonUri) {
    _publishedReport = {
      status: 'done',
      jsonUri: journal.reportPublish.jsonUri,
      htmlUri: journal.reportPublish.htmlUri || null,
    };
    if (typeof refreshLaunchReportUi === 'function') refreshLaunchReportUi();
  }

  document.body.classList.add('has-log');
  document.getElementById('walletInfo')?.classList.remove('hidden');
  const walletAddress = document.getElementById('walletAddress');
  if (walletAddress) walletAddress.value = wallet.publicKey;
  document.getElementById('privateKeyContainer')?.classList.add('hidden');
  document.getElementById('tokenCreatedInfo')?.classList.remove('hidden');
  const mintEl = document.getElementById('tokenMintAddress');
  if (mintEl) mintEl.textContent = journal.token.mint;
  const solscanLink = document.getElementById('tokenSolscanLink');
  if (solscanLink) solscanLink.href = `https://solscan.io/token/${journal.token.mint}`;

  document.getElementById('createTokenBtn')?.classList.add('hidden');
  document.getElementById('createLpBtn')?.classList.add('hidden');
  document.getElementById('transferAssetsBtn')?.classList.remove('hidden');
  document.getElementById('transferResult')?.classList.add('hidden');
  // The "View launch summary" button is revealed only on a fully clean
  // transfer (runTransfer success branch). When resuming a stale journal
  // in a session where a previous launch already completed successfully,
  // the button could still carry over visible from that earlier success.
  // Re-hide it here so the resumed launch's step 6 starts in the right
  // state — symmetrical with the transferResult reset right above.
  document.getElementById('viewLaunchSummaryBtn')?.classList.add('hidden');
  const dest = document.getElementById('destinationWallet');
  if (dest) dest.value = '';

  setStepSummary(1, `${wallet.publicKey.slice(0, 8)}...${wallet.publicKey.slice(-6)}`);
  setStepSummary(4, `${createdTokenInfo.symbol} - ${createdTokenInfo.mint.slice(0, 8)}...`);
  const count = lpResult.results.length;
  setStepSummary(5, count > 0 ? `${count} pool${count === 1 ? '' : 's'} recorded` : 'ready to resume');
}

async function revealPendingWalletSecret(publicKey) {
  const resp = await fetch('/api/pending-wallets/reveal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ publicKey }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.success || !data.wallet) {
    throw new Error(data.error || `Reveal failed with HTTP ${resp.status}`);
  }
  return data.wallet;
}

async function resumeLaunchJournal(journal, wallet, btn) {
  const completedLp = journalHasCompletedLp(journal);
  const actionLabel = completedLp ? 'Continue transfer' : 'Resume launch';
  const ok = await confirmDialog({
    title: `${actionLabel}?`,
    body:
      `<p>${completedLp ? 'Recover the recorded launch session' : 'Resume the recorded launch'} for <strong>${escapeHtml(journal.token?.symbol || 'this token')}</strong>?</p>` +
      `<p>Trebuchet will use the recovered launch wallet ${completedLp ? 'and take you to the final transfer step.' : 'and retry only work that the journal does not show as complete. Review the activity log after it finishes.'}</p>`,
    confirmLabel: actionLabel,
  });
  if (!ok) return;

  await withRunState(async () => {
    setLoading(btn, true);
    try {
      prepareRecoveredSessionFromJournal(journal, wallet);
      log(`${completedLp ? 'Recovering' : 'Resuming'} launch journal for ${createdTokenInfo.symbol}...`, 'warning');

      const resp = await fetch('/api/launch-journals/resume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: journal.id }),
      });
      const data = await resp.json();
      if (!data.success) {
        if (Array.isArray(data.partialResults) && data.partialResults.length > 0) {
          lpResult = { results: data.partialResults };
          setStepSummary(5, `partial - sweep available`);
          activateStep(6);
        }
        throw new Error(data.error || `Resume failed with HTTP ${resp.status}`);
      }

      lpResult = data;
      const count = (data.results || []).length;
      setStepSummary(5, `${count} pool${count === 1 ? '' : 's'} completed`);
      log(`${completedLp ? 'Recovery' : 'Resume'} complete: ${count} pool${count === 1 ? '' : 's'} ready for final transfer`, 'success');
      activateStep(6);
      try {
        await detectFundingWallet();
      } catch {
        // Best-effort convenience only; destination remains manually editable.
      }
      prefillDestinationFromFunder();
      await loadLaunchJournals();
      await loadPendingWallets();
    } catch (e) {
      log(`Journal resume failed: ${e.message}`, 'danger');
    } finally {
      setLoading(btn, false);
    }
  });
}

function buildLaunchJournalRow(journal, wallet) {
  const wrap = document.createElement('div');
  wrap.className = 'box p-3 mb-2 is-size-7';

  const tokenLabel = journal.token?.symbol
    ? `${journal.token.symbol} (${shortAddress(journal.token.mint || '', 6, 6)})`
    : (journal.token?.mint ? shortAddress(journal.token.mint, 6, 6) : 'No token mint recorded');
  const walletShort = shortAddress(journal.walletPublicKey, 6, 6);
  const ageStr = formatAge(journal.updatedAt || journal.createdAt);
  const errorHtml = journal.error
    ? `<div class="notification is-danger is-light is-size-7 py-2 px-3 my-2">${escapeHtml(journal.error)}</div>`
    : '';
  const canResume = canResumeLaunchJournal(journal, wallet);
  const resumeLabel = journalHasCompletedLp(journal) ? 'Continue transfer' : 'Resume launch';
  const resumeHelp = !canResume && journal.token?.mint && journal.poolPlan?.allocations
    ? `<div class="has-text-grey mt-2">Automatic resume is unavailable${wallet?.decryptionFailed ? ': wallet secret could not be decrypted' : unsafeCreatedPoolEvents(journal).length > 0 ? ': unsafe partial pool state recorded' : ': matching recoverable wallet is missing'}.</div>`
    : '';

  // Recovery material from the matching wallet, folded into this card so the
  // whole stalled launch is handled in one place (no second panel to
  // cross-reference). hasSecret is true only when the wallet exists and its
  // secret decrypted; secretIsMnemonic picks the recovery-phrase vs raw-key
  // wording. When a wallet is attached but can't be decrypted we show a note
  // instead of a copy button.
  const hasSecret = !!(wallet && !wallet.decryptionFailed && (wallet.hasMnemonic || wallet.hasSecretKey));
  const secretIsMnemonic = hasSecret && !!wallet.hasMnemonic;
  const recoverBtnHtml = hasSecret ? `
        <div class="control">
          <button class="button is-small is-info" data-action="copy-recovery">
            <span class="icon is-small"><i class="fas ${secretIsMnemonic ? 'fa-list-ol' : 'fa-key'}"></i></span>
            <span>${secretIsMnemonic ? 'Copy recovery phrase' : 'Copy secret key'}</span>
          </button>
        </div>` : '';
  const decryptNoteHtml = (wallet && wallet.decryptionFailed) ? `
    <div class="notification is-danger is-light is-size-7 py-2 px-3 my-2">
      The recoverable wallet for this launch can't be decrypted — the OS
      keychain key has likely changed (file copied to another account or
      machine, or the keychain was reset). If you backed up the recovery
      phrase elsewhere, use that.
    </div>` : '';
  // The removal action also discards the wallet secret when one is attached,
  // so the label and confirmation make that consequence explicit.
  const removeLabel = hasSecret ? 'Dismiss &amp; discard wallet' : 'Dismiss journal';

  wrap.innerHTML = `
    <div class="mb-1">
      <strong>${escapeHtml(tokenLabel)}</strong>
      <span class="tag is-warning is-light ml-1">${escapeHtml(launchJournalStageLabel(journal))}</span>
      <span class="has-text-grey ml-1">${escapeHtml(ageStr)}</span>
    </div>
    <div><strong>Launch wallet:</strong> <span class="is-family-monospace">${escapeHtml(walletShort)}</span></div>
    ${journal.token?.mint ? `<div><strong>Token mint:</strong> <span class="is-family-monospace">${escapeHtml(shortAddress(journal.token.mint, 8, 8))}</span></div>` : ''}
    ${errorHtml}
    <div class="notification is-warning is-light is-size-7 py-2 px-3 my-2">
      ${escapeHtml(launchJournalRecoveryText(journal))}
    </div>
    ${decryptNoteHtml}
    ${launchJournalPoolRows(journal)}
    ${launchJournalTxRows(journal)}
    ${resumeHelp}
    <div class="field is-grouped is-grouped-multiline mt-3">
      ${canResume ? `
        <div class="control">
          <button class="button is-small is-primary" data-action="resume">
            <span class="icon is-small"><i class="fas fa-redo"></i></span>
            <span>${resumeLabel}</span>
          </button>
        </div>
      ` : ''}
      ${hasSecret ? `
        <div class="control">
          <button class="button is-small is-success" data-action="use-wallet">
            <span class="icon is-small"><i class="fas fa-play"></i></span>
            <span>Use wallet for new launch</span>
          </button>
        </div>
      ` : ''}
      ${recoverBtnHtml}
      ${journal.token?.mint ? `
        <div class="control">
          <button class="button is-small" data-action="copy-token">
            <span class="icon is-small"><i class="fas fa-copy"></i></span>
            <span>Copy token mint</span>
          </button>
        </div>
      ` : ''}
      <div class="control">
        <button class="button is-small" data-action="copy-wallet">
          <span class="icon is-small"><i class="fas fa-copy"></i></span>
          <span>Copy launch wallet</span>
        </button>
      </div>
      <div class="control">
        <button class="button is-small is-danger is-light" data-action="dismiss">
          <span class="icon is-small"><i class="fas fa-trash"></i></span>
          <span>${removeLabel}</span>
        </button>
      </div>
    </div>
  `;

  const copyText = async (text, description) => {
    try {
      await navigator.clipboard.writeText(text);
      log(`${description} copied to clipboard`, 'info');
    } catch (e) {
      log(`Couldn't copy ${description}: ${e.message}`, 'warning');
    }
  };

  wrap.querySelector('[data-action="copy-token"]')?.addEventListener('click', async () => {
    await copyText(journal.token.mint, 'Token mint');
  });
  wrap.querySelector('[data-action="copy-wallet"]').addEventListener('click', async () => {
    await copyText(journal.walletPublicKey, 'Launch wallet public key');
  });

  // Use-wallet button: load this wallet as active tempWallet for a fresh launch
  wrap.querySelector('[data-action="use-wallet"]')?.addEventListener('click', async () => {
    if (!wallet || !wallet.hasSecretKey) return;
    if (tempWallet) {
      const ok = await confirmDialog({
        title: 'Switch wallet?',
        body: '<p>You already have a wallet from this session. Switching will discard it.</p><p>Proceed?</p>',
        confirmLabel: 'Switch',
        danger: true,
      });
      if (!ok) return;
    }
    fundingWallet = null;
    fundingDetectionExhausted = false;
    lastSolBalance = 0;
    createdTokenInfo = null;
    lpResult = null;
    fundingRequirement = { solLamports: 0, byQuote: {}, autoSwapPlan: [] };
    if (typeof clearVanityCAs === 'function') clearVanityCAs();

    tempWallet = {
      publicKey: wallet.publicKey,
    };

    document.getElementById('walletInfo').classList.remove('hidden');
    document.getElementById('walletAddress').value = wallet.publicKey;
    document.getElementById('qrCode').src = '';
    document.getElementById('privateKeyContainer').classList.add('hidden');
    document.getElementById('tokenCreatedInfo').classList.add('hidden');
    document.getElementById('createTokenBtn').classList.remove('hidden');
    document.getElementById('createLpBtn').classList.remove('hidden');
    document.getElementById('transferAssetsBtn').classList.remove('hidden');
    setLpDoneVisible(false);
    document.getElementById('lpFailInfo').classList.add('hidden');
    document.getElementById('lpProgress').classList.add('hidden');
    document.getElementById('lpProgressTree').innerHTML = '';
    document.getElementById('transferResult').classList.add('hidden');
    document.getElementById('fundingWalletInfo').classList.add('hidden');
    document.getElementById('destinationWallet').value = '';

    for (let i = 2; i <= 6; i++) setStepSummary(i, '');
    document.body.classList.add('has-log');
    log('Using wallet from incomplete launch: ' + wallet.publicKey, 'success');
    markLaunchActiveForRpcHealth(false);
    if (typeof rebuildPoolsFromSimple === 'function' && pools.length === 0) rebuildPoolsFromSimple();
    if (typeof applySimpleConfigMode === 'function') applySimpleConfigMode();
    setStepSummary(1, wallet.publicKey.slice(0, 8) + '…' + wallet.publicKey.slice(-6));
    if (typeof activateStep === 'function') activateStep(2);
    if (typeof updateContinueToFundingState === 'function') updateContinueToFundingState();
    if (typeof updateCancelButtonState === 'function') updateCancelButtonState();
  });
  wrap.querySelector('[data-action="copy-recovery"]')?.addEventListener('click', async () => {
    try {
      const revealed = await revealPendingWalletSecret(wallet.publicKey);
      const text = revealed.mnemonic || revealed.secretKeyB58;
      if (!text) {
        log(`No recovery secret available for ${walletShort}`, 'warning');
        return;
      }
      await copyText(text, revealed.mnemonic ? 'Recovery phrase' : 'Secret key');
    } catch (e) {
      log(`Couldn't reveal recovery secret for ${walletShort}: ${e.message}`, 'warning');
    }
  });
  wrap.querySelector('[data-action="resume"]')?.addEventListener('click', async (event) => {
    await resumeLaunchJournal(journal, wallet, event.currentTarget);
  });
  wrap.querySelector('[data-action="dismiss"]').addEventListener('click', async () => {
    // When a recoverable wallet is attached, removal clears both the journal
    // summary AND the wallet secret — so the confirmation spells out that the
    // recovery phrase is permanently deleted. With no wallet attached it's the
    // harmless journal-only dismiss.
    const ok = await confirmDialog({
      title: hasSecret ? 'Dismiss and discard wallet?' : 'Dismiss launch journal?',
      body: hasSecret
        ? `<p>Remove the recovery entry for <strong>${escapeHtml(tokenLabel)}</strong>?</p>` +
          `<p>This permanently deletes the recovery phrase / secret key for the launch wallet ` +
          `(<span class="is-family-monospace">${escapeHtml(walletShort)}</span>) and clears the ` +
          `journal summary. Make sure you've moved any funds out of this wallet, or are certain ` +
          `none were ever sent there — this cannot be undone.</p>`
        : `<p>Dismiss the journal for <strong>${escapeHtml(tokenLabel)}</strong>?</p>` +
          `<p>This hides the recovery summary but does not move funds or delete any on-chain assets. ` +
          `Only dismiss it after you have recovered, swept, or intentionally abandoned the launch wallet.</p>`,
      confirmLabel: hasSecret ? 'Discard wallet & dismiss' : 'Dismiss journal',
      danger: true,
    });
    if (!ok) return;
    try {
      await fetch('/api/launch-journals/dismiss', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: journal.id }),
      });
      // Also discard the matching wallet secret when one is attached, so the
      // whole entry is cleaned up in a single action.
      if (hasSecret) {
        await fetch('/api/pending-wallets/dismiss', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ publicKey: journal.walletPublicKey }),
        });
      }
      await loadLaunchJournals();
      await loadPendingWallets();
    } catch (e) {
      log(`Failed to dismiss launch journal: ${e.message}`, 'danger');
    }
  });

  return wrap;
}
