const { getTileProvider } = require("./tile-providers");
const {
  PROJECTION: API_PROJECTION,
  parseTilesOption,
  resolveStyle,
  resolveBackground,
  normalizeTapDetail,
  parseFlyTarget
} = require("./api");
const perf = require("./perf");

const PROJECTION = API_PROJECTION;

const MERCATOR_MAX_LAT = 85.05112878;
const MAP_ZOOM_MIN = 1;
const MAP_ZOOM_MAX = 18;
const DEFAULT_FLY_DURATION = 400;
const DEFAULT_ZOOM_ANIMATE_DURATION = 350;
const ZOOM_SNAP_DURATION = 320;
const DEFAULT_FLY_ZOOM = 10;
const DEFAULT_FLY_PADDING = 0.12;

const requestFrame =
  typeof requestAnimationFrame === "function"
    ? requestAnimationFrame
    : (callback) => setTimeout(callback, 16);
const cancelFrame =
  typeof cancelAnimationFrame === "function" ? cancelAnimationFrame : clearTimeout;
const FIT_PADDING_RATIO = 0.94;
const BOUNDS_PADDING = 0.015;
const TILE_SIZE = 256;
const MAX_TILE_CACHE = 256;
const MAX_TILE_LOADS_PER_FRAME = 6;
const MAX_VISIBLE_TILES = 128;
const TILE_PAN_DEBOUNCE_MS = 120;
const TILE_INTERACT_REQUEST_MS = 100;
const TILE_LOADING_UI_INTERVAL_MS = 400;
const TILE_EXPORT_WAIT_MS = 4000;
const DOUBLE_TAP_MS = 320;
const DOUBLE_TAP_DISTANCE = 36;
const DEFAULT_TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";

function createMapState(projection) {
  return {
    canvasNode: null,
    canvasContext: null,
    canvasWidth: 0,
    canvasHeight: 0,
    canvasDpr: 1,
    initAttempts: 0,
    drawTimer: null,
    rafScheduled: false,
    pinchActive: false,
    tileZoomLock: null,
    viewAnimating: false,
    animTileZoom: null,
    baseView: { scale: 1, offsetX: 0, offsetY: 0 },
    mapView: { scale: 1, offsetX: 0, offsetY: 0 },
    mapZoom: MAP_ZOOM_MIN,
    baseMapZoom: MAP_ZOOM_MIN,
    touchState: {
      mode: "",
      lastPoint: null,
      lastDistance: 0,
      lastCenter: null
    },
    mapPaths: [],
    rawFeatures: [],
    overlayLayers: { points: [], lines: [], polygons: [], pointDrawer: null },
    contentBounds: { minX: 0, minY: 0, maxX: 1, maxY: 1, width: 1, height: 1 },
    currentProjection: projection || PROJECTION.MERCATOR,
    tileCache: {},
    tileCacheKeys: [],
    currentTileZoom: 0,
    viewAnimationTimer: null,
    selectedTarget: null,
    tileLoadQueue: [],
    tileQueueProcessing: false,
    tileQueueTimer: null,
    tilePanDebounceTimer: null,
    tileRedrawScheduled: false,
    interacting: false,
    frameTiles: null,
    frameTileSignature: "",
    viewSignature: "",
    tilesDirty: false,
    _lastTileUiAt: 0
  };
}

function getFeatureName(feature, index) {
  const properties = feature.properties || {};
  return (
    properties.name_zh ||
    properties.name ||
    properties.name_en ||
    properties.admin ||
    `Area ${index + 1}`
  );
}

function getGeometryPolygonGroups(geometry) {
  if (!geometry) {
    return [];
  }
  if (geometry.type === "Polygon") {
    return [geometry.coordinates || []];
  }
  if (geometry.type === "MultiPolygon") {
    return geometry.coordinates || [];
  }
  return [];
}

function projectMercator(lon, lat) {
  const clampedLat = clamp(lat, -MERCATOR_MAX_LAT, MERCATOR_MAX_LAT);
  const latRad = (clampedLat * Math.PI) / 180;

  return {
    x: (lon + 180) / 360,
    y: (1 - Math.log(Math.tan(Math.PI / 4 + latRad / 2)) / Math.PI) / 2
  };
}

function projectEquirectangular(lon, lat) {
  return {
    x: (lon + 180) / 360,
    y: (90 - lat) / 180
  };
}

function projectPoint(lon, lat, projection) {
  if (projection === PROJECTION.EQUIRECTANGULAR) {
    return projectEquirectangular(lon, lat);
  }
  return projectMercator(lon, lat);
}

function getMapSize(projection) {
  if (projection === PROJECTION.EQUIRECTANGULAR) {
    return { width: 360, height: 180 };
  }
  return { width: 360, height: 360 };
}

function buildMapPaths(features, projection) {
  return (features || []).map((feature, index) => {
    const polygonGroups = getGeometryPolygonGroups(feature.geometry).map((polygonRings) =>
      (polygonRings || []).map((ring) =>
        (ring || []).map((point) => projectPoint(point[0], point[1], projection))
      )
    );
    const rings = polygonGroups.reduce((acc, group) => acc.concat(group), []);
    return {
      index,
      name: getFeatureName(feature, index),
      properties: feature.properties || {},
      rawFeature: feature,
      polygonGroups,
      rings,
      bbox: perf.computeFeatureNormBBox(rings)
    };
  });
}

function getPathsBounds(mapPaths) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  (mapPaths || []).forEach((feature) => {
    (feature.rings || []).forEach((ring) => {
      (ring || []).forEach((point) => {
        minX = Math.min(minX, point.x);
        minY = Math.min(minY, point.y);
        maxX = Math.max(maxX, point.x);
        maxY = Math.max(maxY, point.y);
      });
    });
  });

  if (!Number.isFinite(minX)) {
    return null;
  }

  const padX = Math.max((maxX - minX) * BOUNDS_PADDING, BOUNDS_PADDING * 0.5);
  const padY = Math.max((maxY - minY) * BOUNDS_PADDING, BOUNDS_PADDING * 0.5);
  let nextMinX = minX - padX;
  let nextMinY = minY - padY;
  let nextMaxX = maxX + padX;
  let nextMaxY = maxY + padY;
  // 全球范围底图：用完整墨卡托/经纬度 norm 框适配，避免钳位后纵向比例失真
  if (maxX - minX > 0.85 && maxY - minY > 0.45) {
    nextMinX = 0;
    nextMinY = 0;
    nextMaxX = 1;
    nextMaxY = 1;
  } else {
    nextMinX = Math.max(0, nextMinX);
    nextMinY = Math.max(0, nextMinY);
    nextMaxX = Math.min(1, nextMaxX);
    nextMaxY = Math.min(1, nextMaxY);
  }

  return {
    minX: nextMinX,
    minY: nextMinY,
    maxX: nextMaxX,
    maxY: nextMaxY,
    width: Math.max(nextMaxX - nextMinX, 0.001),
    height: Math.max(nextMaxY - nextMinY, 0.001)
  };
}

function isEmptyDataSource(source) {
  if (source === null || source === undefined || source === "") {
    return true;
  }
  if (Array.isArray(source) && source.length === 0) {
    return true;
  }
  if (typeof source === "object" && Array.isArray(source.polygons) && source.polygons.length === 0) {
    const hasPoints = Array.isArray(source.points) && source.points.length > 0;
    const hasLines = Array.isArray(source.lines) && source.lines.length > 0;
    if (!hasPoints && !hasLines) {
      return true;
    }
  }
  return false;
}

function polygonItemToFeature(item, index) {
  const normalized = normalizePolygonItem(item, {});
  if (!normalized) {
    return null;
  }
  const properties = item.properties || {};
  if (!properties.name && !properties.label) {
    properties.name = item.name || item.label || `面 ${index + 1}`;
  }
  return {
    type: "Feature",
    properties,
    geometry: {
      type: "Polygon",
      coordinates: normalized.rings.map((ring) => ring.map((coord) => [coord.lng, coord.lat]))
    }
  };
}

function extractPolygonFeatures(raw) {
  const features = [];

  if (raw.type === "Feature" && raw.geometry) {
    if (raw.geometry.type === "Polygon" || raw.geometry.type === "MultiPolygon") {
      features.push(raw);
    }
    return features;
  }

  if (raw.type === "FeatureCollection" && Array.isArray(raw.features)) {
    raw.features.forEach((feature) => {
      if (feature.geometry && (feature.geometry.type === "Polygon" || feature.geometry.type === "MultiPolygon")) {
        features.push(feature);
      }
    });
    return features;
  }

  if (Array.isArray(raw.polygons)) {
    raw.polygons.forEach((item, index) => {
      const feature = polygonItemToFeature(item, index);
      if (feature) {
        features.push(feature);
      }
    });
    return features;
  }

  if (Array.isArray(raw)) {
    raw.forEach((item, index) => {
      if (item && item.type === "Feature") {
        features.push(...extractPolygonFeatures(item));
      } else {
        const feature = polygonItemToFeature(item, index);
        if (feature) {
          features.push(feature);
        }
      }
    });
    return features;
  }

  if (raw.type === "Polygon" || raw.type === "MultiPolygon") {
    features.push({
      type: "Feature",
      properties: raw.properties || { name: "面 1" },
      geometry: raw
    });
    return features;
  }

  const feature = polygonItemToFeature(raw, 0);
  if (feature) {
    features.push(feature);
  }
  return features;
}

function normalizeBasePolygons(source) {
  if (isEmptyDataSource(source)) {
    return [];
  }

  const raw = parseMaybeJson(source);
  if (!raw) {
    return [];
  }

  return extractPolygonFeatures(raw);
}

function getBasePolygonFeatures(basePolygons) {
  return normalizeBasePolygons(basePolygons);
}

