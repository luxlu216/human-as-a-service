package com.luxlu.console;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.text.InputType;
import android.view.Gravity;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.Toast;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

public class MainActivity extends Activity {

    private static final String START_URL = PollService.BASE + "/";
    private static final String APP_HOST = "luxlu.zeabur.app";

    private WebView webView;
    private SharedPreferences prefs;
    private boolean tokenInjected = false;
    private boolean booting = false;

    static class HttpResult {
        final int code;
        final String body;

        HttpResult(int code, String body) {
            this.code = code;
            this.body = body;
        }
    }

    static HttpResult http(String method, String urlStr, String body, String token) throws Exception {
        URL url = new URL(urlStr);
        HttpURLConnection c = (HttpURLConnection) url.openConnection();
        c.setRequestMethod(method);
        c.setConnectTimeout(10000);
        c.setReadTimeout(10000);
        if (token != null && !token.isEmpty()) c.setRequestProperty("X-Admin-Token", token);
        if (body != null) {
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/json");
            OutputStream os = c.getOutputStream();
            os.write(body.getBytes("UTF-8"));
            os.close();
        }
        int code = c.getResponseCode();
        BufferedReader r = new BufferedReader(new InputStreamReader(
                code < 400 ? c.getInputStream() : c.getErrorStream(), "UTF-8"));
        StringBuilder sb = new StringBuilder();
        String line;
        while ((line = r.readLine()) != null) sb.append(line);
        r.close();
        return new HttpResult(code, sb.toString());
    }

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences("haas", MODE_PRIVATE);

        webView = new WebView(this);
        setContentView(webView);

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setSupportZoom(false);
        s.setJavaScriptCanOpenWindowsAutomatically(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);

        webView.setBackgroundColor(0xFF0B1120);
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (APP_HOST.equals(uri.getHost())) {
                    return false;
                }
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                } catch (Exception ignored) {
                }
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                if (url != null && url.startsWith("https://" + APP_HOST)
                        && !tokenInjected && prefs.contains("token")) {
                    tokenInjected = true;
                    String token = prefs.getString("token", "");
                    String js = "try{localStorage.setItem('gugu_admin_token','" + token + "')}catch(e){};"
                            + "if(location.pathname==='/'){location.replace('/admin')}";
                    view.evaluateJavascript(js, null);
                }
            }
        });

        requestNotifyPermission();

        if (savedInstanceState != null) {
            tokenInjected = true;
            webView.restoreState(savedInstanceState);
        } else {
            boot();
        }
    }

    private void requestNotifyPermission() {
        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 1);
        }
    }

    private void boot() {
        if (booting) return;
        booting = true;
        final String pwd = prefs.getString("pwd", null);
        if (pwd == null) {
            booting = false;
            askPassword("", "首次使用请输入工作台登录密码（ADMIN_PASSWORD），仅保存在本机。");
            return;
        }
        webView.loadUrl(START_URL);
        new Thread(new Runnable() {
            @Override
            public void run() {
                String token = prefs.getString("token", "");
                boolean tokenOk = false;
                if (!token.isEmpty()) {
                    try {
                        HttpResult r = http("GET", PollService.BASE + "/api/sessions", null, token);
                        tokenOk = (r.code == 200);
                    } catch (Exception ignored) {
                    }
                }
                if (!tokenOk) {
                    try {
                        String json = "{\"password\":\"" + pwd.replace("\\", "\\\\").replace("\"", "\\\"") + "\"}";
                        HttpResult r = http("POST", PollService.BASE + "/api/admin/login", json, null);
                        if (r.code == 200) {
                            token = PollService.extractJsonString(r.body, "token");
                            if (token == null) token = "";
                        } else {
                            final boolean badPwd = (r.code == 401);
                            runOnUiThread(new Runnable() {
                                @Override
                                public void run() {
                                    booting = false;
                                    askPassword(prefs.getString("pwd", ""),
                                            badPwd ? "密码不正确，请重新输入：" : "无法登录服务器，请检查网络后重试：");
                                }
                            });
                            return;
                        }
                    } catch (Exception e) {
                        runOnUiThread(new Runnable() {
                            @Override
                            public void run() {
                                booting = false;
                                askPassword(pwd, "连接服务器失败，请检查网络后重试：");
                            }
                        });
                        return;
                    }
                }
                final String t = token;
                prefs.edit().putString("token", t).apply();
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        if (!t.isEmpty() && !tokenInjected) {
                            tokenInjected = true;
                            String js = "try{localStorage.setItem('gugu_admin_token','" + t + "')}catch(e){};"
                                    + "if(location.pathname==='/'){location.replace('/admin')}";
                            webView.evaluateJavascript(js, null);
                        }
                        Intent si = new Intent(MainActivity.this, PollService.class);
                        si.putExtra("token", t);
                        if (Build.VERSION.SDK_INT >= 26) {
                            startForegroundService(si);
                        } else {
                            startService(si);
                        }
                    }
                });
            }
        }).start();
    }

    private void askPassword(String prefilled, String message) {
        final EditText input = new EditText(this);
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        input.setText(prefilled);
        input.setGravity(Gravity.CENTER);
        FrameLayout wrap = new FrameLayout(this);
        int pad = (int) (24 * getResources().getDisplayMetrics().density);
        wrap.setPadding(pad, 0, pad, 0);
        wrap.addView(input, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT));
        new AlertDialog.Builder(this, android.R.style.Theme_Material_Dialog_Alert)
                .setTitle("工作台登录")
                .setMessage(message)
                .setView(wrap)
                .setCancelable(false)
                .setPositiveButton("确定", new android.content.DialogInterface.OnClickListener() {
                    @Override
                    public void onClick(android.content.DialogInterface dialog, int which) {
                        String p = input.getText().toString().trim();
                        if (p.isEmpty()) {
                            askPassword("", message);
                            return;
                        }
                        prefs.edit().putString("pwd", p).apply();
                        boot();
                    }
                })
                .show();
        Toast.makeText(this, "提示：密码就是 Zeabur 变量里的 ADMIN_PASSWORD", Toast.LENGTH_LONG).show();
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        webView.saveState(outState);
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }
}
