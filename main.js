// main.js — Electron entry point.
//
// Strategy: pick a free port, hand it to the Express server via
// process.env.PORT, side-effect-import server.js (which calls app.listen
// during module init), wait for it to actually be listening, then open
// a BrowserWindow pointed at it.
//
// Why this approach: trebuchet was originally built as a web app —
// Express backend plus a static frontend that talks to it via
// fetch('/api/...'). Wrapping it like this means *zero* changes to the
// frontend code; every fetch call works identically to the standalone
// web build. The trade-off is that we're carrying Express around inside
// a desktop app, which is fine in practice — plenty of real Electron
// apps are built this way.

import { app, BrowserWindow, Menu, shell, safeStorage, dialog } from 'electron';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';

import * as secretStore from './secretStore.js';
import * as userPrefs from './userPrefs.js';
import * as updateCheckBridge from './updateCheckBridge.js';
import {
  compareVersions,
  pickAssetForPlatform,
  parseReleaseTag,
  pickLatestRelease,
} from './updateCheck.js';

// __dirname equivalent in ESM. Used to resolve sibling files like README.md.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Right-click context menu.
//
// Electron's BrowserWindow has *no* context menu by default — right-clicking
// does literally nothing unless you wire it up. That breaks user expectation
// in form fields especially: people expect to be able to right-click → Paste
// a wallet address rather than always having to use Ctrl+V. This adds a
// per-context menu with the standard edit actions when right-clicking in a
// text field, plain Copy/Select All when right-clicking on selected text,
// and Inspect Element so we can debug layout issues without having to
// manually open DevTools through a key combo.
//
// Called once per BrowserWindow's webContents.
// ---------------------------------------------------------------------------
function attachContextMenu(webContents) {
  webContents.on('context-menu', (_event, params) => {
    const items = [];

    if (params.isEditable) {
      // Right-click inside a <input>, <textarea>, or contenteditable.
      // The editFlags tell us which actions are actually applicable
      // right now (e.g. Paste is greyed out if the clipboard is empty),
      // so we honour them rather than always enabling everything.
      items.push({ role: 'undo',      enabled: params.editFlags.canUndo });
      items.push({ role: 'redo',      enabled: params.editFlags.canRedo });
      items.push({ type: 'separator' });
      items.push({ role: 'cut',       enabled: params.editFlags.canCut });
      items.push({ role: 'copy',      enabled: params.editFlags.canCopy });
      items.push({ role: 'paste',     enabled: params.editFlags.canPaste });
      items.push({ type: 'separator' });
      items.push({ role: 'selectAll', enabled: params.editFlags.canSelectAll });
    } else if (params.selectionText && params.selectionText.trim().length > 0) {
      // Right-click on selected text in a non-editable region — e.g.
      // copying a generated wallet address from the read-only display.
      items.push({ role: 'copy' });
      items.push({ type: 'separator' });
      items.push({ role: 'selectAll' });
    } else {
      // Nothing useful to do besides Select All. Keeping the menu present
      // (even if minimal) makes the app feel less broken than no menu at all.
      items.push({ role: 'selectAll' });
    }

    // Inspect Element is always available. This is a developer-oriented
    // tool, and being able to right-click → Inspect saves time when
    // diagnosing layout, focus, or styling issues.
    items.push({ type: 'separator' });
    items.push({
      label: 'Inspect Element',
      click: () => webContents.inspectElement(params.x, params.y),
    });

    const win = BrowserWindow.fromWebContents(webContents);
    Menu.buildFromTemplate(items).popup({ window: win });
  });
}

// ---------------------------------------------------------------------------
// External URLs that the menu links to.
// ---------------------------------------------------------------------------
const URLS = {
  website:         'https://makesometokens.com/',
  raydiumClmm:     'https://docs.raydium.io/raydium/for-liquidity-providers/pool-types/clmm-concentrated',
  raydiumBurnEarn: 'https://docs.raydium.io/raydium/for-liquidity-providers/burn-and-earn',
  helius:          'https://www.helius.dev/',
  github:          'https://github.com/AnOversizedMooseWithSocks/trebuchet',
};

