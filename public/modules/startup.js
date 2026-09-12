// ===========================================================================
// Initial state
// ===========================================================================
log('Trebuchet is ready. Click "Generate Wallet" to begin.');
loadRpcConfig();
startRpcHealthPolling();
loadFeeTiers();
bindStepHeaders();
updateCancelButtonState();
// Render the simple-config UI right away so it's visible from page load
// (even before the user generates a wallet). The pool list inside the
// customize-mode container starts empty and stays empty until pools[]
// gets populated — by wallet generation, by recovery, or by manual add.
applySimpleConfigMode();
// Initial paint of the token-preview card. With the default values
// pre-filled in the supply and market-cap inputs, the user sees the
// placeholder name + a populated tech line right away.
renderTokenPreview();

// ---------------------------------------------------------------------------
// Tab-close / reload guard
// ---------------------------------------------------------------------------
//
// Once the user has progressed past wallet generation, accidentally
// closing or reloading the window loses session context (tempWallet, the
// in-progress pools array, the funding-requirement estimate, etc).
// The wallet's secret key is still in the pending-wallets recovery
// cache server-side, so funds are never lost, but the user has to
// re-enter their config and re-derive the wallet — friction we can
// prevent with a confirmation prompt before the unload.
//
// We only fire the warning when there's genuine state worth preserving:
//   - currentStep > 1   → wallet has been generated
//   - currentStep < 6   → we're not on the terminal transfer step
//
// Behavior differs by host:
//   - In a regular browser: Chrome/Firefox show their own generic "Leave
//     site? Changes you made may not be saved" dialog. They ignore our
//     message text; we just need to call preventDefault + set returnValue.
//   - In Electron: the renderer's beforeunload preventDefault is reported
//     to the main process via the 'will-prevent-unload' event, which
//     main.js handles by showing a native dialog. The renderer doesn't
//     need to do anything different here — same preventDefault pattern.
//     See main.js for the dialog setup.
window.addEventListener('beforeunload', (e) => {
  // The demo-mode toggle reloads to reset state, but it has already shown
  // its own HTML confirmation. Let that reload through without also firing
  // the native "launch in progress" dialog.
  if (demoModeReloading) return;
  if (currentStep <= 1 || currentStep >= 6) return;
  e.preventDefault();
  // Some browsers (older Chrome, Edge) still read the return value;
  // newer ones ignore it. Set it for compatibility. Electron ignores
  // it too — the native dialog in main.js uses its own copy.
  e.returnValue = 'A launch is in progress. Leaving now will reset the UI; ' +
    'you\'ll need to recover the wallet from the pending-wallets panel.';
  return e.returnValue;
});

// ---------------------------------------------------------------------------
// Startup gate for the silent update-check
// ---------------------------------------------------------------------------
//
// The Electron main process runs the actual GitHub API call for the
// auto-update check, but we want the "Update available" modal to land
// ON TOP OF the main UI — not behind the splash video or the
// first-run disclaimer. Both of those mask the renderer at startup.
//
// To coordinate, we keep a tiny gate state here. The splash and
// disclaimer setups flip their gate to false when they're going to
// display something blocking, and back to true when the user has
// dismissed it. When both gates are true, we POST to a server
// endpoint that signals main to run the check.
//
// Default-true semantics handle the "didn't need to show anything"
// cases automatically:
//   - splash element missing → splash gate stays true
//   - disclaimer already agreed in a previous session → disclaimer
//     gate stays true
// In either case the gate never flips false, and the final
// _evaluateStartupGates() call at the bottom of this file picks up
// "both still true" and fires the trigger.

const _startupGates = {
  splash: true,
  disclaimer: true,
  secretPin: true,
};
let _startupTriggerFired = false;

function _gateStartup(name) {
  _startupGates[name] = false;
}

function _releaseStartupGate(name) {
  _startupGates[name] = true;
  _evaluateStartupGates();
}

function _evaluateStartupGates() {
  if (_startupTriggerFired) return;
  if (!_startupGates.splash || !_startupGates.disclaimer || !_startupGates.secretPin) return;
  _startupTriggerFired = true;
  // Fire-and-forget. The server endpoint is local so this should
  // never fail in practice; if it somehow does, the user can still
  // run a manual check via Help → Check for Updates, so we don't
  // surface anything.
  fetch('/api/trigger-startup-update-check', { method: 'POST' })
    .catch((err) => {
      console.warn('Startup update-check trigger failed:', err);
    });
}

// ---------------------------------------------------------------------------
// First-run disclaimer
// ---------------------------------------------------------------------------
//
// Show a one-time risk-acknowledgement modal before anything else
// happens on the page. Acceptance is remembered in localStorage so
// returning users skip the dialog. The disclaimer is layered on top
// of the splash (higher z-index in CSS) so on first run the user
// reads and acknowledges before the intro video plays.
//
// Splash gating — implemented in setupSplashScreen() — already waits
// while any .modal.is-active is on the page, so adding the disclaimer
// modal naturally pauses splash playback. When the user clicks Agree,
// the modal class is removed and the splash detects no active modal
// and starts playing.
//
// On Cancel: attempt window.close(). In Electron this terminates the
// app since there's only one window. In plain web mode (npm run web
// served via a browser) window.close() may be blocked by the browser
// for windows not opened by JS — so we replace the modal contents
// with a "please close this tab" fallback message.
//
// Storage is keyed with a namespace prefix so it doesn't collide
// with anything else; we store an ISO timestamp rather than just
// "true" so future debugging can see when the agreement was given.
const DISCLAIMER_STORAGE_KEY = 'trebuchet:disclaimer-agreed';

