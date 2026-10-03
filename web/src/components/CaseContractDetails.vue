<script setup lang="ts">
import type { ResolvedCaseExecutionContract } from '@quality-ai/contracts'
defineProps<{ resolved?: ResolvedCaseExecutionContract; unavailableReason: string; expanded?: boolean }>()
</script>

<template>
  <details class="case-contract-details" :open="expanded">
    <summary>{{ resolved?.title ?? '用例' }} · 查看完整执行口径<span v-if="resolved?.questionAssociation.warning"> · 历史关联待复核</span></summary>
    <p v-if="!resolved" role="status">{{ unavailableReason }}</p>
    <div v-else>
      <p class="contract-origin">以下内容由服务端解析，与本次执行使用同一契约。用例标题仅作索引。</p>
      <dl>
        <dt>测试目标</dt><dd>{{ resolved.contract.objective }}</dd>
        <dt>前置条件</dt><dd><ul v-if="resolved.contract.preconditions.length"><li v-for="(item,index) in resolved.contract.preconditions" :key="index">{{ item }}</li></ul><span v-else>未指定</span></dd>
        <dt>执行步骤</dt><dd><ol><li v-for="(item,index) in resolved.contract.steps" :key="index">{{ item }}</li></ol></dd>
        <dt>预期断言</dt><dd><ol><li v-for="(item,index) in resolved.contract.expectedAssertions" :key="index">{{ item }}</li></ol></dd>
        <dt>测试数据来源</dt><dd><div v-for="binding in resolved.contract.dataBindings" :key="binding.id" class="binding">
          <strong>{{ binding.label }}</strong> · {{ binding.mode === 'runtime_dom' ? '运行时真实 DOM' : binding.mode === 'fixture' ? '固定夹具' : '人工指定' }}
          <p>用途：{{ binding.businessIntent }}；目标：{{ binding.targetHint }}</p>
          <p v-if="binding.fixture">值：{{ binding.fixture.value }}；证据：{{ binding.fixture.evidence }}</p>
          <p v-if="binding.manual">值：{{ binding.manual.value }}；说明：{{ binding.manual.rationale }}</p>
          <p v-if="binding.strategy">策略：{{ binding.strategy }}；{{ binding.constraints.mustComeFromCurrentDom ? '必须来自当前 DOM' : '不要求当前 DOM 来源' }}{{ binding.constraints.mustBePartialOfSource ? '；必须为严格部分关键词' : '' }}{{ binding.constraints.mustRemainAfterFiltering ? '；筛选后来源选项仍需存在' : '' }}</p>
        </div><span v-if="!resolved.contract.dataBindings.length">未配置结构化数据来源；不会因此证明示例数据真实存在。</span></dd>
        <dt>禁止行为</dt><dd>{{ resolved.contract.forbiddenBehaviors.join('；') || '未指定' }}</dd>
        <dt>未确定事项</dt><dd>{{ resolved.contract.uncertainties.join('；') || '无' }}</dd>
        <dt>关联问题</dt><dd><p v-if="resolved.questionAssociation.warning" class="contract-warning">{{ resolved.questionAssociation.warning }}</p>{{ resolved.questionAssociation.questionKeys.join('、') || '无' }}<p v-for="question in resolved.resolvedQuestions" :key="question.questionKey">{{ question.questionKey }}：{{ question.finalStatement }}</p></dd>
        <dt>关联问题执行规则</dt><dd><section v-for="question in resolved.resolvedQuestions" :key="question.questionKey"><strong>{{ question.questionTitle }}</strong><p v-if="question.objective">目标：{{ question.objective }}</p><p>触发：{{ question.triggers.join('；') || '未指定' }}</p><p>行为：{{ question.behaviors.join('；') || '未指定' }}</p><p>追加断言：{{ question.assertions.join('；') || '无' }}</p><p>禁止：{{ question.forbiddenBehaviors.join('；') || '未指定' }}</p><p>源码线索：{{ question.sourceHints.join('；') || '无' }}</p><p>不确定项：{{ question.uncertainties.join('；') || '无' }}</p></section><span v-if="!resolved.resolvedQuestions.length">无</span></dd>
        <dt>动态 Agent</dt><dd>{{ resolved.readiness.agent.executable ? '用例口径已就绪；仍需配置执行环境' : resolved.readiness.agent.reason }}</dd>
        <dt>固定计划</dt><dd>{{ resolved.readiness.plan.executable ? '用例口径已就绪；仍需配置执行环境' : resolved.readiness.plan.reason }}</dd>
        <dt>契约指纹</dt><dd><code>{{ resolved.contractFingerprint }}</code></dd>
      </dl>
    </div>
  </details>
</template>

<style scoped>
.case-contract-details { margin: 8px 0; border: 1px solid #dedfee; border-radius: 8px; padding: 12px 16px; font-size: 16px; line-height: 1.65; background: #fafaff; }
summary { cursor: pointer; color: #4338ca; }
summary span,.contract-warning { color: #925511; }
.contract-origin { color: #586477; font-size: 14px; }
dl { display: grid; grid-template-columns: 120px minmax(0,1fr); gap: 10px 16px; }
dt { color: #586477; } dd { margin: 0; overflow-wrap: anywhere; } ul,ol { margin: 0; padding-left: 24px; }
p { margin: 4px 0; } .binding + .binding { border-top: 1px solid #e2e5ed; margin-top: 8px; padding-top: 8px; }
code { font-size: 14px; }
@media (max-width: 700px) { dl { grid-template-columns: 1fr; gap: 4px; } dt { margin-top: 10px; font-weight: 600; } }
</style>
