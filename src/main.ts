/**
 * Dedalix Desktop Client — Main Process Entry Point
 *
 * Bootstraps the Electron application:
 *   1. Enforce single-instance lock
 *   2. Register dedalix:// protocol handler
 *   3. Create the main window and system tray
 *   4. Handle deep links from protocol invocations (macOS open-url, Windows second-instance)
 */

import {app, BrowserWindow, Menu, ipcMain, net, shell, desktopCapturer, screen, globalShortcut, clipboard, nativeImage, dialog, session} from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import Store from 'electron-store';
import {pathToFileURL} from 'url';

// Hardware services (ported from optibot-erp-desktop)
// These are CommonJS modules, use require()
const ScaleService = require('./services/scale-service');
const PrinterService = require('./services/printer-service');

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

// ─── IPC: Download file with "Save As" dialog ──────────────────────────
ipcMain.handle('download-save-as', async (event, url: string, filename: string) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const {canceled, filePath} = await dialog.showSaveDialog(win!, {
        defaultPath: filename,
    });
    if (canceled || !filePath) {
        return null; // User cancelled
    }
    const resp = await net.fetch(url);
    if (!resp.ok) {
        throw new Error(`Download failed: ${resp.status} ${resp.statusText}`);
    }
    const buffer = Buffer.from(await resp.arrayBuffer());
    fs.writeFileSync(filePath, buffer);
    return filePath;
});

// ─── ERP Hardware Services ──────────────────────────────────────────────
const erpStore = new Store({
    defaults: {
        lastScalePort: '',
        lastScaleOptions: {},
        lastPrinterId: '',
        autoConnectScale: false,
        scaleAverageWindow: 5,
    },
});

let scaleService: any = null;
let printerService: any = null;

function initERPServices() {
    const mainWin = getMainWindow();
    if (!mainWin) return;

    // Initialize scale service
    scaleService = new ScaleService({
        emptyThreshold: 0.01,
    });

    scaleService.on('weight', (weight: any) => {
        const win = getMainWindow();
        if (win && !win.isDestroyed()) {
            win.webContents.send('scale:weight', weight);
        }
    });
    scaleService.on('status', (status: any) => {
        const win = getMainWindow();
        if (win && !win.isDestroyed()) {
            win.webContents.send('scale:status', status);
        }
    });
    scaleService.on('error', (error: Error) => {
        const win = getMainWindow();
        if (win && !win.isDestroyed()) {
            win.webContents.send('scale:error', error.message);
        }
    });

    // Initialize printer service
    printerService = new PrinterService();
    printerService.on('status', (status: any) => {
        const win = getMainWindow();
        if (win && !win.isDestroyed()) {
            win.webContents.send('printer:status', status);
        }
    });
    printerService.on('error', (error: Error) => {
        const win = getMainWindow();
        if (win && !win.isDestroyed()) {
            win.webContents.send('printer:error', error.message);
        }
    });
}

// ─── IPC: ERP Hardware (Scale) ──────────────────────────────────────────
ipcMain.handle('scale:list-ports', async () => {
    if (!scaleService) return [];
    try {
        return await scaleService.listPorts();
    } catch {
        return [];
    }
});

ipcMain.handle('scale:connect', async (_event, portPath: string, options: any) => {
    if (!scaleService) throw new Error('Scale service not initialized');
    // If already connected to the same port, return success without reconnecting
    if (scaleService.connected && scaleService.portPath === portPath) {
        return {success: true, alreadyConnected: true};
    }
    // If connected to a different port, disconnect first
    if (scaleService.connected) {
        await scaleService.disconnect();
    }
    await scaleService.connect(portPath, options || {});
    erpStore.set('lastScalePort', portPath);
    erpStore.set('lastScaleOptions', options || {});
    erpStore.set('autoConnectScale', true);
    return {success: true};
});

ipcMain.handle('scale:disconnect', async () => {
    if (!scaleService) return {success: true};
    await scaleService.disconnect();
    erpStore.set('autoConnectScale', false);
    return {success: true};
});

ipcMain.handle('scale:get-status', () => {
    if (!scaleService) return {connected: false, port: null};
    return scaleService.getStatus();
});

ipcMain.handle('scale:reset-reading', () => {
    if (scaleService) scaleService.resetReading();
    return {success: true};
});

