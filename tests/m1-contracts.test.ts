import { describe, expect, it } from 'vitest';
import type { Candle } from '../src/contracts';
import { buildPathNodes, CATEGORY_IDS, classifyPath, classifyPublication, extractFeatures,
  METHOD_VERSION, PROMPT_VERSION, rawOutputJsonSchema, validateModelOutput, type HorizonSeconds } from '../src/m1-contracts';

const anchor = { anchor_time: 1_789_200_000, anchor_price: 100 };
const path = (end = 100) => Array<number>(96).fill(end);
const representatives = () => {
  const surge = path(); surge[0] = 101;
  const dip = path(); dip[0] = 99;
  const other = path(); other[0] = 100.6;
  return [surge, dip, path(100.5), path(99.5), path(), other];
};
function model() {
  return {
    schema_version: 'm1.0', method_version: METHOD_VERSION, prompt_version: PROMPT_VERSION, ...anchor,
    scenarios: CATEGORY_IDS.map((id, index) => ({ id, probability_24h: index === 0 ? 0.5 : 0.1,
      prices: representatives()[index], support: ['Fixture support'], counterevidence: ['Fixture counterevidence'], invalidations: ['Fixture invalidation'] })),
    stages: [[1, 24], [25, 48], [49, 96]].map(([start_step, end_step]) => ({ start_step, end_step, lower: 98, upper: 102, explanation: 'Uncalibrated model range fixture' })),
    summary: 'Synthetic contract fixture, not a forecast', limitations: ['Subjective and uncalibrated'],
  };
}

describe('frozen path categories', () => {
  it.each(CATEGORY_IDS)('classifies representative %s', id => {
    const index = CATEGORY_IDS.indexOf(id);
    expect(classifyPath(representatives()[index], 100, 86400)).toBe(id);
  });
  it.each([21600, 43200, 86400] as HorizonSeconds[])('uses the actual %i horizon without 24h probability reuse', horizon => {
    expect(classifyPath(Array<number>(horizon / 900).fill(100), 100, horizon)).toBe('narrow');
    expect(() => classifyPath(Array<number>(horizon / 900 - 1).fill(100), 100, horizon)).toThrow();
  });
  it('requires four steps between excursion and reversal, including the exact boundary', () => {
    const tooSoon = path(); tooSoon[92] = 101;
    expect(classifyPath(tooSoon, 100, 86400)).toBe('other');
    tooSoon[92] = 100; tooSoon[91] = 101;
    expect(classifyPath(tooSoon, 100, 86400)).toBe('surge_reversal');
  });
  it('does not reverse the time order of excursion and recovery', () => {
    const reversed = path(); reversed[95] = 101;
    expect(classifyPath(reversed, 100, 86400)).toBe('uptrend');
  });
  it('requires the excursion, subsequent move and endpoint thresholds separately', () => {
    const excursionTooSmall = path(); excursionTooSmall[0] = 100.99999;
    expect(classifyPath(excursionTooSmall, 100, 86400)).toBe('other');
    const retreatTooSmall = path(100.3); retreatTooSmall[0] = 101.2;
    expect(classifyPath(retreatTooSmall, 100, 86400)).toBe('other');
    const endpointTooHigh = path(100.50001); endpointTooHigh[0] = 102;
    expect(classifyPath(endpointTooHigh, 100, 86400)).toBe('uptrend');
  });
  it('includes reversal endpoint and drawdown boundaries', () => {
    const surge = path(100.5); surge[0] = 101.5;
    const dip = path(99.5); dip[0] = 98.5;
    expect(classifyPath(surge, 100, 86400)).toBe('surge_reversal');
    expect(classifyPath(dip, 100, 86400)).toBe('dip_rebound');
  });
  it('freezes overlap priority: surge before dip and both before direction', () => {
    const both = path(); both[0] = 101; both[4] = 99; both[8] = 101;
    expect(classifyPath(both, 100, 86400)).toBe('surge_reversal');
    const dipUp = path(100.6); dipUp[0] = 99;
    expect(classifyPath(dipUp, 100, 86400)).toBe('dip_rebound');
  });
  it('includes anchor in range and gives endpoint direction priority at 0.5%', () => {
    expect(classifyPath(path(100.5), 100, 86400)).toBe('uptrend');
    expect(classifyPath(path(99.5), 100, 86400)).toBe('downtrend');
    const narrow = path(100.1); narrow[0] = 100.5;
    expect(classifyPath(narrow, 100, 86400)).toBe('narrow');
    narrow[0] += 0.00001;
    expect(classifyPath(narrow, 100, 86400)).toBe('other');
  });
  it.each([0, -1, NaN, Infinity])('rejects invalid price %s', bad => {
    const prices = path(); prices[30] = bad;
    expect(() => classifyPath(prices, 100, 86400)).toThrow();
    expect(() => classifyPath(path(), bad, 86400)).toThrow();
  });
  it('rejects unsupported horizons and numerical overflow', () => {
    expect(() => classifyPath(path(), 100, 900 as HorizonSeconds)).toThrow();
    expect(() => classifyPath(path(1e308), 1e-308, 86400)).toThrow('overflow');
  });
});

