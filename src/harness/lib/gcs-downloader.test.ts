import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { downloadRunFromGcsIfMissing, downloadSuiteEvalsIfMissing } from './gcs-downloader.ts';
import { NORMALIZER_VERSION } from './trajectory-normalizer.ts';
import { resultsDir } from '../../core/paths.ts';

describe('gcs-downloader', () => {
  test('downloadRunFromGcsIfMissing returns early when complete directory exists locally', async () => {
    const testSuite = `test-gcs-local-${Date.now()}`;
    const testRunDir = path.join(resultsDir, testSuite, '1', 'details-styling', 'task', 'guided');
    fs.mkdirSync(testRunDir, { recursive: true });
    try {
      // Create local run directory with suite evals.json, _results.json, and raw session log
      fs.writeFileSync(path.join(resultsDir, testSuite, 'evals.json'), JSON.stringify({ suite: testSuite, agent: 'claude_code' }));
      fs.writeFileSync(path.join(testRunDir, 'details-styling_results.json'), JSON.stringify({ suites: [] }));
      fs.writeFileSync(
        path.join(testRunDir, 'session-1.jsonl'),
        JSON.stringify({
          role: 'assistant',
          timestamp: '2026-08-09T21:00:00.000Z',
          message: { content: [{ type: 'tool_use', id: 'c1', name: 'Bash', input: { command: 'npx modern-web-guidance search "dialog"' } }] }
        })
      );

      const result = await downloadRunFromGcsIfMissing(testRunDir);
      assert.strictEqual(result, true);
    } finally {
      fs.rmSync(path.join(resultsDir, testSuite), { recursive: true, force: true });
    }
  });

  test('partial local directory does not contact the network and returns false', async () => {
    const testSuite = `test-gcs-partial-${Date.now()}`;
    const testRunDir = path.join(resultsDir, testSuite, '1', 'details-styling', 'task', 'guided');
    fs.mkdirSync(testRunDir, { recursive: true });

    const origFetch = globalThis.fetch;
    let fetchCount = 0;

    try {
      fs.writeFileSync(path.join(resultsDir, testSuite, 'evals.json'), JSON.stringify({ suite: testSuite }));
      fs.writeFileSync(
        path.join(testRunDir, 'trajectory_summary.json'),
        JSON.stringify({ normalizerVersion: NORMALIZER_VERSION, agent: 'claude_code', steps: [{ stepNumber: 1 }] })
      );

      globalThis.fetch = (async () => {
        fetchCount++;
        return new Response('unexpected', { status: 500 });
      }) as typeof fetch;

      const result = await downloadRunFromGcsIfMissing(testRunDir);
      assert.strictEqual(fetchCount, 0, 'Incomplete local runs must not trigger a download');
      assert.strictEqual(result, false);
    } finally {
      globalThis.fetch = origFetch;
      fs.rmSync(path.join(resultsDir, testSuite), { recursive: true, force: true });
    }
  });

  test('downloadSuiteEvalsIfMissing does not create files or call the network', async () => {
    const testSuite = `test-gcs-dedup-${Date.now()}`;
    const origFetch = globalThis.fetch;
    let fetchCount = 0;

    try {
      globalThis.fetch = (async () => {
        fetchCount++;
        return new Response('{}', { status: 200 });
      }) as typeof fetch;

      await Promise.all([
        downloadSuiteEvalsIfMissing(testSuite, 'Bearer mock-token'),
        downloadSuiteEvalsIfMissing(testSuite, 'Bearer mock-token'),
        downloadSuiteEvalsIfMissing(testSuite, 'Bearer mock-token')
      ]);

      assert.strictEqual(fetchCount, 0);
      assert.strictEqual(fs.existsSync(path.join(resultsDir, testSuite, 'evals.json')), false);
    } finally {
      globalThis.fetch = origFetch;
      fs.rmSync(path.join(resultsDir, testSuite), { recursive: true, force: true });
    }
  });

  test('validates GCS bucket configuration constants', async () => {
    const gcsModule = await import('./gcs-downloader.ts');
    assert.ok(gcsModule.downloadRunFromGcsIfMissing);
    assert.strictEqual(typeof gcsModule.downloadRunFromGcsIfMissing, 'function');
  });

  test('resolveRunPath resolves both repo-relative and results-relative suite paths', async () => {
    const { resolveRunPath } = await import('./gcs-downloader.ts');
    const relativeSuite = 'nightly-2026-08-10_17-00-02-jetski_cli/1/details-styling/task/guided';

    // Results-relative path
    const resolved1 = resolveRunPath(relativeSuite);
    assert.ok(resolved1);
    assert.strictEqual(resolved1.relativeRunPath, relativeSuite);
    assert.ok(resolved1.absoluteRunDir.endsWith(path.normalize(relativeSuite)));

    // Repo-relative path
    const resolved2 = resolveRunPath(`harness/results/${relativeSuite}`);
    assert.ok(resolved2);
    assert.strictEqual(resolved2.relativeRunPath, relativeSuite);
    assert.ok(resolved2.absoluteRunDir.endsWith(path.normalize(relativeSuite)));
  });

  test('resolveRunPath handles results/suites paths without prefixing suites/ to relativeRunPath', async () => {
    const { resolveRunPath } = await import('./gcs-downloader.ts');
    const suiteRun = 'nightly-2026-09-08_12-00-00-claude_code/1/details-styling/task/guided';

    const resolved = resolveRunPath(`results/suites/${suiteRun}`);
    assert.ok(resolved);
    assert.strictEqual(resolved.relativeRunPath, suiteRun);
    assert.ok(resolved.absoluteRunDir.endsWith(path.join('results', 'suites', suiteRun)));

    const resolved2 = resolveRunPath(`harness/results/suites/${suiteRun}`);
    assert.ok(resolved2);
    assert.strictEqual(resolved2.relativeRunPath, suiteRun);
    assert.ok(resolved2.absoluteRunDir.endsWith(path.join('results', 'suites', suiteRun)));
  });
});
