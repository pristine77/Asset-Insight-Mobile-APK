package expo.modules.auctioncamera.viewextensions

import expo.modules.auctioncamera.CaptureMode

/**
 * What one shutter tap asked for, carried with that shot from the tap to the
 * moment its finished photo is filed in a lot (2026-10-03).
 *
 * The screen used to keep the request in two "pending" fields and read them
 * back when the photo arrived. That worked while the shutter stayed locked
 * until the previous shot was fully processed. Now the shutter frees as soon
 * as the frame is on disk, so a second tap can land before the first photo is
 * filed — and would have overwritten those fields, filing the first photo
 * under the second tap's mode. Each shot carries its own request instead.
 */
data class CaptureTicket(
    val mode: CaptureMode,
    val isExtra: Boolean,
    /** SystemClock.elapsedRealtime() at the tap, for the timing log. */
    val tapAtMs: Long,
)
