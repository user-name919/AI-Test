<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { ExecutionRecord } from '@quality-ai/contracts'
import CaseExecutionEvidence from './CaseExecutionEvidence.vue'
import ExecutionArtifacts from './ExecutionArtifacts.vue'
import ExecutionContractEvidence from '../../components/ExecutionContractEvidence.vue'
import SourceWorktreeNote from '../projects/SourceWorktreeNote.vue'

const route=useRoute(), router=useRouter()
const history=ref<ExecutionRecord[]>([]), report=ref<ExecutionRecord>()
const error=ref(''), actionError=ref(''), loading=ref(false), rerunning=ref(false), help=ref(false)
const labels={passed:'通过',failed:'验证失败',blocked:'受阻',infrastructure_failed:'环境或执行器中断',cancelled:'已取消',not_run:'未执行'}
const filtered=computed(()=>history.value.filter(item=>!route.query.status||item.status===route.query.status))
const passed=computed(()=>report.value?.caseResults?.filter(item=>item.status==='passed').length??0)
const rerunReason=computed(()=>{
  if(rerunning.value)return '正在创建任务，请勿重复提交'
  const item=report.value
  if(!item)return '请先打开报告'
  if(item.deploymentConfirmation||item.caseSnapshots?.some(snapshot=>snapshot.source?.type==='change_regression'))return '回归重跑须返回回归任务重新确认部署版本'
  if(!item.caseSnapshots?.length)return '历史报告没有用例版本快照，请从用例重新确认'
  if(item.mode==='plan'&&!item.plan)return '历史报告未保存固定计划'
  if(!item.mode)return '历史记录未记录执行模式'
  return ''
})
let epoch=0
async function get<T>(url:string):Promise<T>{const response=await fetch(url);const payload=await response.json();if(!response.ok)throw new Error(payload.error??`读取失败 ${response.status}`);return payload}
async function load(){
  const current=++epoch;loading.value=true;error.value='';report.value=undefined;actionError.value=''
  const id=typeof route.params.id==='string'?route.params.id:undefined
  try{
    if(id){const result=await get<{execution:ExecutionRecord}>(`/api/executions/${encodeURIComponent(id)}`);if(current===epoch)report.value=result.execution}
    else{const result=await get<{executions:ExecutionRecord[]}>('/api/executions');if(current===epoch)history.value=result.executions}
  }catch(cause){if(current===epoch)error.value=cause instanceof Error?cause.message:'读取失败'}
  finally{if(current===epoch)loading.value=false}
}
async function rerun(){
  if(rerunReason.value||!report.value)return
  if(!window.confirm('将使用已保存的用例版本创建新任务，并可能再次产生业务操作。原报告不会覆盖。确定继续？'))return
  const id=report.value.id, current=epoch
  rerunning.value=true;actionError.value=''
  try{
    const response=await fetch(`/api/executions/${encodeURIComponent(id)}/rerun-job`,{method:'POST'})
    const result=await response.json()
    if(!response.ok||!result.job?.id)throw new Error(result.error??'未能创建重跑任务')
    if(current===epoch)await router.push(`/execution-jobs/${result.job.id}`)
  }catch(cause){if(current===epoch)actionError.value=cause instanceof Error?cause.message:'重跑失败'}
  finally{rerunning.value=false}
}
watch(()=>route.params.id,()=>{void load()},{immediate:true})
onUnmounted(()=>{epoch++})
</script>
<template>
  <main class="execution-reports-page">
    <nav><RouterLink :to="{path:'/executions',query:route.query}">返回报告列表</RouterLink><RouterLink to="/execution-jobs">后台任务与实时预览</RouterLink><RouterLink to="/cases">用例资产</RouterLink><RouterLink to="/regressions">变更回归</RouterLink><RouterLink to="/versions">版本中心</RouterLink></nav>
    <header><h1>执行报告</h1><button @click="help=!help">使用指引</button><button :disabled="loading" @click="load">刷新报告</button></header>
    <section v-if="help" class="panel"><h2>如何阅读报告</h2><p>先看逐用例状态及失败原因，再展开当时确认的契约与实际证据。操作成功不等于业务通过，受阻和未执行没有通过证据。源码版本不证明环境已部署该版本。</p><p>关闭页面不会取消后台任务。实时画面请从“后台任务与实时预览”找回；历史附件缺失时保留引用和提示。重跑创建新记录，回归用例需重新确认部署版本。</p></section>
    <p v-if="loading" role="status">正在读取报告…</p><p v-if="error" role="alert">{{ error }}。未自动替换为其他报告。<button @click="load">重试读取</button></p>
    <section v-if="!route.params.id" class="panel"><h2>最近执行记录</h2><p>最多展示最近 100 条记录；筛选仅作用于这些记录。</p><label>状态筛选 <select :value="route.query.status??''" @change="router.replace({query:{...route.query,status:($event.target as HTMLSelectElement).value||undefined}})"><option value="">全部</option><option v-for="(label,status) in labels" :key="status" :value="status">{{ label }}</option></select></label><p v-if="!loading&&!error&&!filtered.length">当前筛选下没有执行记录。</p><RouterLink v-for="item in filtered" :key="item.id" class="report-row" :to="{path:`/executions/${item.id}`,query:route.query}"><strong>{{ item.name }}</strong><span>{{ labels[item.status] }} · {{ item.mode==='agent'?'动态 Agent':item.mode==='plan'?'固定计划':'历史模式未记录' }} · {{ item.startedAt }}</span></RouterLink></section>
    <article v-else-if="report" class="panel">
      <header><h2>{{ report.name }}</h2><strong>{{ labels[report.status] }}</strong></header><p>{{ report.targetUrl }}</p><p>执行 ID：{{ report.id }} · 耗时 {{ report.interruptionRecovery?'未知（服务中断）':`${report.durationMs} ms` }}</p><p v-if="report.interruptionRecovery">中断恢复时间：{{ report.interruptionRecovery.recoveredAt }}。实际起止时间未知，未自动重放业务操作。</p>
      <p v-if="report.rerunOf">独立重跑自 <RouterLink :to="`/executions/${report.rerunOf}`">原执行报告</RouterLink>，原记录未覆盖。</p>
      <p v-if="report.sourceProject">源码：{{ report.sourceProject.id }} / {{ report.sourceProject.branch||'无分支信息' }} / {{ report.sourceProject.commit||'无 SHA' }}</p><SourceWorktreeNote v-if="report.sourceProject" :worktree="report.sourceProject.worktree" />
      <section v-if="report.deploymentConfirmation"><h3>回归部署对应</h3><RouterLink :to="`/regressions/${report.deploymentConfirmation.regressionId}`">返回关联变更回归</RouterLink><p>目标 SHA：{{ report.deploymentConfirmation.targetSha }}；人工登记部署 SHA：{{ report.deploymentConfirmation.deployedSha||'未登记' }}</p><p>{{ report.deploymentConfirmation.status==='matched'?'人工登记匹配，非平台自动探测证明':'部署未匹配或未核实，不能证明目标版本已部署' }}</p><p>依据：{{ report.deploymentConfirmation.note }}</p></section>
      <p v-if="report.error" role="alert">{{ report.error }}</p><p v-if="actionError" role="alert">{{ actionError }}</p>
      <button :disabled="Boolean(rerunReason)" @click="rerun">创建独立重跑任务</button><p>{{ rerunReason||'服务端会再次检查用例版本和环境条件，不会覆盖本报告。' }}</p>
      <template v-if="report.caseResults"><h3>逐用例结果</h3><p>通过 / 已记录结果：{{ passed }} / {{ report.caseResults.length }}。选中快照：{{ report.caseSnapshots?.length??'历史未记录' }}，不将缺失结果推断为通过。</p><details v-for="result in report.caseResults" :key="result.caseKey"><summary>{{ result.title }} · {{ labels[result.status] }}</summary><p>用例：{{ result.caseKey }} · 执行指纹：{{ result.contractFingerprint }}</p><p v-if="result.error" role="alert">{{ result.error }}</p><p>通过断言：{{ result.passedAssertions.join('、')||'无' }}</p><CaseExecutionEvidence :result="result" /></details></template>
      <section v-else><h3>历史批次证据</h3><p>历史记录没有逐用例结果，不能根据成功步骤数计算用例通过率。</p><p v-if="report.agent">{{ report.agent.summary }}</p><details><summary>查看历史步骤与决策原始记录</summary><pre>{{ JSON.stringify({steps:report.steps,agent:report.agent},null,2) }}</pre></details></section>
      <ExecutionContractEvidence :snapshots="report.caseSnapshots" />
      <ExecutionArtifacts :execution="report" />
    </article>
  </main>
