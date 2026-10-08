<script setup lang="ts">
import type { CaseExecutionResult } from '@quality-ai/contracts'
import SourceWorktreeNote from '../projects/SourceWorktreeNote.vue'
defineProps<{result:CaseExecutionResult}>()
const recoveryNames={reobserved:'已重新观察页面，再由 AI 决定下一步',exhausted:'恢复次数已用尽',observation_failed:'恢复时无法重新观察页面'}
</script>
<template>
  <section class="evidence" aria-label="用例实际执行证据">
    <h3>本次实际使用的数据</h3>
    <article v-for="download in result.downloads??[]" :key="download.downloadId"><p>实际下载：<strong>{{ download.name }}</strong> · {{ download.size }} 字节</p><p>下载标识：{{ download.downloadId }}</p><small>SHA256：{{ download.sha256 }}</small><p>文件已接收不代表业务验证通过，请查看下载断言结果；文件在报告证据区下载。</p></article>
    <article v-for="(fixture,index) in result.usedFixtures??[]" :key="`${fixture.id}:${index}`">
      <p>上传使用的测试附件：<strong>{{ fixture.name }}</strong> · {{ fixture.size }} 字节</p>
      <p>附件 ID：{{ fixture.id }}</p><small>内容 SHA256：{{ fixture.sha256 }}</small>
      <p>这是尝试上传时的附件快照；是否上传成功、是否完成业务处理，以后续动作和断言结果为准。</p>
    </article>
    <p v-if="!result.resolvedDataBindings.length">未记录运行时数据绑定，不代表已验证数据来源。</p>
    <article v-for="binding in result.resolvedDataBindings" :key="binding.bindingId">
      <p>输入：<strong>{{ binding.value }}</strong> · 来源选项：{{ binding.sourceText }}</p>
      <p>选择依据：{{ binding.reason }}</p><small>DOM {{ binding.snapshotId }} · {{ binding.sourceElementRef }} · {{ binding.observedAt }}</small>
    </article>
    <h3>操作与验证经过</h3>
    <article v-for="turn in result.trajectory" :key="turn.iteration">
      <h4>第 {{ turn.iteration }} 步 · {{ turn.decision.type==='finish'?turn.decision.summary:turn.decision.reason }}</h4>
      <template v-if="turn.sourceProject"><p>读取前源码：{{ turn.sourceProject.id }} / {{ turn.sourceProject.branch||'无分支信息' }} / {{ turn.sourceProject.commit||'无 SHA' }}</p><SourceWorktreeNote :worktree="turn.sourceProject.worktree" /></template>
      <p v-if="turn.observation?.frameContext">观察框架：{{ turn.observation.frameContext.frames.find(frame=>frame.active)?.name||'未命名框架' }} · {{ turn.observation.url }}（{{ turn.observation.frameContext.frames.find(frame=>frame.active)?.main?'主页面':'嵌入页面' }}）</p>
      <p v-if="turn.observation?.pageContext">当前标签页：{{ turn.observation.pageContext.pages.find(page=>page.active)?.url }} · 页面标识 {{ turn.observation.pageContext.pages.find(page=>page.active)?.ref }}（已观察 {{ turn.observation.pageContext.pages.length }} 页{{ turn.observation.pageContext.truncated?'，列表不完整':'' }}）</p>
      <p v-if="turn.observation?.observationScope">本步为局部观察：来自快照 {{ turn.observation.observationScope.sourceSnapshotId }} 的 {{ turn.observation.observationScope.sourceElementRef }}。未包含区域外元素，不代表整页或全部业务数据。</p>
      <p v-if="turn.result">{{ turn.result.ok?'本步成功':'本步失败' }}：{{ turn.result.message }} · {{ turn.result.durationMs }} ms</p>
      <p v-else>本步未记录浏览器执行结果，不据此判定通过。</p>
      <p v-if="turn.result?.writeGuard">写操作门禁：{{ turn.result.writeGuard.allowed ? "许可通过（不是业务成功）" : "已阻止" }} · {{ turn.result.writeGuard.reason }}<br />控件：{{ turn.result.writeGuard.label || "无名称" }} · {{ turn.result.writeGuard.observedAt }}</p>
      <p v-if="turn.recovery" class="recovery">技术恢复 {{ turn.recovery.attempt }}/{{ turn.recovery.limit }}：{{ recoveryNames[turn.recovery.status] }}。原因：{{ turn.recovery.reason }}</p>
      <small>DOM 快照：{{ turn.snapshotId }}</small>
      <details><summary>查看本步技术动作与观察</summary><pre>{{ JSON.stringify({decision:turn.decision,observation:turn.observation,projectContext:turn.projectContext},null,2) }}</pre></details>
    </article>
    <template v-if="!result.trajectory.length">
      <p v-if="!result.steps.length">没有操作证据。</p>
      <article v-for="step in result.steps" :key="step.index">
        <p>第 {{ step.index+1 }} 步 · {{ step.action }} · {{ step.status==='passed'?'成功':'失败' }} · {{ step.durationMs }} ms</p><p v-if="step.error">{{ step.error }}</p>
        <p v-if="step.writeGuard">写操作门禁：{{ step.writeGuard.allowed ? "许可通过（不是业务成功）" : "已阻止" }} · {{ step.writeGuard.reason }}<br />控件：{{ step.writeGuard.label || "无名称" }} · {{ step.writeGuard.observedAt }}</p>
        <p v-if="step.pageBefore">操作前页面：{{ step.pageBefore.url }} · {{ step.pageBefore.ref }}</p>
        <p v-if="step.openedPage">实际打开页面：{{ step.openedPage.url }} · {{ step.openedPage.ref }}；请求别名 {{ step.openedPage.alias }}，是否成功绑定请看步骤结果。</p>
        <p v-if="step.pageAfter">操作后当前页面：{{ step.pageAfter.url }} · {{ step.pageAfter.ref }}</p>
      </article>
    </template>
    <details><summary>查看原始执行数据（排障）</summary><pre>{{ JSON.stringify({data:result.resolvedDataBindings,steps:result.steps,trajectory:result.trajectory},null,2) }}</pre></details>
  </section>
</template>
<style scoped>
.evidence{min-width:0;font-size:15px;line-height:1.65}.evidence article{border:1px solid #dce2ed;border-radius:10px;padding:12px;margin:12px 0;overflow-wrap:anywhere}.evidence h4{margin:0;font-size:16px}.evidence small{color:#536078}.evidence pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:14px}.evidence summary{cursor:pointer;padding:8px 0}.recovery{background:#fff5dc;padding:10px;border-radius:6px}
</style>
