
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