function openExternalSafe(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    console.warn(`Blocked invalid external URL: ${rawUrl}`);
    return;
  }

  if (url.protocol !== 'https:') {
    console.warn(`Blocked external URL with disallowed protocol: ${url.protocol}`);
    return;
  }

  shell.openExternal(url.toString());
}

// ---------------------------------------------------------------------------
// Update checking.
//
// The "Check for Updates" menu item fetches the latest release info
// from GitHub, compares the tag against the version baked into this
// build, and pushes a result to the renderer for display. The renderer
// owns the modal UI (window.__showUpdateResult); we just hand it a
// data object describing what to show.
//
// Why everything runs in main rather than the renderer:
//   - app.getVersion() lives here, not in the renderer
//   - process.platform / process.arch are available here for picking
//     the right OS-specific asset
//   - we avoid any CORS concerns with the GitHub API
//   - the renderer remains fully sandboxed (no IPC, no preload)
//
// Communication is one-way: main → renderer via executeJavaScript,
// which evaluates code in the page's JS context. That reaches
// window.__showUpdateResult, defined in public/app.js.
// ---------------------------------------------------------------------------
// The repo path here MUST match the canonical case on GitHub
// (capital T in "Trebuchet"). GitHub's REST API returns 404 on a
// case mismatch — unlike the browser-facing github.com URLs, which
// follow a case-insensitive redirect. The repository.url field in
// package.json is the source of truth for the canonical case; the
// release-workflow test cross-checks that they agree.
//
// We fetch /releases (not /releases/latest) because /releases/latest
// is documented as "the most recent non-prerelease, non-draft
// release". Trebuchet's publish-release.mjs marks releases as
// prerelease when any artifact is unsigned — true for every release
// until code-signing certs are configured. So /releases/latest 404s
// here. /releases returns everything (sorted newest-first), and we
// pick the newest non-draft entry via pickLatestRelease.
const UPDATE_API_URL =
  'https://api.github.com/repos/AnOversizedMooseWithSocks/Trebuchet/releases?per_page=5';

// Pure update-check helpers (compareVersions, pickAssetForPlatform,
// parseReleaseTag) live in updateCheck.js so they can be unit-tested
// without pulling in Electron. main.js handles only the integration:
// menu wiring, the HTTPS call, and the executeJavaScript handoff to
// the renderer.

// Promisified HTTPS GET that returns parsed JSON. Used only for the
// GitHub API call — kept here rather than as a general utility so it
// can hard-code the User-Agent and Accept headers GitHub expects.
function httpsGetJson(url, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        // GitHub's API rejects requests without a User-Agent.
        'User-Agent': `Trebuchet/${app.getVersion()}`,
        // Pin the API version we're targeting.
        'Accept': 'application/vnd.github+json',
      },
    }, (res) => {
      // Follow one level of redirect — GitHub occasionally 301s.
      if (res.statusCode === 301 || res.statusCode === 302) {
        const next = res.headers.location;
        res.resume(); // drain
        if (next) return resolve(httpsGetJson(next, timeoutMs));
        return reject(new Error('Got a redirect with no Location header'));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`GitHub API returned status ${res.statusCode}`));
      }
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(raw));
        } catch (err) {
          reject(new Error('GitHub API returned invalid JSON'));
        }
      });
    });
    // setTimeout fires once the socket has been idle for timeoutMs.
    // Destroying the request triggers the 'error' handler below.
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('GitHub API request timed out'));
    });
    req.on('error', reject);
  });
}

// Guard against re-entry. Without this, mashing the menu item would
// fire multiple concurrent GitHub requests and multiple modals.
let updateCheckInProgress = false;

