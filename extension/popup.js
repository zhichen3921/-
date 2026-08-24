const DESK_ORIGIN = 'http://127.0.0.1:43127';
const TOKEN_KEY = 'extensionToken';
const FIELD_NAMES = Object.freeze(['title', 'company', 'location', 'salary', 'url', 'description']);
const FIELD_LABELS = Object.freeze({
  title: '岗位名称',
  company: '公司',
  location: '地点',
  salary: '薪资',
  url: '岗位链接',
  description: '岗位描述'
});
const VALID_MATCH_ROUTES = new Set(['queue', 'review', 'excluded']);
const BATCH_MAX_ITEMS = 20;

export class DeskApiError extends Error {
  constructor(message, { status = 0, code = 'DESK_REQUEST_FAILED', offline = false } = {}) {
    super(message);
    this.name = 'DeskApiError';
    this.status = status;
    this.code = code;
    this.offline = offline;
  }
}

export function isAllowedBossUrl(value) {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
    return url.protocol === 'https:' && (
      hostname === 'zhipin.com' || hostname.endsWith('.zhipin.com')
    );
  } catch {
    return false;
  }
}

export function derivePopupState({ loading, errorKind, saved, preview } = {}) {
  if (loading) return 'loading';
  if (errorKind === 'service-offline') return 'service-offline';
  if (errorKind) return 'error';
  if (saved) return 'saved';
  if (preview?.duplicate) return 'duplicate';
  if (preview) return 'preview';
  return 'idle';
}

export function deriveConnectionStatus({ token, verified } = {}) {
  if (!String(token || '').trim()) return 'unconfigured';
  return verified === true ? 'verified' : 'configured';
}

export function getSavePolicy(preview, forceSaveChecked) {
  const score = Number(preview?.match?.score);
  const requiresForce = preview?.match?.route === 'excluded' || (Number.isFinite(score) && score < 60);
  return {
    requiresForce,
    canSave: Boolean(preview) && (!requiresForce || forceSaveChecked === true),
    forceSave: requiresForce && forceSaveChecked === true
  };
}

export function makeJobPayload(fields, { forceSave = false, now = new Date().toISOString() } = {}) {
  const payload = {};
  for (const field of FIELD_NAMES) payload[field] = String(fields?.[field] ?? '').trim();
  return {
    ...payload,
    source: 'BOSS直聘（当前页手动采集）',
    verifiedAt: now,
    forceSave: forceSave === true
  };
}

async function parseDeskResponse(response) {
  let body;
  try {
    body = await response.json();
  } catch {
    throw new DeskApiError('投递台返回了无法解析的数据，当前操作未完成。', {
      status: response.status,
      code: 'INVALID_DESK_RESPONSE'
    });
  }
  if (!response.ok) {
    const code = body?.error?.code || 'DESK_REQUEST_FAILED';
    const message = body?.error?.message || `投递台返回 ${response.status}`;
    throw new DeskApiError(message, { status: response.status, code });
  }
  return body;
}

function requirePreviewResponse(body) {
  const normalizedJob = body?.normalizedJob;
  const match = body?.match;
  if (!normalizedJob || typeof normalizedJob !== 'object' || Array.isArray(normalizedJob)
    || !match || typeof match !== 'object'
    || !Number.isFinite(match.score)
    || !VALID_MATCH_ROUTES.has(match.route)) {
    throw new DeskApiError('投递台返回的岗位预览不完整，已拒绝保存。', {
      code: 'INVALID_PREVIEW_RESPONSE'
    });
  }
  return body;
}

function requireSaveResponse(body) {
  if (!body?.job || typeof body.job !== 'object' || !String(body.job.id || '').trim()) {
    throw new DeskApiError('投递台没有确认岗位已保存，当前操作按失败处理。', {
      code: 'INVALID_SAVE_RESPONSE'
    });
  }
  return body;
}

