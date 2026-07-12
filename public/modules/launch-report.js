// ===========================================================================
// Launch Report Download
// ===========================================================================
//
// Generates a markdown report covering the just-completed launch:
// addresses for the token mint, pools, and every position; lock-status
// transactions; transfer txs for any Fee Keys sent to external recipients;
// and a tokenomics summary mirroring the visualization modal's content.
//
// Triggered from step 5 (after all pools created) or step 6 (during
// finalization). The permanent publish happens after airdrop delivery and
// before the final sweep, so the report records the planned sweep
// destination without claiming the sweep transaction has already happened.

// Build an explorer URL for an address or transaction signature. Solscan
// is the de facto standard; users can change cluster via the UI if they
// need devnet/testnet view. Leaving cluster off defaults to mainnet,
// which matches what Trebuchet always launches on.
function solscanAddrUrl(addr) {
  return `https://solscan.io/account/${encodeURIComponent(addr)}`;
}
function solscanTxUrl(sig) {
  return `https://solscan.io/tx/${encodeURIComponent(sig)}`;
}

// Format an ISO timestamp as a human-readable local date+time string.
// Used for the report header so the user has a record of when this
// launch happened.
function formatReportTimestamp(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// Generate the HTML report — a self-contained .html document the team
// can open offline, share, or print to PDF. Includes:
//   - Token name/symbol/mint/decimals/supply/target mcap
//   - Embedded SVG donut chart (same chart the preview modal shows)
//   - Per-pool sections with bootstrap/main/ladder positions
//   - Per-row copy buttons for every address and TX signature
//   - Solscan links for everything
//   - Lock-status summary roll-up at the top
//
// Reads from createdTokenInfo, lpResult, pools (user's UI config — used
// for fee tiers, supply percentages, and ladder band ranges), tempWallet,
// and the token form fields. Defensive on every field: a partial-failure
// resume path may produce results where individual positions don't have
// a `txIds.lock` or `transferredTo`. Missing fields render as "—".

// Escape a value for safe inclusion in an HTML attribute. Used for the
// data attributes that drive the copy buttons. Same set as escapeHtml
// but called out separately so the intent reads clearly at call sites.
function escapeAttr(s) {
  return escapeHtml(String(s));
}

// Render one "address row": label, monospace value, copy button, optional
// explorer link. Used throughout the report for any address or tx sig.
// `kind` is 'addr' or 'tx' — only affects the explorer URL builder.
function renderAddressRow(label, value, kind = 'addr') {
  if (!value) {
    return `<div class="addr-row">
      <span class="addr-label">${escapeHtml(label)}</span>
      <span class="addr-value addr-missing">—</span>
    </div>`;
  }
  const url = kind === 'tx' ? solscanTxUrl(value) : solscanAddrUrl(value);
  return `<div class="addr-row">
    <span class="addr-label">${escapeHtml(label)}</span>
    <code class="addr-value">${escapeHtml(value)}</code>
    <button class="copy-btn" data-copy="${escapeAttr(value)}" title="Copy to clipboard">Copy</button>
    <a class="explorer-link" href="${escapeAttr(url)}" target="_blank" rel="noopener" title="Open on Solscan">↗</a>
  </div>`;
}

// Render a fact-line: "Label: value" with no copy button. For non-address
// fields like fee tier, decimals, range multipliers.
function renderFactRow(label, value) {
  return `<div class="fact-row">
    <span class="fact-label">${escapeHtml(label)}</span>
    <span class="fact-value">${escapeHtml(String(value))}</span>
  </div>`;
}

// Render a lock badge — green pill for locked, gray pill for not.
function renderLockBadge(locked) {
  return locked
    ? `<span class="badge badge-locked">🔒 Locked</span>`
    : `<span class="badge badge-unlocked">Not locked</span>`;
}

function getPlannedSweepDestinationWallet() {
  const value = document.getElementById('destinationWallet')?.value?.trim();
  return value || null;
}

// Compute the lock-status roll-up across every position in every pool.
// Returns { total, locked, transferred, totalRecipient, allLocked }.
function computeLockSummary(results) {
  let total = 0, locked = 0, transferred = 0, totalRecipient = 0;
  for (const r of results) {
    const mains = Array.isArray(r.mainPositions) ? r.mainPositions : [];
    const ladder = Array.isArray(r.ladderPositions) ? r.ladderPositions : [];
    // Support positions carry the same locked-or-not lifecycle as
    // ladder bands. They never have recipients (Fee Keys stay with
    // the launch wallet), so they only contribute to total + locked
    // counts, never to totalRecipient/transferred. Defensive against
    // older result entries that pre-date the field.
    const support = Array.isArray(r.supportPositions) ? r.supportPositions : [];
    const all = [...mains, ...ladder, ...support, ...(r.bootstrap ? [r.bootstrap] : [])];
    for (const p of all) {
      total++;
      if (p.locked) locked++;
    }
    for (const p of mains) {
      if (p.recipient) {
        totalRecipient++;
        if (p.transferredTo) transferred++;
      }
    }
  }
  return { total, locked, transferred, totalRecipient, allLocked: total > 0 && locked === total };
}

// Build the entire HTML report as a string. Self-contained — inlines
// CSS and JS, includes the SVG chart directly, and embeds the token
// logo as a base64 data URL so the file works offline and survives
// email forwarding without breaking image refs.
//
// Visual theme matches the makesometokens.com marketing site:
// parchment background (#efe5cd theme color), Trebuchet MS body font
// (deliberately on-brand — the typeface is literally named after a
// trebuchet), engineering-manuscript flourishes (FIG. NN callouts,
// bracketed enumerators, "STEP NN · LABEL" headers, blueprint-style
// border treatments).
//
// Optional `logoDataUrl` parameter: if provided, embedded as the report's
// hero image. The downloadLaunchReport caller reads the user's selected
// logo file and converts it to a data URL before calling this.
// Build the Airdrop section of the launch report. Returns an empty
// string when no airdrop ran (lastAirdropResult is null) so the call
// site can render unconditionally — the section just disappears in
// the no-airdrop case. Called from buildLaunchReportHtml.
//
// The section follows the same visual treatment as the other
// numbered sections: [ NN ] enum-badge, section-title, content. Each
// recipient row shows the wallet (with copy + Solscan link via the
// existing addr-row pattern), the tokens delivered, and either the
// transaction signature (for delivered) or the failure reason (for
// failed). Delivered and failed lists are visually distinguished by
// a small color accent on the count badge in each subsection header.
function buildAirdropReportSection() {
  // Two rendering paths share most of the visual treatment (enum badge,
  // section title, recipient table). They diverge on:
  //   - title suffix and intro paragraph (pending vs delivered language)
  //   - row contents (planned amount + "pending" badge vs delivered amount
  //     + tx signature)
  //   - subsection counts and pluralization
  //
  // Pending mode runs when no airdrop result exists yet AND the user has
  // configured a non-empty airdrop. Both Step 5's preview and any
  // pre-transfer Download Launch Report click pick this up so the user
  // never sees a confusing "I configured an airdrop but the report doesn't
  // mention it" state.

  const fmtTokens = (n) => {
    const num = Number(n);
    if (!Number.isFinite(num)) return '—';
    return num.toLocaleString(undefined, { maximumFractionDigits: 6 });
  };
  // Max rows rendered per recipient table (pending / delivered / failed).
  // Keeps very large airdrops from blowing the published report past the
  // Arweave free-upload size cap; the overflow collapses into a count row.
  const MAX_REPORT_AIRDROP_ROWS = 100;
  const overflowRowHtml = (hidden, colSpan, noun) => (hidden > 0
    ? `<tr><td colspan="${colSpan}" style="color: var(--ink-muted, #6a4f2a); font-style: italic;">…and ${hidden.toLocaleString()} more ${noun} — every transfer is verifiable on-chain from the launch wallet.</td></tr>`
    : '');

  // ---- Pending path: airdrop configured but not yet executed ----
  // Triggered when no result exists yet but the configured payload has
  // recipients. buildAirdropTransferPayload returns null when:
  //   - no token created yet (so we can't possibly have run)
  //   - mode is customize (preallocation/airdrop is a simple-mode feature)
  //   - preallocation disabled
  //   - airdrop disabled or empty
  // …so falling through to '' below is the right outcome in all those
  // cases — there genuinely is no airdrop section to render.
  if (!lastAirdropResult) {
    const pending = buildAirdropTransferPayload();
    if (!pending || !Array.isArray(pending.recipients) || pending.recipients.length === 0) {
      return '';
    }
    const recipients = pending.recipients;
    const totalPending = recipients.reduce(
      (s, r) => s + (Number(r.tokens) || 0), 0,
    );

    // Recipient table — same structure as the delivered table but the
    // third column reads "pending" instead of a tx link. Amber tint
    // mirrors the failed-row treatment so "not yet done" is visually
    // distinct from delivered/success.
    const pendingRows = recipients.slice(0, MAX_REPORT_AIRDROP_ROWS).map((r) => {
      const wAddr = String(r.wallet || '');
      const tokensTxt = fmtTokens(r.tokens);
      return `<tr>
        <td>
          <code style="font-family: 'JetBrains Mono', monospace; font-size: 11px; word-break: break-all;">${escapeHtml(wAddr || '—')}</code>
          ${wAddr ? `<a class="explorer-link" href="${escapeAttr(solscanAddrUrl(wAddr))}" target="_blank" rel="noopener" title="View address on Solscan" style="margin-left: 4px;">↗</a>` : ''}
        </td>
        <td style="text-align: right;">${tokensTxt}</td>
        <td style="color: #b8821a; font-style: italic;">pending</td>
      </tr>`;
    }).join('') + overflowRowHtml(recipients.length - MAX_REPORT_AIRDROP_ROWS, 3, 'pending recipients');

    return `
      <hr class="section-rule">
      <div class="enum-badge">[ 04 ] &nbsp; Airdrop</div>
      <h2 class="section-title">
        Airdrop distribution
        <span style="font-size: 13px; color: #b8821a; font-weight: normal; margin-left: 8px;">— pending</span>
      </h2>
      <p style="font-size: 13px; color: var(--ink-muted, #6a4f2a); margin-bottom: 1rem;">
        ${recipients.length} recipient${recipients.length === 1 ? '' : 's'} will receive
        <strong>${fmtTokens(totalPending)}</strong> tokens from the preallocation budget
        when the Step 6 transfer is executed. The list and amounts below are the
        planned distribution.
      </p>
      <h3 class="subsection">
        To be delivered &middot;
        <span style="color: #b8821a;">${recipients.length} recipient${recipients.length === 1 ? '' : 's'}</span> &middot;
        ${fmtTokens(totalPending)} tokens
      </h3>
      <table style="width: 100%; border-collapse: collapse; font-size: 12px; margin-bottom: 1rem;">
        <thead>
          <tr style="border-bottom: 1px solid var(--rule, rgba(28,22,16,0.15));">
            <th style="text-align: left; padding: 4px 8px 4px 0;">Recipient</th>
            <th style="text-align: right; padding: 4px 8px;">Tokens</th>
            <th style="text-align: left; padding: 4px 0;">Status</th>
          </tr>
        </thead>
        <tbody>${pendingRows}</tbody>
      </table>
    `;
  }

  // ---- Post-run path: airdrop has executed; render delivered + failed ----
  const delivered = lastAirdropResult.transferred || [];
  const failed = lastAirdropResult.failed || [];
  if (delivered.length === 0 && failed.length === 0) return '';

  // Total tokens delivered — sum across the transferred list. Useful
  // summary stat at the top so the user has a single number for "how
  // much actually went out" without scanning every row.
  const totalDelivered = delivered.reduce(
    (s, r) => s + (Number(r.tokens) || 0), 0,
  );
  const totalFailed = failed.reduce(
    (s, r) => s + (Number(r.tokens) || 0), 0,
  );

  // Delivered rows — each shows wallet + tokens + tx signature with
  // Solscan link. Pattern matches the per-pool position rows so the
  // report reads consistently end-to-end.
  let deliveredRows = '';
  if (delivered.length > 0) {
    deliveredRows = delivered.slice(0, MAX_REPORT_AIRDROP_ROWS).map((r) => {
      const wAddr = String(r.wallet || '');
      const tokensTxt = fmtTokens(r.tokens);
      const txCell = r.txId
        ? `<a class="explorer-link" href="${escapeAttr(solscanTxUrl(r.txId))}" target="_blank" rel="noopener" title="View transaction on Solscan">${escapeHtml(r.txId.slice(0, 8))}…↗</a>`
        : '—';
      return `<tr>
        <td>
          <code style="font-family: 'JetBrains Mono', monospace; font-size: 11px; word-break: break-all;">${escapeHtml(wAddr || '—')}</code>
          ${wAddr ? `<a class="explorer-link" href="${escapeAttr(solscanAddrUrl(wAddr))}" target="_blank" rel="noopener" title="View address on Solscan" style="margin-left: 4px;">↗</a>` : ''}
        </td>
        <td style="text-align: right;">${tokensTxt}</td>
        <td>${txCell}</td>
      </tr>`;
    }).join('') + overflowRowHtml(delivered.length - MAX_REPORT_AIRDROP_ROWS, 3, 'delivered recipients');
  }

  // Failed rows — each shows wallet + tokens + the failure reason
  // (truncated if very long; the on-screen result panel and the
  // downloadable CSV both have the full text). Color-tinted in muted
  // amber to distinguish from delivered rows at a glance.
  let failedRows = '';
  if (failed.length > 0) {
    failedRows = failed.slice(0, MAX_REPORT_AIRDROP_ROWS).map((r) => {
      const wAddr = String(r.wallet || '');
      const tokensTxt = fmtTokens(r.tokens);
      let reasonRaw = String(r.error || 'unknown error');
      if (reasonRaw.length > 140) reasonRaw = reasonRaw.slice(0, 137) + '…';
      const verifyLinkHtml = r.signature
        ? ` <a class="explorer-link" href="${escapeAttr(solscanTxUrl(r.signature))}" target="_blank" rel="noopener" title="View transaction on Solscan to verify whether it landed">verify ↗</a>`
        : '';
      return `<tr>
        <td>
          <code style="font-family: 'JetBrains Mono', monospace; font-size: 11px; word-break: break-all;">${escapeHtml(wAddr || '—')}</code>
          ${wAddr ? `<a class="explorer-link" href="${escapeAttr(solscanAddrUrl(wAddr))}" target="_blank" rel="noopener" title="View address on Solscan" style="margin-left: 4px;">↗</a>` : ''}
        </td>
        <td style="text-align: right;">${tokensTxt}</td>
        <td style="color: #b8821a;">${escapeHtml(reasonRaw)}${verifyLinkHtml}</td>
      </tr>`;
    }).join('') + overflowRowHtml(failed.length - MAX_REPORT_AIRDROP_ROWS, 3, 'failed recipients');
  }

  // Compose the two subsections. We only render a subsection when
  // there's something to put in it, so a clean airdrop produces just
  // the "Delivered" subsection and a fully-failed airdrop (rare)
  // produces just the "Failed" subsection.
  let deliveredBlock = '';
  if (delivered.length > 0) {
    deliveredBlock = `
      <h3 class="subsection">
        Delivered &middot;
        <span style="color: #2c8a52;">${delivered.length} recipient${delivered.length === 1 ? '' : 's'}</span> &middot;
        ${fmtTokens(totalDelivered)} tokens
      </h3>
      <table style="width: 100%; border-collapse: collapse; font-size: 12px; margin-bottom: 1rem;">
        <thead>
          <tr style="border-bottom: 1px solid var(--rule, rgba(28,22,16,0.15));">
            <th style="text-align: left; padding: 4px 8px 4px 0;">Recipient</th>
            <th style="text-align: right; padding: 4px 8px;">Tokens</th>
            <th style="text-align: left; padding: 4px 0;">Transaction</th>
          </tr>
        </thead>
        <tbody>${deliveredRows}</tbody>
      </table>
    `;
  }
  let failedBlock = '';
  if (failed.length > 0) {
    failedBlock = `
      <h3 class="subsection">
        Failed &middot;
        <span style="color: #b8821a;">${failed.length} recipient${failed.length === 1 ? '' : 's'}</span> &middot;
        ${fmtTokens(totalFailed)} tokens un-delivered
      </h3>
      <p style="font-size: 12px; color: var(--ink-muted, #6a4f2a); margin-bottom: 0.5rem;">
        These recipients did not receive their share during the launch.
        Their portion of the supply remained in the ephemeral wallet and
        was swept to the destination wallet alongside the rest. To
        distribute manually, use the recipient list below or the
        downloadable CSV from the Step 6 result panel.
      </p>
      <table style="width: 100%; border-collapse: collapse; font-size: 12px; margin-bottom: 1rem;">
        <thead>
          <tr style="border-bottom: 1px solid var(--rule, rgba(28,22,16,0.15));">
            <th style="text-align: left; padding: 4px 8px 4px 0;">Recipient</th>
            <th style="text-align: right; padding: 4px 8px;">Tokens</th>
            <th style="text-align: left; padding: 4px 0;">Reason</th>
          </tr>
        </thead>
        <tbody>${failedRows}</tbody>
      </table>
    `;
  }

  return `
    <hr class="section-rule">
    <div class="enum-badge">[ 04 ] &nbsp; Airdrop</div>
    <h2 class="section-title">Airdrop distribution</h2>
    <p style="font-size: 13px; color: var(--ink-muted, #6a4f2a); margin-bottom: 1rem;">
      The launched token was distributed to ${delivered.length + failed.length}
      recipient${(delivered.length + failed.length) === 1 ? '' : 's'} from the
      preallocation budget as part of the Step 6 transfer.
      ${failed.length > 0 ? `<strong style="color: #b8821a;">${failed.length} did not deliver successfully.</strong>` : ''}
    </p>
    ${deliveredBlock}
    ${failedBlock}
  `;
}

function buildLaunchReportHtml({ logoDataUrl = null } = {}) {
  const now = new Date();
  const tokenInfo = createdTokenInfo || {};
  const results = (lpResult && Array.isArray(lpResult.results)) ? lpResult.results : [];
  const tokenName = document.getElementById('tokenName')?.value.trim() || tokenInfo.name || '(unnamed)';
  const tokenSymbol = document.getElementById('tokenSymbol')?.value.trim() || tokenInfo.symbol || '?';
  const tokenDescription = document.getElementById('tokenDescription')?.value.trim() || '';
  const supply = parseNumberInput(document.getElementById('tokenSupply'));
  const targetMc = parseNumberInput(document.getElementById('targetMarketCap'));
  const summary = computeLockSummary(results);
  const plannedSweepDestination = getPlannedSweepDestinationWallet();

  // Reuse the same chart and breakdown the preview modal uses, so the
  // report's tokenomics view matches what the user saw at launch time.
  // Slightly smaller in the report so the chart and breakdown fit
  // side-by-side comfortably at the parchment-page width. If the user
  // provided a logo we pass it through so the chart center shows the
  // logo — same treatment as the hero block at the top of the report.
  const arcs = buildTokenomicsArcs();
  const chartSvg = renderTokenomicsDonutSvg(arcs, { size: 300, logoDataUrl });

  // ---- Per-pool sections ----
  let poolSections = '';
  results.forEach((r, idx) => {
    const userPool = pools[r.allocationIndex ?? idx] || pools[idx] || {};
    const sym = r.quoteSymbol || userPool.resolvedSymbol || '?';
    const supplyPct = Number(r.supplyPercent ?? userPool.supplyPercent ?? 0).toFixed(2);
    const feeTierIdx = userPool.ammConfigIndex;
    const feeTier = feeTiers.find((t) => t.index === feeTierIdx);
    const feeTierLabel = feeTier
      ? `${(feeTier.tradeFeeRate / 10000).toFixed(2)}% / spacing ${feeTier.tickSpacing}`
      : (feeTierIdx != null ? `index ${feeTierIdx}` : '—');

    // Pool's own colour from the chart palette — used for the section
    // accent so the report visually ties pools to their arcs.
    const poolHue = POOL_COLOR_BASES[idx % POOL_COLOR_BASES.length].h;
    const poolSat = POOL_COLOR_BASES[idx % POOL_COLOR_BASES.length].s;

    let positionsHtml = '';

    // Bootstrap position (if present)
    if (r.bootstrap) {
      positionsHtml += `
        <div class="position-card">
          <div class="position-header">
            <span class="position-kind">Bootstrap position</span>
            ${renderLockBadge(r.bootstrap.locked)}
          </div>
          ${renderAddressRow('Position NFT', r.bootstrap.nftMint)}
          ${r.bootstrap.feeKeyNftMint ? renderAddressRow('Fee Key NFT', r.bootstrap.feeKeyNftMint) : ''}
          ${renderAddressRow('Open TX', r.bootstrap.txIds?.open, 'tx')}
          ${renderAddressRow('Lock TX', r.bootstrap.txIds?.lock, 'tx')}
        </div>`;
    }

    // Main LP positions / slices
    const mains = Array.isArray(r.mainPositions) ? r.mainPositions : [];
    mains.forEach((pos, si) => {
      const sliceLabel = mains.length === 1
        ? 'Main LP position'
        : `Main LP slice ${si + 1}/${mains.length}`;
      const shareText = pos.sharePercent != null
        ? `${Number(pos.sharePercent).toFixed(2)}% of wide bucket`
        : null;

      let recipientBlock = '';
      if (pos.recipient) {
        recipientBlock = `
          ${renderAddressRow('Fee Key recipient', pos.recipient)}
          <div class="fact-row">
            <span class="fact-label">Transferred to recipient</span>
            <span class="fact-value">${pos.transferredTo ? 'Yes' : 'No (Fee Key NFT stayed with launch wallet)'}</span>
          </div>
          ${pos.txIds?.transfer ? renderAddressRow('Fee Key transfer TX', pos.txIds.transfer, 'tx') : ''}`;
      }

      positionsHtml += `
        <div class="position-card">
          <div class="position-header">
            <span class="position-kind">${escapeHtml(sliceLabel)}</span>
            ${renderLockBadge(pos.locked)}
          </div>
          ${shareText ? renderFactRow('Share', shareText) : ''}
          ${Number.isFinite(pos.tickLower) && Number.isFinite(pos.tickUpper) ? renderFactRow('Range', `tick ${pos.tickLower} \u2192 ${pos.tickUpper} (single-sided, above launch)`) : ''}
          ${renderAddressRow('Position NFT', pos.nftMint)}
          ${pos.feeKeyNftMint ? renderAddressRow('Fee Key NFT', pos.feeKeyNftMint) : ''}
          ${renderAddressRow('Open TX', pos.txIds?.open, 'tx')}
          ${renderAddressRow('Lock TX', pos.txIds?.lock, 'tx')}
          ${recipientBlock}
        </div>`;
    });

    // Ladder bands
    const ladder = Array.isArray(r.ladderPositions) ? r.ladderPositions : [];
    ladder.forEach((pos, bi) => {
      const userBand = userPool.ladderConfig?.bands?.[bi];
      const rangeLabel = userBand
        ? `${Number(userBand.lowerMultiplier).toFixed(2)}× – ${Number(userBand.upperMultiplier).toFixed(2)}× launch price`
        : `tick ${pos.tickLower} → ${pos.tickUpper}`;
      const supplyText = userBand
        ? `${Number(userBand.supplyPercent).toFixed(2)}% of pool`
        : null;

      positionsHtml += `
        <div class="position-card">
          <div class="position-header">
            <span class="position-kind">Ladder band ${bi + 1}/${ladder.length}</span>
            ${renderLockBadge(pos.locked)}
          </div>
          ${renderFactRow('Range', rangeLabel)}
          ${supplyText ? renderFactRow('Token-supply share', supplyText) : ''}
          ${renderAddressRow('Position NFT', pos.nftMint)}
          ${pos.feeKeyNftMint ? renderAddressRow('Fee Key NFT', pos.feeKeyNftMint) : ''}
          ${renderAddressRow('Open TX', pos.txIds?.open, 'tx')}
          ${renderAddressRow('Lock TX', pos.txIds?.lock, 'tx')}
        </div>`;
    });

    // Support positions. Single-sided quote position(s) sitting below
    // launch price (above for mintB-side launches). Backs preallocated
    // supply with a quote-side buy wall. No recipient — Fee Keys stay
    // with the launch wallet. Currently always 0 or 1 entries per pool,
    // but rendered as a loop in case future iterations open multiple
    // support bands at different depths.
    const support = Array.isArray(r.supportPositions) ? r.supportPositions : [];
    support.forEach((pos, si) => {
      const depthLabel = pos.depthPct != null
        ? `launch price down to -${Number(pos.depthPct).toFixed(0)}% (single-sided quote)`
        : `tick ${pos.tickLower} → ${pos.tickUpper}`;
      positionsHtml += `
        <div class="position-card">
          <div class="position-header">
            <span class="position-kind">Support position${support.length > 1 ? ` ${si + 1}/${support.length}` : ''}</span>
            ${renderLockBadge(pos.locked)}
          </div>
          ${renderFactRow('Range', depthLabel)}
          ${renderAddressRow('Position NFT', pos.nftMint)}
          ${pos.feeKeyNftMint ? renderAddressRow('Fee Key NFT', pos.feeKeyNftMint) : ''}
          ${renderAddressRow('Open TX', pos.txIds?.open, 'tx')}
          ${renderAddressRow('Lock TX', pos.txIds?.lock, 'tx')}
        </div>`;
    });

    const poolEnum = String(idx + 1).padStart(2, '0');
    poolSections += `
      <section class="pool-section">
        <div class="pool-section-header">
          <div class="enum-badge">POOL · ${poolEnum}</div>
          <h2 class="pool-title">
            <span class="pool-swatch" style="background: hsl(${poolHue}, ${poolSat}%, 45%);"></span>
            ${escapeHtml(sym)} pool
          </h2>
          <div class="pool-meta">${supplyPct}% of token supply &nbsp;·&nbsp; Fee tier ${escapeHtml(feeTierLabel)}</div>
        </div>
        <div class="pool-addresses">
          ${renderAddressRow('Pool ID', r.poolId)}
          ${(() => {
            // Quote mint: the result records the resolved address; the
            // config carries the user's raw entry (symbol or address).
            // Skip the row for native SOL — its mint is implied.
            const qm = r.quoteAddress || userPool.quoteToken;
            const isSol = (r.quoteSymbol || userPool.quoteToken || '').toUpperCase() === 'SOL';
            return (qm && !isSol) ? renderAddressRow('Quote token mint', qm) : '';
          })()}
          ${renderAddressRow('Create-pool TX', r.txIds?.createPool, 'tx')}
        </div>
        ${(() => {
          // Per-pool liquidity depth chart, baked in as static SVG so the
          // standalone report needs no scripts. Two-sided: support buy wall
          // below launch + wide/ladder above. Shown when there's a ladder or a
          // (placeable) support wall; omitted for a lone flat band.
          if (typeof computeDepthProfile !== 'function') return '';
          const effSupplyPct = Number(r.supplyPercent ?? userPool.supplyPercent);
          const poolNotionalUsd = (Number(targetMc) > 0 && effSupplyPct > 0)
            ? (effSupplyPct / 100) * Number(targetMc) : 0;
          let support = null;
          const sc = userPool.supportConfig;
          if (sc && sc.mode === 'custom' && Number(sc.solValue) > 0) {
            const solPool = (Array.isArray(pools) ? pools : []).find((p) => (p.quoteToken || '').toUpperCase() === 'SOL');
            const solUsd = solPool && Number(solPool.resolvedPriceUsd) > 0 ? Number(solPool.resolvedPriceUsd) : null;
            if (solUsd) support = { usd: Number(sc.solValue) * solUsd, depthPct: Number(sc.depthPct) || 30 };
          }
          const prof = computeDepthProfile(userPool, { poolNotionalUsd, support });
          const html = prof ? renderDepthChartSvg(prof) : '';
          return html ? `<div class="pool-depth-chart" style="margin: 12px 0 4px;">${html}</div>` : '';
        })()}
        <div class="positions-grid">${positionsHtml}</div>
      </section>`;
  });

  // ---- Status banner (top of report) ----
  // Status banner. Two information dimensions: position locks (everything
  // locked? partial?) and Fee Key transfers (any external recipients
  // configured? did they all receive their NFTs?). The lock dimension is
  // always shown; the transfer dimension only when relevant.
  let statusBanner;
  if (results.length === 0) {
    statusBanner = `<div class="banner banner-warn">
      <strong>No pool results captured.</strong>
      This may indicate the launch did not reach the create-pool phase.
    </div>`;
  } else if (summary.allLocked) {
    // Lock all good. Surface transfer status only when external recipients
    // existed AND some failed — otherwise that line would be either "0/0"
    // (uninformative) or "all delivered" (already implicit in the green
    // banner). Failed transfers are the case the user genuinely needs to
    // know about, because the Fee Key NFTs sweep to the destination wallet
    // on transfer and the user has to forward them manually.
    const transferIssue = summary.totalRecipient > 0
      && summary.transferred < summary.totalRecipient;
    statusBanner = `<div class="banner banner-${transferIssue ? 'warn' : 'ok'}">
      <strong>All ${summary.total} positions locked.</strong>
      The liquidity is permanently committed via Burn &amp; Earn. Fees accrue to the Fee Key NFT holders.
      ${transferIssue ? `<br><strong>${summary.transferred} / ${summary.totalRecipient} Fee Key NFTs reached their external recipients</strong> — the remaining ones swept back to the launch wallet and were transferred to the destination wallet on step 6. Forward them manually to complete delivery.` : ''}
    </div>`;
  } else {
    statusBanner = `<div class="banner banner-warn">
      <strong>${summary.locked} / ${summary.total} positions locked.</strong>
      Any unlocked position is still controlled by the ephemeral launch wallet. If you ran the transfer step, those NFTs were swept to your destination wallet — you can re-lock them via Raydium's Burn &amp; Earn UI.
      ${summary.totalRecipient > 0 && summary.transferred < summary.totalRecipient ? `<br><strong>${summary.transferred} / ${summary.totalRecipient} Fee Key NFTs reached their external recipients.</strong>` : ''}
    </div>`;
  }

  // ---- Demo banner (top of report) ----
  // Detect a demo launch by its synthetic Demo-prefixed addresses rather
  // than re-reading the live demoModeActive flag — that way the banner is
  // correct even for a report regenerated later, and it keys off the actual
  // content. A demo launch always has a Demo-prefixed token mint and pool
  // ids; checking a couple of representative addresses is enough.
  const isDemoReport =
    (tokenInfo.mint || '').startsWith('Demo') ||
    results.some((r) => (r.poolId || '').startsWith('Demo'));
  const demoBanner = isDemoReport
    ? `<div class="banner banner-demo">
        <strong>⚠ DEMO LAUNCH REPORT</strong>
        Synthetic addresses, no real transactions. This report was generated in
        demo mode — the addresses below are not real and their explorer links
        will not resolve.
      </div>`
    : '';

  // ---- Tokenomics breakdown (textual, matches the chart) ----
  let breakdownHtml = '';
  pools.forEach((pool, poolIdx) => {
    const poolArcs = arcs.filter((a) => a.poolIdx === poolIdx);
    if (poolArcs.length === 0) return;
    const sym = pool.resolvedSymbol || (pool.quoteToken === 'SOL' ? 'SOL' : pool.quoteToken?.slice(0, 6) + '…');
    breakdownHtml += `<div class="breakdown-pool"><div class="breakdown-pool-name">${escapeHtml(sym)} pool — ${Number(pool.supplyPercent).toFixed(2)}%</div>`;
    poolArcs.forEach((arc) => {
      breakdownHtml += `<div class="breakdown-arc">
        <span class="breakdown-swatch" style="background:${arc.color};"></span>
        <span class="breakdown-arc-label">${escapeHtml(arc.label)}</span>
        <span class="breakdown-arc-share">${(arc.share * 100).toFixed(2)}%</span>
      </div>`;
    });
    breakdownHtml += '</div>';
  });

  // Preallocation section (Airdrop + Launch-wallet holdback) — these arcs
  // already exist in the donut chart with poolIdx === -1, but without an
  // entry in the textual breakdown the legend's percentages sum to less
  // than 100% with no explanation of where the rest of the supply went.
  // Mirrors the in-app renderTokenomicsBreakdownHtml preallocation
  // section so the report and the in-app preview present the same info.
  const preallocArcs = arcs.filter((a) => a.poolIdx === -1);
  if (preallocArcs.length > 0) {
    const preallocTotalPct = preallocArcs
      .reduce((s, a) => s + a.share, 0) * 100;
    breakdownHtml += `<div class="breakdown-pool">
      <div class="breakdown-pool-name">Preallocation — ${preallocTotalPct.toFixed(2)}%</div>`;
    preallocArcs.forEach((arc) => {
      breakdownHtml += `<div class="breakdown-arc">
        <span class="breakdown-swatch" style="background:${arc.color};"></span>
        <span class="breakdown-arc-label">${escapeHtml(arc.label)}</span>
        <span class="breakdown-arc-share">${(arc.share * 100).toFixed(2)}%</span>
      </div>`;
    });
    breakdownHtml += '</div>';
  }

  // ---- Logo hero block ----
  // Embedded as a data URL so the report is fully portable. The user
  // didn't have to provide one — we render a placeholder block with
  // the token symbol instead so the layout reads consistently.
  const logoBlock = logoDataUrl
    ? `<img class="hero-logo" src="${escapeHtml(logoDataUrl)}" alt="${escapeHtml(tokenName)} logo">`
    : `<div class="hero-logo hero-logo-placeholder">${escapeHtml((tokenSymbol || '?').slice(0, 3).toUpperCase())}</div>`;

  // ---- Final HTML document ----
  // Inline CSS so the file works offline and survives email forwarding.
  // Inline JS for the clipboard behavior. The aesthetic mirrors the
  // makesometokens.com marketing site — parchment background, ink
  // typography, engineering-manuscript flourishes.
  const safeName = escapeHtml(tokenName);
  const safeSymbol = escapeHtml(tokenSymbol);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${safeName} (${safeSymbol}) — Launch Dossier</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#efe5cd">
  <style>
    /* ============================================================
       Theme — matches makesometokens.com
       Parchment background, ink typography, engineering-manuscript
       flourishes. Trebuchet MS body font (literally on-brand —
       the typeface is named after a trebuchet).
       ============================================================ */
    :root {
      --parchment: #efe5cd;
      --parchment-deep: #e6dab9;
      --parchment-edge: #d6c8a3;
      --ink: #1a1a1a;
      --ink-soft: #3d3a32;
      --ink-muted: #6b6657;
      --rule: #1a1a1a;
      --rule-soft: #b8ad8a;
      --accent: #8a3a1a;        /* sienna red — matches the manuscript ink-stamp feel */
      --ok: #2d5016;
      --ok-bg: #d9e6c8;
      --ok-edge: #8aa466;
      --warn: #7a3a0a;
      --warn-bg: #eed9b0;
      --warn-edge: #c89860;
      --mono: "Courier New", Courier, ui-monospace, monospace;
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; }
    body {
      font-family: "Trebuchet MS", "Lucida Sans Unicode", "Lucida Grande", Tahoma, sans-serif;
      background: var(--parchment);
      color: var(--ink);
      line-height: 1.55;
      font-size: 14.5px;
      /* Subtle paper texture — radial gradient gives a hint of vignette
         without requiring an external image. */
      background-image:
        radial-gradient(ellipse at center, transparent 0%, transparent 70%, rgba(110, 90, 50, 0.08) 100%),
        repeating-linear-gradient(0deg, transparent 0 28px, rgba(110, 90, 50, 0.012) 28px 29px);
      background-attachment: fixed;
    }
    .wrap {
      max-width: 1100px;
      margin: 0 auto;
      padding: 36px 32px 80px;
    }
    a { color: var(--accent); text-decoration: underline; text-decoration-thickness: 1px; text-underline-offset: 2px; }
    a:hover { text-decoration-thickness: 2px; }
    code { font-family: var(--mono); font-size: 0.92em; }

    /* ---------- Top masthead ---------- */
    .masthead {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 16px;
      padding-bottom: 12px;
      margin-bottom: 8px;
      border-bottom: 2px solid var(--rule);
      font-family: var(--mono);
      font-size: 11px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: var(--ink-soft);
    }
    .masthead-left { display: flex; align-items: center; gap: 18px; }
    .masthead-brand { font-weight: 700; letter-spacing: 0.35em; color: var(--ink); }
    .masthead-right { text-align: right; }

    /* ---------- Document title block ---------- */
    .title-block {
      display: grid;
      grid-template-columns: 120px 1fr;
      gap: 32px;
      align-items: center;
      margin: 32px 0 24px;
      padding-bottom: 24px;
      border-bottom: 1px solid var(--rule-soft);
    }
    @media (max-width: 600px) {
      .title-block { grid-template-columns: 1fr; text-align: center; }
    }
    .hero-logo {
      width: 120px;
      height: 120px;
      object-fit: contain;
      border-radius: 50%;
      background: var(--parchment-deep);
      border: 2px solid var(--rule);
      box-shadow: 0 2px 0 var(--rule-soft);
    }
    .hero-logo-placeholder {
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: var(--mono);
      font-size: 34px;
      font-weight: 700;
      color: var(--ink-soft);
      letter-spacing: 0.1em;
    }
    .doc-fig {
      font-family: var(--mono);
      font-size: 11px;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      color: var(--ink-muted);
      margin: 0 0 8px;
    }
    .doc-title {
      margin: 0;
      font-size: 44px;
      font-weight: 700;
      line-height: 1.05;
      letter-spacing: -0.01em;
    }
    .doc-title .doc-symbol {
      color: var(--ink-muted);
      font-weight: 500;
      font-size: 0.6em;
      letter-spacing: 0.02em;
      margin-left: 0.4em;
    }
    .doc-subtitle {
      margin: 10px 0 0;
      color: var(--ink-soft);
      font-size: 15px;
      font-style: italic;
      max-width: 60ch;
    }

    /* ---------- Section enumeration / headers ---------- */
    .enum-badge {
      display: inline-block;
      font-family: var(--mono);
      font-size: 10.5px;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      color: var(--ink-muted);
      padding: 3px 10px;
      border: 1px solid var(--rule-soft);
      background: var(--parchment-deep);
      margin-bottom: 12px;
    }
    .section-rule {
      margin: 36px 0 24px;
      border: 0;
      border-top: 2px solid var(--rule);
      position: relative;
    }
    .section-rule::after {
      content: "";
      position: absolute;
      top: 4px;
      left: 0;
      right: 0;
      border-top: 1px solid var(--rule);
    }
    h2.section-title {
      margin: 0 0 18px;
      font-size: 22px;
      font-weight: 700;
      letter-spacing: -0.005em;
    }
    h3.subsection {
      margin: 18px 0 8px;
      font-family: var(--mono);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.15em;
      color: var(--ink-muted);
      font-weight: 600;
    }

    /* ---------- Banner ---------- */
    .banner {
      padding: 12px 16px;
      margin: 20px 0 28px;
      font-size: 13.5px;
      border: 1px solid;
      background: var(--parchment-deep);
      position: relative;
    }
    .banner::before {
      content: "";
      position: absolute;
      left: 0; top: 0; bottom: 0;
      width: 4px;
    }
    .banner strong { display: inline-block; margin-right: 6px; }
    .banner-ok { border-color: var(--ok-edge); color: var(--ok); background: var(--ok-bg); }
    .banner-ok::before { background: var(--ok); }
    .banner-warn { border-color: var(--warn-edge); color: var(--warn); background: var(--warn-bg); }
    .banner-warn::before { background: var(--warn); }
    /* Demo report banner — bright amber, hard to miss, so a demo report
       received out of context is instantly recognizable as synthetic. */
    .banner-demo { border-color: #f0c040; color: #6b4b00; background: #fef3c7; }
    .banner-demo::before { background: #f0c040; }

    /* ---------- Token summary stat-grid ---------- */
    .token-summary-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
      gap: 0;
      border: 1px solid var(--rule);
      background: var(--parchment-deep);
    }
    .token-stat {
      padding: 14px 18px;
      border-right: 1px solid var(--rule-soft);
    }
    .token-stat:last-child { border-right: none; }
    .token-stat-label {
      font-family: var(--mono);
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.15em;
      color: var(--ink-muted);
      margin-bottom: 6px;
    }
    .token-stat-value {
      font-size: 18px;
      font-weight: 700;
      letter-spacing: -0.01em;
    }

    /* ---------- Tokenomics block ---------- */
    .tokenomics {
      display: grid;
      grid-template-columns: 320px 1fr;
      gap: 36px;
      align-items: start;
      margin-top: 16px;
    }
    @media (max-width: 720px) {
      .tokenomics { grid-template-columns: 1fr; }
    }
    .tokenomics svg { display: block; margin: 0 auto; }
    .chart-caption {
      font-family: var(--mono);
      font-size: 10px;
      letter-spacing: 0.15em;
      text-transform: uppercase;
      text-align: center;
      color: var(--ink-muted);
      margin-top: 4px;
    }
    .breakdown-pool { margin-bottom: 18px; }
    .breakdown-pool:last-child { margin-bottom: 0; }
    .breakdown-pool-name {
      font-weight: 700;
      font-size: 13px;
      margin-bottom: 8px;
      padding-bottom: 4px;
      border-bottom: 1px dashed var(--rule-soft);
      font-family: var(--mono);
      letter-spacing: 0.05em;
      text-transform: uppercase;
      color: var(--ink-soft);
    }
    .breakdown-arc {
      display: grid;
      grid-template-columns: 14px 1fr auto;
      gap: 10px;
      align-items: center;
      font-size: 13px;
      padding: 3px 0;
    }
    .breakdown-swatch {
      width: 12px; height: 12px; border-radius: 2px;
      border: 1px solid rgba(0,0,0,0.15);
    }
    .breakdown-arc-share {
      color: var(--ink-soft);
      font-variant-numeric: tabular-nums;
      font-family: var(--mono);
      font-size: 12px;
    }

    /* ---------- Pool section ---------- */
    .pool-section {
      margin: 28px 0;
      padding-top: 6px;
      border-top: 2px solid var(--rule);
    }
    .pool-section-header {
      margin-bottom: 18px;
    }
    .pool-title {
      margin: 0 0 4px;
      font-size: 24px;
      font-weight: 700;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .pool-swatch {
      display: inline-block;
      width: 16px; height: 16px;
      border-radius: 2px;
      border: 1px solid var(--rule);
    }
    .pool-meta {
      font-family: var(--mono);
      font-size: 11px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--ink-muted);
    }
    .pool-addresses {
      margin-bottom: 20px;
      padding: 14px 16px;
      background: var(--parchment-deep);
      border: 1px solid var(--rule-soft);
    }

    /* ---------- Position cards ---------- */
    .positions-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(440px, 1fr));
      gap: 14px;
    }
    .position-card {
      background: var(--parchment-deep);
      border: 1px solid var(--rule-soft);
      padding: 14px 16px;
      position: relative;
    }
    /* Top-left corner notch — engineering-drawing accent */
    .position-card::before {
      content: "";
      position: absolute;
      top: 0; left: 0;
      width: 8px; height: 8px;
      border-top: 2px solid var(--rule);
      border-left: 2px solid var(--rule);
    }
    .position-card::after {
      content: "";
      position: absolute;
      bottom: 0; right: 0;
      width: 8px; height: 8px;
      border-bottom: 2px solid var(--rule);
      border-right: 2px solid var(--rule);
    }
    .position-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 10px;
      padding-bottom: 8px;
      border-bottom: 1px dashed var(--rule-soft);
    }
    .position-kind {
      font-weight: 700;
      font-size: 13.5px;
      letter-spacing: 0.01em;
    }

    /* ---------- Address rows ---------- */
    .addr-row {
      display: grid;
      grid-template-columns: 140px 1fr auto auto;
      gap: 8px;
      align-items: center;
      padding: 5px 0;
      font-size: 12.5px;
    }
    .addr-label {
      font-family: var(--mono);
      color: var(--ink-muted);
      font-size: 10.5px;
      letter-spacing: 0.1em;
      text-transform: uppercase;
    }
    .addr-value {
      font-family: var(--mono);
      font-size: 11.5px;
      background: var(--parchment);
      padding: 4px 8px;
      border: 1px solid var(--rule-soft);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .addr-missing {
      background: transparent;
      border: none;
      color: var(--ink-muted);
      font-style: italic;
      padding-left: 0;
    }
    .copy-btn {
      font: inherit;
      font-family: var(--mono);
      font-size: 10px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      padding: 4px 10px;
      background: var(--parchment);
      border: 1px solid var(--rule);
      cursor: pointer;
      color: var(--ink);
      transition: all 120ms ease;
    }
    .copy-btn:hover {
      background: var(--ink);
      color: var(--parchment);
    }
    .copy-btn.copied {
      background: var(--ok);
      border-color: var(--ok);
      color: var(--parchment);
    }
    .explorer-link {
      color: var(--ink-soft);
      font-size: 14px;
      text-decoration: none;
      padding: 2px 6px;
      border: 1px solid var(--rule-soft);
      background: var(--parchment);
      font-family: var(--mono);
    }
    .explorer-link:hover {
      background: var(--ink);
      color: var(--parchment);
      border-color: var(--ink);
      text-decoration: none;
    }

    /* ---------- Fact rows ---------- */
    .fact-row {
      display: grid;
      grid-template-columns: 140px 1fr;
      gap: 8px;
      padding: 4px 0;
      font-size: 12.5px;
    }
    .fact-label {
      font-family: var(--mono);
      color: var(--ink-muted);
      font-size: 10.5px;
      letter-spacing: 0.1em;
      text-transform: uppercase;
    }
    .fact-value { color: var(--ink); }

    /* ---------- Badges ---------- */
    .badge {
      display: inline-block;
      padding: 3px 10px;
      font-family: var(--mono);
      font-size: 10px;
      letter-spacing: 0.15em;
      text-transform: uppercase;
      font-weight: 700;
      border: 1px solid;
    }
    .badge-locked {
      background: var(--ok-bg);
      color: var(--ok);
      border-color: var(--ok-edge);
    }
    .badge-unlocked {
      background: var(--warn-bg);
      color: var(--warn);
      border-color: var(--warn-edge);
    }

    /* ---------- Footer ---------- */
    .doc-footer {
      margin-top: 48px;
      padding-top: 24px;
      border-top: 2px solid var(--rule);
      font-family: var(--mono);
      font-size: 11px;
      letter-spacing: 0.08em;
      color: var(--ink-muted);
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 16px;
      flex-wrap: wrap;
    }
    .doc-footer a {
      color: var(--ink);
      text-decoration: none;
      font-weight: 700;
      letter-spacing: 0.12em;
      text-transform: uppercase;
    }
    .doc-footer a:hover { color: var(--accent); }

    /* ---------- Toast (copied confirmation) ---------- */
    .toast {
      position: fixed;
      bottom: 32px;
      left: 50%;
      transform: translateX(-50%) translateY(20px);
      background: var(--ink);
      color: var(--parchment);
      padding: 10px 22px;
      font-family: var(--mono);
      font-size: 12px;
      letter-spacing: 0.15em;
      text-transform: uppercase;
      border: 2px solid var(--ink);
      opacity: 0;
      pointer-events: none;
      transition: opacity 180ms ease, transform 180ms ease;
      z-index: 1000;
    }
    .toast.show {
      opacity: 1;
      transform: translateX(-50%) translateY(0);
    }

    /* ---------- Print ---------- */
    @media print {
      body {
        background: white;
        background-image: none;
        font-size: 11px;
      }
      .wrap { padding: 0; max-width: none; }
      .copy-btn { display: none; }
      .positions-grid { grid-template-columns: 1fr; }
      a { color: inherit; text-decoration: none; }
      .pool-section { page-break-inside: avoid; }
      .position-card { page-break-inside: avoid; }
      .doc-footer { page-break-inside: avoid; }
    }
  </style>
</head>
<body>
<div class="wrap">

  <!--
    Masthead — manuscript-style figure callout at the top of the page.
    Mirrors the makesometokens.com header strip pattern ("FIG. 1 · Solana
    Token Launcher · v1.0") so a team that's seen the marketing site
    immediately recognizes the document as part of the same family.
  -->
  <div class="masthead">
    <div class="masthead-left">
      <span class="masthead-brand">T R E B U C H E T</span>
      <span>FIG. 01 · Launch Dossier</span>
    </div>
    <div class="masthead-right">
      ${formatReportTimestamp(now)}
    </div>
  </div>

  <header class="title-block">
    ${logoBlock}
    <div>
      <p class="doc-fig">Token launch report · permanent record</p>
      <h1 class="doc-title">${safeName} <span class="doc-symbol">· ${safeSymbol}</span></h1>
      ${tokenDescription ? `<p class="doc-subtitle">${escapeHtml(tokenDescription)}</p>` : ''}
    </div>
  </header>

  ${demoBanner}
  ${statusBanner}

  <hr class="section-rule">
  <div class="enum-badge">[ 01 ] &nbsp; Token</div>
  <h2 class="section-title">Token specification</h2>

  <div class="token-summary-grid">
    <div class="token-stat">
      <div class="token-stat-label">Total supply</div>
      <div class="token-stat-value">${Number.isFinite(supply) && supply > 0 ? supply.toLocaleString() : '—'}</div>
    </div>
    <div class="token-stat">
      <div class="token-stat-label">Decimals</div>
      <div class="token-stat-value">${Number.isFinite(tokenInfo.decimals) ? tokenInfo.decimals : '—'}</div>
    </div>
    <div class="token-stat">
      <div class="token-stat-label">Launch market cap</div>
      <div class="token-stat-value">${Number.isFinite(targetMc) && targetMc > 0 ? '$' + targetMc.toLocaleString() : '—'}</div>
    </div>
    <div class="token-stat">
      <div class="token-stat-label">Pools</div>
      <div class="token-stat-value">${results.length}</div>
    </div>
  </div>

  <h3 class="subsection">Mint &amp; launch wallet</h3>
  ${renderAddressRow('Token mint', tokenInfo.mint)}
  ${tempWallet?.publicKey ? renderAddressRow('Launch wallet', tempWallet.publicKey) : ''}
  ${plannedSweepDestination ? renderAddressRow('Planned sweep destination', plannedSweepDestination) : ''}
  ${tokenInfo.metadataUri ? renderAddressRow('Metadata URI', tokenInfo.metadataUri) : ''}

  ${(tokenInfo.mintAuthorityRenounced || tokenInfo.freezeAuthorityDisabled || tokenInfo.metadataUpdateAuthorityRevoked) ? `
  <h3 class="subsection">Contract safety</h3>
  <!-- Authority-renunciation facts recorded at token creation. Each is
       independently verifiable on-chain: mint/freeze from the mint account
       (both authority options unset), metadata immutability from the
       Metaplex metadata account. Listed so auditors and listing reviewers
       know exactly what to check. -->
  ${renderFactRow('Mint authority', tokenInfo.mintAuthorityRenounced ? 'Renounced — supply is permanently capped' : 'NOT renounced')}
  ${renderFactRow('Freeze authority', tokenInfo.freezeAuthorityDisabled ? 'Disabled — holders can never be frozen' : 'NOT disabled')}
  ${renderFactRow('Metadata update authority', tokenInfo.metadataUpdateAuthorityRevoked ? 'Revoked — name/symbol/logo are permanent' : 'NOT revoked')}
  ${renderFactRow('Token program', 'SPL Token (classic) — no Token-2022 extensions')}
  ` : ''}

  <hr class="section-rule">
  <div class="enum-badge">[ 02 ] &nbsp; Tokenomics</div>
  <h2 class="section-title">Supply distribution</h2>

  <div class="tokenomics">
    <div>
      ${chartSvg}
      <div class="chart-caption">FIG. 02 · Token supply across pools &amp; positions</div>
    </div>
    <div>${breakdownHtml || '<p style="color:var(--ink-muted);">No positions configured.</p>'}</div>
  </div>

  <hr class="section-rule">
  <div class="enum-badge">[ 03 ] &nbsp; Pools &amp; Positions</div>
  <h2 class="section-title">Liquidity pool breakdown</h2>

  ${poolSections}

  ${buildAirdropReportSection()}

  <hr class="section-rule">
  <div class="enum-badge">[ 05 ] &nbsp; Verification</div>
  <h2 class="section-title">Auditing this launch</h2>
  <p style="font-size: 13px; color: var(--ink-muted, #6a4f2a);">
    Every claim in this report is verifiable on-chain. To audit the launch
    against the principles Trebuchet enforces:
  </p>
  <p style="font-size: 13px; color: var(--ink-muted, #6a4f2a);">
    <strong>Safe token contract</strong> — fetch the token mint account: the
    mint and freeze authority options must both be unset (renounced), and the
    Metaplex metadata account must show the update authority revoked. The
    mint must be owned by the classic SPL Token program (no Token-2022
    extensions such as transfer hooks or pausable supply).
  </p>
  <p style="font-size: 13px; color: var(--ink-muted, #6a4f2a);">
    <strong>Locked liquidity</strong> — each position above lists its lock
    transaction and Fee Key NFT. The lock (Raydium Burn &amp; Earn) moves the
    position NFT into the lock program's escrow and mints the Fee Key in its
    place; the on-chain locked-position account links the two. Locked
    liquidity can never be withdrawn — only its trading fees can be claimed,
    by whoever holds the Fee Key.
  </p>
  <p style="font-size: 13px; color: var(--ink-muted, #6a4f2a);">
    <strong>Concentrated LP shape</strong> — the tick ranges above define
    each position's price band; fetch each position account (via its NFT
    mint) to confirm the recorded bounds and liquidity.
  </p>
  <p style="font-size: 13px; color: var(--ink-muted, #6a4f2a);">
    <strong>Report authenticity</strong> — the permanent copy of this report
    is published to Arweave tagged with
    <code>Data-Protocol: trebuchet-launch-report</code> and
    <code>Mint: &lt;token mint&gt;</code>, uploaded and signed by the launch
    wallet — the same key that minted the token and created the pools. When
    querying Arweave for reports about a mint, ignore any item whose owner
    is not the mint's on-chain creator; only the creator-signed report is
    genuine.
  </p>

  <footer class="doc-footer">
    <div>
      <div>Trebuchet — launch Solana tokens, no middleman.</div>
      <div style="margin-top: 4px; text-transform: none; letter-spacing: 0.04em; font-size: 10px;">
        Solscan links use mainnet-beta. Tap any address or transaction signature to copy.
      </div>
    </div>
    <div>
      <a href="https://makesometokens.com/" target="_blank" rel="noopener">makesometokens.com</a>
    </div>
  </footer>

</div>

<div id="toast" class="toast" role="status" aria-live="polite">Copied</div>

<script>
  // Copy-button behavior. Single delegated listener on the body — simpler
  // than attaching one per button and survives any future re-renders
  // (though this is a static report, so re-renders don't happen).
  document.body.addEventListener('click', (e) => {
    const btn = e.target.closest('.copy-btn');
    if (!btn) return;
    const value = btn.dataset.copy;
    if (!value) return;

    const showCopied = () => {
      btn.classList.add('copied');
      const original = btn.textContent;
      btn.textContent = 'Copied';
      const toast = document.getElementById('toast');
      toast.classList.add('show');
      setTimeout(() => {
        btn.classList.remove('copied');
        btn.textContent = original;
        toast.classList.remove('show');
      }, 1400);
    };

    // Modern Clipboard API first; fall back to execCommand for older
    // browsers and odd security contexts (some local-file openings
    // disable the modern API).
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(value).then(showCopied).catch(() => {
        legacyCopy(value, showCopied);
      });
    } else {
      legacyCopy(value, showCopied);
    }
  });

  function legacyCopy(value, onSuccess) {
    const ta = document.createElement('textarea');
    ta.value = value;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      onSuccess();
    } catch (e) {
      console.error('Copy failed:', e);
    }
    document.body.removeChild(ta);
  }
