<script setup lang="ts">
import { computed } from 'vue'
import type { AutomationPlan } from '@quality-ai/contracts'
import { describeAutomationStep } from '@quality-ai/contracts/live-execution'
const props=defineProps<{plan:AutomationPlan}>()
const cases=computed(()=>{
  const plans:NonNullable<AutomationPlan['casePlans']>=props.plan.casePlans??[{caseKey:'legacy',title:props.plan.name,contractFingerprint:'',steps:props.plan.steps}]
  return plans.map(item=>({...item,actions:item.steps.map((step,index)=>({step,description:describeAutomationStep(step,index)}))}))
})
</script>
<template>
  <section class="fixed-plan-review" aria-label="完整固定执行计划">
    <p>将按以下顺序执行 {{ cases.length }} 条用例，共 {{ cases.reduce((sum,item)=>sum+item.steps.length,0) }} 个动作。共享浏览器会话；操作成功不代表业务断言通过。</p>
    <p>测试地址：{{ plan.targetUrl }}</p>
    <p v-if="!plan.casePlans" class="warning">历史计划未记录逐用例契约，请重新生成后确认执行。</p>
    <article v-for="(item,caseIndex) in cases" :key="item.caseKey">
      <h4>{{ caseIndex+1 }}. {{ item.title }}</h4>
      <p v-if="item.preparationError" class="warning">计划受阻：{{ item.preparationError }}（不会执行该用例动作）</p>
      <ol>
        <li v-for="(action,index) in item.actions" :key="index">
          <strong>{{ action.description.title }}</strong>
          <p>{{ action.description.purpose }}</p>
          <p v-if="'assertionIndex' in action.step && action.step.assertionIndex!==undefined">验证预期 {{ action.step.assertionIndex+1 }}：{{ item.contract?.expectedAssertions[action.step.assertionIndex]??'预期依据缺失，需重新生成' }}</p>
          <code>{{ action.description.technicalAction }}</code>
          <details><summary>查看完整动作参数</summary><pre>{{ JSON.stringify(action.step,null,2) }}</pre></details>
        </li>
      </ol>
      <details v-if="item.contract"><summary>查看该用例完整契约与数据策略</summary><pre>{{ JSON.stringify(item.contract,null,2) }}</pre></details>
    </article>
  </section>
</template>
<style scoped>
.fixed-plan-review{font-size:16px;line-height:1.65;min-width:0;overflow-wrap:anywhere}.fixed-plan-review article{padding:16px 0;border-top:1px solid #d7ddea}.fixed-plan-review h4{font-size:18px;margin:0 0 12px}.fixed-plan-review ol{display:block;padding-left:28px}.fixed-plan-review li{display:list-item;margin:12px 0;padding:12px;background:#f6f7fb}.fixed-plan-review p{margin:8px 0}.fixed-plan-review code,.fixed-plan-review pre{font-size:14px;white-space:pre-wrap;overflow-wrap:anywhere}.fixed-plan-review summary{cursor:pointer;padding:8px 0}.warning{color:#8b3e10;background:#fff3df;padding:12px}
</style>
