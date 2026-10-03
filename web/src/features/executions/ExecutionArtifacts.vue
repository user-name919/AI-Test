<script setup lang="ts">
import { onUnmounted, ref, watch } from 'vue'
import type { ExecutionRecord } from '@quality-ai/contracts'
import type { ExecutionArtifact } from '@quality-ai/contracts/cases'
const props=defineProps<{execution:ExecutionRecord}>()
const artifacts=ref<ExecutionArtifact[]>([])
const error=ref('')
const expanded=ref<string[]>([])
let generation=0
async function load(){
  const epoch=++generation;error.value=''
  try{
    const response=await fetch(`/api/executions/${props.execution.id}/artifacts`)
    const result=await response.json()
    if(!response.ok)throw new Error(result.error??'附件读取失败')
    if(epoch===generation)artifacts.value=result.artifacts??[]
  }catch(cause){if(epoch===generation)error.value=cause instanceof Error?cause.message:'附件读取失败'}
}
watch(()=>props.execution.id,()=>{artifacts.value=[];expanded.value=[];void load()},{immediate:true})
onUnmounted(()=>{generation++})
</script>
<template>
  <section class="execution-artifacts"><h3>逐用例证据附件</h3><p v-if="error" role="alert">{{ error }} <button @click="load">重试读取附件</button></p><p v-if="!error&&!artifacts.length">本次报告没有登记可展示附件。</p>
    <article v-for="item in artifacts" :key="item.id"><strong>{{ execution.caseResults?.find(result=>result.caseKey===item.caseKey)?.title??'批次证据' }} · {{ item.kind==='trace'?'操作 Trace':'页面截图' }}</strong><p>{{ item.name }}</p><p v-if="!item.available">文件已清理、缺失或不可访问，历史报告仍保留引用。</p><template v-else><a :href="`${item.url}?download=1`">下载{{ item.kind==='trace'?' Trace':'截图' }}</a><button v-if="item.kind==='screenshot'" @click="expanded=expanded.includes(item.id)?expanded.filter(id=>id!==item.id):[...expanded,item.id]">{{ expanded.includes(item.id)?'收起截图':'查看截图' }}</button><img v-if="expanded.includes(item.id)" :src="item.url" :alt="`${item.name} 页面证据`" /></template></article>
    <details><summary>如何查看 Trace？</summary><p>下载对应 zip，在本机运行 <code>npx playwright show-trace 下载文件路径</code>，查看操作、DOM 与网络。Trace 可能含业务数据，请勿上传公共查看站点。</p></details>
  </section>
</template>
<style scoped>
.execution-artifacts{font-size:16px;margin-top:20px}.execution-artifacts article{padding:16px 0;border-bottom:1px solid #dde2ee;overflow-wrap:anywhere}.execution-artifacts img{display:block;max-width:100%;margin-top:12px;border:1px solid #dde2ee}.execution-artifacts a,.execution-artifacts button{display:inline-block;font:inherit;margin-right:16px}.execution-artifacts p{line-height:1.6}.execution-artifacts summary{cursor:pointer;margin-top:16px}
</style>
