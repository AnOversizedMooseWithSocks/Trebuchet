// ===========================================================================
// Activity log toggle
// ===========================================================================

bind('activityLogHeader', 'click', () => {
  const container = document.getElementById('activityLogContainer');
  const chevron = document.getElementById('activityLogChevron');
  container.classList.toggle('is-expanded');
  document.body.classList.toggle('log-expanded', container.classList.contains('is-expanded'));
  chevron.classList.toggle('fa-chevron-up');
  chevron.classList.toggle('fa-chevron-down');
});

// ===========================================================================
// CLMM fee tier list — fetched at startup and used to populate the per-pool
// Fee Tier dropdown in Step 2.
// ===========================================================================

// Fetch the canonical CLMM fee tier list from the server (which in turn
// pulls from Raydium's published config endpoint, with its own fallback).
// On success, replaces the hardcoded fallback in feeTiers with the live
// list. If pools are already rendered when the call returns, re-render
// them so the dropdown picks up newly-available tiers — this matters
// only on the rare path where the user manages to add a pool faster than
// the network call returns; usual case is the call completes first.
async function loadFeeTiers() {
  try {
    const resp = await fetch('/api/clmm-fee-tiers').then((r) => r.json());
    if (resp.success && Array.isArray(resp.tiers) && resp.tiers.length > 0) {
      feeTiers = resp.tiers;
      // If pools have already been rendered, the dropdowns were built
      // from the fallback list. Re-render to pick up the live list.
      if (pools.length > 0) renderPools();
    }
  } catch (e) {
    console.error('Failed to load CLMM fee tiers, using fallback:', e);
  }
}

// ===========================================================================
// RPC settings (top of page) — unchanged from previous version
// ===========================================================================

async function loadRpcConfig() {
  try {
    const resp = await fetch('/api/rpc-config').then((r) => r.json());
    if (resp.success) renderRpcConfig(resp.config);
  } catch (e) {
    console.error('Failed to load RPC config:', e);
  }
}

// ===========================================================================
// RPC health polling
// ===========================================================================
//
// Polls /api/rpc-health every 30s during active use and updates a small
// coloured dot next to the RPC display. The dot is green (healthy, fast),
// yellow (healthy but slow), red (errors), or grey (unknown / not yet
// polled). If the RPC returns errors during an active launch flow, a
// warning banner appears with a one-click "Open RPC settings" link.

function updateRpcHealthDot(health) {
  const dot = document.getElementById('rpcHealthDot');
  if (!dot) return;
  dot.className = 'rpc-health-dot health-' + health;
  const labels = {
    good: 'RPC healthy, low latency',
    slow: 'RPC healthy, high latency',
    error: 'RPC returning errors',
    unknown: 'RPC health unknown',
  };
  dot.title = labels[health] || labels.unknown;
}

function showRpcHealthWarning(detail) {
  const banner = document.getElementById('rpcHealthWarning');
  const detailEl = document.getElementById('rpcHealthWarningDetail');
  if (!banner || !detailEl) return;
  detailEl.textContent = detail;
  banner.classList.remove('hidden');
}

function hideRpcHealthWarning() {
  const banner = document.getElementById('rpcHealthWarning');
  if (banner) banner.classList.add('hidden');
}

async function pollRpcHealth() {
  try {
    const resp = await fetch('/api/rpc-health').then(r => r.json());
    if (!resp.success) return;
    _rpcHealthLastResult = resp;
    updateRpcHealthDot(resp.health);

    // Show warning only during active launch flow + when RPC is erroring
    if (_rpcHealthLaunchActive && resp.health === 'error') {
      const detail = resp.error
        ? `The RPC returned: ${resp.error}. Launches may fail mid-flow.`
        : 'The RPC is not responding. Launches will likely fail.';
      showRpcHealthWarning(detail);
    } else if (resp.health !== 'error') {
      hideRpcHealthWarning();
    }
  } catch {
    // Network error from our own server — don't spam the activity log
    // since this runs every 30s. Just mark unknown and move on.
    updateRpcHealthDot('unknown');
    _rpcHealthLastResult = { health: 'unknown', latencyMs: null, error: 'Could not reach health endpoint' };
  }
}

