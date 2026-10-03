import type { PageSnapshot, ResolvedDataBinding, ResolveTestDataDecision, TestDataBinding } from '@quality-ai/contracts'

export class RuntimeDataBindingBlockedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RuntimeDataBindingBlockedError'
  }
}

function normalizedText(value: string) {
  return value.trim().replace(/\s+/g, ' ')
}

export function resolveRuntimeDataBinding(
  binding: TestDataBinding,
  snapshot: PageSnapshot,
  proposal: ResolveTestDataDecision,
): ResolvedDataBinding {
  if (binding.mode !== 'runtime_dom') throw new RuntimeDataBindingBlockedError(`数据绑定“${binding.id}”不是运行时 DOM 数据`)
  if (
    binding.strategy !== 'visible_option_substring'
    || !binding.constraints?.mustComeFromCurrentDom
    || !binding.constraints.mustBePartialOfSource
  ) {
    throw new RuntimeDataBindingBlockedError('运行时 DOM 数据绑定必须声明可见 option 严格子串协议')
  }
  if (proposal.bindingId !== binding.id) throw new RuntimeDataBindingBlockedError(`数据提议引用了错误的绑定：${proposal.bindingId}`)
  if (proposal.snapshotId !== snapshot.snapshotId) throw new RuntimeDataBindingBlockedError(`数据提议引用了过期页面快照：${proposal.snapshotId}`)

  const source = snapshot.elements.find(element => element.ref === proposal.sourceElementRef)
  if (!source || !source.visible) throw new RuntimeDataBindingBlockedError('当前 DOM 没有可见的数据来源 option')
  if (source.role !== 'option') {
    throw new RuntimeDataBindingBlockedError('运行时数据来源必须是当前可见 option')
  }

  const sourceText = source.text?.trim() || source.name.trim()
  const normalizedSource = normalizedText(sourceText)
  const value = normalizedText(proposal.value)
  if (!normalizedSource || !value || !normalizedSource.includes(value) || normalizedSource === value) {
    throw new RuntimeDataBindingBlockedError('数据提议必须是可见来源 option 的非空严格子串')
  }

  return {
    bindingId: binding.id,
    sourceElementRef: source.ref,
    sourceText,
    value,
    snapshotId: snapshot.snapshotId,
    observedAt: snapshot.observedAt,
    reason: proposal.reason,
  }
}
