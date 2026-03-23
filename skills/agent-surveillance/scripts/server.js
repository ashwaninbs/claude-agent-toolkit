#!/usr/bin/env node
// Agent Surveillance Dashboard — single-file Node.js server
// Monitors ~/.claude/teams/ and ~/.claude/tasks/ for agent activity
// Serves a live dashboard at http://localhost:3847

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');


// ─── Configuration ──────────────────────────────────────────────────────────
const PORT = 3847;
const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const TEAMS_DIR = path.join(CLAUDE_DIR, 'teams');
const TASKS_DIR = path.join(CLAUDE_DIR, 'tasks');
const POLL_INTERVAL = 2000;
const DB_PATH = path.join(CLAUDE_DIR, 'surveillance.db');

// ─── SQLite setup (graceful degradation) ────────────────────────────────────
let db = null;
let useMemory = false;

function initDatabase() {
  try {
    const Database = require('better-sqlite3');
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    // Validate existing schema -- if columns are missing, recreate tables
    try {
      const cols = db.prepare("PRAGMA table_info(sessions)").all().map(c => c.name);
      if (cols.length > 0 && !cols.includes('started_at')) {
        console.log('[surveillance] Schema mismatch detected, recreating tables...');
        db.exec('DROP TABLE IF EXISTS tasks; DROP TABLE IF EXISTS messages; DROP TABLE IF EXISTS agents; DROP TABLE IF EXISTS sessions;');
      }
    } catch (_) {}
  } catch (e) {
    console.warn('[surveillance] SQLite unavailable, running in memory-only mode:', e.message);
    useMemory = true;
    return;
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at TEXT,
      agent_count INTEGER DEFAULT 0,
      message_count INTEGER DEFAULT 0,
      task_count INTEGER DEFAULT 0,
      snapshot TEXT
    );
    CREATE TABLE IF NOT EXISTS agents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER,
      name TEXT NOT NULL,
      role TEXT,
      status TEXT DEFAULT 'active',
      color TEXT,
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      from_agent TEXT,
      to_agent TEXT,
      content TEXT,
      msg_type TEXT DEFAULT 'chat',
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER,
      title TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      assigned_to TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT,
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    );
  `);
}

// ─── In-memory state ────────────────────────────────────────────────────────
let currentSession = null;
let state = {
  agents: [],
  messages: [],
  tasks: [],
  sessionId: null,
  startedAt: null,
};

function resetState() {
  state = { agents: [], messages: [], tasks: [], sessionId: null, startedAt: null };
}

// ─── SSE connections ────────────────────────────────────────────────────────
const sseClients = new Set();

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch (_) { sseClients.delete(res); }
  }
}

// ─── Color generation from name ─────────────────────────────────────────────
function nameToColor(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const h = Math.abs(hash) % 360;
  return `hsl(${h}, 70%, 60%)`;
}

// ─── File monitoring ────────────────────────────────────────────────────────
let watchers = [];
let lastTeamFiles = {};
let lastTaskFiles = {};

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function readJsonSafe(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

function scanTeams() {
  ensureDir(TEAMS_DIR);
  const files = {};
  try {
    const entries = fs.readdirSync(TEAMS_DIR);
    for (const entry of entries) {
      const fp = path.join(TEAMS_DIR, entry);
      const stat = fs.statSync(fp);
      if (stat.isFile() && entry.endsWith('.json')) {
        const data = readJsonSafe(fp);
        if (data) files[entry] = data;
      } else if (stat.isDirectory()) {
        // TeamCreate stores config in subdirectories: teams/<name>/config.json
        const configPath = path.join(fp, 'config.json');
        if (fs.existsSync(configPath)) {
          const data = readJsonSafe(configPath);
          if (data) files[entry + '/config.json'] = data;
        }
        // Read inbox files: teams/<name>/inboxes/*.json contain agent messages
        const inboxDir = path.join(fp, 'inboxes');
        if (fs.existsSync(inboxDir)) {
          try {
            const inboxFiles = fs.readdirSync(inboxDir).filter(f => f.endsWith('.json'));
            for (const ibf of inboxFiles) {
              const data = readJsonSafe(path.join(inboxDir, ibf));
              if (data) files[entry + '/inboxes/' + ibf] = { _inbox: true, _agent: ibf.replace('.json', ''), messages: Array.isArray(data) ? data : [] };
            }
          } catch (_) {}
        }
      }
    }
  } catch (_) {}
  return files;
}

function scanTasks() {
  ensureDir(TASKS_DIR);
  const files = {};
  try {
    const entries = fs.readdirSync(TASKS_DIR);
    for (const entry of entries) {
      const fp = path.join(TASKS_DIR, entry);
      const stat = fs.statSync(fp);
      if (stat.isFile() && entry.endsWith('.json')) {
        const data = readJsonSafe(fp);
        if (data) files[entry] = data;
      } else if (stat.isDirectory()) {
        // TaskCreate stores tasks in subdirectories: tasks/<team-name>/*.json
        try {
          const subEntries = fs.readdirSync(fp).filter(f => f.endsWith('.json'));
          for (const sub of subEntries) {
            const subFp = path.join(fp, sub);
            const data = readJsonSafe(subFp);
            if (data) files[entry + '/' + sub] = data;
          }
        } catch (_) {}
      }
    }
  } catch (_) {}
  return files;
}

function processTeamData(teamFiles) {
  const agents = [];
  const messages = [];

  for (const [file, data] of Object.entries(teamFiles)) {
    // Extract agents from team files
    // Support both "members" (TeamCreate config.json) and "agents" (CLAUDE.md format)
    const memberList = Array.isArray(data.members) ? data.members :
                       Array.isArray(data.agents) ? data.agents : null;
    if (memberList) {
      for (const m of memberList) {
        const name = m.name || m.id || file.replace('.json', '');
        const nameKey = name.toLowerCase().replace(/[\s_-]+/g, '');
        if (!agents.find(a => a.name.toLowerCase().replace(/[\s_-]+/g, '') === nameKey)) {
          agents.push({
            name,
            role: m.role || m.agentType || 'agent',
            status: m.status || 'active',
            color: nameToColor(name),
          });
        } else {
          // Update status if a later file has more specific info (e.g. "done" vs "active")
          const existing = agents.find(a => a.name.toLowerCase().replace(/[\s_-]+/g, '') === nameKey);
          if (existing && m.status && m.status !== 'active') existing.status = m.status;
        }
      }
    } else if (data.name || data.id) {
      const name = data.name || data.id;
      const nameKey = name.toLowerCase().replace(/[\s_-]+/g, '');
      if (!agents.find(a => a.name.toLowerCase().replace(/[\s_-]+/g, '') === nameKey)) {
        agents.push({
          name,
          role: data.role || 'agent',
          status: data.status || 'active',
          color: nameToColor(name),
        });
      }
    }

    // Extract messages from inbox files (teams/<name>/inboxes/*.json)
    if (data._inbox && Array.isArray(data.messages)) {
      for (const msg of data.messages) {
        const text = msg.text || msg.content || msg.message || '';
        // Skip noisy protocol messages (idle notifications, shutdown acks)
        if (text.includes('"type":"idle_notification"') || text.includes('"type":"shutdown_')) continue;
        // Use summary if available, otherwise use full text
        const content = msg.summary || text;
        messages.push({
          timestamp: msg.timestamp || new Date().toISOString(),
          from: msg.from || msg.sender || 'unknown',
          to: data._agent || 'all',
          content,
          type: msg.type || 'chat',
        });
      }
    }

    // Extract messages from legacy formats
    else if (Array.isArray(data.messages)) {
      for (const msg of data.messages) {
        messages.push({
          timestamp: msg.timestamp || new Date().toISOString(),
          from: msg.from || msg.sender || 'unknown',
          to: msg.to || msg.recipient || 'all',
          content: msg.content || msg.text || msg.message || '',
          type: msg.type || 'chat',
        });
      }
    }

    // Extract conversation if present
    if (Array.isArray(data.conversation)) {
      for (const msg of data.conversation) {
        messages.push({
          timestamp: msg.timestamp || new Date().toISOString(),
          from: msg.from || msg.role || 'unknown',
          to: msg.to || 'all',
          content: msg.content || msg.text || '',
          type: msg.type || 'chat',
        });
      }
    }
  }

  return { agents, messages };
}

function processTaskData(taskFiles) {
  const tasks = [];
  for (const [file, data] of Object.entries(taskFiles)) {
    if (Array.isArray(data)) {
      for (const t of data) {
        tasks.push({
          id: t.id || file + '-' + tasks.length,
          title: t.title || t.name || t.description || 'Untitled',
          status: normalizeStatus(t.status || t.state || 'pending'),
          assignedTo: t.assigned_to || t.assignee || t.agent || null,
          createdAt: t.created_at || t.timestamp || new Date().toISOString(),
          updatedAt: t.updated_at || null,
        });
      }
    } else if (data && typeof data === 'object') {
      if (data.tasks && Array.isArray(data.tasks)) {
        for (const t of data.tasks) {
          tasks.push({
            id: t.id || file + '-' + tasks.length,
            title: t.title || t.name || t.description || 'Untitled',
            status: normalizeStatus(t.status || t.state || 'pending'),
            assignedTo: t.assigned_to || t.assignee || t.agent || null,
            createdAt: t.created_at || t.timestamp || new Date().toISOString(),
            updatedAt: t.updated_at || null,
          });
        }
      } else if (data.title || data.name) {
        tasks.push({
          id: data.id || file.replace('.json', ''),
          title: data.title || data.name || 'Untitled',
          status: normalizeStatus(data.status || data.state || 'pending'),
          assignedTo: data.assigned_to || data.assignee || data.agent || null,
          createdAt: data.created_at || new Date().toISOString(),
          updatedAt: data.updated_at || null,
        });
      }
    }
  }
  return tasks;
}

function normalizeStatus(s) {
  const lower = (s || '').toLowerCase().replace(/[^a-z]/g, '');
  if (lower.includes('progress') || lower.includes('active') || lower.includes('running')) return 'in_progress';
  if (lower.includes('complete') || lower.includes('done') || lower.includes('finished')) return 'completed';
  return 'pending';
}

function refreshState() {
  const teamFiles = scanTeams();
  const taskFiles = scanTasks();

  const { agents, messages } = processTeamData(teamFiles);
  const tasks = processTaskData(taskFiles);

  // Detect changes
  const teamsChanged = JSON.stringify(teamFiles) !== JSON.stringify(lastTeamFiles);
  const tasksChanged = JSON.stringify(taskFiles) !== JSON.stringify(lastTaskFiles);

  if (!teamsChanged && !tasksChanged) return;

  lastTeamFiles = teamFiles;
  lastTaskFiles = taskFiles;

  // Start session if we have agents and no session
  if (agents.length > 0 && !state.sessionId) {
    startSession();
  }

  // End session if agents disappear
  if (agents.length === 0 && state.agents.length > 0 && state.sessionId) {
    endSession();
  }

  state.agents = agents;
  state.messages = messages;
  state.tasks = tasks;

  // Persist to SQLite
  persistState();

  broadcast('state', {
    agents: state.agents,
    messages: state.messages,
    tasks: state.tasks,
    sessionId: state.sessionId,
    startedAt: state.startedAt,
  });
}

function startSession() {
  state.startedAt = new Date().toISOString();
  if (db) {
    const info = db.prepare('INSERT INTO sessions (started_at) VALUES (?)').run(state.startedAt);
    state.sessionId = info.lastInsertRowid;
  } else {
    state.sessionId = Date.now();
  }
}

function endSession() {
  const endedAt = new Date().toISOString();
  if (db && state.sessionId) {
    db.prepare('UPDATE sessions SET ended_at = ?, agent_count = ?, message_count = ?, task_count = ?, snapshot = ? WHERE id = ?')
      .run(endedAt, state.agents.length, state.messages.length, state.tasks.length, JSON.stringify(state), state.sessionId);
  }
  resetState();
}

function persistState() {
  if (!db || !state.sessionId) return;
  try {
    db.prepare('UPDATE sessions SET agent_count = ?, message_count = ?, task_count = ?, snapshot = ? WHERE id = ?')
      .run(state.agents.length, state.messages.length, state.tasks.length, JSON.stringify(state), state.sessionId);
  } catch (_) {}
}

function startWatching() {
  ensureDir(TEAMS_DIR);
  ensureDir(TASKS_DIR);

  // fs.watch (fast but unreliable on macOS) — watch top-level and subdirectories
  try {
    watchers.push(fs.watch(TEAMS_DIR, { persistent: false }, () => refreshState()));
    // Also watch subdirectories (TeamCreate stores config in teams/<name>/config.json)
    // and inbox directories (teams/<name>/inboxes/) for live message updates
    for (const entry of fs.readdirSync(TEAMS_DIR)) {
      const fp = path.join(TEAMS_DIR, entry);
      try {
        if (fs.statSync(fp).isDirectory()) {
          watchers.push(fs.watch(fp, { persistent: false }, () => refreshState()));
          const inboxDir = path.join(fp, 'inboxes');
          if (fs.existsSync(inboxDir)) watchers.push(fs.watch(inboxDir, { persistent: false }, () => refreshState()));
        }
      } catch (_) {}
    }
  } catch (_) {}
  try {
    watchers.push(fs.watch(TASKS_DIR, { persistent: false }, () => refreshState()));
    // Also watch subdirectories (TaskCreate stores tasks in tasks/<team-name>/)
    for (const entry of fs.readdirSync(TASKS_DIR)) {
      const fp = path.join(TASKS_DIR, entry);
      try { if (fs.statSync(fp).isDirectory()) watchers.push(fs.watch(fp, { persistent: false }, () => refreshState())); } catch (_) {}
    }
  } catch (_) {}

  // Polling fallback
  setInterval(refreshState, POLL_INTERVAL);

  // Initial scan
  refreshState();
}

function stopWatching() {
  for (const w of watchers) {
    try { w.close(); } catch (_) {}
  }
  watchers = [];
}

// ─── HTTP Server ────────────────────────────────────────────────────────────
const CACHE_HEADERS = {
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'Pragma': 'no-cache',
  'Expires': '0',
};

function jsonResponse(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, { ...CACHE_HEADERS, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 1e6) reject(new Error('Too large')); });
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const pathname = req.url.split('?')[0];
  const method = req.method;

  // GET / — serve dashboard HTML
  if (method === 'GET' && pathname === '/') {
    const html = getDashboardHTML();
    res.writeHead(200, { ...CACHE_HEADERS, 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html) });
    res.end(html);
    return;
  }

  // GET /api/state
  if (method === 'GET' && pathname === '/api/state') {
    jsonResponse(res, {
      agents: state.agents,
      messages: state.messages,
      tasks: state.tasks,
      sessionId: state.sessionId,
      startedAt: state.startedAt,
    });
    return;
  }

  // POST /api/state — manual state update for testing
  if (method === 'POST' && pathname === '/api/state') {
    try {
      const body = await parseBody(req);
      if (body.agents) state.agents = body.agents;
      if (body.messages) state.messages = body.messages;
      if (body.tasks) state.tasks = body.tasks;
      if (!state.sessionId) startSession();
      persistState();
      broadcast('state', {
        agents: state.agents,
        messages: state.messages,
        tasks: state.tasks,
        sessionId: state.sessionId,
        startedAt: state.startedAt,
      });
      jsonResponse(res, { ok: true });
    } catch (e) {
      jsonResponse(res, { error: e.message }, 400);
    }
    return;
  }

  // GET /api/events — SSE
  if (method === 'GET' && pathname === '/api/events') {
    res.writeHead(200, {
      ...CACHE_HEADERS,
      'Content-Type': 'text/event-stream',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`event: state\ndata: ${JSON.stringify({
      agents: state.agents,
      messages: state.messages,
      tasks: state.tasks,
      sessionId: state.sessionId,
      startedAt: state.startedAt,
    })}\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  // GET /api/sessions
  if (method === 'GET' && pathname === '/api/sessions') {
    if (!db) { jsonResponse(res, []); return; }
    try {
      const rows = db.prepare('SELECT id, started_at, ended_at, agent_count, message_count, task_count FROM sessions ORDER BY id DESC LIMIT 50').all();
      jsonResponse(res, rows);
    } catch (_) { jsonResponse(res, []); }
    return;
  }

  // GET /api/sessions/:id
  const sessionMatch = pathname.match(/^\/api\/sessions\/(\d+)$/);
  if (method === 'GET' && sessionMatch) {
    if (!db) { jsonResponse(res, { error: 'No database' }, 404); return; }
    const id = parseInt(sessionMatch[1], 10);
    try {
      const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
      if (!row) { jsonResponse(res, { error: 'Not found' }, 404); return; }
      let snapshot = null;
      try { snapshot = JSON.parse(row.snapshot); } catch (_) {}
      jsonResponse(res, { ...row, snapshot });
    } catch (_) { jsonResponse(res, { error: 'DB error' }, 500); }
    return;
  }

  // DELETE /api/sessions/:id
  if (method === 'DELETE' && sessionMatch) {
    if (!db) { jsonResponse(res, { error: 'No database' }, 404); return; }
    const id = parseInt(sessionMatch[1], 10);
    try {
      db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
      jsonResponse(res, { ok: true });
    } catch (_) { jsonResponse(res, { error: 'DB error' }, 500); }
    return;
  }

  // 404
  jsonResponse(res, { error: 'Not found' }, 404);
});

