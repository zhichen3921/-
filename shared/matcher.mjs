import { resumeProfile } from './resume-profile.mjs';

const DEFAULT_PREFERENCES = Object.freeze({
  queueThreshold: 75,
  reviewThreshold: 60,
  primaryDirections: [
    'agent',
    'llm-workflow',
    'machine-learning',
    'data-analysis',
    'ai-product',
    'electronics-ai'
  ],
  stretchDirections: ['llm-training', 'computer-vision', 'speech'],
  stretchEnabled: true,
  graduationYears: ['2028'],
  locations: ['深圳', '远程']
});

const DIRECTION_PATTERNS = Object.freeze({
  agent: /\bagent\b|智能体|多智能体|mcp\b/i,
  'llm-workflow': /大模型|llm|prompt|工作流|workflow|openai|claude|codex/i,
  'machine-learning': /机器学习|machine learning|算法建模|xgboost|lightgbm|回归模型/i,
  'data-analysis': /数据分析|数据处理|数据清洗|特征工程|数据科学|sql/i,
  'ai-product': /ai\s*产品|人工智能产品|产品实习|产品经理/i,
  'electronics-ai': /电子信息|传感器|半导体|stm32|硬件|端侧\s*ai|嵌入式/i,
  'llm-training': /预训练|微调|sft\b|rlhf|模型训练|蒸馏/i,
  'computer-vision': /计算机视觉|computer vision|\bcv\b|图像|视觉多模态/i,
  speech: /语音识别|语音算法|speech|asr\b/i
});

const MISSING_TECHNOLOGY_PATTERNS = Object.freeze([
  ['PyTorch', /pytorch/i],
  ['TensorFlow', /tensorflow/i],
  ['SQL', /\bsql\b/i],
  ['Java', /\bjava\b/i],
  ['TypeScript', /typescript/i],
  ['Go', /\bgolang\b|\bgo\s*(?:语言|开发)/i],
  ['C++', /c\+\+/i]
]);

const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));
const unique = (values) => [...new Set(values)];

function preferencesWithDefaults(preferences = {}) {
  return {
    ...DEFAULT_PREFERENCES,
    ...preferences,
    primaryDirections: Array.isArray(preferences.primaryDirections)
      ? preferences.primaryDirections
      : DEFAULT_PREFERENCES.primaryDirections,
    stretchDirections: Array.isArray(preferences.stretchDirections)
      ? preferences.stretchDirections
      : DEFAULT_PREFERENCES.stretchDirections,
    graduationYears: Array.isArray(preferences.graduationYears) && preferences.graduationYears.length
      ? preferences.graduationYears.map(String)
      : DEFAULT_PREFERENCES.graduationYears,
    locations: Array.isArray(preferences.locations) && preferences.locations.length
      ? preferences.locations.map(String)
      : DEFAULT_PREFERENCES.locations
  };
}

function textFor(job) {
  return [
    job.title,
    job.company,
    job.location,
    job.description,
    Array.isArray(job.directions) ? job.directions.join(' ') : ''
  ].filter(Boolean).join(' ').toLowerCase();
}

function detectDirections(text, declaredDirections = []) {
  const found = new Set(Array.isArray(declaredDirections) ? declaredDirections : []);
  for (const [direction, pattern] of Object.entries(DIRECTION_PATTERNS)) {
    if (pattern.test(text)) found.add(direction);
  }
  return [...found];
}

function restrictedGraduationYears(text) {
  const years = new Set();
  for (const match of text.matchAll(/20(2[0-9])(?:\s*年)?(?:\s*届)?/g)) {
    const prefix = text.slice(Math.max(0, match.index - 24), match.index);
    const suffix = text.slice(match.index + match[0].length, match.index + match[0].length + 20);
    const historicalReference = /(?:曾经?|此前|过去|历史上?|往届|上一届|去年)[^，。；\n]{0,20}$/i.test(prefix);
    if (historicalReference) continue;
    const restrictionBefore = /(?:仅限|面向|要求|招聘|毕业于|招收|接受|限招)[^，。；\n]{0,16}$/i.test(prefix);
    const restrictionAfter = /^[^，。；\n]{0,10}(?:可投|可申请|限投|限制|限定|招聘对象|毕业生招聘)/i.test(suffix);
    if (restrictionBefore || restrictionAfter) years.add(`20${match[1]}`);
  }
  return [...years];
}

