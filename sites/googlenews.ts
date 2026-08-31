import { load as cheerioLoad } from 'cheerio';
import type {
  Article,
  Backends,
  DiscoveredItem,
  ScraperContext,
  SectionRef,
} from '../src/contract.ts';
import { createGenericScraper } from '../src/extract/generic.ts';

/**
 * Google News topic feeds — backed by the user's Google Alerts Atom URL for
 * each topic (each topic = one section, its indexUrl = the alert's feed URL).
 *
 * discover() parses the Atom XML and returns the REAL article URLs Google
 * embeds in each entry's <link> (`url=` query param of the google.com/url
 * redirect). parse() delegates to the generic scraper so the central
 * readability + metadata + LLM extraction pipeline applies to the origin
 * article page unchanged.
 */

export const site = 'googlenews';

const generic = createGenericScraper('googlenews');

/** Parse a Google Alerts Atom feed body into discovered article candidates. */
export function parseGoogleAlertsFeed(xml: string): DiscoveredItem[] {
  const $ = cheerioLoad(xml, { xmlMode: true });
  const out: DiscoveredItem[] = [];

  $('entry').each((_i, el) => {
    const $entry = $(el);
    // Title arrives as HTML ("OCC &lt;b&gt;Stablecoin&lt;/b&gt; … - PYMNTS.com");
    // .text() decodes named entities but can leave numeric ones (&#39;) and
    // literal <b> — decode + drop tags.
    const decoded = ($entry.find('title').first().text() ?? '').replace(
      /&#(x?[0-9a-f]+);/gi,
      (_m, hex: string) => String.fromCodePoint(parseInt(hex, hex.toLowerCase().startsWith('x') ? 16 : 10)),
    );
    const title = decoded.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
    const href = $entry.find('link').first().attr('href') ?? '';
    const published = $entry.find('published').first().text().trim();

    let url = href;
    try {
      const u = new URL(href);
      const real = u.searchParams.get('url');
      if (real && /^https?:\/\//i.test(real)) url = real;
    } catch {
      /* keep href as-is */
    }
    if (!url || !/^https?:\/\//i.test(url)) return;

    out.push({
      url,
      hintTitle: title || undefined,
      hintDate: published || undefined,
    });
  });

  return out;
}

export async function discover(
  ctx: ScraperContext,
  backends: Backends,
  section: SectionRef,
): Promise<DiscoveredItem[]> {
  // The alert feed is plain Atom XML — no JS; plain fetch is enough.
  const xml = await backends.plain.fetch(section.indexUrl, {
    headers: {
      accept: 'application/atom+xml, application/xml;q=0.9, */*;q=0.8',
    },
  });
  const max = Number((ctx.config['extract'] as Record<string, unknown> | undefined)?.['max'] ?? ctx.discoverMax ?? 100) || 100;
  const items = parseGoogleAlertsFeed(xml);
  // Newest first (the feed is usually ordered that way already).
  items.sort((a, b) => {
    const ta = a.hintDate ? Date.parse(a.hintDate) : 0;
    const tb = b.hintDate ? Date.parse(b.hintDate) : 0;
    return (tb || 0) - (ta || 0);
  });
  return items.slice(0, max);
}

export async function parse(
  ctx: ScraperContext,
  backends: Backends,
  item: DiscoveredItem,
): Promise<Article> {
  const article = await generic.parse(ctx, backends, item);

  // For feed-backed discovery, Google Alerts' <published> value describes when
  // the result entered the news feed. Destination pages often contain future
  // event/effective dates that generic metadata extraction can mistake for the
  // publication date, so the valid Atom timestamp is authoritative here.
  if (item.hintDate && Number.isFinite(Date.parse(item.hintDate))) {
    article.publishedAt = item.hintDate;
  }

  return article;
}

export default { site, discover, parse };
