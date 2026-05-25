/**
 * 瓦片服务商预设（图源均为 Web 墨卡托 XYZ/TMS）
 * 组件在墨卡托投影下直接铺瓦片；经纬度投影下按纬度条带重投影绘制。
 * scheme:
 *   - xyz: 标准 Web 墨卡托（OSM、高德、天地图 WMTS 等）
 *   - tms: Y 轴翻转（部分腾讯等）
 *   - baidu: 百度瓦片行列（Y 翻转）
 * 天地图需在组件上设置 tile-token（tk）
 */
const TILE_PROVIDERS = {
  osm: {
    name: "OpenStreetMap",
    url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    scheme: "xyz",
    subdomains: "abc",
    minZoom: 0,
    maxZoom: 19
  },
  cartoLight: {
    name: "Carto 浅色",
    url: "https://basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png",
    scheme: "xyz",
    subdomains: "abcd",
    minZoom: 0,
    maxZoom: 20
  },
  cartoDark: {
    name: "Carto 深色",
    url: "https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
    scheme: "xyz",
    subdomains: "abcd",
    minZoom: 0,
    maxZoom: 20
  },
  gaode: {
    name: "高德标准",
    url: "https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}",
    scheme: "xyz",
    subdomains: "1234",
    minZoom: 3,
    maxZoom: 18
  },
  gaodeSatellite: {
    name: "高德影像",
    url: "https://webst0{s}.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}",
    scheme: "xyz",
    subdomains: "1234",
    minZoom: 3,
    maxZoom: 18
  },
  gaodeRoadNet: {
    name: "高德路网",
    url: "https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}",
    scheme: "xyz",
    subdomains: "1234",
    minZoom: 3,
    maxZoom: 18
  },
  baidu: {
    name: "百度标准",
    url: "https://maponline{s}.bdimg.com/tile/?qt=widget&x={x}&y={y}&z={z}&styles=pl&scaler=2&p=1",
    scheme: "baidu",
    subdomains: "0123",
    minZoom: 3,
    maxZoom: 19
  },
  baiduSatellite: {
    name: "百度影像",
    url: "https://maponline{s}.bdimg.com/tile/?qt=sateplt&x={x}&y={y}&z={z}&styles=sl&scaler=2&p=1",
    scheme: "baidu",
    subdomains: "0123",
    minZoom: 3,
    maxZoom: 19
  },
  baiduDark: {
    name: "百度深色",
    url: "https://maponline{s}.bdimg.com/tile/?qt=widget&x={x}&y={y}&z={z}&styles=dl&scaler=2&p=1",
    scheme: "baidu",
    subdomains: "0123",
    minZoom: 3,
    maxZoom: 19
  },
  tencent: {
    name: "腾讯标准",
    url: "https://rt{s}.map.gtimg.com/tile?z={z}&x={x}&y={reverseY}&type=vector&styleid=3",
    scheme: "tms",
    subdomains: "0123",
    minZoom: 3,
    maxZoom: 18
  },
  tencentSatellite: {
    name: "腾讯影像",
    url: "https://p{s}.map.gtimg.com/sateTiles/{z}/{x}/{reverseY}.jpg",
    scheme: "tms",
    subdomains: "0123",
    minZoom: 3,
    maxZoom: 18
  },
  tiandituVec: {
    name: "天地图矢量",
    url:
      "https://t{s}.tianditu.gov.cn/vec_w/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=vec&STYLE=default&TILEMATRIXSET=w&FORMAT=tiles&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&tk={tk}",
    scheme: "xyz",
    subdomains: "01234567",
    requiresToken: true,
    minZoom: 1,
    maxZoom: 18
  },
  tiandituImg: {
    name: "天地图影像",
    url:
      "https://t{s}.tianditu.gov.cn/img_w/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=img&STYLE=default&TILEMATRIXSET=w&FORMAT=tiles&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&tk={tk}",
    scheme: "xyz",
    subdomains: "01234567",
    requiresToken: true,
    minZoom: 1,
    maxZoom: 18
  },
  tiandituTer: {
    name: "天地图地形",
    url:
      "https://t{s}.tianditu.gov.cn/ter_w/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=ter&STYLE=default&TILEMATRIXSET=w&FORMAT=tiles&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&tk={tk}",
    scheme: "xyz",
    subdomains: "01234567",
    requiresToken: true,
    minZoom: 1,
    maxZoom: 18
  },
  tiandituCva: {
    name: "天地图注记",
    url:
      "https://t{s}.tianditu.gov.cn/cva_w/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=cva&STYLE=default&TILEMATRIXSET=w&FORMAT=tiles&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&tk={tk}",
    scheme: "xyz",
    subdomains: "01234567",
    requiresToken: true,
    minZoom: 1,
    maxZoom: 18
  },
  geoq: {
    name: "GeoQ 智图",
    url: "https://map.geoq.cn/ArcGIS/rest/services/ChinaOnlineCommunity/MapServer/tile/{z}/{y}/{x}",
    scheme: "xyz",
    subdomains: "",
    minZoom: 3,
    maxZoom: 18
  },
  stamenToner: {
    name: "Stamen 黑白",
    url: "https://stamen-tiles.a.ssl.fastly.net/toner/{z}/{x}/{y}.png",
    scheme: "xyz",
    subdomains: "",
    minZoom: 0,
    maxZoom: 20
  }
};

function getTileProviderList() {
  return Object.keys(TILE_PROVIDERS).map((id) => ({
    id,
    name: TILE_PROVIDERS[id].name,
    requiresToken: !!TILE_PROVIDERS[id].requiresToken
  }));
}

function getTileProvider(id) {
  if (!id || id === "custom") {
    return null;
  }
  return TILE_PROVIDERS[id] || null;
}

module.exports = {
  TILE_PROVIDERS,
  getTileProviderList,
  getTileProvider
};
