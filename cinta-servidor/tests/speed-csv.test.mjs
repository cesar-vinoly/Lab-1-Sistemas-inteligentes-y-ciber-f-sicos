/**
 * Pruebas automatizadas de persistencia de muestras y correspondencia exacta con la gráfica.
 * Los relojes/dispositivos simulados permiten reproducir transiciones sin hardware.
 * Estas verificaciones no sustituyen un ensayo físico de la cinta.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {createSpeedCsv} from '../control/speed-csv.mjs';
import {attachControlSocket} from '../control/websocket.mjs';
import {WebSocket} from '../vendor/ws/wrapper.mjs';

test('CSV conserva muestras WebSocket y valores exactos de la gráfica, incluso sin navegador',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'cinta-csv-'));
  const csv=await createSpeedCsv(dir);
  const server=http.createServer();let now=1000;
  const frames=[];
  const bridge=attachControlSocket(server,{clock:()=>now,speedCsv:{record(frame){frames.push(frame);csv.record(frame);}}});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const esp=new WebSocket(`ws://127.0.0.1:${server.address().port}/ws/esp32`);
  try{
    await once(esp,'open');
    const data={dir:'FWD',v:50,m:8,rpm_m:75,rpm_t:35.6,rpm_r:35.5,vel_t:5.5,vel_r:5.48,dist:14,pos:10,err:0,state:'OK'};
    esp.send(JSON.stringify(data));
    const wait=async n=>{for(let i=0;i<100&&frames.length<n;i++)await new Promise(r=>setTimeout(r,10));assert.equal(frames.length,n);};
    await wait(1);now=1250;
    esp.send('invalid');esp.send(JSON.stringify({...data,dir:'STOP',rpm_m:0,rpm_r:0,vel_r:0,vel_t:null}));
    await wait(2);await csv.close();
    const rows=(await readFile(csv.filename,'utf8')).trim().split('\r\n').map(row=>row.split(','));
    assert.equal(rows.length,3);
    for(let i=0;i<2;i++){
      const row=rows[i+1],frame=frames[i];
      assert.equal(row[0],new Date(frame.at).toISOString());
      assert.equal(row[3],String(frame.data.vel_r));
      assert.equal(row[4],frame.data.vel_t===null?'':String(frame.data.vel_t));
      assert.equal(row[5],String(frame.model.speedCmS));
    }
    assert.equal(rows[1][1],'0');assert.equal(rows[2][1],'0.25');
    const second=await createSpeedCsv(dir);assert.notEqual(second.filename,csv.filename);await second.close();
  }finally{esp.terminate();bridge.close();await csv.close();await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});
