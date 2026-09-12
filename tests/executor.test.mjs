import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { context, acquire, release, saveCheckpoint, recovery, queueCandidates, issueStamp, localQueue, claim, receipt, syncInbox, sha } from '../scripts/executor.mjs';

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mfv-w0-test-'));
  const root = path.join(base, 'repo'); fs.mkdirSync(root);
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(root, '.gitignore'), 'artifacts/\n');
  fs.writeFileSync(path.join(root, 'file.txt'), 'baseline'); git('add', '.'); git('commit', '-m', 'fixture');
  git('checkout', '-b', 'feat/chart-mvp');
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return { c: context(root), git, base };
}
const owner = (run_id = 'first') => ({ run_id, thread_id: 'fixture-thread', issue_number: 9, trigger: 'manual' });

test('lock excludes a second run and a linked worktree; wrong owner cannot release', t => {
  const { c, git, base } = fixture(t);
  assert.equal(acquire(c, owner()).status, 'ACQUIRED');
  const before = fs.readFileSync(path.join(c.lock, 'owner.json'), 'utf8');
  git('worktree', 'add', '-b', 'other', path.join(base, 'other'));
  assert.equal(acquire(context(path.join(base, 'other')), owner('second')).status, 'LOCK_BUSY');
  assert.throws(() => release(c, 'second'), /LOCK_NOT_OWNED/);
  assert.equal(fs.readFileSync(path.join(c.lock, 'owner.json'), 'utf8'), before);
  release(c, 'first');
  assert.equal(acquire(c, owner('second')).status, 'ACQUIRED');
});
test('incomplete or ancient lock remains occupied; no timeout reclamation', t => {
  const { c } = fixture(t); fs.mkdirSync(c.lock, { recursive: true });
  fs.utimesSync(c.lock, new Date(0), new Date(0));
  assert.equal(acquire(c, owner()).status, 'LOCK_BUSY');
  assert.ok(fs.existsSync(c.lock));
});
test('dirty recovery binds issue, worktree, HEAD, index and untracked bytes', t => {
  const { c, git } = fixture(t); acquire(c, owner());
  fs.writeFileSync(path.join(c.root, 'file.txt'), 'ours');
  fs.writeFileSync(path.join(c.root, 'new.txt'), 'ours');
  assert.equal(recovery(c, 9).status, 'FOREIGN_DIRTY');
  saveCheckpoint(c, 'first', { issue_number: 9, phase: 'implementing', next_step: 'test' });
  release(c, 'first'); acquire(c, owner('next'));
  assert.equal(recovery(c, 9).status, 'CHECKPOINT_MATCH');
  assert.equal(recovery(c, 10).status, 'OTHER_TASK_CHECKPOINT');
  fs.writeFileSync(path.join(c.root, 'new.txt'), 'foreign');
  assert.equal(recovery(c, 9).status, 'CHECKPOINT_DIVERGED');
  fs.writeFileSync(path.join(c.root, 'new.txt'), 'ours'); git('add', 'file.txt');
  assert.equal(recovery(c, 9).status, 'CHECKPOINT_DIVERGED');
});
test('pause marker prevents acquisition; checkpoints require ownership', t => {
  const { c } = fixture(t); fs.mkdirSync(c.base, { recursive: true }); fs.writeFileSync(path.join(c.base, 'PAUSED'), 'user pause');
  assert.equal(acquire(c, owner()).status, 'USER_PAUSED');
  assert.throws(() => saveCheckpoint(c, 'not-owner', { issue_number: 9, phase: 'x', next_step: 'x' }));
});
test('bootstrap handoff allows a new gated task only with clean workspace', t => {
  const { c } = fixture(t); acquire(c, { ...owner(), issue_number: 8 });
  saveCheckpoint(c, 'first', { issue_number: 8, phase: 'bootstrap_handoff', next_step: 'configuration review' });
  assert.equal(recovery(c, 9).status, 'CLEAN_AFTER_HANDOFF');
  fs.writeFileSync(path.join(c.root, 'file.txt'), 'foreign');
  assert.equal(recovery(c, 9).status, 'OTHER_TASK_CHECKPOINT');
});
function issue(number, priority = 'P1', labels = ['queue:codex', 'status:ready']) {
  return { number, state: 'open', labels, created_at: `2026-09-${String(number).padStart(2, '0')}T00:00:00Z`,
    updated_at: '2026-09-12T00:00:00Z', body: `- execution_kind: queue_task\n- priority: ${priority}\n- task_version: 1\n` };
}
test('queue excludes bootstrap, blocked, closed, PRs, conflicting labels and malformed metadata', () => {
  const input = [issue(8), issue(9, 'P1', ['queue:codex', 'status:blocked']),
    { ...issue(10), state: 'closed' }, { ...issue(11), pull_request: {} },
    issue(12, 'P0', ['queue:codex', 'status:ready', 'status:blocked']),
    { ...issue(13), body: 'future roadmap' }];
  assert.deepEqual(queueCandidates(input), []);
  assert.deepEqual(queueCandidates([]), []);
});
test('queue sorts priority then creation; specification hash changes on edit', () => {
  assert.deepEqual(queueCandidates([issue(12), issue(11), issue(13, 'P0')]).map(x => x.issue_number), [13, 11, 12]);
  assert.notEqual(issueStamp(issue(9)).body_sha256, issueStamp({ ...issue(9), body: issue(9).body + 'edit' }).body_sha256);
  assert.throws(() => issueStamp({ ...issue(9), body: 'missing version' }), /TASK_VERSION_MISSING/);
});

