<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import type { DeploymentConfirmation, RegressionReview } from '@quality-ai/contracts/regressions'
import type { CaseAsset, ExecutionJob } from '@quality-ai/contracts/cases'
import type { ExecutionCaseSnapshot, TestEnvironment } from '@quality-ai/contracts'
import WriteAuthorization from '../../components/WriteAuthorization.vue'
import ContractView from '../case-design/ContractView.vue'
import CaseReuseNote from '../../components/CaseReuseNote.vue'
import { regressionRequest } from './api'

const props=defineProps<{regressionId:string;projectId:string;targetSha:string;reviews:RegressionReview[];disabled:boolean}>()
const router=useRouter()
const confirmed=computed(()=>props.reviews.filter(item=>item.content.status==='confirmed'))
const revision=ref(0);const assets=ref<CaseAsset[]>([]);const selected=ref<string[]>([])
const environments=ref<TestEnvironment[]>([]);const environmentId=ref('');const targetUrl=ref('')
const environment=computed(()=>environments.value.find(item=>item.id===environmentId.value))
const mode=ref<'agent'|'plan'>('agent');const deployedSha=ref('');const confirmedBy=ref('');const note=ref('')
const confirmations=ref<DeploymentConfirmation[]>([]);const activeConfirmation=ref<DeploymentConfirmation>()
const preview=ref<ExecutionCaseSnapshot[]>([]);const busy=ref(false);const loading=ref(false);const error=ref('');const notice=ref('')
const authorizedWriteCaseIds=ref<string[]>([])
const writeCases=computed(()=>preview.value.map(item=>({id:item.caseId,title:item.resolved.title,operations:item.resolved.contract.writeOperations})))
const needsWriteAuthorization=computed(()=>writeCases.value.some(item=>item.operations?.length&&!authorizedWriteCaseIds.value.includes(item.id)))
watch(preview,()=>{authorizedWriteCaseIds.value=[]},{flush:'sync'})
let disposed=false;let epoch=0
const deploymentInput=computed(()=>({reviewRevision:revision.value,environmentId:environmentId.value,targetUrl:targetUrl.value.trim(),deployedSha:deployedSha.value.trim()||undefined,confirmedBy:confirmedBy.value.trim(),note:note.value.trim()}))
const input=computed(()=>({mode:mode.value,projectId:props.projectId,environmentId:environmentId.value,targetUrl:targetUrl.value.trim(),deploymentConfirmationId:activeConfirmation.value?.id,cases:assets.value.filter(item=>selected.value.includes(item.id)).map(item=>({caseId:item.id,revision:item.revision,contractFingerprint:item.resolved.contractFingerprint}))}))
const deploymentReason=computed(()=>{
  if(props.disabled)return '审核仍有未保存内容、版本冲突或正在保存，请先处理人工审核'
  if(!revision.value)return '请先确认至少一个人工审核版本'
  if(!environment.value)return '请选择已保存测试环境；没有环境时请在测试环境页配置后刷新配置'
  try{const url=new URL(targetUrl.value);if(!['http:','https:'].includes(url.protocol)||url.origin!==new URL(environment.value.baseUrl).origin)return '测试地址必须是所选环境的 HTTP(S) 地址'}catch{return '请输入完整测试页面地址'}
  if(deployedSha.value.trim()&&!/^[a-f0-9]{40,64}$/i.test(deployedSha.value.trim()))return '部署版本请填写完整 SHA；未核实时留空并在依据中说明'
  if(!confirmedBy.value.trim()||!note.value.trim())return '请填写确认人和部署核对依据；未核实也需要说明'
  return ''
})
const executionReason=computed(()=>deploymentReason.value||(!activeConfirmation.value?'请先保存本次配置的部署确认':activeConfirmation.value.status==='mismatched'?'部署 SHA 不匹配，不能执行；请核对部署或变更目标':!selected.value.length?'请勾选本次执行的用例':selected.value.length>20?'单次最多执行 20 条用例':''))
watch(deploymentInput,()=>{activeConfirmation.value=undefined;preview.value=[]},{deep:true,flush:'sync'})
watch(input,()=>{preview.value=[]},{deep:true})
watch(()=>props.disabled,()=>{preview.value=[]})
watch(confirmed,value=>{if(!value.some(item=>item.revision===revision.value))revision.value=value[0]?.revision??0},{immediate:true})
watch(revision,async value=>{
  const current=++epoch;assets.value=[];selected.value=[];preview.value=[];activeConfirmation.value=undefined
  if(!value)return
  loading.value=true;error.value=''
  try{const result=await regressionRequest<{cases:CaseAsset[]}>(`/api/cases?sourceType=change_regression&sourceId=${props.regressionId}&reviewRevision=${value}`);if(!disposed&&current===epoch)assets.value=result.cases}
  catch(cause){if(!disposed&&current===epoch)error.value=cause instanceof Error?cause.message:'读取用例失败'}
  finally{if(!disposed&&current===epoch)loading.value=false}
},{immediate:true})
async function load(){
  if(busy.value)return
  busy.value=true;error.value='';preview.value=[];activeConfirmation.value=undefined
  try{const [env,deployments]=await Promise.all([regressionRequest<{environments:TestEnvironment[]}>('/api/environments'),regressionRequest<{confirmations:DeploymentConfirmation[]}>(`/api/regressions/${props.regressionId}/deployments`)]);if(disposed)return;environments.value=env.environments;confirmations.value=deployments.confirmations}
  catch(cause){if(!disposed)error.value=cause instanceof Error?cause.message:'读取环境失败'}finally{if(!disposed)busy.value=false}
}
async function confirmDeployment(){
  if(deploymentReason.value||busy.value)return
  busy.value=true;error.value='';preview.value=[];notice.value=''
  try{const result=await regressionRequest<{confirmation:DeploymentConfirmation}>(`/api/regressions/${props.regressionId}/deployments`,deploymentInput.value);if(disposed)return;activeConfirmation.value=result.confirmation;confirmations.value=[result.confirmation,...confirmations.value];notice.value='部署确认已保存；这是人工登记，不是平台自动探测的服务器版本。'}
  catch(cause){if(!disposed)error.value=cause instanceof Error?cause.message:'保存部署确认失败'}finally{if(!disposed)busy.value=false}
}
async function prepare(){
  if(executionReason.value||busy.value||loading.value)return
  busy.value=true;error.value=''
  const request=input.value;const signature=JSON.stringify(request)
  try{const {mode,targetUrl,environmentId,deploymentConfirmationId,cases}=request;const result=await regressionRequest<{preparation:{snapshots:ExecutionCaseSnapshot[]}}>('/api/cases/prepare-execution',{mode,targetUrl,environmentId,deploymentConfirmationId,cases});if(!disposed&&signature===JSON.stringify(input.value))preview.value=result.preparation.snapshots}
  catch(cause){if(!disposed)error.value=cause instanceof Error?cause.message:'预览失败'}finally{if(!disposed)busy.value=false}
}
async function start(){
  if(executionReason.value||busy.value||!preview.value.length||needsWriteAuthorization.value)return
  busy.value=true;error.value=''
  try{const result=await regressionRequest<{job:ExecutionJob}>('/api/execution-jobs',{...input.value,authorizedWriteCaseIds:authorizedWriteCaseIds.value});if(!disposed)await router.push(`/execution-jobs/${result.job.id}`)}
  catch(cause){if(!disposed){preview.value=[];error.value=`${cause instanceof Error?cause.message:'启动失败'}。若响应丢失，先检查后台执行任务列表，避免重复执行有副作用的操作。`}}finally{authorizedWriteCaseIds.value=[];if(!disposed)busy.value=false}
}
onMounted(()=>{void load()});onUnmounted(()=>{disposed=true;epoch++})
</script>

