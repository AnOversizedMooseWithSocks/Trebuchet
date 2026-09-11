// updateCheck.js
//
// Pure helpers used by main.js for the "Check for Updates" feature.
// Lives here, separate from main.js, so it can be imported and tested
// directly without pulling in Electron — main.js imports 'electron'
// at the top, which means any test that imports main.js needs a full
// Electron runtime. Splitting the testable parts out matches the
// pattern used by rpcConfig.js, secretStore.js, etc.
//
// main.js wires these into the GitHub API call (httpsGetJson there)
// and the menu handler. Anything that touches the network, the
// BrowserWindow, app.getVersion(), or process.platform/arch stays
// in main.js — those would be harder to test cleanly and aren't
// where bugs are likely to hide.

/**
 * Compare two version strings like "1.0.9" and "1.1.0".
 *
 * Returns 1 if a is newer than b, -1 if older, 0 if equal. Missing
 * components are treated as zero, so "1.0" equals "1.0.0".
 *
 * We don't need full semver pre-release/build-metadata handling —
 * our release tags are always clean N.N.N. If that ever changes
 * (e.g. we start tagging "1.0.0-rc1"), revisit this — the
 * `parseInt(n, 10) || 0` line will swallow the "-rc1" suffix and
 * incorrectly treat the rc as equal to the GA.
 */
export function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const ai = pa[i] || 0;
    const bi = pb[i] || 0;
    if (ai > bi) return 1;
    if (ai < bi) return -1;
  }
  return 0;
}

/**
 * Pick the release asset that matches a given platform/arch combo.
 *
 * Takes the assets[] array from the GitHub releases API and returns
 * the matching asset object (with .name and .browser_download_url),
 * or undefined if no asset matches.
 *
 * The matching is by regex on the filename rather than constructing
 * an exact name — that way the check stays robust if the version
 * portion of the filename changes, or if electron-builder ever
 * tweaks its default naming for one of our targets.
 *
 * Per-platform/arch rules:
 *
 *   win32  →  Portable .exe (matches the website's Windows default —
 *             nothing to install, just double-click and run).
 *
 *   darwin →  arch matters! arm64 and x64 DMGs are different binaries.
 *             Picking the wrong one gives the user a file that won't
 *             run, with a confusing error. This is the one place we
 *             absolutely cannot fall back to a default.
 *
 *   linux  →  AppImage. Universal-across-distros, doesn't require
 *             root, doesn't touch the package manager. We also ship
 *             a .deb, but the AppImage is the safe default for an
 *             auto-recommendation.
 *
 *   anything else → undefined. The caller treats this as the
 *                   "no-asset" status and routes the user to the
 *                   GitHub release page to choose manually.
 *
 * Parameterising platform/arch (rather than reading process.platform
 * inline) keeps this testable from any host — Linux CI can verify
 * the macOS arm64 case without faking globals.
 */
export function pickAssetForPlatform(assets, platform, arch) {
  if (!Array.isArray(assets)) return undefined;

  if (platform === 'win32') {
    return assets.find((a) => /Portable\.exe$/i.test(a.name));
  }
  if (platform === 'darwin') {
    return arch === 'arm64'
      ? assets.find((a) => /arm64\.dmg$/i.test(a.name))
      : assets.find((a) => /x64\.dmg$/i.test(a.name));
  }
  if (platform === 'linux') {
    return assets.find((a) => /\.AppImage$/i.test(a.name));
  }
  return undefined;
}

/**
 * Normalise a GitHub release tag into a comparable version string.
 *
 * Tags look like "v1.0.9". Strip the leading "v" and return the
 * version part. If the input doesn't match our expected N.N.N
 * pattern (or N.N, or N), returns null — the caller treats null
 * as a "bad response, show an error" signal.
 *
 * Extracted as its own helper so the test suite can exhaustively
 * pin down the accept/reject boundary without going through the
 * full update-check flow.
 */
export function parseReleaseTag(tag) {
  const stripped = String(tag || '').replace(/^v/, '');
  if (!/^\d+(\.\d+)*$/.test(stripped)) return null;
  return stripped;
}

