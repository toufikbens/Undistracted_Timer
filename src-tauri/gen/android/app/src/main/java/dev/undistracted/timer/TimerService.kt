package dev.undistracted.timer

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import android.widget.Toast
import androidx.core.app.NotificationCompat

class TimerService : Service() {
    companion object {
        const val CHANNEL_ID = "timer_countdown"
        const val ALERT_CHANNEL_ID = "timer_alerts"
        const val NOTIFICATION_ID = 1001
        const val ACTION_START = "start"
        const val ACTION_STOP = "stop"

        @JvmStatic
        internal var instance: TimerService? = null
            private set

        fun start(
            context: Context,
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
            val intent = Intent(context, TimerService::class.java)
            intent.action = ACTION_START
            intent.putExtra("end_at_ms", endAtMs)
            intent.putExtra("total_secs", totalSecs)
            intent.putExtra("label", label)
            intent.putExtra("mode", mode)
            intent.putExtra("auto_start", autoStart)
            intent.putExtra("focus_secs", focusSecs)
            intent.putExtra("short_secs", shortSecs)
            intent.putExtra("long_secs", longSecs)
            intent.putExtra("long_every", longEvery)
            intent.putExtra("completed_in_cycle", completedInCycle)

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun stop(context: Context) {
            instance?.requestStop()
            val intent = Intent(context, TimerService::class.java)
            intent.action = ACTION_STOP
            context.startService(intent)
        }
    }

    internal var running = false
    internal var endAtMs = 0L
    internal var totalSecs = 0L
    internal var timerLabel = "Focus"
    internal var currentMode = "focus"
    private var autoStart = false
    private var focusSecs = 0L
    private var shortSecs = 0L
    private var longSecs = 0L
    private var longEvery = 4
    internal var completedInCycle = 0

    private val handler = Handler(Looper.getMainLooper())
    private var appIntent: PendingIntent? = null
    private var pendingNextRunnable: Runnable? = null

    override fun onCreate() {
        super.onCreate()
        instance = this
        createChannels()
    }

    override fun onDestroy() {
        handler.removeCallbacks(tick)
        pendingNextRunnable?.let { handler.removeCallbacks(it) }
        running = false
        instance = null
        super.onDestroy()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> {
                endAtMs = intent.getLongExtra("end_at_ms", 0)
                totalSecs = intent.getLongExtra("total_secs", 0)
                timerLabel = intent.getStringExtra("label") ?: "Focus"
                currentMode = intent.getStringExtra("mode") ?: "focus"
                autoStart = intent.getBooleanExtra("auto_start", false)
                focusSecs = intent.getLongExtra("focus_secs", 0)
                shortSecs = intent.getLongExtra("short_secs", 0)
                longSecs = intent.getLongExtra("long_secs", 0)
                longEvery = intent.getIntExtra("long_every", 4)
                completedInCycle = intent.getIntExtra("completed_in_cycle", 0)

                running = true
                handler.removeCallbacks(tick)
                pendingNextRunnable?.let {
                    handler.removeCallbacks(it)
                    pendingNextRunnable = null
                }
                appIntent = buildPendingIntent()
                val initialRemaining = currentRemaining()
                Log.d("TimerService", "start mode=$currentMode endAt=$endAtMs total=$totalSecs remaining=$initialRemaining")
                startForeground(NOTIFICATION_ID, buildNotification(initialRemaining))
                handler.post(tick)
            }
            ACTION_STOP -> {
                requestStop()
            }
        }
        return START_STICKY
    }

