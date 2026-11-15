import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { marked, type Tokens } from "marked";
import { extractH1Heading } from "../../core/guide-validation.ts";
import { outDir, rootDir } from "../../core/paths.ts";
import { isEnoent } from "../../harness/lib/agent-shared.ts";
import { buildBm25Index, rankBm25 } from "../bm25.ts";
import { dotProduct, loadVectors, type EmbedderLike, type UseCaseVector } from "../search.ts";
import { StaticEmbedder } from "../static-embedder.ts";
import { computeEmbedderHash } from "./bench-rag.ts";
import {
  isRecord,
  parseQrelsJsonl,
  parseQueriesJsonl,
  serializeQrelsJsonl,
  type QrelRecord,
  type QueryRecord,
} from "./dataset.ts";
import {
  DEFAULT_JUDGE_MODEL,
  RUBRIC_VERSION,
  type GuideCard,
  type ParsedJudgment,
} from "./judge-prompts.ts";

export const DEFAULT_POOL_DEPTH = 10;
export const DEFAULT_CONCURRENCY = 8;
export const MAX_HEADINGS_PER_CARD = 24;
export const MAX_BATCH_REQUESTS = 400;
const BOILERPLATE_HEADING_RE = /^(?:table of contents|guidelines|code examples?|dos|don'ts|dos and don'ts)$/i;

export function extractCardHeadings(body: string, maxHeadings = MAX_HEADINGS_PER_CARD): string[] {
  // Parse rather than regex so `##` lines inside fenced code examples aren't mistaken for headings.
  const all = marked
    .lexer(body)
    .filter((t): t is Tokens.Heading => t.type === "heading" && (t.depth === 2 || t.depth === 3))
    .map((t) => ({ level: t.depth, text: t.text.trim() }))
    .filter((h) => !BOILERPLATE_HEADING_RE.test(h.text));

  if (all.length <= maxHeadings) {
    return all.map((h) => h.text);
  }
  const h2s = all.filter((h) => h.level === 2).map((h) => h.text);
  const h3s = all.filter((h) => h.level === 3).map((h) => h.text);
  return [...h2s, ...h3s].slice(0, maxHeadings);
}

export interface CorpusForPooling {
  cards: Map<string, GuideCard>;
  vectors: UseCaseVector[];
  bm25: ReturnType<typeof buildBm25Index>;
}

export function loadCorpusForPooling(buildDir = path.join(outDir, "build/skills-cli")): CorpusForPooling {
  const guidesJsonPath = path.join(buildDir, "gen/guides.json");
  const guidesDir = path.join(buildDir, "guides");

  const metaRaw: unknown = JSON.parse(fs.readFileSync(guidesJsonPath, "utf8"));
  if (!Array.isArray(metaRaw)) {
    throw new Error(`Invalid guides.json at ${guidesJsonPath}`);
  }

  const cards = new Map<string, GuideCard>();
  const bm25Docs: { id: string; text: string }[] = [];

  for (const item of metaRaw) {
    if (!isRecord(item) || typeof item.id !== "string" || typeof item.description !== "string" || typeof item.category !== "string") {
      throw new Error(`Invalid entry in ${guidesJsonPath}`);
    }
    const mdPath = path.join(guidesDir, item.category, `${item.id}.md`);
    const body = fs.readFileSync(mdPath, "utf8");
    const title = extractH1Heading(body) ?? item.id;
    const headings = extractCardHeadings(body);
    cards.set(item.id, {
      id: item.id,
      title,
      description: item.description,
      category: item.category,
      headings,
    });
    // Weight title and description 2x in the pooling BM25 index so header terms surface strongly in the candidate pool
    bm25Docs.push({
      id: item.id,
      text: `${title} ${title} ${item.description} ${item.description} ${body}`,
    });
  }

  const vectors = loadVectors(buildDir);
  for (const v of vectors) {
    if (!cards.has(v.id)) {
      throw new Error(`Vector entry "${v.id}" does not match any guide in ${guidesJsonPath}`);
    }
  }

  return { cards, vectors, bm25: buildBm25Index(bm25Docs) };
}

/**
 * Pools candidate guide IDs for a query by taking the union of top-K from:
 * 1) Dense max-chunk cosine similarity
 * 2) Dense mean-chunk cosine similarity
 * 3) Whole-guide Okapi BM25
 * plus `expectedGuide` (if present in the corpus) and any `extraCandidates`.
 */
