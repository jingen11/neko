(function(){
const stage=document.getElementById('stage');
if(!window.THREE||!THREE.OrbitControls){stage.insertAdjacentHTML('beforeend','<div class="err">The 3D engine could not load. Check your connection and reload the page.</div>');return;}

/* ---------- scene ---------- */
const renderer=new THREE.WebGLRenderer({antialias:true});
renderer.setPixelRatio(Math.min(devicePixelRatio,2));
renderer.shadowMap.enabled=true; renderer.shadowMap.type=THREE.PCFSoftShadowMap;
stage.prepend(renderer.domElement);
const scene=new THREE.Scene();
const camera=new THREE.PerspectiveCamera(40,1,0.1,400);
const controls=new THREE.OrbitControls(camera,renderer.domElement);
controls.enableDamping=true; controls.maxPolarAngle=Math.PI*0.49; controls.minDistance=3; controls.maxDistance=70;

scene.add(new THREE.HemisphereLight(0xffffff,0x8a8f86,0.75));
const sun=new THREE.DirectionalLight(0xfff4e2,0.85);
sun.position.set(14,22,-9); sun.target.position.set(4,0,5);
sun.castShadow=true; sun.shadow.mapSize.set(2048,2048);
Object.assign(sun.shadow.camera,{left:-16,right:16,top:16,bottom:-16,near:1,far:70});
sun.shadow.bias=-0.0006;
scene.add(sun,sun.target);

function readTheme(){
  const cs=getComputedStyle(document.documentElement);
  scene.background=new THREE.Color(cs.getPropertyValue('--scene').trim()||'#e4e9ec');
}
readTheme();
matchMedia('(prefers-color-scheme: dark)').addEventListener('change',readTheme);
new MutationObserver(readTheme).observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']});

/* All geometry below is written in centimetres, in the floor plan's own coordinates:
   x runs west→east, z runs front (north) → back (south). The root group scales to metres. */
const root=new THREE.Group(); root.scale.setScalar(0.01); scene.add(root);
const G={};['g','u','roof','proof','site','nb','ov','facade'].forEach(k=>{G[k]=new THREE.Group();root.add(G[k]);});
const H=250, UB=265;

const std=(c,o={})=>new THREE.MeshStandardMaterial(Object.assign({color:c,roughness:.85,metalness:0},o));
const M={
  wall:std(0xf7f8f6), cap:std(0xd7dadd), frame:std(0xfbfdfd,{roughness:.42}),
  glass:std(0x68889b,{transparent:true,opacity:.38,roughness:.12,metalness:.18,depthWrite:false}),
  door:std(0x4a2d25,{roughness:.64}), idoor:std(0x98755a,{roughness:.7}),
  floorIn:std(0xdcd6cb), floorUp:std(0xd8cdb9), tileOut:std(0xb3bab8), porch:std(0xb7c0c1),
  grass:std(0x648a54), ground:std(0xaab3ae), road:std(0x5e6467), roof:std(0x434a53,{roughness:.82,side:THREE.DoubleSide}),
  ptile:std(0x464d55,{roughness:.75}), counter:std(0xe9e5dc), top:std(0x2e3337,{roughness:.4}),
  stair:std(0xcdbfa8), steel:std(0xb3c2c8,{metalness:.75,roughness:.23}), gate:std(0x242e39,{metalness:.42,roughness:.43}),
  fence:std(0x584638), trunk:std(0x73604a), leaf:std(0x3f7044), leaf2:std(0x507d4c),
  ghost:std(0xcfd4d7,{transparent:true,opacity:.42,depthWrite:false}),
  frost:std(0xe6edf0,{transparent:true,opacity:.82,roughness:.6}),
  frostDoor:std(0x8d9ba3,{transparent:true,opacity:.9,roughness:.5}),
  inox:std(0xd8e1e5,{metalness:.85,roughness:.19}), pergola:std(0x222a31,{metalness:.42,roughness:.4}),
  gateInset:std(0x303c49,{metalness:.55,roughness:.43}), metalDetail:std(0x82929b,{metalness:.74,roughness:.3}),
  woodGroove:std(0x322321,{roughness:.8}), concrete:std(0xd9dcdb),
  balconyGlass:std(0x83bec4,{transparent:true,opacity:.44,metalness:.14,roughness:.1,depthWrite:false,side:THREE.DoubleSide}),
  glassDark:std(0x526b7b,{metalness:.3,roughness:.14,transparent:true,opacity:.68,depthWrite:false}),
  roofEdge:std(0x363c44), terracotta:std(0xb9a9a0),
};

// Repeatable roof-tile pattern based on the charcoal overlapping tiles in the reference photos.
function roofTexture(){
  const c=document.createElement('canvas'); c.width=256; c.height=256;
  const q=c.getContext('2d'); q.fillStyle='#4a5058';q.fillRect(0,0,256,256);
  for(let row=0;row<8;row++){
    const y=row*32,offset=row%2?32:0;
    for(let col=-1;col<5;col++){
      const x=col*64+offset;
      q.fillStyle=(row+col)%3===0?'#505760':(row+col)%3===1?'#464d55':'#4b5159';
      q.fillRect(x+2,y+2,60,29);
      q.strokeStyle='rgba(21,28,34,.40)';q.lineWidth=2;
      q.beginPath();q.moveTo(x+1,y+29);q.quadraticCurveTo(x+32,y+38,x+63,y+29);q.stroke();
      q.strokeStyle='rgba(203,214,224,.13)';q.lineWidth=1;
      q.beginPath();q.moveTo(x+6,y+4);q.lineTo(x+6,y+25);q.stroke();
    }
  }
  const t=new THREE.CanvasTexture(c);t.wrapS=t.wrapT=THREE.RepeatWrapping;
  t.anisotropy=Math.min(8,renderer.capabilities.getMaxAnisotropy());
  t.colorSpace=THREE.SRGBColorSpace||undefined;
  return t;
}
const tileTexture=roofTexture();
const roofMaterial=std(0xffffff,{map:tileTexture,roughness:.86,side:THREE.DoubleSide});
const porchTileTexture=tileTexture.clone();porchTileTexture.repeat.set(12,12);porchTileTexture.needsUpdate=true;
const porchRoofMaterial=std(0xffffff,{map:porchTileTexture,roughness:.84});

// Low-contrast irregular stone paving, made without external images.
function pavingMaterial(repx,repz){
  const c=document.createElement('canvas');c.width=256;c.height=256;const q=c.getContext('2d');
  q.fillStyle='#aab5b7';q.fillRect(0,0,256,256);
  for(let r=0;r<4;r++)for(let k=0;k<4;k++){
    const x=k*64+(r%2)*32-32,y=r*64;
    q.fillStyle=['#aab5b7','#b5c0c0','#a3adae','#bdc5c4'][(k+r*3+8)%4];
    q.fillRect(x+1,y+1,62,62);
    q.fillStyle='rgba(240,244,242,.40)';q.fillRect(x+1,y+1,62,1);
  }
  const t=new THREE.CanvasTexture(c);t.wrapS=t.wrapT=THREE.RepeatWrapping;t.repeat.set(repx,repz);
  return std(0xffffff,{map:t,roughness:.92});
}
function box(g,x0,x1,y0,y1,z0,z1,mat,shadow=true){
  const m=new THREE.Mesh(new THREE.BoxGeometry(Math.max(x1-x0,.2),Math.max(y1-y0,.2),Math.max(z1-z0,.2)),mat);
  m.position.set((x0+x1)/2,(y0+y1)/2,(z0+z1)/2);
  if(shadow){m.castShadow=true;m.receiveShadow=true;}
  g.add(m); return m;
}
const OP={w3:[90,210],w2:[90,210],wk:[105,210],lv:[175,208],slide:[0,210],steel:[0,212],door:[0,210]};
function fill(g,ax,c,s,e,base,y0,y1,type){
  if(type==='door'||type==='steel')return;
  const P=(ps,pe,a,b,d,mat)=>ax==='x'?box(g,ps,pe,base+a,base+b,c-d/2,c+d/2,mat,false):box(g,c-d/2,c+d/2,base+a,base+b,ps,pe,mat,false);
  const f=4;
  P(s,e,y0,y0+f,8,M.frame);P(s,e,y1-f,y1,8,M.frame);P(s,s+f,y0,y1,8,M.frame);P(e-f,e,y0,y1,8,M.frame);
  // toilet window: one high, top-hung frosted pane
  if(type==='lv'){P(s+f,e-f,y0+f,y1-f,1.5,M.frost);return;}
  P(s+f,e-f,y0+f,y1-f,1.5,type==='slide'?M.frost:M.glass);
  const n=(type==='w3'||type==='wk')?3:2;
  for(let i=1;i<n;i++){const x=s+(e-s)*i/n;P(x-2,x+2,y0,y1,7,M.frame);}
}
/* An axis-aligned wall on a centreline. ax 'x': runs along x at z=c; 'z': runs along z at x=c.
   ops: [start,end,type] openings measured along the wall. */
function wall(g,ax,c,a,b,t,base,ops=[]){
  const seg=(s,e,y0,y1,mat=M.wall)=>ax==='x'?box(g,s,e,base+y0,base+y1,c-t/2,c+t/2,mat):box(g,c-t/2,c+t/2,base+y0,base+y1,s,e,mat);
  const A=a-t/2,B=b+t/2; let cur=A;
  ops.slice().sort((p,q)=>p[0]-q[0]).forEach(([s,e,type])=>{
    const [sill,head]=OP[type];
    if(s>cur)seg(cur,s,0,H);
    if(sill>0)seg(s,e,0,sill);
    if(head<H)seg(s,e,head,H);
    fill(g,ax,c,s,e,base,sill,head,type); cur=e;
  });
  if(B>cur)seg(cur,B,0,H);
  seg(A,B,H,H+1.5,M.cap);
}
function leaf(g,x1,z1,x2,z2,base,mat){
  if(mat==='wet'){ // waterproof toilet door: white aluminium frame, frosted panel
    const a=Math.min(x1===x2?z1:x1,x1===x2?z2:x2),b=Math.max(x1===x2?z1:x1,x1===x2?z2:x2);
    const P=(s,e,y0,y1,d,m)=>x1===x2?box(g,x1-d/2,x1+d/2,base+y0,base+y1,s,e,m):box(g,s,e,base+y0,base+y1,z1-d/2,z1+d/2,m);
    P(a,b,1,9,4,M.frame);P(a,b,197,205,4,M.frame);P(a,a+7,1,205,4,M.frame);P(b-7,b,1,205,4,M.frame);
    P(a+7,b-7,9,197,2,M.frostDoor);
    return;
  }
  if(x1===x2)box(g,x1-2,x1+2,base+1,base+205,Math.min(z1,z2),Math.max(z1,z2),mat);
  else box(g,Math.min(x1,x2),Math.max(x1,x2),base+1,base+205,z1-2,z1+2,mat);
}
function shape(pts,holes=[]){
  const s=new THREE.Shape(pts.map(p=>new THREE.Vector2(p[0],p[1])));
  holes.forEach(h=>s.holes.push(new THREE.Path(h.map(p=>new THREE.Vector2(p[0],p[1])))));
  return s;
}
function slab(g,pts,top,depth,mat,holes){
  const geo=new THREE.ExtrudeGeometry(shape(pts,holes),{depth,bevelEnabled:false});
  const m=new THREE.Mesh(geo,mat); m.rotation.x=Math.PI/2; m.position.y=top;
  m.receiveShadow=true; m.castShadow=true; g.add(m); return m;
}
const rect=(x0,x1,z0,z1)=>[[x0,z0],[x1,z0],[x1,z1],[x0,z1]];
function railing(g,ax,c,a,b,base){
  const P=(s,e,y0,y1,d,mat,sh)=>ax==='x'?box(g,s,e,base+y0,base+y1,c-d/2,c+d/2,mat,sh):box(g,c-d/2,c+d/2,base+y0,base+y1,s,e,mat,sh);
  P(a,b,0,12,14,M.wall,true);
  P(a,b,14,100,1.5,M.balconyGlass,false);
  P(a,b,100,104,5,M.steel,true);
  P(a,b,13,16,2,M.steel,true);
  const n=Math.max(1,Math.round((b-a)/110));
  for(let i=0;i<=n;i++){const x=a+(b-a)*i/n;P(x-2.5,x+2.5,12,104,5,M.steel,true);}
}
function hipRoof(g,x0,x1,z0,z1,y,rise,mat){
  const w=x1-x0,xc=(x0+x1)/2,h=y+rise;
  const A=[x0,y,z0],B=[x1,y,z0],C=[x1,y,z1],D=[x0,y,z1];
  const R1=[xc,h,z0+w/2],R2=[xc,h,z1-w/2];
  // A pitched hip roof with individually mapped charcoal clay roof tiles.
  const triangles=[[A,R1,B],[C,R2,D],[B,R1,R2],[B,R2,C],[D,R2,R1],[D,R1,A]];
  const pos=[],uv=[];
  for(const face of triangles)for(const p of face){pos.push(...p);uv.push(p[0]/160,p[2]/140);}
  const geo=new THREE.BufferGeometry();
  geo.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));
  geo.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));
  geo.computeVertexNormals();
  const m=new THREE.Mesh(geo,roofMaterial);m.castShadow=true;m.receiveShadow=true;g.add(m);
  box(g,x0,x1,y-8,y-1,z0-5,z0+5,M.roofEdge);
  box(g,x0,x1,y-8,y-1,z1-5,z1+5,M.roofEdge);
  box(g,x0-5,x0+5,y-8,y-1,z0,z1,M.roofEdge);
  box(g,x1-5,x1+5,y-8,y-1,z0,z1,M.roofEdge);
  box(g,xc-5,xc+5,h-3,h+3,R1[2],R2[2],M.roofEdge);
}
function branch(group,a,b,r,material){
  const p=new THREE.Vector3(...a),q=new THREE.Vector3(...b),delta=new THREE.Vector3().subVectors(q,p);
  const mesh=new THREE.Mesh(new THREE.CylinderGeometry(Math.max(1,r*.68),r,delta.length(),7),material);
  mesh.position.copy(p.add(q).multiplyScalar(.5));mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),delta.normalize());
  mesh.castShadow=true;group.add(mesh);
}
function roofQuad(group,a,b,c,d,th,material){
  const pts=[a,b,c,d];
  const down=pts.map(([x,y,z])=>[x,y-th,z]);
  const faces=[
    [a,b,c],[a,c,d], // top
    [down[2],down[1],down[0]],[down[3],down[2],down[0]], // bottom
    [a,d,down[3]],[a,down[3],down[0]],
    [d,c,down[2]],[d,down[2],down[3]],
    [c,b,down[1]],[c,down[1],down[2]],
    [b,a,down[0]],[b,down[0],down[1]],
  ];
  const geo=new THREE.BufferGeometry();
  const vertices=faces.flat(1), positions=[],uv=[];
  for(const p of vertices){
    positions.push(...p);
    // Same world-scale UVs as hipRoof: charcoal tiles match the main/porch roof.
    uv.push(p[0]/160,p[2]/140);
  }
  geo.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
  geo.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));
  geo.computeVertexNormals();
  const mesh=new THREE.Mesh(geo,material);
  mesh.castShadow=mesh.receiveShadow=true;group.add(mesh);
  return mesh;
}
function foliage(group,x,y,z,rx,ry,rz,i=0){
  const m=new THREE.Mesh(new THREE.SphereGeometry(1,12,8),i%3===0?M.leaf2:M.leaf);
  m.position.set(x,y,z);m.scale.set(rx,ry,rz);m.castShadow=true;m.receiveShadow=true;group.add(m);
}
function tree(group,x,z,s=1){
  // Flat, sculpted evergreen crowns and exposed branching trunks, like the real side garden.
  branch(group,[x,1,z],[x+5*s,114*s,z+2*s],7*s,M.trunk);
  [[-24,134,-8],[-42,157,8],[26,143,4],[44,169,-7]].forEach(([dx,dy,dz])=>
    branch(group,[x+5*s,108*s,z+2*s],[x+dx*s,dy*s,z+dz*s],3*s,M.trunk));
  [[0,192,0,60,26,50],[-41,164,3,46,24,39],[41,169,-5,42,24,42],
    [8,227,10,46,25,42],[-11,119,8,37,20,34],[29,124,-9,31,19,31]].forEach((a,i)=>
      foliage(group,x+a[0]*s,a[1]*s,z+a[2]*s,a[3]*s,a[4]*s,a[5]*s,i));
}
function shrub(group,x,z,s=1){
  branch(group,[x,3,z],[x,39*s,z],3*s,M.trunk);
  [[-11,40,1],[9,46,-6],[0,52,12]].forEach(([dx,y,dz],i)=>
    foliage(group,x+dx*s,y*s,z+dz*s,23*s,17*s,21*s,i));
}

