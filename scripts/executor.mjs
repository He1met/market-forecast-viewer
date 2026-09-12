// W0 helpers only. The official Codex task interprets AGENTS and executes Issues.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const sha = value => createHash('sha256').update(value).digest('hex');
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });
const atomic = (file, data) => {
  const tmp = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  fs.renameSync(tmp, file);
};

export function context(cwd = process.cwd()) {
  const root = git(cwd, 'rev-parse', '--show-toplevel').trim();
  const common = git(cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir').trim();
  const base = path.join(common, 'mfv-executor');
  return { root, base, lock: path.join(base, 'writer.lock'), state: path.join(base, 'checkpoint.json') };
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
  else if (command === 'recover') result = recovery(c, Number(args[0]));
  else if (command === 'release') result = release(c, args[0]);
  else if (command === 'queue') {
    // Read-only discovery, NOT a claim or an authorization/scope/dependency gate.
    const pages = JSON.parse(execFileSync('gh', ['api', '--paginate', '--slurp',
      'repos/He1met/market-forecast-viewer/issues?state=open&labels=queue%3Acodex&per_page=100'],
    { encoding: 'utf8', timeout: 30000 }));
    const candidates = queueCandidates(pages.flat());
    result = { status: candidates.length ? 'CANDIDATES_REQUIRE_GATE' : 'EMPTY_QUEUE', candidates };
  } else throw Error('USAGE: acquire RUN THREAD ISSUE TRIGGER | inspect | checkpoint RUN FILE | recover ISSUE | release RUN | queue');
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
