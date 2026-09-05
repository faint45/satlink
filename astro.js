/* astro.js — 系外行星與深空天體（星團／星雲／星系）
   資料來源：
     · 系外行星 — NASA Exoplanet Archive「Planetary Systems」表，default_flag=1
       （每顆行星取其預設參數集），由 IPAC/Caltech 為 NASA 系外行星探索計畫維運。
     · 深空天體 — OpenNGC (Mattia Verga, CC-BY-SA-4.0)，NGC/IC 修訂資料。
   兩者座標皆為 J2000 赤道座標，繪製前套用與 JPL 星曆相同的 J2000→當日歲差修正，
   使全場（SGP4 的 TEME、太陽、月球、深空任務、恆星、星團）處於同一框架。

   【尺度說明｜必讀】這些天體的距離從 4.2 光年到數千萬光年，遠超本場景任何比例。
   它們一律繪在固定半徑的天球上 —— 也就是「方向是真的，距離不是」。
   真實距離顯示於資訊面板，單位為秒差距與光年。 */
import * as THREE from 'three';
import { precessJ2000ToDate, toJD } from './deepspace.js';

export const PC2LY = 3.2615638;          // 1 秒差距 = 3.2615638 光年（由 IAU 定義的 AU 與角秒導出）
const d2r = Math.PI/180;
let DATA = null;

export async function loadAstro(url){
  DATA = await (await fetch(url || 'astro.json')).json();
  return DATA;
}
export const astroMeta = () => DATA;

/* 赤經赤緯（度，J2000）→ 場景方向向量（當日框架） */
function dirFromRaDec(ra_deg, dec_deg, jd){
  const ra = ra_deg*d2r, dec = dec_deg*d2r;
  const v = [Math.cos(dec)*Math.cos(ra), Math.cos(dec)*Math.sin(ra), Math.sin(dec)];
  const p = precessJ2000ToDate(v, jd);
  return new THREE.Vector3(p[0], p[2], -p[1]).normalize();   // ECI → 場景座標
}

/* 依類型上色（與介面圖例一致） */
export const DSO_COLOR = [
  0x7ee8c0, // 疏散星團
  0xffd166, // 球狀星團
  0xa78bfa, // 星團＋星雲
  0x5fd0ff, // 行星狀星雲
  0xff8fb1, // 瀰漫星雲
  0xff6b9d, // 發射星雲
  0x8fb8ff, // 反射星雲
  0xffa07a, // 超新星殘骸
  0xff9f6b, // 電離氫區
  0xcfd6e4, // 星系
  0xcfd6e4, // 星系群
  0xcfd6e4  // 星系對
];

/* 深空天體圖層：單一 Points，大小依真實視角尺寸（角分）換算 */
export function buildDsoLayer(date, R){
  const D = DATA.dso, jd = toJD(date), n = D.n;
  const pos = new Float32Array(n*3), col = new Float32Array(n*3), siz = new Float32Array(n);
  const c = new THREE.Color();
  for(let i=0;i<n;i++){
    const v = dirFromRaDec(D.ra[i], D.dec[i], jd).multiplyScalar(R);
    pos[i*3]=v.x; pos[i*3+1]=v.y; pos[i*3+2]=v.z;
    c.setHex(DSO_COLOR[D.type[i]] ?? 0xcfd6e4);
    // 亮度依視星等；無星等者給中間值
    const m = D.mag[i];
    const b = m == null ? 0.55 : Math.max(0.25, Math.min(1, (13 - m)/9));
    col[i*3]=c.r*b; col[i*3+1]=c.g*b; col[i*3+2]=c.b*b;
    // 點大小反映真實視角尺寸（MajAx 單位為角分），加下限使小天體仍可見
    const a = D.size[i];
    siz[i] = a == null ? 3.0 : Math.max(3.0, Math.min(26, 2.6*Math.sqrt(a)));
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos,3));
  g.setAttribute('color',    new THREE.BufferAttribute(col,3));
  g.setAttribute('psize',    new THREE.BufferAttribute(siz,1));
  return new THREE.Points(g, ringPointMaterial());
}

