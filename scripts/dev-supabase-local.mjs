import { spawn, spawnSync } from 'node:child_process';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const status = spawnSync(
  npm,
  ['exec', '--yes', '--package=supabase@latest', '--', 'supabase', 'status', '-o', 'env'],
  { encoding: 'utf8' },
);

if (status.status !== 0) {
  console.error('Démarrez Supabase local avec « npm run supabase:start », puis relancez cette commande.');
  process.exit(status.status ?? 1);
}

const localValues = Object.fromEntries(status.stdout.trim().split(/\r?\n/).map((line) => {
  const separator = line.indexOf('=');
  return [line.slice(0, separator), line.slice(separator + 1).replace(/^"|"$/g, '')];
}));

if (!localValues.API_URL || !localValues.PUBLISHABLE_KEY) {
  console.error('La CLI Supabase n’a pas fourni l’URL locale et la clé publiable attendues.');
  process.exit(1);
}

const child = spawn(
  npm,
  ['run', 'dev', '--workspace', 'client'],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      VITE_SUPABASE_URL: localValues.API_URL,
      VITE_SUPABASE_PUBLISHABLE_KEY: localValues.PUBLISHABLE_KEY,
      VITE_API_BASE_URL: '',
    },
  },
);

child.on('error', (error) => {
  console.error('Impossible de démarrer le client local :', error.message);
  process.exitCode = 1;
});
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
