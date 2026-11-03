#!/usr/bin/env node
'use strict';
// Runs suite.js inside a real VS Code with the extension loaded (npm run test:vscode).
// VS Code is found from $VSCODE_BIN, the snap, or a usual install path; without a display the
// run goes through xvfb-run. Each run uses a fresh profile and a fresh temporary paper.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const candidates = [process.env.VSCODE_BIN, '/snap/code/current/usr/share/code/code', '/usr/share/code/code',
  '/Applications/Visual Studio Code.app/Contents/MacOS/Electron'].filter(Boolean);
const bin = candidates.find(p => fs.existsSync(p));
if (!bin) { console.error('VS Code not found; set VSCODE_BIN to its executable'); process.exit(1); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mache-vscode-'));
const paperDir = path.join(tmp, 'paper');
fs.mkdirSync(paperDir);
fs.mkdirSync(path.join(tmp, 'profile', 'User'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'profile', 'User', 'settings.json'),
  JSON.stringify({ 'security.workspace.trust.enabled': false, 'workbench.startupEditor': 'none', 'update.mode': 'none' }));
const result = path.join(tmp, 'result.json');
const args = ['--no-sandbox', `--user-data-dir=${path.join(tmp, 'profile')}`, `--extensions-dir=${path.join(tmp, 'ext')}`,
  `--extensionDevelopmentPath=${path.join(__dirname, '..', '..')}`, `--extensionTestsPath=${path.join(__dirname, 'suite.js')}`, paperDir];
const env = { ...process.env, MACHE_TEST: '1', MACHE_TEST_PAPER: paperDir, MACHE_TEST_RESULT: result,
  MACHE_BIN_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'mache-bin-')) };
const cmd = process.env.DISPLAY || process.platform === 'darwin' ? [bin, args] : ['xvfb-run', ['-a', bin, ...args]];
spawnSync(cmd[0], cmd[1], { env, stdio: 'ignore', timeout: 300000 });
const out = fs.existsSync(result) ? JSON.parse(fs.readFileSync(result, 'utf8')) : [{ name: 'VS Code run', ok: false, error: 'no result written' }];
for (const t of out) console.log(`${t.ok ? 'ok    ' : 'FAIL  '} ${t.name}${t.ok ? '' : `\n       ${t.error}`}`);
fs.rmSync(tmp, { recursive: true, force: true });
const failed = out.filter(t => !t.ok).length;
console.log(`\n${out.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