function locationMatches(location, text, configuredLocations) {
  const remoteMentioned = /远程|remote|居家办公/i.test(text);
  const remoteNegated = /(?:不支持|不接受|不允许|不可|不能|无法|禁止|无|拒绝)\s*(?:远程|remote)|仅限线下|必须到岗|全程线下/i.test(text);
  const remote = remoteMentioned && !remoteNegated;
  const concreteLocations = configuredLocations.filter((item) => !/远程|remote/i.test(item));
  const normalizedLocation = String(location || '').toLowerCase();
  const ambiguous = /^(?:全国|多地|待定|未定|线上线下)$/i.test(normalizedLocation.trim());
  return {
    remote,
    ambiguous,
    matched: concreteLocations.some((item) => normalizedLocation.includes(item.toLowerCase()))
      || (remote && configuredLocations.some((item) => /远程|remote/i.test(item)))
  };
}

function mandatoryCredentialGaps(text) {
  const gaps = [];
  const segments = text.split(/[。；;\n]+/).map((segment) => segment.trim()).filter(Boolean);
  const optionalOrNegated = /无需|无须|不需要|不要求|不强制|不是必须|非必须|可选|优先|加分|有则|更佳|最好/i;
  const mandatoryContext = /必须|硬性要求|要求|须具备|须持有|须提供|需具备|需持有|需提供|仅限/i;

  for (const segment of segments) {
    if (optionalOrNegated.test(segment) || !mandatoryContext.test(segment)) continue;

    if (/英语六级|cet[-\s]?6/i.test(segment)) {
      gaps.push('岗位硬性要求英语六级，但简历未提供该资质');
    }
    if (/博士/i.test(segment)) {
      gaps.push('岗位硬性要求博士学历');
    }
    for (const match of segment.matchAll(/([^，,]{1,24}(?:资格证|证书|认证))/gi)) {
      const credential = match[1]
        .replace(/^.*?(?:必须|硬性要求|要求|须具备|须持有|须提供|需具备|需持有|需提供|仅限)/i, '')
        .trim();
      if (credential && !/英语六级|cet[-\s]?6/i.test(credential)) {
        gaps.push(`岗位硬性要求资质：${credential}`);
      }
    }
  }
  return gaps;
}

function mandatoryExperienceGap(text) {
  const match = text.match(/(?:要求|必须|至少|具备)?\s*([3-9])\s*年(?:以上|\+)?(?:相关|全职|工作|开发|项目)?经验/i);
  return match ? `岗位硬性要求 ${match[1]} 年以上经验` : '';
}

export function routeMatch(score, preferences = {}) {
  const queueThreshold = Number.isFinite(Number(preferences.queueThreshold))
    ? Number(preferences.queueThreshold)
    : DEFAULT_PREFERENCES.queueThreshold;
  const reviewThreshold = Number.isFinite(Number(preferences.reviewThreshold))
    ? Number(preferences.reviewThreshold)
    : DEFAULT_PREFERENCES.reviewThreshold;
  const numericScore = Number(score);
  if (!Number.isFinite(numericScore)) return 'excluded';
  if (numericScore >= queueThreshold) return 'queue';
  if (numericScore >= reviewThreshold) return 'review';
  return 'excluded';
}

