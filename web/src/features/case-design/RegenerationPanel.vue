<script setup lang="ts">
import { computed, ref } from 'vue'
import type { CaseDesign, DesignRun } from '@quality-ai/contracts/case-design'
const props=defineProps<{design:CaseDesign;run:DesignRun;runs:DesignRun[];disabled:boolean}>()
const emit=defineEmits<{generate:[options:{upstreamRunId:string;regeneration:NonNullable<DesignRun['regeneration']>}];check:[options:{upstreamRunId:string} ]}>()
const selected=ref<string[]>([])
const planning=computed(()=>props.runs.find(item=>item.stage==='planning'&&item.status==='completed'&&item.inputHash===props.run.inputHash&&item.inputRevision===props.run.inputRevision&&JSON.stringify([item.output.factModel,item.output.scenarios,item.output.questions])===JSON.stringify([props.run.output.factModel,props.run.output.scenarios,props.run.output.questions])))
const unavailable=computed(()=>props.disabled?'请等待当前任务完成或取消':props.run.inputHash!==props.design.inputHash||props.run.inputRevision!==props.design.revision?'材料版本已变化，请重新生成':props.run.status!=='completed'||props.run.output.unprocessedScenarioIds?.length||!props.run.output.cases?.length?'需要已完整生成的用例产物':!planning.value?'没有与此版本一致的场景规划，不能混用新旧规则':!selected.value.length?'请至少选择一个场景':'')
function generate(){if(!unavailable.value&&planning.value)emit('generate',{upstreamRunId:planning.value.id,regeneration:{baseRunId:props.run.id,scenarioIds:[...selected.value]}})}
</script>
<template>
  <section class="regeneration-panel" aria-label="局部重新生成">
    <h2>局部重新生成</h2><p>基线：第 {{ run.attempt }} 次产物。仅重新生成勾选场景，其余用例保留；已保存的人工审核不会被覆盖。请先保存尚未提交的人工修改。</p>
    <fieldset :disabled="disabled"><legend>选择需要新建议的场景</legend><label v-for="scenario in run.output.scenarios" :key="scenario.id"><input v-model="selected" type="checkbox" :value="scenario.id" />{{ scenario.title }}<small>{{ scenario.testIntent }}</small></label></fieldset>
    <p>{{ unavailable || `将重新生成 ${selected.length} 个场景；新建议仍需质量审查和人工确认。` }}</p><button :disabled="!!unavailable" @click="generate">仅重新生成所选场景</button>
    <div v-if="run.stage==='generating'&&run.regeneration&&run.status==='completed'"><p>本次局部生成已完成。请审查这一份产物，再进行人工审核；不会自动采纳新建议。</p><button :disabled="disabled" @click="emit('check',{upstreamRunId:run.id})">审查这次局部生成</button></div>
  </section>
</template>
<style scoped>
.regeneration-panel{margin:16px 0;padding:20px;background:#fff;border:1px solid #dce1eb;border-radius:12px;font-size:16px}fieldset{border:1px solid #dce1eb;min-width:0}label{display:block;margin:12px 0}small{display:block;font-size:14px;color:#586579;margin-left:24px}button{font:inherit;padding:8px 14px;background:white;border:1px solid #aab5c8;border-radius:6px}button:disabled{opacity:.55}h2{font-size:21px}
</style>
