import os from 'os';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { cRed, cGreen, cCyan, cBold } from '../core/colors.ts';
import { outDir, suitesDir as baseResultsDir } from '../core/paths.ts';
import { extractSuiteSummary } from '../dashboard/summary-extractor.js';
import {
  BASE64_TRAJECTORY_SCRIPT_RE,
  extractBase64TrajectoryPayloads,
  findSecretLeaks,
  getHostSecrets,
  sanitizeTextSecrets,
} from './lib/secret-guard.ts';

const LOCAL_EVALS_DIR = path.join(outDir, 'local-evals');

const TEXT_UPLOAD_EXTENSIONS = new Set([
  '.txt', '.log', '.json', '.jsonl', '.patch', '.md', '.css', '.js', '.mjs', '.cjs',
  '.ts', '.mts', '.cts', '.tsx', '.jsx', '.astro', '.svelte', '.vue', '.htm',
  '.xml', '.svg', '.yaml', '.yml', '.csv',
]);

const BINARY_TRAJECTORY_EXTENSIONS = new Set(['.db', '.db-wal', '.db-shm', '.sqlite', '.pb']);

interface UploadPlanEntry {
  localPath: string;
  destinationPath: string;
  redacted: boolean;
}

function stageOrVerifyFile(
  fullPath: string,
  destinationPath: string,
  fileName: string,
  stagingDir: string,
  extraSecrets: readonly string[],
  entries: UploadPlanEntry[],
  leakErrors: string[],
): void {
  const ext = path.extname(fileName).toLowerCase();
  const lowerName = fileName.toLowerCase();
  const isBinaryTrajectory = BINARY_TRAJECTORY_EXTENSIONS.has(ext)
    || lowerName.endsWith('.db-wal')
    || lowerName.endsWith('.db-shm');

  if (ext === '.html' || TEXT_UPLOAD_EXTENSIONS.has(ext)) {
    const original = fs.readFileSync(fullPath, 'utf8');
    if (ext === '.html') {
      for (const payload of extractBase64TrajectoryPayloads(original)) {
        const payloadLeaks = findSecretLeaks(payload, extraSecrets);
        if (payloadLeaks.length > 0) {
          leakErrors.push(`${destinationPath} (embedded payload: ${payloadLeaks.join(', ')})`);
        }
      }
    }

    const redacted = sanitizeTextSecrets(original, extraSecrets, { preserveBase64Scripts: ext === '.html' });
    const textToVerify = ext === '.html' ? redacted.replace(BASE64_TRAJECTORY_SCRIPT_RE, '') : redacted;
    const remaining = findSecretLeaks(textToVerify, extraSecrets);
    if (remaining.length > 0) {
      leakErrors.push(`${destinationPath} (unredacted: ${remaining.join(', ')})`);
    }

    if (redacted !== original) {
      const stagedPath = path.join(stagingDir, destinationPath.replace(/^[/\\]+/, ''));
      fs.mkdirSync(path.dirname(stagedPath), { recursive: true });
      fs.writeFileSync(stagedPath, redacted, 'utf8');
      entries.push({ localPath: stagedPath, destinationPath, redacted: true });
    } else {
      entries.push({ localPath: fullPath, destinationPath, redacted: false });
    }
    return;
  }

  const leaks = findSecretLeaks(fs.readFileSync(fullPath), extraSecrets, { scanPatterns: isBinaryTrajectory });
  if (leaks.length > 0) {
    leakErrors.push(`${destinationPath} (${leaks.join(', ')})`);
    return;
  }
  entries.push({ localPath: fullPath, destinationPath, redacted: false });
}

