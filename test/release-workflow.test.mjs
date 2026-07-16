import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

import { nextRelease, releaseTypeFromLabels } from '../scripts/auto-version.mjs';
import {
  buildReleaseNotes,
  electronBuilderInvocation,
  resolveReleaseBuild,
  staleReleaseAssetNames,
} from '../scripts/release-lib.mjs';

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

test('release workflow is tag-driven and publishes checksums', () => {
  const workflow = read('.github/workflows/release.yml');
  const publishScript = read('scripts/publish-release.mjs');

  assert.match(workflow, /tags:\s*\n\s*-\s*'v\*'/);
  assert.match(workflow, /name:\s+Verify production release evidence and trust/);
  assert.match(workflow, /node scripts\/production-release-gate\.mjs "\$GITHUB_REF_NAME"/);
  assert.match(workflow, /build:\s*\n\s+name:[\s\S]*?needs:\s+production-gate/);
  assert.match(workflow, /node scripts\/release-build\.mjs/);
  assert.match(workflow, /node scripts\/publish-release\.mjs/);
  assert.match(workflow, /actions\/download-artifact@v5/);
  assert.match(workflow, /npm ci/);
  assert.match(publishScript, /SHA256SUMS\.txt/);
  assert.match(workflow, /name:\s+Publish Website/);
  assert.match(workflow, /FTP_LOGIN/);
  assert.match(workflow, /FTP_PASSWORD/);
  assert.match(workflow, /p1401\.use1\.mysecurecloudhost\.com/);
  assert.match(workflow, /mirror -R --only-newer --no-perms --verbose=2 website/);
});

test('ci runs package smoke builds and the packaged v2 runtime before release', () => {
  const workflow = read('.github/workflows/ci.yml');

  assert.match(workflow, /on:\s*\n\s+pull_request:\s*\n\s+workflow_dispatch:/);
  assert.doesNotMatch(workflow, /\n\s+push:/);
  assert.doesNotMatch(workflow, /needs:\s+test/);
  assert.doesNotMatch(workflow, /macos-15-intel/);
  assert.doesNotMatch(workflow, /Install Linux packaging dependencies/);
  assert.match(workflow, /Build package smoke/);
  assert.match(workflow, /Run packaged v2 Electron smoke/);
  assert.match(workflow, /xvfb-run -a npm run test:electron:v2:packaged/);
  assert.match(workflow, /Run v2 API-backed E2E test/);
  assert.match(workflow, /Run v2 desktop and mobile viewport smoke/);
  assert.doesNotMatch(workflow, /Build release package/);
  assert.doesNotMatch(workflow, /Upload build artifact/);
});

test('main merges automatically create patch, minor, or major release tags', () => {
  const workflow = read('.github/workflows/auto-release.yml');

  assert.match(workflow, /branches:\s*\n\s*-\s+main/);
  assert.match(workflow, /actions:\s+write/);
  assert.match(workflow, /pull-requests:\s+read/);
  assert.match(workflow, /node scripts\/auto-version\.mjs/);
  assert.match(workflow, /git tag -a "\$\{\{ steps\.next\.outputs\.tag \}\}"/);
  assert.match(workflow, /gh workflow run release\.yml --ref "\$\{\{ steps\.next\.outputs\.tag \}\}"/);

  assert.equal(releaseTypeFromLabels([]), 'patch');
  assert.equal(releaseTypeFromLabels(['minor']), 'minor');
  assert.equal(releaseTypeFromLabels(['minor', 'major']), 'major');
  assert.deepEqual(nextRelease('1.0.0', [], []), {
    releaseType: 'patch',
    version: '1.0.1',
    tag: 'v1.0.1',
  });
  assert.equal(nextRelease('1.2.3', ['v1.3.9'], ['minor']).version, '1.4.0');
  assert.equal(nextRelease('1.2.3', ['v1.3.9'], ['major']).version, '2.0.0');
});

