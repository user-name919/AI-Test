import { z } from 'zod'

export const riskSchema = z.enum(['高风险', '中风险', '低风险'])
export const prioritySchema = z.enum(['P0', 'P1', 'P2'])

export const requirementAnalysisSchema = z.object({
  title: z.string().min(1),
  summary: z.string().min(1),
  risk: riskSchema,
  riskReason: z.string().min(1),
  businessRules: z.array(z.object({
    description: z.string().min(1),
    evidence: z.string().min(1),
  })).min(1),
  pageStates: z.array(z.object({
    trigger: z.string().min(1),
    initialState: z.string().min(1),
    interaction: z.string().min(1),
    expectedResult: z.string().min(1),
  })).min(1),
  questions: z.array(z.object({
    title: z.string().min(1),
    reason: z.string().min(1),
    suggestion: z.string().min(1),
  })),
  testCases: z.array(z.object({
    title: z.string().min(1),
    type: z.enum(['主流程', '分支', '边界', '异常', '回归', '交互', '空数据', '数据契约']),
    priority: prioritySchema,
    preconditions: z.array(z.string()),
    steps: z.array(z.string()).min(1),
    expectedResult: z.string().min(1),
    blockedByQuestion: z.boolean(),
    questionIds: z.array(z.string().regex(/^\d+-Q-\d+$/)).optional(),
  })).min(1),
})

export const prdAnalysisSchema = z.object({
  versionName: z.string().min(1),
  productName: z.string().min(1),
  overview: z.string().min(1),
  requirements: z.array(requirementAnalysisSchema).min(1),
})

export type PrdAnalysis = z.infer<typeof prdAnalysisSchema>

export type RequirementAnalysis = PrdAnalysis['requirements'][number]

export interface ReviewExecutionContract {
  objective: string
  triggers: string[]
  preconditions: string[]
  behaviors: string[]
  assertions: string[]
  forbiddenBehaviors: string[]
  sourceHints: string[]
  uncertainties: string[]
  confidence: 'high' | 'medium' | 'low'
}

export type QuestionReviewStatus = 'accepted' | 'edited' | 'deferred'

export interface QuestionReview {
  status: QuestionReviewStatus
  finalStatement: string
  executionContract?: ReviewExecutionContract
  updatedAt: string | null
}

export type TestDataSourceMode = 'runtime_dom' | 'fixture' | 'manual'

export interface TestDataBinding {
  id: string
  label: string
  mode: TestDataSourceMode
  targetHint: string
  businessIntent: string
  strategy?: 'visible_option_full' | 'visible_option_substring' | 'non_matching_option_query'
  optionUniverse?: {
    completeness: 'complete_local' | 'partial_or_remote' | 'unknown'
    options: string[]
    evidence: string
  }
  constraints: {
    mustComeFromCurrentDom: boolean
    mustBePartialOfSource?: boolean
    mustRemainAfterFiltering?: boolean
  }
  fixture?: {
    value: string
    evidence: string
  }
  manual?: {
    value: string
    rationale: string
  }
}

export interface CaseExecutionContract {
  objective: string
  preconditions: string[]
  steps: string[]
  expectedAssertions: string[]
  dataBindings: TestDataBinding[]
  forbiddenBehaviors: string[]
  uncertainties: string[]
}

export interface CaseReview {
  status: 'draft' | 'confirmed' | 'needs_data_review'
  finalContract: CaseExecutionContract
  updatedAt: string | null
}

export interface ResolvedDataBinding {
  bindingId: string
  sourceElementRef: string
  sourceText: string
  value: string
  snapshotId: string
  observedAt: string
  reason: string
}

export interface ResolvedCaseExecutionContract {
  caseKey: string
  requirementIndex: number
  caseIndex: number
  title: string
  contract: CaseExecutionContract
  questionAssociation: {
    mode: 'explicit' | 'legacy_requirement'
    questionKeys: string[]
    warning?: string
  }
  resolvedQuestions: Array<{
    questionKey: string
    finalStatement: string
    questionTitle: string
    objective?: string
    triggers: string[]
    behaviors: string[]
    assertions: string[]
    forbiddenBehaviors: string[]
    sourceHints: string[]
    uncertainties: string[]
    confidence?: ReviewExecutionContract['confidence']
  }>
  readiness: {
    agent: { executable: boolean; reason?: string }
    plan: { executable: boolean; reason?: string }
  }
  contractFingerprint: string
}

