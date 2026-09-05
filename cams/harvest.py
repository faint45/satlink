# -*- coding: utf-8 -*-
"""採集全球公開直播影像來源。
   1) YouTube：以 live 篩選搜尋，逐一查證「確實在直播」且「允許嵌入」。
   2) 座標：以 OpenStreetMap Nominatim 地理編碼（遵守 1 req/s 與 User-Agent 規範）。
      注意：YouTube 直播本身不提供座標，此處取「地點名稱的市級中心點」，
      因此座標為城市級近似，非攝影機實際位置 —— 必須在介面上標明。"""
import urllib.request, urllib.parse, json, re, ssl, time, sys, io
ssl._create_default_https_context = ssl._create_unverified_context
UA = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) satlink-sim/1.1 (research prototype)'}
NOM_UA = {'User-Agent': 'satlink-sim/1.1 (educational 3D earth project; contact via github)'}

def get(url, headers=UA, timeout=30):
    return urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=timeout).read()

def search_live(q, want=3):
    u = ("https://www.youtube.com/results?search_query=" + urllib.parse.quote(q)
         + "&sp=EgJAAQ%253D%253D")                     # sp=EgJAAQ%3D%3D 即「直播中」篩選
    try: h = get(u).decode('utf-8', 'replace')
    except Exception as e: return []
    ids = list(dict.fromkeys(re.findall(r'"videoId":"([A-Za-z0-9_-]{11})"', h)))
    return ids[:want]

def verify(vid):
    """回傳 (ok, title, channel, viewers) —— 必須同時滿足：直播中、允許嵌入。"""
    try:
        o = json.loads(get("https://www.youtube.com/oembed?url=" +
              urllib.parse.quote(f"https://www.youtube.com/watch?v={vid}", safe='') + "&format=json"))
    except Exception:
        return (False, None, None, None)
    try:
        w = get(f"https://www.youtube.com/watch?v={vid}").decode('utf-8', 'replace')
    except Exception:
        return (False, None, None, None)
    live = ('"isLiveNow":true' in w) or ('"isLive":true' in w)
    emb  = '"playableInEmbed":true' in w
    m = re.search(r'"viewCount":\{"videoViewCountRenderer":\{"viewCount":\{"runs":\[\{"text":"([\d,]+)"', w)
    return (live and emb, o.get('title'), o.get('author_name'), m.group(1) if m else None)

_geo_cache = {}
def geocode(place):
    if place in _geo_cache: return _geo_cache[place]
    u = "https://nominatim.openstreetmap.org/search?" + urllib.parse.urlencode(
        {'q': place, 'format': 'json', 'limit': 1})
    try:
        r = json.loads(get(u, headers=NOM_UA, timeout=25))
        time.sleep(1.15)                                # Nominatim 使用規範：每秒最多 1 次
        if r: _geo_cache[place] = (float(r[0]['lat']), float(r[0]['lon']), r[0].get('display_name'))
        else: _geo_cache[place] = None
    except Exception:
        _geo_cache[place] = None
    return _geo_cache[place]

