import type { UnlistenFn } from '@tauri-apps/api/event';

// Keep the desktop bridge out of the browser/mobile startup graph.  This
// module is imported by the shell for lightweight platform detection, while
// the native Tauri plugins are loaded only when a desktop action is invoked.
// Besides reducing the initial bundle, this prevents plugin initialization
// from opening a browser/download flow during app startup.
const loadTauriWindow = () => import('@tauri-apps/api/window');
const loadTauriPath = () => import('@tauri-apps/api/path');
const loadTauriEvent = () => import('@tauri-apps/api/event');
const loadTauriCore = () => import('@tauri-apps/api/core');
const loadTauriOpener = () => import('@tauri-apps/plugin-opener');
const loadTauriShell = () => import('@tauri-apps/plugin-shell');
const loadTauriDialog = () => import('@tauri-apps/plugin-dialog');
const loadTauriFs = () => import('@tauri-apps/plugin-fs');

export type TargetOS = 'windows' | 'linux' | 'android' | 'macos' | 'unknown';

export function getPlatformOS(): TargetOS {
  if (isAndroidPlatform()) return 'android';
  if (typeof window === 'undefined') return 'unknown';
  const ua = (navigator.userAgent || '').toLowerCase();
  const platform = ((navigator as any).userAgentData?.platform || navigator.platform || '').toLowerCase();

  if (platform.includes('win') || ua.includes('windows')) return 'windows';
  if (platform.includes('linux') || ua.includes('linux')) return 'linux';
  if (platform.includes('mac') || ua.includes('macintosh') || ua.includes('mac os')) return 'macos';
  return 'unknown';
}

export function isTauriEnvironment(): boolean {
  if (typeof window === 'undefined') return false;
  return Boolean(
    (window as any).__TAURI__ ||
    (window as any).__TAURI_INTERNALS__ ||
    (window as any).isTauri
  );
}

export function isAndroidPlatform(): boolean {
  if (typeof window === 'undefined') return false;
  if ((window as any).Capacitor?.getPlatform?.() === 'android') return true;
  const ua = navigator.userAgent || '';
  return /Android/i.test(ua);
}

export function isMobilePlatform(): boolean {
  if (typeof window === 'undefined') return false;
  if ((window as any).Capacitor) {
    const capPlatform = (window as any).Capacitor.getPlatform?.();
    if (capPlatform === 'android' || capPlatform === 'ios') return true;
  }
  const ua = navigator.userAgent || '';
  return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua);
}

/**
 * Load the Capacitor app plugin only for the legacy Capacitor shell. Tauri
 * desktop and Tauri Android do not use this bridge, so importing it eagerly
 * would add startup work (and can make native navigation look like a web
 * hand-off).
 */
async function getCapacitorApp() {
  if (typeof window === 'undefined' || isTauriEnvironment()) return null;
  const capacitor = (window as any).Capacitor;
  if (!capacitor?.isNativePlatform?.()) return null;
  try {
    const module = await import('@capacitor/app');
    return module.App;
  } catch {
    return null;
  }
}

export function isDesktopPlatform(): boolean {
  if (typeof window === 'undefined') return false;
  if (isMobilePlatform()) return false;
  
  // Running inside Tauri desktop app (Windows, macOS, Linux)
  if (isTauriEnvironment()) return true;

  // Running inside Electron or custom desktop webview wrapper
  if (Boolean((window as any).electron || (window as any).electronAPI)) return true;
  const ua = (navigator.userAgent || '').toLowerCase();
  if (ua.includes('electron') || ua.includes('tauri') || ua.includes('sirver-desktop')) return true;

  // Manual override flag for testing or explicit desktop titlebar simulation
  if (typeof window !== 'undefined' && window.location) {
    try {
      const search = new URLSearchParams(window.location.search);
      if (search.get('desktop') === 'true') return true;
    } catch {
      // ignore query parsing errors
    }
  }
  if (typeof localStorage !== 'undefined' && localStorage.getItem('sirver_force_desktop_titlebar') === 'true') {
    return true;
  }

  return false;
}

