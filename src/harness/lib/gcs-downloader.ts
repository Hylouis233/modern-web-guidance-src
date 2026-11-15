/**
 * Local-only fork of the run resolver.
 * Copyright 2026 Google LLC, modified to remove Google Cloud Storage downloads.
 * SPDX-License-Identifier: Apache-2.0
 *
 * Missing run files stay missing. This module never calls the network.
 */

import path from 'path';
import fs from 'fs';
import { resultsDir as baseResultsDir } from '../../core/paths.ts';
import { cYellow } from '../../core/colors.ts';
import { hasRawSessionLogs } from './trajectory-normalizer.ts';

export const GCS_DOWNLOAD_COMPLETE_SENTINEL = '.local_archive_complete';

export async function downloadSuiteEvalsIfMissing(
  suiteName: string,
  _token: string | undefined,
  suiteDirOverride?: string
): Promise<void> {
  const destPath = path.join(suiteDirOverride || path.join(baseResultsDir, suiteName), 'evals.json');
  if (fs.existsSync(destPath)) {
    return;
  }
  console.warn(cYellow(`[local-only] ${destPath} is not on disk. Remote download is disabled.`));
}

function normalizePath(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

export function resolveRunPath(runDir: string): { absoluteRunDir: string; relativeRunPath: string } | null {
  const normalizedRunDir = runDir.replaceAll('\\', '/');
  let absoluteRunDir = normalizePath(runDir);
  const absoluteResultsDir = normalizePath(baseResultsDir);
  let relativeRunPath = path.relative(absoluteResultsDir, absoluteRunDir);

  if (relativeRunPath.startsWith('..') || path.isAbsolute(relativeRunPath)) {
    const hasSuites = /(^|\/)suites(\/|$)/.test(normalizedRunDir);
    const stripped = normalizedRunDir.replace(/^(\.\/)?(harness\/)?results\/(suites\/)?/, '');
    const candidate = path.resolve(hasSuites ? path.join(baseResultsDir, 'suites') : baseResultsDir, stripped);
    const candidateRel = path.relative(absoluteResultsDir, normalizePath(candidate));
    if (!candidateRel.startsWith('..') && !path.isAbsolute(candidateRel)) {
      absoluteRunDir = candidate;
      relativeRunPath = candidateRel;
    } else {
      console.warn(`[local-only] Path is outside results directory: ${absoluteRunDir}`);
      return null;
    }
  }

  relativeRunPath = relativeRunPath.replaceAll(path.sep, path.posix.sep).replace(/^suites\//, '');

  return { absoluteRunDir, relativeRunPath };
}

function localRunIsComplete(absoluteRunDir: string): boolean {
  if (!fs.existsSync(absoluteRunDir)) {
    return false;
  }
  const files = fs.readdirSync(absoluteRunDir);
  const hasSentinel = files.includes(GCS_DOWNLOAD_COMPLETE_SENTINEL) || files.includes('.gcs_download_complete');
  const hasTrajectory = files.includes('trajectory_summary.json') || hasRawSessionLogs(absoluteRunDir);
  const hasResults = files.some((f) => f.endsWith('_results.json') || f === 'runtime.json');
  return hasSentinel || (hasResults && hasTrajectory);
}

/**
 * Resolves a run directory that already exists on disk.
 * The historical name is kept so callers do not need a network fallback.
 */
export async function downloadRunFromGcsIfMissing(runDir: string): Promise<boolean> {
  const resolved = resolveRunPath(runDir);
  if (!resolved) return false;
  const { absoluteRunDir, relativeRunPath } = resolved;
  const parts = relativeRunPath.split(/[/\\]/).filter(Boolean);

  if (parts.length <= 1) {
    return fs.existsSync(path.join(absoluteRunDir, 'evals.json'));
  }

  if (localRunIsComplete(absoluteRunDir)) {
    return true;
  }

  console.warn(cYellow(`[local-only] Run is incomplete on disk: ${absoluteRunDir}. Remote download is disabled.`));
  return false;
}
