'use strict';
// The extension's behaviour in the editor. Loaded by VS Code (see run.js); writes its results
// to $MACHE_TEST_RESULT. Each test starts from the same paper: accepted text BASE, file WORK.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const { computeRegions } = require('../../core/diff');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const PARAS = [
  'Timers interrupt a session at a fixed point, which lets a user reconsider whether to keep scrolling.',
  'Lockouts are stricter: once the limit passes, the app closes and stays closed until the next day.',
  'Friction adds a small cost to each continuation, such as a delay or a confirmation prompt.',
  'Our model treats each of these as a change in the chance that the user notices the time.',
  'The results suggest that predictable interruptions work better than random ones of the same strength.',
];
const P = n => PARAS[n - 1];
const BASE = [P(1), P(2), 'In the trial, roughly one in five users turned the timer off within a week.', P(4), P(5)].join('\n\n') + '\n';
const WORK = [P(1), 'In the trial, 20% of users turned the timer off within a week.', P(4), P(5), P(2)].join('\n\n') + '\n';
//   suggestions: an edit ("roughly one in five" → "20%") and a move (paragraph 2 to the end)

const dir = process.env.MACHE_TEST_PAPER;
const file = path.join(dir, 'paper.tex');
const baseFile = path.join(dir, '.review', 'paper.tex');
const notesFile = path.join(dir, '.review', 'paper.notes.json');
const api = () => vscode.extensions.getExtension('narunraman.mache').exports;
const base = () => fs.readFileSync(baseFile, 'utf8');
const regions = doc => computeRegions(base(), doc.getText()).filter(r => !(r.move && r.move.role === 'from'));

async function fresh(notes = []) {
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  fs.mkdirSync(path.dirname(baseFile), { recursive: true });
  fs.writeFileSync(baseFile, BASE);
  fs.writeFileSync(file, WORK);
  fs.writeFileSync(notesFile, JSON.stringify({ notes }));
  await sleep(400);
  const doc = await vscode.workspace.openTextDocument(file);
  const ed = await vscode.window.showTextDocument(doc);
  await sleep(1200);
  return { doc, ed };
}
async function type(ed, offset, text, len = 0) {
  const d = ed.document;
  await ed.edit(e => e.replace(new vscode.Range(d.positionAt(offset), d.positionAt(offset + len)), text));
  await sleep(250);
  await d.save();
  await sleep(400);
}

