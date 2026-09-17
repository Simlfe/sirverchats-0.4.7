# SirverData landing page

Static source for `https://sirverdata.top`.

- Keep download filenames versioned: `SirverData-<version>-<platform>-<arch>.<ext>`.
- Keep `og:image` and `twitter:image` pointed at the current versioned preview.
- Deploy `index.html`, `styles.css`, `favicon.ico`, `assets/`, and `downloads/` to `/var/www/html` on the landing host.
- The Android package is the signed Tauri build (`top.sirverdata.app`), not the legacy Capacitor package.
