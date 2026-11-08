# Platforms: install, live vs check mode, the model question

Checked against Claude Code 2.1.317 and the Antigravity CLI 1.5.3 in November 2026, with live end-to-end tests on both (Windows 11), and against the Cursor and Codex docs of the same month.

## Contents
- The table below, and "Running only on command"
- Claude Code · Codex live mode · Codex check mode · Antigravity · Cursor · Claude app · ChatGPT app · Chat apps: relay mode · Fallback ladder These tools change fast. If anything here disagrees with your installed version's docs or `--help`, trust those, and tell the user what was different.

| Platform | Mode | Model choice | Independence |
|---|---|---|---|
| Claude Code (CLI, desktop app, IDE) | **Live, in parallel**: background judge, wakes the agent only on HALLUCINATION | Yes, AskUserQuestion | Enforced: a separate process with read and search tools only |
| Antigravity (app, CLI, IDE) | **Live**, `sync` (judged before the turn ends) or `deferred` (no pause, a catch is raised next message); workspace or `--global` | Yes, any id from `agy models`, including Antigravity's Claude Sonnet / Opus | A separate `agy -p` process in plan mode; headless mode denies shell commands |
| Codex CLI / app | **Live, synchronous** (project hooks, after `/hooks` trust); check mode as fallback | Ask in chat | A separate `codex exec` in a read-only sandbox, or the claude CLI. **Hook plumbing simulated, not run inside Codex** (see below) |
| Cursor (IDE and CLI) | **Live, synchronous** (`stop` hook, a catch comes back as a follow-up message); check mode as fallback | Ask in chat | A separate `claude -p` (read and search tools only) or `agent -p --mode ask` (read-only). **Hook plumbing simulated, not run inside Cursor** |
| ChatGPT desktop app, Codex mode | Same as Codex | Ask in chat | Same as Codex |
| Claude Cowork | Live via the plugin's hooks (untested), otherwise check mode with a subagent | Ask in chat | Subagent |
| claude.ai chat, ChatGPT Chat / Work | **Relay**, or check mode with a fresh subagent where the app has one (ChatGPT Work) | Only where a subagent's model can be chosen | A fresh chat or subagent |

**For every platform: the judge sees one turn, plus the user's earlier words.** It gets the current user message, the reply and this turn's tool trace, and the user's last 3 messages before this one (`aj.mjs set context-turns N`, 0 turns it off). So if you told the agent "use port 7000 from now on" two messages ago, a reply that relies on 7000 passes, even though the config still says 9090. A reply claiming the *config* says 7000 still gets flagged. The assistant's own earlier answers are shown, marked as not evidence.

## Running only on command

assumption-judge is command-only. In ordinary chats it costs only its description. The hooks register when the skill is **invoked**, and not before.
- The description says "command-only, never load it on your own".
- In Codex, `agents/openai.yaml` sets `allow_implicit_invocation: false`.
- **Don't add `disable-model-invocation: true`.** Antigravity then hides the skill completely, as it does for frame-judge.

How to invoke it:
- Claude Code, Cursor (IDE and CLI), Antigravity: `/assumption-judge`; as a Claude Code plugin, `/assumption-judge:assumption-judge`
- Codex and the ChatGPT desktop app's Codex mode: `$assumption-judge`
- ChatGPT Chat and Work: `@assumption-judge`
- anywhere else: "use assumption-judge"

## Claude Code

**Install**
- **Plugin:** `/plugin marketplace add mirac221/assumption-judge`, then `/plugin install assumption-judge@assumption-judge`.
- **Plain skill:** `~/.claude/skills/assumption-judge/` for every project, or `<repo>/.claude/skills/assumption-judge/` for one.
- **Judge agent** (check mode only, optional): copy `agents/claude-code/assumption-judge.md` to `~/.claude/agents/`.

**How the hooks find the scripts.** Claude Code doesn't expand `${CLAUDE_SKILL_DIR}` inside skill frontmatter hooks; it passes the literal string (tested on 2.1.316). So each hook runs a tiny `node -e` loader that looks for `scripts/watch.mjs` in two places:
- `CLAUDE_PLUGIN_ROOT`, which Claude Code sets to the skill folder for skill hooks and to the plugin root for plugins (observed, not documented);
- the `skill_dir` that `aj.mjs on` writes to `.assumption-judge/config.json`.

`${CLAUDE_PROJECT_DIR}` is expanded in hook `args`.

