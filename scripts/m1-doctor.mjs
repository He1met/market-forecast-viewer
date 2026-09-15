import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import {readBytes, check, safePath} from './m1-files.mjs';
import {processIdentity} from './m1-mutex.mjs';
import {capacitySnapshot} from './m1-capacity.mjs';
import {createDisplayReader} from './m1-display.mjs';
import {caseStore} from './m1-cases.mjs';

// Fixed-size reads only. Recorded summaries are not fresh archive verification
// or an official scheduler readback. Never return raw errors or arbitrary fields.
async function recorded(root, name, project) {
  try {
    const value = JSON.parse((await readBytes(root, path.join(root, name), 1024 * 1024)).toString());
    check(value && typeof value === 'object' && !Array.isArray(value), 'RECORD_INVALID');
    return {status: 'recorded', source: name, ...project(value)};
  } catch (error) {
    return {status: error.code === 'ENOENT' ? 'unknown' : 'unreadable', source: name};
  }
}
const scalar = value => ['string', 'number', 'boolean'].includes(typeof value) ? value : null;
function attempt(value) {
  check(typeof value.status === 'string', 'ATTEMPT_INVALID');
  return Object.fromEntries(['id', 'task', 'trigger', 'task_id', 'thread_id', 'release_id',
    'started_at', 'completed_at', 'status', 'forecast_id', 'backup_id'].map(key =>
    [key === 'status' ? 'result' : key, scalar(value[key])]));
}

// Passive loopback probe; no bind, owner mutation, recovery or process signals.
export async function inspectMutex({dataRoot, port}) {
  const saved = await recorded(dataRoot, 'm1-control/owner.json', value => ({owner: value}));
  const probe = await new Promise(resolve => {
    let text = '', settled = false;
    const socket = net.createConnection({host: '127.0.0.1', port});
    const finish = result => {if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); resolve(result);};
    const timer = setTimeout(() => finish({status: 'unknown'}), 600);
    socket.on('error', error => finish({status: error.code === 'ECONNREFUSED' ? 'vacant' : 'unknown'}));
    socket.on('data', chunk => {text += chunk; if (Buffer.byteLength(text) > 4096) finish({status: 'conflict'});});
    socket.on('end', () => {try {finish({status: 'reply', value: JSON.parse(text)});} catch {finish({status: 'conflict'});}});
  });
  const owner = saved.owner;
  if (probe.status === 'reply') {
    const reply = probe.value;
    const valid = reply?.schema === 'MFV:MUTEX:v1' && owner?.schema === 'MFV:MUTEX_OWNER:v1'
      && reply.data_root === dataRoot && owner.data_root === dataRoot
      && reply.token === owner.token && reply.pid === owner.pid
      && Number.isSafeInteger(reply.pid) && reply.pid > 1 && owner.identity === processIdentity(reply.pid);
    return {status: valid ? 'busy' : 'conflict', owner_task: valid ? scalar(owner.task) : null};
  }
  if (probe.status === 'vacant') return {status: saved.status === 'unreadable' ? 'unknown'
    : owner && !owner.completed_at ? 'unconfirmed_owner' : 'vacant', owner_record: saved.status};
  return {status: probe.status, owner_record: saved.status};
}

// Explicit audit replays original forecasts, candidates and cases without
// capture/evaluate/write APIs. Budget is cooperative between file operations.
export async function auditArchives({codeRoot, dataRoot, maxMs = 30000}) {
  check(Number.isFinite(maxMs) && maxMs >= 0 && maxMs <= 30000, 'AUDIT_BUDGET_INVALID');
  const start = performance.now(), failures = [], groups = [];
  let total = 0, checked = 0, failed = 0, notEvaluated = 0, complete = true;
  const inventory = async name => {
    const dir = path.join(dataRoot, name);
    try {await safePath(dataRoot, dir); return await fs.readdir(dir);} catch (error) {if (error.code !== 'ENOENT') throw error; return [];}
  };
  try {
    for (const role of ['production', 'candidate']) {
      const name = role === 'production' ? 'forecast-runs' : 'm1-candidates';
      const reader = createDisplayReader({root: codeRoot, dataRoot, runsRoot: path.join(dataRoot, name)});
      groups.push({kind: role, ids: await inventory(name), read: id => reader.readRun(id)});
    }
    groups.push({kind: 'case', ids: await inventory('m1-cases'), read: id => caseStore({codeRoot, dataRoot}).read(id)});
    total = groups.reduce((sum, group) => sum + group.ids.length, 0);
    for (const group of groups) for (const id of group.ids) {
      if (performance.now() - start >= maxMs) {complete = false; break;}
      try {
        const value = await group.read(id);
        if (group.kind !== 'case') {
          check(['available', 'not_evaluated'].includes(value.evaluation?.status), 'EVALUATION_UNVERIFIABLE');
          if (value.evaluation.status === 'not_evaluated') notEvaluated++;
        }
      } catch {failed++; if (failures.length < 20) failures.push({kind: group.kind, id, reason: 'unverifiable_or_ineligible'});}
      checked++;
    }
  } catch {complete = false; failures.push({reason: 'inventory_unreadable'});}
  return {status: !complete ? 'incomplete' : failed ? 'failed' : 'completed',
    scope: ['production_archive', 'candidate_archive', 'case_recomputation'],
    snapshot: 'non_transactional_read_only', total, checked, failed, failures,
    not_evaluated: notEvaluated,
    evaluation_scope: 'latest_evaluation_and_its_referenced_capture',
    historical_revisions_audited: false,
    omitted_failures: Math.max(0, failed - 20), budget_ms: maxMs,
    backup_restore_verified: false};
}

