'use strict';
// Inline review of proposed edits to a .tex file. The accepted text lives in
// .review/<name> next to the file; whatever differs from it is a proposal.
// Small edits are shown inline: green new text (editable) and red ghost text for
// what was removed. Rewrites with long removed text are shown in the review view,
// VS Code's diff editor against a virtual baseline that already contains the small
// edits, so only the rewrites appear there as old-above-new blocks.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { computeRegions, acceptChanges, workToBase } = require('./core/diff');
const notes = require('./core/notes');
const project = require('./core/project');
const { pending, startOf, isRewrite, removedText, wordCount, plural, describe, sectionAt, placeNotes, whyOf } = require('./core/suggestions');
const { ReviewPanel } = require('./panel');

const states = new Map(); // uri string -> { basePath, base, regions, baseDirty, ownWrite, notesPath, notes }

const insertedDeco = vscode.window.createTextEditorDecorationType({
  backgroundColor: 'rgba(46, 160, 67, 0.22)',
  overviewRulerColor: 'rgba(46, 160, 67, 0.9)',
  overviewRulerLane: vscode.OverviewRulerLane.Left,
  // OpenOpen: text typed at either edge of a suggestion is not drawn as part of it.
  rangeBehavior: vscode.DecorationRangeBehavior.OpenOpen,
});
const deletedDeco = vscode.window.createTextEditorDecorationType({
  overviewRulerColor: 'rgba(215, 58, 73, 0.9)',
  overviewRulerLane: vscode.OverviewRulerLane.Right,
  rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
});

// A paragraph that moved here: a faint violet background, so it reads as moved, not new.
const movedDeco = vscode.window.createTextEditorDecorationType({
  backgroundColor: 'rgba(150, 110, 230, 0.10)',
  isWholeLine: true,
  overviewRulerColor: 'rgba(150, 110, 230, 0.9)',
  overviewRulerLane: vscode.OverviewRulerLane.Left,
});

// Text with an open note on it.
const noteDeco = vscode.window.createTextEditorDecorationType({
  backgroundColor: 'rgba(255, 196, 0, 0.22)',
  borderWidth: '0 0 2px 0',
  borderStyle: 'solid',
  borderColor: 'rgba(230, 170, 0, 0.9)',
  overviewRulerColor: 'rgba(230, 170, 0, 0.9)',
  overviewRulerLane: vscode.OverviewRulerLane.Center,
  rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
});


function stateFor(doc) {
  if (doc.uri.scheme !== 'file' || !/\.tex$/.test(doc.uri.fsPath)) return undefined;
  const key = doc.uri.toString();
  let st = states.get(key);
  if (!st) {
    const where = project.locate(doc.uri.fsPath);
    if (!where) return undefined;
    const { basePath, notesPath, root, rel } = where;
    st = { basePath, notesPath, root, rel, base: fs.readFileSync(basePath, 'utf8'), regions: [], baseDirty: false };
    st.notes = notes.load(notesPath) || [];
    states.set(key, st);
    recompute(doc, st);
    log.appendLine(`tracking ${doc.uri.fsPath}: ${st.regions.length} proposed changes (baseline ${basePath})`);
  }
  return st;
}

function recompute(doc, st) {
  st.work = doc.getText();
  st.regions = computeRegions(st.base, st.work);
  st.version = doc.version;
}

function writeNotes(st) {
  fs.mkdirSync(path.dirname(st.notesPath), { recursive: true });
  st.notesOwnWrite = notes.serialize(st.notes);
  fs.writeFileSync(st.notesPath, st.notesOwnWrite);
}

// Change the notes starting from what is on disk now, so a reply the agent has just written is
// never overwritten by an older copy. Returns false (and changes nothing) if the file is not
// valid JSON, e.g. while the agent is halfway through writing it.
function editNotes(st, change) {
  const current = notes.load(st.notesPath);
  if (current === null) {
    vscode.window.showWarningMessage(`${path.basename(st.notesPath)} is not valid JSON right now, so the comment was not saved. Try again in a moment.`);
    return false;
  }
  st.notes = current;
  change(st.notes);
  writeNotes(st);
  return true;
}

// Record a step in the paper's local history (core/project.js). Failures (e.g. no git) only
// reach the log: the review itself never depends on the history.
function recordStep(st, title, fields) {
  project.record(st.root, title, fields).catch(e => log.appendLine(`history: ${e.message}`));
}

// What a suggestion is, for the history: label, section, word counts and the agent's reason.
function stepFields(st, r, action) {
  const d = describe(st, r);
  return { Action: action, File: st.rel, Section: sectionAt(st, r.workStart), Label: d.label, Summary: d.summary, Why: whyOf(st, r, st.notes) };
}

function writeBase(st) {
  fs.mkdirSync(path.dirname(st.basePath), { recursive: true });
  st.ownWrite = st.base;
  fs.writeFileSync(st.basePath, st.base);
  st.baseDirty = false;
}

// ---------- display ----------

const changesOf = st => st.regions.flatMap(r => r.changes);

const log = vscode.window.createOutputChannel('Mâché');

// ---------- review view ----------

// The left side of the review view: the baseline with every small edit already
// applied, so the diff editor shows only the rewrites.
const BASE_SCHEME = 'mache-base';
const baseUri = fileUri => fileUri.with({ scheme: BASE_SCHEME });
const baseEmitter = new vscode.EventEmitter();

function shownBase(st) {
  const small = st.regions.filter(r => !isRewrite(st, r)).flatMap(r => r.changes);
  return acceptChanges(st.base, st.work, small);
}

const baseProvider = {
  onDidChange: baseEmitter.event,
  provideTextDocumentContent(uri) {
    const fileUri = uri.with({ scheme: 'file' });
    const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === fileUri.toString());
    const st = doc && stateFor(doc);
    if (st) {
      if (st.version !== doc.version) recompute(doc, st);
      st.shown = shownBase(st);
      return st.shown;
    }
    const where = project.locate(fileUri.fsPath);
    return where ? fs.readFileSync(where.basePath, 'utf8') : '';
  },
};

// Whether this editor is the right-hand (file) side of an open review view. VS Code gives the
// editors inside a diff view no viewColumn, which tells them apart from a normal editor on the file.
function inReview(editor) {
  if (editor.viewColumn !== undefined) return false;
  const uri = editor.document.uri.toString();
  return vscode.window.tabGroups.all.some(g => {
    const input = g.activeTab && g.activeTab.input;
    return input instanceof vscode.TabInputTextDiff && input.original.scheme === BASE_SCHEME && input.modified.toString() === uri;
  });
}

