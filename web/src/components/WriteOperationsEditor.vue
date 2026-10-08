<script setup lang="ts">
const operations=defineModel<string[]>()
function update(event:Event){operations.value=(event.target as HTMLTextAreaElement).value.split('\n')}
</script>
<template>
  <section class="write-operations-editor">
    <label>允许的业务写操作（每行一项）<textarea :value="operations?.join('\n')??''" rows="3" placeholder="例如：仅为专用测试考试生成一份报告；不得删除已有考试" @input="update" @change="operations=operations?.map(value=>value.trim()).filter(Boolean)" /></label>
    <p>涉及保存、提交、删除、发布或对外发送时，写明操作对象和边界。这里仅声明用例范围；每次执行仍须单独授权。留空不代表已证明用例只读，也不能代替人工风险审核。</p>
  </section>
</template>
<style scoped>
.write-operations-editor{padding:12px;border:1px solid #d5b880;border-radius:8px;margin:16px 0;font-size:16px;line-height:1.6}label{display:block}textarea{display:block;width:100%;box-sizing:border-box;font:inherit;padding:8px;margin-top:8px;border:1px solid #aab5c8;border-radius:6px;resize:vertical}p{font-size:14px;margin:8px 0;color:#71531e}
</style>
