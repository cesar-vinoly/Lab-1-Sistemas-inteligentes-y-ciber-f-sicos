import {useState} from 'react';
import {CONTROL} from '../shared/control-protocol.mjs';
import type {Sample} from './lab-state';

export function TrendChart({samples,now,kind}:{samples:Sample[];now:number;kind:'speed'|'position'}){
  const [hover,setHover]=useState<number|null>(null);
  const speed=kind==='speed';const width=600,height=245,left=48,right=16,top=20,bottom=42;
  const data=samples.filter(sample=>now-sample.at<=CONTROL.historyMs);
  const values=data.flatMap(sample=>speed?[sample.speed??0,sample.reference??0,sample.modelSpeed??0,sample.simulatedSpeed??0]:[sample.position??0,sample.simulatedPosition??0]);
  const maximum=speed?Math.max(1,...values)*1.12:Math.max(CONTROL.beltLengthCm,...values);
  const x=(time:number)=>left+(1+(time-now)/CONTROL.historyMs)*(width-left-right);
  const y=(value:number)=>top+(1-value/maximum)*(height-top-bottom);
  const path=(key:'speed'|'reference'|'position'|'modelSpeed'|'simulatedSpeed'|'simulatedPosition')=>{
    let drawing=false,previous=0;
    return data.map(sample=>{
      const value=sample[key];if(value==null){drawing=false;return '';}
      const command=drawing&&sample.at-previous<=CONTROL.staleMs?'L':'M';drawing=true;previous=sample.at;
      return `${command}${x(sample.at).toFixed(2)},${y(value).toFixed(2)}`;
    }).join(' ');
  };
  const hovered=hover===null?null:data.reduce<Sample|null>((nearest,sample)=>!nearest||Math.abs(x(sample.at)-hover)<Math.abs(x(nearest.at)-hover)?sample:nearest,null);
  const hoveredValue=hovered?(speed?hovered.speed:hovered.position):null;
  return <div className="trend">
    <div className="trend-legend"><span className="measured-key">{speed?'Encoder físico':'Ultrasónico'}</span>{speed&&<span className="reference-key">Referencia ESP32</span>}<>{speed&&<span className="model-key">Modelo G(s)</span>}{data.some(sample=>sample.simulated)&&<span className="simulation-key">Falla simulada</span>}</>{speed&&<span className="alarm-key">Divergencia</span>}</div>
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={(speed?'Velocidad de la banda en centímetros por segundo':'Posición del objeto en centímetros')+', últimos 60 segundos'} onPointerLeave={()=>setHover(null)} onPointerMove={event=>{const rect=event.currentTarget.getBoundingClientRect();setHover((event.clientX-rect.left)/rect.width*width);}}>
      <title>{(speed?'Velocidad de la banda':'Posición del objeto')+' · últimos 60 segundos'}</title>
      {[0,1,2,3,4].map(i=>{const value=maximum*i/4;return <g key={i}><line className="chart-grid" x1={left} x2={width-right} y1={y(value)} y2={y(value)}/><text x={left-9} y={y(value)+4} textAnchor="end">{value.toFixed(speed?1:0)}</text></g>;})}
      {[-60,-45,-30,-15,0].map(seconds=><g key={seconds}><line className="chart-grid" x1={x(now+seconds*1000)} x2={x(now+seconds*1000)} y1={top} y2={height-bottom}/><text x={x(now+seconds*1000)} y={height-bottom+22} textAnchor="middle">{seconds}</text></g>)}
      <text x={left} y={12}>{speed?'cm/s':'cm'}</text><text x={width/2} y={height-3} textAnchor="middle">segundos</text>
      {speed&&<path className="chart-reference" d={path('reference')}/>}
      {speed&&<path className="chart-model" d={path('modelSpeed')}/>}
      <path className="chart-simulation" d={path(speed?'simulatedSpeed':'simulatedPosition')}/>
      <path className="chart-measured" d={path(speed?'speed':'position')}/>
      {speed&&data.filter(sample=>sample.divergence&&sample.speed!==null).map((sample,index)=><circle key={sample.at+'-'+index} className="chart-alarm" cx={x(sample.at)} cy={y(sample.speed!)} r="3"/>)}
      {!data.some(sample=>(speed?sample.speed:sample.position)!==null)&&<text className="chart-empty" x={width/2} y={height/2} textAnchor="middle">{speed?'Esperando telemetría':'Sin posición disponible'}</text>}
      {hovered&&hoveredValue!==null&&<g><line className="chart-cursor" x1={x(hovered.at)} x2={x(hovered.at)} y1={top} y2={height-bottom}/><circle className="chart-dot" cx={x(hovered.at)} cy={y(hoveredValue)} r="4"/><rect className="chart-tooltip" x={Math.min(width-212,Math.max(left,x(hovered.at)-90))} y={top+2} width="196" height={speed?80:42} rx="3"/>
        {[( (hovered.at-now)/1000).toFixed(1)+' s',
          (speed?'Encoder: ':'Posición: ')+hoveredValue.toFixed(2)+(speed?' cm/s':' cm'),
          ...(speed?['Modelo: '+(hovered.modelSpeed?.toFixed(2)??'—')+' cm/s','Error: '+(hovered.speedError?.toFixed(2)??'—')+' cm/s']:[])
        ].map((label,index)=><text key={index} x={Math.min(width-204,Math.max(left+8,x(hovered.at)-82))} y={top+18+index*18}>{label}</text>)}
      </g>}
    </svg>
  </div>;
}
