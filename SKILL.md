---
name: assumption-judge
description: Command-only. Run this skill only when the user invokes it by name (/assumption-judge, $assumption-judge, @assumption-judge, or "use assumption-judge"). Never load it on your own. When invoked, it turns on an independent judge agent that runs in parallel, reads the user's message and your reply, fact-checks the reply with its own knowledge, the project files and web search, and writes PASS or HALLUCINATION. It interrupts you only on HALLUCINATION, with evidence.
argument-hint: "[on|off|status|check|model <name>]"
allowed-tools: Bash(node ${CLAUDE_SKILL_DIR}/scripts/aj.mjs *)
license: Apache-2.0
compatibility: Needs Node 18+. Live mode runs on Claude Code (CLI, desktop app or IDE; in parallel, via the claude CLI) and Antigravity (a synchronous Stop hook, via the agy CLI). Codex, Cursor and other agent apps with a shell get check mode (a judge subagent per reply). Not for chat-only uploads such as claude.ai skills.
metadata:
  version: "0.2.0"
hooks:
  UserPromptSubmit:
    - hooks:
        - type: command
          command: node
          args: ["-e", "const p=require('path'),f=require('fs'),u=require('url');const a=process.argv.slice(1);let d=a[1]||'';if(!d||d.indexOf('$')>-1)d=process.cwd();const c=[process.env.CLAUDE_PLUGIN_ROOT];try{c.push(JSON.parse(f.readFileSync(p.join(d,'.assumption-judge','config.json'),'utf8')).skill_dir)}catch(e){}const s=c.filter(Boolean).map(x=>p.join(x,'scripts','watch.mjs')).find(x=>f.existsSync(x));if(s)import(u.pathToFileURL(s).href).then(w=>w.main(a[0],d));", "prompt", "${CLAUDE_PROJECT_DIR}"]
          timeout: 15
  Stop:
    - hooks:
        - type: command
          command: node
          args: ["-e", "const p=require('path'),f=require('fs'),u=require('url');const a=process.argv.slice(1);let d=a[1]||'';if(!d||d.indexOf('$')>-1)d=process.cwd();const c=[process.env.CLAUDE_PLUGIN_ROOT];try{c.push(JSON.parse(f.readFileSync(p.join(d,'.assumption-judge','config.json'),'utf8')).skill_dir)}catch(e){}const s=c.filter(Boolean).map(x=>p.join(x,'scripts','watch.mjs')).find(x=>f.existsSync(x));if(s)import(u.pathToFileURL(s).href).then(w=>w.main(a[0],d));", "stop", "${CLAUDE_PROJECT_DIR}"]
          async: true
          asyncRewake: true
          timeout: 600
---

# assumption-judge

You don't get to fact-check yourself.

Once this is on, every reply you finish goes to a separate judge: a fresh agent that never sees your reasoning, only the user's words, your reply, and what your tools actually returned this turn. It checks your claims against its own knowledge, the project files and the web, and it writes **PASS** or **HALLUCINATION**. A gate script throws out any judge finding that isn't quoted verbatim from your reply and backed by evidence, so the judge can't hallucinate hallucinations either.

You hear from it **only** when it catches something. A PASS is silent.

Why: the model that wrote the answer reads its own intent into it. It "remembers" the flag it meant to look up, the file it assumed it read, the API that sounded right. An agent with no stake in the answer has to check.

`<skill>` below is the folder this file is in (in Claude Code: `${CLAUDE_SKILL_DIR}`). The scripts are plain Node 18+ with no install step. State goes in `.assumption-judge/` under the working directory, and that folder git-ignores itself.

## Commands

The user's argument picks one. No argument means `on`.

| Invocation | You do |
|---|---|
| `/assumption-judge` or `on` | Steps 1 to 3 below |
| `off` | `node <skill>/scripts/aj.mjs off`, then confirm in one line |
| `status` | `node <skill>/scripts/aj.mjs status`, then relay it |
| `check` | `node <skill>/scripts/aj.mjs check`: judges your last reply right now, synchronously |
| `model <name>` | `node <skill>/scripts/aj.mjs set model <name>`, then confirm |

## Turning it on

### 1. Ask which model the judge runs on (once, only where the platform allows it)

Skip this if the user already named a model, or `.assumption-judge/config.json` already has one they chose.

- **Claude Code / Claude desktop app:** ask with AskUserQuestion. Question: "Which model should the assumption judge run on? It runs once after every reply, with web search." Options:
  - `Sonnet (Recommended)`: good fact-checker, moderate cost
  - `Opus`: strictest, catches subtle errors, most quota
  - `Haiku`: cheapest and fastest, but misses subtle errors and is more likely to raise false alarms
  - `Same as me`: the model that wrote the reply (`inherit`)
- **Antigravity:** run `agy models` and ask in chat which one the judge should use, or "same as me" (`inherit`). Recommend a stronger model than the cheapest flash tier.
- **Codex:** ask in chat.
- **Anything else:** ask only if you can actually choose a subagent's model there.

Be straight about cost: one judge run per reply, each with possible web searches, on the user's plan.

### 2. Switch it on

Claude Code:
```bash
node <skill>/scripts/aj.mjs on --model sonnet
```
Models: `sonnet`, `opus`, `haiku`, `fable`, `inherit`, or a full `claude-*` id.

Antigravity (run it from the workspace root):
```bash
node <skill>/scripts/aj.mjs on --platform antigravity --model <id from agy models>
```
This adds an `assumption-judge` entry to `<workspace>/.agents/hooks.json`. Tell the user it did. `--runner claude` uses the claude CLI as the judge instead of `agy`.

