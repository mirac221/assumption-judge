// Hooks for Cursor (IDE and the Cursor CLI), registered in .cursor/hooks.json by "aj.mjs on --platform cursor"
// (or ~/.cursor/hooks.json with --global):
//   beforeSubmitPrompt  -> main('prompt')    records the user's words verbatim, never blocks
//   afterAgentResponse  -> main('response')  records the agent's final text for this generation
//   stop                -> main('stop')      synchronous: judges the reply. On HALLUCINATION it prints
//                                            {"followup_message": ...}, which Cursor submits as the next
//                                            message, so the agent corrects itself before you act on it.
// Built from Cursor's hooks docs (cursor.com/docs/hooks); input fields used: prompt, text, status,
// loop_count, conversation_id, generation_id, model, workspace_roots, transcript_path.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
  appendLog, buildPacket, clip, cursorTurns, earlierText, gate, interruptMessage, isJudgeCommand, isManagementTurn,
  loadConfig, readJSON, readStdin, runJudge, sessionFile, stateDir, traceText, writeJSON,
} from './lib.mjs';

const MARK = '[assumption-judge]';
const out = (obj) => process.stdout.write(JSON.stringify(obj ?? {}));

// Cursor may hand Windows roots over as "/c:/Users/..." URIs; turn them into real paths.
const fixRoot = (p) => {
  let s = String(p || '');
  if (s.startsWith('file://')) { try { s = new URL(s).pathname; } catch {} }
  s = decodeURIComponent(s);
  if (/^\/[a-zA-Z]:[\\/]/.test(s)) s = s.slice(1);
  return s;
};

/** Same scope rules as Antigravity: a workspace with its own config wins, otherwise ~/.assumption-judge/. */
function resolveScope(input) {
  const roots = [...(input.workspace_roots || []), process.env.CURSOR_PROJECT_DIR].map(fixRoot).filter(Boolean);
  const ws = roots.find((p) => fs.existsSync(p)) || null;
  const own = ws && fs.existsSync(path.join(stateDir(ws), 'config.json'));
  const stateRoot = own ? ws : os.homedir();
  let judgeCwd = ws;
  if (!judgeCwd) {
    judgeCwd = path.join(stateDir(os.homedir()), 'no-workspace');
    fs.mkdirSync(judgeCwd, { recursive: true });
  }
  return { ws, stateRoot, judgeCwd, cfg: loadConfig(stateRoot) };
}

// A workspace that has its own entry wins; the global hook stands down so nothing runs twice.
function workspaceHasOwnHook(ws) {
  const doc = ws ? readJSON(path.join(ws, '.cursor', 'hooks.json'), null) : null;
  return !!(doc && JSON.stringify(doc.hooks || {}).includes('cursor-hook.mjs'));
}

