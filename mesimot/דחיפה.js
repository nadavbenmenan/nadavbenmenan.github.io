// דחיפה.js: שליחת התראה ישירה לאפליקציה (Web Push), בלי שירות חיצוני.
// המנוע בגוגל טוען את הקובץ הזה מהאתר, כמו את ליבה.js. גוגל לא נותן את כלי ההצפנה שהתקן דורש,
// ולכן הכול כתוב כאן ב-JS רגיל: SHA-256, HMAC, עקומה P-256 (חתימה ו-ECDH), ו-AES-128-GCM.
// התקנים: RFC 8291 (הצפנת התוכן), RFC 8188 (aes128gcm), RFC 8292 (VAPID), RFC 6979 (חתימה בלי מספר אקראי).
// נבדק מול ספריית ההצפנה של Node (בדיקות/בדיקת דחיפה.js): הדפדפן מפענח את מה שיוצא מכאן.
(function(root, factory){
  const m = factory();
  if(typeof module === 'object' && module.exports) module.exports = m;
  else root.דחיפה = m;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(){
'use strict';

/* ---------- בתים ---------- */
const utf8 = s => { const b = []; for(const ch of unescape(encodeURIComponent(String(s)))) b.push(ch.charCodeAt(0)); return b; };
const concat = (...a) => [].concat(...a.map(x => Array.from(x)));
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
function b64url(bytes){
  let s = '';
  for(let i = 0; i < bytes.length; i += 3){
    const n = (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8) | (bytes[i + 2] || 0);
    s += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < bytes.length ? B64[(n >> 6) & 63] : '') + (i + 2 < bytes.length ? B64[n & 63] : '');
  }
  return s;
}
function fromB64url(s){
  s = String(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const out = [];
  let buf = 0, bits = 0;
  for(const ch of s){
    const v = B64.indexOf(ch);
    if(v < 0) throw new Error('base64 לא תקין');
    buf = (buf << 6) | v; bits += 6;
    if(bits >= 8){ bits -= 8; out.push((buf >> bits) & 255); }
  }
  return out;
}
const toBig = bytes => { let x = 0n; for(const b of bytes) x = (x << 8n) | BigInt(b); return x; };
function fromBig(x, len){ const out = new Array(len); for(let i = len - 1; i >= 0; i--){ out[i] = Number(x & 255n); x >>= 8n; } return out; }

/* ---------- SHA-256 ו-HMAC ---------- */
const K256 = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
function sha256(input){
  const bytes = Array.from(input), bitLen = bytes.length * 8;
  bytes.push(0x80);
  while(bytes.length % 64 !== 56) bytes.push(0);
  for(let i = 7; i >= 0; i--) bytes.push(i >= 4 ? Math.floor(bitLen / 2 ** (i * 8)) & 0xff : (bitLen >>> (i * 8)) & 0xff);
  const H = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  const W = new Array(64), rot = (x, n) => (x >>> n) | (x << (32 - n));
  for(let o = 0; o < bytes.length; o += 64){
    for(let i = 0; i < 16; i++) W[i] = (bytes[o + 4 * i] << 24) | (bytes[o + 4 * i + 1] << 16) | (bytes[o + 4 * i + 2] << 8) | bytes[o + 4 * i + 3];
    for(let i = 16; i < 64; i++){
      const s0 = rot(W[i - 15], 7) ^ rot(W[i - 15], 18) ^ (W[i - 15] >>> 3), s1 = rot(W[i - 2], 17) ^ rot(W[i - 2], 19) ^ (W[i - 2] >>> 10);
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for(let i = 0; i < 64; i++){
      const t1 = (h + (rot(e, 6) ^ rot(e, 11) ^ rot(e, 25)) + ((e & f) ^ (~e & g)) + K256[i] + W[i]) | 0;
      const t2 = ((rot(a, 2) ^ rot(a, 13) ^ rot(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
    H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
  }
  const out = [];
  for(const x of H) out.push((x >>> 24) & 255, (x >>> 16) & 255, (x >>> 8) & 255, x & 255);
  return out;
}
function hmac(key, data){
  key = Array.from(key);
  if(key.length > 64) key = sha256(key);
  while(key.length < 64) key.push(0);
  return sha256(concat(key.map(b => b ^ 0x5c), sha256(concat(key.map(b => b ^ 0x36), data))));
}

/* ---------- עקומה P-256 ---------- */
const P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const B = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn;
const G = [0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296n, 0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5n];
const mod = (a, m) => { const r = a % m; return r < 0n ? r + m : r; };
function powmod(b, e, m){ let r = 1n; b = mod(b, m); while(e > 0n){ if(e & 1n) r = r * b % m; b = b * b % m; e >>= 1n; } return r; }
const inv = (a, m) => powmod(a, m - 2n, m);
// נקודות בקואורדינטות יעקוביות [X, Y, Z]. null = נקודה באינסוף
function jDouble(p){
  if(!p || p[1] === 0n) return null;
  const [X, Y, Z] = p, d = Z * Z % P, g = Y * Y % P, be = X * g % P;
  const al = 3n * mod(X - d, P) * ((X + d) % P) % P;
  const X3 = mod(al * al - 8n * be, P);
  const Z3 = mod((Y + Z) * (Y + Z) - g - d, P);
  const Y3 = mod(al * mod(4n * be - X3, P) - 8n * (g * g % P), P);
  return [X3, Y3, Z3];
}
function jAdd(p, q){
  if(!p) return q; if(!q) return p;
  const [X1, Y1, Z1] = p, [X2, Y2, Z2] = q;
  const Z1Z1 = Z1 * Z1 % P, Z2Z2 = Z2 * Z2 % P;
  const U1 = X1 * Z2Z2 % P, U2 = X2 * Z1Z1 % P, S1 = Y1 * Z2 % P * Z2Z2 % P, S2 = Y2 * Z1 % P * Z1Z1 % P;
  const H = mod(U2 - U1, P), R = mod(S2 - S1, P);
  if(H === 0n) return R === 0n ? jDouble(p) : null;
  const H2 = H * H % P, H3 = H2 * H % P, V = U1 * H2 % P;
  const X3 = mod(R * R - H3 - 2n * V, P);
  const Y3 = mod(R * mod(V - X3, P) - S1 * H3, P);
  return [X3, Y3, Z1 * Z2 % P * H % P];
}
function mul(k, pt){
  let r = null, q = [pt[0], pt[1], 1n];
  for(let i = BigInt(k.toString(2).length) - 1n; i >= 0n; i--){
    r = jDouble(r);
    if((k >> i) & 1n) r = jAdd(r, q);
  }
  if(!r) throw new Error('נקודה באינסוף');
  const zi = inv(r[2], P), zi2 = zi * zi % P;
  return [r[0] * zi2 % P, r[1] * zi2 % P * zi % P];
}
const onCurve = ([x, y]) => mod(y * y - (x * x * x - 3n * x + B), P) === 0n;
const pointBytes = pt => concat([4], fromBig(pt[0], 32), fromBig(pt[1], 32));
function pointFrom(bytes){
  if(bytes.length !== 65 || bytes[0] !== 4) throw new Error('מפתח ציבורי לא תקין');
  const pt = [toBig(bytes.slice(1, 33)), toBig(bytes.slice(33))];
  if(!onCurve(pt)) throw new Error('המפתח הציבורי לא על העקומה');
  return pt;
}
const publicKey = d => pointBytes(mul(d, G));

/** חתימת ES256 (r||s, 64 בתים), עם k דטרמיניסטי לפי RFC 6979. */
function sign(dBytes, msg){
  const d = toBig(dBytes), h = sha256(msg), e = mod(toBig(h), N);
  const x = fromBig(d, 32), h1 = fromBig(e, 32);
  let V = new Array(32).fill(1), Kk = new Array(32).fill(0);
  Kk = hmac(Kk, concat(V, [0], x, h1)); V = hmac(Kk, V);
  Kk = hmac(Kk, concat(V, [1], x, h1)); V = hmac(Kk, V);
  for(;;){
    V = hmac(Kk, V);
    const k = toBig(V);
    if(k >= 1n && k < N){
      const r = mod(mul(k, G)[0], N);
      if(r !== 0n){
        const s = mod(inv(k, N) * (e + r * d), N);
        if(s !== 0n) return concat(fromBig(r, 32), fromBig(s, 32));
      }
    }
    Kk = hmac(Kk, concat(V, [0])); V = hmac(Kk, V);
  }
}

/* ---------- AES-128-GCM (הצפנה בלבד) ---------- */
const SBOX = (() => {
  const s = new Array(256), exp = new Array(256), log = new Array(256);
  for(let i = 0, x = 1; i < 256; i++){ exp[i] = x; log[x] = i; x ^= (x << 1) ^ ((x & 0x80) ? 0x11b : 0); x &= 255; }
  for(let i = 0; i < 256; i++){
    let b = i === 0 ? 0 : exp[(255 - log[i]) % 255];
    let r = b;
    for(let k = 0; k < 4; k++){ b = ((b << 1) | (b >> 7)) & 255; r ^= b; }
    s[i] = r ^ 0x63;
  }
  return s;
})();
function aesKeys(key){
  const w = Array.from(key), rcon = [1, 2, 4, 8, 16, 32, 64, 128, 27, 54];
  for(let i = 16; i < 176; i += 4){
    let t = w.slice(i - 4, i);
    if(i % 16 === 0){ t = [SBOX[t[1]] ^ rcon[i / 16 - 1], SBOX[t[2]], SBOX[t[3]], SBOX[t[0]]]; }
    for(let j = 0; j < 4; j++) w.push(w[i - 16 + j] ^ t[j]);
  }
  return w;
}
const xt = b => ((b << 1) ^ ((b & 0x80) ? 0x1b : 0)) & 255;
function aesBlock(w, inp){
  let s = inp.map((b, i) => b ^ w[i]);
  for(let r = 1; r <= 10; r++){
    s = s.map(b => SBOX[b]);
    s = [s[0], s[5], s[10], s[15], s[4], s[9], s[14], s[3], s[8], s[13], s[2], s[7], s[12], s[1], s[6], s[11]];
    if(r < 10){
      const m = [];
      for(let c = 0; c < 4; c++){
        const [a0, a1, a2, a3] = s.slice(c * 4, c * 4 + 4);
        m.push(xt(a0) ^ xt(a1) ^ a1 ^ a2 ^ a3, a0 ^ xt(a1) ^ xt(a2) ^ a2 ^ a3, a0 ^ a1 ^ xt(a2) ^ xt(a3) ^ a3, xt(a0) ^ a0 ^ a1 ^ a2 ^ xt(a3));
      }
      s = m;
    }
    s = s.map((b, i) => b ^ w[r * 16 + i]);
  }
  return s;
}
const R128 = 0xe1n << 120n;
function gmul(x, y){
  let z = 0n, v = y;
  for(let i = 127n; i >= 0n; i--){
    if((x >> i) & 1n) z ^= v;
    v = (v & 1n) ? (v >> 1n) ^ R128 : v >> 1n;
  }
  return z;
}
function gcmEncrypt(key, iv, plain){
  const w = aesKeys(key), H = toBig(aesBlock(w, new Array(16).fill(0)));
  const j0 = concat(iv, [0, 0, 0, 1]), out = [];
  for(let i = 0; i < plain.length; i += 16){
    const ctr = concat(iv, fromBig(BigInt(2 + i / 16), 4)), ks = aesBlock(w, ctr);
    for(let j = 0; j < 16 && i + j < plain.length; j++) out.push(plain[i + j] ^ ks[j]);
  }
  let X = 0n;
  for(let i = 0; i < out.length; i += 16){
    const blk = out.slice(i, i + 16); while(blk.length < 16) blk.push(0);
    X = gmul(X ^ toBig(blk), H);
  }
  X = gmul(X ^ toBig(concat(fromBig(0n, 8), fromBig(BigInt(out.length * 8), 8))), H);
  const tag = fromBig(X, 16), ek = aesBlock(w, j0);
  return concat(out, tag.map((b, i) => b ^ ek[i]));
}

/* ---------- Web Push ---------- */
/** הצפנת ההודעה למכשיר אחד (RFC 8291). מחזיר את גוף הבקשה (בתים). */
function encrypt(payload, p256dh, auth, rand){
  const ua = fromB64url(p256dh), secret = fromB64url(auth), uaPt = pointFrom(ua);
  const asD = mod(toBig(rand(32)), N - 1n) + 1n, asPub = publicKey(asD);
  const ecdh = fromBig(mul(asD, uaPt)[0], 32);
  const prkKey = hmac(secret, ecdh);
  const ikm = hmac(prkKey, concat(utf8('WebPush: info'), [0], ua, asPub, [1]));
  const salt = rand(16), prk = hmac(salt, ikm);
  const cek = hmac(prk, concat(utf8('Content-Encoding: aes128gcm'), [0, 1])).slice(0, 16);
  const nonce = hmac(prk, concat(utf8('Content-Encoding: nonce'), [0, 1])).slice(0, 12);
  const body = concat(utf8(payload), [2]);
  if(body.length + 16 > 4096) throw new Error('ההודעה ארוכה מדי');
  return concat(salt, [0, 0, 16, 0], [65], asPub, gcmEncrypt(cek, nonce, body));
}
/** אסימון VAPID: מוכיח לשירות ההתראות שהשולח הוא בעל המפתח שהאפליקציה נרשמה איתו. */
function vapidJwt(audience, subject, privateKey, nowSec){
  const head = b64url(utf8(JSON.stringify({typ: 'JWT', alg: 'ES256'})));
  const body = b64url(utf8(JSON.stringify({aud: audience, exp: nowSec + 12 * 3600, sub: subject})));
  return `${head}.${body}.${b64url(sign(fromB64url(privateKey), utf8(`${head}.${body}`)))}`;
}
/**
 * בקשה מוכנה לשליחה: {url, headers, body}. sub = {endpoint, p256dh, auth}.
 * vapid = {publicKey, privateKey, subject}. rand(n) = n בתים אקראיים.
 */
function request(sub, payload, vapid, opts){
  opts = opts || {};
  const u = /^(https:\/\/[^/]+)/.exec(sub.endpoint);
  if(!u) throw new Error('כתובת מנוי לא תקינה');
  const nowSec = Math.floor((opts.now || Date.now()) / 1000);
  return {
    url: sub.endpoint,
    headers: {TTL: String(opts.ttl || 6 * 3600), Urgency: opts.urgency || 'high', 'Content-Encoding': 'aes128gcm',
      Authorization: `vapid t=${vapidJwt(u[1], vapid.subject, vapid.privateKey, nowSec)}, k=${vapid.publicKey}`},
    body: encrypt(payload, sub.p256dh, sub.auth, opts.rand || defaultRand),
  };
}
/** זוג מפתחות VAPID חדש (פעם אחת, בהתקנה). */
function generateVapid(rand){
  const d = mod(toBig((rand || defaultRand)(32)), N - 1n) + 1n;
  return {publicKey: b64url(publicKey(d)), privateKey: b64url(fromBig(d, 32))};
}
function defaultRand(n){
  if(typeof crypto !== 'undefined' && crypto.getRandomValues) return Array.from(crypto.getRandomValues(new Uint8Array(n)));
  throw new Error('אין מקור אקראיות');
}

return {utf8, b64url, fromB64url, sha256, hmac, sign, publicKey: d => publicKey(toBig(d)), gcmEncrypt, encrypt, vapidJwt,
  request, generateVapid, ecdh: (d, pub) => fromBig(mul(toBig(d), pointFrom(pub))[0], 32)};
});