function parseMaybeJson(value) {
  if (typeof value !== "string") {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch (error) {
    return null;
  }
}

function toLngLatPair(value) {
  if (!value) {
    return null;
  }
  if (Array.isArray(value) && value.length >= 2) {
    return { lng: Number(value[0]), lat: Number(value[1]) };
  }
  const lng = value.lng !== undefined ? value.lng : value.longitude !== undefined ? value.longitude : value.lon;
  const lat = value.lat !== undefined ? value.lat : value.latitude;
  if (lng === undefined || lat === undefined) {
    return null;
  }
  return { lng: Number(lng), lat: Number(lat) };
}

function resolveLabelMeta(item, defaults) {
  return {
    label: item.label || item.name || "",
    labelColor: item.labelColor || item.textColor || defaults.labelColor,
    labelFontSize: Number(
      item.labelFontSize !== undefined
        ? item.labelFontSize
        : item.fontSize !== undefined
          ? item.fontSize
          : defaults.labelFontSize
    )
  };
}

function normalizePointItem(item, defaults) {
  const pair =
    toLngLatPair(item) ||
    toLngLatPair(item.coordinate) ||
    toLngLatPair(item.coordinates) ||
    toLngLatPair(item.position);
  if (!pair || !Number.isFinite(pair.lng) || !Number.isFinite(pair.lat)) {
    return null;
  }
  const labelMeta = resolveLabelMeta(item, defaults);
  return {
    lng: pair.lng,
    lat: pair.lat,
    color: item.color || item.pointColor || defaults.pointColor,
    radius: Number(item.radius !== undefined ? item.radius : item.pointRadius !== undefined ? item.pointRadius : defaults.pointRadius),
    strokeColor: item.strokeColor || item.pointStrokeColor || defaults.pointStrokeColor,
    strokeWidth: Number(
      item.strokeWidth !== undefined ? item.strokeWidth : item.pointStrokeWidth !== undefined ? item.pointStrokeWidth : defaults.pointStrokeWidth
    ),
    label: labelMeta.label,
    labelColor: labelMeta.labelColor,
    labelFontSize: labelMeta.labelFontSize,
    renderType: item.renderType || item.render || ""
  };
}

function normalizeLineItem(item, defaults) {
  let coordinates = item.coordinates || item.points || item.path || [];
  if (Array.isArray(coordinates) && coordinates.length >= 2) {
    const first = coordinates[0];
    if (Array.isArray(first) && first.length >= 2 && !Array.isArray(first[0]) && Number.isFinite(Number(first[0]))) {
      coordinates = [coordinates];
    }
  }
  const labelMeta = resolveLabelMeta(item, defaults);
  const lines = [];
  (coordinates || []).forEach((segment) => {
    const projectedSegment = (segment || [])
      .map((coord) => toLngLatPair(coord))
      .filter((coord) => coord && Number.isFinite(coord.lng) && Number.isFinite(coord.lat));
    if (projectedSegment.length >= 2) {
      lines.push({
        coordinates: projectedSegment,
        strokeColor: item.strokeColor || item.lineColor || item.color || defaults.lineColor,
        lineWidth: Number(item.lineWidth !== undefined ? item.lineWidth : item.width !== undefined ? item.width : defaults.lineWidth),
        lineDash: item.lineDash || item.dash || [],
        label: labelMeta.label,
        labelColor: labelMeta.labelColor,
        labelFontSize: labelMeta.labelFontSize
      });
    }
  });
  return lines;
}

function normalizePolygonItem(item, defaults) {
  let coordinates = item.coordinates || item.rings || item.paths || [];
  if (Array.isArray(coordinates) && coordinates.length && !Array.isArray(coordinates[0])) {
    coordinates = [coordinates];
  }
  if (Array.isArray(coordinates) && coordinates.length && Array.isArray(coordinates[0]) && !Array.isArray(coordinates[0][0])) {
    coordinates = [coordinates];
  }

  const rings = (coordinates || [])
    .map((ring) =>
      (ring || [])
        .map((coord) => toLngLatPair(coord))
        .filter((coord) => coord && Number.isFinite(coord.lng) && Number.isFinite(coord.lat))
    )
    .filter((ring) => ring.length >= 3);

  if (!rings.length) {
    return null;
  }

  const labelMeta = resolveLabelMeta(item, defaults);
  return {
    rings,
    fillColor: item.fillColor || item.polygonFillColor || defaults.polygonFillColor,
    strokeColor: item.strokeColor || item.polygonStrokeColor || item.color || defaults.polygonStrokeColor,
    lineWidth: Number(
      item.lineWidth !== undefined ? item.lineWidth : item.strokeWidth !== undefined ? item.strokeWidth : defaults.polygonLineWidth
    ),
    label: labelMeta.label,
    labelColor: labelMeta.labelColor,
    labelFontSize: labelMeta.labelFontSize
  };
}

function appendFeatureToOverlay(target, feature, defaults) {
  const geometry = feature.geometry;
  const props = feature.properties || {};
  if (!geometry) {
    return;
  }

  const style = {
    color: props.color,
    fillColor: props.fillColor,
    strokeColor: props.strokeColor,
    lineWidth: props.lineWidth,
    radius: props.radius,
    label: props.label || props.name,
    labelColor: props.labelColor || props.textColor,
    labelFontSize: props.labelFontSize || props.fontSize
  };

  if (geometry.type === "Point") {
    const point = normalizePointItem({ ...style, coordinates: geometry.coordinates }, defaults);
    if (point) {
      target.points.push(point);
    }
    return;
  }

  if (geometry.type === "MultiPoint") {
    (geometry.coordinates || []).forEach((coord) => {
      const point = normalizePointItem({ ...style, coordinates: coord }, defaults);
      if (point) {
        target.points.push(point);
      }
    });
    return;
  }

  if (geometry.type === "LineString") {
    target.lines.push(
      ...normalizeLineItem({ ...style, coordinates: [geometry.coordinates] }, defaults)
    );
    return;
  }

  if (geometry.type === "MultiLineString") {
    target.lines.push(...normalizeLineItem({ ...style, coordinates: geometry.coordinates }, defaults));
    return;
  }

  if (geometry.type === "Polygon") {
    const polygon = normalizePolygonItem({ ...style, coordinates: geometry.coordinates }, defaults);
    if (polygon) {
      target.polygons.push(polygon);
    }
    return;
  }

  if (geometry.type === "MultiPolygon") {
    (geometry.coordinates || []).forEach((polygonCoords) => {
      const polygon = normalizePolygonItem({ ...style, coordinates: polygonCoords }, defaults);
      if (polygon) {
        target.polygons.push(polygon);
      }
    });
  }
}

function normalizeOverlayData(source, defaults) {
  const empty = { points: [], lines: [], polygons: [] };
  if (source === null || source === undefined || source === "") {
    return empty;
  }

  const raw = parseMaybeJson(source);
  if (!raw) {
    return empty;
  }

  const target = { points: [], lines: [], polygons: [] };

  if (Array.isArray(raw.points)) {
    raw.points.forEach((item) => {
      const point = normalizePointItem(item, defaults);
      if (point) {
        target.points.push(point);
      }
    });
  }
  if (Array.isArray(raw.lines)) {
    raw.lines.forEach((item) => {
      target.lines.push(...normalizeLineItem(item, defaults));
    });
  }
  if (Array.isArray(raw.polygons)) {
    raw.polygons.forEach((item) => {
      const polygon = normalizePolygonItem(item, defaults);
      if (polygon) {
        target.polygons.push(polygon);
      }
    });
  }

  if (raw.type === "FeatureCollection" && Array.isArray(raw.features)) {
    raw.features.forEach((feature) => appendFeatureToOverlay(target, feature, defaults));
  } else if (raw.type === "Feature") {
    appendFeatureToOverlay(target, raw, defaults);
  } else if (Array.isArray(raw)) {
    raw.forEach((item) => {
      if (!item) {
        return;
      }
      if (item.type === "point" || item.lng !== undefined || item.longitude !== undefined) {
        const point = normalizePointItem(item, defaults);
        if (point) {
          target.points.push(point);
        }
        return;
      }
      if (item.type === "line" || item.type === "LineString") {
        target.lines.push(...normalizeLineItem(item, defaults));
        return;
      }
      if (item.type === "polygon" || item.type === "Polygon") {
        const polygon = normalizePolygonItem(item, defaults);
        if (polygon) {
          target.polygons.push(polygon);
        }
        return;
      }
      if (item.geometry) {
        appendFeatureToOverlay(target, item, defaults);
      }
    });
  }

  return target;
}

function buildOverlayLayers(projection, overlayData, defaults) {
  const normalized = normalizeOverlayData(overlayData, defaults);
  return {
    points: normalized.points.map((point, index) => {
      const projected = projectPoint(point.lng, point.lat, projection);
      const r = Math.max((point.radius || 6) / 360, 0.002);
      return {
        ...point,
        index,
        projected,
        bbox: {
          minX: projected.x - r,
          minY: projected.y - r,
          maxX: projected.x + r,
          maxY: projected.y + r
        }
      };
    }),
    lines: normalized.lines.map((line, index) => {
      const projected = line.coordinates.map((coord) => projectPoint(coord.lng, coord.lat, projection));
      return {
        ...line,
        index,
        projected,
        bbox: perf.computeFeatureNormBBox([projected])
      };
    }),
    polygons: normalized.polygons.map((polygon, index) => {
      const projectedRings = polygon.rings.map((ring) =>
        ring.map((coord) => projectPoint(coord.lng, coord.lat, projection))
      );
      return {
        ...polygon,
        index,
        projectedRings,
        bbox: perf.computeFeatureNormBBox(projectedRings)
      };
    })
  };
}

function getOverlayLayersBounds(overlayLayers) {
  if (!overlayLayers) {
    return null;
  }
  const paths = [];
  (overlayLayers.polygons || []).forEach((polygon) => {
    (polygon.projectedRings || []).forEach((ring) => paths.push({ rings: [ring] }));
  });
  (overlayLayers.lines || []).forEach((line) => {
    if (line.projected && line.projected.length) {
      paths.push({ rings: [line.projected] });
    }
  });
  (overlayLayers.points || []).forEach((point) => {
    if (point.projected) {
      paths.push({ rings: [[point.projected]] });
    }
  });
  return getPathsBounds(paths);
}

function mergeBounds(boundsA, boundsB) {
  if (!boundsA) {
    return boundsB;
  }
  if (!boundsB) {
    return boundsA;
  }
  const minX = Math.min(boundsA.minX, boundsB.minX);
  const minY = Math.min(boundsA.minY, boundsB.minY);
  const maxX = Math.max(boundsA.maxX, boundsB.maxX);
  const maxY = Math.max(boundsA.maxY, boundsB.maxY);
  return {
    minX,
    minY,
    maxX,
    maxY,
    width: Math.max(maxX - minX, 0.001),
    height: Math.max(maxY - minY, 0.001)
  };
}

function resolveContentBounds(mapPaths, overlayLayers) {
  const mapBounds = getPathsBounds(mapPaths);
  const overlayBounds = getOverlayLayersBounds(overlayLayers);
  return (
    mergeBounds(mapBounds, overlayBounds) || {
      minX: 0,
      minY: 0,
      maxX: 1,
      maxY: 1,
      width: 1,
      height: 1
    }
  );
}

function getOverlayStyleDefaults(properties) {
  return resolveStyle(properties || {});
}

function isTapEnabled(properties) {
  return properties.tap !== false;
}

function getProjectedMidpoint(projectedPoints) {
  if (!projectedPoints || !projectedPoints.length) {
    return null;
  }
  const midIndex = Math.floor((projectedPoints.length - 1) / 2);
  return projectedPoints[midIndex];
}

function getProjectedCentroid(projectedPoints) {
  if (!projectedPoints || !projectedPoints.length) {
    return null;
  }
  let sumX = 0;
  let sumY = 0;
  projectedPoints.forEach((point) => {
    sumX += point.x;
    sumY += point.y;
  });
  return {
    x: sumX / projectedPoints.length,
    y: sumY / projectedPoints.length
  };
}

function drawOverlayLabel(state, context, item, projectedPoint, offsetX, offsetY) {
  if (!item.label || !projectedPoint) {
    return;
  }
  const canvasPoint = toCanvasPoint(state, projectedPoint);
  context.fillStyle = item.labelColor;
  context.font = `${item.labelFontSize}px sans-serif`;
  context.fillText(item.label, canvasPoint.x + (offsetX || 0), canvasPoint.y + (offsetY || 0));
}

function syncAllMapData(state, projection, basePolygons, overlayData, styleDefaults, pointDrawer) {
  const features = getBasePolygonFeatures(basePolygons);
  state.rawFeatures = features;
  state.mapPaths = buildMapPaths(features, projection);
  state.overlayLayers = buildOverlayLayers(projection, overlayData, styleDefaults);
  state.overlayLayers.pointDrawer = typeof pointDrawer === "function" ? pointDrawer : null;
  state.contentBounds = resolveContentBounds(state.mapPaths, state.overlayLayers);
  state.featureCount = features.length;
  state.viewSignature = "";
  invalidateVisibleTileCache(state);
}

function drawProjectedPath(state, context, projectedPoints, closePath) {
  if (!projectedPoints || projectedPoints.length < 2) {
    return false;
  }

  let started = false;
  for (let index = 0; index < projectedPoints.length; index += 1) {
    const canvasPoint = toCanvasPoint(state, projectedPoints[index]);
    if (!started) {
      context.moveTo(canvasPoint.x, canvasPoint.y);
      started = true;
    } else {
      context.lineTo(canvasPoint.x, canvasPoint.y);
    }
  }
  if (closePath) {
    context.closePath();
  }
  return started;
}

function screenToNorm(state, screenX, screenY) {
  const t = perf.getViewTransform(state);
  return {
    x: (screenX - t.tx) / t.sx,
    y: (screenY - t.ty) / t.sy
  };
}

function drawOverlayLayersNorm(context, overlayLayers, state) {
  if (!overlayLayers) {
    return;
  }

  const vp = perf.getViewportNormBounds(state, 0);
  const normPx = (pixels) => perf.normPixelsToLineWidth(state, pixels);
  const normStroke = normPx;
  const labelOffset = normPx(4);

  (overlayLayers.polygons || []).forEach((polygon) => {
    if (polygon.bbox && !perf.bboxIntersectsNorm(polygon.bbox, vp)) {
      return;
    }
    let hasPath = false;
    context.beginPath();
    (polygon.projectedRings || []).forEach((ring) => {
      const step = perf.getRingDecimation(ring.length, state.mapZoom);
      hasPath = perf.drawRingNorm(context, ring, step) || hasPath;
    });
    if (!hasPath) {
      return;
    }
    if (polygon.fillColor) {
      context.fillStyle = polygon.fillColor;
      context.fill();
    }
    if (polygon.strokeColor) {
      context.strokeStyle = polygon.strokeColor;
      context.lineWidth = Math.max(normStroke(0.5), normStroke(polygon.lineWidth));
      context.stroke();
    }
    const polygonRing = polygon.projectedRings && polygon.projectedRings[0];
    if (polygonRing && polygon.label) {
      const c = getProjectedCentroid(polygonRing);
      context.fillStyle = polygon.labelColor;
      context.font = `${normPx(polygon.labelFontSize)}px sans-serif`;
      context.fillText(polygon.label, c.x + labelOffset, c.y - labelOffset);
    }
  });

  (overlayLayers.lines || []).forEach((line) => {
    if (line.bbox && !perf.bboxIntersectsNorm(line.bbox, vp)) {
      return;
    }
    context.beginPath();
    const step = perf.getRingDecimation(line.projected.length, state.mapZoom);
    let started = false;
    for (let i = 0; i < line.projected.length; i += step) {
      const p = line.projected[i];
      if (!started) {
        context.moveTo(p.x, p.y);
        started = true;
      } else {
        context.lineTo(p.x, p.y);
      }
    }
    if (!started) {
      return;
    }
    context.strokeStyle = line.strokeColor;
    context.lineWidth = Math.max(normStroke(0.5), normStroke(line.lineWidth));
    if (line.lineDash && line.lineDash.length) {
      context.setLineDash(line.lineDash);
    } else {
      context.setLineDash([]);
    }
    context.stroke();
    context.setLineDash([]);
    if (line.label) {
      const mid = getProjectedMidpoint(line.projected);
      context.fillStyle = line.labelColor;
      context.font = `${normPx(line.labelFontSize)}px sans-serif`;
      context.fillText(line.label, mid.x + labelOffset, mid.y - labelOffset);
    }
  });

  (overlayLayers.points || []).forEach((point, index) => {
    if (point.bbox && !perf.bboxIntersectsNorm(point.bbox, vp)) {
      return;
    }
    const pr = point.projected;
    const radiusNorm = Math.max(normPx(point.radius), normPx(0.5));
    const useCustom = point.renderType === "custom" && typeof overlayLayers.pointDrawer === "function";
    const screenShape = useCustom || point.renderType === "pin" || point.renderType === "diamond";
    if (screenShape) {
      const cp = toCanvasPoint(state, pr);
      const radius = Math.max(1, point.radius);
      const dpr = state.canvasDpr || 1;
      context.save();
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (useCustom) {
        overlayLayers.pointDrawer(context, {
          state,
          point,
          index,
          x: cp.x,
          y: cp.y,
          radius,
          lng: point.lng,
          lat: point.lat
        });
      } else if (point.renderType === "pin") {
        drawPointPin(context, cp.x, cp.y, radius, point.color, point.strokeColor, point.strokeWidth);
      } else {
        drawPointDiamond(context, cp.x, cp.y, radius, point.color, point.strokeColor, point.strokeWidth);
      }
      context.restore();
    } else {
      context.beginPath();
      context.arc(pr.x, pr.y, radiusNorm, 0, Math.PI * 2);
      context.fillStyle = point.color;
      context.fill();
      if (point.strokeColor && point.strokeWidth > 0) {
        context.strokeStyle = point.strokeColor;
        context.lineWidth = normStroke(point.strokeWidth);
        context.stroke();
      }
    }
    if (point.label && !useCustom) {
      context.fillStyle = point.labelColor;
      context.font = `${normPx(point.labelFontSize)}px sans-serif`;
      context.fillText(point.label, pr.x + radiusNorm + labelOffset, pr.y + labelOffset);
    }
  });
}

const TAP_MOVE_THRESHOLD = 12;
const TAP_DURATION_THRESHOLD = 360;
const HIT_LINE_THRESHOLD = 10;
const HIT_POINT_PADDING = 6;

function distanceToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) {
    return Math.hypot(px - x1, py - y1);
  }
  let ratio = ((px - x1) * dx + (py - y1) * dy) / lengthSq;
  ratio = clamp(ratio, 0, 1);
  const projX = x1 + ratio * dx;
  const projY = y1 + ratio * dy;
  return Math.hypot(px - projX, py - projY);
}

