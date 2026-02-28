import { callOpenRouter } from "./executor";
import type { Intent } from "./memory";

/** Strip markdown fences and trailing commas from LLM JSON responses */
function cleanJson(raw: string): string {
  return raw
    .replace(/```json\s*/gi, "")
    .replace(/```\s*/g, "")
    .trim()
    .replace(/,\s*([\]}])/g, "$1");
}

export interface ClassifierResult {
  intent: Intent;
  project_summary: string;
}

const CLASSIFIER_MODEL = "openai/gpt-4o-mini";

const SYSTEM_PROMPT = `You are an intent classifier for a coding assistant router.
Given a user's coding prompt, respond with ONLY valid JSON in this exact format:
{"intent": "<plan|ui|logic|debug>", "project_summary": "<one sentence describing what the user is building>"}

Intent definitions:
- plan: Architecture, system design, project planning, API design, high-level decisions
- ui: Frontend components, CSS/Tailwind, React/Vue/HTML, visual layout, user interfaces
- logic: Backend logic, algorithms, data processing, APIs implementation, complex code generation
- debug: Fixing bugs, error analysis, debugging, tracing issues, test failures

Reply with ONLY the JSON object, no markdown, no explanation.`;

export async function classifyIntent(
  prompt: string,
  apiKey: string
): Promise<ClassifierResult> {
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: prompt },
  ];

  const raw = await callOpenRouter(
    CLASSIFIER_MODEL,
    messages,
    apiKey,
    { max_tokens: 150, temperature: 0 }
  );

  try {
    // Strip markdown code fences if the model wraps it anyway
    const cleaned = cleanJson(raw);
    const parsed = JSON.parse(cleaned) as ClassifierResult;

    // Validate intent value
    const validIntents: Intent[] = ["plan", "ui", "logic", "debug"];
    if (!validIntents.includes(parsed.intent)) {
      throw new Error(`Invalid intent: ${parsed.intent}`);
    }

    return parsed;
  } catch (err) {
    // Fallback: default to logic if parsing fails
    console.error(`[classifier] Failed to parse response: ${raw}`);
    console.error(`[classifier] Error: ${err}`);
    return { intent: "logic", project_summary: prompt.slice(0, 100) };
  }
}

export interface Subtask {
  title: string;   // short label for terminal header (3-6 words)
  prompt: string;  // full self-contained prompt sent to the model
  intent: Intent;  // plan | ui | logic | debug
}

export interface DecomposeResult {
  project_summary: string;
  subtasks: Subtask[];
}

const DECOMPOSE_SYSTEM_PROMPT = `You are a task decomposition engine for a coding assistant router.

Given a user's coding prompt, ALWAYS decompose it into multiple sequential steps.

IMPORTANT: Always assume the target is a terminal/CLI app or a web app (Node.js, Python, or React). Never produce Android, iOS, Kotlin, Swift, or any mobile framework. If the prompt is ambiguous (e.g. "build a coin flip app"), default to a terminal/CLI implementation.

Respond with ONLY valid JSON:
{
  "project_summary": "<one sentence describing the overall goal>",
  "subtasks": [
    {
      "title": "<short label, 3-6 words>",
      "prompt": "<full self-contained prompt for this subtask>",
      "intent": "<plan|ui|logic|debug>"
    }
  ]
}

Rules:
- Always return 3-5 subtasks in execution order.
- Each subtask prompt must explicitly scope itself to ONLY that aspect — it must NOT build the full project.
- Each subtask prompt is self-contained — prior outputs will be in context but don't reference them explicitly.
- intent: plan=architecture/design, ui=frontend/React/CSS, logic=backend/algorithms/code, debug=bugs/errors.
- All code produced must be cross-platform (Windows, Mac, Linux). Never use platform-specific APIs (e.g. termios, fcntl, msvcrt). Use cross-platform libraries instead (e.g. curses for Python terminal apps).
- Never build mobile apps (Android/iOS/Kotlin/Swift). Always target terminal/CLI or web (Node.js/Python/React).
- Reply with ONLY the JSON, no markdown.`;

export async function decomposeTask(
  prompt: string,
  apiKey: string
): Promise<DecomposeResult> {
  const messages = [
    { role: "system", content: DECOMPOSE_SYSTEM_PROMPT },
    { role: "user", content: prompt },
  ];

  const raw = await callOpenRouter(CLASSIFIER_MODEL, messages, apiKey, {
    max_tokens: 600,
    temperature: 0,
  });

  try {
    const cleaned = cleanJson(raw);
    const parsed = JSON.parse(cleaned) as DecomposeResult;

    const validIntents: Intent[] = ["plan", "ui", "logic", "debug"];
    if (!Array.isArray(parsed.subtasks) || parsed.subtasks.length === 0) throw new Error("No subtasks");
    for (const s of parsed.subtasks) {
      if (!validIntents.includes(s.intent)) throw new Error(`Invalid intent: ${s.intent}`);
      if (!s.title || !s.prompt) throw new Error("Subtask missing title or prompt");
    }
    return parsed;
  } catch {
    // Fallback: enforce multi-step decomposition
    return {
      project_summary: prompt.slice(0, 100),
      subtasks: [
        {
          title: "Design the architecture",
          prompt: `Design the high-level architecture and file layout for: ${prompt}`,
          intent: "plan",
        },
        {
          title: "Build the UI and UX",
          prompt: `Implement the user-facing interface for: ${prompt}`,
          intent: "ui",
        },
        {
          title: "Implement core logic",
          prompt: `Implement the application logic and required behavior for: ${prompt}`,
          intent: "logic",
        },
      ],
    };
  }
}
