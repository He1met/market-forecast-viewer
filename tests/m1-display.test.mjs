import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, symlink, rename } from 'node:fs/promises';
import { request } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, preview, resolveConfig } from 'vite';
import config from '../vite.config.ts';
import { seal } from '../src/contracts.ts';
import { METHOD_VERSION, PROMPT_VERSION, CATEGORY_IDS, rawOutputJsonSchema } from '../src/m1-contracts.ts';
import { displayRunSchema, indexSchema, loadDisplayIndex, loadDisplayRun } from '../src/m1-display.ts';
import { newRun, freezeInput, prepareAttempt, completeAttempt, publishRun } from '../scripts/m1-archive.mjs';
import { createDisplayReader, m1DisplayPlugin } from '../scripts/m1-display.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const hash = value => createHash('sha256').update(value).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const model_config = { provider: 'official_codex', selection: 'existing_local_cli_configuration',
  cli_version: 'codex-cli 0.0.0-synthetic-test', auth_method: 'chatgpt_verified', sandbox: 'read-only', output_schema: true, startup_warning_count: 0 };

/** All prices/sources/outputs here are explicitly synthetic and kept under LOCAL_ONLY artifacts. */
async function fixture(t) {
  await mkdir(join(root, 'artifacts/m12'), { recursive: true });
  const runsRoot = await mkdtemp(join(root, 'artifacts/m12/synthetic-display-'));
  t.after(() => rm(runsRoot, { recursive: true, force: true }));
  const sourceId = `m12-synthetic-${randomUUID()}`;
  const sourceDir = join(root, 'artifacts/data-source', sourceId);
  await mkdir(sourceDir, { recursive: true });
  t.after(() => rm(sourceDir, { recursive: true, force: true }));
  const source = `artifacts/data-source/${sourceId}/page-001.json`;
  const sentinel = `SYNTHETIC_PRIVATE_INPUT_${randomUUID()}`;
  await writeFile(join(root, source), sentinel);
  const reader = createDisplayReader({ root, runsRoot });
  async function add({ late = false, publish = true, fail = false } = {}) {
    const run = await newRun(runsRoot), anchor = Math.floor(Date.now() / 900000) * 900 - (late ? 900 : 0);
    const template = JSON.parse(await readFile(join(root, 'public/data/history.json'), 'utf8'));
    const start = anchor - 14 * 86400;
    const history = await seal({ ...template, start_time: start, end_time: anchor, downloaded_at: new Date().toISOString(),
      source: { ...template.source, request: { ...template.source.request, requested_start_time: start, requested_end_time: anchor },
        raw_responses: [{ path: source, sha256: hash(sentinel), requested_at: new Date().toISOString(),
          params: { instId: 'BTC-USDT-SWAP', bar: '15m', limit: 300 }, response_code: '0' }] },
      candles: Array.from({ length: 1344 }, (_, index) => ({ open_time: start + index * 900, close_time: start + (index + 1) * 900,
        open: 100, high: 100, low: 100, close: 100, volume_contracts: 0, volume_base: 0, volume_quote: 0, closed: true })) });
    const input = { schema_version: 'm1-input.0', history, anchor_time: anchor, anchor_price: 100,
      features: { synthetic: sentinel }, events: { mode: 'market_only', information_cutoff: new Date().toISOString(), sources: [], event_risk_incorporated: false },
      model_context: { synthetic: sentinel } };
    const code = join(run.runDir, 'synthetic-method.mjs'); await writeFile(code, '// synthetic fixture only\n');
    await freezeInput(run.runDir, input, sentinel, rawOutputJsonSchema,
      { method_version: METHOD_VERSION, prompt_version: PROMPT_VERSION, code_sha256: { [code]: hash(await readFile(code)) } });
    const attempt = await prepareAttempt(run.runDir);
    const prices = [101, 99, 100.5, 99.5, 100, 100.6].map((first, index) => {
      const values = Array(96).fill([100, 100, 100.5, 99.5, 100, 100][index]); values[0] = first; return values;
    });
    const raw = { schema_version: 'm1.0', method_version: METHOD_VERSION, prompt_version: PROMPT_VERSION,
      anchor_time: anchor, anchor_price: 100,
      scenarios: CATEGORY_IDS.map((id, index) => ({ id, probability_24h: index === 0 ? 0.5 : 0.1, prices: prices[index],
        support: ['SYNTHETIC DISPLAY TEST'], counterevidence: ['SYNTHETIC DISPLAY TEST'], invalidations: ['SYNTHETIC DISPLAY TEST'] })),
      stages: [[1, 24], [25, 48], [49, 96]].map(([start_step, end_step]) => ({ start_step, end_step, lower: 98, upper: 102, explanation: 'SYNTHETIC DISPLAY TEST' })),
      summary: 'SYNTHETIC DISPLAY TEST; no market evidence.', limitations: ['SYNTHETIC DISPLAY TEST'] };
    await writeFile(attempt.rawFile, json(raw));
    await completeAttempt(run.runDir, attempt.attempt_id, { exit_code: fail ? 1 : 0, error: fail ? sentinel : null,
      model_config, model_identity: null, model_identity_visibility: 'not_exposed_by_jsonl' });
    if (publish && !fail) await publishRun(run.runDir, attempt.rawFile, attempt);
    return { ...run, attempt, input, raw, code };
  }
  return { root, runsRoot, sourceDir, source, reader, sentinel, add };
}