function isPointInNormRing(normX, normY, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const xi = ring[i].x;
    const yi = ring[i].y;
    const xj = ring[j].x;
    const yj = ring[j].y;
    const intersect = yi > normY !== yj > normY && normX < ((xj - xi) * (normY - yi)) / (yj - yi || 1e-12) + xi;
    if (intersect) {
      inside = !inside;
    }
  }
  return inside;
}

function isPointInCanvasRing(state, tapX, tapY, projectedRing) {
  const norm = screenToNorm(state, tapX, tapY);
  return isPointInNormRing(norm.x, norm.y, projectedRing);
}

function hitTestOverlayPoint(state, tapX, tapY, point) {
  const norm = screenToNorm(state, tapX, tapY);
  const t = perf.getViewTransform(state);
  const radiusNorm = (Math.max(1, point.radius) + HIT_POINT_PADDING) / t.sx;
  return Math.hypot(norm.x - point.projected.x, norm.y - point.projected.y) <= radiusNorm;
}

function hitTestOverlayLine(state, tapX, tapY, line) {
  const norm = screenToNorm(state, tapX, tapY);
  const t = perf.getViewTransform(state);
  const threshold = HIT_LINE_THRESHOLD / t.sx;
  const projected = line.projected || [];
  for (let index = 1; index < projected.length; index += 1) {
    const start = projected[index - 1];
    const end = projected[index];
    if (distanceToSegment(norm.x, norm.y, start.x, start.y, end.x, end.y) <= threshold) {
      return true;
    }
  }
  return false;
}

function hitTestOverlayPolygon(state, tapX, tapY, polygon) {
  const norm = screenToNorm(state, tapX, tapY);
  const tapBox = { minX: norm.x, minY: norm.y, maxX: norm.x, maxY: norm.y };
  if (polygon.bbox && !perf.bboxIntersectsNorm(polygon.bbox, tapBox)) {
    return false;
  }
  const rings = polygon.projectedRings || [];
  for (let index = 0; index < rings.length; index += 1) {
    if (isPointInNormRing(norm.x, norm.y, rings[index])) {
      return true;
    }
  }
  return false;
}

function hitTestMapFeature(state, tapX, tapY, feature) {
  const norm = screenToNorm(state, tapX, tapY);
  const tapBox = { minX: norm.x, minY: norm.y, maxX: norm.x, maxY: norm.y };
  if (feature.bbox && !perf.bboxIntersectsNorm(feature.bbox, tapBox)) {
    return false;
  }
  const rings = feature.rings || [];
  for (let index = 0; index < rings.length; index += 1) {
    if (isPointInNormRing(norm.x, norm.y, rings[index])) {
      return true;
    }
  }
  return false;
}

function getCoordsFromMapPath(mapPath) {
  if (!mapPath || !mapPath.rawFeature || !mapPath.rawFeature.geometry) {
    return [];
  }
  const rings = getGeometryPolygonGroups(mapPath.rawFeature.geometry).reduce(
    (acc, group) => acc.concat(group || []),
    []
  );
  const coords = [];
  rings.forEach((ring) => {
    (ring || []).forEach((point) => {
      if (point && point.length >= 2) {
        coords.push({ lng: point[0], lat: point[1] });
      }
    });
  });
  return coords;
}

function getCoordsFromOverlayItem(state, kind, index) {
  const overlay = state.overlayLayers;
  if (!overlay || index === undefined || index === null || index < 0) {
    return [];
  }

  if (kind === "point") {
    const point = overlay.points && overlay.points[index];
    return point && Number.isFinite(point.lng) ? [{ lng: point.lng, lat: point.lat }] : [];
  }

  if (kind === "line") {
    const line = overlay.lines && overlay.lines[index];
    return line && Array.isArray(line.coordinates) ? line.coordinates : [];
  }

  if (kind === "polygon") {
    const polygon = overlay.polygons && overlay.polygons[index];
    if (!polygon || !Array.isArray(polygon.rings)) {
      return [];
    }
    const coords = [];
    polygon.rings.forEach((ring) => {
      (ring || []).forEach((coord) => {
        if (coord && Number.isFinite(coord.lng)) {
          coords.push({ lng: coord.lng, lat: coord.lat });
        }
      });
    });
    return coords;
  }

  if (kind === "feature") {
    const mapPath = state.mapPaths && state.mapPaths[index];
    return getCoordsFromMapPath(mapPath);
  }

  return [];
}

function resolveFlyOptionsForKind(kind, options) {
  const opts = { ...(options || {}) };
  if (kind === "point") {
    if (opts.zoom === undefined || opts.zoom === null) {
      opts.zoom = DEFAULT_FLY_ZOOM;
    }
  } else if (opts.padding === undefined || opts.padding === null) {
    opts.padding = DEFAULT_FLY_PADDING;
  }
  return opts;
}

function pickMapTarget(state, tapX, tapY) {
  const overlay = state.overlayLayers;
  if (overlay && overlay.points) {
    for (let index = overlay.points.length - 1; index >= 0; index -= 1) {
      const point = overlay.points[index];
      if (hitTestOverlayPoint(state, tapX, tapY, point)) {
        return {
          kind: "point",
          index: point.index,
          data: point,
          lng: point.lng,
          lat: point.lat
        };
      }
    }
  }
  if (overlay && overlay.lines) {
    for (let index = overlay.lines.length - 1; index >= 0; index -= 1) {
      const line = overlay.lines[index];
      if (hitTestOverlayLine(state, tapX, tapY, line)) {
        return { kind: "line", index: line.index, data: line };
      }
    }
  }
  if (overlay && overlay.polygons) {
    for (let index = overlay.polygons.length - 1; index >= 0; index -= 1) {
      const polygon = overlay.polygons[index];
      if (hitTestOverlayPolygon(state, tapX, tapY, polygon)) {
        return { kind: "polygon", index: polygon.index, data: polygon };
      }
    }
  }
  const mapPaths = state.mapPaths || [];
  for (let index = mapPaths.length - 1; index >= 0; index -= 1) {
    const feature = mapPaths[index];
    if (hitTestMapFeature(state, tapX, tapY, feature)) {
      return {
        kind: "feature",
        index: feature.index,
        name: feature.name,
        properties: feature.properties,
        data: feature,
        feature: feature.rawFeature
      };
    }
  }
  return null;
}

function drawPointPin(context, x, y, radius, color, strokeColor, strokeWidth) {
  const r = radius;
  context.beginPath();
  context.moveTo(x, y - r * 1.6);
  context.bezierCurveTo(x + r, y - r * 0.2, x + r * 0.6, y + r, x, y + r * 1.8);
  context.bezierCurveTo(x - r * 0.6, y + r, x - r, y - r * 0.2, x, y - r * 1.6);
  context.closePath();
  context.fillStyle = color;
  context.fill();
  if (strokeColor && strokeWidth > 0) {
    context.strokeStyle = strokeColor;
    context.lineWidth = strokeWidth;
    context.stroke();
  }
}

function drawPointDiamond(context, x, y, radius, color, strokeColor, strokeWidth) {
  context.beginPath();
  context.moveTo(x, y - radius);
  context.lineTo(x + radius, y);
  context.lineTo(x, y + radius);
  context.lineTo(x - radius, y);
  context.closePath();
  context.fillStyle = color;
  context.fill();
  if (strokeColor && strokeWidth > 0) {
    context.strokeStyle = strokeColor;
    context.lineWidth = strokeWidth;
    context.stroke();
  }
}

function drawOverlayPoint(state, context, point, index, pointDrawer) {
  const canvasPoint = toCanvasPoint(state, point.projected);
  const radius = Math.max(1, point.radius);
  const useCustom = point.renderType === "custom" && typeof pointDrawer === "function";

  if (useCustom) {
    pointDrawer(context, {
      state,
      point,
      index,
      x: canvasPoint.x,
      y: canvasPoint.y,
      radius,
      lng: point.lng,
      lat: point.lat
    });
    return;
  }

  if (point.renderType === "pin") {
    drawPointPin(context, canvasPoint.x, canvasPoint.y, radius, point.color, point.strokeColor, point.strokeWidth);
    return;
  }

  if (point.renderType === "diamond") {
    drawPointDiamond(context, canvasPoint.x, canvasPoint.y, radius, point.color, point.strokeColor, point.strokeWidth);
    return;
  }

  context.beginPath();
  context.arc(canvasPoint.x, canvasPoint.y, radius, 0, Math.PI * 2);
  context.fillStyle = point.color;
  context.fill();
  if (point.strokeColor && point.strokeWidth > 0) {
    context.strokeStyle = point.strokeColor;
    context.lineWidth = point.strokeWidth;
    context.stroke();
  }
}

function getTouchPoint(touch) {
  if (!touch) {
    return { x: 0, y: 0 };
  }
  return {
    x: Number(touch.x !== undefined ? touch.x : touch.clientX || 0),
    y: Number(touch.y !== undefined ? touch.y : touch.clientY || 0)
  };
}

function getTouchDistance(touches) {
  const first = getTouchPoint(touches[0]);
  const second = getTouchPoint(touches[1]);
  const diffX = first.x - second.x;
  const diffY = first.y - second.y;
  return Math.sqrt(diffX * diffX + diffY * diffY);
}

