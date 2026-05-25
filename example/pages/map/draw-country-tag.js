/**
 * 绘制腾讯地图风格国家胶囊标注：白底圆角 + 黄色圆点 + 黑色国名
 */
function roundRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

function measureCountryTag(ctx, text, options) {
  const fontSize = (options && options.fontSize) || 12;
  const padX = (options && options.padX) || 8;
  const padY = (options && options.padY) || 5;
  const dotR = (options && options.dotR) || 5;
  const gap = (options && options.gap) || 6;
  ctx.font = `${fontSize}px sans-serif`;
  const textWidth = ctx.measureText(text).width;
  const width = padX + dotR * 2 + gap + textWidth + padX;
  const height = Math.max(dotR * 2, fontSize) + padY * 2;
  return { width, height, fontSize, padX, padY, dotR, gap, textWidth };
}

function drawCountryTag(ctx, payload) {
  const text = (payload.point && (payload.point.label || payload.point.name)) || "";
  if (!text) {
    return;
  }
  const x = payload.x;
  const y = payload.y;
  const metrics = measureCountryTag(ctx, text, payload.point.tagStyle);
  const { width, height, fontSize, padX, padY, dotR, gap } = metrics;
  const left = x - width / 2;
  const top = y - height / 2;

  ctx.save();
  ctx.shadowColor = "rgba(0, 0, 0, 0.12)";
  ctx.shadowBlur = 8;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 2;
  ctx.fillStyle = "#ffffff";
  roundRect(ctx, left, top, width, height, height / 2);
  ctx.fill();
  ctx.restore();

  const dotCx = left + padX + dotR;
  const dotCy = top + height / 2;
  ctx.beginPath();
  ctx.arc(dotCx, dotCy, dotR, 0, Math.PI * 2);
  ctx.fillStyle = "#FFC107";
  ctx.fill();

  ctx.fillStyle = "#333333";
  ctx.font = `${fontSize}px sans-serif`;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.fillText(text, dotCx + dotR + gap, dotCy);
  ctx.textAlign = "start";
}

module.exports = {
  drawCountryTag,
  measureCountryTag
};
