import { onScopeDispose, ref, watch, type Ref } from 'vue'
import type { ResolvedCaseExecutionContract, SavedAnalysis } from '@quality-ai/contracts'

/** 用例就绪状态只读服务端结果；刷新/保存时失效，不回退到原始布尔标记。 */
export function useCaseContracts(analysis: Ref<SavedAnalysis | null>, request: typeof fetch = fetch) {
  const contracts = ref<Record<string, ResolvedCaseExecutionContract>>({})
  const loading = ref(false)
  const error = ref('')
  let generation = 0
  let controller: AbortController | undefined

  async function reload() {
    const current = ++generation
    controller?.abort()
    contracts.value = {}
    error.value = ''
    const id = analysis.value?.id
    loading.value = Boolean(id)
    if (!id) return
    controller = new AbortController()
    try {
      const response = await request(`/api/analyses/${encodeURIComponent(id)}/case-contracts`, { signal: controller.signal })
      const payload = await response.json() as { caseContracts?: ResolvedCaseExecutionContract[]; error?: string }
      if (!response.ok || !Array.isArray(payload.caseContracts)) throw new Error(payload.error ?? '用例执行口径加载失败')
      if (current !== generation) return
      contracts.value = Object.fromEntries(payload.caseContracts.map(contract => [contract.caseKey, contract]))
    } catch (cause) {
      if (current === generation) error.value = cause instanceof Error ? cause.message : '用例执行口径加载失败'
    } finally {
      if (current === generation) loading.value = false
    }
  }

  watch([() => analysis.value?.id, () => analysis.value?.review], () => { void reload() }, { immediate: true, flush: 'sync' })
  onScopeDispose(() => { generation += 1; controller?.abort() })
  return { contracts, loading, error, reload }
}
