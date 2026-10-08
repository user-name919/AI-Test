<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRouter, useRoute, onBeforeRouteLeave, onBeforeRouteUpdate } from 'vue-router'
import type { ChangeComparison, ChangeSet, LocalGitRefs, RegressionAnalysis } from '@quality-ai/contracts/regressions'
import { regressionRequest } from './api'
import ChangeSetView from './ChangeSetView.vue'
import DeploymentBaselinePicker from './DeploymentBaselinePicker.vue'

const router=useRouter();const route=useRoute()
const projects=ref<Array<{id:string;name:string;connected:boolean;error?:string}>>([])
const projectId=ref('');const mode=ref<ChangeComparison['mode']>('endpoints')
const targetRef=ref('');const baseRef=ref('');const commits=ref('')
const branches=ref<LocalGitRefs>({branches:[],truncated:false})
const preview=ref<ChangeSet>();const error=ref('');const busy=ref(false)
let requestId=crypto.randomUUID();let branchEpoch=0
const ready=computed(()=>projectId.value&&targetRef.value.trim()&&(mode.value==='selected_commits'?commits.value.trim():baseRef.value.trim()))
const unsaved=computed(()=>!preview.value&&Boolean(targetRef.value||baseRef.value||commits.value))
onBeforeRouteLeave(()=>!unsaved.value||window.confirm('范围配置尚未生成预览，离开会丢失填写内容。确定离开？'))
onBeforeRouteUpdate(to=>to.params.id==='new'||!unsaved.value||window.confirm('范围配置尚未生成预览，离开会丢失填写内容。确定离开？'))
function beforeUnload(event:BeforeUnloadEvent){if(unsaved.value){event.preventDefault();event.returnValue=''}}
onMounted(()=>window.addEventListener('beforeunload',beforeUnload))
onUnmounted(()=>{branchEpoch++;window.removeEventListener('beforeunload',beforeUnload)})
function invalidate(){ preview.value=undefined; requestId=crypto.randomUUID(); if(route.query.changeSet)void router.replace({query:{}}) }
async function loadBranches(){
  const epoch=++branchEpoch;branches.value={branches:[],truncated:false}
  if(!projectId.value)return
  try{const result=await regressionRequest<LocalGitRefs>(`/api/projects/${projectId.value}/git/refs`);if(epoch===branchEpoch)branches.value=result}
  catch(cause){if(epoch===branchEpoch)error.value=cause instanceof Error?cause.message:'读取分支失败'}
}
async function createPreview(){
  if(busy.value||!ready.value)return
  busy.value=true;error.value=''
  try{
    const comparison:ChangeComparison=mode.value==='selected_commits'?{mode:mode.value,targetRef:targetRef.value.trim(),commits:commits.value.split(/[\s,，]+/).filter(Boolean)}:{mode:mode.value,targetRef:targetRef.value.trim(),baseRef:baseRef.value.trim()}
    preview.value=(await regressionRequest<{changeSet:ChangeSet}>('/api/change-sets/preview',{projectId:projectId.value,comparison})).changeSet
    requestId=crypto.randomUUID()
    await router.replace({query:{changeSet:preview.value.id}})
  }catch(cause){error.value=cause instanceof Error?cause.message:'范围预览失败'}finally{busy.value=false}
}
async function start(){
  if(!preview.value||busy.value)return
  busy.value=true;error.value=''
  try{
    if(preview.value.status!=='frozen')preview.value=(await regressionRequest<{changeSet:ChangeSet}>(`/api/change-sets/${preview.value.id}/freeze`,{expectedHash:preview.value.factsHash})).changeSet
    // 网络失败后重试沿用同一请求 ID；避免在已创建但响应丢失时重复调用模型。
    const result=await regressionRequest<{regression:RegressionAnalysis}>('/api/regressions',{changeSetId:preview.value.id,expectedHash:preview.value.factsHash,requestId})
    await router.push(`/regressions/${result.regression.id}`)
  }catch(cause){error.value=cause instanceof Error?cause.message:'分析启动失败'}finally{busy.value=false}
}
onMounted(async()=>{
  try{
    projects.value=(await regressionRequest<{projects:typeof projects.value}>('/api/projects')).projects
    if(typeof route.query.changeSet==='string'){
      preview.value=(await regressionRequest<{changeSet:ChangeSet}>(`/api/change-sets/${encodeURIComponent(route.query.changeSet)}`)).changeSet
      projectId.value=preview.value.projectId
      const comparison=preview.value.facts.comparison
      mode.value=comparison.mode;targetRef.value=comparison.targetRef
      if(comparison.mode==='selected_commits')commits.value=comparison.commits.join('\n');else baseRef.value=comparison.baseRef
      await loadBranches()
    }
  }catch(cause){error.value=cause instanceof Error?cause.message:'加载失败'}
})
</script>

