import * as fs from "fs";
import * as path from "path";
import type { Intent } from "./memory";

interface ModelEntry {
  primary: string;
  failover: string;
}

interface Recipe {
  description: string;
  overrides: Partial<Record<Intent, ModelEntry>>;
}

interface Config {
  modelMap: Record<Intent, ModelEntry>;
  recipes: Record<string, Recipe>;
}

export interface ResolvedRoute {
  primary: string;
  failover: string;
  recipeName?: string;
}

function resolveConfigPath(): string {
  const candidates = [
    process.env.RELAY_CONFIG_PATH,
    path.resolve(process.cwd(), "config.json"),
    path.resolve(__dirname, "..", "config.json"),
    path.resolve(__dirname, "config.json"),
  ].filter((candidate): candidate is string => Boolean(candidate));

  const existing = candidates.find((candidate) => fs.existsSync(candidate));
  if (existing) return existing;

  throw new Error(`config.json not found. Tried: ${candidates.join(", ")}`);
}

function loadConfig(): Config {
  const configPath = resolveConfigPath();
  const raw = fs.readFileSync(configPath, "utf-8");
  try {
    return JSON.parse(raw) as Config;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid config.json at ${configPath}: ${msg}`);
  }
}

export function getBestModel(intent: Intent, recipeName?: string): ResolvedRoute {
  const config = loadConfig();

  // Start with the default model map
  let entry = config.modelMap[intent];
  if (!entry) {
    throw new Error(`No model configured for intent "${intent}" in config.json`);
  }

  // Apply recipe overrides if a recipe is specified
  if (recipeName) {
    const recipe = config.recipes[recipeName];
    if (!recipe) {
      console.warn(`[router] Recipe "${recipeName}" not found - using defaults`);
    } else if (recipe.overrides[intent]) {
      entry = recipe.overrides[intent]!;
    }
  }

  return {
    primary: entry.primary,
    failover: entry.failover,
    ...(recipeName ? { recipeName } : {}),
  };
}

export function listRecipes(): string[] {
  const config = loadConfig();
  return Object.keys(config.recipes);
}

export function describeRecipe(name: string): string {
  const config = loadConfig();
  const recipe = config.recipes[name];
  if (!recipe) return `Recipe "${name}" not found`;
  return `${name}: ${recipe.description}`;
}

export const MODEL_LABELS: Record<string, string> = {
  'anthropic/claude-opus-4-6': 'Claude Opus 4.6',
  'anthropic/claude-3-7-sonnet': 'Claude 3.7 Sonnet',
  'openai/gpt-5.3-codex': 'GPT-5.3 Codex',
  'anthropic/claude-3-5-haiku': 'Claude 3.5 Haiku',
  'openai/gpt-4o': 'GPT-4o',
  'openai/gpt-4o-mini': 'GPT-4o-mini',
  'google/gemini-2.0-flash-001': 'Gemini 2.0 Flash',
};

const SPECIALIST_REASONS: Record<Intent, string> = {
  plan:  "specialist - best for architecture & long-horizon reasoning",
  ui:    "specialist - SOTA for React, Tailwind & component design",
  logic: "specialist - purpose-built for code generation",
  debug: "specialist - strong chain-of-thought for debugging",
};

export function getRoutingReason(
  intent: Intent,
  modelId: string,
  isFailover: boolean,
  primaryLabel?: string,
  failoverReason?: 'api-error' | 'syntax-error'
): { label: string; reason: string } {
  const label = MODEL_LABELS[modelId] ?? modelId;

  if (!isFailover) {
    return { label, reason: SPECIALIST_REASONS[intent] };
  }

  const primaryName = primaryLabel ?? 'primary model';
  const cause = failoverReason === 'syntax-error'
    ? `${primaryName} produced invalid syntax`
    : `${primaryName} was unavailable`;

  return { label, reason: `competitor failover - ${cause}` };
}
