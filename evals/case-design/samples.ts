// Expectations are review candidates, not human-approved gold labels.
const definitions=[
  ['full-search','完整搜索','选择考试支持完整名称搜索，命中项高亮。名称取自当前账号实际选项。','完整名称与来源项一致；匹配高亮','不得把文档示例当作账号数据','同名结果可多条'],
  ['partial-search','部分搜索','选择考试按部分关键词过滤并高亮匹配文字。','非空严格子串；来源选项仍存在','不得用完整名称冒充部分词','可选择不同实际选项和子串'],
  ['no-match','无匹配','搜索无匹配时显示暂无数据。候选来自服务端分页搜索。','明确负例准备条件；分页不能证明全局不存在','不得称当前可见列表就是完整数据','可以提出受控夹具或标记待准备'],
  ['pagination','表格分页','每页20条，切换筛选重置为第一页。','第一页末页；筛选后页码重置','不得发明总条数与账号记录','测试数据可运行时选择'],
  ['validation','表单校验','姓名必填，最多20个字符；保存失败保留输入。','空值；20与21字符；失败后输入保留','不得自行定义空白字符归一化','空白字符可列待确认'],
  ['permission','角色权限','管理员可删除记录，普通用户不可删除。后端也必须校验权限。','两角色；接口越权；浏览器能力边界','不可用按钮隐藏证明后端拒绝','接口项可独立标为API验证'],
  ['date-boundary','日期边界','开始日期不能晚于结束日期，同一天允许。','早于等于晚于；跨月','不得发明时区或未来日期限制','时区未定义可提问'],
  ['upload','上传限制','仅支持PDF，单文件大小不超过10MB。上传失败可以重试。','类型；大小边界；重试','不得自定义MB换算与重试次数','大小单位可待确认'],
  ['async-download','异步下载','点击生成后异步计算报告，完成后允许下载，失败可以重试。','进行中；成功；失败与重试','不得发明轮询接口、频率和超时','完成通知机制可提问'],
  ['state','状态流转','草稿可提交审批，待审批可通过或驳回；通过后不允许编辑。','每条转换；通过后编辑限制','不得发明撤回或审批角色','可分别设计转换用例'],
  ['conflict','多文档冲突','主需求：搜索区分大小写。','保留双方依据并提出冲突','不得按文档顺序决定规则','等待人工明确最终口径'],
  ['missing','缺失信息','支持批量导出所选记录。示例名称模考数学一，仅作说明。','选择范围；缺失格式和上限待确认','不得编造导出格式、数量上限或账号存在示例名称','允许部分场景待确认'],
] as const
export const samples=definitions.map(([id,title,content,mustCover,forbidden,alternatives])=>({
  id,title,documents:[{fileName:`${id}.md`,role:'prd' as const,content},...(id==='conflict'?[{fileName:'supplement.md',role:'interface' as const,content:'技术方案：搜索不区分大小写。'}]:[])],
  expectations:{explicitFacts:content,mustCover,forbidden,alternatives,humanReview:'pending' as const},
}))
export default function tests(){return samples.map(sample=>({description:`${sample.id} · ${sample.title} · 答案待人工审核`,vars:{payload:JSON.stringify({sampleId:sample.id,documents:sample.documents})},metadata:{expectations:sample.expectations}}))}
