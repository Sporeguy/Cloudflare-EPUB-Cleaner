export default {
  async fetch(request) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': '*',
        }
      });
    }

    if (request.method !== 'POST') {
      return new Response('POST an EPUB file as the request body.', { status: 200 });
    }

    try {
      const inputBytes = new Uint8Array(await request.arrayBuffer());
      const outputBytes = await processZip(inputBytes);
      return new Response(outputBytes, {
        headers: {
          'Content-Type': 'application/epub+zip',
          'Access-Control-Allow-Origin': '*',
        }
      });
    } catch (err) {
      return new Response('Error: ' + err.message + '\n' + err.stack, {
        status: 500,
        headers: { 'Access-Control-Allow-Origin': '*' }
      });
    }
  }
};

// ── ZIP constants ────────────────────────────────────────────────────────────
const SIG_LOCAL  = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD   = 0x06054b50;
const METHOD_STORE   = 0;
const METHOD_DEFLATE = 8;

const TEXT_EXTS = /\.(html|htm|xhtml|xml|opf|ncx|css|txt|js)$/i;

// ── Helpers ──────────────────────────────────────────────────────────────────
function readU16(buf, off) {
  return buf[off] | (buf[off+1] << 8);
}
function readU32(buf, off) {
  return (buf[off] | (buf[off+1] << 8) | (buf[off+2] << 16) | (buf[off+3] << 24)) >>> 0;
}
function writeU16(buf, off, val) {
  buf[off]   = val & 0xff;
  buf[off+1] = (val >>> 8) & 0xff;
}
function writeU32(buf, off, val) {
  buf[off]   = val & 0xff;
  buf[off+1] = (val >>> 8) & 0xff;
  buf[off+2] = (val >>> 16) & 0xff;
  buf[off+3] = (val >>> 24) & 0xff;
}

async function inflate(compressed) {
  const ds = new DecompressionStream('deflate-raw');
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader();
  writer.write(compressed);
  writer.close();
  const chunks = [];
  let totalLen = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    totalLen += value.length;
  }
  const out = new Uint8Array(totalLen);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
  return out;
}

async function deflate(raw) {
  const cs = new CompressionStream('deflate-raw');
  const writer = cs.writable.getWriter();
  const reader = cs.readable.getReader();
  writer.write(raw);
  writer.close();
  const chunks = [];
  let totalLen = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    totalLen += value.length;
  }
  const out = new Uint8Array(totalLen);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
  return out;
}

// CRC-32 table
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Replace << and >> (and HTML-encoded forms) in a UTF-8 byte array
function replaceInBytes(bytes) {
  const dec = new TextDecoder('utf-8', { fatal: false });
  const enc = new TextEncoder();
  let text = dec.decode(bytes);
  text = text.replace(/&lt;&lt;/g, '\u00ab')
             .replace(/&gt;&gt;/g, '\u00bb')
             .replace(/<</g,       '\u00ab')
             .replace(/>>/g,       '\u00bb');
  return enc.encode(text);
}

