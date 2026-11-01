/**
 * TypeScript mirror of the AI harness types (Go: internal/ai, internal/config
 * ai_config.go). JSON on the wire is camelCase. Optional fields are Go
 * `omitempty` fields; `| null` marks Go slices, maps and pointers that may be
 * nil on the wire.
 *
 * Drift guard: ai.contract.ts checks ai.events.golden.json (written by
 * internal/ai/event_contract_test.go) against these types at compile time.
 *
 * Only type declarations live here (no runtime code), so lib/aiReducer.ts can
 * import it with `import type` and run under Node's type stripping.
 */

// --- messages ---------------------------------------------------------------

export type Role = 'user' | 'assistant';
export type BlockType = 'text' | 'thinking' | 'redacted_thinking' | 'tool_use' | 'tool_result';

export interface ApprovalRecord {
  decision: string;
  by: string;
  at: number;
  previewHash?: string;
  grantId?: string;
}

export interface BlockMeta {
  /** "context" | "summary" | "continue" | "read" | "write" | "access" | "stopped" | "error" (marker answers) */
  kind?: string;
  connectionId?: string;
  connectionLabel?: string;
  durationMs?: number;
  summary?: string;
  errorCode?: string;
  warnings?: string[];
  approval?: ApprovalRecord;
  synthetic?: boolean;
  dns?: string[];
  rawArgs?: string;
  executing?: boolean;
  executingSince?: number;
  clearedAt?: number;
  shrunk?: string;
  /** provider host an @entry mention allowed this read for */
  consentHost?: string;
}

export interface Block {
  type: BlockType;
  text?: string;
  thinking?: string;
  signature?: string;
  data?: string;
  producer?: string;
  /** tool_use: harness toolCallId */
  id?: string;
  providerCallId?: string;
  name?: string;
  /** tool_use: always a JSON object */
  input?: Record<string, unknown>;
  /** tool_result → harness toolCallId */
  toolUseId?: string;
  /** tool_result: the exact string the model first saw */
  content?: string;
  isError?: boolean;
  meta?: BlockMeta;
}

export type StopReason =
  | 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'context_exceeded'
  | 'stop_sequence' | 'cancelled' | 'error' | 'unknown';

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  costUsd?: number;
}

export interface Mention {
  profileId: string;
  dn: string;
}

export interface UIContext {
  activeProfileId: string;
  selectedDn: string;
  selectedProfileId: string;
  mentions: Mention[] | null;
  locale: string;
  timeZone: string;
}

export interface RunError {
  code: string;
  message: string;
  retryable: boolean;
  status?: number;
  requestId?: string;
}

export interface Message {
  id: string;
  role: Role;
  blocks: Block[] | null;
  createdAt: number;
  runId?: string;
  provider?: string;
  model?: string;
  stopReason?: StopReason;
  usage?: Usage;
  partial?: boolean;
  truncated?: boolean;
  error?: RunError;
  uiContext?: UIContext;
}

// --- chats ------------------------------------------------------------------

export interface ChatSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  model: string;
  usage: Usage;
  running: boolean;
  corrupt: boolean;
  pendingWrite: boolean;
  note?: string;
}

export interface CompactionMarker {
  id: string;
  at: number;
  summaryMessageId: string;
  upToMessageId: string;
  tokensBefore: number;
  tokensAfter: number;
  summary: string;
  model?: string;
  chunks?: number;
  /** profiles whose data the summary may contain (withheld from destinations that may not see them) */
  connections?: string[];
}

export interface EgressRecord {
  profileId: string;
  providerHost: string;
  remote: boolean;
  toolResults: number;
  bytes: number;
  firstAt: number;
  lastAt: number;
}

export interface ChatView extends ChatSummary {
  modelOverride: string;
  messages: Message[];
  compactions: CompactionMarker[];
  egress: EgressRecord[];
  /** a second LDAPilot instance holds the chat store */
  readOnly: boolean;
}

// --- runs, approvals, grants -----------------------------------------------

export type RunKind = 'send' | 'continue' | 'regenerate' | 'edit' | 'compact';
export type RunStatus =
  | 'queued' | 'running' | 'awaiting_approval'
  | 'completed' | 'cancelled' | 'error' | 'step_limit' | 'truncated' | 'refusal';

