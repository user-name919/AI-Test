<script setup lang="ts">
import { computed } from 'vue'
import type { PrdAnalysis } from '@quality-ai/contracts'
const props = defineProps<{ analysis: PrdAnalysis; persisted: boolean }>()
const emit = defineEmits<{ open: [index: number] }>()
const requirements = computed(() => props.analysis.requirements)
const ruleCount = computed(() => requirements.value.reduce((sum, item) => sum + item.businessRules.length, 0))
const stateCount = computed(() => requirements.value.reduce((sum, item) => sum + item.pageStates.length, 0))
</script>

<template>
  <section class="heading hub-heading">
    <div><small><i></i>{{ analysis.versionName }}</small><h1>需求中心</h1><p>集中查看当前版本的需求风险、规则、页面状态和测试准备度。</p></div>
    <button class="primary" :disabled="!requirements.length" @click="emit('open',0)">打开评审详情</button>
  </section>
  <p v-if="!persisted" role="status">当前为示例材料；请先在版本中心导入真实需求，示例不能作为审核依据。</p>
  <section class="metrics">
    <article><i class="purple">需</i><p><span>需求总数</span><strong>{{ requirements.length }}</strong><small>当前版本</small></p></article>
    <article><i class="amber">高</i><p><span>高风险</span><strong>{{ requirements.filter(item=>item.risk==='高风险').length }}</strong><small>优先评审</small></p></article>
    <article><i class="blue">规</i><p><span>业务规则</span><strong>{{ ruleCount }}</strong><small>提取依据见详情</small></p></article>
    <article><i class="green">态</i><p><span>页面状态</span><strong>{{ stateCount }}</strong><small>交互状态模型</small></p></article>
  </section>
  <section class="requirement-hub">
    <article v-for="(item,index) in requirements" :key="index">
      <header><span>REQ-{{ String(index+1).padStart(3,'0') }}</span><b :class="item.risk==='高风险'?'high':item.risk==='中风险'?'medium':'low'">{{ item.risk }}</b></header>
      <h2>{{ item.title }}</h2><p>{{ item.summary }}</p>
      <div><span>规则 {{ item.businessRules.length }}</span><span>状态 {{ item.pageStates.length }}</span><span>问题 {{ item.questions.length }}</span><span>用例 {{ item.testCases.length }}</span></div>
      <footer><small>{{ item.riskReason }}</small><button @click="emit('open',index)">查看需求详情 →</button></footer>
    </article>
    <p v-if="!requirements.length" class="empty">该版本尚无需求，请导入材料或检查分析结果。</p>
  </section>
</template>
