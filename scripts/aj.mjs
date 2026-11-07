import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  DEFAULTS, MODELS, SKILL_DIR, VERSION, agyBin, appendLog, codexBin, buildPacket, claudeBin, clip, ensureStateDir, findTranscript,
  gate, interruptMessage, isJudgeCommand, loadConfig, readJSON, readLog, readTranscript, runJudge, saveConfig,
  stateDir, traceText, turns, writeJSON,
} from './lib.mjs';

const HELP = `assumption-judge ${VERSION}

  aj.mjs on [--platform claude-code|antigravity|codex] [--runner claude|agy|codex] [--model <alias|id>]
            [--max-interrupts 2] [--no-web]
        Turn live judging on for this project. Claude Code: the skill's hooks do the rest.
        Antigravity: also writes a Stop hook into <workspace>/.agents/hooks.json.
        Codex: also writes UserPromptSubmit + Stop hooks into <repo>/.codex/hooks.json (trust them with /hooks).
  aj.mjs off                      Stop judging. The hooks stay registered but do nothing.
  aj.mjs status                   Settings and the last verdicts.
  aj.mjs set <key> <value>        model | runner | max-interrupts | min-reply-chars | max-turns | timeout-s | web
  aj.mjs check [--transcript auto|<file>] [--prompt-file f --reply-file f [--trace-file f]] [--model m]
        Judge one reply now, synchronously (Claude Code: the last reply before this command).
  aj.mjs packet --prompt-file f --reply-file f [--trace-file f]
        Platforms without hooks: write the judge's packet and print the spawn message.
  aj.mjs gate --verdict <file>    Gate a verdict the judge subagent returned for the last packet.

State lives in .assumption-judge/ under the working directory (it git-ignores itself).`;

const argv = process.argv.slice(2);
const cmd = argv[0];
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i > -1 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const flag = (name) => argv.includes(`--${name}`);
const die = (msg) => { console.error(`assumption-judge: ${msg}`); process.exit(1); };
const proj = path.resolve(opt('dir', process.cwd()));
const readText = (f) => (f === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(path.resolve(f), 'utf8'));

function checkModel(m, runner = 'claude') {
  if (!m) return;
  if (!/^[\w.:-]+$/.test(m)) die(`invalid model "${m}"`);
  if (runner === 'claude' && !MODELS.includes(m) && !/^claude-[\w.-]+$/.test(m)) {
    die(`unknown model "${m}" for the claude runner. Use ${MODELS.join(' | ')} or a full claude-* id.`);
  }
}

const RUNNERS = ['claude', 'agy', 'codex'];
const binFor = (runner) => (runner === 'agy' ? agyBin() : runner === 'codex' ? codexBin() : claudeBin());
const envFor = (runner) => (runner === 'agy' ? 'ASSUMPTION_JUDGE_AGY' : runner === 'codex' ? 'ASSUMPTION_JUDGE_CODEX' : 'ASSUMPTION_JUDGE_CLAUDE');

function cliAvailable(runner) {
  const r = spawnSync(binFor(runner), ['--version'], { encoding: 'utf8', timeout: 20000, windowsHide: true });
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

// Antigravity has no skill-scoped hooks: the Stop hook lives in <workspace>/.agents/hooks.json.
const HOOK_NAME = 'assumption-judge';
function setAgyHook(enabled) {
  const file = path.join(proj, '.agents', 'hooks.json');
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
      '  .then((m) => m.main())',
      "  .catch((e) => { process.stderr.write(String(e && e.stack || e)); process.stdout.write('{}'); });",
      '',
    ].join('\n'));
    hooks[HOOK_NAME] = {
      enabled: true,
      Stop: [{ type: 'command', command: `node ${HOOK_NAME}-hook.cjs`, timeout: 600 }],
    };
  } else if (hooks[HOOK_NAME]) {
    hooks[HOOK_NAME].enabled = false;
  } else return null;
  writeJSON(file, hooks);
  return file;
}