**Live mode, step by step**
1. **UserPromptSubmit** (sync, about 50 ms) stores the user's message in `.assumption-judge/sessions/<session>.json`.
2. **Stop** fires with `"async": true, "asyncRewake": true`. It waits 1.5 s for the transcript to flush, then builds the packet. The trace comes from `transcript_path`, and the reply from `last_assistant_message`.
3. It runs the judge:
   ```
   claude -p --model <m> --tools Read,Grep,Glob,WebSearch,WebFetch --allowedTools <same>
     --disallowedTools mcp__* --strict-mcp-config --no-session-persistence
     --max-turns 25 --output-format json --json-schema <verdict.schema.json>
   ```
   - The working directory is the project.
   - The packet goes in on stdin.
   - `ASSUMPTION_JUDGE_CHILD=1` stops the judge's own session from judging itself.
4. It gates the verdict.
   - **HALLUCINATION:** exit 2. Claude Code shows stderr to the main agent as a system reminder and wakes it immediately, even if the session is idle.
   - **PASS:** exit 0, silent.
   - **Judge error:** reported once per session, then only logged.
5. Corrections get judged too. The interrupt cap (default 2 per user message) stops ping-pong. Claude Code's own cap is 8 consecutive Stop-hook continuations.

**Binary lookup.** The judge runs the first of these that exists:
1. `ASSUMPTION_JUDGE_CLAUDE`
2. `CLAUDE_CODE_EXECPATH`, which the Claude desktop app sets to its bundled CLI
3. `claude` on PATH

**Live test (Claude Code 2.1.317, Haiku as judge).** The main agent was told by a system note that the port was 8080, while `config.toml` said 9090.
- **0 s:** the agent replied "8080" and went idle.
- **~14 s:** the judge read `config.toml`, returned `contradicted` with source `project_file`, and the async hook woke the idle agent.
- **~20 s:** the agent told the user it was wrong and gave 9090.
- **After that:** the correction was judged too, and got PASS.

**Cost.** One headless run per reply longer than 12 characters (`aj.mjs set min-reply-chars N`). Short confident answers are where wrong facts hide, so only "ok"-style replies are skipped. It runs on the user's Claude plan. `aj.mjs status` adds up the API-equivalent cost that the CLI reports.

**Model question.** Ask with AskUserQuestion: Sonnet (recommended), Opus, Haiku, or Same as me (`inherit`, meaning the model of the reply under review). Record the answer with `aj.mjs on --model …` or `aj.mjs set model …`.

**Limits, said plainly**
- The judge sees the **final** reply and a cut-down trace (about 14k characters), not every intermediate message.
- Async hook output in `claude -p` (non-interactive) sessions gets cancelled at teardown, so live mode is for interactive sessions. Use `aj.mjs check` in scripts.
- If an org's managed settings set `strictPluginOnlyCustomization` for hooks, a personal skill's hooks don't run. Install it as a plugin instead.
- Web searches send the judge's search queries to the search provider, so don't turn this on for replies about secrets.

## Codex live mode (CLI, IDE extension, app)

**What was verified**, read-only, against the Codex app's bundled CLI (`codex-cli 0.167.0-alpha.3.2`):
- `codex features list` shows `hooks` as stable and on.
- `codex exec --help` lists `--sandbox read-only`, `--ephemeral`, `--output-schema`, `-o`, `-m` and `-C`, and stdin is used for the prompt when none is given (or with `-`).
- `codex --search exec --help` parses: `--search` is a global flag, and `codex exec --search` is rejected.

**Hook contract**, from Codex's hooks docs:
- **Where:** project hooks live in `<repo>/.codex/hooks.json`.
- **UserPromptSubmit** gets `prompt`.
- **Stop** gets `last_assistant_message`, `transcript_path`, `stop_hook_active` and `model`.
- **Blocking:** `{"decision":"block","reason":…}` on Stop doesn't reject the turn. It turns the reason into a continuation prompt.
- **Sync vs async:** hooks are synchronous by default. Async hooks can't block, and there's no async rewake like Claude Code's.
- **Trust:** non-managed hooks only run after the user trusts them with `/hooks`. Trust is tied to each hook's hash, so changed hooks are skipped until re-trusted. Project hooks also need the project `.codex/` layer to be trusted.

