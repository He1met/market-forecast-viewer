import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { context, acquire, release, saveCheckpoint, recovery, queueCandidates, issueStamp, localQueue, claim, receipt, syncInbox, verifyRelease, remoteDigest, sha } from '../scripts/executor.mjs';

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
  const input = [{ ...issue(8), body: '- execution_kind: bootstrap\n- task_version: 1\n' }, issue(9, 'P1', ['queue:codex', 'status:blocked']),
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
    sync_run_id: 'fixture-run', remote_head_sha: 'fixture-head',
    issues: tasks, reviews: [{ user: { id: 65616876 }, html_url: 'fixture/source', body: 'fixture only' }], releases: [] };
  data.remote_snapshot_sha256 = remoteDigest(data);
  data.releases = tasks.map(task => {
    const evidence = { ...issueStamp(task), run_id: data.sync_run_id, sync_id: data.sync_id,
      remote_snapshot_sha256: data.remote_snapshot_sha256, scope: 'project-development',
      review_id: 'fixture-only', source_comment_url: 'fixture/source', source_body_sha256: sha('fixture only') };
    const evidence_sha256 = sha(JSON.stringify(evidence));
    fs.writeFileSync(path.join(c.base, `release-review-${evidence_sha256}.json`), JSON.stringify(evidence));
    return { ...evidence, approved: true, dependencies_satisfied: true, branch: 'feat/chart-mvp', evidence_sha256 };
  });
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
  assert.equal(claim(c, 'later').status, 'AWAITING_HANDOFF');
});
test('legacy lock blocks migration; foreign dirty workspace blocks a locally released task', t => {
  const { c } = fixture(t); fs.mkdirSync(c.legacyLock, { recursive: true });
  assert.equal(acquire(c, owner()).status, 'LEGACY_LOCK_BUSY'); fs.rmdirSync(c.legacyLock);
  inbox(c); acquire(c, { ...owner(), issue_number: 0 });
  fs.writeFileSync(path.join(c.root, 'file.txt'), 'unknown writer');
  assert.equal(claim(c, 'first').status, 'FOREIGN_DIRTY');
});

function onlineFixture(number = 11) {
  const task = { ...issue(number), user: { id: 65616876 }, issue_dependencies_summary: { blocked_by: 0 } };
  const gate = { id: 2, user: { id: 65616876 }, state: 'COMMENTED',
    body: '<!-- MFV:SUPERVISOR:v1 -->\n- review_id: fixture-approved\nOnly the described task is approved.',
    commit_id: 'base', submitted_at: '2026-09-12T00:00:00Z', html_url: 'review/2' };
  const pr = { state: 'open', base: { ref: 'main' }, head: { ref: 'feat/chart-mvp', sha: 'head', repo: { full_name: 'He1met/market-forecast-viewer' } } };
  const tasks = [task];
  const comments = [];
  const get = endpoint => endpoint.startsWith('issues?') ? tasks
    : endpoint.startsWith('pulls/7/reviews') ? [gate]
    : endpoint === 'pulls/7' ? [pr] : comments;
  const evidence = c => {
    const i = JSON.parse(fs.readFileSync(path.join(c.base, 'inbox.json')));
    return { schema: 'MFV:RELEASE_REVIEW:v1', ...issueStamp(task), sync_id: i.sync_id,
      remote_snapshot_sha256: i.remote_snapshot_sha256, decision: 'approved', scope: 'project-development',
      review_id: 'fixture-approved', source_comment_url: gate.html_url, source_body_sha256: sha(gate.body),
      checks: Object.fromEntries(['scope', 'release', 'dependencies', 'latest_decisions'].map(k =>
        [k, { passed: true, reason: `Fixture-only ${k} verification` }])) };
  };
  return { task, tasks, gate, pr, get, comments, evidence };
}
test('sync only collects evidence; reviewed development task is admitted without pilot or phase IDs', t => {
  const { c } = fixture(t); acquire(c, owner()); const x = onlineFixture();
  assert.equal(syncInbox(c, 'first', x.get).gate_result, 'REQUIRES_EVIDENCE_REVIEW');
  assert.equal(localQueue(c).candidates.length, 0);
  assert.deepEqual(verifyRelease(c, 'first', x.evidence(c), x.get).candidates.map(x => x.issue_number), [11]);
  x.comments.push({ id: 3, html_url: 'comment/3', body: 'plain comment' });
  assert.equal(syncInbox(c, 'first', x.get).review_count, 2);
  // Another stage/number uses exactly the same code and full evidence review.
  x.task.number = 42; x.task.body += '- phase: FUTURE\n';
  syncInbox(c, 'first', x.get);
  assert.deepEqual(verifyRelease(c, 'first', x.evidence(c), x.get).candidates.map(x => x.issue_number), [42]);
});

