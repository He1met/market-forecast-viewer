import { defineConfig } from 'vite';

// Keep Vite 8.3.0's default sensitive-file rules when extending fs.deny.
const privateFiles = [
  '.env', '.env.*', '*.{crt,pem,key,p12,pfx,cer,der}', '.npmrc', '.yarnrc.yml', '**/.git/**',
  '**/artifacts/**', '**/.codex/**',
];

export default defineConfig({
  server: { host: '127.0.0.1', port: 5173, strictPort: true, fs: { deny: privateFiles } },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true },
});
