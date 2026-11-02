import adapter from '@sveltejs/adapter-node';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	kit: {
		// Build a standalone Node server for the production dashboard service.
		adapter: adapter({ out: 'build' })
	}
};

export default config;