/**
 * Pick the newest installable release from a /releases response.
 *
 * Takes the array returned by GitHub's /repos/:owner/:repo/releases
 * endpoint and returns the first release that isn't a draft, or null
 * if none qualifies. Prereleases ARE included.
 *
 * Why we don't use /releases/latest:
 *   GitHub's /releases/latest endpoint is documented as "the most
 *   recent non-prerelease, non-draft release". Trebuchet's publish
 *   script (scripts/publish-release.mjs) marks releases as
 *   --prerelease whenever any artifact has trust = 'unsigned test
 *   artifact', which is true for every release until code-signing
 *   certs are set up (Apple Developer ID, Windows EV). So
 *   /releases/latest returns 404 — there's no non-prerelease release
 *   to return — and the update check silently fails.
 *
 *   Fetching /releases instead returns the full list (sorted newest-
 *   first by default), and we apply our own filter that treats
 *   prereleases as legitimate updates. Users who installed the
 *   "prerelease" build are by definition fine with prerelease builds.
 *
 * Drafts are skipped defensively. In practice GitHub hides drafts
 * from unauthenticated requests, so the input array shouldn't
 * contain any — but we filter just in case authentication is ever
 * added.
 */
export function pickLatestRelease(releases) {
  if (!Array.isArray(releases)) return null;
  for (const release of releases) {
    if (release && release.draft !== true) return release;
  }
  return null;
}

function releaseArtifactBaseName(value) {
  return String(value || '').split(/[\\/]/).pop();
}

function releaseTrustRecord(trust, platform = null) {
  const normalized = String(trust || '').trim().toLowerCase();
  const platformName = platform || null;
  if (normalized === 'signed and notarized') {
    return {
      status: 'signed-and-notarized',
      label: 'Signed and notarized',
      signingStatus: 'signed',
      notarizationStatus: 'notarized',
      platform: platformName,
      detail: 'Release notes mark this artifact as signed and notarized.',
    };
  }
  if (normalized === 'signed') {
    return {
      status: 'signed',
      label: 'Signed',
      signingStatus: 'signed',
      notarizationStatus: platform === 'darwin' ? 'not-reported' : 'not-applicable',
      platform: platformName,
      detail: platform === 'darwin'
        ? 'Release notes mark this artifact as signed, but notarization is not reported.'
        : 'Release notes mark this artifact as signed.',
    };
  }
  if (normalized === 'unsigned test artifact') {
    return {
      status: 'unsigned-test-artifact',
      label: 'Unsigned test artifact',
      signingStatus: 'unsigned',
      notarizationStatus: platform === 'darwin' ? 'not-notarized' : 'not-applicable',
      platform: platformName,
      detail: platform === 'darwin'
        ? 'Release notes mark this macOS artifact as unsigned and not notarized.'
        : 'Release notes mark this artifact as an unsigned test artifact.',
    };
  }
  if (normalized === 'unsigned') {
    return {
      status: 'unsigned',
      label: 'Unsigned',
      signingStatus: 'unsigned',
      notarizationStatus: platform === 'darwin' ? 'not-notarized' : 'not-applicable',
      platform: platformName,
      detail: platform === 'darwin'
        ? 'Release notes mark this macOS artifact as unsigned and not notarized.'
        : 'Release notes mark this artifact as unsigned.',
    };
  }
  return {
    status: 'unknown',
    label: 'Signing unknown',
    signingStatus: 'unknown',
    notarizationStatus: 'unknown',
    platform: platformName,
    detail: 'Release notes do not disclose signing/notarization status for this artifact; verify before installing.',
  };
}

/**
 * Extract the selected artifact's trust status from Trebuchet release notes.
 *
 * scripts/release-lib.mjs emits a "Trust status" section with rows like:
 *   - macOS arm64: unsigned test artifact (Trebuchet-1.2.3-arm64.dmg)
 *
 * The updater already chooses an OS/arch-specific asset. This helper binds
 * the visible update prompt to that exact asset instead of showing a generic
 * release-level claim.
 */
export function releaseTrustForArtifact(releaseNotes, assetName, platform = null) {
  const wanted = releaseArtifactBaseName(assetName);
  if (!wanted) return releaseTrustRecord(null, platform);
  const lines = String(releaseNotes || '').split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^\s*-\s*([^:]+):\s*([^()]+?)\s*\(([^)]*)\)\s*$/);
    if (!match) continue;
    const files = match[3].split(',').map((file) => releaseArtifactBaseName(file.trim()));
    if (!files.includes(wanted)) continue;
    return releaseTrustRecord(match[2], platform);
  }
  return releaseTrustRecord(null, platform);
}
