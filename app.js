const STORAGE_KEY = 'applicationDesk.v2';
const SHENZHEN_CODE = '101280600';
const DEMO_QUERY = new URLSearchParams(window.location.search);
const IS_DEMO_MODE = DEMO_QUERY.get('demo') === '1'
  || window.location.hostname.endsWith('.github.io');
const IS_FILE_MODE = window.location.protocol === 'file:' || IS_DEMO_MODE;
const FILE_BRIDGE_REQUESTED = window.location.protocol === 'file:'
  && new URLSearchParams(window.location.search).get('migration-bridge') === '1';
const PROFILE_STORAGE_KEY = 'applicationDesk.resumeProfile.v1';
const RESUME_SKILL_LIBRARY = [
  ['Python', ['python']],
  ['Java', ['java']],
  ['JavaScript', ['javascript', 'js']],
  ['TypeScript', ['typescript', 'ts']],
  ['SQL', ['sql', 'mysql', 'postgresql']],
  ['C++', ['c++', 'cpp']],
  ['机器学习', ['机器学习', 'machine learning', 'scikit-learn', 'sklearn']],
  ['深度学习', ['深度学习', 'deep learning', 'pytorch', 'tensorflow']],
  ['大模型 / LLM', ['大模型', 'llm', 'large language model', 'rag', 'prompt']],
  ['数据分析', ['数据分析', 'data analysis', 'pandas', 'numpy']],
  ['React', ['react']],
  ['Vue', ['vue']],
  ['Node.js', ['node.js', 'nodejs']],
  ['Docker', ['docker']],
  ['Git', ['git', 'github']]
];

function normalizeResumeProfile(input = {}) {
  const skills = Array.isArray(input.skills) ? input.skills : [];
  return {
    name: String(input.name || 'Your Name').trim().slice(0, 80),
    school: String(input.school || 'Your school').trim().slice(0, 120),
    degree: String(input.degree || 'Your degree / current status').trim().slice(0, 120),
    graduation: String(input.graduation || input.graduationYear || '2028').trim().slice(0, 20),
    evidenceSummary: String(input.evidenceSummary || input.evidence?.[0] || 'relevant project experience').trim().slice(0, 240),
    skills: skills.map((skill) => ({
      label: String(skill?.label || '').trim().slice(0, 40),
      terms: Array.isArray(skill?.terms) ? skill.terms.map(String).slice(0, 12) : []
    })).filter((skill) => skill.label && skill.terms.length)
  };
}

function loadResumeProfile() {
  if (IS_FILE_MODE) {
    try {
      const stored = JSON.parse(localStorage.getItem(PROFILE_STORAGE_KEY) || 'null');
      if (stored && typeof stored === 'object') return normalizeResumeProfile(stored);
    } catch (_) {}
  }
  return normalizeResumeProfile(window.APPLICATION_DESK_PROFILE || {});
}

let resume = loadResumeProfile();
const {
  availableFilterOptions,
  createEmptyFilters,
  filterJobs,
  renderFilterPanel
} = window.ApplicationDeskFilters;
const {
  DEFAULT_PREFERENCES,
  normalizePreferences,
  renderPreferences
} = window.ApplicationDeskPreferences;
const {
  renderExtensionCenter
} = window.ApplicationDeskExtensionCenter;
const {
  buildGreeting,
  isLegacyGreeting
} = window.ApplicationDeskGreetings;

const searches = [
  ['AI 实习生', 'AI实习生', '综合入口'],
  ['机器学习实习生', '机器学习实习生', '建模与算法'],
  ['大模型实习生', '大模型实习生', 'LLM 应用'],
  ['AI 应用开发', 'AI应用开发实习生', '工程落地'],
  ['数据分析实习生', '数据分析实习生', '数据与业务']
];

const statusLabels = { todo: '待沟通', contacted: '已沟通', replied: '已回复', skipped: '已跳过' };
let state = loadState();
let currentFilter = 'all';
let compoundFilters = createEmptyFilters();
let reviewCompoundFilters = createEmptyFilters();
let currentSection = 'radar';
let activeGreetingId = null;
let activeGreetingVariant = 0;
let apiClient = null;
let stateWriteQueue = Promise.resolve();
let extensionPairingToken = '';

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const escapeHtml = (value = '') => String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);

function loadState() {
  if (!IS_FILE_MODE) {
    return {
      jobs: [],
      curatedBatches: [],
      deletedKeys: [],
      preferences: normalizePreferences(DEFAULT_PREFERENCES)
    };
  }
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (parsed && Array.isArray(parsed.jobs)) {
      parsed.curatedBatches = Array.isArray(parsed.curatedBatches) ? parsed.curatedBatches : [];
      parsed.deletedKeys = Array.isArray(parsed.deletedKeys) ? parsed.deletedKeys : [];
      parsed.preferences = normalizePreferences(parsed.preferences || DEFAULT_PREFERENCES);
      return parsed;
    }
  } catch (_) {}
  return {
    jobs: [],
    curatedBatches: [],
    deletedKeys: [],
    preferences: normalizePreferences(DEFAULT_PREFERENCES)
  };
}

function saveState() {
  if (IS_FILE_MODE) {
    if (!FILE_BRIDGE_REQUESTED) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    }
    return { ok: true, mode: 'localStorage' };
  }
  return { ok: true, mode: 'server-granular' };
}

function enqueueServerWrite(operation, failureMessage = '保存到本地服务失败') {
  if (IS_FILE_MODE) return Promise.resolve(null);
  stateWriteQueue = stateWriteQueue.then(async () => {
    if (!apiClient) throw new Error('本地投递台 API 尚未就绪');
    return operation();
  }).catch((error) => {
    console.error(failureMessage, error);
    toast(`${failureMessage}：${error.message}`);
    return null;
  });
  return stateWriteQueue;
}

