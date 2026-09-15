import { z } from 'zod';
import { candleSchema, type Candle } from './contracts';

export const METHOD_VERSION = 'm1-path-events-v1' as const;
export const PROMPT_VERSION = 'm1-codex-v1' as const;
export const CATEGORY_IDS = ['surge_reversal', 'dip_rebound', 'uptrend', 'downtrend', 'narrow', 'other'] as const;
export type PathCategory = typeof CATEGORY_IDS[number];
export type HorizonSeconds = 21600 | 43200 | 86400;
export const STEP_SECONDS = 900;
export const PROBABILITY_SUM_TOLERANCE = 1e-8;
// Only floating-point roundoff is tolerated at the frozen price thresholds.
const ROUNDING_EPSILON = 8 * Number.EPSILON;
const atLeast = (value: number, threshold: number) => value >= threshold - ROUNDING_EPSILON;
const atMost = (value: number, threshold: number) => value <= threshold + ROUNDING_EPSILON;
const positive = z.number().finite().positive();
// Ten-digit epoch seconds, aligned to a completed 15-minute candle boundary.
const anchorTimeSchema = z.number().int().safe().min(0).max(9_999_999_999)
  .refine(value => value % STEP_SECONDS === 0, 'anchor_time must be aligned epoch seconds');
const inputAnchorSchema = z.object({ anchor_time: anchorTimeSchema, anchor_price: positive }).strict();
const text = z.string().trim().min(1);

/** Prices are future closes only; step zero is always the frozen anchor. */
export function classifyPath(prices: number[], anchor: number, horizonSeconds: HorizonSeconds): PathCategory {
  positive.parse(anchor);
  if (![21600, 43200, 86400].includes(horizonSeconds)) throw Error('Unsupported classification horizon');
  const parsed = z.array(positive).length(horizonSeconds / STEP_SECONDS).parse(prices);
  const returns = [0, ...parsed.map(price => (price - anchor) / anchor)];
  if (!returns.every(Number.isFinite)) throw Error('Path relative prices overflow');
  const end = returns.at(-1)!;
  const reversal = (direction: 1 | -1) => {
    if (!atMost(direction * end, 0.005)) return false;
    for (let first = 1; first + 4 < returns.length; first++) {
      if (!atLeast(direction * returns[first], 0.01)) continue;
      for (let later = first + 4; later < returns.length; later++) {
        if (atLeast(direction * (returns[first] - returns[later]), 0.01)) return true;
      }
    }
    return false;
  };
  if (reversal(1)) return 'surge_reversal';
  if (reversal(-1)) return 'dip_rebound';
  // These two categories describe endpoint direction, not monotonic motion.
  if (atLeast(end, 0.005)) return 'uptrend';
  if (atMost(end, -0.005)) return 'downtrend';
  if (atMost(Math.max(...returns) - Math.min(...returns), 0.005)) return 'narrow';
  return 'other';
}

