// ===== STATE =====
// Single top-level App object; everything else lives inside this IIFE closure.
window.App = (function () {
'use strict';

/* ---------------------------------------------------------------------------
 * MODEL UNITS: geometry in mm, time in s, pressure in Pa, temperature °C
 * (converted to K where physics needs it). Raster grid ≤ 400×400 cells.
 * ------------------------------------------------------------------------- */

const MAX_GRID = 400;                 // hard performance cap on raster size
const R_GAS = 8.314;                  // universal gas constant J/(mol·K)
const HISTORY_MAX = 60;               // bounded undo stack (≥50 required)

let _uid = 1;
const uid = () => _uid++;

// ---- parameter registry: every numeric input is validated/clamped here ----
// [id, kind, min, max, unit]
const P_DEFS = [
  ['m_eta0','num',1,1e7,'Pa·s'],   ['m_n','num',0.05,1,''],      ['m_vf','num',0,0.7,''],
  ['m_ar','num',1,500,'L/D'],      ['m_ctk','num',0,0.5,''],     ['m_rho','num',100,5000,'kg/m³'],
  ['m_cp','num',100,5000,'J/kgK'], ['m_k','num',0.01,20,'W/mK'], ['m_Tc','num',-50,400,'°C'],
  ['m_Tm','num',-50,400,'°C'],     ['m_E','num',0,2e5,'J/mol'],  ['m_k0','num',0,10,'1/s'],
  ['m_Ea','num',0,2e5,'J/mol'],
  ['p_hc','num',0.1,100,'mm'],      ['p_hgap','num',0.1,100,'mm'],['p_vc','num',0,200,'mm/s'],
  ['p_hf','num',0.1,100,'mm'],      ['p_pinj','num',0.01,200,'MPa'],['p_res','int',20,MAX_GRID,'cells'],
  ['p_wall','num',0,2,''],          ['p_tol','num',1e-9,0.1,''],  ['p_maxit','int',100,50000,''],
  ['p_dt','num',0.01,10,'s'],       ['p_tmax','num',0.5,600,'s'], ['p_cooltau','num',1,1e4,'s'],
  ['v_cont','int',0,20,''],         ['v_seed','int',2,40,''],     ['snapPitch','num',0.5,100,'mm'],
];
const P = {};                          // current parameter values (validated)

// ---- application state ----
const S = {
  shapes: [],            // array of shape objects (see GEOMETRY section)
  sel: new Set(),        // selected shape ids
  gates: [],             // [{x,y}] model-mm gate positions
  gateMode: false,
  clipboard: [],
  history: [], histPtr: -1,   // undo/redo over shapes+gates snapshots
  view: {cx:0, cy:0, scale:6},   // camera: model center, px per mm
  grid: null,            // raster buffers {nx,ny,cell,cav,ins,chg,...}
  fields: null,          // solver output typed arrays
  solInfo: {model:'A', iters:0, residual:0, ms:0},
  tCur: 20, playing:false, playSpeed:1, playRAF:0, lastPlayTs:0,
  cancelFlag:false, running:false,
  snapGuides: [],        // transient guide lines for drawing {x1,y1,x2,y2}
  dirty: true,           // needs redraw
};

// ---- default demo scene (mirrors the original tool's starting layout) ----
function defaultShapes() {
  return [
    mkShape({type:'rrect', role:'cavity', x:-60, y:-40, w:120, h:80, r:10}),
    mkShape({type:'circle', role:'insert', x:-20, y:0, r:12}),
    mkShape({type:'npoly', role:'insert', x:30, y:-15, r:10, sides:6}),
    mkShape({type:'ellipse', role:'charge', x:-45, y:5, w:34, h:20}),
    mkShape({type:'rect', role:'charge', x:18, y:12, w:26, h:16}),
  ];
}

// =============================================================================
// ===== GEOMETRY =====
// Shape kinds: rect, rrect, circle, ellipse, annulus, npoly, poly, spline, path
// All shapes carry a transform (x,y center + rotation deg). Sizes are local mm.
// =============================================================================
function mkShape(o) {
  const sh = {
    id: uid(), type: o.type || 'rect', role: o.role || 'cavity',
    x: o.x || 0, y: o.y || 0, rot: o.rot || 0,
    w: o.w != null ? o.w : 40, h: o.h != null ? o.h : 30,
    r: o.r != null ? o.r : 15, ri: o.ri != null ? o.ri : 8,   // outer/inner radius
    sides: o.sides || 6,                                        // regular polygon n
    pts: o.pts || null,                                         // poly/spline/path control points, local coords
    width: o.width != null ? o.width : 6,                       // path stroke width mm
    name: o.name || (o.role + ' ' + o.type),
  };
  if (!sh.pts && (sh.type === 'poly' || sh.type === 'spline'))
    sh.pts = [[-20,-14],[20,-14],[24,12],[-24,12]];             // default closed quad
  if (!sh.pts && sh.type === 'path') sh.pts = [[-30,0],[0,10],[30,0]];
  return sh;
}

// Local-space half extents used for handles / bounding boxes.
function shapeHalfExtents(sh) {
  switch (sh.type) {
    case 'rect': case 'rrect': case 'ellipse': return {hw: sh.w/2, hh: sh.h/2};
    case 'circle': case 'npoly': case 'annulus': return {hw: sh.r, hh: sh.r};
    case 'poly': case 'spline': case 'path': {
      let mx = 1, my = 1;
      for (const p of (sh.pts||[])) { mx = Math.max(mx, Math.abs(p[0])); my = Math.max(my, Math.abs(p[1])); }
      const pad = sh.type==='path' ? sh.width/2 : 0;
      return {hw: mx+pad, hh: my+pad};
    }
  }
  return {hw: 10, hh: 10};
}

// World-space AABB of a shape (rotation aware).
function shapeAABB(sh) {
  const {hw, hh} = shapeHalfExtents(sh);
  const c = Math.cos(sh.rot*Math.PI/180), s = Math.sin(sh.rot*Math.PI/180);
  const ex = Math.abs(hw*c) + Math.abs(hh*s), ey = Math.abs(hw*s) + Math.abs(hh*c);
  return {x0: sh.x-ex, x1: sh.x+ex, y0: sh.y-ey, y1: sh.y+ey};
}

// Sample the outline of a shape into world-space polyline(s) for drawing/raster.
function shapeOutline(sh, steps) {
  steps = steps || 48;
  const out = [];
  const tr = (px, py) => {
    const a = sh.rot*Math.PI/180, c = Math.cos(a), s = Math.sin(a);
    return [sh.x + px*c - py*s, sh.y + px*s + py*c];
  };
  const T = sh.type;
  if (T==='rect' || T==='rrect') {
    const hw=sh.w/2, hh=sh.h/2;
    if (T==='rect' || sh.r<=0.01) out.push([tr(-hw,-hh),tr(hw,-hh),tr(hw,hh),tr(-hw,hh)]);
    else { // rounded rectangle: quarter arcs at corners (radius clamped to half-size)
      const r=Math.min(sh.r,hw,hh), seg=Math.max(4,steps>>3);
      const ring=[]; const corners=[[hw-r,hh-r],[-(hw-r),hh-r],[-(hw-r),-(hh-r)],[hw-r,-(hh-r)]];
      for (let ci=0;ci<4;ci++){
        const [ccx,ccy]=corners[ci], a0=(ci*90)*Math.PI/180;
        for(let k=0;k<=seg;k++){const a=a0+k/seg*Math.PI/2;ring.push(tr(ccx+r*Math.cos(a),ccy+r*Math.sin(a)));}
      }
      out.push(ring);
    }
  } else if (T==='circle' || T==='ellipse' || T==='npoly' || T==='annulus') {
    const mk=(rad)=>{const ring=[];
      if (T==='npoly'){const n=Math.max(3,sh.sides|0);
        for(let k=0;k<=n;k++){const a=k/n*Math.PI*2;ring.push(tr(rad*Math.cos(a),rad*Math.sin(a)));}
      } else {
        for(let k=0;k<=steps;k++){const a=k/steps*Math.PI*2;
          ring.push(tr(rad*Math.cos(a), rad*(T==='ellipse'?sh.h/Math.max(sh.w,1e-6):1)*Math.sin(a)));}
      } return ring;};
    out.push(mk(T==='circle'||T==='npoly'?sh.r:sh.w/2));
    if (T==='annulus') out.push(mk(Math.max(0.1,sh.ri)));
  } else if (T==='poly' || T==='spline' || T==='path') {
    const pts = sh.pts||[[0,0]];
    if (T==='poly' || T==='path') out.push(pts.map(p=>tr(p[0],p[1])));
    else out.push(catmullClosed(pts, steps).map(p=>tr(p[0],p[1]))); // closed cubic spline
  }
  return out;
}

// Catmull-Rom → dense sampling of a CLOSED cubic spline through control points.
function catmullClosed(P_, stepsPer) {
  const n=P_.length, res=[]; if(n<3) return P_.slice();
  const seg=Math.max(4,(stepsPer/n)|0);
  for(let i=0;i<n;i++){
    const p0=P_[(i-1+n)%n],p1=P_[i],p2=P_[(i+1)%n],p3=P_[(i+2)%n];
    for(let k=0;k<seg;k++){
      const t=k/seg,t2=t*t,t3=t2*t;
      // uniform Catmull-Rom basis (equivalent to piecewise cubic Bézier segments)
      res.push([
        0.5*((2*p1[0])+(-p0[0]+p2[0])*t+(2*p0[0]-5*p1[0]+4*p2[0]-p3[0])*t2+(-p0[0]+3*p1[0]-3*p2[0]+p3[0])*t3),
        0.5*((2*p1[1])+(-p0[1]+p2[1])*t+(2*p0[1]-5*p1[1]+4*p2[1]-p3[1])*t2+(-p0[1]+3*p1[1]-3*p2[1]+p3[1])*t3)
      ]);
    }
  }
  res.push(res[0].slice());
  return res;
}

// Point-in-shape test in LOCAL space (inverse-transform the query point).
function pointInShape(sh, wx, wy) {
  const a=-sh.rot*Math.PI/180, c=Math.cos(a), s=Math.sin(a);
  const dx=wx-sh.x, dy=wy-sh.y;
  const lx=dx*c-dy*s, ly=dx*s+dy*c;              // inverse rotation
  const T=sh.type;
  if (T==='rect'||T==='rrect'){const hw=sh.w/2,hh=sh.h/2;
    if (T==='rect'||sh.r<=0.01) return Math.abs(lx)<=hw&&Math.abs(ly)<=hh;
    const r=Math.min(sh.r,hw,hh);                // exact rounded-rect corner test
    if (Math.abs(lx)<=hw-r||Math.abs(ly)<=hh-r) return Math.abs(lx)<=hw&&Math.abs(ly)<=hh;
    const qx=Math.abs(lx)-(hw-r),qy=Math.abs(ly)-(hh-r);return qx*qx+qy*qy<=r*r;
  }
  if (T==='circle') return lx*lx+ly*ly<=sh.r*sh.r;
  if (T==='ellipse'){const rx=sh.w/2||1,ry=sh.h/2||1;return (lx/rx)**2+(ly/ry)**2<=1;}
  if (T==='annulus'){const d2=lx*lx+ly*ly;return d2<=sh.r*sh.r && d2>=sh.ri*sh.ri;}
  if (T==='npoly'){const n=Math.max(3,sh.sides|0); // regular polygon via apothem in sector
    if (lx*lx+ly*ly>sh.r*sh.r) return false;
    const ang=Math.atan2(ly,lx),sec=Math.PI*2/n;
    const local=((ang%sec)+sec)%sec-sec/2;                    // angle from sector center
    const lim=sh.r*Math.cos(sec/2)/Math.cos(local);           // distance to chord edge
    return Math.sqrt(lx*lx+ly*ly)<=lim;
  }
  if (T==='poly'||T==='spline'){
    const poly = T==='spline' ? catmullClosed(sh.pts||[], 96) : (sh.pts||[]);
    return pointInPoly(poly, lx, ly);
  }
  if (T==='path'){ // distance to polyline < width/2
    const pts=sh.pts||[]; const hw=sh.width/2;
    for(let i=0;i<pts.length-1;i++) if (distSeg(pts[i],pts[i+1],lx,ly)<=hw) return true;
    return pts.length===1 && Math.hypot(lx-pts[0][0],ly-pts[0][1])<=hw;
  }
  return false;
}
function pointInPoly(poly,x,y){let inside=false;
  for(let i=0,j=poly.length-1;i<poly.length;j=i++){
    const xi=poly[i][0],yi=poly[i][1],xj=poly[j][0],yj=poly[j][1];
    if((yi>y)!==(yj>y)&&x<(xj-xi)*(y-yi)/(yj-yi+1e-12)+xi)inside=!inside;
  } return inside;}
function distSeg(a,b,px,py){const vx=b[0]-a[0],vy=b[1]-a[1];const L=vx*vx+vy*vy;
  let t=L?((px-a[0])*vx+(py-a[1])*vy)/L:0;t=Math.max(0,Math.min(1,t));
  return Math.hypot(px-(a[0]+t*vx),py-(a[1]+t*vy));}

// Selection helpers
function selShapes(){return S.shapes.filter(s=>S.sel.has(s.id));}
function bringSend(dir){ // dir=+1 up (later drawn on top), -1 down
  const idx=S.shapes.map((s,i)=>S.sel.has(s.id)?i:-1).filter(i=>i>=0);
  if(dir>0)for(const i of idx.sort((a,b)=>b-a)){if(i<S.shapes.length-1){const t=S.shapes[i];S.shapes[i]=S.shapes[i+1];S.shapes[i+1]=t;}}
  else for(const i of idx.sort((a,b)=>a-b)){if(i>0){const t=S.shapes[i];S.shapes[i]=S.shapes[i-1];S.shapes[i-1]=t;}}
  pushHistory();refreshShapeList();markDirty();
}
function deleteSel(){if(!S.sel.size)return;S.shapes=S.shapes.filter(s=>!S.sel.has(s.id));S.sel.clear();pushHistory();refreshShapeList();buildEditor();markDirty();}
function duplicateSel(off){const dup=selShapes().map(s=>{const c=JSON.parse(JSON.stringify(s));c.id=uid();c.x+=off||8;c.y+=off||8;c.name+=' copy';return c;});
  S.sel=new Set(dup.map(d=>d.id));S.shapes=S.shapes.concat(dup);pushHistory();refreshShapeList();buildEditor();markDirty();}
function copySel(){S.clipboard=selShapes().map(s=>JSON.parse(JSON.stringify(s)));setMsg('Copied '+S.clipboard.length);}
function pasteClip(){if(!S.clipboard.length)return;const pasted=S.clipboard.map(s=>{const c=JSON.parse(JSON.stringify(s));c.id=uid();c.x+=6;c.y+=6;return c;});
  S.sel=new Set(pasted.map(p=>p.id));S.shapes=S.shapes.concat(pasted);pushHistory();refreshShapeList();buildEditor();markDirty();}

// ---- history (undo/redo): snapshot shapes+gates, bounded stack ----
function snapshot(){return JSON.stringify({shapes:S.shapes,gates:S.gates});}
function pushHistory(){
  S.history=S.history.slice(0,S.histPtr+1);
  S.history.push(snapshot());
  if(S.history.length>HISTORY_MAX)S.history.shift();
  S.histPtr=S.history.length-1;
}
function restore(str){const o=JSON.parse(str);S.shapes=o.shapes;S.gates=o.gates;
  S.sel=new Set([...S.sel].filter(id=>S.shapes.some(s=>s.id===id)));
  refreshShapeList();buildEditor();markDirty();}
function undo(){if(S.histPtr>0){S.histPtr--;restore(S.history[S.histPtr]);setMsg('Undo');}}
function redo(){if(S.histPtr<S.history.length-1){S.histPtr++;restore(S.history[S.histPtr]);setMsg('Redo');}}

// =============================================================================
// ===== RASTER =====
// Cell classification by point-sampling cell centers against shapes.
// Role composition: cavity = union(cavity) minus union(insert); charge must lie
// inside the cavity mask to act as source. Uint8 masks: 0 empty, 1 cavity, etc.
// =============================================================================
const G = {                       // raster buffers (allocated once per solve)
  nx:0, ny:0, cell:0, ox:0, oy:0, // grid dims, cell size mm, model origin (mm)
  bounds:{x0:0,y0:0,x1:1,y1:1},
  cav:null, ins:null, chg:null,   // Uint8Array masks
  wallDist:null,                  // Float32Array: distance-to-wall in cells (for drag penalty)
};

function sceneBounds(){
  let x0=1e9,y0=1e9,x1=-1e9,y1=-1e9;
  for(const sh of S.shapes){const b=shapeAABB(sh);x0=Math.min(x0,b.x0);y0=Math.min(y0,b.y0);x1=Math.max(x1,b.x1);y1=Math.max(y1,b.y1);}
  if(x0>x1){x0=-50;y0=-50;x1=50;y1=50;}
  const pad=(x1-x0+y1-y0)*0.02+1;
  return {x0:x0-pad,y0:y0-pad,x1:x1+pad,y1:y1+pad};
}

function rasterize(){
  const b=sceneBounds();G.bounds=b;
  const res=clampNum(P.p_res,20,MAX_GRID);
  const spanX=b.x1-b.x0, spanY=b.y1-b.y0;
  // resolution = cells across longest dimension, capped so nx*ny ≤ MAX_GRID²
  let cell=Math.max(spanX,spanY)/res;
  const nx=Math.min(MAX_GRID,Math.max(8,Math.ceil(spanX/cell)));
  const ny=Math.min(MAX_GRID,Math.max(8,Math.ceil(spanY/cell)));
  G.nx=nx;G.ny=ny;G.cell=Math.max(spanX/nx,spanY/ny);G.ox=b.x0;G.oy=b.y0;
  const N=nx*ny;
  if(!G.cav||G.cav.length!==N){G.cav=new Uint8Array(N);G.ins=new Uint8Array(N);G.chg=new Uint8Array(N);G.wallDist=new Float32Array(N);}
  G.cav.fill(0);G.ins.fill(0);G.chg.fill(0);
  // classify each cell center against every shape (role stacking by z-order)
  for(let j=0;j<ny;j++){
    const wy=G.oy+(j+0.5)*G.cell;
    for(let i=0;i<nx;i++){
      const wx=G.ox+(i+0.5)*G.cell, k=j*nx+i;
      let c=0,ns=0,ch=0;
      for(const sh of S.shapes){               // last role wins for cavity vs insert override
        if(pointInShape(sh,wx,wy)){
          if(sh.role==='cavity')c=1;else if(sh.role==='insert')ns=1;else if(sh.role==='charge')ch=1;
        }
      }
      if(ns)G.ins[k]=1;                        // inserts block regardless
      G.cav[k]=c&&!ns?1:0;                     // cavity minus inserts
      G.chg[k]=ch&&c&&!ns?1:0;                 // charge only counts inside cavity
    }
  }
  // wall distance (cells to nearest non-cavity) via two-pass chamfer (d≈1/cell)
  // — used by Model A wall-drag penalty. [assumption: 8-connected chamfer]
  const INF=1e9;
  for(let k=0;k<N;k++)G.wallDist[k]=G.cav[k]?INF:0;
  for(let j=0;j<ny;j++)for(let i=0;i<nx;i++){const k=j*nx+i;
    let d=G.wallDist[k];
    if(i>0)d=Math.min(d,G.wallDist[k-1]+1); if(j>0)d=Math.min(d,G.wallDist[k-nx]+1);
    if(i>0&&j>0)d=Math.min(d,G.wallDist[k-nx-1]+1.4142); if(i+1<nx&&j>0)d=Math.min(d,G.wallDist[k-nx+1]+1.4142);
    G.wallDist[k]=d;}
  for(let j=ny-1;j>=0;j--)for(let i=nx-1;i>=0;i--){const k=j*nx+i;
    let d=G.wallDist[k];
    if(i+1<nx)d=Math.min(d,G.wallDist[k+1]+1); if(j+1<ny)d=Math.min(d,G.wallDist[k+nx]+1);
    if(i+1<nx&&j+1<ny)d=Math.min(d,G.wallDist[k+nx+1]+1.4142); if(i>0&&j+1<ny)d=Math.min(d,G.wallDist[k+nx-1]+1.4142);
    G.wallDist[k]=d;}
  for(let k=0;k<N;k++)if(G.wallDist[k]>50)G.wallDist[k]=50;   // cap: deep interior gets no extra drag
  updateStatusGrid();
}

// inlet cells: gates snapped to nearest cavity cell; else all charge cells
function inletCells(){
  const N=G.nx*G.ny, src=new Uint8Array(N);
  if(S.gates.length){
    for(const g of S.gates){
      let i=Math.floor((g.x-G.ox)/G.cell), j=Math.floor((g.y-G.oy)/G.cell);
      i=Math.max(0,Math.min(G.nx-1,i));j=Math.max(0,Math.min(G.ny-1,j));
      // search a small neighborhood for a cavity cell (gate may land on an insert edge)
      let best=-1,bd=1e9;
      for(let dj=-2;dj<=2;dj++)for(let di=-2;di<=2;di++){
        const ii=i+di,jj=j+dj;if(ii<0||jj<0||ii>=G.nx||jj>=G.ny)continue;
        const k=jj*G.nx+ii;if(G.cav[k]){const d=di*di+dj*dj;if(d<bd){bd=d;best=k;}}
      }
      if(best>=0)src[best]=1;
    }
  } else {
    for(let k=0;k<N;k++)if(G.chg[k])src[k]=1;
  }
  return src;
}

// =============================================================================
// ===== SOLVERS =====
/* ---------------------------------------------------------------------------
 * MODEL A — Fast Dijkstra fill time.
 *   Nodes = cavity cells. Source = inlet cells (t=0). Edge cost between
 *   neighbor cells = Δt = cellLen / ū, with mean front speed modeled as
 *   ū ∝ K_eff·wallFactor, where K_eff = 1/(η_rel) and η_rel=(1+4·vf) is the
 *   Einstein-type fiber viscosity multiplier (SMC heuristic). Wall drag:
 *   cells within ~3 cells of a wall get cost × (1 + tightness/wallDist).
 *   Uses a binary-heap priority queue over typed arrays (no allocations).
 * ------------------------------------------------------------------------- */
/* ---------------------------------------------------------------------------
 * MODEL B — Hele-Shaw pressure. Solve ∇·(S∇p)=0 with variable conductance
 *   S=h_gap²/(12·η) (gap converted mm→m), Dirichlet p=p_inj at inlets, p=0 at
 *   "front" cells (initially all cavity cells adjacent to unfilled region —
 *   here treated as open boundary at cavity rim & inserts), Neumann elsewhere.
 *   η = η₀·(1+4vf)·γ̇^(n−1)·f(T), γ̇≈6|∇p|·h/(12η... simplified: γ̇ = |∇p|·h/(2η))
 *   recomputed every 10 sweeps; solved by red-black Gauss–Seidel SOR ω=1.9.
 * ------------------------------------------------------------------------- */
/* ---------------------------------------------------------------------------
 * MODEL C — VOF front tracking on top of B: fill fraction f∈[0,1] advanced by
 *   u=−(h²/12η)∇p with explicit upwind flux per Δt until t_max; air traps =
 *   cells still unfilled whose 4 neighbors are all filled (enclosed gas).
 * ------------------------------------------------------------------------- */

// ---- shared field buffers (reused across solves; sized N=nx*ny) ----
const F = {
  t:null, p:null, vx:null, vy:null, speed:null, fiber:null, weld:null, weldStr:null,
  temp:null, cure:null, a11:null, a22:null, a12:null, frac:null, trap:null, unfilled:null,
  src:null, pq:null, heap:null, inHeap:null, eta:null, Scond:null, gamma:null,
  hist:null, nWeld:0, nTrap:0, nUnf:0, tFillMax:0, pMax:0, clampKN:0,
};
function allocFields(N){
  if(F.t&&F.t.length===N)return;
  const mk=()=>new Float32Array(N);
  Object.assign(F,{t:mk(),p:mk(),vx:mk(),vy:mk(),speed:mk(),fiber:mk(),weld:mk(),weldStr:mk(),
    temp:mk(),cure:mk(),a11:mk(),a22:mk(),a12:mk(),frac:mk(),trap:new Uint8Array(N),
    unfilled:new Uint8Array(N),src:new Uint8Array(N),inHeap:new Uint8Array(N),eta:mk(),Scond:mk()});
  F.hist=new Float32Array(64);
}

// Arrhenius viscosity multiplier: exp(E/R·(1/T − 1/Tref)), T in Kelvin. [source: prompt spec]
function arrhenius(TdegC){
  if(!document.getElementById('p_noniso').checked)return 1;
  const TK=TdegC+273.15, Tref=P.m_Tc+273.15;
  return Math.exp(P.m_E/R_GAS*(1/TK-1/Tref));
}

// effective viscosity at a cell given local shear rate estimate
// η = η₀·(1+4vf)·γ̇^(n−1)·Arrhenius  [power-law (Cross-type simplified), spec eq.]
function effEta(gammaDot,TdegC){
  const gd=Math.max(gammaDot,1e-3);            // clamp γ̇ to avoid 0^(n-1) blowup
  return P.m_eta0*(1+4*P.m_vf)*Math.pow(gd,P.m_n-1)*arrhenius(TdegC);
}

// ---- binary min-heap over (key=Float64 time, val=int cell) — no per-push allocs ----
const Heap = {keys:new Float64Array(0), vals:new Int32Array(0), n:0};
function heapInit(cap){if(Heap.keys.length<cap){Heap.keys=new Float64Array(cap);Heap.vals=new Int32Array(cap);}Heap.n=0;}
function heapPush(key,val){
  let i=Heap.n++;const K=Heap.keys,V=Heap.vals;K[i]=key;V[i]=val;
  while(i>0){const par=(i-1)>>1;if(K[par]<=K[i])break;
    const tk=K[par];K[par]=K[i];K[i]=tk;const tv=V[par];V[par]=V[i];V[i]=tv;i=par;}
}
function heapPop(){
  const K=Heap.keys,V=Heap.vals;const top=V[0];
  Heap.n--;if(Heap.n>0){K[0]=K[Heap.n];V[0]=V[Heap.n];
    let i=0;const n=Heap.n;
    for(;;){const l=i*2+1,r=l+1;let m=i;
      if(l<n&&K[l]<K[m])m=l;if(r<n&&K[r]<K[m])m=r;if(m===i)break;
      const tk=K[m];K[m]=K[i];K[i]=tk;const tv=V[m];V[m]=V[i];V[i]=tv;i=m;}
  }
  return top;
}

/* ============================ MODEL A — Dijkstra ============================ */
function solveDijkstra(){
  const nx=G.nx,ny=G.ny,N=nx*ny,t=F.t,cav=G.cav;
  t.fill(Infinity);
  F.src.set(inletCells());
  heapInit(N);
  for(let k=0;k<N;k++)if(F.src[k]){t[k]=0;heapPush(0,k);}
  if(!countOnes(F.src)){setMsg('No inlet: place gates or charge inside cavity',true);return false;}
  // base front speed u0 [mm/s]: heuristic scale so typical part fills in ~p_tmax window.
  // u0 ∝ h_gap²·p_inj/(η·L) lumped → use dimensionless mobility with η_rel only. [assumption]
  const etaRel=1+4*P.m_vf;
  const uBase=Math.max(P.p_hgap,0.1)**2*(P.p_pinj*1e6)/(P.m_eta0*etaRel*arrhenius(P.m_Tc))*1e-6+0.05; // mm/s (scaled, documented heuristic)
  const tight=P.p_wall;
  const INF=Heap.keys,IV=Heap.vals;
  const dirs=[[1,0,1],[-1,0,1],[0,1,1],[0,-1,1],[1,1,1.4142],[1,-1,1.4142],[-1,1,1.4142],[-1,-1,1.4142]];
  while(Heap.n){
    if(S.cancelFlag)return false;
    const k=heapPop();const tk=t[k];
    if(tk>t[k]+1e-9)continue;                    // stale heap entry
    const i=k%nx,j=(k/nx)|0;
    for(const d of dirs){
      const ii=i+d[0],jj=j+d[1];if(ii<0||jj<0||ii>=nx||jj>=ny)continue;
      const kk=jj*nx+ii;if(!cav[kk])continue;
      // wall-drag penalty near boundaries/inserts (heuristic Poiseuille edge drag)
      const wd=G.wallDist[kk];
      const drag=wd<3?(1+tight/Math.max(wd,0.3)):1;
      const cost=d[2]*G.cell/uBase*drag;
      const nt=tk+cost;
      if(nt<t[kk]-1e-12){t[kk]=nt;heapPush(nt,kk);}
    }
  }
  return true;
}

/* ====================== MODEL B — Hele-Shaw pressure SOR ===================== */
// Returns iteration count; writes p, residual into S.res. Cancel-aware & chunked.
const SOR = {active:false,res:0,iters:0};
function setupHeleShaw(){
  const nx=G.nx,ny=G.ny,N=nx*ny,p=F.p,cav=G.cav;
  p.fill(0);
  const pinj=P.p_pinj*1e6;
  F.src.set(inletCells());
  // Dirichlet inlet p=p_inj; "front" cells = cavity cells touching non-cavity → p=0 open BC.
  for(let k=0;k<N;k++)if(F.src[k])p[k]=pinj;
  markFront();
  // conductance S=h²/(12η) [Hele-Shaw approximation, gap mm→m]. η from power-law w/ γ̇ estimate.
  updateEtaFromGrad();
  return pinj;
}
const FRONT=new Uint8Array(0);
let _front=null;
function markFront(){
  const nx=G.nx,ny=G.ny,N=nx*ny;
  if(!_front||_front.length!==N)_front=new Uint8Array(N);
  _front.fill(0);
  for(let j=0;j<ny;j++)for(let i=0;i<nx;i++){const k=j*nx+i;
    if(!G.cav[k])continue;
    // exposed to void/insert → atmospheric front
    if((i===0||!G.cav[k-1])||(i===nx-1||!G.cav[k+1])||(j===0||!G.cav[k-nx])||(j===ny-1||!G.cav[k+nx]))_front[k]=1;
  }
}
// η(x,y) from current |∇p|: γ̇ ≈ |u|·6/h with u=S|∇p| → simplified γ̇≈|∇p|·h/(2η_prev);
// we iterate: γ̇ = max(|∇p|·h_gap_m /(2·η_prev), 1e-3 s⁻¹)  [channel-flow shear-rate estimate]
function updateEtaFromGrad(){
  const nx=G.nx,ny=G.ny,h=P.p_hgap*1e-3; // gap in m
  const hm=G.cell*1e-3;                  // cell size in m
  for(let j=0;j<ny;j++)for(let i=0;i<nx;i++){
    const k=j*nx+i;
    if(!G.cav[k]){F.eta[k]=1;F.Scond[k]=0;continue;}
    const gx=((i+1<nx?F.p[k+1]:F.p[k])-(i>0?F.p[k-1]:F.p[k]))/(2*hm);
    const gy=((j+1<ny?F.p[k+nx]:F.p[k])-(j>0?F.p[k-nx]:F.p[k]))/(2*hm);
    const gmag=Math.hypot(gx,gy);         // Pa/m
    const gd=Math.max(gmag*h/(2*Math.max(F.eta[k]>1?F.eta[k]:1,1)),1e-3); // γ̇ s⁻¹ (uses prev η, one lag)
    const T=document.getElementById('p_noniso').checked?F.temp[k]:P.m_Tc;
    const eta=effEta(gd,T||P.m_Tc);
    F.eta[k]=eta;
    F.Scond[k]=(h*h)/(12*eta);            // S = h²/(12η)  [m]  (∇·(S∇p)=0 form after gap factor absorb)
  }
}
// red-black Gauss-Seidel with SOR ω=1.9 on ∇·(S∇p)=0 (harmonic-mean face conductances)
function sorSweep(pass){
  const nx=G.nx,ny=G.ny,p=F.p,S_=F.Scond,src=F.src,w=1.9;
  let res=0;
  for(let parity=pass;parity<2;parity++){
    for(let j=0;j<ny;j++)for(let i=((j+parity)&1);i<nx;i+=2){
      const k=j*nx+i;
      if(!G.cav[k]||src[k]||_front[k])continue;   // skip solid/Dirichlet/front
      const Sl=S_[k],Sr=S_[k+1],Su=S_[k-nx],Sd=S_[k+nx];
      const aE=(i+1<nx&&G.cav[k+1])?Math.sqrt(Sl*Sr):0;   // harmonic mean at faces; 0 → Neumann wall
      const aW=(i>0&&G.cav[k-1])?Math.sqrt(S_[k-1]*Sl):0;
      const aN=(j+1<ny&&G.cav[k+nx])?Math.sqrt(Sl*Sd):0;
      const aS=(j>0&&G.cav[k-nx])?Math.sqrt(Su*Sl):0;
      const denom=aE+aW+aN+aS;
      if(denom<=0)continue;
      const pn=(aE*p[k+1]+aW*p[k-1]+aN*p[k+nx]+aS*p[k-nx])/denom;
      const old=p[k];
      const np=old+w*(pn-old);                     // SOR relaxation
      p[k]=np;
      const r=denom*(np-old);res+=r*r;             // local residual contribution
    }
  }
  return Math.sqrt(res);
}
function sorRunAsync(done){
  // async chunked SOR: yields to event loop every 40 sweeps so UI stays live & cancel works
  const nx=G.nx,ny=G.ny,N=nx*ny;
  SOR.active=true;SOR.iters=0;SOR.res=1;
  let firstRes=-1;
  function chunk(){
    if(S.cancelFlag){SOR.active=false;done(false);return;}
    const end=Math.min(SOR.iters+40,P.p_maxit);
    for(;SOR.iters<end;SOR.iters++){
      sorSweep(0);sorSweep(1);
      if((SOR.iters%10)===9)updateEtaFromGrad();   // refresh η(γ̇) every 10 sweeps (lagged coupling)
    }
    // global residual norm
    let res=0,cnt=0;
    for(let k=0;k<N;k++){if(!G.cav[k]||F.src[k]||_front[k])continue;
      const i=k%nx,j=(k/nx)|0;
      const Sl=F.Scond[k];
      const aE=(i+1<nx&&G.cav[k+1])?Math.sqrt(Sl*F.Scond[k+1]):0;
      const aW=(i>0&&G.cav[k-1])?Math.sqrt(F.Scond[k-1]*Sl):0;
      const aN=(j+1<ny&&G.cav[k+nx])?Math.sqrt(Sl*F.Scond[k+nx]):0;
      const aS=(j>0&&G.cav[k-nx])?Math.sqrt(F.Scond[k-nx]*Sl):0;
      const r=aE*(F.p[k+1]-F.p[k])+aW*(F.p[k-1]-F.p[k])+aN*(F.p[k+nx]-F.p[k])+aS*(F.p[k-nx]-F.p[k]);
      res+=r*r;cnt++;}
    SOR.res=Math.sqrt(res/Math.max(cnt,1));
    if(firstRes<0)firstRes=SOR.res||1;
    setProg('SOR sweep '+SOR.iters+' · residual '+SOR.res.toExponential(1));
    if(SOR.iters>=P.p_maxit||SOR.res/firstRes<P.p_tol){SOR.active=false;done(true);return;}
    setTimeout(chunk,0);
  }
  chunk();
}

// Async wrapper for Model C: runs the march in time-chunks on a setTimeout loop
// so the UI stays responsive and S.cancelFlag can interrupt between chunks.
function vofMarchAsync(done){
  const CHUNK=80;                       // steps per slice
  const nx=G.nx,ny=G.ny,N=nx*ny,f=F.frac,t=F.t,cav=G.cav;
  f.fill(0);t.fill(Infinity);
  F.trap.fill(0);F.nTrap=0;
  for(let k=0;k<N;k++)if(F.src[k]){f[k]=1;t[k]=0;}
  const dt=P.p_dt;
  const steps=Math.max(2,Math.min(4000,Math.ceil(P.p_tmax/dt)));
  computeVelocity();
  let simT=0,s=0;
  if(!F.frac2||F.frac2.length!==N)F.frac2=new Float32Array(N);
  const nf=F.frac2;
  const gain=1.5;                                    // fill-rate gain [calibration constant]
  function slice(){
    if(S.cancelFlag){done(false);return;}
    const end=Math.min(s+CHUNK,steps);
    for(;s<end;s++){
      simT+=dt;
      if(document.getElementById('p_noniso').checked){
        // Newton cooling of filled cells toward mold temperature: T←Tm+(T−Tm)e^{−dt/τ}
        const decay=Math.exp(-dt/Math.max(P.p_cooltau,1e-6));
        for(let k=0;k<N;k++)if(f[k]>0)F.temp[k]=P.m_Tm+(F.temp[k]-P.m_Tm)*decay;
        updateEtaFromGrad();computeVelocity();       // re-couple viscosity to T & ∇p
      }
      // global speed renorm so max|u| ≈ 1.25·cell/dt (front advances ≤1.25 cells/step)
      let umax=1e-12;
      for(let k=0;k<N;k++)if(F.speed[k]>umax)umax=F.speed[k];
      const scale=Math.min(1,(1.25*G.cell/dt)/Math.max(umax,1e-9));
      nf.set(f);
      for(let j=0;j<ny;j++)for(let i=0;i<nx;i++){
        const k=j*nx+i;if(!cav[k]||F.src[k]||f[k]>=1)continue;
        // face velocities: average of adjacent cell vx/vy; sign convention >0 = into k
        let inflow=0,vv;
        if(i+1<nx&&cav[k+1]){vv=scale*(F.vx[k]+F.vx[k+1])*0.5; if(vv<0&&f[k+1]>0.02)inflow-=vv*f[k+1];}
        if(i>0&&cav[k-1])    {vv=scale*(F.vx[k]+F.vx[k-1])*0.5; if(vv>0&&f[k-1]>0.02)inflow+= vv*f[k-1];}
        if(j+1<ny&&cav[k+nx]){vv=scale*(F.vy[k]+F.vy[k+nx])*0.5;if(vv<0&&f[k+nx]>0.02)inflow-=vv*f[k+nx];}
        if(j>0&&cav[k-nx])   {vv=scale*(F.vy[k]+F.vy[k-nx])*0.5;if(vv>0&&f[k-nx]>0.02)inflow+= vv*f[k-nx];}
        const nv=f[k]+gain*Math.min(inflow,G.cell/dt)*dt/G.cell;   // ≤1-cell/step limiter
        nf[k]=nv>1?1:nv;
        if(nf[k]>=0.999&&t[k]===Infinity)t[k]=simT;
        else if(nf[k]>0.02&&t[k]===Infinity)t[k]=simT;  // contact time at first wetting
      }
      f.set(nf);
      // incremental air-trap detection (enclosed before being filled)
      for(let j=1;j<ny-1;j++)for(let i=1;i<nx-1;i++){
        const k=j*nx+i;
        if(cav[k]&&!F.trap[k]&&f[k]<0.05&&f[k-1]>0.9&&f[k+1]>0.9&&f[k-nx]>0.9&&f[k+nx]>0.9){F.trap[k]=1;F.nTrap++;}
      }
    }
    setProg('VOF step '+s+'/'+steps+' · t='+simT.toFixed(1)+'s');
    if(s>=steps){done(true);return;}
    setTimeout(slice,0);
  }
  slice();
}

// =============================================================================
// ===== FIELDS =====
// Post-processing: derived fields (velocity from time-of-flight, fiber, weld,
// temperature, cure, orientation tensor) + statistics. All vectorized over
// typed arrays; no allocations inside loops.
// =============================================================================

// velocity from fill-time gradient: front normal speed u = |∇t|⁻¹·1, direction −∇t
// (equivalent to Hele-Shaw front kinematics df/dt=|u|, see Parnarghi et al. approach)
function velocityFromTime(){
  const nx=G.nx,ny=G.ny,cav=G.cav,hm=G.cell*1e-3,t=F.t;
  for(let j=0;j<ny;j++)for(let i=0;i<nx;i++){
    const k=j*nx+i;
    if(!cav[k]||!isFinite(t[k])){F.vx[k]=0;F.vy[k]=0;F.speed[k]=0;continue;}
    const tl=isFinite(t[k-1])?t[k-1]:t[k]+20*hm;   // mirror-with-offset at unfilled edges
    const tr=isFinite(t[k+1])?t[k+1]:t[k]+20*hm;
    const td=isFinite(t[k-nx])?t[k-nx]:t[k]+20*hm;
    const tu=isFinite(t[k+nx])?t[k+nx]:t[k]+20*hm;
    const gx=(tr-tl)/(2*hm);                        // ∂t/∂x [s/m]
    const gy=(tu-td)/(2*hm);                        // ∂t/∂y [s/m]
    const g=Math.hypot(gx,gy);
    if(g<1e-9){F.vx[k]=0;F.vy[k]=0;F.speed[k]=0;continue;}
    const u=1/Math.max(g,1e-9);                       // front speed mm/s · 1/mm → s⁻¹ scale
    F.vx[k]=-gx*u;F.vy[k]=-gy*u;F.speed[k]=Math.hypot(F.vx[k],F.vy[k]);
  }
}

// fiber concentration: base vf + fountain-flow enrichment near walls & fronts
// c = vf·(1 + 0.6·e^{-(wd/2)})·(1 + 0.8·frontness) [heuristic SMC fiber migration]
function fiberField(){
  const N=G.nx*G.ny,cav=G.cav,t=F.t;
  for(let k=0;k<N;k++){
    if(!cav[k]){F.fiber[k]=0;continue;}
    const wd=Math.min(G.wallDist[k],6);
    let front=0;
    if(isFinite(t[k])){
      const nb=[t[k-1],t[k+1],t[k-G.nx],t[k+G.nx]];
      let dmin=1e9;for(const v of nb)if(isFinite(v))dmin=Math.min(dmin,Math.abs(v-t[k]));
      front=dmin<3*G.cell/Math.max(avgSpeed(),1e-6)?1:0;   // crude front proximity
    }
    F.fiber[k]=P.m_vf*(1+0.6*Math.exp(-wd/2))*(1+0.8*front);
  }
}
function avgSpeed(){let s=0,n=0;const N=G.nx*G.ny;for(let k=0;k<N;k++)if(F.speed[k]>0){s+=F.speed[k];n++;}return n?s/n:1;}

// weld lines: cell where ≥2 distinct fronts meet; strength decays with the
// arrival-time spread between competing fronts: σ_w ≈ exp(−Δt/τw),
// τw = 1.5·median fill time (larger Δt ⇒ weaker weld). [assumption]
// Front identity comes from a multi-source BFS that propagates inlet labels
// downhill in the fill-time field.
function weldField(){
  const nx=G.nx,ny=G.ny,N=nx*ny,cav=G.cav,t=F.t;
  F.weld.fill(0);F.weldStr.fill(0);F.nWeld=0;
  if(!F.lab)F.lab=new Int32Array(N);
  const lab=F.lab;
  lab.fill(-1);
  // seed labels: each inlet cell gets its own index id
  let lid=1;
  const q=new Int32Array(N);let qh=0,qt=0;
  for(let k=0;k<N;k++)if(F.src[k]){lab[k]=lid++;q[qt++]=k;}
  // BFS constrained to cavity cells, always expanding toward higher t neighbors
  while(qh<qt){
    const k=q[qh++];
    const i=k%nx,j=(k/nx)|0;
    const nb=[i>0?k-1:-1,i+1<nx?k+1:-1,j>0?k-nx:-1,j+1<ny?k+nx:-1];
    for(const kk of nb){
      if(kk<0||!cav[kk]||lab[kk]>=0||!isFinite(t[kk]))continue;
      if(t[kk]>=t[k]-1e-9){lab[kk]=lab[k];q[qt++]=kk;}   // follow increasing fill time
    }
  }
  const tauw=1.5*Math.max(medianFill(),0.5);
  for(let j=1;j<ny-1;j++)for(let i=1;i<nx-1;i++){
    const k=j*nx+i;if(!cav[k]||!isFinite(t[k])||lab[k]<0)continue;
    let diff=0,cnt=0;
    const nb=[lab[k+1],lab[k-1],lab[k-nx],lab[k+nx]];
    const tt=[t[k+1],t[k-1],t[k-nx],t[k+nx]];
    for(let n=0;n<4;n++){
      const q2=nb[n];
      if(q2>=0&&q2!==lab[k]){cnt++;diff=Math.max(diff,Math.abs(tt[n]-t[k]));}
    }
    if(cnt>=2){                          // meeting line of ≥2 fronts
      F.weld[k]=1;F.nWeld++;
      F.weldStr[k]=Math.exp(-diff/tauw);  // 1 = strong fusion, →0 weak weld
    }
  }
}
function medianFill(){
  const arr=[];const N=G.nx*G.ny;
  for(let k=0;k<N;k++)if(G.cav[k]&&isFinite(F.t[k]))arr.push(F.t[k]);
  if(!arr.length)return 0;arr.sort((a,b)=>a-b);return arr[arr.length>>1];
}

// Temperature field: filled cells cool exponentially in time from T_charge→T_mold.
// T(x,y,t)=Tm+(Tc−Tm)·exp(−t_filled/τ). Non-iso off → uniform Tc. [Newton cooling]
function tempField(){
  const N=G.nx*G.ny;
  if(!document.getElementById('p_noniso').checked){F.temp.fill(P.m_Tc);return;}
  const tau=Math.max(P.p_cooltau,1e-6);
  for(let k=0;k<N;k++){
    if(!G.cav[k]){F.temp[k]=P.m_Tm;continue;}
    const tf=isFinite(F.t[k])?F.t[k]:P.p_tmax;
    const dwell=Math.max(S.tCur-tf,0);       // time since that cell was filled
    F.temp[k]=P.m_Tm+(P.m_Tc-P.m_Tm)*Math.exp(-dwell/tau);
  }
}

// Cure: first-order kinetics integrated over the cell's dwell time analytically
// for isothermal k: α(t)=1−exp(−k·t_dwell); k=k0·exp(−Ea/(R·T)) [Arrhenius cure].
function cureField(){
  const N=G.nx*G.ny;
  for(let k=0;k<N;k++){
    if(!G.cav[k]||!isFinite(F.t[k])){F.cure[k]=0;continue;}
    const dwell=Math.max(S.tCur-F.t[k],0);
    const TK=F.temp[k]+273.15;
    const kc=P.m_k0*Math.exp(-P.m_Ea/(R_GAS*TK));
    F.cure[k]=1-Math.exp(-kc*dwell);          // exact integral of dα/dt=k(1−α)
  }
}

// Fiber orientation: advance 2D tensor A with local velocity gradient L plus
// Folgar–Tucker isotropic diffusion:
//   dA/dt = L·A + A·Lᵀ − 2Cl·Ġ·(A − I/3|2D) ; 2D closure: tr(A)=1 enforced.
// Integrated as explicit Euler over sim time steps at solve time (coarse, stable
// because diffusion term dominates at low shear). [Folgar-Tucker 1984, simplified]
function orientField(){
  const nx=G.nx,ny=G.ny,N=nx*ny,cav=G.cav;
  // init planar-random
  for(let k=0;k<N;k++){F.a11[k]=0.5;F.a22[k]=0.5;F.a12[k]=0;}
  const Cl=P.m_ctk;
  const hm=G.cell*1e-3;
  const dtSub=Math.max(P.p_dt,0.05);
  const steps=Math.max(1,Math.min(200,Math.ceil(Math.min(S.tCur,P.p_tmax)/dtSub)));
  for(let s=0;s<steps;s++){
    if(S.cancelFlag)break;
    for(let j=1;j<ny-1;j++)for(let i=1;i<nx-1;i++){
      const k=j*nx+i;if(!cav[k]||!isFinite(F.t[k])||F.t[k]>s*dtSub)continue;
      // velocity gradient L_ab = ∂u_a/∂x_b (mm/s per mm)
      const dudx=(F.vx[k+1]-F.vx[k-1])/(2*G.cell), dudy=(F.vx[k+nx]-F.vx[k-nx])/(2*G.cell);
      const dvdx=(F.vy[k+1]-F.vy[k-1])/(2*G.cell), dvdy=(F.vy[k+nx]-F.vy[k-nx])/(2*G.cell);
      const a11=F.a11[k],a22=F.a22[k],a12=F.a12[k];
      const gdot=Math.hypot(dudx,dudy,dvdx,dvdy)||1e-6;
      // Jeffery terms (2D): dA = LA + A Lᵀ
      const d11=2*(dudx*a11+dudy*a12);
      const d22=2*(dvdy*a22+dvdx*a12);
      const d12=dudx*a12+dudy*a22+dvdx*a11+dvdy*a12;
      // FT diffusion relaxes toward isotropic I/2 in 2D with rate 2Cl·Ġ
      const rel=2*Cl*gdot*1e-3;                 // Ġ scaled (per-mm→per-m consistency heuristic)
      let n11=a11+dtSub*(d11-rel*(a11-0.5));
      let n22=a22+dtSub*(d22-rel*(a22-0.5));
      let n12=a12+dtSub*(d12-rel*a12);
      // enforce trace 1 and physical eigenvalues (clamp)
      const tr=n11+n22;n11/=tr;n22/=tr;n12/=tr;
      const mid=(n11+n22)/2,diff=Math.hypot((n11-n22)/2,n12);
      const l1=mid+diff,l2=mid-diff;
      if(l2<0){const sc=Math.max(l1,1e-6)/ (l1+l2||1);n11*=sc;n22*=sc;n12*=sc;}
      F.a11[k]=n11;F.a22[k]=n22;F.a12[k]=n12;
    }
  }
}

// ---- statistics / histogram ----
function buildHistogram(){
  const N=G.nx*G.ny,H=F.hist;H.fill(0);
  let tmax=0;
  for(let k=0;k<N;k++)if(G.cav[k]&&isFinite(F.t[k]))tmax=Math.max(tmax,F.t[k]);
  F.tFillMax=tmax;
  if(tmax>0)for(let k=0;k<N;k++)if(G.cav[k]&&isFinite(F.t[k]))
    H[Math.min(63,(F.t[k]/tmax*63)|0)]++;
}
function computeStats(){
  const N=G.nx*G.ny;
  buildHistogram();
  F.pMax=0;let pSum=0,cavN=0,a11sum=0,a11n=0,maxCure=0;
  F.unfilled.fill(0);F.nUnf=0;
  for(let k=0;k<N;k++){
    if(!G.cav[k])continue;cavN++;
    if(F.p[k]>F.pMax)F.pMax=F.p[k];
    pSum+=Math.max(F.p[k],0);
    if(!isFinite(F.t[k])||F.t[k]>S.tCur){F.unfilled[k]=1;F.nUnf++;}
    if(isFinite(F.t[k])){a11sum+=Math.abs(F.a11[k]-0.5)+Math.abs(F.a12[k]);a11n++;}
    if(F.cure[k]>maxCure)maxCure=F.cure[k];
  }
  const areaCell=(G.cell*1e-3)**2;              // m²
  // Clamp force ≈ ∫p dA over cavity projected area [engineering estimate]
  F.clampKN=pSum/N*cavN*areaCell/1000;
  // squeeze-flow add-on: F_sq≈3ηV R²/(2h³) (Stefan equation, disk approx.) [Stefan 1874]
  const Rchar=Math.sqrt(cavN*areaCell/Math.PI);
  const hM3=Math.pow(P.p_hgap*1e-3,3);
  const fSq=3*P.m_eta0*(P.p_vc*1e-3)*Rchar*Rchar/(2*Math.max(hM3,1e-12))/1000;
  F.clampKN+=Math.min(fSq,F.clampKN*0.5+fSq*0.0); // reported separately below
  F.squeezeKN=fSq;
  F.meanAniso=a11n?a11sum/a11n:0;
  F.maxCure=maxCure;
  F.cavN=cavN;
}

// =============================================================================
// ===== RENDER =====
// Smooth bilinear field renderer into an offscreen ImageData (reused buffer),
// then blitted scaled to the visible canvas. Colormaps are 256-entry LUTs.
// =============================================================================

// ---- colormap LUTs (RGB triples packed in Uint8Array(768)) ----
function lerp(a,b,t){return a+(b-a)*t;}
function makeLUT(stops){ // stops: [[pos,[r,g,b]],...] piecewise-linear
  const lut=new Uint8Array(768);
  for(let i=0;i<256;i++){
    const t=i/255;let k=0;
    while(k<stops.length-2&&t>stops[k+1][0])k++;
    const [p0,c0]=stops[k],[p1,c1]=stops[k+1];
    const f=Math.min(1,Math.max(0,(t-p0)/(p1-p0||1)));
    lut[i*3]=lerp(c0[0],c1[0],f)|0;lut[i*3+1]=lerp(c0[1],c1[1],f)|0;lut[i*3+2]=lerp(c0[2],c1[2],f)|0;
  }
  return lut;
}
const CMAPS={
  jet:makeLUT([[0,[0,0,127]],[.125,[0,0,255]],[.375,[0,255,255]],[.625,[255,255,0]],[.875,[255,0,0]],[1,[127,0,0]]]),
  viridis:makeLUT([[0,[68,1,84]],[.25,[59,82,139]],[.5,[33,145,140]],[.75,[94,201,98]],[1,[253,231,37]]]),
  magma:makeLUT([[0,[0,0,4]],[.25,[80,18,123]],[.5,[183,55,121]],[.75,[252,137,97]],[1,[252,253,191]]]),
  turbo:makeLUT([[0,[48,18,59]],[.25,[78,174,239]],[.5,[24,224,122]],[.75,[250,167,44]],[1,[122,4,3]]]),
  gray:makeLUT([[0,[0,0,0]],[1,[255,255,255]]]),
  div:makeLUT([[0,[33,102,172]],[.35,[178,223,251]],[.5,[247,247,247]],[.65,[254,204,149]],[1,[214,96,33]]]), // RdBu-like diverging
};
function activeLUT(){return CMAPS[document.getElementById('v_cmap').value]||CMAPS.jet;}

// ---- per-view field accessor: returns {arr, vmin, vmax, unit, fmt} ----
function fieldFor(mode){
  const N=G.nx*G.ny;
  switch(mode){
    case 'fill':{let mx=0;for(let k=0;k<N;k++)if(G.cav[k]&&isFinite(F.t[k]))mx=Math.max(mx,F.t[k]);
      return{arr:F.t,vmin:0,vmax:Math.max(mx,1e-3),unit:'s',mask:true};}
    case 'pressure':{let mx=F.pMax||1;return{arr:F.p,vmin:0,vmax:mx/1e6,unit:'MPa',scale:1e-6,mask:true};}
    case 'fiber':return{arr:F.fiber,vmin:0,vmax:Math.max(P.m_vf*2.5,0.05),unit:'',mask:true};
    case 'weld':{const w=F._wl||(F._wl=new Float32Array(N));   // cached scratch buffer
      for(let k=0;k<N;k++)w[k]=F.weld[k]?F.weldStr[k]:NaN;
      return{arr:w,vmin:0,vmax:1,unit:'σ',mask:false,isWeld:true};}
    case 'velocity':{let mx=0;for(let k=0;k<N;k++)mx=Math.max(mx,F.speed[k]);
      return{arr:F.speed,vmin:0,vmax:Math.max(mx,1e-4),unit:'mm/s',mask:true};}
    case 'temp':{return{arr:F.temp,vmin:Math.min(P.m_Tm,P.m_Tc)-2,vmax:Math.max(P.m_Tm,P.m_Tc)+2,unit:'°C',mask:true};}
    case 'cure':return{arr:F.cure,vmin:0,vmax:1,unit:'α',mask:true};
    case 'orient':{const w=F._or||new Float32Array(N);F._or=w;
      for(let k=0;k<N;k++)w[k]=F.a11[k]-F.a22[k];   // signed anisotropy → diverging map
      return{arr:w,vmin:-0.5,vmax:0.5,unit:'A11−A22',mask:true,divOk:true};}
  }
  return{arr:F.t,vmin:0,vmax:1,unit:'',mask:true};
}

// ---- offscreen raster image (nx×ny pixels) reused across frames ----
let imgBuf=null,imgData=null,fieldCanvas=null,fieldCtx=null;
function ensureImage(nx,ny){
  if(!fieldCanvas){fieldCanvas=document.createElement('canvas');fieldCtx=fieldCanvas.getContext('2d');}
  if(fieldCanvas.width!==nx||fieldCanvas.height!==ny){
    fieldCanvas.width=nx;fieldCanvas.height=ny;imgData=fieldCtx.createImageData(nx,ny);imgBuf=imgData.data;
  }
}

// Bilinear sample of a cell-centered grid at fractional (fx,fy) grid coords.
// NaN/Infinity neighbors are replaced by nearest valid value (front-safe).
function bilin(arr,nx,ny,fx,fy){
  let x=Math.max(0,Math.min(nx-1.001,fx)),y=Math.max(0,Math.min(ny-1.001,fy));
  const i=x|0,j=y|0,tx=x-i,ty=y-j;
  const v00=arr[j*nx+i],v10=arr[j*nx+i+1],v01=arr[(j+1)*nx+i],v11=arr[(j+1)*nx+i+1];
  const ok=v=>isFinite(v)?v:null;
  const a=ok(v00),b=ok(v10),c=ok(v01),d=ok(v11);
  if(a===null&&b===null&&c===null&&d===null)return NaN;
  const A=a!==null?a:(b!==null?b:(c!==null?c:d));
  const B=b!==null?b:A,C=c!==null?c:A,D=d!==null?d:(A+B+C)/3;
  return lerp(lerp(A,B,tx),lerp(C,D,tx),ty);
}

// main field paint into imgBuf; viewMode selects field; time cut masks unfilled cells
function paintField(viewMode,lut,timeCut,smooth){
  const nx=G.nx,ny=G.ny,fld=fieldFor(viewMode);
  const arr=fld.arr,sc=fld.scale||1,inv=1/(fld.vmax-fld.vmin||1);
  const data=imgBuf;
  const weldNaN=fld.isWeld;   // weld scratch buffer already holds NaN off-weld
  for(let j=0;j<ny;j++){
    const rowBase=j*nx;
    for(let i=0;i<nx;i++){
      const k=rowBase+i,pix=k*4;
      if(!G.cav[k]){ // void & inserts: dark backdrop with subtle checker
        const chk=((i>>3)+(j>>3))&1;data[pix]=chk?14:17;data[pix+1]=chk?18:21;data[pix+2]=chk?22:26;data[pix+3]=255;continue;
      }
      let v=smooth?bilin(arr,nx,ny,i,j):arr[k];
      if(!isFinite(v)){data[pix]=16;data[pix+1]=20;data[pix+2]=26;data[pix+3]=255;continue;}
      // time cutoff: not-yet-filled region strongly dimmed (front animation)
      if(timeCut!=null&&F.t[k]>timeCut&&!F.src[k])v*=0.12;
      let tn=(v*sc-fld.vmin)*inv;tn=tn<0?0:tn>1?1:tn;
      const li=(tn*255)|0;
      data[pix]=lut[li*3];data[pix+1]=lut[li*3+1];data[pix+2]=lut[li*3+2];data[pix+3]=255;
    }
  }
  fieldCtx.putImageData(imgData,0,0);
  return fld;
}

// =============================================================================
// Main draw: world↔screen transform, field blit, overlays, gizmos.
// =============================================================================
let cv=null,ctx=null,dpr=1;
let _w2sx=0,_w2sy=0,_w2px=0,_w2py=0;   // cached transform for this frame
function updateXform(){
  const cw=cv.width/dpr,ch=cv.height/dpr;
  _w2px=cw/2;_w2py=ch/2;
  _w2sx=S.view.scale;_w2sy=-S.view.scale;
}
function W2S(mx,my){ // model→screen px (y up in model space)
  return [ (mx-S.view.cx)*_w2sx + _w2px, (my-S.view.cy)*_w2sy + _w2py ];
}
function S2W(px,py){
  return [ (px - _w2px)/_w2sx + S.view.cx, -(py - _w2py)/_w2sy + S.view.cy ];
}

function draw(){
  if(!cv)return;
  updateXform();
  const cw=cv.width/dpr,ch=cv.height/dpr;
  ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.clearRect(0,0,cw,ch);
  ctx.fillStyle='#0a0d11';ctx.fillRect(0,0,cw,ch);
  if(!G.cav||!F.t){drawEmptyNote(cw,ch);return;}
  const nx=G.nx,ny=G.ny;
  // screen rect of the raster domain
  const [x0,y0]=W2S(G.ox,G.oy+ny*G.cell);       // top-left (model y up)
  const [x1,y1]=W2S(G.ox+nx*G.cell,G.oy);       // bottom-right
  const rw=x1-x0,rh=y1-y0;
  const smooth=document.getElementById('v_smooth').checked;
  const mode=document.getElementById('v_mode').value;
  const compare=document.getElementById('v_compare').checked;
  ensureImage(nx,ny);
  const lut=activeLUT();
  const tcut=S.tCur>=P.p_tmax-1e-6?null:S.tCur;
  if(compare){
    // left half = current mode, right half = compare mode (clipped blits)
    paintField(mode,lut,tcut,smooth);
    ctx.save();ctx.beginPath();ctx.rect(x0,y0,rw/2,rh);ctx.clip();
    ctx.imageSmoothingEnabled=smooth;ctx.drawImage(fieldCanvas,x0,y0,rw,rh);ctx.restore();
    const mode2=document.getElementById('v_mode2').value;
    paintField(mode2,lut,tcut,smooth);
    ctx.save();ctx.beginPath();ctx.rect(x0+rw/2,y0,rw/2,rh);ctx.clip();
    ctx.imageSmoothingEnabled=smooth;ctx.drawImage(fieldCanvas,x0,y0,rw,rh);ctx.restore();
    ctx.strokeStyle='#37b6ff';ctx.beginPath();ctx.moveTo(x0+rw/2,y0);ctx.lineTo(x0+rw/2,y1);ctx.stroke();
    ctx.fillStyle='#cfd8e3';ctx.font='11px sans-serif';
    ctx.fillText(mode+' (left)',x0+4,y0+12);ctx.fillText(mode2+' (right)',x0+rw/2+4,y0+12);
  } else {
    paintField(mode,lut,tcut,smooth);
    ctx.imageSmoothingEnabled=smooth;
    ctx.drawImage(fieldCanvas,x0,y0,rw,rh);
  }
  drawOverlays(x0,y0,x1,y1,rw,rh,nx,ny);
  drawShapeOutlines();
  drawGates();
  drawSelection();
  drawSnapGuides();
  drawRubber();
  drawColorbar(cw,ch);
}

function drawEmptyNote(cw,ch){
  ctx.fillStyle='#8494a7';ctx.font='13px sans-serif';ctx.textAlign='center';
  ctx.fillText('Add a cavity shape and press ▶ Run Solve (R)',cw/2,ch/2);ctx.textAlign='left';
}

// ---- hatch pattern cache (avoid per-frame creation) ----
let hatchRed=null,hatchBlue=null;
function hatches(){
  if(hatchRed)return;
  const mk=(col)=>{const c=document.createElement('canvas');c.width=c.height=8;const g=c.getContext('2d');
    g.strokeStyle=col;g.lineWidth=1.4;g.beginPath();g.moveTo(-2,10);g.lineTo(10,-2);g.moveTo(-2,2);g.lineTo(2,-2);g.stroke();
    return ctx.createPattern(c,'repeat');};
  hatchRed=mk('rgba(255,60,50,.85)');hatchBlue=mk('rgba(80,150,255,.7)');
}
function cellRect(i,j,x0,y0,rw,rh,nx,ny){
  const cs=rw/nx;return[x0+i*cs,y0+j*(rh/ny),cs,rh/ny];
}

function drawOverlays(x0,y0,x1,y1,rw,rh,nx,ny){
  hatches();
  const csx=rw/nx,csy=rh/ny;
  // short-shot (never filled by t_max): blue hatch
  if(document.getElementById('v_short').checked){
    ctx.fillStyle=hatchBlue;
    for(let j=0;j<ny;j++)for(let i=0;i<nx;i++){const k=j*nx+i;
      if(G.cav[k]&&!isFinite(F.t[k]))ctx.fillRect(x0+i*csx,y0+j*csy,csx,csy);}
  }
  // air traps: red hatch
  if(document.getElementById('v_traps').checked){
    ctx.fillStyle=hatchRed;
    for(let j=0;j<ny;j++)for(let i=0;i<nx;i++){const k=j*nx+i;
      if(F.trap[k])ctx.fillRect(x0+i*csx,y0+j*csy,csx,csy);}
  }
  // cure overlay: orange alpha proportional to α
  if(document.getElementById('v_cureov').checked){
    for(let j=0;j<ny;j++)for(let i=0;i<nx;i++){const k=j*nx+i;
      if(G.cav[k]&&F.cure[k]>0.03){
        ctx.fillStyle='rgba(255,140,40,'+(0.55*Math.min(F.cure[k],1))+')';
        ctx.fillRect(x0+i*csx,y0+j*csy,csx,csy);}
    }
  }
  // weld lines colored by strength (green strong → red weak); thicker where possible
  if(document.getElementById('v_weldln').checked){
    ctx.lineWidth=Math.max(1.6,csx*1.3);ctx.lineCap='round';
    for(let j=0;j<ny;j++)for(let i=0;i<nx;i++){const k=j*nx+i;
      if(F.weld[k]){
        const s=F.weldStr[k];
        ctx.strokeStyle='rgb('+((1-s)*255|0)+','+(s*220|0)+',60)';
        const cxp=x0+i*csx+csx/2,cyp=y0+j*csy+csy/2;
        ctx.beginPath();ctx.moveTo(cxp-0.02,cyp);ctx.lineTo(cxp+0.02,cyp);ctx.stroke();  // dot per cell
      }}
    ctx.lineCap='butt';
  }
  // iso-contours via marching squares on the current field
  const ncont=P.v_cont|0;
  if(ncont>0){
    const fld=fieldFor(document.getElementById('v_mode').value);
    drawContours(fld,ncont,x0,y0,rw,rh,nx,ny);
  }
  // velocity arrows / streamlines
  if(document.getElementById('v_vec').checked)drawArrows(x0,y0,rw,rh,nx,ny);
  if(document.getElementById('v_stream').checked)drawStreamlines(x0,y0,rw,rh,nx,ny);
  if(document.getElementById('v_glyph').checked)drawGlyphs(x0,y0,rw,rh,nx,ny);
  // grid lines
  if(document.getElementById('v_grid').checked&&csx>3){
    ctx.strokeStyle='rgba(255,255,255,.08)';ctx.lineWidth=1;ctx.beginPath();
    for(let i=0;i<=nx;i+=Math.max(1,(nx/40)|0)){ctx.moveTo(x0+i*csx,y0);ctx.lineTo(x0+i*csx,y1);}
    for(let j=0;j<=ny;j+=Math.max(1,(ny/40)|0)){ctx.moveTo(x0,y0+j*csy);ctx.lineTo(x1,y0+j*csy);}
    ctx.stroke();
  }
}

// Marching-squares iso-lines of a scalar grid (linear edge interpolation).
function drawContours(fld,nlev,x0,y0,rw,rh,nx,ny){
  const arr=fld.arr,sc=fld.scale||1;
  const csx=rw/nx,csy=rh/ny;
  const label=document.getElementById('v_contlab').checked;
  ctx.strokeStyle='rgba(255,255,255,.55)';ctx.lineWidth=1;ctx.fillStyle='rgba(255,255,255,.8)';ctx.font='9px sans-serif';
  for(let li=1;li<=nlev;li++){
    const lev=fld.vmin+(fld.vmax-fld.vmin)*li/(nlev+1);
    ctx.beginPath();
    let labeled=false;
    for(let j=0;j<ny-1;j++)for(let i=0;i<nx-1;i++){
      const k=j*nx+i;
      const v00=arr[k]*sc,v10=arr[k+1]*sc,v01=arr[k+nx]*sc,v11=arr[k+nx+1]*sc;
      if(!isFinite(v00)||!isFinite(v10)||!isFinite(v01)||!isFinite(v11))continue;
      let idx=0;if(v00>lev)idx|=8;if(v10>lev)idx|=4;if(v11>lev)idx|=2;if(v01>lev)idx|=1;
      if(idx===0||idx===15)continue;
      const X=x0+i*csx,Y=y0+j*csy;
      const ip=(va,vb)=>(lev-va)/(vb-va||1e-12);
      const eT=[X+ip(v00,v10)*csx,Y],eR=[X+csx,Y+ip(v10,v11)*csy],eB=[X+ip(v01,v11)*csx,Y+csy],eL=[X,Y+ip(v00,v01)*csy];
      const seg=(a,b)=>{ctx.moveTo(a[0],a[1]);ctx.lineTo(b[0],b[1]);};
      switch(idx){
        case 1:case 14:seg(eL,eB);break;
        case 2:case 13:seg(eB,eR);break;
        case 3:case 12:seg(eL,eR);break;
        case 4:case 11:seg(eT,eR);break;
        case 7:case 8:seg(eL,eT);break;
        case 5:seg(eL,eT);seg(eB,eR);break;
        case 10:seg(eL,eB);seg(eT,eR);break;
        case 6:seg(eT,eB);seg(eL,eR);break;
        case 9:seg(eT,eR);seg(eL,eB);break;
      }
      if(label&&!labeled&&li%2===1){ctx.fillText(fmtVal(lev,fld.unit),X+csx,Y);labeled=true;}
    }
    ctx.stroke();
  }
}

function fmtVal(v,u){
  const a=Math.abs(v);
  let s=a>=1000?(v/1000).toFixed(1)+'k':a>=100?v.toFixed(0):a>=1?v.toFixed(1):a>=0.01?v.toFixed(3):v.toExponential(1);
  return s+(u?' '+u:'');
}

// velocity arrows on subsampled grid
function drawArrows(x0,y0,rw,rh,nx,ny){
  const step=Math.max(2,(nx/34)|0),csx=rw/nx,csy=rh/ny;
  let mx=1e-9;for(let k=0;k<nx*ny;k++)mx=Math.max(mx,F.speed[k]);
  ctx.strokeStyle='rgba(255,255,255,.75)';ctx.fillStyle='rgba(255,255,255,.75)';ctx.lineWidth=1;
  for(let j=step>>1;j<ny;j+=step)for(let i=step>>1;i<nx;i+=step){
    const k=j*nx+i;if(!G.cav[k]||F.speed[k]<=0)continue;
    const L=Math.min(csx*step*0.9,csx*step*(F.speed[k]/mx)*2.2);
    const ux=F.vx[k]/F.speed[k],uy=-F.vy[k]/F.speed[k];  // screen y is flipped
    const X=x0+i*csx+csx/2,Y=y0+j*csy+csy/2;
    arrow(X,Y,X+ux*L,Y+uy*L);
  }
}
function arrow(x0,y0,x1,y1){
  ctx.beginPath();ctx.moveTo(x0,y0);ctx.lineTo(x1,y1);ctx.stroke();
  const a=Math.atan2(y1-y0,x1-x0),s=3.2;
  ctx.beginPath();ctx.moveTo(x1,y1);
  ctx.lineTo(x1-s*Math.cos(a-0.5),y1-s*Math.sin(a-0.5));
  ctx.lineTo(x1-s*Math.cos(a+0.5),y1-s*Math.sin(a+0.5));
  ctx.closePath();ctx.fill();
}

// streamlines: RK2 integration along normalized velocity, seeds on density grid
function drawStreamlines(x0,y0,rw,rh,nx,ny){
  const d=Math.max(2,P.v_seed|0),csx=rw/nx,csy=rh/ny;
  ctx.strokeStyle='rgba(120,220,255,.6)';ctx.lineWidth=1.1;
  const sx=nx/d,sy=ny/d;
  for(let a=0;a<d;a++)for(let b=0;b<d;b++){
    let gx=(a+0.5)*sx,gy=(b+0.5)*sy;
    ctx.beginPath();let started=false;
    for(let st=0;st<120;st++){                     // fixed-length trace (deterministic)
      const i=gx|0,j=gy|0;if(i<1||j<1||i>=nx-1||j>=ny-1||!G.cav[j*nx+i])break;
      const k=j*nx+i;const sp=F.speed[k];if(sp<=1e-9)break;
      const vx=F.vx[k]/sp,vy=-F.vy[k]/sp;
      const px=x0+gx*csx,py=y0+gy*csy;
      if(!started){ctx.moveTo(px,py);started=true;}else ctx.lineTo(px,py);
      // RK2 midpoint step
      const hx=gx+vx*sx*0.5,hy=gy+vy*sy*0.5;
      const ki=(hy|0)*nx+(hx|0);
      if(ki<0||ki>=nx*ny||!G.cav[ki]||F.speed[ki]<=1e-9)break;
      const nvx=F.vx[ki]/F.speed[ki],nvy=-F.vy[ki]/F.speed[ki];
      gx+=nvx*sx;gy+=nvy*sy;
    }
    ctx.stroke();
    // arrowhead at end
    if(started){const ex=x0+gx*csx,ey=y0+gy*csy;ctx.fillStyle='rgba(120,220,255,.8)';
      ctx.beginPath();ctx.arc(ex,ey,1.8,0,6.29);ctx.fill();}
  }
}

// orientation glyphs: dashes along principal eigenvector of A
function drawGlyphs(x0,y0,rw,rh,nx,ny){
  const step=Math.max(3,(nx/26)|0),csx=rw/nx,csy=rh/ny;
  ctx.strokeStyle='rgba(255,235,120,.85)';ctx.lineWidth=1.3;
  for(let j=step>>1;j<ny;j+=step)for(let i=step>>1;i<nx;i+=step){
    const k=j*nx+i;if(!G.cav[k]||!isFinite(F.t[k]))continue;
    const th=0.5*Math.atan2(2*F.a12[k],F.a11[k]-F.a22[k]);   // principal angle of 2D tensor
    const L=csx*step*0.42*(0.4+Math.abs(F.a11[k]-F.a22[k]));
    const cxp=x0+i*csx+csx/2,cyp=y0+j*csy+csy/2;
    ctx.beginPath();ctx.moveTo(cxp-Math.cos(th)*L,cyp+Math.sin(th)*L);
    ctx.lineTo(cxp+Math.cos(th)*L,cyp-Math.sin(th)*L);ctx.stroke();
  }
}

function drawShapeOutlines(){
  if(!document.getElementById('v_shapes').checked)return;
  ctx.lineWidth=1.4;
  for(const sh of S.shapes){
    const col=sh.role==='cavity'?'#37b6ff':sh.role==='insert'?'#ffb454':'#4dd08a';
    ctx.strokeStyle=col;
    for(const ring of shapeOutline(sh,64)){
      ctx.beginPath();let first=true;
      for(const p of ring){const [sx,sy]=W2S(p[0],p[1]);if(first){ctx.moveTo(sx,sy);first=false;}else ctx.lineTo(sx,sy);}
      if(sh.type!=='path')ctx.closePath();
      ctx.stroke();
    }
  }
}
function drawGates(){
  ctx.fillStyle='#4dd08a';ctx.strokeStyle='#0a0d11';
  for(const g of S.gates){
    const [sx,sy]=W2S(g.x,g.y);
    ctx.beginPath();ctx.moveTo(sx,sy-6);ctx.lineTo(sx+6,sy);ctx.lineTo(sx,sy+6);ctx.lineTo(sx-6,sy);ctx.closePath();
    ctx.fill();ctx.stroke();
  }
}
function drawSelection(){
  if(!S.sel.size)return;
  ctx.strokeStyle='#37b6ff';ctx.setLineDash([4,3]);ctx.lineWidth=1;
  for(const sh of selShapes()){
    const b=shapeAABB(sh);
    const [x0,y0]=W2S(b.x0,b.y1),[x1,y1]=W2S(b.x1,b.y0);
    ctx.strokeRect(x0,y0,x1-x0,y1-y0);
    // resize handles (corners)
    ctx.setLineDash([]);ctx.fillStyle='#37b6ff';
    for(const c of [[x0,y0],[x1,y0],[x1,y1],[x0,y1]])ctx.fillRect(c[0]-3,c[1]-3,6,6);
    // rotate gizmo above top-center
    const rx=(x0+x1)/2,ry=y0-18;
    ctx.beginPath();ctx.moveTo(rx,y0);ctx.lineTo(rx,ry+6);ctx.stroke();
    ctx.beginPath();ctx.arc(rx,ry,5,0,6.29);ctx.fill();
    ctx.setLineDash([4,3]);
  }
  ctx.setLineDash([]);
}
function drawSnapGuides(){
  if(!S.snapGuides.length)return;
  ctx.strokeStyle='rgba(255,90,220,.8)';ctx.lineWidth=1;ctx.setLineDash([2,3]);
  for(const g of S.snapGuides){
    const [x0,y0]=W2S(g.x1,g.y2),[x1,y1]=W2S(g.x2,g.y1);
    ctx.beginPath();ctx.moveTo(x0,y0);ctx.lineTo(x1,y1);ctx.stroke();
  }
  ctx.setLineDash([]);
}

// ---- colorbar with numeric ticks (bottom-left of canvas) ----
function drawColorbar(cw,ch){
  const fld=fieldFor(document.getElementById('v_mode').value);
  const bx=14,by=ch-46,bw=Math.min(240,cw*0.35),bh=12;
  const lut=activeLUT();
  for(let i=0;i<bw;i++){
    const li=(i/bw*255)|0;
    ctx.fillStyle='rgb('+lut[li*3]+','+lut[li*3+1]+','+lut[li*3+2]+')';
    ctx.fillRect(bx+i,by,1,bh);
  }
  ctx.strokeStyle='#2a3542';ctx.strokeRect(bx,by,bw,bh);
  ctx.fillStyle='#cfd8e3';ctx.font='10px sans-serif';
  const nt=5;
  for(let i=0;i<nt;i++){
    const f=i/(nt-1),v=fld.vmin+f*(fld.vmax-fld.vmin),X=bx+f*bw;
    ctx.beginPath();ctx.moveTo(X,by+bh);ctx.lineTo(X,by+bh+3);ctx.strokeStyle='#8494a7';ctx.stroke();
    ctx.textAlign=i===0?'left':i===nt-1?'right':'center';
    ctx.fillText(fmtVal(v,fld.unit),X,by+bh+13);
  }
  ctx.textAlign='left';
  ctx.fillText(fld.unit||'',bx+bw+6,by+10);
}

// =============================================================================
// ===== IO =====
// Project JSON save/load (schema-versioned), PNG & CSV export, presets.
// =============================================================================
const SCHEMA_VER = 2;

function projectJSON(){
  return {
    schema: SCHEMA_VER, app:'smc-compression-molding-sim', created:new Date().toISOString(),
    shapes:S.shapes, gates:S.gates, params:{...P},
    ui:{model:document.getElementById('p_model').value,cmap:document.getElementById('v_cmap').value,
        mode:document.getElementById('v_mode').value,noniso:document.getElementById('p_noniso').checked}
  };
}
function downloadBlob(blob,name){
  const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=name;
  document.body.appendChild(a);a.click();setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove();},400);
}
function saveProject(){
  downloadBlob(new Blob([JSON.stringify(projectJSON(),null,1)],{type:'application/json'}),'smc-project.json');
  setMsg('Project saved');
}
function validateProject(o){
  const errs=[];
  if(!o||typeof o!=='object')return['Not a JSON object'];
  if(typeof o.schema!=='number')errs.push('missing schema version');
  else if(o.schema>SCHEMA_VER)errs.push('schema v'+o.schema+' newer than supported v'+SCHEMA_VER);
  if(!Array.isArray(o.shapes))errs.push('shapes must be an array');
  else o.shapes.forEach((s,i)=>{
    if(!s||typeof s!=='object'){errs.push('shape '+i+' not object');return;}
    if(!['rect','rrect','circle','ellipse','annulus','npoly','poly','spline','path'].includes(s.type))errs.push('shape '+i+': bad type "'+s.type+'"');
    if(!['cavity','insert','charge'].includes(s.role))errs.push('shape '+i+': bad role');
    for(const f of ['x','y','w','h','r','rot'])if(s[f]!=null&&typeof s[f]!=='number')errs.push('shape '+i+': '+f+' not numeric');
    if(s.pts!=null&&!(Array.isArray(s.pts)&&s.pts.every(p=>Array.isArray(p)&&p.length===2)))errs.push('shape '+i+': bad pts');
  });
  if(o.gates&&!Array.isArray(o.gates))errs.push('gates must be array');
  return errs;
}
function loadProjectText(txt){
  let o;
  try{o=JSON.parse(txt);}catch(e){showLoadWarn('Invalid JSON: '+e.message);return;}
  const errs=validateProject(o);
  if(errs.length){showLoadWarn(errs.slice(0,5).join(' · '));return;}
  showLoadWarn('');
  S.shapes=o.shapes.map(s=>mkShape(Object.assign({},s)));   // rebuild via factory (fills defaults)
  _uid=Math.max(...S.shapes.map(s=>s.id),0)+1;
  S.gates=(o.gates||[]).map(g=>({x:+g.x||0,y:+g.y||0}));
  S.sel.clear();
  if(o.params)for(const [id,v] of Object.entries(o.params)){
    const def=P_DEFS.find(d=>d[0]===id);
    if(def)setInputValue(id,clampNum(+v,def[2],def[3]));
  }
  if(o.ui){
    if(o.ui.model)document.getElementById('p_model').value=o.ui.model;
    if(o.ui.cmap)document.getElementById('v_cmap').value=o.ui.cmap;
    if(o.ui.mode)document.getElementById('v_mode').value=o.ui.mode;
    document.getElementById('p_noniso').checked=!!o.ui.noniso;
  }
  pushHistory();refreshShapeList();buildEditor();fitView();runSolve();
  setMsg('Project loaded (schema v'+o.schema+')');
}
function showLoadWarn(msg){document.getElementById('loadWarn').textContent=msg;}

