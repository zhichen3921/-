import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { normalizeState } from './state-schema.mjs';

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

export function createStore({ filePath, initialState = {} } = {}) {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new TypeError('createStore requires a filePath');
  }

  const preparedInitialState = normalizeState(cloneJson(initialState));
  let queue = Promise.resolve();

  function enqueue(operation) {
    const result = queue.then(operation);
    queue = result.catch(() => undefined);
    return result;
  }

  async function writeState(state) {
    const normalized = normalizeState(state);
    const serialized = `${JSON.stringify(normalized, null, 2)}\n`;
    const temporaryPath = `${filePath}.tmp`;
    let handle;

    await mkdir(dirname(filePath), { recursive: true });

    try {
      handle = await open(temporaryPath, 'w');
      await handle.writeFile(serialized, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, filePath);
    } catch (error) {
      if (handle) {
        await handle.close().catch(() => undefined);
      }
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }

    return normalized;
  }

  async function readState() {
    try {
      const serialized = await readFile(filePath, 'utf8');
      return normalizeState(JSON.parse(serialized));
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw error;
      }

      return writeState(preparedInitialState);
    }
  }

  return {
    read() {
      return enqueue(async () => cloneJson(await readState()));
    },

    replace(nextState) {
      let preparedState;
      try {
        preparedState = normalizeState(cloneJson(nextState));
      } catch (error) {
        return Promise.reject(error);
      }

      return enqueue(async () => {
        const saved = await writeState(preparedState);
        return cloneJson(saved);
      });
    },

    update(mutator) {
      if (typeof mutator !== 'function') {
        return Promise.reject(new TypeError('store.update requires a mutator'));
      }

      return enqueue(async () => {
        const current = await readState();
        const draft = cloneJson(current);
        const result = await mutator(draft);
        const saved = await writeState(result === undefined ? draft : result);
        return cloneJson(saved);
      });
    }
  };
}