function setupDisclaimer() {
  const modal = document.getElementById('disclaimerModal');
  if (!modal) return;

  // Check whether the user has already agreed in a previous session.
  // localStorage access can throw in some sandboxed contexts (private
  // browsing, disabled storage); on error, treat as "not agreed" and
  // show the dialog — better safe than skipping the warning.
  let alreadyAgreed = false;
  try {
    alreadyAgreed = !!localStorage.getItem(DISCLAIMER_STORAGE_KEY);
  } catch {
    alreadyAgreed = false;
  }

  if (alreadyAgreed) {
    return; // modal stays inert; splash and main app proceed normally
  }

  // First-run path: gate the silent update-check until the user has
  // acknowledged the disclaimer. Without this, the auto-check modal
  // would land behind this dialog. The agree handler below releases
  // the gate.
  _gateStartup('disclaimer');

  // First run (or storage cleared): show the modal.
  modal.classList.add('is-active');

  const checkbox = document.getElementById('disclaimerAgreeCheck');
  const agreeBtn = document.getElementById('disclaimerAgreeBtn');
  const cancelBtn = document.getElementById('disclaimerCancelBtn');

  // Checkbox gates the agree button. The user has to make the
  // explicit gesture before they can proceed — keeps the
  // acknowledgement intentional rather than muscle-memory clicking.
  if (checkbox && agreeBtn) {
    checkbox.addEventListener('change', () => {
      agreeBtn.disabled = !checkbox.checked;
    });
  }

  if (agreeBtn) {
    agreeBtn.addEventListener('click', () => {
      if (checkbox && !checkbox.checked) return; // safety: button shouldn't be enabled, but guard anyway
      try {
        localStorage.setItem(DISCLAIMER_STORAGE_KEY, new Date().toISOString());
      } catch {
        // Storage failed — proceed anyway. The user will just see the
        // disclaimer again on next launch. Annoying but not broken.
      }
      modal.classList.remove('is-active');
      // Disclaimer is dismissed — release the startup gate. If the
      // splash gate is also clear (returning user or splash already
      // dismissed), this fires the silent update check.
      _releaseStartupGate('disclaimer');
    });
  }

  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => {
      // Try to close the window. In Electron this terminates the app.
      // In plain web mode, browsers may block this — fall back to a
      // "please close" message that overwrites the modal body.
      window.close();
      // If we're still here ~50ms later, the close was blocked.
      setTimeout(() => {
        const body = modal.querySelector('.modal-card-body');
        const foot = modal.querySelector('.modal-card-foot');
        if (body) {
          body.innerHTML =
            '<div class="disclaimer-declined">' +
            '<p class="title is-5">You declined.</p>' +
            '<p>Please close this tab to exit Trebuchet.</p>' +
            '</div>';
        }
        if (foot) foot.style.display = 'none';
      }, 50);
    });
  }
}
setupDisclaimer();

// ---------------------------------------------------------------------------
// Recovery PIN gate
// ---------------------------------------------------------------------------
//
// Saved launch wallets and Vanity CAs are encrypted behind a 4-digit Recovery
// PIN. On first run we require setup before any new real launch can persist
// secrets; on later launches we require unlock before recovery panels and
// saved Vanity CAs are loaded.
let _secretPinStatus = null;

function secretPinEls() {
  return {
    modal: document.getElementById('secretPinModal'),
    title: document.getElementById('secretPinTitle'),
    description: document.getElementById('secretPinDescription'),
    input: document.getElementById('secretPinInput'),
    confirmField: document.getElementById('secretPinConfirmField'),
    confirmInput: document.getElementById('secretPinConfirmInput'),
    submitBtn: document.getElementById('secretPinSubmitBtn'),
    statusLine: document.getElementById('secretPinModalStatus'),
    statusText: document.getElementById('secretPinStatusText'),
    unlockBtn: document.getElementById('secretPinUnlockBtn'),
    lockBtn: document.getElementById('secretPinLockBtn'),
  };
}

function normalizePinField(input) {
  if (!input) return '';
  input.value = input.value.replace(/\D/g, '').slice(0, 4);
  return input.value;
}

function waitForModalInactive(modal) {
  if (!modal || !modal.classList.contains('is-active')) return Promise.resolve();
  return new Promise((resolve) => {
    const observer = new MutationObserver(() => {
      if (!modal.classList.contains('is-active')) {
        observer.disconnect();
        resolve();
      }
    });
    observer.observe(modal, { attributes: true, attributeFilter: ['class'] });
  });
}

async function fetchSecretPinStatus() {
  const resp = await fetch('/api/secret-pin/status');
  const data = await resp.json();
  if (!resp.ok || !data.success) throw new Error(data.error || 'Could not read Recovery PIN status');
  _secretPinStatus = data.status || { configured: false, unlocked: false, locked: false };
  refreshSecretPinUi(_secretPinStatus);
  return _secretPinStatus;
}

function refreshSecretPinUi(status = _secretPinStatus) {
  const { statusText, unlockBtn, lockBtn } = secretPinEls();
  const configured = !!status?.configured;
  const unlocked = !!status?.unlocked;
  const locked = !!status?.locked;
  const protectionLabel = status?.deviceSecretProtected
    ? 'device-bound'
    : 'local fallback';

  if (statusText) {
    statusText.textContent = !configured
      ? 'PIN not set'
      : (unlocked
        ? `Unlocked for this session (${protectionLabel})`
        : (locked ? `Locked (${protectionLabel})` : `Configured (${protectionLabel})`));
  }
  if (unlockBtn) {
    unlockBtn.style.display = unlocked ? 'none' : '';
    const label = unlockBtn.querySelector('span:last-child');
    if (label) label.textContent = configured ? 'Unlock' : 'Set PIN';
  }
  if (lockBtn) {
    lockBtn.disabled = !unlocked;
    lockBtn.style.display = configured ? '' : 'none';
  }
}

function loadSecretDependentStartupState() {
  loadLaunchJournals();
  loadPendingWallets();
  if (typeof loadSavedVanityCAs === 'function') {
    loadSavedVanityCAs();
  }
}

async function showSecretPinModal(mode) {
  const els = secretPinEls();
  if (!els.modal || !els.input || !els.submitBtn || !els.statusLine) {
    _releaseStartupGate('secretPin');
    return Promise.resolve(false);
  }

  await waitForModalInactive(document.getElementById('disclaimerModal'));

  const setupMode = mode === 'setup';
  _gateStartup('secretPin');
  els.modal.classList.add('is-active');
  if (els.title) els.title.textContent = setupMode ? 'Set Recovery PIN' : 'Unlock Recovery PIN';
  if (els.description) {
    els.description.textContent = setupMode
      ? 'Choose a 4-digit PIN. Trebuchet combines it with this device to encrypt launch wallets and saved Vanity CAs.'
      : 'Enter your 4-digit PIN on this device to unlock saved launch wallets and Vanity CAs.';
  }
  if (els.confirmField) els.confirmField.classList.toggle('hidden', !setupMode);
  if (els.submitBtn) {
    const label = els.submitBtn.querySelector('span:last-child');
    if (label) label.textContent = setupMode ? 'Set PIN' : 'Unlock';
  }
  els.statusLine.textContent = '';
  els.statusLine.className = 'help secret-pin-status-line';
  els.input.value = '';
  if (els.confirmInput) els.confirmInput.value = '';
  setTimeout(() => els.input.focus(), 0);

  return new Promise((resolve) => {
    let submitting = false;

    const setStatus = (message, kind = '') => {
      els.statusLine.textContent = message || '';
      els.statusLine.className = 'help secret-pin-status-line' + (kind ? ` ${kind}` : '');
    };

    const finish = async (status) => {
      _secretPinStatus = status || await fetchSecretPinStatus();
      refreshSecretPinUi(_secretPinStatus);
      els.modal.classList.remove('is-active');
      _releaseStartupGate('secretPin');
      loadSecretDependentStartupState();
      resolve(true);
    };

    const submit = async () => {
      if (submitting) return;
      const pin = normalizePinField(els.input);
      const confirm = normalizePinField(els.confirmInput);
      if (pin.length !== 4) {
        setStatus('Enter exactly 4 digits.', 'is-danger');
        return;
      }
      if (setupMode && pin !== confirm) {
        setStatus('PINs do not match.', 'is-danger');
        return;
      }

      submitting = true;
      els.submitBtn.disabled = true;
      setStatus(setupMode ? 'Setting PIN...' : 'Unlocking...', 'is-info');
      try {
        const resp = await fetch(setupMode ? '/api/secret-pin/setup' : '/api/secret-pin/unlock', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pin }),
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok || !data.success) {
          throw new Error(data.error || `PIN request failed with HTTP ${resp.status}`);
        }
        await finish(data.status);
      } catch (e) {
        setStatus(e.message || 'PIN request failed.', 'is-danger');
        els.input.value = '';
        if (els.confirmInput) els.confirmInput.value = '';
        els.input.focus();
      } finally {
        submitting = false;
        els.submitBtn.disabled = false;
      }
    };

    els.input.oninput = () => normalizePinField(els.input);
    if (els.confirmInput) els.confirmInput.oninput = () => normalizePinField(els.confirmInput);
    els.input.onkeydown = (e) => {
      if (e.key === 'Enter') {
        if (setupMode && els.confirmInput && normalizePinField(els.input).length === 4) {
          els.confirmInput.focus();
        } else {
          submit();
        }
      }
    };
    if (els.confirmInput) {
      els.confirmInput.onkeydown = (e) => {
        if (e.key === 'Enter') submit();
      };
    }
    els.submitBtn.onclick = submit;
  });
}

