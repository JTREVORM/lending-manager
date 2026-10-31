import { spawn } from 'node:child_process';
import { authEnvironment } from './real-auth-config.mjs';
const binary = process.env.E2E_REAL_AUTH_BINARY;
if (!binary || !binary.startsWith('/'))
  throw new Error('Real Auth binary path is required.');
const child = spawn(binary, ['serve'], {
  env: { ...process.env, ...authEnvironment },
  stdio: 'inherit',
});
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
child.on('exit', (code) => process.exit(code ?? 1));
