/**
 * ERP WebView Preload Script
 *
 * Exposes window.electronAPI for Frappe/ERPNext client scripts
 * that interact with hardware (electronic scale, label printer).
 * Compatible with optibot-erp-desktop's preload API.
 */

import {contextBridge, ipcRenderer} from 'electron';

// ─── Scale event callbacks ──────────────────────────────────────────
const weightCallbacks: Array<(data: any) => void> = [];
const scaleStatusCallbacks: Array<(data: any) => void> = [];
const scaleErrorCallbacks: Array<(msg: string) => void> = [];
const printerStatusCallbacks: Array<(data: any) => void> = [];
const printerErrorCallbacks: Array<(msg: string) => void> = [];
const menuActionCallbacks: Array<(action: string) => void> = [];

ipcRenderer.on('scale:weight', (_e, data) => weightCallbacks.forEach((cb) => cb(data)));
ipcRenderer.on('scale:status', (_e, data) => scaleStatusCallbacks.forEach((cb) => cb(data)));
ipcRenderer.on('scale:error', (_e, msg) => scaleErrorCallbacks.forEach((cb) => cb(msg)));
ipcRenderer.on('printer:status', (_e, data) => printerStatusCallbacks.forEach((cb) => cb(data)));
ipcRenderer.on('printer:error', (_e, msg) => printerErrorCallbacks.forEach((cb) => cb(msg)));
ipcRenderer.on('menu:action', (_e, action) => menuActionCallbacks.forEach((cb) => cb(action)));

contextBridge.exposeInMainWorld('electronAPI', {
    serial: {
        listPorts: () => ipcRenderer.invoke('serial:list-ports'),
    },
    scale: {
        listPorts: () => ipcRenderer.invoke('scale:list-ports'),
        connect: (port: string, options?: any) => ipcRenderer.invoke('scale:connect', port, options),
        disconnect: () => ipcRenderer.invoke('scale:disconnect'),
        onWeight: (callback: (data: any) => void) => {
            weightCallbacks.push(callback);
        },
        onStatus: (callback: (data: any) => void) => {
            scaleStatusCallbacks.push(callback);
        },
        onError: (callback: (msg: string) => void) => {
            scaleErrorCallbacks.push(callback);
        },
        getStatus: () => ipcRenderer.invoke('scale:get-status'),
        resetReading: () => ipcRenderer.invoke('scale:reset-reading'),
    },
    printer: {
        listPrinters: () => ipcRenderer.invoke('printer:list'),
        printLabelConfig: (printerId: string, labelConfig: any) =>
            ipcRenderer.invoke('printer:print-label', printerId, labelConfig),
        getStatus: () => ipcRenderer.invoke('printer:get-status'),
        onStatus: (callback: (data: any) => void) => {
            printerStatusCallbacks.push(callback);
        },
        onError: (callback: (msg: string) => void) => {
            printerErrorCallbacks.push(callback);
        },
    },
    device: {
        getInfo: () => ipcRenderer.invoke('device:get-info'),
    },
    app: {
        getVersion: () => ipcRenderer.invoke('app:get-version'),
        getConfig: () => ipcRenderer.invoke('app:get-config'),
        setConfig: (key: string, value: any) => ipcRenderer.invoke('app:set-config', key, value),
        onMenuAction: (callback: (action: string) => void) => {
            menuActionCallbacks.push(callback);
        },
        isDesktop: true,
    },
});