async function setupSecretPinGate() {
  const els = secretPinEls();
  if (els.unlockBtn) {
    els.unlockBtn.onclick = async () => {
      const status = await fetchSecretPinStatus().catch(() => _secretPinStatus);
      await showSecretPinModal(status?.configured ? 'unlock' : 'setup');
    };
  }
  if (els.lockBtn) {
    els.lockBtn.onclick = async () => {
      try {
        const resp = await fetch('/api/secret-pin/lock', { method: 'POST' });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok || !data.success) throw new Error(data.error || 'Could not lock Recovery PIN');
        _secretPinStatus = data.status;
        refreshSecretPinUi(_secretPinStatus);
        await showSecretPinModal('unlock');
      } catch (e) {
        log(`Could not lock Recovery PIN: ${e.message}`, 'warning');
      }
    };
  }

  _gateStartup('secretPin');
  try {
    const status = await fetchSecretPinStatus();
    if (!status.configured) {
      return showSecretPinModal('setup');
    }
    if (status.locked || !status.unlocked) {
      return showSecretPinModal('unlock');
    }
    _releaseStartupGate('secretPin');
    loadSecretDependentStartupState();
    return true;
  } catch (e) {
    console.warn('Recovery PIN status unavailable:', e);
    refreshSecretPinUi({ configured: false, unlocked: false, locked: false });
    _releaseStartupGate('secretPin');
    loadSecretDependentStartupState();
    return false;
  }
}

// ---------------------------------------------------------------------------
// Universal modal close affordances
// ---------------------------------------------------------------------------
//
// Three modals in the app were originally wired only to their explicit
// footer buttons (Cancel / Keep Going / Got It / etc.) and lacked the
// click-outside-and-Esc-to-dismiss behaviour users expect from modal
// dialogs.  This block backfills both for them:
//
//   - cancelConfirmModal     (Cancel & Refund prompt from the sticky bar)
//   - transferConfirmModal   (final confirm before sweeping assets)
//   - flywheelInfoModal      (informational; already had background click,
//                             but no Esc handler)
//
// Click-outside is wired per-modal via each one's .modal-background
// element.  Esc is handled with a single delegated keydown listener on
// document — when Esc fires, we close whichever of the three modals is
// currently active.  A single listener avoids the listener-accumulation
// failure mode that bit us elsewhere, and avoids the subtle bug where
// every per-modal Esc listener would also fire even when its own modal
// isn't the topmost one.
//
// Note on stacking with confirmDialog(): confirmDialog adds its own
// ephemeral Esc handler when shown and removes it on dismiss.  In a
// stacked scenario (confirmDialog opened on top of one of these
// modals), pressing Esc would fire BOTH handlers, closing both modals.
// In practice the flows in this app never open confirmDialog while
// one of these three modals is showing (cancel/transfer modals close
// themselves before any subsequent confirm prompt; flywheel is purely
// informational and isn't a launching pad for other dialogs), so this
// is a theoretical issue, not a practical one.  Documenting it here so
// if a future flow tries to stack them, the developer knows the gotcha.
const EXTRA_CLOSE_MODAL_IDS = [
  'cancelConfirmModal',
  'transferConfirmModal',
  'flywheelInfoModal',
];
for (const modalId of EXTRA_CLOSE_MODAL_IDS) {
  const modal = document.getElementById(modalId);
  if (!modal) continue;
  const bg = modal.querySelector('.modal-background');
  if (bg) {
    bg.addEventListener('click', () => modal.classList.remove('is-active'));
  }
}
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  for (const modalId of EXTRA_CLOSE_MODAL_IDS) {
    const modal = document.getElementById(modalId);
    if (modal && modal.classList.contains('is-active')) {
      modal.classList.remove('is-active');
    }
  }
});

