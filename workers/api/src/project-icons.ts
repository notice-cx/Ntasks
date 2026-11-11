/**
 * A project's icon, read from its website when an owner sets the website.
 * The Worker reads it, never the browser: one GET of the page, whose head's
 * <link rel="apple-touch-icon"> and <link rel="icon"> tags name the
 * candidates, then a GET of each candidate in turn, ending with
 * /favicon.ico, until one is an image this Worker can serve.
 *
 * Every read is http or https only, follows redirects by hand (at most five,
 * each to an http or https address that is not a local one), sends no
 * cookie, and stops at READ_TIMEOUT_MS for the whole search. A page is read
 * to the end of its head, at most PAGE_BYTE_LIMIT bytes; an icon at most
 * PROJECT_ICON_MAX_BYTES. An icon is kept only when its own bytes are a PNG,
 * ICO, JPEG, GIF or WebP image, and is served with the type those bytes
 * show, never the type the website claimed: an SVG, which can run script, is
 * never kept.
 */
import { PROJECT_ICON_MAX_BYTES, type ProjectIcon, type ProjectIconType } from '@ntasks/domain';

/** Honest identification, with a product token of its own. */
export const ICON_USER_AGENT = 'Ntasks-Icons/1.0 (+https://ntasks.notice.cx; project icon read)';

/** The whole search: the page and every candidate. */
const READ_TIMEOUT_MS = 8_000;
/** The head is at the top of the page; nothing past this is read. */
const PAGE_BYTE_LIMIT = 256 * 1024;
const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
/** At most this many candidates are asked, /favicon.ico included. */
const MAX_CANDIDATES = 5;
const MAX_URL_LENGTH = 2048;
/** A declared size under this is a last resort: too small to draw sharply. */
const LARGE_PX = 32;
/** What an apple-touch-icon with no sizes attribute usually is. */
const APPLE_TOUCH_PX = 180;

type IconKind = 'icon' | 'apple-touch-icon';

interface DeclaredIcon {
  readonly kind: IconKind;
  readonly href: string;
  readonly sizes: string | null;
  readonly type: string | null;
}

// --- addresses --------------------------------------------------------------

/** A host this Worker never asks: the machine itself, a private network, or a link-local address. */
function localHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/gu, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal'))
    return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (host.includes(':')) {
    return (
      host === '::' || host === '::1' || /^f[cd]/u.test(host) || /^fe[89ab]/u.test(host) || host.startsWith('::ffff:')
    );
  }
  return false;
}

/** An http(s) address that is not a local one, resolved against `base`; null for anything else. */
function webAddress(href: string, base?: string | URL): string | null {
  let url: URL;
  try {
    url = new URL(href.trim(), base);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username !== '' || url.password !== '' || localHost(url.hostname)) return null;
  url.hash = '';
  return url.href.length > MAX_URL_LENGTH ? null : url.href;
}

/**
 * The website an owner typed, as the URL standard writes it, or null when it
 * is not one this Worker reads: `example.com` is read as https://example.com/.
 */
export function websiteAddress(input: string): string | null {
  const typed = input.trim();
  if (typed === '' || /[\s\u0000-\u001f\u007f]/u.test(typed)) return null;
  return webAddress(/^[a-z][a-z0-9+.-]*:/iu.test(typed) ? typed : `https://${typed}`);
}

// --- the page's head ----------------------------------------------------------

const COMMENT = /<!--[\s\S]*?-->/gu;
/** Elements whose text is never markup: a `<link>` inside one is a string. */
const RAW_TEXT = /<(script|style|template|textarea|title)\b[^>]*>[\s\S]*?<\/\1\s*>/giu;
/** Where the head ends, or an element a truncated read left open. */
const HEAD_END = /<\/head\s*>|<body[\s>]|<script\b/iu;
/** A `<link>` or `<base>` tag; a quoted value may hold a `>`. */
const TAG = /<(link|base)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/giu;
const ATTRIBUTE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gu;
const NAMED_REFERENCES: Readonly<Record<string, string>> = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' };

function codePoint(value: number): string | null {
  return Number.isInteger(value) && value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : null;
}

