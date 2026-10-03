import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import test from 'node:test'
import type { LocalChangeFacts, SourceImpact, RegressionGeneration } from '@quality-ai/contracts/regressions'
import { generateRegressionSuggestions } from './modules/regressions/suggestions'

test('公司协议客户端分批生成待审回归建议，拒绝伪造引用并保存已完成批次', async t => {
  const sha = 'a'.repeat(40), base = 'b'.repeat(40)
  const facts: LocalChangeFacts = { comparison: { mode: 'endpoints', baseRef: base, targetRef: sha }, targetSha: sha, commits: [], diffs: [{ baseSha: base, targetSha: sha, files: [{ status: 'M', path: 'Select.ts' }], patch: '+ shared select change\n' }], omittedCommitShas: [], omittedRangeBases: [], dirty: false, capturedAt: 'now', warnings: [] }
  const impact: SourceImpact = { method: 'static-import-candidates-v1', trees: [], skippedShas: [], warnings: ['静态候选不是运行证明'] }
  const requests: Array<{ evidence: Array<{ id: string }>; targetSha: string }> = []
  let invalidAfter = Infinity
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const payload = JSON.parse(Buffer.concat(chunks).toString())
    const input = JSON.parse(payload.input[0].content.split('\n\nReturn only')[0])
    requests.push(input)
    assert.equal(payload.store, false)
    assert.match(payload.instructions, /不能断言某提交已引入 bug/)
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ output_text: JSON.stringify({
      risks: [{ id: 'r1', title: '共享选择器影响', reason: '需要核对调用页面选择行为', severity: 'medium', confidence: 'low', evidenceIds: [requests.length >= invalidAfter ? 'invented' : input.evidence[0].id] }],
      cases: [{ title: '调用页面回归', riskIds: ['r1'], verification: 'manual', verificationReason: '业务预期需要人工补充', contract: { objective: '确认选择器行为', preconditions: ['打开调用页面'], steps: ['操作选择器'], expectedAssertions: ['与人工确认的交互口径一致'], dataBindings: [], forbiddenBehaviors: [], uncertainties: ['业务预期需确认'] } }],
      limitations: ['尚未执行页面'],
    }) }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())))
  const config = { apiKey: 'synthetic-only', model: 'fixture', baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, protocol: 'openai-responses' as const, userAgent: 'fixture', originator: 'fixture' }
  let progress: RegressionGeneration | undefined
  const result = await generateRegressionSuggestions(facts, impact, config, new AbortController().signal, value => { progress = value })
  assert.equal(result.reviewStatus, 'pending')
  assert.equal(result.batches[0]!.suggestions.cases[0]!.contract.uncertainties[0], '业务预期需确认')
  assert.equal(requests[0]!.targetSha, sha)
  assert.deepEqual(result.pendingEvidenceIds, [])
  assert.match(result.batches[0]!.inputHash, /^[a-f0-9]{64}$/)
  const before = requests.length
  const empty = await generateRegressionSuggestions({ ...facts, diffs: [] }, impact, config, new AbortController().signal, () => {})
  assert.equal(requests.length, before)
  assert.equal(empty.batches.length, 0)
  invalidAfter = requests.length + 2
  await assert.rejects(generateRegressionSuggestions({ ...facts, diffs: [{ ...facts.diffs[0]!, patch: '+ large change\n'.repeat(3000) }] }, impact, config, new AbortController().signal, value => { progress = value }), /不存在的源码证据/)
  assert.equal(progress!.batches.length, 1)
  assert.ok(progress!.pendingEvidenceIds.length > 0)
  assert.ok(progress!.batches[0]!.suggestions.risks.every(risk => !risk.evidenceIds.includes('invented')))
  const controller = new AbortController(); controller.abort()
  const beforeCancel = requests.length
  await assert.rejects(generateRegressionSuggestions(facts, impact, config, controller.signal, () => {}))
  assert.equal(requests.length, beforeCancel)
})