/* ---------- ground floor ---------- */
const g=G.g;
slab(g,[[6,6],[624,6],[624,840],[714,840],[714,1434],[6,1434]],1,12,M.floorIn);
wall(g,'x',6,6,624,15,0,[[90,270,'door'],[370,550,'w3']]);
wall(g,'z',624,6,840,15,0,[[570,750,'slide']]);
wall(g,'x',840,624,714,15,0);
wall(g,'z',714,840,1434,15,0,[[951,1131,'wk'],[1236,1326,'steel']]);
// kitchen side door: 0.9 m stainless steel barn-style panel on an outside top rail, slides south; grille in the upper half
(function(){
  const x0=723,x1=727,z0=1230,z1=1332;
  box(g,x0,x1,1,212,z0,z1,M.inox);
  for(let y=128;y<204;y+=11)box(g,x1,x1+3,y,y+3,z0+12,z1-12,M.inox);
  box(g,x1,x1+2,125,127,z0+10,z1-10,M.inox);box(g,x1,x1+2,204,206,z0+10,z1-10,M.inox);
  box(g,724,729,216,220,1226,1438,M.inox);
  [1236,1300,1370].forEach(z=>box(g,722,725,212,222,z-3,z+3,M.inox));
})();
wall(g,'x',1434,6,714,15,0,[[16,116,'w2'],[231,291,'lv'],[414,594,'w3']]);
wall(g,'z',6,6,1434,15,0);
wall(g,'x',474,6,336,12,0);
wall(g,'x',694,6,336,10,0);
wall(g,'z',336,694,1254,10,0,[[724,814,'door']]);
wall(g,'z',126,1254,1434,10,0);
wall(g,'x',1254,126,396,10,0,[[134,209,'door']]);
wall(g,'z',396,1254,1434,10,0,[[1262,1337,'door']]);
box(g,624,714,0,H,1206,1236,M.wall); box(g,624,714,H,H+1.5,1206,1236,M.cap);
box(g,102,312,0,H,580,590,M.wall);
// C-shaped stair: long first flight climbs west, landing at the west wall, short second flight back east
const R=UB/15;
for(let i=0;i<10;i++)box(g,312-(i+1)*21,312-i*21,0,(i+1)*R,480,580,M.stair);
box(g,13,102,0,10*R,480,690,M.stair);
for(let j=0;j<5;j++)box(g,102+j*20.4,102+(j+1)*20.4,0,(11+j)*R,590,690,M.stair);
// counters
box(g,648,708,0,86,846,1206,M.counter); box(g,646,710,86,92,844,1206,M.top);
box(g,400,708,0,86,1368,1428,M.counter); box(g,400,710,86,92,1366,1430,M.top);
[[90,6,90,96,M.door],[270,6,270,96,M.door],[336,724,246,724,M.idoor],[134,1254,134,1329,'wet'],[396,1262,321,1262,'wet']]
  .forEach(([a,b,c,d,m])=>leaf(g,a,b,c,d,0,m));

/* ---------- upper floor ---------- */
const u=G.u;
slab(u,[[6,6],[624,6],[624,1124],[314,1124],[314,1434],[6,1434]],UB,15,M.floorUp,[rect(8,202,480,690)]);
slab(u,[[624,540],[714,540],[714,1434],[314,1434],[314,1124],[624,1124]],UB,15,M.tileOut);
wall(u,'x',6,6,624,15,UB,[[61,121,'lv'],[369,549,'w3']]);
wall(u,'z',624,6,1124,15,UB,[[286,406,'w2'],[546,726,'slide'],[884,1004,'w2']]);
wall(u,'z',6,6,1434,15,UB);
wall(u,'x',1434,6,314,15,UB,[[156,276,'w2']]);
wall(u,'x',474,6,624,10,UB,[[224,314,'door']]);
wall(u,'z',176,6,276,10,UB);
wall(u,'x',276,6,176,10,UB,[[80,170,'door']]);
wall(u,'x',694,6,206,10,UB);
wall(u,'z',206,694,914,10,UB,[[702,777,'door']]);
wall(u,'x',914,6,206,10,UB);
wall(u,'x',794,206,624,10,UB,[[212,302,'door'],[322,412,'door']]);
wall(u,'z',314,794,1434,10,UB,[[1180,1270,'door']]);
wall(u,'x',1124,314,624,10,UB,[[374,464,'door']]);
railing(u,'x',540,624,714,UB); railing(u,'z',714,540,1434,UB); railing(u,'x',1434,314,714,UB); railing(u,'z',202,480,590,UB);
[[224,474,224,384,M.idoor],[170,276,170,186,'wet'],[206,702,131,702,'wet'],[302,794,302,884,M.idoor],[322,794,322,884,M.idoor],[314,1270,224,1270,M.idoor],[374,1124,374,1034,M.idoor]]
  .forEach(([a,b,c,d,m])=>leaf(u,a,b,c,d,UB,m));

