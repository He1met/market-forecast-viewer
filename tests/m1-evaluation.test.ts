import { describe, expect, it } from 'vitest';
import type { Candle } from '../src/contracts';
import { CATEGORY_IDS, METHOD_VERSION, PROMPT_VERSION } from '../src/m1-contracts';
import { publishedForecastSchema } from '../src/m1-display';
import { evaluateForecast, evaluationSchema, type EvaluationInput } from '../src/m1-evaluation';

// All prices and timestamps in these tests are synthetic; no fixture is an actual forecast.
const anchor = 1_789_200_000;
const at = (seconds: number) => new Date(seconds * 1000).toISOString();
function forecast() {
  const paths = CATEGORY_IDS.map((_, index) => Array<number>(96).fill(index === 2 ? 100.5 : index === 3 ? 99.5 : 100));
  paths[0][0] = 101; paths[1][0] = 99; paths[5][0] = 100.6;
  return publishedForecastSchema.parse({
    schema_version: 'm1.0', method_version: METHOD_VERSION, prompt_version: PROMPT_VERSION,
    kind: 'experimental_forecast', run_id: 'm1-20260913T030000000Z-12345678-1234-4123-8123-123456789012',
    anchor_time: anchor, anchor_price: 100, published_at: at(anchor + 4),
    information_frozen_at: at(anchor + 1), generation_started_at: at(anchor + 2), generation_ended_at: at(anchor + 3),
    status: 'valid', eligible_as_latest: true, data_cutoff: anchor, event_cutoff: null,
    event_mode: 'market_only', event_risk_label: '未纳入事件风险',
    probability_kind: 'subjective_uncalibrated', probability_label: '主观未校准；24h 类别概率仅用于 24h',
    range_kind: 'model_range_estimate', range_label: '模型范围估计，未经校准',
    path_label: '代表路径不是类别的全部可能路径；显示插值不是成交轨迹',
    step_seconds: 900, horizon_seconds: 86400, future_count: 96,
    scenarios: CATEGORY_IDS.map((id, index) => ({ id, probability_24h: index === 0 ? 0.5 : 0.1, prices: paths[index],
      points: paths[index].map((price, node) => ({ time: anchor + (node + 1) * 900, price })),
      support: ['Synthetic support'], counterevidence: ['Synthetic counterevidence'], invalidations: ['Synthetic invalidation'],
    })),
    stages: [[1, 24], [25, 48], [49, 96]].map(([start_step, end_step]) => ({ start_step, end_step, lower: 99, upper: 101,
      explanation: 'Synthetic uncalibrated range', start_time: anchor + (start_step - 1) * 900, end_time: anchor + end_step * 900 })),
    summary: 'Synthetic scoring test, not a real forecast', limitations: ['Synthetic fixture only'],
  });
}
function candles(values: number[]): Candle[] {
  return values.map((close, index) => ({ open_time: anchor + index * 900, close_time: anchor + (index + 1) * 900,
    open: close, high: close, low: close, close, volume_contracts: 1, volume_base: 1, volume_quote: close, closed: true }));
}
function input(count = 96): EvaluationInput {
  return { forecast: forecast(), forecastHash: 'a'.repeat(64), candles: candles(Array<number>(count).fill(100)),
    observedThrough: anchor + count * 900, evaluatedAt: at(anchor + count * 900 + 10) };
}