export type ToolStatus =
  | 'queued' | 'running' | 'awaiting_approval' | 'finishing_write'
  | 'ok' | 'error' | 'denied' | 'cancelled' | 'not_executed' | 'outcome_unknown';

export type Decision = 'approve' | 'approve_chat' | 'approve_confirmed' | 'approve_always' | 'deny' | 'deny_remaining';
export type ResolvedDecision =
  | 'approved' | 'approved_chat' | 'approved_always' | 'denied' | 'timeout' | 'cancelled' | 'policy_denied';

export interface SendRequest {
  chatId: string;
  text: string;
  ui: UIContext;
}

export interface SendResult {
  runId: string;
  userMessageId: string;
}

export interface Envelope {
  chatId: string;
  runId: string;
  seq: number;
  ts: number;
}

export interface ApprovalConnection {
  profileId: string;
  label: string;
  serverType: string;
  host: string;
  identity: string;
  readOnly: boolean;
  localProvider: boolean;
}

export interface ApprovalPosition {
  index: number;
  total: number;
}

export interface GrantScope {
  tool: string;
  profileId: string;
  subtree?: string;
  groupDn?: string;
  attributes: string[] | null;
  /** unlock | enable | disable */
  action?: string;
  maxUses: number;
  durationMin: number;
  description: string;
}

export interface AttrDiff {
  attribute: string;
  /** add | delete | replace */
  op: string;
  before: string[] | null;
  after: string[] | null;
  values: string[] | null;
}

export interface AttrValue {
  attribute: string;
  values: string[] | null;
}

export interface ChangePreview {
  /** modify|create|rename|delete|group_membership|unlock|enable|disable|reset_password */
  operation: string;
  dn: string;
  newDn?: string;
  ldif: string;
  changes: AttrDiff[] | null;
  entrySummary?: AttrValue[];
  /** medium | high */
  risk: string;
  riskReasons: string[] | null;
  warnings: string[] | null;
  explanation: string;
  beforeHash: string;
  assertion: boolean;
  grantScope?: GrantScope;
  unchanged?: string[];
  /** reset_password: how the password is stored (never a value). */
  password?: PasswordPreview;
}

/** How a password reset stores the password (password track + storage policy, issue #1). */
export interface PasswordPreview {
  /** unicodePwd | exop | userPassword */
  method: string;
  methodLabel: string;
  scheme?: string;
  schemeLabel?: string;
  /** client | server | ask | ad */
  policy: string;
  policySummary: string;
  serverHashes: boolean;
  cleartextOnWire: boolean;
  unencrypted: boolean;
  mustChange: boolean;
  notes: string[] | null;
}

export interface ApprovalRequest extends Envelope {
  approvalId: string;
  toolCallId: string;
  /** write | access */
  kind: string;
  tool: string;
  toolDisplayName: string;
  connection: ApprovalConnection;
  position: ApprovalPosition;
  preview?: ChangePreview;
  providerHost?: string;
  providerRemote?: boolean;
  allowedDecisions: string[];
  requireConfirm: boolean;
  expiresAt: number;
  grantsSuspended?: boolean;
}

export interface ApprovalResult {
  /** applied | already_resolved */
  status: string;
  decision: string;
  by: string;
}

export interface SecretValue {
  kind: string;
  dn: string;
  value: string;
  expiresAt: number;
}

export interface Grant {
  id: string;
  tool: string;
  profileId: string;
  connectionLabel: string;
  scope: string;
  dns: string[] | null;
  subtree: string;
  attributes: string[] | null;
  usesLeft: number;
  expiresAt: number;
}

// --- events (§3.5) ----------------------------------------------------------

export interface RunStartedEvent extends Envelope {
  userMessageId: string;
  kind: RunKind;
  engine: string;
  provider: string;
  model: string;
  startedAt: number;
}

export interface MessageStartedEvent extends Envelope {
  messageId: string;
  step: number;
  /** Claude Code: the model that answers this step */
  model?: string;
}

/** ai:text_delta, ai:thinking_delta, ai:text_replaced (text = full new block text) */
export interface DeltaEvent extends Envelope {
  messageId: string;
  blockIndex: number;
  text: string;
}

