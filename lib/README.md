# Live2D Runtime Vendor Files

These files are local copies of the browser runtime scripts loaded by the Dustpan Live2D extra. Keeping them under `public/vendor/live2d-runtime` lets Vite copy them into `dist` and lets both the dev server and built Express app serve them from `/vendor/live2d-runtime/...`.

Sources downloaded on 2026-05-09:

- `TweenLite-1.20.2.js`: https://cdn.jsdelivr.net/npm/greensock@1.20.2/dist/TweenLite.js
- `live2d.min.js`: https://cdn.jsdelivr.net/gh/dylanNew/live2d/webgl/Live2D/lib/live2d.min.js
- `live2dcubismcore.min.js`: https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js
- `pixi-7.4.2.min.js`: https://cdn.jsdelivr.net/npm/pixi.js@7.4.2/dist/pixi.min.js
- `pixi-live2d-display-lipsyncpatch-0.5.0-ls-8.min.js`: https://cdn.jsdelivr.net/npm/pixi-live2d-display-lipsyncpatch@0.5.0-ls-8/dist/index.min.js
- `pixi-filters.min.js`: https://cdn.jsdelivr.net/npm/pixi-filters@latest/dist/browser/pixi-filters.min.js

Check upstream licenses before redistributing a packaged build.
