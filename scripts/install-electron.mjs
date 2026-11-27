// Electron 45+ no longer downloads its binary during `npm install` (it dropped
// its postinstall script), but electron-vite (`npm run dev` / `npm start`)
// needs the binary on disk and fails with "Electron uninstall" without it.
// This fetches it as part of our own postinstall. It's a no-op when the right
// version is already present.
//
// CI jobs that never launch Electron (lint, tests, packaging, which downloads
// its own copy) set ELECTRON_SKIP_BINARY_DOWNLOAD=1 to skip the ~100MB download.
if (process.env.ELECTRON_SKIP_BINARY_DOWNLOAD) {
  console.log('Skipping Electron binary download (ELECTRON_SKIP_BINARY_DOWNLOAD is set).');
  process.exit(0);
}

await import('electron/install.js');
