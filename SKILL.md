---
name: assumption-judge
description: Command-only. Runs only when the user invokes it by name (/assumption-judge, $assumption-judge, @assumption-judge, or "use assumption-judge"). Never load it on your own. Turns on an independent judge agent that fact-checks every assistant reply against the user's words, the project files, the real tool results and the web, catches hallucinated flags, APIs, versions, file contents and claimed work, and interrupts only on a HALLUCINATION, with evidence. Works in Claude Code, Cursor, Codex, ChatGPT, Antigravity and Claude apps.
argument-hint: "[on|off|status|check|model <name>]"
allowed-tools: Bash(node ${CLAUDE_SKILL_DIR}/scripts/aj.mjs *)
license: Apache-2.0
compatibility: Needs Node 18+. Live mode (hooks) in Claude Code, Cursor IDE and CLI, Codex CLI and ChatGPT desktop Codex mode, and Antigravity app, IDE and agy CLI, with the judge run by the claude, agy, codex or Cursor CLI. Chat apps (claude.ai, ChatGPT Chat and Work) use relay mode.
metadata:
  version: "0.6.0"
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

Once this is on, every reply you finish goes to a separate judge: a fresh agent that never sees your reasoning, only the user's words (this message and a few earlier ones), your reply, and what your tools actually returned this turn. It checks your claims against the project files, the web and its own knowledge, and writes **PASS** or **HALLUCINATION**. A gate script throws out any finding that isn't quoted verbatim from your reply and backed by evidence, so the judge can't hallucinate hallucinations either.

You hear from it **only** when it catches something. A PASS is silent.

Why: the model that wrote the answer reads its own intent into it. It "remembers" the flag it meant to look up, the file it assumed it read, the API that sounded right. Only an agent with no stake in the answer can check it honestly.

`<skill>` below is the folder this file is in (in Claude Code: `${CLAUDE_SKILL_DIR}`). Scripts are plain Node 18+ with no install step. State goes in `.assumption-judge/` under the working directory, and that folder git-ignores itself.

## Commands

The user's argument picks one. No argument means `on`.

| Invocation | You do |
|---|---|
| `/assumption-judge` or `on` | Steps 1 to 4 below |
| `off` | `node <skill>/scripts/aj.mjs off` (add `--global` if it was turned on that way), then confirm in one line |
| `status` | `node <skill>/scripts/aj.mjs status`, then relay it |
| `check` | `node <skill>/scripts/aj.mjs check --platform <app>`: judges your last finished reply in **this** app's current conversation, right now. It never reads another app's transcripts. |
| `model <name>` | `node <skill>/scripts/aj.mjs set model <name>`, then confirm |

## Turning it on

Copy this checklist and tick it off:

```
- [ ] 1. doctor: which app, which judge runners
- [ ] 2. ask which model the judge runs on (where the app allows it)
- [ ] 3. switch it on with the command for this app
- [ ] 4. tell the user in two or three lines
```

### 1. Run the doctor

```bash
node <skill>/scripts/aj.mjs doctor
```

It prints the app it detected (`claude-code`, `cursor`, `codex`, `antigravity`, or none), which judge runners are installed (`claude`, `agy`, `codex`, `cursor`), and what to do next. Then read **only your app's section** of [references/platforms.md](references/platforms.md):

| You are running in | Mode | Section |
|---|---|---|
| Claude Code: CLI, Claude desktop app (Code tab), IDE extension | **Live, in parallel**: a background judge wakes you only on a catch | Claude Code |
| Claude Cowork (Claude desktop app) | Live if hooks run there, otherwise check mode | Claude app |
| Cursor: IDE or Cursor CLI (`agent`) | **Live, synchronous**: `stop` hook, a catch comes back as a follow-up message | Cursor |
| Codex: CLI, IDE extension, ChatGPT desktop app in Codex mode | **Live, synchronous**: project hooks, after the user trusts them with `/hooks` | Codex |
| Antigravity: app, IDE, `agy` CLI | **Live**: `sync` (judged before the turn ends) or `deferred` (no pause) | Antigravity |
| claude.ai chat, ChatGPT Chat or Work, any app without a shell | **Relay**: a fresh subagent where the app has one, otherwise a fresh chat | Chat apps |

The doctor says "app: not detected" when it can't tell. Then pick the row yourself, and pass `--platform` explicitly.

### 2. Ask which model the judge runs on (once)

Skip this if the user already named a model, or `.assumption-judge/config.json` already has one they chose. Ask only where you can actually choose. Your app's section lists the exact choices (Claude Code: AskUserQuestion with Sonnet (recommended), Opus, Haiku, Same as me; Antigravity: ids from `agy models`; Cursor and Codex: ask in chat).

Be straight about cost: one judge run per reply, each with possible web searches, on the user's plan.

### 3. Switch it on

```bash
node <skill>/scripts/aj.mjs on --platform <app> --model <id>
```

