import fs from 'node:fs';
import path from 'node:path';

/**
 * Read-only access to raw eval suites on the local disk.
 * Remote Google Cloud Storage is not supported in this fork.
 */
export interface SuiteStore {
  /** Every suite that has an `evals.json`, with enough metadata to skip unchanged ones. */
  listSuites(): Promise<SuiteRef[]>;
  /** File contents, or `undefined` if the file does not exist. */
  readFile(relPath: string): Promise<Buffer | undefined>;
}

export interface SuiteRef {
  id: string;
  /** Changes whenever the suite's `evals.json` is rewritten; opaque. */
  generation: string;
  /** When the suite's `evals.json` was written. Used for retention. */
  createdAt: Date;
}

/** Reads suites from a local directory (`<root>/<suiteId>/...`). */
export class LocalSuiteStore implements SuiteStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  async listSuites(): Promise<SuiteRef[]> {
    const refs: SuiteRef[] = [];
    for (const entry of fs.readdirSync(this.root, { withFileTypes: true })) {
      const evalsPath = path.join(this.root, entry.name, 'evals.json');
      if (entry.isDirectory() && fs.existsSync(evalsPath)) {
        const stat = fs.statSync(evalsPath);
        refs.push({ id: entry.name, generation: String(stat.mtimeMs), createdAt: stat.mtime });
      }
    }
    return refs;
  }

  async readFile(relPath: string): Promise<Buffer | undefined> {
    const absolute = path.join(this.root, relPath);
    if (!absolute.startsWith(this.root + path.sep)) {
      throw new Error(`Refusing to read outside the store root: ${relPath}`);
    }
    return fs.existsSync(absolute) ? fs.readFileSync(absolute) : undefined;
  }
}
