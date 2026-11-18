import path from "node:path";
import { writePrivateFile } from "../dist/setup-store.js";

export default async function afterPack({ appOutDir, packager }) {
  const name = packager.appInfo.productFilename;
  const executable = path.join(
    appOutDir,
    ...(packager.platform.name === "mac"
      ? [`${name}.app`, "Contents", "MacOS", name]
      : [packager.platform.name === "windows" ? `${name}.exe` : "coginebot-dev"]),
  );
  await writePrivateFile(
    path.join(packager.config.directories.output, "build-receipt.json"),
    JSON.stringify({ executable }),
  );
}
