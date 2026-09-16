import fs from'node:fs/promises';import path from'node:path';import{execFileSync,spawnSync}from'node:child_process';
import{readFrozen,assertFrozenCode,prepareAttempt,completeAttempt,publishRun,readPublished}from'./m1-archive.mjs';import{auditCodexEvents}from'./m1-forecast.mjs';import{managedProcess}from'./m1-mutex.mjs';import{writeOnce,check,digest}from'./m1-files.mjs';
export function modelArguments({workspace,schema,output,model='gpt-6-astra'}){
 return['exec','--ignore-user-config','--skip-git-repo-check','--ephemeral','--sandbox','read-only','--json','--color','never','-C',workspace,'-m',model,
 '-c','model_reasoning_effort="medium"','-c','model_provider="openai"','-c','forced_login_method="chatgpt"','-c','web_search="disabled"','-c','project_doc_max_bytes=0',
 ...['shell_tool','unified_exec','apps','plugins','computer_use','multi_agent','multi_agent_v2','hooks','chronicle','code_mode','code_mode_host','image_generation','view_image','remote_plugin','tool_suggest','artifact','sleep_tool'].flatMap(x=>['--disable',x]),
 '--output-schema',schema,'--output-last-message',output,'-'];
}
export async function generateInstalled(input,{mutex,timeoutMs,beforePublish}){
 const started=performance.now();
 const runDir=input.runDir,previous=await readPublished(runDir);if(previous)return previous;
 const frozen=await assertFrozenCode(runDir),attempt=await prepareAttempt(runDir),workspace=path.join(attempt.attemptDir,'model-work');await fs.mkdir(workspace);
 const cliVersion=execFileSync('codex',['--version'],{encoding:'utf8',timeout:5000}).trim();
 const help=execFileSync('codex',['exec','--help'],{encoding:'utf8',timeout:5000});for(const flag of ['--ignore-user-config','--skip-git-repo-check','--ephemeral'])check(help.includes(flag),'CLI_CAPABILITY_MISSING');
 const auth=spawnSync('codex',['login','status'],{encoding:'utf8',timeout:10000});check(auth.status===0&&/ChatGPT/i.test(String(auth.stdout)+String(auth.stderr))&&!/API key/i.test(String(auth.stdout)+String(auth.stderr)),'OFFICIAL_AUTH_REQUIRED');
 const args=modelArguments({workspace,schema:path.join(runDir,'output-schema.json'),output:attempt.rawFile});await writeOnce(attempt.attemptDir,path.join(attempt.attemptDir,'invocation.json'),{schema:'MFV:MODEL_INVOCATION:v1',args,cli_version:cliVersion,requested_model:'gpt-6-astra',requested_reasoning:'medium',actual_model:null,actual_reasoning:null,working_directory:workspace,provider:'official_codex',frozen_input_sha256:frozen.manifest.files['input.json']});
 const stdoutFile=path.join(attempt.attemptDir,'events.jsonl'),stderrFile=path.join(attempt.attemptDir,'stderr.log');
 const env={...process.env};for(const key of ['OPENAI_API_KEY','CODEX_API_KEY','OPENAI_BASE_URL'])delete env[key];
 const remaining=timeoutMs-(performance.now()-started);if(remaining<90000){await completeAttempt(runDir,attempt.attempt_id,{exit_code:-1,error:'MODEL_BUDGET_TOO_SHORT',execution_mode:'not_started_budget'});throw Error('MODEL_BUDGET_TOO_SHORT');}
 let result;try{result=await managedProcess('codex',args,{mutex,cwd:workspace,env,stdoutFile,stderrFile,timeoutMs:remaining,input:frozen.prompt,onStarted:execution=>recordExecutionStart(runDir,attempt,'managed_process',execution)});}catch(e){result={code:-1,timedOut:false,error:e.message};}
 const stream=await fs.readFile(stdoutFile,'utf8').catch(()=>''),audit=auditCodexEvents(stream,{kind:'installed_frozen_input',cli_version:cliVersion,args}),raw=await fs.stat(attempt.rawFile).catch(()=>null),valid=result.code===0&&!result.timedOut&&raw?.isFile()&&audit.turn_completed&&!audit.failed&&audit.unexpected_count===0;
 const eventAudit={schema:'MFV:CODEX_EVENT_AUDIT:v1',events_sha256:digest(stream),invocation_sha256:digest(await fs.readFile(path.join(attempt.attemptDir,'invocation.json'))),cli_version:cliVersion,controlled_disabled_context:audit.controlled_disabled_context,startup_notice_count:audit.startup_notice_count,startup_notices:audit.startup_notices,unexpected_event_count:audit.unexpected_count,unexpected_tool_count:audit.unexpected_tool_count,turn_completed:audit.turn_completed,failed:audit.failed};
 await completeAttempt(runDir,attempt.attempt_id,{exit_code:valid?0:-1,cli_exit_code:result.code,timed_out:result.timedOut,error:valid?null:result.error??'MODEL_ATTEMPT_REJECTED',event_audit:eventAudit,turn_completed:audit.turn_completed,model_config:{provider:'official_codex',selection:'existing_local_cli_configuration',cli_version:cliVersion,auth_method:'chatgpt_verified',sandbox:'read-only',output_schema:true,startup_warning_count:audit.startup_warning_count},model_identity:null,model_identity_visibility:'not_exposed_by_jsonl',model_thread_id:audit.events.find(x=>x?.type==='thread.started')?.thread_id??null,unexpected_tool_events:audit.unexpected_count});
 check(valid,'MODEL_ATTEMPT_REJECTED');await beforePublish();return publishRun(runDir,attempt.rawFile,{attempt_id:attempt.attempt_id});
}

export async function generateCandidate(input,options){
 if(!input.probabilityOnly)return generateInstalled(input,options);
 const source=await readPublished(input.sourceRun.runDir);check(source,'PROBABILITY_SOURCE_NOT_PUBLISHED');await assertFrozenCode(input.runDir);const attempt=await prepareAttempt(input.runDir);await options.mutex.guard();await recordExecutionStart(input.runDir,attempt,'deterministic_probability_postprocess');const raw=await fs.readFile(path.join(input.sourceRun.runDir,source.receipt.attempt_id,'raw-output.json'));await fs.writeFile(attempt.rawFile,raw,{flag:'wx',mode:0o600});await completeAttempt(input.runDir,attempt.attempt_id,{exit_code:0,model_config:source.receipt.model_config,model_identity:null,model_identity_visibility:'not_exposed_by_jsonl',execution_mode:'deterministic_probability_postprocess_no_model_call',source_run_id:input.sourceRun.run_id,source_raw_sha256:source.receipt.raw_output_sha256});await options.beforePublish();return publishRun(input.runDir,attempt.rawFile,{attempt_id:attempt.attempt_id});
}

export async function recordExecutionStart(runDir,attempt,mode,processEvidence=null){
 const reservation=await fs.readFile(path.join(attempt.attemptDir,'started.json')),start=JSON.parse(reservation);
 check(start.run_id===path.basename(runDir)&&start.attempt_id===attempt.attempt_id,'EXECUTION_RESERVATION_MISMATCH');
 await writeOnce(attempt.attemptDir,path.join(attempt.attemptDir,'execution-started.json'),{schema:'MFV:EXECUTION_START:v1',run_id:start.run_id,attempt_id:start.attempt_id,input_sha256:start.input_sha256,reservation_sha256:digest(reservation),mode,started_at:new Date().toISOString(),process:processEvidence});
}