function inbox(c, tasks = [issue(9)]) {
  fs.mkdirSync(c.base, { recursive: true });
  const data = { schema: 'MFV:INBOX:v1', repo: 'He1met/market-forecast-viewer', sync_id: 'fixture',
    synced_at: new Date(Date.now() - 1000).toISOString(), expires_at: new Date(Date.now() + 3600000).toISOString(),
    issues: tasks, reviews: [], releases: tasks.map(task => ({ ...issueStamp(task), approved: true,
      dependencies_satisfied: true, branch: 'feat/chart-mvp', scope: 'chart-mvp-comprehensibility',
      review_id: 'fixture-only', source_comment_url: 'https://github.com/example/fixture', gate: 'configuration_ready' })) };
  const write = () => fs.writeFileSync(path.join(c.base, 'inbox.json'), JSON.stringify(data));
  write(); return { data, write };
}
test('local inbox fails closed for missing sync, expired sync, blocked tasks and altered released bytes', t => {
  const { c } = fixture(t);
  assert.equal(localQueue(c).status, 'WAITING_LOCAL_SYNC');
  const { data, write } = inbox(c);
  assert.equal(localQueue(c).status, 'LOCAL_READY');
  data.issues[0].body += 'edited'; write(); assert.equal(localQueue(c).status, 'EMPTY_QUEUE');
  data.issues[0] = issue(9, 'P1', ['queue:codex', 'status:blocked']); write();
  assert.equal(localQueue(c).status, 'EMPTY_QUEUE');
  data.expires_at = '2000-01-01T00:00:00Z'; write(); assert.equal(localQueue(c).status, 'INVALID_OR_EXPIRED_INBOX');
});
test('local claim binds one task, resumes exact checkpoint and waits at handoff with durable receipt', t => {
  const { c } = fixture(t); inbox(c, [issue(9), issue(10)]);
  acquire(c, { ...owner(), issue_number: 0 });
  assert.equal(claim(c, 'first').status, 'CLAIMED');
  assert.throws(() => claim(c, 'first'), /ONE_ISSUE_PER_RUN/);
  fs.writeFileSync(path.join(c.root, 'file.txt'), 'approved fixture edit');
  const saved = receipt(c, 'first', { issue_number: 9, phase: 'implementing', tests: [], next_step: 'test' });
  assert.equal(JSON.parse(fs.readFileSync(saved.file)).github_write, false);
  assert.equal(saved.receipt.task_version, 1);
  release(c, 'first'); acquire(c, { ...owner('next'), issue_number: 0 });
  assert.equal(claim(c, 'next').status, 'RESUMED');
  receipt(c, 'next', { issue_number: 9, phase: 'awaiting_handoff', tests: [{ command: 'fixture assertion', result: 'pass' }], next_step: 'interactive review/commit' });
  release(c, 'next'); acquire(c, { ...owner('later'), issue_number: 0 });
  assert.equal(claim(c, 'later').status, 'WAITING_INTERACTIVE_HANDOFF');
});
test('legacy lock blocks migration; foreign dirty workspace blocks a locally released task', t => {
  const { c } = fixture(t); fs.mkdirSync(c.legacyLock, { recursive: true });
  assert.equal(acquire(c, owner()).status, 'LEGACY_LOCK_BUSY'); fs.rmdirSync(c.legacyLock);
  inbox(c); acquire(c, { ...owner(), issue_number: 0 });
  fs.writeFileSync(path.join(c.root, 'file.txt'), 'unknown writer');
  assert.equal(claim(c, 'first').status, 'FOREIGN_DIRTY');
});

