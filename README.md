# 知测 AI

面向重业务 B 端前端团队的 AI 测试工作台。主流程是：版本管理、导入 PRD、需求结构化、页面状态建模、问题澄清、测试用例生成和 Playwright 执行。

## 本地运行

```bash
npm install
npm run dev
```

本地页面运行在 `http://127.0.0.1:4173`，TypeScript API 运行在 `http://127.0.0.1:8787`。

持久数据路径以仓库根目录为基准，不随终端启动目录变化。默认数据库位于 `data/quality-ai.sqlite`，登录态位于 `data/auth`，执行证据位于 `data/artifacts`，源码项目配置位于 `config/projects.local.json`；已有文件无需移动。

可通过 `QUALITY_AI_DATA_ROOT` 指定数据根目录，通过 `QUALITY_AI_DATABASE_PATH` 单独覆盖数据库位置，通过 `PROJECTS_CONFIG_PATH` 覆盖项目配置。相对路径均相对于仓库根目录，绝对路径保持原样；只覆盖数据库位置不会同时迁移登录态或产物。项目配置中相对的源码 `root` 也按仓库根目录解析。

在 `.env.local` 中配置模型，文件已被 Git 忽略：

```dotenv
MODEL_API_KEY=your-company-key
MODEL_BASE_URL=http://ai-service.tal.com/coding/v1
MODEL_PROTOCOL=openai-responses
MODEL_NAME=gpt-5.6-terra
MODEL_USER_AGENT=codex_cli_rs/你的本机版本（操作系统；架构）
MODEL_ORIGINATOR=codex_cli_rs
API_PORT=8787
```

生产构建与静态预览：

```bash
npm run build
npm run start
```

## 连接本地被测项目

源码辅助是可选能力。`quality-ai` 没有连接源码时仍可进行黑盒测试；连接后，测试 Agent 可以在 DOM 信息不足时按 URL 查询路由并读取有限的页面、组件或 API 源码。

先创建仅供本机使用的软链：

```bash
mkdir -p targets
ln -s /path/to/lvworkbench targets/lvworkbench
```

然后复制配置示例并按实际被测子项目修改：

```bash
cp config/projects.example.json config/projects.local.json
```

`targets/*` 和 `config/projects.local.json` 都已被 Git 忽略。服务端会解析软链真实路径，并仅允许读取 `sourceRoots` 中指定的源码；`node_modules`、构建产物和 Git 目录默认排除。可通过以下接口检查连接和按需检索：

- `GET /api/projects`：列出本地项目及连接状态
- `POST /api/projects/:id/validate`：校验项目根目录、源码目录和 Git 信息
- `POST /api/projects/:id/resolve-route`：根据页面 URL 查询路由和懒加载组件
- `POST /api/projects/:id/search-source`：在允许范围内搜索源码
- `POST /api/projects/:id/inspect-source`：按明确原因读取有限的指定文件

本地配置也可通过 `PROJECTS_CONFIG_PATH` 指向其他 JSON 文件。业务页面运行时状态仍以真实 DOM 为准，源码查询结果只作为辅助上下文。

## 当前实现

- Vue 3 + TypeScript + Vite
- 公司 coding 网关 OpenAI Responses 模型适配层
- PDF、Markdown、TXT PRD 与接口技术文档的多文件联合解析；文本型 PDF 服务端提取正文，扫描件会提示先进行 OCR
- 基于 Node.js 内置 SQLite 的本地持久化
- 0825 版本两个真实需求的解析验证
- 需求概览、页面状态、待确认问题、测试用例四段式流程
- 版本记录自动沉淀、版本摘要进度展示与历史版本一键切换
- PRD 文件选择、需求切换、问题确认、用例选择等前端交互
- 问题确认和用例选择的刷新恢复
- Playwright 受控步骤 DSL、真实 Chromium 执行、截图与结果持久化
- 语义 DOM 快照、临时 `elementRef` 注册表、弹窗/表格/页面消息提取与快照失效保护
- `POST /api/automation/observe` 页面观察接口，可复用测试环境的 `storageState`
- 受控单步 Agent 动作、`snapshotId`/`elementRef` 策略校验和必要断言完成门禁
- Responses 单步决策 Provider，使用紧凑上下文和 AgentDecision Schema 校验，格式错误时按校验反馈修复
- `POST /api/automation/agent/run` 源码增强执行闭环：真实页面观察、公司模型单步决策、受控动作、按需源码读取、DOM 回验与轨迹持久化
- 测试用例页支持选择源码项目后发起 Agent 动态执行，执行中心展示逐轮 DOM 观察摘要、动作、源码上下文、结果与终态
- 选中业务用例后由公司模型生成受控 DSL，并可对指定测试环境立即执行
- 测试环境持久化与 Playwright `storageState` 登录态导入、复用
- 登录态仅保存在 Git 忽略的 `data/auth` 目录，接口只返回是否已配置，不返回凭据或磁盘路径
- 执行中心集中展示执行历史、通过率、失败原因、步骤耗时与证据下载
- 执行记录关联版本、用例、自动化计划和测试环境，并支持按原计划重新执行

未导入 PRD 时页面显示示例数据；成功导入后会明确显示“真实解析”，刷新页面会从 SQLite 恢复最近一次结果。

需要测试登录后的 B 端页面时，可先使用 Playwright 生成登录态文件：

```bash
npx playwright codegen --save-storage=storage-state.json https://你的测试环境地址
```

在打开的浏览器中完成登录并关闭窗口，然后在“测试用例”页签保存测试环境并导入该 JSON。后续确认执行 AI 计划时会自动复用对应环境的登录态。

## 常用命令

- `npm run dev`：启动开发服务器
- `npm run build`：生成生产构建
- `npm run test`：执行服务端单元测试和生产构建
- `npm run test:unit`：执行服务端单元测试
- `npm run typecheck`：检查 Vue、API 与共享契约类型
- `npm run lint`：检查构建与服务端配置代码