async function checkForUpdates(win, options = {}) {
  // silent: only push a modal to the renderer for actionable results
  //         (an actual update is available, or available-but-no-asset).
  //         "Up to date" and "check failed" are skipped silently. Used
  //         by the auto-check that runs on startup so the user only
  //         sees a prompt when there's actually something to act on.
  const { silent = false } = options;

  if (updateCheckInProgress) return;
  updateCheckInProgress = true;
  try {
    const current = app.getVersion();
    // Read the current pref so we can echo it in every result we send
    // to the renderer. The modal's checkbox uses it as its initial
    // state; an opted-out user who manually triggers a check sees an
    // unchecked box and can toggle it back on.
    const prefs = userPrefs.get();

    let releaseList;
    try {
      releaseList = await httpsGetJson(UPDATE_API_URL);
    } catch (err) {
      if (silent) return;
      return sendUpdateResult(win, {
        status: 'error',
        message: `Could not reach GitHub: ${err.message}`,
        releasesUrl: `${URLS.github}/releases`,
        checkOnStartup: prefs.checkForUpdatesOnStartup,
      });
    }

    // The /releases endpoint returns an array sorted newest-first.
    // Pick the first non-draft entry (prereleases are kept — see the
    // comment on pickLatestRelease for why). A null here means the
    // repo has no published releases at all, which is unusual but
    // possible on a brand-new repo before the first release ships.
    const release = pickLatestRelease(releaseList);
    if (!release) {
      if (silent) return;
      return sendUpdateResult(win, {
        status: 'error',
        message: 'GitHub returned no published releases for this repo.',
        releasesUrl: `${URLS.github}/releases`,
        checkOnStartup: prefs.checkForUpdatesOnStartup,
      });
    }

    // Tags look like "v1.0.9". parseReleaseTag strips the "v" and
    // validates the shape — returns null for anything that doesn't
    // look like our normal N.N.N pattern.
    const tag = String(release.tag_name || '');
    const latest = parseReleaseTag(tag);
    if (!latest) {
      if (silent) return;
      return sendUpdateResult(win, {
        status: 'error',
        message: `Unrecognised release tag from GitHub: "${tag || '(empty)'}"`,
        releasesUrl: `${URLS.github}/releases`,
        checkOnStartup: prefs.checkForUpdatesOnStartup,
      });
    }

    // compareVersions returns >=0 when current is at or ahead of latest.
    // The "ahead" case happens with locally-built dev versions; treat
    // them the same as "up to date" — no nag.
    if (compareVersions(current, latest) >= 0) {
      if (silent) return;
      return sendUpdateResult(win, {
        status: 'current',
        current,
        checkOnStartup: prefs.checkForUpdatesOnStartup,
      });
    }

    // An update exists. Find the right asset for this OS/arch.
    const asset = pickAssetForPlatform(release.assets || [], process.platform, process.arch);
    if (!asset) {
      // We're behind, but couldn't find a download for this platform.
      // Unusual — would mean a partial release upload, or running on
      // a platform we don't ship binaries for. Send the user to the
      // release page so they can pick something manually. We DO push
      // this in silent mode — it's actionable.
      return sendUpdateResult(win, {
        status: 'no-asset',
        current,
        latest,
        releaseUrl: release.html_url,
        checkOnStartup: prefs.checkForUpdatesOnStartup,
      });
    }

    sendUpdateResult(win, {
      status: 'available',
      current,
      latest,
      downloadUrl: asset.browser_download_url,
      downloadFilename: asset.name,
      releaseUrl: release.html_url,
      // The renderer truncates release notes for the modal; we just
      // pass the raw markdown through. May be empty.
      notes: release.body || '',
      checkOnStartup: prefs.checkForUpdatesOnStartup,
    });
  } finally {
    updateCheckInProgress = false;
  }
}

