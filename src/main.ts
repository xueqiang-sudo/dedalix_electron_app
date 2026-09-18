/**
 * Dedalix Desktop Client — Main Process Entry Point
 *
 * Bootstraps the Electron application:
 *   1. Enforce single-instance lock
 *   2. Register dedalix:// protocol handler
 *   3. Create the main window and system tray
 *   4. Handle deep links from protocol invocations (macOS open-url, Windows second-instance)
 */

import {app, BrowserWindow, Menu, ipcMain, net, shell, desktopCapturer, screen, globalShortcut} from 'electron';
import * as path from 'path';
import * as fs from 'fs';

import {
    registerProtocol,
    getDeepLinkURL,
    handleDeepLink,
} from './protocol';
import {createMainWindow, showMainWindow, getMainWindow} from './window';
import {createTray, destroyTray} from './tray';

// ─── IPC: Download file and open with default app ───────────────────────
ipcMain.handle('download-and-open-file', async (_event, url: string, filename: string) => {
    const tempPath = path.join(app.getPath('temp'), filename);
    const resp = await net.fetch(url);
    if (!resp.ok) {
        throw new Error(`Download failed: ${resp.status} ${resp.statusText}`);
    }
    const buffer = Buffer.from(await resp.arrayBuffer());
    fs.writeFileSync(tempPath, buffer);
    await shell.openPath(tempPath);
    return tempPath;
});

// ─── IPC: Capture screen for screenshot feature ─────────────────────────
// Plan B: Hide window → capture clean desktop → show window → return image
ipcMain.handle('capture-screen', async () => {
    const win = getMainWindow();
    let wasVisible = false;

    try {
        // Step 1: Hide the main window so it doesn't appear in the screenshot
        if (win && !win.isDestroyed()) {
            wasVisible = win.isVisible();
            if (wasVisible) {
                win.hide();
            }
        }

        // Step 2: Wait for the desktop to repaint (window fully hidden)
        await new Promise((resolve) => setTimeout(resolve, 200));

        // Step 3: Capture the clean desktop screenshot
        const primaryDisplay = screen.getPrimaryDisplay();
        const {width, height} = primaryDisplay.size;
        const scaleFactor = primaryDisplay.scaleFactor;

        const sources = await desktopCapturer.getSources({
            types: ['screen'],
            thumbnailSize: {
                width: Math.round(width * scaleFactor),
                height: Math.round(height * scaleFactor),
            },
        });

        // Step 4: Show the window again (before returning, so ScreenshotOverlay can render)
        if (win && !win.isDestroyed() && wasVisible) {
            win.show();
        }

        if (sources.length === 0) {
            return null;
        }

        const thumb = sources[0].thumbnail;
        const jpegBuffer = thumb.toJPEG(85);
        const dataURL = `data:image/jpeg;base64,${jpegBuffer.toString('base64')}`;
        return {
            dataURL,
            width: thumb.getSize().width,
            height: thumb.getSize().height,
        };
    } catch (err) {
        // Ensure window is restored on error
        if (win && !win.isDestroyed() && wasVisible) {
            win.show();
        }
        console.error('[screenshot] Failed to capture screen:', err);
        return null;
    }
});

// ─── Remove default menu (File, Edit, View, etc.) ──────────────────────
Menu.setApplicationMenu(null);

// ─── Step 1: Enforce single instance ────────────────────────────────────
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
    // Another instance is already running — quit this one
    app.quit();
} else {
    // ─── Step 2: Register protocol BEFORE app.ready ─────────────────────
    registerProtocol();

    // ─── Step 3: App lifecycle ──────────────────────────────────────────

    // Deep link URL captured before the window is created
    let pendingDeepLink: string | undefined;

    // macOS: protocol URLs arrive via open-url event (even before app is ready)
    app.on('will-finish-launching', () => {
        app.on('open-url', (event, url) => {
            event.preventDefault();

            if (app.isReady()) {
                handleDeepLink(url);
            } else {
                // App not ready yet — queue the deep link
                pendingDeepLink = url;
            }
        });
    });

    // Windows/Linux: second-instance passes its argv (including the protocol URL)
    app.on('second-instance', (_event, argv) => {
        const deepLinkUrl = getDeepLinkURL(argv);
        if (deepLinkUrl) {
            handleDeepLink(deepLinkUrl);
        } else {
            // No deep link — just show the existing window
            showMainWindow();
        }
    });

    // App is ready — create the main window
    app.whenReady().then(() => {
        // Re-register protocol after app ready as a safety net (Windows)
        // Some Windows versions need this after the installer runs
        registerProtocol();

        // Check for a deep link from cold-start argv (Windows/Linux)
        const coldStartDeepLink =
            pendingDeepLink || getDeepLinkURL(process.argv.slice(1));

        createMainWindow(coldStartDeepLink);
        createTray();

        // ─── Register global screenshot shortcut (Ctrl+Alt+A) ─────────
        globalShortcut.register('CommandOrControl+Alt+A', () => {
            const win = getMainWindow();
            if (win && !win.isDestroyed()) {
                win.webContents.send('trigger-screenshot');
            }
        });

        // macOS: re-create window when dock icon is clicked and no windows exist
        app.on('activate', () => {
            if (BrowserWindow.getAllWindows().length === 0) {
                createMainWindow();
            } else {
                showMainWindow();
            }
        });
    });

    // ─── Step 4: Cleanup ────────────────────────────────────────────────

    app.on('window-all-closed', () => {
        // On macOS, keep the app running in the tray
        if (process.platform !== 'darwin') {
            destroyTray();
            app.quit();
        }
    });

    app.on('before-quit', () => {
        destroyTray();
        globalShortcut.unregisterAll();
    });
}