export type ExecutionStatus = 'passed' | 'failed' | 'blocked' | 'infrastructure_failed' | 'cancelled'

export const reviewExecutionContractSchema = z.object({
  objective: z.string().min(1),
  triggers: z.array(z.string().min(1)),
  preconditions: z.array(z.string().min(1)),
  behaviors: z.array(z.string().min(1)).min(1),
  assertions: z.array(z.string().min(1)).min(1),
  forbiddenBehaviors: z.array(z.string().min(1)),
  sourceHints: z.array(z.string().min(1)),
  uncertainties: z.array(z.string().min(1)),
  confidence: z.enum(['high', 'medium', 'low']),
})

export const questionReviewSchema = z.object({
  status: z.enum(['accepted', 'edited', 'deferred']),
  finalStatement: z.string().min(1),
  executionContract: reviewExecutionContractSchema.optional(),
  updatedAt: z.string().nullable().default(null),
})

const dataBindingBaseSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  targetHint: z.string().min(1),
  businessIntent: z.string().min(1),
  strategy: z.enum(['visible_option_full', 'visible_option_substring', 'non_matching_option_query']).optional(),
  optionUniverse: z.object({
    completeness: z.enum(['complete_local', 'partial_or_remote', 'unknown']),
    options: z.array(z.string().min(1)),
    evidence: z.string(),
  }).optional(),
  constraints: z.object({
    mustComeFromCurrentDom: z.boolean(),
    mustBePartialOfSource: z.boolean().optional(),
    mustRemainAfterFiltering: z.boolean().optional(),
  }),
  fixture: z.object({
    value: z.string().optional().default(''),
    evidence: z.string().optional().default(''),
  }).optional(),
  manual: z.object({
    value: z.string().optional().default(''),
    rationale: z.string().optional().default(''),
  }).optional(),
})

export const testDataBindingSchema = dataBindingBaseSchema.extend({
  mode: z.enum(['runtime_dom', 'fixture', 'manual']),
}).superRefine((binding, context) => {
  if (binding.mode === 'runtime_dom') {
    if (binding.fixture || binding.manual) {
      context.addIssue({ code: 'custom', message: '运行时 DOM 数据不能预填固定值', path: ['mode'] })
    }
    if (!binding.strategy) {
      context.addIssue({ code: 'custom', message: '运行时 DOM 数据必须声明搜索策略', path: ['strategy'] })
    }
    if (!binding.constraints.mustComeFromCurrentDom) {
      context.addIssue({ code: 'custom', message: '运行时 DOM 数据必须来自当前 DOM', path: ['constraints', 'mustComeFromCurrentDom'] })
    }
    if (binding.strategy === 'visible_option_substring' && !binding.constraints.mustBePartialOfSource) {
      context.addIssue({ code: 'custom', message: '运行时 DOM 数据必须是来源 option 的子串', path: ['constraints', 'mustBePartialOfSource'] })
    }
    if (binding.strategy !== 'visible_option_substring' && binding.constraints.mustBePartialOfSource) {
      context.addIssue({ code: 'custom', message: '完整和无匹配搜索不能声明必须为子串', path: ['constraints', 'mustBePartialOfSource'] })
    }
    if (binding.strategy === 'non_matching_option_query' && binding.constraints.mustRemainAfterFiltering) {
      context.addIssue({ code: 'custom', message: '无匹配搜索不能要求来源选项仍存在', path: ['constraints', 'mustRemainAfterFiltering'] })
    }
  }
  if (binding.mode === 'fixture' && binding.manual) {
    context.addIssue({ code: 'custom', message: 'fixture 数据不能包含人工值', path: ['manual'] })
  }
  if (binding.mode === 'manual' && binding.fixture) {
    context.addIssue({ code: 'custom', message: 'manual 数据不能包含固定夹具', path: ['fixture'] })
  }
})

export const caseExecutionContractSchema = z.object({
  objective: z.string().min(1),
  preconditions: z.array(z.string().min(1)),
  steps: z.array(z.string().min(1)).min(1),
  expectedAssertions: z.array(z.string().min(1)).min(1),
  dataBindings: z.array(testDataBindingSchema),
  forbiddenBehaviors: z.array(z.string().min(1)),
  uncertainties: z.array(z.string().min(1)),
})

