# 项目对接文件（Project Handoff）

> 本文件是 opencode-connection-status 项目的完整对接说明：项目在哪、装在哪、两者关系、数据流、维护流程、已知问题。接手的人从这里开始。

## 1. 位置总览

| 角色 | 路径 | 说明 |
|---|---|---|
| **开发仓库**（源码 + 测试 + 文档） | `D:\HuaweiMoveData\Users\86130\Documents\opencode-connection-status` | Git 仓库，远程：`https://github.com/Flowfangfei/opencode-connection-status`（公开） |
| **安装目录**（opencode 运行时加载） | `C:\Users\86130\.config\opencode\plugin\` | opencode 全局插件目录，自动加载 |
| **CLI 查看器安装位置** | `C:\Users\86130\.config\opencode\connmon.ps1` + `C:\Users\86130\bin\connmon.cmd` | `connmon` 命令入口 |
| **状态数据** | `C:\Users\86130\.cache\opencode\connection-status\status.jsonl` | 运行时产出，append-only JSONL |
| **安装目录的 Git 仓库** | `C:\Users\86130\.config\opencode\.git` | 独立仓库，跟踪已安装副本的变更历史 |

**两个仓库的关系**：开发仓库是源头（source of truth）；安装目录是部署目标。`~/.config/opencode` 自己也有一个 Git 仓库，用于跟踪安装副本和 opencode 配置的变更，但它与 GitHub 远程**不同步**——发布只从开发仓库走。

## 2. 仓库内容

```
opencode-connection-status/          （开发仓库）
├── connection-status.ts             主插件：按会话状态机、看门狗、探测、思考尾巴
├── retry-forever.ts                 伴侣插件：断线重试 + 会话自动恢复（1.x/2.x 双版本）
├── connmon.ps1                      终端面板（独立于 opencode 运行）
├── tests/
│   ├── plugin.test.mjs              主插件测试（20 例）
│   └── retry-forever.test.mjs       retry-forever 测试（15 例）
├── docs/
│   ├── ARCHITECTURE.md              架构与实现细节 + 测试报告
│   ├── screenshot-panel.png         README 主图
│   └── screenshot-detail.png        README 细节图
├── README.md                        使用说明（含动机、安装、场景解读、已知问题）
├── HANDOFF.md                       本文件
├── package.json                     npm test 入口
└── LICENSE                          MIT
```

安装目录侧（`~/.config/opencode/`）：

```
├── plugin/
│   ├── connection-status.ts         ← 从开发仓库复制
│   └── retry-forever.ts             ← 从开发仓库复制
├── connmon.ps1                      ← 从开发仓库复制
├── connmon.cmd                      （在 ~\bin\connmon.cmd，PATH 入口）
├── opencode.jsonc                   opencode 配置（含私人 provider，不入公开仓库）
└── node_modules/                    opencode 运行时依赖（@opencode-ai/sdk 等）
```

## 3. 数据流

```
opencode 进程
├── 事件总线 ──────────┐
├── fetch 补丁 ────────┤
│                      ▼
│   connection-status.ts（每会话独立状态）
│                      │
│                      ▼ 每 5s 看门狗 / 每 60s 空闲探测
│              status.jsonl（追加写）
│                      │
└──────────────────────┼──────► connmon.ps1（tail + 渲染）
                       └──────► 其他脚本（Get-Content -Wait）
```

- 插件与 retry-forever 运行在 opencode 进程内，从事件总线和 fetch 补丁两个角度观察
- 观察结果写入 `status.jsonl`，每行一个 JSON 对象（一次状态变化）
- connmon 只读文件，不依赖 opencode 存活——opencode 卡死时正是最需要它的时候

## 4. 维护流程

### 改代码 → 生效（标准流程）

```powershell
# 1. 在开发仓库改代码、跑测试
cd D:\HuaweiMoveData\Users\86130\Documents\opencode-connection-status
npm test          # 必须 20/20 + 15/15 全绿

# 2. 提交并推送
git add -A; git commit -m "..."; git push

# 3. 同步到安装目录（关键步骤，忘掉这步 = 改动不生效）
Copy-Item connection-status.ts "$env:USERPROFILE\.config\opencode\plugin\" -Force
Copy-Item retry-forever.ts "$env:USERPROFILE\.config\opencode\plugin\" -Force
Copy-Item connmon.ps1 "$env:USERPROFILE\.config\opencode\" -Force

