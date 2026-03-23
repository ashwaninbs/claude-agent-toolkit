---
name: agent-surveillance
description: Launch a real-time web dashboard to monitor Claude Code agent teams — shows agent roster, message feed, and kanban task board with live updates via SSE. Historical sessions are persisted in SQLite.
---

# Agent Surveillance Dashboard

## When to Invoke

Automatically launch this dashboard **before** any `TeamCreate` or multi-agent workflow. It provides real-time visibility into agent activity, messages, and task progress.

## Launch Steps

1. **Check if already running:**
   ```bash
   curl -s http://localhost:3847/api/state > /dev/null 2>&1 && echo "Running" || echo "Not running"
   ```

2. **Install dependencies (first time only):**
   ```bash
   cd ~/.claude/skills/agent-surveillance && npm install
   ```

3. **Start the server:**
   ```bash
   node ~/.claude/skills/agent-surveillance/scripts/server.js &
   ```

4. **Verify it's running:**
   ```bash
   curl -s http://localhost:3847/api/state | head -c 100
   ```

5. **Open in browser** (auto-opens on macOS/Linux/Windows):
   The server opens `http://localhost:3847` automatically on startup.

## What the User Sees

### Live Mode (default)
- **Agent Roster** — left sidebar showing all team members with colored avatars
- **Message Feed** — chronological feed of all inter-agent messages with markdown rendering and protocol card detection (task assignments, idle notifications, shutdown requests)
- **Task Board** — kanban with Pending / In Progress / Completed columns
- Click any message to see the full conversation thread between those two agents

### History Mode
- Grid of past session cards with agent/message/task counts
- Click a card to view the full session detail in the same 3-panel layout
- Delete button on hover to remove old sessions

## Troubleshooting

### Port already in use
```bash
lsof -ti:3847 | xargs kill -9
```

### Native module issues with better-sqlite3
```bash
cd ~/.claude/skills/agent-surveillance && npm rebuild better-sqlite3
```
If SQLite still fails, the dashboard runs in **memory-only mode** — all live features work, but sessions aren't persisted to disk.

### Stale browser cache
The server sets `Cache-Control: no-store, no-cache, must-revalidate` on all responses. If the UI looks wrong, hard-refresh with Cmd+Shift+R.

## Architecture Reference

The entire application is a single file: `scripts/server.js` (~700 lines server + ~700 lines embedded HTML/CSS/JS).

### Data flow
```
~/.claude/teams/  ──┐
~/.claude/tasks/  ──┼──> fs.watch + 2s polling ──> state object ──> SSE push ──> browser
                    │                                    │
                    │                                    └──> SQLite (sessions, agents, messages, tasks)
                    └──> on team removal ──> session.ended_at set
```

### Key design decisions
- **Single file, no build step** — `node server.js` and you're live
- **SSE over WebSockets** — simpler, auto-reconnects, works through proxies
- **Dual fs.watch + polling** — fs.watch is unreliable on macOS, polling is the safety net
- **SQLite with graceful degradation** — works without native modules in memory-only mode
- **Fixed port 3847** — predictable URL, no port hunting

### Template literal rules (CRITICAL for editing)
All client-side code lives inside a template literal. When editing regex patterns:
- Use `[*]` instead of `\*` — backslash gets eaten by template literals
- Use `[.]` instead of `\.`
- Use `[a-zA-Z0-9_]` instead of `\w`
- Use `\x60` for backtick characters
- Test with: `curl -s http://localhost:3847/ | grep 'replace'`
