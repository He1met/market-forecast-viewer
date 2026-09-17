import { constants } from 'node:fs';
import { mkdir, lstat, open, readdir, realpath, rename, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { getHistoryPage } from './m1-history-get.mjs';
import { join, relative, resolve, sep, isAbsolute } from 'node:path';
import { z } from 'zod';
import { canonical, parseStrict } from '../src/contracts.ts';
import { evaluateForecast, evaluationSchema, EVALUATION_VERSION } from '../src/m1-evaluation.ts';
import { normalizeRows } from './data-utils.mjs';
import {legacyScorer}from'./m1-compat.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const encode = value => JSON.stringify(value, null, 2) + '\n';
const check = (value, message = 'OUTCOME_INVALID') => { if (!value) throw Error(message); };
const endpoint = 'https://www.okx.com/api/v5/market/history-candles';
const idPattern = /^(?:capture|evaluation)-\d{8}T\d{9}Z-[a-f0-9-]{36}$/;
const hash = z.string().regex(/^[a-f0-9]{64}$/), iso = z.string().datetime(), int = z.number().int().safe().nonnegative();
const runId = z.string().regex(/^m1-\d{8}T\d{9}Z-[a-f0-9-]{36}$/);
const object = shape => z.object(shape).strict();
const pageSchema = object({ file: z.string().regex(/^page-\d{3}\.json$/), sha256: hash,
  requested_at: iso, completed_at: iso, http_code: z.literal('200'),
  params: object({ instId: z.literal('BTC-USDT-SWAP'), bar: z.literal('15m'), limit: z.literal(100), after: z.string().regex(/^\d+$/) }) });
const captureSchema = object({ schema: z.literal('MFV:M1_OUTCOME_CAPTURE:v1'), capture_id: z.string().regex(idPattern),
  forecast_id: runId, forecast_hash: hash, local_only: z.literal(true), started_at: iso, completed_at: iso,
  status: z.enum(['ok', 'failed']), error: z.string().nullable(), provider: z.literal('OKX'), endpoint: z.literal(endpoint),
  instrument: z.literal('BTC-USDT-SWAP'), market_type: z.literal('linear_perpetual'), price_type: z.literal('trade'), bar_seconds: z.literal(900),
  start_time: int, observed_through: int, pages: z.array(pageSchema).max(3) });
const revisionSchema = object({ schema: z.literal('MFV:M1_EVALUATION_REVISION:v1'), revision_id: z.string().regex(idPattern),
  forecast_id: runId, forecast_hash: hash, evaluation_version: z.literal(EVALUATION_VERSION), evaluated_at: iso,
  capture_id: z.string().regex(idPattern), capture_sha256: hash, result_sha256: hash, method_code_sha256: hash,
  evaluation_code_sha256: hash, local_only: z.literal(true) });

/** Only this explicit command layer writes outcomes. HTTP readers never acquire data. */
export function createOutcomeStore({ root = process.cwd(), dataRoot=process.env.MFV_DATA_ROOT??join(root,'artifacts'), runsRoot=join(dataRoot,'forecast-runs'), stateRoot = join(dataRoot, 'm1-outcomes'), historyGet=getHistoryPage } = {}) {
  root = resolve(root);dataRoot=resolve(dataRoot); stateRoot = resolve(stateRoot);
  const inside = file => { const part = relative(root, file); return part && part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part); };
  check(stateRoot.startsWith(dataRoot+sep));
  async function safe(file, missing = false) {
    const base=file.startsWith(dataRoot+sep)?dataRoot:root;
    check((file.startsWith(base+sep)) && await realpath(base) === base, 'OUTCOME_PATH_INVALID');
    let current = base;
    for (const part of relative(base, file).split(sep)) {
      current = join(current, part);
      try { check(!(await lstat(current)).isSymbolicLink(), 'OUTCOME_SYMLINK_FORBIDDEN'); }
      catch (error) { if (missing && error.code === 'ENOENT') return file; throw error; }
    }
    return file;
  }
  async function exists(file) { try { await safe(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } }
  async function bytes(file) {
    await safe(file); const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { const stat = await handle.stat(); check(stat.isFile() && stat.size < 12 * 1024 * 1024); return await handle.readFile(); }
    finally { await handle.close(); }
  }
  async function json(file) { return parseStrict((await bytes(file)).toString('utf8')); }
  async function directory(file) { await safe(file, true); await mkdir(file, { recursive: true, mode: 0o700 }); await safe(file); }
  async function once(file, value) { await safe(file, true); await writeFile(file, encode(value), { flag: 'wx', mode: 0o600 }); }
  function folder(run) { runId.parse(run.run_id); hash.parse(run.hashes.forecast_sha256); return join(stateRoot, run.run_id); }
  function capturePath(run, id) { check(idPattern.test(id) && id.startsWith('capture-')); return join(folder(run), 'captures', id); }
  function revisionPath(run, id) { check(idPattern.test(id) && id.startsWith('evaluation-')); return join(folder(run), 'evaluations', id); }
  const newId = prefix => `${prefix}-${new Date().toISOString().replace(/[-:.]/g, '')}-${randomUUID()}`;
  async function getPage({ url, file, signal,deadline=Infinity }) {
    // Existing network configuration and normal TLS verification are preserved; bounded, no account API.
    return historyGet({url,file,signal,deadline,kind:'outcome'});
  }
  async function capture(run, { transport = getPage,signal,deadline=Infinity } = {}) {
    const capture_id = newId('capture'), dir = capturePath(run, capture_id); await directory(dir);
    const started_at = new Date().toISOString();
    const observed_through = Math.max(run.forecast.anchor_time, Math.min(run.forecast.anchor_time + 86400, Math.floor(Date.parse(started_at) / 900000) * 900));
    const record = { schema: 'MFV:M1_OUTCOME_CAPTURE:v1', capture_id, forecast_id: run.run_id,
      forecast_hash: run.hashes.forecast_sha256, local_only: true, started_at, completed_at: started_at,
      status: 'ok', error: null, provider: 'OKX', endpoint, instrument: 'BTC-USDT-SWAP', market_type: 'linear_perpetual',
      price_type: 'trade', bar_seconds: 900, start_time: run.forecast.anchor_time, observed_through, pages: [] };
    try {
      let after = String(observed_through * 1000);
      // Fetch only the new outcome horizon (<=96 bars), never the original 14-day input.
      for (let page = 1; observed_through > record.start_time && page <= 3; page++) {
        const params = { instId: 'BTC-USDT-SWAP', bar: '15m', limit: 100, after };
        const file = `page-${String(page).padStart(3, '0')}.json`, began = new Date().toISOString();
        const response = await transport({ url: endpoint + '?' + new URLSearchParams(params), file: join(dir, file),signal,deadline });
        const http_code=typeof response==='string'?response:response.http_code;
        const requested_at=typeof response==='string'?began:response.requested_at;
        const completed_at = new Date().toISOString(); check(http_code === '200', 'OUTCOME_HTTP_FAILED');
        const raw = await bytes(join(dir, file)), body = parseStrict(raw.toString('utf8'));
        check(body.code === '0' && Array.isArray(body.data), 'OUTCOME_RESPONSE_FAILED');
        record.pages.push({ file, sha256: digest(raw), requested_at, completed_at, http_code, params });
        if (!body.data.length) break;
        normalizeRows(body.data, observed_through);
        const oldest = Math.min(...body.data.map(row => Number(row[0])));
        check(Number.isSafeInteger(oldest) && oldest < Number(after), 'OUTCOME_CURSOR_INVALID');
        if (oldest <= record.start_time * 1000) break;
        after = String(oldest);
      }
    } catch (error) {
      record.status = 'failed'; record.error = String(error.message).slice(0, 4000);
    }
    record.completed_at = new Date().toISOString();
    await once(join(dir, 'capture.json'), captureSchema.parse(record));
    return { capture_id, status: record.status };
  }
  async function readCapture(run, id) {
    const dir = capturePath(run, id), raw = await bytes(join(dir, 'capture.json'));
    const record = captureSchema.parse(parseStrict(raw.toString('utf8')));
    check(record.capture_id === id && record.forecast_id === run.run_id && record.forecast_hash === run.hashes.forecast_sha256);
    check(record.start_time === run.forecast.anchor_time && record.observed_through % 900 === 0
      && record.observed_through >= record.start_time && record.observed_through <= record.start_time + 86400
      && record.observed_through <= Date.parse(record.started_at) / 1000
      && Date.parse(record.completed_at) >= Date.parse(record.started_at));
    const rows = []; let after = String(record.observed_through * 1000), previousTime = Date.parse(record.started_at);
    for (const [index, page] of record.pages.entries()) {
      check(page.file === `page-${String(index + 1).padStart(3, '0')}.json` && (record.status === 'failed' || page.params.after === after)
        && Date.parse(page.requested_at) >= previousTime && Date.parse(page.completed_at) >= Date.parse(page.requested_at)
        && Date.parse(page.completed_at) <= Date.parse(record.completed_at));
      const raw = await bytes(join(dir, page.file)); check(digest(raw) === page.sha256, 'OUTCOME_SOURCE_HASH_MISMATCH');
      if (record.status === 'failed') { previousTime = Date.parse(page.completed_at); continue; }
      const body = parseStrict(raw.toString('utf8')); check(body.code === '0' && Array.isArray(body.data));
      rows.push(...body.data); previousTime = Date.parse(page.completed_at);
      if (body.data.length) { const oldest = Math.min(...body.data.map(row => Number(row[0]))); check(oldest < Number(after)); after = String(oldest); }
    }
    if (record.status === 'failed') return { record, candles: [], quality: null, sha256: digest(raw) };
    const normalized = rows.length ? normalizeRows(rows, record.observed_through) : { candles: [], quality: { excluded_unclosed_count: 0, identical_duplicates_removed: 0 } };
    const candles = normalized.candles.filter(c => c.open_time >= record.start_time && c.close_time <= record.observed_through);
    return { record, candles, quality: normalized.quality, sha256: digest(raw) };
  }
  async function methodCode(run) {
    const provenance = await json(join(runsRoot, run.run_id, 'provenance.json'));
    const current = digest(await bytes(join(root, 'src/m1-contracts.ts')));
    check(provenance.code_sha256?.['src/m1-contracts.ts'] === current, 'FROZEN_CLASSIFIER_CODE_CHANGED');
    return current;
  }
  async function readRevision(run, id) {
    const dir = revisionPath(run, id), meta = revisionSchema.parse(await json(join(dir, 'manifest.json')));
    check(meta.revision_id === id && meta.forecast_id === run.run_id && meta.forecast_hash === run.hashes.forecast_sha256);
    const source = await readCapture(run, meta.capture_id); check(source.record.status === 'ok' && source.sha256 === meta.capture_sha256);
    const resultBytes = await bytes(join(dir, 'result.json')); check(digest(resultBytes) === meta.result_sha256, 'EVALUATION_HASH_MISMATCH');
    const result = evaluationSchema.parse(parseStrict(resultBytes.toString('utf8')));
    const provenance=await json(join(runsRoot,run.run_id,'provenance.json'));
    check(meta.method_code_sha256===provenance.code_sha256?.['src/m1-contracts.ts'],'EVALUATION_METHOD_CHANGED');
    const sameCurrent=meta.evaluation_code_sha256 === digest(await bytes(join(root, 'src/m1-evaluation.ts')));
    const scorer=!run.forecast.calibration?await legacyScorer({classifierHash:meta.method_code_sha256,scorerHash:meta.evaluation_code_sha256}):evaluateForecast;
    check(sameCurrent||!run.forecast.calibration,'EVALUATION_CODE_CHANGED');
    check(Date.parse(meta.evaluated_at) >= Date.parse(source.record.completed_at));
    const computed = scorer({ forecast: run.forecast, forecastHash: run.hashes.forecast_sha256,
      candles: source.candles, observedThrough: source.record.observed_through, evaluatedAt: meta.evaluated_at });
    check(canonical(computed) === canonical(result), 'EVALUATION_RECOMPUTE_MISMATCH');
    return { status: 'available', revision_id: id, evaluation_sha256: meta.result_sha256, result };
  }
  async function revisionIds(run) {
    const base = join(folder(run), 'evaluations'); if (!(await exists(base))) return [];
    return (await readdir(base)).filter(id => idPattern.test(id) && id.startsWith('evaluation-')).sort();
  }
  async function computeCapture(run, captureId) {
    const source = await readCapture(run, captureId); check(source.record.status === 'ok', 'OUTCOME_CAPTURE_FAILED');
    const method_code_sha256 = await methodCode(run), evaluation_code_sha256 = digest(await bytes(join(root, 'src/m1-evaluation.ts')));
    for (const id of await revisionIds(run)) {
      const meta = revisionSchema.parse(await json(join(revisionPath(run, id), 'manifest.json')));
      if(meta.evaluation_code_sha256===evaluation_code_sha256){const old=await readCapture(run,meta.capture_id);if(old.record.status==='ok'&&old.record.observed_through===source.record.observed_through&&canonical(old.candles)===canonical(source.candles)&&canonical(old.quality)===canonical(source.quality))return readRevision(run,id);}
    }
    const revision_id = newId('evaluation'), evaluated_at = new Date().toISOString();
    const result = evaluateForecast({ forecast: run.forecast, forecastHash: run.hashes.forecast_sha256,
      candles: source.candles, observedThrough: source.record.observed_through, evaluatedAt: evaluated_at });
    const parent = join(folder(run), 'evaluations'); await directory(parent);
    const temp = join(parent, `.pending-${randomUUID()}`); await directory(temp);
    await once(join(temp, 'result.json'), result);
    await once(join(temp, 'manifest.json'), { schema: 'MFV:M1_EVALUATION_REVISION:v1', revision_id, forecast_id: run.run_id,
      forecast_hash: run.hashes.forecast_sha256, evaluation_version: EVALUATION_VERSION, evaluated_at,
      capture_id: captureId, capture_sha256: source.sha256, result_sha256: digest(encode(result)),
      method_code_sha256, evaluation_code_sha256, local_only: true });
    await rename(temp, revisionPath(run, revision_id));
    return readRevision(run, revision_id);
  }
  async function evaluateCapture(run, captureId) {
    check(idPattern.test(captureId) && captureId.startsWith('capture-'));
    const attemptId = newId('evaluation'), dir = join(folder(run), 'attempts', attemptId);
    await directory(dir);
    await once(join(dir, 'started.json'), { capture_id: captureId, forecast_hash: run.hashes.forecast_sha256,
      started_at: new Date().toISOString(), local_only: true });
    try {
      const result = await computeCapture(run, captureId);
      await once(join(dir, 'outcome.json'), { status: 'available', revision_id: result.revision_id, completed_at: new Date().toISOString() });
      return result;
    } catch (error) {
      await once(join(dir, 'outcome.json'), { status: 'failed', error: String(error.message).slice(0, 4000), completed_at: new Date().toISOString() });
      throw error;
    }
  }
  async function readLatest(run) {
    try {
      const base = join(folder(run), 'captures');
      const captures = await exists(base) ? (await readdir(base)).filter(id => idPattern.test(id) && id.startsWith('capture-')).sort() : [];
      const revisions = await revisionIds(run), latest = revisions.at(-1);
      if (captures.length) {
        const source = await readCapture(run, captures.at(-1));
        if (source.record.status === 'failed') return { status: 'failed', reason: 'evaluation_failed' };
        const attemptsDir = join(folder(run), 'attempts');
        const attempts = await exists(attemptsDir) ? (await readdir(attemptsDir)).filter(id => idPattern.test(id)).sort() : [];
        if (attempts.length) {
          const attemptDir = join(attemptsDir, attempts.at(-1));
          const start = await json(join(attemptDir, 'started.json'));
          check(start.forecast_hash === run.hashes.forecast_sha256);
          if (start.capture_id === source.record.capture_id) {
            if (!(await exists(join(attemptDir, 'outcome.json')))) return { status: 'failed', reason: 'evaluation_incomplete' };
            const outcome = await json(join(attemptDir, 'outcome.json'));
            if (outcome.status === 'failed') return { status: 'failed', reason: 'evaluation_failed' };
            check(outcome.status === 'available' && outcome.revision_id === latest);
          }
        }
        if (!latest) return { status: 'not_evaluated' };
        const meta = revisionSchema.parse(await json(join(revisionPath(run, latest), 'manifest.json')));
        if(meta.capture_id!==captures.at(-1)){const old=await readCapture(run,meta.capture_id);if(old.record.observed_through!==source.record.observed_through||canonical(old.candles)!==canonical(source.candles)||canonical(old.quality)!==canonical(source.quality))return{status:'failed',reason:'evaluation_incomplete'};}
      }
      return latest ? await readRevision(run, latest) : { status: 'not_evaluated' };
    } catch(error) { return { status: 'failed', reason:error.message==='UNKNOWN_SCORER'?'evaluation_unsupported':'evaluation_invalid' }; }
  }
  return { capture, readCapture, evaluateCapture, readRevision, readLatest };
}
