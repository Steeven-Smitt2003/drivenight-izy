import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
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

function buildEnv() {
  const env = { ...process.env };
  const jdk21Candidates = [
    env.JAVA_HOME,
    join(homedir(), '.cache', 'android-jdk', '21', 'usr', 'lib', 'jvm', 'java-21-openjdk-amd64'),
    '/usr/lib/jvm/java-21-openjdk-amd64',
    '/usr/lib/jvm/java-21-openjdk',
  ].filter(Boolean);
  const selectedJdk = jdk21Candidates.find((dir) => existsSync(join(dir, 'bin', 'javac')));
  if (selectedJdk) {
    env.JAVA_HOME = selectedJdk;
    env.PATH = `${join(selectedJdk, 'bin')}:${env.PATH ?? ''}`;
  }

  const sdkCandidates = [
    env.ANDROID_HOME,
    env.ANDROID_SDK_ROOT,
    join(homedir(), 'Android', 'Sdk'),
  ].filter(Boolean);
  const selectedSdk = sdkCandidates.find((dir) => existsSync(dir));
  if (selectedSdk) {
    env.ANDROID_HOME = selectedSdk;
    env.ANDROID_SDK_ROOT = selectedSdk;
  }

  return env;
}

const buildEnvironment = buildEnv();

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    stdio: 'inherit',
    env: buildEnvironment,
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

const embeddedApkPath = join(projectRoot, 'android/app/src/main/assets/public/DriveNight.apk');
if (existsSync(embeddedApkPath)) rmSync(embeddedApkPath, { force: true });

run(npm, ['run', 'build', '--workspace', 'client']);
run(npx, ['cap', 'sync', 'android']);
if (existsSync(embeddedApkPath)) rmSync(embeddedApkPath, { force: true });
run(gradleWrapper, ['assembleDebug'], { cwd: join(projectRoot, 'android') });

const debugApk = join(projectRoot, 'android/app/build/outputs/apk/debug/app-debug.apk');
const namedApk = join(projectRoot, 'DriveNight.apk');
const distApk = join(projectRoot, 'client/dist/DriveNight.apk');
copyFileSync(debugApk, namedApk);
if (existsSync(join(projectRoot, 'client/dist'))) {
  copyFileSync(debugApk, distApk);
}

console.log(`APK Android créé : ${namedApk}`);
