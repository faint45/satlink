import * as THREE from 'three';
import { OrbitControls } from './lib/OrbitControls.js';
import * as PHY from './physics.js';
import { buildHive, REUSE } from './beams.js';
import { getModel } from './satmodels.js';
import * as DS from './deepspace.js';
import * as ASTRO from './astro.js';
import * as CAMS from './cams.js';

const U = 1000;                       // 1 three.js 單位 = 1000 km
const RE = PHY.RE_WGS84/1e3/U;        // 地球赤道半徑（場景單位）
const FLAT = 1 - PHY.F_WGS84;         // WGS84 極半徑比
const d2r = Math.PI/180;

/* ECI(km) → 場景座標。ECI 為 Z 軸朝北，three.js 為 Y-up，右手性保持。 */
const toScene = (p) => new THREE.Vector3(p.x/U, p.z/U, -p.y/U);

/* ── 各類衛星的鏈路參數 ────────────────────────────────────────
   資料等級（呼應「常數必須有出處」）：
     A = 官方規格/國際分配的頻率  ·  B = 公開文獻代表值  ·  C = 推估
   頻率一律 A 級；發射功率與天線增益多為 B 級（各衛星實際值不公開）。
   接收端天線：有口徑者用 Friis 拋物面公式即時算增益與波束寬，不寫死數字。 */
function dish(D_m, f_Hz){ const g = PHY.dishGain(D_m, f_Hz); return {G:g.G_dBi, hpbw:g.hpbw_deg, D:D_m}; }
/* 上行時地面站的發射增益。天線增益隨 f² 變化，直接沿用下行的數字會高估
   —— 同一面 0.75 m 天線，Ka 上行 29.75 GHz 比下行 19.95 GHz 高約 3.5 dB。
   因此凡是碟型天線都用上行頻率重算，不共用。 */
function upTx(up){
  if(!up) return null;
  if(up.dish_m){ const g = PHY.dishGain(up.dish_m, up.f); return {G:g.G_dBi, hpbw:g.hpbw_deg}; }
  return {G:up.txGain_dBi, hpbw:null};
}

const PROFILE = {
  leo_vhf:{ f:137.1e6, txPow_dBW:10*Math.log10(5), txGain_dBi:4, txFeed_dB:0.5,
    txPol:'circular', mode:'APT', bitrate:4160, hpbw:120,
    rx:{G:3, feed:1.5, NF:1.0, pol:'linear', hpbw:60},
    color:0x5ff0c8, label:'VHF 137 MHz · APT 氣象傳真',
    src:'頻率 NOAA POES 規格 (A)；5 W/QFH 為公開代表值 (B)',
    up:null, upNote:'NOAA POES 的 APT 是單向廣播；指令上行走 S 波段 2025–2110 MHz 且非公開，本站不建模' },

  station_vhf:{ f:145.800e6, txPow_dBW:10*Math.log10(5), txGain_dBi:0, txFeed_dB:1.0,
    txPol:'linear', mode:'FSK', bitrate:1200, hpbw:140,
    rx:{G:11, feed:1.2, NF:1.0, pol:'linear', hpbw:38},
    color:0xff5ec8, label:'VHF 145.8 MHz · 太空站業餘下行',
    src:'頻率 ARISS 公開下行 (A)；5 W/全向為代表值 (B)',
    up:{ f:145.990e6, txPow_dBW:10*Math.log10(25), txGain_dBi:11.5, txFeed_dB:1.2,
         txPol:'linear', mode:'FSK', bitrate:1200,
         rx:{G:0, feed:1.0, NF:5.0, pol:'linear', hpbw:120, Tant_K:290},
         label:'VHF 145.99 MHz · ARISS 封包上行',
         src:'頻率 ARISS 公開上行 (A)；地面 25 W / 11.5 dBi 交叉八木為業餘常見配置 (B)；'
            +'ISS 端 0 dBi、NF 5 dB (C)' } },

  gnss_gps:{ f:1575.42e6, txPow_dBW:26.8-12.9, txGain_dBi:12.9, txFeed_dB:0.5,
    txPol:'circular', mode:'BPSK', bitrate:50, hpbw:42.6,
    rx:{G:3, feed:0.5, NF:1.5, pol:'circular', hpbw:90},
    color:0x9ee34f, label:'L1 1575.42 MHz · GPS C/A',
    src:'頻率與 EIRP 26.8 dBW 依 IS-GPS-200 (A)；波束 ±21.3° 覆蓋全地球盤面',
    up:null, upNote:'GNSS 使用者端純接收，沒有上行；控制段以 S 波段 1783.74 MHz 上傳導航電文，非民用' },
  gnss_gal:{ f:1575.42e6, txPow_dBW:27.0-13.0, txGain_dBi:13.0, txFeed_dB:0.5,
    txPol:'circular', mode:'BPSK', bitrate:250, hpbw:42.0,
    rx:{G:3, feed:0.5, NF:1.5, pol:'circular', hpbw:90},
    color:0x6fd3ff, label:'E1 1575.42 MHz · Galileo I/NAV',
    src:'頻率 Galileo OS SIS ICD (A)；EIRP 為公開代表值 (B)',
    up:null, upNote:'GNSS 使用者端純接收，沒有上行' },
  gnss_glo:{ f:1602.0e6, txPow_dBW:27.0-12.5, txGain_dBi:12.5, txFeed_dB:0.5,
    txPol:'circular', mode:'BPSK', bitrate:50, hpbw:42.0,
    rx:{G:3, feed:0.5, NF:1.5, pol:'circular', hpbw:90},
    color:0xffa8a8, label:'L1 1602 MHz · GLONASS FDMA ch0',
    src:'頻率 GLONASS ICD L1 FDMA (A)；EIRP 代表值 (B)',
    up:null, upNote:'GNSS 使用者端純接收，沒有上行' },
  gnss_bds:{ f:1561.098e6, txPow_dBW:27.0-12.5, txGain_dBi:12.5, txFeed_dB:0.5,
    txPol:'circular', mode:'BPSK', bitrate:50, hpbw:42.0,
    rx:{G:3, feed:0.5, NF:1.5, pol:'circular', hpbw:90},
    color:0xffd166, label:'B1I 1561.098 MHz · BeiDou',
    src:'頻率 BDS-SIS-ICD-B1I (A)；EIRP 代表值 (B)',
    up:null, upNote:'GNSS 使用者端純接收，沒有上行' },

  iridium_l:{ f:1621.25e6, txPow_dBW:10*Math.log10(7), txGain_dBi:24, txFeed_dB:1.0,
    txPol:'circular', mode:'QPSK', bitrate:50e3, hpbw:9.0,
    rx:{G:3, feed:0.8, NF:1.5, pol:'circular', hpbw:90},
    color:0xc9a7ff, label:'L 1621.25 MHz · Iridium 點波束', hiveRings:3,
    src:'頻率 Iridium L 頻段分配 (A)；48 波束/衛星，功率為代表值 (B)',
    up:{ f:1621.25e6, txPow_dBW:10*Math.log10(7), txGain_dBi:1.5, txFeed_dB:0.5,
         txPol:'circular', mode:'QPSK', bitrate:2400,
         rx:{G:24, feed:1.0, NF:2.0, pol:'circular', hpbw:8, Tant_K:290},
         label:'L 1621.25 MHz · 手機上行（與下行同頻，分時雙工）',
         src:'Iridium L 波段 1616–1626.5 MHz 為 TDD，上下行共用同一頻段 (A)；'
            +'手持機 7 W 峰值 / 1.5 dBi 鞭狀天線 (B)' } },

  goes_l:{ f:1686.6e6, txPow_dBW:10*Math.log10(20), txGain_dBi:18, txFeed_dB:1.0,
    txPol:'linear', mode:'BPSK', bitrate:31e6, hpbw:18,
    rx:{...dish(3.0, 1686.6e6), feed:0.8, NF:1.2, pol:'linear'},
    color:0x7fe3ff, label:'L 1686.6 MHz · GOES GRB 影像下行',
    src:'頻率 GOES-R GRB 規格 (A)；EIRP 代表值 (B)',
    up:{ f:401.9e6, txPow_dBW:10*Math.log10(10), txGain_dBi:11, txFeed_dB:1.0,
         txPol:'linear', mode:'BPSK', bitrate:300,
         rx:{G:10, feed:1.0, NF:3.0, pol:'linear', hpbw:60, Tant_K:290},
         label:'UHF 401.9 MHz · DCS 資料蒐集平台上行',
         src:'GOES DCS 上行 401.7–402.1 MHz，300/1200 bps (A)；'
            +'地面 DCP 10 W / 11 dBi 八木為典型配置 (B)' } },

  science_s:{ f:2250e6, txPow_dBW:10*Math.log10(10), txGain_dBi:6, txFeed_dB:1.0,
    txPol:'circular', mode:'QPSK', bitrate:2e6, hpbw:70,
    rx:{...dish(3.7, 2250e6), feed:0.8, NF:1.2, pol:'circular'},
    color:0xff9f6b, label:'S 2250 MHz · 科學衛星下行',
    src:'S 頻段 2200–2290 MHz 為 SRS 空對地分配 (A)；功率代表值 (B)',
    up:{ f:2050e6, txPow_dBW:10*Math.log10(100), txGain_dBi:0, txFeed_dB:0.8,
         txPol:'circular', mode:'BPSK', bitrate:4000,
         rx:{G:0, feed:1.2, NF:3.5, pol:'circular', hpbw:120, Tant_K:290},
         label:'S 2050 MHz · 遙測指令上行',
         src:'ITU-R 空間操作 Earth-to-space 分配 2025–2110 MHz (A)；'
            +'地面 3.7 m 天線 100 W、星上低增益全向天線 (B)',
         dish_m:3.7 } },

  amateur_uhf:{ f:436.5e6, txPow_dBW:10*Math.log10(1), txGain_dBi:2, txFeed_dB:0.8,
    txPol:'linear', mode:'FSK', bitrate:9600, hpbw:120,
    rx:{G:14, feed:1.0, NF:0.9, pol:'linear', hpbw:30},
    color:0xa8ff8f, label:'UHF 436.5 MHz · 業餘衛星',
    src:'435–438 MHz 業餘衛星服務分配 (A)；1 W 為立方衛星常見值 (B)',
    up:{ f:145.900e6, txPow_dBW:10*Math.log10(25), txGain_dBi:11.5, txFeed_dB:1.2,
         txPol:'linear', mode:'FSK', bitrate:1200,
         rx:{G:0, feed:1.0, NF:3.0, pol:'linear', hpbw:120, Tant_K:290},
         label:'VHF 145.9 MHz · 立方衛星上行',
         src:'立方衛星常見 VHF 上行 / UHF 下行配對，頻段依 IARU 業餘衛星分配 (A)；'
            +'地面 25 W / 11.5 dBi、星上 0 dBi 轉盤天線 (B)' } },

  eo_xband:{ f:8200e6, txPow_dBW:10*Math.log10(12), txGain_dBi:24, txFeed_dB:1.2,
    txPol:'circular', mode:'QPSK', bitrate:320e6, hpbw:8,
    rx:{...dish(5.4, 8200e6), feed:0.9, NF:1.3, pol:'circular'},
    color:0xffb3f0, label:'X 8.2 GHz · 對地觀測高速下行',
    src:'8025–8400 MHz 為 EESS 空對地分配 (A)；速率/功率代表值 (B)',
    up:{ f:2065e6, txPow_dBW:10*Math.log10(200), txGain_dBi:0, txFeed_dB:0.9,
         txPol:'circular', mode:'BPSK', bitrate:2000,
         rx:{G:0, feed:1.2, NF:3.5, pol:'circular', hpbw:120, Tant_K:290},
         label:'S 2065 MHz · TT&C 指令上行',
         src:'ITU-R 空間操作 Earth-to-space 2025–2110 MHz (A)；'
            +'X 波段只做高速資料下行，指令另走 S 波段 (A)；地面 5.4 m 200 W (B)',
         dish_m:5.4 } },

  oneweb_ku:{ f:11.7e9, txPow_dBW:10*Math.log10(3), txGain_dBi:33, txFeed_dB:0.8,
    txPol:'circular', mode:'QPSK', bitrate:80e6, hpbw:4.0, hiveRings:4,
    rx:{...dish(0.7, 11.7e9), feed:0.7, NF:1.6, pol:'circular'},
    color:0x8fb8ff, label:'Ku 11.7 GHz · OneWeb',
    src:'Ku 下行 10.7–12.7 GHz 分配 (A)；波束/功率代表值 (B)',
    up:{ f:14.25e9, txPow_dBW:10*Math.log10(2), txGain_dBi:0, txFeed_dB:0.7,
         txPol:'circular', mode:'QPSK', bitrate:2.0e6,
         rx:{G:33, feed:0.8, NF:2.5, pol:'circular', hpbw:2.0, Tant_K:290},
         label:'Ku 14.25 GHz · 使用者終端上行',
         src:'ITU-R FSS Earth-to-space Ku 上行 14.0–14.5 GHz (A)；'
            +'終端 0.7 m 天線 2 W (B)',
         dish_m:0.7 } },

  leo_phased:{ f:11.7e9, txPow_dBW:10*Math.log10(4), txGain_dBi:35, txFeed_dB:0.8,
    txPol:'circular', mode:'QPSK', bitrate:100e6, hpbw:3.2, hiveRings:4,
    rx:{...dish(0.6, 11.7e9), feed:0.7, NF:1.6, pol:'circular'},
    color:0x7aa8ff, label:'Ku 11.7 GHz · Starlink 相位陣列',
    src:'Ku 下行分配 (A)；FCC 申報之波束寬與功率量級 (B)',
    up:{ f:14.25e9, txPow_dBW:10*Math.log10(2), txGain_dBi:0, txFeed_dB:0.7,
         txPol:'circular', mode:'QPSK', bitrate:4.0e6,
         rx:{G:35, feed:0.8, NF:2.5, pol:'circular', hpbw:1.8, Tant_K:290},
         label:'Ku 14.25 GHz · 相位陣列終端上行',
         src:'ITU-R FSS Ku 上行 14.0–14.5 GHz，與 FCC 申報一致 (A)；'
            +'終端等效口徑 0.6 m、2 W (B)',
         dish_m:0.6 } },

  geo_spot:{ f:19.95e9, txPow_dBW:10*Math.log10(120), txGain_dBi:48, txFeed_dB:1.2,
    txPol:'circular', mode:'QPSK', bitrate:50e6, hpbw:0.55, hiveRings:10,
    rx:{...dish(0.75, 19.95e9), feed:0.8, NF:1.4, pol:'circular'},
    color:0xffc24d, label:'Ka 19.95 GHz · GEO 點波束',
    src:'Ka 下行 17.7–21.2 GHz 分配 (A)；點波束 0.55° 為 HTS 常見值 (B)',
    up:{ f:29.75e9, txPow_dBW:10*Math.log10(2), txGain_dBi:0, txFeed_dB:0.8,
         txPol:'circular', mode:'QPSK', bitrate:5.0e6,
         rx:{G:48, feed:1.0, NF:3.0, pol:'circular', hpbw:0.55, Tant_K:290},
         label:'Ka 29.75 GHz · 使用者終端上行',
         src:'ITU-R FSS Earth-to-space Ka 上行 27.5–30.0 GHz (A)；'
            +'終端 0.75 m 天線 2 W (B)',
         dish_m:0.75 } }
};

