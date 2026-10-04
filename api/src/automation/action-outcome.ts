/** A Playwright input error does not prove that the page did not receive the input. */
export class ActionOutcomeUnknownError extends Error {
  constructor(action: string, cause: unknown) {
    super(`${action} 调用后发生错误，操作结果不明，可能已触发业务提交；已停止整批且不会自动重试。请人工核对实际状态后再决定是否重新执行。原始错误：${cause instanceof Error ? cause.message : String(cause)}`, { cause })
  }
}

export async function attemptInputAction(action: string, dispatch: () => Promise<unknown>) {
  try { await dispatch() }
  catch (error) { throw new ActionOutcomeUnknownError(action, error) }
}
