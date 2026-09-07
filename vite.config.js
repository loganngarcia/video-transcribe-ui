import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

function wasmerRuntimeAssets() {
  const sdkDist = dirname(fileURLToPath(import.meta.resolve('@wasmer/sdk/browser')));
  const dependencies = ['node-network-rpc.js', 'capi-worker-bridge.js'];

  return {
    name: 'wasmer-sdk-runtime-assets',
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
    },
  };
}

export default defineConfig({
  root: 'web',
  base: './',
  publicDir: 'public',
  plugins: [wasmerRuntimeAssets()],
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
