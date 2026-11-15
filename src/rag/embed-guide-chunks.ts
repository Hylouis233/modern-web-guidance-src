/**
 * Pre-release script to embed guide chunks with gemini-embedding-001 at build time.
 *
 * Chunks are embedded with taskType "RETRIEVAL_DOCUMENT", 768 dimensions,
 * MRL-truncated to 256 dimensions and L2-normalized.
 * Results are stored in an Int8 + scale cache in `src/rag/gen/`.
 *
 * Usage:
 *   node src/rag/embed-guide-chunks.ts [--check] [--force] [--prune]
 */

import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { rootDir } from "../core/paths.ts";
import {
  truncateAndNormalize256,
  TEACHER_MODEL,
  TASK_TYPE,
  TEACHER_DIM,
  STATIC_DIMS,
  DEFAULT_CACHE_DIR,
  loadChunkCache,
  saveChunkCache,
} from "./guide-chunk-cache.ts";
import {
  scanCorpusChunks,
  type GuideChunk,
} from "../core/guide-chunks.ts";
export interface EmbedChunksOptions {
  check?: boolean;
  force?: boolean;
  prune?: boolean;
  cacheDir?: string;
}

export async function embedGuideChunks(options: EmbedChunksOptions = {}): Promise<{
  totalChunks: number;
  cachedCount: number;
  newEmbeds: number;
  prunedCount: number;
  missing: GuideChunk[];
}> {
  const cacheDir = options.cacheDir ?? DEFAULT_CACHE_DIR;
  const allChunks = scanCorpusChunks("skills-cli");

  const existingCache = options.force ? new Map<string, Float32Array>() : loadChunkCache(cacheDir);

  // If check mode requested: verify that 100% of chunks are in cache without calling API
  if (options.check) {
    const missing = allChunks.filter((c) => !existingCache.has(c.hash));
    return {
      totalChunks: allChunks.length,
      cachedCount: allChunks.length - missing.length,
      newEmbeds: 0,
      prunedCount: 0,
      missing,
    };
  }

  const workingCache = new Map<string, Float32Array>(existingCache);

  // Identify missing chunks
  const missingChunks = allChunks.filter((c) => !workingCache.has(c.hash));

  let newEmbeds = 0;
  if (missingChunks.length > 0) {
    throw new Error(
      `Remote embedding is disabled. ${missingChunks.length} guide chunk(s) are missing from the local cache. This fork does not send guide text to Google.`
    );
  }

  // Prune unused entries from older guide versions or deleted guides only if explicitly requested
  let targetCache: Map<string, Float32Array>;
  let prunedCount = 0;
  if (options.prune) {
    const activeCache = new Map<string, Float32Array>();
    for (const chunk of allChunks) {
      const vec = workingCache.get(chunk.hash);
      if (vec) activeCache.set(chunk.hash, vec);
    }
    prunedCount = workingCache.size - activeCache.size;
    targetCache = activeCache;
  } else {
    targetCache = workingCache;
    prunedCount = 0;
  }

  if (newEmbeds > 0 || prunedCount > 0 || options.force) {
    const saveStats = saveChunkCache(targetCache, cacheDir);
    console.log(
      `Saved chunk cache to ${cacheDir}: ${saveStats.count} chunks (${(saveStats.bytes / 1024).toFixed(1)} KB)`
    );
    if (prunedCount > 0) {
      console.log(`Pruned ${prunedCount} stale chunk entries.`);
    }
  }

  return {
    totalChunks: allChunks.length,
    cachedCount: targetCache.size,
    newEmbeds,
    prunedCount,
    missing: [],
  };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      check: { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      prune: { type: "boolean", default: false },
      "cache-dir": { type: "string" },
    },
  });

  const res = await embedGuideChunks({
    check: values.check,
    force: values.force,
    prune: values.prune,
    cacheDir: values["cache-dir"],
  });

  if (values.check) {
    if (res.missing.length > 0) {
      const missingGuides = [...new Set(res.missing.map((c) => c.guideId))];
      console.error(
        `❌ Release check failed: ${res.missing.length} chunk(s) across ${missingGuides.length} guide(s) lack cached teacher vectors:`
      );
      for (const g of missingGuides) {
        console.error(`   - ${g}`);
      }
      console.error(`\nRun 'node src/rag/embed-guide-chunks.ts' to embed them before publishing.`);
      process.exit(1);
    } else {
      console.log(
        `✅ All ${res.totalChunks} guide chunks have valid cached teacher vectors (${TEACHER_MODEL}).`
      );
      process.exit(0);
    }
  }

  console.log(
    `Done! Total chunks: ${res.totalChunks}, newly embedded: ${res.newEmbeds}, active cached: ${res.cachedCount}.`
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    console.error("Error in embed-guide-chunks:", err);
    process.exit(1);
  });
}
