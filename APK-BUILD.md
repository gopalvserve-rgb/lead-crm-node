# Build an Android APK from the Lead CRM PWA

The Lead CRM is a Progressive Web App (PWA). You can install it directly on an Android phone, or package it as a signed APK and distribute via Google Play or a link.

There are two officially-supported paths. Pick whichever fits you.

---

## Option 1 — PWABuilder (easiest, no tools required)

1. Go to https://www.pwabuilder.com
2. Paste your live URL: `https://lead-crm-production-3628.up.railway.app`
3. Click **Start**. PWABuilder analyzes the site, checks the manifest, and generates a **Package** for Android.
4. Choose **Android → Generate Package**. Select "Signed APK" if you want an APK you can install immediately, or "AAB" for Google Play.
5. Download the zip. It contains:
   - `app-release-signed.apk` — sideload directly on any Android phone
   - Signing-key files — **keep these safe**, you'll need the same key to ship updates
6. On your phone: enable "Install from unknown sources" in Settings, then open the APK.

**Pros:** zero install, done in 3 minutes, free.
**Cons:** you don't own the build pipeline — each update means regenerating the APK (but the content inside the APK is always the latest, because it loads the live URL).

---

## Option 2 — Bubblewrap CLI (full control, reproducible builds)

Bubblewrap is Google's official tool for wrapping a PWA as an Android **TWA** (Trusted Web Activity). It produces a real APK that's identical to what Play Store publishes.

### Prerequisites
- Node.js 18+
- JDK 17 (Bubblewrap uses it internally — installs automatically on first run)
- A computer running macOS, Linux, or Windows

### Steps

```bash
# 1. Install Bubblewrap
npm install -g @bubblewrap/cli

# 2. Initialize from the live manifest
bubblewrap init --manifest https://lead-crm-production-3628.up.railway.app/manifest.webmanifest

# Follow the prompts:
#   - Application name:         Lead CRM
#   - Short name:               LeadCRM
#   - App package name:         com.yourcompany.leadcrm
#   - Display mode:             standalone
#   - Signing keystore path:    (press Enter for default)
#   - Signing key alias:        android
#   - Signing key password:     (choose a strong password — save it!)

# 3. Build the APK
bubblewrap build

# Output:  app-release-signed.apk     ← install this on your phone
#          app-release-bundle.aab     ← upload this to Google Play
```

### Updating the APK later
When you push new features to the CRM, you don't have to rebuild the APK — the content is loaded from the live URL. You only rebuild the APK when you want to change:
- App name / icon
- The URL it points to
- The minimum Android version

To rebuild with new content:
```bash
bubblewrap update
bubblewrap build
```

### Verify Digital Asset Links (required for full-screen / no-URL-bar mode)

Bubblewrap prints your SHA-256 fingerprint after the first build. Paste it into a file at:

```
https://lead-crm-production-3628.up.railway.app/.well-known/assetlinks.json
```

With content:
```json
[{
  "relation": ["delegate_permission/common.handle_all_urls"],
  "target": {
    "namespace": "android_app",
    "package_name": "com.yourcompany.leadcrm",
    "sha256_cert_fingerprints": ["<paste SHA-256 here>"]
  }
}]
```

If you skip this step, the app still works but shows a URL bar at the top (like a browser). With it, the TWA runs truly full-screen like a native app.

To serve that file from this CRM, put it in `public/.well-known/assetlinks.json` and it's live.

---

## Option 3 — Capacitor wrapper (native-feeling wrapper with plugins)

If you want native features (push notifications, biometric login, file pickers), use **Capacitor**:

```bash
# 1. Create a minimal wrapper project
mkdir lead-crm-mobile && cd lead-crm-mobile
npm init -y
npm install @capacitor/core @capacitor/android
npx cap init "Lead CRM" com.yourcompany.leadcrm --web-dir=www

# 2. Create a www/index.html that redirects to the live URL
mkdir www && cat > www/index.html <<'EOF'
<!DOCTYPE html>
<html><head><meta http-equiv="refresh" content="0; url=https://lead-crm-production-3628.up.railway.app/"></head></html>
EOF

# 3. Add Android
npx cap add android
npx cap open android
# Android Studio opens → Build → Build Bundle(s) / APK(s) → Build APK
```

This gives you a real native shell where you can later add plugins like `@capacitor/push-notifications` for offline push.

---

## Install on your phone right now — no APK needed

The app is already installable:
1. Open **https://lead-crm-production-3628.up.railway.app/** on Chrome (Android)
2. Tap the 3-dot menu → **Add to Home screen**
3. Done — app icon on your home screen, opens full-screen, works like a native app.

This is the fastest way to get a "mobile app" experience.

---

## Summary

| Approach | Time | Reqs | Output |
|---|---|---|---|
| **Add to Home Screen** | 30s | Just a phone | Installable PWA icon |
| **PWABuilder** | 3 min | Browser only | Signed APK + AAB |
| **Bubblewrap CLI** | 15 min | Node.js | Reproducible TWA APK |
| **Capacitor** | 30 min | Android Studio | Native-wrapped APK with plugin slots |

For most teams, **PWABuilder** is the recommended path. The APK it generates auto-updates whenever you push to Railway (since it loads the live URL), so you never have to rebuild to ship features.
