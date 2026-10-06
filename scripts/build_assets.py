import json
import math
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "assets"
CDN = "https://static.metaforge.app"
CONFIGS = {
    "bakurani": {
        "name": "Bakurani", "zh": "巴库拉尼", "region": "东欧 · 山地河谷",
        "description": "穿越河谷与工业区，在林地和山脊间争夺制高点。",
        "bounds": [-1632000, -2040000, 1632000], "center": [-830053, -1120089],
        "capturable": ["kavkazi-tower-1", "kavkazi-tower-2", "kavkazi-tower-3", "kavkazi-tower-4", "kavkazi-tower-5-l"],
        "control": [["中心战区", -836067.25, -1123312.1, 50000], ["农田战区", -821482.6, -1098870.4, 50000], ["木材厂战区", -810231.7, -1123280, 50000]],
    },
    "ozeti": {
        "name": "Ozeti", "zh": "奥泽蒂", "region": "西欧 · 林地盆地",
        "description": "城镇、体育场与农田交织，河流分隔出不同的进攻路线。",
        "bounds": [-1616000, -1616000, 1632000], "center": [-637636, -611097],
        "control": [["中心战区", -619826.56, -616670.94, 55000], ["农田战区", -672935.1, -616922.44, 55000], ["教堂战区", -603697.2, -613630.56, 55000], ["河流战区", -642564.06, -605435.56, 55000]],
    },
    "zestafona": {
        "name": "Zestafona", "zh": "泽斯塔福纳", "region": "北美 · 河湾城镇",
        "description": "沿蜿蜒的河湾展开行动，穿越仓储区、农田与密集林地。",
        "bounds": [-819200, -819200, 1638400], "center": [-129600, -217600], "control": [],
    },
}

def download(job):
    url, destination = job
    if destination.exists() and destination.stat().st_size:
        return destination
    destination.parent.mkdir(parents=True, exist_ok=True)
    for attempt in range(3):
        try:
            request = urllib.request.Request(url, headers={"User-Agent": "WardogsLocalMap/1.0"})
            with urllib.request.urlopen(request, timeout=30) as response:
                destination.write_bytes(response.read())
            return destination
        except Exception:
            if attempt == 2:
                raise
            time.sleep(attempt + 1)

def pixel(config, longitude, latitude):
    minimum_x, minimum_y, span = config["bounds"]
    return [round((longitude - minimum_x) / span * 2048, 3), round((latitude - minimum_y) / span * 2048, 3)]

def assemble(map_id, zoom, start_x, start_y, target):
    texture = Image.new("RGB", (2048, 2048))
    for column in range(8):
        for row in range(8):
            source = ASSETS / "tiles" / map_id / str(zoom) / f"{start_x + column}_{start_y + row}.webp"
            with Image.open(source) as tile:
                texture.paste(tile.convert("RGB"), (column * 256, row * 256))
    texture.save(target, "WEBP", quality=88, method=6)
    return texture

def build():
    jobs = []
    for map_id, config in CONFIGS.items():
        center_x, center_y = pixel(config, *config["center"])
        start_x = max(0, min(24, math.floor(center_x / 64) - 4))
        start_y = max(0, min(24, math.floor(center_y / 64) - 4))
        config["detail"] = {"x": start_x * 64, "y": start_y * 64, "size": 512}
        for zoom, first_x, first_y in [(3, 0, 0), (5, start_x, start_y)]:
            for column in range(first_x, first_x + 8):
                for row in range(first_y, first_y + 8):
                    jobs.append((f"{CDN}/wardogs/maps/{map_id}/20260826/{zoom}/{column}_{row}.webp", ASSETS / "tiles" / map_id / str(zoom) / f"{column}_{row}.webp"))
    for name in ["faction-lonestar", "faction-valkyra", "faction-manticore", "tower", "tower-inactive"]:
        jobs.append((f"{CDN}/wardogs/maps/icons/{name}.webp", ASSETS / "icons" / f"{name}.webp"))
    jobs.append((f"{CDN}/games/wardogslogo120.webp", ASSETS / "wardogs-logo.webp"))
    with ThreadPoolExecutor(max_workers=12) as executor:
        futures = [executor.submit(download, job) for job in jobs]
        for completed, future in enumerate(as_completed(futures), 1):
            future.result()
            if completed % 40 == 0 or completed == len(jobs):
                print(f"Downloaded {completed}/{len(jobs)} resources", flush=True)
    maps = {}
    for map_id, config in CONFIGS.items():
        overview = assemble(map_id, 3, 0, 0, ASSETS / f"{map_id}.webp")
        overview.thumbnail((480, 480))
        overview.save(ASSETS / f"{map_id}-preview.webp", "WEBP", quality=82)
        detail = config["detail"]
        assemble(map_id, 5, detail["x"] // 64, detail["y"] // 64, ASSETS / f"{map_id}-detail.webp")
        source = json.loads((ASSETS / f"{map_id}-source.json").read_text(encoding="utf-8-sig"))
        towers = {tower["zoneID"]: tower for tower in source["towers"] if tower.get("zoneID")}
        points, zones = [], []
        for zone in source["zones"]:
            kind = zone["subcategory"]
            if kind == "towers":
                kind = "towers" if zone["id"] in config.get("capturable", towers) else "inactive"
            structure = towers.get(zone["id"], zone)
            points.append({"id": zone["id"], "name": zone["name"], "kind": kind, "position": pixel(config, structure["lng"], structure["lat"]), "alt": structure.get("alt"), "label": zone["subcategory"] != "towers"})
            zones.append({"id": zone["id"], "kind": kind, "polygon": [pixel(config, point["lng"], point["lat"]) for point in zone["polygon"]]})
        for item in source["facilities"] + source["features"]:
            points.append({"id": item["id"], "name": item["name"], "kind": item["kind"], "position": pixel(config, item["lng"], item["lat"]), "alt": item.get("alt"), "faction": item.get("faction"), "label": False})
        control = [{"name": name, "position": pixel(config, longitude, latitude), "radius": radius / config["bounds"][2] * 2048} for name, longitude, latitude, radius in config["control"]]
        maps[map_id] = {"id": map_id, "name": config["name"], "zh": config["zh"], "region": config["region"], "description": config["description"], "bounds": config["bounds"], "center": pixel(config, *config["center"]), "detail": detail, "points": points, "zones": zones, "control": control, "image": f"assets/{map_id}.webp", "detailImage": f"assets/{map_id}-detail.webp", "preview": f"assets/{map_id}-preview.webp"}
        print(f"Built {map_id}: {len(points)} real points, {len(zones)} zones", flush=True)
    (ROOT / "map-data.js").write_text("window.WARDOGS_MAPS = " + json.dumps(maps, ensure_ascii=False, separators=(",", ":")) + ";\n", encoding="utf-8")
    (ASSETS / "source-manifest.json").write_text(json.dumps({"provider": "MetaForge", "reference": "https://metaforge.app/wardogs/map", "tileVersion": "20260826", "mapData": [f"https://metaforge.app/api/wardogs/map/{key}" for key in ["kavkazi", "europe", "northamerica"]], "note": "Game assets belong to their respective owners. Local, non-commercial reference project."}, indent=2), encoding="utf-8")

if __name__ == "__main__":
    build()
