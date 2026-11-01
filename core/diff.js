'use strict';
// Baseline-vs-working diff for prose. Lines are compared first (a LaTeX paragraph
// is usually one line); each changed run of lines is then refined word by word,
// unless most of it changed, in which case it stays one block.

const MAX_CELLS = 2e7;     // LCS table limit; beyond this a region is one block
const BLOCK_RATIO = 0.6;   // changed share of a region above which it counts as rewritten
const MERGE_GAP = 3;       // spaces/punctuation tokens between two changes that are joined into one

// LCS diff of two arrays. Returns ops [{eq, aStart, aEnd, bStart, bEnd}] covering both.
function diffSeq(a, b, eq = (x, y) => x === y) {
  let pre = 0;
  while (pre < a.length && pre < b.length && eq(a[pre], b[pre])) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre &&
         eq(a[a.length - 1 - suf], b[b.length - 1 - suf])) suf++;
  const n = a.length - pre - suf;
  const m = b.length - pre - suf;
  const ops = [];
  const push = (isEq, a0, a1, b0, b1) => {
    if (a0 === a1 && b0 === b1) return;
    const last = ops[ops.length - 1];
    if (last && last.eq === isEq) { last.aEnd = a1; last.bEnd = b1; }
    else ops.push({ eq: isEq, aStart: a0, aEnd: a1, bStart: b0, bEnd: b1 });
  };
  push(true, 0, pre, 0, pre);
  if (n && m && (n + 1) * (m + 1) <= MAX_CELLS) {
    const w = m + 1;
    const L = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        L[i * w + j] = eq(a[pre + i], b[pre + j])
          ? L[(i + 1) * w + j + 1] + 1
          : Math.max(L[(i + 1) * w + j], L[i * w + j + 1]);
      }
    }
    let i = 0, j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && eq(a[pre + i], b[pre + j])) {
        push(true, pre + i, pre + i + 1, pre + j, pre + j + 1); i++; j++;
      } else if (j < m && (i === n || L[i * w + j + 1] >= L[(i + 1) * w + j])) {
        push(false, pre + i, pre + i, pre + j, pre + j + 1); j++;
      } else {
        push(false, pre + i, pre + i + 1, pre + j, pre + j); i++;
      }
    }
  } else {
    push(false, pre, pre + n, pre, pre + m);
  }
  push(true, a.length - suf, a.length, b.length - suf, b.length);
  return ops;
}

// Lines with their terminating newline, plus start offsets.
function splitLines(text) {
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) || [];
  const starts = [];
  let o = 0;
  for (const l of lines) { starts.push(o); o += l.length; }
  starts.push(o);
  return { lines, starts };
}

