/**
 * Registro persistente de la gráfica de velocidad. Una fila por telemetría
 * válida, con encoder, referencia ESP32 y modelo en cm/s al mismo instante.
 * La escritura usa un stream asíncrono; la saturación o un error de disco
 * detienen el registro sin bloquear el control. close() termina de escribir.
 */
import {mkdir} from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';

// One row per accepted ESP sample, using exactly the three chart values.
/* Abre un archivo exclusivo por ejecución. La fecha UTC identifica muestras
 * y tiempo_s mide el intervalo desde la primera muestra con reloj monotónico. */
export async function createSpeedCsv(directory, onError = error => console.error('Registro CSV:', error.message)) {
  await mkdir(directory, {recursive:true});
  const filename=join(directory, `velocidad-banda_${new Date().toISOString().replace(/[:.]/g,'-')}_${randomUUID()}.csv`);
  const stream=createWriteStream(filename, {flags:'wx', encoding:'utf8'});
  await new Promise((resolve,reject)=>{stream.once('open',resolve);stream.once('error',reject);});
  let failed=false, closed=false, firstTime=null;
  stream.on('error',error=>{failed=true;onError(error);});
  stream.write('fecha_utc,tiempo_s,sesion_esp32,encoder_fisico_cm_s,referencia_esp32_cm_s,modelo_gs_cm_s\r\n');
  const number=value=>Number.isFinite(value)?String(value):'';
  const quoted=value=>'"'+String(value??'').replaceAll('"','""')+'"';
  return {
    filename,
    record(frame){
      if(failed||closed)return;
      // Never let a stalled disk consume unlimited memory or delay control.
      if(stream.writableLength>1024*1024){
        failed=true;onError(new Error('Escritura demasiado lenta; registro detenido.'));
        stream.end();return;
      }
      firstTime??=frame.timeMs;
      stream.write([new Date(frame.at).toISOString(),number((frame.timeMs-firstTime)/1000),
        quoted(frame.session),number(frame.data.vel_r),number(frame.data.vel_t),
        number(frame.model?.speedCmS)].join(',')+'\r\n');
    },
    close(){
      closed=true;
      if(stream.closed)return Promise.resolve();
      return new Promise(resolve=>{stream.once('close',resolve);stream.end();});
    },
  };
}