export function poolQueryCandidates(
  query: string,
  queryVector: number[],
  corpus: CorpusForPooling,
  options: { poolDepth?: number; expectedGuide?: string; extraCandidates?: Iterable<string> } = {}
): string[] {
  const k = options.poolDepth ?? DEFAULT_POOL_DEPTH;
  const perGuideScores = new Map<string, number[]>();

  for (const item of corpus.vectors) {
    if (item.vector.length === 0) continue;
    const sim = dotProduct(queryVector, item.vector);
    const list = perGuideScores.get(item.id);
    if (list) list.push(sim);
    else perGuideScores.set(item.id, [sim]);
  }

  const denseStats = Array.from(perGuideScores, ([id, sims]) => ({
    id,
    max: Math.max(...sims),
    mean: sims.reduce((a, b) => a + b, 0) / sims.length,
  }));

  const topMax = [...denseStats].sort((a, b) => b.max - a.max).slice(0, k).map((x) => x.id);
  const topMean = [...denseStats].sort((a, b) => b.mean - a.mean).slice(0, k).map((x) => x.id);
  const topBm25 = rankBm25(corpus.bm25, query).slice(0, k).map((x) => x.id);

  const candidates = new Set<string>([...topMax, ...topMean, ...topBm25]);
  if (options.expectedGuide && corpus.cards.has(options.expectedGuide)) {
    candidates.add(options.expectedGuide);
  }
  if (options.extraCandidates) {
    for (const id of options.extraCandidates) {
      if (corpus.cards.has(id)) candidates.add(id);
    }
  }
  return [...candidates];
}

function readEmbeddingCache(cachePath: string): Record<string, number[]> {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    if (!isRecord(raw)) return {};
    const out: Record<string, number[]> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (Array.isArray(v)) out[k] = v.map((n) => Number(n));
    }
    return out;
  } catch (err) {
    if (isEnoent(err)) return {};
    throw err;
  }
}

export async function embedQueriesWithCache(
  queries: string[],
  cachePath = path.join(outDir, "benchmarks", `embed-cache-${computeEmbedderHash(rootDir)}.json`),
  embedder?: EmbedderLike
): Promise<Map<string, number[]>> {
  const cache = readEmbeddingCache(cachePath);
  const actualEmbedder = embedder ?? StaticEmbedder.getInstance();
  const result = new Map<string, number[]>();
  let dirty = false;

  for (const query of queries) {
    let vector = cache[query];
    if (!Array.isArray(vector)) {
      vector = await actualEmbedder.embed(query);
      cache[query] = vector;
      dirty = true;
    }
    result.set(query, vector);
  }

  if (dirty) {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(cache));
  }
  return result;
}

function loadGeminiConfig(): { apiKey: string; model: string } {
  try {
    process.loadEnvFile(path.join(rootDir, ".env"));
  } catch {
    // .env is optional if environment variables are already set
  }
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is required in .env or environment to run the LLM judge");
  }
  const model = process.env.GEMINI_MODEL?.trim() || DEFAULT_JUDGE_MODEL;
  return { apiKey, model };
}

async function judgeSingleLive(
  query: string,
  candidates: GuideCard[],
  apiKey: string,
  model: string,
  existing?: QrelRecord
): Promise<ParsedJudgment> {
  void query;
  void candidates;
  void apiKey;
  void model;
  void existing;
  throw new Error('Remote Gemini judging is disabled. This fork does not upload queries or guides.');
}

async function judgeChunkBatch(
  _items: { qid: string; query: string; candidates: GuideCard[]; existing?: QrelRecord }[],
  _apiKey: string,
  _model: string,
  _displayLabel: string
): Promise<Map<string, ParsedJudgment>> {
  throw new Error('Remote Gemini batch judging is disabled. This fork does not upload queries or guides.');
}

function mergeJudgmentRecord(
  item: { qid: string; query: string; existing?: QrelRecord },
  judgment: ParsedJudgment,
  model: string
): QrelRecord {
  return {
    qid: item.qid,
    query: item.query,
    scope: item.existing?.scope ?? judgment.scope,
    needs: item.existing?.needs.length ? item.existing.needs : judgment.needs,
    grades: [...(item.existing?.grades ?? []), ...judgment.grades],
    judgeModel: model,
    rubricVersion: RUBRIC_VERSION,
  };
}

export interface JudgeFillOptions {
  model?: string;
  batch?: boolean;
  concurrency?: number;
  poolDepth?: number;
  extraCandidatesByQid?: Map<string, Iterable<string>>;
}

/**
 * Ensures every query in `queries` has relevance judgments in `existingQrels` for all pooled
 * (and optional extra) candidate guides. Judges only the missing candidate cards and returns
 * the updated `Map<string, QrelRecord>`.
 */
