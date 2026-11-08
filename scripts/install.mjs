// One installer for every agent app. Plain Node 18+, no dependencies.
//   node scripts/install.mjs                 install for every app found on this machine
//   node scripts/install.mjs --apps codex,cursor
//   node scripts/install.mjs --project .     install into this repo only (.claude/, .agents/, .cursor/ ...)
//   node scripts/install.mjs --zip           build dist/<name>.zip to upload in claude.ai or ChatGPT
//   node scripts/install.mjs --dry-run       show what would happen
//   node scripts/install.mjs --uninstall     remove copies this installer made
// It reads the skill name from SKILL.md, and installs agent definitions from agents/<app>/.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i > -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const flag = (k) => argv.includes(`--${k}`);
const DRY = flag('dry-run');
const HOME = os.homedir();
const PROJECT = opt('project') ? path.resolve(opt('project')) : null;
const BASE = PROJECT || HOME;
const say = (s = '') => console.log(s);

const skillMd = fs.readFileSync(path.join(SRC, 'SKILL.md'), 'utf8');
const NAME = (skillMd.match(/^name:\s*([a-z0-9-]+)\s*$/m) || [])[1];
const VERSION = (skillMd.match(/^\s*version:\s*"?([\w.-]+)"?\s*$/m) || [])[1] || '?';
if (!NAME) { console.error('install: no "name:" in SKILL.md'); process.exit(1); }

const onPath = (bin) => {
  const r = process.platform === 'win32'
    ? spawnSync(`where ${bin}`, { shell: true, encoding: 'utf8', windowsHide: true })
    : spawnSync('sh', ['-c', `command -v ${bin}`], { encoding: 'utf8' });
  return r.status === 0 && String(r.stdout).trim().length > 0;
};
const has = (...p) => fs.existsSync(path.join(HOME, ...p));

// Where each app reads skills and agent files. Cursor also reads ~/.claude/skills and ~/.agents/skills,
// and ~/.claude/agents and ~/.codex/agents, so it only gets its own copy when neither of those is installed.
const APPS = {
  'claude-code': {
    label: 'Claude Code (CLI, desktop app, IDE) and Claude Cowork',
    found: () => has('.claude') || onPath('claude'),
    skills: path.join(BASE, '.claude', 'skills'),
    agents: { 'claude-code': path.join(BASE, '.claude', 'agents') },
    reload: 'start a new session',
  },
  codex: {
    label: 'Codex (CLI, IDE, ChatGPT desktop app Codex mode)',
    found: () => has('.codex') || has('.agents') || onPath('codex'),
    skills: path.join(BASE, '.agents', 'skills'),
    agents: { codex: path.join(BASE, '.codex', 'agents') },
    reload: 'start a new session (ChatGPT desktop app: reopen Codex mode)',
  },
  antigravity: {
    label: 'Antigravity (app, IDE, agy CLI)',
    found: () => has('.gemini') || onPath('agy'),
    skills: PROJECT ? path.join(BASE, '.agents', 'skills') : path.join(HOME, '.gemini', 'config', 'skills'),
    agents: { antigravity: PROJECT ? path.join(BASE, '.agents', 'agents') : path.join(HOME, '.gemini', 'config', 'agents') },
    reload: 'run /skills reload in the agy CLI, or open a new conversation',
  },
  cursor: {
    label: 'Cursor (IDE and Cursor CLI)',
    found: () => has('.cursor') || onPath('agent') || onPath('cursor'),
    skills: path.join(BASE, '.cursor', 'skills'),
    agents: { cursor: path.join(BASE, '.cursor', 'agents') },
    reload: 'start a new chat (Cursor CLI: a new session)',
  },
};

