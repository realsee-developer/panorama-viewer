# Panorama Viewer — WebGPU · HDR

一个基于 **three.js WebGPU** 的全景图查看器。拖拽一张等距圆柱（equirectangular）全景图即可浏览，支持 **Ultra HDR** 图片的真 HDR 显示。

## 功能

- **格式支持**：AVIF · JPG · PNG · Ultra HDR JPG（gain map）
- **交互**：鼠标 / 手指拖拽改变视角；滚轮 / 双指 pinch 缩放（改变 FOV）
- **真 HDR**：加载 Ultra HDR 图片时，通过 WebGPU 将画布重配置为 `rgba16float` + extended tone mapping 输出真 HDR；页面显示显示器 HDR 支持情况（`matchMedia('(dynamic-range: high)')`）
- **元信息 + 缩略图**：左上角显示原图格式、分辨率、宽高比、HDR 状态；缩略图以等距圆柱方式渲染，当前视角区域高亮、其余变暗，支持点击看向对应方向
- **宽高比校验**：宽高比 `< 2:1` 直接报错；`> 2:1` 自动上下留黑边（letterbox）
- **瑞士国际主义风格 UI**：网格化、高对比、红色点缀；移动端缩略图以弹层（modal）显示

## 技术要点

- `WebGPURenderer`（`three/webgpu`）以**等距圆柱背景**（`scene.background` + equirectangular mapping）渲染全景，相机位于原点，按相机光线方向逐像素绘制。相比把大尺寸半浮点纹理贴到球面材质，背景路径对 HDR 浮点纹理更稳定。
- Ultra HDR 解码**不使用** three.js 的 `UltraHDRLoader`，原因有二：
  - 其 JPEG 段扫描器对部分真实文件（含 ICC APP2 段、`@realsee/hdr-toolbox` 生成）会误读 MPF 偏移而抛 `Invalid typed array length`；
  - 更关键的是它把 `maxDisplayBoost` **写死**为 `sqrt(1.8 ^ HDRCapacityMax)`，约等于内容 HDR 能力的一半，导致增益图被严重欠应用、画面灰暗发白。
- 本项目自行实现 Ultra HDR 解码：正确遍历 JPEG 段读取 **MPF（APP2 "MPF\0"）** 定位 primary 与 gain-map 两张子图，从 **gain-map 子图自身的 APP1 XMP** 读取增益图元数据（`GainMapMax`、`Gamma`、`HDRCapacityMax` 等），然后把 **增益图合成放到 GPU**（TSL `scene.backgroundNode`）：按 Android / ISO 21496-1 公式 `hdr = (sdr + offsetSDR) * 2^(logBoost·weight) - offsetHDR` 逐像素恢复 HDR。
- **maxDisplayBoost 实时可调**：由于合成在 GPU 上进行，`maxDisplayBoost` 是一个 uniform，左上角面板提供滑块（仅 Ultra HDR 图显示），范围 `1×（纯 SDR）~ 2^HDRCapacityMax（完整 HDR 强度）`，拖动即时生效、无需重新解码。
- HDR 画布：three.js 默认把 WebGPU 画布配置为 8-bit SDR 预览格式，因此我们在 `renderer.init()` 之后取出同一个 `GPUCanvasContext`，用 `rgba16float` + `colorSpace: 'display-p3'` + `toneMapping: { mode: 'extended' }` 重新 `configure()`，并同步覆盖 `getPreferredCanvasFormat` 让 three 内部缓冲格式匹配，使超过 SDR 白点（> 1.0）的像素映射到显示器的 HDR headroom。

## 开发

```bash
npm install
npm run dev      # 本地开发
npm run build    # 产物输出到 dist/
npm run preview  # 预览构建产物
```

> 需要支持 WebGPU 的浏览器（Chrome / Edge 113+）。真 HDR 效果还需要 HDR 显示器并在系统中开启 HDR。

## 部署

推送到 `main` 分支后，GitHub Actions（`.github/workflows/deploy.yml`）自动构建并发布到 GitHub Pages。

在仓库 **Settings → Pages → Build and deployment → Source** 选择 **GitHub Actions** 即可。

Vite 的 `base` 设为 `'./'`（相对路径），因此无论仓库名是什么，项目页子路径都能正确加载资源。

## 浏览器兼容性说明

| 能力 | 要求 |
| --- | --- |
| 基础渲染 | WebGPU（Chrome/Edge 113+） |
| 真 HDR 输出 | Chrome 121+ 的 canvas `rgba16float` + extended tone mapping，且系统/显示器开启 HDR |
| AVIF 解码 | 浏览器原生 `createImageBitmap` 支持 AVIF |

若浏览器不支持 HDR 画布，Ultra HDR 图片会回退为 SDR 显示（页面会标注）。