test('explicit new PR binding survives merged baseline and gates release and local branch', t => {
  const { c, git } = fixture(t); acquire(c, { ...owner(), issue_number: 0 });
  const x = onlineFixture(); Object.assign(x.pr, { state: 'closed', merged_at: '2026-09-16T08:06:42Z', merge_commit_sha: 'a'.repeat(40) });
  const delivery = { pr_number: 16, branch: 'chore/15-policy' };
  const pr = { state: 'open', base: { ref: 'main' }, head: { ref: delivery.branch, sha: 'new-head', repo: { full_name: 'He1met/market-forecast-viewer' } } };
  const get = endpoint => endpoint === 'pulls/16' ? [pr]
    : endpoint.startsWith('pulls/16/reviews') ? [] : x.get(endpoint);
  assert.equal(syncInbox(c, 'first', get).gate_result, 'MERGED_DELIVERY_READ_ONLY');
  syncInbox(c, 'first', get, delivery);
  assert.deepEqual(verifyRelease(c, 'first', x.evidence(c), get).candidates.map(v => v.issue_number), [11]);
  assert.throws(() => claim(c, 'first'), /WRONG_BRANCH/);
  git('checkout', '-b', delivery.branch);
  assert.equal(claim(c, 'first').status, 'CLAIMED');
  assert.deepEqual(JSON.parse(fs.readFileSync(c.state)).delivery, { ...delivery, state: 'open', merge_commit_sha: null });
  syncInbox(c, 'first', get); // Uses persisted delivery, never old PR7.
  const evidence = x.evidence(c); pr.head.sha = 'changed-head';
  assert.throws(() => verifyRelease(c, 'first', evidence, get), /REMOTE_CHANGED/);
  assert.equal(localQueue(c).status, 'INVALID_OR_EXPIRED_INBOX');
});

test('delivery rejects invalid IDs, closed or foreign PRs, wrong branch and wrong base', t => {
  const { c } = fixture(t); acquire(c, owner()); const x = onlineFixture();
  for (const delivery of [{ pr_number: 0, branch: 'feat/chart-mvp' }, { pr_number: 7, branch: 'main' }, { pr_number: 7, branch: '../bad' }]) {
    assert.throws(() => syncInbox(c, 'first', x.get, delivery), /INVALID_DELIVERY_BINDING/);
    assert.equal(localQueue(c).status, 'INVALID_OR_EXPIRED_INBOX');
  }
  for (const mutate of [() => { x.pr.state = 'closed'; }, () => { x.pr.head.ref = 'other'; },
    () => { x.pr.base.ref = 'other'; }, () => { x.pr.head.repo.full_name = 'foreign/repo'; }]) {
    x.pr.state = 'open'; x.pr.head.ref = 'feat/chart-mvp'; x.pr.base.ref = 'main'; x.pr.head.repo.full_name = 'He1met/market-forecast-viewer';
    mutate(); assert.throws(() => syncInbox(c, 'first', x.get), /WRONG_REMOTE_BASELINE/);
  }
});

test('merged delivery sync remains read-only and cannot release or claim new tasks', t => {
  const { c } = fixture(t); acquire(c, { ...owner(), issue_number: 0 }); const x = onlineFixture();
  syncInbox(c, 'first', x.get); verifyRelease(c, 'first', x.evidence(c), x.get);
  x.pr.state = 'closed'; x.pr.merged_at = '2026-09-16T08:06:42Z'; x.pr.merge_commit_sha = 'a'.repeat(40);
  assert.equal(syncInbox(c, 'first', x.get).gate_result, 'MERGED_DELIVERY_READ_ONLY');
  const first = JSON.parse(fs.readFileSync(path.join(c.base, 'inbox.json')));
  syncInbox(c, 'first', x.get);
  const second = JSON.parse(fs.readFileSync(path.join(c.base, 'inbox.json')));
  assert.equal(second.remote_snapshot_sha256, first.remote_snapshot_sha256);
  assert.equal(second.delivery.merge_commit_sha, 'a'.repeat(40));
  assert.deepEqual(second.releases, []);
  assert.equal(localQueue(c).candidates.length, 0);
  assert.equal(claim(c, 'first').status, 'MERGED_DELIVERY_READ_ONLY');
  const pending = { ...issueStamp(x.task), phase: 'implementing', next_step: 'fixture' };
  fs.writeFileSync(c.state, JSON.stringify(pending));
  const bytes = fs.readFileSync(c.state, 'utf8');
  assert.equal(claim(c, 'first').status, 'MERGED_DELIVERY_READ_ONLY');
  assert.equal(fs.readFileSync(c.state, 'utf8'), bytes);
  assert.throws(() => verifyRelease(c, 'first', x.evidence(c), x.get), /DELIVERY_NOT_OPEN/);
  assert.equal(localQueue(c).status, 'INVALID_OR_EXPIRED_INBOX');
  delete x.pr.merge_commit_sha;
  assert.throws(() => syncInbox(c, 'first', x.get), /WRONG_REMOTE_BASELINE/);
});

