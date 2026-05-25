# miniprogram-canvas-map

微信小程序 **Canvas 2D** 地图组件：矢量面底图、点/线/面叠加、多源瓦片、墨卡托/经纬度投影、1–18 级缩放、视角飞行、PNG 导出。

适用于不依赖原生 `<map>` 组件、需要自定义样式与数据绑定的场景。

---

## 安装

在项目根目录（与 `app.json` 同级，即小程序根目录）执行：

```bash
npm install miniprogram-canvas-map
```

在微信开发者工具中：

1. 打开你的小程序项目（**若演示项目则打开 `example` 目录**）
2. 菜单 **工具 → 构建 npm**
3. 确认生成 `miniprogram_npm/miniprogram-canvas-map/`

> 基础库建议 **2.19.0+**，并启用 **Canvas 2D**（`type="2d"`，组件已内置）。

---

## 快速开始

### 1. 注册组件

在页面的 `*.json` 中：

```json
{
  "usingComponents": {
    "canvas-map": "/miniprogram_npm/miniprogram-canvas-map/miniprogram/canvas-map/canvas-map"
  }
}
```

### 2. 使用组件

```xml
<view class="map-panel">
  <canvas-map
    id="map"
    class="map-host"
    polygons="{{polygons}}"
    overlay="{{overlay}}"
    tiles="osm"
    projection="mercator"
    theme="warm"
    background="{{background}}"
    bind:ready="onMapReady"
    bind:tap="onTap"
    bind:zoom="onZoom"
  />
</view>
```

```css
/* 父容器需有明确高度 */
.map-panel {
  width: 100%;
  height: 420rpx;
}
.map-host {
  width: 100%;
  height: 100%;
}
```

```js
Page({
  data: {
    polygons: null,
    overlay: {
      points: [{ lng: 116.4074, lat: 39.9042, label: "北京", radius: 7 }],
      lines: [],
      polygons: []
    },
    background: "#f4f6f3"
  },
  onMapReady() {
    this.map = this.selectComponent("#map");
  },
  onTap(e) {
    console.log(e.detail);
  }
});
```

### 3. 可选：内置世界面数据

包内附带 Natural Earth 国界（175 个面），**仅一份** `data/world.js`（约 **165 KB**）：

- 坐标保留 **2 位小数**（屏幕显示无可见损失），不做 Douglas–Peucker 简化
- `properties` 仅保留 **`name_zh` / `name_en`**（及展示用 `name`，默认中文）
- 相对旧版约 930KB 全属性 GeoJSON，体积约减 **82%**

```js
const worldGeoJson = require("miniprogram-canvas-map/miniprogram/canvas-map/data/world");

Page({
  onMapReady() {
    const map = this.selectComponent("#map");
    map.setPolygons(worldGeoJson);
  }
});
```

**主包仍紧张时：**

1. **不要** `require` 世界数据，仅用 `tiles` 瓦片底图 + `overlay` 业务叠加。
2. 将地图页放入**分包**，在分包内 `require` 上述数据模块。
3. 自行维护更小 GeoJSON，通过 `polygons` / `setPolygons` 传入。
4. 全精度源数据在仓库 `scripts/data/world-full.json`（仅维护者），可用 `npm run build:world-data` 重新生成发布文件。

---

## 属性

| 属性 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `polygons` | Object | — | 底图面：GeoJSON `FeatureCollection` / `Feature`，或 `{ polygons: [...] }` |
| `overlay` | Object | — | 叠加层 `{ points, lines, polygons }` |
| `tiles` | String | `""` | 瓦片：`off` / `osm` / `gaode` / `baidu` / `tencent` / `tianditu` / `carto` / `geoq`，或 `https://` 自定义模板 |
| `token` | String | `""` | 天地图 `tk` |
| `projection` | String | `mercator` | `mercator` \| `equirectangular` |
| `theme` | String | `default` | `default` \| `warm` \| `ocean` |
| `style` | Object | — | 细调配色，见下文 |
| `background` | String \| Object | `#f4f6f3` | 背景；对象：`{ containerBackground, backgroundColor }`，渐变写在 `containerBackground` |
| `tap` | Boolean | `true` | 是否响应点击 |
| `fly-on-select` | Boolean | `false` | 选中后自动 `flyTo` |
| `min-zoom` / `max-zoom` | Number | `1` / `18` | 缩放范围 |
| `initial-zoom` | Number | `0` | 初始级别，`0` 为自动适配 |
| `zoom-animate` | Boolean | `true` | 程序化缩放是否动画 |
| `zoom-animate-duration` | Number | `280` | 缩放动画时长（ms） |
| `hide-vector-when-tiles` | Boolean | `false` | 有瓦片时隐藏底图矢量 |
| `tile-min-zoom` / `tile-max-zoom` | Number | — | 瓦片级别限制（覆盖服务商默认） |
| `tile-opacity` | Number | `1` | 瓦片透明度 0–1 |
| `show-status` | Boolean | `false` | 显示内置状态文案 |
| `show-reset` | Boolean | `false` | 显示内置「复位」按钮 |

### `style` 示例

```js
style: {
  fill: "#d8a24a",
  stroke: "#ffffff",
  point: { color: "#e63946", radius: 7, stroke: "#fff", strokeWidth: 2 },
  line: { color: "#457b9d", width: 2 },
  polygon: { fill: "rgba(69,123,157,0.35)", stroke: "#1d3557", width: 1.5 },
  label: { color: "#1d2433", size: 12 }
}
```

### 瓦片预设别名

