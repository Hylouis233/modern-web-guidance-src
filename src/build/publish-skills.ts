import fs from 'node:fs/promises';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { buildDist, processSkills, type DistTag } from './build-dist.ts';
import { getFeaturesAndUseCases } from './build-readme.ts';
import { fileURLToPath } from 'node:url';
import { minimatch } from 'minimatch';
import { rootDir } from '../core/paths.ts';
import { embedGuideChunks } from '../rag/embed-guide-chunks.ts';

const ROOT_DIR = rootDir; // modern-web-guidance-src/

const DIST_DIR = path.join(ROOT_DIR, "dist");

// File filter for a local dry-run of the skill package. This fork does not publish it.
export const GH_PUBLISH_PATTERNS = [
  '**/*',
  '!**/.cache/**',
  '!**/tfjs-model-minilm/**',
  '!**/static-model/**',
  '!**/gen/**',
  '!**/*.{js,mjs,ts,bin,map,gz,i8,f32}',
  '!**/guides.json',
  '!**/skill-version.txt',
  '!THIRD_PARTY_NOTICES',
  '!skills/modern-web-guidance/package.json',
];

// Stripped allowlist for the `claude` branch tracked by claude.ai/directory/manage.
// Unverified organizations are rejected if the branch contains non-allowed file types
// (.toml, .svg) or non-Claude manifests/keys (package.json, .codex-plugin, etc.).
export const GH_CLAUDE_PUBLISH_PATTERNS = [
  '.claude-plugin/plugin.json',
  'skills/**/*.md',
  '!**/.cache/**',
  '!**/tfjs-model-minilm/**',
  '!**/static-model/**',
  '!**/gen/**',
  'README.md',
  'CONTRIBUTING.md',
  'LICENSE',
  '.gitignore',
  'assets/logo.png',
];

/**
 * Mirrors globby's positive/negative pattern matching for dry-run previews and tests.
 */
export function filterPublishFiles(files: string[], patterns: string[]): string[] {
  const positivePatterns = patterns.filter((p) => !p.startsWith('!'));
  const negativePatterns = patterns.filter((p) => p.startsWith('!')).map((p) => p.slice(1));

  return files
    .filter((file) =>
      positivePatterns.some((pattern) => minimatch(file, pattern, { dot: true })) &&
      negativePatterns.every((pattern) => !minimatch(file, pattern, { dot: true })),
    )
    .sort((a, b) => a.localeCompare(b));
}

const isDryRun = process.argv.includes('--dry-run');

export type { DistTag };

export interface PublishOptions {
  distTag: DistTag;
  explicitVersion?: string;
}

export function parsePublishOptions(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): PublishOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      tag: { type: 'string' },
      version: { type: 'string' },
    },
    strict: false,
  });

  const rawTag = (typeof values.tag === 'string' ? values.tag : (env.DIST_TAG ?? env.NPM_DIST_TAG))?.trim();
  const rawVersion = (typeof values.version === 'string' ? values.version : env.RELEASE_VERSION)?.trim();

  const distTag = (rawTag || 'latest') as DistTag;
  if (distTag !== 'latest' && distTag !== 'next') {
    throw new Error(`Invalid dist-tag "${distTag}". Expected "latest" or "next".`);
  }

  const explicitVersion = rawVersion ? rawVersion.replace(/^v/, '') : undefined;
  if (explicitVersion !== undefined && !/^\d+\.\d+\.\d+$/.test(explicitVersion)) {
    throw new Error(`Invalid explicit version "${rawVersion}". Expected X.Y.Z semver (e.g. 1.0.0).`);
  }

  return { distTag, explicitVersion };
}

function incrementVersion(version: string): string {
  const parts = version.split('.');
  const patch = parseInt(parts[2], 10) + 1;
  return `${parts[0]}.${parts[1]}.${patch}`;
}

