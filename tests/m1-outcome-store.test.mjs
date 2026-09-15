import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { createOutcomeStore } from '../scripts/m1-outcome-store.mjs';
import { CATEGORY_IDS } from '../src/m1-contracts.ts';
import { publishedForecastSchema } from '../src/m1-display.ts';

const hash = x => createHash('sha256').update(x).digest('hex');
const json = x => JSON.stringify(x, null, 2) + '\n';
async function fixture(t) {
  const home = resolve('artifacts/m13'); await mkdir(home, { recursive: true });
  const root = await mkdtemp(join(home, 'synthetic-outcome-')); t.after(() => rm(root, { recursive: true, force: true }));
  const anchor = Math.floor(Date.now() / 900000) * 900 - 30 * 3600;
  const stamp = new Date(anchor * 1000).toISOString(), id = `m1-${stamp.replace(/[-:.]/g, '')}-${randomUUID()}`;
  const prices = [101, 99, 100.5, 99.5, 100, 100.6].map((first, index) => { const p = Array(96).fill([100, 100, 100.5, 99.5, 100, 100][index]); p[0] = first; return p; });
  const published = new Date(anchor * 1000 + 100000).toISOString();
  const forecast = publishedForecastSchema.parse({ schema_version: 'm1.0', method_version: 'm1-path-events-v1', prompt_version: 'm1-codex-v1',
    anchor_time: anchor, anchor_price: 100, kind: 'experimental_forecast', run_id: id, published_at: published,
    generation_started_at: stamp, generation_ended_at: published, information_frozen_at: stamp, status: 'valid', eligible_as_latest: true,
    data_cutoff: anchor, event_cutoff: null, event_mode: 'market_only', event_risk_label: '未纳入事件风险',
    probability_kind: 'subjective_uncalibrated', probability_label: '主观未校准；24h 类别概率仅用于 24h',
    range_kind: 'model_range_estimate', range_label: '模型范围估计，未经校准',
    path_label: '代表路径不是类别的全部可能路径；显示插值不是成交轨迹', step_seconds: 900, horizon_seconds: 86400, future_count: 96,
    scenarios: CATEGORY_IDS.map((id, i) => ({ id, probability_24h: i ? .1 : .5, prices: prices[i],
      points: prices[i].map((price, n) => ({ time: anchor + (n + 1) * 900, price })),
      support: ['SYNTHETIC'], counterevidence: ['SYNTHETIC'], invalidations: ['SYNTHETIC'] })),
    stages: [[1, 24], [25, 48], [49, 96]].map(([start_step, end_step]) => ({ start_step, end_step,
      start_time: anchor + (start_step - 1) * 900, end_time: anchor + end_step * 900, lower: 98, upper: 102, explanation: 'SYNTHETIC' })),
    summary: 'SYNTHETIC storage fixture, never real evidence', limitations: ['SYNTHETIC'] });
  const run = { run_id: id, forecast, hashes: { forecast_sha256: hash(json(forecast)) } };
  await mkdir(join(root, 'src'), { recursive: true });
  for (const name of ['m1-evaluation.ts', 'm1-contracts.ts']) await writeFile(join(root, 'src', name), await readFile(`src/${name}`));
  await mkdir(join(root, 'artifacts/forecast-runs', id), { recursive: true });
  await writeFile(join(root, 'artifacts/forecast-runs', id, 'provenance.json'), json({ code_sha256: { 'src/m1-contracts.ts': hash(await readFile('src/m1-contracts.ts')) } }));
  const store = createOutcomeStore({ root });
  const rows = Array.from({ length: 96 }, (_, i) => [String((anchor + i * 900) * 1000), '100', '101', '99', '100', '1', '1', '100', '1']).reverse();
  const transport = data => async ({ file }) => { await writeFile(file, json({ code: '0', data })); return '200'; };
  const capture = data => store.capture(run, { transport: transport(data) });
  return { root, run, store, rows, capture, folder: join(root, 'artifacts/m1-outcomes', id) };
}

test('SYNTHETIC outcome capture rebuilds immutable source and repeated evaluation returns original revision/time/hash', async t => {
  const f = await fixture(t), c = await f.capture(f.rows);
  assert.equal(c.status, 'ok'); const source = await f.store.readCapture(f.run, c.capture_id);
  assert.equal(source.candles.length, 96);
  const a = await f.store.evaluateCapture(f.run, c.capture_id), b = await f.store.evaluateCapture(f.run, c.capture_id);
  assert.deepEqual(a, b); assert.equal(a.result.windows.h24.status, 'mature'); assert.ok(a.result.windows.h24.brier_score !== null);
  assert.equal((await readdir(join(f.folder, 'evaluations'))).filter(x => x.startsWith('evaluation-')).length, 1);
  assert.deepEqual(await f.store.readLatest(f.run), a);
  assert.equal(JSON.stringify(a).includes('page-001.json'), false);
});

