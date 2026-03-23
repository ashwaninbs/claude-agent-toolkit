#!/usr/bin/env node
// tmux-team launcher — parses prompt files and launches claude agents in tmux panes

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, spawn } = require('child_process');

// ─── Configuration ───────────────────────────────────────────────────────────
const SESSION_PREFIX = 'claude-team';
const SIGNAL_DIR = '/tmp/claude-team-signals';
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';

// ─── Helpers ─────────────────────────────────────────────────────────────────
function run(cmd) {
  return execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function runSafe(cmd) {
  try { return run(cmd); } catch (_) { return ''; }
}

function tmux(cmd) {
  return run(`tmux ${cmd}`);
}

// ─── Parse prompt file ──────────────────────────────────────────────────────
function parsePromptFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const agents = [];
  let coordination = '';

  // Match both ## Agent: and ### Agent: (2 or 3 hashes)
  const agentRegex = /^#{2,3}\s+Agent:\s*(\S+)\s*$/gm;
  const sections = [];
  let match;

  while ((match = agentRegex.exec(content)) !== null) {
    sections.push({ name: match[1], start: match.index });
  }

  // Extract coordination section (supports "Coordination" and "Coordination Notes")
  const coordMatch = content.match(/^#{2,3}\s+Coordination(?:\s+Notes)?\s*\n([\s\S]*?)(?=\n#{1,3}\s|$)/m);
  if (coordMatch) {
    coordination = coordMatch[1].trim();
  }

  // Find where coordination section starts (to bound last agent)
  const coordStart = content.search(/^#{2,3}\s+Coordination(?:\s+Notes)?\s*$/m);

  // Extract each agent's prompt
  for (let i = 0; i < sections.length; i++) {
    const start = sections[i].start;
    let end;
    if (sections[i + 1]) {
      end = sections[i + 1].start;
    } else if (coordStart > -1 && coordStart > start) {
      end = coordStart;
    } else {
      end = content.length;
    }

    const agentContent = content.substring(start, end).trim();
    // Extract a human-friendly title: first non-empty, non-heading line after the agent header
    const lines = agentContent.split('\n').slice(1); // skip the ## Agent: line
    let title = '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('---') && !trimmed.startsWith('**Depends')) {
        title = trimmed.replace(/^\*\*(.+)\*\*$/, '$1'); // strip bold markers
        break;
      }
    }
    agents.push({
      name: sections[i].name,
      title: title || `${sections[i].name} agent`,
      prompt: agentContent,
    });
  }

  // Parse dependencies from multiple sources
  const dependencies = {};

  function addDep(blocked, blocker) {
    const key = blocked.toLowerCase().replace(/[`*]/g, '');
    const val = blocker.toLowerCase().replace(/[`*]/g, '');
    if (!dependencies[key]) dependencies[key] = [];
    if (!dependencies[key].includes(val)) dependencies[key].push(val);
  }

  // 1. From coordination text: "X must complete ... before Y"
  const depRegex1 = /(\S+)\s+(?:agent\s+)?must\s+complete.*?before\s+(\S+)/gi;
  let depMatch;
  while ((depMatch = depRegex1.exec(coordination)) !== null) {
    addDep(depMatch[2], depMatch[1]);
  }

  // 2. From coordination text: "X depends on Y" or "X frontend depends on X backend"
  const depRegex2 = /[`*]*(\S+?)[`*]*\s+depends\s+on\s+[`*]*(\S+?)[`*]*/gi;
  while ((depMatch = depRegex2.exec(coordination)) !== null) {
    addDep(depMatch[1], depMatch[2]);
  }

  // 3. From inline **Depends on:** inside agent sections
  // Matches: **Depends on:** `notif-backend` or **Depends on:** notif-backend
  for (const agent of agents) {
    const inlineDep = agent.prompt.match(/\*\*Depends on:\*\*\s*`?([\w-]+)`?/i);
    if (inlineDep) {
      addDep(agent.name, inlineDep[1]);
    }
  }

  return { agents, dependencies, coordination };
}