// Push the result of a check into the renderer. Since this codebase
// doesn't use IPC (the renderer is sandboxed and talks to Express via
// fetch), we evaluate a call to window.__showUpdateResult — which is
// defined in public/app.js — directly in the page context.
function sendUpdateResult(win, info) {
  if (!win || win.isDestroyed()) return;
  // JSON-stringify is the safe way to embed an object into JS source.
  // Backslashes, quotes, and HTML/JS-significant characters are all
  // handled correctly without us hand-rolling an escaper.
  const json = JSON.stringify(info);
  win.webContents
    .executeJavaScript(`window.__showUpdateResult(${json})`)
    .catch(() => {
      // Renderer may have reloaded, or app.js may not have parsed yet
      // if this fires very early. Nothing useful we can do — better to
      // silently no-op than to throw an unhandled rejection.
    });
}

// ---------------------------------------------------------------------------
// Find a free local port. We avoid hardcoding 3000 because the user may
// already have something on it — especially likely if they also run the
// web build (npm run web) on the same machine for development.
// ---------------------------------------------------------------------------
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// ---------------------------------------------------------------------------
// Poll the server until it answers. We can't loadURL immediately after
// importing server.js because Express's listen() is asynchronous — there's
// a small window where the port is bound but not yet accepting requests.
// ---------------------------------------------------------------------------
function waitForServer(port, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  const url = `http://127.0.0.1:${port}/`;

  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const req = http.get(url, (res) => {
        res.resume();           // discard body, we only care that it answered
        resolve();
      });
      req.on('error', () => {
        if (Date.now() > deadline) {
          reject(new Error(`Server did not come up within ${timeoutMs}ms`));
        } else {
          setTimeout(tryOnce, 100);
        }
      });
    };
    tryOnce();
  });
}

// ---------------------------------------------------------------------------
// README viewer.
//
// Reads README.md, runs it through `marked` to get HTML, wraps the result
// in a self-contained HTML document with GitHub-ish styling, writes that
// to a temp file, and loads it in a new BrowserWindow.
//
// We use a temp file (rather than a giant data: URL or a custom protocol
// handler) because it's the simplest approach that "just works" with
// Electron's security model and lets the page resolve relative resources
// the way you'd expect.
//
// `readmeWindow` is module-scoped so a second click on "View README"
// re-focuses the existing window instead of opening duplicates.
// ---------------------------------------------------------------------------
let readmeWindow = null;

const README_CSS = `
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI",
                 "Helvetica Neue", Arial, sans-serif;
    font-size: 16px; line-height: 1.5;
    color: #1f2328; background: #fff;
    max-width: 980px; margin: 0 auto; padding: 32px 48px;
  }
  h1, h2, h3, h4, h5, h6 {
    margin-top: 24px; margin-bottom: 16px;
    font-weight: 600; line-height: 1.25;
  }
  h1 { font-size: 2em;    padding-bottom: 0.3em; border-bottom: 1px solid #d1d9e0; }
  h2 { font-size: 1.5em;  padding-bottom: 0.3em; border-bottom: 1px solid #d1d9e0; }
  h3 { font-size: 1.25em; }
  h4 { font-size: 1em; }
  h5 { font-size: 0.875em; }
  h6 { font-size: 0.85em;  color: #59636e; }
  p  { margin: 0 0 16px 0; }
  a  { color: #0969da; text-decoration: none; }
  a:hover { text-decoration: underline; }
  code {
    padding: 0.2em 0.4em; margin: 0; font-size: 85%;
    background-color: rgba(175,184,193,0.2); border-radius: 6px;
    font-family: ui-monospace, SFMono-Regular, "SF Mono",
                 Menlo, Consolas, "Liberation Mono", monospace;
  }
  pre {
    padding: 16px; overflow: auto; font-size: 85%; line-height: 1.45;
    background-color: #f6f8fa; border-radius: 6px; margin-bottom: 16px;
  }
  pre code { padding: 0; background: transparent; font-size: 100%; }
  blockquote {
    padding: 0 1em; color: #59636e;
    border-left: 0.25em solid #d1d9e0; margin: 0 0 16px 0;
  }
  ul, ol { padding-left: 2em; margin-bottom: 16px; }
  li { margin: 0.25em 0; }
  table {
    border-collapse: collapse; margin-bottom: 16px;
    display: block; width: max-content; max-width: 100%; overflow: auto;
  }
  table th, table td { padding: 6px 13px; border: 1px solid #d1d9e0; }
  table th { font-weight: 600; background-color: #f6f8fa; }
  table tr:nth-child(2n) { background-color: #f6f8fa; }
  hr {
    height: 0.25em; padding: 0; margin: 24px 0;
    background-color: #d1d9e0; border: 0;
  }
  img { max-width: 100%; }
`;

