<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import type { AgentDecision, AnalysisSummary, ExecutionRecord, LiveExecutionEvent, PrdAnalysis, QuestionReview, ReviewExecutionContract, SavedAnalysis, SavedAutomationPlan, TestEnvironment } from '../shared/contracts'
import { consumeNdjsonChunk, createLiveExecutionState, reduceLiveExecutionState } from '../shared/live-execution'

type Tab = 'overview' | 'states' | 'questions' | 'cases'
type WorkspaceView = 'version' | 'requirements' | 'cases' | 'executions' | 'memory'
type NoticeKind = 'info' | 'success' | 'error' | 'loading'
interface ProjectOption { id: string; name: string; connected: boolean; targetOrigins: string[]; branch?: string; error?: string }

interface WorkspaceGuide {
  title: string
  summary: string
  steps: string[]
  conditions: string[]
  tip: string
}

const sampleAnalysis: PrdAnalysis = {
  versionName: '0825 版本',
  productName: '错题本',
  overview: '以 PRD 为入口，完成需求澄清、测试设计和自动化准备。',
  requirements: [
    {
      title: '上传试卷学校改为教研学校',
      summary: '高中阶段上传或编辑试卷时，学校字段切换为教研学校口径；小学、初中保持现状，并兼容历史在读学校数据。',
      risk: '高风险',
      riskReason: '涉及默认回显、数据源切换、历史数据兼容和保存契约。',
      businessRules: [
        { description: '小学、初中继续使用原学校数据源', evidence: '小学、初中学校逻辑保持不变' },
        { description: '高中学校切换为教研学校数据源', evidence: '高中阶段学校字段改为教研学校' },
        { description: '高中保存时携带教研学校业务类型', evidence: 'schoolBizType = 1' },
      ],
      pageStates: [
        { trigger: '小学 / 初中', initialState: '回显在读或历史学校', interaction: '使用原省市区与学校列表', expectedResult: 'schoolBizType = 0' },
        { trigger: '高中 · 有历史教研校', initialState: '优先回显历史教研学校', interaction: '使用教研云省市区与学校枚举', expectedResult: 'schoolBizType = 1' },
        { trigger: '高中 · 历史为在读校', initialState: '忽略历史值，读取默认教研校', interaction: '重新选择教研学校', expectedResult: 'schoolBizType = 1' },
        { trigger: '高中 · 无教研校', initialState: '预填注册地区，学校为空', interaction: '加载地区对应学校枚举', expectedResult: '选择学校后保存' },
      ],
      questions: [
        { title: '历史数据规则存在双重表述', reason: '新增试卷应忽略历史在读学校；编辑历史试卷是否原样展示？', suggestion: '新增与编辑拆成两套规则' },
        { title: '无教研学校时如何兜底', reason: '只预填注册分校省市区，还是同时回显注册分校名称？', suggestion: '学校留空，要求从枚举选择' },
      ],
      testCases: [
        { title: '小学上传试卷保持原学校逻辑', type: '回归', priority: 'P1', preconditions: ['小学账号'], steps: ['进入上传试卷页面', '查看学校字段'], expectedResult: '使用原学校数据源', blockedByQuestion: false },
        { title: '高中有历史教研学校时优先回显', type: '主流程', priority: 'P0', preconditions: ['高中账号存在历史教研学校'], steps: ['进入上传试卷页面'], expectedResult: '回显历史教研学校', blockedByQuestion: false },
        { title: '高中历史为在读学校时忽略历史值', type: '分支', priority: 'P0', preconditions: ['历史数据为在读学校'], steps: ['进入上传试卷页面'], expectedResult: '不回显在读学校', blockedByQuestion: true },
      ],
    },
    {
      title: '修复已毕业年级录入成绩时学年计算问题',
      summary: '注册年级为 17 的毕业生录入成绩时，按高三毕业口径计算学年，并覆盖 7 月 1 日的学年边界。',
      risk: '中风险',
      riskReason: '日期边界和特殊年级组合会影响历史成绩归属。',
      businessRules: [{ description: '注册年级 17 使用毕业生特殊计算分支', evidence: '注册年级为 17 时按高三毕业处理' }],
      pageStates: [
        { trigger: '注册年级 ≠ 17', initialState: '沿用原学年公式', interaction: '录入成绩', expectedResult: '结果保持一致' },
        { trigger: '注册年级 = 17 · 7月前', initialState: '按毕业口径计算', interaction: '录入成绩', expectedResult: '返回上一学年' },
        { trigger: '注册年级 = 17 · 7月起', initialState: '按毕业口径计算', interaction: '录入成绩', expectedResult: '返回正确学年' },
      ],
      questions: [{ title: '7 月 1 日边界时区', reason: '应以服务端时区还是用户端时区判断？', suggestion: '统一使用 Asia/Shanghai' }],
      testCases: [
        { title: '毕业生在 6 月 30 日录入高三成绩', type: '边界', priority: 'P0', preconditions: ['注册年级为 17'], steps: ['将日期设为 6 月 30 日', '录入高三成绩'], expectedResult: '成绩归入上一学年', blockedByQuestion: false },
        { title: '毕业生在 7 月 1 日录入高三成绩', type: '边界', priority: 'P0', preconditions: ['注册年级为 17'], steps: ['将日期设为 7 月 1 日', '录入高三成绩'], expectedResult: '成绩归入新学年', blockedByQuestion: true },
      ],
    },
  ],
}

const savedAnalysis = ref<SavedAnalysis | null>(null)
const apiConfigured = ref(false)
const activeRequirement = ref(0)
const activeTab = ref<Tab>('overview')
const confirmed = ref<Record<string, boolean>>({})
const selectedCases = ref<Record<string, boolean>>({})
const questionDrafts = ref<Record<string, string>>({})
const questionReviews = ref<Record<string, QuestionReview>>({})
const contractDrafts = ref<Record<string, ReviewExecutionContract>>({})
const reviewContractBusy = ref<Record<string, boolean>>({})
const notice = ref('')
const noticeKind = ref<NoticeKind>('info')
const helpOpen = ref(false)
const analyzing = ref(false)
const reviewSaving = ref(false)
const executionRunning = ref(false)
const latestExecution = ref<ExecutionRecord | null>(null)
const latestAutomationPlan = ref<SavedAutomationPlan | null>(null)
const targetUrl = ref('')
const environment = ref<TestEnvironment | null>(null)
const environmentName = ref('测试环境')
const analysisHistory = ref<AnalysisSummary[]>([])
const versionMenuOpen = ref(false)
const switchingVersion = ref(false)
const workspaceView = ref<WorkspaceView>('version')
const executionHistory = ref<ExecutionRecord[]>([])
const selectedExecutionId = ref('')
const executionFilter = ref<'all' | 'passed' | 'failed' | 'blocked'>('all')
const caseAssetFilter = ref<'all' | 'ready' | 'blocked'>('all')
const projects = ref<ProjectOption[]>([])
const projectId = ref('')
const liveExecution = ref(createLiveExecutionState())

const workspaceGuides: Record<WorkspaceView, WorkspaceGuide> = {
  version: {
    title: '版本中心使用指引',
    summary: '从需求材料开始，完成需求理解、问题确认、用例选择和执行准备。',
    steps: ['导入一份主 PRD，可同时补充技术方案、接口文档', '逐项查看业务规则、页面状态和待确认问题', '确认问题后选择需要执行的测试用例', '填写测试地址并选择固定计划或 Agent 动态执行'],
    conditions: ['支持 PDF、Markdown、TXT', '至少需要一份主 PRD', '待确认问题会阻止相关用例进入 Agent'],
    tip: '建议先完成高风险需求评审，再进入测试用例页。',
  },
  requirements: {
    title: '需求中心使用指引',
    summary: '按风险集中浏览当前版本需求，并回到评审详情处理规则和歧义。',
    steps: ['优先查看高风险需求', '比较规则、状态、问题和用例数量', '打开需求详情核对模型理解', '确认影响自动化执行的产品问题'],
    conditions: ['需要先导入需求材料', '当前页展示的是当前版本的需求集合'],
    tip: '风险原因比需求标题更值得优先阅读，它决定测试投入顺序。',
  },
  cases: {
    title: '用例资产使用指引',
    summary: '跨需求筛选和选择测试用例，再进入当前版本配置执行。',
    steps: ['按全部、可执行、待确认筛选用例', '勾选本次要覆盖的用例', '查看每条用例的步骤和预期结果', '点击配置并执行，补齐环境和项目条件'],
    conditions: ['待确认用例可以选择，但不能动态执行', '用例选择会自动保存到当前版本'],
    tip: '先用少量 P0 主流程验证环境，再逐步扩大执行范围。',
  },
  executions: {
    title: '执行中心使用指引',
    summary: '查看执行结果、失败证据和 Agent 决策过程，并判断下一步处理方式。',
    steps: ['用状态筛选定位失败或受阻记录', '先阅读失败原因，再查看对应决策步骤', '下载 Trace 或失败截图复盘真实页面', '固定计划可直接重跑，动态 Agent 需从用例重新发起'],
    conditions: ['动态 Agent 记录不能按旧决策原样重跑', '只有带固定计划的记录支持重新执行'],
    tip: '受阻通常代表信息或页面条件不足，不等同于断言失败。',
  },
  memory: {
    title: '质量记忆使用指引',
    summary: '复用当前版本沉淀的规则、失败经验和源码定位线索。',
    steps: ['从业务规则回看对应需求', '从失败记忆打开历史执行报告', '从源码线索查看 Agent 曾读取的局部文件', '在下一轮评审和执行中复用已有结论'],
    conditions: ['内容来自真实需求分析和执行记录', '当前只展示当前项目本地沉淀的数据'],
    tip: '这里的价值是减少重复排查，不应替代当前页面的真实 DOM 验证。',
  },
}