**What `aj.mjs on --platform codex` writes:**
- Two entries, recognised by their `codex-hook.mjs` path.
- Anything already in the file stays (tested with a pre-existing user hook, through `on` and `off`).
- The command is `node C:/…/codex-hook.mjs <mode>`, with **forward slashes**. A backslash path failed under `sh` in testing. The forward-slash command ran correctly under `sh`, PowerShell and `cmd`.

**Simulated end to end** with the documented hook inputs and the exact commands from `hooks.json`:
- The prompt was captured.
- Our own continuation prompt was ignored.
- The activation turn (`$assumption-judge on`) was skipped.
- A wrong "8080" reply gave `{"decision":"block"}`, with the judge citing `config.toml` = 9090.
- The interrupt counter went up.

**Not verified**, because Codex itself was deliberately not prompted:
- a real Codex session firing these hooks;
- the exact transcript (rollout) record shapes for tool calls, which the parser handles tolerantly (`*call` / `*call_output` / `message`);
- the `codex exec` judge runner itself.

The claude runner (`--runner claude`) is the tested path.

## Codex check mode (fallback)

**Install** (the skill is needed for both modes)
- **Skill:** `~/.agents/skills/assumption-judge/` or `<repo>/.agents/skills/assumption-judge/`.
- **Judge agent** (only for this fallback): copy `agents/codex/assumption-judge.toml` to `~/.codex/agents/`.

**When to use it:** only when live mode can't run. That means the user won't trust the hooks, hooks are disabled in their Codex, or no judge CLI is installed. Codex only spawns subagents when asked, and the skill instructions count as asking: "Spawn the assumption_judge agent with this message: …".

**Web search** has to be enabled in the user's Codex config. Without it, set `aj.mjs set web off`, so the judge marks web-only facts `unverifiable` instead of guessing.

**Model:** ask in chat. Some versions ignore the per-spawn model (a known mid-2026 issue). If you can't confirm which model the child used, say so.

## Antigravity (App, IDE, CLI)

**Install**
- **Skill:** `<workspace>/.agents/skills/assumption-judge/` or `~/.gemini/config/skills/assumption-judge/`. Antigravity ignores the Claude Code `hooks:` key in SKILL.md frontmatter, and the skill shows up fine (tested).
- **No agent file.** Antigravity's customization system (rules, skills, plugins, hooks, MCP) has no custom subagent files, and `agy agents` lists none, so this skill ships none for it. Live mode doesn't need one. If live mode can't run, `aj.mjs check --prompt-file p --reply-file r` with `aj.mjs set runner agy` runs the same headless judge on demand.

**Reported from the Antigravity app (fixed in 0.4.0):**
- It didn't work with no workspace open.
- Every reply froze while the judge ran.
- `check` picked up a Claude Code transcript. That one is a privacy bug: the wrong app's conversation went to the judge.

The fixes are `--global`, `--mode deferred`, and a `check` that only reads the current app's transcripts and refuses to guess.

**Judge model.** Antigravity offers Claude as third-party models, and the agy judge runs them fine. Live test, wrong "8080" against `config.toml` = 9090:
- `claude-sonnet-4-6`: `contradicted`/`project_file` in 14.5 s
- `claude-opus-4-6-thinking`: the same, in 21 s
- `gemini-3.8-flash-medium`: the same, in 17 to 27 s

Sonnet is the recommendation.

**Global hooks (`--global`).**
- **What it writes:** `~/.gemini/config/hooks.json`, Antigravity's global customization root per its built-in customization docs, plus the shim next to it. State goes to `~/.assumption-judge/`.
- **Scope rules:** a workspace with its own enabled entry wins, and the global hook stands down. With no workspace, the judge runs in an empty `~/.assumption-judge/no-workspace/` folder and never gets a listing of your home folder.
- **Not verified live:** that the app loads the global `hooks.json` (testing it means writing your real global config). The scope logic is tested with simulated input.

**Deferred mode (`--mode deferred`), tested live on the CLI:**
- the wrong-answer turn returned in 7 s with no judge wait;
- the background judge caught it in 13.5 s;
- the PreInvocation hook delivered the correction at the start of the next message, and cleared it.

**Live mode.** `aj.mjs on --platform antigravity --model <id>` from the workspace root (or `--global`):
- **What it writes:**
  - an `assumption-judge` entry in `<workspace>/.agents/hooks.json`
  - a shim, `.agents/assumption-judge-hook.cjs`
