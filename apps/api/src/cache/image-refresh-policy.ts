export const IMAGE_REVALIDATE_MS = 30 * 24 * 60 * 60 * 1_000;
const DAY_MS = 24 * 60 * 60 * 1_000;

// Conservative exact fingerprints only. This generic silhouette was visually
// verified in an OpenSubsonic JPEG response. Unknown photos remain images;
// this deliberately does not attempt to recognize artists or judge aesthetics.
export const KNOWN_IMAGE_PLACEHOLDERS = new Set([
  'cc10b685f33c5f0b9c3599da834a10dc0c30c164b97032e0fa9ef6266cfa5c72',
]);

export function placeholderDelay(attempts: number, random: number): number {
  return jitter(Math.min(7, 2 ** Math.min(3, Math.max(0, attempts - 1))) * DAY_MS, random);
}

export function imageErrorDelay(attempts: number, random: number): number {
  return jitter(Math.min(6 * 60 * 60 * 1_000, 30_000 * 2 ** Math.min(10, Math.max(0, attempts - 1))), random);
}

function jitter(base: number, random: number): number {
  return base + Math.round(base * 0.25 * Math.max(0, Math.min(1, random)));
}