async function openReview(arg) {
  let doc;
  if (arg && arg.uri) doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(arg.uri));
  else doc = vscode.window.activeTextEditor && vscode.window.activeTextEditor.document;
  if (doc && doc.uri.scheme === BASE_SCHEME) doc = await vscode.workspace.openTextDocument(doc.uri.with({ scheme: 'file' }));
  if (!doc || !stateFor(doc)) return;
  const ed = vscode.window.activeTextEditor;
  const offset = arg && arg.workStart !== undefined ? arg.workStart
    : ed && ed.document === doc ? doc.offsetAt(ed.selection.active) : 0;
  const p = doc.positionAt(offset);
  // Beside the source, or in the group where this file's review view is already open.
  const open = vscode.window.tabGroups.all.find(g => g.tabs.some(tab => tab.input instanceof vscode.TabInputTextDiff &&
    tab.input.original.scheme === BASE_SCHEME && tab.input.modified.toString() === doc.uri.toString()));
  await vscode.commands.executeCommand('vscode.diff', baseUri(doc.uri), doc.uri, `${path.basename(doc.fileName)} (review)`,
    { preview: false, selection: new vscode.Range(p, p), viewColumn: open ? open.viewColumn : vscode.ViewColumn.Beside });
}

// The changes marked inline in this editor. A rewrite is shown phrase by phrase, like a small
// edit, except in the review view, where the diff editor shows it.
function shownChanges(editor, st) {
  const review = editor === 'review' || (editor && inReview(editor));
  return st.regions.flatMap(r => {
    // A move is shown at its new place, with its wording changes against the original.
    if (r.move) return r.move.role === 'to' ? r.moveChanges.map(c => ({ c, at: c.workStart })) : [];
    const rewrite = isRewrite(st, r);
    if (rewrite && review) return [];
    return (rewrite ? r.phrases : r.changes).map(c => ({ c, at: c.workStart }));
  });
}

// Removed text is shown as inlay hints: unlike decoration text, VS Code wraps lines around
// them, so long removed text wraps instead of pushing the line's own text out of view.
// VS Code turns spaces in a hint into non-breaking spaces, which it never wraps at, so the
// extension adds U+00A0 to editor.wordWrapBreakAfterCharacters for LaTeX (package.json).
// Their colour comes from editorInlayHint.* in the workspace's colour customizations, and
// editor.inlayHints.maximumLength: 0 stops VS Code shortening them. (Inlay hints cannot be
// struck through; combining strike characters render as dashes in most editor fonts.)
const hintEmitter = new vscode.EventEmitter();
const START_MAX = 40; // removed text shown at the start of a line is cut to this length
// Whether removed text at this offset is shown as a one-row summary (see below).
function shortened(doc, at, old) {
  const pos = doc.positionAt(at);
  return pos.character === 0 && !/^\s/.test(doc.lineAt(pos.line).text) && old.replace(/\s*\n\s*/g, ' ¶ ').length > START_MAX;
}
const deletionHints = {
  onDidChangeInlayHints: hintEmitter.event,
  provideInlayHints(doc, range) {
    const st = stateFor(doc);
    if (!st) return [];
    if (st.version !== doc.version) recompute(doc, st);
    // Hints belong to the file, not to one editor: while the file's review view is open, the
    // rewrites' removed text is left to it rather than shown again inside the new paragraphs.
    const reviewOpen = vscode.window.visibleTextEditors.some(e => e.document === doc && inReview(e));
    const editor = reviewOpen ? 'review' : undefined;
    const from = doc.offsetAt(range.start), to = doc.offsetAt(range.end);
    return shownChanges(editor, st).filter(({ c, at }) => c.baseEnd > c.baseStart && from <= at && at <= to).map(({ c, at }) => {
      const old = removedText(st, c).replace(/\n+$/, '').replace(/\s*\n\s*/g, ' ¶ ');
      let pos = doc.positionAt(at);
      let label = old;
      // VS Code maps every wrapped row inside text inserted at a line's first column back to
      // that column, so a long hint there repeats the line number on each row and pushes the
      // links above the line onto it. Put it after the line's indentation if there is any,
      // otherwise show a one-row summary instead.
      if (pos.character === 0) {
        const indent = doc.lineAt(pos.line).text.match(/^\s*/)[0].length;
        if (indent) pos = pos.translate(0, indent);
        else if (old.length > START_MAX) label = `${old.slice(0, START_MAX).replace(/\s\S*$/, '')} … (${plural(wordCount(old), 'word')})`;
      }
      const hint = new vscode.InlayHint(pos, label);
      hint.paddingRight = true;
      hint.tooltip = new vscode.MarkdownString().appendMarkdown('**Removed:** ').appendText(old);
      return hint;
    });
  },
};

function render(editor) {
  const doc = editor.document;
  const st = stateFor(doc);
  if (!st) {
    editor.setDecorations(insertedDeco, []);
    editor.setDecorations(deletedDeco, []);
    editor.setDecorations(movedDeco, []);
    editor.setDecorations(noteDeco, []);
    return;
  }
  if (st.version !== doc.version) recompute(doc, st);
  const ins = [];
  const del = [];
  for (const { c, at } of shownChanges(editor, st)) {
    if (c.workEnd > c.workStart) ins.push(new vscode.Range(doc.positionAt(c.workStart), doc.positionAt(c.workEnd)));
    if (c.baseEnd > c.baseStart) del.push(new vscode.Range(doc.positionAt(at), doc.positionAt(at)));
  }
  editor.setDecorations(insertedDeco, ins);
  editor.setDecorations(deletedDeco, del);
  editor.setDecorations(movedDeco, st.regions.filter(r => r.move && r.move.role === 'to')
    .map(r => new vscode.Range(doc.positionAt(r.moveSpan.workStart), doc.positionAt(r.moveSpan.workEnd))));
  const open = placedNotes(st).filter(p => p.note.status !== 'resolved');
  editor.setDecorations(noteDeco, open.filter(p => p.range)
    .map(p => new vscode.Range(doc.positionAt(p.range.start), doc.positionAt(p.range.end))));
}

const lensEmitter = new vscode.EventEmitter();
let renderTimer;
function refreshSoon() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(refreshAll, 150);
}
function refreshAll() {
  for (const ed of vscode.window.visibleTextEditors) render(ed);
  lensEmitter.fire();
  hintEmitter.fire();
  updateStatus();
  postPanel();
  // Update open review views whose left side is now out of date.
  for (const doc of vscode.workspace.textDocuments) {
    if (doc.uri.scheme !== BASE_SCHEME) continue;
    const file = vscode.workspace.textDocuments.find(d => d.uri.toString() === doc.uri.with({ scheme: 'file' }).toString());
    const st = file && stateFor(file);
    if (!st) continue;
    if (st.version !== file.version) recompute(file, st);
    if (shownBase(st) !== st.shown) baseEmitter.fire(doc.uri);
  }
}

