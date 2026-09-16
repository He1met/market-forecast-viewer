import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {cycle} from '../scripts/m1-cycle.mjs';
import {ops} from '../scripts/m1-ops.mjs';
for(const [task,run] of [['forecast',cycle],['ops',ops]])test(task+' records actual invocation identity even paused and rejects invented trigger',async t=>{
 const root=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'mfv-identity-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const options={dataRoot:root,releaseId:'SYNTHETIC',paused:true,trigger:'scheduled',taskId:'synthetic-task',threadId:'synthetic-thread'};
 await run(options);let ids=await fs.readdir(path.join(root,'m1-observations'));assert.equal(ids.length,1);
 for(const name of ['started','result']){const record=JSON.parse(await fs.readFile(path.join(root,'m1-observations',ids[0],name+'.json')));assert.equal(record.task,task);assert.equal(record.trigger,'scheduled');assert.equal(record.task_id,'synthetic-task');assert.equal(record.thread_id,'synthetic-thread');assert.equal(record.status,name==='started'?'started':'skipped');}
 await assert.rejects(run({...options,trigger:'automatic'}),/TRIGGER_INVALID/);await assert.rejects(run({...options,taskId:123}),/INVOCATION_ID_INVALID/);
 assert.equal((await fs.readdir(path.join(root,'m1-observations'))).length,1);
 await run({dataRoot:root,releaseId:'SYNTHETIC',paused:true});const second=(await fs.readdir(path.join(root,'m1-observations'))).find(id=>id!==ids[0]);const unknown=JSON.parse(await fs.readFile(path.join(root,'m1-observations',second,'result.json')));assert.equal(unknown.trigger,'manual');assert.equal(unknown.task_id,null);assert.equal(unknown.thread_id,null);
});
