<script setup lang="ts">
import type { CaseSource } from '@quality-ai/contracts/cases'
defineProps<{source?:CaseSource;title?:string}>()
</script>
<template>
  <div v-if="source?.type==='change_regression'&&source.reusedFrom" class="reuse-note">
    <p v-if="title">{{ title }}</p>
    <p>复用来源：{{ source.reusedFrom.title }} · v{{ source.reusedFrom.revision }} · {{ source.reusedFrom.sourceType }} / {{ source.reusedFrom.sourceId }}</p>
    <p>资产 {{ source.reusedFrom.caseId }} · 来源指纹 {{ source.reusedFrom.contractFingerprint }}</p>
    <p>人工适用理由：{{ source.reusedFrom.reason }}</p><p>来源版本已冻结；本次执行使用审核后的最终口径，不追读来源最新内容。</p>
  </div>
</template>
<style scoped>.reuse-note{background:#f4f3ff;padding:12px;margin:12px 0;overflow-wrap:anywhere;font-size:14px}</style>
