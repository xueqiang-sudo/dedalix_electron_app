/**
 * Dedalix Desktop Client — Main Process Entry Point
 *
 * Bootstraps the Electron application:
 *   1. Enforce single-instance lock
 *   2. Register dedalix:// protocol handler
 *   3. Create the main window and system tray
 *   4. Handle deep links from protocol invocations (macOS open-url, Windows second-instance)
 */

import {app, BrowserWindow, Menu, ipcMain, net, shell, globalShortcut} from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import {execFile} from 'child_process';

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

// ─── Native screenshot capture (reads directly from frame buffer, no flicker) ──
function captureNativeScreenshot(): Promise<{buffer: Buffer; width: number; height: number} | null> {
    return new Promise((resolve) => {
        const tmpFile = path.join(app.getPath('temp'), `dedalix_ss_${Date.now()}.png`);

        // Try screenshot tools in order of preference (Linux)
        // scrot: fastest, reads directly from X frame buffer
        // gnome-screenshot: GNOME/Wayland compatible
        // maim: modern alternative to scrot
        const tryTools = [
            {cmd: 'scrot', args: [tmpFile]},
            {cmd: 'gnome-screenshot', args: ['-f', tmpFile]},
            {cmd: 'maim', args: [tmpFile]},
        ];

        // Detect platform and adjust
        if (process.platform === 'darwin') {
            tryTools.length = 0;
            tryTools.push({cmd: 'screencapture', args: ['-x', tmpFile]}); // -x = no sound
        } else if (process.platform === 'win32') {
            // Windows: use PowerShell to capture via .NET
            tryTools.length = 0;
            const psScript = `
                Add-Type -AssemblyName System.Windows.Forms;
                [System.Windows.Forms.Screen]::PrimaryScreen | ForEach-Object {
                    $bitmap = New-Object System.Drawing.Bitmap($_.Bounds.Width, $_.Bounds.Height);
                    $graphics = [System.Drawing.Graphics]::FromImage($bitmap);
                    $graphics.CopyFromScreen($_.Bounds.Location, [System.Drawing.Point]::Empty, $_.Bounds.Size);
                    $bitmap.Save('${tmpFile.replace(/\\/g, '\\\\')}');
                }
            `;
            tryTools.push({cmd: 'powershell', args: ['-command', psScript]});
        }

        let toolIndex = 0;

        function tryNext() {
            if (toolIndex >= tryTools.length) {
                console.error('[screenshot] All screenshot tools failed');
                resolve(null);
                return;
            }

            const tool = tryTools[toolIndex++];
            console.log(`[screenshot] Trying: ${tool.cmd} ${tool.args.join(' ')}`);

            execFile(tool.cmd, tool.args, {timeout: 5000}, (error) => {
                if (error) {
                    console.log(`[screenshot] ${tool.cmd} failed:`, error.message);
                    tryNext();
                    return;
                }

                // Read the captured file
                try {
                    const buffer = fs.readFileSync(tmpFile);
                    fs.unlinkSync(tmpFile); // Clean up temp file

                    // Get image dimensions from PNG header
                    // PNG IHDR chunk starts at byte 16, width at 16-19, height at 20-23
                    const width = buffer.readUInt32BE(16);
                    const height = buffer.readUInt32BE(20);

                    console.log(`[screenshot] Native capture: ${width}x${height}, ${buffer.length} bytes`);
                    resolve({buffer, width, height});
                } catch (readErr) {
                    console.error(`[screenshot] Failed to read ${tool.cmd} output:`, readErr);
                    tryNext();
                }
            });
        }

        tryNext();
    });
}

// ─── IPC: Screenshot with overlay window (WeChat-style) ─────────────────
let overlayWindow: BrowserWindow | null = null;

ipcMain.handle('screenshot-start', async () => {
    // Prevent concurrent screenshots
    if (overlayWindow) {
        console.log('[screenshot] Already in progress');
        return null;
    }

    const mainWin = getMainWindow();

    try {
        // Step 1: Native screenshot capture (reads frame buffer directly, no flicker)
        console.log('[screenshot] Step 1: Native capture from frame buffer...');
        const capture = await captureNativeScreenshot();

        if (!capture) {
            console.log('[screenshot] Native capture failed');
            return null;
        }

        const {buffer: pngBuffer, width: imgWidth, height: imgHeight} = capture;
        const dataURL = `data:image/png;base64,${pngBuffer.toString('base64')}`;
        console.log(`[screenshot] Captured: ${imgWidth}x${imgHeight}`);

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
            width: imgWidth,
            height: imgHeight,
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
