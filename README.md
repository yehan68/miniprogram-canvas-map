# miniprogram-canvas-map 工作区

微信小程序 Canvas 地图组件 **miniprogram-canvas-map** 的源码、演示与发布配置。

[![npm version](https://img.shields.io/npm/v/miniprogram-canvas-map)](https://www.npmjs.com/package/miniprogram-canvas-map)
[![license](https://img.shields.io/npm/l/miniprogram-canvas-map)](./LICENSE)

## 开源与 GitHub

```bash
# 首次推送到 GitHub（需先 gh auth login 或配置 remote）
gh repo create miniprogram-canvas-map --public --source=. --remote=origin --push
```

将 `packages/miniprogram-canvas-map/package.json` 里的 `YOUR_GITHUB_USERNAME` 换成你的 GitHub 用户名。

## 目录结构

```
.
├── packages/
│   └── miniprogram-canvas-map/   # 📦 发布到 npm 的组件包
│       ├── package.json
│       ├── README.md               # 组件完整文档（使用者请阅此文件）
│       ├── LICENSE
│       └── miniprogram/
│           └── canvas-map/         # 组件源码
├── example/                        # 演示小程序（微信开发者工具打开此目录）
│   ├── app.json
│   ├── package.json                # 依赖 file:../packages/miniprogram-canvas-map
│   ├── pages/map/                  # 功能演示页
│   └── project.config.json
├── scripts/
│   └── test-canvas-map.js          # Node 冒烟测试
├── package.json
└── README.md                       # 本文件
```

## 本地开发演示

```bash
# 安装演示项目依赖并生成 example/miniprogram_npm
npm run install:example

# 冒烟测试
npm test
```

1. 用微信开发者工具打开 **`example`** 目录（不是仓库根目录）。
2. 若 `example/miniprogram_npm` 不存在，在仓库根目录执行 `npm run build:example-npm`，或在开发者工具菜单 **工具 → 构建 npm**。
3. 编译运行，进入「地图」页体验。

## 在业务项目中使用（npm）

```bash
npm install miniprogram-canvas-map
```

构建 npm 后，在页面 json 中：

```json
{
  "usingComponents": {
    "canvas-map": "/miniprogram_npm/miniprogram-canvas-map/miniprogram/canvas-map/canvas-map"
  }
}
```

详细 API、属性、事件、数据格式见：

**[packages/miniprogram-canvas-map/README.md](./packages/miniprogram-canvas-map/README.md)**

## 发布组件到 npm（官方 registry）

全局若配置了 cnpm / npmmirror（`registry=https://registry.npmmirror.com/`），直接 `npm login` 会跳到 **cnpm 登录**，无法发布到 [npmjs.com](https://www.npmjs.com)。

**正确做法**（在组件包目录发布，已自带 `.npmrc` 指向官方源）：

```bash
npm test
cd packages/miniprogram-canvas-map
npm login --registry=https://registry.npmjs.org
npm publish --access public
```

或一行指定 registry：

```bash
npm publish --prefix packages/miniprogram-canvas-map --access public --registry=https://registry.npmjs.org
```

在 `packages/miniprogram-canvas-map/package.json` 中维护版本号，遵循 semver。需先在 [npmjs.com](https://www.npmjs.com) 注册账号。

## 测试

```bash
npm test
```

覆盖 API 解析、世界面数据、线宽换算、瓦片回退绘制、语法检查等（不依赖微信运行时）。

## 说明

- 根目录下的旧路径 `components/canvas-map`、`pages/` 已迁移，请勿再引用。
- 国界数据仅 `data/world.js` 一份（2 位小数坐标 + 中英文国名，约 **165KB**）。不需要矢量底图时不要 `require`；主包紧张时把地图页放分包。
- 维护者从 `scripts/data/world-full.json` 生成：`npm run build:world-data`。