/* ---------- roofs ---------- */
slab(G.roof,rect(-1,631,-1,1441),UB+H+12,12,M.wall);
hipRoof(G.roof,-50,680,-50,1490,UB+H+12,155,M.roof);
// The upstairs front elevation has a triangular gable and a smaller tiled hood over
// its three-panel window. Both are cosmetic, not changes to the existing floor plan.
(function(){
  const z=-56, x0=351,x1=573,base=UB+H+11,apex=base+65,mid=(x0+x1)/2;
  const geo=new THREE.BufferGeometry();
  geo.setAttribute('position',new THREE.Float32BufferAttribute([x0,base,z,x1,base,z,mid,apex,z],3));
  geo.computeVertexNormals();
  const face=new THREE.Mesh(geo,new THREE.MeshStandardMaterial({color:0xe6e8e9,side:THREE.DoubleSide,roughness:.95}));
  G.roof.add(face);
  branch(G.roof,[x0,base,z-5],[mid,apex,z-5],4,M.roofEdge);
  branch(G.roof,[mid,apex,z-5],[x1,base,z-5],4,M.roofEdge);
  box(G.roof,x0-8,x1+8,base-7,base+1,z-9,z+20,M.roofEdge);
})();
// ONE continuous charcoal-tiled roof body: the pitched front porch flows straight
// into the narrow east-side pavement canopy. There is no second roof edge, fascia,
// or overlapping slab at the porch/side junction, and the garden remains uncovered.
(function(){
  const zFront=-660, zPorchRear=10, zSideEnd=540;
  const xLeft=-14, xRidge=319, xHouseEdge=624, xPavementEdge=730;
  const yEave=276, yRidge=364;
  const rightPitch=(yRidge-yEave)/(652-xRidge);
  const roofY=x=>x<=xRidge
    ? yEave+(x-xLeft)*(yRidge-yEave)/(xRidge-xLeft)
    : yRidge-(x-xRidge)*rightPitch;
  const thickness=9;
  const top=[], bottom=[], fascia=[];
  const appendTriangle=(into,a,b,c)=>{into.push(...a,...b,...c);};
  function quad(x0,x1,z0,z1){
    const a=[x0,roofY(x0),z0],b=[x1,roofY(x1),z0];
    const c=[x1,roofY(x1),z1],d=[x0,roofY(x0),z1];
    appendTriangle(top,a,c,b);appendTriangle(top,a,d,c);
    const lower=([x,y,z])=>[x,y-thickness,z];
    appendTriangle(bottom,lower(a),lower(b),lower(c));
    appendTriangle(bottom,lower(a),lower(c),lower(d));
  }
  // A single L-shaped roof footprint: the porch over the driveway, plus ONLY
  // the narrow x=624..730 strip beside (not above) the lawn.
  quad(xLeft,xRidge,zFront,zPorchRear);
  quad(xRidge,xHouseEdge,zFront,zPorchRear);
  quad(xHouseEdge,xPavementEdge,zFront,zSideEnd);
  const perimeter=[
    [xLeft,zFront], [xRidge,zFront], [xPavementEdge,zFront],
    [xPavementEdge,zSideEnd], [xHouseEdge,zSideEnd],
    [xHouseEdge,zPorchRear], [xRidge,zPorchRear], [xLeft,zPorchRear]
  ];
  perimeter.forEach(([x0,z0],i)=>{
    const [x1,z1]=perimeter[(i+1)%perimeter.length];
    const a=[x0,roofY(x0),z0],b=[x1,roofY(x1),z1];
    const c=[x1,roofY(x1)-thickness,z1],d=[x0,roofY(x0)-thickness,z0];
    appendTriangle(fascia,a,b,c);appendTriangle(fascia,a,c,d);
  });
  // Exactly one tile-mapped mesh for the porch and the entire front side canopy.
  // Mapping uses the same global scale as the main house roof.
  function surface(vertices,material){
    const geo=new THREE.BufferGeometry(),tex=[];
    for(let i=0;i<vertices.length;i+=3)tex.push(vertices[i]/160,vertices[i+2]/140);
    geo.setAttribute('position',new THREE.Float32BufferAttribute(vertices,3));
    geo.setAttribute('uv',new THREE.Float32BufferAttribute(tex,2));
    geo.computeVertexNormals();
    const mesh=new THREE.Mesh(geo,material);
    mesh.castShadow=mesh.receiveShadow=true;G.proof.add(mesh);
  }
  surface(top,roofMaterial);
  surface(bottom,M.concrete);
  const fasciaMaterial=M.roofEdge.clone();
  fasciaMaterial.side=THREE.DoubleSide;
  surface(fascia,fasciaMaterial);
  // Trace the exposed eaves only. The inner porch-to-side seam deliberately
  // has no trim, because the tile plane is physically continuous there.
  const outline=[
    [xLeft,zFront],[xRidge,zFront],[xPavementEdge,zFront],
    [xPavementEdge,zSideEnd],[714,zSideEnd] // 714..730 joins transition below
  ];
  for(let i=0;i<outline.length-1;i++){
    const [x0,z0]=outline[i],[x1,z1]=outline[i+1];
    branch(G.proof,[x0,roofY(x0)-3,z0],[x1,roofY(x1)-3,z1],3.5,M.roofEdge);
  }
  // Rear side eave terminates at the corridor clearance line, while a slim
  // transitional strip continues from x714..730 without cutting across it.
  branch(G.proof,[xHouseEdge,roofY(xHouseEdge)-3,zSideEnd],
                 [714,roofY(714)-3,zSideEnd],3.5,M.roofEdge);
  branch(G.proof,[xHouseEdge,roofY(xHouseEdge)-3,zPorchRear],
                 [xHouseEdge,roofY(xHouseEdge)-3,zSideEnd],3.5,M.roofEdge);
  branch(G.proof,[xLeft,roofY(xLeft)-3,zPorchRear],
                 [xRidge,roofY(xRidge)-3,zPorchRear],3.5,M.roofEdge);
  branch(G.proof,[xRidge,roofY(xRidge)-3,zPorchRear],
                 [xHouseEdge,roofY(xHouseEdge)-3,zPorchRear],3.5,M.roofEdge);
  branch(G.proof,[xLeft,roofY(xLeft)-3,zFront],
                 [xLeft,roofY(xLeft)-3,zPorchRear],3.5,M.roofEdge);
  // The ridge runs front-to-back, pointing towards the upstairs toilet louvre.
  branch(G.proof,[xRidge,yRidge+1,zFront],
                 [xRidge,yRidge+1,zPorchRear],4.5,M.roofEdge);

  // Keep the original front porch supports and under-roof beam.
  box(G.proof,20,46,0,272,-555,-529,M.wall);
  box(G.proof,578,604,0,272,-555,-529,M.wall);
  box(G.proof,-6,644,264,273,-666,-646,M.concrete);

  // Corridor-safe tapered link: at z=540 it shares the SAME exact edge with
  // the single-piece porch/side canopy, then steps down to the rear side roof.
  const T1=[714,roofY(714),zSideEnd],T2=[730,roofY(730),zSideEnd];
  const T3=[730,231.866667,660],T4=[714,234,660];
  roofQuad(G.proof,T1,T2,T3,T4,8,roofMaterial);
  branch(G.proof,T2,T3,3.5,M.roofEdge);
  branch(G.proof,T4,T1,3.5,M.roofEdge);
  // Outer supports remain solely on the paving, never on the lawn.
  for(const z of [-540,-100,330])box(G.proof,720,728,0,226,z-9,z+9,M.wall);
})();

// The rear side and back canopies retain their current geometry and height.
(function(){
  // Cover the previously exposed paving outside the ground-floor side sliding door
  // (east wall x=624, door opening z=570..750). This piece is tucked BELOW the
  // upper corridor: highest point y=242, under its underside at approx. y=250.
  // It meets the already tiled side canopy at x=714 without projecting above
  // the garden, and ends at z=840 where the main building widens.
  const D1=[624,242,540], D2=[714,234,540];
  const D3=[714,234,840], D4=[624,242,840];
  roofQuad(G.proof,D1,D2,D3,D4,8,roofMaterial);
  // Only the newly exposed front and wall-side eaves are trimmed; do not
  // introduce a seam across the joint with the existing side roof.
  branch(G.proof,D1,D2,3.5,M.roofEdge);
  branch(G.proof,D4,D1,3.5,M.roofEdge);

  // Rear side pavement roof: starts OUTSIDE the corridor so it does not overlap it.
  const S1=[714,234,660], S2=[894,210,660], S3=[894,210,1434], S4=[714,234,1434];
  roofQuad(G.proof,S1,S2,S3,S4,8,roofMaterial);
  [[S1,S2],[S2,S3],[S3,S4],[S4,S1]].forEach(([p,q])=>branch(G.proof,p,q,4,M.roofEdge));

  // Main back-yard roof strip.
  const B1=[6,234,1434], B2=[714,234,1434], B3=[714,214,1542], B4=[6,214,1542];
  roofQuad(G.proof,B1,B2,B3,B4,8,roofMaterial);
  [[B1,B2],[B2,B3],[B3,B4],[B4,B1]].forEach(([p,q])=>branch(G.proof,p,q,4,M.roofEdge));

  // Back-right corner piece ties the rear side roof into the back-yard roof cleanly.
  const C1=[714,234,1434], C2=[894,210,1434], C3=[894,190,1542], C4=[714,214,1542];
  roofQuad(G.proof,C1,C2,C3,C4,8,roofMaterial);
  [[C1,C2],[C2,C3],[C3,C4],[C4,C1]].forEach(([p,q])=>branch(G.proof,p,q,4,M.roofEdge));

  // Supports only on the outer boundary edges of the added roofs.
  for(const z of [790,1240])box(G.proof,878,892,0,198,z-12,z+12,M.wall);
  for(const x of [54,250,446,642])box(G.proof,x-12,x+12,0,210,1522,1536,M.wall);
  box(G.proof,838-12,838+12,0,188,1522,1536,M.wall);
})();

/* ---------- site ---------- */
const s=G.site;
box(s,-2500,3200,-6,-2,-2400,3200,M.ground,false).receiveShadow=true;
box(s,-2500,3200,-2,0,-1450,-720,M.road,false).receiveShadow=true;
box(s,6,624,0,2,-654,6,pavingMaterial(2.8,3.2));
box(s,624,730,0,2.5,-654,840,pavingMaterial(.8,6));
box(s,714,894,0,2.5,550,1534,pavingMaterial(1.2,4.3));
box(s,6,894,0,2.5,1434,1534,pavingMaterial(4,.7));
box(s,730,887,0,3,-654,550,M.grass);
box(s,887,901,0,150,-661,1541,M.wall); box(s,6,887,0,150,1527,1541,M.wall);
[[6,44],[740,777],[852,887]].forEach(([a,b])=>box(s,a,b,0,150,-661,-647,M.wall));
[[44,62],[600,636],[724,740]].forEach(([a,b])=>box(s,a,b,0,178,-666,-642,M.wall));
// Front boundary rebuilt from the street-facing reference photo.
// Restrict all geometry changes to this site/front-boundary segment.
// The actual driveway gate has FOUR black mesh leaves following one shallow,
// curved/arched crown. It is not four flat-topped opaque panels.
(function(){
  const front=-666;
  const metal=M.gate;
  const mesh=new THREE.MeshStandardMaterial({
    color:0x202b35,roughness:.72,metalness:.22,
    transparent:true,opacity:.77,depthWrite:false,side:THREE.DoubleSide
  });
  const detail=new THREE.MeshStandardMaterial({color:0x303c46,roughness:.78,metalness:.28});
  const yCrown=x=>154+54*Math.pow(Math.sin(Math.PI*(x-62)/538),1.12);
  const steelTube=(a,b,r=2.6,mat=metal)=>branch(s,a,b,r,mat);
  // The dark infill is a shallow, curved panel, with the carport visible through it.
  function meshPanel(l,r,top){
    const sh=new THREE.Shape();sh.moveTo(l+3,12);sh.lineTo(r-3,12);
    sh.lineTo(r-3,top(r-3)-3);
    for(let k=15;k>=0;k--){const x=l+3+(r-l-6)*k/15;sh.lineTo(x,top(x)-3);}
    sh.closePath();
    const m=new THREE.Mesh(new THREE.ShapeGeometry(sh),mesh);
    m.position.z=-657;m.renderOrder=1;s.add(m);
  }
  const edges=[62,196.5,331,465.5,600];
  for(let i=0;i<4;i++){
    const l=edges[i],r=edges[i+1];
    meshPanel(l,r,yCrown);
    // Thin framed edges around each hinged folding section.
    box(s,l,l+5,9,yCrown(l)-2,front-2,front+12,metal);
    box(s,r-5,r,9,yCrown(r)-2,front-2,front+12,metal);
    box(s,l,r,7,14,front-2,front+11,metal);
    // Two horizontal strengthening rails across the mesh, seen in the photo.
    box(s,l+3,r-3,68,72,front-3,front+8,metal);
    box(s,l+3,r-3,133,137,front-3,front+8,metal);
    // Slightly recessed rectangular lower and upper panel borders.
    box(s,l+9,r-9,18,20,front-3,front-1,detail,false);
    box(s,l+9,r-9,124,126,front-3,front-1,detail,false);
    const steps=10;
    for(let k=0;k<steps;k++){
      const x0=l+(r-l)*k/steps,x1=l+(r-l)*(k+1)/steps;
      steelTube([x0,yCrown(x0),front],[x1,yCrown(x1),front],3.2,metal);
    }
    // Raised border follows the curved top on each folding leaf.
    steelTube([l+7,145,front-1],[r-7,145,front-1],1.5,detail);
  }
  // Main gate centre line: distinct, thin meeting stile and floor guide.
  box(s,329,333,8,208,front-4,front+11,metal);
  box(s,322,340,8,11,front-5,front+8,detail);

  // Narrow PEDESTRIAN entrance beside the large driveway gate.
  // The street photo shows a black metal mesh door, not vertical wooden boards.
  // It sits between the two existing white pillars and remains rectangular.
  const l=637,r=723;
  const gateShape=new THREE.Shape();
  gateShape.moveTo(l+4,8);gateShape.lineTo(r-4,8);
  gateShape.lineTo(r-4,153);gateShape.lineTo(l+4,153);gateShape.closePath();
  const sideMesh=new THREE.Mesh(new THREE.ShapeGeometry(gateShape),mesh);
  sideMesh.position.z=-658;sideMesh.renderOrder=1;s.add(sideMesh);
  box(s,l,l+5,6,158,-670,-649,metal);
  box(s,r-5,r,6,158,-670,-649,metal);
  box(s,l,r,5,12,-670,-649,metal);
  box(s,l,r,151,158,-670,-649,metal);
  box(s,l+5,r-5,68,73,-671,-650,metal);
  box(s,l+5,r-5,117,122,-671,-650,metal);
  // Simple black latch at the driveway-facing edge.
  box(s,l+7,l+11,76,96,-677,-671,detail,false);
  box(s,l+11,l+17,85,90,-680,-674,M.steel,false);
})();

