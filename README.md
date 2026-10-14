# Panorama Viewer — WebGPU · HDR

**English** · [简体中文](./README_CN.md)

A panorama viewer built on **three.js WebGPU**. Drag in an equirectangular panorama to explore it, with **true HDR** display for **Ultra HDR** images.

🔗 Live demo: https://realsee-developer.github.io/panorama-viewer/

## Features

- **Formats**: AVIF · JPG · PNG · Ultra HDR JPG (gain map)
- **Controls**: drag with mouse / finger to look around; wheel / two-finger pinch to zoom (changes FOV)
- **True HDR**: for Ultra HDR images the WebGPU canvas is reconfigured to `rgba16float` + extended tone mapping for genuine HDR output; the page reports the display's HDR capability (`matchMedia('(dynamic-range: high)')`)
- **Meta + minimap**: the top-left panel shows the source format, resolution, aspect ratio and HDR status; the minimap renders the equirectangular thumbnail with the current view highlighted and the rest dimmed (drawn as a correct pole cap near the zenith/nadir), and you can click it to look that way
- **Aspect-ratio validation**: ratio `< 2:1` is rejected; `> 2:1` is automatically letterboxed (black bars top & bottom)
- **Swiss / International Typographic style UI**: grid-driven, high-contrast, red accent; on mobile the minimap opens as a modal

## How it works

- `WebGPURenderer` (`three/webgpu`) renders the panorama as an **equirectangular background** (`scene.background` + equirectangular mapping) with the camera at the origin, shading each pixel from the camera ray direction. The background path is more robust for large half-float HDR textures than mapping them onto a sphere material.
- Ultra HDR decoding does **not** use three.js's `UltraHDRLoader`, for two reasons:
  - its JPEG segment scanner misreads the MPF offset on some real-world files (those carrying an ICC APP2 segment, e.g. produced by `@realsee/hdr-toolbox`) and throws `Invalid typed array length`;
  - more importantly it **hardcodes** `maxDisplayBoost` to `sqrt(1.8 ^ HDRCapacityMax)` — roughly half the content's HDR capacity — which under-applies the gain map and leaves the image washed-out and flat.
- This project implements Ultra HDR decoding itself: it walks the JPEG segments to read the **MPF (APP2 "MPF\0")** directory and locate the primary and gain-map sub-images, reads the gain-map metadata (`GainMapMax`, `Gamma`, `HDRCapacityMax`, …) from the **gain-map sub-image's own APP1 XMP**, then composites the gain map **on the GPU** (TSL `scene.backgroundNode`), recovering HDR per the Android / ISO 21496-1 formula `hdr = (sdr + offsetSDR) * 2^(logBoost·weight) - offsetHDR`.
- **Live maxDisplayBoost**: because compositing happens on the GPU, `maxDisplayBoost` is a uniform, exposed as a slider in the top-left panel (Ultra HDR images only). HDR headroom is measured in stops (log2) — real HDR displays typically offer only 1.5–4 stops — so the slider ranges from `1× (pure SDR)` to `16× (4 stops)`, defaulting to `8× (3 stops)`. Dragging it takes effect instantly, with no re-decode.
- HDR canvas: three.js configures the WebGPU canvas as an 8-bit SDR preview format by default, so after `renderer.init()` we grab the same `GPUCanvasContext` and `configure()` it with `rgba16float` + `colorSpace: 'display-p3'` + `toneMapping: { mode: 'extended' }`, and also override `getPreferredCanvasFormat` so three's internal buffers match — mapping pixels above the SDR white point (> 1.0) into the display's HDR headroom.

## Development

```bash
npm install
npm run dev      # local dev server
npm run build    # output to dist/
npm run preview  # preview the production build
```

> Requires a WebGPU-capable browser (Chrome / Edge 113+). True HDR also needs an HDR display with HDR enabled in the OS.

## Deployment

On push to the `main` branch, GitHub Actions (`.github/workflows/deploy.yml`) builds and publishes to GitHub Pages automatically.

In the repo, go to **Settings → Pages → Build and deployment → Source** and select **GitHub Actions**.

Vite's `base` is set to `'./'` (relative paths), so the assets load correctly from the project-page subpath regardless of the repo name.

## Browser compatibility

| Capability | Requirement |
| --- | --- |
| Base rendering | WebGPU (Chrome/Edge 113+) |
| True HDR output | Chrome 121+ canvas `rgba16float` + extended tone mapping, with HDR enabled in the OS/display |
| AVIF decoding | Native `createImageBitmap` AVIF support |

If the browser does not support an HDR canvas, Ultra HDR images fall back to SDR display (the page labels this).
