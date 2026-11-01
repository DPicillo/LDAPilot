/**
 * Pure helpers of the AI settings form. Type-only imports, so Node's test
 * runner loads this file directly (tests/ai/composer.test.mjs).
 */
import type { AIConfig } from '../types/ai';

const MAP_KEYS = new Set(['connectionAccess', 'connectionNotes', 'claudeCode']);

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * The user's unsaved changes (draft against base, the config the form was
 * opened with) applied to fresh, the config that was saved elsewhere in the
 * meantime (A-35: "Reload" threw the draft away). Per connection for the
 * access levels and notes, per field elsewhere; the draft wins where both
 * changed the same thing. The result carries fresh's revision.
 */
export function mergeSettingsDraft(base: AIConfig, draft: AIConfig, fresh: AIConfig): AIConfig {
  const out: Record<string, unknown> = { ...fresh };
  const b = base as unknown as Record<string, unknown>;
  const d = draft as unknown as Record<string, unknown>;
  const keys = new Set([...Object.keys(b), ...Object.keys(d)]);
  for (const k of keys) {
    if (k === 'revision' || k === 'hasKey' || k === 'keyError' || k === 'warnings') continue;
    if (same(b[k], d[k])) continue;
    if (MAP_KEYS.has(k)) {
      const bm = (b[k] ?? {}) as Record<string, unknown>;
      const dm = (d[k] ?? {}) as Record<string, unknown>;
      const merged: Record<string, unknown> = { ...((out[k] ?? {}) as Record<string, unknown>) };
      for (const mk of new Set([...Object.keys(bm), ...Object.keys(dm)])) {
        if (same(bm[mk], dm[mk])) continue;
        if (dm[mk] === undefined) delete merged[mk];
        else merged[mk] = dm[mk];
      }
      out[k] = merged;
      continue;
    }
    if (d[k] === undefined) delete out[k];
    else out[k] = d[k];
  }
  out.revision = fresh.revision;
  return out as unknown as AIConfig;
}

/**
 * "Reload" in the stale settings banner (A-35): the draft merged onto fresh
 * against `base`, the config the draft was cloned from. Without a recorded
 * base the store's config stands in, which the ai:config event has usually
 * already replaced with fresh (P2: every draft field then counted as the
 * user's change, so an "Always allow read" granted in a chat came back as
 * "ask" and the next Save undid it). The merged draft's base is fresh.
 */
export function reloadSettingsDraft(draft: AIConfig, base: AIConfig | undefined, saved: AIConfig, fresh: AIConfig): { draft: AIConfig; base: AIConfig } {
  return { draft: mergeSettingsDraft(base ?? saved, draft, fresh), base: fresh };
}

/** Whether listing the models needs an API key that is not there (A-32: no 401 before a key is entered). */
export function discoveryNeedsKey(cfg: Pick<AIConfig, 'engine' | 'provider' | 'flavor'>, haveKey: boolean): boolean {
  if (cfg.engine === 'claudecode' || haveKey) return false;
  return cfg.provider === 'anthropic' || (cfg.provider === 'openai' && (cfg.flavor || 'custom') === 'openai');
}
