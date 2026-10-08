import type { DesignDocument, EvidenceRef, RequirementFact } from '@quality-ai/contracts/case-design'

const normalize = (value: string) => value.replace(/\s+/g, ' ').trim()
export function validateEvidence(reference: EvidenceRef, documents: DesignDocument[]): string | null {
  const document = documents.find(item => item.id === reference.documentId)
  const block = document?.blocks.find(item => item.id === reference.blockId && item.documentId === reference.documentId)
  if (!block) return '引用的文档块不存在'
  const quote = normalize(reference.quote)
  if (!quote || !normalize(block.text).includes(quote)) return '摘录不完整匹配原文，仅允许空白归一化'
  return null
}
export function validateFactEvidence(facts: RequirementFact[], documents: DesignDocument[]) {
  const issues: Array<{ factId: string; reason: string }> = []
  const ids = new Set<string>()
  for (const fact of facts) {
    if (ids.has(fact.id)) issues.push({ factId: fact.id, reason: '事实 ID 重复' })
    ids.add(fact.id)
    if (fact.kind === 'explicit' && !fact.evidence.length) issues.push({ factId: fact.id, reason: '显式事实缺少原文依据' })
    for (const reference of fact.evidence) {
      const reason = validateEvidence(reference, documents)
      if (reason) issues.push({ factId: fact.id, reason })
    }
  }
  // 引用匹配仅证明原文存在，不证明事实被原文蕴含，仍需要语义/人工审核。
  return issues
}
