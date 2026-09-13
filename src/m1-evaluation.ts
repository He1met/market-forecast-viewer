import { z } from 'zod';
import { candleSchema, type Candle } from './contracts';
import { CATEGORY_IDS, classifyPath, METHOD_VERSION, PROMPT_VERSION, STEP_SECONDS, type HorizonSeconds } from './m1-contracts';
import { publishedForecastSchema, type PublishedForecast } from './m1-display';

export const EVALUATION_VERSION = 'm1-evaluation-v1' as const;
const obj = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();
const integer = z.number().int().safe().nonnegative();
const epoch = integer.max(9_999_999_999);
const price = z.number().finite().positive();
const nonnegative = z.number().finite().nonnegative();
const optionalMetric = nonnegative.nullable();
const coverage = z.number().finite().min(0).max(1).nullable();
const iso = z.string().datetime({ offset: false });
const maturitySchema = z.enum(['not_due', 'partial', 'mature']);
const statusSchema = z.enum(['not_due', 'partial', 'mature', 'missing_data', 'ineligible']);
const availability = {
  maturity: maturitySchema, status: statusSchema,
  observed_count: integer.max(96), expected_count: integer.positive().max(96),
  expected_observed_count: integer.max(96), missing_times: z.array(epoch).max(96),
};
const errors = { mae_price: optionalMetric, mae_return_pct: optionalMetric };
const windowSchema = obj({
  horizon_seconds: z.union([z.literal(21600), z.literal(43200), z.literal(86400)]), due_at: iso,
  ...availability, actual_category: z.enum(CATEGORY_IDS).nullable(), brier_score: nonnegative.max(2 + 1e-8).nullable(),
  scenario_errors: z.array(obj({ id: z.enum(CATEGORY_IDS), ...errors })).length(6), constant_baseline: obj(errors),
});
const stageSchema = obj({
  start_step: integer.positive(), end_step: integer.positive(), start_time: epoch, end_time: epoch,
  ...availability, lower: price, upper: price, width_price: nonnegative, width_return_pct: nonnegative,
  ohlc_eligible_count: integer.max(96), excluded_prepublication_candles: integer.max(96),
  observed: obj({
    close_min: price, close_max: price, ohlc_low: price.nullable(), ohlc_high: price.nullable(),
    close_max_upside_pct: nonnegative, close_max_downside_pct: nonnegative,
    ohlc_max_upside_pct: optionalMetric, ohlc_max_downside_pct: optionalMetric,
    realized_volatility: optionalMetric, return_pair_count: integer.max(95),
    close_coverage: coverage, ohlc_coverage: coverage,
  }).nullable(),
});