// ─── Surveillance integration ────────────────────────────────────────────────
const CLAUDE_HOME = path.join(os.homedir(), '.claude');
const SURV_TEAMS_DIR = path.join(CLAUDE_HOME, 'teams');
const SURV_TASKS_DIR = path.join(CLAUDE_HOME, 'tasks');

function writeSurveillanceTeamFile(sessionName, agents) {
  const teamFile = path.join(SURV_TEAMS_DIR, `${sessionName}.json`);
  const data = {
    id: sessionName,
    agents: agents.map(a => ({
      id: a.name,
      name: a.name,
      status: 'pending',
    })),
  };
  fs.mkdirSync(SURV_TEAMS_DIR, { recursive: true });
  fs.writeFileSync(teamFile, JSON.stringify(data, null, 2));
  return teamFile;
}

function updateSurveillanceAgent(sessionName, agentName, status) {
  const teamFile = path.join(SURV_TEAMS_DIR, `${sessionName}.json`);
  try {
    const data = JSON.parse(fs.readFileSync(teamFile, 'utf8'));
    const agent = data.agents.find(a => a.name === agentName);
    if (agent) agent.status = status;
    fs.writeFileSync(teamFile, JSON.stringify(data, null, 2));
  } catch (_) {}
}

function writeSurveillanceTask(sessionName, agentName, title, status) {
  fs.mkdirSync(SURV_TASKS_DIR, { recursive: true });
  const taskFile = path.join(SURV_TASKS_DIR, `${sessionName}-${agentName}.json`);
  const data = {
    id: `${sessionName}-${agentName}`,
    agent: agentName,
    title: title,
    status: status,
    timestamp: new Date().toISOString(),
  };
  fs.writeFileSync(taskFile, JSON.stringify(data, null, 2));
}

// Shell commands to update surveillance from inside tmux panes
function survStartCmd(sessionName, agentName) {
  const teamFile = path.join(SURV_TEAMS_DIR, `${sessionName}.json`);
  const taskFile = path.join(SURV_TASKS_DIR, `${sessionName}-${agentName}.json`);
  // Use node one-liner to update JSON atomically
  const updateTeam = `node -e "const f='${teamFile}';const d=JSON.parse(require('fs').readFileSync(f,'utf8'));const a=d.agents.find(x=>x.name==='${agentName}');if(a)a.status='active';require('fs').writeFileSync(f,JSON.stringify(d,null,2))"`;
  const writeTask = `node -e "require('fs').writeFileSync('${taskFile}',JSON.stringify({id:'${sessionName}-${agentName}',agent:'${agentName}',title:'${agentName} agent work',status:'in_progress',timestamp:new Date().toISOString()},null,2))"`;
  return `${updateTeam} 2>/dev/null; ${writeTask} 2>/dev/null`;
}

function survDoneCmd(sessionName, agentName) {
  const teamFile = path.join(SURV_TEAMS_DIR, `${sessionName}.json`);
  const taskFile = path.join(SURV_TASKS_DIR, `${sessionName}-${agentName}.json`);
  const updateTeam = `node -e "const f='${teamFile}';const d=JSON.parse(require('fs').readFileSync(f,'utf8'));const a=d.agents.find(x=>x.name==='${agentName}');if(a)a.status='done';require('fs').writeFileSync(f,JSON.stringify(d,null,2))"`;
  const writeTask = `node -e "require('fs').writeFileSync('${taskFile}',JSON.stringify({id:'${sessionName}-${agentName}',agent:'${agentName}',title:'${agentName} agent work',status:'completed',timestamp:new Date().toISOString()},null,2))"`;
  return `${updateTeam} 2>/dev/null; ${writeTask} 2>/dev/null`;
}

