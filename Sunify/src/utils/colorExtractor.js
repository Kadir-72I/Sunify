// src/utils/colorExtractor.js
let sharedCanvas = null;
let sharedCtx = null;

/**
 * Extract dominant RGB color from an image element or canvas.
 * @param {HTMLImageElement} imgElement
 * @returns {{r: number, g: number, b: number, hex: string}}
 */
function extractDominantColor(imgElement) {
  try {
    if (!sharedCanvas) {
      sharedCanvas = document.createElement('canvas');
      sharedCanvas.width = 32;
      sharedCanvas.height = 32;
      sharedCtx = sharedCanvas.getContext('2d', { willReadFrequently: true });
    }
    sharedCtx.drawImage(imgElement, 0, 0, 32, 32);

    const imgData = sharedCtx.getImageData(0, 0, 32, 32).data;
    let r = 0,
      g = 0,
      b = 0,
      count = 0;

    for (let i = 0; i < imgData.length; i += 4) {
      const red = imgData[i];
      const green = imgData[i + 1];
      const blue = imgData[i + 2];
      const alpha = imgData[i + 3];

      // Siyah veya çok beyaza yakın tonları ele
      if (alpha > 128 && red + green + blue > 60 && red + green + blue < 700) {
        r += red;
        g += green;
        b += blue;
        count++;
      }
    }

    if (count === 0) return { r: 99, g: 102, b: 241, hex: '#6366f1' };

    r = Math.round(r / count);
    g = Math.round(g / count);
    b = Math.round(b / count);

    const toHex = (c) => ('0' + c.toString(16)).slice(-2);
    return { r, g, b, hex: `#${toHex(r)}${toHex(g)}${toHex(b)}` };
  } catch (e) {
    return { r: 99, g: 102, b: 241, hex: '#6366f1' };
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { extractDominantColor };
}