// ---- PNG export: render at current size into a fresh canvas & download ----
function exportPNG(){
  markDirty();
  requestAnimationFrame(()=>{
    const a=document.createElement('a');
    a.download='smc-'+document.getElementById('v_mode').value+'.png';
    a.href=cv.toDataURL('image/png');
    a.click();setMsg('PNG exported');
  });
}

// ---- CSV export: metadata comments + one row per cell with all fields ----
function exportCSV(){
  if(!G.cav){setMsg('Nothing solved yet',true);return;}
  const nx=G.nx,ny=G.ny;
  const parts=[];
  parts.push('# SMC sim export v'+SCHEMA_VER+' | model='+document.getElementById('p_model').value+
    ' | grid='+nx+'x'+ny+' | cell='+G.cell.toFixed(4)+'mm | origin='+G.ox.toFixed(2)+','+G.oy.toFixed(2)+
    ' | tCur='+S.tCur+'s | eta0='+P.m_eta0+'Pas n='+P.m_n+' vf='+P.m_vf+' hgap='+P.p_hgap+'mm pinj='+P.p_pinj+'MPa\n');
  parts.push('i,j,x_mm,y_mm,cavity,insert,charge,filled,fill_time_s,pressure_Pa,fiber_conc,velocity_mm_s,temperature_C,cure_alpha,A11,A22,A12,weld,weld_strength,air_trap\n');
  const rows=[];
  for(let j=0;j<ny;j++)for(let i=0;i<nx;i++){
    const k=j*nx+i;
    rows.push(i+','+j+','+(G.ox+(i+.5)*G.cell).toFixed(3)+','+(G.oy+(j+.5)*G.cell).toFixed(3)+','+
      G.cav[k]+','+G.ins[k]+','+G.chg[k]+','+(isFinite(F.t[k])?1:0)+','+
      (isFinite(F.t[k])?F.t[k].toFixed(4):'')+','+F.p[k].toExponential(4)+','+F.fiber[k].toFixed(4)+','+
      F.speed[k].toFixed(4)+','+F.temp[k].toFixed(2)+','+F.cure[k].toFixed(4)+','+
      F.a11[k].toFixed(4)+','+F.a22[k].toFixed(4)+','+F.a12[k].toFixed(4)+','+
      F.weld[k]+','+F.weldStr[k].toFixed(3)+','+F.trap[k]+'\n');
  }
  // chunk join to avoid megabyte string concat blowups
  downloadBlob(new Blob([parts[0],parts[1],rows.join('')],{type:'text/csv'}),'smc-fields.csv');
  setMsg('CSV exported ('+nx*ny+' rows)');
}

