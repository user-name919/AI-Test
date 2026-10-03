import type { SourceDocument } from './model'
import { extractPdfText } from './pdf-text'

const maxCombinedCharacters = 800_000

function sanitizeContent(content: string) {
  return content
    .replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g, '[图片数据已省略]')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim()
}

function decodeBase64(value: unknown) {
  if (typeof value !== 'string' || !value || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error('PDF 二进制内容格式错误')
  return new Uint8Array(Buffer.from(value, 'base64'))
}

export async function parseSourceDocuments(rawFiles: unknown[]): Promise<SourceDocument[]> {
  if (!rawFiles.length || rawFiles.length > 5) throw new Error('一次请选择 1-5 份需求材料')
  const documents = await Promise.all(rawFiles.map(async (item, index) => {
    if (!item || typeof item !== 'object') throw new Error(`第 ${index + 1} 份材料格式错误`)
    const value = item as Record<string, unknown>
    const fileName = typeof value.fileName === 'string' ? value.fileName.trim() : ''
    const role = value.role === 'interface' ? 'interface' as const : 'prd' as const
    if (!fileName) throw new Error(`第 ${index + 1} 份材料名称为空`)
    if (/\.pdf$/i.test(fileName)) {
      const pdf = await extractPdfText(decodeBase64(value.contentBase64))
      return { fileName, content: sanitizeContent(pdf.content), role }
    }
    if (!/\.(md|markdown|txt)$/i.test(fileName)) throw new Error('当前支持 PDF、Markdown 和纯文本材料')
    const content = typeof value.content === 'string' ? sanitizeContent(value.content) : ''
    if (!content) throw new Error(`第 ${index + 1} 份材料内容为空`)
    return { fileName, content, role }
  }))
  const normalizedDocuments = documents.some(document => document.role === 'prd')
    ? documents
    : documents.map((document, index) => index === 0 ? { ...document, role: 'prd' as const } : document)
  if (normalizedDocuments.reduce((sum, document) => sum + document.content.length, 0) > maxCombinedCharacters) {
    throw new Error('需求材料正文合计超过 80 万字符，请拆分后上传')
  }
  return normalizedDocuments
}
