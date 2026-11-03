'use strict';
// What a paper needs beyond the extension for an agent to take part in its review, offered when
// review starts ("Mâché: Finish setting up"): the mache command on the PATH, a note telling the
// agent about it, and colours that show removed text in red. Plain Node, so it is testable
// without VS Code; the extension asks before doing any of it.
const fs = require('fs');
const os = require('os');
const path = require('path');

const MARK = '# mache launcher written by the Mâché extension';

// ---------- the mache command ----------

// Where the launcher goes: ~/.local/bin, which Ubuntu, Fedora and macOS shells put on the PATH
// once it exists (MACHE_BIN_DIR overrides it, for tests).
const binDir = () => process.env.MACHE_BIN_DIR || path.join(os.homedir(), '.local', 'bin');

// A launcher for the cli.js shipped inside the extension. `node` if the shell has one, else the
// Node that runs VS Code itself (Electron, told to act as Node), so it works even where Node
// is only installed through nvm. Rewritten whenever the extension starts, so it follows updates.
function launcherText(extensionDir, execPath) {
  const cli = path.join(extensionDir, 'cli.js');
  const q = s => `'${s.replace(/'/g, `'\\''`)}'`;
  return `#!/bin/sh
${MARK}; it is rewritten when the extension updates.
if command -v node >/dev/null 2>&1; then exec node ${q(cli)} "$@"; fi
ELECTRON_RUN_AS_NODE=1 exec ${q(execPath)} ${q(cli)} "$@"
`;
}

const launcherPath = () => path.join(binDir(), 'mache');
const isOurs = p => { try { return fs.readFileSync(p, 'utf8').includes(MARK); } catch { return false; } };

// The mache command a shell would run, if there is one (other than a launcher of ours).
function commandOnPath(envPath = process.env.PATH || '') {
  for (const dir of envPath.split(path.delimiter).filter(Boolean)) {
    const p = path.join(dir, 'mache');
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* not here */ }
  }
  return undefined;
}

function hasCommand() {
  // With MACHE_BIN_DIR set (tests), only that folder counts, whatever this machine has installed.
  if (process.env.MACHE_BIN_DIR) return !!commandOnPath(process.env.MACHE_BIN_DIR);
  return !!commandOnPath() || isOurs(launcherPath());
}

// Write the launcher. Never replaces a mache that is not ours (an npm install, say).
function installLauncher(extensionDir, execPath) {
  if (process.platform === 'win32') return { ok: false, why: 'on Windows, install the command with npm (see the README)' };
  const p = launcherPath();
  if (fs.existsSync(p) && !isOurs(p)) return { ok: false, why: `${p} is another program; left as it is` };
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, launcherText(extensionDir, execPath), { mode: 0o755 });
  fs.chmodSync(p, 0o755);
  const onPath = (process.env.PATH || '').split(path.delimiter).includes(path.dirname(p));
  return { ok: true, path: p, onPath };
}

// On every start: keep an existing launcher of ours pointing at this copy of the extension.
function refreshLauncher(extensionDir, execPath) {
  const p = launcherPath();
  if (!isOurs(p)) return false;
  const text = launcherText(extensionDir, execPath);
  if (fs.readFileSync(p, 'utf8') === text) return false;
  fs.writeFileSync(p, text, { mode: 0o755 });
  return true;
}

// ---------- the note for agents ----------

const NOTE = `## Review

This paper is reviewed with Mâché. Run \`mache\` in the paper to see which comments are waiting
for you and what to do; \`mache help\` lists the commands. Edit the \`.tex\` files directly: your
edits become suggestions the author accepts or rejects. Never edit \`.review/\` by hand.
`;

// The instructions file agents read: AGENTS.md, or CLAUDE.md if that is the one the paper has.
function noteFile(root) {
  const agents = path.join(root, 'AGENTS.md');
  const claude = path.join(root, 'CLAUDE.md');
  return !fs.existsSync(agents) && fs.existsSync(claude) ? claude : agents;
}

function hasNote(root) {
  const f = noteFile(root);
  try { return /\bmache\b/i.test(fs.readFileSync(f, 'utf8')); } catch { return false; }
}

function addNote(root) {
  const f = noteFile(root);
  if (hasNote(root)) return { file: f, added: false };
  const before = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
  fs.writeFileSync(f, before ? `${before.replace(/\n*$/, '')}\n\n${NOTE}` : `# Notes for agents\n\n${NOTE}`);
  return { file: f, added: true };
}

// ---------- removed text in red ----------

const COLORS = { 'editorInlayHint.foreground': '#f14c4c', 'editorInlayHint.background': '#d73a4a30' };

// The colour settings with ours added, keeping every value already there; undefined if nothing
// would change.
function withColors(current) {
  const merged = { ...(current || {}) };
  let changed = false;
  for (const [k, v] of Object.entries(COLORS)) if (!(k in merged)) { merged[k] = v; changed = true; }
  return changed ? merged : undefined;
}

module.exports = { MARK, binDir, launcherPath, launcherText, commandOnPath, hasCommand, installLauncher, refreshLauncher,
  NOTE, noteFile, hasNote, addNote, COLORS, withColors };
