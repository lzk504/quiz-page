import { defineConfig } from "vite";

/**
 * 前端构建：vanilla TS（无框架插件）。
 * 入口 webapp/index.html，产出到仓库根 ./dist（wrangler.toml 的 assets directory）。
 * publicDir（默认 webapp/public）原样复制 —— 题库 data/questions.json 经此进 dist。
 */
export default defineConfig({
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    sourcemap: false,
    target: "es2022",
  },
});