test('display projects only approved fields and read-only historical bytes remain identical', async t => {
  const f = await fixture(t), first = await f.add();
  const before = await f.reader.readRun(first.run_id);
  const inputBytes = await readFile(join(first.runDir, 'input.json'));
  const forecastBytes = await readFile(join(first.runDir, 'publication/forecast.json'));
  const listing = await readdir(first.runDir);
  await f.add({ fail: true });
  const index = await f.reader.readIndex();
  assert.equal(index.latest_run_id, first.run_id);
  assert.equal(index.latest_attempt.status, 'failed');
  assert.equal(index.latest_attempt.reason, 'generation_failed');
  const after = await f.reader.readRun(first.run_id);
  assert.deepEqual(before, after);
  assert.deepEqual(await readFile(join(first.runDir, 'input.json')), inputBytes);
  assert.deepEqual(await readFile(join(first.runDir, 'publication/forecast.json')), forecastBytes);
  assert.deepEqual(await readdir(first.runDir), listing);
  const serialized = JSON.stringify(after);
  for (const forbidden of [f.sentinel, 'raw_responses', 'model_context', 'prompt.txt', 'model_thread_id', root, f.source]) assert.equal(serialized.includes(forbidden), false);
  assert.equal(after.history.candles.length, 1344);
  assert.equal(after.forecast.scenarios[0].points.length, 96);
  assert.equal(after.evaluation.status, 'not_evaluated');
  await writeFile(first.code, '// later method version\n');
  assert.deepEqual(await f.reader.readRun(first.run_id), before, 'historical display must not require current method code hashes');
});

test('index preserves empty, incomplete, late, expired, failed and corrupt states distinctly', async t => {
  const f = await fixture(t);
  assert.deepEqual((await f.reader.readIndex()).runs, []);
  const good = await f.add(), late = await f.add({ late: true }), incomplete = await f.add({ publish: false });
  let index = await f.reader.readIndex();
  assert.equal(index.latest_run_id, good.run_id);
  assert.equal(index.runs.find(run => run.run_id === late.run_id).reason, 'publication_late');
  assert.equal(index.runs.find(run => run.run_id === incomplete.run_id).reason, 'publication_missing');
  assert.equal((await f.reader.readRun(late.run_id)).forecast.status, 'late');
  index = await f.reader.readIndex({ now: new Date(Date.now() + 25 * 3600000).toISOString() });
  assert.equal(index.latest_run_id, null);
  assert.equal(index.runs.find(run => run.run_id === good.run_id).reason, 'forecast_expired');
  await writeFile(join(incomplete.runDir, 'input.json'), '{}');
  assert.equal((await f.reader.readIndex()).runs.find(run => run.run_id === incomplete.run_id).status, 'invalid');
  await assert.rejects(() => f.reader.readRun(incomplete.run_id));
  await assert.rejects(() => f.reader.readRun('../input.json'));
  const prep = await newRun(f.runsRoot);
  assert.equal((await f.reader.readIndex()).runs.find(run => run.run_id === prep.run_id).reason, 'generation_incomplete');
  await writeFile(join(prep.runDir, 'preparation-failure.json'), json({ status: 'failed', at: new Date().toISOString(), error: f.sentinel, visibility: 'LOCAL_ONLY' }));
  // Non-production roots cannot acquire the production preparation exemption.
  assert.equal((await f.reader.readIndex()).runs.find(run => run.run_id === prep.run_id).reason, 'archive_invalid');
  const validation = await f.add({ publish: false });
  await writeFile(join(validation.attempt.attemptDir, 'validation-result.json'), json({ status: 'failed', error: f.sentinel }));
  assert.equal((await f.reader.readIndex()).runs.find(run => run.run_id === validation.run_id).reason, 'validation_failed');
  const failure = await f.add({ fail: true });
  await writeFile(failure.attempt.rawFile, 'tampered failed output');
  assert.equal((await f.reader.readIndex()).runs.find(run => run.run_id === failure.run_id).status, 'invalid');
});

