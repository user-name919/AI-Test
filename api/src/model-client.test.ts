import assert from 'node:assert/strict'
import test from 'node:test'
import { ResponsesModelClient } from './model-client'

const config = {
  apiKey: 'test-key', baseUrl: 'http://gateway.test/v1', model: 'test-model', protocol: 'openai-responses' as const,
  userAgent: 'codex_cli_rs/test', originator: 'codex_cli_rs',
}

test('sends an OpenAI Responses request with coding client attribution', async () => {
  let request: { url: string; init?: RequestInit } | undefined
  const client = new ResponsesModelClient(config, async (input, init) => {
    request = { url: String(input), init }
    return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '{"ok":true}' }] }] }), { status: 200 })
  })
  assert.equal(await client.generateText({ messages: [{ role: 'system', content: 'JSON' }, { role: 'user', content: '返回结果' }], maxOutputTokens: 100 }), '{"ok":true}')
  assert.equal(request?.url, 'http://gateway.test/v1/responses')
  const headers = new Headers(request?.init?.headers)
  assert.equal(headers.get('user-agent'), 'codex_cli_rs/test')
  assert.equal(headers.get('originator'), 'codex_cli_rs')
  const body = JSON.parse(String(request?.init?.body)) as { instructions: string; input: Array<{ role: string; content: string }>; max_output_tokens: number; temperature?: number }
  assert.equal(body.instructions, 'JSON')
  assert.equal(body.input[0].role, 'user')
  assert.match(body.input[0].content, /\bjson\b/)
  assert.equal(body.max_output_tokens, 100)
  assert.equal(body.temperature, undefined)
})

test('accepts gateway output_text convenience responses', async () => {
  const client = new ResponsesModelClient(config, async () => new Response(JSON.stringify({ status: 'completed', output_text: '{"value":1}' }), { status: 200 }))
  assert.equal(await client.generateText({ messages: [{ role: 'user', content: 'JSON' }], maxOutputTokens: 100 }), '{"value":1}')
})

test('rejects incomplete Responses output', async () => {
  const client = new ResponsesModelClient(config, async () => new Response(JSON.stringify({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }), { status: 200 }))
  await assert.rejects(client.generateText({ messages: [{ role: 'user', content: 'JSON' }], maxOutputTokens: 100 }), /max_output_tokens/)
})
