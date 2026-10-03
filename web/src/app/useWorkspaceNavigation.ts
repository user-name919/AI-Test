import { ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

export type WorkspaceView = 'version' | 'requirements' | 'cases' | 'executions' | 'memory'
export type Tab = 'overview' | 'states' | 'questions' | 'cases'
export function useWorkspaceNavigation() {
  const route = useRoute()
  const router = useRouter()
  const workspaceView = ref<WorkspaceView>('version')
  const activeTab = ref<Tab>('overview')
  const activeRequirement = ref(0)
  const selectedExecutionId = ref('')
  function restore() {
    workspaceView.value = (route.meta.workspace ?? route.name) as WorkspaceView
    activeTab.value = ['overview', 'states', 'questions', 'cases'].includes(String(route.query.tab)) ? route.query.tab as Tab : 'overview'
    const index = Number(route.query.requirement ?? 0)
    activeRequirement.value = Number.isSafeInteger(index) && index >= 0 ? index : 0
    selectedExecutionId.value = route.name === 'executions' && typeof route.params.id === 'string' ? route.params.id : ''
  }
  restore()
  watch(() => route.fullPath, restore, { flush: 'sync' })
  watch([workspaceView, activeTab, activeRequirement, selectedExecutionId], () => {
    const query = { ...route.query, tab: activeTab.value === 'overview' ? undefined : activeTab.value, requirement: activeRequirement.value ? String(activeRequirement.value) : undefined }
    const detail = workspaceView.value === 'version' && route.name === 'requirement-detail'
    const destination = { name: detail ? 'requirement-detail' : workspaceView.value, params: detail ? route.params : workspaceView.value === 'executions' && selectedExecutionId.value ? { id: selectedExecutionId.value } : {}, query }
    if (router.resolve(destination).fullPath !== route.fullPath) void router.push(destination)
  }, { flush: 'post' })
  return { workspaceView, activeTab, activeRequirement, selectedExecutionId }
}
