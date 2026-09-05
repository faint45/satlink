# -*- coding: utf-8 -*-
"""風景區導向的全球直播採集（第二版）。
   相對第一版的關鍵改動：加入「標題／頻道是否真的對應該地點」的比對驗證。
   第一版有數筆錯置（查『特羅姆瑟』回傳阿拉斯加 Fairbanks、查『黃石』回傳蒙大拿），
   若照搜尋詞給座標就會把攝影機標在錯誤位置。此處比對失敗一律捨棄，不硬湊。"""
import urllib.request, urllib.parse, json, re, ssl, time, unicodedata
ssl._create_default_https_context = ssl._create_unverified_context
UA={'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) satlink-sim/1.1'}
NOM={'User-Agent':'satlink-sim/1.1 (educational 3D earth project)'}
def get(u,h=UA,t=30): return urllib.request.urlopen(urllib.request.Request(u,headers=h),timeout=t).read()

def norm(s):
    s=unicodedata.normalize('NFKD',s or '')
    return ''.join(c for c in s if not unicodedata.combining(c)).lower()

def search_live(q,want=6):
    u=("https://www.youtube.com/results?search_query="+urllib.parse.quote(q)+"&sp=EgJAAQ%253D%253D")
    try: h=get(u).decode('utf-8','replace')
    except Exception: return []
    return list(dict.fromkeys(re.findall(r'"videoId":"([A-Za-z0-9_-]{11})"',h)))[:want]

def verify(vid):
    try:
        o=json.loads(get("https://www.youtube.com/oembed?url="+
            urllib.parse.quote(f"https://www.youtube.com/watch?v={vid}",safe='')+"&format=json"))
    except Exception: return None
    try: w=get(f"https://www.youtube.com/watch?v={vid}").decode('utf-8','replace')
    except Exception: return None
    if not (('"isLiveNow":true' in w) or ('"isLive":true' in w)): return None
    if '"playableInEmbed":true' not in w: return None
    m=re.search(r'"viewCount":\{"videoViewCountRenderer":\{"viewCount":\{"runs":\[\{"text":"([\d,]+)"',w)
    return {"id":vid,"title":o.get('title'),"channel":o.get('author_name'),
            "viewers":m.group(1) if m else None}

_gc={}
def geocode(q):
    if q in _gc: return _gc[q]
    try:
        r=json.loads(get("https://nominatim.openstreetmap.org/search?"+
            urllib.parse.urlencode({'q':q,'format':'json','limit':1}),h=NOM,t=25))
        time.sleep(1.15)
        _gc[q]=(float(r[0]['lat']),float(r[0]['lon']),r[0].get('display_name')) if r else None
    except Exception: _gc[q]=None
    return _gc[q]

