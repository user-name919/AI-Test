<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import type { ExecutionJob } from '@quality-ai/contracts/cases'
import type { ExecutionRecord, LiveExecutionEvent } from '@quality-ai/contracts'
import ContractView from '../case-design/ContractView.vue'
import ExecutionArtifacts from './ExecutionArtifacts.vue'
import CaseExecutionEvidence from './CaseExecutionEvidence.vue'

const route=useRoute()
const jobs=ref<ExecutionJob[]>([])
const job=ref<ExecutionJob>()
const report=ref<ExecutionRecord>()
const events=ref<Array<{sequence:number;event:LiveExecutionEvent}>>([])
const frame=ref<Extract<LiveExecutionEvent,{type:'browser_frame'}>>()
const error=ref('')
const actionError=ref('')
const preview=ref(true)
const help=ref(false)
const cancelling=ref(false)
let cursor=0
let generation=0
let busyEpoch:number|undefined
let timer:ReturnType<typeof setTimeout>|undefined
const names:Record<ExecutionJob['status'],string>={queued:'排队中',running:'执行中',cancelling:'正在取消',completed:'运行结束（请查看用例结果）',failed:'任务失败',cancelled:'已取消',interrupted:'服务中断'}
const resultNames={passed:'通过',failed:'验证失败',blocked:'受阻',infrastructure_failed:'环境或执行器中断',cancelled:'已取消',not_run:'未执行'}
const activities=computed(()=>{
  const all=new Map<string,Extract<LiveExecutionEvent,{type:'activity'}>>()
  for(const {event} of events.value)if(event.type==='activity')all.set(`${event.caseKey??''}:${event.activity.id}`,event)
  return [...all.values()]
})
const passed=computed(()=>report.value?.caseResults?.filter(item=>item.status==='passed').length??0)
const verified=computed(()=>report.value?.caseResults?.filter(item=>item.status==='passed'||item.status==='failed').length??0)
async function request<T>(path:string,method='GET'):Promise<T>{
  const response=await fetch(path,{method})
  const payload=await response.json()
  if(!response.ok)throw new Error(payload.error??`请求失败 ${response.status}`)
  return payload
}
async function refresh(epoch=generation){
  if(busyEpoch===epoch)return
  busyEpoch=epoch
  clearTimeout(timer)
  const id=typeof route.params.id==='string'?route.params.id:''
  try{
    if(!id){
      const payload=await request<{jobs:ExecutionJob[]}>('/api/execution-jobs')
      if(epoch!==generation)return
      jobs.value=payload.jobs
    }else{
      const payload=await request<{job:ExecutionJob}>(`/api/execution-jobs/${encodeURIComponent(id)}`)
      if(epoch!==generation)return
      job.value=payload.job
      const history=await request<{events:typeof events.value;nextCursor:number;frame:typeof frame.value}>(`/api/execution-jobs/${encodeURIComponent(id)}/events?after=${cursor}`)
      if(epoch!==generation)return
      events.value.push(...history.events)
      cursor=history.nextCursor
      frame.value=history.frame
      if(payload.job.executionId&&!report.value){
        const result=await request<{execution:ExecutionRecord}>(`/api/executions/${payload.job.executionId}`)
        if(epoch!==generation)return
        report.value=result.execution
      }
    }
    error.value=''
  }catch(cause){if(epoch===generation)error.value=cause instanceof Error?cause.message:'加载失败'}
  finally{if(busyEpoch===epoch)busyEpoch=undefined;if(epoch===generation)timer=setTimeout(()=>{void refresh(epoch)},1500)}
}
async function cancel(){
  if(!job.value||cancelling.value)return
  if(!window.confirm('确定取消？已提交的业务操作不会自动回滚。'))return
  const id=job.value.id;const epoch=generation
  cancelling.value=true
  actionError.value=''
  try{
    const payload=await request<{job:ExecutionJob}>(`/api/execution-jobs/${id}/cancel`,'POST')
    if(epoch===generation)job.value=payload.job
  }catch(cause){if(epoch===generation)actionError.value=cause instanceof Error?cause.message:'取消失败'}
  finally{if(epoch===generation)cancelling.value=false}
}
watch(()=>route.params.id,()=>{
  generation++;cursor=0;events.value=[];frame.value=undefined;job.value=undefined;report.value=undefined;error.value='';actionError.value='';cancelling.value=false
  void refresh(generation)
},{immediate:true})
onUnmounted(()=>{generation++;clearTimeout(timer)})
</script>

