<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import type { DesignPublication } from '@quality-ai/contracts/case-design'
import type { CaseAsset, ExecutionJob } from '@quality-ai/contracts/cases'
import type { TestEnvironment, ExecutionCaseSnapshot } from '@quality-ai/contracts'
import ContractView from '../case-design/ContractView.vue'
const props=defineProps<{publication:DesignPublication}>()
const router=useRouter()
const open=ref(false),loading=ref(false),busy=ref(false)
const error=ref('')
const assets=ref<CaseAsset[]>([])
const selected=ref<string[]>([])
const mode=ref<'agent'|'plan'>('agent')
const targetUrl=ref('')
const environment=ref<TestEnvironment|null>(null)
const useEnvironment=ref(false)
const projects=ref<Array<{id:string;name:string;connected:boolean;targetOrigins:string[];branch?:string;commit?:string}>>([])
const projectId=ref('')
const preview=ref<ExecutionCaseSnapshot[]>([])
let disposed=false
onUnmounted(()=>{disposed=true})
async function request<T>(path:string,body?:unknown):Promise<T>{
  const response=await fetch(path,body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:undefined)
  const result=await response.json()
  if(!response.ok)throw new Error(result.error??`请求失败 ${response.status}`)
  return result
}
const input=computed(()=>({mode:mode.value,targetUrl:targetUrl.value.trim(),cases:assets.value.filter(asset=>selected.value.includes(asset.id)).map(asset=>({caseId:asset.id,revision:asset.revision,contractFingerprint:asset.resolved.contractFingerprint})),...(useEnvironment.value&&environment.value?{environmentId:environment.value.id}:{}),...(projectId.value?{projectId:projectId.value}:{})}))
const reason=computed(()=>{
  if(loading.value)return '正在读取服务端契约与执行配置'
  if(!selected.value.length)return '请勾选至少一条用例'
  if(selected.value.length>20)return '单次最多选择 20 条用例'
  for(const asset of assets.value.filter(item=>selected.value.includes(item.id)))if(!asset.resolved.readiness[mode.value].executable)return `${asset.title}：${asset.resolved.readiness[mode.value].reason??'尚未就绪'}`
  let origin:string
  try{const url=new URL(targetUrl.value);if(!['http:','https:'].includes(url.protocol))return '测试地址只允许 HTTP(S)';origin=url.origin}catch{return '请输入完整测试页面地址'}
  if(useEnvironment.value&&environment.value&&new URL(environment.value.baseUrl).origin!==origin)return '测试地址与所选环境 Origin 不一致；更换地址或取消使用该登录态'
  const project=projects.value.find(item=>item.id===projectId.value)
  if(mode.value==='agent'&&!project)return '动态 Agent 需要选择源码项目'
  if(project&&(!project.connected||(project.targetOrigins.length&&!project.targetOrigins.includes(origin))))return '所选源码未连接或不允许该测试地址'
  return ''
})
watch(input,()=>{preview.value=[]})
async function configure(){
  open.value=true;loading.value=true;error.value=''
  try{
    const [loaded,env,projectList]=await Promise.all([
      Promise.all(props.publication.snapshot.cases.map(item=>request<{asset:CaseAsset}>(`/api/cases/${encodeURIComponent(`published:${props.publication.id}:${item.id}`)}/contract`))),
      request<{environment:TestEnvironment|null}>('/api/environments/latest'),request<{projects:typeof projects.value}>('/api/projects'),
    ])
    if(disposed)return
    assets.value=loaded.map(item=>item.asset);environment.value=env.environment;projects.value=projectList.projects
    selected.value=[];preview.value=[]
    if(environment.value){targetUrl.value=environment.value.targetUrl;useEnvironment.value=true}
  }catch(cause){if(!disposed)error.value=cause instanceof Error?cause.message:'执行配置读取失败'}
  finally{if(!disposed)loading.value=false}
}
async function prepare(){
  if(reason.value||busy.value)return
  busy.value=true;error.value=''
  const requested=input.value;const signature=JSON.stringify(requested)
  try{
    const {mode,targetUrl,cases}=requested
    const result=await request<{preparation:{snapshots:ExecutionCaseSnapshot[]}}>('/api/cases/prepare-execution',{mode,targetUrl,cases})
    if(!disposed&&JSON.stringify(input.value)===signature)preview.value=result.preparation.snapshots
  }catch(cause){if(!disposed)error.value=cause instanceof Error?cause.message:'准备失败'}
  finally{if(!disposed)busy.value=false}
}
async function start(){
  if(reason.value||!preview.value.length||busy.value)return
  busy.value=true;error.value=''
  try{
    const result=await request<{job:ExecutionJob}>('/api/execution-jobs',input.value)
    if(!disposed)await router.push(`/execution-jobs/${result.job.id}`)
  }catch(cause){if(!disposed)error.value=cause instanceof Error?cause.message:'启动失败'}
  finally{if(!disposed)busy.value=false}
}
</script>
<template>
  <section class="publication-execution">
    <button v-if="!open" @click="configure">配置并执行此发布版本</button>
    <template v-else>
      <h3>执行发布 v{{ publication.version }}（不会使用未发布的编辑）</h3>
      <p>先选择用例和环境，再预览服务端执行口径。发布后的设计版本不会因后续人工编辑而改变。</p>
      <p v-if="error" role="alert" class="error">{{ error }}</p>
      <button :disabled="loading||busy" @click="configure">重新读取配置</button>
      <fieldset :disabled="busy||loading"><legend>选择本次用例</legend><label v-for="asset in assets" :key="asset.id" class="case-choice"><input v-model="selected" type="checkbox" :value="asset.id" />{{ asset.title }}<span>{{ asset.resolved.readiness[mode].executable?'可执行':asset.resolved.readiness[mode].reason }}</span></label></fieldset>
      <fieldset :disabled="busy||loading"><legend>执行设置</legend>
        <label>执行模式<select v-model="mode" aria-label="执行模式"><option value="agent">动态 Agent</option><option value="plan">固定计划</option></select></label>
        <label>测试页面地址<input v-model="targetUrl" aria-label="测试页面地址" type="url" placeholder="https://测试环境/目标页面" /></label>
        <label v-if="environment"><input v-model="useEnvironment" type="checkbox" />使用最近环境「{{ environment.name }}」 · {{ environment.hasStorageState?'已有登录态（有效性需运行验证）':'未配置登录态' }}</label>
        <p v-else>尚无已保存环境，可输入公开测试地址。需要登录时，请先在原工作台配置环境和 storageState。</p>
        <label>源码项目<select v-model="projectId" aria-label="源码项目"><option value="">不选择（固定计划可选）</option><option v-for="project in projects" :key="project.id" :value="project.id">{{ project.name }} · {{ project.branch??'未知分支' }} · {{ project.commit??'未记录 SHA' }}</option></select></label>
      </fieldset>
      <p>{{ reason||'配置条件满足，可预览；服务端启动时仍会重新校验版本和环境。' }}</p>
      <button :disabled="!!reason||busy" @click="prepare">预览最终执行口径</button>
      <div v-if="preview.length"><h4>本次执行 {{ preview.length }} 条</h4><details v-for="snapshot in preview" :key="snapshot.caseId"><summary>{{ snapshot.resolved.title }}</summary><ContractView :contract="snapshot.resolved.contract" /><p v-for="question in snapshot.resolved.resolvedQuestions" :key="question.questionKey">关联人工决定：{{ question.finalStatement }}</p><p>版本 {{ snapshot.revision }} · 指纹 {{ snapshot.resolved.contractFingerprint }}</p></details><p>共享浏览器会话；普通失败记录后继续。启动后可关闭页面，在后台执行任务中找回。</p><button :disabled="!!reason||busy" @click="start">{{ busy?'正在提交…':'确认口径并启动后台执行' }}</button></div>
      <button :disabled="busy" @click="open=false">收起执行配置</button>
    </template>
  </section>
</template>
<style scoped>
.publication-execution{margin:20px 0;padding:16px;background:#f5f6ff;border:1px solid #d4d9ef;border-radius:8px;font-size:16px;overflow-wrap:anywhere}fieldset{border:1px solid #b7bfd2;margin:16px 0;min-width:0}label{display:block;margin:12px 0;line-height:1.6}label>select,label>input[type=url]{display:block;width:100%;min-width:0;padding:8px;font:inherit}button{font:inherit;padding:10px 14px;margin:8px 8px 8px 0;border:1px solid #929db6;border-radius:6px;background:white;cursor:pointer}button:disabled{opacity:.55;cursor:not-allowed}.case-choice span{display:block;margin-left:24px;color:#586176;font-size:14px}.error{color:#9e2525;background:#fff0f0;padding:12px}summary{cursor:pointer;padding:10px 0}
</style>
