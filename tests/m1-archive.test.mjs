import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, realpath, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newRun, freezeInput, readFrozen, assertFrozenCode, prepareAttempt, completeAttempt, publishRun, readPublished } from '../scripts/m1-archive.mjs';
import { METHOD_VERSION, PROMPT_VERSION, CATEGORY_IDS, rawOutputJsonSchema } from '../src/m1-contracts.ts';

const hash = value => createHash('sha256').update(value).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
async function fixture(t, { late = false } = {}) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'mfv-m1-archive-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { runDir, run_id } = await newRun(root);
  const codeFile = join(runDir, 'method-fixture.mjs'); await writeFile(codeFile, '// original fixture method\n');
  const provenance = { method_version: METHOD_VERSION, prompt_version: PROMPT_VERSION, code_sha256: { [codeFile]: hash(await readFile(codeFile)) } };
  const input = { anchor_time: Math.floor(Date.now() / 900000) * 900 - (late ? 900 : 0), anchor_price: 100,
    history: { source: { raw_responses: [] } }, features: {}, events: { mode: 'market_only', information_cutoff: new Date().toISOString(), sources: [], event_risk_incorporated: false } };
  return { root, runDir, run_id, input, codeFile, provenance };
}
function output(input) {
  const prices = [101, 99, 100.5, 99.5, 100, 100.6].map((first, index) => {
    const path = Array(96).fill([100, 100, 100.5, 99.5, 100, 100][index]); path[0] = first; return path;
  });
  return { schema_version: 'm1.0', method_version: METHOD_VERSION, prompt_version: PROMPT_VERSION,
    anchor_time: input.anchor_time, anchor_price: input.anchor_price,
    scenarios: CATEGORY_IDS.map((id, index) => ({ id, probability_24h: index === 0 ? 0.5 : 0.1, prices: prices[index], support: ['fixture'], counterevidence: ['fixture'], invalidations: ['fixture'] })),
    stages: [[1, 24], [25, 48], [49, 96]].map(([start_step, end_step]) => ({ start_step, end_step, lower: 98, upper: 102, explanation: 'fixture' })),
    summary: 'Fixture only; no market evidence.', limitations: ['Fixture only.'] };
}
async function freeze(f) { return freezeInput(f.runDir, f.input, 'Fixture frozen prompt.', rawOutputJsonSchema, f.provenance); }
async function successful(f, raw = output(f.input)) {
  await freeze(f);
  const attempt = await prepareAttempt(f.runDir);
  await writeFile(attempt.rawFile, json(raw), { flag: 'wx' });
  const generation = await completeAttempt(f.runDir, attempt.attempt_id, { exit_code: 0, model_config: 'fixture', model_identity_visibility: 'not_exposed', execution_mode: 'test_fixture', model_thread_id: 'fixture', turn_completed: true, unexpected_tool_events: [] });
  return { ...attempt, generation };
}

test('unique runs freeze input, prompt, schema, provenance, source bytes and real program time once', async t => {
  const f = await fixture(t);
  const other = await newRun(f.root);
  assert.notEqual(other.run_id, f.run_id);
  const source = join(f.runDir, 'source.json'); const event = join(f.runDir, 'event.raw');
  await writeFile(source, 'source fixture'); await writeFile(event, 'event fixture');
  f.input.history.source.raw_responses.push({ path: source, sha256: hash('source fixture') });
  f.input.events.sources.push({ raw_path: event, raw_sha256: hash('event fixture') });
  const before = Date.now(); const manifest = await freeze(f);
  assert.ok(Date.parse(manifest.information_frozen_at) >= before && Date.parse(manifest.information_frozen_at) <= Date.now());
  assert.deepEqual((await readFrozen(f.runDir)).input, f.input);
  assert.equal(manifest.source_files.length, 2);
  const original = await readFile(join(f.runDir, 'input.json'));
  await assert.rejects(() => freeze(f), /INPUT_ALREADY_FROZEN/);
  assert.deepEqual(await readFile(join(f.runDir, 'input.json')), original);
  await writeFile(event, 'altered event');
  await assert.rejects(() => readFrozen(f.runDir), /SOURCE_HASH_MISMATCH/);
});

for (const name of ['input.json', 'prompt.txt', 'output-schema.json', 'provenance.json']) {
  test(`altered frozen ${name} is rejected before generation`, async t => {
    const f = await fixture(t); await freeze(f);
    await writeFile(join(f.runDir, name), 'changed');
    await assert.rejects(() => readFrozen(f.runDir), /FROZEN_HASH_MISMATCH/);
    await assert.rejects(() => prepareAttempt(f.runDir), /FROZEN_HASH_MISMATCH/);
  });
}

test('an interrupted freeze is not valid and existing partial bytes cannot be overwritten', async t => {
  const f = await fixture(t);
  await writeFile(join(f.runDir, 'input.json'), 'partial input', { flag: 'wx' });
  await assert.rejects(() => readFrozen(f.runDir), /ENOENT/);
  await assert.rejects(() => freeze(f), /EEXIST/);
  assert.equal(await readFile(join(f.runDir, 'input.json'), 'utf8'), 'partial input');
});