- `--platform`: `claude-code`, `cursor`, `codex` or `antigravity`. Run it from the project root.
- `--global` (Cursor and Antigravity): hooks in the user-level config, for every project and for chats with no folder open.
- `--runner claude|agy|codex|cursor`: which CLI runs the judge. The default is the best one installed for your app.
- `--mode deferred` (Antigravity): no pause; a catch is raised at the start of the next message.
- `--max-interrupts N` (default 2 per user message), `--no-web`.

If it prints a WARNING that the judge's CLI wasn't found or isn't logged in, live mode can't run. Tell the user the fix it printed, and use check mode (below) until then.

### 4. Tell the user

In two or three lines:
- It's on, with the model they chose, and which file you changed (if any).
- From their **next** message on, every reply gets judged, and they only hear about it on a HALLUCINATION. Say whether replies pause while the judge runs (Cursor, Codex, Antigravity `sync`) or not (Claude Code, Antigravity `deferred`).
- Anything they must do: Codex needs `/hooks` trust; Cursor and Antigravity may need a restart or a new conversation.
- `/assumption-judge off` stops it. In Claude Code it also stops when the session ends.

The reply you're writing now, the activation turn, isn't judged.

## When the judge interrupts you

You'll get a message starting with `[assumption-judge] HALLUCINATION`. Then:

1. **Tell the user first**, in plain words: what you said, what's actually true, and the evidence the judge cited. Don't bury it.
2. **Correct it.** If code or files you wrote depend on the wrong claim, fix them, or say you will.
3. **Don't argue in secret.** If you have hard evidence the judge is wrong (a tool result, a file, a doc), show that evidence to the user and let them decide. Never quietly ignore a finding.
4. **Check the source directly.** Open the cited file or URL with your file or fetch tool. Don't re-run your own reasoning to dodge it. Your correction goes back to the judge automatically, up to the interrupt cap.
5. **Don't game it.** Don't hedge every sentence or stop making claims to avoid the judge. It doesn't flag honest uncertainty ("I think", "I haven't checked"). It flags false facts, and guesses stated as facts.

If you get `[assumption-judge] The judge could not run`, tell the user once. That reply wasn't checked.

## Check mode (no hooks, or no judge CLI)

Without hooks nothing runs on its own, so you check **before** you send:

1. Write your draft reply to a file, and the user's message, verbatim, to another. Optionally write the tool calls and results you relied on to a third, and the user's earlier messages to a fourth.
2. Build the packet:
   ```bash
   node <skill>/scripts/aj.mjs packet --prompt-file prompt.txt --reply-file draft.md --trace-file trace.txt --earlier-file earlier.txt
   ```
3. Spawn a **fresh** judge subagent with exactly the message it prints, and nothing else.
   - Use the installed `assumption-judge` agent if there is one (`assumption_judge` in Codex, `assumption-judge:assumption-judge` as a Claude Code plugin). Otherwise use a general-purpose agent that has web search.
   - Never a fork: a judge that sees your context isn't independent.
   - If no subagent is possible but a judge CLI is installed, run `aj.mjs check --prompt-file … --reply-file …` instead; it runs the same judge headless.
4. Save its reply to a file, then gate it: `node <skill>/scripts/aj.mjs gate --verdict verdict.json`
5. On PASS, send your reply. On HALLUCINATION, fix the reply before sending, and tell the user what the judge caught.

In check mode nothing enforces the judge's independence. Say so if the user asks.

## What the gate enforces

A finding only interrupts when all of these hold:
- status `contradicted` (false), `assumed` (a guess stated as fact), or `misread_request` (answered something the user didn't ask)
- severity `major`, and confidence of at least 0.7
- the quote appears verbatim in your reply (for `misread_request`, it may come from the user's message)
- it has evidence, and a `web` source includes a URL
- a `knowledge`-only finding is `contradicted` at confidence 0.9 or higher
- a time-sensitive claim (versions, models, prices, releases) is settled by a live source, never from memory

Everything else is logged in `.assumption-judge/log.jsonl` and never interrupts. `aj.mjs status` shows the counts and the last verdicts.

## Files

| File | What |
|---|---|
| `scripts/aj.mjs` | Commands: doctor, on, off, status, set, check, packet, gate |
| `scripts/install.mjs` | Installs the skill and judge agents for every app on the machine; `--zip` builds the chat-app upload |
| `scripts/watch.mjs`, `cursor-hook.mjs`, `codex-hook.mjs`, `agy-hook.mjs` | Hook handlers for Claude Code, Cursor, Codex and Antigravity |
| `scripts/lib.mjs` | Transcript parsing, packet, judge runners, the gate |
| [references/platforms.md](references/platforms.md) | Per-app install, model choice, how live mode works, test results and limits |
| [references/judge-brief.md](references/judge-brief.md) | The judge's instructions. Don't edit them to go easier on yourself. |
| [references/verdict.schema.json](references/verdict.schema.json) | The verdict format, enforced with `--json-schema` |
| `agents/` | Judge agents for check mode: Claude Code, Cursor, Codex |
