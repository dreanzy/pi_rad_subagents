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

## 用法

### 单次委托

```
rad-subagents(agent: "explorer", task: "find all auth-related code")
```

### 并行委托

```
rad-subagents(tasks: [
  { agent: "explorer", task: "find model files" },
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

## Agent 舰队

| Agent | 角色 | 工具 |
|-------|------|------|
| `deepwork` | 分阶段深度工作 | rad-subagents, read, grep, find, ls, bash, write, edit |
| `explorer` | 快速代码库侦察 | read, grep, find, ls, bash |
| `librarian` | 外部知识 + 网络研究 | read, grep, find, ls, bash |
| `oracle` | 架构决策 + 代码审查 | read, grep, find, ls, bash |
| `designer` | UI/UX 设计与实现 | read, grep, find, ls, bash, write, edit |
| `fixer` | 有界实现专家 | read, grep, find, ls, bash, write, edit |
| `observer` | 视觉/媒体分析 | read, grep, find, ls |

## 配置

配置从 `.pi/rad-subagents.json`（从 cwd 向上查找）或 `~/.pi/agent/rad-subagents.json` 加载。

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
    }
  }
}
```

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
