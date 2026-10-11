import { describe, expect, it } from 'vitest';

import { DEFAULT_LOGO_PATH, letterheadJpegPath } from '@/lib/reports/letterhead';

/**
 * The letterhead mark's path, which comes out of the database and reaches
 * `readFile`.
 *
 * `company_settings.logo_path` is a value an administrator sets. It is not a
 * file name this application chose, so what is done with it is a whitelist
 * rather than an escape — and a whitelist that cannot be read in a test is a
 * control nobody can be sure of, which is why the function lives in a module
 * with no `server-only` marker.
 */
describe('the file a letterhead is drawn from', () => {
  it('is the JPEG beside the configured asset, by the same stem', () => {
    // The web uses the WebP; a PDF embeds a JPEG by passing its bytes through
    // `DCTDecode` and has no path for WebP at all. One stem, two files, so a
    // business that replaces its mark changes one row rather than two places.
    expect(letterheadJpegPath('/brand/polytos-logo.webp')).toBe(
      '/brand/polytos-logo.jpg',
    );
    expect(letterheadJpegPath('/brand/acme.png')).toBe('/brand/acme.jpg');
    expect(letterheadJpegPath('/brand/sub/dir/mark.webp')).toBe(
      '/brand/sub/dir/mark.jpg',
    );
  });

  it('leaves a JPEG alone', () => {
    expect(letterheadJpegPath('/brand/polytos-logo.jpg')).toBe('/brand/polytos-logo.jpg');
  });

  it('falls back to the default for a deployment that has set none', () => {
    expect(letterheadJpegPath(null)).toBe('/brand/polytos-logo.jpg');
    expect(DEFAULT_LOGO_PATH.endsWith('.webp')).toBe(true);
  });

  it('refuses anything that is not a plain path under the public root', () => {
    // Each of these is a value somebody could put in `logo_path`. The
    // consequence of accepting one is reading a file off the server's disk
    // into a document the business hands to people.
    for (const value of [
      '/../../etc/passwd.jpg',
      '/brand/../../etc/passwd.png',
      '../../../etc/passwd.png',
      'brand/relative.webp',
      '',
      '/',
      '/brand/no-extension',
      'http://example.invalid/logo.png',
      'https://example.invalid/logo.png',
      '//example.invalid/logo.png',
      'file:///etc/passwd',
      '/brand/logo.png\u0000.jpg',
      '/brand/$(whoami).png',
      '/brand/`id`.png',
      '/brand/logo;rm -rf.png',
      '/brand/logo .png',
      '/brand/логотип.png',
    ]) {
      expect(letterheadJpegPath(value), JSON.stringify(value)).toBeNull();
    }
  });

  it('never returns a path that climbs out of the public root', () => {
    // The property, rather than a list of payloads: whatever comes back is a
    // single rooted path with no `..` in it, so joining it under `public/`
    // stays under `public/`.
    for (const value of [
      '/brand/polytos-logo.webp',
      '/brand/a/b/c.png',
      '/x.jpeg',
      null,
    ]) {
      const result = letterheadJpegPath(value);

      expect(result, String(value)).not.toBeNull();
      expect(result?.startsWith('/'), String(value)).toBe(true);
      expect(result?.includes('..'), String(value)).toBe(false);
      expect(result?.endsWith('.jpg'), String(value)).toBe(true);
    }
  });
});
