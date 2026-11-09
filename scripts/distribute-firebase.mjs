import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const appId = process.env.FIREBASE_APP_ID?.trim();
const groups = process.env.FIREBASE_TESTER_GROUPS?.trim();
const testers = process.env.FIREBASE_TESTER_EMAILS?.trim();
const releaseNotes = process.env.FIREBASE_RELEASE_NOTES?.trim() || 'Version de test DriveNight';
const apkPath = join(projectRoot, 'android/app/build/outputs/apk/debug/app-debug.apk');

if (!appId) {
  throw new Error('Configure FIREBASE_APP_ID dans .env avec l’identifiant de l’application Android Firebase.');
}
if (!groups && !testers) {
  throw new Error('Configure FIREBASE_TESTER_GROUPS ou FIREBASE_TESTER_EMAILS dans .env.');
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    stdio: 'inherit',
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const firebase = process.platform === 'win32' ? 'firebase.cmd' : 'firebase';
const firebaseVersion = spawnSync(firebase, ['--version'], {
  cwd: projectRoot,
  stdio: 'ignore',
});
if (firebaseVersion.error || firebaseVersion.status !== 0) {
  throw new Error('Installe la Firebase CLI et connecte-toi avec firebase login avant la distribution.');
}

run(npm, ['run', 'android:apk']);
if (!existsSync(apkPath)) throw new Error('L’APK de test est introuvable après la compilation.');

const args = [
  'appdistribution:distribute',
  apkPath,
  '--app',
  appId,
  '--release-notes',
  releaseNotes,
];
if (groups) args.push('--groups', groups);
if (testers) args.push('--testers', testers);

run(firebase, args);