// Default Download Directory Subpath
export const TAURI_DOWNLOAD_SUBDIR = 'Downloads';
export const CUSTOM_DOWNLOAD_DIR_STORAGE_KEY = 'sirver_custom_download_dir';

export function getCustomDownloadDirSetting(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(CUSTOM_DOWNLOAD_DIR_STORAGE_KEY) || null;
}

export function setCustomDownloadDirSetting(path: string | null): void {
  if (typeof window === 'undefined') return;
  if (path && path.trim()) {
    localStorage.setItem(CUSTOM_DOWNLOAD_DIR_STORAGE_KEY, path.trim());
  } else {
    localStorage.removeItem(CUSTOM_DOWNLOAD_DIR_STORAGE_KEY);
  }
}

/**
 * Open native folder picker dialog if running in Tauri desktop environment.
 */
export async function selectFolderWithNativeDialog(): Promise<string | null> {
  if (isTauriEnvironment()) {
    try {
      const { open: openDialog } = await loadTauriDialog();
      const selected = await openDialog({
        directory: true,
        multiple: false,
        title: 'Select Download Directory',
      });
      if (typeof selected === 'string' && selected) {
        console.log('[TauriDesktopService] Selected folder via plugin-dialog:', selected);
        return selected;
      }
    } catch (e) {
      console.warn('[TauriDesktopService] plugin-dialog open error:', e);
    }
    try {
      if ((window as any).__TAURI__?.dialog?.open) {
        const selected = await (window as any).__TAURI__.dialog.open({
          directory: true,
          multiple: false,
          title: 'Select Download Directory',
        });
        if (typeof selected === 'string' && selected) return selected;
      }
    } catch (e) {
      console.warn('[TauriDesktopService] window.__TAURI__.dialog.open error:', e);
    }
    try {
      const { invoke } = await loadTauriCore();
      const selected = await invoke<string>('plugin:dialog|open', {
        directory: true,
        multiple: false,
      });
      if (selected && typeof selected === 'string') return selected;
    } catch (e) {
      console.warn('[TauriDesktopService] invoke plugin:dialog|open error:', e);
    }
  }
  return null;
}

/**
 * Resolves the active download directory dynamically using OS APIs or user custom settings.
 * Default is the OS's native Downloads directory.
 * Automatically falls back to standard OS default location if custom folder is unavailable or deleted.
 */
export async function getDownloadDirectory(): Promise<string> {
  const os = getPlatformOS();

  // 1. Check custom user setting
  const customDir = getCustomDownloadDirSetting();
  if (customDir && customDir.trim()) {
    const trimmed = customDir.trim();
    if (isTauriEnvironment()) {
      try {
        const { exists, mkdir } = await loadTauriFs();
        const dirExists = await exists(trimmed).catch(() => false);
        if (!dirExists) {
          await mkdir(trimmed, { recursive: true }).catch(() => false);
        }
        const isValidNow = await exists(trimmed).catch(() => false);
        if (isValidNow) {
          return trimmed;
        }
        console.warn('Custom download directory unavailable or deleted. Falling back to OS default location.');
      } catch (e) {
        console.warn('Failed to verify custom download directory, falling back:', e);
      }
    } else {
      return trimmed;
    }
  }

  // 2. Resolve default OS user downloads directory dynamically via platform OS APIs
  if (isTauriEnvironment()) {
    try {
      const { downloadDir, documentDir, homeDir, join } = await loadTauriPath();
      const dDir = await downloadDir().catch(() => null);
      if (dDir) {
        return dDir;
      }
      const docDir = await documentDir().catch(() => null);
      if (docDir) {
        return docDir;
      }
      const hDir = await homeDir().catch(() => null);
      if (hDir) {
        return await join(hDir, 'Downloads');
      }
    } catch (e) {
      console.warn('Failed to resolve Tauri default download directory:', e);
    }
  }

  // 3. Platform-specific fallback without hardcoded absolute paths
  if (os === 'android') {
    return '/storage/emulated/0/Download';
  }

  // Standard user relative directory fallback for cross-platform / web
  return 'Downloads';
}

