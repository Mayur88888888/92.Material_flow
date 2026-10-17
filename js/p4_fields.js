
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