- **Why the shim:** Antigravity runs hook commands via `cmd /c` on Windows, and a quoted absolute path then reaches node *with the quotes in it* (seen live). So the command is a quote-free `node assumption-judge-hook.cjs`, and the shim holds the real path.
- **PreInvocation** (`node assumption-judge-hook.cjs pre`) returns `{}` in sync mode. In deferred mode it injects a waiting verdict as `{"injectSteps":[{"systemMessage":{"systemMessage":…}}]}`.
- **Each Stop** (`terminationReason: NO_TOOL_CALL`):
  1. The hook takes the user's words from `lastUserInput`.
  2. It takes the reply and tool steps from `transcriptPath`: `PLANNER_RESPONSE` steps hold the text and `tool_calls`, and `GENERIC` steps hold the tool results.
  3. It runs `agy -p <packet> --mode plan --output-format json --json-schema <schema> --model <id>`. The packet goes inline when it fits under the Windows command-line limit, and through a file otherwise.
- **On HALLUCINATION** it returns `{"decision":"continue","reason":…}`. Antigravity injects that as a system message and the agent re-enters its loop (tested).
- **Hooks are synchronous.** The turn pauses while the judge runs: about 25 s with Gemini 3.8 Flash Medium in testing (it was 80 to 120 s before the judge got a file map). Pick a faster model or `--runner claude` if that's too slow.
- **`off`** sets `"enabled": false` on the entry. It stays on across sessions until then.
- **Recursion guard:** `ASSUMPTION_JUDGE_CHILD=1` is inherited by the judge's own agy process, so its Stop hook does nothing.

**Model:** run `agy models` and ask in chat. `inherit` uses the session's `modelName`.

**Headless (`agy -p`) gotchas, seen live**
- Print mode auto-denies shell commands, and a denied command ends the run with **no output at all**. The judge is told to use only its file viewer and web search. If it still tries a command, the runner retries once with a blunter instruction, and if that fails too, the log says so plainly.
- The *main* agent, once corrected, sometimes reaches for `ls` to double-check. Print mode denies that; the app asks you. The correction message suggests opening the cited file directly.
- Without a file map, the Gemini judge flagged unverified claims as `assumed` instead of opening the file that proves them wrong. The packet now lists the project files, and the brief says to open the one that settles a claim before settling for `assumed`. After that, Gemini returned `contradicted` with source `project_file` in 2 out of 2 runs.
- Each `agy` judge run is its own Antigravity conversation, so it shows up in your conversation history. agy has no "don't save" flag. `--runner claude` avoids it if the claude CLI is installed. `check` skips those judge conversations when it looks for yours.

## Cursor (IDE and Cursor CLI)

Built from Cursor's hooks, skills and CLI docs (cursor.com/docs, November 2026). The hook plumbing was **simulated** end to end with the documented payloads and a real judge (below). It was not run inside Cursor, since Cursor isn't installed on the test machine.

**Install**
- **Skill:** Cursor reads `~/.cursor/skills/`, `~/.agents/skills/`, `~/.claude/skills/` and `~/.codex/skills/` (plus the same folders in a project). If the skill is already installed for Claude Code or Codex, Cursor uses that copy. `node scripts/install.mjs` handles this.
- **Judge agent** (check mode only): `agents/cursor/assumption-judge.md` goes to `~/.cursor/agents/`. It sets `readonly: true`. Cursor also reads `~/.claude/agents/` and `~/.codex/agents/`, and `.cursor/` wins on a name clash.
- **Invoke:** `/assumption-judge` in Agent chat or the Cursor CLI.

