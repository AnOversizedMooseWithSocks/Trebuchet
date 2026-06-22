// audio.js — sound effects and looping background music
//
// All sound here is built on plain HTMLAudioElement. There is deliberately NO
// Web Audio graph: a small pool of <audio> elements per sound is far easier to
// read and maintain, and most of our effects are triggered by a user gesture
// (a click, a checkbox, a menu pick), so the browser autoplay policy never
// gets in our way for them.
//
// Sound effects (all gated by the single playSoundEffects preference):
//   - click    (audio/click.flac)      a button or other clickable control
//   - menu     (audio/menuSelect.wav)  a <select> dropdown item is chosen
//   - checkbox (audio/checkbox.wav)    a checkbox is ticked or unticked
//   - coins    (audio/coins.wav)       the running SOL launch-cost estimate
//                                       changes to a new value
//   - expand       (audio/expand.wav)        a <details> panel opens
//   - collapse     (audio/collapse.ogg)      a <details> panel closes
//   - expandStep   (audio/expandStep.ogg)    a step card is opened for review
//   - collapseStep (audio/collapseStep.ogg)  a step card is collapsed again
//
// Background music (gated by the playBackgroundMusic preference):
//   - warTheme.mp3, looped. We try to start it the moment the app loads — in
//     the packaged Electron build the autoplay policy is relaxed, so it begins
//     immediately, playing under the first startup dialog. In a plain browser
//     (the `npm run web` build) the first play() is blocked until a gesture, so
//     we also retry on focus and on the first interaction. It fades in rather
//     than slamming on at full volume, and pauses while the window is hidden.
//
// Each sound effect keeps a POOL of preloaded elements so repeated triggers
// overlap cleanly instead of cutting each other off — a single <audio> can
// only play one instance of itself at a time.
//
// Everything here is defensive. A missing file, a blocked play() call, or an
// absent DOM element all degrade silently to "no sound" rather than throwing
// and taking the rest of the page down with them.
(function setupAudio() {
  // ---- Sound effect catalogue -------------------------------------------
  // One entry per effect. `volume` is 0..1; `poolSize` is how many overlapping
  // copies to keep ready (more for sounds that can fire in fast succession).
  // Paths are relative to the page (served from public/ by express.static).
  const SOUNDS = {
    click:    { url: 'audio/click.flac',     volume: 0.5, poolSize: 4 },
    menu:     { url: 'audio/menuSelect.wav', volume: 0.5, poolSize: 3 },
    checkbox: { url: 'audio/checkbox.wav',   volume: 0.5, poolSize: 3 },
    coins:    { url: 'audio/coins.wav',      volume: 0.5, poolSize: 2 },
    // Panel (a <details> disclosure) and whole-step expand/collapse.
    expand:       { url: 'audio/expand.wav',       volume: 0.5, poolSize: 2 },
    collapse:     { url: 'audio/collapse.ogg',     volume: 0.5, poolSize: 2 },
    expandStep:   { url: 'audio/expandStep.ogg',   volume: 0.5, poolSize: 2 },
    collapseStep: { url: 'audio/collapseStep.ogg', volume: 0.5, poolSize: 2 },
    // Played when the launch-success modal appears — the payoff moment of
    // the whole flow, so it sits a notch above the UI ticks.
    launch:       { url: 'audio/launch.ogg',       volume: 0.6, poolSize: 1 },
  };

  // What counts as "a clickable control" for the click sound. We match the
  // element itself OR any ancestor (via closest), so a click on the <span>/<i>
  // inside a Bulma button still ticks. Inputs, checkboxes, and <select>s are
  // intentionally absent — those get their own dedicated sounds below, so they
  // must not also fire the generic click.
  const CLICKABLE_SELECTOR = [
    'button',
    '.button',
    '[role="button"]',
    'a.button',
  ].join(',');

  // The element whose text shows the running launch-cost estimate. It is only
  // ever written with the actual SOL figure (the loading/error states live on
  // other elements), so watching its text for changes is a clean signal that
  // the total estimate moved.
  const COST_ELEMENT_ID = 'stickyCostValue';

  const MUSIC_URL = 'audio/warTheme.mp3';
  const MUSIC_VOLUME = 0.3;     // sits underneath the UI, ambient not loud
  const MUSIC_FADE_MS = 1500;   // fade-in (and fade-out on toggle/hide)

  // ---- State -------------------------------------------------------------
  // Preference flags. Sound effects default on. Background music defaults off
  // and only starts when the persisted value is explicitly true.
  let sfxEnabled = true;
  let musicEnabled = false;

  // name -> { pool: [HTMLAudioElement], index: roundRobinCursor }
  const sfxBank = {};

  // The single looping music element, its fade timer, and whether playback has
  // actually begun (so we only fade-in once and don't fight ourselves).
  let musicEl = null;
  let musicFadeTimer = null;
  let musicStarted = false;

  // Last cost text we played the coins sound for, so re-rendering the same
  // value (which happens as multiple pools resolve) doesn't re-trigger it.
  let lastCostText = '';

  // ---- Sound effect engine ----------------------------------------------
  // Build the pool for one named sound. Each element is a detached <audio>
  // (an HTMLAudioElement plays fine without being in the DOM) with the source
  // assigned and preload hinted so the file is ready before the first trigger.
  function buildPool(name) {
    const def = SOUNDS[name];
    const pool = [];
    for (let i = 0; i < def.poolSize; i++) {
      const a = new Audio(def.url);
      a.preload = 'auto';
      a.volume = def.volume;
      pool.push(a);
    }
    sfxBank[name] = { pool, index: 0 };
  }

  // Play one instance of a named sound. We grab the next element in its pool,
  // rewind it to the start (in case it's mid-play from a very recent trigger),
  // and play. play() returns a promise that can reject (e.g. the file failed
  // to load); we swallow that — a missing effect shouldn't surface an error.
  function playSfx(name) {
    if (!sfxEnabled) return;
    const bank = sfxBank[name];
    if (!bank || bank.pool.length === 0) return;
    const el = bank.pool[bank.index];
    bank.index = (bank.index + 1) % bank.pool.length;
    try {
      el.currentTime = 0;
      const p = el.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch (_) {
      // Ignore — never let a sound effect break a real interaction.
    }
  }

  // ---- Delegated input listeners ----------------------------------------
  // One click listener for the whole page, in the CAPTURE phase so it still
  // fires for handlers that stopPropagation() on the way up. Skips disabled
  // and static controls so a greyed-out button stays silent.
  function onDocumentClick(e) {
    const target = e.target;
    if (!target || typeof target.closest !== 'function') return;
    const control = target.closest(CLICKABLE_SELECTOR);
    if (!control) return;
    if (control.disabled || control.classList.contains('is-static')) return;
    playSfx('click');
    // A click is a user gesture — a good moment to (re)try music if the web
    // build is still waiting for one.
    tryStartMusic();
  }

  // The change event is the precise "value committed" signal for both form
  // controls: a <select> fires it when the user picks a different option, and
  // a checkbox fires it when toggled. We listen once on the document so this
  // covers controls that are injected later, not just those present at load.
  function onDocumentChange(e) {
    const el = e.target;
    if (!el || !el.tagName) return;
    const tag = el.tagName.toLowerCase();
    if (tag === 'select') {
      playSfx('menu');
    } else if (tag === 'input' && el.type === 'checkbox') {
      playSfx('checkbox');
    }
    tryStartMusic();
  }

  // ---- Launch-cost watcher ----------------------------------------------
  // Watch the cost readout's text. When it changes to a new, non-placeholder
  // value, play the coins sound. Using a MutationObserver keeps this fully
  // decoupled from whatever code computes and writes the estimate.
  function watchCostEstimate() {
    const el = document.getElementById(COST_ELEMENT_ID);
    if (!el || typeof MutationObserver === 'undefined') return;

    // Seed with the current text so the initial placeholder (an em-dash)
    // doesn't count as a change the first time the observer fires.
    lastCostText = (el.textContent || '').trim();

    const isRealCost = (txt) => /\d/.test(txt); // must contain a digit

    const observer = new MutationObserver(() => {
      const txt = (el.textContent || '').trim();
      if (txt === lastCostText) return;       // no actual change
      const changed = txt;
      lastCostText = txt;
      if (isRealCost(changed)) playSfx('coins');
    });
    observer.observe(el, { childList: true, characterData: true, subtree: true });
  }

  // ---- Panel and step expand/collapse -----------------------------------
  // The native <details>/<summary> disclosure is this app's standard
  // collapsible panel (Advanced options, the airdrop section, the per-phase
  // descriptions, and so on). Each fires a `toggle` event whose .open tells
  // us which way it went. `toggle` does not bubble, but the capture phase
  // still reaches the document, so one capture-phase listener covers every
  // <details> on the page, including those injected into the DOM later.
  function watchDetailsPanels() {
    document.addEventListener('toggle', (e) => {
      const el = e.target;
      if (!el || el.tagName !== 'DETAILS') return;
      playSfx(el.open ? 'expand' : 'collapse');
    }, true);
  }

  // The six step cards expand/collapse for review via the `is-peeking` marker
  // class: the step-header click handler adds it when the user opens a
  // completed step, and setStepState() clears it when the step closes again.
  // Normal forward progression through the flow never sets it, so watching
  // that one class gives a clean "user expanded / collapsed a step" signal
  // with no false positives from advancing the launcher.
  function watchStepCards() {
    if (typeof MutationObserver === 'undefined') return;
    for (let i = 1; i <= 6; i++) {
      const card = document.getElementById(`step${i}-card`);
      if (!card) continue;
      let wasPeeking = card.classList.contains('is-peeking');
      const observer = new MutationObserver(() => {
        const now = card.classList.contains('is-peeking');
        if (now === wasPeeking) return;
        wasPeeking = now;
        playSfx(now ? 'expandStep' : 'collapseStep');
      });
      observer.observe(card, { attributes: true, attributeFilter: ['class'] });
    }
  }

  // ---- Launch-success fanfare ---------------------------------------------
  // Play the launch sound whenever the launch-success modal appears. Watching
  // the modal's class (Bulma modals show via is-active) keeps this module
  // self-contained — no call site needed in the modal-opening code, same as
  // every other trigger in this file.
  //
  // Wrinkle: the modal markup lives LATER in index.html than the app.js
  // script tag (see the lazy-wire comment in showLaunchSuccessModal), so the
  // element isn't in the DOM yet when this module boots. Try immediately for
  // safety, and fall back to wiring at DOMContentLoaded.
  function watchLaunchSuccessModal() {
    if (typeof MutationObserver === 'undefined') return;
    const wire = () => {
      const modal = document.getElementById('launchSuccessModal');
      if (!modal) return false;
      let wasActive = modal.classList.contains('is-active');
      const observer = new MutationObserver(() => {
        const now = modal.classList.contains('is-active');
        if (now === wasActive) return;
        wasActive = now;
        if (now) playSfx('launch');
      });
      observer.observe(modal, { attributes: true, attributeFilter: ['class'] });
      return true;
    };
    if (wire()) return;
    document.addEventListener('DOMContentLoaded', wire, { once: true });
  }

  // ---- Background music --------------------------------------------------
  // Create the looping music element on demand. Starts silent (volume 0) so
  // the fade-in has somewhere to climb from.
  function ensureMusicEl() {
    if (musicEl) return musicEl;
    musicEl = new Audio(MUSIC_URL);
    musicEl.loop = true;
    musicEl.preload = 'auto';
    musicEl.volume = 0;
    return musicEl;
  }

  // Linear volume fade on the music element. Clears any in-flight fade first so
  // toggling quickly doesn't leave two timers fighting over the volume.
  function fadeMusicTo(targetVolume, durationMs, onDone) {
    if (!musicEl) return;
    if (musicFadeTimer) {
      clearInterval(musicFadeTimer);
      musicFadeTimer = null;
    }
    const stepMs = 50;
    const steps = Math.max(1, Math.round(durationMs / stepMs));
    const start = musicEl.volume;
    const delta = targetVolume - start;
    let i = 0;
    musicFadeTimer = setInterval(() => {
      i++;
      const v = start + (delta * i) / steps;
      // Clamp — floating-point drift could otherwise push slightly past the
      // 0..1 range that .volume requires.
      musicEl.volume = Math.min(1, Math.max(0, v));
      if (i >= steps) {
        clearInterval(musicFadeTimer);
        musicFadeTimer = null;
        if (typeof onDone === 'function') onDone();
      }
    }, stepMs);
  }

  // Try to start the music. Idempotent: the musicStarted guard means repeated
  // calls (from boot, focus, first gesture, etc.) are harmless. If play() is
  // rejected — the plain-browser autoplay block before any gesture — we leave
  // musicStarted false so the next trigger retries.
  function tryStartMusic() {
    if (musicStarted || !musicEnabled) return;
    const el = ensureMusicEl();
    const p = el.play();
    if (p && typeof p.then === 'function') {
      p.then(() => {
        musicStarted = true;
        fadeMusicTo(MUSIC_VOLUME, MUSIC_FADE_MS);
      }).catch(() => {
        musicStarted = false; // blocked — a later gesture will retry
      });
    } else {
      // Older engines: play() returned no promise. Assume it started.
      musicStarted = true;
      fadeMusicTo(MUSIC_VOLUME, MUSIC_FADE_MS);
    }
  }

  // Fade out, then pause. Used when the user turns music off.
  function fadeOutAndPause() {
    if (!musicEl) return;
    fadeMusicTo(0, MUSIC_FADE_MS, () => {
      try { musicEl.pause(); } catch (_) {}
    });
  }

  // ---- Preference wiring -------------------------------------------------
  // Read persisted prefs once on load. On any read error we keep the quiet
  // music default while leaving sound effects on.
  function loadPrefs() {
    fetch('/api/user-prefs')
      .then((r) => r.json())
      .then((data) => {
        if (data && data.prefs) {
          sfxEnabled = data.prefs.playSoundEffects !== false;
          musicEnabled = data.prefs.playBackgroundMusic === true;
        }
        const sfxToggle = document.getElementById('soundEffectsToggle');
        if (sfxToggle) sfxToggle.checked = sfxEnabled;
        const musicToggle = document.getElementById('backgroundMusicToggle');
        if (musicToggle) musicToggle.checked = musicEnabled;
        // If music is allowed, try to start now (the prefs round-trip may have
        // resolved after our initial boot attempt).
        tryStartMusic();
      })
      .catch((err) => {
        console.warn('audio: failed to read preferences, using defaults:', err);
      });
  }

  // Persist a single pref, fire-and-forget — same pattern as the intro-video
  // and update-check toggles. If the write fails the checkbox still moved
  // visually and the in-memory flag is already updated, so the current session
  // behaves as the user expects; only persistence across restarts is at risk.
  function persistPref(key, value) {
    fetch('/api/user-prefs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [key]: value }),
    }).catch((err) => {
      console.warn(`audio: failed to persist ${key}:`, err);
    });
  }

  function wireSettingsToggles() {
    const sfxToggle = document.getElementById('soundEffectsToggle');
    if (sfxToggle) {
      sfxToggle.addEventListener('change', () => {
        sfxEnabled = sfxToggle.checked;
        persistPref('playSoundEffects', sfxEnabled);
      });
    }

    const musicToggle = document.getElementById('backgroundMusicToggle');
    if (musicToggle) {
      musicToggle.addEventListener('change', () => {
        musicEnabled = musicToggle.checked;
        persistPref('playBackgroundMusic', musicEnabled);
        if (musicEnabled) {
          tryStartMusic();        // the checkbox click is itself a gesture
        } else if (musicStarted) {
          fadeOutAndPause();
          musicStarted = false;
        }
      });
    }
  }

  // ---- Lifecycle ---------------------------------------------------------
  // First-gesture retry for the plain-browser build, where the initial boot
  // play() is blocked until the user interacts. pointerdown/keydown cover
  // mouse, touch, and keyboard. Once music has started we stop listening.
  function onFirstGesture() {
    tryStartMusic();
    if (musicStarted) {
      window.removeEventListener('pointerdown', onFirstGesture, true);
      window.removeEventListener('keydown', onFirstGesture, true);
    }
  }

  // Be a good neighbour: pause when the tab/window is hidden, resume when it
  // comes back (only if the user still wants music). When it hasn't started
  // yet, a return-to-visible is also a fine moment to try.
  function onVisibilityChange() {
    if (document.hidden) {
      if (musicEl && musicStarted) {
        try { musicEl.pause(); } catch (_) {}
      }
      return;
    }
    if (musicStarted && musicEl) {
      const p = musicEl.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } else {
      tryStartMusic();
    }
  }

  // ---- Boot --------------------------------------------------------------
  for (const name of Object.keys(SOUNDS)) buildPool(name);
  document.addEventListener('click', onDocumentClick, true);
  document.addEventListener('change', onDocumentChange, true);
  window.addEventListener('pointerdown', onFirstGesture, true);
  window.addEventListener('keydown', onFirstGesture, true);
  window.addEventListener('focus', tryStartMusic);
  document.addEventListener('visibilitychange', onVisibilityChange);
  watchCostEstimate();
  watchDetailsPanels();
  watchStepCards();
  watchLaunchSuccessModal();
  // If the loaded preference allows music, loadPrefs() starts it. This early
  // call stays harmless because musicEnabled defaults to false until then.
  tryStartMusic();
  loadPrefs();
  wireSettingsToggles();
})();
