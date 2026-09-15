import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateAndCopyEvents } from '../scripts/m1-events.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hash = value => createHash('sha256').update(value).digest('hex');
const iso = value => new Date(value).toISOString();
async function fixture(t, mode = 'market_only') {
  const root = await mkdtemp(join(project, 'artifacts', 'm1-events-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runDir = join(root, 'run'); await mkdir(runDir);
  const raw = join(root, 'source.raw'); await writeFile(raw, 'Official source fixture bytes');
  const fetched = iso(Date.now() - 60_000).replace(/\.(\d{3})Z$/, '.$1123Z');
  const cutoff = iso(Date.now() - 30_000).replace(/\.(\d{3})Z$/, '.$1456Z');
  const raw_path = relative(project, raw);
  const source = { source_url: 'https://www.federalreserve.gov/fixture', raw_path,
    raw_sha256: hash(await readFile(raw)), fetched_at: fetched, curl_exit_code: 0 };
  const item = { title: 'Fixture event', source_url: source.source_url, raw_path,
    raw_sha256: source.raw_sha256, fetched_at: fetched,
    published_at: mode === 'market_only' ? null : iso(Date.now() - 120_000),
    event_time: mode === 'market_only' ? '2026-09-14' : iso(Date.now() + 86_400_000),
    excluded_from_predictive_event_risk: mode === 'market_only' };
  const events = { mode, information_cutoff: cutoff, sources: [source], items: [item],
    event_risk_incorporated: mode === 'official_calendar', limitations: ['Fixture only; not an actual event.'] };
  const eventsFile = join(root, 'events.json');
  const save = async () => writeFile(eventsFile, JSON.stringify(events));
  await save();
  return { root, runDir, raw, eventsFile, events, save };
}

test('copies validated bytes without changing original JSON, timestamps or unknown metadata', async t => {
  const f = await fixture(t); f.events.extra_evidence_note = 'preserved'; await f.save();
  const original = await readFile(f.eventsFile);
  const result = await validateAndCopyEvents(f.eventsFile, f.runDir);
  assert.equal(result.original_sha256, hash(original));
  assert.equal(result.events.extra_evidence_note, 'preserved');
  assert.equal(result.events.information_cutoff, f.events.information_cutoff);
  assert.equal(result.events.items[0].published_at, null);
  assert.equal(result.events.items[0].event_time, '2026-09-14');
  assert.equal(result.events.sources[0].raw_path, relative(project, join(f.runDir, 'events-source-001.raw')));
  assert.equal(result.events.items[0].raw_path, result.events.sources[0].raw_path);
  assert.deepEqual(await readFile(join(f.runDir, 'events-source-001.raw')), await readFile(f.raw));
  assert.deepEqual(await readFile(f.eventsFile), original);
});
test('accepts exact official UTC events, including a future scheduled event time', async t => {
  const f = await fixture(t, 'official_calendar');
  const { events } = await validateAndCopyEvents(f.eventsFile, f.runDir);
  assert.equal(events.event_risk_incorporated, true);
  assert.equal(events.items[0].event_time, f.events.items[0].event_time);
});
test('retains failed fetch bytes in market_only but forbids treating them as included official events', async t => {
  const f = await fixture(t); f.events.sources[0].curl_exit_code = 22; await f.save();
  await validateAndCopyEvents(f.eventsFile, f.runDir);
  const other = await fixture(t, 'official_calendar'); other.events.sources[0].curl_exit_code = 22; await other.save();
  await assert.rejects(() => validateAndCopyEvents(other.eventsFile, other.runDir), /INCLUDED_SOURCE_FETCH_FAILED/);
});
test('never overwrites an existing source copy', async t => {
  const f = await fixture(t); const output = join(f.runDir, 'events-source-001.raw');
  await writeFile(output, 'earlier immutable bytes');
  await assert.rejects(() => validateAndCopyEvents(f.eventsFile, f.runDir), /EEXIST/);
  assert.equal(await readFile(output, 'utf8'), 'earlier immutable bytes');
});

const changes = [
  ['future cutoff', f => { f.events.information_cutoff = iso(Date.now() + 30_000); }, /FUTURE_INFORMATION_CUTOFF/],
  ['fetch after cutoff', f => { f.events.sources[0].fetched_at = iso(Date.now() - 1000); }, /SOURCE_FETCH_AFTER_CUTOFF/],
  ['publication after fetch', f => { f.events.items[0].published_at = iso(Date.now() - 1000); }, /PUBLICATION_AFTER_FETCH/],
  ['source publication after fetch', f => { f.events.sources[0].published_at = iso(Date.now() - 1000); }, /PUBLICATION_AFTER_FETCH/],
  ['fetch starts after it ends', f => { f.events.sources[0].started_at = iso(Date.now() - 1000); }, /FETCH_START_AFTER_COMPLETION/],
  ['date-only cutoff', f => { f.events.information_cutoff = '2026-09-12'; }, /INVALID_UTC_TIME/],
  ['invalid calendar day', f => { f.events.information_cutoff = '2026-02-30T00:00:00Z'; }, /INVALID_UTC_TIME/],
  ['offset instead of UTC', f => { f.events.information_cutoff = '2026-09-12T00:00:00+00:00'; }, /INVALID_UTC_TIME/],
  ['invalid hour', f => { f.events.information_cutoff = '2026-09-12T24:00:00Z'; }, /INVALID_UTC_TIME/],
  ['wrong source hash', f => { f.events.sources[0].raw_sha256 = '0'.repeat(64); }, /EVENT_SOURCE_HASH_MISMATCH/],
  ['item hash does not match source', f => { f.events.items[0].raw_sha256 = '0'.repeat(64); }, /EVENT_ITEM_SOURCE_MISMATCH/],
  ['item URL does not match source', f => { f.events.items[0].source_url = 'https://www.bls.gov/other'; }, /EVENT_ITEM_SOURCE_MISMATCH/],
  ['item path does not match source', f => { f.events.items[0].raw_path = 'artifacts/missing.raw'; }, /EVENT_ITEM_SOURCE_MISMATCH/],
  ['item fetch time does not match source', f => { f.events.items[0].fetched_at = iso(Date.now() - 120_000); }, /EVENT_ITEM_FETCH_MISMATCH/],
  ['unexcluded market-only item', f => { f.events.items[0].excluded_from_predictive_event_risk = false; }, /MARKET_ONLY_ITEM_NOT_EXCLUDED/],
  ['mode-risk contradiction', f => { f.events.event_risk_incorporated = true; }, /EVENT_MODE_RISK_CONFLICT/],
  ['unknown mode', f => { f.events.mode = 'news'; }, /INVALID_EVENT_MODE/],
  ['missing sources', f => { delete f.events.sources; }, /EVENT_ARRAYS_REQUIRED/],
  ['duplicate source', f => { f.events.sources.push({ ...f.events.sources[0] }); }, /DUPLICATE_EVENT_SOURCE/],
  ['URL credentials', f => { f.events.sources[0].source_url = 'https://user:password@example.com/'; }, /INVALID_SOURCE_URL/],
  ['absolute source path', f => { f.events.sources[0].raw_path = f.raw; }, /ABSOLUTE_SOURCE_PATH_FORBIDDEN/],
  ['traversal source path', f => { f.events.sources[0].raw_path = 'artifacts/../package.json'; }, /ARTIFACT_PATH_TRAVERSAL/],
  ['non-artifacts source', f => { f.events.sources[0].raw_path = 'package.json'; }, /PATH_OUTSIDE_ARTIFACTS/],
];
for (const [name, change, error] of changes) test(`rejects ${name} before any run copy`, async t => {
  const f = await fixture(t); change(f); await f.save();
  await assert.rejects(() => validateAndCopyEvents(f.eventsFile, f.runDir), error);
  assert.deepEqual(await readdir(f.runDir), []);
});
test('does not truncate microseconds when comparing fetch and cutoff or publication time', async t => {
  const f = await fixture(t);
  const whole = iso(Date.now() - 120_000).slice(0, 19);
  f.events.information_cutoff = `${whole}.123001Z`;
  f.events.sources[0].fetched_at = `${whole}.123002Z`; await f.save();
  await assert.rejects(() => validateAndCopyEvents(f.eventsFile, f.runDir), /SOURCE_FETCH_AFTER_CUTOFF/);
  f.events.information_cutoff = `${whole}.123002Z`;
  f.events.items[0].fetched_at = `${whole}.123002Z`;
  f.events.items[0].published_at = `${whole}.123003Z`; await f.save();
  await assert.rejects(() => validateAndCopyEvents(f.eventsFile, f.runDir), /PUBLICATION_AFTER_FETCH/);
});
for (const field of ['published_at', 'event_time']) test(`official inclusion rejects missing or approximate ${field}`, async t => {
  const f = await fixture(t, 'official_calendar');
  f.events.items[0][field] = field === 'published_at' ? null : '2026-09-14'; await f.save();
  await assert.rejects(() => validateAndCopyEvents(f.eventsFile, f.runDir), /INVALID_UTC_TIME/);
});
test('official mode cannot silently contain only excluded events', async t => {
  const f = await fixture(t, 'official_calendar'); f.events.items[0].excluded_from_predictive_event_risk = true; await f.save();
  await assert.rejects(() => validateAndCopyEvents(f.eventsFile, f.runDir), /OFFICIAL_CALENDAR_HAS_NO_INCLUDED_EVENTS/);
});
test('strict JSON parsing rejects duplicate decoded keys', async t => {
  const f = await fixture(t); await writeFile(f.eventsFile, '{"mode":"market_only","\\u006dode":"official_calendar"}');
  await assert.rejects(() => validateAndCopyEvents(f.eventsFile, f.runDir), /重复 JSON 键/);
});
test('rejects source symlink escapes even when bytes and hash would match', async t => {
  const f = await fixture(t); const link = join(f.root, 'escape.raw');
  await symlink(join(project, 'package.json'), link);
  f.events.sources[0].raw_path = relative(project, link);
  f.events.sources[0].raw_sha256 = hash(await readFile(join(project, 'package.json'))); await f.save();
  await assert.rejects(() => validateAndCopyEvents(f.eventsFile, f.runDir), /ARTIFACT_SYMLINK_ESCAPE/);
});
test('rejects source directory symlink escapes', async t => {
  const f = await fixture(t); const link = join(f.root, 'escape-dir'); await symlink(project, link);
  f.events.sources[0].raw_path = relative(project, join(link, 'package.json')); await f.save();
  await assert.rejects(() => validateAndCopyEvents(f.eventsFile, f.runDir), /ARTIFACT_SYMLINK_ESCAPE/);
});
test('rejects run-directory symlink escapes without writing outside artifacts', async t => {
  const f = await fixture(t); const link = join(f.root, 'run-escape'); await symlink(project, link);
  await assert.rejects(() => validateAndCopyEvents(f.eventsFile, link), /ARTIFACT_SYMLINK_ESCAPE/);
});
test('rejects internal symlink aliases under the stable data-root contract', async t => {
  const f = await fixture(t); const link = join(f.root, 'inside.raw'); await symlink(f.raw, link);
  const name = relative(project, link); f.events.sources[0].raw_path = name; f.events.items[0].raw_path = name; await f.save();
  await assert.rejects(()=>validateAndCopyEvents(f.eventsFile,f.runDir),/ARTIFACT_SYMLINK_ESCAPE/);
});