| `tiles` 值 | 说明 |
|------------|------|
| `off` / `none` | 关闭 |
| `osm` | OpenStreetMap |
| `carto` | Carto 浅色 |
| `gaode` | 高德标准（minZoom 3） |
| `baidu` | 百度 |
| `tencent` | 腾讯 |
| `tianditu` | 天地图（需 `token`） |
| `geoq` | GeoQ |

---

## 方法

通过 `this.selectComponent('#map')` 获取实例。

| 方法 | 返回值 | 说明 |
|------|--------|------|
| `update(opts)` | `this` | 批量更新属性对应数据，见 `opts` 字段 |
| `setPolygons(data)` | `number` | 设置底图面，返回要素数量 |
| `setOverlay(data)` | `Object` | 设置叠加层 |
| `reset()` | `boolean` | 复位视图 |
| `zoom(level, opts?)` | `boolean` | 设置 1–18 级 |
| `flyTo(target, opts?)` | `boolean` | 飞行，见下文 |
| `fit(target, opts?)` | `boolean` | 适配范围，如 `'overlay'` |
| `export(opts?)` | `Promise` | 导出 PNG |
| `save(opts?)` | `Promise` | 导出并保存相册 |
| `getZoom()` | `number` | 当前级别 |
| `getView()` | `Object` | 视口经纬度范围 |
| `relayout()` | `this` | 容器尺寸变化后重算画布 |
| `setPointDrawer(fn)` | `this` | 自定义点绘制 `(ctx, payload) => {}` |
| `getSelected()` / `setSelected()` / `clearSelected()` | — | 选中态 |

### `flyTo` 目标

- `[lng, lat]` 或 `[[lng, lat], ...]`
- `'overlay'`：适配叠加层
- `'selected'`：飞往当前选中
- 数字：视为 zoom 级别

```js
map.flyTo([116.4, 39.9], { zoom: 10, animate: true, duration: 500 });
map.flyTo("selected");
map.export({ pixelRatio: 2, waitForTiles: true, waitTimeout: 5000 });
```

---

## 事件

| 事件 | detail |
|------|--------|
| `bind:ready` | `{ count, zoom }` 地图就绪 |
| `bind:tap` | `{ type, index, data, lng, lat, name, x, y }`，`type`: `point` \| `line` \| `polygon` \| `area` \| `blank` |
| `bind:select` | 选中变化，字段同 `tap` |
| `bind:zoom` | `{ zoom, minZoom, maxZoom }` |
| `bind:export` | `{ tempFilePath, width, height, fileType }` |
| `bind:exportfail` / `bind:savefail` | 错误信息 |

> 勿使用 `bind:onReady`，请用 `bind:ready`（`onReady` 与页面生命周期重名）。

---

## 数据格式

### 底图 `polygons`

```js
// GeoJSON
{ type: "FeatureCollection", features: [/* Polygon / MultiPolygon */] }

// 面数组
{
  polygons: [
    {
      coordinates: [[[lng, lat], ...]],
      name: "区域 A",
      fillColor: "#d8a24a",
      strokeColor: "#fff"
    }
  ]
}
```

### 叠加 `overlay`

```js
{
  points: [{ lng, lat, color, radius, label, renderType: "circle" | "pin" | "diamond" | "custom" }],
  lines: [{ coordinates: [[lng, lat], ...], strokeColor, lineWidth, label }],
  polygons: [{ coordinates: [[[lng, lat], ...]], fillColor, strokeColor, label }]
}
```

---

## 瓦片缓存

- 已加载瓦片保存在内存（约 **256** 张，LRU），同一 URL **只请求一次**。
- 当前级别未加载完时，用**父级**或已缓存的**子级**瓦片裁切回退，减轻缩放空白。
- 拖动、捏合、缩放动画期间不裁剪缓存。
- 切换 `tiles` 或 `projection` 会清空缓存（需重新加载）。

---

## 性能建议

- 开启瓦片时建议 `hide-vector-when-tiles="{{true}}"`，避免矢量与瓦片重叠。
- 底图 GeoJSON 请简化几何；叠加要素建议控制在数百级以内。
- 高德/百度等 **minZoom ≥ 3**，全球视图（级别 1–2）瓦片可能较稀疏，属图源限制。

---

## 目录结构（npm 包内）

```
miniprogram-canvas-map/
├── package.json
├── README.md
├── LICENSE
└── miniprogram/
    └── canvas-map/
        ├── canvas-map.js      # 组件逻辑
        ├── canvas-map.json
        ├── canvas-map.wxml
        ├── canvas-map.wxss
        ├── api.js
        ├── perf.js
        ├── tile-providers.js
        └── data/
            └── world.js       # 国界数据（2 位小数，~165KB）
```

---

## 发布到 npm（维护者）

本包目录下已配置 `.npmrc`，**发布时走官方源** `https://registry.npmjs.org/`，不受全局 cnpm/npmmirror 影响。

```bash
# 在仓库根目录重新生成国界数据（修改 world-full 后执行）
npm run build:world-data

cd packages/miniprogram-canvas-map

# 登录官方 npm（会打开浏览器或提示输入账号，不是 cnpm）
npm login --registry=https://registry.npmjs.org

# 确认当前目录 registry
npm config get registry
# 应输出 https://registry.npmjs.org/

npm publish --access public
```

若全局 `~/.npmrc` 里是 `registry=https://registry.npmmirror.com/`，**安装依赖仍可继续用镜像**；只有在本包目录执行 `npm publish` 时会用官方源。

发布前在仓库根目录执行：

```bash
npm test
```

---

## 许可证

MIT