const analysis = computed(() => savedAnalysis.value?.result ?? sampleAnalysis)
const requirements = computed(() => analysis.value.requirements)
const requirement = computed(() => requirements.value[activeRequirement.value] ?? requirements.value[0])
const states = computed(() => requirement.value?.pageStates ?? [])
const questions = computed(() => requirement.value?.questions ?? [])
const cases = computed(() => requirement.value?.testCases ?? [])
const totalQuestions = computed(() => requirements.value.reduce((sum, item) => sum + item.questions.length, 0))
const totalCases = computed(() => requirements.value.reduce((sum, item) => sum + item.testCases.length, 0))
const readyCases = computed(() => requirements.value.reduce((sum, item, requirementIndex) => sum + item.testCases.filter(test => !test.blockedByQuestion || requirementQuestionsResolved(requirementIndex)).length, 0))
const confirmedCount = computed(() => questions.value.filter((_, index) => questionResolved(questionKey(index))).length)
const selectedCount = computed(() => cases.value.filter((_, index) => selectedCases.value[caseKey(index)]).length)
const coverage = computed(() => totalCases.value ? Math.round((readyCases.value / totalCases.value) * 100) : 0)
const sourceFileNames = computed(() => savedAnalysis.value?.fileNames?.length ? savedAnalysis.value.fileNames : [savedAnalysis.value?.fileName ?? '错题本_0825版本需求.md'])
const filteredExecutions = computed(() => executionFilter.value === 'all' ? executionHistory.value : executionHistory.value.filter(item => item.status === executionFilter.value))
const selectedExecution = computed(() => executionHistory.value.find(item => item.id === selectedExecutionId.value) ?? filteredExecutions.value[0] ?? null)
const executionPassRate = computed(() => executionHistory.value.length ? Math.round(executionHistory.value.filter(item => item.status === 'passed').length / executionHistory.value.length * 100) : 0)
const selectedCaseKeys = computed(() => Object.keys(selectedCases.value).filter(key => selectedCases.value[key]))
function blockedCaseKeys(caseKeys: string[]) {
  return caseKeys.filter(key => {
  const match = key.match(/^(\d+)-TC-(\d+)$/)
  return match ? Boolean(requirements.value[Number(match[1])]?.testCases[Number(match[2])]?.blockedByQuestion && !requirementQuestionsResolved(Number(match[1]))) : true
  })
}
const blockedSelectedCaseKeys = computed(() => blockedCaseKeys(selectedCaseKeys.value))
const selectedProject = computed(() => projects.value.find(project => project.id === projectId.value) ?? null)
const targetOrigin = computed(() => { try { return new URL(targetUrl.value).origin } catch { return '' } })
const matchingProjects = computed(() => projects.value.filter(project => project.connected && (!project.targetOrigins.length || project.targetOrigins.includes(targetOrigin.value))))
const requirementAssets = computed(() => requirements.value.map((item, index) => ({ item, index, code: requirementCode(index) })))
const caseAssets = computed(() => requirements.value.flatMap((item, requirementIndex) => item.testCases.map((testCase, caseIndex) => ({
  item: testCase,
  blocked: caseIsBlocked(requirementIndex, testCase),
  requirementTitle: item.title,
  requirementIndex,
  caseIndex,
  key: `${requirementIndex}-TC-${caseIndex}`,
  code: `${requirementCode(requirementIndex)} / TC-${String(caseIndex + 1).padStart(3, '0')}`,
}))))
const filteredCaseAssets = computed(() => caseAssetFilter.value === 'all' ? caseAssets.value : caseAssets.value.filter(asset => caseAssetFilter.value === 'blocked' ? asset.blocked : !asset.blocked))
const memoryRules = computed(() => requirements.value.flatMap((item, requirementIndex) => item.businessRules.map(rule => ({ ...rule, requirementTitle: item.title, requirementIndex }))))
const memoryFailures = computed(() => executionHistory.value.filter(item => item.status !== 'passed' && item.error).slice(0, 20))
const memorySourceUses = computed(() => executionHistory.value.flatMap(execution => execution.agent?.trajectory.flatMap(item => item.decision.type === 'need_project_context' ? [{ execution, item }] : []) ?? []).slice(0, 20))
const memoryCount = computed(() => memoryRules.value.length + memoryFailures.value.length + memorySourceUses.value.length)
const workspaceLabel = computed(() => ({ version: '版本中心', requirements: '需求中心', cases: '用例资产', executions: '执行中心', memory: '质量记忆' })[workspaceView.value])
const currentGuide = computed(() => workspaceGuides[workspaceView.value])
const agentRunDisabledReason = computed(() => {
  if (executionRunning.value) return '当前已有任务执行中，请等待完成'
  if (!selectedCaseKeys.value.length) return '请先选择至少一条测试用例'
  if (blockedSelectedCaseKeys.value.length) return `有 ${blockedSelectedCaseKeys.value.length} 条用例依赖待确认问题`
  if (!targetUrl.value) return '请先填写测试环境地址'
  if (!projectId.value) return '请选择已连接且与测试地址匹配的源码项目'
  if (!matchingProjects.value.some(project => project.id === projectId.value)) return '当前项目与测试地址 Origin 不匹配'
  return ''
})
const planDisabledReason = computed(() => {
  if (executionRunning.value) return '当前已有任务执行中，请等待完成'
  if (!selectedCaseKeys.value.length) return '请先选择至少一条测试用例'
  if (blockedSelectedCaseKeys.value.length) return `有 ${blockedSelectedCaseKeys.value.length} 条用例依赖待确认问题`
  if (!targetUrl.value) return '请先填写测试环境地址'
  return ''
})

function requirementCode(index: number) { return `REQ-${String(index + 1).padStart(3, '0')}` }
function questionKey(index: number) { return `${activeRequirement.value}-Q-${index}` }
function caseKey(index: number) { return `${activeRequirement.value}-TC-${index}` }
function caseCode(index: number) { return `TC-${String(index + 1).padStart(3, '0')}` }
function questionResolved(key: string) {
  const review = questionReviews.value[key]
  if (review) return review.status === 'accepted' || review.status === 'edited'
  return Boolean(confirmed.value[key])
}
function requirementQuestionsResolved(requirementIndex: number) {
  const requirementValue = requirements.value[requirementIndex]
  return Boolean(requirementValue?.questions.length && requirementValue.questions.every((_, questionIndex) => questionResolved(`${requirementIndex}-Q-${questionIndex}`)))
}
function caseIsBlocked(requirementIndex: number, testCase: PrdAnalysis['requirements'][number]['testCases'][number]) {
  return testCase.blockedByQuestion && !requirementQuestionsResolved(requirementIndex)
}
function chooseRequirement(index: number) { activeRequirement.value = index; activeTab.value = 'overview' }
function openRequirement(index: number) { chooseRequirement(index); workspaceView.value = 'version' }
function openCaseAsset(requirementIndex: number) { activeRequirement.value = requirementIndex; activeTab.value = 'cases'; workspaceView.value = 'version' }
function openExecution(id: string) { selectedExecutionId.value = id; workspaceView.value = 'executions' }
function questionDraft(index: number) {
  const key = questionKey(index)
  return questionDrafts.value[key] ?? questions.value[index]?.suggestion ?? ''
}
function updateQuestionDraft(index: number, event: Event) {
  const key = questionKey(index)
  questionDrafts.value[key] = (event.target as HTMLTextAreaElement).value
  delete contractDrafts.value[key]
}
function questionReviewLabel(key: string) {
  const review = questionReviews.value[key]
  if (review?.status === 'accepted') return '已采纳 AI 建议'
  if (review?.status === 'edited') return '已保存人工口径'
  if (review?.status === 'deferred') return '暂不确认'
  if (contractDrafts.value[key]) return '执行规则待人工确认'
  return '尚未形成最终口径'
}
function closeLiveExecution() { liveExecution.value = { ...liveExecution.value, visible: false } }
async function openLiveReport() {
  const execution = liveExecution.value.execution
  if (!execution) return
  latestExecution.value = execution
  if (!executionHistory.value.some(item => item.id === execution.id)) executionHistory.value = [execution, ...executionHistory.value]
  selectedExecutionId.value = execution.id
  workspaceView.value = 'executions'
  closeLiveExecution()
  await nextTick()
  document.querySelector('.execution-heading')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}