export async function fillJudgmentsForDataset(
  queries: QueryRecord[],
  existingQrels: Map<string, QrelRecord>,
  corpus: CorpusForPooling,
  options: JudgeFillOptions = {}
): Promise<{ qrels: Map<string, QrelRecord>; judgedCount: number }> {
  const vectorsByQuery = await embedQueriesWithCache(queries.map((q) => q.query));
  const pending: { qid: string; query: string; candidates: GuideCard[]; existing?: QrelRecord }[] = [];

  for (const q of queries) {
    const queryVector = vectorsByQuery.get(q.query);
    if (!queryVector) throw new Error(`Missing embedding for query "${q.query}"`);
    const pooledIds = poolQueryCandidates(q.query, queryVector, corpus, {
      poolDepth: options.poolDepth,
      expectedGuide: q.expectedGuide,
      extraCandidates: options.extraCandidatesByQid?.get(q.qid),
    });

    const existing = existingQrels.get(q.qid);
    const alreadyGraded = new Set(existing?.grades.map((g) => g.id) ?? []);
    const missingIds = pooledIds.filter((id) => !alreadyGraded.has(id));

    if (!existing || missingIds.length > 0) {
      const cards = missingIds.map((id) => {
        const card = corpus.cards.get(id);
        if (!card) throw new Error(`Missing guide card for "${id}"`);
        return card;
      });
      if (cards.length > 0) {
        pending.push({ qid: q.qid, query: q.query, candidates: cards, existing });
      }
    }
  }

  if (pending.length === 0) {
    return { qrels: new Map(existingQrels), judgedCount: 0 };
  }

  const { apiKey, model: defaultModel } = loadGeminiConfig();
  const model = options.model ?? defaultModel;
  const updated = new Map(existingQrels);

  if (options.batch) {
    for (let i = 0; i < pending.length; i += MAX_BATCH_REQUESTS) {
      const chunk = pending.slice(i, i + MAX_BATCH_REQUESTS);
      const batchJudgments = await judgeChunkBatch(chunk, apiKey, model, `rag-judge-${i}`);
      for (const item of chunk) {
        const judgment = batchJudgments.get(item.qid);
        if (!judgment) throw new Error(`Batch output missing qid "${item.qid}"`);
        updated.set(item.qid, mergeJudgmentRecord(item, judgment, model));
      }
    }
  } else {
    const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
    let nextIdx = 0;
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        while (nextIdx < pending.length) {
          const item = pending[nextIdx++];
          const judgment = await judgeSingleLive(item.query, item.candidates, apiKey, model, item.existing);
          updated.set(item.qid, mergeJudgmentRecord(item, judgment, model));
        }
      })
    );
  }

  return { qrels: updated, judgedCount: pending.length };
}

export async function fillMissingJudgmentsInFiles(
  queriesPath: string,
  qrelsPath: string,
  options: JudgeFillOptions = {}
): Promise<number> {
  const queries = parseQueriesJsonl(fs.readFileSync(queriesPath, "utf8"), queriesPath);
  let existingQrels = new Map<string, QrelRecord>();
  try {
    existingQrels = parseQrelsJsonl(fs.readFileSync(qrelsPath, "utf8"), qrelsPath);
  } catch (err) {
    if (!isEnoent(err)) throw err;
  }

  const corpus = loadCorpusForPooling();
  const { qrels, judgedCount } = await fillJudgmentsForDataset(queries, existingQrels, corpus, options);
  if (judgedCount > 0) {
    const ordered = queries.map((q) => qrels.get(q.qid)).filter((r): r is QrelRecord => r !== undefined);
    const tmpPath = `${qrelsPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, serializeQrelsJsonl(ordered));
    fs.renameSync(tmpPath, qrelsPath);
  }
  return judgedCount;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values, positionals } = parseArgs({
    options: {
      batch: { type: "boolean", default: false },
      model: { type: "string" },
    },
    allowPositionals: true,
  });
  const [queriesPath, qrelsPath] = positionals;
  if (!queriesPath || !qrelsPath) {
    throw new Error("Usage: node src/rag/benchmarks/judge-fill.ts <queries.jsonl> <qrels.jsonl> [--batch] [--model=...]");
  }
  const count = await fillMissingJudgmentsInFiles(queriesPath, qrelsPath, {
    batch: values.batch,
    model: values.model,
  });
  console.log(`Judged ${count} queries into ${qrelsPath}`);
}