function startRpcHealthPolling() {
  if (_rpcHealthPollTimer) return; // already running
  pollRpcHealth(); // immediate first check
  _rpcHealthPollTimer = setInterval(pollRpcHealth, RPC_HEALTH_INTERVAL_MS);
}

function stopRpcHealthPolling() {
  if (_rpcHealthPollTimer) {
    clearInterval(_rpcHealthPollTimer);
    _rpcHealthPollTimer = null;
  }
  hideRpcHealthWarning();
  updateRpcHealthDot('unknown');
}

function markLaunchActiveForRpcHealth(active) {
  _rpcHealthLaunchActive = active;
  if (!active) hideRpcHealthWarning();
}

// RPC health warning: "Open RPC settings" link handler
bind('rpcHealthWarningSwitch', 'click', (e) => {
  e.preventDefault();
  const panel = document.getElementById('rpcSettingsPanel');
  const chevron = document.getElementById('rpcSettingsChevron');
  panel.classList.remove('hidden');
  chevron.classList.remove('fa-chevron-down');
  chevron.classList.add('fa-chevron-up');
});


// Render an RPC URL safely for display. Keeps just the scheme and host
// — everything else (path, query string) is redacted, because that's
// where API keys typically live. Helius URLs look like
// https://mainnet.helius-rpc.com/?api-key=<secret>; QuickNode/Triton
// embed the key in the path. Showing the host only is enough for the
// user to recognise which RPC is active without exposing their key in
// screenshots, screen-shares, or tutorial videos.
//
// `host` mode returns just "https://mainnet.helius-rpc.com".
// `hostWithIndicator` mode appends "/…" if the original had a path or
// query, as a subtle hint that there's more in the URL the user just
// can't see. That's the default — it makes it obvious the display is
// truncated, not that the URL itself is bare.
function safeRpcUrl(url, mode = 'hostWithIndicator') {
  if (typeof url !== 'string' || url.length === 0) return '';
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    // Malformed input — return a generic placeholder rather than
    // leaking whatever raw text was passed in.
    return '(invalid url)';
  }
  const base = `${parsed.protocol}//${parsed.host}`;
  if (mode === 'host') return base;
  const hasMore = parsed.pathname !== '/' || parsed.search.length > 0;
  return hasMore ? `${base}/…` : base;
}