// The low fence LEFT of the pedestrian entrance (as seen from the road) is a
// continuous plastered WHITE WALL, same existing 150 cm fence height. The
// former brown timber pickets here belonged to neither the street photo nor
// the house's front boundary, so remove them entirely.
box(s,740,887,0,150,-666,-646,M.wall);
box(s,738,889,148,154,-669,-642,M.concrete);
// Concrete-grey caps on the original, unchanged-height gate piers.
for(const [a,b] of [[44,62],[600,636],[724,740]]){
  box(s,a-4,b+4,176,183,-673,-637,M.concrete);
  box(s,a,b,183,185,-667,-643,M.cap);
  const x=(a+b)/2;
  // Small square slatted metal light fixtures visible on each white pillar.
  box(s,x-12,x+12,185,188,-662,-648,M.steel,false);
  box(s,x-11,x+11,207,210,-663,-647,M.steel,false);
  for(const xx of [x-10,x-5,x,x+5,x+10])
    box(s,xx-0.9,xx+0.9,188,207,-663,-649,M.steel,false);
}
// Shorter solid boundary-wall cap by the garden; never add neighbour railings.
box(s,740,777,150,155,-673,-640,M.concrete);
box(s,852,887,150,155,-673,-640,M.concrete);
tree(s,814,-400,1); tree(s,817,250,.87);
for(const [x,z,size] of [[795,-155,.7],[851,-50,.55],[827,110,.6],[812,390,.68],[766,-535,.48]])shrub(s,x,z,size);
/* ---------- photo-specific exterior details ---------- */
// Only rendered in Outside mode: floor openings and all sensor hotspots remain untouched.
(function(){
  const f=G.facade;
  // Main timber double doors: dark mahogany, curved routed detailing and chrome handles.
  [[94,177],[181,266]].forEach(([l,r],i)=>{
    box(f,l,r,1,210,-5,-2,M.door);
    box(f,l+8,r-8,9,201,-7,-5,M.door);
    box(f,l+17,r-17,31,33,-8,-6,M.woodGroove,false);
    box(f,l+17,r-17,124,126,-8,-6,M.woodGroove,false);
    // Sweeping routed groove traced into each door panel.
    const pts=[];
    for(let j=0;j<=20;j++){
      const yy=26+j*8;const bend=16*Math.sin((yy-26)/160*Math.PI);
      pts.push(new THREE.Vector3((i?l+27:r-27)+(i?-bend:bend),yy,-8));
    }
    const line=new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts),new THREE.LineBasicMaterial({color:0x352520}));f.add(line);
  });
  box(f,168,172,99,116,-11,-8,M.inox,false);
  box(f,179,183,99,116,-11,-8,M.inox,false);
  box(f,82,278,209,218,-8,9,M.concrete);
  // Exterior window trims make the glazing look like actual aluminium-frame windows.
  function windowTrim(ax,c,l,r,base,sill,head,panes=3){
    const p=(a,b,y0,y1,d,mat)=>ax==='x'
      ?box(f,a,b,y0,y1,c-d/2,c+d/2,mat,false)
      :box(f,c-d/2,c+d/2,y0,y1,a,b,mat,false);
    const v0=base+sill,v1=base+head,outer=5;
    p(l,r,v0,v0+outer,7,M.frame);p(l,r,v1-outer,v1,7,M.frame);
    p(l,l+outer,v0,v1,7,M.frame);p(r-outer,r,v0,v1,7,M.frame);
    p(l+outer,r-outer,v0+outer,v1-outer,1.5,M.glassDark);
    for(let k=1;k<panes;k++){
      const a=l+(r-l)*k/panes;p(a-2.5,a+2.5,v0,v1,7,M.frame);
    }
    // Slightly raised lower sliding-track line.
    p(l+outer,r-outer,v0+7,v0+9,8,M.frame);
  }
  windowTrim('x',-7,370,550,0,90,210);
  windowTrim('x',-7,369,549,UB,90,210);
  // Upper-floor side windows have two panels; only the front window has three.
  windowTrim('z',635,286,406,UB,90,210,2);
  windowTrim('z',635,884,1004,UB,90,210,2);
  // The small projecting dark-grey tile awning above the upstairs front window.
  (function(){
    const x0=345,x1=573,y0=UB+225;
    box(f,x0,x1,y0-2,y0+3,-58,-4,M.roofEdge);
    box(f,x0+4,x1-4,y0+3,y0+9,-53,0,porchRoofMaterial);
    box(f,x0+2,x1-2,y0-12,y0-2,-58,-52,M.roofEdge);
    box(f,x0+5,x0+11,y0-12,y0+3,-57,-6,M.concrete);
    box(f,x1-11,x1-5,y0-12,y0+3,-57,-6,M.concrete);
  })();
  // Stainless/glass upper corridor, with square railing posts and glass clamps.
  for(const z of [570,680,790,900,1010,1120,1230,1340,1428]){
    box(f,717,721,UB+42,UB+51,z-3,z+3,M.inox,false);
    box(f,717,721,UB+74,UB+83,z-3,z+3,M.inox,false);
  }
  // Kitchen-side extended roof removed as requested; keep the service area open.
  // Wall-mounted air-conditioning outdoor compressor (only one; not neighbour's).
  box(f,630,680,UB+15,UB+76,105,172,M.concrete);
  box(f,680,691,UB+18,UB+73,119,158,M.inox);
  const fan=new THREE.Mesh(new THREE.TorusGeometry(21,3,8,24),M.metalDetail);
  fan.rotation.y=Math.PI/2;fan.position.set(693,UB+46,138);f.add(fan);
})();

// the attached semi-D neighbour, shown faded for context
box(G.nb,-618,-2,0,UB+H+12,6,1434,M.ghost,false);

/* ---------- rooms ---------- */
const ROOMS=[
  {id:'lobby',name:'Lobby',lv:'g',p:rect(6,336,6,474)},
  {id:'living',name:'Living area',lv:'g',p:[[336,6],[624,6],[624,694],[336,694]]},
  {id:'stairs',name:'Stairs',lv:'g',p:rect(6,336,474,694)},
  {id:'work',name:'Work room',lv:'g',p:[[6,694],[336,694],[336,1254],[126,1254],[126,1434],[6,1434]]},
  {id:'dining',name:'Dining area',lv:'g',p:[[336,694],[624,694],[624,840],[714,840],[714,1254],[336,1254]]},
  {id:'kitchen',name:'Kitchen',lv:'g',p:rect(396,714,1254,1434)},
  {id:'wc-g',name:'Toilet (ground)',lv:'g',p:rect(126,396,1254,1434)},
  {id:'master',name:'Master room',lv:'u',p:[[176,6],[624,6],[624,474],[6,474],[6,276],[176,276]]},
  {id:'wc-m',name:'Master toilet',lv:'u',p:rect(6,176,6,276)},
  {id:'uliving',name:'Upper living',lv:'u',p:[[202,474],[624,474],[624,794],[206,794],[206,690],[202,690]]},
  {id:'wc-u',name:'Toilet (upper)',lv:'u',p:rect(6,206,694,914)},
  {id:'bed2',name:'Bedroom 2',lv:'u',p:[[206,794],[314,794],[314,1434],[6,1434],[6,914],[206,914]]},
  {id:'bed1',name:'Bedroom 1',lv:'u',p:rect(314,624,794,1124)},
  {id:'corridor',name:'Corridor',lv:'u',p:[[624,540],[714,540],[714,1434],[314,1434],[314,1124],[624,1124]]},
  {id:'porch',name:'Porch',lv:'out',p:rect(6,624,-654,6)},
  {id:'garden',name:'Garden',lv:'out',p:rect(730,887,-654,550)},
  {id:'yard',name:'Side & back yard',lv:'out',p:[[624,-654],[730,-654],[730,550],[887,550],[887,1527],[6,1527],[6,1434],[714,1434],[714,840],[624,840]]},
];
const LVNAME={out:'Outside',g:'Ground floor',u:'Upper floor'};
const BASE={g:4,u:UB+3,out:6};
const ROOM_BY_ID={};
ROOMS.forEach(r=>{
  let a=0,cx=0,cz=0,minx=1e9,maxx=-1e9,minz=1e9,maxz=-1e9;
  r.p.forEach((q,k)=>{const n=r.p[(k+1)%r.p.length];const c=q[0]*n[1]-n[0]*q[1];a+=c;cx+=(q[0]+n[0])*c;cz+=(q[1]+n[1])*c;
    minx=Math.min(minx,q[0]);maxx=Math.max(maxx,q[0]);minz=Math.min(minz,q[1]);maxz=Math.max(maxz,q[1]);});
  a/=2; r.area=Math.abs(a)/10000; r.c=[cx/(6*a),cz/(6*a)]; r.span=Math.max(maxx-minx,maxz-minz);
  const mat=new THREE.MeshBasicMaterial({color:0x0a84ff,transparent:true,opacity:0,depthWrite:false,side:THREE.DoubleSide,polygonOffset:true,polygonOffsetFactor:-2});
  const m=new THREE.Mesh(new THREE.ShapeGeometry(shape(r.p)),mat);
  m.rotation.x=Math.PI/2; m.position.y=BASE[r.lv]; m.userData.room=r; m.renderOrder=5;
  r.mesh=m; G.ov.add(m); ROOM_BY_ID[r.id]=r;
});

