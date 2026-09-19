/**
 * Dedalix Desktop Client — Main Process Entry Point
 *
 * Bootstraps the Electron application:
 *   1. Enforce single-instance lock
 *   2. Register dedalix:// protocol handler
 *   3. Create the main window and system tray
 *   4. Handle deep links from protocol invocations (macOS open-url, Windows second-instance)
 */

import {app, BrowserWindow, Menu, ipcMain, net, shell, desktopCapturer, screen, globalShortcut, clipboard, nativeImage} from 'electron';
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

// ─── IPC: Screenshot with overlay window (WeChat-style) ─────────────────
let overlayWindow: BrowserWindow | null = null;

// ─── 截图核心函数（可被 IPC 和全局快捷键调用）───────────────────
async function handleScreenshotStart(): Promise<{dataURL: string; width: number; height: number} | null> {
    // Prevent concurrent screenshots
    if (overlayWindow) {
        console.log('[screenshot] Already in progress');
        return null;
    }

    const mainWin = getMainWindow();

    try {
        // Step 1: Capture full screen using desktopCapturer (fast, direct from GPU)
        console.log('[screenshot] Step 1: Capturing screen...');
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

        if (sources.length === 0) {
            console.log('[screenshot] No screen sources found');
            return null;
        }

        const thumb = sources[0].thumbnail;
        const pngBuffer = thumb.toPNG();
        const dataURL = `data:image/png;base64,${pngBuffer.toString('base64')}`;
        const imgSize = thumb.getSize();
        console.log(`[screenshot] Captured: ${imgSize.width}x${imgSize.height}`);

        // Step 2: Create fullscreen overlay window (covers entire screen, no DPI issues)
        overlayWindow = new BrowserWindow({
            fullscreen: true,
            frame: false,
            transparent: false,
            alwaysOnTop: true,
            skipTaskbar: true,
            show: false,
            webPreferences: {
                preload: path.join(__dirname, 'overlay-preload.js'),
                contextIsolation: true,
                nodeIntegration: false,
                sandbox: false,
            },
        });

        // Step 3: Load the overlay HTML
        const htmlPath = path.join(__dirname, 'screenshot-overlay.html');
        await overlayWindow.loadFile(htmlPath);

        // Step 4: Show overlay on top of main window (no hide/show = no flicker)
        overlayWindow.show();
        overlayWindow.focus();
        overlayWindow.setAlwaysOnTop(true, 'screen-saver');

        // Step 5: Send screenshot data to overlay
        overlayWindow.webContents.send('screenshot-data', {
            dataURL,
            width: imgSize.width,
            height: imgSize.height,
        });

        // Step 6: Wait for user to confirm or cancel
        return await new Promise<any>((resolve) => {
            let resolved = false;

            const cleanup = () => {
                if (resolved) {
                    return;
                }
                resolved = true;
                if (overlayWindow && !overlayWindow.isDestroyed()) {
                    overlayWindow.destroy();
                }
                overlayWindow = null;
                ipcMain.removeAllListeners('screenshot-confirm');
                ipcMain.removeAllListeners('screenshot-cancel');
                // Main window was never hidden, just bring it to front
                if (mainWin && !mainWin.isDestroyed()) {
                    mainWin.focus();
                }
            };

            ipcMain.once('screenshot-confirm', (_e, result) => {
                console.log('[screenshot] Confirmed:', result ? `${result.width}x${result.height}` : 'null');
                // Copy image to clipboard (like WeChat) so user can Ctrl+V paste
                if (result && result.dataURL) {
                    try {
                        const base64 = result.dataURL.split(',')[1];
                        const img = nativeImage.createFromBuffer(Buffer.from(base64, 'base64'));
                        clipboard.writeImage(img);
                        console.log('[screenshot] Image copied to clipboard');
                    } catch (err) {
                        console.error('[screenshot] Failed to copy to clipboard:', err);
                    }
                }
                resolve(result);
                cleanup();
            });

            ipcMain.once('screenshot-cancel', () => {
                console.log('[screenshot] Cancelled');
                resolve(null);
                cleanup();
            });

            // Handle overlay window closed unexpectedly.
            // cleanup() calls destroy() which triggers 'closed' — only treat as unexpected
            // if we haven't already resolved (i.e., not from a confirm/cancel flow).
            overlayWindow!.on('closed', () => {
                if (resolved) {
                    return;
                }
                console.log('[screenshot] Overlay closed unexpectedly');
                cleanup();
                resolve(null);
            });

            // Safety timeout: auto-cancel after 60 seconds
            setTimeout(() => {
                if (!resolved) {
                    cleanup();
                    resolve(null);
                }
            }, 60000);
        });
    } catch (err) {
        // Cleanup on error
        if (overlayWindow && !overlayWindow.isDestroyed()) {
            overlayWindow.destroy();
        }
        overlayWindow = null;
        console.error('[screenshot] Failed:', err);
        return null;
    }
}

// ─── IPC handler: webapp 调用截图（点击按钮时）──────────────────
ipcMain.handle('screenshot-start', async () => {
    return handleScreenshotStart();
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

        // ─── Screenshot shortcut management ─────────────────────────────
        let currentShortcutAccelerator = 'CommandOrControl+Alt+A';

        // 将 webapp 格式的快捷键 (Ctrl+Alt+A) 转换为 Electron accelerator 格式
        function toElectronAccelerator(shortcut: string): string {
            return shortcut
                .replace(/\bCtrl\b/gi, 'CommandOrControl')
                .replace(/\bCmd\b/gi, 'CommandOrControl');
        }

        // 注册/更新全局截图快捷键
        function registerScreenshotShortcut(accelerator: string): boolean {
            // 先注销旧的快捷键
            if (currentShortcutAccelerator) {
                globalShortcut.unregister(currentShortcutAccelerator);
            }

            // 注册新的快捷键
            const success = globalShortcut.register(accelerator, async () => {
                console.log('[screenshot] Global shortcut triggered:', accelerator);
                try {
                    const result = await handleScreenshotStart();
                    if (result) {
                        console.log('[screenshot] Global shortcut: image copied to clipboard');
                        const win = getMainWindow();
                        if (win && !win.isDestroyed()) {
                            win.webContents.send('screenshot-completed', result);
                        }
                    }
                } catch (err) {
                    console.error('[screenshot] Global shortcut failed:', err);
                }
            });

            if (success) {
                currentShortcutAccelerator = accelerator;
                console.log('[screenshot] Registered shortcut:', accelerator);
            } else {
                console.error('[screenshot] Failed to register shortcut:', accelerator);
                // 回退到默认快捷键
                if (accelerator !== 'CommandOrControl+Alt+A') {
                    registerScreenshotShortcut('CommandOrControl+Alt+A');
                }
            }

            return success;
        }

        // 注册默认快捷键
        registerScreenshotShortcut(currentShortcutAccelerator);

        // IPC: webapp 通知更新快捷键
        ipcMain.handle('set-screenshot-shortcut', (_event, shortcut: string) => {
            const accelerator = toElectronAccelerator(shortcut);
            console.log('[screenshot] Updating shortcut:', shortcut, '→', accelerator);
            return registerScreenshotShortcut(accelerator);
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
