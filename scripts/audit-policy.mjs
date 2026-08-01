import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const ALLOWED_HIGH_ADVISORIES = new Set([
  // No patched bigint-buffer release exists. The affected path is constrained
  // to parsing Solana/Raydium account layouts; every other high finding blocks.
  'GHSA-3GC7-FJRX-P6MG',
]);

const BRACE_EXPANSION_REDOS_ADVISORY = 'GHSA-MH99-V99M-4GVG';

function versionParts(version) {
  const match = String(version || '').match(/^(\d+)\.(\d+)\.(\d+)(?:-|$)/);
  return match ? match.slice(1).map(Number) : null;
}

export function isPatchedBraceExpansionVersion(version) {
  if (version === '1.1.16' || version === '2.1.2') return true;
  const parts = versionParts(version);
  if (!parts || parts[0] < 5) return false;
  return parts[0] > 5 || parts[1] > 0 || parts[2] >= 8;
}

export function braceExpansionVersions(packageLock) {
  return Object.entries(packageLock?.packages || {})
    .filter(([packagePath]) => packagePath === 'node_modules/brace-expansion'
      || packagePath.endsWith('/node_modules/brace-expansion'))
    .map(([, record]) => String(record?.version || ''));
}

export function hasOnlyPatchedBraceExpansion(packageLock) {
  const versions = braceExpansionVersions(packageLock);
  return versions.length > 0 && versions.every(isPatchedBraceExpansionVersion);
}

function advisoryId(via) {
  const url = String(via?.url || '');
  return url.match(/GHSA-[A-Za-z0-9-]+/i)?.[0]?.toUpperCase() || null;
}

function highAdvisoriesFor(name, vulnerabilities, seen = new Set()) {
  if (seen.has(name)) return new Set();
  seen.add(name);
  const record = vulnerabilities[name];
  if (!record) return new Set();
  const found = new Set();
  for (const via of record.via || []) {
    if (typeof via === 'string') {
      for (const id of highAdvisoriesFor(via, vulnerabilities, seen)) found.add(id);
      continue;
    }
    if (!['high', 'critical'].includes(String(via?.severity || '').toLowerCase())) continue;
    const id = advisoryId(via);
    if (id) found.add(id);
  }
  return found;
}

export function evaluateAuditReport(report, allowed = ALLOWED_HIGH_ADVISORIES, { packageLock } = {}) {
  const vulnerabilities = report?.vulnerabilities || {};
  const blocked = [];
  const allowedFindings = [];
  const patchedBraceExpansion = hasOnlyPatchedBraceExpansion(packageLock);
  for (const [name, record] of Object.entries(vulnerabilities)) {
    const severity = String(record?.severity || '').toLowerCase();
    if (!['high', 'critical'].includes(severity)) continue;
    const advisoryIds = [...highAdvisoriesFor(name, vulnerabilities)];
    const isExplicitlyAllowed = severity === 'high'
      && advisoryIds.length > 0
      && advisoryIds.every((id) => allowed.has(id));
    const isPatchedMaintenanceRelease = severity === 'high'
      && patchedBraceExpansion
      && ['brace-expansion', 'minimatch'].includes(name)
      && advisoryIds.length > 0
      && advisoryIds.every((id) => id === BRACE_EXPANSION_REDOS_ADVISORY);
    const isAllowed = isExplicitlyAllowed || isPatchedMaintenanceRelease;
    (isAllowed ? allowedFindings : blocked).push({
      name,
      severity,
      advisoryIds,
      reason: isPatchedMaintenanceRelease ? 'patched-maintenance-release' : 'explicit-advisory',
    });
  }
  return { blocked, allowed: allowedFindings };
}

function run() {
  const audit = spawnSync('npm', ['audit', '--json'], { encoding: 'utf8' });
  let report;
  try {
    report = JSON.parse(audit.stdout || audit.stderr || '{}');
  } catch {
    console.error(audit.stderr || audit.stdout || 'npm audit returned invalid JSON');
    process.exit(1);
  }
  if (report?.error || !report?.metadata?.vulnerabilities) {
    console.error(report?.message || 'npm audit did not return a vulnerability report');
    process.exit(1);
  }
  let packageLock;
  try {
    packageLock = JSON.parse(readFileSync(resolve('package-lock.json'), 'utf8'));
  } catch (error) {
    console.error(`Could not verify installed dependency versions: ${error.message}`);
    process.exit(1);
  }
  const result = evaluateAuditReport(report, ALLOWED_HIGH_ADVISORIES, { packageLock });
  if (result.blocked.length) {
    for (const finding of result.blocked) {
      console.error(`BLOCKED ${finding.severity}: ${finding.name} (${finding.advisoryIds.join(', ') || 'unresolved advisory chain'})`);
    }
    process.exit(1);
  }
  const totals = report.metadata.vulnerabilities;
  console.log(`Audit policy passed: ${totals.critical} critical, ${totals.high} high, ${totals.moderate} moderate.`);
  const explicitlyAllowed = result.allowed.filter((finding) => finding.reason === 'explicit-advisory');
  if (explicitlyAllowed.length) {
    console.log(`Accepted upstream Solana parser advisory: ${[...ALLOWED_HIGH_ADVISORIES].join(', ')} (${explicitlyAllowed.length} dependency nodes).`);
  }
  const patchedVersions = [...new Set(braceExpansionVersions(packageLock))];
  if (result.allowed.some((finding) => finding.reason === 'patched-maintenance-release')) {
    console.log(`Verified patched brace-expansion releases: ${patchedVersions.join(', ')}.`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run();
}
