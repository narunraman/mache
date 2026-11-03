'use strict';
// Pack the extension as a .vsix (a zip with a manifest) and install it into VS Code, with
// nothing but Node: `mache setup` and `mache vsix` use this.
//
// This is a minimal packer for local installs only (`code --install-extension`, or Install from
// VSIX…). Its manifest lists no README or license assets, so the VS Code Marketplace rejects
// what it writes (error TF400898). Build Marketplace uploads with `npm run package:marketplace`
// (the official vsce), which takes its file list from package.json's "files".
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
// What the extension needs at run time (the command line and tests are not part of it).
const FILES = ['package.json', 'extension.js', 'panel.js', 'core/diff.js', 'core/notes.js',
  'core/project.js', 'core/suggestions.js', 'media/review.svg', 'README.md', 'LICENSE'];

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// A minimal zip writer: deflated entries, a central directory, no zip64 (the extension is small).
function zip(entries) {
  const local = [], central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const packed = zlib.deflateRawSync(data);
    const crc = crc32(data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x0800, 6);
    head.writeUInt16LE(8, 8); head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(packed.length, 18); head.writeUInt32LE(data.length, 22); head.writeUInt16LE(nameBuf.length, 26);
    local.push(head, nameBuf, packed);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0); dir.writeUInt16LE(20, 4); dir.writeUInt16LE(20, 6); dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(8, 10); dir.writeUInt32LE(crc, 16); dir.writeUInt32LE(packed.length, 20);
    dir.writeUInt32LE(data.length, 24); dir.writeUInt16LE(nameBuf.length, 28); dir.writeUInt32LE(offset, 42);
    central.push(dir, nameBuf);
    offset += head.length + nameBuf.length + packed.length;
  }
  const dirBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dirBuf.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, dirBuf, end]);
}

const esc = s => String(s).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

function pack() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const manifest = `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Language="en-US" Id="${esc(pkg.name)}" Version="${esc(pkg.version)}" Publisher="${esc(pkg.publisher)}"/>
    <DisplayName>${esc(pkg.displayName)}</DisplayName>
    <Description xml:space="preserve">${esc(pkg.description)}</Description>
    <Properties><Property Id="Microsoft.VisualStudio.Code.Engine" Value="${esc(pkg.engines.vscode)}"/></Properties>
  </Metadata>
  <Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation>
  <Dependencies/>
  <Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/></Assets>
</PackageManifest>
`;
  const types = `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension=".json" ContentType="application/json"/>
  <Default Extension=".js" ContentType="application/javascript"/>
  <Default Extension=".md" ContentType="text/markdown"/>
  <Default Extension=".svg" ContentType="image/svg+xml"/>
  <Default Extension=".vsixmanifest" ContentType="text/xml"/>
  <Default Extension="" ContentType="text/plain"/>
</Types>
`;
  return zip([
    { name: '[Content_Types].xml', data: Buffer.from(types) },
    { name: 'extension.vsixmanifest', data: Buffer.from(manifest) },
    ...FILES.filter(f => fs.existsSync(path.join(ROOT, f)))
      .map(f => ({ name: `extension/${f}`, data: fs.readFileSync(path.join(ROOT, f)) })),
  ]);
}

// Every VS Code this machine can install into: the `code` command, and the server VS Code
// runs on this machine when you connect to it remotely (Remote-SSH, tunnels).
function vscodes() {
  const found = [];
  for (const name of ['code', 'code-insiders', 'cursor']) {
    try {
      const p = execFileSync('which', [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (p) found.push({ name, cli: p });
    } catch { /* not installed */ }
  }
  const servers = path.join(os.homedir(), '.vscode-server', 'cli', 'servers');
  if (fs.existsSync(servers)) {
    const latest = fs.readdirSync(servers).map(d => path.join(servers, d, 'server', 'bin', 'code-server'))
      .filter(p => fs.existsSync(p)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
    if (latest) found.push({ name: 'VS Code server (remote connections)', cli: latest });
  }
  return found;
}

// Install from the Marketplace, which keeps the extension updated; where that fails (offline,
// or an editor such as Cursor that cannot use Microsoft's Marketplace), install a package built
// from these files instead.
const MARKETPLACE_ID = 'narunraman.mache';

function install() {
  const targets = vscodes();
  if (!targets.length) return { installed: [], failed: [], none: true };
  const installed = [], failed = [];
  let file;
  for (const t of targets) {
    const run = what => execFileSync(t.cli, ['--install-extension', what, '--force'], { stdio: 'ignore', timeout: 180000 });
    try {
      run(MARKETPLACE_ID);
      installed.push(`${t.name} (from the Marketplace)`);
      continue;
    } catch { /* fall back to a local package */ }
    try {
      if (!file) { file = path.join(os.tmpdir(), `mache-${process.pid}.vsix`); fs.writeFileSync(file, pack()); }
      run(file);
      installed.push(`${t.name} (from this copy)`);
    } catch { failed.push(t.name); }
  }
  if (file) fs.rmSync(file, { force: true });
  return { installed, failed };
}

module.exports = { pack, install, vscodes, zip };
