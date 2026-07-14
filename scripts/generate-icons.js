#!/usr/bin/env node
/**
 * Generates PNG icon files for the SFDC Metadata Navigator Chrome Extension.
 * Creates minimal valid PNG files with a Salesforce-blue background and
 * a white "SF" design indicator.
 *
 * Sizes: 16x16, 48x48, 128x128
 * No external dependencies required (uses Node.js built-in zlib).
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// Salesforce-inspired blue color
const BG_R = 0x1b;
const BG_G = 0x96;
const BG_B = 0xff;

// White accent color for the inner design
const FG_R = 0xff;
const FG_G = 0xff;
const FG_B = 0xff;

/**
 * Creates a simple PNG file with a colored square and a smaller inner square accent.
 * @param {number} size - Width and height in pixels
 * @returns {Buffer} - Valid PNG file buffer
 */
function createIcon(size) {
  // Build raw pixel data (RGBA) with filter byte per row
  const rawData = Buffer.alloc((size * 4 + 1) * size);

  // Inner accent square dimensions (centered, ~40% of size)
  const accentSize = Math.max(4, Math.floor(size * 0.4));
  const accentOffset = Math.floor((size - accentSize) / 2);

  // Rounded corner radius
  const radius = Math.max(1, Math.floor(size * 0.15));

  for (let y = 0; y < size; y++) {
    const rowOffset = y * (size * 4 + 1);
    rawData[rowOffset] = 0; // Filter: None

    for (let x = 0; x < size; x++) {
      const pixelOffset = rowOffset + 1 + x * 4;

      // Check if pixel is within rounded rectangle
      const isInRoundedRect = isInsideRoundedRect(x, y, size, size, radius);

      // Check if pixel is in the inner accent area (a magnifying glass shape)
      const isAccent = isInMagnifyingGlass(x, y, size);

      if (!isInRoundedRect) {
        // Transparent outside rounded corners
        rawData[pixelOffset] = 0;
        rawData[pixelOffset + 1] = 0;
        rawData[pixelOffset + 2] = 0;
        rawData[pixelOffset + 3] = 0;
      } else if (isAccent) {
        // White accent
        rawData[pixelOffset] = FG_R;
        rawData[pixelOffset + 1] = FG_G;
        rawData[pixelOffset + 2] = FG_B;
        rawData[pixelOffset + 3] = 255;
      } else {
        // Blue background
        rawData[pixelOffset] = BG_R;
        rawData[pixelOffset + 1] = BG_G;
        rawData[pixelOffset + 2] = BG_B;
        rawData[pixelOffset + 3] = 255;
      }
    }
  }

  // Compress with zlib deflate
  const compressed = zlib.deflateSync(rawData);

  // Build PNG file
  return buildPng(size, size, compressed);
}

/**
 * Checks if a point is inside a rounded rectangle.
 */
function isInsideRoundedRect(x, y, w, h, r) {
  // Check corners
  if (x < r && y < r) {
    return distance(x, y, r, r) <= r;
  }
  if (x >= w - r && y < r) {
    return distance(x, y, w - r - 1, r) <= r;
  }
  if (x < r && y >= h - r) {
    return distance(x, y, r, h - r - 1) <= r;
  }
  if (x >= w - r && y >= h - r) {
    return distance(x, y, w - r - 1, h - r - 1) <= r;
  }
  return true;
}

/**
 * Creates a magnifying glass shape for the icon accent.
 */
function isInMagnifyingGlass(x, y, size) {
  // Circle center and radius (upper-left area)
  const cx = size * 0.4;
  const cy = size * 0.4;
  const r = size * 0.22;
  const thickness = Math.max(1, size * 0.06);

  // Check if on the circle ring
  const dist = distance(x, y, cx, cy);
  if (dist >= r - thickness && dist <= r + thickness) {
    return true;
  }

  // Handle (diagonal line from circle to bottom-right)
  const handleStartX = cx + r * 0.7;
  const handleStartY = cy + r * 0.7;
  const handleEndX = size * 0.75;
  const handleEndY = size * 0.75;
  const handleThickness = Math.max(1, size * 0.07);

  if (distanceToSegment(x, y, handleStartX, handleStartY, handleEndX, handleEndY) <= handleThickness) {
    return true;
  }

  return false;
}

function distance(x1, y1, x2, y2) {
  return Math.sqrt((x1 - x2) ** 2 + (y1 - y2) ** 2);
}

function distanceToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return distance(px, py, x1, y1);

  let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));

  const projX = x1 + t * dx;
  const projY = y1 + t * dy;
  return distance(px, py, projX, projY);
}

/**
 * Builds a valid PNG file from compressed IDAT data.
 */
function buildPng(width, height, compressedData) {
  const chunks = [];

  // PNG Signature
  chunks.push(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));

  // IHDR chunk
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  ihdr[10] = 0; // compression method
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // interlace method
  chunks.push(createChunk('IHDR', ihdr));

  // IDAT chunk
  chunks.push(createChunk('IDAT', compressedData));

  // IEND chunk
  chunks.push(createChunk('IEND', Buffer.alloc(0)));

  return Buffer.concat(chunks);
}

/**
 * Creates a PNG chunk with type, data, length, and CRC.
 */
function createChunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);

  const crcData = Buffer.concat([typeBuffer, data]);
  const crc = crc32(crcData);
  const crcBuffer = Buffer.alloc(4);
  crcBuffer.writeUInt32BE(crc >>> 0, 0);

  return Buffer.concat([length, typeBuffer, data, crcBuffer]);
}

/**
 * CRC32 calculation for PNG chunks.
 */
function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      if (crc & 1) {
        crc = (crc >>> 1) ^ 0xedb88320;
      } else {
        crc = crc >>> 1;
      }
    }
  }
  return crc ^ 0xffffffff;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const iconsDir = path.join(__dirname, '..', 'icons');

// Ensure icons directory exists
if (!fs.existsSync(iconsDir)) {
  fs.mkdirSync(iconsDir, { recursive: true });
}

const sizes = [16, 48, 128];

for (const size of sizes) {
  const pngBuffer = createIcon(size);
  const filePath = path.join(iconsDir, `icon${size}.png`);
  fs.writeFileSync(filePath, pngBuffer);
  console.log(`Created ${filePath} (${pngBuffer.length} bytes)`);
}

console.log('Icon generation complete.');
