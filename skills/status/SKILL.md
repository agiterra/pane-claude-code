---
description: Full crew status overview - tabs, panes, agents, and their relationships.
allowed-tools: mcp__plugin_crew_crew__agent_list, mcp__plugin_crew_crew__pane_list, mcp__plugin_crew_crew__tab_list
---

# Crew Status

Show a full overview of the crew system state.

1. Call `tab_list`, `pane_list`, and `agent_list` in parallel.
2. Display organized by tab:
   - Tab name and theme
   - Panes in that tab with their occupant (if any)
   - Unattached agents (running headless)
3. Keep output compact — use a table or structured format.
