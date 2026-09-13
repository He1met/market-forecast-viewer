import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, readdir, rm, symlink } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import * as realExecutor from '../scripts/executor.mjs';
import { REQUIRED_CODE_FILES, runRuntimeCycle, verifyRuntimeRelease, needsOutcome } from '../scripts/m1-runtime.mjs';
import { collectRuntimeEvents } from '../scripts/m1-runtime-events.mjs';
import { generateForecast } from '../scripts/m1-forecast.mjs';
import { newRun, freezeInput, readPublished } from '../scripts/m1-archive.mjs';
import { rawOutputJsonSchema } from '../src/m1-contracts.ts';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const encode = value => JSON.stringify(value, null, 2) + '\n';
const anchor = 1789002000, currentTime = new Date((anchor + 13 * 3600) * 1000).toISOString();
const goodResult = (h6 = 'mature', h12 = 'mature', h24 = 'partial') => ({ status: 'available', revision_id: 'evaluation-synthetic',
  evaluation_sha256: 'e'.repeat(64), result: { windows: { h6: { status: h6 }, h12: { status: h12 }, h24: { status: h24 } } } });

async function fixture(t) {
  const home = resolve('artifacts/m14'); await mkdir(home, { recursive: true });
  const root = await mkdtemp(join(home, 'synthetic-runtime-')); t.after(() => rm(root, { recursive: true, force: true }));
  const code = {};
  for (const file of REQUIRED_CODE_FILES) {
    const raw = await readFile(file); await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), raw); code[file] = digest(raw);
  }
  const release = { schema: 'MFV:M1_RUNTIME_RELEASE:v1', release_id: 'SYNTHETIC-release', local_only: true,
    method_version: 'm1-path-events-v1', prompt_version: 'm1-codex-v1', evaluation_version: 'm1-evaluation-v1',
    gate: { name: 'single_run_verified', review_id: 'SYNTHETIC-review',
      source_url: 'https://github.com/He1met/market-forecast-viewer/pull/7#pullrequestreview-1',
      source_body_sha256: 'a'.repeat(64), reviewed_head_sha: 'b'.repeat(40) }, code_sha256: code,
    cli_configuration: { model: 'SYNTHETIC', model_reasoning_effort: 'medium', approval_policy: 'never', sandbox_mode: 'danger-full-access' } };
  const releaseFile = join(root, 'artifacts/m1-runtime/release.json');
  await mkdir(dirname(releaseFile), { recursive: true }); await writeFile(releaseFile, encode(release));
  const base = join(root, 'artifacts/executor'), context = { root, canonical: root, base,
    lock: join(base, 'writer.lock'), legacyLock: join(root, 'legacy-writer.lock') };
  const old = { run_id: 'm1-synthetic-old', forecast: { status: 'valid', anchor_time: anchor }, hashes: { forecast_sha256: 'd'.repeat(64) } };
  const fresh = { run_id: 'm1-synthetic-new', forecast: { run_id: 'm1-synthetic-new', status: 'valid',
    published_at: currentTime, anchor_time: anchor + 13 * 3600 }, hashes: { forecast_sha256: 'f'.repeat(64) } };
  const runs = new Map([[old.run_id, old]]), counters = { prepare: 0, generate: 0, capture: 0, events: 0, evaluate: 0 };
  let latest = goodResult('mature', 'partial'), publication = null;
  const deps = { executor: { ...realExecutor, context: () => context }, verifyConfiguration: async () => {},
    reader: { readRun: async runId => structuredClone(runs.get(runId)),
      readIndex: async () => ({ schema: 'MFV:M1_INDEX:v1', checked_at: currentTime,
        latest_run_id: publication?.forecast.status === 'valid' ? fresh.run_id : old.run_id,
        runs: [...runs.values()].map(run => ({ run_id: run.run_id, status: run.forecast.status })) }) },
    store: { readLatest: async run => run.run_id === old.run_id ? latest : { status: 'not_evaluated' },
      capture: async () => { counters.capture++; return { status: 'ok', capture_id: 'capture-synthetic' }; },
      evaluateCapture: async () => { counters.evaluate++; latest = goodResult(); return latest; } },
    collectEvents: async () => { counters.events++; return 'SYNTHETIC-events.json'; },
    prepare: async () => { counters.prepare++; return { run_id: fresh.run_id, runDir: 'SYNTHETIC-runDir' }; },
    readPublished: async () => publication,
    generate: async (_, { beforePublish }) => { counters.generate++; await beforePublish(); runs.set(fresh.run_id, fresh);
      publication = { forecast: fresh.forecast, receipt: { forecast_sha256: fresh.hashes.forecast_sha256 } }; return publication; } };
  const options = { root, releaseFile, expectedReleaseHash: digest(encode(release)), threadId: 'SYNTHETIC-thread', trigger: 'manual', now: () => currentTime, dependencies: deps };
  return { root, release, releaseFile, options, deps, counters, context, old, fresh, runs,
    run: (extra = {}) => runRuntimeCycle({ ...options, ...extra }),
    setLatest: value => { latest = value; }, clearPublication: () => { publication = null; },
    state: async () => JSON.parse(await readFile(join(root, 'artifacts/m1-runtime/status.json'), 'utf8')) };
}

