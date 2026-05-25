/**
 * canvas-map 自动化冒烟测试（Node 环境，不依赖微信运行时）
 * 运行: node scripts/test-canvas-map.js
 */
const assert = require("assert");
const path = require("path");

const api = require("../packages/miniprogram-canvas-map/miniprogram/canvas-map/api");
const perf = require("../packages/miniprogram-canvas-map/miniprogram/canvas-map/perf");
const world = require("../packages/miniprogram-canvas-map/miniprogram/canvas-map/data/world");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed += 1;
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
  }
}

function mockState(overrides) {
  return Object.assign(
    {
      currentProjection: "mercator",
      canvasWidth: 390,
      canvasHeight: 250,
      canvasDpr: 2,
      baseView: { scale: 0.65, offsetX: 77, offsetY: 7 },
      mapView: { scale: 2, offsetX: 0, offsetY: 0 },
      mapZoom: 1,
      baseMapZoom: 0,
      tileCacheKeys: []
    },
    overrides || {}
  );
}

console.log("\n=== canvas-map 自动化测试 ===\n");

console.log("-- API --");
test("parseTiles off", () => {
  const r = api.parseTilesOption("off");
  assert.strictEqual(r.enabled, false);
});
test("parseTiles osm", () => {
  const r = api.parseTilesOption("osm");
  assert.strictEqual(r.enabled, true);
  assert.strictEqual(r.providerId, "osm");
});
test("resolveBackground 渐变对象", () => {
  const bg = api.resolveBackground({
    background: {
      containerBackground: "linear-gradient(180deg, #000, #fff)",
      backgroundColor: "transparent"
    }
  });
  assert.ok(bg.containerBackground.includes("gradient"));
  assert.strictEqual(bg.backgroundColor, "transparent");
});
test("resolveStyle theme warm", () => {
  const s = api.resolveStyle({ theme: "warm" });
  assert.ok(s.fillColor);
  assert.ok(s.pointColor);
});
test("parseFlyTarget overlay", () => {
  assert.strictEqual(api.parseFlyTarget("overlay").mode, "overlay");
});

console.log("\n-- 世界面数据 --");
test("world.js 175 个面", () => {
  assert.strictEqual(world.features.length, 175);
});
test("world 坐标为 lon,lat", () => {
  const p = world.features[0].geometry.coordinates[0][0];
  assert.ok(Math.abs(p[0]) <= 180);
  assert.ok(Math.abs(p[1]) <= 90);
});
test("world properties 仅含中英文国名", () => {
  const china = world.features.find((f) => f.properties && f.properties.name_zh === "中华人民共和国");
  assert.ok(china, "应有中国");
  assert.strictEqual(china.properties.name_en, "People's Republic of China");
  const keys = new Set();
  world.features.forEach((f) => Object.keys(f.properties || {}).forEach((k) => keys.add(k)));
  assert.deepStrictEqual([...keys].sort(), ["name", "name_en", "name_zh"]);
});

console.log("\n-- 性能 / 坐标 --");
test("normPixelsToLineWidth 约 1 屏幕像素", () => {
  const state = mockState();
  const w = perf.normPixelsToLineWidth(state, 1);
  const t = perf.getViewTransform(state);
  assert.ok(w * t.sx >= 0.5 && w * t.sx <= 2.5, `实际线宽约 ${w * t.sx}px`);
});
test("getRingDecimation 大国界低 zoom 有抽稀", () => {
  assert.ok(perf.getRingDecimation(200, 1) > 1);
  assert.strictEqual(perf.getRingDecimation(200, 12), 1);
});
test("capTileList 不超过上限", () => {
  const tiles = [];
  for (let i = 0; i < 200; i += 1) tiles.push({ z: 5, x: i % 32, y: Math.floor(i / 32) });
  const capped = perf.capTileList(tiles, 128);
  assert.ok(capped.length <= 128);
  assert.ok(capped.length > 0);
});
test("bboxIntersectsNorm", () => {
  assert.strictEqual(
    perf.bboxIntersectsNorm({ minX: 0, minY: 0, maxX: 0.5, maxY: 0.5 }, { minX: 0.4, minY: 0.4, maxX: 1, maxY: 1 }),
    true
  );
  assert.strictEqual(
    perf.bboxIntersectsNorm({ minX: 0, minY: 0, maxX: 0.1, maxY: 0.1 }, { minX: 0.5, minY: 0.5, maxX: 1, maxY: 1 }),
    false
  );
});

console.log("\n-- 瓦片绘制回退 --");
test("buildMercatorTileDrawList 父级回退", () => {
  const state = mockState({
    tileCacheKeys: ["mercator/osm/xyz/5/10/12"]
  });
  const tileConfig = {
    projection: "mercator",
    providerId: "osm",
    scheme: "xyz",
    minZoom: 1,
    maxZoom: 18,
    opacity: 1
  };
  const fakeImage = { width: 256, height: 256 };
  state.tileCache = {
    "mercator/osm/xyz/5/10/12": { status: "loaded", image: fakeImage }
  };
  const drawList = perf.buildMercatorTileDrawList(state, 6, tileConfig, state.tileCache, {});
  const hasSubset = drawList.list.some((item) => item.sw !== undefined);
  assert.ok(drawList.list.length > 0, "应有回退瓦片");
  assert.ok(hasSubset, "应使用父瓦片裁切");
});

console.log("\n-- 语法检查 --");
const files = [
  "../packages/miniprogram-canvas-map/miniprogram/canvas-map/canvas-map.js",
  "../packages/miniprogram-canvas-map/miniprogram/canvas-map/perf.js",
  "../packages/miniprogram-canvas-map/miniprogram/canvas-map/api.js",
  "../packages/miniprogram-canvas-map/miniprogram/canvas-map/tile-providers.js",
  "../example/pages/map/map.js"
];
files.forEach((f) => {
  test(`syntax ${path.basename(f)}`, () => {
    require("child_process").execFileSync("node", ["--check", path.join(__dirname, f)], { stdio: "pipe" });
  });
});

console.log(`\n=== 结果: ${passed} 通过, ${failed} 失败 ===\n`);
process.exit(failed > 0 ? 1 : 0);
