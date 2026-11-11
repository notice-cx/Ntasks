// A project's icon, read from its website (src/project-icons.ts): which
// declared icon is chosen, what is never kept, and how far a read goes. Every
// read goes to an invented website below; none reaches the network.
import { PROJECT_ICON_MAX_BYTES } from '@ntasks/domain';
import { describe, expect, it } from 'vitest';
import { declaredIcons, readProjectIcon, sniffIcon, websiteAddress } from '../src/project-icons.ts';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const ICO = new Uint8Array([0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x10, 0x10]);
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

type Answer = Response | (() => Response);

/** A fetch that answers only the addresses in `site`, and records every address asked. */
function website(site: Readonly<Record<string, Answer>>) {
  const asked: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = new Request(input).url;
    asked.push(url);
    const answer = site[url];
    if (answer === undefined) return new Response('Not Found', { status: 404 });
    return typeof answer === 'function' ? answer() : answer.clone();
  }) as typeof fetch;
  return { fetchImpl, asked };
}

const page = (head: string) =>
  new Response(`<!doctype html><html><head>${head}</head><body><link rel="icon" href="/body.png"></body></html>`, {
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
const image = (bytes: Uint8Array, type: string) => new Response(bytes, { headers: { 'content-type': type } });
const redirect = (location: string) => new Response(null, { status: 301, headers: { location } });

describe('the icons a page declares', () => {
  it('ranks apple-touch-icons and large icons by size, then icons of no size, then small ones, leaving SVG out', () => {
    const html = `
      <link rel="icon" href="/16.png" sizes="16x16">
      <link rel="icon" href="/any.ico">
      <link rel="icon" type="image/svg+xml" href="/mark.svg">
      <link rel="icon" href="/vector.svg?v=2">
      <link rel="apple-touch-icon" href="/touch.png">
      <link rel="icon" href="/192.png" sizes="192x192">
      <link rel="shortcut icon" href="/48.png" sizes="48x48">
      <!-- <link rel="icon" href="/commented.png" sizes="512x512"> -->
      <script>document.write('<link rel="icon" href="/scripted.png" sizes="512x512">')</script>`;
    expect(declaredIcons(html, 'https://example.com/app/')).toEqual([
      'https://example.com/192.png',
      'https://example.com/touch.png',
      'https://example.com/48.png',
      'https://example.com/any.ico',
      'https://example.com/16.png',
    ]);
  });

  it('resolves each against the page’s base and keeps only web addresses', () => {
    const html = `<base href="https://cdn.example.com/assets/">
      <link rel="icon" href="icon.png" sizes="64x64">
      <link rel="icon" href="data:image/png;base64,AAAA" sizes="128x128">
      <link rel="icon" href="javascript:alert(1)" sizes="128x128">
      <link rel="icon" href="http://localhost/icon.png" sizes="128x128">`;
    expect(declaredIcons(html, 'https://example.com/')).toEqual(['https://cdn.example.com/assets/icon.png']);
  });
});

describe('a website address an owner types', () => {
  it('reads a bare domain as https and refuses anything that is not a public web address', () => {
    expect(websiteAddress(' example.com ')).toBe('https://example.com/');
    expect(websiteAddress('http://example.com/shop')).toBe('http://example.com/shop');
    for (const refused of [
      '',
      'ftp://example.com/',
      'javascript:alert(1)',
      'https://user:secret@example.com/',
      'http://localhost:8787/',
      'http://127.0.0.1/',
      'http://10.0.0.8/',
      'http://192.168.1.1/',
      'http://[::1]/',
      'https://exa mple.com/',
    ]) {
      expect(websiteAddress(refused), refused).toBeNull();
    }
  });
});

describe('the bytes of an icon', () => {
  it('are kept only as the raster type they show, whatever the website claims', () => {
    expect(sniffIcon(PNG)).toBe('image/png');
    expect(sniffIcon(ICO)).toBe('image/x-icon');
    expect(sniffIcon(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffIcon(SVG)).toBeNull();
    expect(sniffIcon(new TextEncoder().encode('<!doctype html>'))).toBeNull();
  });
});

describe('reading a website’s icon', () => {
  it('keeps the best declared icon, with the type its bytes show and the address it came from', async () => {
    const { fetchImpl, asked } = website({
      'https://example.com/': page(
        '<link rel="icon" href="/small.png" sizes="16x16"><link rel="apple-touch-icon" href="/touch">',
      ),
      'https://example.com/touch': image(PNG, 'application/octet-stream'),
      'https://example.com/small.png': image(PNG, 'image/png'),
    });
    const icon = await readProjectIcon('https://example.com/', fetchImpl);
    expect(icon).toMatchObject({ sourceUrl: 'https://example.com/touch', contentType: 'image/png' });
    expect(new Uint8Array(icon!.bytes)).toEqual(PNG);
    expect(asked).toEqual(['https://example.com/', 'https://example.com/touch']);
  });

  it('skips an SVG, whatever type it is served as, and falls back to /favicon.ico', async () => {
    const { fetchImpl } = website({
      'https://example.com/': page('<link rel="apple-touch-icon" href="/touch.png">'),
      'https://example.com/touch.png': image(SVG, 'image/png'),
      'https://example.com/favicon.ico': image(ICO, 'image/vnd.microsoft.icon'),
    });
    expect(await readProjectIcon('https://example.com/', fetchImpl)).toMatchObject({
      sourceUrl: 'https://example.com/favicon.ico',
      contentType: 'image/x-icon',
    });
  });

  it('follows the website’s redirects and reads its icons from where the page is', async () => {
    const { fetchImpl } = website({
      'http://example.com/': redirect('https://www.example.com/'),
      'https://www.example.com/': page('<link rel="icon" href="icon.png" sizes="32x32">'),
      'https://www.example.com/icon.png': () => redirect('/static/icon.png'),
      'https://www.example.com/static/icon.png': image(PNG, 'image/png'),
    });
    expect(await readProjectIcon('http://example.com/', fetchImpl)).toMatchObject({
      sourceUrl: 'https://www.example.com/static/icon.png',
    });
  });

  it('stops after five redirects, and never follows one to a local address', async () => {
    const loop: Record<string, Answer> = {};
    for (let hop = 0; hop < 7; hop += 1) loop[`https://example.com/${hop}`] = redirect(`/${hop + 1}`);
    loop['https://example.com/7'] = page('');
    const looping = website(loop);
    expect(await readProjectIcon('https://example.com/0', looping.fetchImpl)).toBeNull();
    expect(looping.asked.filter((url) => /\/\d$/u.test(url))).toHaveLength(6);

    const local = website({
      'https://example.com/': page('<link rel="icon" href="/icon.png">'),
      'https://example.com/icon.png': redirect('http://169.254.169.254/latest/meta-data'),
    });
    expect(await readProjectIcon('https://example.com/', local.fetchImpl)).toBeNull();
    expect(local.asked).not.toContain('http://169.254.169.254/latest/meta-data');
  });

  it('refuses an icon too large to keep, and a page served where an icon was expected', async () => {
    const large = new Uint8Array(PROJECT_ICON_MAX_BYTES + 1);
    large.set(PNG);
    const { fetchImpl } = website({
      'https://example.com/': page('<link rel="icon" href="/large.png" sizes="512x512">'),
      'https://example.com/large.png': image(large, 'image/png'),
      'https://example.com/favicon.ico': page(''),
    });
    expect(await readProjectIcon('https://example.com/', fetchImpl)).toBeNull();
  });

  it('skips an icon whose read fails part-way, so a cut-off image is never kept', async () => {
    // The first read hands over a valid PNG start; the next one fails, as a dropped connection does.
    const cutOff = () => {
      let reads = 0;
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (reads++ === 0) controller.enqueue(PNG);
            else controller.error(new TypeError('connection reset'));
          },
        }),
        { headers: { 'content-type': 'image/png' } },
      );
    };
    const { fetchImpl } = website({
      'https://example.com/': page('<link rel="icon" href="/cut.png" sizes="64x64">'),
      'https://example.com/cut.png': cutOff,
      'https://example.com/favicon.ico': image(ICO, 'image/x-icon'),
    });
    expect(await readProjectIcon('https://example.com/', fetchImpl)).toMatchObject({
      sourceUrl: 'https://example.com/favicon.ico',
    });
  });

  it('asks /favicon.ico when the website’s page does not answer', async () => {
    const { fetchImpl } = website({
      'https://example.com/': new Response('Unavailable', { status: 503 }),
      'https://example.com/favicon.ico': image(ICO, 'image/x-icon'),
    });
    expect(await readProjectIcon('https://example.com/', fetchImpl)).toMatchObject({ contentType: 'image/x-icon' });
  });

  it('keeps nothing from a website with no icon, and never throws when the network fails', async () => {
    expect(
      await readProjectIcon('https://example.com/', website({ 'https://example.com/': page('') }).fetchImpl),
    ).toBeNull();
    const failing = (async () => {
      throw new TypeError('network connection lost');
    }) as typeof fetch;
    expect(await readProjectIcon('https://example.com/', failing)).toBeNull();
  });
});
