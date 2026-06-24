package dev.undistracted.timer

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

class TimerAlarmReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION_START_NEXT) return

        val endAtMs = intent.getLongExtra("end_at_ms", 0)
        val totalSecs = intent.getLongExtra("total_secs", 0)
        val label = intent.getStringExtra("label") ?: "Focus"
        val autoStart = intent.getBooleanExtra("auto_start", false)
        val nextEndAtMs = intent.getLongExtra("next_end_at_ms", 0)
        val nextTotalSecs = intent.getLongExtra("next_total_secs", 0)
        val nextLabel = intent.getStringExtra("next_label") ?: "Focus"

        TimerService.start(
            context, endAtMs, totalSecs, label,
            autoStart, nextEndAtMs, nextTotalSecs, nextLabel
        )
    }

    companion object {
        const val ACTION_START_NEXT = "dev.undistracted.timer.START_NEXT"

        fun buildIntent(
            context: Context,
            endAtMs: Long,
            totalSecs: Long,
            label: String,
            autoStart: Boolean,
            nextEndAtMs: Long,
            nextTotalSecs: Long,
            nextLabel: String
        ): Intent {
            val intent = Intent(context, TimerAlarmReceiver::class.java)
            intent.action = ACTION_START_NEXT
            intent.putExtra("end_at_ms", endAtMs)
            intent.putExtra("total_secs", totalSecs)
            intent.putExtra("label", label)
            intent.putExtra("auto_start", autoStart)
            intent.putExtra("next_end_at_ms", nextEndAtMs)
            intent.putExtra("next_total_secs", nextTotalSecs)
            intent.putExtra("next_label", nextLabel)
            return intent
        }
    }
}
