export interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
  }>;
}

/**
 * Shared transport helper to invoke Gemini for markdown bullets with runtime validation and retries.
 */
async function callGeminiForBullets(_opts: {
  prompt: string;
  apiKey: string;
  model: string;
  validate: (bullets: string[]) => boolean;
  validationErrorMsg?: (count: number) => string;
  expectedItems?: string[];
  maxRetries?: number;
}): Promise<string[] | null> {
  throw new Error('Remote Gemini release notes are disabled. This fork does not upload diffs to Google.');
}

interface BuildGuideSummaryPromptOptions {
  type: 'new' | 'updated';
  guideNames: string[];
  guideDiff: string;
}

function buildGuideSummaryPrompt({ type, guideNames, guideDiff }: BuildGuideSummaryPromptOptions): string {
  const isNew = type === 'new';
  const label = isNew ? 'newly introduced guides' : 'updated guidance';
  const sectionHeader = isNew ? 'New Guides to Summarize' : 'Updated Guides to Summarize';
  const targetDesc = isNew ? 'new guide listed above' : 'updated guide listed above';
  const contentDesc = isNew
    ? 'what the new guide introduces and what use case or problem it solves'
    : 'key improvements, best practices, or platform evolutions added to the guide';
  const boldExample = isNew
    ? `* Introduced a new guide for **state-aware-sticky-headers** detailing how to build UI headers that react to scroll changes.`
    : `* Updated the **translator** guide to require accessing the API exclusively via the global \`Translator\` interface.`;
  const focusDesc = isNew ? 'developer guidance and use cases' : 'developer guidance and API patterns';

  return `You are writing concise release note bullet points for ${label} in GoogleChrome/modern-web-guidance.

### ${sectionHeader} (${guideNames.length} total):
${guideNames.map(g => `- ${g.endsWith('-skill') ? `${g.slice(0, -'-skill'.length)} skill` : g}`).join('\n')}

### Content Diff:
${guideDiff}

### Core Formatting Rules:
1. Output exactly ${guideNames.length} Markdown bullet points (starting with '* ' or '- '), one for each ${targetDesc}.
2. Each bullet must describe ${contentDesc} in a single concise sentence or short paragraph.
3. Keep each bullet point on a single line without manual line breaks.
4. Bold the guide identifier or skill name in each bullet using Markdown bold syntax (e.g., "* Updated the **modern-web-guidance** skill to..." or "${boldExample}").
5. NEVER use nested sub-bullets or multiple bullet points for a single guide.
6. Do NOT mention Baseline status or browser compatibility updates (these are tracked separately in the Browser Support section). Focus on substantive ${focusDesc}.
7. Do NOT include headings, sections, benchmark tables, code blocks, or preamble. Output ONLY the ${guideNames.length} bullet points.`;
}

/**
 * Uses Gemini to generate bullet summaries for newly added guides.
 */
export async function generateNewGuideSummariesWithGemini(opts: {
  guideDiff: string;
  guideNames: string[];
  apiKey: string;
  model: string;
}): Promise<string[] | null> {
  const { guideDiff, guideNames, apiKey, model } = opts;
  if (!guideDiff.trim() || guideNames.length === 0) {
    return [];
  }

  const prompt = buildGuideSummaryPrompt({
    type: 'new',
    guideNames,
    guideDiff,
  });

  return callGeminiForBullets({
    prompt,
    apiKey,
    model,
    expectedItems: guideNames,
    validate: (bullets) => bullets.length === guideNames.length,
    validationErrorMsg: (count) =>
      `Gemini new guide summary validation failed: expected ${guideNames.length} bullets, received ${count}.`,
  });
}

/**
 * Uses Gemini to generate bullet summaries for updated / modified guides.
 */
export async function generateUpdatedGuideSummariesWithGemini(opts: {
  guideDiff: string;
  guideNames: string[];
  apiKey: string;
  model: string;
}): Promise<string[] | null> {
  const { guideDiff, guideNames, apiKey, model } = opts;
  if (!guideDiff.trim() || guideNames.length === 0) {
    return [];
  }

  const prompt = buildGuideSummaryPrompt({
    type: 'updated',
    guideNames,
    guideDiff,
  });

  return callGeminiForBullets({
    prompt,
    apiKey,
    model,
    expectedItems: guideNames,
    validate: (bullets) => bullets.length === guideNames.length,
    validationErrorMsg: (count) =>
      `Gemini updated guide summary validation failed: expected ${guideNames.length} bullets, received ${count}.`,
  });
}

/**
 * Uses Gemini to generate bullet summaries for agent ecosystem / plugin changes.
 */
export async function generateEcosystemSummariesWithGemini(opts: {
  pluginDiff: string;
  pluginFiles: string[];
  apiKey: string;
  model: string;
}): Promise<string[] | null> {
  const { pluginDiff, pluginFiles, apiKey, model } = opts;
  if (!pluginDiff.trim() || pluginFiles.length === 0) {
    return [];
  }

  const prompt = `You are writing concise release note bullet points for agent ecosystem and plugin marketplace changes in GoogleChrome/modern-web-guidance.

### Changed Plugin Files:
${pluginFiles.map(p => `- ${p}`).join('\n')}

### Agent Plugin Diff / Changes:
${pluginDiff}

### Core Formatting Rules:
1. Output concise Markdown bullet points (starting with '* ' or '- ') describing what was added or updated across the affected agent platforms, IDEs, or marketplaces.
2. Bold the specific name of each target agent platform, IDE, or marketplace (e.g., **GitHub Copilot**, **Claude Code**, **Cursor**, **Grok**, **Gemini CLI**) derived from the plugin directory or manifest, rather than the generic package name.
3. Output at least 1 and at most ${pluginFiles.length} bullet points.
4. Do NOT mention rote version bumps.
5. Keep each bullet point on a single line without manual line breaks.
6. Do NOT include headings, sections, or preamble. Output ONLY the bullet points.`;

  return callGeminiForBullets({
    prompt,
    apiKey,
    model,
    expectedItems: pluginFiles,
    validate: (bullets) => bullets.length > 0 && bullets.length <= pluginFiles.length,
    validationErrorMsg: (count) =>
      `Gemini ecosystem summary validation failed: received ${count} bullets for ${pluginFiles.length} plugin files.`,
  });
}