/* ---------- doors and windows ----------
   Every external door and every window panel, on the model's own wall lines (cm, like the walls above).
   A contact or vibration sensor is put on one by its id in layout.json: "opening": "door-front".
   ax 'x': the wall runs along x at z=c; 'z': along z at x=c. d: depth of the marker through the wall. */
const PANES={w3:3,wk:3,w2:2,lv:1};
const OPENINGS=[],OPEN_BY_ID={};
function door(id,name,room,lv,ax,c,s,e,d=19){OPENINGS.push({id,name,room,lv,kind:'door',ax,c,s,e,y0:0,y1:210,d});}
function panes(id,name,room,lv,ax,c,s,e,type,d=19){
  const n=PANES[type],[sill,head]=OP[type];
  for(let i=0;i<n;i++)OPENINGS.push({id:n>1?`${id}-${i+1}`:id,name:n>1?`${name}, panel ${i+1}`:name,room,lv,kind:'window',
    ax,c,s:s+(e-s)*i/n,e:s+(e-s)*(i+1)/n,y0:sill,y1:head,d});
}
door('door-front','Front door','lobby','g','x',6,90,270,32);
door('door-living','Living sliding door','living','g','z',624,570,750);
door('door-kitchen','Kitchen side door','kitchen','g','z',719,1236,1326,24);
panes('win-living','Living front window','living','g','x',6,370,550,'w3');
panes('win-dining','Dining window','dining','g','z',714,951,1131,'wk');
panes('win-work','Work room window','work','g','x',1434,16,116,'w2');
panes('win-wc-g','Ground toilet window','wc-g','g','x',1434,231,291,'lv');
panes('win-kitchen','Kitchen window','kitchen','g','x',1434,414,594,'w3');
door('door-upper-living','Upper living sliding door','uliving','u','z',624,546,726);
door('door-bed1','Bedroom 1 corridor door','bed1','u','x',1124,374,464,14);
door('door-bed2','Bedroom 2 corridor door','bed2','u','z',314,1180,1270,14);
panes('win-wc-m','Master toilet window','wc-m','u','x',6,61,121,'lv');
panes('win-master-front','Master front window','master','u','x',6,369,549,'w3');
panes('win-master-side','Master side window','master','u','z',624,286,406,'w2');
panes('win-bed1','Bedroom 1 window','bed1','u','z',624,884,1004,'w2');
panes('win-bed2','Bedroom 2 window','bed2','u','x',1434,156,276,'w2');
// each gets a tint over its whole opening (shown while open) and a small sensor puck on its head
OPENINGS.forEach(o=>{
  const base=o.lv==='u'?UB:0, grp=o.lv==='u'?G.u:G.g;
  const place=(m,s,e,y0,y1,d)=>{
    m.scale.set(o.ax==='x'?e-s:d,y1-y0,o.ax==='x'?d:e-s);
    m.position.set(o.ax==='x'?(s+e)/2:o.c,base+(y0+y1)/2,o.ax==='x'?o.c:(s+e)/2);
    grp.add(m); return m;
  };
  const unit=new THREE.BoxGeometry(1,1,1);
  o.tint=place(new THREE.Mesh(unit,new THREE.MeshBasicMaterial({color:0xf39a38,transparent:true,opacity:0,depthWrite:false})),o.s+3,o.e-3,o.y0+3,o.y1-3,o.d);
  o.tint.renderOrder=4;
  const mid=(o.s+o.e)/2,w=Math.min(16,(o.e-o.s)*.5);
  o.puck=place(new THREE.Mesh(unit,new THREE.MeshStandardMaterial({color:0xc5cbd3,roughness:.5})),mid-w/2,mid+w/2,o.y1-9,o.y1-2,o.d+6);
  o.tagAt=new THREE.Vector3((o.ax==='x'?mid:o.c)/100,(base+o.y1+25)/100,(o.ax==='x'?o.c:mid)/100);
  OPEN_BY_ID[o.id]=o;
});

/* ---------- live sensor data ----------
   The server (src/broker.ts) streams devices and entities from MQTT discovery over server-sent events.
   Each device carries the room id it was given in layout.json; nothing is stored on the page. */
const live={connected:false,everConnected:false,brokerUp:false,devices:new Map(),entities:new Map()};
const OCC=['occupancy','presence','motion'];
const entitiesOf=id=>[...live.entities.values()].filter(e=>e.device===id);
const occupancyOf=id=>entitiesOf(id).find(e=>e.component==='binary_sensor'&&OCC.includes(e.deviceClass||''));
const distanceOf=id=>entitiesOf(id).find(e=>e.component==='sensor'&&e.unit==='cm');
const devicesIn=r=>[...live.devices.values()].filter(d=>d.room===r.id).sort((a,b)=>a.label.localeCompare(b.label));
const unplaced=()=>[...live.devices.values()].filter(d=>!ROOM_BY_ID[d.room]&&!OPEN_BY_ID[d.opening]);
const devicesAt=o=>[...live.devices.values()].filter(d=>d.opening===o.id);
const CONTACT=['door','window','opening','garage_door','vibration','moving'];
const contactOf=id=>entitiesOf(id).find(e=>e.component==='binary_sensor'&&CONTACT.includes(e.deviceClass||''));
/** st: 'open' · 'shaking' (a vibration sensor) · 'closed' · 'offline' · 'unknown' · 'none' (no sensor here yet) */
function openingState(o){
  const ds=devicesAt(o).filter(d=>contactOf(d.id));
  if(!ds.length)return {st:'none'};
  const up=ds.filter(d=>d.available!==false);
  if(!up.length)return {st:'offline'};
  const es=up.map(d=>contactOf(d.id)), hot=es.find(e=>e.value===true);
  if(hot)return {st:hot.deviceClass==='vibration'?'shaking':'open',at:hot.at};
  if(es.some(e=>e.value===false))return {st:'closed',at:Math.max(0,...es.map(e=>e.at||0))||null};
  return {st:'unknown'};
}
const OWORD={open:'Open',shaking:'Shaking',closed:'Closed',offline:'Offline',unknown:'No reading yet',none:'No sensor'};
const isAlert=st=>st==='open'||st==='shaking';
const sensorRooms=()=>ROOMS.filter(r=>devicesIn(r).length);

/** st: 'on' someone there · 'clear' · 'offline' (every presence sensor offline: its last reading isn't counted)
    · 'unknown' (online, no reading yet) · 'none' (no presence sensor in the room) */
function roomState(r){
  const ds=devicesIn(r).filter(d=>occupancyOf(d.id));
  if(!ds.length)return {st:'none'};
  const up=ds.filter(d=>d.available!==false);
  if(!up.length)return {st:'offline',at:Math.max(0,...ds.map(d=>d.availableAt||0))||null};
  const on=up.filter(d=>occupancyOf(d.id).value===true);
  if(on.length)return {st:'on',dist:on.map(d=>distanceOf(d.id)?.value).find(v=>typeof v==='number')};
  if(up.some(d=>occupancyOf(d.id).value===false))return {st:'clear',at:Math.max(0,...up.map(d=>occupancyOf(d.id).at||0))||null};
  return {st:'unknown'};
}
const metres=cm=>(cm/100).toFixed(1)+' m';
const WORD={on:'Occupied',clear:'Clear',offline:'Offline',unknown:'No reading yet',none:'No sensor'};

function ago(t){
  if(!t)return null;
  const s=(Date.now()-t)/1000;
  if(s<45)return 'just now';
  if(s<3600)return `${Math.round(s/60)} min ago`;
  if(s<86400)return `${Math.round(s/3600)} h ago`;
  return new Date(t).toLocaleDateString(undefined,{day:'numeric',month:'short'});
}
const clockTime=t=>new Date(t).toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'});
function formatValue(e){
  if(e.value===null||e.value===undefined)return '—';
  if(typeof e.value==='boolean'){
    const pair={occupancy:['Occupied','Clear'],presence:['Present','Clear'],motion:['Motion','Still'],door:['Open','Closed'],window:['Open','Closed'],vibration:['Shaking','Still']}[e.deviceClass]||['On','Off'];
    return e.value?pair[0]:pair[1];
  }
  if(typeof e.value==='number')return `${Number.isInteger(e.value)?e.value:e.value.toFixed(1)}${e.unit?(e.unit==='%'?'%':' '+e.unit):''}`;
  return String(e.value);
}
function esc(t){return String(t).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}

/* ---------- icons: the cat-home PNG packs in assets/icons ---------- */
const IMG=n=>`<img src="assets/icons/${n}.png" alt="" width="24" height="24">`;
const ICON={close:IMG('close')};
const ROOM_ICON={lobby:'entrance',living:'living-room',stairs:'stairs',work:'work',dining:'dining',kitchen:'kitchen','wc-g':'toilet',master:'bed','wc-m':'toilet',
  uliving:'living-room','wc-u':'toilet',bed2:'bed',bed1:'bed',corridor:'balcony',porch:'carport',garden:'garden',yard:'garden'};
const roomIcon=r=>IMG(ROOM_ICON[r.id]||'rooms');
const openingIconName=(o,st)=>o.kind==='door'?(st==='open'||st==='shaking'?'door-open':'rooms'):(st==='open'||st==='shaking'?'window-open':'window');
const openingIcon=(o,st)=>IMG(openingIconName(o,st));
const CAT=m=>`assets/cat/${m}_256.png`;

/* ---------- view state ---------- */
let view='out',sel=null,hover=null,page='overview';
const ZOOM_OUT=2;
controls.maxDistance=Math.max(controls.maxDistance,22.4*ZOOM_OUT*1.2); // scroll can reach it too
const PRESET={
  // the whole-house view starts ZOOM_OUT times farther from the house than the sample did
  out:{pos:[4.2+(15.5-4.2)*ZOOM_OUT,1.6+(11.5-1.6)*ZOOM_OUT,3.6+(-13-3.6)*ZOOM_OUT],tgt:[4.2,1.6,3.6]},
  g:{pos:[10.5,17,16.5],tgt:[3.7,0,7]},
  u:{pos:[10.5,19.5,16.5],tgt:[3.7,2.65,7]},
};
let tween=null;
function flyTo(pos,tgt,ms=850){
  const reduce=matchMedia('(prefers-reduced-motion: reduce)').matches;
  if(reduce){camera.position.set(...pos);controls.target.set(...tgt);return;}
  tween={t0:performance.now(),ms,p0:camera.position.clone(),q0:controls.target.clone(),p1:new THREE.Vector3(...pos),q1:new THREE.Vector3(...tgt)};
}
function applyVisibility(){
  G.roof.visible=view==='out'; G.nb.visible=view==='out'; G.facade.visible=view==='out';
  G.u.visible=view!=='g'; G.proof.visible=view==='out';
  ROOMS.forEach(r=>{r.mesh.visible=r.lv===view;});
}
function markView(){document.querySelectorAll('.seg button').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.view===view)));}
function setView(v,fly=true){
  view=v; if(sel&&sel.lv!==v)sel=null;
  markView(); applyVisibility();
  if(fly){const p=PRESET[v];flyTo(p.pos,p.tgt);}
  render();
}
function select(r){
  sel=r;
  if(r){
    if(r.lv!==view){view=r.lv;markView();applyVisibility();}
    const y=(r.lv==='u'?UB:0)/100, c=[r.c[0]/100,y,r.c[1]/100], d=r.span/100*1.25+4.5;
    flyTo([c[0]+d*.3,y+d*1.25,c[2]+d*.45],c);
  } else {const p=PRESET[view];flyTo(p.pos,p.tgt);}
  render();
}
// occupied rooms glow cat-orange on their floor; selection and hover use the accent
const C_ACC=new THREE.Color(0x0a84ff),C_WARM=new THREE.Color(0xf39a38);
function paint(){
  ROOMS.forEach(r=>{
    const on=roomState(r).st==='on';
    r.mesh.material.color.copy(on?C_WARM:C_ACC);
    r.mesh.material.opacity=r===sel?(on?.5:.3):r===hover?(on?.42:.14):on?.32:0;
  });
  OPENINGS.forEach(o=>{
    const st=openingState(o).st;
    o.tint.material.opacity=isAlert(st)?.55:0;
    o.puck.material.color.setHex(isAlert(st)?0xf39a38:st==='closed'?0x0f9d6a:st==='none'?0xc5cbd3:0x93a1b8);
  });
}