describe('strict raw Codex output', () => {
  it('accepts the complete unmodified fixture and keeps probabilities unchanged', () => {
    const original = model(); original.scenarios[0].probability_24h += 5e-9;
    const output = validateModelOutput(original, anchor);
    expect(output).toEqual(original);
    expect(output.scenarios[0].probability_24h).toBe(0.500000005);
  });
  const changes: [string, (output: ReturnType<typeof model>) => void][] = [
    ['probability sum', output => { output.scenarios[0].probability_24h += 2e-8; }],
    ['negative probability', output => { output.scenarios[0].probability_24h = -0.1; }],
    ['probability above one', output => { output.scenarios[0].probability_24h = 1.1; }],
    ['NaN probability', output => { output.scenarios[0].probability_24h = NaN; }],
    ['duplicate category', output => { output.scenarios[0].id = output.scenarios[1].id; }],
    ['missing scenario', output => { output.scenarios.pop(); }],
    ['incorrect representative', output => { output.scenarios[0].prices = path(); }],
    ['missing node', output => { output.scenarios[0].prices.pop(); }],
    ['node object', output => { (output.scenarios[0].prices as unknown[])[0] = { time: anchor.anchor_time, price: 101 }; }],
    ['millisecond time', output => { output.anchor_time *= 1000; }],
    ['unaligned seconds', output => { output.anchor_time++; }],
    ['different anchor time', output => { output.anchor_time += 900; }],
    ['different anchor price', output => { output.anchor_price += 0.00001; }],
    ['stage ordering', output => { output.stages.reverse(); }],
    ['stage gap', output => { output.stages[1].start_step++; }],
    ['stage bounds', output => { output.stages[0].lower = 103; }],
    ['missing stage', output => { output.stages.pop(); }],
    ['empty support', output => { output.scenarios[0].support = []; }],
    ['blank text', output => { output.summary = '   '; }],
    ['version', output => { output.schema_version = 'm2'; }],
  ];
  it.each(changes)('rejects %s', (_, change) => {
    const output = model(); change(output);
    expect(() => validateModelOutput(output, anchor)).toThrow();
  });
  it.each(['root', 'scenario', 'stage'])('rejects unknown or model-generated time fields at %s', location => {
    const output = model();
    const object = location === 'root' ? output : location === 'scenario' ? output.scenarios[0] : output.stages[0];
    Object.assign(object, { published_at: '2026-01-01T00:00:00Z' });
    expect(() => validateModelOutput(output, anchor)).toThrow();
  });
  it('publishes a serializable strict JSON schema, with no generated-time field', () => {
    const schema = JSON.parse(JSON.stringify(rawOutputJsonSchema));
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required.sort()).toEqual(Object.keys(model()).sort());
    expect(schema.properties.scenarios.items.additionalProperties).toBe(false);
    expect(schema.properties.stages.items.additionalProperties).toBe(false);
  });
});

