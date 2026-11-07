// Hooks for Antigravity (app, CLI, IDE), registered in a hooks.json by "aj.mjs on --platform antigravity":
//   <workspace>/.agents/hooks.json  for one workspace
//   ~/.gemini/config/hooks.json     with --global, which also covers chats with no workspace open
//
// Antigravity hooks are synchronous. Two modes:
//   sync      Stop judges the reply before the turn ends; on HALLUCINATION it returns
//             {"decision":"continue","reason":...} and the agent goes straight back to work.
//   deferred  Stop starts a detached judge and returns at once (no freeze). PreInvocation delivers a
//             HALLUCINATION verdict as a system message before the next model call, i.e. at the start
//             of your next message.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  agyTurn, appendLog, buildPacket, clip, gate, interruptMessage, isJudgeCommand, loadConfig, readJSON,
  readStdin, runJudge, sessionFile, stateDir, traceText, writeJSON,
} from './lib.mjs';

const SELF = fileURLToPath(import.meta.url);
const out = (obj) => process.stdout.write(JSON.stringify(obj ?? {}));

/**
 * Where config and state live, and where the judge runs.
 * A workspace with its own .assumption-judge/config.json uses that. Otherwise the global scope
 * (~/.assumption-judge/) applies, and with no workspace the judge gets an empty private folder,
 * so it never sees (or lists) anything from your home directory.
 */
export function resolveScope(input) {
  const ws = (input.workspacePaths || []).find((p) => p && fs.existsSync(p)) || null;
  const own = ws && fs.existsSync(path.join(stateDir(ws), 'config.json'));
  const stateRoot = own ? ws : os.homedir();
  let judgeCwd = ws;
  if (!judgeCwd) {
    judgeCwd = path.join(stateDir(os.homedir()), 'no-workspace');
    fs.mkdirSync(judgeCwd, { recursive: true });
  }
  return { ws, stateRoot, judgeCwd, cfg: loadConfig(stateRoot) };
}

function judgeTurn({ input, scope, prompt, answer, steps }) {
  const { cfg, stateRoot, judgeCwd, ws } = scope;
  const model = cfg.model === 'inherit' ? (input.modelName || 'inherit') : cfg.model;
  const packet = buildPacket({
    prompt, reply: answer, trace: traceText(steps), cwd: judgeCwd, web: cfg.web,
  }) + (ws ? '' : '\n\nNo project folder is open in this chat: judge project claims from the TRACE only, and facts from the web.');
  const res = runJudge({ runner: cfg.runner, packet, model, cwd: judgeCwd, web: cfg.web, maxTurns: cfg.max_turns, timeoutS: cfg.timeout_s });
  const base = { session: input.conversationId, platform: 'antigravity', mode: cfg.mode, workspace: ws ? 'yes' : 'none' };
  const meta = { ms: res.ms, turns: res.turns, model, runner: cfg.runner, retried: res.retried || undefined };
  if (!res.ok) {
    appendLog(stateRoot, { ...base, ...meta, decision: 'JUDGE_ERROR', error: res.error });
    return { error: res.error, model };
  }
  const g = gate(res.verdict, { reply: answer, prompt });
  appendLog(stateRoot, { ...base, ...meta, decision: g.decision, judge_said: g.judge_said, checked: g.checked, summary: g.summary, counted: g.counted, dropped: g.dropped, reply: clip(answer, 2000) });
  return { g, model };
}

