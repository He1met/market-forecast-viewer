import test from'node:test';import assert from'node:assert/strict';import fs from'node:fs/promises';import path from'node:path';import os from'node:os';import http from'node:http';import net from'node:net';import{serviceStatus,startService,stopService}from'../scripts/m1-service.mjs';
for(const protocol of ['http-404','non-http','stalled'])test(`unknown ${protocol} listener blocks launch without consuming restart budget`,async t=>{
 const home=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'mfv-foreign-service-'));
 const sockets=new Set();const server=protocol==='http-404'?http.createServer((req,res)=>{res.writeHead(404);res.end('missing');}):net.createServer(socket=>{if(protocol==='non-http')socket.end('NOT HTTP\n');});
 server.on('connection',socket=>{sockets.add(socket);socket.on('error',()=>{});socket.on('close',()=>sockets.delete(socket));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;
 t.after(async()=>{for(const socket of sockets)socket.destroy();await new Promise(r=>server.close(r));await fs.rm(home,{recursive:true,force:true});});
 await fs.mkdir(path.join(home,'service'));const budget='[{"at":0,"automatic":true}]';await fs.writeFile(path.join(home,'service/restarts.json'),budget);
 for(const staleOwner of [false,true]){
  if(staleOwner)await fs.writeFile(path.join(home,'service/owner.json'),JSON.stringify({pid:2147483647,identity:'SYNTHETIC_DEAD',token:'SYNTHETIC',release_id:'SYNTHETIC'}));
  assert.equal((await serviceStatus({runtimeHome:home,port})).status,'unknown_listener');
  await assert.rejects(()=>startService({runtimeHome:home,port,releaseId:'SYNTHETIC',paused:false,automatic:true}),/SERVICE_OWNER_OR_PORT_CONFLICT/);
  await assert.rejects(()=>stopService({runtimeHome:home,port}),/SERVICE_IDENTITY_UNKNOWN/);
  assert.equal(await fs.readFile(path.join(home,'service/restarts.json'),'utf8'),budget);
  assert.equal(await fs.stat(path.join(home,'service/logs')).catch(()=>null),null);
 }
 assert.equal(server.listening,true);
});
test('service never stops or replaces an unknown listener and preserves foreign control lock',async t=>{
 const home=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'mfv-service-'));t.after(()=>fs.rm(home,{recursive:true,force:true}));const server=http.createServer((req,res)=>res.end(JSON.stringify({ready:true,release_id:'FOREIGN'})));await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));const port=server.address().port;
 assert.equal((await serviceStatus({runtimeHome:home,port})).status,'unknown_listener');await assert.rejects(()=>startService({runtimeHome:home,port,releaseId:'SYNTHETIC',paused:false}),/SERVICE_OWNER_OR_PORT_CONFLICT/);await assert.rejects(()=>stopService({runtimeHome:home,port}),/SERVICE_IDENTITY_UNKNOWN/);assert.equal((await fetch('http://127.0.0.1:'+port+'/health')).status,200);
 await fs.mkdir(path.join(home,'service/control.lock'));await fs.writeFile(path.join(home,'service/control.lock/owner.json'),'FOREIGN');assert.equal((await startService({runtimeHome:home,port,releaseId:'SYNTHETIC',paused:false})).status,'control_busy');assert.equal(await fs.readFile(path.join(home,'service/control.lock/owner.json'),'utf8'),'FOREIGN');
});

