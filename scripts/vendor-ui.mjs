// Commit these pinned assets so Django deployment needs no Node runtime or CDN.
import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
const target = "web/static/vendor/bootstrap";
await mkdir(target, { recursive: true });
for (const [source, destination] of [
  ["dist/css/bootstrap.min.css", "bootstrap.min.css"],
  ["dist/js/bootstrap.bundle.min.js", "bootstrap.bundle.min.js"],
]) {
  const text = await readFile(`node_modules/bootstrap/${source}`, "utf8");
  await writeFile(
    `${target}/${destination}`,
    text
      .replace(/\/\*# sourceMappingURL=.*?\*\//g, "")
      .replace(/\/\/# sourceMappingURL=.*$/gm, ""),
  );
}
await copyFile("node_modules/bootstrap/LICENSE", `${target}/LICENSE`);
