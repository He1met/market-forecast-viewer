import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {alertStore} from '../scripts/m1-alerts.mjs';
import {notificationSummary} from '../scripts/m1-notifications.mjs';
const guard=async()=>{},at='2026-09-15T00:00:00Z';
async function fixture(t){const root=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'mfv-notify-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));return root;}
async function fault(root,stream,id='1'){return alertStore(root,{stream}).observe({task:'ops',observationId:id,at,condition:{code:'STORAGE_UNWRITABLE',object:'inspection',severity:'critical'},guard});}
test('three streams remain pending after repeat summary; bounded events and stable identity, no private fields',async t=>{
 const root=await fixture(t);for(const stream of ['default','execution','capacity'])await fault(root,stream);
 const file=path.join(root,'m1-control/alerts.json'),state=JSON.parse(await fs.readFile(file));state.events[0].raw='/private/SYNTHETIC_SECRET';state.events[0].delivery.receipt={id:'SECRET'};await fs.writeFile(file,JSON.stringify(state));const before=await fs.readFile(file);
 const first=await notificationSummary(root,{limit:2}),again=await notificationSummary(root);
 assert.equal(first.pending_count,3);assert.equal(first.events.length,2);assert.equal(first.omitted_count,1);assert.equal(first.event_set_id,again.event_set_id);assert.equal(first.delivery,'pending');assert.equal(first.transport,'not_configured');assert.equal(JSON.stringify(again).includes('SECRET'),false);assert.deepEqual(await fs.readFile(file),before);
 const pending=await alertStore(root).pending();await alertStore(root).acknowledge({eventId:pending[0].id,receipt:{channel:'official-task',id:'SYNTHETIC',delivered_at:at},guard});
 const changed=await notificationSummary(root);assert.equal(changed.pending_count,2);assert.notEqual(changed.event_set_id,again.event_set_id);
});
test('empty read creates no state; recovery stays historical; recorded success does not imply inspected health',async t=>{
 const root=await fixture(t);assert.equal((await notificationSummary(root)).delivery,'none');assert.deepEqual(await fs.readdir(root),[]);
 await fault(root,'default');await alertStore(root).observe({task:'ops',observationId:'recovered',at:'2026-09-15T01:00:00Z',condition:null,guard});
 const dir=path.join(root,'m1-task-status');await fs.mkdir(dir);const file=path.join(dir,'last-forecast-success.json');await fs.writeFile(file,JSON.stringify({status:'completed',completed_at:at,raw:'SECRET'}));
 const summary=await notificationSummary(root);assert.deepEqual(summary.events.map(x=>x.kind),['fault','recovery']);assert.equal(summary.last_publication.status,'recorded');assert.equal(summary.last_publication.source,'recorded_summary');assert.equal(JSON.stringify(summary).includes('SECRET'),false);
 await fs.writeFile(file,'{');assert.equal((await notificationSummary(root)).last_publication.status,'unreadable');assert.equal((await notificationSummary(root)).pending_count,2);
});
test('invalid or unsafe pending state fails closed, never empty or raw error export',async t=>{
 const root=await fixture(t);await fault(root,'execution');const file=path.join(root,'m1-control/execution-alerts.json'),state=JSON.parse(await fs.readFile(file));state.events[0].object='/private/SECRET';await fs.writeFile(file,JSON.stringify(state));
 await assert.rejects(()=>notificationSummary(root),/NOTIFICATION_EVENT_INVALID/);await assert.rejects(()=>notificationSummary(root,{limit:101}),/LIMIT_INVALID/);
 await fs.writeFile(file,'{}');await assert.rejects(()=>notificationSummary(root),/ALERT_STATE_INVALID/);
});
