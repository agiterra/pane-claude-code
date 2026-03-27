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
import { Orchestrator } from "@agiterra/pane-tools";

const orchestrator = new Orchestrator();

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
    name: "slot_create",
    description: "Create a named slot (pane viewport) in a tab",
    inputSchema: {
      type: "object" as const,
      properties: {
        tab: { type: "string", description: "Tab name" },
        name: { type: "string", description: "Slot name" },
        position: { type: "string", description: "Position hint (nw, ne, sw, se, etc.)" },
      },
      required: ["tab", "name"],
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
    description: "Destroy a slot (detaches any agent first)",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Slot name" },
      },
      required: ["name"],
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
      case "agent_launch":
        result = await orchestrator.launchAgent({
          id: a.id as string,
          displayName: a.name as string,
          runtime: a.runtime as string | undefined,
          projectDir: a.project_dir as string | undefined,
          extraFlags: a.extra_flags as string | undefined,
        });
        break;
      case "agent_stop":
        await orchestrator.stopAgent(a.id as string);
        result = { stopped: a.id };
        break;
      case "agent_list":
        result = orchestrator.listAgents();
        break;
      case "agent_attach":
        orchestrator.attachAgent(a.id as string, a.slot as string);
        result = { attached: a.id, slot: a.slot };
        break;
      case "agent_detach":
        orchestrator.detachAgent(a.id as string);
        result = { detached: a.id };
        break;
      case "agent_move":
        orchestrator.moveAgent(a.id as string, a.slot as string);
        result = { moved: a.id, slot: a.slot };
        break;
      case "agent_swap":
        orchestrator.swapAgents(a.id_a as string, a.id_b as string);
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
      case "slot_create":
        result = orchestrator.createSlot(a.tab as string, a.name as string, a.position as string | undefined);
        break;
      case "slot_list":
        result = orchestrator.listSlots(a.tab as string | undefined);
        break;
      case "slot_destroy":
        orchestrator.deleteSlot(a.name as string);
        result = { destroyed: a.name };
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
    return {
      content: [{ type: "text" as const, text: `error: ${e.message}` }],
      isError: true,
    };
  }
});

// --- Main ---

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await mcp.connect(transport);

  // Reconcile on boot
  const report = await orchestrator.reconcile();
  console.error(`[pane] boot reconcile:\n${report}`);
  console.error("[pane] ready");
}

main().catch((e) => {
  console.error("[pane] fatal:", e);
  process.exit(1);
});