function onlineFixture() {
  const task = { ...issue(9), user: { id: 1 }, issue_dependencies_summary: { blocked_by: 0 } };
  const gate = { id: 2, user: { id: 1 }, state: 'COMMENTED', body: 'fixture approved pilot',
    commit_id: 'base', submitted_at: '2026-09-12T00:00:00Z', html_url: 'review/2' };
  const pr = { state: 'open', head: { ref: 'feat/chart-mvp', sha: 'head', repo: { full_name: 'He1met/market-forecast-viewer' } } };
  const approval = { issue: 9, version: 1, author: 1, body: sha(task.body), review: 2, reviewBody: sha(gate.body), head: 'base' };
  const comments = [];
  const get = endpoint => endpoint.startsWith('issues?') ? [task]
    : endpoint === 'issues/9' ? [task]
    : endpoint.startsWith('pulls/7/reviews') ? [gate]
    : endpoint === 'pulls/7' ? [pr] : comments;
  return { task, gate, approval, get, comments };
}
test('online sync admits verified pilot, deduplicates reviews, rejects forged gate and changed task', t => {
  const { c } = fixture(t); acquire(c, owner()); const x = onlineFixture();
  assert.equal(syncInbox(c, 'first', x.get, x.approval).gate_result, 'PILOT_READY');
  x.comments.push({ id: 3, html_url: 'comment/3', body: 'plain comment' });
  assert.equal(syncInbox(c, 'first', x.get, x.approval).review_count, 2);
  x.gate.user.id = 7;
  assert.equal(syncInbox(c, 'first', x.get, x.approval).candidates.length, 0);
  x.gate.user.id = 1; x.task.body += 'new scope';
  assert.equal(syncInbox(c, 'first', x.get, x.approval).candidates.length, 0);
});
test('failed or inconsistent online sync invalidates old ready; scheduled claim requires same-run sync', t => {
  const { c } = fixture(t); inbox(c); acquire(c, { ...owner(), issue_number: 0, trigger: 'scheduled' });
  assert.equal(claim(c, 'first').status, 'FRESH_SYNC_REQUIRED');
  assert.throws(() => syncInbox(c, 'first', () => { throw Error('network down'); }), /network down/);
  assert.equal(localQueue(c).status, 'INVALID_OR_EXPIRED_INBOX');
  const x = onlineFixture();
  assert.throws(() => syncInbox(c, 'first', endpoint => endpoint === 'issues/9'
    ? [{ ...x.task, updated_at: 'changed' }] : x.get(endpoint), x.approval), /REMOTE_CHANGED/);
  assert.equal(localQueue(c).candidates.length, 0);
});
test('newer supervisor decision and unsatisfied dependencies prevent stale approval reuse', t => {
  const { c } = fixture(t); acquire(c, owner()); const x = onlineFixture();
  x.task.issue_dependencies_summary.blocked_by = 1;
  assert.equal(syncInbox(c, 'first', x.get, x.approval).candidates.length, 0);
  x.task.issue_dependencies_summary.blocked_by = 0;
  x.comments.push({ user: { id: 1 }, html_url: 'comment/4', updated_at: '2026-09-13T00:00:00Z',
    body: '<!-- MFV:SUPERVISOR:v1 -->\n- issue_number: `9`\n- status: STOP' });
  assert.equal(syncInbox(c, 'first', x.get, x.approval).candidates.length, 0);
});
