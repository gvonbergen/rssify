import { register } from 'node:module';

/**
 * Register the `.js`→`.ts` relative-import loader hook (see loader-hook.ts).
 * Import this module first at the CLI entrypoint so dynamically loaded site
 * modules resolve regardless of which extension `pi` wrote on relative imports.
 */
register(new URL('./loader-hook.ts', import.meta.url).href);

export {};
