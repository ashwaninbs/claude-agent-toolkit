#!/bin/bash
# Claude Agent Toolkit — Install Script
# Installs tmux-team and agent-surveillance skills into ~/.claude/skills/

set -e

BLUE='\033[0;34m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${BLUE}╔══════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║   Claude Agent Toolkit — Installer       ║${NC}"
echo -e "${BLUE}╚══════════════════════════════════════════╝${NC}"
echo ""

# ─── Detect install source (local clone or curl pipe) ─────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -d "$SCRIPT_DIR/skills" ]; then
  SOURCE_DIR="$SCRIPT_DIR/skills"
else
  # Cloned from GitHub — clone to temp dir
  echo -e "${BLUE}→${NC} Cloning repository..."
  TMPDIR=$(mktemp -d)
  git clone --depth 1 https://github.com/anthropics/claude-agent-toolkit.git "$TMPDIR" 2>/dev/null || {
    echo -e "${RED}✗${NC} Failed to clone repository."
    echo "  You can manually copy the skills/ directory to ~/.claude/skills/"
    exit 1
  }
  SOURCE_DIR="$TMPDIR/skills"
fi

SKILLS_DIR="$HOME/.claude/skills"

# ─── Check prerequisites ──────────────────────────────────────────────────────
echo -e "${BLUE}→${NC} Checking prerequisites..."

# Node.js
if ! command -v node &>/dev/null; then
  echo -e "${RED}✗${NC} Node.js is required but not installed."
  echo "  Install: https://nodejs.org or brew install node"
  exit 1
fi
echo -e "  ${GREEN}✓${NC} Node.js $(node -v)"

# Claude CLI
if ! command -v claude &>/dev/null; then
  echo -e "${RED}✗${NC} Claude CLI is required but not installed."
  echo "  Install: https://claude.ai/cli"
  exit 1
fi
echo -e "  ${GREEN}✓${NC} Claude CLI found"

# tmux
if command -v tmux &>/dev/null; then
  echo -e "  ${GREEN}✓${NC} tmux $(tmux -V)"
else
  echo -e "  ${YELLOW}!${NC} tmux not found — required for /tmux-team"
  if command -v brew &>/dev/null; then
    read -p "  Install tmux via Homebrew? [Y/n] " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]] || [[ -z $REPLY ]]; then
      brew install tmux
      echo -e "  ${GREEN}✓${NC} tmux installed"
    fi
  else
    echo "  Install manually: brew install tmux (macOS) or apt install tmux (Linux)"
  fi
fi

# ─── Install skills ──────────────────────────────────────────────────────────
echo ""
echo -e "${BLUE}→${NC} Installing skills to ${SKILLS_DIR}..."

mkdir -p "$SKILLS_DIR"

# tmux-team
echo -e "  Installing ${GREEN}tmux-team${NC}..."
rm -rf "$SKILLS_DIR/tmux-team"
cp -r "$SOURCE_DIR/tmux-team" "$SKILLS_DIR/tmux-team"

# agent-surveillance
echo -e "  Installing ${GREEN}agent-surveillance${NC}..."
rm -rf "$SKILLS_DIR/agent-surveillance"
cp -r "$SOURCE_DIR/agent-surveillance" "$SKILLS_DIR/agent-surveillance"

# ─── Install dependencies ────────────────────────────────────────────────────
echo ""
echo -e "${BLUE}→${NC} Installing dependencies..."
cd "$SKILLS_DIR/agent-surveillance" && npm install --silent 2>&1 | tail -1
echo -e "  ${GREEN}✓${NC} agent-surveillance dependencies installed"

# ─── Create required directories ─────────────────────────────────────────────
mkdir -p "$HOME/.claude/teams" "$HOME/.claude/tasks"

# ─── Clean up temp dir if used ────────────────────────────────────────────────
if [ -n "$TMPDIR" ] && [ -d "$TMPDIR" ]; then
  rm -rf "$TMPDIR"
fi

# ─── Done ────────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}╔══════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║   Installation complete!                 ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════╝${NC}"
echo ""
echo -e "  ${GREEN}Skills installed:${NC}"
echo -e "    /tmux-team          — Launch agents in visible tmux panes"
echo -e "    agent-surveillance  — Real-time web dashboard at localhost:3847"
echo ""
echo -e "  ${BLUE}Quick start:${NC}"
echo ""
echo -e "    1. Start the surveillance dashboard:"
echo -e "       ${YELLOW}cd ~/.claude/skills/agent-surveillance && node scripts/server.js &${NC}"
echo -e "       Then open ${YELLOW}http://localhost:3847${NC}"
echo ""
echo -e "    2. In Claude Code, launch agents with:"
echo -e "       ${YELLOW}/tmux-team prompts/your-prompt.md${NC}"
echo ""
echo -e "    3. Your prompt file should have agent sections like:"
echo -e "       ${YELLOW}## Agent: backend${NC}"
echo -e "       ${YELLOW}Build the REST API...${NC}"
echo ""
echo -e "       ${YELLOW}## Agent: frontend${NC}"
echo -e "       ${YELLOW}Build the React app...${NC}"
echo ""
echo -e "       ${YELLOW}## Coordination${NC}"
echo -e "       ${YELLOW}Backend must complete before frontend.${NC}"
echo ""
echo -e "  ${BLUE}More info:${NC} https://github.com/anthropics/claude-agent-toolkit"