// ── Main ZIP processor ───────────────────────────────────────────────────────
async function processZip(input) {
  // 1. Find End of Central Directory
  let eocdOffset = -1;
  for (let i = input.length - 22; i >= 0; i--) {
    if (readU32(input, i) === SIG_EOCD) { eocdOffset = i; break; }
  }
  if (eocdOffset < 0) throw new Error('Not a valid ZIP/EPUB file.');

  const centralDirOffset = readU32(input, eocdOffset + 16);
  const totalEntries     = readU16(input, eocdOffset + 10);

  // 2. Walk central directory to collect entries
  const entries = [];
  let cdPos = centralDirOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (readU32(input, cdPos) !== SIG_CENTRAL) break;
    const method        = readU16(input, cdPos + 10);
    const crc           = readU32(input, cdPos + 16);
    const compSize      = readU32(input, cdPos + 20);
    const uncompSize    = readU32(input, cdPos + 24);
    const nameLen       = readU16(input, cdPos + 28);
    const extraLen      = readU16(input, cdPos + 30);
    const commentLen    = readU16(input, cdPos + 32);
    const localOffset   = readU32(input, cdPos + 42);
    const nameBytes     = input.slice(cdPos + 46, cdPos + 46 + nameLen);
    const name          = new TextDecoder().decode(nameBytes);
    entries.push({ name, method, crc, compSize, uncompSize, localOffset, cdOffset: cdPos });
    cdPos += 46 + nameLen + extraLen + commentLen;
  }

  // 3. Process each local file entry
  // We'll rebuild the zip from scratch into output parts
  const localParts = []; // { header: Uint8Array, data: Uint8Array }
  const updatedEntries = []; // updated metadata for central dir

  for (const entry of entries) {
    const loff = entry.localOffset;
    if (readU32(input, loff) !== SIG_LOCAL) throw new Error('Bad local header for ' + entry.name);

    const lNameLen  = readU16(input, loff + 26);
    const lExtraLen = readU16(input, loff + 28);
    const dataStart = loff + 30 + lNameLen + lExtraLen;

    // Copy the original local file header
    const headerSize = 30 + lNameLen + lExtraLen;
    let localHeader = new Uint8Array(input.slice(loff, loff + headerSize));

    let compData;
    let newCrc      = entry.crc;
    let newCompSize = entry.compSize;
    let newUncompSize = entry.uncompSize;
    let newMethod   = entry.method;

    const isText = TEXT_EXTS.test(entry.name) && entry.uncompSize > 0;

    if (isText) {
      // Decompress if needed
      let rawBytes;
      if (entry.method === METHOD_DEFLATE) {
        rawBytes = await inflate(input.slice(dataStart, dataStart + entry.compSize));
      } else if (entry.method === METHOD_STORE) {
        rawBytes = input.slice(dataStart, dataStart + entry.compSize);
      } else {
        // Unknown compression — copy as-is
        rawBytes = null;
      }

      if (rawBytes !== null) {
        const replaced = replaceInBytes(rawBytes);
        newCrc        = crc32(replaced);
        newUncompSize = replaced.length;

        if (entry.method === METHOD_DEFLATE) {
          compData    = await deflate(replaced);
          newCompSize = compData.length;
        } else {
          compData    = replaced;
          newCompSize = replaced.length;
          newMethod   = METHOD_STORE;
        }

        // Patch local header: method(2), crc(4), compSize(4), uncompSize(4)
        localHeader = new Uint8Array(localHeader); // make mutable copy
        writeU16(localHeader, 8,  newMethod);
        writeU32(localHeader, 14, newCrc);
        writeU32(localHeader, 18, newCompSize);
        writeU32(localHeader, 22, newUncompSize);
      } else {
        compData = input.slice(dataStart, dataStart + entry.compSize);
      }
    } else {
      compData = input.slice(dataStart, dataStart + entry.compSize);
    }

    localParts.push({ header: localHeader, data: compData });
    updatedEntries.push({
      ...entry,
      crc: newCrc,
      compSize: newCompSize,
      uncompSize: newUncompSize,
      method: newMethod,
    });
  }

  // 4. Assemble output
  // Calculate total size for local sections
  let totalLocalSize = 0;
  for (const p of localParts) totalLocalSize += p.header.length + p.data.length;

  // We need to rebuild central directory entries from original, updating offsets + sizes
  // First pass: compute new local offsets
  const newLocalOffsets = [];
  let cursor = 0;
  for (const p of localParts) {
    newLocalOffsets.push(cursor);
    cursor += p.header.length + p.data.length;
  }
  const newCentralDirOffset = cursor;

  // Rebuild central directory
  const cdParts = [];
  for (let i = 0; i < entries.length; i++) {
    const orig = entries[i];
    const upd  = updatedEntries[i];
    const cdOff = orig.cdOffset;

    // Central dir entry size = 46 + nameLen + extraLen + commentLen
    const nameLen    = readU16(input, cdOff + 28);
    const extraLen   = readU16(input, cdOff + 30);
    const commentLen = readU16(input, cdOff + 32);
    const cdEntrySize = 46 + nameLen + extraLen + commentLen;

    const cdEntry = new Uint8Array(input.slice(cdOff, cdOff + cdEntrySize));
    // Patch: method, crc, compSize, uncompSize, local offset
    writeU16(cdEntry, 10, upd.method);
    writeU32(cdEntry, 16, upd.crc);
    writeU32(cdEntry, 20, upd.compSize);
    writeU32(cdEntry, 24, upd.uncompSize);
    writeU32(cdEntry, 42, newLocalOffsets[i]);
    cdParts.push(cdEntry);
  }

  let totalCdSize = cdParts.reduce((s, p) => s + p.length, 0);

  // Rebuild EOCD (22 bytes)
  const newEocd = new Uint8Array(input.slice(eocdOffset, eocdOffset + 22));
  writeU32(newEocd, 16, newCentralDirOffset);
  writeU32(newEocd, 12, totalCdSize);

  // Assemble everything
  const outputSize = totalLocalSize + totalCdSize + 22;
  const output = new Uint8Array(outputSize);
  let pos = 0;

  for (const p of localParts) {
    output.set(p.header, pos); pos += p.header.length;
    output.set(p.data,   pos); pos += p.data.length;
  }
  for (const cd of cdParts) {
    output.set(cd, pos); pos += cd.length;
  }
  output.set(newEocd, pos);

  return output;
}
