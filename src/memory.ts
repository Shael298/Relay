import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export type Intent = "plan" | "ui" | "logic" | "debug";

export interface Turn {
  role: "user" | "assistant";
  content: string;
  intent?: Intent;
  model?: string;
  timestamp: string;
}

export interface ContextFile {
  projectSummary: string;
  turns: Turn[];
}

const RELAY_DIR = path.join(os.homedir(), ".relay");
const CONTEXT_PATH = path.join(RELAY_DIR, "context.json");
const MAX_TURNS = 5;

function loadContext(): ContextFile {
  if (!fs.existsSync(CONTEXT_PATH)) {
    return { projectSummary: "", turns: [] };
  }
  try {
    const raw = fs.readFileSync(CONTEXT_PATH, "utf-8");
    return JSON.parse(raw) as ContextFile;
  } catch {
    return { projectSummary: "", turns: [] };
  }
}

function saveContext(ctx: ContextFile): void {
  if (!fs.existsSync(RELAY_DIR)) fs.mkdirSync(RELAY_DIR, { recursive: true });
  fs.writeFileSync(CONTEXT_PATH, JSON.stringify(ctx, null, 2), "utf-8");
}

export function getRecentTurns(): Turn[] {
  const ctx = loadContext();
  return ctx.turns.slice(-MAX_TURNS * 2); // last 5 user+assistant pairs
}

export function getProjectSummary(): string {
  return loadContext().projectSummary;
}

export function addTurn(turn: Turn): void {
  const ctx = loadContext();
  ctx.turns.push(turn);
  saveContext(ctx);
}

export function updateProjectSummary(summary: string): void {
  const ctx = loadContext();
  ctx.projectSummary = summary;
  saveContext(ctx);
}

function modelFamily(modelId: string): string {
  return modelId.split("/")[0] ?? "unknown";
}

/**
 * Build the messages array for the API call, injecting recent context.
 * When switching model families, prepends an enhanced handoff message so the
 * incoming model knows it is continuing from a prior step.
 */
export function buildContextMessages(
  userPrompt: string,
  currentModel: string,
  projectSummary: string
): Array<{ role: string; content: string }> {
  const recentTurns = getRecentTurns();
  const messages: Array<{ role: string; content: string }> = [];

  if (projectSummary) {
    const lastModelTurn = [...recentTurns].reverse().find(t => t.model);
    const switching = lastModelTurn?.model
      ? modelFamily(currentModel) !== modelFamily(lastModelTurn.model)
      : false;

    messages.push({
      role: "system",
      content: switching
        ? `You are continuing a multi-step pipeline (model handoff from ${modelFamily(lastModelTurn!.model!)} → ${modelFamily(currentModel)}). Project context: ${projectSummary}`
        : `Project context: ${projectSummary}`,
    });
  }

  // Add recent turns as conversation history
  for (const turn of recentTurns) {
    messages.push({ role: turn.role, content: turn.content });
  }

  // Add the current user prompt
  messages.push({ role: "user", content: userPrompt });

  return messages;
}
