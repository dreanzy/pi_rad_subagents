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

## Usage

### Single delegation

```
rad-subagents(agent: "explorer", task: "find all auth-related code")
```

### Parallel delegation

```
rad-subagents(tasks: [
  { agent: "explorer", task: "find model files" },
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

## Agent Fleet

| Agent | Role | Tools |
|-------|------|-------|
| `deepwork` | Phase-gated deep work | rad-subagents, read, grep, find, ls, bash, write, edit |
| `explorer` | Codebase reconnaissance | read, grep, find, ls, bash |
| `librarian` | External knowledge + web research | read, grep, find, ls, bash |
| `oracle` | Architecture decisions + code review | read, grep, find, ls, bash |
| `designer` | UI/UX design + implementation | read, grep, find, ls, bash, write, edit |
| `fixer` | Bounded implementation specialist | read, grep, find, ls, bash, write, edit |
| `observer` | Visual/media analysis | read, grep, find, ls |

## Configuration

Config is loaded from `.pi/rad-subagents.json` (walked up from cwd) or `~/.pi/agent/rad-subagents.json`.

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
    }
  }
}
```

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
