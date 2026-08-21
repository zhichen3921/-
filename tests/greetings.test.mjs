import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

const source = await readFile(new URL('../client/greetings.js', import.meta.url), 'utf8');
const context = { window: {} };
vm.runInNewContext(source, context);
const { buildGreeting, isLegacyGreeting } = context.window.ApplicationDeskGreetings;

const profile = {
  name: '陈志',
  school: '延安大学',
  degree: '电子信息硕士在读',
  evidenceSummary: '1500+ 样本的数据建模与特征分析，以及大模型 API 应用实践'
};

test('greetings vary by job category and stay natural', () => {
  const jobs = [
    { company: '甲公司', title: '算法实习生', description: '机器学习模型训练', matchedSkills: ['Python', '机器学习'] },
    { company: '乙公司', title: '产品经理实习生', description: '用户研究、PRD 和竞品分析', matchedSkills: ['大模型 API'] },
    { company: '丙公司', title: '数据分析实习生', description: '数据分析和业务报表', matchedSkills: ['数据处理'] },
    { company: '丁公司', title: '嵌入式实习生', description: '传感器和 STM32 开发', matchedSkills: ['电子信息'] }
  ];
  const greetings = jobs.map((job) => buildGreeting(job, profile));

  assert.equal(new Set(greetings).size, jobs.length);
  for (const [index, greeting] of greetings.entries()) {
    assert.match(greeting, new RegExp(jobs[index].company));
    assert.match(greeting, new RegExp(jobs[index].title));
    assert.doesNotMatch(greeting, /岗位方向与我的背景较匹配/);
    assert.doesNotMatch(greeting, /关注到贵司的[^。]+。/);
  }
});

test('legacy fixed-template greetings are detectable', () => {
  assert.equal(isLegacyGreeting('您好，我是陈志，关注到贵司的算法实习生。项目经历，熟悉 Python。岗位方向与我的背景较匹配，希望进一步交流，谢谢！'), true);
  assert.equal(isLegacyGreeting('您好，我是陈志。想申请「甲公司·算法实习生」岗位，方便的话想和您聊聊。'), false);
});

test('variant offset produces another stable sentence', () => {
  const job = {
    company: '甲公司',
    title: '算法实习生',
    url: 'https://example.com/job/1',
    description: '机器学习模型训练',
    matchedSkills: ['Python', '机器学习']
  };
  const first = buildGreeting(job, profile);
  const second = buildGreeting(job, profile, { variantOffset: 1 });
  assert.notEqual(first, second);
  assert.equal(first, buildGreeting(job, profile));
});
