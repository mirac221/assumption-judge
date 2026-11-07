# Platforms: install, live vs check mode, the model question

Checked against Claude Code 2.1.317 and the Antigravity CLI 1.5.3 in November 2026, with live end-to-end tests on both (Windows 11). These tools change fast. If anything here disagrees with your installed version's docs or `--help`, trust those, and tell the user what was different.

| Platform | Mode | Model choice | Independence |
|---|---|---|---|
| Claude Code (CLI, desktop app, IDE) | **Live, in parallel**: background judge, wakes the agent only on HALLUCINATION | Yes, AskUserQuestion | Enforced: a separate process with read and search tools only |
| Antigravity (CLI, IDE, app) | **Live, synchronous**: the Stop hook judges each reply before the turn ends | Yes, any id from `agy models` | A separate `agy -p` process in plan mode; headless mode denies shell commands |
| Codex CLI / app | Check mode, before sending | Ask in chat | Rests on the agent's instructions |
| Cursor and others | Check mode if subagents exist, otherwise the headless judge via the claude CLI | Only if the app supports it | Depends |

**For every platform: the judge sees one turn.** It gets the current user message, the reply and this turn's tool trace, not the earlier conversation. Suppose you told the agent "use port 8080" three messages ago and the config says 9090. Then "8080" gets flagged as unbacked. That's usually what you want, since the config wins, but it is a known source of false alarms.

## Running only on command

assumption-judge is command-only. In ordinary chats it costs only its description. The hooks register when the skill is **invoked**, and not before.
- The description says "command-only, never load it on your own".
- In Codex, `agents/openai.yaml` sets `allow_implicit_invocation: false`.
- **Don't add `disable-model-invocation: true`.** Antigravity then hides the skill completely, as it does for frame-judge.

How to invoke it:
- Claude Code, Cursor, Antigravity: `/assumption-judge`; as a Claude Code plugin, `/assumption-judge:assumption-judge`
- Codex: `$assumption-judge`
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

## Codex (CLI, IDE extension, app)

**Install**
- **Skill:** `~/.agents/skills/assumption-judge/` or `<repo>/.agents/skills/assumption-judge/`.
- **Judge agent:** copy `agents/codex/assumption-judge.toml` to `~/.codex/agents/`.

**Mode:** check mode. Codex only spawns subagents when asked, and the skill instructions count as asking: "Spawn the assumption_judge agent with this message: …".

**Web search** has to be enabled in the user's Codex config. Without it, set `aj.mjs set web off`, so the judge marks web-only facts `unverifiable` instead of guessing.

**Model:** ask in chat. Some versions ignore the per-spawn model (a known mid-2026 issue). If you can't confirm which model the child used, say so.

## Antigravity (App, IDE, CLI)

**Install**
- **Skill:** `<workspace>/.agents/skills/assumption-judge/` or `~/.gemini/config/skills/assumption-judge/`. Antigravity ignores the Claude Code `hooks:` key in SKILL.md frontmatter, and the skill shows up fine (tested).
- **Agent** (check mode only, optional): `agents/antigravity/assumption-judge.md`. `agy agents` on CLI 1.5.3 didn't list workspace agent files, so treat this path as unverified.

**Live mode.** `aj.mjs on --platform antigravity --model <id>`, run from the workspace root:
- **What it writes:**
  - an `assumption-judge` entry in `<workspace>/.agents/hooks.json`
  - a shim, `.agents/assumption-judge-hook.cjs`
- **Why the shim:** Antigravity runs hook commands via `cmd /c` on Windows, and a quoted absolute path then reaches node *with the quotes in it* (seen live). So the command is a quote-free `node assumption-judge-hook.cjs`, and the shim holds the real path.
- **Each Stop** (`terminationReason: NO_TOOL_CALL`):
  1. The hook takes the user's words from `lastUserInput`.
  2. It takes the reply and tool steps from `transcriptPath`: `PLANNER_RESPONSE` steps hold the text and `tool_calls`, and `GENERIC` steps hold the tool results.
  3. It runs `agy -p <packet> --mode plan --output-format json --json-schema <schema> --model <id>`. The packet goes inline when it fits under the Windows command-line limit, and through a file otherwise.
- **On HALLUCINATION** it returns `{"decision":"continue","reason":…}`. Antigravity injects that as a system message and the agent re-enters its loop (tested).
- **Hooks are synchronous.** The turn pauses while the judge runs: about 80 to 120 s with Gemini 3.8 Flash Medium in testing. Pick a faster model or `--runner claude` if that's too slow.
- **`off`** sets `"enabled": false` on the entry. It stays on across sessions until then.
- **Recursion guard:** `ASSUMPTION_JUDGE_CHILD=1` is inherited by the judge's own agy process, so its Stop hook does nothing.

**Model:** run `agy models` and ask in chat. `inherit` uses the session's `modelName`.

**Headless (`agy -p`) gotchas, seen live**
- Print mode auto-denies shell commands, and a denied command ends the run with **no output at all**. The judge is told to use only its file viewer and web search; if it still tries a command, the log says so plainly.
- The Gemini judge tended to flag unverified claims as `assumed` without opening the file that would prove them `contradicted`. The Claude judge (`--runner claude`) did open it. Both still interrupt.
- Each judge run is its own Antigravity conversation, so it shows up in your conversation history.

## Fallback ladder (anything else)

Use the first one that works, and tell the user which one:
1. **Native subagent with web search**, fresh and never a fork.
2. **Headless judge via the claude CLI.** `aj.mjs check --prompt-file p --reply-file r` works anywhere the claude CLI is installed.
3. **Human relay.** Hand the user `.assumption-judge/packet.md` for any chat model with web search, then run `aj.mjs gate --verdict` on the JSON they paste back.
4. **Nothing available.** Say the reply wasn't independently checked. Never play the judge yourself and call it independent.
