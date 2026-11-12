// Where the Claude Code CLI runs (AI settings, Claude Code engine). Pure
// helpers, node-tested (tests/ai/claudecode.test.mjs): type-only imports.
import type { ClaudeCodeLocation, WSLStatus } from '../types/ai';

export interface Option {
  value: string;
  label: string;
}

/** ClaudeCodeConfig.runtime choices (Windows only). */
export const CC_RUNTIMES: readonly Option[] = [
  { value: '', label: 'Automatic' },
  { value: 'windows', label: 'Windows' },
  { value: 'wsl', label: 'WSL' },
];

/** What each choice does (hint below the control). */
export function ccRuntimeHint(runtime: string): string {
  switch (runtime) {
    case 'windows':
      return 'Only a Claude Code installed in Windows is used.';
    case 'wsl':
      return 'Claude Code inside a WSL distribution, with its own login there (run claude once in that distribution). LDAPilot connects it to its tools through LDAPilot.exe on this computer; nothing listens outside its loopback.';
    default:
      return 'A Claude Code installed in Windows is used; without one, LDAPilot looks in WSL (the default distribution first).';
  }
}

/** The distribution choices: the default one, the installed ones, and a
 * configured one that is no longer installed (kept, marked). */
export function distroOptions(wsl: WSLStatus | undefined, current: string): Option[] {
  const distros = wsl?.distros ?? [];
  const def = distros.find((d) => d.default);
  const out: Option[] = [{ value: '', label: def ? `Default distribution (${def.name})` : 'Default distribution' }];
  for (const d of distros) out.push({ value: d.name, label: d.version ? `${d.name} · WSL ${d.version}` : d.name });
  if (current && !distros.some((d) => d.name === current)) out.push({ value: current, label: `${current} (not installed)` });
  return out;
}

/** "Found: …" line for the place discovery found the CLI. */
export function locationText(loc: ClaudeCodeLocation | undefined, os: string): string {
  if (!loc) return '';
  if (loc.runtime === 'wsl') {
    const where = `WSL${loc.wslVersion ? ' ' + loc.wslVersion : ''}${loc.distro ? ' · ' + loc.distro : ''}`;
    const env = loc.envSource === 'login' ? ' (environment of the login shell)' : loc.envSource === 'plain' ? ' (environment of /bin/sh: the login shell did not answer)' : '';
    return `Found in ${where}: ${loc.path}${env}`;
  }
  return os === 'windows' ? `Found in Windows: ${loc.path}` : `Found: ${loc.path}`;
}

/** The hint of "Use my environment's Anthropic settings": in WSL the
 * variables come from the login shell in the distribution. */
export function anthropicEnvHint(inWSL: boolean): string {
  const vars = 'ANTHROPIC_* and the Claude Code login/backend variables (CLAUDE_CODE_OAUTH_TOKEN, CLAUDE_CODE_USE_BEDROCK/VERTEX/FOUNDRY, CLAUDE_CODE_SKIP_*_AUTH)';
  return inWSL
    ? `Passes ${vars} of your login shell in WSL to Claude Code. Off: only a \`claude login\` session in that distribution works.`
    : `Passes ${vars} to Claude Code. Off: only a \`claude login\` session works.`;
}
