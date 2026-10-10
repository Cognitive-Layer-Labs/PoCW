/**
 * AI configuration (models + prompts) loaded from a YAML file.
 *
 * Path: AI_CONFIG_PATH (absolute, or relative to the working directory / project root), default
 * ai-config.yml in the project root. ai-config.baseline.yml keeps the pre-2026-10-10 setup
 * (all google/gemini-2.5-flash) so two engines can be compared side by side.
 *
 * A model entry is either a plain OpenRouter model id (legacy form) or an object:
 *
 *   kg-model:
 *     model: anthropic/claude-haiku-5.5
 *     reasoning: low                    # off | minimal | low | medium | high | { ...raw OpenRouter field }
 *     fallbacks: [google/gemini-2.5-flash]
 *
 * Decisions models (System One, e.g. typesafe/jev-1.13) are plain ids under
 * question-check-model / grade-decisions-model; when absent those steps are skipped
 * (question check) or done by the LLM grader alone (grading).
 */

import { existsSync, readFileSync } from "fs";
import * as path from "path";
import * as yaml from "js-yaml";

/** OpenRouter "reasoning" request field. */
export type ReasoningSetting =
  | { effort: "minimal" | "low" | "medium" | "high" }
  | { enabled: false }
  | { max_tokens: number };

export interface ModelSpec {
  /** Primary OpenRouter model id. */
  model: string;
  /** Tried in order by OpenRouter when the primary fails (sent as "models": [model, ...fallbacks]). */
  fallbacks: string[];
  /** Sent as-is as the "reasoning" request field; undefined → not sent (provider default). */
  reasoning?: ReasoningSetting;
}

/** Model keys that must be present (prompts are checked separately). */
const REQUIRED_MODEL_KEYS = ["kg-model", "kaqg-model", "kaqg-mcq-model", "kaqg-tf-model", "grade-model"] as const;
const REQUIRED_PROMPT_KEYS = ["kg-prompt", "kaqg-prompt", "kaqg-mcq-prompt", "kaqg-tf-prompt", "grade-prompt"] as const;

export const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const DEFAULT_CONFIG_FILE = "ai-config.yml";

export const DEFAULT_TITLE_PROMPT =
  "Given the following information about a web page, provide a concise, accurate title (under 120 characters). " +
  "Reply with ONLY the title — no quotes, no explanation.";

export class AIConfigError extends Error {
  constructor(message: string) { super(message); this.name = "AIConfigError"; }
}

export interface LoadedAIConfig {
  /** Absolute path of the file that was loaded. */
  path: string;
  raw: Record<string, unknown>;
}

let cached: LoadedAIConfig | null = null;

/** Resolve AI_CONFIG_PATH (or the default) to an absolute path. */
export function resolveAIConfigPath(envValue = process.env.AI_CONFIG_PATH): string {
  const value = (envValue ?? "").trim();
  if (!value) return path.join(PROJECT_ROOT, DEFAULT_CONFIG_FILE);
  if (path.isAbsolute(value)) return value;
  const fromCwd = path.resolve(process.cwd(), value);
  if (existsSync(fromCwd)) return fromCwd;
  return path.resolve(PROJECT_ROOT, value);
}

const EFFORTS = new Set(["minimal", "low", "medium", "high"]);

function parseReasoning(value: unknown, where: string): ReasoningSetting | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === false) return { enabled: false };
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (v === "off" || v === "none" || v === "disabled") return { enabled: false };
    if (EFFORTS.has(v)) return { effort: v as "minimal" | "low" | "medium" | "high" };
    throw new AIConfigError(`${where}: unknown reasoning "${value}" (use off, minimal, low, medium, high)`);
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    const o = value as Record<string, unknown>;
    if (typeof o.effort === "string" && EFFORTS.has(o.effort)) return { effort: o.effort as "minimal" | "low" | "medium" | "high" };
    if (o.enabled === false) return { enabled: false };
    if (typeof o.max_tokens === "number" && o.max_tokens > 0) return { max_tokens: o.max_tokens };
  }
  throw new AIConfigError(`${where}: invalid reasoning setting ${JSON.stringify(value)}`);
}

