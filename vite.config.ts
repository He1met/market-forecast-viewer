import { defineConfig } from 'vite';
// @ts-expect-error The read-only Node middleware is covered by its HTTP integration tests.
import { m1DisplayPlugin } from './scripts/m1-display.mjs';

// Keep Vite 8.3.0's default sensitive-file rules when extending fs.deny.
const privateFiles = [
  '.env', '.env.*', '*.{crt,pem,key,p12,pfx,cer,der}', '.npmrc', '.yarnrc.yml', '**/.git/**',
  '**/artifacts/**', '**/.codex/**',
];

export default defineConfig({
  plugins: [m1DisplayPlugin()],
  server: { host: '127.0.0.1', port: 5173, strictPort: true, cors: false, fs: { deny: privateFiles } },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true, cors: false },
});
