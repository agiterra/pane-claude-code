#!/usr/bin/env bun
/**
 * Crew orchestration plugin for Claude Code.
 *
 * MCP adapter over crew-tools. Exposes agent lifecycle, tab/pane management,
 * and screen I/O as tools.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Orchestrator, iterm } from "@agiterra/crew-tools";
import { generateKeyPair, exportPrivateKey, register, setPlan } from "@agiterra/wire-tools";
import { execSync } from "child_process";
import { join } from "path";

const orchestrator = new Orchestrator();
const CALLER_AGENT_ID =
  process.env.CREW_AGENT_ID ?? process.env.WIRE_AGENT_ID ?? "unknown";
let keyPair: { publicKey: string; privateKey: CryptoKey } | null = null;

// Resolve the caller's iTerm2 session by finding the TTY of the parent process.
// More reliable than ITERM_SESSION_ID env var which goes stale on restart.
/**
 * Resolve the caller's iTerm2 session ID.
 * No caching — the session can change after screen detach/reattach.
 */
async function callerSession(): Promise<string | undefined> {
  // Try TTY lookup first (always current)
  try {
    const tty = execSync(`ps -o tty= -p ${process.ppid}`, { encoding: "utf-8" }).trim();
    if (tty && tty !== "??") {
      const id = await iterm.sessionIdForTty(tty);
      if (id) return id;
    }
  } catch (e) {
    console.error(`[crew] TTY lookup failed for ppid ${process.ppid}:`, e);
  }

  // Fall back to env var (may be stale for long-running screen sessions)
  const raw = process.env.ITERM_SESSION_ID;
  if (raw) return raw.split(":")[1];

  return undefined;
}

// --- MCP server ---

const mcp = new Server(
  { name: "crew", version: "0.2.0" },
  {
    capabilities: { tools: {} },
    instructions:
      "Crew manages agents across three independent layers:\n" +
      "- AGENT = the full stack: identity + CC session + CC process + screen. 1:1:1:1. Survives pane closes and terminal crashes.\n" +
      "- PANE = an iTerm2 pane. A viewport — nothing more. Think of panes as conference rooms.\n" +
      "- TAB = an iTerm2 tab containing a layout of panes.\n\n" +
      "Agents and panes are independent. An agent can run without a pane (headless), " +
      "and a pane can exist without an agent (empty shell). " +
      "`agent_attach` connects an agent's screen to a pane. `agent_detach` disconnects without stopping the agent.\n\n" +
      "Standard sequence: agent_launch → pane_create → agent_attach → agent_send '\\r' (confirm dev-channel prompt).\n\n" +
      "RULES:\n" +
      "- Name panes by position or purpose (e.g. 'engineering-nw', 'oak', 'review-left'), NOT by agent name. " +
      "Agents don't own rooms — they sit in them.\n" +
      "- To close a pane you no longer need: agent_detach first (if occupied), then pane_close.\n" +
      "- To stop watching an agent without closing the pane: agent_detach.\n" +
      "- To kill an agent: agent_stop (screen dies, pane stays). Then pane_close if you want the pane gone too.\n" +
      "- NEVER close a pane you are sitting in — it will kill your process.",
  },
);

// --- Tools ---

