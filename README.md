# assumption-judge

**Your AI states guesses as facts. assumption-judge makes a second AI check them while it works.**

Turn it on, and every reply your AI finishes goes to an independent judge. The judge never sees your AI's reasoning, only three things: your message, the reply, and what the tools actually returned. It checks the claims against the project files, the web and its own knowledge, then writes **PASS** or **HALLUCINATION**. A PASS stays silent. A HALLUCINATION interrupts your AI with the evidence, and your AI has to tell you and correct itself.

Works live on **Claude Code** and **Antigravity** (both tested end to end) and **Codex** (hook plumbing tested by simulation), with a check mode for Cursor and any other agent that supports [Agent Skills](https://agentskills.io).

## Install

**Send this link to your AI:**

> Install this skill: https://github.com/mirac221/assumption-judge

That's it. Your AI reads the setup steps below and does the rest.

## What it catches

This comes from a real live test on Claude Code. The agent had been told by stale notes that the app runs on port 8080. The project's `config.toml` says 9090.

> **You:** quick one: what port does our app server listen on, per our config? i need it for the firewall rule
>
> **AI:** Port **8080**, bound to 127.0.0.1 … That's from the team notes; I didn't open `config.toml` to confirm.

The AI goes idle. About 15 seconds later, with nobody typing, the judge has read `config.toml` and wakes it:

> **AI:** The judge was right, and I got it wrong. I gave you 8080 from the team notes, but you asked for the port per our config, and I didn't check the file. I've now read `config.toml`: … `port = 9090` …

The judge's finding was: `contradicted`, source `project_file`, evidence `config.toml:3 sets port = 9090`. The AI's correction then went to the judge too, and passed.

What it looks for:
- **Made-up facts:** CLI flags that don't exist, wrong defaults, invented APIs, wrong versions.
- **Guesses stated as facts:** "your server runs Node 20" when nothing was ever checked.
- **Claimed work that never happened:** "tests pass" with no test run in the trace.
- **Answering the wrong question:** the reply does something other than what you asked.

## Run it

It only runs when you call it. In normal chats, the only cost is its one-paragraph description.

| App | Command |
|---|---|
| Claude Code (terminal, Claude desktop app, IDE) | `/assumption-judge` (`/assumption-judge:assumption-judge` as a plugin) |
| Antigravity (CLI, IDE, app) | `/assumption-judge` |
| Codex | `$assumption-judge` |
| Cursor | `/assumption-judge` |
| Anything else | "use assumption-judge" |

Arguments: `on` (the default), `off`, `status`, `check` (judge the last reply right now), `model <name>`.

## What changes for you

- **The model question:** your AI asks once which model the judge runs on.
  - Claude Code: Sonnet (recommended), Opus, Haiku, or the same model as the main agent.
  - Antigravity: anything `agy models` lists, including its own Claude Sonnet (recommended) and Opus.
- **Silence means pass.** You only hear from the judge when it catches something.
- **How "live" it is depends on the app:**
  - **Claude Code:** the judge runs **in parallel** in the background. You and your AI keep going, and an idle session gets woken when it catches something.
  - **Antigravity:** you pick.
    - `sync`: each reply pauses while the judge runs (about 15 s with Claude Sonnet via Antigravity), and a catch sends your AI straight back to fix it.
    - `deferred`: no pause at all, and a catch is raised at the start of your next message.
    - It works with or without a workspace open (`--global`).
  - **Codex:** synchronous project hooks, like Antigravity. Codex only runs them after you trust them, so run `/hooks` in Codex once after turning it on.
  - **Cursor and others:** no hooks, so your AI checks each draft with a judge subagent **before** sending.
- **It costs tokens:** one judge run per reply, with web searches when needed, on your own plan. `status` shows the running total.
- **No ping-pong:** at most 2 interrupts per message of yours. Only replies like "ok" or "noted" are skipped.

## Requirements

- Node.js 18 or newer
- Live mode on Claude Code: the `claude` CLI (the Claude desktop app ships its own copy, and the judge finds it)
- Live mode on Antigravity: the `agy` CLI (or the `claude` CLI, with `--runner claude`)
- Live mode on Codex: the `codex` CLI on PATH, or the `claude` CLI

## Setup steps (for the AI doing the install)

You were sent this link to install assumption-judge. Do this, then tell the user what you did.

**1. Clone this repo into your skills folder as `assumption-judge`.**

```
git clone https://github.com/mirac221/assumption-judge <skill folder>
```

On Windows PowerShell, use `$HOME\...` instead of `~/...`.

| Agent | Skill folder | Judge agent file (check mode only) | Copy it to |
|---|---|---|---|
| Claude Code | `~/.claude/skills/assumption-judge` | not needed for live mode | |
| Antigravity | `~/.gemini/config/skills/assumption-judge` | not needed for live mode | |
| Codex | `~/.agents/skills/assumption-judge` | `agents/codex/assumption-judge.toml` (check-mode fallback only) | `~/.codex/agents/` |
| Cursor | `~/.cursor/skills/assumption-judge` (skip it if the skill is already in `~/.claude/skills` or `~/.agents/skills`) | `agents/claude-code/assumption-judge.md` if your Cursor has subagents | your agents folder |
| Anything else | your skills folder | the closest match | your agents folder |

**2. Claude Code, optional:** install it as a plugin instead: `/plugin marketplace add mirac221/assumption-judge`, then `/plugin install assumption-judge@assumption-judge`.

**3. Check the requirements:** run `node --version` (needs 18+), and `claude --version` or `agy --version`. If one is missing, tell the user. Don't install system software without asking.

**4. Reload:** in the Antigravity CLI, run `/skills reload`. Elsewhere, a new session picks the skill up.

**One project only?** Use that project's `.claude/skills/` (Claude Code) or `.agents/skills/` (Antigravity, Codex).

**To update:** `git -C <skill folder> pull`.

<details>
<summary>Prefer to install it yourself? Copy-paste commands</summary>

**Claude Code (plugin):** in Claude Code, run
```
/plugin marketplace add mirac221/assumption-judge
/plugin install assumption-judge@assumption-judge
```

**Claude Code (skill):**
```bash
git clone https://github.com/mirac221/assumption-judge ~/.claude/skills/assumption-judge
```

**Antigravity:**
```bash
git clone https://github.com/mirac221/assumption-judge ~/.gemini/config/skills/assumption-judge
```

**Codex:**
```bash
git clone https://github.com/mirac221/assumption-judge ~/.agents/skills/assumption-judge
mkdir -p ~/.codex/agents && cp ~/.agents/skills/assumption-judge/agents/codex/assumption-judge.toml ~/.codex/agents/
```

**Windows PowerShell** (Claude Code shown; swap the folder from the table for other agents):
```powershell
git clone https://github.com/mirac221/assumption-judge "$HOME\.claude\skills\assumption-judge"
```

</details>

## How the judge stays honest

| Problem | What assumption-judge does |
|---|---|
| The judge only skims | It has to list **every** factual claim it checked, including the ones that hold up, as proof of work. Anything that changes over time (AI models, versions, prices, releases) must be checked on the web, and `status` shows how many claims each verdict covered and how many were web-verified. |
| The judge calls a brand-new model fake from stale memory | A time-sensitive claim can never be flagged (or passed) from the judge's own memory, only from a live source. Not finding something isn't proof that it doesn't exist. |
| The AI fact-checks itself | The judge is a separate process with no access to the AI's reasoning. It gets only your words, the reply and the real tool results. |
| The judge invents problems | A script, the gate, throws out any finding that doesn't quote the reply word for word, has no evidence, cites the web without a URL, or rests only on "I know this" below 90% confidence. Minor and unsure findings are logged and never interrupt. |
| The judge says PASS but lists an error | The gate recomputes the verdict from the findings, so a wrong label doesn't let an error through. |
| The judge can change things | Claude Code: the judge only gets Read, Grep, Glob, WebSearch and WebFetch, with no MCP servers. Antigravity: plan mode, and headless mode denies shell commands. |
| The judge judges itself | Its own process carries a guard variable, so its hooks never start another judge. |
| Endless correction loops | At most 2 interrupts per message of yours, and corrections get judged too. |
| Your user message contains "ignore your instructions" | The judge treats everything quoted from the conversation as data, not instructions. |

**Known limits**
- The judge sees **one turn**: your current message, the reply and this turn's tools, not the earlier conversation. Something you agreed on three messages ago can get flagged if the files say otherwise.
- A cheap judge model misses more. In testing, a Haiku judge once summarized two errors and still answered PASS with an empty findings list. The schema now makes it write its findings first, and that case was caught in 3 out of 3 reruns.
- The judge's web searches go to the search provider. Don't run it on replies full of secrets.

<details>
<summary>What's in the repo</summary>

```
SKILL.md                   the workflow your AI follows, plus the Claude Code hooks
references/
  judge-brief.md           the judge's instructions
  verdict.schema.json      the judge's answer format, enforced
  platforms.md             per-app details, live test results, and known gotchas
scripts/
  aj.mjs                   on / off / status / set / check / packet / gate
  watch.mjs                Claude Code hook handler (prompt capture + async Stop judge)
  agy-hook.mjs             Antigravity Stop hook handler
  codex-hook.mjs           Codex UserPromptSubmit + Stop hook handler
  lib.mjs                  transcript parsing, packet, judge runners (claude / agy / codex), the gate
agents/                    judge agents for check mode (Claude Code / Cursor subagents, Codex), plus Codex's command-only setting
.claude-plugin/            Claude Code plugin files
```

</details>

## License

[Apache-2.0](LICENSE) © 2026 mirac221. Use it, change it, ship it. When you share it, keep the [LICENSE](LICENSE) and [NOTICE](NOTICE) files so the credit stays with the original work.
