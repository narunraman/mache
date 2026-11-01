'use strict';
// Finds top-level \ReviewDelete[...]{...} and \ReviewAdd{...} in LaTeX source and
// groups adjacent ones into hunks. Pure string offsets, no VS Code dependency.

const CMD = /\\Review(Add|Delete)(?![A-Za-z])(\[[^\]\n]*\])?\s*\{/y;

// Index just past the brace that closes the group opened at `open`, or -1.
function matchBrace(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') { i++; continue; }
    if (c === '%') { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i + 1;
  }
  return -1;
}

function findConstructs(text) {
  const out = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '%') { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (c !== '\\') continue;
    CMD.lastIndex = i;
    const m = CMD.exec(text);
    if (!m) { i++; continue; }
    const open = CMD.lastIndex - 1;
    const end = matchBrace(text, open);
    if (end < 0) break; // unbalanced; stop rather than guess
    out.push({
      kind: m[1] === 'Add' ? 'add' : 'delete',
      start: i,
      bodyStart: open + 1,
      bodyEnd: end - 1,
      end,
    });
    i = end - 1;
  }
  return out;
}

// Constructs separated only by whitespace and bare end-of-line `%` form one hunk.
const SEP = /^(?:\s|%[ \t]*(?=\n|$))*$/;

function findHunks(text) {
  const hunks = [];
  let cur = null;
  for (const c of findConstructs(text)) {
    if (cur && SEP.test(text.slice(cur.end, c.start))) {
      cur.parts.push(c);
      cur.end = c.end;
    } else {
      cur = { start: c.start, end: c.end, parts: [c] };
      hunks.push(cur);
    }
  }
  return hunks;
}

// Body without the `%\n` that guards a leading newline or the trailing newline.
function cleanBody(text, part) {
  return text.slice(part.bodyStart, part.bodyEnd)
    .replace(/^%[ \t]*\n/, '')
    .replace(/\n[ \t]*$/, '');
}

// Text edit {start, end, text} resolving a hunk by keeping parts of one kind
// (the other kind is dropped).
function resolveHunk(text, hunk, keepKind) {
  const pieces = [];
  let sep = null;
  hunk.parts.forEach((p, idx) => {
    if (p.kind === keepKind) {
      if (pieces.length) pieces.push(sep ?? '\n');
      pieces.push(cleanBody(text, p));
      const next = hunk.parts[idx + 1];
      sep = next ? text.slice(p.end, next.start) : null;
    }
  });
  let start = hunk.start;
  let end = hunk.end;
  if (pieces.length) return { start, end, text: pieces.join('') };

  // Nothing kept: remove the hunk, plus a guarding `%`, plus its line if it becomes empty.
  const trail = /^%[ \t]*(?=\n|$)/.exec(text.slice(end));
  if (trail) end += trail[0].length;
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  let lineEnd = text.indexOf('\n', end);
  if (lineEnd < 0) lineEnd = text.length;
  if (/^[ \t]*$/.test(text.slice(lineStart, start)) && /^[ \t]*$/.test(text.slice(end, lineEnd))) {
    start = lineStart;
    end = Math.min(lineEnd + 1, text.length);
  } else if (text[start - 1] === ' ' && (text[end] === ' ' || text[end] === '\n')) {
    start -= 1;
  }
  return { start, end, text: '' };
}

module.exports = { findConstructs, findHunks, resolveHunk, cleanBody };
