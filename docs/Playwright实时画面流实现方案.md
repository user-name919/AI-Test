# Playwright 实时画面流实现方案

## 目标

自动化执行期间，在知测 AI 页面内实时展示 Playwright 正在控制的同一个 Chromium 页面，并同步展示用户可理解的操作说明。原始动作仍保留，作为调试信息使用。

## 用户看到的内容

- 用例名称优先展示，`TC-*` 仅作为辅助编号。
- 当前操作使用业务语言，例如“点击‘批量操作’”。
- 操作目的展示 Agent 的决策原因。
- 原始技术动作保留，例如 `click e10`、`waitFor 1000ms`。
- 右侧画面展示 Playwright 当前页面，执行结束后保留最后一帧。
- 失败时在同一面板展示失败说明，不用等待进入历史报告才能看见。

## 技术方案

1. Playwright 仍在服务端独立 Chromium 中执行，不使用 iframe 打开第二个页面。
2. Chromium 页面通过 Playwright `CDPSession` 启动 `Page.startScreencast`，用浏览器绘制事件触发采集。
3. CDP 帧只作为刷新信号并及时确认；发送给前端的 JPEG 统一由同一个 `page.screenshot()` 产生，避免 headless screencast 的空白帧覆盖真实画面。
4. 服务端最多每秒发送 5 帧，并在每个动作结束后强制发送校准帧，快速执行也能保留真实最终页面。
5. 执行接口新增 NDJSON 流式版本；同一个 HTTP 响应依次推送开始、活动、画面帧和完成事件。
6. 前端流式读取响应，在固定的实时执行面板中更新画面和操作信息。
7. 原有非流式执行接口、Trace、失败截图和数据库记录保持兼容。
8. 实时画面初始化失败时降级为无预览执行，并提示用户稍后查看截图和 Trace，不影响测试结论。

## 为什么不用 iframe 或 WebView

iframe 会打开另一个页面实例，不共享 Playwright 的 BrowserContext、storageState 和交互状态。WebView 需要把当前 Web 项目改造成桌面容器，并重新解决 Playwright 控制连接，改造范围与目标不成比例。画面流直接来源于 Playwright 正在操作的页面，证据一致。

## 事件协议

- `execution_started`：执行编号、模式、名称、目标地址和用例名称。
- `activity`：当前阶段、中文操作、操作目的、原始动作、状态和耗时。
- `browser_frame`：JPEG Data URL 和采集时间。
- `execution_completed`：数据库保存后的完整执行记录。
- `execution_error`：流建立后的不可恢复错误。

画面帧只存在于内存和网络响应中，不写入 SQLite，避免数据库快速膨胀。

## 第一版边界

- 支持动态 Agent、固定计划和执行器验证入口。
- 实时预览为只读，不支持在画面中人工接管鼠标键盘。
- 不新增第三方 WebSocket 依赖，使用现有 Node HTTP 流式响应。
- 不改变 lvworkbench 项目，只修改 quality-ai。

## 验收标准

1. 点击执行后，不等待测试结束即可看到首帧。
2. 页面发生跳转、点击、输入或弹窗变化时，右侧画面持续更新。
3. `click e10` 上方能看到“点击‘元素名称’”和操作目的。
4. `waitFor 1000ms` 上方能看到“等待页面加载”和等待原因。
5. 执行完成后仍生成原有执行记录、Trace 与失败截图。
6. 原有非流式 API 和测试不回归。
