import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { ExecutionRecord } from '@quality-ai/contracts'
import { executionArtifacts } from './modules/executions/artifacts'

test('附件只解析登记且位于本次执行目录的真实文件，拒绝越界软链',()=>{
  const directory=mkdtempSync(join(tmpdir(),'quality-ai-artifacts-'))
  const before=process.env.QUALITY_AI_DATA_ROOT
  process.env.QUALITY_AI_DATA_ROOT=directory
  try{
    const root=join(directory,'artifacts','execution');mkdirSync(root,{recursive:true})
    const nested=join(root,'case');mkdirSync(nested)
    const screenshot=join(nested,'failure.png');writeFileSync(screenshot,'fixture')
    const external=join(directory,'private.png');writeFileSync(external,'do not serve')
    const link=join(root,'linked.png');symlinkSync(external,link)
    const execution:ExecutionRecord={id:'execution',name:'合成',targetUrl:'http://localhost',status:'failed',startedAt:'now',finishedAt:'now',durationMs:0,steps:[],screenshots:[screenshot,external,link,join(root,'missing.png')],caseKeys:[]}
    const artifacts=executionArtifacts(execution)
    assert.equal(artifacts.length,3)
    assert.equal(artifacts.find(item=>item.name==='failure.png')?.available,true)
    assert.equal(artifacts.find(item=>item.name==='linked.png')?.available,false)
    assert.equal(artifacts.find(item=>item.name==='missing.png')?.available,false)
    assert.ok(artifacts.every(item=>!item.url.includes(directory)))
    const outsideRoot=join(directory,'outside');mkdirSync(outsideRoot);writeFileSync(join(outsideRoot,'trace.zip'),'fixture')
    symlinkSync(outsideRoot,join(directory,'artifacts','redirected'))
    assert.equal(executionArtifacts({...execution,id:'redirected',screenshots:[],tracePath:join(directory,'artifacts','redirected','trace.zip')})[0]?.available,false)
  }finally{if(before===undefined)delete process.env.QUALITY_AI_DATA_ROOT;else process.env.QUALITY_AI_DATA_ROOT=before;rmSync(directory,{recursive:true,force:true})}
})
