/**
 * 从 scripts/data/world-full.json 生成发布用国界数据 world.js
 * - 单文件；坐标保留 2 位小数（屏幕显示无损失）；无 Douglas-Peucker 简化
 * - properties 仅保留 name / name_zh / name_en
 * 运行: node scripts/build-world-data.js
 */
const fs = require("fs");
const path = require("path");

const COORD_DIGITS = 2;

const root = path.join(__dirname, "..");
const sourcePath = path.join(root, "scripts/data/world-full.json");
const outPath = path.join(root, "packages/miniprogram-canvas-map/miniprogram/canvas-map/data/world.js");

function pickNameProperties(properties, index) {
  const props = properties || {};
  const nameZh = props.name_zh || props.name_zht || props.name || props.admin || "";
  const nameEn = props.name_en || props.name || props.admin || "";
  if (!nameZh && !nameEn) {
    return { name: `region-${index + 1}`, name_zh: `region-${index + 1}`, name_en: `region-${index + 1}` };
  }
  return {
    name: nameZh || nameEn,
    name_zh: nameZh || nameEn,
    name_en: nameEn || nameZh
  };
}

function roundCoordinates(coords, digits) {
  if (!coords || !coords.length) {
    return coords;
  }
  if (typeof coords[0] === "number") {
    return [Number(coords[0].toFixed(digits)), Number(coords[1].toFixed(digits))];
  }
  return coords.map((item) => roundCoordinates(item, digits));
}

function dedupeRing(ring) {
  const out = [];
  for (let index = 0; index < ring.length; index += 1) {
    const point = ring[index];
    const prev = out[out.length - 1];
    if (!prev || prev[0] !== point[0] || prev[1] !== point[1]) {
      out.push(point);
    }
  }
  return out;
}

function roundGeometry(geometry, digits) {
  const type = geometry.type;
  const coordinates = geometry.coordinates || [];
  if (type === "Polygon") {
    return {
      type,
      coordinates: coordinates.map((ring) => dedupeRing(roundCoordinates(ring, digits)))
    };
  }
  if (type === "MultiPolygon") {
    return {
      type,
      coordinates: coordinates.map((polygon) =>
        polygon.map((ring) => dedupeRing(roundCoordinates(ring, digits)))
      )
    };
  }
  return geometry;
}

function buildCollection(source) {
  const features = (source.features || []).map((feature, index) => ({
    type: "Feature",
    geometry: roundGeometry(feature.geometry, COORD_DIGITS),
    properties: pickNameProperties(feature.properties, index)
  }));
  return { type: "FeatureCollection", features };
}

function formatKb(bytes) {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

if (!fs.existsSync(sourcePath)) {
  console.error(`[build-world-data] 缺少源文件: ${sourcePath}`);
  process.exit(1);
}

const source = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
const data = buildCollection(source);
const json = JSON.stringify(data);
const content = `/** 由 scripts/build-world-data.js 生成，请勿手改 */\nmodule.exports=${json};\n`;
fs.writeFileSync(outPath, content);

const litePath = path.join(path.dirname(outPath), "world-lite.js");
const miniPath = path.join(path.dirname(outPath), "world-mini.js");
if (fs.existsSync(litePath)) fs.unlinkSync(litePath);
if (fs.existsSync(miniPath)) fs.unlinkSync(miniPath);

console.log("[build-world-data] 源:", sourcePath, formatKb(fs.statSync(sourcePath).size));
console.log(
  `  world.js: ${data.features.length} 面, 坐标 ${COORD_DIGITS} 位小数, ${formatKb(Buffer.byteLength(content))}`
);
