# 用例生成质量评估

当前为接入基础，不能凭配置存在或模型自评认定质量提升。

三个 Provider 共用平台公司模型客户端：旧流程调用 `analyzePrd`，以源文件 SHA256 锁定基线，文件改变时拒绝运行；新流程直接调用线上使用的事实提取、建模/规划、生成和质量审查函数。Skills 由后端同一加载器按阶段读取，不另写评估专用提示词。评估不写平台数据库、不创建人工确认或发布版本。

12 份公开合成材料含显式事实、覆盖候选、禁止编造项与允许多解处，均标为 `humanReview: pending`。配置同模型同输入，每配置三次，不缓存。输出保留输入 hash、模型配置 hash（不含 key）、阶段产物与技能版本；随机 UUID 和列表顺序不能作为质量退化依据。

## 本地运行

在仓库根目录配置原有 `MODEL_*` 环境变量，使用本地安装的 Promptfoo。不要在命令行或配置中写密钥。关闭遥测并将结果保存到忽略目录，不运行 share，不使用托管平台：

```sh
PROMPTFOO_DISABLE_TELEMETRY=1 pnpm exec promptfoo eval -c evals/case-design/promptfooconfig.yaml --no-cache -o outputs/case-design-eval.json
```

该命令会实际调用已配置模型，12 × 3 × 3 个评估项，新流程每项包含多次模型请求。只有显式设置 `QUALITY_AI_EVAL_MODE=stub` 并使用本地合成模型地址时才能记录为夹具测试；该标记不会自动替换模型。运行前应检查模型地址，不能把 stub 结果标为真实质量证据。

基础机器断言已检查 schema、事实引用、阶段输入版本和三类搜索策略是否出现，结果名称刻意标为“机器结构检查_非质量通过”。仍需补齐固定值来源对抗样本、逐样本报告与人工评审模板，再实际运行完整矩阵。当前尚未完成 G4 验收。

参考：[Promptfoo 自定义 Provider](https://www.promptfoo.dev/docs/providers/custom-api/) 与[配置参考](https://www.promptfoo.dev/docs/configuration/reference/)。
