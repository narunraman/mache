'use strict';
// The review panel: a card per suggestion and per comment, in document order, with
// Accept / Reject / Comment / Compare buttons and comment threads. The extension sends
// the whole state on every refresh; the panel sends back what was clicked.
const vscode = require('vscode');

class ReviewPanel {
  constructor(onMessage) {
    this.onMessage = onMessage;
    this.view = undefined;
    this.pending = [];
  }

  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = html(nonce());
    view.webview.onDidReceiveMessage(m => this.onMessage(m));
    view.onDidDispose(() => { this.view = undefined; });
    view.onDidChangeVisibility(() => { if (view.visible) this.onMessage({ cmd: 'ready' }); });
  }

  post(msg) {
    if (this.view) this.view.webview.postMessage(msg);
    else if (msg.type === 'compose' || msg.type === 'commentOn' || msg.type === 'focus') this.pending.push(msg);
  }

  flush() {
    for (const m of this.pending.splice(0)) this.post(m);
  }

  async show() {
    await vscode.commands.executeCommand('mache.panel.focus');
  }
}

function nonce() {
  let s = '';
  for (let i = 0; i < 32; i++) s += 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 62)];
  return s;
}

// 16px line icons, drawn with the text colour.
const ICONS = {
  check: '<path d="M3.5 8.5l3 3 6-7"/>',
  close: '<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>',
  comment: '<path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z"/>',
  compare: '<path d="M2.5 3h4.5v10H2.5zM9 3h4.5v10H9z"/><path d="M4 6h1.5M10.5 6H12M4 8.5h1.5M10.5 8.5H12"/>',
  reply: '<path d="M6.5 4L3 7.5 6.5 11"/><path d="M3 7.5h6.5A3.5 3.5 0 0 1 13 11v1.5"/>',
  resolve: '<circle cx="8" cy="8" r="5.5"/><path d="M5.5 8.2l1.8 1.8 3.3-3.6"/>',
  reopen: '<path d="M3.5 8a4.5 4.5 0 1 0 1.4-3.3"/><path d="M3.5 2.5v2.5H6"/>',
  edited: '<path d="M10.5 3l2.5 2.5-6.5 6.5H4v-2.5z"/>',
  rewrite: '<path d="M3 5h8.5M9 2.5L11.5 5 9 7.5M13 11H4.5M7 8.5L4.5 11 7 13.5"/>',
  addition: '<path d="M8 3.5v9M3.5 8h9"/>',
  deletion: '<path d="M3.5 8h9"/>',
  move: '<path d="M8 2.5v11M5 10.5l3 3 3-3M5 5.5l3-3 3 3"/>',
  note: '<path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z"/><path d="M5 6h6M5 8h3.5"/>',
  filter: '<path d="M2.5 3.5h11l-4.3 5.2v4l-2.4 1.3v-5.3z"/>',
  tick: '<path d="M3.5 8.5l3 3 6-7"/>',
  chevron: '<path d="M5 6.5l3 3 3-3"/>',
};
const icon = name => `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;

function html(n) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${n}'; script-src 'nonce-${n}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style nonce="${n}">
  :root {
    --add: #3fa45b; --add-bg: rgba(63,164,91,.22);
    --del: #d9534f; --del-bg: rgba(217,83,79,.16);
    --note: #c9a227; --note-bg: rgba(201,162,39,.2);
    --edit: #5b8fd6;
    --muted: var(--vscode-descriptionForeground);
    --border: var(--vscode-widget-border, var(--vscode-panel-border));
  }
  * { border-radius: 0 !important; }
  body { margin: 0; padding: 0 12px 32px; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); }
  button { font: inherit; color: inherit; cursor: pointer; }
  svg { display: block; }
  .meta { font-family: var(--vscode-font-family); font-size: 11px; letter-spacing: .04em; color: var(--muted); }

  header { position: sticky; top: 0; z-index: 2; background: var(--vscode-sideBar-background); padding: 10px 0 8px; border-bottom: 1px solid var(--border); }
  .top, .sub { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .sub { margin-top: 2px; }
  .file { display: inline-flex; align-items: center; gap: 2px; max-width: 100%; border: none; background: none; padding: 2px 4px 2px 0; font-weight: 600; font-size: 1.05em; color: var(--vscode-foreground); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .file svg { flex: none; color: var(--muted); }
  .file:disabled { cursor: default; }
  .stat { display: inline-flex; align-items: center; gap: 3px; margin-right: 10px; }
  .stat svg { width: 13px; height: 13px; }
  .status { display: flex; font-family: var(--vscode-font-family); font-size: 11px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .bulk { display: flex; gap: 2px; flex: none; }
  .textbtn { border: none; background: none; padding: 2px 6px; color: var(--vscode-textLink-foreground); display: inline-flex; gap: 4px; align-items: center; }
  .textbtn:hover { background: var(--vscode-toolbar-hoverBackground); }
  .bulk .textbtn { font-family: var(--vscode-font-family); font-size: 11px; color: var(--muted); }
  .bulk .textbtn:hover { color: var(--vscode-foreground); }
  .menuwrap { position: relative; min-width: 0; }
  #filterBtn { position: relative; }
  .dot { display: none; position: absolute; top: 4px; right: 4px; width: 6px; height: 6px; border-radius: 50% !important; background: var(--vscode-focusBorder); }
  .dot.on { display: block; }
  .menu { display: none; position: absolute; top: 100%; left: 0; z-index: 5; min-width: 190px; padding: 4px 0; margin-top: 2px; background: var(--vscode-menu-background, var(--vscode-editorWidget-background)); color: var(--vscode-menu-foreground, var(--vscode-foreground)); border: 1px solid var(--vscode-menu-border, var(--border)); box-shadow: 0 2px 8px var(--vscode-widget-shadow, rgba(0,0,0,.3)); font-family: var(--vscode-font-family); font-size: 12px; }
  .menu.right { left: auto; right: 0; }
  .menu.open { display: block; }
  .menu button { display: flex; align-items: center; gap: 6px; width: 100%; border: none; background: none; padding: 4px 10px 4px 6px; text-align: left; color: inherit; white-space: nowrap; }
  .menu button:hover { background: var(--vscode-menu-selectionBackground, var(--vscode-list-hoverBackground)); color: var(--vscode-menu-selectionForeground, inherit); }
  .menu .mark { width: 16px; flex: none; }
  .menu .n { margin-left: auto; padding-left: 12px; color: var(--muted); }
  .menu .sep { height: 1px; margin: 4px 0; background: var(--vscode-menu-separatorBackground, var(--border)); }
  .menu .label { padding: 4px 10px 2px 28px; color: var(--muted); font-size: 11px; }

  .card { position: relative; margin: 12px 0; padding: 10px 12px 12px; border: 1px solid var(--border); border-left: 3px solid var(--accent); background: var(--vscode-editor-background); }
  .card.current { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .k-addition { --accent: var(--add); } .k-deletion { --accent: var(--del); } .k-edit { --accent: var(--edit); }
  .k-rewrite { --accent: var(--edit); } .k-note { --accent: var(--note); } .k-move { --accent: #9b7be0; }
  .head { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 24px; }
  .title { flex: 1; min-width: 0; }
  .kind { display: flex; align-items: center; gap: 6px; font-family: var(--vscode-font-family); font-size: 11px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: var(--accent); }
  .kind svg { flex: none; }
  .where { margin-top: 4px; cursor: pointer; }
  .where:hover { color: var(--vscode-textLink-foreground); }
  .tools { display: flex; gap: 0; flex: none; }
  .icon { width: 24px; height: 24px; display: inline-flex; align-items: center; justify-content: center; border: none; background: none; color: var(--muted); }
  .icon:hover { background: var(--vscode-toolbar-hoverBackground); color: var(--vscode-foreground); }
  .icon.accept:hover { color: var(--add); } .icon.reject:hover { color: var(--del); }

  .section-label { margin: 10px 0 2px; font-family: var(--vscode-font-family); font-size: 10px; font-weight: 600; letter-spacing: .1em; text-transform: uppercase; color: var(--muted); }
  .body { margin-top: 8px; line-height: 1.55; white-space: pre-wrap; word-break: break-word; cursor: pointer; }
  .section-label + .body { margin-top: 0; }
  .body.before { color: var(--muted); }
  .body.clamped { max-height: 7.8em; overflow: hidden; -webkit-mask-image: linear-gradient(#000 55%, transparent); mask-image: linear-gradient(#000 55%, transparent); }
  .link-row { display: grid; grid-template-columns: 20px 1fr; gap: 4px; align-items: start; width: 100%; margin-top: 8px; padding: 2px 0; text-align: left; font-family: var(--vscode-font-family); font-size: 11px; line-height: 1.4; }
  .link-row svg { margin: 1px 0 0 4px; }
  .more { margin-top: 2px; padding-left: 0; font-family: var(--vscode-font-family); font-size: 11px; }
  ins { background: var(--add-bg); text-decoration: none; }
  del { background: var(--del-bg); color: var(--del); text-decoration: line-through; text-decoration-thickness: 1px; }
  mark { background: var(--note-bg); color: inherit; border-bottom: 1px solid var(--note); }
  blockquote { margin: 8px 0 0; padding: 3px 8px; border-left: 2px solid var(--note); background: var(--note-bg); white-space: pre-wrap; word-break: break-word; cursor: pointer; }

  .change { margin: 8px 0 2px 6px; padding: 6px 8px 8px; border: 1px solid var(--border); border-left: 3px solid var(--accent); background: var(--vscode-sideBar-background); font-size: .92em; }
  .change .kind { font-size: 10px; }
  .change .body { line-height: 1.45; }
  .thread.lead blockquote { margin: 0 0 2px; }
  .change-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .thread { margin-top: 10px; padding-top: 6px; border-top: 1px solid var(--border); }
  .thread.lead { margin-top: 8px; padding-top: 0; border-top: none; }
  .thread.resolved { opacity: .6; }
  .thread blockquote { margin: 2px 0 6px; font-size: .95em; }
  .msg { margin: 6px 0; padding: 2px 0 2px 9px; border-left: 2px solid var(--note); }
  .msg.agent { border-left-color: var(--edit); }
  .msg .who { font-family: var(--vscode-font-family); font-size: 12px; font-weight: 700; color: var(--note); }
  .msg.agent .who { color: var(--edit); }
  .msg .when { font-family: var(--vscode-font-family); font-size: 11px; color: var(--muted); margin-left: 6px; }
  .msg .text { white-space: pre-wrap; word-break: break-word; margin-top: 1px; line-height: 1.45; }
  .thread-actions { display: flex; gap: 4px; margin-left: -6px; font-family: var(--vscode-font-family); font-size: 11px; }
  .gone { margin-top: 4px; font-style: italic; color: var(--muted); }

  .composer { margin-top: 8px; }
  textarea { width: 100%; box-sizing: border-box; min-height: 56px; font: inherit; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--border)); padding: 6px; resize: vertical; }
  textarea:focus { outline: 1px solid var(--vscode-focusBorder); }
  .composer .row { display: flex; gap: 6px; justify-content: flex-end; margin-top: 6px; }
  .primary, .secondary { border: none; padding: 3px 12px; font-family: var(--vscode-font-family); font-size: 12px; }
  .primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  .primary:hover { background: var(--vscode-button-hoverBackground); }
  .secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
  .empty { margin-top: 24px; color: var(--muted); line-height: 1.5; font-style: italic; }
</style>
</head>
<body>
<header>
  <div class="top">
    <div class="menuwrap">
      <button class="file" id="file"></button>
      <div class="menu" id="fileMenu"></div>
    </div>
    <div class="menuwrap">
      <button class="icon" id="filterBtn" title="Filter">${icon('filter')}<span class="dot" id="filterDot"></span></button>
      <div class="menu right" id="filterMenu"></div>
    </div>
  </div>
  <div class="sub">
    <div class="status" id="status"></div>
    <div class="bulk">
      <button class="textbtn" id="acceptAll" title="Accept every suggestion in this file">${icon('check')}Accept all</button>
      <button class="textbtn" id="undoAll" title="Reject every suggestion in this file">${icon('close')}Reject all</button>
    </div>
  </div>
</header>
<div id="cards"></div>
<script nonce="${n}">
const vscode = acquireVsCodeApi();
const ICON = ${JSON.stringify(Object.fromEntries(Object.keys(ICONS).map(k => [k, icon(k)])))};
let state = { cards: [] };
let compose = null;           // { anchor, quote, line } for a new comment on text
const drafts = {};            // textarea contents by key, kept across re-renders
const expanded = new Set();   // cards whose long text is shown in full
let focusKey = null;
const saved = vscode.getState() || {};
let filter = saved.filter || 'all';
const send = (cmd, extra) => vscode.postMessage(Object.assign({ cmd }, extra));
let showResolvedOn = !!saved.showResolved;
const remember = () => vscode.setState({ filter, showResolved: showResolvedOn });

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function iconButton(name, tip, cls, fn) {
  const b = el('button', 'icon ' + (cls || ''));
  b.innerHTML = ICON[name];
  b.title = tip;
  b.setAttribute('aria-label', tip);
  b.onclick = e => { e.stopPropagation(); fn(); };
  return b;
}
function textButton(name, label, fn) {
  const b = el('button', 'textbtn');
  if (name) b.innerHTML = ICON[name];
  b.appendChild(document.createTextNode(label));
  b.onclick = e => { e.stopPropagation(); fn(); };
  return b;
}
function ago(iso) {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (!isFinite(s)) return '';
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}

document.getElementById('acceptAll').onclick = () => send('acceptAll');
document.getElementById('undoAll').onclick = () => send('undoAll');
// Small drop-down menus: one open at a time, closed by clicking elsewhere.
function toggleMenu(id) {
  const m = document.getElementById(id);
  const opening = !m.classList.contains('open');
  document.querySelectorAll('.menu.open').forEach(x => x.classList.remove('open'));
  if (opening) m.classList.add('open');
}
document.addEventListener('click', e => { if (!e.target.closest('.menuwrap')) document.querySelectorAll('.menu.open').forEach(x => x.classList.remove('open')); });
function menuItem(menu, label, checked, onclick, count) {
  const b = el('button');
  const mark = el('span', 'mark');
  if (checked) mark.innerHTML = ICON.tick;
  b.appendChild(mark);
  b.appendChild(el('span', '', label));
  if (count !== undefined) b.appendChild(el('span', 'n', String(count)));
  b.onclick = e => { e.stopPropagation(); document.querySelectorAll('.menu.open').forEach(x => x.classList.remove('open')); onclick(); };
  menu.appendChild(b);
}
document.getElementById('filterBtn').onclick = e => { e.stopPropagation(); toggleMenu('filterMenu'); };
document.getElementById('file').onclick = e => { e.stopPropagation(); if (!e.currentTarget.disabled) toggleMenu('fileMenu'); };

function segments(parent, segs) {
  for (const s of segs) parent.appendChild(s.t === 'eq' ? document.createTextNode(s.s) : el(s.t, '', s.s));
}

// Long text is clamped to a few lines with a "Show more" link.
function body(card, key, cls, segs, onclick) {
  const b = el('div', 'body ' + cls);
  segments(b, segs);
  b.onclick = onclick;
  card.appendChild(b);
  if (expanded.has(key)) {
    card.appendChild(textButton(null, 'Show less', () => { expanded.delete(key); render(); })).classList.add('more');
  } else {
    b.classList.add('clamped');
    requestAnimationFrame(() => {
      if (b.scrollHeight <= b.clientHeight + 4) { b.classList.remove('clamped'); return; }
      const m = textButton(null, 'Show more', () => { expanded.add(key); render(); });
      m.classList.add('more');
      b.after(m);
    });
  }
}

function composer(key, placeholder, onSubmit, onCancel) {
  const wrap = el('div', 'composer');
  const ta = el('textarea');
  ta.placeholder = placeholder + '  (Ctrl+Enter to post)';
  ta.dataset.key = key;
  ta.value = drafts[key] || '';
  ta.oninput = () => { drafts[key] = ta.value; };
  const submit = () => { if (ta.value.trim()) { delete drafts[key]; onSubmit(ta.value.trim()); } };
  ta.onkeydown = e => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); }
    if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
  };
  wrap.appendChild(ta);
  const row = el('div', 'row');
  const cancel = el('button', 'secondary', 'Cancel'); cancel.onclick = onCancel; row.appendChild(cancel);
  const post = el('button', 'primary', 'Comment'); post.onclick = submit; row.appendChild(post);
  wrap.appendChild(row);
  return wrap;
}

// A thread; insert = { at, el } puts el after message number at (-1: before them all).
function thread(note, quote, insert, lead) {
  const t = el('div', 'thread' + (note.status === 'resolved' ? ' resolved' : '') + (lead ? ' lead' : ''));
  if (quote) t.appendChild(el('blockquote', '', quote));
  if (insert && insert.at < 0) t.appendChild(insert.el);
  note.messages.forEach((m, i) => {
    const agent = m.from === 'agent';
    const row = el('div', 'msg ' + (agent ? 'agent' : 'user'));
    const who = el('div');
    who.appendChild(el('span', 'who', agent ? 'Agent' : 'You'));
    if (m.at) who.appendChild(el('span', 'when', ago(m.at)));
    row.appendChild(who);
    row.appendChild(el('div', 'text', m.text));
    // A change the agent made in answer sits inside its reply.
    if (insert && insert.at === i) row.appendChild(insert.el);
    t.appendChild(row);
  });
  if (note.gone) t.appendChild(el('div', 'gone', note.gone));
  const key = 'reply:' + note.id;
  if (note.status === 'resolved') {
    const a = el('div', 'thread-actions');
    a.appendChild(textButton('reopen', 'Reopen', () => send('reopen', { id: note.id })));
    t.appendChild(a);
  } else if (drafts[key] !== undefined) {
    t.appendChild(composer(key, 'Reply…', text => send('reply', { id: note.id, text }), () => { delete drafts[key]; render(); }));
  } else {
    const a = el('div', 'thread-actions');
    a.appendChild(textButton('reply', 'Reply', () => { drafts[key] = ''; focusKey = key; render(); }));
    // With a change still pending, resolving the comment means taking the change.
    if (insert && insert.change) a.appendChild(textButton('resolve', 'Accept & resolve', () => send('accept', { arg: { ...insert.change.arg, resolve: true } })));
    else a.appendChild(textButton('resolve', 'Resolve', () => send('resolve', { id: note.id })));
    t.appendChild(a);
  }
  return t;
}

const KIND_ICON = { addition: 'addition', deletion: 'deletion', edit: 'edited', rewrite: 'rewrite', note: 'note', move: 'move' };

function header(card, c, tools) {
  const head = el('div', 'head');
  const title = el('div', 'title');
  const kind = el('div', 'kind');
  kind.innerHTML = ICON[KIND_ICON[c.kind]];
  kind.appendChild(document.createTextNode(c.label));
  title.appendChild(kind);
  const where = el('div', 'where meta', [c.section, 'line ' + c.line].filter(Boolean).join('  ·  '));
  where.title = 'Go to line ' + c.line;
  where.onclick = () => send('reveal', { offset: c.offset });
  head.appendChild(title);
  if (tools) head.appendChild(tools);
  card.appendChild(head);
  card.appendChild(where);
}

// A suggestion shown inside a comment's thread: the change it makes, with its own buttons.
function changeBox(c) {
  const box = el('div', 'change k-' + c.kind);
  const go = () => send('reveal', { offset: c.offset });
  const head = el('div', 'change-head');
  const kind = el('div', 'kind');
  kind.innerHTML = ICON[KIND_ICON[c.kind]];
  kind.appendChild(document.createTextNode(c.label));
  head.appendChild(kind);
  const tools = el('div', 'tools');
  tools.appendChild(iconButton('check', 'Accept', 'accept', () => send('accept', { arg: c.arg })));
  tools.appendChild(iconButton('close', 'Reject', 'reject', () => send('undo', { arg: c.arg })));
  if (c.kind === 'rewrite') tools.appendChild(iconButton('compare', 'Compare old and new paragraph (opens beside the editor)', '', () => send('compare', { arg: c.arg })));
  head.appendChild(tools);
  box.appendChild(head);
  const where = el('div', 'where meta', 'line ' + c.line);
  where.onclick = go;
  box.appendChild(where);
  if (c.old) {
    box.appendChild(el('div', 'section-label', 'Before'));
    body(box, c.key + ':old', 'before', c.old, go);
    box.appendChild(el('div', 'section-label', 'After'));
  }
  if (c.segs) body(box, c.key, '', c.segs, go);
  return box;
}

function render() {
  const s = state;
  const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');
  // The file name; when other files of the paper have pending work, it opens a list of them.
  const file = document.getElementById('file');
  const others = (s.files || []).filter(f => !f.current && (f.suggestions || f.comments));
  file.textContent = s.file ? s.file.split('/').pop() : 'Open a reviewed .tex file';
  file.title = s.file || '';
  file.disabled = !others.length;
  if (others.length) file.insertAdjacentHTML('beforeend', ICON.chevron);
  const fileMenu = document.getElementById('fileMenu');
  fileMenu.textContent = '';
  if (others.length) {
    fileMenu.appendChild(el('div', 'label', 'Other files with pending work'));
    for (const f of others) {
      menuItem(fileMenu, f.rel.split('/').pop(), false, () => send('open', { path: f.path }),
        [f.suggestions && f.suggestions + ' sugg.', f.comments && f.comments + ' comm.'].filter(Boolean).join(' · '));
    }
  }
  const status = document.getElementById('status');
  status.textContent = '';
  if (s.file) {
    for (const [ic, n, w] of [['edited', s.suggestions || 0, 'suggestion'], ['comment', s.openNotes || 0, 'open comment']]) {
      const span = el('span', 'stat');
      span.innerHTML = ICON[ic];
      span.appendChild(document.createTextNode(String(n)));
      span.title = plural(n, w);
      status.appendChild(span);
    }
  }
  // The filter menu: what to show, and whether resolved comments are included.
  const filterMenu = document.getElementById('filterMenu');
  filterMenu.textContent = '';
  for (const [f, label] of [['all', 'All'], ['suggestions', 'Suggestions'], ['comments', 'Comments']]) {
    menuItem(filterMenu, label, filter === f, () => { filter = f; remember(); render(); });
  }
  filterMenu.appendChild(el('div', 'sep'));
  menuItem(filterMenu, 'Show resolved comments', showResolvedOn, () => { showResolvedOn = !showResolvedOn; remember(); render(); });
  document.getElementById('filterDot').classList.toggle('on', filter !== 'all' || showResolvedOn);
  document.getElementById('filterBtn').title = 'Filter: ' + { all: 'all', suggestions: 'suggestions', comments: 'comments' }[filter] + (showResolvedOn ? ', with resolved comments' : '');

  const root = document.getElementById('cards');
  root.textContent = '';
  if (compose) {
    const c = el('div', 'card k-note current');
    header(c, { kind: 'note', label: 'New comment', line: compose.line, section: compose.section, offset: compose.anchor.offset });
    if (compose.quote) c.appendChild(el('blockquote', '', compose.quote));
    c.appendChild(composer('compose', 'Write a comment…', text => { send('addNote', { anchor: compose.anchor, text }); compose = null; render(); },
      () => { compose = null; delete drafts.compose; render(); }));
    root.appendChild(c);
  }
  const open = n => n.status !== 'resolved' || showResolvedOn;
  // In the Suggestions view every change is a plain suggestion card, without threads; a change
  // that answers a comment links back to it.
  const asSuggestion = c => ({ ...c.change, notes: [], replyTo: { key: c.key, text: (c.notes[0] && c.notes[0].messages[0] || {}).text || '' } });
  const shown = filter === 'suggestions'
    ? s.cards.filter(c => c.kind !== 'note' || c.change).map(c => c.kind === 'note' ? asSuggestion(c) : { ...c, commentCount: c.notes.filter(open).length, notes: [] })
    : s.cards.filter(c => filter === 'comments' || c.kind === 'note' ? c.notes.some(open) : true);
  if (!shown.length && !compose && s.file) {
    root.appendChild(el('div', 'empty', filter === 'comments'
      ? 'No comments. Select text and press Alt+M to comment on it, or use the comment button on a suggestion.'
      : 'Nothing to review: no suggestions or open comments in this file.'));
  }
  for (const c of shown) {
    const card = el('div', 'card k-' + c.kind + (c.key === s.current ? ' current' : ''));
    card.dataset.key = c.key;
    const go = () => send('reveal', { offset: c.offset });
    let tools = null;
    if (c.arg) {
      tools = el('div', 'tools');
      tools.appendChild(iconButton('check', 'Accept', 'accept', () => send('accept', { arg: c.arg })));
      tools.appendChild(iconButton('close', 'Reject', 'reject', () => send('undo', { arg: c.arg })));
      tools.appendChild(iconButton('comment', 'Comment', '', () => {
        const k = 'comment:' + c.key;
        if (drafts[k] === undefined) drafts[k] = '';
        focusKey = k; render();
      }));
      if (c.kind === 'rewrite') tools.appendChild(iconButton('compare', 'Compare old and new paragraph (opens beside the editor)', '', () => send('compare', { arg: c.arg })));
    }
    header(card, c, tools);
    if (c.old) {
      card.appendChild(el('div', 'section-label', 'Before'));
      body(card, c.key + ':old', 'before', c.old, go);
      card.appendChild(el('div', 'section-label', 'After'));
    }
    if (c.segs) body(card, c.key, '', c.segs, go);
    c.notes.forEach((n, i) => {
      if (!open(n)) return;
      const insert = i === 0 && c.change ? { at: c.changeAfter, el: changeBox(c.change), change: c.change } : null;
      const lead = c.kind === 'note' && i === 0;
      const t = thread(n, lead ? c.quote : c.kind !== 'note' ? n.quote : null, insert, lead);
      const q = t.querySelector('blockquote');
      if (q) q.onclick = go;
      card.appendChild(t);
    });
    // Links from the Suggestions view back to the conversation.
    const toThread = (label, key) => {
      const b = textButton('comment', '', () => { filter = 'all'; remember(); state.current = key; render();
        const cur = document.querySelector('.card[data-key="' + CSS.escape(key) + '"]'); if (cur) cur.scrollIntoView({ block: 'center' }); });
      b.classList.add('link-row');
      b.appendChild(el('span', '', label));
      card.appendChild(b);
    };
    if (c.replyTo) toThread('In reply to: ' + (c.replyTo.text.length > 70 ? c.replyTo.text.slice(0, 70) + '…' : c.replyTo.text), c.replyTo.key);
    if (c.commentCount) toThread(c.commentCount + ' comment' + (c.commentCount > 1 ? 's' : ''), c.key);
    if (c.answeredIn) card.appendChild(el('div', 'gone', 'Answered by the change shown with another comment on this text.'));
    const ck = 'comment:' + c.key;
    if (c.arg && drafts[ck] !== undefined) {
      card.appendChild(composer(ck, 'Comment on this suggestion…', text => send('addNote', { proposal: c.arg, text }),
        () => { delete drafts[ck]; render(); }));
    }
    root.appendChild(card);
  }
  if (focusKey) {
    const ta = document.querySelector('textarea[data-key="' + CSS.escape(focusKey) + '"]');
    if (ta) { ta.focus(); ta.scrollIntoView({ block: 'nearest' }); }
    focusKey = null;
  }
}

const typing = () => document.activeElement && document.activeElement.matches('textarea');
let pendingRender = false;
window.addEventListener('message', e => {
  const m = e.data;
  if (m.type === 'state') {
    state = m.state;
    if (typing()) pendingRender = true; else render();
  }
  if (m.type === 'cursor') {
    state.current = m.key;
    document.querySelectorAll('.card.current').forEach(c => { if (!compose || !c.classList.contains('k-note')) c.classList.remove('current'); });
    const cur = m.key && document.querySelector('.card[data-key="' + CSS.escape(m.key) + '"]');
    if (cur) { cur.classList.add('current'); if (!typing()) cur.scrollIntoView({ block: 'nearest' }); }
  }
  if (m.type === 'focus') {
    state.current = m.key;
    if (filter !== 'all') { filter = 'all'; remember(); }
    render();
    const cur = document.querySelector('.card[data-key="' + CSS.escape(m.key) + '"]');
    if (cur) cur.scrollIntoView({ block: 'center' });
  }
  if (m.type === 'commentOn') {
    const k = 'comment:' + m.key;
    if (drafts[k] === undefined) drafts[k] = '';
    if (filter === 'comments') filter = 'all';
    focusKey = k;
    render();
  }
  if (m.type === 'compose') { compose = m.compose; drafts.compose = ''; focusKey = 'compose'; render(); window.scrollTo(0, 0); }
});
// Re-render once typing stops if a refresh arrived meanwhile.
document.addEventListener('focusout', () => setTimeout(() => {
  if (pendingRender && !typing()) { pendingRender = false; render(); }
}, 0));
send('ready');
</script>
</body>
</html>`;
}

module.exports = { ReviewPanel };
