// Historical closure is a present-day reviewed disposition, not a rewritten
// generation receipt or proof of retry exhaustion. Source snapshots are data.
import fs from 'node:fs/promises';
import path from 'node:path';
import {parseStrict,canonical} from '../src/contracts.ts';
import {runIdSchema} from '../src/m1-display.ts';
import {check,digest,readBytes,safePath,exists} from './m1-files.mjs';

export const legacyParser = 'bb44213ec2ceb3e4b0666ef59963f7b23f02283db1fc19b4c1304a25f5e181ef';
export const closureImplementationFiles = ['scripts/m1-closures.mjs','scripts/m1-display.mjs','scripts/m1-ops.mjs',
 'scripts/m1-backup.mjs','scripts/m1-compatibility.mjs','scripts/m1-restore-replay.mjs'];
const sha = x => typeof x==='string' && /^[a-f0-9]{64}$/.test(x);
const iso = x => typeof x==='string' && /^\d{4}-\d\d-\d\dT.*Z$/.test(x) && Number.isFinite(Date.parse(x));
const exact = (x,names) => x && typeof x==='object' && !Array.isArray(x) && canonical(Object.keys(x).sort())===canonical([...names].sort());
const json = async(root,file) => parseStrict((await readBytes(root,file)).toString('utf8'));
const owner = x => x?.user?.id===65616876 && x.user.login==='He1met';

export async function listClosureIds(dataRoot) {
 const root=path.join(dataRoot,'m1-closures');if(!await exists(root))return [];
 await safePath(dataRoot,root);const ids=await fs.readdir(root);
 for(const id of ids){runIdSchema.parse(id);const file=path.join(root,id);await safePath(dataRoot,file);check((await fs.stat(file)).isDirectory(),'CLOSURE_FILE_TYPE');}
 return ids.sort();
}

/** Include directories (including empty ones), reject links and special files. */
export async function closureInventory(root) {
 const items=[];await safePath(root,root);
 async function visit(dir,rel='') {
  for(const entry of (await fs.readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name,'en'))) {
   const name=rel+entry.name,file=path.join(dir,entry.name);await safePath(root,file);
   check(!entry.isSymbolicLink(),'CLOSURE_SYMLINK');
   if(entry.isDirectory()){items.push({path:name,kind:'directory'});await visit(file,name+'/');}
   else {check(entry.isFile(),'CLOSURE_FILE_TYPE');const b=await readBytes(root,file);items.push({path:name,kind:'file',bytes:b.length,sha256:digest(b)});}
  }
 }
 await visit(root);return items;
}

// This narrowly supported parser predates the startup-warning exemption. Do not
// import/execute preserved historical source or trust receipt audit summaries.
function rejectedLegacyAttempt(events,receipt) {
 const known=['thread.started','turn.started','turn.completed','turn.failed','error','item.started','item.updated','item.completed'];
 const unexpected=events.filter(e=>!e||typeof e!=='object'||!known.includes(e.type)||
  (e.type.startsWith('item.')&&(!e.item||!['agent_message','reasoning'].includes(e.item.type))));
 const notice=unexpected[0],noticeIndex=events.indexOf(notice),turn=events.findIndex(e=>e.type==='turn.started');
 const prefix='Under-development features enabled: chronicle. Under-development features are incomplete and may behave unpredictably. To suppress this warning, set `suppress_unstable_features_warning = true` in ';
 check(unexpected.length===1 && notice?.type==='item.completed' && notice.item?.type==='error' &&
  typeof notice.item.message==='string' && notice.item.message.startsWith(prefix) &&
  /^\/[^\r\n]+\/config\.toml\.$/.test(notice.item.message.slice(prefix.length)) && noticeIndex<turn,
  'CLOSURE_REJECTION_UNPROVEN');
 check(events.filter(e=>e.type==='thread.started').length===1 && events[0]?.thread_id===receipt.model_thread_id &&
  events.filter(e=>e.type==='turn.started').length===1 && events.filter(e=>e.type==='turn.completed').length===1 &&
  events.at(-1)?.type==='turn.completed' && !events.some(e=>['turn.failed','error'].includes(e.type)), 'CLOSURE_TURN_INCOMPLETE');
 const messages=events.filter(e=>e.type==='item.completed'&&e.item?.type==='agent_message');
 check(messages.length===1,'CLOSURE_OUTPUT_UNPROVEN');return parseStrict(messages[0].item.text);
}

