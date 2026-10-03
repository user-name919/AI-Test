# 统一可执行用例契约与人工 Review 工作台 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将“给人看的自然语言用例”升级为一份可人工评审、可被动态 Agent 和固定计划共同消费、可在执行报告中追溯的数据契约；运行时数据必须从当前真实 DOM 解析，而不能把示例文本误当作测试数据。

**Architecture:** 保留 PRD 分析的原始用例作为 AI 建议，在 `ReviewState.caseReviews` 中以覆盖层保存人工最终契约。服务端纯函数 `resolveCaseExecutionContract` 是唯一解析入口，UI 预览、动态 Agent、固定计划和执行报告都读取其结果及指纹。动态运行时通过受策略约束的 `resolve_test_data` 决策把当前 DOM 中的候选数据绑定到契约，再由 `valueRef` 消费；整批执行共享连续浏览器会话，每条用例只拥有独立验证结果和报告边界。前端“用例资产”使用主从布局显示同一份完整契约，实时面板保留按时间排序的完整操作历史。

**Tech Stack:** Vue 3 + TypeScript、Node.js HTTP API、SQLite、Zod、Playwright、Node test runner。

**Spec:** `docs/superpowers/specs/2026-09-02-test-case-execution-contract-design.md`

## Global Constraints

- 只修改 `/Users/tal/Desktop/quality-ai-test-case-contract` 的隔离分支 `codex/test-case-contract`；不触碰原工作区的未提交改动，也不修改 `lvworkbench`。
- 原始 `PrdAnalysis.testCases` 和历史 `ExecutionRecord` 是事实记录，不能被人工 Review 覆写或回写修改。
- UI、Agent、计划生成器不得各自拼接另一份“真实用例”；都必须消费服务端解析出的同一个 `ResolvedCaseExecutionContract` 与 `contractFingerprint`。
- `runtime_dom` 的运行时绑定不是永久业务口径：它按环境、目标地址和契约指纹保存为运行事实；没有真实候选时必须 `blocked`，不能伪造固定文本。
- `fixture` 必须含值和来源证据；`manual` 明确包含人工输入的值与理由；`runtime_dom` 不允许由模型直接给出脱离页面的文本值。
- 一次选择多条用例时，整批共享同一个认证上下文和当前 Page；每条用例只是独立的验证/报告 checkpoint。普通失败、受阻或单条超时必须记录后继续下一条；只有会话级基础设施失败才中断整批。
- 继续保留 `click e10`、`waitFor 1000ms` 等技术动作，但实时 UI 要给出对应业务意图、用例编号和历史记录。
- 先写会失败的最小测试，再实现生产代码；每个里程碑运行对应单测，最后运行 `npm test`、`npm run typecheck`、`npm run lint`。

---

## Task 1: 建立可执行用例契约、Review 覆盖层与兼容性边界

**Files:**
- Modify: `shared/contracts.ts`
- Modify: `shared/review-state.ts`
- Test: `server/review-state.test.ts`

**Interfaces:**
- Consumes: legacy `ReviewState`, raw `PrdAnalysis.testCases`, existing `QuestionReview`.
- Produces:

```ts
type TestDataSourceMode = 'runtime_dom' | 'fixture' | 'manual'

interface TestDataBinding {
  id: string
  label: string
  mode: TestDataSourceMode
  targetHint: string
  businessIntent: string
  strategy?: 'visible_option_substring'
  constraints: {
    mustComeFromCurrentDom: boolean
    mustBePartialOfSource?: boolean
    mustRemainAfterFiltering?: boolean
  }
  fixture?: { value: string; evidence: string }
  manual?: { value: string; rationale: string }
}

interface CaseExecutionContract {
  objective: string
  preconditions: string[]
  steps: string[]
  expectedAssertions: string[]
  dataBindings: TestDataBinding[]
  forbiddenBehaviors: string[]
  uncertainties: string[]
}

interface CaseReview {
  status: 'draft' | 'confirmed' | 'needs_data_review'
  finalContract: CaseExecutionContract
  updatedAt: string | null
}

type ExecutionStatus = 'passed' | 'failed' | 'blocked' | 'infrastructure_failed'

function isCaseReviewExecutable(
  review: ReviewState,
  caseKey: string,
  mode: 'agent' | 'plan',
): { executable: boolean; reason?: string }
```

