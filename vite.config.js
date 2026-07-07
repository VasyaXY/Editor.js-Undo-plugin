import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    emptyOutDir: false,
    lib: {
      entry: fileURLToPath(new URL('./src/browser.ts', import.meta.url)),
      name: 'EditorJSUndo',
      formats: [ 'iife' ],
      fileName: () => 'editorjs-undo.js',
    },
    minify: 'esbuild',
    rollupOptions: {
      output: {
        exports: 'default',
        inlineDynamicImports: true,
      },
    },
    sourcemap: false,
    target: 'es2017',
  },
});