function renderRpcConfig(config) {
  const active = config.saved.find((r) => r.url === config.active);
  const display = active
    ? `${active.name} — ${safeRpcUrl(active.url)}`
    : safeRpcUrl(config.active);
  document.getElementById('rpcCurrentDisplay').textContent = display;

  // Toggle the public-RPC warning. Anything matching the well-known
  // public mainnet hosts is a launch hazard; dedicated RPCs (custom
  // URLs the user has added — Helius, QuickNode, etc., free tier or
  // otherwise) are fine. We match on hostname rather than exact URL
  // so query-string variants and minor formatting differences all
  // get caught.
  togglePublicRpcWarning(config.active);

  const list = document.getElementById('rpcSavedList');
  list.innerHTML = '';
  config.saved.forEach((rpc) => {
    const isActive = rpc.url === config.active;
    const row = document.createElement('div');
    row.className = 'rpc-row';
    const info = document.createElement('div');
    info.className = 'rpc-info';
    info.innerHTML = `
      <strong>${escapeHtml(rpc.name)}</strong>
      ${isActive ? '<span class="tag is-success is-light is-small">active</span>' : ''}
      <br>
      <span class="is-family-monospace is-size-7">${escapeHtml(safeRpcUrl(rpc.url))}</span>
    `;
    const actions = document.createElement('div');
    actions.className = 'rpc-actions';
    if (!isActive) {
      const useBtn = document.createElement('button');
      useBtn.className = 'button is-small is-primary';
      useBtn.textContent = 'Use';
      useBtn.addEventListener('click', () => selectRpc(rpc.url));
      actions.appendChild(useBtn);
    }
    if (config.saved.length > 1) {
      const rmBtn = document.createElement('button');
      rmBtn.className = 'button is-danger is-light';
      rmBtn.innerHTML = '<span class="icon"><i class="fas fa-times"></i></span>';
      rmBtn.title = 'Remove';
      rmBtn.addEventListener('click', () => removeRpc(rpc.url));
      actions.appendChild(rmBtn);
    }
    row.appendChild(info);
    row.appendChild(actions);
    list.appendChild(row);
  });
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Format a token amount in whole units for display in a balance row.
// Uses Math.floor to avoid the rounding hazard where displayed >
// actual — polling reads this text back as Number to compare against
// the wallet balance, so wallet >= displayed must imply wallet >=
// actual on-chain target. For small amounts (<10), keeps decimals so
// USDC-like rows still display "1" not "0".
function formatTokenDisplay(whole) {
  const n = Number(whole);
  if (!isFinite(n) || n <= 0) return '0';
  if (n >= 10) {
    // Big amounts: floor to integer for readability.
    return String(Math.floor(n));
  }
  // Small amounts: keep up to 4 sig figs, floored.
  // (toPrecision rounds — fine for display since the actual auto-swap
  // target is already buffered with the 2x sizing multiplier.)
  return Number(n.toPrecision(4)).toString();
}

// ---------------------------------------------------------------------------
// Numeric input formatting (thousands separators)
// ---------------------------------------------------------------------------
//
// We display large numbers in inputs with comma thousand-separators
// (e.g. "1,000,000,000") because long runs of zeros are hard to
// distinguish at a glance. The inputs themselves are <input type="text"
// inputmode="numeric"> — type="number" won't store commas and the native
// number stepper would conflict with our formatting.
//
// At submit time, every read site uses parseNumberInput() to strip
// the commas and produce a plain number. Server-side sees raw digits
// only.

// Format an input's current value as a comma-grouped integer string,
// preserving the user's cursor position. Called from the input
// element's `input` event so the value re-formats live as the user
// types — but without the cursor jumping to the end on every keystroke
// (which is what naive innerHTML rewrites would cause).
//
// Cursor preservation works by counting how many commas sit before
// the cursor in the OLD value, computing the same count after the
// reformat, and shifting the cursor by the difference. That handles
// every case I can think of: typing in the middle of a number, deleting
// a digit which removes a comma, pasting a long number, etc.
//
// Allows a leading minus sign and decimals — the integer portion gets
// commas, the decimal portion doesn't. Empty input stays empty (no
// leading "0"). Multiple decimals or non-digit junk gets stripped.
function formatNumberInput(input) {
  if (!input) return;
  const oldValue = input.value;
  const oldCursor = input.selectionStart ?? oldValue.length;

  // Count commas before the cursor in the old value — we'll use this
  // to compute where the cursor should sit after re-formatting.
  const oldCommasBeforeCursor = (oldValue.slice(0, oldCursor).match(/,/g) || []).length;

  // Strip everything except digits, the leading minus, and a single
  // decimal point. Order: minus first (if present), then digits, then
  // optional decimal + more digits.
  const cleaned = oldValue
    .replace(/[^\d.\-]/g, '')         // drop everything but digits, dot, minus
    .replace(/(?!^)-/g, '')           // minus only at start
    .replace(/(\..*)\./g, '$1');      // collapse multiple dots into one

  if (cleaned === '' || cleaned === '-' || cleaned === '.') {
    // Edge case: user is mid-typing something that isn't yet a number
    // (just typed "-" or "."). Keep the literal value, no commas yet.
    input.value = cleaned;
    return;
  }

  // Split integer and decimal portions; comma-format the integer only.
  const negative = cleaned.startsWith('-');
  const body = negative ? cleaned.slice(1) : cleaned;
  const dotIdx = body.indexOf('.');
  const intPart = dotIdx === -1 ? body : body.slice(0, dotIdx);
  const decPart = dotIdx === -1 ? '' : body.slice(dotIdx); // includes the dot

  // Strip leading zeros from the integer part (but keep a single zero
  // if the whole integer is zero, e.g. "0.5").
  const intStripped = intPart.replace(/^0+(?=\d)/, '') || '0';
  const intWithCommas = intStripped.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

  const newValue = (negative ? '-' : '') + intWithCommas + decPart;
  input.value = newValue;

  // Reposition cursor: walk from the start of the new value, counting
  // non-comma characters, and stop when we've walked past the same
  // count as came before the cursor in the old value. This handles
  // every case I tested: typing in the middle, deleting a digit that
  // collapses a comma, pasting a long number, etc.
  const oldNonCommasBeforeCursor = oldCursor - oldCommasBeforeCursor;
  let walked = 0;
  let cursor = 0;
  while (cursor < newValue.length && walked < oldNonCommasBeforeCursor) {
    if (newValue[cursor] !== ',') walked++;
    cursor++;
  }
  input.setSelectionRange(cursor, cursor);
}

// Read a numeric input's current value as a plain number, stripping
// any thousand-separator commas. Returns NaN for empty / unparseable
// inputs — same as Number() on a malformed string. Callers that need
// a non-NaN fallback should provide one explicitly (e.g. `?? 0`).
function parseNumberInput(input) {
  if (!input) return NaN;
  const raw = String(input.value).replace(/,/g, '');
  if (raw === '' || raw === '-' || raw === '.') return NaN;
  return Number(raw);
}

function getIntegerInputString(input) {
  if (!input) return '';
  return String(input.value).replace(/,/g, '').trim();
}

// Show a warning banner whenever the active RPC is one of the well-known
// public mainnet endpoints. The list is matched by hostname so all the
// quirky variants (with/without trailing slashes, query strings, etc.)
// still get caught. If a new public alias appears in the wild, just add
// its hostname here.
const PUBLIC_RPC_HOSTS = new Set([
  'api.mainnet-beta.solana.com',
  'solana-api.projectserum.com',
  'rpc.ankr.com',                    // free tier shows up here
  'solana.public-rpc.com',
]);

function togglePublicRpcWarning(activeUrl) {
  const banner = document.getElementById('publicRpcWarning');
  if (!banner) return;

  let isPublic = false;
  try {
    const host = new URL(activeUrl).hostname.toLowerCase();
    isPublic = PUBLIC_RPC_HOSTS.has(host);
  } catch {
    // Malformed URL — treat as not-public (the existing test/validate
    // flow will surface URL problems separately).
    isPublic = false;
  }

  banner.classList.toggle('hidden', !isPublic);
  // Mirror the state onto the collapsed settings header so the entry
  // point itself says setup is needed — the user shouldn't have to
  // scroll to the danger banner to learn their RPC won't work.
  const pill = document.getElementById('settingsSetupPill');
  if (pill) pill.classList.toggle('hidden', !isPublic);
}

// Open the settings panel (if collapsed) and scroll to the RPC section.
// Used by the welcome card's "Set up my RPC" button; kept here next to
// toggleSettingsPanel so the expand logic stays in one module.
function openSettingsToRpc() {
  const panel = document.getElementById('rpcSettingsPanel');
  if (panel && panel.classList.contains('hidden')) toggleSettingsPanel();
  const anchor = document.getElementById('rpcSectionAnchor');
  if (anchor) anchor.scrollIntoView({ behavior: 'smooth', block: 'start' });
  // Put the cursor where the user's next action is.
  const nameInput = document.getElementById('newRpcName');
  if (nameInput) nameInput.focus({ preventScroll: true });
}

async function selectRpc(url) {
  try {
    const resp = await fetch('/api/rpc-config/select', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    }).then((r) => r.json());
    if (resp.success) {
      renderRpcConfig(resp.config);
      log(`Switched RPC to ${safeRpcUrl(url)}`, 'success');
    }
  } catch (e) {
    log(`Failed to switch RPC: ${e.message}`, 'danger');
  }
}

