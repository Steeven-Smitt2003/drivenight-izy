import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const apiOrigin = process.env.VITE_API_BASE_URL?.trim();

if (!apiOrigin) {
  throw new Error('Définis VITE_API_BASE_URL dans .env avec l’origine HTTPS de l’API avant de compiler.');
}

let parsedApiOrigin;
try {
  parsedApiOrigin = new URL(apiOrigin);
} catch {
  throw new Error('VITE_API_BASE_URL doit être une URL HTTPS valide.');
}

if (
  parsedApiOrigin.protocol !== 'https:'
  || parsedApiOrigin.username
  || parsedApiOrigin.password
  || parsedApiOrigin.pathname !== '/'
  || parsedApiOrigin.search
  || parsedApiOrigin.hash
) {
  throw new Error('VITE_API_BASE_URL doit contenir uniquement l’origine HTTPS de l’API.');
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    stdio: 'inherit',
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const gradleWrapper = process.platform === 'win32' ? 'gradlew.bat' : './gradlew';

run(npm, ['run', 'build', '--workspace', 'client']);
run(npx, ['cap', 'sync', 'android']);
run(gradleWrapper, ['assembleDebug'], { cwd: join(projectRoot, 'android') });

console.log('APK de test créé : android/app/build/outputs/apk/debug/app-debug.apk');