// ─── Startup ────────────────────────────────────────────────────────────────
initDatabase();
startWatching();

server.listen(PORT, () => {
  console.log(`[surveillance] Dashboard live at http://localhost:${PORT}`);
  // Auto-open browser
  const openCmd = process.platform === 'darwin' ? 'open' :
                  process.platform === 'win32' ? 'start' : 'xdg-open';
  exec(`${openCmd} http://localhost:${PORT}`);
});

process.on('SIGINT', () => {
  console.log('\n[surveillance] Shutting down...');
  stopWatching();
  if (state.sessionId) endSession();
  if (db) db.close();
  server.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  stopWatching();
  if (state.sessionId) endSession();
  if (db) db.close();
  server.close();
  process.exit(0);
});

// ─── Dashboard HTML ─────────────────────────────────────────────────────────
function getDashboardHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Agent Surveillance</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg-primary: #0d1117;
    --bg-secondary: #161b22;
    --bg-tertiary: #21262d;
    --bg-card: #1c2128;
    --border: #30363d;
    --text-primary: #e6edf3;
    --text-secondary: #8b949e;
    --text-muted: #6e7681;
    --accent-blue: #58a6ff;
    --accent-green: #3fb950;
    --accent-yellow: #d29922;
    --accent-red: #f85149;
    --accent-purple: #bc8cff;
    --status-pending: #d29922;
    --status-progress: #58a6ff;
    --status-completed: #3fb950;
    --radius: 8px;
    --shadow: 0 2px 8px rgba(0,0,0,0.3);
  }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, sans-serif;
    background: var(--bg-primary);
    color: var(--text-primary);
    height: 100vh;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
  /* ─── Header ─── */
  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 24px;
    background: var(--bg-secondary);
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }
  .header-left {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .header h1 {
    font-size: 18px;
    font-weight: 600;
    letter-spacing: -0.3px;
  }
  .header h1 span { color: var(--accent-blue); }
  .status-dot {
    width: 8px; height: 8px;
    border-radius: 50%;
    background: var(--accent-green);
    animation: pulse 2s infinite;
  }
  .status-dot.offline { background: var(--text-muted); animation: none; }
  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }
  .mode-toggle {
    display: flex;
    background: var(--bg-tertiary);
    border-radius: var(--radius);
    overflow: hidden;
    border: 1px solid var(--border);
  }
  .mode-btn {
    padding: 6px 16px;
    border: none;
    background: transparent;
    color: var(--text-secondary);
    cursor: pointer;
    font-size: 13px;
    font-weight: 500;
    transition: all 0.2s;
  }
  .mode-btn.active {
    background: var(--accent-blue);
    color: #fff;
  }
  .mode-btn:hover:not(.active) { color: var(--text-primary); }

  /* ─── Main layout ─── */
  .main { display: flex; flex-direction: column; flex: 1; overflow: hidden; }
  .main.hidden { display: none; }
  .main-top { display: flex; flex: 1; overflow: hidden; min-height: 0; }
  .main-bottom { border-top: 1px solid var(--border); }

  /* ─── Agent Roster (left) ─── */
  .roster {
    width: 240px;
    min-width: 240px;
    background: var(--bg-secondary);
    border-right: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .roster-header {
    padding: 14px 16px;
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--text-secondary);
    border-bottom: 1px solid var(--border);
  }
  .roster-list {
    flex: 1;
    overflow-y: auto;
    padding: 8px;
  }
  .agent-card {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 12px;
    border-radius: var(--radius);
    margin-bottom: 4px;
    transition: background 0.15s;
    cursor: default;
  }
  .agent-card:hover { background: var(--bg-tertiary); }
  .agent-avatar {
    width: 36px; height: 36px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: 700;
    font-size: 14px;
    color: #fff;
    flex-shrink: 0;
    text-shadow: 0 1px 2px rgba(0,0,0,0.3);
  }
  .agent-info { flex: 1; min-width: 0; }
  .agent-name {
    font-size: 14px;
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .agent-role {
    font-size: 11px;
    color: var(--text-muted);
    text-transform: capitalize;
  }
  .agent-status-dot {
    width: 8px; height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .agent-status-dot.active { background: var(--accent-green); }
  .agent-status-dot.idle { background: var(--accent-yellow); }
  .agent-status-dot.done { background: var(--accent-blue); }
  .agent-status-dot.offline { background: var(--text-muted); }
  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 40px 20px;
    text-align: center;
    color: var(--text-muted);
    gap: 8px;
  }
  .empty-icon { font-size: 32px; opacity: 0.5; }
  .empty-text { font-size: 13px; }

  /* ─── Message Feed (center) ─── */
  .feed {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    min-width: 0;
  }
  .feed-header {
    padding: 14px 20px;
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--text-secondary);
    border-bottom: 1px solid var(--border);
    background: var(--bg-primary);
  }
  .feed-list {
    flex: 1;
    overflow-y: auto;
    padding: 16px 20px;
  }
  .message {
    display: flex;
    gap: 12px;
    padding: 12px 0;
    border-bottom: 1px solid var(--border);
    animation: fadeIn 0.3s ease;
  }
  @keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
  .message:last-child { border-bottom: none; }
  .msg-avatar {
    width: 32px; height: 32px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: 700;
    font-size: 12px;
    color: #fff;
    flex-shrink: 0;
  }
  .msg-body { flex: 1; min-width: 0; }
  .msg-header {
    display: flex;
    align-items: baseline;
    gap: 8px;
    margin-bottom: 4px;
  }
  .msg-from { font-weight: 600; font-size: 14px; }
  .msg-arrow { color: var(--text-muted); font-size: 12px; }
  .msg-to { font-weight: 500; font-size: 13px; color: var(--text-secondary); }
  .msg-time { font-size: 11px; color: var(--text-muted); margin-left: auto; }
  .msg-content {
    font-size: 13px;
    line-height: 1.5;
    color: var(--text-secondary);
    word-break: break-word;
  }
  .msg-content code {
    background: var(--bg-tertiary);
    padding: 1px 5px;
    border-radius: 3px;
    font-size: 12px;
    font-family: 'SF Mono', Monaco, Consolas, monospace;
  }
  .msg-content pre {
    background: var(--bg-tertiary);
    padding: 10px;
    border-radius: var(--radius);
    overflow-x: auto;
    margin: 6px 0;
    font-size: 12px;
    font-family: 'SF Mono', Monaco, Consolas, monospace;
  }
  .protocol-card {
    background: var(--bg-tertiary);
    border-left: 3px solid var(--accent-purple);
    padding: 8px 12px;
    border-radius: 0 var(--radius) var(--radius) 0;
    margin-top: 4px;
    font-size: 12px;
  }

  /* ─── Task Board (right) ─── */
  .taskboard {
    background: var(--bg-secondary);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    max-height: 280px;
  }
  .taskboard-header {
    padding: 10px 16px;
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--text-secondary);
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }
  .taskboard-columns {
    flex: 1;
    overflow-y: auto;
    padding: 12px 16px;
    display: flex;
    gap: 16px;
  }
  .task-column {
    flex: 1;
    min-width: 0;
  }
  .column-header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
    padding: 0 4px;
  }
  .column-dot {
    width: 10px; height: 10px;
    border-radius: 50%;
  }
  .column-dot.pending { background: var(--status-pending); }
  .column-dot.in_progress { background: var(--status-progress); }
  .column-dot.completed { background: var(--status-completed); }
  .column-title {
    font-size: 13px;
    font-weight: 600;
  }
  .column-count {
    font-size: 11px;
    color: var(--text-muted);
    background: var(--bg-tertiary);
    padding: 1px 7px;
    border-radius: 10px;
  }
  .task-card {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 12px;
    margin-bottom: 8px;
    transition: border-color 0.15s;
  }
  .task-card:hover { border-color: var(--text-muted); }
  .task-card.pending { border-left: 3px solid var(--status-pending); }
  .task-card.in_progress { border-left: 3px solid var(--status-progress); }
  .task-card.completed { border-left: 3px solid var(--status-completed); }
  .task-title { font-size: 13px; font-weight: 500; margin-bottom: 6px; }
  .task-meta {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 11px;
    color: var(--text-muted);
  }
  .task-assignee {
    background: var(--bg-tertiary);
    padding: 2px 8px;
    border-radius: 10px;
  }

  /* ─── History Mode ─── */
  .history { display: none; flex: 1; overflow-y: auto; padding: 24px; }
  .history.visible { display: block; }
  .history-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 16px;
  }
  .session-card {
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 20px;
    cursor: pointer;
    transition: all 0.15s;
    position: relative;
  }
  .session-card:hover {
    border-color: var(--accent-blue);
    transform: translateY(-2px);
    box-shadow: var(--shadow);
  }
  .session-card .delete-btn {
    position: absolute;
    top: 10px;
    right: 10px;
    background: var(--accent-red);
    color: #fff;
    border: none;
    border-radius: 4px;
    width: 24px;
    height: 24px;
    cursor: pointer;
    font-size: 14px;
    display: none;
    align-items: center;
    justify-content: center;
  }
  .session-card:hover .delete-btn { display: flex; }
  .session-date { font-size: 14px; font-weight: 600; margin-bottom: 4px; }
  .session-time { font-size: 12px; color: var(--text-muted); margin-bottom: 12px; }
  .session-stats {
    display: flex;
    gap: 16px;
  }
  .session-stat {
    text-align: center;
  }
  .stat-value {
    font-size: 20px;
    font-weight: 700;
    color: var(--accent-blue);
  }
  .stat-label {
    font-size: 10px;
    text-transform: uppercase;
    color: var(--text-muted);
    letter-spacing: 0.3px;
  }
  .history-empty {
    text-align: center;
    padding: 80px 20px;
    color: var(--text-muted);
  }

  /* ─── Session Detail Overlay ─── */
  .session-detail {
    display: none;
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.6);
    z-index: 100;
    align-items: center;
    justify-content: center;
    padding: 24px;
  }
  .session-detail.visible {
    display: flex;
  }
  .detail-panel {
    background: var(--bg-primary);
    border: 1px solid var(--border);
    border-radius: 12px;
    width: 95vw;
    max-width: 1200px;
    height: 80vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .detail-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 20px;
    border-bottom: 1px solid var(--border);
    background: var(--bg-secondary);
  }
  .detail-close {
    background: none;
    border: 1px solid var(--border);
    color: var(--text-secondary);
    width: 32px;
    height: 32px;
    border-radius: var(--radius);
    cursor: pointer;
    font-size: 16px;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .detail-close:hover { color: var(--text-primary); border-color: var(--text-muted); }
  .detail-body {
    flex: 1;
    display: flex;
    overflow: hidden;
  }

  /* Scrollbar */
  ::-webkit-scrollbar { width: 6px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
  ::-webkit-scrollbar-thumb:hover { background: var(--text-muted); }
</style>
</head>
<body>
  <div class="header">
    <div class="header-left">
      <div class="status-dot" id="statusDot"></div>
      <h1><span>Agent</span> Surveillance</h1>
    </div>
    <div class="mode-toggle">
      <button class="mode-btn active" data-mode="live" onclick="switchMode('live')">Live</button>
      <button class="mode-btn" data-mode="history" onclick="switchMode('history')">History</button>
    </div>
  </div>

  <div class="main" id="liveView">
    <div class="main-top">
      <div class="roster">
        <div class="roster-header">Agent Roster <span id="agentCount">(0)</span></div>
        <div class="roster-list" id="rosterList">
          <div class="empty-state"><div class="empty-icon">&#x1F916;</div><div class="empty-text">No agents detected</div></div>
        </div>
      </div>
      <div class="feed">
        <div class="feed-header">Message Feed <span id="msgCount">(0)</span></div>
        <div class="feed-list" id="feedList">
          <div class="empty-state"><div class="empty-icon">&#x1F4AC;</div><div class="empty-text">No messages yet</div></div>
        </div>
      </div>
    </div>
    <div class="main-bottom">
      <div class="taskboard">
        <div class="taskboard-header">Task Board <span id="taskCount">(0)</span></div>
        <div class="taskboard-columns" id="taskColumns">
          <div class="empty-state"><div class="empty-icon">&#x1F4CB;</div><div class="empty-text">No tasks tracked</div></div>
        </div>
      </div>
    </div>
  </div>

  <div class="history" id="historyView">
    <div class="history-grid" id="historyGrid">
      <div class="history-empty">No sessions recorded yet.</div>
    </div>
  </div>

  <div class="session-detail" id="sessionDetail">
    <div class="detail-panel">
      <div class="detail-header">
        <strong id="detailTitle">Session Detail</strong>
        <button class="detail-close" onclick="closeDetail()">X</button>
      </div>
      <div class="detail-body" id="detailBody"></div>
    </div>
  </div>

<script>
(function() {
  // ─── State ──────────────────────────────────────────────
  var currentState = { agents: [], messages: [], tasks: [] };
  var mode = 'live';
  var evtSource = null;

  // ─── SSE Connection ─────────────────────────────────────
  function connectSSE() {
    if (evtSource) evtSource.close();
    evtSource = new EventSource('/api/events');

    evtSource.addEventListener('state', function(e) {
      try {
        currentState = JSON.parse(e.data);
        console.log('[surveillance] SSE state received:', currentState.agents.length, 'agents,', currentState.tasks.length, 'tasks');
        if (mode === 'live') renderLive();
      } catch(err) { console.error('[surveillance] SSE parse error:', err); }
    });

    evtSource.onerror = function() {
      document.getElementById('statusDot').classList.add('offline');
    };

    evtSource.onopen = function() {
      document.getElementById('statusDot').classList.remove('offline');
    };
  }

  // ─── Mode switching ─────────────────────────────────────
  window.switchMode = function(m) {
    mode = m;
    var btns = document.querySelectorAll('.mode-btn');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('active', btns[i].getAttribute('data-mode') === m);
    }
    document.getElementById('liveView').classList.toggle('hidden', m !== 'live');
    var hv = document.getElementById('historyView');
    if (m === 'history') {
      hv.classList.add('visible');
      loadHistory();
    } else {
      hv.classList.remove('visible');
      renderLive();
    }
  };

  // ─── Color from name ───────────────────────────────────
  function nameToColor(name) {
    var hash = 0;
    for (var i = 0; i < name.length; i++) {
      hash = name.charCodeAt(i) + ((hash << 5) - hash);
    }
    var h = Math.abs(hash) % 360;
    return 'hsl(' + h + ', 70%, 60%)';
  }

  function initials(name) {
    var parts = name.split(/[^a-zA-Z0-9]+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return name.substring(0, 2).toUpperCase();
  }

  // ─── Simple markdown ───────────────────────────────────
  function renderMarkdown(text) {
    if (!text) return '';
    var s = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    // Code blocks
    s = s.replace(/\x60\x60\x60([^]*?)\x60\x60\x60/g, '<pre>$1</pre>');
    // Inline code
    s = s.replace(/\x60([^\x60]+)\x60/g, '<code>$1</code>');
    // Bold
    s = s.replace(/[*][*]([^*]+)[*][*]/g, '<strong>$1</strong>');
    // Italic
    s = s.replace(/[*]([^*]+)[*]/g, '<em>$1</em>');
    // Line breaks
    s = s.replace(new RegExp('\\n', 'g'), '<br>');
    return s;
  }

  // ─── Detect protocol messages ──────────────────────────
  function isProtocol(content) {
    if (!content) return false;
    var lower = content.toLowerCase();
    return lower.indexOf('task:') === 0 ||
           lower.indexOf('idle') !== -1 ||
           lower.indexOf('shutdown') !== -1 ||
           lower.indexOf('assigned') !== -1;
  }

  // ─── Format time ───────────────────────────────────────
  function formatTime(ts) {
    if (!ts) return '';
    try {
      var d = new Date(ts);
      return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    } catch(_) { return ts; }
  }

  function formatDate(ts) {
    if (!ts) return '';
    try {
      var d = new Date(ts);
      return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    } catch(_) { return ts; }
  }

  // ─── Render Live ───────────────────────────────────────
  function renderLive() {
    renderRoster();
    renderFeed();
    renderTaskBoard();
  }

  function renderRoster() {
    var el = document.getElementById('rosterList');
    var agents = currentState.agents || [];
    document.getElementById('agentCount').textContent = '(' + agents.length + ')';

    if (agents.length === 0) {
      el.innerHTML = '<div class="empty-state"><div class="empty-icon">&#x1F916;</div><div class="empty-text">No agents detected</div></div>';
      return;
    }

    var html = '';
    for (var i = 0; i < agents.length; i++) {
      var a = agents[i];
      var color = a.color || nameToColor(a.name);
      var statusClass = (a.status || 'active').toLowerCase();
      html += '<div class="agent-card">' +
        '<div class="agent-avatar" style="background:' + color + '">' + initials(a.name) + '</div>' +
        '<div class="agent-info">' +
          '<div class="agent-name">' + escHtml(a.name) + '</div>' +
          '<div class="agent-role">' + escHtml(a.role || 'agent') + '</div>' +
        '</div>' +
        '<div class="agent-status-dot ' + statusClass + '"></div>' +
      '</div>';
    }
    el.innerHTML = html;
  }

  function renderFeed() {
    var el = document.getElementById('feedList');
    var msgs = currentState.messages || [];
    document.getElementById('msgCount').textContent = '(' + msgs.length + ')';

    if (msgs.length === 0) {
      el.innerHTML = '<div class="empty-state"><div class="empty-icon">&#x1F4AC;</div><div class="empty-text">No messages yet</div></div>';
      return;
    }

    var html = '';
    for (var i = 0; i < msgs.length; i++) {
      var m = msgs[i];
      var fromColor = nameToColor(m.from || 'unknown');
      var contentHtml = renderMarkdown(m.content);
      var protocol = isProtocol(m.content);

      html += '<div class="message">' +
        '<div class="msg-avatar" style="background:' + fromColor + '">' + initials(m.from || '??') + '</div>' +
        '<div class="msg-body">' +
          '<div class="msg-header">' +
            '<span class="msg-from">' + escHtml(m.from || 'unknown') + '</span>' +
            '<span class="msg-arrow">-&gt;</span>' +
            '<span class="msg-to">' + escHtml(m.to || 'all') + '</span>' +
            '<span class="msg-time">' + formatTime(m.timestamp) + '</span>' +
          '</div>' +
          (protocol
            ? '<div class="protocol-card">' + contentHtml + '</div>'
            : '<div class="msg-content">' + contentHtml + '</div>') +
        '</div>' +
      '</div>';
    }
    el.innerHTML = html;
    el.scrollTop = el.scrollHeight;
  }

  function renderTaskBoard() {
    var el = document.getElementById('taskColumns');
    var tasks = currentState.tasks || [];
    document.getElementById('taskCount').textContent = '(' + tasks.length + ')';

    if (tasks.length === 0) {
      el.innerHTML = '<div class="empty-state"><div class="empty-icon">&#x1F4CB;</div><div class="empty-text">No tasks tracked</div></div>';
      return;
    }

    var cols = { pending: [], in_progress: [], completed: [] };
    for (var i = 0; i < tasks.length; i++) {
      var t = tasks[i];
      var status = t.status || 'pending';
      if (!cols[status]) cols[status] = [];
      cols[status].push(t);
    }

    var labels = { pending: 'Pending', in_progress: 'In Progress', completed: 'Completed' };
    var html = '';
    var order = ['pending', 'in_progress', 'completed'];

    for (var c = 0; c < order.length; c++) {
      var key = order[c];
      var items = cols[key] || [];
      html += '<div class="task-column">' +
        '<div class="column-header">' +
          '<div class="column-dot ' + key + '"></div>' +
          '<span class="column-title">' + labels[key] + '</span>' +
          '<span class="column-count">' + items.length + '</span>' +
        '</div>';

      for (var j = 0; j < items.length; j++) {
        var tk = items[j];
        html += '<div class="task-card ' + key + '">' +
          '<div class="task-title">' + escHtml(tk.title) + '</div>' +
          '<div class="task-meta">' +
            (tk.assignedTo ? '<span class="task-assignee">' + escHtml(tk.assignedTo) + '</span>' : '') +
            '<span>' + formatTime(tk.createdAt) + '</span>' +
          '</div>' +
        '</div>';
      }
      html += '</div>';
    }
    el.innerHTML = html;
  }

  // ─── History ───────────────────────────────────────────
  function loadHistory() {
    fetch('/api/sessions').then(function(r) { return r.json(); }).then(function(sessions) {
      var grid = document.getElementById('historyGrid');
      if (!sessions || sessions.length === 0) {
        grid.innerHTML = '<div class="history-empty">No sessions recorded yet.</div>';
        return;
      }
      var html = '';
      for (var i = 0; i < sessions.length; i++) {
        var s = sessions[i];
        html += '<div class="session-card" onclick="viewSession(' + s.id + ')">' +
          '<button class="delete-btn" onclick="event.stopPropagation(); deleteSession(' + s.id + ')">X</button>' +
          '<div class="session-date">' + formatDate(s.started_at) + '</div>' +
          '<div class="session-time">' + formatTime(s.started_at) +
            (s.ended_at ? ' - ' + formatTime(s.ended_at) : ' (active)') + '</div>' +
          '<div class="session-stats">' +
            '<div class="session-stat"><div class="stat-value">' + (s.agent_count || 0) + '</div><div class="stat-label">Agents</div></div>' +
            '<div class="session-stat"><div class="stat-value">' + (s.message_count || 0) + '</div><div class="stat-label">Messages</div></div>' +
            '<div class="session-stat"><div class="stat-value">' + (s.task_count || 0) + '</div><div class="stat-label">Tasks</div></div>' +
          '</div>' +
        '</div>';
      }
      grid.innerHTML = html;
    }).catch(function() {
      document.getElementById('historyGrid').innerHTML = '<div class="history-empty">Failed to load sessions.</div>';
    });
  }

  window.viewSession = function(id) {
    fetch('/api/sessions/' + id).then(function(r) { return r.json(); }).then(function(data) {
      if (!data || data.error) return;
      document.getElementById('detailTitle').textContent = 'Session #' + id + ' - ' + formatDate(data.started_at);
      var snap = data.snapshot || { agents: [], messages: [], tasks: [] };
      var body = document.getElementById('detailBody');
      body.innerHTML =
        '<div class="roster" style="border-right:1px solid var(--border)">' +
          '<div class="roster-header">Agents (' + (snap.agents || []).length + ')</div>' +
          '<div class="roster-list">' + renderAgentListHTML(snap.agents || []) + '</div>' +
        '</div>' +
        '<div class="feed">' +
          '<div class="feed-header">Messages (' + (snap.messages || []).length + ')</div>' +
          '<div class="feed-list">' + renderFeedHTML(snap.messages || []) + '</div>' +
        '</div>' +
        '<div class="taskboard" style="border-left:1px solid var(--border)">' +
          '<div class="taskboard-header">Tasks (' + (snap.tasks || []).length + ')</div>' +
          '<div class="taskboard-columns">' + renderTasksHTML(snap.tasks || []) + '</div>' +
        '</div>';
      document.getElementById('sessionDetail').classList.add('visible');
    });
  };

  function renderAgentListHTML(agents) {
    if (!agents.length) return '<div class="empty-state"><div class="empty-text">No agents</div></div>';
    var html = '';
    for (var i = 0; i < agents.length; i++) {
      var a = agents[i];
      var color = a.color || nameToColor(a.name);
      html += '<div class="agent-card">' +
        '<div class="agent-avatar" style="background:' + color + '">' + initials(a.name) + '</div>' +
        '<div class="agent-info"><div class="agent-name">' + escHtml(a.name) + '</div>' +
        '<div class="agent-role">' + escHtml(a.role || 'agent') + '</div></div></div>';
    }
    return html;
  }

  function renderFeedHTML(msgs) {
    if (!msgs.length) return '<div class="empty-state"><div class="empty-text">No messages</div></div>';
    var html = '';
    for (var i = 0; i < msgs.length; i++) {
      var m = msgs[i];
      var fromColor = nameToColor(m.from || 'unknown');
      html += '<div class="message">' +
        '<div class="msg-avatar" style="background:' + fromColor + '">' + initials(m.from || '??') + '</div>' +
        '<div class="msg-body">' +
          '<div class="msg-header">' +
            '<span class="msg-from">' + escHtml(m.from || 'unknown') + '</span>' +
            '<span class="msg-arrow">-&gt;</span>' +
            '<span class="msg-to">' + escHtml(m.to || 'all') + '</span>' +
            '<span class="msg-time">' + formatTime(m.timestamp) + '</span>' +
          '</div>' +
          '<div class="msg-content">' + renderMarkdown(m.content) + '</div>' +
        '</div></div>';
    }
    return html;
  }

  function renderTasksHTML(tasks) {
    if (!tasks.length) return '<div class="empty-state"><div class="empty-text">No tasks</div></div>';
    var cols = { pending: [], in_progress: [], completed: [] };
    for (var i = 0; i < tasks.length; i++) {
      var st = tasks[i].status || 'pending';
      if (!cols[st]) cols[st] = [];
      cols[st].push(tasks[i]);
    }
    var labels = { pending: 'Pending', in_progress: 'In Progress', completed: 'Completed' };
    var order = ['pending', 'in_progress', 'completed'];
    var html = '';
    for (var c = 0; c < order.length; c++) {
      var key = order[c];
      var items = cols[key] || [];
      html += '<div class="task-column">' +
        '<div class="column-header"><div class="column-dot ' + key + '"></div>' +
        '<span class="column-title">' + labels[key] + '</span>' +
        '<span class="column-count">' + items.length + '</span></div>';
      for (var j = 0; j < items.length; j++) {
        var tk = items[j];
        html += '<div class="task-card ' + key + '">' +
          '<div class="task-title">' + escHtml(tk.title) + '</div>' +
          '<div class="task-meta">' +
          (tk.assignedTo ? '<span class="task-assignee">' + escHtml(tk.assignedTo) + '</span>' : '') + '</div></div>';
      }
      html += '</div>';
    }
    return html;
  }

  window.deleteSession = function(id) {
    fetch('/api/sessions/' + id, { method: 'DELETE' }).then(function() { loadHistory(); });
  };

  window.closeDetail = function() {
    document.getElementById('sessionDetail').classList.remove('visible');
  };

  // ─── Utility ───────────────────────────────────────────
  function escHtml(s) {
    if (!s) return '';
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ─── Init ──────────────────────────────────────────────
  connectSSE();

  // Close detail on Escape
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') closeDetail();
  });

  // Click outside detail to close
  document.getElementById('sessionDetail').addEventListener('click', function(e) {
    if (e.target === this) closeDetail();
  });

})();
</script>
</body>
</html>`;
}
