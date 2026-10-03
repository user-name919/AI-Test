<script setup lang="ts">
import type { CaseExecutionResult } from '@quality-ai/contracts'
defineProps<{result:CaseExecutionResult}>()
const recoveryNames={reobserved:'已重新观察页面，再由 AI 决定下一步',exhausted:'恢复次数已用尽',observation_failed:'恢复时无法重新观察页面'}
</script>
<template>
  <section class="evidence" aria-label="用例实际执行证据">
    <h3>本次实际使用的数据</h3>
    <p v-if="!result.resolvedDataBindings.length">未记录运行时数据绑定，不代表已验证数据来源。</p>
    <article v-for="binding in result.resolvedDataBindings" :key="binding.bindingId">
      <p>输入：<strong>{{ binding.value }}</strong> · 来源选项：{{ binding.sourceText }}</p>
      <p>选择依据：{{ binding.reason }}</p><small>DOM {{ binding.snapshotId }} · {{ binding.sourceElementRef }} · {{ binding.observedAt }}</small>
    </article>
    <h3>操作与验证经过</h3>
    <article v-for="turn in result.trajectory" :key="turn.iteration">
      <h4>第 {{ turn.iteration }} 步 · {{ turn.decision.type==='finish'?turn.decision.summary:turn.decision.reason }}</h4>
      <p v-if="turn.result">{{ turn.result.ok?'本步成功':'本步失败' }}：{{ turn.result.message }} · {{ turn.result.durationMs }} ms</p>
      <p v-else>本步未记录浏览器执行结果，不据此判定通过。</p>
      <p v-if="turn.recovery" class="recovery">技术恢复 {{ turn.recovery.attempt }}/{{ turn.recovery.limit }}：{{ recoveryNames[turn.recovery.status] }}。原因：{{ turn.recovery.reason }}</p>
      <small>DOM 快照：{{ turn.snapshotId }}</small>
      <details><summary>查看本步技术动作与观察</summary><pre>{{ JSON.stringify({decision:turn.decision,observation:turn.observation,projectContext:turn.projectContext},null,2) }}</pre></details>
    </article>
    <template v-if="!result.trajectory.length"><p v-if="!result.steps.length">没有操作证据。</p><article v-for="step in result.steps" :key="step.index"><p>第 {{ step.index+1 }} 步 · {{ step.action }} · {{ step.status==='passed'?'成功':'失败' }} · {{ step.durationMs }} ms</p><p v-if="step.error">{{ step.error }}</p></article></template>
    <details><summary>查看原始执行数据（排障）</summary><pre>{{ JSON.stringify({data:result.resolvedDataBindings,steps:result.steps,trajectory:result.trajectory},null,2) }}</pre></details>
  </section>
</template>
<style scoped>
.evidence{min-width:0;font-size:15px;line-height:1.65}.evidence article{border:1px solid #dce2ed;border-radius:10px;padding:12px;margin:12px 0;overflow-wrap:anywhere}.evidence h4{margin:0;font-size:16px}.evidence small{color:#536078}.evidence pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:14px}.evidence summary{cursor:pointer;padding:8px 0}.recovery{background:#fff5dc;padding:10px;border-radius:6px}
</style>
