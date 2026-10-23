/**
 * Window Manager
 *
 * Manages the main BrowserWindow: creation, state persistence,
 * User-Agent injection, and deep-link interception.
 */

import {app, BrowserWindow, dialog, screen} from 'electron';
import * as path from 'path';
import * as fs from 'fs';

import {version as appVersion} from '../package.json';
import {getAppURL, handleWillNavigate, handleWindowOpen} from './protocol';

/**
 * Get the window state persistence file path.
 * Uses Electron's userData path (available after app ready).
 */
function getStateFilePath(): string {
    return path.join(app.getPath('userData'), 'window-state.json');
}

interface WindowState {
    x?: number;
    y?: number;
    width: number;
    height: number;
    isMaximized: boolean;
}

const DEFAULT_WIDTH = 900;
const DEFAULT_HEIGHT = 650;
const MIN_WIDTH = 600;
const MIN_HEIGHT = 450;

let mainWindow: BrowserWindow | null = null;
let windowState: WindowState;
let isQuitting = false;

/**
 * Load persisted window state from disk.
 */
function loadWindowState(): WindowState {
    try {
        const stateFile = getStateFilePath();
        if (fs.existsSync(stateFile)) {
            const data = fs.readFileSync(stateFile, 'utf-8');
            const parsed = JSON.parse(data) as Partial<WindowState>;
            const w = parsed.width || DEFAULT_WIDTH;
            const h = parsed.height || DEFAULT_HEIGHT;
            // One-time migration: reset old default size (1280×800) to new compact size
            if (w === 1280 && h === 800) {
                return {
                    width: DEFAULT_WIDTH,
                    height: DEFAULT_HEIGHT,
                    isMaximized: parsed.isMaximized || false,
                };
            }
            return {
                x: parsed.x,
                y: parsed.y,
                width: w,
                height: h,
                isMaximized: parsed.isMaximized || false,
            };
        }
    } catch {
        // Corrupted or missing — use defaults
    }
    return {
        width: DEFAULT_WIDTH,
        height: DEFAULT_HEIGHT,
        isMaximized: false,
    };
}

/**
 * Save current window state to disk.
 */
function saveWindowState(win: BrowserWindow): void {
    const bounds = win.getBounds();
    const state: WindowState = {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        isMaximized: win.isMaximized(),
    };

    try {
        const stateFile = getStateFilePath();
        const dir = path.dirname(stateFile);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, {recursive: true});
        }
        fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
    } catch {
        // Ignore write errors
    }
}

/**
 * Validate that the saved window position is still visible on a connected display.
 */
function isVisibleOnScreen(state: WindowState): boolean {
    if (state.x === undefined || state.y === undefined) {
        return false;
    }

    const displays = screen.getAllDisplays();
    return displays.some((display) => {
        const {x, y, width, height} = display.bounds;
        return (
            state.x! >= x - 100 &&
            state.x! < x + width &&
            state.y! >= y - 100 &&
            state.y! < y + height
        );
    });
}


/**
 * Create the main application window.
 */
