import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createDisplayReader, m1DisplayPlugin } from '../scripts/m1-display.mjs';
import { loadRuntimeDisplay, runtimeDisplaySchema } from '../src/m1-display.ts';
import { REQUIRED_CODE_FILES } from '../scripts/m1-runtime.mjs';

const time = '2026-09-13T08:00:00.000Z';
const forecastId = 'm1-20260913T070000000Z-00000000-0000-4000-8000-000000000014';
const privateValue = 'SYNTHETIC_PRIVATE_PATH_AND_ERROR';
const configuration = { schema: 'MFV:M1_RUNTIME_CONFIGURATION:v1', local_only: true,
  task_name: 'M1 实验预测运行', task_id: privateValue, frequency_hours: 2, time_zone: null,
  enabled: true, next_run_at: '2026-09-13T09:00:00.000Z', read_back_at: time,
  working_directory: privateValue, prompt: privateValue };
const state = { schema: 'MFV:M1_RUNTIME_STATE:v1', local_only: true,
  cycle_id: 'm1-cycle-scheduled-00000000-0000-4000-8000-000000000014', trigger: 'scheduled',
  thread_id: privateValue, release_id: privateValue, release_sha256: 'a'.repeat(64),
  status: 'failed', stage: 'generate', started_at: time, updated_at: time, completed_at: time,
  error_code: 'GENERATION_FAILED', error: privateValue, new_forecast: null,
  old_results: [{ run_id: forecastId, raw_path: privateValue }],
  last_success: { cycle_id: 'prior-synthetic-success', completed_at: time, forecast_id: forecastId } };

async function fixture(t) {
  const parent = resolve('artifacts/m14'); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'synthetic-runtime-display-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'artifacts/m1-runtime'); await mkdir(directory, { recursive: true });
  const save = (name, value) => writeFile(join(directory, name), JSON.stringify(value));
  return { root, directory, save, reader: createDisplayReader({ root }) };
}

test('runtime read is empty until configured; repeated reads do not create records or infer a schedule', async t => {
  const f = await fixture(t), result = await f.reader.readRuntime({ now: time });
  assert.deepEqual(result, { schema: 'MFV:M1_RUNTIME_DISPLAY:v1', checked_at: time,
    release_integrity: 'unconfigured',
    configuration: null, paused: false, latest_attempt: null, last_success: null });
  await f.save('configuration.json', configuration); const before = await readFile(join(f.directory, 'configuration.json'));
  const configured = await f.reader.readRuntime({ now: time });
  assert.equal(configured.configuration.time_zone, null); assert.equal(configured.configuration.next_run_at, null);
  assert.equal(configured.configuration.read_back_at, time);
  await f.reader.readRuntime({ now: time }); assert.deepEqual(await readFile(join(f.directory, 'configuration.json')), before);
  assert.equal(JSON.stringify(configured).includes(privateValue), false);
});

test('latest failure preserves explicit prior business success and strips all archive-only fields', async t => {
  const f = await fixture(t); await f.save('configuration.json', configuration); await f.save('status.json', state);
  const result = await f.reader.readRuntime({ now: time });
  assert.equal(result.latest_attempt.status, 'failed'); assert.equal(result.latest_attempt.reason, 'runtime_failed');
  assert.equal(result.last_success.forecast_id, forecastId); assert.equal(result.latest_attempt.forecast_id, null);
  assert.equal(JSON.stringify(result).includes(privateValue), false);
  assert.deepEqual(Object.keys(result), ['schema', 'checked_at', 'release_integrity', 'configuration', 'paused', 'latest_attempt', 'last_success']);
  await f.save('status.json', { ...state, status: 'skipped', error_code: 'CODE_VERSION_CHANGED' });
  assert.equal((await f.reader.readRuntime({ now: time })).latest_attempt.reason, 'code_changed');
  await writeFile(join(f.directory, 'PAUSED'), '');
  const paused = await f.reader.readRuntime({ now: time }); assert.equal(paused.paused, true);
  assert.equal(paused.configuration.enabled, true); // Actual pause remains distinct from an earlier official configuration readback.
});

test('runtime corruption and symlinks fail closed without returning raw errors', async t => {
  const f = await fixture(t);
  await f.save('status.json', { ...state, cycle_id: '../private-file' });
  await assert.rejects(() => f.reader.readRuntime({ now: time }));
  await f.save('status.json', { ...state, status: 'completed' });
  await assert.rejects(() => f.reader.readRuntime({ now: time }), /runtime status relationship/);
  await f.save('status.json', { ...state, status: 'running', completed_at: null });
  assert.equal((await f.reader.readRuntime({ now: time })).latest_attempt.status, 'running');
  await f.save('configuration.json', { ...configuration, time_zone: privateValue });
  await assert.rejects(() => f.reader.readRuntime({ now: time }));
  await rm(join(f.directory, 'configuration.json'));
  await symlink(join(f.directory, 'status.json'), join(f.directory, 'configuration.json'));
  await assert.rejects(() => f.reader.readRuntime({ now: time }), /SYMLINK_FORBIDDEN/);
});

