import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { CaseDesign, DesignRun } from '@quality-ai/contracts/case-design'

export async function designRequest<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const value = await response.json()
  if (!response.ok) throw new Error([value.error, ...(value.reasons ?? [])].filter(Boolean).join('；') || '请求失败')
  return value
}

export function useCaseDesign() {
  const route = useRoute()
  const router = useRouter()
  const design = ref<CaseDesign | null>(null)
  const runs = ref<DesignRun[]>([])
  const error = ref('')
  const loading = ref(false)
  const busy = ref(false)
  const active = computed(() => runs.value.find(run => ['queued', 'running'].includes(run.status)))
  const selected = computed(() => runs.value.find(run => run.id === route.query.runId) ?? (route.query.runId ? undefined : runs.value[0]))
  let sequence = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  async function refresh() {
    const id = String(route.params.id ?? '')
    if (!id) return
    const request = ++sequence
    clearTimeout(timer)
    try {
      const result = await designRequest<{ design: CaseDesign; runs: DesignRun[] }>(`/api/case-designs/${encodeURIComponent(id)}`)
      if (disposed || request !== sequence) return
      design.value = result.design; runs.value = result.runs
    } catch (cause) {
      if (request === sequence && !disposed) error.value = cause instanceof Error ? cause.message : '加载失败'
    } finally {
      if (request === sequence && !disposed) {
        loading.value = false
        if (active.value) timer = setTimeout(() => { void refresh() }, 2000)
      }
    }
  }
  watch(() => route.params.id, () => {
    ++sequence; clearTimeout(timer); design.value = null; runs.value = []; error.value = ''
    loading.value = Boolean(route.params.id); void refresh()
  }, { immediate: true })
  onBeforeUnmount(() => { disposed = true; ++sequence; clearTimeout(timer) })
  async function start(stage: DesignRun['stage']) {
    if (!design.value || busy.value) return
    const designId = design.value.id
    busy.value = true; error.value = ''
    try {
      const result = await designRequest<{run: DesignRun}>(`/api/case-designs/${designId}/runs`, { stage, expectedRevision: design.value.revision })
      if (disposed || route.params.id !== designId) return
      await router.replace({query:{...route.query,runId:result.run.id}})
      await refresh()
    } catch (cause) { error.value = cause instanceof Error ? cause.message : '启动失败' }
    finally { busy.value = false }
  }
  async function cancel() {
    if (!design.value || busy.value) return
    busy.value = true; error.value = ''
    try { await designRequest(`/api/case-designs/${design.value.id}/cancel`, {}); await refresh() }
    catch (cause) { error.value = cause instanceof Error ? cause.message : '取消失败' }
    finally { busy.value = false }
  }
  return { design, runs, selected, active, error, loading, busy, refresh, start, cancel }
}