</template>
<style scoped>
.execution-reports-page{margin:0;width:100%;max-width:none;min-height:100vh;box-sizing:border-box;padding:24px;background:#f5f7fb;color:#202a40;font-size:16px;line-height:1.65}.execution-reports-page nav,.execution-reports-page header{display:flex;gap:18px;align-items:center;flex-wrap:wrap;margin-bottom:18px}.execution-reports-page h1,.execution-reports-page h2{margin-right:auto}.execution-reports-page p,.execution-reports-page summary{overflow-wrap:anywhere}.execution-reports-page button,.execution-reports-page select{font:inherit;padding:8px 12px}.execution-reports-page button:disabled{opacity:.55;cursor:not-allowed}.panel{background:white;border:1px solid #dce2ed;border-radius:12px;padding:20px;margin:18px 0;min-width:0}.report-row{display:flex;flex-direction:column;padding:16px 0;border-bottom:1px solid #dde2ee}.execution-reports-page details{border-bottom:1px solid #dde2ee;padding:14px 0}.execution-reports-page summary{cursor:pointer;font-weight:600}.execution-reports-page [role=alert]{background:#fff0f0;color:#a32020;padding:12px}.execution-reports-page pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:14px}@media(max-width:600px){.execution-reports-page{padding:12px}.panel{padding:14px}}
</style>
