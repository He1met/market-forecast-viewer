// This entry point loads only Node builtins before verifying the approved release.
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REQUIRED_CODE_FILES = Object.freeze([
  'scripts/m1-runtime.mjs', 'scripts/m1-runtime-events.mjs', 'scripts/executor.mjs',
  'scripts/m1-input.mjs', 'scripts/m1-forecast.mjs', 'scripts/m1-archive.mjs', 'scripts/m1-events.mjs',
  'scripts/m1-outcome-store.mjs', 'scripts/m1-display.mjs', 'scripts/data-utils.mjs',
  'src/contracts.ts', 'src/m1-contracts.ts', 'src/m1-display.ts', 'src/m1-evaluation.ts',
  'docs/M1_FORECAST.md', 'package.json', 'package-lock.json', 'tsconfig.json', '.codex/config.toml',
]);
const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const digest = value => createHash('sha256').update(value).digest('hex');
const encode = value => JSON.stringify(value, null, 2) + '\n';
const id = /^[a-zA-Z0-9_-]{1,180}$/, hash = /^[a-f0-9]{64}$/;
const validId = value => typeof value === 'string' && id.test(value);
const validHash = value => typeof value === 'string' && hash.test(value);
const check = (value, code) => { if (!value) throw Error(code); };
let importedRelease = null;