function upsertServerJob(job, previousId = '') {
  if (!job?.id) return;
  const index = state.jobs.findIndex((item) => item.id === job.id || (previousId && item.id === previousId));
  if (index === -1) state.jobs.push(job);
  else state.jobs[index] = job;
}

function normalizeServerState(input) {
  const serverState = input && typeof input === 'object' ? input : {};
  return {
    ...serverState,
    jobs: Array.isArray(serverState.jobs)
      ? serverState.jobs.map((job) => {
        if (!job || typeof job !== 'object') return job;
        if (!String(job.greeting || '').trim() || isLegacyGreeting(job.greeting)) {
          return { ...job, greeting: makeGreeting(job) };
        }
        return job;
      })
      : [],
    curatedBatches: Array.isArray(serverState.curatedBatches)
      ? serverState.curatedBatches
      : Array.isArray(serverState.importedBatchIds) ? serverState.importedBatchIds : [],
    deletedKeys: Array.isArray(serverState.deletedKeys) ? serverState.deletedKeys : [],
    preferences: normalizePreferences(serverState.preferences || DEFAULT_PREFERENCES)
  };
}

function parseFileBridgeLaunch() {
  if (!FILE_BRIDGE_REQUESTED) return null;
  const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  if (fragment.get('migrationBridge') !== '1') return null;

  const token = fragment.get('token') || '';
  let baseUrl;
  let returnUrl;
  try {
    baseUrl = new URL(fragment.get('baseUrl') || '');
    returnUrl = new URL(fragment.get('returnUrl') || '');
  } catch {
    return null;
  }
  if (
    !token ||
    baseUrl.protocol !== 'http:' ||
    baseUrl.hostname !== '127.0.0.1' ||
    returnUrl.protocol !== 'http:' ||
    returnUrl.hostname !== '127.0.0.1' ||
    baseUrl.origin !== returnUrl.origin
  ) return null;

  return {
    baseUrl: baseUrl.href.replace(/\/$/, ''),
    token,
    returnUrl: returnUrl.href
  };
}

function strictMigrationSuccess(response, total) {
  if (!response || response.ok !== true) return false;
  const fields = ['imported', 'merged', 'alreadyPresent', 'total'];
  if (!fields.every((field) => Number.isInteger(response[field]) && response[field] >= 0)) {
    return false;
  }
  return (
    response.total === total &&
    response.imported + response.merged + response.alreadyPresent === response.total
  );
}

async function runFileMigrationBridge() {
  const config = parseFileBridgeLaunch();
  if (!config) {
    console.warn('File migration bridge parameters are missing or invalid.');
    toast('迁移入口参数无效，旧数据未发生变化');
    return;
  }

  let legacy;
  try {
    legacy = JSON.parse(localStorage.getItem(STORAGE_KEY));
  } catch (error) {
    console.error('Legacy state is not valid JSON:', error);
    toast('旧版数据无法读取，未执行迁移');
    return;
  }
  if (!legacy || !Array.isArray(legacy.jobs)) {
    toast('没有找到可迁移的旧版岗位');
    return;
  }

  const curated = legacy.jobs.filter((job) => (
    job?.curatedBatchId || job?.source || job?.verifiedAt || job?.curationNote || job?.review
  )).length;
  const withGreeting = legacy.jobs.filter((job) => String(job?.greeting || '').trim()).length;
  const confirmed = window.confirm(
    `检测到旧版投递台的 ${legacy.jobs.length} 个岗位，`
    + `其中 ${curated} 个含公开核验信息、`
    + `${withGreeting} 个含保存话术。\n\n`
    + '是否复制到新版本地数据？旧版 localStorage 将保持不变。'
  );
  if (!confirmed) return;

  const payload = {
    sourceKey: STORAGE_KEY,
    jobs: JSON.parse(JSON.stringify(legacy.jobs)),
    curatedBatches: Array.isArray(legacy.curatedBatches)
      ? JSON.parse(JSON.stringify(legacy.curatedBatches))
      : [],
    deletedKeys: Array.isArray(legacy.deletedKeys)
      ? JSON.parse(JSON.stringify(legacy.deletedKeys))
      : []
  };

  try {
    const response = await fetch(`${config.baseUrl}/api/migrations/legacy`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'x-desk-token': config.token
      },
      body: JSON.stringify(payload)
    });
    const result = await response.json();
    if (!response.ok || !strictMigrationSuccess(result, payload.jobs.length)) {
      throw new Error(result?.error?.message || '服务端未确认全部岗位迁移完成');
    }
    window.location.replace(config.returnUrl);
  } catch (error) {
    console.error('File migration bridge failed:', error);
    toast(`迁移失败：${error.message}`);
  }
}

async function startLocalhostApplication() {
  try {
    const { createApiClient } = await import('./client/api.js');
    apiClient = createApiClient();
    state = normalizeServerState(await apiClient.getState());
    renderSearches();
    renderAll();
  } catch (error) {
    console.error('Failed to load server application state:', error);
    state = normalizeServerState({});
    renderSearches();
    renderAll();
    toast('无法读取本地服务数据，请确认投递台服务已启动');
  }
}

function searchUrl(query) {
  const url = new URL('https://www.zhipin.com/web/geek/job');
  url.searchParams.set('query', query);
  url.searchParams.set('city', SHENZHEN_CODE);
  return url.toString();
}

