<script setup lang="ts">
import type { CaseExecutionContract, TestDataBinding } from '@quality-ai/contracts'
const contract=defineModel<CaseExecutionContract>({required:true})
const fields=[['preconditions','前置条件'],['steps','执行步骤'],['expectedAssertions','预期断言'],['forbiddenBehaviors','禁止行为'],['uncertainties','未确定事项']] as const
function lines(key: typeof fields[number][0], event:Event) { contract.value[key]=(event.target as HTMLTextAreaElement).value.split('\n') }
function mode(binding:TestDataBinding,event:Event) {
  binding.mode=(event.target as HTMLSelectElement).value as TestDataBinding['mode']
  delete binding.manual; delete binding.fixture; delete binding.strategy; delete binding.optionUniverse
  binding.constraints={mustComeFromCurrentDom:binding.mode==='runtime_dom'}
  if(binding.mode==='runtime_dom'){binding.strategy='visible_option_substring';binding.constraints.mustBePartialOfSource=true}
  else if(binding.mode==='manual')binding.manual={value:'',rationale:''}
  else binding.fixture={value:'',evidence:''}
}
function strategy(binding:TestDataBinding,event:Event) {
  binding.strategy=(event.target as HTMLSelectElement).value as TestDataBinding['strategy']
  binding.constraints={mustComeFromCurrentDom:true,mustBePartialOfSource:binding.strategy==='visible_option_substring',mustRemainAfterFiltering:binding.strategy!=='non_matching_option_query'}
  if(binding.strategy==='non_matching_option_query')binding.optionUniverse={completeness:'unknown',options:[],evidence:''}
  else delete binding.optionUniverse
}
function options(binding:TestDataBinding,event:Event){if(binding.optionUniverse)binding.optionUniverse.options=(event.target as HTMLTextAreaElement).value.split('\n').map(line=>line.trim()).filter(Boolean)}
function addData(){contract.value.dataBindings.push({id:crypto.randomUUID(),label:'',targetHint:'',businessIntent:'',mode:'runtime_dom',strategy:'visible_option_substring',constraints:{mustComeFromCurrentDom:true,mustBePartialOfSource:true}})}
</script>
<template>
  <div class="contract-editor">
    <label>测试目标<textarea v-model="contract.objective" rows="2" /></label>
    <label v-for="[key,label] in fields" :key="key">{{ label }}（每行一项）<textarea :value="contract[key].join('\n')" rows="3" @input="lines(key,$event)" /></label>
    <h3>测试数据策略</h3><p>从页面取值不预填账号数据；无匹配负例需要完整候选依据。</p>
    <section v-for="(binding,index) in contract.dataBindings" :key="binding.id">
      <label>数据名称<input v-model="binding.label" /></label><label>目标控件<input v-model="binding.targetHint" /></label><label>数据用途<input v-model="binding.businessIntent" /></label>
      <label>来源<select aria-label="数据来源" :value="binding.mode" @change="mode(binding,$event)"><option value="runtime_dom">当前页面选项</option><option value="fixture">测试夹具</option><option value="manual">人工指定</option></select></label>
      <label v-if="binding.mode==='runtime_dom'">搜索策略<select aria-label="搜索策略" :value="binding.strategy" @change="strategy(binding,$event)"><option value="visible_option_full">完整名称</option><option value="visible_option_substring">部分关键词</option><option value="non_matching_option_query">无匹配负例</option></select></label>
      <template v-if="binding.optionUniverse"><label>候选范围<select aria-label="候选范围" v-model="binding.optionUniverse.completeness"><option value="unknown">尚未确认</option><option value="partial_or_remote">分页或远程</option><option value="complete_local">已确认完整本地列表</option></select></label><label>完整候选（每行一项）<textarea :value="binding.optionUniverse.options.join('\n')" @input="options(binding,$event)" /></label><label>完整性依据<input v-model="binding.optionUniverse.evidence" /></label></template>
      <template v-if="binding.manual"><label>人工值<input v-model="binding.manual.value" /></label><label>选值理由<input v-model="binding.manual.rationale" /></label></template>
      <template v-if="binding.fixture"><label>夹具值<input v-model="binding.fixture.value" /></label><label>夹具依据<input v-model="binding.fixture.evidence" /></label></template>
      <label v-if="binding.mode==='runtime_dom' && binding.strategy!=='non_matching_option_query'"><input v-model="binding.constraints.mustRemainAfterFiltering" type="checkbox" />筛选后来源选项仍应存在</label>
      <button type="button" @click="contract.dataBindings.splice(index,1)">移除数据规则</button>
    </section>
    <button type="button" @click="addData">添加数据规则</button>
  </div>
</template>
<style scoped>
label{display:block;margin:12px 0}textarea,input:not([type=checkbox]),select{font:inherit;width:100%;padding:8px;border:1px solid #aab5c8;border-radius:6px;box-sizing:border-box}section{padding:12px;border:1px solid #d7dce7;margin:12px 0;border-radius:8px}button{font:inherit;padding:8px 12px;cursor:pointer}textarea{resize:vertical}
</style>
