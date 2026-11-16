export type Sniffed = { mime: string; ext: string };

/** Flow rejects non image/* content types, and Go multipart clients send application/octet-stream. */
export function sniffImage(buf: Buffer, fallbackMime = ""): Sniffed {
  if (buf.length > 8) {
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return { mime: "image/png", ext: "png" };
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: "image/jpeg", ext: "jpg" };
    if (buf.subarray(0, 4).toString() === "RIFF" && buf.subarray(8, 12).toString() === "WEBP") return { mime: "image/webp", ext: "webp" };
    if (buf.subarray(0, 4).toString() === "GIF8") return { mime: "image/gif", ext: "gif" };
  }
  if (fallbackMime.startsWith("image/")) return { mime: fallbackMime, ext: (fallbackMime.split("/")[1] || "png").replace("jpeg", "jpg") };
  return { mime: "image/png", ext: "png" };
}

export function filenameFor(name: string | undefined, ext: string): string {
  const base = (name || "image").replace(/\.[^.]+$/, "");
  return (base || "image") + "." + ext;
}