export const caseReviewSchema = z.object({
  status: z.enum(['draft', 'confirmed', 'needs_data_review']),
  finalContract: caseExecutionContractSchema,
  updatedAt: z.string().nullable().default(null),
})

export interface SavedAnalysis {
  id: string
  fileName: string
  fileNames: string[]
  provider: string
  model: string
  createdAt: string
  result: PrdAnalysis
  review: ReviewState
}

export interface AnalysisSummary {
  id: string
  versionName: string
  productName: string
  requirementCount: number
  questionCount: number
  confirmedQuestionCount: number
  testCaseCount: number
  selectedCaseCount: number
  provider: string
  model: string
  createdAt: string
}

export interface ReviewState {
  confirmedQuestions: string[]
  selectedCases: string[]
  questionReviews?: Record<string, QuestionReview>
  caseReviews?: Record<string, CaseReview>
  updatedAt: string | null
}

export const reviewStateSchema = z.object({
  confirmedQuestions: z.array(z.string()).default([]),
  selectedCases: z.array(z.string()).default([]),
  questionReviews: z.record(z.string(), questionReviewSchema).default({}),
  caseReviews: z.record(z.string(), caseReviewSchema).default({}),
  updatedAt: z.string().nullable().default(null),
})

export const locatorSchema = z.object({
  by: z.enum(['role', 'label', 'text', 'css']),
  value: z.string().min(1),
  name: z.string().optional(),
})

export const automationStepSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('goto'), path: z.string().min(1) }),
  z.object({ action: z.literal('click'), locator: locatorSchema }),
  z.object({ action: z.literal('fill'), locator: locatorSchema, value: z.string() }),
  z.object({ action: z.literal('expectText'), text: z.string().min(1) }),
  z.object({ action: z.literal('screenshot'), name: z.string().min(1) }),
])

export const automationPlanSchema = z.object({
  name: z.string().min(1),
  targetUrl: z.string().url(),
  steps: z.array(automationStepSchema).min(1).max(50),
  casePlans: z.array(z.object({
    caseKey: z.string().regex(/^(?:\d+-TC-\d+|published:[a-zA-Z0-9_-]+:[a-zA-Z0-9_-]+|regression:[a-f0-9-]{36}:[1-9]\d*:\d+)$/),
    title: z.string().min(1),
    contractFingerprint: z.string().min(1),
    contract: caseExecutionContractSchema.optional(),
    steps: z.array(automationStepSchema).min(1).max(50),
  })).min(1).max(20).optional(),
})

export type AutomationPlan = z.infer<typeof automationPlanSchema>

export interface SavedAutomationPlan {
  id: string
  analysisId: string
  caseKeys: string[]
  createdAt: string
  plan: AutomationPlan
}

export interface TestEnvironment {
  id: string
  name: string
  baseUrl: string
  targetUrl: string
  hasStorageState: boolean
  createdAt: string
  updatedAt: string
}

export const storageStateSchema = z.object({
  cookies: z.array(z.object({
    name: z.string(), value: z.string(), domain: z.string(), path: z.string(),
    expires: z.number(), httpOnly: z.boolean(), secure: z.boolean(), sameSite: z.enum(['Strict', 'Lax', 'None']),
  }).passthrough()),
  origins: z.array(z.object({
    origin: z.string().url(),
    localStorage: z.array(z.object({ name: z.string(), value: z.string() })),
  })),
})

export interface ExecutionCaseSnapshot {
  caseId: string
  revision: number
  analysisId?: string
  source?: import('./case-assets').CaseSource
  capturedAt: string
  resolved: ResolvedCaseExecutionContract
}

