import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseStrict, validateHistory, canonical } from '../src/contracts.ts';
import { rawOutputJsonSchema, validateModelOutput } from '../src/m1-contracts.ts';
import { displayRunSchema, indexSchema, publishedForecastSchema, runIdSchema, runtimeDisplaySchema } from '../src/m1-display.ts';
import { readFrozen, readPublished } from './m1-archive.mjs';
import { createOutcomeStore } from './m1-outcome-store.mjs';
import { auditCodexEvents } from './m1-forecast.mjs';
import { modelArguments } from './m1-model.mjs';
import {readLegacyClosure} from './m1-closures.mjs';
import {readPreparationFailure} from './m1-preparation.mjs';
import {dataReference} from './m1-files.mjs';import{effectiveEvents}from'./m1-supplementary.mjs';

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const check = (condition, message = 'ARCHIVE_INVALID') => { if (!condition) throw Error(message); };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const iso = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value) && Number.isFinite(Date.parse(value));
const inside = (file, root) => { const part = relative(root, file); return part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part); };
const keys = (value, names) => value && typeof value === 'object' && !Array.isArray(value)
  && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...names].sort());
// Read-only display verification deliberately does not import or execute the runtime entry point.
const runtimeReleaseFiles = [
  'scripts/m1-runtime.mjs', 'scripts/m1-runtime-events.mjs', 'scripts/executor.mjs',
  'scripts/m1-input.mjs', 'scripts/m1-forecast.mjs', 'scripts/m1-archive.mjs', 'scripts/m1-events.mjs',
  'scripts/m1-outcome-store.mjs', 'scripts/m1-display.mjs', 'scripts/data-utils.mjs',
  'src/contracts.ts', 'src/m1-contracts.ts', 'src/m1-display.ts', 'src/m1-evaluation.ts',
  'docs/M1_FORECAST.md', 'package.json', 'package-lock.json', 'tsconfig.json', '.codex/config.toml',
];

