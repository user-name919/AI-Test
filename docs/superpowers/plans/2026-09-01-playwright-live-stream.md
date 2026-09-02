# Playwright Live Stream Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在知测 AI 内实时展示 Playwright 同一页面的画面、中文操作说明和原始技术动作。

**Architecture:** Chromium 通过 CDP screencast 产生受限帧率的 JPEG 帧；现有执行函数通过回调发出活动和画面事件；新增 NDJSON 流式接口把事件直接推送给 Vue。最终执行结果仍按现有方式写入 SQLite，画面帧不持久化。

**Tech Stack:** TypeScript、Node HTTP、Playwright Chromium CDPSession、Vue 3、NDJSON

**Spec:** `docs/Playwright实时画面流实现方案.md`

## Global Constraints

- 保留原有 `/api/automation/run` 与 `/api/automation/agent/run` JSON 行为。
- 不新增第三方 WebSocket 依赖。
- 画面来自 Playwright 正在控制的同一个 Page。
- 保留 `click e10`、`waitFor 1000ms` 等原始动作，并增加中文说明。
- 不修改 lvworkbench，不覆盖用户当前 `src/App.vue` 未提交改动。

---

### Task 1: 实时事件契约和中文动作描述

**Files:**
- Modify: `shared/contracts.ts`
- Create: `shared/live-execution.ts`
- Test: `server/live-execution.test.ts`

**Interfaces:**
- Produces: `LiveExecutionEvent`、`LiveExecutionActivity`、`describeAgentDecision()`、`describeAutomationStep()`、`consumeNdjsonChunk()`。

- [x] **Step 1: Write the failing test**

覆盖 `click e10` 映射为“点击‘选择考试’”、`waitFor 1000ms` 映射为“等待页面加载”、分块 NDJSON 能正确保留残段。

- [x] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test server/live-execution.test.ts`
Expected: FAIL because `shared/live-execution.ts` does not exist.

- [x] **Step 3: Write minimal implementation**

实现纯函数描述器和 NDJSON 分块解析；不访问浏览器或数据库。

- [x] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test server/live-execution.test.ts`
Expected: PASS.

### Task 2: Playwright 同页画面采集

**Files:**
- Create: `server/live-page-stream.ts`
- Test: `server/live-page-stream.test.ts`

**Interfaces:**
- Produces: `startLivePageStream(context, page, onFrame)`，返回异步停止函数。

- [x] **Step 1: Write the failing test**

使用可控 CDP Session，验证启动 screencast、首帧输出、帧确认、限频和停止。

- [x] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test server/live-page-stream.test.ts`
Expected: FAIL because the frame streamer does not exist.

- [x] **Step 3: Write minimal implementation**

调用 `Page.startScreencast`，把 JPEG 转成 Data URL，最多每 200ms 推送一帧，并对每帧调用 `Page.screencastFrameAck`。

- [x] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test server/live-page-stream.test.ts`
Expected: PASS.

### Task 3: 执行器发出实时活动和画面事件

**Files:**
- Modify: `server/test-agent.ts`
- Modify: `server/agent-test-runner.ts`
- Modify: `server/playwright-runner.ts`
- Modify: `server/agent-test-runner.test.ts`
- Create: `server/playwright-runner.test.ts`

**Interfaces:**
- Consumes: `startLivePageStream()` and live event types.
- Produces: both runners accept optional `onEvent(event)` without changing existing callers.

- [x] **Step 1: Write the failing tests**

断言 Agent 和固定计划在执行完成前发出 `execution_started`、`activity`、`browser_frame`，并保留最终结果。

- [x] **Step 2: Run tests to verify they fail**

Run: `node --import tsx --test server/agent-test-runner.test.ts server/playwright-runner.test.ts`
Expected: FAIL because runners do not accept event callbacks.

- [x] **Step 3: Write minimal implementation**

在页面创建后启动画面流；Agent 决策前后和固定步骤前后发出中文活动；finally 中停止画面流。

- [x] **Step 4: Run tests to verify they pass**

Run: `node --import tsx --test server/agent-test-runner.test.ts server/playwright-runner.test.ts`
Expected: PASS.

### Task 4: NDJSON 流式 API

**Files:**
- Modify: `server/index.ts`
- Test: `server/live-execution.test.ts`

**Interfaces:**
- Consumes: runner `onEvent` callbacks and `LiveExecutionEvent`.
- Produces: `POST /api/automation/run/stream` and `POST /api/automation/agent/run/stream`.

- [x] **Step 1: Write the failing test**

断言事件编码每行一个完整 JSON，并能被分块解析器恢复。

- [x] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test server/live-execution.test.ts`
Expected: FAIL on the missing encoder behavior.

- [x] **Step 3: Write minimal implementation**

复用原有校验和保存逻辑；流式路径写出 runner 事件，保存完成后写出 `execution_completed`。

- [x] **Step 4: Run relevant tests**

Run: `npm run test:unit`
Expected: 0 failures outside sandbox.

### Task 5: Vue 实时执行面板

**Files:**
- Modify: `src/App.vue`
- Modify: `src/runtime.css`

**Interfaces:**
- Consumes: NDJSON live execution endpoints.
- Produces: right-side panel with current frame, case name, readable activity, purpose, raw action, status and close control.

- [x] **Step 1: Implement the narrow UI integration**

三个新执行入口改用流式接口；逐块读取事件并更新响应式状态；执行结束仍刷新历史记录。

- [x] **Step 2: Preserve the user's existing App.vue changes**

确认“分享评审”删除和现有指引 footer 修改仍存在，且不把它们作为本功能的独立修改处理。

- [x] **Step 3: Verify static correctness**

Run: `npm run typecheck && npm run build`
Expected: both pass.

### Task 6: 集成验证与提交

**Files:**
- Modify: `docs/Playwright实时画面流实现方案.md` only if verification exposes a documented difference.

**Interfaces:**
- Consumes: complete implementation.
- Produces: verified commit on `feat-agentic-test-optimization`.

- [x] **Step 1: Run full verification**

Run: `npm run test:unit`, `npm run typecheck`, `npm run build`.
Expected: all pass; tests needing Chromium run outside sandbox.

- [x] **Step 2: Inspect final diff**

Run: `git diff --check` and `git status --short`.
Expected: no whitespace errors; only scoped files plus the user's pre-existing App.vue changes.

- [ ] **Step 3: Commit scoped work**

Stage implementation, tests and documents deliberately. Use a detailed Chinese commit message describing the frame stream, streaming protocol, readable activity and verification.

- [ ] **Step 4: Push**

Push `feat-agentic-test-optimization` to its configured remote after commit succeeds.