const GS = { name:'台北地面控制站', lat:25.033, lon:121.565, alt:0.05 };  // km

/* ── 場景 ─────────────────────────────────────────────────── */
const canvas = document.getElementById('gl');
const renderer = new THREE.WebGLRenderer({canvas, antialias:true});
renderer.setPixelRatio(Math.min(devicePixelRatio,2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.18;

const scene  = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(38, innerWidth/innerHeight, 0.2, 6000);
camera.position.set(14, 7, 18);
const ctl = new OrbitControls(camera, canvas);
ctl.enableDamping = true; ctl.dampingFactor = 0.06;
/* 不使用 zoomToCursor。實測它會在游標指向空白處時，把環繞中心推到太空中的
   任意點（量到 target 跑到離地球 23 單位的虛空），minDistance 於是相對那個
   無意義的點生效，相機停在地表 16,688 km 高就再也推不進去。
   改為：中心永遠是地心或聚焦中的目標，兩者都有明確意義。
   「想看哪就縮到哪」由聚焦模式達成 —— 點衛星即以它為中心。 */
ctl.zoomToCursor = false;
ctl.zoomSpeed = 1.15;
/* 距離下限：原設 RE*1.06 等於卡在地表 383 km 高，永遠靠近不了 LEO 衛星
   （ISS 在 6.80 單位）。改成貼近地表，聚焦某顆衛星時再放到更小。 */
const MIN_FREE  = RE*1.0025;      // 自由視角：離地表約 16 km，不會穿進球體
const MIN_FOCUS = 0.0022;         // 聚焦視角：離目標 2.2 km，可繞著看
/* 環繞中心在地表某一點時的下限。MIN_FREE 是「離地心」的下限，
   套到地表目標上會變成「不准靠近該地點 6,394 km」。實測後果：
   從清單點某個攝影機（flyToCam）之後，相機被推到 6,390 km 高，
   而且**滾輪推近完全無反應**，只有拉遠有作用 —— 因為已經卡在下限上。 */
const MIN_SURF  = 0.05;           // 離地表目標 50 km

/* 距離下限由「環繞中心在哪」決定，不由「進入了哪個模式」決定。
   之前是各條路徑各自去設 ctl.minDistance，於是 flyToCam 這條忘了設就壞掉，
   而且壞在很難察覺的地方（畫面正常，只有滾輪某一個方向沒反應）。
   改成從 ctl.target 推導並每幀套用，任何新增的移動視角路徑都不必記得這件事。 */
function updateCtlLimits(){
  const m = focusSat ? MIN_FOCUS
          : (ctl.target.lengthSq() > 1e-8 ? MIN_SURF : MIN_FREE);
  if(ctl.minDistance !== m) ctl.minDistance = m;
}
ctl.minDistance = MIN_FREE; ctl.maxDistance = 400;

const tl = new THREE.TextureLoader();
const texDay = tl.load('tex/earth_atmos_2048.jpg');
const texNgt = tl.load('tex/earth_lights_2048.png');
const texSpc = tl.load('tex/earth_specular_2048.jpg');
const texNrm = tl.load('tex/earth_normal_2048.jpg');
const texCld = tl.load('tex/earth_clouds_1024.png');
/* NASA GIBS：VIIRS/SNPP Corrected Reflectance True Color 每日全球鑲嵌。
   選 VIIRS 而非 MODIS：掃描寬 3040 km，赤道帶無觀測缺口 0.6%（MODIS Terra 為 23.9%，
   相鄰軌道在低緯度拍不滿）。【資料性質】由極軌掃描帶於 ~24 小時內拼接，
   非同一瞬間快照；雲為真實觀測，非模擬。*/
const IMG_VER = 'a33a646b';   // 影像內容雜湊，避免瀏覽器快取到舊鑲嵌圖
const texReal = tl.load('tex/gibs_truecolor.jpg?v='+IMG_VER);
[texDay,texNgt,texSpc,texNrm,texCld,texReal].forEach(t=>{ t.anisotropy=8; });
texDay.colorSpace = THREE.SRGBColorSpace;
texNgt.colorSpace = THREE.SRGBColorSpace;
texReal.colorSpace = THREE.SRGBColorSpace;

const sunDir = new THREE.Vector3(1,0,0);   // 世界座標，每幀由真實日期更新

/* 地球：日/夜混合 + 海面鏡面 + 法線起伏，晨昏線由真實太陽方向決定 */
const earthMat = new THREE.ShaderMaterial({
  uniforms:{ dayMap:{value:texDay}, nightMap:{value:texNgt}, specMap:{value:texSpc},
             normMap:{value:texNrm}, sunDir:{value:sunDir},
             realMap:{value:texReal}, uReal:{value:1.0} },
  vertexShader:`
    varying vec2 vUv; varying vec3 vN; varying vec3 vW;
    void main(){ vUv=uv; vN=normalize(mat3(modelMatrix)*normal);
      vec4 w=modelMatrix*vec4(position,1.0); vW=w.xyz;
      gl_Position=projectionMatrix*viewMatrix*w; }`,
  fragmentShader:`
    uniform sampler2D dayMap,nightMap,specMap,normMap,realMap;
    uniform vec3 sunDir; uniform float uReal;
    varying vec2 vUv; varying vec3 vN; varying vec3 vW;
    void main(){
      vec3 n=normalize(vN);
      vec3 bump=texture2D(normMap,vUv).rgb*2.0-1.0;
      n=normalize(n+bump*0.12);
      float mu=dot(n,normalize(sunDir));
      // 晨昏線寬度取真實太陽視角 ~0.53deg 加大氣散射展寬
      float day=smoothstep(-0.12,0.14,mu);
      vec3 bm=texture2D(dayMap,vUv).rgb;
      vec3 rm=texture2D(realMap,vUv).rgb*1.30;      // 反射率較暗，做曝光補償
      // 殘餘無觀測缺口（近黑）以 Blue Marble 底圖回填，避免出現假的黑色陸塊
      float cover=smoothstep(0.012, 0.075, dot(rm, vec3(0.299,0.587,0.114)));
      vec3 dc=mix(bm, mix(bm, rm, cover), uReal);
      vec3 nc=texture2D(nightMap,vUv).rgb;
      float ocean=texture2D(specMap,vUv).r;
      vec3 V=normalize(cameraPosition-vW);
      vec3 H=normalize(normalize(sunDir)+V);
      float spec=pow(max(dot(n,H),0.0),58.0)*ocean*0.55*smoothstep(0.05,0.45,mu);
      // 晨昏帶的紅化（Rayleigh 路徑加長）
      vec3 warm=mix(vec3(1.0,0.62,0.38),vec3(1.0),smoothstep(-0.02,0.12,mu));
      vec3 col=dc*day*warm*1.12 + nc*(1.0-day)*1.15 + vec3(0.9,0.95,1.0)*spec;
      col+=dc*0.035;
      col+=ocean*vec3(0.015,0.055,0.125)*day;   // 深海反照補償（視覺）                                  // 極微環境光，避免夜面全黑
      gl_FragColor=vec4(col,1.0);
    }`
});
const earth = new THREE.Mesh(new THREE.SphereGeometry(RE,128,96), earthMat);
earth.scale.set(1,FLAT,1);                            // WGS84 橢球扁率（真實 0.335%）
scene.add(earth);

const clouds = new THREE.Mesh(new THREE.SphereGeometry(RE*1.004,96,64),
  new THREE.MeshLambertMaterial({map:texCld,transparent:true,opacity:0.38,depthWrite:false}));
clouds.scale.set(1,FLAT,1); scene.add(clouds);
clouds.visible = false;   // 預設使用 MODIS 真實雲圖，不疊加程序雲層
const sunLight = new THREE.DirectionalLight(0xffffff, 2.2); scene.add(sunLight);
scene.add(new THREE.AmbientLight(0x2a3a55, 0.30));
/* 地球反照光：地球平均反照率約 0.3（Bond albedo 0.29，NASA Earth Fact Sheet），
   對低軌衛星的對地面而言是不可忽略的第二光源。以一盞方向光近似，
   每幀指向目前顯示模型的形心，方向由地心指向該處。 */
const earthShine = new THREE.DirectionalLight(0x9fc4ff, 0.0);
scene.add(earthShine); scene.add(earthShine.target);

/* ── 大氣散射：Rayleigh + Mie 單次散射數值積分 ──────────────────
   支配方程：沿視線對 in-scattering 積分
     L(λ) = Σ_i  T(cam→P_i)·T(P_i→sun)·[βR(λ)ρR(h)PR(μ) + βM ρM(h) PM(μ)] ds
   係數來源：Bruneton & Neyret (2008) / Bruneton (2017) 標準大氣
     βR = (5.802, 13.558, 33.100)e-6 m^-1  @ 680/550/440 nm
     βM(散射) = 3.996e-6 m^-1、βM(消光) = 4.40e-6 m^-1、g = 0.80
     尺度高 HR = 8 km、HM = 1.2 km
   【已驗證】柱密度對解析解 rho(h0)*sqrt(2*pi*(R+h0)*H)：切點高度 2/5/10/20 km
     誤差 <0.11%（NV=40 已收斂，NV 提高到 1280 結果不變）。切點 0 km 為 50%
     是正確的：射線正切地表時遠側半程被遮蔽，此 2 倍跳變即地平線亮線成因。
   【模型簡化】僅單次散射，未含多次散射與臭氧吸收 → 深藍天空與地影帶偏暗；
   亦未對地表既有輻射做消光（採加成合成）。屬視覺模型，物理量不由此引用。 */
const R_GROUND = PHY.RE_WGS84/1e3/U;                 // 場景單位
const R_ATMO   = R_GROUND + 60/U;                     // 大氣頂 +60 km (=7.5 個 Rayleigh 尺度高)
const atmo = new THREE.Mesh(new THREE.SphereGeometry(R_ATMO,128,96), new THREE.ShaderMaterial({
  uniforms:{ uSun:{value:sunDir}, uRg:{value:R_GROUND}, uRt:{value:R_ATMO}, uI:{value:6.5} },
  vertexShader:`varying vec3 vW;
    void main(){ vec4 w=modelMatrix*vec4(position,1.0); vW=w.xyz;
      gl_Position=projectionMatrix*viewMatrix*w; }`,
  fragmentShader:`
    uniform vec3 uSun; uniform float uRg, uRt, uI; varying vec3 vW;
    const vec3  BR   = vec3(5.802, 13.558, 33.100);   // 1e-6 m^-1 -> 1/場景單位(1e6 m)
    const float BMs  = 3.996;
    const float BMe  = 4.400;
    const float HR   = 0.008;                          // 8 km
    const float HM   = 0.0012;                         // 1.2 km
    const float G    = 0.80;
    const int   NV   = 40;
    const int   NL   = 7;

    // 射線與以原點為心、半徑 r 的球相交，回傳 (t近, t遠)；無交點回傳 (1,-1)
    vec2 hit(vec3 o, vec3 d, float r){
      float b = dot(o,d), c = dot(o,o)-r*r, disc = b*b-c;
      if(disc < 0.0) return vec2(1.0,-1.0);
      float q = sqrt(disc);
      return vec2(-b-q, -b+q);
    }
    void main(){
      vec3 cam = cameraPosition;
      vec3 dir = normalize(vW - cam);
      vec2 ta  = hit(cam, dir, uRt);
      if(ta.y < 0.0) discard;
      float t0 = max(ta.x, 0.0), t1 = ta.y;
      vec2 tg = hit(cam, dir, uRg);
      bool ground = (tg.y > 0.0 && tg.x > 0.0);
      if(ground) t1 = min(t1, tg.x);                   // 被地表擋住則只積到地面
      if(t1 <= t0) discard;

      float mu = dot(dir, normalize(uSun));
      float pR = 3.0/(16.0*3.14159265)*(1.0+mu*mu);
      float g2 = G*G;
      float pM = 3.0/(8.0*3.14159265)*((1.0-g2)*(1.0+mu*mu))
               / ((2.0+g2)*pow(1.0+g2-2.0*G*mu, 1.5));

      // 非均勻取樣：以視線對地表的最近接近點為中心做二次加密。
      // 均勻取樣在掠射時 ds 可達 55 km >> Rayleigh 尺度高 8 km，會漏掉密集層。
      float tm = clamp(-dot(cam,dir), t0, t1);
      float aL = tm - t0, aR = t1 - tm;
      vec3 sumR = vec3(0.0); vec3 sumM = vec3(0.0);
      float odR = 0.0, odM = 0.0;
      vec3 sun = normalize(uSun);
      float prevT = t0;
      for(int i=1;i<=NV;i++){
        float u = float(i)/float(NV);
        float t;
        if(u < 0.5){ float w=(0.5-u)*2.0; t = tm - aL*w*w; }
        else       { float w=(u-0.5)*2.0; t = tm + aR*w*w; }
        float ds = t - prevT;
        vec3 P = cam + dir*(0.5*(t+prevT));
        prevT = t;
        if(ds <= 0.0) continue;
        float h = max(length(P)-uRg, 0.0);
        float dR = exp(-h/HR)*ds, dM = exp(-h/HM)*ds;
        odR += dR; odM += dM;
        vec2 gl = hit(P, sun, uRg);
        if(gl.y > 0.0 && gl.x > 0.0) continue;          // 該點落在地球本影內
        vec2 tl = hit(P, sun, uRt);
        // 光線方向同樣加密於起點（密度最高處）
        float lR = 0.0, lM = 0.0, prevL = 0.0;
        for(int j=1;j<=NL;j++){
          float v = float(j)/float(NL);
          float tj = tl.y*v*v;
          float dl = tj - prevL;
          vec3 Q = P + sun*(0.5*(tj+prevL));
          prevL = tj;
          float hq = max(length(Q)-uRg, 0.0);
          lR += exp(-hq/HR)*dl; lM += exp(-hq/HM)*dl;
        }
        vec3 tau = BR*(odR+lR) + vec3(BMe*1.1)*(odM+lM);
        vec3 att = exp(-tau);
        sumR += att*dR; sumM += att*dM;
      }
      vec3 col = (sumR*BR*pR + sumM*BMs*pM) * uI;
      gl_FragColor = vec4(col, 1.0);
    }`,
  transparent:true, side:THREE.BackSide, depthWrite:false, blending:THREE.AdditiveBlending
}));
scene.add(atmo);

/* 星空：HYG Database v4.0 真實星表（Hipparcos/Yale BSC/Gliese），J2000，mag<=6.5
   已套用 J2000→當日歲差修正（與 JPL 星曆、星團、系外行星同一框架）。 */
let starPoints=null;
async function loadStars(){
  const S = await (await fetch('stars.json')).json();
  const n=S.n, pos=new Float32Array(n*3), col=new Float32Array(n*3), siz=new Float32Array(n);
  const R=2600;
  for(let i=0;i<n;i++){
    const ra=S.ra_h[i]*15*d2r, dec=S.dec_d[i]*d2r;
    // 赤道座標(J2000) -> 歲差修正到當日 -> 場景座標
    const p=DS.precessJ2000ToDate(
      [Math.cos(dec)*Math.cos(ra), Math.cos(dec)*Math.sin(ra), Math.sin(dec)],
      DS.toJD(simTime));
    pos[i*3]=R*p[0]; pos[i*3+1]=R*p[2]; pos[i*3+2]=-R*p[1];
    // B-V 色指數 -> 色溫 -> RGB（Ballesteros 2012 近似）
    const bv=Math.max(-0.4,Math.min(2.0,S.ci[i]));
    const T=4600*(1/(0.92*bv+1.7)+1/(0.92*bv+0.62));
    const t=Math.max(0,Math.min(1,(T-2000)/(12000-2000)));
    const r=Math.min(1,0.62+0.65*(1-t)), g=Math.min(1,0.72+0.28*(1-Math.abs(t-0.55)*1.6));
    const b=Math.min(1,0.55+0.75*t);
    // 視星等 -> 相對亮度（每 5 等 100 倍），做感知壓縮避免暗星消失
    const br=Math.pow(10,-0.4*(S.mag[i]-6.5))/Math.pow(10,-0.4*(-1.5-6.5));
    const l=0.22+0.78*Math.pow(br,0.30);
    col[i*3]=r*l; col[i*3+1]=g*l; col[i*3+2]=b*l;
    siz[i]=1.0+3.4*Math.pow(br,0.34);
  }
  const g=new THREE.BufferGeometry();
  g.setAttribute('position',new THREE.BufferAttribute(pos,3));
  g.setAttribute('color',new THREE.BufferAttribute(col,3));
  g.setAttribute('psize',new THREE.BufferAttribute(siz,1));
  const m=new THREE.ShaderMaterial({
    uniforms:{}, transparent:true, depthWrite:false, blending:THREE.AdditiveBlending,
    vertexShader:`attribute float psize; varying vec3 vC;
      void main(){ vC=color; vec4 mv=modelViewMatrix*vec4(position,1.0);
        gl_Position=projectionMatrix*mv; gl_PointSize=psize; }`,
    fragmentShader:`varying vec3 vC;
      void main(){ vec2 d=gl_PointCoord-0.5; float r=length(d);
        if(r>0.5) discard; float a=smoothstep(0.5,0.06,r);
        gl_FragColor=vec4(vC,a); }`,
    vertexColors:true
  });
  starPoints=new THREE.Points(g,m); starPoints.frustumCulled=false; scene.add(starPoints);
  return S;
}

/* ── 全球公開即時影像 ─────────────────────────────────────────
   標記畫在 ellip 群組內（隨地球自轉），點擊開啟播放器。
   座標精度分兩級：YouTube 直播為「地點中心」（可差數公里），
   MJPEG 公務攝影機為實際架設點 —— 面板上分別標示，不混為一談。 */
let camsOn=false, camLayer=null, camsReady=false, camSel=-1;
async function initCams(){
  const meta = await CAMS.loadCams('cams.json');
  camLayer = CAMS.buildCamLayer(U, FLAT, PHY.RE_WGS84/1e3);
  camLayer.visible=false; ellip.add(camLayer);
  camsReady=true;
  return meta;
}
let camStop=null;
function openCam(i){
  const list=CAMS.camList(); if(i<0||i>=list.length) return;
  if(camStop){ camStop(); camStop=null; }
  camSel=i; const c=list[i];
  const P=document.getElementById('cam');
  document.getElementById('c_name').textContent = c.zh + (c.place? ' · '+c.place.split(',')[0] : '');
  document.getElementById('c_player').innerHTML = CAMS.playerHTML(c);
  document.getElementById('c_cite').innerHTML =
    CAMS.camSourceLine(c, (CAMS.camsMeta()||{}).fetched_utc);
  camStop = CAMS.startPlayer(c);        // 靜態快照需要定時更新
  P.classList.add('show');
}
function closeCam(){
  if(camStop){ camStop(); camStop=null; }   // 停掉快照計時器，否則會持續抓圖
  document.getElementById('cam').classList.remove('show');
  document.getElementById('c_player').innerHTML='';   // 停止播放，釋放連線
  camSel=-1;
}
/* 從「以地表某點為中心」回到地心環繞。
   之前根本沒有這條路：從清單點一個攝影機（flyToCam）之後，環繞中心就一直留在
   地表上，使用者只能靠「聚焦一顆衛星再按 ESC」間接繞回地心。中心不在地心時，
   縮放與拖曳的手感跟預期完全不同，很容易被誤認成滾輪壞掉。 */
function clearSurfaceView(){
  if(focusSat || roamOn || ctl.target.lengthSq() < 1e-8) return;
  ctl.target.set(0,0,0);
  camera.position.setLength(Math.max(camera.position.length(), RE*2.6));
  updateCtlLimits(); ctl.update();
}

/* 點選：以螢幕空間最近點判定（比 raycast 對 Points 更穩定） */
function flyToCam(i){
  const c = CAMS.camList()[i]; if(!c || !c._v) return;
  ellip.updateMatrixWorld(true);
  const w = c._v.clone().applyMatrix4(ellip.matrixWorld);
  const n = w.clone().normalize();
  camera.position.copy(n).multiplyScalar(w.length() + RE*0.55);
  ctl.target.copy(w); ctl.maxDistance = Math.max(ctl.maxDistance, 60);
  updateCtlLimits();               // 必須在 update 之前：否則這一次就被舊下限夾開
  ctl.update();
}
/* ── 漫遊模式 ──────────────────────────────────────────────
   這個站的用途之一，是在家繞著地球看世界。151 個據點要一個一個點開太費力，
   漫遊模式替你選點、飛過去、停留一陣子再換下一個，停留時鏡頭沿著當地緩慢繞行。

   兩個刻意的設計：
   1. 不搶操作權 —— 只要動了滑鼠，就把下一次換點往後延，
      想在喜歡的地方多待一會兒不必先關掉漫遊。
   2. 視角保持斜的而不是正俯視 —— 看得到地平線與大氣層散射，
      那才像從太空往下看，正俯視只是一張地圖。 */
let   ROAM_DWELL = 55000;    // ms；一個據點停留多久（回歸測試會調短以驗換點）
const ROAM_FLY   = 2600;     // ms；過場時間
const ROAM_SPIN  = 0.021;    // rad/s；繞行角速度，約 5 分鐘一圈
const roamDbg = {spins:0, dt:0, rad:0};   // 只給驗證用
let roamOn=false, roamBtn=null, roamCam=null, roamTween=null,
    roamNext=0, roamHold=0, roamOrder=[], roamI=0, roamT=0;

/* 終點姿態。刻意側傾：正上方俯視看不到大氣層，斜角才有從太空看的感覺。 */
function roamViewPose(c){
  // 不要用 updateMatrixWorld(true)：那會強制走訪 ellip 整個子樹（151 個影像標記、
  // 波束、覆蓋橢圓），每幀做一次量到 1.4 → 22.4 ms/frame。ellip 是 scene 的直接子物件
  // 且 scene 無變換，所以 matrixWorld 就等於它自己的 local matrix，更新 local 即可。
  ellip.updateMatrix();
  const w = c._v.clone().applyMatrix4(ellip.matrix);
  const n = w.clone().normalize();
  let t = new THREE.Vector3(0,1,0).cross(n);
  if(t.lengthSq() < 1e-6) t.set(1,0,0);        // 正對南北極時另取一個切向
  t.normalize();
  return { pos: n.clone().multiplyScalar(w.length() + RE*0.30).addScaledVector(t, RE*0.26),
           tgt: w };
}

/* 排序：風景優先，且同一個提供者不連著出現 ——
   否則會連看四個同一條公路的路況攝影機，那不叫遨遊世界。 */
function roamBuildOrder(){
  const list = CAMS.camList();
  const rank = c => c.kind==='scenic' ? 0 : (c.kind==='city' ? 2 : 1);
  const idx = list.map((c,i)=>i).filter(i => list[i]._v);
  for(let i=idx.length-1;i>0;i--){ const j=(Math.random()*(i+1))|0; [idx[i],idx[j]]=[idx[j],idx[i]]; }
  idx.sort((a,b)=> rank(list[a]) - rank(list[b]));
  const out=[], pool=idx.slice();
  while(pool.length){
    const prev = out.length ? (list[out[out.length-1]].provider || list[out[out.length-1]].channel || '') : '';
    let k = pool.findIndex(i => (list[i].provider || list[i].channel || '') !== prev);
    if(k < 0) k = 0;                            // 全都同一家時就照順序，不卡住
    out.push(pool.splice(k,1)[0]);
  }
  return out;
}

function roamGo(i){
  const list = CAMS.camList(); const c = list[i]; if(!c || !c._v) return;
  roamCam = c; camSel = i;
  roamTween = { p0: camera.position.clone(), g0: ctl.target.clone(),
                t0: performance.now(), dur: ROAM_FLY };
  ctl.maxDistance = Math.max(ctl.maxDistance, 60);
  openCam(i);
  roamNext = performance.now() + ROAM_FLY + ROAM_DWELL;
}

function roamAdvance(){
  if(!roamOrder.length) roamOrder = roamBuildOrder();
  if(!roamOrder.length){ roamStop(); return; }
  roamI = (roamI + 1) % roamOrder.length;
  if(roamI === 0) roamOrder = roamBuildOrder();     // 一輪跑完重新洗牌
  roamGo(roamOrder[roamI]);
}

function roamStart(){
  if(!camsReady) return;
  if(!camsOn){                                     // 漫遊本來就是在看影像，順手把圖層打開
    camsOn = true;
    if(camLayer) camLayer.visible = true;
    const vb = document.getElementById('ly_cams');
    if(vb) vb.classList.add('on');
    buildList();
  }
  clearFocus();
  roamOn = true; roamT = performance.now();
  roamOrder = roamBuildOrder(); roamI = -1;
  roamAdvance();
  if(roamBtn) roamBtn.classList.add('on');
  const f = document.getElementById('roam_hint'); if(f) f.classList.add('show');
}

function roamStop(){
  roamOn = false; roamTween = null; roamCam = null;
  ctl.target.set(0,0,0);           // 交還地心環繞，否則使用者接手時中心仍在地表
  updateCtlLimits();
  camera.position.setLength(Math.max(camera.position.length(), RE*2.6));
  ctl.update();
  if(roamBtn) roamBtn.classList.remove('on');
  const f = document.getElementById('roam_hint'); if(f) f.classList.remove('show');
}

document.getElementById('roam_x').onclick = () => roamStop();

function updateRoam(){
  if(!roamOn) return;
  const now = performance.now();
  const dt  = Math.min(0.1, (now - roamT)/1000); roamT = now;
  if(!roamCam || !roamCam._v) return;

  // 終點每幀重算：時間加速時地表點會跑，用起飛當下算好的終點會飛到舊位置
  const pose = roamViewPose(roamCam);
  if(roamTween){
    const k = Math.min(1, (now - roamTween.t0)/roamTween.dur);
    const e = k*k*k*(k*(k*6-15)+10);              // smootherstep：兩端加速度為零，不會有頓挫
    camera.position.lerpVectors(roamTween.p0, pose.pos, e);
    ctl.target.lerpVectors(roamTween.g0, pose.tgt, e);
    if(k >= 1) roamTween = null;
    return;
  }
  // 鎖住地表點：地球自轉時視野才不會慢慢漂走
  const d = pose.tgt.clone().sub(ctl.target);
  ctl.target.add(d); camera.position.add(d);

  // 繞著當地的鉛垂線緩慢轉。不能用 OrbitControls 的 autoRotate ——
  // 它繞的是世界 Y 軸，目標點在赤道附近時會把鏡頭轉到地底下。
  if(now > roamHold){
    const ax  = ctl.target.clone().normalize();
    const rel = camera.position.clone().sub(ctl.target).applyAxisAngle(ax, ROAM_SPIN*dt);
    camera.position.copy(ctl.target).add(rel);
    roamDbg.spins++; roamDbg.dt += dt; roamDbg.rad += ROAM_SPIN*dt;
  }
  if(now >= roamNext) roamAdvance();
}

/* 使用者一動，就把換點往後延、並暫停繞行 —— 漫遊是陪你看，不是趕你走。
   OrbitControls 的 start 事件涵蓋拖曳、滾輪與觸控。 */
ctl.addEventListener('start', () => {
  if(!roamOn) return;
  const now = performance.now();
  roamTween = null;                       // 使用者接手，取消進行中的過場
  roamHold  = now + 9000;                 // 停手後九秒才恢復緩慢繞行
  roamNext  = Math.max(roamNext, now + ROAM_DWELL);
});

/* 螢幕空間最近點選取。對 Points 而言比 raycast 穩定 —— raycast 需要設
   Points.threshold，且會隨相機距離失準。 */
const _pv = new THREE.Vector3();
const _tmpv2 = new THREE.Vector3();
function pickSatellite(ndcX, ndcY, maxPx, w, h){
  let best=-1, bestD=maxPx*maxPx;
  for(let i=0;i<SATS.length;i++){
    const s=SATS[i]; if(!s.vis) continue;
    _pv.copy(s.pos).project(camera);
    if(_pv.z < -1 || _pv.z > 1) continue;
    const dx=(_pv.x-ndcX)*w*0.5, dy=(_pv.y-ndcY)*h*0.5;
    const d=dx*dx+dy*dy;
    if(d<bestD){ bestD=d; best=i; }
  }
  return best;
}
function pickHandler(ev){
  const r=renderer.domElement.getBoundingClientRect();
  if(r.width<1||r.height<1) return;
  const x=((ev.clientX-r.left)/r.width)*2-1, y=-((ev.clientY-r.top)/r.height)*2+1;

  // 影像標記優先（它們貼在地表，比衛星密集，先讓使用者點得到）
  if(camsOn && camsReady){
    const ci=CAMS.pickCam(x,y,camera,ellip,15,r.width,r.height);
    if(ci>=0){ openCam(ci);
      // 漫遊中手動點某一支＝想看這一個，接手它並重新計時，別讓它兩秒後被換掉
      if(roamOn){ roamCam=CAMS.camList()[ci]; roamTween={p0:camera.position.clone(),
        g0:ctl.target.clone(), t0:performance.now(), dur:ROAM_FLY};
        roamNext=performance.now()+ROAM_FLY+ROAM_DWELL; }
      ev.stopPropagation(); return; }
  }
  const si=pickSatellite(x,y,15,r.width,r.height);
  if(si>=0){ if(roamOn) roamStop(); sel=SATS[si]; setFocus(sel); buildList(); ev.stopPropagation(); return; }
  // 點空白處：退出聚焦，或退出以地表某點為中心的視角
  if(focusSat) clearFocus(); else clearSurfaceView();
}

/* ── 深空天體（星團/星雲/星系）與系外行星 ────────────────────
   全部繪在半徑 R_SKY 的天球上：方向為真，距離不按比例（跨 4.2 光年 ~ 數千萬光年）。
   座標 J2000 → 當日歲差修正，與場景其餘天體同框架。 */
const R_SKY = 2450;
let astroOn=false, dsoLayer=null, exoLayer=null, msLabels=null, astroReady=false;
async function initAstro(){
  await ASTRO.loadAstro('astro.json');
  dsoLayer = ASTRO.buildDsoLayer(simTime, R_SKY);
  exoLayer = ASTRO.buildExoLayer(simTime, R_SKY*1.01);
  dsoLayer.frustumCulled=false; exoLayer.frustumCulled=false;
  dsoLayer.visible=false; exoLayer.visible=false;
  scene.add(dsoLayer, exoLayer);
  // 梅西耶天體標籤
  msLabels = new THREE.Group(); msLabels.visible=false; scene.add(msLabels);
  for(const o of ASTRO.messierList(simTime, R_SKY*0.995)){
    const txt = 'M'+o.m + (o.common ? ' '+o.common : '');
    const sp = labelSprite(txt, 0xbfe9ff);
    sp.position.copy(o.dir); sp.userData.m=o;
    msLabels.add(sp);
  }
  astroReady=true;
  return ASTRO.summary();
}
function updateAstro(){
  if(!astroReady) return;
  dsoLayer.visible = astroOn; exoLayer.visible = astroOn; msLabels.visible = astroOn;
  if(!astroOn) return;
  // 標籤維持固定視角大小（天球半徑固定，因此只需一次縮放）
  const k = camera.position.distanceTo(msLabels.children[0].position)*0.0075;
  for(const sp of msLabels.children){
    sp.visible = !occludedByEarth(sp.position);   // 同理：天球背面的標籤不該穿透地球
    if(sp.visible) sp.scale.set(sp.userData.aspect*k, k, 1);
  }
}

/* ── 地面站 ────────────────────────────────────────────────── */
/* 地面站原本只是一顆 0.055 單位的小球加一個細圈 —— 在整顆地球（半徑 6.378 單位）
   的尺度下幾乎看不見，使用者會以為「沒有地面站」。這裡改成：
     · 放大標記並加一道朝天頂的立柱，遠看就有可辨識的形狀
     · 兩層同心圈，外圈較淡，模仿雷達站的視覺語彙
     · 掛一個永遠面向鏡頭的標籤，寫出站名
   標籤 depthTest:false 會穿過地球，所以每幀依幾何遮蔽自行決定顯示與否。 */
const gsGroup = new THREE.Group(); scene.add(gsGroup);
const GS_COL = 0xff5ec8;
const gsMark = new THREE.Mesh(new THREE.SphereGeometry(0.085,18,14),
  new THREE.MeshBasicMaterial({color:GS_COL}));
const gsRing = new THREE.Mesh(new THREE.RingGeometry(0.15,0.185,48),
  new THREE.MeshBasicMaterial({color:GS_COL,side:THREE.DoubleSide,transparent:true,opacity:0.85}));
const gsRing2 = new THREE.Mesh(new THREE.RingGeometry(0.28,0.30,64),
  new THREE.MeshBasicMaterial({color:GS_COL,side:THREE.DoubleSide,transparent:true,opacity:0.35}));
const gsMast = new THREE.Mesh(new THREE.CylinderGeometry(0.012,0.012,0.42,8),
  new THREE.MeshBasicMaterial({color:GS_COL,transparent:true,opacity:0.9}));
gsGroup.add(gsMark, gsRing, gsRing2, gsMast);
const gsLabel = labelSprite(GS.name, GS_COL);
gsLabel.scale.multiplyScalar(0.42);
gsGroup.add(gsLabel);

/* ── 動態物件 ──────────────────────────────────────────────── */
const trailMat = new THREE.LineBasicMaterial({color:0x5ff0c8,transparent:true,opacity:0.55});
const orbitLine = new THREE.Line(new THREE.BufferGeometry(), trailMat); scene.add(orbitLine);
const trackLine = new THREE.Line(new THREE.BufferGeometry(),
  new THREE.LineBasicMaterial({color:0x5ff0c8,transparent:true,opacity:0.3})); scene.add(trackLine);
const fpLine = new THREE.LineLoop(new THREE.BufferGeometry(),
  new THREE.LineBasicMaterial({color:0x5ff0c8,transparent:true,opacity:0.65})); scene.add(fpLine);
const beamEllipse = new THREE.LineLoop(new THREE.BufferGeometry(),
  new THREE.LineBasicMaterial({color:0xffc24d,transparent:true,opacity:0.95})); scene.add(beamEllipse);
/* 下行（衛星 → 地面）與上行（地面 → 衛星）分開畫。
   用虛線並讓 dashOffset 以相反方向流動，方向感不必靠箭頭就看得出來。 */
const linkLine = new THREE.Line(new THREE.BufferGeometry(),
  new THREE.LineDashedMaterial({color:0x5ff0c8,transparent:true,opacity:0.9,
    dashSize:0.28,gapSize:0.20})); scene.add(linkLine);
const upLine = new THREE.Line(new THREE.BufferGeometry(),
  new THREE.LineDashedMaterial({color:0xffc24d,transparent:true,opacity:0.9,
    dashSize:0.28,gapSize:0.20})); scene.add(upLine);
upLine.visible=false;

/* 沿路徑移動的封包點。WebGL 的線寬永遠是 1px（linewidth 在多數平台被忽略），
   細虛線在幾千公里的尺度下讀不出流向，所以另外用會跑的點來表示方向。
   這是純視覺輔助，不代表任何物理量 —— 點的間距與速度都不對應真實位元率。 */
const PKT_N = 5;
function makePackets(hex){
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(PKT_N*3), 3));
  const m = new THREE.PointsMaterial({color:hex, size:7, sizeAttenuation:false,
    transparent:true, opacity:0.95, depthWrite:false});
  const pts = new THREE.Points(g, m); pts.frustumCulled=false; pts.visible=false;
  scene.add(pts); return pts;
}
const pktDown = makePackets(0x5ff0c8);
const pktUp   = makePackets(0xffc24d);
/* 端點存起來，讓封包的更新與鏈路計算解耦（鏈路每幀算，封包每幀走） */
const _pkA = new THREE.Vector3(), _pkB = new THREE.Vector3();
const _pkUpA = new THREE.Vector3(), _pkUpB = new THREE.Vector3();
let pktLive = false;
function updatePackets(nowMs){
  pktDown.visible = pktUp.visible = false;
  if(!pktLive) return;
  const t = (nowMs*0.00016) % 1;
  for(const [pts, from, to] of [[pktDown,_pkA,_pkB],[pktUp,_pkUpA,_pkUpB]]){
    if(!pts.parent) continue;
    const a = pts.geometry.attributes.position;
    for(let i=0;i<PKT_N;i++){
      const u = (t + i/PKT_N) % 1;
      a.array[i*3]   = from.x + (to.x-from.x)*u;
      a.array[i*3+1] = from.y + (to.y-from.y)*u;
      a.array[i*3+2] = from.z + (to.z-from.z)*u;
    }
    a.needsUpdate = true;
  }
  pktDown.visible = linkLine.visible;
  pktUp.visible   = upLine.visible;
}

