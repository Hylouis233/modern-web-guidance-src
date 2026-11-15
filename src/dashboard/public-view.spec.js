import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ARTIFACTS_FILE, buildSuite, writeManifest } from '../harness/public/builder.ts';
import { LocalSuiteStore } from '../harness/public/suite-store.ts';
import { FIXTURE_MODEL, FIXTURE_SUITE, makeFixtureStore, SECURITY_RUN } from '../harness/public/fixtures/make-store.ts';

/**
 * The public, unauthenticated view must render entirely from `public-evals/`
 * and never contact the private bucket. These tests build a real public copy
 * with the harness builder, serve it to the page, and fail on any request to a
 * Google storage or console host, including from popups.
 */

const SUITE = FIXTURE_SUITE;
const GOOGLE_HOSTS = /https:\/\/[^/]*(googleapis\.com|cloud\.google\.com|accounts\.google\.com)\//;
/**
 * This fork does not load Google Identity Services. Every request to a Google host is a failure.
 */

/** @type {string} */
let publicDir;
/** @type {string} */
let rawEvalsJson;

test.beforeAll(async () => {
  const { root, baseApps } = makeFixtureStore();
  rawEvalsJson = fs.readFileSync(path.join(root, SUITE, 'evals.json'), 'utf8');

  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'public-view-out-'));
  const result = await buildSuite(SUITE, {
    store: new LocalSuiteStore(root),
    outDir,
    baseAppsDir: baseApps,
    allowlist: { include: ['nightly-*'], exclude: [], overrides: [], releasedModels: [FIXTURE_MODEL] },
  });
  if (result.status !== 'built') throw new Error(`fixture build failed: ${result.reason}`);
  writeManifest(outDir, [result]);
  publicDir = path.join(outDir, 'public-evals');
});

/** The token the stubbed Google Identity Services client hands out when Sign in is clicked. */
const FRESH_TOKEN = 'fresh-token';

/**
 * Replaces the Google Identity Services client so the Sign in / Sign out button renders
 * without loading the real script (which `GOOGLE_HOSTS` blocks). Clicking Sign in
 * completes immediately with `FRESH_TOKEN` instead of opening a popup.
 * @param {import('@playwright/test').Page} page
 */
async function stubGoogleSignIn(page) {
  await page.context().addInitScript(token => {
    /** @type {any} */ (window).google = {
      accounts: {
        oauth2: {
          initTokenClient: (/** @type {{ callback: (response: { access_token: string }) => void }} */ config) => ({
            requestAccessToken() { config.callback({ access_token: token }); },
          }),
        },
      },
    };
  }, FRESH_TOKEN);
}

/**
 * Serves `public-evals/**` from the built fixture, blocks every Google host at the
 * context level (so popups are covered too), and records what tried to get through.
 * @param {import('@playwright/test').Page} page
 * @param {{ token?: string, manageToken?: boolean }} [options] `manageToken: false` leaves
 *   localStorage alone so a test can set and clear the token itself.
 * @returns {Promise<{ googleRequests: string[], popupOrigins: string[] }>}
 */
async function servePublicCopy(page, options = {}) {
  /** @type {string[]} */
  const googleRequests = [];
  /** @type {string[]} */
  const popupOrigins = [];
  if (options.manageToken !== false) {
    await page.context().addInitScript(t => {
      if (t) localStorage.setItem('gcs_access_token', t);
      else localStorage.removeItem('gcs_access_token');
    }, options.token ?? '');
  }
  await stubGoogleSignIn(page);
  await page.context().route(GOOGLE_HOSTS, route => {
    googleRequests.push(route.request().url());
    return route.abort();
  });
  await page.context().route('**/public-evals/**', route => {
    const url = new URL(route.request().url());
    const rel = url.pathname.replace(/^.*\/public-evals\//, '');
    const file = path.join(publicDir, rel);
    if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: 'not found' });
    return route.fulfill({ path: file, contentType: rel.endsWith('.json') ? 'application/json' : 'text/plain' });
  });
  page.context().on('page', popup => popupOrigins.push(new URL(popup.url()).origin));
  return { googleRequests, popupOrigins };
}

/**
 * Serves the dev server's pages under a fake non-localhost origin so `resolveDataSource()`
 * behaves as it does on GitHub Pages instead of picking 'local'.
 * @param {import('@playwright/test').Page} page
 * @param {string} [basePath=''] Project-site prefix such as `/repo`, as on `user.github.io/repo/`.
 * @returns {Promise<string>} the fake origin
 */
