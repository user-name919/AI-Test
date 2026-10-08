<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { DesignPublication, DesignReview } from '@quality-ai/contracts/case-design'
import { designRequest } from './useCaseDesign'
import ContractView from './ContractView.vue'
import PublicationExecution from '../executions/PublicationExecution.vue'
const props=defineProps<{designId:string;review?:DesignReview;dirty:boolean;disabled:boolean}>()
const route=useRoute();const router=useRouter()
const publications=ref<DesignPublication[]>([])
const busy=ref(false);const loading=ref(false);const error=ref('');const notice=ref('')
const downloading=ref(false)
const selected=computed(()=>publications.value.find(item=>item.id===route.query.publicationId)??(route.query.publicationId?undefined:publications.value[0]))
const unavailable=computed(()=>props.disabled?'请等待审核读取或保存完成':props.dirty?'有未保存草稿，请先保存人工审核':!props.review?'当前产物尚未保存人工审核，请先保存':'')
let disposed=false
onBeforeUnmount(()=>{disposed=true})
async function load(){loading.value=true;try{const result=await designRequest<{publications:DesignPublication[]}>(`/api/case-designs/${props.designId}/publications`);if(!disposed)publications.value=result.publications}catch(cause){if(!disposed)error.value=cause instanceof Error?cause.message:'读取版本失败'}finally{loading.value=false}}
onMounted(()=>{void load()})
async function publish(){
  if(unavailable.value||!props.review||busy.value)return
  busy.value=true;error.value='';notice.value=''
  try{
    const result=await designRequest<{publication:DesignPublication}>(`/api/case-designs/${props.designId}/publish`,{expectedRevision:props.review.revision})
    if(disposed)return
    publications.value=[result.publication,...publications.value.filter(item=>item.id!==result.publication.id)].sort((a,b)=>b.version-a.version)
    await router.replace({query:{...route.query,publicationId:result.publication.id}})
    notice.value=`已发布 v${result.publication.version}。这是确认的设计范围，不代表执行通过。`
  }catch(cause){if(!disposed)error.value=cause instanceof Error?cause.message:'发布失败'}finally{busy.value=false}
}
async function download(){
  if(!selected.value||downloading.value)return
  const publication=selected.value
  downloading.value=true;error.value=''
  try{
    const response=await fetch(`/api/case-designs/${props.designId}/publications/${publication.id}/markdown`)
    if(!response.ok||!response.headers.get('content-type')?.includes('text/markdown'))throw new Error('导出失败：服务器未返回 Markdown 文件，请刷新版本后重试')
    const blob=await response.blob()
    if(disposed)return
    const url=URL.createObjectURL(blob)
    const link=document.createElement('a');link.href=url;link.download=`case-design-v${publication.version}.md`;document.body.append(link);link.click();link.remove()
    setTimeout(()=>URL.revokeObjectURL(url),1000)
  }catch(cause){if(!disposed)error.value=cause instanceof Error?cause.message:'下载失败'}finally{downloading.value=false}
}
</script>
<template>
  <section class="design-publications" aria-label="发布与导出">
    <h2>发布与导出</h2><p>发布冻结已保存审核。后续编辑只影响新版本；无需配置环境，不会启动浏览器测试。</p>
    <button :disabled="!!unavailable||busy" @click="publish">{{ busy?'正在检查并发布…':`发布已保存审核${review?` v${review.revision}`:''}` }}</button><p>{{ unavailable || '服务端将检查未确认用例、问题处置、依据及范围，条件不足不会发布。' }}</p>
    <p v-if="error" role="alert" class="error">{{ error }}</p><p v-if="notice" role="status">{{ notice }}</p>
    <button :disabled="loading||busy" @click="load">刷新发布版本</button><p v-if="loading">正在读取版本…</p>
    <label>已发布版本<select aria-label="已发布版本" :value="selected?.id??''" @change="router.replace({query:{...route.query,publicationId:($event.target as HTMLSelectElement).value}})"><option v-for="item in publications" :key="item.id" :value="item.id">v{{ item.version }} · 审核 v{{ item.snapshot.review.revision }} · {{ item.snapshot.cases.length }} 条</option></select></label>
    <p v-if="!publications.length&&!loading">尚未发布。请先完成并保存人工审核。</p><p v-if="route.query.publicationId&&!selected" role="alert">指定发布版本不存在，请重新选择。</p>
    <article v-if="selected" class="publication-preview"><h3>发布 v{{ selected.version }} · 只读快照</h3><p>发布时间：{{ selected.createdAt }} · 材料 v{{ selected.snapshot.design.revision }} · 审核 v{{ selected.snapshot.review.revision }}</p><details><summary>内容校验标识</summary><code>{{ selected.contentHash }}</code></details>
      <a :href="`/api/case-designs/${designId}/publications/${selected.id}/markdown`" :aria-disabled="downloading" @click.prevent="download">{{ downloading?'正在准备下载…':'下载此版本 Markdown' }}</a>
      <PublicationExecution :key="selected.id" :publication="selected" />
      <details v-for="item in selected.snapshot.cases" :key="item.id" open><summary>{{ item.title }} · {{ {browser:'浏览器验证',api:'接口验证',manual:'人工验证'}[item.verification] }}</summary><p>验证方式依据：{{ item.verificationReason }}</p><ContractView :contract="item.contract" />
        <h4>冻结的原文依据</h4><section v-for="fact in selected.snapshot.run.output.factModel?.consolidatedFacts.filter(fact=>item.factIds.includes(fact.id))" :key="fact.id"><p>{{ fact.statement }}（{{ fact.kind }}）</p><blockquote v-for="(ref,index) in fact.evidence" :key="index">{{ ref.quote }}<small>{{ selected.snapshot.design.documents.find(document=>document.id===ref.documentId)?.fileName }} · {{ ref.blockId }}</small></blockquote></section>
        <p v-for="id in item.questionIds" :key="id">人工决定 {{ id }}：{{ selected.snapshot.review.content.questionDecisions[id] }}</p>
      </details>
      <details><summary>排除范围与审查处置</summary><p v-for="(item,id) in selected.snapshot.review.content.cases" :key="id"><span v-if="item.status==='excluded'">排除用例 {{ item.title }}：{{ item.exclusionReason }}</span></p><p v-for="(reason,id) in selected.snapshot.review.content.excludedFacts" :key="id">排除规则 {{ id }}：{{ reason }}</p><p v-for="issue in selected.snapshot.run.output.issues" :key="issue.id">{{ issue.reason }}；人工处置：{{ selected.snapshot.review.content.issueDecisions[issue.id]?.reason || '无单独处置，见排除范围或保留提醒' }}</p></details>
    </article>
  </section>
</template>
<style scoped>
.design-publications{margin-top:24px;border-top:2px solid #e3e5f0;padding-top:16px;font-size:16px}button,select{font:inherit;padding:8px 12px;border:1px solid #aab5c8;border-radius:6px;background:#fff}button:disabled{opacity:.55}label{display:block;margin:16px 0}select{display:block;max-width:100%}.error{background:#fff0f0;color:#942727;padding:12px}.publication-preview{padding:20px;border:1px solid #d8ddec;border-radius:10px;margin-top:16px}.publication-preview>details{margin:16px 0}summary{cursor:pointer;font-weight:600}a{display:inline-block;margin:12px 0;color:#4937b8}code{overflow-wrap:anywhere}small{display:block;font-size:14px}blockquote{border-left:3px solid #c2bbf1;padding-left:12px;margin:12px 0}
</style>