test('SYNTHETIC full cycle scores mature old forecast, publishes index, and duplicate thread never resamples', async t => {
  const f = await fixture(t), result = await f.run();
  assert.equal(result.status, 'completed'); assert.equal(result.old_results[0].status, 'available');
  assert.equal(result.new_forecast.forecast_sha256, 'f'.repeat(64)); assert.equal(result.last_success.forecast_id, f.fresh.run_id);
  assert.deepEqual(f.counters, { prepare: 1, generate: 1, capture: 1, events: 1, evaluate: 1 });
  const state = await f.state(); assert.equal((await f.run()).status, 'DUPLICATE_CYCLE'); assert.deepEqual(await f.state(), state);
  assert.equal(f.counters.prepare, 1); assert.equal(f.counters.generate, 1);
  assert.equal((await readdir(f.context.base)).includes('writer.lock'), false);
});

test('SYNTHETIC overlap with development, legacy locks and pause leave status untouched', async t => {
  const f = await fixture(t);
  realExecutor.acquire(f.context, { run_id: 'DEV', thread_id: 'OTHER', issue_number: 14, trigger: 'scheduled' });
  assert.deepEqual(await f.run(), { status: 'LOCK_BUSY', quiet: true }); assert.equal(f.counters.prepare, 0);
  realExecutor.release(f.context, 'DEV');
  await mkdir(f.context.legacyLock); assert.equal((await f.run()).status, 'LEGACY_LOCK_BUSY'); await rm(f.context.legacyLock, { recursive: true });
  const pause = join(f.root, 'artifacts/m1-runtime/PAUSED'); await writeFile(pause, 'SYNTHETIC pause');
  assert.equal((await f.run()).status, 'USER_PAUSED'); await rm(pause);
  assert.equal((await f.run()).status, 'completed');
});

test('SYNTHETIC manual borrowed owner checks thread and never releases development lock', async t => {
  const f = await fixture(t);
  realExecutor.acquire(f.context, { run_id: 'DEV', thread_id: f.options.threadId, issue_number: 14, trigger: 'scheduled' });
  await assert.rejects(() => f.run({ borrowOwner: 'DEV', threadId: 'OTHER' }), /BORROW_OWNER_MISMATCH/);
  await assert.rejects(() => f.run({ borrowOwner: 'DEV', trigger: 'scheduled' }), /BORROW_REQUIRES_MANUAL/);
  assert.equal((await f.run({ borrowOwner: 'DEV' })).status, 'completed');
  assert.equal(realExecutor.owned(f.context, 'DEV').issue_number, 14); realExecutor.release(f.context, 'DEV');
});

test('SYNTHETIC source edits and replaced manifest fail before executing any method', async t => {
  const f = await fixture(t), file = join(f.root, 'src/m1-evaluation.ts'), original = await readFile(file);
  await writeFile(file, 'UNAPPROVED'); await assert.rejects(() => f.run(), /CODE_VERSION_CHANGED/); assert.equal(f.counters.prepare, 0);
  await writeFile(file, original);
  f.release.release_id = 'SYNTHETIC-replaced'; await writeFile(f.releaseFile, encode(f.release));
  await assert.rejects(() => f.run(), /CODE_VERSION_CHANGED/); assert.equal(f.counters.prepare, 0);
});

test('SYNTHETIC missing or non-string thread identity is rejected before lock or methods', async t => {
  const f = await fixture(t);
  for (const threadId of [undefined, null, 14]) {
    await assert.rejects(() => f.run({ threadId }), /RUNTIME_ARGUMENT_INVALID/);
  }
  await assert.rejects(() => f.run({ cycleId: 14 }), /RUNTIME_ARGUMENT_INVALID/);
  assert.equal(f.counters.prepare, 0); assert.equal(f.counters.generate, 0);
});

