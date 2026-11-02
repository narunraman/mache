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

// Stop reviewing files: their accepted copies and comment threads leave .review/ (the
// private history keeps both). The working files are untouched.
function stop(root, files) {
  const stopped = [];
  for (const f of files) {
    const p = paths(root, f);
    if (!fs.existsSync(p.basePath)) continue;
    fs.rmSync(p.basePath);
    fs.rmSync(p.notesPath, { force: true });
    stopped.push(p.rel);
  }
  return stopped;
}

// Folders that hold no part of the paper: hidden ones (.archive/), build output, old drafts.
const SKIP = name => name.startsWith('.') || ['build', 'node_modules', 'archive'].includes(name);
const skipped = rel => rel.split('/').slice(0, -1).some(SKIP);

// A main file and every .tex file it reads through \input, \include or \subfile.
function withInputs(root, rel, seen = new Set()) {
  const file = path.join(root, rel);
  if (seen.has(rel) || !fs.existsSync(file)) return seen;
  seen.add(rel);
  const text = fs.readFileSync(file, 'utf8').replace(/(^|[^\\])%.*$/gm, '$1');
  for (const m of text.matchAll(/\\(?:input|include|subfile)\s*\{([^}]+)\}/g)) {
    const name = m[1].trim().endsWith('.tex') ? m[1].trim() : `${m[1].trim()}.tex`;
    for (const base of [path.dirname(file), root]) {
      const r = path.relative(root, path.resolve(base, name)).split(path.sep).join('/');
      if (!r.startsWith('..') && fs.existsSync(path.join(root, r))) { withInputs(root, r, seen); break; }
    }
  }
  return seen;
}

// .tex files a review starts with by default: the paper's main files and what they input.
// The main files are kagaz.toml's, if there is one; else those with \begin{document} among the
// .tex files git tracks (or, outside git, all of them), leaving out hidden, build and archive
// folders. If none has \begin{document}, every .tex file that is left.
function candidates(root) {
  const toml = path.join(root, 'kagaz.toml');
  if (fs.existsSync(toml)) {
    const seen = new Set();
    for (const m of fs.readFileSync(toml, 'utf8').matchAll(/^\s*driver\s*=\s*"([^"]+)"/gm)) withInputs(root, m[1], seen);
    if (seen.size) return [...seen].filter(f => !skipped(f)).sort();
  }
  let files = [];
  try {
    const out = execFileSync('git', ['-C', root, 'ls-files', '--', '*.tex'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    files = out.split('\n').filter(Boolean);
  } catch { /* not a git repository */ }
  if (!files.length) {
    const walk = (dir, rel) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (SKIP(e.name)) continue;
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(path.join(dir, e.name), r);
        else if (e.name.endsWith('.tex')) files.push(r);
      }
    };
    walk(root, '');
  }
  files = files.filter(f => !skipped(f));
  const mains = files.filter(f => /^[^%\n]*\\begin\{document\}/m.test(fs.readFileSync(path.join(root, f), 'utf8')));
  if (!mains.length) return files.sort();
  const seen = new Set();
  for (const m of mains) withInputs(root, m, seen);
  return [...seen].filter(f => !skipped(f)).sort();
}

// A note in .review/ for whoever (or whatever) finds the folder.
function writeReadme(root) {
  const p = path.join(root, REVIEW, 'README.md');
  if (fs.existsSync(p)) return;
  fs.writeFileSync(p, `# Review state (mache)

This paper is reviewed with mache. Edits to the paper's .tex files show the author as
suggestions to accept or reject, and comments are threads stored here.

Run \`mache\` anywhere in the paper to see which comments are waiting for a reply and what is
pending; \`mache help\` lists the commands. Do not edit this folder by hand: it holds the
author's accepted text, the comment threads and a local history (history.git).
`);
}

// .review/ is local state (the accepted text, comments and history; \`mache commit\` commits
// the accepted text itself), so it is kept out of git. The entry added, if one was.
function ignoreReview(root) {
  const top = gitTop(root);
  if (!top) return undefined;
  const ignore = path.join(top, '.gitignore');
  const entry = path.relative(top, path.join(root, REVIEW)).split(path.sep).join('/') + '/';
  const lines = fs.existsSync(ignore) ? fs.readFileSync(ignore, 'utf8').split('\n') : [];
  if (lines.some(l => [entry, '/' + entry, '.review/', '.review'].includes(l.trim()))) return undefined;
  fs.writeFileSync(ignore, lines.join('\n').replace(/\n*$/, lines.length ? '\n' : '') + entry + '\n');
  return entry;
}

// Start reviewing a paper (the command line's \`mache start\` and the extension's command).
function startPaper(root, files) {
  const started = start(root, files);
  if (isDir(path.join(root, REVIEW))) writeReadme(root);
  return { started, ignored: started.length ? ignoreReview(root) : undefined };
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

module.exports = { REVIEW, reviewRoot, newRoot, gitTop, paths, locate, tracked, start, stop, startPaper, candidates, record, steps, markSquashed };
