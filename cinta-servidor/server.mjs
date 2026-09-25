// Servidor local sin dependencias externas. Ejecutar: node server.mjs
import http from 'node:http';
import {createReadStream} from 'node:fs';
import {realpath, stat} from 'node:fs/promises';
import {extname, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {pipeline} from 'node:stream/promises';
import {spawn} from 'node:child_process';
import {attachControlSocket} from './control/websocket.mjs';

let port = Number(process.env.CINTA_PORT || 8000);
let host = process.env.CINTA_HOST || '127.0.0.1';
let openBrowser = false;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--open') openBrowser = true;
  else if (args[i] === '--port' && args[i + 1]) port = Number(args[++i]);
  else if (args[i] === '--host' && args[i + 1]) host = args[++i];
  else {
    console.error('Uso: node server.mjs [--port 8000] [--host 127.0.0.1] [--open]');
    process.exit(1);
  }
}
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('El puerto debe ser un numero entero entre 1 y 65535.');
  process.exit(1);
}

let webRoot;
try {
  webRoot = await realpath(fileURLToPath(new URL('./dist/', import.meta.url)));
  if (!(await stat(resolve(webRoot, 'index.html'))).isFile()) throw new Error();
} catch {
  console.error('Falta dist/index.html. Extrae todo el ZIP o ejecuta: npm ci y npm run build.');
  process.exit(1);
}

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.wasm': 'application/wasm',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};
const insideRoot = path => path.startsWith(webRoot + sep);
function reply(res, status, message, head = false) {
  const body = Buffer.from(message + '\n', 'utf8');
  res.writeHead(status, {'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': body.length});
  res.end(head ? undefined : body);
}

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-cache');
  const head = req.method === 'HEAD';
  if (req.method !== 'GET' && !head) {
    res.setHeader('Allow', 'GET, HEAD');
    return reply(res, 405, 'Metodo no permitido.');
  }
  try {
    let pathname;
    try { pathname = decodeURIComponent((req.url || '/').split('?')[0]); }
    catch { return reply(res, 400, 'Ruta invalida.', head); }
    if (!pathname.startsWith('/') || /[\\\u0000-\u001f]/.test(pathname) || pathname.split('/').some(p => p.startsWith('.'))) {
      return reply(res, 403, 'Ruta no permitida.', head);
    }
    if (pathname === '/') pathname = '/index.html';
    const candidate = resolve(webRoot, '.' + pathname);
    if (!insideRoot(candidate)) return reply(res, 403, 'Ruta no permitida.', head);
    const filename = await realpath(candidate);
    if (!insideRoot(filename)) return reply(res, 403, 'Ruta no permitida.', head);
    const info = await stat(filename);
    if (!info.isFile()) return reply(res, 404, 'Archivo no encontrado.', head);
    res.writeHead(200, {
      'Content-Type': types[extname(filename).toLowerCase()] || 'application/octet-stream',
      'Content-Length': info.size,
    });
    if (head) return res.end();
    await pipeline(createReadStream(filename), res);
  } catch (error) {
    if (res.headersSent || res.destroyed) return;
    const missing = error.code === 'ENOENT' || error.code === 'ENOTDIR';
    reply(res, missing ? 404 : 500, missing ? 'Archivo no encontrado.' : 'No se pudo leer el archivo.', head);
  }
});

const controlSocket = attachControlSocket(server);
server.on('error', error => {
  if (error.code === 'EADDRINUSE') console.error(`El puerto ${port} esta ocupado. Proba: node server.mjs --port ${port < 65535 ? port + 1 : 8001}`);
  else console.error('No se pudo iniciar el servidor:', error.message);
  process.exitCode = 1;
});
server.listen(port, host, () => {
  const address = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  const url = `http://${address.includes(':') ? '[' + address + ']' : address}:${port}/`;
  console.log(`
========================================
   CINTA TRANSPORTADORA - GEMELO DIGITAL
========================================

Servidor iniciado correctamente.

Acceso local:
${url}
`);
  if (openBrowser) {
    const command = process.platform === 'win32' ? 'rundll32.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    const openArgs = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
    const child = spawn(command, openArgs, {stdio: 'ignore', detached: true, windowsHide: true});
    child.on('error', () => console.log('Abri el enlace anterior manualmente en tu navegador.'));
    child.unref();
  }
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  controlSocket.close();
  server.close(() => process.exit(0));
  server.closeAllConnections();
});