function requireBatchPreviewResponse(body) {
  if (!Array.isArray(body?.items) || body.items.length > BATCH_MAX_ITEMS) {
    throw new DeskApiError('投递台返回的批量预览不完整，已拒绝继续。', {
      code: 'INVALID_BATCH_PREVIEW_RESPONSE'
    });
  }
  for (const item of body.items) {
    if (!Number.isInteger(item?.index)) {
      throw new DeskApiError('投递台返回的批量预览缺少岗位序号。', {
        code: 'INVALID_BATCH_PREVIEW_RESPONSE'
      });
    }
    if (item.error) {
      if (!String(item.error.code || '').trim() || !String(item.error.message || '').trim()) {
        throw new DeskApiError('投递台返回了无法识别的批量错误。', {
          code: 'INVALID_BATCH_PREVIEW_RESPONSE'
        });
      }
      continue;
    }
    try {
      requirePreviewResponse(item);
    } catch {
      throw new DeskApiError('投递台返回的批量预览不完整，已拒绝保存。', {
        code: 'INVALID_BATCH_PREVIEW_RESPONSE'
      });
    }
  }
  return body;
}

function requireBatchSaveResponse(body) {
  if (!Array.isArray(body?.results) || body.results.length > BATCH_MAX_ITEMS) {
    throw new DeskApiError('投递台没有确认批量保存结果，当前操作按失败处理。', {
      code: 'INVALID_BATCH_SAVE_RESPONSE'
    });
  }
  for (const result of body.results) {
    if (!result?.job || typeof result.job !== 'object' || !String(result.job.id || '').trim()) {
      throw new DeskApiError('投递台返回的批量保存结果缺少岗位编号。', {
        code: 'INVALID_BATCH_SAVE_RESPONSE'
      });
    }
  }
  return body;
}

