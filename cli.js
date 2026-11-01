#!/usr/bin/env node
'use strict';
// mache: the command line for reviewing a LaTeX paper, for agents and authors. It uses the same
// core as the VS Code extension, so both always agree on the suggestions and comments.
// Run it with no command inside a paper to see what is waiting; `mache help` lists the rest.
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const project = require('./core/project');
const notes = require('./core/notes');
const sg = require('./core/suggestions');

const HELP = `mache — suggestions, comments and history for a LaTeX paper

  (no command)                   what is waiting: comments to answer, suggestions pending
  comments [--waiting] [--all]   comment threads, waiting ones first (--waiting: only those)
  reply <id> <text>              answer a comment; --change <file>:<line> names the edit that answers it
  comment <file>:<line> <text>   start a thread on that line (--quote "<text>" to anchor on exact words)
  explain <file>:<line> <text>   say why you made the suggestion at that line
  status                         every pending suggestion, per file
  start [files...]               start reviewing files (default: every .tex file in the paper)
  summary                        the commit message for everything since the last commit
  commit [--no-edit]             commit the accepted text with that message

A comment is waiting when its thread's last word is the author's. Edit the .tex files directly;
your changes become suggestions the author accepts or rejects. Never edit .review/ by hand.
Messages are from the agent unless --as user. Options: --json, --root <dir>.`;

function fail(msg) {
  process.stderr.write(`mache: ${msg}\n`);
  process.exit(1);
}

function parse(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json' || a === '--all' || a === '--no-edit' || a === '--waiting') opts[a.slice(2)] = true;
    else if (a === '--root' || a === '--as' || a === '--change' || a === '--quote') opts[a.slice(2)] = argv[++i];
    else if (a === '-h' || a === '--help') opts.help = true;
    else opts._.push(a);
  }
  return opts;
}

const read = p => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };

// Everything about one file under review.
function load(root, rel) {
  const p = project.paths(root, rel);
  const work = read(p.file);
  const base = read(p.basePath);
  if (work === null || base === null) return { ...p, missing: true };
  const list = notes.load(p.notesPath);
  if (list === null) fail(`${path.relative(process.cwd(), p.notesPath)} is not valid JSON`);
  const rv = sg.analyze(base, work);
  return { ...p, rv, notes: list };
}

function suggestions(f) {
  return sg.pending(f.rv).map(r => {
    const d = sg.describe(f.rv, r);
    return { line: sg.lineAt(f.rv.work, sg.startOf(f.rv, r)), endLine: sg.lineAt(f.rv.work, Math.max(r.workStart, r.workEnd - 1)),
      section: sg.sectionAt(f.rv, r.workStart), ...d, region: r };
  });
}

function comments(f, all) {
  return sg.placeNotes(f.rv, f.notes).filter(p => all || p.note.status !== 'resolved').map(p => {
    const offset = p.range ? p.range.start : p.region ? p.region.workStart : (p.note.anchor && p.note.anchor.offset) || 0;
    const on = p.region ? sg.describe(f.rv, p.region).label : null;
    const answer = p.answer ? `change at line ${sg.lineAt(f.rv.work, sg.startOf(f.rv, p.answer))}` : null;
    return { ref: `${f.rel}#${p.note.id}`, id: p.note.id, file: f.rel, line: sg.lineAt(f.rv.work, Math.min(offset, f.rv.work.length)),
      status: p.note.status, quote: p.note.anchor && (p.note.anchor.quote || (p.note.anchor.proposal && (p.note.anchor.proposal.new || p.note.anchor.proposal.old))),
      onSuggestion: p.answer ? null : on, answeredBy: answer, moved: !p.range && !(p.note.anchor && p.note.anchor.proposal), messages: p.note.messages,
      waiting: waiting(p.note) };
  });
}

// A thread waits on the agent when it is open and the author spoke last.
function waiting(note) {
  const last = note.messages && note.messages[note.messages.length - 1];
  return note.status !== 'resolved' && !!last && last.from === 'user';
}
const lastAt = c => { const m = c.messages[c.messages.length - 1]; return (m && m.at) || ''; };