**Model question:** ask in chat. Two cases:
- The judge runs on the **claude CLI** (the default when it's installed): Sonnet (recommended), Opus, Haiku.
- The judge runs on the **Cursor CLI** (`--runner cursor`): any id from `agent --list-models`, or "same as me" (`inherit`, the `model` Cursor sends to the hook).

**Turn it on** (from the project root):
```bash
node <skill>/scripts/aj.mjs on --platform cursor --model sonnet
```
- **What it writes:** three entries in `<project>/.cursor/hooks.json` (or `~/.cursor/hooks.json` with `--global`). Ours are recognised by the `cursor-hook.mjs` path; anything else in the file stays.
  - `beforeSubmitPrompt`: stores the user's words. It always answers `{"continue": true}`, so it never blocks a prompt.
  - `afterAgentResponse`: stores the agent's final text.
  - `stop`: on `status: "completed"`, judges the reply synchronously. On HALLUCINATION it returns `{"followup_message": …}`, which Cursor submits as the next message. The agent then tells the user and corrects itself.
- **Loops:** our cap (2 per user message) plus `loop_limit: 3` on the stop hook. Our own follow-up message is recognised by its `[assumption-judge]` prefix: it doesn't count as the user's words, and doesn't reset the count.
- **Context:** the judge gets the trace and the earlier user messages from `transcript_path` when Cursor writes transcripts, and otherwise from what the hooks recorded. With no trace, the judge is told that a missing tool call is not evidence.
- **Global scope:** a project with its own entry wins, and the global hook stands down, so nothing runs twice.
- **`off`** removes our three entries.

**Judge runners**
- `claude` (default when installed): `claude -p` with Read, Grep, Glob, WebSearch and WebFetch only. Strictest isolation.
- `cursor`: `agent -p --mode ask --output-format json --trust --workspace <project>`. Ask mode is read-only. The packet goes through a file, because Windows caps a command line at about 32k characters. Untested: whether ask mode gets web search in headless runs. If it doesn't, the judge marks web-only facts `unverifiable` and nothing false gets through.
- `agy` also works if Antigravity is installed.

**Simulated test** (Windows 11, November 2026). The documented payloads were piped into the exact `hooks.json` commands, with the agy runner and `claude-sonnet-4-6` as judge, against a fixture where `config.toml` says `port = 9090`:
- `beforeSubmitPrompt` → `{"continue":true}`; `afterAgentResponse` → `{}`
- a short "Got it." turn was skipped
- a reply claiming "Per config.toml the server listens on port 8080" got `{"followup_message": …}` in 21.6 s, citing `config.toml line 3: port = 9090`

**Known Cursor issue:** a forum report (2026) says that on Windows, some Cursor builds ignore a stop hook's `followup_message`. If a catch never reaches the agent, `aj.mjs status` still shows it, and check mode is the fallback.

## Claude app (desktop and claude.ai)

- **Code tab of the Claude desktop app:** that's Claude Code. Use the Claude Code section.
- **Cowork:** Cowork plugins use the Claude Code plugin format, and Anthropic's docs say hooks and subagents run there (not in chat). Install the plugin (`/plugin marketplace add mirac221/assumption-judge`). Not tested in Cowork. If the hooks don't fire there, use check mode: Cowork has subagents.
- **claude.ai chat** (web, desktop or mobile chat): no hooks, no subagents, no local CLI. Upload the zip from `node scripts/install.mjs --zip` (Settings > Capabilities > code execution on, then Skills > Upload). It then runs in **relay mode**, below.

## ChatGPT app

- **Codex mode in the ChatGPT desktop app** (the former Codex app, merged into ChatGPT in July 2026): same skills folder (`~/.agents/skills/`), same hooks, same `$assumption-judge`. Use the Codex section. Codex hooks run in the desktop app after you review them (Settings > Hooks).
- **ChatGPT Work:** skills load from uploads, and Work can run subagents in its hosted environment. Plugin hooks don't run in cloud-orchestrated Work. Use check mode with a fresh subagent: the packet and gate scripts run wherever the skill's scripts can run. If they can't, use relay mode.
- **ChatGPT Chat:** upload the zip (Skills > Create > Upload from your computer) and invoke it with `@assumption-judge`. Relay mode.

## Chat apps: relay mode

For any app with no hooks and no way to start an independent agent:
1. Build the packet as in check mode (`aj.mjs packet …`) if scripts can run. If they can't, write the packet by hand: the full text of `references/judge-brief.md`, then the USER, REPLY and TRACE blocks exactly as in `buildPacket`.
2. Hand the packet to the user. They paste it into a **fresh chat** (any model with web search), then paste the JSON reply back.
3. Gate it with `aj.mjs gate --verdict` if scripts can run. Otherwise apply the gate rules from SKILL.md yourself, and say you did.
4. Never play the judge yourself and call it independent. If the user doesn't want to relay, say plainly that this reply wasn't independently checked.

## Fallback ladder (anything else)

Use the first one that works, and tell the user which one:
1. **Native subagent with web search**, fresh and never a fork.
2. **Headless judge via the claude CLI.** `aj.mjs check --prompt-file p --reply-file r` works anywhere the claude CLI is installed.
3. **Human relay.** Hand the user `.assumption-judge/packet.md` for any chat model with web search, then run `aj.mjs gate --verdict` on the JSON they paste back.
4. **Nothing available.** Say the reply wasn't independently checked. Never play the judge yourself and call it independent.