function analyzeJob(job) {
  const text = `${job.title} ${job.company} ${job.location} ${job.description}`.toLowerCase();
  const reasons = [];
  const matchedSkills = resume.skills.filter((skill) => skill.terms.some((term) => text.includes(term)));
  let score = 28;
  let hardMismatch = false;

  if (/实习|intern/.test(text)) { score += 16; reasons.push('实习属性匹配'); }
  else { score -= 5; reasons.push('未明确实习属性'); }

  if (/深圳|南山|福田|宝安|龙岗/.test(text)) { score += 12; reasons.push('深圳地点匹配'); }
  else if (job.location.trim()) { score -= 8; reasons.push('地点需要确认'); }

  if (/人工智能|\bai\b|算法|机器学习|深度学习|大模型|llm|数据分析|数据科学/.test(text)) {
    score += 16;
    reasons.push('AI 方向匹配');
  } else {
    score -= 8;
    reasons.push('AI 方向不够明确');
  }

  score += Math.min(24, matchedSkills.length * 4);
  if (matchedSkills.length) reasons.push(`命中 ${matchedSkills.slice(0, 3).map((skill) => skill.label).join(' / ')}`);

  if (/硕士|研究生|在校生/.test(text)) { score += 6; reasons.push('学历阶段匹配'); }
  if (/2028届|28届/.test(text)) { score += 10; reasons.push('毕业年份匹配'); }
  if (/2026届|2027届|26届|27届/.test(text) && !/2028届|28届/.test(text)) {
    score -= 28; hardMismatch = true; reasons.push('毕业年份可能不符');
  }
  if (/(3|4|5|6|7|8|9)\s*年(以上)?|三年以上|五年以上/.test(text)) {
    score -= 35; hardMismatch = true; reasons.push('全职经验要求过高');
  }
  if (/博士/.test(text) && /必须|要求|仅限/.test(text)) {
    score -= 30; hardMismatch = true; reasons.push('博士硬性要求');
  }

  const descriptionMissing = job.description.trim().length < 25;
  if (descriptionMissing) { score = Math.min(score, 59); reasons.push('岗位要求信息不足'); }
  score = clamp(Math.round(score), 0, 100);

  let verdict = 'bad';
  if (descriptionMissing || (!hardMismatch && score >= 45 && score < 66)) verdict = 'unknown';
  if (!hardMismatch && !descriptionMissing && score >= 66) verdict = 'good';

  return { score, verdict, reasons: [...new Set(reasons)].slice(0, 4), matchedSkills: matchedSkills.map((skill) => skill.label) };
}

function makeGreeting(job, variantOffset = 0) {
  return buildGreeting(job, resume, { variantOffset });
}

function renderProfile() {
  const profile = resume || {};
  const name = String(profile.name || 'Your Name');
  const graduation = String(profile.graduation || '2028');
  const skills = Array.isArray(profile.skills) ? profile.skills : [];
  $$('[data-profile-name]').forEach((node) => { node.textContent = name; });
  $$('[data-profile-school]').forEach((node) => { node.textContent = profile.school || 'Your school'; });
  $$('[data-profile-degree]').forEach((node) => { node.textContent = profile.degree || 'Your degree'; });
  $$('[data-profile-graduation]').forEach((node) => { node.textContent = graduation; });
  $$('[data-profile-initial]').forEach((node) => { node.textContent = [...name][0] || '?'; });
  $$('[data-profile-evidence]').forEach((node) => { node.textContent = profile.evidenceSummary || 'relevant project experience'; });
  $$('[data-profile-skills-summary]').forEach((node) => { node.textContent = skills.slice(0, 6).map((skill) => skill.label).join('、'); });
  const skillsCloud = $('#profile-skills');
  if (skillsCloud) skillsCloud.innerHTML = skills.map((skill) => `<span>${escapeHtml(skill.label)}</span>`).join('');
}

function profileFromResumeText(text) {
  const cleanText = String(text || '').replace(/\r/g, '').replace(/[ \t]+/g, ' ');
  const lines = cleanText.split('\n').map((line) => line.trim()).filter(Boolean);
  const firstMatch = (patterns, fallback) => {
    for (const line of lines) {
      for (const pattern of patterns) {
        const match = line.match(pattern);
        if (match?.[1]) return match[1].trim().slice(0, 120);
      }
    }
    return fallback;
  };

  const name = firstMatch([/(?:姓名|name)\s*[:：|丨-]\s*([^|丨]+)/i], lines[0] || 'Your Name');
  const school = firstMatch([/(?:学校|院校|教育经历|university|college)\s*[:：|丨-]?\s*([^|丨]+)/i], 'Your school');
  const degree = firstMatch([/(?:学历|学位|degree)\s*[:：|丨-]?\s*([^|丨]+)/i], 'Your degree / current status');
  const graduation = firstMatch([/(20\d{2})\s*(?:届|年毕业|graduat)/i], '2028');
  const normalized = cleanText.toLowerCase();
  const skills = RESUME_SKILL_LIBRARY
    .filter(([, terms]) => terms.some((term) => normalized.includes(term.toLowerCase())))
    .map(([label, terms]) => ({ label, terms }));
  const evidenceLine = lines.find((line) => /项目|实习|工作经历|project|intern|experience/i.test(line))
    || '从上传简历中提取的项目与经历';

  return normalizeResumeProfile({
    name,
    school,
    degree,
    graduation,
    evidenceSummary: evidenceLine,
    skills: skills.length ? skills : normalizeResumeProfile(window.APPLICATION_DESK_PROFILE || {}).skills
  });
}

