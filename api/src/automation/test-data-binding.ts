import { testDataBindingSchema, type PageSnapshot, type ResolvedDataBinding, type ResolveTestDataDecision, type TestDataBinding } from '@quality-ai/contracts'

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
  if (!testDataBindingSchema.safeParse(binding).success) throw new RuntimeDataBindingBlockedError('运行时 DOM 数据绑定不符合已声明的策略协议')
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
  if (!normalizedSource || !value) throw new RuntimeDataBindingBlockedError('来源选项与输入值不能为空')
  if (binding.strategy === 'visible_option_substring' && (!normalizedSource.includes(value) || normalizedSource === value)) {
    throw new RuntimeDataBindingBlockedError('数据提议必须是可见来源 option 的非空严格子串')
  }
  if (binding.strategy === 'visible_option_full') {
    if (source.textTruncated || source.nameTruncated) throw new RuntimeDataBindingBlockedError('来源选项文字被截断，不能作为完整名称')
    if (value !== normalizedSource) throw new RuntimeDataBindingBlockedError('完整搜索必须使用来源 option 的完整名称')
  }
  if (binding.strategy === 'non_matching_option_query') {
    const universe = binding.optionUniverse
    if (!universe || universe.completeness !== 'complete_local' || !universe.evidence.trim() || !universe.options.length) throw new RuntimeDataBindingBlockedError('无匹配搜索缺少完整本地候选范围依据；分页或远程搜索不能用当前可见选项证明全局不存在')
    if (snapshot.loading || snapshot.stats.truncated) throw new RuntimeDataBindingBlockedError('页面加载中或快照截断，不能确认无匹配候选范围')
    const visibleOptions = snapshot.elements.filter(item => item.visible && item.role === 'option')
    if (visibleOptions.some(item => item.textTruncated || item.nameTruncated)) throw new RuntimeDataBindingBlockedError('候选文字被截断，不能确认无匹配候选范围')
    const expected = [...new Set(universe.options.map(normalizedText))].sort()
    const actual = [...new Set(visibleOptions.map(item => normalizedText(item.text?.trim() || item.name)))].sort()
    if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new RuntimeDataBindingBlockedError('当前可见候选与声明的完整候选集不一致，请准备可控夹具或重新审核数据范围')
    if (actual.some(option => option.toLocaleLowerCase().includes(value.toLocaleLowerCase()))) throw new RuntimeDataBindingBlockedError('负例关键词仍能匹配候选项')
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
