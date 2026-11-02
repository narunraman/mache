# Mâché

Mâché lets you write a LaTeX paper with an AI agent the way you would with a co-author in Google Docs. The agent edits your `.tex` files directly; in VS Code you see its edits as suggestions — added words in green, removed words in red, moved paragraphs as moves — with comment threads that you and the agent both write in, and nothing becomes part of the paper until you accept it. It works on any LaTeX project and with any agent that can run a command, keeps a private record of every step, and turns each round of review into one clean git commit. It is part of [kagaz](https://github.com/narunraman/kagaz), a kit for writing papers, and works without it.

![An agent's edits in VS Code with Mâché: removed words in red, added words in green, a moved paragraph, and the review panel](media/screenshots/editor.png)

## Install

Install **Mâché** from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=narunraman.mache) (search for "Mâché" in VS Code's Extensions view), and the `mache` command, which needs [Node.js](https://nodejs.org):

```bash
npm install -g github:narunraman/mache
mache setup    # optional: installs the extension into every VS Code on this machine
```

`mache setup` installs the extension from the Marketplace into the `code` command's VS Code and, if you connect to this machine with Remote-SSH or a tunnel, into the VS Code server there too. Where the Marketplace isn't available (offline, or Cursor and VSCodium) it installs a package built from your copy instead; `mache vsix` writes that package to install by hand.

Two editor settings make removed text red and show it at full length. kagaz adds them to a paper's workspace; otherwise add them yourself:

```json
"workbench.colorCustomizations": { "editorInlayHint.foreground": "#f14c4c", "editorInlayHint.background": "#d73a4a30" },
"editor.inlayHints.maximumLength": 0
```

## Review a round

Start reviewing a paper once, from anywhere inside it:

```bash
mache start
```

Its current text becomes the accepted text, kept in `.review/` (which it adds to `.gitignore`). Then:

1. **Comment.** Select text in VS Code and press `Alt+M`, or right-click and choose "Comment on selection"; the words get a yellow underline and the thread lives in the Mâché panel. Your own typing is just editing (switch on *Review mode* in the status bar to have it shown as suggestions too).
2. **Ask your agent**, in whatever chat you already use: "go through my comments", "tighten §3". An agent finds its way by running `mache` in the paper: it lists the comments waiting for a reply, newest first, and what to do. Nothing is configured for a particular agent; a paper's `AGENTS.md` only needs a line saying it is reviewed with `mache`.
3. **The agent edits the `.tex` files.** Its edits become suggestions. It answers your comments with `mache reply` (naming the edit that answers, so the edit appears inside its reply), says why it made other edits with `mache explain`, and raises things of its own with `mache comment`.
4. **Review.** Accept, Reject or Comment above each change, in the panel, or with `Alt+Y` / `Alt+N` at the cursor. *Accept & resolve* takes an answering edit and closes its comment. A comment is waiting on the agent whenever you had the last word.
5. **Commit** when the round is done: `mache commit`.

![A comment in Mâché: the commented words underlined in yellow, the author's question and the agent's answer in the panel](media/screenshots/comment.png)

When writing with AI it's hard to know what it has edited. In a `.tex` file a paragraph is usually one long line, so `git diff` shows you this:

```diff
- Thompson's lesson applies here as well \citep{thompson1984trusting}. A check that is performed by a tool you trust is only as trustworthy as that tool, and the tools in a typesetting pipeline are numerous, mostly unaudited, and updated without notice. …
+ Thompson's lesson applies to the checks themselves \citep{thompson1984trusting}. A check that is performed by a tool you trust is only as trustworthy as that tool, and the tools in a typesetting pipeline are numerous, mostly unaudited, and updated without notice. …
```

Two whole paragraphs, to find that four words changed (and here the paragraph had also moved, which a diff shows as one paragraph deleted and an unrelated one added). Mâché shows the same change as the first screenshot does: one moved paragraph, four words reworded inside it.

## Working and public histories

Every step is recorded in a private git history inside `.review/` that never leaves your machine: each agent edit, each accept and reject with the agent's reason, each comment and reply, and your own edits. Your paper's own repository does not have to see any of that if you run `mache commit`: it squashes everything since the last commit into **one commit of accepted text only**, with a message drafted from the round (mostly from the agent's own explanations) that opens in your editor first. Pending suggestions stay in your working files and out of your history.

```text
your repository (what you push)               private history (.review/, never pushed)

● Draft the paper
│                                               ● you comment on §4
│                                               ● agent edits §4 and replies
│                                               ● you accept the edit
│                                               ● agent adds a paragraph
│                                               ● you reject it
│               mache commit: squash, keeping   │
│               only the text you accepted      │
● Revise §4  ◀──────────────────────────────────┘
│                                               ● agent moves a paragraph in §2
│                                               ● you reply: "shorter?"
│                                               ● agent shortens it
│                                               ● you accept both
│               mache commit                    │
● Tighten §2  ◀─────────────────────────────────┘
```

## Commands

Run `mache` anywhere inside a paper; `mache help` lists everything.

| Command | What it does |
|---|---|
| `mache` | comments waiting for a reply (newest first), suggestions pending, what to do next |
| `mache comments [--waiting] [--all]` | comment threads, waiting ones first |
| `mache reply <id> "…"` | answer a comment; `--change <file>:<line>` names the edit that answers it |
| `mache comment <file>:<line> "…"` | start a thread on a line (`--quote "…"` to anchor on exact words) |
| `mache explain <file>:<line> "…"` | say why you made the edit at that line |
| `mache status` | every pending suggestion, per file (`--json`) |
| `mache start [files…]` | start reviewing files (default: every `.tex` file in the paper) |
| `mache summary` | the commit message for everything since the last commit |
| `mache commit` | commit the accepted text with that message (`--no-edit` skips the editor) |
| `mache setup` | install the Mâché extension into this machine's VS Code |
| `mache vsix [file]` | write the extension package |

Messages are the agent's unless you add `--as user`. Accepting, rejecting and resolving are not commands: they are the author's calls, made in the editor.

## Where things live

```text
.review/README.md                          what this folder is, for whoever finds it
.review/paper/sections/model.tex           the accepted text of paper/sections/model.tex
.review/paper/sections/model.notes.json    its comment threads
.review/history.git                        the private step-by-step history
```

A paper has one `.review/` folder, at the nearest folder above its files that has one; `mache start` creates it at the paper's root (the folder with `kagaz.toml`, else the top of the git repository). The accepted copies change only through your Accept, Reject and own edits.

## Known limits

- A long deletion at the very start of a line is shown as a one-line summary (the full text is in the hover and the panel): VS Code misplaces wrapped text inserted at a line's first column.
- Text typed directly onto the end of a suggested word, with no space, joins that suggestion.
- Splitting one paragraph into two shows as a deletion and a new paragraph rather than an edit.
- One author at a time: co-authors editing simultaneously are not supported yet.

## Tests

```bash
npm test               # the comparison, comments and the mache command (a second or two)
npm run test:vscode    # the extension inside a real VS Code (set VSCODE_BIN if it is not found)
```

## License

MIT (`LICENSE`).
