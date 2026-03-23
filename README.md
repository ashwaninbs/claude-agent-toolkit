# Claude Agent Toolkit

Watch your Claude Code agents work in real-time. Two skills that add visibility to multi-agent sessions:

- **`/tmux-team`** — Launch agents in visible tmux panes so you can watch them code side-by-side
- **Agent Surveillance Dashboard** — Live web dashboard showing agent roster, message feed, and kanban task board

![Layout](https://img.shields.io/badge/layout-tmux%20panes-blue) ![Dashboard](https://img.shields.io/badge/dashboard-localhost:3847-green) ![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-lightgrey)

## Install

```bash
git clone https://github.com/anthropics/claude-agent-toolkit.git
cd claude-agent-toolkit
./install.sh
```

## Prerequisites

- [Claude Code CLI](https://claude.ai/cli)
- Node.js 18+
- tmux (`brew install tmux` on macOS)

## How It Works

### 1. Write a prompt file with agent sections

```markdown
# My Feature

## Agent: backend
Build the REST API with these endpoints...

## Agent: frontend
Build the React UI with these components...

## Coordination
Backend must complete before frontend begins.
```

### 2. Launch agents in tmux

In Claude Code, run:

```
/tmux-team prompts/my-feature.md
```

This:
- Parses your prompt file into agent sections
- Detects dependency ordering automatically
- Creates a tmux session with one pane per agent
- Opens a terminal window so you can watch them work
- Updates the surveillance dashboard in real-time

### 3. Watch on the dashboard

Start the dashboard (if not already running):

```bash
cd ~/.claude/skills/agent-surveillance && node scripts/server.js &
```

Open **http://localhost:3847** to see:

- **Agent Roster** — Who's active, idle, or done
- **Message Feed** — Inter-agent communication
- **Task Board** — Kanban view of pending / in progress / completed tasks

## Prompt File Format

The launcher supports flexible formats:

```markdown
## Agent: name        # 2 hashes
### Agent: name       # or 3 hashes — both work

**Depends on:** `other-agent`   # Inline dependency declaration

## Coordination                  # or "Coordination Notes"
- backend must complete before frontend   # Auto-detected dependency
```

**Dependency detection** works from:
1. `## Coordination` section — phrases like "X must complete before Y"
2. Inline `**Depends on:** agent-name` in agent sections
3. Dependent agents wait automatically and start when their blockers finish

## Layout

The tmux layout adapts to the number of agents:

| Agents | Layout |
|--------|--------|
| 2 | Side-by-side |
| 3-4 | 2x2 tiled grid |
| 5+ | Tiled grid |

Each pane has a labeled border showing the agent name.

## Managing Sessions

```bash
# List active sessions
node ~/.claude/skills/tmux-team/scripts/launch.js --list

# Kill a specific session
node ~/.claude/skills/tmux-team/scripts/launch.js --kill <session-name>

# Kill all sessions
node ~/.claude/skills/tmux-team/scripts/launch.js --kill-all
```

## Uninstall

```bash
./uninstall.sh
```

## How the Dashboard Integrates

The tmux launcher writes agent status and task files to `~/.claude/teams/` and `~/.claude/tasks/`. The dashboard watches these directories and updates the UI via Server-Sent Events. It also works with Claude Code's native `TeamCreate` and `TaskCreate` tools.

## License

MIT
