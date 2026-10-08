<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { onBeforeRouteLeave, onBeforeRouteUpdate, useRoute, useRouter } from 'vue-router'
import { designReviewContentSchema, type DesignReview, type DesignReviewContent, type DesignReviewDraft, type DesignRun, type EvidenceRef } from '@quality-ai/contracts/case-design'
import ContractEditor from './ContractEditor.vue'
import ContractView from './ContractView.vue'
import PublicationPanel from './PublicationPanel.vue'
import RegenerationComparison from './RegenerationComparison.vue'
import { designRequest } from './useCaseDesign'
const props=defineProps<{designId:string;run:DesignRun}>()
const emit=defineEmits<{locate:[value:EvidenceRef]}>()
const route=useRoute();const router=useRouter()
const content=ref<DesignReviewContent>({cases:{},questionDecisions:{},issueDecisions:{},excludedFacts:{}})
const revision=ref(0);const history=ref<DesignReview[]>([]);const error=ref('');const notice=ref('');const busy=ref(false);const ready=ref(false);const dirty=ref(false);const conflict=ref<DesignReview|null>(null)
const activeId=computed(()=>typeof route.query.caseId==='string'?route.query.caseId:props.run.output.cases?.[0]?.id??'')
const current=computed(()=>content.value.cases[activeId.value])
const original=computed(()=>props.run.output.cases?.find(item=>item.id===activeId.value))
const relatedFacts=computed(()=>props.run.output.factModel?.consolidatedFacts.filter(fact=>original.value?.factIds.includes(fact.id))??[])
const storageKey=computed(()=>`design-review-draft:${props.designId}:${props.run.id}`)
let disposed=false
const copy=<T,>(value:T):T=>JSON.parse(JSON.stringify(value))
async function load() {
  ready.value=false;error.value=''
  try {
    const [result,{draft}]=await Promise.all([
      designRequest<{reviews:DesignReview[]}>(`/api/case-designs/${props.designId}/reviews`),
      designRequest<{draft:DesignReviewDraft}>(`/api/case-designs/${props.designId}/runs/${props.run.id}/review-draft`),
    ])
    if(disposed)return
    history.value=result.reviews;revision.value=draft.expectedRevision
    content.value=copy(draft.content)
    if(draft.sourceReviewId){dirty.value=true;notice.value=`参考审核 v${draft.sourceReviewRevision}，保留 ${draft.inheritedCaseIds.length} 条未变化用例的人工口径；重生成用例仍是待审核草稿，质量问题需重新处置。请检查后保存。`}
    const local=sessionStorage.getItem(storageKey.value)
    if(local){const parsed=JSON.parse(local);content.value=parsed.content;revision.value=parsed.revision;dirty.value=true;notice.value='已恢复当前标签页未保存草稿；保存时仍会校验服务端版本。'}
  } catch(cause){error.value=cause instanceof Error?cause.message:'读取审核失败';return}
  ready.value=true
}
onMounted(()=>{void load()})
watch(content,()=>{
  if(!ready.value)return
  dirty.value=true
  try{sessionStorage.setItem(storageKey.value,JSON.stringify({revision:revision.value,content:content.value}))}
  catch{error.value='本地草稿保存失败，请保持页面打开并保存到服务端。'}
},{deep:true,flush:'sync'})
function leave(){return !dirty.value || window.confirm('有未保存修改。离开后保留当前标签页草稿，但不会更新服务端；是否离开？')}
onBeforeRouteLeave(leave)
onBeforeRouteUpdate(to=>to.params.id!==route.params.id || to.query.runId!==route.query.runId ? leave():true)
function beforeUnload(event:BeforeUnloadEvent){if(dirty.value){event.preventDefault();event.returnValue=''}}
onMounted(()=>window.addEventListener('beforeunload',beforeUnload))
onBeforeUnmount(()=>{disposed=true;window.removeEventListener('beforeunload',beforeUnload)})
async function save() {
  busy.value=true;error.value='';notice.value=''
  try {
    const value=copy(content.value)
    for(const item of Object.values(value.cases)) for(const key of ['preconditions','steps','expectedAssertions','forbiddenBehaviors','uncertainties'] as const)item.contract[key]=item.contract[key].map(line=>line.trim()).filter(Boolean)
    value.questionDecisions=Object.fromEntries(Object.entries(value.questionDecisions).filter(([,answer])=>answer.trim()))
    const parsed=designReviewContentSchema.safeParse(value)
    if(!parsed.success)throw new Error(parsed.error.issues.map(issue=>`${issue.path.join('.')}：${issue.message}`).join('；'))
    const response=await fetch(`/api/case-designs/${props.designId}/reviews`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({expectedRevision:revision.value,runId:props.run.id,review:parsed.data})})
    const result=await response.json()
    if(disposed)return
    if(response.status===409){conflict.value=result.review;throw new Error('审核版本已更新。草稿未覆盖，请对比最新记录后再保存。')}
    if(!response.ok)throw new Error(result.error||'保存失败')
    ready.value=false;content.value=copy(result.review.content);ready.value=true
    revision.value=result.review.revision;history.value=[result.review,...history.value];dirty.value=false;conflict.value=null
    sessionStorage.removeItem(storageKey.value);notice.value=`已保存审核 v${revision.value}，尚未发布，也不代表测试通过。`
  }catch(cause){error.value=cause instanceof Error?cause.message:'保存失败'}finally{busy.value=false}
}
function rebase(){if(conflict.value){revision.value=conflict.value.revision;conflict.value=null;sessionStorage.setItem(storageKey.value,JSON.stringify({revision:revision.value,content:content.value}));notice.value='已更新基线，请再次保存以提交你的口径。'}}
function issueStatus(id:string,event:Event){const status=(event.target as HTMLSelectElement).value;if(!status)delete content.value.issueDecisions[id];else content.value.issueDecisions[id]={status:status as 'addressed'|'dismissed',reason:content.value.issueDecisions[id]?.reason??''}}
function adopt(value:{caseId:string;review:DesignReviewContent['cases'][string]}){
  if(!ready.value||busy.value||conflict.value||!content.value.cases[value.caseId])return
  content.value.cases[value.caseId]=copy(value.review)
  notice.value='已更新此用例草稿，尚未确认或保存；请核对关联依据、步骤与断言。'
  void router.replace({query:{...route.query,caseId:value.caseId}})
}
</script>
<template>
  <section class="design-review-editor">
    <header><div><h2>人工审核用例</h2><p>逐条选择确认、草稿或排除，保存完整审核快照。{{ dirty?'有未保存修改':'当前无未保存修改' }}</p></div><button :disabled="!ready||busy||!!conflict" @click="save">{{ busy?'正在保存…':'保存人工审核' }}</button></header>
    <p v-if="error" role="alert" class="error">{{ error }} <button v-if="!ready" @click="load">重试读取</button></p><p v-if="notice" role="status">{{ notice }}</p>
    <div v-if="conflict" class="error"><h3>服务端最新审核 v{{ conflict.revision }}</h3><p v-if="conflict.runId!==run.id">最新审核来自另一份生成产物。保留本草稿会建立旧产物的新审核版本，请确认这是你的意图。</p><details><summary>展开最新口径对比（不会覆盖草稿）</summary><pre>{{ JSON.stringify(conflict.content,null,2) }}</pre></details><button @click="rebase">已对比，保留我的草稿并更新版本号</button></div>
    <RegenerationComparison v-if="run.regeneration" :key="run.id" :design-id="designId" :run-id="run.id" :disabled="!ready||busy||!!conflict" @adopt="adopt" />
    <div v-if="ready" class="review-columns">
      <nav aria-label="审核用例列表"><button v-for="item in run.output.cases" :key="item.id" :class="{selected:item.id===activeId}" @click="router.replace({query:{...route.query,caseId:item.id}})">{{ content.cases[item.id]?.title || item.title }}<small>{{ {draft:'待审核草稿',confirmed:'人工已确认',excluded:'已排除'}[content.cases[item.id]?.status??'draft'] }}</small></button></nav>
      <div v-if="current" class="case-detail"><fieldset :disabled="busy"><legend>完整人工口径</legend><label>用例标题<input v-model="current.title" /></label><label>审核状态<select aria-label="审核状态" v-model="current.status"><option value="draft">草稿，尚未确认</option><option value="confirmed">人工确认</option><option value="excluded">本次排除</option></select></label><label v-if="current.status==='excluded'">排除理由<textarea v-model="current.exclusionReason" /></label><label>验证方式<select aria-label="验证方式" v-model="current.verification"><option value="browser">浏览器</option><option value="api">接口</option><option value="manual">人工</option></select></label><label>验证方式依据<input v-model="current.verificationReason" /></label><ContractEditor v-model="current.contract" /></fieldset>
        <h3>此用例原文依据</h3><div v-for="fact in relatedFacts" :key="fact.id"><p>{{ fact.statement }}（{{ fact.kind }}）</p><button v-for="(reference,index) in fact.evidence" :key="index" @click="emit('locate',reference)">定位依据：{{ reference.quote }}</button></div>
        <details><summary>AI 原始建议（只读，不是人工最终口径）</summary><ContractView v-if="original" :contract="original.contract" /></details>
      </div><p v-else>指定用例不存在，请从列表选择。</p>
    </div>
    <fieldset v-if="ready" :disabled="busy"><legend>问题决定、质量处置与范围</legend>
      <label v-for="question in [...run.output.questions,...run.output.factModel?.conflicts??[]]" :key="question.id">{{ question.question }}<textarea v-model="content.questionDecisions[question.id]" placeholder="人工最终决定；不确定可留空，但相关用例暂不能发布" /></label>
      <article v-for="issue in run.output.issues" :key="issue.id"><p>{{ issue.severity==='blocking'?'阻塞':'提醒' }} · {{ issue.reason }}</p><select :aria-label="`问题 ${issue.id} 处理方式`" :value="content.issueDecisions[issue.id]?.status??''" @change="issueStatus(issue.id,$event)"><option value="">尚未处理</option><option value="addressed">已处理并说明改动</option><option value="dismissed">不采纳并说明原因</option></select><label v-if="content.issueDecisions[issue.id]">处理理由<textarea v-model="content.issueDecisions[issue.id].reason" /></label></article>
      <article v-for="fact in run.output.factModel?.consolidatedFacts" :key="fact.id"><label><input type="checkbox" :checked="fact.id in content.excludedFacts" @change="($event.target as HTMLInputElement).checked ? content.excludedFacts[fact.id]='' : delete content.excludedFacts[fact.id]" />排除规则：{{ fact.statement }}</label><label v-if="fact.id in content.excludedFacts">排除规则理由<input v-model="content.excludedFacts[fact.id]" /></label></article>
    </fieldset>
    <details><summary>历史审核记录（{{ history.length }}）</summary><details v-for="item in history" :key="item.id"><summary>v{{ item.revision }} · {{ item.createdAt }}</summary><pre>{{ JSON.stringify(item.content,null,2) }}</pre></details></details>
    <PublicationPanel :design-id="designId" :review="history[0]?.runId===run.id?history[0]:undefined" :dirty="dirty" :disabled="!ready||busy||!!conflict" />
  </section>