let hiveOn=false, hiveLines=null, hiveFill=null, hiveKey='', hiveStat=null;
const beamMat = new THREE.MeshBasicMaterial({color:0xffc24d,transparent:true,opacity:0.11,
  side:THREE.DoubleSide,depthWrite:false,blending:THREE.AdditiveBlending});
const beamMesh = new THREE.Mesh(new THREE.ConeGeometry(1,1,64,1,true), beamMat);
beamMesh.visible=false; scene.add(beamMesh);

/* 尾焰：保存每顆衛星最近 TRAIL_N 個「真實 SGP4 位置」，合併成單一 LineSegments。
   不是速度外插，是實際傳播出來的軌跡點。 */
// 尾焰長度依目錄大小自適應：顆數多時縮短，避免每幀寫入過多頂點
let TRAIL_N = 46;
let trailGeo=null, trailPos=null, trailCol=null, trailMesh=null;
function initTrails(nSat){
  TRAIL_N = nSat > 300 ? 22 : (nSat > 120 ? 32 : 46);
  SATS.forEach(s=>{ s.hist=new Array(TRAIL_N).fill(null); });
  const segs=(TRAIL_N-1)*nSat;
  trailPos=new Float32Array(segs*2*3); trailCol=new Float32Array(segs*2*3);
  trailGeo=new THREE.BufferGeometry();
  trailGeo.setAttribute('position',new THREE.BufferAttribute(trailPos,3).setUsage(THREE.DynamicDrawUsage));
  trailGeo.setAttribute('color',new THREE.BufferAttribute(trailCol,3).setUsage(THREE.DynamicDrawUsage));
  trailMesh=new THREE.LineSegments(trailGeo, new THREE.LineBasicMaterial({
    vertexColors:true, transparent:true, opacity:0.9, blending:THREE.AdditiveBlending,
    depthWrite:false }));
  trailMesh.frustumCulled=false; scene.add(trailMesh);
}
function updateTrails(){
  if(!trailMesh) return;
  let k=0;
  for(const s of SATS){
    const h=s.hist, col=new THREE.Color(s.prof.color);
    for(let i=0;i<TRAIL_N-1;i++){
      const a=h[i], b=h[i+1];
      const ok = a && b && s.vis;
      // 越舊越暗；不可見時收成 0 長度線段（不畫）
      const f=Math.pow(i/(TRAIL_N-1),2.1)*(s===sel?1.0:0.42);
      trailPos[k*6]=ok?a.x:0; trailPos[k*6+1]=ok?a.y:0; trailPos[k*6+2]=ok?a.z:0;
      trailPos[k*6+3]=ok?b.x:0; trailPos[k*6+4]=ok?b.y:0; trailPos[k*6+5]=ok?b.z:0;
      trailCol[k*6]=col.r*f; trailCol[k*6+1]=col.g*f; trailCol[k*6+2]=col.b*f;
      trailCol[k*6+3]=col.r*f; trailCol[k*6+4]=col.g*f; trailCol[k*6+5]=col.b*f;
      k++;
    }
  }
  trailGeo.attributes.position.needsUpdate=true;
  trailGeo.attributes.color.needsUpdate=true;
}