function reopenLiveExecution() { liveExecution.value = { ...liveExecution.value, visible: true } }
function toggleCaseAsset(key: string) { selectedCases.value[key] = !selectedCases.value[key]; void saveCurrentReview() }
let noticeTimer: number | undefined
function showNotice(message: string, kind: NoticeKind = 'info', duration?: number) {
  if (noticeTimer) window.clearTimeout(noticeTimer)
  notice.value = message
  noticeKind.value = kind
  if (duration === 0) return
  const visibleMs = duration ?? Math.min(16_000, Math.max(8_000, 5_000 + message.length * 120))
  noticeTimer = window.setTimeout(() => {
    notice.value = ''
    noticeTimer = undefined
  }, visibleMs)
}
function toast(message: string) {
  const kind: NoticeKind = /失败|错误|不能|不匹配|超过|请先/.test(message) ? 'error' : /正在|执行中|解析中/.test(message) ? 'loading' : 'success'
  showNotice(message, kind)
}
function dismissNotice() {
  if (noticeTimer) window.clearTimeout(noticeTimer)
  noticeTimer = undefined
  notice.value = ''
}
function rerunDisabledReason(execution: ExecutionRecord) {
  if (executionRunning.value) return '当前已有任务执行中'
  if (!execution.plan) return execution.mode === 'agent' ? '动态 Agent 需要从用例重新发起，以重新观察页面' : '旧记录没有保存固定计划，无法重跑'
  return ''
}
function formatVersionTime(value: string) { return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value)) }
function targetHost(value: string) { try { return new URL(value).host } catch { return value } }
function executionStatusText(status: ExecutionRecord['status']) { return status === 'passed' ? '执行通过' : status === 'blocked' ? '执行受阻' : '执行失败' }
function executionStatusIcon(status: ExecutionRecord['status']) { return status === 'passed' ? '✓' : status === 'blocked' ? '!' : '×' }
function liveStatusText() {
  if (liveExecution.value.status === 'running') return '实时执行中'
  if (liveExecution.value.status === 'passed') return '执行通过'
  if (liveExecution.value.status === 'blocked') return '执行受阻'
  if (liveExecution.value.status === 'failed') return '执行失败'
  return '正在连接浏览器'
}
function displayCaseKey(key: string) {
  const match = key.match(/^(\d+)-TC-(\d+)$/)
  return match ? `REQ-${String(Number(match[1]) + 1).padStart(3, '0')} / TC-${String(Number(match[2]) + 1).padStart(3, '0')}` : key
}
function markLiveExecutionFailed(error: unknown) {
  const message = error instanceof Error ? error.message : '未知错误'
  liveExecution.value = reduceLiveExecutionState(liveExecution.value, {
    type: 'execution_error',
    executionId: liveExecution.value.executionId || undefined,
    error: message,
  })
  return message
}
function decisionTitle(decision: AgentDecision) {
  if (decision.type === 'action') return `执行 ${decision.action.action}`
  if (decision.type === 'need_project_context') return `读取源码 · ${decision.request.operation}`
  if (decision.type === 'finish') return '完成测试'
  return '停止执行'
}
function decisionReason(decision: AgentDecision) { return decision.type === 'finish' ? decision.summary : decision.reason }
function actionDetail(decision: AgentDecision) {
  if (decision.type !== 'action') return ''
  const action = decision.action
  if ('target' in action) {
    if (action.target.by === 'elementRef') return `${action.target.elementRef} · 隐藏`
    if (action.target.by === 'text') return `文本“${action.target.text}” · 隐藏`
    return `${action.target.role}${action.target.name ? `“${action.target.name}”` : ''} · 隐藏`
  }
  if (action.action === 'scroll') return `${action.elementRef ?? '页面'} · x=${action.deltaX}, y=${action.deltaY}`
  if (action.action === 'expectCount') return `${action.containerRef ? `${action.containerRef} 内 ` : ''}${action.role}${action.name ? `“${action.name}”` : ''} · ${action.count} 个`
  if ('elementRef' in action) {
    if ('key' in action) return `${action.elementRef} · ${action.key}`
    if ('name' in action && 'value' in action) return `${action.elementRef} · ${action.name} ${action.match} ${action.value}`
    if ('text' in action) return `${action.elementRef} · ${action.text}`
    if ('checked' in action) return `${action.elementRef} · ${action.checked ? '已选中' : '未选中'}`
    return `${action.elementRef}${'value' in action ? ` · ${action.value}` : ''}`
  }
  if ('text' in action) return action.text
  if ('path' in action) return action.path
  if ('durationMs' in action) return `${action.durationMs}ms`
  return 'name' in action ? action.name : ''
}
function projectContextSummary(value: unknown) {
  if (Array.isArray(value)) return `命中 ${value.length} 处源码${value.length ? ` · ${value.slice(0, 3).map(item => typeof item === 'object' && item && 'path' in item ? String(item.path) : '').filter(Boolean).join('、')}` : ''}`
  if (!value || typeof value !== 'object') return '未返回源码上下文'
  if ('routeFile' in value) return `路由文件：${String(value.routeFile)}${'componentFile' in value && value.componentFile ? ` · 页面：${String(value.componentFile)}` : ''}`
  if ('files' in value && Array.isArray(value.files)) return `读取 ${value.files.length} 个局部文件 · ${value.files.map(file => typeof file === 'object' && file && 'path' in file ? String(file.path) : '').filter(Boolean).join('、')}`
  return '已返回项目上下文'
}

async function streamExecution(url: string, body: unknown, fallbackName: string, fallbackTargetUrl: string) {
  liveExecution.value = {
    ...createLiveExecutionState(),
    visible: true,
    status: 'running',
    name: fallbackName,
    targetUrl: fallbackTargetUrl,
  }
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: string } | null
    throw new Error(payload?.error ?? `执行请求失败（${response.status}）`)
  }
  if (!response.body) throw new Error('浏览器不支持读取实时执行流')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let remainder = ''
  while (true) {
    const { done, value } = await reader.read()
    const chunk = decoder.decode(value, { stream: !done })
    const consumed = consumeNdjsonChunk<LiveExecutionEvent>(remainder, done ? `${chunk}\n` : chunk)
    remainder = consumed.remainder
    for (const event of consumed.values) liveExecution.value = reduceLiveExecutionState(liveExecution.value, event)
    if (done) break
  }

  if (!liveExecution.value.execution) throw new Error(liveExecution.value.error || '实时执行流意外中断')
  return liveExecution.value.execution
}
function selectMatchingProject() {
  if (matchingProjects.value.some(project => project.id === projectId.value)) return
  projectId.value = matchingProjects.value[0]?.id ?? projects.value.find(project => project.connected)?.id ?? ''
}

function prepareDocumentText(content: string) {
  return content.replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g, '[图片数据已省略]')
}

function arrayBufferToBase64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768))
  }
  return window.btoa(binary)
}

function applyReview(analysisValue: SavedAnalysis) {
  confirmed.value = Object.fromEntries((analysisValue.review?.confirmedQuestions ?? []).map(key => [key, true]))
  selectedCases.value = Object.fromEntries((analysisValue.review?.selectedCases ?? []).map(key => [key, true]))
  questionReviews.value = { ...(analysisValue.review?.questionReviews ?? {}) }
  const drafts: Record<string, string> = {}
  analysisValue.result.requirements.forEach((item, requirementIndex) => item.questions.forEach((question, questionIndex) => {
    drafts[`${requirementIndex}-Q-${questionIndex}`] = questionReviews.value[`${requirementIndex}-Q-${questionIndex}`]?.finalStatement ?? question.suggestion
  }))
  questionDrafts.value = drafts
  contractDrafts.value = {}
}

async function saveCurrentReview() {
  if (!savedAnalysis.value || reviewSaving.value) return false
  reviewSaving.value = true
  try {
    const response = await fetch(`/api/analyses/${encodeURIComponent(savedAnalysis.value.id)}/review`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        confirmedQuestions: Object.keys(confirmed.value).filter(key => confirmed.value[key]),
        selectedCases: Object.keys(selectedCases.value).filter(key => selectedCases.value[key]),
        questionReviews: questionReviews.value,
      }),
    })
    const payload = await response.json() as { review?: SavedAnalysis['review']; error?: string }
    if (!response.ok || !payload.review) throw new Error(payload.error ?? '保存失败')
    savedAnalysis.value.review = payload.review
    questionReviews.value = { ...(payload.review.questionReviews ?? {}) }
    return true
  } catch (error) {
    toast(`评审状态保存失败：${error instanceof Error ? error.message : '未知错误'}`)
    return false
  } finally {
    reviewSaving.value = false
  }
}

async function saveQuestionReview(index: number, status: 'accepted' | 'edited' | 'deferred') {
  const key = questionKey(index)
  const statement = questionDraft(index).trim()
  if (!statement) return toast('请先填写人工最终口径')
  const previousReviews = questionReviews.value
  const previousConfirmed = { ...confirmed.value }
  const nextReviews = { ...questionReviews.value }
  const existing = nextReviews[key]
  const statementChanged = existing?.finalStatement.trim() !== statement
  const contract = contractDrafts.value[key] ?? (statementChanged ? undefined : existing?.executionContract)
  if (status !== 'deferred' && contract?.uncertainties.length) return toast('执行规则仍有不确定项，请补充人工口径后再确认')
  nextReviews[key] = {
    status,
    finalStatement: statement,
    executionContract: contract,
    updatedAt: existing?.updatedAt ?? null,
  }
  questionReviews.value = nextReviews
  if (status === 'deferred') delete confirmed.value[key]
  else confirmed.value[key] = true
  if (!await saveCurrentReview()) {
    questionReviews.value = previousReviews
    confirmed.value = previousConfirmed
    return
  }
  toast(status === 'deferred' ? '已暂不确认，相关用例仍保持阻塞' : '人工最终口径已保存，相关用例可进入执行准备')
}
async function generateQuestionContract(index: number) {
  const key = questionKey(index)
  const finalStatement = questionDraft(index).trim()
  if (!finalStatement) return toast('请先填写人工最终口径')
  reviewContractBusy.value[key] = true
  try {
    const caseKey = caseAssets.value.find(item => item.requirementIndex === activeRequirement.value && item.item.blockedByQuestion)?.key
    const response = await fetch(`/api/analyses/${encodeURIComponent(savedAnalysis.value?.id ?? '')}/review/contract`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ questionKey: key, finalStatement, caseKey, projectId: projectId.value || undefined, targetUrl: targetUrl.value || undefined }),
    })
    const payload = await response.json() as { contract?: ReviewExecutionContract; sourceContext?: { warnings?: string[] }; error?: string }
    if (!response.ok || !payload.contract) throw new Error(payload.error ?? '执行规则生成失败')
    contractDrafts.value[key] = payload.contract
    const warnings = payload.sourceContext?.warnings ?? []
    toast(warnings.length ? `执行规则已生成，但源码辅助有提示：${warnings[0]}` : 'AI 已生成执行规则，请检查后保存人工口径')
  } catch (error) {
    toast(`执行规则生成失败：${error instanceof Error ? error.message : '未知错误'}`)
  } finally {
    reviewContractBusy.value[key] = false
  }
}
function toggleQuestion(index: number) {
  const key = questionKey(index)
  const review = questionReviews.value[key]
  if (confirmed.value[key] || review?.status === 'accepted' || review?.status === 'edited') {
    void saveQuestionReview(index, 'deferred')
    return
  }
  const suggestion = questions.value[index]?.suggestion ?? ''
  const statement = questionDraft(index).trim()
  void saveQuestionReview(index, statement === suggestion.trim() ? 'accepted' : 'edited')
}

