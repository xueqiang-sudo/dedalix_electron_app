/**
 * Dedalix Desktop Client — Main Process Entry Point
 *
 * Bootstraps the Electron application:
 *   1. Enforce single-instance lock
 *   2. Register dedalix:// protocol handler
 *   3. Create the main window and system tray
 *   4. Handle deep links from protocol invocations (macOS open-url, Windows second-instance)
 */

import {app, BrowserWindow} from 'electron';

import {
    registerProtocol,
    getDeepLinkURL,
    handleDeepLink,
} from './protocol';
import {createMainWindow, showMainWindow, getMainWindow} from './window';
import {createTray, destroyTray} from './tray';

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
        // Check for a deep link from cold-start argv (Windows/Linux)
        const coldStartDeepLink =
            pendingDeepLink || getDeepLinkURL(process.argv.slice(1));

        createMainWindow(coldStartDeepLink);
        createTray();

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
    });
}