const scenarioSchema = z.object({
  id: z.enum(CATEGORY_IDS),
  probability_24h: z.number().finite().min(0).max(1),
  prices: z.array(positive).length(96),
  support: z.array(text).min(1),
  counterevidence: z.array(text).min(1),
  invalidations: z.array(text).min(1),
}).strict();
const stageSchema = z.object({
  start_step: z.number().int(), end_step: z.number().int(),
  lower: positive, upper: positive, explanation: text,
}).strict();
export const rawOutputSchema = z.object({
  schema_version: z.literal('m1.0'), method_version: z.literal(METHOD_VERSION),
  prompt_version: z.literal(PROMPT_VERSION), anchor_time: anchorTimeSchema, anchor_price: positive,
  scenarios: z.array(scenarioSchema).length(6), stages: z.array(stageSchema).length(3),
  summary: text, limitations: z.array(text).min(1),
}).strict().superRefine((output, ctx) => {
  const fail = (path: (string | number)[], message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
  if (new Set(output.scenarios.map(scenario => scenario.id)).size !== CATEGORY_IDS.length) {
    fail(['scenarios'], 'Scenarios must uniquely cover all six categories');
  }
  const sum = output.scenarios.reduce((total, scenario) => total + scenario.probability_24h, 0);
  if (Math.abs(sum - 1) > PROBABILITY_SUM_TOLERANCE) fail(['scenarios'], '24h probabilities must sum to one within 1e-8');
  output.scenarios.forEach((scenario, index) => {
    try {
      if (classifyPath(scenario.prices, output.anchor_price, 86400) !== scenario.id) {
        fail(['scenarios', index, 'prices'], 'Representative path does not match its frozen category');
      }
    } catch {
      fail(['scenarios', index, 'prices'], 'Representative path contains invalid relative prices');
    }
  });
  const boundaries = [[1, 24], [25, 48], [49, 96]];
  output.stages.forEach((stage, index) => {
    if (stage.start_step !== boundaries[index]?.[0] || stage.end_step !== boundaries[index]?.[1]) {
      fail(['stages', index], 'Stages must cover steps 1-24, 25-48 and 49-96 in order');
    }
    if (stage.lower > stage.upper) fail(['stages', index], 'Stage lower price exceeds upper price');
  });
});
export type ModelOutput = z.infer<typeof rawOutputSchema>;

export function validateModelOutput(raw: unknown, input: { anchor_time: number; anchor_price: number }): ModelOutput {
  const anchor = inputAnchorSchema.parse(input);
  const output = rawOutputSchema.parse(raw);
  if (output.anchor_time !== anchor.anchor_time || output.anchor_price !== anchor.anchor_price) {
    throw Error('Model anchor does not exactly match frozen input');
  }
  return output;
}

/** The program adds timestamps; raw model JSON cannot supply node or publication times. */
export function buildPathNodes(prices: number[], anchorTime: number) {
  anchorTimeSchema.parse(anchorTime);
  const values = z.array(positive).length(96).parse(prices);
  return values.map((price, index) => ({ time: anchorTime + (index + 1) * STEP_SECONDS, price }));
}

export function classifyPublication(anchorTime: number, publishedAtISO: string): 'valid' | 'late' {
  anchorTimeSchema.parse(anchorTime);
  z.string().datetime({ offset: true }).parse(publishedAtISO);
  const published = Date.parse(publishedAtISO) / 1000;
  if (!Number.isFinite(published) || published < anchorTime) throw Error('Publication precedes the frozen anchor');
  return published < anchorTime + STEP_SECONDS ? 'valid' : 'late';
}

const jsonText = { type: 'string', minLength: 1 };
const jsonPrice = { type: 'number', exclusiveMinimum: 0 };
const jsonTexts = { type: 'array', minItems: 1, items: jsonText };
const jsonObject = (properties: Record<string, unknown>) => ({
  type: 'object', properties, required: Object.keys(properties), additionalProperties: false,
});
// Cross-field identities, sums, category membership and ordered stages are rechecked by Zod.
export const rawOutputJsonSchema = jsonObject({
  schema_version: { type: 'string', enum: ['m1.0'] },
  method_version: { type: 'string', enum: [METHOD_VERSION] },
  prompt_version: { type: 'string', enum: [PROMPT_VERSION] },
  anchor_time: { type: 'integer', minimum: 0, maximum: 9_999_999_999, multipleOf: STEP_SECONDS },
  anchor_price: jsonPrice,
  scenarios: { type: 'array', minItems: 6, maxItems: 6, items: jsonObject({
    id: { type: 'string', enum: [...CATEGORY_IDS] },
    probability_24h: { type: 'number', minimum: 0, maximum: 1 },
    prices: { type: 'array', minItems: 96, maxItems: 96, items: jsonPrice },
    support: jsonTexts, counterevidence: jsonTexts, invalidations: jsonTexts,
  }) },
  stages: { type: 'array', minItems: 3, maxItems: 3, items: jsonObject({
    start_step: { type: 'integer', enum: [1, 25, 49] },
    end_step: { type: 'integer', enum: [24, 48, 96] },
    lower: jsonPrice, upper: jsonPrice, explanation: jsonText,
  }) },
  summary: jsonText, limitations: jsonTexts,
});

/** Completed, contiguous OKX trade candles only. Volatility is not annualized. */
export function extractFeatures(candles: Candle[]) {
  const input = z.array(candleSchema).min(1).parse(candles);
  input.forEach((candle, index) => {
    anchorTimeSchema.parse(candle.close_time);
    if (candle.open_time !== candle.close_time - STEP_SECONDS
      || (index > 0 && candle.open_time !== input[index - 1].close_time)) {
      throw Error('Feature input requires contiguous complete 15m candles');
    }
    if (candle.low > Math.min(candle.open, candle.close) || candle.high < Math.max(candle.open, candle.close)) {
      throw Error('Feature input has inconsistent OHLC prices');
    }
  });
  const last = input.at(-1)!;
  const windowFeatures = (horizon: HorizonSeconds) => {
    const steps = horizon / STEP_SECONDS;
    if (input.length < steps + 1) return {
      status: 'unknown' as const, reason: 'insufficient_history' as const,
      required_candles: steps + 1, available_candles: input.length,
    };
    const sample = input.slice(-steps);
    const baseline = input[input.length - steps - 1].close;
    const closes = [baseline, ...sample.map(candle => candle.close)];
    const logReturns = sample.map((_, index) => Math.log(closes[index + 1]) - Math.log(closes[index]));
    const metrics = {
      return_fraction: (last.close - baseline) / baseline,
      close_to_close_realized_volatility: Math.sqrt(logReturns.reduce((sum, value) => sum + value * value, 0)),
      range_fraction: (Math.max(...sample.map(candle => candle.high)) - Math.min(...sample.map(candle => candle.low))) / baseline,
      quote_volume: sample.reduce((sum, candle) => sum + candle.volume_quote, 0),
    };
    if (!Object.values(metrics).every(Number.isFinite)) throw Error('Feature calculation overflow');
    return { status: 'available' as const, horizon_seconds: horizon,
      start_time: sample[0].open_time, end_time: last.close_time, candle_count: steps, ...metrics };
  };
  const closeDate = new Date(last.close_time * 1000);
  return {
    method_version: METHOD_VERSION, candle_count: input.length,
    input_start_time: input[0].open_time, input_end_time: last.close_time, anchor_price: last.close,
    windows: { h6: windowFeatures(21600), h12: windowFeatures(43200), h24: windowFeatures(86400) },
    utc: { close_hour: closeDate.getUTCHours(), close_minute: closeDate.getUTCMinutes(),
      close_weekday_sunday_zero: closeDate.getUTCDay() },
    open_interest: { status: 'unknown' as const, reason: 'not_acquired' as const },
    funding: { status: 'unknown' as const, reason: 'not_acquired' as const },
  };
}
