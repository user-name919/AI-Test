<script setup lang="ts">
import type { CaseExecutionContract } from '@quality-ai/contracts'
defineProps<{contract:CaseExecutionContract}>()
const fields=[['preconditions','前置条件'],['steps','执行步骤'],['expectedAssertions','预期断言'],['forbiddenBehaviors','禁止行为'],['uncertainties','未确定事项']] as const
const strategies={visible_option_full:'完整名称搜索',visible_option_substring:'部分关键词搜索',non_matching_option_query:'无匹配负例'}
</script>
<template>
  <div class="design-contract-view">
    <h4>测试目标</h4><p>{{ contract.objective }}</p>
    <section v-for="[key,label] in fields" :key="key"><h4>{{ label }}</h4><ol v-if="contract[key].length"><li v-for="(line,index) in contract[key]" :key="index">{{ line }}</li></ol><p v-else>无</p></section>
    <h4>数据策略</h4><p v-if="!contract.dataBindings.length">无单独数据规则</p>
    <section v-for="binding in contract.dataBindings" :key="binding.id"><h5>{{ binding.label }}</h5><p>目标：{{ binding.targetHint }}；用途：{{ binding.businessIntent }}</p><p>来源：{{ {runtime_dom:'当前页面',fixture:'测试夹具',manual:'人工指定'}[binding.mode] }}{{ binding.strategy ? `；${strategies[binding.strategy]}` : '' }}</p>
      <p v-if="binding.manual">值：{{ binding.manual.value }}；理由：{{ binding.manual.rationale }}</p><p v-if="binding.fixture">值：{{ binding.fixture.value }}；依据：{{ binding.fixture.evidence }}</p>
      <p>当前 DOM 依据：{{ binding.constraints.mustComeFromCurrentDom?'必须':'不要求' }}；严格部分词：{{ binding.constraints.mustBePartialOfSource?'是':'否' }}；筛选后来源项保留：{{ binding.constraints.mustRemainAfterFiltering?'要求':'未要求' }}</p>
      <p v-if="binding.optionUniverse">候选范围：{{ {complete_local:'已确认完整本地范围',partial_or_remote:'分页或远程',unknown:'尚未确认'}[binding.optionUniverse.completeness] }}；依据：{{ binding.optionUniverse.evidence || '未提供' }}；候选：{{ binding.optionUniverse.options.join('、') || '未提供' }}</p>
    </section>
  </div>
</template>
<style scoped>
.design-contract-view{font-size:16px;line-height:1.65;overflow-wrap:anywhere}h4{font-size:17px;margin:18px 0 6px}h5{font-size:16px}p{white-space:pre-wrap;margin:6px 0}ol{padding-left:24px}section{margin:12px 0}
</style>
