import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {execFileSync} from 'node:child_process';
import {doctor, doctorExitCode, inspectMutex, auditArchives} from '../scripts/m1-doctor.mjs';
import {createDisplayReader} from '../scripts/m1-display.mjs';
import {requireEvidence} from '../scripts/evidence-context.mjs';
import {digest} from '../scripts/m1-files.mjs';
import {businessMutex} from '../scripts/m1-mutex.mjs';

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mfv-doctor-')));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const data = path.join(root, 'data'), home = path.join(root, 'home');
  await fs.mkdir(data); await fs.mkdir(home);
  const server = net.createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port; await new Promise(r => server.close(r));
  return {data, home, port, options: {codeRoot: process.cwd(), config: {data_root: data, runtime_home: home, mutex_port: port}, manifest: {release_id: 'SYNTHETIC', build_sha: 'SYNTHETIC'}}};
}
async function put(root, name, value) {const file = path.join(root, name); await fs.mkdir(path.dirname(file), {recursive: true}); await fs.writeFile(file, JSON.stringify(value)); return file;}

test('default doctor is read-only and bounded; no absent state is called healthy', async t => {
  const f = await fixture(t), output = await doctor(f.options);
  assert.equal(output.tasks.official_current, 'unknown');
  for (const key of ['forecast', 'last_publication', 'inspection', 'backup', 'last_backup_success']) assert.equal(output[key].status, 'unknown');
  assert.equal(output.mutex.status, 'vacant'); assert.equal(output.audit.status, 'not_requested');
  assert.deepEqual(await fs.readdir(f.data), []); assert.deepEqual(await fs.readdir(f.home), []);
  const file = await put(f.data, 'm1-task-status/forecast.json', {status: 'failed', id: 'SYNTHETIC', trigger: 'manual', raw: 'SECRET'});
  const before = await fs.readFile(file), result = await doctor(f.options);
  assert.equal(result.forecast.result, 'failed'); assert.equal(result.forecast.trigger, 'manual'); assert.equal(result.forecast.thread_id, null);
  assert.equal(JSON.stringify(result).includes('SECRET'), false); assert.deepEqual(await fs.readFile(file), before);
  await fs.writeFile(file, 'x'.repeat(1024 * 1024 + 1)); assert.equal((await doctor(f.options)).forecast.status, 'unreadable');
  await fs.writeFile(file, '{}'); assert.equal((await doctor(f.options)).forecast.status, 'unreadable');
  await fs.unlink(file); await fs.symlink(path.join(f.home, 'missing'), file);
  assert.equal((await doctor(f.options)).forecast.status, 'unreadable');
});

test('passive mutex probe sees real owner, unknown listener and unconfirmed record without recovery', async t => {
  const f = await fixture(t), mutex = await businessMutex({dataRoot: f.data, port: f.port, releaseId: 'SYNTHETIC', task: 'ops'});
  assert.equal(mutex.status, 'ACQUIRED');
  const file = path.join(f.data, 'm1-control/owner.json'), before = await fs.readFile(file);
  try {assert.deepEqual(await inspectMutex({dataRoot: f.data, port: f.port}), {status: 'busy', owner_task: 'ops'}); assert.deepEqual(await fs.readFile(file), before);} finally {await mutex.close();}
  assert.equal((await inspectMutex({dataRoot: f.data, port: f.port})).status, 'vacant');
  const owner = JSON.parse(before); await fs.writeFile(file, JSON.stringify(owner));
  assert.equal((await inspectMutex({dataRoot: f.data, port: f.port})).status, 'unconfirmed_owner');
  const server = net.createServer(s => s.end('not a mutex')); await new Promise(r => server.listen(f.port, '127.0.0.1', r));
  try {assert.equal((await inspectMutex({dataRoot: f.data, port: f.port})).status, 'conflict');} finally {await new Promise(r => server.close(r));}
  assert.deepEqual(JSON.parse(await fs.readFile(file)), owner);
});

test('explicit archive audit reports corrupt objects and exhausted budget without writing', async t => {
  const f = await fixture(t), id = 'm1-20260912T183644170Z-00000000-0000-4000-8000-000000000011';
  const file = await put(f.data, 'forecast-runs/' + id + '/manifest.json', {}), before = await fs.readFile(file);
  await put(f.data, 'm1-candidates/' + id + '/manifest.json', {});
  await put(f.data, 'forecast-runs/unknown-format/manifest.json', {});
  const stopped = await auditArchives({codeRoot: process.cwd(), dataRoot: f.data, maxMs: 0});
  assert.equal(stopped.status, 'incomplete'); assert.equal(stopped.checked, 0);
  const audit = await auditArchives({codeRoot: process.cwd(), dataRoot: f.data});
  assert.equal(audit.status, 'failed'); assert.equal(audit.failed, 3); assert.equal(audit.total, 3);
  assert.equal(audit.failures.filter(x => x.kind === 'candidate').length, 1); assert.equal(audit.backup_restore_verified, false);
  assert.deepEqual(await fs.readFile(file), before);
});

