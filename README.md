# Sales Copilot Extension

This extension is built with Vite and `@crxjs/vite-plugin`.

## Development

Install dependencies, then build the unpacked extension:

```sh
npm install
npm run build
```

Load the generated `dist` directory in Chrome via `chrome://extensions` -> `Load unpacked`.

Do not load the source directory directly. The source uses ES module imports in extension files, and the Vite build rewrites those files into the Chrome-compatible bundle.

# Sales-Copilot
