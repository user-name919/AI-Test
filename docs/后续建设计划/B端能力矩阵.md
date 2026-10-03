# B 端执行能力矩阵

核对日期：2026-10-04；代码基线：`9758686`。本表描述平台已经接入的能力，不是 Playwright 的全部能力，也不是任意企业页面都能自动测试的承诺。

“已支持”表示存在执行路径；“部分支持”表示有明确限制；“缺失”表示仍需开发。验证证据另列，代码支持不等于真实模型会正确选择动作。表内示例均为合成测试，不使用公司账号或材料。

## 动作与场景

| 场景与最小示例 | 动态 Agent | 固定计划 | 实现及限制 |
|---|---|---|---|
| 点击查询按钮、填写文本、同源跳转 | 已支持 | 已支持 | `api/src/single-action-executor.ts`、`api/src/playwright-runner.ts`；动作成功不代表业务断言通过 |
| 异步显示结果、消失的加载提示 | 部分支持 | 部分支持 | 两执行器支持可见/隐藏断言及有限等待；动态另有 100–5000ms `waitFor`。固定无独立等待动作；不得用固定睡眠证明页面已完成加载 |
| 原生 select 选择一项 | 已支持 | 缺失 | 动态 `selectOption`；固定 schema 尚未声明此动作。自定义下拉不能直接当原生 select |
| 勾选/取消复选框、验证选中状态 | 已支持 | 缺失 | 动态 `check/uncheck/expectChecked`；固定只有 click，不能把一次 click 等同于已勾选 |
| 键盘选择、悬停展开菜单 | 已支持 | 缺失 | 动态 `press/hover`，键名受 schema 限制；固定尚无这些动作 |
| 展开下拉，从实际选项选完整名称/部分词 | 部分支持 | 部分支持 | `api/src/test-data-binding.ts`、`api/src/modules/cases/fixed-plan-model.ts`；有三策略及 valueRef。必须先观察可见 option，过长截断文本不可冒充完整名称 |
| 搜索不存在项并验证空态 | 部分支持 | 部分支持 | 负例要求完整受控候选依据；只有远程/分页列表当前可见项时不能证明全局不存在 |
| 逐步滚动虚拟列表，再观察新选项 | 部分支持 | 缺失 | 动态 scroll 后重新观察；没有全量列表枚举或保证到达目标项的协议，不能把一次快照当完整数据集 |
| 表格按行内容点操作、分页筛选 | 部分支持 | 部分支持 | observer 有表格摘要和最多 3 行样本；无显式行作用域定位协议。固定可使用已知 CSS，但不能要求模型凭空猜 selector |
| 弹窗内同名按钮，与背景按钮区分 | 部分支持 | 部分支持 | observer 保存 dialog/container 描述，动态引用绑定具体 DOM；尚无通用 scope 定位契约，普通弹窗容器本身不一定可引用 |
| 禁用/启用、输入值、错误提示 | 已支持 | 已支持 | `expectEnabled/expectDisabled/expectValue` 和文本/属性断言；动态有局部 `expectElementText`，固定 expectText 仍是页面范围，不能证明特定容器结果 |
| 匹配关键词高亮 | 部分支持 | 部分支持 | 验证明确 class/data-state 等属性；固定 token 匹配、动态属性匹配规则不同。文本出现不能代替高亮，也未验证像素颜色或视觉规范 |
| 容器中 option 数量为 0 | 部分支持 | 缺失 | 动态 `expectCount` 可带 containerRef；容器必须可被观察/引用。固定无计数动作 |
| 选择已配置附件并上传 | 缺失 | 缺失 | 没有附件白名单/附件 ID 到受控路径映射，也无 setInputFiles 动作。平台导入 PRD 文件不等于自动化上传被测网站文件 |
| 点击导出，等待下载并验证文件 | 缺失 | 缺失 | 没有受控 download 监听、文件完成/内容验证及逐用例产物关联。页面出现“下载成功”不是文件已正确生成的证据 |
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
| 报告、实时预览 | 后台任务、逐用例记录、截图/Trace、画面流和可重开历史 | `api/src/modules/executions/`、`web/src/features/executions/`；下载文件证据尚未接入 |

## 可重现的聚焦检查

```bash
node --import tsx --test api/src/page-observer.test.ts api/src/single-action-executor.test.ts api/src/test-policy.test.ts
```

这些测试使用真实本地 Chromium 和合成页面，覆盖观察截断、引用稳定性、键盘/悬停/滚动/局部断言、未解析数据引用与不安全键名拒绝。不调用公司模型，不证明模型在真实企业页面上的动作选择正确。具体运行结果记在《执行进度》。其他已有故事的历史证据与局限也保留在进度中，本次不把未重跑项写为刚验收通过。

## 补齐顺序及验收要求

1. 表单动作对齐：固定计划加入键盘/勾选/选择等必要动作与状态断言，保持人工契约和可读历史；每项验证成功及失败继续。
2. 表格/弹窗作用域：观察与执行使用明确容器；同名背景元素不能误通过，固定文本断言也需限定目标。
3. 受控上传下载：先建立测试附件与产物协议，再加动作；模型只选择附件 ID，不接受任意本机路径。下载完成与内容验证分开，失败保留证据。
4. 页面/框架上下文：先完善引用身份和生命周期，再支持 iframe/新页；切换后旧引用拒绝，不静默操作原页面。
5. 有副作用动作：执行前明确授权与预期，技术超时后核对实际状态，不盲目重复提交。

每项以实际生产链路和本地正反例验收，不把新增 schema、提示词或按钮单独视为交付。尚未接入的必需能力应明确受阻/人工验证，不能删除该场景或替换为更容易通过的断言。G7 未完成；本矩阵是后续实现依据，不是缩减目标后的交付结论。