async function openReadmeWindow() {
  // Re-focus an existing window rather than spawning another one.
  if (readmeWindow && !readmeWindow.isDestroyed()) {
    readmeWindow.focus();
    return;
  }

  try {
    const md = await fs.readFile(path.join(__dirname, 'README.md'), 'utf8');
    const body = marked.parse(md);

    const fullHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Trebuchet — README</title>
<style>${README_CSS}</style>
</head>
<body>
${body}
</body>
</html>`;

    // Write to the OS temp dir. We don't bother cleaning up — the OS
    // handles temp dir lifecycle, and overwriting the same path each time
    // means we don't accumulate stale copies.
    const tempPath = path.join(app.getPath('temp'), 'trebuchet-readme.html');
    await fs.writeFile(tempPath, fullHtml, 'utf8');

    readmeWindow = new BrowserWindow({
      width: 900,
      height: 800,
      title: 'README',
      autoHideMenuBar: true,    // no menu bar in the README window itself
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    // Open any links inside the README in the user's default browser
    // rather than navigating the README window away from the README.
    readmeWindow.webContents.setWindowOpenHandler(({ url }) => {
      openExternalSafe(url);
      return { action: 'deny' };
    });
    readmeWindow.webContents.on('will-navigate', (event, url) => {
      // Allow only the initial file:// load; redirect everything else.
      if (!url.startsWith('file://')) {
        event.preventDefault();
        openExternalSafe(url);
      }
    });

    readmeWindow.on('closed', () => { readmeWindow = null; });
    attachContextMenu(readmeWindow.webContents);
    readmeWindow.loadFile(tempPath);
  } catch (err) {
    console.error('Failed to open README:', err);
  }
}

// ---------------------------------------------------------------------------
// Application menu.
//
// The default Electron menu is full of dev-tool noise (Reload, Toggle
// DevTools, Learn More -> electronjs.org, etc.) that has no business in
// a shipped product. We replace it with a minimal menu containing just
// the items that make sense: File/Quit, and a Help menu with links to
// relevant external docs and the in-app README.
//
// macOS gets the same Help menu, plus the standard Apple-required app
// menu (About / Hide / Quit) and a working Edit menu (which is what
// gives form fields their keyboard shortcuts on Mac).
// ---------------------------------------------------------------------------
function setAppMenu() {
  // The Help submenu is identical across platforms. Defining it once
  // keeps Windows/Linux and macOS in sync.
  const helpSubmenu = [
    {
      label: 'Check for Updates…',
      click: () => {
        // Prefer the focused window so the result modal opens in the
        // window the user was looking at when they clicked. Fall back
        // to the first window if (somehow) none is focused — better
        // to show the modal somewhere than to silently no-op.
        const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
        if (win) checkForUpdates(win);
      },
    },
    { type: 'separator' },
    {
      label: 'Official website',
      click: () => openExternalSafe(URLS.website),
    },
    {
      label: 'View README',
      click: () => openReadmeWindow(),
    },
    { type: 'separator' },
    {
      label: 'Raydium CLMM Pools (docs)',
      click: () => openExternalSafe(URLS.raydiumClmm),
    },
    {
      // && escapes the Alt-mnemonic underscore so users see "Burn & Earn"
      // rather than "Burn _Earn" with E underlined as an accelerator.
      label: 'Raydium Burn && Earn (docs)',
      click: () => openExternalSafe(URLS.raydiumBurnEarn),
    },
    {
      label: 'Helius RPC',
      click: () => openExternalSafe(URLS.helius),
    },
    { type: 'separator' },
    {
      label: 'GitHub Repository',
      click: () => openExternalSafe(URLS.github),
    },
  ];

  if (process.platform !== 'darwin') {
    // Windows / Linux: minimal File menu plus the Help menu.
    const template = [
      {
        label: 'File',
        submenu: [{ role: 'quit' }],
      },
      {
        label: 'Help',
        submenu: helpSubmenu,
      },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
    return;
  }

  // macOS: app menu, Edit, Window, Help. The menu bar is system-level
  // and always visible at the top of the screen, so apps without one
  // look broken.
  const template = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'close' },
      ],
    },
    {
      label: 'Help',
      submenu: helpSubmenu,
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------------------
// Boot sequence.
// ---------------------------------------------------------------------------
let serverPort;

async function startServer() {
  // Persisted state (rpcConfig.json) needs to live somewhere writable and
  // stable across reinstalls. userData is the right answer on every
  // platform: ~/Library/Application Support/Trebuchet on macOS,
  // %APPDATA%/Trebuchet on Windows, ~/.config/Trebuchet on Linux.
  //
  // rpcConfig.js honours TREBUCHET_CONFIG_DIR if set, else falls back to
  // its own __dirname (used in `npm run web` mode).
  process.env.TREBUCHET_CONFIG_DIR = app.getPath('userData');

  serverPort = await getFreePort();

  // IMPORTANT: PORT must be set before importing server.js, since server.js
  // reads process.env.PORT at module load time and immediately calls listen.
  process.env.PORT = String(serverPort);

  // Side-effect import: server.js calls app.listen() during module init.
  // We don't need its exports.
  await import('./server.js');

  await waitForServer(serverPort);
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    show: false,                // avoid the white-flash; show after content loads
    webPreferences: {
      // We're loading our own bundled HTML/JS over a localhost loopback,
      // so renderer sandboxing is appropriate and we don't need a preload
      // script (no IPC — the renderer talks to Express via fetch, exactly
      // as it does in the standalone web build).
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Don't throttle the renderer while the window is hidden during
      // startup. Default is true, which slows down timers and can leave
      // the renderer's input/focus subsystem in an inconsistent state
      // when the window is later shown. Disabling throttling for our
      // single-window desktop app costs us nothing — we don't have
      // long-lived background tabs to worry about.
      backgroundThrottling: false,
    },
  });

  win.once('ready-to-show', () => {
    win.show();
  });

  // Register the silent startup update-check handler.
  //
  // The renderer POSTs to /api/trigger-startup-update-check after
  // its splash video AND first-run disclaimer have both been
  // dismissed. The server forwards that signal here via the bridge.
  // We can't just fire from ready-to-show with a timeout (the
  // previous approach) because the resulting modal would land
  // behind the splash or disclaimer, where the user never sees it.
  //
  // The pref check happens inside the handler so an opted-out user
  // never reaches the network call. The fire-once guard inside
  // updateCheckBridge means dev-mode page reloads can't cause
  // duplicate checks.
  updateCheckBridge.registerHandler(() => {
    if (win.isDestroyed()) return;
    if (!userPrefs.get().checkForUpdatesOnStartup) return;
    checkForUpdates(win, { silent: true });
  });

  // Initial compositor reset (Windows-only).
  //
  // Workaround for a long-standing Chromium bug on Windows: on first
  // launch, the compositor sometimes initializes with broken hit-testing
  // for input elements. Symptoms — single-click on a text input doesn't
  // focus it, double-click can still select text, typing does nothing.
  // The user has to switch to another window and back, or open DevTools,
  // to "fix" it. DevTools "fixes" the bug because opening it forces
  // Chromium to rebuild its compositor surface and recompute hit-test
  // regions. A 1-pixel resize triggers the same rebuild, programmatically.
  //
  // This handler covers the initial-launch case. Most of the follow-on
  // cases — recurrence of the bug after a native dialog dismisses —
  // have been eliminated by replacing window.confirm() calls with HTML
  // modals (see confirmDialog() in public/app.js). HTML modals never
  // leave Chromium's compositor, so they don't trigger the bug.
  //
  // The one native dialog that still exists in the app is the
  // "launch in progress" close confirmation in the will-prevent-unload
  // handler further down — which has to be native because that event
  // requires a synchronous decision and we can't await an HTML modal
  // in the renderer from main-process code without significantly more
  // plumbing. That handler applies the same setSize-by-1 reset itself
  // when the user chooses Stay.
  //
  // SmartScreen on first-run-of-unsigned-binary still triggers the bug,
  // but that's covered here too: did-finish-load fires after the page
  // loads, which on a SmartScreen launch happens after the user dismisses
  // SmartScreen — at which point the compositor needs the same reset as
  // any other launch.
  win.webContents.once('did-finish-load', () => {
    if (process.platform === 'win32') {
      const [w, h] = win.getSize();
      win.setSize(w + 1, h + 1);
      win.setSize(w, h);
    }
    win.focus();
    win.webContents.focus();
  });

  // Keep the page's focus state aligned with the window's whenever the
  // window receives focus (alt-tab back, taskbar click, etc.). The two
  // are independent in Chromium; this prevents the page falling out of
  // sync with the OS-level window focus.
  win.on('focus', () => {
    win.webContents.focus();
  });

  attachContextMenu(win.webContents);

  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalSafe(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    const appOrigin = `http://127.0.0.1:${serverPort}`;
    if (!url.startsWith(`${appOrigin}/`)) {
      event.preventDefault();
      openExternalSafe(url);
    }
  });

  // When the user hits the window's X (or Cmd/Ctrl+W, or quits via the
  // app menu), Chromium fires the renderer's beforeunload event. The
  // renderer (see the window.addEventListener('beforeunload') at the
  // bottom of public/app.js) returns a non-empty value when a launch
  // is in progress, signalling "the unload should be prevented".
  //
  // In a browser, this would trigger Chrome/Firefox's native "Leave
  // site? Changes you may not be saved" dialog. In Electron, the
  // default behavior is different: the close is SILENTLY blocked, no
  // dialog shown. The user clicks X, nothing happens, they have no
  // idea why. That's the bug we're fixing here.
  //
  // The fix is to listen for `will-prevent-unload` on the webContents
  // — Electron's signal that beforeunload tried to cancel the unload —
  // and show our own native confirmation dialog.
  //
  // Counterintuitive API note: calling event.preventDefault() here
  // means "prevent the prevention" — i.e. allow the close to proceed.
  // Not calling preventDefault() leaves the default behavior intact
  // (window stays open). The naming is awkward but the Electron docs
  // are clear on this.
  win.webContents.on('will-prevent-unload', (event) => {
    const choice = dialog.showMessageBoxSync(win, {
      type: 'question',
      buttons: ['Stay', 'Leave anyway'],
      defaultId: 0,
      cancelId: 0,
      title: 'Launch in progress',
      message: 'A launch is in progress.',
      detail:
        'Anything created on-chain so far (token mint, pools) is permanent. ' +
        'If you close now, you\'ll need to recover the ephemeral wallet from ' +
        'the Pending Wallets panel next time you open the app — its secret ' +
        'key is saved in your OS keychain, so the funds remain accessible.\n\n' +
        'In-progress UI state (current step, pool config you\'ve typed) will ' +
        'be lost.',
    });
    if (choice === 1) {
      // User chose "Leave anyway". preventDefault on the will-prevent-unload
      // event tells Electron to ignore the renderer's beforeunload return
      // value and proceed with the unload — counterintuitive naming, but
      // see the Electron docs for `will-prevent-unload`.
      event.preventDefault();
      return;
    }

    // User chose "Stay". The window stays open via default behavior
    // (no preventDefault call needed). BUT: the native dialog we just
    // showed has triggered the Chromium compositor hit-testing bug on
    // Windows — the same bug we work around in did-finish-load above,
    // and the same one that drove the window.confirm() → HTML modal
    // migration in public/app.js. After a native dialog dismisses,
    // text inputs in the renderer become un-clickable: single-clicks
    // don't focus them, even though double-click can still select text.
    // The user has to alt-tab away and back to fix it. From their
    // perspective the UI has frozen.
    //
    // The fix is the same setSize-by-1 trick used in did-finish-load:
    // resizing the window forces Chromium to rebuild its compositor
    // surface and recompute hit-test regions. We then explicitly
    // restore focus to the window and webContents, since the dialog
    // stole both. Windows-only — macOS and Linux don't exhibit the
    // bug. We could probably do the resize unconditionally, but
    // there's no upside to flickering the window on platforms that
    // don't need it.
    if (process.platform === 'win32') {
      const [w, h] = win.getSize();
      win.setSize(w + 1, h + 1);
      win.setSize(w, h);
    }
    win.focus();
    win.webContents.focus();
  });

  win.loadURL(`http://127.0.0.1:${serverPort}/`);
}

