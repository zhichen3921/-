(function exposeApplicationDeskUpdateCenter(root) {
  const KNOWN_STATUSES = new Set(['idle', 'running', 'success', 'failed', 'error']);
  const LOG_STATUSES = new Set(['success', 'running', 'failed', 'error', 'unknown']);

  function cleanStringList(value) {
    return Array.isArray(value)
      ? [...new Set(value.filter((item) => typeof item === 'string').map((item) => item.trim()).filter(Boolean))]
      : [];
  }

  function normalizeExtension(input = {}) {
    const extension = input && typeof input === 'object' ? input : {};
    const heartbeat = typeof extension.lastHeartbeatAt === 'string'
      ? extension.lastHeartbeatAt
      : typeof extension.heartbeatAt === 'string' ? extension.heartbeatAt : null;
    const hasHeartbeat = heartbeat && Number.isFinite(Date.parse(heartbeat));
    return {
      status: hasHeartbeat || extension.connected === true
        ? 'connected'
        : extension.paired === true ? 'paired' : 'unpaired',
      lastHeartbeatAt: heartbeat,
      pairedAt: typeof extension.pairedAt === 'string' ? extension.pairedAt : null
    };
  }

  function statusForLog(entry = {}) {
    if (LOG_STATUSES.has(entry.status)) return entry.status === 'error' ? 'failed' : entry.status;
    if (entry.error) return 'failed';
    return 'unknown';
  }

  function normalizeUpdates(input = {}, extensionInput) {
    const logs = Array.isArray(input.logs) ? input.logs.filter((entry) => entry && typeof entry === 'object') : [];
    const failedFromLogs = logs
      .filter((entry) => statusForLog(entry) === 'failed')
      .map((entry) => entry.source || entry.label)
      .filter(Boolean);
    return {
      status: KNOWN_STATUSES.has(input.status) ? input.status : 'idle',
      lastSuccessAt: typeof input.lastSuccessAt === 'string' ? input.lastSuccessAt : null,
      lastAttemptAt: typeof input.lastAttemptAt === 'string' ? input.lastAttemptAt : null,
      nextRunAt: typeof input.nextRunAt === 'string' ? input.nextRunAt : null,
      todayDiscovered: Number.isFinite(Number(input.todayDiscovered))
        ? Math.max(0, Number(input.todayDiscovered))
        : 0,
      failedSources: [...new Set([...cleanStringList(input.failedSources), ...failedFromLogs])],
      logs,
      scheduleEnabled: input.scheduleEnabled === true,
      scheduleTime: typeof input.scheduleTime === 'string' ? input.scheduleTime : '09:00',
      extension: normalizeExtension(extensionInput || input.extension)
    };
  }

  function latestSummary(updates) {
    const log = [...updates.logs].reverse().find((entry) => (
      entry.summary || ['queued', 'review', 'excluded', 'duplicates'].some((key) => key in entry)
    ));
    const summary = log?.summary || log || {};
    return {
      queued: Number(summary.queued) || 0,
      review: Number(summary.review) || 0,
      excluded: Number(summary.excluded) || 0,
      duplicates: Number(summary.duplicates) || 0
    };
  }

  function formatDateTime(value, fallback = '尚未提供') {
    if (!value) return fallback;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return new Intl.DateTimeFormat('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).format(date);
  }

  function escapeHtml(value = '') {
    return String(value).replace(/[&<>'"]/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
    })[char]);
  }

  function logRows(logs) {
    if (!logs.length) {
      return '<div class="update-empty-log">还没有更新记录。只有真实执行过的来源和结果会出现在这里。</div>';
    }
    return [...logs].reverse().slice(0, 8).map((entry) => {
      const status = statusForLog(entry);
      const source = entry.source || entry.label || '未标注来源';
      const detail = entry.message || entry.error || entry.detail || '没有提供执行详情';
      const time = entry.at || entry.createdAt || entry.timestamp;
      const statusLabel = {
        success: '成功', running: '进行中', failed: '失败', unknown: '未知'
      }[status];
      return `<div class="update-log-row">
        <i class="${status}" aria-hidden="true"></i>
        <strong>${escapeHtml(source)}</strong>
        <span>${escapeHtml(detail)}</span>
        <small>${statusLabel}</small>
        <time>${escapeHtml(formatDateTime(time, '时间未知'))}</time>
      </div>`;
    }).join('');
  }

  function extensionCopy(extension, pairingToken) {
    if (pairingToken) {
      return {
        label: '已生成配对令牌，等待扩展连接',
        detail: '令牌仅在本次页面会话中显示；安装扩展后粘贴完成配对。',
        className: 'generated'
      };
    }
    if (extension.status === 'connected') {
      return {
        label: '扩展已连接',
        detail: `最近心跳：${formatDateTime(extension.lastHeartbeatAt, '服务端确认已连接')}`,
        className: 'connected'
      };
    }
    if (extension.status === 'paired') {
      return {
        label: '已配对，等待扩展心跳',
        detail: '服务端已有配对信号，但暂未收到可验证的连接心跳。',
        className: 'paired'
      };
    }
    return {
      label: '扩展未配对',
      detail: '需要时再手动生成令牌；页面加载不会自动创建或暴露令牌。',
      className: 'unpaired'
    };
  }

  function renderUpdateCenter(container, {
    updates: inputUpdates,
    jobs = [],
    serverMode = false,
    extension,
    pairingToken = ''
  } = {}) {
    if (!container) return;
    const updates = normalizeUpdates(inputUpdates, extension);
    const summary = latestSummary(updates);
    const activeJobs = jobs.filter((job) => job.active !== false).length;
    const extensionState = extensionCopy(updates.extension, pairingToken);
    const statusLabel = {
      idle: '等待真实更新',
      running: '正在更新',
      success: '最近成功',
      failed: '最近失败',
      error: '最近失败'
    }[updates.status];

    container.innerHTML = `<div class="update-masthead">
      <div>
        <span class="index-label">04 / UPDATE STATION</span>
        <h2>岗位更新，<em>有迹可循。</em></h2>
        <p>公开来源与登录后的 BOSS 当前岗位分开采集。没有明确结果的任务会标为“未知”，不会伪装成成功。</p>
      </div>
      <button class="update-run-button" type="button" data-run-update ${serverMode && updates.status !== 'running' ? '' : 'disabled'}>
        <span>${updates.status === 'running' ? '更新中' : '立即更新'}</span><b aria-hidden="true">↗</b>
      </button>
    </div>

    <div class="update-status-grid">
      <article class="update-status-card lead">
        <span>LAST SUCCESS</span>
        <strong>${escapeHtml(formatDateTime(updates.lastSuccessAt, '尚未成功'))}</strong>
        <p><i class="${updates.status}" aria-hidden="true"></i>${escapeHtml(statusLabel)}</p>
      </article>
      <article class="update-status-card"><span>今日发现</span><strong>${updates.todayDiscovered}</strong><p>由服务端真实更新状态提供</p></article>
      <article class="update-status-card"><span>主队列新增</span><strong>${summary.queued}</strong><p>达到当前主队列阈值</p></article>
      <article class="update-status-card"><span>进入待复核</span><strong>${summary.review}</strong><p>信息不足或 60–74 分</p></article>
      <article class="update-status-card"><span>排除 / 重复</span><strong>${summary.excluded + summary.duplicates}</strong><p>不写入主队列</p></article>
    </div>

    <div class="update-layout">
      <section class="update-panel schedule-panel">
        <div class="panel-title"><span>01</span><div><strong>每日更新计划</strong><p>北京时间，每天一次</p></div></div>
        <div class="schedule-clock"><small>DAILY</small><strong>${escapeHtml(updates.scheduleTime)}</strong><span>Asia / Shanghai</span></div>
        <dl class="schedule-facts">
          <div><dt>下次运行</dt><dd>${escapeHtml(formatDateTime(updates.nextRunAt, '等待调度器提供'))}</dd></div>
          <div><dt>上次尝试</dt><dd>${escapeHtml(formatDateTime(updates.lastAttemptAt, '尚未尝试'))}</dd></div>
        </dl>
        <div class="truth-note ${updates.scheduleEnabled ? 'ready' : ''}">
          <i aria-hidden="true"></i><span>${updates.scheduleEnabled ? '调度任务已启用' : '尚无已启用的调度信号'}</span>
        </div>
      </section>

      <section class="update-panel source-panel">
        <div class="panel-title"><span>02</span><div><strong>采集通道</strong><p>公开搜索 + 当前页主动采集</p></div></div>
        <div class="source-channel"><i class="public" aria-hidden="true"></i><div><strong>公开招聘来源</strong><p>公司官网、学校就业网和公开招聘页</p></div><b>${serverMode ? '本地服务在线' : '需本地服务'}</b></div>
        <div class="source-channel"><i class="boss" aria-hidden="true"></i><div><strong>BOSS 当前岗位</strong><p>${escapeHtml(extensionState.detail)}</p></div><b class="extension-state ${extensionState.className}">${escapeHtml(extensionState.label)}</b></div>
        <div class="extension-pairing-controls">
          <button class="button secondary" type="button" data-pair-extension ${serverMode ? '' : 'disabled'}>生成扩展配对令牌</button>
          ${pairingToken ? `<div class="extension-token-box"><code data-extension-token>${escapeHtml(pairingToken)}</code><button type="button" data-copy-extension-token>复制令牌</button></div>` : '<p class="pairing-privacy">令牌仅在你点击后生成，不会在页面加载时暴露。</p>'}
        </div>
      </section>

      <section class="update-panel inventory-panel">
        <div class="panel-title"><span>03</span><div><strong>本地库存</strong><p>不读取 Cookie、验证码或聊天记录</p></div></div>
        <div class="inventory-number"><strong>${jobs.length}</strong><span>全部岗位</span></div>
        <div class="inventory-number"><strong>${activeJobs}</strong><span>仍标记招聘中</span></div>
      </section>
    </div>

    <section class="failed-sources-panel">
      <div><span>FAILED SOURCES</span><strong>失败来源</strong></div>
      ${updates.failedSources.length
        ? `<ul>${updates.failedSources.map((source) => `<li>${escapeHtml(source)}</li>`).join('')}</ul>`
        : '<p>当前没有服务端报告的失败来源。</p>'}
    </section>

    <section class="update-history">
      <div class="panel-title"><span>LOG</span><div><strong>最近更新记录</strong><p>失败会保留旧数据，并在此显示原因。</p></div></div>
      <div class="update-log">${logRows(updates.logs)}</div>
    </section>`;

    container.querySelector('[data-run-update]')?.addEventListener('click', () => {
      container.dispatchEvent(new CustomEvent('updates:run', { bubbles: true }));
    });
    container.querySelector('[data-pair-extension]')?.addEventListener('click', () => {
      container.dispatchEvent(new CustomEvent('extension:pair', { bubbles: true }));
    });
    container.querySelector('[data-copy-extension-token]')?.addEventListener('click', () => {
      container.dispatchEvent(new CustomEvent('extension:copy', {
        bubbles: true,
        detail: { token: pairingToken }
      }));
    });
  }

  root.ApplicationDeskUpdateCenter = Object.freeze({
    normalizeUpdates,
    renderUpdateCenter,
    statusForLog
  });
})(typeof window !== 'undefined' ? window : globalThis);