test('owned service starts with identity/token, stops safely and exhausts bounded automatic restart budget',async t=>{
 const home=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'mfv-owned-service-'));let port;t.after(async()=>{if(port)await stopService({runtimeHome:home,port}).catch(()=>{});await fs.rm(home,{recursive:true,force:true});});
 const server=http.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));port=server.address().port;await new Promise(r=>server.close(r));const code=path.join(home,'releases/SYNTHETIC');await fs.mkdir(path.join(code,'scripts'),{recursive:true});await fs.cp(path.resolve('node_modules'),path.join(code,'node_modules'),{recursive:true});await fs.writeFile(path.join(home,'installation.local.json'),JSON.stringify({http_port:port}));
 await fs.writeFile(path.join(code,'scripts/m1-entry.mjs'),`import fs from 'node:fs';import http from 'node:http';const c=JSON.parse(fs.readFileSync(process.argv[3]+'/installation.local.json'));http.createServer((req,res)=>res.end(JSON.stringify({owner_token:process.env.MFV_SERVICE_TOKEN,release_id:'SYNTHETIC',ready:true}))).listen(c.http_port,'127.0.0.1');`);
 assert.equal((await startService({runtimeHome:home,port,releaseId:'SYNTHETIC',paused:false})).status,'healthy');const before=await serviceStatus({runtimeHome:home,port});assert.equal((await startService({runtimeHome:home,port,releaseId:'SYNTHETIC',paused:false})).owner.token,before.owner.token);assert.equal((await stopService({runtimeHome:home,port})).status,'stopped');
 await fs.writeFile(path.join(home,'service/restarts.json'),JSON.stringify(Array.from({length:3},()=>({at:Date.now(),release_id:'SYNTHETIC',automatic:true}))));assert.equal((await startService({runtimeHome:home,port,releaseId:'SYNTHETIC',paused:false,automatic:true})).status,'restart_budget_exhausted');
 const {inspectService}=await import('../scripts/m1-service.mjs');const result=await inspectService({runtimeHome:home,port,releaseId:'SYNTHETIC',paused:false});assert.equal(result.status,'restart_budget_exhausted');assert.equal(result.before_status,'exited');assert.equal(result.restart_attempted,true);
});

test('ops preserves service failures after completed slot, deduplicates separate alerts and records true recovery',async t=>{
 const {ops}=await import('../scripts/m1-ops.mjs'),{alertStore}=await import('../scripts/m1-alerts.mjs'),{notificationSummary}=await import('../scripts/m1-notifications.mjs');
 const root=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'mfv-ops-service-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
 let state='healthy',calls=0,refreshes=0;const options={codeRoot:process.cwd(),dataRoot:root,port,releaseId:'SYNTHETIC',refreshInputs:async()=>{refreshes++;},inspectService:async()=>{calls++;return{status:state};}};
 assert.equal((await ops(options)).status,'completed');assert.equal(refreshes,1);
 const slotDir=path.join(root,'m1-control/ops-slots'),slotFile=path.join(slotDir,(await fs.readdir(slotDir))[0]),slotBytes=await fs.readFile(slotFile);
 state='restart_budget_exhausted';let result=await ops(options);assert.equal(result.status,'partial');assert.equal(result.service.status,state);assert.equal(result.reason,'service_unavailable');
 await ops(options);const store=alertStore(root,{stream:'service'});assert.equal((await store.pending()).length,1);assert.equal((await store.pending())[0].code,'SERVICE_RESTART_BUDGET_EXHAUSTED');
 await ops(options);assert.equal((await store.pending()).length,1);
 state='paused';await ops(options);assert.equal((await store.pending()).length,1);
 state='healthy';await ops(options);assert.deepEqual((await store.pending()).map(x=>x.kind),['fault','recovery']);
 assert.equal((await notificationSummary(root)).events.filter(x=>x.stream==='service').length,2);
 const recorded=JSON.parse(await fs.readFile(path.join(root,'m1-task-status/ops.json')));assert.equal(recorded.service.status,'healthy');
 const before=calls;await ops({...options,paused:true});assert.equal(calls,before);
 state='unknown_listener';result=await ops(options);assert.equal(result.status,'partial');assert.equal((await store.pending()).at(-1).severity,'critical');
 result=await ops({...options,inspectService:async()=>{throw Error('EACCES synthetic');}});assert.equal(result.service.status,'inspection_failed');assert.equal(result.status,'partial');
 assert.equal(refreshes,1);assert.deepEqual(await fs.readFile(slotFile),slotBytes);
});

test('service inspection honors pause and preserves unknown listener without starting a process',async t=>{
 const {inspectService}=await import('../scripts/m1-service.mjs');const home=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'mfv-inspect-service-'));t.after(()=>fs.rm(home,{recursive:true,force:true}));
 const server=net.createServer(s=>s.end());await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));const options={runtimeHome:home,port:server.address().port,releaseId:'SYNTHETIC'};
 assert.equal((await inspectService({...options,paused:true})).status,'paused');assert.equal((await inspectService(options)).status,'unknown_listener');
 assert.equal(await fs.stat(path.join(home,'service/restarts.json')).catch(()=>null),null);assert.equal(server.listening,true);
});