// ---------------------------------------------------------------------------
// Splash screen dismissal
// ---------------------------------------------------------------------------
//
// The splash markup is in index.html; this wires up:
//   - Gated playback: video only starts playing once the window has
//     focus AND no blocking modal is on the page. Without focus,
//     browsers reliably block unmuted autoplay, and starting playback
//     while a modal is up would mean audio plays under invisible UI.
//   - Dismiss on `ended` (video ran to completion), explicit user
//     skip (click backdrop, Skip button, Esc/Space/Enter), or a
//     `<video>` error (file missing, format unsupported).
//
// There's deliberately NO stall/timeout-based dismiss. If focus never
// arrives, the splash stays — but that's the right call because if the
// user isn't focused on this window, they aren't interacting with the
// app either. The moment they tab back, the video starts.
//
// Console is sprinkled with [splash] log lines so you can open dev
// tools and see what's happening if playback doesn't start.
//
// Idempotent: dismiss runs at most once. Triggers a CSS fade-out via
// the is-dismissing class, then removes the splash node entirely.
function setupSplashScreen() {
  const splash = document.getElementById('splashScreen');
  if (!splash) return; // nothing to do (e.g. someone removed the markup)

  // Gate the silent update-check until the splash is dismissed. The
  // dismiss() function below releases the gate.
  _gateStartup('splash');

  const video = document.getElementById('splashVideo');
  const skipBtn = document.getElementById('splashSkipBtn');

  document.body.classList.add('has-splash');

  let dismissed = false;
  let started = false;
  // Whether the intro-video preference allows playback. null = not yet
  // known (still reading the pref); true = allowed. We never set it false —
  // "disabled" takes the dismiss path below instead. tryStartPlayback() holds
  // off until this is true, so a disabled intro never flashes a frame.
  let playAllowed = null;

  function dismiss(reason, instant) {
    if (dismissed) return;
    dismissed = true;
    console.log('[splash] dismiss:', reason || 'unknown');
    document.body.classList.remove('has-splash');
    // Pause the video so audio stops immediately on dismiss.
    if (video) {
      try { video.pause(); } catch {}
    }
    if (instant) {
      // No fade — used when the intro is disabled in settings, so the
      // splash is removed before it ever really registers as visible.
      if (splash.parentNode) splash.parentNode.removeChild(splash);
    } else {
      splash.classList.add('is-dismissing');
      // Remove the node after the fade finishes so it isn't lingering in
      // the DOM as invisible chrome. The 500ms cushion is slightly longer
      // than the 0.4s CSS transition.
      setTimeout(() => {
        if (splash.parentNode) splash.parentNode.removeChild(splash);
      }, 500);
    }
    // Splash is dismissed — release the startup gate. If the
    // disclaimer gate is also clear, this fires the silent update
    // check.
    _releaseStartupGate('splash');
  }

  // Honour the "play intro video" preference. We optimise for the default
  // (on): the splash markup is already on screen, so we only need to bail
  // out when it's off. The read is a localhost round-trip; until it returns,
  // tryStartPlayback() holds (playAllowed === null) so the video can't start
  // under a splash we're about to remove. If it comes back disabled we
  // dismiss instantly (no fade); on any read error we fall through to
  // playing — failing toward the original behaviour.
  fetch('/api/user-prefs')
    .then((r) => r.json())
    .then((data) => {
      if (data && data.prefs && data.prefs.playIntroVideo === false) {
        dismiss('intro video disabled in settings', true);
      } else {
        playAllowed = true;
        tryStartPlayback();
      }
    })
    .catch(() => {
      playAllowed = true;
      tryStartPlayback();
    });

  // Conditions for starting playback. Both must be true:
  //   - document.hasFocus() — without focus, browsers reliably block
  //     unmuted autoplay. Even when not blocked, playing audio under
  //     a backgrounded tab is bad UX.
  //   - No .modal.is-active — a confirmation dialog or transfer modal
  //     is up. Audio playing under a dialog would be confusing.
  // Once both are true, call video.play() exactly once. If play()
  // rejects (browser still blocks autoplay despite focus, or some
  // other error), surface a click-to-play affordance: the splash
  // backdrop already accepts clicks to dismiss, but we attach a
  // one-shot click handler that retries play() instead.
  function tryStartPlayback() {
    if (started || dismissed || !video) return;
    if (playAllowed !== true) {
      // Still confirming the intro-video preference (or it's disabled and
      // a dismiss is already in flight) — don't start playback yet.
      console.log('[splash] waiting for intro-video preference');
      return;
    }
    if (!document.hasFocus()) {
      console.log('[splash] waiting for focus');
      return;
    }
    if (document.querySelector('.modal.is-active')) {
      console.log('[splash] waiting for modal to close');
      return;
    }
    started = true;
    console.log('[splash] calling play()');
    const playPromise = video.play();
    if (playPromise && typeof playPromise.then === 'function') {
      playPromise.then(() => {
        console.log('[splash] play() promise resolved');
      }).catch((err) => {
        // play() was blocked despite our gating. Common causes:
        // browser policy that requires user gesture even with focus,
        // or audio device unavailable. We let the user click the
        // splash to retry.
        console.warn('[splash] play() rejected:', err && err.message);
        started = false; // allow a click-driven retry
      });
    }
  }

  // Re-check the start condition whenever something might have
  // changed: window focus, page visibility, or after a short poll
  // interval (covers modal opens/closes that don't fire focus events).
  // Polling 4× per second is cheap and avoids hooking every modal
  // toggle code path.
  window.addEventListener('focus', tryStartPlayback);
  document.addEventListener('visibilitychange', tryStartPlayback);
  const pollHandle = setInterval(() => {
    if (dismissed) {
      clearInterval(pollHandle);
      return;
    }
    tryStartPlayback();
  }, 250);
  // Try once immediately too — if the page has focus and there are
  // no modals at load, we start right away without waiting for the
  // first poll tick.
  tryStartPlayback();

  // Lifecycle listeners — also useful for debugging.
  if (video) {
    // Track lifecycle for visibility into playback state.
    video.addEventListener('loadedmetadata', () => {
      console.log(`[splash] video metadata loaded: ${video.videoWidth}x${video.videoHeight}, ${video.duration.toFixed(1)}s`);
    });
    video.addEventListener('playing', () => {
      console.log('[splash] playback actually started');
    });
    // Auto-dismiss on natural end of playback.
    video.addEventListener('ended', () => dismiss('video ended'));
    // If the file is missing/corrupt or the format is unsupported,
    // dismiss immediately rather than leaving the user staring at a
    // broken splash. (Doesn't fire for autoplay-blocked — that's a
    // policy block, not a load error.)
    video.addEventListener('error', (e) => {
      console.warn('[splash] video error:', e && (e.message || e.type));
      dismiss('video error');
    });
  }

  // User-initiated skips. The click-on-backdrop handler does double
  // duty: if playback hasn't started yet (because play() was blocked),
  // retry play(); if it has started, dismiss. The retry path comes
  // first so a user click counts as the gesture browsers want.
  splash.addEventListener('click', () => {
    if (!started && !dismissed) {
      tryStartPlayback();
      return;
    }
    dismiss('backdrop click');
  });
  if (skipBtn) {
    skipBtn.addEventListener('click', (e) => {
      // Skip always dismisses, never retries — the user explicitly
      // chose to skip.
      e.stopPropagation();
      dismiss('skip button');
    });
  }

  // Keyboard escape hatches. Esc/Space/Enter dismiss outright. Skip
  // when there's an active modal on top of the splash (e.g. the
  // first-run disclaimer) — those keys belong to the modal in that
  // case, and dismissing the splash silently would mean the user
  // never sees the video once the modal is gone.
  function onKeydown(e) {
    if (dismissed) return;
    if (document.querySelector('.modal.is-active')) return;
    if (e.key === 'Escape' || e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      dismiss(`keydown: ${e.key}`);
    }
  }
  document.addEventListener('keydown', onKeydown);
}
setupSplashScreen();