function getTouchCenter(touches) {
  const first = getTouchPoint(touches[0]);
  const second = getTouchPoint(touches[1]);
  return {
    x: (first.x + second.x) / 2,
    y: (first.y + second.y) / 2
  };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeBackground(value) {
  if (value === null || value === undefined) {
    return "";
  }
  return String(value).trim();
}

function isTransparentBackground(value) {
  const normalized = normalizeBackground(value).toLowerCase();
  return (
    !normalized ||
    normalized === "transparent" ||
    normalized === "none" ||
    normalized === "rgba(0,0,0,0)" ||
    normalized === "rgba(0, 0, 0, 0)"
  );
}

function isGradientBackground(value) {
  return /gradient\s*\(/i.test(normalizeBackground(value));
}

function resolveBackgroundConfig(containerBackground, backgroundColor) {
  const containerBg = normalizeBackground(containerBackground);
  const canvasBg = normalizeBackground(backgroundColor);
  const activeContainerBg = containerBg || canvasBg;
  const containerStyle = activeContainerBg && !isTransparentBackground(activeContainerBg)
    ? `background:${activeContainerBg}`
    : "background:transparent";

  let paintCanvasBg = false;
  let canvasFillColor = canvasBg;

  if (containerBg) {
    paintCanvasBg = !isTransparentBackground(containerBg) && !isGradientBackground(containerBg);
    if (paintCanvasBg) {
      canvasFillColor = containerBg;
    }
  } else if (!isTransparentBackground(canvasBg) && !isGradientBackground(canvasBg)) {
    paintCanvasBg = true;
    canvasFillColor = canvasBg;
  }

  return {
    containerStyle,
    paintCanvasBg,
    canvasFillColor
  };
}

function getMapZoomLimits(zoomLimits) {
  let min = zoomLimits && zoomLimits.min !== undefined ? zoomLimits.min : MAP_ZOOM_MIN;
  let max = zoomLimits && zoomLimits.max !== undefined ? zoomLimits.max : MAP_ZOOM_MAX;
  min = clamp(Math.round(min), MAP_ZOOM_MIN, MAP_ZOOM_MAX);
  max = clamp(Math.round(max), MAP_ZOOM_MIN, MAP_ZOOM_MAX);
  if (min > max) {
    const swap = min;
    min = max;
    max = swap;
  }
  return { min, max };
}

function computeFitMapZoom(state, bounds, zoomLimits) {
  const limits = getMapZoomLimits(zoomLimits);
  const mapSize = getMapSize(state.currentProjection);
  const contentWidth = Math.max(bounds.width * mapSize.width, 1);
  const contentHeight = Math.max(bounds.height * mapSize.height, 1);
  const fitScale =
    Math.min(state.canvasWidth / contentWidth, state.canvasHeight / contentHeight) * FIT_PADDING_RATIO;
  const pixelScale = Math.max(mapSize.width * fitScale, 1);
  let zoom = Math.round(Math.log2(pixelScale / TILE_SIZE));
  if (!Number.isFinite(zoom)) {
    zoom = limits.min;
  }
  return clamp(zoom, limits.min, limits.max);
}

function getMapViewScaleForZoom(state, mapZoom) {
  return Math.pow(2, mapZoom - state.baseMapZoom);
}

function getMapZoomFromViewScale(state) {
  const scale = Math.max(state.mapView.scale || 1, 0.0001);
  const zoom = state.baseMapZoom + Math.log2(scale);
  return zoom;
}

function getScaleRangeForLimits(state, limits) {
  return {
    min: getMapViewScaleForZoom(state, limits.min),
    max: getMapViewScaleForZoom(state, limits.max)
  };
}

function getScreenViewTransform(state) {
  const mapSize = getMapSize(state.currentProjection);
  const mapScale = Math.max(state.mapView.scale || 1, 0.0001);
  return {
    tx: state.baseView.offsetX + state.mapView.offsetX,
    ty: state.baseView.offsetY + state.mapView.offsetY,
    sx: mapSize.width * state.baseView.scale * mapScale,
    sy: mapSize.height * state.baseView.scale * mapScale,
    mapScale
  };
}

/** 以屏幕坐标 anchor 为焦点缩放（保持锚点下地理内容不动） */
function applyScaleAtAnchor(state, nextScale, anchor) {
  const anchorPoint = anchor || {
    x: state.canvasWidth / 2,
    y: state.canvasHeight / 2
  };
  const view = getScreenViewTransform(state);
  const ratio = nextScale / view.mapScale;
  const nx = (anchorPoint.x - view.tx) / view.sx;
  const ny = (anchorPoint.y - view.ty) / view.sy;
  const mapSize = getMapSize(state.currentProjection);
  const sxNew = mapSize.width * state.baseView.scale * nextScale;
  const syNew = mapSize.height * state.baseView.scale * nextScale;
  const txNew = anchorPoint.x - nx * sxNew;
  const tyNew = anchorPoint.y - ny * syNew;

  state.mapView.scale = nextScale;
  state.mapView.offsetX = txNew - state.baseView.offsetX;
  state.mapView.offsetY = tyNew - state.baseView.offsetY;
}

function computeViewAtZoom(state, mapZoom, anchor) {
  const scale = getMapViewScaleForZoom(state, mapZoom);
  const anchorPoint = anchor || {
    x: state.canvasWidth / 2,
    y: state.canvasHeight / 2
  };
  const view = getScreenViewTransform(state);
  const ratio = scale / view.mapScale;
  const nx = (anchorPoint.x - view.tx) / view.sx;
  const ny = (anchorPoint.y - view.ty) / view.sy;
  const mapSize = getMapSize(state.currentProjection);
  const sxNew = mapSize.width * state.baseView.scale * scale;
  const syNew = mapSize.height * state.baseView.scale * scale;
  return {
    mapZoom,
    scale,
    offsetX: anchorPoint.x - nx * sxNew - state.baseView.offsetX,
    offsetY: anchorPoint.y - ny * syNew - state.baseView.offsetY
  };
}

/**
 * 双指连续缩放：以 lastCenter 对应地图点为基准，缩放后该点落在 center 下（与高德一致）
 */
function applyPinchGesture(state, lastCenter, center, scaleFactor, limits) {
  if (!state || !center) {
    return;
  }
  const focal = lastCenter || center;
  const view = getScreenViewTransform(state);
  const nx = (focal.x - view.tx) / view.sx;
  const ny = (focal.y - view.ty) / view.sy;
  const range = getScaleRangeForLimits(state, limits);
  const nextScale =
    scaleFactor && scaleFactor !== 1
      ? clamp(view.mapScale * scaleFactor, range.min, range.max)
      : view.mapScale;
  const mapSize = getMapSize(state.currentProjection);
  const sxNew = mapSize.width * state.baseView.scale * nextScale;
  const syNew = mapSize.height * state.baseView.scale * nextScale;
  const txNew = center.x - nx * sxNew;
  const tyNew = center.y - ny * syNew;

  state.mapView.scale = nextScale;
  state.mapView.offsetX = txNew - state.baseView.offsetX;
  state.mapView.offsetY = tyNew - state.baseView.offsetY;
}

function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

function runViewAnimation(state, component, from, to, duration, onComplete, easing) {
  cancelViewAnimation(state);
  if (!duration || duration <= 0) {
    state.mapView.offsetX = to.offsetX;
    state.mapView.offsetY = to.offsetY;
    state.mapView.scale = to.scale;
    if (to.mapZoom !== undefined) {
      state.mapZoom = to.mapZoom;
    }
    state.viewAnimating = false;
    state.animTileZoom = null;
    if (onComplete) {
      onComplete();
    }
    return;
  }

  state.viewAnimating = true;
  state.animTileZoom = to.mapZoom !== undefined ? to.mapZoom : state.mapZoom;
  state._tileAnimRequestAt = 0;
  const startTime = Date.now();
  component.scheduleTileRequests(true);

  const step = () => {
    const progress = clamp((Date.now() - startTime) / duration, 0, 1);
    const eased = easing === "out" ? easeOutCubic(progress) : easeInOutCubic(progress);
    state.mapView.offsetX = from.offsetX + (to.offsetX - from.offsetX) * eased;
    state.mapView.offsetY = from.offsetY + (to.offsetY - from.offsetY) * eased;
    state.mapView.scale = from.scale + (to.scale - from.scale) * eased;
    const now = Date.now();
    if (now - (state._tileAnimRequestAt || 0) > 140) {
      state._tileAnimRequestAt = now;
      component.scheduleTileRequests(true);
    }
    component.scheduleDraw();

    if (progress < 1) {
      state.viewAnimationTimer = requestFrame(step);
    } else {
      state.viewAnimationTimer = null;
      state.mapView.offsetX = to.offsetX;
      state.mapView.offsetY = to.offsetY;
      state.mapView.scale = to.scale;
      if (to.mapZoom !== undefined) {
        state.mapZoom = to.mapZoom;
      }
      state.viewAnimating = false;
      state.animTileZoom = null;
      if (onComplete) {
        onComplete();
      }
    }
  };

  state.viewAnimationTimer = requestFrame(step);
}

function easeInOutCubic(t) {
  if (t < 0.5) {
    return 4 * t * t * t;
  }
  return 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function cancelViewAnimation(state) {
  if (!state) {
    return;
  }
  if (state.viewAnimationTimer) {
    cancelFrame(state.viewAnimationTimer);
    state.viewAnimationTimer = null;
  }
  state.viewAnimating = false;
  state.animTileZoom = null;
}

function dataUrlToTempFile(dataUrl, fileType) {
  const ext = fileType === "jpg" || fileType === "jpeg" ? "jpg" : "png";
  const base64 = String(dataUrl).replace(/^data:image\/\w+;base64,/, "");
  const filePath = `${wx.env.USER_DATA_PATH}/canvas-map-export-${Date.now()}.${ext}`;
  return new Promise((resolve, reject) => {
    wx.getFileSystemManager().writeFile({
      filePath,
      data: base64,
      encoding: "base64",
      success: () => resolve({ tempFilePath: filePath }),
      fail: reject
    });
  });
}

function normalizeLngLat(input) {
  if (!input || typeof input !== "object") {
    return null;
  }
  if (Array.isArray(input)) {
    if (input.length < 2 || typeof input[0] !== "number") {
      return null;
    }
    return { lng: input[0], lat: input[1] };
  }
  const lng = input.lng !== undefined ? input.lng : input.lon !== undefined ? input.lon : input.longitude;
  const lat = input.lat !== undefined ? input.lat : input.latitude;
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
    return null;
  }
  return { lng, lat };
}

function normalizeCoordinateList(input) {
  if (input === null || input === undefined) {
    return [];
  }

  const single = normalizeLngLat(input);
  if (single) {
    return [single];
  }

  if (!Array.isArray(input)) {
    return [];
  }

  if (input.length >= 2 && typeof input[0] === "number") {
    const point = normalizeLngLat(input);
    return point ? [point] : [];
  }

  const result = [];
  input.forEach((item) => {
    const point = normalizeLngLat(item);
    if (point) {
      result.push(point);
      return;
    }
    if (Array.isArray(item)) {
      result.push(...normalizeCoordinateList(item));
    }
  });
  return result;
}

function getProjectedBoundsFromCoords(coords, projection, paddingRatio) {
  if (!coords.length) {
    return null;
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  coords.forEach((coord) => {
    const projected = projectPoint(coord.lng, coord.lat, projection);
    minX = Math.min(minX, projected.x);
    minY = Math.min(minY, projected.y);
    maxX = Math.max(maxX, projected.x);
    maxY = Math.max(maxY, projected.y);
  });

  if (!Number.isFinite(minX)) {
    return null;
  }

  const width = Math.max(maxX - minX, 0.000001);
  const height = Math.max(maxY - minY, 0.000001);
  const padX = width * (paddingRatio || 0);
  const padY = height * (paddingRatio || 0);

  return {
    minX: clamp(minX - padX, 0, 1),
    minY: clamp(minY - padY, 0, 1),
    maxX: clamp(maxX + padX, 0, 1),
    maxY: clamp(maxY + padY, 0, 1),
    width: Math.min(1, width + padX * 2),
    height: Math.min(1, height + padY * 2)
  };
}

function computeViewTarget(state, projectedBounds, options, limits) {
  const mapSize = getMapSize(state.currentProjection);
  const opts = options || {};
  const padding = opts.padding !== undefined ? opts.padding : DEFAULT_FLY_PADDING;
  let mapZoom;

  if (opts.zoom !== undefined && opts.zoom !== null && opts.zoom > 0) {
    mapZoom = clamp(Math.round(opts.zoom), limits.min, limits.max);
  } else if (projectedBounds.width <= 0.00001 && projectedBounds.height <= 0.00001) {
    mapZoom = clamp(
      state.mapZoom !== undefined ? state.mapZoom : DEFAULT_FLY_ZOOM,
      limits.min,
      limits.max
    );
  } else {
    const padX = projectedBounds.width * padding;
    const padY = projectedBounds.height * padding;
    const paddedBounds = {
      minX: clamp(projectedBounds.minX - padX, 0, 1),
      minY: clamp(projectedBounds.minY - padY, 0, 1),
      maxX: clamp(projectedBounds.maxX + padX, 0, 1),
      maxY: clamp(projectedBounds.maxY + padY, 0, 1)
    };
    paddedBounds.width = Math.max(paddedBounds.maxX - paddedBounds.minX, 0.000001);
    paddedBounds.height = Math.max(paddedBounds.maxY - paddedBounds.minY, 0.000001);
    mapZoom = computeFitMapZoom(state, paddedBounds, limits);
  }

  const scale = getMapViewScaleForZoom(state, mapZoom);
  const centerX = (projectedBounds.minX + projectedBounds.maxX) / 2;
  const centerY = (projectedBounds.minY + projectedBounds.maxY) / 2;

  return {
    mapZoom,
    scale,
    offsetX:
      state.canvasWidth / 2 -
      state.baseView.offsetX -
      centerX * mapSize.width * state.baseView.scale * scale,
    offsetY:
      state.canvasHeight / 2 -
      state.baseView.offsetY -
      centerY * mapSize.height * state.baseView.scale * scale,
    centerX,
    centerY
  };
}

function resetView(state, zoomLimits, preferredZoom) {
  if (!state.canvasWidth || !state.canvasHeight) {
    return;
  }

  const limits = getMapZoomLimits(zoomLimits);
  const mapSize = getMapSize(state.currentProjection);
  const bounds = state.contentBounds || getPathsBounds(state.mapPaths);
  const contentWidth = Math.max(bounds.width * mapSize.width, 1);
  const contentHeight = Math.max(bounds.height * mapSize.height, 1);
  const scale =
    Math.min(state.canvasWidth / contentWidth, state.canvasHeight / contentHeight) * FIT_PADDING_RATIO;

  state.baseView.scale = scale;
  state.baseView.offsetX =
    (state.canvasWidth - bounds.width * mapSize.width * scale) / 2 - bounds.minX * mapSize.width * scale;
  state.baseView.offsetY =
    (state.canvasHeight - bounds.height * mapSize.height * scale) / 2 - bounds.minY * mapSize.height * scale;

  const fitZoom = computeFitMapZoom(state, bounds, limits);
  let mapZoom = fitZoom;
  if (preferredZoom !== undefined && preferredZoom !== null && preferredZoom > 0) {
    mapZoom = clamp(Math.round(preferredZoom), limits.min, limits.max);
  }

  state.baseMapZoom = fitZoom;
  state.mapZoom = mapZoom;
  state.mapView = {
    scale: getMapViewScaleForZoom(state, mapZoom),
    offsetX: 0,
    offsetY: 0
  };
}

function toCanvasPoint(state, point) {
  const mapSize = getMapSize(state.currentProjection);
  return {
    x: state.baseView.offsetX + state.mapView.offsetX + point.x * mapSize.width * state.baseView.scale * state.mapView.scale,
    y: state.baseView.offsetY + state.mapView.offsetY + point.y * mapSize.height * state.baseView.scale * state.mapView.scale
  };
}

function isRingVisible(state, ring) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (let index = 0; index < ring.length; index += 1) {
    const point = toCanvasPoint(state, ring[index]);
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }

  return maxX >= -20 && maxY >= -20 && minX <= state.canvasWidth + 20 && minY <= state.canvasHeight + 20;
}

function drawRing(state, context, ring) {
  if (!ring || ring.length < 2 || !isRingVisible(state, ring)) {
    return false;
  }

  for (let index = 0; index < ring.length; index += 1) {
    const point = toCanvasPoint(state, ring[index]);
    if (index === 0) {
      context.moveTo(point.x, point.y);
    } else {
      context.lineTo(point.x, point.y);
    }
  }
  context.closePath();
  return true;
}

function resolveTileIndices(scheme, z, x, y) {
  const tileZ = Math.max(0, Math.floor(z));
  const tileX = Math.floor(x);
  const tileY = Math.floor(y);
  const n = Math.pow(2, tileZ);

  if (scheme === "tms" || scheme === "baidu") {
    return { z: tileZ, x: tileX, y: Math.max(0, n - 1 - tileY) };
  }

  return { z: tileZ, x: tileX, y: tileY };
}

function formatTileUrl(template, z, x, y, options) {
  const config = options || {};
  const resolved = resolveTileIndices(config.scheme || "xyz", z, x, y);
  const reverseY = Math.pow(2, resolved.z) - 1 - resolved.y;
  const subdomains = String(config.subdomains !== undefined ? config.subdomains : "0123");
  const subdomain = subdomains ? subdomains[(resolved.x + resolved.y) % subdomains.length] : "0";
  const token = config.token || "";

  return String(template || DEFAULT_TILE_URL)
    .replace(/\{z\}/gi, String(resolved.z))
    .replace(/\{x\}/gi, String(resolved.x))
    .replace(/\{y\}/gi, String(resolved.y))
    .replace(/\{reverseY\}/gi, String(reverseY))
    .replace(/\{s\}/gi, subdomain)
    .replace(/\{tk\}/gi, token)
    .replace(/\{token\}/gi, token);
}

function getMapScale(state) {
  const mapSize = getMapSize(state.currentProjection);
  return {
    scaleX: mapSize.width * state.baseView.scale * state.mapView.scale,
    scaleY: mapSize.height * state.baseView.scale * state.mapView.scale
  };
}

function longitudeToTileX(lon, z) {
  const n = Math.pow(2, z);
  return clamp(Math.floor(((lon + 180) / 360) * n), 0, n - 1);
}

function latitudeToTileY(lat, z) {
  const n = Math.pow(2, z);
  const latRad = (clamp(lat, -MERCATOR_MAX_LAT, MERCATOR_MAX_LAT) * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
  return clamp(Math.floor(y), 0, n - 1);
}

function latitudeFromTileY(tileY, z) {
  const n = Math.pow(2, z);
  const latRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * tileY) / n)));
  return (latRad * 180) / Math.PI;
}

function getNormalizedViewport(state) {
  const { scaleX, scaleY } = getMapScale(state);
  return {
    scaleX,
    scaleY,
    normMinX: (-state.mapView.offsetX - state.baseView.offsetX) / scaleX,
    normMaxX: (state.canvasWidth - state.mapView.offsetX - state.baseView.offsetX) / scaleX,
    normMinY: (-state.mapView.offsetY - state.baseView.offsetY) / scaleY,
    normMaxY: (state.canvasHeight - state.mapView.offsetY - state.baseView.offsetY) / scaleY
  };
}

