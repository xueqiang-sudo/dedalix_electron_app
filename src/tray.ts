/**
 * System Tray
 *
 * Creates a system tray icon with a context menu for quick access
 * to show/hide the window and quit the application.
 */

import {app, Tray, Menu, nativeImage} from 'electron';
import * as path from 'path';

import {showMainWindow, getMainWindow} from './window';

let tray: Tray | null = null;

/**
 * Get the tray icon path based on the current platform.
 */
function getTrayIconPath(): string {
    const resourcesDir = path.join(__dirname, '..', 'resources');

    if (process.platform === 'darwin') {
        // macOS: use a Template image for automatic dark/light mode
        return path.join(resourcesDir, 'tray-icon-Template.png');
    }

    if (process.platform === 'win32') {
        return path.join(resourcesDir, 'tray-icon.ico');
    }

    // Linux
    return path.join(resourcesDir, 'tray-icon.png');
}

/**
 * Create the system tray icon and context menu.
 */
export function createTray(): void {
    const iconPath = getTrayIconPath();

    try {
        // Create a small tray icon
        let icon: Electron.NativeImage;
        try {
            icon = nativeImage.createFromPath(iconPath);
        } catch {
            // Fallback: create a simple empty icon
            icon = nativeImage.createEmpty();
        }

        tray = new Tray(icon);
        tray.setToolTip('Dedalix');

        updateTrayMenu();

        // Double-click tray icon to show window (Windows/Linux)
        if (process.platform !== 'darwin') {
            tray.on('double-click', () => {
                showMainWindow();
            });
        }
    } catch (err) {
        console.error('[tray] Failed to create tray:', err);
    }
}

/**
 * Update the tray context menu.
 */
function updateTrayMenu(): void {
    if (!tray) {
        return;
    }

    const contextMenu = Menu.buildFromTemplate([
        {
            label: '打开 Dedalix',
            click: () => {
                showMainWindow();
            },
        },
        {type: 'separator'},
        {
            label: '刷新',
            click: () => {
                const win = getMainWindow();
                if (win) {
                    win.webContents.reload();
                }
            },
        },
        {type: 'separator'},
        {
            label: '退出',
            click: () => {
                app.quit();
            },
        },
    ]);

    tray.setContextMenu(contextMenu);
}

/**
 * Destroy the tray icon (cleanup).
 */
export function destroyTray(): void {
    if (tray) {
        tray.destroy();
        tray = null;
    }
}
