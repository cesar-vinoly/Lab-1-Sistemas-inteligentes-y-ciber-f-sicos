/**
 * Interfaz de mando, medición, divergencias, PID, modelo y gráficas.
 * Los componentes convierten el estado de useLab en elementos visuales;
 * no calculan comandos PID ni reemplazan las mediciones del hardware.
 * La posición enviada al cubo puede ser la copia de deslizamiento, conservando
 * la validación de presencia sobre POS real.
 */
import {useEffect,useRef,useState} from 'react';
import {CONTROL,FAULTS,PID_DEFAULTS,validEncoder} from '../shared/control-protocol.mjs';
import type {PidConfig} from '../shared/control-protocol.mjs';
import {useLab} from './use-lab';
import {TrendChart} from './trend-chart';
import ConveyorViewer from './viewer';
import type {Fault,LabSnapshot} from './lab-state';
import './control-dashboard.css';

const directions={FWD:'adelante',REV:'reversa',STOP:'detenida'};
/* Formatea valores ausentes como raya; no los convierte en cero. */
function fmt(value:number|null|undefined,decimals=1,suffix=''){
  return value===null||value===undefined?'—':value.toFixed(decimals)+suffix;
}
function signed(value:number|null){return value===null?'—':(value>0?'+':'')+value.toFixed(1);}
function Badge({text,kind='inactivo'}:{text:string;kind?:string}){return <span className={'estado '+kind}>{text}</span>;}

/* Explica el estado de velocidad, posición y comunicación a partir de
 * mediciones y persistencia evaluadas por LabState. */
function Divergences({state}:{state:LabSnapshot}){
  const u=state.fresh?state.latest:null;
  let speed={text:'Sin datos',kind:'inactivo',detail:''};
  if(u){
    if(state.divergence)speed={text:'Divergencia',kind:'alarma',detail:`Error ${fmt(u.err,1,' %')}. Revisar pérdida de pasos, engranajes o atasco de la banda.`};
    else if(u.state==='RAMP'||state.settling)speed={text:u.state==='RAMP'?'En rampa':'Estabilizando',kind:'aviso',detail:'Se espera el régimen antes de evaluar.'};
    else if(u.dir==='STOP')speed={text:'Detenida',kind:'inactivo',detail:''};
    else if(u.rpm_t===null||u.err===null)speed={text:'Sin referencia',kind:'inactivo',detail:'Se necesitan RPM_T y ERR de la ESP32 para comparar.'};
    else if(u.rpm_t<=5)speed={text:'Velocidad baja',kind:'inactivo',detail:'La comparación se evalúa por encima de 5 RPM del rodillo.'};
    else if(state.evaluatingSpeed)speed={text:'Evaluando',kind:'aviso',detail:'Error por encima del límite; comprobando persistencia.'};
    else speed={text:'Dentro de tolerancia',kind:'normal',detail:`Error ${fmt(u.err,1,' %')} (límite ${CONTROL.speedErrorPct} %).`};
  }
  const position=!u?{text:'Sin datos',kind:'inactivo',detail:''}:u.pos===null?{text:'Sin objeto',kind:'inactivo',detail:''}:{text:'Posición medida',kind:'normal',detail:'Se conserva el ultrasónico. G(s) predice velocidad; no estima la posición del objeto.'};
  const connection=!state.bridge?{text:'Desconectada',kind:'alarma',detail:'Reintentando conexión con el servidor.'}:!state.connected?{text:'Esperando ESP32',kind:'inactivo',detail:'El servidor está listo para recibir la conexión.'}:!state.fresh?{text:'Sin datos',kind:'alarma',detail:state.age===null?'La ESP32 todavía no envía telemetría.':`Último dato hace ${fmt(state.age/1000,1)} s.`}:{text:'Normal',kind:'normal',detail:state.latency===null?'Latencia de comandos: sin medir aún.':`Latencia: ${fmt(state.latency,0)} ms (promedio ${fmt(state.averageLatency,0)} ms).`};
  return <>{[['Velocidad',speed],['Posición',position],['Comunicación',connection]].map(([name,entry])=>{
    const value=entry as typeof speed;return <div className="alarma-fila" key={name as string}><div><span className="alarma-nombre">{name as string}</span><Badge text={value.text} kind={value.kind}/></div>{value.detail&&<p className="alarma-detalle">{value.detail}</p>}</div>;
  })}</>;
}

