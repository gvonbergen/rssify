/**
 * Junk-body classification for cleaned article extractions.
 *
 * The fetch cascade's quality trigger (src/scraper.ts persistArticle) advances
 * to the next configured engine when a cleaned body is empty or near-empty.
 * The 2026-09 extraction-quality audits (150-item Camofox recheck + prior
 * audit) proved that a large share of severe failures are NOT near-empty:
 * JavaScript-gate notices, playback-error stubs, consent forms, ©/footer
 * plates and subscription-offer walls all clean "successfully" to a
 * substantial-looking body (9–321 words, one case 1,385 words) that no word
 * count alone can catch. This module adds marker- and structure-based
 * detection for exactly those classes.
 *
 * Design constraints pinned by the audits:
 *  - Raw sentence containment against the live source must NEVER be a
 *    persistence signal: two sampled aggregators dynamically rewrite/translate
 *    article text, so faithful captures can legitimately fail containment.
 *  - A single marker phrase is only trusted when it is unambiguous (gate /
 *    error text). Consent and subscription markers are corroborated with
 *    structure signals (body length, consent-tail share, substantial-paragraph
 *    ratio), because real articles can legitimately quote or embed such text.
 *  - Junk detection never deletes content: it only steers the fetch cascade.
 *    When every engine is exhausted the last body is stored and flagged weak,
 *    exactly like the near-empty path.
 */

/** A junk verdict: `reason` is null when the body looks like a real article. */
export interface JunkVerdict {
  junk: boolean;
  reason: string | null;
}

/**
 * Unambiguous gate/error markers: a cleaned body CONTAINING one of these is a
 * gate/error response, not an article (verified against the 2026-09 audit
 * fixtures: MenAFN JS gate, YouTube playback error, Business Wire error page,
 * Reuters Connect "Reference Error ID" page).
 */
const GATE_MARKERS = [
  'javascript is required',
  'enable javascript before you are allowed',
  'you need to enable javascript',
  "if playback doesn't begin shortly",
  'please be advised that this page is unavailable',
  'reference error id',
];

/**
 * Cookie/consent markers. A consent form that DOMINATES the body (Moneycontrol
 * stored a truncated article followed by a full consent form) is junk; a short
 * banner tail on an otherwise complete article is boilerplate the cleaning
 * pass trims, not a junk verdict.
 */
const CONSENT_MARKERS = [
  'i agree to the updated privacy policy',
  'manage cookie preferences',
  'manage preferences',
  'cookie preferences',
  'we use cookies',
];

/**
 * Subscription-offer markers. Offer walls (FT syndication variant: 1,385 words
 * of "Subscribe to unlock this article — Save 40%…" with zero article text)
 * need TWO distinct markers, or one marker in a short body, so a single
 * legitimate mention never nukes a real article.
 */
const OFFER_MARKERS = [
  'subscribe to unlock',
  'subscribe to continue reading',
  'already a subscriber',
  'choose a subscription',
  'you have reached your limit',
  'limit of free articles',
];

/**
 * Footer/copyright plate markers. Only trusted when the WHOLE body is short
 * and has no substantial paragraph (TradingView 52-word FactSet/ICE footer,
 * CoinDesk 92-word © + disclosure plate, MacroMicro 93-word chart
 * disclaimer). The disclaimer phrases are the PANews SSR footer plate
 * ("Not financial or tax advice… Disclosure… This site is protected by
 * reCAPTCHA.") that Readability can select INSTEAD of the real short brief —
 * the plate leads the body, so the lead-window rule below catches it.
 */
const FOOTER_MARKERS = [
  '©',
  'all rights reserved',
  'copyright',
  'disclosure',
  'not financial or tax advice',
  'protected by recaptcha',
];

/** A paragraph counts as substantial article text at this many chars. */
const SUBSTANTIAL_PARAGRAPH_CHARS = 80;
/** Below this word count a body with no substantial paragraph is scaffolding. */
const THIN_BODY_WORDS = 60;
/** Consent junk ceiling: consent forms on longer bodies are boilerplate tails. */
const CONSENT_MAX_WORDS = 600;
/** Share of the body (by words) the consent tail must dominate to be junk. */
const CONSENT_TAIL_SHARE = 0.4;
/** One offer marker alone is junk only in a short body. */
const OFFER_SINGLE_MAX_WORDS = 150;
/** Footer/copyright-only junk ceiling. */
const FOOTER_MAX_WORDS = 150;

