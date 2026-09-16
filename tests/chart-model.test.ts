import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { validateForecast, validateHistory, type Scheme } from '../src/contracts';
import { CATEGORY_IDS, METHOD_VERSION, PROMPT_VERSION } from '../src/m1-contracts';
import { displayRunSchema, type DisplayRun } from '../src/m1-display';
import { CATEGORY_DEFINITIONS, CATEGORY_LABELS, chartPriceRange, chartSupportPoints,
  toExperimentChart, validateActualPoints, type ChartForecast, type ChartHistory } from '../src/chart-model';

/** Entirely synthetic display fixture; it is never published or presented as a real forecast. */
function fixture(): DisplayRun {
  const anchor = 1_789_200_000, run_id = 'm1-20260913T030000000Z-12345678-1234-4123-8123-123456789012';
  const at = (seconds: number) => new Date(seconds * 1000).toISOString();
  const prices = CATEGORY_IDS.map((_, index) => Array<number>(96).fill(index === 2 ? 100.5 : index === 3 ? 99.5 : 100));
  prices[0][0] = 101; prices[1][0] = 99; prices[5][0] = 100.6;
  return displayRunSchema.parse({
    schema: 'MFV:M1_DISPLAY:v1', run_id,
    history: {
      dataset_id: 'history:' + 'a'.repeat(64), instrument: 'BTC-USDT-SWAP',
      market_type: 'linear_perpetual', price_type: 'trade', bar_seconds: 900,
      start_time: anchor - 1344 * 900, end_time: anchor, count: 1344,
      candles: Array.from({ length: 1344 }, (_, index) => ({
        open_time: anchor - (1344 - index) * 900, close_time: anchor - (1343 - index) * 900,
        open: 100, high: 100.2, low: 99.8, close: 100,
        volume_contracts: 1, volume_base: 1, volume_quote: 100, closed: true,
      })),
      source: { provider: 'OKX', endpoint: 'https://www.okx.com/api/v5/market/history-candles' },
      downloaded_at: at(anchor + 1),
    },
    forecast: {
      schema_version: 'm1.0', method_version: METHOD_VERSION, prompt_version: PROMPT_VERSION,
      kind: 'experimental_forecast', run_id, anchor_time: anchor, anchor_price: 100,
      published_at: at(anchor + 4), generation_started_at: at(anchor + 2),
      generation_ended_at: at(anchor + 3), information_frozen_at: at(anchor + 1),
      status: 'valid', eligible_as_latest: true, data_cutoff: anchor, event_cutoff: null,
      event_mode: 'market_only', event_risk_label: '未纳入事件风险',
      probability_kind: 'subjective_uncalibrated', probability_label: '主观未校准；24h 类别概率仅用于 24h',
      range_kind: 'model_range_estimate', range_label: '模型范围估计，未经校准',
      path_label: '代表路径不是类别的全部可能路径；显示插值不是成交轨迹',
      step_seconds: 900, horizon_seconds: 86400, future_count: 96,
      scenarios: CATEGORY_IDS.map((id, index) => ({
        id, probability_24h: index === 0 ? .5 : .1, prices: prices[index],
        points: prices[index].map((price, node) => ({ time: anchor + (node + 1) * 900, price })),
        support: ['Synthetic support'], counterevidence: ['Synthetic counterevidence'], invalidations: ['Synthetic invalidation'],
      })),
      stages: [[1, 24, 95, 105], [25, 48, 80, 120], [49, 96, 90, 110]].map(([start_step, end_step, lower, upper]) => ({
        start_step, end_step, lower, upper, explanation: 'Synthetic uncalibrated range',
        start_time: anchor + (start_step - 1) * 900, end_time: anchor + end_step * 900,
      })),
      summary: 'Synthetic projection test, not a real forecast', limitations: ['Synthetic values only'],
    },
    model: {
      config: { provider: 'official_codex', selection: 'existing_local_cli_configuration',
        cli_version: 'codex-cli 0.0.0', auth_method: 'chatgpt_verified', sandbox: 'read-only', output_schema: true, startup_warning_count: 0 },
      identity: null, identity_visibility: 'not_exposed_by_jsonl',
    },
    hashes: { input_sha256: 'b'.repeat(64), forecast_sha256: 'c'.repeat(64) },
    evaluation: { status: 'not_evaluated' },
  });
}