/** The few character references an address carries. */
function decodeAttribute(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt);/giu, (match, ref: string) => {
    const lower = ref.toLowerCase();
    if (lower.startsWith('#x')) return codePoint(Number.parseInt(lower.slice(2), 16)) ?? match;
    if (lower.startsWith('#')) return codePoint(Number.parseInt(lower.slice(1), 10)) ?? match;
    return NAMED_REFERENCES[lower] ?? match;
  });
}

/** A tag's attributes by lower-case name; the first of a repeated name counts, as in a browser. */
function attributesOf(source: string): Map<string, string> {
  const attributes = new Map<string, string>();
  for (const match of source.matchAll(ATTRIBUTE)) {
    const name = match[1]!.toLowerCase();
    if (!attributes.has(name)) attributes.set(name, decodeAttribute(match[2] ?? match[3] ?? match[4] ?? ''));
  }
  return attributes;
}

function iconKind(rel: string): IconKind | null {
  const tokens = rel.toLowerCase().split(/\s+/u);
  if (tokens.includes('apple-touch-icon') || tokens.includes('apple-touch-icon-precomposed')) return 'apple-touch-icon';
  if (tokens.includes('icon')) return 'icon';
  return null;
}

/** The largest edge a `sizes` attribute declares, in pixels; null for none or `any`. */
function largestSize(sizes: string | null): number | null {
  let largest: number | null = null;
  for (const token of (sizes ?? '').split(/\s+/u)) {
    const match = /^(\d+)[xX](\d+)$/u.exec(token);
    if (!match) continue;
    const edge = Math.max(Number(match[1]), Number(match[2]));
    if (largest === null || edge > largest) largest = edge;
  }
  return largest;
}

function isSvg(icon: DeclaredIcon): boolean {
  return /svg/iu.test(icon.type ?? '') || /\.svgz?(?:[?#]|$)/iu.test(icon.href.trim());
}

/**
 * Lower is better: an apple-touch-icon or an icon of 32 px or more, largest
 * first; then an icon with no declared size; then one under 32 px. Document
 * order breaks a tie.
 */
function rank(icon: DeclaredIcon): [number, number] {
  const size = largestSize(icon.sizes) ?? (icon.kind === 'apple-touch-icon' ? APPLE_TOUCH_PX : null);
  if (size === null) return [1, 0];
  return size >= LARGE_PX ? [0, -size] : [2, -size];
}

/**
 * The icons a page's head declares, best first, each as an absolute address
 * resolved against its `<base href>` or else `pageUrl`, the address the page
 * was read from. SVG icons are left out.
 */
export function declaredIcons(html: string, pageUrl: string): string[] {
  const text = html.replace(COMMENT, '').replace(RAW_TEXT, '');
  const end = text.search(HEAD_END);
  const head = end === -1 ? text : text.slice(0, end);
  let base: string | null = null;
  const icons: { url: string; rank: [number, number]; index: number }[] = [];
  const declared: DeclaredIcon[] = [];
  for (const match of head.matchAll(TAG)) {
    const attributes = attributesOf(match[2] ?? '');
    const href = attributes.get('href');
    if (match[1]!.toLowerCase() === 'base') {
      if (base === null && href !== undefined) base = webAddress(href, pageUrl);
      continue;
    }
    const kind = iconKind(attributes.get('rel') ?? '');
    if (kind === null || href === undefined || href.trim() === '') continue;
    declared.push({ kind, href, sizes: attributes.get('sizes') ?? null, type: attributes.get('type') ?? null });
  }
  declared.forEach((icon, index) => {
    if (isSvg(icon)) return;
    const url = webAddress(icon.href, base ?? pageUrl);
    if (url !== null) icons.push({ url, rank: rank(icon), index });
  });
  icons.sort((a, b) => a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1] || a.index - b.index);
  return [...new Set(icons.map((icon) => icon.url))];
}

// --- the bytes ----------------------------------------------------------------

/** The raster type `bytes` hold, read from their first bytes; null for any other content, SVG included. */
export function sniffIcon(bytes: Uint8Array): ProjectIconType | null {
  const starts = (...signature: number[]) => signature.every((byte, index) => bytes[index] === byte);
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (starts(0x00, 0x00, 0x01, 0x00) && bytes.length > 6) return 'image/x-icon';
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (starts(0x47, 0x49, 0x46, 0x38)) return 'image/gif';
  if (
    starts(0x52, 0x49, 0x46, 0x46) &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  )
    return 'image/webp';
  return null;
}

/** Whether the type a website claimed for an icon may be a raster image; the bytes decide. */
function rasterClaim(contentType: string | null): boolean {
  const type = (contentType ?? '').split(';')[0]!.trim().toLowerCase();
  if (type.includes('svg')) return false;
  return type === '' || type.startsWith('image/') || type === 'application/octet-stream';
}

/** Up to `limit` bytes of the body; null when it holds more. A failure part-way keeps what arrived. */
async function readBody(response: Response, limit: number): Promise<Uint8Array | null> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } catch {
    // What arrived before the failure is all there is.
  }
  const bytes = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}