const detectPlatform = () => (process.env.ANTIGRAVITY_CONVERSATION_ID || process.env.ANTIGRAVITY_AGENT ? 'antigravity'
  : Object.keys(process.env).some((k) => /^CODEX_/.test(k)) && !process.env.CLAUDECODE ? 'codex' : 'claude-code');

// Codex: prefer its own CLI as the judge; fall back to the claude CLI if only that one is installed.
function defaultRunner(platform) {
  if (platform === 'antigravity') return 'agy';
  if (platform === 'codex') return cliAvailable('codex') || !cliAvailable('claude') ? 'codex' : 'claude';
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
    const platform = opt('platform', detectPlatform());
    if (!['claude-code', 'antigravity', 'codex'].includes(platform)) die('--platform must be claude-code, antigravity or codex (other apps: use check mode)');
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
      web: flag('no-web') ? false : cfg.web,
      max_interrupts: Number(opt('max-interrupts', cfg.max_interrupts)),
      skill_dir: SKILL_DIR,
      version: VERSION,
      enabled_at: new Date().toISOString(),
    };
    saveConfig(proj, next);
    const hookFile = platform === 'antigravity' ? setAgyHook(true) : platform === 'codex' ? setCodexHook(true) : null;
    const cli = cliAvailable(runner);
    console.log(`assumption-judge ON in ${proj} (${platform})`);
    console.log(`  judge model: ${model}${model === 'inherit' ? ' (whatever model wrote the reply)' : ''} · runner: ${runner} · web: ${next.web ? 'on' : 'off'} · max interrupts per prompt: ${next.max_interrupts}`);
    console.log(cli
      ? `  judge runner: ${binFor(runner)} (${cli})`
      : `  WARNING: the ${runner} CLI was not found, so the live judge cannot run. Set ${envFor(runner)} to its path, pick another --runner, or use check mode.`);
    if (hookFile && platform === 'codex') {
      console.log(`  UserPromptSubmit + Stop hooks written to ${hookFile}.`);
      console.log('  ACTION NEEDED: Codex runs project hooks only after you trust them. Run /hooks in Codex, review the two assumption-judge hooks, and trust them (the project .codex/ folder must be trusted too).');
      console.log('  Codex hooks are synchronous: each reply pauses while the judge runs. You are only interrupted on HALLUCINATION.');
    } else if (hookFile) {
      console.log(`  Stop hook written to ${hookFile} (entry "${HOOK_NAME}").`);
      console.log('  Antigravity hooks are synchronous: each reply pauses while the judge runs (~25 s with Gemini Flash). You are only interrupted on HALLUCINATION.');
    } else {
      console.log('  Every reply from the next user message on gets judged in the background. You are only interrupted on HALLUCINATION.');
    }
    break;
  }
  case 'off': {
    const cfg = loadConfig(proj);
    saveConfig(proj, { ...cfg, enabled: false });
    const agyFile = setAgyHook(false);
    const codexFile = setCodexHook(false);
    console.log('assumption-judge OFF.');
    if (agyFile) console.log(`  The "${HOOK_NAME}" entry in ${agyFile} is now disabled.`);
    if (codexFile) console.log(`  Its hooks were removed from ${codexFile}.`);
    if (!agyFile && !codexFile) console.log('  Claude Code hooks stay registered until the session ends but do nothing.');
    break;
  }
  case 'set': {
    const [key, value] = [argv[1], argv[2]];
    if (!key || value === undefined) die('usage: aj.mjs set <key> <value>');
    const cfg = loadConfig(proj);
    const k = key.replace(/-/g, '_');
    if (!(k in DEFAULTS) || k === 'enabled' || k === 'platform') die(`unknown key "${key}"`);
    if (k === 'model') checkModel(value, cfg.runner);
    if (k === 'runner' && !RUNNERS.includes(value)) die(`runner must be one of ${RUNNERS.join(', ')}`);
    cfg[k] = ['model', 'runner'].includes(k) ? value : k === 'web' ? !/^(false|off|0|no)$/i.test(value) : Number(value);
    if (typeof cfg[k] === 'number' && !Number.isFinite(cfg[k])) die(`${key} needs a number`);
    saveConfig(proj, cfg);
    console.log(`${key} = ${cfg[k]}`);
    break;
  }
  case 'status': {
    const cfg = loadConfig(proj);
    const log = readLog(proj);
    const count = (d) => log.filter((r) => r.decision === d).length;
    console.log(`assumption-judge ${VERSION}: ${cfg.enabled ? 'ON' : 'OFF'} · ${cfg.platform} · runner ${cfg.runner} · model ${cfg.model} · web ${cfg.web ? 'on' : 'off'} · cap ${cfg.max_interrupts}/prompt`);
    console.log(`verdicts: ${count('PASS')} PASS · ${count('HALLUCINATION')} HALLUCINATION · ${count('JUDGE_ERROR')} errors · ${count('SKIPPED')} skipped`);
    const cost = log.reduce((a, r) => a + (typeof r.cost_usd === 'number' ? r.cost_usd : 0), 0);
    if (cost) console.log(`judge cost so far (API-equivalent, as reported by the CLI): ~$${cost.toFixed(2)}`);
    for (const r of log.slice(-5)) {
      const what = r.decision === 'HALLUCINATION' ? r.counted?.map((c) => `${c.id} ${c.status}: "${clip(c.quote, 60)}"`).join(' | ')
        : r.error || r.why || r.summary || '';
      console.log(`  ${r.at?.slice(11, 19) ?? ''} ${r.decision} ${clip(what, 160)}`);
    }
    break;
  }
  case 'check': {
    const cfg = loadConfig(proj);
    const model = opt('model', cfg.model);
    checkModel(model, cfg.runner);
    let prompt, reply, trace, turnModel = '';
    if (opt('reply-file')) {
      reply = readText(opt('reply-file'));
      prompt = opt('prompt-file') ? readText(opt('prompt-file')) : '';
      trace = opt('trace-file') ? readText(opt('trace-file')) : '(no trace given)';
    } else {
      const t = opt('transcript', 'auto');
      const file = t === 'auto' ? findTranscript(proj) : path.resolve(t);
      if (!file) die('no transcript found for this folder. Pass --transcript <file> or --prompt-file/--reply-file.');
      const done = turns(readTranscript(file)).filter((x) => !isJudgeCommand(x.prompt) && x.reply.trim());
      const last = done[done.length - 1];
      if (!last) die(`no finished reply found in ${file}`);
      ({ prompt, reply } = last);
      trace = traceText(last.steps);
      turnModel = last.model;
    }
    const m = model === 'inherit' ? (turnModel || 'inherit') : model;
    console.error(`assumption-judge: judging with ${m}${cfg.web ? ' + web' : ''}…`);
    const res = runJudge({ runner: cfg.runner, packet: buildPacket({ prompt, reply, trace, cwd: proj, web: cfg.web }), model: m, cwd: proj, web: cfg.web, maxTurns: cfg.max_turns, timeoutS: cfg.timeout_s });
    if (!res.ok) { appendLog(proj, { decision: 'JUDGE_ERROR', manual: true, error: res.error, model: m }); die(res.error); }
    const g = gate(res.verdict, { reply, prompt });
    appendLog(proj, { manual: true, decision: g.decision, judge_said: g.judge_said, checked: g.checked, model: m, ms: res.ms, cost_usd: res.cost_usd, turns: res.turns, summary: g.summary, counted: g.counted, dropped: g.dropped, reply: clip(reply, 2000) });
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
    fs.writeFileSync(packetPath, buildPacket({ prompt, reply, trace, cwd: proj, web: cfg.web })
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
    appendLog(proj, { manual: true, reviewer: 'subagent', decision: g.decision, summary: g.summary, counted: g.counted, dropped: g.dropped, reply: clip(pending.reply, 2000) });
    printVerdict(g, opt('model', 'subagent'));
    process.exitCode = g.decision === 'HALLUCINATION' ? 2 : g.decision === 'JUDGE_ERROR' ? 1 : 0;
    break;
  }
  case undefined: case 'help': case '--help': case '-h':
    console.log(HELP);
    break;
  default:
    die(`unknown command "${cmd}". Run "aj.mjs help".`);
}
