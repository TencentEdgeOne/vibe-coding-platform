# Vibe Coding Platform

> 一个基于 Claude Agent SDK 和 EdgeOne Makers 的沙箱 Web 开发 Agent。

**框架：** Claude Agent SDK · **分类：** Coding · **语言：** TypeScript

[![部署到 EdgeOne Makers](https://cdnstatic.tencentcs.com/edgeone/pages/deploy.svg)](https://console.cloud.tencent.com/edgeone/makers/new?template=vibe-coding-agent&from=within&fromAgent=1&agentLang=typescript)

## 概览

> **这是哪个 Vibe Coding 模板？** 本模板在沙箱内驱动 EdgeOne CLI，生成的项目可以直接获得沙箱内实时预览
> （`edgeone makers dev`），并通过 `edgeone makers deploy` 部署。另一个同名模板在沙箱外经由 Makers SDK
> 部署，不支持沙箱预览。如果你希望用户在正式上线前先看到生成的应用跑起来，就用这一个。

Vibe Coding Platform 可以把自然语言需求转换为可运行的 Web 项目。每个会话会准备一个隔离的临时沙箱工作区，在其中创建或修改项目文件、安装依赖、发布实时预览，并把验证结果反馈回 Agent 循环。它适合需要生成应用、查看预览、浏览文件的一体化 Coding 类 Makers 模板。

- **临时沙箱工作区** — 在当前会话对应的临时沙箱中创建和修改项目代码
- **适配 Makers 的生成** — 静态站、Cloud Functions、Edge Functions、`agents/` AI 接口等可在 Makers 本地预览的布局
- **Claude Agent SDK 循环** — 使用 EdgeOne 沙箱 MCP 工具、内置 Makers skills 和受限工具集运行模型
- **实时预览** — 在沙箱内启动 `edgeone makers dev`，并把该 URL 展示在右侧面板（不是云端 `makers deploy`）
- **一键部署** — 项目生成完成后，右上角按钮不经过模型直接执行 `edgeone makers deploy`，线上地址进入与模型部署同一条部署状态
- **Makers 语义代码视图** — 为 `agents/`、Cloud/Edge Functions、中间件和 `edgeone.json` 标注能力徽标与推导路由
- **验证反馈** — 执行 skills 驱动的 Makers 兼容性 lint、构建或 Python 编译检查，失败时尝试一轮自动修复

## 环境变量

| 变量 | 是否必填 | 说明 |
|----------|----------|-------------|
| `AI_GATEWAY_API_KEY` | 是 | 模型网关 API Key。使用 Makers Models API Key，或任意 OpenAI 兼容供应商的 Key。 |
| `AI_GATEWAY_BASE_URL` | 是 | 网关 Base URL。使用 Makers Models 时填写 `https://ai-gateway.edgeone.link/v1`。 |
| `AI_GATEWAY_MODEL` | 否 | 模型 ID。默认值为 `@makers/deepseek-v4-flash`（Makers 内置模型）。它同时是输入框模型选择器的初始项，以及没人手动选择时实际运行的模型。 |
| `AI_GATEWAY_EXTRA_MODELS` | 否 | 为输入框的模型选择器追加条目，格式为逗号分隔的 `id\|展示名`（展示名可省略）。内置模型已经在列表中，这里用于填写已在控制台绑定 Key 的厂商模型，例如 `deepseek/deepseek-v4-pro\|DeepSeek V4 Pro`。所有条目共用同一套网关 Key 与 Base URL，因此它扩展的是可选模型而不是可选厂商。不在最终列表中的模型会被服务端拒绝。 |
| `API_TOKEN` | 部署必需 | Makers 主 API Token。它只保留在 Agent Runtime 中，为直接沙箱 CLI 调用签发并注入按项目隔离的临时 tenant token。线上部署以及 Blob 等带凭证的本地后端必须配置；不填时对话和纯前端预览仍可用，但部署会失败。不要提交到仓库。 |
| `MAKERS_DEPLOY_PROJECT_NAME` | 否 | 把所有会话固定到同一个 Makers 项目。建议留空：留空时预览与部署都按会话派生出独立项目名，后续轮次落在同一个站点，不同用户也不会撞名。 |

本模板遵循 OpenAI 兼容标准，可以将这些变量指向 Makers Models 或任意兼容供应商。

### 如何获取 `AI_GATEWAY_API_KEY`

1. 打开 [Makers Console](https://edgeone.ai/makers/new?s_url=https://console.tencentcloud.com/edgeone/makers)。
2. 登录并启用 Makers。
3. 进入 **Makers → Models → API Key** 并创建 Key。
4. 将它填写到 `AI_GATEWAY_API_KEY`。

内置模型免费但有额度限制，适合验证使用。生产环境请在控制台绑定自己的模型供应商 Key。

### 供应商兜底变量

Agent 会优先使用 `AI_GATEWAY_*` 变量。需要时也可以使用 Anthropic 兼容或 DeepSeek 兼容变量作为兜底：

| 变量 | 是否必填 | 说明 |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | 否 | Anthropic 兼容 API Key 兜底。 |
| `ANTHROPIC_AUTH_TOKEN` | 否 | Anthropic 兼容认证 Token 兜底。 |
| `ANTHROPIC_MODEL` | 否 | Anthropic 兼容模型兜底。 |
| `ANTHROPIC_BASE_URL` | 否 | Anthropic 兼容 Base URL 兜底。 |
| `ANTHROPIC_CUSTOM_HEADERS` | 否 | 传给 Anthropic SDK 的额外请求头。 |
| `DEEPSEEK_API_KEY` | 否 | DeepSeek 兼容 API Key 兜底。 |
| `DEEPSEEK_MODEL` | 否 | DeepSeek 兼容模型兜底。 |
| `DEEPSEEK_BASE_URL` | 否 | DeepSeek 兼容 Base URL 兜底。 |
| `CLAUDE_CODE_EXECUTABLE_PATH` | 否 | 可选的 Claude Code 可执行文件路径。 |

## 本地开发

**前置依赖：** Node.js、npm，以及 EdgeOne CLI（`npm install -g edgeone`）。

```bash
npm install
cp .env.example .env    # 然后填入 AI_GATEWAY_API_KEY
edgeone makers dev      # 在 http://localhost:8088 提供服务
```

只有当生成的项目使用 Blob 等需要凭证的后端时才需要 `edgeone login`；纯静态预览无需登录。

打开 `http://localhost:8088/agent-metrics` 查看 CLI 提供的本地可观测面板。

提交改动前请运行 `npm test` 和 `npm run typecheck`。

## 项目结构

```text
├── app/                    # Next.js 前端界面
│   ├── layout.tsx          # 应用元数据和根布局
│   ├── page.tsx            # 入口界面
│   ├── i18n.ts             # 中英文界面文案
│   ├── features/           # 工作区：对话、进度、预览、文件浏览
│   ├── components/         # 复用的功能组件
│   ├── hooks/ lib/ types/  # 前端辅助逻辑
│   └── globals.css styles/ # 样式
├── agents/                 # EdgeOne Makers Agent 路由和流水线
│   ├── chat.ts             # POST /chat：创建并流式返回；GET /chat：重连
│   ├── resume.ts           # /resume：刷新后恢复会话
│   ├── stop.ts             # /stop：中止当前轮次
│   ├── file.ts             # /file：读取单个项目文件
│   ├── status.ts download.ts transcript.ts
│   ├── _agent.ts           # Claude Agent SDK 集成
│   ├── _constants.ts       # 运行时常量
│   ├── _memory.ts          # 对话历史和项目状态
│   ├── _prompt.ts          # 系统提示词
│   ├── _types.ts           # 共享 TypeScript 类型
│   ├── pipelines/          # 对话、部署、恢复、文件读取流水线
│   ├── project/            # 沙箱项目、预览、部署、验证
│   ├── tools/              # 自定义 scaffold/write 工具及直接 CLI 生命周期观察器
│   └── utils/              # 路径、文本、叙述和构建错误辅助逻辑
├── shared/                 # app/ 与 agents/ 共用的辅助逻辑
├── components/ lib/        # UI 基础组件和工具函数
├── tests/                  # node:test 用例，通过 npm test 运行
├── .claude/skills/         # 适配沙箱后的 Makers skills
├── edgeone.json            # Agent 运行时配置
├── next.config.ts          # 模板应用的 Next.js 配置
├── package.json            # 脚本和依赖
└── tsconfig.json           # TypeScript 配置
```

以 `_` 开头的文件是私有模块，不会作为 EdgeOne 公开路由暴露。

## 工作原理

Agent 在 `agents/` 下以会话模式运行。带有相同 `conversation_id` 的请求会路由到同一个运行时实例，并在沙箱生命周期内复用同一个临时项目工作区。

1. **提交并流式返回** — 前端携带消息和 `Makers-Conversation-Id` 请求头调用 `POST /chat`。接口持久化任务后在同一个 SSE 响应中持续返回事件，因此正常一轮只调用一次 Agent 路由；从首页发起的新请求也可以设置 `resetProject: true` 来重建项目工作区。
2. **状态恢复** — Chat pipeline 从 `context.store` 读取对话历史；沙箱已回收时，通过 `context.sandbox.restore()` 从项目 Blob 恢复生成源码。
3. **LLM 与工具循环** — Claude Agent SDK 使用 `edgeone-sandbox` MCP 服务、`permissionMode: 'dontAsk'` 和仅限沙箱的工具运行。Agent 必须先调用 `ensure_project_scaffold`，再读取或写入项目文件。
4. **项目编辑** — 生成的源码通过 `write_project_file` 按文件逐个写入，让进度持续反馈到界面。命令执行和依赖安装都在沙箱内完成；代码面板会依据目录约定直接推导 Makers 能力徽标和公开路由。
5. **直接 CLI 预览与部署** — 模型通过通用 `commands` 工具直接调用目标沙箱镜像提供的 `edgeone makers dev` / `edgeone makers deploy --json`。Makers dev 监听 8088，3000 端口的轻量代理剥离路径前缀，再由沙箱固定的 9000 网关通过 `/preview/` 发布到右侧面板；部署 JSON 则进入独立部署状态。宿主只保留一层薄观察器，在配置后注入短期 tenant token，主 token 不会进入沙箱或模型上下文。镜像能力尚未上线时，观察器会返回终止型 `MAKERS_CLI_UNAVAILABLE` 错误，并禁止安装、路径探测、`npx` 和重试兜底。
6. **验证检查** — 预览/部署前以及确定性验证阶段，运行时会把 vendored skills 的 `pathPatterns`/`validate` 元数据与结构性 Makers 规则转换为沙箱 lint；随后在 Node 项目包含 build 脚本时运行 `npm run build`，存在 Python 文件时运行 `python -m compileall .`。任一检查失败都会进入现有的一轮自动修复链路。
7. **持久化、SSE 与重连** — 源码检查点通过 `context.sandbox.persist()` 写入当前项目保留的 `__sandbox` Blob Store，归档字节不再经过对话元数据。正常生成通过 `POST /chat` 的 SSE 接收状态、日志、工具、文件、预览、构建状态和最终回复；页面刷新后使用 `GET /chat?runId=...` 重连任务，`GET /resume` 在同一 SSE 连接中恢复工作区并预热最多 48 个、总计 2 MiB 的文本文件。

文件路由为 `/file?path=<relative-path>`，并使用同一会话上下文从沙箱项目读取文本文件。沙箱凭证由运行时提供，本地无需配置。沙箱实例仍是临时资源，生命周期由 `agents.sandbox.timeout` 控制；持久化源码计入用户当前项目的 Blob 存储和配额。

## 资源

- [Makers Agents 文档](https://cloud.tencent.com/document/product/1552/132759)
- [Agent 开发快速开始](https://cloud.tencent.com/document/product/1552/132786)
- [Makers Models](https://cloud.tencent.com/document/product/1552/132748)

## 许可证

MIT，详见 [LICENSE](./LICENSE)。
