import type {
  AgentAction,
  AgentDecision,
  AutomationPlan,
  ExecutionRecord,
  LiveExecutionEvent,
  LiveExecutionActivity,
  PageSnapshot,
} from './contracts'

type AutomationStep = AutomationPlan['steps'][number]

export interface LiveExecutionState {
  visible: boolean
  status: 'idle' | 'running' | ExecutionRecord['status']
  executionId: string
  mode: 'plan' | 'agent' | null
  name: string
  targetUrl: string
  cases: Array<{ key: string; title: string }>
  frameDataUrl: string
  frameCapturedAt: string
  activity: LiveExecutionActivity | null
  execution: ExecutionRecord | null
  error: string
}

export function createLiveExecutionState(): LiveExecutionState {
  return {
    visible: false,
    status: 'idle',
    executionId: '',
    mode: null,
    name: '',
    targetUrl: '',
    cases: [],
    frameDataUrl: '',
    frameCapturedAt: '',
    activity: null,
    execution: null,
    error: '',
  }
}

export function reduceLiveExecutionState(state: LiveExecutionState, event: LiveExecutionEvent): LiveExecutionState {
  if (event.type === 'execution_started') return {
    ...createLiveExecutionState(),
    visible: true,
    status: 'running',
    executionId: event.executionId,
    mode: event.mode,
    name: event.name,
    targetUrl: event.targetUrl,
    cases: event.cases ?? [],
  }
  if (event.type === 'execution_completed') return {
    ...state,
    visible: true,
    status: event.execution.status,
    executionId: event.execution.id,
    name: event.execution.name,
    targetUrl: event.execution.targetUrl,
    execution: event.execution,
    error: event.execution.error ?? '',
  }
  if (event.type === 'execution_error') {
    if (event.executionId && state.executionId && event.executionId !== state.executionId) return state
    return { ...state, visible: true, status: 'failed', error: event.error }
  }
  if (event.executionId !== state.executionId) return state
  if (event.type === 'browser_frame') return {
    ...state,
    frameDataUrl: event.dataUrl,
    frameCapturedAt: event.capturedAt,
  }
  return { ...state, activity: event.activity }
}

function quoted(value: string) {
  return `“${value}”`
}

function elementName(snapshot: PageSnapshot, ref: string) {
  const element = snapshot.elements.find(item => item.ref === ref)
  return element?.name || element?.label || element?.placeholder || element?.text || ref
}

function targetName(action: AgentAction, snapshot: PageSnapshot) {
  return 'elementRef' in action && action.elementRef ? elementName(snapshot, action.elementRef) : '当前页面'
}

function rawAgentAction(action: AgentAction) {
  if (action.action === 'goto') return `goto ${action.path}`
  if (action.action === 'waitFor') return `waitFor ${action.durationMs}ms`
  if (action.action === 'screenshot') return `screenshot ${action.name}`
  if (action.action === 'expectText') return `expectText ${quoted(action.text)}`
  if (action.action === 'expectHidden') {
    const target = action.target.by === 'elementRef'
      ? action.target.elementRef
      : action.target.by === 'text'
        ? `text=${quoted(action.target.text)}`
        : `role=${action.target.role}${action.target.name ? ` name=${quoted(action.target.name)}` : ''}`
    return `expectHidden ${target}`
  }
  if (action.action === 'expectCount') {
    return `expectCount ${action.containerRef ? `${action.containerRef} ` : ''}role=${action.role}${action.name ? ` name=${quoted(action.name)}` : ''} count=${action.count}`
  }
  if (action.action === 'scroll') return `scroll ${action.elementRef ?? 'page'} x=${action.deltaX} y=${action.deltaY}`
  if ('elementRef' in action) {
    if (action.action === 'fill' || action.action === 'selectOption' || action.action === 'expectValue') return `${action.action} ${action.elementRef} ${action.value !== undefined ? quoted(action.value) : `valueRef=${action.valueRef}`}`
    if (action.action === 'press') return `press ${action.elementRef} ${action.key}`
    if (action.action === 'expectChecked') return `expectChecked ${action.elementRef} ${action.checked}`
    if (action.action === 'expectElementText') return `expectElementText ${action.elementRef} ${quoted(action.text)}`
    if (action.action === 'expectAttribute') return `expectAttribute ${action.elementRef} ${action.name} ${action.match} ${quoted(action.value)}`
    return `${action.action} ${action.elementRef}`
  }
  const exhaustiveAction: never = action
  return String(exhaustiveAction)
}

