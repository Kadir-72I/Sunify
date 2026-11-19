// src/utils/colorExtractor.js
/**
 * Extract dominant RGB color from an image element or canvas.
 * @param {HTMLImageElement} imgElement
 * @returns {{r: number, g: number, b: number, hex: string}}
 */
function extractDominantColor(imgElement) {
  try {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    canvas.width = 40;
    canvas.height = 40;
    ctx.drawImage(imgElement, 0, 0, 40, 40);

    const imgData = ctx.getImageData(0, 0, 40, 40).data;
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

    if (count === 0) return { r: 99, g: 102, b: 241, hex: '#6366f1' }; // Fallback indigo

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
