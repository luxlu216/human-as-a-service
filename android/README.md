# Android 壳应用（Luxlu 工作台）

将 `/admin` 网页工作台打包成独立安卓 App 的 WebView 壳工程，附带前台服务监听新提问（响铃 + 震动 + 通知）。

## 结构

- `app/AndroidManifest.xml` — 清单（权限：INTERNET / 前台服务 / 通知 / 震动）
- `app/java/com/luxlu/console/MainActivity.java` — WebView 壳 + 原生登录（保存 ADMIN_PASSWORD，自动拿 token 注入网页免登录）
- `app/java/com/luxlu/console/PollService.java` — 前台服务，每 8 秒轮询 `/api/sessions`，新提问提醒
- `app/res/` — 主题与图标资源

## 手工构建（无需 Android Studio / Gradle）

需要 JDK 17、Android build-tools 35、platforms/android-35：

```bash
BT=<build-tools 路径>; AJ=<android-35>/android.jar

aapt2 compile --dir app/res -o build/res.zip
aapt2 link -o build/base.apk --manifest app/AndroidManifest.xml -I "$AJ" --java build/gen build/res.zip --auto-add-overlay
javac -encoding UTF-8 -source 8 -target 8 -nowarn -cp "$AJ" -d build/classes app/java/com/luxlu/console/*.java build/gen/com/luxlu/console/R.java
d8 --release --lib "$AJ" --output build build/classes/com/luxlu/console/*.class
# 将 build/classes.dex 加入 base.apk（zip 方式），然后：
zipalign -f 4 build/base.apk build/aligned.apk
keytool -genkeypair -keystore release.keystore -alias <alias> -keyalg RSA -keysize 2048 -validity 10000 ...
apksigner sign --ks release.keystore --out LuxluConsole.apk build/aligned.apk
```

## ⚠️ 签名

签名密钥库（keystore）**不入库**，请本地妥善保管。升级安装必须使用同一密钥签名，否则无法覆盖安装。

## 服务端地址

`PollService.BASE` 与 `MainActivity.APP_HOST` 中写死了 `luxlu.zeabur.app`，换域名时需同步修改后重新打包。
