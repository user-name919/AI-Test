<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { onBeforeRouteLeave, onBeforeRouteUpdate, useRoute, useRouter } from 'vue-router'
import type { CaseExecutionContract } from '@quality-ai/contracts'
import { regressionReviewContentSchema, type RegressionReview, type RegressionReviewItems } from '@quality-ai/contracts/regressions'
import ContractEditor from '../case-design/ContractEditor.vue'
import ContractView from '../case-design/ContractView.vue'
import RegressionExecution from './RegressionExecution.vue'
import { regressionRequest } from './api'

const props=defineProps<{regressionId:string;projectId:string;targetSha:string}>()
const route=useRoute();const router=useRouter()
type Decision='pending'|'include'|'exclude'
interface Draft {scopeNote:string;risks:Record<string,{decision:Decision;reason:string}>;cases:Record<string,{decision:Decision;reason:string;title:string;verification:'browser'|'api'|'manual';verificationReason:string;contract:CaseExecutionContract}>}
const draft=ref<Draft>({scopeNote:'',risks:{},cases:{}})
const items=ref<RegressionReviewItems>({risks:[],cases:[]});const history=ref<RegressionReview[]>([])
const revision=ref(0);const ready=ref(false);const busy=ref(false);const dirty=ref(false);const error=ref('');const notice=ref('');const conflict=ref<RegressionReview>()
const selected=computed(()=>typeof route.query.reviewCase==='string'?route.query.reviewCase:items.value.cases[0]?.key??'')
const current=computed(()=>draft.value.cases[selected.value]);const original=computed(()=>items.value.cases.find(item=>item.key===selected.value))
const pending=computed(()=>Object.values(draft.value.risks).filter(item=>item.decision==='pending').length+Object.values(draft.value.cases).filter(item=>item.decision==='pending').length)
const storageKey=`regression-review-draft:${props.regressionId}`
const copy=<T,>(value:T):T=>JSON.parse(JSON.stringify(value))
let disposed=false
function remember(){try{sessionStorage.setItem(storageKey,JSON.stringify({revision:revision.value,draft:draft.value,dirty:dirty.value}))}catch{error.value='本地草稿暂存失败，请保持页面打开并保存到服务端。'}}
watch(draft,()=>{if(ready.value){dirty.value=true;remember()}},{deep:true,flush:'sync'})
async function load(){
  if(busy.value)return
  error.value='';ready.value=false
  try{
    const result=await regressionRequest<{items:RegressionReviewItems;reviews:RegressionReview[]}>(`/api/regressions/${props.regressionId}/review`)
    if(disposed)return
    items.value=result.items;history.value=result.reviews;revision.value=result.reviews[0]?.revision??0
    const latest=result.reviews[0]?.content
    const value:Draft={scopeNote:latest?.scopeNote??'',risks:{},cases:{}}
    for(const item of result.items.risks){const saved=latest?.risks.find(entry=>entry.key===item.key);value.risks[item.key]={decision:saved?.decision??'pending',reason:saved?.reason??''}}
    for(const item of result.items.cases){
      const saved=latest?.cases.find(entry=>entry.key===item.key)
      value.cases[item.key]={decision:saved?.decision??'pending',reason:saved?.decision==='exclude'?saved.reason:'',title:saved?.decision==='include'?saved.title:item.original.title,verification:saved?.decision==='include'?saved.verification:item.original.verification,verificationReason:saved?.decision==='include'?saved.verificationReason:item.original.verificationReason,contract:copy(saved?.decision==='include'?saved.finalContract:item.original.contract)}
    }
    draft.value=value
    const local=sessionStorage.getItem(storageKey)
    if(local){
      const restored=JSON.parse(local) as {revision:number;draft:Draft;dirty?:boolean}
      if(!Number.isInteger(restored.revision)||!restored.draft?.risks||!restored.draft?.cases||typeof restored.draft.scopeNote!=='string')throw new Error('本地草稿格式异常，请保留页面并检查；未覆盖服务端数据')
      draft.value=restored.draft;revision.value=restored.revision;dirty.value=restored.dirty!==false;notice.value='已恢复此标签页编辑内容，保存时仍会校验版本。未决定项的文字仅暂存在此标签页；服务端只保存明确纳入/排除的内容。'
    }
    ready.value=true
  }catch(cause){error.value=cause instanceof Error?cause.message:'读取审核失败'}
}
async function save(status:'draft'|'confirmed'){
  if(!ready.value||busy.value||conflict.value)return
  busy.value=true;error.value='';notice.value=''
  try{
    const content:RegressionReview['content']={status,scopeNote:draft.value.scopeNote,risks:[],cases:[]}
    for(const [key,item] of Object.entries(draft.value.risks))if(item.decision!=='pending')content.risks.push({key,decision:item.decision,reason:item.reason})
    for(const [key,item] of Object.entries(draft.value.cases)){
      if(item.decision==='exclude')content.cases.push({key,decision:'exclude',reason:item.reason})
      if(item.decision==='include'){
        const contract=copy(item.contract)
        for(const key of ['preconditions','steps','expectedAssertions','forbiddenBehaviors','uncertainties'] as const)contract[key]=contract[key].map(line=>line.trim()).filter(Boolean)
        content.cases.push({key,decision:'include',title:item.title,verification:item.verification,verificationReason:item.verificationReason,finalContract:contract})
      }
    }
    const parsed=regressionReviewContentSchema.safeParse(content)
    if(!parsed.success)throw new Error(parsed.error.issues.map(issue=>`${issue.path.join('.')}：${issue.message}`).join('；'))
    const response=await fetch(`/api/regressions/${props.regressionId}/review`,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({expectedRevision:revision.value,content:parsed.data})})
    const result=await response.json()
    if(disposed)return
    if(!response.ok){
      if(response.status===409){const latest=await regressionRequest<{reviews:RegressionReview[]}>(`/api/regressions/${props.regressionId}/review`);if(disposed)return;history.value=latest.reviews;if(latest.reviews[0]&&latest.reviews[0].revision!==revision.value)conflict.value=latest.reviews[0]}
      throw new Error(result.error??'保存失败；草稿保留')
    }
    revision.value=result.review.revision;history.value=[result.review,...history.value];dirty.value=false
    // 本地草稿保留未决定项的编辑，但标记为服务端新基线；刷新后可继续审核。
    remember()
    notice.value=`已保存${status==='confirmed'?'确认':'草稿'}版本 v${revision.value}。未决定项的编辑只保留在此标签页；确认仅生成回归资产，不代表测试通过。`
  }catch(cause){if(!disposed)error.value=cause instanceof Error?cause.message:'保存失败'}finally{if(!disposed)busy.value=false}
}
function rebase(){if(conflict.value){revision.value=conflict.value.revision;conflict.value=undefined;dirty.value=true;remember();notice.value='保留你的草稿并采用最新版本号；请核对全部内容后再次保存。'}}
function leave(){return !dirty.value||window.confirm('有未保存人工审核，离开后只保留此标签页草稿，是否离开？')}
onBeforeRouteLeave(leave)
onBeforeRouteUpdate(to=>to.params.id===route.params.id||leave())
function beforeUnload(event:BeforeUnloadEvent){if(dirty.value){event.preventDefault();event.returnValue=''}}
onMounted(()=>{window.addEventListener('beforeunload',beforeUnload);void load()})
onUnmounted(()=>{disposed=true;window.removeEventListener('beforeunload',beforeUnload)})
</script>