test('SYNTHETIC missing close stays unknown; repaired capture adds revision without overwriting earlier evidence', async t => {
  const f = await fixture(t), c = await f.capture(f.rows.filter(row => Number(row[0]) !== (f.run.forecast.anchor_time + 8 * 900) * 1000));
  const a = await f.store.evaluateCapture(f.run, c.capture_id);
  assert.equal(a.result.windows.h6.status, 'missing_data'); assert.equal(a.result.windows.h24.brier_score, null);
  assert.equal(a.result.actual_points.length, 8);
  const c2 = await f.capture(f.rows), b = await f.store.evaluateCapture(f.run, c2.capture_id);
  assert.notEqual(a.revision_id, b.revision_id); assert.equal(b.result.windows.h6.status, 'mature');
  assert.deepEqual(await f.store.readRevision(f.run, a.revision_id), a);
});

test('SYNTHETIC newest failed acquisition stays visible instead of silently returning older success', async t => {
  const f = await fixture(t), c = await f.capture(f.rows); await f.store.evaluateCapture(f.run, c.capture_id);
  const failed = await f.store.capture(f.run, { transport: async () => { throw Error('SYNTHETIC network failure'); } });
  assert.equal(failed.status, 'failed'); assert.deepEqual(await f.store.readLatest(f.run), { status: 'failed', reason: 'evaluation_failed' });
});

test('SYNTHETIC computation failure is durable; unfinished attempts are distinguishable', async t => {
  const f = await fixture(t), c = await f.capture(f.rows);
  await writeFile(join(f.root, 'src/m1-contracts.ts'), 'changed method');
  await assert.rejects(() => f.store.evaluateCapture(f.run, c.capture_id), /CLASSIFIER_CODE_CHANGED/);
  assert.deepEqual(await f.store.readLatest(f.run), { status: 'failed', reason: 'evaluation_failed' });
  const attempts = await readdir(join(f.folder, 'attempts'));
  await rm(join(f.folder, 'attempts', attempts[0], 'outcome.json'));
  assert.deepEqual(await f.store.readLatest(f.run), { status: 'failed', reason: 'evaluation_incomplete' });
});

test('SYNTHETIC source and result tampering, cross-forecast binding, path traversal and symlinks fail closed', async t => {
  const f = await fixture(t), c = await f.capture(f.rows), result = await f.store.evaluateCapture(f.run, c.capture_id);
  const file = join(f.folder, 'evaluations', result.revision_id, 'result.json'), original = await readFile(file);
  await writeFile(file, '{}'); assert.equal((await f.store.readLatest(f.run)).reason, 'evaluation_invalid'); await writeFile(file, original);
  await assert.rejects(() => f.store.readRevision({ ...f.run, hashes: { forecast_sha256: 'f'.repeat(64) } }, result.revision_id));
  await assert.rejects(() => f.store.readCapture(f.run, '../capture.json'));
  const source = join(f.folder, 'captures', c.capture_id, 'page-001.json'), raw = await readFile(source);
  await writeFile(source, '{}'); assert.equal((await f.store.readLatest(f.run)).reason, 'evaluation_invalid'); await writeFile(source, raw);
  await rm(source); await symlink(join(f.root, 'src/m1-contracts.ts'), source);
  assert.equal((await f.store.readLatest(f.run)).reason, 'evaluation_invalid');
});

test('SYNTHETIC identical duplicates are counted, conflicting candles fail and unclosed bars remain missing', async t => {
  const f = await fixture(t), c = await f.capture([...f.rows, f.rows[0]]), source = await f.store.readCapture(f.run, c.capture_id);
  assert.equal(source.candles.length, 96); assert.equal(source.quality.identical_duplicates_removed, 1);
  const bad = structuredClone(f.rows[0]); bad[4] = '100.5';
  assert.equal((await f.capture([...f.rows, bad])).status, 'failed');
  const unclosed = structuredClone(f.rows); unclosed[0][8] = '0'; const u = await f.capture(unclosed);
  const e = await f.store.evaluateCapture(f.run, u.capture_id); assert.equal(e.result.windows.h24.status, 'missing_data');
});

test('SYNTHETIC malformed row timestamp remains an archived capture failure, not source tampering', async t => {
  const f = await fixture(t), rows = structuredClone(f.rows); rows[0][0] = 'bad-ts';
  const c = await f.capture(rows); assert.equal(c.status, 'failed');
  assert.equal((await f.store.readCapture(f.run, c.capture_id)).record.status, 'failed');
  assert.deepEqual(await f.store.readLatest(f.run), { status: 'failed', reason: 'evaluation_failed' });
});