/* 全部衛星以單一 THREE.Points 批次渲染：614 顆 = 1 個 draw call。
   深度測試維持開啟，因此被地球擋住的衛星會正確消失。 */
let satPoints=null, satPos=null, satCol=null, satSiz=null;
function initSatPoints(n){
  satPos=new Float32Array(n*3); satCol=new Float32Array(n*3); satSiz=new Float32Array(n);
  const g=new THREE.BufferGeometry();
  g.setAttribute('position',new THREE.BufferAttribute(satPos,3).setUsage(THREE.DynamicDrawUsage));
  g.setAttribute('color',   new THREE.BufferAttribute(satCol,3).setUsage(THREE.DynamicDrawUsage));
  g.setAttribute('psize',   new THREE.BufferAttribute(satSiz,1).setUsage(THREE.DynamicDrawUsage));
  satPoints=new THREE.Points(g,new THREE.ShaderMaterial({
    transparent:true, depthWrite:false, vertexColors:true,
    vertexShader:`attribute float psize; varying vec3 vC;
      void main(){ vC=color; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);
        gl_PointSize=psize; }`,
    fragmentShader:`varying vec3 vC;
      void main(){ float r=length(gl_PointCoord-0.5); if(r>0.5) discard;
        float core=smoothstep(0.30,0.05,r), halo=smoothstep(0.5,0.12,r);
        gl_FragColor=vec4(vC*(0.45+core), halo*0.85+core*0.15); }`
  }));
  satPoints.frustumCulled=false; scene.add(satPoints);
}

/* 選定衛星的醒目標記 */
const selMark = new THREE.Mesh(new THREE.SphereGeometry(0.075,16,12),
  new THREE.MeshBasicMaterial({color:0xffffff}));
const selRing = new THREE.Mesh(new THREE.RingGeometry(0.20,0.245,40),
  new THREE.MeshBasicMaterial({color:0xffffff,side:THREE.DoubleSide,transparent:true,opacity:0.9,
    depthWrite:false}));
selMark.visible=false; selRing.visible=false; scene.add(selMark, selRing);

/* ── 月球（真實 JPL 星曆、真實尺寸、真實相位）─────────────────
   半徑 1737.4 km（IAU 2015 平均半徑）→ 1.7374 場景單位，與地球同尺度。
   位置逐幀由 JPL 表內插（驗證誤差 0.051 km）。相位由同一個太陽方向照明，
   因此畫面上的月相與該時刻真實月相一致。
   【模型簡化】採潮汐鎖定近似（本初子午線恆對地心），未計入天平動（±8°）。 */
const MOON_R = 1737.4/U;
const moonMesh = new THREE.Mesh(new THREE.SphereGeometry(MOON_R, 64, 48),
  new THREE.MeshLambertMaterial({ map: tl.load('tex/moon_1024.jpg') }));
moonMesh.visible = false; scene.add(moonMesh);
const moonOrbit = new THREE.Line(new THREE.BufferGeometry(),
  new THREE.LineBasicMaterial({color:0x8899bb, transparent:true, opacity:0.28}));
moonOrbit.visible = false; scene.add(moonOrbit);

/* ── 深空任務標記 ──────────────────────────────────────────── */
let dsOn = false, dsReady = false, dsGroup = null, dsList = [], dsSel = null;
function labelSprite(text, color){
  const pad=8, f=26;
  const c=document.createElement('canvas'); const g=c.getContext('2d');
  g.font=`500 ${f}px "Noto Sans TC",system-ui,sans-serif`;
  c.width=Math.ceil(g.measureText(text).width)+pad*2; c.height=f+pad*2;
  const g2=c.getContext('2d');
  g2.font=`500 ${f}px "Noto Sans TC",system-ui,sans-serif`;
  g2.fillStyle='rgba(6,10,20,0.72)'; g2.fillRect(0,0,c.width,c.height);
  g2.fillStyle='#'+color.toString(16).padStart(6,'0');
  g2.fillText(text, pad, f+pad*0.65);
  const t=new THREE.CanvasTexture(c); t.colorSpace=THREE.SRGBColorSpace;
  const sp=new THREE.Sprite(new THREE.SpriteMaterial({map:t, depthTest:false, transparent:true}));
  sp.scale.set(c.width/c.height*2.6, 2.6, 1);
  sp.userData.aspect = c.width/c.height;
  return sp;
}
async function initDeepSpace(){
  await DS.loadDeepSpace('deepspace.json');
  dsGroup = new THREE.Group(); dsGroup.visible=false; scene.add(dsGroup);
  const snap = DS.missionPositions(simTime);
  for(const o of snap){
    const st = DS.KIND_STYLE[o.kind] || DS.KIND_STYLE.deep;
    const g = new THREE.Group();
    const dot = new THREE.Mesh(new THREE.SphereGeometry(2.2,12,10),
      new THREE.MeshBasicMaterial({color:st.color}));
    const ring = new THREE.Mesh(new THREE.RingGeometry(4.2,5.0,32),
      new THREE.MeshBasicMaterial({color:st.color,side:THREE.DoubleSide,
        transparent:true,opacity:0.55}));
    const lab = labelSprite(o.name, st.color); lab.position.set(0,9,0);
    g.add(dot, ring, lab);
    g.userData = {obj:o, ring, lab, dot};
    dsGroup.add(g);
    dsList.push(g);
  }
  dsReady = true;
  return snap.length;
}
const _fwd=new THREE.Vector3(), _tmpv=new THREE.Vector3(), _seg=new THREE.Vector3();
/* 相機到該點的線段是否被地球擋住。
   標籤（Sprite）必須關閉深度測試才不會被自己的標記切掉，
   因此無法靠 GPU 深度測試遮蔽，改用這個幾何判定。 */
