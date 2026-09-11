package com.luxlu.console;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.SharedPreferences;
import android.media.AudioManager;
import android.media.ToneGenerator;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.VibrationEffect;
import android.os.Vibrator;

public class PollService extends Service {

    public static final String BASE = "https://luxlu.zeabur.app";
    private static final long INTERVAL_MS = 8000;

    private Handler handler;
    private Runnable pollTask;
    private ToneGenerator tone;
    private int lastPending = -1;
    private String token = "";

    @Override
    public void onCreate() {
        super.onCreate();
        createChannels();
        startForeground(1, buildNotification(BASE_SHORT + " 新提问监听中…", false, 1));
        handler = new Handler(Looper.getMainLooper());
        pollTask = new Runnable() {
            @Override
            public void run() {
                doPoll();
                handler.postDelayed(this, INTERVAL_MS);
            }
        };
        handler.postDelayed(pollTask, 1500);
    }

    private static final String BASE_SHORT = "工作台";

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        SharedPreferences prefs = getSharedPreferences("haas", MODE_PRIVATE);
        if (intent != null && intent.getStringExtra("token") != null) {
            token = intent.getStringExtra("token");
            prefs.edit().putString("token", token).apply();
        } else {
            token = prefs.getString("token", "");
        }
        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        if (handler != null && pollTask != null) handler.removeCallbacks(pollTask);
        if (tone != null) {
            tone.release();
            tone = null;
        }
        super.onDestroy();
    }

    private void doPoll() {
        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    MainActivity.HttpResult r = MainActivity.http("GET", BASE + "/api/sessions", null, token);
                    if (r.code == 401) {
                        relogin();
                        return;
                    }
                    if (r.code != 200) return;
                    int count = countOccurrences(r.body, "\"isPending\":true");
                    int prev = lastPending;
                    lastPending = count;
                    if (prev >= 0 && count > prev) {
                        alert(count);
                    }
                } catch (Exception ignored) {
                }
            }
        }).start();
    }

    private void relogin() {
        final SharedPreferences prefs = getSharedPreferences("haas", MODE_PRIVATE);
        final String pwd = prefs.getString("pwd", null);
        if (pwd == null) return;
        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    String json = "{\"password\":\"" + pwd.replace("\\", "\\\\").replace("\"", "\\\"") + "\"}";
                    MainActivity.HttpResult r = MainActivity.http("POST", BASE + "/api/admin/login", json, null);
                    if (r.code == 200) {
                        String t = extractJsonString(r.body, "token");
                        if (t != null) {
                            token = t;
                            prefs.edit().putString("token", t).apply();
                        }
                    }
                } catch (Exception ignored) {
                }
            }
        }).start();
    }

    static String extractJsonString(String body, String key) {
        String needle = "\"" + key + "\"";
        int i = body.indexOf(needle);
        if (i < 0) return null;
        int c = body.indexOf(':', i + needle.length());
        if (c < 0) return null;
        int q1 = body.indexOf('"', c + 1);
        if (q1 < 0) return null;
        StringBuilder sb = new StringBuilder();
        for (int j = q1 + 1; j < body.length(); j++) {
            char ch = body.charAt(j);
            if (ch == '\\' && j + 1 < body.length()) {
                sb.append(body.charAt(++j));
            } else if (ch == '"') {
                break;
            } else {
                sb.append(ch);
            }
        }
        return sb.toString();
    }

    static int countOccurrences(String s, String sub) {
        int count = 0;
        int idx = 0;
        while ((idx = s.indexOf(sub, idx)) >= 0) {
            count++;
            idx += sub.length();
        }
        return count;
    }

    private void alert(final int pendingCount) {
        handler.post(new Runnable() {
            @Override
            public void run() {
                try {
                    if (tone == null) tone = new ToneGenerator(AudioManager.STREAM_NOTIFICATION, 100);
                    tone.startTone(ToneGenerator.TONE_PROP_BEEP2, 900);
                    Vibrator vb = (Vibrator) getSystemService(VIBRATOR_SERVICE);
                    if (vb != null) {
                        long[] pattern = {0, 350, 150, 350};
                        if (Build.VERSION.SDK_INT >= 26) {
                            vb.vibrate(VibrationEffect.createWaveform(pattern, -1));
                        } else {
                            vb.vibrate(pattern, -1);
                        }
                    }
                } catch (Exception ignored) {
                }
                NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
                if (nm != null) {
                    nm.notify(2, buildNotification("有 " + pendingCount + " 位朋友正在等你回复，点击进入工作台", true, 2));
                }
            }
        });
    }

    private void createChannels() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        NotificationChannel silent = new NotificationChannel("haas", "后台监听", NotificationManager.IMPORTANCE_MIN);
        silent.setShowBadge(false);
        silent.setDescription("保持与工作台的连接");
        NotificationChannel loud = new NotificationChannel("haas_alert", "新提问提醒", NotificationManager.IMPORTANCE_HIGH);
        loud.enableVibration(true);
        if (nm != null) {
            nm.createNotificationChannel(silent);
            nm.createNotificationChannel(loud);
        }
    }

    private Notification buildNotification(String text, boolean alert, int id) {
        Intent open = new Intent(this, MainActivity.class);
        open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        int piFlags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= 23) piFlags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent pi = PendingIntent.getActivity(this, 0, open, piFlags);

        Notification.Builder b;
        if (Build.VERSION.SDK_INT >= 26) {
            b = new Notification.Builder(this, alert ? "haas_alert" : "haas");
        } else {
            b = new Notification.Builder(this);
        }
        b.setSmallIcon(R.drawable.ic_launcher)
                .setContentTitle(alert ? "🔔 新提问！" : BASE_SHORT)
                .setContentText(text)
                .setContentIntent(pi)
                .setOngoing(!alert)
                .setAutoCancel(alert);
        if (alert) b.setDefaults(Notification.DEFAULT_SOUND | Notification.DEFAULT_LIGHTS);
        return b.build();
    }
}
