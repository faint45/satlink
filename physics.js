// physics.js — 鏈路預算與天文幾何
// 每個常數都標來源。單位一律明寫。模型失效邊界寫在各函式上方。
export const C  = 299792458.0;        // m/s   SI 定義精確值
export const KB = 1.380649e-23;       // J/K   CODATA 2019，SI 定義精確值
export const K_DB = 10*Math.log10(KB);            // = -228.599 dB(W/K/Hz)
export const RE_WGS84 = 6378137.0;    // m     WGS84 長半軸
export const F_WGS84  = 1/298.257223563;          // WGS84 扁率
export const MU = 3.986004418e14;     // m^3/s^2  WGS84/EGM96

const d2r = Math.PI/180, r2d = 180/Math.PI;

/* ── 自由空間損耗（Friis）────────────────────────────────────────
   FSPL = 20log10(4*pi*d*f/c)
   失效：近場 d < 2D^2/λ；有繞射/多路徑/遮蔽時不成立（此式只算擴散）。 */
export function fspl_dB(d_m, f_Hz){
  return 20*Math.log10(4*Math.PI*d_m*f_Hz/C);
}

/* ── 大氣氣體吸收（ITU-R P.676 簡化天頂值 + 餘割律）─────────────
   A = A_zenith / sin(el)。失效：el < 5° 時餘割律高估（地球曲率），
   此處在 el<5° 改用等效餘割上限；且天頂值為中緯度標準大氣代表值，
   非逐日氣象資料 —— 標記為 B 級資料。 */
const GAS_ZENITH = [ // [f_GHz, A_zenith_dB] 中緯度標準大氣，取自 P.676 典型曲線
  [0.1,0.003],[0.3,0.004],[1,0.007],[3,0.015],[10,0.05],
  [12,0.06],[20,0.35],[22.2,0.55],[30,0.25],[40,0.4],[50,1.2],[60,90]
];
export function gasLoss_dB(f_Hz, el_deg){
  const g = f_Hz/1e9, T = GAS_ZENITH;
  let az = T[T.length-1][1];
  for(let i=0;i<T.length-1;i++){
    if(g>=T[i][0] && g<=T[i+1][0]){
      const t=(g-T[i][0])/(T[i+1][0]-T[i][0]);
      az = T[i][1]+t*(T[i+1][1]-T[i][1]); break;
    }
  }
  if(g<T[0][0]) az=T[0][1];
  const el = Math.max(el_deg, 0);
  const csc = el>=5 ? 1/Math.sin(el*d2r) : 1/Math.sin(5*d2r)*(1+(5-el)*0.12);
  return az*csc;
}

/* ── 雨衰（ITU-R P.618 / P.838）─────────────────────────────────
   僅在 f > ~4 GHz 才顯著；VHF/UHF 回傳 0（不假裝有）。
   k,alpha 取 P.838-3 水平極化代表值，rain_rate 為 mm/h。 */
export function rainLoss_dB(f_Hz, el_deg, rainRate_mmh, hs_km=0.05){
  const g=f_Hz/1e9;
  if(g<4 || rainRate_mmh<=0) return 0;
  const k = 4.21e-5*Math.pow(g,2.42), a = 1.41*Math.pow(g,-0.0779); // P.838 擬合
  const gamma = k*Math.pow(rainRate_mmh,a);                          // dB/km
  const hR = 5.0;                                                    // 雨高 km（熱帶約 5）
  const el = Math.max(el_deg,1)*d2r;
  const Ls = (hR-hs_km)/Math.sin(el);                                // 斜路徑長 km
  const r  = 1/(1+0.78*Math.sqrt(Ls*gamma/g)-0.38*(1-Math.exp(-2*Ls)));
  return gamma*Ls*r;
}

/* ── 電離層法拉第旋轉 ───────────────────────────────────────────
   Omega[rad] = (2.365e4 / f^2) * B_par * TEC       (f:Hz, B:T, TEC:el/m^2)
   VHF 主導、Ka 可忽略。失效：TEC 為統計代表值非即時 GNSS 實測（B 級）。 */
