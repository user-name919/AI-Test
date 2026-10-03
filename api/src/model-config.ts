export interface ModelConfig {
  apiKey: string
  baseUrl: string
  model: string
  protocol: 'openai-responses'
  userAgent: string
  originator: string
}

export function getModelConfig(overrides: Partial<ModelConfig> = {}): ModelConfig {
  const apiKey = overrides.apiKey ?? process.env.MODEL_API_KEY ?? process.env.DEEPSEEK_API_KEY
  if (!apiKey) throw new Error('MODEL_API_KEY 未配置')
  const protocol = overrides.protocol ?? process.env.MODEL_PROTOCOL ?? 'openai-responses'
  if (protocol !== 'openai-responses') throw new Error(`不支持的模型协议：${protocol}`)
  return {
    apiKey,
    baseUrl: (overrides.baseUrl ?? process.env.MODEL_BASE_URL ?? 'http://ai-service.tal.com/coding/v1').replace(/\/$/, ''),
    model: overrides.model ?? process.env.MODEL_NAME ?? 'gpt-5.6-terra',
    protocol,
    userAgent: overrides.userAgent ?? process.env.MODEL_USER_AGENT ?? 'codex_cli_rs/0.147.0-alpha.1.2 (quality-ai; node)',
    originator: overrides.originator ?? process.env.MODEL_ORIGINATOR ?? 'codex_cli_rs',
  }
}