/** The page's text up to the end of its head, at most PAGE_BYTE_LIMIT bytes. */
async function readHead(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  try {
    while (bytes < PAGE_BYTE_LIMIT) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      const chunk = value.byteLength > PAGE_BYTE_LIMIT - bytes ? value.subarray(0, PAGE_BYTE_LIMIT - bytes) : value;
      bytes += chunk.byteLength;
      // A tag split across two chunks is found from a few characters back.
      const from = Math.max(0, text.length - 16);
      text += decoder.decode(chunk, { stream: true });
      if (/<\/head\s*>|<body[\s>]/iu.test(text.slice(from))) break;
    }
  } catch {
    return text;
  }
  await reader.cancel().catch(() => undefined);
  return text;
}

// --- the reads ----------------------------------------------------------------

/** One GET, redirects followed by hand; the final answer and its address, or null. Never throws. */
async function get(
  fetchImpl: typeof fetch,
  start: string,
  accept: string,
  signal: AbortSignal,
): Promise<{ readonly url: string; readonly response: Response } | null> {
  let url = start;
  try {
    for (let redirects = 0; ; redirects += 1) {
      const response = await fetchImpl(url, {
        method: 'GET',
        headers: { accept, 'user-agent': ICON_USER_AGENT },
        redirect: 'manual',
        signal,
      });
      const location = REDIRECT_STATUSES.has(response.status) ? response.headers.get('location') : null;
      if (location === null) {
        if (response.ok) return { url, response };
        await response.body?.cancel();
        return null;
      }
      await response.body?.cancel();
      const next = webAddress(location, url);
      if (next === null || redirects === MAX_REDIRECTS) return null;
      url = next;
    }
  } catch {
    return null;
  }
}

async function readIcon(fetchImpl: typeof fetch, candidate: string, signal: AbortSignal): Promise<ProjectIcon | null> {
  const answer = await get(fetchImpl, candidate, 'image/*', signal);
  if (answer === null) return null;
  const { url, response } = answer;
  const declared = Number(response.headers.get('content-length'));
  if (!rasterClaim(response.headers.get('content-type')) || declared > PROJECT_ICON_MAX_BYTES) {
    await response.body?.cancel();
    return null;
  }
  const bytes = await readBody(response, PROJECT_ICON_MAX_BYTES);
  const contentType = bytes === null || bytes.byteLength === 0 ? null : sniffIcon(bytes);
  if (bytes === null || contentType === null) return null;
  return { sourceUrl: url, contentType, bytes: bytes.slice().buffer };
}

/**
 * The icon of the website at `websiteUrl`, an address `websiteAddress`
 * accepted, or null when it serves none this Worker keeps. Never throws.
 */
export async function readProjectIcon(
  websiteUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ProjectIcon | null> {
  const signal = AbortSignal.timeout(READ_TIMEOUT_MS);
  const page = await get(fetchImpl, websiteUrl, 'text/html,application/xhtml+xml', signal);
  let pageUrl = websiteUrl;
  let candidates: string[] = [];
  if (page !== null) {
    pageUrl = page.url;
    const type = page.response.headers.get('content-type') ?? '';
    if (/html/iu.test(type) || type === '') candidates = declaredIcons(await readHead(page.response), page.url);
    else await page.response.body?.cancel();
  }
  // /favicon.ico is always asked, last unless the page declares it, however many icons the page declares.
  const favicon = webAddress('/favicon.ico', pageUrl);
  candidates = candidates.slice(0, MAX_CANDIDATES - 1);
  if (favicon !== null && !candidates.includes(favicon)) candidates.push(favicon);
  for (const candidate of candidates) {
    if (signal.aborted) return null;
    const icon = await readIcon(fetchImpl, candidate, signal);
    if (icon !== null) return icon;
  }
  return null;
}
