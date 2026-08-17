import { existsSync } from 'node:fs';

/**
 * Module-customization hook (loaded via module.register) that rewrites relative
 * `.js` import specifiers (and extensionless ones) to `.ts` when the importer is
 * a `.ts` file and a `.ts` sibling exists. Handles pi-authored scraper modules
 * regardless of which extension they used on relative imports. Robust to
 * cache-busting query strings on the parent URL.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function resolve(specifier: string, context: any, nextResolve: any) {
  const parentRaw = context?.parentURL as string | undefined;
  if (parentRaw && (specifier.startsWith('./') || specifier.startsWith('../'))) {
    let fromTs = false;
    try {
      fromTs = new URL(parentRaw).pathname.endsWith('.ts');
    } catch {
      fromTs = false;
    }
    if (fromTs) {
      const cleanParent = new URL(parentRaw);
      if (specifier.endsWith('.js')) {
        const tsUrl = new URL(specifier.slice(0, -3) + '.ts', cleanParent);
        if (existsSync(tsUrl)) {
          return nextResolve(tsUrl.href, context);
        }
      } else if (!/\.[a-z0-9]+$/i.test(specifier)) {
        const tsUrl = new URL(specifier + '.ts', cleanParent);
        if (existsSync(tsUrl)) {
          return nextResolve(tsUrl.href, context);
        }
      }
    }
  }
  return nextResolve(specifier, context);
}
