(function installTrebuchetV2Api(global) {
  const API_SESSION_PATH = '/api/session';
  const LAUNCH_PLAN_PATH = '/api/v2/launch-plan';
  const V2_EXECUTION_READINESS_PATH = '/api/v2/execution-readiness';
  const V2_DEMO_LAUNCH_RUN_PATH = '/api/v2/demo-launch/run';
  const V2_WALLETS_PATH = '/api/v2/wallets';
  const V2_RUN_ARM_PATH = '/api/v2/run-envelope/arm';
  const V2_RUN_EXECUTE_NEXT_PATH = '/api/v2/run-envelope/execute-next';
  const V2_VIEWPORT_SMOKE_PROOF_PATH = '/api/v2/viewport-smoke-proof';
  const V2_DISCOVERY_INSPECT_PATH = '/api/v2/discovery/inspect';
  const V2_PERSONAL_DISCOVERY_PATH = '/api/v2/discovery/personal';
  const V2_DISCOVERY_WALLETS_PATH = '/api/v2/discovery/wallets';
  const V2_DISCOVERY_SCAN_PATH = '/api/v2/discovery/scan';
  const WALLET_QR_PATH = '/api/wallet-qr';
  const PENDING_WALLETS_PATH = '/api/pending-wallets';
  const SECRET_PIN_PATH = '/api/secret-pin';
  const VANITY_CA_CANDIDATES_PATH = '/api/vanity-ca-candidates';
  const CLMM_FEE_TIERS_PATH = '/api/clmm-fee-tiers';
  const QUOTE_TOKEN_INFO_PATH = '/api/quote-token-info';
  const ESTIMATE_LP_FUNDING_PATH = '/api/estimate-lp-funding';
  const ACQUIRE_QUOTE_TOKENS_PATH = '/api/acquire-quote-tokens';
  const CHECK_BALANCE_DETAILED_PATH = '/api/check-balance-detailed';
  const FIND_FUNDER_PATH = '/api/find-funder';
  const CANCEL_VANITY_GRIND_PATH = '/api/cancel-vanity-grind';
  const DIAGNOSE_LAUNCH_PATH = '/api/diagnose-launch';
  const LAUNCH_JOURNALS_PATH = '/api/launch-journals';
  const LP_PROGRESS_PATH = '/api/lp-progress';
  const AIRDROP_PROGRESS_PATH = '/api/airdrop-progress';
  const RUN_AIRDROP_PATH = '/api/run-airdrop';
  const RETRY_AIRDROP_PATH = '/api/retry-airdrop';
  const PUBLISH_LAUNCH_REPORT_PATH = '/api/publish-launch-report';
  const TRANSFER_ASSETS_PATH = '/api/transfer-assets';
  const SERVER_LOGS_PATH = '/api/server-logs';
  const APP_VERSION_PATH = '/api/app-version';
  const CHECK_FOR_UPDATES_PATH = '/api/check-for-updates';
  const BOOT_ENDPOINTS = {
    appVersion: APP_VERSION_PATH,
    prefs: '/api/user-prefs',
    demo: '/api/demo/status',
    rpcConfig: '/api/rpc-config',
    rpcHealth: '/api/rpc-health',
    journals: '/api/launch-journals?includeCompleted=1',
    pendingWallets: PENDING_WALLETS_PATH,
    secretPin: `${SECRET_PIN_PATH}/status`,
    vanityCandidates: VANITY_CA_CANDIDATES_PATH,
    v2Wallets: V2_WALLETS_PATH,
    feeTiers: CLMM_FEE_TIERS_PATH,
    viewportSmoke: V2_VIEWPORT_SMOKE_PROOF_PATH,
    personalDiscovery: V2_PERSONAL_DISCOVERY_PATH,
  };

  class V2ApiError extends Error {
    constructor(message, options = {}) {
      super(message);
      this.name = 'V2ApiError';
      this.code = options.code || 'V2_API_ERROR';
      this.status = options.status ?? null;
      this.response = options.response && typeof options.response === 'object'
        ? options.response
        : null;
      if (this.response) {
        for (const [key, value] of Object.entries(this.response)) {
          if (['success', 'error', 'message', 'code', 'status'].includes(key)) continue;
          if (!(key in this)) this[key] = value;
        }
      }
    }
  }

  function errorMessage(error) {
    if (!error) return null;
    if (typeof error === 'string') return error;
    return error.message || String(error);
  }

  function copyHeaders(headers) {
    const output = {};
    if (!headers) return output;
    const HeadersCtor = global.Headers;
    if (HeadersCtor && headers instanceof HeadersCtor) {
      headers.forEach((value, key) => {
        output[key] = value;
      });
      return output;
    }
    if (Array.isArray(headers)) {
      headers.forEach(([key, value]) => {
        output[key] = value;
      });
      return output;
    }
    return { ...headers };
  }

  function isPlainObject(value) {
    if (!value || typeof value !== 'object') return false;
    const FormDataCtor = global.FormData;
    if (FormDataCtor && value instanceof FormDataCtor) return false;
    return !(value instanceof ArrayBuffer);
  }

  function apiRuntimeStatus(fetchImpl, locationLike) {
    if (typeof fetchImpl !== 'function') {
      return { ok: false, reason: 'Fetch is unavailable in this runtime.' };
    }
    const protocol = locationLike?.protocol;
    if (protocol === 'file:') {
      return { ok: false, reason: 'Static file preview; local API is unavailable.' };
    }
    if (protocol && !['http:', 'https:'].includes(protocol)) {
      return { ok: false, reason: `${protocol} preview; local API is unavailable.` };
    }
    return { ok: true, reason: null };
  }

  function shortAddress(value) {
    const text = String(value || '');
    if (text.length <= 12) return text || 'Unknown';
    return `${text.slice(0, 4)}...${text.slice(-4)}`;
  }

  function rpcLabel(activeUrl, saved) {
    const savedEntry = Array.isArray(saved)
      ? saved.find((entry) => entry?.url === activeUrl)
      : null;
    if (savedEntry?.name) return savedEntry.name;
    try {
      const parsed = new URL(activeUrl);
      return parsed.hostname.replace(/^www\./, '') || 'Custom RPC';
    } catch {
      return activeUrl ? shortAddress(activeUrl) : 'Unknown RPC';
    }
  }

  function normalizeHealth(value) {
    return ['good', 'slow', 'error'].includes(value) ? value : 'unknown';
  }

  function healthLabel(value, latencyMs) {
    const normalized = normalizeHealth(value);
    if (normalized === 'good') return latencyMs === 0 ? 'healthy demo RPC' : `healthy ${latencyMs}ms`;
    if (normalized === 'slow') return latencyMs == null ? 'slow' : `slow ${latencyMs}ms`;
    if (normalized === 'error') return 'unhealthy';
    return 'unknown';
  }

  function safeArray(value) {
    return Array.isArray(value) ? value : [];
  }

  function normalizeViewportSmokeProof(input, error = null) {
    const proof = input?.proof || input || null;
    if (!proof || typeof proof !== 'object') {
      return {
        passed: false,
        state: error ? 'unavailable' : 'missing',
        detail: error || 'Viewport smoke proof has not been generated.',
      };
    }
    const viewports = safeArray(proof.viewports).map((row) => ({
      name: String(row?.name || ''),
      width: Number(row?.width || 0),
      height: Number(row?.height || 0),
      passed: row?.passed === true,
      checks: row?.checks && typeof row.checks === 'object' ? row.checks : {},
    })).filter((row) => row.name);
    return {
      passed: proof.passed === true,
      state: proof.state || (proof.passed === true ? 'valid' : 'missing'),
      detail: proof.detail || (proof.passed === true
        ? 'Viewport smoke proof is attached.'
        : 'Viewport smoke proof has not passed.'),
      artifactVersion: proof.artifactVersion ?? null,
      kind: proof.kind || null,
      generatedAt: proof.generatedAt || null,
      command: proof.command || null,
      requiredChecks: safeArray(proof.requiredChecks).map((check) => String(check || '')).filter(Boolean),
      expectedRequiredChecks: safeArray(proof.expectedRequiredChecks).map((check) => String(check || '')).filter(Boolean),
      viewports,
      assetHashes: proof.assetHashes && typeof proof.assetHashes === 'object' ? proof.assetHashes : {},
      expectedAssetHashes: proof.expectedAssetHashes && typeof proof.expectedAssetHashes === 'object'
        ? proof.expectedAssetHashes
        : {},
    };
  }

  function normalizeReleaseTrust(input = {}) {
    if (!input || typeof input !== 'object') {
      return {
        status: 'unsigned-test-artifact',
        label: 'Unsigned test artifact',
        signingStatus: 'unsigned',
        notarizationStatus: 'not-notarized',
        platform: null,
        detail: 'Release downloads should be treated as unsigned and not notarized unless the release notes explicitly say otherwise.',
      };
    }
    return {
      status: input.status || 'unknown',
      label: input.label || input.status || 'Signing unknown',
      signingStatus: input.signingStatus || 'unknown',
      notarizationStatus: input.notarizationStatus || 'unknown',
      platform: input.platform || null,
      detail: input.detail || 'Check the release notes before installing this build.',
    };
  }

  function deriveV2BootState(input = {}) {
    const endpoints = input.endpoints || {};
    const apiAvailable = input.apiAvailable === true;
    const appVersion = endpoints.appVersion?.ok ? endpoints.appVersion.data || {} : {};
    const prefs = endpoints.prefs?.ok ? endpoints.prefs.data?.prefs || {} : {};
    const demo = endpoints.demo?.ok ? endpoints.demo.data || {} : {};
    const rpcConfig = endpoints.rpcConfig?.ok ? endpoints.rpcConfig.data?.config || {} : {};
    const rpcHealth = endpoints.rpcHealth?.ok ? endpoints.rpcHealth.data || {} : {};
    const journals = safeArray(endpoints.journals?.ok ? endpoints.journals.data?.journals : []);
    const pendingWallets = safeArray(
      endpoints.pendingWallets?.ok ? endpoints.pendingWallets.data?.wallets : [],
    );
    const secretPinStatus = endpoints.secretPin?.ok ? endpoints.secretPin.data?.status || {} : {};
    const vanityCandidates = safeArray(
      endpoints.vanityCandidates?.ok ? endpoints.vanityCandidates.data?.candidates : [],
    );
    const viewportSmoke = normalizeViewportSmokeProof(
      endpoints.viewportSmoke?.ok ? endpoints.viewportSmoke.data : null,
      endpoints.viewportSmoke?.ok ? null : endpoints.viewportSmoke?.error,
    );
    const vanityAvailabilityKnown = typeof demo.vanity?.available === 'boolean';
    const v2Wallets = safeArray(endpoints.v2Wallets?.ok ? endpoints.v2Wallets.data?.wallets : []);
    const feeTiers = safeArray(endpoints.feeTiers?.ok ? endpoints.feeTiers.data?.tiers : []);
    const personalDiscovery = endpoints.personalDiscovery?.ok
      ? endpoints.personalDiscovery.data || {}
      : {};
    const activeJournals = journals.filter((journal) => journal?.status === 'active');
    const failedJournals = journals.filter((journal) => journal?.status === 'failed');
    const health = normalizeHealth(rpcHealth.health);
    const detail = apiAvailable
      ? 'Local API connected.'
      : errorMessage(input.error) || 'Static preview; local API is unavailable.';

    return {
      api: {
        available: apiAvailable,
        status: apiAvailable ? 'connected' : input.status || 'static',
        detail,
        error: apiAvailable ? null : errorMessage(input.error),
        tokenPresent: Boolean(input.sessionToken),
      },
      app: {
        version: appVersion.version || null,
        releaseUrl: appVersion.releaseUrl || 'https://github.com/AnOversizedMooseWithSocks/Trebuchet/releases',
        updateCheckAvailable: endpoints.appVersion?.ok === true,
        checkForUpdatesOnStartup: appVersion.checkForUpdatesOnStartup !== false && prefs.checkForUpdatesOnStartup !== false,
        releaseTrust: normalizeReleaseTrust(appVersion.releaseTrust),
      },
      prefs: {
        demoMode: prefs.demoMode === true,
        publishLaunchReport: prefs.publishLaunchReport !== false,
        checkForUpdatesOnStartup: prefs.checkForUpdatesOnStartup !== false,
      },
      demo: {
        active: demo.active === true || prefs.demoMode === true,
        vanityAvailable: demo.vanity?.available === true,
        vanityReason: demo.vanity?.reason || null,
      },
      rpc: {
        activeUrl: rpcConfig.active || null,
        label: rpcLabel(rpcConfig.active, rpcConfig.saved),
        saved: safeArray(rpcConfig.saved),
        savedCount: safeArray(rpcConfig.saved).length,
        health,
        healthLabel: healthLabel(health, rpcHealth.latencyMs),
        latencyMs: rpcHealth.latencyMs ?? null,
        error: rpcHealth.error || endpoints.rpcHealth?.error || null,
      },
      recovery: {
        journals,
        pendingWallets,
        journalCount: journals.length,
        activeJournalCount: activeJournals.length,
        failedJournalCount: failedJournals.length,
        pendingWalletCount: pendingWallets.length,
      },
      wallets: {
        managed: v2Wallets.length ? v2Wallets : pendingWallets,
        managedCount: v2Wallets.length || pendingWallets.length,
      },
      secretPin: {
        configured: secretPinStatus.configured === true,
        unlocked: secretPinStatus.unlocked === true,
        locked: secretPinStatus.locked === true,
        version: secretPinStatus.version || null,
        kdf: secretPinStatus.kdf || null,
        deviceSecretProtected: secretPinStatus.deviceSecretProtected === true,
        deviceSecretAvailable: secretPinStatus.deviceSecretAvailable !== false,
      },
      vanity: {
        available: vanityAvailabilityKnown ? demo.vanity.available === true : endpoints.vanityCandidates?.ok === true,
        reason: vanityAvailabilityKnown && demo.vanity.available === false
          ? demo.vanity.reason || 'Vanity grinder unavailable.'
          : demo.vanity?.reason || endpoints.vanityCandidates?.error || null,
        candidates: vanityCandidates,
        candidateCount: vanityCandidates.length,
        secretPinLocked: endpoints.vanityCandidates?.data?.secretPinLocked === true,
      },
      feeTiers: {
        tiers: feeTiers,
        available: endpoints.feeTiers?.ok === true && feeTiers.length > 0,
        error: endpoints.feeTiers?.error || null,
      },
      discovery: {
        wallets: safeArray(personalDiscovery.wallets),
        snapshot: personalDiscovery.snapshot && typeof personalDiscovery.snapshot === 'object'
          ? personalDiscovery.snapshot
          : null,
        job: personalDiscovery.job && typeof personalDiscovery.job === 'object'
          ? personalDiscovery.job
          : { status: 'idle' },
        available: endpoints.personalDiscovery?.ok === true,
        error: endpoints.personalDiscovery?.ok ? null : endpoints.personalDiscovery?.error || null,
      },
      viewportSmoke,
      endpointStatus: Object.fromEntries(
        Object.entries(endpoints).map(([key, result]) => [key, Boolean(result?.ok)]),
      ),
    };
  }

  function createV2ApiClient(options = {}) {
    const fetchImpl = options.fetchImpl || (typeof global.fetch === 'function'
      ? global.fetch.bind(global)
      : null);
    const locationLike = options.locationLike || global.location || null;
    const baseUrl = options.baseUrl || '';
    const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 3500;
    let sessionTokenPromise = null;

    function resolvePath(path) {
      if (!baseUrl) return path;
      return new URL(path, baseUrl).toString();
    }

    async function rawRequest(path, init = {}) {
      if (typeof fetchImpl !== 'function') {
        throw new V2ApiError('Fetch is unavailable in this runtime.', { code: 'NO_FETCH' });
      }

      const { timeoutMs: timeoutOverride, ...requestInit } = init;
      const effectiveTimeoutMs = Number.isFinite(timeoutOverride) ? timeoutOverride : timeoutMs;
      const headers = copyHeaders(requestInit.headers);
      let body = requestInit.body;
      if (isPlainObject(body)) {
        headers['Content-Type'] = headers['Content-Type'] || 'application/json';
        body = JSON.stringify(body);
      }
      headers.Accept = headers.Accept || 'application/json';

      const AbortControllerCtor = global.AbortController;
      const controller = effectiveTimeoutMs > 0 && AbortControllerCtor ? new AbortControllerCtor() : null;
      const timeoutId = controller
        ? global.setTimeout(() => controller.abort(), effectiveTimeoutMs)
        : null;

      try {
        const response = await fetchImpl(resolvePath(path), {
          credentials: 'same-origin',
          ...requestInit,
          headers,
          body,
          signal: init.signal || controller?.signal,
        });

        let data = null;
        let jsonError = null;
        if (response && typeof response.json === 'function') {
          try {
            data = await response.json();
          } catch (error) {
            jsonError = error;
          }
        }

        if (!response || response.ok !== true) {
          const status = response?.status || 0;
          throw new V2ApiError(
            data?.error || data?.message || `HTTP ${status || 'request failed'}`,
            {
              code: data?.code || 'HTTP_ERROR',
              status,
              response: data,
            },
          );
        }
        if (jsonError) {
          throw new V2ApiError('API response was not valid JSON.', {
            code: 'INVALID_JSON',
            status: response.status || null,
          });
        }
        if (data?.success === false) {
          throw new V2ApiError(data.error || data.message || 'API request failed.', {
            code: data.code || 'API_ERROR',
            status: response.status || null,
            response: data,
          });
        }
        return data;
      } catch (error) {
        if (error?.name === 'AbortError') {
          throw new V2ApiError('Request timed out.', { code: 'TIMEOUT' });
        }
        throw error;
      } finally {
        if (timeoutId) global.clearTimeout(timeoutId);
      }
    }

    async function getSessionToken() {
      if (!sessionTokenPromise) {
        sessionTokenPromise = rawRequest(API_SESSION_PATH).then((data) => {
          if (!data?.token) {
            throw new V2ApiError('API session response missing token.', { code: 'BAD_SESSION' });
          }
          return data.token;
        });
      }
      return sessionTokenPromise;
    }

    async function request(path, init = {}) {
      const headers = copyHeaders(init.headers);
      if (path !== API_SESSION_PATH) {
        headers['x-trebuchet-session'] = await getSessionToken();
      }
      return rawRequest(path, { ...init, headers });
    }

    async function safeGet(path) {
      try {
        return { ok: true, data: await request(path) };
      } catch (error) {
        return { ok: false, error: errorMessage(error), code: error?.code || null };
      }
    }

    async function stageLaunchPlan(config) {
      const data = await request(LAUNCH_PLAN_PATH, {
        method: 'POST',
        body: config || {},
      });
      if (!data?.plan) {
        throw new V2ApiError('Launch plan response missing plan.', { code: 'BAD_LAUNCH_PLAN' });
      }
      return data.plan;
    }

    async function checkExecutionReadiness({
      walletPublicKey,
      config,
      tokenMint,
      priorResults,
      fundingEstimate,
      airdropRecipients,
    } = {}) {
      const data = await request(V2_EXECUTION_READINESS_PATH, {
        method: 'POST',
        body: { walletPublicKey, config: config || {}, tokenMint, priorResults, fundingEstimate, airdropRecipients },
      });
      if (!data?.readiness) {
        throw new V2ApiError('Execution readiness response missing readiness.', { code: 'BAD_EXECUTION_READINESS' });
      }
      return data.readiness;
    }

    async function inspectDiscoveryToken(mint) {
      const data = await request(V2_DISCOVERY_INSPECT_PATH, {
        method: 'POST',
        body: { mint: String(mint || '').trim() },
        timeoutMs: 20000,
      });
      if (!data?.record) {
        throw new V2ApiError('Discovery response missing token record.', { code: 'BAD_DISCOVERY_RECORD' });
      }
      return data.record;
    }

    async function getPersonalDiscovery() {
      return request(V2_PERSONAL_DISCOVERY_PATH);
    }

    async function addDiscoveryWallet({ publicKey, label } = {}) {
      return request(V2_DISCOVERY_WALLETS_PATH, {
        method: 'POST',
        body: { publicKey: String(publicKey || '').trim(), label: String(label || '').trim() },
      });
    }

    async function setDiscoveryWalletEnabled(publicKey, enabled) {
      return request(`${V2_DISCOVERY_WALLETS_PATH}/${encodeURIComponent(publicKey)}/enabled`, {
        method: 'POST',
        body: { enabled: enabled === true },
      });
    }

    async function removeDiscoveryWallet(publicKey) {
      return request(`${V2_DISCOVERY_WALLETS_PATH}/${encodeURIComponent(publicKey)}`, {
        method: 'DELETE',
      });
    }

    async function scanPersonalDiscovery(limits = {}) {
      return request(V2_DISCOVERY_SCAN_PATH, {
        method: 'POST',
        body: { limits },
      });
    }

    async function runDemoLaunch({ walletPublicKey, config, fundingEstimate, airdropRecipients } = {}) {
      const data = await request(V2_DEMO_LAUNCH_RUN_PATH, {
        method: 'POST',
        // A complete local practice launch creates the token, opens and locks
        // liquidity, sweeps the wallet, and assembles proof before replying.
        // It regularly takes longer than the short UI-request timeout.
        timeoutMs: 60_000,
        body: {
          walletPublicKey,
          config: config || {},
          fundingEstimate,
          airdropRecipients,
        },
      });
      if (!data?.run) {
        throw new V2ApiError('Demo launch response missing run.', { code: 'BAD_DEMO_LAUNCH' });
      }
      return data.run;
    }

    async function listManagedWallets() {
      const data = await request(V2_WALLETS_PATH);
      return safeArray(data.wallets);
    }

    async function getWalletQr(publicKey) {
      const query = new URLSearchParams({ publicKey: String(publicKey || '') });
      const data = await request(`${WALLET_QR_PATH}?${query.toString()}`);
      if (!data?.qrCode) {
        throw new V2ApiError('Wallet QR response missing qrCode.', { code: 'BAD_WALLET_QR' });
      }
      return data;
    }

    async function revealPendingWallet(publicKey) {
      const data = await request(`${PENDING_WALLETS_PATH}/reveal`, {
        method: 'POST',
        body: { publicKey },
      });
      if (!data?.wallet) {
        throw new V2ApiError('Pending wallet reveal response missing wallet.', { code: 'BAD_WALLET_REVEAL' });
      }
      return data.wallet;
    }

    async function dismissPendingWallet(publicKey) {
      return request(`${PENDING_WALLETS_PATH}/dismiss`, {
        method: 'POST',
        body: { publicKey },
      });
    }

    async function getSecretPinStatus() {
      const data = await request(`${SECRET_PIN_PATH}/status`);
      return data.status || {};
    }

    async function setupSecretPin(pin) {
      const data = await request(`${SECRET_PIN_PATH}/setup`, {
        method: 'POST',
        body: { pin },
      });
      return data.status || {};
    }

    async function unlockSecretPin(pin) {
      const data = await request(`${SECRET_PIN_PATH}/unlock`, {
        method: 'POST',
        body: { pin },
      });
      return data.status || {};
    }

    async function changeSecretPin({ currentPin, newPin } = {}) {
      const data = await request(`${SECRET_PIN_PATH}/change`, {
        method: 'POST',
        body: { currentPin, newPin },
      });
      return data.status || {};
    }

    async function lockSecretPin() {
      const data = await request(`${SECRET_PIN_PATH}/lock`, {
        method: 'POST',
        body: {},
      });
      return data.status || {};
    }

    async function resetSecretPin(confirmReset) {
      const data = await request(`${SECRET_PIN_PATH}/reset`, {
        method: 'POST',
        body: { confirmReset },
      });
      return {
        status: data.status || {},
        removed: data.removed || {},
      };
    }

    async function listVanityCandidates() {
      const data = await request(VANITY_CA_CANDIDATES_PATH);
      return safeArray(data.candidates);
    }

    async function listLaunchJournals({ includeCompleted = true, includeArchived = false } = {}) {
      const query = new URLSearchParams();
      if (includeCompleted) query.set('includeCompleted', '1');
      if (includeArchived) query.set('includeArchived', '1');
      const suffix = query.toString() ? `?${query.toString()}` : '';
      const data = await request(`${LAUNCH_JOURNALS_PATH}${suffix}`);
      return safeArray(data.journals);
    }

    async function resumeLaunchJournal(id) {
      return request(`${LAUNCH_JOURNALS_PATH}/resume`, {
        method: 'POST',
        body: { id },
      });
    }

    async function dismissLaunchJournal(id) {
      return request(`${LAUNCH_JOURNALS_PATH}/dismiss`, {
        method: 'POST',
        body: { id },
      });
    }

    async function removeVanityCandidate(publicKey) {
      return request(`${VANITY_CA_CANDIDATES_PATH}/remove`, {
        method: 'POST',
        body: { publicKey },
      });
    }

    async function cancelVanityGrind() {
      return request(CANCEL_VANITY_GRIND_PATH, { method: 'POST', body: {} });
    }

    async function estimateClassicFunding({
      allocations,
      targetMarketCapUsd,
      publishLaunchReport,
      token,
      preallocation,
      airdrop,
    }) {
      const data = await request(ESTIMATE_LP_FUNDING_PATH, {
        method: 'POST',
        body: {
          allocations,
          targetMarketCapUsd,
          publishLaunchReport,
          token,
          preallocation,
          airdrop,
        },
      });
      if (!data?.estimate) {
        throw new V2ApiError('Funding estimate response missing estimate.', { code: 'BAD_FUNDING_ESTIMATE' });
      }
      return data.estimate;
    }

    async function getQuoteTokenInfo(quoteToken) {
      const token = String(quoteToken || '').trim();
      if (!token) throw new V2ApiError('Quote token is required.', { code: 'BAD_QUOTE_TOKEN' });
      const data = await request(QUOTE_TOKEN_INFO_PATH, {
        method: 'POST',
        body: { quoteToken: token },
      });
      if (!data?.success || !data.info) {
        throw new V2ApiError(data?.error || 'Quote-token info response missing info.', { code: 'BAD_QUOTE_TOKEN_INFO' });
      }
      return data.info;
    }

    async function getClmmFeeTiers() {
      const data = await request(CLMM_FEE_TIERS_PATH);
      return safeArray(data.tiers);
    }

    async function acquireQuoteTokens({ walletPublicKey, autoSwapPlan } = {}) {
      const data = await request(ACQUIRE_QUOTE_TOKENS_PATH, {
        method: 'POST',
        body: { walletPublicKey, autoSwapPlan: safeArray(autoSwapPlan) },
      });
      if (!data?.jobId) {
        throw new V2ApiError('Acquire quote tokens response missing jobId.', { code: 'BAD_ACQUIRE_JOB' });
      }
      return data;
    }

    async function getAcquireQuoteTokens(jobId) {
      if (!jobId) throw new V2ApiError('Acquire job id is required.', { code: 'BAD_ACQUIRE_JOB' });
      return request(`${ACQUIRE_QUOTE_TOKENS_PATH}/${encodeURIComponent(jobId)}`);
    }

    async function cancelAcquireQuoteTokens(jobId) {
      if (!jobId) throw new V2ApiError('Acquire job id is required.', { code: 'BAD_ACQUIRE_JOB' });
      return request(`${ACQUIRE_QUOTE_TOKENS_PATH}/${encodeURIComponent(jobId)}`, { method: 'DELETE' });
    }

    async function checkDetailedBalance(publicKey) {
      const data = await request(CHECK_BALANCE_DETAILED_PATH, {
        method: 'POST',
        body: { publicKey },
      });
      if (!data?.balance) {
        throw new V2ApiError('Detailed balance response missing balance.', { code: 'BAD_BALANCE' });
      }
      return data.balance;
    }

    async function findFundingWallet(publicKey) {
      const data = await request(FIND_FUNDER_PATH, {
        method: 'POST',
        body: { publicKey },
      });
      return data.result || null;
    }

    async function generateManagedWallet() {
      const data = await request(`${V2_WALLETS_PATH}/generate`, { method: 'POST', body: {} });
      if (!data?.wallet) {
        throw new V2ApiError('Wallet response missing wallet.', { code: 'BAD_WALLET' });
      }
      return data.wallet;
    }

    async function importManagedWallet(secret) {
      const data = await request(`${V2_WALLETS_PATH}/import`, {
        method: 'POST',
        body: { secret },
      });
      if (!data?.wallet) {
        throw new V2ApiError('Wallet import response missing wallet.', { code: 'BAD_WALLET' });
      }
      return data.wallet;
    }

    async function armRunEnvelope({ walletPublicKey, config, fundingEstimate }) {
      const data = await request(V2_RUN_ARM_PATH, {
        method: 'POST',
        body: { walletPublicKey, config, fundingEstimate },
      });
      if (!data?.envelope) {
        throw new V2ApiError('Run envelope response missing envelope.', { code: 'BAD_RUN_ENVELOPE' });
      }
      return data.envelope;
    }

    async function executeNextRunOperation({
      walletPublicKey,
      config,
      fundingEstimate,
      airdropRecipients,
      confirmNextEndpoint,
      localDossier,
      runEnvelopeId,
    } = {}) {
      const data = await request(V2_RUN_EXECUTE_NEXT_PATH, {
        method: 'POST',
        body: {
          walletPublicKey,
          config,
          fundingEstimate,
          airdropRecipients,
          confirmNextEndpoint,
          localDossier,
          runEnvelopeId,
        },
      });
      if (!data?.executed) {
        throw new V2ApiError('Execute-next response missing execution result.', { code: 'BAD_EXECUTE_NEXT' });
      }
      return data;
    }

    async function diagnoseLaunch(tokenMint) {
      const query = new URLSearchParams({ tokenMint: String(tokenMint || '') });
      const data = await request(`${DIAGNOSE_LAUNCH_PATH}?${query.toString()}`);
      return data.report || data;
    }

    async function getLpProgress({ walletPublicKey, since = 0 } = {}) {
      const query = new URLSearchParams({
        wallet: String(walletPublicKey || ''),
        since: String(Number.isFinite(Number(since)) ? Number(since) : 0),
      });
      const data = await request(`${LP_PROGRESS_PATH}?${query.toString()}`);
      return data.state || null;
    }

    async function getAirdropProgress(walletPublicKey) {
      const query = new URLSearchParams({ wallet: String(walletPublicKey || '') });
      const data = await request(`${AIRDROP_PROGRESS_PATH}?${query.toString()}`);
      return data.state || null;
    }

    async function runAirdrop({ walletPublicKey, tokenMint, tokenDecimals, isToken2022 = false, recipients } = {}) {
      const data = await request(RUN_AIRDROP_PATH, {
        method: 'POST',
        body: {
          walletPublicKey,
          tokenMint,
          tokenDecimals,
          isToken2022,
          recipients: safeArray(recipients),
        },
      });
      return data.airdrop || data;
    }

    async function retryAirdrop({ walletPublicKey, tokenMint, tokenDecimals, isToken2022 = false, recipients } = {}) {
      const data = await request(RETRY_AIRDROP_PATH, {
        method: 'POST',
        body: {
          walletPublicKey,
          tokenMint,
          tokenDecimals,
          isToken2022,
          recipients: safeArray(recipients),
        },
      });
      return data.airdrop || data;
    }

    async function sweepPendingWallet({ walletPublicKey, destinationWallet } = {}) {
      return request(TRANSFER_ASSETS_PATH, {
        method: 'POST',
        body: { walletPublicKey, destinationWallet },
      });
    }

    async function cancelLaunchRefund({ walletPublicKey, destinationWallet } = {}) {
      return sweepPendingWallet({ walletPublicKey, destinationWallet });
    }

    async function selectRpc(url) {
      const data = await request('/api/rpc-config/select', {
        method: 'POST',
        body: { url },
      });
      return data.config || {};
    }

    async function addRpc({ name, url, setActive = true } = {}) {
      const data = await request('/api/rpc-config/add', {
        method: 'POST',
        body: { name, url, setActive },
      });
      return data.config || {};
    }

    async function removeRpc(url) {
      const data = await request('/api/rpc-config/remove', {
        method: 'POST',
        body: { url },
      });
      return data.config || {};
    }

    async function testRpc(url) {
      const data = await request('/api/rpc-config/test', {
        method: 'POST',
        body: { url },
      });
      return data.result || {};
    }

    async function publishLaunchReport({ walletPublicKey, mint, quoteMint, poolIds, reportHtml, launchData, proofFingerprint } = {}) {
      return request(PUBLISH_LAUNCH_REPORT_PATH, {
        method: 'POST',
        body: {
          walletPublicKey,
          mint,
          quoteMint: quoteMint || null,
          poolIds: safeArray(poolIds),
          reportHtml,
          launchData,
          proofFingerprint,
        },
      });
    }

    async function checkForUpdates() {
      return request(CHECK_FOR_UPDATES_PATH, { method: 'POST', body: {} });
    }

    async function setUserPrefs(prefs = {}) {
      const data = await request('/api/user-prefs', {
        method: 'POST',
        body: prefs,
      });
      return data.prefs || {};
    }

    async function getServerLogs({ since = 0, limit = 50 } = {}) {
      const query = new URLSearchParams({
        since: String(Number.isFinite(Number(since)) ? Number(since) : 0),
        limit: String(Number.isFinite(Number(limit)) ? Number(limit) : 50),
      });
      const data = await request(`${SERVER_LOGS_PATH}?${query.toString()}`);
      return safeArray(data.entries);
    }

    async function bootstrap() {
      const runtime = apiRuntimeStatus(fetchImpl, locationLike);
      if (!runtime.ok) {
        return deriveV2BootState({
          apiAvailable: false,
          status: 'static',
          error: runtime.reason,
        });
      }

      try {
        const sessionToken = await getSessionToken();
        const entries = await Promise.all(
          Object.entries(BOOT_ENDPOINTS).map(async ([key, path]) => [key, await safeGet(path)]),
        );
        return deriveV2BootState({
          apiAvailable: true,
          sessionToken,
          endpoints: Object.fromEntries(entries),
        });
      } catch (error) {
        const detail = error?.code === 'HTTP_ERROR' && [0, 404].includes(error.status)
          ? 'Static preview; local API is unavailable.'
          : errorMessage(error) || 'Local API is unavailable.';
        return deriveV2BootState({
          apiAvailable: false,
          status: 'static',
          error: detail,
        });
      }
    }

    return {
      bootstrap,
      acquireQuoteTokens,
      cancelLaunchRefund,
      cancelVanityGrind,
      cancelAcquireQuoteTokens,
      changeSecretPin,
      checkForUpdates,
      checkDetailedBalance,
      checkExecutionReadiness,
      diagnoseLaunch,
      dismissPendingWallet,
      dismissLaunchJournal,
      estimateClassicFunding,
      executeNextRunOperation,
      findFundingWallet,
      getClmmFeeTiers,
      getQuoteTokenInfo,
      getAirdropProgress,
      getAcquireQuoteTokens,
      getLpProgress,
      getServerLogs,
      getSessionToken,
      getSecretPinStatus,
      getWalletQr,
      request,
      safeGet,
      armRunEnvelope,
      generateManagedWallet,
      getPersonalDiscovery,
      importManagedWallet,
      addDiscoveryWallet,
      inspectDiscoveryToken,
      listLaunchJournals,
      listVanityCandidates,
      listManagedWallets,
      lockSecretPin,
      publishLaunchReport,
      revealPendingWallet,
      removeVanityCandidate,
      removeDiscoveryWallet,
      resetSecretPin,
      retryAirdrop,
      runAirdrop,
      runDemoLaunch,
      addRpc,
      removeRpc,
      selectRpc,
      setDiscoveryWalletEnabled,
      testRpc,
      setUserPrefs,
      resumeLaunchJournal,
      setupSecretPin,
      stageLaunchPlan,
      scanPersonalDiscovery,
      sweepPendingWallet,
      unlockSecretPin,
    };
  }

  global.TrebuchetV2Api = {
    BOOT_ENDPOINTS,
    CANCEL_VANITY_GRIND_PATH,
    ACQUIRE_QUOTE_TOKENS_PATH,
    CLMM_FEE_TIERS_PATH,
    QUOTE_TOKEN_INFO_PATH,
    CHECK_BALANCE_DETAILED_PATH,
    DIAGNOSE_LAUNCH_PATH,
    ESTIMATE_LP_FUNDING_PATH,
    FIND_FUNDER_PATH,
    LAUNCH_JOURNALS_PATH,
    LAUNCH_PLAN_PATH,
    AIRDROP_PROGRESS_PATH,
    RUN_AIRDROP_PATH,
    RETRY_AIRDROP_PATH,
    PUBLISH_LAUNCH_REPORT_PATH,
    TRANSFER_ASSETS_PATH,
    APP_VERSION_PATH,
    CHECK_FOR_UPDATES_PATH,
    VANITY_CA_CANDIDATES_PATH,
    LP_PROGRESS_PATH,
    SERVER_LOGS_PATH,
    SECRET_PIN_PATH,
    V2_DEMO_LAUNCH_RUN_PATH,
    V2_EXECUTION_READINESS_PATH,
    V2_DISCOVERY_INSPECT_PATH,
    V2_PERSONAL_DISCOVERY_PATH,
    V2_DISCOVERY_WALLETS_PATH,
    V2_DISCOVERY_SCAN_PATH,
    V2_RUN_ARM_PATH,
    V2_WALLETS_PATH,
    V2ApiError,
    createV2ApiClient,
    deriveV2BootState,
    shortAddress,
  };
})(globalThis);
