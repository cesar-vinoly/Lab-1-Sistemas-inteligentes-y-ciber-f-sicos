'use client';

import {useEffect, useLayoutEffect, useRef, useState} from 'react';
import {flushSync} from 'react-dom';
import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {DRACOLoader} from 'three/addons/loaders/DRACOLoader.js';
import {Checkbox} from '@/components/ui/checkbox';
import {Box, RotateCcw, ZoomIn, ZoomOut, Grid2X2, Maximize, PanelTop, Check, LoaderCircle, AlertCircle} from 'lucide-react';
import {ROTORS, createTransmission} from './transmission';
import type {Motion, RotorId, Transmission} from './transmission';
import {loadConveyorMaterials, applyRotorMaterial} from './rotor-materials';
import type {ConveyorMaterials} from './rotor-materials';
import {applySupportMaterial} from './support-materials';
import {applyBeltMaterials} from './belt';
import {createDetectedObject} from './detected-object';

type View = 'perspective'|'top'|'side';
type Part = 'base'|'supports'|'belt'|RotorId;
type ViewerState = {grid:boolean; view:View};
type Engine = {
  transmission: Transmission;
  detectedObject: ReturnType<typeof createDetectedObject>|null;
  grid: THREE.GridHelper;
  render: ()=>void;
  view: (view:View)=>void;
  zoom: (factor:number)=>void;
  fit: ()=>void;
};
type ModelContext = {registerTool:(tool:{name:string;title:string;description:string;inputSchema:object;annotations:{readOnlyHint:boolean};execute:(input:unknown)=>unknown},options:{signal:AbortSignal})=>void|Promise<void>};
const viewLabels: Record<View,string> = {perspective:'Perspectiva',top:'Superior',side:'Lateral'};
const MODELS: {id:Part;url:string}[] = [
  {id:'base',url:'/models/base.glb'}, {id:'supports',url:'/models/soportes.glb'},
  ...ROTORS.map(spec=>({id:spec.id,url:'/models/'+spec.file})),
  {id:'belt',url:'/models/correa.glb'},
];