const TOOLS = [
  {
    name: "agent_launch",
    description: "Launch an agent in a persistent screen session (runs headless until attached to a pane)",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "Agent ID (Wire agent name)" },
        name: { type: "string", description: "Display name" },
        plan: { type: "string", description: "Initial plan (shown on Wire dashboard)" },
        prompt: { type: "string", description: "Initial prompt — the agent's task. Passed as positional arg to claude." },
        runtime: { type: "string", description: "Runtime: claude-code, codex, etc. Default: claude-code" },
        project_dir: { type: "string", description: "Working directory for the agent" },
        extra_flags: { type: "string", description: "Additional CLI flags" },
      },
      required: ["id", "name"],
    },
  },
  {
    name: "agent_register",
    description: "Register yourself as a crew agent. Call this on boot if you're running in a screen session. Auto-links to your pane if one exists with the same name.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "Agent ID (your Wire agent name)" },
        name: { type: "string", description: "Display name" },
        runtime: { type: "string", description: "Runtime: claude-code, codex, etc. Default: claude-code" },
      },
      required: ["id", "name"],
    },
  },
  {
    name: "agent_stop",
    description: "Stop an agent (kills the screen session). The pane stays open — use pane_close separately if you want the pane gone too.",
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
    description: "List all agents with status, pane, and runtime",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "agent_attach",
    description: "Attach an agent's screen session to a pane, making it visible. If another agent occupies the pane, it is detached first.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "Agent ID" },
        pane: { type: "string", description: "Pane name" },
      },
      required: ["id", "pane"],
    },
  },
  {
    name: "agent_detach",
    description: "Detach an agent from its pane. The agent keeps running headless in its screen session. The pane stays open with an empty shell. Use this to free a pane without stopping the agent.",
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
    description: "Move an agent to a different pane",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "Agent ID" },
        pane: { type: "string", description: "Target pane name" },
      },
      required: ["id", "pane"],
    },
  },
  {
    name: "agent_swap",
    description: "Swap two agents' panes",
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
    description: "Send keystrokes to an agent's screen session. Works whether the agent is attached to a pane or running headless.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "Agent ID" },
        text: { type: "string", description: "Text to send (use \\r for enter in screen sessions)" },
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
    description: "Read an agent's current screen output. Works whether the agent is attached to a pane or running headless.",
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
    description: "Create a named tab (iTerm2 tab — a container for panes). Optionally set a theme for auto-naming panes.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Tab name" },
        theme: { type: "string", description: "Pane naming theme: trees, rivers, stones, peaks, spices. Panes created without a name get one from this pool." },
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
    description: "Destroy a tab and all its panes. Agents in those panes are detached (keep running headless). NEVER destroy a tab containing a pane you are sitting in.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Tab name" },
      },
      required: ["name"],
    },
  },
  {
    name: "pane_register",
    description: "Register your own iTerm2 pane. Call this at session start so other agents can split relative to your pane. If no name is given, one is auto-assigned from the tab's theme.",
    inputSchema: {
      type: "object" as const,
      properties: {
        tab: { type: "string", description: "Tab name (created if missing)" },
        name: { type: "string", description: "Pane name (optional — auto-assigned from tab theme if omitted)" },
      },
      required: ["tab"],
    },
  },
  {
    name: "pane_create",
    description: "Create a pane by splitting an existing iTerm2 pane. If no name is given, one is auto-assigned from the tab's theme.",
    inputSchema: {
      type: "object" as const,
      properties: {
        tab: { type: "string", description: "Tab name" },
        name: { type: "string", description: "Pane name (optional — auto-assigned from tab theme if omitted)" },
        position: { type: "string", description: "Split direction: below (default), right, left, above" },
        relative_to: { type: "string", description: "Pane name or session UUID to split from (default: caller's pane)" },
      },
      required: ["tab"],
    },
  },
  {
    name: "pane_send",
    description: "Send keystrokes to a pane's iTerm2 session. Works whether or not an agent is attached.",
    inputSchema: {
      type: "object" as const,
      properties: {
        pane: { type: "string", description: "Pane name" },
        text: { type: "string", description: "Text to send" },
      },
      required: ["pane", "text"],
    },
  },
  {
    name: "pane_badge",
    description: "Set the iTerm2 badge on a pane (overlay text in corner)",
    inputSchema: {
      type: "object" as const,
      properties: {
        pane: { type: "string", description: "Pane name" },
        text: { type: "string", description: "Badge text (e.g. 'ENG-1234\\nsoil-app PR #42')" },
      },
      required: ["pane", "text"],
    },
  },
  {
    name: "pane_list",
    description: "List all panes, optionally filtered by tab",
    inputSchema: {
      type: "object" as const,
      properties: {
        tab: { type: "string", description: "Optional tab filter" },
      },
    },
  },
  {
    name: "pane_close",
    description: "Close a pane (closes the iTerm2 pane and removes it). Detaches any agent first (agent keeps running headless). NEVER close a pane you are sitting in. To stop watching an agent without closing the pane, use agent_detach instead.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Pane name" },
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
        pane: { type: "string", description: "Pane name (auto-generated if omitted)" },
        url: { type: "string", description: "URL to open" },
        position: { type: "string", description: "Split direction: below (default), right" },
        relative_to: { type: "string", description: "Pane name to split from (default: caller's pane)" },
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

        // Check if agent already exists on Wire (permanent agents manage their own keys)
        let privateKeyB64: string | undefined;
        const agentsRes = await fetch(`${wireUrl}/agents`);
        const agents = await agentsRes.json() as any[];
        const existing = agents.find((ag: any) => ag.id === agentId);

        if (existing?.permanent) {
          // Permanent agent — don't pre-register, don't generate keys.
          // Agent has its own key in .env and is already registered.
          if (a.plan && keyPair) {
            // Set plan using caller's key on behalf of the agent won't work —
            // the agent will set its own plan after boot.
          }
        } else {
          // Ephemeral agent — pre-register on Wire using the spawning agent's key
          if (!keyPair) throw new Error("no signing key — cannot pre-register agent");
          const newKp = await generateKeyPair();
          await register(wireUrl, CALLER_AGENT_ID, agentId, displayName, newKp.publicKey, keyPair.privateKey);

          if (a.plan) {
            await setPlan(wireUrl, agentId, a.plan as string, newKp.privateKey);
          }

          privateKeyB64 = await exportPrivateKey(newKp.privateKey);
        }

        result = await orchestrator.launchAgent({
          id: agentId,
          displayName,
          runtime: a.runtime as string | undefined,
          projectDir: a.project_dir as string | undefined,
          extraFlags: a.extra_flags as string | undefined,
          privateKeyB64,
          prompt: a.prompt as string | undefined,
        });
        break;
      }
      case "agent_register":
        result = await orchestrator.registerAgent({
          id: a.id as string,
          displayName: a.name as string,
          runtime: a.runtime as string | undefined,
          callerItermId: await callerSession(),
        });
        break;
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
        await orchestrator.attachAgent(a.id as string, a.pane as string);
        result = { attached: a.id, pane: a.pane };
        break;
      case "agent_detach":
        await orchestrator.detachAgent(a.id as string);
        result = { detached: a.id };
        break;
      case "agent_move":
        await orchestrator.moveAgent(a.id as string, a.pane as string);
        result = { moved: a.id, pane: a.pane };
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
        result = orchestrator.createTab(a.name as string, a.theme as string | undefined);
        break;
      case "tab_list":
        result = orchestrator.listTabs();
        break;
      case "tab_destroy":
        orchestrator.deleteTab(a.name as string);
        result = { destroyed: a.name };
        break;
      case "pane_register": {
        const itermId = await callerSession();
        if (!itermId) throw new Error("cannot detect iTerm2 session — are you running in iTerm2?");
        // Auto-create tab if needed
        if (!orchestrator.store.getTab(a.tab as string)) {
          orchestrator.createTab(a.tab as string);
        }
        result = await orchestrator.registerPane(a.tab as string, a.name as string | undefined, itermId);
        break;
      }
      case "pane_create":
        result = await orchestrator.createPane(
          a.tab as string,
          a.name as string | undefined,
          a.position as string | undefined,
          (a.relative_to as string) ?? await callerSession(),
        );
        break;
      case "pane_send":
        await orchestrator.sendToPane(a.pane as string, a.text as string);
        result = { sent: true, pane: a.pane };
        break;
      case "pane_badge":
        await orchestrator.setBadge(a.pane as string, a.text as string);
        result = { badge_set: a.pane, text: a.text };
        break;
      case "pane_list":
        result = orchestrator.listPanes(a.tab as string | undefined);
        break;
      case "pane_close":
        await orchestrator.closePane(a.name as string, await callerSession());
        result = { closed: a.name };
        break;
      case "url_open":
        result = await orchestrator.openUrl({
          tab: a.tab as string,
          pane: a.pane as string | undefined,
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
  // Load spawning agent's key from WIRE_PRIVATE_KEY env (same as all agents)
  const rawKey = process.env.WIRE_PRIVATE_KEY;
  if (rawKey) {
    try {
      const pkcs8 = Uint8Array.from(atob(rawKey), (c) => c.charCodeAt(0));
      const privateKey = await crypto.subtle.importKey("pkcs8", pkcs8, "Ed25519", true, ["sign"]);
      const jwk = await crypto.subtle.exportKey("jwk", privateKey);
      const pubB64Url = jwk.x!;
      const pubB64 = pubB64Url.replace(/-/g, "+").replace(/_/g, "/");
      const publicKey = pubB64 + "=".repeat((4 - (pubB64.length % 4)) % 4);
      keyPair = { publicKey, privateKey };
    } catch (e) {
      console.error(`[crew] failed to load WIRE_PRIVATE_KEY:`, e);
    }
  } else {
    console.error("[crew] WIRE_PRIVATE_KEY not set — pre-registration disabled");
  }

  const transport = new StdioServerTransport();
  await mcp.connect(transport);

  // Reconcile on boot
  const report = await orchestrator.reconcile();
  console.error(`[crew] boot reconcile:\n${report}`);
  console.error(`[crew] ready (caller=${CALLER_AGENT_ID})`);
}

main().catch((e) => {
  console.error("[crew] fatal:", e);
  process.exit(1);
});