// ---- presets: matched material + process sets ----
const PRESETS={
  thin:{m_eta0:800,m_n:0.55,m_vf:0.3,p_hgap:1.5,p_hc:5,p_vc:3,p_pinj:12,p_tmax:60,p_res:220,p_wall:0.6},
  thick:{m_eta0:1500,m_n:0.7,m_vf:0.15,p_hgap:6,p_hc:14,p_vc:1,p_pinj:3,p_tmax:15,p_res:120,p_wall:0.2},
  fiber:{m_eta0:1200,m_n:0.5,m_vf:0.45,m_ar:80,m_ctk:0.02,p_hgap:2.5,p_pinj:8,p_tmax:30},
  insert:{m_eta0:900,m_n:0.6,m_vf:0.25,p_hgap:3,p_pinj:6,p_wall:0.9,p_tmax:25},
};
function applyPreset(name){
  const pr=PRESETS[name];if(!pr)return;
  for(const [id,v] of Object.entries(pr)){
    const def=P_DEFS.find(d=>d[0]===id);
    if(def)setInputValue(id,v);
  }
  if(name==='insert'){ // add inserts around center to demonstrate core-heavy layout
    if(!S.shapes.some(s=>s.role==='insert')){
      S.shapes.push(mkShape({type:'circle',role:'insert',x:-15,y:0,r:9}));
      S.shapes.push(mkShape({type:'circle',role:'insert',x:15,y:0,r:9}));
      S.shapes.push(mkShape({type:'annulus',role:'insert',x:0,y:22,r:10,ri:5}));
    }
  }
  pushHistory();refreshShapeList();markDirty();runSolve();
  setMsg('Preset "'+name+'" applied');
}

