#!/usr/bin/env node
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const v2Dir = path.join(root, 'public', 'v2');
const v2Url = pathToFileURL(path.join(v2Dir, 'index.html')).href;
const proofPath = path.join(v2Dir, 'viewport-smoke-proof.json');
const assetFiles = ['index.html', 'styles.css', 'api-client.js', 'app.js'];
const requiredChecks = [
  'launchVisible',
  'horizontalOverflow',
  'tokenomicsChart',
  'liquidityChart',
  'fundingMeter',
  'parityPanel',
  'firstViewportFit',
  'terminalPanelFit',
  'discoveryTokenViewport',
];

const viewports = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
];

function assertRectVisible(rect, selector, viewport) {
  assert.ok(rect, `${viewport.name}: ${selector} missing`);
  assert.ok(rect.width > 0, `${viewport.name}: ${selector} has zero width`);
  assert.ok(rect.height > 0, `${viewport.name}: ${selector} has zero height`);
  assert.ok(rect.left >= -1, `${viewport.name}: ${selector} starts outside the viewport`);
  assert.ok(rect.right <= viewport.width + 1, `${viewport.name}: ${selector} overflows horizontally`);
}

function assertRectSized(rect, selector, viewport) {
  assert.ok(rect, `${viewport.name}: ${selector} missing`);
  assert.ok(rect.width > 0, `${viewport.name}: ${selector} has zero width`);
  assert.ok(rect.height > 0, `${viewport.name}: ${selector} has zero height`);
}

async function v2AssetHashes() {
  const entries = await Promise.all(assetFiles.map(async (file) => {
    const bytes = await fs.readFile(path.join(v2Dir, file));
    return [file, crypto.createHash('sha256').update(bytes).digest('hex')];
  }));
  return Object.fromEntries(entries);
}

