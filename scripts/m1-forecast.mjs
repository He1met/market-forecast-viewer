import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { readFrozen, assertFrozenCode, prepareAttempt, completeAttempt, publishRun, readPublished } from './m1-archive.mjs';
import { prepareForecast } from './m1-input.mjs';

export function auditCodexEvents(stream) {
  const events = stream.trim().split('\n').filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch { return { type: 'unparsed' }; }
  });
  const known = ['thread.started', 'turn.started', 'turn.completed', 'turn.failed', 'error',
    'item.started', 'item.updated', 'item.completed'];
  let turnStarted = false, startupWarnings = 0;
  const noticePrefix = 'Under-development features enabled: chronicle. Under-development features are incomplete and may behave unpredictably. To suppress this warning, set `suppress_unstable_features_warning = true` in ';
  const unexpected = events.filter(event => {
    if (!event || typeof event !== 'object' || !known.includes(event.type)) return true;
    if (event.type === 'turn.started') turnStarted = true;
    // Observed CLI 0.154.0-alpha.6.2 startup notice, emitted before any model turn.
    // It is neither a failed turn nor a tool call; every other error item remains rejected.
    if (!turnStarted && event.type === 'item.completed' && event.item?.type === 'error'
      && typeof event.item.message === 'string'
      && event.item.message.startsWith(noticePrefix)
      && /^\/[^\r\n]+\/config\.toml\.$/.test(event.item.message.slice(noticePrefix.length))) {
      startupWarnings++; return false;
    }
    return event.type.startsWith('item.') && (!event.item || !['agent_message', 'reasoning'].includes(event.item.type));
  });
  return { events, unexpected_count: unexpected.length,
    startup_warning_count: startupWarnings,
    turn_completed: events.some(event => event?.type === 'turn.completed'),
    failed: events.some(event => ['turn.failed', 'error'].includes(event?.type)) };
}

// The CLI is a single bounded model operation, never a development executor.
export async function generateForecast(runDir, { beforePublish = async () => {} } = {}) {
  const frozen = await readFrozen(runDir);
  const previous = await readPublished(runDir);
  if (previous) return previous;
  await assertFrozenCode(runDir);
  const attempt = await prepareAttempt(runDir);
  const args = ['exec', '--sandbox', 'read-only', '--json', '--color', 'never',
    '--output-schema', path.resolve(runDir, 'output-schema.json'),
    '--output-last-message', path.resolve(attempt.rawFile), '-'];
  let cliVersion = 'unavailable';
  let authMethod = 'not_confirmed';
  const result = await Promise.resolve().then(() => {
    cliVersion = execFileSync('codex', ['--version'], { encoding: 'utf8', timeout: 5000 }).trim();
    const auth = spawnSync('codex', ['login', 'status'], { encoding: 'utf8', timeout: 10000 });
    const authStatus = String(auth.stdout ?? '') + String(auth.stderr ?? '');
    if (auth.status !== 0 || !/ChatGPT/i.test(authStatus) || /using (?:an )?API key/i.test(authStatus)) {
      throw Error('Existing ChatGPT authentication could not be confirmed; no model invocation');
    }
    authMethod = 'chatgpt_verified';
    return new Promise((resolve, reject) => {
    const child = spawn('codex', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false;
    let killTimeout;
    const timeout = setTimeout(() => {
      timedOut = true; child.kill('SIGTERM');
      killTimeout = setTimeout(() => child.kill('SIGKILL'), 2000);
    }, 240000);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', bytes => { stdout += bytes; });
    child.stderr.on('data', bytes => { stderr += bytes; });
    child.on('error', error => { clearTimeout(timeout); clearTimeout(killTimeout); reject(error); });
    child.on('close', (code, signal) => { clearTimeout(timeout); clearTimeout(killTimeout); resolve({ code, signal, stdout, stderr, timedOut }); });
    child.stdin.on('error', () => {});
    child.stdin.end(frozen.prompt);
    });
  }).catch(error => ({ code: -1, signal: null, stdout: '', stderr: error.message, timedOut: false }));
  await fs.writeFile(path.join(attempt.attemptDir, 'events.jsonl'), result.stdout, { flag: 'wx', mode: 0o600 });
  await fs.writeFile(path.join(attempt.attemptDir, 'stderr.log'), result.stderr, { flag: 'wx', mode: 0o600 });
  const audit = auditCodexEvents(result.stdout), events = audit.events;
  const rawExists = await fs.stat(attempt.rawFile).then(stat => stat.isFile(), () => false);
  const succeeded = result.code === 0 && rawExists && !result.timedOut && audit.turn_completed && !audit.failed && audit.unexpected_count === 0;
  const failure = succeeded ? null : result.timedOut ? 'CODEX_TIMEOUT'
    : result.code !== 0 ? 'CODEX_PROCESS_FAILED' : !rawExists ? 'RAW_OUTPUT_MISSING' : 'CODEX_EVENT_REJECTED';
  await completeAttempt(runDir, attempt.attempt_id, { exit_code: succeeded ? 0 : result.code || -1,
    cli_exit_code: result.code, signal: result.signal, timed_out: result.timedOut, error: failure,
    model_config: { provider: 'official_codex', selection: 'existing_local_cli_configuration', cli_version: cliVersion, auth_method: authMethod,
      sandbox: 'read-only', output_schema: true, startup_warning_count: audit.startup_warning_count },
    model_identity: null, model_identity_visibility: 'not_exposed_by_jsonl',
    model_thread_id: events.find(event => event?.type === 'thread.started')?.thread_id ?? null,
    execution_mode: 'official_codex_exec_frozen_stdin',
    unexpected_tool_events: audit.unexpected_count, turn_completed: audit.turn_completed });
  if (!succeeded) throw Error('Codex generation failed or attempted tools after input freeze; see LOCAL_ONLY attempt receipt');
  try {
    // The atomic publication receipt already records successful validation.
    await beforePublish();
    return await publishRun(runDir, attempt.rawFile, { attempt_id: attempt.attempt_id });
  } catch (error) {
    await fs.writeFile(path.join(attempt.attemptDir, 'validation-result.json'), JSON.stringify({
      status: 'failed', validated_at: new Date().toISOString(), error: error.message,
      stage: 'validate_publish' }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    throw error;
  }
}

async function main() {
  const [command, argument] = process.argv.slice(2);
  if (!argument) throw Error('Usage: prepare EVENTS_JSON | generate RUN_DIR | read RUN_DIR');
  if (command === 'prepare') {
    const run = await prepareForecast(argument);
    console.log(JSON.stringify({ run_id: run.run_id, runDir: run.runDir, anchor_time: run.anchor_time,
      first_node: run.first_node, status: 'frozen' }));
  } else if (command === 'generate' || command === 'read') {
    const value = command === 'generate' ? await generateForecast(argument) : await readPublished(argument);
    console.log(JSON.stringify(value ? { run_id: value.forecast.run_id, receipt: value.receipt,
      status: value.forecast.status ?? value.receipt.status } : { status: 'not_published' }));
  } else throw Error('Unknown command');
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
