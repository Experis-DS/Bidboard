/* Minimal ZIP reader — no dependencies.
   Uses the browser's own DecompressionStream("deflate-raw"), so there is no
   CDN to go stale and nothing to npm-install. Handles the two things a
   /RFP bundle ever contains: stored (method 0) and deflated (method 8) entries.

   Returns a Map of path -> Uint8Array. */

const dv = (b) => new DataView(b.buffer, b.byteOffset, b.byteLength);
const u16 = (b, o) => dv(b).getUint16(o, true);
const u32 = (b, o) => dv(b).getUint32(o, true);

export async function unzip(arrayBuffer) {
  const buf = new Uint8Array(arrayBuffer);

  // End of central directory: scan backwards for the signature.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) {
    if (u32(buf, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("Not a zip file (no end-of-directory record).");

  const count = u16(buf, eocd + 10);
  let p = u32(buf, eocd + 16);
  const out = new Map();

  for (let n = 0; n < count; n++) {
    if (u32(buf, p) !== 0x02014b50) throw new Error("Damaged zip directory.");
    const method = u16(buf, p + 10);
    const compSize = u32(buf, p + 20);
    const nameLen = u16(buf, p + 28);
    const extraLen = u16(buf, p + 30);
    const commentLen = u16(buf, p + 32);
    const localOff = u32(buf, p + 42);
    const name = new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith("/")) continue;                       // directory entry
    if (u32(buf, localOff) !== 0x04034b50) throw new Error(`Damaged entry: ${name}`);
    const lNameLen = u16(buf, localOff + 26);
    const lExtraLen = u16(buf, localOff + 28);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + compSize);

    if (method === 0) { out.set(name, raw.slice()); continue; }
    if (method !== 8) throw new Error(`Unsupported compression in ${name}.`);
    if (typeof DecompressionStream === "undefined")
      throw new Error("This browser can't unzip. Use Chrome, Edge, or Safari 16.4+, or import the pack.json directly.");

    const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    out.set(name, new Uint8Array(await new Response(stream).arrayBuffer()));
  }
  return out;
}

export const asText = (u8) => new TextDecoder().decode(u8);
export const asJson = (u8) => JSON.parse(asText(u8));
