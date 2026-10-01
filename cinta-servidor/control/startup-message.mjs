/**
 * Presentación de las direcciones de acceso al servidor.
 * Consulta las interfaces locales sin enviar tráfico ni modificar la escucha.
 * Si hay varias IPv4, prioriza una interfaz física con dirección privada.
 * La detección es orientativa: no verifica rutas, firewall ni acceso desde la ESP.
 */
import {networkInterfaces} from 'node:os';

/** Consulta tolerante a restricciones del sistema operativo. Un fallo de
 * diagnóstico de red no debe interrumpir HTTP, WebSocket ni el control. */
function availableInterfaces() {
  try {return networkInterfaces();} catch {return {};}
}

/** Selecciona IPv4 no loopback; interfaces se puede inyectar en pruebas. */
export function selectLanIPv4(host, interfaces=availableInterfaces()) {
  const candidates=[];
  for(const [name,addresses] of Object.entries(interfaces)) {
    for(const info of addresses??[]) {
      if((info.family!=='IPv4'&&info.family!==4)||info.internal)continue;
      if(!/^\d+\.\d+\.\d+\.\d+$/.test(info.address))continue;
      const [a,b]=info.address.split('.').map(Number);
      if(a===127||a===0||a>=224)continue;
      const privateAddress=a===10||a===172&&b>=16&&b<=31||a===192&&b===168;
      const virtual=/virtual|vmware|vbox|vethernet|docker|veth|bridge|vpn|tun|tap|tailscale|zerotier|wsl/i.test(name);
      // Una escucha en IP específica se anuncia con esa misma IP.
      const score=(info.address===host?100:0)+(virtual?0:20)+(privateAddress?10:0)-(a===169&&b===254?50:0);
      candidates.push({address:info.address,name,score});
    }
  }
  candidates.sort((a,b)=>b.score-a.score||a.name.localeCompare(b.name)||a.address.localeCompare(b.address));
  return candidates[0]?.address??null;
}

/** Tres líneas de inicio; el puerto anunciado siempre es el configurado. */
export function startupMessage(host,port,interfaces=availableInterfaces()) {
  const wildcard=host==='0.0.0.0'||host==='::';
  const localHost=wildcard?'127.0.0.1':host;
  const url=`http://${localHost.includes(':')?'['+localHost+']':localHost}:${port}/`;
  const ipv4=selectLanIPv4(host,interfaces);
  // No anunciar acceso LAN como disponible si solo se escucha en loopback.
  const loopback=host==='localhost'||host==='::1'||host.startsWith('127.');
  const lan=loopback?'no habilitada (usar --host 0.0.0.0)':
    ipv4?`http://${ipv4}:${port}/`:'IPv4 no disponible';
  return {url,text:`Cinta transportadora - Gemelo Digital\nConexión local: ${url}\nRed local: ${lan}`};
}
