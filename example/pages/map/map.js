const defaultGeoJson = require("miniprogram-canvas-map/miniprogram/canvas-map/data/world");

const PROJECTION = {
  MERCATOR: "mercator",
  EQUIRECTANGULAR: "equirectangular"
};

const BG_PRESETS = {
  solid: { containerBackground: "", backgroundColor: "#f4f6f3" },
  gradient: {
    containerBackground: "linear-gradient(165deg, #1d2433 0%, #3d5a80 48%, #8ecae6 100%)",
    backgroundColor: "transparent"
  },
  transparent: { containerBackground: "transparent", backgroundColor: "transparent" }
};

const MAP_COLOR_PRESETS = {
  gold: { fillColor: "#d8a24a", strokeColor: "#ffffff" },
  ocean: { fillColor: "#4a90d8", strokeColor: "#e8f4ff" },
  forest: { fillColor: "#588157", strokeColor: "#f1faee" }
};

const OVERLAY_PRESETS = {
  empty: null,
  default: {
    points: [
      {
        lng: 116.4074,
        lat: 39.9042,
        color: "#e63946",
        radius: 7,
        strokeColor: "#ffffff",
        label: "北京",
        labelColor: "#c1121f"
      },
      {
        lng: 121.4737,
        lat: 31.2304,
        color: "#2a9d8f",
        radius: 7,
        strokeColor: "#ffffff",
        label: "上海",
        labelColor: "#0077b6"
      }
    ],
    lines: [
      {
        coordinates: [
          [116.4074, 39.9042],
          [121.4737, 31.2304]
        ],
        strokeColor: "#e76f51",
        lineWidth: 3,
        label: "京沪连线",
        labelColor: "#bc4749"
      }
    ],
    polygons: [
      {
        coordinates: [[[108, 32], [122, 32], [122, 42], [108, 42], [108, 32]]],
        fillColor: "rgba(69, 123, 157, 0.28)",
        strokeColor: "#1d3557",
        lineWidth: 2,
        label: "华北区域",
        labelColor: "#1d3557"
      }
    ]
  },
  south: {
    points: [
      { lng: 113.2644, lat: 23.1291, color: "#f4a261", radius: 7, strokeColor: "#fff", label: "广州", labelColor: "#e76f51" },
      { lng: 114.0579, lat: 22.5431, color: "#e9c46a", radius: 7, strokeColor: "#fff", label: "深圳", labelColor: "#f77f00" },
      { lng: 114.1694, lat: 22.3193, color: "#2a9d8f", radius: 7, strokeColor: "#fff", label: "香港", labelColor: "#2a9d8f" }
    ],
    lines: [
      {
        coordinates: [
          [113.2644, 23.1291],
          [114.0579, 22.5431],
          [114.1694, 22.3193]
        ],
        strokeColor: "#264653",
        lineWidth: 2.5,
        label: "华南线路",
        labelColor: "#264653"
      }
    ],
    polygons: [
      {
        coordinates: [[[108, 20], [118, 20], [118, 26], [108, 26], [108, 20]]],
        fillColor: "rgba(244, 162, 97, 0.25)",
        strokeColor: "#e76f51",
        lineWidth: 2,
        label: "华南区域",
        labelColor: "#e76f51"
      }
    ]
  },
  clear: { points: [], lines: [], polygons: [] }
};

const TILE_PRESETS = {
  off: "off",
  osm: "osm",
  carto: "carto",
  gaode: "gaode",
  baidu: "baidu",
  tencent: "tencent",
  tianditu: "tianditu",
  geoq: "geoq"
};

const TILE_REQUIRES_TOKEN = { tianditu: true };

const OVERLAY_STYLE_PRESETS = {
  warm: {
    pointColor: "#e76f51",
    lineColor: "#f4a261",
    polygonFillColor: "rgba(231, 111, 81, 0.35)",
    polygonStrokeColor: "#bc4749",
    labelColor: "#bc4749"
  },
  cool: {
    pointColor: "#219ebc",
    lineColor: "#457b9d",
    polygonFillColor: "rgba(69, 123, 157, 0.35)",
    polygonStrokeColor: "#1d3557",
    labelColor: "#1d3557"
  }
};

function getProjectionLabel(projection) {
  return projection === PROJECTION.EQUIRECTANGULAR ? "经纬度" : "墨卡托";
}

