import { isBotAvatarValue } from "@rakazo/contracts";
import { File } from "expo-file-system";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import { launchImageLibraryAsync } from "expo-image-picker";

/** Decode locally before accepting a draft; persist the same bounded data URL as Web. */
export async function pickBotAvatar(isCurrent: () => boolean): Promise<string | null> {
  const result = await launchImageLibraryAsync({
    mediaTypes: ["images"],
    allowsMultipleSelection: false,
    quality: 1,
  });
  if (result.canceled || !isCurrent()) return null;
  const asset = result.assets[0];
  if (
    !asset?.uri ||
    !Number.isFinite(asset.width) ||
    !Number.isFinite(asset.height) ||
    asset.width <= 0 ||
    asset.height <= 0
  )
    throw new Error("Invalid avatar image");
  const context = ImageManipulator.manipulate(asset.uri);
  try {
    const side = Math.min(asset.width, asset.height);
    context.crop({
      originX: (asset.width - side) / 2,
      originY: (asset.height - side) / 2,
      width: side,
      height: side,
    });
    context.resize({ width: 256, height: 256 });
    const image = await context.renderAsync();
    try {
      if (!isCurrent()) return null;
      const saved = await image.saveAsync({ format: SaveFormat.WEBP, compress: 0.9, base64: true });
      try {
        if (!isCurrent()) return null;
        const value = `data:image/webp;base64,${saved.base64 ?? ""}`;
        if (!isBotAvatarValue(value)) throw new Error("Invalid avatar image");
        return value;
      } finally {
        // Only our generated cache file, never the library asset.
        try {
          new File(saved.uri).delete();
        } catch {
          /* The OS may already have evicted it. */
        }
      }
    } finally {
      image.release();
    }
  } finally {
    context.release();
  }
}
