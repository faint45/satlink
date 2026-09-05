/* satmodels.js — 以 three.js 程序生成的衛星本體模型（無外部資產）
   模型座標約定（LVLH 本體座標系，與真實衛星姿態一致）：
     +Z = 天底方向（對地）   +X = 速度方向（迎風面）   +Y = 軌道法線負向
   太陽能板掛在 userData.arrays 群組，繞本體 Y 軸單軸轉動追日 —— 這是絕大多數
   三軸穩定衛星的真實作法（單自由度太陽能板驅動裝置 SADA）。
   【尺度說明】模型以「模型單位」建構，繪製時由 app.js 依相機距離縮放，
   因此畫面上的衛星是放大示意，非真實比例；實際放大倍率顯示於介面。
   【外形依據】比例參考各衛星公開外觀照片與規格描述，屬辨識用示意，非工程圖。 */
import * as THREE from 'three';

/* ── 程序生成貼圖（canvas，不載入任何外部圖檔）───────────────── */
function tex(w, h, draw){
  const c = document.createElement('canvas'); c.width=w; c.height=h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}
const T = {};
function texSolar(){
  if(T.solar) return T.solar;
  return T.solar = tex(256,256,(g,w,h)=>{
    g.fillStyle='#0d1b3a'; g.fillRect(0,0,w,h);
    for(let y=0;y<8;y++) for(let x=0;x<8;x++){
      const v = 18 + Math.random()*10;
      g.fillStyle = 'rgb(' + v + ',' + (v+14) + ',' + (v+52) + ')';
      g.fillRect(x*32+2, y*32+2, 28, 28);
      g.strokeStyle='rgba(150,190,255,0.20)'; g.lineWidth=1;
      for(let k=1;k<4;k++){ g.beginPath(); g.moveTo(x*32+2+k*7, y*32+2); g.lineTo(x*32+2+k*7, y*32+30); g.stroke(); }
    }
    g.strokeStyle='rgba(180,210,255,0.35)'; g.lineWidth=2;
    for(let k=0;k<=8;k++){ g.beginPath(); g.moveTo(k*32,0); g.lineTo(k*32,h); g.moveTo(0,k*32); g.lineTo(w,k*32); g.stroke(); }
  });
}
function texFoil(){          /* 多層隔熱毯 MLI，金色，帶皺褶 */
  if(T.foil) return T.foil;
  return T.foil = tex(128,128,(g,w,h)=>{
    g.fillStyle='#c8952f'; g.fillRect(0,0,w,h);
    for(let i=0;i<900;i++){
      const x=Math.random()*w, y=Math.random()*h, l=6+Math.random()*22, a=Math.random()*Math.PI;
      const gg = Math.round(200+Math.random()*40), bb = Math.round(90+Math.random()*70);
      g.strokeStyle = 'rgba(255,' + gg + ',' + bb + ',' + (0.05+Math.random()*0.16).toFixed(3) + ')';
      g.lineWidth = 0.6 + Math.random()*1.6;
      g.beginPath(); g.moveTo(x,y); g.lineTo(x+Math.cos(a)*l, y+Math.sin(a)*l); g.stroke();
    }
  });
}
function texRad(){           /* 散熱片：白色 OSR 鏡面 */
  if(T.rad) return T.rad;
  return T.rad = tex(64,64,(g,w,h)=>{
    g.fillStyle='#e8eef5'; g.fillRect(0,0,w,h);
    g.strokeStyle='rgba(120,150,180,0.5)';
    for(let k=0;k<8;k++){ g.beginPath(); g.moveTo(0,k*8); g.lineTo(w,k*8); g.stroke(); }
  });
}

const M = {};
function matFoil(){  return M.foil  || (M.foil  = new THREE.MeshStandardMaterial({map:texFoil(),  metalness:0.35, roughness:0.55})); }
function matSolar(){ return M.solar || (M.solar = new THREE.MeshStandardMaterial({map:texSolar(), metalness:0.20, roughness:0.42, side:THREE.DoubleSide})); }
function matRad(){   return M.rad   || (M.rad   = new THREE.MeshStandardMaterial({map:texRad(),   metalness:0.10, roughness:0.35, side:THREE.DoubleSide})); }
function matAl(){    return M.al    || (M.al    = new THREE.MeshStandardMaterial({color:0xb9c3ce, metalness:0.30, roughness:0.45})); }
function matDark(){  return M.dark  || (M.dark  = new THREE.MeshStandardMaterial({color:0x3a424e, metalness:0.25, roughness:0.65})); }
function matWhite(){ return M.wht   || (M.wht   = new THREE.MeshStandardMaterial({color:0xe6ebf2, metalness:0.08, roughness:0.60})); }

