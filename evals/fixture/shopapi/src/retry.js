export const MAX_RETRIES = 4;
export const BASE_DELAY_MS = 250;

// exponential backoff with full jitter
export function delayFor(attempt) {
  return Math.random() * BASE_DELAY_MS * 2 ** attempt;
}
