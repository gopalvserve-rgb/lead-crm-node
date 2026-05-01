package app.leadcrm.mobile

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.telephony.TelephonyManager
import android.util.Log

/**
 * Fires when a call state changes:
 *   - RINGING      -> incoming call, unknown -> prompt "Save as lead?"
 *   - OFFHOOK      -> call answered
 *   - IDLE         -> call ended -> prompt after-call modal
 *
 * Broadcasts a local Intent the MainActivity picks up, then forwards to the
 * webview via JavaScript so the CRM UI can react.
 */
class PhoneStateReceiver : BroadcastReceiver() {
    companion object {
        private const val TAG = "LeadCRM/PhoneState"
        var lastNumber: String? = null
        var lastState: String = TelephonyManager.EXTRA_STATE_IDLE
    }

    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action
        Log.d(TAG, "onReceive action=$action")

        if (action == Intent.ACTION_NEW_OUTGOING_CALL) {
            val number = intent.getStringExtra(Intent.EXTRA_PHONE_NUMBER)
            lastNumber = number
            broadcast(context, "outgoing_call", number ?: "")
            return
        }

        if (action == TelephonyManager.ACTION_PHONE_STATE_CHANGED) {
            val state = intent.getStringExtra(TelephonyManager.EXTRA_STATE) ?: return
            val incoming = intent.getStringExtra(TelephonyManager.EXTRA_INCOMING_NUMBER)

            when (state) {
                TelephonyManager.EXTRA_STATE_RINGING -> {
                    if (!incoming.isNullOrEmpty()) {
                        lastNumber = incoming
                        broadcast(context, "incoming_ringing", incoming)
                    }
                }
                TelephonyManager.EXTRA_STATE_OFFHOOK -> {
                    broadcast(context, "call_answered", lastNumber ?: "")
                }
                TelephonyManager.EXTRA_STATE_IDLE -> {
                    if (lastState != TelephonyManager.EXTRA_STATE_IDLE) {
                        broadcast(context, "call_ended", lastNumber ?: "")
                    }
                }
            }
            lastState = state
        }
    }

    private fun broadcast(ctx: Context, event: String, number: String) {
        val local = Intent("app.leadcrm.mobile.CALL_EVENT")
        local.putExtra("event", event)
        local.putExtra("number", number)
        ctx.sendBroadcast(local)
        Log.d(TAG, "local broadcast: $event for $number")
    }
}