test('installed helper and stable launcher reject unsupported audit arguments before execution', async t => {
  const f = await fixture(t);
  for (const args of [ ['scripts/m1-installed.mjs', 'doctor', '--full-audit', 'extra'], ['scripts/m1-installed.mjs', 'forecast', '--full-audit'], ['runtime/launch.mjs', f.home, 'ops', '--full-audit'], ['runtime/launch.mjs', f.home, 'doctor', '--unexpected'] ]) {
    assert.throws(() => execFileSync(process.execPath, args, {env: {...process.env, MFV_RUNTIME_HOME: f.home}, stdio: 'pipe'}), /failed/);
  }
  // The helper must forward the explicit option, not silently consume it.
  await fs.writeFile(path.join(f.home, 'launch.mjs'), 'console.log(JSON.stringify(process.argv.slice(2)))');
  const forwarded = JSON.parse(execFileSync(process.execPath, ['scripts/m1-installed.mjs', 'doctor', '--full-audit'], {env: {...process.env, MFV_RUNTIME_HOME: f.home}, encoding: 'utf8'}));
  assert.deepEqual(forwarded, [f.home, 'doctor', '--full-audit']);
  for (const status of ['failed', 'incomplete']) {
    const code = doctorExitCode({audit: {status}}); assert.equal(code, 2);
    await fs.writeFile(path.join(f.home, 'launch.mjs'), 'process.exit(2)');
    assert.throws(() => execFileSync(process.execPath, ['scripts/m1-installed.mjs', 'doctor', '--full-audit'], {env: {...process.env, MFV_RUNTIME_HOME: f.home}, stdio: 'pipe'}), error => error.status === code);
  }
  assert.equal(doctorExitCode({audit: {status: 'completed'}}), 0);
  assert.equal(doctorExitCode({audit: {status: 'not_requested'}}), 0);
});

test('published production and candidate audits fail on returned evaluation errors; partial and not evaluated are legitimate', async t => {
  const evidence = requireEvidence(), f = await fixture(t);
  const id = 'm1-20260912T183644170Z-00000000-0000-4000-8000-000000000011';
  // Only the wrapper-generated synthetic workspace is an input; never production.
  for (const name of ['data-source', 'm1-outcomes']) await fs.cp(path.join(evidence.workspace, 'artifacts', name), path.join(f.data, name), {recursive: true});
  for (const name of ['forecast-runs', 'm1-candidates']) await fs.cp(path.join(evidence.workspace, 'artifacts/forecast-runs', id), path.join(f.data, name, id), {recursive: true});
  const opts = {codeRoot: process.cwd(), dataRoot: f.data};
  const reader = createDisplayReader({root: opts.codeRoot, dataRoot: f.data});
  const run = await reader.readRun(id);
  assert.equal(run.evaluation.status, 'available'); assert.equal(run.evaluation.result.windows.h24.status, 'missing_data');
  const healthy = await auditArchives(opts); assert.equal(healthy.status, 'completed'); assert.equal(healthy.checked, 2);
  const outcome = path.join(f.data, 'm1-outcomes', id), revisions = path.join(outcome, 'evaluations');
  const revisionId = (await fs.readdir(revisions)).filter(x => x.startsWith('evaluation-'))[0];
  const resultFile = path.join(revisions, revisionId, 'result.json'), originalResult = await fs.readFile(resultFile);
  const captureDir = path.join(outcome, 'captures'), captureId = (await fs.readdir(captureDir))[0];
  const pageFile = path.join(captureDir, captureId, 'page-001.json'), originalPage = await fs.readFile(pageFile);
  for (const [file, original] of [[resultFile, originalResult], [pageFile, originalPage]]) {
    await fs.writeFile(file, '{}'); const before = await treeHashes(f.data);
    assert.equal((await reader.readRun(id)).evaluation.status, 'failed');
    const broken = await auditArchives(opts); assert.equal(broken.status, 'failed'); assert.equal(broken.failed, 2);
    assert.deepEqual(broken.failures.map(x => x.kind), ['production', 'candidate']);
    assert.deepEqual(await treeHashes(f.data), before); await fs.writeFile(file, original);
  }
  const metaFile = path.join(revisions, revisionId, 'manifest.json'), metaBytes = await fs.readFile(metaFile);
  const meta = JSON.parse(metaBytes); meta.evaluation_code_sha256 = 'f'.repeat(64); await fs.writeFile(metaFile, JSON.stringify(meta));
  const beforeUnknown = await treeHashes(f.data);
  assert.equal((await reader.readRun(id)).evaluation.reason, 'evaluation_unsupported');
  assert.equal((await auditArchives(opts)).failed, 2); assert.deepEqual(await treeHashes(f.data), beforeUnknown);
  await fs.writeFile(metaFile, metaBytes);
  await fs.rm(outcome, {recursive: true});
  const empty = await auditArchives(opts); assert.equal(empty.status, 'completed'); assert.equal(empty.not_evaluated, 2);
  assert.equal(empty.historical_revisions_audited, false);
});

async function treeHashes(root, relative = '') {
  const hashes = {};
  for (const item of await fs.readdir(path.join(root, relative), {withFileTypes: true})) {
    const name = path.join(relative, item.name);
    if (item.isDirectory()) Object.assign(hashes, await treeHashes(root, name));
    else hashes[name] = digest(await fs.readFile(path.join(root, name)));
  }
  return hashes;
}