/* Mantiene un borrador de parámetros; solo Aplicar lo envía al backend.
 * Las restricciones HTML ayudan al usuario y el servidor vuelve a validar. */
function PidSettings({config,disabled,onApply}:{config:PidConfig;disabled:boolean;onApply:(config:PidConfig)=>void}){
  const [draft,setDraft]=useState(config);
  const revision=JSON.stringify(config);
  useEffect(()=>{setDraft(JSON.parse(revision));},[revision]);
  const numeric=(key:Exclude<keyof PidConfig,'forwardIncreasesDistance'>,label:string,min:number,max:number,step:number|'any')=><label key={key}>{label}<input type="number" required min={min} max={max} step={step} value={Number.isFinite(draft[key])?draft[key]:''} onChange={event=>setDraft({...draft,[key]:event.target.valueAsNumber})}/></label>;
  return <form className="pid-form" onSubmit={event=>{event.preventDefault();onApply(draft);}}>
    <fieldset disabled={disabled}>
      <legend>Configuración del PID</legend>
      <div className="pid-fields pid-timing">
        {numeric('targetCm','Distancia objetivo (cm)',2,400,0.1)}
        {numeric('sampleMs','Muestreo (ms)',50,2000,1)}
      </div>
      <div className="pid-fields pid-coefficients">
        {numeric('kp','Kp',0,10000,0.01)}
        {numeric('ki','Ki',0,10000,0.01)}
        {numeric('kd','Kd',0,10000,0.01)}
      </div>
      <details className="pid-advanced"><summary>Sensor y unidades del modelo</summary><div className="pid-fields">
        {numeric('toleranceCm','Tolerancia de parada (cm)',0.1,5,0.1)}
        <label>Al avanzar, la distancia<select value={String(draft.forwardIncreasesDistance)} onChange={event=>setDraft({...draft,forwardIncreasesDistance:event.target.value==='true'})}><option value="true">Aumenta</option><option value="false">Disminuye</option></select></label>
        {numeric('inputScale','Hz de identificación por 1 % de mando',0.000001,10000,'any')}
        {numeric('outputScale','cm/s por RPM del rodillo modelo',0.000001,10000,'any')}
      </div><p className="ayuda">Conversión del ensayo a cm/s: 40 Hz por 1 % de mando y diámetro de rodillo de 2,95 cm. La gráfica conserva las tres curvas en cm/s.</p></details>
      <button className="btn" disabled={revision===JSON.stringify(draft)}>Aplicar configuración</button>
    </fieldset>
    <p className="ayuda">Configurá con el PID desactivado. La velocidad base y máxima del PID es siempre 100 %. El control reduce la salida durante la aproximación y conserva la realimentación del encoder.</p>
  </form>;
}

export default function ControlDashboard(){
  const lab=useLab();
  return <Dashboard {...lab}/>;
}

/* Compone paneles y enlaza sus eventos con el mando único. El tema visual
 * se conserva localmente; el estado de máquina procede del servidor. */
