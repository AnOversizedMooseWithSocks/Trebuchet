import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)$/;
const MAJOR_LABELS = new Set(['major', 'semver:major', 'release:major', 'version:major']);
const MINOR_LABELS = new Set(['minor', 'semver:minor', 'release:minor', 'version:minor']);

export function releaseTypeFromLabels(labels = []) {
  const normalized = labels.map((label) => String(label).trim().toLowerCase());

  if (normalized.some((label) => MAJOR_LABELS.has(label))) {
    return 'major';
  }

  if (normalized.some((label) => MINOR_LABELS.has(label))) {
    return 'minor';
  }

  return 'patch';
}

export function parseVersion(version) {
  const match = VERSION_PATTERN.exec(String(version).trim());
  if (!match) {
    return null;
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

export function compareVersions(left, right) {
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch;
}

export function formatVersion(version) {
  return `${version.major}.${version.minor}.${version.patch}`;
}

export function highestVersion(values = []) {
  const versions = values.map(parseVersion).filter(Boolean);
  if (versions.length === 0) {
    throw new Error('No valid semver versions were found.');
  }

  return versions.sort(compareVersions).at(-1);
}

export function incrementVersion(version, releaseType) {
  if (releaseType === 'major') {
    return { major: version.major + 1, minor: 0, patch: 0 };
  }

  if (releaseType === 'minor') {
    return { major: version.major, minor: version.minor + 1, patch: 0 };
  }

  return { major: version.major, minor: version.minor, patch: version.patch + 1 };
}

export function nextRelease(packageVersion, tags = [], labels = [], { minimumMajor = 0 } = {}) {
  let releaseType = releaseTypeFromLabels(labels);
  const baseVersion = highestVersion([packageVersion, ...tags]);
  let nextVersion = incrementVersion(baseVersion, releaseType);
  if (Number(minimumMajor) > nextVersion.major) {
    nextVersion = { major: Number(minimumMajor), minor: 0, patch: 0 };
    releaseType = 'major';
  }
  const version = formatVersion(nextVersion);

  return {
    releaseType,
    version,
    tag: `v${version}`,
  };
}

function readPackageVersion() {
  return JSON.parse(readFileSync('package.json', 'utf8')).version;
}

function parseJsonEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }

  return JSON.parse(raw);
}

function writeOutput(release) {
  const lines = [
    `release_type=${release.releaseType}`,
    `version=${release.version}`,
    `tag=${release.tag}`,
  ];

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
    return;
  }

  console.log(lines.join('\n'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const release = nextRelease(
    readPackageVersion(),
    parseJsonEnv('RELEASE_TAGS_JSON', []),
    parseJsonEnv('PR_LABELS_JSON', []),
    { minimumMajor: Number(process.env.TREBUCHET_MIN_RELEASE_MAJOR || 0) },
  );

  writeOutput(release);
}