describe('synthetic hand-calculated evaluation', () => {
  it('scores every representative and fixed baseline at matching timestamps, with partial status', () => {
    const sample = input(3); sample.candles = candles([101, 99, 102]);
    sample.candles[0].high = 1000; sample.candles[0].low = 1;
    sample.candles[1].low = 98; sample.candles[2].high = 103;
    const result = evaluateForecast(sample), window = result.windows.h6;
    expect(window).toMatchObject({ maturity: 'partial', status: 'partial', observed_count: 3, expected_count: 24,
      expected_observed_count: 3, missing_times: [], actual_category: null, brier_score: null });
    expect(window.constant_baseline.mae_price).toBeCloseTo(4 / 3, 12);
    expect(window.constant_baseline.mae_return_pct).toBeCloseTo(4 / 3, 12);
    expect(window.scenario_errors.map(value => value.id)).toEqual([...CATEGORY_IDS]);
    expect(window.scenario_errors[0].mae_price).toBeCloseTo(1, 12);
    expect(window.scenario_errors[1].mae_price).toBeCloseTo(5 / 3, 12);
    expect(window.scenario_errors[2].mae_price).toBeCloseTo(7 / 6, 12);
    expect(window.scenario_errors[3].mae_price).toBeCloseTo(1.5, 12);
    expect(window.scenario_errors[4].mae_price).toBeCloseTo(4 / 3, 12);
    expect(window.scenario_errors[5].mae_price).toBeCloseTo(3.4 / 3, 12);
    const stage = result.stages[0];
    expect(stage).toMatchObject({ width_price: 2, width_return_pct: 2, ohlc_eligible_count: 2, excluded_prepublication_candles: 1,
      observed: { close_min: 99, close_max: 102, ohlc_low: 98, ohlc_high: 103,
        close_max_upside_pct: 2, close_max_downside_pct: 1, ohlc_max_upside_pct: 3, ohlc_max_downside_pct: 2,
        close_coverage: 2 / 3, ohlc_coverage: 0, return_pair_count: 2 } });
    expect(stage.observed!.realized_volatility).toBeCloseTo(Math.sqrt(Math.log(99 / 101) ** 2 + Math.log(102 / 99) ** 2), 12);
    expect(result.stages[1].observed).toBeNull();
    expect(result.actual_points).toEqual(sample.candles.map(candle => ({ time: candle.close_time, price: candle.close })));
  });
  it('retains null before the first scoring node and does not mark a not-due event wrong', () => {
    const sample = input(0); sample.observedThrough = anchor + 899; sample.evaluatedAt = at(anchor + 899);
    const result = evaluateForecast(sample);
    for (const window of Object.values(result.windows)) {
      expect(window).toMatchObject({ status: 'not_due', maturity: 'not_due', observed_count: 0, expected_observed_count: 0,
        actual_category: null, brier_score: null, constant_baseline: { mae_price: null, mae_return_pct: null } });
      expect(window.scenario_errors).toHaveLength(6);
      expect(window.scenario_errors.every(error => error.mae_price === null && error.mae_return_pct === null)).toBe(true);
    }
    expect(result.actual_points).toEqual([]);
    expect(result.stages.every(stage => stage.observed === null)).toBe(true);
  });
  it.each([24, 48, 96])('matures each window at its exact close boundary (%i nodes)', count => {
    const result = evaluateForecast(input(count));
    Object.values(result.windows).forEach(window => {
      expect(window.status).toBe(window.expected_count <= count ? 'mature' : 'partial');
      expect(window.actual_category).toBe(window.expected_count <= count ? 'narrow' : null);
      expect(window.brier_score).toBe(window.horizon_seconds === 86400 && count === 96 ? 1.1 : null);
    });
  });
  it('uses sum-of-six Brier without dividing by class count, with exact best/worst bounds', () => {
    const sample = input(); sample.forecast.scenarios.forEach(scenario => { scenario.probability_24h = scenario.id === 'narrow' ? 1 : 0; });
    expect(evaluateForecast(sample).windows.h24.brier_score).toBe(0);
    sample.forecast.scenarios.forEach(scenario => { scenario.probability_24h = scenario.id === 'uptrend' ? 1 : 0; });
    expect(evaluateForecast(sample).windows.h24.brier_score).toBe(2);
    sample.forecast.scenarios.forEach(scenario => { scenario.probability_24h = 1 / 6; });
    expect(evaluateForecast(sample).windows.h24.brier_score).toBeCloseTo(5 / 6, 12);
  });
  it('uses the frozen reversal and direction boundary rules rather than interpreting OHLC order', () => {
    const sample = input(24); sample.candles = candles([101, ...Array<number>(23).fill(100)]);
    expect(evaluateForecast(sample).windows.h6.actual_category).toBe('surge_reversal');
    sample.candles = candles(Array<number>(24).fill(100.5));
    sample.candles[1].low = 97; sample.candles[1].high = 103;
    expect(evaluateForecast(sample).windows.h6.actual_category).toBe('uptrend');
    sample.candles = candles(Array<number>(24).fill(99.5));
    expect(evaluateForecast(sample).windows.h6.actual_category).toBe('downtrend');
  });
  it('aligns stage boundaries and reuses only the actual adjacent prior-stage close for volatility', () => {
    const sample = input(25); sample.candles[23].close = 101; sample.candles[23].high = 101;
    const result = evaluateForecast(sample);
    expect(result.stages[0].observed_count).toBe(24);
    expect(result.stages[1]).toMatchObject({ expected_observed_count: 1, observed_count: 1, maturity: 'partial',
      observed: { return_pair_count: 1, close_min: 100, close_max: 100 } });
    expect(result.stages[1].observed!.realized_volatility).toBeCloseTo(Math.log(1.01), 12);
  });
  it('allows strictly future close scoring but cannot determine pre/post-publication intrabar extrema', () => {
    const sample = input(1), result = evaluateForecast(sample);
    expect(result.windows.h6.constant_baseline.mae_price).toBe(0);
    expect(result.stages[0]).toMatchObject({ ohlc_eligible_count: 0, excluded_prepublication_candles: 1,
      observed: { ohlc_low: null, ohlc_high: null, ohlc_coverage: null, return_pair_count: 0, realized_volatility: null } });
    sample.forecast.information_frozen_at = at(anchor); sample.forecast.generation_started_at = at(anchor);
    sample.forecast.generation_ended_at = at(anchor); sample.forecast.published_at = at(anchor);
    expect(evaluateForecast(sample).stages[0].ohlc_eligible_count).toBe(1);
  });
});

