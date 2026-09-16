import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {backupCycle} from '../scripts/m1-backup-cycle.mjs';
import {businessMutex} from '../scripts/m1-mutex.mjs';
import {collectExecutionObservations} from '../scripts/m1-observation-alerts.mjs';
async function setup(t){
 const root=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'mfv-backup-cycle-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const data=path.join(root,'data'),target=path.join(root,'target');await fs.mkdir(path.join(data,'data-source'),{recursive:true});await fs.mkdir(target);await fs.writeFile(path.join(data,'data-source/a'),'SYNTHETIC ORIGINAL');
 const server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));
 const options={codeRoot:root,config:{data_root:data,mutex_port:port,backup:{target}},releaseId:'SYNTHETIC',trigger:'scheduled',taskId:'synthetic-task',threadId:'synthetic-thread',clock:()=>Date.parse('2026-09-20T00:00:00Z'),verify:async dest=>({passed:(await fs.readFile(path.join(dest,'data-source/a'),'utf8'))==='SYNTHETIC ORIGINAL'})};
 const read=name=>fs.readFile(path.join(data,name),'utf8').then(JSON.parse);return{options,data,target,read,port};
}
test('backup invocation preserves identity and incomplete restore resumes without false success',async t=>{
 const {options,data,target,read}=await setup(t);
 const partial=await backupCycle({...options,restoreMaxFiles:1});assert.equal(partial.status,'partial');assert.equal(partial.reason,'RESTORE_CHECK_INCOMPLETE');assert.equal(partial.trigger,'scheduled');assert.equal(partial.task_id,'synthetic-task');assert.equal(partial.thread_id,'synthetic-thread');
 assert.equal((await read('m1-task-status/backup.json')).status,'partial');await assert.rejects(read('m1-task-status/last-backup-success.json'),/ENOENT/);
 assert.equal((await read(`m1-observations/${partial.id}/result.json`)).status,'partial');
 const complete=await backupCycle(options);assert.equal(complete.status,'completed');assert.equal(complete.already_completed,true);assert.equal(complete.restore_check.schema,'MFV:RESTORE:v1');assert.equal((await read('m1-task-status/last-backup-success.json')).id,complete.id);await assert.rejects(fs.stat(path.join(target,'restore-checks/pending.json')),/ENOENT/);
 const success=await fs.readFile(path.join(data,'m1-task-status/last-backup-success.json'),'utf8');
 const failed=await backupCycle({...options,config:{...options.config,backup:{target:path.join(target,'missing')}}});assert.equal(failed.status,'failed');assert.match(failed.reason,/ENOENT/);assert.equal((await read('m1-task-status/backup.json')).status,'failed');assert.equal(await fs.readFile(path.join(data,'m1-task-status/last-backup-success.json'),'utf8'),success);
});
test('busy invocation records independent failure without shared writes and is collected later',async t=>{
 const {options,data,read,port}=await setup(t);
 const owner=await businessMutex({dataRoot:data,port,releaseId:'SYNTHETIC',task:'synthetic-owner'});assert.equal(owner.status,'ACQUIRED');
 let result;try{result=await backupCycle(options);assert.equal(result.status,'skipped');assert.match(result.reason,/BUSY/);assert.match(result.summary_status,/BUSY/);await assert.rejects(read('m1-task-status/backup.json'),/ENOENT/);assert.equal((await read(`m1-observations/${result.id}/result.json`)).task,'backup');}finally{await owner.close();}
 const collector=await businessMutex({dataRoot:data,port,releaseId:'SYNTHETIC',task:'ops'});try{const collected=await collectExecutionObservations({dataRoot:data,guard:collector.guard,now:Date.parse('2026-09-21T00:00:00Z')});assert.equal(collected.status,'completed');assert.equal(collected.consumed,1);}finally{await collector.close();}
});
test('restore replay failure stays failed and manual unknown scheduler identity is honest',async t=>{
 const {options,read}=await setup(t);const result=await backupCycle({...options,trigger:'manual',taskId:null,threadId:null,verify:async()=>({passed:false})});assert.equal(result.status,'failed');assert.equal(result.backup_status,'completed');assert.match(result.reason,/RESTORE_REPLAY_FAILED/);assert.equal(result.task_id,null);assert.equal(result.thread_id,null);await assert.rejects(read('m1-task-status/last-backup-success.json'),/ENOENT/);
});