# (地理編碼查詢字串, 中文名, 搜尋詞, 必須出現於標題/頻道的關鍵字之一)
T=[
 ("Mount Fuji, Japan","富士山","mount fuji live camera",["fuji","富士"]),
 ("Lake Kawaguchi, Japan","河口湖","kawaguchiko live camera",["kawaguchi","河口湖"]),
 ("Shirakawa-go, Japan","白川鄉","shirakawago live camera",["shirakawa","白川"]),
 ("Jeju Island, South Korea","濟州島","jeju live cam",["jeju","제주"]),
 ("Alishan, Taiwan","阿里山","阿里山 即時影像 直播",["阿里山","alishan"]),
 ("Sun Moon Lake, Taiwan","日月潭","日月潭 即時影像 直播",["日月潭","sun moon"]),
 ("Taipei 101, Taiwan","台北101","台北 象山 即時影像 直播",["台北","taipei"]),
 ("Halong Bay, Vietnam","下龍灣","ha long bay live cam",["long bay","halong"]),
 ("Bali, Indonesia","峇里島","bali live cam beach",["bali"]),
 ("Phuket, Thailand","普吉島","phuket live cam beach",["phuket"]),
 ("Maldives","馬爾地夫","maldives live cam",["maldive"]),
 ("Zermatt, Switzerland","策馬特","zermatt matterhorn live cam",["zermatt","matterhorn"]),
 ("Jungfraujoch, Switzerland","少女峰","jungfrau live cam",["jungfrau"]),
 ("Dolomites, Italy","多洛米蒂","dolomites live cam",["dolomit"]),
 ("Santorini, Greece","聖托里尼","santorini live cam",["santorini"]),
 ("Venice, Italy","威尼斯","venice live cam",["venice","venezia"]),
 ("Lake Bled, Slovenia","布萊德湖","lake bled live cam",["bled"]),
 ("Geiranger, Norway","蓋倫格峽灣","norway fjord live cam",["norway","fjord","geiranger"]),
 ("Tromso, Norway","特羅姆瑟","tromso northern lights live cam",["tromso","tromsø","norway"]),
 ("Reykjavik, Iceland","冰島","iceland volcano live cam",["iceland","volcano"]),
 ("Hallstatt, Austria","哈爾施塔特","hallstatt live cam",["hallstatt"]),
 ("Yosemite National Park, USA","優勝美地","yosemite live cam",["yosemite"]),
 ("Grand Canyon, USA","大峽谷","grand canyon live cam",["grand canyon"]),
 ("Yellowstone National Park, USA","黃石公園","old faithful live cam yellowstone",["yellowstone","old faithful"]),
 ("Banff National Park, Canada","班夫","banff live cam",["banff"]),
 ("Niagara Falls, Canada","尼加拉瀑布","niagara falls live cam",["niagara"]),
 ("Katmai National Park, Alaska, USA","布魯克斯瀑布棕熊","brooks falls bear cam katmai",["brooks","katmai"]),
 ("Waikiki, Honolulu, Hawaii, USA","威基基海灘","waikiki beach live cam",["waikiki"]),
 ("Machu Picchu, Peru","馬丘比丘","machu picchu live cam",["machu"]),
 ("Iguazu Falls, Argentina","伊瓜蘇瀑布","iguazu falls live cam",["iguaz","iguaç"]),
 ("Copacabana, Rio de Janeiro, Brazil","科帕卡巴納","copacabana live cam rio",["copacabana","rio"]),
 ("Victoria Falls, Zambia","維多利亞瀑布","victoria falls live cam",["victoria falls"]),
 ("Maasai Mara, Kenya","馬賽馬拉","masai mara live safari cam",["mara","kenya","safari"]),
 ("Kruger National Park, South Africa","克留格爾","kruger waterhole live cam",["kruger","waterhole"]),
 ("Table Mountain, Cape Town, South Africa","桌山","table mountain live cam",["table mountain","cape town"]),
 ("Great Barrier Reef, Australia","大堡礁","great barrier reef live cam",["reef","barrier"]),
 ("Sydney Harbour, Australia","雪梨港","sydney harbour live cam",["sydney"]),
 ("Milford Sound, New Zealand","米佛峽灣","milford sound live cam",["milford","fiordland"]),
 ("Amalfi Coast, Italy","阿瑪菲海岸","amalfi coast live cam",["amalfi","positano"]),
 ("Mont Saint-Michel, France","聖米歇爾山","mont saint michel live cam",["saint michel","mont-saint"]),
 ("Plitvice Lakes, Croatia","十六湖","plitvice live cam",["plitvice"]),
 ("Dubrovnik, Croatia","杜布羅夫尼克","dubrovnik live cam",["dubrovnik"]),
 ("Cinque Terre, Italy","五漁村","cinque terre live cam",["cinque","vernazza","monterosso"]),
 ("Lake Louise, Canada","露易絲湖","lake louise live cam",["louise"]),
 ("Mount Everest, Nepal","聖母峰","everest live cam nepal",["everest","khumbu"]),
]
out=[]; skipped=[]
for i,(place,zh,q,keys) in enumerate(T,1):
    cands=search_live(q)
    hit=None
    for vid in cands:
        v=verify(vid); time.sleep(0.35)
        if not v: continue
        blob=norm(v['title'])+' '+norm(v['channel'])
        if any(norm(k) in blob for k in keys): hit=v; break
    if not hit:
        skipped.append((zh,'標題與地點比對不通過或無可用直播'))
        print(f"[{i}/{len(T)}] {zh:12s} 捨棄（{len(cands)} 個候選都不符）",flush=True); continue
    g=geocode(place)
    if not g:
        skipped.append((zh,'地理編碼失敗')); print(f"[{i}/{len(T)}] {zh:12s} 地理編碼失敗",flush=True); continue
    out.append({"kind":"youtube","id":hit['id'],"title":hit['title'],"channel":hit['channel'],
                "viewers":hit['viewers'],"place":place,"zh":zh,
                "lat":round(g[0],5),"lon":round(g[1],5),"geo_name":g[2],
                "geo_precision":"place","matched":keys})
    print(f"[{i}/{len(T)}] {zh:12s} {hit['id']} {str(hit['viewers']):>7}人 {hit['title'][:42]}",flush=True)

json.dump({"fetched_utc":time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),
  "source":"YouTube 直播（live 篩選搜尋 → 逐一查證直播中且允許嵌入 → 標題/頻道須與地點關鍵字相符）",
  "geo_source":"OpenStreetMap Nominatim；座標為地點中心，非攝影機實際架設點",
  "verified":len(out),"skipped":skipped,"cams":out},
  open('scenic_cams.json','w'),ensure_ascii=False,indent=1)
print(f"\n通過 {len(out)}/{len(T)}；捨棄 {len(skipped)}")
