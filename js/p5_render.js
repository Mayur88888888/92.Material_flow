
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