const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
status.command = 'mache.showPanel';
const modeStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 49);
modeStatus.command = 'mache.toggleReviewMode';
function updateStatus() {
  const ed = vscode.window.activeTextEditor;
  const st = ed && stateFor(ed.document);
  vscode.commands.executeCommand('setContext', 'mache.tracked', !!st);
  if (st) {
    modeStatus.text = reviewMode ? '$(eye) Review mode: on' : '$(eye-closed) Review mode: off';
    modeStatus.backgroundColor = reviewMode ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    modeStatus.tooltip = reviewMode
      ? 'Review mode is on: what you type shows as suggestions, to accept or reject later. Click to turn it off.'
      : 'Review mode is off: what you type is a normal edit. Click to turn it on and have your edits show as suggestions.';
    modeStatus.show();
  } else modeStatus.hide();
  if (!st) {
    const tex = ed && /\.tex$/.test(ed.document.fileName) && ed.document.uri.scheme === 'file';
    const paperReviewed = tex && !!project.reviewRoot(ed.document.uri.fsPath);
    vscode.commands.executeCommand('setContext', 'mache.paperReviewed', paperReviewed);
    if (tex && !paperReviewed) {
      status.text = '$(play) Mâché: start reviewing';
      status.tooltip = 'This paper is not under review yet. Click to start: its current text becomes the accepted text, and comments (Alt+M) and suggestions appear.';
      status.command = 'mache.startPaper';
      status.show();
      offerStart(ed.document.uri.fsPath);
    } else if (tex) {
      status.text = '$(circle-slash) not reviewed';
      status.tooltip = 'The paper is under review, but not this file. Click to review this file too.';
      status.command = 'mache.track';
      status.show();
    } else status.hide();
    return;
  }
  status.command = 'mache.showPanel';
  const n = pending(st).length;
  const rewrites = st.regions.filter(r => isRewrite(st, r)).length;
  const open = st.notes.filter(x => x.status !== 'resolved').length;
  status.text = (n ? `$(git-compare) ${plural(n, 'suggestion')}` : '$(check) No suggestions') +
    (open ? `  $(comment) ${open}` : '');
  status.tooltip = `${plural(n, 'suggestion')} (${rewrites} rewritten paragraphs), ${plural(open, 'open note')}. Click to open the review panel.`;
  status.show();
}

const codeLenses = {
  onDidChangeCodeLenses: lensEmitter.event,
  provideCodeLenses(doc) {
    const st = stateFor(doc);
    if (!st || !vscode.workspace.getConfiguration('mache').get('codeLens')) return [];
    if (st.version !== doc.version) recompute(doc, st);
    // A comment on text that no suggestion touches gets a link of its own on its line.
    const placed = placedNotes(st);
    const lines = new Map();
    for (const p of placed) {
      if (!p.range || p.region || p.note.status === 'resolved') continue;
      const line = doc.positionAt(p.range.start).line;
      if (!lines.has(line)) lines.set(line, []);
      lines.get(line).push(p);
    }
    const commentLenses = [...lines].map(([line, ps]) => {
      const first = ps[0].note.messages[0];
      const preview = first ? first.text.replace(/\s+/g, ' ').slice(0, 60) + (first.text.length > 60 ? '…' : '') : '';
      return new vscode.CodeLens(new vscode.Range(line, 0, line, 0), {
        title: `$(comment-discussion)\u2002${ps.length > 1 ? `${ps.length} comments` : `Comment: ${preview}`}`,
        command: 'mache.showPanel', arguments: [{ key: 'note:' + ps[0].note.id }],
      });
    });
    return commentLenses.concat(st.regions.flatMap(r => {
      const pos = doc.positionAt(Math.min(startOf(st, r), doc.getText().length));
      const range = new vscode.Range(pos.line, 0, pos.line, 0);
      const arg = { uri: doc.uri.toString(), scope: 'region', workStart: r.workStart, baseStart: r.baseStart };
      const d = describe(st, r);
      const there = r.move && { offset: startOf(st, r.move.partner) };
      // Where a paragraph moved away from: only a link to where it went.
      if (r.move && r.move.role === 'from') {
        return [new vscode.CodeLens(range, { title: `$(arrow-${there.offset > r.workStart ? 'down' : 'up'})\u2002Paragraph moved to line ${doc.positionAt(there.offset).line + 1}`, command: 'mache.goto', arguments: [there] })];
      }
      const lenses = [
        r.move
          ? new vscode.CodeLens(range, { title: `${d.label} from line ${doc.positionAt(there.offset).line + 1}`, command: 'mache.goto', arguments: [there] })
          : new vscode.CodeLens(range, { title: d.label, command: '' }),
        new vscode.CodeLens(range, { title: '$(check)\u2002Accept', command: 'mache.accept', arguments: [arg] }),
        new vscode.CodeLens(range, { title: '$(close)\u2002Reject', command: 'mache.undo', arguments: [arg] }),
        new vscode.CodeLens(range, { title: '$(comment)\u2002Comment', command: 'mache.commentOn', arguments: [arg] }),
      ];
      if (d.kind === 'rewrite') {
        lenses.push(new vscode.CodeLens(range, { title: '$(diff)\u2002Compare', command: 'mache.openReview', arguments: [arg] }));
      }
      const open = notesOn(st, r).filter(x => x.status !== 'resolved').length;
      if (open) {
        lenses.push(new vscode.CodeLens(range, {
          title: `$(comment-discussion)\u2002${open} comment${open > 1 ? 's' : ''}`, command: 'mache.showPanel', arguments: [{ key: currentCardFor(st, r) }],
        }));
      }
      return lenses;
    }));
  },
};

// Hovering a suggestion only shows what is not already on screen: Accept / Reject for just
// that edit when its paragraph has several, and the full text of a shortened deletion.
const hovers = {
  provideHover(doc, position) {
    const st = stateFor(doc);
    if (!st) return undefined;
    if (st.version !== doc.version) recompute(doc, st);
    const o = doc.offsetAt(position);
    const r = st.regions.find(r => r.changes.some(c => c.workStart <= o && o <= c.workEnd));
    const c = r && r.changes.find(c => c.workStart <= o && o <= c.workEnd);
    const old = c ? removedText(st, c).replace(/\n+$/, '') : '';
    const many = r && r.changes.length > 1;
    const short = old && shortened(doc, c.workStart, old);
    if (!many && !short) return noteHover(doc, st, o);
    const md = new vscode.MarkdownString();
    md.isTrusted = { enabledCommands: ['mache.accept', 'mache.undo'] };
    if (many) {
      const one = encodeURIComponent(JSON.stringify([{ uri: doc.uri.toString(), scope: 'change', workStart: c.workStart, baseStart: c.baseStart }]));
      md.appendMarkdown(`This edit only: [Accept](command:mache.accept?${one}) · [Reject](command:mache.undo?${one})`);
    }
    if (short) md.appendMarkdown(many ? '\n\n**Removed:** ' : '**Removed:** ').appendText(old.replace(/\s*\n\s*/g, ' ¶ '));
    return new vscode.Hover(md, new vscode.Range(doc.positionAt(c.workStart), doc.positionAt(c.workEnd)));
  },
};

// ---------- actions ----------

