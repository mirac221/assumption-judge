// Hooks for Codex (registered in <repo>/.codex/hooks.json by "aj.mjs on --platform codex"):
//   UserPromptSubmit -> main('prompt')  records the user's words verbatim
//   Stop             -> main('stop')    synchronous: judges the reply, and on HALLUCINATION prints
//                                        {"decision":"block","reason":...}, which Codex turns into a
//                                        continuation prompt for the agent
// Codex only runs these after the user trusts them with /hooks.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  appendLog, buildPacket, clip, codexTurn, gate, interruptMessage, isJudgeCommand, loadConfig, readJSON,
  readStdin, runJudge, sessionFile, traceText, writeJSON,
} from './lib.mjs';

const MARK = '[assumption-judge]';

export async function main(mode) {
  if (process.env.ASSUMPTION_JUDGE_CHILD) return; // the judge's own codex process never judges itself
  let input = {};
  try { input = JSON.parse((await readStdin()) || '{}'); } catch {}
  const proj = input.cwd && fs.existsSync(input.cwd) ? input.cwd : process.cwd();
  const cfg = loadConfig(proj);
  if (!cfg.enabled) return;

  const sf = sessionFile(proj, input.session_id);
  const st = readJSON(sf, {});

  if (mode === 'prompt') {
    const prompt = String(input.prompt ?? '');
    // Our own block reason comes back as a continuation prompt: it isn't the user's words.
    if (prompt.trimStart().startsWith(MARK)) return;
    writeJSON(sf, { ...st, prompt, prompt_at: new Date().toISOString(), interrupts: 0 });
    return;
  }
  if (mode !== 'stop') return;

  const turn = codexTurn(input.transcript_path);
  const prompt = String(st.prompt || turn.prompt || '').trim();
  const reply = String(input.last_assistant_message ?? turn.reply ?? '').trim();
  if (!prompt || isJudgeCommand(prompt)) return; // activation turn, or nothing to judge against

  const base = { session: input.session_id, platform: 'codex' };
  if (reply.length < cfg.min_reply_chars) return appendLog(proj, { ...base, decision: 'SKIPPED', why: 'short reply' });
  if ((st.interrupts || 0) >= cfg.max_interrupts) {
    return appendLog(proj, { ...base, decision: 'SKIPPED', why: `interrupt cap ${cfg.max_interrupts} reached for this prompt` });
  }

  const model = cfg.model === 'inherit' ? (input.model || turn.model || 'inherit') : cfg.model;
  const packet = buildPacket({ prompt, reply, trace: traceText(turn.steps), cwd: proj, web: cfg.web });
  const res = runJudge({ runner: cfg.runner, packet, model, cwd: proj, web: cfg.web, maxTurns: cfg.max_turns, timeoutS: cfg.timeout_s });
  const meta = { ms: res.ms, cost_usd: res.cost_usd, turns: res.turns, model, runner: cfg.runner };

  const block = (reason) => process.stdout.write(JSON.stringify({ decision: 'block', reason }));

  if (!res.ok) {
    appendLog(proj, { ...base, ...meta, decision: 'JUDGE_ERROR', error: res.error });
    if (!st.error_reported) {
      writeJSON(sf, { ...st, error_reported: true });
      block(`${MARK} The judge could not run, so your last reply was NOT checked: ${clip(res.error, 400)}\nTell the user once, briefly, then stop.`);
    }
    return;
  }

  const g = gate(res.verdict, { reply, prompt });
  appendLog(proj, { ...base, ...meta, decision: g.decision, judge_said: g.judge_said, checked: g.checked, summary: g.summary, counted: g.counted, dropped: g.dropped, reply: clip(reply, 2000) });
  if (g.decision !== 'HALLUCINATION') return;
  writeJSON(sf, { ...st, interrupts: (st.interrupts || 0) + 1 });
  block(interruptMessage(g, model));
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main(process.argv[2]);
