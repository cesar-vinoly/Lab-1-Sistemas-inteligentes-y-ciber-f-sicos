import {ConveyorController} from './pid.mjs';
import {calibrateTelemetry} from './telemetry.mjs';
import {performance} from 'node:perf_hooks';
import {randomUUID} from 'node:crypto';
import {WebSocketServer, WebSocket} from '../vendor/ws/wrapper.mjs';
import {CONTROL, parseTelemetry, normalizeCommand, canChangeMicrostep, matchReply} from '../shared/control-protocol.mjs';

// Additive transport: attaches only upgrade handling to the existing HTTP server.
export function attachControlSocket(server, options={}) {
  const clock=options.clock??(()=>performance.now());
  const controller=new ConveyorController();
  let pidDrive=null;
  const timeoutMs=options.commandTimeoutMs??CONTROL.commandTimeoutMs;
  const deviceServer=new WebSocketServer({noServer:true,maxPayload:16384,perMessageDeflate:false});
  const uiServer=new WebSocketServer({noServer:true,maxPayload:4096,perMessageDeflate:false});
  let device=null, last=null, lastAt=0, session=null, lastMotionAt=-Infinity;
  let motionPollUntil=-Infinity,statusPollAt=-Infinity,statusPollPending=false;
  const followMotion=()=>{
    const now=clock();
    if(now>=motionPollUntil)statusPollAt=now; // Let the native 20 ms motor task run first.
    motionPollUntil=now+2*CONTROL.encoderSampleMs+250;
  };
  const pollMotion=()=>{
    const now=clock();
    if(!device||device.readyState!==WebSocket.OPEN||now>=motionPollUntil||
      now-statusPollAt<CONTROL.motionPollMs||statusPollPending&&now-statusPollAt<250)return;
    // Read-only query already supported by the ESP. At most one outstanding
    // poll, bounded rate, no command/ACK record, no motion replay on reconnect.
    statusPollAt=now;statusPollPending=true;device.send('STATUS\n');
  };
  let pending=[];
  const recentReplies=[];
  const events=[];
  const send=(socket,value)=>{
    if (socket.readyState!==WebSocket.OPEN) return;
    if (socket.bufferedAmount>256*1024) {socket.terminate();return;}
    socket.send(JSON.stringify(value));
  };
  const broadcast=value=>{for (const socket of uiServer.clients) send(socket,value);};
  const event=(text,kind='info')=>{
    const record={id:randomUUID(),at:Date.now(),text,kind};
    events.push(record);if(events.length>80)events.shift();
    broadcast({type:'event',event:record});
  };
  const link=()=>({type:'link',connected:Boolean(device),session});
  const result=(entry,status,response,latencyMs=null)=>{
    if(status!=='sent'){
      recentReplies.push({command:entry.command,at:clock()});
      while(recentReplies.length>64||recentReplies[0]&&clock()-recentReplies[0].at>2*timeoutMs)recentReplies.shift();
    }
    broadcast({type:'command',id:entry.id,command:entry.command,status,response,latencyMs,source:entry.source??'web'});
    if(status!=='sent'&&(entry.source!=='pid'||!['ack','cancelled'].includes(status))) event(response,status==='ack'?'resp':status==='cancelled'?'info':'alarma');
  };
  const cancelPending=reason=>{for(const entry of pending)result(entry,'cancelled',reason+' · '+entry.command);pending=[];};
  const publishController=()=>broadcast({type:'controller',state:controller.snapshot()});
  const issueCommand=(command,id,source='web',requester=null)=>{
    const entry={id,command,sentAt:clock(),source};
    const reject=reason=>{
      if(requester)send(requester,{type:'command',id,command,status:'rejected',response:reason,latencyMs:null,source});
      event(reason,'alarma');return false;
    };
    if(!device||device.readyState!==WebSocket.OPEN)return reject('Sin conexión: '+command+' no se envió');
    if(pending.some(item=>item.id===id))return reject('La orden ya está pendiente');
    if(source==='web'&&controller.enabled&&!['F','R','S','E','STATUS'].includes(command))return reject('Desactivá el PID para cambiar velocidad o micropaso manualmente.');
    if(command.startsWith('M')&&(!canChangeMicrostep(last,clock()-lastAt)||lastAt<lastMotionAt||pending.some(item=>['F','R'].includes(item.command))))return reject('El micropaso solo cambia con telemetría reciente y el motor detenido.');
    if(command==='E'||command==='S'){
      cancelPending('Orden sustituida por '+command);
    }
    if(pending.length>=32)return reject('Hay demasiadas órdenes sin confirmar.');
    pending.push(entry);
    if(['F','R','S','E'].includes(command))lastMotionAt=entry.sentAt;
    if(source==='web'&&command!=='STATUS'&&/^[FRSEV]/.test(command)){
      controller.manual(command,clock());if(controller.enabled)pidDrive=null;publishController();
    }
    result(entry,'sent','Enviado '+command+'; esperando respuesta');
    device.send(command+'\n',error=>{
      if(!error)return;
      pending=pending.filter(item=>item!==entry);result(entry,'rejected','No se pudo enviar '+command);
      if(source==='pid')failPid('No se pudo enviar el comando PID.');
    });
    if(/^[FRSEV]/.test(command))followMotion();
    if(source!=='pid')event('Enviado '+command,'cmd');
    return true;
  };
  const failPid=(reason,waitFor='telemetry')=>{
    if(!controller.enabled||controller.waitFor)return;
    controller.pause(clock(),reason,waitFor);pidDrive=0;
    cancelPending('PID interrumpido');
    if(device)issueCommand('E',randomUUID(),'pid');
    publishController();event(reason,'alarma');
  };
  const drivePid=output=>{
    if(output===pidDrive)return true;
    const previous=pidDrive;
    if(output===0){if(!issueCommand('S',randomUUID(),'pid'))return false;}
    else{
      // Same native protocol: set magnitude first, then direction if needed.
      if(previous===null||Math.abs(previous)!==Math.abs(output)){
        if(!issueCommand('V'+Math.abs(output),randomUUID(),'pid'))return false;
      }
      if(previous===null||Math.sign(previous)!==Math.sign(output)){
        if(!issueCommand(output>0?'F':'R',randomUUID(),'pid'))return false;
      }
    }
    pidDrive=output;return true;
  };
  const pump=()=>{
    const next=controller.tick(clock(),!pending.some(entry=>entry.command!=='STATUS'));
    if(next?.fault){failPid(next.fault,next.waitFor);return;}
    if(next&&Object.hasOwn(next,'output')){
      controller.applied(next.output,clock());publishController();
      if(!drivePid(next.output)){failPid('No se pudo aplicar la salida PID.');return;}
    }
  };
  const handlePid=(socket,message)=>{
    const reply=(status,response)=>send(socket,{type:'pid-result',id:message.id,status,response});
    try{
      if(message.action==='configure')controller.configure(message.config,clock());
      else if(message.action==='enable'){
        if(controller.enabled){reply('ack','PID ya activo.');return;}
        if(!device||pending.some(entry=>entry.command!=='STATUS'))throw Error('Esperá la conexión y la confirmación de las órdenes pendientes.');
        controller.enable(clock());pidDrive=null;pump();
      }else if(message.action==='disable'){
        if(controller.enabled){
          controller.disable(clock());pidDrive=null;
          if(device)issueCommand('S',randomUUID(),'web');
        }
      }else throw Error('Acción PID inválida.');
      publishController();reply('ack',message.action==='configure'?'Configuración PID aplicada.':controller.reason);
      event(message.action==='configure'?'Configuración PID aplicada.':controller.reason,'info');
    }catch(error){reply('rejected',error.message);}
  };
  const rejectUpgrade=(socket,status,text)=>{socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`);};
  const upgrade=(request,socket,head)=>{
    let url;
    try {url=new URL(request.url,'http://localhost');} catch {rejectUpgrade(socket,400,'Bad Request');return;}
    if (request.headers.origin) {
      try {if(new URL(request.headers.origin).host!==request.headers.host)throw Error();}
      catch {rejectUpgrade(socket,403,'Forbidden');return;}
    }
    if (url.pathname==='/ws/esp32') {
      if(device){rejectUpgrade(socket,409,'Device Already Connected');return;}
      deviceServer.handleUpgrade(request,socket,head,ws=>deviceServer.emit('connection',ws));
    } else if (url.pathname==='/ws/ui') {
      uiServer.handleUpgrade(request,socket,head,ws=>uiServer.emit('connection',ws));
    } else rejectUpgrade(socket,404,'Not Found');
  };
  server.on('upgrade',upgrade);

  deviceServer.on('connection',socket=>{
    device=socket;last=null;lastAt=0;lastMotionAt=-Infinity;session=randomUUID();
    motionPollUntil=-Infinity;statusPollAt=-Infinity;statusPollPending=false;
    controller.reset(clock());pidDrive=null;
    recentReplies.length=0;
    socket.isAlive=true;socket.on('pong',()=>{socket.isAlive=true;});
    broadcast(link());publishController();event('ESP32 conectada','ok');
    // Read first. An enabled PID resumes only from the new session's feedback;
    // commands queued in the old connection are never replayed.
    socket.send('STATUS\n');
    socket.on('message',(bytes,binary)=>{
      if(binary){event('La ESP32 envió una trama binaria; se espera texto.','alarma');return;}
      for(const line of bytes.toString('utf8').split(/\r?\n/).map(line=>line.trim()).filter(Boolean)) {
        const telemetry=calibrateTelemetry(parseTelemetry(line));
        if(telemetry){
          statusPollPending=false;
          if(telemetry.state==='RAMP'||last&&(telemetry.dir!==last.dir||telemetry.rpm_m!==last.rpm_m))followMotion();
          last=telemetry;lastAt=clock();
          controller.observe(telemetry,lastAt);
          // A local change takes priority. During a native reversal/stop ramp
          // DIR still describes actual motion, not the requested direction.
          if(controller.enabled&&!controller.waitFor&&pidDrive!==null&&clock()-controller.motion.commandAt>=500&&telemetry.state!=='RAMP'&&!pending.some(entry=>entry.command!=='STATUS')){
            const expected=pidDrive>0?'FWD':pidDrive<0?'REV':'STOP';
            if(telemetry.dir!==expected){
              if(telemetry.dir==='STOP')controller.pause(clock(),'PID activo; esperando confirmar el estado del motor.');
              else controller.manual(telemetry.dir==='FWD'?'F':'R',clock());
              pidDrive=null;
            }else if(pidDrive!==0&&telemetry.v!==Math.abs(pidDrive))pidDrive=null;
          }
          broadcast({type:'telemetry',data:telemetry,model:controller.lastModel,controller:controller.snapshot(),at:Date.now(),timeMs:lastAt,session});
          const requests=pending.filter(entry=>entry.command==='STATUS');
          pending=pending.filter(entry=>entry.command!=='STATUS');
          // A streaming telemetry frame has no request ID, so it cannot give
          // an unambiguous STATUS round-trip latency. Do not invent one.
          for(const entry of requests)result(entry,'ack','Estado recibido');
          pump();continue;
        }
        const index=pending.findIndex(entry=>matchReply(entry.command,line)!==null);
        if(index!==-1){
          const [entry]=pending.splice(index,1);
          const status=matchReply(entry.command,line);
          result(entry,status,'ESP32: '+line,clock()-entry.sentAt);
          if(entry.source==='pid'&&status==='rejected')failPid('La ESP32 rechazó el comando PID.');
        } else if(recentReplies.some(entry=>clock()-entry.at<=2*timeoutMs&&matchReply(entry.command,line)!==null)){
          // Native replies have no IDs. Ignore late/duplicate acknowledgments
          // instead of interpreting them as a new local hardware command.
        } else if(controller.enabled&&/^(STOP(?: INMEDIATO)?|Direccion:\s*(?:ADELANTE|REVERSA)|Velocidad:\s*\d+%)$/i.test(line)){
          const local=/^STOP INMEDIATO$/i.test(line)?'E':/^STOP$/i.test(line)?'S':
            /^Direccion:\s*ADELANTE$/i.test(line)?'F':/^Direccion:\s*REVERSA$/i.test(line)?'R':'V'+line.match(/\d+/)[0];
          controller.manual(local,clock());pidDrive=null;publishController();
        }
        else if(line.startsWith('DIR=') || line.startsWith('{'))event('Telemetría inválida descartada','alarma');
        else if(/error|invalido|inválido/i.test(line))event('ESP32: '+line.slice(0,300),'alarma');
      }
    });
    socket.on('error',error=>event('Error del enlace ESP32: '+error.message,'alarma'));
    socket.on('close',()=>{
      if(device!==socket)return;
      device=null;last=null;lastAt=0;
      controller.reset(clock());pidDrive=null;
      cancelPending('Enlace cerrado, orden sin confirmar');
      broadcast(link());publishController();event('ESP32 desconectada','alarma');
    });
  });

  uiServer.on('connection',socket=>{
    socket.isAlive=true;socket.on('pong',()=>{socket.isAlive=true;});
    controller.advance(clock());
    send(socket,{type:'snapshot',link:link(),events,clockMs:clock(),controller:controller.snapshot(),last:last?{data:last,model:controller.lastModel,timeMs:lastAt,ageMs:clock()-lastAt,session}:null});
    socket.on('message',(bytes,binary)=>{
      let message;
      try {message=JSON.parse(bytes.toString('utf8'));} catch {return;}
      if(binary||!message||typeof message.id!=='string'||!(/^[\w-]{1,80}$/).test(message.id))return;
      if(message.type==='pid'){handlePid(socket,message);return;}
      if(message.type!=='command')return;
      const command=normalizeCommand(message.command);
      if(!command){send(socket,{type:'command',id:message.id,command:String(message.command).slice(0,24),status:'rejected',response:'Comando inválido',latencyMs:null});return;}
      issueCommand(command,message.id,'web',socket);
    });
    socket.on('error',()=>{});
  });

  const timer=setInterval(()=>{
    const expired=pending.filter(entry=>clock()-entry.sentAt>=timeoutMs);
    pending=pending.filter(entry=>clock()-entry.sentAt<timeoutMs);
    for(const entry of expired){
      result(entry,'timeout','Sin respuesta para '+entry.command+'; no se reenvía');
      if(entry.source==='pid'){
        if(entry.command==='E')device?.terminate();
        else failPid('La ESP32 no confirmó la salida PID.');
      }
    }
    pump();pollMotion();
  },25);
  const heartbeat=setInterval(()=>{
    for(const socket of [...deviceServer.clients,...uiServer.clients]){
      if(!socket.isAlive){socket.terminate();continue;}
      socket.isAlive=false;socket.ping();
    }
  },15000);
  timer.unref();heartbeat.unref();
  return {
    close(){
      if(controller.enabled&&device?.readyState===WebSocket.OPEN)device.send('E\n');
      clearInterval(timer);clearInterval(heartbeat);server.off('upgrade',upgrade);
      for(const socket of [...deviceServer.clients,...uiServer.clients])socket.terminate();
      deviceServer.close();uiServer.close();
    },
  };
}
