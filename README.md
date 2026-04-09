# Crew

Multi-agent orchestration for Claude Code. Launch agents in persistent screen sessions, arrange them in iTerm2 panes with themed backgrounds, and communicate between them.

## Prerequisites

- macOS with [iTerm2](https://iterm2.com/)
- `screen` (`brew install screen` if missing)
- [Bun](https://bun.sh) (auto-installed on first plugin install if missing)

## Install

```
/plugin install agiterra/crew
```

## What It Does

Crew manages three independent layers:

- **Agents** — Claude Code instances running in persistent `screen` sessions. Survive pane closes and terminal crashes.
- **Panes** — iTerm2 pane viewports. Think of them as conference rooms — agents sit in them but don't own them.
- **Tabs** — iTerm2 tabs containing layouts of panes.

Agents and panes are independent. An agent can run without a pane (headless), and a pane can exist without an agent (empty shell).

## Capabilities

### Launch and manage agents

```
"Launch an agent called 'reviewer' in ~/Projects/my-app with the prompt 'Review the PR for security issues'"
"Stop the reviewer agent"
"List all running agents"
"Read what the reviewer agent is doing"
"Send 'focus on the auth module' to the reviewer"
```

### Arrange agents in panes

```
"Create a new tab called 'engineering' with the trees theme"
"Create a pane in the engineering tab"
"Attach the reviewer agent to the oak pane"
"Detach the reviewer from its pane"
"Move the reviewer to the maple pane"
"Swap the reviewer and planner agents"
```

### Pane themes

Themes auto-name panes and set background images. Built-in themes: `trees`, `cities`, `rivers`, `stones`, `peaks`, `spices`.

```
"Create a tab called 'team' with the cities theme"
"Build a new theme based on mountains"
```

Each pane gets a unique name from the theme pool (e.g., `oak`, `maple`, `cedar` for the trees theme) and a matching background image at 50% blend.

### Monitor and recover

```
"Run reconcile to check agent/pane state"
"Show crew status"
"Read the output from all agents"
```

## Standard Workflow

A typical session looks like:

1. **Create a tab** — `tab_create` makes a new iTerm2 tab with an optional theme
2. **Create panes** — `pane_create` splits panes in the tab with themed names and backgrounds
3. **Launch agents** — `agent_launch` starts Claude Code in a screen session
4. **Attach** — `agent_attach` connects an agent's screen to a pane so you can see it
5. **Send work** — `agent_send` delivers prompts to running agents

## Configuration

| Env var | Default | Description |
|---------|---------|-------------|
| `WIRE_URL` | `http://localhost:9800` | Wire server URL (for agent identity) |
| `WIRE_PRIVATE_KEY` | — | Ed25519 private key for agent registration |

No env vars are required for basic local use. Wire integration enables inter-agent messaging and identity.

## Architecture

- Agents run in GNU `screen` sessions (persistent, survives terminal crashes)
- iTerm2 integration via AppleScript (`osascript`)
- Pane backgrounds use iTerm2 Dynamic Profiles
- State stored in SQLite (`~/.crew/crew.db`)
- Agent identity + crypto via `@agiterra/wire-tools`
