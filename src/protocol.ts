/**
 * dedalix:// Protocol Handler
 *
 * Registers the dedalix:// custom protocol at the OS level and provides
 * utilities for parsing deep-link URLs and navigating the main window.
 *
 * Protocol URL format:
 *   dedalix://<host>:<port>/<path>?<query>
 *
 * The handler converts dedalix:// → https:// and navigates the main window.
 */

import {app, shell} from 'electron';
import * as path from 'path';

import {getMainWindow, showMainWindow} from './window';

export const PROTOCOL = 'dedalix';

/**
 * Register this app as the default handler for the dedalix:// protocol.
 * Must be called BEFORE app.whenReady().
 */
export function registerProtocol(): void {
    const isDev = !app.isPackaged;

    if (isDev) {
        // In development, use a separate protocol to avoid conflicts
        app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [
            path.resolve(process.argv[1] || ''),
        ]);
    } else {
        app.setAsDefaultProtocolClient(PROTOCOL);
    }
}

/**
 * Extract a deep-link URL from command-line arguments.
 * Returns the URL string if found, or undefined.
 *
 * On Windows/Linux, the OS passes the protocol URL as the last argument:
 *   Dedalix.exe dedalix://host/path?query
 */
export function getDeepLinkURL(args: string[]): string | undefined {
    if (!Array.isArray(args) || args.length === 0) {
        return undefined;
    }

    // Find the first argument that starts with dedalix:
    const deepLinkArg = args.find((arg) =>
        arg.toLowerCase().startsWith(`${PROTOCOL}:`),
    );

    if (!deepLinkArg) {
        return undefined;
    }

    // Basic URI validation
    try {
        new URL(deepLinkArg);
        return deepLinkArg;
    } catch {
        // Not a valid URL — ignore
        return undefined;
    }
}

/**
 * Convert a dedalix:// URL to an https:// URL.
 *
 * Example:
 *   dedalix://ai.optibot.cn:8065/invite?id=abc
 *   → https://ai.optibot.cn:8065/invite?id=abc
 */
export function protocolToHTTPS(protocolUrl: string): string {
    return protocolUrl.replace(new RegExp(`^${PROTOCOL}://`, 'i'), 'https://');
}

/**
 * Handle an incoming deep-link URL.
 *
 * Flow:
 *   1. Parse and validate the URL
 *   2. Convert dedalix:// → https://
 *   3. Show and focus the main window
 *   4. Navigate the webContents to the target URL
 */
export function handleDeepLink(url: string): void {
    console.log(`[protocol] Deep link received: ${url}`);

    const httpsUrl = protocolToHTTPS(url);
    console.log(`[protocol] Converted to: ${httpsUrl}`);

    let parsedUrl: URL;
    try {
        parsedUrl = new URL(httpsUrl);
    } catch {
        console.error(`[protocol] Invalid URL: ${httpsUrl}`);
        return;
    }

    const win = getMainWindow();
    if (!win) {
        console.error('[protocol] No main window available');
        return;
    }

    // Show and focus the window
    showMainWindow();

    // Navigate to the deep-link URL
    win.webContents.loadURL(httpsUrl).catch((err) => {
        console.error(`[protocol] Failed to navigate to ${httpsUrl}:`, err);
    });
}

/**
 * Handle external protocol links clicked inside the webview.
 * If a link inside the app points to dedalix://, intercept it
 * and handle it internally instead of letting the OS open it.
 */
export function handleWillNavigate(
    event: Electron.Event,
    url: string,
): void {
    if (url.toLowerCase().startsWith(`${PROTOCOL}:`)) {
        event.preventDefault();
        handleDeepLink(url);
    }
}

/**
 * Handle new-window requests.
 * - dedalix:// URLs → handle internally
 * - External http(s) URLs → open in system browser
 * - Internal http(s) URLs → allow (open in new Electron window)
 */
export function handleWindowOpen(
    details: Electron.HandlerDetails,
): {action: 'deny'} | {action: 'allow'} {
    if (details.url.toLowerCase().startsWith(`${PROTOCOL}:`)) {
        handleDeepLink(details.url);
        return {action: 'deny'};
    }

    // Open external links in the system browser
    if (
        details.url.startsWith('http://') ||
        details.url.startsWith('https://')
    ) {
        const appUrl = getAppURL();
        try {
            const targetHost = new URL(details.url).host;
            const appHost = new URL(appUrl).host;
            if (targetHost !== appHost) {
                shell.openExternal(details.url);
                return {action: 'deny'};
            }
        } catch {
            // Invalid URL — deny
            return {action: 'deny'};
        }
    }

    // Internal URL — allow the new window
    return {action: 'allow'};
}

/** The app's server URL. */
export const APP_URL = 'https://ai.optibot.cn:8066';

/**
 * Get the app's base URL.
 */
export function getAppURL(): string {
    return APP_URL;
}
