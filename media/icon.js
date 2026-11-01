'use strict';
// Draws the Mâché icon: a page made of torn paper strips, layered like papier-mâché.
// Everything is randomised from a seed, so each seed is a different "handmade" icon.
//
//   node icon.js [seed]          writes mache.svg (colour) and mache-mono.svg (activity bar)
//   node icon.js --sheet a b c   writes sheet.html comparing seeds at several sizes
//   --trio                       adds a red (rejected) and a yellow (comment) strip

const fs = require('fs');
const path = require('path');

// Small seeded PRNG (mulberry32), so a seed always draws the same icon.
function rng(seed) {
  let a = typeof seed === 'number' ? seed : [...String(seed)].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 2654435761) >>> 0, 7);
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const f = n => Math.round(n * 10) / 10;
const pts = ps => ps.map(([x, y]) => `${f(x)},${f(y)}`).join(' ');

// Points along A→B with a torn edge: a slow wander plus fine, uneven fibres.
function tear(R, [ax, ay], [bx, by], { step = 3, wander = 2.2, fibre = 1.4 } = {}) {
  const len = Math.hypot(bx - ax, by - ay);
  const nx = -(by - ay) / len, ny = (bx - ax) / len;
  const n = Math.max(2, Math.round(len / step));
  const phase = R() * 10, freq = 0.04 + R() * 0.05;
  const out = [];
  let drift = 0;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    drift = drift * 0.7 + (R() - 0.5) * 0.9;
    const d = Math.sin(phase + i * step * freq) * wander + drift + (R() - 0.5) * fibre * (R() < 0.2 ? 2.5 : 1);
    out.push([ax + (bx - ax) * t + nx * d, ay + (by - ay) * t + ny * d]);
  }
  return out;
}

// A wobbly line, as if drawn freehand.
function wobble(R, a, b, amount = 0.8) {
  return tear(R, a, b, { step: 6, wander: amount, fibre: amount * 0.6 });
}

// A strip across the page at angle `ang` through (cx, cy): two torn long edges, ends run off the page.
function strip(R, cx, cy, ang, width, reach = 200) {
  const dx = Math.cos(ang), dy = Math.sin(ang);
  const nx = -dy, ny = dx;
  const h = width / 2;
  const p = (s, o) => [cx + dx * s + nx * o, cy + dy * s + ny * o];
  const top = tear(R, p(-reach, -h), p(reach, -h));
  const bottom = tear(R, p(reach, h), p(-reach, h));
  return { top, bottom, poly: [...top, ...bottom], cx, cy, ang, width };
}

const PAPERS = ['#f7f1e3', '#ead9b8', '#f3e9d4', '#e0cca6', '#f9f4ea', '#e6d4b0'];
const GREEN = '#a9d6a2';
const RED = '#eab0a8';
const YELLOW = '#f1dc8e';

