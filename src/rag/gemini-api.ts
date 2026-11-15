/**
 * Client helpers for calling Google Generative Language embedding APIs.
 */

export interface BatchEmbeddingResponse {
  embeddings: Array<{ values: number[] }>;
}

export function isBatchEmbeddingResponse(val: unknown): val is BatchEmbeddingResponse {
  if (typeof val !== "object" || val === null || !("embeddings" in val)) return false;
  const emb = (val as { embeddings: unknown }).embeddings;
  return (
    Array.isArray(emb) &&
    emb.every(
      (item) =>
        typeof item === "object" &&
        item !== null &&
        "values" in item &&
        Array.isArray((item as { values: unknown }).values)
    )
  );
}

export async function postWithRetry(_url: string, _body: unknown): Promise<unknown> {
  throw new Error('Remote Gemini embedding is disabled. This fork does not upload text to Google.');
}