test('SYNTHETIC code edit while model runs blocks publication, no second model sample', async t => {
  const f = await fixture(t);
  f.deps.generate = async (_, { beforePublish }) => { f.counters.generate++; await writeFile(join(f.root, 'scripts/m1-runtime-events.mjs'), 'UNAPPROVED'); await beforePublish(); };
  const result = await f.run(); assert.equal(result.status, 'failed'); assert.equal(result.error_code, 'CODE_VERSION_CHANGED');
  assert.equal(f.counters.generate, 1); assert.equal(result.old_results[0].status, 'available');
  assert.equal(f.runs.has(f.fresh.run_id), false);
});

test('SYNTHETIC model failure has exactly two same-run attempts and retains old result plus original last success', async t => {
  const f = await fixture(t), success = await f.run();
  f.clearPublication(); f.setLatest(goodResult('mature', 'missing_data'));
  f.deps.generate = async directory => { assert.equal(directory, 'SYNTHETIC-runDir'); f.counters.generate++; throw Error('SYNTHETIC quota failure'); };
  const failed = await f.run({ cycleId: 'SYNTHETIC-next' });
  assert.equal(failed.status, 'failed'); assert.equal(failed.error_code, 'GENERATION_FAILED');
  assert.equal(failed.old_results[0].status, 'available'); assert.deepEqual(failed.last_success, success.last_success);
  assert.equal(f.counters.prepare, 2); assert.equal(f.counters.generate, 3);
  assert.equal((await f.run({ cycleId: 'SYNTHETIC-next' })).status, 'DUPLICATE_CYCLE'); assert.equal(f.counters.generate, 3);
});

test('SYNTHETIC completed h24 and already scored h12 are not re-captured; new mature boundary and missing data are', async t => {
  const f = await fixture(t), at = hours => new Date((anchor + hours * 3600) * 1000).toISOString();
  assert.equal(needsOutcome(f.old, null, at(5)), false);
  assert.equal(needsOutcome(f.old, null, at(6)), true);
  assert.equal(needsOutcome(f.old, goodResult('mature', 'partial'), at(11)), false);
  assert.equal(needsOutcome(f.old, goodResult('mature', 'partial'), at(12)), true);
  assert.equal(needsOutcome(f.old, goodResult(), at(13)), false);
  assert.equal(needsOutcome(f.old, goodResult('mature', 'mature', 'mature'), at(100)), false);
  assert.equal(needsOutcome(f.old, goodResult('mature', 'mature', 'missing_data'), at(100)), true);
  f.setLatest(goodResult('mature', 'mature', 'mature')); await f.run(); assert.equal(f.counters.capture, 0);
});

test('SYNTHETIC late publication is archived once and never retried to obtain a nicer result', async t => {
  const f = await fixture(t); f.fresh.forecast.status = 'late';
  const result = await f.run(); assert.equal(result.status, 'late'); assert.equal(result.error_code, 'PUBLICATION_LATE');
  assert.equal(result.last_success, null); assert.equal(result.latest_valid_run_id, f.old.run_id); assert.equal(f.counters.generate, 1);
});

test('SYNTHETIC pause during active operation keeps lock until work ends, then next cycle skips and resumes', async t => {
  const f = await fixture(t), generate = f.deps.generate, pause = join(f.root, 'artifacts/m1-runtime/PAUSED');
  f.deps.generate = async (...args) => {
    await writeFile(pause, 'SYNTHETIC pause'); assert.equal(realExecutor.owned(f.context, 'm1-cycle-manual-SYNTHETIC-thread').issue_number, 0);
    assert.equal((await f.run({ cycleId: 'SYNTHETIC-overlap' })).status, 'USER_PAUSED'); return generate(...args);
  };
  assert.equal((await f.run()).status, 'completed'); assert.equal((await f.run({ cycleId: 'SYNTHETIC-next' })).status, 'USER_PAUSED');
  await rm(pause); f.deps.generate = generate; f.clearPublication(); assert.equal((await f.run({ cycleId: 'SYNTHETIC-next' })).status, 'completed');
});

test('SYNTHETIC interrupted state is retained across restart and no catch-up forecast is created', async t => {
  const f = await fixture(t), stateFile = join(f.root, 'artifacts/m1-runtime/status.json');
  const interrupted = { status: 'running', cycle_id: 'SYNTHETIC-interrupted', stage: 'generate' };
  await writeFile(stateFile, encode(interrupted));
  assert.equal((await f.run()).status, 'INCOMPLETE_PRIOR_CYCLE'); assert.equal(f.counters.prepare, 0);
  assert.deepEqual(await f.state(), interrupted);
});

