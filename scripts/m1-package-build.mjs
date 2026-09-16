import {installationProtocol,protocolFiles} from './m1-install-protocol.mjs';
const allowedName=s=>typeof s==='string'&&!path.isAbsolute(s)&&!s.includes('\\')&&s.split('/').every(x=>x&&x!=='.'&&x!=='..');
import fs from'node:fs/promises';import path from'node:path';import{execFileSync}from'node:child_process';import{init,parse}from'es-module-lexer';
import{digest,encode,check,readBytes,readJson,writeOnce,within,safePath,sourceCodeRoot as here}from'./m1-files.mjs';import{verifyPackage,tree}from'./m1-package.mjs';
export async function buildPackage({sourceRoot=here,destination,buildSha,synthetic=false}) {
 check(path.isAbsolute(destination)&&!within(destination,sourceRoot),'PACKAGE_DESTINATION_INVALID');
 check(/^[a-f0-9]{40}$/.test(buildSha??''),'BUILD_SHA_REQUIRED');
 await safePath(path.parse(destination).root,path.dirname(destination));
 const sourceCommit=execFileSync('git',['rev-parse',buildSha+'^{commit}'],{cwd:sourceRoot,encoding:'utf8'}).trim();check(sourceCommit===buildSha,'SOURCE_COMMIT_MISMATCH');
 await fs.mkdir(destination,{recursive:false,mode:0o700});
 const archive=execFileSync('git',['archive','--format=tar',buildSha],{cwd:sourceRoot,maxBuffer:64*1024*1024});const buildRoot=await fs.mkdtemp(path.join(path.dirname(destination),'runtime-build-'));
 execFileSync('tar',['-x','-C',buildRoot],{input:archive});sourceRoot=buildRoot;
 execFileSync('npm',['ci','--no-audit','--no-fund'],{cwd:sourceRoot,stdio:'pipe',timeout:120000});
 execFileSync(process.execPath,['node_modules/vite/bin/vite.js','build'],{cwd:sourceRoot,stdio:'pipe',timeout:60000});
 const list=await readJson(sourceRoot,path.join(sourceRoot,'runtime/files.json'));const imports=await verifyClosure(sourceRoot,list);
 check(/^[a-f0-9]{40}$/.test(buildSha),'BUILD_SHA_REQUIRED');
 for(const name of [...list.files,'runtime/files.json']){check(allowedName(name),'PACKAGE_PATH_INVALID');await writeOnce(destination,path.join(destination,name),(await readBytes(sourceRoot,path.join(sourceRoot,name))).toString());}
 for(const name of await tree(path.join(sourceRoot,'dist'))){if(name.startsWith('data/'))continue;await fs.mkdir(path.dirname(path.join(destination,'dist',name)),{recursive:true});await fs.copyFile(await safePath(sourceRoot,path.join(sourceRoot,'dist',name)),path.join(destination,'dist',name));}
 const runtimePackage=await readJson(sourceRoot,path.join(sourceRoot,'runtime/package.json')),runtimeLock=await readJson(sourceRoot,path.join(sourceRoot,'runtime/package-lock.json'));
 const dependencies=runtimePackage.dependencies;check(JSON.stringify(Object.keys(dependencies).sort())===JSON.stringify(['tsx','zod'])&&Object.values(dependencies).every(v=>/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(v)),'RUNTIME_EXACT_DEPENDENCIES_REQUIRED');
 check(JSON.stringify(runtimeLock.packages[''].dependencies)===JSON.stringify(dependencies),'RUNTIME_LOCK_MISMATCH');
 await writeOnce(destination,path.join(destination,'package.json'),runtimePackage);await writeOnce(destination,path.join(destination,'package-lock.json'),runtimeLock);
 execFileSync('npm',['ci','--omit=dev','--ignore-scripts','--no-audit','--no-fund'],{cwd:destination,stdio:'pipe',timeout:120000});
 // npm's binary aliases are not runtime inputs; use explicit module files and remove only package-created aliases.
 await fs.rm(path.join(destination,'node_modules/.bin'),{recursive:true,force:true});
 const files={};for(const name of await tree(destination)){const bytes=await readBytes(destination,path.join(destination,name),256*1024*1024);files[name]={sha256:digest(bytes),bytes:bytes.length};}
 const installation_protocol={schema:installationProtocol,files:Object.fromEntries(protocolFiles.map(file=>[file,files[file].sha256]))};
 const manifest={installation_protocol,schema:'MFV:RUNTIME_PACKAGE:v1',build_sha:buildSha,source_kind:'git_archive',source_archive_sha256:digest(archive),synthetic,platform:process.platform,architecture:process.arch,built_at:new Date().toISOString(),node_major:22,dependencies,files,imports,policy:await readJson(sourceRoot,path.join(sourceRoot,'config/m1-defaults.json'))};
 manifest.release_id=digest(encode(manifest));await writeOnce(destination,path.join(destination,'manifest.json'),manifest);await verifyPackage(destination);await fs.rm(buildRoot,{recursive:true,force:false});return manifest;
}

export async function verifyClosure(root,list){
 check(list.schema==='MFV:RUNTIME_FILES:v1'&&Array.isArray(list.files),'RUNTIME_LIST_INVALID');const names=new Set(list.files);check(names.size===list.files.length&&list.files.every(allowedName),'RUNTIME_PATH_INVALID');const graph={};
 for(const name of names){const bytes=await readBytes(root,path.join(root,name));if(!/\.(?:mjs|cjs|js|mts|cts|ts)$/.test(name))continue;await init;check(!/\.(?:cjs|cts)$/.test(name),'RUNTIME_COMMONJS_UNSUPPORTED');const source=bytes.toString();check(!/\brequire\s*\(/.test(source),'RUNTIME_COMMONJS_UNSUPPORTED');const [parsed]=parse(source,name),specs=[];
  for(const entry of parsed){if(entry.d===-2)continue;check(typeof entry.n==='string','DYNAMIC_IMPORT_UNREVIEWABLE');specs.push(entry.n);}graph[name]=[...new Set(specs)].sort();
  for(const spec of specs){if(spec.startsWith('.')){const resolved=path.posix.normalize(path.posix.join(path.posix.dirname(name),spec));check([resolved,resolved+'.ts',resolved+'.mjs',resolved+'.js'].some(x=>names.has(x)),'RUNTIME_IMPORT_MISSING:'+name+':'+spec);}else check(spec.startsWith('node:')||['tsx','zod'].includes(spec.split('/')[0]),'RUNTIME_DEPENDENCY_UNLISTED:'+spec);}
 }return graph;
}
