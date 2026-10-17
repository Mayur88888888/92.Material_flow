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
