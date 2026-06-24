// userPrefs.js
//
// Manages a small JSON file (userPrefs.json) of user-toggleable
// preferences. Currently just one knob:
//
//   checkForUpdatesOnStartup (default: true)
//     Controls whether the app automatically checks for a newer
//     release a couple of seconds after the window appears. The
//     manual "Help → Check for Updates" menu item always works
//     regardless of this setting.
//
// Modelled on rpcConfig.js — same TREBUCHET_CONFIG_DIR convention,
// same lazy-load pattern, same defensive error handling.
//
// File format is intentionally simple so it's easy to hand-edit if
// someone needs to:
//   { "checkForUpdatesOnStartup": false }

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Same env-var convention as rpcConfig.js / pendingWallets.js. main.js
// sets this to app.getPath('userData') in the Electron build; left
// unset by the web build (npm run web) so writes land alongside the
// source. Either way the file is small and safe to manage.
//
// IMPORTANT: resolve the directory LAZILY on every call, not once at
// module-import time. main.js imports this module at startup, which is
// BEFORE it sets TREBUCHET_CONFIG_DIR = app.getPath('userData') inside
// startServer(). If we froze the path at import we'd capture __dirname,
// which in a packaged build lives inside the read-only asar archive —
// every write would then silently fail (persist() swallows the error) and
// no preference would ever stick. Reading process.env on each call means
// get()/set() — which only run well after startup — always see userData.
function configDir() {
  return process.env.TREBUCHET_CONFIG_DIR || __dirname;
}
function configFile() {
  return path.join(configDir(), 'userPrefs.json');
}

// Defaults — also the schema for what fields exist. Anything not
// listed here is silently dropped on set(); anything missing from
// disk is filled in from here on get().
const DEFAULTS = Object.freeze({
  checkForUpdatesOnStartup: true,
  // Medieval gauntlet cursor theme. Off by default — covers every
  // cursor state (idle, pointer, active, text, wait, resize, etc.)
  // with hand-and-quill artwork. Can be turned off in settings for
  // users who rely on OS cursor-size / high-contrast accessibility
  // overrides, since custom cursors bypass those.
  medievalCursor: false,
  // Migration guard for the cursor theme. Older builds persisted the full
  // default-shaped prefs object whenever any setting changed, so many users
  // have medievalCursor:true on disk even though they never opted in. The
  // renderer only enables the theme when both fields are true; the settings
  // checkbox writes both fields together from now on.
  medievalCursorOptIn: false,
  // 3D spinning coin in the token preview card. On by default; can be
  // turned off (falls back to the flat logo) for weak hardware or
  // personal preference.
  coinPreview: true,
  coinPreviewParked: false,
  // Demo mode. When true, every chain-touching API simulates its result —
  // no transactions are sent and no SOL is spent. Intended for testing UI
  // changes, capturing tutorial screenshots, and demonstrating the app
  // without chain risk. Off by default; intentional opt-in only.
  demoMode: false,
  // Intro splash video. The short animation that plays on startup. On by
  // default; can be turned off in settings so the app opens straight to the
  // UI (handy once the novelty wears off, or on slow hardware). Read by the
  // renderer's setupSplashScreen() on load — disabled means the splash is
  // dismissed immediately and never plays.
  playIntroVideo: true,
  // Click sound effect. A short tick played when the user activates a button
  // or other clickable control. On by default; toggled in settings. Handled
  // entirely in the renderer (public/modules/audio.js) — the server only
  // stores the flag.
  playSoundEffects: true,
  // Looping background music. Starts once the intro splash is gone and the
  // user has interacted with the page. Off by default; toggled in settings.
  // Like the sound effect, this is renderer-side only.
  playBackgroundMusic: false,
  // Publish a permanent launch report to Arweave (a machine-readable JSON
  // plus the rendered HTML) after a launch completes, tagged so anyone can
  // find it from the token mint — without writing anything onto the token's
  // own metadata. On by default; opt-out for users who don't want their
  // token associated with the launchpad (e.g. a corporate launch). The
  // report is signed by the launch wallet, so it's verifiable against
  // on-chain state, and a failed publish never blocks or fails a launch.
  publishLaunchReport: true,
});

// Lazy-loaded in-memory cache. We refresh from disk on every get()
// because writes can come from either the main process (e.g. future
// auto-pref-update logic) or the renderer (via the /api/user-prefs
// POST endpoint in server.js), and we want both readers to see each
// other's writes without needing IPC plumbing.
//
// The file is tiny (a few bytes) so re-reading on every get() costs
// effectively nothing.

// ---------------------------------------------------------------------------
// File I/O
// ---------------------------------------------------------------------------

function loadFromDisk() {
  try {
    if (fs.existsSync(configFile())) {
      const raw = fs.readFileSync(configFile(), 'utf8');
      const parsed = JSON.parse(raw);
      // Merge over defaults so missing fields take their default and
      // unknown fields are ignored (next persist() will drop them).
      const merged = { ...DEFAULTS };
      for (const key of Object.keys(DEFAULTS)) {
        if (Object.prototype.hasOwnProperty.call(parsed, key)) {
          merged[key] = parsed[key];
        }
      }
      return merged;
    }
  } catch (e) {
    console.warn('userPrefs: failed to load, using defaults:', e.message);
  }
  return { ...DEFAULTS };
}

function persist(state) {
  try {
    // mkdirSync recursive is a no-op if the directory already exists,
    // so this is safe to call on every save. Necessary on first run
    // when the config dir may be a userData path that hasn't been created
    // yet.
    fs.mkdirSync(configDir(), { recursive: true });
    fs.writeFileSync(configFile(), JSON.stringify(state, null, 2) + '\n');
  } catch (e) {
    console.error('userPrefs: failed to save:', e.message);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read the current preferences. Always returns a fully-populated
 * object — any missing keys are filled in from DEFAULTS. The returned
 * object is a fresh copy each call, so callers can't accidentally
 * mutate our state by holding onto a reference.
 */
export function get() {
  return loadFromDisk();
}

/**
 * Merge a partial preferences object into the persisted state.
 * Only known keys (those present in DEFAULTS) are applied; unknown
 * keys are ignored. Type-checks each value against the default's
 * type so a bad client can't write garbage in.
 *
 * Returns the fully-populated post-write state.
 */
export function set(partial) {
  if (!partial || typeof partial !== 'object') {
    return get();
  }
  const current = loadFromDisk();
  for (const key of Object.keys(DEFAULTS)) {
    if (!Object.prototype.hasOwnProperty.call(partial, key)) continue;
    const incoming = partial[key];
    // Reject if the incoming value's type doesn't match the default's.
    // This is a soft guard — keeps boolean prefs from being set to
    // strings/numbers by a buggy client, without needing a full
    // schema library.
    if (typeof incoming !== typeof DEFAULTS[key]) continue;
    current[key] = incoming;
  }
  persist(current);
  return current;
}