async function removeRpc(url) {
  // The confirm dialog should identify which RPC is being removed
  // without exposing the API key in the URL. Hostname is plenty for
  // the user to recognise. escapeHtml because the URL goes into
  // innerHTML; we don't trust user-supplied URL bytes.
  const ok = await confirmDialog({
    title: 'Remove RPC?',
    body: `<p>Remove this RPC from your saved list?</p>
           <p class="is-family-monospace is-size-7">${escapeHtml(safeRpcUrl(url))}</p>`,
    confirmLabel: 'Remove',
    danger: true,
  });
  if (!ok) return;
  try {
    const resp = await fetch('/api/rpc-config/remove', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    }).then((r) => r.json());
    if (resp.success) renderRpcConfig(resp.config);
  } catch (e) {
    log(`Failed to remove RPC: ${e.message}`, 'danger');
  }
}

function toggleSettingsPanel() {
  const toggle = document.getElementById('rpcSettingsToggle');
  const panel = document.getElementById('rpcSettingsPanel');
  const chevron = document.getElementById('rpcSettingsChevron');
  if (!panel) return;
  // classList.toggle returns true when the class is now present, i.e. the
  // panel is now hidden — so aria-expanded is the negation.
  const nowHidden = panel.classList.toggle('hidden');
  if (chevron) {
    chevron.classList.toggle('fa-chevron-down');
    chevron.classList.toggle('fa-chevron-up');
  }
  if (toggle) toggle.setAttribute('aria-expanded', String(!nowHidden));
}
bind('rpcSettingsToggle', 'click', toggleSettingsPanel);
// The header is role="button" with tabindex=0, so support keyboard
// activation the way a native button would: Enter and Space toggle it
// (Space is prevented from scrolling the page).
bind('rpcSettingsToggle', 'keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    toggleSettingsPanel();
  }
});