function occludedByEarth(p){
  const Re = PHY.RE_WGS84/1e3/U;
  _seg.copy(p).sub(camera.position);
  const L = _seg.length(); if(L < 1e-6) return false;
  _seg.divideScalar(L);
  const b = 2*camera.position.dot(_seg);
  const c = camera.position.lengthSq() - Re*Re;
  const disc = b*b - 4*c;
  if(disc <= 0) return false;
  const t = (-b - Math.sqrt(disc))/2;
  return t > 0 && t < L;      // 交點在相機與目標之間 → 被擋住
}
function updateDeepSpace(){
  // 月球：真實位置、真實尺寸、真實相位
  const mp = DS.moonPos(simTime);
  moonMesh.visible = !!mp && dsOn;
  moonOrbit.visible = !!mp && dsOn;
  if(mp && dsOn){
    const v = toScene({x:mp[0], y:mp[1], z:mp[2]});
    moonMesh.position.copy(v);
    moonMesh.lookAt(0,0,0);                       // 潮汐鎖定：近側恆對地球
    if(!moonOrbit.userData.built || (simTime.getTime()-moonOrbit.userData.t0)>3.6e6){
      const pts=[];
      for(let i=0;i<=180;i++){
        const t=new Date(simTime.getTime()+(i-90)/180*27.32*86400000*1.0);
        const q=DS.moonPos(t); if(!q) continue;
        pts.push(toScene({x:q[0],y:q[1],z:q[2]}));
      }
      if(pts.length>2){
        moonOrbit.geometry.dispose();
        moonOrbit.geometry=new THREE.BufferGeometry().setFromPoints(pts);
      }
      moonOrbit.userData.built=true; moonOrbit.userData.t0=simTime.getTime();
    }
  }
  if(!dsReady) return;
  dsGroup.visible = dsOn;
  if(!dsOn) return;
  const snap = DS.missionPositions(simTime);
  for(let i=0;i<dsList.length;i++){
    const g = dsList[i], o = snap[i];
    g.userData.obj = o;
    if(!o.covered){ g.visible=false; continue; }
    const d = o.dist_km, r = DS.compressRadius(d);
    const dir = new THREE.Vector3(o.pos[0], o.pos[2], -o.pos[1]).normalize();
    g.position.copy(dir.multiplyScalar(r));
    g.visible = !occludedByEarth(g.position);      // 地球背面的任務不該穿透顯示
    if(!g.visible) continue;
    // 標記維持固定視角大小：整組（點+環+標籤）約佔畫面高度 4.5%
    const dist = camera.position.distanceTo(g.position);
    const worldExtent = 2*dist*Math.tan(camera.fov*0.5*Math.PI/180)*0.045;
    g.scale.setScalar(worldExtent/12);
    g.userData.ring.lookAt(camera.position);
    g.userData.lab.material.opacity = (g===dsSel) ? 1.0 : 0.72;
    g.userData.rank = _fwd.set(0,0,-1).applyQuaternion(camera.quaternion)
        .dot(_tmpv.copy(g.position).sub(camera.position).normalize());
  }
  // 標籤只給最接近視線中心的 10 個 + 選定者，避免 26 個標籤疊成一團
  const vis = dsList.filter(g=>g.visible).sort((a,b)=>b.userData.rank-a.userData.rank);
  vis.forEach((g,i)=>{ g.userData.lab.visible = (i<10) || (g===dsSel); });
}

/* ── 聚焦模式 ─────────────────────────────────────────────────
   選一顆衛星後把 OrbitControls 的中心移到它身上，相機每幀跟著它平移
   （保留使用者的環繞角度與距離），於是滾輪就是朝那顆衛星推進。
   自由視角下中心是地心，縮放只會往地球去，看不了單顆衛星 —— 這是原本的問題。 */
let focusSat = null;
const _prevTgt = new THREE.Vector3(), _dTgt = new THREE.Vector3();

function setFocus(s){
  focusSat = s;
  updateCtlLimits();
  if(s && s.vis){
    _prevTgt.copy(ctl.target);
    ctl.target.copy(s.pos);
    // 進場距離：離目標約 60 km，看得到本體又保有周遭
    const dir = camera.position.clone().sub(_prevTgt).normalize();
    camera.position.copy(s.pos).addScaledVector(dir, 0.06);
    ctl.update();
  }
  document.body.classList.add('focused');
  const fb = document.getElementById('focus');
  if(fb){ fb.classList.add('show');
    document.getElementById('focus_t').textContent = '聚焦 ' + (s ? s.name : ''); }
}
function clearFocus(){
  if(!focusSat) return;
  focusSat = null;
  ctl.target.set(0,0,0);
  updateCtlLimits();
  // 退回到能看見整顆地球的距離
  camera.position.setLength(Math.max(camera.position.length(), RE*3.2));
  ctl.update();
  document.body.classList.remove('focused');
  const fb = document.getElementById('focus'); if(fb) fb.classList.remove('show');
}
/* 近／遠裁剪面依情境調整。
   自由視角的 near=0.2 單位（200 km）在聚焦時會把目標整個裁掉 ——
   實測聚焦 ISS 拉近到 9.5 km 時只看得到 435 km 外的地球，模型完全不見。
   聚焦時改 near=0.4 km；far 同時收到 3000 以維持深度精度
   （此距離下地球處的深度解析度約 28 m，遠小於覆蓋圈 12.8 km 的抬升量，
   不會造成 z-fighting）。 */
const NEAR_FREE = 0.2,    FAR_FREE  = 6000;
const NEAR_FOCUS = 0.0004, FAR_FOCUS = 3000;
function applyClip(){
  const n = focusSat ? NEAR_FOCUS : NEAR_FREE;
  const f = focusSat ? FAR_FOCUS  : FAR_FREE;
  if(camera.near !== n || camera.far !== f){
    camera.near = n; camera.far = f; camera.updateProjectionMatrix();
  }
}

/* 每幀讓中心跟著目標移動；相機同步平移以保留使用者的視角 */
function followFocus(){
  if(!focusSat) return;
  if(!focusSat.vis){ clearFocus(); return; }
  _dTgt.copy(focusSat.pos).sub(ctl.target);
  if(_dTgt.lengthSq() === 0) return;
  ctl.target.add(_dTgt);
  camera.position.add(_dTgt);
}

/* ── 衛星 3D 本體 LOD ─────────────────────────────────────────
   離相機最近的 MODEL_MAX 顆（必含選定衛星）改以 three.js 程序生成的
   本體模型繪製，其餘維持點。姿態依 LVLH：+Z 對地、+X 對速度、
   太陽翼繞本體 Y 軸追日。模型尺寸依相機距離縮放以維持可辨識，
   實際放大倍率即時算出並顯示於介面（誠實標示非真實比例）。 */
let MODEL_MAX = 26;
let MODEL_FRAC = 0.10;
const FOCUS_SPAN_KM = 3.0;   // 聚焦時模型的固定世界尺寸（公里）      // 模型佔畫面高度的比例（可調），決定放大倍率
const slots = [];            // {group, cls, sat}
let modelsOn = true, exagg = 0;
const _m4 = new THREE.Matrix4(), _q = new THREE.Quaternion();
const _xb = new THREE.Vector3(), _yb = new THREE.Vector3(), _zb = new THREE.Vector3(),
      _vv = new THREE.Vector3(), _sl = new THREE.Vector3();

function slotFor(i, cls){
  let sl = slots[i];
  if(!sl) sl = slots[i] = {models:{}, cur:null};
  if(sl.cur !== cls){
    if(sl.cur && sl.models[sl.cur]) sl.models[sl.cur].visible = false;
    if(!sl.models[cls]){ const g = getModel(cls); g.visible=false; scene.add(g); sl.models[cls]=g; }
    sl.cur = cls;
  }
  sl.group = sl.models[cls];
  return sl;
}
function hideSlot(sl){ if(sl && sl.cur && sl.models[sl.cur]) sl.models[sl.cur].visible=false; }

/* 依實際幾何寬度回推放大倍率，作為誠實標示 */
const REAL_SPAN_M = { geo_spot:31, leo_phased:9.5, oneweb_ku:6.0, gnss:12, station_vhf:109,
                      iridium_l:9.4, leo_vhf:8.3, goes_l:6.1, science_s:13.2,
                      amateur_uhf:0.34, eo_xband:10.6 };
function realSpan(cls){
  const k = cls.startsWith('gnss') ? 'gnss' : cls;
  return REAL_SPAN_M[k] || 8;
}

const _cen = new THREE.Vector3();
function updateModels(su){
  // 相機退到地月/深空尺度時關閉本體模型：固定視角大小的模型在該尺度會
  // 大過地球本身，變成誤導。此時交回點雲呈現。
  const camR = camera.position.length();
  if(!modelsOn || (camR > 90 && !focusSat)){ for(const sl of slots) hideSlot(sl); return; }
  // 取離相機最近者
  const cand = [];
  for(const s of SATS){ if(!s.vis) continue;
    cand.push([camera.position.distanceToSquared(s.pos), s]); }
  cand.sort((a,b)=>a[0]-b[0]);
  const chosen = cand.slice(0, MODEL_MAX).map(c=>c[1]);
  if(sel && sel.vis && chosen.indexOf(sel)<0){ chosen.pop(); chosen.unshift(sel); }
  // 依型號排序讓插槽指派穩定，避免同一槽的型號逐幀跳動
  chosen.sort((a,b)=> a===sel ? -1 : b===sel ? 1 : (a.class<b.class?-1:a.class>b.class?1:0));

  const shown = new Set();
  for(let i=0;i<chosen.length;i++){
    const s = chosen[i], sl = slotFor(i, s.prof.modelCls || s.class);
    const g = sl.group; g.visible = true; shown.add(s);
    g.position.copy(s.pos);

    // 姿態：+Z 天底、+X 速度（去掉徑向分量）、+Y = Z×X
    _zb.copy(s.pos).negate().normalize();
    _vv.set(s.pv.velocity.x, s.pv.velocity.z, -s.pv.velocity.y);
    _xb.copy(_vv).addScaledVector(_zb, -_vv.dot(_zb)).normalize();
    _yb.crossVectors(_zb, _xb).normalize();
    _m4.makeBasis(_xb, _yb, _zb);
    g.quaternion.setFromRotationMatrix(_m4);

    // 太陽翼：把太陽方向轉進本體座標，繞 Y 軸轉到板面法線(+Z)對準太陽在 XZ 的投影
    _sl.copy(sunDir).applyQuaternion(_q.copy(g.quaternion).invert());
    g.userData.arrays.rotation.y = Math.atan2(_sl.x, _sl.z);

    // 縮放：維持固定視角大小 -> 換算實際放大倍率
    const dist = camera.position.distanceTo(s.pos);
    // 一般情況依相機距離維持可辨識大小（否則遠觀時看不見），
    // 但聚焦某顆衛星時改用固定世界尺寸 —— 否則不管怎麼縮放，
    // 模型在畫面上永遠一樣大，「拉近觀察」等於沒有作用。
    let worldSpan;
    if(s === focusSat){
      worldSpan = FOCUS_SPAN_KM/U;                   // 固定 3 km，放大倍率誠實顯示
    } else {
      worldSpan = 2*dist*Math.tan(camera.fov*0.5*Math.PI/180)*MODEL_FRAC;
      worldSpan = Math.min(worldSpan, 0.42);         // 上限 420 km
    }
    const k = worldSpan / g.userData.span;
    g.scale.setScalar(k);
    if(s===sel) exagg = (g.userData.span*k*1e6) / realSpan(s.class);   // 場景單位=1e6 m
    const si = SATS.indexOf(s); if(si>=0) satSiz[si] = 0;              // 有模型就不畫點
  }
  // 地球反照光：由地心射向顯示模型的形心；亮度隨該處是否受陽照而定
  if(chosen.length){
    _cen.set(0,0,0);
    for(const s of chosen) _cen.add(s.pos);
    _cen.multiplyScalar(1/chosen.length);
    const sub = _cen.clone().normalize();
    earthShine.position.set(0,0,0);
    earthShine.target.position.copy(_cen);
    earthShine.target.updateMatrixWorld();
    const lit = Math.max(0, sub.dot(sunDir));      // 星下點受陽照程度
    earthShine.intensity = 0.30*lit + 0.05;
  } else earthShine.intensity = 0;
  for(let i=chosen.length;i<slots.length;i++) hideSlot(slots[i]);
}

/* ── 載入 TLE ──────────────────────────────────────────────── */
let SATS=[], sel=null, tleMeta=null;
const bootmsg = document.getElementById('bootmsg');

async function boot(){
  bootmsg.textContent='讀取 CelesTrak TLE 快取…';
  const raw = await (await fetch('tle_cache.json')).json();
  tleMeta = raw;
  SATS = raw.sats.map(s=>{
    const rec = satellite.twoline2satrec(s.tle1, s.tle2);
    return {...s, rec, prof:PROFILE[s.class], mesh:null, err:rec.error};
  }).filter(s=>{
    if(s.err){ console.warn('SGP4 init 失敗', s.name, s.err); return false; }
    return true;
  });
  bootmsg.textContent=`${SATS.length} 顆衛星 SGP4 初始化完成 · 載入真實星表…`;
  const starMeta = await loadStars();
  window.__stars = starMeta;
  bootmsg.textContent=`${starMeta.n} 顆真實恆星就位 · 載入 JPL 深空星曆…`;
  const nMission = await initDeepSpace();
  bootmsg.textContent=`${nMission} 個太空探索任務就位 · 載入星團與系外行星…`;
  const A = await initAstro();
  window.__astro = A;
  bootmsg.textContent=`${A.exo} 顆系外行星 · ${A.dso} 個深空天體就位 · 載入即時影像清單…`;
  const CM = await initCams();
  window.__cams = CM;
  bootmsg.textContent=`${CM.cams.length} 個公開即時影像據點就位`;
  SATS.forEach(s=>{ s.hist=new Array(TRAIL_N).fill(null); s.pos=new THREE.Vector3(); s.vis=false; });
  initSatPoints(SATS.length);
  initTrails(SATS.length);
  buildSearch();
  buildList();
  sel = SATS.find(s=>s.name.startsWith('NOAA 19')) || SATS[0];
  document.getElementById('src').textContent =
    `TLE 來源：CelesTrak GP · 取得於 ${raw.fetched_utc.slice(0,16).replace('T',' ')}Z`;
  document.getElementById('boot').style.display='none';
  frameOnSunlitSide();
  window.__dbg = {scene,camera,ctl,earth,sunDir,SATS,PHY,roamDbg,get roamOn(){return roamOn;},
    get roamDwell(){return ROAM_DWELL;}, set roamDwell(v){ROAM_DWELL=v;},
    get roamCamName(){return roamCam ? roamCam.zh : null;},get fps(){return fpsV;},
    get exagg(){return exagg;},
    get frac(){return MODEL_FRAC;}, set frac(v){MODEL_FRAC=v;}, get exagg(){return exagg;},
    get maxModels(){return MODEL_MAX;}, set maxModels(v){MODEL_MAX=v;},
    get models(){return modelsOn;}, set models(v){modelsOn=v;},
    get renderer(){return renderer;},
    openCam, flyToCam, CAMS,
    bench(n){
      n = n || 60;
      frame();                                    // 暖機
      const gl = renderer.getContext();
      const t0 = performance.now();
      for(let i=0;i<n;i++) frame();
      gl.finish();                                // 等 GPU 真的做完，否則只量到送出指令
      const ms = (performance.now()-t0)/n;
      const info = renderer.info.render;
      return { ms_per_frame:+ms.toFixed(2), fps_equiv:+(1000/ms).toFixed(1),
               draw_calls:info.calls, triangles:info.triangles, hidden:document.hidden };
    },
    slots, get models(){return modelsOn;}, set models(v){modelsOn=v;},
    get sel(){return sel;}, set sel(v){sel=v;},
    get t(){return simTime;}, set t(v){simTime=v;},
    get speed(){return speed;}, set speed(v){speed=v;}};
  animate();
}