function readableAgentAction(action: AgentAction, snapshot: PageSnapshot) {
  const name = targetName(action, snapshot)
  const value = 'value' in action && action.value !== undefined ? quoted(action.value) : 'valueRef' in action ? `已解析数据“${action.valueRef}”` : ''
  if (action.action === 'goto') return `打开页面 ${quoted(action.path)}`
  if (action.action === 'click') return `点击${quoted(name)}`
  if (action.action === 'fill') return `在${quoted(name)}中输入${value}`
  if (action.action === 'selectOption') return `在${quoted(name)}中选择${value}`
  if (action.action === 'check') return `选中${quoted(name)}`
  if (action.action === 'uncheck') return `取消选中${quoted(name)}`
  if (action.action === 'press') return `在${quoted(name)}上按下 ${action.key}`
  if (action.action === 'hover') return `将鼠标移到${quoted(name)}`
  if (action.action === 'scroll') return action.elementRef ? `滚动${quoted(name)}` : '滚动当前页面'
  if (action.action === 'expectVisible') return `确认${quoted(name)}已经显示`
  if (action.action === 'expectHidden') return '确认目标内容已经隐藏'
  if (action.action === 'expectEnabled') return `确认${quoted(name)}可以操作`
  if (action.action === 'expectDisabled') return `确认${quoted(name)}不可操作`
  if (action.action === 'expectChecked') return `确认${quoted(name)}${action.checked ? '已选中' : '未选中'}`
  if (action.action === 'expectValue') return `确认${quoted(name)}的值为${value}`
  if (action.action === 'expectText') return `确认页面出现${quoted(action.text)}`
  if (action.action === 'expectElementText') return `确认${quoted(name)}包含${quoted(action.text)}`
  if (action.action === 'expectAttribute') return `确认${quoted(name)}的 ${action.name} 状态`
  if (action.action === 'expectCount') return `确认页面中 ${action.role} 的数量为 ${action.count}`
  if (action.action === 'waitFor') return `等待页面加载 ${action.durationMs / 1_000} 秒`
  return `保存当前页面截图${quoted(action.name)}`
}

export function describeAgentDecision(decision: AgentDecision, snapshot: PageSnapshot, iteration: number): LiveExecutionActivity {
  const base = {
    id: `${snapshot.snapshotId}:${iteration}`,
    iteration,
    snapshotId: snapshot.snapshotId,
    status: 'running' as const,
  }
  if (decision.type === 'action') return {
    ...base,
    phase: 'executing',
    title: readableAgentAction(decision.action, snapshot),
    purpose: decision.reason,
    technicalAction: rawAgentAction(decision.action),
  }
  if (decision.type === 'need_project_context') return {
    ...base,
    phase: 'reading_source',
    title: decision.request.operation === 'resolve_route' ? '根据地址查找页面路由' : decision.request.operation === 'search_source' ? '搜索相关页面源码' : '读取相关页面局部源码',
    purpose: decision.reason,
    technicalAction: decision.request.operation,
  }
  if (decision.type === 'resolve_test_data') return {
    ...base,
    phase: 'deciding',
    title: `从${quoted(elementName(snapshot, decision.sourceElementRef))}解析测试数据${quoted(decision.value)}`,
    purpose: decision.reason,
    technicalAction: `resolve_test_data ${decision.bindingId} source=${decision.sourceElementRef} value=${quoted(decision.value)}`,
  }
  if (decision.type === 'finish') return { ...base, phase: 'completed', title: '测试目标已完成', purpose: decision.summary, status: 'passed' }
  return { ...base, phase: 'blocked', title: '测试暂时无法继续', purpose: decision.reason, status: 'failed' }
}

