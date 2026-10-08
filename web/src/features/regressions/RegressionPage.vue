<script setup lang="ts">
import { onUnmounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import type { ChangeSet, RegressionAnalysis } from '@quality-ai/contracts/regressions'
import NewRegression from './NewRegression.vue'
import ChangeSetView from './ChangeSetView.vue'
import RegressionReview from './RegressionReview.vue'
import ContractView from '../case-design/ContractView.vue'
import { regressionRequest } from './api'
import WorktreeStatus from './WorktreeStatus.vue'

const route=useRoute()
const list=ref<Array<Omit<RegressionAnalysis,'sourceImpact'|'generation'> & {completedBatches:number;analyzedTrees:number}>>([])
const ranges=ref<Array<Omit<ChangeSet,'facts'> & {targetSha:string;fileCount:number}>>([])
const analysis=ref<RegressionAnalysis>();const changeSet=ref<ChangeSet>()
const error=ref('');const actionError=ref('');const help=ref(false);const cancelling=ref(false)
const statusNames={queued:'排队中',running:'分析中',completed:'分析完成（审核状态见人工范围）',failed:'分析失败，已保存部分成果',cancelled:'已取消',interrupted:'服务中断'}
const stageNames={source:'读取源码影响线索',generating:'生成风险与回归建议',finished:'阶段处理结束'}
const levels={high:'高',medium:'中',low:'低'}
let epoch=0;let busyEpoch:number|undefined;let timer:ReturnType<typeof setTimeout>|undefined
async function refresh(current=epoch){
  if(busyEpoch===current)return
  busyEpoch=current;clearTimeout(timer)
  const id=typeof route.params.id==='string'?route.params.id:''
  try{
    if(!id){
      const [tasks,changes]=await Promise.all([regressionRequest<{regressions:typeof list.value}>('/api/regressions'),regressionRequest<{changeSets:typeof ranges.value}>('/api/change-sets')])
      if(current!==epoch)return
      list.value=tasks.regressions;ranges.value=changes.changeSets
    }else if(id!=='new'){
      const payload=await regressionRequest<{regression:RegressionAnalysis}>(`/api/regressions/${encodeURIComponent(id)}`)
      if(current!==epoch)return
      analysis.value=payload.regression
      if(changeSet.value?.id!==payload.regression.changeSetId){
        const range=await regressionRequest<{changeSet:ChangeSet}>(`/api/change-sets/${payload.regression.changeSetId}`)
        if(current!==epoch)return
        changeSet.value=range.changeSet
      }
    }
    error.value=''
  }catch(cause){if(current===epoch)error.value=cause instanceof Error?cause.message:'加载失败'}
  finally{
    if(busyEpoch===current)busyEpoch=undefined
    if(current===epoch&&id!=='new'&&(!id||error.value||analysis.value&&['queued','running'].includes(analysis.value.status)))timer=setTimeout(()=>{void refresh(current)},2000)
  }
}
async function cancel(){
  if(!analysis.value||cancelling.value)return
  if(!window.confirm('取消分析？已完成的源码依据和建议会保留。'))return
  const id=analysis.value.id;const current=epoch;cancelling.value=true;actionError.value=''
  try{const payload=await regressionRequest<{regression:RegressionAnalysis}>(`/api/regressions/${id}/cancel`,{});if(current===epoch)analysis.value=payload.regression}
  catch(cause){if(current===epoch)actionError.value=cause instanceof Error?cause.message:'取消失败'}
  finally{if(current===epoch)cancelling.value=false}
}
watch(()=>route.params.id,()=>{epoch++;analysis.value=undefined;changeSet.value=undefined;error.value='';actionError.value='';cancelling.value=false;void refresh(epoch)},{immediate:true})
onUnmounted(()=>{epoch++;clearTimeout(timer)})
</script>

<template>
  <main class="regression-page">
    <nav aria-label="变更回归导航"><RouterLink to="/regressions">返回回归任务列表</RouterLink><RouterLink to="/case-designs">用例设计</RouterLink><RouterLink to="/execution-jobs">后台执行任务</RouterLink><RouterLink to="/versions">版本中心</RouterLink></nav>
    <header><h1>代码变更回归</h1><button @click="help=!help">使用指引</button><button v-if="route.params.id!=='new'" @click="refresh()">刷新状态</button></header>
    <section v-if="help" class="reg-card"><h2>如何回归一次重构</h2><ol><li>选择已配置的本地项目、目标分支和明确基线，或指定相关提交。</li><li>检查差异、未选提交与未提交内容提示，确认冻结 SHA 后启动分析。</li><li>源码只能提供影响候选。AI 建议不是业务事实，需人工确认风险范围与完整用例。</li><li>执行前由你部署测试环境并登记版本；平台不自动部署，也不认定某个提交必然导致失败。</li></ol><p>分析在后台运行，离开或刷新不取消；用当前任务地址找回。失败时保留已完成批次，不把部分分析显示为完整覆盖。</p></section>
    <p v-if="error" class="reg-error" role="alert">{{ error }} · 查询失败不表示任务停止，可点击刷新重试。</p><p v-if="actionError" class="reg-error" role="alert">{{ actionError }}</p>
    <NewRegression v-if="route.params.id==='new'" />
    <template v-else-if="!route.params.id">
      <section class="reg-card"><h2>开始新的回归</h2><p>无需上传 PRD：以本地提交与 Diff 为输入，形成独立的回归任务。</p><RouterLink class="reg-primary-link" to="/regressions/new">创建变更回归</RouterLink></section>
      <section class="reg-card"><h2>分析任务（最近 100 条）</h2><p v-if="!list.length">暂无分析任务。</p><RouterLink v-for="item in list" :key="item.id" class="reg-list-row" :to="`/regressions/${item.id}`"><strong>{{ item.projectId }} · {{ item.targetSha.slice(0,12) }}</strong><span>{{ statusNames[item.status] }} · {{ item.completedBatches }} 个建议批次 · {{ item.updatedAt }}</span></RouterLink></section>
      <section class="reg-card"><h2>已保存的范围（最近 100 条）</h2><p>预览也会保存；可重新打开确认，或基于同一冻结范围发起新分析。不会重写旧任务。</p><RouterLink v-for="item in ranges" :key="item.id" class="reg-list-row" :to="{path:'/regressions/new',query:{changeSet:item.id}}">{{ item.projectId }} · {{ item.targetSha.slice(0,12) }} · {{ item.fileCount }} 个文件 · {{ item.status==='frozen'?'已冻结':'待确认预览' }}</RouterLink></section>
    </template>
    <template v-else-if="analysis">
      <section class="reg-card"><h2>{{ analysis.projectId }} · {{ statusNames[analysis.status] }}</h2><p>{{ stageNames[analysis.stage] }} · 最近更新 {{ analysis.updatedAt }}</p><p>任务 ID：{{ analysis.id }}<br />固定目标 SHA：{{ analysis.targetSha }}</p><p v-if="analysis.error" class="reg-error">{{ analysis.error }}</p><button v-if="['queued','running'].includes(analysis.status)" :disabled="cancelling" @click="cancel">取消分析</button><RouterLink v-else :to="{path:'/regressions/new',query:{changeSet:analysis.changeSetId}}">以此冻结范围创建新分析</RouterLink></section>
      <ChangeSetView v-if="changeSet" :change-set="changeSet" />
      <WorktreeStatus v-if="changeSet" :key="changeSet.id" :change-set-id="changeSet.id" />
      <RegressionReview v-if="analysis.generation&&!['queued','running'].includes(analysis.status)" :key="analysis.id" :regression-id="analysis.id" :project-id="analysis.projectId" :target-sha="analysis.targetSha" />
      <section v-if="analysis.generation?.memoryReferences?.length" class="reg-card">
        <h2>本次分析参考的历史经验</h2>
        <p>仅选取同项目、差异两端固定版本中人工已采纳的经验，最多5条。来源页面不一定是本次目标页面；这些是风险线索，不是业务规则、源码证据或通过结论。以下保留分析时的内容和审核版本。</p>
        <details v-for="memory in analysis.generation.memoryReferences" :key="memory.id">
          <summary>经验 {{ memory.id }} · 审核版本 {{ memory.revision }}</summary>
          <p>{{ memory.lesson }}</p>
          <p>来源 SHA：{{ memory.sourceCommit }}<br />来源页面：{{ memory.targetUrl }}</p>
          <RouterLink :to="`/executions/${encodeURIComponent(memory.executionId)}`">查看来源执行报告</RouterLink>
        </details>
      </section>
      <section v-if="analysis.sourceImpact" class="reg-card"><h2>源码影响候选</h2><p>基于静态 import 等词法线索，可能误匹配；不是完整调用图，也不是已验证页面行为。</p><ul class="reg-warning"><li v-for="warning in analysis.sourceImpact.warnings" :key="warning">{{ warning }}</li></ul>
        <p v-if="analysis.sourceImpact.skippedShas.length" class="reg-warning">未分析版本：{{ analysis.sourceImpact.skippedShas.join('、') }}</p>
        <details v-for="tree in analysis.sourceImpact.trees" :key="tree.sha"><summary>{{ tree.sha.slice(0,12) }} · 影响候选 {{ tree.affectedFiles.length }} 个 · 未解析 {{ tree.unresolved.length }} 项 · 跳过 {{ tree.skippedFiles.length }} 个文件</summary><h3>候选影响文件</h3><ul><li v-for="path in tree.affectedFiles" :key="path">{{ path }}</li></ul><h3>引用线索</h3><ul><li v-for="(edge,index) in tree.edges" :key="index">{{ edge.from }}:{{ edge.line }} → {{ edge.to }}（{{ edge.specifier }}）</li></ul><h3>未解析依赖</h3><ul><li v-for="(item,index) in tree.unresolved" :key="index">{{ item.path }}:{{ item.line }} · {{ item.expression }} · {{ item.reason }}</li></ul><details><summary>跳过文件及原因</summary><ul><li v-for="item in tree.skippedFiles" :key="item.path">{{ item.path }} · {{ item.reason }}</li></ul></details></details>
      </section>
      <section v-if="analysis.generation" class="reg-card"><h2>AI 原始风险与用例建议</h2><p>已完成 {{ analysis.generation.batches.length }} 批；待处理 {{ analysis.generation.pendingEvidenceIds.length }} 项依据；未纳入 {{ analysis.generation.omittedEvidenceIds.length }} 项依据。以下均待人工审核，不代表用例通过。</p><p>模型 {{ analysis.generation.model }} · 提示词版本 {{ analysis.generation.promptVersion }}</p><ul class="reg-warning"><li v-for="item in analysis.generation.limitations" :key="item">{{ item }}</li></ul><details v-if="analysis.generation.pendingEvidenceIds.length||analysis.generation.omittedEvidenceIds.length"><summary>未覆盖的依据 ID</summary><p>待处理：{{ analysis.generation.pendingEvidenceIds.join('、')||'无' }}</p><p>未纳入：{{ analysis.generation.omittedEvidenceIds.join('、')||'无' }}</p></details>
        <article v-for="batch in analysis.generation.batches" :key="batch.id" class="reg-batch"><h3>建议批次 {{ batch.id }}</h3><p v-if="!batch.suggestions.risks.length">本批未提出风险，不等于没有风险。</p><details v-for="risk in batch.suggestions.risks" :key="risk.id"><summary>{{ risk.title }} · 严重度 {{ levels[risk.severity] }} · 置信度 {{ levels[risk.confidence] }}</summary><p>{{ risk.reason }}</p><details v-for="evidence in batch.evidence.filter(item=>risk.evidenceIds.includes(item.id))" :key="evidence.id"><summary>依据 {{ evidence.id }} · {{ evidence.paths.join('、') }}</summary><p>版本 {{ evidence.targetSha }} · {{ evidence.line?`源码行 ${evidence.line}`:`patch 字符偏移 ${evidence.patchOffset??0}（非行号）` }}</p><pre>{{ evidence.text }}</pre></details></details><details v-for="(item,index) in batch.suggestions.cases" :key="index"><summary>建议用例：{{ item.title }} · {{ item.verification==='browser'?'浏览器':item.verification==='api'?'接口':'人工' }}验证</summary><p>{{ item.verificationReason }} · 关联风险 {{ item.riskIds.join('、') }}</p><ContractView :contract="item.contract" /></details><ul v-if="batch.suggestions.limitations.length" class="reg-warning"><li v-for="limitation in batch.suggestions.limitations" :key="limitation">{{ limitation }}</li></ul></article>
      </section>
    </template>
  </main>
</template>

<style>
.regression-page{display:block;width:100%;max-width:none;margin:0;padding:24px;box-sizing:border-box;background:#f5f7fb;color:#202a40;min-height:100vh;font-size:16px;line-height:1.65}.regression-page nav,.regression-page header{display:flex;gap:18px;align-items:center;flex-wrap:wrap;margin-bottom:20px}.regression-page h1{margin-right:auto}.regression-page h2{font-size:22px}.regression-page h3{font-size:18px}.reg-card{background:white;border:1px solid #d9dfec;border-radius:12px;padding:22px;margin-bottom:20px;min-width:0;overflow-wrap:anywhere}.regression-page label{display:block;margin:16px 0;font-weight:600}.regression-page input,.regression-page select,.regression-page textarea{display:block;box-sizing:border-box;width:100%;max-width:900px;padding:10px;border:1px solid #8895ab;border-radius:6px;font:inherit}.regression-page button{padding:10px 16px;font:inherit;cursor:pointer}.regression-page button:disabled{opacity:.6;cursor:not-allowed}.regression-page fieldset{border:0;padding:0;min-width:0}.reg-error{color:#a72020;background:#fff0f0;padding:14px;white-space:pre-wrap}.reg-warning{background:#fff8e5;padding:16px 32px}.regression-page details{padding:12px 0;border-top:1px solid #e0e5ef}.regression-page summary{cursor:pointer;font-weight:600}.regression-page pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f3f5f9;padding:16px;font-size:14px;max-height:500px;overflow:auto}.reg-list-row{display:flex;gap:16px;flex-wrap:wrap;padding:16px 0;border-bottom:1px solid #e0e5ef}.reg-primary-link{display:inline-block;background:#5443e8;color:white;padding:10px 16px;border-radius:6px}.reg-batch{margin:20px 0}.regression-page code{font-size:14px}@media(max-width:700px){.regression-page{padding:12px}.reg-card{padding:16px}}
</style>
