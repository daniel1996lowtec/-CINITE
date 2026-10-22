/** Text only. No persistence or room history; identity comes from the joined seat. */
export const CHAT_MAX_LENGTH = 240;
export const CHAT_RATE_COUNT = 5;
export const CHAT_RATE_WINDOW_MS = 10_000;

export function validateChatText(value) {
  if (typeof value !== 'string' || value.length > CHAT_MAX_LENGTH) return null;
  // Single-line plain text. Reject control/bidi-spoofing characters, retain emoji/ZWJ.
  if (/[\u0000-\u001f\u007f-\u009f\u200b\u2028-\u202e\u2066-\u2069\ufeff]/u.test(value)) return null;
  const text = value.normalize('NFC').trim();
  return text.length > 0 && text.length <= CHAT_MAX_LENGTH ? text : null;
}

/** Bounded sliding window, keyed by verified account (across rooms/reconnects).
 * Invalid attempts also consume quota. No intervals, sockets or chat text retained.
 */
export function createChatRateLimiter({maxEntries = 4096} = {}) {
  const entries = new Map();
  return (identity, now = Date.now()) => {
    if (!entries.has(identity) && entries.size >= maxEntries) {
      for (const [key, times] of entries) {
        if (times.at(-1) <= now - CHAT_RATE_WINDOW_MS) entries.delete(key);
      }
      if (entries.size >= maxEntries) return false; // fail closed, never evict live quotas
    }
    const times = (entries.get(identity) || []).filter(t => t > now - CHAT_RATE_WINDOW_MS);
    if (times.length >= CHAT_RATE_COUNT) return false;
    times.push(now); entries.set(identity, times);
    return true;
  };
}
