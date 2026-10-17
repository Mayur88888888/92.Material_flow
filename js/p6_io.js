
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