async function loadSavedAnalysis() {
  try {
    const [healthResponse, latestResponse, executionResponse, environmentResponse, historyResponse, executionsResponse, projectsResponse] = await Promise.all([fetch('/api/health'), fetch('/api/analyses/latest'), fetch('/api/executions/latest'), fetch('/api/environments/latest'), fetch('/api/analyses'), fetch('/api/executions'), fetch('/api/projects')])
    if (healthResponse.ok) apiConfigured.value = Boolean((await healthResponse.json()).configured)
    if (latestResponse.ok) {
      const payload = await latestResponse.json() as { analysis: SavedAnalysis | null }
      if (payload.analysis) {
        savedAnalysis.value = payload.analysis
        applyReview(payload.analysis)
      }
    }
    if (executionResponse.ok) latestExecution.value = (await executionResponse.json() as { execution: ExecutionRecord | null }).execution
    if (environmentResponse.ok) {
      const saved = (await environmentResponse.json() as { environment: TestEnvironment | null }).environment
      if (saved) {
        environment.value = saved
        environmentName.value = saved.name
        targetUrl.value = saved.targetUrl
      }
    }
    if (historyResponse.ok) analysisHistory.value = (await historyResponse.json() as { analyses: AnalysisSummary[] }).analyses
    if (executionsResponse.ok) {
      executionHistory.value = (await executionsResponse.json() as { executions: ExecutionRecord[] }).executions
      selectedExecutionId.value = executionHistory.value[0]?.id ?? ''
    }
    if (projectsResponse.ok) projects.value = (await projectsResponse.json() as { projects: ProjectOption[] }).projects
    selectMatchingProject()
  } catch {
    apiConfigured.value = false
  }
}

async function refreshExecutions(selectId?: string) {
  const response = await fetch('/api/executions')
  if (!response.ok) return
  executionHistory.value = (await response.json() as { executions: ExecutionRecord[] }).executions
  selectedExecutionId.value = selectId || selectedExecutionId.value || executionHistory.value[0]?.id || ''
}

async function refreshAnalysisHistory() {
  const response = await fetch('/api/analyses')
  if (response.ok) analysisHistory.value = (await response.json() as { analyses: AnalysisSummary[] }).analyses
}

async function switchVersion(id: string) {
  if (id === savedAnalysis.value?.id) {
    versionMenuOpen.value = false
    return
  }
  switchingVersion.value = true
  try {
    const response = await fetch(`/api/analyses/${encodeURIComponent(id)}`)
    const payload = await response.json() as { analysis?: SavedAnalysis; error?: string }
    if (!response.ok || !payload.analysis) throw new Error(payload.error ?? '版本加载失败')
    savedAnalysis.value = payload.analysis
    applyReview(payload.analysis)
    activeRequirement.value = 0
    activeTab.value = 'overview'
    latestAutomationPlan.value = null
    versionMenuOpen.value = false
    toast(`已切换到 ${payload.analysis.result.versionName}`)
  } catch (error) {
    toast(`版本切换失败：${error instanceof Error ? error.message : '未知错误'}`)
  } finally {
    switchingVersion.value = false
  }
}

async function verifyPlaywright() {
  executionRunning.value = true
  showNotice('正在启动 Chromium 执行真实浏览器测试…', 'loading', 0)
  try {
    const execution = await streamExecution('/api/automation/run/stream', {
        name: '知测 AI 本地冒烟测试',
        targetUrl: window.location.origin,
        steps: [
          { action: 'goto', path: '/' },
          { action: 'expectText', text: '知测 AI' },
          { action: 'expectText', text: analysis.value.productName },
          { action: 'screenshot', name: '工作台首页' },
        ],
      }, '知测 AI 本地冒烟测试', window.location.origin)
    latestExecution.value = execution
    await refreshExecutions(execution.id)
    toast(`Playwright 执行${execution.status === 'passed' ? '通过' : '失败'}，共 ${execution.steps.length} 个步骤`)
  } catch (error) {
    toast(`Playwright 执行失败：${markLiveExecutionFailed(error)}`)
  } finally {
    executionRunning.value = false
  }
}

async function persistEnvironment() {
  const response = await fetch('/api/environments', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: environment.value?.id, name: environmentName.value, targetUrl: targetUrl.value }),
  })
  const payload = await response.json() as { environment?: TestEnvironment; error?: string }
  if (!response.ok || !payload.environment) throw new Error(payload.error ?? '测试环境保存失败')
  environment.value = payload.environment
  return payload.environment
}

async function generatePlanOnly() {
  if (!savedAnalysis.value || !selectedCount.value || !targetUrl.value) return toast('请先选择用例并填写测试环境地址')
  if (blockedSelectedCaseKeys.value.length) return toast(`有 ${blockedSelectedCaseKeys.value.length} 条用例仍依赖待确认问题，暂不能生成固定计划`)
  executionRunning.value = true
  showNotice('公司模型正在生成受控 Playwright 计划…', 'loading', 0)
  try {
    await persistEnvironment()
    const generateResponse = await fetch('/api/automation/generate', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ analysisId: savedAnalysis.value.id, targetUrl: targetUrl.value, caseKeys: Object.keys(selectedCases.value).filter(key => selectedCases.value[key]) }),
    })
    const generated = await generateResponse.json() as { automationPlan?: SavedAutomationPlan; error?: string }
    if (!generateResponse.ok || !generated.automationPlan) throw new Error(generated.error ?? '计划生成失败')
    latestAutomationPlan.value = generated.automationPlan
    toast(`已生成 ${generated.automationPlan.plan.steps.length} 个步骤，请确认后执行`)
  } catch (error) {
    toast(`计划生成失败：${error instanceof Error ? error.message : '未知错误'}`)
  } finally { executionRunning.value = false }
}

async function runGeneratedPlan() {
  if (!latestAutomationPlan.value) return
  const blockedPlanCases = blockedCaseKeys(latestAutomationPlan.value.caseKeys)
  if (blockedPlanCases.length) return toast(`计划包含 ${blockedPlanCases.length} 条仍待确认的用例，请重新确认人工口径后再生成`)
  executionRunning.value = true
  showNotice('正在启动 Chromium 执行已确认计划…', 'loading', 0)
  try {
    const execution = await streamExecution('/api/automation/run/stream', {
      plan: latestAutomationPlan.value.plan,
      automationPlanId: latestAutomationPlan.value.id,
      environmentId: environment.value?.id,
    }, latestAutomationPlan.value.plan.name, latestAutomationPlan.value.plan.targetUrl)
    latestExecution.value = execution
    await refreshExecutions(execution.id)
    toast(`AI 计划执行${execution.status === 'passed' ? '通过' : '失败'}：${execution.steps.length} 步`)
  } catch (error) { toast(`执行失败：${markLiveExecutionFailed(error)}`) }
  finally { executionRunning.value = false }
}

async function runDynamicAgent() {
  if (!savedAnalysis.value || !selectedCaseKeys.value.length || !targetUrl.value) return toast('请先选择用例并填写测试环境地址')
  if (blockedSelectedCaseKeys.value.length) return toast(`有 ${blockedSelectedCaseKeys.value.length} 条用例仍依赖待确认问题，暂不能动态执行`)
  selectMatchingProject()
  if (!projectId.value) return toast('没有可用的项目源码连接，请先检查项目软链配置')
  if (!matchingProjects.value.some(project => project.id === projectId.value)) return toast('当前项目与测试地址 Origin 不匹配')
  executionRunning.value = true
  showNotice('Agent 正在观察真实页面并逐步执行，遇到歧义时会按需读取局部源码…', 'loading', 0)
  try {
    const savedEnvironment = await persistEnvironment()
    const execution = await streamExecution('/api/automation/agent/run/stream', {
        analysisId: savedAnalysis.value.id,
        caseKeys: selectedCaseKeys.value,
        targetUrl: targetUrl.value,
        environmentId: savedEnvironment.id,
        projectId: projectId.value,
      }, selectedCaseKeys.value.length === 1 ? caseAssets.value.find(item => item.key === selectedCaseKeys.value[0])?.item.title ?? 'Agent 动态执行' : `${analysis.value.versionName} · ${selectedCaseKeys.value.length} 条用例`, targetUrl.value)
    latestExecution.value = execution
    await refreshExecutions(execution.id)
    workspaceView.value = 'executions'
    toast(`Agent ${executionStatusText(execution.status)} · ${execution.agent?.trajectory.length ?? 0} 轮决策`)
  } catch (error) {
    toast(`Agent 执行失败：${markLiveExecutionFailed(error)}`)
  } finally {
    executionRunning.value = false
  }
}

async function rerunExecution(execution: ExecutionRecord) {
  if (!execution.plan || executionRunning.value) return
  executionRunning.value = true
  showNotice(`正在重新执行「${execution.name}」…`, 'loading', 0)
  try {
    const response = await fetch(`/api/executions/${encodeURIComponent(execution.id)}/rerun`, { method: 'POST' })
    const payload = await response.json() as { execution?: ExecutionRecord; error?: string }
    if (!payload.execution) throw new Error(payload.error ?? '重新执行失败')
    latestExecution.value = payload.execution
    await refreshExecutions(payload.execution.id)
    toast(`重新执行${payload.execution.status === 'passed' ? '通过' : '失败'}，已生成新的执行记录`)
  } catch (error) {
    toast(`重新执行失败：${error instanceof Error ? error.message : '未知错误'}`)
  } finally {
    executionRunning.value = false
  }
}

