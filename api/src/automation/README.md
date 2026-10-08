# 自动化运行模块

本目录承载真实浏览器运行，不承载需求文档分析、人工审核、任务队列或报告存储。

- `agent-test-runner.ts`、`playwright-runner.ts`：动态与固定模式的连续会话、逐用例结果、取消和证据收集。
- `test-agent.ts`、`responses-decision-provider.ts`：观察与决策循环、有限恢复和单步模型协议；模型网络客户端仍由外部集成提供。
- `page-observer.ts`、`page-observer-browser.js`、`element-registry.ts`：当前页面事实、容器/框架身份、快照内元素引用。浏览器执行代码和声明文件保持相邻。
- `single-action-executor.ts`、`test-policy.ts`：受控动作与执行前校验。
- `test-data-binding.ts`及`fixed-*`：运行时数据依据、固定动作参数与断言覆盖。
- `live-page-stream.ts`、`download-capture.ts`：真实页面画面和下载证据。
- `agent-goal.ts`、`complete-case-results.ts`：已解析契约到执行目标，以及批次剩余用例状态补全。

HTTP与持久任务位于`modules/executions`，共享类型位于`packages/contracts`。测试暂保留`api/src/*.test.ts`以维持原测试入口；直接导入本目录，不增加空转发兼容层。

本次是职责归拢，不是全部解耦完成。源码Provider、模型客户端和附件存储仍有明确外部依赖；后续应按实际变化边界调整，不能把数据库或页面业务塞回运行器。
