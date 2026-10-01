/**
 * Configuración de desarrollo y compilación del frontend. El alias @ apunta
 * a la raíz del proyecto. El servidor Vite de desarrollo redirige /ws al
 * backend en 8000; la aplicación compilada se entrega desde dist/.
 */
import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import {fileURLToPath, URL} from 'node:url';

export default defineConfig({
  plugins: [react()],
  resolve: {alias: {'@': fileURLToPath(new URL('.', import.meta.url))}},
  server: {host: '127.0.0.1', port: 5173, strictPort: true,
    proxy: {'/ws': {target:'ws://127.0.0.1:8000',ws:true,changeOrigin:false}}},
  build: {outDir: 'dist'},
});
