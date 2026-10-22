/** Shared new-name policy. Existing persisted legacy names remain valid unchanged. */
export function validateDisplayName(value) {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9 _-]{2,17}$/.test(name) ? name : null;
}
