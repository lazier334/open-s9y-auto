import fs from "node:fs";
import archiver from "archiver";

export type ZipResult =
  | { success: true; sizeKB: string }
  | { success: false; error: string };

export async function zipDir(
  sourceDir: string,
  outputPath: string
): Promise<ZipResult> {
  try {
    const output = fs.createWriteStream(outputPath);
    const archive = archiver("zip", { zlib: { level: 9 } });

    archive.on("warning", (err: any) => {
      if (err.code !== "ENOENT") {
        output.destroy(err);
      }
    });
    archive.on("error", (err: any) => {
      output.destroy(err);
    });

    archive.pipe(output);
    archive.directory(sourceDir, false);
    await archive.finalize();

    await new Promise<void>((resolve, reject) => {
      output.on("close", () => resolve());
      output.on("error", reject);
    });

    const sizeKB = (archive.pointer() / 1024).toFixed(2);
    return { success: true, sizeKB };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: message };
  }
}
