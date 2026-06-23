package dev.undistracted.timer

import android.content.Context
import android.webkit.JavascriptInterface

class TimerBridge(private val context: Context) {
    @JavascriptInterface
    fun timerStart(endAtMs: Long, totalSecs: Long, label: String) {
        TimerService.start(context, endAtMs, totalSecs, label)
    }

    @JavascriptInterface
    fun timerStop() {
        TimerService.stop(context)
    }
}
