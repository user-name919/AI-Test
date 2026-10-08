<script setup lang="ts">
import { RouterLink } from 'vue-router'
</script>
<template><main class="missing-page"><h1>页面不存在</h1><p>该地址可能已失效，请返回版本中心继续。</p><RouterLink to="/versions">返回版本中心</RouterLink></main></template>
<style scoped>.missing-page { padding:48px; font-size:18px; line-height:1.7; }</style>
