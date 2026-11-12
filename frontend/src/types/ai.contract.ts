/**
 * Go/TS drift guard (§12.10), checked by `tsc --noEmit` only (nothing here
 * runs or is bundled).
 *
 * ai.events.golden.json is written by internal/ai/event_contract_test.go with
 * one fully populated payload per event and view type (every optional field
 * set, every slice with one element). The checks below walk each golden
 * payload together with its TS type, recursively:
 *  - both sides must have exactly the same field names (a field only Go or
 *    only TS has is reported with its path),
 *  - each field must have the same primitive kind (string / number / boolean
 *    / array / object); literal unions in TS count as their base type,
 *  - maps (index signatures) check their values only.
 * A failure shows up as `Type '"<path>: <problem>"' does not satisfy the
 * constraint 'true'`.
 */
import type golden from './ai.events.golden.json';
import type * as AI from './ai';

type Golden = typeof golden;

/** NonNullable that keeps `unknown` (NonNullable<unknown> would be {}). */
type NN<T> = unknown extends T ? unknown : NonNullable<T>;

type AllTrue<U> = [Exclude<U, true>] extends [never] ? true : Exclude<U, true>;

type Check<G, T, P extends string> =
  unknown extends T ? true
  : [T] extends [string] ? ([G] extends [string] ? true : `${P}: expected a string`)
  : [T] extends [number] ? ([G] extends [number] ? true : `${P}: expected a number`)
  : [T] extends [boolean] ? ([G] extends [boolean] ? true : `${P}: expected a boolean`)
  : [T] extends [readonly (infer U)[]]
    ? ([G] extends [readonly (infer V)[]] ? Check<V, NN<U>, `${P}[]`> : `${P}: expected an array`)
  : [T] extends [object]
    ? ([G] extends [object]
      ? (string extends keyof T ? CheckRecord<G, T, P> : CheckObject<G, T, P>)
      : `${P}: expected an object`)
  : `${P}: unsupported TS type`;

type CheckRecord<G, T, P extends string> =
  AllTrue<{ [K in keyof G]: Check<G[K], NN<T[keyof T]>, `${P}{}`> }[keyof G]>;

type CheckObject<G, T, P extends string> =
  [Exclude<keyof G, keyof T>] extends [never]
    ? [Exclude<keyof T, keyof G>] extends [never]
      ? AllTrue<{ [K in keyof T]-?: K extends keyof G ? Check<G[K], NN<T[K]>, `${P}.${K & string}`> : never }[keyof T]>
      : `${P}: field(s) only in TS: ${Exclude<keyof T, keyof G> & string}`
    : `${P}: field(s) only in Go: ${Exclude<keyof G, keyof T> & string}`;

type Assert<X extends true> = X;

// --- events -----------------------------------------------------------------

type EventChecks = {
  [K in keyof AI.AIEventMap]: K extends keyof Golden['events']
    ? Check<Golden['events'][K], AI.AIEventMap[K], K>
    : `${K}: not emitted by Go`;
};
export type EventsMatch = Assert<AllTrue<EventChecks[keyof EventChecks]>>;
export type EventNamesMatch = Assert<
  [Exclude<keyof Golden['events'], keyof AI.AIEventMap>] extends [never]
    ? true
    : `events only in Go: ${Exclude<keyof Golden['events'], keyof AI.AIEventMap> & string}`
>;

// --- facade views -----------------------------------------------------------

interface Views {
  Message: AI.Message;
  ChatSummary: AI.ChatSummary;
  ChatView: AI.ChatView;
  RunSnapshot: AI.RunSnapshot;
  ContextInfo: AI.ContextInfo;
  ModelDiscovery: AI.ModelDiscovery;
  ClaudeCodeHosts: AI.ClaudeCodeHosts;
  ProviderTestResult: AI.ProviderTestResult;
  ApprovalResult: AI.ApprovalResult;
  SecretValue: AI.SecretValue;
  Grant: AI.Grant;
  SendRequest: AI.SendRequest;
  SendResult: AI.SendResult;
  AIConfig: AI.AIConfig;
}

type ViewChecks = {
  [K in keyof Views]: K extends keyof Golden['views'] ? Check<Golden['views'][K], Views[K], K> : `${K}: missing in the golden`;
};
export type ViewsMatch = Assert<AllTrue<ViewChecks[keyof ViewChecks]>>;
export type ViewNamesMatch = Assert<
  [Exclude<keyof Golden['views'], keyof Views>] extends [never]
    ? true
    : `views only in Go: ${Exclude<keyof Golden['views'], keyof Views> & string}`
>;
