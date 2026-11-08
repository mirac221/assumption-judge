// Runs the judge on every case in cases.json against the fixture repo, and scores it.
//   node evals/run.mjs --runner agy --model gemini-3.8-flash-high
//   node evals/run.mjs --runner claude --model sonnet --concurrency 2
//   node evals/run.mjs --aj /path/to/another/aj.mjs        compare another version of the skill
// Cases: N* are real replies from Claude Haiku agents (a good judge stays quiet), P* are planted
// hallucinations (a good judge catches them), E* test the earlier-context block.
// Every judge run costs one model call with possible web searches, on your plan.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i > -1 && argv[i + 1] ? argv[i + 1] : d; };
const AJ = path.resolve(opt('aj', path.join(HERE, '..', 'scripts', 'aj.mjs')));
const runner = opt('runner', 'claude');
const model = opt('model', runner === 'claude' ? 'sonnet' : 'inherit');
const conc = Number(opt('concurrency', 1));
const only = opt('only', '');
const cases = JSON.parse(fs.readFileSync(path.join(HERE, 'cases.json'), 'utf8')).filter((c) => !only || only.split(',').includes(c.id));

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'aj-eval-'));
const proj = path.join(work, 'shopapi');
fs.cpSync(path.join(HERE, 'fixture', 'shopapi'), proj, { recursive: true });

const node = (args) => new Promise((res) => {
  const p = spawn(process.execPath, [AJ, ...args], { cwd: proj, env: { ...process.env, CLAUDECODE: '' } });
  let out = '', err = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { err += d; });
  p.on('close', (code) => res({ code, out, err }));
});
await node(['set', 'runner', runner]);
await node(['set', 'model', model]);
const supportsEarlier = fs.readFileSync(AJ, 'utf8').includes('earlier-file');

console.log(`judge: ${runner} / ${model} · skill: ${AJ} · ${cases.length} cases · fixture copy: ${proj}\n`);
const results = [];
let next = 0;
async function worker() {
  while (next < cases.length) {
    const c = cases[next++];
    const io = path.join(work, 'io', c.id);
    fs.mkdirSync(io, { recursive: true });
    const f = (n, v) => { const p = path.join(io, n); fs.writeFileSync(p, v); return p; };
    const args = ['check', '--prompt-file', f('p.txt', c.prompt), '--reply-file', f('r.txt', c.reply), '--trace-file', f('t.txt', c.trace)];
    if (c.earlier && supportsEarlier) args.push('--earlier-file', f('e.txt', c.earlier));
    const t0 = Date.now();
    const r = await node(args);
    const decision = /\] HALLUCINATION/.test(r.out) ? 'HALLUCINATION' : /\] PASS/.test(r.out) ? 'PASS' : 'ERROR';
    const ok = c.expect === 'EITHER' ? decision !== 'ERROR' : decision === c.expect;
    results.push({ id: c.id, kind: c.kind, expect: c.expect, decision, ok });
    console.log(`${c.id.padEnd(3)} ${decision.padEnd(13)} expected ${c.expect.padEnd(13)} ${ok ? 'ok' : 'MISS'}  ${Math.round((Date.now() - t0) / 1000)}s${decision === 'ERROR' ? `  ${r.err.trim().split('\n').pop()}` : ''}`);
  }
}
await Promise.all(Array.from({ length: conc }, worker));
const score = (k) => { const a = results.filter((r) => r.kind === k); return `${a.filter((r) => r.ok).length}/${a.length}`; };
console.log(`\nquiet on real replies ${score('natural')} · caught planted ${score('planted')} · earlier context ${score('earlier')} · errors ${results.filter((r) => r.decision === 'ERROR').length}`);
