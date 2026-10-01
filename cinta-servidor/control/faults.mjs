/**
 * Simulación de fallas mediante limitación del comando físico.
 * Pérdida de velocidad y sobrecarga se combinan multiplicando factores;
 * no se modifican lecturas del encoder. El deslizamiento se representa
 * únicamente en el navegador y no afecta el factor enviado al motor.
 */
import {FAULTS} from '../shared/control-protocol.mjs';

// Physical effects operate on commands, never on received measurements.
export class FaultSimulation {
  active={};
  /* Valida la clave y conserva el instante de activación para no reiniciar
   * la sobrecarga si llega de nuevo la misma selección. */
  set(key,enabled,now){
    if(!Object.hasOwn(FAULTS,key)||typeof enabled!=='boolean')throw Error('Falla inválida.');
    if(enabled&&!Object.hasOwn(this.active,key))this.active[key]=now;
    if(!enabled)delete this.active[key];
  }
  reset(){this.active={};}
  /* Pérdida: factor 0,75. Sobrecarga: cae 0,06/s hasta 0,45.
   * Los factores activos se multiplican y el resultado nunca es negativo. */
  factor(now){
    const loss=Object.hasOwn(this.active,'perdida_vel')?.75:1;
    const start=this.active.sobrecarga;
    const load=start===undefined?1:Math.max(.45,1-.06*Math.max(0,now-start)/1000);
    return loss*load;
  }
  command(base,now){return base===0?0:Math.max(1,Math.floor(base*this.factor(now)+1e-9));}
  snapshot(){return {...this.active};}
}
