package dev.undistracted.timer

import android.content.Context
import android.webkit.JavascriptInterface

class TimerBridge(private val context: Context) {
    @JavascriptInterface
    fun timerStart(
        endAtMs: Long,
        totalSecs: Long,
        label: String,
        mode: String,
        autoStart: Boolean,
        focusSecs: Long,
        shortSecs: Long,
        longSecs: Long,
        longEvery: Int,
        completedInCycle: Int
    ) {
        TimerService.start(
            context, endAtMs, totalSecs, label, mode, autoStart,
            focusSecs, shortSecs, longSecs, longEvery, completedInCycle
        )
    }

    @JavascriptInterface
    fun timerStop() {
        TimerService.stop(context)
    }

    @JavascriptInterface
    fun getState(): String {
        val svc = TimerService.instance ?: return "{}"
        return """{"running":${svc.running},"mode":"${svc.currentMode}","endAt":${svc.endAtMs},"totalSecs":${svc.totalSecs},"label":"${svc.timerLabel}","completedInCycle":${svc.completedInCycle}}"""
    }
}
