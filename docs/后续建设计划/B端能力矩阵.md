# B 端执行能力矩阵

核对日期：2026-10-04；初次盘点基线：`9758686`，固定表单增量接续 `f6878a9`。本表描述平台已经接入的能力，不是 Playwright 的全部能力，也不是任意企业页面都能自动测试的承诺。

“已支持”表示存在执行路径；“部分支持”表示有明确限制；“缺失”表示仍需开发。验证证据另列，代码支持不等于真实模型会正确选择动作。表内示例均为合成测试，不使用公司账号或材料。

## 动作与场景

| 场景与最小示例 | 动态 Agent | 固定计划 | 实现及限制 |
|---|---|---|---|
| 点击查询按钮、填写文本、同源跳转 | 已支持 | 已支持 | `api/src/single-action-executor.ts`、`api/src/playwright-runner.ts`；动作成功不代表业务断言通过 |
| 异步显示结果、消失的加载提示 | 部分支持 | 部分支持 | 两执行器支持可见/隐藏断言及有限等待；动态另有 100–5000ms `waitFor`。固定无独立等待动作；不得用固定睡眠证明页面已完成加载 |
| 原生 select 选择一项 | 已支持 | 部分支持 | 固定 `selectOption` 明确按 value/label 选择，要求契约中有依据的 fixture/manual 值；尚无原生选项运行时采集策略。不把自定义下拉当原生 select，不支持批量多选或重复 label 消歧 |
| 勾选/取消复选框、验证选中状态 | 已支持 | 已支持 | 两模式 `check/uncheck/expectChecked`；固定新增真实状态验证，mixed 不等于 false，不把一次 click 等同于已勾选 |
| 键盘选择、悬停展开菜单 | 已支持 | 已支持 | 两模式 `press/hover`，共用受限键名 schema；按键触发提交仍必须符合契约，不代表已具备通用副作用授权机制 |
| 展开下拉，从实际选项选完整名称/部分词 | 部分支持 | 部分支持 | `api/src/test-data-binding.ts`、`api/src/modules/cases/fixed-plan-model.ts`；有三策略及 valueRef。必须先观察可见 option，过长截断文本不可冒充完整名称 |
| 搜索不存在项并验证空态 | 部分支持 | 部分支持 | 负例要求完整受控候选依据；只有远程/分页列表当前可见项时不能证明全局不存在 |
| 逐步滚动虚拟列表，再观察新选项 | 部分支持 | 缺失 | 动态 scroll 后重新观察；没有全量列表枚举或保证到达目标项的协议，不能把一次快照当完整数据集 |
| 表格按行内容点操作、分页筛选 | 部分支持 | 部分支持 | observer 有表格摘要和最多 3 行样本；动态新增行/表格 e 引用及 containerRef 父链，固定 scope 支持表格→行→控件。分页/虚拟表格完整性不能据此保证，动态缺针对某容器主动重采集协议 |
| 弹窗内同名按钮，与背景按钮区分 | 部分支持 | 部分支持 | 动态弹窗注册为 e 引用，摘要 elementRef 关联它，限定容器计数已实测；固定 scope 已验证背景同名按钮不被误点。预算截断时不伪造容器引用，模型理解正确性未保证 |
| 禁用/启用、输入值、错误提示 | 已支持 | 已支持 | `expectEnabled/expectDisabled/expectValue` 和文本/属性断言；两模式有局部 `expectElementText`。固定旧 expectText 仍是页面范围，局部结果需使用带范围的元素断言 |
| 匹配关键词高亮 | 部分支持 | 部分支持 | 验证明确 class/data-state 等属性；固定 token 匹配、动态属性匹配规则不同。文本出现不能代替高亮，也未验证像素颜色或视觉规范 |
| 容器中 option 数量为 0 | 部分支持 | 缺失 | 动态 `expectCount` 可带 containerRef；容器必须可被观察/引用。固定无计数动作 |
| 选择已配置附件并上传 | 部分支持 | 部分支持 | `/#/test-fixtures` 登记不可覆盖附件，两模式 uploadFile 只接受契约授权UUID并保存指纹。动态只操作当前快照中的文件控件，上传异常不自动恢复重试；隐藏输入/文件选择对话框/多文件待扩展，真实input上传不等于业务处理成功 |
| 点击导出，等待下载并验证文件 | 部分支持 | 部分支持 | 两模式 download 点击前监听，15秒接收期限、10MB证据保存上限，expectDownload 验证名称/大小/UTF-8文本包含；逐用例隔离文件和指纹关联报告，动态异常不自动重复导出。PDF/Excel解析、多文件未接入；页面“下载成功”不能代替文件证据 |
| iframe 内控件操作 | 缺失 | 缺失 | observer 使用主 Page 的 document；registry 未记录 frame 上下文；固定定位也以 Page 为根。不能用主页面引用代替 frame 内元素 |
| 新标签页打开、切回原页面 | 缺失 | 缺失 | 没有 page ID/切换动作、弹出页面生命周期或跨页引用失效规则 |
| Shadow DOM 内控件 | 缺失（观察链） | 部分支持（定位层） | observer 的 document.querySelectorAll 不穿透 shadow root；Playwright 定位器自身能力不能补齐 Agent 观察。固定未作本地场景验收 |