// =============================================================================
// analysis panel drawing (histogram + legend colorbar with ticks)
// =============================================================================
let histCv=null,histCtx=null,legCv=null,legCtx=null;
function drawHistogram(){
  if(!histCv)return;
  const w=histCv.width,h=histCv.height,g=histCtx;
  g.clearRect(0,0,w,h);
  g.fillStyle='#0d1218';g.fillRect(0,0,w,h);
  if(!F.hist)return;
  let mx=1;for(let i=0;i<64;i++)mx=Math.max(mx,F.hist[i]);
  g.fillStyle='#37b6ff';
  const bw=w/64;
  for(let i=0;i<64;i++){
    const bh=(F.hist[i]/mx)*(h-16);
    g.fillRect(i*bw+1,h-12-bh,bw-1.5,bh);
  }
  g.fillStyle='#8494a7';g.font='9px sans-serif';
  g.fillText('0',2,h-2);g.fillText(F.tFillMax.toFixed(1)+' s',w-34,h-2);
}
function drawLegend(){
  if(!legCv||!G.cav||!F.t)return;
  const w=legCv.width,h=legCv.height,g=legCtx,lut=activeLUT();
  g.clearRect(0,0,w,h);
  const fld=fieldFor(document.getElementById('v_mode').value);
  const bx=8,by=8,bw=w-16,bh=14;
  for(let i=0;i<bw;i++){const li=(i/bw*255)|0;
    g.fillStyle='rgb('+lut[li*3]+','+lut[li*3+1]+','+lut[li*3+2]+')';g.fillRect(bx+i,by,1,bh);}
  g.strokeStyle='#2a3542';g.strokeRect(bx,by,bw,bh);
  g.fillStyle='#cfd8e3';g.font='9px sans-serif';
  for(let i=0;i<5;i++){
    const f=i/4,X=bx+f*bw,v=fld.vmin+f*(fld.vmax-fld.vmin);
    g.textAlign=i===0?'left':i===4?'right':'center';
    g.fillText(fmtVal(v,fld.unit),X,by+bh+10);
  }
  g.textAlign='left';
  // weld strength mini-legend when relevant
  if(document.getElementById('v_weldln').checked){
    g.fillStyle='#4dd08a';g.fillRect(w-90,h-12,8,8);g.fillStyle='#cfd8e3';g.fillText('strong',w-80,h-5);
    g.fillStyle='#ff5f56';g.fillRect(w-42,h-12,8,8);g.fillStyle='#cfd8e3';g.fillText('weak',w-32,h-5);
  }
}
function updateAnalysisPanel(){
  if(!F.t||!G.cav)return;
  const q=id=>document.getElementById(id);
  q('an_fill').textContent=F.tFillMax.toFixed(2)+' s';
  q('an_pmax').textContent=(F.pMax/1e6).toFixed(3)+' MPa';
  q('an_clamp').textContent=F.clampKN.toFixed(1)+' kN (+squeeze ≈'+F.squeezeKN.toFixed(0)+' kN)';
  q('an_weld').textContent=F.nWeld+' cells';
  q('an_trap').textContent=F.nTrap;
  q('an_unf').textContent=F.nUnf+' / '+F.cavN;
  q('an_cure').textContent=F.maxCure.toFixed(3);
  q('an_a11').textContent=F.meanAniso.toFixed(3);
  drawHistogram();drawLegend();
}