export async function ensureDownloadDirectoryExists(): Promise<string> {
  const dirPath = await getDownloadDirectory();
  if (isTauriEnvironment()) {
    try {
      const { exists, mkdir } = await loadTauriFs();
      const dirExists = await exists(dirPath).catch(() => false);
      if (!dirExists) {
        await mkdir(dirPath, { recursive: true });
        console.log('[TauriDesktopService] Created missing download directory:', dirPath);
      }
    } catch (e) {
      console.warn('Tauri ensure directory error:', e);
    }
  }
  return dirPath;
}

export async function openDownloadDirectory(): Promise<boolean> {
  const dirPath = await ensureDownloadDirectoryExists();
  console.log('[TauriDesktopService] Opening download directory:', dirPath);
  return openPathExternally(dirPath);
}

/**
 * Open local file or folder path in system File Explorer / Finder / default app.
 */
export async function openPathExternally(targetPath: string): Promise<boolean> {
  if (!targetPath) {
    console.error('[TauriDesktopService] openPathExternally called with empty targetPath');
    return false;
  }

  if (isTauriEnvironment()) {
    console.log('[TauriDesktopService] Opening path in Tauri:', targetPath);

    // Ensure directory exists if targetPath is a folder
    try {
      const { exists, mkdir } = await loadTauriFs();
      const isDir = !targetPath.includes('.') || targetPath.endsWith('/') || targetPath.endsWith('\\');
      if (isDir) {
        const dirExists = await exists(targetPath).catch(() => false);
        if (!dirExists) {
          await mkdir(targetPath, { recursive: true }).catch(() => {});
        }
      }
    } catch (e) {}

    // 1. Try Tauri v2 plugin-opener openPath
    try {
      const { openPath } = await loadTauriOpener();
      await openPath(targetPath);
      return true;
    } catch (e) {
      console.warn('[TauriDesktopService] openPath error:', e);
    }
    // 2. Try window.__TAURI__.opener or shell
    try {
      if ((window as any).__TAURI__?.opener?.openPath) {
        await (window as any).__TAURI__.opener.openPath(targetPath);
        return true;
      }
      if ((window as any).__TAURI__?.shell?.open) {
        await (window as any).__TAURI__.shell.open(targetPath);
        return true;
      }
    } catch (e) {
      console.warn('[TauriDesktopService] window.__TAURI__ opener error:', e);
    }
    // 3. Try Tauri v2 plugin-shell openShell
    try {
      const { open: openShell } = await loadTauriShell();
      await openShell(targetPath);
      return true;
    } catch (e) {
      try {
        const { invoke } = await loadTauriCore();
        await invoke('plugin:opener|open_path', { path: targetPath });
        return true;
      } catch (err) {
        console.error(`[TauriDesktopService] Failed all attempts to open path: ${targetPath}`, err);
      }
    }
  }

  // Web fallback: clipboard copy path
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      await navigator.clipboard.writeText(targetPath);
      console.log(`[TauriDesktopService] Copied path to clipboard: ${targetPath}`);
    }
  } catch (e) {}
  return false;
}

/**
 * Write file natively to disk in Tauri environment, creating parent folders if missing,
 * and verifying that the file exists on disk afterward.
 */