const TOKEN = /\\[A-Za-z@]+\*?|\s+|[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*|[^\sA-Za-z0-9]/g;
function tokenize(text, offset) {
  const toks = [];
  let m;
  TOKEN.lastIndex = 0;
  while ((m = TOKEN.exec(text))) toks.push({ s: m[0], o: offset + m.index });
  return toks;
}

// A change: base[baseStart, baseEnd) was replaced by work[workStart, workEnd).
// Changes are grouped into regions (one per changed run of lines) for paragraph actions.
// r.changes are the edits shown and acted on, joined into phrases across spaces and
// punctuation (r.phrases is the same list); r.raw is the exact token-level difference, used
// to tell your typing apart from a suggestion; r.heavy is set when most of the paragraph changed.
function computeRegions(base, work) {
  const A = splitLines(base);
  const B = splitLines(work);
  const regions = [];
  // Changes separated only by blank lines are one block, so its paragraphs can be paired.
  const all = diffSeq(A.lines, B.lines);
  const ops = [];
  all.forEach((op, k) => {
    if (op.eq) return;
    const last = ops[ops.length - 1];
    const gap = all[k - 1];
    if (last && gap && gap.eq && last.aEnd === gap.aStart && last.bEnd === gap.bStart &&
        A.lines.slice(gap.aStart, gap.aEnd).every(l => !l.trim())) {
      last.aEnd = op.aEnd;
      last.bEnd = op.bEnd;
    } else ops.push({ ...op });
  });
  for (const op of ops) {
    if (op.eq) continue;
    for (const part of splitParagraphs(A, B, op)) {
      const r = {
        baseStart: A.starts[part.aStart], baseEnd: A.starts[part.aEnd],
        workStart: B.starts[part.bStart], workEnd: B.starts[part.bEnd],
      };
      Object.assign(r, refine(base, work, r));
      regions.push(r);
    }
  }
  findMoves(base, work, regions);
  return regions;
}

// A changed run of lines can hold several paragraphs on each side, e.g. one paragraph deleted
// next to another edited. Pair them by content (in order) so that each pair is its own
// region and unpaired paragraphs are plain deletions or additions; otherwise they would read
// as one rewrite, and a moved paragraph next to an edit would never be recognised.
const PAIR_SIMILARITY = 0.35;

// Paragraphs of lines [start, end): each is its text lines plus the blank lines after them.
function paragraphs(lines, start, end) {
  const units = [];
  for (let i = start; i < end; i++) {
    const blank = !lines[i].trim();
    const last = units[units.length - 1];
    if (last && (blank || !last.ended)) { last.end = i + 1; if (blank) last.ended = true; }
    else units.push({ start: i, end: i + 1, ended: blank });
  }
  return units;
}

function splitParagraphs(A, B, op) {
  const whole = [{ aStart: op.aStart, aEnd: op.aEnd, bStart: op.bStart, bEnd: op.bEnd }];
  const pa = paragraphs(A.lines, op.aStart, op.aEnd);
  const pb = paragraphs(B.lines, op.bStart, op.bEnd);
  if (!pa.length || !pb.length || (pa.length === 1 && pb.length === 1) || pa.length * pb.length > 400) return whole;
  const text = (L, u) => L.lines.slice(u.start, u.end).join('');
  const sim = pa.map(a => pb.map(b => similarity(text(A, a), text(B, b))));
  // Close matches count far more than loose ones, and an unchanged paragraph most of all, so a
  // chain of loose pairings never beats the obvious ones.
  const score = s => (s > 0.9999 ? 10 : s ** 4);
  // Best order-preserving pairing (most total similarity), as in an alignment.
  const n = pa.length, m = pb.length;
  const best = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const pair = sim[i][j] >= PAIR_SIMILARITY ? score(sim[i][j]) + best[i + 1][j + 1] : -1;
      best[i][j] = Math.max(pair, best[i + 1][j], best[i][j + 1]);
    }
  }
  const parts = [];
  let i = 0, j = 0;
  // Blank lines left over from an unchanged paragraph start the next part (see below).
  let carry = null;
  const push = (a0, a1, b0, b1) => {
    if (carry) { a0 = Math.min(a0, carry.a); b0 = Math.min(b0, carry.b); carry = null; }
    parts.push({ aStart: a0, aEnd: a1, bStart: b0, bEnd: b1 });
  };
  const textEnd = (L, u) => { let k = u.start; while (k < u.end && L.lines[k].trim()) k++; return k; };
  const at = (units, k, L, fallback) => (k < units.length ? units[k].start : fallback);
  while (i < n || j < m) {
    if (i < n && j < m && sim[i][j] >= PAIR_SIMILARITY && best[i][j] === score(sim[i][j]) + best[i + 1][j + 1]) {
      // An unchanged paragraph is no change; one that differs only in the blank lines after it
      // hands just those lines to the next change.
      const ta = text(A, pa[i]), tb = text(B, pb[j]);
      if (ta.trim() !== tb.trim()) push(pa[i].start, pa[i].end, pb[j].start, pb[j].end);
      else if (ta !== tb) carry = { a: textEnd(A, pa[i]), b: textEnd(B, pb[j]) };
      i++; j++;
    } else if (i < n && (j === m || best[i][j] === best[i + 1][j])) {
      const b = at(pb, j, B, op.bEnd);
      push(pa[i].start, pa[i].end, b, b); i++;
    } else {
      const a = at(pa, i, A, op.aEnd);
      push(a, a, pb[j].start, pb[j].end); j++;
    }
  }
  // Blank lines at the very end with no change after them join the last change, or stand alone.
  if (carry) {
    const last = parts[parts.length - 1];
    if (last && last.aEnd === carry.a && last.bEnd === carry.b) { last.aEnd = op.aEnd; last.bEnd = op.bEnd; }
    else parts.push({ aStart: carry.a, aEnd: op.aEnd, bStart: carry.b, bEnd: op.bEnd });
  }
  return parts.length ? parts : whole;
}

// Moved paragraphs. Line by line, a paragraph that moved is a deletion in one place and an
// addition in another; when a region that only deletes and a region that only adds hold mostly
// the same words, they are one move. Both get r.move = { role: 'from' | 'to', partner,
// similarity }, and the 'to' region gets moveChanges: its wording changes against the original,
// in the same shape as r.changes (base offsets inside the 'from' region).
const MOVE_MIN_WORDS = 12;  // shorter blocks are not worth calling moves
const MOVE_SIMILARITY = 0.6; // share of words in common (2·common / total) to count as a move
const words = s => s.match(/\S+/g) || [];

function similarity(a, b) {
  const x = words(a), y = words(b);
  if (!x.length || !y.length || x.length * y.length > MAX_CELLS) return 0;
  const common = diffSeq(x, y).filter(op => op.eq).reduce((n, op) => n + op.aEnd - op.aStart, 0);
  return (2 * common) / (x.length + y.length);
}