<template>
  <section class="reg-card regression-review" aria-label="人工回归审核">
    <h2>人工范围与最终用例</h2><p>AI 原文保持只读。每项需明确纳入或排除，排除填写理由；保存草稿不会生成可执行资产，确认后保留独立版本。</p>
    <p>{{ dirty?'有未保存修改':'当前无未保存修改' }} · 当前基线 v{{ revision }} · {{ pending }} 项待决定</p>
    <p v-if="error" role="alert" class="reg-error">{{ error }}<button v-if="!ready" @click="load">重试读取审核</button></p><p v-if="notice" role="status">{{ notice }}</p>
    <div v-if="conflict" class="reg-warning"><h3>发现服务端新版本 v{{ conflict.revision }}</h3><p>未覆盖你的草稿。请展开比较，再决定是否保留自己的完整口径。</p><details><summary>最新人工口径（只读）</summary><pre>{{ JSON.stringify(conflict.content,null,2) }}</pre></details><button @click="rebase">已比较，保留我的草稿并更新基线</button></div>
    <template v-if="ready">
      <fieldset :disabled="busy"><legend>逐项决定风险范围</legend><article v-for="item in items.risks" :key="item.key" class="risk-review"><h3>{{ item.original.title }}</h3><p>{{ item.original.reason }}</p><p>来源：{{ item.batchId }} · 依据 {{ item.original.evidenceIds.join('、') }}（原始依据见本页 AI 建议）</p><label>范围决定<select v-model="draft.risks[item.key]!.decision" :aria-label="`风险 ${item.original.title} 范围决定`"><option value="pending">尚未决定</option><option value="include">纳入回归</option><option value="exclude">本次排除</option></select></label><label>理由或验证安排<textarea v-model="draft.risks[item.key]!.reason" :aria-label="`风险 ${item.original.title} 理由`" placeholder="排除必须说明；纳入但没有对应用例时，说明验证安排" /></label></article></fieldset>
      <h3>回归用例审核</h3><div class="reg-review-columns"><nav aria-label="回归用例审核列表"><button v-for="item in items.cases" :key="item.key" :class="{selected:item.key===selected}" @click="router.replace({query:{...route.query,reviewCase:item.key}})">{{ draft.cases[item.key]?.title||item.original.title }}<small>{{ {pending:'待决定',include:'纳入',exclude:'排除'}[draft.cases[item.key]?.decision??'pending'] }}</small></button></nav>
      <section v-if="current&&original"><fieldset :disabled="busy"><legend>完整最终口径</legend><label>用例范围决定<select v-model="current.decision" aria-label="用例范围决定"><option value="pending">尚未决定</option><option value="include">纳入回归</option><option value="exclude">本次排除</option></select></label><label v-if="current.decision==='exclude'">用例排除理由<textarea v-model="current.reason" /></label><p>关联风险：{{ original.riskKeys.map(key=>items.risks.find(item=>item.key===key)?.original.title??key).join('、') }}</p><label>回归用例标题<input v-model="current.title" /></label><label>验证方式<select v-model="current.verification" aria-label="回归验证方式"><option value="browser">浏览器</option><option value="api">接口</option><option value="manual">人工</option></select></label><label>验证方式理由<input v-model="current.verificationReason" /></label><ContractEditor v-model="current.contract" /></fieldset><details><summary>AI 原始用例（只读）</summary><ContractView :contract="original.original.contract" /></details></section><p v-else>请从列表选择需要审核的用例。</p></div>
      <label>人工回归范围及已知限制<textarea v-model="draft.scopeNote" :disabled="busy" rows="3" placeholder="说明本次覆盖什么，哪些未解析、未处理或未验证内容需要后续补充" /></label>
      <div class="review-actions"><button :disabled="busy||!!conflict" @click="save('draft')">保存审核草稿</button><button :disabled="busy||!!conflict||pending>0||!draft.scopeNote.trim()" @click="save('confirmed')">确认回归范围与用例</button></div><p v-if="pending||!draft.scopeNote.trim()">确认前请决定所有风险和用例，并填写范围限制。接口或人工用例不会自动变成浏览器用例。</p>
      <details><summary>人工审核历史（{{ history.length }}）</summary><article v-for="entry in history" :key="entry.revision"><h3>v{{ entry.revision }} · {{ entry.content.status==='confirmed'?'已确认':'草稿' }} · {{ entry.createdAt }}</h3><p>{{ entry.content.scopeNote }}</p><ul><li v-for="risk in entry.content.risks" :key="risk.key">{{ items.risks.find(item=>item.key===risk.key)?.original.title??risk.key }} · {{ risk.decision==='include'?'纳入':'排除' }} · {{ risk.reason||'未附理由' }}</li></ul><details v-for="item in entry.content.cases" :key="item.key"><summary>{{ item.decision==='include'?item.title:items.cases.find(candidate=>candidate.key===item.key)?.original.title??item.key }} · {{ item.decision==='include'?'纳入':'排除' }}</summary><ContractView v-if="item.decision==='include'" :contract="item.finalContract" /><p v-else>{{ item.reason }}</p></details></article></details>
      <RegressionExecution :regression-id="regressionId" :project-id="projectId" :target-sha="targetSha" :reviews="history" :disabled="dirty||busy||!!conflict" />
    </template>
  </section>
</template>

<style scoped>
.reg-review-columns{display:grid;grid-template-columns:minmax(180px,28%) minmax(0,1fr);gap:20px}.reg-review-columns nav{display:block}.reg-review-columns nav button{display:block;width:100%;text-align:left;margin-bottom:10px;overflow-wrap:anywhere}.selected{background:#ece9ff}small{display:block;font-size:14px}.risk-review{padding:12px 0;border-bottom:1px solid #dce1eb}.review-actions{display:flex;gap:16px;flex-wrap:wrap}.regression-review fieldset{border:1px solid #dce1eb;padding:16px;margin:16px 0;border-radius:8px}.regression-review textarea{min-height:70px}@media(max-width:800px){.reg-review-columns{grid-template-columns:1fr}}
</style>
