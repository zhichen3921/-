(function exposeApplicationDeskFilters(root) {
  const ROUTES = Object.freeze(['queue', 'review', 'excluded']);
  const STATUSES = Object.freeze(['todo', 'contacted', 'replied', 'skipped']);
  const RECOMMENDATION_LEVELS = Object.freeze(['priority', 'suggested', 'review']);
  const DISTRICT_NAMES = Object.freeze([
    '南山', '福田', '宝安', '龙岗', '龙华', '罗湖', '光明', '坪山', '盐田', '大鹏',
    '海淀', '朝阳', '浦东', '黄埔', '天河', '番禺'
  ]);
  const DIRECTION_PATTERNS = Object.freeze({
    agent: /\bagent\b|智能体|多智能体|\bmcp\b/i,
    'llm-workflow': /大模型|\bllm\b|prompt|工作流|workflow|openai|claude|codex/i,
    'machine-learning': /机器学习|machine learning|算法建模|xgboost|lightgbm|回归模型/i,
    'data-analysis': /数据分析|数据处理|数据清洗|特征工程|数据科学|\bsql\b/i,
    'ai-product': /ai\s*产品|人工智能产品|产品实习|产品经理/i,
    'electronics-ai': /电子信息|传感器|半导体|stm32|硬件|端侧\s*ai|嵌入式/i,
    'llm-training': /预训练|微调|\bsft\b|\brlhf\b|模型训练|蒸馏/i,
    'computer-vision': /计算机视觉|computer vision|\bcv\b|图像|视觉多模态/i,
    speech: /语音识别|语音算法|speech|\basr\b/i
  });
  const DIRECTION_LABELS = Object.freeze({
    agent: 'AI 应用 / Agent',
    'llm-workflow': '大模型工作流',
    'machine-learning': '机器学习',
    'data-analysis': '数据分析',
    'ai-product': 'AI 产品',
    'electronics-ai': '电子信息 × AI',
    'llm-training': '大模型训练',
    'computer-vision': '计算机视觉',
    speech: '语音算法'
  });
  const RECOMMENDATION_LABELS = Object.freeze({
    priority: '优先沟通',
    suggested: '建议沟通',
    review: '待复核'
  });
  const STATUS_LABELS = Object.freeze({
    todo: '待沟通',
    contacted: '已沟通',
    replied: '已回复',
    skipped: '已跳过'
  });

  const arrayFields = Object.freeze([
    'routes',
    'recommendationLevels',
    'directions',
    'companies',
    'sources',
    'districts',
    'durationMonths',
    'daysPerWeek',
    'viewedStates',
    'activeStates',
    'statuses',
    'graduationYears'
  ]);

  function createEmptyFilters() {
    return {
      routes: [],
      recommendationLevels: [],
      directions: [],
      companies: [],
      sources: [],
      districts: [],
      publishedWithinDays: null,
      durationMonths: [],
      daysPerWeek: [],
      graduationYears: [],
      accepts2028: false,
      viewedStates: [],
      activeStates: [],
      statuses: [],
      keyword: ''
    };
  }

  function cleanList(value) {
    return Array.isArray(value)
      ? [...new Set(value.filter((item) => item !== '' && item !== null && item !== undefined))]
      : [];
  }

  function textFor(job) {
    return [
      job.title,
      job.company,
      job.location,
      job.description,
      job.source,
      ...(Array.isArray(job.directions) ? job.directions : [])
    ].filter(Boolean).join(' ');
  }

  function routeFor(job) {
    if (ROUTES.includes(job.route)) return job.route;
    if (job.verdict === 'good') return 'queue';
    if (job.verdict === 'unknown') return 'review';
    return job.verdict === 'bad' ? 'excluded' : '';
  }

  function recommendationLevelFor(job) {
    const route = routeFor(job);
    if (route === 'review') return 'review';
    if (route !== 'queue') return '';
    const recommendation = String(job.recommendation || job.review?.recommendation || '');
    if (/优先/.test(recommendation)) return 'priority';
    if (/建议|可以/.test(recommendation)) return 'suggested';
    return Number(job.score) >= 85 ? 'priority' : 'suggested';
  }

  function directionsFor(job) {
    const found = new Set(Array.isArray(job.directions) ? job.directions.filter(Boolean) : []);
    const text = textFor(job);
    Object.entries(DIRECTION_PATTERNS).forEach(([direction, pattern]) => {
      if (pattern.test(text)) found.add(direction);
    });
    return [...found];
  }

  function hasNegatedYear(text, year) {
    const escaped = String(year).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const directNegative = new RegExp(`(?:不接受|不招收?|拒绝|暂不接受|不面向)\\s*${escaped}\\s*届?`);
    if (directNegative.test(text)) return true;

    const restricted = text.matchAll(/(?:仅限|只限|仅面向|只招|限招)([^。；;！!？?\n]{0,32})/g);
    for (const match of restricted) {
      const years = [...match[1].matchAll(/20\d{2}/g)].map((item) => item[0]);
      if (years.length && !years.includes(String(year))) return true;
    }
    return false;
  }

  function hasExplicitPositiveYear(text, year) {
    const escaped = String(year).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(
      `(?:面向|接受|招收|欢迎)\\s*${escaped}\\s*届?|${escaped}\\s*届[^。；;！!？?\\n]{0,10}(?:可投|可申请|毕业生)`
    ).test(text);
  }

  function acceptsGraduationYear(job, year) {
    const text = textFor(job);
    if (hasNegatedYear(text, year)) return false;
    const structured = Array.isArray(job.graduationYears)
      ? job.graduationYears.map(String)
      : [];
    return structured.includes(String(year)) || hasExplicitPositiveYear(text, year);
  }

  function graduationYearsFor(job) {
    const years = new Set(
      Array.isArray(job.graduationYears)
        ? job.graduationYears.map(String).filter(Boolean)
        : []
    );
    const text = textFor(job);
    for (const match of text.matchAll(/\b20(?:2[0-9])\b/g)) {
      if (hasExplicitPositiveYear(text, match[0]) && !hasNegatedYear(text, match[0])) {
        years.add(match[0]);
      }
    }
    return [...years].filter((year) => !hasNegatedYear(text, year));
  }

  function districtFor(job) {
    const location = String(job.location || '').trim();
    if (!location) return '';
    return DISTRICT_NAMES.find((district) => location.includes(district)) || '';
  }

  function viewedStateFor(job) {
    return job.viewedAt || job.lastViewedAt ? 'viewed' : 'unviewed';
  }

  function activeStateFor(job) {
    return job.active === false ? 'inactive' : 'active';
  }

  function intersects(actual, selected) {
    return !selected.length || actual.some((value) => selected.includes(value));
  }

  function scalarIncluded(actual, selected) {
    return !selected.length || selected.includes(actual);
  }

  function publishedWithin(job, days, now) {
    if (days === null || days === '' || days === undefined) return true;
    const limit = Number(days);
    if (!Number.isFinite(limit) || limit < 0) return true;
    const publishedAt = Date.parse(job.publishedAt);
    const reference = Date.parse(now || new Date().toISOString());
    if (!Number.isFinite(publishedAt) || !Number.isFinite(reference)) return false;
    const age = reference - publishedAt;
    return age >= 0 && age <= limit * 86_400_000;
  }

  function filterJobs(jobs, inputFilters = {}) {
    const filters = { ...createEmptyFilters(), ...inputFilters };
    arrayFields.forEach((field) => {
      filters[field] = cleanList(filters[field]);
    });
    const keyword = String(filters.keyword || '').trim().toLocaleLowerCase('zh-CN');

    return (Array.isArray(jobs) ? jobs : []).filter((job) => {
      const directions = directionsFor(job);
      const years = graduationYearsFor(job);
      const route = routeFor(job);
      const recommendationLevel = recommendationLevelFor(job);
      const district = districtFor(job);

      if (!scalarIncluded(route, filters.routes)) return false;
      if (!scalarIncluded(recommendationLevel, filters.recommendationLevels)) return false;
      if (!intersects(directions, filters.directions)) return false;
      if (!scalarIncluded(job.company, filters.companies)) return false;
      if (!scalarIncluded(job.source, filters.sources)) return false;
      if (!scalarIncluded(district, filters.districts)) return false;
      if (!scalarIncluded(Number(job.durationMonths), filters.durationMonths.map(Number))) return false;
      if (!scalarIncluded(Number(job.daysPerWeek), filters.daysPerWeek.map(Number))) return false;
      if (!intersects(years, filters.graduationYears.map(String))) return false;
      if (filters.accepts2028 && !acceptsGraduationYear(job, '2028')) return false;
      if (!scalarIncluded(viewedStateFor(job), filters.viewedStates)) return false;
      if (!scalarIncluded(activeStateFor(job), filters.activeStates)) return false;
      if (!scalarIncluded(job.status, filters.statuses)) return false;
      if (!publishedWithin(job, filters.publishedWithinDays, filters.now)) return false;
      if (keyword && !textFor(job).toLocaleLowerCase('zh-CN').includes(keyword)) return false;
      return true;
    });
  }

  function sortedStrings(values) {
    return [...new Set(values.filter(Boolean))]
      .sort((a, b) => String(a).localeCompare(String(b), 'zh-CN'));
  }

  function sortedNumbers(values) {
    return [...new Set(values.map(Number).filter(Number.isFinite))].sort((a, b) => a - b);
  }

  function availableFilterOptions(jobs) {
    const source = Array.isArray(jobs) ? jobs : [];
    return {
      routes: ROUTES.filter((route) => source.some((job) => routeFor(job) === route)),
      recommendationLevels: RECOMMENDATION_LEVELS.filter((level) => (
        source.some((job) => recommendationLevelFor(job) === level)
      )),
      directions: sortedStrings(source.flatMap(directionsFor)),
      companies: sortedStrings(source.map((job) => job.company)),
      sources: sortedStrings(source.map((job) => job.source)),
      districts: sortedStrings(source.map(districtFor)),
      durationMonths: sortedNumbers(source.map((job) => job.durationMonths)),
      daysPerWeek: sortedNumbers(source.map((job) => job.daysPerWeek)),
      graduationYears: sortedStrings(source.flatMap(graduationYearsFor)),
      statuses: STATUSES.filter((status) => source.some((job) => job.status === status))
    };
  }

  function hasActiveFilters(inputFilters = {}) {
    const filters = { ...createEmptyFilters(), ...inputFilters };
    if (arrayFields.some((field) => cleanList(filters[field]).length > 0)) return true;
    if (filters.accepts2028 === true) return true;
    if (filters.publishedWithinDays !== null && filters.publishedWithinDays !== '') return true;
    return Boolean(String(filters.keyword || '').trim());
  }

  function escapeHtml(value = '') {
    return String(value).replace(/[&<>'"]/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
    })[char]);
  }

  function checkboxGroup(name, label, values, selected, labelFor = (value) => value) {
    if (!values.length) return '';
    const selectedValues = new Set(selected.map(String));
    const items = values.map((value) => {
      const normalized = String(value);
      return `<label class="filter-check">
        <input type="checkbox" name="${escapeHtml(name)}" value="${escapeHtml(normalized)}" ${selectedValues.has(normalized) ? 'checked' : ''}>
        <span>${escapeHtml(labelFor(value))}</span>
      </label>`;
    }).join('');
    return `<details class="filter-menu">
      <summary>${escapeHtml(label)}<b>${selectedValues.size || ''}</b></summary>
      <div class="filter-popover">${items}</div>
    </details>`;
  }

  function readFilterForm(form) {
    const values = (name) => [...form.querySelectorAll(`[name="${name}"]:checked`)]
      .map((input) => input.value);
    return {
      ...createEmptyFilters(),
      recommendationLevels: values('recommendationLevels'),
      directions: values('directions'),
      companies: values('companies'),
      sources: values('sources'),
      districts: values('districts'),
      publishedWithinDays: form.elements.publishedWithinDays?.value || null,
      durationMonths: values('durationMonths').map(Number),
      daysPerWeek: values('daysPerWeek').map(Number),
      graduationYears: values('graduationYears'),
      accepts2028: Boolean(form.elements.accepts2028?.checked),
      viewedStates: values('viewedStates'),
      activeStates: values('activeStates'),
      statuses: values('statuses'),
      keyword: form.elements.keyword?.value || ''
    };
  }

  function renderFilterPanel(container, options, inputFilters = {}, {
    hideRecommendationLevels = false
  } = {}) {
    if (!container) return;
    const filters = { ...createEmptyFilters(), ...inputFilters };
    const safeOptions = options || {};
    const selectedPublishedAge = filters.publishedWithinDays === null
      ? ''
      : String(filters.publishedWithinDays);
    container.innerHTML = `<form class="compound-filter-form">
      <label class="filter-search">
        <span aria-hidden="true">⌕</span>
        <input name="keyword" value="${escapeHtml(filters.keyword)}" placeholder="搜索岗位、公司或技能" aria-label="搜索岗位、公司或技能">
      </label>
      <div class="filter-menu-row">
        ${hideRecommendationLevels ? '' : checkboxGroup('recommendationLevels', '推荐等级', safeOptions.recommendationLevels || [], filters.recommendationLevels, (value) => RECOMMENDATION_LABELS[value] || value)}
        ${checkboxGroup('directions', '岗位方向', safeOptions.directions || [], filters.directions, (value) => DIRECTION_LABELS[value] || value)}
        ${checkboxGroup('companies', '公司', safeOptions.companies || [], filters.companies)}
        ${checkboxGroup('sources', '来源', safeOptions.sources || [], filters.sources)}
        ${checkboxGroup('districts', '区域', safeOptions.districts || [], filters.districts)}
        ${checkboxGroup('durationMonths', '实习时长', safeOptions.durationMonths || [], filters.durationMonths, (value) => `${value} 个月`)}
        ${checkboxGroup('daysPerWeek', '每周到岗', safeOptions.daysPerWeek || [], filters.daysPerWeek, (value) => `${value} 天`)}
        ${checkboxGroup('graduationYears', '毕业年份', safeOptions.graduationYears || [], filters.graduationYears, (value) => `${value} 届`)}
        ${checkboxGroup('statuses', '沟通状态', safeOptions.statuses || [], filters.statuses, (value) => STATUS_LABELS[value] || value)}
        <label class="filter-select-wrap">发布时间
          <select name="publishedWithinDays">
            <option value="" ${selectedPublishedAge === '' ? 'selected' : ''}>不限</option>
            <option value="7" ${selectedPublishedAge === '7' ? 'selected' : ''}>7 天内</option>
            <option value="30" ${selectedPublishedAge === '30' ? 'selected' : ''}>30 天内</option>
            <option value="90" ${selectedPublishedAge === '90' ? 'selected' : ''}>90 天内</option>
          </select>
        </label>
      </div>
      <div class="filter-quick-row">
        <label class="filter-toggle"><input type="checkbox" name="accepts2028" ${filters.accepts2028 ? 'checked' : ''}><span>仅看明确接受 2028 届</span></label>
        <label class="filter-check inline"><input type="checkbox" name="viewedStates" value="unviewed" ${filters.viewedStates.includes('unviewed') ? 'checked' : ''}><span>仅看未查看</span></label>
        <label class="filter-check inline"><input type="checkbox" name="activeStates" value="active" ${filters.activeStates.includes('active') ? 'checked' : ''}><span>仅看招聘中</span></label>
        <button class="clear-filter-button" type="button" data-clear-filters ${hasActiveFilters(filters) ? '' : 'disabled'}>清空筛选</button>
      </div>
    </form>`;

    const form = container.querySelector('form');
    let keywordTimer;
    const emitChange = () => {
      const nextFilters = readFilterForm(form);
      if (hideRecommendationLevels) nextFilters.routes = ['review'];
      const clearButton = form.querySelector('[data-clear-filters]');
      if (clearButton) clearButton.disabled = !hasActiveFilters(nextFilters);
      container.dispatchEvent(new CustomEvent('filters:change', {
        bubbles: true,
        detail: { filters: nextFilters }
      }));
    };
    form.addEventListener('change', emitChange);
    form.elements.keyword?.addEventListener('input', () => {
      clearTimeout(keywordTimer);
      keywordTimer = setTimeout(emitChange, 120);
    });
    form.querySelector('[data-clear-filters]')?.addEventListener('click', () => {
      container.dispatchEvent(new CustomEvent('filters:clear', {
        bubbles: true,
        detail: { filters: createEmptyFilters() }
      }));
    });
  }

  root.ApplicationDeskFilters = Object.freeze({
    acceptsGraduationYear,
    availableFilterOptions,
    createEmptyFilters,
    filterJobs,
    hasActiveFilters,
    recommendationLevelFor,
    renderFilterPanel
  });
})(typeof window !== 'undefined' ? window : globalThis);
