import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { loadStageSkills } from './skill-loader'

test('stage mapping loads only relevant methods and returns reproducible content hashes',()=> {
  const facts=loadStageSkills('extracting')
  assert.deepEqual(facts.map(skill=>skill.id),['requirement-facts'])
  assert.match(facts[0].content,/模糊搜索/)
  assert.equal(facts[0].hash,loadStageSkills('extracting')[0].hash)
  assert.deepEqual(loadStageSkills('generating').map(skill=>skill.id),['test-data-design'])
  assert.deepEqual(loadStageSkills('checking').map(skill=>skill.id),['case-quality-review'])
  assert.deepEqual(loadStageSkills('extracting',false,'/nonexistent'),[])
})
test('skill resource symlinks cannot escape the selected skill directory',()=> {
  const directory=mkdtempSync(join(tmpdir(),'quality-ai-skills-'))
  try {
    const skill=join(directory,'requirement-facts')
    mkdirSync(join(skill,'references'),{recursive:true})
    writeFileSync(join(skill,'SKILL.md'),'# 合成测试技能')
    writeFileSync(join(directory,'outside.md'),'不应读取')
    symlinkSync(join(directory,'outside.md'),join(skill,'references/examples.md'))
    assert.throws(()=>loadStageSkills('extracting',true,directory),/技能引用必须/)
  } finally { rmSync(directory,{recursive:true,force:true}) }
})