const GROUP_META = {
  stations:['太空站與來訪飛行器','VHF 145.8 業餘下行'],
  weather :['極軌氣象','VHF 137 APT'],
  goes    :['靜止氣象 GOES','L 1686.6 GRB'],
  gnss    :['全球衛星導航 GNSS','L1/E1/B1 導航訊號'],
  iridium :['Iridium 通訊','L 1621 點波束'],
  science :['科學與天文','S 2250 下行'],
  amateur :['業餘/立方衛星','UHF 436.5'],
  eo      :['對地觀測','X 8.2 高速下行'],
  oneweb  :['OneWeb','Ku 11.7'],
  starlink:['Starlink','Ku 11.7 相位陣列'],
  geo     :['GEO 商用通訊','Ka 19.95 點波束']
};
const openGroups = new Set(['stations','weather','geo']);
let filterText = '';

/* 左側清單分成兩個可收合的大區：太空、世界知名景點。
   為什麼要分：原本是把「即時影像 → 太空探索 → 各衛星群組」平鋪成一長串，
   看風景的人要捲過 619 顆衛星，看衛星的人要捲過 151 個攝影機，兩邊都不好用。
   兩個大區各自收合之後，你要看什麼就只展開那一邊。 */
const SECTION_META = {
  space: ['太空',       'TLE·星曆驅動'],
  earth: ['世界知名景點', '公開即時影像']
};
let openSections = new Set(['earth']);   // 預設展開景點：這個站最常被拿來看風景

function secHead(key, n, forced){
  const [title, sub] = SECTION_META[key];
  const open = forced || openSections.has(key);
  return `<div class="lsec stog${open?' open':''}" data-s="${key}">`+
         `<b>${open?'▾':'▸'}</b>${title}<span class="cnt">${n}</span><i>${sub}</i></div>`;
}

function buildList(){
  const host = document.getElementById('satlist');
  const q = filterText;
  let html = '';

  // ── 世界知名景點 ───────────────────────────────────────
  if(camsOn && camsReady){
    const rows = CAMS.camList().map((c,i)=>[c,i]).filter(([c])=> !q ||
        (c.zh+' '+(c.place||'')+' '+(c.title||'')).toLowerCase().includes(q));
    // 搜尋時強制展開，否則打了字卻看不到結果
    const open = openSections.has('earth') || !!q;
    html += secHead('earth', rows.length, !!q);
    if(open && rows.length){
      const byRegion = new Map(CAMS.REGION_ORDER.map(r=>[r,[]]));
      for(const r of rows) byRegion.get(CAMS.camRegion(r[0])).push(r);
      for(const region of CAMS.REGION_ORDER){
        const list = byRegion.get(region);
        if(!list.length) continue;
        list.sort((a,b)=> CAMS.camKindRank(a[0])-CAMS.camKindRank(b[0])
                       || a[0].zh.localeCompare(b[0].zh,'zh-Hant'));
        const gk = 'rg_'+region;
        const gopen = openGroups.has(gk) || !!q;
        const nScenic = list.filter(([c])=>c.kind==='scenic').length;
        html += `<div class="grp gtog sub" data-g="${gk}">${gopen?'▾':'▸'} ${region}`+
                `<span class="cnt">${list.length}</span>`+
                `<i>${nScenic?`風景 ${nScenic}`:''}</i></div>`;
        if(!gopen) continue;
        for(const [c,i] of list){
          const col = (CAMS.KIND_COLOR[c.kind]||0x6ee7a8).toString(16).padStart(6,'0');
          html += `<div class="sat cam sub" data-c="${i}"><span class="dot" style="color:#${col};`+
            `background:currentColor"></span><span class="nm">${c.zh}</span>`+
            `<span class="el">${CAMS.KIND_LABEL[c.kind]||'影像'}</span></div>`;
        }
      }
    } else if(open){
      html += '<div class="more sub">查無符合的據點</div>';
    }
  }

  // ── 太空 ───────────────────────────────────────────────
  {
    const groups = [];
    let nTotal = 0;
    if(dsOn && dsReady){
      const snap = DS.missionPositions(simTime);
      const shown = snap.map((o,i)=>[o,i])
        .filter(([o])=>o.covered && (!q || (o.name+' '+(o.note||'')).toLowerCase().includes(q)))
        .sort((a,b)=>a[0].dist_km-b[0].dist_km);
      if(shown.length){
        nTotal += shown.length;
        groups.push({key:'ds', title:'太空探索任務', sub:'JPL Horizons 星曆', n:shown.length,
          rows:()=>shown.map(([o,i])=>{
            const st = DS.KIND_STYLE[o.kind] || DS.KIND_STYLE.deep;
            return `<div class="sat msn sub" data-m="${i}"><span class="dot" style="color:#`+
              `${st.color.toString(16).padStart(6,'0')};background:currentColor"></span>`+
              `<span class="nm">${o.name}</span>`+
              `<span class="el">${DS.fmtDist(o.dist_km).split('（')[0]}</span></div>`;}).join('')});
      }
    }
    for(const g of Object.keys(GROUP_META)){
      const [title, sub] = GROUP_META[g];
      let list = SATS.filter(s=>s.group===g);
      if(q) list = list.filter(s=>s.name.toLowerCase().includes(q));
      if(!list.length) continue;
      nTotal += list.length;
      groups.push({key:g, title, sub, n:list.length, rows:()=>{
        const shown = list.slice(0, 200);
        let h = shown.map(s=>{
          const i = SATS.indexOf(s);
          return `<div class="sat sub" data-i="${i}"><span class="dot" style="color:#`+
            `${s.prof.color.toString(16).padStart(6,'0')};background:currentColor"></span>`+
            `<span class="nm">${s.name}</span><span class="el" id="el${i}">—</span></div>`;
        }).join('');
        if(list.length>shown.length)
          h += `<div class="more sub">…另有 ${list.length-shown.length} 顆，請用搜尋縮小範圍</div>`;
        return h;
      }});
    }
    if(groups.length){
      const open = openSections.has('space') || !!q;
      html += secHead('space', nTotal, !!q);
      if(open) for(const gr of groups){
        const gopen = openGroups.has(gr.key) || !!q;
        html += `<div class="grp gtog sub" data-g="${gr.key}">${gopen?'▾':'▸'} ${gr.title}`+
                `<span class="cnt">${gr.n}</span><i>${gr.sub}</i></div>`;
        if(gopen) html += gr.rows();
      }
    }
  }

  host.innerHTML = html || '<div class="more">查無符合的項目</div>';
  host.querySelectorAll('.stog').forEach(el=>el.onclick=()=>{
    const k=el.dataset.s;
    if(openSections.has(k)) openSections.delete(k); else openSections.add(k);
    buildList();
  });
  host.querySelectorAll('.gtog').forEach(el=>el.onclick=()=>{
    const g=el.dataset.g;
    if(openGroups.has(g)) openGroups.delete(g); else openGroups.add(g);
    buildList();
  });
  host.querySelectorAll('.sat').forEach(el=>el.onclick=()=>{
    if(el.dataset.c !== undefined){ openCam(+el.dataset.c); flyToCam(+el.dataset.c); }
    else if(el.dataset.m !== undefined){ selectMission(+el.dataset.m); }
    else { sel = SATS[+el.dataset.i]; setFocus(sel); }
  });
}

function buildSearch(){
  const wrap = document.createElement('div'); wrap.className='srch';
  wrap.innerHTML = '<input id="q" placeholder="搜尋衛星名稱…" autocomplete="off">';
  document.getElementById('left').insertBefore(wrap, document.getElementById('satlist'));
  const q = document.getElementById('q');
  q.oninput = ()=>{ filterText = q.value.trim().toLowerCase(); buildList(); };
}

/* ── 時間控制 ──────────────────────────────────────────────── */
let simTime = new Date(), speed = 60, lastReal = performance.now();
{
  const box=document.getElementById('speeds');
  [1,10,60,300,1800].forEach(v=>{
    const b=document.createElement('button'); b.className='sb'+(v===60?' on':'');
    b.textContent = v===1?'即時':`×${v}`;
    b.onclick=()=>{ speed=v; [...box.children].forEach(c=>c.classList.remove('on'));
      b.classList.add('on'); };
    box.appendChild(b);
  });
  const now=document.createElement('button'); now.className='sb'; now.textContent='回到現在';
  now.onclick=()=>{ simTime=new Date(); }; box.appendChild(now);
  const LY=document.getElementById('layers');
  const cb=document.createElement('button'); cb.className='sb on'; cb.textContent='真實雲圖';
  cb.title='NASA GIBS MODIS Terra 每日全球真色鑲嵌';
  /* 標籤固定不變，只用 on 狀態表示開關 —— 與其他五顆圖層鈕行為一致。
     原本會把文字換成 "Blue Marble"，造成按鈕在兩種狀態下名稱不同。 */
  cb.title='開：NASA VIIRS 今日真實雲圖　關：Blue Marble 無雲底圖';
  cb.onclick=()=>{ const on = earthMat.uniforms.uReal.value < 0.5;
    earthMat.uniforms.uReal.value = on?1:0; clouds.visible = !on;
    cb.classList.toggle('on', on); };
  LY.appendChild(cb);
  const hb=document.createElement('button'); hb.className='sb'; hb.textContent='多波束';
  hb.title='蜂巢式點波束覆蓋 + 四色頻率重用（僅窄波束衛星）';
  hb.onclick=()=>{ hiveOn=!hiveOn; hb.classList.toggle('on',hiveOn); hiveKey='';
    if(!hiveOn){ if(hiveLines)hiveLines.visible=false; if(hiveFill)hiveFill.visible=false; } };
  LY.appendChild(hb);
  const mb=document.createElement('button'); mb.className='sb on'; mb.textContent='本體模型';
  mb.title='最近 26 顆以 three.js 程序生成的本體模型繪製（姿態為真實 LVLH + 太陽翼追日）';
  mb.onclick=()=>{ modelsOn=!modelsOn; mb.classList.toggle('on',modelsOn); };
  LY.appendChild(mb);
  const db=document.createElement('button'); db.className='sb'; db.textContent='太空探索';
  db.title='月球（真實 JPL 星曆）與 26 個深空任務的真實方向';
  db.onclick=()=>{ dsOn=!dsOn; db.classList.toggle('on',dsOn); buildList();
    if(!dsOn){ dsSel=null; document.getElementById('mission').style.display='none'; }
    else viewTier('cislunar'); };
  LY.appendChild(db);
  const ab=document.createElement('button'); ab.className='sb'; ab.textContent='星團·系外行星';
  ab.title='OpenNGC 深空天體 + NASA Exoplanet Archive 系外行星（方向為真，距離不按比例）';
  ab.onclick=()=>{ astroOn=!astroOn; ab.classList.toggle('on',astroOn); };
  LY.appendChild(ab);
  const vb=document.createElement('button'); vb.className='sb'; vb.id='ly_cams'; vb.textContent='即時影像';
  vb.title='全球公開直播與公務攝影機（點地球上的圓圈標記開啟）';
  vb.onclick=()=>{ camsOn=!camsOn; vb.classList.toggle('on',camsOn);
    if(camLayer) camLayer.visible=camsOn;
    if(!camsOn){ closeCam(); if(roamOn) roamStop(); else clearSurfaceView(); } buildList(); };
  LY.appendChild(vb);
  const rb=document.createElement('button'); rb.className='sb'; rb.id='ly_roam'; rb.textContent='漫遊';
  rb.title='自動巡遊全球風景據點：飛到定點、停留約一分鐘、鏡頭緩慢繞行；'
         + '動一下滑鼠就會自動延後換點';
  roamBtn = rb;
  rb.onclick=()=>{ roamOn ? roamStop() : roamStart(); };
  LY.appendChild(rb);
  const ib=document.createElement('button'); ib.className='sb'; ib.textContent='關於';
  ib.title='說明、資料來源與授權';
  ib.onclick=()=>{ if(window.__openAbout) window.__openAbout(); };
  LY.appendChild(ib);
}

/* 讓貼地元素跟隨 WGS84 扁率（footprint/ground track/beam 橢圓） */
const ellip = new THREE.Group(); ellip.scale.set(1,FLAT,1); scene.add(ellip);
[fpLine, trackLine, beamEllipse, gsGroup].forEach(o=>{ scene.remove(o); ellip.add(o); });

const OMEGA_E = 7.2921159e-5;         // rad/s  地球自轉角速度（IERS）
const gsGd = { longitude: GS.lon*d2r, latitude: GS.lat*d2r, height: GS.alt };

function gsEci(gmst){
  const ecf = satellite.geodeticToEcf(gsGd);
  return satellite.ecfToEci(ecf, gmst);
}
/* 觀測者 ECI 速度 = omega x r（純自轉） */
const obsVel = p => ({ x:-OMEGA_E*p.y, y:OMEGA_E*p.x, z:0 });

function propagate(rec, date){
  const pv = satellite.propagate(rec, date);
  if(!pv || !pv.position || Number.isNaN(pv.position.x)) return null;
  return pv;
}

const V = new THREE.Vector3(), V2 = new THREE.Vector3(), _c = new THREE.Color();
let hudT = 0, listT = 0, fpsN = 0, fpsT = performance.now(), fpsV = 0;

