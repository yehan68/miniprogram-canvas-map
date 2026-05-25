/**
 * 将 example 的 npm 依赖同步到 miniprogram_npm（等同开发者工具「构建 npm」的本地包拷贝）
 * 运行: node scripts/build-example-npm.js
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const exampleDir = path.join(root, "example");
const pkgName = "miniprogram-canvas-map";
const srcDir = path.join(exampleDir, "node_modules", pkgName);
const destDir = path.join(exampleDir, "miniprogram_npm", pkgName);

function ensureDeps() {
  if (!fs.existsSync(srcDir)) {
    console.error(
      "[build-example-npm] 未找到 node_modules/miniprogram-canvas-map，请先执行:\n  npm run install:example"
    );
    process.exit(1);
  }
}

function syncPackage() {
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(destDir), { recursive: true });
  fs.cpSync(srcDir, destDir, { recursive: true });
  console.log(`[build-example-npm] 已生成 ${path.relative(root, destDir)}`);
}

ensureDeps();
syncPackage();