async function onStop(input) {
  const scope = resolveScope(input);
  const { cfg, stateRoot } = scope;
  if (!cfg.enabled) return out({});
  if (input.terminationReason && input.terminationReason !== 'NO_TOOL_CALL') return out({});

  const turn = agyTurn(input.transcriptPath);
  const prompt = String(input.lastUserInput || turn.prompt || '').trim();
  const answer = String(turn.reply || '').trim();
  if (!prompt || isJudgeCommand(prompt)) return out({});

  const sf = sessionFile(stateRoot, input.conversationId);
  const promptKey = crypto.createHash('sha1').update(prompt).digest('hex');
  let st = readJSON(sf, {});
  if (st.prompt_key !== promptKey) st = { ...st, prompt_key: promptKey, interrupts: 0 };
  writeJSON(sf, st);

  const base = { session: input.conversationId, platform: 'antigravity' };
  if (answer.length < cfg.min_reply_chars) { appendLog(stateRoot, { ...base, decision: 'SKIPPED', why: 'short reply' }); return out({}); }
  if ((st.interrupts || 0) >= cfg.max_interrupts) {
    appendLog(stateRoot, { ...base, decision: 'SKIPPED', why: `interrupt cap ${cfg.max_interrupts} reached for this prompt` });
    return out({});
  }

  if (cfg.mode === 'deferred') {
    // Hand the turn to a detached worker and return immediately: no freeze.
    const job = path.join(stateDir(stateRoot), 'jobs', `${Date.now()}-${process.pid}.json`);
    writeJSON(job, { input, prompt, answer, steps: turn.steps, prompt_key: promptKey });
    const child = spawn(process.execPath, [SELF, 'bg', job], { detached: true, stdio: 'ignore', windowsHide: true, env: process.env });
    child.unref();
    return out({});
  }

  const { g, error, model } = judgeTurn({ input, scope, prompt, answer, steps: turn.steps });
  if (error) {
    if (!st.error_reported) {
      writeJSON(sf, { ...st, error_reported: true });
      return out({ decision: 'continue', reason: `[assumption-judge] The judge could not run, so your last reply was NOT checked: ${clip(error, 400)}\nTell the user once, briefly, then stop.` });
    }
    return out({});
  }
  if (g.decision !== 'HALLUCINATION') return out({});
  writeJSON(sf, { ...st, interrupts: (st.interrupts || 0) + 1 });
  return out({ decision: 'continue', reason: interruptMessage(g, model) });
}

// Deferred mode, detached worker: judge the saved turn and leave a verdict for PreInvocation to deliver.
async function onBackground(jobFile) {
  const job = readJSON(jobFile, null);
  try { fs.rmSync(jobFile, { force: true }); } catch {}
  if (!job) return;
  const scope = resolveScope(job.input);
  const { g, error, model } = judgeTurn({ input: job.input, scope, prompt: job.prompt, answer: job.answer, steps: job.steps });
  const sf = sessionFile(scope.stateRoot, job.input.conversationId);
  const st = readJSON(sf, {});
  if (error) {
    if (!st.error_reported) writeJSON(sf, { ...st, error_reported: true, pending: { kind: 'error', text: error } });
    return;
  }
  if (g.decision !== 'HALLUCINATION') return;
  writeJSON(sf, { ...st, interrupts: (st.interrupts || 0) + 1, pending: { kind: 'hallucination', text: interruptMessage(g, model), at: new Date().toISOString() } });
}

// Deferred mode: before the model runs, hand over any verdict that arrived since the last reply.
async function onPreInvocation(input) {
  const scope = resolveScope(input);
  if (!scope.cfg.enabled || scope.cfg.mode !== 'deferred') return out({});
  const sf = sessionFile(scope.stateRoot, input.conversationId);
  const st = readJSON(sf, {});
  if (!st.pending) return out({});
  writeJSON(sf, { ...st, pending: null, delivered_at: new Date().toISOString() });
  const text = st.pending.kind === 'error'
    ? `[assumption-judge] The judge could not check your previous reply: ${clip(st.pending.text, 400)}\nTell the user once, briefly, before anything else.`
    : `${st.pending.text}\nThis is about your PREVIOUS reply (the judge ran in the background). Before answering the new message, tell the user what was wrong and correct it.`;
  return out({ injectSteps: [{ systemMessage: { systemMessage: text } }] });
}

// A workspace with its own enabled entry wins; the global hook then stands down so nothing runs twice.
function workspaceHasOwnHook(input) {
  const ws = (input.workspacePaths || []).find((p) => p && fs.existsSync(p));
  return !!(ws && readJSON(path.join(ws, '.agents', 'hooks.json'), {})?.['assumption-judge']?.enabled);
}

export async function main(mode = 'stop', arg) {
  if (process.env.ASSUMPTION_JUDGE_CHILD) return mode === 'bg' ? undefined : out({}); // the judge's own agy runs never judge themselves
  if (mode === 'bg') return onBackground(arg);
  let input = {};
  try { input = JSON.parse((await readStdin()) || '{}'); } catch {}
  if (arg === 'global' && workspaceHasOwnHook(input)) return out({});
  if (mode === 'pre') return onPreInvocation(input);
  return onStop(input);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main(process.argv[2], process.argv[3]);
