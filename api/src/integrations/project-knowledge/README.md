# 本地项目源码集成

这里负责项目配置、Provider注册、本机软链解析、路由定位、限定范围检索及局部文件读取。源码只用于辅助理解，不代表真实页面已通过验证。

- `config.ts`使用`config/paths.ts`统一运行路径；相对配置和项目根目录不随启动cwd改变。
- `local-project-provider.ts`读取本地项目事实与Git状态，不执行被测代码，不切换原工作区。
- `registry.ts`按配置建立Provider，配置刷新由调用方显式重置。
- 回归的受管理worktree生命周期由相邻`integrations/git`管理，不在Provider中隐式创建或清理。

路由和业务任务仍在`modules/projects`、`modules/regressions`、`modules/executions`；自动化观察与动作在`automation`。业务调用本集成获取有限源码信息，再回到真实DOM验证。
