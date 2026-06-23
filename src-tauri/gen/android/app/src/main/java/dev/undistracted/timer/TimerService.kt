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
import androidx.core.app.NotificationCompat

class TimerService : Service() {
    companion object {
        const val CHANNEL_ID = "timer_countdown"
        const val NOTIFICATION_ID = 1001
        const val DONE_NOTIFICATION_ID = 1002
        const val ACTION_START = "start"
        const val ACTION_STOP = "stop"

        var isRunning = false
        private var handler: Handler? = null
        private var updateRunnable: Runnable? = null

        var remainingSeconds = 0L
        var totalSeconds = 0L
        var modeLabel = "Focus"

        fun start(context: Context, endAtMs: Long, totalSecs: Long, label: String) {
            totalSeconds = totalSecs
            remainingSeconds = maxOf(0, (endAtMs - System.currentTimeMillis()) / 1000)
            modeLabel = label
            isRunning = true

            val intent = Intent(context, TimerService::class.java)
            intent.action = ACTION_START
            intent.putExtra("end_at_ms", endAtMs)
            intent.putExtra("total_secs", totalSecs)
            intent.putExtra("label", label)

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun stop(context: Context) {
            isRunning = false
            handler?.removeCallbacks(updateRunnable ?: return)

            val intent = Intent(context, TimerService::class.java)
            intent.action = ACTION_STOP
            context.startService(intent)
        }
    }

    private val mainHandler = Handler(Looper.getMainLooper())

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> {
                val endAtMs = intent.getLongExtra("end_at_ms", 0)
                val totalSecs = intent.getLongExtra("total_secs", 0)
                val label = intent.getStringExtra("label") ?: "Timer"
                totalSeconds = totalSecs
                remainingSeconds = maxOf(0, (endAtMs - System.currentTimeMillis()) / 1000)
                modeLabel = label
                isRunning = true
                createNotificationChannel()
                startForeground(NOTIFICATION_ID, buildNotification())
                startCountdown()
            }
            ACTION_STOP -> {
                stopCountdown()
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelf()
            }
        }
        return START_STICKY
    }

    private fun startCountdown() {
        stopCountdown()
        updateRunnable = object : Runnable {
            override fun run() {
                if (!isRunning) return
                remainingSeconds = maxOf(0, remainingSeconds - 1)
                updateNotification()
                if (remainingSeconds <= 0) {
                    stopCountdown()
                    stopForeground(STOP_FOREGROUND_DETACH)
                    showCompletionNotification()
                    stopSelf()
                    return
                }
                mainHandler.postDelayed(this, 1000)
            }
        }
        mainHandler.post(updateRunnable!!)
    }

    private fun stopCountdown() {
        updateRunnable?.let { mainHandler.removeCallbacks(it) }
    }

    private fun formatTime(seconds: Long): String {
        val mins = seconds / 60
        val secs = seconds % 60
        return "${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}"
    }

    private fun buildNotification(): Notification {
        val appIntent = packageManager.getLaunchIntentForPackage(packageName)
        val pendingIntent = PendingIntent.getActivity(
            this, 0, appIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(modeLabel)
            .setContentText(formatTime(remainingSeconds))
            .setSmallIcon(android.R.drawable.ic_popup_reminder)
            .setOngoing(true)
            .setContentIntent(pendingIntent)
            .setProgress(totalSeconds.toInt(), remainingSeconds.toInt(), false)
            .build()
    }

    private fun updateNotification() {
        val notification = buildNotification()
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.notify(NOTIFICATION_ID, notification)
    }

    private fun showCompletionNotification() {
        val appIntent = packageManager.getLaunchIntentForPackage(packageName)
        val pendingIntent = PendingIntent.getActivity(
            this, 0, appIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("${modeLabel} complete")
            .setContentText("Tap to open")
            .setSmallIcon(android.R.drawable.ic_popup_reminder)
            .setAutoCancel(true)
            .setContentIntent(pendingIntent)
            .build()

        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.notify(DONE_NOTIFICATION_ID, notification)
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Timer countdown",
                NotificationManager.IMPORTANCE_LOW
            )
            channel.description = "Shows the timer countdown"
            val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            manager.createNotificationChannel(channel)
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null
}
