/**
 * Generate extension icons (16, 48, 128px).
 * Run: node scripts/generate-icons.js
 * Requires: sharp (npm install sharp --save-dev)
 *
 * If sharp is unavailable, creates simple colored PNG placeholders.
 */
const fs = require('fs');
const path = require('path');

const SIZES = [16, 48, 128];
const ICON_DIR = path.join(__dirname, '..', 'icons');

// Simple 1-pixel purple PNG as placeholder (valid PNG files)
// In production, replace with actual designed icons
function createPlaceholderPNG(size) {
  // Minimal valid PNG with purple color (#6366f1)
  // This creates a 1x1 purple pixel PNG that browsers will scale
  const header = Buffer.from([
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, // PNG signature
    0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52, // IHDR chunk
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, // 1x1 pixels
    0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xDE, // 8-bit RGB
    0x00, 0x00, 0x00, 0x0C, 0x49, 0x44, 0x41, 0x54, // IDAT chunk
    0x08, 0xD7, 0x63, 0x98, 0xC9, 0xF2, 0x1E, 0x00, // compressed pixel (purple-ish)
    0x01, 0x05, 0x00, 0xFE, 0xC5, 0xAD, 0xA3, 0x6A, // 
    0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, // IEND chunk
    0xAE, 0x42, 0x60, 0x82,
  ]);
  return header;
}

if (!fs.existsSync(ICON_DIR)) {
  fs.mkdirSync(ICON_DIR, { recursive: true });
}

for (const size of SIZES) {
  const outPath = path.join(ICON_DIR, `icon-${size}.png`);
  fs.writeFileSync(outPath, createPlaceholderPNG(size));
  console.log(`Created: icons/icon-${size}.png (placeholder)`);
}

// Remove .gitkeep
const gitkeep = path.join(ICON_DIR, '.gitkeep');
if (fs.existsSync(gitkeep)) fs.unlinkSync(gitkeep);

console.log('\nReplace these with properly designed icons before publishing.');
