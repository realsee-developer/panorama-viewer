# Panorama Viewer — WebGPU · HDR

**简体中文** · [English](./README.md)

一个基于 **three.js WebGPU** 的全景图查看器。拖入一张等距圆柱（equirectangular）全景图即可浏览，支持 **Ultra HDR**、**EXR**、**Radiance HDR** 图片的真 HDR 显示。

🔗 **在线预览：** https://realsee-developer.github.io/panorama-viewer/

## 功能

- **格式** — AVIF · JPG · PNG · Ultra HDR JPG（gain map）· OpenEXR（`.exr`）· Radiance HDR（`.hdr`）
- **交互** — 拖拽改变视角；滚轮 / 双指 pinch 缩放（FOV）
- **真 HDR** — Ultra HDR 图片渲染到 `rgba16float` HDR 画布；`.exr` / `.hdr` 线性浮点全景图在加载时转换为 SDR base + gain map，走同一条渲染路径；提供实时 **maxDisplayBoost** 滑块控制增益图的应用强度
- **缩略图** — 等距圆柱小地图高亮当前视角区域（点击可看向对应方向）
- **输入校验** — 宽高比 `< 2:1` 报错，`> 2:1` 自动上下留黑边
- **响应式** — 瑞士风格 UI；移动端缩略图以弹层显示

## 快速开始

```bash
npm install
npm run dev      # 本地开发
npm run build    # 产物输出到 dist/
npm run preview  # 预览构建产物
```

> 需要支持 WebGPU 的浏览器（Chrome / Edge 113+）。真 HDR 效果还需要 HDR 显示器并在系统中开启 HDR；否则 HDR 内容会回退为 SDR。

## 部署

推送到 `main` 分支会触发 GitHub Actions（`.github/workflows/deploy.yml`）构建并发布到 GitHub Pages。在仓库 **Settings → Pages → Source** 选择 **GitHub Actions** 即可。

## 文档

架构设计、Ultra HDR 增益图解码流程、WebGPU HDR 画布配置、小地图视锥投影等技术细节见 **[DEVELOPMENT.md](./DEVELOPMENT.md)**（含流程图）。

## 协议

[MIT](./LICENSE)