test('read-only integrity detects source or manifest replacement without fabricating an attempt', async t => {
  const f = await fixture(t), digest = value => createHash('sha256').update(value).digest('hex');
  const code = {};
  for (const name of REQUIRED_CODE_FILES) {
    await mkdir(dirname(join(f.root, name)), { recursive: true });
    const content = '// SYNTHETIC bytes only. This file must never execute.\n';
    await writeFile(join(f.root, name), content); code[name] = digest(content);
  }
  const releaseFile = 'artifacts/m1-runtime/releases/synthetic-readonly.json';
  const release = JSON.stringify({ schema: 'MFV:M1_RUNTIME_RELEASE:v1', local_only: true, code_sha256: code });
  await mkdir(dirname(join(f.root, releaseFile)), { recursive: true });
  await writeFile(join(f.root, releaseFile), release);
  const config = { ...configuration, release_file: releaseFile, release_sha256: digest(release) };
  await f.save('configuration.json', config); await f.save('status.json', state);
  const before = await readFile(join(f.directory, 'status.json'));
  assert.equal((await f.reader.readRuntime({ now: time })).release_integrity, 'verified');
  await writeFile(join(f.root, 'scripts/executor.mjs'), 'throw Error("MUST_NOT_EXECUTE");');
  const changed = await f.reader.readRuntime({ now: time }); assert.equal(changed.release_integrity, 'changed');
  assert.equal(changed.latest_attempt.status, 'failed'); assert.deepEqual(await readFile(join(f.directory, 'status.json')), before);
  await writeFile(join(f.root, releaseFile), release + ' ');
  assert.equal((await f.reader.readRuntime({ now: time })).release_integrity, 'changed');
  await f.save('configuration.json', { ...config, release_file: '../../private.json' });
  assert.equal((await f.reader.readRuntime({ now: time })).release_integrity, 'unknown');
  await f.save('configuration.json', { ...config, release_file: 'artifacts/m1-runtime/releases/missing.json' });
  assert.equal((await f.reader.readRuntime({ now: time })).release_integrity, 'unknown');
  assert.equal(JSON.stringify(changed).includes(releaseFile), false);
});

function middleware(plugin) {
  let handler; plugin.configureServer({ middlewares: { use: value => { handler = value; } } });
  return async (url, { method = 'GET', headers = {} } = {}) => {
    let result; const responseHeaders = {};
    const response = { statusCode: 200, setHeader: (key, value) => { responseHeaders[key] = value; },
      end: body => { result = { status: response.statusCode, headers: responseHeaders, body: JSON.parse(body) }; } };
    await handler({ url, method, headers: { host: '127.0.0.1:5173', ...headers },
      socket: { localAddress: '127.0.0.1', remoteAddress: '127.0.0.1', localPort: 5173 } }, response,
    () => { result = { status: 'next' }; });
    return result;
  };
}

test('runtime endpoint shares strict local GET and exact-route guards with existing display routes', async t => {
  const f = await fixture(t), get = middleware(m1DisplayPlugin({ root: f.root }));
  const result = await get('/api/m1/runtime'); assert.equal(result.status, 200);
  assert.equal(result.headers['Cache-Control'], 'no-store');
  assert.equal((await get('/api/m1/runtime', { method: 'POST' })).status, 405);
  for (const headers of [{ host: 'evil.example' }, { origin: 'http://evil.example' }, { referer: 'http://evil.example/' }, { 'sec-fetch-site': 'cross-site' }]) {
    assert.equal((await get('/api/m1/runtime', { headers })).status, 403);
  }
  for (const path of ['/api/m1/runtime?file=status.json', '/api/m1/runtime/../status.json', '/api/m1/runtime.json']) assert.equal((await get(path)).status, 404);
  await f.save('status.json', { ...state, status: privateValue });
  assert.deepEqual((await get('/api/m1/runtime')).body, { error: 'DISPLAY_ARCHIVE_UNAVAILABLE' });
});

test('runtime client accepts only the white list and rejects duplicate, extra, and contradictory fields', async t => {
  const f = await fixture(t), originalFetch = globalThis.fetch; t.after(() => { globalThis.fetch = originalFetch; });
  const value = await f.reader.readRuntime({ now: time });
  const reply = body => { globalThis.fetch = async (url, options) => {
    assert.equal(url, '/api/m1/runtime'); assert.equal(options.method, 'GET'); assert.equal(options.cache, 'no-store');
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  }; };
  reply(value); assert.deepEqual(await loadRuntimeDisplay(), value);
  reply({ ...value, raw_error: privateValue }); await assert.rejects(() => loadRuntimeDisplay());
  reply('{"schema":"MFV:M1_RUNTIME_DISPLAY:v1","schema":"MFV:M1_RUNTIME_DISPLAY:v1"}'); await assert.rejects(() => loadRuntimeDisplay());
  assert.equal(runtimeDisplaySchema.safeParse({ ...value, configuration: { ...configuration, next_run_at: time } }).success, false);
});