export function scoreJob(job, preferences = {}) {
  if (!job || typeof job !== 'object') throw new TypeError('岗位数据必须是对象');

  const prefs = preferencesWithDefaults(preferences);
  const text = textFor(job);
  const description = String(job.description || '').trim();
  const reasons = [];
  const gaps = [];
  let score = 20;
  let hardMismatch = false;
  const isInternship = /实习|intern/i.test(text);
  const isAiRelevant = /人工智能|\bai\b|算法|机器学习|深度学习|大模型|\bllm\b|数据分析|数据科学|智能体|\bagent\b/i.test(text);

  if (isInternship) {
    score += 12;
    reasons.push('实习属性匹配');
  } else {
    score -= 4;
    gaps.push('岗位未明确说明实习属性');
  }

  const location = locationMatches(job.location, text, prefs.locations);
  let locationNeedsReview = false;
  if (location.matched) {
    score += 12;
    reasons.push(location.remote ? '支持远程实习' : '地点符合求职偏好');
  } else if (location.ambiguous) {
    score -= 4;
    locationNeedsReview = true;
    gaps.push('工作地点信息不明确');
  } else if (String(job.location || '').trim()) {
    score -= 35;
    hardMismatch = true;
    gaps.push('工作地点不在已配置范围且未说明支持远程');
  } else {
    score -= 4;
    locationNeedsReview = true;
    gaps.push('工作地点信息不足');
  }

  if (isAiRelevant) {
    score += 14;
    reasons.push('AI 方向匹配');
  } else {
    score -= 10;
    gaps.push('AI 方向不明确');
  }

  const directions = detectDirections(text, job.directions);
  const primaryMatches = directions.filter((direction) => prefs.primaryDirections.includes(direction));
  const stretchMatches = directions.filter((direction) => prefs.stretchDirections.includes(direction));
  if (primaryMatches.length) {
    score += 8;
    reasons.push('命中优先求职方向');
  } else if (stretchMatches.length && prefs.stretchEnabled) {
    score += 3;
    reasons.push('命中冲刺方向');
  } else if (stretchMatches.length) {
    score -= 6;
    gaps.push('岗位属于未启用的冲刺方向');
  }

  const matchedSkills = resumeProfile.skills
    .filter((item) => item.terms.some((term) => text.includes(term.toLowerCase())))
    .map((item) => item.label);
  score += Math.min(25, matchedSkills.length * 5);
  if (matchedSkills.length) {
    reasons.push(`命中技能：${matchedSkills.slice(0, 4).join('、')}`);
  } else {
    gaps.push('未从岗位信息中识别出简历技能匹配');
  }

  const requiredYears = restrictedGraduationYears(text);
  const declaredYears = Array.isArray(job.graduationYears)
    ? job.graduationYears.map(String)
    : [];
  const graduationYears = unique([...requiredYears, ...declaredYears]);
  if (graduationYears.length) {
    if (graduationYears.some((year) => prefs.graduationYears.includes(year))) {
      score += 12;
      reasons.push('毕业年份匹配');
    } else {
      score -= 45;
      hardMismatch = true;
      gaps.push(`毕业年份限制不接受 ${resumeProfile.graduationYear} 届`);
    }
  } else {
    gaps.push('未明确是否接受 2028 届');
  }

  if (/硕士|研究生|在校生/i.test(text)) {
    score += 5;
    reasons.push('学历阶段匹配');
  }

  const credentialGaps = mandatoryCredentialGaps(text);
  if (credentialGaps.length) {
    score -= 45;
    hardMismatch = true;
    gaps.push(...credentialGaps);
  }

  const experienceGap = mandatoryExperienceGap(text);
  if (experienceGap) {
    score -= 40;
    hardMismatch = true;
    gaps.push(experienceGap);
  }

  const missingTechnologies = MISSING_TECHNOLOGY_PATTERNS
    .filter(([, pattern]) => pattern.test(text))
    .map(([label]) => label)
    .filter((label) => !resumeProfile.skills.some((item) => item.label.toLowerCase() === label.toLowerCase()));
  if (missingTechnologies.length) {
    score -= Math.min(15, missingTechnologies.length * 5);
    gaps.push(`简历未体现：${missingTechnologies.join('、')}`);
  }

  const descriptionMissing = description.length < 25;
  if (descriptionMissing) {
    gaps.push('岗位要求信息不足');
  } else {
    score += 5;
  }

  score = clamp(Math.round(score), 0, 100);
  const informationNeedsReview = descriptionMissing || locationNeedsReview;
  if (informationNeedsReview && !hardMismatch && isInternship && isAiRelevant) {
    const reviewThreshold = Number(prefs.reviewThreshold);
    const queueThreshold = Number(prefs.queueThreshold);
    const reviewCeiling = Math.max(reviewThreshold, queueThreshold - 1);
    score = clamp(Math.max(score, reviewThreshold), reviewThreshold, reviewCeiling);
  } else if (descriptionMissing && !hardMismatch) {
    const queueThreshold = Number(prefs.queueThreshold);
    score = Math.min(score, queueThreshold - 1);
  }

  const route = hardMismatch ? 'excluded' : routeMatch(score, prefs);
  const recommendation = route === 'queue'
    ? '优先沟通'
    : route === 'review' ? '待复核' : '不建议加入';

  return {
    score,
    route,
    recommendation,
    reasons: unique(reasons),
    gaps: unique(gaps),
    matchedSkills: unique(matchedSkills),
    hardMismatch
  };
}
