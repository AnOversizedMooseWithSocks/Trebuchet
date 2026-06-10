import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

test('public frontend has no inline JavaScript event handlers', () => {
  const app = read('public/app.js');
  const html = read('public/index.html');
  const combined = `${app}\n${html}`;

  assert.equal(/\bon(?:click|load|error)=["']/i.test(combined), false);
  assert.equal(/javascript:/i.test(combined), false);
});

test('frontend assets are local and guarded by CSP', () => {
  const html = read('public/index.html');
  const middleware = read('serverMiddleware.js');

  assert.match(html, /Content-Security-Policy/);
  assert.match(middleware, /Content-Security-Policy/);
  assert.match(middleware, /frame-ancestors 'none'/);
  assert.match(middleware, /X-Frame-Options/);
  assert.match(html, /vendor\/bulma\/bulma\.min\.css/);
  assert.match(html, /vendor\/fontawesome\/css\/all\.min\.css/);
  assert.doesNotMatch(html, /cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com/);
});

test('release artifacts stay out of git and lockfile is trackable', () => {
  const ignore = read('.gitignore');

  assert.match(ignore, /^\/dist$/m);
  assert.doesNotMatch(ignore, /^package-lock\.json$/m);
});

test('dependency risk controls document audit residuals and PR checklist', () => {
  const security = read('SECURITY.md');
  const pkg = JSON.parse(read('package.json'));
  const template = read('.github/pull_request_template.md');

  assert.equal(pkg.overrides.tmp, '^0.2.6');
  assert.match(security, /SDK compatibility matrix/);
  assert.match(security, /npm audit --audit-level=high/);
  assert.match(security, /@metaplex-foundation\/umi-uploader-irys/);
  assert.match(template, /Dependency Risk/);
});

test('Electron only opens allowed external URL schemes', () => {
  const main = read('main.js');

  assert.match(main, /function openExternalSafe\(rawUrl\)/);
  assert.match(main, /url\.protocol !== 'https:'/);
  assert.doesNotMatch(main, /shell\.openExternal\(url\)/);
  assert.doesNotMatch(main, /shell\.openExternal\(URLS\./);
});

test('pending-wallet list API does not bulk-return secret material', () => {
  const server = read('server.js');
  const listStart = server.indexOf("app.get('/api/pending-wallets'");
  const revealStart = server.indexOf("app.post('/api/pending-wallets/reveal'");
  assert.ok(listStart >= 0, 'pending-wallet list route missing');
  assert.ok(revealStart > listStart, 'pending-wallet reveal route must follow list route');

  const listRoute = server.slice(listStart, revealStart);
  assert.match(listRoute, /hasSecretKey/);
  assert.match(listRoute, /hasMnemonic/);
  assert.doesNotMatch(listRoute, /secretKeyB58/);
  assert.doesNotMatch(listRoute, /out\.secretKey\s*=/);
  assert.doesNotMatch(listRoute, /out\.mnemonic\s*=/);
});

test('splash debug endpoint is opt-in only', () => {
  const server = read('server.js');
  const gatedRoute = "if (process.env.TREBUCHET_ENABLE_SPLASH_DEBUG === '1') {";
  const gateStart = server.indexOf(gatedRoute);
  const routeStart = server.indexOf("app.get('/api/_splash-debug'");

  assert.ok(gateStart >= 0, 'splash debug env gate missing');
  assert.ok(routeStart > gateStart, 'splash debug route must be inside the env-gated block');
});