let loopDead = false;
function animate(){
  if(loopDead) return;
  requestAnimationFrame(animate);
  try { frame(); } catch(err){
    loopDead = true;
    console.error('[SatLink] 主迴圈例外，已停止：', err);
    const w=document.getElementById('warn');
    w.style.display='block'; w.style.color='#ff6b6b';
    w.textContent='主迴圈例外已停止：'+(err&&err.message||err);
    window.__loopError = (err&&err.stack)||String(err);
  }
}
function frame(){
  const nowReal = performance.now();
  simTime = new Date(simTime.getTime() + (nowReal-lastReal)*speed);
  lastReal = nowReal;

  const gmst = satellite.gstime(simTime);
  earth.rotation.y  = gmst;          // 本初子午線在貼圖 u=0.5 → 場景 +X → ECI 赤經 = GMST
  clouds.rotation.y = gmst + 0.0006*(simTime.getTime()/3.6e6);
  ellip.rotation.y  = gmst;

  const su = PHY.sunEci(simTime);
  sunDir.set(su.x, su.z, -su.y).normalize();
  sunLight.position.copy(sunDir).multiplyScalar(300);

  // 地面站：在 ellip 群組的 local 空間表示（該群組已套用 gmst 旋轉與扁率縮放）
  const gsEcf = satellite.geodeticToEcf(gsGd);
  gsGroup.position.set(gsEcf.x/U, gsEcf.z/U/FLAT, -gsEcf.y/U);
  const gsUp = gsGroup.position.clone().normalize();
  gsRing.quaternion.setFromUnitVectors(new THREE.Vector3(0,0,1), gsUp);
  gsRing2.quaternion.copy(gsRing.quaternion);
  gsMast.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0), gsUp);
  gsMast.position.copy(gsUp).multiplyScalar(0.21);
  gsLabel.position.copy(gsUp).multiplyScalar(0.62);
  {   // 標籤不寫深度，會穿透地球；用幾何遮蔽自行決定顯示
    const wp = gsLabel.getWorldPosition(_tmpv2);
    const dist = camera.position.distanceTo(wp);
    const k = dist*0.030;
    gsLabel.scale.set(gsLabel.userData.aspect*k, k, 1);
    gsLabel.visible = !occludedByEarth(wp) && dist < 260;
  }
  const gsP = gsEci(gmst), gsV = obsVel(gsP);

  const updHud  = (nowReal-hudT)  > 100;
  const updList = (nowReal-listT) > 400;
  if(updHud)  hudT = nowReal;
  if(updList) listT = nowReal;

  let si=-1;
  for(const s of SATS){
    si++;
    const pv = propagate(s.rec, simTime);
    const i = si;
    if(!pv){ s.vis=false; satSiz[i]=0; s.hist.shift(); s.hist.push(null); continue; }
    s.vis=true; s.pv = pv;
    s.pos.copy(toScene(pv.position));
    satPos[i*3]=s.pos.x; satPos[i*3+1]=s.pos.y; satPos[i*3+2]=s.pos.z;
    s.hist.shift(); s.hist.push(s.pos.clone());
    const ecl = PHY.inEclipse(pv.position, su);      // 進入地影者調暗
    _c.setHex(ecl ? 0x33465e : s.prof.color);
    const k = ecl ? 0.55 : 1.0;
    satCol[i*3]=_c.r*k; satCol[i*3+1]=_c.g*k; satCol[i*3+2]=_c.b*k;
    satSiz[i] = (s===sel) ? 11.0 : (ecl ? 4.2 : 5.6);

    if(updList){
      const ecf = satellite.eciToEcf(pv.position, gmst);
      const la  = satellite.ecfToLookAngles(gsGd, ecf);
      s.el = la.elevation/d2r; s.az = la.azimuth/d2r; s.rng = la.rangeSat;
      const n = document.getElementById('el'+si);
      if(n){ n.textContent = s.el>=0 ? s.el.toFixed(1)+'°' : '—';
             n.parentElement.classList.toggle('vis', s.el>=5); }
    }
  }
  if(updList) for(const el of document.querySelectorAll('.sat'))
    el.classList.toggle('on', SATS[+el.dataset.i]===sel);

  updateDeepSpace();
  updateAstro();
  updateModels(su);
  if(satPoints){
    satPoints.geometry.attributes.position.needsUpdate=true;
    satPoints.geometry.attributes.color.needsUpdate=true;
    satPoints.geometry.attributes.psize.needsUpdate=true;
  }
  if(sel && sel.vis){
    selMark.visible=!modelsOn; selRing.visible=true;
    selMark.position.copy(sel.pos); selRing.position.copy(sel.pos);
    selRing.lookAt(camera.position);
    const c2=new THREE.Color(sel.prof.color);
    selMark.material.color.copy(c2); selRing.material.color.copy(c2);
  } else { selMark.visible=false; selRing.visible=false; }
  updateTrails();
  if(sel && sel.pv) updateSelected(gmst, gsP, gsV, su, updHud);

  fpsN++; const fnow=performance.now();
  if(fnow-fpsT>1000){ fpsV=fpsN*1000/(fnow-fpsT); fpsN=0; fpsT=fnow; }
  // 虛線流動方向即訊號流向：下行往地面跑，上行往衛星跑
  const dashT = nowReal * 0.0009;
  if(linkLine.visible) linkLine.material.dashOffset = -dashT;
  if(upLine.visible)   upLine.material.dashOffset   =  dashT;
  updatePackets(nowReal);

  applyClip();
  followFocus();
  updateRoam();
  updateCtlLimits();
  ctl.update();
  renderer.render(scene, camera);
}

/* ── 選定衛星：軌道、覆蓋圈、地面軌跡、波束、鏈路 ─────────── */
const Y = new THREE.Vector3(0,1,0);
function ecfToLocal(e){ return new THREE.Vector3(e.x/U, e.z/U/FLAT, -e.y/U); }

function updateSelected(gmst, gsP, gsV, su, updHud){
  const s = sel, p = s.pv.position, v = s.pv.velocity, prof = s.prof;

  // 幾何
  const ecf = satellite.eciToEcf(p, gmst);
  const la  = satellite.ecfToLookAngles(gsGd, ecf);
  const el  = la.elevation/d2r, az = la.azimuth/d2r, rng_km = la.rangeSat;
  const rel = {x:p.x-gsP.x, y:p.y-gsP.y, z:p.z-gsP.z};
  const rv  = {x:v.x-gsV.x/1, y:v.y-gsV.y/1, z:v.z-gsV.z/1};
  const rr  = (rel.x*rv.x+rel.y*rv.y+rel.z*rv.z)/rng_km;    // km/s，正=遠離
  const gd  = satellite.eciToGeodetic(p, gmst);
  const alt_km = gd.height;

  // 軌道環（慣性系，一個週期）
  const T_s = 2*Math.PI/ (s.rec.no / 60);                    // no: rad/min
  const N=256, pts=[];
  for(let i=0;i<=N;i++){
    const t=new Date(simTime.getTime()+(i/N)*T_s*1000);
    const q=propagate(s.rec,t); if(!q) continue;
    pts.push(toScene(q.position));
  }
  orbitLine.geometry.dispose();
  orbitLine.geometry=new THREE.BufferGeometry().setFromPoints(pts);
  trailMat.color.setHex(prof.color);

  // 地面軌跡（±40% 週期，畫在當前地球表面上）
  const tp=[];
  for(let i=-40;i<=40;i++){
    const t=new Date(simTime.getTime()+(i/100)*T_s*1000);
    const q=propagate(s.rec,t); if(!q) continue;
    const g=satellite.eciToGeodetic(q.position, satellite.gstime(t));
    const e=satellite.geodeticToEcf({longitude:g.longitude,latitude:g.latitude,height:20});
    tp.push(ecfToLocal(e));
  }
  trackLine.geometry.dispose();
  trackLine.geometry=new THREE.BufferGeometry().setFromPoints(tp);
  trackLine.material.color.setHex(prof.color);

  // 覆蓋圈（最小仰角 5°，真實地心半角）
  const lam = PHY.footprintAngle_deg(alt_km*1000, 5)*d2r;
  const sub = new THREE.Vector3(ecf.x,ecf.z,-ecf.y).normalize();
  const e1 = new THREE.Vector3().crossVectors(sub, Math.abs(sub.y)<0.9?Y:new THREE.Vector3(1,0,0)).normalize();
  const e2 = new THREE.Vector3().crossVectors(sub,e1).normalize();
  const fp=[]; const Rl = PHY.RE_WGS84/1e3/U;
  for(let i=0;i<=90;i++){
    const a=i/90*Math.PI*2;
    fp.push(new THREE.Vector3().copy(sub).multiplyScalar(Math.cos(lam))
      .addScaledVector(e1, Math.sin(lam)*Math.cos(a))
      .addScaledVector(e2, Math.sin(lam)*Math.sin(a)).multiplyScalar(Rl*1.002));
  }
  fpLine.geometry.dispose();
  fpLine.geometry=new THREE.BufferGeometry().setFromPoints(fp);
  fpLine.material.color.setHex(prof.color);

  // 波束錐（窄波束才畫；全向天線照實不畫假光束）
  const narrow = prof.hpbw < 20 && el > 0;
  beamMesh.visible = narrow; beamEllipse.visible = narrow;
  if(narrow){
    const A = toScene(p), B = toScene(gsP);
    const dir = new THREE.Vector3().subVectors(B,A);
    const L = dir.length(); dir.normalize();
    const half = prof.hpbw/2*d2r, rBase = Math.tan(half)*L;
    beamMesh.geometry.dispose();
    beamMesh.geometry = new THREE.ConeGeometry(rBase, L, 72, 1, true);
    beamMesh.position.copy(A).addScaledVector(dir, L/2);
    beamMesh.quaternion.setFromUnitVectors(new THREE.Vector3(0,-1,0), dir);
    beamMat.color.setHex(prof.color);
    // 錐與地球交線：逐方位射線求交（真實幾何，非貼圖）
    const u1=new THREE.Vector3().crossVectors(dir,Math.abs(dir.y)<0.9?Y:new THREE.Vector3(1,0,0)).normalize();
    const u2=new THREE.Vector3().crossVectors(dir,u1).normalize();
    const ring=[], Aun=new THREE.Vector3(A.x,A.y/FLAT,A.z);
    for(let i=0;i<=90;i++){
      const a=i/90*Math.PI*2;
      const d=new THREE.Vector3().copy(dir).addScaledVector(u1,Math.tan(half)*Math.cos(a))
        .addScaledVector(u2,Math.tan(half)*Math.sin(a));
      d.set(d.x, d.y/FLAT, d.z).normalize();            // 轉到未扁化球空間
      const b=2*Aun.dot(d), c=Aun.lengthSq()-Rl*Rl, disc=b*b-4*c;
      let t = disc>0 ? (-b-Math.sqrt(disc))/2 : -Aun.dot(d);
      const hit=new THREE.Vector3().copy(Aun).addScaledVector(d,t).setLength(Rl*1.003);
      ring.push(hit.applyAxisAngle(Y,-gmst));
    }
    beamEllipse.geometry.dispose();
    beamEllipse.geometry=new THREE.BufferGeometry().setFromPoints(ring);
    beamEllipse.material.color.setHex(prof.color);
  }

  // 多波束蜂巢覆蓋（節流重建：GEO 幾乎不動，不必逐幀重算）
  // 蜂巢覆蓋是衛星自身的波束佈局，與「我們這個地面站看不看得到」無關，
  // 因此不可綁 narrow（其含 el>0 條件）。
  const wantHive = hiveOn && !!prof.hiveRings && prof.hpbw < 20;
  if(wantHive){
    const key = [s.name, (gmst*57.3).toFixed(2), toScene(p).length().toFixed(3)].join('|');
    if(key !== hiveKey){
      hiveKey = key;
      const h = buildHive({ satScene: toScene(p), hpbw_deg: prof.hpbw,
        rings: prof.hiveRings, gmst, Rl: PHY.RE_WGS84/1e3/U, FLAT });
      if(hiveLines){ ellip.remove(hiveLines); hiveLines.geometry.dispose(); }
      if(hiveFill){  ellip.remove(hiveFill);  hiveFill.geometry.dispose(); }
      hiveLines = new THREE.LineSegments(h.lineGeo, new THREE.LineBasicMaterial({
        vertexColors:true, transparent:true, opacity:0.95, depthWrite:false }));
      hiveFill = new THREE.Mesh(h.fillGeo, new THREE.MeshBasicMaterial({
        vertexColors:true, transparent:true, opacity:0.13, depthWrite:false,
        side:THREE.DoubleSide, blending:THREE.AdditiveBlending }));
      ellip.add(hiveLines, hiveFill);
      hiveStat = h;
    }
    if(hiveLines){ hiveLines.visible=true; hiveFill.visible=true; }
  } else if(hiveLines){ hiveLines.visible=false; hiveFill.visible=false; hiveStat=null; }

  // 鏈路預算
  const lb = PHY.linkBudget({
    f_Hz:prof.f, range_m:rng_km*1000, el_deg:el,
    txPow_dBW:prof.txPow_dBW, txGain_dBi:prof.txGain_dBi, txFeed_dB:prof.txFeed_dB,
    rxGain_dBi:prof.rx.G, rxFeed_dB:prof.rx.feed, rxNF_dB:prof.rx.NF,
    bitrate_bps:prof.bitrate, mode:prof.mode, txPol:prof.txPol, rxPol:prof.rx.pol,
    rxHpbw_deg:prof.rx.hpbw
  });
  /* 上行（地面 → 衛星）。與下行是不同的頻率、不同的天線、不同的雜訊環境：
       · 頻率不同 → FSPL、氣體/雨衰、法拉第旋轉全部要重算
       · 接收端在衛星上，天線朝地 → 天線雜訊溫度是地球的 ~290 K，不是冷天空
       · 有些系統根本沒有使用者上行（GNSS、氣象廣播），那就照實不畫、不算 */
  const up = prof.up;
  const uTx = upTx(up);
  const lbUp = up ? PHY.linkBudget({
    f_Hz:up.f, range_m:rng_km*1000, el_deg:el,
    txPow_dBW:up.txPow_dBW, txGain_dBi:uTx.G, txFeed_dB:up.txFeed_dB,
    rxGain_dBi:up.rx.G, rxFeed_dB:up.rx.feed, rxNF_dB:up.rx.NF,
    bitrate_bps:up.bitrate, mode:up.mode, txPol:up.txPol, rxPol:up.rx.pol,
    rxHpbw_deg:up.rx.hpbw, Tant_K:up.rx.Tant_K
  }) : null;
  /* 對照組：同一條鏈路但天線雜訊溫度改用天空值。只為了在介面上如實顯示
     「這個假設差多少 dB」，不參與任何實際顯示的鏈路數字。
     注意差值**會換號**：銀河背景與地球 290 K 的交越點在 231.7 MHz，
     低於它（如 ARISS 145.99 MHz，天空約 1019 K）朝地反而比較安靜。 */
  const lbUpSky = up ? PHY.linkBudget({
    f_Hz:up.f, range_m:rng_km*1000, el_deg:el,
    txPow_dBW:up.txPow_dBW, txGain_dBi:uTx.G, txFeed_dB:up.txFeed_dB,
    rxGain_dBi:up.rx.G, rxFeed_dB:up.rx.feed, rxNF_dB:up.rx.NF,
    bitrate_bps:up.bitrate, mode:up.mode, txPol:up.txPol, rxPol:up.rx.pol,
    rxHpbw_deg:up.rx.hpbw
  }) : null;
  const dopUp = up ? PHY.doppler_Hz(up.f, rr*1000) : null;

  const visible = el >= 5;
  const ok = visible && lb.margin > 0;
  const okUp = visible && lbUp && lbUp.margin > 0;

  /* 兩條路徑幾何上重疊，錯開一點才看得出是兩條；
     位移量隨距離縮放，遠看不會糊成一條、近看也不會誇張。 */
  const A = toScene(p), B = toScene(gsP);
  const seg = new THREE.Vector3().subVectors(B, A);
  // 兩條路徑幾何上完全重合，位移量要夠大才看得出是兩條；
  // 隨距離縮放並設下限，遠距不會糊成一條、近距也不會誇張到不像同一條鏈路。
  const nOff = new THREE.Vector3().crossVectors(seg, camera.position.clone().sub(A))
                 .normalize().multiplyScalar(Math.max(0.05, seg.length()*0.035));
  linkLine.visible = visible;
  if(visible){
    linkLine.geometry.dispose();
    linkLine.geometry=new THREE.BufferGeometry().setFromPoints(
      [A.clone().add(nOff), B.clone().add(nOff)]);
    linkLine.computeLineDistances();
    linkLine.material.color.setHex(ok?0x5ff0c8:0xff6b6b);
    linkLine.material.opacity = ok?0.95:0.4;
  }
  _pkA.copy(A).add(nOff); _pkB.copy(B).add(nOff);   // 下行封包走這條（含位移）
  pktLive = visible;
  upLine.visible = visible && !!up;
  if(upLine.visible){
    upLine.geometry.dispose();
    upLine.geometry=new THREE.BufferGeometry().setFromPoints(
      [B.clone().sub(nOff), A.clone().sub(nOff)]);
    upLine.computeLineDistances();
    upLine.material.color.setHex(okUp?0xffc24d:0xff6b6b);
    upLine.material.opacity = okUp?0.95:0.4;
    _pkUpA.copy(B).sub(nOff); _pkUpB.copy(A).sub(nOff);
  }
  pktDown.material.color.setHex(ok?0x5ff0c8:0xff6b6b);
  pktUp.material.color.setHex(okUp?0xffc24d:0xff6b6b);

  if(updHud) hud(s, {el,az,rng_km,alt_km,rr}, lb, visible, ok, wantHive?hiveStat:null,
                   {up, lbUp, lbUpSky, okUp, dopUp, uTx});
}

