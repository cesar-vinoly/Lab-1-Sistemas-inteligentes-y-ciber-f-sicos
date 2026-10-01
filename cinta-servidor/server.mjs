/**
 * Punto de entrada del servidor HTTP de la cinta transportadora.
 * Sirve dist/, adjunta los canales WebSocket y abre el registro CSV.
 * El control reside en control/websocket.mjs y control/pid.mjs; el navegador
 * recibe estados y mediciones, pero no ejecuta el PID del sistema físico.
 * Las rutas de archivos se resuelven respecto de este módulo, no del directorio de ejecución.
 */
// Servidor local sin dependencias externas. Ejecutar: node server.mjs
import http from 'node:http';
import {startupMessage} from './control/startup-message.mjs';
import {createReadStream} from 'node:fs';
import {realpath, stat} from 'node:fs/promises';
import {extname, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {pipeline} from 'node:stream/promises';
import {spawn} from 'node:child_process';
import {attachControlSocket} from './control/websocket.mjs';
import {createSpeedCsv} from './control/speed-csv.mjs';

/* Puerto y dirección de escucha: argumentos explícitos prevalecen sobre entorno.
 * Se conserva el alcance de red existente; el mensaje no abre nuevas interfaces. */
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

/* Comprueba que la distribución compilada exista antes de admitir conexiones. */
let webRoot;
try {
  webRoot = await realpath(fileURLToPath(new URL('./dist/', import.meta.url)));
  if (!(await stat(resolve(webRoot, 'index.html'))).isFile()) throw new Error();
} catch {
  console.error('Falta dist/index.html. Extrae todo el ZIP o ejecuta: npm ci y npm run build.');
  process.exit(1);
}

/* Tipos MIME necesarios para HTML, módulos, modelos GLB, imágenes y fuentes. */
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
/* Respuesta textual uniforme; HEAD envía cabeceras pero no cuerpo. */
function reply(res, status, message, head = false) {
  const body = Buffer.from(message + '\n', 'utf8');
  res.writeHead(status, {'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': body.length});
  res.end(head ? undefined : body);
}

/* Servidor de archivos estáticos: solo GET/HEAD y rutas contenidas en dist.
 * realpath también impide escapar de la raíz mediante enlaces simbólicos. */
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

/* Inicia registro CSV asíncrono; se omite su aviso de éxito en la consola.
 * Los errores conservan diagnóstico visible y no detienen el servicio de control. */
let speedCsv;
try {
  speedCsv = await createSpeedCsv(fileURLToPath(new URL('./datos/', import.meta.url)));
} catch (error) {
  console.error('No se pudo iniciar el registro CSV:', error.message);
}
const controlSocket = attachControlSocket(server, {speedCsv});
server.on('error', error => {
  if (error.code === 'EADDRINUSE') console.error(`El puerto ${port} esta ocupado. Proba: node server.mjs --port ${port < 65535 ? port + 1 : 8001}`);
  else console.error('No se pudo iniciar el servidor:', error.message);
  void speedCsv?.close();
  process.exitCode = 1;
});
server.listen(port, host, () => {
  // Mensaje institucional; la dirección LAN procede de las interfaces del equipo.
  const {url,text}=startupMessage(host,port);
  console.log(text);
  if (openBrowser) {
    const command = process.platform === 'win32' ? 'rundll32.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    const openArgs = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
    const child = spawn(command, openArgs, {stdio: 'ignore', detached: true, windowsHide: true});
    child.on('error', () => console.log('Abri el enlace anterior manualmente en tu navegador.'));
    child.unref();
  }
});
/* Cierre ordenado: detiene WebSocket/HTTP y espera el vaciado del CSV.
 * La bandera impide ejecutar dos cierres simultáneos por señales repetidas. */
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
  if (stopping) return;
  stopping = true;
  controlSocket.close();
  const httpClosed = new Promise(resolve => server.close(resolve));
  server.closeAllConnections();
  await Promise.all([httpClosed, speedCsv?.close()]);
  process.exit(0);
});
