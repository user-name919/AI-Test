<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { CaseDesign, DesignRun, EvidenceRef } from '@quality-ai/contracts/case-design'
import { designRequest, useCaseDesign } from './useCaseDesign'
import SourceViewer from './SourceViewer.vue'
import CaseDesignReview from './CaseDesignReview.vue'
import RegenerationPanel from './RegenerationPanel.vue'

const route = useRoute(); const router = useRouter()
const { design, runs, selected, active, error, loading, busy, refresh, start, cancel } = useCaseDesign()
const designs = ref<Array<Pick<CaseDesign, 'id'|'name'|'revision'|'updatedAt'>>>([])
const name = ref('')
const files = ref<Array<{file: File; role: 'prd'|'interface'}>>([])
const creating = ref(false)
const help = ref(false)
const showSource = ref(true)
const reference = ref<EvidenceRef>()
const stages: Array<{id:DesignRun['stage'];name:string}> = [{id:'extracting',name:'提取需求事实'},{id:'modeling',name:'整理事实与冲突'},{id:'planning',name:'规划场景覆盖'},{id:'generating',name:'生成用例草稿'},{id:'checking',name:'审查用例质量'}]
const statusNames: Record<DesignRun['status'],string> = {queued:'排队中',running:'进行中',completed:'阶段完成',failed:'失败',cancelled:'已取消',interrupted:'进程中断'}
const facts = computed(() => selected.value?.output.factModel?.consolidatedFacts ?? selected.value?.output.facts ?? [])
const importError = ref('')
async function loadList() {
  try { designs.value = (await designRequest<{designs: typeof designs.value}>('/api/case-designs')).designs }
  catch (cause) { importError.value = cause instanceof Error ? cause.message : '列表加载失败' }
}
onMounted(() => { void loadList() })
function chooseFiles(event: Event) {
  files.value = [...(event.target as HTMLInputElement).files ?? []].map((file,index) => ({file,role:index===0?'prd':'interface'}))
}
async function create() {
  if (creating.value) return
  creating.value = true; importError.value = ''
  try {
    if (!name.value.trim() || !files.value.length || files.value.length>5) throw new Error('请输入任务名称，并选择 1–5 份材料')
    const materials = await Promise.all(files.value.map(async ({file,role}) => {
      if (/\.pdf$/i.test(file.name)) {
        const contentBase64 = await new Promise<string>((resolve,reject) => { const reader=new FileReader(); reader.onload=()=>resolve(String(reader.result).split(',')[1]); reader.onerror=()=>reject(new Error(`读取 ${file.name} 失败`)); reader.readAsDataURL(file) })
        return {fileName:file.name,role,contentBase64}
      }
      return {fileName:file.name,role,content:await file.text()}
    }))
    const result=await designRequest<{design:CaseDesign}>('/api/case-designs',{name:name.value.trim(),files:materials})
    await loadList(); await router.push(`/case-designs/${result.design.id}`)
  } catch (cause) { importError.value=cause instanceof Error?cause.message:'导入失败' }
  finally { creating.value=false }
}
function unavailable(index:number) {
  if (busy.value || active.value) return '请等待当前操作完成，或取消正在进行的任务'
  if (index>0 && !runs.value.some(run=>run.stage===stages[index-1].id && run.status==='completed' && run.inputHash===design.value?.inputHash)) return `请先完成“${stages[index-1].name}”`
  return ''
}
function locate(value:EvidenceRef) { reference.value=value; showSource.value=true }
</script>
<template>
  <div class="design-layout">
    <nav class="design-nav" aria-label="设计工作台导航"><RouterLink to="/versions">返回版本中心</RouterLink><RouterLink to="/requirements">需求中心</RouterLink><RouterLink to="/case-designs" @click="loadList">用例设计</RouterLink><RouterLink to="/cases">用例资产</RouterLink><RouterLink to="/executions">执行中心</RouterLink></nav>
    <main>
      <header><div><small>独立设计 · 无需测试环境</small><h1>{{ design?.name || '用例设计' }}</h1></div><button @click="help=!help">使用指引</button></header>
      <section v-if="help" class="card"><h2>如何使用</h2><p>导入材料 → 提取并检查事实 → 规划场景 → 生成草稿 → 审查质量。各阶段会保存独立产物，关闭页面不会取消生成。点击依据可定位左侧原文。</p><p>“阶段完成”不代表审核通过。选择已完成的质量审查记录后，在下方编辑人工口径、确认或排除用例并保存。未保存草稿留在当前标签页，离开会提示；保存后可发布并下载冻结版本，发布不等于测试通过。</p></section>
      <p v-if="importError" role="alert" class="error">{{ importError }} <button @click="loadList">重试列表</button></p>
      <template v-if="!route.params.id">
        <form class="card" @submit.prevent="create"><h2>创建用例设计</h2><label>任务名称<input v-model="name" maxlength="200" required /></label><label>需求材料（PDF、Markdown、TXT，1–5 份）<input type="file" accept=".pdf,.md,.markdown,.txt" multiple @change="chooseFiles" /></label>
          <label v-for="(item,index) in files" :key="index">{{ item.file.name }}<select v-model="item.role" :aria-label="`材料 ${index+1} 角色`"><option value="prd">主材料</option><option value="interface">补充材料 / 技术方案</option></select></label>
          <p>如果全部选为补充材料，第一份将作为主材料；解析失败不会清空已选文件。扫描 PDF 未提取到文字时需先准备可读文本。</p><button :disabled="creating">{{ creating?'正在解析材料…':'创建并保存材料' }}</button></form>
        <section class="card"><h2>已有设计任务</h2><p v-if="!designs.length">暂无任务，可先导入材料。</p><RouterLink v-for="item in designs" :key="item.id" class="design-link" :to="`/case-designs/${item.id}`">{{ item.name }} · 材料 v{{ item.revision }}</RouterLink></section>
      </template>
      <template v-else>
        <p v-if="error" role="alert" class="error">{{ error }} <button @click="refresh">重新读取</button></p>
        <p v-if="loading">正在读取任务…</p>
        <template v-if="design">
          <section class="card"><h2>生成阶段</h2><div class="stages"><div v-for="(stage,index) in stages" :key="stage.id"><button :disabled="Boolean(unavailable(index))" @click="start(stage.id)">{{ stage.name }}</button><small>{{ unavailable(index) || '可运行或重新生成；将创建新记录' }}</small></div></div><p v-if="active" role="status">{{ stages.find(stage=>stage.id===active?.stage)?.name }} · {{ statusNames[active.status] }} · 最近更新 {{ active.updatedAt }} <button :disabled="busy" @click="cancel">取消生成</button></p></section>
          <section class="card"><label>查看阶段产物<select aria-label="查看阶段产物" :value="selected?.id ?? ''" @change="router.replace({query:{...route.query,runId:($event.target as HTMLSelectElement).value}})"><option v-for="run in runs" :key="run.id" :value="run.id">第 {{ run.attempt }} 次 · {{ stages.find(stage=>stage.id===run.stage)?.name }} · {{ statusNames[run.status] }}</option></select></label><p v-if="route.query.runId && !selected" role="alert">指定的阶段记录不存在，请重新选择。</p><p v-if="selected?.error" role="alert" class="error">{{ selected.error }}</p><p v-if="selected">使用方法：{{ selected.skills.map(skill=>`${skill.id}@${skill.version}`).join('、') || '未启用 Skills' }} · 调用 {{ selected.statistics.calls }} 次</p><button @click="showSource=!showSource">{{ showSource?'收起原文':'显示原文' }}</button></section>
          <section v-if="selected?.stage==='modeling' && selected.output.modelingBatches" class="card" aria-label="事实交叉合并进度">
            <h2>事实交叉合并进度</h2><p>已处理 {{ selected.output.modelingBatches.filter(batch=>batch.status==='completed').length }} / {{ selected.output.modelingBatches.length }} 批。{{ selected.output.factModel?'全局汇总已生成，冲突与语义仍需人工审核。':'全局汇总尚未完成，局部结果不能视为完整分析。' }}</p>
            <p>大材料按事实分区，两两交叉检查，使任意两条事实至少共同提供给模型一次；调用次数会随分区数增加。模型仍可能漏判，不能代替人工审核。已校验批次保留，取消不删除已完成结果。等价事实汇总保留首条原始表述和全部来源；原始事实仍可在提取阶段查看。</p>
            <details v-for="batch in selected.output.modelingBatches" :key="batch.id"><summary>{{ batch.id }} · {{ batch.status==='completed'?'已校验批次':'尚未完成' }} · {{ batch.factIds.length }} 条原始事实</summary><p>参与事实：{{ batch.factIds.join('、') }}</p><template v-if="batch.model"><p>批内整理 {{ batch.model.consolidatedFacts.length }} 条 · 冲突 {{ batch.model.conflicts.length }} 项</p><p v-for="conflict in batch.model.conflicts" :key="conflict.id">{{ conflict.question }}</p></template></details>
          </section>
          <section v-if="selected?.stage==='planning' && selected.output.planningBatches" class="card" aria-label="场景规划进度">
            <h2>场景规划进度</h2><p>已处理 {{ selected.output.planningBatches.filter(batch=>batch.status==='completed').length }} / {{ selected.output.planningBatches.length }} 批 · 已保存 {{ selected.output.scenarios?.length??0 }} 个场景。{{ selected.status==='completed'?'规划已完成，覆盖与业务含义仍需人工审核。':'规划尚未完成，局部场景不能作为完整结果继续生成。' }}</p>
            <p>先规划分区内部场景，再补充两侧规则的联动场景；没有依据时允许不生成联动。仅合并字段完全相同的建议，近似重复仍需审核；两两分析不能证明全部复合业务关系已覆盖。</p>
            <details v-for="batch in selected.output.planningBatches" :key="batch.id"><summary>{{ batch.id }} · {{ {whole:'全量规划',local:'分区内部',cross:'跨分区联动'}[batch.kind] }} · {{ batch.status==='completed'?'已校验批次':'尚未完成' }}</summary><p>参与事实：{{ batch.factIds.join('、') }}</p><p>场景：{{ batch.scenarioIds.join('、')||'尚无场景' }}</p></details>
          </section>
          <section v-if="selected?.stage==='checking' && selected.output.qualityBatches" class="card" aria-label="质量审查批次">
            <h2>质量审查批次</h2><p>已完成 {{ selected.output.qualityBatches.filter(batch=>batch.status==='completed').length }} / {{ selected.output.qualityBatches.length }} 批。{{ selected.output.modelReviewCompleted?'所有审查请求已完成，问题仍需人工判断，不代表测试通过。':'仍有未完成审查，已保存的问题与局部结果不能用于发布。' }}</p>
            <p>大上下文保留用例与直接依据，再交叉检查不同分区。原文阅读范围与跨用例审查进度分开统计；原文全部出现过，也不代表所有交叉批次完成。模型可能漏判，不替代人工审核。</p>
            <details v-for="batch in selected.output.qualityBatches" :key="batch.id"><summary>{{ batch.id }} · {{ batch.kind==='documents'?'全量目标与原文分批':'分区交叉审查' }} · {{ batch.status==='completed'?'请求已完成':'尚未完成' }}</summary><p>用例：{{ batch.caseIds.join('、')||'本批无用例' }}</p><p>规则：{{ batch.factIds.join('、')||'本批无规则' }}</p><p>场景：{{ batch.scenarioIds.join('、')||'本批无场景' }}</p><p>原文块：{{ batch.blockIds.join('、')||'本批只含依据摘录，未提供完整原文块' }}</p></details>
          </section>
          <section v-if="selected?.stage==='checking' && selected.output.reviewedBlockIds" class="card" aria-label="原文审查范围">
            <h2>原文审查范围</h2><p>已审查 {{ selected.output.reviewedBlockIds.length }} 块 · 未完成 {{ selected.output.unreviewedBlockIds?.length??0 }} 块。{{ selected.output.modelReviewCompleted?'模型审查完成，仍需人工审核。':'审查尚未完成，已保存批次不代表全量通过。' }}</p>
            <details v-if="selected.output.unreviewedBlockIds?.length"><summary>查看未完成的原文块</summary><p v-for="id in selected.output.unreviewedBlockIds" :key="id">{{ id }}</p></details>
          </section>
          <section v-if="selected?.output.generationAttempts?.length" class="card" aria-label="生成格式修复记录">
            <h2>生成与格式修复记录</h2><p>每个场景最多生成两次。结构有效仅表示字段校验通过，不代表业务含义正确；请结合原始依据和最终用例审核。</p>
            <details v-for="attempt in selected.output.generationAttempts" :key="`${attempt.scenarioId}-${attempt.attempt}`">
              <summary>场景 {{ attempt.scenarioId }} · 第 {{ attempt.attempt }} 次 · {{ attempt.status==='invalid'?'结构校验失败':'结构校验通过，待语义审核' }}</summary>
              <p v-if="attempt.error" class="error">{{ attempt.error }}</p>
              <p v-if="attempt.responseTruncated">响应过长，仅保留前 64000 字符；不能视为完整原文。</p>
              <pre>{{ attempt.response }}</pre>
            </details>
          </section>
          <div class="evidence-layout" :class="{single:!showSource}">
            <SourceViewer v-if="showSource" :documents="design.documents" :reference="reference" />
            <section class="card results"><h2>需求事实与场景</h2><p v-if="!selected">材料已保存，请先提取需求事实。</p>
              <article v-for="fact in facts" :key="fact.id"><h3>{{ fact.id }} · {{ {explicit:'原文明示',inferred:'AI 推断',unresolved:'待确认'}[fact.kind] }}</h3><p>{{ fact.statement }}</p><button v-for="(ref,index) in fact.evidence" :key="index" @click="locate(ref)">查看依据：{{ ref.quote }}</button></article>
              <article v-for="question in selected?.output.questions" :key="question.id"><h3>待确认 {{ question.id }}</h3><p>{{ question.question }}</p></article>
              <article v-for="conflict in selected?.output.factModel?.conflicts" :key="conflict.id"><h3>材料冲突 {{ conflict.id }}</h3><p>{{ conflict.question }}</p><button v-for="(ref,index) in conflict.evidence" :key="index" @click="locate(ref)">查看冲突依据：{{ ref.quote }}</button></article>
              <p v-if="selected?.output.uncoveredFactIds?.length" class="error">未分配场景的规则：{{ selected.output.uncoveredFactIds.join('、') }}</p>
              <article v-for="scenario in selected?.output.scenarios" :key="scenario.id"><h3>{{ scenario.title }}</h3><p>{{ scenario.testIntent }}</p><small>关联规则：{{ scenario.factIds.join('、') }} · {{ scenario.requiresReview?'有推断或问题，需复核':'仍需人工审核' }}</small></article>
              <details v-for="item in selected?.output.cases" :key="item.id"><summary>{{ item.title }} · {{ item.verification }} · 待审核建议</summary><pre>{{ JSON.stringify(item.contract,null,2) }}</pre></details>
              <article v-for="issue in selected?.output.issues" :key="issue.id"><h3>{{ issue.severity==='blocking'?'阻塞问题':'审查提醒' }} · {{ issue.checkedBy==='rule'?'代码检查':'模型建议' }}</h3><p>{{ issue.reason }}</p></article>
            </section>
          </div>
          <RegenerationPanel v-if="selected && ['generating','checking'].includes(selected.stage)" :key="`regenerate-${selected.id}`" :design="design" :run="selected" :runs="runs" :disabled="busy||!!active" @generate="start('generating',$event)" @check="start('checking',$event)" />
          <CaseDesignReview v-if="selected?.stage==='checking' && selected.status==='completed'" :key="selected.id" :design-id="design.id" :run="selected" @locate="locate" />
        </template>
      </template>
    </main>
  </div>