const tests = {
  async 'typing away from suggestions is a normal edit'() {
    const { doc, ed } = await fresh();
    await type(ed, 0, 'Hello. ');
    assert.ok(base().startsWith('Hello. '));
    assert.equal(regions(doc).length, 2);
  },
  async 'typing right after an edit does not join it'() {
    const { doc, ed } = await fresh();
    const at = doc.getText().indexOf(' of users');
    await type(ed, at, ' typed');
    assert.ok(base().includes('typed'), 'the typed word went into the accepted text');
    assert.equal(regions(doc).length, 2);
  },
  async 'typing inside a suggestion edits the suggestion'() {
    const { ed } = await fresh();
    const before = base();
    await type(ed, ed.document.getText().indexOf('20%') + 1, '5');
    assert.equal(base(), before);
  },
  async 'Accept and Reject'() {
    const { doc } = await fresh();
    const edit = api().panelState().cards.find(c => c.kind === 'edit');
    await api().panelMessage({ cmd: 'accept', arg: edit.arg });
    await sleep(500);
    assert.ok(base().includes('20% of users'));
    const move = api().panelState().cards.find(c => c.kind === 'move');
    await api().panelMessage({ cmd: 'undo', arg: move.arg });
    await sleep(500);
    await doc.save();
    const left = computeRegions(base(), doc.getText());
    assert.equal(left.length, 0, 'rejecting the move put paragraph 2 back; left: ' + JSON.stringify(left.map(r => [base().slice(r.baseStart, r.baseEnd).slice(0, 40), doc.getText().slice(r.workStart, r.workEnd).slice(0, 40)])) + ' DOC=' + JSON.stringify(doc.getText().replace(/Paragraph (\d)[^\n]*/g, 'P$1')) + ' BASE=' + JSON.stringify(base().replace(/Paragraph (\d)[^\n]*/g, 'P$1')));
    assert.equal(doc.getText().indexOf(P(2)) < doc.getText().indexOf(P(4)), true);
  },
  async 'review mode turns your typing into suggestions'() {
    const { doc, ed } = await fresh();
    await vscode.commands.executeCommand('mache.toggleReviewMode');
    try {
      await type(ed, 0, 'Suggested. ');
      assert.ok(!base().startsWith('Suggested.'));
      assert.equal(regions(doc).length, 3);
    } finally {
      await vscode.commands.executeCommand('mache.toggleReviewMode');
    }
  },
  async 'a change written to disk by an agent is a suggestion'() {
    const { doc } = await fresh();
    fs.writeFileSync(file, doc.getText().replace(P(4), P(4) + ' An added sentence.'));
    await sleep(2000);
    assert.equal(regions(doc).length, 3, 'got ' + regions(doc).length + ' DOC has added: ' + doc.getText().includes('An added sentence') + ' BASE has: ' + base().includes('An added sentence'));
    assert.ok(!base().includes('An added sentence'));
  },
  async 'a reply the agent just wrote survives your reply'() {
    const at = BASE.indexOf('roughly');
    const anchor = { quote: 'roughly', prefix: BASE.slice(at - 20, at), suffix: BASE.slice(at + 7, at + 27), offset: at };
    await fresh([{ id: 'n1', status: 'open', anchor, messages: [{ from: 'user', text: 'Number?' }] }]);
    const n = JSON.parse(fs.readFileSync(notesFile, 'utf8'));
    n.notes[0].messages.push({ from: 'agent', text: 'AGENT' });
    fs.writeFileSync(notesFile, JSON.stringify(n));
    await api().panelMessage({ cmd: 'reply', id: 'n1', text: 'USER' });
    const texts = JSON.parse(fs.readFileSync(notesFile, 'utf8')).notes[0].messages.map(m => m.text);
    assert.deepEqual(texts.slice(-2), ['AGENT', 'USER']);
  },
  async 'you can edit your own messages, not the agent\'s'() {
    const at = BASE.indexOf('roughly');
    const anchor = { quote: 'roughly', prefix: BASE.slice(at - 20, at), suffix: BASE.slice(at + 7, at + 27), offset: at };
    await fresh([{ id: 'n1', status: 'open', anchor, messages: [{ from: 'user', text: 'Number?', at: '2026-01-01T00:00:00Z' }, { from: 'agent', text: 'About 20%.' }] }]);
    await api().panelMessage({ cmd: 'edit', id: 'n1', index: 0, text: 'The exact number?' });
    await api().panelMessage({ cmd: 'edit', id: 'n1', index: 1, text: 'HIJACKED' });
    const msgs = JSON.parse(fs.readFileSync(notesFile, 'utf8')).notes[0].messages;
    assert.deepEqual(msgs.map(m => [m.from, m.text]), [['user', 'The exact number?'], ['agent', 'About 20%.']], 'the agent still has the last word');
    assert.ok(!isNaN(Date.parse(msgs[0].edited)), 'the edit is timestamped');
    assert.equal(msgs[0].at, '2026-01-01T00:00:00Z', 'the message keeps its time');
    assert.equal(msgs[1].edited, undefined);
    const shown = api().panelState().cards.flatMap(c => c.notes).find(n => n.id === 'n1').messages[0];
    assert.equal(shown.text, 'The exact number?');
    assert.ok(shown.edited, 'the panel gets the edited time to show "(edited)"');
  },
  async 'Accept keeps the comment open; Accept & resolve closes it'() {
    const at = BASE.indexOf('roughly');
    const anchor = { quote: 'roughly', prefix: BASE.slice(at - 20, at), suffix: BASE.slice(at + 7, at + 27), offset: at };
    const thread = () => [{ id: 'n1', status: 'open', anchor, messages: [{ from: 'user', text: 'Number?' }, { from: 'agent', text: 'Done.' }] }];
    await fresh(thread());
    let card = api().panelState().cards.find(c => c.change);
    assert.ok(card, 'the edit shows inside the comment');
    await api().panelMessage({ cmd: 'accept', arg: card.change.arg });
    await sleep(400);
    assert.equal(JSON.parse(fs.readFileSync(notesFile, 'utf8')).notes[0].status, 'open');
    await fresh(thread());
    card = api().panelState().cards.find(c => c.change);
    await api().panelMessage({ cmd: 'accept', arg: { ...card.change.arg, resolve: true } });
    await sleep(400);
    assert.equal(JSON.parse(fs.readFileSync(notesFile, 'utf8')).notes[0].status, 'resolved');
  },
  async 'a paper not under review can be started from the editor'() {
    const other = fs.mkdtempSync(path.join(require('os').tmpdir(), 'mache-start-'));
    fs.writeFileSync(path.join(other, 'main.tex'), '\\documentclass{article}\n\\begin{document}\n\\input{intro}\n\\end{document}\n');
    fs.writeFileSync(path.join(other, 'intro.tex'), P(1) + '\n');
    fs.writeFileSync(path.join(other, 'notes.tex'), 'Not part of the paper.\n');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(path.join(other, 'intro.tex')));
    await sleep(800);
    await vscode.commands.executeCommand('mache.startPaper');
    await sleep(800);
    assert.deepEqual(fs.readdirSync(path.join(other, '.review')).filter(f => f.endsWith('.tex')).sort(), ['intro.tex', 'main.tex']);
    fs.rmSync(other, { recursive: true, force: true });
  },
};

exports.run = async function () {
  const results = [];
  for (const [name, fn] of Object.entries(tests)) {
    try { await fn(); results.push({ name, ok: true }); }
    catch (e) { results.push({ name, ok: false, error: String(e && e.message || e).split('\n')[0] }); }
  }
  fs.writeFileSync(process.env.MACHE_TEST_RESULT, JSON.stringify(results));
};
