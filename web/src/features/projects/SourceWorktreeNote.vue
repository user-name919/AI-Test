<script setup lang="ts">
import type { ProjectInfo } from '@quality-ai/contracts'
defineProps<{ worktree?: ProjectInfo['worktree'] }>()
const labels = { clean: '未发现 Git 跟踪或未跟踪改动', dirty: '存在本地未提交或未跟踪改动，SHA 不能代表全部读取内容', unknown: '无法确认工作区状态，不能认为源码与 SHA 完全一致' }
</script>
<template>
  <p class="source-worktree-note">源码工作区：{{ worktree ? labels[worktree.status] : '历史未记录，不推断为干净' }}<template v-if="worktree">。检查时间：{{ worktree.observedAt }}</template>。Git 忽略文件不计入此检查；这是检查时状态，不是内容冻结或部署版本证明。</p>
</template>
<style scoped>
.source-worktree-note{font-size:15px;line-height:1.7;overflow-wrap:anywhere;background:#fff6df;color:#674c19;padding:10px;border-radius:8px}
</style>