协议依据：`packages/contracts/src/contracts.ts` 中的 `agentActionSchema` 与 `automationStepSchema`。页面摘要依据：`api/src/page-observer.ts`、`api/src/page-observer-browser.js`。引用依据：`api/src/element-registry.ts`。

## 执行边界与证据

| 边界 | 当前行为 | 证据入口与缺口 |
|---|---|---|
| DOM 节点索引改变 | 引用绑定本次观察的属性标识，不再依赖候选 nth 索引；旧 snapshot 被拒绝 | `page-observer.test.ts` 中插入候选后的节点引用测试 |
| 技术动作失败 | 动态每用例最多两次重观察恢复，原失败保留；断言失败不走恢复 | `test-agent.test.ts`；这不是所有写操作可安全重试的证明 |
| 业务用例失败 | 记录并继续后续用例，同一 Page 保留现场 | `execution-story.test.ts`、`playwright-runner.test.ts`；会话整体失效仍需停止 |
| 断言完整性 | 动态 assertionId、固定 assertionIndex 关联契约预期；未全部完成不能当通过 | `test-policy.ts`、`fixed-assertion-coverage.ts`；映射存在不等于自然语言语义必然正确 |
| 页面和动作范围 | goto 同 Origin、快照引用、动作白名单、次数/时长预算 | `test-policy.ts`；仍缺通用破坏性写操作授权和“已提交则不重复”确认协议，不能称为安全完成任意表单提交 |
| 报告、实时预览 | 后台任务、逐用例记录、截图/Trace、下载文件证据、画面流和可重开历史 | `api/src/modules/executions/`、`web/src/features/executions/`；新增文件证据的独立页面浏览器验收待补 |

## 可重现的聚焦检查

```bash
node --import tsx --test api/src/page-observer.test.ts api/src/single-action-executor.test.ts api/src/test-policy.test.ts
node --import tsx --test api/src/fixed-form-actions.test.ts api/src/fixed-locator-assertion.test.ts api/src/modules/cases/fixed-plan-model.test.ts
node --import tsx --test api/src/fixed-select-option.test.ts
node --import tsx --test api/src/fixed-scope.test.ts
node --import tsx --test api/src/modules/test-fixtures/store.test.ts
node --import tsx --test api/src/agent-upload.test.ts
node --import tsx --test api/src/download-capture.test.ts
```

这些测试使用真实本地 Chromium 和合成页面，覆盖观察截断、引用稳定性、键盘/悬停/滚动/局部断言、未解析数据引用与不安全键名拒绝。不调用公司模型，不证明模型在真实企业页面上的动作选择正确。具体运行结果记在《执行进度》。其他已有故事的历史证据与局限也保留在进度中，本次不把未重跑项写为刚验收通过。

## 补齐顺序及验收要求

1. 表单动作对齐：固定键盘/勾选/悬停与选中断言已接入；原生 selectOption 已接入有依据的单值选择，运行时原生选项采集仍待扩展。保持人工契约和可读历史；每项验证成功及失败继续。
2. 表格/弹窗作用域：固定 scope 与局部文本、动态容器引用/父链已接入并验证背景反例；仍需局部重采集与复杂列表验证，不宣称所有表格场景完成。
3. 受控上传下载：附件登记API/UI及两模式单文件上传已接入，继续下载产物与上传控件覆盖；模型只选择获准附件 ID，不接受任意本机路径。下载完成与内容验证分开，失败保留证据。
4. 页面/框架上下文：先完善引用身份和生命周期，再支持 iframe/新页；切换后旧引用拒绝，不静默操作原页面。
5. 有副作用动作：执行前明确授权与预期，技术超时后核对实际状态，不盲目重复提交。

每项以实际生产链路和本地正反例验收，不把新增 schema、提示词或按钮单独视为交付。尚未接入的必需能力应明确受阻/人工验证，不能删除该场景或替换为更容易通过的断言。G7 未完成；本矩阵是后续实现依据，不是缩减目标后的交付结论。
