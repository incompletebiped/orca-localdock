// Builds the plugin folder Orca loads (dist/) and, with --preview, a browser
// preview of the panel (preview/index.html).
//
//   dist/orca-plugin.json   manifest
//   dist/worker.mjs         worker bundle (engine included)
//   dist/panel/index.html   panel, with its script and styles inlined (Orca's panel CSP allows inline only)
import { build } from 'esbuild';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const preview = process.argv.includes('--preview');

/** Bundle a browser entry to a string of JS that's safe to inline in a <script>. */
async function bundleBrowser(entry) {
  const out = await build({
    entryPoints: [join(root, entry)],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    write: false,
    legalComments: 'none',
  });
  return out.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
}

function page({ title, css, js, body }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>${css}</style>
</head>
<body>
${body}
<script>${js}</script>
</body>
</html>
`;
}

await rm(dist, { recursive: true, force: true });
await mkdir(join(dist, 'panel'), { recursive: true });

await build({
  entryPoints: [join(root, 'src/worker/main.ts')],
  outfile: join(dist, 'worker.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  legalComments: 'none',
  // Some dependencies are CommonJS and use require() and __dirname (ssh2); give the ESM bundle both.
  banner: {
    js: [
      "import { createRequire as __ldCreateRequire } from 'node:module';",
      "import { fileURLToPath as __ldFileURLToPath } from 'node:url';",
      "import { dirname as __ldDirname } from 'node:path';",
      'const require = __ldCreateRequire(import.meta.url);',
      'const __filename = __ldFileURLToPath(import.meta.url);',
      'const __dirname = __ldDirname(__filename);',
    ].join(' '),
  },
  logLevel: 'warning',
});

const css = await readFile(join(root, 'src/panel/styles.css'), 'utf-8');
await writeFile(
  join(dist, 'panel/index.html'),
  page({ title: 'LocalDock', css, js: await bundleBrowser('src/panel/main.ts'), body: '<div id="app"></div>' }),
);
await copyFile(join(root, 'orca-plugin.json'), join(dist, 'orca-plugin.json'));
console.log('Built plugin → packages/orca-plugin/dist');

if (preview) {
  const dir = join(root, 'preview');
  await mkdir(dir, { recursive: true });
  const chrome = `
.preview-bar { display:flex; gap:8px; align-items:center; padding:8px 12px; font:12px system-ui; background:#111; color:#ccc; border-bottom:1px solid #333; }
.preview-wrap { display:flex; gap:16px; padding:16px; background:#0b0b0b; min-height:calc(100vh - 40px); }
#app { width:340px; border:1px solid #333; border-radius:8px; overflow:auto; max-height:calc(100vh - 72px); background:var(--ld-bg); }
#log { flex:1; margin:0; font:11px ui-monospace,monospace; color:#8b8; white-space:pre-wrap; }`;
  await writeFile(
    join(dir, 'index.html'),
    page({
      title: 'LocalDock panel preview',
      css: css + chrome,
      js: await bundleBrowser('src/preview/main.ts'),
      body: `<div class="preview-bar"><strong>LocalDock panel preview</strong><span>sample data · state:</span><select id="state"></select></div>
<div class="preview-wrap"><div id="app"></div><pre id="log">Actions you trigger show up here.</pre></div>`,
    }),
  );
  console.log('Built preview → packages/orca-plugin/preview/index.html');
}