// ─── Build agent command ────────────────────────────────────────────────────
function buildAgentCommand(agent, cwd, dependencies, sessionName, signalDir) {
  const promptFile = path.join(signalDir, `${agent.name}-prompt.md`);
  fs.writeFileSync(promptFile, agent.prompt);

  const doneFile = path.join(signalDir, `${agent.name}-done`);
  const scriptFile = path.join(signalDir, `${agent.name}-run.sh`);

  // Build a shell script instead of a long one-liner (tmux send-keys mangles long commands)
  const lines = ['#!/bin/bash', `cd "${cwd}"`];

  // Wait for dependencies
  const deps = dependencies[agent.name] || [];
  if (deps.length > 0) {
    const depNames = deps.join(', ');
    lines.push(`echo "⏳ Waiting for ${depNames} to complete..."`);
    for (const dep of deps) {
      const depDoneFile = path.join(signalDir, `${dep}-done`);
      lines.push(`while [ ! -f "${depDoneFile}" ]; do sleep 3; done`);
    }
    lines.push(`echo "✅ Dependencies ready, starting ${agent.name}..."`);
    lines.push('sleep 1');
  }

  // Surveillance: mark active
  const teamFile = path.join(SURV_TEAMS_DIR, `${sessionName}.json`);
  const taskFile = path.join(SURV_TASKS_DIR, `${sessionName}-${agent.name}.json`);
  lines.push(`node -e "const f='${teamFile}';const d=JSON.parse(require('fs').readFileSync(f,'utf8'));const a=d.agents.find(x=>x.name==='${agent.name}');if(a)a.status='active';require('fs').writeFileSync(f,JSON.stringify(d,null,2))" 2>/dev/null`);
  lines.push(`node -e "require('fs').writeFileSync('${taskFile}',JSON.stringify({id:'${sessionName}-${agent.name}',agent:'${agent.name}',title:'${(agent.title || agent.name).replace(/'/g, '')}',status:'in_progress',timestamp:new Date().toISOString()},null,2))" 2>/dev/null`);

  // Run claude
  lines.push(`echo "🚀 Starting ${agent.name}..."`);
  lines.push(`cat "${promptFile}" | ${CLAUDE_BIN} -p --permission-mode bypassPermissions --verbose 2>&1`);

  // Surveillance: mark done
  lines.push(`node -e "const f='${teamFile}';const d=JSON.parse(require('fs').readFileSync(f,'utf8'));const a=d.agents.find(x=>x.name==='${agent.name}');if(a)a.status='done';require('fs').writeFileSync(f,JSON.stringify(d,null,2))" 2>/dev/null`);
  lines.push(`node -e "require('fs').writeFileSync('${taskFile}',JSON.stringify({id:'${sessionName}-${agent.name}',agent:'${agent.name}',title:'${(agent.title || agent.name).replace(/'/g, '')}',status:'completed',timestamp:new Date().toISOString()},null,2))" 2>/dev/null`);

  // Signal done
  lines.push(`touch "${doneFile}"`);
  lines.push(`echo "✅ ${agent.name} complete!"`);

  fs.writeFileSync(scriptFile, lines.join('\n') + '\n', { mode: 0o755 });

  // Return a short command that tmux send-keys won't mangle
  return `bash ${scriptFile}`;
}

