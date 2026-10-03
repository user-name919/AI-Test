import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import type { ExecutionRecord } from '@quality-ai/contracts'

test('独立证据接口兼容旧附件URL，拒绝未登记文件、越界软链和错误编码', async () => {
  const directory=await mkdtemp(join(tmpdir(),'quality-ai-evidence-route-'))
  const before=process.env.QUALITY_AI_DATA_ROOT,beforeDb=process.env.QUALITY_AI_DATABASE_PATH
  process.env.QUALITY_AI_DATA_ROOT=directory;process.env.QUALITY_AI_DATABASE_PATH=join(directory,'test.sqlite')
  const {handleExecutionEvidenceRoutes}=await import('./modules/executions/evidence-routes')
  const {saveExecution}=await import('./modules/executions/repository')
  const {database}=await import('./storage/database')
  const id=randomUUID(),root=join(directory,'artifacts',id)
  await mkdir(join(root,'case'),{recursive:true})
  const screenshot=join(root,'中文截图.png'),trace=join(root,'trace.zip'),nested=join(root,'case','failure.png')
  for(const file of [screenshot,trace,nested,join(root,'unregistered.png')])await writeFile(file,'synthetic artifact bytes')
  const outside=join(directory,'outside.png');await writeFile(outside,'not an execution artifact')
  const linked=join(root,'linked.png');await symlink(outside,linked)
  const record:ExecutionRecord={id,name:'附件兼容',targetUrl:'http://example.test',status:'failed',startedAt:'now',finishedAt:'now',durationMs:0,steps:[],screenshots:[screenshot,nested,linked],tracePath:trace,caseKeys:[]}
  saveExecution(record)
  const api=createServer((request,response)=>{if(!handleExecutionEvidenceRoutes(request,response)){response.writeHead(404);response.end()}})
  await new Promise<void>(resolve=>api.listen(0,'127.0.0.1',resolve))
  const address=api.address();assert.ok(address&&typeof address!=='string')
  const base=`http://127.0.0.1:${address.port}`
  try{
    const legacy=await fetch(`${base}/api/artifacts/${id}/${encodeURIComponent('中文截图.png')}`)
    assert.equal(legacy.status,200);assert.equal(await legacy.text(),'synthetic artifact bytes')
    assert.match(legacy.headers.get('content-disposition')??'',/^attachment;/)
    assert.equal(legacy.headers.get('x-content-type-options'),'nosniff')
    assert.equal((await fetch(`${base}/api/artifacts/${id}/trace.zip`)).headers.get('content-type'),'application/zip')
    assert.equal((await fetch(`${base}/api/artifacts/${id}/unregistered.png`)).status,404)
    assert.equal((await fetch(`${base}/api/artifacts/${id}/linked.png`)).status,404)
    assert.equal((await fetch(`${base}/api/artifacts/${id}/%ZZ`)).status,400)
    assert.equal((await fetch(`${base}/api/artifacts/${id}/..%2Foutside.png`)).status,400)
    assert.equal((await fetch(`${base}/api/artifacts/${randomUUID()}/trace.zip`)).status,404)
    const list=await (await fetch(`${base}/api/executions/${id}/artifacts`)).json()
    assert.ok(list.artifacts.every((item:Record<string,unknown>)=>!('path' in item)))
    const nestedArtifact=list.artifacts.find((item:{name:string})=>item.name==='failure.png')
    const current=await fetch(base+nestedArtifact.url)
    assert.equal(current.status,200);assert.match(current.headers.get('content-disposition')??'',/^inline;/)
    assert.match((await fetch(`${base}${nestedArtifact.url}?download=1`)).headers.get('content-disposition')??'',/^attachment;/)
    const markdown=await fetch(`${base}/api/executions/${id}/report.md`)
    assert.equal(markdown.status,200);assert.match(await markdown.text(),/历史记录未采集逐用例结果/)
  }finally{
    await new Promise<void>(resolve=>{api.closeAllConnections();api.close(()=>resolve())});database.close()
    if(before===undefined)delete process.env.QUALITY_AI_DATA_ROOT;else process.env.QUALITY_AI_DATA_ROOT=before
    if(beforeDb===undefined)delete process.env.QUALITY_AI_DATABASE_PATH;else process.env.QUALITY_AI_DATABASE_PATH=beforeDb
    await rm(directory,{recursive:true,force:true})
  }
})