export default function ConveyorViewer({motion,objectPosition=null}:{motion:Motion;objectPosition?:number|null}){
  const host=useRef<HTMLDivElement>(null);
  const engine=useRef<Engine|null>(null);
  const [state,setState]=useState<ViewerState>({grid:true,view:'perspective'});
  const stateRef=useRef(state);
  stateRef.current=state;
  const [status,setStatus]=useState<'loading'|'ready'|'preview'|'error'>('loading');
  const [progress,setProgress]=useState(0);
  const [error,setError]=useState('');
  const selectView=(view:View)=>{
    setState(s=>({...s,view}));
    engine.current?.view(view);
  };
  const toggleGrid=(visible:boolean)=>{
    setState(s=>({...s,grid:visible}));
    if(engine.current)engine.current.grid.visible=visible;
    engine.current?.render();
  };

  useLayoutEffect(()=>{
    if(status!=='ready'||!engine.current)return;
    const transmission=engine.current.transmission;
    if(document.hidden)transmission.resetClock();
    transmission.setMotion(motion,performance.now());
    if(document.hidden)transmission.resetClock();
    engine.current.render();
  },[motion.direction,motion.driveRpm,motion.targetRpm,motion.sampledAt,status]);

  useLayoutEffect(()=>{
    if(status!=='ready'||!engine.current?.detectedObject)return;
    engine.current.detectedObject.setPosition(objectPosition,performance.now());
    engine.current.render();
  },[objectPosition,status]);

  useEffect(()=>{
    const container=host.current;
    if(!container)return;
    let alive=true,dirty=true;
    let conveyorMaterials:ConveyorMaterials|null=null;
    let belt:ReturnType<typeof applyBeltMaterials>|null=null;
    let beltBounds:THREE.Box3|null=null;
    let detectedObject:ReturnType<typeof createDetectedObject>|null=null;
    const pendingScenes=new Set<THREE.Object3D>();
    const transmission=createTransmission();
    const scene=new THREE.Scene();
    const camera=new THREE.PerspectiveCamera(36,1,.002,30);
    let renderer:THREE.WebGLRenderer;
    try{
      renderer=new THREE.WebGLRenderer({antialias:true,alpha:true});
    }catch{
      setStatus('preview');return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio,2));
    renderer.setClearColor(0xe9eef3,0);
    renderer.outputColorSpace=THREE.SRGBColorSpace;
    renderer.toneMapping=THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure=1.12;
    renderer.shadowMap.enabled=true;
    renderer.shadowMap.type=THREE.PCFSoftShadowMap;
    renderer.domElement.setAttribute('aria-label','Modelo 3D de la cinta con base, soportes, engranajes, rodillos, encoder y correa. Usá el mouse, los gestos táctiles o los botones de vista para explorarlo.');
    renderer.domElement.setAttribute('role','img');
    renderer.domElement.tabIndex=0;
    container.appendChild(renderer.domElement);
    const controls=new OrbitControls(camera,renderer.domElement);
    controls.enableDamping=true;controls.dampingFactor=.10;
    controls.minDistance=.12;controls.maxDistance=3.5;
    controls.maxPolarAngle=Math.PI-.03;
    controls.screenSpacePanning=true;
    controls.addEventListener('start',()=>setState(s=>({...s,view:'perspective'})));
    controls.listenToKeyEvents(renderer.domElement);
    const requestRender=()=>{dirty=true;};
    controls.addEventListener('change',requestRender);
    scene.add(new THREE.HemisphereLight(0xf3f7ff,0x657283,2.35));
    const sun=new THREE.DirectionalLight(0xfff8ef,3.1);
    sun.position.set(.5,1.15,.6);sun.castShadow=true;
    sun.shadow.mapSize.set(2048,2048);
    sun.shadow.camera.left=-.7;sun.shadow.camera.right=.7;
    sun.shadow.camera.top=.7;sun.shadow.camera.bottom=-.7;
    sun.shadow.camera.near=.1;sun.shadow.camera.far=4;
    sun.shadow.normalBias=.00065;sun.shadow.bias=-.0001;
    sun.shadow.radius=3;
    scene.add(sun);
    const fill=new THREE.DirectionalLight(0xd6e7ff,1.25);
    fill.position.set(-.8,.4,-.7);scene.add(fill);
    const ground=new THREE.Mesh(new THREE.PlaneGeometry(4,4),new THREE.ShadowMaterial({opacity:.16,depthWrite:false}));
    ground.rotation.x=-Math.PI/2;ground.position.y=-.0003;ground.receiveShadow=true;scene.add(ground);
    const grid=new THREE.GridHelper(2.4,48,0xbdc8d5,0xcbd3de);
    const gridMaterial=grid.material as THREE.Material;
    gridMaterial.transparent=true;gridMaterial.opacity=.37;gridMaterial.depthWrite=false;
    grid.position.y=-.0005;scene.add(grid);
    // A common rigid transform makes the source CAD's negative Y direction point up.
    // All relative placements from the imported files remain unchanged.
    const assembly=new THREE.Group();assembly.rotation.z=Math.PI;
    const stage=new THREE.Group();stage.rotation.y=Math.PI/2;stage.add(assembly);scene.add(stage);
    const center=new THREE.Vector3(0,.07,0);
    let radius=.31;
    const fitDistance=()=>radius/Math.sin(THREE.MathUtils.degToRad(camera.fov/2))*Math.max(1,1/camera.aspect)*1.1;
    const applyView=(view:View)=>{
      controls.target.copy(center);
      camera.up.set(0,1,0);
      const direction=view==='top'?new THREE.Vector3(0,1,.00001):view==='side'?new THREE.Vector3(0,.025,1):new THREE.Vector3(.78,.62,1);
      if(view==='top')camera.up.set(0,0,-1);
      camera.position.copy(center).addScaledVector(direction.normalize(),fitDistance());
      camera.lookAt(center);controls.update();requestRender();
    };
    engine.current={transmission,detectedObject:null,grid,render:requestRender,view:applyView,
      zoom(factor){const diff=camera.position.clone().sub(controls.target);const length=THREE.MathUtils.clamp(diff.length()*factor,controls.minDistance,controls.maxDistance);camera.position.copy(controls.target).add(diff.setLength(length));controls.update();requestRender();},
      fit(){applyView(stateRef.current.view);}
    };
    const resize=()=>{
      const {width,height}=container.getBoundingClientRect();
      if(!width||!height)return;
      camera.aspect=width/height;camera.updateProjectionMatrix();renderer.setSize(width,height);
      requestRender();
    };
    const observer=new ResizeObserver(resize);observer.observe(container);resize();applyView('perspective');
    const draco=new DRACOLoader();draco.setDecoderPath('/draco/');draco.setWorkerLimit(2);
    const loader=new GLTFLoader();loader.setDRACOLoader(draco);
    const finishes=loadConveyorMaterials(Math.min(8,renderer.capabilities.getMaxAnisotropy())).then(materials=>{
      if(!alive){materials.dispose();return null;}
      conveyorMaterials=materials;return materials;
    });
    const ratios=Object.fromEntries(MODELS.map(model=>[model.id,0])) as Record<Part,number>;
    const load=async(part:Part,url:string)=>{
      const gltf=await loader.loadAsync(url,event=>{
        ratios[part]=event.total?event.loaded/event.total:0;
        if(alive)setProgress(Math.min(95,Math.round(Object.values(ratios).reduce((sum,value)=>sum+value,0)/MODELS.length*95)));
      });
      if(!alive){disposeObject(gltf.scene);return;}
      pendingScenes.add(gltf.scene);
      const spec=ROTORS.find(rotor=>rotor.id===part);
      if(spec||part==='supports'||part==='belt'){
        const materials=await finishes;
        if(!alive||!materials)return;
        if(spec)applyRotorMaterial(gltf.scene,spec,materials[spec.finish]);
        else if(part==='supports')applySupportMaterial(gltf.scene,materials.gray);
        else belt=applyBeltMaterials(gltf.scene,materials,transmission);
      }
      gltf.scene.traverse(object=>{
        if(!(object instanceof THREE.Mesh))return;
        object.castShadow=true;object.receiveShadow=true;
        const materials=Array.isArray(object.material)?object.material:[object.material];
        for(const material of materials){
          if(material instanceof THREE.MeshStandardMaterial){
            if(part==='base'){
              material.color.set(0xffffff);material.roughness=.86;material.metalness=0;
              if(material.map){material.map.colorSpace=THREE.SRGBColorSpace;material.map.anisotropy=Math.min(8,renderer.capabilities.getMaxAnisotropy());}
              material.needsUpdate=true;
            }
          }
        }
      });
      const object=spec?transmission.add(gltf.scene,spec):gltf.scene;
      if(part==='belt')beltBounds=new THREE.Box3().setFromObject(gltf.scene);
      assembly.add(object);
      pendingScenes.delete(gltf.scene);
      requestRender();
    };
    Promise.all([...MODELS.map(model=>load(model.id,model.url)),finishes]).then(()=>{
      if(!alive)return;
      const bounds=new THREE.Box3().setFromObject(stage);
      const origin=bounds.getCenter(new THREE.Vector3());
      stage.position.set(-origin.x,-bounds.min.y,-origin.z);
      const adjusted=new THREE.Box3().setFromObject(stage);
      adjusted.getCenter(center);radius=adjusted.getBoundingSphere(new THREE.Sphere()).radius;
      // Add after fitting: even an invisible mesh would otherwise change the
      // original bounds, camera distance and stage placement.
      if(beltBounds){
        detectedObject=createDetectedObject(beltBounds);assembly.add(detectedObject.mesh);
        if(engine.current)engine.current.detectedObject=detectedObject;
      }
      applyView(stateRef.current.view);setProgress(100);setStatus('ready');requestRender();
    }).catch(e=>{
      if(!alive)return;
      console.error('No se pudo cargar el modelo:',e);
      setError('No se pudieron cargar todos los modelos o texturas. Revisá los archivos del servidor y volvé a intentarlo.');setStatus('error');
    });
    const onContextLost=(event:Event)=>{event.preventDefault();if(alive){transmission.setDirection(0,performance.now());setError('Se interrumpió la vista 3D. Recargá el visor para continuar.');setStatus('error');}};
    renderer.domElement.addEventListener('webglcontextlost',onContextLost);
    // Pause elapsed-time accounting while the tab is hidden, so returning to
    // the viewer never produces a large catch-up jump. One existing render loop.
    const onVisibilityChange=()=>{transmission.resetClock();detectedObject?.resetClock();};
    document.addEventListener('visibilitychange',onVisibilityChange);
    renderer.setAnimationLoop(time=>{
      if(document.hidden){transmission.resetClock();detectedObject?.resetClock();return;}
      const moving=transmission.update(time);
      const objectMoving=detectedObject?.update(time)??false;
      const changed=controls.update();
      if(changed||dirty||moving||objectMoving){renderer.render(scene,camera);dirty=false;}
    });
    return()=>{
      alive=false;observer.disconnect();renderer.setAnimationLoop(null);controls.dispose();draco.dispose();
      document.removeEventListener('visibilitychange',onVisibilityChange);
      renderer.domElement.removeEventListener('webglcontextlost',onContextLost);
      belt?.dispose();
      const shared=new Set<THREE.Material>(conveyorMaterials?.all??[]);
      disposeObject(scene,shared);pendingScenes.forEach(root=>disposeObject(root,shared));pendingScenes.clear();
      conveyorMaterials?.dispose();renderer.dispose();renderer.domElement.remove();engine.current=null;
    };
  },[]);

  useEffect(()=>{
    if(status!=='ready')return;
    const context=(document as Document & {modelContext?:ModelContext}).modelContext;
    if(!context?.registerTool)return;
    const lifecycle=new AbortController();
    const read=()=>({...stateRef.current,status:'ready',motion:engine.current?.transmission.getState()});
    const tools=[{
      name:'get_conveyor_view',title:'Consultar vista de la cinta',description:'Devuelve la cámara, la cuadrícula y el movimiento del visor 3D.',
      inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true},execute:()=>read()
    },{
      name:'configure_conveyor_view',title:'Configurar vista de la cinta',description:'Cambia la cámara o la cuadrícula. No modifica el mando ni la geometría.',
      inputSchema:{type:'object',properties:{view:{type:'string',enum:['perspective','top','side']},grid:{type:'boolean'}},minProperties:1,additionalProperties:false},
      annotations:{readOnlyHint:false},async execute(input:unknown){
        if(!input||typeof input!=='object'||Array.isArray(input))throw Error('Se requiere un objeto.');
        const value=input as Record<string,unknown>;const keys=Object.keys(value);
        if(!keys.length||keys.some(k=>!['view','grid'].includes(k)))throw Error('Opciones inválidas.');
        if('grid'in value&&typeof value.grid!=='boolean')throw Error('La visibilidad debe ser booleana.');
        if('view'in value&&!['perspective','top','side'].includes(String(value.view)))throw Error('Vista inválida.');
        flushSync(()=>{
          if('grid'in value)toggleGrid(value.grid as boolean);
          if('view'in value)selectView(value.view as View);
        });
        await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
        return read();
      }
    }];
    for(const tool of tools){try{Promise.resolve(context.registerTool(tool,{signal:lifecycle.signal})).catch(()=>{});}catch{}}
    return()=>lifecycle.abort();
  },[status]);

  return <section className="panel viewer-panel" id="visor" aria-labelledby="visor-title">
    <header className="panel-heading viewer-heading">
      <h2 id="visor-title">Gemelo digital</h2>
      <div className="view-buttons" role="group" aria-label="Vistas de cámara">
        {(['perspective','top','side'] as View[]).map(view=><button key={view} aria-pressed={state.view===view} onClick={()=>selectView(view)} disabled={status!=='ready'} title={'Vista '+viewLabels[view].toLowerCase()}>{view==='perspective'?<Box size={16}/>:view==='top'?<PanelTop size={16}/>:<Grid2X2 size={16}/>}<span>{viewLabels[view]}</span></button>)}
      </div>
    </header>
    <div className="viewport" aria-label="Visor del conjunto">
      <div className="canvas-host" ref={host}/>
      {status==='preview'&&<div className="static-preview"><img src="/model-preview.png" alt="Vista del ensamble con base, soportes, engranajes, rodillos, encoder y correa"/><p><AlertCircle size={16}/><span>Vista previa estática. Activá la aceleración gráfica de tu navegador para explorar y animar en 3D.</span></p></div>}
      {status==='loading'&&<div className="loading-layer" role="status"><div className="loading-card"><LoaderCircle className="spin" size={28}/><strong>Preparando el conjunto</strong><span>Cargando modelos y texturas…</span><div className="progress-track"><div style={{width:progress+'%'}}/></div><small>{progress}%</small></div></div>}
      {status==='error'&&<div className="loading-layer" role="alert"><div className="loading-card error-card"><AlertCircle size={28}/><strong>No se pudo abrir el visor</strong><p>{error}</p><button className="btn" onClick={()=>window.location.reload()}>Volver a cargar</button></div></div>}
      <div className="viewport-bottom">
        <div className="grid-toggle"><Checkbox id="grid-visible" checked={state.grid} onCheckedChange={v=>toggleGrid(v===true)} aria-label="Mostrar cuadrícula" disabled={status!=='ready'}/><label htmlFor="grid-visible">Cuadrícula</label></div>
        <div className="camera-tools" role="group" aria-label="Controles de cámara"><button onClick={()=>engine.current?.zoom(.8)} disabled={status!=='ready'} aria-label="Acercar" title="Acercar"><ZoomIn size={19}/></button><button onClick={()=>engine.current?.zoom(1.25)} disabled={status!=='ready'} aria-label="Alejar" title="Alejar"><ZoomOut size={19}/></button><span/><button onClick={()=>engine.current?.fit()} disabled={status!=='ready'} aria-label="Encuadrar conjunto" title="Encuadrar conjunto"><Maximize size={18}/></button><button onClick={()=>selectView('perspective')} disabled={status!=='ready'} aria-label="Restablecer vista" title="Restablecer vista"><RotateCcw size={18}/></button></div>
      </div>
    </div>
    <footer className="viewer-footer"><span className="interaction-hints">Arrastrar para girar · Rueda para acercar · Botón derecho para desplazar</span><span className="touch-hint">Un dedo para girar · Dos dedos para acercar</span><span className="load-status" role="status">{status==='ready'?<><Check size={14}/>Visor listo</>:status==='error'?'Error de carga':status==='preview'?'Vista estática':'Cargando…'}</span></footer>
  </section>;
}

function disposeObject(root:THREE.Object3D,sharedMaterials=new Set<THREE.Material>()){
  const geometries=new Set<THREE.BufferGeometry>(),materials=new Set<THREE.Material>(),textures=new Set<THREE.Texture>();
  root.traverse(object=>{
    if(object instanceof THREE.Mesh||object instanceof THREE.LineSegments){
      geometries.add(object.geometry);
      for(const material of Array.isArray(object.material)?object.material:[object.material]){
        if(sharedMaterials.has(material))continue;
        materials.add(material);
        for(const value of Object.values(material))if(value instanceof THREE.Texture)textures.add(value);
      }
    }
  });
  geometries.forEach(g=>g.dispose());materials.forEach(m=>m.dispose());textures.forEach(t=>t.dispose());
}
