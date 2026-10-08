<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { caseExecutionContractSchema, type CaseExecutionContract } from '@quality-ai/contracts'
import type { CaseAsset } from '@quality-ai/contracts/cases'
import WriteOperationsEditor from './WriteOperationsEditor.vue'
import CaseContractDetails from './CaseContractDetails.vue'

const props = defineProps<{ analysisId: string; selected: Record<string, boolean> }>()
const route = useRoute()
const router = useRouter()
const emit = defineEmits<{ saved: []; toggle: [key: string]; execute: [requirementIndex: number] }>()
type Draft = { revision: number; contract: CaseExecutionContract }
const assets = ref<CaseAsset[]>([])
const activeId = ref('')
const active = computed(() => assets.value.find(asset => asset.id === activeId.value))
const drafts = ref<Record<string, Draft>>({})
const draft = computed(() => drafts.value[activeId.value])
const error = ref('')
const notice = ref('')
const busy = ref(false)
const loading = ref(false)
const retry = ref(0)
const filter = computed({
  get: () => ['ready', 'blocked'].includes(String(route.query.caseStatus)) ? String(route.query.caseStatus) : 'all',
  set: value => { void router.push({ query: { ...route.query, caseStatus: value === 'all' ? undefined : value } }) },
})
const visible = computed(() => assets.value.filter(asset => filter.value === 'all' || asset.resolved.readiness.agent.executable === (filter.value === 'ready')))
const conflict = ref<CaseAsset | null>(null)
const listFields = [
  { key: 'preconditions', label: '前置条件' }, { key: 'steps', label: '执行步骤' },
  { key: 'expectedAssertions', label: '预期断言' }, { key: 'forbiddenBehaviors', label: '禁止行为' },
  { key: 'uncertainties', label: '未确定事项' },
] as const
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) }
function key(asset: CaseAsset) { return asset.source.type === 'requirement' ? asset.source.caseKey : '' }
let requestSequence = 0
watch([() => props.analysisId, retry], async ([id]) => {
  const sequence = ++requestSequence
  assets.value = []; activeId.value = ''; error.value = ''; conflict.value = null
  try { drafts.value = JSON.parse(sessionStorage.getItem(`case-drafts:${id}`) ?? '{}') }
  catch { drafts.value = {}; error.value = '无法恢复当前标签页草稿，请勿关闭页面。' }
  loading.value = true
  try {
    const response = await fetch(`/api/cases?sourceType=requirement&sourceId=${encodeURIComponent(id)}`)
    const body = await response.json()
    if (!response.ok) throw new Error(body.error || '读取用例失败')
    if (sequence !== requestSequence) return
    assets.value = body.cases
    activeId.value = typeof route.query.caseId === 'string' ? route.query.caseId : assets.value[0]?.id ?? ''
    if (activeId.value && !active.value) error.value = '用例记录不存在，请从左侧重新选择。'
  } catch (cause) { if (sequence === requestSequence) error.value = cause instanceof Error ? cause.message : '读取失败' }
  finally { if (sequence === requestSequence) loading.value = false }
}, { immediate: true })
watch(drafts, value => {
  try { sessionStorage.setItem(`case-drafts:${props.analysisId}`, JSON.stringify(value)) }
  catch { error.value = '浏览器无法保存草稿。请保持页面打开并尽快保存到服务端。' }
}, { deep: true, flush: 'sync' })
watch(() => route.query.caseId, id => {
  activeId.value = typeof id === 'string' ? id : assets.value[0]?.id ?? ''
  conflict.value = null
})
function select(id: string) {
  activeId.value = id; conflict.value = null; notice.value = ''; error.value = ''
  void router.push({ query: { ...route.query, caseId: id } })
}
function edit() {
  if (!active.value) return
  drafts.value[active.value.id] = { revision: active.value.revision, contract: clone(active.value.finalContract) }
}
function discard() {
  if (!window.confirm('确定丢弃该用例的本地草稿？服务端内容不会改变。')) return
  delete drafts.value[activeId.value]; conflict.value = null
}
function updateLines(field: typeof listFields[number]['key'], event: Event) {
  if (draft.value) draft.value.contract[field] = (event.target as HTMLTextAreaElement).value.split('\n')
}
function addData() {
  draft.value?.contract.dataBindings.push({ id: crypto.randomUUID(), label: '搜索词', mode: 'runtime_dom', targetHint: '', businessIntent: '', strategy: 'visible_option_substring', constraints: { mustComeFromCurrentDom: true, mustBePartialOfSource: true, mustRemainAfterFiltering: true } })
}
function changeMode(index: number, event: Event) {
  const binding = draft.value?.contract.dataBindings[index]
  if (!binding) return
  const mode = (event.target as HTMLSelectElement).value as typeof binding.mode
  binding.mode = mode; delete binding.fixture; delete binding.manual; delete binding.strategy; delete binding.optionUniverse
  binding.constraints = { mustComeFromCurrentDom: false }
  if (mode === 'runtime_dom') {
    binding.strategy = 'visible_option_substring'
    binding.constraints = { mustComeFromCurrentDom: true, mustBePartialOfSource: true, mustRemainAfterFiltering: true }
  } else if (mode === 'manual') binding.manual = { value: '', rationale: '' }
  else binding.fixture = { value: '', evidence: '' }
}
function changeStrategy(index: number, event: Event) {
  const binding = draft.value?.contract.dataBindings[index]
  if (!binding) return
  binding.strategy = (event.target as HTMLSelectElement).value as typeof binding.strategy
  binding.constraints = { mustComeFromCurrentDom: true, mustBePartialOfSource: binding.strategy === 'visible_option_substring', mustRemainAfterFiltering: binding.strategy !== 'non_matching_option_query' }
  if (binding.strategy === 'non_matching_option_query') binding.optionUniverse = { completeness: 'unknown', options: [], evidence: '' }
  else delete binding.optionUniverse
}
function updateOptions(index: number, event: Event) {
  const universe = draft.value?.contract.dataBindings[index]?.optionUniverse
  if (universe) universe.options = (event.target as HTMLTextAreaElement).value.split('\n').map(value => value.trim()).filter(Boolean)
}
async function save(status: 'draft' | 'confirmed') {
  if (!active.value || !draft.value) return
  const id = active.value.id
  const contract = clone(draft.value.contract)
  for (const field of listFields) contract[field.key] = contract[field.key].map(line => line.trim()).filter(Boolean)
  contract.objective = contract.objective.trim()
  const parsed = caseExecutionContractSchema.safeParse(contract)
  if (!parsed.success) { error.value = `请完善用例：${parsed.error.issues.map(issue => `${issue.path.join('.')}：${issue.message}`).join('；')}`; return }
  busy.value = true; error.value = ''; notice.value = ''
  try {
    const response = await fetch(`/api/cases/${id}/review`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedRevision: draft.value.revision, review: { status, finalContract: parsed.data } }) })
    const body = await response.json()
    if (response.status === 409) { conflict.value = body.asset; error.value = '服务端版本已更新。草稿仍保留，请对照最新内容后再决定。'; return }
    if (!response.ok) throw new Error(body.error || '保存失败')
    assets.value = assets.value.map(asset => asset.id === id ? body.asset : asset)
    delete drafts.value[id]; conflict.value = null
    notice.value = status === 'confirmed' ? '人工最终口径已保存。执行就绪条件仍由服务端判断。' : '已保存为服务端草稿，尚未确认执行。'
    emit('saved')
  } catch (cause) { error.value = cause instanceof Error ? cause.message : '保存失败，草稿已保留' }
  finally { busy.value = false }
}
function rebase() {
  if (!draft.value || !conflict.value) return
  draft.value.revision = conflict.value.revision
  assets.value = assets.value.map(asset => asset.id === conflict.value?.id ? conflict.value : asset)
  conflict.value = null; error.value = ''; notice.value = '已使用最新版本号；请检查草稿，点击保存才会提交。'
}
</script>

