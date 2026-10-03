<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router'
import type { ExecutionRecord } from '@quality-ai/contracts'
import type { QualityMemory } from '@quality-ai/contracts/memories'

const memories=ref<QualityMemory[]>([]), executions=ref<ExecutionRecord[]>([])
const route=useRoute(),router=useRouter()
const selected=ref(typeof route.query.memoryId==='string'?route.query.memoryId:''), executionId=ref(''), caseKey=ref(''), lesson=ref(''), reason=ref(''), project=ref('')
watch(selected,id=>{void router.replace({query:{...route.query,memoryId:id||undefined}})})
const loading=ref(false), busy=ref(false), error=ref(''), notice=ref(''), help=ref(false)
const labels={candidate:'待审核',adopted:'已采纳',invalid:'已失效'}
const resultLabels={passed:'通过',failed:'验证失败',blocked:'受阻',cancelled:'取消',not_run:'未执行',infrastructure_failed:'执行中断'}
const current=computed(()=>memories.value.find(item=>item.id===selected.value))
const execution=computed(()=>executions.value.find(item=>item.id===executionId.value))
const projects=computed(()=>[...new Set(memories.value.flatMap(item=>item.scope.projectId?[item.scope.projectId]:[]))])
const visible=computed(()=>memories.value.filter(item=>!project.value||item.scope.projectId===project.value))
const dirty=computed(()=>Boolean(lesson.value.trim()||reason.value.trim()))
async function request<T>(url:string,body?:unknown):Promise<T>{
  const response=await fetch(url,body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:undefined)
  const data=await response.json()
  if(!response.ok)throw new Error(data.error??'请求失败，请重试')
  return data
}
async function refresh(){
  if(loading.value||busy.value)return
  loading.value=true;error.value=''
  try{
    const [items,reports]=await Promise.all([request<{memories:QualityMemory[]}>('/api/memories'),request<{executions:ExecutionRecord[]}>('/api/executions')])
    memories.value=items.memories;executions.value=reports.executions
  }catch(cause){error.value=cause instanceof Error?cause.message:'读取失败'}
  finally{loading.value=false}
}
async function save(){
  if(busy.value||!executionId.value||!lesson.value.trim())return
  if(reason.value.trim()&&!window.confirm('当前审核理由尚未提交，保存新经验后将切换记录并放弃该理由。继续？'))return
  busy.value=true;error.value=''
  try{
    const {memory}=await request<{memory:QualityMemory}>('/api/memories',{executionId:executionId.value,caseKey:caseKey.value||undefined,lesson:lesson.value})
    memories.value.unshift(memory);selected.value=memory.id;project.value='';lesson.value='';reason.value=''
    notice.value='经验已保存为待审核，不代表原测试通过。'
  }catch(cause){error.value=cause instanceof Error?cause.message:'保存失败'}
  finally{busy.value=false}
}
function select(id:string){
  if(busy.value)return
  if(reason.value.trim()&&!window.confirm('审核理由尚未提交，放弃理由并切换？'))return
  reason.value='';selected.value=id
}
async function review(status:'adopted'|'invalid'){
  if(busy.value||!current.value||!reason.value.trim())return
  const item=current.value
  busy.value=true;error.value=''
  try{
    const {memory}=await request<{memory:QualityMemory}>(`/api/memories/${item.id}/review`,{expectedRevision:item.revision,status,reason:reason.value})
    memories.value=memories.value.map(value=>value.id===item.id?memory:value);reason.value=''
    notice.value=`已${status==='adopted'?'采纳':'标记失效'}，原报告未改动。`
  }catch(cause){error.value=cause instanceof Error?cause.message:'审核失败'}
  finally{busy.value=false}
}
function protect(event:BeforeUnloadEvent){if(dirty.value||busy.value){event.preventDefault();event.returnValue=''}}
onBeforeRouteLeave(()=>busy.value?false:!dirty.value||window.confirm('经验或审核理由尚未保存。取消可留在此页继续保存，确认将放弃草稿离开。'))
onMounted(()=>{void refresh();window.addEventListener('beforeunload',protect)})
onBeforeUnmount(()=>window.removeEventListener('beforeunload',protect))
</script>
<template>
  <main class="memories-page">
    <nav><RouterLink to="/versions">返回版本中心</RouterLink><RouterLink to="/executions">执行报告</RouterLink><RouterLink to="/case-designs">用例设计</RouterLink></nav>
    <header><h1>质量记忆</h1><button @click="help=!help">使用指引</button><button :disabled="loading||busy" @click="refresh">刷新来源与记忆</button></header>
    <section v-if="help"><h2>如何沉淀经验</h2><ol><li>选择已保存的执行报告，可进一步指定一条用例；查看原报告后填写经验。</li><li>经验先保存为待审核。选择左侧记录，核对项目、页面、SHA和原结论，再填写理由采纳。</li><li>页面或规则改变后标记失效。经验是参考，不证明当前页面通过，也不能替代真实DOM验证。</li></ol><p>后台执行任务只引用已采纳、项目和完整目标地址及源码SHA一致，且两次源码工作区均记录为干净的最近5条经验。跨版本、未知或脏工作区不自动引用；已确认固定计划不重新生成。报告保留本次提供给模型的版本，不代表模型已采纳。旧页面PRD规则并非已审核记忆，原需求和历史报告仍在各自入口。</p></section>
    <p v-if="error" role="alert" class="error">{{ error }}（草稿仍保留，可重试；版本冲突时先刷新。）</p>
    <p v-if="notice" role="status">{{ notice }} <button @click="notice=''">关闭提示</button></p>
    <section><h2>登记执行经验</h2>
      <label>来源报告<select v-model="executionId" :disabled="busy" @change="caseKey=''"><option value="">请选择报告（最近100条）</option><option v-for="item in executions" :key="item.id" :value="item.id">{{ item.name }} · {{ item.startedAt }} · {{ resultLabels[item.status] }}</option></select></label>
      <template v-if="execution"><RouterLink :to="`/executions/${execution.id}`">查看来源完整报告</RouterLink><label>来源用例<select v-model="caseKey" :disabled="busy"><option value="">整批执行</option><option v-for="item in execution.caseResults" :key="item.caseKey" :value="item.caseKey">{{ item.title }} · {{ resultLabels[item.status] }}</option></select></label><p>项目：{{ execution.projectId??execution.sourceProject?.id??'未知，不推断跨项目适用' }} · 页面：{{ execution.targetUrl }}</p></template>
      <label>人工经验<textarea v-model="lesson" :disabled="busy" maxlength="4000" rows="3" placeholder="说明观察到的问题、适用条件与建议，不将失败直接认定为产品缺陷"></textarea></label>
      <button :disabled="busy||!executionId||!lesson.trim()" @click="save">保存为待审核</button><p>必须选择来源并填写经验；保存失败不清空内容。来源事实不可编辑。</p>
    </section>
    <section><label>筛选适用项目<select v-model="project"><option value="">全部项目（含未知）</option><option v-for="id in projects" :key="id">{{ id }}</option></select></label><p v-if="loading">正在读取…</p>
      <div class="master-detail"><aside><h2>经验记录（{{ visible.length }}）</h2><p v-if="!visible.length">暂无符合条件的记忆。</p><button v-for="item in visible" :key="item.id" :aria-pressed="selected===item.id" :disabled="busy" @click="select(item.id)">{{ labels[item.status] }} · {{ item.source.title }}<br>{{ item.lesson }}</button></aside>
        <article v-if="current"><h2>{{ current.source.title }} · {{ labels[current.status] }}</h2><p class="lesson">{{ current.lesson }}</p><p>人工经验 · 审核版本 {{ current.revision }} · {{ current.createdAt }}</p><p>原执行结论：{{ resultLabels[current.source.status] }}（采纳经验不修改此结论）</p><p v-if="current.source.error">原原因：{{ current.source.error }}</p><p>适用项目：{{ current.scope.projectId??'未知，不自动跨项目复用' }}</p><p>来源页面：{{ current.scope.targetUrl }}</p><p>源码分支：{{ current.scope.sourceProject?.branch??'未记录' }} · SHA：{{ current.scope.sourceProject?.commit??'未记录' }}</p><p>源码版本不证明测试环境部署版本。适用性仍需人工核对。</p><RouterLink :to="`/executions/${current.source.executionId}`">查看原始执行证据</RouterLink>
          <label>审核理由<textarea v-model="reason" :disabled="busy" rows="3" maxlength="2000"></textarea></label><button :disabled="busy||!reason.trim()" @click="review('adopted')">采纳经验</button> <button :disabled="busy||!reason.trim()" @click="review('invalid')">标记失效</button><p>必须填写理由。重复采纳也会记录新审核，不会覆盖原历史。</p>
          <details><summary>审核历史（{{ current.reviews.length }}）</summary><p v-for="entry in current.reviews" :key="entry.revision">v{{ entry.revision }} · {{ labels[entry.status] }} · {{ entry.at }}<br>{{ entry.reason }}</p></details>
        </article><article v-else>选择左侧记录查看来源、范围与审核历史。</article>
      </div>
    </section>
  </main>
