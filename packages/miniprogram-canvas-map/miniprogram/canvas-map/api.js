/**
 * canvas-map 对外简洁 API 辅助
 * 详见 README.md
 */
const { getTileProviderList } = require("./tile-providers");

const PROJECTION = {
  MERCATOR: "mercator",
  EQUIRECTANGULAR: "equirectangular"
};

const THEMES = {
  default: {
    fill: "#d8a24a",
    stroke: "#ffffff",
    point: { color: "#e63946", radius: 6, stroke: "#ffffff", strokeWidth: 2 },
    line: { color: "#457b9d", width: 2 },
    polygon: { fill: "rgba(69, 123, 157, 0.35)", stroke: "#1d3557", width: 1.5 },
    label: { color: "#17211d", size: 12 }
  },
  warm: {
    fill: "#d8a24a",
    stroke: "#ffffff",
    point: { color: "#e76f51", radius: 7, stroke: "#ffffff", strokeWidth: 2 },
    line: { color: "#f4a261", width: 2.5 },
    polygon: { fill: "rgba(231, 111, 81, 0.35)", stroke: "#bc4749", width: 1.5 },
    label: { color: "#bc4749", size: 12 }
  },
  ocean: {
    fill: "#4a90d8",
    stroke: "#e8f4ff",
    point: { color: "#219ebc", radius: 6, stroke: "#ffffff", strokeWidth: 2 },
    line: { color: "#457b9d", width: 2 },
    polygon: { fill: "rgba(69, 123, 157, 0.35)", stroke: "#1d3557", width: 1.5 },
    label: { color: "#1d3557", size: 12 }
  }
};

const TILE_ALIASES = {
  "": false,
  off: false,
  none: false,
  false: false,
  osm: "osm",
  carto: "cartoLight",
  gaode: "gaode",
  baidu: "baidu",
  tencent: "tencent",
  tianditu: "tiandituVec",
  geoq: "geoq"
};

function parseTilesOption(tiles) {
  if (tiles === undefined || tiles === null) {
    return null;
  }
  const raw = String(tiles).trim();
  const key = raw.toLowerCase();
  if (!key || key === "off" || key === "none" || key === "false") {
    return { enabled: false, providerId: "custom" };
  }
  if (/^https?:\/\//i.test(raw)) {
    return { enabled: true, providerId: "custom", customUrl: raw };
  }
  const providerId = TILE_ALIASES[key] || key;
  if (providerId === false) {
    return { enabled: false, providerId: "custom" };
  }
  return { enabled: true, providerId };
}

function resolveStyle(properties) {
  const themeName = properties.theme || "default";
  const theme = THEMES[themeName] || THEMES.default;
  const custom = properties.style && typeof properties.style === "object" ? properties.style : {};
  const point = { ...theme.point, ...(custom.point || {}) };
  const line = { ...theme.line, ...(custom.line || {}) };
  const polygon = { ...theme.polygon, ...(custom.polygon || {}) };
  const label = { ...theme.label, ...(custom.label || {}) };

  return {
    fillColor: custom.fill || theme.fill,
    strokeColor: custom.stroke || theme.stroke,
    pointColor: point.color,
    pointRadius: point.radius,
    pointStrokeColor: point.stroke,
    pointStrokeWidth: point.strokeWidth,
    lineColor: line.color,
    lineWidth: line.width,
    polygonFillColor: polygon.fill,
    polygonStrokeColor: polygon.stroke,
    polygonLineWidth: polygon.width,
    labelColor: label.color,
    labelFontSize: label.size
  };
}

function resolveBackground(properties) {
  const bg = properties.background;
  if (bg === null || bg === undefined || bg === "") {
    return { backgroundColor: "", containerBackground: "" };
  }
  if (typeof bg === "object") {
    const containerBackground =
      bg.containerBackground !== undefined
        ? bg.containerBackground
        : bg.container !== undefined
          ? bg.container
          : "";
    const backgroundColor =
      bg.backgroundColor !== undefined
        ? bg.backgroundColor
        : bg.canvas !== undefined
          ? bg.canvas
          : bg.color !== undefined
            ? bg.color
            : "";
    return {
      containerBackground: String(containerBackground).trim(),
      backgroundColor: String(backgroundColor).trim()
    };
  }
  const text = String(bg).trim();
  return {
    backgroundColor: text,
    containerBackground: text
  };
}

function normalizeTapDetail(target, tapPoint) {
  if (!target) {
    return {
      type: "blank",
      index: -1,
      data: null,
      x: tapPoint && tapPoint.x,
      y: tapPoint && tapPoint.y
    };
  }
  const typeMap = {
    point: "point",
    line: "line",
    polygon: "polygon",
    feature: "area"
  };
  return {
    type: typeMap[target.kind] || target.kind,
    index: target.index,
    data: target.data || null,
    lng: target.lng,
    lat: target.lat,
    name: target.name,
    x: tapPoint && tapPoint.x,
    y: tapPoint && tapPoint.y
  };
}

function parseFlyTarget(target) {
  if (target === undefined || target === null) {
    return { mode: "none" };
  }
  if (typeof target === "string") {
    const mode = target.toLowerCase();
    if (mode === "overlay" || mode === "selected" || mode === "selection") {
      return { mode };
    }
  }
  if (typeof target === "number") {
    return { mode: "zoom", zoom: target };
  }
  return { mode: "coords", coordinates: target };
}

module.exports = {
  PROJECTION,
  THEMES,
  TILE_ALIASES,
  getTileProviderList,
  parseTilesOption,
  resolveStyle,
  resolveBackground,
  normalizeTapDetail,
  parseFlyTarget
};