// ---- probe tooltip: every field at hovered cell ----
function probeText(i,j){
  const nx=G.nx,N=nx*G.ny,k=j*nx+i;
  if(k<0||k>=N)return null;
  const wx=(G.ox+(i+.5)*G.cell).toFixed(2),wy=(G.oy+(j+.5)*G.cell).toFixed(2);
  const L=[];
  L.push('cell ['+i+','+j+']  mm ('+wx+','+wy+')');
  L.push('mask: cavity='+G.cav[k]+' insert='+G.ins[k]+' charge='+G.chg[k]);
  if(G.cav[k]){
    L.push('fill time : '+(isFinite(F.t[k])?F.t[k].toFixed(3)+' s':'not filled'));
    L.push('pressure  : '+(F.p[k]/1e6).toFixed(4)+' MPa');
    L.push('fiber conc: '+F.fiber[k].toFixed(3));
    L.push('|velocity|: '+F.speed[k].toFixed(3)+' mm/s');
    L.push('temperat. : '+F.temp[k].toFixed(1)+' °C');
    L.push('cure α    : '+F.cure[k].toFixed(3));
    L.push('orient A  : ['+F.a11[k].toFixed(2)+' '+F.a12[k].toFixed(2)+'; '+F.a12[k].toFixed(2)+' '+F.a22[k].toFixed(2)+']');
    if(F.weld[k])L.push('WELD  strength≈'+(F.weldStr[k]*100).toFixed(0)+'%');
    if(F.trap[k])L.push('AIR TRAP');
  }
  return L.join('\n');
}
// =============================================================================
// ===== UI WIRING =====
// Parameter validation, canvas interaction (drag/resize/rotate/snap/multi-
// select/gates), solve orchestration, playback, keyboard, tooltips.
// =============================================================================