<template>
  <main class="execution-jobs-page">
    <nav><RouterLink to="/execution-jobs">返回任务列表</RouterLink><RouterLink to="/executions">历史执行报告</RouterLink><RouterLink to="/case-designs">用例设计</RouterLink><RouterLink to="/cases">用例资产</RouterLink></nav>
    <header><h1>后台执行任务</h1><button @click="help=!help">使用指引</button><button @click="refresh()">刷新状态</button></header>
    <section v-if="help" class="panel"><h2>如何查看执行</h2><p>任务在服务端运行，关闭此页或预览不会取消。保存当前地址即可刷新找回；取消需单独点击按钮。操作历史保留每一步，开始和结果合并在同一条记录中，不强制滚动。</p><p>运行结束不等于所有用例通过。请查看逐用例结果；“未执行”没有验证证据。预览显示最近一帧及采集时间，不表示页面还在运行。</p></section>
    <p v-if="error" role="alert" class="error">{{ error }} · 查询失败不代表后台任务停止，可点击刷新重试。</p>
    <p v-if="actionError" role="alert" class="error">{{ actionError }}</p>
    <section v-if="!route.params.id" class="panel">
      <h2>任务列表</h2><p v-if="!jobs.length">尚无持久执行任务。</p>
      <RouterLink v-for="item in jobs" :key="item.id" class="job-row" :to="`/execution-jobs/${item.id}`"><strong>{{ item.snapshots[0]?.resolved.title??item.id }}</strong><span>{{ names[item.status] }} · {{ item.snapshots.length }} 条 · {{ item.createdAt }}</span></RouterLink>
    </section>
    <template v-else-if="job">
      <p v-if="job.rerunOf">本次是独立重跑，原结果不变。<RouterLink :to="`/executions/${job.rerunOf}`">查看原执行报告</RouterLink></p>
      <section class="panel"><h2>{{ job.snapshots[0]?.resolved.title }} · {{ job.snapshots.length }} 条用例</h2><p>{{ names[job.status] }} · {{ job.mode==='agent'?'动态 Agent':'固定计划' }} · 最近更新 {{ job.updatedAt }}</p><p>{{ job.targetUrl }}</p><p>源码：{{ job.sourceProject ? `${job.sourceProject.id} / ${job.sourceProject.branch??'未知分支'} / ${job.sourceProject.commit??'未记录 SHA'}`:'未关联源码' }}</p><p v-if="job.error" class="error">{{ job.error }}</p><button :disabled="cancelling||!['queued','running'].includes(job.status)" @click="cancel">取消执行</button><span v-if="job.status==='cancelling'"> 已请求取消，等待执行器及当前请求收尾。</span></section>
      <section v-if="job.deploymentConfirmation" class="panel" aria-label="回归版本对应">
        <h2>回归版本对应 · 人工审核 v{{ job.deploymentConfirmation.reviewRevision }}</h2>
        <RouterLink :to="`/regressions/${job.deploymentConfirmation.regressionId}`">返回回归范围、审核与变更依据</RouterLink>
        <p :class="{error:job.deploymentConfirmation.status!=='matched'}">{{ job.deploymentConfirmation.status==='matched'?'人工登记匹配（非自动探测证明）':job.deploymentConfirmation.status==='unverified'?'部署版本未核实：本次结果不能证明目标版本已经部署':'部署版本不匹配' }}</p>
        <p>冻结源码 SHA：{{ job.deploymentConfirmation.targetSha }}<br />人工登记部署 SHA：{{ job.deploymentConfirmation.deployedSha??'未提供' }}</p>
        <p>确认人：{{ job.deploymentConfirmation.confirmedBy }} · {{ job.deploymentConfirmation.createdAt }}<br />依据：{{ job.deploymentConfirmation.note }}</p>
        <p>回归任务：{{ job.deploymentConfirmation.regressionId }}<br />变更范围：{{ job.deploymentConfirmation.changeSetId }}</p>
        <p>以下信息保留创建任务时的记录，不随新部署确认更新。失败关联此变更范围，不代表已确定由某个提交引入。</p>
      </section>
      <div class="execution-columns">
        <div class="operation-panel panel"><h2>完整操作历史（{{ activities.length }} 步）</h2><p v-if="!activities.length">尚无浏览器操作。任务可能正在排队或生成计划。</p><ol><li v-for="item in activities" :key="`${item.caseKey}:${item.activity.id}`"><strong>{{ item.caseTitle??'执行准备' }} · {{ item.activity.title }}</strong><p>{{ item.activity.purpose }}</p><p>{{ item.activity.status==='running'&&['completed','cancelled','failed','interrupted'].includes(job.status)?'未收到该操作的完成事件':item.activity.status }} · {{ item.activity.message }}</p><details><summary>技术动作与定位依据</summary><code>{{ item.activity.technicalAction }}</code><p>DOM 快照：{{ item.activity.snapshotId??'未记录' }}</p></details></li></ol></div>
        <aside class="panel preview-panel"><h2>Playwright 画面</h2><button @click="preview=!preview">{{ preview?'关闭预览':'重新打开预览' }}</button><template v-if="preview"><p>最近采集：{{ frame?.capturedAt??'尚未收到画面' }}</p><img v-if="frame" :src="frame.dataUrl" alt="Playwright 最近页面画面" /><p>画面连接与执行状态相互独立；关闭预览不会取消任务。</p></template></aside>
      </div>
      <section class="panel"><h2>逐用例结果</h2><p v-if="report">通过 / 选中总数：{{ passed }} / {{ job.snapshots.length }}；已完成验证通过率：{{ verified?`${Math.round(passed/verified*100)}%`:'暂无' }}（仅 passed + failed，{{ verified }} 条）</p><p v-else>暂无最终浏览器报告，以下是任务创建时冻结的用例，不表示已通过。</p>
        <details v-for="snapshot in job.snapshots" :key="snapshot.caseId" class="case-result"><summary>{{ snapshot.resolved.title }} · {{ report?.caseResults?.find(item=>item.caseKey===snapshot.resolved.caseKey) ? resultNames[report.caseResults.find(item=>item.caseKey===snapshot.resolved.caseKey)!.status] : '尚无最终结果' }}</summary><p>资产版本 {{ snapshot.revision }} · 指纹 {{ snapshot.resolved.contractFingerprint }}</p><p v-if="snapshot.source?.type==='case_design'">设计发布 v{{ snapshot.source.publicationVersion }} · {{ snapshot.source.publicationId }}</p><ContractView :contract="snapshot.resolved.contract" /><template v-for="result in report?.caseResults?.filter(item=>item.caseKey===snapshot.resolved.caseKey)??[]" :key="result.caseKey"><p v-if="result.error" class="error">{{ result.error }}</p><p>起始页面：{{ result.startedFromUrl||'未开始' }} · 快照：{{ result.startedFromSnapshotId??'无' }}</p><p>通过断言：{{ result.passedAssertions.join('、')||'无' }}</p><CaseExecutionEvidence :result="result" /></template></details>
        <RouterLink v-if="job.executionId" :to="`/executions/${job.executionId}`">查看完整报告与附件入口</RouterLink>
        <ExecutionArtifacts v-if="report" :execution="report" />
      </section>
    </template>
  </main>
