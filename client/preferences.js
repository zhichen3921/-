(function exposeApplicationDeskPreferences(root) {
  const DEFAULT_PREFERENCES = Object.freeze({
    queueThreshold: 75,
    reviewThreshold: 60,
    primaryDirections: Object.freeze([
      'agent',
      'llm-workflow',
      'machine-learning',
      'data-analysis',
      'ai-product',
      'electronics-ai'
    ]),
    stretchDirections: Object.freeze([
      'llm-training',
      'computer-vision',
      'speech'
    ]),
    stretchEnabled: true,
    graduationYears: Object.freeze(['2028']),
    locations: Object.freeze(['深圳', '远程']),
    minimumMonths: 3,
    availableDaysPerWeek: 4
  });

  const DIRECTIONS = Object.freeze([
    ['agent', 'AI 应用 / Agent', '工具调用、智能体与业务落地'],
    ['llm-workflow', '大模型工具与工作流', 'Prompt、API、自动化流程'],
    ['machine-learning', '机器学习', '建模、特征工程与可解释性'],
    ['data-analysis', '数据分析', '清洗、指标与业务分析'],
    ['ai-product', 'AI 产品', '需求、评测与产品迭代'],
    ['electronics-ai', '电子信息 × AI', '传感器、端侧与硬件结合'],
    ['llm-training', '大模型训练', '预训练、微调与评测'],
    ['computer-vision', '计算机视觉', '视觉、多模态与图像算法'],
    ['speech', '语音算法', 'ASR、音频与语音模型']
  ]);

  function cleanStringArray(value, fallback) {
    return Array.isArray(value)
      ? [...new Set(value.map(String).filter(Boolean))]
      : [...fallback];
  }

  function normalizePreferences(input = {}) {
    const queueThreshold = Number(input.queueThreshold);
    const reviewThreshold = Number(input.reviewThreshold);
    const minimumMonths = Number(input.minimumMonths);
    const availableDaysPerWeek = Number(input.availableDaysPerWeek);
    return {
      queueThreshold: Number.isInteger(queueThreshold) ? queueThreshold : DEFAULT_PREFERENCES.queueThreshold,
      reviewThreshold: Number.isInteger(reviewThreshold) ? reviewThreshold : DEFAULT_PREFERENCES.reviewThreshold,
      primaryDirections: cleanStringArray(input.primaryDirections, DEFAULT_PREFERENCES.primaryDirections),
      stretchDirections: cleanStringArray(input.stretchDirections, DEFAULT_PREFERENCES.stretchDirections),
      stretchEnabled: typeof input.stretchEnabled === 'boolean'
        ? input.stretchEnabled
        : DEFAULT_PREFERENCES.stretchEnabled,
      graduationYears: cleanStringArray(input.graduationYears, DEFAULT_PREFERENCES.graduationYears),
      locations: cleanStringArray(input.locations, DEFAULT_PREFERENCES.locations),
      minimumMonths: Number.isInteger(minimumMonths) ? minimumMonths : DEFAULT_PREFERENCES.minimumMonths,
      availableDaysPerWeek: Number.isInteger(availableDaysPerWeek)
        ? availableDaysPerWeek
        : DEFAULT_PREFERENCES.availableDaysPerWeek
    };
  }

  function escapeHtml(value = '') {
    return String(value).replace(/[&<>'"]/g, (char) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;'
    })[char]);
  }

  function directionCards(prefs, kind) {
    const selected = new Set(prefs[kind]);
    const allowed = kind === 'primaryDirections'
      ? DIRECTIONS.slice(0, 6)
      : DIRECTIONS.slice(6);
    return allowed.map(([value, label, note]) => `<label class="preference-direction ${selected.has(value) ? 'selected' : ''}">
      <input type="checkbox" name="${kind}" value="${value}" ${selected.has(value) ? 'checked' : ''}>
      <span><strong>${escapeHtml(label)}</strong><small>${escapeHtml(note)}</small></span>
    </label>`).join('');
  }

  function renderPreferences(container, inputPreferences, { serverMode = false } = {}) {
    if (!container) return;
    const prefs = normalizePreferences(inputPreferences);
    container.innerHTML = `<form class="preferences-form">
      <div class="preferences-masthead">
        <div>
          <span class="index-label">05 / MATCHING COMPASS</span>
          <h2>把“合适”<em>定义清楚。</em></h2>
          <p>修改偏好后，${serverMode ? '本地服务只会重新计算“待沟通”岗位；历史沟通结果保持原分数快照。' : '设置会保存在当前浏览器，但 file:// 模式不会伪造重新评分。'}</p>
        </div>
        <span class="mode-stamp ${serverMode ? 'connected' : ''}">${serverMode ? 'LOCAL API · CONNECTED' : 'FILE MODE · LOCAL ONLY'}</span>
      </div>

      <section class="preference-sheet">
        <div class="sheet-index"><span>01</span><strong>优先方向</strong><p>这些方向会获得主要匹配加权。</p></div>
        <div class="preference-directions">${directionCards(prefs, 'primaryDirections')}</div>
      </section>

      <section class="preference-sheet">
        <div class="sheet-index"><span>02</span><strong>冲刺方向</strong><p>技术门槛更高，默认进入谨慎评估。</p></div>
        <div>
          <label class="switch-line">
            <input type="checkbox" name="stretchEnabled" ${prefs.stretchEnabled ? 'checked' : ''}>
            <span class="switch-control"></span>
            <strong>启用冲刺方向</strong>
          </label>
          <div class="preference-directions stretch-directions">${directionCards(prefs, 'stretchDirections')}</div>
        </div>
      </section>

      <section class="preference-sheet">
        <div class="sheet-index"><span>03</span><strong>硬条件</strong><p>用于地点、届别与实习安排判断。</p></div>
        <div class="preference-fields">
          <label>可接受地点
            <div class="inline-options">
              <label><input type="checkbox" name="locations" value="深圳" ${prefs.locations.includes('深圳') ? 'checked' : ''}>深圳</label>
              <label><input type="checkbox" name="locations" value="远程" ${prefs.locations.includes('远程') ? 'checked' : ''}>远程</label>
            </div>
          </label>
          <label>毕业年份
            <input name="graduationYears" value="${escapeHtml(prefs.graduationYears.join('、'))}" placeholder="例如：2028">
          </label>
          <label>最短实习月数
            <input name="minimumMonths" type="number" min="0" max="24" value="${prefs.minimumMonths}">
          </label>
          <label>每周可到岗
            <select name="availableDaysPerWeek">${[3, 4, 5, 6, 7].map((days) => `<option value="${days}" ${prefs.availableDaysPerWeek === days ? 'selected' : ''}>${days} 天</option>`).join('')}</select>
          </label>
        </div>
      </section>

      <section class="preference-sheet threshold-sheet">
        <div class="sheet-index"><span>04</span><strong>分流阈值</strong><p>主队列 ≥75，待复核 60–74。</p></div>
        <div class="threshold-grid">
          <label><span>主队列最低分</span><input name="queueThreshold" type="number" min="0" max="100" value="${prefs.queueThreshold}"><small>达到后自动进入优先队列</small></label>
          <label><span>待复核最低分</span><input name="reviewThreshold" type="number" min="0" max="100" value="${prefs.reviewThreshold}"><small>低于此分数默认不保存</small></label>
        </div>
      </section>

      <div class="preference-savebar">
        <p><strong>保存范围：</strong>${serverMode ? '偏好 + 待沟通岗位重评分' : '当前浏览器偏好；不重评分'}</p>
        <button class="button primary preference-save" type="submit">保存求职偏好</button>
      </div>
    </form>`;

    container.querySelectorAll('.preference-direction input').forEach((input) => {
      input.addEventListener('change', () => {
        input.closest('.preference-direction')?.classList.toggle('selected', input.checked);
      });
    });
    container.querySelector('form').addEventListener('submit', (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const values = (name) => [...form.querySelectorAll(`[name="${name}"]:checked`)]
        .map((input) => input.value);
      const queueThreshold = Number(form.elements.queueThreshold.value);
      const reviewThreshold = Number(form.elements.reviewThreshold.value);
      if (reviewThreshold > queueThreshold) {
        form.elements.reviewThreshold.setCustomValidity('待复核阈值不能高于主队列阈值');
        form.elements.reviewThreshold.reportValidity();
        return;
      }
      form.elements.reviewThreshold.setCustomValidity('');
      const preferences = normalizePreferences({
        queueThreshold,
        reviewThreshold,
        primaryDirections: values('primaryDirections'),
        stretchDirections: values('stretchDirections'),
        stretchEnabled: form.elements.stretchEnabled.checked,
        graduationYears: String(form.elements.graduationYears.value)
          .split(/[、,，\s]+/)
          .map((value) => value.trim())
          .filter(Boolean),
        locations: values('locations'),
        minimumMonths: Number(form.elements.minimumMonths.value),
        availableDaysPerWeek: Number(form.elements.availableDaysPerWeek.value)
      });
      container.dispatchEvent(new CustomEvent('preferences:save', {
        bubbles: true,
        detail: { preferences }
      }));
    });
  }

  async function requestJson(path, { method = 'GET', body } = {}) {
    const tokenResponse = await fetch('/api/bootstrap', {
      headers: { accept: 'application/json' }
    });
    if (!tokenResponse.ok) throw new Error('无法获取本地服务授权');
    const { token } = await tokenResponse.json();
    const response = await fetch(path, {
      method,
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'x-desk-token': token
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(payload?.error?.message || `保存失败（${response.status}）`);
    }
    return payload;
  }

  async function savePreferencesToLocalService(preferences) {
    const result = await requestJson('/api/preferences', {
      method: 'PUT',
      body: normalizePreferences(preferences)
    });
    if (!result?.preferences) throw new Error('服务端未返回已保存偏好');
    return result.preferences;
  }

  root.ApplicationDeskPreferences = Object.freeze({
    DEFAULT_PREFERENCES,
    normalizePreferences,
    renderPreferences,
    savePreferencesToLocalService
  });
})(typeof window !== 'undefined' ? window : globalThis);
