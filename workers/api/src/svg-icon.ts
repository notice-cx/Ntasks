/**
 * An SVG icon made safe to keep: the drawing a website's SVG holds, without
 * anything that runs or reaches outside it. The Worker serves the result
 * with a content security policy that sandboxes it as well
 * (`ICON_SECURITY_POLICY`), and the web app draws it only in `<img>`, where
 * a browser runs no script and loads nothing else; this removal is the layer
 * under both.
 *
 * The SVG is read as XML, tag by tag. What comes before its `<svg>` root (the
 * XML declaration, comments, a document type and the entities it declares)
 * is dropped, and so is anything after the root ends. Inside it, comments,
 * processing instructions and these elements with all they hold are dropped:
 * `script`, `foreignObject`, elements that embed another document or media,
 * and the animation elements, which can change an attribute after this
 * removal. On every element that stays, event-handler attributes (`on…`),
 * `xml:base`, any value naming `javascript:`, and any link (`href`,
 * `xlink:href`) that is not to a part of the same SVG (`#id`) or to a PNG,
 * JPEG, GIF or WebP `data:` image are dropped. An SVG that is not
 * well-formed enough to read this way is not kept.
 */

/** Elements dropped with everything inside them, by local name in lower case. */
const DROPPED = new Set([
  'script',
  'foreignobject',
  'iframe',
  'embed',
  'object',
  'audio',
  'video',
  'handler',
  'listener',
  'set',
  'animate',
  'animatemotion',
  'animatetransform',
  'animatecolor',
  'discard',
]);

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const NAME = /^[A-Za-z_][\w.:-]*/u;
/** One attribute, which XML always quotes. */
const ATTRIBUTE = /^\s+([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/u;
const SAFE_LINK = /^(?:#|data:image\/(?:png|jpeg|gif|webp)[;,])/iu;

/** Where the `<svg` root starts, after an optional BOM, XML declaration, comments and document type; -1 when there is none. */
function svgRootAt(text: string): number {
  let at = text.startsWith('\uFEFF') ? 1 : 0;
  for (;;) {
    while (at < text.length && /\s/u.test(text[at]!)) at += 1;
    const rest = text.slice(at);
    let end: number;
    if (rest.startsWith('<?')) end = rest.indexOf('?>') + 2;
    else if (rest.startsWith('<!--')) end = rest.indexOf('-->') + 3;
    else if (/^<!DOCTYPE/iu.test(rest)) end = doctypeEnd(rest);
    else return /^<svg[\s>/]/u.test(rest) ? at : -1;
    // indexOf answered -1: the part never ends.
    if (end <= 2) return -1;
    at += end;
  }
}

/** Where a `<!DOCTYPE …>` that starts `text` ends, its internal subset in brackets included; -1 when it does not. */
function doctypeEnd(text: string): number {
  let inSubset = false;
  for (let index = 2; index < text.length; index += 1) {
    const char = text[index];
    if (char === '[') inSubset = true;
    else if (char === ']') inSubset = false;
    else if (char === '>' && !inSubset) return index + 1;
  }
  return -1;
}

/** An attribute value as a browser reads it, for the checks: the few character references decoded, whitespace dropped. */
function readValue(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);?/giu, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16) || 0x20))
    .replace(/&#(\d+);?/gu, (_, decimal: string) => String.fromCodePoint(Number(decimal) || 0x20))
    .replace(/&(?:colon);/giu, ':')
    .replace(/[\s\u0000-\u001f]/gu, '');
}

function localName(name: string): string {
  return name.slice(name.indexOf(':') + 1).toLowerCase();
}

/** Whether an attribute stays on an element that stays. */
function keptAttribute(name: string, value: string): boolean {
  const local = localName(name);
  if (local.startsWith('on') || name.toLowerCase() === 'xml:base') return false;
  const read = readValue(value);
  if (/javascript:/iu.test(read)) return false;
  if (local === 'href' || local === 'src') return SAFE_LINK.test(read);
  return true;
}

