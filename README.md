# assumption-judge

**Your AI states guesses as facts. assumption-judge makes a second AI check them while it works.**

Turn it on, and every reply your AI finishes goes to an independent judge. The judge never sees your AI's reasoning, only three things: your message, the reply, and what the tools actually returned. It checks the claims against the project files, the web and its own knowledge, then writes **PASS** or **HALLUCINATION**. A PASS stays silent. A HALLUCINATION interrupts your AI with the evidence, and your AI has to tell you and correct itself.

![license](https://img.shields.io/badge/license-Apache--2.0-blue) ![agent skills](https://img.shields.io/badge/Agent%20Skills-compatible-6b4fbb) ![node](https://img.shields.io/badge/node-18%2B-339933) ![deps](https://img.shields.io/badge/dependencies-0-brightgreen)

| Works in | How | Status |
|---|---|---|
| **Claude Code** (CLI, desktop app, VS Code / JetBrains) | Live: a background judge, in parallel, wakes your AI only on a catch | Tested live |
| **Antigravity** (app, IDE, `agy` CLI) | Live: judged before the turn ends, or in the background | Tested live |
| **Cursor** (IDE and Cursor CLI) | Live: a `stop` hook sends the catch back as a follow-up message | Hooks tested by simulation with a real judge |
| **Codex** (CLI, IDE, ChatGPT desktop app in Codex mode) | Live: synchronous hooks, after you trust them with `/hooks` | Hooks tested by simulation |
| **Claude Cowork**, **ChatGPT Work** | Check mode: a fresh judge subagent per reply | From the docs |
| **claude.ai**, **ChatGPT** chat | Relay mode: upload the zip, and the judge runs in a fresh chat | From the docs |

Any other app that reads [Agent Skills](https://agentskills.io) gets check mode.

## Install

**Send this link to your AI:**

> Install this skill: https://github.com/mirac221/assumption-judge

That's it. Your AI reads the setup steps below and does the rest. Or do it yourself in one go: it installs into every agent app it finds on your machine.

```bash
git clone https://github.com/mirac221/assumption-judge && node assumption-judge/scripts/install.mjs
```

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
- **Code that can't run as written:** a snippet that imports a package, calls a method or passes an option that doesn't exist.
- **Guesses stated as facts:** "your server runs Node 20" when nothing was ever checked.
- **Claimed work that never happened:** "tests pass" with no test run in the trace.
- **Answering the wrong question:** the reply does something other than what you asked.

## Does it actually help?

We ran the judge on 14 replies about a small fixture repo whose team notes are stale (they say port 8080, `npm run serve`, `--legacy-auth`; the real config, scripts and changelog say otherwise).
- 6 are real replies from Claude Haiku agents doing the task. A good judge stays quiet on those.
- 6 are planted versions of the classic failure shapes: a stale value passed off as config, a removed CLI flag, a script that doesn't exist, "all tests pass" with no test run, a wrong dependency version, and an outdated "newest model".
- 2 test the new earlier-context feature: the user set port 7000 two messages ago.

The same judge model ran both 0.5.1 and 0.6.0.

| Judge: Gemini 3.8 Flash (High), via Antigravity | Stayed quiet on real replies | Caught planted errors | Earlier-context cases | Total |
|---|---|---|---|---|
| assumption-judge 0.5.1 | 6/6 | 6/6 | 1/2 | 13/14 |
| **assumption-judge 0.6.0** | **6/6** | **6/6** | **2/2** | **14/14** |

- **Caught, every time:** a stale port passed off as "the project config", a removed `--legacy-auth` flag, `npm run serve` (no such script), "all 12 tests pass" with no test run, a wrong Express version, and "Claude 3.5 Sonnet is the newest model".
- **The one difference:** two messages earlier, the user said "use port 7000 from now on". 0.5.1 never saw that and flagged a correct `ufw allow 7000/tcp` as a hallucination. 0.6.0 passed it, and still flagged the variant that falsely claimed `config.toml` already says 7000.
- **Found and fixed during testing:** an earlier pre-release run with a Sonnet judge let the stale-port case through, because the reply's values matched the stale notes. The judge now ranks sources (running config and code over notes and docs), and that case has been caught since.

Every number above comes from one run each, with an Antigravity-hosted judge. Small samples, so treat them as a smoke test, not a benchmark. The cases, the fixture repo and the runner are in [`evals/`](evals/), so you can rerun them: `node evals/run.mjs --runner agy --model <id>` (or `--runner claude --model sonnet`).

**0.6.1.** The judge's instructions changed: code in a reply now counts as claims, and long replies get checked in order of what you'd act on first. The suite was rerun with Claude Haiku as the judge, through the `claude` CLI: 14/14 (6/6, 6/6, 2/2). One run, and no 0.6.0 run on the same model to compare with, so it shows nothing broke, not that it got better.

## Run it

It only runs when you call it. In normal chats, the only cost is its one-paragraph description.

| App | Command |
|---|---|
| Claude Code (terminal, Claude desktop app, IDE) | `/assumption-judge` (`/assumption-judge:assumption-judge` as a plugin) |
| Antigravity (CLI, IDE, app) | `/assumption-judge` |
| Codex (CLI, IDE, ChatGPT desktop app in Codex mode) | `$assumption-judge` |
| Cursor (IDE and Cursor CLI) | `/assumption-judge` |
| ChatGPT (Chat and Work) | `@assumption-judge` |
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
  - **Cursor:** a synchronous `stop` hook. A catch comes back to your AI as a follow-up message, before you act on the answer. Works in the IDE and in the Cursor CLI.
  - **Codex:** synchronous project hooks, like Antigravity. Codex only runs them after you trust them, so run `/hooks` in Codex once after turning it on.
  - **Chat apps and others:** no hooks, so your AI checks each draft with a fresh judge **before** sending, or hands you a packet for a fresh chat.
- **It remembers what you said:** the judge sees your last few messages too. Tell your AI "use port 7000 from now on", and a reply using 7000 isn't flagged just because a config file still says 9090.
- **It costs tokens:** one judge run per reply, with web searches when needed, on your own plan. `status` shows the running total.
- **No ping-pong:** at most 2 interrupts per message of yours. Only replies like "ok" or "noted" are skipped.

## Requirements

- Node.js 18 or newer
- Live mode on Claude Code: the `claude` CLI (the Claude desktop app ships its own copy, and the judge finds it)
- Live mode on Antigravity: the `agy` CLI (or the `claude` CLI, with `--runner claude`)
- Live mode on Codex: the `codex` CLI on PATH, or the `claude` CLI
- Live mode on Cursor: the `claude` CLI (strictest), or the Cursor CLI (`agent`)
- `node scripts/aj.mjs doctor` tells you what's installed and which mode will run

## Setup steps (for the AI doing the install)

You were sent this link to install assumption-judge. Do this, then tell the user what you did.

**1. Clone this repo anywhere and run the installer.** It detects Claude Code, Codex (and the ChatGPT desktop app's Codex mode), Antigravity and Cursor on this machine, and copies the skill and the judge agents into each one's folders. It never overwrites a git clone or a different skill.

```bash
git clone https://github.com/mirac221/assumption-judge
node assumption-judge/scripts/install.mjs --dry-run   # show what it would do
node assumption-judge/scripts/install.mjs             # do it
```

- `--apps claude-code,codex,antigravity,cursor` picks apps instead of auto-detecting.
- `--project <repo>` installs into one project instead of your user folders.
- `--zip` builds `dist/assumption-judge.zip` for **claude.ai** (Settings > Capabilities > code execution, then Skills > Upload) and **ChatGPT** (Skills > Create > Upload).
- `--uninstall` removes what it installed.

**2. Claude Code, optional:** install it as a plugin instead: `/plugin marketplace add mirac221/assumption-judge`, then `/plugin install assumption-judge@assumption-judge`. Claude Cowork takes the same plugin.

**3. Check the requirements:** `node assumption-judge/scripts/aj.mjs doctor`. If something's missing, tell the user. Don't install system software without asking.

**4. Reload:** in the Antigravity CLI, run `/skills reload`. Elsewhere, a new session picks the skill up.

**To update:** `git -C assumption-judge pull`, then run the installer again.

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

**Windows PowerShell** (Claude Code shown; for other apps, `scripts/install.mjs` picks the right folders):
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
| Your user message contains "ignore your instructions" | The judge treats everything quoted from the conversation as data, not instructions. A reply also can't fake the end of its own data block to slip some in: block markers inside the data are broken up before the judge sees them. |

**Known limits**
- The judge sees this turn's tools and your last 3 messages, not the whole conversation. Something you settled ten messages ago can still get flagged if the files say otherwise (`aj.mjs set context-turns N`).
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
  aj.mjs                   doctor / on / off / status / set / check / packet / gate
  install.mjs              installs into every agent app on the machine; --zip for claude.ai and ChatGPT
  cursor-hook.mjs          Cursor hook handler (prompt + response capture, synchronous stop judge)
  watch.mjs                Claude Code hook handler (prompt capture + async Stop judge)
  agy-hook.mjs             Antigravity Stop hook handler
  codex-hook.mjs           Codex UserPromptSubmit + Stop hook handler
  lib.mjs                  transcript parsing, packet, judge runners (claude / agy / codex / cursor), the gate
agents/                    judge agents for check mode (Claude Code, Cursor, Codex), plus Codex's command-only setting
.claude-plugin/            Claude Code plugin files
```

</details>

**Also by me:** [frame-judge](https://github.com/mirac221/frame-judge), a code-blind critic that checks every ask in your request against the rendered frames of AI-built UI, animation and video.

## License

[Apache-2.0](LICENSE) © 2026 mirac221. Use it, change it, ship it. When you share it, keep the [LICENSE](LICENSE) and [NOTICE](NOTICE) files so the credit stays with the original work.
