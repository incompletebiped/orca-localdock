# Contributing

Thanks for your interest! LocalDock is a work in progress that's waiting on Orca plugin APIs (see [docs/ORCA-GAPS.md](docs/ORCA-GAPS.md)). Please open an issue to discuss a change before sending a large pull request.

## Development

```sh
npm install
npm test            # vitest across all packages
npm run typecheck
npm run lint
npm run build       # plugin → packages/orca-plugin/dist (load it in Orca: Settings → Plugin Development)
npm run preview     # panel preview with sample data → packages/orca-plugin/preview/index.html
```

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) explains how the pieces fit.

## Ground rules

- **No real infrastructure in the repo.** Use `example.com` and `203.0.113.x` in code, tests, fixtures and screenshots, and sanitize any captured server output.
- **Never build shell strings from input.** Use `shq` / `shellCommand` from `packages/core/src/util/shell.ts`.
- **Remote and local paths go through the guards** in `packages/core/src/util/remotePath.ts`.
- **The panel escapes everything** it renders (`esc` in `packages/orca-plugin/src/panel/render.ts`) and can't use `confirm()`/`alert()`, because the sandbox blocks them.
- **Orca-specific code stays behind `OrcaHost` and the panel bridge**, so the engine and UI never depend on Orca internals.
- Add tests for sync logic, path handling, panel rendering and anything that touches a server.
- Report security issues privately; see [SECURITY.md](SECURITY.md).
