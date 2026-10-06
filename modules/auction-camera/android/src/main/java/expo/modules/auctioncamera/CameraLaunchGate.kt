package expo.modules.auctioncamera

import java.util.UUID

/** AsyncFunction opens and main-thread activity results must transfer one identity. */
class CameraLaunchGate<T> {
    class Claim<T> internal constructor(val receiver: T, val handoffId: String)
    private val lock = Any()
    private var pending: Claim<T>? = null

    fun claim(receiver: T): Claim<T>? = synchronized(lock) {
        if (pending != null) null
        else Claim(receiver, UUID.randomUUID().toString()).also { pending = it }
    }

    fun detach(): Claim<T>? = synchronized(lock) {
        pending.also { pending = null }
    }

    /** A failed old launch must never clear a subsequent camera's pending result. */
    fun release(claim: Claim<T>): Boolean = synchronized(lock) {
        if (pending !== claim) false else {
            pending = null
            true
        }
    }
}