- [ ] **Step 1: 写入 Review 状态与数据绑定的失败测试。**
  - 为缺失 `caseReviews` 的旧记录、`draft` / `confirmed` / `needs_data_review` 状态、fixture 缺少证据、manual 缺少值、runtime DOM 绑定加入断言。
  - 运行：`node --import tsx --test server/review-state.test.ts`
  - 预期：因新类型和判断尚未实现而失败。

- [ ] **Step 2: 定义 Zod schema 与 TypeScript 类型。**
  - 在 `shared/contracts.ts` 增加 `TestDataSourceMode`、`TestDataBinding`、`CaseExecutionContract`、`CaseReview`、`ResolvedCaseExecutionContract`、`ResolvedDataBinding`、`CaseExecutionResult`。
  - `manual` 使用 `{ value, rationale }`；`fixture` 使用 `{ value, evidence }`；`runtime_dom` 使用策略与约束而不带预填文本。
  - 扩展 `ReviewState` / `reviewStateSchema` 的 `caseReviews` 默认值，保留 `questionReviews` 行为不变；给执行记录预留 `caseResults`。

- [ ] **Step 3: 实现可执行性判定。**
  - 在 `shared/review-state.ts` 实现 `isCaseReviewExecutable` 和固定计划可执行性判断：`needs_data_review` 永远不可执行，未解析 runtime DOM 只能进入动态 Agent，fixture/manual 需完整值。
  - 运行：`node --import tsx --test server/review-state.test.ts`
  - 预期：全部通过。

- [ ] **Step 4: 提交契约基础。**
  - 仅暂存本任务文件，运行 `git diff --check`。
  - 提交信息：`feat: 定义统一可执行用例契约`

## Task 2: 让服务端成为唯一契约解析、持久化与预览入口

**Files:**
- Modify: `server/review-execution-context.ts`
- Modify: `server/database.ts`
- Modify: `server/index.ts`
- Modify: `server/review-execution-context.test.ts`
- Add: `server/database.test.ts`
- Add: `server/case-contract-api.test.ts`

**Interfaces:**
- Consumes: `CaseReview`, `QuestionReview`, raw requirement/test case, legacy saved review rows.
- Produces:

```ts
interface ResolvedCaseExecutionContract {
  caseKey: string
  requirementIndex: number
  caseIndex: number
  title: string
  contract: CaseExecutionContract
  resolvedQuestions: ResolvedReviewContext[]
  readiness: { agent: { executable: boolean; reason?: string }; plan: { executable: boolean; reason?: string } }
  contractFingerprint: string
}

function resolveCaseExecutionContract(
  analysis: SavedAnalysis,
  caseKey: string,
): ResolvedCaseExecutionContract
```

- [ ] **Step 1: 编写数据库与 API 的失败测试。**
  - 使用独立临时 SQLite 文件验证 `case_reviews_json` 的增量迁移、保存、读取和旧行默认值。
  - 在 `server/review-execution-context.test.ts` 为“原始用例回退”“case Review 覆盖”“关联的已确认问题合并”“同输入同指纹”“人工口径变更后指纹改变”“旧记录兼容”编写失败测试。
  - 为 `GET /api/analyses/:id/cases/:caseKey/contract` 写接口测试，断言未知用例返回 404/400，正常结果包含 fingerprint 和 resolved contract。
  - 运行：`node --import tsx --test server/review-execution-context.test.ts server/database.test.ts server/case-contract-api.test.ts`
  - 预期：失败。