export async function main(mode = 'stop', scopeArg) {
  if (process.env.ASSUMPTION_JUDGE_CHILD) return out(mode === 'prompt' ? { continue: true } : {}); // the judge's own runs never judge themselves
  let input = {};
  try { input = JSON.parse((await readStdin()) || '{}'); } catch {}
  const scope = resolveScope(input);
  if (scopeArg === 'global' && workspaceHasOwnHook(scope.ws)) return out(mode === 'prompt' ? { continue: true } : {});
  const { cfg, stateRoot } = scope;
  if (!cfg.enabled) return out(mode === 'prompt' ? { continue: true } : {});

  const sf = sessionFile(stateRoot, input.conversation_id || input.session_id);
  const st = readJSON(sf, {});

  if (mode === 'prompt') {
    const prompt = String(input.prompt ?? '');
    // Our own follow-up message comes back as a prompt. It isn't the user's words, and it keeps the interrupt count.
    if (!prompt.trimStart().startsWith(MARK)) {
      const history = [...(st.history || []), ...(st.prompt ? [{ prompt: st.prompt, reply: st.reply || '' }] : [])].slice(-6);
      writeJSON(sf, { ...st, history, prompt, reply: '', prompt_at: new Date().toISOString(), interrupts: 0, skip_turn: isJudgeCommand(prompt) });
    }
    return out({ continue: true });
  }

  if (mode === 'response') {
    const text = String(input.text ?? '').trim();
    if (text) writeJSON(sf, { ...st, reply: text, reply_generation: input.generation_id || null });
    return out({});
  }

  if (mode !== 'stop') return out({});
  if (input.status && input.status !== 'completed') return out({});
  if (st.skip_turn) return out({});

  const all = input.transcript_path ? cursorTurns(input.transcript_path) : [];
  const turn = all.at(-1) || { prompt: '', reply: '', steps: [] };
  const prompt = String(st.prompt || turn.prompt || '').trim();
  const reply = String(st.reply || turn.reply || '').trim();
  if (!prompt || isJudgeCommand(prompt) || isManagementTurn(turn.steps)) return out({}); // activation turn, or nothing to judge against

  const base = { session: input.conversation_id, platform: 'cursor', workspace: scope.ws ? 'yes' : 'none' };
  if (reply.length < cfg.min_reply_chars) { appendLog(stateRoot, { ...base, decision: 'SKIPPED', why: 'short reply' }); return out({}); }
  const loops = Math.max(Number(input.loop_count) || 0, st.interrupts || 0);
  if (loops >= cfg.max_interrupts) {
    appendLog(stateRoot, { ...base, decision: 'SKIPPED', why: `interrupt cap ${cfg.max_interrupts} reached for this prompt` });
    return out({});
  }

  // Earlier context: from the transcript when Cursor writes one, otherwise from what the hooks recorded.
  const earlier = all.length > 1 ? earlierText(all, cfg.context_turns) : earlierText([...(st.history || []), { prompt }], cfg.context_turns);
  const model = cfg.model === 'inherit' ? (input.model || 'inherit') : cfg.model;
  const packet = buildPacket({ prompt, reply, trace: traceText(turn.steps), cwd: scope.judgeCwd, web: cfg.web, earlier })
    + (scope.ws ? '' : '\n\nNo project folder is open: judge project claims from the TRACE only, and facts from the web.')
    + (turn.steps.length ? '' : '\n\nNote: Cursor gave no tool trace for this turn, so a missing CALL is NOT evidence that the assistant did not do something. Judge claimed actions by checking the project files instead, or mark them unverifiable.');
  const res = runJudge({ runner: cfg.runner, packet, model, cwd: scope.judgeCwd, web: cfg.web, maxTurns: cfg.max_turns, timeoutS: cfg.timeout_s });
  const meta = { ms: res.ms, cost_usd: res.cost_usd, turns: res.turns, model, runner: cfg.runner, key: crypto.createHash('sha1').update(prompt).digest('hex').slice(0, 8) };

  if (!res.ok) {
    appendLog(stateRoot, { ...base, ...meta, decision: 'JUDGE_ERROR', error: res.error });
    if (!st.error_reported) {
      writeJSON(sf, { ...st, error_reported: true, interrupts: (st.interrupts || 0) + 1 });
      return out({ followup_message: `${MARK} The judge could not run, so your last reply was NOT checked: ${clip(res.error, 400)}\nTell the user once, briefly, then stop.` });
    }
    return out({});
  }

  const g = gate(res.verdict, { reply, prompt });
  appendLog(stateRoot, { ...base, ...meta, decision: g.decision, judge_said: g.judge_said, checked: g.checked, summary: g.summary, counted: g.counted, dropped: g.dropped, ledger: g.ledger, reply: clip(reply, 2000) });
  if (g.decision !== 'HALLUCINATION') return out({});
  writeJSON(sf, { ...readJSON(sf, {}), interrupts: (st.interrupts || 0) + 1 });
  return out({ followup_message: interruptMessage(g, model) });
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main(process.argv[2], process.argv[3]);