/* ---------- the HUD panel ---------- */
const panel=document.getElementById('panel');
function readLine(r){
  const s=roomState(r),where=LVNAME[r.lv];
  if(s.st==='on')return `${where} · <b>Occupied</b>${typeof s.dist==='number'?` · ${metres(s.dist)}`:''}`;
  if(s.st==='clear')return `${where} · <b>Clear</b>${s.at?` · ${ago(s.at)}`:''}`;
  if(s.st==='offline')return `${where} · Offline${s.at?` · ${ago(s.at)}`:''}`;
  return `${where} · ${WORD[s.st]}`;
}
function statusHtml(ds){
  if(!ds.length)return '<span></span>';
  const up=ds.filter(d=>d.available!==false).length;
  return up===ds.length?`<span class="status up">Online</span>`:up?`<span class="status down">${up}/${ds.length} online</span>`:`<span class="status down">Offline</span>`;
}
function headHtml(title,sub){
  const now=new Date();
  return `<header class="head"><div><h1>${title}</h1><p>${sub}</p></div>
    <div class="clock"><b>${now.toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'})}</b>${now.toLocaleDateString(undefined,{weekday:'short',day:'numeric',month:'short'})}</div></header>`;
}
/** the pixel cat shows how the house is: asleep when nobody's home, curious at an open door or window */
function catMood(rooms,on,off,hot){
  if(!live.everConnected)return 'neutral';
  if(hot.some(([,s])=>s.st==='shaking'))return 'surprised';
  if(hot.length)return 'curious';
  if(rooms.length&&off.length===rooms.length)return 'crying';
  if(on.length)return 'happy';
  return rooms.length?'sleeping':'neutral';
}
function overviewHtml(){
  const rooms=sensorRooms(), states=rooms.map(roomState);
  const on=rooms.filter((r,i)=>states[i].st==='on'), off=rooms.filter((r,i)=>states[i].st==='offline');
  const ops=OPENINGS.map(o=>[o,openingState(o)]), hot=ops.filter(([,s])=>isAlert(s.st));
  let big,note,cls='';
  if(!live.everConnected){big='Connecting';note='Waiting for the box';cls='off';}
  else if(!rooms.length){big='No sensors yet';note=live.devices.size?'Place a board in a room in layout.json':'Boards appear as soon as they announce themselves';cls='off';}
  else if(on.length){big='Someone’s home';note=on.map(r=>{const d=roomState(r).dist;return `${r.name}${typeof d==='number'?`, ${metres(d)} from the sensor`:''}`;}).join(' · ');cls='on';}
  else if(off.length===rooms.length){big='Can’t tell';note='Every presence sensor is offline';cls='off';}
  else{big='Nobody home';note=off.length?`${off.map(r=>r.name).join(', ')} offline, not counted`:'Every room with a sensor is clear';}
  const devs=[...live.devices.values()];
  const times=[...rooms.flatMap(r=>devicesIn(r).map(d=>occupancyOf(d.id)?.at)),...devs.map(d=>d.availableAt)].filter(Boolean);
  const rows=rooms.map(r=>{const s=roomState(r);return `<li><button class="row ${s.st==='on'?'on':''}" data-id="${r.id}" aria-pressed="${r===sel}">
      <span class="ico ${s.st==='on'?'on':s.st==='offline'?'off':''}">${roomIcon(r)}</span>
      <span><span class="name">${esc(r.name)}</span><span class="read">${readLine(r)}</span></span>
      ${statusHtml(devicesIn(r))}</button></li>`;}).join('');
  const lost=unplaced();
  return `${headHtml('My home','Malaysia · live from your sensors')}
    <article class="panel-card">
      <div class="mood ${cls}"><img src="${CAT(catMood(rooms,on,off,hot))}" alt="" width="96" height="96">
        <div><span class="label">Right now</span><strong class="big">${big}</strong><p class="note">${esc(note)}</p></div></div>
      <div class="stats">
        <div class="stat"><span class="label">Occupied</span><strong>${rooms.length?`${on.length}/${rooms.length}`:'—'}</strong></div>
        <div class="stat"><span class="label">Online</span><strong>${devs.length?`${devs.filter(d=>d.available!==false).length}/${devs.length}`:'—'}</strong></div>
        <div class="stat"><span class="label">Changed</span><strong>${times.length?ago(Math.max(...times)).replace(' ago',''):'—'}</strong></div>
      </div>
    </article>
    ${openingsHtml(ops,hot)}
    <h2 class="section">Rooms with sensors</h2>
    ${rooms.length?`<ul class="rows">${rows}</ul>`:`<p class="empty">${live.everConnected?'No room has a sensor yet.':'Connecting…'}</p>`}
    ${lost.length?`<p class="empty">Not placed: ${lost.map(d=>`<b>${esc(d.label)}</b>${d.room||d.opening?` (no “${esc(d.room||d.opening)}”)`:''}`).join(', ')}. Give ${lost.length===1?'it':'each'} a <code>room</code> or <code>opening</code> in <code>layout.json</code> and restart the server.</p>`:''}`;
}
function openingsHtml(states,hot){
  const fitted=states.filter(([,s])=>s.st!=='none'), off=fitted.filter(([,s])=>s.st==='offline');
  const doors=OPENINGS.filter(o=>o.kind==='door').length, wins=OPENINGS.length-doors;
  let big,note,cls='';
  if(!fitted.length){big='No sensors yet';note=`${doors} doors and ${wins} window panels are marked for one`;cls='off';}
  else if(hot.length){big=hot.length===1?`${hot[0][0].name} ${OWORD[hot[0][1].st].toLowerCase()}`:`${hot.length} open`;note=hot.length>1?'':(hot[0][1].at?`Since ${ago(hot[0][1].at)}`:'');cls='on';}
  else if(off.length===fitted.length){big='Can’t tell';note='Every door and window sensor is offline';cls='off';}
  else{big='All closed';note=off.length?`${off.length} offline, not counted`:'';}
  const rows=hot.map(([o,s])=>`<li><button class="mini" data-room="${o.room}"><span>${esc(o.name)}</span><b class="on">${OWORD[s.st]}</b></button></li>`).join('');
  return `<article class="panel-card">
    <div class="card-head ${cls}"><span class="ico ${cls}">${IMG('security')}</span>
      <div><span class="label">Doors and windows</span><strong class="big">${esc(big)}</strong>${note?`<p class="note">${esc(note)}</p>`:''}</div></div>
    ${rows&&hot.length>1?`<ul class="minis">${rows}</ul>`:''}
    <div class="stats">
      <div class="stat"><span class="label">Open</span><strong>${fitted.length?hot.length:'—'}</strong></div>
      <div class="stat"><span class="label">Fitted</span><strong>${fitted.length}/${OPENINGS.length}</strong></div>
      <div class="stat"><span class="label">Offline</span><strong>${fitted.length?off.length:'—'}</strong></div>
    </div></article>`;
}
function devicesHtml(){
  const devs=[...live.devices.values()].sort((a,b)=>a.label.localeCompare(b.label));
  return `${headHtml('Devices','Found through MQTT discovery')}
    ${devs.length?devs.map(d=>{const room=ROOM_BY_ID[d.room],op=OPEN_BY_ID[d.opening];return `<article class="panel-card">
      <div class="card-head"><span class="ico ${d.available===false?'off':''}">${(op?openingIcon(op,openingState(op).st):IMG(occupancyOf(d.id)?'motion':'devices'))}</span>
        <div style="flex:1;min-width:0"><strong class="name" style="font:600 16px var(--f-head)">${esc(d.label)}</strong><span class="label">${esc(d.id)}</span></div>
        <span class="status ${d.available===false?'down':d.available?'up':''}">${d.available===false?'Offline':d.available?'Online':'Unknown'}</span></div>
      <dl class="facts">
        <dt>${op?'On':'Room'}</dt><dd>${op?esc(op.name):room?`${esc(room.name)}, ${LVNAME[room.lv].toLowerCase()}`:'Not placed (layout.json)'}</dd>
        ${entitiesOf(d.id).map(e=>`<dt>${esc(e.name)}</dt><dd>${esc(formatValue(e))}${e.at?`, ${ago(e.at)}`:''}</dd>`).join('')}
        <dt>IP</dt><dd>${esc(d.ip||'—')}</dd>
        <dt>Board</dt><dd>${esc([d.model,d.firmware&&'ESPHome '+d.firmware].filter(Boolean).join(' · ')||'—')}</dd>
        <dt>${d.available===false?'Offline':'Online'} since</dt><dd>${d.availableAt?`${clockTime(d.availableAt)}, ${ago(d.availableAt)}`:'—'}</dd>
      </dl></article>`;}).join(''):`<p class="empty">${live.everConnected?'No devices yet.':'Connecting…'}</p>`}`;
}
/* ---------- alarm page ---------- */
// status comes live over SSE; the schedule and the log are fetched (on opening the page, after each change, and as the log grows)
const alarm={status:null,periods:[],away:[],sessions:[],events:new Map(),open:null,loaded:false,error:null,busy:false};
async function api(path,opts={}){
  const r=await fetch('api/alarm'+path,{...opts,headers:opts.body?{'content-type':'application/json'}:{}});
  if(r.status===204)return null;
  const j=await r.json().catch(()=>null);
  if(!r.ok)throw new Error(j?.error||j?.message||`HTTP ${r.status}`);
  return j;
}
async function loadAlarm(){
  try{
    const [a,sessions]=await Promise.all([api(''),api('/sessions?limit=10')]);
    const {periods,away,...status}=a;
    Object.assign(alarm,{status,periods,away,sessions,loaded:true,error:null});
    if(alarm.open===null&&sessions.length)alarm.open=sessions[0].id;
    if(alarm.open!==null)alarm.events.set(alarm.open,await api(`/sessions/${alarm.open}/events`));
  }catch(err){alarm.error=err.message;}
  render();
}
let logTimer=null;
const refreshLogSoon=()=>{if(page!=='alarm'||!alarm.status?.armed||logTimer)return;logTimer=setTimeout(()=>{logTimer=null;loadAlarm();},2000);};
async function alarmDo(fn){
  if(alarm.busy)return; alarm.busy=true; alarm.error=null; alarmDirty=false; render(); // acting on the page drops any half-filled form
  try{await fn();}catch(err){alarm.error=err.message;}
  alarm.busy=false; await loadAlarm();
}
const shortDate=d=>new Date(d+'T00:00').toLocaleDateString(undefined,{weekday:'short',day:'numeric',month:'short'});
const when=t=>{const d=new Date(t),today=new Date().toDateString()===d.toDateString();
  return today?clockTime(t):`${d.toLocaleDateString(undefined,{day:'numeric',month:'short'})}, ${clockTime(t)}`;};