const SKIP = new Set(['.git', '.github', 'node_modules', 'dist', 'evals', '.frame-judge', '.assumption-judge', '.DS_Store']);
function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const a = path.join(from, e.name), b = path.join(to, e.name);
    if (e.isDirectory()) copyDir(a, b); else fs.copyFileSync(a, b);
  }
}
const sameDir = (a, b) => { try { return fs.realpathSync(a) === fs.realpathSync(b); } catch { return false; } };
const isOurs = (dir) => { try { return (fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8').match(/^name:\s*([a-z0-9-]+)/m) || [])[1] === NAME; } catch { return false; } };

function installSkill(dir) {
  const target = path.join(dir, NAME);
  if (sameDir(target, SRC)) return `already here (this clone is the install; update with git pull)`;
  if (fs.existsSync(target)) {
    if (fs.existsSync(path.join(target, '.git')) && !flag('force')) return `kept: ${target} is a git clone (update it with "git -C <that folder> pull", or pass --force)`;
    if (!isOurs(target)) return `skipped: ${target} holds a different skill`;
    if (!DRY) fs.rmSync(target, { recursive: true, force: true });
  }
  if (!DRY) copyDir(SRC, target);
  return `${DRY ? 'would install' : 'installed'} ${target}`;
}

function installAgents(map) {
  const done = [];
  for (const [kind, dest] of Object.entries(map)) {
    const from = path.join(SRC, 'agents', kind);
    if (!fs.existsSync(from)) continue;
    for (const f of fs.readdirSync(from)) {
      if (!DRY) { fs.mkdirSync(dest, { recursive: true }); fs.copyFileSync(path.join(from, f), path.join(dest, f)); }
      done.push(path.join(dest, f));
    }
  }
  return done;
}

function uninstall(app) {
  const out = [];
  const target = path.join(app.skills, NAME);
  if (fs.existsSync(target) && !sameDir(target, SRC) && !fs.existsSync(path.join(target, '.git')) && isOurs(target)) {
    if (!DRY) fs.rmSync(target, { recursive: true, force: true });
    out.push(`${DRY ? 'would remove' : 'removed'} ${target}`);
  }
  for (const [kind, dest] of Object.entries(app.agents)) {
    const from = path.join(SRC, 'agents', kind);
    if (!fs.existsSync(from)) continue;
    for (const f of fs.readdirSync(from)) {
      const p = path.join(dest, f);
      if (fs.existsSync(p)) { if (!DRY) fs.rmSync(p); out.push(`${DRY ? 'would remove' : 'removed'} ${p}`); }
    }
  }
  return out;
}

// ---- a tiny zip writer (deflate), so claude.ai / ChatGPT uploads need no zip tool ----
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
// Chat uploads get spec-only frontmatter (agentskills.io): app-specific keys such as Claude Code's hooks mean
// nothing there and could trip an upload validator.
const SPEC_KEYS = new Set(['name', 'description', 'license', 'compatibility', 'metadata']);
function specOnly(md) {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!m) return md;
  const keep = [];
  let on = false;
  for (const line of m[1].split(/\r?\n/)) {
    const key = line.match(/^([A-Za-z][\w-]*):/);
    if (key) on = SPEC_KEYS.has(key[1]);
    if (on) keep.push(line);
  }
  return `---\n${keep.join('\n')}\n---\n${md.slice(m[0].length)}`;
}
const ZIP_SKIP = new Set(['agents', '.claude-plugin', '.gitattributes', '.gitignore']); // nothing a chat app can use

function zipDir(root, prefix, outFile) {
  const files = [];
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (SKIP.has(e.name) || (rel === '' && ZIP_SKIP.has(e.name))) continue;
      const a = path.join(d, e.name), r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(a, r); else files.push([a, `${prefix}/${r}`]);
    }
  };
  walk(root, '');
  const parts = [], central = [];
  let offset = 0;
  for (const [abs, name] of files) {
    const data = name === `${prefix}/SKILL.md` ? Buffer.from(specOnly(fs.readFileSync(abs, 'utf8')), 'utf8') : fs.readFileSync(abs);
    const comp = zlib.deflateRawSync(data);
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(0, 10); local.writeUInt32LE(crc, 14); local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
    parts.push(local, nameBuf, comp);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0x0800, 8); cen.writeUInt16LE(8, 10);
    cen.writeUInt32LE(0, 12); cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(comp.length, 20); cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28); cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
  }
  const cenBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cenBuf.length, 12); end.writeUInt32LE(offset, 16);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, Buffer.concat([...parts, cenBuf, end]));
  return files.length;
}

if (flag('help') || flag('h')) {
  say(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).slice(0, 8).map((l) => l.slice(3)).join('\n'));
  process.exit(0);
}

if (flag('zip')) {
  const out = path.resolve(opt('out', path.join(SRC, 'dist', `${NAME}.zip`)));
  const n = zipDir(SRC, NAME, out);
  say(`${NAME} ${VERSION}: wrote ${out} (${n} files)`);
  say('  claude.ai: Settings > Capabilities > turn on code execution, then Skills > Upload a skill > pick this zip.');
  say('  ChatGPT (web/desktop Chat or Work): Skills > Create > Upload from your computer > pick this zip.');
  say('  In chat apps the skill runs in relay mode. See references/platforms.md, section "Chat apps".');
  process.exit(0);
}

const wanted = opt('apps', 'auto');
const names = wanted === 'auto' ? Object.keys(APPS).filter((k) => APPS[k].found()) : wanted === 'all' ? Object.keys(APPS) : wanted.split(',').map((s) => s.trim());
for (const n of names) if (!APPS[n]) { console.error(`install: unknown app "${n}". Use ${Object.keys(APPS).join(', ')}, all or auto.`); process.exit(1); }
if (!names.length) { say('install: no agent app found. Pass --apps claude-code,codex,antigravity,cursor (or --zip for claude.ai / ChatGPT uploads).'); process.exit(1); }

// Cursor reads the Claude Code and Codex folders too: give it its own skill copy only when neither is installed.
const cursorCovered = names.includes('claude-code') || names.includes('codex');

say(`${NAME} ${VERSION}: ${flag('uninstall') ? 'uninstalling' : 'installing'} ${PROJECT ? `into project ${PROJECT}` : 'for your user'}${DRY ? ' (dry run)' : ''}`);
for (const n of names) {
  const app = APPS[n];
  say(`\n${app.label}`);
  if (flag('uninstall')) { for (const l of uninstall(app)) say(`  ${l}`); continue; }
  if (n === 'cursor' && cursorCovered) say(`  skill: reads the copy in ${names.includes('claude-code') ? APPS['claude-code'].skills : APPS.codex.skills}`);
  else say(`  skill: ${installSkill(app.skills)}`);
  if (!flag('no-agents')) for (const a of installAgents(app.agents)) say(`  agent: ${a}`);
  say(`  then: ${app.reload}`);
}
if (!flag('uninstall')) {
  say('\nNeeds Node 18+ at run time. Chat apps (claude.ai, ChatGPT web): node scripts/install.mjs --zip');
  if (names.includes('cursor') && names.includes('claude-code') && names.includes('codex')) say('Note: Cursor sees both the Claude Code and the Codex copy. If it lists the skill twice, remove one copy from Cursor\'s view with --apps.');
}
