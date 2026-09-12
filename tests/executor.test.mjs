import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { context, acquire, release, saveCheckpoint, recovery, queueCandidates, issueStamp } from '../scripts/executor.mjs';

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mfv-w0-test-'));
  const root = path.join(base, 'repo'); fs.mkdirSync(root);
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(root, 'file.txt'), 'baseline'); git('add', '.'); git('commit', '-m', 'fixture');
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
  const { c } = fixture(t); fs.mkdirSync(c.base); fs.writeFileSync(path.join(c.base, 'PAUSED'), 'user pause');
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
