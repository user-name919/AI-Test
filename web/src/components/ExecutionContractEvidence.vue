<script setup lang="ts">
import type { ExecutionCaseSnapshot } from '@quality-ai/contracts'
import CaseContractDetails from './CaseContractDetails.vue'
import CaseReuseNote from './CaseReuseNote.vue'
defineProps<{ snapshots?: ExecutionCaseSnapshot[] }>()
</script>
<template>
  <section class="execution-contract-evidence" aria-label="本次执行的用例版本">
    <h3>本次执行的用例版本</h3>
    <p v-if="!snapshots?.length">历史记录未保存用例版本快照，不能据当前用例推断当时执行口径。</p>
    <template v-else>
      <p>以下为执行开始前保存的口径。后续人工修改不会改变本报告；历史计划重跑沿用原计划口径。</p>
      <article v-for="snapshot in snapshots" :key="snapshot.caseId">
        <strong>{{ snapshot.resolved.title }} · v{{ snapshot.revision }}</strong>
        <small>资产 {{ snapshot.caseId }} · 快照时间 {{ snapshot.capturedAt }}</small>
        <CaseReuseNote :source="snapshot.source" />
        <CaseContractDetails :resolved="snapshot.resolved" unavailable-reason="历史契约不可用" />
      </article>
    </template>
  </section>
</template>
<style scoped>
.execution-contract-evidence { padding:20px; border-bottom:1px solid #e3e6ed; font-size:16px; line-height:1.6; } h3 { margin:0 0 8px; } small { display:block; color:#59677b; font-size:14px; overflow-wrap:anywhere; } article { margin-top:16px; }
</style>
