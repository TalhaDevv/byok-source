"use strict";

// ─── Varint kodlama / çözme ──────────────────────────────────────────────────

function encodeVarint(value) {
  let n = value >>> 0;
  const out = [];
  while (n > 127) {
    out.push((n & 127) | 128);
    n >>>= 7;
  }
  out.push(n);
  return Buffer.from(out);
}

function encodeVarint64(value) {
  let n = BigInt(value);
  if (n < 0n) n = 0n;
  const out = [];
  while (n > 127n) {
    out.push(Number(n & 127n) | 128);
    n >>= 7n;
  }
  out.push(Number(n));
  return Buffer.from(out);
}

function decodeVarint(buf, i) {
  let n = 0;
  let shift = 0;
  while (i < buf.length) {
    const b = buf[i++];
    n |= (b & 127) << shift;
    if ((b & 128) === 0) return { n: n >>> 0, i };
    shift += 7;
    if (shift > 35) break;
  }
  return { n: 0, i };
}

// ─── Proto field encode yardımcıları ────────────────────────────────────────

function stringField(field, value) {
  const body = Buffer.from(String(value || ""), "utf8");
  return Buffer.concat([
    encodeVarint((field << 3) | 2),
    encodeVarint(body.length),
    body,
  ]);
}

function messageField(field, body) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.alloc(0);
  return Buffer.concat([
    encodeVarint((field << 3) | 2),
    encodeVarint(buf.length),
    buf,
  ]);
}

function bytesField(field, body) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body || ""));
  return Buffer.concat([
    encodeVarint((field << 3) | 2),
    encodeVarint(buf.length),
    buf,
  ]);
}

function intField(field, value) {
  const n = Number(value);
  if (!Number.isFinite(n) || Math.abs(n) > 0xffffffff) {
    return Buffer.concat([encodeVarint((field << 3) | 0), encodeVarint64(Math.trunc(n))]);
  }
  return Buffer.concat([encodeVarint((field << 3) | 0), encodeVarint(n >>> 0)]);
}

function boolField(field, value) {
  if (!value) return Buffer.alloc(0);
  return intField(field, 1);
}

function join(parts) {
  return Buffer.concat(parts.filter((p) => p && p.length));
}

// ─── Connect protokolü frame ─────────────────────────────────────────────────

function connectFrame(payload) {
  const head = Buffer.alloc(5);
  head.writeUInt32BE(payload.length, 1);
  return Buffer.concat([head, payload]);
}

// ─── Proto parse yardımcıları ────────────────────────────────────────────────

function walkProto(buf, acc) {
  let i = 0;
  while (i < buf.length) {
    const tag = decodeVarint(buf, i);
    i = tag.i;
    const field = tag.n >>> 3;
    const wire = tag.n & 7;
    if (wire === 0) {
      const v = decodeVarint(buf, i);
      i = v.i;
      acc.ints.push({ field, value: v.n });
    } else if (wire === 2) {
      const len = decodeVarint(buf, i);
      i = len.i;
      const slice = buf.subarray(i, i + len.n);
      i += len.n;
      acc.bytes.push({ field, value: slice });
      const text = slice.toString("utf8");
      if (/^[\x09\x0a\x0d\x20-\x7e\u00a0-\uffff]+$/.test(text) && text.trim()) {
        acc.strings.push({ field, value: text });
      }
      walkProto(slice, acc);
    } else if (wire === 1) {
      i += 8;
    } else if (wire === 5) {
      i += 4;
    } else {
      break;
    }
  }
  return acc;
}

function parseProto(buf) {
  return walkProto(buf || Buffer.alloc(0), { strings: [], bytes: [], ints: [] });
}

/** Belirli bir field numarasına ait ilk wire-type-2 (length-delimited) değeri döndürür */
function protoGetBytes(body, fieldNum) {
  let i = 0;
  while (i < body.length) {
    let tag = 0, shift = 0;
    while (i < body.length) { const b = body[i++]; tag |= (b & 0x7f) << shift; shift += 7; if (!(b & 0x80)) break; }
    const field = tag >>> 3, wire = tag & 7;
    if (wire === 0) { while (i < body.length) { const b = body[i++]; if (!(b & 0x80)) break; } }
    else if (wire === 1) { i += 8; }
    else if (wire === 2) {
      let len = 0, shift2 = 0;
      while (i < body.length) { const b = body[i++]; len |= (b & 0x7f) << shift2; shift2 += 7; if (!(b & 0x80)) break; }
      const slice = body.slice(i, i + len); i += len;
      if (field === fieldNum) return slice;
    }
    else if (wire === 5) { i += 4; }
    else break;
  }
  return null;
}

/** Belirli bir field numarasına ait string/bytes değerini UTF-8 olarak döndürür */
function protoGetString(body, fieldNum) {
  const b = protoGetBytes(body, fieldNum);
  return b ? b.toString("utf8") : null;
}

/** Belirli bir field numarasına ait ilk varint değerini döndürür */
function protoGetVarint(body, fieldNum) {
  let i = 0;
  while (i < body.length) {
    let tag = 0, shift = 0;
    while (i < body.length) { const b = body[i++]; tag |= (b & 0x7f) << shift; shift += 7; if (!(b & 0x80)) break; }
    const field = tag >>> 3, wire = tag & 7;
    if (wire === 0) {
      let val = 0, s2 = 0;
      while (i < body.length) { const b = body[i++]; val |= (b & 0x7f) << s2; s2 += 7; if (!(b & 0x80)) break; }
      if (field === fieldNum) return val;
    }
    else if (wire === 1) { i += 8; }
    else if (wire === 2) { let len = 0, s2 = 0; while (i < body.length) { const b = body[i++]; len |= (b & 0x7f) << s2; s2 += 7; if (!(b & 0x80)) break; } i += len; }
    else if (wire === 5) { i += 4; }
    else break;
  }
  return null;
}

module.exports = {
  encodeVarint,
  encodeVarint64,
  decodeVarint,
  stringField,
  messageField,
  bytesField,
  intField,
  boolField,
  join,
  connectFrame,
  walkProto,
  parseProto,
  protoGetBytes,
  protoGetString,
  protoGetVarint,
};