const todayStr=()=>{const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;};
function alarmNote(s){
  const away=alarm.away.find(a=>a.from<=todayStr()&&todayStr()<=a.to);
  if(s.reason==='away')return `You're away until ${shortDate(away?.to||todayStr())}`;
  if(s.reason==='schedule'){const m=new Date().getHours()*60+new Date().getMinutes(),mins=t=>+t.slice(0,2)*60+ +t.slice(3);
    const p=alarm.periods.find(p=>{const a=mins(p.start),b=mins(p.end);return a<b?a<=m&&m<b:m>=a||m<b;});
    return p?`Armed period ${p.start}–${p.end}`:'Armed by the schedule';}
  if(s.reason==='manual')return 'Armed by hand, until the schedule next changes';
  if(s.override)return 'Disarmed by hand, until the schedule next changes';
  return alarm.periods.length?`Next armed at ${nextStart()}`:'No armed periods set';
}
function nextStart(){
  const m=new Date().getHours()*60+new Date().getMinutes(),mins=t=>+t.slice(0,2)*60+ +t.slice(3);
  const sorted=alarm.periods.map(p=>p.start).sort();
  return sorted.find(t=>mins(t)>m)||sorted[0];
}
function eventLine(e){
  const dev=live.devices.get(e.device), where=ROOM_BY_ID[e.room]?.name||OPEN_BY_ID[e.opening]?.name||dev?.label||e.device;
  if(e.kind==='availability')return {where,what:e.value?'Back online':'Went offline',hot:!e.value};
  const ent=live.entities.get(e.entity)||{deviceClass:null,unit:e.unit};
  const what=typeof e.value==='boolean'?formatValue({...ent,value:e.value}):`${e.name} ${formatValue({...ent,unit:e.unit,value:e.value})}`;
  return {where,what,hot:e.value===true};
}
function alarmHtml(){
  const s=alarm.status;
  if(!s)return `${headHtml('Alarm','Arms itself from your schedule')}<p class="empty">${alarm.error?esc(alarm.error):'Loading…'}</p>`;
  const sess=s.session, evs=sess?alarm.events.get(sess.id):null;
  const dis=alarm.busy?' disabled':'';
  const periods=alarm.periods.map((p,i)=>`<li class="mini"><span class="mono">${p.start} – ${p.end}${p.end<p.start?' <small class="label" style="display:inline">next day</small>':''}</span>
      <button class="btn ghost" data-act="del-period" data-i="${i}" aria-label="Remove ${p.start} to ${p.end}"${dis}>Remove</button></li>`).join('');
  const today=todayStr();
  const aways=alarm.away.map(a=>`<li class="mini"><span>${shortDate(a.from)}${a.to!==a.from?` – ${shortDate(a.to)}`:''}${a.note?` · ${esc(a.note)}`:''}${a.from<=today&&today<=a.to?' <b class="on">now</b>':a.to<today?' <b>past</b>':''}</span>
      <button class="btn ghost" data-act="del-away" data-id="${a.id}" aria-label="Remove away ${a.from} to ${a.to}"${dis}>Remove</button></li>`).join('');
  const log=alarm.sessions.map(x=>{
    const open=alarm.open===x.id, list=open?alarm.events.get(x.id):null;
    const why={schedule:'Schedule',away:'Away',manual:'By hand'}[x.reason];
    return `<li class="sess${open?' open':''}"><button class="mini sess-head" data-act="sess" data-id="${x.id}" aria-expanded="${open}">
        <span>${when(x.armedAt)} → ${x.disarmedAt?when(x.disarmedAt):'<b class="on">now</b>'}</span><b>${why}</b></button>
      ${open?(list?(list.length?`<ul class="minis log">${list.slice().reverse().map(e=>{const l=eventLine(e);
        return `<li class="mini"><span><b class="mono">${clockTime(e.at)}</b> ${esc(l.where)}</span><b class="${l.hot?'on':''}">${esc(l.what)}</b></li>`;}).join('')}</ul>`
        :'<p class="note">Nothing happened.</p>'):'<p class="note">Loading…</p>'):''}</li>`;}).join('');
  return `${headHtml('Alarm','Arms itself from your schedule')}
    <article class="panel-card">
      <div class="card-head ${s.armed?'on':'off'}"><span class="ico ${s.armed?'on':''}">${IMG(s.armed?'alarm':'security')}</span>
        <div><span class="label">Right now</span><strong class="big">${s.armed?'Armed':'Disarmed'}</strong><p class="note">${esc(alarmNote(s))}</p></div></div>
      <div class="stats">
        <div class="stat"><span class="label">Armed</span><strong>${sess?ago(sess.armedAt).replace(' ago',''):'—'}</strong></div>
        <div class="stat"><span class="label">Logged</span><strong>${evs?evs.length:'—'}</strong></div>
        <div class="stat"><span class="label">Periods</span><strong>${alarm.periods.length}</strong></div>
      </div>
      <div class="actions">
        <button class="btn ${s.armed?'':'primary'}" data-act="${s.armed?'disarm':'arm'}"${dis}>${s.armed?'Disarm now':'Arm now'}</button>
        ${s.override?`<button class="btn ghost" data-act="follow"${dis}>Follow the schedule</button>`:''}
      </div>
      ${alarm.error?`<p class="note err-note" role="alert">${esc(alarm.error)}</p>`:''}
    </article>

    <h2 class="section">Armed every day</h2>
    <article class="panel-card">
      ${periods?`<ul class="minis">${periods}</ul>`:'<p class="note">No periods yet. The alarm only arms on away days or by hand.</p>'}
      <form class="add" data-form="period">
        <label><span class="label">From</span><input type="time" name="start" required></label>
        <label><span class="label">To</span><input type="time" name="end" required></label>
        <button class="btn primary"${dis}>Add</button>
      </form>
      <p class="note">An end earlier than the start runs past midnight. Times are the box's clock.</p>
    </article>

    <h2 class="section">Away from home</h2>
    <article class="panel-card">
      ${aways?`<ul class="minis">${aways}</ul>`:'<p class="note">No away days. On these days the alarm stays armed all day.</p>'}
      <form class="add" data-form="away">
        <label><span class="label">From</span><input type="date" name="from" min="${today}" required></label>
        <label><span class="label">To</span><input type="date" name="to" min="${today}" required></label>
        <label class="wide"><span class="label">Note</span><input type="text" name="note" maxlength="200" placeholder="Optional, e.g. trip"></label>
        <button class="btn primary"${dis}>Add</button>
      </form>
    </article>

    <h2 class="section">Log</h2>
    ${log?`<ul class="minis sessions">${log}</ul>`:'<p class="empty">Nothing yet. Each time the alarm arms, what the sensors do is logged here.</p>'}`;
}
let alarmDirty=false; // a half-filled form: don't redraw over it
function bindAlarm(){
  panel.querySelectorAll('[data-act]').forEach(b=>b.onclick=()=>{
    const a=b.dataset.act;
    if(a==='arm'||a==='disarm')alarmDo(()=>api('',{method:'POST',body:JSON.stringify({armed:a==='arm'})}));
    else if(a==='follow')alarmDo(()=>api('/override',{method:'DELETE'}));
    else if(a==='del-period'){const list=alarm.periods.filter((_,i)=>i!==+b.dataset.i).map(({start,end})=>({start,end}));
      alarmDo(()=>api('/periods',{method:'PUT',body:JSON.stringify(list)}));}
    else if(a==='del-away')alarmDo(()=>api(`/away/${b.dataset.id}`,{method:'DELETE'}));
    else if(a==='sess'){const id=+b.dataset.id;alarm.open=alarm.open===id?-1:id;
      if(alarm.open===id&&!alarm.events.has(id))api(`/sessions/${id}/events`).then(ev=>{alarm.events.set(id,ev);render();});
      render();}
  });
  panel.querySelectorAll('form[data-form]').forEach(f=>{
    f.oninput=()=>{alarmDirty=true;};
    f.onsubmit=e=>{
      e.preventDefault(); const v=Object.fromEntries(new FormData(f));
      if(f.dataset.form==='period'){
        if(v.start===v.end){alarm.error='Start and end must differ';alarmDirty=false;render();return;}
        const list=[...alarm.periods.map(({start,end})=>({start,end})),{start:v.start,end:v.end}];
        alarmDirty=false; alarmDo(()=>api('/periods',{method:'PUT',body:JSON.stringify(list)}));
      }else{
        if(v.to<v.from){alarm.error='The last day is before the first';alarmDirty=false;render();return;}
        alarmDirty=false; alarmDo(()=>api('/away',{method:'POST',body:JSON.stringify({from:v.from,to:v.to,...(v.note?{note:v.note}:{})})}));
      }
    };
  });
}
function renderPanel(){
  // keep keyboard focus across live re-renders
  const f=document.activeElement, fid=f&&panel.contains(f)?(f.dataset?.id||f.dataset?.room):null;
  if(page==='alarm'){
    // a form being filled in survives live updates; the page redraws only when its content changes
    const typing=f&&panel.contains(f)&&f.matches('input');
    if(alarmDirty||typing)return;
    const html=alarmHtml();
    if(panel._html===html)return;
    const top=panel.scrollTop; panel._html=html; panel.innerHTML=html; panel.scrollTop=top;
    bindAlarm();
    if(f&&panel.contains(f)===false&&f.dataset?.act)panel.querySelector(`[data-act="${CSS.escape(f.dataset.act)}"]${f.dataset.id?`[data-id="${CSS.escape(f.dataset.id)}"]`:''}`)?.focus();
    return;
  }
  panel._html=null;
  const top=panel.scrollTop;
  panel.innerHTML=page==='devices'?devicesHtml():overviewHtml();
  panel.scrollTop=top;
  panel.querySelectorAll('.row').forEach(b=>b.onclick=()=>{const r=ROOM_BY_ID[b.dataset.id];select(r===sel?null:r);});
  panel.querySelectorAll('.mini[data-room]').forEach(b=>b.onclick=()=>select(ROOM_BY_ID[b.dataset.room]));
  if(fid)panel.querySelector(`[data-id="${CSS.escape(fid)}"],[data-room="${CSS.escape(fid)}"]`)?.focus();
}