test('attempts are exclusive, retain timeout evidence, and cannot exceed two', async t => {
  const f = await fixture(t); await freeze(f);
  const first = await prepareAttempt(f.runDir);
  await assert.rejects(() => prepareAttempt(f.runDir), /ATTEMPT_STILL_OPEN/);
  await assert.rejects(() => completeAttempt(f.runDir, first.attempt_id, { exit_code: 0 }), /SUCCESS_WITHOUT_RAW_OUTPUT/);
  await assert.rejects(() => completeAttempt(f.runDir, first.attempt_id, { exit_code: 1, ended_at: new Date().toISOString() }), /CALLER_TIMESTAMP_FORBIDDEN/);
  const failed = await completeAttempt(f.runDir, first.attempt_id, { exit_code: null, timed_out: true, signal: 'SIGTERM', error: 'fixture timeout', model_thread_id: 'fixture-thread', unexpected_tool_events: [{ type: 'tool_call' }], cli_exit_code: null, turn_completed: false });
  assert.equal(failed.timed_out, true); assert.equal(failed.model_thread_id, 'fixture-thread');
  assert.deepEqual(failed.unexpected_tool_events, [{ type: 'tool_call' }]);
  assert.ok(Date.parse(failed.ended_at) >= Date.parse(failed.started_at));
  await assert.rejects(() => completeAttempt(f.runDir, first.attempt_id, { exit_code: 1 }), /EEXIST/);
  const second = await prepareAttempt(f.runDir);
  assert.equal(second.attempt_id, 'attempt-002');
  await completeAttempt(f.runDir, second.attempt_id, { exit_code: 1, error: 'fixture quota failure' });
  await assert.rejects(() => prepareAttempt(f.runDir), /ATTEMPT_LIMIT_REACHED/);
  assert.equal(await readPublished(f.runDir), null);
});