// ─── IPC: Serial ports ──────────────────────────────────────────────────
ipcMain.handle('serial:list-ports', async () => {
    if (!scaleService) return [];
    try {
        return await scaleService.listPorts();
    } catch {
        return [];
    }
});

// ─── IPC: ERP Hardware (Printer) ────────────────────────────────────────
ipcMain.handle('printer:list', async () => {
    if (!printerService) return [];
    try {
        return await printerService.listPrinters();
    } catch {
        return [];
    }
});

ipcMain.handle('printer:print-label', async (_event, printerId: string, labelConfig: any) => {
    if (!printerService) throw new Error('Printer service not initialized');
    erpStore.set('lastPrinterId', printerId);
    return await printerService.printLabel(printerId, labelConfig);
});

ipcMain.handle('printer:get-status', () => {
    if (!printerService) return {connected: false, printers: []};
    return printerService.getStatus();
});

// ─── IPC: Device info ───────────────────────────────────────────────────
ipcMain.handle('device:get-info', () => {
    return {
        scale: scaleService ? scaleService.getStatus() : {connected: false, port: null},
        printer: printerService ? printerService.getStatus() : {connected: false, printers: []},
    };
});

// ─── IPC: App config ────────────────────────────────────────────────────
ipcMain.handle('app:get-version', () => app.getVersion());
ipcMain.handle('app:get-config', () => ({
    lastScalePort: erpStore.get('lastScalePort'),
    lastScaleOptions: erpStore.get('lastScaleOptions'),
    lastPrinterId: erpStore.get('lastPrinterId'),
    autoConnectScale: erpStore.get('autoConnectScale'),
}));
ipcMain.handle('app:set-config', (_event, key: string, value: any) => {
    erpStore.set(key, value);
    return {success: true};
});

// ─── IPC: ERP WebView management ────────────────────────────────────────
let erpCredentials: {api_key: string; api_secret: string; erp_url: string} | null = null;

ipcMain.handle('erp-set-credentials', (_event, creds: {api_key: string; api_secret: string; erp_url: string}) => {
    erpCredentials = creds;

    // Set up webRequest hook for the ERP session
    const erpSession = session.fromPartition('persist:erp');
    const erpURL = 'https://erp.optibot.cn:8443';
    const urlPattern = erpURL.replace(/\/$/, '') + '/*';

    erpSession.webRequest.onBeforeSendHeaders(
        {urls: [urlPattern]},
        (details, callback) => {
            const headers = {...details.requestHeaders};
            if (erpCredentials) {
                headers['Authorization'] = `token ${erpCredentials.api_key}:${erpCredentials.api_secret}`;
            }
            // Force Host header for nginx virtual host compatibility
            try {
                const url = new URL(erpURL);
                headers['Host'] = url.host;
            } catch {
                // ignore
            }
            // Replace User-Agent to hide Electron identity
            if (headers['User-Agent']) {
                headers['User-Agent'] = headers['User-Agent'].replace(/Electron\/[\d.]+/, 'Chrome/120.0.0.0');
            }
            callback({requestHeaders: headers});
        },
    );

    console.log('[erp] Credentials set, webRequest hook configured for', erpURL);
    return {success: true};
});

// Return the preload path for ERP webview
ipcMain.handle('erp-get-preload-path', () => {
    return pathToFileURL(path.join(__dirname, 'erp-preload.js')).href;
});

// Return the erp-bridge.js content for injection into webview
let _erpBridgeCode: string | null = null;
ipcMain.handle('erp-get-bridge-code', () => {
    if (!_erpBridgeCode) {
        const bridgePath = path.join(__dirname, 'renderer', 'erp-bridge.js');
        try {
            _erpBridgeCode = fs.readFileSync(bridgePath, 'utf-8');
        } catch (err) {
            console.error('[erp] Failed to read bridge code:', err);
            return '';
        }
    }
    return _erpBridgeCode;
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

        // Initialize ERP hardware services
        initERPServices();

        // Auto-connect scale if configured
        if (erpStore.get('autoConnectScale') && scaleService) {
            const lastPort = erpStore.get('lastScalePort') as string;
            const lastOpts = erpStore.get('lastScaleOptions') as any;
            if (lastPort) {
                setTimeout(async () => {
                    try {
                        await scaleService.connect(lastPort, lastOpts || {});
                        console.log('[erp] Auto-connected scale on', lastPort);
                    } catch (err) {
                        console.warn('[erp] Auto-connect scale failed:', err);
                    }
                }, 3000);
            }
        }

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