- [ ] **Step 2: 实现纯解析器。**
  - 在 `server/review-execution-context.ts` 实现 `resolveCaseExecutionContract(analysis, caseKey)`：原始用例 -> 兼容默认契约 -> caseReview 最终契约 -> 同需求已确认问题的执行口径 -> 就绪状态与稳定指纹。
  - 没有具体值的旧用例保持兼容路径；包含具体值但没有 fixture/manual 证据、也没有 `runtime_dom` 绑定策略的旧用例自动标为 `needs_data_review`，不静默把文字继续当环境事实。
  - 保留 `collectResolvedReviewContext` 作为兼容包装或改为内部辅助，避免其他调用点自行重组文本。

- [ ] **Step 3: 实现存储迁移与 Review 保存。**
  - `server/database.ts` 添加 `case_reviews_json` 的无损 `ALTER TABLE`、select/map/save 支持；通过可注入数据库路径让数据库测试不触碰真实 `data/quality-ai.sqlite`。
  - 扩展 PATCH Review 验证为可选 `caseReviews`，同时保留现有客户端只传问题 Review 的兼容路径。

- [ ] **Step 4: 暴露只读解析接口。**
  - 在 `server/index.ts` 添加只读用例契约接口；返回服务端解析后的结果，绝不信任客户端上传的 contract 或 fingerprint。
  - 运行：`node --import tsx --test server/review-execution-context.test.ts server/database.test.ts server/case-contract-api.test.ts`
  - 预期：全部通过。

- [ ] **Step 5: 提交服务端解析里程碑。**
  - 运行 `git diff --check`，只暂存本任务文件。
  - 提交信息：`feat: 持久化并解析人工确认的用例契约`

## Task 3: 用真实 DOM 绑定运行时数据，杜绝硬编码示例输入

**Files:**
- Modify: `shared/contracts.ts`
- Add: `server/test-data-binding.ts`
- Add: `server/test-data-binding.test.ts`
- Modify: `server/test-policy.ts`
- Modify: `server/test-policy.test.ts`
- Modify: `server/test-agent.ts`
- Modify: `server/test-agent.test.ts`
- Modify: `server/single-action-executor.ts`
- Modify: `server/single-action-executor.test.ts`
- Modify: `server/responses-decision-provider.ts`
- Modify: `server/responses-decision-provider.test.ts`
- Modify: `shared/live-execution.ts`
- Modify: `server/live-execution.test.ts`

**Interfaces:**
- Consumes: `ResolvedCaseExecutionContract.contract.dataBindings`, `PageSnapshot`, existing action executor registry.
- Produces:

```ts
type ValueReference = { valueRef: string }

type ResolveTestDataDecision = {
  type: 'resolve_test_data'
  snapshotId: string
  bindingId: string
  sourceElementRef: string
  value: string
  reason: string
}

interface ResolvedDataBinding {
  bindingId: string
  sourceElementRef: string
  sourceText: string
  value: string
  snapshotId: string
  observedAt: string
  reason: string
}

function resolveRuntimeDataBinding(
  binding: TestDataBinding,
  snapshot: PageSnapshot,
  proposal: ResolveTestDataDecision,
): ResolvedDataBinding
```

- [ ] **Step 1: 为 `resolve_test_data` 与 `valueRef` 编写失败测试。**
  - 断言动态决策只能引用当前快照、source element 必须可见、模糊搜索词必须是当前 option 的非空严格子串、不能等于完整 option。
  - 覆盖“未找到候选 -> blocked”“模型给出脱离 DOM 的文本 -> rejected”“过滤后匹配来源消失 -> failed”“fixture/manual 正常引用”。
  - 运行：`node --import tsx --test server/test-data-binding.test.ts server/test-policy.test.ts server/test-agent.test.ts server/single-action-executor.test.ts server/responses-decision-provider.test.ts`
  - 预期：失败。

