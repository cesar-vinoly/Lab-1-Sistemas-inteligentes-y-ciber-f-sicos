/**
 * Pruebas automatizadas de estructura de interfaz y mando único.
 * Los relojes/dispositivos simulados permiten reproducir transiciones sin hardware.
 * Estas verificaciones no sustituyen un ensayo físico de la cinta.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {createServer} from 'vite';
import {LabState} from '../app/lab-state.ts';
import {parseTelemetry} from '../shared/control-protocol.mjs';
import {ConveyorController} from '../control/pid.mjs';

const pidSwitch=html=>html.match(/class="pid-toggle"><input[^>]+>/)?.[0]??'';
const button=(html,label)=>html.match(new RegExp('<button[^>]*>'+label+'</button>'))?.[0]??'';

test('una sola interfaz, un mando, visor y todos los paneles; sin lateral heredado',async()=>{
  // Render component markup only, with no browser, HTTP listener or WebGL.
  const vite=await createServer({root:fileURLToPath(new URL('..',import.meta.url)),server:{middlewareMode:true,hmr:false},logLevel:'error'});
  try{
    const module=await vite.ssrLoadModule('/app/control-dashboard.tsx');
    const html=renderToStaticMarkup(createElement(module.default));
    for(const name of ['Gemelo digital','Mando','Medición','Modelo','Divergencias','Velocidad de la banda','Posición del objeto'])assert.ok(html.includes('>'+name+'<'),name);
    for(const name of ['Adelante','Reversa','Detener','Paro inmediato']){
      assert.equal((html.match(new RegExp('>'+name+'</button>','g'))||[]).length,1,name);
      assert.match(button(html,name),/disabled=""/);
    }
    assert.equal((html.match(/<main /g)||[]).length,1);
    assert.equal((html.match(/<h1>/g)||[]).length,1);
    assert.equal((html.match(/id="visor"/g)||[]).length,1);
    assert.equal((html.match(/id="mando-title"/g)||[]).length,1);
    assert.doesNotMatch(html,/<aside|Material de la base|Medidas de la base|Componentes|Sentido 1|Sentido 2|animación local|Volver al 3D/);
    assert.match(html,/PID de aproximación y velocidad/);
    assert.match(html,/Modelo G\(s\)/);
    assert.match(html,/<div class="plant-equation" role="math" aria-label="G de s igual a la fracción:/);
    assert.match(html,/<span class="plant-numerator">0\.004656 <i>s<\/i> \+ 0\.1425<\/span>/);
    assert.match(html,/<span class="plant-denominator"><i>s<\/i><sup>2<\/sup> \+ 4\.286 <i>s<\/i> \+ 8\.058<\/span>/);
    const timing=html.match(/<div class="pid-fields pid-timing">(.*?)<\/div>/)?.[1]??'';
    const gains=html.match(/<div class="pid-fields pid-coefficients">(.*?)<\/div>/)?.[1]??'';
    assert.match(timing,/Distancia objetivo \(cm\)/);assert.match(timing,/Muestreo \(ms\)/);
    assert.equal((timing.match(/<input/g)||[]).length,2);
    for(const label of ['Kp','Ki','Kd'])assert.ok(gains.includes('>'+label+'<'));
    assert.equal((gains.match(/<input/g)||[]).length,3);
    assert.ok(html.indexOf(timing)<html.indexOf(gains));
    assert.ok(html.indexOf('>Adelante</button>')<html.indexOf('>Detener</button>'));
    assert.ok(html.indexOf('>Detener</button>')<html.indexOf('>Reversa</button>'));
    for(const label of ['Distancia objetivo (cm)','Kp','Ki','Kd','Muestreo (ms)'])assert.ok(html.includes(label));
    assert.doesNotMatch(html,/Velocidad inicial \(%\)|Velocidad mínima \(%\)|Velocidad máxima \(%\)/);
    assert.match(html,/base y máxima del PID es siempre 100 %/);
    assert.match(html,/Referencia ESP32/);
    assert.doesNotMatch(html,/Registro de eventos|Conexión WebSocket de la ESP32|websocket-help|class="registro"|Consultar estado|IP_DE_TU_PC/);
    assert.match(html,/Sin posición disponible/);
    assert.equal((html.match(/class="trend"/g)||[]).length,2);
    assert.equal((html.match(/type="checkbox"/g)||[]).length,5); // Three faults, grid and PID switch.
    for(const label of ['Acercar','Alejar','Encuadrar conjunto','Restablecer vista','Mostrar cuadrícula'])assert.ok(html.includes('aria-label="'+label+'"'),label);

    const state=new LabState(()=>0);state.setBridge(true);state.setLink(true,'device');
    const render=()=>renderToStaticMarkup(createElement(module.Dashboard,{state:state.snapshot(),send:()=>{},setFault:()=>{},sendPid:()=>{}}));
    state.ingest(parseTelemetry('DIR=REV,V=65,M=16,RPM_M=97.5,RPM_R=46.3,VEL_R=7.2,STATE=OK'));
    const moving=render();
    assert.doesNotMatch(pidSwitch(moving),/disabled/); // No ultrasound object required.
    assert.match(button(moving,'Reversa'),/aria-pressed="true"/);
    assert.match(button(moving,'Adelante'),/aria-pressed="false"/);
    assert.match(moving,/<input[^>]*id="lab-velocity"[^>]*value="65"/);
    assert.match(moving,/<option value="16" selected="">1\/16/);
    assert.match(moving,/<select[^>]*id="lab-micro"[^>]*disabled=""/);
    state.command({type:'command',id:'stop',command:'E',status:'queued',response:'E',latencyMs:null});
    assert.match(button(render(),'Detener'),/aria-pressed="true"/);
    state.ingest(parseTelemetry('DIR=STOP,V=25,M=4,RPM_M=0,RPM_R=0,VEL_R=0,STATE=OK'));
    state.command({type:'command',id:'stop',command:'E',status:'ack',response:'E',latencyMs:null});
    const stopped=render();
    assert.doesNotMatch(pidSwitch(stopped),/disabled/); // Encoder = 0 allows activation.
    assert.match(button(stopped,'Detener'),/aria-pressed="true"/);
    assert.match(stopped,/<input[^>]*id="lab-velocity"[^>]*value="25"/);
    assert.match(stopped,/<option value="4" selected="">1\/4/);
    assert.doesNotMatch(stopped,/<select[^>]*disabled=""/);
    state.setLink(false,null);
    const offline=render();
    assert.match(pidSwitch(offline),/disabled/);
    for(const name of ['Adelante','Reversa','Detener'])assert.match(button(offline,name),/aria-pressed="false"/);

    const controller=new ConveyorController();controller.reset(0);
    const raw=parseTelemetry('DIR=STOP,V=50,M=8,RPM_M=0,RPM_R=0,VEL_R=0,POS=NA,STATE=OK');
    controller.observe(raw,0);controller.enable(0);
    state.setLink(true,'device-2');state.setController(controller.snapshot());state.ingest(raw);
    const automatic=render();assert.match(pidSwitch(automatic),/checked=""/);
    assert.doesNotMatch(automatic,/id="lab-velocity"/);assert.match(automatic,/Base 100 %/);
    for(const name of ['Adelante','Reversa','Detener'])assert.doesNotMatch(button(automatic,name),/disabled/);
    controller.manual('S',0);state.setController(controller.snapshot());
    assert.match(render(),/PID activo · cinta detenida/);assert.match(pidSwitch(render()),/checked=""/);
    state.setBridge(false);const bridgeLost=render();
    assert.match(pidSwitch(bridgeLost),/checked=""/);assert.match(pidSwitch(bridgeLost),/disabled/);
    assert.doesNotMatch(bridgeLost,/>PID desactivado</);
    state.setBridge(true);assert.doesNotMatch(pidSwitch(render()),/disabled/); // User can disable with ESP offline.
    state.setLink(true,'device-3');assert.match(pidSwitch(render()),/checked=""/);
    controller.disable(0);state.setController(controller.snapshot());
    assert.doesNotMatch(pidSwitch(render()),/checked=""/);assert.match(render(),/PID desactivado/);
  }finally{await vite.close();}
});
