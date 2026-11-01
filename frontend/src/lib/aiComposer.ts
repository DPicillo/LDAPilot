/**
 * Pure helpers of the AI composer and its commands (UX A-05, A-14, A-15,
 * A-33). Type-only imports, so Node's test runner loads this file directly
 * (tests/ai/composer.test.mjs).
 */
import type { ModelInfo } from '../types/ai';

/** A standalone "@" (the mention trigger without a pick) is never sent (A-14). */
export function stripBareAt(text: string): string {
  return text.replace(/(^|\s)@(?=\s|$)/g, '$1').trim();
}

export type ModelCheck =
  | { ok: true; id: string }
  | { ok: false; suggestions: string[] }
  /** no model list to check against (discovery failed or not available) */
  | { ok: 'unknown'; id: string };

/**
 * Checks a model ID typed after /model against the discovered models
 * (A-15: "/model gpt-nonexistent" was accepted). Case is ignored, and an
 * Ollama name without a tag means ":latest". Claude Code also takes full
 * "claude-…" model IDs that its alias list does not show.
 */
export function checkModelId(input: string, models: ModelInfo[] | undefined, engine: string): ModelCheck {
  const id = input.trim();
  if (!models || models.length === 0) return { ok: 'unknown', id };
  const lower = id.toLowerCase();
  const exact = models.find((m) => m.id === id) ?? models.find((m) => m.id.toLowerCase() === lower);
  if (exact) return { ok: true, id: exact.id };
  if (!id.includes(':')) {
    const latest = models.find((m) => m.id.toLowerCase() === lower + ':latest');
    if (latest) return { ok: true, id: latest.id };
  }
  if (engine === 'claudecode' && /^claude-[a-z0-9.-]+$/i.test(id)) return { ok: true, id };
  const near = models.filter((m) => {
    const x = m.id.toLowerCase();
    return x.includes(lower) || lower.includes(x.split(':')[0]);
  });
  return { ok: false, suggestions: (near.length ? near : models).slice(0, 5).map((m) => m.id) };
}

/** The model the settings form preselects: the only one, or the only one with tools (A-33). */
export function soleModel(models: ModelInfo[] | null | undefined): string | null {
  const list = models ?? [];
  if (list.length === 1) return list[0].id;
  const usable = list.filter((m) => m.tools !== 'no');
  return usable.length === 1 ? usable[0].id : null;
}

/** "Test Smartcard, Test Stale" — the entries Ask AI could not add (A-05). */
export function droppedNames(labels: string[], max: number): string {
  const rest = labels.slice(max);
  if (rest.length <= 3) return rest.join(', ');
  return `${rest.slice(0, 3).join(', ')} and ${rest.length - 3} more`;
}

/**
 * The title of "Ask AI about …" for n selected entries: "This User" (the
 * kind label in title case), "These 3 Entries", "the First 5 of 22
 * Entries" (more than `max`; DEFERRED: 22 result rows once read "These 5
 * Entries"), plus " (no AI access)" for a connection at access None.
 */
export function askAITitleText(n: number, kindLabel: string, max: number, noAccess: boolean): string {
  const suffix = noAccess ? ' (no AI access)' : '';
  if (n > max) return `Ask AI about the First ${max} of ${n} Entries${suffix}`;
  if (n > 1) return `Ask AI about These ${n} Entries${suffix}`;
  // Title case in a menu title ("This Organizational Unit", not "…unit").
  const label = (kindLabel || 'Entry').replace(/\b[a-z]/g, (c) => c.toUpperCase());
  return `Ask AI about This ${label}${suffix}`;
}

/** The new composer text after Esc in the @ list: a bare "@" before the caret goes (with the space the @ button added). */
export function dropBareAt(text: string, caret: number): { text: string; caret: number } | null {
  const before = text.slice(0, caret);
  if (!/(^|\s)@$/.test(before)) return null;
  const kept = before.replace(/(\S) @$/, '$1').replace(/@$/, '');
  return { text: kept + text.slice(caret), caret: kept.length };
}