async function importStorageState(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  if (!environment.value && !targetUrl.value) {
    toast('请先填写测试环境地址，再导入登录态')
    input.value = ''
    return
  }
  try {
    const savedEnvironment = environment.value ?? await persistEnvironment()
    const response = await fetch(`/api/environments/${encodeURIComponent(savedEnvironment.id)}/storage-state`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: await file.text(),
    })
    const payload = await response.json() as { environment?: TestEnvironment; error?: string }
    if (!response.ok || !payload.environment) throw new Error(payload.error ?? '登录态导入失败')
    environment.value = payload.environment
    toast('Playwright 登录态已安全导入，后续执行会自动复用')
  } catch (error) {
    toast(`登录态导入失败：${error instanceof Error ? error.message : '文件格式错误'}`)
  } finally {
    input.value = ''
  }
}

function artifactUrl(path: string) {
  const parts = path.split('/')
  return `/api/artifacts/${encodeURIComponent(parts.at(-2) ?? '')}/${encodeURIComponent(parts.at(-1) ?? '')}`
}

async function importPrd(event: Event) {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  if (!files.length) return
  if (files.some(file => !/\.(pdf|md|markdown|txt)$/i.test(file.name))) {
    toast('当前支持 PDF、Markdown 和 TXT 文件')
    input.value = ''
    return
  }
  if (files.some(file => /\.pdf$/i.test(file.name) && file.size > 15 * 1024 * 1024)) {
    toast('单个 PDF 不能超过 15MB')
    input.value = ''
    return
  }
  if (files.reduce((sum, file) => sum + file.size, 0) > 22 * 1024 * 1024) {
    toast('单次上传的需求材料合计不能超过 22MB')
    input.value = ''
    return
  }

  analyzing.value = true
  showNotice(`正在联合解析 ${files.length} 份需求材料，请稍候…`, 'loading', 0)
  try {
    const documents = await Promise.all(files.map(async file => /\.pdf$/i.test(file.name) ? {
      fileName: file.name,
      contentBase64: arrayBufferToBase64(await file.arrayBuffer()),
      role: /接口|技术方案|api/i.test(file.name) ? 'interface' : 'prd',
    } : {
      fileName: file.name,
      content: prepareDocumentText(await file.text()),
      role: /接口|技术方案|api/i.test(file.name) ? 'interface' : 'prd',
    }))
    const response = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ files: documents }),
    })
    const payload = await response.json() as { analysis?: SavedAnalysis; error?: string }
    if (!response.ok || !payload.analysis) throw new Error(payload.error ?? '解析失败')
    savedAnalysis.value = payload.analysis
    activeRequirement.value = 0
    activeTab.value = 'overview'
    applyReview(payload.analysis)
    await refreshAnalysisHistory()
    toast(`公司模型已联合解析 ${files.length} 份材料，提取 ${payload.analysis.result.requirements.length} 个需求`)
  } catch (error) {
    toast(`解析失败：${error instanceof Error ? error.message : '未知错误'}`)
  } finally {
    analyzing.value = false
    input.value = ''
  }
}

onMounted(loadSavedAnalysis)
</script>

