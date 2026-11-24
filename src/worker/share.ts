/** index.html with its link-preview addresses pointing at the install that serves it: previews need a full URL that works. */
export async function sharePage(index: Response, url: string, path: string): Promise<{ html: string; headers: Headers }> {
  const { origin } = new URL(url);
  const headers = new Headers(index.headers);
  // They describe the stored file, not this one.
  for (const h of ['Content-Length', 'ETag', 'Last-Modified']) headers.delete(h);
  const html = (await index.text())
    .replace(/https:\/\/datamonster\.dev\/og-image\.png/g, () => `${origin}/og-image.png`)
    .replace(/(<meta property="og:url" content=")[^"]*/, (_, a: string) => `${a}${origin}${path}`);
  return { html, headers };
}
