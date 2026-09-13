import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseStrict, validateHistory, canonical } from '../src/contracts.ts';
import { rawOutputJsonSchema, validateModelOutput } from '../src/m1-contracts.ts';
import { displayRunSchema, indexSchema, publishedForecastSchema, runIdSchema } from '../src/m1-display.ts';
import { readFrozen, readPublished } from './m1-archive.mjs';

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const check = (condition, message = 'ARCHIVE_INVALID') => { if (!condition) throw Error(message); };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const iso = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value) && Number.isFinite(Date.parse(value));
const inside = (file, root) => { const part = relative(root, file); return part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part); };
const keys = (value, names) => value && typeof value === 'object' && !Array.isArray(value)
  && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...names].sort());

/** Local read-only access. No downloads, model calls, manifests or index writes. */
export function createDisplayReader({ root = defaultRoot, runsRoot = join(root, 'artifacts/forecast-runs') } = {}) {
  root = resolve(root); runsRoot = resolve(runsRoot);
  check(inside(runsRoot, join(root, 'artifacts')) && runsRoot !== join(root, 'artifacts'));

  async function safePath(file, directory = false) {
    check(inside(file, root));
    check(await realpath(root) === root, 'SYMLINK_FORBIDDEN');
    const pieces = relative(root, file).split(sep);
    let current = root;
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
    check(keys(input, ['schema_version', 'history', 'anchor_time', 'anchor_price', 'features', 'events', 'model_context']) && input.schema_version === 'm1-input.0');
    check(Array.isArray(input.history?.source?.raw_responses) && Array.isArray(input.events?.sources));
    for (const record of input.history.source.raw_responses) {
      check(typeof record.path === 'string' && /^artifacts\/data-source\/[a-zA-Z0-9_-]+\/page-\d+\.json$/.test(record.path));
      await bytes(resolve(root, record.path));
    }
    for (const source of input.events.sources) {
      check(typeof source.raw_path === 'string' && !isAbsolute(source.raw_path)
        && !source.raw_path.includes('\\') && !source.raw_path.split('/').includes('..'));
      const file = resolve(root, source.raw_path);
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
  async function readRun(id) {
    const directory = await preflight(id);
    const frozen = await readFrozen(directory);
    check(canonical(frozen.schema) === canonical(rawOutputJsonSchema));
    const published = await readPublished(directory);
    check(published, 'PUBLICATION_MISSING');
    const history = await validateHistory(frozen.input.history);
    const forecast = publishedForecastSchema.parse(published.forecast);
    const receipt = published.receipt;
    check(forecast.anchor_time === frozen.input.anchor_time && forecast.anchor_price === frozen.input.anchor_price
      && forecast.information_frozen_at === frozen.manifest.information_frozen_at
      && forecast.event_cutoff === (frozen.input.events.information_cutoff ?? null)
      && forecast.event_mode === frozen.input.events.mode
      && (forecast.event_risk_label !== '未纳入事件风险') === (frozen.input.events.event_risk_incorporated === true));
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
    projection.scenarios = forecast.scenarios.map(({ points: _points, ...value }) => value);
    projection.stages = forecast.stages.map(({ start_time: _start, end_time: _end, ...value }) => value);
    check(canonical(projection) === canonical(rawOutput), 'MODEL_PUBLICATION_MISMATCH');
    // Whitelist the response; never spread input, source records, provenance or receipts.
    return displayRunSchema.parse({
      schema: 'MFV:M1_DISPLAY:v1', run_id: id,
      history: { dataset_id: history.dataset_id, instrument: history.instrument, market_type: history.market_type,
        price_type: history.price_type, bar_seconds: history.bar_seconds, start_time: history.start_time,
        end_time: history.end_time, count: history.count, candles: history.candles,
        source: { provider: history.source.provider, endpoint: history.source.endpoint }, downloaded_at: history.downloaded_at },
      forecast, model: { config: receipt.model_config, identity: receipt.model_identity, identity_visibility: receipt.model_identity_visibility },
      hashes: { input_sha256: receipt.input_sha256, forecast_sha256: receipt.forecast_sha256 }, evaluation: { status: 'not_evaluated' },
    });
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
        const failed = await json(join(directory, 'preparation-failure.json'));
        check(failed.status === 'failed' && iso(failed.at));
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
  return { readRun, readIndex };
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