export interface ExecutionResult {
  deploymentConfirmation?: import('./regressions').DeploymentConfirmation
  id: string
  name: string
  targetUrl: string
  status: ExecutionStatus
  mode?: 'plan' | 'agent'
  startedAt: string
  finishedAt: string
  durationMs: number
  steps: Array<{ index: number; action: string; status: 'passed' | 'failed'; durationMs: number; error?: string }>
  screenshots: string[]
  tracePath?: string
  error?: string
  caseResults?: CaseExecutionResult[]
  caseSnapshots?: ExecutionCaseSnapshot[]
  sourceProject?: { id: string; branch?: string; commit?: string }
  agent?: {
    summary: string
    passedAssertions: string[]
    trajectory: Array<{
      iteration: number
      snapshotId: string
      decision: AgentDecision
      observation?: {
        url: string
        title: string
        elementCount: number
        elements: Array<{ ref: string; role: string; name: string }>
        dialogs: string[]
        messages: string[]
      }
      result?: ToolResult
      projectContext?: unknown
      resolvedDataBinding?: ResolvedDataBinding
      recovery?: { attempt: number; limit: number; status: 'reobserved' | 'exhausted' | 'observation_failed'; reason: string }
    }>
  }
}

export interface CaseExecutionResult {
  caseKey: string
  title: string
  contractFingerprint: string
  status: ExecutionStatus | 'not_run'
  startedFromUrl: string
  startedFromSnapshotId?: string
  continuation: 'reused_current_page' | 'agent_recovered_page' | 'not_started'
  resolvedDataBindings: ResolvedDataBinding[]
  passedAssertions: string[]
  trajectory: NonNullable<ExecutionResult['agent']>['trajectory']
  steps: ExecutionResult['steps']
  screenshots: string[]
  tracePath?: string
  error?: string
}

export interface ExecutionRecord extends ExecutionResult {
  analysisId?: string
  automationPlanId?: string
  environmentId?: string
  projectId?: string
  caseKeys: string[]
  plan?: AutomationPlan
  versionName?: string
  productName?: string
  environmentName?: string
  rerunOf?: string
  caseResults?: CaseExecutionResult[]
}

export interface LiveExecutionActivity {
  id: string
  phase: 'observing' | 'deciding' | 'reading_source' | 'executing' | 'completed' | 'blocked'
  title: string
  purpose: string
  technicalAction?: string
  iteration?: number
  snapshotId?: string
  status: 'running' | 'passed' | 'failed' | 'info'
  durationMs?: number
  message?: string
}

export type LiveExecutionEvent =
  | {
    type: 'execution_started'
    executionId: string
    mode: 'plan' | 'agent'
    name: string
    targetUrl: string
    cases?: Array<{ key: string; title: string }>
  }
  | { type: 'activity'; executionId: string; caseKey?: string; caseTitle?: string; activity: LiveExecutionActivity }
  | { type: 'browser_frame'; executionId: string; caseKey?: string; caseTitle?: string; dataUrl: string; capturedAt: string }
  | { type: 'execution_completed'; execution: ExecutionRecord }
  | { type: 'execution_error'; executionId?: string; error: string }

export const semanticElementSchema = z.object({
  ref: z.string().regex(/^e\d+$/),
  tag: z.string().min(1),
  role: z.string().min(1),
  name: z.string(),
  label: z.string().optional(),
  placeholder: z.string().optional(),
  value: z.string().optional(),
  text: z.string().optional(),
  textTruncated: z.boolean().optional(),
  nameTruncated: z.boolean().optional(),
  visible: z.boolean(),
  enabled: z.boolean(),
  checked: z.boolean().optional(),
  selected: z.boolean().optional(),
  expanded: z.boolean().optional(),
  required: z.boolean().optional(),
  container: z.string().optional(),
})

export const pageSnapshotSchema = z.object({
  snapshotId: z.string().uuid(),
  observedAt: z.string().datetime(),
  url: z.string(),
  title: z.string(),
  loading: z.boolean(),
  elements: z.array(semanticElementSchema),
  dialogs: z.array(z.object({
    ref: z.string().regex(/^d\d+$/),
    title: z.string(),
    modal: z.boolean(),
  })),
  tables: z.array(z.object({
    ref: z.string().regex(/^t\d+$/),
    name: z.string(),
    columns: z.array(z.string()),
    rowCount: z.number().int().nonnegative(),
    sampleRows: z.array(z.array(z.string())),
  })),
  messages: z.array(z.object({
    type: z.enum(['alert', 'status', 'error', 'message', 'notification']),
    text: z.string().min(1),
  })),
  stats: z.object({
    discoveredElements: z.number().int().nonnegative(),
    returnedElements: z.number().int().nonnegative(),
    truncated: z.boolean(),
  }),
})

export type SemanticElement = z.infer<typeof semanticElementSchema>
export type PageSnapshot = z.infer<typeof pageSnapshotSchema>

