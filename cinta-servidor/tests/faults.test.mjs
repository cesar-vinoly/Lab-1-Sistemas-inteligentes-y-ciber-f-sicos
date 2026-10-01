/**
 * Pruebas automatizadas de limitación física de comando, combinación de fallas y prioridad de parada.
 * Los relojes/dispositivos simulados permiten reproducir transiciones sin hardware.
 * Estas verificaciones no sustituyen un ensayo físico de la cinta.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {FaultSimulation} from '../control/faults.mjs';
import {ConveyorController} from '../control/pid.mjs';
import {attachControlSocket} from '../control/websocket.mjs';
import {WebSocket} from '../vendor/ws/wrapper.mjs';
const raw=(extra={})=>({dir:'FWD',v:100,m:8,rpm_m:150,rpm_t:71.25,rpm_r:71.25,vel_t:11,vel_r:11,dist:null,pos:null,state:'OK',err:0,...extra});
async function until(fn){for(let i=0;i<200;i++){if(fn())return;await delay(5);}assert.ok(fn(),'Tiempo de espera agotado');}

test('factores físicos combinados, progresión, restauración y validación',()=>{
 const f=new FaultSimulation();assert.equal(f.command(100,0),100);
 f.set('perdida_vel',true,0);assert.equal(f.command(80,0),60);
 f.set('sobrecarga',true,0);assert.equal(f.command(100,5000),52);assert.equal(f.command(100,10000),33);
 f.set('sobrecarga',true,10000);assert.equal(f.command(100,10000),33);
 f.set('perdida_vel',false,10000);assert.equal(f.command(100,10000),45);
 f.set('sobrecarga',false,10000);assert.equal(f.command(100,10000),100);
 f.set('deslizamiento',true,10000);assert.equal(f.command(100,10000),100);assert.equal(f.command(0,0),0);
 assert.throws(()=>f.set('__proto__',true,0));assert.throws(()=>f.set('perdida_vel','true',0));
});

test('PID respeta límite físico, conserva encoder y objetivo, se recupera y no acumula integral',()=>{
 const c=new ConveyorController();c.reset(0);c.observe(raw({dir:'STOP',rpm_m:0,rpm_r:0,vel_r:0}),0);c.setSpeedLimit(75);c.enable(0);
 let next=c.tick(0);assert.equal(Math.abs(next.output),75);c.applied(next.output,0);
 for(let now=250;now<=5000;now+=250){
   c.observe(raw({dir:'REV',v:75,rpm_m:112.5,rpm_r:53.4,vel_r:8.25}),now);
   next=c.tick(now);if(next?.output!==undefined){assert.ok(Math.abs(next.output)<=75);c.applied(next.output,now);}
   assert.equal(c.latest.vel_r,8.25);
 }
 c.setSpeedLimit(33);c.observe(raw({dir:'REV',vel_r:8}),5250);next=c.tick(5250);assert.ok(Math.abs(next.output)<=33);c.applied(next.output,5250);
 c.observe(raw({dir:'REV',dist:20,pos:20}),5500);next=c.tick(5500);assert.equal(next.output,0);c.applied(0,5500);assert.ok(c.enabled);
 c.setSpeedLimit(100);c.observe(raw({dir:'STOP',vel_r:0,rpm_r:0,rpm_m:0}),5750);c.tick(5750);
 c.observe(raw({dir:'STOP',vel_r:0,rpm_r:0,rpm_m:0}),6000);next=c.tick(6000);assert.equal(Math.abs(next.output),100);assert.ok(c.enabled);
});

test('WebSocket: fallas manuales físicas, ACK, varias webs, paro, reversa, telemetría y reconexión',async()=>{
 let now=0;const server=http.createServer();const frames=[];
 const bridge=attachControlSocket(server,{clock:()=>now,speedCsv:{record:f=>frames.push(f)}});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const url=`ws://127.0.0.1:${server.address().port}`;
 const esp=new WebSocket(url+'/ws/esp32');const commands=[];let data=raw();
 esp.on('message',bytes=>{
   const cmd=bytes.toString().trim();commands.push(cmd);
   if(/^V\d+$/.test(cmd)){data={...data,v:Number(cmd.slice(1))};esp.send(`Velocidad: ${data.v}%`);}
   else if(['F','R','S','E'].includes(cmd)){data={...data,dir:cmd==='F'?'FWD':cmd==='R'?'REV':'STOP',rpm_m:cmd==='S'||cmd==='E'?0:150};esp.send(cmd==='F'?'Direccion: ADELANTE':cmd==='R'?'Direccion: REVERSA':cmd==='E'?'STOP INMEDIATO':'STOP');}
   if(cmd==='STATUS')esp.send(JSON.stringify(data));
 });
 const ui=new WebSocket(url+'/ws/ui'),other=new WebSocket(url+'/ws/ui');const a=[],b=[];
 ui.on('message',x=>a.push(JSON.parse(x)));other.on('message',x=>b.push(JSON.parse(x)));
 let n=0;const fault=(key,enabled)=>ui.send(JSON.stringify({type:'fault',id:'f'+(++n),key,enabled}));
 const command=cmd=>ui.send(JSON.stringify({type:'command',id:'c'+(++n),command:cmd}));
 try{
   await until(()=>ui.readyState===1&&other.readyState===1&&frames.length);
   fault('perdida_vel',true);await until(()=>commands.includes('V75'));
   await until(()=>b.some(x=>x.type==='faults'&&Object.hasOwn(x.state,'perdida_vel')));
   assert.equal(frames[0].data.vel_r,11);
   now=250;esp.send(JSON.stringify(data));await delay(30);assert.equal(commands.filter(x=>x==='V75').length,1);
   fault('sobrecarga',true);await delay(30);now=5250;esp.send(JSON.stringify(data));await until(()=>commands.includes('V52'));
   now=10250;esp.send(JSON.stringify(data));await until(()=>commands.includes('V33'));
   fault('sobrecarga',false);await until(()=>commands.filter(x=>x==='V75').length===2);
   fault('perdida_vel',false);await until(()=>commands.includes('V100'));
   command('S');await until(()=>commands.includes('S'));await delay(20);
   const before=commands.length;fault('perdida_vel',true);await delay(40);
   assert.ok(!commands.slice(before).some(x=>/^[VFR]/.test(x)));
   command('R');await until(()=>commands.includes('R'));const r=commands.indexOf('R');assert.equal(commands[r-1],'V75');
   fault('deslizamiento',true);await delay(30);
   assert.equal(frames.at(-1).data.vel_r,11);
   esp.close();await until(()=>b.some(x=>x.type==='link'&&!x.connected));
   assert.deepEqual(b.filter(x=>x.type==='faults').at(-1).state,{});
   const esp2=new WebSocket(url+'/ws/esp32'),reconnected=[];esp2.on('message',x=>reconnected.push(x.toString().trim()));
   await once(esp2,'open');await delay(30);assert.deepEqual(reconnected,['STATUS']);esp2.terminate();
 }finally{esp.terminate();ui.terminate();other.terminate();bridge.close();await new Promise(r=>server.close(r));}
});

test('WebSocket PID aplica falla, conserva límite tras ACK y detiene al alcanzar objetivo',async()=>{
 let now=0;const server=http.createServer();const bridge=attachControlSocket(server,{clock:()=>now});
 server.listen(0,'127.0.0.1');await once(server,'listening');const url=`ws://127.0.0.1:${server.address().port}`;
 let data=raw({dir:'STOP',rpm_m:0,rpm_r:0,vel_r:0});const commands=[];
 const esp=new WebSocket(url+'/ws/esp32');esp.on('message',x=>{
   const cmd=x.toString().trim();commands.push(cmd);
   if(/^V\d+$/.test(cmd)){data.v=Number(cmd.slice(1));esp.send(`Velocidad: ${data.v}%`);}
   if(cmd==='R'||cmd==='F'){data.dir=cmd==='R'?'REV':'FWD';esp.send(cmd==='R'?'Direccion: REVERSA':'Direccion: ADELANTE');}
   if(cmd==='S'){data.dir='STOP';esp.send('STOP');}
   if(cmd==='STATUS')esp.send(JSON.stringify(data));
 });
 const ui=new WebSocket(url+'/ws/ui');const messages=[];ui.on('message',x=>messages.push(JSON.parse(x)));
 try{
   await until(()=>messages.some(x=>x.type==='telemetry'));
   ui.send(JSON.stringify({type:'fault',id:'loss',key:'perdida_vel',enabled:true}));await until(()=>messages.some(x=>x.type==='fault-result'));
   ui.send(JSON.stringify({type:'pid',id:'pid',action:'enable'}));await until(()=>commands.includes('R'));
   assert.equal(commands.find(x=>x.startsWith('V')),'V75');
   for(let i=1;i<=8;i++){now=i*250;data={...data,rpm_m:112.5,rpm_r:53.4,vel_r:8.25};esp.send(JSON.stringify(data));await delay(10);}
   assert.ok(commands.filter(x=>/^V\d+$/.test(x)).every(x=>Number(x.slice(1))<=75));
   now=2250;data={...data,dist:20,pos:20};esp.send(JSON.stringify(data));await until(()=>commands.includes('S'));
   assert.ok(messages.filter(x=>x.type==='controller').at(-1).state.enabled);
 }finally{esp.terminate();ui.terminate();bridge.close();await new Promise(r=>server.close(r));}
});

test('falla manual no reintenta una velocidad sin ACK',async()=>{
 let now=0;const server=http.createServer();const bridge=attachControlSocket(server,{clock:()=>now,commandTimeoutMs:100});
 server.listen(0,'127.0.0.1');await once(server,'listening');const url=`ws://127.0.0.1:${server.address().port}`;
 const esp=new WebSocket(url+'/ws/esp32'),commands=[];esp.on('message',x=>{commands.push(x.toString().trim());if(x.toString().trim()==='STATUS')esp.send(JSON.stringify(raw()));});
 const ui=new WebSocket(url+'/ws/ui'),messages=[];ui.on('message',x=>messages.push(JSON.parse(x)));
 try{
   await until(()=>messages.some(x=>x.type==='telemetry'));
   ui.send(JSON.stringify({type:'fault',id:'loss',key:'perdida_vel',enabled:true}));await until(()=>commands.includes('V75'));
   now=150;await until(()=>messages.some(x=>x.type==='command'&&x.status==='timeout'));
   now=500;esp.send(JSON.stringify(raw()));await delay(80);
   assert.equal(commands.filter(x=>x==='V75').length,1);
 }finally{esp.terminate();ui.terminate();bridge.close();await new Promise(r=>server.close(r));}
});
