# Android Tauri builds

Android now uses the same `src-tauri` Rust application and frontend as desktop.
The legacy `android/` Capacitor tree is retained for reference, but no Android
npm command or workflow selects it.

## Build an installable test APK

Install Android SDK platform/build tools 36, NDK 28.2.13676358, Java 21, Rust and
the `aarch64-linux-android` / `armv7-linux-androideabi` Rust targets. Set
`ANDROID_HOME`, `JAVA_HOME` and `NDK_HOME` to actual installed directories.

Run `npm ci`, then `npm run build:android:apk` (or `npm run build:android`).
Tauri initializes ignored Gradle glue and runs the configured frontend build.
The universal ARM64/ARMv7 debug APK is under
`src-tauri/gen/android/app/build/outputs/apk/universal/debug/`.
Override targets using `ANDROID_TARGETS=aarch64` or `ANDROID_TARGETS=x86_64`
after installing the corresponding Rust target. Debug builds are unoptimized
and are not suitable evidence for production speed or stability.

## Signed release

Keep the signing key and properties private. Create the ignored file
`src-tauri/gen/android/keystore.properties` with `storeFile`, `keyAlias`,
`password` (key password), and optionally `storePassword` when it differs.
Run `npm run build:android:release` for optimized APK and AAB outputs. The
command refuses to run without the properties file; Gradle validates the key.
Never distribute an unsigned APK or label a debug-key APK as a production release.

On the primary Windows build device, the permanent release identity is stored at
`%LOCALAPPDATA%\SirverData\signing`. Its password is protected with Windows DPAPI
for the current user, and the directory ACL is restricted. Run
`powershell -ExecutionPolicy Bypass -File scripts/build-android-release.ps1` to
materialize the ignored Gradle properties only for the duration of a signed build.
The helper deletes the plaintext properties in a `finally` block. Back up the
keystore and recovery credentials securely: losing this identity prevents future
APK updates signed as the same application.

CI push builds produce a debug artifact. A version tag or manual run with
`release=true` additionally requires repository secrets `ANDROID_KEY_BASE64`,
`ANDROID_KEY_ALIAS`, and `ANDROID_KEY_PASSWORD`. CI supports a shared
store/key password; local Gradle configuration supports separate passwords.
Only signed release files are attached to version releases.

## Migration and acceptance gate

The existing Tauri identity is `top.sirverdata.app`. Legacy Capacitor used
`com.sirverdata.chat`; Android treats them as different apps. Installing Tauri
does not upgrade or transfer the legacy app's session/cache. Do not uninstall
the old app before testing the new one. Preserve the same Tauri signing key
for future updates, and increment the Android version before a later release.

Before replacing the default website APK, test on a signed-in real device:
chat startup, repeated channel switching, older history/scroll anchors, microphone
deny/allow, voice join and two-way audio, camera, reconnection, hardware Back,
password-reset links, downloads, notifications, screen lock and background calls.
Manifest permissions are not proof of working background services or notifications.
The current notification adapter uses Capacitor only in the legacy shell, so
native notification parity is not established in Tauri.

Step 7's API-v2 canary flag, suppressed timing telemetry, public web deployment
and access-control blockers are unchanged. This migration does not enable an
unverified gateway rollout or claim measured latency improvements.

Official signing reference: https://v2.tauri.app/distribute/sign/android/