function locatorDetail(locator: Extract<AutomationStep, { action: 'click' | 'fill' }>['locator']) {
  return `${locator.by}=${locator.value}${locator.name ? ` name=${quoted(locator.name)}` : ''}`
}

export function describeAutomationStep(step: AutomationStep, index: number): LiveExecutionActivity {
  let title: string
  let technicalAction: string
  if (step.action === 'goto') {
    title = `打开页面${quoted(step.path)}`
    technicalAction = `goto ${step.path}`
  } else if (step.action === 'click') {
    title = `点击${quoted(step.locator.name ?? step.locator.value)}`
    technicalAction = `click ${locatorDetail(step.locator)}`
  } else if (step.action === 'check' || step.action === 'uncheck' || step.action === 'hover' || step.action === 'press') {
    const names={check:'勾选',uncheck:'取消勾选',hover:'悬停到',press:'按键操作'}
    title = `${names[step.action]}${quoted(step.locator.name ?? step.locator.value)}${step.action==='press'?`：${step.key}`:''}`
    technicalAction = JSON.stringify(step)
  } else if (step.action === 'uploadFile') {
    title = `向${quoted(step.locator.name ?? step.locator.value)}上传已确认附件 ${step.fixtureId}`
    technicalAction = JSON.stringify(step)
  } else if (step.action === 'selectOption') {
    title = `在${quoted(step.locator.name ?? step.locator.value)}中按${step.optionBy==='label'?'显示名称':'选项值'}选择${quoted(step.value)}`
    technicalAction = JSON.stringify(step)
  } else if (step.action === 'fill') {
    title = `在${quoted(step.locator.name ?? step.locator.value)}中输入${step.valueRef?`运行时数据 ${step.valueRef}`:quoted(step.value??'')}`
    technicalAction = `fill ${locatorDetail(step.locator)} ${step.valueRef?`valueRef=${step.valueRef}`:quoted(step.value??'')}`
  } else if (step.action === 'expectText') {
    title = `确认页面出现${step.valueRef?`运行时数据 ${step.valueRef}`:quoted(step.text??'')}`
    technicalAction = `expectText ${step.valueRef?`valueRef=${step.valueRef}`:quoted(step.text??'')}`
  } else if(step.action==='resolveTestData'){
    title=`从当前页面解析测试数据 ${step.bindingId}`
    technicalAction=`resolveTestData ${step.bindingId}`
  } else if('locator' in step){
    const names={expectVisible:'可见',expectHidden:'隐藏',expectEnabled:'可操作',expectDisabled:'不可操作',expectChecked:step.action==='expectChecked'&&step.checked?'已选中':'未选中',expectValue:'输入值符合预期',expectElementText:step.action==='expectElementText'?`文本${step.exact?'等于':'包含'}${quoted(step.text)}`:'文本符合预期',expectAttribute:'属性符合预期'}
    title=`确认${quoted(step.locator.name??step.locator.value)}${names[step.action]}`
    technicalAction=JSON.stringify(step)
  } else {
    title = `保存当前页面截图${quoted(step.name)}`
    technicalAction = `screenshot ${step.name}`
  }
  if ('locator' in step && step.locator.scope?.length) {
    title = `在${step.locator.scope.map(scope=>quoted(scope.name??scope.value)).join(' → ')}范围内：${title}`
    technicalAction = JSON.stringify(step)
  }
  return {
    id: `plan-step:${index}`,
    phase: 'executing',
    title,
    purpose: `执行固定计划的第 ${index + 1} 步`,
    technicalAction,
    status: 'running',
  }
}

export function encodeNdjsonEvent(value: unknown) {
  return `${JSON.stringify(value)}\n`
}

export function consumeNdjsonChunk<T = unknown>(remainder: string, chunk: string): { values: T[]; remainder: string } {
  const lines = `${remainder}${chunk}`.split('\n')
  const nextRemainder = lines.pop() ?? ''
  return {
    values: lines.filter(line => line.trim()).map(line => JSON.parse(line) as T),
    remainder: nextRemainder,
  }
}
