#!/usr/bin/env node
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import * as readline from "readline";
import { execSync } from "child_process";

const RELAY_CONFIG_DIR = path.join(os.homedir(), ".relay");
const RELAY_CONFIG_FILE = path.join(RELAY_CONFIG_DIR, "config");

function loadApiKey(): string | undefined {
  // 1. Environment variable takes priority
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;

  // 2. Read from ~/.relay/config
  if (fs.existsSync(RELAY_CONFIG_FILE)) {
    const content = fs.readFileSync(RELAY_CONFIG_FILE, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("OPENROUTER_API_KEY=")) {
        return trimmed.slice("OPENROUTER_API_KEY=".length).trim();
      }
    }
  }

  return undefined;
}

function saveApiKey(key: string): void {
  if (!fs.existsSync(RELAY_CONFIG_DIR)) {
    fs.mkdirSync(RELAY_CONFIG_DIR, { recursive: true });
  }
  fs.writeFileSync(RELAY_CONFIG_FILE, `OPENROUTER_API_KEY=${key}\n`, "utf-8");
}

function promptForApiKey(): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    console.log("-------------------------------------");
    console.log("First-time setup");
    console.log("Get your API key at: https://openrouter.ai/keys");
    console.log("-------------------------------------");
    console.log();
    rl.question("  Enter your OpenRouter API key: ", (answer) => {
      const key = answer.trim();
      if (!key) {
        console.log("  Skipped - no key entered.\n");
        resolve("");
      } else {
        saveApiKey(key);
        console.log(`\n  Saved to ${RELAY_CONFIG_FILE}\n`);
        resolve(key);
      }
      rl.close();
    });
  });
}

import { decomposeTask } from "./classifier";
import type { DecomposeResult, Subtask } from "./classifier";
import { getBestModel, getRoutingReason, MODEL_LABELS, describeRecipe, listRecipes } from "./router";
import { execute, callOpenRouter } from "./executor";
import {
  addTurn,
  buildContextMessages,
  getProjectSummary,
  updateProjectSummary,
} from "./memory";
import type { Intent } from "./memory";

const DIVIDER = "-------------------------------------";

let currentAbortController: AbortController | null = null;

function printWelcome(recipe: string): void {
  console.log("Relay");
  console.log("Combining the best coding models seamlessly");
  console.log("-------------------------------------");
  console.log(`Recipe: ${recipe}  |  Type /help for commands`);
  console.log();
}

function printRecipeTable(recipe: string | undefined): void {
  const intents = ["plan", "ui", "logic", "debug"] as const;
  for (const intent of intents) {
    const route = getBestModel(intent, recipe);
    const primary = MODEL_LABELS[route.primary] ?? route.primary;
    const failover = MODEL_LABELS[route.failover] ?? route.failover;
    console.log(`  ${intent.padEnd(6)}->  ${primary.padEnd(22)}  fallback: ${failover}`);
  }
  console.log();
}

function printHelp(): void {
  console.log(`Commands:
  /recipe the-duo  Opus 4.6 + Codex 5.3, each where they're strongest
  /recipe default  Back to the default model lineup
  /dry-run         Toggle dry-run mode (no API calls)
  /help            Show this help
  exit, /exit      Quit`);
}

function mockDecompose(prompt: string): DecomposeResult {
  const project_summary = prompt.slice(0, 100);
  return {
    project_summary,
    subtasks: [
      { title: "Design the architecture", prompt: `Design the high-level architecture for: ${prompt}`, intent: "plan" },
      { title: "Build the UI components", prompt: `Build the frontend/React components for: ${prompt}`, intent: "ui" },
      { title: "Implement the business logic", prompt: `Write the backend logic for: ${prompt}`, intent: "logic" },
    ],
  };
}

