/* cams.js — 全球公開即時影像圖層
   來源與查證方式：
     · YouTube 直播 — 以 YouTube 的「直播中」篩選搜尋，再逐一查證兩件事：
       (1) 該影片當下確實在直播；(2) 影片允許嵌入。兩者皆通過才收錄。
       另加「標題／頻道必須含該地點關鍵字」的比對，避免把搜尋詞的座標
       套到不相干的直播上（實測會發生：查『特羅姆瑟』回傳阿拉斯加 Fairbanks）。
     · 座標 — OpenStreetMap Nominatim 地理編碼。

   【座標精度｜必讀】YouTube 直播本身不提供攝影機座標，因此收錄的是
   「地點中心點」，不是攝影機實際架設位置，誤差可達數公里。介面上標為
   「地點級」。這與衛星位置（公尺級）是完全不同等級的資料，不可混為一談。

   【時效性】直播會下線、頻道會關閉。清單是建置當下查證的快照，
   介面會顯示查證時間；播不出來屬正常，不是程式錯誤。 */
import * as THREE from 'three';

let DATA = null;
export async function loadCams(url){
  DATA = await (await fetch(url || 'cams.json')).json();
  return DATA;
}
export const camsMeta = () => DATA;
export const camList  = () => (DATA ? DATA.cams : []);

const d2r = Math.PI/180;

/* 大地座標 → ellip 群組的 local 空間（與地面站相同的處理：
   先算 WGS84 橢球上的 ECEF，再把 y 反扁平化，交由群組的縮放還原） */
export function camLocal(lat, lon, U, FLAT, RE_km, alt_km = 3){
  const la = lat*d2r, lo = lon*d2r;
  // FLAT 是極半徑／赤道半徑之比 b/a，因此第一偏心率平方 e² = 1 − (b/a)²。
  // 這裡原本寫成 e² = 1 − (1−FLAT)²，把「扁率 f」誤當成 b/a：
  // 得到 e² ≈ 0.99999 而非 0.00669，N 被放大、z 幾乎歸零，
  // 所有標記被壓向赤道（日月潭 23.85°N 落到 0.01°，偏約 2,650 km）。
  // 點擊仍會開到正確的攝影機（pickCam 用同一組座標），所以肉眼不易察覺。
  const e2 = 1 - FLAT*FLAT;
  const N = RE_km/Math.sqrt(1 - e2*Math.sin(la)*Math.sin(la));
  const x = (N+alt_km)*Math.cos(la)*Math.cos(lo);
  const y = (N+alt_km)*Math.cos(la)*Math.sin(lo);
  const z = (N*(1-e2)+alt_km)*Math.sin(la);
  return new THREE.Vector3(x/U, z/U/FLAT, -y/U);
}

export const KIND_COLOR = { scenic: 0x6ee7a8, city: 0x7ab8ff,
                            snapshot: 0xffc24d, mjpeg: 0xffc24d };
export const KIND_LABEL = { scenic:'風景', city:'街景', snapshot:'公務', mjpeg:'公務' };

/* 建立標記圖層：一個 Points 批次繪製所有攝影機 */
export function buildCamLayer(U, FLAT, RE_km){
  const cams = camList(), n = cams.length;
  const pos = new Float32Array(n*3), col = new Float32Array(n*3), siz = new Float32Array(n);
  const c = new THREE.Color();
  for(let i=0;i<n;i++){
    const v = camLocal(cams[i].lat, cams[i].lon, U, FLAT, RE_km);
    pos[i*3]=v.x; pos[i*3+1]=v.y; pos[i*3+2]=v.z;
    c.setHex(KIND_COLOR[cams[i].kind] || 0x6ee7a8);
    col[i*3]=c.r; col[i*3+1]=c.g; col[i*3+2]=c.b;
    siz[i]=9.0;
    cams[i]._v = v;                                  // 供點擊測試與相機對位
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos,3));
  g.setAttribute('color',    new THREE.BufferAttribute(col,3));
  g.setAttribute('psize',    new THREE.BufferAttribute(siz,1));
  const m = new THREE.ShaderMaterial({
    transparent:true, depthWrite:false, vertexColors:true,
    vertexShader:`attribute float psize; varying vec3 vC;
      void main(){ vC=color; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);
        gl_PointSize=psize; }`,
    fragmentShader:`varying vec3 vC;
      void main(){ vec2 p=gl_PointCoord-0.5; float r=length(p);
        if(r>0.5) discard;
        // 外環＋中心點，與衛星的實心點在視覺上區隔
        float ring=smoothstep(0.50,0.40,r)*smoothstep(0.26,0.36,r);
        float core=smoothstep(0.16,0.02,r);
        gl_FragColor=vec4(vC, ring*0.95 + core*0.9); }`
  });
  const pts = new THREE.Points(g, m);
  pts.frustumCulled = false;
  return pts;
}

