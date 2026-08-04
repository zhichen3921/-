import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createStore } from './store.mjs';
import { createRouter } from './router.mjs';
import { createRuntimeToken } from './security.mjs';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 43127;
const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(moduleDirectory, '..');

export function createApplicationServer({
  store,
  host = DEFAULT_HOST,
  port = DEFAULT_PORT,
  staticRoot = projectRoot,
  runtimeToken = createRuntimeToken()
} = {}) {
  if (host !== DEFAULT_HOST) {
    throw new TypeError('Application server must bind only to 127.0.0.1');
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new TypeError('Application server port must be an integer from 0 to 65535');
  }
  if (!store) {
    throw new TypeError('createApplicationServer requires a store');
  }

  const extensionToken = createRuntimeToken();
  let server;
  const expectedAuthority = () => {
    const address = server?.address();
    if (!address || typeof address === 'string') return '';
    return `${DEFAULT_HOST}:${address.port}`;
  };
  const handler = createRouter({
    store,
    runtimeToken,
    extensionToken,
    expectedAuthority,
    staticRoot
  });
  server = createServer((request, response) => {
    handler(request, response).catch(() => {
      if (!response.headersSent) {
        const body = JSON.stringify({
          error: {
            code: 'INTERNAL_ERROR',
            message: 'The local application service encountered an unexpected error'
          }
        });
        response.writeHead(500, {
          'content-type': 'application/json; charset=utf-8',
          'content-length': Buffer.byteLength(body)
        });
        response.end(body);
      } else {
        response.destroy();
      }
    });
  });

  let startPromise;
  return {
    server,
    token: runtimeToken,

    start() {
      if (server.listening) return Promise.resolve(this);
      if (startPromise) return startPromise;
      startPromise = new Promise((resolveStart, rejectStart) => {
        const onError = (error) => {
          server.off('listening', onListening);
          startPromise = undefined;
          rejectStart(error);
        };
        const onListening = () => {
          server.off('error', onError);
          resolveStart(this);
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, DEFAULT_HOST);
      });
      return startPromise;
    },

    address() {
      return server.address();
    },

    close() {
      if (!server.listening) return Promise.resolve();
      return new Promise((resolveClose, rejectClose) => {
        server.close((error) => {
          startPromise = undefined;
          if (error) {
            rejectClose(error);
          } else {
            resolveClose();
          }
        });
      });
    }
  };
}

export async function startDefaultApplicationServer() {
  const store = createStore({
    filePath: join(projectRoot, 'data', 'state.json'),
    initialState: { version: 3, jobs: [] }
  });
  const application = createApplicationServer({
    store,
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    staticRoot: projectRoot
  });
  await application.start();
  return application;
}

const entryPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (entryPath === import.meta.url) {
  const application = await startDefaultApplicationServer();
  const address = application.address();
  process.stdout.write(`Application Desk listening on http://${address.address}:${address.port}\n`);

  const shutdown = async () => {
    await application.close();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
