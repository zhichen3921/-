(() => {
  const CATEGORY_RULES = Object.freeze([
    { key: 'product', pattern: /产品|prd|需求分析|竞品|用户研究|产品运营/i },
    { key: 'data', pattern: /数据分析|数据科学|数据标注|数据处理|统计|报表|指标/i },
    { key: 'hardware', pattern: /硬件|嵌入式|传感器|单片机|stm32|电子信息|半导体/i },
    { key: 'content', pattern: /内容|视频|剪辑|文案|新媒体|运营|社媒|营销/i },
    { key: 'algorithm', pattern: /算法|模型|机器学习|深度学习|大模型|llm|nlp|视觉|agent|智能体|推荐|AI工作流|AI开发/i }
  ]);

  const TEMPLATES = Object.freeze({
    product: [
      ({ identity, role, evidence, skills }) => `您好，我是${identity}，对${role}很感兴趣。我做过${evidence}${skills ? `，也有${skills}相关实践` : ''}，想了解一下团队目前的实习安排。谢谢！`,
      ({ identity, role, evidence, skills }) => `您好，我想申请${role}。我的项目经历主要是${evidence}${skills ? `，其中${skills}和岗位方向比较贴合` : ''}。如果岗位还在招聘，希望有机会和您聊聊。`,
      ({ identity, role, evidence, skills }) => `您好，我是${identity}。看到${role}后觉得方向比较合适，我有${evidence}${skills ? `，也接触过${skills}` : ''}，方便的话想进一步了解岗位和团队。`,
      ({ identity, role, evidence, skills }) => `您好，想和您沟通一下${role}。我的项目经历包括${evidence}${skills ? `，对${skills}方向也比较熟悉` : ''}，希望有机会参与团队的实际项目。谢谢！`
    ],
    data: [
      ({ identity, role, evidence, skills }) => `您好，我是${identity}，想申请${role}。我做过${evidence}${skills ? `，岗位提到的${skills}也有实践` : ''}，想了解一下团队主要负责哪些数据和业务场景。`,
      ({ identity, role, evidence, skills }) => `您好，我对${role}很感兴趣。我的经历集中在${evidence}${skills ? `，和${skills}方向比较匹配` : ''}。请问目前还在招聘吗？`,
      ({ identity, role, evidence, skills }) => `您好，我是${identity}。看到${role}后想来了解一下，我有${evidence}${skills ? `，也用过${skills}` : ''}，希望有机会参与真实业务的数据工作。谢谢！`,
      ({ identity, role, evidence, skills }) => `您好，想请教一下${role}的实习安排。我做过${evidence}${skills ? `，对${skills}相关任务比较感兴趣` : ''}，如果岗位还在招，期待和您进一步沟通。`
    ],
    hardware: [
      ({ identity, role, evidence, skills }) => `您好，我是${identity}，对${role}很感兴趣。我有${evidence}${skills ? `，也接触过${skills}` : ''}，想了解一下岗位更偏硬件开发还是数据与算法应用。`,
      ({ identity, role, evidence, skills }) => `您好，我想申请${role}。我做过${evidence}${skills ? `，其中${skills}和岗位要求比较贴合` : ''}，希望有机会参与团队的实际项目。谢谢！`,
      ({ identity, role, evidence, skills }) => `您好，看到${role}后想和您沟通一下。我做过${evidence}${skills ? `，对${skills}方向也有兴趣` : ''}，请问目前还在招聘吗？`,
      ({ identity, role, evidence, skills }) => `您好，我是${identity}。${role}的方向和我的经历有一定交集：${evidence}${skills ? `，也具备${skills}相关基础` : ''}。方便的话想进一步了解岗位。`
    ],
    content: [
      ({ identity, role, evidence, skills }) => `您好，我是${identity}，对${role}很感兴趣。我做过${evidence}${skills ? `，也关注${skills}在内容和业务中的应用` : ''}，想了解一下团队目前的实习安排。`,
      ({ identity, role, evidence, skills }) => `您好，我想申请${role}。我有${evidence}${skills ? `，对${skills}方向也比较感兴趣` : ''}，希望有机会参与具体项目并持续学习。谢谢！`,
      ({ identity, role, evidence, skills }) => `您好，看到${role}后觉得方向很合适。我的项目经历包括${evidence}${skills ? `，也在关注${skills}相关实践` : ''}，请问岗位还在招聘吗？`,
      ({ identity, role, evidence, skills }) => `您好，我是${identity}。想和您了解一下${role}，我的经历包括${evidence}${skills ? `，和${skills}有一定关联` : ''}。如果方便，期待进一步沟通。`
    ],
    algorithm: [
      ({ identity, role, evidence, skills }) => `您好，我是${identity}，想了解贵司的${role}。我做过${evidence}${skills ? `，岗位涉及的${skills}和我的经历比较贴近` : ''}，请问目前还在招聘吗？`,
      ({ identity, role, evidence, skills }) => `您好，我对${role}很感兴趣。我的项目经历是${evidence}${skills ? `，也有${skills}相关实践` : ''}，希望有机会和您聊聊团队的技术方向。`,
      ({ identity, role, evidence, skills }) => `您好，看到${role}后想和您沟通一下。我的项目经历包括${evidence}${skills ? `，对${skills}方向有实际接触` : ''}，如果岗位还在招，期待进一步了解。谢谢！`,
      ({ identity, role, evidence, skills }) => `您好，我是${identity}。${role}和我的经历比较匹配：${evidence}${skills ? `，其中${skills}是我比较熟悉的方向` : ''}。方便的话想请教一下岗位安排。`
    ],
    engineering: [
      ({ identity, role, evidence, skills }) => `您好，我是${identity}，想申请${role}。我有${evidence}${skills ? `，也具备${skills}相关实践` : ''}，和岗位的开发方向比较匹配。请问目前还在招聘吗？`,
      ({ identity, role, evidence, skills }) => `您好，对${role}很感兴趣。我做过${evidence}${skills ? `，岗位提到的${skills}也有接触` : ''}，希望有机会参与团队的实际开发。谢谢！`,
      ({ identity, role, evidence, skills }) => `您好，我想了解一下${role}。我的经历主要是${evidence}${skills ? `，对${skills}方向比较熟悉` : ''}，如果岗位还在招，期待和您进一步沟通。`,
      ({ identity, role, evidence, skills }) => `您好，我是${identity}。看到${role}后觉得方向合适，我有${evidence}${skills ? `，也在持续积累${skills}相关经验` : ''}，方便的话想和您聊聊。`
    ]
  });

  function clean(value) {
    return String(value || '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function cleanEvidence(value) {
    const evidence = clean(value)
      .replace(/^相关项目实践$/i, '相关项目实践')
      .replace(/[。；;]+$/g, '');
    return evidence || '相关项目实践';
  }

  function validProfileValue(value) {
    const text = clean(value);
    return text && !/^your\s+(name|school|degree)/i.test(text) && !/^relevant project experience$/i.test(text);
  }

  function identityFor(profile = {}) {
    const name = validProfileValue(profile.name) ? clean(profile.name) : '';
    const school = validProfileValue(profile.school) ? clean(profile.school) : '';
    const degree = validProfileValue(profile.degree) ? clean(profile.degree) : '';
    if (school && degree && name) return `${school}${degree}的${name}`;
    if (degree && name) return `${degree}的${name}`;
    if (school && name) return `${school}的学生${name}`;
    if (name) return name;
    if (degree) return degree;
    return '一名求职者';
  }

  function stableHash(value) {
    let hash = 0;
    for (const char of String(value || '')) hash = (hash * 31 + char.codePointAt(0)) >>> 0;
    return hash;
  }

  function categoryFor(job) {
    const title = String(job?.title || '');
    const titleCategory = CATEGORY_RULES.find(({ pattern }) => pattern.test(title))?.key;
    if (titleCategory) return titleCategory;
    const text = `${title} ${job?.description || ''}`;
    return CATEGORY_RULES.find(({ pattern }) => pattern.test(text))?.key || 'engineering';
  }

  function formatSkills(job) {
    const raw = Array.isArray(job?.matchedSkills)
      ? job.matchedSkills
      : Array.isArray(job?.match?.matchedSkills) ? job.match.matchedSkills : [];
    const skills = [...new Set(raw.map(clean).filter(Boolean))].slice(0, 3);
    if (skills.length <= 1) return skills[0] || '';
    if (skills.length === 2) return skills.join('和');
    return skills.join('、');
  }

  function roleFor(job) {
    const title = clean(job?.title) || '这个岗位';
    const company = clean(job?.company);
    return company ? `「${company}·${title}」岗位` : `「${title}」岗位`;
  }

  function buildGreeting(job = {}, profile = {}, { variantOffset = 0 } = {}) {
    const category = categoryFor(job);
    const templates = TEMPLATES[category] || TEMPLATES.engineering;
    const key = `${job?.url || ''}|${job?.company || ''}|${job?.title || ''}`;
    const index = (stableHash(key) + Number(variantOffset || 0)) % templates.length;
    const skills = formatSkills(job);
    return templates[index]({
      identity: identityFor(profile),
      role: roleFor(job),
      evidence: cleanEvidence(profile.evidenceSummary || profile.evidence?.[0]),
      skills
    }).replace(/。+/g, '。').trim();
  }

  function isLegacyGreeting(value) {
    const text = clean(value);
    return text.includes('岗位方向与我的背景较匹配，希望进一步交流，谢谢！')
      || /关注到贵司的.+。.+，熟悉.+。/.test(text);
  }

  window.ApplicationDeskGreetings = { buildGreeting, isLegacyGreeting };
})();