// ===========================================================================
// User preferences (renderer side)
// ---------------------------------------------------------------------------
// The medieval gauntlet cursor theme is opt-in. It is fun as flavor, but
// custom cursor images bypass OS accessibility sizing/contrast and can make
// text entry feel imprecise, so fresh installs keep the native cursor.
// ===========================================================================
(function setupAppearance() {
  const toggle = document.getElementById('medievalCursorToggle');

  function applyCursorPreference(enabled) {
    document.body.classList.toggle('medieval-cursor', enabled);
    if (!enabled) document.body.classList.remove('cursor-clenched');
    if (toggle) toggle.checked = enabled;
  }

  // Old builds wrote medievalCursor:true into userPrefs.json as part of the
  // default-shaped prefs object even when the user only changed an unrelated
  // setting. Require the new opt-in marker too so those migrated files open
  // with the quieter native cursor.
  function cursorEnabledFromPrefs(prefs) {
    return !!(prefs && prefs.medievalCursor === true && prefs.medievalCursorOptIn === true);
  }

  applyCursorPreference(false);

  fetch('/api/user-prefs')
    .then((r) => r.json())
    .then((data) => {
      applyCursorPreference(cursorEnabledFromPrefs(data && data.prefs));
    })
    .catch((err) => {
      console.warn('Failed to read cursor preference:', err);
      applyCursorPreference(false);
    });

  if (toggle) {
    toggle.addEventListener('change', () => {
      const enabled = toggle.checked;
      applyCursorPreference(enabled);
      fetch('/api/user-prefs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          medievalCursor: enabled,
          medievalCursorOptIn: enabled,
        }),
      }).catch((err) => {
        console.warn('Failed to persist cursor preference:', err);
      });
    });
  }

  // Global mousedown clench: a click ANYWHERE adds .cursor-clenched so the
  // gauntlet shows the fist even over non-interactive space, then relaxes on
  // release. Listeners are passive — we never preventDefault.
  document.addEventListener('mousedown', () => {
    if (!document.body.classList.contains('medieval-cursor')) return;
    document.body.classList.add('cursor-clenched');
  }, { passive: true });
  document.addEventListener('mouseup', () => {
    document.body.classList.remove('cursor-clenched');
  }, { passive: true });
  // If the pointer leaves the window mid-press, clear the clench so it
  // doesn't get stuck clenched when the mouse comes back.
  window.addEventListener('blur', () => {
    document.body.classList.remove('cursor-clenched');
  });
})();

// ===========================================================================
// Intro-video preference (renderer side)
// ---------------------------------------------------------------------------
// The startup splash plays by default; the "Play the intro video on startup"
// checkbox in the settings panel lets the user turn it off. We reflect the
// persisted value into the checkbox on load and write changes back via
// /api/user-prefs. The change takes effect on the NEXT launch — the splash
// for the current session has already been decided by setupSplashScreen().
// ===========================================================================
(function setupIntroVideoPref() {
  const toggle = document.getElementById('introVideoToggle');
  if (!toggle) return;

  // Reflect the stored value. Default is on, so we only uncheck when the
  // pref is explicitly false; any read error leaves the checkbox at its
  // default-checked markup state, matching the default-on behaviour.
  fetch('/api/user-prefs')
    .then((r) => r.json())
    .then((data) => {
      if (data && data.prefs) toggle.checked = data.prefs.playIntroVideo !== false;
    })
    .catch((err) => {
      console.warn('Failed to read intro-video preference:', err);
    });

  // Persist on change, fire-and-forget — same pattern as the update-check
  // preference. If the write fails the toggle still moved visually; the
  // user can toggle again. We don't touch the current session's splash.
  toggle.addEventListener('change', () => {
    fetch('/api/user-prefs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playIntroVideo: toggle.checked }),
    }).catch((err) => {
      console.warn('Failed to persist intro-video preference:', err);
    });
  });
})();

// ===========================================================================
// Launch-report preference + "What's this?" explainer (renderer side)
// ---------------------------------------------------------------------------
// The "Publish a permanent launch report to Arweave" checkbox mirrors the
// other settings toggles: reflect the persisted value on load, persist changes
// via /api/user-prefs. The "What's this?" link opens a plain-language modal.
// The actual publishing happens server-side at step 5; this only manages the
// on/off preference and the explainer UI.
// ===========================================================================
(function setupLaunchReportPref() {
  const settingsToggle = document.getElementById('publishReportToggle');
  const stepToggle = document.getElementById('lpPublishReportToggle');
  const configToggle = document.getElementById('configPublishReportToggle');
  const toggles = [settingsToggle, stepToggle, configToggle].filter(Boolean);

  // Reflect the persisted value into every launch-report toggle on load.
  fetch('/api/user-prefs')
    .then((r) => r.json())
    .then((data) => {
      if (data && data.prefs) {
        const on = data.prefs.publishLaunchReport !== false;
        toggles.forEach((t) => { t.checked = on; });
      }
    })
    .catch((err) => {
      console.warn('Failed to read launch-report preference:', err);
    })
    .finally(() => {
      // Paint the step-5 idle hint once the toggle state is known.
      if (typeof refreshLaunchReportUi === 'function') {
        try { refreshLaunchReportUi(); } catch (_) { /* DOM may not be ready */ }
      }
    });

  // A change on any toggle persists the pref, syncs the other toggle, refreshes
  // the status surfaces, and — if turned ON after the pools are already created
  // — publishes now (the idempotency guard prevents duplicates).
  const onToggleChange = (source) => {
    const on = source.checked;
    toggles.forEach((t) => { if (t !== source) t.checked = on; });
    fetch('/api/user-prefs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ publishLaunchReport: on }),
    }).catch((err) => {
      console.warn('Failed to persist launch-report preference:', err);
    });
    if (typeof refreshLaunchReportUi === 'function') {
      try { refreshLaunchReportUi(); } catch (_) { /* no-op */ }
    }
    // The launch-report line is part of the cost estimate, so re-run the cost
    // preview whenever the toggle changes.
    if (typeof requestCostPreviewUpdate === 'function') {
      try { requestCostPreviewUpdate(); } catch (_) { /* no-op */ }
    }
    if (on && typeof publishLaunchReportToArweave === 'function'
        && typeof lpResult !== 'undefined' && lpResult
        && typeof createdTokenInfo !== 'undefined' && createdTokenInfo && createdTokenInfo.mint
        // Only publish immediately when the step-6 publish point already
        // passed while the toggle was OFF (it recorded 'skipped'). Before
        // that, flipping the pref is enough — runTransfer publishes after
        // the airdrop and before the sweep, so the permanent record gets
        // the real delivery results.
        && typeof _publishedReport !== 'undefined' && _publishedReport
        && _publishedReport.status === 'skipped') {
      publishLaunchReportToArweave();
    }
  };
  toggles.forEach((t) => t.addEventListener('change', () => onToggleChange(t)));

  // "What's this?" explainer modal. Its markup lives LATER in index.html than
  // <script src="app.js">, so it is NOT in the DOM when this runs (while the
  // openers are). Binding directly here would silently no-op. Use document-level
  // event delegation and resolve the modal at click time, so open/close work
  // regardless of parse order — the same hazard the success modal documents.
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (!t || !t.closest) return;
    // Open: any launch-report "What's this?" link (Settings, step 5, or config).
    if (t.closest('#launchReportWhatsThis, #lpReportWhatsThis, #configReportWhatsThis')) {
      e.preventDefault();
      const m = document.getElementById('launchReportInfoModal');
      if (m) m.classList.add('is-active');
      return;
    }
    // Close: the X, the "Got it" button, or a click on the modal backdrop.
    if (t.closest('#launchReportInfoClose, #launchReportInfoDone')
        || (t.matches && t.matches('#launchReportInfoModal .modal-background'))) {
      const m = document.getElementById('launchReportInfoModal');
      if (m) m.classList.remove('is-active');
    }
  });
})();
// ===========================================================================
// Demo destination wallet
// ---------------------------------------------------------------------------
// In demo mode the Step 6 "Destination Wallet" input asks for a real Solana
// address — that's friction the user shouldn't have to deal with for a
// walk-through. Auto-fill a synthetic Demo-prefixed address so the user can
// just click Transfer Assets and watch the simulated sweep complete.
//
// Generated once per session (module-scope cache) so the same address shows
// up if the field is cleared and re-applied during the same session — e.g.
// after the user clicks Cancel and refund mid-launch and the reset path
// clears the input. The user sees a stable address rather than a new random
// one each time.
//
// Uses the same Demo-prefix convention demoChainService.js uses for its
// synthetic on-chain addresses — visually consistent with the rest of the
// demo data in screenshots and the launch report.
// ===========================================================================

