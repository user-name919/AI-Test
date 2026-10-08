import type { IncomingMessage, ServerResponse } from 'node:http'
import { json, readJson } from '../../http/response'
import { createMemory, listMemories, reviewMemory } from './repository'

export async function handleMemoryRoutes(request:IncomingMessage,response:ServerResponse):Promise<boolean>{
  const url=new URL(request.url??'/','http://localhost')
  if(url.pathname==='/api/memories'){
    if(request.method==='GET')return json(response,200,{memories:listMemories(url.searchParams.get('projectId')||undefined)})
    if(request.method==='POST'){
      try{return json(response,201,{memory:createMemory(await readJson(request))})}
      catch(error){return json(response,400,{error:error instanceof Error?error.message:'登记失败'})}
    }
    return json(response,405,{error:'不支持此操作'})
  }
  const match=url.pathname.match(/^\/api\/memories\/([a-f0-9-]+)\/review$/i)
  if(match){
    if(request.method!=='POST')return json(response,405,{error:'审核需要POST请求'})
    try{return json(response,200,{memory:reviewMemory(match[1],await readJson(request))})}
    catch(error){return json(response,409,{error:error instanceof Error?error.message:'审核失败'})}
  }
  return false
}
