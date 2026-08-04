const TOKEN_KEY = 'extensionToken';
const DESK_URL = 'http://127.0.0.1:43127/';

function storageGet(key) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get([key], (result) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(result?.[key]);
    });
  });
}

function storageSet(value) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(value, () => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve();
    });
  });
}

function storageRemove(key) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.remove(key, () => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve();
    });
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  const input = document.querySelector('#extension-token');
  const status = document.querySelector('#status');
  const existing = String(await storageGet(TOKEN_KEY) || '');
  status.textContent = existing ? '已保存配对令牌，可以回到 BOSS 岗位页使用扩展。' : '尚未连接投递台。';

  document.querySelector('#save-token').addEventListener('click', async () => {
    const token = input.value.trim();
    if (token.length < 24) {
      input.setCustomValidity('令牌格式不完整，请从投递台重新复制。');
      input.reportValidity();
      return;
    }
    input.setCustomValidity('');
    await storageSet({ [TOKEN_KEY]: token });
    input.value = '';
    status.textContent = '连接令牌已保存。';
  });

  document.querySelector('#clear-token').addEventListener('click', async () => {
    await storageRemove(TOKEN_KEY);
    input.value = '';
    status.textContent = '连接已清除。重新使用前需要粘贴新令牌。';
  });

  document.querySelector('#open-desk').addEventListener('click', () => {
    chrome.tabs.create({ url: DESK_URL });
  });
});