<template>
  <section class="asset-workbench" aria-label="用例审核工作台">
    <p v-if="loading" role="status">正在读取服务端用例…</p>
    <p v-if="error" class="message error" role="alert">{{ error }} <button v-if="!assets.length && !loading" @click="retry++">重试读取</button></p>
    <p v-if="notice" class="message" role="status">{{ notice }}</p>
    <div class="master-detail">
      <nav aria-label="用例列表">
        <label>筛选 <select v-model="filter" aria-label="筛选"><option value="all">全部用例</option><option value="ready">Agent 就绪</option><option value="blocked">未就绪</option></select></label>
        <div v-for="asset in visible" :key="asset.id" class="case-row" :class="{ chosen: activeId === asset.id }">
          <input type="checkbox" :aria-label="`选择执行 ${asset.title}`" :checked="selected[key(asset)]" @change="emit('toggle', key(asset))" />
          <button :disabled="busy" @click="select(asset.id)"><strong>{{ asset.title }}</strong><small>{{ key(asset) }} · v{{ asset.revision }} · {{ asset.reviewStatus === 'confirmed' ? '已确认' : asset.reviewStatus === 'legacy_unreviewed' ? '历史待复核' : '待确认' }}{{ drafts[asset.id] ? ' · 有本地草稿' : '' }}</small></button>
        </div>
        <p v-if="!loading && !visible.length">暂无符合条件的用例</p>
      </nav>
      <article v-if="active" class="detail">
        <header><h2>{{ active.title }}</h2><button v-if="!draft" @click="edit">编辑最终口径</button></header>
        <p>AI 原始建议保留不变；人工最终口径经服务端解析后用于执行。草稿仅保留在当前浏览器标签页会话中。</p>
        <details><summary>查看 AI 原始建议</summary><p>{{ active.originalSuggestion.objective }}</p><ol><li v-for="(step,index) in active.originalSuggestion.steps" :key="index">{{ step }}</li></ol><p>预期：{{ active.originalSuggestion.expectedAssertions.join('；') }}</p></details>
        <CaseContractDetails :resolved="active.resolved" :expanded="!draft" unavailable-reason="正在读取" />
        <fieldset v-if="draft" :disabled="busy" class="editor">
          <legend>人工最终口径 · 基于 v{{ draft.revision }}</legend>
          <label>测试目标<input v-model="draft.contract.objective" /></label>
          <label v-for="field in listFields" :key="field.key">{{ field.label }}（每行一项）<textarea :value="draft.contract[field.key].join('\n')" rows="3" @input="updateLines(field.key,$event)" /></label>
          <WriteOperationsEditor v-model="draft.contract.writeOperations" />
          <h3>测试数据来源</h3><p>AI 根据当前选项选值，分别验证完整名称、部分关键词或无匹配负例。无匹配必须有完整候选范围依据，不能把当前可见列表当成全部远程数据。</p>
          <section v-for="(binding,index) in draft.contract.dataBindings" :key="binding.id" class="data-editor">
            <label>数据名称<input v-model="binding.label" /></label><label>目标控件<input v-model="binding.targetHint" /></label><label>业务用途<input v-model="binding.businessIntent" /></label>
            <label>来源<select :value="binding.mode" @change="changeMode(index,$event)"><option value="runtime_dom">当前 DOM 选项</option><option value="manual">人工指定</option><option value="fixture">固定测试夹具</option></select></label>
            <label v-if="binding.mode==='runtime_dom'">搜索策略<select aria-label="搜索策略" :value="binding.strategy" @change="changeStrategy(index,$event)"><option value="visible_option_full">完整名称搜索</option><option value="visible_option_substring">部分关键词搜索</option><option value="non_matching_option_query">无匹配搜索（负例）</option></select></label>
            <template v-if="binding.optionUniverse">
              <label>候选范围<select aria-label="候选范围" v-model="binding.optionUniverse.completeness"><option value="unknown">尚未确认</option><option value="partial_or_remote">分页、虚拟列表或远程搜索</option><option value="complete_local">已确认完整本地候选</option></select></label>
              <label>完整候选名称（每行一项）<textarea :value="binding.optionUniverse.options.join('\n')" @input="updateOptions(index,$event)" /></label>
              <label>完整性依据<input v-model="binding.optionUniverse.evidence" placeholder="例如已确认的受控夹具及数据范围；不能仅写当前页面可见" /></label>
              <p>未确认完整范围时，动态取负例会受阻；可准备可控夹具后复核。这里只保存范围声明，不代表系统证明了全局不存在。</p>
            </template>
            <template v-if="binding.manual"><label>人工值<input v-model="binding.manual.value" /></label><label>选值依据<input v-model="binding.manual.rationale" /></label></template>
            <template v-if="binding.fixture"><label>夹具值<input v-model="binding.fixture.value" /></label><label>存在性证据<input v-model="binding.fixture.evidence" /></label></template>
            <label v-if="binding.mode==='runtime_dom' && binding.strategy!=='non_matching_option_query'"><input v-model="binding.constraints.mustRemainAfterFiltering" type="checkbox" />筛选后来源选项仍应存在</label>
            <button @click="draft.contract.dataBindings.splice(index,1)">移除此数据规则</button>
          </section>
          <button @click="addData">添加数据规则</button>
          <div v-if="conflict" class="conflict"><h3>服务端最新 v{{ conflict.revision }}（未覆盖本地草稿）</h3><CaseContractDetails :resolved="conflict.resolved" unavailable-reason="" /><button @click="rebase">已对比，保留我的草稿并使用最新版本号</button></div>
          <footer><button :disabled="Boolean(conflict)" @click="save('draft')">保存草稿</button><button :disabled="Boolean(conflict)" @click="save('confirmed')">保存并确认最终口径</button><button @click="discard">丢弃本地草稿</button></footer>
        </fieldset>
        <button :disabled="Boolean(draft) || busy" :title="draft ? '请先保存或丢弃本地草稿，执行只使用服务端口径' : '进入测试环境配置'" @click="emit('execute',active.resolved.requirementIndex)">前往配置执行</button>
      </article>
    </div>
  </section>