function cloneOverlayWithPointRender(overlay, renderType) {
  const next = {
    points: (overlay.points || []).map((point) => ({
      ...point,
      renderType: renderType || ""
    })),
    lines: overlay.lines || [],
    polygons: overlay.polygons || []
  };
  return next;
}

function drawStar(ctx, x, y, radius, color) {
  const spikes = 5;
  const outer = radius;
  const inner = radius * 0.45;
  let rotation = -Math.PI / 2;
  const step = Math.PI / spikes;
  ctx.beginPath();
  for (let index = 0; index < spikes * 2; index += 1) {
    const r = index % 2 === 0 ? outer : inner;
    const px = x + Math.cos(rotation) * r;
    const py = y + Math.sin(rotation) * r;
    if (index === 0) {
      ctx.moveTo(px, py);
    } else {
      ctx.lineTo(px, py);
    }
    rotation += step;
  }
  ctx.closePath();
  ctx.fillStyle = color || "#e9c46a";
  ctx.fill();
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

Page({
  data: {
    mapZoom: null,
    projection: PROJECTION.MERCATOR,
    projectionLabel: "墨卡托",
    theme: "warm",
    background: BG_PRESETS.solid,
    bgPreset: "solid",
    tiles: "off",
    tilePreset: "off",
    token: "",
    hideVectorWhenTiles: false,
    polygons: defaultGeoJson,
    overlay: null,
    basePreset: "world",
    overlayPreset: "empty",
    pointRenderPreset: "circle",
    lastTapText: "点击地图上的点/线/面",
    selectedLabel: "未选中",
    apiProperties: [
      { name: "polygons", type: "Object", desc: "底图面（GeoJSON 或面数组），不传则不画。" },
      { name: "overlay", type: "Object", desc: "叠加 { points, lines, polygons }。" },
      { name: "tiles", type: "String", desc: "瓦片：off / osm / gaode / … 或 https 自定义模板。" },
      { name: "token", type: "String", desc: "天地图 tk。" },
      { name: "theme", type: "String", desc: "default / warm / ocean，配合 style 细调。" },
      { name: "projection", type: "String", desc: "mercator | equirectangular。" },
      { name: "background", type: "String|Object", desc: "背景色或 { containerBackground, backgroundColor }。" },
      { name: "tap", type: "Boolean", desc: "是否响应点击。" },
      { name: "fly-on-select", type: "Boolean", desc: "选中后自动飞行。" },
      { name: "hide-vector-when-tiles", type: "Boolean", desc: "有瓦片时隐藏底图矢量。" }
    ],
    apiMethods: [
      { name: "update(opts)", desc: "批量更新 polygons / overlay / tiles / token / theme …" },
      { name: "setPolygons / setOverlay", desc: "设置底图面、叠加层。" },
      { name: "reset()", desc: "复位视图。" },
      { name: "zoom(level)", desc: "设置 1–18 级缩放。" },
      { name: "flyTo(target)", desc: "飞行：坐标、坐标数组、'overlay'、'selected'。" },
      { name: "fit('overlay')", desc: "视角适配叠加层。" },
      { name: "export() / save()", desc: "导出 PNG、保存相册。" },
      { name: "getZoom() / getView()", desc: "当前级别、视口范围。" }
    ],
    apiEvents: [
      { name: "bind:ready", desc: "加载完成 { count, zoom }。" },
      { name: "bind:tap", desc: "点击 { type, index, data, lng, lat }。" },
      { name: "bind:select", desc: "选中变化，字段同 tap。" },
      { name: "bind:zoom", desc: "{ zoom, minZoom, maxZoom }。" },
      { name: "bind:export / exportfail", desc: "导出成功或失败。" },
      { name: "bind:save / savefail", desc: "保存相册成功或失败。" }
    ]
  },

  getMap() {
    return this.selectComponent("#map");
  },

  getMapComponent() {
    return this.getMap();
  },

  onShow() {
    wx.nextTick(() => {
      const map = this.getMapComponent();
      if (map && typeof map.relayout === "function") {
        map.relayout();
      }
    });
  },

  onMapReady(event) {
    const detail = (event && event.detail) || {};
    if (detail.zoom !== undefined) {
      this.setData({ mapZoom: detail.zoom });
    }
    if (this.data.basePreset === "world") {
      const map = this.getMap();
      if (map && typeof map.setPolygons === "function") {
        map.setPolygons(defaultGeoJson);
      }
    }
    this.setupPointDrawer();
  },

  onZoom(event) {
    const detail = event.detail || {};
    if (detail.zoom !== undefined) {
      this.setData({ mapZoom: detail.zoom });
    }
  },

  onTap(event) {
    const detail = event.detail || {};
    const typeLabel = {
      point: "点",
      line: "线",
      polygon: "面",
      area: "底图面",
      blank: "空白"
    };
    const label =
      detail.type === "blank"
        ? "空白区域"
        : (detail.data && detail.data.label) ||
          detail.name ||
          `${typeLabel[detail.type] || "要素"} #${(detail.index || 0) + 1}`;
    this.setData({
      selectedLabel: detail.type === "blank" ? "未选中" : label,
      lastTapText: detail.type === "blank" ? "点击空白" : `选中：${label}`
    });
    if (detail.type !== "blank") {
      wx.showToast({ title: label, icon: "none", duration: 1400 });
    }
  },

  setupPointDrawer() {
    const map = this.getMap();
    if (!map || typeof map.setPointDrawer !== "function") {
      return;
    }
    map.setPointDrawer((ctx, payload) => {
      drawStar(ctx, payload.x, payload.y, payload.radius, payload.point.color);
    });
  },

  onExportPng() {
    const map = this.getMap();
    if (!map || typeof map.export !== "function") {
      return;
    }
    wx.showLoading({ title: "导出中" });
    map
      .export({ pixelRatio: 2, waitForTiles: this.data.tiles && this.data.tiles !== "off", waitTimeout: 5000 })
      .then((result) => {
        wx.hideLoading();
        wx.previewImage({ urls: [result.tempFilePath], current: result.tempFilePath });
        this.setData({ lastTapText: "已导出 PNG" });
      })
      .catch((error) => {
        wx.hideLoading();
        wx.showToast({
          title: (error && error.errMsg) || "导出失败",
          icon: "none"
        });
      });
  },

  onSavePngToAlbum() {
    const map = this.getMap();
    if (!map || typeof map.save !== "function") {
      return;
    }
    wx.showLoading({ title: "保存中" });
    map
      .save({ pixelRatio: 2 })
      .then(() => {
        wx.hideLoading();
        wx.showToast({ title: "已保存到相册", icon: "success" });
      })
      .catch((error) => {
        wx.hideLoading();
        if (error && error.errMsg && error.errMsg.indexOf("auth deny") !== -1) {
          wx.showModal({
            title: "需要相册权限",
            content: "请在设置中允许保存到相册后重试",
            confirmText: "去设置",
            success: (res) => {
              if (res.confirm) {
                wx.openSetting();
              }
            }
          });
          return;
        }
        wx.showToast({
          title: (error && error.errMsg) || "保存失败",
          icon: "none"
        });
      });
  },

  onFitToOverlay() {
    const map = this.getMap();
    if (!map || typeof map.fit !== "function") {
      return;
    }
    if (!this.data.overlay) {
      wx.showToast({ title: "请先加载叠加数据", icon: "none" });
      return;
    }
    const ok = map.fit("overlay", { animate: true, duration: 500 });
    if (!ok) {
      wx.showToast({ title: "叠加层无要素", icon: "none" });
    }
  },

  onFlyToSelected() {
    const map = this.getMap();
    if (!map || typeof map.flyTo !== "function") {
      return;
    }
    const ok = map.flyTo("selected", { animate: true, duration: 500 });
    if (!ok) {
      wx.showToast({ title: "请先点击点/线/面", icon: "none" });
    }
  },

  onBasePresetChange(event) {
    const preset = event.currentTarget.dataset.preset;
    if (!preset || preset === this.data.basePreset) {
      return;
    }
    const polygons = preset === "world" ? defaultGeoJson : null;
    this.setData({ basePreset: preset, polygons });
    const map = this.getMap();
    if (map && typeof map.setPolygons === "function") {
      const count = map.setPolygons(polygons);
      if (preset === "world") {
        wx.showToast({ title: `已加载 ${count} 个面`, icon: "none" });
      }
    }
  },

  onProjectionChange(event) {
    const projection = event.currentTarget.dataset.projection;
    if (!projection || projection === this.data.projection) {
      return;
    }
    this.setData({
      projection,
      projectionLabel: getProjectionLabel(projection)
    });
    const map = this.getMap();
    if (map && typeof map.update === "function") {
      map.update({ projection });
    }
  },

  onTilePresetChange(event) {
    const preset = event.currentTarget.dataset.preset;
    const tiles = TILE_PRESETS[preset];
    if (!preset || tiles === undefined || preset === this.data.tilePreset) {
      return;
    }
    if (TILE_REQUIRES_TOKEN[preset] && !this.data.token) {
      wx.showToast({ title: "请先填写天地图 tk", icon: "none" });
      return;
    }
    this.setData({ tilePreset: preset, tiles });
    const map = this.getMap();
    if (map && typeof map.update === "function") {
      map.update({ tiles, token: this.data.token });
    }
  },

  onTokenInput(event) {
    const token = (event.detail && event.detail.value) || "";
    this.setData({ token });
    const map = this.getMap();
    if (map && typeof map.update === "function") {
      map.update({ token });
    }
  },

  onTileVectorToggle(event) {
    const mode = event.currentTarget.dataset.mode;
    if (!mode) {
      return;
    }
    const hideVectorWhenTiles = mode === "hide";
    this.setData({ hideVectorWhenTiles });
    const map = this.getMap();
    if (map && typeof map.update === "function") {
      map.update({ hideVectorWhenTiles });
    }
  },

  onMapReset() {
    const map = this.getMap();
    if (map && typeof map.reset === "function") {
      map.reset();
    }
  },

  onFlyToBeijing() {
    const map = this.getMap();
    if (map) {
      map.flyTo([116.4074, 39.9042], { zoom: 10, animate: true });
    }
  },

  onFlyToJingHu() {
    const map = this.getMap();
    if (map) {
      map.flyTo(
        [
          [116.4074, 39.9042],
          [121.4737, 31.2304]
        ],
        { animate: true, padding: 0.25 }
      );
    }
  },

  onFlyToSouth() {
    if (this.data.overlayPreset !== "south") {
      this.onOverlayPresetChange({ currentTarget: { dataset: { preset: "south" } } });
    }
    const map = this.getMap();
    if (map) {
      map.flyTo("overlay", { animate: true, padding: 0.3 });
    }
  },

  onBgPresetChange(event) {
    const preset = event.currentTarget.dataset.preset;
    const config = BG_PRESETS[preset];
    if (!preset || !config || preset === this.data.bgPreset) {
      return;
    }
    this.setData({ bgPreset: preset, background: config });
    const map = this.getMap();
    if (map && typeof map.update === "function") {
      map.update({ background: config });
    }
  },

  onThemeChange(event) {
    const preset = event.currentTarget.dataset.preset;
    if (!preset || preset === this.data.theme) {
      return;
    }
    this.setData({ theme: preset });
    const map = this.getMap();
    if (map && typeof map.update === "function") {
      map.update({ theme: preset });
    }
  },

  onOverlayPresetChange(event) {
    const preset = event.currentTarget.dataset.preset;
    const overlaySource = OVERLAY_PRESETS[preset];
    if (!preset || preset === this.data.overlayPreset) {
      return;
    }
    const renderMap = { circle: "", pin: "pin", diamond: "diamond", custom: "custom" };
    const overlay =
      preset === "empty" ? null : cloneOverlayWithPointRender(overlaySource, renderMap[this.data.pointRenderPreset] || "");
    this.setData({ overlayPreset: preset, overlay });
    const map = this.getMap();
    if (map && typeof map.setOverlay === "function") {
      map.setOverlay(overlay);
    }
  },

  onPointRenderChange(event) {
    const preset = event.currentTarget.dataset.preset;
    const renderMap = {
      circle: "",
      pin: "pin",
      diamond: "diamond",
      custom: "custom"
    };
    if (!preset || preset === this.data.pointRenderPreset) {
      return;
    }

    const baseOverlay = OVERLAY_PRESETS[this.data.overlayPreset] || OVERLAY_PRESETS.default;
    if (!baseOverlay) {
      return;
    }
    const nextOverlay = cloneOverlayWithPointRender(baseOverlay, renderMap[preset]);
    this.setData({
      pointRenderPreset: preset,
      overlay: nextOverlay
    });

    const map = this.getMap();
    if (map) {
      if (preset === "custom") {
        this.setupPointDrawer();
      } else if (typeof map.setPointDrawer === "function") {
        map.setPointDrawer(null);
      }
      if (typeof map.setOverlay === "function") {
        map.setOverlay(nextOverlay);
      }
    }
  }
});
