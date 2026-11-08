import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  DEFAULTS, MODELS, SKILL_DIR, VERSION, agyBin, agyTurns, appendLog, codexBin, codexTurns, buildPacket, claudeBin, clip, cursorBin, cursorTurns, earlierText, ensureStateDir, findAgyTranscript, findTranscript,
  gate, interruptMessage, isJudgeCommand, loadConfig, readJSON, readLog, readTranscript, runJudge, saveConfig,
  stateDir, traceText, turns, writeJSON,
} from './lib.mjs';

const HELP = `assumption-judge ${VERSION}

  aj.mjs doctor                   Which app this is, which judge runners are installed, and what to do next.
  aj.mjs on [--platform claude-code|antigravity|codex|cursor] [--runner claude|agy|codex|cursor] [--model <alias|id>]
            [--max-interrupts 2] [--no-web] [--global] [--mode sync|deferred]
        Turn live judging on for this project. Claude Code: the skill's hooks do the rest.
        Antigravity: also writes Stop + PreInvocation hooks into <workspace>/.agents/hooks.json, or with
        --global into ~/.gemini/config/hooks.json (covers chats with no workspace open). --mode deferred
        judges in the background (no freeze) and delivers a catch at the start of your next message.
        Codex: also writes UserPromptSubmit + Stop hooks into <repo>/.codex/hooks.json (trust them with /hooks).
        Cursor (IDE and CLI): writes beforeSubmitPrompt + afterAgentResponse + stop hooks into <project>/.cursor/hooks.json,
        or with --global into ~/.cursor/hooks.json. A catch comes back to the agent as a follow-up message.
  aj.mjs off [--global]           Stop judging (disables or removes the hook entries).
  aj.mjs status [--global]        Settings and the last verdicts.
  aj.mjs set <key> <value> [--global]  model | runner | mode | max-interrupts | min-reply-chars | max-turns | timeout-s | web | context-turns
  aj.mjs check [--platform p] [--transcript auto|<file>] [--prompt-file f --reply-file f [--trace-file f]] [--model m]
        Judge one reply now, synchronously: the last finished reply of THIS app's current conversation.
        It never reads another app's transcripts; if it can't tell which app it runs in, it asks for --platform.
  aj.mjs packet --prompt-file f --reply-file f [--trace-file f] [--earlier-file f]
        Platforms without hooks: write the judge's packet and print the spawn message.
  aj.mjs gate --verdict <file>    Gate a verdict the judge subagent returned for the last packet.

State lives in .assumption-judge/ under the working directory (it git-ignores itself), or ~/.assumption-judge/ with --global.`;

const argv = process.argv.slice(2);
const cmd = argv[0];
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i > -1 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const flag = (name) => argv.includes(`--${name}`);
const die = (msg) => { console.error(`assumption-judge: ${msg}`); process.exit(1); };
const GLOBAL = flag('global');
// --global: config and state in ~/.assumption-judge/ (Antigravity chats with no workspace use this scope).
const proj = GLOBAL ? os.homedir() : path.resolve(opt('dir', process.cwd()));
const readText = (f) => (f === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(path.resolve(f), 'utf8'));

function checkModel(m, runner = 'claude') {
  if (m && runner !== 'claude' && /^[\w.:\[\]=,-]+$/.test(m)) return; // Cursor ids can carry options: claude-opus-5[effort=high]
  if (!m) return;
  if (!/^[\w.:-]+$/.test(m)) die(`invalid model "${m}"`);
  if (runner === 'claude' && !MODELS.includes(m) && !/^claude-[\w.-]+$/.test(m)) {
    die(`unknown model "${m}" for the claude runner. Use ${MODELS.join(' | ')} or a full claude-* id.`);
  }
}

const RUNNERS = ['claude', 'agy', 'codex', 'cursor'];
const binFor = (runner) => ({ agy: agyBin, codex: codexBin, cursor: cursorBin }[runner] || claudeBin)();
const envFor = (runner) => `ASSUMPTION_JUDGE_${{ agy: 'AGY', codex: 'CODEX', cursor: 'CURSOR' }[runner] || 'CLAUDE'}`;