</template>
<style scoped>
.memories-page{margin-left:0;width:100%;padding:24px;box-sizing:border-box;background:#f5f7fb;color:#202a40;font-size:16px;line-height:1.65;min-height:100vh}nav,header{display:flex;align-items:center;gap:16px;flex-wrap:wrap}h1{margin-right:auto}h2{font-size:21px}section{background:#fff;border:1px solid #d7ddea;border-radius:10px;padding:20px;margin-top:16px}label{display:block;margin:12px 0}select,textarea{display:block;width:100%;padding:9px;margin-top:6px;box-sizing:border-box;font:inherit}button{font:inherit;padding:8px 12px;cursor:pointer;max-width:100%}button:disabled{opacity:.55;cursor:not-allowed}.master-detail{display:grid;grid-template-columns:minmax(230px,30%) minmax(0,1fr);gap:24px;margin-top:16px}aside button{display:block;width:100%;text-align:left;white-space:normal;overflow-wrap:anywhere;margin-bottom:10px}button[aria-pressed=true]{background:#eeeaff;border-color:#5545db}article,aside{min-width:0}p,.lesson{overflow-wrap:anywhere;white-space:pre-wrap}.error{background:#fff0f0;color:#9e2525;padding:12px}summary{cursor:pointer;padding:10px 0}@media(max-width:760px){.memories-page{padding:12px}.master-detail{grid-template-columns:1fr}section{padding:14px}}
</style>
