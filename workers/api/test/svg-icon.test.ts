// An SVG icon made safe to keep (src/svg-icon.ts): what of a website's SVG
// stays, what is dropped, and what is not kept at all.
import { describe, expect, it } from 'vitest';
import { safeSvg } from '../src/svg-icon.ts';

const NS = 'http://www.w3.org/2000/svg';
const kept = (svg: string): string | null => {
  const safe = safeSvg(new TextEncoder().encode(svg));
  return safe === null ? null : new TextDecoder().decode(safe);
};

describe('an SVG icon made safe', () => {
  it('keeps the drawing, its styles and same-document links, and drops what comes before the root', () => {
    const svg = `﻿<?xml version="1.0" encoding="UTF-8"?>
<!-- <svg onload="alert(1)"> in a comment is not the root -->
<!DOCTYPE svg [<!ENTITY x "boom">]>
<svg xmlns="${NS}" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 32 32">
  <style><![CDATA[circle { fill: #2745d4 }]]></style>
  <defs><path id="p" d="M0 0h8v8z"/></defs>
  <use xlink:href="#p"/><image href="data:image/png;base64,iVBORw0KGgo=" width="8" height="8"/>
  <circle cx="16" cy="16" r="12" class='a "b"'/>
</svg>
trailing text after the root`;
    expect(kept(svg)).toBe(
      `<svg xmlns="${NS}" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 32 32">
  <style><![CDATA[circle { fill: #2745d4 }]]></style>
  <defs><path id="p" d="M0 0h8v8z"/></defs>
  <use xlink:href="#p"/><image href="data:image/png;base64,iVBORw0KGgo=" width="8" height="8"/>
  <circle cx="16" cy="16" r="12" class="a &quot;b&quot;"/>
</svg>`,
    );
  });

  it('drops scripts, embedded documents, animations, event handlers and links that leave the SVG', () => {
    const svg = `<svg xmlns="${NS}" onload="alert(1)" xml:base="https://example.com/">
<script>alert(1)</script><script href="https://example.com/x.js"/>
<foreignObject><div xmlns="http://www.w3.org/1999/xhtml"><iframe src="https://example.com/"/></div></foreignObject>
<a href="javascript:alert(1)"><rect width="4" height="4" ONCLICK="alert(1)"/></a>
<a href="java&#x73;cript:alert(1)"><circle r="2"/></a>
<set attributeName="href" to="javascript:alert(1)"/><animate attributeName="onclick" values="alert(1)"><g/></animate>
<use href="https://example.com/sprite.svg#icon"/><image href="data:image/svg+xml;base64,PHN2Zz4="/>
<g style="fill: url(javascript:alert(1))"/>
</svg>`;
    const safe = kept(svg)!;
    expect(safe).not.toMatch(/script|alert|onload|onclick|foreignObject|iframe|xml:base|example\.com|svg\+xml/iu);
    expect(safe).toBe(
      `<svg xmlns="${NS}">\n\n\n<a><rect width="4" height="4"/></a>\n<a><circle r="2"/></a>\n\n<use/><image/>\n<g/>\n</svg>`,
    );
  });

  it('gives a root with no namespace the SVG namespace, so it draws as SVG', () => {
    expect(kept('<svg viewBox="0 0 8 8"><rect width="8" height="8"/></svg>')).toBe(
      `<svg xmlns="${NS}" viewBox="0 0 8 8"><rect width="8" height="8"/></svg>`,
    );
  });

  it('keeps nothing that is not a well-formed SVG', () => {
    for (const refused of [
      '<!doctype html><html><head></head><body></body></html>',
      '<script>alert(1)</script>',
      '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"/>',
      `<svg xmlns="${NS}"><g></svg>`,
      `<svg xmlns="${NS}"><g></g>`,
      `<svg xmlns="${NS}"><!ENTITY x "y"></svg>`,
      `<svg xmlns="${NS}" width="1" width="2"/>`,
      `<svg xmlns="${NS}"><rect width=4/></svg>`,
      '<!-- unterminated <svg>',
    ]) {
      expect(kept(refused), refused).toBeNull();
    }
    expect(safeSvg(new Uint8Array([0x3c, 0x73, 0x76, 0x67, 0xff, 0xfe]))).toBeNull();
  });
});
