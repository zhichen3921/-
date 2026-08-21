import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = join(projectRoot, '_site');

await rm(outputRoot, { recursive: true, force: true });
await mkdir(join(outputRoot, 'client'), { recursive: true });

for (const file of ['styles.css', 'app.js', 'curated-jobs.js']) {
  await cp(join(projectRoot, file), join(outputRoot, file));
}

const publicIndex = (await readFile(join(projectRoot, 'index.html'), 'utf8'))
  .replace(/\s*<script src="client\/profile\.local\.js" onerror="this\.remove\(\)"><\/script>/, '');
await writeFile(join(outputRoot, 'index.html'), publicIndex);

for (const file of ['filters.js', 'preferences.js', 'profile.js', 'greetings.js', 'extension-center.js']) {
  await cp(join(projectRoot, 'client', file), join(outputRoot, 'client', file));
}

await writeFile(join(outputRoot, '.nojekyll'), '');
console.log(`Built static demo in ${outputRoot}`);
