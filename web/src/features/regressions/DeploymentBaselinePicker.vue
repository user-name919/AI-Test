<script setup lang="ts">
import { ref, watch, onUnmounted } from 'vue'
import type { DeploymentBaseline } from '@quality-ai/contracts/regressions'
import { regressionRequest } from './api'

const props = defineProps<{ projectId: string }>()
const emit = defineEmits<{ adopt: [sha: string] }>()
const baselines = ref<DeploymentBaseline[]>([])
const selected = ref(''), error = ref(''), loading = ref(false)
let epoch = 0
async function load() {
  const current = ++epoch
  baselines.value = []; selected.value = ''; error.value = ''
  if (!props.projectId) { loading.value = false; return }
  loading.value = true
  try {
    const result = await regressionRequest<{ baselines: DeploymentBaseline[] }>(`/api/regression-baselines?projectId=${encodeURIComponent(props.projectId)}`)
    if (current !== epoch) return
    baselines.value = result.baselines
    selected.value = result.baselines[0]?.confirmation.id ?? ''
  } catch (cause) { if (current === epoch) error.value = cause instanceof Error ? cause.message : '部署基线读取失败' }
  finally { if (current === epoch) loading.value = false }
}
function adopt() {
  const item = baselines.value.find(item => item.confirmation.id === selected.value)
  if (item?.confirmation.deployedSha) emit('adopt', item.confirmation.deployedSha)
}
watch(() => props.projectId, load, { immediate: true })
onUnmounted(() => { epoch++ })
</script>

<template>
  <section aria-label="推荐部署基线" v-if="projectId">
    <h3>推荐：从上次登记部署版本比较</h3>
    <p>仅列出本项目在各环境的最新匹配记录，不自动探测服务器版本。采用后仍可手动修改基线；本机没有对应提交时预览会拒绝，不会拉取远端。</p>
    <p v-if="error" role="alert" class="reg-error">{{ error }}</p>
    <p v-if="loading">正在读取部署记录…</p>
    <template v-else-if="baselines.length">
      <label>部署记录<select v-model="selected"><option v-for="item in baselines" :key="item.confirmation.id" :value="item.confirmation.id">{{ item.environmentName }} · {{ item.confirmation.deployedSha?.slice(0, 12) }} · {{ item.confirmation.createdAt }}</option></select></label>
      <template v-for="item in baselines.filter(item => item.confirmation.id === selected)" :key="item.confirmation.id">
        <p style="overflow-wrap:anywhere">{{ item.confirmation.targetUrl }}<br />完整 SHA：{{ item.confirmation.deployedSha }}<br />确认人：{{ item.confirmation.confirmedBy }} · 依据：{{ item.confirmation.note }}</p>
      </template>
      <button type="button" :disabled="!selected" @click="adopt">采用此部署 SHA 为基线</button>
    </template>
    <p v-else>没有可推荐的有效部署记录。可能尚未登记、最新记录未核实或不匹配、环境配置已变化。请明确填写基线，不会默认猜测主干或退回旧记录。</p>
    <button type="button" :disabled="loading" @click="load">刷新部署基线</button>
  </section>
</template>
