import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
export function requireEvidence() {
  const file = process.env.MFV_EVIDENCE_CONTEXT, token = process.env.MFV_EVIDENCE_TOKEN;
  if (!file || !token || !/^[a-f0-9]{64}$/.test(token)) throw Error('EVIDENCE_WRAPPER_REQUIRED');
  const c = JSON.parse(fs.readFileSync(file, 'utf8'));
  const root = path.resolve(c.evidence_root), workspace = path.join(root, 'work');
  if (c.schema !== 'MFV:EVIDENCE_CONTEXT:v1' || path.resolve(file) !== path.join(root, 'context.json')
    || path.basename(path.dirname(root)) !== 'evidence' || !/^\d{8}T\d{9}Z-[a-f0-9-]{36}$/.test(path.basename(root))
    || c.token_sha256 !== createHash('sha256').update(token).digest('hex')
    || path.resolve(process.cwd()) !== workspace || c.workspace !== workspace
    || fs.existsSync(path.join(root, 'completed.json')) || Date.now() - Date.parse(c.started_at) > 4 * 3600000) throw Error('EVIDENCE_CONTEXT_INVALID');
  for (let p = root; p !== path.dirname(p); p = path.dirname(p)) if (fs.lstatSync(p).isSymbolicLink()) throw Error('EVIDENCE_SYMLINK_FORBIDDEN');
  process.kill(c.parent_pid, 0);
  return c;
}