    fun requestStop() {
        handler.removeCallbacks(tick)
        pendingNextRunnable?.let {
            handler.removeCallbacks(it)
            pendingNextRunnable = null
        }
        running = false
        autoStart = false
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun currentRemaining(): Int {
        val remaining = (endAtMs - System.currentTimeMillis()) / 1000
        return maxOf(0, remaining.toInt())
    }

    private val tick = object : Runnable {
        override fun run() {
            if (!running) return

            val remaining = currentRemaining()
            Log.d("TimerService", "tick remaining=$remaining running=$running")
            updateNotification(remaining)

            if (remaining <= 0) {
                running = false
                handler.removeCallbacks(this)
                onTimerComplete()
                return
            }
            handler.postDelayed(this, 1000)
        }
    }

    private fun onTimerComplete() {
        if (currentMode == "focus") {
            completedInCycle = (completedInCycle + 1) % longEvery
        }

        if (autoStart) {
            // Stay in the foreground; just swap the notification to the
            // completion alert, then start the next session shortly after.
            Log.d("TimerService", "onTimerComplete autoStart next=${computeNextMode()}")
            Toast.makeText(this, "${timerLabel} complete — starting next", Toast.LENGTH_SHORT).show()
            startForeground(NOTIFICATION_ID, buildCompletionNotification())
            val nextMode = computeNextMode()
            val runnable = Runnable { startNextSegment(nextMode) }
            pendingNextRunnable = runnable
            handler.postDelayed(runnable, 700)
        } else {
            stopForeground(STOP_FOREGROUND_DETACH)
            val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            manager.notify(NOTIFICATION_ID, buildCompletionNotification())
            stopSelf()
        }
    }

    private fun startNextSegment(nextMode: String) {
        pendingNextRunnable = null
        currentMode = nextMode
        totalSecs = durationForMode(nextMode)
        timerLabel = labelForMode(nextMode)
        endAtMs = System.currentTimeMillis() + totalSecs * 1000
        running = true
        Log.d("TimerService", "startNextSegment mode=$currentMode total=$totalSecs endAt=$endAtMs")
        Toast.makeText(this, "Starting $timerLabel", Toast.LENGTH_SHORT).show()
        startForeground(NOTIFICATION_ID, buildNotification(currentRemaining()))
        handler.post(tick)
    }

    private fun computeNextMode(): String {
        return if (currentMode == "focus") {
            if (completedInCycle == 0) "long" else "short"
        } else {
            "focus"
        }
    }

    private fun durationForMode(mode: String): Long {
        return when (mode) {
            "short" -> shortSecs
            "long" -> longSecs
            else -> focusSecs
        }
    }

    private fun labelForMode(mode: String): String {
        return when (mode) {
            "short" -> "Short break"
            "long" -> "Long break"
            else -> "Focus"
        }
    }

    private fun buildPendingIntent(): PendingIntent {
        val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
        return PendingIntent.getActivity(
            this, 0, launchIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
    }

    private fun buildNotification(remaining: Int): Notification {
        val iconRes = packageManager.getApplicationInfo(packageName, 0).icon
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(iconRes)
            .setContentTitle(timerLabel)
            .setContentText(formatTime(remaining.toLong()))
            .setOngoing(true)
            .setContentIntent(appIntent)
            .setProgress(totalSecs.toInt(), remaining, false)
            .setOnlyAlertOnce(true)
            .build()
    }

    private fun buildCompletionNotification(): Notification {
        val iconRes = packageManager.getApplicationInfo(packageName, 0).icon
        return NotificationCompat.Builder(this, ALERT_CHANNEL_ID)
            .setSmallIcon(iconRes)
            .setContentTitle("${timerLabel} complete")
            .setContentText("Tap to open")
            .setOngoing(true)
            .setAutoCancel(true)
            .setContentIntent(appIntent)
            .build()
    }

    private fun updateNotification(remaining: Int) {
        try {
            startForeground(NOTIFICATION_ID, buildNotification(remaining))
        } catch (e: Exception) {
            Log.e("TimerService", "updateNotification failed", e)
        }
    }

    private fun formatTime(seconds: Long): String {
        val mins = seconds / 60
        val secs = seconds % 60
        return "${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}"
    }

    private fun createChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return

        val countdownChannel = NotificationChannel(
            CHANNEL_ID,
            "Timer countdown",
            NotificationManager.IMPORTANCE_LOW
        )
        countdownChannel.description = "Ongoing timer countdown"

        val alertChannel = NotificationChannel(
            ALERT_CHANNEL_ID,
            "Timer alerts",
            NotificationManager.IMPORTANCE_HIGH
        )
        alertChannel.description = "Sounds when a timer ends"

        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.createNotificationChannels(listOf(countdownChannel, alertChannel))
    }
}