// ─── Create tmux session ────────────────────────────────────────────────────
function createSession(agents, dependencies, cwd) {
  // Clean up signal directory
  if (fs.existsSync(SIGNAL_DIR)) {
    fs.rmSync(SIGNAL_DIR, { recursive: true });
  }
  fs.mkdirSync(SIGNAL_DIR, { recursive: true });

  // Generate unique session name
  const timestamp = Date.now().toString(36);
  const sessionName = `${SESSION_PREFIX}-${timestamp}`;

  // Write initial surveillance team file (all agents as "pending")
  writeSurveillanceTeamFile(sessionName, agents);
  // Write initial task files
  for (const agent of agents) {
    writeSurveillanceTask(sessionName, agent.name, agent.title, 'pending');
  }

  // Kill existing session if somehow exists
  runSafe(`tmux kill-session -t ${sessionName}`);

  // Create session with first agent
  const firstAgent = agents[0];
  const firstCmd = buildAgentCommand(firstAgent, cwd, dependencies, sessionName, SIGNAL_DIR);

  tmux(`new-session -d -s ${sessionName} -n agents -x 220 -y 50`);

  // Configure tmux for this session
  // Build a pane-border-format that maps pane_index to agent names (immune to shell title resets)
  const borderConds = agents.map((a, i) =>
    `#{?#{==:#{pane_index},${i}}, 🔧 ${a.name} ,}`
  ).join('');
  const borderFormat = borderConds || ' #{pane_index} ';

  tmux(`set-option -t ${sessionName} pane-border-status top`);
  tmux(`set-option -t ${sessionName} pane-border-format "${borderFormat}"`);
  tmux(`set-option -t ${sessionName} pane-border-style "fg=colour240"`);
  tmux(`set-option -t ${sessionName} pane-active-border-style "fg=colour39,bold"`);
  tmux(`set-option -t ${sessionName} status-style "bg=colour235,fg=colour136"`);
  tmux(`set-option -t ${sessionName} status-left " 🤖 ${sessionName} "`);
  tmux(`set-option -t ${sessionName} status-left-length 40`);
  tmux(`set-option -t ${sessionName} status-right " agents: ${agents.length} "`);

  // Send command for first pane
  tmux(`send-keys -t ${sessionName}:agents.0 '${escapeForTmux(firstCmd)}' Enter`);

  // Create additional panes for remaining agents
  for (let i = 1; i < agents.length; i++) {
    const agent = agents[i];
    const cmd = buildAgentCommand(agent, cwd, dependencies, sessionName, SIGNAL_DIR);

    // Split: alternate between horizontal and vertical for good layout
    if (agents.length === 2) {
      // Two agents: side by side
      tmux(`split-window -t ${sessionName}:agents -h`);
    } else if (agents.length <= 4) {
      // 3-4 agents: tiled
      tmux(`split-window -t ${sessionName}:agents`);
      tmux(`select-layout -t ${sessionName}:agents tiled`);
    } else {
      // 5+ agents: tiled
      tmux(`split-window -t ${sessionName}:agents`);
      tmux(`select-layout -t ${sessionName}:agents tiled`);
    }

    tmux(`send-keys -t ${sessionName}:agents.${i} '${escapeForTmux(cmd)}' Enter`);
  }

  // Final layout adjustment
  if (agents.length > 2) {
    tmux(`select-layout -t ${sessionName}:agents tiled`);
  }

  // Select first pane
  tmux(`select-pane -t ${sessionName}:agents.0`);

  return sessionName;
}

