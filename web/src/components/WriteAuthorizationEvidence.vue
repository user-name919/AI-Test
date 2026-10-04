<script setup lang="ts">
import type { ExecutionWriteAuthorization } from '@quality-ai/contracts'
defineProps<{authorizations?:ExecutionWriteAuthorization[]}>()
</script>
<template>
  <section v-if="authorizations?.length" class="write-evidence" aria-label="本次业务写操作授权记录">
    <h3>本次业务写操作授权记录</h3><p>启动时逐条确认的范围；不证明操作成功。历史重跑必须重新授权，取消测试不会回滚业务。</p>
    <details v-for="authorization in authorizations" :key="authorization.caseId"><summary>{{ authorization.caseKey }} · {{ authorization.operations.join('；') }}</summary><p>资产：{{ authorization.caseId }}<br />契约指纹：{{ authorization.contractFingerprint }}<br />测试地址：{{ authorization.targetUrl }}<br />确认时间：{{ authorization.confirmedAt }}</p></details>
  </section>
</template>
<style scoped>
.write-evidence{font-size:16px;line-height:1.65;overflow-wrap:anywhere;margin:16px 0;padding:16px;border:1px solid #d5b880;border-radius:8px}summary{cursor:pointer}details{margin:12px 0}h3{margin:0 0 8px}
</style>
