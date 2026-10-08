import { ref, type Ref } from 'vue'
import type { PrdAnalysis, QuestionReview, ReviewExecutionContract, SavedAnalysis } from '@quality-ai/contracts'

interface RequirementReviewContext {
  savedAnalysis: Ref<SavedAnalysis | null>
  activeRequirement: Ref<number>
  questions: Readonly<Ref<PrdAnalysis['requirements'][number]['questions']>>
  getSourceContext: () => { caseKey?: string; projectId?: string; targetUrl?: string }
  notify: (message: string) => void
}

/** 管理当前需求版本的问题审核；执行就绪状态仍由服务端最终用例契约决定。 */
export function useRequirementReview(
  { savedAnalysis, activeRequirement, questions, getSourceContext, notify }: RequirementReviewContext,
  request: typeof fetch = fetch,
) {
  const confirmed = ref<Record<string, boolean>>({})
  const selectedCases = ref<Record<string, boolean>>({})
  const questionDrafts = ref<Record<string, string>>({})
  const questionReviews = ref<Record<string, QuestionReview>>({})
  const contractDrafts = ref<Record<string, ReviewExecutionContract>>({})
  const reviewContractBusy = ref<Record<string, boolean>>({})
  const reviewSaving = ref(false)
  let versionEpoch = 0
  const contractRequests = new Map<string, symbol>()

  function questionKey(index: number) { return `${activeRequirement.value}-Q-${index}` }

  function questionResolved(key: string) {
    const review = questionReviews.value[key]
    if (review) return review.status === 'accepted' || review.status === 'edited'
    return Boolean(confirmed.value[key])
  }

  function questionDraft(index: number) {
    const key = questionKey(index)
    return questionDrafts.value[key] ?? questions.value[index]?.suggestion ?? ''
  }
  function updateQuestionDraft(index: number, event: Event) {
    const key = questionKey(index)
    questionDrafts.value[key] = (event.target as HTMLTextAreaElement).value
    delete contractDrafts.value[key]
    contractRequests.delete(key)
    reviewContractBusy.value[key] = false
  }
  function questionReviewLabel(key: string) {
    const review = questionReviews.value[key]
    if (review?.status === 'accepted') return '已采纳 AI 建议'
    if (review?.status === 'edited') return '已保存人工口径'
    if (review?.status === 'deferred') return '暂不确认'
    if (contractDrafts.value[key]) return '执行规则待人工确认'
    return '尚未形成最终口径'
  }

  function applyReview(analysisValue: SavedAnalysis) {
    versionEpoch++
    contractRequests.clear()
    reviewContractBusy.value = {}
    reviewSaving.value = false
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
    const sourceAnalysis = savedAnalysis.value
    const epoch = versionEpoch
    reviewSaving.value = true
    try {
      const response = await request(`/api/analyses/${encodeURIComponent(savedAnalysis.value.id)}/review`, {
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
      if (epoch === versionEpoch && savedAnalysis.value === sourceAnalysis) {
        savedAnalysis.value.review = payload.review
        questionReviews.value = { ...(payload.review.questionReviews ?? {}) }
      }
      return true
    } catch (error) {
      if (epoch === versionEpoch) notify(`评审状态保存失败：${error instanceof Error ? error.message : '未知错误'}`)
      return false
    } finally {
      if (epoch === versionEpoch) reviewSaving.value = false
    }
  }

  async function saveQuestionReview(index: number, status: 'accepted' | 'edited' | 'deferred') {
    if (reviewSaving.value) return
    const epoch = versionEpoch
    const key = questionKey(index)
    const statement = questionDraft(index).trim()
    if (!statement) return notify('请先填写人工最终口径')
    const previousReviews = questionReviews.value
    const previousConfirmed = { ...confirmed.value }
    const nextReviews = { ...questionReviews.value }
    const existing = nextReviews[key]
    const statementChanged = existing?.finalStatement.trim() !== statement
    const contract = contractDrafts.value[key] ?? (statementChanged ? undefined : existing?.executionContract)
    if (status !== 'deferred' && contract?.uncertainties.length) return notify('执行规则仍有不确定项，请补充人工口径后再确认')
    nextReviews[key] = {
      status,
      finalStatement: statement,
      executionContract: contract,
      updatedAt: existing?.updatedAt ?? null,
    }
    questionReviews.value = nextReviews
    if (status === 'deferred') delete confirmed.value[key]
    else confirmed.value[key] = true
    const saved = await saveCurrentReview()
    if (epoch !== versionEpoch) return
    if (!saved) {
      questionReviews.value = previousReviews
      confirmed.value = previousConfirmed
      return
    }
    notify(status === 'deferred' ? '已暂不确认，相关用例仍保持阻塞' : '人工最终口径已保存，相关用例可进入执行准备')
  }
  async function generateQuestionContract(index: number) {
    const sourceAnalysis = savedAnalysis.value
    if (!sourceAnalysis) return notify('请先保存需求分析')
    const key = questionKey(index)
    const finalStatement = questionDraft(index).trim()
    if (!finalStatement) return notify('请先填写人工最终口径')
    const epoch = versionEpoch
    const token = Symbol(key)
    contractRequests.set(key, token)
    const isCurrent = () => epoch === versionEpoch && savedAnalysis.value === sourceAnalysis && contractRequests.get(key) === token
    reviewContractBusy.value[key] = true
    try {
      const sourceContext = getSourceContext()
      const response = await request(`/api/analyses/${encodeURIComponent(sourceAnalysis.id)}/review/contract`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ questionKey: key, finalStatement, ...sourceContext }),
      })
      const payload = await response.json() as { contract?: ReviewExecutionContract; sourceContext?: { warnings?: string[] }; error?: string }
      if (!isCurrent()) return
      if (!response.ok || !payload.contract) throw new Error(payload.error ?? '执行规则生成失败')
      contractDrafts.value[key] = payload.contract
      const warnings = payload.sourceContext?.warnings ?? []
      notify(warnings.length ? `执行规则已生成，但源码辅助有提示：${warnings[0]}` : 'AI 已生成执行规则，请检查后保存人工口径')
    } catch (error) {
      if (isCurrent()) notify(`执行规则生成失败：${error instanceof Error ? error.message : '未知错误'}`)
    } finally {
      if (isCurrent()) {
        reviewContractBusy.value[key] = false
        contractRequests.delete(key)
      }
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

  return {
    confirmed, selectedCases, contractDrafts, reviewContractBusy, reviewSaving,
    questionKey, questionResolved, questionDraft, updateQuestionDraft, questionReviewLabel,
    applyReview, saveCurrentReview, saveQuestionReview, generateQuestionContract, toggleQuestion,
  }
}
