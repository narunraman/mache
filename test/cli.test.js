'use strict';
// The mache command, end to end in a temporary paper with its own git repository.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const CLI = path.join(__dirname, '..', 'cli.js');
const GIT = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com'];

function paper(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mache-paper-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'paper'));
  fs.writeFileSync(path.join(root, 'kagaz.toml'), '[project]\nname = "t"\n');
  fs.writeFileSync(path.join(root, 'paper', 'intro.tex'), '\\section{Intro}\n\nRoughly one in five documents fail to match.\n\nA second paragraph that stays as it is.\n');
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, ...GIT, 'add', '-A']);
  execFileSync('git', ['-C', root, ...GIT, 'commit', '-qm', 'init']);
  const env = { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' };
  const run = (...args) => {
    const r = spawnSync('node', [CLI, ...args], { cwd: path.join(root, 'paper'), encoding: 'utf8', env });
    if (r.status !== 0) throw new Error(`mache ${args.join(' ')} failed:\n${r.stderr}`);
    return r.stdout;
  };
  return { root, run, file: path.join(root, 'paper', 'intro.tex') };
}

test('a round: comment, edit, reply with the change, explain, status, commit', t => {
  const { root, run, file } = paper(t);
  assert.match(run('start'), /Reviewing paper\/intro.tex/);
  assert.ok(fs.existsSync(path.join(root, '.review', 'README.md')));
  assert.ok(fs.existsSync(path.join(root, '.review', 'paper', 'intro.tex')));

  // The author comments; it is waiting on the agent.
  assert.match(run('comment', 'intro.tex:3', '--quote', 'Roughly one in five', '--as', 'user', 'The exact number?'), /Started paper\/intro.tex#n1/);
  assert.match(run(), /1 comment waiting for a reply/);

  // The agent edits, answers with the edit, and makes an unasked edit with a reason.
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8')
    .replace('Roughly one in five', 'Twenty percent of')
    .replace('A second paragraph that stays as it is.', 'A second paragraph that the agent rewrote completely into something new.'));
  run('reply', 'n1', '--change', 'intro.tex:3', '20% is the value in the figure data.');
  run('explain', 'intro.tex:5', 'Clearer.');
  const out = run();
  assert.match(out, /No comments are waiting/);
  assert.match(out, /2 suggestions pending/);
  assert.match(run('comments'), /answered by the change at line 3/);

  const status = JSON.parse(run('status', '--json'));
  assert.equal(status[0].suggestions.length, 2);

  // Accept the first edit by hand (as the editor would) and commit: only accepted text is committed.
  const accepted = path.join(root, '.review', 'paper', 'intro.tex');
  fs.writeFileSync(accepted, fs.readFileSync(accepted, 'utf8').replace('Roughly one in five', 'Twenty percent of'));
  assert.match(run('summary'), /\S/);
  run('commit', '--no-edit');
  const committed = execFileSync('git', ['-C', root, 'show', 'HEAD:paper/intro.tex'], { encoding: 'utf8' });
  assert.match(committed, /Twenty percent of/);
  assert.match(committed, /stays as it is/, 'the pending rewrite is not committed');
  assert.match(fs.readFileSync(file, 'utf8'), /rewrote completely/, 'and stays in the working file');
});

test('replying as the author puts a thread back in the waiting list', t => {
  const { run } = paper(t);
  run('start');
  run('comment', 'intro.tex:3', 'Agent question: should this be a percentage?');
  assert.match(run(), /No comments are waiting/);
  run('reply', 'n1', '--as', 'user', 'yes');
  assert.match(run('comments', '--waiting'), /paper\/intro.tex#n1 .*WAITING/);
});

test('clear errors for a bad line or an unknown comment', t => {
  const { run } = paper(t);
  run('start');
  assert.throws(() => run('explain', 'intro.tex:3', 'why'), /no suggestion at paper\/intro.tex:3/);
  assert.throws(() => run('reply', 'n9', 'hello'), /no comment n9/);
});
