---
name: tmux-team
description: Launch Claude Code agent teams in visible tmux panes. Use when the user wants to run multiple agents concurrently in tmux so they can watch agents work side-by-side in real-time. Invoked as /tmux-team <prompt-file>.
---

# tmux-team

Launch agent teams from a prompt file into visible tmux panes. Each agent gets its own pane, dependency ordering is respected, and the user can watch all agents work simultaneously.

## Usage

When this skill is invoked, follow these steps exactly:

### 1. Determine the prompt file

The argument is the path to a prompt file (e.g., `prompts/base-app.md`). If no argument is provided, ask the user which prompt file to use.

### 2. Validate prerequisites

```bash
# Verify tmux is installed
which tmux || echo "MISSING: Install with 'brew install tmux'"

# Verify claude CLI is available
which claude || echo "MISSING: claude CLI not found"
```

If either is missing, inform the user and stop.

### 3. Launch the tmux session

Run the launcher script:

```bash
node ~/.claude/skills/tmux-team/scripts/launch.js <prompt-file> --cwd <project-root>
```

- `<prompt-file>` — absolute path to the prompt file
- `--cwd` — the project's working directory (use the current working directory)

### 4. Report to the user

After launching, tell the user:
- The tmux session name
- How to attach: `tmux attach -t <session-name>`
- How to navigate panes: `Ctrl+B` then arrow keys
- How to kill: `tmux kill-session -t <session-name>`
- Remind them the surveillance dashboard at http://localhost:3847 shows agent activity

### 5. Ensure surveillance dashboard is running

```bash
curl -s http://localhost:3847/api/state > /dev/null 2>&1 || \
  (cd ~/.claude/skills/agent-surveillance && npm install && node scripts/server.js &)
```

## Prompt file format

The launcher parses prompt files with this structure:

```markdown
# Title

## Agent: backend
<instructions for the backend agent>

## Agent: frontend
<instructions for the frontend agent>

## Coordination
- Backend agent must complete before frontend agent begins.
```

- Each `## Agent: <name>` section becomes a tmux pane
- The `## Coordination` section defines dependency ordering
- Dependencies are auto-detected from phrases like "X must complete before Y"
- Agents without dependencies start immediately
- Dependent agents poll until their blockers finish

## Managing sessions

```bash
# List active sessions
node ~/.claude/skills/tmux-team/scripts/launch.js --list

# Kill a specific session
node ~/.claude/skills/tmux-team/scripts/launch.js --kill <session-name>

# Kill all sessions
node ~/.claude/skills/tmux-team/scripts/launch.js --kill-all
```

## Layout

The layout adapts to the number of agents:
- **2 agents**: side-by-side (horizontal split)
- **3-4 agents**: tiled grid
- **5+ agents**: tiled grid

Each pane has a title bar showing the agent name.