/* ── 零件 ─────────────────────────────────────────────────── */
function box(w,h,d,m){ return new THREE.Mesh(new THREE.BoxGeometry(w,h,d), m); }
function cyl(r,h,m,seg){ return new THREE.Mesh(new THREE.CylinderGeometry(r,r,h,seg||18), m); }
function whip(len){ return cyl(0.012, len, matAl(), 6); }

/* 太陽能翼：支臂 + n 塊板，掛在 ±Y。未轉動時板面法線朝 +Z。 */
function wing(sign, len, wid, n){
  n = n || 3;
  const g = new THREE.Group();
  const boom = cyl(0.045, 0.9, matAl()); boom.position.y = sign*0.45; g.add(boom);
  for(let i=0;i<n;i++){
    const p = new THREE.Mesh(new THREE.PlaneGeometry(wid, len/n*0.96), matSolar());
    p.rotation.x = -Math.PI/2;
    p.position.y = sign*(0.9 + len/n*(i+0.5));
    g.add(p);
    const sp = box(wid*1.01, 0.02, 0.02, matAl());
    sp.position.y = sign*(0.9 + len/n*(i+1)); g.add(sp);
  }
  return g;
}
/* 拋物面天線：主反射面 + 饋源支臂 + 副反射面 */
function dish(d, m){
  const g = new THREE.Group();
  const s = new THREE.Mesh(new THREE.SphereGeometry(d/2,20,10,0,Math.PI*2,0,Math.PI*0.34), m||matWhite());
  s.rotation.x = Math.PI; g.add(s);
  const f = cyl(0.02, d*0.42, matAl(), 8); f.position.z = d*0.21; f.rotation.x = Math.PI/2; g.add(f);
  const sub = new THREE.Mesh(new THREE.SphereGeometry(d*0.09,10,6), matAl());
  sub.position.z = d*0.42; g.add(sub);
  return g;
}
/* GNSS L 頻段螺旋天線陣列 */
function helixArray(cols, rows, r){
  const g = new THREE.Group();
  for(let i=0;i<cols;i++) for(let j=0;j<rows;j++){
    const h = cyl(r*0.28, r*1.5, matAl(), 8);
    h.rotation.x = Math.PI/2;
    h.position.set((i-(cols-1)/2)*r*1.9, (j-(rows-1)/2)*r*1.9, r*0.75);
    g.add(h);
  }
  return g;
}

