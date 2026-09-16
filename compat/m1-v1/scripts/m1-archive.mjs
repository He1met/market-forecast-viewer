import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const frozenNames = ['run.json', 'input.json', 'prompt.txt', 'output-schema.json', 'provenance.json'];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const encode = value => JSON.stringify(value, null, 2) + '\n';
const check = (condition, message) => { if (!condition) throw Error(message); };
const now = () => new Date().toISOString();
const within = (file, dir) => { const r = relative(resolve(dir), resolve(file)); return r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r); };
async function exists(file) { try { await lstat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
async function bytes(file) {
  const stat = await lstat(file);
  check(stat.isFile() && !stat.isSymbolicLink(), `NOT_REGULAR_FILE: ${basename(file)}`);
  return readFile(file);
}
async function json(file) { return JSON.parse((await bytes(file)).toString('utf8')); }
async function writeOnce(file, value) { await writeFile(file, typeof value === 'string' ? value : encode(value), { flag: 'wx', mode: 0o600 }); }
function localOnly(runDir) {
  const full = resolve(runDir);
  check(!within(full, join(projectRoot, 'public')) && !within(full, join(projectRoot, 'dist')), 'RAW_MATERIAL_MUST_BE_LOCAL_ONLY');
  return full;
}
async function runMetadata(runDir) {
  localOnly(runDir);
  const run = await json(join(runDir, 'run.json'));
  check(run.schema === 'MFV:M1_RUN:v1' && run.run_id === basename(resolve(runDir)), 'RUN_ID_MISMATCH');
  return run;
}
async function sourceFiles(input, runDir) {
  const records = [
    ...(input.history?.source?.raw_responses ?? []),
    ...(input.events?.sources ?? []).map(source => ({ path: source.raw_path, sha256: source.raw_sha256 })),
  ];
  check(Array.isArray(records), 'INVALID_SOURCE_RECORDS');
  const paths = new Set();
  const result = [];
  for (const record of records) {
    check(typeof record.path === 'string' && /^[a-f0-9]{64}$/.test(record.sha256), 'INVALID_SOURCE_REFERENCE');
    const file = resolve(projectRoot, record.path);
    check(within(file, join(projectRoot, 'artifacts', 'data-source')) || within(file, runDir), 'SOURCE_MUST_BE_LOCAL_ONLY');
    check(!paths.has(file), 'DUPLICATE_SOURCE_REFERENCE'); paths.add(file);
    check(digest(await bytes(file)) === record.sha256, 'SOURCE_HASH_MISMATCH');
    result.push({ path: record.path, sha256: record.sha256 });
  }
  return result;
}

/** Create a unique local run; no existing file or run is reused. */
export async function newRun(root = 'artifacts/forecast-runs') {
  const directory = localOnly(root);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const created_at = now();
  const run_id = `m1-${created_at.replace(/[-:.]/g, '')}-${randomUUID()}`;
  const runDir = join(directory, run_id);
  await mkdir(runDir, { mode: 0o700 });
  await writeOnce(join(runDir, 'run.json'), { schema: 'MFV:M1_RUN:v1', run_id, created_at, local_only: true });
  return { run_id, runDir };
}

/** A manifest is the commit marker for the frozen bundle; partial files are never valid input. */
export async function freezeInput(runDir, input, prompt, schema, provenance) {
  const run = await runMetadata(runDir);
  check(typeof prompt === 'string' && prompt.length > 0, 'EMPTY_PROMPT');
  check(!(await exists(join(runDir, 'manifest.json'))), 'INPUT_ALREADY_FROZEN');
  const source_files = await sourceFiles(input, runDir);
  const information_frozen_at = now();
  const content = { 'input.json': input, 'prompt.txt': prompt, 'output-schema.json': schema, 'provenance.json': provenance };
  for (const [name, value] of Object.entries(content)) await writeOnce(join(runDir, name), value);
  const files = {};
  for (const name of frozenNames) files[name] = digest(await bytes(join(runDir, name)));
  const manifest = { schema: 'MFV:M1_FROZEN:v1', run_id: run.run_id, information_frozen_at, files, source_files };
  await writeOnce(join(runDir, 'manifest.json'), manifest);
  return manifest;
}

export async function readFrozen(runDir) {
  const run = await runMetadata(runDir);
  const manifest = await json(join(runDir, 'manifest.json'));
  check(manifest.schema === 'MFV:M1_FROZEN:v1' && manifest.run_id === run.run_id, 'FROZEN_MANIFEST_MISMATCH');
  check(JSON.stringify(Object.keys(manifest.files).sort()) === JSON.stringify([...frozenNames].sort()), 'FROZEN_FILE_SET_MISMATCH');
  for (const name of frozenNames) check(digest(await bytes(join(runDir, name))) === manifest.files[name], `FROZEN_HASH_MISMATCH: ${name}`);
  const input = await json(join(runDir, 'input.json'));
  check(JSON.stringify(await sourceFiles(input, runDir)) === JSON.stringify(manifest.source_files), 'FROZEN_SOURCE_SET_MISMATCH');
  return { input, prompt: (await bytes(join(runDir, 'prompt.txt'))).toString('utf8'), schema: await json(join(runDir, 'output-schema.json')), provenance: await json(join(runDir, 'provenance.json')), manifest };
}

/** Only new generation/publication depends on the current method code; historical reads do not. */
export async function assertFrozenCode(runDir) {
  const frozen = await readFrozen(runDir);
  const code = frozen.provenance.code_sha256;
  check(code && typeof code === 'object' && !Array.isArray(code) && Object.keys(code).length > 0, 'METHOD_CODE_HASHES_REQUIRED');
  for (const [name, expected] of Object.entries(code)) {
    const file = resolve(projectRoot, name);
    check((within(file, projectRoot) || within(file, runDir)) && /^[a-f0-9]{64}$/.test(expected), 'INVALID_METHOD_CODE_REFERENCE');
    check(digest(await bytes(file)) === expected, `METHOD_CODE_CHANGED: ${basename(file)}; create a new run`);
  }
  return frozen;
}

function attemptPath(runDir, attemptId) {
  check(/^attempt-00[12]$/.test(attemptId), 'INVALID_ATTEMPT_ID');
  return join(runDir, attemptId);
}
async function readAttempt(runDir, attemptId) {
  const directory = attemptPath(runDir, attemptId);
  const start = await json(join(directory, 'started.json'));
  check(start.attempt_id === attemptId, 'ATTEMPT_ID_MISMATCH');
  check(start.frozen_manifest_sha256 === digest(await bytes(join(runDir, 'manifest.json'))), 'ATTEMPT_INPUT_CHANGED');
  const receipt = await json(join(directory, 'receipt.json'));
  check(receipt.attempt_id === attemptId && receipt.started_at === start.started_at, 'ATTEMPT_RECEIPT_MISMATCH');
  check(receipt.started_sha256 === digest(await bytes(join(directory, 'started.json'))), 'ATTEMPT_START_CHANGED');
  check(Date.parse(receipt.ended_at) >= Date.parse(start.started_at), 'INVALID_GENERATION_TIME');
  if (receipt.raw_output_sha256 !== null) check(digest(await bytes(join(directory, 'raw-output.json'))) === receipt.raw_output_sha256, 'RAW_OUTPUT_HASH_MISMATCH');
  return { start, receipt, directory };
}

export async function prepareAttempt(runDir) {
  const { manifest } = await assertFrozenCode(runDir);
  check(!(await exists(join(runDir, 'publication'))), 'RUN_ALREADY_PUBLISHED');
  for (let index = 1; index <= 2; index++) {
    const attempt_id = `attempt-${String(index).padStart(3, '0')}`;
    const attemptDir = attemptPath(runDir, attempt_id);
    if (await exists(attemptDir)) {
      check(await exists(join(attemptDir, 'receipt.json')), 'ATTEMPT_STILL_OPEN');
      await readAttempt(runDir, attempt_id);
      continue;
    }
    // mkdir is the exclusive reservation; a racing caller cannot start the next attempt.
    await mkdir(attemptDir, { mode: 0o700 });
    const started_at = now();
    const start = { schema: 'MFV:M1_ATTEMPT_START:v1', run_id: manifest.run_id, attempt_id, started_at, input_sha256: manifest.files['input.json'], frozen_manifest_sha256: digest(await bytes(join(runDir, 'manifest.json'))) };
    await writeOnce(join(attemptDir, 'started.json'), start);
    return { attempt_id, attemptDir, started_at, rawFile: join(attemptDir, 'raw-output.json') };
  }
  throw Error('ATTEMPT_LIMIT_REACHED');
}

/** The caller supplies the actual process outcome, never timestamps. Failed attempts remain archived. */
export async function completeAttempt(runDir, attemptId, info) {
  const { manifest } = await readFrozen(runDir);
  const directory = attemptPath(runDir, attemptId);
  const start = await json(join(directory, 'started.json'));
  check(start.frozen_manifest_sha256 === digest(await bytes(join(runDir, 'manifest.json'))), 'ATTEMPT_INPUT_CHANGED');
  check(Date.parse(start.started_at) >= Date.parse(manifest.information_frozen_at), 'GENERATION_BEFORE_INPUT_FREEZE');
  check(info && (Number.isInteger(info.exit_code) || info.exit_code === null), 'EXIT_CODE_REQUIRED');
  for (const key of ['started_at', 'ended_at', 'published_at']) check(!(key in info), 'CALLER_TIMESTAMP_FORBIDDEN');
  const rawFile = join(directory, 'raw-output.json');
  const raw_output_sha256 = await exists(rawFile) ? digest(await bytes(rawFile)) : null;
  check(info.exit_code !== 0 || raw_output_sha256 !== null, 'SUCCESS_WITHOUT_RAW_OUTPUT');
  const receipt = {
    schema: 'MFV:M1_ATTEMPT_RESULT:v1', run_id: start.run_id, attempt_id: attemptId,
    started_at: start.started_at, ended_at: now(), started_sha256: digest(await bytes(join(directory, 'started.json'))),
    exit_code: info.exit_code, signal: info.signal ?? null, error: info.error ?? null,
    model_config: info.model_config ?? 'unknown', model_identity: info.model_identity ?? null,
    model_identity_visibility: info.model_identity_visibility ?? 'not_exposed',
    execution_mode: info.execution_mode ?? 'unknown', raw_output_sha256,
    model_thread_id: info.model_thread_id ?? null, unexpected_tool_events: info.unexpected_tool_events ?? [],
    turn_completed: info.turn_completed ?? null, timed_out: info.timed_out ?? false, cli_exit_code: info.cli_exit_code ?? info.exit_code,
  };
  await writeOnce(join(directory, 'receipt.json'), receipt);
  return receipt;
}

async function publicationFiles(runDir) {
  const directory = join(runDir, 'publication');
  if (!(await exists(directory))) return null;
  const manifest = await json(join(directory, 'manifest.json'));
  check(manifest.schema === 'MFV:M1_PUBLICATION:v1', 'INVALID_PUBLICATION_MANIFEST');
  check(JSON.stringify((await readdir(directory)).sort()) === JSON.stringify(['forecast.json', 'manifest.json', 'receipt.json']), 'PUBLICATION_FILE_SET_MISMATCH');
  check(JSON.stringify(Object.keys(manifest.files).sort()) === JSON.stringify(['forecast.json', 'receipt.json']), 'PUBLICATION_HASH_SET_MISMATCH');
  for (const [name, hash] of Object.entries(manifest.files)) check(digest(await bytes(join(directory, name))) === hash, `PUBLICATION_HASH_MISMATCH: ${name}`);
  return { forecast: await json(join(directory, 'forecast.json')), receipt: await json(join(directory, 'receipt.json')), manifest };
}

export async function readPublished(runDir) {
  const published = await publicationFiles(runDir);
  if (!published) return null;
  const { manifest } = await readFrozen(runDir);
  const { receipt } = await readAttempt(runDir, published.receipt.attempt_id);
  check(published.receipt.frozen_manifest_sha256 === digest(await bytes(join(runDir, 'manifest.json'))), 'PUBLISHED_INPUT_CHANGED');
  check(published.receipt.attempt_receipt_sha256 === digest(await bytes(join(attemptPath(runDir, published.receipt.attempt_id), 'receipt.json'))), 'PUBLISHED_ATTEMPT_CHANGED');
  check(published.receipt.raw_output_sha256 === receipt.raw_output_sha256, 'PUBLISHED_OUTPUT_CHANGED');
  check(published.receipt.input_sha256 === manifest.files['input.json'], 'PUBLISHED_INPUT_HASH_MISMATCH');
  check(published.receipt.forecast_sha256 === published.manifest.files['forecast.json'], 'PUBLISHED_FORECAST_HASH_MISMATCH');
  check(published.forecast.run_id === manifest.run_id && published.receipt.run_id === manifest.run_id, 'PUBLISHED_RUN_MISMATCH');
  check(published.forecast.published_at === published.receipt.published_at, 'PUBLISHED_TIME_MISMATCH');
  return published;
}

/** Validate raw Codex bytes, then atomically expose one immutable local publication bundle. */
export async function publishRun(runDir, rawFile, generationInfo) {
  const { input, schema: frozenSchema, manifest: frozen } = await readFrozen(runDir);
  const attemptId = generationInfo?.attempt_id;
  const attemptDir = attemptPath(runDir, attemptId);
  check(resolve(rawFile) === resolve(attemptDir, 'raw-output.json'), 'RAW_OUTPUT_NOT_IN_ATTEMPT');
  const prior = await readPublished(runDir);
  if (prior) {
    check(prior.receipt.attempt_id === attemptId, 'RUN_ALREADY_PUBLISHED_FROM_OTHER_ATTEMPT');
    return prior;
  }
  await assertFrozenCode(runDir);
  const { receipt: generation } = await readAttempt(runDir, attemptId);
  check(generation.exit_code === 0 && generation.raw_output_sha256, 'GENERATION_NOT_SUCCESSFUL');
  const { validateModelOutput, classifyPublication, rawOutputJsonSchema } = await import('../src/m1-contracts.ts');
  const { parseStrict, canonical } = await import('../src/contracts.ts');
  check(canonical(frozenSchema) === canonical(rawOutputJsonSchema), 'FROZEN_SCHEMA_VERSION_MISMATCH');
  const raw = await bytes(rawFile);
  check(digest(raw) === generation.raw_output_sha256, 'RAW_OUTPUT_HASH_MISMATCH');
  const validated = await validateModelOutput(parseStrict(raw.toString('utf8')), { anchor_time: input.anchor_time, anchor_price: input.anchor_price });
  const published_at = now();
  check(Date.parse(frozen.information_frozen_at) <= Date.parse(generation.started_at) && Date.parse(generation.ended_at) <= Date.parse(published_at), 'INVALID_GENERATION_TIME');
  const status = classifyPublication(input.anchor_time, published_at);
  const forecast = {
    ...validated, kind: 'experimental_forecast', run_id: frozen.run_id,
    published_at, generation_started_at: generation.started_at, generation_ended_at: generation.ended_at,
    information_frozen_at: frozen.information_frozen_at, status, eligible_as_latest: status === 'valid',
    data_cutoff: input.anchor_time, event_cutoff: input.events?.information_cutoff ?? null,
    event_mode: input.events?.mode ?? 'market_only',
    event_risk_label: input.events?.event_risk_incorporated === true ? '已纳入所列事件信息，其他风险未知' : '未纳入事件风险',
    probability_kind: 'subjective_uncalibrated', probability_label: '主观未校准；24h 类别概率仅用于 24h',
    range_kind: 'model_range_estimate', range_label: '模型范围估计，未经校准',
    path_label: '代表路径不是类别的全部可能路径；显示插值不是成交轨迹',
    step_seconds: 900, horizon_seconds: 86400, future_count: 96,
    scenarios: validated.scenarios.map(scenario => ({ ...scenario, points: scenario.prices.map((price, index) => ({ time: input.anchor_time + (index + 1) * 900, price })) })),
    stages: validated.stages.map(stage => ({ ...stage, start_time: input.anchor_time + (stage.start_step - 1) * 900, end_time: input.anchor_time + stage.end_step * 900 })),
  };
  const forecastBytes = encode(forecast);
  const receipt = {
    schema: 'MFV:M1_PUBLICATION_RECEIPT:v1', run_id: frozen.run_id, attempt_id: attemptId, status,
    first_published_at: published_at, published_at, input_sha256: frozen.files['input.json'],
    raw_output_sha256: generation.raw_output_sha256, forecast_sha256: digest(forecastBytes),
    frozen_manifest_sha256: digest(await bytes(join(runDir, 'manifest.json'))),
    attempt_receipt_sha256: digest(await bytes(join(attemptDir, 'receipt.json'))),
    generation_started_at: generation.started_at, generation_ended_at: generation.ended_at,
    information_frozen_at: frozen.information_frozen_at, data_cutoff: input.anchor_time,
    event_cutoff: input.events?.information_cutoff ?? null, event_mode: input.events?.mode ?? 'market_only',
    method_version: validated.method_version, prompt_version: validated.prompt_version,
    model_config: generation.model_config, model_identity: generation.model_identity,
    model_identity_visibility: generation.model_identity_visibility, local_only: true,
  };
  const receiptBytes = encode(receipt);
  const publicationManifest = { schema: 'MFV:M1_PUBLICATION:v1', run_id: frozen.run_id, files: { 'forecast.json': digest(forecastBytes), 'receipt.json': digest(receiptBytes) } };
  const temporary = join(runDir, `.publication-${randomUUID()}.tmp`);
  await mkdir(temporary, { mode: 0o700 });
  await writeOnce(join(temporary, 'forecast.json'), forecastBytes);
  await writeOnce(join(temporary, 'receipt.json'), receiptBytes);
  await writeOnce(join(temporary, 'manifest.json'), publicationManifest);
  // Recheck all immutable inputs immediately before committing. Abandoned temporary bundles are inert.
  await assertFrozenCode(runDir);
  await readAttempt(runDir, attemptId);
  check(classifyPublication(input.anchor_time, now()) === status, 'LATE_DURING_COMMIT');
  try { await rename(temporary, join(runDir, 'publication')); }
  catch (error) {
    if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
    const winner = await readPublished(runDir);
    check(winner?.receipt.attempt_id === attemptId, 'CONCURRENT_PUBLICATION_CONFLICT');
    return winner;
  }
  return readPublished(runDir);
}
