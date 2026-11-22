import { expect, test } from "bun:test";
import { imageSize } from "../src/imageSize.ts";

test("PNG size from the header", () => {
  const png = new Uint8Array(24);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  new DataView(png.buffer).setUint32(16, 544);
  new DataView(png.buffer).setUint32(20, 300);
  expect(imageSize(png)).toEqual({ width: 544, height: 300 });
});

test("JPEG size from the first frame marker, skipping other segments", () => {
  const jpeg = new Uint8Array([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46, // a short APP0 segment
    0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0xe2, 0x00, 0xe2, 0x03, // SOF0: height 226, width 226
  ]);
  expect(imageSize(jpeg)).toEqual({ width: 226, height: 226 });
});

test("anything else is unknown", () => {
  expect(imageSize(new Uint8Array([1, 2, 3, 4]))).toBeNull();
  expect(imageSize(new Uint8Array(0))).toBeNull();
});

import { bigArt } from "../src/ytmArt.ts";

test("YouTube Music cover addresses are asked for at full size", () => {
  expect(bigArt("https://lh3.googleusercontent.com/abc123=w226-h226-l90-rj")).toBe("https://lh3.googleusercontent.com/abc123=w1200-h1200-l90-rj");
  expect(bigArt("https://lh3.googleusercontent.com/abc123=s120")).toBe("https://lh3.googleusercontent.com/abc123=w1200-h1200-l90-rj");
  expect(bigArt("https://lh3.googleusercontent.com/abc123")).toBe("https://lh3.googleusercontent.com/abc123=w1200-h1200-l90-rj");
  expect(bigArt("https://i.ytimg.com/vi/x/hq720.jpg")).toBeUndefined();
  expect(bigArt(undefined)).toBeUndefined();
  expect(bigArt("not a url")).toBeUndefined();
});
