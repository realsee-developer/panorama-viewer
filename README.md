# Panorama Viewer — WebGPU · HDR

**English** · [简体中文](./README_CN.md)

A panorama viewer built on **three.js WebGPU**. Drag in an equirectangular panorama to explore it, with **true HDR** display for **Ultra HDR** images.

🔗 **Live demo:** https://realsee-developer.github.io/panorama-viewer/

## Features

- **Formats** — AVIF · JPG · PNG · Ultra HDR JPG (gain map)
- **Controls** — drag to look around; wheel / pinch to zoom (FOV)
- **True HDR** — Ultra HDR images render to an `rgba16float` HDR canvas; a live **maxDisplayBoost** slider controls how much of the gain map is applied
- **Minimap** — equirectangular thumbnail with your current view highlighted (click to look that way)
- **Robust input** — aspect ratio `< 2:1` is rejected, `> 2:1` is letterboxed
- **Responsive** — Swiss-style UI; the minimap becomes a modal on mobile

## Quick start

```bash
npm install
npm run dev      # local dev server
npm run build    # output to dist/
npm run preview  # preview the production build
```

> Requires a WebGPU browser (Chrome / Edge 113+). True HDR also needs an HDR display with HDR enabled in the OS; otherwise Ultra HDR falls back to SDR.

## Deployment

Pushing to `main` triggers GitHub Actions (`.github/workflows/deploy.yml`) to build and publish to GitHub Pages. In the repo, set **Settings → Pages → Source → GitHub Actions**.

## Documentation

Architecture, the Ultra HDR gain-map decoding pipeline, the WebGPU HDR canvas setup, and the minimap frustum projection are documented in **[DEVELOPMENT.md](./DEVELOPMENT.md)** (with a flow diagram).

## License

[MIT](./LICENSE)