function loadExternalScript(src, globalName) {
  if (window[globalName]) return Promise.resolve(window[globalName]);
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    const timeout = window.setTimeout(() => {
      script.remove();
      reject(new Error('解析组件加载超时，请检查网络后重试'));
    }, 12000);
    script.src = src;
    script.onload = () => {
      window.clearTimeout(timeout);
      if (window[globalName]) resolve(window[globalName]);
      else reject(new Error('解析组件加载失败，请刷新页面后重试'));
    };
    script.onerror = () => {
      window.clearTimeout(timeout);
      script.remove();
      reject(new Error('解析组件加载失败，请检查网络后重试'));
    };
    document.head.appendChild(script);
  });
}

async function parseResumeFile(file) {
  const extension = String(file.name || '').split('.').pop().toLowerCase();
  if (['txt', 'md'].includes(extension) || file.type.startsWith('text/')) {
    return { text: await file.text() };
  }
  if (extension === 'json') {
    const parsed = JSON.parse(await file.text());
    return { profile: parsed.profile || parsed.resume || parsed };
  }
  if (extension === 'pdf' || file.type === 'application/pdf') {
    await loadExternalScript(
      'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
      'pdfjsLib'
    );
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    const document = await window.pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
    const pages = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      pages.push(content.items.map((item) => item.str).join(' '));
    }
    return { text: pages.join('\n') };
  }
  if (extension === 'docx') {
    await loadExternalScript(
      'https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.8.0/mammoth.browser.min.js',
      'mammoth'
    );
    const result = await window.mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
    return { text: result.value };
  }
  throw new Error('暂不支持该文件格式，请上传 PDF、DOCX、TXT 或 Markdown');
}

function refreshJobsForResume() {
  state.jobs = state.jobs.map((job) => {
    const analysis = analyzeJob(job);
    const refreshed = { ...job, ...analysis };
    refreshed.route = analysis.verdict === 'good' ? 'queue' : analysis.verdict === 'unknown' ? 'review' : 'excluded';
    refreshed.greeting = makeGreeting(refreshed);
    return refreshed;
  });
  saveState();
  renderProfile();
  renderAll();
}

async function handleResumeUpload(file) {
  const status = $('#resume-upload-status');
  if (status) status.textContent = '正在本地解析简历……';
  try {
    const parsed = await parseResumeFile(file);
    resume = parsed.profile
      ? normalizeResumeProfile(parsed.profile)
      : profileFromResumeText(parsed.text);
    if (IS_FILE_MODE && !FILE_BRIDGE_REQUESTED) {
      localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(resume));
    }
    refreshJobsForResume();
    if (status) status.textContent = `已载入 ${file.name}；识别到 ${resume.skills.length} 项技能。`;
    toast('简历画像已更新，岗位匹配已重新计算');
  } catch (error) {
    console.error('Resume upload failed:', error);
    if (status) status.textContent = `解析失败：${error.message}`;
    toast(`简历解析失败：${error.message}`);
  }
}

function routeForJob(job) {
  if (['queue', 'review', 'excluded'].includes(job.route)) return job.route;
  if (job.verdict === 'good') return 'queue';
  if (job.verdict === 'unknown') return 'review';
  return 'excluded';
}

function verdictForJob(job) {
  if (['good', 'unknown', 'bad'].includes(job.verdict)) return job.verdict;
  return routeForJob(job) === 'queue' ? 'good' : routeForJob(job) === 'review' ? 'unknown' : 'bad';
}

function reasonsForJob(job) {
  if (Array.isArray(job.reasons)) return job.reasons;
  if (Array.isArray(job.match?.reasons)) return job.match.reasons;
  return [];
}

function gapsForJob(job) {
  return Array.isArray(job.match?.gaps) ? job.match.gaps : [];
}

function normalizeJob(input, existing = {}) {
  const job = {
    id: existing.id || crypto.randomUUID(),
    title: String(input.title || '').trim().slice(0, 100),
    company: String(input.company || '').trim().slice(0, 100),
    location: String(input.location || '').trim().slice(0, 100),
    url: String(input.url || '').trim().slice(0, 1000),
    description: String(input.description || '').trim().slice(0, 12000),
    status: existing.status || ['todo', 'contacted', 'replied', 'skipped'].includes(input.status) && input.status || 'todo',
    createdAt: existing.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    source: String(input.source || existing.source || '').trim().slice(0, 200),
    publishedAt: String(input.publishedAt || existing.publishedAt || '').trim().slice(0, 20),
    verifiedAt: String(input.verifiedAt || existing.verifiedAt || '').trim().slice(0, 20),
    curationNote: String(input.curationNote || existing.curationNote || '').trim().slice(0, 1000),
    curatedBatchId: input.curatedBatchId || existing.curatedBatchId || '',
    review: input.review || existing.review || null,
    directions: Array.isArray(input.directions)
      ? [...input.directions]
      : Array.isArray(existing.directions) ? [...existing.directions] : [],
    graduationYears: Array.isArray(input.graduationYears)
      ? input.graduationYears.map(String)
      : Array.isArray(existing.graduationYears) ? existing.graduationYears.map(String) : [],
    durationMonths: input.durationMonths ?? existing.durationMonths ?? null,
    daysPerWeek: input.daysPerWeek ?? existing.daysPerWeek ?? null,
    active: typeof input.active === 'boolean'
      ? input.active
      : typeof existing.active === 'boolean' ? existing.active : true,
    viewedAt: String(input.viewedAt || existing.viewedAt || '').slice(0, 40)
  };
  const analysis = analyzeJob(job);
  if (job.review) {
    analysis.score = clamp(Number(job.review.score) || analysis.score, 0, 100);
    analysis.verdict = ['good', 'unknown', 'bad'].includes(job.review.verdict) ? job.review.verdict : analysis.verdict;
    analysis.reasons = Array.isArray(job.review.reasons) ? job.review.reasons.slice(0, 4) : analysis.reasons;
    analysis.matchedSkills = Array.isArray(job.review.matchedSkills) ? job.review.matchedSkills.slice(0, 6) : analysis.matchedSkills;
    analysis.recommendation = String(job.review.recommendation || '').slice(0, 30);
  }
  Object.assign(job, analysis);
  job.route = ['queue', 'review', 'excluded'].includes(input.route)
    ? input.route
    : analysis.verdict === 'good' ? 'queue' : analysis.verdict === 'unknown' ? 'review' : 'excluded';
  job.greeting = !String(existing.greeting || '').trim() || isLegacyGreeting(existing.greeting)
    ? makeGreeting(job)
    : existing.greeting;
  return job;
}