test('archive tampering, unknown forecast fields, and changed path relations are refused even with updated publication hashes', async t => {
  const f = await fixture(t), run = await f.add();
  const original = await f.reader.readRun(run.run_id);
  for (const mutate of [value => { value.private_path = f.sentinel; }, value => { value.schema_version = 'm2.0'; },
    value => { value.scenarios[0].probability_24h = 0.4; }, value => { value.scenarios[0].points[0].price += 1; },
    value => { value.data_cutoff += 900; }, value => { value.stages[0].end_time += 900; }]) {
    const changed = structuredClone(original.forecast); mutate(changed);
    assert.equal(displayRunSchema.safeParse({ ...original, forecast: changed }).success, false);
  }
  const directory = join(run.runDir, 'publication');
  const forecast = structuredClone(original.forecast); forecast.unrecognized = f.sentinel;
  const receipt = JSON.parse(await readFile(join(directory, 'receipt.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  receipt.forecast_sha256 = hash(json(forecast));
  manifest.files['forecast.json'] = receipt.forecast_sha256;
  manifest.files['receipt.json'] = hash(json(receipt));
  await writeFile(join(directory, 'forecast.json'), json(forecast));
  await writeFile(join(directory, 'receipt.json'), json(receipt));
  await writeFile(join(directory, 'manifest.json'), json(manifest));
  await assert.rejects(() => f.reader.readRun(run.run_id));
  assert.equal((await f.reader.readIndex()).runs[0].status, 'invalid');
});

test('valid-looking rewritten publication cannot detach from the original model output', async t => {
  const f = await fixture(t), run = await f.add();
  const directory = join(run.runDir, 'publication');
  const forecast = JSON.parse(await readFile(join(directory, 'forecast.json'), 'utf8'));
  const receipt = JSON.parse(await readFile(join(directory, 'receipt.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  forecast.summary = 'Changed but structurally valid summary';
  receipt.forecast_sha256 = hash(json(forecast)); manifest.files['forecast.json'] = receipt.forecast_sha256;
  manifest.files['receipt.json'] = hash(json(receipt));
  await writeFile(join(directory, 'forecast.json'), json(forecast));
  await writeFile(join(directory, 'receipt.json'), json(receipt)); await writeFile(join(directory, 'manifest.json'), json(manifest));
  await assert.rejects(() => f.reader.readRun(run.run_id), /MODEL_PUBLICATION_MISMATCH/);
});

test('run directories, publication directories and source ancestors cannot be symlinks', async t => {
  const f = await fixture(t), run = await f.add();
  const moved = `${run.runDir}-original`;
  await rename(run.runDir, moved); await symlink(moved, run.runDir);
  await assert.rejects(() => f.reader.readRun(run.run_id), /SYMLINK_FORBIDDEN/);
  await rm(run.runDir); await rename(moved, run.runDir);
  const publication = join(run.runDir, 'publication');
  await rename(publication, `${publication}-original`); await symlink(`${publication}-original`, publication);
  await assert.rejects(() => f.reader.readRun(run.run_id), /SYMLINK_FORBIDDEN/);
  await rm(publication); await rename(`${publication}-original`, publication);
  await rename(f.sourceDir, `${f.sourceDir}-original`);
  t.after(() => rm(`${f.sourceDir}-original`, { recursive: true, force: true }));
  await symlink(`${f.sourceDir}-original`, f.sourceDir);
  await assert.rejects(() => f.reader.readRun(run.run_id), /SYMLINK_FORBIDDEN/);
});

function http(port, path, headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method, headers }, response => {
      let body = ''; response.setEncoding('utf8'); response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }));
    }); req.on('error', reject); req.end();
  });
}
for (const mode of ['dev', 'preview']) test(`${mode} serves only same-origin loopback GET display routes without raw file leakage`, async t => {
  const f = await fixture(t), run = await f.add();
  const options = { ...config, configFile: false, root, logLevel: 'silent',
    plugins: [m1DisplayPlugin({ root, runsRoot: f.runsRoot })],
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { ...config.server, port: 0, hmr: false, watch: null, preTransformRequests: false },
    preview: { ...config.preview, port: 0 } };
  const server = mode === 'dev' ? await createServer(options) : await preview(options);
  if (mode === 'dev') await server.listen();
  t.after(async () => { if (mode === 'dev') await server.close(); else await new Promise(resolve => server.httpServer.close(resolve)); });
  const port = server.httpServer.address().port;
  assert.equal(server.httpServer.address().address, '127.0.0.1');
  const good = await http(port, `/api/m1/runs/${run.run_id}`);
  assert.equal(good.status, 200); assert.equal(good.headers['cache-control'], 'no-store');
  assert.equal(good.headers['access-control-allow-origin'], undefined);
  assert.equal(displayRunSchema.safeParse(JSON.parse(good.body)).success, true);
  assert.equal(good.body.includes(f.sentinel), false);
  const index = await http(port, '/api/m1/index'); assert.equal(index.status, 200);
  assert.equal(indexSchema.safeParse(JSON.parse(index.body)).success, true);
  for (const path of ['/api/m1/runs/../../input.json', '/api/m1/runs/%2e%2e%2finput.json',
    `/api/m1/runs/${run.run_id}/input.json`, `/api/m1/runs/${run.run_id}?file=input.json`,
    '/api/m1/index?file=../../.env', '/api%2fm1%2findex', '/api/m1/runs/%252e%252e']) {
    const response = await http(port, path);
    assert.ok([404, 422].includes(response.status), `${path}: ${response.status}`);
    assert.equal(response.body.includes(f.sentinel), false); assert.equal(response.body.includes(root), false);
  }
  for (const headers of [{ origin: 'https://attacker.invalid' }, { host: 'attacker.invalid' },
    { referer: 'https://attacker.invalid/page' }, { 'sec-fetch-site': 'cross-site' }]) {
    const response = await http(port, '/api/m1/index', headers); assert.equal(response.status, 403);
    assert.equal(response.headers['access-control-allow-origin'], undefined);
  }
  for (const method of ['POST', 'PUT', 'DELETE', 'HEAD', 'OPTIONS']) assert.equal((await http(port, '/api/m1/index', {}, method)).status, 405);
  await writeFile(join(run.runDir, 'input.json'), f.sentinel);
  const broken = await http(port, `/api/m1/runs/${run.run_id}`);
  assert.equal(broken.status, 422); assert.deepEqual(JSON.parse(broken.body), { error: 'DISPLAY_ARCHIVE_UNAVAILABLE' });
  assert.equal(broken.body.includes(f.sentinel), false);
});

