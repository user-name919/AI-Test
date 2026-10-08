<script setup lang="ts">
import type { ChangeSet } from '@quality-ai/contracts/regressions'
defineProps<{ changeSet: ChangeSet }>()
const modes = { endpoints: '端点比较', merge_base: '分支贡献（公共基线）', selected_commits: '指定提交（逐个 patch）' }
</script>

<template>
  <section class="reg-card" aria-label="固定变更范围">
    <h2>{{ changeSet.status==='frozen'?'已冻结范围':'待确认的范围预览' }}</h2>
    <p>{{ modes[changeSet.facts.comparison.mode] }} · 项目 {{ changeSet.projectId }} · {{ changeSet.createdAt }}</p>
    <p>目标 SHA：<code>{{ changeSet.facts.targetSha }}</code></p>
    <p v-if="changeSet.facts.effectiveBaseSha">实际基线 SHA：<code>{{ changeSet.facts.effectiveBaseSha }}</code></p>
    <p v-if="changeSet.facts.requestedBaseSha">所选基线解析 SHA：<code>{{ changeSet.facts.requestedBaseSha }}</code></p>
    <p>只读取已提交对象，不包含未提交编辑；分支后续移动不会更新此快照。</p>
    <ul v-if="changeSet.facts.warnings.length" class="reg-warning"><li v-for="warning in changeSet.facts.warnings" :key="warning">{{ warning }}</li></ul>
    <details><summary>提交记录（{{ changeSet.facts.commits.length }}）</summary><ul><li v-for="commit in changeSet.facts.commits" :key="commit.sha"><strong>{{ commit.subject }}</strong><p>{{ commit.sha }}<br />父提交：{{ commit.parents.join('、')||'根提交' }}</p></li></ul></details>
    <details v-if="changeSet.facts.omittedCommitShas.length"><summary>目标版本中未选的提交（{{ changeSet.facts.omittedCommitShas.length }}）</summary><p>这些提交仍存在于目标版本，不能声称测试环境只有本次选择的修改。</p><ul><li v-for="sha in changeSet.facts.omittedCommitShas" :key="sha">{{ sha }}</li></ul></details>
    <details v-for="(diff,index) in changeSet.facts.diffs" :key="`${diff.baseSha}:${diff.targetSha}`"><summary>差异 {{ index+1 }} · {{ diff.files.length }} 个文件 · {{ diff.baseSha.slice(0,8) }} → {{ diff.targetSha.slice(0,8) }}</summary><ul><li v-for="file in diff.files" :key="file.path">{{ file.status }} · {{ file.oldPath?`${file.oldPath} → `:'' }}{{ file.path }}</li></ul><pre>{{ diff.patch||'无文本差异' }}</pre></details>
    <details><summary>范围 ID 与完整性指纹</summary><p>{{ changeSet.id }}<br />{{ changeSet.factsHash }}</p></details>
  </section>
</template>
