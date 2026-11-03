'use strict';
// What "Finish setting up" writes: the mache launcher, the note for agents, the colours.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const tmp = t => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mache-setup-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };

test('the launcher runs the shipped cli.js, follows updates, and leaves other programs alone', t => {
  const bin = tmp(t);
  process.env.MACHE_BIN_DIR = bin;
  const setup = require('../core/setup');
  const ext = path.join(__dirname, '..');
  assert.equal(setup.hasCommand(), false);
  const r = setup.installLauncher(ext, process.execPath);
  assert.ok(r.ok && setup.hasCommand());
  const out = spawnSync('sh', [r.path, 'help'], { encoding: 'utf8' }).stdout;
  assert.match(out, /mache — suggestions, comments and history/);
  // Without node on the PATH, it runs with the Node that VS Code itself runs on.
  const bare = spawnSync('/bin/sh', [r.path, 'help'], { encoding: 'utf8', env: { PATH: '/nonexistent' } }).stdout;
  assert.match(bare, /mache — suggestions/);
  assert.equal(setup.refreshLauncher(ext, process.execPath), false, 'unchanged');
  assert.equal(setup.refreshLauncher('/elsewhere/mache-0.2.0', process.execPath), true, 'a new copy of the extension');
  assert.match(fs.readFileSync(r.path, 'utf8'), /\/elsewhere\/mache-0\.2\.0\/cli\.js/);
  fs.writeFileSync(r.path, '#!/bin/sh\necho someone else\n');
  assert.equal(setup.installLauncher(ext, process.execPath).ok, false, 'not ours: left alone');
  assert.equal(setup.refreshLauncher(ext, process.execPath), false);
  delete process.env.MACHE_BIN_DIR;
});

test('the note goes in AGENTS.md, or CLAUDE.md if that is what the paper has, once', t => {
  const setup = require('../core/setup');
  const a = tmp(t);
  assert.equal(path.basename(setup.addNote(a).file), 'AGENTS.md');
  assert.equal(setup.addNote(a).added, false, 'once');
  const c = tmp(t);
  fs.writeFileSync(path.join(c, 'CLAUDE.md'), '# House rules\n\nUse uv.\n');
  const r = setup.addNote(c);
  assert.equal(path.basename(r.file), 'CLAUDE.md');
  assert.match(fs.readFileSync(r.file, 'utf8'), /^# House rules\n\nUse uv\.\n\n## Review\n/);
});

test('colours are added without touching the ones already set', () => {
  const { withColors } = require('../core/setup');
  assert.deepEqual(withColors({ 'editor.background': '#000' }),
    { 'editor.background': '#000', 'editorInlayHint.foreground': '#f14c4c', 'editorInlayHint.background': '#d73a4a30' });
  assert.equal(withColors({ 'editorInlayHint.foreground': '#fff', 'editorInlayHint.background': '#000' }), undefined);
});
