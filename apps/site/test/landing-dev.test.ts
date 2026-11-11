import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const site = fileURLToPath(new URL('../', import.meta.url));

/** Every URL the page's img src and source srcset attributes name. */
function imageUrls(html: string): string[] {
  const urls: string[] = [];
  for (const [, attribute, value = ''] of html.matchAll(/<(?:img|source)\b[^>]*?\s(src|srcset)="([^"]*)"/gu)) {
    if (attribute === 'src') urls.push(value);
    else urls.push(...value.split(',').map((candidate) => candidate.trim().split(/\s+/u)[0] ?? ''));
  }
  return urls.filter((url) => url !== '');
}

test("the landing page's dev server serves every image the page names", async () => {
  const server = await createServer({
    root: site,
    configFile: `${site}vite.config.ts`,
    logLevel: 'silent',
    server: { port: 0, strictPort: true, host: '127.0.0.1', hmr: false, watch: null },
  });
  try {
    await server.listen();
    const origin = server.resolvedUrls?.local[0];
    assert.ok(origin);
    const html = await (await fetch(origin)).text();
    const images = imageUrls(html)
      .map((url) => new URL(url, origin))
      .filter((url) => url.origin === new URL(origin).origin);
    assert.ok(images.length > 0);
    for (const image of images) {
      const response = await fetch(image);
      await response.arrayBuffer();
      assert.equal(response.status, 200, image.pathname);
      assert.match(response.headers.get('content-type') ?? '', /^image\//u, image.pathname);
    }
  } finally {
    await server.close();
  }
});