test('SYNTHETIC release missing transitive source and symlinked source fail closed', async t => {
  const f = await fixture(t); delete f.release.code_sha256['src/m1-evaluation.ts']; await writeFile(f.releaseFile, encode(f.release));
  await assert.rejects(() => verifyRuntimeRelease({ root: f.root, releaseFile: f.releaseFile }), /RELEASE_INVALID/);
  f.release.code_sha256['src/m1-evaluation.ts'] = digest(await readFile('src/m1-evaluation.ts')); await writeFile(f.releaseFile, encode(f.release));
  await rm(join(f.root, 'src/m1-evaluation.ts')); await symlink(resolve('src/m1-evaluation.ts'), join(f.root, 'src/m1-evaluation.ts'));
  await assert.rejects(() => verifyRuntimeRelease({ root: f.root, releaseFile: f.releaseFile }), /SYMLINK/);
});

test('SYNTHETIC bounded official event capture preserves HTTP failure and explicitly remains market_only', async t => {
  const f = await fixture(t); let count = 0;
  const file = await collectRuntimeEvents({ root: f.root, directory: join(f.root, 'artifacts/events'),
    transport: async (url, output) => { count++; assert.match(url, /^https:\/\/(www\.federalreserve\.gov|www\.bls\.gov)\//);
      if (count === 1) { await writeFile(output, 'SYNTHETIC official calendar without first-publication evidence'); return { curl_exit_code: 0, http_code: '200', error: null }; }
      return { curl_exit_code: 28, http_code: null, error: 'OFFICIAL_SOURCE_FETCH_FAILED' }; } });
  const events = JSON.parse(await readFile(file, 'utf8')); assert.equal(count, 2); assert.equal(events.mode, 'market_only');
  assert.equal(events.event_risk_incorporated, false); assert.deepEqual(events.items, []);
  assert.equal(events.sources[1].curl_exit_code, 28); assert.equal(events.sources[0].published_at, null);
  for (const source of events.sources) assert.equal(digest(await readFile(join(f.root, source.raw_path))), source.raw_sha256);
});

test('SYNTHETIC real runner invokes release guard immediately before publication and preserves rejected attempt', async t => {
  const f = await fixture(t), bin = join(f.root, 'bin'); await mkdir(bin);
  const executable = `#!${process.execPath}\nconst a=process.argv.slice(2);if(a[0]==='--version')console.log('SYNTHETIC-cli');else if(a[0]==='login')console.error('Logged in using ChatGPT');else {process.stdin.resume();process.stdin.on('end',async()=>{(await import('node:fs')).writeFileSync(a[a.indexOf('--output-last-message')+1],'{}');console.log('{"type":"turn.completed"}');});}\n`;
  await writeFile(join(bin, 'codex'), executable, { mode: 0o700 });
  const source = resolve('scripts/m1-forecast.mjs'), run = await newRun(join(f.root, 'artifacts/forecast-runs'));
  await freezeInput(run.runDir, { anchor_time: Math.floor(Date.now() / 900000) * 900, anchor_price: 100 },
    'SYNTHETIC only. No model is invoked.', rawOutputJsonSchema, { code_sha256: { [source]: digest(await readFile(source)) } });
  const originalPath = process.env.PATH; let called = false;
  try {
    process.env.PATH = bin;
    await assert.rejects(() => generateForecast(run.runDir, { beforePublish: async () => { called = true; throw Error('CODE_VERSION_CHANGED'); } }), /CODE_VERSION_CHANGED/);
  } finally { process.env.PATH = originalPath; }
  assert.equal(called, true); assert.equal(await readPublished(run.runDir), null);
  const receipt = JSON.parse(await readFile(join(run.runDir, 'attempt-001/receipt.json'), 'utf8'));
  assert.equal(receipt.exit_code, 0); assert.ok(receipt.raw_output_sha256);
  assert.equal(JSON.parse(await readFile(join(run.runDir, 'attempt-001/validation-result.json'), 'utf8')).error, 'CODE_VERSION_CHANGED');
});

test('SYNTHETIC complete immutable h24 revision is not reacquired after a later failed capture', async t => {
  const f = await fixture(t), revision = 'evaluation-20260913T000000000Z-00000000-0000-0000-0000-000000000000';
  await mkdir(join(f.root, 'artifacts/m1-outcomes', f.old.run_id, 'evaluations', revision), { recursive: true });
  f.setLatest({ status: 'failed', reason: 'evaluation_failed' });
  f.deps.store.readRevision = async (_, value) => { assert.equal(value, revision); return goodResult('mature', 'mature', 'mature'); };
  const result = await f.run(); assert.equal(result.old_results[0].status, 'complete');
  assert.equal(result.old_results[0].latest_attempt_status, 'failed'); assert.equal(f.counters.capture, 0);
});