// Resolve a lens/hover argument, or the cursor, to { doc, st, region, changes }.
async function target(arg) {
  let doc;
  if (arg && arg.uri) doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(arg.uri));
  else doc = vscode.window.activeTextEditor && vscode.window.activeTextEditor.document;
  const st = doc && stateFor(doc);
  if (!st) return undefined;
  recompute(doc, st);
  if (arg && arg.uri) {
    for (const r of st.regions) {
      if (arg.scope === 'region' && r.workStart === arg.workStart && r.baseStart === arg.baseStart) {
        return { doc, st, region: r, changes: r.changes };
      }
      const c = r.changes.find(c => c.workStart === arg.workStart && c.baseStart === arg.baseStart);
      if (arg.scope === 'change' && c) return { doc, st, region: r, changes: [c] };
    }
    vscode.window.showWarningMessage('That proposal changed since it was shown; try again.');
    return undefined;
  }
  // Cursor: the edit under it, else its paragraph.
  const o = doc.offsetAt(vscode.window.activeTextEditor.selection.active);
  for (const r of st.regions) {
    const c = r.changes.find(c => c.workStart <= o && o <= c.workEnd);
    if (c) return { doc, st, region: r, changes: [c] };
  }
  const r = st.regions.find(r => r.workStart <= o && o <= r.workEnd);
  return r ? { doc, st, region: r, changes: r.changes } : undefined;
}

async function accept(arg) {
  const t = await target(arg);
  if (!t) return;
  const fields = stepFields(t.st, t.region, 'accept');
  if (t.changes === t.region.changes) {
    // Accepting a suggestion resolves the comments made on it. A comment it answers stays open
    // (you may still want to reply) unless this is "Accept & resolve".
    const ids = placedNotes(t.st).filter(p => p.note.status !== 'resolved' &&
      ((p.region === t.region && p.note.anchor && p.note.anchor.proposal) || (arg && arg.resolve && p.answer === t.region))).map(p => p.note.id);
    if (ids.length) editNotes(t.st, all => all.forEach(n => { if (ids.includes(n.id)) n.status = 'resolved'; }));
  }
  const whole = t.changes === t.region.changes;
  const changes = whole && t.region.move ? [...t.region.changes, ...t.region.move.partner.changes] : t.changes;
  t.st.base = acceptChanges(t.st.base, t.doc.getText(), changes);
  writeBase(t.st);
  recordStep(t.st, `author: accepted ${fields.Label.toLowerCase()} in ${t.st.rel}${fields.Section ? ` (${fields.Section})` : ''}`, fields);
  recompute(t.doc, t.st);
  refreshAll();
}

async function undo(arg) {
  const t = await target(arg);
  if (!t) return;
  const fields = stepFields(t.st, t.region, 'reject');
  recordStep(t.st, `author: rejected ${fields.Label.toLowerCase()} in ${t.st.rel}${fields.Section ? ` (${fields.Section})` : ''}`, fields);
  const edit = new vscode.WorkspaceEdit();
  const whole = t.changes === t.region.changes;
  const spans = whole ? (t.region.move ? [t.region, t.region.move.partner] : [t.region]) : t.changes;
  for (const c of spans) {
    edit.replace(t.doc.uri,
      new vscode.Range(t.doc.positionAt(c.workStart), t.doc.positionAt(c.workEnd)),
      t.st.base.slice(c.baseStart, c.baseEnd));
  }
  t.st.rejecting = true;
  try { await vscode.workspace.applyEdit(edit); } finally { t.st.rejecting = false; }
}

async function all(kind) {
  const ed = vscode.window.activeTextEditor;
  const st = ed && stateFor(ed.document);
  if (!st) return;
  recompute(ed.document, st);
  if (!pending(st).length) return;
  const verb = kind === 'accept' ? 'Accept' : 'Reject';
  const ok = await vscode.window.showWarningMessage(
    `${verb} all ${plural(pending(st).length, 'suggestion')} in ${path.basename(ed.document.fileName)}?`,
    { modal: true }, verb);
  if (ok !== verb) return;
  for (const r of st.regions) {
    const fields = stepFields(st, r, kind === 'accept' ? 'accept' : 'reject');
    recordStep(st, `author: ${kind === 'accept' ? 'accepted' : 'rejected'} ${fields.Label.toLowerCase()} in ${st.rel}`, fields);
  }
  if (kind === 'accept') {
    st.base = ed.document.getText();
    writeBase(st);
    recompute(ed.document, st);
    refreshAll();
  } else {
    const doc = ed.document;
    const edit = new vscode.WorkspaceEdit();
    edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), st.base);
    st.rejecting = true;
    try { await vscode.workspace.applyEdit(edit); } finally { st.rejecting = false; }
  }
}

