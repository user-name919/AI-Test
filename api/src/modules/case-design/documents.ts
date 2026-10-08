import { createHash, randomUUID } from 'node:crypto'
import type { DesignDocument, DocumentBlock } from '@quality-ai/contracts/case-design'
import type { SourceDocument } from '../../model'

export function createEvidenceDocuments(sources: SourceDocument[]): DesignDocument[] {
  return sources.map(source => {
    const id = randomUUID()
    const blocks: DocumentBlock[] = []
    let section: string | undefined
    const append = (text: string, kind: DocumentBlock['kind'], page?: number, warnings: string[] = []) => {
      // 不截断大段正文；固定大小分块，后续阶段必须记录每块处理状态。
      const chunks = text.match(/[\s\S]{1,12000}/g) ?? ['']
      chunks.forEach(chunk => blocks.push({ id: `${id}:b${blocks.length + 1}`, documentId: id, kind, page, section, text: chunk, warnings: [...warnings] }))
    }
    if (source.pages) {
      for (const page of source.pages) append(page.text, page.text ? 'paragraph' : 'image_placeholder', page.page, page.warnings)
    } else {
      for (const text of source.content.split(/\n\s*\n/).filter(text => text.trim())) {
        if (/^#{1,6}\s/m.test(text)) {
          // 标题和紧随其后的正文分别保存，不把整段伪装成标题。
          for (const line of text.split('\n')) {
            if (/^#{1,6}\s/.test(line)) { section = line.replace(/^#{1,6}\s+/, ''); append(line, 'heading') }
            else if (line.trim()) append(line, 'paragraph')
          }
        } else if (/!\[.*?\]\(|<img\b|\[图片数据已省略\]/i.test(text)) {
          append(text, 'image_placeholder', undefined, ['图片内容未识别，仅保留原文和替代文本，不作为图片语义已提取的证明'])
        } else append(text, text.includes('|') && /\|[\s:-]+\|/.test(text) ? 'table' : 'paragraph')
      }
    }
    return { id, fileName: source.fileName, role: source.role, contentHash: createHash('sha256').update(source.content).digest('hex'), version: 1, blocks, warnings: [...new Set(blocks.flatMap(block => block.warnings))] }
  })
}