export async function saveFileToTauriDisk(
  fullPath: string,
  blob: Blob
): Promise<{ success: boolean; error?: string }> {
  if (!isTauriEnvironment()) {
    return { success: false, error: 'Not running in Tauri environment' };
  }

  try {
    const { exists, mkdir, writeFile } = await loadTauriFs();
    // 1. Ensure parent directory exists
    const lastSepIdx = Math.max(fullPath.lastIndexOf('/'), fullPath.lastIndexOf('\\'));
    if (lastSepIdx !== -1) {
      const dirPath = fullPath.substring(0, lastSepIdx);
      const dirExists = await exists(dirPath).catch(() => false);
      if (!dirExists) {
        await mkdir(dirPath, { recursive: true });
        console.log(`[TauriDesktopService] Created missing parent directory: ${dirPath}`);
      }
    }

    // 2. Convert Blob to Uint8Array
    const arrayBuffer = await blob.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);

    // 3. Write file bytes to disk using plugin-fs
    await writeFile(fullPath, bytes);
    console.log(`[TauriDesktopService] Wrote ${bytes.length} bytes to ${fullPath}`);

    // 4. Verify file exists on disk after writing
    const fileExists = await exists(fullPath).catch(() => false);
    if (!fileExists) {
      const err = `File write reported success but file was not found on disk at ${fullPath}`;
      console.error(`[TauriDesktopService] ${err}`);
      return { success: false, error: err };
    }

    console.log(`[TauriDesktopService] File successfully written and verified on disk: ${fullPath}`);
    return { success: true };
  } catch (e: any) {
    const errorMsg = e?.message || String(e) || 'Unknown file write error';
    console.error(`[TauriDesktopService] Failed to write file to ${fullPath}:`, e);
    return { success: false, error: errorMsg };
  }
}

/**
 * Remove file from disk in Tauri environment.
 */
export async function removeFileFromTauriDisk(fullPath: string): Promise<boolean> {
  if (!isTauriEnvironment()) return false;
  try {
    const { exists, remove } = await loadTauriFs();
    const fileExists = await exists(fullPath).catch(() => false);
    if (fileExists) {
      await remove(fullPath);
      console.log(`[TauriDesktopService] Deleted file from disk: ${fullPath}`);
      return true;
    }
  } catch (e) {
    console.warn(`[TauriDesktopService] Failed to remove file from disk (${fullPath}):`, e);
  }
  return false;
}

/**
 * Check if a file exists on physical disk in Tauri environment.
 */
export async function checkFileExistsOnDisk(fullPath: string): Promise<boolean> {
  if (!isTauriEnvironment()) return false;
  try {
    const { exists } = await loadTauriFs();
    return await exists(fullPath);
  } catch (e) {
    return false;
  }
}

/**
 * Open external HTTP/HTTPS URL in default web browser.
 */
export async function openExternalUrl(url: string): Promise<boolean> {
  if (!url) return false;
  if (isTauriEnvironment()) {
    // 1. Try Tauri v2 plugin-opener openUrl
    try {
      const { openUrl } = await loadTauriOpener();
      await openUrl(url);
      return true;
    } catch (e) {
      console.warn('openUrl error:', e);
    }
    // 2. Try Tauri v2 plugin-shell openShell
    try {
      const { open: openShell } = await loadTauriShell();
      await openShell(url);
      return true;
    } catch (e) {
      try {
        const { invoke } = await loadTauriCore();
        await invoke('plugin:opener|open_url', { url });
        return true;
      } catch (err) {}
    }
  }

  // Mobile / Capacitor or Browser fallback
  try {
    if (typeof window !== 'undefined' && (window as any).Capacitor?.isNativePlatform?.()) {
      window.open(url, '_system');
      return true;
    }
    window.open(url, '_blank', 'noopener,noreferrer');
    return true;
  } catch (e) {
    console.warn('Failed to open external url:', e);
    return false;
  }
}

export async function openFileExternally(targetPath: string, objectUrl?: string): Promise<boolean> {
  if (isTauriEnvironment()) {
    const success = await openPathExternally(targetPath);
    if (success) return true;
  }

  if (objectUrl) {
    const filename = targetPath.split(/[/\\]/).pop() || 'file';
    const a = document.createElement('a');
    a.href = objectUrl;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => document.body.removeChild(a), 500);
    return true;
  }
  return false;
}

/**
 * Execute silent MSI installation for Windows (msiexec /i <msiPath> /qn /norestart).
 */
export async function executeSilentMsiInstall(msiFilePath: string): Promise<boolean> {
  if (isTauriEnvironment()) {
    try {
      const { invoke } = await loadTauriCore();
      await invoke('execute_silent_msi', { path: msiFilePath });
      return true;
    } catch (e) {
      console.warn('Tauri invoke execute_silent_msi error:', e);
    }
    try {
      const { open: openShell } = await loadTauriShell();
      await (openShell as any)('msiexec', ['/i', msiFilePath, '/qn', '/norestart']);
      return true;
    } catch (e) {
      console.warn('Tauri openShell msiexec error:', e);
    }
    try {
      return await openPathExternally(msiFilePath);
    } catch (e) {}
  }
  return false;
}

