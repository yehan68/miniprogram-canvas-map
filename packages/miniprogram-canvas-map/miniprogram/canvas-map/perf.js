/**
 * canvas-map 性能优化：视口变换、包围盒剔除、瓦片绘制列表
 */
const TILE_SIZE = 256;

function tilePow2(z) {
  return z >= 0 && z < 31 ? 1 << z : Math.pow(2, z);
}

function getMapSize(projection) {
  if (projection === "equirectangular") {
    return { width: 360, height: 180 };
  }
  return { width: 360, height: 360 };
}

function getViewTransform(state) {
  const mapSize = getMapSize(state.currentProjection);
  const sx = mapSize.width * state.baseView.scale * state.mapView.scale;
  const sy = mapSize.height * state.baseView.scale * state.mapView.scale;
  return {
    sx,
    sy,
    tx: state.baseView.offsetX + state.mapView.offsetX,
    ty: state.baseView.offsetY + state.mapView.offsetY
  };
}

/** applyViewTransform 后：将屏幕像素线宽换算为 norm 坐标系下的 lineWidth */
function normPixelsToLineWidth(state, pixels) {
  const t = getViewTransform(state);
  const scale = Math.max(Math.abs(t.sx), Math.abs(t.sy), 0.001);
  return Math.max(Number(pixels) || 0, 0) / scale;
}

function getViewSignature(state) {
  const t = getViewTransform(state);
  return [
    state.currentProjection,
    state.mapZoom,
    Math.round(t.tx * 2) / 2,
    Math.round(t.ty * 2) / 2,
    Math.round(t.sx * 1000) / 1000,
    Math.round(t.sy * 1000) / 1000,
    state.canvasWidth,
    state.canvasHeight
  ].join("|");
}

function getViewportNormBounds(state, padScreenRatio) {
  const t = getViewTransform(state);
  const ratio = padScreenRatio > 0 ? padScreenRatio : 0;
  const padX = ratio > 0 ? (state.canvasWidth * ratio) / t.sx : 0.06;
  const padY = ratio > 0 ? (state.canvasHeight * ratio) / t.sy : 0.06;
  return {
    minX: -t.tx / t.sx - padX,
    minY: -t.ty / t.sy - padY,
    maxX: (state.canvasWidth - t.tx) / t.sx + padX,
    maxY: (state.canvasHeight - t.ty) / t.sy + padY
  };
}

function bboxIntersectsNorm(a, b) {
  return !(a.maxX < b.minX || a.minX > b.maxX || a.maxY < b.minY || a.minY > b.maxY);
}

function computeRingNormBBox(ring) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < ring.length; i += 1) {
    const p = ring[i];
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  if (!Number.isFinite(minX)) {
    return null;
  }
  return { minX, minY, maxX, maxY };
}

function mergeBBox(a, b) {
  if (!a) {
    return b;
  }
  if (!b) {
    return a;
  }
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY)
  };
}

function computeFeatureNormBBox(rings) {
  let bbox = null;
  for (let i = 0; i < rings.length; i += 1) {
    bbox = mergeBBox(bbox, computeRingNormBBox(rings[i]));
  }
  return bbox;
}

function applyViewTransform(ctx, state) {
  const t = getViewTransform(state);
  const dpr = state.canvasDpr || 1;
  // 须包含 DPR：setTransform 会覆盖 init 时的 scale(dpr)，否则只画在物理像素左上角
  ctx.setTransform(t.sx * dpr, 0, 0, t.sy * dpr, t.tx * dpr, t.ty * dpr);
}

