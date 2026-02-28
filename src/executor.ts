import * as vm from "vm";

const OPENROUTER_BASE = "https://openrouter.ai/api/v1/chat/completions";
const APP_NAME = "relay";

// Cache node-fetch import so it's only loaded once
let _fetch: typeof import("node-fetch").default | null = null;
async function getFetch() {
  if (!_fetch) {
    const mod = await import("node-fetch");
    _fetch = mod.default;
  }
  return _fetch;
}

interface OpenRouterMessage {
  role: string;
  content: string;
}

interface OpenRouterOptions {
  max_tokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

interface OpenRouterResponse {
  choices: Array<{
    message: {
      content: string;
    };
  }>;
  error?: {
    message: string;
    code?: number;
  };
}

/**
 * Makes a raw call to OpenRouter and returns the assistant's text content.
 */
export async function callOpenRouter(
  model: string,
  messages: OpenRouterMessage[],
  apiKey: string,
  options: OpenRouterOptions = {}
): Promise<string> {
  const fetch = await getFetch();

  const body = {
    model,
    messages,
    max_tokens: options.max_tokens ?? 4096,
    temperature: options.temperature ?? 0.7,
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res = await fetch(OPENROUTER_BASE, {
    method: "POST",
    signal: options.signal as any,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "HTTP-Referer": `https://github.com/${APP_NAME}`,
      "X-Title": APP_NAME,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenRouter API error ${res.status}: ${errText}`);
  }

  const data = (await res.json()) as OpenRouterResponse;

  if (data.error) {
    throw new Error(`OpenRouter returned error: ${data.error.message}`);
  }

  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("OpenRouter returned empty content");
  }

  return content;
}

/**
 * Extracts all code blocks from a markdown response.
 */
function extractCodeBlocks(text: string): string[] {
  const blocks: string[] = [];
  // Match fenced code blocks (```...```)
  const fenced = text.matchAll(/```(?:\w+)?\n([\s\S]*?)```/g);
  for (const match of fenced) {
    blocks.push(match[1].trim());
  }
  return blocks;
}

/**
 * Validates extracted JS/TS code blocks using vm.compileFunction.
 * Returns null if valid, or an error message if invalid.
 */
function validateCode(response: string): string | null {
  // Check for model refusal
  if (/i('m| am) (unable|sorry)|i cannot help|i (can't|cannot) (assist|provide|generate)/i.test(response)) {
    return "Model refused to respond";
  }

  // Check for truncated response (odd number of opening code fences = unclosed block)
  const fenceCount = (response.match(/^```/gm) || []).length;
  if (fenceCount > 0 && fenceCount % 2 !== 0) {
    return "Response appears truncated (unclosed code block)";
  }

  const blocks = extractCodeBlocks(response);

  for (const block of blocks) {
    // Skip obvious non-JS blocks (HTML, CSS, JSON, shell, etc.)
    if (
      block.startsWith("<") ||
      block.startsWith("{") ||
      block.startsWith("#") ||
      block.startsWith("$") ||
      block.startsWith("npm") ||
      block.startsWith("yarn") ||
      /^[a-z-]+:\s/i.test(block) // CSS property-like
    ) {
      continue;
    }

    try {
      vm.compileFunction(block, [], { parsingContext: vm.createContext() });
    } catch (err) {
      if (err instanceof SyntaxError) {
        return `Syntax error in code block: ${err.message}`;
      }
      // Non-syntax VM errors are fine (e.g., reference errors are runtime, not compile-time)
    }
  }

  return null; // all blocks valid
}

export interface ExecuteResult {
  response: string;
  modelUsed: string;
  usedFailover: boolean;
  failoverReason?: 'api-error' | 'syntax-error';
}

/**
 * Executes a prompt against the primary model, validates code output,
 * and falls back to the failover model if validation fails.
 * Max 2 attempts total.
 */
export async function execute(
  messages: OpenRouterMessage[],
  primaryModel: string,
  failoverModel: string,
  apiKey: string,
  onFailover?: (model: string, reason: 'api-error' | 'syntax-error') => void,
  signal?: AbortSignal
): Promise<ExecuteResult> {
  // Attempt 1: primary model
  let response: string;
  let usedFailover = false;
  let modelUsed = primaryModel;
  let failoverReason: 'api-error' | 'syntax-error' | undefined;

  try {
    response = await callOpenRouter(primaryModel, messages, apiKey, { signal });
  } catch (err) {
    // User pressed Ctrl+C — don't failover, just propagate
    if (err instanceof Error && err.name === 'AbortError' && signal?.aborted) throw err;
    onFailover?.(failoverModel, 'api-error');
    response = await callOpenRouter(failoverModel, messages, apiKey, { signal });
    modelUsed = failoverModel;
    usedFailover = true;
    failoverReason = 'api-error';
    return { response, modelUsed, usedFailover, failoverReason };
  }

  // Validate code in the response
  const validationError = validateCode(response);

  if (!validationError) {
    return { response, modelUsed, usedFailover };
  }

  // Attempt 2: failover model with error context injected
  const failoverMessages: OpenRouterMessage[] = [
    ...messages,
    { role: "assistant", content: response },
    {
      role: "user",
      content: `The previous response contained a syntax error: "${validationError}". Please fix the code and provide a corrected version.`,
    },
  ];

  onFailover?.(failoverModel, 'syntax-error');
  try {
    response = await callOpenRouter(failoverModel, failoverMessages, apiKey, { signal });
    modelUsed = failoverModel;
    usedFailover = true;
    failoverReason = 'syntax-error';
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`\n  ⚠ Failover model also failed: ${msg}. Returning original response.`);
  }

  return { response, modelUsed, usedFailover, failoverReason };
}