// Window control actions
export async function minimizeWindow(): Promise<void> {
  if (isTauriEnvironment()) {
    try {
      const { invoke } = await loadTauriCore();
      await invoke('minimize_window');
      return;
    } catch (e) {}
    try {
      const { getCurrentWindow } = await loadTauriWindow();
      const appWindow = getCurrentWindow();
      await appWindow.minimize();
      return;
    } catch (e) {
      console.warn('Minimize window failed:', e);
    }
  }
  try {
    const capApp = await getCapacitorApp();
    if (capApp && typeof capApp.minimizeApp === 'function') {
      await capApp.minimizeApp();
    }
  } catch (e) {}
}

export async function showAndFocusWindow(): Promise<void> {
  if (isTauriEnvironment()) {
    try {
      const { getCurrentWindow } = await loadTauriWindow();
      const appWindow = getCurrentWindow();
      await appWindow.show();
      await appWindow.unminimize();
      await appWindow.setFocus();
      return;
    } catch (e) {
      console.warn('showAndFocusWindow via getCurrentWindow failed:', e);
    }
  }
  try {
    window.focus();
  } catch (e) {}
}

export async function toggleMaximizeWindow(): Promise<boolean> {
  if (isTauriEnvironment()) {
    try {
      const { invoke } = await loadTauriCore();
      const res = await invoke<boolean>('toggle_maximize_window');
      return res;
    } catch (e) {}
    try {
      const { getCurrentWindow } = await loadTauriWindow();
      const appWindow = getCurrentWindow();
      const isMax = await appWindow.isMaximized();
      if (isMax) {
        await appWindow.unmaximize();
        return false;
      } else {
        await appWindow.maximize();
        return true;
      }
    } catch (e) {
      console.warn('Toggle maximize failed:', e);
    }
  }

  // Browser Fullscreen fallback
  try {
    if (!document.fullscreenElement) {
      if (document.documentElement.requestFullscreen) {
        await document.documentElement.requestFullscreen();
        return true;
      }
    } else {
      if (document.exitFullscreen) {
        await document.exitFullscreen();
        return false;
      }
    }
  } catch (e) {}

  return Boolean(document.fullscreenElement);
}

/**
 * Close (X) button action:
 * Hides/minimizes the main window to system tray without terminating the application process
 * or disconnecting realtime PocketBase/WebSocket connections (Discord style behavior).
 */
export async function closeWindow(): Promise<void> {
  if (isTauriEnvironment()) {
    try {
      const { invoke } = await loadTauriCore();
      await invoke('close_to_tray');
      return;
    } catch (e) {}
    try {
      const { getCurrentWindow } = await loadTauriWindow();
      const appWindow = getCurrentWindow();
      await appWindow.hide();
      return;
    } catch (e) {
      console.warn('Hide window via appWindow.hide() failed:', e);
      try {
        const { getCurrentWindow } = await loadTauriWindow();
        const appWindow = getCurrentWindow();
        await appWindow.minimize();
        return;
      } catch (err) {}
    }
  }

  // Capacitor / Mobile fallback
  try {
    const capApp = await getCapacitorApp();
    if (capApp && typeof capApp.minimizeApp === 'function') {
      await capApp.minimizeApp();
      return;
    }
  } catch (e) {}
}

/**
 * Native Tauri window close requested event interceptor.
 * When the user clicks the real OS X button or triggers close, hide the window instead of terminating process.
 */
export async function setupWindowCloseRequestedListener(): Promise<UnlistenFn | null> {
  if (!isTauriEnvironment()) return null;
  try {
    const { getCurrentWindow } = await loadTauriWindow();
    const appWindow = getCurrentWindow();
    if (appWindow && typeof appWindow.onCloseRequested === 'function') {
      const unlisten = await appWindow.onCloseRequested(async (event) => {
        // Prevent default window close/destruction
        event.preventDefault();
        // Hide window and keep process alive in background
        await appWindow.hide();
      });
      return unlisten;
    }
  } catch (e) {
    console.warn('Failed to setup Tauri onCloseRequested listener:', e);
  }
  return null;
}

