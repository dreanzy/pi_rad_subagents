# rad-subagents

[![GitHub](https://img.shields.io/badge/repo-github-blue)](https://github.com/dreanzy/pi_rad_subagents)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![English](https://img.shields.io/badge/lang-English-blue)](README.md)

[pi](https://pi.dev) Agent 的 Subagent 工具 — 将任务委托给具有隔离上下文窗口的专业化 agent。

灵感来自 [omos](https://github.com/alvinunreal/oh-my-opencode-slim) 的 agent 编排模式。

## 安装

```bash
pi install git:github.com/dreanzy/pi_rad_subagents
# 或本地开发
pi install /path/to/pi_rad_subagents
# 重载扩展
/reload
```

安装后，在输入框输入 `@` 即可通过自动补全查看可用 agent。

## 用法

### 单次委托

```
rad-subagents(agent: "explorer", task: "find all auth-related code")
```

### 并行委托

```
rad-subagents(tasks: [
  { agent: "explorer", task: "find model files"    },
  { agent: "librarian", task: "check ORM docs" }
])
```

### 链式委托

```
rad-subagents(chain: [
  { agent: "explorer", task: "find auth code" },
  { agent: "fixer", task: "implement based on {previous}" }
])
```

### 工具参数

| 参数 | 说明 |
|------|------|
| `agent` | 要调用的 agent 名称（单次模式） |
| `task` | 要委托的任务（单次模式） |
| `tasks` | 并行执行的 `{agent, task}` 数组 |
| `chain` | 顺序执行的 `{agent, task}` 数组；支持 `{previous}` 占位符引用上一步输出 |
| `agentScope` | 使用的 agent 目录：`"user"`（默认）、`"project"` 或 `"both"`（启用项目本地 agent `.pi/agents`） |
| `confirmProjectAgents` | 运行项目本地 agent 前是否确认。默认 `true` |
| `cwd` | agent 进程的工作目录（单次模式） |
| `timeoutMs` | 应用于所有任务/步骤的默认超时；单项 `timeoutMs` 优先。到时限时 subagent 被终止（部分输出以 `stopReason: "timeout"` 返回）。省略则无超时——建议设置 |

`tasks` 和 `chain` 的每个条目也支持可选的 `cwd` 和 `timeoutMs`。

### Orchestrator 模式

```
/orchestrate
/orchestrate off
```

切换工作流管理器模式。启用后，LLM 充当编排者 — 规划、委托给专业 agent（`@explorer`、`@fixer`、`@oracle` 等），并整合结果。

默认开启；可通过 `rad-subagents.json` 中的 `orchestrator.enabled: false` 关闭（见配置）。

## Agent 舰队

| Agent | 角色 | 工具 |
|-------|------|------|
| `deepwork` | 分阶段深度工作 | rad-subagents, read, grep, find, ls, bash, write, edit |
| `explorer` | 快速代码库侦察 | read, grep, find, ls, bash |
| `librarian` | 外部知识 + 网络研究 | read, grep, find, ls, bash |
| `oracle` | 架构决策 + 代码审查 | read, grep, find, ls, bash |
| `designer` | UI/UX 设计与实现 | read, grep, find, ls, bash, write, edit |
| `fixer` | 有界实现专家 | read, grep, find, ls, bash, write, edit |
| `observer` | 视觉/媒体分析（需视觉模型） | read, grep, find, ls |

`observer` 委托给支持图像输入的模型；若配置的模型无法看图，委托会以明确错误失败。

### 内置别名

常见角色名已预映射到真实 agent：无论何时被提及（通过 `rad-subagents` 或 `@提及`）都可用，但不会出现在自动补全和 orchestrator 工作流中。它们在运行时解析为目标 agent 的配置（包括你 JSON 里的 `agents.<name>` 覆盖），因此自动保持同步。

| 别名 | 目标 |
|------|------|
| `general-purpose` | `oracle` |
| `scout` | `explorer` |
| `worker` | `fixer` |
| `researcher` | `librarian` |
| `reviewer` | `oracle` |

用户 `agentAliases` 在同名时覆盖内置别名。

## 配置

配置从 `.pi/rad-subagents.json`（从 cwd 向上查找）或 `~/.pi/agent/rad-subagents.json` 加载。

优先级：**项目 JSON > 全局 JSON > agent `.md` frontmatter > 内置默认**。

示例 `.pi/rad-subagents.json`：

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

| 键 | 类型 | 说明 |
|----|------|------|
| `defaultModel` | string | 未指定模型的 agent 的默认模型（支持 `model:level` 语法） |
| `agents.<name>.model` | string \| string[] | 主模型，或回退模型数组（第一个为主）。支持 `model:level` 语法 |
| `agents.<name>.tools` | string[] | 工具白名单覆盖 |
| `agents.<name>.description` | string | 覆盖展示给 LLM 的 agent 描述 |
| `agents.<name>.disabled` | boolean | 完全禁用某个 agent |
| `agentAliases` | object | 将未知 agent 名映射到真实 agent（如 `@navigator` → `explorer`）。内置别名已覆盖 `general-purpose`→`oracle`、`scout`→`explorer`、`worker`→`fixer`、`researcher`→`librarian`、`reviewer`→`oracle`；用户条目在同名时覆盖内置 |
| `orchestrator.enabled` | boolean | Orchestrator 模式开关。默认 `true` |

## 开发

```bash
git clone https://github.com/dreanzy/pi_rad_subagents.git
cd pi_rad_subagents
npm ci
npm run typecheck     # 类型检查
npm test              # 运行测试
```

## 许可

MIT