test('plugin refuses non-loopback or CORS configuration and retains every Vite private-file deny rule', async () => {
  const resolved = await resolveConfig({ root, configFile: join(root, 'vite.config.ts'), logLevel: 'silent' }, 'serve');
  const defaults = await resolveConfig({ root, configFile: false, logLevel: 'silent' }, 'serve');
  for (const pattern of defaults.server.fs.deny) assert.ok(resolved.server.fs.deny.includes(pattern));
  assert.ok(resolved.server.fs.deny.includes(`${root.replace(/\/$/, '')}/artifacts/**`));
  await assert.rejects(() => resolveConfig({ root, configFile: join(root, 'vite.config.ts'), logLevel: 'silent', server: { host: '0.0.0.0' } }, 'serve'), /STRICT_LOOPBACK/);
  await assert.rejects(() => resolveConfig({ root, configFile: join(root, 'vite.config.ts'), logLevel: 'silent', server: { cors: true } }, 'serve'), /NO_CORS/);
});

test('client rejects duplicate keys, unknown index fields, wrong run identity and contradictory latest status', async t => {
  const f = await fixture(t), run = await f.add(), display = await f.reader.readRun(run.run_id), index = await f.reader.readIndex();
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const reply = value => { globalThis.fetch = async () => new Response(typeof value === 'string' ? value : JSON.stringify(value), { headers: { 'content-type': 'application/json' } }); };
  reply(index); assert.deepEqual(await loadDisplayIndex(), index);
  reply(display); assert.deepEqual(await loadDisplayRun(run.run_id), display);
  const other = await f.add(); reply(display); await assert.rejects(() => loadDisplayRun(other.run_id), /run_id/);
  reply({ ...index, hidden_field: true }); await assert.rejects(() => loadDisplayIndex());
  reply('{"schema":"MFV:M1_INDEX:v1","schema":"MFV:M1_INDEX:v1"}'); await assert.rejects(() => loadDisplayIndex());
  assert.equal(indexSchema.safeParse({ ...index, latest_attempt: { ...index.latest_attempt, status: 'failed', reason: 'generation_failed' } }).success, false);
  assert.equal(indexSchema.safeParse({ ...index, latest_run_id: null }).success, false);
  await assert.rejects(() => loadDisplayRun('../input.json'));
});