function mergeCuratedBatch() {
  const batch = window.CURATED_BATCH;
  if (!batch || !batch.id || !Array.isArray(batch.jobs)) return 0;
  state.curatedBatches = Array.isArray(state.curatedBatches) ? state.curatedBatches : [];
  if (state.curatedBatches.includes(batch.id)) return 0;

  const existingKeys = new Set(state.jobs.map((job) => job.url || `${job.company}::${job.title}`.toLowerCase()));
  let added = 0;
  batch.jobs.forEach((input) => {
    const key = input.url || `${input.company}::${input.title}`.toLowerCase();
    if (existingKeys.has(key)) return;
    state.jobs.push(normalizeJob({
      ...input,
      verifiedAt: batch.verifiedAt,
      curatedBatchId: batch.id
    }));
    existingKeys.add(key);
    added += 1;
  });
  state.curatedBatches.push(batch.id);
  saveState();
  return added;
}

function renderSearches() {
  $('#search-grid').innerHTML = searches.map(([title, query, note]) => `<a class="search-card" href="${searchUrl(query)}" target="_blank" rel="noopener"><span>${escapeHtml(note)}</span><strong>${escapeHtml(title)}</strong><span>深圳 · 实习</span></a>`).join('');
}

function renderStats() {
  const counts = { total: state.jobs.length, todo: 0, contacted: 0, replied: 0, review: 0 };
  state.jobs.forEach((job) => { if (counts[job.status] !== undefined) counts[job.status] += 1; });
  counts.review = state.jobs.filter((job) => routeForJob(job) === 'review').length;
  $('#stats').innerHTML = [
    ['岗位总数', counts.total], ['待沟通', counts.todo], ['已沟通', counts.contacted], ['已回复', counts.replied]
  ].map(([label, value]) => `<div class="stat"><span>${label}</span><strong>${value}</strong></div>`).join('');
  $('#nav-count').textContent = counts.total;
  $('#review-nav-count').textContent = counts.review;
  $('#review-count').textContent = counts.review;
  $('#total-count').textContent = counts.total;
}

function filterByLegacyTab(job) {
  if (currentFilter === 'all') return true;
  if (currentFilter === 'recommended') return routeForJob(job) === 'queue';
  if (currentFilter === 'stretch') return routeForJob(job) === 'review';
  return job.status === currentFilter;
}

function jobCardMarkup(job) {
  const route = routeForJob(job);
  const verdict = verdictForJob(job);
  const reasons = reasonsForJob(job);
  const gaps = gapsForJob(job);
  const recommendation = job.recommendation
    || (route === 'queue' ? '优先沟通' : route === 'review' ? '待复核' : '不建议加入');
  return `<article class="job-card" data-id="${escapeHtml(job.id)}">
    <div class="score-badge ${verdict}"><strong>${Number(job.score) || 0}</strong><span>MATCH</span></div>
    <div class="job-info">
      <h3>${escapeHtml(job.title)}${job.source ? '<span class="curated-tag">公开核验</span>' : ''}${job.viewedAt ? '<span class="viewed-tag">已查看</span>' : ''}</h3>
      <p>${escapeHtml(job.company)} · ${escapeHtml(job.location || '地点未填')}${job.verifiedAt ? ` · 核验 ${escapeHtml(job.verifiedAt)}` : ''}</p>
      <div class="reason-line">${[...reasons.slice(0, 2), ...gaps.slice(0, 1)].map((reason) => `<span>${escapeHtml(reason)}</span>`).join('')}</div>
    </div>
    <div class="job-state"><small>${escapeHtml(recommendation)}</small><select class="status-select" data-status>${Object.entries(statusLabels).map(([value, label]) => `<option value="${value}" ${job.status === value ? 'selected' : ''}>${label}</option>`).join('')}</select></div>
    <div class="job-actions"><button class="main" data-greet>查看话术</button><button data-edit>编辑岗位</button><button data-delete>删除</button></div>
  </article>`;
}

function renderJobList(targetSelector, jobs, { reviewOnly = false } = {}) {
  const target = $(targetSelector);
  if (!target) return;
  if (!jobs.length) {
    target.innerHTML = `<div class="empty-state"><div class="empty-icon">${reviewOnly ? '✓' : '＋'}</div><h3>${state.jobs.length ? '当前筛选下没有岗位' : '岗位池还是空的'}</h3><p>${reviewOnly ? '暂时没有需要人工复核的岗位，或筛选条件过严。' : state.jobs.length ? '清空筛选或切换状态查看其他岗位。' : '从公开页面或 BOSS 当前岗位添加进来。'}</p><button class="button primary" ${state.jobs.length ? 'data-empty-clear' : 'data-empty-add'}>${state.jobs.length ? '清空筛选' : '添加第一个岗位'}</button></div>`;
    return;
  }

  target.innerHTML = jobs.map(jobCardMarkup).join('');
}

