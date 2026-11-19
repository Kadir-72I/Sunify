package com.sunify.mobile

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.support.v4.media.MediaMetadataCompat
import android.support.v4.media.session.MediaSessionCompat
import android.support.v4.media.session.PlaybackStateCompat
import androidx.core.app.NotificationCompat
import androidx.media.app.NotificationCompat.MediaStyle

class MediaPlaybackService : Service() {

    companion object {
        const val CHANNEL_ID = "sunify_playback_channel"
        const val NOTIF_ID = 7201
        const val ACTION_UPDATE = "com.sunify.mobile.ACTION_UPDATE"
        const val ACTION_CONTROL = "com.sunify.mobile.ACTION_CONTROL"
        const val EXTRA_TITLE = "title"
        const val EXTRA_ARTIST = "artist"
        const val EXTRA_PLAYING = "playing"
        const val EXTRA_CONTROL = "control"

        var onMediaAction: ((String) -> Unit)? = null
    }

    private lateinit var mediaSession: MediaSessionCompat

    override fun onCreate() {
        super.onCreate()
        createChannel()
        mediaSession = MediaSessionCompat(this, "SunifyMediaSession").apply {
            setCallback(object : MediaSessionCompat.Callback() {
                override fun onPlay() { onMediaAction?.invoke("toggle") }
                override fun onPause() { onMediaAction?.invoke("toggle") }
                override fun onSkipToNext() { onMediaAction?.invoke("next") }
                override fun onSkipToPrevious() { onMediaAction?.invoke("previous") }
            })
            isActive = true
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_CONTROL -> {
                val cmd = intent.getStringExtra(EXTRA_CONTROL) ?: return START_NOT_STICKY
                onMediaAction?.invoke(cmd)
            }
            ACTION_UPDATE, null -> {
                val title = intent?.getStringExtra(EXTRA_TITLE) ?: "Sunify"
                val artist = intent?.getStringExtra(EXTRA_ARTIST) ?: "Müzik Çalar"
                val playing = intent?.getBooleanExtra(EXTRA_PLAYING, false) ?: false
                updateNotification(title, artist, playing)
            }
        }
        return START_STICKY
    }

    private fun updateNotification(title: String, artist: String, playing: Boolean) {
        mediaSession.setMetadata(
            MediaMetadataCompat.Builder()
                .putString(MediaMetadataCompat.METADATA_KEY_TITLE, title)
                .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, artist)
                .build()
        )
        val state = if (playing) PlaybackStateCompat.STATE_PLAYING else PlaybackStateCompat.STATE_PAUSED
        mediaSession.setPlaybackState(
            PlaybackStateCompat.Builder()
                .setActions(
                    PlaybackStateCompat.ACTION_PLAY or
                        PlaybackStateCompat.ACTION_PAUSE or
                        PlaybackStateCompat.ACTION_PLAY_PAUSE or
                        PlaybackStateCompat.ACTION_SKIP_TO_NEXT or
                        PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS
                )
                .setState(state, 0L, 1f)
                .build()
        )

        val openIntent = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )

        fun controlIntent(cmd: String, reqCode: Int): PendingIntent {
            val i = Intent(this, MediaPlaybackService::class.java).apply {
                action = ACTION_CONTROL
                putExtra(EXTRA_CONTROL, cmd)
            }
            return PendingIntent.getService(
                this,
                reqCode,
                i,
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
            )
        }

        val notif: Notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(title)
            .setContentText(artist)
            .setSmallIcon(R.drawable.ic_sunify_notif)
            .setContentIntent(openIntent)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOngoing(playing)
            .addAction(android.R.drawable.ic_media_previous, "Önceki", controlIntent("previous", 1))
            .addAction(
                if (playing) android.R.drawable.ic_media_pause else android.R.drawable.ic_media_play,
                if (playing) "Duraklat" else "Oynat",
                controlIntent("toggle", 2)
            )
            .addAction(android.R.drawable.ic_media_next, "Sonraki", controlIntent("next", 3))
            .setStyle(
                MediaStyle()
                    .setMediaSession(mediaSession.sessionToken)
                    .setShowActionsInCompactView(0, 1, 2)
            )
            .build()

        startForeground(NOTIF_ID, notif)
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Sunify Müzik Oynatma",
                NotificationManager.IMPORTANCE_LOW
            )
            getSystemService(NotificationManager::class.java)?.createNotificationChannel(channel)
        }
    }

    override fun onDestroy() {
        mediaSession.release()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null
}