</template>

<style scoped>
.asset-workbench { font-size:16px; line-height:1.6; } .master-detail { display:grid; grid-template-columns:minmax(250px,30%) minmax(0,1fr); border:1px solid #dce0eb; border-radius:12px; background:white; }
nav { padding:16px; border-right:1px solid #dce0eb; } .detail { padding:24px; min-width:0; } header { display:flex; justify-content:space-between; gap:16px; align-items:center; } h2 { font-size:22px; }
.case-row { display:flex; align-items:center; gap:8px; padding:10px; border-bottom:1px solid #e5e7ef; } .case-row button { text-align:left; background:transparent; border:0; flex:1; } small { display:block; color:#586477; font-size:14px; } .chosen { background:#efedff; }
button { cursor:pointer; padding:8px 12px; border:1px solid #cbcde0; border-radius:6px; background:#f7f7ff; font-size:15px; } button:disabled { opacity:.55; cursor:not-allowed; }
.editor { border:1px solid #cbcde0; padding:18px; margin:20px 0; border-radius:8px; } label { display:block; margin:10px 0; } input:not([type=checkbox]),textarea,select { display:block; width:100%; box-sizing:border-box; padding:10px; font:inherit; border:1px solid #bfc7d4; border-radius:5px; } textarea { resize:vertical; } input[type=checkbox] { width:18px; height:18px; }
footer { display:flex; flex-wrap:wrap; gap:12px; margin-top:20px; } .message,.conflict { background:#f0f2ff; border:1px solid #c8ceeb; padding:14px; border-radius:8px; } .error { background:#fff3f2; color:#982323; } .data-editor { border:1px solid #dce0eb; padding:12px; margin:12px 0; } p { overflow-wrap:anywhere; }
@media(max-width:850px) { .master-detail { grid-template-columns:1fr; } nav { border-right:0; max-height:300px; overflow:auto; } .detail { padding:16px; } }
</style>