export function doctorExitCode(result) {
  return ['failed', 'incomplete'].includes(result?.audit?.status) ? 2 : 0;
}

export async function doctor({codeRoot, config, manifest, fullAudit = false}) {
  check(typeof fullAudit === 'boolean', 'DOCTOR_OPTIONS_INVALID');
  const data = config.data_root;
  const result = {schema: 'MFV:DOCTOR:v1', checked_at: new Date().toISOString(),
    release_id: manifest.release_id, build_sha: manifest.build_sha, package_integrity: 'verified',
    roots: {code_root: codeRoot, data_root: data, runtime_home: config.runtime_home},
    production_paused: config.forecast_paused !== false,
    pauses: {forecast: config.forecast_paused !== false, ops: config.ops_paused !== false, service: config.service_paused !== false},
    outer_hard_timeout_verified: false,
    tasks: {official_current: 'unknown',
      release_intents: await recorded(codeRoot, 'config/tasks.json', value => {
        check(value.schema === 'MFV:TASK_INTENTS:v1' && Array.isArray(value.tasks), 'TASK_INTENTS_INVALID');
        return {timezone: scalar(value.timezone), count: value.tasks.length,
          tasks: value.tasks.slice(0, 8).map(t => ({key: scalar(t.key), existing_id: scalar(t.existing_id), cron: scalar(t.cron)}))};
      }),
      legacy_evidence: await recorded(data, 'm1-runtime/configuration.json', value => ({schema: scalar(value.schema)}))},
    mutex: await inspectMutex({dataRoot: data, port: config.mutex_port}),
    capacity: await capacitySnapshot(data, {policy: config.capacity}),
    forecast: await recorded(data, 'm1-task-status/forecast.json', attempt),
    last_publication: await recorded(data, 'm1-task-status/last-forecast-success.json', attempt),
    inspection: await recorded(data, 'm1-task-status/ops.json', attempt),
    backup: await recorded(data, 'm1-task-status/backup.json', attempt),
    last_backup_success: await recorded(data, 'm1-task-status/last-backup-success.json', attempt),
    learning: {
      controls: await recorded(data, 'm1-learning/controls.json', value => ({disabled: scalar(value.learning_disabled), effective_at: scalar(value.effective_at)})),
      strategy: await recorded(data, 'm1-learning/production-policy.json', value => {
        check(value.schema === 'MFV:PRODUCTION_POLICY:v1' && value.policy, 'POLICY_RECORD_INVALID');
        return {effective_after: scalar(value.effective_after), policy: Object.fromEntries(['predictor_version', 'feedback', 'lambda', 'additional_inputs', 'model', 'reasoning_effort'].map(k => [k, scalar(value.policy[k])]))};
      }),
      experiment: await recorded(data, 'm1-experiments/active.json', value => ({id: scalar(value.id), experiment_status: scalar(value.status), plan_hash: scalar(value.plan_hash)}))},
    audit: fullAudit ? await auditArchives({codeRoot, dataRoot: data}) : {status: 'not_requested'},
    limitations: ['Recorded summaries are not current archive verification or official task state.',
      'Reads are non-transactional. Unknown or unreadable records do not imply success.',
      'Backup observation integration remains pending; missing backup summaries stay unknown.']};
  return result;
}
