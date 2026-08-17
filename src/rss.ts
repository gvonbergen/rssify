import { rfc822 } from './util.ts';

export interface FeedItem {
  title: string;
  link: string;
  guid: string; // hash, isPermaLink=false
  pubDate: number; // epoch ms
  description: string | null; // full article body text → <description>
  contentHtml: string | null; // cleaned article HTML → <content:encoded>
  author?: string; // → <dc:creator>
}

export interface FeedMeta {
  title: string;
  description: string;
  link: string;
  feedUrl: string; // atom:link self href
  ttlMinutes: number;
  lastBuildDate: number; // latest first_seen
  items: FeedItem[];
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Wrap arbitrary HTML/text in CDATA, splitting any `]]>` safely. */
function cdata(body: string): string {
  return body.split(']]>').join(']]]]><![CDATA[>');
}

/**
 * Build an RSS 2.0 document. Full-content model: <description> = full article
 * body text, <content:encoded> = the complete cleaned article.
 */
export function buildRss(meta: FeedMeta): string {
  const items = meta.items
    .map((it) => {
      let s = '    <item>\n';
      s += `      <title>${esc(it.title)}</title>\n`;
      s += `      <link>${esc(it.link)}</link>\n`;
      s += `      <guid isPermaLink="false">${esc(it.guid)}</guid>\n`;
      s += `      <pubDate>${rfc822(it.pubDate)}</pubDate>\n`;
      if (it.description) s += `      <description><![CDATA[${cdata(it.description)}]]></description>\n`;
      else s += '      <description/>\n';
      if (it.contentHtml) {
        s += `      <content:encoded><![CDATA[${cdata(it.contentHtml)}]]></content:encoded>\n`;
      }
      if (it.author) s += `      <dc:creator>${esc(it.author)}</dc:creator>\n`;
      s += '    </item>\n';
      return s;
    })
    .join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
     xmlns:content="http://purl.org/rss/1.0/modules/content/"
     xmlns:dc="http://purl.org/dc/elements/1.1/"
     xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${esc(meta.title)}</title>
    <link>${esc(meta.link)}</link>
    <description>${esc(meta.description)}</description>
    <lastBuildDate>${rfc822(meta.lastBuildDate)}</lastBuildDate>
    <ttl>${meta.ttlMinutes}</ttl>
    <atom:link href="${esc(meta.feedUrl)}" rel="self" type="application/rss+xml"/>
${items}  </channel>
</rss>
`;
}

/** Derive ttl (minutes) from a cron expression (best-effort: minutes between runs). */
export function ttlFromSchedule(schedule: string): number {
  // Common case "*/N * * * *" → N minutes.
  const m = schedule.match(/^\*\/(\d+) \* \* \* \*$/);
  if (m) return Math.max(1, Number(m[1]));
  // Default 15.
  return 15;
}