<template>
  <section class="regression-execution" aria-label="回归部署与执行">
    <h2>部署确认与执行</h2><p>被测项目由你部署。源码固定读取 {{ projectId }} 的 {{ targetSha }}，不会读取当前编辑中的文件。</p>
    <p v-if="error" role="alert" class="reg-error">{{ error }}</p><p v-if="notice" role="status">{{ notice }}</p>
    <p v-if="!confirmed.length">尚无已确认审核版本。请先完成上方人工范围与用例确认。</p>
    <button :disabled="busy||loading" @click="load">刷新环境与部署记录</button>
    <RouterLink to="/environments">管理测试环境与登录态</RouterLink>
    <fieldset :disabled="busy||loading||disabled"><legend>选择确切审核版本和环境</legend>
      <label>执行审核版本<select v-model.number="revision" aria-label="执行审核版本"><option :value="0">请选择确认版本</option><option v-for="review in confirmed" :key="review.revision" :value="review.revision">v{{ review.revision }} · {{ review.createdAt }}</option></select></label>
      <label>回归测试环境<select v-model="environmentId" aria-label="回归测试环境" @change="targetUrl=environment?.targetUrl??''"><option value="">请选择环境</option><option v-for="env in environments" :key="env.id" :value="env.id">{{ env.name }} · {{ env.baseUrl }}</option></select></label>
      <p v-if="environment">{{ environment.hasStorageState?'已保存登录态，是否有效仍需运行验证':'没有登录态；需要登录的页面请先导入 storageState' }}</p>
      <label>回归测试地址<input v-model="targetUrl" type="url" /></label>
      <label>环境已部署 SHA（未核实可留空）<input v-model="deployedSha" placeholder="完整 SHA，不填写分支名" /></label>
      <label>部署确认人<input v-model="confirmedBy" /></label><label>部署核对依据<textarea v-model="note" rows="3" placeholder="发布记录或核对方式；未核实请说明原因与限制" /></label>
    </fieldset>
    <p>{{ deploymentReason||'可以保存部署确认；不匹配将禁止执行，未核实会在报告中持续标注。' }}</p><button :disabled="!!deploymentReason||busy||loading" @click="confirmDeployment">保存部署确认</button>
    <p v-if="activeConfirmation" :class="activeConfirmation.status==='matched'?'':'reg-warning'">{{ activeConfirmation.status==='matched'?'人工登记版本匹配（非自动探测证明）':activeConfirmation.status==='unverified'?'部署版本未核实：本次结果不能证明目标版本已经部署':'登记版本不匹配，禁止执行' }}</p>
    <fieldset :disabled="busy||loading||disabled"><legend>选择本次执行用例</legend><p v-if="!assets.length">当前版本没有纳入的回归用例。</p><label v-for="asset in assets" :key="asset.id"><input v-model="selected" type="checkbox" :value="asset.id" />{{ asset.title }}<small>{{ preview.some(item=>item.caseId===asset.id)?'本次配置已通过服务端执行预检':`预检前提示：${asset.resolved.readiness[mode].reason||'待服务端执行预览确认'}` }}</small></label><label>回归执行模式<select v-model="mode" aria-label="回归执行模式"><option value="agent">动态 Agent</option><option value="plan">固定计划</option></select></label></fieldset>
    <p>{{ executionReason||'可以预览最终口径；服务端会核验部署确认时效及每条用例的可执行性。' }}</p><button :disabled="!!executionReason||busy||loading" @click="prepare">预览回归执行口径</button>
    <section v-if="preview.length"><h3>本次冻结执行 {{ preview.length }} 条 · 审核 v{{ revision }}</h3><details v-for="snapshot in preview" :key="snapshot.caseId"><summary>{{ snapshot.resolved.title }}</summary><CaseReuseNote :source="snapshot.source" /><ContractView :contract="snapshot.resolved.contract" /><p>版本 {{ snapshot.revision }} · 指纹 {{ snapshot.resolved.contractFingerprint }}</p></details><p>相关用例共享会话，普通失败记录后继续；配置改变需要重新预览。</p><WriteAuthorization v-model="authorizedWriteCaseIds" :cases="writeCases" :target-url="targetUrl" :disabled="busy" /><button :disabled="busy||!!executionReason||disabled||needsWriteAuthorization" @click="start">确认并启动回归执行</button></section>
    <details><summary>部署确认历史（{{ confirmations.length }}）</summary><article v-for="item in confirmations" :key="item.id"><p>审核 v{{ item.reviewRevision }} · {{ item.status==='matched'?'人工登记匹配':item.status==='unverified'?'未核实':'不匹配' }} · {{ item.createdAt }}<br />环境 {{ item.environmentId }} · {{ item.targetUrl }}<br />部署 SHA {{ item.deployedSha??'未提供' }} · {{ item.confirmedBy }}<br />{{ item.note }}</p></article><p>历史仅供追溯，不自动认为旧确认仍有效。重新保存确认会使同环境旧确认失效。</p></details>
  </section>
</template>

<style scoped>
.regression-execution{margin-top:24px;border-top:2px solid #d8deec;padding-top:16px}.regression-execution fieldset{border:1px solid #d8deec;padding:16px;margin:16px 0}.regression-execution input[type=checkbox]{display:inline-block;width:auto;margin-right:10px}small{display:block;font-size:14px;font-weight:400}.regression-execution button{margin:8px 8px 8px 0}
</style>
