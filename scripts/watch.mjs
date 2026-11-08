// Hook handler for Claude Code. SKILL.md registers it when /assumption-judge is invoked:
//   UserPromptSubmit -> main('prompt')  sync, records the user's words verbatim
//   Stop             -> main('stop')    async + asyncRewake: judges in the background and
//                                        exits 2 (waking the main agent) only on HALLUCINATION
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  appendLog, earlierText, isManagementTurn, buildPacket, clip, gate, interruptMessage, isJudgeCommand, loadConfig, readJSON,
  readStdin, readTranscript, runJudge, sessionFile, traceText, turns, writeJSON,
} from './lib.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function main(mode, projArg) {
  if (process.env.ASSUMPTION_JUDGE_CHILD) return; // the judge's own process never judges itself
  let input = {};
  try { input = JSON.parse((await readStdin()) || '{}'); } catch {}
  const proj = projArg && !projArg.includes('${') && fs.existsSync(projArg) ? projArg : (input.cwd || process.cwd());
  const cfg = loadConfig(proj);
  if (!cfg.enabled) return;

  const sf = sessionFile(proj, input.session_id);
  const st = readJSON(sf, {});

  if (mode === 'prompt') {
    const prompt = String(input.prompt ?? '');
    writeJSON(sf, {
      ...st,
      prompt,
      prompt_id: input.prompt_id ?? null,
      prompt_at: new Date().toISOString(),
      interrupts: 0,
      skip_turn: isJudgeCommand(prompt),
    });
    return;
  }
  if (mode !== 'stop') return;

  // No user prompt recorded yet means the hooks registered mid-turn: this Stop ends the
  // activation turn itself, so there is nothing of the user's to judge against. Skip it.
  if (!st.prompt_at) { writeJSON(sf, { ...st, armed_at: new Date().toISOString() }); return; }
  if (st.skip_turn) return;

  const reply = String(input.last_assistant_message ?? '').trim();
  const base = { session: input.session_id, prompt_id: st.prompt_id ?? null };
  if (reply.length < cfg.min_reply_chars) return appendLog(proj, { ...base, decision: 'SKIPPED', why: 'short reply' });
  if ((st.interrupts || 0) >= cfg.max_interrupts) {
    return appendLog(proj, { ...base, decision: 'SKIPPED', why: `interrupt cap ${cfg.max_interrupts} reached for this prompt` });
  }

  await sleep(1500); // the transcript is written asynchronously; give it a moment
  const all = turns(readTranscript(input.transcript_path));
  const turn = all[all.length - 1] || { prompt: '', steps: [], model: '' };
  const prompt = st.prompt || turn.prompt;
  if (isJudgeCommand(prompt) || isManagementTurn(turn.steps)) return;
  const model = cfg.model === 'inherit' ? (turn.model || 'inherit') : cfg.model;

  const packet = buildPacket({ prompt, reply, trace: traceText(turn.steps), cwd: proj, web: cfg.web, earlier: earlierText(all, cfg.context_turns) });
  const res = runJudge({ runner: cfg.platform === 'claude-code' ? cfg.runner : 'claude', packet, model, cwd: proj, web: cfg.web, maxTurns: cfg.max_turns, timeoutS: cfg.timeout_s });
  const meta = { ms: res.ms, cost_usd: res.cost_usd, turns: res.turns, model };

  if (!res.ok) {
    appendLog(proj, { ...base, ...meta, decision: 'JUDGE_ERROR', error: res.error });
    const cur = readJSON(sf, {});
    if (!cur.error_reported) {
      writeJSON(sf, { ...cur, error_reported: true });
      process.stderr.write(`[assumption-judge] The judge could not run, so your last reply was NOT checked: ${clip(res.error, 400)}\nTell the user once, briefly. Later failures this session are only logged in .assumption-judge/log.jsonl.\n`);
      process.exitCode = 2;
    }
    return;
  }

  const g = gate(res.verdict, { reply, prompt });
  appendLog(proj, { ...base, ...meta, decision: g.decision, judge_said: g.judge_said, checked: g.checked, summary: g.summary, counted: g.counted, dropped: g.dropped, ledger: g.ledger, reply: clip(reply, 2000) });
  if (g.decision !== 'HALLUCINATION') return;

  const cur = readJSON(sf, {});
  writeJSON(sf, { ...cur, interrupts: (cur.interrupts || 0) + 1 });
  process.stderr.write(interruptMessage(g, model));
  process.exitCode = 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main(process.argv[2], process.argv[3]);
}
