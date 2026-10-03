import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'

const maxPdfBytes = 15 * 1024 * 1024
const maxPdfPages = 200
const maxPdfCharacters = 400_000

function normalizePageText(items: unknown[]) {
  let text = ''
  for (const item of items) {
    if (!item || typeof item !== 'object' || !('str' in item) || typeof item.str !== 'string') continue
    const value = item.str.trim()
    if (value) text += `${text && !text.endsWith('\n') ? ' ' : ''}${value}`
    if ('hasEOL' in item && item.hasEOL) text += '\n'
  }
  return text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

export interface PdfTextResult {
  content: string
  pageCount: number
}

export async function extractPdfText(data: Uint8Array): Promise<PdfTextResult> {
  if (!data.byteLength) throw new Error('PDF 文件为空')
  if (data.byteLength > maxPdfBytes) throw new Error('单个 PDF 不能超过 15MB')
  if (new TextDecoder('ascii').decode(data.slice(0, 5)) !== '%PDF-') throw new Error('文件不是有效的 PDF')

  const loadingTask = getDocument({ data: data.slice(), useSystemFonts: true })
  try {
    const document = await loadingTask.promise
    if (document.numPages > maxPdfPages) throw new Error(`PDF 页数超过上限 ${maxPdfPages}`)
    const pages: string[] = []
    let characters = 0
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber)
      const pageText = normalizePageText((await page.getTextContent()).items)
      if (pageText) {
        characters += pageText.length
        if (characters > maxPdfCharacters) throw new Error('PDF 正文超过 40 万字符，请拆分后上传')
        pages.push(`--- 第 ${pageNumber} 页 ---\n${pageText}`)
      }
      page.cleanup()
    }
    const content = pages.join('\n\n').trim()
    if (content.replace(/\s/g, '').length < 10) throw new Error('PDF 未提取到可用文字，可能是扫描件，请先进行 OCR')
    return { content, pageCount: document.numPages }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/password/i.test(message)) throw new Error('PDF 已加密，请解除密码后重新上传')
    throw error
  } finally {
    await loadingTask.destroy()
  }
}
