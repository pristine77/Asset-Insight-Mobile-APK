/**
 * "Add logo where missing" (owner request 2026-10-03). On by default: the
 * server adds the company logo only to photos that don't show it yet (camera
 * photos carry it already), so it is safe for every report.
 */
export const DEFAULT_IMAGE_WATERMARK = true;

/**
 * Keep an explicit saved choice; anything else (older drafts with no choice,
 * unreadable values) gets the default. Drafts saved by builds where the switch
 * was off by default still hold `false` and stay off until changed.
 */
export function restoreImageWatermarkPreference(savedValue: unknown): boolean {
  return savedValue === false ? false : DEFAULT_IMAGE_WATERMARK;
}