/* 視野尺度：把相機拉到能看見該層級的距離（方向沿用目前視線） */
function viewTier(tier){
  const d = {near:RE*4.0, cislunar:430, deep:760}[tier] || RE*4.0;
  const dir = camera.position.clone().normalize();
  camera.position.copy(dir.multiplyScalar(d));
  ctl.target.set(0,0,0); ctl.maxDistance = Math.max(400, d*1.6); ctl.update();
}

/* 開場鏡頭：站在太陽側後方 35° 看地球，讓晨昏線與夜面燈光同時入鏡 */
function frameOnSunlitSide(){
  const su = PHY.sunEci(simTime);
  const sv = new THREE.Vector3(su.x, su.z, -su.y).normalize();
  const up = new THREE.Vector3(0,1,0);
  const side = new THREE.Vector3().crossVectors(sv, up).normalize();
  const dir = sv.clone().multiplyScalar(Math.cos(46*d2r))
    .addScaledVector(side, Math.sin(46*d2r))
    .addScaledVector(up, 0.22).normalize();
  camera.position.copy(dir).multiplyScalar(RE*4.0);
  ctl.target.set(0,0,0); ctl.update();
}

function selectMission(i){
  dsSel = dsList[i];
  const o = dsSel.userData.obj;
  const st = DS.KIND_STYLE[o.kind] || DS.KIND_STYLE.deep;
  const P = document.getElementById('mission');
  P.style.display = 'block';
  document.getElementById('m_name').textContent = o.name;
  document.getElementById('m_kind').textContent = st.label;
  document.getElementById('m_dist').textContent = DS.fmtDist(o.dist_km);
  document.getElementById('m_light').textContent = DS.fmtLight(o.light_s);
  document.getElementById('m_note').textContent = o.note;
  document.getElementById('m_cite').innerHTML =
    `<b>星曆</b> NASA/JPL Horizons · 地心 ICRF 赤道 · 日步長 Catmull-Rom 內插<br>`+
    (o.coverage_end ? `<b>涵蓋至</b> ${o.coverage_end}（JPL 預報軌跡上限，之後無資料不外插）<br>` : '')+
    (DS.isCompressed(o.dist_km)
      ? `<span style="color:#ffc24d">畫面上的<b>方向是真的</b>，但徑向距離經對數壓縮 —— 真實距離見上方數字。月球以內為等比。</span>`
      : `<span style="color:#5ff0c8">此距離在等比範圍內（≤50 萬 km），畫面位置即真實位置。</span>`);
  // 相機轉向該目標
  const g = dsSel;
  const dir = g.position.clone().normalize();
  const r = Math.max(g.position.length()*1.35, 200);
  camera.position.copy(dir.multiplyScalar(r)); ctl.target.set(0,0,0);
  ctl.maxDistance = Math.max(ctl.maxDistance, r*1.5); ctl.update();
}

/* ── HUD ───────────────────────────────────────────────────── */
const $ = id => document.getElementById(id);
const set = (id, txt, cls='') => { const n=$(id); n.textContent=txt; n.className='v '+cls; };
const f = (x,n=1) => (x==null||Number.isNaN(x)) ? '—' : x.toFixed(n);

function hud(s, g, lb, visible, ok, hive, U2){
  const prof=s.prof;
  $('selName').textContent = s.name;
  $('selSub').textContent  = prof.label + ' · ' + lb.modeName;

  set('v_el',  f(g.el,2)+'°', g.el>=5?'g':(g.el>=0?'w':'b'));
  set('v_az',  f(g.az,1)+'°');
  set('v_rng', g.rng_km>=1000 ? f(g.rng_km,0)+' km' : f(g.rng_km,1)+' km');
  set('v_alt', f(g.alt_km,1)+' km');
  set('v_rr',  (g.rr>0?'+':'')+f(g.rr,3)+' km/s');

  const dop = PHY.doppler_Hz(prof.f, g.rr*1000);
  set('v_dop', (dop>0?'+':'')+f(Math.abs(dop)>=1000?dop/1000:dop, Math.abs(dop)>=1000?2:0)
       + (Math.abs(dop)>=1000?' kHz':' Hz'));
  set('v_lat', f(g.rng_km/299.792458,2)+' ms');
  set('v_fspl', f(lb.FSPL,1)+' dB');
  set('v_atm', f(lb.A_gas+lb.A_rain+lb.L_pol,2)+' dB');
  set('v_cn0', visible? f(lb.CN0,1)+' dB-Hz' : '無視線', visible?'':'b');
  set('v_ebn0', visible? f(lb.EbN0,1)+' dB' : '—');
  set('v_marg', visible? (lb.margin>0?'+':'')+f(lb.margin,1)+' dB' : '—',
      !visible?'':(lb.margin>6?'g':lb.margin>0?'w':'b'));
  $('v_bar').style.width = visible ? Math.max(0,Math.min(100,(lb.margin+10)/35*100))+'%' : '0%';

  /* ── 上行 ──────────────────────────────────────────────
     有些系統照實就是沒有使用者上行（GNSS 純接收、氣象衛星是單向廣播）。
     那種情況不畫、不算、也不填假數字，直接說明原因 —— 比留一排「—」誠實。 */
  const up = U2 && U2.up, lbUp = U2 && U2.lbUp;
  if(up && lbUp){
    $('sec_up').style.opacity = '1';
    set('u_band', up.label.split(' · ')[0]);
    set('u_eirp', f(lbUp.EIRP,1)+' dBW');
    const du = U2.dopUp;
    set('u_dop', (du>0?'+':'')+f(Math.abs(du)>=1000?du/1000:du, Math.abs(du)>=1000?2:0)
         + (Math.abs(du)>=1000?' kHz':' Hz'));
    set('u_fspl', f(lbUp.FSPL,1)+' dB');
    set('u_atm',  f(lbUp.A_gas+lbUp.A_rain+lbUp.L_pol,2)+' dB');
    set('u_gt',   f(lbUp.GT,1)+' dB/K');
    set('u_cn0',  visible? f(lbUp.CN0,1)+' dB-Hz' : '無視線', visible?'':'b');
    set('u_marg', visible? (lbUp.margin>0?'+':'')+f(lbUp.margin,1)+' dB' : '—',
        !visible?'':(lbUp.margin>6?'g':lbUp.margin>0?'w':'b'));
    $('u_bar').style.width = visible ? Math.max(0,Math.min(100,(lbUp.margin+10)/35*100))+'%' : '0%';
    /* 這個差值一定要當場算，不能寫死一個「大概幾 dB」。
       它隨頻率變化很大：VHF 的銀河雜訊本來就有數百 K，朝地與朝天差不了多少；
       Ku/Ka 的冷天空只有十幾 K，差距才明顯。實測 Starlink Ku 上行是 2.5 dB。 */
    const dGT = (U2.lbUpSky ? U2.lbUpSky.GT - lbUp.GT : null);
    $('u_note').innerHTML =
      `${up.label}<br>${up.src}<br>`+
      `<span style="color:#ffc24d">星上接收天線朝地，天線雜訊溫度取地球亮度溫度 ${up.rx.Tant_K} K，`+
      `不是冷天空。</span>`+
      (dGT!==null ? `　若改用天空雜訊溫度（${f(U2.lbUpSky.Tsky,0)} K）會把此鏈路的 G/T `+
        `<b>${dGT>=0?'高估':'低估'} ${f(Math.abs(dGT),1)} dB</b>`+
        `（T_sys ${f(lbUp.Tsys,0)} K → ${f(U2.lbUpSky.Tsys,0)} K）。`+
        (dGT<0 ? `此頻率的銀河背景比地球還吵（交越點 231.7 MHz），朝地反而較安靜。` : '') : '');
  } else {
    $('sec_up').style.opacity = '0.55';
    for(const k of ['u_band','u_eirp','u_dop','u_fspl','u_atm','u_gt','u_cn0','u_marg']) set(k,'—');
    $('u_bar').style.width='0%';
    $('u_note').innerHTML = `<span style="color:#ffc24d">此系統沒有使用者上行。</span><br>`+
      (s.prof.upNote || '');
  }

  /* ── 地面站 ──────────────────────────────────────────── */
  set('g_name', GS.name);
  set('g_pos', `${Math.abs(GS.lat).toFixed(3)}°${GS.lat>=0?'N':'S'} `+
               `${Math.abs(GS.lon).toFixed(3)}°${GS.lon>=0?'E':'W'} · ${(GS.alt*1000).toFixed(0)} m`);
  set('g_ant', up ? (up.dish_m ? `${up.dish_m} m 碟型 · ${f(U2.uTx.G,1)} dBi @ ${(up.f/1e9).toFixed(2)} GHz`
                               : `${f(U2.uTx.G,1)} dBi · ${f(up.txPow_dBW,1)} dBW`)
                  : '—（此系統無上行）');

  // TLE 年齡與不確定度
  const ep = s.rec.jdsatepoch + (s.rec.jdsatepochF||0);
  const jdNow = simTime.getTime()/86400000 + 2440587.5;
  const age = jdNow - ep;
  // age 可能為負：模擬時間被拉到 TLE 曆元之前。此時「已 N 天」語意不通，改為「早於」。
  const aa = Math.abs(age);
  const ageTxt = (aa<2 ? f(aa*24,1)+' 小時' : f(aa,2)+' 天') + (age<0 ? '（曆元之後）' : '');
  set('v_age', ageTxt, aa>7?'b':aa>3?'w':'g');
  set('v_unc', '± '+f(PHY.sgp4Uncertainty_km(age),1)+' km',
      Math.abs(age)>7?'w':'');
  set('v_prop', s.rec.method==='d' ? 'SDP4（深空）' : 'SGP4（近地）');

  $('cite').innerHTML =
    `<b>軌道</b> CelesTrak GP TLE → SGP4/SDP4 (satellite.js, Vallado 2006)<br>`+
    `<b>常數</b> k=1.380649e−23 J/K (CODATA 2019) · c=299792458 m/s (SI)<br>`+
    `<b>損耗</b> Friis FSPL · ITU-R P.676 氣體 · P.618 雨衰 · P.372 天電雜訊<br>`+
    `<b>雜訊</b> T_sky=${f(lb.Tsky,0)} K · T_sys=${f(lb.Tsys,0)} K · G/T=${f(lb.GT,1)} dB/K<br>`+
    `<b>電離層</b> 法拉第旋轉 ${f(lb.faraday_deg,0)}° (TEC=20 TECU 代表值)<br>`+
    // 全向或寬波束天線不該畫出指向性光束，畫了就是假的。但介面沉默會讓人以為壞了，
    // 所以照實說明為什麼沒有錐體，以及它實際的輻射樣態。
    (prof.hpbw >= 20
      ? `<b>天線樣態</b> 發射半功率波束寬 ${f(prof.hpbw,0)}°，屬寬波束／近全向 —— `+
        `<span style="color:#ffc24d">不畫波束錐</span>，因為它不是指向性光束；`+
        `畫面上的虛線是傳播路徑，不是波束形狀。<br>`
      : `<b>天線樣態</b> 發射半功率波束寬 ${f(prof.hpbw,1)}°，指向性波束，錐體為真實張角。<br>`)+
    (hive ? `<b>蜂巢</b> ${hive.drawn} 個點波束 · 間距 ${hive.spacing_deg}° (=HPBW，交越 −3 dB) · 四色頻率重用<br>`+
     `<span style="color:#ffc24d">蜂巢為幾何示範：真實系統只覆蓋服務區，且各波束指向由營運商規劃，非機械填滿。</span><br>` : '')+
    (modelsOn && exagg>1 ? `<b>本體模型</b> three.js 程序生成 · 姿態 LVLH(+Z 對地) + 太陽翼單軸追日 · <span style="color:#ffc24d">圖示放大約 ×${Math.round(exagg).toLocaleString()}，非真實比例</span><br>` : '')+
    `<b>星空</b> HYG Database v4.0 真實星表 ${(window.__stars?window.__stars.n:0)} 顆 (mag≤6.5, J2000)<br>`+
    (astroOn ? `<b>深空天體</b> OpenNGC ${ASTRO.astroMeta().dso.n} 個（星團/星雲/星系）· NASA Exoplanet Archive ${ASTRO.astroMeta().exoplanets.n} 顆系外行星<br>` : '')+
    `<span style="color:#ffc24d">大氣輝光為視覺近似，不供物理引用。恆星/星團/系外行星只有方向為真，距離未按比例。</span>`;

  $('utc').textContent = simTime.toISOString().replace('T',' ').slice(0,19)+' UTC';

  const w=$('warn');
  if(Math.abs(age)>14){ w.style.display='block';
    w.textContent = (age<0
      ? `此時刻早於 TLE 曆元 ${f(-age,1)} 天`
      : `TLE 已 ${f(age,1)} 天`)
      + `，SGP4 位置誤差可能超過 ${f(PHY.sgp4Uncertainty_km(age),0)} km — 數值僅供參考`; }
  else w.style.display='none';
}

renderer.domElement.addEventListener('click', pickHandler);
addEventListener('keydown', e=>{ if(e.key==='Escape' && focusSat) clearFocus(); });
document.getElementById('c_x').onclick = () => {
  if(roamOn) roamStop();          // 漫遊自己會把中心交還地心
  else { closeCam(); clearSurfaceView(); }
};
document.getElementById('focus_x').onclick = clearFocus;

addEventListener('resize', ()=>{
  camera.aspect=innerWidth/innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});
boot().catch(e=>{ $('bootmsg').innerHTML='<span style="color:#ff6b6b">載入失敗：'+e.message+'</span>';
  console.error(e); });
