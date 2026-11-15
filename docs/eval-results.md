# Evaluation Results Management

This document covers how evaluation results stay on this machine. This fork does not upload them to Google Cloud Storage or anywhere else. There is no remote bucket to sync.

## Storage Location
Evaluation results are stored locally in:
- `results/suites/` (default within the repo).
- Or a custom external directory (e.g., `~/guidance-evals`).

Each job has its own directory containing:
- `evals.json`: Summary of all trials and checks.
- `evals.md`: Markdown report of the job.
- Numbered directories (`1`, `2`, `3`...) for each repetition, containing agent logs and grader results.

---

## Archiving locally
`src/harness/upload-suite.ts` copies a job into `out/local-evals/`. The file name is unchanged so existing tests keep working. It never contacts a cloud bucket.

### How it works
1. Requires `evals.json` to exist in the job directory (ensures evaluation was run).
2. Copies the job into `out/local-evals/<suite-name>/` (skipping `node_modules`).
3. Refuses to write outside that archive directory.

### Command
```bash
# Archive a job from local repo results
pnpm archive-evals <suite-name>

# Archive with flags or from a custom directory
node src/harness/upload-suite.ts <suite-name> [--summary-only] [custom_results_dir]
```

---

## Workflows

### 1. No remote copy
Results that are not already under `results/` or `out/local-evals/` stay missing. Do not run `gcloud storage` against this tree.

### 2. Backfilling Metrics
When metrics reporting logic changes, you can backfill all jobs in a directory:

```bash
# Backfill local repo results
node src/harness/backfill.ts

# Backfill a custom local directory
node src/harness/backfill.ts ~/guidance-evals
```
This updates `evals.json` and `evals.md` in each job directory. Run `pnpm archive-evals` again if you want a fresh local archive. Nothing is pushed off the machine.