export interface StepDiscardedEvent extends Envelope {
  messageId: string;
  /** max_tokens_retry | empty_retry | context_retry | param_retry */
  reason: string;
}

export interface ToolStartEvent extends Envelope {
  messageId: string;
  toolCallId: string;
  name: string;
  displayName: string;
  /** read | write */
  kind: string;
  /** validated JSON, invisible characters escaped */
  args: string;
  connectionId: string;
  connectionLabel: string;
  status: ToolStatus;
  warnings: string[] | null;
}

export interface ToolUpdateEvent extends Envelope {
  toolCallId: string;
  status: ToolStatus;
}

export interface WriteInfo {
  op: string;
  dn: string;
  newDn?: string;
  parentDn?: string;
  profileId: string;
}

export interface ToolEndEvent extends Envelope {
  toolCallId: string;
  status: ToolStatus;
  durationMs: number;
  summary: string;
  /** the exact model-facing JSON */
  result: string;
  isError: boolean;
  errorCode?: string;
  warnings: string[] | null;
  dns: string[] | null;
  write?: WriteInfo;
}

export interface ApprovalResolvedEvent extends Envelope {
  approvalId: string;
  toolCallId: string;
  decision: ResolvedDecision;
  /** user | grant | policy | timeout | run */
  by: string;
}

/** Never carries the secret; RevealSecret pulls it once. */
export interface SecretAvailableEvent extends Envelope {
  toolCallId: string;
  kind: string;
  dn: string;
  expiresAt: number;
}

export interface UsageEvent extends Envelope {
  step: number;
  usage: Usage;
  contextTokens: number;
  contextWindow: number;
  contextPercent: number;
  totals: Usage;
  costUsd?: number;
  /** Claude Code: model turns of the run */
  turns?: number;
}

export type StatusKind =
  | 'retrying' | 'queued' | 'model_loading' | 'processing_prompt' | 'compacting'
  | 'compacted' | 'finishing_write' | 'truncated_output' | 'warning';

export interface StatusEvent extends Envelope {
  kind: StatusKind;
  message: string;
  attempt?: number;
  delayMs?: number;
  param?: string;
}

export interface ErrorEvent extends Envelope {
  code: string;
  message: string;
  retryable: boolean;
  status?: number;
  requestId?: string;
}

export interface DoneEvent extends Envelope {
  status: RunStatus;
  finalMessageId?: string;
  durationMs: number;
  totals: Usage;
  canContinue: boolean;
  contextEdited: boolean;
}

/** no run envelope */
export interface ChatUpdatedEvent {
  chatId: string;
  title?: string;
  updatedAt: number;
  pendingWrite?: boolean;
}

/** no run envelope */
export interface ModelsUpdatedEvent {
  providerKey: string;
  models: ModelInfo[] | null;
  discovery: ModelDiscovery;
}

/** no run envelope */
export interface ConfigUpdatedEvent {
  revision: number;
}

/** no run envelope */
export interface GrantsUpdatedEvent {
  chatId: string;
  grants: Grant[] | null;
}

export interface AIEventMap {
  'ai:run_started': RunStartedEvent;
  'ai:message_started': MessageStartedEvent;
  'ai:text_delta': DeltaEvent;
  'ai:thinking_delta': DeltaEvent;
  'ai:text_replaced': DeltaEvent;
  'ai:step_discarded': StepDiscardedEvent;
  'ai:tool_start': ToolStartEvent;
  'ai:tool_update': ToolUpdateEvent;
  'ai:tool_end': ToolEndEvent;
  'ai:approval_request': ApprovalRequest;
  'ai:approval_resolved': ApprovalResolvedEvent;
  'ai:secret_available': SecretAvailableEvent;
  'ai:usage': UsageEvent;
  'ai:status': StatusEvent;
  'ai:error': ErrorEvent;
  'ai:done': DoneEvent;
  'ai:chat_updated': ChatUpdatedEvent;
  'ai:models_updated': ModelsUpdatedEvent;
  'ai:config_updated': ConfigUpdatedEvent;
  'ai:grants_updated': GrantsUpdatedEvent;
}

export type AIEventName = keyof AIEventMap;

/** Discriminated union of all events as the store receives them. */
export type AIEvent = { [K in AIEventName]: { name: K; payload: AIEventMap[K] } }[AIEventName];