// ---- helpers ----
const $=id=>document.getElementById(id);
function clampNum(v,lo,hi){v=+v;if(!isFinite(v))return lo;return Math.max(lo,Math.min(hi,v));}
function countOnes(a){let n=0;for(let i=0;i<a.length;i++)n+=a[i]?1:0;return n;}
function setMsg(msg,warn){const el=$('stMsg');el.textContent=msg;el.style.color=warn?'var(--warn)':'var(--acc2)';if(msg&&!warn)setTimeout(()=>{if(el.textContent===msg)el.textContent='';},4000);}
function setProg(txt){$('progTxt').textContent=txt||'Solving…';}
function showProg(on){$('progress').style.display=on?'flex':'none';$('btnCancel').style.display=on?'inline-block':'none';}
function markDirty(){S.dirty=true;}
function setInputValue(id,v){
  const el=$(id);if(!el)return;
  if(el.type==='checkbox')el.checked=!!v;else el.value=v;
  readParam(id);
}

// ---- validated parameter reading ----
function readParam(id){
  const def=P_DEFS.find(d=>d[0]===id);if(!def)return;
  const el=$(id);if(!el)return;
  let raw=el.value;
  if(def[1]==='chk'){P[id]=el.checked;return;}
  let v=parseFloat(raw);
  let bad=false;
  if(!isFinite(v)){bad=true;v=def[2];}
  else if(v<def[2]||v>def[3]){bad=true;v=clampNum(v,def[2],def[3]);}
  if(def[1]==='int')v=Math.round(v);
  if(bad){el.classList.add('invalid');setMsg('Input "'+(el.closest('.row')?.querySelector('label')?.textContent||id).trim()+'" clamped to '+v+' '+(def[4]||''),true);}
  else el.classList.remove('invalid');
  if(String(v)!==String(raw)&&!bad)el.value=v;      // reflect snap without nagging
  P[id]=v;
}
function readAllParams(){for(const d of P_DEFS)readParam(d[0]);}