- [ ] **Step 2: 扩展动作协议。**
  - 在 `shared/contracts.ts` 增加 `resolve_test_data` decision，给 `fill` / `selectOption` / `expectValue` 增加互斥的 `value` 与 `valueRef` 形态。
  - 在 Agent goal 中带入单用例 resolved contract、bindings 和 fingerprint，让模型明确“先读当前 DOM 后选值”。

- [ ] **Step 3: 实现可审计的数据绑定器。**
  - 在 `server/test-data-binding.ts` 纯函数中从 `PageSnapshot` 验证并输出 `ResolvedDataBinding`（binding id、source ref、source text、value、snapshot id、原因、时间）。
  - 对 `visible_option_substring` 采用保守归一化，保留原文本证据；无合法候选抛出可转为 `blocked` 的领域错误。

- [ ] **Step 4: 连接 Agent、策略与执行器。**
  - `TestAgent` 接受并记录 `resolve_test_data`，不调用 Playwright；后续 `valueRef` 只读取已验证绑定。
  - `TestPolicy` 拒绝未知、过期或不允许的 ref；`SingleActionExecutor` 在调用 Playwright 前解析 ref。
  - 过滤后重新观察 DOM 并执行 `mustRemainAfterFiltering`；“无法取得合法数据”分类为受阻，“取得合法数据后断言失败”分类为测试失败。
  - 对“高亮”类断言，只允许通过当前可观察 element ref 的文本和属性/状态证据完成；若当前组件没有可观察高亮信号，Agent 必须受阻或要求人工补充规则，不能用“文本仍可见”替代高亮通过。

- [ ] **Step 5: 更新模型提示和可读轨迹。**
  - `ResponsesDecisionProvider` 说明 concrete value 不是默认示例数据；仅在 resolver 要求时返回结构化绑定决策。
  - `shared/live-execution.ts` 为绑定行为提供业务化文案和保留的技术动作，方便用户知道“本次输入来自哪个真实 option”。
  - 运行本任务全部测试。

- [ ] **Step 6: 提交运行时数据里程碑。**
  - 运行 `git diff --check`，只暂存本任务文件。
  - 提交信息：`feat: 基于真实 DOM 解析 Agent 测试数据`

## Task 4: 单用例目标、连续会话与可归因批量执行

**Files:**
- Modify: `server/agent-goal.ts`
- Modify: `server/agent-goal.test.ts`
- Modify: `server/agent-test-runner.ts`
- Modify: `server/agent-test-runner.test.ts`
- Modify: `server/playwright-runner.ts`
- Modify: `server/playwright-runner.test.ts`
- Modify: `server/index.ts`
- Modify: `shared/contracts.ts`
- Modify: `server/database.ts`

**Interfaces:**
- Consumes: one `ResolvedCaseExecutionContract` per requested case, one shared authenticated BrowserContext and one shared current Page.
- Produces:

```ts
interface CaseExecutionResult {
  caseKey: string
  title: string
  contractFingerprint: string
  status: ExecutionStatus
  startedFromUrl: string
  startedFromSnapshotId?: string
  continuation: 'reused_current_page' | 'agent_recovered_page'
  resolvedDataBindings: ResolvedDataBinding[]
  passedAssertions: string[]
  trajectory: AgentTrajectoryItem[]
  steps: ExecutionResult['steps']
  screenshots: string[]
  tracePath?: string
  error?: string
}

function buildAgentTestGoal(
  analysis: SavedAnalysis,
  caseKey: string,
  targetUrl: string,
): AgentTestGoal

function runAgentTest(
  goals: AgentTestGoal[],
  storageStatePath: string | undefined,
  options: AgentTestRunnerOptions,
): Promise<ExecutionResult>
```

- [ ] **Step 1: 先把 Agent goal 改造为单用例失败测试。**
  - 改写测试使 `buildAgentTestGoal(analysis, caseKey, targetUrl)` 只能处理一条用例，并断言 goal 与 resolver 的 fingerprint、目标、断言和数据绑定完全一致。
  - 运行：`node --import tsx --test server/agent-goal.test.ts`
  - 预期：失败。

