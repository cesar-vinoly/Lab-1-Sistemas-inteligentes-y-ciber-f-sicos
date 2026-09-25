import {flushSync} from 'react-dom';
import {useCallback,useEffect,useRef,useState} from 'react';
import {CONTROL,parseTelemetry} from '../shared/control-protocol.mjs';
import type {PidConfig} from '../shared/control-protocol.mjs';
import {LabState} from './lab-state.ts';
import type {Fault} from './lab-state.ts';
import {clientId} from './client-id.ts';

export function useLab(){
  const [store]=useState(()=>new LabState());
  const [state,setState]=useState(()=>store.snapshot());
  const socket=useRef<WebSocket|null>(null);
  useEffect(()=>{
    let serverOffset=0;
    let alive=true,reconnect:ReturnType<typeof setTimeout>|undefined;
    const refresh=()=>{if(alive)setState(store.snapshot());};
    const connect=()=>{
      const url=new URL('/ws/ui',window.location.href);url.protocol=url.protocol==='https:'?'wss:':'ws:';
      const ws=new WebSocket(url);socket.current=ws;
      ws.onopen=()=>{if(!alive)return;store.setBridge(true);refresh();};
      ws.onmessage=event=>{
        if(!alive)return;
        try{
          const message=JSON.parse(event.data);
          if(message.type==='snapshot'){
            serverOffset=performance.now()-(message.clockMs??performance.now());
            store.setLink(message.link.connected,message.link.session);
            if(message.controller)store.setController(message.controller,serverOffset);
            if(message.last){const data=parseTelemetry(message.last.data);if(data)store.ingest(data,performance.now()-message.last.ageMs,message.last.model);}
          }else if(message.type==='link')store.setLink(message.connected,message.session);
          else if(message.type==='telemetry'){
            if(message.controller)store.setController(message.controller,serverOffset);
            const data=parseTelemetry(message.data);if(data)store.ingest(data,typeof message.timeMs==='number'?message.timeMs+serverOffset:performance.now(),message.model);
          }else if(message.type==='command')store.command(message);
          else if(message.type==='controller')store.setController(message.state,serverOffset);
          else if(message.type==='pid-result')store.response=message.response;
          else return; // Event log remains a server protocol feature, not a web panel.
          // Commit new measurements in this same WS callback; no panel timer
          // or additional smoothing delays the received motion feedback.
          if(['snapshot','telemetry','link'].includes(message.type))flushSync(refresh);
          else refresh();
        }catch{store.response='Mensaje del servidor inválido';refresh();}
      };
      ws.onerror=()=>{ws.close();};
      ws.onclose=()=>{
        if(!alive)return;store.setBridge(false);refresh();
        reconnect=setTimeout(connect,CONTROL.reconnectMs);
      };
    };
    connect();const tick=setInterval(refresh,CONTROL.refreshMs);
    return()=>{alive=false;clearInterval(tick);clearTimeout(reconnect);socket.current?.close();socket.current=null;};
  },[store]);
  const send=useCallback((command:string)=>{
    const id=clientId();
    if(socket.current?.readyState!==WebSocket.OPEN || !store.connected){
      store.command({type:'command',id,command,status:'rejected',response:'Sin conexión: '+command+' no se envió',latencyMs:null});
      setState(store.snapshot());return;
    }
    try{
      store.command({type:'command',id,command,status:'queued',response:'Enviando '+command+'…',latencyMs:null});
      socket.current.send(JSON.stringify({type:'command',id,command}));
    }catch{
      store.command({type:'command',id,command,status:'rejected',response:'No se pudo enviar '+command,latencyMs:null});
    }
    setState(store.snapshot());
  },[store]);
  const setFault=useCallback((key:Fault,enabled:boolean)=>{store.setFault(key,enabled);setState(store.snapshot());},[store]);
  const sendPid=useCallback((action:'configure'|'enable'|'disable',config?:PidConfig)=>{
    if(socket.current?.readyState!==WebSocket.OPEN){store.response='Sin conexión con el servidor.';}
    else{
      try{socket.current.send(JSON.stringify({type:'pid',id:clientId(),action,config}));store.response='Procesando solicitud PID…';}
      catch{store.response='No se pudo enviar la solicitud PID.';}
    }
    setState(store.snapshot());
  },[store]);
  return {state,send,setFault,sendPid};
}
