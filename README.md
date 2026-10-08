# 知测 AI

面向企业 B 端前端开发、测试和产品人员的可视化测试工作台。支持独立用例设计、需求测试和本地代码变更回归；AI 建议、人工最终口径与实际执行结果分别保存。

当前仍在建设和验收中，不承诺任意页面无人值守通过。已验证层级与未完成项见 [核心验收差距](docs/后续建设计划/核心验收差距.md)、[B端能力矩阵](docs/后续建设计划/B端能力矩阵.md) 和 [执行进度](docs/后续建设计划/执行进度.md)。

## 本地运行

```bash
pnpm install --frozen-lockfile
pnpm dev
```

本地页面运行在 `http://127.0.0.1:4173`，TypeScript API 运行在 `http://127.0.0.1:8787`。

要求 Node >=22.13.0、pnpm 10.23.0。目录划分：`web/` 为 Vue 前端、`api/` 为 Node API、`packages/contracts/` 为前后端共享类型和校验；`data/`、`config/` 留在仓库根目录。内部依赖通过 `workspace:*` 链接，不再跨应用目录引用 shared 源文件。

常用命令：

- `pnpm dev:web` / `pnpm dev:api`：分别启动前后端；也可在对应子目录运行 `pnpm dev`。
- `pnpm build`：构建前端并检查 API/契约类型；前端输出为 `web/dist/`。
- `pnpm start:api`：以 tsx 运行 API 源码，不需要额外生成后端 JavaScript；使用仓库根目录的 `.env.local`（可缺省）。
- `pnpm typecheck` / `pnpm lint`：统一检查，lint 包含 Vue 页面。
- `pnpm --filter @quality-ai/api test -- src/config/paths.test.ts`：只跑指定后端测试。
- `pnpm test:ui`：使用合成数据进行本地 Chromium 页面验收；不操作公司业务环境。

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

生产构建与静态预览（API 需要另一个终端独立运行，`pnpm start` 不会启动 API）：

```bash
pnpm build
pnpm start
```

另一个终端运行 `pnpm start:api`。首次运行浏览器测试前，若缺少 Chromium，可运行 `pnpm exec playwright install chromium`；该命令需要下载浏览器。模型 API、页面登录及部署由使用者配置，不会自动购买服务或部署被测项目。

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

## 页面入口

使用 Hash 路由，例如 `http://127.0.0.1:4173/#/case-designs`。以下为当前实际路由，不是规划中的未来地址。

| 入口 | 用途 |
|---|---|
| `/#/case-designs` | 独立材料分析、用例设计、人工审核、发布和导出 |
| `/#/requirements`、`/#/cases` | 原需求任务和用例资产审核 |
| `/#/regressions` | 本地分支/提交范围、源码影响候选和回归审核 |
| `/#/execution-jobs` | 持久任务、排队/取消、实时画面与过程历史 |
| `/#/executions` | 已保存报告、逐用例结果及证据 |
| `/#/projects`、`/#/environments` | 本地源码连接、测试地址和登录态 |
| `/#/test-fixtures` | 登记执行允许使用的附件 |
| `/#/memory` | 审核带来源的历史经验及其有效性 |

## 场景一：从需求设计用例并测试

1. 在“用例设计”导入材料并确认角色。没有测试环境和源码连接也可以设计用例。文本 PDF 保留提取页码与警告；扫描件/复杂布局可能不完整，不把解析成功当作无遗漏。
2. 查看事实依据、跨文档冲突、场景覆盖和完整用例。区分文档事实、AI 推断与待确认信息；生成器结构检查通过不代表需求理解正确。
3. 人工修改目标、前置条件、步骤、断言及数据策略，保存审核。局部重新生成是新的建议，不覆盖已发布版本。处理阻塞项或明确排除并写明理由后发布，可独立导出 Markdown。
4. 需要执行时选择已审核用例、环境、模式和可选源码项目。固定计划与动态 Agent 使用服务端最终契约；完整搜索取真实完整 option，部分搜索取严格子串，远程分页负例不能凭当前列表推断全局不存在。
5. 启动后到“执行任务”看实时画面和历史。相关用例共享会话；普通失败/受阻记录后继续，取消或会话丢失时剩余用例不冒充通过。
6. 在报告查看实际数据、通过断言、源码版本、首次失败与恢复、截图/Trace。重跑是新记录，不覆盖原失败。