function cliAvailable(runner) {
  const bin = binFor(runner);
  const viaShell = runner === 'cursor' && process.platform === 'win32' && !/[\\/]/.test(bin); // "agent" is a .cmd shim on Windows
  const r = viaShell ? spawnSync(`${bin} --version`, { encoding: 'utf8', timeout: 20000, windowsHide: true, shell: true })
    : spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 20000, windowsHide: true });
  if (/not recognized|command not found/i.test(`${r.stdout}${r.stderr}`)) return null;
  return r.error || r.status !== 0 ? null : String(r.stdout || r.stderr || '').trim().split('\n')[0];
}

// Codex: project hooks in <repo>/.codex/hooks.json. Ours are recognised by the script path they run.
const quoteIfSpaces = (p) => (/\s/.test(p) ? `"${p}"` : p);
function setCodexHook(enabled) {
  const file = path.join(proj, '.codex', 'hooks.json');
  const doc = readJSON(file, {});
  const hooks = doc.hooks || {};
  // Forward slashes: node takes them on Windows, and they survive cmd, PowerShell and sh alike
  // (sh eats backslashes, and we don't know which shell a given Codex build runs hooks with).
  const script = path.join(SKILL_DIR, 'scripts', 'codex-hook.mjs').replace(/\\/g, '/');
  const ours = (group) => (group.hooks || []).some((h) => String(h.command || '').includes('codex-hook.mjs'));
  let touched = false;
  for (const ev of ['UserPromptSubmit', 'Stop']) {
    const before = (hooks[ev] || []).length;
    hooks[ev] = (hooks[ev] || []).filter((g) => !ours(g));
    if (hooks[ev].length !== before) touched = true;
    if (!hooks[ev].length) delete hooks[ev];
  }
  if (enabled) {
    const cmd = (mode) => `node ${quoteIfSpaces(script)} ${mode}`;
    (hooks.UserPromptSubmit ||= []).push({ hooks: [{ type: 'command', command: cmd('prompt'), timeout: 15 }] });
    (hooks.Stop ||= []).push({ hooks: [{ type: 'command', command: cmd('stop'), timeout: 600, statusMessage: 'assumption-judge: checking the reply' }] });
    touched = true;
  }
  if (!touched) return null;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeJSON(file, { ...doc, hooks });
  return file;
}

// Cursor: hooks in <project>/.cursor/hooks.json, or ~/.cursor/hooks.json with --global. Ours are recognised by
// the script path. The command uses forward slashes, which survive cmd, PowerShell and sh alike.
function setCursorHook(enabled) {
  const file = GLOBAL ? path.join(os.homedir(), '.cursor', 'hooks.json') : path.join(proj, '.cursor', 'hooks.json');
  const doc = readJSON(file, {});
  const hooks = doc.hooks || {};
  const script = path.join(SKILL_DIR, 'scripts', 'cursor-hook.mjs').replace(/\\/g, '/');
  const ours = (h) => String(h?.command || '').includes('cursor-hook.mjs');
  let touched = false;
  for (const ev of ['beforeSubmitPrompt', 'afterAgentResponse', 'stop']) {
    const before = (hooks[ev] || []).length;
    hooks[ev] = (hooks[ev] || []).filter((h) => !ours(h));
    if (hooks[ev].length !== before) touched = true;
    if (!hooks[ev].length) delete hooks[ev];
  }
  if (enabled) {
    const cmd = (mode) => `node ${quoteIfSpaces(script)} ${mode}${GLOBAL ? ' global' : ''}`;
    (hooks.beforeSubmitPrompt ||= []).push({ command: cmd('prompt'), timeout: 15 });
    (hooks.afterAgentResponse ||= []).push({ command: cmd('response'), timeout: 15 });
    // loop_limit backs up our own interrupt cap; the judge needs the long timeout.
    (hooks.stop ||= []).push({ command: cmd('stop'), timeout: 600, loop_limit: 3 });
    touched = true;
  }
  if (!touched) return null;
  writeJSON(file, { version: doc.version || 1, ...doc, hooks });
  return file;
}

