/** Verifica que el aviso anuncie direcciones detectadas y respete la escucha. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {selectLanIPv4,startupMessage} from '../control/startup-message.mjs';
const interfaces={
  lo:[{family:'IPv4',internal:true,address:'127.0.0.1'}],
  'vEthernet (WSL)':[{family:'IPv4',internal:false,address:'172.20.0.1'}],
  WiFi:[{family:'IPv4',internal:false,address:'192.168.1.24'}],
};
test('inicio LAN: tres líneas, IPv4 física y puerto configurado',()=>{
 assert.equal(startupMessage('0.0.0.0',8000,interfaces).text,
 'Cinta transportadora - Gemelo Digital\nConexión local: http://127.0.0.1:8000/\nRed local: http://192.168.1.24:8000/');
 assert.ok(startupMessage('0.0.0.0',8080,interfaces).text.endsWith(':8080/'));
 assert.equal(selectLanIPv4('172.20.0.1',interfaces),'172.20.0.1');
});
test('inicio sin IPv4 y escucha restringida no anuncian un acceso inexistente',()=>{
 assert.match(startupMessage('0.0.0.0',8000,{}).text,/IPv4 no disponible$/);
 assert.match(startupMessage('127.0.0.1',8000,interfaces).text,/no habilitada/);
 assert.equal(selectLanIPv4('0.0.0.0',{eth:[{family:4,internal:false,address:'10.0.0.2'}]}),'10.0.0.2');
});