describe('independent chart projection', () => {
  it('retains run identity, all exact paths and three single-layer stage ranges without mutating the validated run', () => {
    const run = fixture(), before = JSON.stringify(run), { history, forecast } = toExperimentChart(run);
    expect(history.dataset_id).toBe(run.history.dataset_id);
    expect(forecast).toMatchObject({ mode: 'experiment', run_id: run.run_id,
      anchor_time: run.forecast.anchor_time, horizon_seconds: 86400, step_seconds: 900 });
    expect(forecast.bands).toEqual({ kind: 'model_range_estimate', label: '模型范围估计，未经校准' });
    expect(forecast).not.toHaveProperty('demo');
    expect(forecast).not.toHaveProperty('source_kind');
    expect(forecast.bands).not.toHaveProperty('points');
    forecast.scenarios.forEach((scenario, index) => {
      expect(scenario.points).toEqual(run.forecast.scenarios[index].points);
      expect(scenario.points).not.toBe(run.forecast.scenarios[index].points);
      expect(scenario.name).toBe(CATEGORY_LABELS[run.forecast.scenarios[index].id]);
      expect(scenario.description).toBe(CATEGORY_DEFINITIONS[run.forecast.scenarios[index].id]);
      expect(scenario).not.toHaveProperty('probability_6h');
    });
    forecast.stages.forEach((stage, index) => {
      const published = run.forecast.stages[index];
      expect(stage).toMatchObject({ start_time: published.start_time, end_time: published.end_time,
        lower: published.lower, upper: published.upper, explanation: published.explanation });
      expect(stage).not.toHaveProperty('inner_lower');
      expect(stage).not.toHaveProperty('outer_lower');
    });
    expect(forecast.stages.map(stage => stage.name)).toEqual(['0–6h', '6–12h', '12–24h']);
    expect(JSON.stringify(run)).toBe(before);
  });
  it('preserves exact original DEMO input assignability and support nodes', async () => {
    const history = await validateHistory(JSON.parse(await readFile('public/data/history.json', 'utf8')));
    const forecast = await validateForecast(JSON.parse(await readFile('public/data/forecast.demo.json', 'utf8')), history);
    const chartHistory: ChartHistory = history, chartForecast: ChartForecast = forecast;
    const support = chartSupportPoints(chartHistory, chartForecast);
    expect(support).toHaveLength(1441);
    expect(support.at(-1)).toEqual({ time: forecast.bands.points.at(-1)!.time,
      value: (forecast.bands.points.at(-1)!.inner_lower + forecast.bands.points.at(-1)!.inner_upper) / 2 });
  });
  it('keeps all 96 future times and the anchor as coordinate support without adding future candles', () => {
    const { history, forecast } = toExperimentChart(fixture());
    const points = chartSupportPoints(history, forecast);
    expect(points).toHaveLength(1441);
    expect(history.candles).toHaveLength(1344);
    expect(points[1343].time).toBe(forecast.anchor_time - 900);
    expect(points[1344]).toEqual({ time: forecast.anchor_time, value: forecast.anchor_price });
    expect(points.slice(1345).map(point => point.time)).toEqual(forecast.scenarios[0].points.map(point => point.time));
    expect(new Set(points.slice(1345).map(point => point.value))).toEqual(new Set([forecast.anchor_price]));
  });
  it('retains frozen ordering, endpoint wording and 24h definitions', () => {
    expect(Object.keys(CATEGORY_LABELS)).toEqual([...CATEGORY_IDS]);
    expect(Object.keys(CATEGORY_DEFINITIONS)).toEqual([...CATEGORY_IDS]);
    expect(Object.values(CATEGORY_DEFINITIONS).every(text => text.includes('24h'))).toBe(true);
    expect(CATEGORY_DEFINITIONS.uptrend).toContain('不保证单调');
    expect(CATEGORY_DEFINITIONS.dip_rebound).toContain('先排除冲高回落');
  });
});

