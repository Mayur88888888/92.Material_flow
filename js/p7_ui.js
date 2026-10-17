
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