// Antigravity has no skill-scoped hooks: they live in <workspace>/.agents/hooks.json, or, with --global,
// in ~/.gemini/config/hooks.json (Antigravity's global customization root), which also covers no-workspace chats.
const HOOK_NAME = 'assumption-judge';
function setAgyHook(enabled) {
  const file = GLOBAL ? path.join(os.homedir(), '.gemini', 'config', 'hooks.json') : path.join(proj, '.agents', 'hooks.json');
  const scopeArg = GLOBAL ? ' global' : '';
  const hooks = readJSON(file, {});
  if (enabled) {
    // Antigravity runs hook commands via `cmd /c` on Windows and `sh -c` elsewhere, with the working
    // directory set to the folder holding hooks.json. A quoted absolute path reaches node with literal
    // quotes under cmd /c, so the command stays quote-free and a shim next to hooks.json holds the path.
    const shim = path.join(path.dirname(file), `${HOOK_NAME}-hook.cjs`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(shim, [
      '// Generated by assumption-judge ("aj.mjs on --platform antigravity"). Safe to delete with the hooks.json entry.',
      `import(require('node:url').pathToFileURL(${JSON.stringify(path.join(SKILL_DIR, 'scripts', 'agy-hook.mjs'))}).href)`,
      '  .then((m) => m.main(process.argv[2] || \'stop\', process.argv[3]))',
      "  .catch((e) => { process.stderr.write(String(e && e.stack || e)); process.stdout.write('{}'); });",
      '',
    ].join('\n'));
    hooks[HOOK_NAME] = {
      enabled: true,
      Stop: [{ type: 'command', command: `node ${HOOK_NAME}-hook.cjs stop${scopeArg}`, timeout: 600 }],
      // Deferred mode delivers background verdicts here; in sync mode it returns {} at once.
      PreInvocation: [{ type: 'command', command: `node ${HOOK_NAME}-hook.cjs pre${scopeArg}`, timeout: 15 }],
    };
  } else if (hooks[HOOK_NAME]) {
    hooks[HOOK_NAME].enabled = false;
  } else return null;
  writeJSON(file, hooks);
  return file;
}

// Only trust clear signals. Guessing wrong here once made "check" read a Claude Code transcript inside Antigravity.
const detectPlatform = () => {
  if (process.env.CLAUDECODE) return 'claude-code';
  if (process.env.CURSOR_AGENT || process.env.CURSOR_TRACE_ID || process.env.CURSOR_PROJECT_DIR || /cursor/i.test(process.env.TERM_PROGRAM || '')) return 'cursor';
  if (Object.keys(process.env).some((k) => /^ANTIGRAVITY_/.test(k))) return 'antigravity';
  if (Object.keys(process.env).some((k) => /^CODEX_/.test(k))) return 'codex';
  return null;
};
const PLATFORMS = ['claude-code', 'antigravity', 'codex', 'cursor'];
function resolvePlatform(cfg) {
  const p = opt('platform', detectPlatform() || (cfg.platform !== DEFAULTS.platform || cfg.enabled_at ? cfg.platform : null));
  if (!p) die('can\'t tell which app this is running in. Pass --platform claude-code, antigravity, codex or cursor.');
  if (!PLATFORMS.includes(p)) die(`--platform must be one of ${PLATFORMS.join(', ')} (other apps: use check mode)`);
  return p;
}

// Codex: prefer its own CLI as the judge; fall back to the claude CLI if only that one is installed.
function defaultRunner(platform) {
  if (platform === 'antigravity') return 'agy';
  if (platform === 'codex') return cliAvailable('codex') || !cliAvailable('claude') ? 'codex' : 'claude';
  // Cursor: the claude CLI judge has the strictest tool limits (read + search only); otherwise the Cursor CLI in ask mode.
  if (platform === 'cursor') return cliAvailable('claude') || !cliAvailable('cursor') ? 'claude' : 'cursor';
  return 'claude';
}

function printVerdict(g, model) {
  if (g.decision === 'HALLUCINATION') { process.stdout.write(interruptMessage(g, model)); return; }
  console.log(`[assumption-judge] ${g.decision}${g.summary ? `: ${g.summary}` : ''}`);
  if (g.dropped?.length) console.log(`  ${g.dropped.length} lower-grade note(s) logged, none interrupting.`);
}

switch (cmd) {
  case 'on': {
    const cfg = loadConfig(proj);
    const platform = resolvePlatform(cfg);
    if (GLOBAL && !['antigravity', 'cursor'].includes(platform)) die('--global is for Antigravity and Cursor only (Claude Code hooks are per session, Codex hooks per repo).');
    const mode = opt('mode', cfg.mode);
    if (!['sync', 'deferred'].includes(mode)) die('--mode must be sync or deferred');
    const runner = opt('runner', defaultRunner(platform));
    if (!RUNNERS.includes(runner)) die(`--runner must be one of ${RUNNERS.join(', ')}`);
    const model = opt('model', cfg.platform === platform && cfg.runner === runner ? cfg.model : (runner === 'claude' ? 'sonnet' : 'inherit'));
    checkModel(model, runner);
    const next = {
      ...cfg,
      enabled: true,
      platform,
      runner,
      model,
      mode,
      web: flag('no-web') ? false : cfg.web,
      max_interrupts: Number(opt('max-interrupts', cfg.max_interrupts)),
      skill_dir: SKILL_DIR,
      version: VERSION,
      enabled_at: new Date().toISOString(),
    };
    saveConfig(proj, next);
    const hookFile = { antigravity: setAgyHook, codex: setCodexHook, cursor: setCursorHook }[platform]?.(true) ?? null;
    const cli = cliAvailable(runner);
    console.log(`assumption-judge ON in ${proj} (${platform})`);
    console.log(`  judge model: ${model}${model === 'inherit' ? ' (whatever model wrote the reply)' : ''} · runner: ${runner} · web: ${next.web ? 'on' : 'off'} · max interrupts per prompt: ${next.max_interrupts}`);
    console.log(cli
      ? `  judge runner: ${binFor(runner)} (${cli})`
      : `  WARNING: the ${runner} CLI was not found, so the live judge cannot run. Set ${envFor(runner)} to its path, pick another --runner, or use check mode.`);
    if (hookFile && platform === 'cursor') {
      console.log(`  beforeSubmitPrompt + afterAgentResponse + stop hooks written to ${hookFile}${GLOBAL ? ', for every Cursor project without its own entry' : ''}.`);
      console.log('  Cursor hooks are synchronous: each reply pauses while the judge runs. A catch comes back as a follow-up message, and the agent corrects itself.');
      console.log('  If nothing fires, restart Cursor (or the Cursor CLI session) and check Settings > Hooks for errors.');
    } else if (hookFile && platform === 'codex') {
      console.log(`  UserPromptSubmit + Stop hooks written to ${hookFile}.`);
      console.log('  ACTION NEEDED: Codex runs project hooks only after you trust them. Run /hooks in Codex, review the two assumption-judge hooks, and trust them (the project .codex/ folder must be trusted too).');
      console.log('  Codex hooks are synchronous: each reply pauses while the judge runs. You are only interrupted on HALLUCINATION.');
    } else if (hookFile) {
      console.log(`  Stop + PreInvocation hooks written to ${hookFile} (entry "${HOOK_NAME}")${GLOBAL ? ', for every Antigravity chat, with or without a workspace' : ''}.`);
      console.log(mode === 'deferred'
        ? '  Deferred mode: replies never pause. The judge runs in the background, and a catch is raised at the start of your next message.'
        : '  Sync mode: each reply pauses while the judge runs (~15 s with Claude Sonnet via Antigravity). A catch sends the agent straight back to fix it.');
      console.log('  Reload Antigravity (or start a new conversation) if the hooks do not fire right away.');
    } else {
      console.log('  Every reply from the next user message on gets judged in the background. You are only interrupted on HALLUCINATION.');
    }
    break;
  }
  case 'off': {
    const cfg = loadConfig(proj);
    saveConfig(proj, { ...cfg, enabled: false });
    const agyFile = setAgyHook(false);
    const codexFile = GLOBAL ? null : setCodexHook(false);
    const cursorFile = setCursorHook(false);
    console.log('assumption-judge OFF.');
    if (agyFile) console.log(`  The "${HOOK_NAME}" entry in ${agyFile} is now disabled.`);
    for (const f of [codexFile, cursorFile]) if (f) console.log(`  Its hooks were removed from ${f}.`);
    if (!agyFile && !codexFile && !cursorFile) console.log('  Claude Code hooks stay registered until the session ends but do nothing.');
    break;
  }
  case 'set': {
    const [key, value] = [argv[1], argv[2]];
    if (!key || value === undefined) die('usage: aj.mjs set <key> <value>');
    const cfg = loadConfig(proj);
    const k = key.replace(/-/g, '_');
    if (!(k in DEFAULTS) || k === 'enabled' || k === 'platform') die(`unknown key "${key}"`);
    if (k === 'mode' && !['sync', 'deferred'].includes(value)) die('mode must be sync or deferred');
    if (k === 'model') checkModel(value, cfg.runner);
    if (k === 'runner' && !RUNNERS.includes(value)) die(`runner must be one of ${RUNNERS.join(', ')}`);
    cfg[k] = ['model', 'runner', 'mode'].includes(k) ? value : k === 'web' ? !/^(false|off|0|no)$/i.test(value) : Number(value);
    if (typeof cfg[k] === 'number' && !Number.isFinite(cfg[k])) die(`${key} needs a number`);
    saveConfig(proj, cfg);
    console.log(`${key} = ${cfg[k]}`);
    break;
  }
  case 'status': {
    const cfg = loadConfig(proj);
    const log = readLog(proj);
    const count = (d) => log.filter((r) => r.decision === d).length;
    console.log(`assumption-judge ${VERSION}: ${cfg.enabled ? 'ON' : 'OFF'}${GLOBAL ? ' (global)' : ''} · ${cfg.platform}${cfg.platform === 'antigravity' ? ` (${cfg.mode})` : ''} · runner ${cfg.runner} · model ${cfg.model} · web ${cfg.web ? 'on' : 'off'} · cap ${cfg.max_interrupts}/prompt`);
    console.log(`verdicts: ${count('PASS')} PASS · ${count('HALLUCINATION')} HALLUCINATION · ${count('JUDGE_ERROR')} errors · ${count('SKIPPED')} skipped`);
    const cost = log.reduce((a, r) => a + (typeof r.cost_usd === 'number' ? r.cost_usd : 0), 0);
    if (cost) console.log(`judge cost so far (API-equivalent, as reported by the CLI): ~$${cost.toFixed(2)}`);
    for (const r of log.slice(-5)) {
      const what = r.decision === 'HALLUCINATION' ? r.counted?.map((c) => `${c.id} ${c.status}: "${clip(c.quote, 60)}"`).join(' | ')
        : r.error || r.why || r.summary || '';
      const l = r.ledger ? ` [${r.ledger.claims} claims, ${r.ledger.supported} ok, ${r.ledger.web} via web]` : '';
      console.log(`  ${r.at?.slice(11, 19) ?? ''} ${r.decision}${l} ${clip(what, 160)}`);
    }
    break;
  }
  case 'check': {
    const cfg = loadConfig(proj);
    const model = opt('model', cfg.model);
    checkModel(model, cfg.runner);
    let prompt, reply, trace, turnModel = '', earlier = '';
    if (opt('reply-file')) {
      reply = readText(opt('reply-file'));
      prompt = opt('prompt-file') ? readText(opt('prompt-file')) : '';
      trace = opt('trace-file') ? readText(opt('trace-file')) : '(no trace given)';
      earlier = opt('earlier-file') ? readText(opt('earlier-file')) : '';
    } else {
      // Each app's transcripts only. Never fall back to another app's history.
      const platform = resolvePlatform(cfg);
      const t = opt('transcript', 'auto');
      let file = null;
      if (t !== 'auto') file = path.resolve(t);
      else if (platform === 'antigravity') file = findAgyTranscript();
      else if (platform === 'claude-code') file = findTranscript(proj);
      else if (platform === 'cursor' && process.env.CURSOR_TRANSCRIPT_PATH) file = process.env.CURSOR_TRANSCRIPT_PATH;
      else die(`${platform === 'cursor' ? 'Cursor' : 'Codex'}: pass --transcript <file.jsonl> (or --prompt-file/--reply-file); its transcripts can't be matched to this conversation safely.`);
      if (!file) die(`no ${platform} transcript found. Pass --transcript <file> or --prompt-file/--reply-file.`);
      const all = platform === 'antigravity' ? agyTurns(file) : platform === 'codex' ? codexTurns(file) : platform === 'cursor' ? cursorTurns(file) : turns(readTranscript(file));
      const done = all.filter((x) => !isJudgeCommand(x.prompt) && x.reply.trim());
      const last = done[done.length - 1];
      if (!last) die(`no finished reply found in ${file}`);
      ({ prompt, reply } = last);
      trace = traceText(last.steps);
      turnModel = last.model;
      earlier = earlierText(all.slice(0, all.indexOf(last) + 1), cfg.context_turns);
    }
    const m = model === 'inherit' ? (turnModel || 'inherit') : model;
    console.error(`assumption-judge: judging with ${m}${cfg.web ? ' + web' : ''}…`);
    const runner = opt('runner', cfg.runner);
    const res = runJudge({ runner, packet: buildPacket({ prompt, reply, trace, cwd: proj, web: cfg.web, earlier }), model: m, cwd: proj, web: cfg.web, maxTurns: cfg.max_turns, timeoutS: cfg.timeout_s });
    if (!res.ok) { appendLog(proj, { decision: 'JUDGE_ERROR', manual: true, error: res.error, model: m }); die(res.error); }
    const g = gate(res.verdict, { reply, prompt });
    appendLog(proj, { manual: true, decision: g.decision, judge_said: g.judge_said, checked: g.checked, model: m, ms: res.ms, cost_usd: res.cost_usd, turns: res.turns, summary: g.summary, counted: g.counted, dropped: g.dropped, ledger: g.ledger, reply: clip(reply, 2000) });
    printVerdict(g, m);
    if (flag('json')) console.log(JSON.stringify(g, null, 2));
    process.exitCode = g.decision === 'HALLUCINATION' ? 2 : 0;
    break;
  }
  case 'packet': {
    if (!opt('reply-file')) die('packet needs --reply-file (and usually --prompt-file)');
    const cfg = loadConfig(proj);
    const prompt = opt('prompt-file') ? readText(opt('prompt-file')) : '';
    const reply = readText(opt('reply-file'));
    const trace = opt('trace-file') ? readText(opt('trace-file')) : '(no trace given)';
    const dir = ensureStateDir(proj);
    const packetPath = path.join(dir, 'packet.md');
    const earlier = opt('earlier-file') ? readText(opt('earlier-file')) : '';
    fs.writeFileSync(packetPath, buildPacket({ prompt, reply, trace, cwd: proj, web: cfg.web, earlier })
      + '\n\nReply with the verdict JSON only, matching the schema in the brief.\n');
    writeJSON(path.join(dir, 'pending.json'), { prompt, reply, at: new Date().toISOString() });
    console.log('Send the judge subagent exactly this message, nothing else:\n');
    console.log(`You are the assumption judge. Read ${packetPath} and follow it exactly. Reply with the verdict JSON only.`);
    break;
  }
  case 'gate': {
    const vf = opt('verdict');
    if (!vf) die('gate needs --verdict <file>');
    const pending = readJSON(path.join(stateDir(proj), 'pending.json'));
    if (!pending) die('no pending packet. Run "aj.mjs packet" first.');
    let verdict = null;
    try { verdict = JSON.parse(readText(vf).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')); } catch {}
    const g = gate(verdict, pending);
    appendLog(proj, { manual: true, reviewer: 'subagent', decision: g.decision, summary: g.summary, counted: g.counted, dropped: g.dropped, ledger: g.ledger, reply: clip(pending.reply, 2000) });
    printVerdict(g, opt('model', 'subagent'));
    process.exitCode = g.decision === 'HALLUCINATION' ? 2 : g.decision === 'JUDGE_ERROR' ? 1 : 0;
    break;
  }
  case 'doctor': {
    const platform = detectPlatform();
    const node = process.versions.node;
    console.log(`assumption-judge ${VERSION} doctor`);
    console.log(`  node ${node}${Number(node.split('.')[0]) < 18 ? '  <- needs 18 or newer' : ''}`);
    console.log(`  app: ${platform || 'not detected (pass --platform to "on"; chat apps use relay mode, see references/platforms.md)'}`);
    const found = {};
    for (const r of RUNNERS) {
      found[r] = cliAvailable(r);
      console.log(`  judge runner ${r.padEnd(6)} ${found[r] ? `found: ${found[r]}` : 'not found'}`);
    }
    const live = { 'claude-code': ['claude'], antigravity: ['agy', 'claude'], codex: ['codex', 'claude'], cursor: ['claude', 'cursor'] };
    const usable = platform ? live[platform].filter((r) => found[r]) : RUNNERS.filter((r) => found[r]);
    if (platform && usable.length) console.log(`  -> live mode can run here: aj.mjs on --platform ${platform}${usable[0] !== defaultRunner(platform) ? ` --runner ${usable[0]}` : ''}  (details: the "${platform}" section of references/platforms.md)`);
    else if (usable.length) console.log(`  -> check mode works here: aj.mjs check --prompt-file p --reply-file r --runner ${usable[0]}`);
    else console.log('  -> no judge runner installed. Use check mode with a fresh judge subagent, or the human relay (references/platforms.md).');
    break;
  }
  case undefined: case 'help': case '--help': case '-h':
    console.log(HELP);
    break;
  default:
    die(`unknown command "${cmd}". Run "aj.mjs help".`);
}