test('a racing prepare can reserve only one active attempt', async t => {
  const f = await fixture(t); await freeze(f);
  const results = await Promise.allSettled([prepareAttempt(f.runDir), prepareAttempt(f.runDir)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.deepEqual((await readdir(f.runDir)).filter(name => name.startsWith('attempt-')), ['attempt-001']);
});

test('valid publish builds 96 UTC nodes, frozen labels and stable idempotent bundle', async t => {
  const f = await fixture(t); const attempt = await successful(f);
  const published = await publishRun(f.runDir, attempt.rawFile, attempt);
  assert.equal(published.forecast.status, 'valid'); assert.equal(published.forecast.eligible_as_latest, true);
  assert.equal(published.forecast.probability_kind, 'subjective_uncalibrated');
  assert.equal(published.forecast.range_kind, 'model_range_estimate');
  assert.equal(published.forecast.event_risk_label, '未纳入事件风险');
  assert.equal(published.forecast.scenarios[0].points.length, 96);
  assert.equal(published.forecast.scenarios[0].points[0].time, f.input.anchor_time + 900);
  assert.equal(published.forecast.scenarios[0].points.at(-1).time, f.input.anchor_time + 86400);
  assert.deepEqual(published.forecast.stages.map(stage => [stage.start_time, stage.end_time]), [[0, 21600], [21600, 43200], [43200, 86400]].map(pair => pair.map(value => f.input.anchor_time + value)));
  assert.equal(published.receipt.first_published_at, published.receipt.published_at);
  assert.equal(published.receipt.generation_started_at, attempt.started_at);
  assert.equal(published.receipt.generation_ended_at, attempt.generation.ended_at);
  const snapshot = await readFile(join(f.runDir, 'publication', 'receipt.json'));
  assert.deepEqual(await publishRun(f.runDir, attempt.rawFile, attempt), published);
  assert.deepEqual(await readPublished(f.runDir), published);
  assert.deepEqual(await readFile(join(f.runDir, 'publication', 'receipt.json')), snapshot);
  await assert.rejects(() => prepareAttempt(f.runDir), /RUN_ALREADY_PUBLISHED/);
});

test('late publication keeps original nodes and is never latest-eligible', async t => {
  const f = await fixture(t, { late: true }); const attempt = await successful(f);
  const published = await publishRun(f.runDir, attempt.rawFile, attempt);
  assert.equal(published.forecast.status, 'late'); assert.equal(published.forecast.eligible_as_latest, false);
  assert.equal(published.forecast.anchor_time, f.input.anchor_time);
  assert.equal(published.forecast.scenarios[0].points[0].time, f.input.anchor_time + 900);
});

test('raw output edits after completion or publication fail integrity checks', async t => {
  const f = await fixture(t); const attempt = await successful(f);
  await publishRun(f.runDir, attempt.rawFile, attempt);
  await writeFile(attempt.rawFile, json({ ...output(f.input), summary: 'rewritten' }));
  await assert.rejects(() => readPublished(f.runDir), /RAW_OUTPUT_HASH_MISMATCH/);
  await assert.rejects(() => publishRun(f.runDir, attempt.rawFile, attempt), /RAW_OUTPUT_HASH_MISMATCH/);
});

test('editing input and replacing its manifest hash still fails the attempt binding', async t => {
  const f = await fixture(t); const attempt = await successful(f);
  await publishRun(f.runDir, attempt.rawFile, attempt);
  const altered = json({ ...f.input, anchor_price: 101 }); await writeFile(join(f.runDir, 'input.json'), altered);
  const manifest = JSON.parse(await readFile(join(f.runDir, 'manifest.json'), 'utf8'));
  manifest.files['input.json'] = hash(altered); await writeFile(join(f.runDir, 'manifest.json'), json(manifest));
  await assert.rejects(() => readPublished(f.runDir), /ATTEMPT_INPUT_CHANGED/);
});

test('altered forecast or generation receipt cannot be read as valid publication', async t => {
  const first = await fixture(t); const attempt = await successful(first);
  await publishRun(first.runDir, attempt.rawFile, attempt);
  await writeFile(join(first.runDir, 'publication', 'forecast.json'), '{}');
  await assert.rejects(() => readPublished(first.runDir), /PUBLICATION_HASH_MISMATCH/);
  const second = await fixture(t); const secondAttempt = await successful(second);
  await publishRun(second.runDir, secondAttempt.rawFile, secondAttempt);
  const file = join(secondAttempt.attemptDir, 'receipt.json');
  const changed = JSON.parse(await readFile(file, 'utf8')); changed.model_identity = 'rewritten'; await writeFile(file, json(changed));
  await assert.rejects(() => readPublished(second.runDir), /PUBLISHED_ATTEMPT_CHANGED/);
});

test('abandoned temporary publication is ignored; retry commits a complete bundle', async t => {
  const f = await fixture(t); const attempt = await successful(f);
  const interrupted = join(f.runDir, '.publication-interrupted.tmp'); await mkdir(interrupted);
  await writeFile(join(interrupted, 'forecast.json'), '{}');
  assert.equal(await readPublished(f.runDir), null);
  const published = await publishRun(f.runDir, attempt.rawFile, attempt);
  assert.equal(published.forecast.status, 'valid');
  assert.equal(await readFile(join(interrupted, 'forecast.json'), 'utf8'), '{}');
  assert.deepEqual((await readdir(join(f.runDir, 'publication'))).sort(), ['forecast.json', 'manifest.json', 'receipt.json']);
});

test('bad model probabilities never publish or damage the preceding good run', async t => {
  const good = await fixture(t); const goodAttempt = await successful(good);
  const before = await publishRun(good.runDir, goodAttempt.rawFile, goodAttempt);
  const bad = await fixture(t); const raw = output(bad.input); raw.scenarios[0].probability_24h = 0.4;
  const badAttempt = await successful(bad, raw);
  await assert.rejects(() => publishRun(bad.runDir, badAttempt.rawFile, badAttempt));
  assert.equal(await readPublished(bad.runDir), null);
  assert.deepEqual(await readPublished(good.runDir), before);
});

test('wrong frozen schema and raw files outside the selected attempt are refused', async t => {
  const f = await fixture(t);
  await freezeInput(f.runDir, f.input, 'fixture', { type: 'object' }, f.provenance);
  const attempt = await prepareAttempt(f.runDir); await writeFile(attempt.rawFile, json(output(f.input)), { flag: 'wx' });
  await completeAttempt(f.runDir, attempt.attempt_id, { exit_code: 0 });
  await assert.rejects(() => publishRun(f.runDir, join(f.runDir, 'other.json'), attempt), /RAW_OUTPUT_NOT_IN_ATTEMPT/);
  await assert.rejects(() => publishRun(f.runDir, attempt.rawFile, attempt), /FROZEN_SCHEMA_VERSION_MISMATCH/);
  assert.equal(await readPublished(f.runDir), null);
});

test('method changes reject generation and first publish while preserving historical readability', async t => {
  const beforeGeneration = await fixture(t); await freeze(beforeGeneration);
  await writeFile(beforeGeneration.codeFile, '// changed fixture method\n');
  await assert.rejects(() => assertFrozenCode(beforeGeneration.runDir), /METHOD_CODE_CHANGED/);
  await assert.rejects(() => prepareAttempt(beforeGeneration.runDir), /METHOD_CODE_CHANGED/);

  const beforePublish = await fixture(t); const attempt = await successful(beforePublish);
  await writeFile(beforePublish.codeFile, '// changed fixture method\n');
  await assert.rejects(() => publishRun(beforePublish.runDir, attempt.rawFile, attempt), /METHOD_CODE_CHANGED/);
  assert.equal(await readPublished(beforePublish.runDir), null);

  const historical = await fixture(t); const oldAttempt = await successful(historical);
  const original = await publishRun(historical.runDir, oldAttempt.rawFile, oldAttempt);
  await writeFile(historical.codeFile, '// later upgraded fixture method\n');
  assert.deepEqual(await readPublished(historical.runDir), original);
  assert.deepEqual(await publishRun(historical.runDir, oldAttempt.rawFile, oldAttempt), original);
});
