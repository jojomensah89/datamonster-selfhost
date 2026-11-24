# Third-party notices

DataMonster contains code from Minilytics (https://github.com/surendrapandar/minilytics), used under the MIT License below. Minilytics source revision: 3243342.

```
MIT License

Copyright (c) 2026 surendrapandar

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Fonts

- **IBM Plex Mono** (`public/fonts/IBMPlexMono-*`), Copyright IBM Corp., licensed under the SIL Open Font License 1.1. Full text in `public/fonts/IBMPlexMono-OFL.txt`.
- **General Sans** by the Indian Type Foundry is not included in this repository. Its ITF Free Font License allows self-hosting but not redistribution, so `scripts/fetch-fonts.mjs` downloads it from Fontshare at build time, together with its licence file.

## Map data

- **Natural Earth** 1:110m land (https://www.naturalearthdata.com, retrieved from https://github.com/nvkelso/natural-earth-vector), public domain. `scripts/build-land-dots.mjs` samples it into the dot grids in `src/dashboard/assets/land-dots.ts` that the live map draws. It is a coarse display mask, not a boundary authority.

## Flags

- **circle-flags** 2.8.3 by HatScripts (https://github.com/HatScripts/circle-flags), MIT License. The 264 two-letter country flags are copied unchanged into `public/flags/`. Each is a separate static file that the dashboard fetches only when that flag is shown (`Flag` in `src/dashboard/components/Icons.tsx`), so none of them is in the JavaScript bundle.

```
MIT License

Copyright (c) 2026 HatScripts

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## QR codes

- **qrcode-generator** 2.0.4 by Kazuhiko Arase (https://github.com/kazuhikoarase/qrcode-generator), MIT License (http://www.opensource.org/licenses/mit-license.php), Copyright (c) 2009 Kazuhiko Arase. It is bundled into the dashboard JavaScript and encodes tracked-link QR codes in the browser, with no network request. "QR Code" is a registered trademark of DENSO WAVE INCORPORATED.

## Launch directories list

- Names, addresses and categories in `src/shared/directories.json` come from the **OpenLaunch** platform registry (https://github.com/Securiteru/openlaunch), MIT License, Copyright (c) 2026 OpenLaunch contributors.
