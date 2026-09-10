/**
 * Preload Script
 *
 * Runs in the renderer process with access to a limited set of
 * Node.js and Electron APIs. Exposes safe APIs to the webapp
 * via contextBridge.
 */

import {contextBridge} from 'electron';
import {version} from '../package.json';

// Expose platform info to the renderer so the webapp can detect the client
contextBridge.exposeInMainWorld('dedalix', {
    // Client version — matches package.json version
    version,

    // Platform identifier
    platform: process.platform,

    // Flag for the webapp to detect it's running inside the desktop client
    isDesktop: true,
});