test('release workflow publishes the GitHub package for each tag', () => {
  const workflow = read('.github/workflows/release.yml');
  const pkg = JSON.parse(read('package.json'));

  assert.equal(pkg.name, '@anoversizedmoosewithsocks/trebuchet-desktop');
  assert.equal(pkg.publishConfig.registry, 'https://npm.pkg.github.com');
  assert.equal(pkg.repository.url, 'git+https://github.com/AnOversizedMooseWithSocks/Trebuchet.git');
  assert.equal(pkg.build.productName, 'Trebuchet');
  assert.equal(pkg.build.executableName, 'Trebuchet');
  assert.equal(pkg.build.publish, null);
  assert.equal(pkg.build.nsis.artifactName, '${productName}-${version}-Setup.${ext}');
  assert.equal(pkg.build.linux.executableName, 'Trebuchet');
  assert.equal(pkg.build.linux.artifactName, 'Trebuchet-${version}-${arch}.${ext}');
  assert.equal(pkg.build.deb.packageName, 'trebuchet-desktop');
  assert.equal(pkg.build.deb.artifactName, 'trebuchet-desktop_${version}_${arch}.${ext}');
  assert.match(workflow, /packages:\s+write/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /npm version "\$\{GITHUB_REF_NAME#v\}" --no-git-tag-version/);
  assert.match(workflow, /name:\s+Publish GitHub Package/);
  assert.match(workflow, /registry-url:\s+https:\/\/npm\.pkg\.github\.com/);
  assert.match(workflow, /npm publish/);
});

test('release docs explain trust states and verification', () => {
  const docs = read('docs/releasing.md');

  assert.match(docs, /Merges to `main`/);
  assert.match(docs, /`minor` label/);
  assert.match(docs, /`major` label/);
  assert.match(docs, /signed and notarized/i);
  assert.match(docs, /unsigned test artifact/i);
  assert.match(docs, /GitHub Packages/);
  assert.match(docs, /WIN_CSC_LINK/);
  assert.match(docs, /APPLE_API_KEY/);
  assert.match(docs, /V2 production gate/);
  assert.match(docs, /release-evidence\/v2\/field-verification\.json/);
  assert.match(docs, /V2 releases cannot fall back to unsigned test artifacts/);
  assert.match(docs, /SHA256SUMS\.txt/);
});

test('mac build uses a native icns app icon', () => {
  const pkg = JSON.parse(read('package.json'));

  assert.equal(pkg.build.mac.icon, 'build/icon.icns');
  assert.equal(existsSync(new URL('../build/icon.icns', import.meta.url)), true);
});

test('windows release builds installer and portable executable', () => {
  const pkg = JSON.parse(read('package.json'));
  const plan = resolveReleaseBuild('windows', {});

  assert.deepEqual(pkg.build.win.target, ['nsis', 'portable']);
  // Windows artifactNames use hyphens, not spaces. electron-builder
  // silently rewrites spaces to dots in NSIS and portable artifact
  // names (a URL-safety measure for Windows targets), so a template
  // like "Trebuchet Setup ${version}.exe" actually produces
  // "Trebuchet.Setup.1.2.3.exe" — which we then can't match against
  // the website's download URLs. Hyphens pass through untouched.
  assert.equal(pkg.build.portable.artifactName, '${productName}-${version}-Portable.${ext}');
  assert.deepEqual(plan.builderArgs.slice(0, 3), ['--win', 'nsis', 'portable']);
  assert.equal(plan.builderArgs.some((arg) => arg.includes('signExecutable')), false);
  assert.equal(plan.builderArgs.some((arg) => arg.includes('signAndEditExecutable')), false);
  assert.equal(plan.expectedFiles.some((expected) => expected.matches('Trebuchet-1.2.3-Setup.exe')), true);
  assert.equal(plan.expectedFiles.some((expected) => expected.matches('Trebuchet-1.2.3-Portable.exe')), true);
});

test('release build planner enforces complete signing credentials', () => {
  assert.equal(resolveReleaseBuild('macos-arm64', {}).trust, 'unsigned test artifact');
  assert.equal(
    resolveReleaseBuild('macos-arm64', {
      CSC_LINK: 'base64-p12',
      CSC_KEY_PASSWORD: 'secret',
      APPLE_API_KEY: 'key',
      APPLE_API_KEY_ID: 'kid',
      APPLE_API_ISSUER: 'issuer',
    }).trust,
    'signed and notarized',
  );
  assert.throws(
    () => resolveReleaseBuild('macos-arm64', { CSC_LINK: 'base64-p12' }),
    /Incomplete macOS signing\/notarization configuration/,
  );

  assert.equal(resolveReleaseBuild('windows', {}).trust, 'unsigned test artifact');
  assert.equal(
    resolveReleaseBuild('windows', {
      WIN_CSC_LINK: 'base64-pfx',
      WIN_CSC_KEY_PASSWORD: 'secret',
    }).builderArgs.includes('-c.forceCodeSigning=true'),
    true,
  );
  assert.equal(
    resolveReleaseBuild('windows', {
      WIN_CSC_LINK: 'base64-pfx',
      WIN_CSC_KEY_PASSWORD: 'secret',
    }).trust,
    'signed',
  );
  assert.throws(
    () => resolveReleaseBuild('windows', { WIN_CSC_LINK: 'base64-pfx' }),
    /Incomplete Windows signing configuration/,
  );

  assert.equal(resolveReleaseBuild('linux', {}).trust, 'unsigned');
});