<template>
  <div class="app-shell">
    <aside class="sidebar">
      <div class="brand"><span>知</span><div><strong>知测 AI</strong><small>测试工作台</small></div></div>
      <nav>
        <button aria-label="版本中心" title="版本中心" :class="{active:workspaceView==='version'}" @click="workspaceView='version'"><i>版</i><span>版本中心</span></button><button aria-label="需求中心" title="需求中心" :class="{active:workspaceView==='requirements'}" @click="workspaceView='requirements'"><i>需</i><span>需求中心</span><em>{{ requirements.length }}</em></button><button aria-label="用例资产" title="用例资产" :class="{active:workspaceView==='cases'}" @click="workspaceView='cases'"><i>例</i><span>用例资产</span><em>{{ totalCases }}</em></button><button aria-label="执行中心" title="执行中心" :class="{active:workspaceView==='executions'}" @click="workspaceView='executions'"><i>执</i><span>执行中心</span><em>{{ executionHistory.length }}</em></button><button aria-label="质量记忆" title="质量记忆" :class="{active:workspaceView==='memory'}" @click="workspaceView='memory'"><i>忆</i><span>质量记忆</span><em>{{ memoryCount }}</em></button>
      </nav>
      <div class="side-bottom"><div class="memory"><b :class="{offline:!apiConfigured}"></b><p><strong>{{ apiConfigured ? '公司模型已连接' : '模型服务未连接' }}</strong><small>{{ savedAnalysis ? `${savedAnalysis.model} · 已持久化` : '当前显示示例数据' }}</small></p></div><div class="user"><span>TX</span><p><strong>测试小组</strong><small>前端质量空间</small></p></div></div>
    </aside>

    <main>
      <header class="topbar"><div v-if="workspaceView==='version'" class="version-switcher"><span>版本中心</span><b>/</b><button :disabled="switchingVersion" @click="versionMenuOpen=!versionMenuOpen"><strong>{{ analysis.versionName }}</strong><i>⌄</i></button><div v-if="versionMenuOpen" class="version-menu"><header><strong>版本记录</strong><span>{{ analysisHistory.length }} 个版本</span></header><button v-for="item in analysisHistory" :key="item.id" :class="{active:item.id===savedAnalysis?.id}" @click="switchVersion(item.id)"><i>{{ item.id===savedAnalysis?.id ? '✓' : '版' }}</i><span><strong>{{ item.productName }} · {{ item.versionName }}</strong><small>{{ formatVersionTime(item.createdAt) }} · {{ item.requirementCount }} 项需求 · {{ item.testCaseCount }} 条用例</small><em><b :style="{width:`${item.questionCount ? Math.round(item.confirmedQuestionCount/item.questionCount*100) : 100}%`}"></b></em></span></button><p v-if="!analysisHistory.length">导入第一份 PRD 后会形成版本记录</p></div></div><div v-else><span>{{ workspaceLabel }}</span><b>/</b><strong>{{ analysis.versionName }}</strong></div><div class="topbar-actions"><button class="guide-trigger" @click="helpOpen=true"><b>?</b> 如何使用</button><label v-if="workspaceView==='version'" :class="['import',{disabled:analyzing}]"><input :disabled="analyzing" multiple type="file" accept=".pdf,.md,.markdown,.txt,application/pdf" @change="importPrd" />{{ analyzing ? 'AI 解析中…' : '＋ 导入需求材料' }}</label></div></header>
      <div class="workspace">
        <template v-if="workspaceView==='version'">
        <section class="heading"><div><small><i></i>{{ savedAnalysis ? `真实解析 · ${savedAnalysis.provider}` : '示例模式 · 等待导入 PRD' }}</small><h1>{{ analysis.productName }} · {{ analysis.versionName }}</h1><p>{{ analysis.overview }}</p></div><div><button>分享评审</button><button class="primary" @click="activeTab='cases';toast('已切换到当前测试用例')">查看测试建议</button></div></section>
        <section class="metrics"><article><i class="purple">需</i><p><span>前端需求</span><strong>{{ requirements.length }}</strong><small>{{ savedAnalysis ? '公司模型已解析' : '当前为示例数据' }}</small></p></article><article><i class="amber">?</i><p><span>待确认问题</span><strong>{{ totalQuestions }}</strong><small>影响规则与用例</small></p></article><article><i class="blue">例</i><p><span>测试用例</span><strong>{{ totalCases }}</strong><small>{{ readyCases }} 条可执行</small></p></article><article><i class="green">✓</i><p><span>当前可执行率</span><strong>{{ coverage }}%</strong><small>确认后继续提升</small></p></article></section>

        <section class="content-grid">
          <aside class="requirements"><div class="section-title"><span>版本需求</span><b>{{ requirements.length }} 项</b></div>
            <button v-for="(item,index) in requirements" :key="`${item.title}-${index}`" :class="['req-card',{active:activeRequirement===index}]" @click="chooseRequirement(index)"><small><span>{{ requirementCode(index) }}</span><b :class="{medium:item.risk==='中风险',low:item.risk==='低风险'}">{{ item.risk }}</b></small><strong>{{ item.title }}</strong><p>{{ item.summary }}</p><div><i :style="{width:`${Math.round((item.testCases.filter(test => !test.blockedByQuestion || requirementQuestionsResolved(index)).length / item.testCases.length) * 100)}%`}"></i></div></button>
            <div class="sources"><span>需求材料</span><div v-for="fileName in sourceFileNames" :key="fileName"><i :class="{api:/接口|技术方案|api/i.test(fileName)}">{{ /接口|技术方案|api/i.test(fileName) ? 'API' : 'MD' }}</i><p><strong>{{ fileName }}</strong><small>{{ savedAnalysis ? `${/接口|技术方案|api/i.test(fileName) ? '增强材料' : '产品需求'} · 已联合解析` : '示例材料 · 等待真实导入' }}</small></p><b>{{ savedAnalysis ? '✓' : '○' }}</b></div></div>
          </aside>

          <section v-if="requirement" class="detail"><div class="detail-head"><small><span>{{ requirementCode(activeRequirement) }}</span><b>{{ requirement.risk }}</b></small><h2>{{ requirement.title }}</h2><p>{{ requirement.summary }}</p><div><span>◉ 前端需求</span><span>规则 {{ requirement.businessRules.length }}</span><span>问题 {{ requirement.questions.length }}</span><span>用例 {{ requirement.testCases.length }}</span></div></div>
            <div class="tabs"><button :class="{active:activeTab==='overview'}" @click="activeTab='overview'">需求概览</button><button :class="{active:activeTab==='states'}" @click="activeTab='states'">页面状态</button><button :class="{active:activeTab==='questions'}" @click="activeTab='questions'">待确认问题 <em>{{ questions.length-confirmedCount }}</em></button><button :class="{active:activeTab==='cases'}" @click="activeTab='cases'">测试用例</button></div>
            <div class="tab-content">
              <template v-if="activeTab==='overview'"><article class="ai-insight"><small><b>AI</b> 需求理解</small><h3>{{ requirement.riskReason }}</h3><p>{{ requirement.summary }}</p><button @click="activeTab='states'">查看页面状态 →</button></article><div class="rule-block"><header><h3>提取的业务规则</h3><span>{{ requirement.businessRules.length }} 条规则</span></header><div v-for="(rule,index) in requirement.businessRules" :key="`${rule.description}-${index}`"><span>BR-{{ String(index+1).padStart(2,'0') }}</span><p><strong>{{ rule.description }}</strong><small>{{ rule.evidence }}</small></p><b>有依据</b></div></div></template>
              <template v-else-if="activeTab==='states'"><header class="subhead"><div><h3>页面状态模型</h3><p>由 PRD 规则反推出用户可见状态与系统结果</p></div><span>{{ states.length }} 个关键状态</span></header><div class="flow"><span>进入页面</span><i>→</i><span>判断条件</span><i>→</i><span>回显 / 选择</span><i>→</i><span>保存校验</span></div><div class="state-table"><header><span>触发条件</span><span>页面初始状态</span><span>数据与交互</span><span>提交结果</span></header><div v-for="(state,index) in states" :key="`${state.trigger}-${index}`"><strong>{{ state.trigger }}</strong><span>{{ state.initialState }}</span><span>{{ state.interaction }}</span><span>{{ state.expectedResult }}</span></div></div><div v-if="questions.length" class="warning"><b>!</b><p><strong>存在 {{ questions.length }} 个待确认问题</strong><span>确认后才能稳定生成对应自动化任务。</span></p><button @click="activeTab='questions'">去确认</button></div></template>
              <template v-else-if="activeTab==='questions'"><header class="subhead"><div><h3>待产品确认</h3><p>确认结果会立即保存，刷新页面不会丢失</p></div><span>{{ reviewSaving ? '保存中…' : `${confirmedCount}/${questions.length} 已确认` }}</span></header><div class="question-list"><article v-for="(q,index) in questions" :key="`${q.title}-${index}`" :class="{done:confirmed[questionKey(index)]}"><i>{{ confirmed[questionKey(index)]?'✓':index+1 }}</i><div><h4>{{ q.title }}</h4><p>{{ q.reason }}</p><small><b>AI 建议</b>{{ q.suggestion }}</small></div><button @click="toggleQuestion(index)">{{ confirmed[questionKey(index)]?'已确认':'采纳建议' }}</button></article><div v-if="!questions.length" class="empty">模型未发现需要产品确认的问题</div></div></template>
              <template v-else><header class="case-toolbar"><div><h3>测试用例</h3><p>由当前真实业务规则和页面状态生成</p></div><span>{{ reviewSaving ? '保存中…' : `已选 ${selectedCount}/${cases.length}` }}</span></header><div class="case-table"><header><span></span><span>用例</span><span>类型</span><span>优先级</span><span>状态</span></header><label v-for="(item,index) in cases" :key="`${item.title}-${index}`"><input v-model="selectedCases[caseKey(index)]" type="checkbox" @change="saveCurrentReview"/><span><b>{{ caseCode(index) }}</b><strong>{{ item.title }}</strong></span><span>{{ item.type }}</span><i :class="item.priority.toLowerCase()">{{ item.priority }}</i><em :class="item.blockedByQuestion?'pending':'ready'">{{ item.blockedByQuestion ? '待确认' : '已就绪' }}</em></label></div><div class="environment-config"><input v-model="environmentName" placeholder="环境名称"/><span :class="{ ready: environment?.hasStorageState }">{{ environment?.hasStorageState ? '✓ 已配置登录态' : '未配置登录态' }}</span><label :class="{disabled:!targetUrl}" :title="!targetUrl ? '请先填写测试环境地址' : '导入 Playwright storageState JSON'"><input :disabled="!targetUrl" type="file" accept=".json,application/json" @change="importStorageState"/>导入 storageState</label></div><div class="agent-config"><label><span>源码项目</span><select v-model="projectId"><option value="">请选择已连接项目</option><option v-for="project in projects" :key="project.id" :value="project.id" :disabled="!project.connected">{{ project.name }}{{ project.connected ? '' : '（未连接）' }}</option></select></label><p :class="{ready:selectedProject?.connected && matchingProjects.some(project=>project.id===projectId)}"><b>{{ selectedProject?.connected && matchingProjects.some(project=>project.id===projectId) ? '✓' : '!' }}</b><span v-if="selectedProject?.connected && matchingProjects.some(project=>project.id===projectId)">{{ selectedProject.name }} 已连接{{ selectedProject.branch ? ` · ${selectedProject.branch}` : '' }}</span><span v-else>{{ selectedProject?.error ?? '项目未连接，或与测试地址 Origin 不匹配' }}</span></p></div><div v-if="blockedSelectedCaseKeys.length" class="agent-case-warning">有 {{ blockedSelectedCaseKeys.length }} 条已选用例仍依赖待确认问题，Agent 动态执行暂不可用。</div><div class="target-config"><input v-model="targetUrl" type="url" placeholder="测试环境地址，例如 https://test.example.com" @change="selectMatchingProject"/><div><span class="action-with-hint" :data-hint="agentRunDisabledReason"><button class="agent-run" :disabled="Boolean(agentRunDisabledReason)" @click="runDynamicAgent">{{ executionRunning ? '执行中…' : 'Agent 动态执行' }}</button></span><span class="action-with-hint" :data-hint="planDisabledReason"><button :disabled="Boolean(planDisabledReason)" @click="generatePlanOnly">{{ executionRunning ? '生成中…' : '生成固定计划' }}</button></span></div></div><div v-if="agentRunDisabledReason || planDisabledReason" class="action-readiness"><b>执行前置条件</b><span :class="{ready:selectedCaseKeys.length}">{{ selectedCaseKeys.length ? `✓ 已选 ${selectedCaseKeys.length} 条用例` : '○ 选择测试用例' }}</span><span :class="{ready:Boolean(targetUrl)}">{{ targetUrl ? '✓ 已填写测试地址' : '○ 填写测试地址' }}</span><span :class="{ready:Boolean(projectId) && matchingProjects.some(project=>project.id===projectId)}">{{ projectId && matchingProjects.some(project=>project.id===projectId) ? '✓ 源码项目已匹配' : '○ Agent 需匹配源码项目' }}</span></div><div v-if="latestAutomationPlan" class="plan-preview"><header><strong>{{ latestAutomationPlan.plan.name }}</strong><button :disabled="executionRunning" @click="runGeneratedPlan">{{ executionRunning ? '执行中…' : '确认并执行' }}</button></header><ol><li v-for="(step,index) in latestAutomationPlan.plan.steps" :key="index"><b>{{ index+1 }}</b><span>{{ step.action }}</span><code>{{ 'text' in step ? step.text : 'path' in step ? step.path : 'name' in step ? step.name : step.locator.value }}</code></li></ol></div><div class="automation"><div><b>✦</b><p><strong>Playwright 真实执行器</strong><span v-if="latestExecution">最近执行：{{ executionStatusText(latestExecution.status) }} · {{ latestExecution.mode==='agent' ? `${latestExecution.agent?.trajectory.length ?? 0} 轮决策` : `${latestExecution.steps.length} 步` }}</span><span v-else>尚未执行浏览器测试</span></p></div><button :disabled="executionRunning" @click="verifyPlaywright">验证执行器</button></div><div v-if="latestExecution" class="execution-report"><div v-for="step in latestExecution.steps" :key="step.index"><b :class="step.status">{{ step.status==='passed'?'✓':'×' }}</b><span>步骤 {{ step.index+1 }} · {{ step.action }}</span><small>{{ step.durationMs }}ms</small></div><footer><a v-if="latestExecution.tracePath" :href="artifactUrl(latestExecution.tracePath)">下载 Trace</a><a v-for="shot in latestExecution.screenshots" :key="shot" :href="artifactUrl(shot)">下载截图</a></footer></div></template>
            </div>
          </section>
        </section>
        </template>
        <template v-else-if="workspaceView==='executions'">
          <section class="heading execution-heading"><div><small><i></i>Playwright 真实浏览器结果</small><h1>自动化执行中心</h1><p>查看固定计划与动态 Agent 的步骤结果、决策轨迹、源码上下文和证据文件。</p></div><div><button class="primary" @click="workspaceView='version';activeTab='cases'">创建新执行</button></div></section>
          <section class="metrics execution-metrics"><article><i class="purple">执</i><p><span>执行总数</span><strong>{{ executionHistory.length }}</strong><small>本地持久化记录</small></p></article><article><i class="green">✓</i><p><span>通过</span><strong>{{ executionHistory.filter(item=>item.status==='passed').length }}</strong><small>浏览器执行成功</small></p></article><article><i class="amber">!</i><p><span>未完成</span><strong>{{ executionHistory.filter(item=>item.status!=='passed').length }}</strong><small>{{ executionHistory.filter(item=>item.status==='failed').length }} 失败 · {{ executionHistory.filter(item=>item.status==='blocked').length }} 受阻</small></p></article><article><i class="blue">率</i><p><span>通过率</span><strong>{{ executionPassRate }}%</strong><small>全部执行记录</small></p></article></section>
          <div class="execution-filters"><button :class="{active:executionFilter==='all'}" @click="executionFilter='all'">全部 {{ executionHistory.length }}</button><button :class="{active:executionFilter==='passed'}" @click="executionFilter='passed'">已通过</button><button :class="{active:executionFilter==='failed'}" @click="executionFilter='failed'">失败</button><button :class="{active:executionFilter==='blocked'}" @click="executionFilter='blocked'">受阻</button></div>
          <section class="execution-center">
            <aside class="execution-list"><button v-for="item in filteredExecutions" :key="item.id" :class="{active:selectedExecution?.id===item.id}" @click="selectedExecutionId=item.id"><i :class="item.status">{{ executionStatusIcon(item.status) }}</i><span><strong>{{ item.name }}</strong><small>{{ item.productName ? `${item.productName} · ${item.versionName}` : '未关联版本的执行' }}</small><em>{{ item.mode === 'agent' ? '动态 Agent' : '固定计划' }} · {{ formatVersionTime(item.startedAt) }} · {{ item.durationMs }}ms</em></span><b>{{ item.environmentName ?? targetHost(item.targetUrl) }}</b></button><div v-if="!filteredExecutions.length" class="empty">当前筛选条件下暂无执行记录</div></aside>
            <article v-if="selectedExecution" class="execution-detail">
              <header><div><span :class="selectedExecution.status">{{ executionStatusText(selectedExecution.status) }}</span><h2>{{ selectedExecution.name }}</h2><p>{{ selectedExecution.targetUrl }}</p></div><span class="action-with-hint" :data-hint="rerunDisabledReason(selectedExecution)"><button :disabled="Boolean(rerunDisabledReason(selectedExecution))" @click="rerunExecution(selectedExecution)">{{ executionRunning ? '执行中…' : selectedExecution.plan ? '重新执行固定计划' : selectedExecution.mode === 'agent' ? '从用例重新发起' : '记录不可重跑' }}</button></span></header>
              <div class="execution-meta"><p><span>执行模式</span><strong>{{ selectedExecution.mode === 'agent' ? '动态 Agent' : '固定计划' }}</strong></p><p><span>源码项目</span><strong>{{ selectedExecution.projectId ?? '未接入源码' }}</strong></p><p><span>关联用例</span><strong>{{ selectedExecution.caseKeys.length }} 条</strong></p><p><span>执行耗时</span><strong>{{ selectedExecution.durationMs }}ms</strong></p></div>
              <div v-if="selectedExecution.rerunOf" class="rerun-note">本次为重新执行 · 来源记录 {{ selectedExecution.rerunOf.slice(0,8) }}</div><div v-if="selectedExecution.error" class="execution-error"><b>{{ selectedExecution.status === 'blocked' ? '受阻原因' : '失败原因' }}</b><code>{{ selectedExecution.error }}</code></div>
              <section v-if="selectedExecution.mode === 'agent' && selectedExecution.agent" class="agent-trajectory">
                <header><div><h3>Agent 决策轨迹</h3><p>{{ selectedExecution.agent.summary }}</p></div><span>{{ selectedExecution.agent.trajectory.length }} 轮 · {{ selectedExecution.agent.passedAssertions.length }}/{{ selectedExecution.caseKeys.length }} 个断言通过</span></header>
                <article v-for="item in selectedExecution.agent.trajectory" :key="`${item.iteration}-${item.snapshotId}`" :class="`decision-${item.decision.type}`">
                  <i>{{ item.iteration }}</i><div class="trajectory-body"><header><strong>{{ decisionTitle(item.decision) }}</strong><code>{{ item.snapshotId.slice(0,8) }}</code></header><p>{{ decisionReason(item.decision) }}</p><div v-if="item.observation" class="observation"><b>观察</b><span>{{ item.observation.title || targetHost(item.observation.url) }} · {{ item.observation.elementCount }} 个交互元素</span><small v-for="element in item.observation.elements.slice(0,6)" :key="element.ref">{{ element.ref }} {{ element.name || element.role }}</small><em v-if="item.observation.messages.length">页面消息：{{ item.observation.messages.join('、') }}</em></div><div v-if="actionDetail(item.decision)" class="action-detail"><b>动作</b><code>{{ actionDetail(item.decision) }}</code></div><div v-if="item.projectContext" class="source-context"><b>源码</b><span>{{ projectContextSummary(item.projectContext) }}</span></div><div v-if="item.result" :class="['tool-result',{failed:!item.result.ok}]"><b>{{ item.result.ok ? '执行成功' : '执行失败' }}</b><span>{{ item.result.message }}</span><em>{{ item.result.durationMs }}ms</em></div></div>
                </article>
              </section>
              <section v-else class="step-detail"><h3>步骤明细</h3><div v-for="step in selectedExecution.steps" :key="step.index"><i :class="step.status">{{ step.status==='passed'?'✓':'×' }}</i><span><strong>步骤 {{ step.index+1 }} · {{ step.action }}</strong><small v-if="step.error">{{ step.error }}</small></span><b>{{ step.durationMs }}ms</b></div></section>
              <footer><a v-if="selectedExecution.tracePath" :href="artifactUrl(selectedExecution.tracePath)">下载 Trace</a><a v-for="shot in selectedExecution.screenshots" :key="shot" :href="artifactUrl(shot)">下载{{ shot.endsWith('failure.png') ? '失败截图' : '步骤截图' }}</a></footer>
            </article>
            <article v-else class="execution-detail empty">执行固定计划或动态 Agent 后，这里会展示详细报告。</article>
          </section>
        </template>
        <template v-else-if="workspaceView==='requirements'">
          <section class="heading hub-heading"><div><small><i></i>{{ analysis.versionName }}</small><h1>需求中心</h1><p>集中查看当前版本的需求风险、规则、页面状态和测试准备度。</p></div><div><button class="primary" @click="workspaceView='version'">打开评审详情</button></div></section>
          <section class="metrics"><article><i class="purple">需</i><p><span>需求总数</span><strong>{{ requirements.length }}</strong><small>当前版本</small></p></article><article><i class="amber">高</i><p><span>高风险</span><strong>{{ requirements.filter(item=>item.risk==='高风险').length }}</strong><small>优先评审</small></p></article><article><i class="blue">规</i><p><span>业务规则</span><strong>{{ memoryRules.length }}</strong><small>具备 PRD 依据</small></p></article><article><i class="green">态</i><p><span>页面状态</span><strong>{{ requirements.reduce((sum,item)=>sum+item.pageStates.length,0) }}</strong><small>交互状态模型</small></p></article></section>
          <section class="requirement-hub"><article v-for="asset in requirementAssets" :key="asset.code"><header><span>{{ asset.code }}</span><b :class="asset.item.risk==='高风险'?'high':asset.item.risk==='中风险'?'medium':'low'">{{ asset.item.risk }}</b></header><h2>{{ asset.item.title }}</h2><p>{{ asset.item.summary }}</p><div><span>规则 {{ asset.item.businessRules.length }}</span><span>状态 {{ asset.item.pageStates.length }}</span><span>问题 {{ asset.item.questions.length }}</span><span>用例 {{ asset.item.testCases.length }}</span></div><footer><small>{{ asset.item.riskReason }}</small><button @click="openRequirement(asset.index)">查看需求详情 →</button></footer></article></section>
        </template>
        <template v-else-if="workspaceView==='cases'">
          <section class="heading hub-heading"><div><small><i></i>{{ analysis.versionName }}</small><h1>用例资产</h1><p>跨需求查看当前版本全部用例，维护执行选择并快速进入测试配置。</p></div><div><button class="primary" @click="workspaceView='version';activeTab='cases'">配置并执行</button></div></section>
          <section class="metrics"><article><i class="purple">例</i><p><span>用例总数</span><strong>{{ caseAssets.length }}</strong><small>当前版本</small></p></article><article><i class="green">✓</i><p><span>可执行</span><strong>{{ caseAssets.filter(asset=>!asset.item.blockedByQuestion).length }}</strong><small>规则已明确</small></p></article><article><i class="amber">?</i><p><span>待确认</span><strong>{{ caseAssets.filter(asset=>asset.item.blockedByQuestion).length }}</strong><small>暂不进入 Agent</small></p></article><article><i class="blue">选</i><p><span>已选择</span><strong>{{ selectedCaseKeys.length }}</strong><small>将用于自动化</small></p></article></section>
          <div class="execution-filters"><button :class="{active:caseAssetFilter==='all'}" @click="caseAssetFilter='all'">全部</button><button :class="{active:caseAssetFilter==='ready'}" @click="caseAssetFilter='ready'">可执行</button><button :class="{active:caseAssetFilter==='blocked'}" @click="caseAssetFilter='blocked'">待确认</button></div>
          <section class="case-assets"><article v-for="asset in filteredCaseAssets" :key="asset.key"><label><input :checked="Boolean(selectedCases[asset.key])" type="checkbox" @change="toggleCaseAsset(asset.key)"/><span>{{ asset.code }}</span></label><div><header><strong>{{ asset.item.title }}</strong><b :class="asset.item.priority.toLowerCase()">{{ asset.item.priority }}</b><em :class="asset.item.blockedByQuestion?'blocked':'ready'">{{ asset.item.blockedByQuestion ? '待确认' : '可执行' }}</em></header><p>{{ asset.requirementTitle }}</p><small>步骤：{{ asset.item.steps.join(' → ') }}</small><footer><span>预期：{{ asset.item.expectedResult }}</span><button @click="openCaseAsset(asset.requirementIndex)">查看并执行 →</button></footer></div></article><div v-if="!filteredCaseAssets.length" class="empty">当前筛选条件下暂无用例</div></section>
        </template>
        <template v-else>
          <section class="heading hub-heading"><div><small><i></i>由真实评审与执行自动沉淀</small><h1>质量记忆</h1><p>汇总已提取业务规则、历史失败和 Agent 使用过的源码线索，避免后续测试重复摸索。</p></div></section>
          <section class="metrics"><article><i class="purple">规</i><p><span>规则记忆</span><strong>{{ memoryRules.length }}</strong><small>来源于当前 PRD</small></p></article><article><i class="amber">!</i><p><span>失败记忆</span><strong>{{ memoryFailures.length }}</strong><small>失败与受阻记录</small></p></article><article><i class="blue">源</i><p><span>源码线索</span><strong>{{ memorySourceUses.length }}</strong><small>Agent 按需读取</small></p></article><article><i class="green">版</i><p><span>历史版本</span><strong>{{ analysisHistory.length }}</strong><small>已持久化分析</small></p></article></section>
          <section class="memory-grid"><article><header><h2>业务规则</h2><span>{{ memoryRules.length }}</span></header><button v-for="(rule,index) in memoryRules" :key="`${rule.requirementIndex}-${index}`" @click="openRequirement(rule.requirementIndex)"><i>规</i><p><strong>{{ rule.description }}</strong><small>{{ rule.requirementTitle }} · {{ rule.evidence }}</small></p></button><div v-if="!memoryRules.length" class="empty">导入 PRD 后自动沉淀业务规则</div></article><article><header><h2>失败与受阻</h2><span>{{ memoryFailures.length }}</span></header><button v-for="failure in memoryFailures" :key="failure.id" @click="openExecution(failure.id)"><i class="warning">!</i><p><strong>{{ failure.name }}</strong><small>{{ executionStatusText(failure.status) }} · {{ failure.error }}</small></p></button><div v-if="!memoryFailures.length" class="empty">暂无失败或受阻经验</div></article><article><header><h2>源码使用线索</h2><span>{{ memorySourceUses.length }}</span></header><button v-for="(source,index) in memorySourceUses" :key="`${source.execution.id}-${index}`" @click="openExecution(source.execution.id)"><i class="source">源</i><p><strong>{{ decisionTitle(source.item.decision) }}</strong><small>{{ source.execution.name }} · {{ projectContextSummary(source.item.projectContext) }}</small></p></button><div v-if="!memorySourceUses.length" class="empty">Agent 请求源码后会记录在这里</div></article></section>
        </template>
      </div>
    </main>
    <Transition name="review-panel">
      <aside v-if="workspaceView==='version' && activeTab==='questions' && questions.length" class="review-workbench" aria-label="人工 Review 工作台">
        <header>
          <div><small>人工参与环节</small><h2>Review 执行口径</h2><p>AI 建议仅作参考；最终口径会先由 AI 转成可验证规则，再进入自动化执行。</p></div>
          <button aria-label="关闭人工 Review 工作台" @click="activeTab='overview'">×</button>
        </header>
        <div class="review-workbench-list">
          <article v-for="(q,index) in questions" :key="`review-${questionKey(index)}`" class="review-card">
            <div class="review-card-head"><span>问题 {{ index + 1 }}</span><em :class="questionResolved(questionKey(index)) ? 'resolved' : 'pending'">{{ questionReviewLabel(questionKey(index)) }}</em></div>
            <h3>{{ q.title }}</h3>
            <p class="review-reason">{{ q.reason }}</p>
            <div class="ai-suggestion"><b>AI 建议（保留）</b><span>{{ q.suggestion }}</span></div>
            <label class="human-final"><span>人工最终口径</span><textarea :value="questionDraft(index)" :disabled="!savedAnalysis || reviewSaving" @input="updateQuestionDraft(index, $event)" placeholder="用业务语言写下最终规则，细节不足也可以，AI 会结合 PRD、源码和 DOM 补全"></textarea></label>
            <div class="review-actions"><button :disabled="!savedAnalysis || reviewContractBusy[questionKey(index)] || reviewSaving" @click="generateQuestionContract(index)">{{ reviewContractBusy[questionKey(index)] ? 'AI 解析中…' : 'AI 转为执行规则' }}</button><button class="primary" :disabled="!savedAnalysis || reviewSaving" @click="saveQuestionReview(index, questionDraft(index).trim() === q.suggestion.trim() ? 'accepted' : 'edited')">确认并保存口径</button><button class="quiet" :disabled="!savedAnalysis || reviewSaving" @click="saveQuestionReview(index, 'deferred')">暂不确认</button></div>
            <section v-if="contractDrafts[questionKey(index)]" class="contract-preview"><header><b>AI 执行规则草案</b><span>{{ contractDrafts[questionKey(index)].confidence === 'high' ? '高置信度' : contractDrafts[questionKey(index)].confidence === 'medium' ? '中置信度' : '低置信度' }}</span></header><p>{{ contractDrafts[questionKey(index)].objective }}</p><dl><dt>触发条件</dt><dd>{{ contractDrafts[questionKey(index)].triggers.join('；') || '未明确' }}</dd><dt>页面行为</dt><dd>{{ contractDrafts[questionKey(index)].behaviors.join('；') }}</dd><dt>可验证断言</dt><dd>{{ contractDrafts[questionKey(index)].assertions.join('；') }}</dd><dt v-if="contractDrafts[questionKey(index)].uncertainties.length">仍需确认</dt><dd v-if="contractDrafts[questionKey(index)].uncertainties.length" class="contract-warning">{{ contractDrafts[questionKey(index)].uncertainties.join('；') }}</dd></dl><small>检查无误后点击“确认并保存口径”，否则不会解除用例阻塞。</small></section>
          </article>
        </div>
      </aside>
    </Transition>
    <button v-if="!liveExecution.visible && liveExecution.executionId" class="live-reopen" @click="reopenLiveExecution"><i></i>{{ liveExecution.execution ? '打开最近执行画面' : '重新打开实时执行' }}</button>
    <Transition name="live-panel">
      <aside v-if="liveExecution.visible" class="live-execution-panel" aria-label="Playwright 实时执行画面">
        <header>
          <div><span :class="liveExecution.status"><i></i>{{ liveStatusText() }}</span><h2>{{ liveExecution.name || '正在启动 Playwright' }}</h2><p>{{ targetHost(liveExecution.targetUrl) }}</p></div>
          <button aria-label="关闭实时执行面板" @click="closeLiveExecution">×</button>
        </header>
        <section class="live-browser-view">
          <img v-if="liveExecution.frameDataUrl" :src="liveExecution.frameDataUrl" alt="Playwright 当前浏览器画面" />
          <div v-else class="live-browser-empty"><i></i><strong>正在连接真实浏览器</strong><span>首帧生成后会自动显示在这里</span></div>
          <span v-if="liveExecution.status==='running'" class="live-badge"><i></i> LIVE</span>
        </section>
        <section v-if="liveExecution.cases.length" class="live-cases">
          <small>本次验证</small>
          <div v-for="testCase in liveExecution.cases.slice(0,3)" :key="testCase.key"><strong>{{ testCase.title }}</strong><span>{{ displayCaseKey(testCase.key) }}</span></div>
          <p v-if="liveExecution.cases.length>3">另有 {{ liveExecution.cases.length-3 }} 条用例</p>
        </section>
        <section class="live-activity">
          <small>当前操作</small>
          <h3>{{ liveExecution.activity?.title ?? (liveExecution.status==='running' ? '正在启动浏览器并恢复登录态' : liveStatusText()) }}</h3>
          <p>{{ liveExecution.activity?.purpose ?? liveExecution.error ?? '等待 Playwright 返回页面状态' }}</p>
          <dl v-if="liveExecution.activity?.technicalAction">
            <dt>技术动作</dt><dd><code>{{ liveExecution.activity.technicalAction }}</code></dd>
            <dt v-if="liveExecution.activity.snapshotId">DOM 快照</dt><dd v-if="liveExecution.activity.snapshotId"><code>{{ liveExecution.activity.snapshotId.slice(0,8) }}</code></dd>
          </dl>
          <div v-if="liveExecution.activity?.message" :class="['live-result',liveExecution.activity.status]"><b>{{ liveExecution.activity.status==='passed'?'✓':liveExecution.activity.status==='failed'?'!':'…' }}</b><span>{{ liveExecution.activity.message }}</span><em v-if="liveExecution.activity.durationMs!==undefined">{{ liveExecution.activity.durationMs }}ms</em></div>
          <div v-if="liveExecution.error" class="live-stream-error"><b>失败说明</b><span>{{ liveExecution.error }}</span></div>
        </section>
        <footer><span>{{ liveExecution.mode==='agent' ? '动态 Agent' : '固定计划' }}</span><button v-if="liveExecution.execution" @click="openLiveReport">查看完整报告</button><em v-else>画面来自 Playwright 当前 Page</em></footer>
      </aside>
    </Transition>
    <Transition name="drawer">
      <div v-if="helpOpen" class="guide-overlay" @click.self="helpOpen=false">
        <aside class="guide-drawer" role="dialog" aria-modal="true" :aria-label="currentGuide.title">
          <header><div><small>{{ workspaceLabel }}</small><h2>{{ currentGuide.title }}</h2></div><button aria-label="关闭使用指引" @click="helpOpen=false">×</button></header>
          <p class="guide-summary">{{ currentGuide.summary }}</p>
          <section><h3>推荐操作顺序</h3><ol><li v-for="(step,index) in currentGuide.steps" :key="step"><b>{{ index+1 }}</b><span>{{ step }}</span></li></ol></section>
          <section><h3>使用前请确认</h3><ul><li v-for="condition in currentGuide.conditions" :key="condition">{{ condition }}</li></ul></section>
          <footer><b>建议</b><span>{{ currentGuide.tip }}</span></footer>
        </aside>
      </div>
    </Transition>
    <Transition name="toast"><div v-if="notice" :class="['toast',`toast-${noticeKind}`]" role="status" aria-live="polite"><b>{{ noticeKind === 'loading' ? '…' : noticeKind === 'error' ? '!' : '✓' }}</b><span>{{ notice }}</span><button aria-label="关闭提示" @click="dismissNotice">×</button></div></Transition>
  </div>
</template>