/** Local read-only access. No downloads, model calls, manifests or index writes. */
export function createDisplayReader({ root = defaultRoot, dataRoot = process.env.MFV_DATA_ROOT??join(root,'artifacts'), runsRoot = join(dataRoot, 'forecast-runs') } = {}) {
  root = resolve(root); dataRoot=resolve(dataRoot); runsRoot = resolve(runsRoot);
  check(inside(runsRoot,dataRoot)&&runsRoot!==dataRoot);

  async function safePath(file, directory = false) {
    const base=inside(file,dataRoot)?dataRoot:root;
    check(inside(file,base));
    check(await realpath(base) === base, 'SYMLINK_FORBIDDEN');
    const pieces = relative(base, file).split(sep);
    let current = base;
    for (let index = 0; index < pieces.length; index++) {
      current = join(current, pieces[index]);
      const stat = await lstat(current);
      check(!stat.isSymbolicLink(), 'SYMLINK_FORBIDDEN');
      check(index < pieces.length - 1 || directory ? stat.isDirectory() : stat.isFile());
    }
    check(await realpath(file) === file, 'SYMLINK_FORBIDDEN');
    return file;
  }
  async function exists(file) {
    try { await lstat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }
  async function bytes(file) {
    await safePath(file);
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat(); check(stat.isFile() && stat.size <= 12 * 1024 * 1024);
      return await handle.readFile();
    } finally { await handle.close(); }
  }
  async function json(file) { return parseStrict((await bytes(file)).toString('utf8')); }
  function runDirectory(id) { runIdSchema.parse(id); return join(runsRoot, id); }
  async function metadata(id) {
    const run = await json(join(runDirectory(id), 'run.json'));
    check(keys(run, ['schema', 'run_id', 'created_at', 'local_only']) && run.schema === 'MFV:M1_RUN:v1'
      && run.run_id === id && run.local_only === true && iso(run.created_at));
    check(id.startsWith(`m1-${run.created_at.replace(/[-:.]/g, '')}-`));
    return run;
  }
  async function preflight(id) {
    const directory = runDirectory(id);
    await metadata(id);
    for (const name of ['manifest.json', 'input.json', 'output-schema.json', 'provenance.json']) await json(join(directory, name));
    await bytes(join(directory, 'prompt.txt'));
    const input = await json(join(directory, 'input.json'));
    check(keys(input, ['schema_version','history','anchor_time','anchor_price','features','events','model_context',...(input.schema_version==='m1-input.1'?['supplementary']:[])])&&['m1-input.0','m1-input.1'].includes(input.schema_version));
    check(Array.isArray(input.history?.source?.raw_responses) && Array.isArray(input.events?.sources));
    for (const record of input.history.source.raw_responses) {
      check(typeof record.path === 'string' && /^artifacts\/data-source\/[a-zA-Z0-9_-]+\/page-\d+\.json$/.test(record.path));
      await bytes(dataReference(record.path,dataRoot));
    }
    for (const source of input.events.sources) {
      check(typeof source.raw_path === 'string' && !isAbsolute(source.raw_path)
        && !source.raw_path.includes('\\') && !source.raw_path.split('/').includes('..'));
      const file = dataReference(source.raw_path,dataRoot);
      check(inside(file, directory) && /^events-source-\d{3}\.raw$/.test(relative(directory, file)));
      await bytes(file);
    }
    if (await exists(join(directory, 'publication'))) {
      await safePath(join(directory, 'publication'), true);
      for (const name of ['forecast.json', 'receipt.json', 'manifest.json']) await json(join(directory, 'publication', name));
    }
    for (const attempt of ['attempt-001', 'attempt-002']) {
      const attemptDir = join(directory, attempt);
      if (!(await exists(attemptDir))) continue;
      await safePath(attemptDir, true);
      for (const name of ['started.json', 'receipt.json', 'raw-output.json', 'validation-result.json']) {
        if (await exists(join(attemptDir, name))) {
          // Invalid raw model output is legitimate failed-attempt evidence, never display input.
          if (name === 'raw-output.json') await bytes(join(attemptDir, name));
          else await json(join(attemptDir, name));
        }
      }
    }
    return directory;
  }
  async function readRun(id, { includeEvaluation = true } = {}) {
    const directory = await preflight(id);
    const frozen = await readFrozen(directory);
    check(canonical(frozen.schema) === canonical(rawOutputJsonSchema));
    const published = await readPublished(directory);
    check(published, 'PUBLICATION_MISSING');
    const history = await validateHistory(frozen.input.history);
    const forecast = publishedForecastSchema.parse(published.forecast);
    const receipt = published.receipt;const eventData=effectiveEvents(frozen.input);
    check(forecast.anchor_time === frozen.input.anchor_time && forecast.anchor_price === frozen.input.anchor_price
      && forecast.information_frozen_at === frozen.manifest.information_frozen_at
      && forecast.event_cutoff === (eventData.information_cutoff ?? null)
      && forecast.event_mode === eventData.mode
      && (forecast.event_risk_label !== '未纳入事件风险') === (eventData.event_risk_incorporated === true));
    for (const key of ['run_id', 'status', 'published_at', 'generation_started_at', 'generation_ended_at',
      'information_frozen_at', 'data_cutoff', 'event_cutoff', 'event_mode', 'method_version', 'prompt_version']) check(receipt[key] === forecast[key]);
    check(receipt.schema === 'MFV:M1_PUBLICATION_RECEIPT:v1' && receipt.local_only === true
      && receipt.first_published_at === forecast.published_at);
    const generation = await json(join(directory, receipt.attempt_id, 'receipt.json'));
    check(generation.exit_code === 0 && generation.started_at === forecast.generation_started_at
      && generation.ended_at === forecast.generation_ended_at
      && canonical(generation.model_config) === canonical(receipt.model_config)
      && generation.model_identity === receipt.model_identity
      && generation.model_identity_visibility === receipt.model_identity_visibility);
    const rawOutput = validateModelOutput(await json(join(directory, receipt.attempt_id, 'raw-output.json')),
      { anchor_time: frozen.input.anchor_time, anchor_price: frozen.input.anchor_price });
    const projection = Object.fromEntries(Object.keys(rawOutput).map(key => [key, forecast[key]]));
    projection.scenarios = forecast.scenarios.map(({ points: _points, ...value },i) => forecast.calibration?{...value,probability_24h:forecast.calibration.raw_probabilities[i]}:value);
    if(forecast.calibration){const learning=frozen.input.model_context?.learning;check(learning&&learning.lambda===forecast.calibration.lambda&&canonical(learning.base.probabilities)===canonical(forecast.calibration.base),'CALIBRATION_FROZEN_INPUT_MISMATCH');}
    projection.stages = forecast.stages.map(({ start_time: _start, end_time: _end, ...value }) => value);
    check(canonical(projection) === canonical(rawOutput), 'MODEL_PUBLICATION_MISMATCH');
    // Whitelist the response; never spread input, source records, provenance or receipts.
    const result = displayRunSchema.parse({
      schema: 'MFV:M1_DISPLAY:v1', run_id: id,
      history: { dataset_id: history.dataset_id, instrument: history.instrument, market_type: history.market_type,
        price_type: history.price_type, bar_seconds: history.bar_seconds, start_time: history.start_time,
        end_time: history.end_time, count: history.count, candles: history.candles,
        source: { provider: history.source.provider, endpoint: history.source.endpoint }, downloaded_at: history.downloaded_at },
      ...(frozen.input.model_context?.learning||frozen.input.supplementary?{basis:{feedback_mode:frozen.input.model_context?.learning?.feedback_mode??'F0',case_ids:frozen.input.model_context?.learning?.feedback?.case_ids??[],base_count:frozen.input.model_context?.learning?.base?.n??0,base_cutoff:frozen.input.model_context?.learning?.base?.cutoff??null,derivatives_collected:frozen.input.supplementary?.derivatives?.items?.filter(x=>x.status==='collected').length??0,derivatives_incorporated:frozen.input.supplementary?.derivatives?.incorporated??false,calendar_collected:frozen.input.supplementary?.calendar?.items?.length??0,calendar_included:frozen.input.supplementary?.calendar?.included?.length??0}}:{}),
      forecast, model: { config: receipt.model_config, identity: receipt.model_identity, identity_visibility: receipt.model_identity_visibility },
      hashes: { input_sha256: receipt.input_sha256, forecast_sha256: receipt.forecast_sha256 }, evaluation: { status: 'not_evaluated' },
    });
    return includeEvaluation ? displayRunSchema.parse({ ...result, evaluation: await createOutcomeStore({ root, dataRoot, runsRoot }).readLatest(result) }) : result;
  }
  /** Two exhausted failures, or an independently reviewed historical closure.
   * A single completed attempt alone never proves run closure. */
  async function readScoringRun(id) {
    const preparation=await readPreparationFailure({codeRoot:root,dataRoot,runId:id,runsRoot});
    if(preparation){check(preparation.status==='preparation_failed_not_scoreable','PREPARATION_FAILURE_UNPROVEN');return preparation;}
    const directory = await preflight(id);
    check(!(await exists(join(directory, 'preparation-failure.json'))), 'SCORING_FAILURE_UNPROVEN');
    // Even a dangling symlink or partial publication must take the strict path.
    const closureExists=await exists(join(dataRoot,'m1-closures',id));
    if (await exists(join(directory, 'publication'))) {
      check(!closureExists,'CLOSURE_PUBLICATION_CONTRADICTION');
      return { status: 'readable', run: await readRun(id) };
    }
    const frozen = await readFrozen(directory);
    check(canonical(frozen.schema) === canonical(rawOutputJsonSchema), 'SCORING_SCHEMA_MISMATCH');
    await validateHistory(frozen.input.history);
    check(iso(frozen.manifest.information_frozen_at), 'SCORING_FREEZE_TIME_INVALID');
    const entries = await readdir(directory);
    check(!entries.some(name => name.startsWith('.publication-') || /^attempt-/.test(name) && !['attempt-001', 'attempt-002'].includes(name)), 'SCORING_FAILURE_UNPROVEN');
    check(!(await exists(join(dataRoot, 'm1-outcomes', id))), 'SCORING_PUBLICATION_EVIDENCE');
    const successFile = join(dataRoot, 'm1-task-status', 'last-forecast-success.json');
    if (await exists(successFile)) check((await json(successFile)).forecast_id !== id, 'SCORING_PUBLICATION_EVIDENCE');
    const indexFile = join(dataRoot, 'm1-projections', 'index.json');
    if (await exists(indexFile)) {
      const index = await json(indexFile);
      check(index.schema === 'MFV:PROJECTIONS:v1' && Array.isArray(index.runs), 'SCORING_INDEX_INVALID');
      check(index.latest_run_id !== id && !index.runs.some(row => row.run_id === id &&
        (row.published_at != null || row.projection != null || ['valid', 'late'].includes(row.status))), 'SCORING_PUBLICATION_EVIDENCE');
    }
    if(closureExists)return await readLegacyClosure({codeRoot:root,dataRoot,runId:id,runsRoot,frozen});
    let endedAt = frozen.manifest.information_frozen_at;
    for (const attempt of ['attempt-001', 'attempt-002']) {
      const folder = join(directory, attempt);
      await safePath(folder, true);
      check(!(await exists(join(folder, 'validation-result.json'))), 'SCORING_FAILURE_UNPROVEN');
      const start = await json(join(folder, 'started.json')), receipt = await json(join(folder, 'receipt.json'));
      check(start.schema === 'MFV:M1_ATTEMPT_START:v1' && start.run_id === id && start.attempt_id === attempt
        && start.input_sha256 === frozen.manifest.files['input.json']
        && start.frozen_manifest_sha256 === digest(await bytes(join(directory, 'manifest.json'))), 'SCORING_ATTEMPT_MISMATCH');
      check(receipt.schema === 'MFV:M1_ATTEMPT_RESULT:v1' && receipt.run_id === id && receipt.attempt_id === attempt
        && receipt.started_at === start.started_at && receipt.started_sha256 === digest(await bytes(join(folder, 'started.json'))), 'SCORING_RECEIPT_MISMATCH');
      check(iso(start.started_at) && iso(receipt.ended_at) && Date.parse(start.started_at) >= Date.parse(endedAt)
        && Date.parse(receipt.ended_at) >= Date.parse(start.started_at), 'SCORING_ATTEMPT_TIME_INVALID');
      check(receipt.exit_code === -1 && receipt.error === 'MODEL_ATTEMPT_REJECTED', 'SCORING_FAILURE_UNPROVEN');
      const raw = join(folder, 'raw-output.json');
      if (receipt.raw_output_sha256 === null) check(!(await exists(raw)), 'SCORING_RAW_HASH_MISMATCH');
      else check(typeof receipt.raw_output_sha256 === 'string' && /^[a-f0-9]{64}$/.test(receipt.raw_output_sha256)
        && digest(await bytes(raw)) === receipt.raw_output_sha256, 'SCORING_RAW_HASH_MISMATCH');
      const stream = (await bytes(join(folder, 'events.jsonl'))).toString('utf8');
      // Malformed/truncated JSONL is not proof of a completed failed attempt.
      for (const line of stream.trim().split('\n')) parseStrict(line);
      const invocationBytes = await bytes(join(folder, 'invocation.json')), invocation = parseStrict(invocationBytes.toString('utf8'));
      const workspace = invocation.working_directory, originalRun = typeof workspace === 'string' ? dirname(dirname(workspace)) : '';
      check(invocation.schema === 'MFV:MODEL_INVOCATION:v1' && invocation.provider === 'official_codex'
        && invocation.cli_version === receipt.model_config?.cli_version && invocation.cli_version === 'codex-cli 0.154.0-alpha.6.2'
        && invocation.requested_model === 'gpt-6-astra' && invocation.requested_reasoning === 'medium'
        && invocation.frozen_input_sha256 === frozen.manifest.files['input.json']
        && typeof workspace === 'string' && isAbsolute(workspace) && originalRun.split(sep).at(-1) === id
        && workspace === join(originalRun, attempt, 'model-work')
        && canonical(invocation.args) === canonical(modelArguments({workspace,schema:join(originalRun,'output-schema.json'),output:join(originalRun,attempt,'raw-output.json')})), 'SCORING_INVOCATION_MISMATCH');
      const context = {kind:'installed_frozen_input',cli_version:invocation.cli_version,args:invocation.args};
      const audit = auditCodexEvents(stream, context), parser = frozen.provenance.code_sha256?.['scripts/m1-forecast.mjs'];
      check(audit.events.some(event => event?.type === 'thread.started' && event.thread_id === receipt.model_thread_id), 'SCORING_THREAD_MISMATCH');
      if (parser === '9016c56108a71f3daacbaef25db705ab306a06ac4600889712ab892a680d7a4d' && receipt.event_audit === undefined) {
        // Exact legacy parser: no context exemption. Recognize only the known
        // pre-turn disabled-host notice rejection, never retrofit its receipt.
        const legacy = auditCodexEvents(stream);
        check(legacy.unexpected_count === 1 && !legacy.failed && legacy.turn_completed
          && audit.controlled_disabled_context && audit.startup_notice_count === 1
          && audit.unexpected_count === 0 && !audit.failed && audit.turn_completed
          && receipt.unexpected_tool_events === legacy.unexpected_count
          && receipt.model_config.startup_warning_count === legacy.startup_warning_count
          && receipt.turn_completed === null && receipt.cli_exit_code === 0 && receipt.timed_out === false, 'SCORING_FAILURE_UNPROVEN');
      } else {
        check(parser === 'b280c281ad131160aacf1fc20b0bd893ccc73e2e13e9d794f1a444f0c64212da', 'SCORING_PARSER_UNSUPPORTED');
        const expected = {schema:'MFV:CODEX_EVENT_AUDIT:v1',events_sha256:digest(stream),invocation_sha256:digest(invocationBytes),
          cli_version:invocation.cli_version,controlled_disabled_context:audit.controlled_disabled_context,startup_notice_count:audit.startup_notice_count,
          startup_notices:audit.startup_notices,unexpected_event_count:audit.unexpected_count,unexpected_tool_count:audit.unexpected_tool_count,
          turn_completed:audit.turn_completed,failed:audit.failed};
        check(canonical(receipt.event_audit) === canonical(expected), 'SCORING_AUDIT_MISMATCH');
        check(receipt.unexpected_tool_events === audit.unexpected_count && receipt.turn_completed === audit.turn_completed
          && receipt.model_config.startup_warning_count === audit.startup_warning_count
          && (audit.failed || audit.unexpected_count > 0), 'SCORING_FAILURE_UNPROVEN');
      }
      endedAt = receipt.ended_at;
    }
    return { status: 'terminal_failed_not_scoreable' };
  }
  async function runState(id, checkedAt) {
    // A malformed run.json stays visible as invalid without returning its bytes/error.
    const stamp = id.match(/^m1-(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)(\d{3})Z/);
    const fallback = `${stamp[1]}-${stamp[2]}-${stamp[3]}T${stamp[4]}:${stamp[5]}:${stamp[6]}.${stamp[7]}Z`;
    const state = { run_id: id, created_at: fallback, published_at: null, status: 'invalid', reason: 'archive_invalid' };
    try {
      const directory = runDirectory(id);
      state.created_at = (await metadata(id)).created_at;
      if (await exists(join(directory, 'preparation-failure.json'))) {
        await readPreparationFailure({codeRoot:root,dataRoot,runId:id,runsRoot});
        return { ...state, status: 'failed', reason: 'preparation_failed' };
      }
      if (!(await exists(join(directory, 'manifest.json')))) return { ...state, status: 'incomplete', reason: 'generation_incomplete' };
      await preflight(id);
      await readFrozen(directory);
      if (await exists(join(directory, 'publication'))) {
        const run = await readRun(id), forecast = run.forecast;
        return { ...state, published_at: forecast.published_at, status: forecast.status,
          reason: forecast.status === 'late' ? 'publication_late' : Date.parse(checkedAt) / 1000 >= forecast.anchor_time + forecast.horizon_seconds ? 'forecast_expired' : null };
      }
      for (const attempt of ['attempt-002', 'attempt-001']) {
        const attemptDir = join(directory, attempt);
        if (!(await exists(attemptDir))) continue;
        const start = await json(join(attemptDir, 'started.json'));
        check(start.schema === 'MFV:M1_ATTEMPT_START:v1' && start.run_id === id && start.attempt_id === attempt
          && start.frozen_manifest_sha256 === digest(await bytes(join(directory, 'manifest.json'))));
        if (!(await exists(join(attemptDir, 'receipt.json')))) return { ...state, status: 'incomplete', reason: 'generation_incomplete' };
        const receipt = await json(join(attemptDir, 'receipt.json'));
        check(receipt.schema === 'MFV:M1_ATTEMPT_RESULT:v1' && receipt.run_id === id && receipt.attempt_id === attempt
          && (receipt.exit_code === null || Number.isInteger(receipt.exit_code)) && receipt.started_at === start.started_at
          && receipt.started_sha256 === digest(await bytes(join(attemptDir, 'started.json'))));
        check(iso(start.started_at) && iso(receipt.ended_at) && Date.parse(receipt.ended_at) >= Date.parse(start.started_at));
        check(receipt.raw_output_sha256 === null || (typeof receipt.raw_output_sha256 === 'string'
          && /^[a-f0-9]{64}$/.test(receipt.raw_output_sha256)
          && receipt.raw_output_sha256 === digest(await bytes(join(attemptDir, 'raw-output.json')))));
        check(receipt.exit_code !== 0 || receipt.raw_output_sha256 !== null);
        if (receipt.exit_code !== 0) return { ...state, status: 'failed', reason: 'generation_failed' };
        if (await exists(join(attemptDir, 'validation-result.json'))) {
          check((await json(join(attemptDir, 'validation-result.json'))).status === 'failed');
          return { ...state, status: 'failed', reason: 'validation_failed' };
        }
        return { ...state, status: 'incomplete', reason: 'publication_missing' };
      }
      return { ...state, status: 'incomplete', reason: 'generation_incomplete' };
    } catch { return state; }
  }
  async function readIndex({ now = new Date().toISOString() } = {}) {
    let ids = [];
    if (await exists(runsRoot)) {
      await safePath(runsRoot, true);
      ids = (await readdir(runsRoot)).filter(id => runIdSchema.safeParse(id).success);
    }
    const runs = [];
    for (const id of ids) runs.push(await runState(id, now));
    runs.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.run_id.localeCompare(a.run_id));
    const latest = runs[0];
    const valid = runs.filter(run => run.status === 'valid' && run.reason === null)
      .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at))[0];
    return indexSchema.parse({ schema: 'MFV:M1_INDEX:v1', checked_at: now, latest_run_id: valid?.run_id ?? null,
      latest_attempt: latest ? { run_id: latest.run_id, created_at: latest.created_at, status: latest.status, reason: latest.reason } : null, runs });
  }
  async function readRuntime({ now = new Date().toISOString() } = {}) {
    const runtimeRoot = join(dataRoot, 'm1-runtime');
    const optional = async name => {
      const file = join(runtimeRoot, name);
      return await exists(file) ? await json(file) : null;
    };
    const configuration = await optional('configuration.json');
    if (configuration) check(configuration.schema === 'MFV:M1_RUNTIME_CONFIGURATION:v1' && configuration.local_only === true);
    async function releaseIntegrity() {
      if (!configuration) return 'unconfigured';
      if (typeof configuration.release_file !== 'string'
        || !/^artifacts\/m1-runtime\/releases\/[a-zA-Z0-9_-]{1,180}\.json$/.test(configuration.release_file)
        || !/^[a-f0-9]{64}$/.test(configuration.release_sha256 ?? '')) return 'unknown';
      try {
        const raw = await bytes(resolve(root, configuration.release_file));
        if (digest(raw) !== configuration.release_sha256) return 'changed';
        const release = parseStrict(raw.toString('utf8'));
        if (release.schema !== 'MFV:M1_RUNTIME_RELEASE:v1' || release.local_only !== true
          || !keys(release.code_sha256, runtimeReleaseFiles)) return 'unknown';
        for (const name of runtimeReleaseFiles) {
          if (!/^[a-f0-9]{64}$/.test(release.code_sha256[name])) return 'unknown';
          if (!await exists(join(root, name)) || digest(await bytes(join(root, name))) !== release.code_sha256[name]) return 'changed';
        }
        return 'verified';
      } catch { return 'unknown'; }
    }
    const state = await optional('status.json');
    if (state) check(state.schema === 'MFV:M1_RUNTIME_STATE:v1' && state.local_only === true);
    const pauseFile = join(runtimeRoot, 'PAUSED');
    const paused = await exists(pauseFile);
    if (paused) await safePath(pauseFile);
    const stages = ['check_release', 'score_old', 'collect_events', 'prepare', 'generate', 'publish_index', 'done'];
    const reason = !state || state.error_code === null ? null
      : ['CODE_VERSION_CHANGED', 'CLI_CONFIGURATION_CHANGED'].includes(state.error_code) ? 'code_changed'
      : state.error_code === 'PUBLICATION_LATE' ? 'publication_late'
      : state.status === 'failed' ? 'runtime_failed' : 'unknown';
    // Whitelist each field: local thread/configuration paths, raw errors, prompts and receipts stay private.
    return runtimeDisplaySchema.parse({
      schema: 'MFV:M1_RUNTIME_DISPLAY:v1', checked_at: now,
      release_integrity: await releaseIntegrity(),
      configuration: configuration ? {
        task_name: configuration.task_name, frequency_hours: configuration.frequency_hours,
        time_zone: configuration.time_zone, enabled: configuration.enabled,
        next_run_at: null, read_back_at: configuration.read_back_at,
      } : null,
      paused,
      latest_attempt: state ? {
        cycle_id: state.cycle_id, trigger: state.trigger, status: state.status,
        stage: stages.includes(state.stage) ? state.stage : 'unknown',
        started_at: state.started_at, updated_at: state.updated_at, completed_at: state.completed_at,
        reason, forecast_id: state.new_forecast?.run_id ?? null,
      } : null,
      last_success: state?.last_success ? {
        cycle_id: state.last_success.cycle_id, completed_at: state.last_success.completed_at,
        forecast_id: state.last_success.forecast_id,
      } : null,
    });
  }
  const listRunIds=async()=>await exists(runsRoot)?(await readdir(await safePath(runsRoot,true))).filter(id=>runIdSchema.safeParse(id).success).sort().reverse():[];
  const readPreparationState=id=>readPreparationFailure({codeRoot:root,dataRoot,runId:id,runsRoot});
  return { readRun, readScoringRun, readPreparationState, readIndex, readRuntime,listRunIds,runState };
}

