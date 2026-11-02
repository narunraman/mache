'use strict';
// Where a paper's review state lives, and its local history.
//
// A project has one .review/ folder at its root. For a file <root>/a/b.tex:
//   <root>/.review/a/b.tex           the accepted text
//   <root>/.review/a/b.notes.json    its comment threads
//   <root>/.review/history.git       a private git history of every step (never pushed)
// The root is the nearest folder above a file that has a .review/ folder; when starting a
// review, the nearest one with kagaz.toml, else the git repository's top, else the
// file's own folder. (So a .review/ next to a file, as older papers have, still works.)
const fs = require('fs');
const path = require('path');
const { execFile, execFileSync } = require('child_process');

const REVIEW = '.review';
const HISTORY = 'history.git';
const SQUASHED = 'squashed'; // tag on the step last folded into a real commit

function ancestors(dir) {
  const out = [];
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    out.push(d);
    if (path.dirname(d) === d) return out;
  }
}

const isDir = p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

// The root of an existing review, or undefined.
function reviewRoot(start) {
  const dir = isDir(start) ? start : path.dirname(start);
  return ancestors(dir).find(d => isDir(path.join(d, REVIEW)));
}

// Where a new review should be rooted.
function newRoot(start) {
  const dir = isDir(start) ? start : path.dirname(start);
  const existing = reviewRoot(dir);
  if (existing) return existing;
  const toml = ancestors(dir).find(d => fs.existsSync(path.join(d, 'kagaz.toml')));
  if (toml) return toml;
  const top = gitTop(dir);
  return top || dir;
}

function gitTop(dir) {
  try {
    return execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return undefined;
  }
}

// Paths for one file in a project.
function paths(root, file) {
  // A relative path is relative to the root (as tracked() returns them), not the current folder.
  const rel = path.relative(root, path.resolve(root, file)).split(path.sep).join('/');
  const basePath = path.join(root, REVIEW, rel);
  return { root, rel, file: path.join(root, rel), basePath, notesPath: basePath.replace(/\.tex$/, '') + '.notes.json' };
}

// The review paths for a file if it is under review, else undefined.
function locate(file) {
  const root = reviewRoot(file);
  if (!root) return undefined;
  const p = paths(root, file);
  return fs.existsSync(p.basePath) ? p : undefined;
}

// Every file under review in a project (relative paths).
function tracked(root) {
  const out = [];
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) { if (e.name !== HISTORY) walk(path.join(dir, e.name), rel ? `${rel}/${e.name}` : e.name); }
      else if (e.name.endsWith('.tex')) out.push(rel ? `${rel}/${e.name}` : e.name);
    }
  };
  const top = path.join(root, REVIEW);
  if (isDir(top)) walk(top, '');
  return out.sort();
}

// Start reviewing files: their current text becomes the accepted text.
function start(root, files) {
  const started = [];
  for (const f of files) {
    const p = paths(root, f);
    if (fs.existsSync(p.basePath) || !fs.existsSync(p.file)) continue;
    fs.mkdirSync(path.dirname(p.basePath), { recursive: true });
    fs.copyFileSync(p.file, p.basePath);
    started.push(p.rel);
  }
  return started;
}

// .tex files a review would start with by default: those git tracks under the root, or
// else every .tex file outside build/, .review/ and hidden folders.
function candidates(root) {
  try {
    const out = execFileSync('git', ['-C', root, 'ls-files', '--', '*.tex'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const files = out.split('\n').filter(Boolean);
    if (files.length) return files;
  } catch { /* not a git repository */ }
  const found = [];
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.') || e.name === 'build' || e.name === 'node_modules') continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), r);
      else if (e.name.endsWith('.tex')) found.push(r);
    }
  };
  walk(root, '');
  return found.sort();
}

// ---------- local history ----------
//
// A private git repository whose work tree is the project root, holding only .review/ and
// the files under review. Each step (an agent's edit, an accept, a reject, a comment) is a
// commit whose message ends in "Key: value" lines that summaries are built from.

function historyEnv(root) {
  return { ...process.env, GIT_DIR: path.join(root, REVIEW, HISTORY), GIT_WORK_TREE: root };
}

function git(root, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { env: historyEnv(root), cwd: root, encoding: 'utf8', maxBuffer: 64 << 20, ...opts },
      (err, stdout, stderr) => (err && !opts.allowFail ? reject(new Error(stderr || err.message)) : resolve({ ok: !err, stdout })));
  });
}

async function ensureHistory(root) {
  const dir = path.join(root, REVIEW, HISTORY);
  if (isDir(dir)) return;
  await git(root, ['init', '-q']);
  fs.writeFileSync(path.join(dir, 'info', 'exclude'), `${REVIEW}/${HISTORY}/\n`);
  // Use the person's own git identity; fall back to a neutral one so steps always record.
  const name = await git(root, ['config', 'user.name'], { allowFail: true });
  if (!name.stdout.trim()) {
    await git(root, ['config', 'user.name', 'Review history']);
    await git(root, ['config', 'user.email', 'review@localhost']);
  }
}

// Steps are recorded one at a time, in order, so two never race for git's index.
let queue = Promise.resolve();

// Record a step: snapshot .review/ and the files under review, with a message whose first
// line is for people and whose fields (an object) become "Key: value" lines.
function record(root, title, fields = {}) {
  const step = async () => {
    await ensureHistory(root);
    const files = tracked(root).filter(rel => fs.existsSync(path.join(root, rel)));
    // -f: the paper's own .gitignore excludes .review/, which this history must still record.
    // (but never its own storage, which -f would otherwise take too).
    await git(root, ['add', '-A', '-f', '--', REVIEW, ...files, `:(exclude)${REVIEW}/${HISTORY}`]);
    const body = Object.entries(fields).filter(([, v]) => v !== undefined && v !== '')
      .map(([k, v]) => `${k}: ${String(v).replace(/\s*\n\s*/g, ' ')}`).join('\n');
    await git(root, ['commit', '-q', '--allow-empty', '-m', body ? `${title}\n\n${body}` : title]);
  };
  queue = queue.then(step, step);
  return queue;
}

// The steps since the last real commit: [{ title, fields, at }], oldest first.
async function steps(root, { all = false } = {}) {
  if (!isDir(path.join(root, REVIEW, HISTORY))) return [];
  const since = all ? null : (await git(root, ['rev-parse', '-q', '--verify', `refs/tags/${SQUASHED}`], { allowFail: true })).stdout.trim();
  const range = since ? [`${since}..HEAD`] : ['HEAD'];
  const out = await git(root, ['log', '--reverse', '--format=%aI%x1f%B%x1e', ...range], { allowFail: true });
  return out.stdout.split('\x1e').map(s => s.trim()).filter(Boolean).map(s => {
    const [at, msg] = s.split('\x1f');
    const [title, ...rest] = msg.trim().split('\n');
    const fields = {};
    for (const line of rest) {
      const m = line.match(/^([A-Za-z-]+): (.*)$/);
      if (m) fields[m[1].toLowerCase()] = m[2];
    }
    return { title, fields, at };
  });
}

async function markSquashed(root) {
  await git(root, ['tag', '-f', SQUASHED, 'HEAD']);
}

module.exports = { REVIEW, reviewRoot, newRoot, gitTop, paths, locate, tracked, start, candidates, record, steps, markSquashed };