// --- views ------------------------------------------------------------------

export interface RunSnapshot {
  chatId: string;
  runId: string;
  status: RunStatus;
  kind: RunKind;
  startedAt: number;
  lastSeq: number;
  /** last persisted message before the run ("" = the chat was empty) */
  baseMessageId: string;
  /** messages persisted by this run so far */
  messages: Message[];
  /** the streaming assistant message (text so far) */
  partial: Message | null;
  pendingApprovals: ApprovalRequest[];
  /** toolCallId → status */
  toolStatus: Record<string, ToolStatus>;
  usage: UsageEvent | null;
}

export interface ContextInfo {
  contextWindow: number;
  maxOutput: number;
  inputBudget: number;
  fixedOverhead: number;
  estimatedTokens: number;
  lastActualTokens: number;
  percent: number;
  autoCompactAt: number;
  compactions: number;
  breakdown: Record<string, number> | null;
  windowSource: string;
  suspect: boolean;
  model: string;
  provider: string;
}

/** "yes" | "no" | "unknown" */
export type Cap = string;

export interface ModelInfo {
  id: string;
  displayName: string;
  contextWindow: number;
  maxOutput: number;
  tools: Cap;
  vision: Cap;
  thinking: Cap;
  family?: string;
  paramSize?: string;
  note?: string;
  remote: boolean;
  resolvedModel?: string;
  description?: string;
  thinkingModes?: string[];
  effortLevels?: string[];
  loadedContext?: number;
  configuredCtx?: number;
  default?: boolean;
  contextSource?: string;
  toolsVerified?: boolean;
  supportsEffort?: boolean;
}

export interface ModelDiscovery {
  provider: string;
  baseUrl: string;
  models: ModelInfo[] | null;
  fetchedAt: number;
  fromCache: boolean;
  error?: string;
  warnings?: string[];
  configuredModel?: string;
  effectiveModel?: string;
  modelMissing?: boolean;
  version?: string;
}

export interface ProviderTestResult {
  ok: boolean;
  latencyMs: number;
  modelFound: boolean;
  tools: Cap;
  contextWindow: number;
  local: boolean;
  message: string;
  warnings?: string[];
}

// --- configuration (Go: internal/config/ai_config.go) -----------------------

export type AccessLevel = 'none' | 'ask' | 'read' | 'write';

export interface AccessEntry {
  level: string;
  /** remote provider hosts this level was granted for */
  hosts?: string[];
  /** remote hosts allowed to read only although the level is write ("Always allow read") */
  readHosts?: string[];
}

export interface ClaudeCodeConfig {
  path?: string;
  model?: string;
  maxBudgetUsd?: number;
  allowResume?: boolean;
  useAnthropicEnv?: boolean;
}

export interface AIConfig {
  version: number;
  revision: number;
  /** builtin | claudecode */
  engine: string;
  /** openai | ollama | anthropic | "" */
  provider: string;
  /** provider=openai: openai|litellm|ollama|vllm|lmstudio|custom */
  flavor?: string;
  url: string;
  /** write-only: always "" in responses */
  apiKey: string;
  hasKey: boolean;
  clearApiKey?: boolean;
  keyError?: string;
  warnings?: string[];
  anthropicAuth?: string;
  anthropicFallback?: boolean;
  allowInsecureHttp?: boolean;
  tlsSkipVerify?: boolean;
  endpointLocal?: boolean;
  endpointConcurrency?: number;
  toolCallIdStyle?: string;
  model: string;
  contextWindow: number;
  maxOutputTokens: number;
  maxSteps: number;
  /** "" | off | low | medium | high */
  thinking: string;
  hideThinking: boolean;
  effort?: string;
  requestTimeoutSec: number;
  ollamaKeepAlive?: string;
  allowWrites: boolean;
  /** "" (= ask) | none | read */
  defaultAccess: string;
  connectionAccess: Record<string, AccessEntry> | null;
  redactAttributes: string[] | null;
  /** "" (= remote) | always | never */
  maskPasswordValues: string;
  disableTitleGeneration: boolean;
  connectionNotes?: Record<string, string>;
  claudeCode: ClaudeCodeConfig;
}
