import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {check} from './m1-files.mjs';
import {verifyPackage} from './m1-package.mjs';
const execute=promisify(execFile);
// A bounded, read-only smoke of the exact target at the configured loopback port.
// It closes before activation; it does not turn on the paused display service.
const probe=`
import {serve} from './scripts/m1-server.mjs';
import {runtimeDisplaySchema} from './src/m1-display.ts';
import {exists} from './scripts/m1-files.mjs';
import path from 'node:path';
const port=Number(process.env.MFV_PROBE_PORT),release=process.env.MFV_PROBE_RELEASE;
const server=await serve({codeRoot:process.cwd(),dataRoot:process.env.MFV_DATA_ROOT,port});
try {
 const get=async route=>{const r=await fetch('http://127.0.0.1:'+port+route,{signal:AbortSignal.timeout(3000)});if(!r.ok)throw Error('DEPLOY_HTTP_FAILED');return r;};
 const h=await(await get('/health')).json();
 if(h.schema!=='MFV:HEALTH:v1'||h.release_id!==release||h.build_sha!==process.env.MFV_PROBE_BUILD||h.ready!==true)throw Error('DEPLOY_HEALTH_IDENTITY');
 runtimeDisplaySchema.parse(await(await get('/api/m1/runtime')).json());
 const hasProjection=await exists(path.join(process.env.MFV_DATA_ROOT,'m1-projections/index.json'));
 let indexStatus='not_initialized';
 if(hasProjection){const index=await(await get('/api/m1/index')).json();if(index.schema!=='MFV:M1_INDEX:v1'||!Array.isArray(index.runs))throw Error('DEPLOY_INDEX_CONTRACT');indexStatus='passed';}
 const html=await(await get('/')).text();if(!html.includes('<html'))throw Error('DEPLOY_PAGE_INVALID');
 console.log(JSON.stringify({status:'healthy',release_id:h.release_id,build_sha:h.build_sha,checks:['health','runtime','page'],index_status:indexStatus}));
} finally {server.closeAllConnections();await new Promise(r=>server.close(r));}
`;
export async function verifyDeploymentHealth({packageRoot,dataRoot,releaseId,port}) {
 const manifest=await verifyPackage(packageRoot);
 check(manifest.release_id===releaseId,'DEPLOY_TARGET_MISMATCH');
 check(Number.isInteger(port)&&port>=1024&&port<=65535,'INVALID_PORT');
 const env={...process.env,MFV_DATA_ROOT:dataRoot,MFV_PROBE_PORT:String(port),MFV_PROBE_RELEASE:releaseId,MFV_PROBE_BUILD:manifest.build_sha};
 delete env.NODE_OPTIONS;delete env.NODE_PATH;
 const {stdout}=await execute(process.execPath,['--import','tsx','--input-type=module','-e',probe],{cwd:packageRoot,env,timeout:15000,killSignal:'SIGKILL',maxBuffer:1024*1024});
 const result=JSON.parse(stdout);check(result.status==='healthy'&&result.release_id===releaseId&&result.build_sha===manifest.build_sha,'DEPLOY_HEALTH_RESULT_INVALID');
 check((await verifyPackage(packageRoot)).release_id===releaseId,'DEPLOY_TARGET_CHANGED');
 return {schema:'MFV:DEPLOY_HEALTH:v1',...result,checked_at:new Date().toISOString(),scope:'pre_activation_target_http',service_left_running:false};
}