export function Dashboard({state,send,setFault,sendPid}:ReturnType<typeof useLab>){
  const [velocityDraft,setVelocityDraft]=useState<number|null>(null);
  const editing=useRef(false);
  const control=state.control;
  const velocity=velocityDraft??control.v;
  const [theme,setTheme]=useState(()=>{
    try{return localStorage.getItem('cinta-panel-theme')??(matchMedia('(prefers-color-scheme: dark)').matches?'oscuro':'claro');}catch{return 'claro';}
  });
  useEffect(()=>{
    if(!state.fresh||!editing.current)setVelocityDraft(null);
    if(!state.fresh)editing.current=false;
  },[state.raw,state.fresh]);
  useEffect(()=>{document.documentElement.dataset.theme=theme;},[theme]);
  const toggleTheme=()=>{const next=theme==='oscuro'?'claro':'oscuro';setTheme(next);try{localStorage.setItem('cinta-panel-theme',next);}catch{}};
  const connected=state.bridge&&state.connected;
  const u=state.fresh?state.raw:null;
  const objectPosition=u?.pos!==null&&u?.pos!==undefined&&u.pos>=0&&u.pos<=CONTROL.beltLengthCm
    ?(state.faults.deslizamiento!==undefined?state.latest?.pos??null:u.pos):null;
  const pid=state.controller;
  const automatic=pid?.enabled??false;
  const anyFaults=Object.keys(state.faults).length>0;
  const differenceRpm=u?.rpm_t===null||!u?null:u.rpm_r-u.rpm_t;
  const row=(name:string,measured:string,reference:string,difference:string,alarm=false)=><tr key={name}><th scope="row">{name}</th><td className="real">{measured}</td><td className="modelo">{reference}</td><td className={alarm?'alarma-txt':''}>{difference}</td></tr>;
  const connectionText=!state.bridge?'Conectando con el servidor':!state.connected?'Esperando ESP32':state.fresh?'ESP32 conectada':'ESP32 conectada sin datos';
  /* Confirma el deslizador al terminar la interacción, evitando enviar
   * una orden física por cada movimiento intermedio del puntero. */
  const commitVelocity=(value:number)=>{
    editing.current=false;setVelocityDraft(null);
    if(!automatic&&value!==control.v)send('V'+value);
  };
  return <main className="instrumentation" id="control" data-theme={theme}>
    <div className="pagina">
      <header className="cabecera">
        <div className="brand"><div className="brand-symbol" aria-hidden="true"><span/><span/></div><div><p className="eyebrow">GEMELO DIGITAL · ESP32</p><h1>Cinta transportadora</h1></div></div>
        <div className="cabecera-der"><span className={'con '+(!state.bridge?'error':state.fresh?'ok':'aviso')} role="status">{connectionText}</span><button className="btn-tema" onClick={toggleTheme}>{theme==='oscuro'?'Modo claro':'Modo oscuro'}</button></div>
      </header>

      <div className="panel resumen" aria-label="Estado de la cinta">
        {[['Sentido',control.dir?directions[control.dir]:'—'],['Consigna',state.fresh?fmt(control.v,0,' %'):'—'],['Micropaso',state.fresh?'1/'+control.m:'—'],['Estado de la ESP32',u?({OK:'normal',RAMP:'en rampa',DIVERG:'divergencia'}[u.state]??u.state):'sin datos'],['Último dato',state.age===null?'—':fmt(state.age/1000,1,' s')]].map(([name,value])=><div className="dato" key={name}><span className="k">{name}</span><span className="v">{value}</span></div>)}
        {anyFaults&&<Badge text="Fallas simuladas activas" kind="aviso"/>}
      </div>

      <div className="workspace-grid">
        <ConveyorViewer motion={control} objectPosition={objectPosition}/>
        <section className="panel mando-panel" aria-labelledby="mando-title"><div className="panel-heading"><h2 id="mando-title">Mando</h2><Badge text={automatic?'PID activo':control.source==='command'?'Orden enviada':state.fresh?'Sincronizado':'Sin datos'} kind={control.source==='command'?'aviso':state.fresh?'normal':'inactivo'}/></div>
          <label className="pid-toggle"><input type="checkbox" checked={automatic} disabled={!state.bridge||(!automatic&&(!connected||!state.fresh||!validEncoder(u)))} onChange={event=>sendPid(event.target.checked?'enable':'disable')}/><span>PID de aproximación y velocidad</span></label>
          {automatic&&<p className="pid-command">Base 100 % · Objetivo {fmt(pid?.config.targetCm,1,' cm')} · Salida {fmt(pid?.outputPercent,0,' %')}</p>}
          <div className="botonera" role="group" aria-label="Mando de la cinta">
            <button className="btn" onClick={()=>send('F')} disabled={!connected||!state.fresh} aria-pressed={control.dir==='FWD'}>Adelante</button>
            <button className="btn" onClick={()=>send('S')} disabled={!connected} aria-pressed={control.dir==='STOP'}>Detener</button>
            <button className="btn" onClick={()=>send('R')} disabled={!connected||!state.fresh} aria-pressed={control.dir==='REV'}>Reversa</button>
            <button className="btn btn-paro" onClick={()=>send('E')} disabled={!connected}>Paro inmediato</button>
          </div>
          {!automatic&&<><div className="setpoint-heading"><label className="etiqueta" htmlFor="lab-velocity">Velocidad del motor</label><output htmlFor="lab-velocity">{velocity} %</output></div>
          <input id="lab-velocity" type="range" min="0" max="100" step="5" value={velocity} disabled={!connected||!state.fresh||automatic} aria-valuetext={velocity+' % de '+CONTROL.maxMotorRpm+' RPM'} onPointerDown={event=>{event.currentTarget.setPointerCapture(event.pointerId);}} onChange={event=>{editing.current=true;setVelocityDraft(Number(event.target.value));}} onPointerUp={event=>commitVelocity(Number(event.currentTarget.value))} onPointerCancel={()=>{editing.current=false;setVelocityDraft(null);}} onKeyUp={event=>{if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown'].includes(event.key))commitVelocity(Number(event.currentTarget.value));}} onBlur={event=>{if(editing.current)commitVelocity(Number(event.currentTarget.value));}}/>
          <div className="range-marks" aria-hidden="true"><span>0</span><span>25</span><span>50</span><span>75</span><span>100</span></div></>}
          <label className="etiqueta" htmlFor="lab-micro">Micropaso</label>
          <select id="lab-micro" value={control.m} disabled={!connected||!state.canMicro} onChange={event=>send('M'+event.target.value)}>{[2,4,8,16].map(value=><option value={value} key={value}>1/{value}</option>)}</select>
          <p className="ayuda">Detener pausa la cinta; Adelante/Reversa reanudan. Solo desmarcar el PID lo desactiva. El micropaso se cambia con la cinta detenida y el PID desactivado.</p>
          <p className="respuesta" role="status">{state.response}</p>
        </section>
      </div>

      <div className="detail-grid">
          <section className="panel" aria-labelledby="medicion-title"><h2 id="medicion-title">Medición</h2>
            <div className="table-scroll"><table className="tabla"><thead><tr><th scope="col">Magnitud</th><th scope="col">Medido</th><th scope="col">Referencia ESP32</th><th scope="col">Diferencia</th></tr></thead><tbody>
              {row('Velocidad de la banda (cm/s)',fmt(u?.vel_r,2),fmt(u?.vel_t,2),fmt(u?.err,1,' %'),state.divergence)}
              {row('Giro del rodillo (RPM)',fmt(u?.rpm_r),fmt(u?.rpm_t),signed(differenceRpm),state.divergence)}
              {row('Posición del objeto (cm)',fmt(u?.pos),'—','—')}
              {row('Motor, comandado (RPM)','',fmt(u?.rpm_m),'')}
              {row('Distancia bruta HC-SR04 (cm)',fmt(u?.dist),'','')}
            </tbody></table></div>
            <p className="ayuda">Las referencias de velocidad y giro son datos recibidos de la ESP32.</p>
            {anyFaults&&<p className="simulation-note">Simulación activa. Encoder, tabla y CSV conservan las mediciones físicas. El deslizamiento solo modifica la posición visual.</p>}
          </section>

        <section className="panel" aria-labelledby="divergencias-title"><h2 id="divergencias-title">Divergencias</h2><Divergences state={state}/>
          <h3>Simulación de fallas</h3><div className={'fallas '+(anyFaults?'activas':'')}>{Object.entries(FAULTS).map(([key,label])=><label key={key}><input type="checkbox" checked={state.faults[key as Fault]!==undefined} disabled={!connected||!state.fresh} onChange={event=>setFault(key as Fault,event.target.checked)}/><span>{label}</span></label>)}</div>
          <p className="ayuda">Pérdida: comando al 75 %. Sobrecarga: reducción progresiva hasta el 45 % en 9,2 s. Ambas se combinan y actúan sobre el motor; el PID respeta el límite. Deslizamiento del objeto. Se desactivan al desconectar la ESP32.</p>
        </section>
        <section className="panel model-panel" aria-labelledby="modelo-title"><div className="panel-heading"><h2 id="modelo-title">Modelo</h2><Badge text={!automatic?'PID desactivado':pid?.status==='fault'?'PID activo · sin salida':pid?.status==='waiting'?'PID activo · esperando datos':pid?.status==='paused'?'PID activo · cinta detenida':'PID activo'} kind={pid?.status==='fault'?'alarma':automatic?'normal':'inactivo'}/></div>
          <div className="plant-equation" role="math" aria-label="G de s igual a la fracción: numerador, 0.004656 por s más 0.1425; denominador, s al cuadrado más 4.286 por s más 8.058.">
            <span className="plant-symbol" aria-hidden="true"><i>G</i>(<i>s</i>) =</span>
            <span className="plant-fraction" aria-hidden="true"><span className="plant-numerator">0.004656 <i>s</i> + 0.1425</span><span className="plant-denominator"><i>s</i><sup>2</sup> + 4.286 <i>s</i> + 8.058</span></span>
          </div>
          <div className="model-slots"><div><span>Velocidad modelo</span><strong>{fmt(state.model.speedCmS,2)} <small>cm/s</small></strong></div><div><span>Giro del rodillo modelo</span><strong>{fmt(state.model.rollerRpm)} <small>RPM</small></strong></div><div><span>Error encoder − modelo</span><strong>{signed(state.model.errorCmS)} <small>cm/s</small></strong><span>{fmt(state.model.errorPercent,1,' %')}</span></div></div>
          <p className="ayuda">Modelo dinámico independiente del encoder. Ambos se comparan con el mismo tiempo en la gráfica de velocidad.</p>
          <p className="pid-gains">Kp = {(pid?.config??PID_DEFAULTS).kp} · Ki = {(pid?.config??PID_DEFAULTS).ki} · Kd = {(pid?.config??PID_DEFAULTS).kd}</p>
          <div className="pid-readouts"><span>Distancia restante: <strong>{signed(pid?.remainingCm??null)} cm</strong></span><span>Velocidad objetivo: <strong>{fmt(pid?.speedReferenceCmS,2,' cm/s')}</strong></span><span>Error de velocidad: <strong>{signed(pid?.speedErrorCmS??null)} cm/s</strong></span><span>Salida: <strong>{fmt(pid?.outputPercent,0,' %')}</strong></span><span>Muestreo efectivo: <strong>{fmt(pid?.effectiveSampleMs,0,' ms')}</strong></span></div>
          <p className={'ayuda '+(pid?.status==='fault'?'pid-fault':'')}>{pid?.reason??'PID desactivado.'}</p>
          <PidSettings config={pid?.config??PID_DEFAULTS} disabled={!state.bridge||automatic} onApply={config=>sendPid('configure',config)}/>
        </section>
      </div>

      <div className="fila2">
        <section className="panel"><h2>Velocidad de la banda</h2><TrendChart samples={state.history} now={state.now} kind="speed"/></section>
        <section className="panel"><h2>Posición del objeto</h2><TrendChart samples={state.history} now={state.now} kind="position"/></section>
      </div>
    </div>
  </main>;
}