export const agentTestGoalSchema = z.object({
  name: z.string().min(1),
  targetUrl: z.string().url(),
  objective: z.string().min(1),
  requiredAssertions: z.array(z.object({
    id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/),
    description: z.string().min(1),
  })).min(1).max(20),
  executionContract: z.object({
    caseKey: z.string().regex(/^(?:\d+-TC-\d+|published:[a-zA-Z0-9_-]+:[a-zA-Z0-9_-]+|regression:[a-f0-9-]{36}:[1-9]\d*:\d+)$/),
    contract: caseExecutionContractSchema,
    contractFingerprint: z.string().min(1),
  }).optional(),
  resolvedQuestions: z.array(z.object({
    questionKey: z.string(), questionTitle: z.string(), finalStatement: z.string(),
    objective: z.string().optional(), triggers: z.array(z.string()), behaviors: z.array(z.string()).optional(),
    assertions: z.array(z.string()), forbiddenBehaviors: z.array(z.string()), sourceHints: z.array(z.string()),
    uncertainties: z.array(z.string()), confidence: z.enum(['high', 'medium', 'low']).optional(),
  })).optional(),
  previousCaseSummaries: z.array(z.object({
    caseKey: z.string(), title: z.string(), status: z.enum(['passed', 'failed', 'blocked', 'infrastructure_failed', 'cancelled', 'not_run']),
    summary: z.string(), actions: z.array(z.string()),
  })).optional(),
  sessionContinuation: z.string().optional(),
})

export const agentRunRequestSchema = z.object({
  analysisId: z.string().uuid(),
  caseKeys: z.array(z.string().regex(/^\d+-TC-\d+$/)).min(1).max(20),
  targetUrl: z.string().url(),
  environmentId: z.string().uuid().optional(),
  projectId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
}).superRefine((value, context) => {
  if (new Set(value.caseKeys).size !== value.caseKeys.length) {
    context.addIssue({ code: 'custom', path: ['caseKeys'], message: '测试用例不能重复' })
  }
})

const elementActionBase = {
  elementRef: z.string().regex(/^e\d+$/),
}

const keyboardKeySchema = z.enum([
  'Enter', 'Escape', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Home', 'End', 'PageUp', 'PageDown', 'Backspace', 'Delete', 'Space',
])

const semanticRoleSchema = z.enum([
  'alert', 'button', 'cell', 'checkbox', 'combobox', 'dialog', 'grid', 'gridcell',
  'heading', 'link', 'listbox', 'listitem', 'menu', 'menuitem', 'option', 'radio',
  'row', 'status', 'switch', 'tab', 'textbox', 'tree', 'treeitem',
])

const hiddenTargetSchema = z.discriminatedUnion('by', [
  z.object({ by: z.literal('elementRef'), ...elementActionBase }),
  z.object({ by: z.literal('text'), text: z.string().min(1), exact: z.boolean().default(false) }),
  z.object({ by: z.literal('role'), role: semanticRoleSchema, name: z.string().optional(), exact: z.boolean().default(false) }),
])

const assertableAttributeSchema = z.enum([
  'aria-checked', 'aria-current', 'aria-disabled', 'aria-expanded', 'aria-invalid',
  'aria-selected', 'class', 'data-state', 'role',
])

const valueReferenceFields = {
  value: z.string().optional(),
  valueRef: z.string().min(1).optional(),
}

function requireExactlyOneValueReference(
  action: { value?: string; valueRef?: string },
  context: z.RefinementCtx,
) {
  if ((action.value === undefined) === (action.valueRef === undefined)) {
    context.addIssue({
      code: 'custom',
      message: 'value 与 valueRef 必须且只能提供一个',
      path: ['value'],
    })
  }
}