describe('experiment autoscale reflects published stage rectangles', () => {
  const scheme: Scheme = { id: 'demo', name: 'demo', mode: { id: 'demo', label: 'DEMO' },
    lower_price: 1, upper_price: 999, distribution: 'arithmetic', interval_count: 1, levels: [1, 999] };
  it.each([[0, 95, 105], [21600, 80, 120], [43200, 90, 110]])('keeps exact stage bounds within a cropped stage at offset %i with all paths hidden', (offset, lower, upper) => {
    const { history, forecast } = toExperimentChart(fixture());
    expect(chartPriceRange(history, forecast, forecast.anchor_time + offset + 450,
      forecast.anchor_time + offset + 1800, new Set())).toEqual({ minValue: lower, maxValue: upper });
  });
  it('includes each actual stage at a boundary without a sloping transition or DEMO grid range', () => {
    const { history, forecast } = toExperimentChart(fixture());
    const boundary = forecast.stages[1].start_time;
    expect(chartPriceRange(history, forecast, boundary - 100, boundary + 100, new Set(), scheme))
      .toEqual({ minValue: 80, maxValue: 120 });
  });
  it('unions visible paths and measured closes on the same scale while preserving hidden-path exclusion', () => {
    const { history, forecast } = toExperimentChart(fixture());
    forecast.scenarios[0].points[0].price = 140;
    const from = forecast.anchor_time + 900, to = from + 900;
    expect(chartPriceRange(history, forecast, from, to, new Set())).toEqual({ minValue: 95, maxValue: 105 });
    expect(chartPriceRange(history, forecast, from, to, new Set(['surge_reversal']))).toEqual({ minValue: 95, maxValue: 140 });
    expect(chartPriceRange(history, forecast, from, to, new Set(), undefined, [{ time: from, price: 70 }]))
      .toEqual({ minValue: 70, maxValue: 105 });
  });
});

describe('explicit future actual-overlay entrance', () => {
  it('does not invent observations and copies valid points before chart mutation', () => {
    const { forecast } = toExperimentChart(fixture());
    expect(validateActualPoints(forecast, [])).toEqual([]);
    const points = [{ time: forecast.anchor_time + 900, price: 101 }];
    const checked = validateActualPoints(forecast, points);
    expect(checked).toEqual(points);
    expect(checked[0]).not.toBe(points[0]);
  });
  it.each(['anchor', 'late', 'unaligned', 'duplicate', 'negative', 'nan'])('rejects %s observations before an overlay changes', kind => {
    const { forecast } = toExperimentChart(fixture());
    const point = { time: forecast.anchor_time + 900, price: 100 };
    if (kind === 'anchor') point.time = forecast.anchor_time;
    if (kind === 'late') point.time = forecast.anchor_time + 86400 + 900;
    if (kind === 'unaligned') point.time++;
    if (kind === 'negative') point.price = -1;
    if (kind === 'nan') point.price = NaN;
    expect(() => validateActualPoints(forecast, kind === 'duplicate' ? [point, point] : [point])).toThrow();
  });
  it('cannot attach supplied observations to a missing or DEMO forecast', async () => {
    const history = await validateHistory(JSON.parse(await readFile('public/data/history.json', 'utf8')));
    const forecast = await validateForecast(JSON.parse(await readFile('public/data/forecast.demo.json', 'utf8')), history);
    const points = [{ time: forecast.anchor_time + 900, price: 100 }];
    expect(() => validateActualPoints(undefined, points)).toThrow('experimental');
    expect(() => validateActualPoints(forecast, points)).toThrow('experimental');
  });
});
