# Flint Cogsworth – character sheet app

This branch holds the Android app for Flint's character sheet. It is separate from the Barovia wiki on `main`
and does not affect the GitHub Pages site.

- `web/index.html` – the sheet itself (works offline, saves on the device)
- `android/` – a small WebView wrapper that adds backup-to-Downloads and file loading
- Every push to this branch builds a signed APK and attaches it to a release named `flint-vN`.

Updating: install the newer APK over the old one. Your data is kept because every build uses the same signing key.
Uninstalling the app deletes its data, so save a backup file first.
