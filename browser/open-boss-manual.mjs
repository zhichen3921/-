import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const profilePath = resolve('.boss-edge-profile');
const child = spawn(edgePath, [
  `--user-data-dir=${profilePath}`,
  '--no-first-run',
  '--new-window',
  'https://www.zhipin.com/'
], {
  detached: true,
  stdio: 'ignore'
});

child.unref();
console.log('Dedicated BOSS browser launched with Microsoft Edge.');
