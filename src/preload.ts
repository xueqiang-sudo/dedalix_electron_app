/**
 * Preload Script
 *
 * Runs in the renderer process with access to a limited set of
 * Node.js and Electron APIs. Exposes safe APIs to the webapp
 * via contextBridge.
 */

import {contextBridge, ipcRenderer} from 'electron';
import {version} from '../package.json';

// ─── Inject Dedalix branding overlay (top-left corner) ───────────────
(function injectBranding() {
    function apply() {
        if (document.getElementById('dedalix-brand-overlay')) return;
        // Only inject into the top frame
        if (window !== window.top) return;

        const overlay = document.createElement('div');
        overlay.id = 'dedalix-brand-overlay';
        overlay.innerHTML = `
            <style>
                #dedalix-brand-overlay {
                    position: fixed;
                    top: 0;
                    left: 0;
                    z-index: 2147483647;
                    display: flex;
                    align-items: center;
                    user-select: none;
                    -webkit-app-region: no-drag;
                }
                #dedalix-brand-btn {
                    padding: 6px 16px;
                    font-size: 16px;
                    font-weight: 700;
                    color: #fff;
                    background: transparent;
                    border: none;
                    cursor: pointer;
                    font-family: "Microsoft YaHei", "PingFang SC", Arial, sans-serif;
                    letter-spacing: 1px;
                    outline: none;
                }
                #dedalix-brand-btn:hover {
                    background: rgba(255,255,255,0.1);
                    border-radius: 4px;
                }
                #dedalix-brand-dropdown {
                    display: none;
                    position: absolute;
                    top: 100%;
                    left: 0;
                    background: #fff;
                    border: 1px solid #e0e0e0;
                    border-radius: 6px;
                    box-shadow: 0 4px 16px rgba(0,0,0,0.15);
                    min-width: 140px;
                    padding: 4px 0;
                    z-index: 2147483647;
                }
                #dedalix-brand-dropdown.open {
                    display: block;
                }
                .dedalix-menu-item {
                    padding: 8px 20px;
                    font-size: 14px;
                    color: #333;
                    cursor: pointer;
                    font-family: "Microsoft YaHei", "PingFang SC", Arial, sans-serif;
                    white-space: nowrap;
                    display: block;
                    border: none;
                    background: none;
                    width: 100%;
                    text-align: left;
                }
                .dedalix-menu-item:hover {
                    background: #f0f0f0;
                }
            </style>
            <button id="dedalix-brand-btn">Dedalix ▾</button>
            <div id="dedalix-brand-dropdown">
                <button class="dedalix-menu-item" id="dedalix-refresh-btn">🔄 刷新</button>
            </div>
        `;
        document.body.appendChild(overlay);

        const btn = document.getElementById('dedalix-brand-btn')!;
        const dropdown = document.getElementById('dedalix-brand-dropdown')!;
        const refreshBtn = document.getElementById('dedalix-refresh-btn')!;

        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            dropdown.classList.toggle('open');
        });

        document.addEventListener('click', () => {
            dropdown.classList.remove('open');
        });

        refreshBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            dropdown.classList.remove('open');
            ipcRenderer.send('dedalix:force-reload');
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', apply);
    } else {
        apply();
    }

    // Re-inject on SPA navigation
    const observer = new MutationObserver(() => {
        if (!document.getElementById('dedalix-brand-overlay')) {
            apply();
        }
    });
    observer.observe(document.documentElement || document, {childList: true, subtree: true});
})();

// ─── Inject 宋体 font into every frame (preload runs in iframes too) ───
(function injectFont() {
    const FONT_CSS = '*, *::before, *::after, body, html, input, textarea, select, button, p, span, div, a, h1, h2, h3, h4, h5, h6, li, td, th, label, em, strong { font-family: "Microsoft YaHei", "PingFang SC", "Helvetica Neue", Arial, sans-serif !important; }';

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
