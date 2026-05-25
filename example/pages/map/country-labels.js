/**
 * 欧非/中东国家标注（经纬度为示意中心点，用于演示胶囊标签）
 */
const COUNTRY_LABEL_POINTS = [
  { lng: 5.3, lat: 52.2, label: "荷兰" },
  { lng: 10.5, lat: 51.2, label: "德国" },
  { lng: 2.2, lat: 46.8, label: "法国" },
  { lng: 8.2, lat: 46.8, label: "瑞士" },
  { lng: 14.5, lat: 47.5, label: "奥地利" },
  { lng: 19.4, lat: 52.1, label: "波兰" },
  { lng: 25.0, lat: 45.9, label: "罗马尼亚" },
  { lng: 23.7, lat: 39.0, label: "希腊" },
  { lng: 35.2, lat: 39.0, label: "土耳其" },
  { lng: 33.4, lat: 35.1, label: "塞浦路斯" },
  { lng: 51.2, lat: 25.3, label: "卡塔尔" },
  { lng: 53.7, lat: 32.5, label: "伊朗" },
  { lng: 30.8, lat: 26.8, label: "埃及" },
  { lng: 2.6, lat: 9.3, label: "贝宁" },
  { lng: 20.0, lat: 5.0, label: "非洲" },
  { lng: 37.9, lat: 0.5, label: "肯尼亚" },
  { lng: 17.9, lat: -11.2, label: "安哥拉" },
  { lng: 27.8, lat: -13.5, label: "赞比亚" },
  { lng: 25.7, lat: -28.5, label: "南非" }
];

function buildCountryLabelsOverlay() {
  return {
    points: COUNTRY_LABEL_POINTS.map((item) => ({
      lng: item.lng,
      lat: item.lat,
      label: item.label,
      renderType: "custom",
      radius: 14
    })),
    lines: [],
    polygons: []
  };
}

module.exports = {
  COUNTRY_LABEL_POINTS,
  buildCountryLabelsOverlay
};
