/**
 * Request-scoped context for the LLM / decisions call log: which resource (knowledge_id) or test
 * session (session_id) a call belongs to. Set around indexing and session work with
 * runWithUsageContext(); every call made inside (including awaited async work) inherits it.
 */

import { AsyncLocalStorage } from "async_hooks";

export interface UsageContext {
  knowledgeId?: string | null;
  sessionId?: string | null;
}

const storage = new AsyncLocalStorage<UsageContext>();

/** Run `fn` with `ctx` merged over the current context. */
export function runWithUsageContext<T>(ctx: UsageContext, fn: () => T): T {
  const parent = storage.getStore() ?? {};
  return storage.run({ ...parent, ...ctx }, fn);
}

export function currentUsageContext(): UsageContext {
  return storage.getStore() ?? {};
}