/* ---------- the selected room card ---------- */
const card=document.getElementById('room-card');
function renderCard(){
  if(!sel){card.hidden=true;delete card.dataset.room;return;}
  const r=sel,ds=devicesIn(r),s=roomState(r);
  const cells=ds.flatMap(d=>{
    const off=d.available===false;
    return entitiesOf(d.id).map(e=>{
      // distance only updates while someone is in range, so once the room is clear its last value is stale
      const stale=e===distanceOf(d.id)&&occupancyOf(d.id)?.value===false;
      const isOcc=OCC.includes(e.deviceClass||'');
      const v=stale?'—':e===distanceOf(d.id)&&typeof e.value==='number'?metres(e.value):formatValue(e);
      const cls=off||stale||e.value===null?'dim':isOcc&&e.value===true?'on':'';
      return `<div class="cell"><span class="label">${isOcc?'Presence':esc(e.name)}</span><strong class="${cls}">${esc(v)}</strong></div>`;
    });
  }).join('');
  const changed=s.at||Math.max(0,...ds.flatMap(d=>entitiesOf(d.id).map(e=>e.at||0)))||null;
  const ops=OPENINGS.filter(o=>o.room===r.id);
  // the header (with the close button) is rebuilt only when the room changes: live readings
  // arrive several times a second, and replacing the button mid-click would swallow the click
  if(card.dataset.room!==r.id){
    card.dataset.room=r.id;
    card.innerHTML=`<div class="rc-head"><span class="ico"></span>
      <div><strong>${esc(r.name)}</strong><small>${LVNAME[r.lv]} · ${r.area.toFixed(1)} m²</small></div>
      <button class="close" aria-label="Close ${esc(r.name)}">${ICON.close}</button></div><div class="rc-body"></div>`;
    card.querySelector('.ico').innerHTML=roomIcon(r);
    card.querySelector('.close').onclick=()=>select(null);
  }
  card.querySelector('.ico').className=`ico ${s.st==='on'?'on':s.st==='offline'?'off':''}`;
  const body=card.querySelector('.rc-body');
  const html=`${ds.length?`<div class="cells">${cells||'<p class="note">No readings yet.</p>'}</div>
      ${s.st==='offline'?'<p class="note">An offline board’s last reading isn’t counted as someone being there.</p>':''}
      <div class="rc-foot">${statusHtml(ds)}<span>${changed?ago(changed):''}</span></div>`
    :`<p class="note">No presence sensor here. To add one, set <code>"room": "${r.id}"</code> for it in <code>layout.json</code>.</p>`}
    ${ops.length?`<div class="ops"><span class="label">Doors and windows</span><ul class="minis">${ops.map(o=>{const st=openingState(o).st;
      return `<li class="mini" title="${o.id}"><span>${esc(o.name)}</span><b class="${isAlert(st)?'on':st==='closed'?'ok':''}">${OWORD[st]}</b></li>`;}).join('')}</ul></div>`:''}`;
  if(body._html!==html){body._html=html;body.innerHTML=html;}
  card.hidden=false;
}

/* ---------- tags over the 3D view ---------- */
const tagsEl=document.getElementById('tags'); let tags=[];
// tags are kept by key and only their contents change: readings arrive several times a second,
// and swapping the button out mid-click would swallow the click
const tagEls=new Map(); let tagSeen=new Set();
function addTag(key,r,v,cls,label,html){
  let el=tagEls.get(key);
  if(!el){el=document.createElement('button');tagEls.set(key,el);}
  el.onclick=()=>select(r===sel?null:r);
  const c='tag'+cls+(r===sel?' sel':'');
  if(el.className!==c)el.className=c;
  if(el.getAttribute('aria-label')!==label)el.setAttribute('aria-label',label);
  if(el._html!==html){el._html=html;el.innerHTML=html;}
  if(el.parentNode!==tagsEl)tagsEl.appendChild(el); // moving a node mid-click loses the click too
  tags.push({r,el,v}); tagSeen.add(key);
}
function buildTags(){
  tags=[]; tagSeen=new Set();
  // rooms with a sensor get a bubble (from the whole-house view too); the rest of this floor a quiet name
  ROOMS.filter(r=>devicesIn(r).length?(r.lv===view||view==='out'):r.lv===view).forEach(r=>{
    const s=roomState(r),sensor=s.st!=='none';
    const y=(r.lv==='u'?UB+(sensor?160:40):r.lv==='g'?(sensor?150:30):40)/100;
    addTag('room:'+r.id,r,new THREE.Vector3(r.c[0]/100,y,r.c[1]/100),sensor?(s.st==='on'?' on':s.st==='clear'?'':' off'):' quiet',`${r.name}: ${WORD[s.st]}`,
      sensor?`<span class="bubble">${roomIcon(r)}<span><b>${WORD[s.st]}${s.st==='on'&&typeof s.dist==='number'?' · '+metres(s.dist):''}</b><small>${esc(r.name)}</small></span></span><span class="pin"></span>`
        :`<span class="bubble">${roomIcon(r)}<span>${esc(r.name)}</span></span>`);
  });
  // an open door or window gets its own bubble, on its floor and from the whole-house view
  OPENINGS.filter(o=>(o.lv===view||view==='out')&&isAlert(openingState(o).st)).forEach(o=>{
    const st=openingState(o).st;
    addTag('op:'+o.id,ROOM_BY_ID[o.room],o.tagAt,' on',`${o.name}: ${OWORD[st]}`,
      `<span class="bubble">${openingIcon(o,st)}<span><b>${OWORD[st]}</b><small>${esc(o.name)}</small></span></span><span class="pin"></span>`);
  });
  tagEls.forEach((el,k)=>{if(!tagSeen.has(k)){el.remove();tagEls.delete(k);}});
}
const tmp=new THREE.Vector3();
function placeTags(w,h){
  tags.forEach(t=>{tmp.copy(t.v).project(camera);
    const vis=tmp.z<1&&tmp.x>-1.1&&tmp.x<1.1&&tmp.y>-1.1&&tmp.y<1.1;
    t.el.style.display=vis?'flex':'none';
    if(vis){t.el.style.left=((tmp.x+1)/2*w)+'px';t.el.style.top=((1-tmp.y)/2*h)+'px';}
  });
}

/* ---------- connection status ---------- */
let lastReading=null;
function renderLink(){
  const el=document.getElementById('link'), up=live.connected&&live.brokerUp;
  el.className='link'+(up?' up':live.everConnected?' down':'');
  const t=(!live.connected?(live.everConnected?'Reconnecting':'Connecting'):live.brokerUp?'Connected':'Broker down')+(lastReading?` · last reading ${ago(lastReading)}`:'');
  el.title=t; document.getElementById('link-text').textContent=t;
}

// coalesce bursts of updates (distance arrives up to once a second per board) into one redraw
let pending=false;
function render(){
  if(pending)return; pending=true;
  requestAnimationFrame(()=>{pending=false;paint();renderPanel();renderCard();buildTags();renderLink();});
}

/* ---------- picking and controls ---------- */
const ray=new THREE.Raycaster(),ptr=new THREE.Vector2(); let down=null;
function pick(e){
  const b=renderer.domElement.getBoundingClientRect();
  ptr.set(((e.clientX-b.left)/b.width)*2-1,-((e.clientY-b.top)/b.height)*2+1);
  ray.setFromCamera(ptr,camera);
  const hit=ray.intersectObjects(ROOMS.filter(r=>r.mesh.visible).map(r=>r.mesh))[0];
  return hit?hit.object.userData.room:null;
}
renderer.domElement.addEventListener('pointerdown',e=>{down=[e.clientX,e.clientY];});
renderer.domElement.addEventListener('pointermove',e=>{
  if(e.pointerType!=='mouse')return;
  const r=pick(e); if(r!==hover){hover=r;paint();renderer.domElement.style.cursor=r?'pointer':'';}
});
renderer.domElement.addEventListener('pointerup',e=>{
  if(!down)return; const moved=Math.hypot(e.clientX-down[0],e.clientY-down[1]); down=null;
  if(moved>6)return;
  const r=pick(e);
  if(r)select(r===sel?null:r);
  else if(view==='out'&&ray.intersectObjects([G.roof,G.g,G.u],true).length){setView('g');}
});
addEventListener('keydown',e=>{if(e.key==='Escape'&&sel)select(null);});
document.querySelectorAll('.seg button').forEach(b=>b.onclick=()=>{sel=null;setView(b.dataset.view);});
function zoom(f){
  const off=camera.position.clone().sub(controls.target).multiplyScalar(f);
  off.setLength(Math.min(controls.maxDistance,Math.max(controls.minDistance,off.length())));
  flyTo(controls.target.clone().add(off).toArray(),controls.target.toArray(),300);
}
document.getElementById('zoom-in').onclick=()=>zoom(.75);
document.getElementById('zoom-out').onclick=()=>zoom(1/.75);
document.getElementById('reset').onclick=()=>{sel=null;const p=PRESET[view];flyTo(p.pos,p.tgt);render();};
document.querySelectorAll('button.rail-btn').forEach(b=>b.onclick=()=>{
  page=b.dataset.page; alarmDirty=false;
  if(page==='alarm')loadAlarm();
  document.querySelectorAll('button.rail-btn').forEach(x=>x===b?x.setAttribute('aria-current','page'):x.removeAttribute('aria-current'));
  panel.scrollTop=0; render();
});

/* ---------- live connection ---------- */
function apply(msg){
  const seen=t=>{if(t)lastReading=Math.max(lastReading||0,t);};
  if(msg.type==='snapshot'){
    live.brokerUp=msg.connected;
    live.devices=new Map(msg.devices.map(d=>[d.id,d]));
    live.entities=new Map(msg.entities.map(e=>[e.id,e]));
    msg.entities.forEach(e=>seen(e.at)); msg.devices.forEach(d=>seen(d.availableAt));
    if(msg.alarm){alarm.status=msg.alarm;if(page==='alarm')loadAlarm();}
  } else if(msg.type==='device'){live.devices.set(msg.device.id,msg.device);seen(msg.device.availableAt);refreshLogSoon();}
  else if(msg.type==='entity'){live.entities.set(msg.entity.id,msg.entity);seen(msg.entity.at);refreshLogSoon();}
  else if(msg.type==='alarm'){alarm.status=msg.alarm;if(page==='alarm')loadAlarm();}
  else if(msg.type==='broker')live.brokerUp=msg.connected;
  render();
}
function connect(){
  const es=new EventSource('api/events');
  es.onopen=()=>{live.connected=live.everConnected=true;render();};
  es.onmessage=ev=>apply(JSON.parse(ev.data));
  es.onerror=()=>{live.connected=false;render();}; // EventSource retries by itself
}
setInterval(render,30_000); // keeps the clock and every "… ago" current

/* ---------- loop ---------- */
// On wide screens the panels cover the left of the stage, so the house is drawn centred in the free part.
const LEFT_COVER=16+72+16+392;
function resize(){
  const w=stage.clientWidth,h=stage.clientHeight; if(!w||!h)return;
  renderer.setSize(w,h,false); camera.aspect=w/h;
  if(w>820)camera.setViewOffset(w,h,-Math.round(Math.min(LEFT_COVER,w*.45)/2),0,w,h); else camera.clearViewOffset();
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(stage); resize();
const compass=document.getElementById('compass');
const ease=t=>t<.5?4*t*t*t:1-Math.pow(-2*t+2,3)/2;
function loop(now){
  if(tween){
    const k=Math.min(1,(now-tween.t0)/tween.ms),e=ease(k);
    camera.position.lerpVectors(tween.p0,tween.p1,e); controls.target.lerpVectors(tween.q0,tween.q1,e);
    if(k>=1)tween=null;
  }
  controls.update(); renderer.render(scene,camera);
  placeTags(stage.clientWidth,stage.clientHeight);
  // the plan's north is -z: on screen it sits at the camera's azimuth, clockwise from up
  compass.style.transform=`rotate(${controls.getAzimuthalAngle()}rad)`;
  requestAnimationFrame(loop);
}
camera.position.set(...PRESET.out.pos); controls.target.set(...PRESET.out.tgt);
applyVisibility(); markView(); render();
connect();
requestAnimationFrame(loop);
})();