export async function uploadDirectory(
  bucket: { upload: (localPath: string, opts: { destination: string }) => Promise<unknown> },
  dirPath: string,
  gcsPrefix: string,
  summaryOnly = false,
  options: { extraSecrets?: readonly string[] } = {},
): Promise<{ uploaded: number; redacted: number }> {
  const extraSecrets = options.extraSecrets ?? getHostSecrets();
  const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-upload-stage-'));
  const entries: UploadPlanEntry[] = [];
  const leakErrors: string[] = [];

  function collectFiles(currentDir: string, currentPrefix: string) {
    const files = fs.readdirSync(currentDir, { withFileTypes: true });

    for (const file of files) {
      const fullPath = path.join(currentDir, file.name);
      const destinationPath = path.join(currentPrefix, file.name);

      if (file.name === 'node_modules' || file.name === '.jetskicli') continue;

      if (file.isDirectory()) {
        if (!summaryOnly) {
          collectFiles(fullPath, destinationPath);
        }
      } else {
        if (file.name === '.DS_Store' || file.name === 'pnpm-workspace.yaml') continue;
        if (summaryOnly && file.name !== 'evals.json' && file.name !== 'evals.md') continue;
        stageOrVerifyFile(fullPath, destinationPath, file.name, stagingDir, extraSecrets, entries, leakErrors);
      }
    }
  }

  try {
    collectFiles(dirPath, gcsPrefix);

    if (leakErrors.length > 0) {
      throw new Error(`Upload blocked: detected credentials in ${leakErrors.length} file(s):\n  - ${leakErrors.join('\n  - ')}`);
    }

    const redactedCount = entries.filter(e => e.redacted).length;
    console.log(
      `Discovered ${entries.length} files to archive locally${redactedCount > 0 ? ` (${redactedCount} redacted)` : ''}.`,
    );

    const concurrencyLevel = 50;
    for (let i = 0; i < entries.length; i += concurrencyLevel) {
      const chunk = entries.slice(i, i + concurrencyLevel);
      await Promise.all(
        chunk.map(async (entry) => {
          console.log(`Archiving ${entry.destinationPath} on the local disk...`);
          await bucket.upload(entry.localPath, { destination: entry.destinationPath });
        }),
      );
    }

    return { uploaded: entries.length, redacted: redactedCount };
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
}

export async function reconcileAndUploadManifest(
  bucket: any,
  uploadedSuiteName: string | null,
  evalsData: any,
  options: { reextractAll?: boolean } = {},
) {
  console.log(cCyan('🔄 Reconciling the local suites manifest...'));
  
  let remoteManifest: any[] = [];
  const manifestFile = bucket.file('suites.gen.json');
  try {
    const [exists] = await manifestFile.exists();
    if (exists) {
      const [content] = await manifestFile.download();
      remoteManifest = JSON.parse(content.toString('utf8'));
    }
  } catch (e: any) {
    console.warn(`Could not read the local suites.gen.json: ${e.message}`);
  }

  // Fast prefix listing with pagination to detect all suites in GCS
  const gcsPrefixes: string[] = [];
  let pageToken: string | undefined = undefined;
  do {
    const res: [any, any, any] = await bucket.getFiles({ delimiter: '/', autoPaginate: false, pageToken });
    const nextQuery = res[1];
    const apiResponse = res[2];
    if (apiResponse && apiResponse.prefixes) {
      gcsPrefixes.push(...apiResponse.prefixes);
    }
    pageToken = nextQuery?.pageToken;
  } while (pageToken);

  const activeSuiteIds = new Set<string>(gcsPrefixes.map((p: string) => p.replace(/\/$/, '')));
  if (uploadedSuiteName) {
    activeSuiteIds.add(uploadedSuiteName);
  }

  const manifestMap = new Map<string, any>();
  for (const entry of remoteManifest) {
    const id = typeof entry === 'string' ? entry : entry.testId;
    if (id && activeSuiteIds.has(id)) {
      manifestMap.set(id, typeof entry === 'string' ? { testId: id } : entry);
    }
  }

  // Update the uploaded suite's summary
  if (uploadedSuiteName && evalsData) {
    const uploadedSummary = extractSuiteSummary(uploadedSuiteName, evalsData);
    if (uploadedSummary) {
      manifestMap.set(uploadedSuiteName, uploadedSummary);
    }
  }

  // Backfill missing summaries (or re-extract all when --reextract-manifest is passed)
  const missingSuiteIds = Array.from(activeSuiteIds).filter(id => {
    if (options.reextractAll && id !== uploadedSuiteName) return true;
    const existing = manifestMap.get(id);
    return !existing || !existing.guidedStats || !existing.a11yStats || !existing.showcase;
  });

  if (missingSuiteIds.length > 0) {
    const concurrency = 10;
    for (let i = 0; i < missingSuiteIds.length; i += concurrency) {
      const chunk = missingSuiteIds.slice(i, i + concurrency);
      await Promise.all(chunk.map(async (suiteId) => {
        try {
          console.log(`${options.reextractAll ? 'Re-extracting' : 'Extracting'} summary for local suite: ${suiteId}...`);
          const evalsFile = bucket.file(`${suiteId}/evals.json`);
          const [fileContent] = await evalsFile.download();
          const parsed = JSON.parse(fileContent.toString('utf8'));
          const summary = extractSuiteSummary(suiteId, parsed);
          if (summary) {
            manifestMap.set(suiteId, summary);
          }
        } catch (e: any) {
          console.warn(`Could not fetch evals.json for ${suiteId}: ${e.message}`);
        }
      }));
    }
  }

  const updatedList = Array.from(manifestMap.values()).sort((a, b) => (a.testId || '').localeCompare(b.testId || ''));

  await manifestFile.save(JSON.stringify(updatedList, null, 2), {
    contentType: 'application/json',
    resumable: false,
  });

  console.log(cBold(cGreen(`✅ Reconciled local suites.gen.json (${updatedList.length} suites)`)));
}

function resolveInside(root: string, rel: string): string {
  const dest = path.resolve(root, rel);
  const resolvedRoot = path.resolve(root);
  if (dest !== resolvedRoot && !dest.startsWith(resolvedRoot + path.sep)) {
    throw new Error(`Refusing to write outside the local archive: ${rel}`);
  }
  return dest;
}

/** Disk stand-in for the old bucket client. It never opens a network connection. */
function createLocalArchive(root: string) {
  fs.mkdirSync(root, { recursive: true });
  return {
    async upload(localPath: string, opts: { destination: string }) {
      const dest = resolveInside(root, opts.destination);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(localPath, dest);
    },
    async getFiles() {
      const prefixes = fs.readdirSync(root, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => `${entry.name}/`);
      return [[], null, { prefixes }];
    },
    file(objectPath: string) {
      const dest = resolveInside(root, objectPath);
      return {
        async exists() {
          return [fs.existsSync(dest)];
        },
        async download() {
          return [fs.readFileSync(dest)];
        },
        async save(body: string) {
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.writeFileSync(dest, body);
        },
      };
    },
  };
}

async function main() {
  const args = process.argv.slice(2);
  const summaryOnly = args.includes('--summary-only');
  const reextractManifest = args.includes('--reextract-manifest');

  // Remove flags to get positional arguments
  const positionalArgs = args.filter(a => !a.startsWith('--'));

  if (reextractManifest && positionalArgs.length === 0) {
    const archive = createLocalArchive(LOCAL_EVALS_DIR);
    await reconcileAndUploadManifest(archive, null, null, { reextractAll: true });
    return;
  }

  let suiteName = positionalArgs[0];
  const customResultsDir = positionalArgs[1];

  if (!suiteName) {
    console.error('❌ Please provide a suite name (e.g. pnpm upload <suite-name>) or --reextract-manifest.');
    process.exit(1);
  }

  // Strip trailing slashes and normalize to just the suite ID
  suiteName = path.basename(suiteName);

  let resultsDir = path.join(baseResultsDir, suiteName);
  
  // Support custom results directory!
  if (customResultsDir) {
    resultsDir = path.join(path.resolve(customResultsDir), suiteName);
  }
  
  const evalsJsonPath = path.join(resultsDir, 'evals.json');

  if (!fs.existsSync(resultsDir)) {
    console.error(cRed(`❌ Results directory not found: ${resultsDir}`));
    process.exit(1);
  }

  if (!fs.existsSync(evalsJsonPath)) {
    console.error(cRed(`❌ evals.json not found in ${resultsDir}. Cannot upload incomplete or un-evaluated suite.`));
    process.exit(1);
  }

  let evalsData: any = null;
  try {
    const evalsContent = fs.readFileSync(evalsJsonPath, 'utf8');
    evalsData = JSON.parse(evalsContent);
    const results = evalsData.results || {};
    if (Object.keys(results).length === 0) {
      console.warn(cRed(`⚠️ Warning: No evaluation data found in evals.json (0 tasks were run). Sync skipped.`));
      process.exit(0);
    }

    // Guard: Prevent uploading runs with 100% early generation failures (catastrophic crash)
    const testNames = Object.keys(results);
    let totalRunsCount = 0;
    let earlyFailuresCount = 0;
    for (const testName of testNames) {
      const runs = results[testName] || [];
      for (const run of runs) {
        totalRunsCount++;
        const scenarioChecks = run.results || [];
        if (scenarioChecks.some((check: any) => check.isEarlyFailure)) {
          earlyFailuresCount++;
        }
      }
    }
    if (totalRunsCount > 0 && earlyFailuresCount === totalRunsCount) {
      console.error(cRed(`❌ Error: Catastrophic generation failures (100% early failure rate). Upload blocked to prevent trend contamination.`));
      process.exit(1);
    }
  } catch (e: any) {
    console.error(cRed(`❌ Failed to parse evals.json: ${e.message}`));
    process.exit(1);
  }

  console.log(cBold(cCyan(`Archiving suite locally: ${suiteName}${summaryOnly ? ' (Summary Only)' : ''}`)));

  const archive = createLocalArchive(LOCAL_EVALS_DIR);

  try {
    await uploadDirectory(archive, resultsDir, suiteName, summaryOnly);
    console.log(cBold(cGreen(`\n✅ Archived suite '${suiteName}' to ${path.join(LOCAL_EVALS_DIR, suiteName)}`)));
    await reconcileAndUploadManifest(archive, suiteName, evalsData, { reextractAll: reextractManifest });
  } catch (error: any) {
    console.error(cRed(`❌ Local archive failed: ${error.message}`));
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(console.error);
}