export const agentActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('goto'), path: z.string().min(1) }),
  z.object({ action: z.literal('click'), ...elementActionBase }),
  z.object({ action: z.literal('fill'), ...elementActionBase, ...valueReferenceFields }).superRefine(requireExactlyOneValueReference),
  z.object({ action: z.literal('selectOption'), ...elementActionBase, ...valueReferenceFields }).superRefine(requireExactlyOneValueReference),
  z.object({ action: z.literal('check'), ...elementActionBase }),
  z.object({ action: z.literal('uncheck'), ...elementActionBase }),
  z.object({ action: z.literal('press'), ...elementActionBase, key: keyboardKeySchema }),
  z.object({ action: z.literal('hover'), ...elementActionBase }),
  z.object({
    action: z.literal('scroll'),
    elementRef: elementActionBase.elementRef.optional(),
    deltaX: z.number().int().min(-3_000).max(3_000).default(0),
    deltaY: z.number().int().min(-3_000).max(3_000),
  }),
  z.object({ action: z.literal('expectVisible'), ...elementActionBase, assertionId: z.string().min(1) }),
  z.object({ action: z.literal('expectHidden'), target: hiddenTargetSchema, assertionId: z.string().min(1) }),
  z.object({ action: z.literal('expectEnabled'), ...elementActionBase, assertionId: z.string().min(1) }),
  z.object({ action: z.literal('expectDisabled'), ...elementActionBase, assertionId: z.string().min(1) }),
  z.object({ action: z.literal('expectChecked'), ...elementActionBase, checked: z.boolean(), assertionId: z.string().min(1) }),
  z.object({ action: z.literal('expectValue'), ...elementActionBase, ...valueReferenceFields, assertionId: z.string().min(1) }).superRefine(requireExactlyOneValueReference),
  z.object({ action: z.literal('expectText'), text: z.string().min(1), assertionId: z.string().min(1) }),
  z.object({ action: z.literal('expectElementText'), ...elementActionBase, text: z.string().min(1), exact: z.boolean().default(false), assertionId: z.string().min(1) }),
  z.object({
    action: z.literal('expectAttribute'),
    ...elementActionBase,
    name: assertableAttributeSchema,
    value: z.string(),
    match: z.enum(['equals', 'contains']).default('equals'),
    assertionId: z.string().min(1),
  }),
  z.object({
    action: z.literal('expectCount'),
    containerRef: elementActionBase.elementRef.optional(),
    role: semanticRoleSchema,
    name: z.string().optional(),
    exact: z.boolean().default(false),
    count: z.number().int().min(0).max(1_000),
    assertionId: z.string().min(1),
  }),
  z.object({ action: z.literal('waitFor'), durationMs: z.number().int().min(100).max(5_000) }),
  z.object({ action: z.literal('screenshot'), name: z.string().min(1) }),
])

export const projectContextRequestSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('resolve_route'), url: z.string().url() }),
  z.object({
    operation: z.literal('search_source'),
    query: z.string().min(2),
    scopes: z.array(z.enum(['route', 'page', 'component', 'api'])).optional(),
  }),
  z.object({
    operation: z.literal('inspect_files'),
    paths: z.array(z.string().min(1)).min(1).max(5),
  }),
])

export const agentDecisionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('action'),
    snapshotId: z.string().uuid(),
    action: agentActionSchema,
    reason: z.string().min(1),
  }),
  z.object({
    type: z.literal('need_project_context'),
    request: projectContextRequestSchema,
    reason: z.string().min(1),
  }),
  z.object({
    type: z.literal('resolve_test_data'),
    snapshotId: z.string().uuid(),
    bindingId: z.string().min(1),
    sourceElementRef: z.string().regex(/^e\d+$/),
    value: z.string().min(1),
    reason: z.string().min(1),
  }),
  z.object({ type: z.literal('finish'), summary: z.string().min(1) }),
  z.object({ type: z.literal('blocked'), reason: z.string().min(1) }),
])

export const toolResultSchema = z.object({
  ok: z.boolean(),
  code: z.string().min(1),
  retryable: z.boolean(),
  message: z.string(),
  durationMs: z.number().int().nonnegative(),
  pageChanged: z.boolean(),
  screenshotPath: z.string().optional(),
})

export type AgentTestGoal = z.infer<typeof agentTestGoalSchema>
export type AgentRunRequest = z.infer<typeof agentRunRequestSchema>
export type AgentAction = z.infer<typeof agentActionSchema>
export type AgentDecision = z.infer<typeof agentDecisionSchema>
export type ValueReference = { valueRef: string }
export type ResolveTestDataDecision = Extract<AgentDecision, { type: 'resolve_test_data' }>
export type ProjectContextRequest = z.infer<typeof projectContextRequestSchema>
export type ToolResult = z.infer<typeof toolResultSchema>
