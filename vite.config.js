import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

function browserRuntimeAssets() {
  const sdkDist = dirname(fileURLToPath(import.meta.resolve('@wasmer/sdk/browser')));
  const tfjsWasmDist = dirname(fileURLToPath(import.meta.resolve('@tensorflow/tfjs-backend-wasm')));
  const dependencies = ['node-network-rpc.js', 'capi-worker-bridge.js'];

  return {
    name: 'browser-runtime-assets',
    async generateBundle() {
      const emitDirectory = async (sourceDirectory, outputDirectory) => {
        for (const entry of await readdir(sourceDirectory, { withFileTypes: true })) {
          const sourcePath = resolve(sourceDirectory, entry.name);
          const outputPath = `${outputDirectory}/${entry.name}`;
          if (entry.isDirectory()) {
            await emitDirectory(sourcePath, outputPath);
          } else if (entry.isFile()) {
            this.emitFile({
              type: 'asset',
              fileName: outputPath,
              source: await readFile(sourcePath),
            });
          }
        }
      };

      for (const fileName of dependencies) {
        this.emitFile({
          type: 'asset',
          fileName: `assets/${fileName}`,
          source: await readFile(resolve(sdkDist, fileName)),
        });
      }
      await emitDirectory(resolve(sdkDist, '../pkg/snippets'), 'assets/snippets');
      for (const entry of await readdir(tfjsWasmDist, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith('.wasm')) {
          this.emitFile({
            type: 'asset',
            fileName: `assets/tfjs/${entry.name}`,
            source: await readFile(resolve(tfjsWasmDist, entry.name)),
          });
        }
      }
    },
  };
}

export default defineConfig({
  root: 'web',
  base: './',
  publicDir: 'public',
  plugins: [browserRuntimeAssets()],
  optimizeDeps: {
    exclude: ['@wasmer/sdk'],
  },
  worker: {
    format: 'es',
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    target: 'es2022',
    modulePreload: { polyfill: false },
  },
});