async function serveAsGitHubPages(page, basePath = '') {
  const origin = 'https://example.github.io';
  const devServer = test.info().project.use.baseURL ?? 'http://localhost:11432';
  await page.context().route(`${origin}${basePath}/**`, async route => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith(`${basePath}/public-evals/`)) return route.fallback(); // served from the built fixture
    const response = await route.fetch({ url: devServer + url.pathname.slice(basePath.length) + url.search });
    return route.fulfill({ response });
  });
  return origin;
}

/**
 * Routes the private bucket to the raw fixture so signed-in mode can be exercised offline.
 * Registered after `servePublicCopy`, so it takes precedence over the `GOOGLE_HOSTS` block
 * for the bucket only; every other Google host stays blocked.
 * @param {import('@playwright/test').Page} page
 * @param {{ status?: number }} [options] Reject every bucket request with this status instead.
 * @returns {Promise<string[]>} Authorization header of every bucket request
 */
async function mockPrivateBucket(page, options = {}) {
  /** @type {string[]} */
  const authHeaders = [];
  await page.context().route(/storage\.googleapis\.com/, route => {
    if (options.status) {
      authHeaders.push(route.request().headers()['authorization'] ?? '');
      return route.fulfill({ status: options.status, body: 'unauthorized' });
    }
    const url = new URL(route.request().url());
    authHeaders.push(route.request().headers()['authorization'] ?? '');
    const object = decodeURIComponent(url.pathname.replace(/^.*\/o\//, ''));
    if (object === 'suites.gen.json') {
      const manifest = JSON.parse(fs.readFileSync(path.join(publicDir, 'suites.gen.json'), 'utf8'));
      return route.fulfill({ json: manifest });
    }
    if (object === `${SUITE}/evals.json`) {
      return route.fulfill({ body: rawEvalsJson, contentType: 'application/json' });
    }
    if (url.pathname.endsWith('/o') || url.pathname.endsWith('/o/')) {
      return route.fulfill({ json: { items: [] } });
    }
    return route.fulfill({ status: 404, body: 'not found' });
  });
  return authHeaders;
}

/**
 * Records, in order, each request for a suite's `artifacts.json` or for a run's own patch or log file.
 * @param {import('@playwright/test').Page} page
 * @returns {string[]} Paths relative to `public-evals/`; filled in as requests are made.
 */
function recordArtifactRequests(page) {
  /** @type {string[]} */
  const requested = [];
  page.on('request', request => {
    const rel = new URL(request.url()).pathname.split('/public-evals/')[1];
    if (rel && /\/(artifacts\.json|agent\.patch|modern-web\.log)$/.test(rel)) requested.push(rel);
  });
  return requested;
}

test.describe('Public view', () => {
  test('landing lists published suites without touching Google hosts', async ({ page }) => {
    const { googleRequests } = await servePublicCopy(page);
    await page.goto('/?source=public');

    const row = page.locator('.suite-table-row', { hasText: 'codex' }).first();
    await expect(row).toBeVisible();
    await expect(row.locator('.source-cell')).toHaveText('public');
    await expect(row.locator('a.suite-link')).toHaveAttribute('href', /source=public/);
    await expect(page.locator('.suite-table-row', { hasText: 'example-result' })).toHaveCount(0);
    await expect(page.locator('#auth-btn')).toBeHidden();
    await expect(page.locator('#scheduled-only-label')).toBeHidden();
    await expect(page.locator('#scheduled-only-check')).toBeHidden();
    expect(googleRequests).toEqual([]);
  });

  test('Scheduled only toggle is hidden on public dashboard but visible on internal', async ({ page }) => {
    await servePublicCopy(page);
    await page.goto('/?source=public');
    await expect(page.locator('#scheduled-only-label')).toBeHidden();
    await expect(page.locator('#scheduled-only-check')).toBeHidden();

    // On local/internal server it is visible
    await page.goto('/');
    await expect(page.locator('#scheduled-only-label')).toBeVisible();
    await expect(page.locator('#scheduled-only-check')).toBeVisible();
  });

  test('Sign in stays hidden, including when ?show_login=true', async ({ page }) => {
    const { googleRequests } = await servePublicCopy(page);

    for (const url of [
      '/?source=public',
      '/?source=public&show_login=false',
      '/?source=public&show_login=true',
      `/dashboard.html?testId=${SUITE}&source=public&show_login=true`,
      '/guide.html?guide=security&source=public&show_login=true',
    ]) {
      await page.goto(url);
      await expect(page.locator('#auth-btn')).toBeHidden();
      await expect(page.locator('#hero-auth-btn')).toBeHidden();
    }
    expect(googleRequests).toEqual([]);
  });

  test('suite page renders, and Diff and Log open from public-evals only', async ({ page }) => {
    const { googleRequests, popupOrigins } = await servePublicCopy(page);
    await page.goto(`/dashboard.html?testId=${SUITE}&source=public`);

    await expect(page.locator('#test-header')).toContainText(SUITE);
    await expect(page.locator('#test-header')).not.toContainText('Serving Mode');
    const security = page.locator('.task-accordion[data-guide="security"]').first();
    await security.locator('.task-toggle').click();
    await expect(security.locator('.tfoot-action-btn').first()).toBeVisible();

    await security.locator('.tfoot-action-btn', { hasText: 'Diff' }).first().click();
    await expect(page.locator('#modal')).toBeVisible();
    await expect(page.locator('#modal')).toContainText('a/src/app.ts');
    await page.keyboard.press('Escape');

    await security.locator('.tfoot-action-btn', { hasText: 'Log' }).first().click();
    await expect(page.locator('#modal')).toContainText('GET /guides/security');
    await page.keyboard.press('Escape');

    // Only the artifacts the builder publishes get a button; nothing that would 404 or need the bucket.
    const buttonLabels = await security.locator('.tfoot-action-btn').allInnerTexts();
    const labelSet = new Set(buttonLabels.map(label => label.trim()));
    expect(labelSet).toEqual(new Set(['Diff', 'Log']));
    await expect(page.locator('#view-gcs-artifacts-btn')).toBeHidden();
    await expect(page.locator('#view-log-btn')).toBeHidden();

    expect(googleRequests).toEqual([]);
    expect(popupOrigins).toEqual([]);
  });

  test('suite page shows the recorded task prompt without fetching task files', async ({ page }) => {
    const { googleRequests } = await servePublicCopy(page);
    /** @type {string[]} */
    const promptSourceRequests = [];
    page.on('request', request => {
      if (/\/tasks\/|run\.mjs/.test(request.url())) promptSourceRequests.push(request.url());
    });
    await page.goto(`/dashboard.html?testId=${SUITE}&source=public`);

    const security = page.locator('.task-accordion[data-guide="security"]').first();
    await security.locator('.task-toggle').click();
    await expect(security.locator('.task-prompt-text')).toContainText('Audit the Daily Grind web app');
    await expect(security.locator('.task-prompt-meta-value')).toHaveText('daily-grind');
    expect(promptSourceRequests).toEqual([]);
    expect(googleRequests).toEqual([]);
  });

  test('public evals.json uses the same 10-minute cache bucket as the manifest', async ({ page }) => {
    await servePublicCopy(page);
    /** @type {string[]} */
    const busters = [];
    page.on('request', request => {
      const url = new URL(request.url());
      if (/\/public-evals\/.*\.json$/.test(url.pathname)) busters.push(url.searchParams.get('t') ?? '');
    });
    await page.goto(`/dashboard.html?testId=${SUITE}&source=public`);
    await expect(page.locator('#test-header')).toContainText(SUITE);

    expect(busters.length).toBeGreaterThan(0);
    for (const t of busters) {
      expect(Math.abs(Number(t) - Math.floor(Date.now() / 600_000))).toBeLessThanOrEqual(1);
    }
  });

  test('a 404 from public-evals shows an error that names no bucket', async ({ page }) => {
    const { googleRequests } = await servePublicCopy(page);
    await page.goto('/dashboard.html?testId=nightly-does-not-exist&source=public');

    const body = page.locator('body');
    await expect(body).toContainText('Error loading dashboard data');
    await expect(body).not.toContainText('guidance-evals');
    expect(googleRequests).toEqual([]);
  });

  test('?source=public wins over a stale token', async ({ page }) => {
    const { googleRequests } = await servePublicCopy(page, { token: 'stale-token' });
    await page.goto('/?source=public');

    await expect(page.locator('.suite-table-row', { hasText: 'codex' }).first()).toBeVisible();
    expect(googleRequests).toEqual([]);
  });

  test('?source=remote without a token reads the public copy, not the bucket', async ({ page }) => {
    const { googleRequests } = await servePublicCopy(page);
    await page.goto('/?source=remote');

    const row = page.locator('.suite-table-row', { hasText: 'codex' }).first();
    await expect(row).toBeVisible();
    await expect(row.locator('.source-cell')).toHaveText('public');
    expect(googleRequests).toEqual([]);
  });

  test('with no token off the dev server, the public copy loads without ?source=', async ({ page }) => {
    const { googleRequests } = await servePublicCopy(page);
    const origin = await serveAsGitHubPages(page);

    await page.goto(`${origin}/`);
    await expect(page.locator('.suite-table-row', { hasText: 'codex' }).first()).toBeVisible();
    await expect(page.locator('#hero-auth-btn')).toBeHidden();
    expect(googleRequests).toEqual([]);
  });

  test('guide page renders the public manifest without touching Google hosts', async ({ page }) => {
    const { googleRequests } = await servePublicCopy(page);
    await page.goto('/guide.html?guide=security&source=public');

    await expect(page.locator('#guide-name-header')).toHaveText('security');
    await expect(page.locator('.timeline-point').first()).toBeVisible();
    expect(googleRequests).toEqual([]);
  });

  test('guide Prev / Next navigation keeps ?source=public', async ({ page }) => {
    const { googleRequests } = await servePublicCopy(page);
    await page.goto('/guide.html?guide=security&source=public');
    await expect(page.locator('#guide-name-header')).toHaveText('security');

    await page.locator('#next-guide-btn').click();
    await page.waitForURL(url => url.pathname.endsWith('/guide.html') && url.searchParams.get('guide') !== 'security');
    expect(new URL(page.url()).searchParams.get('source')).toBe('public');
    await expect(page.locator('.timeline-point').first()).toBeVisible();
    expect(googleRequests).toEqual([]);
  });

  test('a capped agent.patch placeholder is shown as text, not as an empty diff', async ({ page }) => {
    await servePublicCopy(page);
    const placeholder = '# diff omitted: 1.5 MB exceeds the 1 MB cap\n';
    const artifacts = JSON.parse(fs.readFileSync(path.join(publicDir, SUITE, ARTIFACTS_FILE), 'utf8'));
    for (const relPath of Object.keys(artifacts)) {
      if (relPath.endsWith('/agent.patch')) artifacts[relPath] = placeholder;
    }
    // Registered after servePublicCopy so it wins for this one file.
    await page.context().route('**/public-evals/**/artifacts.json', route => route.fulfill({ json: artifacts }));
    await page.goto(`/dashboard.html?testId=${SUITE}&source=public`);

    const security = page.locator('.task-accordion[data-guide="security"]').first();
    await security.locator('.task-toggle').click();
    await security.locator('.tfoot-action-btn', { hasText: 'Diff' }).first().click();
    await expect(page.locator('#modal')).toContainText('# diff omitted: 1.5 MB exceeds the 1 MB cap');
    await expect(page.locator('#modal .diff-file-details')).toHaveCount(0);
    await expect(page.locator('#modal')).not.toContainText('diff --git');
  });

  test('the builder\'s artifacts.json serves both Diff and Log with one request', async ({ page }) => {
    await servePublicCopy(page);
    const requested = recordArtifactRequests(page);
    await page.goto(`/dashboard.html?testId=${SUITE}&source=public`);

    const security = page.locator('.task-accordion[data-guide="security"]').first();
    await security.locator('.task-toggle').click();
    await security.locator('.tfoot-action-btn', { hasText: 'Diff' }).first().click();
    await expect(page.locator('#modal')).toContainText('a/src/app.ts');
    await page.keyboard.press('Escape');
    await security.locator('.tfoot-action-btn', { hasText: 'Log' }).first().click();
    await expect(page.locator('#modal')).toContainText('GET /guides/security');

    expect(requested).toEqual([`${SUITE}/artifacts.json`]);
  });

  test('Diff and Log read from the suite\'s artifacts.json when it has one', async ({ page }) => {
    await servePublicCopy(page);
    const patch = 'diff --git a/from/artifacts.ts b/from/artifacts.ts\n--- a/from/artifacts.ts\n+++ b/from/artifacts.ts\n@@ -0,0 +1 @@\n+ok\n';
    /** @type {(value?: unknown) => void} */
    let release = () => {};
    const held = new Promise(resolve => { release = resolve; });
    // Registered after servePublicCopy so it wins: a file that has this run's patch but not its log, held back until released.
    await page.context().route('**/public-evals/**/artifacts.json', async route => {
      await held;
      return route.fulfill({ json: { [`${SECURITY_RUN}/agent.patch`]: patch } });
    });
    const requested = recordArtifactRequests(page);
    await page.goto(`/dashboard.html?testId=${SUITE}&source=public`);

    const security = page.locator('.task-accordion[data-guide="security"]').first();
    await security.locator('.task-toggle').click();
    await security.locator('.tfoot-action-btn', { hasText: 'Diff' }).first().click();
    await expect(page.locator('#modal')).toContainText('Loading content...');
    release();
    await expect(page.locator('#modal')).toContainText('a/from/artifacts.ts');
    await page.keyboard.press('Escape');

    // The log is missing from a file that exists: an error, without asking for a separate log file that cannot be there.
    await security.locator('.tfoot-action-btn', { hasText: 'Log' }).first().click();
    await expect(page.locator('#modal')).toContainText('File not found');
    expect(requested).toEqual([`${SUITE}/artifacts.json`]);
  });

  test('a suite with no artifacts.json opens its per-run files, then uses the file once it is published', async ({ page }) => {
    await servePublicCopy(page);
    let published = false;
    // Registered after servePublicCopy so these win: no artifacts.json at first, and the patch as its own file.
    await page.context().route('**/public-evals/**/artifacts.json', route => published
      ? route.fulfill({ json: { [`${SECURITY_RUN}/modern-web.log`]: 'log from artifacts.json\n' } })
      : route.fulfill({ status: 404, body: 'not found' }));
    const perRunPatch = 'diff --git a/per/run.ts b/per/run.ts\n--- a/per/run.ts\n+++ b/per/run.ts\n@@ -0,0 +1 @@\n+ok\n';
    await page.context().route('**/public-evals/**/agent.patch', route => route.fulfill({ body: perRunPatch, contentType: 'text/plain' }));
    const requested = recordArtifactRequests(page);
    await page.goto(`/dashboard.html?testId=${SUITE}&source=public`);

    const security = page.locator('.task-accordion[data-guide="security"]').first();
    await security.locator('.task-toggle').click();
    await security.locator('.tfoot-action-btn', { hasText: 'Diff' }).first().click();
    await expect(page.locator('#modal')).toContainText('a/per/run.ts');
    expect(requested).toEqual([`${SUITE}/artifacts.json`, `${SUITE}/${SECURITY_RUN}/agent.patch`]);
    await page.keyboard.press('Escape');

    published = true;
    await security.locator('.tfoot-action-btn', { hasText: 'Log' }).first().click();
    await expect(page.locator('#modal')).toContainText('log from artifacts.json');
  });

  test('a failed artifacts.json load is tried again on the next click', async ({ page }) => {
    await servePublicCopy(page);
    let failedOnce = false;
    // Registered after servePublicCopy so it wins: a server error the first time, the file after that.
    await page.context().route('**/public-evals/**/artifacts.json', route => {
      if (failedOnce) return route.fulfill({ json: { [`${SECURITY_RUN}/modern-web.log`]: 'log from artifacts.json\n' } });
      failedOnce = true;
      return route.fulfill({ status: 500, body: 'server error' });
    });
    const requested = recordArtifactRequests(page);
    await page.goto(`/dashboard.html?testId=${SUITE}&source=public`);

    const security = page.locator('.task-accordion[data-guide="security"]').first();
    await security.locator('.task-toggle').click();
    await security.locator('.tfoot-action-btn', { hasText: 'Log' }).first().click();
    await expect(page.locator('#modal')).toContainText('Error loading file');
    await page.keyboard.press('Escape');

    await security.locator('.tfoot-action-btn', { hasText: 'Log' }).first().click();
    await expect(page.locator('#modal')).toContainText('log from artifacts.json');
    expect(requested).toEqual([`${SUITE}/artifacts.json`, `${SUITE}/artifacts.json`]);
  });

  test('a Log opened while a Diff is still loading shows the log, not the diff', async ({ page }) => {
    await servePublicCopy(page);
    const patch = 'diff --git a/from/artifacts.ts b/from/artifacts.ts\n--- a/from/artifacts.ts\n+++ b/from/artifacts.ts\n@@ -0,0 +1 @@\n+ok\n';
    /** @type {(value?: unknown) => void} */
    let release = () => {};
    const held = new Promise(resolve => { release = resolve; });
    // Registered after servePublicCopy so it wins: both artifacts in one file, held back until released.
    await page.context().route('**/public-evals/**/artifacts.json', async route => {
      await held;
      return route.fulfill({ json: { [`${SECURITY_RUN}/agent.patch`]: patch, [`${SECURITY_RUN}/modern-web.log`]: 'log from artifacts.json\n' } });
    });
    await page.goto(`/dashboard.html?testId=${SUITE}&source=public`);

    const security = page.locator('.task-accordion[data-guide="security"]').first();
    await security.locator('.task-toggle').click();
    await security.locator('.tfoot-action-btn', { hasText: 'Diff' }).first().click();
    await expect(page.locator('#modal')).toContainText('Loading content...');
    await page.keyboard.press('Escape');
    await security.locator('.tfoot-action-btn', { hasText: 'Log' }).first().click();
    release();

    await expect(page.locator('#modal')).toContainText('log from artifacts.json');
    await expect(page.locator('#modal')).not.toContainText('a/from/artifacts.ts');
  });

  test('a missing public manifest is not an error', async ({ page }) => {
    const { googleRequests } = await servePublicCopy(page);
    // Registered after servePublicCopy so it takes precedence over the fixture for every public-evals file.
    await page.context().route('**/public-evals/**', route => route.fulfill({ status: 404, body: '' }));
    /** @type {string[]} */
    const errors = [];
    page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });

    await page.goto('/?source=public');
    await expect(page.locator('.suites-empty-row')).toBeVisible();
    await expect(page.locator('.suite-table-row')).toHaveCount(0);
    await expect(page.locator('#hero-status-text')).toHaveText('No published results yet. Evaluation files stay on this machine.');
    await expect(page.locator('#hero-auth-btn')).toBeHidden();

    await page.goto('/?source=public&show_login=true');
    await expect(page.locator('#hero-auth-btn')).toBeHidden();
    expect(errors.filter(e => e.includes('public suites'))).toEqual([]);
    expect(googleRequests).toEqual([]);
  });

  test('a stored token and ?source=remote still read the public copy', async ({ page }) => {
    const { googleRequests } = await servePublicCopy(page, { token: 'leftover-token' });
    const authHeaders = await mockPrivateBucket(page);
    const origin = await serveAsGitHubPages(page);

    await page.goto(`${origin}/?source=remote&show_login=true`);
    const row = page.locator('.suite-table-row', { hasText: 'codex' }).first();
    await expect(row.locator('.source-cell')).toHaveText('public');
    await expect(page.locator('#auth-btn')).toBeHidden();
    expect(authHeaders).toEqual([]);
    expect(googleRequests).toEqual([]);
  });
});