/** Count whitespace-separated words. */
function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/** Collapse whitespace + lowercase so marker matching survives formatting. */
function normText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Substantial-paragraph ratio of the cleaned TEXT: paragraphs of at least
 * SUBSTANTIAL_PARAGRAPH_CHARS chars / total paragraphs. When the content has
 * no paragraph structure at all, a contiguous text blob counts as substantial
 * only from double the threshold (a contiguous 100-char blob can still be a
 * nav/ticker fragment — the DNA India topic-page nav stored as a 17-word
 * "body"); mirrors the looksLikePictureItem blob convention otherwise.
 */
function hasSubstantialParagraph(text: string, content?: string): boolean {
  if (!content) {
    return text.trim().length >= SUBSTANTIAL_PARAGRAPH_CHARS * 2;
  }
  const paras: string[] = [];
  const blocks = content.match(/<(p|h1|h2|h3|h4|h5|h6|li|blockquote)\b[^>]*>[\s\S]*?<\/\1>/gi) ?? [];
  for (const block of blocks) {
    const t = block
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (t) paras.push(t);
  }
  if (paras.length === 0) {
    return text.trim().length >= SUBSTANTIAL_PARAGRAPH_CHARS * 2;
  }
  return paras.some((p) => p.length >= SUBSTANTIAL_PARAGRAPH_CHARS);
}

/**
 * Classify a cleaned article body as junk (gate/error/consent/offer/footer
 * response instead of an article). `text` is the plain text of the cleaned
 * body; `content` is the cleaned HTML (optional, improves paragraph
 * structure signals). Never uses similarity to the live source — marker and
 * structure signals only.
 */
export function looksLikeJunkBody(text: string, content?: string): JunkVerdict {
  const trimmed = text.trim();
  if (!trimmed) return { junk: true, reason: 'empty-body' };

  const words = wordCount(trimmed);
  const norm = normText(trimmed);

  for (const marker of GATE_MARKERS) {
    if (norm.includes(marker)) {
      return { junk: true, reason: `gate-marker: ${marker}` };
    }
  }

  // Structure-thin: a handful of nav/ticker fragments (DNA India stored 17
  // words of topic-page nav) with no substantial paragraph. Real short posts
  // (a complete 85-word brief) have substantial paragraphs and never fire.
  if (words < THIN_BODY_WORDS && !hasSubstantialParagraph(trimmed, content)) {
    return { junk: true, reason: `structure-thin (${words} words, no substantial paragraph)` };
  }
  // Subscription offers: two distinct markers, or one in a short body.
  const offerHits = OFFER_MARKERS.filter((m) => norm.includes(m));
  if (offerHits.length >= 2) {
    return { junk: true, reason: `subscription-offer (${offerHits.length} offer markers)` };
  }
  if (offerHits.length === 1 && words < OFFER_SINGLE_MAX_WORDS) {
    return { junk: true, reason: `subscription-offer (${offerHits[0]} in a ${words}-word body)` };
  }

  // Consent-only / consent-dominated bodies.
  const consentHits = CONSENT_MARKERS.filter((m) => norm.includes(m));
  if (consentHits.length > 0 && words < CONSENT_MAX_WORDS) {
    // The consent TAIL must dominate: everything from the first consent
    // marker onward. A complete article with a small banner tail stays.
    const firstIdx = Math.min(
      ...consentHits.map((m) => norm.indexOf(m)).filter((i) => i >= 0),
    );
    const tailWords = wordCount(norm.slice(firstIdx));
    if (words > 0 && tailWords / words >= CONSENT_TAIL_SHARE) {
      return {
        junk: true,
        reason: `consent-only (consent tail is ${Math.round((tailWords / words) * 100)}% of a ${words}-word body)`,
      };
    }
  }

  // Copyright/footer-only plates: a short body that LEADS with the ©/rights
  // marker (TradingView's FactSet/ICE plate and CoinDesk's ©+disclosure plate
  // both open with it; a real article only ever mentions such text later, in
  // a closing disclosure line — that stays).
  if (words < FOOTER_MAX_WORDS) {
    const footerHit = FOOTER_MARKERS.find((m) => {
      const idx = norm.indexOf(m);
      return idx >= 0 && idx <= 120;
    });
    if (footerHit) {
      return { junk: true, reason: `footer-only (${footerHit} in a ${words}-word body)` };
    }
  }

  return { junk: false, reason: null };
}