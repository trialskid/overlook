// Runs the backend (tsx watch, with .env if present) and Vite together; Ctrl-C stops both.
// On macOS, node can't reach LAN addresses (Local Network privacy), so upstream calls go through curl.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const env = { ...process.env, ...(process.platform === 'darwin' && !process.env.CC_FETCH ? { CC_FETCH: 'curl' } : {}) };
const envFile = fs.existsSync('.env') && process.env.MOCK !== '1' ? ['--env-file=.env'] : [];
const run = (cmd, args) => spawn(cmd, args, { stdio: 'inherit', env });
const kids = [run('npx', ['tsx', 'watch', ...envFile, 'server/index.ts']), run('npx', ['vite'])];
const stop = () => { for (const k of kids) k.kill(); process.exit(0); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
