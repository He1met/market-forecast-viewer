import http from 'node:http';import path from 'node:path';
import{check,readBytes,digest}from'./m1-files.mjs';import{verifyPackage}from'./m1-package.mjs';import{projectionStore}from'./m1-index.mjs';import{createDisplayReader}from'./m1-display.mjs';import{runtimeDisplay}from'./m1-status.mjs';
const mime={'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon','.txt':'text/plain; charset=utf-8'};
export async function serve({codeRoot,dataRoot,port,paused=true,readStatusOptions=async()=>({paused})}){
 const manifest=await verifyPackage(codeRoot),views=projectionStore(dataRoot,{reader:createDisplayReader({root:codeRoot,dataRoot})}),origin=`http://127.0.0.1:${port}`;
 const server=http.createServer(async(req,res)=>{try{
  check(req.method==='GET','METHOD_FORBIDDEN');check(req.headers.host===`127.0.0.1:${port}`,'HOST_FORBIDDEN');
  for(const key of ['origin','referer'])if(req.headers[key])check(new URL(req.headers[key]).origin===origin,'ORIGIN_FORBIDDEN');
  check(!req.headers['content-length']||req.headers['content-length']==='0','BODY_FORBIDDEN');
  check(req.url.length<=2048&&!/%(?:2e|2f|5c)/i.test(req.url)&&!req.url.includes('\\')&&!req.url.split('/').includes('..'),'PATH_FORBIDDEN');
  const url=new URL(req.url,origin);let body,type='application/json; charset=utf-8';
  if(url.pathname==='/api/m1/index')body=JSON.stringify(await views.page(Number(url.searchParams.get('cursor')??0)));
  else if(/^\/api\/m1\/runs\/m1-[\w-]+$/.test(url.pathname))body=JSON.stringify(await views.run(url.pathname.split('/').at(-1)));
  else if(url.pathname==='/api/m1/runtime')body=JSON.stringify(await runtimeDisplay(dataRoot,await readStatusOptions()));
  else if(url.pathname==='/health')body=JSON.stringify({schema:'MFV:HEALTH:v1',release_id:manifest.release_id,build_sha:manifest.build_sha,ready:true,owner_token:process.env.MFV_SERVICE_TOKEN??null});
  else {const name=url.pathname==='/'?'dist/index.html':'dist'+url.pathname;check(manifest.files[name]&&mime[path.extname(name)]&&!name.startsWith('dist/data/'),'STATIC_FORBIDDEN');body=await readBytes(codeRoot,path.join(codeRoot,name));check(digest(body)===manifest.files[name].sha256,'STATIC_INTEGRITY_CHANGED');type=mime[path.extname(name)];}
  res.writeHead(200,{'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'"});res.end(body);
 }catch{res.writeHead(404,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end('{"error":"unavailable"}');}});
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen({host:'127.0.0.1',port,exclusive:true},resolve);});return server;
}
