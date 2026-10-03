import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import type { RequirementFact } from '@quality-ai/contracts/case-design'

// Transport fixture, not an intelligent model or a quality reference answer.
const counts:Record<string,number>={}
const server=createServer(async(request,response)=>{
  try{
    const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(Buffer.from(chunk))
    const body=JSON.parse(Buffer.concat(chunks).toString())
    const instructions=body.instructions as string
    const stage=instructions.includes('资深 B 端')?'legacy':instructions.match(/阶段：(\w+)/)?.[1]??'extracting'
    counts[stage]=(counts[stage]??0)+1
    let output:unknown
    if(stage==='legacy')output={versionName:'合成夹具',productName:'非真实业务',overview:'仅验证协议',requirements:[{title:'合成场景',summary:'只验证评估传输',risk:'低风险',riskReason:'夹具',businessRules:[{description:'夹具规则',evidence:'合成依据不代表语义验证'}],pageStates:[{trigger:'打开',initialState:'初始',interaction:'操作',expectedResult:'显示'}],questions:[],testCases:[{title:'夹具用例',type:'主流程',priority:'P1',preconditions:[],steps:['执行合成操作'],expectedResult:'观察合成结果',blockedByQuestion:false,questionIds:[]}]}]}
    else{
      let text=body.input[0].content.split('\n\nReturn only')[0]
      if(stage==='extracting')text=text.slice(text.indexOf('：')+1)
      const input=JSON.parse(text)
      if(stage==='extracting')output={facts:input.blocks.map((block:{documentId:string;id:string;text:string},index:number)=>({id:`f${index}`,statement:block.text,kind:'explicit',evidence:[{documentId:block.documentId,blockId:block.id,quote:block.text}],relatedQuestionIds:[]})),questions:[]}
      else if(stage==='modeling'){
        const facts=(input.facts as Array<RequirementFact & {evidenceRefs:string[]}>).map((fact,index)=>({...fact,id:`m${index}`,sourceFactIds:[fact.id]}))
        output={consolidatedFacts:facts,conflicts:facts.length>1?[{id:'conflict',factIds:facts.map(item=>item.id),question:'合成材料冲突待人工确认',evidenceRefs:facts.flatMap(item=>item.evidenceRefs)}]:[]}
      }else if(stage==='planning')output={scenarios:[{id:'s1',title:'夹具场景',testIntent:'验证生成协议',factIds:input.facts.map((fact:RequirementFact)=>fact.id),questionIds:[],coverage:'positive'}]}
      else if(stage==='generating'){
        const text=input.facts.map((fact:RequirementFact)=>fact.statement).join('\n')
        const strategy=text.includes('无匹配')?'non_matching_option_query':text.includes('部分关键词')?'visible_option_substring':'visible_option_full'
        output={cases:[{title:'合成生成用例',verification:'browser',verificationReason:'夹具，不代表业务可验证性',contract:{objective:'验证夹具流程',preconditions:['准备合成页面'],steps:['观察后输入'],expectedAssertions:['匹配合成结果'],dataBindings:[{id:'query',label:'查询词',mode:'runtime_dom',strategy,targetHint:'合成搜索框',businessIntent:'仅检查策略传输',constraints:{mustComeFromCurrentDom:true,mustBePartialOfSource:strategy==='visible_option_substring'},...(strategy==='non_matching_option_query'?{optionUniverse:{completeness:'unknown',options:[],evidence:''}}:{})}],forbiddenBehaviors:[],uncertainties:[]}}]}
      }else output={issues:[]}
    }
    response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify({output_text:JSON.stringify(output)}))
  }catch(error){response.writeHead(500);response.end(JSON.stringify({error:String(error)}))}
})
await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
const root=resolve(import.meta.dirname,'../..')
const directory=resolve(root,'outputs/case-design-stub')
mkdirSync(directory,{recursive:true})
try{
  const exitCode=await new Promise<number>((resolveExit,reject)=>{
    const child=spawn('pnpm',['exec','promptfoo','eval','-c','evals/case-design/promptfooconfig.yaml','--no-cache','--no-share','--no-write','--no-table','--no-progress-bar','-o',resolve(directory,'results.json')],{
      cwd:root,stdio:'inherit',env:{...process.env,MODEL_API_KEY:'local-synthetic-key',MODEL_BASE_URL:`http://127.0.0.1:${(server.address() as AddressInfo).port}`,MODEL_NAME:'synthetic-transport-fixture',MODEL_PROTOCOL:'openai-responses',QUALITY_AI_EVAL_MODE:'stub',PROMPTFOO_DISABLE_TELEMETRY:'1',PROMPTFOO_CONFIG_DIR:resolve(directory,'config')},
    })
    child.on('error',reject);child.on('close',code=>resolveExit(code??1))
  })
  console.log('本地夹具请求计数（不是质量成绩）：',JSON.stringify(counts))
  process.exitCode=exitCode
}finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()))}
