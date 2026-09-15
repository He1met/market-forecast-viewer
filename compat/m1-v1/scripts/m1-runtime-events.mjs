import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';

const execute = promisify(execFile);
const sources = [
  'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm',
  'https://www.bls.gov/schedule/news_release/cpi.htm',
];

/** Bounded official-source capture. No inferred publication time or executable page content. */
export async function collectRuntimeEvents({ root, directory, transport } = {}) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const records = [];
  const fetchSource = transport ?? (async (url, file) => {
    try {
      const { stdout } = await execute('curl', ['--silent', '--show-error', '--fail-with-body',
        '--max-time', '15', '--max-filesize', '2000000', '--output', file, '--write-out', '%{http_code}', url],
      { timeout: 18000, maxBuffer: 10000 });
      return { curl_exit_code: 0, http_code: stdout.trim(), error: null };
    } catch (error) {
      return { curl_exit_code: Number.isInteger(error.code) ? error.code : -1,
        http_code: /^\d{3}$/.test(String(error.stdout).trim()) ? String(error.stdout).trim() : null,
        error: 'OFFICIAL_SOURCE_FETCH_FAILED' };
    }
  });
  for (const [i, source_url] of sources.entries()) {
    const file = join(directory, `source-${i + 1}.raw`), started_at = new Date().toISOString();
    const result = await fetchSource(source_url, file), fetched_at = new Date().toISOString();
    // A failed transfer with no body still has explicit local failure evidence, never invented event text.
    let raw;
    try { raw = await readFile(file); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      raw = Buffer.from(JSON.stringify({ source_url, started_at, fetched_at, ...result }) + '\n');
      await writeFile(file, raw, { flag: 'wx', mode: 0o600 });
    }
    records.push({ source_url, raw_path: relative(root, file), raw_sha256: createHash('sha256').update(raw).digest('hex'),
      started_at, fetched_at, published_at: null, ...result });
  }
  const value = { mode: 'market_only', information_cutoff: new Date().toISOString(),
    event_risk_incorporated: false, sources: records, items: [],
    limitations: ['已有限获取官方日历材料，但未建立可核实的首次发布时间与事件时间映射；未纳入事件风险，不能推断没有重大事件。'] };
  const file = join(directory, 'events.json');
  await writeFile(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return file;
}