function getTileZoom(state, tileMinZoom, tileMaxZoom) {
  if (state.pinchActive && state.tileZoomLock !== undefined && state.tileZoomLock !== null) {
    return clamp(Math.round(state.tileZoomLock), tileMinZoom, tileMaxZoom);
  }
  if (state.viewAnimating && state.animTileZoom !== undefined && state.animTileZoom !== null) {
    return clamp(Math.round(state.animTileZoom), tileMinZoom, tileMaxZoom);
  }
  const z = state.mapZoom !== undefined ? state.mapZoom : state.baseMapZoom || MAP_ZOOM_MIN;
  return clamp(Math.round(z), tileMinZoom, tileMaxZoom);
}

function tilePow2(z) {
  return z >= 0 && z < 31 ? 1 << z : Math.pow(2, z);
}

function getViewTileSignature(state, tileMinZoom, tileMaxZoom) {
  const z = getTileZoom(state, tileMinZoom, tileMaxZoom);
  return [
    z,
    Math.round(state.mapView.offsetX * 10) / 10,
    Math.round(state.mapView.offsetY * 10) / 10,
    Math.round((state.mapView.scale || 1) * 1000) / 1000,
    state.currentProjection
  ].join("|");
}

function getVisibleTiles(state, tileMinZoom, tileMaxZoom) {
  const z = getTileZoom(state, tileMinZoom, tileMaxZoom);
  const n = tilePow2(z);
  const { normMinX, normMaxX, normMinY, normMaxY } = getNormalizedViewport(state);
  let minTx;
  let maxTx;
  let minTy;
  let maxTy;

  if (state.currentProjection === PROJECTION.EQUIRECTANGULAR) {
    const lonMin = normMinX * 360 - 180;
    const lonMax = normMaxX * 360 - 180;
    const latNorth = 90 - normMinY * 180;
    const latSouth = 90 - normMaxY * 180;
    minTx = longitudeToTileX(Math.min(lonMin, lonMax), z);
    maxTx = longitudeToTileX(Math.max(lonMin, lonMax), z);
    minTy = latitudeToTileY(Math.max(latNorth, latSouth), z);
    maxTy = latitudeToTileY(Math.min(latNorth, latSouth), z);
  } else {
    minTx = clamp(Math.floor(normMinX * n), 0, n - 1);
    maxTx = clamp(Math.min(n - 1, Math.ceil(normMaxX * n) - 1), 0, n - 1);
    minTy = clamp(Math.floor(normMinY * n), 0, n - 1);
    maxTy = clamp(Math.min(n - 1, Math.ceil(normMaxY * n) - 1), 0, n - 1);
  }

  const tiles = [];
  for (let ty = minTy; ty <= maxTy; ty += 1) {
    for (let tx = minTx; tx <= maxTx; tx += 1) {
      tiles.push({ z, x: tx, y: ty });
    }
  }

  state.currentTileZoom = z;
  return perf.capTileList(tiles, MAX_VISIBLE_TILES);
}

function markViewChanged(state) {
  const sig = perf.getViewSignature(state);
  if (state.viewSignature === sig) {
    return false;
  }
  state.viewSignature = sig;
  invalidateVisibleTileCache(state);
  state.tilesDirty = true;
  return true;
}

function refreshTilesAfterViewChange(component) {
  const state = component._state;
  if (!state || !getTileConfig(component).enabled) {
    return;
  }
  invalidateVisibleTileCache(state);
  state.tilesDirty = true;
  component.scheduleTileRequests(true);
}

function getVisibleTilesCached(state, tileMinZoom, tileMaxZoom) {
  const signature = getViewTileSignature(state, tileMinZoom, tileMaxZoom);
  if (state.frameTiles && state.frameTileSignature === signature) {
    return state.frameTiles;
  }
  const tiles = getVisibleTiles(state, tileMinZoom, tileMaxZoom);
  state.frameTiles = tiles;
  state.frameTileSignature = signature;
  return tiles;
}

function invalidateVisibleTileCache(state) {
  state.frameTiles = null;
  state.frameTileSignature = "";
}

function shouldRetainTileCache(state) {
  return !!(state.interacting || state.pinchActive || state.viewAnimating);
}

function touchTileCacheKey(state, key) {
  const idx = state.tileCacheKeys.indexOf(key);
  if (idx < 0) {
    return;
  }
  state.tileCacheKeys.splice(idx, 1);
  state.tileCacheKeys.push(key);
}

function getTileAncestorTiles(tiles, minZ, depth) {
  const extra = [];
  const seen = new Set();
  (tiles || []).forEach((tile) => {
    let x = tile.x;
    let y = tile.y;
    let z = tile.z;
    for (let d = 0; d < depth; d += 1) {
      if (z <= minZ) {
        break;
      }
      z -= 1;
      x = Math.floor(x / 2);
      y = Math.floor(y / 2);
      const dedupe = `${z}/${x}/${y}`;
      if (seen.has(dedupe)) {
        break;
      }
      seen.add(dedupe);
      extra.push({ z, x, y });
    }
  });
  return extra;
}

function pruneTileCacheToVisible(state, tileConfig, visibleTiles) {
  if (!visibleTiles.length || shouldRetainTileCache(state)) {
    return;
  }
  const currentZ = visibleTiles[0].z;
  const visibleKeys = new Set(visibleTiles.map((tile) => getTileCacheKey(tileConfig, tile)));
  const nextKeys = [];
  state.tileCacheKeys.forEach((key) => {
    if (visibleKeys.has(key)) {
      nextKeys.push(key);
      return;
    }
    const parts = key.split("/");
    const keyZ = Number(parts[3]);
    if (!Number.isFinite(keyZ) || keyZ !== currentZ) {
      nextKeys.push(key);
      return;
    }
    const cached = state.tileCache[key];
    if (cached && cached.status === "loaded" && state.tileCacheKeys.length < MAX_TILE_CACHE) {
      nextKeys.push(key);
      return;
    }
    if (state.tileCacheKeys.length > MAX_TILE_CACHE * 0.92) {
      delete state.tileCache[key];
    } else {
      nextKeys.push(key);
    }
  });
  state.tileCacheKeys = nextKeys;
  trimTileCache(state);
}

function trimTileCache(state) {
  while (state.tileCacheKeys.length > MAX_TILE_CACHE) {
    const removeKey = state.tileCacheKeys.shift();
    if (removeKey && state.tileCache[removeKey]) {
      delete state.tileCache[removeKey];
    }
  }
}

function setTileCacheEntry(state, key, entry) {
  touchTileCacheKey(state, key);
  if (state.tileCacheKeys.indexOf(key) < 0) {
    state.tileCacheKeys.push(key);
  }
  state.tileCache[key] = entry;
  trimTileCache(state);
}

function getTileCacheKey(tileConfig, tile) {
  return `${tileConfig.projection || "mercator"}/${tileConfig.providerId || "custom"}/${tileConfig.scheme}/${tile.z}/${tile.x}/${tile.y}`;
}

function loadMapTile(state, component, tile, tileConfig) {
  const key = getTileCacheKey(tileConfig, tile);
  tile.key = key;
  const cached = state.tileCache[key];
  if (cached && (cached.status === "loading" || cached.status === "loaded")) {
    touchTileCacheKey(state, key);
    return;
  }

  if (!state.canvasNode || typeof state.canvasNode.createImage !== "function") {
    return;
  }

  if (tileConfig.requiresToken && !tileConfig.token) {
    setTileCacheEntry(state, key, { status: "error", image: null, url: "", error: "missing_token" });
    return;
  }

  setTileCacheEntry(state, key, { status: "loading", image: null, url: "" });
  const image = state.canvasNode.createImage();
  const url = formatTileUrl(tileConfig.url, tile.z, tile.x, tile.y, tileConfig);

  image.onload = () => {
    setTileCacheEntry(state, key, { status: "loaded", image, url });
    component.scheduleTileRedraw();
    component.updateTileLoadingState();
  };
  image.onerror = () => {
    setTileCacheEntry(state, key, { status: "error", image: null, url });
    component.updateTileLoadingState();
  };
  image.src = url;
}

function processTileLoadQueue(state, component) {
  if (!state.tileLoadQueue.length) {
    state.tileQueueProcessing = false;
    return;
  }
  if (state.tileQueueProcessing) {
    return;
  }
  state.tileQueueProcessing = true;

  const step = () => {
    let loaded = 0;
    while (state.tileLoadQueue.length && loaded < MAX_TILE_LOADS_PER_FRAME) {
      const item = state.tileLoadQueue.shift();
      loadMapTile(state, component, item.tile, item.tileConfig);
      loaded += 1;
    }
    component.updateTileLoadingState();
    if (state.tileLoadQueue.length) {
      state.tileQueueTimer = requestFrame(step);
    } else {
      state.tileQueueProcessing = false;
      state.tileQueueTimer = null;
    }
  };

  step();
}

function enqueueTileLoads(state, component, tileConfig, tiles) {
  if (!state.tileLoadQueue) {
    state.tileLoadQueue = [];
  }
  const queuedKeys = new Set(state.tileLoadQueue.map((item) => item.key));
  const ancestors = getTileAncestorTiles(tiles, tileConfig.minZoom, 2);
  const loadTiles = ancestors.concat(tiles);

  loadTiles.forEach((tile) => {
    const key = getTileCacheKey(tileConfig, tile);
    tile.key = key;
    const cached = state.tileCache[key];
    if (cached && (cached.status === "loading" || cached.status === "loaded")) {
      touchTileCacheKey(state, key);
      return;
    }
    if (queuedKeys.has(key)) {
      return;
    }
    state.tileLoadQueue.push({ tile, tileConfig, key });
    queuedKeys.add(key);
  });

  processTileLoadQueue(state, component);
}

function requestVisibleTiles(state, component, tileConfig, options) {
  const opts = options || {};
  const tiles = getVisibleTilesCached(state, tileConfig.minZoom, tileConfig.maxZoom);
  if (!opts.skipPrune) {
    pruneTileCacheToVisible(state, tileConfig, tiles);
  }
  enqueueTileLoads(state, component, tileConfig, tiles);
  return tiles.length;
}

function countPendingTiles(state, tileConfig) {
  let pending = state.tileLoadQueue ? state.tileLoadQueue.length : 0;
  const tiles = getVisibleTilesCached(state, tileConfig.minZoom, tileConfig.maxZoom);
  tiles.forEach((tile) => {
    const key = getTileCacheKey(tileConfig, tile);
    const cached = state.tileCache[key];
    if (!cached || cached.status === "loading") {
      pending += 1;
    }
  });
  return pending;
}

function waitForVisibleTiles(component, tileConfig, timeoutMs) {
  const state = component._state;
  if (!state || !tileConfig.enabled) {
    return Promise.resolve();
  }

  requestVisibleTiles(state, component, tileConfig);
  const deadline = Date.now() + (timeoutMs || TILE_EXPORT_WAIT_MS);

  return new Promise((resolve) => {
    const tick = () => {
      component.updateTileLoadingState();
      if (countPendingTiles(state, tileConfig) === 0 || Date.now() >= deadline) {
        component.drawMap();
        resolve();
        return;
      }
      setTimeout(tick, 80);
    };
    tick();
  });
}

function drawTileOnCanvasMercator(state, context, image, tile) {
  const n = tilePow2(tile.z);
  const topLeft = toCanvasPoint(state, { x: tile.x / n, y: tile.y / n });
  const bottomRight = toCanvasPoint(state, { x: (tile.x + 1) / n, y: (tile.y + 1) / n });
  const width = bottomRight.x - topLeft.x;
  const height = bottomRight.y - topLeft.y;
  if (width <= 0 || height <= 0) {
    return;
  }
  context.drawImage(image, topLeft.x, topLeft.y, width, height);
}

function drawTileOnCanvasEquirectangular(state, context, image, tile) {
  const n = tilePow2(tile.z);
  const lonWest = (tile.x / n) * 360 - 180;
  const lonEast = ((tile.x + 1) / n) * 360 - 180;
  const stripCount = perf.getEquirectangularStripCount(state.mapZoom);

  for (let index = 0; index < stripCount; index += 1) {
    const srcY = Math.floor((index / stripCount) * TILE_SIZE);
    const srcHeight = Math.max(1, Math.ceil(TILE_SIZE / stripCount));
    const tileYNorth = tile.y + index / stripCount;
    const tileYSouth = tile.y + (index + 1) / stripCount;
    const latNorth = latitudeFromTileY(tileYNorth, tile.z);
    const latSouth = latitudeFromTileY(tileYSouth, tile.z);
    const topLeft = toCanvasPoint(state, projectEquirectangular(lonWest, latNorth));
    const bottomRight = toCanvasPoint(state, projectEquirectangular(lonEast, latSouth));
    const width = bottomRight.x - topLeft.x;
    const height = bottomRight.y - topLeft.y;
    if (width <= 0 || height <= 0) {
      continue;
    }
    context.drawImage(image, 0, srcY, TILE_SIZE, srcHeight, topLeft.x, topLeft.y, width, height);
  }
}

function drawTileOnCanvas(state, context, image, tile) {
  if (state.currentProjection === PROJECTION.EQUIRECTANGULAR) {
    drawTileOnCanvasEquirectangular(state, context, image, tile);
    return;
  }
  drawTileOnCanvasMercator(state, context, image, tile);
}

function drawCachedEquirectangularTiles(state, context, tileConfig, tileZ, padRatio) {
  const prefix = `${tileConfig.projection || "mercator"}/${tileConfig.providerId || "custom"}/${tileConfig.scheme}/${tileZ}/`;
  const vp = perf.getViewportNormBounds(state, padRatio);
  let drawn = 0;
  const keys = state.tileCacheKeys || [];
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    if (!key.startsWith(prefix)) {
      continue;
    }
    const cached = state.tileCache[key];
    if (!cached || cached.status !== "loaded" || !cached.image) {
      continue;
    }
    const parts = key.split("/");
    const tile = { z: tileZ, x: Number(parts[4]), y: Number(parts[5]) };
    if (!Number.isFinite(tile.x) || !Number.isFinite(tile.y)) {
      continue;
    }
    const n = 1 / perf.tilePow2(tileZ);
    const minX = tile.x * n;
    const minY = tile.y * n;
    if (!perf.bboxIntersectsNorm({ minX, minY, maxX: minX + n, maxY: minY + n }, vp)) {
      continue;
    }
    drawTileOnCanvasEquirectangular(state, context, cached.image, tile);
    drawn += 1;
  }
  return drawn;
}

