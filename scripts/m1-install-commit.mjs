import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {atomic,writeOnce,readBytes,readJson,exists,check,encode,digest,assertInstallationSettled} from './m1-files.mjs';
const names=['launch.mjs','installation.local.json','current.json'];
const pendingFile=home=>path.join(home,'installation-pending.json');
export async function readInstallationTransaction(runtimeHome,id) {
 check(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id??''),'INSTALL_TRANSACTION_ID_INVALID');
 const pending=await readJson(runtimeHome,pendingFile(runtimeHome));check(pending.id===id,'INSTALL_PENDING_ID_MISMATCH');
 const dir=path.join(runtimeHome,'installation-changes',id),bytes=await readBytes(runtimeHome,path.join(dir,'intent.json'));
 check(digest(bytes)===pending.intent_sha256,'INSTALL_INTENT_CHANGED');const intent=JSON.parse(bytes);
 check(intent.schema==='MFV:INSTALL_COMMIT:v2'&&intent.id===id&&intent.runtime_home===runtimeHome&&intent.files.map(x=>x.name).join(',')===names.join(','),'INSTALL_INTENT_INVALID');
 const entries=intent.files.map(x=>{const before=x.before===null?null:Buffer.from(x.before,'base64'),after=Buffer.from(x.after,'base64');check((before===null||before.toString('base64')===x.before)&&after.toString('base64')===x.after&&digest(after)===x.after_sha256,'INSTALL_INTENT_BYTES_INVALID');return{...x,before,after};});
 return {id,dir,intent,entries,pending};
}
async function knownState(home,entries) {
 for(const item of entries){const file=path.join(home,item.name),now=await exists(file)?await readBytes(home,file):null;check(now===null?item.before===null:now.equals(item.after)||Boolean(item.before&&now.equals(item.before)),'INSTALL_CHANGED_DURING_COMMIT');}
}
async function exactState(home,entries,side) {
 for(const item of entries){const file=path.join(home,item.name),wanted=item[side],now=await exists(file)?await readBytes(home,file):null;check(wanted===null?now===null:Boolean(now&&now.equals(wanted)),'INSTALL_READBACK_MISMATCH');}
}
async function clearPending(home,transaction,guard) {
 await guard();const current=await readJson(home,pendingFile(home));check(JSON.stringify(current)===JSON.stringify(transaction.pending),'INSTALL_PENDING_CHANGED');await fs.unlink(pendingFile(home));
}
// The supplied gates run under the caller's normal business mutex. Repeating this
// operation after a crash is safe: each file may contain only its before/after image.
export async function recoverInstallationFiles({runtimeHome,id,guard,verifyTarget}) {
 const tx=await readInstallationTransaction(runtimeHome,id);
 const committed=await exists(path.join(tx.dir,'result.json'));
 await guard();await knownState(runtimeHome,tx.entries);
 await verifyTarget({transaction:tx,side:committed?'after':'before'});
 if(committed){
  check((await readJson(runtimeHome,path.join(tx.dir,'result.json'))).status==='committed','INSTALL_RESULT_INVALID');
  await exactState(runtimeHome,tx.entries,'after');await clearPending(runtimeHome,tx,guard);return {status:'committed',id};
 }
 await atomic(runtimeHome,path.join(tx.dir,'recovery-state.json'),{status:'restoring',at:new Date().toISOString()});
 for(const item of tx.entries){await guard();await knownState(runtimeHome,tx.entries);const file=path.join(runtimeHome,item.name);if(item.before===null){if(await exists(file))await fs.unlink(file);}else await atomic(runtimeHome,file,item.before);}
 await exactState(runtimeHome,tx.entries,'before');
 await guard();
 await atomic(runtimeHome,path.join(tx.dir,'recovery-state.json'),{status:'restored_before_images',at:new Date().toISOString()});
 await clearPending(runtimeHome,tx,guard);return {status:'restored_before_images',id};
}
export async function commitInstallation({runtimeHome,files,guard,rollbackGuard}) {
 await assertInstallationSettled(runtimeHome);const id=randomUUID(),dir=path.join(runtimeHome,'installation-changes',id),entries=[];
 check(Object.keys(files).join(',')===names.join(','),'INSTALL_COMMIT_ORDER');
 for(const [name,value] of Object.entries(files)){
  const file=path.join(runtimeHome,name),before=await exists(file)?await readBytes(runtimeHome,file):null;
  const after=Buffer.isBuffer(value)?value:Buffer.from(typeof value==='string'?value:encode(value));entries.push({name,before,after});
 }
 const intent={schema:'MFV:INSTALL_COMMIT:v2',id,runtime_home:runtimeHome,at:new Date().toISOString(),files:entries.map(x=>({name:x.name,before:x.before?.toString('base64')??null,after:x.after.toString('base64'),after_sha256:digest(x.after)}))};
 await writeOnce(runtimeHome,path.join(dir,'intent.json'),intent);
 const pending={id,intent_sha256:digest(encode(intent))};await guard();await writeOnce(runtimeHome,pendingFile(runtimeHome),pending);
 try {
  for(const item of entries){await guard();await knownState(runtimeHome,entries);await atomic(runtimeHome,path.join(runtimeHome,item.name),item.after);}
  await exactState(runtimeHome,entries,'after');await guard();await writeOnce(runtimeHome,path.join(dir,'result.json'),{status:'committed',at:new Date().toISOString()});
  await clearPending(runtimeHome,{pending},guard);return {status:'committed',id};
 } catch(error) {
  try {await recoverInstallationFiles({runtimeHome,id,guard,verifyTarget:rollbackGuard});}
  catch(recoveryError){await atomic(runtimeHome,path.join(dir,'recovery-failed.json'),{status:'requires_recovery',at:new Date().toISOString(),error:error.message,recovery_error:recoveryError.message});throw Error('INSTALL_COMMIT_RECOVERY_REQUIRED:'+id,{cause:recoveryError});}
  throw error;
 }
}