export function faradayRot_rad(f_Hz, tec_TECU=20, Bpar_T=2.0e-5){
  return 2.365e4 * Bpar_T * (tec_TECU*1e16) / (f_Hz*f_Hz);
}
/* 極化失配損耗。linear-linear 受法拉第旋轉週期性深衰落；
   circular-linear 固定 3 dB 但免疫法拉第（這正是 NOAA 用 QFH 的原因）。*/
export function polLoss_dB(txPol, rxPol, faraday_rad){
  if(txPol==='circular' && rxPol==='circular') return 0.5;
  if(txPol!==rxPol) return 3.0;
  if(txPol==='linear'){
    const c=Math.abs(Math.cos(faraday_rad));
    return Math.min(30, -20*Math.log10(Math.max(c,1e-3)));
  }
  return 0.5;
}

/* ── 天空雜訊溫度（ITU-R P.372 / Haslam 408MHz 巡天外插）────────
   T_gal(f) = T408 * (408/f_MHz)^2.75，T408 冷天區約 20K、銀河面數百 K。
   VHF 下 T_sky 可達 1e3 K 量級，遠超接收機雜訊 —— 這是 VHF 的真實限制。
   失效：未查真實 Haslam 地圖方向，用中位代表值（B 級資料）。 */
export function skyNoiseTemp_K(f_Hz, T408_K=60){
  const fM=f_Hz/1e6;
  const gal = T408_K*Math.pow(408/fM, 2.75);
  const cmb = 2.725;                              // 宇宙微波背景
  const atm = fM>1e4 ? 30 : 3;                    // 大氣輻射（>10GHz 才顯著）
  return gal+cmb+atm;
}

/* ── 系統雜訊溫度（Friis 級聯）──────────────────────────────── */
export function sysNoiseTemp_K({Tant,feedLoss_dB,Tamb=290,rxNF_dB}){
  const Lf = Math.pow(10, feedLoss_dB/10);
  const Trx = Tamb*(Math.pow(10, rxNF_dB/10)-1);
  return Tant/Lf + Tamb*(1-1/Lf) + Trx;   // 參考至 LNA 輸入
}

/* ── 天線增益樣式（ITU-R S.1528 主瓣拋物近似）────────────────── */
export function antGain_dBi(Gmax_dBi, theta_deg, hpbw_deg){
  const t=Math.abs(theta_deg);
  if(t<=hpbw_deg/2*2.0) return Gmax_dBi - 12*Math.pow(t/hpbw_deg,2);
  return Math.max(Gmax_dBi-25, Gmax_dBi - 12*Math.pow(t/hpbw_deg,2)); // 旁瓣地板
}
/* 由口徑估增益與波束寬（拋物面）。失效：僅適用 D >> λ。 */
export function dishGain(D_m, f_Hz, eff=0.6){
  const lam=C/f_Hz;
  return { G_dBi: 10*Math.log10(eff*Math.pow(Math.PI*D_m/lam,2)),
           hpbw_deg: 70*lam/D_m };
}

/* ── BER（AWGN 解析式）──────────────────────────────────────── */
function erfc(x){ // Numerical Recipes 分數近似，|err|<1.2e-7
  const z=Math.abs(x), t=1/(1+0.5*z);
  const y=t*Math.exp(-z*z-1.26551223+t*(1.00002368+t*(0.37409196+t*(0.09678418+
    t*(-0.18628806+t*(0.27886807+t*(-1.13520398+t*(1.48851587+
    t*(-0.82215223+t*0.17087277)))))))));
  return x>=0?y:2-y;
}
const Q = x => 0.5*erfc(x/Math.SQRT2);
export const MODES = {
  BPSK : {name:'BPSK',  req:9.6,  ber:e=>Q(Math.sqrt(2*e))},
  QPSK : {name:'QPSK',  req:9.6,  ber:e=>Q(Math.sqrt(2*e))},
  GMSK : {name:'GMSK',  req:10.4, ber:e=>Q(Math.sqrt(2*0.68*e))}, // BT=0.5 有效性損失
  FSK  : {name:'FSK',   req:13.4, ber:e=>0.5*Math.exp(-e/2)},     // 非同調
  APT  : {name:'APT(AM)',req:12.0,ber:()=>NaN}                    // 類比，無 BER
};