function files(root) {
  const within = file => { const part = relative(root, file); return part && part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part); };
  async function safe(file, missing = false) {
    check(within(file) && await realpath(root) === root, 'RUNTIME_PATH_INVALID');
    let current = root;
    for (const part of relative(root, file).split(sep)) {
      current = join(current, part);
      try { check(!(await lstat(current)).isSymbolicLink(), 'RUNTIME_SYMLINK_FORBIDDEN'); }
      catch (error) { if (missing && error.code === 'ENOENT') return; throw error; }
    }
  }
  async function exists(file) { try { await safe(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
  async function bytes(file) {
    await safe(file); const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { const stat = await handle.stat(); check(stat.isFile() && stat.size <= 16 * 1024 * 1024, 'RUNTIME_FILE_INVALID'); return await handle.readFile(); }
    finally { await handle.close(); }
  }
  async function directory(file) { await safe(file, true); await mkdir(file, { recursive: true, mode: 0o700 }); await safe(file); }
  async function atomic(file, value) {
    await directory(dirname(file)); await safe(file, true);
    const tmp = `${file}.${randomUUID()}.tmp`;
    await writeFile(tmp, encode(value), { flag: 'wx', mode: 0o600 }); await rename(tmp, file);
  }
  return { safe, exists, bytes, directory, atomic, json: async file => JSON.parse((await bytes(file)).toString('utf8')) };
}

export async function verifyRuntimeRelease({ root = defaultRoot, releaseFile, expectedHash = null } = {}) {
  root = resolve(root); const io = files(root), raw = await io.bytes(resolve(root, releaseFile));
  const release = JSON.parse(raw.toString('utf8')), sha256 = digest(raw);
  check(expectedHash === null || (validHash(expectedHash) && expectedHash === sha256), 'CODE_VERSION_CHANGED');
  check(release.schema === 'MFV:M1_RUNTIME_RELEASE:v1' && release.local_only === true && validId(release.release_id)
    && release.method_version === 'm1-path-events-v1' && release.prompt_version === 'm1-codex-v1'
    && release.evaluation_version === 'm1-evaluation-v1', 'RELEASE_INVALID');
  const gate = release.gate;
  check(gate?.name === 'single_run_verified' && validId(gate.review_id)
    && /^https:\/\/github\.com\/He1met\/market-forecast-viewer\/pull\/7#pullrequestreview-\d+$/.test(gate.source_url)
    && validHash(gate.source_body_sha256) && typeof gate.reviewed_head_sha === 'string'
    && /^[a-f0-9]{40}$/.test(gate.reviewed_head_sha), 'RELEASE_INVALID');
  check(release.code_sha256 && Object.keys(release.code_sha256).sort().join('\n') === [...REQUIRED_CODE_FILES].sort().join('\n'), 'RELEASE_INVALID');
  for (const file of REQUIRED_CODE_FILES) {
    check(validHash(release.code_sha256[file]) && digest(await io.bytes(join(root, file))) === release.code_sha256[file], 'CODE_VERSION_CHANGED');
  }
  const config = release.cli_configuration;
  check(config && ['model', 'model_reasoning_effort', 'approval_policy', 'sandbox_mode'].every(key => typeof config[key] === 'string')
    && config.approval_policy === 'never' && config.sandbox_mode === 'danger-full-access', 'RELEASE_INVALID');
  return { release, sha256 };
}

async function verifyCliConfiguration(expected) {
  // Read only top-level non-secret settings; never return or print the config document.
  const text = await readFile(join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'config.toml'), 'utf8');
  const top = text.split(/^\s*\[/m)[0];
  for (const [key, value] of Object.entries(expected)) {
    check(['model', 'model_reasoning_effort', 'approval_policy', 'sandbox_mode'].includes(key), 'RELEASE_INVALID');
    const actual = top.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"\\r\\n]*)"\\s*(?:#.*)?$`, 'm'))?.[1];
    check(actual === value, 'CLI_CONFIGURATION_CHANGED');
  }
}

/** Mature boundaries only; missing mature data is retried with a new outcome capture. */
export function needsOutcome(run, latest, now) {
  if (run.forecast.status !== 'valid') return false;
  const elapsed = Date.parse(now) / 1000 - run.forecast.anchor_time;
  if (elapsed < 21600) return false;
  if (latest?.status !== 'available') return true;
  for (const [key, seconds] of [['h6', 21600], ['h12', 43200], ['h24', 86400]]) {
    if (elapsed >= seconds && latest.result.windows[key].status !== 'mature') return true;
  }
  return false;
}

async function productionDependencies(root, releaseHash) {
  check(!importedRelease || importedRelease === releaseHash, 'CODE_VERSION_CHANGED');
  importedRelease = releaseHash;
  const [input, forecast, archive, outcome, display, events] = await Promise.all([
    import('./m1-input.mjs'), import('./m1-forecast.mjs'), import('./m1-archive.mjs'),
    import('./m1-outcome-store.mjs'), import('./m1-display.mjs'), import('./m1-runtime-events.mjs'),
  ]);
  return { prepare: input.prepareForecast, generate: forecast.generateForecast, readPublished: archive.readPublished,
    reader: display.createDisplayReader({ root }), store: outcome.createOutcomeStore({ root }),
    collectEvents: events.collectRuntimeEvents, verifyConfiguration: verifyCliConfiguration };
}

/** Dependency injection is available to local synthetic tests; the real CLI exposes no substitutions. */
export async function runRuntimeCycle({ root = defaultRoot, releaseFile, expectedReleaseHash, threadId, trigger, borrowOwner = null,
  cycleId = `m1-cycle-${trigger}-${threadId}`, now = () => new Date().toISOString(), dependencies = null } = {}) {
  root = resolve(root); check(validHash(expectedReleaseHash) && validId(threadId) && validId(cycleId) && ['manual', 'scheduled'].includes(trigger), 'RUNTIME_ARGUMENT_INVALID');
  check(!borrowOwner || trigger === 'manual', 'BORROW_REQUIRES_MANUAL');
  if (!dependencies) check(resolve(process.cwd()) === root && root === defaultRoot, 'RUNTIME_REQUIRES_PROJECT_CWD');
  const io = files(root), base = join(root, 'artifacts/m1-runtime'), stateFile = join(base, 'status.json');
  if (await io.exists(join(base, 'PAUSED'))) return { status: 'USER_PAUSED', quiet: true };
  const approved = await verifyRuntimeRelease({ root, releaseFile, expectedHash: expectedReleaseHash });
  const executor = dependencies?.executor ?? await import('./executor.mjs');
  const context = executor.context(root);
  let lockId = cycleId, acquired = false;
  if (borrowOwner) {
    const owner = executor.owned(context, borrowOwner);
    check(owner.thread_id === threadId && owner.run_id === borrowOwner, 'BORROW_OWNER_MISMATCH');
    lockId = borrowOwner;
  } else {
    const result = executor.acquire(context, { run_id: cycleId, thread_id: threadId, issue_number: 0, trigger });
    if (result.status !== 'ACQUIRED') return { ...result, quiet: true };
    acquired = true;
  }
  let state, deps, stepNumber = 0;
  const cycle = join(base, 'cycles', cycleId);
  const guard = async () => {
    executor.owned(context, lockId);
    await verifyRuntimeRelease({ root, releaseFile, expectedHash: approved.sha256 });
    if (deps) await deps.verifyConfiguration(approved.release.cli_configuration);
  };
  const save = async () => {
    state.updated_at = now();
    await io.atomic(join(cycle, `step-${String(++stepNumber).padStart(3, '0')}.json`), state);
    await io.atomic(join(cycle, 'state.json'), state);
    await io.atomic(stateFile, state);
  };
  const phase = async stage => { await guard(); state.stage = stage; await save(); };
  try {
    await guard();
    if (await io.exists(join(base, 'PAUSED'))) return { status: 'USER_PAUSED', quiet: true };
    if (await io.exists(join(cycle, 'state.json'))) {
      const previous = await io.json(join(cycle, 'state.json'));
      return { status: previous.status === 'running' ? 'INCOMPLETE_PRIOR_CYCLE' : 'DUPLICATE_CYCLE', cycle_id: cycleId, previous, quiet: true };
    }
    const previous = await io.exists(stateFile) ? await io.json(stateFile) : null;
    if (previous?.status === 'running') return { status: 'INCOMPLETE_PRIOR_CYCLE', cycle_id: previous.cycle_id, quiet: false };
    state = { schema: 'MFV:M1_RUNTIME_STATE:v1', local_only: true, cycle_id: cycleId, trigger, thread_id: threadId,
      release_id: approved.release.release_id, release_sha256: approved.sha256, status: 'running', stage: 'check_release',
      started_at: now(), updated_at: now(), completed_at: null, error_code: null, new_forecast: null,
      old_results: [], latest_valid_run_id: previous?.latest_valid_run_id ?? null, last_success: previous?.last_success ?? null };
    await save();
    deps = dependencies ?? await productionDependencies(root, approved.sha256);
    await deps.verifyConfiguration(approved.release.cli_configuration);
    await phase('score_old');
    const before = await deps.reader.readIndex({ now: now() });
    const beforeIds = new Set(before.runs.map(run => run.run_id));
    let oldFailed = false;
    for (const entry of before.runs) {
      if (!['valid', 'expired'].includes(entry.status)) continue;
      await guard();
      try {
        const run = await deps.reader.readRun(entry.run_id), latest = await deps.store.readLatest(run);
        let decisionResult = latest;
        // An immutable complete 24h result remains complete even if a later capture failed.
        // Keep the latest failure visible, but do not repeatedly download the already complete horizon.
        const revisions = join(root, 'artifacts/m1-outcomes', entry.run_id, 'evaluations');
        if (latest.status !== 'available' && await io.exists(revisions)) {
          for (const revision of (await readdir(revisions)).filter(value => /^evaluation-\d{8}T\d{9}Z-[a-f0-9-]{36}$/.test(value)).sort().reverse()) {
            const saved = await deps.store.readRevision(run, revision);
            if (saved.result.windows.h24.status === 'mature') { decisionResult = saved; break; }
          }
        }
        if (!needsOutcome(run, decisionResult, now())) {
          state.old_results.push({ run_id: entry.run_id, status: decisionResult?.result?.windows.h24.status === 'mature' ? 'complete' : 'not_due',
            ...(latest.status === 'failed' ? { latest_attempt_status: 'failed', reason: 'OLD_RESULT_FAILED' } : {}),
            ...(decisionResult?.status === 'available' ? { revision_id: decisionResult.revision_id, evaluation_sha256: decisionResult.evaluation_sha256 } : {}) });
        } else {
          const capture = await deps.store.capture(run); await guard();
          check(capture.status === 'ok', 'OLD_RESULT_FAILED');
          const result = await deps.store.evaluateCapture(run, capture.capture_id); await guard();
          check(result.status === 'available', 'OLD_RESULT_FAILED');
          state.old_results.push({ run_id: entry.run_id, status: 'available', capture_id: capture.capture_id,
            revision_id: result.revision_id, evaluation_sha256: result.evaluation_sha256 });
        }
      } catch (error) {
        if (['CODE_VERSION_CHANGED', 'LOCK_NOT_OWNED'].includes(error.message)) throw error;
        oldFailed = true; state.old_results.push({ run_id: entry.run_id, status: 'failed', reason: 'OLD_RESULT_FAILED' });
        await io.atomic(join(cycle, `old-error-${state.old_results.length}.json`), { local_only: true, error: String(error.message) });
      }
      await save();
    }
    await phase('collect_events');
    const eventsFile = await deps.collectEvents({ root, directory: join(cycle, 'events') });
    await phase('prepare');
    let prepared;
    try { prepared = await deps.prepare(eventsFile); }
    catch (error) {
      const after = await deps.reader.readIndex({ now: now() });
      const created = after.runs.filter(run => !beforeIds.has(run.run_id));
      state.preparation_run_ids = created.map(run => run.run_id);
      throw error;
    }
    state.new_forecast = { run_id: prepared.run_id, status: 'frozen', published_at: null, forecast_sha256: null };
    await save();
    await phase('generate');
    let published, lastError;
    for (let attempt = 1; attempt <= 2; attempt++) {
      await guard(); state.generation_attempt = attempt; await save();
      published = await deps.readPublished(prepared.runDir);
      if (published) break;
      try { published = await deps.generate(prepared.runDir, { beforePublish: guard }); break; }
      catch (error) { lastError = error; await io.atomic(join(cycle, `generation-error-${attempt}.json`), { local_only: true, error: String(error.message), at: now() }); }
    }
    if (!published) throw lastError ?? Error('GENERATION_FAILED');
    await guard();
    state.new_forecast = { run_id: published.forecast.run_id, status: published.forecast.status,
      published_at: published.forecast.published_at, forecast_sha256: published.receipt.forecast_sha256 ?? published.manifest?.forecast_sha256 ?? null };
    await phase('publish_index');
    const displayed = await deps.reader.readRun(prepared.run_id);
    state.new_forecast.forecast_sha256 = displayed.hashes.forecast_sha256;
    const index = await deps.reader.readIndex({ now: now() }); await guard();
    await io.atomic(join(base, 'index.json'), { schema: 'MFV:M1_RUNTIME_INDEX:v1', cycle_id: cycleId, updated_at: now(), index });
    state.latest_valid_run_id = index.latest_run_id;
    state.status = published.forecast.status === 'late' ? 'late' : oldFailed ? 'failed' : 'completed';
    state.error_code = state.status === 'late' ? 'PUBLICATION_LATE' : oldFailed ? 'OLD_RESULT_FAILED' : null;
    state.completed_at = now(); state.stage = 'done';
    if (state.status === 'completed') state.last_success = { cycle_id: cycleId, completed_at: state.completed_at, forecast_id: prepared.run_id };
    await save(); return state;
  } catch (error) {
    if (!state) throw error;
    const code = error.message;
    state.error_code = ['CODE_VERSION_CHANGED', 'CLI_CONFIGURATION_CHANGED', 'RELEASE_INVALID'].includes(code) ? code
      : ({ prepare: 'PREPARATION_FAILED', collect_events: 'PREPARATION_FAILED', generate: 'GENERATION_FAILED', publish_index: 'INDEX_FAILED' }[state.stage] ?? 'UNEXPECTED_FAILURE');
    state.status = 'failed'; state.completed_at = now();
    await io.atomic(join(cycle, 'error.json'), { local_only: true, error: String(error.message), at: now() });
    // A failed new forecast still refreshes the read-only projection of old outcomes and attempt status.
    // With changed code, keep the prior verified index rather than calling unapproved methods.
    if (deps && state.error_code !== 'CODE_VERSION_CHANGED') {
      try {
        await guard(); const index = await deps.reader.readIndex({ now: now() }); await guard();
        await io.atomic(join(base, 'index.json'), { schema: 'MFV:M1_RUNTIME_INDEX:v1', cycle_id: cycleId, updated_at: now(), index });
        state.latest_valid_run_id = index.latest_run_id;
      } catch (indexError) {
        await io.atomic(join(cycle, 'index-error.json'), { local_only: true, error: String(indexError.message), at: now() });
      }
    }
    await save(); return state;
  } finally {
    // Normal completion waits for every child operation. Process termination leaves the lock and stage intact.
    if (acquired) executor.release(context, lockId);
  }
}

async function main() {
  const [command, releaseFile, expectedReleaseHash, threadId, trigger, borrowOwner] = process.argv.slice(2);
  check(command === 'run' && releaseFile && expectedReleaseHash && threadId && trigger, 'Usage: run RELEASE_FILE RELEASE_SHA256 THREAD_ID manual|scheduled [BORROW_OWNER]');
  const result = await runRuntimeCycle({ releaseFile, expectedReleaseHash, threadId, trigger, borrowOwner });
  console.log(JSON.stringify({ status: result.status, cycle_id: result.cycle_id ?? null, error_code: result.error_code ?? null,
    new_forecast: result.new_forecast ?? null, quiet: result.quiet ?? false }));
  if (['failed', 'late', 'INCOMPLETE_PRIOR_CYCLE'].includes(result.status)) process.exitCode = 1;
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
