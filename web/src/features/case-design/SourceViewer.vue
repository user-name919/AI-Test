<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import type { DesignDocument, EvidenceRef } from '@quality-ai/contracts/case-design'
const props = defineProps<{ documents: DesignDocument[]; reference?: EvidenceRef }>()
const root = ref<HTMLElement>()
watch(() => props.reference, async () => {
  await nextTick()
  root.value?.querySelector('[data-selected="true"]')?.scrollIntoView({ block: 'nearest' })
})
</script>
<template>
  <aside ref="root" class="source-viewer" aria-label="原文依据">
    <h2>材料原文</h2><p>摘录匹配不代表语义已确认；点击右侧依据定位原文。</p>
    <section v-for="document in documents" :key="document.id">
      <h3>{{ document.fileName }} · {{ document.role === 'prd' ? '主材料' : '补充材料' }}</h3>
      <p v-for="warning in document.warnings" :key="warning" class="warning">{{ warning }}</p>
      <article v-for="block in document.blocks" :key="block.id" :data-selected="reference?.documentId === document.id && reference?.blockId === block.id" tabindex="0">
        <small>{{ block.page ? `第 ${block.page} 页 · ` : '' }}{{ block.section || block.kind }}</small>
        <pre>{{ block.text || '此块未提取到文字' }}</pre>
        <p v-for="warning in block.warnings" :key="warning" class="warning">{{ warning }}</p>
      </article>
    </section>
  </aside>
</template>
<style scoped>
.source-viewer{overflow:auto;max-height:78vh;padding:20px;background:#fff;border:1px solid #dce1eb;border-radius:12px;min-width:0}.source-viewer h2{font-size:20px}article{padding:12px;margin:12px 0;border:2px solid transparent;border-radius:8px;background:#f6f8fc}article[data-selected=true]{border-color:#6254dd;background:#efedff}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;margin:8px 0}small{font-size:14px;color:#59677b}.warning{color:#92500c}
</style>