/** Parse a model entry (string id or { model, reasoning?, fallbacks? }). */
export function parseModelSpec(value: unknown, where: string): ModelSpec {
  if (typeof value === "string" && value.trim()) return { model: value.trim(), fallbacks: [] };
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const o = value as Record<string, unknown>;
    if (typeof o.model !== "string" || !o.model.trim()) throw new AIConfigError(`${where}: "model" must be a non-empty string`);
    const rawFallbacks = o.fallbacks ?? o.fallback ?? [];
    const list = Array.isArray(rawFallbacks) ? rawFallbacks : [rawFallbacks];
    if (!list.every(f => typeof f === "string" && f.trim())) {
      throw new AIConfigError(`${where}: "fallbacks" must be a list of model ids`);
    }
    const model = o.model.trim();
    const fallbacks = [...new Set((list as string[]).map(f => f.trim()))].filter(f => f !== model);
    return { model, fallbacks, reasoning: parseReasoning(o.reasoning, where) };
  }
  throw new AIConfigError(`${where}: expected a model id or { model, reasoning?, fallbacks? }`);
}

function validate(raw: Record<string, unknown>, file: string): void {
  for (const key of REQUIRED_MODEL_KEYS) parseModelSpec(raw[key], `${file}: ${key}`);
  for (const key of REQUIRED_PROMPT_KEYS) {
    if (typeof raw[key] !== "string" || !(raw[key] as string).trim()) {
      throw new AIConfigError(`${file}: "${key}" must be a non-empty string`);
    }
  }
  if (raw["title-model"] !== undefined) parseModelSpec(raw["title-model"], `${file}: title-model`);
  for (const key of ["question-check-model", "grade-decisions-model"]) {
    const v = raw[key];
    if (v !== undefined && v !== null && (typeof v !== "string" || !v.trim())) {
      throw new AIConfigError(`${file}: "${key}" must be a decisions model id (string)`);
    }
  }
}

/** Load (and validate) the AI config. Cached after the first call. */
export function loadAIConfig(): LoadedAIConfig {
  if (cached) return cached;
  const file = resolveAIConfigPath();
  if (!existsSync(file)) throw new AIConfigError(`AI config not found: ${file} (AI_CONFIG_PATH=${process.env.AI_CONFIG_PATH ?? ""})`);
  const parsed = yaml.load(readFileSync(file, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AIConfigError(`${file}: expected a YAML mapping`);
  }
  const raw = parsed as Record<string, unknown>;
  validate(raw, path.basename(file));
  cached = { path: file, raw };
  return cached;
}

/** Model spec for a required model key (kg-model, kaqg-model, grade-model, ...). */
export function modelSpec(key: string): ModelSpec {
  const { raw, path: file } = loadAIConfig();
  return parseModelSpec(raw[key], `${path.basename(file)}: ${key}`);
}

/** Model spec for titles: title-model, else kg-model's primary without reasoning/fallbacks. */
export function titleModelSpec(): ModelSpec {
  const { raw } = loadAIConfig();
  if (raw["title-model"] !== undefined) return modelSpec("title-model");
  return { model: modelSpec("kg-model").model, fallbacks: [] };
}

/** Prompt text for a key; `fallback` when the key is absent. */
export function promptFor(key: string, fallback?: string): string {
  const v = loadAIConfig().raw[key];
  if (typeof v === "string" && v.trim()) return v;
  if (fallback !== undefined) return fallback;
  throw new AIConfigError(`AI config: "${key}" is missing`);
}

/** Decisions model id (question-check-model / grade-decisions-model), or undefined when not set. */
export function decisionsModel(key: "question-check-model" | "grade-decisions-model"): string | undefined {
  const v = loadAIConfig().raw[key];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/** Optional plain string value (legacy question-eval-model). */
export function optionalString(key: string): string | undefined {
  const v = loadAIConfig().raw[key];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/** Test-only: drop the cached config so the next access reloads (e.g. after changing AI_CONFIG_PATH). */
export function __resetAIConfigForTest(): void {
  cached = null;
}
