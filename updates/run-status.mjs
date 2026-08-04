import {
  appendFile,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile
} from 'node:fs/promises';
import { spawn as spawnProcess } from 'node:child_process';
import { isAbsolute, join, resolve } from 'node:path';

import { importBatch } from './import-batch.mjs';
import {
  validatePublicBatch,
  verifyPublicBatch
} from './validate-public-results.mjs';

const DEFAULT_FS = Object.freeze({
  appendFile,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile
});

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function defaultProcessExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export class UpdateRunError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.name = 'UpdateRunError';
    this.status = status;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export function createCodexProcessRunner({ spawn = spawnProcess } = {}) {
  if (typeof spawn !== 'function') {
    throw new TypeError('createCodexProcessRunner requires a spawn function');
  }

  return async function runCodex({
    projectRoot,
    candidatePath,
    promptPath,
    onOutput = () => undefined
  }) {
    const scriptPath = join(projectRoot, 'updates', 'run-public-update.ps1');
    await new Promise((resolveRun, rejectRun) => {
      const child = spawn('powershell.exe', [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        scriptPath,
        '-ProjectPath',
        projectRoot,
        '-PromptPath',
        promptPath,
        '-OutputPath',
        candidatePath
      ], {
        cwd: projectRoot,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });

      child.stdout?.on('data', (chunk) => onOutput('stdout', String(chunk)));
      child.stderr?.on('data', (chunk) => onOutput('stderr', String(chunk)));
      child.once('error', rejectRun);
      child.once('close', (code, signal) => {
        if (code === 0) {
          resolveRun();
          return;
        }
        rejectRun(new Error(
          `Codex update runner exited with code ${code ?? 'unknown'}`
          + (signal ? ` (signal ${signal})` : '')
        ));
      });
    });
  };
}

