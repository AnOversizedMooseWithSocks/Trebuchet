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
    for (const workspace of ['configure', 'fund', 'execute', 'verify', 'recover']) {
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
      ? metrics.scrollHeight <= metrics.clientHeight + 1
        && metrics.rects.launchShell.bottom <= metrics.clientHeight + 1
        && metrics.rects.workspaceViewport.bottom <= metrics.clientHeight + 1
      : metrics.rects.cockpit.bottom <= viewport.height + 1;
    assert.ok(
      firstViewportFit,
      `${viewport.name}: launch workspace does not fit its intended viewport`,
    );

    for (const selector of ['launchShell', 'cockpit', 'chartDeck', 'tokenomicsChart', 'liquidityChart', 'fundingMeter', 'workspaceTabs', 'workspaceViewport', 'actionPanel', 'setupDock']) {
      assertRectSized(metrics.rects[selector], selector, viewport);
    }

    const initiallyVisibleSelectors = viewport.name === 'mobile'
      ? ['cockpit', 'chartDeck', 'tokenomicsChart', 'workspaceTabs', 'setupDock']
      : ['launchShell', 'cockpit', 'chartDeck', 'tokenomicsChart', 'liquidityChart', 'fundingMeter', 'workspaceTabs', 'workspaceViewport', 'actionPanel', 'setupDock'];
    for (const selector of initiallyVisibleSelectors) {
      assertRectVisible(metrics.rects[selector], selector, viewport);
    }
    if (viewport.name === 'mobile') {
      assert.ok(
        metrics.chartDeckScrollWidth > metrics.chartDeckClientWidth,
        'mobile: chart deck should expose the non-primary charts as a horizontal rail',
      );
    }
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