const _DEMO_BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
let _demoDestinationWalletCached = null;

function getDemoDestinationWallet() {
  if (_demoDestinationWalletCached) return _demoDestinationWalletCached;
  // 'DemoDest' (8 chars, all valid base58) + 24 random = 32 chars total.
  // The 'DemoDest' prefix is recognizable in screenshots as the demo sweep
  // target without the user having to know what's behind it.
  let suffix = '';
  for (let i = 0; i < 24; i++) {
    suffix += _DEMO_BASE58[Math.floor(Math.random() * _DEMO_BASE58.length)];
  }
  _demoDestinationWalletCached = 'DemoDest' + suffix;
  return _demoDestinationWalletCached;
}

// Apply the demo destination address to the Step 6 input field, plus
// swap the placeholder so it doesn't read "Your real Solana wallet
// address" while sitting next to an auto-filled synthetic one.
//
// No-op in real mode — safe to call unconditionally from anywhere that
// might clear or re-render the destination input.
function applyDemoDestinationWallet() {
  if (!demoModeActive) return;
  const input = document.getElementById('destinationWallet');
  if (!input) return;
  input.value = getDemoDestinationWallet();
  input.placeholder = 'Demo destination wallet (auto-filled)';
}

// ===========================================================================
// Demo mode (renderer side)
// ---------------------------------------------------------------------------
// On load we ask the server whether demo mode is on (/api/demo/status) and
// reflect that in the UI. Toggling the setting (or clicking the banner's
// Disable button) persists the new value via /api/user-prefs, then VERIFIES
// the change by reading /api/demo/status back before touching any demo UI.
//
// Why verify instead of trusting the POST: userPrefs.persist() swallows
// disk-write errors — set() reports success even if the write never reached
// disk (e.g. a packaged build without write access to its config folder).
// isDemoMode() on the server reads the pref fresh per request, so if the
// write silently failed the server would still be in REAL mode. Showing the
// demo banner in that case would be dangerous — it would promise "no real
// transactions" over a live server. Reading the status back closes that gap:
// we only show demo UI once the server CONFIRMS it is in demo mode.
//
// Toggling always asks for confirmation first: switching mode discards any
// current launch progress and starts over. On confirm we persist, verify
// the server entered the new mode, then reload — the most reliable way to
// reset every in-memory launch variable and restart the flow from the
// beginning in the new mode.
// ===========================================================================
// ===========================================================================
// Demo chrome: fold the demo indicator into the sticky bar when both are up.
// ---------------------------------------------------------------------------
// The demo banner and the sticky progress bar are both position:sticky at
// top:0, so during a demo launch they fight for the same spot and the higher-
// z banner hides the step/cost/cancel controls. Instead of stacking two bars,
// fold the demo badge + Disable button INTO the sticky bar whenever the bar is
// visible, and fall back to the standalone top banner only when there is no
// sticky bar to fold into (e.g. before the flow starts). Top-level (not inside
// the IIFE) so step-orchestrator.js can call it the moment the bar appears.
// ===========================================================================
function syncDemoChrome() {
  const sticky = document.getElementById('stickyBar');
  const banner = document.getElementById('demoBanner');
  const badge = document.getElementById('stickyDemoBadge');
  const disableBtn = document.getElementById('stickyDemoDisable');
  const stickyVisible = !!(sticky && sticky.classList.contains('is-visible'));
  // Fold into the sticky bar only when demo is on AND a sticky bar is showing.
  const folded = demoModeActive && stickyVisible;

  // Standalone banner only when demo is on but there's no sticky bar yet.
  if (banner) banner.style.display = (demoModeActive && !stickyVisible) ? 'flex' : 'none';
  // Sticky bar adopts the amber demo treatment and reveals its in-bar controls.
  if (sticky) sticky.classList.toggle('demo-active', folded);
  if (badge) badge.style.display = folded ? 'inline-flex' : 'none';
  if (disableBtn) disableBtn.style.display = folded ? 'inline-flex' : 'none';

  // Modal offset (--demo-banner-height) only needs to clear the STANDALONE
  // banner (z-index 100). When folded, the demo lives in the sticky bar
  // (z-index 30, below the modal layer), so the offset collapses to 0.
  const px = (banner && banner.style.display !== 'none') ? banner.offsetHeight : 0;
  document.documentElement.style.setProperty('--demo-banner-height', px + 'px');
}

