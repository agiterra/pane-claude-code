# Crew

Multi-agent orchestration for Claude Code. Launch agents in persistent screen sessions, arrange them in terminal panes with themed backgrounds, and communicate between them.

Supports both **[cmux](https://cmux.com)** and **iTerm2** as terminal backends, with auto-detection.

## Prerequisites

- macOS with [cmux](https://cmux.com) (recommended) or [iTerm2](https://iterm2.com/)
- `screen` (`brew install screen` if missing)
- [Bun](https://bun.sh) (auto-installed on first plugin install if missing)

## Install

```
/plugin install agiterra/crew
```

## What It Does

Crew manages three independent layers:

- **Agents** — Claude Code instances running in persistent `screen` sessions. Survive pane closes and terminal crashes.
- **Panes** — Terminal pane viewports. Think of them as conference rooms — agents sit in them but don't own them.
- **Tabs** — Terminal tabs/workspaces containing layouts of panes.

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

Themes auto-name panes and set background images (iTerm2) or sidebar metadata (cmux). Built-in themes: `trees`, `cities`, `rivers`, `stones`, `peaks`, `spices`.

```
"Create a tab called 'team' with the cities theme"
"Build a new theme based on mountains"
```

Each pane gets a unique name from the theme pool (e.g., `oak`, `maple`, `cedar` for the trees theme) and a matching background image at 50% blend (iTerm2 only).

### Monitor and recover

```
"Run reconcile to check agent/pane state"
"Show crew status"
"Read the output from all agents"
```

## Standard Workflow

A typical session looks like:

1. **Create a tab** — `tab_create` makes a new terminal tab/workspace with an optional theme
2. **Create panes** — `pane_create` splits panes in the tab with themed names
3. **Launch agents** — `agent_launch` starts Claude Code in a screen session
4. **Attach** — `agent_attach` connects an agent's screen to a pane so you can see it
5. **Send work** — `agent_send` delivers prompts to running agents

## Terminal Backend

Crew auto-detects which terminal you're running in:

| Terminal | Detection | Features |
|----------|-----------|----------|
| **cmux** | `CMUX_SURFACE_ID` env var | Split panes, embedded browser, sidebar metadata, notifications |
| **iTerm2** | Default fallback | Split panes, AppleScript control, dynamic profiles, background images |

Override with the `CREW_TERMINAL` env var:

```bash
export CREW_TERMINAL=cmux   # Force cmux backend
export CREW_TERMINAL=iterm  # Force iTerm2 backend
```

## Configuration

| Env var | Default | Description |
|---------|---------|-------------|
| `CREW_TERMINAL` | auto-detect | Terminal backend: `cmux` or `iterm` |
| `CREW_NOTIFY` | `0` (off) | Set to `1` to forward Claude Code Notification/Stop events to cmux (macOS banners). Off by default since v1.2.3 — opt in only if you want the dings. |
| `WIRE_URL` | `http://localhost:9800` | Wire server URL (for agent identity) |
| `WIRE_PRIVATE_KEY` | — | Ed25519 private key for agent registration |

No env vars are required for basic local use. Wire integration enables inter-agent messaging and identity.

### Notifications

Crew ships `Notification` and `Stop` hooks that can forward Claude Code's "waiting for input" and "agent stopped" events to cmux, which produces macOS notification banners. This is **off by default** as of v1.2.3 — operators managing multiple agents typically find the stream of banners more noise than signal.

To enable, export `CREW_NOTIFY=1` before launching the agent:

```bash
# In your shell rc, or per-agent .env file:
export CREW_NOTIFY=1
```

Requires cmux on `PATH` (the hook is a no-op otherwise).

## Architecture

- Agents run in GNU `screen` sessions (persistent, survives terminal crashes)
- Terminal backend abstraction supports cmux and iTerm2
- cmux: uses CLI/socket API for pane operations
- iTerm2: uses AppleScript (`osascript`) and Dynamic Profiles for backgrounds
- State stored in SQLite (`~/.wire/crews.db`)
- Agent identity + crypto via `@agiterra/wire-tools`