bind('testRpcBtn', 'click', async () => {
  const url = document.getElementById('newRpcUrl').value.trim();
  const result = document.getElementById('rpcTestResult');
  if (!url) {
    result.textContent = 'Enter a URL first';
    result.className = 'help is-warning';
    return;
  }
  result.textContent = 'Testing...';
  result.className = 'help';
  try {
    const resp = await fetch('/api/rpc-config/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    }).then((r) => r.json());
    if (resp.result.ok) {
      result.textContent = `OK — Solana ${resp.result.version}, ${resp.result.latencyMs}ms`;
      result.className = 'help is-success';
    } else {
      result.textContent = `Failed: ${resp.result.error}`;
      result.className = 'help is-danger';
    }
  } catch (e) {
    result.textContent = `Failed: ${e.message}`;
    result.className = 'help is-danger';
  }
});

bind('addRpcBtn', 'click', async () => {
  const name = document.getElementById('newRpcName').value.trim();
  const url = document.getElementById('newRpcUrl').value.trim();
  const result = document.getElementById('rpcTestResult');
  if (!name || !url) {
    result.textContent = 'Both name and URL are required';
    result.className = 'help is-warning';
    return;
  }
  try {
    const resp = await fetch('/api/rpc-config/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, url, setActive: true }),
    }).then((r) => r.json());
    if (resp.success) {
      document.getElementById('newRpcName').value = '';
      document.getElementById('newRpcUrl').value = '';
      result.textContent = '';
      renderRpcConfig(resp.config);
      log(`RPC added: ${name}`, 'success');
    } else {
      result.textContent = `Failed: ${resp.error}`;
      result.className = 'help is-danger';
    }
  } catch (e) {
    result.textContent = `Failed: ${e.message}`;
    result.className = 'help is-danger';
  }
});

