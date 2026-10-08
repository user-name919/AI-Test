// 兼容旧调用方；新领域代码直接引用所属 repository，避免恢复成集中式存储模块。
export { saveAnalysis, getLatestAnalysis, getAnalysisById, listAnalyses, saveReview } from './modules/requirements/repository'
export { saveExecution, getLatestExecution, getExecutionById, listExecutions } from './modules/executions/repository'
export { saveAutomationPlan, getLatestAutomationPlan, getAutomationPlanById } from './modules/cases/plan-repository'
export { saveEnvironment, setEnvironmentStorageState, getEnvironmentById, getLatestEnvironment } from './modules/projects/environment-repository'