async function writeExclusiveJson(fs, filePath, value) {
  let handle;
  let created = false;
  try {
    handle = await fs.open(filePath, 'wx');
    created = true;
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    if (typeof handle.sync === 'function') await handle.sync();
    await handle.close();
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    if (created) await fs.rm(filePath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function fileExists(fs, filePath) {
  try {
    await fs.stat(filePath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

export function createPublicUpdateManager({
  projectRoot,
  store,
  runner = createCodexProcessRunner(),
  validator = validatePublicBatch,
  verifier = verifyPublicBatch,
  importer = importBatch,
  fetchPage,
  fetch: fetchImplementation = globalThis.fetch,
  fs = DEFAULT_FS,
  now = () => new Date(),
  pid = process.pid,
  processExists = defaultProcessExists
} = {}) {
  if (typeof projectRoot !== 'string' || !isAbsolute(projectRoot)) {
    throw new TypeError('createPublicUpdateManager requires an absolute projectRoot');
  }
  if (!store || typeof store.read !== 'function' || typeof store.update !== 'function') {
    throw new TypeError('createPublicUpdateManager requires a store');
  }
  if (typeof runner !== 'function') {
    throw new TypeError('createPublicUpdateManager requires a runner function');
  }
  if (
    typeof validator !== 'function'
    || typeof verifier !== 'function'
    || typeof importer !== 'function'
  ) {
    throw new TypeError('validator, verifier, and importer must be functions');
  }
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new TypeError('pid must be a positive integer');
  }

  const root = resolve(projectRoot);
  const dataDirectory = join(root, 'data');
  const incomingDirectory = join(dataDirectory, 'update-batches', 'incoming');
  const rejectedDirectory = join(dataDirectory, 'update-batches', 'rejected');
  const acceptedDirectory = join(dataDirectory, 'update-batches');
  const logDirectory = join(dataDirectory, 'update-logs');
  const lockPath = join(dataDirectory, 'update-running.lock');
  const promptPath = join(root, 'updates', 'update-prompt.md');
  const completions = new Map();
  let activeRun = null;
  let sequence = 0;

  function clockDate() {
    const value = now();
    const date = value instanceof Date ? new Date(value.valueOf()) : new Date(value);
    if (Number.isNaN(date.valueOf())) throw new TypeError('now() returned an invalid date');
    return date;
  }

  async function ensureDirectories() {
    await Promise.all([
      fs.mkdir(incomingDirectory, { recursive: true }),
      fs.mkdir(rejectedDirectory, { recursive: true }),
      fs.mkdir(logDirectory, { recursive: true })
    ]);
  }

  function lockedError(lock = null) {
    return new UpdateRunError(
      409,
      'UPDATE_ALREADY_RUNNING',
      'A public job update is already running',
      lock
    );
  }

  async function acquireLock(metadata) {
    await ensureDirectories();
    const serialized = `${JSON.stringify(metadata, null, 2)}\n`;

    for (let attempt = 0; attempt < 4; attempt += 1) {
      let handle;
      let created = false;
      try {
        handle = await fs.open(lockPath, 'wx');
        created = true;
        await handle.writeFile(serialized, 'utf8');
        if (typeof handle.sync === 'function') await handle.sync();
        await handle.close();
        return;
      } catch (error) {
        if (handle) await handle.close().catch(() => undefined);
        if (created) await fs.rm(lockPath, { force: true }).catch(() => undefined);
        if (error?.code !== 'EEXIST') throw error;
      }

      let rawLock;
      try {
        rawLock = await fs.readFile(lockPath, 'utf8');
      } catch (error) {
        if (error?.code === 'ENOENT') continue;
        throw error;
      }

      let existing;
      try {
        existing = JSON.parse(rawLock);
      } catch {
        throw lockedError({ reason: 'lock metadata cannot be verified' });
      }
      if (
        !isRecord(existing)
        || !Number.isInteger(existing.pid)
        || existing.pid <= 0
        || typeof existing.startedAt !== 'string'
        || typeof existing.runId !== 'string'
      ) {
        throw lockedError({ reason: 'lock metadata cannot be verified' });
      }

      if (await processExists(existing.pid)) throw lockedError(existing);

      let confirmation;
      try {
        confirmation = await fs.readFile(lockPath, 'utf8');
      } catch (error) {
        if (error?.code === 'ENOENT') continue;
        throw error;
      }
      if (confirmation !== rawLock) continue;

      const stalePath = `${lockPath}.stale-${metadata.runId}`;
      try {
        await fs.rename(lockPath, stalePath);
        await fs.rm(stalePath, { force: true });
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
    throw lockedError({ reason: 'lock changed while it was being checked' });
  }

  async function releaseOwnLock(runId) {
    try {
      const lock = JSON.parse(await fs.readFile(lockPath, 'utf8'));
      if (lock?.runId === runId && lock?.pid === pid) {
        await fs.rm(lockPath, { force: true });
      }
    } catch (error) {
      if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
  }

  async function appendRunLog(run, level, message, details = undefined) {
    const entry = {
      at: clockDate().toISOString(),
      runId: run.runId,
      level,
      message,
      ...(details === undefined ? {} : { details })
    };
    await fs.appendFile(
      run.logPath,
      `${JSON.stringify(entry)}\n`,
      'utf8'
    );
    await store.update((state) => {
      const currentLogs = Array.isArray(state.updates.logs) ? state.updates.logs : [];
      state.updates.logs = [...currentLogs, entry].slice(-200);
    });
  }

  async function markRunning(run) {
    await store.update((state) => {
      state.updates.status = 'running';
      state.updates.lastAttemptAt = run.startedAt;
      state.updates.activeRun = {
        runId: run.runId,
        pid,
        startedAt: run.startedAt
      };
      state.updates.lastError = null;
    });
  }

  async function markFinished(run, status, extra = {}) {
    const finishedAt = clockDate().toISOString();
    await store.update((state) => {
      state.updates.status = status;
      state.updates.activeRun = null;
      state.updates.lastFinishedAt = finishedAt;
      if (status === 'success') {
        state.updates.lastSuccessAt = finishedAt;
        state.updates.lastSummary = extra.summary || null;
        state.updates.lastError = null;
      } else {
        state.updates.lastError = extra.error || 'Public update failed';
      }
    });
    return finishedAt;
  }

  async function preserveRejectedCandidate(run) {
    if (!(await fileExists(fs, run.candidatePath))) return null;
    if (await fileExists(fs, run.rejectedPath)) {
      await fs.rm(run.rejectedPath, { force: true });
    }
    await fs.rename(run.candidatePath, run.rejectedPath);
    return run.rejectedPath;
  }

  async function saveAcceptedBatch(batch) {
    const acceptedPath = join(acceptedDirectory, `${batch.id}.json`);
    try {
      await writeExclusiveJson(fs, acceptedPath, batch);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const existing = JSON.parse(await fs.readFile(acceptedPath, 'utf8'));
      if (JSON.stringify(existing) !== JSON.stringify(batch)) {
        throw new UpdateRunError(
          409,
          'BATCH_ID_COLLISION',
          `Batch ${batch.id} already exists with different contents`
        );
      }
    }
    return acceptedPath;
  }

  async function assertAcceptedBatchCompatible(batch) {
    const acceptedPath = join(acceptedDirectory, `${batch.id}.json`);
    if (!(await fileExists(fs, acceptedPath))) return acceptedPath;
    let existing;
    try {
      existing = JSON.parse(await fs.readFile(acceptedPath, 'utf8'));
    } catch (error) {
      throw new UpdateRunError(
        409,
        'BATCH_ID_COLLISION',
        `Batch ${batch.id} has an unreadable accepted archive: ${errorMessage(error)}`
      );
    }
    if (JSON.stringify(existing) !== JSON.stringify(batch)) {
      throw new UpdateRunError(
        409,
        'BATCH_ID_COLLISION',
        `Batch ${batch.id} already exists with different contents`
      );
    }
    return acceptedPath;
  }

  async function execute(run) {
    let stagedPath = null;
    let committed = false;
    try {
      await appendRunLog(run, 'info', 'Public job update started');
      const outputChunks = [];
      const runnerResult = await runner({
        projectRoot: root,
        promptPath,
        candidatePath: run.candidatePath,
        runId: run.runId,
        onOutput(stream, text) {
          outputChunks.push({ stream, text: String(text).slice(0, 4000) });
        }
      });
      if (isRecord(runnerResult)) {
        const candidateOutput = isRecord(runnerResult.candidate)
          ? runnerResult.candidate
          : runnerResult;
        await fs.writeFile(
          run.candidatePath,
          `${JSON.stringify(candidateOutput, null, 2)}\n`,
          'utf8'
        );
      }
      if (outputChunks.length > 0) {
        await appendRunLog(run, 'info', 'Codex runner output captured', outputChunks);
      }

      let candidate;
      try {
        candidate = JSON.parse(await fs.readFile(run.candidatePath, 'utf8'));
      } catch (error) {
        throw new UpdateRunError(
          422,
          'INVALID_UPDATE_OUTPUT',
          `Runner did not produce valid JSON: ${errorMessage(error)}`
        );
      }
      const validation = validator(candidate);
      if (!validation || !Array.isArray(validation.errors)) {
        throw new UpdateRunError(
          500,
          'INVALID_VALIDATOR_RESULT',
          'Public update validator returned an invalid result'
        );
      }
      if (validation.errors.length > 0 || !validation.batch) {
        throw new UpdateRunError(
          422,
          'PUBLIC_BATCH_VALIDATION_FAILED',
          'Public update candidate failed validation',
          validation.errors
        );
      }

      const verification = await verifier(validation.batch, {
        fetchPage,
        fetch: fetchImplementation,
        now: clockDate
      });
      if (
        !isRecord(verification)
        || !isRecord(verification.batch)
        || !Array.isArray(verification.batch.jobs)
        || !Array.isArray(verification.rejected)
        || !Array.isArray(verification.evidence)
      ) {
        throw new UpdateRunError(
          500,
          'INVALID_VERIFIER_RESULT',
          'Public source verifier returned an invalid result'
        );
      }

      if (verification.rejected.length > 0) {
        await writeExclusiveJson(fs, run.manualReviewPath, {
          runId: run.runId,
          batchId: validation.batch.id,
          createdAt: clockDate().toISOString(),
          manualReview: verification.rejected
        });
      }
      if (verification.batch.jobs.length === 0) {
        await fs.writeFile(run.candidatePath, `${JSON.stringify({
          candidate,
          manualReview: verification.rejected
        }, null, 2)}\n`, 'utf8');
        throw new UpdateRunError(
          422,
          'PUBLIC_SOURCE_VERIFICATION_FAILED',
          'No candidate had verifiable company and job-title evidence',
          verification.rejected
        );
      }

      await assertAcceptedBatchCompatible(verification.batch);
      stagedPath = run.stagedPath;
      await writeExclusiveJson(fs, stagedPath, {
        batch: verification.batch,
        evidence: verification.evidence
      });

      const summary = await importer({ store, batch: verification.batch });
      committed = true;
      const warnings = [];
      let acceptedPath = null;

      try {
        acceptedPath = await saveAcceptedBatch(verification.batch);
      } catch (error) {
        warnings.push({ code: 'ARCHIVE_FAILED', message: errorMessage(error) });
      }
      for (const cleanupPath of [run.candidatePath, stagedPath]) {
        try {
          await fs.rm(cleanupPath, { force: true });
        } catch (error) {
          warnings.push({
            code: 'CLEANUP_FAILED',
            message: `${cleanupPath}: ${errorMessage(error)}`
          });
        }
      }
      try {
        await appendRunLog(run, 'info', 'Public job update imported', {
          acceptedPath,
          manualReviewPath: verification.rejected.length > 0
            ? run.manualReviewPath
            : null,
          verificationEvidence: verification.evidence,
          summary,
          warnings
        });
      } catch (error) {
        warnings.push({ code: 'LOG_FAILED', message: errorMessage(error) });
      }

      let finishedAt = clockDate().toISOString();
      try {
        finishedAt = await markFinished(run, 'success', { summary });
      } catch (error) {
        warnings.push({ code: 'STATE_FINALIZE_FAILED', message: errorMessage(error) });
      }
      return {
        runId: run.runId,
        status: 'success',
        startedAt: run.startedAt,
        finishedAt,
        summary,
        acceptedPath,
        manualReviewPath: verification.rejected.length > 0
          ? run.manualReviewPath
          : null,
        evidence: verification.evidence,
        warnings
      };
    } catch (error) {
      if (stagedPath) {
        await fs.rm(stagedPath, { force: true }).catch(() => undefined);
      }
      let rejectedPath = null;
      try {
        rejectedPath = await preserveRejectedCandidate(run);
      } catch {
        // The original failure remains authoritative; log/state still record it.
      }
      const message = errorMessage(error);
      try {
        await appendRunLog(run, 'error', 'Public job update failed', {
          code: error?.code || 'UPDATE_RUN_FAILED',
          message,
          rejectedPath,
          validationErrors: Array.isArray(error?.details) ? error.details : undefined
        });
      } catch {
        // A logging failure must not mask the update failure or alter job data.
      }
      let finishedAt = clockDate().toISOString();
      try {
        finishedAt = await markFinished(run, 'failed', { error: message });
      } catch {
        // The caller still receives an explicit failed completion.
      }
      return {
        runId: run.runId,
        status: committed ? 'success' : 'failed',
        startedAt: run.startedAt,
        finishedAt,
        error: {
          code: error?.code || 'UPDATE_RUN_FAILED',
          message
        },
        rejectedPath
      };
    } finally {
      try {
        await releaseOwnLock(run.runId);
      } catch {
        // Lock cleanup is best effort; stale-lock recovery verifies the PID.
      }
      if (activeRun?.runId === run.runId) activeRun = null;
    }
  }

  return {
    lockPath,

    async start() {
      if (activeRun) throw lockedError(activeRun);
      const startedAt = clockDate().toISOString();
      sequence += 1;
      const runId = `manual-${startedAt.replace(/[^0-9]/g, '').slice(0, 17)}-${pid}-${sequence}`;
      const run = {
        runId,
        pid,
        startedAt,
        status: 'running',
        candidatePath: join(incomingDirectory, `${runId}.json`),
        stagedPath: join(incomingDirectory, `${runId}.verified.json`),
        rejectedPath: join(rejectedDirectory, `${runId}.json`),
        manualReviewPath: join(rejectedDirectory, `${runId}-manual-review.json`),
        logPath: join(logDirectory, `${runId}.jsonl`)
      };

      await acquireLock({ runId, pid, startedAt });
      activeRun = run;
      try {
        await markRunning(run);
      } catch (error) {
        activeRun = null;
        await releaseOwnLock(runId);
        throw error;
      }

      const completion = execute(run);
      completions.set(runId, completion);
      completion.finally(() => completions.delete(runId)).catch(() => undefined);
      return { runId, status: 'running', startedAt };
    },

    async waitForIdle(runId = activeRun?.runId) {
      const completion = runId ? completions.get(runId) : null;
      if (!completion) {
        throw new UpdateRunError(404, 'UPDATE_RUN_NOT_FOUND', 'Update run was not found');
      }
      return completion;
    }
  };
}