app.whenReady().then(async () => {
  setAppMenu();

  // Hand Electron's safeStorage API to our secret-store module so any
  // wallet keys persisted during this session are encrypted at rest
  // using the OS keychain. Has to happen before startServer(), since
  // server.js imports pendingWallets and any read from the recovery
  // cache should already be going through the encrypted path.
  secretStore.setSafeStorage(safeStorage);

  try {
    await startServer();
    createWindow();
  } catch (err) {
    // If the server failed to start there's nothing useful the user can do
    // from a blank window — log loudly and bail.
    console.error('Failed to start trebuchet server:', err);
    app.quit();
    return;
  }

  // Standard macOS behaviour: re-create a window when the dock icon is
  // clicked and there are no other windows open.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // Standard macOS behaviour: stay running until Cmd+Q; on every other
  // platform, quit when the last window closes.
  if (process.platform !== 'darwin') app.quit();
});

// Kill any in-flight vanity grind subprocess before the app exits.
//
// server.js is loaded as a dynamic ES module *into* this Electron main
// process (see startServer above) — they share one OS process and one
// event loop. When the user closes the window during a grind, the
// spawned vanity_keygen.exe child is still running with open stdio
// pipes to the parent. Node refuses to exit while those handles are
// alive, so app.quit() initiates shutdown but the parent process
// lingers in Task Manager indefinitely.
//
// 'before-quit' fires from every exit path (window close, Cmd+Q, File →
// Quit, programmatic app.quit()) and gives us a hook to send the kill
// signal before Electron's shutdown sequence tries to actually exit.
//
// We use dynamic import() rather than a static import at the top of
// this file for two reasons:
//   1. vanityKeygen.js is only loaded on demand by server.js when the
//      user actually grinds. We don't want to pull it in at startup.
//   2. By the time a grind is in flight, server.js has already imported
//      vanityKeygen.js transitively, so this import() hits the module
//      cache and resolves synchronously.
//
// If no grind is in flight (or vanityKeygen was never loaded), the
// cancel call is a no-op and this handler costs nothing.
app.on('before-quit', () => {
  import('./vanityKeygen.js')
    .then((mod) => {
      const cancelled = mod.cancelVanityGrind();
      if (cancelled) {
        console.log('[shutdown] Killed in-flight vanity grind to release subprocess handles');
      }
    })
    .catch((e) => {
      // Module not loaded yet (no grind ever happened) or some other
      // load failure. Either way there's nothing to cancel, so quiet
      // failure is correct here.
      console.warn('[shutdown] vanityKeygen module unavailable on quit:', e?.message);
    });
});
