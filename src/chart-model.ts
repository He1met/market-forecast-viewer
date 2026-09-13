import type { Forecast, History, Scheme } from './contracts';
import type { DisplayRun } from './m1-display';
import type { PathCategory } from './m1-contracts';

/** A drawing projection, independent from the sealed DEMO file contract. */
export type ChartHistory = Pick<History,
  'dataset_id' | 'instrument' | 'market_type' | 'price_type' | 'bar_seconds'
  | 'start_time' | 'end_time' | 'candles' | 'downloaded_at'> & {
  count: number;
  source: Pick<History['source'], 'provider' | 'endpoint'>;
};
type ForecastDrawing = Pick<Forecast,
  'anchor_time' | 'anchor_price' | 'horizon_seconds' | 'step_seconds' | 'scenarios'>;
export type DemoChartForecast = ForecastDrawing & Pick<Forecast, 'bands' | 'stages'> & { mode?: 'demo' };
export type ExperimentStage = {
  id: string; name: string; start_time: number; end_time: number;
  lower: number; upper: number; explanation: string;
};
export type ExperimentChartForecast = ForecastDrawing & {
  mode: 'experiment';
  run_id: string;
  stages: ExperimentStage[];
  bands: { kind: 'model_range_estimate'; label: string };
};
export type ChartForecast = DemoChartForecast | ExperimentChartForecast;
/** #13 may supply verified completed closes through setActual; this module acquires none. */
export type ActualChartPoint = { time: number; price: number };

export const CATEGORY_LABELS: Readonly<Record<PathCategory, string>> = Object.freeze({
  surge_reversal: '冲高回落', dip_rebound: '下探回升', uptrend: '终点向上',
  downtrend: '终点向下', narrow: '窄幅', other: '其他复杂路径',
});
export const CATEGORY_DEFINITIONS: Readonly<Record<PathCategory, string>> = Object.freeze({
  surge_reversal: '未来24h内先出现相对锚点至少 +1% 的收盘节点，至少4步后回落至少锚点的1%，终点不高于 +0.5%。',
  dip_rebound: '未来24h内先出现相对锚点至多 -1% 的收盘节点，至少4步后回升至少锚点的1%，终点不低于 -0.5%；先排除冲高回落类。',
  uptrend: '排除两种反转类后，未来24h终点相对锚点至少 +0.5%；不保证单调持续上涨。',
  downtrend: '排除两种反转类后，未来24h终点相对锚点至多 -0.5%；不保证单调持续下跌。',
  narrow: '排除反转和终点方向类后，未来24h收盘节点（含锚点）的最大值减最小值不大于锚点的0.5%。',
  other: '未来24h收盘采样路径中，冲高回落、下探回升、终点向上、终点向下、窄幅以外的全部路径。',
});

/** Strict DisplayRun validation happens before projection; no probability or price is derived here. */
export function toExperimentChart(run: DisplayRun): { history: ChartHistory; forecast: ExperimentChartForecast } {
  const f = run.forecast;
  return {
    history: run.history,
    forecast: {
      mode: 'experiment', run_id: run.run_id,
      anchor_time: f.anchor_time, anchor_price: f.anchor_price,
      horizon_seconds: f.horizon_seconds, step_seconds: f.step_seconds,
      scenarios: f.scenarios.map(scenario => ({
        id: scenario.id, name: CATEGORY_LABELS[scenario.id],
        description: CATEGORY_DEFINITIONS[scenario.id],
        points: scenario.points.map(point => ({ time: point.time, price: point.price })),
      })),
      bands: { kind: f.range_kind, label: f.range_label },
      stages: f.stages.map(stage => ({
        id: `steps-${stage.start_step}-${stage.end_step}`,
        name: `${(stage.start_step - 1) * f.step_seconds / 3600}–${stage.end_step * f.step_seconds / 3600}h`,
        start_time: stage.start_time, end_time: stage.end_time,
        lower: stage.lower, upper: stage.upper, explanation: stage.explanation,
      })),
    },
  };
}