(function setupDemoMode() {
  // Single source of truth for demo-dependent UI: the top banner, the Step 3
  // "Pretend funding arrived" button, and the settings checkbox.
  function applyDemoModeUi(active) {
    demoModeActive = !!active;
    const toggle = document.getElementById('demoModeToggle');
    if (toggle) toggle.checked = demoModeActive;
    const fundWrap = document.getElementById('demoFundWrap');
    if (fundWrap) fundWrap.style.display = demoModeActive ? 'block' : 'none';
    // Publish the banner's height so modals can stay clear of it. The
    // banner we just toggled above is measured here; see the CSS rules
    // on .modal / .modal-card (keyed off --demo-banner-height) for why.
    syncDemoBannerHeight();
    // Pre-fill the Step 6 destination wallet input so the user doesn't
    // need a real address to finish the demo walkthrough. No-op in
    // real mode (the helper itself gates on demoModeActive).
    applyDemoDestinationWallet();
  }

  // Republish --demo-banner-height with the banner's live pixel height so
  // the modal layer can subtract it from its max-height and shift its
  // centred card down past the banner (otherwise a tall dialog like the
  // launch-complete one runs off the bottom of the screen in demo mode).
  // Reading offsetHeight forces a synchronous layout pass, so the value
  // reflects the banner exactly as it now renders — including the taller
  // two-line state it wraps into on narrow windows. When demo mode is off
  // we publish 0px, which collapses the modal rules back to Bulma defaults.
  // Superseded by the top-level syncDemoChrome(), which also decides whether
  // the demo shows as the standalone banner or folded into the sticky bar.
  // Kept as a thin delegator so the resize listener and callers stay valid.
  function syncDemoBannerHeight() { syncDemoChrome(); }

  // The banner can wrap to a second line as the window narrows, which
  // changes its height — re-measure on resize so the modal offset tracks
  // it. Harmless while demo mode is off (resolves to 0px).
  window.addEventListener('resize', syncDemoBannerHeight);

  // Persist a new demoMode value and switch the app into it. Switching mode
  // discards the current launch and starts over, so we always confirm first —
  // EXCEPT when enabling from a pristine state (step 1, no wallet generated):
  // there is nothing to lose yet, and greeting a first-time user's "Try a
  // demo launch" click with a data-will-be-lost warning is needless friction.
  async function setDemoMode(enabled) {
    const want = !!enabled;

    // Pristine = step 1, no wallet generated, currently in real mode.
    // Enabling demo from here loses nothing, so skip the data-will-be-lost
    // dialog — greeting a first-time user's "Try a demo launch" click with
    // a scary warning is needless friction. Every other transition (any
    // progress made, or disabling) still confirms below.
    const pristine = currentStep === 1 && !tempWallet && !demoModeActive;
    const needsConfirm = !(want && pristine);

    // If a REAL launch is mid-flight (steps 2..5, and we're currently in real
    // mode), the ephemeral wallet has been stashed for recovery — surface that
    // here, since this single HTML dialog now replaces the old native one.
    const launchInProgress =
      typeof currentStep === 'number' && currentStep > 1 && currentStep < 6;
    const recoveryNote =
      launchInProgress && !demoModeActive
        ? '<p>If you already created an on-chain wallet for this launch, you ' +
          'can still recover it from the pending-wallets panel.</p>'
        : '';

    // Warn before switching: changing mode resets the app to defaults and
    // restarts the launch from the beginning, discarding anything entered
    // so far. (Skipped for the pristine enable — see above.)
    if (needsConfirm) {
      const proceed = await confirmDialog({
        title: want ? 'Enable demo mode?' : 'Disable demo mode?',
        body:
          '<p>Switching demo mode resets the app to defaults and restarts the ' +
          'launch from the beginning, with demo mode ' +
          (want ? '<strong>enabled</strong>' : '<strong>disabled</strong>') +
          '.</p><p>Any wallet, token, or pool data you have entered for the ' +
          'current launch will be lost.</p>' +
          recoveryNote,
        confirmLabel: want ? 'Enable & restart' : 'Disable & restart',
        danger: true,
      });
      if (!proceed) {
        // User backed out — put the checkbox back the way it was.
        const toggle = document.getElementById('demoModeToggle');
        if (toggle) toggle.checked = !want;
        return;
      }
    }

    try {
      const postResp = await fetch('/api/user-prefs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ demoMode: want }),
      });
      if (!postResp.ok) throw new Error('save failed (HTTP ' + postResp.status + ')');

      // Confirm the server actually entered the requested mode BEFORE we
      // reset/restart. persist() swallows disk-write errors, so a POST can
      // report success while the value never reached disk (e.g. a packaged
      // build without write access to its config folder). If it didn't take,
      // don't reload into a mismatched state — surface the reason instead.
      const statusResp = await fetch('/api/demo/status');
      const status = await statusResp.json();
      if (!!(status && status.active) !== want) {
        throw new Error(
          'the setting did not persist — the app may not have write access to ' +
          'its config folder. Demo mode was NOT changed.',
        );
      }

      // Reset to defaults and restart the launch from the beginning in the new
      // mode. A full reload is the most reliable reset: it clears every
      // in-memory launch variable and re-runs init, and the on-load path below
      // re-reads the (now-persisted) status to show or hide the demo banner.
      // Set the bypass first so the reload doesn't also trip the native
      // "launch in progress" dialog — we've already confirmed above.
      demoModeReloading = true;
      window.location.reload();
    } catch (e) {
      // Revert the checkbox to the real (unchanged) state and surface why.
      const toggle = document.getElementById('demoModeToggle');
      if (toggle) toggle.checked = !want;
      console.error('Failed to change demo mode:', e);
      log('Could not change demo mode: ' + e.message, 'danger');
    }
  }

  // Wire the settings toggle and the banner Disable button up front — they
  // exist in the DOM regardless of the current mode.
  bind('demoModeToggle', 'change', (e) => setDemoMode(e.target.checked));
  bind('demoBannerDisable', 'click', () => setDemoMode(false));
  bind('stickyDemoDisable', 'click', () => setDemoMode(false));

  // Reflect the current server state on load.
  fetch('/api/demo/status')
    .then((r) => r.json())
    .then((data) => {
      applyDemoModeUi(data && data.active);
      // Apply vanity availability — disables the Vanity CA UI when the
      // server reports the binary isn't built. CI handles release builds,
      // so end-user installs always show vanity enabled; this only
      // affects dev environments without a C toolchain.
      const vanity = data && data.vanity;
      applyVanityAvailabilityUi(vanity);
    })
    .catch((err) => {
      // If the status check fails, assume real mode (the safe default)
      // AND assume vanity is unavailable. Disabling a feature that
      // would have worked is a smaller cost than letting a request
      // fail mid-grind without an explanation.
      console.warn('Status check failed; assuming real mode + vanity disabled:', err);
      applyDemoModeUi(false);
      applyVanityAvailabilityUi({ available: false, reason: 'status check failed' });
    });
})();

