const { sign: signOneShot } = require('crypto');

const base64url = require('base64url');

const PURPOSE = 'public';
const VERSION = 'v2';

const le64 = (n) => {
  const up = ~~(n / 0xFFFFFFFF); // eslint-disable-line no-bitwise
  const dn = (n % 0xFFFFFFFF) - up;

  const buf = Buffer.allocUnsafe(8);

  buf.writeUInt32LE(up, 4);
  buf.writeUInt32LE(dn, 0);

  return buf;
};

const pae = (...pieces) => {
  let accumulator = le64(pieces.length);
  for (let piece of pieces) { // eslint-disable-line no-restricted-syntax
    piece = Buffer.from(piece, 'utf8');
    const len = le64(Buffer.byteLength(piece));
    accumulator = Buffer.concat([accumulator, len, piece]);
  }
  return accumulator;
};

const pack = (header, payload) => `${header}${base64url.encode(Buffer.concat(payload))}`;


const decode = (paseto) => {
  const {
    0: version, 1: purpose, 2: sPayload, length,
  } = paseto.split('.');

  if (!(length === 3 || length === 4) || version !== VERSION || purpose !== PURPOSE) {
    throw new TypeError('not a v2.public PASETO');
  }

  return JSON.parse(base64url.toBuffer(sPayload).slice(0, -64));
};

const sign = (payload, key) => {
  const h = `${VERSION}.${PURPOSE}.`;
  const m = Buffer.from(JSON.stringify(payload), 'utf8');
  const sig = signOneShot(undefined, pae(h, m, ''), key);
  return pack(h, [m, sig]);
};

module.exports = { sign, decode };