test('inconsistent merge identities and merge during double-read invalidate snapshots', t => {
  const { c } = fixture(t); acquire(c, owner()); const x = onlineFixture();
  x.pr.state = 'closed'; x.pr.merged_at = '2026-09-16T08:06:42Z'; x.pr.merge_commit_sha = 'a'.repeat(40);
  for (const patch of [{ merged: false }, { merged_at: 'invalid' }, { merge_commit_sha: 'abc' }, { state: 'open', merged: true }]) {
    const before = structuredClone(x.pr);Object.assign(x.pr, patch);
    assert.throws(() => syncInbox(c, 'first', x.get), /WRONG_REMOTE_BASELINE/);
    Object.assign(x.pr, before);delete x.pr.merged;
  }
  x.pr.state = 'open';delete x.pr.merged_at;delete x.pr.merge_commit_sha;
  let reads = 0;
  const get = endpoint => {
    if (endpoint === 'pulls/7' && ++reads === 2) Object.assign(x.pr, { state: 'closed', merged_at: '2026-09-16T08:06:42Z', merge_commit_sha: 'a'.repeat(40) });
    return x.get(endpoint);
  };
  assert.throws(() => syncInbox(c, 'first', get), /REMOTE_CHANGED_DURING_SYNC/);
  assert.equal(localQueue(c).status, 'INVALID_OR_EXPIRED_INBOX');
  reads = 0;
  assert.throws(() => syncInbox(c, 'first', endpoint => {
    if(endpoint === 'pulls/7' && ++reads === 2)x.pr.merge_commit_sha='b'.repeat(40);
    return x.get(endpoint);
  }), /REMOTE_CHANGED_DURING_SYNC/);
});
test('failed or inconsistent online sync invalidates old ready; scheduled claim requires same-run sync', t => {
  const { c } = fixture(t); inbox(c); acquire(c, { ...owner(), issue_number: 0, trigger: 'scheduled' });
  assert.equal(claim(c, 'first').status, 'FRESH_SYNC_REQUIRED');
  assert.throws(() => syncInbox(c, 'first', () => { throw Error('network down'); }), /network down/);
  assert.equal(localQueue(c).status, 'INVALID_OR_EXPIRED_INBOX');
  const x = onlineFixture();
  let reads = 0;
  assert.throws(() => syncInbox(c, 'first', endpoint => endpoint.startsWith('issues?') && ++reads > 1
    ? [{ ...x.task, updated_at: 'changed' }] : x.get(endpoint)), /REMOTE_CHANGED/);
  assert.equal(localQueue(c).candidates.length, 0);
});
test('source identity, reviewed version, dependency semantics and real blocked_by are required', t => {
  const { c } = fixture(t); acquire(c, owner()); const x = onlineFixture();
  x.gate.user.id = 7; syncInbox(c, 'first', x.get);
  assert.throws(() => verifyRelease(c, 'first', x.evidence(c), x.get), /UNTRUSTED_RELEASE_SOURCE/);
  x.gate.user.id = 65616876; syncInbox(c, 'first', x.get);
  const stale = x.evidence(c); stale.task_version = 2;
  assert.throws(() => verifyRelease(c, 'first', stale, x.get), /TASK_NOT_ELIGIBLE/);
  syncInbox(c, 'first', x.get);
  const dependencies = x.evidence(c); dependencies.checks.dependencies.passed = false;
  assert.throws(() => verifyRelease(c, 'first', dependencies, x.get), /SEMANTIC_REVIEW_REQUIRED/);
  syncInbox(c, 'first', x.get);
  const scope = x.evidence(c); scope.scope = 'arbitrary-account-actions';
  assert.throws(() => verifyRelease(c, 'first', scope, x.get), /INVALID_RELEASE_REVIEW/);
  x.task.issue_dependencies_summary.blocked_by = 1;
  syncInbox(c, 'first', x.get);
  assert.throws(() => verifyRelease(c, 'first', x.evidence(c), x.get), /TASK_NOT_ELIGIBLE/);
});