test('release builder invokes npm through a shell on Windows', () => {
  assert.deepEqual(electronBuilderInvocation(['--win'], 'linux'), {
    command: 'npm',
    args: ['exec', 'electron-builder', '--', '--win'],
    shell: false,
  });
  assert.deepEqual(electronBuilderInvocation(['--win'], 'win32'), {
    command: 'npm.cmd',
    args: ['exec', 'electron-builder', '--', '--win'],
    shell: true,
  });
});

test('release notes call out prerelease trust gaps and checksum verification', () => {
  const notes = buildReleaseNotes('v1.2.3', [
    {
      target: 'macos-arm64',
      label: 'macOS arm64',
      trust: 'unsigned test artifact',
      files: ['Trebuchet-1.2.3-arm64.dmg'],
    },
    {
      target: 'windows',
      label: 'Windows',
      trust: 'signed',
      files: ['Trebuchet Setup 1.2.3.exe', 'latest.yml'],
    },
  ]);

  assert.match(notes, /prerelease/i);
  assert.match(notes, /unsigned test artifact/i);
  assert.match(notes, /signed/);
  assert.match(notes, /SHA256SUMS\.txt/);
  assert.match(notes, /shasum -a 256 -c SHA256SUMS\.txt/);
});

test('publish reruns remove release assets that are no longer produced', () => {
  const staleAssets = staleReleaseAssetNames(
    [
      { name: 'Trebuchet Setup 1.2.3.exe' },
      { name: 'Trebuchet 1.2.3 Portable.exe' },
      { name: 'Trebuchet-1.2.3.zip' },
      { name: 'SHA256SUMS.txt' },
    ],
    [
      '/tmp/release-assets/windows/Trebuchet Setup 1.2.3.exe',
      '/tmp/release-assets/windows/Trebuchet 1.2.3 Portable.exe',
      '/tmp/release-assets/SHA256SUMS.txt',
    ],
  );

  assert.deepEqual(staleAssets, ['Trebuchet-1.2.3.zip']);
});

