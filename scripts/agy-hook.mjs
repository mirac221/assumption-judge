// Stop hook for Antigravity (registered in <workspace>/.agents/hooks.json by "aj.mjs on --platform antigravity").
// Antigravity hooks are synchronous: this runs the judge right after each reply, and on HALLUCINATION
// returns {"decision":"continue","reason":...}, which puts the agent back in its loop with the correction.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
  agyTurn, appendLog, buildPacket, clip, gate, interruptMessage, isJudgeCommand, loadConfig, readJSON,
  readStdin, runJudge, sessionFile, traceText, writeJSON,
} from './lib.mjs';

const reply = (obj) => process.stdout.write(JSON.stringify(obj ?? {}));

export async function main() {
  if (process.env.ASSUMPTION_JUDGE_CHILD) return reply({}); // the judge's own agy session never judges itself
  let input = {};
  try { input = JSON.parse((await readStdin()) || '{}'); } catch {}
  const proj = (input.workspacePaths || [])[0] || process.cwd();
  if (!fs.existsSync(proj)) return reply({});
  const cfg = loadConfig(proj);
  if (!cfg.enabled) return reply({});
  if (input.terminationReason && input.terminationReason !== 'NO_TOOL_CALL') return reply({});

  const turn = agyTurn(input.transcriptPath);
  const prompt = String(input.lastUserInput || turn.prompt || '').trim();
  const answer = String(turn.reply || '').trim();
  if (!prompt || isJudgeCommand(prompt)) return reply({}); // activation turn or nothing to judge against

  const sf = sessionFile(proj, input.conversationId);
  const promptKey = crypto.createHash('sha1').update(prompt).digest('hex');
  let st = readJSON(sf, {});
  if (st.prompt_key !== promptKey) st = { ...st, prompt_key: promptKey, interrupts: 0 };
  writeJSON(sf, st);

  const base = { session: input.conversationId, platform: 'antigravity' };
  if (answer.length < cfg.min_reply_chars) { appendLog(proj, { ...base, decision: 'SKIPPED', why: 'short reply' }); return reply({}); }
  if ((st.interrupts || 0) >= cfg.max_interrupts) {
    appendLog(proj, { ...base, decision: 'SKIPPED', why: `interrupt cap ${cfg.max_interrupts} reached for this prompt` });
    return reply({});
  }

  const model = cfg.model === 'inherit' ? (input.modelName || 'inherit') : cfg.model;
  const packet = buildPacket({ prompt, reply: answer, trace: traceText(turn.steps), cwd: proj, web: cfg.web });
  const res = runJudge({ runner: cfg.runner, packet, model, cwd: proj, web: cfg.web, maxTurns: cfg.max_turns, timeoutS: cfg.timeout_s });
  const meta = { ms: res.ms, cost_usd: res.cost_usd, turns: res.turns, model, runner: cfg.runner };

  if (!res.ok) {
    appendLog(proj, { ...base, ...meta, decision: 'JUDGE_ERROR', error: res.error });
    if (!st.error_reported) {
      writeJSON(sf, { ...st, error_reported: true });
      return reply({ decision: 'continue', reason: `[assumption-judge] The judge could not run, so your last reply was NOT checked: ${clip(res.error, 400)}\nTell the user once, briefly, then stop.` });
    }
    return reply({});
  }

  const g = gate(res.verdict, { reply: answer, prompt });
  appendLog(proj, { ...base, ...meta, decision: g.decision, judge_said: g.judge_said, checked: g.checked, summary: g.summary, counted: g.counted, dropped: g.dropped, reply: clip(answer, 2000) });
  if (g.decision !== 'HALLUCINATION') return reply({});
  writeJSON(sf, { ...st, interrupts: (st.interrupts || 0) + 1 });
  return reply({ decision: 'continue', reason: interruptMessage(g, model) });
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main();
