import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { cBold, cRed, cYellow } from '../../core/colors.ts';
import { outDir as defaultOutRoot, suitesDir } from '../../core/paths.ts';
import { loadValidatedAllowlist } from './allowlist.ts';
import { buildSelectedSuites, PUBLIC_EVALS_DIR } from './builder.ts';
import type { SuiteBuildResult } from './builder.ts';
import { forbiddenTokens, forbiddenTokensVersion } from './forbidden-tokens.ts';
import { reportResults } from './report.ts';
import { LocalSuiteStore } from './suite-store.ts';

/**
 * CLI: build a local copy of sanitized eval suites. Nothing is pushed.
 *
 *   node src/harness/public/publish-cli.ts [--dry-run] [--force]
 *
 * Reads suites from results/suites and writes out/local-public-evals/.
 */

/** Throws when any result is `failed`, so a partial local export is not treated as success. */
function assertNoFailures(results: readonly SuiteBuildResult[]): void {
  const failed = results.filter(result => result.status === 'failed').map(result => result.suiteId);
  if (failed.length > 0) {
    throw new Error(`${failed.length} suite(s) failed to build; nothing published: ${failed.join(', ')}`);
  }
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      'dry-run': { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
      dispatch: { type: 'boolean', default: true },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowNegative: true,
  });
  if (values.help) {
    console.log('Usage: publish-cli.ts [--dry-run] [--force]');
    console.log('Writes a local sanitized copy under out/local-public-evals. Remote publish is disabled.');
    return 0;
  }

  const tokens = forbiddenTokens([], process.env);
  const tokensVersion = forbiddenTokensVersion();
  const allowlist = loadValidatedAllowlist();
  if (allowlist.releasedModels.length === 0) {
    console.warn(cYellow('releasedModels is empty in the allowlist; every suite will be skipped.'));
  }

  if (!fs.existsSync(suitesDir)) {
    console.log(cBold(`No local suites at ${suitesDir}. Nothing to export.`));
    return 0;
  }

  fs.mkdirSync(defaultOutRoot, { recursive: true });
  const outDir = path.join(defaultOutRoot, 'local-public-evals');
  fs.mkdirSync(outDir, { recursive: true });
  const results = await buildSelectedSuites({
    store: new LocalSuiteStore(suitesDir),
    outDir,
    allowlist,
    forbiddenTokens: tokens,
    forbiddenTokensVersion: tokensVersion,
    force: values.force,
  });
  reportResults(results, path.join(outDir, PUBLIC_EVALS_DIR));
  assertNoFailures(results);
  console.log(cBold(`Wrote local eval copy to ${outDir}. Nothing was uploaded.`));
  return 0;
}

main().then(
  code => process.exit(code),
  err => {
    console.error(cRed(err instanceof Error ? err.stack ?? err.message : String(err)));
    process.exit(1);
  },
);
