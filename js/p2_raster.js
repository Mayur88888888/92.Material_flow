
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
