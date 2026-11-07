import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  DEFAULTS, MODELS, SKILL_DIR, VERSION, appendLog, buildPacket, claudeBin, clip, ensureStateDir, findTranscript,
  gate, interruptMessage, isJudgeCommand, loadConfig, readJSON, readLog, readTranscript, runJudge, saveConfig,
  stateDir, traceText, turns, writeJSON,
} from './lib.mjs';

const HELP = `assumption-judge ${VERSION}

  aj.mjs on [--model sonnet|opus|haiku|fable|inherit|<id>] [--max-interrupts 2] [--no-web]
        Turn live watching on for this project (Claude Code hooks do the rest).
  aj.mjs off                      Stop judging. The hooks stay registered but do nothing.
  aj.mjs status                   Settings and the last verdicts.
  aj.mjs set <key> <value>        model | max-interrupts | min-reply-chars | max-turns | timeout-s | web
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

function checkModel(m) {
  if (!m) return;
  if (!MODELS.includes(m) && !/^claude-[\w.-]+$/.test(m)) die(`unknown model "${m}". Use ${MODELS.join(' | ')} or a full claude-* id.`);
}

function cliAvailable() {
  const r = spawnSync(claudeBin(), ['--version'], { encoding: 'utf8', timeout: 20000, windowsHide: true });
  return r.error ? null : String(r.stdout || '').trim();
}

function printVerdict(g, model) {
  if (g.decision === 'HALLUCINATION') { process.stdout.write(interruptMessage(g, model)); return; }
  console.log(`[assumption-judge] ${g.decision}${g.summary ? `: ${g.summary}` : ''}`);
  if (g.dropped?.length) console.log(`  ${g.dropped.length} lower-grade note(s) logged, none interrupting.`);
}

switch (cmd) {
  case 'on': {
    const cfg = loadConfig(proj);
    const model = opt('model', cfg.model);
    checkModel(model);
    const next = {
      ...cfg,
      enabled: true,
      model,
      web: flag('no-web') ? false : cfg.web,
      max_interrupts: Number(opt('max-interrupts', cfg.max_interrupts)),
      skill_dir: SKILL_DIR,
      version: VERSION,
      enabled_at: new Date().toISOString(),
    };
    saveConfig(proj, next);
    const cli = cliAvailable();
    console.log(`assumption-judge ON in ${proj}`);
    console.log(`  judge model: ${model}${model === 'inherit' ? ' (whatever model wrote the reply)' : ''} · web: ${next.web ? 'on' : 'off'} · max interrupts per prompt: ${next.max_interrupts}`);
    console.log(cli
      ? `  judge runner: ${claudeBin()} (${cli})`
      : '  WARNING: the claude CLI was not found, so the live judge cannot run. Set ASSUMPTION_JUDGE_CLAUDE to its path, or use the subagent mode in SKILL.md.');
    console.log('  Every reply from the next user message on gets judged in the background. You are only interrupted on HALLUCINATION.');
    break;
  }
  case 'off': {
    const cfg = loadConfig(proj);
    saveConfig(proj, { ...cfg, enabled: false });
    console.log('assumption-judge OFF. Hooks stay registered until the session ends but do nothing.');
    break;
  }
  case 'set': {
    const [key, value] = [argv[1], argv[2]];
    if (!key || value === undefined) die('usage: aj.mjs set <key> <value>');
    const cfg = loadConfig(proj);
    const k = key.replace(/-/g, '_');
    if (!(k in DEFAULTS) || k === 'enabled') die(`unknown key "${key}"`);
    if (k === 'model') checkModel(value);
    cfg[k] = k === 'model' ? value : k === 'web' ? !/^(false|off|0|no)$/i.test(value) : Number(value);
    if (typeof cfg[k] === 'number' && !Number.isFinite(cfg[k])) die(`${key} needs a number`);
    saveConfig(proj, cfg);
    console.log(`${key} = ${cfg[k]}`);
    break;
  }
  case 'status': {
    const cfg = loadConfig(proj);
    const log = readLog(proj);
    const count = (d) => log.filter((r) => r.decision === d).length;
    console.log(`assumption-judge ${VERSION}: ${cfg.enabled ? 'ON' : 'OFF'} · model ${cfg.model} · web ${cfg.web ? 'on' : 'off'} · cap ${cfg.max_interrupts}/prompt`);
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
    checkModel(model);
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
    const res = runJudge({ packet: buildPacket({ prompt, reply, trace, cwd: proj, web: cfg.web }), model: m, cwd: proj, web: cfg.web, maxTurns: cfg.max_turns, timeoutS: cfg.timeout_s });
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