/** No revisions or raw responses here: the archive adds its own immutable receipt. */
export const evaluationSchema = obj({
  schema: z.literal('MFV:M1_EVALUATION:v1'),
  forecast_id: z.string().regex(/^m1-\d{8}T\d{9}Z-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/),
  forecast_hash: z.string().regex(/^[a-f0-9]{64}$/),
  method_version: z.literal(METHOD_VERSION), prompt_version: z.literal(PROMPT_VERSION),
  evaluation_version: z.literal(EVALUATION_VERSION),
  anchor_time: epoch, anchor_price: price, published_at: iso, evaluated_at: iso, observed_through: epoch,
  status: statusSchema,
  actual_points: z.array(obj({ time: epoch, price })).max(96), omitted_after_gap_count: integer.max(96),
  windows: obj({ h6: windowSchema, h12: windowSchema, h24: windowSchema }), stages: z.array(stageSchema).length(3),
}).superRefine((evaluation, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  const published = Date.parse(evaluation.published_at) / 1000;
  const evaluated = Date.parse(evaluation.evaluated_at) / 1000;
  const late = published >= evaluation.anchor_time + STEP_SECONDS;
  if (evaluation.anchor_time % STEP_SECONDS || published < evaluation.anchor_time || evaluated < published
    || evaluation.observed_through < evaluation.anchor_time || evaluation.observed_through > evaluated) fail('Invalid evaluation chronology');
  const checkAvailability = (value: z.infer<typeof windowSchema> | z.infer<typeof stageSchema>, start: number, end: number) => {
    const expected = Math.max(0, Math.min(end, Math.floor((evaluation.observed_through - evaluation.anchor_time) / STEP_SECONDS)) - start + 1);
    const maturity = expected === 0 ? 'not_due' : expected === end - start + 1 ? 'mature' : 'partial';
    const status = late ? 'ineligible' : value.missing_times.length ? 'missing_data' : maturity;
    if (value.expected_count !== end - start + 1 || value.expected_observed_count !== expected
      || value.observed_count + value.missing_times.length !== expected || value.maturity !== maturity || value.status !== status) fail('Invalid observation availability');
    value.missing_times.forEach((time, index) => {
      if (time < evaluation.anchor_time + start * STEP_SECONDS || time > evaluation.anchor_time + (start + expected - 1) * STEP_SECONDS
        || time % STEP_SECONDS || (index > 0 && time <= value.missing_times[index - 1])) fail('Invalid missing node times');
    });
  };
  const horizons = [21600, 43200, 86400];
  Object.values(evaluation.windows).forEach((window, index) => {
    checkAvailability(window, 1, horizons[index] / STEP_SECONDS);
    if (window.horizon_seconds !== horizons[index] || Date.parse(window.due_at) / 1000 !== evaluation.anchor_time + horizons[index]) fail('Invalid horizon identity');
    if ((window.actual_category !== null) !== (window.status === 'mature')) fail('Event category requires a complete mature window');
    if ((window.brier_score !== null) !== (window.status === 'mature' && index === 2)) fail('Brier requires the complete mature 24h event');
    window.scenario_errors.forEach((error, position) => {
      if (error.id !== CATEGORY_IDS[position]) fail('Scenario errors must preserve all frozen categories');
    });
    for (const error of [...window.scenario_errors, window.constant_baseline]) {
      const available = !late && window.observed_count > 0;
      if ((error.mae_price !== null) !== available || (error.mae_return_pct !== null) !== available) fail('MAE availability mismatch');
    }
  });
  const boundaries = [[1, 24], [25, 48], [49, 96]];
  evaluation.stages.forEach((stage, index) => {
    const [start, end] = boundaries[index];
    checkAvailability(stage, start, end);
    if (stage.start_step !== start || stage.end_step !== end || stage.start_time !== evaluation.anchor_time + (start - 1) * STEP_SECONDS
      || stage.end_time !== evaluation.anchor_time + end * STEP_SECONDS || stage.lower > stage.upper
      || stage.width_price !== stage.upper - stage.lower || stage.width_return_pct !== stage.width_price / evaluation.anchor_price * 100) fail('Invalid stage identity or width');
    if (stage.ohlc_eligible_count + stage.excluded_prepublication_candles !== stage.observed_count) fail('OHLC publication eligibility mismatch');
    if ((stage.observed !== null) !== (!late && stage.observed_count > 0)) fail('Stage statistics availability mismatch');
    if (stage.observed) {
      const statistics = stage.observed;
      if (statistics.close_min > statistics.close_max || statistics.close_coverage === null
        || (statistics.realized_volatility !== null) !== (statistics.return_pair_count > 0)) fail('Invalid close statistics');
      const ohlcAvailable = stage.ohlc_eligible_count > 0;
      for (const metric of [statistics.ohlc_low, statistics.ohlc_high, statistics.ohlc_max_upside_pct, statistics.ohlc_max_downside_pct, statistics.ohlc_coverage]) {
        if ((metric !== null) !== ohlcAvailable) fail('OHLC statistics require wholly post-publication candles');
      }
      if (ohlcAvailable && statistics.ohlc_low! > statistics.ohlc_high!) fail('Invalid OHLC extrema');
    }
  });
  const h24 = evaluation.windows.h24;
  if (evaluation.status !== h24.status || evaluation.omitted_after_gap_count !== (late ? 0 : h24.observed_count - evaluation.actual_points.length)) fail('Invalid overall status or display prefix');
  const expectedPrefix = late ? 0 : h24.missing_times.length
    ? (h24.missing_times[0] - evaluation.anchor_time) / STEP_SECONDS - 1 : h24.expected_observed_count;
  if (evaluation.actual_points.length !== expectedPrefix) fail('Actual display points must stop at the first gap');
  evaluation.actual_points.forEach((point, index) => {
    if (point.time !== evaluation.anchor_time + (index + 1) * STEP_SECONDS || point.time <= published || point.time > evaluation.observed_through) fail('Invalid actual display node');
  });
});
export type EvaluationResult = z.infer<typeof evaluationSchema>;