test.describe('Local-only view', () => {
  test('a leftover token does not mix the public copy into the local view or call Google', async ({ page }) => {
    const { googleRequests } = await servePublicCopy(page, { token: 'expired-token' });
    const authHeaders = await mockPrivateBucket(page, { status: 403 });
    /** @type {string[]} */
    const publicRequests = [];
    page.on('request', request => { if (request.url().includes('/public-evals/')) publicRequests.push(request.url()); });

    await page.goto('/');
    await expect(page.locator('.suite-table-row', { hasText: 'example-result' }).first()).toBeVisible();
    await expect(page.locator('.suite-table-row', { hasText: 'codex' })).toHaveCount(0);
    await expect(page.locator('#auth-btn')).toBeHidden();
    expect(publicRequests).toEqual([]);
    expect(authHeaders).toEqual([]);
    expect(googleRequests).toEqual([]);
  });

  test('?source=remote on a suite page reads the public copy and never the bucket', async ({ page }) => {
    const { googleRequests } = await servePublicCopy(page, { token: 'googler-token' });
    const authHeaders = await mockPrivateBucket(page);

    await page.goto(`/dashboard.html?testId=${SUITE}&source=remote`);
    await expect(page.locator('#test-header')).toContainText(SUITE);
    await expect(page.locator('.task-accordion').first()).toBeVisible();
    await expect(page.locator('#auth-btn')).toBeHidden();
    await expect(page.locator('#view-gcs-artifacts-btn')).toBeHidden();
    expect(authHeaders).toEqual([]);
    expect(googleRequests).toEqual([]);
  });

  test('an empty public copy does not offer Google sign-in', async ({ page }) => {
    const { googleRequests } = await servePublicCopy(page, { token: 'outsider-token' });
    await page.context().route('**/public-evals/**', route => route.fulfill({ status: 404, body: '' }));
    const origin = await serveAsGitHubPages(page);

    await page.goto(`${origin}/`);
    await expect(page.locator('#hero-status-text')).toHaveText('No published results yet. Evaluation files stay on this machine.');
    await expect(page.locator('#hero-auth-btn')).toBeHidden();
    await expect(page.locator('#auth-btn')).toBeHidden();
    expect(googleRequests).toEqual([]);
  });
});
