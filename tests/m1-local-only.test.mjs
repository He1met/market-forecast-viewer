import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, isFileLoadingAllowed, normalizePath, resolveConfig } from 'vite';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const digest = value => createHash('sha256').update(value).digest('hex');

async function startServer() {
  for (let port = 5184; port < 5194; port++) {
    const server = await createServer({
      root, configFile: join(root, 'vite.config.ts'), logLevel: 'silent',
      optimizeDeps: { noDiscovery: true, include: [] },
      server: { host: '127.0.0.1', port, strictPort: true, hmr: false,
        watch: null, preTransformRequests: false },
    });
    try {
      await server.listen();
      return server;
    } catch (error) {
      await server.close();
      if (error.code !== 'EADDRINUSE' && !/already in use/.test(error.message)) throw error;
    }
  }
  throw Error('No unused strict test port in 5184-5193; existing services were left running');
}

test('Vite keeps raw archives private while serving the chart and DEMO data', async () => {
  const defaults = await resolveConfig({ root, configFile: false, logLevel: 'silent' }, 'serve');
  const filename = `m1-local-only-${randomUUID()}.txt`;
  const sentinelFile = join(root, 'artifacts', filename);
  const sentinel = `LOCAL_ONLY_SENTINEL_${randomUUID()}`;
  await mkdir(join(root, 'artifacts'), { recursive: true });
  await writeFile(sentinelFile, sentinel, { flag: 'wx', mode: 0o600 });
  let server;
  try {
    server = await startServer();
    const address = server.httpServer.address();
    assert.equal(address.address, '127.0.0.1');
    assert.equal(server.config.server.strictPort, true);
    for (const pattern of defaults.server.fs.deny) {
      assert.ok(server.config.server.fs.deny.includes(pattern), `Missing Vite default deny rule: ${pattern}`);
    }
    for (const file of ['.env', '.env.local', '.npmrc', '.yarnrc.yml', 'private.pem',
      '.git/config', '.codex/private.json', 'artifacts/private.json']) {
      assert.equal(isFileLoadingAllowed(server.config, normalizePath(join(root, file))), false,
        `Private path must be denied: ${file}`);
    }
    const origin = `http://127.0.0.1:${address.port}`;
    const pageResponse = await fetch(origin + '/');
    assert.equal(pageResponse.status, 200);
    const pageHash = digest(Buffer.from(await pageResponse.arrayBuffer()));
    const deniedPaths = [
      `/artifacts/${filename}`,
      `/@fs/${normalizePath(sentinelFile)}`,
      `/%61rtifacts/${filename}`,
      `/artifacts%2F${filename}`,
      `/artifacts/${filename.replace('.txt', '%2Etxt')}`,
      `/@fs/${normalizePath(sentinelFile).replace('/artifacts/', '/%61rtifacts/')}`,
    ];
    for (const [index, url] of deniedPaths.entries()) {
      const response = await fetch(origin + url);
      const body = Buffer.from(await response.arrayBuffer());
      assert.equal(body.includes(Buffer.from(sentinel)), false, `Sentinel leaked through variant ${index}`);
      const pageFallback = response.status === 200
        && response.headers.get('content-type')?.includes('text/html') && digest(body) === pageHash;
      assert.ok([400, 403, 404].includes(response.status) || pageFallback,
        `Private variant ${index} returned neither denial nor the unchanged SPA page`);
      console.log(JSON.stringify({ check: `private_variant_${index}`, status: response.status,
        page_fallback: Boolean(pageFallback), response_sha256: digest(body) }));
    }
    for (const url of ['/', '/src/contracts.ts', '/data/history.json']) {
      const response = await fetch(origin + url);
      const body = Buffer.from(await response.arrayBuffer());
      assert.equal(response.status, 200, `Public resource failed: ${url}`);
      if (url === '/data/history.json') {
        assert.equal(digest(body), digest(await readFile(join(root, 'public/data/history.json'))));
      }
      console.log(JSON.stringify({ check: url, status: response.status, response_sha256: digest(body) }));
    }
  } finally {
    try {
      if (server) {
        await server.close();
        assert.equal(server.httpServer.listening, false);
      }
    } finally {
      await unlink(sentinelFile);
      await assert.rejects(() => access(sentinelFile), { code: 'ENOENT' });
      console.log(JSON.stringify({ check: 'cleanup', sentinel_removed: true,
        own_server_closed: !server || !server.httpServer.listening }));
    }
  }
});
