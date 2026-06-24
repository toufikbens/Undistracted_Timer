package dev.undistracted.timer

import android.content.Context
import android.webkit.JavascriptInterface

class TimerBridge(private val context: Context) {
    @JavascriptInterface
    fun timerStart(
        endAtMs: Long,
        totalSecs: Long,
        label: String,
        autoStart: Boolean,
        nextEndAtMs: Long,
        nextTotalSecs: Long,
        nextLabel: String
    ) {
        TimerService.start(
            context, endAtMs, totalSecs, label,
            autoStart, nextEndAtMs, nextTotalSecs, nextLabel
        )
    }

    @JavascriptInterface
    fun timerStop() {
        TimerService.stop(context)
    }
}
