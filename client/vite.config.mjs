import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

function relativePublicAssets() {
  return {
    name: 'relative-public-assets',
    enforce: 'pre',
    transform(code, id) {
      if (!id.endsWith('.svelte')) return null;
      const next = code
        .replaceAll('src="/logo-drivenight.', 'src="logo-drivenight.')
        .replaceAll('src="/icons/', 'src="icons/');
      return next === code ? null : { code: next, map: null };
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [relativePublicAssets(), svelte()],
  envDir: '..',
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3000',
        ws: true,
      },
    },
  },
});