</script>
</body>
</html>`;
}

// Read the user-selected token logo file as a data URL (base64-encoded
// with the correct MIME prefix). Used to embed the logo directly into
// the downloadable HTML report so the report is self-contained — the
// team can open it offline or forward it without breaking image refs.
// Returns null if no logo is selected or the read fails; the report
// gracefully falls back to a text-only header in that case.
async function readLogoAsDataUrl() {
  const logoEl = document.getElementById('tokenLogo');
  const file = logoEl?.files?.[0];
  if (!file) return null;
  return await new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
    reader.onerror = () => {
      // Don't surface this as an error log — the rest of the report is
      // perfectly usable without the logo. Quietly fall back.
      console.warn('Failed to read logo file for report embedding', reader.error);
      resolve(null);
    };
    reader.readAsDataURL(file);
  });
}

// Trigger a download of the HTML report. Filename includes the token
// symbol (sanitized) and a date stamp so multiple reports from the
// same machine don't collide. Reads the logo file first so we can
// embed it; falls back to text-only header on failure.
async function downloadLaunchReport() {
  if (!createdTokenInfo && (!lpResult || !lpResult.results || lpResult.results.length === 0)) {
    log('No launch results available yet — try again after pools are created.', 'warning');
    return;
  }
  try {
    const logoDataUrl = await readLogoAsDataUrl();
    const html = buildLaunchReportHtml({ logoDataUrl });
    const symbol = (document.getElementById('tokenSymbol')?.value.trim() || createdTokenInfo?.symbol || 'token')
      .replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 24) || 'token';
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const datePart = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
    const filename = `trebuchet-launch-${symbol}-${datePart}.html`;

    // Use a Blob + anchor click for the download. Works in Electron's
    // Chromium without main-process file-system plumbing.
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 100);
    log(`Launch report saved: ${filename}`, 'success');
  } catch (err) {
    // Catch-all: a thrown error from any step in the report-build/download
    // pipeline shouldn't leave the user with no feedback. Surface via the
    // activity log and console; the launch itself is unaffected since this
    // is post-launch reporting.
    console.error('Launch report generation failed:', err);
    log(`Failed to generate launch report: ${err.message || err}`, 'danger');
  }
}

bind('downloadReportBtnStep6', 'click', downloadLaunchReport);

// ===========================================================================
// Permanent launch report — publish to Arweave
// ===========================================================================
//
// After step 5 completes (all pools created, positions locked) we optionally
// publish the launch report to Arweave so anyone holding the token mint can
// find it — without anything being written onto the token's own metadata. Two
// artifacts go up: the rendered HTML (the same document the Download button
// produces) and a machine-readable JSON record. The SERVER signs both with the
// launch wallet, which is why this runs at step 5: that wallet is swept at
// step 6 and is gone by the time the success modal opens.
//
// Opt-out (userPrefs.publishLaunchReport) and any failure are handled by the
// server; this is fire-and-forget. The result is stashed in _publishedReport
// for the success modal's renderPublishedReportCard() to display.

function getPublishedReport() {
  return _publishedReport;
}

// Compact machine-readable launch record. Mirrors the data the HTML report
// shows but as structured JSON for querying/verification. Small (well under
// the Arweave free-tier limit) and never includes secrets.
function buildLaunchReportData(lp) {
  const results = (lp && Array.isArray(lp.results)) ? lp.results : [];
  const plannedSweepDestination = getPlannedSweepDestinationWallet();

  // Map one position record into the audit shape. Every field here exists
  // to let a third party verify a Trebuchet launch principle on-chain:
  //   - tickLower/tickUpper prove the position's range (concentrated LP);
  //   - locked + the lock tx + feeKeyNftMint prove the Burn & Earn lock
  //     (the position NFT is escrowed by the lock program and the Fee Key
  //     NFT is minted in its place — the lock account on-chain links the
  //     two, so a verifier can confirm the liquidity can never be pulled);
  //   - recipient/transferredTo + the transfer tx prove where each fee
  //     stream went.
  // Older journals (pre-feeKeyNftMint / pre-tick-recording / pre-shape
  // metadata) yield nulls for the missing fields rather than failing.
  const mapPosition = (pos, type, extra) => ({
    type,
    ...(extra || {}),
    sliceIndex: Number.isFinite(Number(pos.sliceIndex)) ? Number(pos.sliceIndex) : extra?.sliceIndex ?? null,
    bandIndex: Number.isFinite(Number(pos.bandIndex)) ? Number(pos.bandIndex) : extra?.bandIndex ?? null,
    supportIndex: Number.isFinite(Number(pos.supportIndex)) ? Number(pos.supportIndex) : extra?.supportIndex ?? null,
    sharePercent: Number.isFinite(Number(pos.sharePercent)) ? Number(pos.sharePercent) : extra?.sharePercent ?? null,
    supplyPercent: Number.isFinite(Number(pos.supplyPercent)) ? Number(pos.supplyPercent) : extra?.supplyPercent ?? null,
    lowerMultiplier: Number.isFinite(Number(pos.lowerMultiplier)) ? Number(pos.lowerMultiplier) : extra?.lowerMultiplier ?? null,
    upperMultiplier: Number.isFinite(Number(pos.upperMultiplier)) ? Number(pos.upperMultiplier) : extra?.upperMultiplier ?? null,
    depthPct: Number.isFinite(Number(pos.depthPct)) ? Number(pos.depthPct) : extra?.depthPct ?? null,
    tickLower: Number.isFinite(pos.tickLower) ? pos.tickLower : null,
    tickUpper: Number.isFinite(pos.tickUpper) ? pos.tickUpper : null,
    positionNftMint: pos.nftMint || null,
    feeKeyNftMint: pos.feeKeyNftMint || null,
    locked: pos.locked === true,
    openTx: pos.txIds?.open || null,
    lockTx: pos.txIds?.lock || null,
    transferTx: pos.txIds?.transfer || null,
  });

  const mapAirdropRow = (row) => ({
    wallet: row?.wallet || null,
    tokens: Number.isFinite(Number(row?.tokens)) ? Number(row.tokens) : null,
    amountRaw: row?.amountRaw == null ? null : String(row.amountRaw),
    txId: row?.txId || row?.signature || null,
    attempts: Number.isFinite(Number(row?.attempts)) ? Number(row.attempts) : null,
    error: row?.error || null,
  });
  const airdrop = (() => {
    if (lastAirdropResult && typeof lastAirdropResult === 'object') {
      const transferred = Array.isArray(lastAirdropResult.transferred)
        ? lastAirdropResult.transferred.map(mapAirdropRow)
        : [];
      const failed = Array.isArray(lastAirdropResult.failed)
        ? lastAirdropResult.failed.map(mapAirdropRow)
        : [];
      return {
        status: failed.length ? 'partial' : 'delivered',
        plannedRecipientCount: transferred.length + failed.length,
        deliveredCount: transferred.length,
        failedCount: failed.length,
        transferred,
        failed,
      };
    }
    const pending = buildAirdropTransferPayload();
    if (!pending || !Array.isArray(pending.recipients) || pending.recipients.length === 0) {
      return null;
    }
    return {
      status: 'pending',
      plannedRecipientCount: pending.recipients.length,
      deliveredCount: 0,
      failedCount: 0,
      tokenMint: pending.tokenMint || null,
      tokenDecimals: Number.isFinite(Number(pending.tokenDecimals)) ? Number(pending.tokenDecimals) : null,
      recipients: pending.recipients.map(mapAirdropRow),
      transferred: [],
      failed: [],
    };
  })();

  return {
    // Version of this inner payload. The Arweave envelope's Schema-Version
    // tag (owned by launchReportService) describes the envelope; this field
    // tracks the launch payload itself. v1 was the original thin shape
    // (mint + pool ids); v2 adds the per-position audit records and the
    // token-safety facts; v3 adds structured airdrop evidence; v4 adds the
    // planned final sweep destination recorded before the sweep executes; v5
    // adds slice/ladder/support shape fields for depth-chart parity checks.
    dataVersion: 5,
    launchWallet: tempWallet ? String(tempWallet.publicKey) : null,
    // Flat token identity fields kept from v1 for any reader already
    // consuming them; the structured facts live under token.
    mint: createdTokenInfo?.mint || null,
    name: createdTokenInfo?.name || null,
    symbol: createdTokenInfo?.symbol || null,
    decimals: createdTokenInfo?.decimals ?? null,
    totalSupply: createdTokenInfo?.totalSupply ?? null,
    destinationWallet: plannedSweepDestination,
    transfer: {
      status: plannedSweepDestination ? 'planned-before-sweep' : 'not-recorded',
      destinationWallet: plannedSweepDestination,
    },
    supply: (() => {
      const allocated = results.reduce(
        (s, r) => s + (Number.isFinite(r.supplyPercent) ? r.supplyPercent : 0),
        0,
      );
      return {
        allocatedToPoolsPercent: Number(allocated.toFixed(4)),
        preallocationPercent: Number(Math.max(0, 100 - allocated).toFixed(4)),
      };
    })(),
    token: {
      mint: createdTokenInfo?.mint || null,
      // Trebuchet mints classic SPL tokens; recording the program id lets a
      // verifier confirm there are no Token-2022 extensions (transfer
      // hooks, pausable, etc.) without guessing.
      tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      metadataUri: createdTokenInfo?.metadataUri || null,
      // Safety facts recorded at creation time. Each is independently
      // verifiable on-chain: mint/freeze authority from the mint account
      // (both authority options must be unset), metadata mutability from
      // the Metaplex metadata account (isMutable false, update authority
      // revoked). A verifier should treat the on-chain state as truth and
      // these flags as the launch's claim.
      authorities: {
        mintAuthorityRenounced: createdTokenInfo?.mintAuthorityRenounced === true,
        freezeAuthorityDisabled: createdTokenInfo?.freezeAuthorityDisabled === true,
        metadataUpdateAuthorityRevoked: createdTokenInfo?.metadataUpdateAuthorityRevoked === true,
        metadataImmutable: createdTokenInfo?.metadataImmutable === true,
      },
    },
    pools: results.map((r) => ({
      poolId: r.poolId || null,
      quote: r.quoteSymbol || null,
      quoteMint: r.quoteAddress || null,
      supplyPercent: Number.isFinite(r.supplyPercent) ? r.supplyPercent : null,
      launchedSide: r.launchedSide || null,
      // Pool parameters: tickSpacing identifies the CLMM fee-tier config
      // the pool was created with; initialPrice is the launch price (in
      // quote per launched token) the pool opened at.
      tickSpacing: Number.isFinite(r.tickSpacing) ? r.tickSpacing : null,
      initialPrice: r.initialPrice || null,
      createPoolTx: r.txIds?.createPool || null,
      positions: [
        ...(r.mainPositions || []).map((p) => mapPosition(p, 'main', {
          sliceIndex: p.sliceIndex ?? null,
          sharePercent: Number.isFinite(p.sharePercent) ? p.sharePercent : null,
          recipient: p.recipient || null,
          transferredTo: p.transferredTo || null,
        })),
        ...(r.ladderPositions || []).map((p) => mapPosition(p, 'ladder', {
          bandIndex: p.bandIndex ?? null,
          supplyPercent: Number.isFinite(Number(p.supplyPercent)) ? Number(p.supplyPercent) : null,
          lowerMultiplier: Number.isFinite(Number(p.lowerMultiplier)) ? Number(p.lowerMultiplier) : null,
          upperMultiplier: Number.isFinite(Number(p.upperMultiplier)) ? Number(p.upperMultiplier) : null,
        })),
        ...(r.supportPositions || []).map((p) => mapPosition(p, 'support', {
          supportIndex: p.supportIndex ?? null,
          depthPct: Number.isFinite(p.depthPct) ? p.depthPct : null,
          quoteRaw: p.quoteRaw || null,
        })),
        ...(r.bootstrap ? [mapPosition(r.bootstrap, 'bootstrap')] : []),
      ],
    })),
    airdrop,
  };
}

// Kick off (or retry) the Arweave publish. Reads shared launch state
// (createdTokenInfo, lpResult, tempWallet). Never throws; updates
// _publishedReport and refreshes the success-modal card if it's open.
// Is launch-report publishing currently enabled? Reads the in-context step-5
// toggle if present, else the Settings toggle; both reflect the same pref.
// Defaults to on if neither is in the DOM yet.
function isLaunchReportEnabled() {
  const t = document.getElementById('configPublishReportToggle')
    || document.getElementById('lpPublishReportToggle')
    || document.getElementById('publishReportToggle');
  return t ? t.checked : true;
}

// Step-5 status line (#lpReportStatus, under the Create Pools button). Shows an
// idle hint before completion, then live publish status. Kept in sync with the
// success-modal card by refreshLaunchReportUi().
function renderLaunchReportStep5Status() {
  const el = document.getElementById('lpReportStatus');
  if (!el) return;
  el.innerHTML = '';
  const rep = _publishedReport;

  if (!rep) {
    el.textContent = isLaunchReportEnabled()
      ? 'A permanent launch report will be published to Arweave when this launch completes.'
      : 'Launch report publishing is off — your launch stays private.';
    return;
  }
  if (rep.status === 'skipped') {
    el.textContent = 'Launch report publishing is off — your launch stays private.';
    return;
  }
  if (rep.status === 'pending') {
    el.textContent = 'Publishing the permanent launch report to Arweave…';
    return;
  }
  if (rep.status === 'done') {
    el.append('Permanent launch report published — ');
    const a = document.createElement('a');
    a.href = rep.htmlUri || rep.jsonUri || '#';
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = 'view on Arweave';
    el.append(a);
    return;
  }
  // failed
  el.append('Couldn’t publish the launch report. ');
  const retry = document.createElement('a');
  retry.href = '#';
  retry.textContent = 'Retry';
  retry.addEventListener('click', (e) => { e.preventDefault(); publishLaunchReportToArweave(); });
  el.append(retry);
  el.append(' — the launch itself is unaffected.');
}

// Refresh every launch-report surface from the current _publishedReport state:
// the step-5 status line and the success-modal card. Each renderer no-ops if
// its DOM isn't present, so this is safe to call any time.
function refreshLaunchReportUi() {
  try { renderLaunchReportStep5Status(); } catch (e) { console.warn('step-5 report status render failed', e); }
  try { renderPublishedReportCard(); } catch (e) { /* modal may not be open */ }
}

async function publishLaunchReportToArweave(lp) {
  const data = lp || lpResult;
  const mint = createdTokenInfo?.mint;
  if (!mint) return; // nothing to key discovery off — skip silently

  // Idempotency: skip if a publish is already in flight or has succeeded, so a
  // second completion trigger can't double-publish. A FAILED publish can still
  // be retried — status would be 'failed' here, which isn't caught.
  if (_publishedReport && (_publishedReport.status === 'pending' || _publishedReport.status === 'done')) {
    return;
  }
  // Opt-out: respect the launch-report toggle (same pref as Settings). When
  // off, record a 'skipped' state and don't publish.
  if (!isLaunchReportEnabled()) {
    _publishedReport = { status: 'skipped', reason: 'opted-out' };
    refreshLaunchReportUi();
    return;
  }
  _publishedReport = { status: 'pending' };
  refreshLaunchReportUi();

  try {
    const reportHtml = await _getReportHtml();
    const launchData = buildLaunchReportData(data);
    const poolIds = launchData.pools.map((p) => p.poolId).filter(Boolean);

    const resp = await fetch('/api/publish-launch-report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        walletPublicKey: tempWallet ? String(tempWallet.publicKey) : undefined,
        mint,
        poolIds,
        reportHtml,
        launchData,
      }),
    });
    const out = await resp.json();

    if (out && out.skipped) {
      _publishedReport = { status: 'skipped', reason: out.reason };
    } else if (out && out.failed) {
      _publishedReport = { status: 'failed', error: out.error };
      log(`Launch report publish failed: ${out.error || 'unknown error'}`, 'warning');
    } else if (out && out.success) {
      _publishedReport = { status: 'done', jsonUri: out.jsonUri, htmlUri: out.htmlUri };
      log('Permanent launch report published to Arweave', 'success');
    } else {
      _publishedReport = { status: 'failed', error: 'unexpected response' };
    }
  } catch (err) {
    _publishedReport = { status: 'failed', error: err?.message || String(err) };
    console.error('publishLaunchReportToArweave failed:', err);
  }

  refreshLaunchReportUi();
}

// ===========================================================================
// Inline Launch Report Preview
// ===========================================================================
//
// Renders the launch report HTML inline in a sandboxed iframe so the user
// can inspect addresses, pool IDs, and TX signatures before the final sweep
// (step 5) or after transfer (step 6 / success modal). Collapsed by default;
// the toggle button expands it. The download button remains the primary action.

// Memoized report HTML — build once per launch, reuse across all three
// containers. Reset by the lpDoneInfo/transferResult hide paths.
let _cachedReportHtml = null;
// Result of the Arweave publish kicked off during step 6's transfer flow,
// after the airdrop and before the sweep (see publishLaunchReportToArweave
// and runTransfer's step 6b). Shape:
//   { status: 'pending' | 'done' | 'failed' | 'skipped', jsonUri?, htmlUri?, error?, reason? }
// Read by the success modal's renderPublishedReportCard(). null = not started.
// Reset per-launch at the start of an LP run (see lp-execution.js), NOT here.
// _resetCachedReport() runs mid-transfer to rebuild the HTML with airdrop
// results — wiping the published record there would erase the step-5 publish
// before the success modal can show it.
let _publishedReport = null;
function _resetCachedReport() {
  _cachedReportHtml = null;
  // Also clear every preview iframe's srcdoc. renderLaunchReportPreview
  // only sets srcdoc when it's empty (so the iframe doesn't reload on
  // every step transition); without this, a preview iframe that was
  // already shown keeps its OLD HTML even after the cache is rebuilt
  // with fresh data. Most visible failure: step 5's preview was rendered
  // before the airdrop step ran, so it has airdrop-less HTML; without
  // clearing the iframe srcdoc, even reaching step 6 and rebuilding the
  // cache leaves step 5 stuck on the old report.
  for (const prefix of ['step5', 'step6', 'modal']) {
    const iframe = document.getElementById(prefix + 'ReportIframe');
    if (iframe && iframe.srcdoc) iframe.srcdoc = '';
  }
}

// Build (or retrieve cached) report HTML document string.
async function _getReportHtml() {
  if (_cachedReportHtml) return _cachedReportHtml;
  try {
    const logoSrc = (createdTokenInfo && createdTokenInfo.imageUri)
      ? createdTokenInfo.imageUri
      : await readLogoAsDataUrl();
    _cachedReportHtml = buildLaunchReportHtml({ logoDataUrl: logoSrc });
  } catch (e) {
    console.error('Failed to build report HTML for preview:', e);
    _cachedReportHtml = '<html><body><p>Failed to generate preview.</p></body></html>';
  }
  return _cachedReportHtml;
}

// Render the launch report preview for a given container prefix.
//   prefix: 'step5', 'step6', or 'modal'
async function renderLaunchReportPreview(prefix) {
  const container = document.getElementById(prefix + 'ReportPreview');
  const toggleBtn = document.getElementById(prefix + 'ReportToggle');
  const body = container?.querySelector('.launch-report-preview-body');
  const iframe = document.getElementById(prefix + 'ReportIframe');
  const copyAddrsBtn = document.getElementById(prefix + 'CopyAllAddrs');
  const copyTxsBtn = document.getElementById(prefix + 'CopyAllTxs');

  if (!container || !toggleBtn || !body || !iframe) return;

  // Reveal the preview container AND the toggle button. The step-6 and
  // modal toggles are standalone buttons outside the container (next to /
  // above it), initially hidden because the report doesn't exist until the
  // launch reaches this point; for step 5 the un-hide is a no-op since that
  // toggle lives in the action row shown by setLpDoneVisible().
  container.classList.remove('hidden');
  toggleBtn.classList.remove('hidden');

  // Load the report into the iframe (only if not already loaded)
  if (!iframe.srcdoc) {
    const html = await _getReportHtml();
    iframe.srcdoc = html;
  }

  // ---- Toggle expand/collapse ----
  // _wired guards against re-attaching listeners on repeated calls to
  // renderLaunchReportPreview (e.g. the initial LP success + the resume
  // path both call it). Safe because this codebase uses static HTML —
  // no virtual DOM that would replace the element and lose the flag.
  toggleBtn._wired = toggleBtn._wired || false;
  if (!toggleBtn._wired) {
    toggleBtn._wired = true;
    toggleBtn.addEventListener('click', () => {
      const expanded = !body.classList.contains('hidden');
      if (expanded) {
        body.classList.add('hidden');
        toggleBtn.classList.remove('is-expanded');
        toggleBtn.querySelector('span:last-child').textContent = 'Show launch report preview';
      } else {
        body.classList.remove('hidden');
        toggleBtn.classList.add('is-expanded');
        toggleBtn.querySelector('span:last-child').textContent = 'Hide launch report preview';
        iframe.style.height = Math.max(400, Math.min(window.innerHeight * 0.6, 700)) + 'px';
      }
    });
  }

  // ---- Bulk-copy: all addresses ----
  if (copyAddrsBtn && !copyAddrsBtn._wired) {
    copyAddrsBtn._wired = true;
    copyAddrsBtn.addEventListener('click', () => {
      _copyFromIframe(iframe, 'addrs');
    });
  }

  // ---- Bulk-copy: all TX signatures ----
  if (copyTxsBtn && !copyTxsBtn._wired) {
    copyTxsBtn._wired = true;
    copyTxsBtn.addEventListener('click', () => {
      _copyFromIframe(iframe, 'txs');
    });
  }
}

// Extract addresses or TX signatures from the iframe's rendered DOM.
function _copyFromIframe(iframe, mode) {
  try {
    const doc = iframe.contentDocument || iframe.contentWindow?.document;
    if (!doc) {
      log('Cannot access report preview — the iframe may not be loaded yet.', 'warning');
      return;
    }

    const codes = doc.querySelectorAll('code.addr-value');
    const values = [];
    const ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

    codes.forEach((code) => {
      const text = code.textContent.trim();
      if (!text || text === '\u2014') return;

      const row = code.closest('.addr-row');
      const label = row ? row.querySelector('.addr-label') : null;
      const labelText = label ? label.textContent.trim().toUpperCase() : '';

      const isTx = labelText.includes('TX');
      const isAddr = !isTx && ADDR_RE.test(text);

      if (mode === 'txs' && isTx && text.length >= 85) {
        values.push(text);
      } else if (mode === 'addrs' && isAddr) {
        values.push(text);
      }
    });

    if (values.length === 0) {
      log('No ' + (mode === 'txs' ? 'TX signatures' : 'addresses') + ' found in report.', 'warning');
      return;
    }

    const joined = values.join('\n');
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(joined).then(() => {
        log('Copied ' + values.length + ' ' + (mode === 'txs' ? 'TX signature(s)' : 'address(es)') + ' to clipboard.', 'success');
      }).catch(() => {
        _legacyCopyReport(joined, values.length, mode);
      });
    } else {
      _legacyCopyReport(joined, values.length, mode);
    }
  } catch (e) {
    console.error('Bulk copy failed:', e);
    log('Failed to copy from report preview.', 'danger');
  }
}

function _legacyCopyReport(text, count, mode) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
    log('Copied ' + count + ' ' + (mode === 'txs' ? 'TX signature(s)' : 'address(es)') + ' to clipboard.', 'success');
  } catch (e) {
    log('Copy to clipboard failed — try selecting and copying manually.', 'warning');
  }
  document.body.removeChild(ta);
}
