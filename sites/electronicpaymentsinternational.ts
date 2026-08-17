import { createGenericScraper } from '../src/extract/generic.ts';
import type { Backends, DiscoveredItem, ScraperContext, SectionRef, Article } from '../src/contract.ts';

export const site = 'electronicpaymentsinternational';
const inner = createGenericScraper('electronicpaymentsinternational');

export async function discover(ctx: ScraperContext, backends: Backends, section: SectionRef): Promise<DiscoveredItem[]> {
  return inner.discover(ctx, backends, section);
}
export async function parse(ctx: ScraperContext, backends: Backends, item: DiscoveredItem): Promise<Article> {
  return inner.parse(ctx, backends, item);
}
export default { site, discover, parse };
