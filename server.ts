#!/usr/bin/env bun
/**
 * Pane orchestration plugin for Claude Code.
 *
 * MCP adapter over pane-tools. Exposes agent lifecycle, tab/slot management,
 * and screen I/O as tools.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Orchestrator, iterm } from "@agiterra/pane-tools";
import { loadOrCreateKey, register, setPlan } from "@agiterra/wire-tools";
import { execSync } from "child_process";

const orchestrator = new Orchestrator();
const CALLER_AGENT_ID =
  process.env.PANE_AGENT_ID ?? process.env.WIRE_AGENT_ID ?? "unknown";
let keyPair: Awaited<ReturnType<typeof loadOrCreateKey>> | null = null;

// Resolve the caller's iTerm2 session by finding the TTY of the parent process.
// More reliable than ITERM_SESSION_ID env var which goes stale on restart.
let _callerSessionCache: string | undefined;

async function callerSession(): Promise<string | undefined> {
  if (_callerSessionCache) return _callerSessionCache;

  // Try TTY lookup first (always current)
  try {
    const tty = execSync(`ps -o tty= -p ${process.ppid}`, { encoding: "utf-8" }).trim();
    if (tty && tty !== "??") {
      const id = await iterm.sessionIdForTty(tty);
      if (id) {
        _callerSessionCache = id;
        return id;
      }
    }
  } catch {}

  // Fall back to env var
  const raw = process.env.ITERM_SESSION_ID;
  if (raw) {
    _callerSessionCache = raw.split(":")[1];
    return _callerSessionCache;
  }

  return undefined;
}

// --- MCP server ---

const mcp = new Server(
  { name: "pane", version: "0.1.0" },
  {
    capabilities: { tools: {} },
    instructions:
      "Agent pane orchestrator. Launch agents in persistent screen sessions, " +
      "manage tabs and slots (iTerm2 panes), attach/detach agents, read/send " +
      "to agent screens. Agents survive terminal crashes and run whether or not " +
      "they're attached to a visible pane.",
  },
);

// --- Tools ---

const TOOLS = [
  {
    name: "agent_launch",
    description: "Launch an agent in a persistent screen session",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "Agent ID (Wire agent name)" },
        name: { type: "string", description: "Display name" },
        plan: { type: "string", description: "Initial plan (shown on Wire dashboard)" },
        runtime: { type: "string", description: "Runtime: claude-code, codex, etc. Default: claude-code" },
        project_dir: { type: "string", description: "Working directory for the agent" },
        extra_flags: { type: "string", description: "Additional CLI flags" },
      },
      required: ["id", "name"],
    },
  },
  {
    name: "agent_stop",
    description: "Stop an agent (kills screen session)",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "Agent ID" },
      },
      required: ["id"],
    },
  },
  {
    name: "agent_list",
    description: "List all agents with status, slot, and runtime",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "agent_attach",
    description: "Attach an agent to a slot (make visible in a pane)",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "Agent ID" },
        slot: { type: "string", description: "Slot name" },
      },
      required: ["id", "slot"],
    },
  },
  {
    name: "agent_detach",
    description: "Detach an agent from its slot (keeps running in background)",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "Agent ID" },
      },
      required: ["id"],
    },
  },
  {
    name: "agent_move",
    description: "Move an agent to a different slot",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "Agent ID" },
        slot: { type: "string", description: "Target slot name" },
      },
      required: ["id", "slot"],
    },
  },
  {
    name: "agent_swap",
    description: "Swap two agents' slots",
    inputSchema: {
      type: "object" as const,
      properties: {
        id_a: { type: "string", description: "First agent ID" },
        id_b: { type: "string", description: "Second agent ID" },
      },
      required: ["id_a", "id_b"],
    },
  },
  {
    name: "agent_send",
    description: "Send keystrokes to an agent's screen session",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "Agent ID" },
        text: { type: "string", description: "Text to send (include \\n for enter)" },
      },
      required: ["id", "text"],
    },
  },
  {
    name: "agent_interrupt",
    description: "Interrupt an agent. Returns screen output so you can assess the result.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "Agent ID" },
        background: { type: "boolean", description: "If true, Ctrl-B Ctrl-B (background task). Default: Escape (cancel)." },
      },
      required: ["id"],
    },
  },
  {
    name: "agent_read",
    description: "Read an agent's current screen output",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "Agent ID" },
      },
      required: ["id"],
    },
  },
  {
    name: "tab_create",
    description: "Create a named tab (workstream container)",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Tab name" },
      },
      required: ["name"],
    },
  },
  {
    name: "tab_list",
    description: "List all tabs",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "tab_destroy",
    description: "Destroy a tab and its slots",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Tab name" },
      },
      required: ["name"],
    },
  },
  {
    name: "slot_register",
    description: "Register your own iTerm2 pane as a named slot (uses your ITERM_SESSION_ID)",
    inputSchema: {
      type: "object" as const,
      properties: {
        tab: { type: "string", description: "Tab name (created if missing)" },
        name: { type: "string", description: "Slot name for your pane" },
      },
      required: ["tab", "name"],
    },
  },
  {
    name: "slot_create",
    description: "Create a named slot by splitting an iTerm2 pane",
    inputSchema: {
      type: "object" as const,
      properties: {
        tab: { type: "string", description: "Tab name" },
        name: { type: "string", description: "Slot name" },
        position: { type: "string", description: "Split direction: below (default), right, left, above" },
        relative_to: { type: "string", description: "Slot name or session UUID to split from (default: caller's pane)" },
      },
      required: ["tab", "name"],
    },
  },
  {
    name: "slot_badge",
    description: "Set the iTerm2 badge on a slot's pane (overlay text in corner)",
    inputSchema: {
      type: "object" as const,
      properties: {
        slot: { type: "string", description: "Slot name" },
        text: { type: "string", description: "Badge text (e.g. 'ENG-1234\\nsoil-app PR #42')" },
      },
      required: ["slot", "text"],
    },
  },
  {
    name: "slot_list",
    description: "List all slots, optionally filtered by tab",
    inputSchema: {
      type: "object" as const,
      properties: {
        tab: { type: "string", description: "Optional tab filter" },
      },
    },
  },
  {
    name: "slot_destroy",
    description: "Destroy a slot (closes iTerm2 pane, detaches any agent first)",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Slot name" },
      },
      required: ["name"],
    },
  },
  {
    name: "url_open",
    description: "Open a URL in a new pane (splits current pane, opens URL in browser)",
    inputSchema: {
      type: "object" as const,
      properties: {
        tab: { type: "string", description: "Tab name (must exist)" },
        slot: { type: "string", description: "Slot name (auto-generated if omitted)" },
        url: { type: "string", description: "URL to open" },
        position: { type: "string", description: "Split direction: below (default), right" },
        relative_to: { type: "string", description: "Slot name to split from (default: caller's pane)" },
      },
      required: ["tab", "url"],
    },
  },
  {
    name: "reconcile",
    description: "Sync DB state with running screen sessions. Run on boot or to check health.",
    inputSchema: { type: "object" as const, properties: {} },
  },
];

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  const a = (args ?? {}) as Record<string, unknown>;

  try {
    let result: unknown;

    switch (name) {
      case "agent_launch": {
        const agentId = a.id as string;
        const displayName = a.name as string;
        const wireUrl = process.env.WIRE_URL ?? "http://localhost:9800";

        // Pre-register ephemeral agent on Wire using the spawning agent's key
        if (keyPair) {
          try {
            const newKp = await loadOrCreateKey(agentId);
            await register(wireUrl, agentId, displayName, newKp.publicKey, keyPair.privateKey);
            // Set initial plan if provided
            if (a.plan) {
              await setPlan(wireUrl, agentId, a.plan as string, newKp.privateKey);
            }
          } catch (e: any) {
            // Non-fatal — agent may already be registered
            console.error(`[pane] pre-register ${agentId}: ${e.message}`);
          }
        }

        result = await orchestrator.launchAgent({
          id: agentId,
          displayName,
          runtime: a.runtime as string | undefined,
          projectDir: a.project_dir as string | undefined,
          extraFlags: a.extra_flags as string | undefined,
        });
        break;
      }
      case "agent_interrupt":
        result = await orchestrator.interruptAgent(a.id as string, !!a.background);
        break;
      case "agent_stop":
        await orchestrator.stopAgent(a.id as string);
        result = { stopped: a.id };
        break;
      case "agent_list":
        result = orchestrator.listAgents();
        break;
      case "agent_attach":
        await orchestrator.attachAgent(a.id as string, a.slot as string);
        result = { attached: a.id, slot: a.slot };
        break;
      case "agent_detach":
        await orchestrator.detachAgent(a.id as string);
        result = { detached: a.id };
        break;
      case "agent_move":
        await orchestrator.moveAgent(a.id as string, a.slot as string);
        result = { moved: a.id, slot: a.slot };
        break;
      case "agent_swap":
        await orchestrator.swapAgents(a.id_a as string, a.id_b as string);
        result = { swapped: [a.id_a, a.id_b] };
        break;
      case "agent_send":
        await orchestrator.sendToAgent(a.id as string, a.text as string);
        result = { sent: true };
        break;
      case "agent_read":
        result = { output: await orchestrator.readAgent(a.id as string) };
        break;
      case "tab_create":
        result = orchestrator.createTab(a.name as string);
        break;
      case "tab_list":
        result = orchestrator.listTabs();
        break;
      case "tab_destroy":
        orchestrator.deleteTab(a.name as string);
        result = { destroyed: a.name };
        break;
      case "slot_register": {
        const itermId = await callerSession();
        if (!itermId) throw new Error("ITERM_SESSION_ID not set — cannot register pane");
        // Auto-create tab if needed
        if (!orchestrator.store.getTab(a.tab as string)) {
          orchestrator.createTab(a.tab as string);
        }
        result = orchestrator.registerSlot(a.tab as string, a.name as string, itermId);
        break;
      }
      case "slot_create":
        result = await orchestrator.createSlot(
          a.tab as string,
          a.name as string,
          a.position as string | undefined,
          (a.relative_to as string) ?? await callerSession(),
        );
        break;
      case "slot_badge":
        await orchestrator.setBadge(a.slot as string, a.text as string);
        result = { badge_set: a.slot, text: a.text };
        break;
      case "slot_list":
        result = orchestrator.listSlots(a.tab as string | undefined);
        break;
      case "slot_destroy":
        await orchestrator.deleteSlot(a.name as string);
        result = { destroyed: a.name };
        break;
      case "url_open":
        result = await orchestrator.openUrl({
          tab: a.tab as string,
          slot: a.slot as string | undefined,
          url: a.url as string,
          position: a.position as string | undefined,
          relativeTo: (a.relative_to as string) ?? await callerSession(),
        });
        break;
      case "reconcile":
        result = { report: await orchestrator.reconcile() };
        break;
      default:
        throw new Error(`unknown tool: ${name}`);
    }

    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    };
  } catch (e: any) {
    const detail = e.stderr
      ? `${e.message}\nstderr: ${e.stderr}\nexit: ${e.exitCode}`
      : e.stack ?? e.message;
    return {
      content: [{ type: "text" as const, text: `error: ${detail}` }],
      isError: true,
    };
  }
});

// --- Main ---

async function main(): Promise<void> {
  // Load spawning agent's key for pre-registering ephemeral agents
  try {
    keyPair = await loadOrCreateKey(CALLER_AGENT_ID);
  } catch (e) {
    console.error(`[pane] key load failed for ${CALLER_AGENT_ID}:`, e);
  }

  const transport = new StdioServerTransport();
  await mcp.connect(transport);

  // Reconcile on boot
  const report = await orchestrator.reconcile();
  console.error(`[pane] boot reconcile:\n${report}`);
  console.error(`[pane] ready (caller=${CALLER_AGENT_ID})`);
}

main().catch((e) => {
  console.error("[pane] fatal:", e);
  process.exit(1);
});