/**
 * The SVG `bytes` hold, made safe as this module's comment describes, as
 * UTF-8; null when they are not an SVG, or one this reading cannot make safe.
 */
export function safeSvg(bytes: Uint8Array): Uint8Array | null {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }
  const root = svgRootAt(text);
  if (root === -1) return null;
  let rest = text.slice(root);
  let out = '';
  const open: string[] = [];
  /** The depth of `open` at which a dropped element started; its content is dropped until it ends. */
  let droppedAt: number | null = null;
  const keep = (part: string) => {
    if (droppedAt === null) out += part;
  };

  while (rest !== '') {
    if (!rest.startsWith('<')) {
      const next = rest.indexOf('<');
      const textPart = next === -1 ? rest : rest.slice(0, next);
      if (open.length === 0) {
        if (textPart.trim() !== '') return null;
      } else keep(textPart);
      rest = next === -1 ? '' : rest.slice(next);
      continue;
    }
    if (rest.startsWith('<!--')) {
      const end = rest.indexOf('-->');
      if (end === -1) return null;
      rest = rest.slice(end + 3);
      continue;
    }
    if (rest.startsWith('<![CDATA[')) {
      const end = rest.indexOf(']]>');
      if (end === -1 || open.length === 0) return null;
      keep(rest.slice(0, end + 3));
      rest = rest.slice(end + 3);
      continue;
    }
    if (rest.startsWith('<?')) {
      const end = rest.indexOf('?>');
      if (end === -1) return null;
      rest = rest.slice(end + 2);
      continue;
    }
    // A declaration inside the root, such as a second DOCTYPE or an ENTITY, is never valid SVG.
    if (rest.startsWith('<!')) return null;

    if (rest.startsWith('</')) {
      const match = /^<\/([A-Za-z_][\w.:-]*)\s*>/u.exec(rest);
      if (!match || open.at(-1) !== match[1]) return null;
      open.pop();
      if (droppedAt !== null && open.length === droppedAt) droppedAt = null;
      else keep(match[0]);
      rest = rest.slice(match[0].length);
      if (open.length === 0) break;
      continue;
    }

    const name = NAME.exec(rest.slice(1))?.[0];
    if (name === undefined) return null;
    let at = 1 + name.length;
    const attributes: string[] = [];
    const names = new Set<string>();
    for (;;) {
      const attribute = ATTRIBUTE.exec(rest.slice(at));
      if (!attribute) break;
      at += attribute[0].length;
      const attributeName = attribute[1]!;
      // A repeated attribute makes the XML ill-formed.
      if (names.has(attributeName)) return null;
      names.add(attributeName);
      const value = attribute[2] ?? (attribute[3] ?? '').replaceAll('"', '&quot;');
      if (keptAttribute(attributeName, value)) attributes.push(` ${attributeName}="${value}"`);
    }
    const close = /^\s*(\/?)>/u.exec(rest.slice(at));
    if (!close) return null;
    rest = rest.slice(at + close[0].length);
    const selfClosing = close[1] === '/';
    if (open.length === 0) {
      if (name !== 'svg') return null;
      // A root with no namespace draws as an XML error, not as an SVG.
      if (!names.has('xmlns')) attributes.unshift(` xmlns="${SVG_NAMESPACE}"`);
    }
    if (droppedAt === null && DROPPED.has(localName(name))) {
      if (open.length === 0) return null;
      if (!selfClosing) droppedAt = open.length;
    } else keep(`<${name}${attributes.join('')}${selfClosing ? '/>' : '>'}`);
    if (selfClosing) {
      if (open.length === 0) break;
    } else open.push(name);
  }
  if (open.length !== 0 || out === '') return null;
  return new TextEncoder().encode(out);
}

/**
 * What the icon route sends with every icon: nothing loads but inline styles
 * and `data:` images, and the sandbox gives a page that opens the icon's
 * address directly no script and no origin of its own.
 */
export const ICON_SECURITY_POLICY = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox";