describe('missing outcomes and reproducibility', () => {
  it('retains gaps, aligns later MAE by time, stops plotted lines, and never bridges a missing return', () => {
    const sample = input(24); sample.candles = candles([101, ...Array<number>(23).fill(100)]); sample.candles.splice(1, 1);
    const result = evaluateForecast(sample), window = result.windows.h6;
    expect(window).toMatchObject({ maturity: 'mature', status: 'missing_data', observed_count: 23,
      expected_observed_count: 24, missing_times: [anchor + 1800], actual_category: null, brier_score: null });
    expect(window.scenario_errors[0].mae_price).toBe(0);
    expect(result.actual_points).toEqual([{ time: anchor + 900, price: 101 }]);
    expect(result.omitted_after_gap_count).toBe(22);
    expect(result.stages[0].observed!.return_pair_count).toBe(21);
    expect(result.stages[0].observed!.realized_volatility).toBe(0);
  });
  it('keeps missing_data before maturity and all-null observations when acquisition returns none', () => {
    const sample = input(3); sample.candles = [];
    const result = evaluateForecast(sample);
    expect(result.windows.h6).toMatchObject({ maturity: 'partial', status: 'missing_data', observed_count: 0,
      missing_times: [anchor + 900, anchor + 1800, anchor + 2700] });
    expect(result.windows.h6.constant_baseline.mae_price).toBeNull();
    expect(result.stages[0].observed).toBeNull();
  });
  it('omits all plotted nodes if the first is missing, while retaining later observed statistics', () => {
    const sample = input(3); sample.candles.shift();
    const result = evaluateForecast(sample);
    expect(result.actual_points).toEqual([]);
    expect(result.omitted_after_gap_count).toBe(2);
    expect(result.windows.h6.constant_baseline.mae_price).toBe(0);
    expect(result.stages[0].observed!.return_pair_count).toBe(1);
  });
  it('is deterministic, leaves inputs unchanged and permits a separate corrected evaluation after missing data arrives', () => {
    const sample = input(); sample.candles.splice(5, 1);
    const before = JSON.stringify(sample), missing = evaluateForecast(sample);
    expect(evaluateForecast(sample)).toEqual(missing);
    expect(JSON.stringify(sample)).toBe(before);
    sample.candles = candles(Array<number>(96).fill(100));
    sample.evaluatedAt = at(anchor + 86400 + 20);
    const corrected = evaluateForecast(sample);
    expect(missing.windows.h24.brier_score).toBeNull();
    expect(corrected.windows.h24.brier_score).toBeCloseTo(1.1, 12);
    expect(corrected.forecast_hash).toBe(missing.forecast_hash);
    expect(corrected.evaluated_at).not.toBe(missing.evaluated_at);
  });
  it('makes the entire late publication ineligible even when its observed windows are mature', () => {
    const sample = input(); sample.forecast.published_at = at(anchor + 900);
    sample.forecast.status = 'late'; sample.forecast.eligible_as_latest = false;
    const result = evaluateForecast(sample);
    expect(result.status).toBe('ineligible');
    expect(result.actual_points).toEqual([]);
    expect(result.stages.every(stage => stage.observed === null)).toBe(true);
    for (const window of Object.values(result.windows)) {
      expect(window).toMatchObject({ maturity: 'mature', status: 'ineligible', actual_category: null, brier_score: null,
        constant_baseline: { mae_price: null, mae_return_pct: null } });
    }
  });
});

