package expo.modules.auctioncamera

import android.app.Activity
import android.content.Intent
import android.os.SystemClock
import android.util.Log
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.Promise
import expo.modules.auctioncamera.ui.camera.CameraViewActivity

/**
 * EXPO NATIVE MODULE ENTRY POINT
 * This class bridges React Native (JavaScript) with the native Android Camera OS.
 */
class AuctionCameraModule : Module() {

    companion object {
        private const val REQUEST_CODE_CAMERA = 0xAC01
        const val EXTRA_LOT_PAYLOAD_JSON      = "lot_payload_json"
    }

    private val cameraLaunchGate = CameraLaunchGate<Promise>()
    private var initialPayload: String = ""
    private var uploader: ContentUriUploader? = null

    override fun definition() = ModuleDefinition {
        Name("AuctionCameraModule")
        AsyncFunction("getCameraCapabilities") { mapOf("lockedStructure" to true) }
        Events("uploadProgress")
        AsyncFunction("getContentUriInfo") { value: String ->
            val context = appContext.reactContext ?: error("Application context unavailable")
            val uri = android.net.Uri.parse(value)
            require(uri.scheme == "content" && uri.authority == "media") { "Only device media references are supported" }
            try {
                context.contentResolver.openAssetFileDescriptor(uri, "r")?.use { descriptor ->
                    var length = descriptor.length
                    if (length < 0) context.contentResolver.query(uri, arrayOf(android.provider.OpenableColumns.SIZE), null, null, null)?.use { cursor ->
                        if (cursor.moveToFirst() && !cursor.isNull(0)) length = cursor.getLong(0)
                    }
                    mapOf("exists" to true, "size" to length, "type" to context.contentResolver.getType(uri))
                } ?: mapOf("exists" to false)
            } catch (_: java.io.FileNotFoundException) { mapOf("exists" to false) }
              catch (_: SecurityException) { mapOf("exists" to false) }
        }
        AsyncFunction("getPendingCapture") { owner: String, draft: String ->
            CaptureJournal.read(appContext.reactContext ?: error("Application context unavailable"), owner, draft)?.toString()
        }
        AsyncFunction("acknowledgeCapture") { owner: String, draft: String, session: String, revision: Long ->
            CaptureJournal.acknowledge(appContext.reactContext ?: error("Application context unavailable"), owner, draft, session, revision)
        }
        AsyncFunction("uploadContentUri") { id: String, uri: String, url: String, headers: Map<String, String>, size: Long, promise: Promise ->
            val transfer = uploader ?: ContentUriUploader(appContext.reactContext ?: error("Application context unavailable")) { requestId, sent, total ->
                sendEvent("uploadProgress", mapOf("id" to requestId, "bytesSent" to sent, "totalBytes" to total))
            }.also { uploader = it }
            transfer.upload(id, uri, url, headers, size, promise)
        }
        AsyncFunction("cancelContentUriUpload") { id: String -> uploader?.cancel(id) }
        OnDestroy { uploader?.close(); uploader = null }

// Receives the serialized JSON string of existing lots/photos from React Native
        AsyncFunction("setInitialPayload") { payload: String, promise: Promise ->
            this@AuctionCameraModule.initialPayload = payload
            promise.resolve(null)
        }

       // ── async function exposed to JS ──────────────────────────────────────
        // Launches the full-screen native CameraViewActivity
        AsyncFunction("openAuctionCamera") { payload: String?, promise: Promise ->
            val launchStartMs = SystemClock.elapsedRealtime()
            val activity = appContext.activityProvider?.currentActivity
                ?: run {
                    promise.reject("E_NO_ACTIVITY", "No current Activity found", null)
                    return@AsyncFunction
                }

            val launch = cameraLaunchGate.claim(promise) ?: run {
                promise.reject("E_CAMERA_BUSY", "The camera is already open. Finish the current capture first.", null)
                return@AsyncFunction
            }

            val effectivePayload = payload ?: initialPayload
            initialPayload = ""
            try {
                val handoffId = CameraPayloadStore.prepare(activity, effectivePayload.ifEmpty { "[]" }, launch.handoffId)
                val intent = Intent(activity, CameraViewActivity::class.java)
                    .putExtra(CameraPayloadStore.EXTRA_HANDOFF_ID, handoffId)
                Log.d(
                    "AuctionCameraTiming",
                    "launch payloadBytes=${effectivePayload.length} prepMs=${SystemClock.elapsedRealtime() - launchStartMs}"
                )
                activity.startActivityForResult(intent, REQUEST_CODE_CAMERA)
            } catch (error: Exception) {
                cameraLaunchGate.release(launch)
                runCatching { CameraPayloadStore.discard(activity, launch.handoffId) }
                promise.reject("E_CAMERA_LAUNCH", "The camera could not open. Your saved draft and photos are unchanged. Try again.", error)
            }
        }

       // ── handle the Activity result ────────────────────────────────────────
        // When the user taps "Done" in the native UI, this passes the updated JSON back to JS
        OnActivityResult { _, payload ->
            if (payload.requestCode != REQUEST_CODE_CAMERA) return@OnActivityResult

            val launch = cameraLaunchGate.detach() ?: return@OnActivityResult
            val promise = launch.receiver
            val handoffId = launch.handoffId
            val context = appContext.reactContext
            try {
                if (payload.resultCode == Activity.RESULT_OK) {
                    val json = CameraPayloadStore.result(context ?: error("Application context unavailable"), payload.data, handoffId)
                    Log.d("AuctionCameraTiming", "activity_result payloadBytes=${json.length}")
                    promise.resolve(json)
                } else if (payload.data?.getStringExtra(CameraPayloadStore.EXTRA_ERROR_CODE) != null) {
                    promise.reject("E_CAMERA_INPUT", "The camera could not restore this draft. Your saved photos are unchanged.", null)
                } else {
                    promise.reject("E_CANCELLED", "User cancelled the camera", null)
                }
            } catch (error: Exception) {
                promise.reject("E_CAMERA_RESULT", "Captured photos remain saved on this device. Reopen this draft to recover the camera capture.", error)
            } finally {
                // Journal recovery survives even if JS is interrupted before saving.
                if (context != null) runCatching { CameraPayloadStore.discard(context, handoffId) }
            }
        }
    }
}