export interface EvaluationInput {
  forecast: PublishedForecast;
  forecastHash: string;
  candles: Candle[];
  /** Latest time for which acquisition was attempted; missing closed bars stay missing. */
  observedThrough: number;
  evaluatedAt: string;
}

/** Pure, deterministic scoring of the unchanged publication, without acquisition or a clock. */
export function evaluateForecast(input: EvaluationInput): EvaluationResult {
  const forecast = publishedForecastSchema.parse(input.forecast);
  const observedThrough = epoch.parse(input.observedThrough);
  const evaluatedAt = iso.parse(input.evaluatedAt);
  const published = Date.parse(forecast.published_at) / 1000;
  if (observedThrough < forecast.anchor_time || observedThrough > Date.parse(evaluatedAt) / 1000
    || Date.parse(evaluatedAt) < Date.parse(forecast.published_at)) throw Error('Invalid evaluation chronology');
  const candles = z.array(candleSchema).max(96).parse(input.candles);
  candles.forEach((candle, index) => {
    if (candle.close_time % STEP_SECONDS || candle.open_time !== candle.close_time - STEP_SECONDS
      || candle.close_time <= forecast.anchor_time || candle.close_time > forecast.anchor_time + 86400
      || candle.close_time > observedThrough || (index > 0 && candle.close_time <= candles[index - 1].close_time)
      || candle.low > Math.min(candle.open, candle.close) || candle.high < Math.max(candle.open, candle.close)) {
      throw Error('Evaluation requires ordered, unique, aligned, completed future OHLC candles');
    }
  });
  const byTime = new Map(candles.map(candle => [candle.close_time, candle]));
  const eligible = forecast.status === 'valid';
  if (eligible && candles.some(candle => candle.close_time <= published)) throw Error('Scoring nodes must follow first publication');
  const availabilityFor = (start: number, end: number) => {
    const last = Math.min(end, Math.floor((observedThrough - forecast.anchor_time) / STEP_SECONDS));
    const times = Array.from({ length: Math.max(0, last - start + 1) }, (_, index) => forecast.anchor_time + (start + index) * STEP_SECONDS);
    const sample = times.flatMap(time => byTime.has(time) ? [byTime.get(time)!] : []);
    const missing = times.filter(time => !byTime.has(time));
    const maturity = times.length === 0 ? 'not_due' as const : times.length === end - start + 1 ? 'mature' as const : 'partial' as const;
    return { sample, value: { maturity, status: !eligible ? 'ineligible' as const : missing.length ? 'missing_data' as const : maturity,
      observed_count: sample.length, expected_count: end - start + 1, expected_observed_count: times.length, missing_times: missing } };
  };
  const errorFor = (sample: Candle[], prices: number[]) => {
    if (!eligible || !sample.length) return { mae_price: null, mae_return_pct: null };
    const mae = sample.reduce((sum, candle) => {
      const index = (candle.close_time - forecast.anchor_time) / STEP_SECONDS - 1;
      return sum + Math.abs(candle.close - prices[index]) / sample.length;
    }, 0);
    return { mae_price: mae, mae_return_pct: mae / forecast.anchor_price * 100 };
  };
  const constant = Array<number>(96).fill(forecast.anchor_price);
  const windowFor = (horizon: HorizonSeconds) => {
    const { sample, value } = availabilityFor(1, horizon / STEP_SECONDS);
    const category = value.status === 'mature' ? classifyPath(sample.map(candle => candle.close), forecast.anchor_price, horizon) : null;
    return { horizon_seconds: horizon, due_at: new Date((forecast.anchor_time + horizon) * 1000).toISOString(), ...value,
      actual_category: category,
      // Multiclass Brier: sum over all six classes, no division by K; theoretical range [0, 2].
      brier_score: horizon === 86400 && category !== null ? forecast.scenarios.reduce((sum, scenario) => sum + (scenario.probability_24h - Number(scenario.id === category)) ** 2, 0) : null,
      scenario_errors: CATEGORY_IDS.map(id => ({ id, ...errorFor(sample, forecast.scenarios.find(scenario => scenario.id === id)!.prices) })),
      constant_baseline: errorFor(sample, constant),
    };
  };
  const windows = { h6: windowFor(21600), h12: windowFor(43200), h24: windowFor(86400) };
  const stages = forecast.stages.map(stage => {
    const { sample, value } = availabilityFor(stage.start_step, stage.end_step);
    // A candle opening before publication includes unknown intrabar ordering around publication.
    const ohlc = sample.filter(candle => candle.open_time >= published);
    const width = stage.upper - stage.lower;
    const up = (maximum: number) => Math.max(0, (maximum - forecast.anchor_price) / forecast.anchor_price * 100);
    const down = (minimum: number) => Math.max(0, (forecast.anchor_price - minimum) / forecast.anchor_price * 100);
    const closes = sample.map(candle => candle.close);
    // Both ends must be actual future closes. No anchor/pre-publication or cross-gap return.
    const returns = sample.flatMap(candle => {
      const previous = byTime.get(candle.close_time - STEP_SECONDS);
      return previous && previous.close_time > published ? [Math.log(candle.close) - Math.log(previous.close)] : [];
    });
    const closeMin = Math.min(...closes), closeMax = Math.max(...closes);
    const ohlcLow = ohlc.length ? Math.min(...ohlc.map(candle => candle.low)) : null;
    const ohlcHigh = ohlc.length ? Math.max(...ohlc.map(candle => candle.high)) : null;
    return { start_step: stage.start_step, end_step: stage.end_step, start_time: stage.start_time, end_time: stage.end_time,
      ...value, lower: stage.lower, upper: stage.upper, width_price: width, width_return_pct: width / forecast.anchor_price * 100,
      ohlc_eligible_count: ohlc.length, excluded_prepublication_candles: sample.length - ohlc.length,
      observed: !eligible || !sample.length ? null : {
        close_min: closeMin, close_max: closeMax, ohlc_low: ohlcLow, ohlc_high: ohlcHigh,
        close_max_upside_pct: up(closeMax), close_max_downside_pct: down(closeMin),
        ohlc_max_upside_pct: ohlcHigh === null ? null : up(ohlcHigh), ohlc_max_downside_pct: ohlcLow === null ? null : down(ohlcLow),
        realized_volatility: returns.length ? Math.sqrt(returns.reduce((sum, value) => sum + value * value, 0)) : null,
        return_pair_count: returns.length,
        close_coverage: sample.filter(candle => candle.close >= stage.lower && candle.close <= stage.upper).length / sample.length,
        ohlc_coverage: ohlc.length ? ohlc.filter(candle => candle.low >= stage.lower && candle.high <= stage.upper).length / ohlc.length : null,
      },
    };
  });
  const actual = eligible ? candles.slice(0, windows.h24.missing_times.length
    ? (windows.h24.missing_times[0] - forecast.anchor_time) / STEP_SECONDS - 1 : candles.length) : [];
  return evaluationSchema.parse({ schema: 'MFV:M1_EVALUATION:v1', forecast_id: forecast.run_id, forecast_hash: input.forecastHash,
    method_version: forecast.method_version, prompt_version: forecast.prompt_version, evaluation_version: EVALUATION_VERSION,
    anchor_time: forecast.anchor_time, anchor_price: forecast.anchor_price, published_at: forecast.published_at,
    evaluated_at: evaluatedAt, observed_through: observedThrough, status: windows.h24.status,
    actual_points: actual.map(candle => ({ time: candle.close_time, price: candle.close })),
    omitted_after_gap_count: eligible ? candles.length - actual.length : 0, windows, stages });
}
