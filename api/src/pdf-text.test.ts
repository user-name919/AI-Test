import assert from 'node:assert/strict'
import test from 'node:test'
import { extractPdfText } from './pdf-text'
import { parseSourceDocuments } from './source-documents'

function createTextPdf(text: string) {
  const escaped = text.replace(/([\\()])/g, '\\$1')
  const stream = `BT /F1 14 Tf 72 720 Td (${escaped}) Tj ET`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let output = '%PDF-1.4\n'
  const offsets = [0]
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(output))
    output += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const xrefOffset = Buffer.byteLength(output)
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  output += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  return new Uint8Array(Buffer.from(output, 'ascii'))
}

test('extracts readable requirement text and page boundaries from a PDF', async () => {
  const result = await extractPdfText(createTextPdf('Product requirement: student search and save flow'))
  assert.equal(result.pageCount, 1)
  assert.match(result.content, /第 1 页/)
  assert.match(result.content, /student search and save flow/)
})

test('parses PDF and Markdown files into one model-ready document list', async () => {
  const pdf = createTextPdf('Main product requirement from PDF document')
  const documents = await parseSourceDocuments([
    { fileName: 'student-prd.pdf', contentBase64: Buffer.from(pdf).toString('base64'), role: 'prd' },
    { fileName: 'api.md', content: '# API\nPOST /students', role: 'interface' },
  ])
  assert.equal(documents.length, 2)
  assert.match(documents[0].content, /Main product requirement/)
  assert.equal(documents[1].role, 'interface')
})

test('promotes the first technical document when no explicit PRD is uploaded', async () => {
  const pdf = createTextPdf('Technical solution: student search and save flow')
  const documents = await parseSourceDocuments([
    { fileName: 'student-solution.pdf', contentBase64: Buffer.from(pdf).toString('base64'), role: 'interface' },
    { fileName: 'student-api.md', content: '# API\nPOST /students', role: 'interface' },
  ])

  assert.equal(documents[0].role, 'prd')
  assert.equal(documents[1].role, 'interface')
})

test('keeps an explicit PRD as primary when technical documents are uploaded first', async () => {
  const documents = await parseSourceDocuments([
    { fileName: 'student-api.md', content: '# API\nPOST /students', role: 'interface' },
    { fileName: 'student-prd.md', content: '# PRD\nStudent search requirement', role: 'prd' },
  ])

  assert.equal(documents[0].role, 'interface')
  assert.equal(documents[1].role, 'prd')
})

test('rejects invalid and image-only PDF input with actionable messages', async () => {
  await assert.rejects(extractPdfText(new Uint8Array(Buffer.from('not a pdf'))), /有效的 PDF/)
  await assert.rejects(extractPdfText(createTextPdf('')), /OCR/)
})