function files(root) {
  return project.tracked(root).map(rel => load(root, rel));
}

// Change a file's notes starting from what is on disk now (the editor may have just written).
function editNotes(f, change) {
  const list = notes.load(f.notesPath);
  if (list === null) fail(`${f.notesPath} is not valid JSON`);
  const result = change(list);
  fs.mkdirSync(path.dirname(f.notesPath), { recursive: true });
  fs.writeFileSync(f.notesPath, notes.serialize(list));
  return result;
}

const short = (s, n = 90) => { s = (s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

// ---------- commands ----------

function status(root, opts) {
  const all = files(root);
  if (opts.json) {
    process.stdout.write(JSON.stringify(all.map(f => f.missing ? { file: f.rel, missing: true } : {
      file: f.rel, suggestions: suggestions(f).map(({ region, ...s }) => s), openComments: comments(f).length,
    }), null, 2) + '\n');
    return;
  }
  if (!all.length) { console.log('Nothing under review here. Start with: mache start'); return; }
  let total = 0, open = 0;
  for (const f of all) {
    if (f.missing) { console.log(`${f.rel}  (file missing)`); continue; }
    const s = suggestions(f), c = comments(f);
    total += s.length; open += c.length;
    if (!s.length && !c.length) continue; // nothing pending in this file
    console.log(`${f.rel}  ${sg.plural(s.length, 'suggestion')}, ${sg.plural(c.length, 'open comment')}`);
    for (const x of s) console.log(`  line ${x.line}${x.endLine !== x.line ? `–${x.endLine}` : ''}  ${x.label}${x.section ? ` (${x.section})` : ''}: ${x.summary}`);
  }
  console.log(`\n${sg.plural(total, 'suggestion')} and ${sg.plural(open, 'open comment')} in ${sg.plural(all.length, 'file')}.`);
}

// Waiting threads first, newest first; then the rest in file order.
function allComments(root, opts) {
  const out = files(root).filter(f => !f.missing).flatMap(f => comments(f, opts.all));
  const wait = out.filter(c => c.waiting).sort((a, b) => lastAt(b).localeCompare(lastAt(a)));
  return opts.waiting ? wait : [...wait, ...out.filter(c => !c.waiting)];
}

function printComment(c) {
  const where = c.answeredBy ? `  answered by the ${c.answeredBy}` : c.onSuggestion ? `  on a suggestion (${c.onSuggestion})` : '';
  console.log(`${c.ref}  line ${c.line}${c.waiting ? '  WAITING' : c.status === 'resolved' ? '  (resolved)' : ''}${where}`);
  if (c.quote) console.log(`  “${short(c.quote)}”${c.moved ? '  [this text has since changed]' : ''}`);
  for (const m of c.messages) console.log(`  ${m.from === 'agent' ? 'agent' : 'author'}: ${m.text}`);
  console.log('');
}

function listComments(root, opts) {
  const out = allComments(root, opts);
  if (opts.json) { process.stdout.write(JSON.stringify(out, null, 2) + '\n'); return; }
  if (!out.length) { console.log(opts.waiting ? 'Nothing is waiting for a reply.' : opts.all ? 'No comments.' : 'No open comments.'); return; }
  out.forEach(printComment);
}

// The front door: what is waiting, what is pending, and what to do about it.
function overview(root) {
  const fs_ = files(root).filter(f => !f.missing);
  const wait = allComments(root, { waiting: true });
  const pendingCount = fs_.reduce((n, f) => n + suggestions(f).length, 0);
  const open = fs_.reduce((n, f) => n + comments(f).length, 0);
  console.log(`Paper: ${path.relative(process.cwd(), root) || '.'} (${sg.plural(fs_.length, 'file')} under review)\n`);
  if (wait.length) {
    console.log(`${sg.plural(wait.length, 'comment')} waiting for a reply, newest first:\n`);
    wait.forEach(printComment);
  } else console.log('No comments are waiting for a reply.\n');
  console.log(`${sg.plural(pendingCount, 'suggestion')} pending, ${sg.plural(open, 'open comment')} in all.`);
  console.log(`\nNext: edit the .tex files (edits become suggestions), then \`mache reply <id> "…"\` (add --change <file>:<line> if an edit answers it).
More: \`mache help\`.`);
}

function findComment(root, ref) {
  const all = files(root).filter(f => !f.missing);
  const [file, id] = ref.includes('#') ? ref.split('#') : [null, ref];
  const hits = all.flatMap(f => (!file || f.rel === file || f.rel.endsWith('/' + file)) ? f.notes.filter(n => n.id === id).map(n => ({ f, n })) : []);
  if (!hits.length) fail(`no comment ${ref}`);
  if (hits.length > 1) fail(`${ref} is ambiguous; use file#id (${hits.map(h => `${h.f.rel}#${id}`).join(', ')})`);
  return hits[0];
}

async function reply(root, opts) {
  const [ref, ...words] = opts._;
  const text = words.join(' ').trim();
  if (!ref || !text) fail('usage: review reply <file#id | id> <text>');
  const from = opts.as === 'user' ? 'user' : 'agent';
  const { f, n } = findComment(root, ref);
  const message = { from, text, at: new Date().toISOString() };
  let changed;
  if (opts.change) {
    const { f: cf, s } = suggestionAt(root, opts.change);
    if (cf.rel !== f.rel) fail(`the change must be in ${f.rel}, the file the comment is on`);
    message.change = notes.proposalAnchor(cf.rv.base, cf.rv.work, s.region);
    changed = `${s.label.toLowerCase()} at line ${s.line}`;
  }
  editNotes(f, list => list.find(x => x.id === n.id).messages.push(message));
  await project.record(root, `${from === 'agent' ? 'agent' : 'author'}: reply on ${f.rel}#${n.id}`,
    { Action: 'reply', From: from, File: f.rel, Comment: short(n.messages[0] && n.messages[0].text, 200), Text: text });
  console.log(`Replied on ${f.rel}#${n.id}${changed ? `, answered by the ${changed}` : ''}.`);
}

// The suggestion at <file>:<line>, as { f, s }.
function suggestionAt(root, where) {
  const m = where && where.match(/^(.*):(\d+)$/);
  if (!m) fail(`expected <file>:<line>, got "${where}"`);
  const rel = project.paths(root, path.resolve(process.cwd(), m[1])).rel;
  if (!project.tracked(root).includes(rel)) fail(`${m[1]} is not under review`);
  const f = load(root, rel);
  const line = Number(m[2]);
  const s = suggestions(f).find(x => x.line <= line && line <= x.endLine);
  if (!s) fail(`no suggestion at ${rel}:${line} (see: mache status)`);
  return { f, s };
}

async function comment(root, opts) {
  const [where, ...words] = opts._;
  const text = words.join(' ').trim();
  const m = where && where.match(/^(.*):(\d+)$/);
  if (!m || !text) fail('usage: mache comment <file>:<line> <text> [--quote "<exact words>"]');
  const rel = project.paths(root, path.resolve(process.cwd(), m[1])).rel;
  if (!project.tracked(root).includes(rel)) fail(`${m[1]} is not under review`);
  const f = load(root, rel);
  const lines = f.rv.work.split('\n');
  const n = Number(m[2]);
  if (n < 1 || n > lines.length) fail(`${rel} has no line ${n}`);
  const lineStart = lines.slice(0, n - 1).reduce((s, l) => s + l.length + 1, 0);
  const line = lines[n - 1];
  let start, end;
  if (opts.quote) {
    const i = line.indexOf(opts.quote);
    if (i < 0) fail(`"${opts.quote}" is not on ${rel}:${n}`);
    start = lineStart + i; end = start + opts.quote.length;
  } else {
    // Without --quote, the comment sits on the line's first few words.
    const first = line.match(/^\s*(\S+(?:\s+\S+){0,5})/);
    if (!first) fail(`${rel}:${n} is blank`);
    start = lineStart + line.indexOf(first[1]); end = start + first[1].length;
  }
  const from = opts.as === 'user' ? 'user' : 'agent';
  const anchor = notes.textAnchor(f.rv.work, start, end);
  const id = editNotes(f, list => {
    const note = { id: notes.nextId(list), status: 'open', anchor, messages: [{ from, text, at: new Date().toISOString() }] };
    list.push(note);
    return note.id;
  });
  await project.record(root, `${from === 'agent' ? 'agent' : 'author'}: commented on ${rel}:${n}`, { Action: 'comment', From: from, File: rel, Quote: anchor.quote, Text: text });
  console.log(`Started ${rel}#${id} on line ${n} (“${short(anchor.quote, 60)}”).`);
}

async function explain(root, opts) {
  const [where, ...words] = opts._;
  const text = words.join(' ').trim();
  if (!where || !text) fail('usage: review explain <file>:<line> <text>');
  const { f, s } = suggestionAt(root, where);
  const rel = f.rel;
  const anchor = notes.proposalAnchor(f.rv.base, f.rv.work, s.region);
  const id = editNotes(f, list => {
    const note = { id: notes.nextId(list), status: 'open', anchor, messages: [{ from: 'agent', text, at: new Date().toISOString() }] };
    list.push(note);
    return note.id;
  });
  await project.record(root, `agent: explained ${s.label.toLowerCase()} at ${rel}:${s.line}`,
    { Action: 'explain', File: rel, Section: s.section, Label: s.label, Why: text });
  console.log(`Added ${rel}#${id} to the suggestion at line ${s.line} (${s.label}).`);
}

async function start(root, opts) {
  const list = opts._.length ? opts._.map(f => path.resolve(process.cwd(), f)) : project.candidates(root).map(f => path.join(root, f));
  const started = project.start(root, list);
  writeReadme(root);
  if (!started.length) { console.log('Nothing new to start; those files are already under review.'); return; }
  await project.record(root, `author: started reviewing ${sg.plural(started.length, 'file')}`, { Action: 'start', Files: started.join(', ') });
  console.log(`Reviewing ${started.join(', ')}.\nAccepted copies are in ${path.relative(process.cwd(), path.join(root, project.REVIEW)) || project.REVIEW}/.`);
  // .review/ is local state (the accepted text, comments and history): keep it out of the repo.
  try {
    execFileSync('git', ['-C', root, 'check-ignore', '-q', project.REVIEW], { stdio: 'ignore' });
  } catch (e) {
    if (e.status === 1) console.log(`Tip: add "${project.REVIEW}/" to .gitignore; it is local review state, and \`review commit\` commits the accepted text itself.`);
  }
}

// A note in .review/ for whoever (or whatever) finds the folder.
function writeReadme(root) {
  const p = path.join(root, project.REVIEW, 'README.md');
  if (fs.existsSync(p)) return;
  fs.writeFileSync(p, `# Review state (mache)

This paper is reviewed with mache. Edits to the paper's .tex files show the author as
suggestions to accept or reject, and comments are threads stored here.

Run \`mache\` anywhere in the paper to see which comments are waiting for a reply and what is
pending; \`mache help\` lists the commands. Do not edit this folder by hand: it holds the
author's accepted text, the comment threads and a local history (history.git).
`);
}

// A commit message from the steps since the last commit.
async function draft(root) {
  const steps = await project.steps(root);
  const where = s => s.fields.section || path.basename(s.fields.file || '', '.tex');
  const accepted = steps.filter(s => s.fields.action === 'accept');
  const rejected = steps.filter(s => s.fields.action === 'reject');
  const discussed = steps.filter(s => s.fields.action === 'resolve' && s.fields.comment);
  const own = [...new Set(steps.filter(s => s.fields.action === 'own-edit').map(s => s.fields.file))];
  const places = [...new Set(accepted.map(where).filter(Boolean))];
  const counts = [accepted.length && `${accepted.length} accepted`, rejected.length && `${rejected.length} rejected`].filter(Boolean).join(', ');
  const title = accepted.length
    ? `Revise ${places.slice(0, 3).join(', ')}${places.length > 3 ? ' and more' : ''}${counts ? `: ${counts}` : ''}`
    : rejected.length ? `Review round: ${counts}` : own.length ? `Edit ${own.map(f => path.basename(f, '.tex')).join(', ')}` : 'Edit the paper';
  const lines = [title, ''];
  for (const s of accepted) lines.push(`- ${where(s)}: ${s.fields.why || `${(s.fields.label || 'edit').toLowerCase()} (${s.fields.summary || ''})`}`);
  if (rejected.length) {
    lines.push('', 'Rejected:');
    for (const s of rejected) lines.push(`- ${where(s)}: ${s.fields.why || (s.fields.label || 'suggestion').toLowerCase()}`);
  }
  if (own.length) lines.push('', `Also edited directly: ${own.join(', ')}.`);
  if (discussed.length) {
    lines.push('', 'Discussed:');
    for (const s of discussed) lines.push(`- ${where(s)}: ${s.fields.comment}`);
  }
  return { message: lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n', steps };
}

async function summary(root) {
  const { message, steps } = await draft(root);
  if (!steps.length) { console.log('No steps since the last commit.'); return; }
  process.stdout.write(message);
}

// Commit the accepted text of every file under review to the paper's own repository,
// leaving pending suggestions in the working files (and out of history).
async function commit(root, opts) {
  const top = project.gitTop(root);
  if (!top) fail('this paper is not in a git repository');
  const g = (args, input) => execFileSync('git', ['-C', top, ...args], { encoding: 'utf8', input, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
  let staged = 0;
  for (const rel of project.tracked(root)) {
    const p = project.paths(root, rel);
    const repoPath = path.relative(top, p.file).split(path.sep).join('/');
    const blob = g(['hash-object', '-w', '--stdin'], fs.readFileSync(p.basePath)).trim();
    g(['update-index', '--add', '--cacheinfo', `100644,${blob},${repoPath}`]);
    staged++;
  }
  try { g(['diff', '--cached', '--quiet']); console.log('Nothing to commit: the accepted text matches the last commit.'); return; } catch { /* there are changes */ }
  const { message } = await draft(root);
  const msgFile = path.join(root, project.REVIEW, 'COMMIT_MSG');
  fs.writeFileSync(msgFile, message);
  const edit = !opts['no-edit'] && process.stdin.isTTY && process.stdout.isTTY;
  const res = spawnSync('git', ['-C', top, 'commit', ...(edit ? ['-e'] : []), '-F', msgFile], { stdio: 'inherit' });
  if (res.status !== 0) fail('git commit did not complete; nothing was marked as committed');
  await project.record(root, 'author: committed the accepted text', { Action: 'commit' });
  await project.markSquashed(root);
  console.log(`Committed the accepted text of ${sg.plural(staged, 'file')}. Pending suggestions stay in the working files.`);
}

async function main() {
  const opts = parse(process.argv.slice(2));
  const cmd = opts._.shift();
  if (opts.help || cmd === 'help') { console.log(HELP); return; }
  const here = opts.root ? path.resolve(opts.root) : process.cwd();
  const root = cmd === 'start' ? project.newRoot(opts._[0] ? path.resolve(here, opts._[0]) : here) : project.reviewRoot(here);
  if (!root) {
    if (!cmd) { console.log(`Not inside a paper under review (no .review/ folder here or above).\nStart with: mache start\n\n${HELP}`); return; }
    fail('no .review/ folder here or above; start with: mache start');
  }
  if (!cmd) { overview(root); return; }
  const commands = { status, comments: listComments, reply, comment, explain, start, summary, commit };
  if (!commands[cmd]) fail(`unknown command "${cmd}"\n\n${HELP}`);
  await commands[cmd](root, opts);
}

main().catch(e => fail(e.message));
