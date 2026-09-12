import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, parseStrict } from '../src/contracts.ts';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const artifactsRoot = join(projectRoot, 'artifacts');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const within = (file, directory) => {
  const part = relative(directory, file);
  return part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part);
};

// Preserve microseconds in provenance comparisons; Date.parse alone truncates them.
function utcMicros(value, field) {
  check(typeof value === 'string', `INVALID_UTC_TIME: ${field}`);
  const match = value.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z$/);
  check(match, `INVALID_UTC_TIME: ${field}`);
  const milliseconds = Date.parse(`${match[1]}Z`);
  check(Number.isFinite(milliseconds) && new Date(milliseconds).toISOString().slice(0, 19) === match[1], `INVALID_UTC_TIME: ${field}`);
  return BigInt(milliseconds) * 1000n + BigInt((match[2] ?? '').padEnd(6, '0'));
}

function sourceUrl(value) {
  check(typeof value === 'string', 'INVALID_SOURCE_URL');
  let parsed;
  try { parsed = new URL(value); } catch { throw Error('INVALID_SOURCE_URL'); }
  check(parsed.protocol === 'https:' && parsed.hostname && !parsed.username && !parsed.password && !parsed.hash, 'INVALID_SOURCE_URL');
  return value;
}

async function artifactPath(value, { source = false, directory = false } = {}) {
  check(typeof value === 'string' && value.length > 0 && !value.includes('\0') && !value.includes('\\'), 'INVALID_ARTIFACT_PATH');
  check(!value.split('/').includes('..'), 'ARTIFACT_PATH_TRAVERSAL');
  if (source) check(!isAbsolute(value), 'ABSOLUTE_SOURCE_PATH_FORBIDDEN');
  const lexical = resolve(projectRoot, value);
  check(within(lexical, artifactsRoot), 'PATH_OUTSIDE_ARTIFACTS');
  const trueRoot = await realpath(projectRoot);
  const trueArtifacts = await realpath(artifactsRoot);
  check(trueArtifacts === join(trueRoot, 'artifacts'), 'ARTIFACTS_ROOT_SYMLINK_FORBIDDEN');
  const actual = await realpath(lexical);
  check(within(actual, trueArtifacts), 'ARTIFACT_SYMLINK_ESCAPE');
  if (directory) check((await stat(actual)).isDirectory(), 'RUN_DIRECTORY_REQUIRED');
  return actual;
}

async function regularBytes(file) {
  // The final realpath component must still be a regular file when opened.
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    check((await handle.stat()).isFile(), 'EVENT_SOURCE_NOT_REGULAR_FILE');
    return await handle.readFile();
  } finally { await handle.close(); }
}

/** Validate only existing LOCAL_ONLY event material; this function performs no networking. */
export async function validateAndCopyEvents(eventsFile, runDir) {
  const original = await regularBytes(await artifactPath(eventsFile));
  const events = parseStrict(original.toString('utf8'));
  check(object(events), 'INVALID_EVENTS_OBJECT');
  check(['market_only', 'official_calendar'].includes(events.mode), 'INVALID_EVENT_MODE');
  check(Array.isArray(events.sources) && Array.isArray(events.items), 'EVENT_ARRAYS_REQUIRED');
  check(Array.isArray(events.limitations) && events.limitations.every(value => typeof value === 'string' && value.trim()), 'INVALID_EVENT_LIMITATIONS');
  const cutoff = utcMicros(events.information_cutoff, 'information_cutoff');
  const observedNow = BigInt(Date.now()) * 1000n;
  check(cutoff <= observedNow, 'FUTURE_INFORMATION_CUTOFF');
  if ('event_risk_incorporated' in events) {
    check(events.event_risk_incorporated === (events.mode === 'official_calendar'), 'EVENT_MODE_RISK_CONFLICT');
  }
  const sourceMap = new Map(), fileSet = new Set(), copies = [];
  for (const source of events.sources) {
    check(object(source), 'INVALID_EVENT_SOURCE');
    sourceUrl(source.source_url);
    check(typeof source.raw_sha256 === 'string' && /^[a-f0-9]{64}$/.test(source.raw_sha256), 'INVALID_EVENT_SOURCE_HASH');
    const fetched = utcMicros(source.fetched_at, 'source.fetched_at');
    check(fetched <= cutoff, 'SOURCE_FETCH_AFTER_CUTOFF');
    if (source.started_at !== undefined) check(utcMicros(source.started_at, 'source.started_at') <= fetched, 'FETCH_START_AFTER_COMPLETION');
    if (source.published_at !== null && source.published_at !== undefined) {
      check(utcMicros(source.published_at, 'source.published_at') <= fetched, 'PUBLICATION_AFTER_FETCH');
    }
    const file = await artifactPath(source.raw_path, { source: true });
    check(!fileSet.has(file), 'DUPLICATE_EVENT_SOURCE'); fileSet.add(file);
    const bytes = await regularBytes(file);
    check(hash(bytes) === source.raw_sha256, 'EVENT_SOURCE_HASH_MISMATCH');
    sourceMap.set(source.raw_path, { source, fetched });
    copies.push({ source, bytes });
  }
  let included = 0;
  for (const item of events.items) {
    check(object(item), 'INVALID_EVENT_ITEM');
    const linked = sourceMap.get(item.raw_path);
    check(linked && item.source_url === linked.source.source_url && item.raw_sha256 === linked.source.raw_sha256, 'EVENT_ITEM_SOURCE_MISMATCH');
    const fetched = utcMicros(item.fetched_at, 'item.fetched_at');
    check(fetched === linked.fetched, 'EVENT_ITEM_FETCH_MISMATCH');
    if (item.published_at !== null && item.published_at !== undefined) {
      check(utcMicros(item.published_at, 'item.published_at') <= fetched, 'PUBLICATION_AFTER_FETCH');
    }
    if (events.mode === 'market_only') {
      check(item.excluded_from_predictive_event_risk === true, 'MARKET_ONLY_ITEM_NOT_EXCLUDED');
    } else if (item.excluded_from_predictive_event_risk !== true) {
      utcMicros(item.published_at, 'included.published_at');
      utcMicros(item.event_time, 'included.event_time');
      check(linked.source.curl_exit_code === undefined || linked.source.curl_exit_code === 0, 'INCLUDED_SOURCE_FETCH_FAILED');
      included++;
    }
  }
  if (events.mode === 'official_calendar') check(included > 0, 'OFFICIAL_CALENDAR_HAS_NO_INCLUDED_EVENTS');
  // All source and metadata checks finish before creating any run copy.
  const destination = await artifactPath(runDir, { directory: true });
  const rewritten = new Map();
  for (const [index, copy] of copies.entries()) {
    const filename = join(destination, `events-source-${String(index + 1).padStart(3, '0')}.raw`);
    await writeFile(filename, copy.bytes, { flag: 'wx', mode: 0o600 });
    const savedPath = relative(await realpath(projectRoot), filename).split(sep).join('/');
    rewritten.set(copy.source.raw_path, savedPath);
    copy.source.raw_path = savedPath;
  }
  for (const item of events.items) item.raw_path = rewritten.get(item.raw_path);
  return { events, original_sha256: hash(original) };
}
