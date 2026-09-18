/**
 * Screenshot Overlay Window — Preload Script
 *
 * Exposes a minimal IPC API for the screenshot overlay HTML page
 * to communicate with the Electron main process.
 */

import {contextBridge, ipcRenderer} from 'electron';

contextBridge.exposeInMainWorld('overlayAPI', {
    /** Receive the full-screen screenshot data from main process */
    onScreenshotData: (cb: (data: {dataURL: string; width: number; height: number}) => void) => {
        ipcRenderer.on('screenshot-data', (_e, data) => cb(data));
    },

    /** Send the cropped + annotated selection back to main process */
    confirm: (dataURL: string, width: number, height: number) => {
        ipcRenderer.send('screenshot-confirm', {dataURL, width, height});
    },

    /** Cancel the screenshot */
    cancel: () => {
        ipcRenderer.send('screenshot-cancel');
    },
});
