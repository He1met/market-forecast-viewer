// W0 helpers only. The official Codex task interprets AGENTS and executes Issues.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const sha = value => createHash('sha256').update(value).digest('hex');
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
const atomic = (file, data) => {
  const tmp = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  fs.renameSync(tmp, file);
};

export function context(cwd = process.cwd()) {
  const root = git(cwd, 'rev-parse', '--show-toplevel').trim();
  const common = git(cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir').trim();
  const canonical = git(cwd, 'worktree', 'list', '--porcelain', '-z').split('\0')[0].slice('worktree '.length);
  const base = path.join(canonical, 'artifacts', 'executor');
  return { root, canonical, base, legacyLock: path.join(common, 'mfv-executor', 'writer.lock'),
    lock: path.join(base, 'writer.lock'), state: path.join(base, 'checkpoint.json') };
}

export function snapshot(c) {
  const status = git(c.root, 'status', '--porcelain=v1', '-z', '--untracked-files=all');
  const names = new Set([
    ...git(c.root, 'diff', '--name-only', '-z', 'HEAD').split('\0'),
    ...git(c.root, 'ls-files', '--others', '--exclude-standard', '-z').split('\0'),
  ].filter(Boolean));
  const files = [...names].sort().map(name => {
    const file = path.join(c.root, name);
    let digest;
    try {
      const stat = fs.lstatSync(file);
      digest = stat.isSymbolicLink() ? sha(fs.readlinkSync(file)) : sha(fs.readFileSync(file));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      digest = 'DELETED';
    }
    return [name, digest];
  });
  return {
    head_sha: git(c.root, 'rev-parse', 'HEAD').trim(),
    branch: git(c.root, 'branch', '--show-current').trim(),
    clean: status === '',
    fingerprint: sha(JSON.stringify({ status, files,
      staged: sha(git(c.root, 'diff', '--cached', '--binary')),
      unstaged: sha(git(c.root, 'diff', '--binary')) })),
  };
}

export function owned(c, runId) {
  const owner = json(path.join(c.lock, 'owner.json'));
  if (!runId || owner.run_id !== runId) throw Error('LOCK_NOT_OWNED');
  return owner;
}

export function acquire(c, owner) {
  if (!owner.run_id || !owner.thread_id || !Number.isSafeInteger(owner.issue_number)
    || !['manual_setup', 'manual', 'scheduled'].includes(owner.trigger)) throw Error('INVALID_OWNER');
  if (fs.existsSync(c.legacyLock)) return { status: 'LEGACY_LOCK_BUSY' };
  fs.mkdirSync(c.base, { recursive: true });
  if (fs.existsSync(path.join(c.base, 'PAUSED'))) return { status: 'USER_PAUSED' };
  try { fs.mkdirSync(c.lock); } catch (error) {
    if (error.code === 'EEXIST') return { status: 'LOCK_BUSY' };
    throw error;
  }
  // If this write is interrupted, keep the incomplete lock; never infer expiry.
  fs.writeFileSync(path.join(c.lock, 'owner.json'), JSON.stringify({ ...owner,
    host: os.hostname(), acquired_at: new Date().toISOString() }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { status: 'ACQUIRED' };
}

export function saveCheckpoint(c, runId, data) {
  const owner = owned(c, runId);
  if (data.issue_number !== owner.issue_number || !data.next_step || !data.phase) throw Error('INVALID_CHECKPOINT');
  const state = { ...data, run_id: runId, thread_id: owner.thread_id,
    saved_at: new Date().toISOString(), worktree: fs.realpathSync(c.root), snapshot: snapshot(c) };
  atomic(c.state, state);
  return state;
}

export function recovery(c, issueNumber) {
  const current = snapshot(c);
  if (!fs.existsSync(c.state)) return { status: current.clean ? 'CLEAN' : 'FOREIGN_DIRTY' };
  const previous = json(c.state);
  if (['bootstrap_handoff', 'acknowledged'].includes(previous.phase)
    && previous.issue_number !== issueNumber && current.clean) {
    return { status: 'CLEAN_AFTER_HANDOFF', checkpoint: previous };
  }
  if (previous.issue_number !== issueNumber || previous.worktree !== fs.realpathSync(c.root)) {
    return { status: 'OTHER_TASK_CHECKPOINT' };
  }
  const same = JSON.stringify(current) === JSON.stringify(previous.snapshot);
  return { status: same ? 'CHECKPOINT_MATCH' : 'CHECKPOINT_DIVERGED', checkpoint: previous };
}

export function release(c, runId) {
  owned(c, runId);
  // Refuse unexpected entries. Never recursive-delete a lock or user data.
  if (fs.readdirSync(c.lock).sort().join(',') !== 'owner.json') throw Error('LOCK_CONTENTS_CHANGED');
  fs.unlinkSync(path.join(c.lock, 'owner.json'));
  fs.rmdirSync(c.lock);
  return { status: 'RELEASED' };
}

export function issueStamp(issue) {
  const version = issue.body.match(/^\s*-?\s*task_version:\s*(\d+)\s*$/m)?.[1];
  if (!version) throw Error('TASK_VERSION_MISSING');
  return { issue_number: issue.number, task_version: Number(version),
    updated_at: issue.updated_at, body_sha256: sha(issue.body) };
}

export function queueCandidates(issues) {
  const result = [];
  for (const issue of issues) {
    const labels = issue.labels.map(label => typeof label === 'string' ? label : label.name);
    if (issue.pull_request || issue.state !== 'open' || issue.number === 8
      || !labels.includes('queue:codex') || !labels.includes('status:ready')
      || labels.filter(label => label.startsWith('status:')).length !== 1
      || !/^\s*-?\s*execution_kind:\s*queue_task\s*$/m.test(issue.body)) continue;
    const priority = issue.body.match(/^\s*-?\s*priority:\s*(P[012])\s*$/m)?.[1];
    if (!priority) continue;
    try { result.push({ ...issueStamp(issue), priority, created_at: issue.created_at }); }
    catch { /* malformed task is ineligible, never infer a version */ }
  }
  return result.sort((a, b) => a.priority.localeCompare(b.priority)
    || a.created_at.localeCompare(b.created_at) || a.issue_number - b.issue_number);
}

// Only the currently reviewed pilot is mechanically admitted. Unknown scope/version
// remains visible in issues, but must not inherit this pilot's approval.
export const pilotApproval = Object.freeze({ issue: 9, version: 1, author: 65616876,
  body: 'f74c22b5823d3d8d242b45a5f1596a94ebf0b6a74f669454787310c97c555ee4',
  review: 5187124672, reviewBody: '9ca248f2aed9a97bb230e347d5c8432e30565335e6e3cdec91f9d9d2f85c6f90',
  head: 'b40967d425bf5e461ff72f034cc1624bae16aae2' });
const repo = 'He1met/market-forecast-viewer';
const github = endpoint => JSON.parse(execFileSync('gh', ['api', '--paginate', '--slurp',
  `repos/${repo}/${endpoint}`], { encoding: 'utf8', timeout: 60000, maxBuffer: 16 * 1024 * 1024 })).flat();

export function syncInbox(c, runId, get = github, approval = pilotApproval) {
  owned(c, runId);
  const file = path.join(c.base, 'inbox.json');
  // Invalidate before network I/O: crashes and failed refreshes cannot reuse ready.
  atomic(file, { schema: 'MFV:INBOX:v1', sync_status: 'SYNCING', releases: [] });
  try {
    const issues = get('issues?state=all&per_page=100').filter(x => !x.pull_request);
    const comments = get('issues/7/comments?per_page=100');
    const reviews = get('pulls/7/reviews?per_page=100');
    for (const number of new Set([8, 9, ...queueCandidates(issues).map(x => x.issue_number)])) {
      comments.push(...get(`issues/${number}/comments?per_page=100`));
    }
    const pr = get('pulls/7')[0];
    const unique = [...new Map([...comments, ...reviews].map(x => [x.html_url, x])).values()];
    const task = issues.find(x => x.number === approval.issue);
    const gate = reviews.find(x => x.id === approval.review);
    const trustedGate = gate?.user?.id === approval.author && gate.state === 'COMMENTED'
      && sha(gate.body) === approval.reviewBody && gate.commit_id === approval.head;
    // Any newer supervisor decision touching this pilot/config requires re-evaluation,
    // rather than allowing an older approval to override it.
    const newerDecision = unique.some(x => x.user?.id === approval.author
      && Date.parse(x.submitted_at || x.updated_at) > Date.parse(gate?.submitted_at)
      && x.body?.includes('MFV:SUPERVISOR:v1') && /issue_number:\s*`?(8|9)\b/.test(x.body));
    const eligible = queueCandidates(issues).some(x => x.issue_number === 9)
      && task?.user?.id === approval.author && sha(task.body) === approval.body
      && issueStamp(task).task_version === approval.version && trustedGate && !newerDecision
      && task.issue_dependencies_summary?.blocked_by === 0
      && pr?.state === 'open' && pr.head?.ref === 'feat/chart-mvp'
      && pr.head?.repo?.full_name === repo;
    // Double-read live task/review/PR: reject changes during the multi-request snapshot.
    const again = get('issues/9')[0], againGate = get(`pulls/7/reviews/${approval.review}`)[0];
    const againPr = get('pulls/7')[0];
    if (JSON.stringify(again) !== JSON.stringify(task) || JSON.stringify(againGate) !== JSON.stringify(gate)
      || againPr.head?.sha !== pr.head?.sha) throw Error('REMOTE_CHANGED_DURING_SYNC');
    const inbox = { schema: 'MFV:INBOX:v1', repo, sync_status: 'OK', sync_run_id: runId,
      sync_id: randomUUID(), synced_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(), issues,
      reviews: unique, remote_head_sha: pr.head.sha,
      releases: eligible ? [{ ...issueStamp(task), approved: true, dependencies_satisfied: true,
        branch: 'feat/chart-mvp', scope: 'chart-mvp-comprehensibility', gate: 'configuration_ready',
        review_id: 'MFV-SUP-W0-CONFIG-READY-20260913-01', source_comment_url: gate.html_url }] : [],
      gate_result: eligible ? 'PILOT_READY' : 'REQUIRES_EVIDENCE_REVIEW' };
    atomic(file, inbox);
    return { status: 'SYNCED', gate_result: inbox.gate_result, candidates: localQueue(c).candidates,
      review_count: unique.length, remote_head_sha: pr.head.sha };
  } catch (error) {
    atomic(file, { schema: 'MFV:INBOX:v1', sync_status: 'FAILED', releases: [],
      blocker_key: 'REMOTE_SYNC_FAILED', error: error.message, failed_at: new Date().toISOString() });
    throw error;
  }
}

// Hashes bind the reviewed bytes; they are not authentication or new authorization.
export function localQueue(c, now = Date.now()) {
  const file = path.join(c.base, 'inbox.json');
  if (!fs.existsSync(file)) return { status: 'WAITING_LOCAL_SYNC', candidates: [] };
  const inbox = json(file);
  if ((inbox.sync_status && inbox.sync_status !== 'OK') || inbox.schema !== 'MFV:INBOX:v1' || inbox.repo !== 'He1met/market-forecast-viewer'
    || !Array.isArray(inbox.issues) || !Array.isArray(inbox.releases)
    || !Array.isArray(inbox.reviews) || !inbox.sync_id
    || !Number.isFinite(Date.parse(inbox.expires_at)) || Date.parse(inbox.expires_at) <= now
    || !Number.isFinite(Date.parse(inbox.synced_at)) || Date.parse(inbox.synced_at) > now) {
    return { status: 'INVALID_OR_EXPIRED_INBOX', candidates: [] };
  }
  const candidates = queueCandidates(inbox.issues).filter(task => inbox.releases.some(release =>
    release.issue_number === task.issue_number && release.task_version === task.task_version
    && release.body_sha256 === task.body_sha256 && release.updated_at === task.updated_at
    && release.approved === true && release.dependencies_satisfied === true
    && release.branch === 'feat/chart-mvp' && release.scope === 'chart-mvp-comprehensibility'
    && release.review_id && release.source_comment_url
    && (task.issue_number !== 9 || release.gate === 'configuration_ready')));
  return { status: candidates.length ? 'LOCAL_READY' : 'EMPTY_QUEUE', candidates,
    inbox_sha256: sha(fs.readFileSync(file)), inbox };
}

export function claim(c, runId) {
  const owner = owned(c, runId);
  if (owner.issue_number !== 0) throw Error('ONE_ISSUE_PER_RUN');
  if (fs.realpathSync(c.root) !== fs.realpathSync(c.canonical)) throw Error('CANONICAL_CHECKOUT_REQUIRED');
  if (snapshot(c).branch !== 'feat/chart-mvp') throw Error('WRONG_BRANCH');
  const queue = localQueue(c);
  if (!['LOCAL_READY', 'EMPTY_QUEUE'].includes(queue.status)) return { status: queue.status };
  if (owner.trigger === 'scheduled' && queue.inbox.sync_run_id !== runId) return { status: 'FRESH_SYNC_REQUIRED' };
  const previous = fs.existsSync(c.state) ? json(c.state) : null;
  const pending = previous && !['bootstrap_handoff', 'acknowledged'].includes(previous.phase);
  if (pending && ['awaiting_handoff', 'awaiting_review', 'blocked'].includes(previous.phase)) {
    return { status: 'WAITING_INTERACTIVE_HANDOFF', issue_number: previous.issue_number };
  }
  const task = pending ? queue.candidates.find(x => x.issue_number === previous.issue_number) : queue.candidates[0];
  if (!task) return { status: pending ? 'WAITING_LOCAL_RELEASE' : 'EMPTY_QUEUE' };
  const recovered = recovery(c, task.issue_number);
  if (!['CLEAN', 'CLEAN_AFTER_HANDOFF', 'CHECKPOINT_MATCH'].includes(recovered.status)) return recovered;
  if (pending && (previous.body_sha256 !== task.body_sha256 || previous.task_version !== task.task_version)) {
    return { status: 'TASK_CHANGED_REQUIRES_HANDOFF' };
  }
  atomic(path.join(c.lock, 'owner.json'), { ...owner, issue_number: task.issue_number });
  const checkpoint = saveCheckpoint(c, runId, { ...task, phase: 'claimed',
    claim_base_sha: pending ? previous.claim_base_sha : snapshot(c).head_sha,
    inbox_sha256: queue.inbox_sha256, next_step: 'Read local issue, release and reviews; implement only approved scope.' });
  return { status: pending ? 'RESUMED' : 'CLAIMED', checkpoint,
    issue: queue.inbox.issues.find(x => x.number === task.issue_number), reviews: queue.inbox.reviews };
}

export function receipt(c, runId, data) {
  const owner = owned(c, runId);
  if (data.issue_number !== owner.issue_number || !Array.isArray(data.tests)
    || !data.next_step || !['implementing', 'testing', 'blocked', 'awaiting_handoff', 'bootstrap_handoff'].includes(data.phase)) {
    throw Error('INVALID_RECEIPT');
  }
  const previous = fs.existsSync(c.state) ? json(c.state) : {};
  const checkpoint = saveCheckpoint(c, runId, { ...(previous.issue_number === owner.issue_number ? previous : {}), ...data });
  const record = { ...checkpoint, schema: 'MFV:RECEIPT:v1', trigger: owner.trigger,
    visibility: 'LOCAL_ONLY', git_write: false, github_write: false };
  const dir = path.join(c.base, 'receipts'); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sha(runId)}-${randomUUID()}.json`);
  atomic(file, record);
  return { status: 'RECEIPT_SAVED', file, receipt: record };
}

function main() {
  const [command, ...args] = process.argv.slice(2);
  const c = context();
  let result;
  if (command === 'acquire') result = acquire(c, {
    run_id: args[0], thread_id: args[1], issue_number: Number(args[2]), trigger: args[3],
  });
  else if (command === 'inspect') result = {
    locked: fs.existsSync(c.lock),
    owner: fs.existsSync(path.join(c.lock, 'owner.json')) ? json(path.join(c.lock, 'owner.json')) : null,
    paused: fs.existsSync(path.join(c.base, 'PAUSED')), snapshot: snapshot(c),
  };
  else if (command === 'bind') {
    const owner = owned(c, args[0]);
    const issue = Number(args[1]);
    if (owner.issue_number !== 0 || !Number.isSafeInteger(issue) || issue < 1) throw Error('ONE_ISSUE_PER_RUN');
    atomic(path.join(c.lock, 'owner.json'), { ...owner, issue_number: issue });
    result = { status: 'BOUND', issue_number: issue };
  }
  else if (command === 'checkpoint') result = saveCheckpoint(c, args[0], json(args[1]));
  else if (command === 'claim') result = claim(c, args[0]);
  else if (command === 'sync') result = syncInbox(c, args[0]);
  else if (command === 'receipt') result = receipt(c, args[0], json(args[1]));
  else if (command === 'recover') result = recovery(c, Number(args[0]));
  else if (command === 'release') result = release(c, args[0]);
  else if (command === 'queue') {
    const { inbox, ...summary } = localQueue(c); result = summary;
  } else throw Error('USAGE: acquire RUN THREAD ISSUE TRIGGER | inspect | checkpoint RUN FILE | recover ISSUE | release RUN | queue');
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
