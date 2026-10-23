// Token capacity is metadata; byte/character limits are transport guards, not token estimates.
export const LIMITS = Object.freeze({
  contextWindowTokens: 1_000_000,
  autoCompactTokens: 900_000,
  maxRequestBytes: 32 * 1024 * 1024,
  maxTaskBytes: 16 * 1024 * 1024,
  maxTaskCharacters: 8_000_000,
});