/* ── 各型號原型 ───────────────────────────────────────────── */
const BUILD = {
  /* GEO 通訊衛星：方形艙體 + 兩片大型太陽翼 + 多面天線 + 側面散熱器 */
  geo_spot: function(){
    const g = new THREE.Group(), a = new THREE.Group();
    g.add(box(1.5,1.4,1.8, matFoil()));
    const r1 = new THREE.Mesh(new THREE.PlaneGeometry(1.7,1.3), matRad());
    r1.position.x = 0.78; r1.rotation.y = Math.PI/2; g.add(r1);
    const r2 = r1.clone(); r2.position.x = -0.78; g.add(r2);
    a.add(wing(1,5.2,1.5,3), wing(-1,5.2,1.5,3)); g.add(a);
    const d1 = dish(1.5); d1.position.z = 1.0; g.add(d1);
    const d2 = dish(0.9); d2.position.set( 0.55,0,0.95); d2.rotation.y =  0.35; g.add(d2);
    const d3 = dish(0.9); d3.position.set(-0.55,0,0.95); d3.rotation.y = -0.35; g.add(d3);
    g.userData.arrays = a; g.userData.span = 11; return g;
  },
  /* Starlink：扁平艙體 + 對地相位陣列面 + 單片開書式太陽翼 */
  leo_phased: function(){
    const g = new THREE.Group(), a = new THREE.Group();
    g.add(box(2.6,0.22,1.6, matDark()));
    const pa = new THREE.Mesh(new THREE.PlaneGeometry(2.4,1.4), matAl());
    pa.rotation.x = Math.PI/2; pa.position.z = 0.13; g.add(pa);
    for(let i=0;i<4;i++){
      const p = new THREE.Mesh(new THREE.PlaneGeometry(2.5,1.6), matSolar());
      p.rotation.x = -Math.PI/2; p.position.y = 1.0 + i*1.65; a.add(p);
    }
    g.add(a);
    g.userData.arrays = a; g.userData.span = 9; return g;
  },
  oneweb_ku: function(){
    const g = new THREE.Group(), a = new THREE.Group();
    g.add(box(1.0,1.0,1.3, matFoil()));
    const pa = new THREE.Mesh(new THREE.PlaneGeometry(0.95,0.95), matDark());
    pa.rotation.x = Math.PI/2; pa.position.z = 0.68; g.add(pa);
    a.add(wing(1,2.6,0.95,2), wing(-1,2.6,0.95,2)); g.add(a);
    g.userData.arrays = a; g.userData.span = 6.5; return g;
  },
  /* GNSS：艙體 + 對地螺旋陣列 + 兩翼 + 重力梯度桿 */
  gnss: function(){
    const g = new THREE.Group(), a = new THREE.Group();
    g.add(box(1.3,1.3,1.6, matFoil()));
    g.add(helixArray(4,3,0.17));
    a.add(wing(1,3.4,1.1,2), wing(-1,3.4,1.1,2)); g.add(a);
    const b = whip(1.4); b.position.set(0,0,-1.0); b.rotation.x = Math.PI/2; g.add(b);
    g.userData.arrays = a; g.userData.span = 8; return g;
  },
  /* Iridium：三角艙體 + 三面主任務天線 + 兩翼 */
  iridium_l: function(){
    const g = new THREE.Group(), a = new THREE.Group();
    const bus = new THREE.Mesh(new THREE.CylinderGeometry(0.75,0.75,2.0,3), matFoil());
    bus.rotation.x = Math.PI/2; g.add(bus);
    for(let i=0;i<3;i++){
      const th = i*Math.PI*2/3;
      const p = new THREE.Mesh(new THREE.PlaneGeometry(1.5,1.9), matDark());
      p.position.set(Math.cos(th)*0.95, Math.sin(th)*0.95, 0.35);
      p.rotation.set(Math.PI/2.6, 0, th + Math.PI/2);
      g.add(p);
    }
    a.add(wing(1,2.6,0.9,2), wing(-1,2.6,0.9,2)); g.add(a);
    g.userData.arrays = a; g.userData.span = 7; return g;
  },
  /* 太空站：加壓艙 + 桁架 + 四對太陽翼 + 散熱器 */
  station_vhf: function(){
    const g = new THREE.Group(), a = new THREE.Group();
    for(let i=-1;i<=1;i++){
      const m = cyl(0.45,1.5, matWhite()); m.rotation.z = Math.PI/2; m.position.x = i*1.5; g.add(m);
    }
    const node = cyl(0.5,0.9, matWhite()); node.position.set(0,0,0.7); g.add(node);
    g.add(box(9.5,0.30,0.30, matAl()));
    const xs = [-4.3,-3.0,3.0,4.3];
    for(let k=0;k<xs.length;k++){
      for(const sgn of [1,-1]){
        const p = new THREE.Mesh(new THREE.PlaneGeometry(1.15,3.4), matSolar());
        p.rotation.x = -Math.PI/2; p.position.set(xs[k], sgn*1.9, 0); a.add(p);
      }
    }
    g.add(a);
    for(const x of [-1.9,1.9]){
      const r = new THREE.Mesh(new THREE.PlaneGeometry(1.5,2.4), matRad());
      r.position.set(x,0,-1.2); r.rotation.x = Math.PI*0.075; g.add(r);
    }
    g.userData.arrays = a; g.userData.span = 11; return g;
  },
  /* 極軌氣象：長方艙體 + 單翼 + 掃描輻射計 + VHF 鞭狀天線 */
  leo_vhf: function(){
    const g = new THREE.Group(), a = new THREE.Group();
    g.add(box(1.2,1.2,3.4, matFoil()));
    const sc = cyl(0.28,0.6, matAl()); sc.position.set(0,0,1.9); g.add(sc);
    a.add(wing(1,3.6,1.3,3)); g.add(a);
    const w = whip(1.6); w.position.set(0,-0.7,-1.2); g.add(w);
    g.userData.arrays = a; g.userData.span = 8; return g;
  },
  goes_l: function(){
    const g = new THREE.Group(), a = new THREE.Group();
    g.add(box(1.4,1.4,2.0, matFoil()));
    const im = box(0.8,0.8,0.7, matDark()); im.position.z = 1.2; g.add(im);
    a.add(wing(1,4.2,1.3,3)); g.add(a);
    const boom = whip(4.5); boom.position.y = -2.6; g.add(boom);
    const d = dish(0.8); d.position.set(0.5,0,1.1); g.add(d);
    g.userData.arrays = a; g.userData.span = 9; return g;
  },
  /* 科學衛星：望遠鏡筒身 + 光圈門 + 兩翼 */
  science_s: function(){
    const g = new THREE.Group(), a = new THREE.Group();
    const tube = cyl(0.7,3.6, matAl(), 24); tube.rotation.x = Math.PI/2; g.add(tube);
    const door = new THREE.Mesh(new THREE.CircleGeometry(0.7,24), matWhite());
    door.position.z = 1.8; g.add(door);
    a.add(wing(1,2.6,1.1,2), wing(-1,2.6,1.1,2)); g.add(a);
    const d = dish(0.6); d.position.set(0,-0.9,-1.2); g.add(d);
    g.userData.arrays = a; g.userData.span = 7; return g;
  },
  /* 立方衛星：3U 本體 + 貼片太陽能 + 四支展開鞭狀天線 */
  amateur_uhf: function(){
    const g = new THREE.Group(), a = new THREE.Group();
    g.add(box(0.5,0.5,1.5, matDark()));
    for(const s of [1,-1]){
      const p = new THREE.Mesh(new THREE.PlaneGeometry(0.48,1.45), matSolar());
      p.rotation.y = Math.PI/2*s; p.position.x = s*0.26; g.add(p);
    }
    for(let i=0;i<4;i++){
      const th = i*Math.PI/2;
      const w = whip(1.5);
      w.position.set(Math.cos(th)*0.2, Math.sin(th)*0.2, -0.9);
      w.rotation.set(Math.PI/2.2, 0, th); g.add(w);
    }
    a.add(wing(1,1.2,0.5,1)); g.add(a);
    g.userData.arrays = a; g.userData.span = 3.5; return g;
  },
  /* 對地觀測：艙體 + 光學筒 + 大單翼 + X 頻段可動天線 */
  eo_xband: function(){
    const g = new THREE.Group(), a = new THREE.Group();
    g.add(box(1.3,1.3,2.6, matFoil()));
    const opt = cyl(0.5,1.0, matDark(), 20); opt.rotation.x = Math.PI/2; opt.position.z = 1.6; g.add(opt);
    a.add(wing(1,4.4,1.4,3)); g.add(a);
    const d = dish(0.7); d.position.set(0,-0.85,-1.2); d.rotation.x = 0.4; g.add(d);
    g.userData.arrays = a; g.userData.span = 9; return g;
  }
};
const ALIAS = { gnss_gps:'gnss', gnss_gal:'gnss', gnss_glo:'gnss', gnss_bds:'gnss' };

const protoCache = {};
export function getModel(cls){
  const key = ALIAS[cls] || cls;
  const fn = BUILD[key] || BUILD.eo_xband;
  if(!protoCache[key]) protoCache[key] = fn();
  const proto = protoCache[key];
  const c = proto.clone(true);
  // clone() 不會複製 userData 內的物件參照，需依子物件索引重新綁定太陽翼群組
  const idx = proto.children.indexOf(proto.userData.arrays);
  c.userData.arrays = c.children[idx];
  c.userData.span = proto.userData.span;
  return c;
}
export const MODEL_KEYS = Object.keys(BUILD);