async function smokeViewport(browser, viewport) {
  const page = await browser.newPage({ viewport });
  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  try {
    await page.goto(v2Url, { waitUntil: 'load' });
    await page.waitForSelector('#view-launch.is-active', { timeout: 10_000 });
    await page.waitForFunction(
      () => document.querySelector('#tokenomicsChart svg')
        && document.querySelector('#parityPanel article'),
      null,
      { timeout: 10_000 },
    );

    const guidedMetrics = await page.evaluate(() => {
      const rectFor = (selector) => {
        const element = document.querySelector(selector);
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        return {
          width: rect.width,
          height: rect.height,
          top: rect.top,
          left: rect.left,
          right: rect.right,
          bottom: rect.bottom,
        };
      };
      return {
        experienceMode: document.body.dataset.experienceMode,
        welcomeText: document.querySelector('#guidedLaunchFlow')?.textContent || '',
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        sidebarVisible: Boolean(document.querySelector('.sidebar')?.getClientRects().length),
        topbarVisible: Boolean(document.querySelector('.topbar')?.getClientRects().length),
        visibleAdvancedChrome: [
          '.cockpit-heading',
          '.launch-summary-drawer',
          '#launchWorkspaceTabs',
          '.launch-choice-bar',
        ].filter((selector) => document.querySelector(selector)?.getClientRects().length),
        rects: {
          flow: rectFor('#guidedLaunchFlow'),
          welcome: rectFor('.guided-welcome'),
        },
      };
    });
    assert.equal(guidedMetrics.experienceMode, 'guided', `${viewport.name}: guided launch is not the default experience`);
    assert.match(guidedMetrics.welcomeText, /Your first launch/);
    assert.match(guidedMetrics.welcomeText, /sends no transaction, and spends no SOL/);
    assert.equal(guidedMetrics.sidebarVisible, false, `${viewport.name}: Guided Mode still shows the app sidebar`);
    assert.equal(guidedMetrics.topbarVisible, false, `${viewport.name}: Guided Mode still shows the terminal header`);
    assert.deepEqual(
      guidedMetrics.visibleAdvancedChrome,
      [],
      `${viewport.name}: Guided Mode exposes advanced launch chrome`,
    );
    assert.ok(
      guidedMetrics.scrollWidth <= guidedMetrics.clientWidth + 1,
      `${viewport.name}: guided launch overflows horizontally`,
    );
    for (const selector of ['flow', 'welcome']) {
      assertRectVisible(guidedMetrics.rects[selector], `guided ${selector}`, viewport);
    }

    await page.click('[data-action="guided-next"]');
    await page.fill('[data-guided-field="name"]', 'First Launch');
    await page.fill('[data-guided-field="symbol"]', 'FIRST');
    await page.click('[data-action="guided-next"]');
    await page.fill('[data-guided-field="destinationWallet"]', '11111111111111111111111111111112');
    await page.click('[data-action="guided-next"]');
    const guidedConsoleSkin = await page.evaluate(() => {
      const bodyStyle = getComputedStyle(document.body);
      const formStyle = getComputedStyle(document.querySelector('.guided-form-card'));
      const strategyStyle = getComputedStyle(document.querySelector('.guided-strategy-preview strong'));
      return {
        fontFamily: bodyStyle.fontFamily,
        formRadius: formStyle.borderTopLeftRadius,
        formShadow: formStyle.boxShadow,
        strategyFontSize: Number.parseFloat(strategyStyle.fontSize),
      };
    });
    assert.match(guidedConsoleSkin.fontFamily, /JetBrains Mono|SFMono-Regular|Consolas/);
    assert.equal(guidedConsoleSkin.formRadius, '0px', `${viewport.name}: Guided Mode still uses rounded glass panels`);
    assert.equal(guidedConsoleSkin.formShadow, 'none', `${viewport.name}: Guided Mode still uses floating card shadows`);
    assert.ok(guidedConsoleSkin.strategyFontSize <= 12, `${viewport.name}: Step 3 strategy copy is oversized`);
    await page.click('[data-action="guided-value-preset"][data-value="100000"]');
    await page.click('[data-action="guided-next"]');

    const guidedReview = await page.evaluate(() => {
      const visibleAdvancedPanes = Array.from(document.querySelectorAll('[data-launch-pane]'))
        .filter((panel) => panel.id !== 'guidedRunShell'
          && !panel.classList.contains('setup-dock')
          && !panel.closest('#guidedLaunchFlow')
          && !panel.hidden
          && panel.getClientRects().length > 0)
        .map((panel) => panel.id || panel.className || panel.tagName);
      return {
        text: document.querySelector('#guidedLaunchFlow')?.textContent || '',
        runLabel: document.querySelector('[data-action="guided-practice"]')?.textContent?.trim() || '',
        actionRect: (() => {
          const element = document.querySelector('[data-action="guided-practice"]');
          if (!element) return null;
          const rect = element.getBoundingClientRect();
          return { width: rect.width, height: rect.height, top: rect.top, left: rect.left, right: rect.right, bottom: rect.bottom };
        })(),
        visibleAdvancedPanes,
      };
    });
    assert.match(guidedReview.text, /Ready to practice/);
    assert.match(guidedReview.runLabel, /Start practice launch/);
    assertRectVisible(guidedReview.actionRect, 'guided practice action', viewport);
    assert.deepEqual(guidedReview.visibleAdvancedPanes, [], `${viewport.name}: guided review exposes advanced wallet operations`);

    await page.click('.guided-advanced-shortcut');
    await page.waitForFunction(() => document.body.dataset.experienceMode === 'advanced');
    await page.click('.launch-workspace-tab[data-launch-workspace="configure"]');

    const collapsedMetrics = await page.evaluate(() => {
      const cockpit = document.querySelector('.launch-summary-drawer');
      const workspace = document.querySelector('#launchWorkspaceViewport');
      const shell = document.querySelector('#view-launch .surface-main');
      const rect = (element) => {
        const value = element?.getBoundingClientRect();
        return value ? { top: value.top, bottom: value.bottom, width: value.width, height: value.height } : null;
      };
      return {
        open: cockpit?.open === true,
        scrollHeight: document.documentElement.scrollHeight,
        clientHeight: document.documentElement.clientHeight,
        cockpit: rect(cockpit),
        workspace: rect(workspace),
        shell: rect(shell),
        workspaceOverflowY: workspace ? getComputedStyle(workspace).overflowY : null,
      };
    });
    assert.equal(collapsedMetrics.open, false, `${viewport.name}: launch summary should start collapsed`);
    assert.ok(collapsedMetrics.cockpit?.height > 0 && collapsedMetrics.cockpit.height < 80, `${viewport.name}: collapsed summary is not compact`);
    await page.click('.launch-summary-drawer > summary');

    const metrics = await page.evaluate(() => {
      const rectFor = (selector) => {
        const element = document.querySelector(selector);
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        return {
          width: rect.width,
          height: rect.height,
          top: rect.top,
          left: rect.left,
          right: rect.right,
          bottom: rect.bottom,
        };
      };
      return {
        clientWidth: document.documentElement.clientWidth,
        clientHeight: document.documentElement.clientHeight,
        scrollWidth: document.documentElement.scrollWidth,
        scrollHeight: document.documentElement.scrollHeight,
        title: document.title,
        launchVisible: document.querySelector('#view-launch')?.classList.contains('is-active') === true,
        chartSvgCount: document.querySelectorAll('#chartDeck svg').length,
        depthNodeCount: document.querySelectorAll('#liquidityChart *').length,
        fundingRowCount: document.querySelectorAll('#fundingMeter .funding-row').length,
        parityRowCount: document.querySelectorAll('#parityPanel article').length,
        chartDeckClientWidth: document.querySelector('#chartDeck')?.clientWidth ?? 0,
        chartDeckScrollWidth: document.querySelector('#chartDeck')?.scrollWidth ?? 0,
        rects: {
          launchShell: rectFor('#view-launch .surface-main'),
          cockpit: rectFor('.cockpit-board'),
          chartDeck: rectFor('#chartDeck'),
          tokenomicsChart: rectFor('#tokenomicsChart'),
          liquidityChart: rectFor('#liquidityChart'),
          fundingMeter: rectFor('#fundingMeter'),
          workspaceTabs: rectFor('#launchWorkspaceTabs'),
          workspaceViewport: rectFor('#launchWorkspaceViewport'),
          actionPanel: rectFor('.cockpit-board .action-panel'),
          setupDock: rectFor('.setup-dock'),
        },
      };
    });

    const workspaceStates = {};
    for (const workspace of ['wallet', 'configure', 'fund', 'mint', 'liquidity', 'finish']) {
      await page.click(`.launch-workspace-tab[data-launch-workspace="${workspace}"]`);
      workspaceStates[workspace] = await page.evaluate((selectedWorkspace) => {
        const selectedTab = document.querySelector(`.launch-workspace-tab[data-launch-workspace="${selectedWorkspace}"]`);
        const visiblePaneCount = Array.from(document.querySelectorAll('[data-launch-pane]'))
          .filter((panel) => !panel.hidden && panel.getClientRects().length > 0).length;
        const classicSection = document.querySelector(`[data-classic-workspace="${selectedWorkspace}"]`);
        return {
          bodyWorkspace: document.body.dataset.launchWorkspace,
          selected: selectedTab?.getAttribute('aria-selected') === 'true',
          visiblePaneCount,
          classicSectionVisible: classicSection
            ? !classicSection.hidden && classicSection.getClientRects().length > 0
            : selectedWorkspace === 'configure',
        };
      }, workspace);
    }
    await page.click('.launch-workspace-tab[data-launch-workspace="configure"]');

    assert.deepEqual(pageErrors, [], `${viewport.name}: page errors`);
    assert.deepEqual(consoleErrors, [], `${viewport.name}: console errors`);
    assert.equal(metrics.title, 'TREBUCHET · makesometokens');
    assert.equal(metrics.launchVisible, true, `${viewport.name}: launch view is not active`);
    assert.ok(
      metrics.scrollWidth <= metrics.clientWidth + 1,
      `${viewport.name}: horizontal overflow ${metrics.scrollWidth} > ${metrics.clientWidth}`,
    );
    assert.ok(metrics.chartSvgCount >= 1, `${viewport.name}: tokenomics chart did not render`);
    assert.ok(metrics.depthNodeCount > 0, `${viewport.name}: liquidity chart did not render`);
    assert.ok(metrics.fundingRowCount >= 3, `${viewport.name}: funding meter did not render`);
    assert.ok(metrics.parityRowCount >= 3, `${viewport.name}: parity panel did not render`);
    for (const [workspace, workspaceState] of Object.entries(workspaceStates)) {
      assert.equal(workspaceState.bodyWorkspace, workspace, `${viewport.name}: ${workspace} did not become active`);
      assert.equal(workspaceState.selected, true, `${viewport.name}: ${workspace} tab is not selected`);
      assert.ok(workspaceState.visiblePaneCount > 0, `${viewport.name}: ${workspace} has no visible workspace pane`);
      assert.equal(workspaceState.classicSectionVisible, true, `${viewport.name}: ${workspace} content is hidden`);
    }
    const firstViewportFit = viewport.name === 'desktop'
      ? collapsedMetrics.workspace.top < collapsedMetrics.clientHeight
        && collapsedMetrics.workspaceOverflowY === 'auto'
      : collapsedMetrics.cockpit.bottom <= viewport.height + 1;
    assert.ok(
      firstViewportFit,
      `${viewport.name}: launch workspace does not fit its intended viewport`,
    );

    for (const selector of ['launchShell', 'cockpit', 'chartDeck', 'tokenomicsChart', 'liquidityChart', 'fundingMeter', 'workspaceTabs', 'workspaceViewport', 'setupDock']) {
      assertRectSized(metrics.rects[selector], selector, viewport);
    }

    const initiallyVisibleSelectors = viewport.name === 'mobile'
      ? ['cockpit', 'chartDeck', 'tokenomicsChart', 'workspaceTabs', 'setupDock']
      : ['cockpit', 'chartDeck', 'tokenomicsChart', 'liquidityChart', 'fundingMeter', 'workspaceTabs'];
    for (const selector of initiallyVisibleSelectors) {
      assertRectVisible(metrics.rects[selector], selector, viewport);
    }
    if (viewport.name === 'desktop') {
      assert.ok(metrics.rects.workspaceViewport.top < viewport.height, 'desktop: active phase panel starts below the viewport');
      assert.ok(metrics.rects.setupDock.top < viewport.height, 'desktop: configure panel starts below the viewport');
    }
    if (viewport.name === 'mobile') {
      assert.ok(
        metrics.chartDeckScrollWidth <= metrics.chartDeckClientWidth + 1,
        'mobile: expanded launch summary should not require horizontal scrolling',
      );
    }
    let terminalPanelFit = true;
    if (viewport.name === 'desktop') {
      await page.click('.launch-workspace-tab[data-launch-workspace="finish"]');
      const terminalMetrics = await page.evaluate(() => {
        const bridge = document.querySelector('#classicBridge');
        bridge.classList.add('has-recovery-notice', 'is-terminal-launch');
        bridge.innerHTML = `
          <aside class="recovered-plan-notice" role="status">
            <i></i><span><strong>Recovery loaded</strong><small>Only unfinished work remains.</small></span><button class="text-button">View record</button>
          </aside>
          <section class="classic-workspace-section classic-workspace-verify" data-classic-workspace="finish">
            <section class="launch-step-guide is-complete"><span class="launch-step-kicker">Launch complete</span><div><h2>Assets swept and proof recorded</h2><p>Launch wallet empty.</p></div><aside><span><strong>Final sweep verified.</strong></span></aside></section>
            <div class="finalize-panel is-terminal"><div class="finalize-head"><span><h3>Launch complete</h3></span></div><div class="finalize-grid"><span><small>Sweep</small><strong>Recorded</strong></span></div><div class="verify-panel-stage"><div class="proof-review-panel"><div class="proof-link-grid"><span><small>Mint</small><strong>Mint111</strong></span></div></div></div><div class="operator-toolbar compact"><button class="pill-button">Download proof</button></div></div>
          </section>`;
        const rect = (selector) => {
          const value = document.querySelector(selector)?.getBoundingClientRect();
          return value ? { top: value.top, bottom: value.bottom, height: value.height } : null;
        };
        return {
          viewport: rect('#launchWorkspaceViewport'),
          bridge: rect('#classicBridge'),
          notice: rect('.recovered-plan-notice'),
          phase: rect('.classic-workspace-verify'),
          guide: rect('.launch-step-guide.is-complete'),
          finalize: rect('.finalize-panel.is-terminal'),
        };
      });
      terminalPanelFit = Boolean(
        terminalMetrics.viewport
        && terminalMetrics.bridge
        && terminalMetrics.notice
        && terminalMetrics.phase
        && terminalMetrics.guide
        && terminalMetrics.finalize
        && terminalMetrics.notice.height <= 46
        && terminalMetrics.phase.top - terminalMetrics.notice.bottom <= 12
        && terminalMetrics.guide.top < viewport.height
        && terminalMetrics.finalize.top < viewport.height
        && terminalMetrics.phase.bottom <= terminalMetrics.viewport.bottom + 1
      );
      assert.ok(terminalPanelFit, `desktop: terminal recovery workspace is not tightly panelized: ${JSON.stringify(terminalMetrics)}`);
    }
    await page.click('.nav-item[data-view="discovery"]');
    await page.waitForFunction(() => document.body.dataset.activeView === 'discovery');
    const discoveryMetrics = await page.evaluate(() => {
      const rect = (selector) => {
        const value = document.querySelector(selector)?.getBoundingClientRect();
        return value ? { top: value.top, bottom: value.bottom, width: value.width, height: value.height } : null;
      };
      return {
        tabs: rect('.discovery-pane-tabs'),
        firstTab: rect('.discovery-pane-tab'),
        tokenPanel: rect('.token-discovery-panel'),
        tokenFeed: rect('#personalTokenNetwork'),
        personalizeBannerCount: document.querySelectorAll('.discovery-personalize-banner, #discoveryPersonalizeBanner').length,
        duplicateWalletActions: document.querySelectorAll('#view-discovery .surface-main [data-discovery-pane-panel="tokens"] [data-action="open-wallet-tracking"]').length,
      };
    });
    const discoveryTokenViewport = Boolean(
      discoveryMetrics.tabs
      && discoveryMetrics.firstTab
      && discoveryMetrics.tokenPanel
      && discoveryMetrics.tokenFeed
      && discoveryMetrics.tabs.height <= 36
      && discoveryMetrics.firstTab.height <= 36
      && discoveryMetrics.tokenPanel.top - discoveryMetrics.tabs.bottom <= 10
      && discoveryMetrics.tokenPanel.top < viewport.height
      && discoveryMetrics.personalizeBannerCount === 0
      && discoveryMetrics.duplicateWalletActions === 0
    );
    assert.ok(discoveryTokenViewport, `${viewport.name}: Discovery navigation still crowds the token feed: ${JSON.stringify(discoveryMetrics)}`);
    return {
      name: viewport.name,
      width: viewport.width,
      height: viewport.height,
      passed: true,
      checks: {
        launchVisible: metrics.launchVisible,
        horizontalOverflow: metrics.scrollWidth <= metrics.clientWidth + 1,
        tokenomicsChart: metrics.chartSvgCount >= 1,
        liquidityChart: metrics.depthNodeCount > 0,
        fundingMeter: metrics.fundingRowCount >= 3,
        parityPanel: metrics.parityRowCount >= 3,
        firstViewportFit,
        terminalPanelFit,
        discoveryTokenViewport,
      },
    };
  } finally {
    await page.close();
  }
}

await fs.rm(proofPath, { force: true });
const startedAt = Date.now();
const browser = await chromium.launch({ headless: true });
try {
  const results = [];
  for (const viewport of viewports) {
    results.push(await smokeViewport(browser, viewport));
  }
  const proof = {
    artifactVersion: 1,
    kind: 'trebuchet-v2-viewport-smoke',
    passed: true,
    command: 'npm run test:v2:viewport',
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    target: v2Url,
    requiredChecks,
    assetHashes: await v2AssetHashes(),
    viewports: results,
  };
  await fs.writeFile(proofPath, `${JSON.stringify(proof, null, 2)}\n`);
  console.log(`v2 viewport smoke passed for ${viewports.map((viewport) => viewport.name).join(', ')}`);
} finally {
  await browser.close();
}
