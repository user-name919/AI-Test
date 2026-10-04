<script setup lang="ts">
import { computed } from 'vue'
const props=defineProps<{cases:Array<{id:string;title:string;operations?:string[]}>;targetUrl:string;disabled?:boolean}>()
const approved=defineModel<string[]>({required:true})
const required=computed(()=>props.cases.filter(item=>item.operations?.length))
</script>
<template>
  <fieldset v-if="required.length" :disabled="disabled" class="write-authorization">
    <legend>本次业务写操作授权</legend>
    <p>确认测试地址及数据可被修改后，逐条勾选。仅授权以下已声明范围，不授权任意写操作；取消测试不会回滚已经发生的操作。</p>
    <p>启动时校验声明，运行时对风险名称和原生提交进行保守拦截，要求动作关联授权项。不能识别所有隐式副作用，也不能完全验证自然语言范围；请只在可控测试环境运行。</p>
    <p>本次地址：{{ targetUrl }}</p>
    <article v-for="item in required" :key="item.id"><label><input v-model="approved" type="checkbox" :value="item.id" />允许本次执行：{{ item.title }}</label><ul><li v-for="(operation,index) in item.operations" :key="index">{{ operation }}</li></ul></article>
    <p role="status">{{ required.every(item=>approved.includes(item.id))?'已逐条确认；服务端仍会核对用例版本。':'请逐条核对并授权后再启动。更换配置、重新预览或重跑需要再次确认。' }}</p>
  </fieldset>
</template>
<style scoped>
.write-authorization{min-width:0;padding:16px;margin:16px 0;border:1px solid #b99046;background:#fffbf0;border-radius:8px;font-size:16px;line-height:1.6;overflow-wrap:anywhere}legend{font-weight:700}article{margin:12px 0}label{display:flex;align-items:flex-start;gap:10px}input{flex:none;width:18px;height:18px;margin-top:4px}ul{margin:8px 0;padding-left:32px}p{margin:8px 0}
</style>