/** Caller has already validated frozen input, history and absence of success
 * traces. Candidate validation uses an explicit isolated recordRoot; normal
 * scoring always uses dataRoot/m1-closures/run_id. No network or mutations. */
export async function readLegacyClosure({codeRoot,dataRoot,runId,runsRoot,frozen,recordRoot}) {
 runIdSchema.parse(runId);
 const standard=path.join(dataRoot,'m1-closures',runId),folder=recordRoot??standard;
 if(!recordRoot && !await exists(standard))return null;
 check(path.resolve(runsRoot)===path.join(path.resolve(dataRoot),'forecast-runs'),'CLOSURE_ROLE_UNSUPPORTED');
 const container=recordRoot?path.dirname(folder):dataRoot;
 await safePath(container,folder);
 check(canonical((await fs.readdir(folder)).sort())===canonical(['historical-report.json','planning-issue.json','review.json','statement.json']), 'CLOSURE_FILE_SET');
 const statementBytes=await readBytes(container,path.join(folder,'statement.json')),s=parseStrict(statementBytes.toString('utf8'));
 check(exact(s,['schema','run_id','role','proposed_at','manifest_sha256','parser_sha256','original_inventory','historical_report','planning_issue']) &&
  s.schema==='MFV:LEGACY_CLOSURE:v1'&&s.run_id===runId&&s.role==='production'&&iso(s.proposed_at)&&
  s.parser_sha256===legacyParser&&frozen.provenance.code_sha256?.['scripts/m1-forecast.mjs']===legacyParser,
  'CLOSURE_STATEMENT_INVALID');
 const directory=path.join(runsRoot,runId),inventory=await closureInventory(directory);
 check(canonical(s.original_inventory)===canonical(inventory),'CLOSURE_ARCHIVE_CHANGED');
 check(s.manifest_sha256===digest(await readBytes(dataRoot,path.join(directory,'manifest.json'))),'CLOSURE_MANIFEST_MISMATCH');
 // Exact legacy shape: never extend this exception to an open/second attempt,
 // validation failure, invocation from another parser, or publication remnant.
 const names=inventory.map(x=>x.path);
 check(names.filter(x=>/^attempt-[^/]+$/.test(x)).join(',')==='attempt-001' &&
  canonical(names.filter(x=>x.startsWith('attempt-001/')).sort())===canonical(['events.jsonl','raw-output.json','receipt.json','started.json','stderr.log'].map(x=>'attempt-001/'+x).sort()) &&
  !names.some(x=>x.startsWith('publication')||x.startsWith('.publication-')||x==='preparation-failure.json'), 'CLOSURE_ATTEMPT_SHAPE');
 const startBytes=await readBytes(dataRoot,path.join(directory,'attempt-001/started.json')),start=parseStrict(startBytes.toString('utf8'));
 const receipt=await json(dataRoot,path.join(directory,'attempt-001/receipt.json'));
 check(start.schema==='MFV:M1_ATTEMPT_START:v1'&&start.run_id===runId&&start.attempt_id==='attempt-001'&&
  start.input_sha256===frozen.manifest.files['input.json']&&start.frozen_manifest_sha256===s.manifest_sha256,
  'CLOSURE_START_MISMATCH');
 check(receipt.schema==='MFV:M1_ATTEMPT_RESULT:v1'&&receipt.run_id===runId&&receipt.attempt_id==='attempt-001'&&
  receipt.started_sha256===digest(startBytes)&&receipt.started_at===start.started_at&&iso(start.started_at)&&iso(receipt.ended_at)&&
  Date.parse(start.started_at)>=Date.parse(frozen.manifest.information_frozen_at)&&Date.parse(receipt.ended_at)>=Date.parse(start.started_at)&&
  Date.parse(s.proposed_at)>=Date.parse(receipt.ended_at)&&receipt.exit_code===-1&&receipt.error==='CODEX_EVENT_REJECTED'&&
  receipt.cli_exit_code===0&&receipt.signal===null&&receipt.timed_out===false&&receipt.turn_completed===true&&
  receipt.unexpected_tool_events===1&&receipt.event_audit===undefined&&receipt.model_identity===null&&
  receipt.model_config?.cli_version==='codex-cli 0.154.0-alpha.6.2'&&receipt.execution_mode==='official_codex_exec_frozen_stdin', 'CLOSURE_RECEIPT_MISMATCH');
 const raw=await readBytes(dataRoot,path.join(directory,'attempt-001/raw-output.json'));
 check(sha(receipt.raw_output_sha256)&&digest(raw)===receipt.raw_output_sha256,'CLOSURE_RAW_MISMATCH');
 const stream=await readBytes(dataRoot,path.join(directory,'attempt-001/events.jsonl'));
 const events=stream.toString('utf8').trim().split('\n').map(line=>parseStrict(line));
 check(canonical(rejectedLegacyAttempt(events,receipt))===canonical(parseStrict(raw.toString('utf8'))),'CLOSURE_OUTPUT_MISMATCH');
 for(const [field,name,kind]of [['historical_report','historical-report.json','comment'],['planning_issue','planning-issue.json','issue']]) {
  const ref=s[field],b=await readBytes(container,path.join(folder,name)),source=parseStrict(b.toString('utf8'));
  check(exact(ref,['url','snapshot_sha256','body_sha256'])&&sha(ref.snapshot_sha256)&&sha(ref.body_sha256)&&digest(b)===ref.snapshot_sha256&&
   typeof source.body==='string'&&digest(source.body)===ref.body_sha256&&source.html_url===ref.url&&owner(source)&&
   Number.isSafeInteger(source.id)&&iso(source.created_at)&&iso(source.updated_at)&&Date.parse(source.updated_at)<=Date.parse(s.proposed_at), 'CLOSURE_SOURCE_MISMATCH');
  check(kind==='comment'?new RegExp('^https://github.com/He1met/market-forecast-viewer/pull/[1-9][0-9]*#issuecomment-'+source.id+'$').test(ref.url):
   Number.isSafeInteger(source.number)&&ref.url===`https://github.com/He1met/market-forecast-viewer/issues/${source.number}`&&!source.pull_request,
   'CLOSURE_SOURCE_IDENTITY');
 }
 const review=await json(container,path.join(folder,'review.json'));
 check(owner(review)&&['COMMENTED','APPROVED'].includes(review.state)&&Number.isSafeInteger(review.id)&&
  /^[a-f0-9]{40}$/.test(review.commit_id??'')&&iso(review.submitted_at)&&Date.parse(review.submitted_at)>=Date.parse(s.proposed_at)&&Date.parse(review.submitted_at)<=Date.now()&&
  new RegExp('^https://github.com/He1met/market-forecast-viewer/pull/[1-9][0-9]*#pullrequestreview-'+review.id+'$').test(review.html_url??''), 'CLOSURE_REVIEW_IDENTITY');
 const blocks=typeof review.body==='string'?[...review.body.matchAll(/```mfv-closure-review\n([\s\S]*?)\n```/g)]:[];
 check(blocks.length===1,'CLOSURE_REVIEW_REQUIRED');const decision=parseStrict(blocks[0][1]);
 check(exact(decision,['schema','decision','statement_sha256','reviewed_commit','implementation_files'])&&decision.schema==='MFV:CLOSURE_REVIEW:v1'&&
  decision.decision==='historical_unpublished_closure_approved'&&decision.statement_sha256===digest(statementBytes)&&
  decision.reviewed_commit===review.commit_id&&exact(decision.implementation_files,closureImplementationFiles),'CLOSURE_REVIEW_MISMATCH');
 for(const file of closureImplementationFiles)check(sha(decision.implementation_files[file])&&digest(await readBytes(codeRoot,path.join(codeRoot,file)))===decision.implementation_files[file], 'CLOSURE_REVIEWED_CODE_CHANGED');
 return {status:'historical_unpublished_closed_not_scoreable',statement_sha256:digest(statementBytes),review_url:review.html_url};
}
