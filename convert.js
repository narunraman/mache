#!/usr/bin/env node
'use strict';
// One-time conversion of \ReviewDelete/\ReviewAdd markup to baseline review:
//   .review/<name>  gets every deletion kept and every addition dropped (accepted text)
//   <name>          gets every addition kept and every deletion dropped (proposed text)
// Usage: node convert.js path/to/file.tex
const fs = require('fs');
const path = require('path');
const { findHunks, resolveHunk } = require('./parser');

function resolveAll(text, keepKind) {
  let out = text;
  for (const h of findHunks(text).reverse()) {
    const e = resolveHunk(text, h, keepKind);
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
  }
  return out;
}

const file = process.argv[2];
if (!file) { console.error('usage: convert.js file.tex'); process.exit(1); }
const basePath = path.join(path.dirname(file), '.review', path.basename(file));
if (fs.existsSync(basePath)) { console.error(`${basePath} already exists`); process.exit(1); }

const text = fs.readFileSync(file, 'utf8');
const n = findHunks(text).length;
fs.mkdirSync(path.dirname(basePath), { recursive: true });
fs.writeFileSync(basePath, resolveAll(text, 'delete'));
fs.writeFileSync(file, resolveAll(text, 'add'));
console.log(`${file}: converted ${n} proposals; accepted text in ${basePath}`);