# 4. 重启 opencode（插件在启动时加载，不热更新）
```

### connmon 更新

connmon.ps1 不需要重启 opencode，复制后下一次运行即生效。

### 发布检查单

- [ ] `npm test` 全绿
- [ ] 无隐私泄漏：`rg -i "86130|api[_-]?key|secret|volces" .`（排除 README）应为空
- [ ] 无会话 ID 泄漏：`rg "ses_[a-z0-9]{8,}|msg_[a-z0-9]{8,}" .` 应为空
- [ ] README 与实现一致（环境变量表、场景说明）
- [ ] 提交并推送

## 5. 关键设计决策（为什么是这样）

1. **按会话独立状态**：初版用单一全局状态，并发会话互相覆盖——子代理的 streaming 显示成主会话的思考。现在是 `Map<sessionID, State>`，每个会话独立追踪。
2. **fetch 在途计数是全局的**：模型请求体里没有 sessionID，无法从网络层归属到会话。计数挂在 tracker 上，归属给事件流最后触碰的活跃会话，输出事件到达后自动收敛。
3. **探测分两条路径**：静默探测（模型请求挂起 45s 无输出）和空闲探测（无请求在途时每 60s）。前者判断"模型是不是卡了"，后者回答"现在线通不通"。都只在状态变化时 toast，不刷屏。
4. **思考尾巴清空时机**：回答文本开始 = 思考结束。所以 `思考` 行消失意味着模型开始作答。
5. **connmon 不依赖 opencode**：只读状态文件。opencode 卡死时正是最需要监视器的时候。

## 6. 已知问题与限制

1. **思考显示依赖模型行为**：简单问题模型不输出 reasoning（面板无 `思考` 行是正常的）；部分模型/供应商组合可能完全不返回 reasoning，功能静默失效。
2. **opencode 版本差异**：1.x 与 2.x 事件名不同（`message.part.updated` vs `session.next.*.delta`），两套都已处理，但未来版本再改事件结构需要跟进（1.18.31 实测：reasoning 走 `message.part.updated` 快照，不走 delta 事件）。
3. **1.x fetch 重试路径无自动化测试**：需要 fetch 级 mock + 流式 body；2.x aisdk hook 路径同样只有实测覆盖。
4. **connmon 无脚本化断言**：靠渲染检查和人工使用验证。
5. **状态文件无限增长**：目前靠 viewer 只读尾部（600 行）保证性能；文件本身不轮转，长期使用可手动清理。
6. **空闲探测的局限**：探测结果只反映探测那一刻的连通性，发送消息的瞬间仍可能刚好断连。

## 7. 环境变量速查

| 变量 | 默认 | 归属 | 含义 |
|---|---|---|---|
| `OPENCODE_CONN_SILENCE_MS` | 45000 | connection-status | 模型静默多久后探测 |
| `OPENCODE_CONN_RENOTIFY_MS` | 120000 | connection-status | 长等待/持续断连的重复提醒间隔 |
| `OPENCODE_CONN_PROBE_TIMEOUT_MS` | 5000 | connection-status | 探测超时 |
| `OPENCODE_CONN_IDLE_PROBE_MS` | 60000 | connection-status | 空闲背景探测间隔 |
| `OPENCODE_RETRY_DELAY_MS` | 250 | retry-forever | 重试基础间隔 |
| `OPENCODE_RETRY_MAX_ATTEMPTS` | 0（无限） | retry-forever | 单请求最大重试次数 |
| `OPENCODE_RETRY_HONOR_RETRY_AFTER` | true | retry-forever | 尊重 Retry-After 头 |
| `OPENCODE_RETRY_VERBOSE` | true | retry-forever | stderr 打印每次重试 |

## 8. 快速排障

| 症状 | 检查 |
|---|---|
| 面板显示"暂无数据" | opencode 是否重启过（插件启动时才加载）；`status.jsonl` 是否存在 |
| 改动不生效 | 是否忘了同步到安装目录（见 §4）；是否忘了重启 opencode |
| 中文乱码 | 用 `connmon` 入口（内部已强制 UTF-8）；老 conhost 先 `chcp 65001` |
| 空闲时不探测 | 安装目录的插件是否为最新（`Select-String idle-probe-ok`）；provider 是否配置了 `baseURL` |
| toast 不出现 | TUI 是否在前台；`client.tui.showToast` 仅在 TUI 运行时可用，后台降级为 stderr |