function drawMapTiles(state, context, tileConfig) {
  if (!tileConfig.enabled) {
    return 0;
  }

  const tileZ = getTileZoom(state, tileConfig.minZoom, tileConfig.maxZoom);
  const interacting = !!(state.interacting || state.pinchActive || state.viewAnimating);
  const pad = interacting ? 0.55 : 0.15;

  if (state.currentProjection !== PROJECTION.EQUIRECTANGULAR) {
    const drawList = perf.buildMercatorTileDrawList(state, tileZ, tileConfig, state.tileCache, {
      interacting
    });
    context.save();
    perf.applyViewTransform(context, state);
    perf.drawMercatorTileList(context, drawList);
    context.restore();
    return drawList.list.length;
  }

  context.save();
  context.globalAlpha = clamp(tileConfig.opacity, 0, 1);
  const drawn = drawCachedEquirectangularTiles(state, context, tileConfig, tileZ, pad);
  context.restore();
  return drawn;
}

function clearTileCache(state) {
  state.tileCache = {};
  state.tileCacheKeys = [];
  state.currentTileZoom = 0;
  state.tileLoadQueue = [];
  state.tileQueueProcessing = false;
  if (state.tileQueueTimer) {
    cancelFrame(state.tileQueueTimer);
    state.tileQueueTimer = null;
  }
  invalidateVisibleTileCache(state);
}

function clearTileTimers(state) {
  if (state.tilePanDebounceTimer) {
    clearTimeout(state.tilePanDebounceTimer);
    state.tilePanDebounceTimer = null;
  }
}

function applyTilesChange(component) {
  const state = component._state;
  if (!state) {
    return;
  }
  clearTileCache(state);
  invalidateVisibleTileCache(state);
  state.tilesDirty = true;
  markViewChanged(state);
  component.scheduleDraw();
  if (getTileConfig(component).enabled) {
    component.scheduleTileRequests(true);
  }
}

function getTileConfig(component) {
  const properties = component.properties || {};
  const tilesParsed = parseTilesOption(properties.tiles);
  const enabled = !!(tilesParsed && tilesParsed.enabled);
  const providerId = (tilesParsed && tilesParsed.providerId) || "custom";
  const provider = getTileProvider(providerId);
  const customUrl = (tilesParsed && tilesParsed.customUrl) || "";

  let url = customUrl || DEFAULT_TILE_URL;
  let scheme = "xyz";
  let minZoom = Number(properties.tileMinZoom) || 1;
  let maxZoom = Number(properties.tileMaxZoom) || 18;
  let subdomains = "0123";
  if (properties.tileSubdomains !== undefined && properties.tileSubdomains !== null && properties.tileSubdomains !== "") {
    subdomains = properties.tileSubdomains;
  }
  let requiresToken = false;

  if (provider) {
    url = provider.url;
    scheme = provider.scheme || "xyz";
    minZoom = provider.minZoom !== undefined ? provider.minZoom : minZoom;
    maxZoom = provider.maxZoom !== undefined ? provider.maxZoom : maxZoom;
    if (provider.subdomains !== undefined) {
      subdomains = provider.subdomains;
    }
    requiresToken = !!provider.requiresToken;
  }

  if (providerId === "custom" && customUrl) {
    url = customUrl;
  }

  const state = component._state;
  const projection =
    (state && state.currentProjection) || properties.projection || PROJECTION.MERCATOR;

  return {
    enabled,
    projection,
    providerId,
    providerName: provider ? provider.name : "自定义",
    url,
    scheme,
    subdomains,
    token: properties.token || "",
    requiresToken,
    minZoom,
    maxZoom,
    opacity: Number(properties.tileOpacity !== undefined ? properties.tileOpacity : 1)
  };
}

