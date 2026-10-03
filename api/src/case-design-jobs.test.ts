import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { before, after } from 'node:test'
import type { DesignRun } from '@quality-ai/contracts/case-design'

const directory = mkdtempSync(join(tmpdir(),'quality-ai-design-jobs-'))
process.env.QUALITY_AI_DATABASE_PATH = join(directory,'test.sqlite')
const { createApiServer } = await import('./app')
const { database } = await import('./storage/database')
const { saveDesignRun, recoverInterruptedDesignRuns, listDesignRuns } = await import('./modules/case-design/repository')
const api = createApiServer()
let mode: 'valid' | 'invalid' | 'hold' = 'valid'
let release: (()=>void) | undefined
let received = 0
let failAt = -1
const model = createServer(async (request,response) => {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  const body = JSON.parse(Buffer.concat(chunks).toString())
  const message = body.input[0].content as string
  const input = JSON.parse(message.slice(message.indexOf('：')+1).split('\n\nReturn only')[0])
  const block = input.blocks[0]
  received += 1
  if (mode === 'hold') await new Promise<void>(resolve=> {release=resolve})
  response.writeHead(200,{'content-type':'application/json'})
  response.end(JSON.stringify({output_text:JSON.stringify({facts:[{id:'f1',statement:'支持搜索',kind:'explicit',evidence:[{documentId:block.documentId,blockId:block.id,quote:mode==='invalid'||received===failAt?'凭空生成的原文':block.text}],relatedQuestionIds:[]}],questions:[]})}))
})
let url = ''
before(async()=> {
  await new Promise<void>(resolve=>model.listen(0,'127.0.0.1',resolve))
  await new Promise<void>(resolve=>api.listen(0,'127.0.0.1',resolve))
  process.env.MODEL_API_KEY='synthetic-key'
  process.env.MODEL_BASE_URL=`http://127.0.0.1:${(model.address() as AddressInfo).port}`
  url=`http://127.0.0.1:${(api.address() as AddressInfo).port}`
})
after(async()=> {
  release?.(); model.closeAllConnections(); api.closeAllConnections()
  await Promise.all([new Promise<void>(resolve=>model.close(()=>resolve())),new Promise<void>(resolve=>api.close(()=>resolve()))])
  database.close(); rmSync(directory,{recursive:true,force:true})
})
const post = (path:string,body:unknown={}) => fetch(url+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})
async function create(content='支持搜索。') {
  const response=await post('/api/case-designs',{name:'合成任务',files:[{fileName:'prd.md',content,role:'prd'}]})
  return (await response.json()).design
}
async function waitFor(id:string,status:string):Promise<DesignRun> {
  for(let attempt=0;attempt<200;attempt++) {
    const {runs}=await (await fetch(`${url}/api/case-designs/${id}`)).json()
    if(runs[0]?.status===status) return runs[0]
    await new Promise(resolve=>setTimeout(resolve,10))
  }
  throw new Error(`未达到 ${status}`)
}
test('background generation survives request completion and records model, input and validated output',async()=> {
  const design=await create()
  const response=await post(`/api/case-designs/${design.id}/runs`,{stage:'extracting',expectedRevision:1})
  assert.equal(response.status,202)
  const run=await waitFor(design.id,'completed')
  assert.equal(run.inputHash,design.inputHash)
  assert.equal(run.output.facts[0].id,'b1:f1')
  assert.equal(run.output.unprocessedBlockIds.length,0)
  assert.equal(run.statistics.calls,1)
  assert.ok(run.statistics.outputCharacters>0)
  assert.equal(JSON.stringify(run).includes('synthetic-key'),false)
})
test('invalid evidence fails without approving output; retries create separate attempts',async()=> {
  const design=await create(); mode='invalid'
  await post(`/api/case-designs/${design.id}/runs`,{stage:'extracting',expectedRevision:1})
  const failed=await waitFor(design.id,'failed')
  assert.match(failed.error!,/依据校验失败/)
  assert.equal(failed.output.facts.length,0)
  mode='valid'
  await post(`/api/case-designs/${design.id}/runs`,{stage:'extracting',expectedRevision:1})
  assert.equal((await waitFor(design.id,'completed')).attempt,2)
  assert.equal(listDesignRuns(design.id)[1].status,'failed')
})
test('cancellation cannot be overwritten by a late model result; startup recovers orphaned runs',async()=> {
  const design=await create(); mode='hold'
  const initial=received
  await post(`/api/case-designs/${design.id}/runs`,{stage:'extracting',expectedRevision:1})
  await waitFor(design.id,'running')
  for(let i=0;i<100 && received===initial;i++) await new Promise(resolve=>setTimeout(resolve,10))
  assert.ok(received>initial)
  assert.equal((await post(`/api/case-designs/${design.id}/runs`,{stage:'extracting',expectedRevision:1})).status,409)
  assert.equal((await (await post(`/api/case-designs/${design.id}/cancel`)).json()).cancelled,true)
  release?.(); mode='valid'
  const cancelled=await waitFor(design.id,'cancelled')
  assert.equal(cancelled.output.facts.length,0)
  saveDesignRun({...cancelled,id:'orphan',status:'running'})
  assert.equal(recoverInterruptedDesignRuns(),1)
  assert.equal(listDesignRuns(design.id).find(run=>run.id==='orphan')?.status,'interrupted')
  assert.equal((await post(`/api/case-designs/${design.id}/runs`,{stage:'extracting',expectedRevision:99})).status,409)
})

test('later batch failure keeps completed batch facts and explicit unprocessed block list',async()=> {
  const design=await create('支持搜索。'.repeat(6000))
  failAt=received+2
  await post(`/api/case-designs/${design.id}/runs`,{stage:'extracting',expectedRevision:1})
  const run=await waitFor(design.id,'failed')
  assert.equal(run.statistics.calls,2)
  assert.equal(run.output.facts.length,1)
  assert.equal(run.output.processedBlockIds.length,2)
  assert.equal(run.output.unprocessedBlockIds.length,1)
  assert.match(run.modelConfigHash,/^[a-f0-9]{64}$/)
  failAt=-1
})
