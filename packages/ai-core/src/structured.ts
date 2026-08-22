import type { z } from 'zod';

/**
 * Getting structured data out of a model that has no structured-output mode.
 *
 * JSON mode, tool calling and grammar constraints are all unavailable on much
 * of what this framework is pointed at, so the only portable approach is to
 * ask for JSON in the prompt and parse defensively. In practice models wrap it
 * in a code fence, prefix it with "Sure, here's the JSON:", append an
 * explanation, or emit trailing commas — so each of those is handled explicitly
 * rather than hoped away.
 */

export interface ParseSuccess<T> {
  ok: true;
  value: T;
  /** Which extraction strategy worked. Useful for spotting a degrading model. */
  strategy: 'direct' | 'fence' | 'braces' | 'repaired';
}

export interface ParseFailure {
  ok: false;
  /** Human-readable reason, safe to feed back to the model as a repair hint. */
  error: string;
  /** Candidates that were tried, for logging. */
  attempted: number;
}

export type ParseResult<T> = ParseSuccess<T> | ParseFailure;

/** Strips a ```json ... ``` fence if present. */
function fromFence(text: string): string | null {
  const m = text.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
  return m && m[1] ? m[1].trim() : null;
}

/**
 * Extracts the outermost balanced {...} or [...] span, tracking string state so
 * a brace inside a string literal does not end the span early. A naive
 * greedy regex gets this wrong whenever the payload contains a brace in text.
 */
function fromBraces(text: string): string | null {
  const start = text.search(/[{[]/);
  if (start === -1) return null;

  const open = text[start] as '{' | '[';
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** Removes trailing commas, which smaller models produce constantly. */
function repairCommon(text: string): string {
  return text.replace(/,(\s*[}\]])/g, '$1');
}

function candidates(text: string): Array<{ raw: string; strategy: ParseSuccess<unknown>['strategy'] }> {
  const out: Array<{ raw: string; strategy: ParseSuccess<unknown>['strategy'] }> = [];
  const trimmed = text.trim();
  if (trimmed) out.push({ raw: trimmed, strategy: 'direct' });

  const fenced = fromFence(text);
  if (fenced) out.push({ raw: fenced, strategy: 'fence' });

  const braced = fromBraces(text);
  if (braced) out.push({ raw: braced, strategy: 'braces' });

  // Repairs are tried last so a clean parse always wins.
  for (const c of [...out]) {
    const repaired = repairCommon(c.raw);
    if (repaired !== c.raw) out.push({ raw: repaired, strategy: 'repaired' });
  }
  return out;
}

/**
 * Parses `text` into `schema`, trying progressively more forgiving extraction.
 *
 * Never throws — a model producing garbage is an expected condition here, not
 * an exceptional one, and every caller has a deterministic fallback to take.
 */
export function parseStructured<T>(text: string, schema: z.ZodType<T>): ParseResult<T> {
  const tried = candidates(text);
  let lastError = 'no JSON-looking content found in the response';

  for (const { raw, strategy } of tried) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      lastError = `invalid JSON: ${(err as Error).message}`;
      continue;
    }
    const result = schema.safeParse(parsed);
    if (result.success) return { ok: true, value: result.data, strategy };

    lastError = result.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
  }

  return { ok: false, error: lastError, attempted: tried.length };
}

/**
 * Builds a follow-up prompt asking the model to fix its own output.
 *
 * One repair attempt only. If a model cannot produce valid output twice in a
 * row, more attempts mostly buy latency and quota, and the caller should fall
 * through to its deterministic path instead.
 */
export function buildRepairPrompt(originalText: string, error: string): string {
  const excerpt = originalText.length > 1500 ? `${originalText.slice(0, 1500)}\n...[truncated]` : originalText;
  return (
    'Your previous response could not be parsed.\n\n' +
    `Problem: ${error}\n\n` +
    `Your previous response was:\n${excerpt}\n\n` +
    'Reply with ONLY the corrected JSON object. No code fence, no explanation, ' +
    'no text before or after it.'
  );
}