function findMoves(base, work, regions) {
  const oldOf = r => base.slice(r.baseStart, r.baseEnd);
  const newOf = r => work.slice(r.workStart, r.workEnd);
  const removals = regions.filter(r => !newOf(r).trim() && words(oldOf(r)).length >= MOVE_MIN_WORDS);
  const additions = regions.filter(r => !oldOf(r).trim() && words(newOf(r)).length >= MOVE_MIN_WORDS);
  if (!removals.length || !additions.length) return;
  const pairs = [];
  for (const from of removals) {
    for (const to of additions) {
      const s = similarity(oldOf(from), newOf(to));
      if (s >= MOVE_SIMILARITY) pairs.push({ from, to, s });
    }
  }
  // Best matches first, each region in at most one move.
  pairs.sort((p, q) => q.s - p.s);
  for (const { from, to, s } of pairs) {
    if (from.move || to.move) continue;
    from.move = { role: 'from', partner: to, similarity: s };
    to.move = { role: 'to', partner: from, similarity: s };
    // Trim the blank lines around both blocks so the wording diff is of the text alone.
    const lead = (text, start, end) => { const m = text.slice(start, end).match(/^\s*/); return start + m[0].length; };
    const tail = (text, start, end) => { const m = text.slice(start, end).match(/\s*$/); return end - m[0].length; };
    const span = {
      baseStart: lead(base, from.baseStart, from.baseEnd), baseEnd: tail(base, from.baseStart, from.baseEnd),
      workStart: lead(work, to.workStart, to.workEnd), workEnd: tail(work, to.workStart, to.workEnd),
    };
    to.moveSpan = span;
    to.moveChanges = s > 0.9999 && base.slice(span.baseStart, span.baseEnd) === work.slice(span.workStart, span.workEnd) ? [] : refine(base, work, span).changes;
  }
}

function refine(base, work, r) {
  const block = [{ baseStart: r.baseStart, baseEnd: r.baseEnd, workStart: r.workStart, workEnd: r.workEnd }];
  const a = tokenize(base.slice(r.baseStart, r.baseEnd), r.baseStart);
  const b = tokenize(work.slice(r.workStart, r.workEnd), r.workStart);
  if (!a.length || !b.length || (a.length + 1) * (b.length + 1) > MAX_CELLS) return { changes: block, phrases: block, raw: block, heavy: true };

  const ops = diffSeq(a, b, (x, y) => x.s === y.s);
  const at = (toks, i, fallback) => (i < toks.length ? toks[i].o : fallback);
  const toChange = op => ({
    baseStart: at(a, op.aStart, r.baseEnd), baseEnd: at(a, op.aEnd, r.baseEnd),
    workStart: at(b, op.bStart, r.workEnd), workEnd: at(b, op.bEnd, r.workEnd),
  });
  const raw = ops.filter(op => !op.eq).map(toChange);
  // Join changes separated only by spaces or punctuation, so edits read as phrases, not
  // confetti. Never join across a word: it may be text you typed next to a suggestion.
  const light = op => a.slice(op.aStart, op.aEnd).every(t => /^(\s+|[^\sA-Za-z0-9\\])$/.test(t.s));
  const merged = [];
  for (let k = 0; k < ops.length; k++) {
    const op = ops[k];
    const prev = merged[merged.length - 1];
    const next = ops[k + 1];
    if (op.eq && prev && next && op.aEnd - op.aStart <= MERGE_GAP && light(op)) {
      prev.aEnd = next.aEnd; prev.bEnd = next.bEnd; k++;
    } else if (!op.eq && prev && !prev.eq) {
      prev.aEnd = op.aEnd; prev.bEnd = op.bEnd;
    } else {
      merged.push({ ...op });
    }
  }

  const changes = merged.filter(op => !op.eq).map(toChange);
  const changed = raw.reduce((s, c) => s + (c.baseEnd - c.baseStart) + (c.workEnd - c.workStart), 0);
  const total = (r.baseEnd - r.baseStart) + (r.workEnd - r.workStart);
  return { changes, phrases: changes, raw, heavy: changed / total > BLOCK_RATIO };
}

// Apply a set of changes (from computeRegions) to the baseline, last first (changes starting at
// the same baseline offset in reverse working order, so insertions there keep their order): the baseline takes
// the working text in those spots.
function acceptChanges(base, work, changes) {
  let out = base;
  for (const c of [...changes].sort((x, y) => (y.baseStart - x.baseStart) || (y.workStart - x.workStart))) {
    out = out.slice(0, c.baseStart) + work.slice(c.workStart, c.workEnd) + out.slice(c.baseEnd);
  }
  return out;
}

// Map a working-text offset that lies outside every change to the baseline. A pure
// removal sitting exactly at the offset counts as before it only if atRemoval is true.
function workToBase(changes, offset, atRemoval = true) {
  let delta = 0;
  for (const c of changes) {
    const before = c.workEnd < offset || (c.workEnd === offset && (atRemoval || c.workStart < c.workEnd));
    if (before) delta += (c.baseEnd - c.baseStart) - (c.workEnd - c.workStart);
  }
  return offset + delta;
}

module.exports = { computeRegions, acceptChanges, workToBase, diffSeq, tokenize };
