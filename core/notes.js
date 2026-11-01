'use strict';
// Notes: comment threads on a reviewed .tex file, kept in .review/<name>.notes.json so
// they never touch the paper. A note is anchored either to a piece of text (the quoted
// text plus a little context on each side, found again after edits) or to a proposal
// (the start of its accepted and proposed text). Both you and the agent append messages.
//
// {
//   "notes": [
//     { "id": "n1", "status": "open",
//       "anchor": { "quote": "dual-self model", "prefix": "within a ", "suffix": ", which was", "offset": 10950 },
//       "messages": [ { "from": "user", "text": "Cite the original?", "at": "2026-10-29T21:00:00Z" } ] },
//     { "id": "n2", "status": "open",
//       "anchor": { "proposal": { "old": "These tools are now", "new": "These tools are now" }, "offset": 10822 },
//       "messages": [ { "from": "agent", "text": "Shortened: the second half repeated section 2.", "at": "..." } ] }
//   ]
// }
const fs = require('fs');
const path = require('path');

const CONTEXT = 40;  // characters of prefix/suffix stored with a quote
const LEAD = 80;     // characters of a proposal's text stored to recognise it

function notesPath(basePath) {
  return path.join(path.dirname(basePath), path.basename(basePath).replace(/\.tex$/, '') + '.notes.json');
}

// The notes in a file: [] if there is no file yet, null if it is not valid (e.g. half-written).
function load(p) {
  let text;
  try { text = fs.readFileSync(p, 'utf8'); } catch { return []; }
  try {
    const data = JSON.parse(text);
    return Array.isArray(data.notes) ? data.notes.map(tidy) : null;
  } catch {
    return null;
  }
}

// Accept a note whose anchor fields were written at the top level instead of under "anchor"
// (an easy mistake for an agent), and fill in a missing status or message list.
function tidy(note) {
  if (!note.anchor) {
    const keys = ['proposal', 'quote', 'prefix', 'suffix', 'offset'].filter(k => k in note);
    if (keys.length) {
      note.anchor = {};
      for (const k of keys) { note.anchor[k] = note[k]; delete note[k]; }
    }
  }
  if (!note.status) note.status = 'open';
  if (!Array.isArray(note.messages)) note.messages = [];
  return note;
}

function serialize(notes) {
  return JSON.stringify({ notes }, null, 2) + '\n';
}

function nextId(notes) {
  const n = notes.reduce((m, x) => Math.max(m, parseInt(String(x.id).replace(/\D/g, ''), 10) || 0), 0);
  return `n${n + 1}`;
}

function textAnchor(work, start, end) {
  return {
    quote: work.slice(start, end),
    prefix: work.slice(Math.max(0, start - CONTEXT), start),
    suffix: work.slice(end, end + CONTEXT),
    offset: start,
  };
}

const lead = s => s.trim().slice(0, LEAD);

function proposalAnchor(base, work, region) {
  return {
    proposal: { old: lead(base.slice(region.baseStart, region.baseEnd)), new: lead(work.slice(region.workStart, region.workEnd)) },
    offset: region.workStart,
  };
}

// Length of the common run at the end of a and the start of b's mirror (for prefix) or start (for suffix).
function commonSuffix(a, b) {
  let k = 0;
  while (k < a.length && k < b.length && a[a.length - 1 - k] === b[b.length - 1 - k]) k++;
  return k;
}
function commonPrefix(a, b) {
  let k = 0;
  while (k < a.length && k < b.length && a[k] === b[k]) k++;
  return k;
}

// Where a text anchor sits in the current text: { start, end } or null if the quote is gone.
function locateText(work, a) {
  if (!a.quote) return null;
  let best = null;
  for (let i = work.indexOf(a.quote); i >= 0; i = work.indexOf(a.quote, i + 1)) {
    const end = i + a.quote.length;
    const score = commonSuffix(work.slice(Math.max(0, i - CONTEXT), i), a.prefix || '') +
      commonPrefix(work.slice(end, end + CONTEXT), a.suffix || '') -
      Math.abs(i - (a.offset || 0)) / 1e4;
    if (!best || score > best.score) best = { start: i, end, score };
  }
  return best && { start: best.start, end: best.end };
}

// The proposal (region) a proposal anchor refers to, or undefined once it is gone.
function locateProposal(base, work, regions, a) {
  const p = a.proposal;
  const oldOf = r => lead(base.slice(r.baseStart, r.baseEnd));
  const newOf = r => lead(work.slice(r.workStart, r.workEnd));
  const near = rs => rs.sort((x, y) => Math.abs(x.workStart - a.offset) - Math.abs(y.workStart - a.offset))[0];
  if (p.old) {
    const r = near(regions.filter(r => oldOf(r) === p.old));
    if (r) return r;
  }
  if (p.new) {
    const r = near(regions.filter(r => newOf(r) === p.new));
    if (r) return r;
  }
  return undefined;
}

module.exports = { notesPath, load, serialize, nextId, textAnchor, proposalAnchor, locateText, locateProposal };