export function createDeskApi({ fetchImpl = globalThis.fetch, token, origin = DESK_ORIGIN } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  const extensionToken = String(token || '').trim();
  if (!extensionToken) throw new TypeError('A paired extension token is required');

  async function post(path, payload, validateResponse) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), 6000) : null;
    try {
      const response = await fetchImpl(`${origin}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-desk-extension-token': extensionToken
        },
        body: JSON.stringify(payload),
        signal: controller?.signal
      });
      const body = await parseDeskResponse(response);
      return validateResponse(body);
    } catch (error) {
      if (error instanceof DeskApiError) throw error;
      throw new DeskApiError('无法连接本地投递台，请先启动投递台服务。', {
        code: 'DESK_OFFLINE',
        offline: true
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  return {
    preview: (job) => post('/api/jobs/preview', job, requirePreviewResponse),
    save: (job) => post('/api/jobs', job, requireSaveResponse),
    batchPreview: (jobs) => post('/api/jobs/batch-preview', { jobs }, requireBatchPreviewResponse),
    batchSave: (jobs, { forceSaveExcluded = false } = {}) => post(
      '/api/jobs/batch',
      { jobs, forceSaveExcluded: forceSaveExcluded === true },
      requireBatchSaveResponse
    )
  };
}

function chromeStorageGet(key) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get([key], (result) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(result?.[key]);
    });
  });
}

function chromeStorageSet(value) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(value, () => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve();
    });
  });
}

function chromeStorageRemove(key, storageArea = globalThis.chrome?.storage?.local) {
  return new Promise((resolve, reject) => {
    if (!storageArea || typeof storageArea.remove !== 'function') {
      reject(new Error('Chrome extension storage is unavailable'));
      return;
    }
    storageArea.remove([key], () => {
      const error = globalThis.chrome?.runtime?.lastError;
      if (error) reject(new Error(error.message));
      else resolve();
    });
  });
}

export async function clearInvalidExtensionToken(error, storageArea = globalThis.chrome?.storage?.local) {
  if (error?.code !== 'INVALID_EXTENSION_TOKEN') return false;
  await chromeStorageRemove(TOKEN_KEY, storageArea);
  return true;
}

function queryActiveTab() {
  return new Promise((resolve, reject) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(tabs?.[0] || null);
    });
  });
}

function executeScript(details) {
  return new Promise((resolve, reject) => {
    chrome.scripting.executeScript(details, (results) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(results || []);
    });
  });
}

function initializePopup() {
  const elements = {
    pairPanel: document.querySelector('#pair-panel'),
    collectorPanel: document.querySelector('#collector-panel'),
    pairToken: document.querySelector('#pair-token'),
    saveToken: document.querySelector('#save-token'),
    collectButton: document.querySelector('#collect-button'),
    collectPageButton: document.querySelector('#collect-page-button'),
    idleView: document.querySelector('#idle-view'),
    loadingView: document.querySelector('#loading-view'),
    batchView: document.querySelector('#batch-view'),
    batchCount: document.querySelector('#batch-count'),
    batchSummary: document.querySelector('#batch-summary'),
    batchList: document.querySelector('#batch-list'),
    batchSelectAll: document.querySelector('#batch-select-all'),
    batchForceSaveWrap: document.querySelector('#batch-force-save-wrap'),
    batchForceSave: document.querySelector('#batch-force-save'),
    batchSave: document.querySelector('#batch-save'),
    batchBack: document.querySelector('#batch-back'),
    jobForm: document.querySelector('#job-form'),
    messageView: document.querySelector('#message-view'),
    messageGlyph: document.querySelector('#message-glyph'),
    messageTitle: document.querySelector('#message-title'),
    messageCopy: document.querySelector('#message-copy'),
    resultBanner: document.querySelector('#result-banner'),
    resultLabel: document.querySelector('#result-label'),
    resultDetail: document.querySelector('#result-detail'),
    scoreValue: document.querySelector('#score-value'),
    missingFields: document.querySelector('#missing-fields'),
    matchReasons: document.querySelector('#match-reasons'),
    forceSaveWrap: document.querySelector('#force-save-wrap'),
    forceSave: document.querySelector('#force-save'),
    previewButton: document.querySelector('#preview-button'),
    saveButton: document.querySelector('#save-button'),
    collectAgain: document.querySelector('#collect-again'),
    openOptions: document.querySelector('#open-options'),
    connectionDot: document.querySelector('#connection-dot'),
    liveStatus: document.querySelector('#live-status')
  };

  const state = {
    token: '',
    connectionVerified: false,
    preview: null,
    batchItems: [],
    missingFields: [],
    dirty: false
  };

  function announce(message) {
    elements.liveStatus.textContent = '';
    setTimeout(() => { elements.liveStatus.textContent = message; }, 0);
  }

  function showOnly(view) {
    for (const candidate of [elements.idleView, elements.loadingView, elements.batchView, elements.jobForm, elements.messageView]) {
      candidate.hidden = candidate !== view;
    }
  }

  function renderConnectionStatus(status = deriveConnectionStatus({
    token: state.token,
    verified: state.connectionVerified
  })) {
    if (status === 'verified') {
      elements.connectionDot.className = 'connection-dot online';
      elements.connectionDot.title = '已验证连接到本地投递台';
      return;
    }
    if (status === 'configured') {
      elements.connectionDot.className = 'connection-dot';
      elements.connectionDot.title = '已配置令牌，等待首次连接验证';
      return;
    }
    elements.connectionDot.className = 'connection-dot offline';
    elements.connectionDot.title = status === 'offline'
      ? '本地投递台暂时无法连接'
      : '尚未配置投递台连接';
  }

  function showCollector({ verified = false } = {}) {
    state.connectionVerified = verified;
    elements.pairPanel.hidden = true;
    elements.collectorPanel.hidden = false;
    renderConnectionStatus();
    showOnly(elements.idleView);
  }

  function showPairing(message = '') {
    elements.pairPanel.hidden = false;
    elements.collectorPanel.hidden = true;
    state.connectionVerified = false;
    renderConnectionStatus('unconfigured');
    if (message) announce(message);
  }

  function formFields() {
    return Object.fromEntries(FIELD_NAMES.map((name) => [
      name,
      elements.jobForm.elements.namedItem(name)?.value || ''
    ]));
  }

  function fillForm(job) {
    for (const name of FIELD_NAMES) {
      const field = elements.jobForm.elements.namedItem(name);
      if (field) field.value = job?.[name] || '';
    }
    state.missingFields = Array.isArray(job?.missingFields) ? job.missingFields : [];
    renderMissingFields();
  }

  function renderMissingFields() {
    elements.missingFields.replaceChildren();
    elements.missingFields.hidden = state.missingFields.length === 0;
    for (const field of state.missingFields) {
      const chip = document.createElement('span');
      chip.textContent = `需补充：${FIELD_LABELS[field] || field}`;
      elements.missingFields.append(chip);
    }
  }

  function recommendationLabel(match) {
    if (match?.route === 'queue') return '进入主队列';
    if (match?.route === 'review') return '进入待复核';
    return '低于入队线';
  }

  function renderPreview(preview) {
    state.connectionVerified = true;
    renderConnectionStatus();
    state.preview = preview;
    state.dirty = false;
    const match = preview.match || {};
    const score = Number.isFinite(Number(match.score)) ? Number(match.score) : 0;
    elements.resultBanner.dataset.route = match.route || 'review';
    elements.resultLabel.textContent = preview.duplicate ? '发现重复岗位' : recommendationLabel(match);
    elements.resultDetail.textContent = preview.duplicate
      ? `投递台已有：${preview.duplicate.title || '同一岗位'} · ${preview.duplicate.status || '未沟通'}`
      : String(match.recommendation || '请确认岗位字段和匹配理由');
    elements.scoreValue.textContent = String(score);

    const reasons = Array.isArray(match.reasons) ? match.reasons.slice(0, 5) : [];
    elements.matchReasons.replaceChildren();
    elements.matchReasons.hidden = reasons.length === 0;
    for (const reason of reasons) {
      const chip = document.createElement('span');
      chip.textContent = String(reason);
      elements.matchReasons.append(chip);
    }

    const policy = getSavePolicy(preview, elements.forceSave.checked);
    elements.forceSaveWrap.hidden = !policy.requiresForce;
    elements.saveButton.disabled = !policy.canSave;
    elements.saveButton.textContent = preview.duplicate ? '更新已有记录' : '加入投递队列';
    showOnly(elements.jobForm);
    announce(`${elements.resultLabel.textContent}，匹配分 ${score}`);
  }

  function markPreviewStale() {
    if (!state.preview) return;
    state.dirty = true;
    elements.resultLabel.textContent = '内容已修改';
    elements.resultDetail.textContent = '重新评估后才能保存';
    elements.scoreValue.textContent = '—';
    elements.saveButton.disabled = true;
    elements.forceSaveWrap.hidden = true;
  }

  function showMessage({ kind = 'saved', title, copy }) {
    elements.messageGlyph.textContent = kind === 'error' ? '!' : kind === 'offline' ? '⌁' : '✓';
    elements.messageTitle.textContent = title;
    elements.messageCopy.textContent = copy;
    if (kind === 'offline') {
      state.connectionVerified = false;
      renderConnectionStatus('offline');
    } else if (kind === 'saved') {
      state.connectionVerified = true;
      renderConnectionStatus();
    } else {
      renderConnectionStatus();
    }
    showOnly(elements.messageView);
    announce(`${title}。${copy}`);
  }

  async function handleError(error) {
    if (error?.offline) {
      showMessage({
        kind: 'offline',
        title: '投递台还没启动',
        copy: '请先打开本地投递台，再回来重试。当前岗位没有被保存。'
      });
      return;
    }
    if (error?.code === 'INVALID_EXTENSION_TOKEN') {
      state.token = '';
      state.connectionVerified = false;
      try {
        await clearInvalidExtensionToken(error);
      } catch {
        // The in-memory token is still discarded; pairing is required again.
      }
      showPairing('配对令牌已失效，请从投递台重新复制。');
      return;
    }
    showMessage({
      kind: 'error',
      title: '这次没有采集成功',
      copy: String(error?.message || '请确认当前是 BOSS 岗位页面后重试。')
    });
  }

  async function requestPreview() {
    if (!elements.jobForm.reportValidity()) return;
    elements.previewButton.disabled = true;
    elements.saveButton.disabled = true;
    try {
      const api = createDeskApi({ token: state.token });
      const preview = await api.preview(makeJobPayload(formFields()));
      renderPreview(preview);
    } catch (error) {
      await handleError(error);
    } finally {
      elements.previewButton.disabled = false;
    }
  }

  async function collectCurrentJob() {
    showOnly(elements.loadingView);
    announce('正在读取当前 BOSS 岗位');
    try {
      const tab = await queryActiveTab();
      if (!tab?.id || !isAllowedBossUrl(tab.url)) {
        throw new DeskApiError('请先打开一个 BOSS 直聘岗位，再点击扩展图标。', {
          code: 'NOT_BOSS_PAGE'
        });
      }
      await executeScript({ target: { tabId: tab.id }, files: ['extract-current-job.js'] });
      const results = await executeScript({
        target: { tabId: tab.id },
        func: () => globalThis.BossJobCollectorExtract(document, location)
      });
      const extracted = results?.[0]?.result;
      if (!extracted || typeof extracted !== 'object') {
        throw new DeskApiError('当前页面没有可预览的岗位信息。', { code: 'EMPTY_EXTRACTION' });
      }
      fillForm(extracted);
      showOnly(elements.jobForm);
      await requestPreview();
    } catch (error) {
      await handleError(error);
    }
  }

  function batchRouteLabel(match) {
    if (match?.route === 'queue') return '推荐入队';
    if (match?.route === 'review') return '建议复核';
    return '低匹配';
  }

  function selectedBatchItems() {
    return state.batchItems.filter((item) => item.selected && !item.error);
  }

  function updateBatchSelectionState() {
    const selected = selectedBatchItems();
    const selectedExcluded = selected.some((item) => item.match?.route === 'excluded');
    const eligible = state.batchItems.filter((item) => !item.error && item.match?.route !== 'excluded');
    elements.batchForceSaveWrap.hidden = !selectedExcluded;
    elements.batchSave.disabled = selected.length === 0
      || (selectedExcluded && !elements.batchForceSave.checked);
    elements.batchSave.textContent = selected.length ? `保存所选 ${selected.length} 份` : '保存所选岗位';
    elements.batchSummary.textContent = selected.length
      ? `已选 ${selected.length} 份${selectedExcluded ? ' · 含低匹配' : ''}`
      : '请至少勾选 1 份';
    elements.batchSelectAll.checked = eligible.length > 0 && eligible.every((item) => item.selected);
  }

  function renderBatchPreview(response, totalVisible) {
    state.connectionVerified = true;
    renderConnectionStatus();
    state.batchItems = response.items.map((item) => ({
      ...item,
      selected: Object.hasOwn(item, 'selected')
        ? item.selected
        : !item.error && item.match?.route !== 'excluded'
    }));
    elements.batchList.replaceChildren();
    elements.batchCount.textContent = `${state.batchItems.length}/${BATCH_MAX_ITEMS}`;
    for (const item of state.batchItems) {
      const row = document.createElement('label');
      row.className = 'batch-item';
      if (item.error) row.classList.add('is-error');
      if (item.match?.route === 'excluded') row.classList.add('is-excluded');

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = item.selected;
      checkbox.disabled = Boolean(item.error);
      checkbox.addEventListener('change', () => {
        item.selected = checkbox.checked;
        updateBatchSelectionState();
      });

      const main = document.createElement('div');
      main.className = 'batch-item-main';
      const title = document.createElement('div');
      title.className = 'batch-item-title';
      title.textContent = item.normalizedJob?.title || `第 ${Number(item.index) + 1} 份岗位`;
      main.append(title);

      const meta = document.createElement('div');
      meta.className = item.error ? 'batch-item-error' : 'batch-item-meta';
      meta.textContent = item.error
        ? item.error.message
        : [item.normalizedJob.company, item.normalizedJob.location, item.normalizedJob.salary]
          .filter(Boolean)
          .join(' · ') || '字段较少，请到投递台补充';
      main.append(meta);

      const side = document.createElement('div');
      if (item.error) {
        side.className = 'batch-item-route';
        side.textContent = '无法评估';
      } else {
        const score = document.createElement('div');
        score.className = 'batch-item-score';
        score.textContent = String(Number(item.match.score));
        const route = document.createElement('div');
        route.className = 'batch-item-route';
        route.textContent = item.duplicate
          ? `已有记录 · ${item.duplicate.status || '未沟通'}`
          : batchRouteLabel(item.match);
        side.append(score, route);
      }

      row.append(checkbox, main, side);
      elements.batchList.append(row);
    }
    if (Number(totalVisible) > state.batchItems.length) {
      elements.batchSummary.textContent = `当前页 ${totalVisible} 份，已取前 ${state.batchItems.length} 份`;
    }
    elements.batchForceSave.checked = false;
    showOnly(elements.batchView);
    updateBatchSelectionState();
    announce(`已评估 ${state.batchItems.length} 份可见岗位`);
  }

  async function collectCurrentPageJobs() {
    showOnly(elements.loadingView);
    announce('正在读取当前页面可见岗位');
    try {
      const tab = await queryActiveTab();
      if (!tab?.id || !isAllowedBossUrl(tab.url)) {
        throw new DeskApiError('请先打开 BOSS 直聘岗位搜索结果页，再点击批量采集。', {
          code: 'NOT_BOSS_PAGE'
        });
      }
      await executeScript({ target: { tabId: tab.id }, files: ['extract-current-page-jobs.js'] });
      const results = await executeScript({
        target: { tabId: tab.id },
        func: () => globalThis.BossJobCollectorExtractPage(document, location)
      });
      const extracted = results?.[0]?.result;
      if (!extracted || !Array.isArray(extracted.jobs) || extracted.jobs.length === 0) {
        throw new DeskApiError('当前页面没有可批量评估的可见岗位。', { code: 'EMPTY_BATCH_EXTRACTION' });
      }
      const api = createDeskApi({ token: state.token });
      const response = await api.batchPreview(
        extracted.jobs.map((job) => makeJobPayload(job))
      );
      renderBatchPreview(response, extracted.totalVisible);
    } catch (error) {
      await handleError(error);
    }
  }

  async function saveBatchJobs() {
    const selected = selectedBatchItems();
    const forceSaveExcluded = elements.batchForceSave.checked;
    if (selected.length === 0 || (selected.some((item) => item.match?.route === 'excluded') && !forceSaveExcluded)) {
      return;
    }
    elements.batchSave.disabled = true;
    try {
      const api = createDeskApi({ token: state.token });
      const result = await api.batchSave(
        selected.map((item) => makeJobPayload(item.normalizedJob, { forceSave: forceSaveExcluded })),
        { forceSaveExcluded }
      );
      showMessage({
        title: `已保存 ${result.results.length} 份岗位`,
        copy: `新增 ${result.created} 份，更新 ${result.updated} 份。没有自动发送消息，请到投递台审核后自行沟通。`
      });
    } catch (error) {
      await handleError(error);
    } finally {
      updateBatchSelectionState();
    }
  }

  async function saveCurrentJob() {
    if (state.dirty || !state.preview || !elements.jobForm.reportValidity()) return;
    const policy = getSavePolicy(state.preview, elements.forceSave.checked);
    if (!policy.canSave) return;
    elements.saveButton.disabled = true;
    try {
      const api = createDeskApi({ token: state.token });
      const result = await api.save(makeJobPayload(formFields(), { forceSave: policy.forceSave }));
      state.connectionVerified = true;
      const duplicate = result.duplicate;
      showMessage({
        title: duplicate ? '已有岗位已更新' : '已加入投递台',
        copy: duplicate
          ? `保留原沟通状态：${duplicate.status || '未沟通'}。你可以到投递台继续查看。`
          : '没有自动发送任何消息。请到投递台审核话术后自行沟通。'
      });
    } catch (error) {
      await handleError(error);
    } finally {
      elements.saveButton.disabled = false;
    }
  }

  async function savePairToken() {
    const token = elements.pairToken.value.trim();
    if (token.length < 24) {
      elements.pairToken.setCustomValidity('令牌格式不完整，请重新复制。');
      elements.pairToken.reportValidity();
      return;
    }
    elements.pairToken.setCustomValidity('');
    await chromeStorageSet({ [TOKEN_KEY]: token });
    state.token = token;
    state.connectionVerified = false;
    elements.pairToken.value = '';
    showCollector({ verified: false });
    announce('令牌已配置，首次预览成功后确认连接');
  }

  function openDesk() {
    chrome.tabs.create({ url: `${DESK_ORIGIN}/` });
  }

  elements.saveToken.addEventListener('click', () => savePairToken().catch(handleError));
  elements.collectButton.addEventListener('click', collectCurrentJob);
  elements.collectPageButton.addEventListener('click', collectCurrentPageJobs);
  elements.jobForm.addEventListener('submit', (event) => {
    event.preventDefault();
    requestPreview();
  });
  elements.jobForm.addEventListener('input', (event) => {
    if (event.target === elements.forceSave) {
      const policy = getSavePolicy(state.preview, elements.forceSave.checked);
      elements.saveButton.disabled = !policy.canSave || state.dirty;
    } else {
      markPreviewStale();
    }
  });
  elements.saveButton.addEventListener('click', saveCurrentJob);
  elements.collectAgain.addEventListener('click', () => {
    state.preview = null;
    state.batchItems = [];
    state.dirty = false;
    elements.forceSave.checked = false;
    elements.batchForceSave.checked = false;
    showOnly(elements.idleView);
  });
  elements.batchSelectAll.addEventListener('change', () => {
    for (const item of state.batchItems) {
      if (!item.error && item.match?.route !== 'excluded') item.selected = elements.batchSelectAll.checked;
    }
    renderBatchPreview({ items: state.batchItems }, state.batchItems.length);
  });
  elements.batchForceSave.addEventListener('change', updateBatchSelectionState);
  elements.batchSave.addEventListener('click', saveBatchJobs);
  elements.batchBack.addEventListener('click', () => {
    state.batchItems = [];
    elements.batchForceSave.checked = false;
    showOnly(elements.idleView);
  });
  elements.openOptions.addEventListener('click', () => chrome.runtime.openOptionsPage());
  for (const button of document.querySelectorAll('[data-open-desk]')) {
    button.addEventListener('click', openDesk);
  }

  chromeStorageGet(TOKEN_KEY)
    .then((token) => {
      state.token = String(token || '').trim();
      if (state.token) showCollector({ verified: false });
      else showPairing();
    })
    .catch(handleError);
}

if (typeof document !== 'undefined' && typeof chrome !== 'undefined') {
  document.addEventListener('DOMContentLoaded', initializePopup, { once: true });
}
