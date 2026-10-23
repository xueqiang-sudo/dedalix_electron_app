#!/usr/bin/env node
// Cross-platform build script: copies static assets into dist/ after tsc
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const src = path.join(root, 'src');
const dist = path.join(root, 'dist');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function copyFile(from, to) {
  ensureDir(path.dirname(to));
  fs.copyFileSync(from, to);
  console.log(`  copied ${path.relative(root, from)} → ${path.relative(root, to)}`);
}

// 1. screenshot-overlay.html → dist/
const overlayHtml = path.join(src, 'screenshot-overlay.html');
if (fs.existsSync(overlayHtml)) {
  copyFile(overlayHtml, path.join(dist, 'screenshot-overlay.html'));
} else {
  console.warn(`  warning: ${path.relative(root, overlayHtml)} not found, skipping`);
}

// 2. renderer/erp-bridge.js → dist/renderer/
const erpBridge = path.join(src, 'renderer', 'erp-bridge.js');
if (fs.existsSync(erpBridge)) {
  copyFile(erpBridge, path.join(dist, 'renderer', 'erp-bridge.js'));
} else {
  console.warn(`  warning: ${path.relative(root, erpBridge)} not found, skipping`);
}

// 3. services/*.js → dist/services/
const servicesDir = path.join(src, 'services');
if (fs.existsSync(servicesDir)) {
  const files = fs.readdirSync(servicesDir).filter(f => f.endsWith('.js'));
  for (const file of files) {
    copyFile(
      path.join(servicesDir, file),
      path.join(dist, 'services', file)
    );
  }
} else {
  console.warn(`  warning: ${path.relative(root, servicesDir)} not found, skipping`);
}

console.log('Build assets copied successfully.');