export function isExperimentForecast(f: ChartForecast): f is ExperimentChartForecast {
  return f.mode === 'experiment';
}

/** Keep every future node on the common price/time scale, even with all paths hidden. */
export function chartSupportPoints(h: ChartHistory, f: ChartForecast) {
  const future = isExperimentForecast(f)
    // A constant coordinate carrier, never a forecast line, tooltip value or autoscale input.
    ? f.scenarios[0].points.map(point => ({ time: point.time, value: f.anchor_price }))
    : f.bands.points.map(point => ({ time: point.time, value: (point.inner_lower + point.inner_upper) / 2 }));
  return [...h.candles.map(candle => ({ time: candle.open_time, value: candle.close })),
    { time: f.anchor_time, value: f.anchor_price }, ...future];
}

/** Range union uses the same frozen stage rectangles as the primitive; no interpolated M1 bands. */
export function chartPriceRange(h: ChartHistory, f: ChartForecast | undefined,
  from: number, to: number, visiblePaths: ReadonlySet<string>, scheme?: Scheme,
  actual: readonly ActualChartPoint[] = []) {
  const values = h.candles.filter(candle => candle.open_time >= from && candle.open_time <= to)
    .flatMap(candle => [candle.low, candle.high]);
  const collectLine = (points: { time: number; value: number }[]) => {
    points.forEach((point, index) => {
      if (point.time >= from && point.time <= to) values.push(point.value);
      if (index === 0) return;
      const previous = points[index - 1];
      for (const edge of [from, to]) if (edge > previous.time && edge < point.time) {
        values.push(previous.value + (point.value - previous.value) * (edge - previous.time) / (point.time - previous.time));
      }
    });
  };
  if (f) {
    if (isExperimentForecast(f)) {
      for (const stage of f.stages) if (stage.end_time >= from && stage.start_time <= to) {
        values.push(stage.lower, stage.upper);
      }
    } else {
      for (const key of ['outer_lower', 'outer_upper'] as const) collectLine([
        { time: f.anchor_time, value: f.anchor_price },
        ...f.bands.points.map(point => ({ time: point.time, value: point[key] })),
      ]);
    }
    for (const scenario of f.scenarios) if (visiblePaths.has(scenario.id)) collectLine([
      { time: f.anchor_time, value: f.anchor_price },
      ...scenario.points.map(point => ({ time: point.time, value: point.price })),
    ]);
    if (actual.length) collectLine([{ time: f.anchor_time, value: f.anchor_price },
      ...actual.map(point => ({ time: point.time, value: point.price }))]);
    if (!values.length) values.push(f.anchor_price * .99, f.anchor_price * 1.01);
  }
  if (scheme && (!f || !isExperimentForecast(f))) values.push(scheme.lower_price, scheme.upper_price);
  if (!values.length) values.push(h.candles.at(-1)!.close * .99, h.candles.at(-1)!.close * 1.01);
  return { minValue: Math.min(...values), maxValue: Math.max(...values) };
}

/** Reject malformed future observations before touching an existing actual overlay. */
export function validateActualPoints(f: ChartForecast | undefined, points: readonly ActualChartPoint[]) {
  if (points.length && (!f || !isExperimentForecast(f))) throw Error('Actual overlay requires an experimental forecast');
  return points.map((point, index) => {
    if (!f || !Number.isSafeInteger(point.time) || !Number.isFinite(point.price) || point.price <= 0
      || point.time <= f.anchor_time || point.time > f.anchor_time + f.horizon_seconds
      || (point.time - f.anchor_time) % f.step_seconds !== 0
      || (index > 0 && point.time <= points[index - 1].time)) {
      throw Error('Actual overlay requires ordered, aligned completed closes within this run');
    }
    return { time: point.time, price: point.price };
  });
}
