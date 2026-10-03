import type { ModelConfig } from './model-config'

export interface ModelMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

interface ResponsesPayload {
  status?: string
  error?: { message?: string } | null
  incomplete_details?: { reason?: string } | null
  output_text?: string
  output?: Array<{
    type?: string
    content?: Array<{ type?: string; text?: string }>
  }>
}

interface GenerateTextInput {
  messages: ModelMessage[]
  maxOutputTokens: number
}

function outputText(payload: ResponsesPayload) {
  if (typeof payload.output_text === 'string' && payload.output_text.trim()) return payload.output_text.trim()
  const text = payload.output
    ?.flatMap(item => item.type === 'message' ? item.content ?? [] : [])
    .filter(item => item.type === 'output_text' && typeof item.text === 'string')
    .map(item => item.text)
    .join('')
    .trim()
  return text || undefined
}

export class ResponsesModelClient {
  constructor(
    private readonly config: ModelConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 180_000,
  ) {}

  async generateText(input: GenerateTextInput) {
    const instructions = input.messages
      .filter(message => message.role === 'system')
      .map(message => message.content)
      .join('\n\n')
    const responseInput = input.messages
      .filter(message => message.role !== 'system')
      .map(message => ({ role: message.role, content: message.content }))
    let lastUserMessageIndex = -1
    responseInput.forEach((message, index) => {
      if (message.role === 'user') lastUserMessageIndex = index
    })
    const jsonModeInstruction = 'Return only a valid json object.'
    if (lastUserMessageIndex >= 0) {
      const message = responseInput[lastUserMessageIndex]
      responseInput[lastUserMessageIndex] = { ...message, content: `${message.content}\n\n${jsonModeInstruction}` }
    } else {
      responseInput.push({ role: 'user', content: jsonModeInstruction })
    }
    const response = await this.fetchImpl(`${this.config.baseUrl}/responses`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.config.apiKey}`,
        'content-type': 'application/json',
        'user-agent': this.config.userAgent,
        originator: this.config.originator,
      },
      body: JSON.stringify({
        model: this.config.model,
        instructions: instructions || undefined,
        input: responseInput,
        text: { format: { type: 'json_object' } },
        max_output_tokens: input.maxOutputTokens,
        store: false,
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    const payload = await response.json() as ResponsesPayload
    if (!response.ok) throw new Error(payload.error?.message ?? `模型请求失败（HTTP ${response.status}）`)
    if (payload.status === 'incomplete') {
      throw new Error(`模型输出未完成：${payload.incomplete_details?.reason ?? '未知原因'}`)
    }
    const text = outputText(payload)
    if (!text) throw new Error('模型返回了空内容')
    return text
  }
}