const getLatestGitTag = (target = 'HEAD') => {
  const output = execSync(`git tag --merged ${target} -l "v*.*.*" --sort=-v:refname`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
  if (!output) {
    throw new Error(`No tag matching v*.*.* found reachable from ${target}`);
  }
  return output.split('\n')[0].trim();
};

function gitTagExists(version: string): boolean {
  const localCheck = execSync(`git tag -l "v${version}"`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
  return Boolean(localCheck);
}

export async function getNextVersion(getLatestTag = getLatestGitTag): Promise<string> {
  console.log("Determining next version...");

  const target = isDryRun ? 'origin/main' : 'HEAD';
  console.log(`Checking latest tag against ${target}...`);
  
  let latestTag: string;
  try {
    latestTag = getLatestTag(target);
  } catch (err) {
    if (isDryRun) {
      console.log(`Could not find tags on ${target}. Falling back to HEAD.`);
      latestTag = getLatestTag('HEAD');
    } else {
      throw err;
    }
  }

  console.log(`Found latest tag: ${latestTag}`);
  const currentVersion = latestTag.startsWith('v') ? latestTag.slice(1) : latestTag;

  const newVersion = incrementVersion(currentVersion);
  console.log(`Next version will be: ${newVersion}`);
  return newVersion;
}

/**
 * Validate using the local build.
 */
export interface ValidateDeps {
  dryRun?: boolean;
  distTag?: DistTag;
  embedChunks?: typeof embedGuideChunks;
  runBuildDist?: typeof buildDist;
  runDistTests?: () => void;
}

export async function validate(newVersion: string, deps: ValidateDeps = {}) {
  const {
    dryRun = isDryRun,
    distTag = 'latest',
    embedChunks = embedGuideChunks,
    runBuildDist = buildDist,
    runDistTests = () =>
      execSync('node --test src/build/dist.test.ts', {
        cwd: ROOT_DIR,
        stdio: 'inherit',
        env: { ...process.env, TEST_REPORTER: 'spec' },
      }),
  } = deps;
  const publishCliDir = path.join(DIST_DIR, "skills-cli");

  if (dryRun) {
    console.log(`\nChecking cached teacher vectors (dry run)...`);
    const checkResult = await embedChunks({ check: true });
    if (checkResult.missing.length > 0) {
      const missingGuides = [...new Set(checkResult.missing.map((c) => c.guideId))];
      console.warn(
        `⚠️  [Dry Run] ${checkResult.missing.length} chunk(s) across ${missingGuides.length} guide(s) lack cached teacher vectors ` +
          `(indexed for BM25 only, vector: []; real publish will embed them):\n` +
          missingGuides.map((g) => `  - ${g}`).join("\n")
      );
    }
  } else {
    console.log(`\nEnsuring all guide chunks have cached teacher vectors...`);
    const embedResult = await embedChunks({ prune: true });
    if (embedResult.newEmbeds > 0 || embedResult.prunedCount > 0) {
      console.log(`✅ Updated static chunk vector cache (+${embedResult.newEmbeds} embedded, -${embedResult.prunedCount} pruned).`);
    }
  }

  console.log(`\nRebuilding distribution with version ${newVersion} (dist-tag: ${distTag})...`);
  const result = await runBuildDist({
    publishRoot: publishCliDir,
    version: newVersion,
    failOnMissingVectors: !dryRun,
    distTag,
  });
  if (!result) {
    throw new Error("Build failed or was already in progress.");
  }

  console.log(`\nVerifying built distribution with dist.test.ts suite...`);
  runDistTests();

  return result;
}

async function main() {
  if (!isDryRun) {
    console.error('External publishing is disabled in this local-only fork. Nothing is pushed to GitHub, npm, or Google.');
    console.error('Re-run with --dry-run to validate the local build. The output stays in dist/skills-cli.');
    process.exit(1);
  }
  const { distTag, explicitVersion } = parsePublishOptions();
  let newVersion: string;

  if (explicitVersion) {
    if (gitTagExists(explicitVersion)) {
      throw new Error(`Version v${explicitVersion} has already been tagged!`);
    }
    newVersion = explicitVersion;
    console.log(`Using explicit version override: ${newVersion} (dist-tag: ${distTag})`);
  } else {
    newVersion = await getNextVersion();
    // Self-healing loop: ensure the version tag doesn't exist locally or on remote repos
    while (gitTagExists(newVersion)) {
      console.log(`⚠️ Version v${newVersion} has already been tagged! Bumping version to next patch...`);
      newVersion = incrementVersion(newVersion);
    }
  }

  const { skillsCount, skillNames } = await validate(newVersion, { distTag });
  const publishCliDir = path.join(DIST_DIR, "skills-cli");

  if (isDryRun) {
    const { allFeatureIds, readyGuides } = getFeaturesAndUseCases();
    const featuresCount = allFeatureIds.size;
    const useCasesCount = readyGuides.length;

    const files = await fs.readdir(publishCliDir, {recursive: true, withFileTypes: true});
    const allRelativeFiles = files
      .filter(f => !f.parentPath.includes('node_modules') && f.isFile())
      .map(f => path.relative(publishCliDir, path.join(f.parentPath, f.name)));
    const filteredFiles = filterPublishFiles(allRelativeFiles, GH_PUBLISH_PATTERNS);
    const claudeFiles = filterPublishFiles(allRelativeFiles, GH_CLAUDE_PUBLISH_PATTERNS);

    console.log(`\n[Dry Run] Skipping GitHub publishing. Would push to main:\n - ${filteredFiles.join('\n - ')}`);
    console.log(`\n[Dry Run] Would push to claude (${claudeFiles.length} files):\n - ${claudeFiles.join('\n - ')}`);
    console.log(`\n[Dry Run] ✅ Successfully verified v${newVersion} build pipeline offline!`);
    console.log(`\n[Dry Run] Skills: ${skillsCount} (${skillNames.join(', ')})`);
    console.log(`\n[Dry Run] Features: ${featuresCount}, Use cases: ${useCasesCount}`);

    console.log(`\n[Dry Run] Skipping Gemini release notes so the diff is not uploaded.`);

    console.log(`\n💡 Tip: Run thorough pre-flight verification with FULL=1 to include heavy agent tests:`);
    console.log(`   env FULL=1 TEST_REPORTER=spec pnpm test`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error("Publishing failed!", err);
    process.exit(1);
  });
}