function wireJobCards() {
  $$('.job-card').forEach((card) => {
    const id = card.dataset.id;
    card.querySelector('[data-status]').addEventListener('change', (event) => updateStatus(id, event.target.value));
    card.querySelector('[data-greet]').addEventListener('click', () => openGreeting(id));
    card.querySelector('[data-edit]').addEventListener('click', () => openEditModal(id));
    card.querySelector('[data-delete]').addEventListener('click', () => deleteJob(id));
  });
  $$('[data-empty-add]').forEach((button) => button.addEventListener('click', openAddModal));
  $$('[data-empty-clear]').forEach((button) => button.addEventListener('click', () => {
    clearCompoundFilters(button.closest('#review-job-list') ? 'review' : 'queue');
  }));
}

function renderJobs() {
  const filtered = filterJobs(state.jobs, compoundFilters)
    .filter(filterByLegacyTab)
    .sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0) || new Date(b.createdAt) - new Date(a.createdAt));
  const reviewFilters = {
    ...reviewCompoundFilters,
    routes: ['review'],
    recommendationLevels: []
  };
  const reviewJobs = filterJobs(state.jobs, reviewFilters)
    .sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0) || new Date(b.createdAt) - new Date(a.createdAt));
  renderJobList('#job-list', filtered);
  renderJobList('#review-job-list', reviewJobs, { reviewOnly: true });
  wireJobCards();
}

function renderFilterPanels() {
  const options = availableFilterOptions(state.jobs);
  renderFilterPanel($('#compound-filter-panel'), options, compoundFilters);
  renderFilterPanel($('#review-filter-panel'), {
    ...options,
    routes: options.routes.includes('review') ? ['review'] : []
  }, { ...reviewCompoundFilters, routes: ['review'], recommendationLevels: [] }, {
    hideRecommendationLevels: true
  });
}

function renderSupplementaryViews() {
  renderPreferences($('#preferences-root'), state.preferences, { serverMode: !IS_FILE_MODE });
  renderExtensionCenter($('#extension-center-root'), {
    serverMode: !IS_FILE_MODE,
    extension: state.extension,
    pairingToken: extensionPairingToken
  });
}

function renderAll() {
  renderStats();
  renderFilterPanels();
  renderJobs();
  renderSupplementaryViews();
}

function switchSection(section) {
  currentSection = section;
  $$('.section').forEach((item) => {
    const active = item.id === `${section}-section`;
    item.classList.toggle('active-section', active);
    item.setAttribute('aria-hidden', String(!active));
  });
  $$('.nav-item').forEach((item) => {
    const active = item.dataset.section === section;
    item.classList.toggle('active', active);
    item.setAttribute('aria-selected', String(active));
    item.setAttribute('tabindex', active ? '0' : '-1');
    if (active) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  });
  $('#page-title').textContent = {
    radar: '岗位雷达',
    queue: '投递队列',
    review: '待复核',
    extension: '浏览器扩展',
    preferences: '求职偏好',
    profile: '简历画像'
  }[section];
  if (section === 'queue' || section === 'review') renderFilterPanels();
}

function openModal(selector) { $(selector).classList.add('open'); }
function closeModals() { $$('.modal-backdrop').forEach((modal) => modal.classList.remove('open')); }

function openAddModal() {
  $('#job-form').reset();
  $('#job-id').value = '';
  $('#job-location').value = '深圳';
  $('#modal-title').textContent = '添加岗位';
  openModal('#job-modal');
}

function openEditModal(id) {
  const job = state.jobs.find((item) => item.id === id);
  if (!job) return;
  $('#job-id').value = job.id;
  $('#job-title').value = job.title;
  $('#job-company').value = job.company;
  $('#job-location').value = job.location;
  $('#job-url').value = job.url;
  $('#job-description').value = job.description;
  $('#modal-title').textContent = '编辑岗位';
  openModal('#job-modal');
}

function openGreeting(id) {
  const job = state.jobs.find((item) => item.id === id);
  if (!job) return;
  activeGreetingId = id;
  activeGreetingVariant = 0;
  if (!job.viewedAt) {
    job.viewedAt = new Date().toISOString();
    job.updatedAt = job.viewedAt;
    if (IS_FILE_MODE) {
      saveState();
    } else {
      const viewedAt = job.viewedAt;
      void enqueueServerWrite(
        () => apiClient.patchJob(id, { viewedAt }),
        '记录查看状态失败'
      ).then((result) => {
        if (result?.job) upsertServerJob(result.job, id);
      });
    }
  }
  if (!String(job.greeting || '').trim() || isLegacyGreeting(job.greeting)) {
    job.greeting = makeGreeting(job);
  }
  $('#greeting-title').textContent = `${job.company} · ${job.title}`;
  $('#greeting-text').value = job.greeting;
  const sourceLine = job.source ? `<br><span>来源：${escapeHtml(job.source)} · 发布 ${escapeHtml(job.publishedAt || '日期未标注')} · 核验 ${escapeHtml(job.verifiedAt || '日期未标注')}</span>` : '';
  const noteLine = job.curationNote ? `<br><span>${escapeHtml(job.curationNote)}</span>` : '';
  const route = routeForJob(job);
  const recommendation = job.recommendation
    || (route === 'queue' ? '优先沟通' : route === 'review' ? '待复核' : '不建议加入');
  const evidence = [...reasonsForJob(job), ...gapsForJob(job)].slice(0, 5);
  $('#match-summary').innerHTML = `<strong>${Number(job.score) || 0} 分 · ${escapeHtml(recommendation)}</strong><br>${evidence.map(escapeHtml).join(' · ')}${sourceLine}${noteLine}`;
  renderJobs();
  openModal('#greeting-modal');
}

