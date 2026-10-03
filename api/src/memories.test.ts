import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'

test('记忆保留执行来源与项目范围，审核需要显式理由且不覆盖原报告',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'quality-ai-memories-'))
  process.env.QUALITY_AI_DATABASE_PATH=join(directory,'db.sqlite')
  const {database}=await import('./storage/database')
  const {saveExecution,getExecutionById}=await import('./modules/executions/repository')
  const {initializeMemories,selectMemoryHints}=await import('./modules/memories/repository')
  const {handleMemoryRoutes}=await import('./modules/memories/routes')
  initializeMemories()
  const server=createServer(async(req,res)=>{if(!await handleMemoryRoutes(req,res)){res.writeHead(404);res.end()}})
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
  const address=server.address();assert.ok(address&&typeof address!=='string')
  const base=`http://127.0.0.1:${address.port}/api/memories`
  const post=(url:string,body:unknown)=>fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})
  try{
    saveExecution({id:'source',name:'合成失败',status:'failed',mode:'plan',targetUrl:'https://example.test/search',startedAt:'2026-10-04',finishedAt:'2026-10-04',durationMs:10,steps:[],screenshots:[],error:'未找到匹配项',sourceProject:{id:'project-a',commit:'a'.repeat(40)},caseResults:[{caseKey:'case-1',title:'部分搜索',contractFingerprint:'frozen',status:'failed',continuation:'reused_current_page',error:'匹配结果为空',startedFromUrl:'https://example.test/search',resolvedDataBindings:[],passedAssertions:[],trajectory:[],steps:[],screenshots:[]}]},{projectId:'project-a'})
    const original=getExecutionById('source')
    assert.equal((await post(base,{executionId:'missing',lesson:'无证据'})).status,400)
    assert.equal((await post(base,{executionId:'source',caseKey:'missing',lesson:'无证据'})).status,400)
    assert.equal((await post(base,{executionId:'source',lesson:'尝试指定其他项目',projectId:'project-b'})).status,400)
    const response=await post(base,{executionId:'source',caseKey:'case-1',lesson:'搜索前先确认当前账号实际可见选项'})
    assert.equal(response.status,201)
    const memory=(await response.json()).memory
    assert.equal(memory.status,'candidate')
    assert.equal(memory.source.status,'failed')
    assert.equal(memory.source.error,'匹配结果为空')
    assert.equal(memory.source.contractFingerprint,'frozen')
    assert.equal(memory.scope.sourceProject.commit,'a'.repeat(40))
    assert.equal((await(await fetch(base+'?projectId=project-b')).json()).memories.length,0)
    assert.equal((await(await fetch(base+'?projectId=project-a')).json()).memories.length,1)
    const reviewUrl=`${base}/${memory.id}/review`
    assert.equal((await post(reviewUrl,{expectedRevision:1,status:'adopted',reason:''})).status,409)
    const adopted=(await(await post(reviewUrl,{expectedRevision:1,status:'adopted',reason:'已核对报告，仅作为选取数据建议'})).json()).memory
    assert.equal(adopted.status,'adopted')
    assert.equal(adopted.source.status,'failed','采纳经验不代表原测试通过')
    const project={id:'project-a',commit:'a'.repeat(40),worktree:{status:'clean' as const,observedAt:'now'}}
    assert.deepEqual(selectMemoryHints(project,'https://example.test/search'),[],'历史工作区未知时不自动套用经验')
    database.prepare('UPDATE quality_memories SET memory_json=? WHERE id=?').run(JSON.stringify({...adopted,scope:{...adopted.scope,sourceProject:project}}),memory.id)
    const hints=selectMemoryHints(project,'https://example.test/search')
    assert.equal(hints.length,1)
    assert.equal(hints[0].revision,2)
    assert.deepEqual(selectMemoryHints({...project,id:'project-b'},'https://example.test/search'),[])
    assert.deepEqual(selectMemoryHints({...project,commit:'b'.repeat(40)},'https://example.test/search'),[])
    assert.deepEqual(selectMemoryHints({...project,worktree:{status:'dirty',observedAt:'now'}},'https://example.test/search'),[])
    assert.deepEqual(selectMemoryHints(project,'https://example.test/other'),[])
    assert.equal((await post(reviewUrl,{expectedRevision:1,status:'invalid',reason:'过期提交'})).status,409)
    const invalid=(await(await post(reviewUrl,{expectedRevision:2,status:'invalid',reason:'页面行为已调整，停止参考'})).json()).memory
    assert.equal(invalid.reviews.length,2)
    assert.equal(invalid.status,'invalid')
    assert.deepEqual(selectMemoryHints(project,'https://example.test/search'),[])
    assert.equal(hints[0].revision,2,'历史引用不随后续审核改变')
    assert.deepEqual(invalid.source,memory.source)
    assert.deepEqual(getExecutionById('source'),original)
    initializeMemories()
    assert.equal((await(await fetch(base)).json()).memories[0].status,'invalid')
  }finally{
    await new Promise<void>(resolve=>server.close(()=>resolve()))
    database.close()
    rmSync(directory,{recursive:true,force:true})
  }
})
