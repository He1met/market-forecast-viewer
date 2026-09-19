import { describe, it, expect } from 'vitest';
import { CATEGORY_IDS } from '../src/m1-contracts';
import type { RuntimeDisplay } from '../src/m1-display';
import { probabilityStyle, rankProbabilities, topProbabilityIds, formatProbability, displayTime, runtimeHeadline } from '../src/forecast-presentation';
const probabilities=(values:number[])=>CATEGORY_IDS.map((id,index)=>({id,probability_24h:values[index]}));
describe('honest forecast presentation',()=>{
 it('uses absolute probability weight and includes all ties at third place without mutating inputs',()=>{
  const source=probabilities([.25,.20,.15,.15,.15,.10]),before=structuredClone(source);
  expect([...topProbabilityIds(source)]).toHaveLength(5);
  expect(rankProbabilities([...source].reverse())).toEqual(source);
  expect(source).toEqual(before);
  expect(probabilityStyle('uptrend',.25).width).toBe(2);
  expect(probabilityStyle('uptrend',.25).opacity).toBeLessThan(probabilityStyle('uptrend',1).opacity);
  for(const s of source){const normal=probabilityStyle(s.id,s.probability_24h),dim=probabilityStyle(s.id,s.probability_24h,true);expect(dim.width).toBe(normal.width);expect(dim.opacity).toBeGreaterThan(.45);}
  expect(probabilityStyle('uptrend',.15).width).toBe(probabilityStyle('downtrend',.15).width);
  expect(probabilityStyle('uptrend',.15).opacity).toBe(probabilityStyle('downtrend',.15).opacity);
  expect(probabilityStyle('narrow',0).width).toBe(1);
  expect(topProbabilityIds(probabilities(Array(6).fill(1/6))).size).toBe(6);
  expect(formatProbability(.12345678)).toBe('12.345678%');
 });
 it('formats one instant in the selected timezone without changing the source',()=>{
  const at='2026-09-19T17:52:04.162Z';expect(displayTime(at)).toBe('2026/09/20 01:52');expect(displayTime(at,'UTC')).toBe('2026/09/19 17:52');expect(displayTime(null)).toBe('未知');
 });
 it('never promotes old completion to current healthy operation',()=>{
  const runtime:RuntimeDisplay={schema:'MFV:M1_RUNTIME_DISPLAY:v1',checked_at:'2026-09-20T00:00:00.000Z',configuration:null,release_integrity:'verified',paused:false,latest_attempt:null,last_success:null};
  expect(runtimeHeadline(runtime)).toContain('待核验');
  runtime.inspection={paused:false,freshness:'fresh',last_observed_at:runtime.checked_at,result:'ok'};
  runtime.publication_health={basis:'local_schedule',checked_at:runtime.checked_at,expected_since:runtime.checked_at,status:'current',slots:[]};
  expect(runtimeHeadline(runtime)).toBe('最近时段产出正常 · 巡检已更新');
  runtime.inspection.freshness='stale';expect(runtimeHeadline(runtime)).toContain('陈旧');
  runtime.publication_health.status='stalled';expect(runtimeHeadline(runtime)).toContain('更新停滞');
  runtime.paused=true;expect(runtimeHeadline(runtime)).toBe('本地暂停标记生效');
  runtime.paused=false;runtime.release_integrity='unknown';expect(runtimeHeadline(runtime)).toContain('待核验');
 });
});
