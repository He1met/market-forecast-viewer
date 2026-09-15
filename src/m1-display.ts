import { z } from 'zod';
import { candleSchema, parseStrict } from './contracts';
import { evaluationSchema } from './m1-evaluation';
import { classifyPublication, rawOutputSchema, validateModelOutput } from './m1-contracts';

const iso = z.string().datetime({ offset: false });
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const integer = z.number().int().safe().nonnegative();
const obj = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();
export const runIdSchema = z.string().regex(/^m1-\d{8}T\d{9}Z-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
const raw = rawOutputSchema.innerType();
const scenario = raw.shape.scenarios.element.extend({
  points: z.array(obj({ time: integer, price: z.number().finite().positive() })).length(96),
}).strict();
const stage = raw.shape.stages.element.extend({ start_time: integer, end_time: integer }).strict();

/** Strictly validate the original publication before projecting any display fields. */
export const publishedForecastSchema = raw.extend({
  kind: z.literal('experimental_forecast'), run_id: runIdSchema,
  calibration:obj({schema:z.literal('MFV:CALIBRATION:v1'),lambda:z.union([z.literal(0),z.literal(.1),z.literal(.25),z.literal(.5)]),base:z.array(z.number().min(0).max(1)).length(6),raw_probabilities:z.array(z.number().min(0).max(1)).length(6),raw_main:z.string(),final_main:z.string()}).optional(),
  published_at: iso, generation_started_at: iso, generation_ended_at: iso, information_frozen_at: iso,
  status: z.enum(['valid', 'late']), eligible_as_latest: z.boolean(), data_cutoff: integer,
  event_cutoff: iso.nullable(), event_mode: z.enum(['market_only', 'official_calendar']),
  event_risk_label: z.enum(['未纳入事件风险', '已纳入所列事件信息，其他风险未知']),
  probability_kind: z.literal('subjective_uncalibrated'),
  probability_label: z.literal('主观未校准；24h 类别概率仅用于 24h'),
  range_kind: z.literal('model_range_estimate'), range_label: z.literal('模型范围估计，未经校准'),
  path_label: z.literal('代表路径不是类别的全部可能路径；显示插值不是成交轨迹'),
  step_seconds: z.literal(900), horizon_seconds: z.literal(86400), future_count: z.literal(96),
  scenarios: z.array(scenario).length(6), stages: z.array(stage).length(3),
}).strict().superRefine((forecast, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  if(forecast.calibration){const c=forecast.calibration;const p=forecast.scenarios.map(x=>x.probability_24h);if(Math.abs(c.base.reduce((a,b)=>a+b,0)-1)>1e-8||Math.abs(c.raw_probabilities.reduce((a,b)=>a+b,0)-1)>1e-8||p.some((x,i)=>Math.abs(x-((1-c.lambda)*c.raw_probabilities[i]+c.lambda*c.base[i]))>1e-12)||c.raw_main!==forecast.scenarios[c.raw_probabilities.indexOf(Math.max(...c.raw_probabilities))].id||c.final_main!==forecast.scenarios[p.indexOf(Math.max(...p))].id)fail('Calibration reconstruction mismatch');}
  try {
    validateModelOutput({
      schema_version: forecast.schema_version, method_version: forecast.method_version,
      prompt_version: forecast.prompt_version, anchor_time: forecast.anchor_time, anchor_price: forecast.anchor_price,
      scenarios: forecast.scenarios.map(({ points: _points, ...value }) => value),
      stages: forecast.stages.map(({ start_time: _start, end_time: _end, ...value }) => value),
      summary: forecast.summary, limitations: forecast.limitations,
    }, { anchor_time: forecast.anchor_time, anchor_price: forecast.anchor_price });
    if (classifyPublication(forecast.anchor_time, forecast.published_at) !== forecast.status) fail('Publication status mismatch');
  } catch { fail('Invalid model output or publication time'); }
  if (forecast.eligible_as_latest !== (forecast.status === 'valid') || forecast.data_cutoff !== forecast.anchor_time) fail('Publication anchor or eligibility mismatch');
  const times = [forecast.information_frozen_at, forecast.generation_started_at, forecast.generation_ended_at, forecast.published_at].map(Date.parse);
  if (times.some((time, index) => index > 0 && time < times[index - 1])) fail('Publication chronology mismatch');
  if (forecast.event_cutoff !== null && Date.parse(forecast.event_cutoff) > times[0]) fail('Event cutoff after freeze');
  if ((forecast.event_mode === 'market_only') !== (forecast.event_risk_label === '未纳入事件风险')) fail('Event coverage mismatch');
  forecast.scenarios.forEach(value => value.points.forEach((point, index) => {
    if (point.time !== forecast.anchor_time + (index + 1) * 900 || point.price !== value.prices[index]) fail('Path nodes mismatch');
  }));
  forecast.stages.forEach(value => {
    if (value.start_time !== forecast.anchor_time + (value.start_step - 1) * 900 || value.end_time !== forecast.anchor_time + value.end_step * 900) fail('Stage times mismatch');
  });
});
export type PublishedForecast = z.infer<typeof publishedForecastSchema>;

const historySchema = obj({
  dataset_id: z.string().regex(/^history:[a-f0-9]{64}$/), instrument: z.literal('BTC-USDT-SWAP'),
  market_type: z.literal('linear_perpetual'), price_type: z.literal('trade'), bar_seconds: z.literal(900),
  start_time: integer, end_time: integer, count: z.literal(1344), candles: z.array(candleSchema).length(1344),
  source: obj({ provider: z.literal('OKX'), endpoint: z.literal('https://www.okx.com/api/v5/market/history-candles') }),
  downloaded_at: iso,
}).superRefine((history, ctx) => {
  const fail = () => ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid display history relationship' });
  if (history.start_time !== history.candles[0].open_time || history.end_time !== history.candles.at(-1)!.close_time
    || history.end_time - history.start_time !== 14 * 86400 || history.end_time > Date.parse(history.downloaded_at) / 1000) fail();
  history.candles.forEach((candle, index) => {
    if (candle.open_time % 900 !== 0 || candle.close_time !== candle.open_time + 900
      || (index > 0 && candle.open_time !== history.candles[index - 1].close_time)
      || candle.low > Math.min(candle.open, candle.close) || candle.high < Math.max(candle.open, candle.close)) fail();
  });
});
const configSchema = obj({
  provider: z.literal('official_codex'), selection: z.literal('existing_local_cli_configuration'),
  cli_version: z.string().regex(/^codex-cli [a-zA-Z0-9.+-]{1,80}$/),
  auth_method: z.literal('chatgpt_verified'), sandbox: z.literal('read-only'), output_schema: z.literal(true),
  startup_warning_count: integer,
});
export const displayRunSchema = obj({
  schema: z.literal('MFV:M1_DISPLAY:v1'), run_id: runIdSchema, history: historySchema, forecast: publishedForecastSchema,
  basis:obj({feedback_mode:z.enum(['F0','F1']),case_ids:z.array(hash).max(4),base_count:integer,base_cutoff:iso.nullable(),derivatives_collected:integer,derivatives_incorporated:z.boolean(),calendar_collected:integer,calendar_included:integer}).optional(),
  model: obj({ config: configSchema, identity: z.null(), identity_visibility: z.literal('not_exposed_by_jsonl') }),
  hashes: obj({ input_sha256: hash, forecast_sha256: hash }), evaluation: z.discriminatedUnion('status', [obj({ status: z.literal('not_evaluated') }),
    obj({ status: z.literal('failed'), reason: z.enum(['evaluation_failed', 'evaluation_invalid', 'evaluation_incomplete','evaluation_unsupported']) }),
    obj({ status: z.literal('available'), revision_id: z.string().regex(/^evaluation-\d{8}T\d{9}Z-[a-f0-9-]{36}$/), evaluation_sha256: hash, result: z.lazy(() => evaluationSchema) })]),
}).superRefine((run, ctx) => {
  if (run.evaluation.status === 'available') {
    const e = run.evaluation.result;
    if (e.forecast_id !== run.run_id || e.forecast_hash !== run.hashes.forecast_sha256
      || e.method_version !== run.forecast.method_version || e.prompt_version !== run.forecast.prompt_version
      || e.anchor_time !== run.forecast.anchor_time || e.anchor_price !== run.forecast.anchor_price
      || e.published_at !== run.forecast.published_at) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Evaluation/forecast relationship mismatch' });
  }
  if (run.run_id !== run.forecast.run_id || run.history.end_time !== run.forecast.anchor_time
    || run.history.candles.at(-1)!.close !== run.forecast.anchor_price
    || Date.parse(run.history.downloaded_at) > Date.parse(run.forecast.information_frozen_at)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Run/history/forecast relationship mismatch' });
  }
});
export type DisplayRun = z.infer<typeof displayRunSchema>;
const statusSchema = z.enum(['valid', 'late', 'failed', 'incomplete', 'invalid']);
const reasonSchema = z.enum(['forecast_expired', 'publication_late', 'preparation_failed', 'generation_failed', 'validation_failed', 'generation_incomplete', 'publication_missing', 'archive_invalid']).nullable();
const indexEntry = obj({ run_id: runIdSchema, created_at: iso, published_at: iso.nullable(), status: statusSchema, reason: reasonSchema });
export const indexSchema = obj({
  summary:obj({total_runs:integer,verified_mature_runs:integer,valid_runs:integer,late_runs:integer,failed_runs:integer}).optional(),
  schema: z.literal('MFV:M1_INDEX:v1'), checked_at: iso, latest_run_id: runIdSchema.nullable(),
  latest_attempt: obj({ run_id: runIdSchema, status: statusSchema, created_at: iso, reason: reasonSchema }).nullable(),
  runs: z.array(indexEntry),page_offset:integer.optional(),next_cursor:integer.nullable().optional(),verified_at:iso.optional(),
}).superRefine((index, ctx) => {
  const fail = () => ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid run index relationship' });
  if (new Set(index.runs.map(run => run.run_id)).size !== index.runs.length) fail();
  index.runs.forEach((run, position) => {
    if (position && Date.parse(run.created_at) > Date.parse(index.runs[position - 1].created_at)) fail();
    if (Date.parse(run.created_at) > Date.parse(index.checked_at)) fail();
    if ((run.status === 'valid' || run.status === 'late') !== (run.published_at !== null)) fail();
    if (run.published_at && (Date.parse(run.published_at) < Date.parse(run.created_at) || Date.parse(run.published_at) > Date.parse(index.checked_at))) fail();
    if ((run.status === 'valid' && run.reason !== null && run.reason !== 'forecast_expired')
      || (run.status === 'late' && run.reason !== 'publication_late')
      || (run.status === 'failed' && !['preparation_failed', 'generation_failed', 'validation_failed'].includes(run.reason ?? ''))
      || (run.status === 'incomplete' && !['generation_incomplete', 'publication_missing'].includes(run.reason ?? ''))
      || (run.status === 'invalid' && run.reason !== 'archive_invalid')) fail();
  });
  if(index.page_offset!==undefined)return;
  const latest = index.runs[0];
  if (latest ? !index.latest_attempt || ['run_id', 'created_at', 'status', 'reason'].some(key => latest[key as keyof typeof latest] !== index.latest_attempt![key as keyof typeof index.latest_attempt]) : index.latest_attempt !== null) fail();
  const valid = index.runs.filter(run => run.status === 'valid' && run.reason === null)
    .sort((a, b) => Date.parse(b.published_at!) - Date.parse(a.published_at!))[0];
  if (index.latest_run_id !== (valid?.run_id ?? null)) fail();
});
export type DisplayIndex = z.infer<typeof indexSchema>;

const cycleIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,179}$/);
const runtimeAttemptSchema = obj({
  cycle_id: cycleIdSchema, trigger: z.enum(['manual', 'scheduled']),
  status: z.enum(['running', 'completed', 'failed', 'late', 'skipped']),
  stage: z.enum(['check_release', 'score_old', 'collect_events', 'prepare', 'generate', 'publish_index', 'done', 'unknown']),
  started_at: iso, updated_at: iso, completed_at: iso.nullable(),
  reason: z.enum(['code_changed', 'lock_busy', 'paused', 'runtime_failed', 'publication_late', 'unknown']).nullable(),
  forecast_id: runIdSchema.nullable(),
});
/** Small read-only projection. Scheduler times are never inferred from a frequency. */
export const runtimeDisplaySchema = obj({
  schema: z.literal('MFV:M1_RUNTIME_DISPLAY:v1'), checked_at: iso,
  source: z.literal('installed').optional(),
  publication_health: obj({basis:z.literal('local_schedule'),expected_since:iso.nullable(),checked_at:iso,
    status:z.enum(['paused','unknown','waiting','current','stalled']),slots:z.array(obj({slot_id:z.string().regex(/^[a-f0-9]{64}$/),anchor_time:z.number().int(),deadline_at:iso,status:z.enum(['present','missing','unknown']),forecast_id:runIdSchema.nullable()})).max(2)}).optional(),
  inspection: obj({ paused: z.boolean(), freshness: z.enum(['unknown', 'fresh', 'stale', 'clock_invalid']),
    last_observed_at: iso.nullable(), result: z.enum(['unknown', 'ok', 'failed']) }).optional(),
  release_integrity: z.enum(['verified', 'changed', 'unknown', 'unconfigured']),
  configuration: obj({
    task_name: z.literal('M1 实验预测运行'), frequency_hours: z.literal(2),
    time_zone: z.string().min(1).max(80).refine(value => {
      try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; }
    }).nullable(), enabled: z.boolean(), next_run_at: z.null(), read_back_at: iso,
  }).nullable(),
  paused: z.boolean(), latest_attempt: runtimeAttemptSchema.nullable(),
  last_success: obj({ cycle_id: cycleIdSchema, completed_at: iso, forecast_id: runIdSchema }).nullable(),
}).superRefine((runtime, ctx) => {
  const fail = () => ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid runtime status relationship' });
  const attempt = runtime.latest_attempt;
  if (runtime.source === 'installed') {
    if (runtime.configuration !== null || runtime.release_integrity !== 'verified' || !runtime.inspection) fail();
    const inspection = runtime.inspection;
    if (inspection) {
      const age = inspection.last_observed_at === null ? null : Date.parse(runtime.checked_at) - Date.parse(inspection.last_observed_at);
      const expected = age === null ? 'unknown' : age < 0 ? 'clock_invalid' : age > 90 * 60000 ? 'stale' : 'fresh';
      if (inspection.freshness !== expected || (age === null) !== (inspection.result === 'unknown')) fail();
    }
  } else {
    if (runtime.inspection || (runtime.configuration === null) !== (runtime.release_integrity === 'unconfigured')) fail();
  }
  const health=runtime.publication_health;
  if(health){
    if(runtime.source!=='installed'||health.checked_at!==runtime.checked_at||(health.status==='paused')!==runtime.paused)fail();
    if(health.status==='current'&&health.slots[0]?.status!=='present'||health.status==='stalled'&&health.slots[0]?.status!=='missing')fail();
    for(const slot of health.slots)if((slot.status==='present')!==(slot.forecast_id!==null)||Date.parse(slot.deadline_at)>Date.parse(health.checked_at)||Date.parse(slot.deadline_at)!==(slot.anchor_time+1020)*1000)fail();
  }
  if (runtime.configuration && Date.parse(runtime.configuration.read_back_at) > Date.parse(runtime.checked_at)) fail();
  if (runtime.last_success && Date.parse(runtime.last_success.completed_at) > Date.parse(runtime.checked_at)) fail();
  if (!attempt) return;
  if (Date.parse(attempt.started_at) > Date.parse(attempt.updated_at) || Date.parse(attempt.updated_at) > Date.parse(runtime.checked_at)) fail();
  if ((attempt.status === 'running') !== (attempt.completed_at === null)) fail();
  if (attempt.completed_at && (Date.parse(attempt.completed_at) < Date.parse(attempt.started_at)
    || Date.parse(attempt.completed_at) > Date.parse(attempt.updated_at))) fail();
  if (attempt.status === 'completed' && (!runtime.last_success || runtime.last_success.cycle_id !== attempt.cycle_id
    || runtime.last_success.forecast_id !== attempt.forecast_id
    || (runtime.source === 'installed' ? Date.parse(runtime.last_success.completed_at) < Date.parse(attempt.started_at)
      || Date.parse(runtime.last_success.completed_at) > Date.parse(attempt.completed_at!)
      : runtime.last_success.completed_at !== attempt.completed_at))) fail();
});
export type RuntimeDisplay = z.infer<typeof runtimeDisplaySchema>;

async function load<T>(url: string, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { method: 'GET', cache: 'no-store', credentials: 'same-origin', redirect: 'error', signal });
  if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) throw Error(`实验档案读取失败（HTTP ${response.status}）`);
  return schema.parse(parseStrict(await response.text()));
}
export const loadDisplayIndex = (signal?: AbortSignal,cursor=0) => load(cursor?'/api/m1/index?cursor='+cursor:'/api/m1/index', indexSchema, signal);
export const loadRuntimeDisplay = (signal?: AbortSignal) => load('/api/m1/runtime', runtimeDisplaySchema, signal);
export async function loadDisplayRun(id: string, signal?: AbortSignal): Promise<DisplayRun> {
  const runId = runIdSchema.parse(id);
  const run = await load(`/api/m1/runs/${runId}`, displayRunSchema, signal);
  if (run.run_id !== runId) throw Error('实验档案 run_id 关联错误');
  return run;
}