## 场景二：回归本地重构变更

1. 连接本机已有 Git 项目，在“变更回归”选择目标分支/SHA及基线，或选择相关提交。只读取本地对象，不自动 fetch；先看范围预览再冻结。
2. 分支名解析为固定 SHA；后续分支移动不改变本次范围。原工作区无需切分支，平台使用独立 detached worktree 读取目标源码，原未提交内容不纳入变更事实。
3. 查看共享组件调用候选、未解析依赖和 AI 风险。人工纳入/排除风险并写理由，修改和确认回归用例。静态关联不证明某提交已经引入缺陷。
4. 由人员将目标版本部署到测试环境，并登记部署对应信息。版本不匹配需先处理；未核实版本需要明确备注，报告持续提示，不自动探测为匹配。
5. 复用执行任务与报告。失败可返回本次 ChangeSet、人工审核版本和源码证据，不把“关联”写成已证明的因果。

回归详情可查看平台源码快照引用和状态。仅无引用且版本/内容校验通过才能清理；创建中断但目录完整时可“校验并恢复登记”。目录缺失、不完整、被修改或存在遗留引用时保留现场，不强制删除或释放引用。

## 登录态、取消和证据

需要测试登录后的 B 端页面时，可先将登录态保存到本机临时目录：

```bash
pnpm exec playwright codegen --save-storage=/private/tmp/quality-ai-storage-state.json "https://你的测试环境地址"
```

在打开的浏览器中完成登录并正常关闭窗口，再在“测试环境”导入 JSON。文件包含登录凭据，不要提交、公开分享或写进提示词。仅使用 sessionStorage 或额外设备验证的系统可能无法仅靠 storageState 恢复登录，应在测试环境中验证。

关闭预览、切页或浏览器断流不等于取消；从执行任务列表可重新打开同一任务。取消使用专门按钮，不会回滚已提交的业务操作。服务重启后丢失的运行上下文会标为中断，已持久保存的结果保留；未保存事实不能补造，不能无条件接着提交业务动作。

报告提供中文 Markdown 和逐用例证据入口。下载 Trace 后本地打开：

```bash
pnpm exec playwright show-trace /你的本机路径/trace.zip
```

报告中的附件链接需要回到平台访问，不是离线打包。截图/Trace/下载文件可能包含业务数据；缺失产物会明确提示，不从其他执行借用。不要将实际 PRD、数据库、登录态、源码软链或运行产物提交到仓库。

## Skills 与质量评估

三个平台 Skills 按事实提取、测试数据设计和用例审查阶段加载，并记录版本/hash；不是安装到 IDE 的插件。Promptfoo 实际调用相同生产生成函数，对比旧流程、五阶段和加 Skills，样本为公开合成材料。

运行方法见 [评估说明](evals/case-design/README.md)，结果和限制见 [评估记录](docs/后续建设计划/用例生成评估结果.md)。机器通过率不是用例准确率，人工审核材料不会自动签署结论。Docling、Midscene 尚未作为生产默认接入；不能据本地夹具声称公司业务质量已验收。

## 常用命令

- `pnpm dev`：启动开发服务器
- `pnpm build`：生成前端生产构建并检查 API/契约类型
- `pnpm test`：执行服务端单元测试和构建
- `pnpm test:unit`：执行服务端单元测试
- `pnpm typecheck`：检查 Vue、API 与共享契约类型
- `pnpm lint`：检查前后端、共享契约与构建配置代码
