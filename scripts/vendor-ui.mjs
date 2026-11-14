// Commit these pinned assets so Django deployment needs no Node runtime or CDN.
import {
  mkdir,
  readFile,
  writeFile,
  copyFile,
  readdir,
} from "node:fs/promises";
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

// IBM Plex Sans (OFL-1.1), Latin subset, the three weights the UI uses.
const fonts = "web/static/vendor/ibm-plex-sans";
const fontSource = "node_modules/@fontsource/ibm-plex-sans";
await mkdir(fonts, { recursive: true });
for (const weight of [400, 500, 600]) {
  const file = `ibm-plex-sans-latin-${weight}-normal.woff2`;
  await copyFile(`${fontSource}/files/${file}`, `${fonts}/${file}`);
}
await copyFile(`${fontSource}/LICENSE`, `${fonts}/LICENSE`);

// Leaflet (BSD-2-Clause) for the delivery-area map. Map tiles and place names
// are fetched from external services at runtime; the library itself is local.
const leaflet = "web/static/vendor/leaflet";
const leafletSource = "node_modules/leaflet";
await mkdir(`${leaflet}/images`, { recursive: true });
await copyFile(`${leafletSource}/dist/leaflet.css`, `${leaflet}/leaflet.css`);
await writeFile(
  `${leaflet}/leaflet.js`,
  (await readFile(`${leafletSource}/dist/leaflet.js`, "utf8")).replace(
    /\/\/# sourceMappingURL=.*$/gm,
    "",
  ),
);
for (const image of await readdir(`${leafletSource}/dist/images`))
  await copyFile(
    `${leafletSource}/dist/images/${image}`,
    `${leaflet}/images/${image}`,
  );
await copyFile(`${leafletSource}/LICENSE`, `${leaflet}/LICENSE`);