// ---- shape list UI (layers/z-order visible top→bottom as last-drawn-on-top) ----
function refreshShapeList(){
  const box=$('shapeList');box.innerHTML='';
  for(let idx=S.shapes.length-1;idx>=0;idx--){
    const sh=S.shapes[idx];
    const div=document.createElement('div');
    div.className='shape-item'+(S.sel.has(sh.id)?' sel':'');
    div.innerHTML='<span class="role '+sh.role+'">'+sh.role+'</span><span style="flex:1">'+
      sh.name+'</span><button class="small" title="Move up">▲</button><button class="small" title="Move down">▼</button>';
    div.onclick=e=>{
      if(e.target.tagName==='BUTTON'){S.sel.clear();S.sel.add(sh.id);bringSend(e.target.textContent==='▲'?1:-1);return;}
      if(e.shiftKey){S.sel.has(sh.id)?S.sel.delete(sh.id):S.sel.add(sh.id);}
      else{S.sel.clear();S.sel.add(sh.id);}
      refreshShapeList();buildEditor();markDirty();
    };
    box.appendChild(div);
  }
}

// ---- numeric editor panel for selection ----
function buildEditor(){
  const body=$('editorBody');
  const sel=selShapes();
  if(!sel.length){body.innerHTML='<div class="hint">Select one or more shapes to edit exact values.</div>';return;}
  const fields=[
    ['x','Center X (mm)'],['y','Center Y (mm)'],['rot','Rotation (°)'],
    ['w','Width (mm)'],['h','Height (mm)'],['r','Radius (mm)'],['ri','Inner r (annulus)'],
    ['sides','# sides (npoly)'],['width','Path width (mm)'],
  ];
  let html='<div class="hint">'+sel.length+' selected · blank = no change · Enter applies</div>';
  for(const [f,label] of fields){
    const vals=sel.map(s=>s[f]).filter(v=>v!=null&&isFinite(v));
    const same=vals.length===sel.length&&vals.every(v=>v===vals[0]);
    html+='<div class="row"><label>'+label+'</label><input type="number" data-field="'+f+'" value="'+
      (same?vals[0]:'')+'" step="0.5"></div>';
  }
  html+='<div class="row"><label>Name/role</label><input type="text" id="edName" value="'+
    (sel.length===1?sel[0].name:'')+'"><select id="edRole"><option value="">role…</option>'+
    '<option>cavity</option><option>insert</option><option>charge</option></select></div>';
  html+='<div class="row"><button class="small primary" id="edApply">Apply</button>'+
    '<button class="small" id="edUp">Layer ▲</button><button class="small" id="edDown">Layer ▼</button></div>';
  body.innerHTML=html;
  body.querySelectorAll('input[data-field]').forEach(inp=>{
    inp.onkeydown=e=>{if(e.key==='Enter')applyEditor();};
  });
  $('edApply').onclick=applyEditor;
  $('edUp').onclick=()=>bringSend(1);
  $('edDown').onclick=()=>bringSend(-1);
  function applyEditor(){
    let changed=false;
    body.querySelectorAll('input[data-field]').forEach(inp=>{
      if(inp.value==='')return;
      let v=parseFloat(inp.value);if(!isFinite(v))return;
      const f=inp.dataset.field;
      if(f==='w'||f==='h'||f==='r'||f==='ri'||f==='width')v=Math.max(0.1,v);
      if(f==='sides')v=Math.max(3,Math.round(v));
      for(const s of sel){s[f]=v;changed=true;}
    });
    if($('edName')&&$('edName').value&&sel.length===1){sel[0].name=$('edName').value;changed=true;}
    const role=$('edRole').value;
    if(role){for(const s of sel){s.role=role;s.name=s.name.replace(/^(cavity|insert|charge)/,role);}}
    if(changed||role){pushHistory();refreshShapeList();markDirty();scheduleAutoSolve();}
  }
}

// ---- canvas interaction ----
let drag=null;   // {mode:'move'|'resize'|'rotate'|'pan'|'rubber', ...}
function hitHandle(px,py){ // returns {shape,handle} or null — handles are screen-space squares
  for(const sh of selShapes().reverse()){
    const b=shapeAABB(sh);
    const [x0,y0]=W2S(b.x0,b.y1),[x1,y1]=W2S(b.x1,b.y0);
    const rx=(x0+x1)/2,ry=y0-18;
    if(Math.hypot(px-rx,py-ry)<9)return{shape:sh,handle:'rot'};
    for(const c of [[x0,y0],[x1,y0],[x1,y1],[x0,y1]])
      if(Math.abs(px-c[0])<7&&Math.abs(py-c[1])<7)return{shape:sh,handle:c};
  }
  return null;
}
function pickShape(wx,wy){
  for(let idx=S.shapes.length-1;idx>=0;idx--){
    const sh=S.shapes[idx];
    if(pointInShape(sh,wx,wy))return sh;
    // generous outline hit for path/poly lines
    const b=shapeAABB(sh);
    if(wx>b.x0-2&&wx<b.x1+2&&wy>b.y0-2&&wy<b.y1+2&&(sh.type==='path')){
      if(pointInShape(sh,wx,wy))return sh;
    }
  }
  return null;
}
// snapping: candidate points (centers/corners of other shapes + grid pitch)
function snapPoint(wx,wy,exclude){
  S.snapGuides.length=0;
  const tolPx=8,tol=tolPx/S.view.scale;
  const cand=[];
  if($('ckSnapGrid').checked){
    const p=P.snapPitch;
    cand.push([Math.round(wx/p)*p,'g']);cand.push([Math.round(wy/p)*p,'g']);
  }
  if($('ckSnapShape').checked){
    for(const sh of S.shapes){
      if(exclude&&exclude.has(sh.id))continue;
      const b=shapeAABB(sh);
      cand.push([sh.x,'x']);cand.push([sh.y,'y']);
      cand.push([b.x0,'x']);cand.push([b.x1,'x']);cand.push([b.y0,'y']);cand.push([b.y1,'y']);
    }
  }
  // nearest candidate independently on each axis within screen tolerance
  let bx=wx,by=wy;
  for(const [v,axis] of cand){
    if(axis==='x'&&Math.abs(v-wx)<Math.abs(bx-wx))bx=v;
    if(axis==='y'&&Math.abs(v-wy)<Math.abs(by-wy))by=v;
  }
  const sx=bx,sy=by;
  if(sx!==wx)S.snapGuides.push({x1:sx,y1:wy-1e4,x2:sx,y2:wy+1e4});
  if(sy!==wy)S.snapGuides.push({x1:wx-1e4,y1:sy,x2:wx+1e4,y2:sy});
  return[sx,sy];
}

function setupCanvasEvents(){
  cv.addEventListener('pointerdown',e=>{
    cv.setPointerCapture(e.pointerId);
    const px=e.offsetX,py=e.offsetY,[wx,wy]=S2W(px,py);
    updateXform();
    if(S.gateMode){ // place gate inside cavity only
      const i=((wx-G.ox)/G.cell)|0,j=((wy-G.oy)/G.cell)|0;
      if(i>=0&&j>=0&&i<G.nx&&j<G.ny&&G.cav[j*G.nx+i]){S.gates.push({x:wx,y:wy});pushHistory();updateGateCount();markDirty();}
      else setMsg('Gate must be inside the cavity raster',true);
      return;
    }
    const h=hitHandle(px,py);
    if(h){
      if(h.handle==='rot'){
        const b=shapeAABB(h.shape);
        drag={mode:'rotate',shape:h.shape,pivot:W2S((b.x0+b.x1)/2,(b.y0+b.y1)/2),base:null};
      }
      else{
        const b=shapeAABB(h.shape);
        // fixed opposite corner while dragging this handle
        const fx=h.handle[0]===b.x0?b.x1:b.x0, fy=h.handle[1]===b.y1?b.y0:b.y1;
        drag={mode:'resize',shape:h.shape,handle:h.handle,orig:JSON.parse(JSON.stringify(h.shape)),fixed:[fx,fy]};
      }
      return;
    }
    const sh=pickShape(wx,wy);
    if(sh){
      if(e.shiftKey){S.sel.has(sh.id)?S.sel.delete(sh.id):S.sel.add(sh.id);refreshShapeList();buildEditor();markDirty();return;}
      if(!S.sel.has(sh.id)){S.sel.clear();S.sel.add(sh.id);refreshShapeList();buildEditor();}
      const ids=new Set(S.sel);
      const start=[];for(const s of selShapes())start.push({id:s.id,x:s.x,y:s.y});
      drag={mode:'move',start,wx0:wx,wy0:wy,ids};
    } else if(e.button===1||e.altKey){
      drag={mode:'pan',px0:px,py0:py};
    } else {
      if(!e.shiftKey){S.sel.clear();refreshShapeList();buildEditor();}
      drag={mode:'rubber',x0:px,y0:py,x1:px,y1:py,add:e.shiftKey};
    }
    markDirty();
  });
  cv.addEventListener('pointermove',e=>{
    const px=e.offsetX,py=e.offsetY;
    updateXform();
    // hover probe tooltip
    if(!drag){
      const [wx,wy]=S2W(px,py);
      const tip=$('tip');
      if(G.cav){
        const i=((wx-G.ox)/G.cell)|0,j=((wy-G.oy)/G.cell)|0;
        const txt=probeText(i,j);
        if(txt){tip.style.display='block';tip.textContent=txt;
          tip.style.left=Math.min(px+14,cv.clientWidth-240)+'px';tip.style.top=Math.min(py+10,cv.clientHeight-160)+'px';
          updateProbePanel(txt);
        } else tip.style.display='none';
      }
      return;
    }
    const [wx,wy]=S2W(px,py);
    if(drag.mode==='move'){
      const dx=wx-drag.wx0,dy=wy-drag.wy0;
      // snap the first selected shape's center; others follow rigidly
      const first=S.shapes.find(s=>s.id===[...drag.ids][0]);
      if(first){
        const st=drag.start.find(p=>p.id===first.id);
        const [sx,sy]=snapPoint(st.x+dx,st.y+dy,drag.ids);
        const ddx=sx-st.x,ddy=sy-st.y;
        for(const p of drag.start){const s=S.shapes.find(q=>q.id===p.id);if(s){s.x=p.x+ddx;s.y=p.y+ddy;}}
      }
      markDirty();
    } else if(drag.mode==='resize'){
      const sh=drag.shape,[fx,fy]=drag.fixed;
      // scale in local (unrotated) frame
      const a=-sh.rot*Math.PI/180,c=Math.cos(a),s=Math.sin(a);
      const lx=(wx-fx)*c-(wy-fy)*s,ly=(wx-fx)*s+(wy-fy)*c;
      const lw=Math.abs(lx)/2,lh=Math.abs(ly)/2;
      if(sh.type==='circle'||sh.type==='npoly'||sh.type==='annulus')sh.r=Math.max(0.5,Math.max(lw,lh));
      else if(sh.type==='poly'||sh.type==='spline'){
        const ob=shapeHalfExtents(drag.orig);
        const scx=Math.max(0.05,lw/Math.max(ob.hw,.1)),scy=Math.max(0.05,lh/Math.max(ob.hh,.1));
        sh.pts=drag.orig.pts.map(p=>[p[0]*scx,p[1]*scy]);
      }
      else if(sh.type==='path'){
        const ob=shapeHalfExtents(drag.orig);
        const sc=Math.max(0.05,Math.max(lw/Math.max(ob.hw,.1),lh/Math.max(ob.hh,.1)));
        sh.pts=drag.orig.pts.map(p=>[p[0]*sc,p[1]*sc]);
      }
      else{sh.w=Math.max(0.5,lw*2);sh.h=Math.max(0.5,lh*2);}
      sh.x=(fx+wx)/2;sh.y=(fy+wy)/2;
      markDirty();
    } else if(drag.mode==='rotate'){
      const [pvx,pvy]=drag.pivot;
      const ang=Math.atan2(pvy-py,px-pvx)*180/Math.PI;
      const sh=drag.shape;
      if(!drag.base){drag.base=ang-sh.rot;}
      let nr=ang-drag.base;
      if(e.shiftKey)nr=Math.round(nr/15)*15;                 // 15° increments with Shift
      sh.rot=(nr%360+360)%360;
      markDirty();
    } else if(drag.mode==='rubber'){
      drag.x1=px;drag.y1=py;markDirty();
    } else if(drag.mode==='pan'){
      S.view.cx-=(px-drag.px0)/S.view.scale;
      S.view.cy+=(py-drag.py0)/S.view.scale;
      drag.px0=px;drag.py0=py;markDirty();
    }
  });
  cv.addEventListener('pointerup',e=>{
    if(!drag)return;
    const m=drag.mode;
    if(m==='move'||m==='resize'||m==='rotate'){pushHistory();buildEditor();scheduleAutoSolve();}
    if(m==='rubber'){
      const [ax,ay]=S2W(Math.min(drag.x0,drag.x1),Math.max(drag.y0,drag.y1));
      const [bx,by]=S2W(Math.max(drag.x0,drag.x1),Math.min(drag.y0,drag.y1));
      if(!drag.add)S.sel.clear();
      for(const sh of S.shapes){const b=shapeAABB(sh);
        if(b.x0>=ax&&b.x1<=bx&&b.y0>=ay&&b.y1<=by)S.sel.add(sh.id);}
      refreshShapeList();buildEditor();
    }
    S.snapGuides.length=0;
    drag=null;markDirty();
  });
  cv.addEventListener('wheel',e=>{
    e.preventDefault();
    const f=e.deltaY<0?1.12:1/1.12;
    const [wx,wy]=S2W(e.offsetX,e.offsetY);
    S.view.scale=Math.max(0.2,Math.min(400,S.view.scale*f));
    // zoom around cursor
    updateXform();
    const [nx,ny]=S2W(e.offsetX,e.offsetY);
    S.view.cx+=wx-nx;S.view.cy+=wy-ny;
    markDirty();
  },{passive:false});
  cv.addEventListener('dblclick',e=>{
    const [wx,wy]=S2W(e.offsetX,e.offsetY);updateXform();
    const sh=pickShape(wx,wy);
    if(sh){S.sel.clear();S.sel.add(sh.id);refreshShapeList();buildEditor();
      // focus editor on rotation field
      const rot=$('editorBody').querySelector('input[data-field=rot]');if(rot){rot.focus();rot.select();}}
  });
  window.addEventListener('keydown',onKey);
}

