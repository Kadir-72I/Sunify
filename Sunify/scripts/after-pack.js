const fs = require('node:fs/promises');
const path = require('node:path');

exports.default = async function afterPack(context) {
  const appOutDir = context.appOutDir;
  // Paketlenen uygulamada kullanılmayan ağır Chromium lisans, yazılımsal Vulkan ve eski DX9 derleyici dosyalarını sil (~25 MB kazanç)
  const removableFiles = [
    'LICENSES.chromium.html',
    'LICENSE.electron.txt',
    'vk_swiftshader.dll',
    'vk_swiftshader_icd.json',
    'vulkan-1.dll',
    'd3dcompiler_47.dll',
  ];
  await Promise.all(
    removableFiles.map((name) => fs.rm(path.join(appOutDir, name), { force: true }).catch(() => {}))
  );

  // Yalnızca Türkçe ve İngilizce dil paketlerini tut
  const localesDir = path.join(appOutDir, 'locales');
  const allowedLocales = new Set(['tr.pak', 'en-US.pak']);
  const localeFiles = await fs.readdir(localesDir).catch(() => []);
  await Promise.all(
    localeFiles
      .filter((name) => !allowedLocales.has(name))
      .map((name) => fs.rm(path.join(localesDir, name), { force: true }).catch(() => {}))
  );
};
