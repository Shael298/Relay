# Relay

Relay is a Windows-first CLI that takes one prompt and scaffolds a runnable **CLI app** (Node.js or Python) to disk.

## Scope (Current MVP)

- CLI apps only (no web/mobile output)
- Multi-step model routing with failover
- Writes generated project into `relay-output/<project-name>`
- Prints clear handoff commands (`cd`, install, run)
- Does **not** auto-run generated apps
- Runs scaffold validation before marking projects as ready

## Alpha Status

- This is an early alpha.
- Generated projects can still need manual fixes in some runs.
- If validation fails, Relay marks the scaffold as incomplete instead of claiming success.

## Requirements

- Node.js 18+
- OpenRouter API key: https://openrouter.ai/keys

## Install

```bash
git clone https://github.com/<your-org-or-user>/relay
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
