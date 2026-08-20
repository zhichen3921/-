(function exposeApplicationDeskExtensionCenter(root) {
  function escapeHtml(value = '') {
    return String(value).replace(/[&<>'"]/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
    })[char]);
  }

  function extensionStatus(extension = {}) {
    const heartbeat = extension.lastHeartbeatAt || extension.heartbeatAt;
    if (extension.connected === true || (heartbeat && Number.isFinite(Date.parse(heartbeat)))) {
      return ['已连接', 'connected'];
    }
    if (extension.paired === true) return ['已配对，等待连接', 'paired'];
    return ['尚未配对', 'unpaired'];
  }

  function renderExtensionCenter(container, {
    serverMode = false,
    extension = {},
    pairingToken = ''
  } = {}) {
    if (!container) return;
    const [statusLabel, statusClass] = extensionStatus(extension);
    const heartbeat = extension.lastHeartbeatAt || extension.heartbeatAt;
    const detail = heartbeat
      ? `最近连接：${new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(heartbeat))}`
      : '在 BOSS 岗位详情页主动点击扩展，采集后仍需人工确认保存。';

    container.innerHTML = `<div class="update-masthead">
      <div>
        <span class="index-label">04 / BROWSER EXTENSION</span>
        <h2>主动采集，<em>确认后保存。</em></h2>
        <p>浏览器扩展只读取当前打开的 BOSS 岗位详情，不自动登录、不自动投递，也不会读取 Cookie 或聊天记录。</p>
      </div>
      <span class="mode-stamp ${serverMode ? 'connected' : ''}">${serverMode ? 'LOCAL API · READY' : 'FILE MODE · LOCAL ONLY'}</span>
    </div>
    <section class="update-panel source-panel">
      <div class="panel-title"><span>01</span><div><strong>扩展连接状态</strong><p>需要本地服务版才能连接浏览器扩展</p></div></div>
      <div class="source-channel"><i class="boss" aria-hidden="true"></i><div><strong>${escapeHtml(statusLabel)}</strong><p>${escapeHtml(detail)}</p></div><b class="extension-state ${statusClass}">${serverMode ? '本地服务' : '需本地服务'}</b></div>
      <div class="extension-pairing-controls">
        <button class="button secondary" type="button" data-pair-extension ${serverMode ? '' : 'disabled'}>生成扩展配对令牌</button>
        ${pairingToken
          ? `<div class="extension-token-box"><code data-extension-token>${escapeHtml(pairingToken)}</code><button type="button" data-copy-extension-token>复制令牌</button></div>`
          : '<p class="pairing-privacy">令牌仅在你点击后生成，不会在页面加载时暴露。</p>'}
      </div>
    </section>`;

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

  root.ApplicationDeskExtensionCenter = Object.freeze({ renderExtensionCenter });
})(typeof window !== 'undefined' ? window : globalThis);
