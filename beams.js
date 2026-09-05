/* beams.js — 多波束蜂巢覆蓋
   真實依據：
   1. 相鄰波束中心間隔取 HPBW，交越點即 −3 dB 等值線（業界常規蜂巢排布）。
   2. 每個波束的地面覆蓋 = 半角 HPBW/2 的圓錐與 WGS84 橢球的交線，
      逐射線求交後得到真實橢圓（趨近天底為圓、趨近臨邊拉長）。
   3. 著色為四色頻率重用（2 頻段 × 2 極化，N=4），
      色碼 c=(q+2r) mod 4 可證六個相鄰波束皆與中心異色。
   【模型簡化】未含波束成形旁瓣與相鄰波束干擾（C/I），故不得由此判定容量。 */
import * as THREE from 'three';

export const REUSE = [
  {name:'F1 / RHCP', color:0x35d6ff},
  {name:'F1 / LHCP', color:0x7d6bff},
  {name:'F2 / RHCP', color:0xffb03a},
  {name:'F2 / LHCP', color:0xff5ec8}
];

const d2r = Math.PI/180;
const _Y = new THREE.Vector3(0,1,0);

/* 產生六角晶格的軸向座標 (q,r)，環數 rings */
function hexAxial(rings){
  const out=[[0,0]];
  for(let R=1;R<=rings;R++){
    let q=R, r=0;
    const dirs=[[-1,1],[-1,0],[0,-1],[1,-1],[1,0],[0,1]];
    for(const [dq,dr] of dirs)
      for(let i=0;i<R;i++){ out.push([q,r]); q+=dq; r+=dr; }
  }
  return out;
}

/* 射線與半徑 R 的球求交，回傳最近正根，無交回傳 null */
function raySphere(o, d, R){
  const b = o.dot(d), c = o.lengthSq()-R*R, disc = b*b-c;
  if(disc <= 0) return null;
  const t = -b - Math.sqrt(disc);
  return t > 0 ? t : null;
}

/**
 * @param satScene  衛星位置（場景座標，未反扁平化）
 * @param hpbw_deg  單波束半功率波束寬
 * @param rings     蜂巢環數
 * @param gmst      當前 GMST（用於轉回 ellip 群組 local 空間）
 * @param Rl        地球赤道半徑（場景單位）
 * @param FLAT      WGS84 極半徑比
 */
export function buildHive({satScene, hpbw_deg, rings, gmst, Rl, FLAT, ringPts=20}){
  // 轉到「未扁平化球空間」求交，之後由 ellip 群組的縮放還原扁率
  const A = new THREE.Vector3(satScene.x, satScene.y/FLAT, satScene.z);
  const nadir = A.clone().negate().normalize();
  const u1 = new THREE.Vector3().crossVectors(nadir, Math.abs(nadir.y)<0.9?_Y:new THREE.Vector3(1,0,0)).normalize();
  const u2 = new THREE.Vector3().crossVectors(nadir, u1).normalize();

  const s    = hpbw_deg*d2r;                 // 波束間距 = HPBW
  const half = hpbw_deg/2*d2r;               // −3 dB 半角
  const limb = Math.asin(Math.min(1, Rl/A.length()));

  const cells = hexAxial(rings);
  const linePos=[], lineCol=[], fillPos=[], fillCol=[];
  const tmp=new THREE.Vector3(), c=new THREE.Color();
  let drawn=0, culled=0;

  for(const [q,r] of cells){
    // 六角晶格 -> 角度偏移（軸向轉直角）
    const ax = s*(q + r*0.5), ay = s*(r*Math.sqrt(3)/2);
    const off = Math.hypot(ax, ay);
    if(off > limb*0.995){ culled++; continue; }       // 超出地球臨邊

    const bore = nadir.clone()
      .addScaledVector(u1, Math.tan(ax))
      .addScaledVector(u2, Math.tan(ay)).normalize();
    const tc = raySphere(A, bore, Rl);
    if(tc === null){ culled++; continue; }

    const idx = ((q + 2*r) % 4 + 4) % 4;
    c.setHex(REUSE[idx].color);
    // 臨邊波束因入射角變淺而增益下降，用亮度反映（非嚴謹增益，僅視覺提示）
    const dim = 0.55 + 0.45*Math.cos(off);

    const center = A.clone().addScaledVector(bore, tc).setLength(Rl*1.0016)
                    .applyAxisAngle(_Y, -gmst);

    // 波束邊緣：繞 boresight 一圈取 −3 dB 方向逐一求交
    const b1 = new THREE.Vector3().crossVectors(bore, Math.abs(bore.y)<0.9?_Y:new THREE.Vector3(1,0,0)).normalize();
    const b2 = new THREE.Vector3().crossVectors(bore, b1).normalize();
    const ring=[];
    let bad=false;
    for(let k=0;k<ringPts;k++){
      const a = k/ringPts*Math.PI*2;
      tmp.copy(bore).addScaledVector(b1, Math.tan(half)*Math.cos(a))
                    .addScaledVector(b2, Math.tan(half)*Math.sin(a)).normalize();
      const t = raySphere(A, tmp, Rl);
      if(t === null){ bad=true; break; }
      ring.push(A.clone().addScaledVector(tmp, t).setLength(Rl*1.0016).applyAxisAngle(_Y, -gmst));
    }
    if(bad){ culled++; continue; }

    for(let k=0;k<ringPts;k++){
      const p=ring[k], n=ring[(k+1)%ringPts];
      linePos.push(p.x,p.y,p.z, n.x,n.y,n.z);
      for(let m=0;m<2;m++) lineCol.push(c.r*dim, c.g*dim, c.b*dim);
      fillPos.push(center.x,center.y,center.z, p.x,p.y,p.z, n.x,n.y,n.z);
      for(let m=0;m<3;m++) fillCol.push(c.r*dim*0.75, c.g*dim*0.75, c.b*dim*0.75);
    }
    drawn++;
  }

  const mk = (pos,col) => {
    const g=new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos,3));
    g.setAttribute('color',    new THREE.Float32BufferAttribute(col,3));
    return g;
  };
  return { lineGeo: mk(linePos,lineCol), fillGeo: mk(fillPos,fillCol),
           drawn, culled, spacing_deg: hpbw_deg };
}
