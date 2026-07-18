import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const ALLOWED_HIGH_ADVISORIES = new Set([
  // No patched bigint-buffer release exists. The affected path is constrained
  // to parsing Solana/Raydium account layouts; every other high finding blocks.
  'GHSA-3GC7-FJRX-P6MG',
]);

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

export function evaluateAuditReport(report, allowed = ALLOWED_HIGH_ADVISORIES) {
  const vulnerabilities = report?.vulnerabilities || {};
  const blocked = [];
  const allowedFindings = [];
  for (const [name, record] of Object.entries(vulnerabilities)) {
    const severity = String(record?.severity || '').toLowerCase();
    if (!['high', 'critical'].includes(severity)) continue;
    const advisoryIds = [...highAdvisoriesFor(name, vulnerabilities)];
    const isAllowed = severity === 'high'
      && advisoryIds.length > 0
      && advisoryIds.every((id) => allowed.has(id));
    (isAllowed ? allowedFindings : blocked).push({ name, severity, advisoryIds });
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
  const result = evaluateAuditReport(report);
  if (result.blocked.length) {
    for (const finding of result.blocked) {
      console.error(`BLOCKED ${finding.severity}: ${finding.name} (${finding.advisoryIds.join(', ') || 'unresolved advisory chain'})`);
    }
    process.exit(1);
  }
  const totals = report.metadata.vulnerabilities;
  console.log(`Audit policy passed: ${totals.critical} critical, ${totals.high} high, ${totals.moderate} moderate.`);
  if (result.allowed.length) {
    console.log(`Accepted upstream Solana parser advisory: ${[...ALLOWED_HIGH_ADVISORIES].join(', ')} (${result.allowed.length} dependency nodes).`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run();
}