Component({
  properties: {
    polygons: {
      type: Object,
      optionalTypes: [String],
      value: null
    },
    overlay: {
      type: Object,
      optionalTypes: [String],
      value: null
    },
    tiles: {
      type: String,
      value: ""
    },
    token: {
      type: String,
      value: ""
    },
    theme: {
      type: String,
      value: "default"
    },
    style: {
      type: Object,
      value: null
    },
    background: {
      type: null,
      value: "#f4f6f3"
    },
    tap: {
      type: Boolean,
      value: true
    },
    projection: {
      type: String,
      value: PROJECTION.MERCATOR
    },
    showStatus: {
      type: Boolean,
      value: false
    },
    showReset: {
      type: Boolean,
      value: false
    },
    flyOnSelect: {
      type: Boolean,
      value: false
    },
    minZoom: {
      type: Number,
      value: MAP_ZOOM_MIN
    },
    maxZoom: {
      type: Number,
      value: MAP_ZOOM_MAX
    },
    initialZoom: {
      type: Number,
      value: 0
    },
    zoomAnimate: {
      type: Boolean,
      value: true
    },
    zoomAnimateDuration: {
      type: Number,
      value: DEFAULT_ZOOM_ANIMATE_DURATION
    },
    hideVectorWhenTiles: {
      type: Boolean,
      value: false
    },
    tileMinZoom: {
      type: Number,
      value: 1
    },
    tileMaxZoom: {
      type: Number,
      value: 18
    },
    tileOpacity: {
      type: Number,
      value: 1
    }
  },

  data: {
    mapStatus: "地图初始化中",
    countryCount: 0,
    containerStyle: "background:#f4f6f3",
    tileLoading: false
  },

  observers: {
    "background, theme, style"() {
      this.updateBackgroundStyle();
      if (this._state) {
        this.syncMapLayers();
      }
      this.scheduleDraw();
    },
    polygons() {
      if (!this._state) {
        return;
      }
      const prevCount = this._state.featureCount || 0;
      this.syncMapLayers(false);
      this.resetViewIfPolygonsChanged(prevCount);
    },
    overlay() {
      if (!this._state) {
        return;
      }
      this.syncMapLayers(false);
    },
    "tiles, token"() {
      applyTilesChange(this);
    },
    projection(projection) {
      if (!projection || !this._state || !this._state.canvasContext) {
        return;
      }
      this.applyProjection(projection);
    },
    "hideVectorWhenTiles"() {
      if (this._state) {
        this.scheduleDraw();
      }
    }
  },

  lifetimes: {
    ready() {
      this._state = createMapState(this.properties.projection);
      this.updateBackgroundStyle();
      wx.nextTick(() => this.initMap());
    },
    detached() {
      this._overridePolygons = undefined;
      this._overrideOverlay = undefined;
      this._pointDrawer = null;
      this.cleanup();
    }
  },

  methods: {
    update(options) {
      const opts = options || {};
      const patch = {};

      if (opts.polygons !== undefined) {
        this._overridePolygons = opts.polygons;
        const prevCount = this._state.featureCount || 0;
        this.syncMapLayers(false);
        this.resetViewIfPolygonsChanged(prevCount);
      }
      if (opts.overlay !== undefined) {
        this._overrideOverlay = opts.overlay;
        this.syncMapLayers(false);
      }
      if (opts.tiles !== undefined) {
        patch.tiles = opts.tiles;
      }
      if (opts.token !== undefined) {
        patch.token = opts.token;
      }
      if (opts.projection !== undefined) {
        patch.projection = opts.projection;
      }
      if (opts.theme !== undefined) {
        patch.theme = opts.theme;
      }
      if (opts.style !== undefined) {
        patch.style = opts.style;
      }
      if (opts.background !== undefined) {
        patch.background = opts.background;
      }
      if (opts.hideVectorWhenTiles !== undefined) {
        patch.hideVectorWhenTiles = opts.hideVectorWhenTiles;
      }
      if (opts.flyOnSelect !== undefined) {
        patch.flyOnSelect = opts.flyOnSelect;
      }
      const tilesChanged = opts.tiles !== undefined || opts.token !== undefined;
      if (tilesChanged) {
        const afterPatch = () => applyTilesChange(this);
        if (Object.keys(patch).length) {
          this.setData(patch, afterPatch);
        } else {
          afterPatch();
        }
        return this;
      }
      if (Object.keys(patch).length) {
        this.setData(patch);
      }
      this.scheduleDraw();
      return this;
    },

    setPolygons(data) {
      this._overridePolygons = data;
      this.reloadMapData();
      return this.getFeatureCount();
    },

    setOverlay(data) {
      this._overrideOverlay = data;
      this.syncMapLayers(true);
      return this._state && this._state.overlayLayers;
    },

    reset() {
      const state = this._state;
      if (!state || !state.canvasContext || !state.canvasWidth || !state.canvasHeight) {
        return false;
      }
      const preferredZoom = Number(this.properties.initialZoom) || 0;
      resetView(state, this.getMapZoomLimitsFromProps(), preferredZoom > 0 ? preferredZoom : undefined);
      state.touchState = {
        mode: "",
        lastPoint: null,
        lastDistance: 0,
        lastCenter: null
      };
      markViewChanged(state);
      state.tilesDirty = true;
      this.scheduleDraw();
      if (getTileConfig(this).enabled) {
        this.scheduleTileRequests(true);
      }
      this.emitZoomChange();
      return true;
    },

    zoom(level, options) {
      const state = this._state;
      if (!state) {
        return false;
      }
      const limits = this.getMapZoomLimitsFromProps();
      const nextZoom = clamp(Math.round(level), limits.min, limits.max);
      return this.animateMapZoomTo(nextZoom, null, options);
    },

    flyTo(target, options) {
      const parsed = parseFlyTarget(target);
      if (parsed.mode === "coords") {
        return this.flyToCoordinates(parsed.coordinates, options);
      }
      if (parsed.mode === "overlay") {
        return this.fitToOverlay(options);
      }
      if (parsed.mode === "selected" || parsed.mode === "selection") {
        return this.flyToSelected(options);
      }
      if (parsed.mode === "zoom") {
        return this.animateMapZoomTo(parsed.zoom, null, options);
      }
      return false;
    },

    fit(target, options) {
      const mode = typeof target === "string" ? target.toLowerCase() : "overlay";
      if (mode === "selected" || mode === "selection") {
        return this.flyToSelected(options);
      }
      return this.fitToOverlay(options);
    },

    export(options) {
      const state = this._state;
      const opts = options || {};

      return new Promise((resolve, reject) => {
        if (!state || !state.canvasNode || !state.canvasContext) {
          const error = { errMsg: "canvas-map: map not ready" };
          this.triggerEvent("exportfail", error);
          reject(error);
          return;
        }

        cancelViewAnimation(state);
        const tileConfig = getTileConfig(this);
        const exportTask =
          opts.waitForTiles && tileConfig.enabled
            ? waitForVisibleTiles(this, tileConfig, opts.waitTimeout || TILE_EXPORT_WAIT_MS)
            : Promise.resolve().then(() => this.drawMap());

        exportTask
          .then(() => {
            const fileType = opts.fileType === "jpg" || opts.fileType === "jpeg" ? "jpg" : "png";
            const quality = opts.quality !== undefined ? clamp(Number(opts.quality), 0, 1) : 1;
            const exportPixelRatio =
              Number(opts.pixelRatio) > 0 ? Number(opts.pixelRatio) : state.canvasDpr || 2;
            const physicalWidth = state.canvasNode.width || state.canvasWidth * state.canvasDpr;
            const physicalHeight = state.canvasNode.height || state.canvasHeight * state.canvasDpr;
            const destWidth = opts.destWidth || Math.round(state.canvasWidth * exportPixelRatio);
            const destHeight = opts.destHeight || Math.round(state.canvasHeight * exportPixelRatio);

            const finish = (result) => {
              const payload = {
                tempFilePath: result.tempFilePath,
                width: destWidth,
                height: destHeight,
                fileType
              };
              this.triggerEvent("export", payload);
              resolve(payload);
            };

            const onFail = (error) => {
              const err = error || { errMsg: "canvas-map: export failed" };
              this.triggerEvent("exportfail", err);
              reject(err);
            };

            const tryDataUrl = () => {
              if (typeof state.canvasNode.toDataURL !== "function") {
                onFail({ errMsg: "canvas-map: toDataURL not supported" });
                return;
              }
              let dataUrl = "";
              try {
                dataUrl =
                  fileType === "jpg" || fileType === "jpeg"
                    ? state.canvasNode.toDataURL("image/jpeg", quality)
                    : state.canvasNode.toDataURL("image/png");
              } catch (error) {
                onFail(error);
                return;
              }
              dataUrlToTempFile(dataUrl, fileType).then(finish).catch(onFail);
            };

            if (typeof wx.canvasToTempFilePath === "function") {
              wx.canvasToTempFilePath(
                {
                  canvas: state.canvasNode,
                  x: opts.x || 0,
                  y: opts.y || 0,
                  width: opts.width || physicalWidth,
                  height: opts.height || physicalHeight,
                  destWidth,
                  destHeight,
                  fileType,
                  quality,
                  success: finish,
                  fail: (error) => {
                    if (opts.disableFallback) {
                      onFail(error);
                    } else {
                      tryDataUrl();
                    }
                  }
                },
                this
              );
            } else {
              tryDataUrl();
            }
          })
          .catch((error) => {
            const err = error || { errMsg: "canvas-map: export failed" };
            this.triggerEvent("exportfail", err);
            reject(err);
          });
      });
    },

    save(options) {
      return this.export(options).then(
        (result) =>
          new Promise((resolve, reject) => {
            wx.saveImageToPhotosAlbum({
              filePath: result.tempFilePath,
              success: () => {
                this.triggerEvent("save", result);
                resolve(result);
              },
              fail: (error) => {
                this.triggerEvent("savefail", error || {});
                reject(error || { errMsg: "saveImageToPhotosAlbum failed" });
              }
            });
          })
      );
    },

    getZoom() {
      const state = this._state;
      return state && state.mapZoom !== undefined ? state.mapZoom : null;
    },

    getView() {
      const state = this._state;
      if (!state || !state.canvasWidth) {
        return null;
      }
      const viewport = getNormalizedViewport(state);
      return {
        zoom: state.mapZoom,
        projection: state.currentProjection,
        west: viewport.normMinX * 360 - 180,
        east: viewport.normMaxX * 360 - 180,
        north: 90 - viewport.normMinY * 180,
        south: 90 - viewport.normMaxY * 180
      };
    },

    getActivePolygons() {
      if (this._overridePolygons !== undefined) {
        return this._overridePolygons;
      }
      if (!isEmptyDataSource(this.properties.polygons)) {
        return this.properties.polygons;
      }
      return null;
    },

    getFeatureCount() {
      const state = this._state;
      if (state && state.featureCount !== undefined) {
        return state.featureCount;
      }
      return getBasePolygonFeatures(this.getActivePolygons()).length;
    },

    getActiveOverlay() {
      if (this._overrideOverlay !== undefined) {
        return this._overrideOverlay;
      }
      if (!isEmptyDataSource(this.properties.overlay)) {
        return this.properties.overlay;
      }
      return null;
    },

    resetViewIfPolygonsChanged(prevCount) {
      const state = this._state;
      if (!state || !state.canvasWidth || !state.canvasHeight) {
        return;
      }
      const nextCount = state.featureCount || 0;
      if (prevCount === nextCount) {
        return;
      }
      const preferredZoom = Number(this.properties.initialZoom) || 0;
      resetView(
        state,
        this.getMapZoomLimitsFromProps(),
        preferredZoom > 0 ? preferredZoom : undefined
      );
      markViewChanged(state);
      state.tilesDirty = true;
      this.scheduleDraw();
      if (getTileConfig(this).enabled) {
        this.scheduleTileRequests(true);
      }
      this.emitZoomChange();
    },

    syncMapLayers(shouldResetView) {
      const state = this._state;
      if (!state) {
        return;
      }

      syncAllMapData(
        state,
        state.currentProjection,
        this.getActivePolygons(),
        this.getActiveOverlay(),
        getOverlayStyleDefaults(this.properties),
        this._pointDrawer
      );
      this.setData({
        countryCount: state.featureCount
      });

      if (state.canvasContext && state.canvasWidth && state.canvasHeight) {
        if (shouldResetView) {
          const preferredZoom = Number(this.properties.initialZoom) || 0;
          resetView(
            state,
            this.getMapZoomLimitsFromProps(),
            preferredZoom > 0 ? preferredZoom : undefined
          );
        }
        this.scheduleDraw();
      }
    },

    setPointDrawer(drawer) {
      this._pointDrawer = typeof drawer === "function" ? drawer : null;
      if (this._state && this._state.overlayLayers) {
        this._state.overlayLayers.pointDrawer = this._pointDrawer;
      }
      this.scheduleDraw();
      return this;
    },

    getSelected() {
      const state = this._state;
      return (state && state.selectedTarget) || null;
    },

    setSelected(target) {
      const state = this._state;
      if (!state || !target || !target.kind || target.index === undefined) {
        return false;
      }
      state.selectedTarget = {
        kind: target.kind,
        index: target.index
      };
      this.triggerEvent("select", {
        type: target.kind === "feature" ? "area" : target.kind,
        index: target.index,
        data: target.data || null,
        lng: target.lng,
        lat: target.lat,
        name: target.name
      });
      return true;
    },

    clearSelected() {
      const state = this._state;
      if (!state) {
        return;
      }
      state.selectedTarget = null;
      this.triggerEvent("select", { type: "", index: -1, data: null });
    },

    flyToOverlayTarget(kind, index, options) {
      const state = this._state;
      if (!state) {
        return false;
      }
      const coords = getCoordsFromOverlayItem(state, kind, index);
      if (!coords.length) {
        return false;
      }
      return this.flyToCoordinates(coords, resolveFlyOptionsForKind(kind, options));
    },

    flyToSelected(options) {
      const state = this._state;
      if (!state || !state.selectedTarget) {
        return false;
      }
      const { kind, index } = state.selectedTarget;
      return this.flyToOverlayTarget(kind, index, options);
    },

    applySelectionFromTap(target, tapPoint) {
      const state = this._state;
      if (!state || !target) {
        return;
      }

      state.selectedTarget = {
        kind: target.kind,
        index: target.index
      };

      const selectDetail = {
        kind: target.kind,
        index: target.index,
        data: target.data || null,
        lng: target.lng,
        lat: target.lat,
        name: target.name,
        x: tapPoint && tapPoint.x,
        y: tapPoint && tapPoint.y
      };
      this.triggerEvent("select", {
        type: selectDetail.kind === "feature" ? "area" : selectDetail.kind,
        index: selectDetail.index,
        data: selectDetail.data,
        lng: selectDetail.lng,
        lat: selectDetail.lat,
        name: selectDetail.name
      });

      if (this.properties.flyOnSelect) {
        this.flyToSelected({ animate: true, duration: DEFAULT_FLY_DURATION });
      }
    },

    handleMapTap(tapPoint) {
      if (!isTapEnabled(this.properties) || !this._state) {
        return;
      }

      const target = pickMapTarget(this._state, tapPoint.x, tapPoint.y);
      if (!target) {
        this.clearSelected();
        this.triggerEvent("tap", normalizeTapDetail(null, tapPoint));
        return;
      }

      this.applySelectionFromTap(target, tapPoint);
      this.triggerEvent("tap", normalizeTapDetail(target, tapPoint));
    },

    reloadMapData() {
      this.syncMapLayers(true);
    },

    updateBackgroundStyle() {
      const bg = resolveBackground(this.properties);
      const config = resolveBackgroundConfig(bg.containerBackground, bg.backgroundColor);
      this.setData({
        containerStyle: config.containerStyle
      });
      this._backgroundConfig = config;
    },

    getMapZoomLimitsFromProps() {
      return getMapZoomLimits({
        min: Number(this.properties.minZoom) || MAP_ZOOM_MIN,
        max: Number(this.properties.maxZoom) || MAP_ZOOM_MAX
      });
    },

    emitStatus(status) {
      const countryCount = this.getFeatureCount();
      this.setData({ mapStatus: status, countryCount });
    },

    emitZoomChange() {
      const state = this._state;
      if (!state) {
        return;
      }
      const limits = this.getMapZoomLimitsFromProps();
      this.triggerEvent("zoom", {
        zoom: state.mapZoom,
        minZoom: limits.min,
        maxZoom: limits.max
      });
    },

    cleanup() {
      const state = this._state;
      if (!state) {
        return;
      }
      cancelViewAnimation(state);
      clearTileTimers(state);
      if (state.drawTimer) {
        clearTimeout(state.drawTimer);
        state.drawTimer = null;
      }
      clearTileCache(state);
      state.canvasNode = null;
      state.canvasContext = null;
      this._state = null;
    },

    scheduleTileRedraw() {
      const state = this._state;
      if (!state || state.tileRedrawScheduled) {
        return;
      }
      state.tileRedrawScheduled = true;
      requestFrame(() => {
        state.tileRedrawScheduled = false;
        this.scheduleDraw();
      });
    },

    updateTileLoadingState() {
      const state = this._state;
      const tileConfig = getTileConfig(this);
      if (!state || !tileConfig.enabled) {
        if (this.data.tileLoading) {
          this.setData({ tileLoading: false });
        }
        return;
      }
      const pending = countPendingTiles(state, tileConfig);
      const loading = pending > 0;
      const now = Date.now();
      if (loading !== this.data.tileLoading) {
        state._lastTileUiAt = now;
        this.setData({ tileLoading: loading });
        return;
      }
      if (loading && now - (state._lastTileUiAt || 0) < TILE_LOADING_UI_INTERVAL_MS) {
        return;
      }
      state._lastTileUiAt = now;
    },

    scheduleTileRequests(immediate) {
      const state = this._state;
      const tileConfig = getTileConfig(this);
      if (!state || !tileConfig.enabled) {
        return;
      }

      const run = () => {
        requestVisibleTiles(state, this, tileConfig, { skipPrune: shouldRetainTileCache(state) });
        this.updateTileLoadingState();
      };

      if (immediate) {
        clearTileTimers(state);
        run();
        return;
      }

      if (state.interacting) {
        if (state.tilePanDebounceTimer) {
          return;
        }
        state.tilePanDebounceTimer = setTimeout(() => {
          state.tilePanDebounceTimer = null;
          if (!this._state || !this._state.interacting) {
            return;
          }
          run();
          if (this._state.interacting) {
            this.scheduleTileRequests(false);
          }
        }, TILE_INTERACT_REQUEST_MS);
        return;
      }

      if (state.touchState.mode === "pan") {
        if (state.tilePanDebounceTimer) {
          clearTimeout(state.tilePanDebounceTimer);
        }
        state.tilePanDebounceTimer = setTimeout(() => {
          state.tilePanDebounceTimer = null;
          run();
        }, TILE_PAN_DEBOUNCE_MS);
        return;
      }

      run();
    },

    fitToOverlay(options) {
      const state = this._state;
      if (!state || !state.overlayLayers) {
        return false;
      }
      const overlay = state.overlayLayers;
      const coords = [];
      (overlay.points || []).forEach((point) => {
        coords.push({ lng: point.lng, lat: point.lat });
      });
      (overlay.lines || []).forEach((line) => {
        (line.coordinates || []).forEach((coord) => coords.push(coord));
      });
      (overlay.polygons || []).forEach((polygon) => {
        (polygon.rings || []).forEach((ring) => {
          ring.forEach((coord) => coords.push(coord));
        });
      });
      if (!coords.length) {
        return false;
      }
      return this.flyToCoordinates(coords, { padding: 0.18, animate: true, ...(options || {}) });
    },

    relayout() {
      const state = this._state;
      if (!state || !state.canvasNode) {
        return false;
      }
      const query = this.createSelectorQuery();
      query.select(".canvas-map").boundingClientRect();
      query.select("#world-map").fields({ node: true, size: true });
      query.exec((result) => {
        const container = result && result[0];
        const canvasItem = result && result[1];
        const width = (container && container.width) || (canvasItem && canvasItem.width);
        const height = (container && container.height) || (canvasItem && canvasItem.height);
        if (!width || !height || !this._state) {
          return;
        }
        const next = this._state;
        const prevZoom = next.mapZoom;
        const prevScale = next.mapView.scale;
        const prevOffsetX = next.mapView.offsetX;
        const prevOffsetY = next.mapView.offsetY;
        next.canvasWidth = width;
        next.canvasHeight = height;
        next.canvasDpr = wx.getSystemInfoSync().pixelRatio || 1;
        next.canvasNode.width = width * next.canvasDpr;
        next.canvasNode.height = height * next.canvasDpr;
        next.canvasContext = next.canvasNode.getContext("2d");
        next.canvasContext.scale(next.canvasDpr, next.canvasDpr);
        next.mapZoom = prevZoom;
        next.mapView.scale = prevScale;
        next.mapView.offsetX = prevOffsetX;
        next.mapView.offsetY = prevOffsetY;
        invalidateVisibleTileCache(next);
        clearTileCache(next);
        this.scheduleTileRequests(true);
        this.scheduleDraw();
      });
      return true;
    },

    applyProjection(projection) {
      const state = this._state;
      if (!state || projection === state.currentProjection) {
        return;
      }
      state.currentProjection = projection;
      clearTileCache(state);
      syncAllMapData(
        state,
        projection,
        this.getActivePolygons(),
        this.getActiveOverlay(),
        getOverlayStyleDefaults(this.properties),
        this._pointDrawer
      );
      if (state.canvasWidth && state.canvasHeight) {
        const preferredZoom = Number(this.properties.initialZoom) || 0;
        resetView(
          state,
          this.getMapZoomLimitsFromProps(),
          preferredZoom > 0 ? preferredZoom : undefined
        );
        this.scheduleDraw();
        this.emitZoomChange();
      }
    },

    cancelFlyTo() {
      cancelViewAnimation(this._state);
      return this;
    },

    flyToCoordinates(coordinates, options) {
      const state = this._state;
      if (!state || !state.canvasWidth || !state.canvasHeight) {
        return false;
      }

      const coords = normalizeCoordinateList(coordinates);
      if (!coords.length) {
        return false;
      }

      const projectedBounds = getProjectedBoundsFromCoords(coords, state.currentProjection, 0);
      if (!projectedBounds) {
        return false;
      }

      const limits = getMapZoomLimits({
        min:
          options && options.minZoom !== undefined
            ? options.minZoom
            : this.getMapZoomLimitsFromProps().min,
        max:
          options && options.maxZoom !== undefined
            ? options.maxZoom
            : this.getMapZoomLimitsFromProps().max
      });
      const target = computeViewTarget(state, projectedBounds, options, limits);
      let sumLng = 0;
      let sumLat = 0;
      coords.forEach((coord) => {
        sumLng += coord.lng;
        sumLat += coord.lat;
      });
      target.centerLng = sumLng / coords.length;
      target.centerLat = sumLat / coords.length;
      return this.applyViewTarget(target, options, coords);
    },

    applyViewTarget(target, options, coords) {
      const state = this._state;
      if (!state || !target) {
        return false;
      }

      cancelViewAnimation(state);
      const opts = options || {};
      const animate = !!opts.animate;
      const duration = Number(opts.duration) > 0 ? Number(opts.duration) : DEFAULT_FLY_DURATION;
      const from = {
        scale: state.mapView.scale || 1,
        offsetX: state.mapView.offsetX,
        offsetY: state.mapView.offsetY
      };
      const to = {
        mapZoom: target.mapZoom,
        scale: target.scale,
        offsetX: target.offsetX,
        offsetY: target.offsetY
      };

      const finish = () => {
        markViewChanged(state);
        this.scheduleDraw();
        refreshTilesAfterViewChange(this);
        this.emitZoomChange();
      };

      if (!animate) {
        state.mapZoom = to.mapZoom;
        state.mapView.scale = to.scale;
        state.mapView.offsetX = to.offsetX;
        state.mapView.offsetY = to.offsetY;
        finish();
        return true;
      }

      const component = this;
      runViewAnimation(state, component, from, to, duration, () => finish(), "out");
      return true;
    },

    animateMapZoomTo(nextZoom, anchor, options) {
      const state = this._state;
      if (!state || !state.canvasWidth) {
        return false;
      }

      const limits = this.getMapZoomLimitsFromProps();
      const targetZoom = clamp(Math.round(nextZoom), limits.min, limits.max);
      const currentZoom = state.mapZoom !== undefined ? state.mapZoom : state.baseMapZoom || limits.min;

      if (targetZoom === currentZoom && Math.abs(getMapViewScaleForZoom(state, targetZoom) - (state.mapView.scale || 1)) < 0.001) {
        return false;
      }

      const anchorPoint = anchor || {
        x: state.canvasWidth / 2,
        y: state.canvasHeight / 2
      };
      const opts = options || {};
      const animate = opts.animate !== undefined ? !!opts.animate : !!this.properties.zoomAnimate;
      const duration =
        Number(opts.duration) > 0
          ? Number(opts.duration)
          : Number(this.properties.zoomAnimateDuration) || DEFAULT_ZOOM_ANIMATE_DURATION;
      const from = {
        scale: state.mapView.scale || 1,
        offsetX: state.mapView.offsetX,
        offsetY: state.mapView.offsetY
      };
      const toView = computeViewAtZoom(state, targetZoom, anchorPoint);
      const to = {
        mapZoom: targetZoom,
        scale: toView.scale,
        offsetX: toView.offsetX,
        offsetY: toView.offsetY
      };

      const component = this;
      state.animTileZoom = targetZoom;
      this.scheduleTileRequests(true);
      const onDone = () => {
        markViewChanged(state);
        component.scheduleDraw();
        refreshTilesAfterViewChange(component);
        component.emitZoomChange();
      };

      if (!animate) {
        cancelViewAnimation(state);
        state.mapZoom = to.mapZoom;
        state.mapView.scale = to.scale;
        state.mapView.offsetX = to.offsetX;
        state.mapView.offsetY = to.offsetY;
        onDone();
        return true;
      }

      runViewAnimation(state, component, from, to, duration, onDone, "out");
      return true;
    },

    applyMapZoomStep(delta, origin, options) {
      const state = this._state;
      if (!state || !delta) {
        return false;
      }

      const limits = this.getMapZoomLimitsFromProps();
      const currentZoom = state.mapZoom !== undefined ? state.mapZoom : state.baseMapZoom || limits.min;
      const nextZoom = clamp(Math.round(currentZoom + delta), limits.min, limits.max);

      if (nextZoom === currentZoom) {
        return false;
      }

      return this.animateMapZoomTo(nextZoom, origin, options);
    },

    finishPinchZoom(anchor) {
      const state = this._state;
      if (!state) {
        return;
      }

      state.pinchActive = false;
      state.tileZoomLock = null;

      const limits = this.getMapZoomLimitsFromProps();
      const snapped = clamp(Math.round(getMapZoomFromViewScale(state)), limits.min, limits.max);
      const anchorPoint =
        anchor ||
        state.touchState.lastCenter || {
          x: state.canvasWidth / 2,
          y: state.canvasHeight / 2
        };

      const targetScale = getMapViewScaleForZoom(state, snapped);
      if (Math.abs((state.mapView.scale || 1) - targetScale) < 0.002) {
        state.mapZoom = snapped;
        state.mapView.scale = targetScale;
        markViewChanged(state);
        this.scheduleDraw();
        refreshTilesAfterViewChange(this);
        this.emitZoomChange();
        return;
      }

      this.animateMapZoomTo(snapped, anchorPoint, {
        animate: this.properties.zoomAnimate,
        duration: ZOOM_SNAP_DURATION
      });
    },

    onResetTap() {
      this.reset();
    },

    drawMap() {
      const state = this._state;
      if (!state || !state.canvasContext || !state.canvasWidth || !state.canvasHeight) {
        return;
      }

      const mapStyle = getOverlayStyleDefaults(this.properties);
      const { hideVectorWhenTiles } = this.properties;
      const tileConfig = getTileConfig(this);
      const bg = resolveBackground(this.properties);
      const bgConfig =
        this._backgroundConfig || resolveBackgroundConfig(bg.containerBackground, bg.backgroundColor);
      const context = state.canvasContext;
      perf.resetCanvasTransform(context, state);
      context.clearRect(0, 0, state.canvasWidth, state.canvasHeight);
      if (bgConfig.paintCanvasBg) {
        context.fillStyle = bgConfig.canvasFillColor;
        context.fillRect(0, 0, state.canvasWidth, state.canvasHeight);
      }

      if (tileConfig.enabled) {
        drawMapTiles(state, context, tileConfig);
      }

      const drawVector = !tileConfig.enabled || !hideVectorWhenTiles;
      const vp = perf.getViewportNormBounds(state, 0);
      const lineWidth = perf.normPixelsToLineWidth(state, 0.85);

      if (drawVector) {
        context.save();
        perf.applyViewTransform(context, state);
        context.lineJoin = "round";
        context.lineCap = "round";
        context.strokeStyle = mapStyle.strokeColor;
        context.lineWidth = lineWidth;
        context.fillStyle = mapStyle.fillColor;

        for (let index = 0; index < state.mapPaths.length; index += 1) {
          const feature = state.mapPaths[index];
          if (feature.bbox && !perf.bboxIntersectsNorm(feature.bbox, vp)) {
            continue;
          }
          const groups =
            feature.polygonGroups && feature.polygonGroups.length
              ? feature.polygonGroups
              : [feature.rings];
          for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
            const group = groups[groupIndex];
            let hasPath = false;
            context.beginPath();
            for (let ringIndex = 0; ringIndex < group.length; ringIndex += 1) {
              const ring = group[ringIndex];
              hasPath = perf.drawRingNorm(context, ring, 1) || hasPath;
            }
            if (hasPath) {
              context.fill();
              context.stroke();
            }
          }
        }
        context.restore();
      }

      context.save();
      perf.applyViewTransform(context, state);
      drawOverlayLayersNorm(context, state.overlayLayers, state);
      context.restore();
      this.updateTileLoadingState();
    },

    scheduleDraw() {
      const state = this._state;
      if (!state) {
        return;
      }
      if (state.rafScheduled) {
        return;
      }
      state.rafScheduled = true;
      requestFrame(() => {
        state.rafScheduled = false;
        if (!this._state || !this._state.canvasContext) {
          return;
        }
        const viewChanged = markViewChanged(this._state);
        this.drawMap();
        if (viewChanged || this._state.tilesDirty) {
          this._state.tilesDirty = false;
          this.scheduleTileRequests();
        }
      });
    },

    applyPan(dx, dy) {
      const state = this._state;
      if (!state) {
        return;
      }
      state.mapView.offsetX += dx;
      state.mapView.offsetY += dy;
      this.scheduleDraw();
    },

    handleDoubleTap(tapPoint) {
      const state = this._state;
      if (!state) {
        return;
      }
      const limits = this.getMapZoomLimitsFromProps();
      if (state.mapZoom >= limits.max) {
        this.animateMapZoomTo(limits.max - 1, tapPoint, { duration: ZOOM_SNAP_DURATION });
        return;
      }
      this.animateMapZoomTo((state.mapZoom || limits.min) + 1, tapPoint, { duration: ZOOM_SNAP_DURATION });
    },

    applyPinchZoomRatio(scale, origin, lastCenter) {
      const state = this._state;
      if (!state || !origin) {
        return;
      }

      cancelViewAnimation(state);
      const limits = this.getMapZoomLimitsFromProps();
      applyPinchGesture(state, lastCenter || origin, origin, scale || 1, limits);
      this.scheduleDraw();
    },

    initMap() {
      const state = this._state;
      if (!state) {
        return;
      }

      state.initAttempts += 1;
      this.emitStatus(`获取地图画布 ${state.initAttempts}`);

      const query = this.createSelectorQuery();
      query.select(".canvas-map").boundingClientRect();
      query.select("#world-map").fields({ node: true, size: true });
      query.exec((result) => {
        const container = result && result[0];
        const canvasItem = result && result[1];
        const width = (container && container.width) || (canvasItem && canvasItem.width);
        const height = (container && container.height) || (canvasItem && canvasItem.height);

        if (!canvasItem || !canvasItem.node || !width || !height) {
          if (state.initAttempts < 20) {
            setTimeout(() => this.initMap(), 120);
            return;
          }
          this.emitStatus("地图画布获取失败");
          return;
        }

        this.renderMap(canvasItem.node, width, height);
      });
    },

    renderMap(nextCanvasNode, width, height) {
      const state = this._state;
      if (!state) {
        return;
      }

      try {
        this.emitStatus("地图渲染中");
        state.canvasNode = nextCanvasNode;
        state.canvasWidth = width;
        state.canvasHeight = height;
        state.canvasDpr = wx.getSystemInfoSync().pixelRatio || 1;
        state.canvasNode.width = width * state.canvasDpr;
        state.canvasNode.height = height * state.canvasDpr;
        state.canvasContext = state.canvasNode.getContext("2d");
        state.canvasContext.scale(state.canvasDpr, state.canvasDpr);
        state.currentProjection = this.properties.projection || PROJECTION.MERCATOR;
        syncAllMapData(
          state,
          state.currentProjection,
          this.getActivePolygons(),
          this.getActiveOverlay(),
          getOverlayStyleDefaults(this.properties),
          this._pointDrawer
        );
        const preferredZoom = Number(this.properties.initialZoom) || 0;
        resetView(
          state,
          this.getMapZoomLimitsFromProps(),
          preferredZoom > 0 ? preferredZoom : undefined
        );
        markViewChanged(state);
        state.tilesDirty = true;
        this.drawMap();
        if (getTileConfig(this).enabled) {
          this.scheduleTileRequests(true);
        }
        this.emitStatus("地图已加载");
        this.emitZoomChange();
        this.triggerEvent("ready", {
          count: state.featureCount,
          zoom: state.mapZoom
        });
      } catch (error) {
        this.emitStatus(error && error.message ? error.message : "地图渲染失败");
      }
    },

    onMapTouchStart(event) {
      const state = this._state;
      const touches = event.touches || [];
      if (!state || !state.canvasContext || !touches.length) {
        return;
      }

      cancelViewAnimation(state);
      state.interacting = true;

      if (touches.length >= 2) {
        if (!state.pinchActive) {
          state.pinchActive = true;
          state.tileZoomLock = state.mapZoom;
        }
        state.touchState = {
          mode: "pinch",
          lastPoint: null,
          lastDistance: getTouchDistance(touches),
          lastCenter: getTouchCenter(touches)
        };
        return;
      }

      const tapPoint = getTouchPoint(touches[0]);
      state.touchState = {
        mode: "pan",
        lastPoint: tapPoint,
        lastDistance: 0,
        lastCenter: null,
        tapStart: tapPoint,
        tapStartTime: Date.now(),
        tapMoved: 0
      };
    },

    onMapTouchMove(event) {
      const state = this._state;
      const touches = event.touches || [];
      if (!state || !state.canvasContext || !touches.length) {
        return;
      }

      if (touches.length >= 2) {
        const distance = getTouchDistance(touches);
        const center = getTouchCenter(touches);
        if (state.touchState.mode !== "pinch" || !state.touchState.lastCenter) {
          if (!state.pinchActive) {
            state.pinchActive = true;
            state.tileZoomLock = state.mapZoom;
          }
          state.touchState = {
            mode: "pinch",
            lastPoint: null,
            lastDistance: distance,
            lastCenter: center
          };
          return;
        }

        if (state.touchState.lastDistance > 0 && distance > 0) {
          const scale = distance / state.touchState.lastDistance;
          cancelViewAnimation(state);
          const limits = this.getMapZoomLimitsFromProps();
          applyPinchGesture(state, state.touchState.lastCenter, center, scale, limits);
          this.scheduleDraw();
          state.touchState.lastDistance = distance;
          state.touchState.lastCenter = center;
        }
        return;
      }

      const point = getTouchPoint(touches[0]);
      if (state.touchState.mode !== "pan" || !state.touchState.lastPoint) {
        state.touchState = {
          mode: "pan",
          lastPoint: point,
          lastDistance: 0,
          lastCenter: null
        };
        return;
      }

      const dx = point.x - state.touchState.lastPoint.x;
      const dy = point.y - state.touchState.lastPoint.y;
      if (state.touchState.tapStart) {
        state.touchState.tapMoved = Math.max(
          state.touchState.tapMoved,
          Math.hypot(point.x - state.touchState.tapStart.x, point.y - state.touchState.tapStart.y)
        );
      }
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) {
        return;
      }
      this.applyPan(dx, dy);
      state.touchState.lastPoint = point;
    },

    onMapTouchEnd(event) {
      const state = this._state;
      if (!state) {
        return;
      }

      const touches = event.touches || [];
      const pinchAnchor = state.touchState.lastCenter;

      if (touches.length >= 2) {
        state.touchState = {
          mode: "pinch",
          lastPoint: null,
          lastDistance: getTouchDistance(touches),
          lastCenter: getTouchCenter(touches),
          tapStart: null,
          tapStartTime: 0,
          tapMoved: 0
        };
        return;
      }
      if (touches.length === 1) {
        if (state.pinchActive) {
          this.finishPinchZoom(pinchAnchor || getTouchCenter(touches));
        }
        state.touchState = {
          mode: "pan",
          lastPoint: getTouchPoint(touches[0]),
          lastDistance: 0,
          lastCenter: null,
          tapStart: state.touchState.tapStart,
          tapStartTime: state.touchState.tapStartTime,
          tapMoved: state.touchState.tapMoved
        };
        return;
      }

      if (state.pinchActive) {
        this.finishPinchZoom(pinchAnchor || { x: state.canvasWidth / 2, y: state.canvasHeight / 2 });
      } else {
        clearTileTimers(state);
      }
      state.interacting = false;

      const changedTouch = event.changedTouches && event.changedTouches[0];
      const tapPoint = changedTouch ? getTouchPoint(changedTouch) : state.touchState.tapStart;
      const isTap =
        tapPoint &&
        state.touchState.tapStart &&
        state.touchState.tapMoved <= TAP_MOVE_THRESHOLD &&
        Date.now() - state.touchState.tapStartTime <= TAP_DURATION_THRESHOLD;

      if (isTap) {
        const now = Date.now();
        const lastTapTime = state.touchState.lastTapTime || 0;
        const lastTapPoint = state.touchState.lastTapPoint;
        const isDoubleTap =
          now - lastTapTime <= DOUBLE_TAP_MS &&
          lastTapPoint &&
          Math.hypot(tapPoint.x - lastTapPoint.x, tapPoint.y - lastTapPoint.y) <= DOUBLE_TAP_DISTANCE;

        if (isDoubleTap) {
          this.handleDoubleTap(tapPoint);
          state.touchState.lastTapTime = 0;
          state.touchState.lastTapPoint = null;
        } else {
          state.touchState.lastTapTime = now;
          state.touchState.lastTapPoint = tapPoint;
          this.handleMapTap(tapPoint);
        }
      }

      if (state.touchState.mode === "pan" || state.pinchActive) {
        this.scheduleTileRequests(true);
      }

      state.touchState = {
        mode: "",
        lastPoint: null,
        lastDistance: 0,
        lastCenter: null,
        tapStart: null,
        tapStartTime: 0,
        tapMoved: 0
      };
    }
  }
});