</template>
<style scoped>
.design-review-editor{margin-top:20px;padding:20px;background:#fff;border:1px solid #dce1eb;border-radius:12px;font-size:16px}header{display:flex;justify-content:space-between;gap:16px;align-items:center}.review-columns{display:grid;grid-template-columns:minmax(180px,25%) minmax(0,1fr);gap:20px}nav button{display:block;width:100%;text-align:left;margin:8px 0}.selected{background:#ece9ff}small{display:block;font-size:14px}label{display:block;margin:12px 0}textarea,input:not([type=checkbox]),select{font:inherit;padding:8px;border:1px solid #aab5c8;border-radius:6px;max-width:100%;width:100%;box-sizing:border-box}textarea{min-height:70px;resize:vertical}fieldset{min-width:0;border:1px solid #dce1eb;border-radius:8px;margin:16px 0;padding:16px}button{font:inherit;padding:8px 12px;border:1px solid #b8bfd0;border-radius:6px;background:#fff;cursor:pointer}button:disabled{opacity:.5;cursor:not-allowed}.error{background:#fff0f0;color:#942727;padding:12px}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:14px/1.6 monospace}details{margin:16px 0}summary{cursor:pointer}article{border-bottom:1px solid #e0e4ed;padding:10px 0}@media(max-width:850px){.review-columns{grid-template-columns:1fr}header{display:block}}
</style>