/* 系外行星圖層：以「宿主恆星方向」繪點。同一宿主的多顆行星會重疊，
   此處刻意保留 —— 疊加後較亮，正好反映多行星系統。 */
export function buildExoLayer(date, R){
  const E = DATA.exoplanets, jd = toJD(date), n = E.n;
  const pos = new Float32Array(n*3), col = new Float32Array(n*3), siz = new Float32Array(n);
  const c = new THREE.Color();
  for(let i=0;i<n;i++){
    const v = dirFromRaDec(E.ra[i], E.dec[i], jd).multiplyScalar(R);
    pos[i*3]=v.x; pos[i*3+1]=v.y; pos[i*3+2]=v.z;
    // 近者亮、遠者暗（距離未知者給中間值）
    const d = E.dist_pc[i];
    const b = d == null ? 0.5 : Math.max(0.3, Math.min(1, 1.15 - Math.log10(d)/3.2));
    c.setHex(0x66ffcc);
    col[i*3]=c.r*b; col[i*3+1]=c.g*b*0.95; col[i*3+2]=c.b*b*0.8;
    siz[i] = d == null ? 3.2 : Math.max(2.6, Math.min(9, 9 - Math.log10(Math.max(d,1))*2.2));
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos,3));
  g.setAttribute('color',    new THREE.BufferAttribute(col,3));
  g.setAttribute('psize',    new THREE.BufferAttribute(siz,1));
  return new THREE.Points(g, ringPointMaterial(true));
}

/* 空心圈狀點：讓星團與恆星在視覺上可區分（恆星是實心亮點） */
function ringPointMaterial(solid){
  return new THREE.ShaderMaterial({
    transparent:true, depthWrite:false, vertexColors:true,
    blending:THREE.AdditiveBlending,
    vertexShader:`attribute float psize; varying vec3 vC;
      void main(){ vC=color; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);
        gl_PointSize=psize; }`,
    fragmentShader: solid
      ? `varying vec3 vC;
         void main(){ float r=length(gl_PointCoord-0.5); if(r>0.5) discard;
           gl_FragColor=vec4(vC, smoothstep(0.5,0.05,r)*0.95); }`
      : `varying vec3 vC;
         void main(){ float r=length(gl_PointCoord-0.5); if(r>0.5) discard;
           float ring=smoothstep(0.5,0.40,r)*smoothstep(0.20,0.32,r);
           float core=smoothstep(0.14,0.0,r)*0.55;
           gl_FragColor=vec4(vC, ring*0.95+core); }`
  });
}

/* 梅西耶天體清單（含方向），供標籤與清單使用 */
export function messierList(date, R){
  const D = DATA.dso, jd = toJD(date), out = [];
  for(let i=0;i<D.n;i++){
    if(D.messier[i] == null) continue;
    out.push({ i, m:D.messier[i], name:D.name[i], common:D.common[i],
               type:D.type_names[D.type[i]], mag:D.mag[i], size_arcmin:D.size[i],
               dir: dirFromRaDec(D.ra[i], D.dec[i], jd).multiplyScalar(R) });
  }
  out.sort((a,b)=>a.m-b.m);
  return out;
}

/* 統計摘要（供介面顯示） */
export function summary(){
  const E = DATA.exoplanets, D = DATA.dso;
  const byType = {};
  for(let i=0;i<D.n;i++){
    const t = D.type_names[D.type[i]];
    byType[t] = (byType[t]||0)+1;
  }
  const byMethod = {};
  for(let i=0;i<E.n;i++){
    const m = E.method_names[E.method[i]];
    byMethod[m] = (byMethod[m]||0)+1;
  }
  const dists = E.dist_pc.filter(x=>x!=null);
  return { exo:E.n, dso:D.n, byType, byMethod,
           nearest_pc: Math.min(...dists), farthest_pc: Math.max(...dists) };
}