function forceMultiStep(prompt: string, projectSummary: string, subtasks: Subtask[]): DecomposeResult {
  if (subtasks.length >= 2) {
    return { project_summary: projectSummary, subtasks };
  }

  return {
    project_summary: projectSummary || prompt.slice(0, 100),
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

function mockClassify(prompt: string): Intent {
  const lower = prompt.toLowerCase();
  if (lower.includes("plan") || lower.includes("architect") || lower.includes("design") || lower.includes("api")) {
    return "plan";
  } else if (
    lower.includes("ui") ||
    lower.includes("react") ||
    lower.includes("component") ||
    lower.includes("navbar") ||
    lower.includes("frontend") ||
    lower.includes("tailwind") ||
    lower.includes("css") ||
    lower.includes("html") ||
    lower.includes("login page") ||
    lower.includes("page")
  ) {
    return "ui";
  } else if (lower.includes("fix") || lower.includes("bug") || lower.includes("debug") || lower.includes("error") || lower.includes("null pointer")) {
    return "debug";
  } else {
    return "logic";
  }
}

function startSpinner(label: string): () => void {
  const frames = ["|", "/", "-", "\\"];
  let i = 0;
  let stopped = false;
  process.stdout.write("\n");
  const id = setInterval(() => {
    process.stdout.write(`\r  ${frames[i++ % frames.length]}  ${label}`);
  }, 100);
  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(id);
    process.stdout.write(`\r${" ".repeat(label.length + 6)}\r`);
  };
}

function truncateResponse(text: string, maxLines = 10): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  return lines.slice(0, maxLines).join("\n") + `\n\n  ... (${lines.length - maxLines} more lines - see saved file)`;
}

function saveSubtaskOutput(title: string, index: number, content: string, sessionId: string): string {
  const dir = path.resolve(process.cwd(), "relay-output", "sessions", sessionId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const slug = title.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "").slice(0, 40);
  const filepath = path.join(dir, `${index}-${slug}.md`);
  fs.writeFileSync(filepath, content, "utf-8");
  return path.relative(process.cwd(), filepath);
}

interface ScaffoldResult {
  projectDir: string;
  installCmd: string | null;
  runCmd: string;
  warnings: string[];
  isRunnable: boolean;
}

function buildProjectSlug(projectSummary: string, prompt: string): string {
  const base = (projectSummary || prompt || "relay-app")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 30);
  return base || "relay-app";
}

function writeRunInstructions(projectDir: string, installCmd: string | null, runCmd: string): void {
  const lines = [
    "Relay generated this project.",
    "",
    "From this project folder, run:",
  ];
  if (installCmd) lines.push(installCmd);
  lines.push(runCmd);
  lines.push("");
  fs.writeFileSync(path.join(projectDir, "RUN_ME.txt"), lines.join("\n"), "utf-8");
}

function extractCodeBlocksWithLang(text: string): Array<{ lang: string; code: string }> {
  const blocks: Array<{ lang: string; code: string }> = [];
  for (const match of text.matchAll(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g)) {
    const lang = (match[1] ?? "").toLowerCase().trim();
    const code = (match[2] ?? "").trim();
    if (!code) continue;
    blocks.push({ lang, code });
  }
  return blocks;
}