test('new veto, changed parent, remote head or failed verification invalidate all old ready', t => {
  const { c } = fixture(t); acquire(c, owner()); const x = onlineFixture();
  const parent = { ...issue(10), body: 'stage definition', labels: [], state: 'closed' };
  x.task.body += 'Parent #10'; x.tasks.push(parent);
  for (const mutate of [() => x.comments.push({ html_url: 'new/veto', body: 'STOP', user: { id: 65616876 } }),
    () => { parent.body += ' changed'; }, () => { x.pr.head.sha += 'x'; }]) {
    syncInbox(c, 'first', x.get); const evidence = x.evidence(c); mutate();
    assert.throws(() => verifyRelease(c, 'first', evidence, x.get), /REMOTE_CHANGED/);
    assert.equal(localQueue(c).status, 'INVALID_OR_EXPIRED_INBOX');
  }
  syncInbox(c, 'first', x.get); const evidence = x.evidence(c);
  assert.throws(() => verifyRelease(c, 'first', evidence, () => { throw Error('network down'); }), /network down/);
  assert.equal(localQueue(c).candidates.length, 0);
});

test('acknowledged tasks are not reclaimed, including after another task becomes the checkpoint', t => {
  const { c } = fixture(t); acquire(c, owner());
  // A real legacy checkpoint predates acknowledged.json. Do not create it via the new helper.
  fs.writeFileSync(c.state, JSON.stringify({ ...issueStamp(issue(9)), phase: 'acknowledged', next_step: 'next task' }));
  assert.equal(fs.existsSync(path.join(c.base, 'acknowledged.json')), false);
  release(c, 'first'); acquire(c, { ...owner('next'), issue_number: 0 });
  inbox(c, [issue(9), issue(11)]);
  assert.equal(claim(c, 'next').checkpoint.issue_number, 11);
  assert.throws(() => claim(c, 'next'), /ONE_ISSUE_PER_RUN/);
  saveCheckpoint(c, 'next', { ...issueStamp(issue(11)), phase: 'acknowledged', next_step: 'next task' });
  release(c, 'next'); acquire(c, { ...owner('later'), issue_number: 0 });
  inbox(c, [issue(9), issue(11)]);
  assert.equal(claim(c, 'later').status, 'EMPTY_QUEUE');
});

test('repository comments include closed numeric prerequisites and failed re-review invalidates ready', t => {
  const { c } = fixture(t); acquire(c, owner()); const x = onlineFixture(42);
  x.task.body += '- parent_issue: 10\n- depends_on: 20\n';
  x.tasks.push({ ...issue(10), state: 'closed' }, { ...issue(20), state: 'closed' });
  x.comments.push({ id: 30, html_url: 'closed/20/comment/30', body: 'dependency review', user: { id: 65616876 } });
  const endpoints = [];
  const get = endpoint => { endpoints.push(endpoint); return x.get(endpoint); };
  syncInbox(c, 'first', get);
  assert.ok(endpoints.includes('issues/comments?per_page=100'));
  assert.ok(JSON.parse(fs.readFileSync(path.join(c.base, 'inbox.json'))).reviews.some(r => r.id === 30));
  const evidence = x.evidence(c); verifyRelease(c, 'first', evidence, get);
  assert.equal(localQueue(c).status, 'LOCAL_READY');
  evidence.checks.dependencies.passed = false;
  assert.throws(() => verifyRelease(c, 'first', evidence, get), /SEMANTIC_REVIEW_REQUIRED/);
  assert.equal(localQueue(c).status, 'INVALID_OR_EXPIRED_INBOX');
});

test('release proof tampering or another run sync cannot authorize a scheduled claim', t => {
  const { c } = fixture(t); acquire(c, { ...owner(), issue_number: 0, trigger: 'scheduled' });
  const x = onlineFixture(); syncInbox(c, 'first', x.get);
  const verified = verifyRelease(c, 'first', x.evidence(c), x.get);
  assert.equal(localQueue(c).status, 'LOCAL_READY');
  fs.appendFileSync(verified.evidence_path, ' '); // JSON whitespace does not change reviewed semantic bytes.
  const proof = JSON.parse(fs.readFileSync(verified.evidence_path)); proof.decision = 'denied';
  fs.writeFileSync(verified.evidence_path, JSON.stringify(proof));
  assert.equal(localQueue(c).status, 'EMPTY_QUEUE');
  release(c, 'first'); acquire(c, { ...owner('next'), issue_number: 0, trigger: 'scheduled' });
  assert.equal(claim(c, 'next').status, 'FRESH_SYNC_REQUIRED');
});