/* 螢幕空間最近點選取：回傳點到攝影機的索引，或 -1 */
export function pickCam(ndcX, ndcY, camera, group, maxPx, w, h){
  const cams = camList();
  let best = -1, bestD = maxPx*maxPx;
  const v = new THREE.Vector3();
  for(let i=0;i<cams.length;i++){
    if(!cams[i]._v) continue;
    v.copy(cams[i]._v).applyMatrix4(group.matrixWorld).project(camera);
    if(v.z < -1 || v.z > 1) continue;
    const dx = (v.x - ndcX)*w*0.5, dy = (v.y - ndcY)*h*0.5;
    const d = dx*dx + dy*dy;
    if(d < bestD){ bestD = d; best = i; }
  }
  return best;
}

/* 產生播放器。三種來源：
     youtube  官方 iframe 嵌入
     mjpeg    multipart/x-mixed-replace，瀏覽器的 <img> 原生支援連續更新
     snapshot 政府攝影機的靜態 JPEG，需自行定時重取（見 startPlayer）
   注意 <img> 不受 CORS 限制（只有要讀像素才需要），因此可直接顯示。 */
export function playerHTML(cam){
  if(cam.kind === 'mjpeg' || cam.kind === 'snapshot'){
    return `<img id="c_img" src="${cam.url}" alt="${cam.zh}" referrerpolicy="no-referrer"
            style="width:100%;aspect-ratio:16/9;object-fit:cover;background:#000;border:0">`;
  }
  const src = `https://www.youtube-nocookie.com/embed/${cam.id}`
            + `?autoplay=1&mute=1&playsinline=1&modestbranding=1&rel=0`;
  return `<iframe src="${src}" allow="autoplay; encrypted-media; picture-in-picture"
          allowfullscreen referrerpolicy="strict-origin-when-cross-origin"
          style="width:100%;aspect-ratio:16/9;border:0;background:#000"></iframe>`;
}

/* 靜態快照要自己更新。多數公務攝影機每 10–60 秒換一張，這裡取 12 秒；
   加時間戳避免瀏覽器沿用快取。回傳停止函式，關閉面板時必須呼叫，
   否則計時器會留著繼續抓圖。 */
export function startPlayer(cam){
  if(cam.kind !== 'snapshot') return () => {};
  const base = cam.url + (cam.url.includes('?') ? '&' : '?') + 't=';
  const id = setInterval(() => {
    const el = document.getElementById('c_img');
    if(!el){ clearInterval(id); return; }
    el.src = base + Date.now();
  }, 12000);
  return () => clearInterval(id);
}

export function camSourceLine(cam, fetched){
  const prec = cam.geo_precision === 'exact'
    ? '<span style="color:#5ff0c8">座標為攝影機實際位置</span>'
    : '<span style="color:#ffc24d">座標為地點中心，非攝影機架設點（可差數公里）</span>';
  const gov = cam.kind === 'mjpeg' || cam.kind === 'snapshot';
  const via = gov
    ? (cam.provider || '公開攝影機') + (cam.note ? '<br>' + cam.note : '')
    : `YouTube 直播 · 頻道 ${cam.channel || '—'}` + (cam.viewers ? ` · 查證時 ${cam.viewers} 人在看` : '');
  const tail = gov
    ? '每 12 秒自動更新一張；為靜態快照而非連續視訊'
    : `清單查證於 ${fetched || '—'}；直播可能已下線`;
  return `${via}<br>${prec}<br>${tail}`;
}
