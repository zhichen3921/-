import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

test('manifest uses the exact minimal MV3 permission allowlist', async () => {
  const manifest = JSON.parse(await readFile(resolve('extension/manifest.json'), 'utf8'));

  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual([...manifest.permissions].sort(), ['activeTab', 'scripting', 'storage']);
  assert.deepEqual(manifest.host_permissions, ['http://127.0.0.1:43127/*']);
  assert.equal(manifest.action.default_popup, 'popup.html');
  assert.equal(manifest.options_page, 'options.html');
  assert.equal(manifest.content_scripts, undefined);
  assert.equal(manifest.background, undefined);

  const serialized = JSON.stringify(manifest).toLowerCase();
  for (const forbidden of ['cookies', 'history', 'debugger', '*://*.zhipin.com', 'https://www.zhipin.com']) {
    assert.equal(serialized.includes(forbidden), false, `manifest must not contain ${forbidden}`);
  }

  for (const size of ['16', '32', '48', '128']) {
    assert.equal(manifest.icons[size], `icons/icon-${size}.png`);
    await access(resolve('extension', manifest.icons[size]));
  }
});