/* ── 主鏈路預算 ─────────────────────────────────────────────── */
export function linkBudget(o){
  const { f_Hz, range_m, el_deg, txPow_dBW, txGain_dBi, txFeed_dB,
          rxGain_dBi, rxFeed_dB, rxNF_dB, bitrate_bps, mode,
          rainRate_mmh=0, tec_TECU=20, txPol='circular', rxPol='linear',
          pointErr_deg=0, rxHpbw_deg=60 } = o;

  const EIRP   = txPow_dBW + txGain_dBi - txFeed_dB;
  const FSPL   = fspl_dB(range_m, f_Hz);
  const A_gas  = gasLoss_dB(f_Hz, el_deg);
  const A_rain = rainLoss_dB(f_Hz, el_deg, rainRate_mmh);
  const far    = faradayRot_rad(f_Hz, tec_TECU);
  const L_pol  = polLoss_dB(txPol, rxPol, far);
  const L_pt   = 12*Math.pow(pointErr_deg/rxHpbw_deg,2);
  const L_tot  = FSPL + A_gas + A_rain + L_pol + L_pt;

  const Tsky = skyNoiseTemp_K(f_Hz);
  const Tsys = sysNoiseTemp_K({Tant:Tsky, feedLoss_dB:rxFeed_dB, rxNF_dB});
  const GT   = rxGain_dBi - rxFeed_dB - 10*Math.log10(Tsys);

  const CN0  = EIRP - L_tot + GT - K_DB;          // dB-Hz
  const EbN0 = CN0 - 10*Math.log10(bitrate_bps);
  const M    = MODES[mode] || MODES.BPSK;
  const ber  = M.ber(Math.pow(10, EbN0/10));
  return { EIRP, FSPL, A_gas, A_rain, L_pol, L_pt, L_tot,
           faraday_deg: far*r2d, Tsky, Tsys, GT, CN0, EbN0,
           margin: EbN0 - M.req, ber, modeName: M.name, req: M.req };
}

/* ── 幾何 ───────────────────────────────────────────────────── */
export const doppler_Hz = (f_Hz, rangeRate_ms) => -f_Hz*rangeRate_ms/C;
/* 覆蓋圈地心半角：cos(el+lambda)*(Re+h) = Re*cos(el)  →  解 lambda */
export function footprintAngle_deg(alt_m, minEl_deg=0){
  const el=minEl_deg*d2r, Re=RE_WGS84, r=Re+alt_m;
  return (Math.acos(Re*Math.cos(el)/r) - el)*r2d;
}
/* SGP4 位置不確定度（Vallado）：epoch 約 1 km，之後每日 1–3 km */
export const sgp4Uncertainty_km = ageDays => 1.0 + 2.0*Math.abs(ageDays);

/* ── 太陽方向（Astronomical Almanac 低精度式，誤差 < 0.01°）───── */
export function sunEci(date){
  const JD = date.getTime()/86400000 + 2440587.5, n = JD-2451545.0;
  const L = (280.460 + 0.9856474*n)*d2r;
  const g = (357.528 + 0.9856003*n)*d2r;
  const lam = L + (1.915*Math.sin(g) + 0.020*Math.sin(2*g))*d2r;
  const eps = (23.439 - 0.0000004*n)*d2r;
  return { x: Math.cos(lam), y: Math.cos(eps)*Math.sin(lam), z: Math.sin(eps)*Math.sin(lam) };
}
/* 圓柱本影模型判定衛星是否進入地影。
   【模型簡化】忽略半影與大氣折射 → 進出影時刻誤差約數秒，偏保守。 */
export function inEclipse(satEci_km, sunUnit){
  const d = satEci_km.x*sunUnit.x + satEci_km.y*sunUnit.y + satEci_km.z*sunUnit.z;
  if(d>0) return false;
  const r2 = satEci_km.x**2+satEci_km.y**2+satEci_km.z**2;
  return Math.sqrt(r2-d*d) < RE_WGS84/1000;
}
