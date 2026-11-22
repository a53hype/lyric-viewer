/**
 * YouTube Music's cover address at full size. Its thumbnails are served by Google's image host and the size
 * is the tail of the address ("=w226-h226-l90-rj"); asking for a bigger one gives the same picture sharper.
 * Anything else (a video's frame from i.ytimg.com, say) is not a square cover and is left out.
 */
export function bigArt(url: string | undefined): string | undefined {
  if (!url) return undefined;
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    return undefined;
  }
  if (!/^(?:lh\d|yt\d)\.googleusercontent\.com$/.test(host)) return undefined;
  const sized = /=(?:[wsh]\d+)[^/]*$/;
  return sized.test(url) ? url.replace(sized, "=w1200-h1200-l90-rj") : `${url}=w1200-h1200-l90-rj`;
}
