# Images

Everything here uses the panel's sample states (`packages/orca-plugin/src/preview/fixtures.ts`): example.com and other made-up names, never a real site.

| File | Size | Used for |
|---|---|---|
| `icon.png` | 256×256 | The manifest `icon` |
| `cover.png` | 1600×1000 | The manifest `cover`, and the top of the README |
| `social-preview.png` | 1280×640 | GitHub's social preview (Settings → General → Social preview; GitHub has no API for it) |
| `screenshot-*.png` | 1600×1000 | The manifest `screenshots` |
| `panel-*.png` | 720 wide | The README's screenshots: the sidebar at 2× |

The manifest (`orca-plugin.json` at the repository root) names `icon.png`, `cover.png` and the `screenshot-*.png` files here directly.

## Making them again

The sources are in `src/`: `icon.svg`, and HTML pages laid out at the exact image size (`social.html`, `cover.html`, and `screenshot.html`, which takes its title, text and panels from the URL hash). They embed the `panel-*.png` shots, so take those first.

1. `npm run preview`, then open `packages/orca-plugin/preview/index.html#state=<sample state>&bare=1` in a browser. `bare=1` shows just the panel, 360px wide. For a 2× shot, set the viewport to 720px wide, set `document.documentElement.style.zoom = '2'`, and take a full-page screenshot.
2. Open each page in `src/` with the viewport at its size (1280×640 or 1600×1000) and screenshot it.
3. For `icon.png`, draw `icon.svg` onto a 256×256 canvas and save it as PNG, so the rounded corners stay transparent.

Orca's browser does all of this from the command line: `orca viewport`, `orca eval`, `orca screenshot` and `orca full-screenshot`.
