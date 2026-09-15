import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {runtimeDisplay} from '../scripts/m1-status.mjs';
import {runtimeDisplaySchema} from '../src/m1-display.ts';
import {alertStore} from '../scripts/m1-alerts.mjs';
const at='2026-09-15T08:00:00.000Z',now=Date.parse(at);
const forecast='m1-20260915T080000000Z-00000000-0000-4000-8000-000000000015';
async function fixture(t){const root=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'mfv-status-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));return root;}
async function save(root,name,value){const file=path.join(root,name);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,JSON.stringify(value));}
const parse=value=>runtimeDisplaySchema.parse(value);
test('installed empty status satisfies page contract without claiming an official schedule',async t=>{
 const root=await fixture(t),value=parse(await runtimeDisplay(root,{now}));
 assert.equal(value.source,'installed');assert.equal(value.configuration,null);assert.equal(value.release_integrity,'verified');assert.equal(value.inspection.freshness,'unknown');
 assert.deepEqual(await fs.readdir(root),[]);
 const {source,inspection,...legacy}=value;assert.equal(runtimeDisplaySchema.safeParse(legacy).success,false);
 assert.equal(runtimeDisplaySchema.safeParse({...legacy,release_integrity:'unconfigured'}).success,true);
});
test('installed publication time can precede cycle completion; later failure preserves publication',async t=>{
 const root=await fixture(t),success={id:'SYNTHETIC_CYCLE',forecast_id:forecast,completed_at:'2026-09-15T07:58:00.000Z'};
 const attempt={...success,trigger:'scheduled',status:'completed',started_at:'2026-09-15T07:57:00.000Z',completed_at:'2026-09-15T07:59:00.000Z'};
 await save(root,'m1-task-status/forecast.json',attempt);await save(root,'m1-task-status/last-forecast-success.json',success);
 const value=parse(await runtimeDisplay(root,{now,paused:false}));assert.equal(value.last_success.completed_at,success.completed_at);
 assert.equal(runtimeDisplaySchema.safeParse({...value,last_success:{...value.last_success,completed_at:'2026-09-15T07:56:00.000Z'}}).success,false);
 assert.equal(runtimeDisplaySchema.safeParse({...value,last_success:{...value.last_success,completed_at:'2026-09-15T07:59:30.000Z'}}).success,false);
 await save(root,'m1-task-status/forecast.json',{...attempt,id:'SYNTHETIC_FAILED',status:'failed',reason:'PRIVATE_PATH',forecast_id:null});
 const failed=parse(await runtimeDisplay(root,{now}));assert.deepEqual(failed.last_success,value.last_success);assert.equal(JSON.stringify(failed).includes('PRIVATE_PATH'),false);
});
test('90-minute observation boundary is read-only and independent of forecast or backup success',async t=>{
 const root=await fixture(t),guard=async()=>{};
 await alertStore(root).observe({task:'ops',observationId:'inspection',at,condition:null,guard});
 const before=await fs.readFile(path.join(root,'m1-control/alerts.json'));
 assert.equal(parse(await runtimeDisplay(root,{now:now+90*60000})).inspection.freshness,'fresh');
 const stale=parse(await runtimeDisplay(root,{now:now+90*60000+1,opsPaused:false}));assert.equal(stale.inspection.freshness,'stale');assert.equal(stale.inspection.result,'ok');
 await save(root,'m1-task-status/backup.json',{completed_at:new Date(now+90*60000).toISOString()});
 assert.deepEqual((await runtimeDisplay(root,{now:now+90*60000+1,opsPaused:false})).inspection,stale.inspection);
 assert.deepEqual(await fs.readFile(path.join(root,'m1-control/alerts.json')),before);
 assert.equal(parse(await runtimeDisplay(root,{now:now-1})).inspection.freshness,'clock_invalid');
 assert.equal(runtimeDisplaySchema.safeParse({...stale,inspection:{...stale.inspection,freshness:'fresh'}}).success,false);
});
test('fresh failed observation remains unhealthy and paused display does not manufacture recovery',async t=>{
 const root=await fixture(t);await alertStore(root).observe({task:'ops',observationId:'failed',at,condition:{code:'OPS_RESULTS_INCOMPLETE',object:'inspection',severity:'warning'},guard:async()=>{}});
 const active=parse(await runtimeDisplay(root,{now,opsPaused:false}));assert.equal(active.inspection.freshness,'fresh');assert.equal(active.inspection.result,'failed');
 const paused=parse(await runtimeDisplay(root,{now:now+91*60000,opsPaused:true}));assert.equal(paused.inspection.paused,true);assert.equal(paused.inspection.freshness,'stale');assert.equal(paused.inspection.result,'failed');
});
