#!/usr/bin/env node
/**
 * Build script for SFDC Metadata Navigator Chrome Extension.
 *
 * Uses esbuild to bundle each entry point (background, popup, content, settings)
 * into self-contained JS files, then assembles the final extension directory
 * at `build/` ready to be loaded as an unpacked Chrome extension.
 */

const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BUILD_DIR = path.join(ROOT, 'build');

// ---------------------------------------------------------------------------
// Clean build directory
// ---------------------------------------------------------------------------

function cleanBuildDir() {
  if (fs.existsSync(BUILD_DIR)) {
    fs.rmSync(BUILD_DIR, { recursive: true });
  }
  fs.mkdirSync(BUILD_DIR, { recursive: true });
}

// ---------------------------------------------------------------------------
// Bundle entry points with esbuild
// ---------------------------------------------------------------------------

async function bundleEntryPoints() {
  const commonOptions = {
    bundle: true,
    minify: false, // Keep readable for debugging
    sourcemap: false,
    target: ['chrome100'],
    format: 'iife', // Self-contained, no ES module imports
  };

  // Background service worker
  await esbuild.build({
    ...commonOptions,
    entryPoints: [path.join(ROOT, 'src/background/background.ts')],
    outfile: path.join(BUILD_DIR, 'js/background/background.js'),
  });

  // Content script
  await esbuild.build({
    ...commonOptions,
    entryPoints: [path.join(ROOT, 'src/content/content.ts')],
    outfile: path.join(BUILD_DIR, 'js/content/content.js'),
  });

  // Popup script
  await esbuild.build({
    ...commonOptions,
    entryPoints: [path.join(ROOT, 'src/popup/popup.ts')],
    outfile: path.join(BUILD_DIR, 'popup/popup.js'),
    external: [], // Bundle fuse.js inline
  });

  // Settings script
  await esbuild.build({
    ...commonOptions,
    entryPoints: [path.join(ROOT, 'src/settings/settings.ts')],
    outfile: path.join(BUILD_DIR, 'settings/settings.js'),
  });

  // Scanner UI script
  await esbuild.build({
    ...commonOptions,
    entryPoints: [path.join(ROOT, 'src/scanner/scanner-ui.ts')],
    outfile: path.join(BUILD_DIR, 'scanner/scanner-ui.js'),
  });

  // Org Info script
  await esbuild.build({
    ...commonOptions,
    entryPoints: [path.join(ROOT, 'src/orginfo/orginfo.ts')],
    outfile: path.join(BUILD_DIR, 'orginfo/orginfo.js'),
  });

  // Field Inspector script (injected into Salesforce pages)
  await esbuild.build({
    ...commonOptions,
    entryPoints: [path.join(ROOT, 'src/field-inspector/field-inspector.ts')],
    outfile: path.join(BUILD_DIR, 'js/field-inspector/field-inspector.js'),
  });

  // Perm Checker script
  await esbuild.build({
    ...commonOptions,
    entryPoints: [path.join(ROOT, 'src/perm-checker/perm-checker.ts')],
    outfile: path.join(BUILD_DIR, 'perm-checker/perm-checker.js'),
  });

  console.log('  Bundled all entry points.');
}

// ---------------------------------------------------------------------------
// Copy static assets
// ---------------------------------------------------------------------------

function copyStaticAssets() {
  // manifest.json
  fs.copyFileSync(
    path.join(ROOT, 'manifest.json'),
    path.join(BUILD_DIR, 'manifest.json')
  );

  // Icons
  const iconsDir = path.join(BUILD_DIR, 'icons');
  fs.mkdirSync(iconsDir, { recursive: true });
  for (const file of fs.readdirSync(path.join(ROOT, 'icons'))) {
    if (file.endsWith('.png')) {
      fs.copyFileSync(
        path.join(ROOT, 'icons', file),
        path.join(iconsDir, file)
      );
    }
  }

  // Popup HTML and CSS
  const popupDir = path.join(BUILD_DIR, 'popup');
  fs.mkdirSync(popupDir, { recursive: true });
  fs.copyFileSync(
    path.join(ROOT, 'src/popup/popup.html'),
    path.join(popupDir, 'popup.html')
  );
  fs.copyFileSync(
    path.join(ROOT, 'src/popup/popup.css'),
    path.join(popupDir, 'popup.css')
  );

  // Settings HTML and CSS
  const settingsDir = path.join(BUILD_DIR, 'settings');
  fs.mkdirSync(settingsDir, { recursive: true });
  fs.copyFileSync(
    path.join(ROOT, 'src/settings/settings.html'),
    path.join(settingsDir, 'settings.html')
  );
  fs.copyFileSync(
    path.join(ROOT, 'src/settings/settings.css'),
    path.join(settingsDir, 'settings.css')
  );

  // Scanner HTML and CSS
  const scannerDir = path.join(BUILD_DIR, 'scanner');
  fs.mkdirSync(scannerDir, { recursive: true });
  fs.copyFileSync(
    path.join(ROOT, 'src/scanner/scanner.html'),
    path.join(scannerDir, 'scanner.html')
  );
  fs.copyFileSync(
    path.join(ROOT, 'src/scanner/scanner.css'),
    path.join(scannerDir, 'scanner.css')
  );

  // Org Info HTML and CSS
  const orginfoDir = path.join(BUILD_DIR, 'orginfo');
  fs.mkdirSync(orginfoDir, { recursive: true });
  fs.copyFileSync(
    path.join(ROOT, 'src/orginfo/orginfo.html'),
    path.join(orginfoDir, 'orginfo.html')
  );
  fs.copyFileSync(
    path.join(ROOT, 'src/orginfo/orginfo.css'),
    path.join(orginfoDir, 'orginfo.css')
  );

  // Perm Checker HTML and CSS
  const permCheckerDir = path.join(BUILD_DIR, 'perm-checker');
  fs.mkdirSync(permCheckerDir, { recursive: true });
  fs.copyFileSync(
    path.join(ROOT, 'src/perm-checker/perm-checker.html'),
    path.join(permCheckerDir, 'perm-checker.html')
  );
  fs.copyFileSync(
    path.join(ROOT, 'src/perm-checker/perm-checker.css'),
    path.join(permCheckerDir, 'perm-checker.css')
  );

  console.log('  Copied static assets.');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('Building SFDC Metadata Navigator extension...\n');

  cleanBuildDir();
  console.log('1. Cleaned build directory.');

  await bundleEntryPoints();
  console.log('2. Bundled TypeScript entry points.');

  copyStaticAssets();
  console.log('3. Copied static assets.\n');

  console.log(`Build complete! Extension ready at: ${BUILD_DIR}`);
  console.log('Load it in Chrome via: chrome://extensions → Load unpacked → select the build/ folder');
}

main().catch((err) => {
  console.error('Build failed:', err);
  process.exit(1);
});