describe('strict scoring boundaries', () => {
  it.each(['probability bounds', 'probability sum', 'duplicate category', 'overlapping representative', 'method', 'prompt', 'late status', 'path time', 'unknown forecast field'])('rejects %s', problem => {
    const sample = input();
    if (problem === 'probability bounds') sample.forecast.scenarios[0].probability_24h = -0.1;
    if (problem === 'probability sum') sample.forecast.scenarios[0].probability_24h += 0.1;
    if (problem === 'duplicate category') sample.forecast.scenarios[0].id = 'narrow';
    if (problem === 'overlapping representative') {
      sample.forecast.scenarios[0].prices = sample.forecast.scenarios[4].prices;
      sample.forecast.scenarios[0].points = sample.forecast.scenarios[4].points;
    }
    if (problem === 'method') Object.assign(sample.forecast, { method_version: 'm2' });
    if (problem === 'prompt') Object.assign(sample.forecast, { prompt_version: 'm2' });
    if (problem === 'late status') sample.forecast.published_at = at(anchor + 900);
    if (problem === 'path time') sample.forecast.scenarios[0].points[0].time++;
    if (problem === 'unknown forecast field') Object.assign(sample.forecast, { forged: true });
    expect(() => evaluateForecast(sample)).toThrow();
  });
  it.each(['duplicate', 'reverse', 'alignment', 'open time', 'history', 'beyond horizon', 'unclosed', 'OHLC', 'future', 'clock', 'millisecond', 'hash'])('rejects invalid observation %s', problem => {
    const sample = input();
    if (problem === 'duplicate') sample.candles[1] = sample.candles[0];
    if (problem === 'reverse') sample.candles.reverse();
    if (problem === 'alignment') { sample.candles[0].close_time++; sample.candles[0].open_time++; }
    if (problem === 'open time') sample.candles[0].open_time++;
    if (problem === 'history') { sample.candles[0].close_time = anchor; sample.candles[0].open_time = anchor - 900; }
    if (problem === 'beyond horizon') { sample.candles[95].close_time += 900; sample.candles[95].open_time += 900; }
    if (problem === 'unclosed') Object.assign(sample.candles[0], { closed: false });
    if (problem === 'OHLC') sample.candles[0].low = 101;
    if (problem === 'future') sample.observedThrough--;
    if (problem === 'clock') sample.evaluatedAt = at(sample.observedThrough - 1);
    if (problem === 'millisecond') sample.observedThrough *= 1000;
    if (problem === 'hash') sample.forecastHash = 'bad';
    expect(() => evaluateForecast(sample)).toThrow();
  });
  it.each(['unknown field', 'early category', 'early brier', 'status', 'count', 'gap time', 'future actual', 'false width'])('rejects malformed persisted evaluation %s', problem => {
    const result = evaluateForecast(input(3));
    if (problem === 'unknown field') Object.assign(result, { forged: true });
    if (problem === 'early category') result.windows.h6.actual_category = 'narrow';
    if (problem === 'early brier') result.windows.h6.brier_score = 0;
    if (problem === 'status') result.windows.h6.status = 'mature';
    if (problem === 'count') result.windows.h6.observed_count--;
    if (problem === 'gap time') result.windows.h6.missing_times.push(anchor + 4 * 900);
    if (problem === 'future actual') result.actual_points[0].time += 900;
    if (problem === 'false width') result.stages[0].width_price++;
    expect(() => evaluationSchema.parse(result)).toThrow();
  });
});