<template>
  <section class="reg-card"><h2>创建本地变更回归</h2><p>先确定比较范围，再确认冻结。这里只读本地 Git，不拉远端、不切原分支、不自动部署。</p>
    <p v-if="error" role="alert" class="reg-error">{{ error }}</p>
    <form @submit.prevent="createPreview"><fieldset :disabled="busy">
      <label>源码项目<select v-model="projectId" aria-label="源码项目" required @change="invalidate();targetRef='';baseRef='';commits='';loadBranches()"><option value="">请选择已连接项目</option><option v-for="project in projects" :key="project.id" :value="project.id" :disabled="!project.connected">{{ project.name }}{{ project.connected?'':'（未连接）' }}</option></select></label>
      <p v-if="!projects.length">尚未配置源码项目。请先在本机项目配置中登记软链或目录，再刷新本页。</p>
      <label>比较方式<select v-model="mode" aria-label="比较方式" @change="invalidate"><option value="endpoints">端点比较：基线到目标的最终变化</option><option value="merge_base">分支贡献：公共祖先到目标的变化</option><option value="selected_commits">指定提交：分别分析所选提交的 patch</option></select></label>
      <p v-if="mode==='endpoints'">适合比较上次部署到本次目标的变化。基线由你明确填写，平台不猜测主干。</p><p v-else-if="mode==='merge_base'">自动计算所选基线与目标的公共祖先，不等于两个分支当前文件直接比较。</p><p v-else>最多 50 个本地提交，用逗号或换行分隔。非连续提交不会伪装成连续范围；合并提交请改用端点比较。</p>
      <datalist id="regression-local-branches"><option v-for="branch in branches.branches" :key="branch.name" :value="branch.name">{{ branch.sha }}</option></datalist>
      <label>目标本地分支或 SHA<input v-model="targetRef" list="regression-local-branches" required placeholder="例如 feature/refactor 或完整 SHA" @input="invalidate" /></label>
      <label v-if="mode!=='selected_commits'">基线本地分支或 SHA<input v-model="baseRef" list="regression-local-branches" required placeholder="例如上次部署 SHA" @input="invalidate" /></label>
      <label v-else>指定提交 SHA<textarea v-model="commits" required rows="4" @input="invalidate" /></label>
      <DeploymentBaselinePicker v-if="mode==='endpoints'" :project-id="projectId" @adopt="sha=>{baseRef=sha;invalidate()}" />
      <p v-if="branches.truncated" class="reg-warning">仅展示前 500 个本地分支；可以手动填写其他本地分支或 SHA。</p>
      <button :disabled="busy||!ready">{{ busy?'处理中…':'预览变更范围' }}</button><span v-if="!ready"> 请先选择项目、目标和明确的比较范围。</span>
    </fieldset></form>
  </section>
  <template v-if="preview"><ChangeSetView :change-set="preview" /><section class="reg-card"><p>确认后固定当前 SHA 与差异，AI 分析会产生待人工审核的建议，不会直接执行测试。</p><button :disabled="busy" @click="start">{{ busy?'正在提交…':preview.status==='frozen'?'基于冻结范围启动分析':'确认冻结并分析' }}</button></section></template>
</template>