</template>

<style scoped>
.execution-jobs-page{margin-left:0}
.execution-jobs-page{display:block;width:100%;max-width:none;padding:24px;box-sizing:border-box;font-size:16px;color:#202a40;background:#f5f7fb;min-height:100vh}.execution-jobs-page nav,.execution-jobs-page header{display:flex;flex-wrap:wrap;align-items:center;gap:18px;margin-bottom:20px}.execution-jobs-page h1{margin-right:auto}.execution-jobs-page h2{font-size:20px}.execution-jobs-page button{font-size:16px;padding:10px 14px;cursor:pointer}.execution-jobs-page button:disabled{cursor:not-allowed;opacity:.6}.panel{background:white;border:1px solid #d9dfec;border-radius:12px;padding:20px;margin-bottom:20px;min-width:0}.panel p,.case-result{overflow-wrap:anywhere;line-height:1.7}.job-row{display:flex;gap:20px;flex-wrap:wrap;padding:16px 0;border-bottom:1px solid #dde2ee}.execution-columns{display:grid;grid-template-columns:minmax(0,1.3fr) minmax(300px,1fr);gap:20px}.operation-panel{max-height:650px;overflow:auto}.operation-panel li{padding:14px 4px;border-bottom:1px solid #ddd}.preview-panel img{width:100%;display:block}.error{color:#a72020;background:#fff1f1;padding:12px;white-space:pre-wrap}.case-result{padding:16px 0;border-bottom:1px solid #ddd}.case-result summary{cursor:pointer;font-weight:600}.execution-jobs-page pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:14px}.execution-jobs-page code{overflow-wrap:anywhere}@media(max-width:800px){.execution-jobs-page{padding:12px}.execution-columns{grid-template-columns:1fr}}
</style>