TARGETS = [
 ("Tokyo, Japan","東京","tokyo live camera street"),
 ("Shibuya, Tokyo, Japan","澀谷","shibuya crossing live camera"),
 ("Osaka, Japan","大阪","osaka live camera dotonbori"),
 ("Seoul, South Korea","首爾","seoul live cam"),
 ("Taipei, Taiwan","台北","taipei live camera"),
 ("Hong Kong","香港","hong kong live cam"),
 ("Singapore","新加坡","singapore live camera"),
 ("Bangkok, Thailand","曼谷","bangkok live cam street"),
 ("Dubai, United Arab Emirates","杜拜","dubai live cam"),
 ("Kathmandu, Nepal","加德滿都","kathmandu live cam"),
 ("Times Square, New York, USA","紐約時代廣場","times square live cam"),
 ("New York City, USA","紐約","new york live cam street"),
 ("Los Angeles, California, USA","洛杉磯","los angeles live cam beach"),
 ("San Francisco, California, USA","舊金山","san francisco live cam"),
 ("Chicago, Illinois, USA","芝加哥","chicago live cam"),
 ("Miami, Florida, USA","邁阿密","miami beach live cam"),
 ("Las Vegas, Nevada, USA","拉斯維加斯","las vegas live cam"),
 ("New Orleans, Louisiana, USA","紐奧良","new orleans bourbon street live cam"),
 ("Toronto, Canada","多倫多","toronto live cam"),
 ("Mexico City, Mexico","墨西哥城","mexico city live cam"),
 ("Rio de Janeiro, Brazil","里約","rio de janeiro live cam"),
 ("Buenos Aires, Argentina","布宜諾斯艾利斯","buenos aires live cam"),
 ("London, United Kingdom","倫敦","london live cam street"),
 ("Paris, France","巴黎","paris live cam eiffel"),
 ("Rome, Italy","羅馬","rome live cam"),
 ("Venice, Italy","威尼斯","venice live cam"),
 ("Amsterdam, Netherlands","阿姆斯特丹","amsterdam live cam"),
 ("Prague, Czech Republic","布拉格","prague live cam"),
 ("Barcelona, Spain","巴塞隆納","barcelona live cam"),
 ("Dublin, Ireland","都柏林","dublin live cam"),
 ("Zurich, Switzerland","蘇黎世","switzerland live cam mountain"),
 ("Reykjavik, Iceland","雷克雅維克","iceland live cam volcano"),
 ("Istanbul, Turkey","伊斯坦堡","istanbul live cam"),
 ("Sydney, Australia","雪梨","sydney live cam harbour"),
 ("Auckland, New Zealand","奧克蘭","new zealand live cam"),
 ("Cape Town, South Africa","開普敦","cape town live cam"),
 ("Kruger National Park, South Africa","克留格爾國家公園","africa safari live cam waterhole"),
 ("Tromso, Norway","特羅姆瑟","northern lights live cam aurora"),
 ("Yellowstone National Park, USA","黃石公園","yellowstone live cam old faithful"),
 ("Niagara Falls, Canada","尼加拉瀑布","niagara falls live cam"),
 ("Mount Fuji, Japan","富士山","mount fuji live camera"),
 ("Katmai National Park, Alaska, USA","卡特邁棕熊","brooks falls bear live cam"),
 ("Honolulu, Hawaii, USA","檀香山","hawaii live cam beach"),
 ("Jerusalem, Israel","耶路撒冷","jerusalem live cam western wall"),
 ("Machu Picchu, Peru","馬丘比丘","peru live cam"),
]

out=[]
for i,(place, zh, query) in enumerate(TARGETS):
    ids = search_live(query, want=3)
    picked=None
    for vid in ids:
        ok,title,ch,view = verify(vid)
        time.sleep(0.4)
        if ok: picked=(vid,title,ch,view); break
    if not picked:
        print(f"[{i+1}/{len(TARGETS)}] {zh:12s} 無可用直播", flush=True); continue
    g = geocode(place)
    if not g:
        print(f"[{i+1}/{len(TARGETS)}] {zh:12s} 地理編碼失敗", flush=True); continue
    vid,title,ch,view = picked
    out.append({"kind":"youtube","id":vid,"title":title,"channel":ch,
                "viewers":view,"place":place,"zh":zh,
                "lat":round(g[0],5),"lon":round(g[1],5),"geo_name":g[2],
                "geo_precision":"city"})
    print(f"[{i+1}/{len(TARGETS)}] {zh:12s} {vid}  {str(view):>8} 人  {title[:44]}", flush=True)

json.dump({"fetched_utc": time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
           "source":"YouTube 直播（以 live 篩選搜尋後逐一查證：確實直播中且允許嵌入）；"
                    "座標為 OpenStreetMap Nominatim 之地點中心，屬城市級近似",
           "cams": out}, open('youtube_cams.json','w'), ensure_ascii=False, indent=1)
print(f"\n完成：{len(out)}/{len(TARGETS)} 個地點取得可用直播")
