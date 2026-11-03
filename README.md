# Panorama Viewer — WebGPU · HDR

**English** · [简体中文](./README_CN.md)

A panorama viewer built on **three.js WebGPU**. Drag in an equirectangular panorama to explore it, with **true HDR** display for **Ultra HDR**, **HDR AVIF** (10-bit PQ/HLG and gain map), **EXR**, and **Radiance HDR** images.

🔗 **Live demo:** https://realsee-developer.github.io/panorama-viewer/

## Features

- **Formats** — AVIF (8-bit SDR · 10/12-bit PQ/HLG HDR · gain map) · JPG · PNG · Ultra HDR JPG (gain map) · OpenEXR (`.exr`) · Radiance HDR (`.hdr`)
- **Controls** — drag to look around; wheel / pinch to zoom (FOV)
- **True HDR** — Ultra HDR images, HDR AVIF (10-bit PQ/HLG and ISO 21496-1 gain map) and `.exr` / `.hdr` linear-float panoramas all render to an `rgba16float` HDR canvas. HDR AVIF is decoded via libavif-wasm (lazy-loaded); every HDR source ends up as an SDR base + gain map composited on the GPU, so a live **maxDisplayBoost** slider controls how much of the gain map is applied
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

> Requires a WebGPU browser (Chrome / Edge 113+). True HDR also needs an HDR display with HDR enabled in the OS; otherwise HDR content falls back to SDR.

## Deployment

Pushing to `main` triggers GitHub Actions (`.github/workflows/deploy.yml`) to build and publish to GitHub Pages. In the repo, set **Settings → Pages → Source → GitHub Actions**.

## Documentation

Architecture, the Ultra HDR gain-map decoding pipeline, the WebGPU HDR canvas setup, and the minimap frustum projection are documented in **[DEVELOPMENT.md](./DEVELOPMENT.md)** (with a flow diagram).

## Engineering articles

- [From Ultra HDR to Space HDR](https://www.realsee.ai/blogs/dev/realsee-ultra-hdr-to-space-hdr?utm_source=github&utm_medium=referral&utm_campaign=dev_blogs_webgpu_space_hdr_202610&utm_content=panorama_viewer_readme_en): how the SDR base, gain map and recovery parameters follow panorama sampling, detail loading and viewpoint changes. Includes an interactive tour and an HDR capability checker.
- [Realsee’s full WebGPU renderer rewrite](https://www.realsee.ai/blogs/dev/webgpu-spatial-rendering-engineering?utm_source=github&utm_medium=referral&utm_campaign=dev_blogs_webgpu_space_hdr_202610&utm_content=panorama_viewer_readme_en): materials, viewport-driven detail, color handling, resource lifecycles and image output, in pursuit of the ultimate 3D experience.

This viewer provides the public panorama-viewing capability. The Space HDR article covers the wider capture-to-presentation chain and spatial navigation. In the linked tour, enter the first panorama and look for its **24K HDR** badge. If it is absent, use the article’s checker to inspect browser and display support.

[Discuss HDR integration](https://github.com/realsee-developer/panorama-viewer/discussions/1?utm_source=github&utm_medium=referral&utm_campaign=dev_blogs_webgpu_space_hdr_202610&utm_content=readme_hdr_discussion_en).

## Current code license

The identified Realsee-authored code is available under [PolyForm Noncommercial License 1.0.0](LICENSE), SPDX `PolyForm-Noncommercial-1.0.0`. The unmodified license governs permitted purposes, modification and distribution. This is source-available licensing, not an OSI-approved open source license. SDKs, third-party components and assets retain their separate terms. Earlier licensed copies retain their applicable rights, irrespective of this license change or Git history consolidation.
