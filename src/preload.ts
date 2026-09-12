/**
 * Preload Script
 *
 * Runs in the renderer process with access to a limited set of
 * Node.js and Electron APIs. Exposes safe APIs to the webapp
 * via contextBridge.
 */

import {contextBridge} from 'electron';
import {version} from '../package.json';

// ─── Inject 宋体 font into every frame (preload runs in iframes too) ───
(function injectFont() {
    const FONT_CSS = 'body, html, input, textarea, select, button, p, span, div, a, h1, h2, h3, h4, h5, h6, li, td, th, label, em, strong { font-family: "Microsoft YaHei", "PingFang SC", "Helvetica Neue", Arial, sans-serif !important; } [class^="icon-"], [class*="icon-"], [class^="fa-"], [class*=" fa-"] { font-family: "compass-icons" !important; } .fa, .fas, .far, .fab, .fal { font-family: "FontAwesome" !important; }';

    function apply() {
        if (!document.getElementById('dedalix-font-override')) {
            const style = document.createElement('style');
            style.id = 'dedalix-font-override';
            style.textContent = FONT_CSS;
            (document.head || document.documentElement).appendChild(style);
        }
    }

    // Inject as early as possible
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', apply);
    } else {
        apply();
    }

    // Re-inject when DOM changes (SPA navigation, dynamically added content)
    const observer = new MutationObserver(() => {
        if (!document.getElementById('dedalix-font-override')) {
            apply();
        }
    });
    observer.observe(document.documentElement || document, {childList: true, subtree: true});
})();

// Expose platform info to the renderer so the webapp can detect the client
contextBridge.exposeInMainWorld('dedalix', {
    // Client version — matches package.json version
    version,

    // Platform identifier
    platform: process.platform,

    // Flag for the webapp to detect it's running inside the desktop client
    isDesktop: true,
});