/** A tiny Vite middleware used identically by dev and preview, without a static archive mount. */
export function m1DisplayPlugin(options = {}) {
  const reader = createDisplayReader(options);
  function install(server) {
    server.middlewares.use(async (request, response, next) => {
      if (!/^\/api(?:\/|%2f)m1(?:\/|%2f|$|\?)/i.test(request.url ?? '')) return next();
      const send = (status, value) => {
        response.statusCode = status;
        response.setHeader('Content-Type', 'application/json; charset=utf-8');
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader('X-Content-Type-Options', 'nosniff');
        response.end(JSON.stringify(value));
      };
      const address = request.socket.localAddress, peer = request.socket.remoteAddress;
      const host = `127.0.0.1:${request.socket.localPort}`, origin = `http://${host}`;
      const sameOrigin = value => { try { return new URL(value).origin === origin; } catch { return false; } };
      if (address !== '127.0.0.1' || !['127.0.0.1', '::ffff:127.0.0.1'].includes(peer)
        || request.headers.host !== host || (request.headers.origin && request.headers.origin !== origin)
        || (request.headers.referer && !sameOrigin(request.headers.referer))
        || (request.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(request.headers['sec-fetch-site']))) return send(403, { error: 'LOCAL_SAME_ORIGIN_ONLY' });
      if (request.method !== 'GET') return send(405, { error: 'GET_ONLY' });
      try {
        if (request.url === '/api/m1/index') return send(200, await reader.readIndex());
        if (request.url === '/api/m1/runtime') return send(200, await reader.readRuntime());
        const match = request.url?.match(/^\/api\/m1\/runs\/([^/?]+)$/);
        if (!match || !runIdSchema.safeParse(match[1]).success) return send(404, { error: 'DISPLAY_ROUTE_NOT_FOUND' });
        return send(200, await reader.readRun(match[1]));
      } catch { return send(422, { error: 'DISPLAY_ARCHIVE_UNAVAILABLE' }); }
    });
  }
  return {
    name: 'mfv-m1-read-only-display',
    configResolved(config) {
      check(config.server.host === '127.0.0.1' && config.preview.host === '127.0.0.1'
        && config.server.strictPort && config.preview.strictPort, 'M1_DISPLAY_REQUIRES_STRICT_LOOPBACK');
      check(config.server.cors === false && config.preview.cors === false, 'M1_DISPLAY_REQUIRES_NO_CORS');
    },
    configureServer: install, configurePreviewServer: install,
  };
}
