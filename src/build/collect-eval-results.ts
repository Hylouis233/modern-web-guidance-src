import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { rootDir, suitesDir } from '../core/paths.ts';

const ALLOWED_AGENTS = ['claude_code', 'codex_cli', 'antigravity_cli'];

// Compare case-insensitively and ignore '-'/'_' so spelling variants (e.g. claude-code) still match.
const normalizeAgent = (name: string) => name.toLowerCase().replace(/[-_]/g, '');
const NORMALIZED_ALLOWED_AGENTS = new Set(ALLOWED_AGENTS.map(normalizeAgent));

function isAgentAllowed(agent: string): boolean {
  return NORMALIZED_ALLOWED_AGENTS.has(normalizeAgent(agent));
}


const OUTPUT_PATH = path.join(rootDir, 'src/build/eval-results-summary.json');

interface EvalsSummary {
  testId: string;
  timestamp: string;
  agent: string;
  serving: string;
  model: string;
  taskCount: number;
  assertionCount: number;
  unguidedPassRate: number;
  guidedPassRate: number;
  skillVersion?: string;
  cliVersion?: string;
}

function listLocalNightlySuites(): string[] {
  if (!fs.existsSync(suitesDir)) {
    console.log(`No local suites directory at ${suitesDir}.`);
    return [];
  }
  const targetFolders = fs.readdirSync(suitesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('nightly-'))
    .map((entry) => entry.name)
    .sort((a, b) => b.localeCompare(a))
    .slice(0, 10);
  console.log(`Using ${targetFolders.length} local nightly suite(s) from ${suitesDir}. Remote collection is disabled.`);
  return targetFolders;
}

function collectResults() {
  const targetSuites = listLocalNightlySuites();
  if (targetSuites.length === 0) {
    console.log('No local nightly suites. Leaving the checked-in summary unchanged.');
    return;
  }

  console.log(`Aggregating results from ${targetSuites.length} verified suites...`);
  const summaries: EvalsSummary[] = [];

  for (let folderName of targetSuites) {
    const suiteDir = path.join(suitesDir, folderName);
    const evalsPath = path.join(suiteDir, 'evals.json');

    if (!fs.existsSync(evalsPath)) {
      console.warn(`Missing evals.json in ${folderName}`);
      continue;
    }

    try {
      const content = fs.readFileSync(evalsPath, 'utf8');
      const data = JSON.parse(content);

      let agent = data.agent || 'unknown';
      if (agent.startsWith('jetski')) {
        agent = 'antigravity_cli';
        folderName = folderName.replace('jetski_cli', 'antigravity_cli');
      }

      if (!isAgentAllowed(agent)) {
        console.log(`Skipping ${folderName} (agent ${agent} not in allowlist)`);
        continue;
      }

      const summary = data.summary;
      if (!summary) {
        console.warn(`Missing summary in ${folderName}/evals.json`);
        continue;
      }

      const taskCount = summary.taskCount || 0;
      if (taskCount < 60) {
        console.log(`Skipping ${folderName} (taskCount ${taskCount} < 60)`);
        continue;
      }
      // broken run.
      if (summary.unguidedPassRate == 0 || summary.guidedPassRate == 0 || summary.guidedTotal < 500) {
        console.log(`Skipping ${folderName} (broken run probably)`);
        continue;
      }

      // Historical runs may record a now-removed serving approach (e.g. `mcp`).
      const serving = data.serving || 'unknown';

      summaries.push({
        testId: folderName,
        timestamp: data.timestamp || new Date().toISOString(),
        agent: agent,
        serving: serving,
        model: data.model || 'unknown',
        taskCount: taskCount,
        assertionCount: summary.guidedTotal ?? 0,
        unguidedPassRate: summary.unguidedPassRate ?? 0,
        guidedPassRate: summary.guidedPassRate ?? 0,
        skillVersion: data.skillVersion,
        cliVersion: data.cliVersion,
      });
    } catch (e) {
      console.error(`Error reading/parsing ${folderName}/evals.json:`, e);
    }
  }

  // Sort by timestamp descending
  summaries.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  console.log(`Collected ${summaries.length} nightly runs.`);

  // Ensure directory exists
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(summaries, null, 2));
  console.log(`Saved summary to ${OUTPUT_PATH}`);

  console.log(`\nVerifying collected summary against evaluation regression guardrails...`);
  try {
    execSync('node --test src/build/eval-regression.test.ts', { cwd: rootDir, stdio: 'inherit' });
    console.log(`✅ Regression guardrail checks passed successfully.`);
  } catch (err) {
    console.error(`\n❌ EVALUATION REGRESSION DETECTED! Please review the failures above before committing.`);
    process.exit(1);
  }
}

collectResults();
