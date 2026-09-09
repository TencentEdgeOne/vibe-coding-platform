import adapter from '@edgeone/sveltekit';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},

			// The platform adapter, and the reason this file is the whole of the
			// SvelteKit config: passing any option to sveltekit() makes a sibling
			// svelte.config.js dead weight — it is ignored whole, adapter included.
			adapter: adapter()
		})
	]
});
