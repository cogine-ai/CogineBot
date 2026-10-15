import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = new URL("../../../", import.meta.url);
const path = (name: string) => fileURLToPath(new URL(name, root));
const source = path("packages/ui-tokens/assets/CogineBot.svg");

// The approved C artwork includes its centered layout and background.
const square = await sharp(source).resize(1024, 1024).png().toBuffer();
const mask = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><rect width="1024" height="1024" rx="200" fill="white"/></svg>',
);
const rounded = await sharp(square)
  .composite([{ input: mask, blend: "dest-in" }])
  .png()
  .toBuffer();

async function png(input: Buffer, name: string, size: number) {
  await sharp(input).resize(size, size).png().toFile(path(name));
}

// PNG frames in ICO are supported by modern Windows and browser favicon loaders.
async function ico(input: Buffer, name: string, sizes: number[]) {
  const frames = await Promise.all(sizes.map((size) => sharp(input).resize(size).png().toBuffer()));
  const header = Buffer.alloc(6 + frames.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(frames.length, 4);
  let offset = header.length;
  frames.forEach((frame, index) => {
    const entry = 6 + index * 16;
    header[entry] = header[entry + 1] = sizes[index] === 256 ? 0 : sizes[index];
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(frame.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += frame.length;
  });
  await writeFile(path(name), Buffer.concat([header, ...frames]));
}

for (const app of ["web", "www"]) {
  const publicDir = `apps/${app}/public`;
  await png(rounded, `${publicDir}/favicon-16x16.png`, 16);
  await png(rounded, `${publicDir}/favicon-32x32.png`, 32);
  await png(rounded, `${publicDir}/favicon.png`, 128);
  await png(square, `${publicDir}/apple-touch-icon.png`, 180);
  await png(square, `${publicDir}/icon-192.png`, 192);
  await png(square, `${publicDir}/icon-512.png`, 512);
  await ico(rounded, `${publicDir}/favicon.ico`, [16, 32, 48]);
}
await mkdir(path("apps/www/public/brand"), { recursive: true });
await png(rounded, "apps/www/public/brand/rakazo-mark.png", 256);
// Mobile's web favicon uses the approved transparent symbol, not a launcher tile.
const symbol = await sharp(path("packages/ui-tokens/assets/CogineBot-symbol.svg"))
  .resize(128, 128)
  .png()
  .toBuffer();
await png(symbol, "apps/mobile/assets/favicon.png", 128);

// Apple Icon Composer, desktop legacy icons, and Android adaptive/notification
// exports have distinct native masks and safe areas. Keep their checked-in
// platform exports; this browser-asset command must not overwrite them.
