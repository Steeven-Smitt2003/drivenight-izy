import { spawnSync } from 'node:child_process';
import { copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const apiOrigin = process.env.VITE_API_BASE_URL?.trim();
const supabaseUrl = process.env.VITE_SUPABASE_URL?.trim();
const supabaseKey = process.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim();

if (Boolean(supabaseUrl) !== Boolean(supabaseKey)) {
  throw new Error('Configure VITE_SUPABASE_URL et VITE_SUPABASE_PUBLISHABLE_KEY ensemble.');
}

if (!supabaseUrl && !apiOrigin) {
  throw new Error(
    'Configure un backend distant dans .env : VITE_SUPABASE_URL + VITE_SUPABASE_PUBLISHABLE_KEY, ou VITE_API_BASE_URL.',
  );
}

for (const [name, value] of [
  ['VITE_SUPABASE_URL', supabaseUrl],
  ['VITE_API_BASE_URL', apiOrigin],
].filter(([, value]) => value)) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} doit être une URL HTTPS valide.`);
  }
  if (
    url.protocol !== 'https:'
    || url.username
    || url.password
    || url.pathname !== '/'
    || url.search
    || url.hash
  ) {
    throw new Error(`${name} doit contenir uniquement une origine HTTPS.`);
  }
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

const debugApk = join(projectRoot, 'android/app/build/outputs/apk/debug/app-debug.apk');
const namedApk = join(projectRoot, 'DriveNight.apk');
copyFileSync(debugApk, namedApk);

console.log(`APK de test créé : ${namedApk}`);