function updateStatus(id, status) {
  const job = state.jobs.find((item) => item.id === id);
  if (!job || !statusLabels[status]) return;
  const previousStatus = job.status;
  job.status = status;
  job.updatedAt = new Date().toISOString();
  if (IS_FILE_MODE) {
    saveState();
    renderAll();
    toast(`已标记为“${statusLabels[status]}”`);
    return;
  }
  renderAll();
  void enqueueServerWrite(
    () => apiClient.patchJob(id, { status }),
    '更新沟通状态失败'
  ).then((result) => {
    if (!result?.job) {
      const current = state.jobs.find((item) => item.id === id);
      if (current?.status === status) current.status = previousStatus;
      renderAll();
      return;
    }
    upsertServerJob(result.job, id);
    renderAll();
    toast(`已标记为“${statusLabels[status]}”`);
  });
}

function deleteJob(id) {
  const job = state.jobs.find((item) => item.id === id);
  if (!job || !confirm(`删除“${job.company} · ${job.title}”？`)) return;
  if (IS_FILE_MODE) {
    state.jobs = state.jobs.filter((item) => item.id !== id);
    saveState();
    renderAll();
    toast('岗位已删除');
    return;
  }
  void enqueueServerWrite(
    () => apiClient.deleteJob(id),
    '删除岗位失败'
  ).then((result) => {
    if (!result?.job) return;
    state.jobs = state.jobs.filter((item) => item.id !== id);
    renderAll();
    toast('岗位已删除');
  });
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch (_) {
    const field = document.createElement('textarea');
    field.value = text;
    field.setAttribute('readonly', '');
    field.style.position = 'fixed';
    field.style.opacity = '0';
    document.body.append(field);
    field.select();
    const copied = document.execCommand('copy');
    field.remove();
    return copied;
  }
}

function toast(message) {
  const element = $('#toast'); element.textContent = message; element.classList.add('show');
  clearTimeout(toast.timer); toast.timer = setTimeout(() => element.classList.remove('show'), 2400);
}

function clearCompoundFilters(target = 'queue') {
  if (target === 'review') reviewCompoundFilters = createEmptyFilters();
  else compoundFilters = createEmptyFilters();
  currentFilter = 'all';
  $$('#filter-tabs button').forEach((item) => item.classList.toggle('active', item.dataset.filter === 'all'));
  renderFilterPanels();
  renderJobs();
  toast('筛选条件已清空，求职偏好保持不变');
}

function exportData() {
  const payload = JSON.stringify({
    version: 3,
    exportedAt: new Date().toISOString(),
    jobs: state.jobs,
    preferences: state.preferences,
    curatedBatches: state.curatedBatches,
    deletedKeys: state.deletedKeys
  }, null, 2);
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([payload], { type: 'application/json' }));
  link.download = `投递台备份-${new Date().toISOString().slice(0, 10)}.json`;
  link.click(); URL.revokeObjectURL(link.href); toast('备份已导出');
}

async function importData(file) {
  try {
    const parsed = JSON.parse(await file.text());
    if (!Array.isArray(parsed.jobs)) throw new Error('缺少 jobs 数组');
    const imported = parsed.jobs.slice(0, 1000).map((job) => normalizeJob(job, { id: job.id, status: job.status, createdAt: job.createdAt, greeting: job.greeting }));
    if (IS_FILE_MODE) {
      state.jobs = imported;
      if (parsed.preferences) state.preferences = normalizePreferences(parsed.preferences);
      saveState();
      renderAll();
      switchSection('queue');
      toast(`已导入 ${imported.length} 个岗位`);
      return;
    }

    let saved = 0;
    for (const job of imported) {
      const result = await enqueueServerWrite(
        () => apiClient.createJob({ ...job, forceSave: true }),
        `导入“${job.company} · ${job.title}”失败`
      );
      if (result?.job) saved += 1;
    }
    if (parsed.preferences) {
      await enqueueServerWrite(
        () => apiClient.updatePreferences(normalizePreferences(parsed.preferences)),
        '导入求职偏好失败'
      );
    }
    state = normalizeServerState(await apiClient.getState());
    renderAll();
    switchSection('queue');
    toast(`已通过逐条写入导入 ${saved} 个岗位`);
  } catch (error) { toast(`导入失败：${error.message}`); }
}

async function handlePreferencesSave(preferences) {
  if (IS_FILE_MODE) {
    state.preferences = normalizePreferences(preferences);
    saveState();
    renderSupplementaryViews();
    toast('偏好已保存在浏览器；通过本地服务打开后可重新评分');
    return;
  }
  try {
    await apiClient.updatePreferences(normalizePreferences(preferences));
    state = normalizeServerState(await apiClient.getState());
    renderAll();
    toast('偏好已保存，仅“待沟通”岗位已重新评分');
  } catch (error) {
    console.error('Failed to save preferences:', error);
    toast(`偏好保存失败：${error.message}`);
  }
}

