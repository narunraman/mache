'use strict';
// The comparison, comments and suggestion descriptions (no editor needed): node --test
const test = require('node:test');
const assert = require('node:assert/strict');
const { computeRegions, acceptChanges, workToBase } = require('../core/diff');
const notes = require('../core/notes');
const sg = require('../core/suggestions');

const para = n => `Paragraph ${n} talks about topic number ${n} at some length, with enough words that it reads like real prose in a paper.`;
const doc = (...ps) => ps.join('\n\n') + '\n';

test('an unchanged file has no suggestions', () => {
  assert.deepEqual(computeRegions(doc(para(1), para(2)), doc(para(1), para(2))), []);
});

test('a word change is one small edit, on its line', () => {
  const base = doc(para(1), 'We work within a dual-self model.', para(3));
  const work = doc(para(1), 'We build on a dual-self model.', para(3));
  const rv = sg.analyze(base, work);
  assert.equal(rv.regions.length, 1);
  const [r] = rv.regions;
  assert.equal(sg.describe(rv, r).kind, 'edit');
  assert.equal(sg.lineAt(work, sg.startOf(rv, r)), 3);
  assert.deepEqual(r.changes.map(c => [base.slice(c.baseStart, c.baseEnd), work.slice(c.workStart, c.workEnd)]), [['work within', 'build on']]);
});

test('changes are joined across spaces and punctuation, never across a word', () => {
  // Text typed between two edits must not be drawn as part of either (it is the author's).
  const base = 'Alpha beta gamma delta epsilon zeta eta theta.\n';
  const work = 'Alpha BETA gamma typed DELTA epsilon zeta eta theta.\n';
  const [r] = computeRegions(base, work);
  assert.ok(r.changes.every(c => !work.slice(c.workStart, c.workEnd).includes('gamma')));
  assert.ok(r.changes.length >= 2);
});

test('deletions, additions and rewrites are told apart', () => {
  const base = doc(para(1), para(2), para(3));
  const kinds = work => sg.analyze(base, work).regions.map(r => sg.describe(sg.analyze(base, work), r));
  assert.equal(kinds(doc(para(1), para(3)))[0].label, 'Deleted paragraph');
  assert.equal(kinds(doc(para(1), para(2), para(3), para(4)))[0].label, 'New paragraph');
  assert.equal(kinds(doc(para(1), 'Something else entirely, said in quite different words, about another matter altogether now.', para(3)))[0].kind, 'rewrite');
});

test('a moved paragraph is one move, with its wording changes against the original', () => {
  const base = doc(para(1), para(2), para(3), para(4));
  const moved = para(2).replace('at some length', 'at length');
  const work = doc(para(1), para(3), para(4), moved);
  const rv = sg.analyze(base, work);
  const to = rv.regions.find(r => r.move && r.move.role === 'to');
  const from = rv.regions.find(r => r.move && r.move.role === 'from');
  assert.ok(to && from && to.move.partner === from);
  assert.equal(sg.pending(rv).length, 1, 'a move counts once');
  assert.equal(sg.describe(rv, to).label, 'Moved and edited');
  assert.deepEqual(to.moveChanges.map(c => base.slice(c.baseStart, c.baseEnd)), ['some ']);
  // Accepting both ends gives the new text.
  assert.equal(acceptChanges(base, work, [...to.changes, ...from.changes]), work);
});

test('unrelated paragraphs are not mistaken for a move', () => {
  const base = doc(para(1), para(2), para(3));
  const work = doc(para(1), para(3), 'An entirely different paragraph that shares nothing with the deleted one, about birds and boats.');
  assert.ok(!sg.analyze(base, work).regions.some(r => r.move));
});

test('accepting all changes gives the working text; workToBase maps around them', () => {
  const base = 'one two three four five\n';
  const work = 'one TWO three four FIVE six\n';
  const regions = computeRegions(base, work);
  assert.equal(acceptChanges(base, work, regions.flatMap(r => r.changes)), work);
  const raw = regions.flatMap(r => r.raw);
  assert.equal(base.slice(workToBase(raw, work.indexOf('three'))).slice(0, 5), 'three');
});

test('a text comment follows its words through edits elsewhere', () => {
  const text = doc(para(1), 'The golden rendering is a claim.', para(3));
  const at = text.indexOf('golden rendering');
  const anchor = notes.textAnchor(text, at, at + 'golden rendering'.length);
  const edited = 'A new first line.\n\n' + text;
  const found = notes.locateText(edited, anchor);
  assert.equal(edited.slice(found.start, found.end), 'golden rendering');
  assert.equal(notes.locateText(edited.replace('golden rendering', 'reference'), anchor), null);
});