export async function isWindowMaximized(): Promise<boolean> {
  try {
    if (!isTauriEnvironment()) return Boolean(document.fullscreenElement);
    const { getCurrentWindow } = await loadTauriWindow();
    const appWindow = getCurrentWindow();
    return await appWindow.isMaximized();
  } catch (e) {
    return Boolean(document.fullscreenElement);
  }
}

export async function startWindowDragging(): Promise<void> {
  try {
    if (!isTauriEnvironment()) return;
    const { getCurrentWindow } = await loadTauriWindow();
    const appWindow = getCurrentWindow();
    await appWindow.startDragging();
  } catch (e) {
    // ignore
  }
}

// Window state restore / save
const WINDOW_STATE_KEY = 'sirverdata_window_state';

export async function restoreWindowState(): Promise<void> {
  try {
    const saved = localStorage.getItem(WINDOW_STATE_KEY);
    if (saved) {
      const state = JSON.parse(saved);
      if (state.isMaximized) {
        const isMax = await isWindowMaximized();
        if (!isMax) {
          await toggleMaximizeWindow();
        }
      }
    }
  } catch (e) {}
}

export async function saveWindowState(): Promise<void> {
  try {
    const isMax = await isWindowMaximized();
    localStorage.setItem(WINDOW_STATE_KEY, JSON.stringify({ isMaximized: isMax }));
  } catch (e) {}
}

/**
 * Creates a real JavaScript File object with actual content from a local disk path (using Tauri plugin-fs).
 */
export async function createRealFileFromLocalPath(filePath: string): Promise<File> {
  const fileName = filePath.split(/[/\\]/).pop() || 'attachment_file';
  if (isTauriEnvironment()) {
    try {
      const { readFile } = await loadTauriFs();
      const bytes = await readFile(filePath);
      return new File([bytes], fileName, { type: 'application/octet-stream' });
    } catch (e) {
      console.warn('Failed to read local file bytes in Tauri:', e);
    }
  }
  return new File([], fileName, { type: 'application/octet-stream' });
}

// File drop listener for Tauri v2
export async function setupTauriFileDropListener(
  onFilesDropped: (paths: string[], files?: File[]) => void
): Promise<UnlistenFn | null> {
  if (!isTauriEnvironment()) return null;

  try {
    const { getCurrentWindow } = await loadTauriWindow();
    const appWindow = getCurrentWindow();
    if (appWindow && typeof appWindow.onDragDropEvent === 'function') {
      const unlisten = await appWindow.onDragDropEvent(async (event) => {
        if (event.payload.type === 'drop') {
          const paths = event.payload.paths || [];
          if (paths.length > 0) {
            const realFiles: File[] = [];
            for (const p of paths) {
              const file = await createRealFileFromLocalPath(p);
              (file as any).path = p;
              realFiles.push(file);
            }
            onFilesDropped(paths, realFiles);
          }
        }
      });
      return unlisten;
    }
  } catch (e) {
    console.warn('onDragDropEvent error:', e);
  }

  // Fallback: listen for 'tauri://drag-drop'
  try {
    const { listen } = await loadTauriEvent();
    const unlisten = await listen<any>('tauri://drag-drop', async (event) => {
      const payload = event.payload;
      let paths: string[] = [];
      if (Array.isArray(payload)) {
        paths = payload;
      } else if (payload && Array.isArray(payload.paths)) {
        paths = payload.paths;
      }
      if (paths.length > 0) {
        const realFiles: File[] = [];
        for (const p of paths) {
          const file = await createRealFileFromLocalPath(p);
          (file as any).path = p;
          realFiles.push(file);
        }
        onFilesDropped(paths, realFiles);
      }
    });
    return unlisten;
  } catch (e) {
    console.warn('Failed to listen to tauri drag-drop event:', e);
    return null;
  }
}