- [ ] **Step 2: 实现单用例 goal。**
  - 删除多用例拼接 objective 的行为；用 resolved contract 构建唯一的业务目标和断言。
  - 对 `needs_data_review`、问题未确认、未准备的 fixture/manual 给出明确拒绝原因。

- [ ] **Step 3: 写连续批量会话的失败测试。**
  - 在 runner 测试中用两条相关用例验证：同一 BrowserContext 和同一个 Page 被连续复用；第二条能观察到第一条留下的页面状态和轨迹摘要，不会被强制导航回目标 URL。
  - 覆盖第一条 failed 或 blocked 后仍进入第二条、每条 `CaseExecutionResult` 保留 case key、title、fingerprint、bindings、trajectory、artifacts，以及 startedFromUrl / continuation。
  - 另测 browser/context 无法继续时整批停止，并标记为 `infrastructure_failed`。
  - 运行：`node --import tsx --test server/agent-test-runner.test.ts server/playwright-runner.test.ts`
  - 预期：失败。

- [ ] **Step 4: 实现动态 Agent 的批量 fan-out。**
  - `runAgentTest` 接受多个已解析单用例目标；一个 context、一个连续 Page、每个目标一个 case checkpoint 和独立 artifact 子目录。
  - 当前 case 结束后，无论 passed / failed / blocked 都切换到下一 case；下一轮 Agent 输入包含当前 DOM、前序用例摘要和当前 case 合约，但不得把前序断言当作当前用例已通过。
  - live event 增加 case key/title，运行结束写入 `caseResults`；顶层状态按 infrastructure_failed > failed > blocked > passed 聚合，报告仍保留每条 case 的真实状态。

- [ ] **Step 5: 约束固定计划生成和执行。**
  - API 对 runtime DOM 契约先执行预检/绑定；没有环境事实不能生成伪造固定计划。
  - fixture/manual 可生成直接计划；批量固定计划也按同一个连续 Page 执行，单条失败后记录并继续，不再让 `caseKeys` 只是展示字段。

- [ ] **Step 6: 在 API 与数据库中保存真实归因。**
  - `/api/automation/agent/run` 服务器端逐条解析已选用例；请求仍仅包含 case keys。
  - 结果保存关联 analysis、environment、project、source project branch 和 case result；历史记录不可重写。
  - 运行：`node --import tsx --test server/agent-goal.test.ts server/agent-test-runner.test.ts server/playwright-runner.test.ts`

- [ ] **Step 7: 提交批量执行里程碑。**
  - 运行 `git diff --check`，只暂存本任务文件。
  - 提交信息：`feat: 在连续会话中执行用例并保留归因`

## Task 5: 将模型输出和计划生成对齐为“建议，不是环境事实”

**Files:**
- Modify: `server/model.ts`
- Add: `server/model.test.ts`
- Modify: `shared/contracts.ts`
- Modify: `server/index.ts`
- Modify: `server/responses-decision-provider.ts`

**Interfaces:**
- Consumes: PRD source evidence and resolved contracts.
- Produces:

```ts
interface TestDataHint {
  bindingLabel: string
  source: 'prd' | 'interface_document'
  evidence: string
  suggestedMode: TestDataSourceMode
}

// This is advisory only. It is never executable until CaseReview.finalContract
// and, for runtime_dom, a ResolvedDataBinding have both been validated.
```

- [ ] **Step 1: 添加模型结构边界测试。**
  - 用可注入模型客户端测试：分析结果可以带非权威 `testDataHints`，但缺失 PRD 证据的具体文本绝不能被转换为合法 fixture。
  - 固定计划 prompt 只能消费 resolver 输出；runtime DOM 未绑定时应得到可读的预检要求而非生成步骤。
  - 运行：`node --import tsx --test server/model.test.ts server/responses-decision-provider.test.ts`
  - 预期：失败。