test('website download CTA uses per-OS direct links to tagged GitHub releases', () => {
  const site = read('website/index.html');

  // Per-OS download cards must exist for the three platforms we ship
  // binaries for. Each card has data-os set so the JS detection can
  // tag the matching one with .primary-os.
  assert.match(site, /data-os="windows"/);
  assert.match(site, /data-os="macos"/);
  assert.match(site, /data-os="linux"/);

  // Download URLs point at the tagged release (not /releases/latest)
  // for the version stamped at deploy time. The __TREBUCHET_VERSION__
  // placeholder is substituted by the "Stamp version into website"
  // step in release.yml right before the FTP push.
  assert.match(site, /\/releases\/download\/v__TREBUCHET_VERSION__\//);

  // Each of the six expected artifact filenames the website advertises
  // must be referenced in a href. If any are missing/renamed without
  // updating the CI verification step, this test catches it.
  assert.match(site, /Trebuchet-__TREBUCHET_VERSION__-arm64\.dmg/);
  assert.match(site, /Trebuchet-__TREBUCHET_VERSION__-x64\.dmg/);
  assert.match(site, /Trebuchet-__TREBUCHET_VERSION__-Setup\.exe/);
  assert.match(site, /Trebuchet-__TREBUCHET_VERSION__-Portable\.exe/);
  assert.match(site, /Trebuchet-__TREBUCHET_VERSION__-x86_64\.AppImage/);
  assert.match(site, /trebuchet-desktop___TREBUCHET_VERSION___amd64\.deb/);
  assert.match(site, /Unsigned build: macOS may say the app is damaged/);
  assert.match(site, /xattr -dr com\.apple\.quarantine \/Applications\/Trebuchet\.app/);

  // Negative checks — make sure we don't slip back into the old
  // "redirect to /releases/latest" or "raw committed dist files"
  // patterns. Either would break deep-linking and version pinning.
  assert.doesNotMatch(site, /\/raw\/main\/dist\//);
  assert.doesNotMatch(site, /\/releases\/latest(?!\.\w)/);
});

test('release workflow stamps version into website and verifies assets before FTP push', () => {
  const workflow = read('.github/workflows/release.yml');

  // The "Stamp version into website" step must run before the FTP push
  // so the deployed HTML has real versions instead of placeholders.
  assert.match(workflow, /Stamp version into website/);
  assert.match(workflow, /sed -i "s\/__TREBUCHET_VERSION__\//);

  // The "Verify release assets exist" step gates the FTP push on the
  // tagged release actually containing every download the website is
  // about to advertise. Without this gate, naming drift in
  // electron-builder output would ship a website full of 404s.
  assert.match(workflow, /Verify release assets exist/);
  assert.match(workflow, /gh release view/);

  // The expected[] array in that step must list every filename the
  // website hard-codes — both must stay in sync, so both are tested
  // against the same list. If you change one, change both AND this
  // test.
  const expected = [
    'Trebuchet-${version}-arm64.dmg',
    'Trebuchet-${version}-x64.dmg',
    'Trebuchet-${version}-Setup.exe',
    'Trebuchet-${version}-Portable.exe',
    'Trebuchet-${version}-x86_64.AppImage',
    'trebuchet-desktop_${version}_amd64.deb',
  ];
  for (const filename of expected) {
    // Each filename appears as a quoted entry in expected=( ... ).
    // We grep for it literally — the ${version} placeholder is part
    // of the shell var the workflow step expands, not a JS template.
    assert.ok(
      workflow.includes(`"${filename}"`),
      `release.yml expected[] is missing "${filename}"`,
    );
  }
});

test('update-check API URL matches the canonical repo case from package.json', () => {
  // GitHub's REST API is case-sensitive on the owner/repo path —
  // unlike the browser-facing github.com URLs, which follow a
  // case-insensitive redirect. A lowercase "trebuchet" in the API
  // URL returns 404 on every check while the web pages still load.
  // Symptom is silent: the user sees an "update check failed" modal
  // with no obvious clue that the bug is a single character.
  //
  // package.json's repository.url is the canonical source of truth
  // for the casing. This test extracts the owner/repo from there and
  // asserts that the api.github.com URL hard-coded in main.js uses
  // exactly the same case.
  const pkg = JSON.parse(read('package.json'));
  const main = read('main.js');

  // repository.url looks like "git+https://github.com/Owner/Repo.git"
  const repoMatch = /github\.com\/([^/]+)\/([^/.]+)/.exec(pkg.repository.url);
  assert.ok(repoMatch, 'Could not parse owner/repo from package.json repository.url');
  const [, owner, repo] = repoMatch;

  // The api URL in main.js should reference the same owner/repo with
  // identical case. Build the exact substring we expect and search for it.
  const expectedApiPath = `api.github.com/repos/${owner}/${repo}/`;
  assert.ok(
    main.includes(expectedApiPath),
    `main.js update-check URL must contain "${expectedApiPath}" exactly. ` +
      `A case mismatch silently 404s the update check.`,
  );

  // Must hit the /releases LIST endpoint, not /releases/latest.
  // /releases/latest excludes prereleases (publish-release.mjs marks
  // every unsigned release as prerelease), so it 404s while there are
  // perfectly good releases available. Hitting /releases and filtering
  // client-side keeps prereleases visible to the update check.
  assert.ok(
    main.includes(`${expectedApiPath}releases?`),
    `main.js update-check URL must hit /releases (the list endpoint), ` +
      `not /releases/latest — see the comment on UPDATE_API_URL in main.js`,
  );
  assert.ok(
    !main.includes(`${expectedApiPath}releases/latest`),
    `main.js must NOT use /releases/latest — that endpoint excludes ` +
      `prereleases and 404s while every release is unsigned`,
  );
  assert.match(main, /releaseTrustForArtifact/);
  assert.match(main, /releaseTrust: releaseTrustForArtifact\(release\.body \|\| '', asset\.name, process\.platform\)/);
});