function updateProbePanel(txt){$('probeBox').innerHTML='<pre style="margin:0;font-size:10.5px;white-space:pre-wrap;color:var(--txt)">'+txt+'</pre>';}

// ---- rubber-band drawing hook (called from draw via drag state) ----
function drawRubber(){
  if(drag&&drag.mode==='rubber'){
    ctx.strokeStyle='#37b6ff';ctx.fillStyle='rgba(55,182,255,.08)';ctx.lineWidth=1;
    const x=Math.min(drag.x0,drag.x1),y=Math.min(drag.y0,drag.y1),w=Math.abs(drag.x1-drag.x0),h=Math.abs(drag.y1-drag.y0);
    ctx.fillRect(x,y,w,h);ctx.strokeRect(x,y,w,h);
  }
}


// ---- solve orchestration -----------------------------------------------------
let _autoTimer=0;
function scheduleAutoSolve(){clearTimeout(_autoTimer);_autoTimer=setTimeout(runSolve,350);}

function runSolve(){
  if(S.running){setMsg('Solver already running — cancel first',true);return;}
  readAllParams();
  S.running=true;S.cancelFlag=false;
  const t0=performance.now();
  rasterize();
  allocFields(G.nx*G.ny);
  updateStatusGrid();
  showProg(true);setProg('Rasterized '+G.nx+'×'+G.ny);
  const model=document.getElementById('p_model').value;
  S.solInfo.model=model;
  $('hdrModel').textContent={A:'Fast (Dijkstra)',B:'Hele-Shaw SOR',C:'VOF front tracking'}[model];
  // temperature init before viscosity coupling uses it
  F.temp.fill(P.m_Tc);
  const finish=(ok)=>{
    if(!ok){showProg(false);S.running=false;setMsg('Cancelled — partial results kept',true);updateStatus(0);return;}
    // shared post-processing for all models (order matters: velocity feeds fields)
    if(model==='A'||model==='C'){velocityFromTime();}
    if(model==='B'){deriveFillFromPressure();computeVelocity();}
    fiberField();weldField();tempField();cureField();orientField();computeStats();
    const ms=Math.round(performance.now()-t0);
    S.solInfo.ms=ms;
    showProg(false);S.running=false;
    updateStatus(ms);
    updateAnalysisPanel();refreshTimeSlider();markDirty();
    setMsg('Solved with model '+model+' in '+ms+' ms');
  };
  if(model==='A'){finish(solveDijkstra());}
  else if(model==='B'){setupHeleShaw();sorRunAsync(ok=>finish(ok));}
  else { // C: Hele-Shaw pressure solve, then chunked VOF front march
    setupHeleShaw();
    sorRunAsync(ok=>{if(!ok){finish(false);return;}vofMarchAsync(ok2=>finish(ok2));});
  }
}

// Model B only: reconstruct fill time from the steady pressure field by a fast
// front march (cells ordered by descending p ≈ arrival order) — documented approximation.
function deriveFillFromPressure(){
  const nx=G.nx,ny=G.ny,N=nx*ny,t=F.t;
  t.fill(Infinity);
  heapInit(N);
  for(let k=0;k<N;k++)if(F.src[k])t[k]=0;
  // BFS from inlets through cavity, cost = cellLen/|u| (clamped)
  const q=new Int32Array(N);let qh=0,qt=0;
  for(let k=0;k<N;k++)if(F.src[k])q[qt++]=k;
  while(qh<qt){
    const k=q[qh++];const i=k%nx,j=(k/nx)|0;
    const nb=[i>0?k-1:-1,i+1<nx?k+1:-1,j>0?k-nx:-1,j+1<ny?k+nx:-1];
    for(const kk of nb){
      if(kk<0||!G.cav[kk]||isFinite(t[kk]))continue;
      const sp=Math.max((F.speed[k]+F.speed[kk])/2,1e-4);
      t[kk]=t[k]+G.cell/sp;                     // Δt = ℓ/ū [front kinematics]
      q[qt++]=kk;
    }
  }
}

// ---- status bar / slider ----
function updateStatusGrid(){$('stGrid').textContent=(G.nx||'—')+'×'+(G.ny||'—');}
function updateStatus(ms){
  $('stModel').textContent=S.solInfo.model;
  $('stIter').textContent=SOR.iters||'—';
  $('stRes').textContent=SOR.res?SOR.res.toExponential(1):'—';
  $('stMs').textContent=ms+' ms';
  refreshFilledPct();
}
function refreshFilledPct(){
  if(!F.t)return;
  let n=0,f=0;const N=G.nx*G.ny;
  for(let k=0;k<N;k++)if(G.cav[k]){n++;if(isFinite(F.t[k])&&F.t[k]<=S.tCur)f++;}
  $('stFill').textContent=n?(f/n*100).toFixed(1)+'%':'—%';
  $('stT').textContent=S.tCur.toFixed(2)+' s';
}
function refreshTimeSlider(){
  const sl=$('timeSlider');
  sl.max=P.p_tmax;
  if(S.tCur>P.p_tmax)S.tCur=P.p_tmax;
  sl.value=S.tCur;$('timeLbl').textContent='t = '+S.tCur.toFixed(1)+' s';
}

// ---- playback ----
function togglePlay(){
  S.playing=!S.playing;
  $('btnPlay').textContent=S.playing?'⏸ Pause':'▶ Play';
  if(S.playing){S.lastPlayTs=performance.now();playStep();}
  else cancelAnimationFrame(S.playRAF);
}
function playStep(){
  if(!S.playing)return;
  const now=performance.now(),dtms=now-S.lastPlayTs;S.lastPlayTs=now;
  S.tCur+=dtms/1000*S.playSpeed*(P.p_tmax/8);   // full sweep ≈ 8 s at 1×
  if(S.tCur>=P.p_tmax){S.tCur=0;}               // loop animation
  $('timeSlider').value=S.tCur;
  $('timeLbl').textContent='t = '+S.tCur.toFixed(1)+' s';
  tempField();cureField();computeStats();       // time-dependent fields follow slider
  refreshFilledPct();updateAnalysisPanel();markDirty();
  S.playRAF=requestAnimationFrame(playStep);
}

// ---- view mode buttons & selects sync ----
function setViewMode(m){
  document.getElementById('v_mode').value=m;
  for(const b of document.querySelectorAll('#viewBtns button'))b.classList.toggle('on',b.dataset.m===m);
  drawLegend();markDirty();
}

// ---- gates ----
function updateGateCount(){
  $('gateCount').textContent=S.gates.length?('Gates placed: '+S.gates.length):'No gates — charge contact is used as inlet.';
}

// ---- keyboard ----
function onKey(e){
  if(e.target.tagName==='INPUT'||e.target.tagName==='SELECT'||e.target.tagName==='TEXTAREA')return;
  const ctrl=e.ctrlKey||e.metaKey;
  if(ctrl&&e.key.toLowerCase()==='z'){e.preventDefault();e.shiftKey?redo():undo();return;}
  if(ctrl&&e.key.toLowerCase()==='y'){e.preventDefault();redo();return;}
  if(ctrl&&e.key.toLowerCase()==='c'){copySel();return;}
  if(ctrl&&e.key.toLowerCase()==='v'){pasteClip();return;}
  if(ctrl&&e.key.toLowerCase()==='d'){e.preventDefault();duplicateSel();return;}
  if(e.key==='Delete'){deleteSel();scheduleAutoSolve();return;}
  if(e.key===' '){e.preventDefault();togglePlay();return;}
  if(e.key==='?'){$('helpModal').classList.add('open');return;}
  if(e.key==='Escape'){$('helpModal').classList.remove('open');S.gateMode=false;$('btnGateMode').classList.remove('active');return;}
  if(e.key.toLowerCase()==='r'){runSolve();return;}
  if(e.key.toLowerCase()==='f'){fitView();return;}
  const modes=['fill','pressure','fiber','weld','velocity','temp','cure','orient'];
  if(e.key>='1'&&e.key<='8')setViewMode(modes[+e.key-1]);
}

// ---- tooltips (title attrs from data-tip so they work offline everywhere) ----
function wireTooltips(){
  for(const el of document.querySelectorAll('[data-tip]'))el.title=el.dataset.tip;
}

// ---- fit view to scene ----
function fitView(){
  const b=sceneBounds();
  const cw=cv.width/dpr,ch=cv.height/dpr;
  S.view.cx=(b.x0+b.x1)/2;S.view.cy=(b.y0+b.y1)/2;
  S.view.scale=Math.min(cw/(b.x1-b.x0),ch/(b.y1-b.y0))*0.92;
  markDirty();
}

// ---- canvas sizing (HiDPI aware, no allocation churn) ----
function resizeCanvas(){
  const wrap=$('canvasWrap');
  dpr=Math.min(2,window.devicePixelRatio||1);
  const w=wrap.clientWidth,h=wrap.clientHeight;
  if(cv.width!==Math.round(w*dpr)||cv.height!==Math.round(h*dpr)){
    cv.width=Math.round(w*dpr);cv.height=Math.round(h*dpr);
    markDirty();
  }
}

// =============================================================================
// ===== BOOT =====
// =============================================================================
function boot(){
  cv=$('view');ctx=cv.getContext('2d',{alpha:false});
  histCv=$('histCv');histCtx=histCv.getContext('2d');
  legCv=$('legCv');legCtx=legCv.getContext('2d');
  readAllParams();
  S.shapes=defaultShapes();pushHistory();
  refreshShapeList();buildEditor();wireTooltips();updateGateCount();
  setupCanvasEvents();

  // sidebar wiring -----------------------------------------------------------
  $('btnAddShape').onclick=()=>{
    const role=$('selRole').value,type=$('selType').value;
    const sh=mkShape({role,type,x:S.view.cx,y:S.view.cy});
    sh.name=role+' '+type;
    S.shapes.push(sh);S.sel.clear();S.sel.add(sh.id);
    pushHistory();refreshShapeList();buildEditor();markDirty();scheduleAutoSolve();
  };
  $('btnDelSel').onclick=()=>{deleteSel();scheduleAutoSolve();};
  $('btnDupSel').onclick=()=>{duplicateSel(6);scheduleAutoSolve();};
  $('btnCopy').onclick=copySel;$('btnPaste').onclick=pasteClip;
  $('btnUndo').onclick=undo;$('btnRedo').onclick=redo;
  $('btnGateMode').onclick=()=>{S.gateMode=!S.gateMode;$('btnGateMode').classList.toggle('active',S.gateMode);
    setMsg(S.gateMode?'Click inside cavity to place gate':'Gate mode off');};
  $('btnClearGates').onclick=()=>{S.gates=[];pushHistory();updateGateCount();markDirty();scheduleAutoSolve();};

  $('btnSaveProj').onclick=saveProject;
  $('btnLoadProj').onclick=()=>$('projFile').click();
  $('projFile').onchange=e=>{
    const f=e.target.files[0];if(!f)return;
    const r=new FileReader();
    r.onload=()=>loadProjectText(r.result);
    r.onerror=()=>showLoadWarn('Could not read file');
    r.readAsText(f);e.target.value='';
  };
  $('btnExportPNG').onclick=exportPNG;
  $('btnExportCSV').onclick=exportCSV;
  $('presetSel').onchange=e=>{if(e.target.value)applyPreset(e.target.value);e.target.value='';};

  // numeric inputs validate on change; geometry params trigger re-solve
  for(const d of P_DEFS){
    const el=$(d[0]);if(!el)continue;
    el.addEventListener('input',()=>readParam(d[0]));
    el.addEventListener('change',()=>{
      readParam(d[0]);
      if(d[0].startsWith('p_')||d[0].startsWith('m_'))scheduleAutoSolve();
      if(d[0]==='v_cont')markDirty();
    });
  }
  $('p_model').onchange=runSolve;
  $('p_noniso').onchange=runSolve;
  $('btnRun').onclick=runSolve;
  $('btnCancel').onclick=$('btnProgCancel').onclick=()=>{S.cancelFlag=true;setMsg('Cancel requested…',true);};

  // visualization toggles just redraw
  for(const id of ['v_smooth','v_compare','v_stream','v_vec','v_glyph','v_traps','v_short','v_cureov','v_weldln','v_grid','v_shapes','v_contlab'])
    $(id).addEventListener('change',()=>{drawLegend();markDirty();});
  $('v_mode').onchange=e=>setViewMode(e.target.value);
  $('v_mode2').onchange=markDirty;
  $('v_cmap').onchange=()=>{drawLegend();markDirty();};

  // toolbar
  for(const b of document.querySelectorAll('#viewBtns button'))
    b.onclick=()=>setViewMode(b.dataset.m);
  $('btnPlay').onclick=togglePlay;
  $('playSpeed').onchange=e=>{S.playSpeed=parseFloat(e.target.value)||1;};
  $('timeSlider').addEventListener('input',e=>{
    S.tCur=clampNum(parseFloat(e.target.value),0,P.p_tmax);
    $('timeLbl').textContent='t = '+S.tCur.toFixed(1)+' s';
    tempField();cureField();computeStats();refreshFilledPct();updateAnalysisPanel();markDirty();
  });
  $('btnFit').onclick=fitView;
  $('btnHelp').onclick=()=>$('helpModal').classList.add('open');
  $('helpModal').onclick=e=>{if(e.target===$('helpModal'))$('helpModal').classList.remove('open');};

  window.addEventListener('resize',()=>{resizeCanvas();markDirty();});

  // render loop: draws only when dirty (or during drag) ------------------------
  (function loop(){
    resizeCanvas();
    if(S.dirty||drag){S.dirty=false;draw();}
    requestAnimationFrame(loop);
  })();

  fitView();
  runSolve();
}
document.addEventListener('DOMContentLoaded',boot);

// public API surface (single global; nothing else leaks to window)
return {
  version:'2.0', state:S, params:P, fields:F, grid:G,
  solve:runSolve, undo:undo, redo:redo, fitView:fitView,
  saveProject, loadProjectText, exportPNG, exportCSV, applyPreset, setViewMode,
};
})();