$('#job-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const id = $('#job-id').value;
  const existing = state.jobs.find((item) => item.id === id);
  const input = { title: $('#job-title').value, company: $('#job-company').value, location: $('#job-location').value, url: $('#job-url').value, description: $('#job-description').value };
  if (IS_FILE_MODE) {
    const job = normalizeJob(input, existing || {});
    if (existing) state.jobs = state.jobs.map((item) => item.id === id ? job : item);
    else state.jobs.push(job);
    saveState();
    renderAll();
    closeModals();
    switchSection('queue');
    toast(existing ? '岗位已更新' : `已加入队列，匹配度 ${job.score} 分`);
    return;
  }

  const result = await enqueueServerWrite(
    () => existing ? apiClient.patchJob(id, input) : apiClient.createJob(input),
    existing ? '更新岗位失败' : '添加岗位失败'
  );
  if (!result?.job) return;
  upsertServerJob(result.job, id);
  renderAll();
  closeModals();
  switchSection('queue');
  toast(existing ? '岗位已更新' : `已加入队列，匹配度 ${result.job.score} 分`);
});

$$('.nav-item').forEach((button) => button.addEventListener('click', () => switchSection(button.dataset.section)));
$('.sidebar nav').addEventListener('keydown', (event) => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  const items = $$('.nav-item');
  const currentIndex = Math.max(0, items.indexOf(document.activeElement));
  const nextIndex = event.key === 'Home'
    ? 0
    : event.key === 'End'
      ? items.length - 1
      : (currentIndex + (event.key === 'ArrowRight' ? 1 : -1) + items.length) % items.length;
  event.preventDefault();
  items[nextIndex].focus();
  switchSection(items[nextIndex].dataset.section);
});
$$('[data-close]').forEach((button) => button.addEventListener('click', closeModals));
$$('.modal-backdrop').forEach((modal) => modal.addEventListener('click', (event) => { if (event.target === modal) closeModals(); }));
$('#add-job-btn').addEventListener('click', openAddModal);
$('#filter-tabs').addEventListener('click', (event) => {
  const button = event.target.closest('[data-filter]'); if (!button) return;
  currentFilter = button.dataset.filter;
  $$('#filter-tabs button').forEach((item) => item.classList.toggle('active', item === button)); renderJobs();
});
document.addEventListener('filters:change', (event) => {
  const next = event.detail?.filters || createEmptyFilters();
  if (event.target?.id === 'review-filter-panel') {
    reviewCompoundFilters = { ...next, routes: [], recommendationLevels: [] };
  } else {
    compoundFilters = next;
  }
  renderJobs();
});
document.addEventListener('filters:clear', (event) => {
  clearCompoundFilters(event.target?.id === 'review-filter-panel' ? 'review' : 'queue');
});
document.addEventListener('preferences:save', (event) => {
  void handlePreferencesSave(event.detail?.preferences || DEFAULT_PREFERENCES);
});
document.addEventListener('extension:pair', () => {
  if (IS_FILE_MODE) {
    toast('生成配对令牌需要从本地服务版投递台打开');
    return;
  }
  void enqueueServerWrite(
    () => apiClient.pairExtension(),
    '生成扩展配对令牌失败'
  ).then((result) => {
    if (!result?.extensionToken) return;
    extensionPairingToken = result.extensionToken;
    renderSupplementaryViews();
    toast('已生成配对令牌，等待扩展连接');
  });
});
document.addEventListener('extension:copy', async (event) => {
  const token = String(event.detail?.token || '');
  if (!token) return;
  toast(await copyText(token) ? '扩展配对令牌已复制' : '复制失败，请手动选择令牌');
});
$('#regenerate-greeting-btn').addEventListener('click', () => {
  const job = state.jobs.find((item) => item.id === activeGreetingId); if (!job) return;
  activeGreetingVariant += 1;
  job.greeting = makeGreeting(job, activeGreetingVariant);
  $('#greeting-text').value = job.greeting;
  toast('已换一版话术，请检查后复制');
});
$('#copy-greeting-btn').addEventListener('click', async () => {
  const job = state.jobs.find((item) => item.id === activeGreetingId); if (!job) return;
  job.greeting = $('#greeting-text').value.trim();
  if (IS_FILE_MODE) {
    saveState();
  } else {
    const greeting = job.greeting;
    void enqueueServerWrite(
      () => apiClient.patchJob(job.id, { greeting }),
      '保存招呼语失败'
    ).then((result) => {
      if (result?.job) upsertServerJob(result.job, job.id);
    });
  }
  toast(await copyText(job.greeting) ? '招呼语已复制，请在 BOSS 中确认发送' : '复制失败，请手动选择文本');
});
$('#open-job-btn').addEventListener('click', () => {
  const job = state.jobs.find((item) => item.id === activeGreetingId); if (!job) return;
  try { const url = new URL(job.url); if (!/^https?:$/.test(url.protocol)) throw new Error(); window.open(url.href, '_blank', 'noopener'); }
  catch (_) { toast('岗位链接无效，请先编辑岗位链接'); }
});
$('#skip-job-btn').addEventListener('click', () => { if (activeGreetingId) updateStatus(activeGreetingId, 'skipped'); closeModals(); });
$('#export-btn').addEventListener('click', exportData);
$('#import-btn').addEventListener('click', () => $('#import-file').click());
$('#import-file').addEventListener('change', (event) => { if (event.target.files[0]) importData(event.target.files[0]); event.target.value = ''; });
$('#resume-upload-btn')?.addEventListener('click', () => $('#resume-file')?.click());
$('#resume-file')?.addEventListener('change', (event) => {
  if (event.target.files[0]) void handleResumeUpload(event.target.files[0]);
  event.target.value = '';
});
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeModals(); });

if (IS_FILE_MODE) {
  renderProfile();
  if (!FILE_BRIDGE_REQUESTED) mergeCuratedBatch();
  renderSearches();
  renderAll();
  if (FILE_BRIDGE_REQUESTED) void runFileMigrationBridge();
} else {
  renderProfile();
  void startLocalhostApplication();
}
