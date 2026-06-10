// ===========================================================================
// STEP 1: Generate wallet
// ===========================================================================

bind('generateWalletBtn', 'click', async () => {
  const btn = document.getElementById('generateWalletBtn');
  // If a wallet already exists, this is a regenerate. Confirm to avoid
  // accidentally wiping a launch in progress. Tailor the warning to how
  // far along the user is — past step 3 they may have funded the wallet.
  if (tempWallet && currentStep > 1) {
    const pastFunding = currentStep > 3;
    const body = pastFunding
      ? '<p>You are mid-launch. Generating a new wallet will <strong>not</strong> ' +
        'recover any funds, tokens, or NFTs already in the current ephemeral ' +
        'wallet — those will be stranded unless you save the private key ' +
        '(currently visible above) <strong>first</strong>.</p>' +
        '<p>Cancel this dialog, click "Show Private Key", copy the key somewhere ' +
        'safe, <strong>then</strong> regenerate.</p>' +
        '<p>Proceed anyway?</p>'
      : '<p>You already have a wallet from this session. Generating a new one will ' +
        'discard it. If you sent any SOL to it, you will lose access unless you ' +
        'saved the private key first.</p>' +
        '<p>Proceed?</p>';
    const ok = await confirmDialog({
      title: 'Discard current wallet?',
      body,
      confirmLabel: 'Generate new wallet',
      danger: true,
    });
    if (!ok) return;
  }

  await withRunState(async () => {
    setLoading(btn, true);
    try {
      log('Generating temporary wallet...');
      if (balancePollHandle) {
        clearInterval(balancePollHandle);
        balancePollHandle = null;
      }
      const resp = await fetch('/api/generate-wallet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const data = await resp.json();
      if (!data.success) throw new Error(data.error);

      // Reset all per-launch state so a regenerate starts truly fresh
      tempWallet = data.wallet;
      fundingWallet = null;
      fundingDetectionExhausted = false;
      lastSolBalance = 0;
      createdTokenInfo = null;
      lpResult = null;
      lastAirdropResult = null;
      fundingRequirement = { solLamports: 0, byQuote: {}, autoSwapPlan: [] };

      // Reset UI panels that may carry stale info from a previous attempt
      document.getElementById('walletInfo').classList.remove('hidden');
      document.getElementById('qrCode').src = data.wallet.qrCode;
      document.getElementById('walletAddress').value = data.wallet.publicKey;
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
      // In demo mode, immediately re-fill with the synthetic destination
      // address so the user doesn't have to re-enter anything to finish
      // a second demo run after a reset. No-op in real mode.
      applyDemoDestinationWallet();
      if (typeof window.applySolflareDestinationWallet === 'function') {
        window.applySolflareDestinationWallet({ silent: true });
      }

      // Reset step summaries from any prior attempt
      for (let i = 2; i <= 6; i++) setStepSummary(i, '');

      document.body.classList.add('has-log');

      log(`Wallet generated: ${data.wallet.publicKey}`, 'success');
      markLaunchActiveForRpcHealth(false);

      if (pools.length === 0) {
        // Build pools from simpleConfig defaults — produces 90/10
        // SOL+XLRT (or whatever the user has selected in the simple
        // toggle) instead of the old single SOL pool. The simple-config
        // UI may have been rendered already (see init at the bottom of
        // this file); we re-apply the mode here to make sure the right
        // container is visible after step 2 activates.
        rebuildPoolsFromSimple();
      }
      applySimpleConfigMode();

      setStepSummary(1, `${data.wallet.publicKey.slice(0, 8)}…${data.wallet.publicKey.slice(-6)}`);
      activateStep(2);
      updateContinueToFundingState();
      updateCancelButtonState();
    } catch (e) {
      log(`Error: ${e.message}`, 'danger');
    } finally {
      setLoading(btn, false);
    }
  });
});

bind('showPrivateKeyBtn', 'click', () => {
  const cont = document.getElementById('privateKeyContainer');
  const target = document.getElementById('privateKey');
  if (!tempWallet) return;
  if (cont.classList.contains('hidden')) {
    // New wallets always have a mnemonic; the base58 fallback is only
    // here in case something upstream changes and we end up without one.
    if (tempWallet.mnemonic) {
      target.innerHTML = '';
      target.appendChild(buildMnemonicGrid(tempWallet.mnemonic));
    } else {
      target.className = 'secret-key-container';
      target.textContent = tempWallet.secretKeyB58 || '(secret unavailable)';
    }
    cont.classList.remove('hidden');
  } else {
    cont.classList.add('hidden');
  }
});

// Build a numbered 12-word grid for displaying a BIP39 mnemonic. Reads
// nicely on screen, easy to copy down accurately on paper.
function buildMnemonicGrid(mnemonic) {
  const wrap = document.createElement('div');
  wrap.className = 'mnemonic-grid';
  const words = mnemonic.trim().split(/\s+/);
  words.forEach((word, i) => {
    const cell = document.createElement('div');
    cell.innerHTML = `<span class="num">${i + 1}.</span>${word}`;
    wrap.appendChild(cell);
  });
  return wrap;
}

// ===========================================================================
// STEP 2: Token + Pool config
// ===========================================================================

// Validate a picked logo file against the size and dimension limits.
// Returns a Promise<string|null>: null on success, an error message on
// failure. Loads the file as an image to read its natural dimensions —
// we can't trust the file metadata or filename extension for this; the
// only reliable read is "actually decode the image and ask."
//
// The Image decode is wrapped in a same-document objectURL that we
// revoke immediately after, regardless of outcome, so this validation
// path doesn't leak object URLs even on rapid file changes.
async function validateLogoFile(file) {
  if (file.size > MAX_LOGO_BYTES) {
    const kb = (file.size / 1024).toFixed(1);
    const maxKb = (MAX_LOGO_BYTES / 1024).toFixed(0);
    return `Logo is ${kb}KB; max is ${maxKb}KB. ` +
      `Compress the image or pick a smaller file.`;
  }
  // accept attribute on the input already restricts the picker to
  // image/png and image/jpeg, but the browser's filter isn't a hard
  // gate (drag-and-drop, devtools, OS file dialogs that ignore filters
  // on some platforms). Re-check the MIME explicitly so we surface a
  // useful message instead of letting the image decode fail opaquely.
  if (file.type !== 'image/png' && file.type !== 'image/jpeg') {
    return 'Logo must be a PNG or JPG image.';
  }

  // Image-decode dimension check. We have to actually load the file as
  // an image — there's no synchronous way to get pixel dimensions from
  // a File object. createObjectURL + new Image() is the standard idiom.
  const url = URL.createObjectURL(file);
  try {
    const dims = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
      img.onerror = () => reject(new Error('Could not decode image — file may be corrupt'));
      img.src = url;
    });
    if (dims.w > MAX_LOGO_DIMENSION || dims.h > MAX_LOGO_DIMENSION) {
      return `Logo is ${dims.w}×${dims.h}px; max is ` +
        `${MAX_LOGO_DIMENSION}×${MAX_LOGO_DIMENSION}px. Resize the image and try again.`;
    }
    if (dims.w < MIN_LOGO_DIMENSION || dims.h < MIN_LOGO_DIMENSION) {
      return `Logo is ${dims.w}×${dims.h}px; minimum is ` +
        `${MIN_LOGO_DIMENSION}×${MIN_LOGO_DIMENSION}px. Pick a larger image.`;
    }
    return null;
  } catch (e) {
    return e.message || 'Could not read the image.';
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Show or clear the inline logo error message under the file picker.
// Passing null hides the element; passing a string reveals it with the
// message. Encapsulates the .hidden toggle so the call sites read
// clearly as "set the error" vs "clear the error."
function setLogoError(message) {
  const el = document.getElementById('tokenLogoError');
  if (!el) return;
  if (message) {
    el.textContent = message;
    el.classList.remove('hidden');
  } else {
    el.textContent = '';
    el.classList.add('hidden');
  }
}

bind('tokenLogo', 'change', async (e) => {
  const f = e.target.files[0];
  const filenameEl = document.getElementById('logoFileName');
  // No file selected (user cancelled out of the picker, or cleared the
  // selection). Reset displayed state and any prior error.
  if (!f) {
    filenameEl.textContent = 'No file selected';
    setLogoError(null);
    return;
  }
  // Show the picked filename immediately so the UI feels responsive
  // even while we're decoding the image to check dimensions. We'll
  // overwrite this with "No file selected" if validation fails.
  filenameEl.textContent = f.name;
  setLogoError(null);

  const err = await validateLogoFile(f);
  if (err) {
    // Reject the file: clear the input so subsequent code paths
    // (renderTokenPreview, the create-token submit) see no logo at
    // all, rather than seeing a logo that's about to be rejected by
    // the server. Setting .value = '' is the cross-browser way to
    // programmatically clear a file input.
    e.target.value = '';
    filenameEl.textContent = 'No file selected';
    setLogoError(err);
    // Trigger a preview re-render so the thumbnail and live preview
    // card both drop back to their no-logo state.
    if (typeof renderTokenPreview === 'function') renderTokenPreview();
    return;
  }
  // Valid file — leave the filename as set above. The separate
  // change-handler binding (see bind('tokenLogo', 'change', renderTokenPreview)
  // below in this file) handles updating the preview thumbnail and
  // live card. We don't trigger it directly from here; the browser
  // fires `change` once and both listeners receive it.
});

const poolList = document.getElementById('poolList');

