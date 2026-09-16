import path from 'node:path';
import {check,digest,readBytes,readJson,exists} from './m1-files.mjs';
export const installationProtocol='MFV:INSTALL_PENDING:v1';
export const protocolFiles=['runtime/launch.mjs','scripts/m1-entry.mjs','scripts/m1-files.mjs','scripts/m1-service.mjs','scripts/m1-admin.mjs','scripts/m1-install-commit.mjs'];
// The exact package and explicit maintainer protocol acknowledgement are the
// evidence. A keyword in an old launcher is not a protocol certification.
export function verifyProtocolEvidence({manifest,approval,launcher}) {
 check(manifest.installation_protocol?.schema===installationProtocol&&approval.installation_protocol===installationProtocol,'LEGACY_INSTALLATION_PROTOCOL_UNSUPPORTED');
 check(manifest.synthetic===false&&approval.schema==='MFV:MAINTAINER_APPROVAL:v1'&&approval.approved===true&&approval.release_id===manifest.release_id&&approval.build_sha===manifest.build_sha&&/^https:\/\/github\.com\/He1met\/market-forecast-viewer\/(?:pull|issues)\//.test(approval.source_url)&&Number.isFinite(Date.parse(approval.approved_at)),'PROTOCOL_APPROVAL_MISMATCH');
 for(const file of protocolFiles)check(/^[a-f0-9]{64}$/.test(manifest.installation_protocol.files?.[file]??'')&&manifest.installation_protocol.files[file]===manifest.files[file]?.sha256,'INSTALL_PROTOCOL_BINDING_INVALID');
 check(digest(launcher)===manifest.files['runtime/launch.mjs'].sha256,'INSTALLED_LAUNCHER_PROTOCOL_MISMATCH');
}
export function verifyConfigBoundary(before,after) {
 check(before.data_root===after.data_root&&before.mutex_port===after.mutex_port&&before.runtime_home===after.runtime_home,'INSTALLATION_CHANGED');
 check(before.http_port===after.http_port,'HTTP_PORT_MIGRATION_REQUIRES_SEPARATE_FLOW');
}
export async function verifyExistingCoordinates(runtimeHome,next) {
 const currentFile=path.join(runtimeHome,'current.json');
 if(!await exists(currentFile)){
  check(!await exists(path.join(runtimeHome,'launch.mjs'))&&!await exists(path.join(runtimeHome,'installation.local.json')),'LEGACY_PARTIAL_INSTALLATION_REQUIRES_MIGRATION');return null;
 }
 const before=await readJson(runtimeHome,path.join(runtimeHome,'installation.local.json'));verifyConfigBoundary(before,next);return before;
}
export async function installedLauncher(runtimeHome){return readBytes(runtimeHome,path.join(runtimeHome,'launch.mjs'));}
