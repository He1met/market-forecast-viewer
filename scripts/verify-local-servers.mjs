import{requireEvidence}from'./evidence-context.mjs';requireEvidence();
import {spawn,spawnSync,execFileSync}from'node:child_process';
import {mkdir,writeFile}from'node:fs/promises';
import {chromium}from'@playwright/test';
const folder='artifacts/c5';await mkdir(folder,{recursive:true});const reports=[];
const listening=port=>{const r=spawnSync('lsof',['-nP',`-iTCP:${port}`,'-sTCP:LISTEN'],{encoding:'utf8'});return r.status===0?r.stdout:'';};
for(const [script,port]of[['dev',5173],['preview',4173]]){
 if(listening(port))throw Error(`端口${port}已被占用，未启动或终止其他进程`);
 const command=`npm run ${script}`;const child=spawn('npm',['run',script],{detached:true,stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);let browser;
 try{
  let ready=false;for(let i=0;i<100;i++){if(child.exitCode!==null)throw Error(`服务提前退出: ${output}`);try{const r=await fetch(`http://127.0.0.1:${port}`);if(r.ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}if(!ready)throw Error('服务启动超时');
  const listeners=listening(port);if(!listeners.includes(`127.0.0.1:${port}`)||listeners.includes(`*:${port}`)||listeners.includes(`[::]:${port}`))throw Error('监听地址不是限定127.0.0.1');
  const conflict=spawnSync('npm',['run',script],{encoding:'utf8',timeout:15000});if(conflict.status===0||!((conflict.stdout??'')+(conflict.stderr??'')).includes(`Port ${port} is already in use`))throw Error('端口冲突未明确失败');
  browser=await chromium.launch();const context=await browser.newContext({viewport:{width:1440,height:900},deviceScaleFactor:1,timezoneId:'Asia/Shanghai'});const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(`http://127.0.0.1:${port}/?test=1`);await page.waitForFunction(()=>window.chartTest?.snapshot()?.gridLineCount>0);await page.waitForFunction(()=>window.chartTest?.snapshot()?.vertices?.length===97);await page.screenshot({path:`${folder}/${script}-startup.png`,fullPage:true});const state=await page.evaluate(()=>window.chartTest.snapshot());if(state.historyCount!==1344||errors.length)throw Error('实际页面验证失败 '+errors.join(','));reports.push({command,result:'PASS',url:`http://127.0.0.1:${port}`,started_pid:child.pid,listeners,conflicting_command_exit:conflict.status,conflict_error:conflict.stderr.trim(),browser:browser.version(),viewport:{width:1440,height:900},dpr:1,timezone:'Asia/Shanghai',code_head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),code_receipt:'artifacts/c5/code-receipt.json',screenshot:`${folder}/${script}-startup.png`,page_state:state});
 }finally{
  if(browser)await browser.close();try{process.kill(-child.pid,'SIGTERM');}catch(e){if(e.code!=='ESRCH')throw e;}
  for(let i=0;i<50&&listening(port);i++)await new Promise(r=>setTimeout(r,100));await writeFile(`${folder}/${script}-startup.log`,output);if(listening(port))throw Error(`自己启动的${script}服务尚未停止`);if(reports.at(-1)?.command===command)reports.at(-1).stop_result='PASS';
 }
}
await writeFile(`${folder}/local-servers.json`,JSON.stringify({result:'PASS',at:new Date().toISOString(),reports},null,2));console.log('PASS: clean-install dev/preview, loopback bindings, port-conflict refusal, browser rendering, and stop');