function jump(dir) {
  const ed = vscode.window.activeTextEditor;
  const st = ed && stateFor(ed.document);
  if (!st || !st.regions.length) return;
  recompute(ed.document, st);
  const o = ed.document.offsetAt(ed.selection.active);
  const starts = pending(st).map(r => startOf(st, r));
  let s = dir > 0 ? starts.find(x => x > o) : [...starts].reverse().find(x => x < o);
  if (s === undefined) s = dir > 0 ? starts[0] : starts[starts.length - 1];
  const p = ed.document.positionAt(s);
  ed.selection = new vscode.Selection(p, p);
  ed.revealRange(new vscode.Range(p, p), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

// Start reviewing the whole paper the active file belongs to: its main files and what they input.
async function startPaper() {
  const ed = vscode.window.activeTextEditor;
  if (!ed || !/\.tex$/.test(ed.document.fileName)) {
    vscode.window.showInformationMessage('Open a .tex file of the paper first.');
    return;
  }
  await ed.document.save();
  const file = ed.document.uri.fsPath;
  const root = project.newRoot(file);
  const files = [...new Set([...project.candidates(root).map(f => path.join(root, f)), file])];
  const { started, ignored } = project.startPaper(root, files);
  if (started.length) {
    project.record(root, `author: started reviewing ${plural(started.length, 'file')}`, { Action: 'start', Files: started.join(', ') })
      .catch(e => log.appendLine(`history: ${e.message}`));
  }
  refreshAll();
  vscode.window.showInformationMessage(
    `Mâché is reviewing ${plural(started.length, 'file')} in ${path.basename(root)}${ignored ? ` (and added ${ignored} to .gitignore)` : ''}. ` +
    'Select text and press Alt+M to comment; ask your agent to run `mache` in the paper.');
}

// Once per paper and session, a prompt to start, unless the author said not to ask again.
const offered = new Set();
let extContext; // set in activate()
function offerStart(file) {
  const root = project.newRoot(file);
  const never = extContext && extContext.workspaceState.get('mache.neverOffer', []);
  if (offered.has(root) || (never && never.includes(root)) || process.env.MACHE_TEST) return;
  offered.add(root);
  vscode.window.showInformationMessage(`Mâché is not reviewing ${path.basename(root)} yet.`, 'Start reviewing', 'Not now', "Don't ask again")
    .then(choice => {
      if (choice === 'Start reviewing') startPaper();
      else if (choice === "Don't ask again") extContext.workspaceState.update('mache.neverOffer', [...(never || []), root]);
    });
}

async function track() {
  const ed = vscode.window.activeTextEditor;
  if (!ed || !/\.tex$/.test(ed.document.fileName)) return;
  if (project.locate(ed.document.uri.fsPath)) {
    vscode.window.showInformationMessage('This file is already under review.');
    return;
  }
  await ed.document.save();
  const root = project.newRoot(ed.document.uri.fsPath);
  const [rel] = project.start(root, [ed.document.uri.fsPath]);
  project.record(root, `author: started reviewing ${rel}`, { Action: 'start', Files: rel }).catch(e => log.appendLine(`history: ${e.message}`));
  refreshAll();
  vscode.window.showInformationMessage(`Reviewing ${rel}. Its accepted text is in ${path.join(path.relative(path.dirname(ed.document.fileName), root) || '.', project.REVIEW)}/.`);
}

// ---------- notes ----------

// Each note with where it currently sits: a text range, a suggestion, or neither (gone).
const placedNotes = st => placeNotes(st, st.notes);

const notesOn = (st, r) => placedNotes(st).filter(p => p.region === r).map(p => p.note);

function addNote(st, anchor, text, from = 'user') {
  return editNotes(st, all => all.push({ id: notes.nextId(all), status: 'open', anchor, messages: [{ from, text, at: new Date().toISOString() }] }));
}

function noteHover(doc, st, o) {
  const hits = placedNotes(st).filter(p => p.range && p.note.status !== 'resolved' && p.range.start <= o && o <= p.range.end);
  if (!hits.length) return undefined;
  const md = new vscode.MarkdownString();
  md.isTrusted = { enabledCommands: ['mache.showPanel'] };
  for (const { note } of hits) {
    for (const m of note.messages) md.appendMarkdown(`**${m.from === 'agent' ? 'Agent' : 'You'}:** `).appendText(m.text).appendMarkdown('\n\n');
  }
  const key = encodeURIComponent(JSON.stringify([{ key: 'note:' + hits[0].note.id }]));
  md.appendMarkdown(`[Open in the review panel](command:mache.showPanel?${key})`);
  const r = hits[0].range;
  return new vscode.Hover(md, new vscode.Range(doc.positionAt(r.start), doc.positionAt(r.end)));
}

// ---------- review panel ----------

const panel = new ReviewPanel(onPanelMessage);
let panelUri; // the tracked file the panel shows

function panelDoc() {
  const ed = vscode.window.activeTextEditor;
  if (ed && stateFor(ed.document)) panelUri = ed.document.uri.toString();
  const doc = panelUri && vscode.workspace.textDocuments.find(d => d.uri.toString() === panelUri);
  const st = doc && stateFor(doc);
  return st ? { doc, st } : undefined;
}

const cardKey = (st, r) => 'p:' + (st.base.slice(r.baseStart, r.baseEnd).trim().slice(0, 60) || '+' + st.work.slice(r.workStart, r.workEnd).trim().slice(0, 60));
const CONTEXT = 70; // unchanged characters shown around an edit in a card

// Segments [{t: 'eq'|'ins'|'del', s}] for one side of a region, marking the exact changes.
function sideSegments(text, start, end, spans, short = true) {
  const segs = [];
  let at = start;
  for (const [s, e, t] of spans) {
    if (s > at) segs.push({ t: 'eq', s: text.slice(at, s) });
    if (e > s) segs.push({ t, s: text.slice(s, e) });
    at = Math.max(at, e);
  }
  if (end > at) segs.push({ t: 'eq', s: text.slice(at, end) });
  return short ? shorten(trimEnd(segs)) : trimEnd(segs);
}

function trimEnd(segs) {
  const last = segs[segs.length - 1];
  if (last) last.s = last.s.replace(/\n+$/, '');
  return segs.filter(s => s.s);
}

// A small edit's paragraph with the removed text inline, shortened to the edits and some context.
function inlineSegments(st, r) {
  const segs = [];
  let at = r.workStart;
  for (const c of r.phrases) {
    if (c.workStart > at) segs.push({ t: 'eq', s: st.work.slice(at, c.workStart) });
    if (c.baseEnd > c.baseStart) segs.push({ t: 'del', s: st.base.slice(c.baseStart, c.baseEnd) });
    if (c.workEnd > c.workStart) segs.push({ t: 'ins', s: st.work.slice(c.workStart, c.workEnd) });
    at = c.workEnd;
  }
  if (r.workEnd > at) segs.push({ t: 'eq', s: st.work.slice(at, r.workEnd) });
  return shorten(trimEnd(segs));
}

// A moved paragraph as it now reads, with its wording changes against the original marked.
function moveSegments(st, r) {
  const span = r.moveSpan;
  const segs = [];
  let at = span.workStart;
  for (const c of r.moveChanges) {
    if (c.workStart > at) segs.push({ t: 'eq', s: st.work.slice(at, c.workStart) });
    if (c.baseEnd > c.baseStart) segs.push({ t: 'del', s: st.base.slice(c.baseStart, c.baseEnd) });
    if (c.workEnd > c.workStart) segs.push({ t: 'ins', s: st.work.slice(c.workStart, c.workEnd) });
    at = Math.max(at, c.workEnd);
  }
  if (span.workEnd > at) segs.push({ t: 'eq', s: st.work.slice(at, span.workEnd) });
  return segs.filter(s => s.s);
}

// Shorten long unchanged stretches to some context around the changes.
function shorten(out) {
  out.forEach((s, i) => {
    if (s.t !== 'eq') return;
    const first = i === 0, last = i === out.length - 1;
    if (first && s.s.length > CONTEXT) s.s = '… ' + s.s.slice(-CONTEXT).replace(/^\S*\s/, '');
    else if (last && s.s.length > CONTEXT) s.s = s.s.slice(0, CONTEXT).replace(/\s\S*$/, '') + ' …';
    else if (!first && !last && s.s.length > 2 * CONTEXT + 10) {
      s.s = s.s.slice(0, CONTEXT).replace(/\s\S*$/, '') + ' … ' + s.s.slice(-CONTEXT).replace(/^\S*\s/, '');
    }
  });
  return out;
}

function noteView(st, p) {
  const v = { id: p.note.id, status: p.note.status, messages: p.note.messages || [] };
  if (p.range) v.quote = st.work.slice(p.range.start, p.range.end);
  v.onProposal = !!p.range; // a text note shown on a proposal card quotes its text
  if (!p.range && p.region && p.note.anchor && p.note.anchor.quote) {
    v.quote = p.note.anchor.quote;
    v.onProposal = true;
    v.gone = 'The commented text was changed by this suggestion.';
  }
  return v;
}

// The card data for one suggestion: what it is, where, and its text.
function suggestionView(doc, st, r) {
  const d = describe(st, r);
  const view = {
    key: cardKey(st, r), kind: d.kind, label: d.label, summary: d.summary,
    section: sectionAt(st, r.workStart), offset: startOf(st, r), line: doc.positionAt(startOf(st, r)).line + 1,
    arg: { uri: doc.uri.toString(), scope: 'region', workStart: r.workStart, baseStart: r.baseStart },
  };
  const oldText = st.base.slice(r.baseStart, r.baseEnd).trim();
  const newText = st.work.slice(r.workStart, r.workEnd).trim();
  if (r.move) { view.segs = moveSegments(st, r); view.label = `${d.label} ${d.summary}`; }
  else if (d.kind === 'addition' && /paragraph/.test(d.label)) view.segs = [{ t: 'ins', s: newText }];
  else if (d.kind === 'deletion' && /paragraph/.test(d.label)) view.segs = [{ t: 'del', s: oldText }];
  else if (d.kind === 'rewrite') {
    view.old = sideSegments(st.base, r.baseStart, r.baseEnd, r.raw.map(c => [c.baseStart, c.baseEnd, 'del']));
    view.segs = sideSegments(st.work, r.workStart, r.workEnd, r.raw.map(c => [c.workStart, c.workEnd, 'ins']));
  } else view.segs = inlineSegments(st, r);
  return view;
}

// Which comment card each answering suggestion is shown in: the first open comment it answers.
function answeredBy(st, placed) {
  const map = new Map();
  for (const p of placed) {
    if (p.answer && p.note.status !== 'resolved' && !map.has(p.answer)) map.set(p.answer, p);
  }
  return map;
}

function panelState() {
  const pd = panelDoc();
  if (!pd) return { cards: [] };
  const { doc, st } = pd;
  if (st.version !== doc.version) recompute(doc, st);
  const placed = placedNotes(st);
  const answered = answeredBy(st, placed);
  const cards = [];
  // A suggestion nobody asked for is its own card, with the comments on it.
  for (const r of st.regions) {
    if (answered.has(r) || (r.move && r.move.role === 'from')) continue;
    cards.push({ ...suggestionView(doc, st, r), notes: placed.filter(p => p.region === r && !p.answer).map(p => noteView(st, p)) });
  }
  // A comment is its own card; a suggestion that answers it is shown inside its thread.
  for (const p of placed) {
    if (!p.answer && p.region) continue; // on an unprompted suggestion's card
    const proposal = p.note.anchor && p.note.anchor.proposal;
    const r = p.answer && answered.get(p.answer) === p ? p.answer : undefined;
    const offset = r ? r.workStart : p.range ? p.range.start : Math.min((p.note.anchor && p.note.anchor.offset) || 0, st.work.length);
    const v = noteView(st, p);
    v.onProposal = false;
    if (!p.range && !p.answer) {
      v.gone = proposal ? 'That suggestion has since been accepted or rejected.' : 'The commented text has since been changed or removed.';
    }
    if (!p.range && p.answer) delete v.gone;
    const card = {
      key: 'note:' + p.note.id, kind: 'note', offset, line: doc.positionAt(offset).line + 1,
      label: proposal ? 'Comment on a suggestion' : 'Comment', section: sectionAt(st, offset),
      quote: p.range ? st.work.slice(p.range.start, p.range.end) : proposal ? (proposal.new || proposal.old) : p.note.anchor && p.note.anchor.quote,
      changed: !p.range && !proposal,
      notes: [v],
    };
    if (r) {
      card.change = suggestionView(doc, st, r);
      // Where the change goes in the thread: after the reply that made it, else after the last agent reply.
      const msgs = v.messages;
      let at = msgs.map(m => !!(m.change && m.change.proposal)).lastIndexOf(true);
      if (at < 0) at = msgs.map(m => m.from === 'agent').lastIndexOf(true);
      card.changeAfter = at;
      // Comments made on the suggestion itself (e.g. the agent's reason) go with it.
      card.notes.push(...placed.filter(q => q !== p && q.region === r && !q.answer).map(q => noteView(st, q)));
    } else if (p.answer) {
      card.answeredIn = answered.get(p.answer) && 'note:' + answered.get(p.answer).note.id;
    }
    cards.push(card);
  }
  cards.sort((a, b) => a.offset - b.offset);
  const n = pending(st).length;
  const open = st.notes.filter(x => x.status !== 'resolved').length;
  return {
    file: st.rel,
    suggestions: n, openNotes: open,
    reviewMode, cards, current: currentKey(doc, st),
    files: projectFiles(st),
  };
}

// Every file under review in the same paper, with its counts, for the panel's file list.
// Files not open in the editor are read from disk, and cached until they change.
const fileCounts = new Map(); // path -> { stamp, suggestions, comments }
function projectFiles(st) {
  const mtime = p => { try { return fs.statSync(p).mtimeMs; } catch { return 0; } };
  return project.tracked(st.root).map(rel => {
    const p = project.paths(st.root, rel);
    const open = [...states.values()].find(s => s.basePath === p.basePath && s.work !== undefined);
    let counts;
    if (open) {
      counts = { suggestions: pending(open).length, comments: open.notes.filter(x => x.status !== 'resolved').length };
    } else {
      const stamp = `${mtime(p.file)}:${mtime(p.basePath)}:${mtime(p.notesPath)}`;
      const cached = fileCounts.get(p.basePath);
      if (cached && cached.stamp === stamp) counts = cached;
      else {
        const work = readOrNull(p.file), base = readOrNull(p.basePath);
        const list = notes.load(p.notesPath) || [];
        counts = { stamp, suggestions: work !== null && base !== null ? pending({ regions: computeRegions(base, work) }).length : 0,
          comments: list.filter(x => x.status !== 'resolved').length };
        fileCounts.set(p.basePath, counts);
      }
    }
    return { rel, path: p.file, current: rel === st.rel, suggestions: counts.suggestions, comments: counts.comments };
  });
}

function currentKey(doc, st) {
  const ed = vscode.window.visibleTextEditors.find(e => e.document === doc);
  if (!ed) return undefined;
  const o = doc.offsetAt(ed.selection.active);
  const placed = placedNotes(st);
  const r = st.regions.find(r => r.workStart <= o && o <= r.workEnd);
  if (r) {
    const by = answeredBy(st, placed).get(r);
    return by ? 'note:' + by.note.id : cardKey(st, r);
  }
  const p = placed.find(p => p.range && !p.region && p.range.start <= o && o <= p.range.end);
  return p ? 'note:' + p.note.id : undefined;
}

function postPanel() {
  panel.post({ type: 'state', state: panelState() });
}

async function reveal(offset) {
  const pd = panelDoc();
  if (!pd) return;
  const ed = vscode.window.visibleTextEditors.find(e => e.document === pd.doc) ||
    await vscode.window.showTextDocument(pd.doc, { preserveFocus: true });
  const p = pd.doc.positionAt(offset);
  ed.selection = new vscode.Selection(p, p);
  ed.revealRange(new vscode.Range(p, p), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

async function onPanelMessage(m) {
  const pd = panelDoc();
  const st = pd && pd.st;
  const withNote = fn => st && editNotes(st, all => { const n = all.find(x => x.id === m.id); if (n) fn(n); });
  switch (m.cmd) {
    case 'ready': postPanel(); panel.flush(); return;
    case 'accept': await accept(m.arg); return;
    case 'undo': await undo(m.arg); return;
    case 'compare': await openReview(m.arg); return;
    case 'reveal': await reveal(m.offset); return;
    case 'open': await vscode.window.showTextDocument(vscode.Uri.file(m.path)); return;
    case 'toggleMode': await vscode.commands.executeCommand('mache.toggleReviewMode'); postPanel(); return;
    case 'acceptAll': if (pd) { await vscode.window.showTextDocument(pd.doc); await all('accept'); } return;
    case 'undoAll': if (pd) { await vscode.window.showTextDocument(pd.doc); await all('undo'); } return;
    case 'addNote': {
      if (!st) return;
      let anchor = m.anchor;
      if (m.proposal) {
        const t = await target(m.proposal);
        if (!t) return;
        anchor = notes.proposalAnchor(t.st.base, t.st.work, t.region);
      }
      if (addNote(st, anchor, m.text)) recordStep(st, `author: commented in ${st.rel}`, { Action: 'comment', File: st.rel, Quote: anchor.quote, Text: m.text });
      break;
    }
    case 'reply':
      if (withNote(n => n.messages.push({ from: 'user', text: m.text, at: new Date().toISOString() }))) recordStep(st, `author: replied on ${st.rel}#${m.id}`, { Action: 'reply', From: 'user', File: st.rel, Text: m.text });
      break;
    case 'resolve': case 'reopen': {
      let first = '';
      if (withNote(n => { n.status = m.cmd === 'resolve' ? 'resolved' : 'open'; first = n.messages[0] ? n.messages[0].text : ''; })) recordStep(st, `author: ${m.cmd === 'resolve' ? 'resolved' : 'reopened'} ${st.rel}#${m.id}`, { Action: m.cmd, File: st.rel, Comment: first });
      break;
    }
    default: return;
  }
  refreshAll();
}

// The suggestion at the cursor drives the editor title bar buttons and the panel highlight.
function onSelection(e) {
  const doc = e.textEditor.document;
  const st = stateFor(doc);
  if (!st) return;
  if (st.version !== doc.version) recompute(doc, st);
  const o = doc.offsetAt(e.selections[0].active);
  const r = st.regions.find(r => r.workStart <= o && o <= r.workEnd);
  vscode.commands.executeCommand('setContext', 'mache.atSuggestion', !!r);
  vscode.commands.executeCommand('setContext', 'mache.atRewrite', !!r && describe(st, r).kind === 'rewrite');
  if (panelUri === doc.uri.toString()) panel.post({ type: 'cursor', key: currentKey(doc, st) });
}

// Title bar buttons act on the whole suggestion at the cursor.
async function atCursor(fn) {
  const ed = vscode.window.activeTextEditor;
  const st = ed && stateFor(ed.document);
  if (!st) return;
  recompute(ed.document, st);
  const o = ed.document.offsetAt(ed.selection.active);
  const r = st.regions.find(r => r.workStart <= o && o <= r.workEnd);
  if (r) await fn({ uri: ed.document.uri.toString(), scope: 'region', workStart: r.workStart, baseStart: r.baseStart });
}

// Alt+M: a note on the selection, or on the word or proposal at the cursor.
async function noteCommand() {
  const ed = vscode.window.activeTextEditor;
  const st = ed && stateFor(ed.document);
  if (!st) return;
  const doc = ed.document;
  if (st.version !== doc.version) recompute(doc, st);
  let s = doc.offsetAt(ed.selection.start);
  let e = doc.offsetAt(ed.selection.end);
  let anchor;
  if (s === e) {
    const r = st.regions.find(r => r.workStart <= s && s <= r.workEnd);
    if (r) return commentOn({ uri: doc.uri.toString(), scope: 'region', workStart: r.workStart, baseStart: r.baseStart });
    const w = doc.getWordRangeAtPosition(ed.selection.active);
    if (!w) return;
    s = doc.offsetAt(w.start);
    e = doc.offsetAt(w.end);
  }
  anchor = notes.textAnchor(st.work, s, e);
  panelUri = doc.uri.toString();
  await panel.show();
  panel.post({ type: 'compose', compose: { anchor, quote: anchor.quote, line: doc.positionAt(s).line + 1, section: sectionAt(st, s) } });
}

// Open a comment box on a proposal's card.
async function commentOn(arg) {
  const t = await target(arg);
  if (!t) return;
  panelUri = t.doc.uri.toString();
  await panel.show();
  postPanel();
  panel.post({ type: 'commentOn', key: cardKey(t.st, t.region) });
}

async function goto(arg) {
  const ed = vscode.window.activeTextEditor;
  if (!ed || !arg) return;
  const p = ed.document.positionAt(arg.offset);
  ed.selection = new vscode.Selection(p, p);
  ed.revealRange(new vscode.Range(p, p), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

// The panel card a suggestion is shown in: its own, or the comment it answers.
function currentCardFor(st, r) {
  const by = answeredBy(st, placedNotes(st)).get(r);
  return by ? 'note:' + by.note.id : cardKey(st, r);
}

// Open the panel, optionally at a card ({ key }) or at a position ({ workStart }).
async function showPanel(arg) {
  if (arg && arg.workStart !== undefined) await reveal(arg.workStart);
  await panel.show();
  if (arg && arg.key) panel.post({ type: 'focus', key: arg.key });
}

function onNotesFileChange(uri) {
  for (const st of states.values()) {
    if (st.notesPath !== uri.fsPath) continue;
    const text = readOrNull(st.notesPath);
    if (text === null || text === st.notesOwnWrite) continue;
    const loaded = notes.load(st.notesPath);
    if (loaded === null) log.appendLine(`${st.notesPath} is not valid JSON; keeping the last good copy`);
    else st.notes = loaded;
  }
  refreshSoon();
}

// ---------- your own typing ----------

// What you type is a real edit: it goes into the baseline too, so it never shows as a
// proposal. The exception is typing inside a proposal's new text, which edits that
// proposal. An edit that spans part of a proposal accepts that proposal first.
// In review mode your edits are left as proposals instead.
// Reloads from disk (the agent writing the file) leave the baseline alone.
let reviewMode = false;

function readOrNull(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

function onChange(e) {
  const doc = e.document;
  const st = stateFor(doc);
  if (!st || !e.contentChanges.length) return;
  // A reload from disk leaves the document equal to the file. (isDirty alone is not enough:
  // it is still false during the first edit after a save.)
  const external = !doc.isDirty && e.reason === undefined && readOrNull(doc.uri.fsPath) === doc.getText();
  // Reject writes accepted text back into the file: that is not the author's own typing.
  const rejecting = st.rejecting;
  if (external) recordAgentEdit(st);
  // The diff regions must describe the text before this edit; if not, leave the edit as a proposal.
  if (!external && !rejecting && !reviewMode && st.version === doc.version - 1) {
    const rawOf = () => st.regions.flatMap(r => r.raw);
    const overlaps = (c, s, end) => c.workStart < end && s < c.workEnd;
    const inside = (c, s, end) => c.workStart <= s && end <= c.workEnd && c.workStart < c.workEnd &&
      (s < end ? overlaps(c, s, end) : c.workStart < s && s < c.workEnd);
    // Treat the event as one edit from its first to its last piece: VS Code delivers a
    // large replacement (Undo, the diff editor's revert) as many small pieces.
    const chs = e.contentChanges;
    const s = Math.min(...chs.map(ch => ch.rangeOffset));
    const end = Math.max(...chs.map(ch => ch.rangeOffset + ch.rangeLength));
    const grow = chs.reduce((n, ch) => n + ch.text.length - ch.rangeLength, 0);
    const text = doc.getText().slice(s, end + grow);
    // Accept the proposals the edit cuts across, so the edit can apply to the baseline.
    const cut = rawOf().filter(c => overlaps(c, s, end) && !inside(c, s, end));
    if (cut.length) {
      st.base = acceptChanges(st.base, st.work, cut);
      st.regions = computeRegions(st.base, st.work);
    }
    const raw = rawOf();
    if (!raw.some(c => inside(c, s, end))) {
      const bs = workToBase(raw, s, true);
      const be = end === s ? bs : workToBase(raw, end, false);
      st.base = st.base.slice(0, bs) + text + st.base.slice(be);
      st.baseDirty = true;
    }
  }
  // Regions must describe the text these offsets were taken from, so refresh now.
  recompute(doc, st);
  refreshSoon();
}

// An edit arriving from disk (an agent writing the file) is one history step per burst.
const agentEditTimers = new Map();
function recordAgentEdit(st) {
  clearTimeout(agentEditTimers.get(st.basePath));
  agentEditTimers.set(st.basePath, setTimeout(() => {
    agentEditTimers.delete(st.basePath);
    recordStep(st, `agent: edited ${st.rel}`, { Action: 'edit', File: st.rel, Suggestions: st.regions.length });
  }, 2000));
}

function onSave(doc) {
  const st = states.get(doc.uri.toString());
  if (st && st.baseDirty) {
    writeBase(st);
    recordStep(st, `author: edited ${st.rel}`, { Action: 'own-edit', File: st.rel });
  }
}

function onBaselineFileChange(uri) {
  for (const [key, st] of states) {
    if (st.basePath !== uri.fsPath || !fs.existsSync(st.basePath)) continue;
    const text = fs.readFileSync(st.basePath, 'utf8');
    if (text === st.ownWrite || text === st.base) continue;
    st.base = text;
    const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === key);
    if (doc) recompute(doc, st);
  }
  refreshSoon();
}

function activate(context) {
  extContext = context;
  log.appendLine('Mâché active');
  reviewMode = context.workspaceState.get('mache.reviewMode', false);
  const toggleReviewMode = () => {
    reviewMode = !reviewMode;
    context.workspaceState.update('mache.reviewMode', reviewMode);
    log.appendLine(`review mode ${reviewMode ? 'on' : 'off'}`);
    updateStatus();
    postPanel();
  };
  const selector = [{ language: 'latex' }, { pattern: '**/*.tex' }];
  const watcher = vscode.workspace.createFileSystemWatcher('**/.review/**/*.tex');
  const notesWatcher = vscode.workspace.createFileSystemWatcher('**/.review/**/*.notes.json');
  context.subscriptions.push(
    insertedDeco, deletedDeco, movedDeco, noteDeco, status, modeStatus, lensEmitter, baseEmitter, watcher, notesWatcher, log,
    vscode.window.registerWebviewViewProvider('mache.panel', panel, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand('mache.addNote', noteCommand),
    vscode.commands.registerCommand('mache.acceptSuggestion', () => atCursor(accept)),
    vscode.commands.registerCommand('mache.rejectSuggestion', () => atCursor(undo)),
    vscode.commands.registerCommand('mache.commentSuggestion', () => atCursor(commentOn)),
    vscode.commands.registerCommand('mache.compareSuggestion', () => atCursor(openReview)),
    vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('mache')) refreshAll(); }),
    vscode.commands.registerCommand('mache.commentOn', commentOn),
    vscode.commands.registerCommand('mache.showPanel', showPanel),
    vscode.commands.registerCommand('mache.goto', goto),
    vscode.window.onDidChangeTextEditorSelection(onSelection),
    notesWatcher.onDidChange(onNotesFileChange),
    notesWatcher.onDidCreate(onNotesFileChange),
    vscode.workspace.registerTextDocumentContentProvider(BASE_SCHEME, baseProvider),
    vscode.commands.registerCommand('mache.openReview', openReview),
    vscode.commands.registerCommand('mache.toggleReviewMode', toggleReviewMode),
    vscode.languages.registerCodeLensProvider(selector, codeLenses),
    vscode.languages.registerHoverProvider(selector, hovers),
    vscode.languages.registerInlayHintsProvider(selector, deletionHints), hintEmitter,
    vscode.commands.registerCommand('mache.accept', accept),
    vscode.commands.registerCommand('mache.undo', undo),
    vscode.commands.registerCommand('mache.acceptAll', () => all('accept')),
    vscode.commands.registerCommand('mache.undoAll', () => all('undo')),
    vscode.commands.registerCommand('mache.next', () => jump(1)),
    vscode.commands.registerCommand('mache.previous', () => jump(-1)),
    vscode.commands.registerCommand('mache.track', track),
    vscode.commands.registerCommand('mache.startPaper', startPaper),
    vscode.workspace.onDidChangeTextDocument(onChange),
    vscode.workspace.onDidSaveTextDocument(onSave),
    vscode.workspace.onDidCloseTextDocument(doc => states.delete(doc.uri.toString())),
    vscode.window.onDidChangeVisibleTextEditors(refreshAll),
    vscode.window.tabGroups.onDidChangeTabs(refreshSoon),
    vscode.window.onDidChangeActiveTextEditor(() => { updateStatus(); postPanel(); }),
    watcher.onDidChange(onBaselineFileChange),
    watcher.onDidCreate(onBaselineFileChange),
  );
  refreshAll();
  // Lets tests drive the panel the way its buttons do.
  if (process.env.MACHE_TEST) return { panelMessage: onPanelMessage, panelState };
}

module.exports = { activate, deactivate() {} };
