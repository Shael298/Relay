# Relay

Combine the best of all coding models.

## TL;DR
Relay is a native CLI tool that breaks your coding prompts into subtasks and assigns each to the best model for the job. It orchestrates a high-fidelity relay, sending UI tasks to Claude 4.6 and complex logic to GPT-5.3 Codex. If a model produces an error, Relay automatically triggers a "failover" to a rival model family to fix the mistake. Then, all the code is scaffolded together into a final file.

## 5 Core Features
1) Intent Classifier: Uses a lightning-fast model to instantly categorize your request into specialized tracks like Architecture, UI Design, or Logic Implementation.
2) Dynamic Model Map: A real-time routing table that sends each specific task to the current SOTA model best suited for it (e.g., UI to Claude, Backend Logic to GPT).
3) Double-Check Loop: An automated sanity check that detects non-compiling code or linting errors and triggers a "Failover" to a rival model family to fix the mistake.
4) Context Sync: A persistent "Global State" node that summarizes and transfers technical specs between different models so no context is lost during handoffs.
5) Recipes: Custom recipes that allow you to lock specific models to specific stages, like forcing Opus for planning and Codex for execution.
  i) Default Recipe
  | Intent | Primary | Failover |
  |---|---|---|
  | PLAN | Claude Opus 4.6 | GPT-4o |
  | UI | Claude 3.7 Sonnet | Gemini 2.0 Flash |
  | LOGIC | GPT-5.3 Codex | Claude Opus 4.6 |
  | DEBUG | Claude 3.5 Haiku | GPT-4o |
  ii) The-Duo Recipe
  | Intent | Primary | Failover |
  |---|---|---|
  | PLAN | Claude Opus 4.6 | GPT-5.3 Codex |
  | UI | GPT-5.3 Codex | Claude Opus 4.6 |
  | LOGIC | GPT-5.3 Codex | Claude Opus 4.6 |
  | DEBUG | Claude Opus 4.6 | GPT-5.3 Codex |

## Scope for Alpha Prototype

- This is an early alpha, so some scaffolds can still need manual fixes in some runs.
- CLI apps only currently (no web/mobile output)
- Writes generated project into `relay-output/<project-name>`
- Prints clear handoff commands (`cd`, install, run)
- Runs scaffold validation before marking projects as ready

## Compared to perplexity computer
1) Native CLI tool vs cloud-based, with laser focus on coding dev workflow
2) Pay as you go through openrouter, no need for $200 subscription
3) Raw model integrity vs silent downgrades (Perpelxity has been caught doing this)

## Requirements

- Node.js 18+
- OpenRouter API key: https://openrouter.ai/keys

## Install

```bash
git clone https://github.com/Shael298/Relay.git
cd relay
npm install
npm run build
npm link
```

Run with:

```bash
relay
```

## First Run

On first launch, Relay asks for your OpenRouter API key and stores it at:

- `~/.relay/config`

The key is not written into project source files.

## Developer Onboarding

1. Install Node.js.
2. Clone repo and run `npm install`.
3. Run `npm run build` and `npm link`.
4. Start Relay with `relay`.
5. Enter a prompt like: `build a command-line todo app in Python`.
6. Follow the printed commands:
   - `cd <generated-project>`
   - install command (if shown)
   - run command

## Commands

```text
/recipe the-duo
/recipe default
/dry-run
/help
exit
```

## Example Prompts

- `build a command-line todo app in Python`
- `build a Node.js CLI expense tracker with JSON storage`
- `build a terminal flashcard quiz app in Python`