- [ ] **Step 2: 实现非权威数据提示与提示词约束。**
  - 给原始 test case 增加可选 `testDataHints`，默认 `[]` 保持旧分析可读。
  - 更新 PRD 分析及计划生成 prompt：不能把未知环境中是否存在的名称、账号、下拉选项作为固定测试数据。

- [ ] **Step 3: 为固定计划增加环境预检入口。**
  - API 以 analysis、case key、environment、target URL 和 fingerprint 查询/创建绑定事实；向 UI 返回缺少的绑定和可执行状态。
  - 运行：`node --import tsx --test server/model.test.ts server/case-contract-api.test.ts`
  - 预期：全部通过。

- [ ] **Step 4: 提交模型与计划边界。**
  - 运行 `git diff --check`，只暂存本任务文件。
  - 提交信息：`feat: 区分 AI 建议与测试环境数据事实`

## Task 6: 实现 B 方案的用例资产主从 Review 工作台

**Files:**
- Modify: `src/App.vue`
- Modify: `src/style.css` (or the existing style section in `src/App.vue` after confirming the actual style location)
- Modify: `shared/contracts.ts` (only if UI type imports expose new contract data)
- Test: `npm run typecheck`
- Test: `npm run build`

**Interfaces:**
- Consumes: `SavedAnalysis.review.caseReviews` and `GET /api/analyses/:id/cases/:caseKey/contract`.
- Produces:

```ts
const selectedCaseAssetKey = ref<string>('')
const selectedCaseContract = ref<ResolvedCaseExecutionContract | null>(null)
const caseReviews = ref<Record<string, CaseReview>>({})

async function loadCaseContract(caseKey: string): Promise<void>
async function saveCaseReview(caseKey: string, review: CaseReview): Promise<boolean>
async function previewRuntimeBindings(caseKey: string): Promise<void>
```

- [ ] **Step 1: 增加客户端状态与服务端数据读取。**
  - 引入 `caseReviews`、选中详情 case key、resolver result、编辑草稿、运行数据预览状态；`applyReview` / `saveCurrentReview` 同步 `caseReviews`。
  - 单击列表项只切换详情；复选框只控制本次执行选择，禁止混用。

- [ ] **Step 2: 将“用例资产”替换为 B 主从布局。**
  - 左侧约三分之一显示可筛选用例列表、执行选择和状态；右侧约三分之二始终显示当前用例的完整合约，而不是隐藏步骤。
  - 明确区分“AI 原始建议”“人工最终口径”“运行时数据策略”“禁止行为”“不确定项”“同一份 Agent 接收内容”。

- [ ] **Step 3: 提供可编辑的人工 Review。**
  - “编辑”进入表单状态；支持添加/修改前置条件、步骤、断言、绑定模式与约束、manual/fixture 值、禁止行为与不确定项。
  - “确认可执行”只保存通过完整性校验的 final contract；`needs_data_review` 显示不可执行原因与下一步操作。

- [ ] **Step 4: 增加运行数据预览与报告入口。**
  - “预览本次运行数据”调用服务端预检，展示 source option、实际选词、约束校验、绑定快照和 fingerprint。
  - 在“配置并执行”保留当前流程，但禁用文案具体说明是缺少 Review、缺少环境事实，还是项目 Origin 不匹配。

- [ ] **Step 5: 运行前端检查。**
  - 运行：`npm run typecheck`
  - 运行：`npm run build`
  - 预期：均通过，无未使用状态或模板类型错误。

- [ ] **Step 6: 提交 UI Review 工作台。**
  - 运行 `git diff --check`，只暂存本任务文件。
  - 提交信息：`feat: 提供可评审的完整用例执行契约`

## Task 7: 实时执行历史、逐用例报告与可读故障定位

**Files:**
- Modify: `shared/live-execution.ts`
- Modify: `server/live-execution.test.ts`
- Modify: `src/App.vue`
- Modify: `server/agent-test-runner.ts`
- Modify: `server/playwright-runner.ts`
- Modify: `shared/contracts.ts`