// Disable Vanity CA controls and surface a friendly explanation when the
// server reports the vanity_keygen binary isn't built. Idempotent and
// safe to call before the relevant DOM elements exist — every lookup
// guards with a null check so partial DOM during startup doesn't throw.
function applyVanityAvailabilityUi(vanity) {
  const available = vanity && vanity.available;
  const target = document.getElementById('vanityCATarget');
  const endTarget = document.getElementById('vanityCAEndTarget');
  const mode = document.getElementById('vanityCAMode');
  const btn = document.getElementById('grindCABtn');
  if (available) {
    // Make sure controls are enabled (in case a prior call disabled them
    // and a later status check showed the feature came back). Rare but
    // cheap to handle.
    if (target) { target.disabled = false; target.title = ''; }
    if (endTarget) { endTarget.disabled = false; endTarget.title = ''; }
    if (mode) { mode.disabled = false; }
    if (btn) { btn.disabled = false; btn.title = ''; }
    const note = document.getElementById('vanityCAUnavailableNote');
    if (note) note.remove();
    return;
  }
  // Disabled state. Tooltip + visible help line so the user understands
  // why the button is dead. Reason comes from the server when available.
  const reason = (vanity && vanity.reason) || 'vanity address generation is not available in this build';
  if (target) { target.disabled = true; target.title = reason; }
  if (endTarget) { endTarget.disabled = true; endTarget.title = reason; }
  if (mode) { mode.disabled = true; }
  if (btn) { btn.disabled = true; btn.title = reason; }
  // Insert a help line below the existing description, so the user sees
  // an explanation in context rather than only when they hover the
  // greyed-out button. Idempotent: skip if already present.
  if (btn && !document.getElementById('vanityCAUnavailableNote')) {
    const note = document.createElement('p');
    note.id = 'vanityCAUnavailableNote';
    // Use the theme's rubric red (--rubric, #9a2424). Bulma's is-warning
    // would be yellow on the parchment background and basically illegible;
    // is-danger would work but the theme reserves stronger red for errors.
    // Rubric is the manuscript red used for accents and links throughout
    // the app, which is the right "needs attention but not catastrophic"
    // tone for a feature toggle.
    note.className = 'help is-size-7 mt-1';
    note.style.color = 'var(--rubric, #9a2424)';
    note.textContent = `Unavailable: ${reason}`;
    // Insert after the field container (the has-addons div that contains
    // the mode select, target input, and Grind button).
    const field = btn.closest('.field');
    if (field && field.parentNode) {
      field.parentNode.insertBefore(note, field.nextSibling);
    }
  }
}

setupSecretPinGate();

// Final gate evaluation. setupDisclaimer(), setupSplashScreen(), and the
// Recovery PIN gate have run by this point. If any of them gated itself,
// this call is a no-op; the trigger will fire when the last blocker clears.
_evaluateStartupGates();

// ---------------------------------------------------------------------------
// First-launch welcome card.
//
// The card (see #welcomeCard in index.html) fronts the two things a new
// user needs to know before anything else: demo mode exists and is the
// recommended first step, and a real launch needs a dedicated RPC. It is
// visible while the showWelcomeCard user pref is true and demo mode is
// off — once demo is active the sticky amber banner owns that state, and
// showing both would be noise. Dismissal persists showWelcomeCard:false.
// ---------------------------------------------------------------------------
(function setupWelcomeCard() {
  const card = document.getElementById('welcomeCard');
  if (!card) return;

  // Visibility: all fetches are best-effort. If prefs can't be read we
  // default to SHOWING the card (a new install with a broken prefs read
  // is exactly a first-time user); if the demo status can't be read we
  // fall back to the in-memory flag set by setupDemoMode's own fetch.
  //
  // Recovery state outranks onboarding: someone with an incomplete launch
  // or a pending recovery wallet is not a first-timer, and their money
  // comes before a getting-started card — the recovery panels should be
  // the first thing they see, not sit below it. If either recovery
  // lookup fails we treat it as "none" (the panels themselves surface
  // independently either way).
  Promise.allSettled([
    fetch('/api/user-prefs').then((r) => r.json()),
    fetch('/api/demo/status').then((r) => r.json()),
    fetch('/api/pending-wallets').then((r) => r.json()),
    fetch('/api/launch-journals').then((r) => r.json()),
  ]).then(([prefsRes, demoRes, walletsRes, journalsRes]) => {
    const prefs = prefsRes.status === 'fulfilled' ? prefsRes.value : {};
    const demoActive = demoRes.status === 'fulfilled'
      ? !!(demoRes.value && demoRes.value.active)
      : !!demoModeActive;
    const pendingCount = walletsRes.status === 'fulfilled'
      ? (walletsRes.value?.wallets?.length || 0)
      : 0;
    const journalCount = journalsRes.status === 'fulfilled'
      ? (journalsRes.value?.journals?.length || 0)
      : 0;
    const hasRecoveryState = pendingCount > 0 || journalCount > 0;
    const wantCard = prefs.showWelcomeCard !== false;
    card.classList.toggle('hidden', !wantCard || demoActive || hasRecoveryState);
  });

  // "Try a demo launch" — drive the settings checkbox and fire its change
  // handler so the exact same setDemoMode path runs (persist, verify,
  // reload). From a pristine state that path skips the reset warning.
  // The persist + verify round-trips take a beat before the reload, so
  // show a spinner immediately — a dead-looking button on a first-timer's
  // very first click reads as "the app is broken".
  bind('welcomeTryDemoBtn', 'click', (e) => {
    const btn = e.currentTarget;
    btn.classList.add('is-loading');
    btn.disabled = true;
    const toggle = document.getElementById('demoModeToggle');
    if (!toggle) return;
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));
    // If enabling fails or is cancelled, setDemoMode reverts the checkbox
    // and the page never reloads — poll for that and restore the button.
    // (A one-shot timeout isn't enough: the mid-launch confirm dialog can
    // stay open arbitrarily long before the user cancels.) On success the
    // reload wipes this interval with the page. The 60s cap restores the
    // button even if something failed without reverting the checkbox.
    let waited = 0;
    const poll = setInterval(() => {
      waited += 500;
      if (!toggle.checked || waited >= 60000) {
        btn.classList.remove('is-loading');
        btn.disabled = false;
        clearInterval(poll);
      }
    }, 500);
  });

  // "Set up my RPC" — expand the settings panel and land on the RPC
  // section (helper lives in rpc-panel.js next to the panel logic).
  bind('welcomeOpenRpcBtn', 'click', () => openSettingsToRpc());

  // "Don't show this again" — persist and hide. Fire-and-forget on the
  // POST: if it fails the card reappears next session, which is annoying
  // but harmless, and the hide itself should feel instant.
  bind('welcomeHideLink', 'click', (e) => {
    e.preventDefault();
    card.classList.add('hidden');
    fetch('/api/user-prefs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ showWelcomeCard: false }),
    }).catch(() => {});
  });
})();
