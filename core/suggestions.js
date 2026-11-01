'use strict';
// What the suggestions in a file are, independent of any editor: the extension and the
// command line both describe them with these functions, so they always agree.
//
// A "review" is { base, work, regions }: the accepted text, the current text, and the
// regions computeRegions found between them. Comments are placed with placeNotes.
const { computeRegions } = require('./diff');
const notes = require('./notes');

const INLINE_MAX = 80; // removed text longer than this (or spanning lines) makes a paragraph a rewrite
const isShort = s => s.length <= INLINE_MAX && !s.includes('\n');
const removedText = (rv, c) => rv.base.slice(c.baseStart, c.baseEnd);
const isRewrite = (rv, r) => r.heavy || r.changes.some(c => {
  const old = removedText(rv, c).replace(/\n+$/, '');
  return old.trim() && !isShort(old);
});

const wordCount = s => (s.match(/\S+/g) || []).length;
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

function analyze(base, work) {
  return { base, work, regions: computeRegions(base, work) };
}

// What a suggestion does, from its exact changes: { kind, label, summary }.
function describe(rv, r) {
  if (r.move) {
    const other = lineAt(rv.work, startOf(rv, r.move.partner));
    if (r.move.role === 'from') return { kind: 'moved', label: 'Moved away', summary: `moved to line ${other}` };
    const edited = r.moveChanges && r.moveChanges.length;
    return { kind: 'move', label: edited ? 'Moved and edited' : 'Moved', summary: `from line ${other}` };
  }
  const removed = wordCount(r.raw.map(c => rv.base.slice(c.baseStart, c.baseEnd)).join(' '));
  const added = wordCount(r.raw.map(c => rv.work.slice(c.workStart, c.workEnd)).join(' '));
  const oldEmpty = !rv.base.slice(r.baseStart, r.baseEnd).trim();
  const newEmpty = !rv.work.slice(r.workStart, r.workEnd).trim();
  if (!added && removed) {
    const many = /\n\s*\n/.test(rv.base.slice(r.baseStart, r.baseEnd).trim());
    return { kind: 'deletion', label: newEmpty ? (many ? 'Deleted paragraphs' : 'Deleted paragraph') : 'Deleted text', summary: `${plural(removed, 'word')} removed` };
  }
  if (added && !removed) {
    const many = /\n\s*\n/.test(rv.work.slice(r.workStart, r.workEnd).trim());
    return { kind: 'addition', label: oldEmpty ? (many ? 'New paragraphs' : 'New paragraph') : 'Added text', summary: `${plural(added, 'word')} added` };
  }
  const summary = `${plural(removed, 'word')} → ${plural(added, 'word')}`;
  if (isRewrite(rv, r)) return { kind: 'rewrite', label: 'Rewritten', summary };
  return { kind: 'edit', label: removed || added ? 'Edited' : 'Spacing', summary };
}

// The section (or \paragraph) a position is in, for labelling suggestions.
const HEADING = /\\(?:sub)*section\*?\s*\{([^}]*)\}|\\paragraph\*?\s*\{((?:[^{}]|\{[^}]*\})*)\}/g;
function sectionAt(rv, offset) {
  if (rv.headingsFor !== rv.work) {
    rv.headings = [];
    HEADING.lastIndex = 0;
    let m;
    while ((m = HEADING.exec(rv.work))) {
      const name = (m[1] || m[2]).replace(/\\[A-Za-z]+\*?\s*/g, '').replace(/[{}]/g, '').trim().replace(/[.:]$/, '');
      if (name) rv.headings.push({ at: m.index, name });
    }
    rv.headingsFor = rv.work;
  }
  let name = '';
  for (const h of rv.headings) { if (h.at <= offset) name = h.name; else break; }
  return name;
}

// Where a suggestion visibly starts: its first non-blank character (a paragraph's change often
// begins with the blank line before it), or its start if it adds nothing.
function startOf(rv, r) {
  const m = rv.work.slice(r.workStart, r.workEnd).match(/\S/);
  return m ? r.workStart + m.index : r.workStart;
}

// The suggestions to show and count: a move counts once, at its new place.
const pending = rv => rv.regions.filter(r => !(r.move && r.move.role === 'from'));

// 1-based line number of an offset in the current text.
function lineAt(text, offset) {
  let n = 1;
  for (let i = text.indexOf('\n'); i !== -1 && i < offset; i = text.indexOf('\n', i + 1)) n++;
  return n;
}

// Each note with where it now sits: a text range, the suggestion it belongs to, or neither,
// plus `answer`: the suggestion that answers it, if any. A comment the author started is
// answered by the suggestion an agent reply names ("change": an anchor like a proposal note's),
// or else by the suggestion its text now sits in or was changed by.
function placeNotes(rv, list) {
  return list.map(note => {
    const placed = place(rv, note);
    const linked = [...(note.messages || [])].reverse().find(m => m.change && m.change.proposal);
    const started = note.messages && note.messages[0] && note.messages[0].from;
    if (linked) placed.answer = notes.locateProposal(rv.base, rv.work, rv.regions, linked.change);
    else if (started === 'user' && !(note.anchor && note.anchor.proposal)) placed.answer = placed.region;
    return placed;
  });
}

function place(rv, note) {
  {
    if (note.anchor && note.anchor.proposal) {
      return { note, region: notes.locateProposal(rv.base, rv.work, rv.regions, note.anchor) };
    }
    const range = note.anchor ? notes.locateText(rv.work, note.anchor) : null;
    if (range) {
      note.anchor.offset = range.start;
      const region = rv.regions.find(r => r.workStart <= range.start && range.start < Math.max(r.workEnd, r.workStart + 1));
      return { note, range, region };
    }
    // A note whose text is gone stays with the suggestion that changed it: the one whose
    // accepted (old) text still contains the quote, nearest to where the note was.
    const quote = note.anchor && note.anchor.quote;
    const off = (note.anchor && note.anchor.offset) || 0;
    const region = quote && rv.regions.filter(r => rv.base.slice(r.baseStart, r.baseEnd).includes(quote))
      .sort((x, y) => Math.abs(x.workStart - off) - Math.abs(y.workStart - off))[0];
    return { note, range: null, region };
  }
}

// The agent's explanation of a suggestion (its own notes on it), for summaries.
function whyOf(rv, r, list) {
  const texts = placeNotes(rv, list).filter(p => (p.answer || p.region) === r)
    .flatMap(p => p.note.messages.filter(m => m.from === 'agent').map(m => m.text));
  return texts.length ? texts[0].replace(/^why:\s*/i, '') : '';
}

module.exports = { pending, startOf, INLINE_MAX, isShort, removedText, isRewrite, wordCount, plural, analyze, describe, sectionAt, lineAt, placeNotes, whyOf };
