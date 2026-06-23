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
        const val ACTION_START = "start"
        const val ACTION_STOP = "stop"

        private var instance: TimerService? = null

        fun start(context: Context, endAtMs: Long, totalSecs: Long, label: String) {
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
            instance?.requestStop()
            val intent = Intent(context, TimerService::class.java)
            intent.action = ACTION_STOP
            context.startService(intent)
        }
    }

    private var running = false
    private var remainingSecs = 0L
    private var totalSecs = 0L
    private var timerLabel = "Focus"
    private val handler = Handler(Looper.getMainLooper())
    private var appIntent: PendingIntent? = null

    private val tick = object : Runnable {
        override fun run() {
            if (!running) return
            remainingSecs = maxOf(0, remainingSecs - 1)
            updateNotification()
            if (remainingSecs <= 0) {
                running = false
                stopForeground(STOP_FOREGROUND_DETACH)
                showCompletionNotification()
                stopSelf()
                return
            }
            handler.postDelayed(this, 1000)
        }
    }

    override fun onCreate() {
        super.onCreate()
        instance = this
        createChannel()
    }

    override fun onDestroy() {
        handler.removeCallbacks(tick)
        running = false
        instance = null
        super.onDestroy()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> {
                totalSecs = intent.getLongExtra("total_secs", 0)
                remainingSecs = maxOf(0, (intent.getLongExtra("end_at_ms", 0) - System.currentTimeMillis()) / 1000)
                timerLabel = intent.getStringExtra("label") ?: "Focus"
                running = true
                handler.removeCallbacks(tick)
                appIntent = buildPendingIntent()
                startForeground(NOTIFICATION_ID, buildNotification())
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
        running = false
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun buildPendingIntent(): PendingIntent {
        val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
        return PendingIntent.getActivity(
            this, 0, launchIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
    }

    private fun buildNotification(): Notification {
        val iconRes = packageManager.getApplicationInfo(packageName, 0).icon
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(iconRes)
            .setContentTitle(timerLabel)
            .setContentText(formatTime(remainingSecs))
            .setOngoing(true)
            .setContentIntent(appIntent)
            .setProgress(totalSecs.toInt(), remainingSecs.toInt(), false)
            .setOnlyAlertOnce(true)
            .build()
    }

    private fun updateNotification() {
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.notify(NOTIFICATION_ID, buildNotification())
    }

    private fun showCompletionNotification() {
        val iconRes = packageManager.getApplicationInfo(packageName, 0).icon
        val notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(iconRes)
            .setContentTitle("${timerLabel} complete")
            .setContentText("Tap to open")
            .setAutoCancel(true)
            .setContentIntent(appIntent)
            .build()
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.notify(NOTIFICATION_ID, notification)
    }

    private fun formatTime(seconds: Long): String {
        val mins = seconds / 60
        val secs = seconds % 60
        return "${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}"
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Timer",
                NotificationManager.IMPORTANCE_LOW
            )
            channel.description = "Ongoing timer countdown"
            val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            manager.createNotificationChannel(channel)
        }
    }
}