**Interfaces:**
- Consumes: case-scoped `LiveExecutionEvent` records emitted by both runners.
- Produces:

```ts
interface LiveExecutionActivity {
  id: string
  caseKey?: string
  caseTitle?: string
  phase: 'observing' | 'deciding' | 'reading_source' | 'executing' | 'completed' | 'blocked'
  title: string
  purpose: string
  technicalAction?: string
  status: 'running' | 'passed' | 'failed' | 'info'
}

interface LiveExecutionState {
  activity: LiveExecutionActivity | null
  activityHistory: LiveExecutionActivity[]
  // existing fields remain unchanged
}
```

- [ ] **Step 1: 编写 activity history reducer 失败测试。**
  - 验证同 ID 的状态事件更新原记录、不同 ID 追加且顺序稳定、关闭面板后历史可重新打开、case key/title 始终可见。
  - 运行：`node --import tsx --test server/live-execution.test.ts`
  - 预期：失败。

- [ ] **Step 2: 实现历史化实时状态。**
  - `LiveExecutionState` 增加 `activityHistory` 和 current pointer；reducer upsert 事件而非覆盖唯一 activity。
  - 事件中携带 case 信息；页面切换 case 时产生清晰分隔项。

- [ ] **Step 3: 重构实时面板和执行中心报告。**
  - 顶部保留实时画面流；下方展示“当前步骤”及可由用户滚动查看的完整历史，不对快动作强行延迟。
  - 每步显示 `REQ/TC`、业务目的、中文动作、技术动作、DOM 快照、数据来源；执行中心按 case result 展开断言、绑定、源码项目/分支、截图、Trace，并显式区分 blocked、产品 failed 与 infrastructure_failed。

- [ ] **Step 4: 运行相关测试与前端检查。**
  - 运行：`node --import tsx --test server/live-execution.test.ts server/agent-test-runner.test.ts server/playwright-runner.test.ts`
  - 运行：`npm run typecheck`
  - 预期：全部通过。

- [ ] **Step 5: 提交可读执行产物。**
  - 运行 `git diff --check`，只暂存本任务文件。
  - 提交信息：`feat: 保留实时执行历史和逐用例报告`

## Task 8: 全量回归、手工验收与提交交付

**Files:**
- Modify only if verification exposes a scoped defect; otherwise none.
- Verify: all files changed in Tasks 1–7.

- [ ] **Step 1: 运行完整自动化验证。**
  - 运行：`npm test`
  - 运行：`npm run typecheck`
  - 运行：`npm run lint`
  - 预期：全部通过；若失败，只修复本特性造成的问题，并新增对应回归测试。

- [ ] **Step 2: 做一次真实流程手工验收。**
  - 使用带“选择考试”下拉框的测试环境：打开列表 -> 读取真实 option -> 选择严格子串 -> 输入 -> 验证来源项仍在结果中；随后让后一条相关用例在同一个页面状态中继续执行。
  - 人为制造一条普通断言失败，确认报告记录该 TC 后，下一条已选用例仍然开始执行。
  - 确认报告显示实际 source option、运行词、contract fingerprint、对应项目/分支，并验证“无合法候选”归为受阻而不是假失败。

- [ ] **Step 3: 审查交付差异。**
  - 运行：`git diff --check HEAD~1..HEAD`（以及工作树 `git diff --check`）
  - 运行：`git status --short --branch`
  - 确保无密钥、storageState、trace、SQLite 数据或用户原工作区文件被纳入提交。

- [ ] **Step 4: 形成最终实现提交并推送。**
  - 仅在所有验证通过后提交剩余修复；建议信息：`test: 覆盖统一用例契约端到端回归`。
  - 尝试推送 `codex/test-case-contract`；若当前 HTTPS 凭据仍不可用，记录本地 commit SHA 与可执行推送命令，不反复重试。