function resetCanvasTransform(ctx, state) {
  const dpr = state.canvasDpr || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function drawRingNorm(ctx, ring, step) {
  if (!ring || ring.length < 2) {
    return false;
  }
  const stride = step > 1 ? step : 1;
  const last = ring.length - 1;
  ctx.moveTo(ring[0].x, ring[0].y);
  for (let i = stride; i < last; i += stride) {
    ctx.lineTo(ring[i].x, ring[i].y);
  }
  if (last > 0) {
    ctx.lineTo(ring[last].x, ring[last].y);
  }
  ctx.closePath();
  return true;
}

function getRingDecimation(ringLength, mapZoom) {
  if (ringLength < 80) {
    return 1;
  }
  if (mapZoom >= 12) {
    return 1;
  }
  if (mapZoom >= 8) {
    return 2;
  }
  if (mapZoom >= 5) {
    return 4;
  }
  return 8;
}

function getEquirectangularStripCount(mapZoom) {
  if (mapZoom >= 14) {
    return 12;
  }
  if (mapZoom >= 10) {
    return 8;
  }
  return 6;
}

function getMercatorTileCacheKey(tileConfig, z, x, y) {
  return `${tileConfig.projection || "mercator"}/${tileConfig.providerId || "custom"}/${tileConfig.scheme}/${z}/${x}/${y}`;
}

function getLoadedMercatorTile(tileCache, tileConfig, z, x, y) {
  const cached = tileCache[getMercatorTileCacheKey(tileConfig, z, x, y)];
  if (!cached || cached.status !== "loaded" || !cached.image) {
    return null;
  }
  return cached.image;
}

function getMercatorTileIndexRange(vp, z) {
  const n = tilePow2(z);
  return {
    n,
    minTx: Math.max(0, Math.floor(vp.minX * n)),
    maxTx: Math.min(n - 1, Math.ceil(vp.maxX * n) - 1),
    minTy: Math.max(0, Math.floor(vp.minY * n)),
    maxTy: Math.min(n - 1, Math.ceil(vp.maxY * n) - 1)
  };
}

function buildMercatorTileDrawList(state, tileZ, tileConfig, tileCache, options) {
  const opts = options || {};
  const pad = opts.interacting ? 0.55 : 0.15;
  const vp = getViewportNormBounds(state, pad);
  const list = [];
  const seen = new Set();
  const z = tileZ;
  const n = 1 / tilePow2(z);
  const prefix = `${tileConfig.projection || "mercator"}/${tileConfig.providerId || "custom"}/${tileConfig.scheme}/${z}/`;
  const keys = state.tileCacheKeys || [];
  const minFallbackZoom = Math.max(
    Number(tileConfig.minZoom) || 0,
    z - (opts.maxFallbackLevels !== undefined ? opts.maxFallbackLevels : 4)
  );

  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    if (!key.startsWith(prefix)) {
      continue;
    }
    const cached = tileCache[key];
    if (!cached || cached.status !== "loaded" || !cached.image) {
      continue;
    }
    const parts = key.split("/");
    const tx = Number(parts[4]);
    const ty = Number(parts[5]);
    if (!Number.isFinite(tx) || !Number.isFinite(ty)) {
      continue;
    }
    const dedupe = `${z}/${tx}/${ty}`;
    if (seen.has(dedupe)) {
      continue;
    }
    const minX = tx * n;
    const minY = ty * n;
    const maxX = minX + n;
    const maxY = minY + n;
    if (!bboxIntersectsNorm({ minX, minY, maxX, maxY }, vp)) {
      continue;
    }
    seen.add(dedupe);
    list.push({
      image: cached.image,
      x: minX,
      y: minY,
      w: n,
      h: n
    });
  }

  const range = getMercatorTileIndexRange(vp, z);
  let fallbackCount = 0;
  const maxFallback = opts.maxFallbackTiles !== undefined ? opts.maxFallbackTiles : 96;

  for (let ty = range.minTy; ty <= range.maxTy && fallbackCount < maxFallback; ty += 1) {
    for (let tx = range.minTx; tx <= range.maxTx && fallbackCount < maxFallback; tx += 1) {
      const dedupe = `${z}/${tx}/${ty}`;
      if (seen.has(dedupe)) {
        continue;
      }
      const minX = tx * n;
      const minY = ty * n;
      if (!bboxIntersectsNorm({ minX, minY, maxX: minX + n, maxY: minY + n }, vp)) {
        continue;
      }
      for (let dz = 1; z - dz >= minFallbackZoom; dz += 1) {
        const factor = tilePow2(dz);
        const px = Math.floor(tx / factor);
        const py = Math.floor(ty / factor);
        const image = getLoadedMercatorTile(tileCache, tileConfig, z - dz, px, py);
        if (!image) {
          continue;
        }
        const localX = tx % factor;
        const localY = ty % factor;
        const cell = TILE_SIZE / factor;
        seen.add(dedupe);
        list.push({
          image,
          x: minX,
          y: minY,
          w: n,
          h: n,
          sx: localX * cell,
          sy: localY * cell,
          sw: cell,
          sh: cell
        });
        fallbackCount += 1;
        break;
      }
      if (seen.has(dedupe)) {
        continue;
      }
      const maxTileZ = Number(tileConfig.maxZoom) || 18;
      const maxUpLevels = opts.maxUpFallbackLevels !== undefined ? opts.maxUpFallbackLevels : 2;
      for (let dz = 1; z + dz <= maxTileZ && dz <= maxUpLevels; dz += 1) {
        const factor = tilePow2(dz);
        const groupTx = tx - (tx % factor);
        const groupTy = ty - (ty % factor);
        const cx = groupTx * factor;
        const cy = groupTy * factor;
        const image = getLoadedMercatorTile(tileCache, tileConfig, z + dz, cx, cy);
        if (!image) {
          continue;
        }
        const subX = tx - groupTx;
        const subY = ty - groupTy;
        const cell = TILE_SIZE / factor;
        seen.add(dedupe);
        list.push({
          image,
          x: minX,
          y: minY,
          w: n,
          h: n,
          sx: subX * cell,
          sy: subY * cell,
          sw: cell,
          sh: cell
        });
        fallbackCount += 1;
        break;
      }
    }
  }

  return { list, opacity: tileConfig.opacity };
}