describe('program-owned node and publication times', () => {
  it('constructs 96 strictly ascending second timestamps without model timestamps', () => {
    const nodes = buildPathNodes(path(), anchor.anchor_time);
    expect(nodes).toHaveLength(96);
    expect(nodes[0].time).toBe(anchor.anchor_time + 900);
    expect(nodes.at(-1)!.time).toBe(anchor.anchor_time + 86400);
    expect(nodes.every((node, index) => node.time === anchor.anchor_time + (index + 1) * 900)).toBe(true);
  });
  it('accepts publication at the anchor and before the first node, but equality is late', () => {
    const at = (seconds: number) => new Date(seconds * 1000).toISOString();
    expect(classifyPublication(anchor.anchor_time, at(anchor.anchor_time))).toBe('valid');
    expect(classifyPublication(anchor.anchor_time, at(anchor.anchor_time + 899.999))).toBe('valid');
    expect(classifyPublication(anchor.anchor_time, at(anchor.anchor_time + 900))).toBe('late');
    expect(classifyPublication(anchor.anchor_time, at(anchor.anchor_time + 86400))).toBe('late');
    expect(() => classifyPublication(anchor.anchor_time, at(anchor.anchor_time - 0.001))).toThrow('precedes');
  });
  it('rejects malformed or millisecond anchor inputs', () => {
    expect(() => classifyPublication(anchor.anchor_time, '2026-02-30T00:00:00Z')).toThrow();
    expect(() => classifyPublication(anchor.anchor_time, '2026-01-01')).toThrow();
    expect(() => buildPathNodes(path(), anchor.anchor_time * 1000)).toThrow();
  });
});

function candles(count = 97): Candle[] {
  return Array.from({ length: count }, (_, index) => ({
    open_time: anchor.anchor_time - (count - index) * 900,
    close_time: anchor.anchor_time - (count - index - 1) * 900,
    open: 100, high: 101, low: 99, close: 100,
    volume_contracts: 10, volume_base: 2, volume_quote: 200, closed: true,
  }));
}
describe('auditable features without missing-data fabrication', () => {
  it('calculates constant-close volatility, exact quote volume and horizon boundaries', () => {
    const output = extractFeatures(candles());
    expect(output.windows.h24).toMatchObject({ status: 'available', start_time: anchor.anchor_time - 86400,
      end_time: anchor.anchor_time, return_fraction: 0, close_to_close_realized_volatility: 0,
      range_fraction: 0.02, quote_volume: 96 * 200 });
    expect(output.windows.h6).toMatchObject({ status: 'available', quote_volume: 24 * 200 });
    expect(output.open_interest.status).toBe('unknown');
    expect(output.funding.status).toBe('unknown');
    expect(output.utc.close_minute).toBe(0);
  });
  it('uses close-to-close log returns including the prior horizon close', () => {
    const input = candles(25); input[24].close = 101;
    const window = extractFeatures(input).windows.h6;
    expect(window.status).toBe('available');
    if (window.status !== 'available') throw Error('Expected available window');
    expect(window.return_fraction).toBeCloseTo(0.01, 12);
    expect(window.close_to_close_realized_volatility).toBeCloseTo(Math.log(1.01), 12);
  });
  it('marks insufficient history unknown instead of inventing a zero return', () => {
    expect(extractFeatures(candles(24)).windows.h6).toEqual({ status: 'unknown', reason: 'insufficient_history', required_candles: 25, available_candles: 24 });
    expect(extractFeatures(candles(25)).windows.h12.status).toBe('unknown');
  });
  it.each(['gap', 'order', 'ohlc', 'open', 'unclosed', 'quote', 'milliseconds'])('rejects bad input %s', problem => {
    const input = candles();
    if (problem === 'gap') input.splice(10, 1);
    if (problem === 'order') input.reverse();
    if (problem === 'ohlc') input[10].low = 102;
    if (problem === 'open') input[10].open_time++;
    if (problem === 'unclosed') Object.assign(input[10], { closed: false });
    if (problem === 'quote') input[10].volume_quote = -1;
    if (problem === 'milliseconds') input[10].close_time *= 1000;
    expect(() => extractFeatures(input)).toThrow();
  });
});