Options for both: `--max-interrupts N` (default 2 per user message) and `--no-web`.

If it prints a warning that the judge's CLI wasn't found, live mode can't run. Tell the user, and use check mode (below).

### 3. Tell the user, in two or three lines

- It's on, with the model they chose.
- From their **next** message on, every reply gets judged, and you'll only be interrupted on a HALLUCINATION.
  - Claude Code: the judge runs in the background, in parallel.
  - Antigravity: hooks are synchronous, so each reply pauses for about 10 to 60 seconds while the judge runs.
- `/assumption-judge off` stops it.
  - Claude Code: it also stops when the session ends, so invoke it again in a new session.
  - Antigravity: it stays on for the workspace until `off`.

The reply you're writing now (the activation turn) isn't judged.

## How live mode works (Claude Code)

Invoking this skill registers two hooks for the rest of the session:

1. **UserPromptSubmit** saves the user's message verbatim.
2. **Stop** (async, `asyncRewake`) fires when you finish a reply. In the background, it starts a separate headless `claude -p` judge:
   - tools: `Read`, `Grep`, `Glob`, `WebSearch`, `WebFetch` only
   - no MCP servers, no session saved, output forced to the verdict schema
   - working directory: the project, so it can open the files you talked about
   - packet: the brief, the user's message, your reply, and a digest of this turn's tool calls and results

   Then the gate checks the verdict. On PASS the hook exits quietly. On HALLUCINATION it exits 2, which wakes you right away, even if the session is idle.

You keep working while the judge runs. It doesn't block you or the user.

## How live mode works (Antigravity)

`aj.mjs on --platform antigravity` registers a **Stop** hook in `<workspace>/.agents/hooks.json`. When you finish a reply:
1. It reads your words from `lastUserInput` and your reply and tool steps from the transcript.
2. It runs a separate `agy -p` judge in plan mode, with the packet in a file, output forced to the verdict schema, and the chosen `--model`.
3. It gates the verdict.

On HALLUCINATION the hook returns `{"decision":"continue"}` with the correction, which puts you straight back in the loop before the turn ends. On PASS it returns nothing.

## When the judge interrupts you

You'll get a system message starting with `[assumption-judge] HALLUCINATION`. Then:

1. **Tell the user first**, in plain words: what you said, what's actually true, and the evidence the judge cited. Don't bury it.
2. **Correct it.** If code or files you wrote depend on the wrong claim, fix them, or say you will.
3. **Don't argue in secret.** If you have hard evidence the judge is wrong (a tool result, a file, a doc), show that evidence to the user and let them decide. Never quietly ignore a finding.
4. **Don't re-check yourself to dodge it.** Your corrected reply goes back to the judge automatically, up to the interrupt cap (2 per user message by default).
5. **Don't game it.** Don't hedge every sentence or stop making claims just to avoid being judged. The judge doesn't flag honest uncertainty ("I think", "I haven't checked"). It flags false facts and guesses stated as facts.

If you get `[assumption-judge] The judge could not run`, tell the user once. The reply wasn't checked.

## Check mode (Codex, Cursor, others, or no judge CLI)

Without hooks, nothing can run on its own, so the check happens **before** you send instead:

1. Write your draft reply to a file, and the user's message, verbatim, to another. Optionally write the tool calls and results you relied on to a third.
2. Build the packet:
   ```bash
   node <skill>/scripts/aj.mjs packet --prompt-file prompt.txt --reply-file draft.md --trace-file trace.txt
   ```
3. Spawn a **fresh** judge subagent with exactly the message it prints, and nothing else.
   - Use the installed `assumption-judge` agent if there is one: `assumption_judge` in Codex, and `assumption-judge:assumption-judge` when this came in as a Claude Code plugin.
   - Otherwise use a general-purpose agent that has web search.
   - Never a fork: a judge that sees your context isn't independent.
4. Save its reply to a file, then gate it:
   ```bash
   node <skill>/scripts/aj.mjs gate --verdict verdict.json
   ```
5. On PASS, send your reply. On HALLUCINATION, fix the reply before sending, and tell the user what the judge caught.

In check mode, nothing enforces the judge's independence, so say so if the user asks. Platform details: [references/platforms.md](references/platforms.md).

## What the gate enforces

A judge finding only interrupts you when all of these hold:
- status `contradicted` (false), `assumed` (a guess stated as fact), or `misread_request` (answered something the user didn't ask)
- severity `major`, and confidence of at least 0.7
- the quote appears verbatim in your reply; for `misread_request`, it may come from the user's message instead
- it has evidence, and a `web` source must include a URL
- a `knowledge`-only finding must be `contradicted` at confidence 0.9 or higher

Everything else is logged in `.assumption-judge/log.jsonl` and never interrupts. `aj.mjs status` shows the counts and the last verdicts.

## Files

| File | What |
|---|---|
| `scripts/aj.mjs` | Commands: on, off, status, set, check, packet, gate |
| `scripts/watch.mjs` | The hook handler for Claude Code live mode |
| `scripts/agy-hook.mjs` | The Stop hook handler for Antigravity live mode |
| `scripts/lib.mjs` | Transcript parsing, packet, headless judge runner, gate |
| [references/judge-brief.md](references/judge-brief.md) | The judge's instructions. Don't edit them to go easier on yourself. |
| [references/verdict.schema.json](references/verdict.schema.json) | The verdict format, enforced with `--json-schema` |
| [references/platforms.md](references/platforms.md) | Install, model choice and limits per platform |
| `agents/` | Judge agent definitions for Claude Code, Codex and Antigravity (check mode) |
