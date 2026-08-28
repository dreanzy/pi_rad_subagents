# rad-subagents

[![GitHub](https://img.shields.io/badge/repo-github-blue)](https://github.com/dreanzy/pi_rad_subagents)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![中文文档](https://img.shields.io/badge/lang-中文-red)](README.zh.md)

Subagent Tool for [pi](https://pi.dev) Agent — delegate tasks to specialized agents with isolated context windows.

Inspired by [omos](https://github.com/alvinunreal/oh-my-opencode-slim)'s agent orchestration pattern.

## Installation

```bash
pi install git:github.com/dreanzy/pi_rad_subagents
# or local dev
pi install /path/to/pi_rad_subagents
# Reload extensions
/reload
```

After install, typing `@` in the input shows available agents via autocomplete.

## Usage

### Single delegation

```
rad-subagents(agent: "explorer", task: "find all auth-related code")
```

### Parallel delegation

```
rad-subagents(tasks: [
  { agent: "explorer", task: "find model files"    },
  { agent: "librarian", task: "check ORM docs" }
])
```

### Chained delegation

```
rad-subagents(chain: [
  { agent: "explorer", task: "find auth code" },
  { agent: "fixer", task: "implement based on {previous}" }
])
```

### Tool parameters

| Parameter | Description |
|-----------|-------------|
| `agent` | Agent name to invoke (single mode) |
| `task` | Task to delegate (single mode) |
| `tasks` | Array of `{agent, task}` for parallel execution |
| `chain` | Array of `{agent, task}` for sequential execution; supports `{previous}` placeholder for prior output |
| `agentScope` | Agent directories to use: `"user"` (default), `"project"`, or `"both"` for project-local agents (`.pi/agents`) |
| `confirmProjectAgents` | Prompt before running project-local agents. Default: `true` |
| `cwd` | Working directory for the agent process (single mode) |
| `resumeSession` | Path to a pi session file (jsonl) kept by a previous timed-out run (see `sessionFile` in the result / `[session kept for resume: ...]` in the TUI). Resumes that conversation (`--session <file>`) instead of starting fresh — the subagent continues from the earlier run's partial findings. Single mode only. Note: the session file only contains useful context if the timed-out run got far enough for pi to write messages — a very tight timeout budget (≲30s on slow models) may leave an empty session, in which case resuming reports `resumeSession file not found`; size the budget so the run can at least start working |
| `timeoutMs` | Default timeout applied to all tasks/steps; per-task `timeoutMs` overrides. The subagent is killed at the deadline (partial output returned with `stopReason: "timeout"`). Omit for no timeout — setting one is recommended |
| `retryOnTimeout` | Automatic retries after a task-level timeout (default `1`, max `3`, `0` disables). Each retry gets a fresh wall-clock budget; the partial output from the timed-out attempt is injected as `CONTEXT:` so the retry resumes instead of restarting from scratch. The final result keeps `stopReason: "timeout"` and reports `timeoutRetries`. A run that goes silent for 120s is flagged `possiblyStuck` in the result. When retries are exhausted, the pi session file is kept (`sessionFile` in the result, `[session kept for resume: ...]` in the TUI) so the task can be resumed later; stale sessions older than 24h are swept on each spawn |

`tasks` and `chain` items also accept optional `cwd` and `timeoutMs` per item.

### Orchestrator mode

```
/orchestrate
/orchestrate off
```

Toggle workflow manager mode. When enabled, the LLM acts as orchestrator — plans, delegates to specialists (`@explorer`, `@fixer`, `@oracle`, etc.), and integrates results.

On by default; disable with `orchestrator.enabled: false` in `rad-subagents.json` (see Configuration).

### Model check command

```
/rad-models-check
```

Validate every model reference in `rad-subagents.json` (project and global) — `defaultModel` plus each agent's `model` array, including fallback entries — against the pi model registry.

A reference is reported invalid when:

- the model is unknown in the registry, or
- its provider has no configured auth, or
- a live probe fails with a model-level error (e.g. `400 unsupported_model` for models delisted from their endpoint)

Probing sends one minimal completion per statically-valid reference (bounded 15s timeout, concurrency 4, Escape-cancellable progress display). Transient errors (rate limits, network) are treated as inconclusive and do not flag the model. The report is grouped per config file and ends with a summary line; non-TUI sessions get a notify summary instead.

## Agent Fleet

| Agent | Role | Tools |
|-------|------|-------|
| `deepwork` | Phase-gated deep work | rad-subagents, read, grep, find, ls, bash, write, edit |
| `explorer` | Codebase reconnaissance | read, grep, find, ls, bash |
| `librarian` | External knowledge + web research | read, grep, find, ls, bash |
| `oracle` | Architecture decisions + code review | read, grep, find, ls, bash |
| `designer` | UI/UX design + implementation | read, grep, find, ls, bash, write, edit |
| `fixer` | Bounded implementation specialist | read, grep, find, ls, bash, write, edit |
| `observer` | Visual/media analysis (requires a vision-capable model) | read, grep, find, ls |

`observer` delegates to a model with image input support; delegation fails with a clear error if the configured model can't see images.

### Built-in aliases

Common role names are pre-mapped to real agents and work whenever mentioned (via `rad-subagents` or `@mention`), while staying hidden from autocomplete and orchestrator workflows. They resolve at runtime to the target agent's config — including your JSON `agents.<name>` overrides — so they stay in sync automatically.

| Alias | Target |
|-------|--------|
| `general-purpose` | `oracle` |
| `scout` | `explorer` |
| `worker` | `fixer` |
| `researcher` | `librarian` |
| `reviewer` | `oracle` |

User `agentAliases` override built-in ones on name collision.

JSON `agents.<alias>` overrides (`model`, `tools`, `description`) apply to the alias entry on top of the config it inherits from its target — they never affect the target itself.

## Configuration

Config is loaded from `.pi/rad-subagents.json` (walked up from cwd) or `~/.pi/agent/rad-subagents.json`.

Priority: **project JSON > global JSON > agent `.md` frontmatter > built-in defaults**.

Example `.pi/rad-subagents.json`:

```json
{
  "defaultModel": "opencode-go/deepseek-v4-flash:high",
  "agents": {
    "explorer": {
      "model": ["opencode-go/deepseek-v4-flash", "deepseek/deepseek-v4-flash"]
    },
    "oracle": {
      "model": ["opencode-go/deepseek-v4-pro:xhigh", "deepseek/deepseek-v4-pro:xhigh"]
    },
    "fixer": {
      "tools": ["read", "write", "edit", "bash"],
      "disabled": false
    }
  },
  "agentAliases": {
    "navigator": "explorer"
  },
  "orchestrator": {
    "enabled": true
  }
}
```

| Key | Type | Description |
|-----|------|-------------|
| `defaultModel` | string | Default model for agents that don't specify one (supports `model:level` syntax) |
| `agents.<name>.model` | string \| string[] | Primary model, or array of fallbacks (first = primary). Supports `model:level` syntax |
| `agents.<name>.tools` | string[] | Tool allowlist override |
| `agents.<name>.description` | string | Override agent description shown to the LLM |
| `agents.<name>.disabled` | boolean | Disable an agent entirely |
| `agentAliases` | object | Map unknown agent names to real ones (e.g. `@navigator` → `explorer`). Built-in aliases already cover `general-purpose`→`oracle`, `scout`→`explorer`, `worker`→`fixer`, `researcher`→`librarian`, `reviewer`→`oracle`; user entries override built-ins on name collision |
| `orchestrator.enabled` | boolean | Orchestrator mode on/off. Default: `true` |

## Development

```bash
git clone https://github.com/dreanzy/pi_rad_subagents.git
cd pi_rad_subagents
npm ci
npm run typecheck     # type check
npm test              # run tests
```

## License

MIT