</template>
<style scoped>
.design-layout > main{margin-left:0;width:100%;max-width:none}
.design-layout{display:grid;grid-template-columns:180px minmax(0,1fr);min-height:100vh;background:#f4f6fb;font:16px/1.65 system-ui,sans-serif;color:#202a3a}.design-nav{padding:24px 16px;background:#111b2b;display:flex;flex-direction:column;gap:20px}.design-nav a{color:#e8ecff;text-decoration:none}.design-nav .router-link-exact-active{color:#bcb4ff}main{min-width:0;padding:24px}header{display:flex;justify-content:space-between;align-items:center;gap:20px}h1{font-size:28px;margin:4px 0 20px}h2{font-size:21px}h3{font-size:17px}small{font-size:14px;color:#586579;display:block}.card{padding:20px;background:white;border:1px solid #dce1eb;border-radius:12px;margin-bottom:16px}.stages{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}.evidence-layout{display:grid;grid-template-columns:minmax(280px,40%) minmax(0,1fr);gap:20px}.evidence-layout.single{grid-template-columns:1fr}.results{min-width:0;max-height:78vh;overflow:auto}.results article{border-bottom:1px solid #dce1eb;padding:12px 0}.results button{text-align:left;white-space:normal;overflow-wrap:anywhere}button,input,select{font:inherit}button{padding:8px 14px;border:1px solid #b9c1d3;background:#fff;color:#4434b3;border-radius:6px;cursor:pointer}button:disabled{opacity:.55;cursor:not-allowed}input:not([type=file]),select{padding:8px;border:1px solid #aab5c8;border-radius:5px;max-width:100%;display:block}label{display:block;margin:12px 0}pre{font:14px/1.6 monospace;white-space:pre-wrap;overflow-wrap:anywhere}.error{padding:12px;color:#9a2424;background:#fff1f1;border:1px solid #e8bbbb;border-radius:6px}.design-link{display:block;padding:12px;border-bottom:1px solid #e0e5ef}.results details{margin:16px 0}summary{cursor:pointer}@media(max-width:850px){.design-layout{grid-template-columns:1fr}.design-nav{flex-direction:row;flex-wrap:wrap;gap:12px;padding:12px}main{padding:16px}.evidence-layout{grid-template-columns:1fr}.results{max-height:none}}
</style>
