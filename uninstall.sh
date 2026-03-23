#!/bin/bash
# Claude Agent Toolkit — Uninstall Script

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

echo "Uninstalling Claude Agent Toolkit..."

# Stop surveillance dashboard if running
if lsof -ti :3847 &>/dev/null; then
  lsof -ti :3847 | xargs kill 2>/dev/null
  echo -e "  ${GREEN}✓${NC} Stopped surveillance dashboard"
fi

# Kill any tmux agent sessions
for session in $(tmux list-sessions -F "#{session_name}" 2>/dev/null | grep "^claude-team-"); do
  tmux kill-session -t "$session" 2>/dev/null
  echo -e "  ${GREEN}✓${NC} Killed tmux session: $session"
done

# Remove skills
rm -rf "$HOME/.claude/skills/tmux-team"
rm -rf "$HOME/.claude/skills/agent-surveillance"
echo -e "  ${GREEN}✓${NC} Removed skills"

# Remove surveillance database (optional)
if [ -f "$HOME/.claude/surveillance.db" ]; then
  read -p "  Remove surveillance database? [y/N] " -n 1 -r
  echo
  if [[ $REPLY =~ ^[Yy]$ ]]; then
    rm -f "$HOME/.claude/surveillance.db"
    echo -e "  ${GREEN}✓${NC} Removed surveillance database"
  fi
fi

echo ""
echo -e "${GREEN}Uninstalled successfully.${NC}"
