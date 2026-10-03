import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import test from 'node:test'
import CaseDesignProvider from './provider'

test('真实生成器解析失败仍保存输入配置指纹及当前阶段，不泄露配置密钥',async()=>{
  const original={...process.env}
  const server=createServer((_request,response)=>{
    response.writeHead(200,{'content-type':'application/json'})
    response.end(JSON.stringify({output_text:JSON.stringify({facts:'invalid',questions:[]})}))
  })
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
  try{
    Object.assign(process.env,{MODEL_API_KEY:'synthetic-secret-not-for-output',MODEL_BASE_URL:`http://127.0.0.1:${(server.address() as AddressInfo).port}`,MODEL_PROTOCOL:'openai-responses',MODEL_NAME:'fixture',QUALITY_AI_EVAL_MODE:'stub'})
    const provider=new CaseDesignProvider()
    const result=await provider.callApi(JSON.stringify({sampleId:'invalid-facts',documents:[{fileName:'公开合成材料',role:'prd',content:'点击查询显示结果'}]}))
    assert.ok(result.error)
    assert.equal(result.metadata.failedStage,'extracting')
    assert.deepEqual(result.metadata.completedStages,[])
    assert.match(result.metadata.provenance?.inputHash??'',/^[a-f0-9]{64}$/)
    assert.match(result.metadata.provenance?.modelConfigHash??'',/^[a-f0-9]{64}$/)
    assert.equal(result.metadata.provenance?.evidenceMode,'stub')
    assert.doesNotMatch(JSON.stringify(result),/synthetic-secret-not-for-output/)
    const invalid=await provider.callApi('not-json')
    assert.equal(invalid.metadata.failedStage,'input')
    assert.equal(invalid.metadata.provenance?.inputHash,undefined)
  }finally{
    process.env=original
    server.closeAllConnections()
    await new Promise<void>(resolve=>server.close(()=>resolve()))
  }
})