test('notes files: missing is empty, broken is null, flat agent anchors are tidied', t => {
  const fs = require('fs'), os = require('os'), path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mache-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual(notes.load(path.join(dir, 'none.json')), []);
  fs.writeFileSync(path.join(dir, 'bad.json'), '{"notes": [');
  assert.equal(notes.load(path.join(dir, 'bad.json')), null);
  fs.writeFileSync(path.join(dir, 'flat.json'), JSON.stringify({ notes: [{ id: 'a1', proposal: { old: 'x', new: 'y' }, offset: 3, messages: [] }] }));
  const [n] = notes.load(path.join(dir, 'flat.json'));
  assert.deepEqual(n.anchor, { proposal: { old: 'x', new: 'y' }, offset: 3 });
  assert.equal(n.status, 'open');
});

test('a comment is answered by the edit to its text, or by the edit a reply names', () => {
  const base = doc(para(1), 'Roughly one in five documents fail.', para(3));
  const work = doc(para(1), 'Twenty percent of documents fail.', para(3));
  const rv = sg.analyze(base, work);
  const q = 'Roughly one in five';
  const userNote = { id: 'n1', status: 'open', anchor: notes.textAnchor(base, base.indexOf(q), base.indexOf(q) + q.length), messages: [{ from: 'user', text: 'Exact number?' }] };
  assert.equal(sg.placeNotes(rv, [userNote])[0].answer, rv.regions[0], 'inferred');
  const elsewhere = { id: 'n2', status: 'open', anchor: notes.textAnchor(work, 0, 9), messages: [
    { from: 'user', text: 'And this?' },
    { from: 'agent', text: 'Done there.', change: notes.proposalAnchor(base, work, rv.regions[0]) }] };
  assert.equal(sg.placeNotes(rv, [elsewhere])[0].answer, rv.regions[0], 'named by the reply');
  const agentNote = { id: 'n3', status: 'open', anchor: notes.proposalAnchor(base, work, rv.regions[0]), messages: [{ from: 'agent', text: 'Why: precision.' }] };
  assert.equal(sg.whyOf(rv, rv.regions[0], [agentNote]), 'precision.');
});

// Distinct paragraphs, as in a real paper (nearly identical ones make pairing ambiguous).
const REAL = [
  'Timers interrupt a session at a fixed point, which lets a user reconsider whether to keep scrolling.',
  'Lockouts are stricter: once the limit passes, the app closes and stays closed until the next day.',
  'In the trial, roughly one in five users turned the timer off within a week.',
  'Our model treats each of these as a change in the chance that the user notices the time.',
  'The results suggest that predictable interruptions work better than random ones of the same strength.',
];
const labels = (base, work) => { const rv = sg.analyze(base, work); return sg.pending(rv).map(r => sg.describe(rv, r).label); };

test('a move next to an edited paragraph is still a move', () => {
  const base = doc(...REAL);
  const work = doc(REAL[0], REAL[2].replace('roughly one in five', '20% of'), REAL[3], REAL[4], REAL[1]);
  assert.deepEqual(labels(base, work), ['Edited', 'Moved']);
  const rv = sg.analyze(base, work);
  assert.equal(acceptChanges(base, work, rv.regions.flatMap(r => r.changes)), work);
});

test('an agent edit beside a move does not disturb it', () => {
  const base = doc(...REAL);
  const work = doc(REAL[0], REAL[2].replace('roughly one in five', '20% of'), REAL[3] + ' An added sentence.', REAL[4], REAL[1]);
  assert.deepEqual(labels(base, work), ['Edited', 'Added text', 'Moved']);
});

test('swapping two paragraphs is one move', () => {
  assert.deepEqual(labels(doc(...REAL), doc(REAL[1], REAL[0], ...REAL.slice(2))), ['Moved']);
});

test('changes that start at the same place are accepted in order', () => {
  // Several insertions and deletions next to each other: accepting all of them, or one at a
  // time, always ends at the working text.
  const base = doc(...REAL);
  const work = doc(REAL[0], 'A brand new opening for this part.', REAL[3], 'Another new paragraph here.', REAL[4], REAL[1]);
  const rv = sg.analyze(base, work);
  assert.equal(acceptChanges(base, work, rv.regions.flatMap(r => r.changes)), work);
  for (const r of rv.regions) {
    const once = acceptChanges(base, work, r.changes);
    const rest = sg.analyze(once, work);
    assert.equal(acceptChanges(once, work, rest.regions.flatMap(x => x.changes)), work);
  }
});