function scaffoldFromSessionFallback(projectSlug: string, sessionId: string): ScaffoldResult | null {
  const sessionDir = path.resolve(process.cwd(), "relay-output", "sessions", sessionId);
  if (!fs.existsSync(sessionDir)) return null;

  const mdFiles = fs.readdirSync(sessionDir)
    .filter((f) => f.endsWith(".md"))
    .sort();
  if (mdFiles.length === 0) return null;

  const combined = mdFiles
    .map((name) => fs.readFileSync(path.join(sessionDir, name), "utf-8"))
    .join("\n\n");
  const blocks = extractCodeBlocksWithLang(combined);

  const pythonBlocks = blocks.filter((b) => ["py", "python"].includes(b.lang));
  const jsBlocks = blocks.filter((b) => ["js", "javascript", "node", "mjs", "cjs"].includes(b.lang));

  const projectDir = path.resolve(process.cwd(), "relay-output", projectSlug);
  if (fs.existsSync(projectDir)) {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
  fs.mkdirSync(projectDir, { recursive: true });

  let runCmd = "node index.js";
  const installCmd: string | null = null;

  if (pythonBlocks.length > 0) {
    const code = pythonBlocks.sort((a, b) => b.code.length - a.code.length)[0].code;
    fs.writeFileSync(path.join(projectDir, "main.py"), code, "utf-8");
    runCmd = "python main.py";
  } else if (jsBlocks.length > 0) {
    const code = jsBlocks.sort((a, b) => b.code.length - a.code.length)[0].code;
    fs.writeFileSync(path.join(projectDir, "index.js"), code, "utf-8");
    runCmd = "node index.js";
  } else {
    const msg = [
      "console.log('Relay could not extract executable code from the model output.');",
      "console.log('Open the session markdown files and refine your prompt to request full runnable files.');",
    ].join("\n");
    fs.writeFileSync(path.join(projectDir, "index.js"), msg, "utf-8");
  }

  const validated = validateScaffoldCommands(projectDir, fs.readdirSync(projectDir), installCmd, runCmd);
  writeRunInstructions(projectDir, validated.installCmd, validated.runCmd);
  return {
    projectDir,
    installCmd: validated.installCmd,
    runCmd: validated.runCmd,
    warnings: validated.warnings,
    isRunnable: !validated.hardErrors,
  };
}

/**
 * If runCmd references a file that doesn't exist in the file map,
 * try to find the actual entry point and fix the command.
 */
function fixRunCommand(runCmd: string, files: string[]): string {
  // Extract the file referenced in the command (e.g. "python main.py" -> "main.py")
  const match = runCmd.match(/^(python3?\s+|node\s+)(.+)$/);
  if (!match) return runCmd;

  const [, prefix, target] = match;
  const targetFile = target.trim();

  // If the file exists in the map, command is fine
  if (files.includes(targetFile)) return runCmd;

  // Look for the file anywhere in the file list
  const found = files.find(f => f.endsWith("/" + targetFile) || f === targetFile);
  if (found) return prefix + found;

  // Fallback: find any likely entry point
  const entryNames = ["main.py", "app.py", "index.js", "index.ts", "server.js", "server.ts"];
  const entry = files.find(f => {
    const base = f.split("/").pop() ?? "";
    return entryNames.includes(base);
  });
  if (entry) {
    const lang = entry.endsWith(".py") ? "python " : "node ";
    return lang + entry;
  }

  return runCmd;
}

function normalizePathSlashes(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

function parseRunCommand(runCmd: string): { runtime: "python" | "node" | null; target: string | null } {
  const trimmed = runCmd.trim();
  const match = trimmed.match(/^(python3?|py|node)\s+(.+)$/i);
  if (!match) return { runtime: null, target: null };

  const rawRuntime = match[1].toLowerCase();
  const runtime: "python" | "node" = rawRuntime === "node" ? "node" : "python";
  const rawTarget = match[2].trim().split(/\s+/)[0];
  const target = rawTarget.replace(/^['"]|['"]$/g, "");
  return { runtime, target: target || null };
}

function hasPythonMainEntrypoint(content: string): boolean {
  return /if\s+__name__\s*==\s*["']__main__["']\s*:/.test(content);
}

function validateScaffoldCommands(
  projectDir: string,
  files: string[],
  installCmd: string | null,
  runCmd: string
): { installCmd: string | null; runCmd: string; warnings: string[]; hardErrors: boolean } {
  const warnings: string[] = [];
  let nextInstall = installCmd;
  let nextRun = runCmd;
  let hardErrors = false;

  const normalizedFiles = files.map(normalizePathSlashes);

  if (nextInstall) {
    const lower = nextInstall.toLowerCase();
    const reqMatch = nextInstall.match(/(?:^|\s)-r\s+([^\s]+)/i);

    if (reqMatch) {
      const reqFile = normalizePathSlashes(reqMatch[1].replace(/^['"]|['"]$/g, ""));
      const reqExistsInMap = normalizedFiles.includes(reqFile);
      const reqExistsOnDisk = fs.existsSync(path.join(projectDir, reqFile));
      if (!reqExistsInMap && !reqExistsOnDisk) {
        warnings.push(`Install command removed: referenced missing file "${reqFile}".`);
        nextInstall = null;
      }
    } else if (lower.includes("npm install")) {
      const hasPackageJson = normalizedFiles.includes("package.json") || fs.existsSync(path.join(projectDir, "package.json"));
      if (!hasPackageJson) {
        warnings.push('Install command removed: "npm install" provided but package.json is missing.');
        nextInstall = null;
      }
    }
  }

  nextRun = fixRunCommand(nextRun, normalizedFiles);
  const parsed = parseRunCommand(nextRun);
  if (!parsed.runtime || !parsed.target) {
    return { installCmd: nextInstall, runCmd: nextRun, warnings, hardErrors };
  }

  const target = normalizePathSlashes(parsed.target);
  const fullTargetPath = path.join(projectDir, target);
  if (!fs.existsSync(fullTargetPath)) {
    warnings.push(`Run command may be invalid: entrypoint "${target}" does not exist.`);
    hardErrors = true;
    return { installCmd: nextInstall, runCmd: nextRun, warnings, hardErrors };
  }

  if (parsed.runtime === "python") {
    const pyContent = fs.readFileSync(fullTargetPath, "utf-8");
    if (!hasPythonMainEntrypoint(pyContent)) {
      warnings.push(`Python entrypoint "${target}" has no __main__ guard; it may exit immediately.`);
    }
    try {
      execSync(`python -m py_compile "${target}"`, { cwd: projectDir, stdio: "pipe" });
    } catch {
      warnings.push(`Python syntax check failed for "${target}".`);
      hardErrors = true;
    }
    try {
      execSync("python -m compileall -q .", { cwd: projectDir, stdio: "pipe" });
    } catch {
      warnings.push("Python project-wide syntax check failed.");
      hardErrors = true;
    }
  } else {
    const jsFiles = normalizedFiles.filter((f) => /\.(js|mjs|cjs)$/i.test(f));
    for (const jsFile of jsFiles) {
      try {
        execSync(`node --check "${jsFile}"`, { cwd: projectDir, stdio: "pipe" });
      } catch {
        warnings.push(`Node syntax check failed for "${jsFile}".`);
        hardErrors = true;
      }
    }
  }

  return { installCmd: nextInstall, runCmd: nextRun, warnings, hardErrors };
}

async function scaffoldProject(
  projectSlug: string,
  sessionId: string,
  apiKey: string,
  signal?: AbortSignal
): Promise<ScaffoldResult | null> {
  const sessionDir = path.resolve(process.cwd(), "relay-output", "sessions", sessionId);
  if (!fs.existsSync(sessionDir)) return null;

  const mdFiles = fs.readdirSync(sessionDir)
    .filter(f => f.endsWith(".md"))
    .sort()
    .map(f => ({ name: f, content: fs.readFileSync(path.join(sessionDir, f), "utf-8") }));

  if (mdFiles.length === 0) return null;

  const context = mdFiles.map(f => `### ${f.name}\n${f.content}`).join("\n\n---\n\n");

  const messages = [
    {
      role: "system",
      content: `You are a file scaffolder. Extract ALL source code files from the generated output and return a single JSON object with this exact structure:
{
  "files": { "relative/path": "complete file content", ... },
  "install_command": "<exact install command or null>",
  "run_command": "<exact run command matching the actual entry point file path>"
}

CRITICAL RULES:
1. ALL files must be placed at the project ROOT - NO subdirectories/nested folders unless absolutely required (like node_modules or __pycache__). Place main.py, index.js, app.py, etc. directly at root, NOT inside a subfolder.
   WRONG: { "my_app/main.py": "..." }
   RIGHT: { "main.py": "..." }
2. The run_command MUST exactly match the entry point file path in "files". If the entry file is "main.py", run_command must be "python main.py". If "index.js", use "node index.js".
3. The install_command and run_command MUST match the actual language of the code.
4. If the code is Android/Kotlin/Java or any mobile framework, rewrite it as a terminal/CLI app in Python or Node.js instead.

Rules:
- "files": map of every source file needed (include package.json/requirements.txt/etc.)
- "install_command": the exact command to install dependencies (e.g. "npm install", "pip install -r requirements.txt"), or null if none needed
- "run_command": the exact command to run the app - must reference the actual file path from "files"
- Output MUST be CLI-only. Never output web/front-end apps, HTML/CSS, React, Next.js, Vite, Vue, Svelte, or browser-only code.
- If the source content looks like a web app, convert it into an equivalent terminal CLI app in Python or Node.js.
- All code must be cross-platform (Windows, Mac, Linux). Never use Unix-only modules (termios, fcntl, select for input, tty). Never use Windows-only modules (msvcrt). Use cross-platform alternatives: curses (with windows-curses in requirements.txt for Python terminal apps), pathlib for paths, os.path for file operations.
- For Python terminal/interactive apps always use the curses module and include "windows-curses; sys_platform == 'win32'" in requirements.txt.
- Output ONLY valid JSON, no markdown, no explanation.`,
    },
    {
      role: "user",
      content: `Extract all source files from this output and return the JSON:\n\n${context}`,
    },
  ];

  const raw = await callOpenRouter("openai/gpt-4o", messages, apiKey, { max_tokens: 12000, temperature: 0, signal });
  const cleaned = raw
    .replace(/```json\s*/gi, "")
    .replace(/```\s*/g, "")
    .trim()
    .replace(/,\s*([\]}])/g, "$1");

  let fileMap: Record<string, string>;
  let installCmd: string | null = null;
  let runCmd: string = "npm start";

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(cleaned) as Record<string, unknown>;
  } catch {
    console.log("  Warning: Could not parse scaffolding response.\n");
    return null;
  }

  // New structured format
  if (parsed.files && typeof parsed.files === "object") {
    fileMap = parsed.files as Record<string, string>;
    installCmd = typeof parsed.install_command === "string" ? parsed.install_command : null;
    runCmd = typeof parsed.run_command === "string" ? parsed.run_command : "npm start";
  } else {
    // Fallback: old flat format (all keys are file paths)
    fileMap = parsed as Record<string, string>;
  }

  // Filter out non-string values (malformed LLM output)
  for (const [key, val] of Object.entries(fileMap)) {
    if (typeof val !== "string") delete fileMap[key];
  }

  if (Object.keys(fileMap).length === 0) {
    console.log("  Warning: No valid files found in scaffolding response.\n");
    return null;
  }

  // Flatten nested files to project root when possible
  // e.g. if all files are under "my_app/", strip that prefix
  const filePaths = Object.keys(fileMap);
  const parts = filePaths.map(p => p.split("/"));
  if (parts.length > 0 && parts.every(p => p.length > 1 && p[0] === parts[0][0])) {
    const prefix = parts[0][0] + "/";
    const flattened: Record<string, string> = {};
    for (const [key, val] of Object.entries(fileMap)) {
      flattened[key.slice(prefix.length)] = val;
    }
    fileMap = flattened;
  }

  // Fix runCmd if it references a file that doesn't exist at root
  // e.g. "python main.py" but actual file is "app.py"
  runCmd = fixRunCommand(runCmd, Object.keys(fileMap).map(normalizePathSlashes));

  const projectDir = path.resolve(process.cwd(), "relay-output", projectSlug);

  // Wipe previous run so no stale files linger
  if (fs.existsSync(projectDir)) {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }

  for (const [filePath, content] of Object.entries(fileMap)) {
    const fullPath = path.join(projectDir, filePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, "utf-8");
  }

  const validated = validateScaffoldCommands(projectDir, Object.keys(fileMap), installCmd, runCmd);
  installCmd = validated.installCmd;
  runCmd = validated.runCmd;
  for (const warning of validated.warnings) {
    console.log(`  Warning: ${warning}`);
  }

  if (installCmd) {
    const stopInstall = startSpinner(`Running ${installCmd}`);
    try {
      execSync(installCmd, { cwd: projectDir, stdio: "pipe" });
      stopInstall();
    } catch {
      stopInstall();
      console.log(`  Warning: ${installCmd} failed - run it manually.\n`);
    }
  }

  writeRunInstructions(projectDir, installCmd, runCmd);
  return {
    projectDir,
    installCmd,
    runCmd,
    warnings: validated.warnings,
    isRunnable: !validated.hardErrors,
  };
}

function printReadySection(projectDir: string, runCmd: string, installCmd: string | null, warnings: string[]): void {
  if (!runCmd || !runCmd.trim()) {
    console.log("  Warning: No run command available. Check the project files manually.\n");
    return;
  }
  const relProjectDir = path.relative(process.cwd(), projectDir);
  const runMe = path.join(relProjectDir, "RUN_ME.txt");

  console.log();
  console.log("-------------------------------------");
  console.log("Your app is ready");
  console.log("-------------------------------------");
  console.log(`Project: ${path.basename(projectDir)}`);
  console.log(`Path: ${projectDir}`);
  console.log();
  console.log("Next steps:");
  console.log(`1) cd ${relProjectDir}`);
  if (installCmd) console.log(`2) ${installCmd}`);
  console.log(`${installCmd ? "3" : "2"}) ${runCmd}`);
  console.log();
  console.log("Notes:");
  console.log("- Relay is configured for CLI-style runnable projects.");
  console.log(`- Full instructions: ${runMe}`);
  if (warnings.length > 0) {
    console.log("- Scaffold warnings:");
    for (const warning of warnings) {
      console.log(`  * ${warning}`);
    }
  }
  console.log();
}

function printNotReadySection(projectDir: string, warnings: string[]): void {
  const relProjectDir = path.relative(process.cwd(), projectDir);
  const runMe = path.join(relProjectDir, "RUN_ME.txt");

  console.log();
  console.log("-------------------------------------");
  console.log("Scaffold Incomplete");
  console.log("-------------------------------------");
  console.log(`Project: ${path.basename(projectDir)}`);
  console.log(`Path: ${projectDir}`);
  console.log("Relay generated files, but validation failed.");
  if (warnings.length > 0) {
    console.log("Validation issues:");
    for (const warning of warnings) {
      console.log(`  * ${warning}`);
    }
  }
  console.log(`Check generated files and instructions: ${runMe}`);
  console.log();
}

function autoRunProject(projectDir: string, runCmd: string): void {
  if (!runCmd || !runCmd.trim()) return;

  console.log("Auto-running the generated app...");
  const runMe = path.join(path.relative(process.cwd(), projectDir), "RUN_ME.txt");

  try {
    if (process.platform === "win32") {
      // Windows MVP: launch a new terminal window and run the app there.
      const escapedDir = projectDir.replace(/'/g, "''");
      const escapedCmd = runCmd.replace(/'/g, "''");
      const ps = `Start-Process powershell -ArgumentList '-NoExit','-Command','Set-Location -LiteralPath ''${escapedDir}''; ${escapedCmd}'`;
      execSync(`powershell -NoProfile -Command "${ps}"`, { stdio: "ignore" });
      console.log("  Opened a new terminal and started the app.\n");
      return;
    }

    // Non-Windows fallback: run in current terminal.
    execSync(runCmd, { cwd: projectDir, stdio: "inherit" });
  } catch {
    console.log(`  Warning: Auto-run failed. Use ${runMe}.\n`);
  }
}

function printSubtaskTeaser(
  summary: string,
  subtasks: Subtask[],
  recipe: string | undefined
): void {
  const recipeKey = recipe === "default" ? undefined : recipe;
  const titleWidth = Math.max(...subtasks.map((s) => s.title.length)) + 2;

  console.log();
  console.log(`  ${summary}`);
  console.log(`  |`);
  for (let i = 0; i < subtasks.length; i++) {
    const s = subtasks[i];
    const isLast = i === subtasks.length - 1;
    const branch = isLast ? "`-" : "|-";
    const route = getBestModel(s.intent, recipeKey);
    const modelLabel = MODEL_LABELS[route.primary] ?? route.primary;
    const intent = s.intent.padEnd(5);
    const title = s.title.padEnd(titleWidth);
    console.log(`  ${branch} ${i + 1}  ${intent}  ${title}  ->  ${modelLabel}`);
  }
  console.log();
}

async function handlePrompt(
  prompt: string,
  recipe: string | undefined,
  dryRun: boolean,
  apiKey: string
): Promise<void> {
  try {
    const decomposition = dryRun
      ? mockDecompose(prompt)
      : await decomposeTask(prompt, apiKey);
    const normalized = forceMultiStep(prompt, decomposition.project_summary, [...decomposition.subtasks]);
    const { project_summary, subtasks } = normalized;

    if (subtasks.length === 0) {
      console.error("Error: No subtasks generated. Try rephrasing your prompt.\n");
      return;
    }

    // Always append a debug pass
    if (!subtasks.some((s) => s.intent === "debug")) {
      subtasks.push({
        title: "Debug & review",
        prompt: "Review all the code produced in the previous steps. Identify and fix any bugs, logic errors, or integration issues between the parts. Output only the corrected files that need changes.",
        intent: "debug",
      });
    }

    const total = subtasks.length;
    const sessionId = Date.now().toString();

    // Fresh run - always clear context so prior sessions don't bleed in
    const relayDir = path.join(os.homedir(), ".relay");
    if (!fs.existsSync(relayDir)) fs.mkdirSync(relayDir, { recursive: true });
    fs.writeFileSync(path.join(relayDir, "context.json"), JSON.stringify({ projectSummary: "", turns: [] }, null, 2), "utf-8");

    printSubtaskTeaser(project_summary, subtasks, recipe);

    for (let i = 0; i < total; i++) {
      const subtask = subtasks[i];

      console.log(`[${i + 1}/${total}] ${subtask.title}`);

    const route = getBestModel(subtask.intent, recipe === "default" ? undefined : recipe);
    const { label: primaryLabel, reason: primaryReason } = getRoutingReason(
      subtask.intent, route.primary, false
    );

    console.log(DIVIDER);
    console.log(` intent: ${subtask.intent}  |  ${primaryLabel}`);
    console.log(` ${primaryReason}`);
    console.log(DIVIDER);

    if (dryRun) {
      console.log(`\n[dry-run] Would call: ${route.primary}`);
      console.log(`[dry-run] Prompt: "${subtask.prompt}"\n`);
      continue;
    }

    const scopedPrompt = `Step ${i + 1}/${total} - ${subtask.title} only. Do not implement other steps. Target a terminal/CLI app only (Node.js or Python). Never generate web apps, React, HTML/CSS frontends, or mobile apps (Android/iOS/Kotlin/Swift).\n\n${subtask.prompt}`;

    // Debug step: spawn 2 subagents in parallel
    if (subtask.intent === "debug") {
      console.log(`\n  * Spawning 2 subagents in parallel`);
      console.log(`  |- Subagent 1  ->  runtime bugs & logic errors`);
      console.log(`  \`- Subagent 2  ->  component integration\n`);

      const stopSpinner = startSpinner("Both subagents running");
      currentAbortController = new AbortController();

      const msgs1 = buildContextMessages(
        scopedPrompt + "\n\nFocus ONLY on: runtime bugs, logic errors, and incorrect behaviour.",
        route.primary, getProjectSummary() || project_summary
      );
      const msgs2 = buildContextMessages(
        scopedPrompt + "\n\nFocus ONLY on: integration issues between the components and modules.",
        route.primary, getProjectSummary() || project_summary
      );

      let r1: string, r2: string;
      try {
        [r1, r2] = await Promise.all([
          callOpenRouter(route.primary, msgs1, apiKey, { signal: currentAbortController.signal }),
          callOpenRouter(route.primary, msgs2, apiKey, { signal: currentAbortController.signal }),
        ]);
      } catch (err) {
        stopSpinner();
        currentAbortController?.abort();
        currentAbortController = null;
        if (err instanceof Error && err.name === "AbortError") {
          console.log("\n  Stopped.\n");
          break;
        }
        throw err;
      }

      stopSpinner();
      currentAbortController = null;

      saveSubtaskOutput("debug-runtime-bugs", i + 1, r1, sessionId);
      saveSubtaskOutput("debug-integration", i + 2, r2, sessionId);

      console.log("  [ok] Subagent 1 - runtime bugs & logic errors\n");
      console.log(truncateResponse(r1) + "\n");
      console.log("  [ok] Subagent 2 - component integration\n");
      console.log(truncateResponse(r2) + "\n");

      addTurn({ role: "user", content: scopedPrompt, intent: subtask.intent, timestamp: new Date().toISOString() });
      addTurn({ role: "assistant", content: r1 + "\n\n---\n\n" + r2, model: route.primary, timestamp: new Date().toISOString() });
      continue;
    }

    const messages = buildContextMessages(
      scopedPrompt,
      route.primary,
      getProjectSummary() || project_summary
    );

    const stopSpinner = startSpinner("Generating");
    currentAbortController = new AbortController();

    let result: Awaited<ReturnType<typeof execute>>;
    try {
      result = await execute(
        messages, route.primary, route.failover, apiKey,
        (model, reason) => {
          stopSpinner();
          const { label: fLabel, reason: fReason } = getRoutingReason(
            subtask.intent, model, true, primaryLabel, reason
          );
          console.log(DIVIDER);
          console.log(` [warn] Switched to ${fLabel}`);
          console.log(` ${fReason}`);
          console.log(DIVIDER);
        },
        currentAbortController.signal
      );
    } catch (err) {
      stopSpinner();
      currentAbortController = null;
      if (err instanceof Error && err.name === 'AbortError') {
        console.log("\n  Stopped.\n");
        break;
      }
      throw err;
    }

    stopSpinner();
    currentAbortController = null;

    const savedPath = saveSubtaskOutput(subtask.title, i + 1, result.response, sessionId);
    console.log("\n" + truncateResponse(result.response) + "\n");
    console.log(`  Saved -> ${savedPath}\n`);

    // Save turns - next subtask's buildContextMessages() picks these up automatically
    addTurn({ role: "user", content: scopedPrompt, intent: subtask.intent, timestamp: new Date().toISOString() });
    addTurn({ role: "assistant", content: result.response, model: result.modelUsed, timestamp: new Date().toISOString() });
  }

    if (project_summary) updateProjectSummary(project_summary);

    if (!dryRun) {
      const projectSlug = buildProjectSlug(project_summary, prompt);

      const stopScaffold = startSpinner("Scaffolding your project");
      currentAbortController = new AbortController();
      try {
        const scaffold = await scaffoldProject(projectSlug, sessionId, apiKey, currentAbortController.signal)
          ?? scaffoldFromSessionFallback(projectSlug, sessionId);
        stopScaffold();
        currentAbortController = null;
        if (scaffold) {
          if (scaffold.isRunnable) {
            printReadySection(scaffold.projectDir, scaffold.runCmd, scaffold.installCmd, scaffold.warnings);
          } else {
            printNotReadySection(scaffold.projectDir, scaffold.warnings);
          }
        } else {
          console.log("  Note: Could not create project files from this run.\n");
        }
      } catch (err) {
        stopScaffold();
        currentAbortController = null;
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`  Note: Could not auto-scaffold project files (${msg}).\n`);
      }
    }
  } finally {
    currentAbortController = null;
  }
}

async function main(): Promise<void> {
  let recipe: string | undefined = undefined;
  let dryRun = false;
  let shuttingDown = false;
  let processingLine = false;
  let sawInputClose = false;

  let apiKey = loadApiKey();
  if (!apiKey || apiKey === "your_openrouter_api_key_here") {
    apiKey = await promptForApiKey();
    if (!apiKey) {
      dryRun = true;
      console.warn("No API key provided - running in dry-run mode.\n");
    }
  }

  printWelcome(recipe ?? "default");

  const commands = ["/recipe the-duo", "/recipe default", "/dry-run", "/help", "/exit"];

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "relay > ",
    completer: (line: string) => {
      const hits = commands.filter(c => c.startsWith(line));
      return [hits.length ? hits : commands, line];
    },
  });

  const shutdown = (withLeadingNewline = false): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (withLeadingNewline) process.stdout.write("\n");
    console.log("Goodbye.");
    rl.close();
  };

  rl.prompt();

  rl.on("line", async (line) => {
    const input = line.trim();

    if (!input) {
      rl.prompt();
      return;
    }

    // In piped/headless mode, additional lines can arrive while a run is in progress.
    // Defer exit until current processing completes; ignore other extra lines.
    if (processingLine) {
      if (input === "exit" || input === "/exit") {
        sawInputClose = true;
      }
      return;
    }
    processingLine = true;

    // Handle commands
    if (input === "exit" || input === "/exit") {
      processingLine = false;
      shutdown();
      return;
    }

    if (input === "/help") {
      processingLine = false;
      printHelp();
      rl.prompt();
      return;
    }

    if (input === "/dry-run") {
      processingLine = false;
      dryRun = !dryRun;
      console.log(`Dry-run mode: ${dryRun ? "ON" : "OFF"}`);
      rl.prompt();
      return;
    }

    if (input.startsWith("/recipe")) {
      const name = input.split(/\s+/)[1];
      if (!name) {
        console.log("Usage: /recipe the-duo  or  /recipe default");
      } else if (name !== "default" && !listRecipes().includes(name)) {
        console.log(`Unknown recipe "${name}". Available: default, ${listRecipes().join(", ")}`);
      } else {
        recipe = name === "default" ? undefined : name;
        if (recipe) {
          console.log(`Recipe: ${describeRecipe(recipe)}\n`);
          printRecipeTable(recipe);
        } else {
          console.log(`Recipe: default\n`);
          printRecipeTable(undefined);
        }
      }
      processingLine = false;
      rl.prompt();
      return;
    }

    // It's a prompt - pause readline while we process
    rl.pause();

    try {
      await handlePrompt(input, recipe, dryRun, apiKey ?? "");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Error: ${msg}`);
    } finally {
      processingLine = false;
    }

    if (sawInputClose) {
      rl.close();
      return;
    }
    rl.resume();
    rl.prompt();
  });

  rl.on("close", () => {
    if (processingLine) {
      sawInputClose = true;
      return;
    }
    process.exit(0);
  });
}

main().catch((err) => {
  console.error(`Fatal error: ${err.message}`);
  process.exit(1);
});