function colourIcon(seed, { trio = false } = {}) {
  const R = rng(seed);
  const S = 256;
  // The page: a slightly crooked sheet with a hand-cut outline.
  const tilt = (R() - 0.5) * 0.12;
  const corners = [[44, 20], [210, 16], [216, 238], [38, 240]].map(([x, y]) => {
    const cx = 128, cy = 128;
    const xr = cx + (x - cx) * Math.cos(tilt) - (y - cy) * Math.sin(tilt);
    const yr = cy + (x - cx) * Math.sin(tilt) + (y - cy) * Math.cos(tilt);
    return [xr + (R() - 0.5) * 5, yr + (R() - 0.5) * 5];
  });
  const outline = [];
  for (let i = 0; i < 4; i++) outline.push(...tear(R, corners[i], corners[(i + 1) % 4], { step: 4, wander: 1.2, fibre: 1.1 }));

  // Strips laid in two directions, the way papier-mâché is built up.
  const strips = [];
  const base = -0.35 + (R() - 0.5) * 0.2;
  const n = 7;
  for (let i = 0; i < n; i++) {
    const cross = i % 3 === 2;
    const ang = (cross ? base + Math.PI / 2 - 0.25 : base) + (R() - 0.5) * 0.22;
    const t = (i + 0.5) / n;
    const cx = 128 + (cross ? (t - 0.5) * 150 : (R() - 0.5) * 20);
    const cy = 128 + (cross ? (R() - 0.5) * 20 : (t - 0.5) * 230);
    const s = strip(R, cx, cy, ang, 38 + R() * 18);
    // Neighbouring strips alternate light and dark paper, so the layers read at small sizes.
    s.fill = PAPERS[(i % 2 ? 1 : 0) + 2 * Math.floor(R() * 3)];
    strips.push(s);
  }
  // The last paper strip carries handwriting; on top of everything, a green strip (a suggestion,
  // with a tick) runs through the middle of the page.
  // With `trio`, a yellow comment strip (handwriting and a speech bubble) and a red rejected
  // strip (a pencilled cross) join it, and the handwriting moves onto the comment.
  const marks = []; // where the pencil marks sit, so later strips can leave them visible
  const coloured = (cy, ang, width, fill, mark, at) => {
    const s = strip(R, 128 + (R() - 0.5) * 16, cy + (R() - 0.5) * 12, ang, width);
    const dx = Math.cos(ang), dy = Math.sin(ang), a = (at[0] - s.cx) * dx + (at[1] - s.cy) * dy;
    Object.assign(s, { fill, mark, at: [s.cx + dx * a, s.cy + dy * a] });
    marks.push(s.at);
    if (mark === 'bubble') marks.push([s.at[0] - dx * 52, s.at[1] - dy * 52]); // its handwriting
    strips.push(s);
    return s;
  };
  // A plain strip laid over the coloured ones, placed so it misses every mark so far.
  const overlay = () => {
    for (let tries = 0; tries < 80; tries++) {
      const ang = base + (R() < 0.5 ? Math.PI / 2 : 0) + (R() - 0.5) * 1.1;
      const w = 22 + R() * 12, cx = 50 + R() * 156, cy = 30 + R() * 196;
      const clear = marks.every(([mx, my]) => Math.abs(-(mx - cx) * Math.sin(ang) + (my - cy) * Math.cos(ang)) > w / 2 + 20);
      if (!clear) continue;
      const s = strip(R, cx, cy, ang, w);
      s.fill = PAPERS[Math.floor(R() * PAPERS.length)];
      strips.push(s);
      return;
    }
  };
  if (trio) {
    // Red, yellow and green run in different directions, with paper laid over parts of them.
    coloured(206, base - 0.3 + (R() - 0.5) * 0.2, 40 + R() * 6, YELLOW, 'bubble', [150, 208]).writing = true;
    overlay();
    coloured(72, base + 0.55 + (R() - 0.5) * 0.2, 36 + R() * 6, RED, 'cross', [100, 74]);
    overlay();
    coloured(146, base + (R() - 0.5) * 0.18, 42 + R() * 6, GREEN, 'tick', [140, 140]);
    overlay();
  } else {
    strips[n - 1].writing = true;
    coloured(146, base + (R() - 0.5) * 0.18, 42 + R() * 6, GREEN, 'tick', [140, 140]);
  }

  const defs = `
  <defs>
    <clipPath id="page"><polygon points="${pts(outline)}"/></clipPath>
    <filter id="soft" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="2.2"/></filter>
    <filter id="grain" x="0" y="0" width="100%" height="100%">
      <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="${Math.floor(R() * 1000)}" result="n"/>
      <feColorMatrix type="matrix" values="0 0 0 0 0.35  0 0 0 0 0.28  0 0 0 0 0.18  0 0 0 0.55 -0.12"/>
    </filter>
    <filter id="fibres" x="-5%" y="-5%" width="110%" height="110%">
      <feTurbulence type="fractalNoise" baseFrequency="0.08" numOctaves="3" seed="${Math.floor(R() * 1000)}"/>
      <feDisplacementMap in="SourceGraphic" scale="2.2"/>
    </filter>
  </defs>`;

  let body = '';
  // Shadow of the whole page, then the page's backing sheet.
  body += `<polygon points="${pts(outline.map(([x, y]) => [x + 3, y + 5]))}" fill="#3b2f1e" opacity=".35" filter="url(#soft)"/>`;
  body += `<polygon points="${pts(outline)}" fill="#e6d8bd"/>`;
  body += `<g clip-path="url(#page)">`;
  for (const s of strips) {
    body += `<polygon points="${pts(s.poly.map(([x, y]) => [x + 1.5, y + 2.5]))}" fill="#4a3a22" opacity=".32" filter="url(#soft)"/>`;
    body += `<g filter="url(#fibres)">`;
    body += `<polygon points="${pts(s.poly)}" fill="${s.fill}"/>`;
    // The torn edge shows a paler, fibrous layer.
    for (const edge of [s.top, s.bottom]) {
      body += `<polyline points="${pts(edge)}" fill="none" stroke="#fffdf6" stroke-width="${f(1.8 + R() * 1)}" stroke-linejoin="round"/>`;
    }
    body += `</g>`;
    const dx = Math.cos(s.ang), dy = Math.sin(s.ang), nx = -dy, ny = dx;
    // A mark sits on the strip's centre line, as close to its target point as it gets.
    const onAxis = p => p;
    const pen = (ps, colour, width) =>
      `<polyline points="${pts(ps)}" fill="none" stroke="${colour}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" opacity=".85"/>`;
    if (s.writing) {
      // A few lines of "handwriting" along the strip.
      const from = s.mark === 'bubble' ? -75 : -45;
      for (let k = -1; k <= 1; k++) {
        const o = k * (s.width * 0.22);
        // On the comment strip the writing runs up to the speech bubble.
        const len = (s.mark === 'bubble' ? 40 : 50) + R() * (s.mark === 'bubble' ? 14 : 30);
        const start = s.mark === 'bubble' ? (s.at[0] - s.cx) * dx + (s.at[1] - s.cy) * dy - 78 + R() * 6
          : (128 - s.cx) * dx + (128 - s.cy) * dy + from + R() * 15;
        const a = [s.cx + dx * start + nx * o, s.cy + dy * start + ny * o];
        const b = [a[0] + dx * len, a[1] + dy * len];
        body += `<polyline points="${pts(wobble(R, a, b, 0.7))}" fill="none" stroke="#5d4c38" stroke-width="2.4" stroke-linecap="round" opacity=".6"/>`;
      }
    }
    if (s.mark === 'tick') {
      const c = onAxis(s.at);
      body += pen([...wobble(R, [c[0] - 13, c[1] - 1], [c[0] - 3, c[1] + 10], 0.5), ...wobble(R, [c[0] - 3, c[1] + 10], [c[0] + 17, c[1] - 15], 0.5)], '#2c6a37', 5);
    }
    if (s.mark === 'cross') {
      const c = onAxis(s.at);
      body += pen(wobble(R, [c[0] - 10, c[1] - 10], [c[0] + 10, c[1] + 10], 0.6), '#9b3128', 4.6);
      body += pen(wobble(R, [c[0] + 10, c[1] - 11], [c[0] - 9, c[1] + 10], 0.6), '#9b3128', 4.6);
    }
    if (s.mark === 'bubble') {
      // A speech bubble drawn in one pass: a wobbly rounded box with a tail.
      const [x, y] = onAxis(s.at), w = 30, h = 20;
      const box = [[x - w / 2, y - h / 2 - 2], [x + w / 2, y - h / 2], [x + w / 2 + 1, y + h / 2 - 1], [x - 2, y + h / 2],
        [x - 9, y + h / 2 + 8], [x - 8, y + h / 2], [x - w / 2 - 1, y + h / 2 - 1], [x - w / 2, y - h / 2 - 2]];
      let line = [];
      for (let i = 0; i < box.length - 1; i++) line = line.concat(wobble(R, box[i], box[i + 1], 0.45));
      body += pen(line, '#7a5a00', 3.4);
    }
  }
  body += `<rect width="${S}" height="${S}" filter="url(#grain)" opacity=".5"/>`;
  body += `</g>`;
  // A hand-drawn outline, gone over twice like a pen sketch.
  for (let k = 0; k < 2; k++) {
    const o = outline.map(([x, y]) => [x + (R() - 0.5) * 1.2, y + (R() - 0.5) * 1.2]);
    body += `<polygon points="${pts(o)}" fill="none" stroke="#4a3826" stroke-width="${k ? 1.4 : 3}" stroke-linejoin="round" opacity="${k ? .4 : .8}"/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">${defs}${body}</svg>\n`;
}

// The activity bar icon: one colour, line only, still hand-drawn.
function monoIcon(seed) {
  const R = rng(String(seed) + ':mono');
  const page = [[6, 3.2], [18.2, 2.8], [18.6, 21], [5.6, 21.3]];
  const outline = [];
  for (let i = 0; i < 4; i++) outline.push(...tear(R, page[i], page[(i + 1) % 4], { step: 1.6, wander: 0.18, fibre: 0.16 }));
  let body = `<polygon points="${pts2(outline)}" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>`;
  // Two torn seams across the page, and a strip of writing between them.
  for (const [a, b] of [[[6, 9.4], [18.4, 7.4]], [[5.8, 15.6], [18.5, 13.4]]]) {
    body += `<polyline points="${pts2(tear(R, a, b, { step: 1.1, wander: 0.35, fibre: 0.45 }))}" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/>`;
  }
  for (const [a, b] of [[[8.6, 11.9], [14.6, 10.9]]]) {
    body += `<polyline points="${pts2(wobble(R, a, b, 0.12))}" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" opacity=".8"/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">${body}</svg>\n`;
}
const pts2 = ps => ps.map(([x, y]) => `${Math.round(x * 100) / 100},${Math.round(y * 100) / 100}`).join(' ');

function sheet(seeds, trio = false) {
  const sizes = [256, 128, 64, 32, 16];
  const rows = seeds.map(s => {
    const svg = colourIcon(s, { trio });
    const uri = 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
    const mono = 'data:image/svg+xml;base64,' + Buffer.from(monoIcon(s).replaceAll('currentColor', '#cccccc')).toString('base64');
    return `<div class="row"><div class="seed">${s}</div>${sizes.map(z => `<img src="${uri}" width="${z}" height="${z}">`).join('')}` +
      `<div class="mono"><img src="${mono}" width="24" height="24"><img src="${mono}" width="48" height="48"></div></div>`;
  }).join('');
  return `<!DOCTYPE html><html><head><style>
    body { margin: 0; padding: 20px; background: #f3efe6; font: 13px system-ui, sans-serif; color: #444; }
    .row { display: flex; align-items: center; gap: 18px; margin-bottom: 14px; }
    .seed { width: 70px; }
    .mono { display: flex; gap: 10px; align-items: center; background: #252526; padding: 10px; }
  </style></head><body>${rows}</body></html>`;
}

const args = process.argv.slice(2);
const trio = args.includes('--trio');
const rest = args.filter(a => a !== '--trio');
if (rest[0] === '--sheet') {
  fs.writeFileSync(path.join(__dirname, 'sheet.html'), sheet(rest.slice(1).length ? rest.slice(1) : ['mache', 'papier', 'strips', 'glue'], trio));
} else {
  const seed = rest[0] || 'mache';
  fs.writeFileSync(path.join(__dirname, 'mache.svg'), colourIcon(seed, { trio }));
  fs.writeFileSync(path.join(__dirname, 'mache-mono.svg'), monoIcon(seed));
}
