// Renders the app icon from design/logo/*.svg into PNG + multi-size ICO (apps/desktop/build).
// Run with Electron (Chromium rasterizes the SVG): pnpm icon
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { app, BrowserWindow } from 'electron';

const root = join(import.meta.dirname, '../..');
const logo = join(root, 'design/logo');
const out = join(root, 'apps/desktop/build');
// Small sizes use the simplified mark (one arc, larger plane) so it stays legible.
const SMALL = [16, 20, 24];
const ICO = [16, 20, 24, 32, 40, 48, 64, 256];

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const big = await readFile(join(logo, 'icon.svg'), 'utf8');
  const small = await readFile(join(logo, 'icon-small.svg'), 'utf8');
  const w = new BrowserWindow({ show: false });
  await w.loadURL('about:blank');
  const render = async (svg, size) => {
    const url = await w.webContents.executeJavaScript(`new Promise((ok, fail) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = c.height = ${size};
        c.getContext('2d').drawImage(img, 0, 0, ${size}, ${size});
        ok(c.toDataURL('image/png'));
      };
      img.onerror = fail;
      img.src = 'data:image/svg+xml;base64,' + ${JSON.stringify(Buffer.from(svg).toString('base64'))};
    })`);
    return Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
  };

  const pngs = [];
  for (const size of ICO) pngs.push(await render(SMALL.includes(size) ? small : big, size));
  await writeFile(join(out, 'icon.ico'), ico(ICO, pngs));
  await writeFile(join(out, 'icon.png'), await render(big, 512));
  console.log(`icon.ico (${ICO.join(', ')}) and icon.png (512) → ${out}`);
  app.quit();
});

// ICO container with PNG-compressed entries (supported since Windows Vista).
function ico(sizes, pngs) {
  const head = Buffer.alloc(6 + 16 * sizes.length);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(sizes.length, 4);
  let offset = head.length;
  sizes.forEach((size, i) => {
    const e = 6 + 16 * i;
    head.writeUInt8(size >= 256 ? 0 : size, e);
    head.writeUInt8(size >= 256 ? 0 : size, e + 1);
    head.writeUInt16LE(1, e + 4);
    head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(pngs[i].length, e + 8);
    head.writeUInt32LE(offset, e + 12);
    offset += pngs[i].length;
  });
  return Buffer.concat([head, ...pngs]);
}