export function createMainWindow(deepLinkUrl?: string): BrowserWindow {
    windowState = loadWindowState();

    // Ensure window position is on a visible display
    const positionOnScreen = isVisibleOnScreen(windowState);
    const windowOptions: Electron.BrowserWindowConstructorOptions = {
        width: windowState.width,
        height: windowState.height,
        minWidth: MIN_WIDTH,
        minHeight: MIN_HEIGHT,
        title: 'Dedalix',
        show: false, // Show after ready-to-show
        autoHideMenuBar: true, // Force hide menu bar
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
            webSecurity: true,
            webviewTag: true,
        },
    };

    if (positionOnScreen) {
        windowOptions.x = windowState.x;
        windowOptions.y = windowState.y;
    }

    mainWindow = new BrowserWindow(windowOptions);

    // Fix window title — prevent Mattermost document.title changes from updating it
    mainWindow.webContents.on('page-title-updated', (event) => {
        event.preventDefault();
    });

    // Force hide menu bar (multiple methods for reliability, matching optibot-erp-desktop)
    mainWindow.setMenuBarVisibility(false);
    mainWindow.removeMenu();

    // Append Dedalix/{version} to the real Electron User-Agent
    mainWindow.webContents.userAgent += ` Dedalix/${appVersion}`;

    // Restore maximized state
    if (windowState.isMaximized) {
        mainWindow.maximize();
    }

    // Show window when content is ready
    mainWindow.once('ready-to-show', () => {
        mainWindow?.show();
    });

    // Persist window state on move/resize/close
    const saveState = () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            saveWindowState(mainWindow);
        }
    };
    mainWindow.on('resize', saveState);
    mainWindow.on('move', saveState);
    mainWindow.on('close', saveState);

    // Intercept navigation events for dedalix:// protocol
    mainWindow.webContents.on('will-navigate', handleWillNavigate);

    // Handle new-window requests (target="_blank" links)
    mainWindow.webContents.setWindowOpenHandler(handleWindowOpen);

    // Inject 宋体 (SimSun) font — main frame via insertCSS, iframes via preload
    const FONT_CSS = 'body, html, input, textarea, select, button, p, span, div, a, h1, h2, h3, h4, h5, h6, li, td, th, label, em, strong { font-family: "Microsoft YaHei", "PingFang SC", "Helvetica Neue", Arial, sans-serif !important; } [class^="icon-"], [class*="icon-"], [class^="fa-"], [class*=" fa-"] { font-family: "compass-icons" !important; } .fa, .fas, .far, .fab, .fal { font-family: "FontAwesome" !important; }';

    const injectFont = () => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        mainWindow.webContents.insertCSS(FONT_CSS);
        // Also inject into iframes via executeJavaScript
        mainWindow.webContents.executeJavaScript(`
            (function() {
                const css = '${FONT_CSS}';
                document.querySelectorAll('iframe').forEach(function(iframe) {
                    try {
                        var doc = iframe.contentDocument;
                        if (doc && doc.head) {
                            var style = doc.createElement('style');
                            style.textContent = css;
                            doc.head.appendChild(style);
                        }
                    } catch(e) {}
                });
            })();
        `).catch(() => {});
    };

    mainWindow.webContents.on('did-finish-load', injectFont);
    mainWindow.webContents.on('did-navigate', injectFont);
    mainWindow.webContents.on('did-navigate-in-page', injectFont);
    mainWindow.webContents.on('did-frame-finish-load', injectFont);

    // Navigate to the deep-linkURL or the default app URL
    const targetUrl = deepLinkUrl
        ? deepLinkUrl.replace(/^dedalix:/i, 'https:')
        : getAppURL();

    // ─── Load error handling ──────────────────────────────────────────────
    // Show error page with retry button when the main page fails to load
    let retryTimer: NodeJS.Timeout | null = null;
    let retryCount = 0;
    const MAX_AUTO_RETRY = 5;
    const RETRY_INTERVAL = 5000; // 5 seconds

    function showErrorPage(errorDesc: string) {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        const retryUrl = encodeURIComponent(targetUrl);
        const errorHtml = `
            <!DOCTYPE html>
            <html>
            <head><meta charset="utf-8"><title>Dedalix</title></head>
            <body style="margin:0; display:flex; align-items:center; justify-content:center; height:100vh; background:#f5f5f5; font-family:'Microsoft YaHei','PingFang SC',sans-serif;">
                <div style="text-align:center; color:#333;">
                    <div style="font-size:64px; margin-bottom:20px;">⚠️</div>
                    <h2 style="margin:0 0 12px 0; font-size:20px; font-weight:500;">无法连接到服务器</h2>
                    <p style="color:#666; font-size:14px; margin:0 0 8px 0;">${errorDesc}</p>
                    <p style="color:#999; font-size:12px; margin:0 0 24px 0;">${RETRY_INTERVAL / 1000} 秒后自动重试（第 ${retryCount}/${MAX_AUTO_RETRY} 次）</p>
                    <button onclick="location.href=decodeURIComponent('${retryUrl}')" style="padding:10px 32px; font-size:14px; color:#fff; background:#166de0; border:none; border-radius:4px; cursor:pointer;">
                        立即重试
                    </button>
                </div>
            </body>
            </html>
        `;
        mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(errorHtml)}`).catch(() => {});
    }

    function scheduleRetry() {
        if (retryTimer) clearInterval(retryTimer);
        retryCount++;
        if (retryCount > MAX_AUTO_RETRY) {
            console.log(`[window] Max auto-retry (${MAX_AUTO_RETRY}) reached, stopping.`);
            return;
        }
        console.log(`[window] Auto-retry #${retryCount} in ${RETRY_INTERVAL / 1000}s...`);
        retryTimer = setTimeout(() => {
            if (!mainWindow || mainWindow.isDestroyed()) return;
            console.log(`[window] Auto-retry #${retryCount}: loading ${targetUrl}`);
            mainWindow.loadURL(targetUrl).catch((err) => {
                console.error(`[window] Auto-retry failed:`, err);
                showErrorPage(`连接失败 (${err.message})，${RETRY_INTERVAL / 1000} 秒后自动重试`);
                scheduleRetry();
            });
        }, RETRY_INTERVAL);
    }

    // Handle main frame load failures (network errors, DNS failures, etc.)
    mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, _validatedURL, isMainFrame) => {
        if (!isMainFrame) return; // Only handle main frame failures
        if (errorCode === -3) return; // ERR_ABORTED (intentional cancellation)
        console.error(`[window] Load failed: ${errorCode} ${errorDescription}`);
        showErrorPage(`${errorDescription} (${errorCode})`);
        scheduleRetry();
    });

    // Reset retry count on successful load
    mainWindow.webContents.on('did-finish-load', () => {
        retryCount = 0;
        if (retryTimer) {
            clearTimeout(retryTimer);
            retryTimer = null;
        }
    });

    mainWindow.loadURL(targetUrl).catch((err) => {
        console.error(`[window] Failed to load ${targetUrl}:`, err);
        showErrorPage(`连接失败 (${err.message})，${RETRY_INTERVAL / 1000} 秒后自动重试`);
        scheduleRetry();
    });

    // ─── Close confirmation dialog ──────────────────────────────────
    mainWindow.on('close', (event) => {
        if (!isQuitting) {
            event.preventDefault();
            saveState();
            const choice = dialog.showMessageBoxSync(mainWindow!, {
                type: 'question',
                buttons: ['确定', '取消'],
                defaultId: 0,
                cancelId: 1,
                title: '退出确认',
                message: '确定要退出 Dedalix 吗？',
            });
            if (choice === 0) {
                isQuitting = true;
                mainWindow?.destroy();
            }
        }
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
    });

    // ─── Dev & debug shortcuts ──────────────────────────────────────────
    mainWindow.webContents.on('before-input-event', (event, input) => {
        // Ctrl+Shift+R: force reload
        if (input.control && input.shift && input.key.toLowerCase() === 'r') {
            event.preventDefault();
            mainWindow?.webContents.reloadIgnoringCache();
        }
        // F12 or Ctrl+Shift+I: toggle DevTools
        if (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i')) {
            event.preventDefault();
            mainWindow?.webContents.toggleDevTools();
        }
    });


    // When app.quit() is called (from tray or system), skip confirmation
    app.on('before-quit', () => {
        isQuitting = true;
    });

    return mainWindow;
}

/**
 * Get the current main window instance.
 */
export function getMainWindow(): BrowserWindow | null {
    return mainWindow;
}

/**
 * Show and focus the main window.
 * Unminimizes if minimized.
 */
export function showMainWindow(): void {
    if (!mainWindow || mainWindow.isDestroyed()) {
        return;
    }

    if (mainWindow.isMinimized()) {
        mainWindow.restore();
    }

    mainWindow.show();
    mainWindow.focus();
}

/**
 * Toggle window visibility (for tray click).
 */
export function toggleMainWindow(): void {
    if (!mainWindow || mainWindow.isDestroyed()) {
        return;
    }

    if (mainWindow.isVisible()) {
        mainWindow.hide();
    } else {
        showMainWindow();
    }
}