function drawMercatorTileList(ctx, drawList) {
  const items = drawList.list;
  const alpha = drawList.opacity;
  const prevAlpha = ctx.globalAlpha;
  if (alpha < 1) {
    ctx.globalAlpha = prevAlpha * alpha;
  }
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (item.sw !== undefined && item.sh !== undefined) {
      ctx.drawImage(item.image, item.sx, item.sy, item.sw, item.sh, item.x, item.y, item.w, item.h);
    } else {
      ctx.drawImage(item.image, item.x, item.y, item.w, item.h);
    }
  }
  if (alpha < 1) {
    ctx.globalAlpha = prevAlpha;
  }
}

function capTileList(tiles, maxCount) {
  if (tiles.length <= maxCount) {
    return tiles;
  }
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < tiles.length; i += 1) {
    const t = tiles[i];
    minX = Math.min(minX, t.x);
    maxX = Math.max(maxX, t.x);
    minY = Math.min(minY, t.y);
    maxY = Math.max(maxY, t.y);
  }
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  const edgeKeys = new Set();
  for (let i = 0; i < tiles.length; i += 1) {
    const t = tiles[i];
    if (t.x === minX || t.x === maxX || t.y === minY || t.y === maxY) {
      edgeKeys.add(`${t.z}/${t.x}/${t.y}`);
    }
  }
  const sorted = tiles.slice().sort((a, b) => {
    const da = (a.x - centerX) * (a.x - centerX) + (a.y - centerY) * (a.y - centerY);
    const db = (b.x - centerX) * (b.x - centerX) + (b.y - centerY) * (b.y - centerY);
    return da - db;
  });
  const chosen = [];
  const used = new Set();
  const push = (tile) => {
    const key = `${tile.z}/${tile.x}/${tile.y}`;
    if (used.has(key)) {
      return;
    }
    used.add(key);
    chosen.push(tile);
  };
  for (let i = 0; i < tiles.length; i += 1) {
    const t = tiles[i];
    const key = `${t.z}/${t.x}/${t.y}`;
    if (edgeKeys.has(key)) {
      push(t);
    }
  }
  for (let i = 0; i < sorted.length && chosen.length < maxCount; i += 1) {
    push(sorted[i]);
  }
  return chosen;
}

module.exports = {
  TILE_SIZE,
  tilePow2,
  getMapSize,
  getViewTransform,
  normPixelsToLineWidth,
  getViewSignature,
  getViewportNormBounds,
  bboxIntersectsNorm,
  computeRingNormBBox,
  computeFeatureNormBBox,
  mergeBBox,
  applyViewTransform,
  resetCanvasTransform,
  drawRingNorm,
  getRingDecimation,
  getEquirectangularStripCount,
  buildMercatorTileDrawList,
  drawMercatorTileList,
  capTileList
};
