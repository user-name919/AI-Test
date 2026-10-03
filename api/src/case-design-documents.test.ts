import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import test, { after, before } from 'node:test'
import { createEvidenceDocuments } from './modules/case-design/documents'
import { validateFactEvidence } from './modules/case-design/evidence-validator'

const directory = mkdtempSync(join(tmpdir(), 'quality-ai-design-docs-'))
process.env.QUALITY_AI_DATABASE_PATH = join(directory, 'test.sqlite')
const { createApiServer } = await import('./app')
const { database } = await import('./storage/database')
const server = createApiServer()
let url = ''
before(async () => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
after(async () => {
  await new Promise<void>((resolve,reject) => server.close(error => error ? reject(error) : resolve()))
  database.close(); rmSync(directory, { recursive:true, force:true })
})

test('same file names remain distinct and all large text is represented without truncation', () => {
  const content = '甲'.repeat(25001)
  const documents = createEvidenceDocuments([{ fileName:'same.md', role:'prd', content }, { fileName:'same.md', role:'interface', content:'另一份规则' }])
  assert.notEqual(documents[0].id, documents[1].id)
  assert.equal(documents[0].blocks.map(block => block.text).join(''), content)
  assert.equal(documents[0].blocks.length, 3)
})

test('evidence validates complete excerpts and does not accept fabricated quotes or foreign blocks', () => {
  const documents = createEvidenceDocuments([{ fileName:'prd.md', role:'prd', content:'# 搜索\n\n支持 模糊\n搜索。\n\n![界面](diagram.png)' }])
  const block = documents[0].blocks[1]
  const fact = { id:'f1', statement:'支持模糊搜索', kind:'explicit' as const, relatedQuestionIds:[], evidence:[{ documentId:documents[0].id, blockId:block.id, quote:'支持 模糊 搜索。' }] }
  assert.deepEqual(validateFactEvidence([fact],documents), [])
  assert.equal(validateFactEvidence([{...fact,evidence:[]}],documents).length, 1)
  assert.equal(validateFactEvidence([{...fact,evidence:[{...fact.evidence[0],quote:'支持搜索且不区分大小写'}]}],documents).length, 1)
  assert.equal(validateFactEvidence([{...fact,evidence:[{...fact.evidence[0],documentId:'other'}]}],documents).length, 1)
  assert.match(documents[0].warnings.join(' '), /图片内容未识别/)
})

test('create and reopen a design without model credentials or test environment', async () => {
  const response = await fetch(`${url}/api/case-designs`, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({name:'独立设计',files:[{fileName:'同名.md',content:'# 规则\n\n支持搜索',role:'prd'},{fileName:'同名.md',content:'只匹配完整名称',role:'interface'}]}) })
  assert.equal(response.status, 201)
  const { design } = await response.json()
  assert.equal(design.documents.length, 2)
  assert.notEqual(design.documents[0].id,design.documents[1].id)
  assert.match(design.inputHash,/^[a-f0-9]{64}$/)
  const reopened = await (await fetch(`${url}/api/case-designs/${design.id}`)).json()
  assert.deepEqual(reopened.design,design)
  const list = await (await fetch(`${url}/api/case-designs`)).json()
  assert.equal(list.designs[0].documentCount,2)
  assert.equal((await fetch(`${url}/api/case-designs/missing`)).status,404)
})
