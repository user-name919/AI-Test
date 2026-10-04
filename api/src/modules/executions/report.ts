import type { ExecutionRecord } from '@quality-ai/contracts'
import type { ExecutionArtifact } from '@quality-ai/contracts/cases'

const labels={passed:'通过',failed:'验证失败',blocked:'受阻',infrastructure_failed:'环境或执行器中断',cancelled:'已取消',not_run:'未执行'}
const worktreeLabels={clean:'未发现 Git 跟踪或未跟踪改动',dirty:'存在本地未提交或未跟踪改动，SHA 不能代表全部读取内容',unknown:'无法确认工作区状态'}
const text=(value:unknown)=>String(value??'未记录').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/([\\`*_{}[\]#|])/g,'\\$1').replace(/\r?\n/g,' / ')

export function executionMarkdown(execution:ExecutionRecord,artifacts:ExecutionArtifact[]):string{
  const results=execution.caseResults??[]
  const selected=execution.caseSnapshots?.length??results.length
  const passed=results.filter(item=>item.status==='passed').length
  const verified=results.filter(item=>item.status==='passed'||item.status==='failed').length
  const lines=[`# ${text(execution.name)} · 执行报告`,'',`- 执行 ID：${text(execution.id)}`,`- 批次状态：${labels[execution.status]}`,`- 测试地址：${text(execution.targetUrl)}`,`- 执行模式：${execution.mode==='agent'?'动态 Agent':execution.mode==='plan'?'固定计划':'历史未记录'}`,execution.interruptionRecovery?`- 实际起止与耗时：未知；中断恢复记录时间：${text(execution.interruptionRecovery.recoveredAt)}`:`- 开始：${text(execution.startedAt)}；结束：${text(execution.finishedAt)}；耗时 ${execution.durationMs} ms`,'', '本报告来自当次保存的契约和运行事实，不重新调用模型评判。失败不直接等同于产品缺陷，需结合证据定位。','']
  if(execution.rerunOf)lines.push(`重跑来源：${text(execution.rerunOf)}（独立记录，未覆盖原执行）`,'')
  if(execution.sourceProject)lines.push(`源码参考：${text(execution.sourceProject.id)} / 分支 ${text(execution.sourceProject.branch)} / SHA ${text(execution.sourceProject.commit)}`,'源码版本不是测试环境部署版本证明。','')
  else lines.push('源码参考：本次未记录。','')
  if(execution.sourceProject){
    const state=execution.sourceProject.worktree
    lines.push(`工作区检查：${state?worktreeLabels[state.status]:'历史未记录，不推断为干净'}；时间：${text(state?.observedAt)}`,'此状态不包括 Git 忽略文件，也不是内容冻结或部署版本证明。','')
  }
  if(execution.deploymentConfirmation){
    const confirmation=execution.deploymentConfirmation
    lines.push('## 回归版本对应','',`回归任务：${text(confirmation.regressionId)}；ChangeSet：${text(confirmation.changeSetId)}；人工审核 v${confirmation.reviewRevision}`,
      `目标 SHA：${text(confirmation.targetSha)}；人工登记部署 SHA：${text(confirmation.deployedSha)}`,
      `对应状态：${confirmation.status==='matched'?'人工登记匹配':confirmation.status==='unverified'?'未核实，不得作为版本匹配证明':'不匹配'}`,
      `确认人：${text(confirmation.confirmedBy)}；时间：${text(confirmation.createdAt)}；依据：${text(confirmation.note)}`,
      '这是人工登记，不是平台自动探测证明；失败与变更相关联，不代表已确定由某个提交引入。','')
  }
  if(execution.error)lines.push(`批次说明：${text(execution.error)}`,'')
  if(execution.memoryHints?.length){
    lines.push('## 本次提供给模型的历史经验','', '仅为参考，不替代当前 DOM 或改变原断言；以下为当次冻结版本，后续审核不覆盖。')
    for(const hint of execution.memoryHints)lines.push(`- ${text(hint.id)} / v${hint.revision}：${text(hint.lesson)}；来源执行 ${text(hint.executionId)}；源码 ${text(hint.sourceCommit)}`)
    lines.push('')
  }
  if(!execution.caseResults)lines.push('历史记录未采集逐用例结果；不能用步骤成功数推算用例通过率。','')
  else{
    lines.push('## 结果概览','',`通过 / 选中总数：${passed} / ${selected}`,`已完成验证通过率：${verified?`${Math.round(passed/verified*100)}%`:'暂无'}（分母只计通过和验证失败，共 ${verified} 条）`)
    for(const [status,label] of Object.entries(labels))lines.push(`- ${label}：${results.filter(item=>item.status===status).length}`)
    if(selected!==results.length)lines.push(`- 记录不完整：选择 ${selected} 条，结果 ${results.length} 条；缺失项不推断为通过或未执行。`)
    lines.push('')
  }
  for(const [index,item] of results.entries()){
    const snapshot=execution.caseSnapshots?.find(candidate=>candidate.resolved.caseKey===item.caseKey)
    lines.push(`## ${index+1}. ${text(item.title)} · ${labels[item.status]}`,'',`用例标识：${text(item.caseKey)}`,`执行指纹：${text(item.contractFingerprint)}`)
    if(snapshot){
      lines.push(`冻结版本：${snapshot.revision}；采集时间：${text(snapshot.capturedAt)}`)
      if(snapshot.resolved.contractFingerprint!==item.contractFingerprint)lines.push('警告：执行指纹与契约快照不一致，不能认为使用了同一口径。')
      if(snapshot.source?.type==='case_design')lines.push(`设计来源：${text(snapshot.source.designId)}；发布 v${snapshot.source.publicationVersion} / ${text(snapshot.source.publicationId)}`)
      if(snapshot.source?.type==='requirement')lines.push(`需求来源：${text(snapshot.source.analysisId)} / ${text(snapshot.source.caseKey)}`)
      if(snapshot.source?.type==='change_regression')lines.push(`变更回归来源：${text(snapshot.source.regressionId)} / ${text(snapshot.source.suggestionId)}`)
      if(snapshot.source?.type==='change_regression'&&snapshot.source.reusedFrom){
        const source=snapshot.source.reusedFrom
        lines.push(`复用来源：${text(source.title)} / ${text(source.caseId)} / v${source.revision}；${text(source.sourceType)} / ${text(source.sourceId)}；来源指纹 ${text(source.contractFingerprint)}`,
          `人工适用理由：${text(source.reason)}；来源版本已冻结，本次使用人工最终口径，不追读来源最新内容。`)
      }
      lines.push('','### 当时确认的测试口径','',`目标：${text(snapshot.resolved.contract.objective)}`)
      for(const [key,label] of [['preconditions','前置条件'],['steps','计划操作'],['expectedAssertions','预期断言'],['forbiddenBehaviors','禁止行为'],['uncertainties','未确定事项']] as const){
        lines.push(`- ${label}：`)
        for(const value of snapshot.resolved.contract[key])lines.push(`  - ${text(value)}`)
        if(!snapshot.resolved.contract[key].length)lines.push('  - 无')
      }
      for(const question of snapshot.resolved.resolvedQuestions)lines.push(`- 关联人工决定：${text(question.questionTitle)} → ${text(question.finalStatement)}`)
    }else lines.push('未保存该用例的契约快照，不从当前编辑记录补写。')
    lines.push('','### 实际数据与结果','',`- 起始页面：${item.startedFromUrl?text(item.startedFromUrl):'未开始/未记录'}`,`- 起始 DOM 快照：${text(item.startedFromSnapshotId)}`,`- 结果说明：${text(item.error??labels[item.status])}`)
    for(const binding of item.resolvedDataBindings)lines.push(`- 数据 ${text(binding.bindingId)}：输入「${text(binding.value)}」，来源 option「${text(binding.sourceText)}」；DOM ${text(binding.snapshotId)} / ${text(binding.sourceElementRef)}；观察时间 ${text(binding.observedAt)}；选择理由：${text(binding.reason)}`)
    if(!item.resolvedDataBindings.length)lines.push('- 本条未记录运行时数据绑定；不代表已验证数据来源。')
    for(const fixture of item.usedFixtures??[])lines.push(`- 尝试上传附件：${text(fixture.name)} · ${fixture.size} 字节 · 附件 ID ${text(fixture.id)} · SHA256 ${text(fixture.sha256)}。这是当时使用的附件快照，不证明上传或业务处理成功。`)
    for(const download of item.downloads??[])lines.push(`- 实际下载 ${text(download.downloadId)}：${text(download.name)} · ${download.size} 字节 · SHA256 ${text(download.sha256)}。文件接收完成不等于业务内容断言通过。`)
    lines.push(`- 已通过断言 ID：${item.passedAssertions.length?item.passedAssertions.map(text).join('、'):'无'}`,'','### 操作与观察记录','')
    for(const turn of item.trajectory){
      const decision=turn.decision
      const purpose=decision.type==='finish'?decision.summary:decision.reason
      lines.push(`- 第 ${turn.iteration} 轮 · ${text(decision.type)}：${text(purpose)}；DOM ${text(turn.snapshotId)}`)
      const frame = turn.observation?.frameContext?.frames.find(frame=>frame.active)
      const activePage = turn.observation?.pageContext?.pages.find(page=>page.active)
      if(activePage)lines.push(`  - 当前标签页：${text(activePage.url)} / 页面标识 ${text(activePage.ref)}。页面列表${turn.observation?.pageContext?.truncated?'不完整':'未截断'}；切页后需使用新DOM证据。`)
      if(turn.sourceProject){
        const source=turn.sourceProject
        lines.push(`  - 读取前源码：${text(source.id)} / ${text(source.branch)} / ${text(source.commit)}；${source.worktree?worktreeLabels[source.worktree.status]:'工作区历史未记录'}；检查时间 ${text(source.worktree?.observedAt)}`)
      }
      if(frame)lines.push(`  - 观察框架：${frame.main?'主页面':'嵌入页面'} / ${text(frame.name||'未命名')} / ${text(frame.ref)} / ${text(turn.observation?.url)}`)
      const scope=turn.observation?.observationScope
      if(scope)lines.push(`  - 局部观察：来自快照 ${text(scope.sourceSnapshotId)} 的区域 ${text(scope.sourceElementRef)}。未包含区域外元素，不代表整页或全部业务数据；不改变断言自身的作用范围。`)
      if(decision.type==='action')lines.push(`  - 技术动作：${text(JSON.stringify(decision.action))}`)
      if(turn.result)lines.push(`  - 实际结果：${turn.result.ok?'操作/断言成功':'操作/断言失败'} · ${text(turn.result.message)} · ${turn.result.durationMs} ms`)
      if(turn.recovery)lines.push(`  - 技术恢复 ${turn.recovery.attempt}/${turn.recovery.limit}：${{reobserved:'重新观察页面后交由模型决策，未盲目重放动作',exhausted:'恢复预算耗尽',observation_failed:'恢复时重新观察页面失败'}[turn.recovery.status]}；原因：${text(turn.recovery.reason)}`)
    }
    if(!item.trajectory.length)for(const step of item.steps)lines.push(`- 步骤 ${step.index+1}：${text(step.action)} · ${step.status==='passed'?'成功':'失败'} · ${step.durationMs} ms${step.error?` · ${text(step.error)}`:''}`)
    if(!item.trajectory.length&&!item.steps.length)lines.push('- 没有操作证据。')
    lines.push('','### 附件','')
    const attachments=artifacts.filter(artifact=>artifact.caseKey===item.caseKey)
    for(const artifact of attachments)lines.push(artifact.available?`- [${text(artifact.name)}](${artifact.url})`:`- ${text(artifact.name)}：已清理或不可访问`)
    if(!attachments.length)lines.push('- 本条未登记附件。')
    lines.push('')
  }
  lines.push('## 查看与判读说明','','附件链接相对于本平台地址；离线阅读时需回平台打开。Trace 请下载后在本地使用 Playwright show-trace 查看。','恢复操作如有发生，按原始轨迹展示；未单独记录恢复尝试时，本报告不推断曾重试或已自愈。','取消不会回滚已提交业务操作；未执行没有通过证据。')
  return lines.join('\n')+'\n'
}
