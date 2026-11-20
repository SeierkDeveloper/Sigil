// Cipher-like text for illustrations. Fixed per seed, so the server and the browser draw the same thing.

/** A fixed string of cipher-like characters, the same on the server and in the browser. */
export function cipherText(seed: number, length: number, group = 4): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let s = (seed * 2654435761) >>> 0 || 1;
  let out = "";
  for (let i = 0; i < length; i++) {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    out += alphabet[s % alphabet.length];
    if (group > 0 && (i + 1) % group === 0 && i + 1 < length) out += " ";
  }
  return out;
}