function escapeForTmux(cmd) {
  // Escape single quotes for tmux send-keys
  return cmd.replace(/'/g, "'\\''");
}

// ─── Open a new window in the current terminal app attached to tmux ──────────
function openTerminalWithTmux(sessionName) {
  const attachCmd = `tmux attach -t ${sessionName}`;
  // Use TERM_PROGRAM to open a window in whatever terminal the user is currently running
  const termProgram = (process.env.TERM_PROGRAM || '').toLowerCase();

  const appName = termProgram.includes('warp') ? 'Warp'
    : termProgram.includes('iterm') ? 'iTerm2'
    : termProgram.includes('apple_terminal') ? 'Terminal'
    : termProgram.includes('alacritty') ? 'Alacritty'
    : termProgram.includes('kitty') ? 'kitty'
    : null;

  if (!appName) {
    console.log(`\n⚠️  Unknown terminal (${process.env.TERM_PROGRAM}). Attach manually:`);
    console.log(`   ${attachCmd}`);
    return;
  }

  // Use Cmd+T for Warp (new tab), Cmd+N for others (new window)
  const newKey = appName === 'Warp' ? 't' : 'n';
  const script = `
    tell application "${appName}" to activate
    delay 0.5
    tell application "System Events"
      tell process "${appName}"
        keystroke "${newKey}" using command down
        delay 0.5
        keystroke "${attachCmd}"
        delay 0.2
        key code 36
      end tell
    end tell
  `;

  try {
    execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, { stdio: 'pipe' });
    console.log(`   (opened in ${appName})`);
  } catch (_) {
    console.log(`\n⚠️  Could not auto-open ${appName}. Attach manually:`);
    console.log(`   ${attachCmd}`);
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────
function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error('Usage: launch.js <prompt-file> [--cwd <dir>] [--no-open]');
    console.error('');
    console.error('Options:');
    console.error('  <prompt-file>    Path to prompt file with ## Agent: sections');
    console.error('  --cwd <dir>      Working directory for agents (default: cwd)');
    console.error('  --no-open        Don\'t auto-open a Terminal window');
    console.error('  --list           List active claude-team sessions');
    console.error('  --kill <name>    Kill a specific session');
    console.error('  --kill-all       Kill all claude-team sessions');
    process.exit(1);
  }

  // Handle --list
  if (args[0] === '--list') {
    const sessions = runSafe('tmux list-sessions -F "#{session_name}"')
      .split('\n')
      .filter(s => s.startsWith(SESSION_PREFIX));
    if (sessions.length === 0 || (sessions.length === 1 && sessions[0] === '')) {
      console.log('No active claude-team sessions.');
    } else {
      console.log('Active sessions:');
      sessions.forEach(s => console.log(`  - ${s}`));
    }
    return;
  }

  // Handle --kill
  if (args[0] === '--kill') {
    const name = args[1];
    if (!name) { console.error('Specify session name'); process.exit(1); }
    runSafe(`tmux kill-session -t ${name}`);
    console.log(`Killed session: ${name}`);
    return;
  }

  // Handle --kill-all
  if (args[0] === '--kill-all') {
    const sessions = runSafe('tmux list-sessions -F "#{session_name}"')
      .split('\n')
      .filter(s => s.startsWith(SESSION_PREFIX));
    sessions.forEach(s => { if (s) runSafe(`tmux kill-session -t ${s}`); });
    console.log(`Killed ${sessions.filter(Boolean).length} sessions.`);
    return;
  }

  // Parse arguments
  const promptFile = path.resolve(args[0]);
  let cwd = process.cwd();
  let noOpen = false;

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--cwd' && args[i + 1]) { cwd = path.resolve(args[++i]); }
    if (args[i] === '--no-open') { noOpen = true; }
  }

  // Validate prompt file
  if (!fs.existsSync(promptFile)) {
    console.error(`Prompt file not found: ${promptFile}`);
    process.exit(1);
  }

  // Verify tmux is available
  try { run('which tmux'); } catch (_) {
    console.error('tmux is not installed. Run: brew install tmux');
    process.exit(1);
  }

  // Parse and launch
  console.log(`📄 Parsing: ${promptFile}`);
  const { agents, dependencies } = parsePromptFile(promptFile);

  if (agents.length === 0) {
    console.error('No agents found. Prompt file must have ## Agent: <name> sections.');
    process.exit(1);
  }

  console.log(`🤖 Agents: ${agents.map(a => a.name).join(', ')}`);
  if (Object.keys(dependencies).length > 0) {
    for (const [blocked, blockers] of Object.entries(dependencies)) {
      console.log(`   ⏳ ${blocked} waits for: ${blockers.join(', ')}`);
    }
  }

  const sessionName = createSession(agents, dependencies, cwd);
  console.log(`\n✅ Tmux session created: ${sessionName}`);
  console.log(`   Kill:    tmux kill-session -t ${sessionName}`);
  console.log(`   List:    node ${__filename} --list`);

  // Auto-open a new Terminal window attached to the tmux session
  if (!noOpen) {
    openTerminalWithTmux(sessionName);
    console.log(`\n🖥️  Opened Terminal window attached to tmux session`);
  } else {
    console.log(`\n   Attach:  tmux attach -t ${sessionName}`);
  }
}

main();
