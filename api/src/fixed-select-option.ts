import type { CaseExecutionContract } from '@quality-ai/contracts'
import { RuntimeDataBindingBlockedError } from './test-data-binding'

// 原生选项的 value/label 不是搜索词，不能套用下拉搜索的运行时数据协议。
export function validateFixedSelectData(value: string, contract?: CaseExecutionContract) {
  const approved = contract?.dataBindings.some(binding =>
    binding.mode === 'manual'
      ? binding.manual?.value === value && Boolean(binding.manual.rationale.trim())
      : binding.mode === 'fixture' && binding.fixture?.value === value && Boolean(binding.fixture.evidence.trim()),
  )
  if (!approved) throw new RuntimeDataBindingBlockedError('原生下拉选择需要最终契约中有依据的 fixture/manual 值，不得猜测选项或借用搜索词')
}
