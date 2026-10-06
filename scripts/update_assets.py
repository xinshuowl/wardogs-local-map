import argparse
import copy
import hashlib
import json
import math
import os
import socket
import subprocess
import sys
import urllib.request
import uuid
from pathlib import Path

from download_scene_detail import build_scene, public_landscape, validate_landscape

ROOT = Path(__file__).resolve().parents[1]
WORLDS = {"bakurani": "kavkazi", "ozeti": "europe", "zestafona": "northamerica"}
KINDS = {"towers", "inactive", "spawn", "safe-zone", "vendor", "vehicle-board", "fuel", "ladder", "barbed-wire", "settlements", "industry", "terrain"}


def confined(path):
    resolved = path.resolve()
    if not resolved.is_relative_to(ROOT) or resolved == ROOT:
        raise ValueError("Update path escapes this project")
    return resolved


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def ensure_server_stopped():
    with socket.socket() as connection:
        connection.settimeout(1)
        if connection.connect_ex(("127.0.0.1", 4173)) == 0:
            raise RuntimeError("Close the local server before applying an update. No live data has been replaced.")


def write_json(path, value):
    confined(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


def fetch_json(world, suffix):
    request = urllib.request.Request(f"https://metaforge.app/api/wardogs/map/{world}{suffix}", headers={"User-Agent": "WardogsLocalAtlas/2.0"})
    with urllib.request.urlopen(request, timeout=45) as response:
        payload = response.read(32 * 1024 * 1024 + 1)
    if len(payload) > 32 * 1024 * 1024:
        raise ValueError("Source manifest is too large")
    value = json.loads(payload)
    if not isinstance(value, dict):
        raise ValueError("Unexpected source manifest")
    return value


def map_data(sources):
    prefix = "window.WARDOGS_MAPS = "
    text = (ROOT / "map-data.js").read_text(encoding="utf-8")
    if not text.startswith(prefix):
        raise ValueError("Unknown local map data format")
    maps = json.loads(text[len(prefix):].strip().removesuffix(";"))
    for map_id in WORLDS:
        source = sources[map_id]["map"]
        updated = copy.deepcopy(maps[map_id])
        bounds = updated["bounds"]
        def point(longitude, latitude):
            if not all(isinstance(value, (int, float)) and math.isfinite(value) for value in [longitude, latitude]):
                raise ValueError("Non-finite map coordinate")
            result = [(longitude - bounds[0]) / bounds[2] * 2048, (latitude - bounds[1]) / bounds[2] * 2048]
            if any(coordinate < -32 or coordinate > 2080 for coordinate in result):
                raise ValueError("Source map bounds changed; manual coordinate migration required")
            return [round(coordinate, 3) for coordinate in result]
        towers = {tower["zoneID"]: tower for tower in source["towers"] if tower.get("zoneID")}
        existing_towers = {item["id"] for item in updated["points"] if item["kind"] == "towers"}
        points = []
        zones = []
        for zone in source["zones"]:
            kind = zone["subcategory"]
            if kind == "towers":
                kind = "towers" if zone["id"] in existing_towers else "inactive"
            if kind not in KINDS:
                raise ValueError(f"New unsupported map category: {kind}")
            structure = towers.get(zone["id"], zone)
            points.append({"id": zone["id"], "name": zone["name"], "kind": kind, "position": point(structure["lng"], structure["lat"]), "alt": structure.get("alt"), "label": zone["subcategory"] != "towers"})
            zones.append({"id": zone["id"], "kind": kind, "polygon": [point(vertex["lng"], vertex["lat"]) for vertex in zone["polygon"]]})
        for item in source["facilities"] + source["features"]:
            if item["kind"] not in KINDS:
                raise ValueError("New unsupported facility category")
            points.append({"id": item["id"], "name": item["name"], "kind": item["kind"], "position": point(item["lng"], item["lat"]), "alt": item.get("alt"), "faction": item.get("faction"), "label": False})
        updated["points"] = points
        updated["zones"] = zones
        maps[map_id] = updated
    return "window.WARDOGS_MAPS = " + json.dumps(maps, ensure_ascii=False, separators=(",", ":")) + ";\n"


def commit(replacements, backup):
    audited = [(confined(source), confined(target), confined(backup / target.relative_to(ROOT))) for source, target in replacements]
    completed = []
    try:
        for source, target, previous in audited:
            previous.parent.mkdir(parents=True, exist_ok=True)
            target.parent.mkdir(parents=True, exist_ok=True)
            existed = target.exists()
            if existed:
                os.replace(target, previous)
            try:
                os.replace(source, target)
            except Exception:
                if existed:
                    os.replace(previous, target)
                raise
            completed.append((target, previous, existed, source))
    except Exception:
        for target, previous, existed, source in reversed(completed):
            source.parent.mkdir(parents=True, exist_ok=True)
            os.replace(target, source)
            if existed:
                os.replace(previous, target)
        raise


def main():
    parser = argparse.ArgumentParser(description="Check and stage versioned model, terrain, scene and point updates. Base-map imagery remains pinned to its verified version.")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--check", action="store_true")
    arguments = parser.parse_args()
    sources = {}
    scene_file = ROOT / "assets/scene-manifest.json"
    scenes = json.loads(scene_file.read_text(encoding="utf-8-sig")) if scene_file.is_file() else {}
    changed = []
    for map_id, world in WORLDS.items():
        source = {"map": fetch_json(world, ""), "props": fetch_json(world, "/props"), "materials": fetch_json(world, "/prop-materials"), "landscape": fetch_json(world, "/landscape")}
        validate_landscape(source["landscape"], world)
        sources[map_id] = source
        current_landscape = scenes.get(map_id, {}).get("landscape")
        if not current_landscape or fingerprint(public_landscape(current_landscape)) != fingerprint(public_landscape(source["landscape"])):
            changed.append(f"{map_id}/landscape")
        for kind, filename in [("map", ROOT / "assets" / f"{map_id}-source.json"), ("props", ROOT / "assets" / "models" / f"{map_id}-source.json"), ("materials", ROOT / "assets" / "models" / f"{map_id}-materials-source.json")]:
            current = json.loads(filename.read_text(encoding="utf-8-sig"))
            if fingerprint(current) != fingerprint(source[kind]):
                changed.append(f"{map_id}/{kind}")
        print(f"{map_id}: models {source['props']['version']}, materials {source['materials']['version']}, terrain {source['map']['terrain']['tiles']['version']}", flush=True)
    print("Changes: " + (", ".join(changed) if changed else "none"), flush=True)
    if not arguments.apply or not changed:
        return
    ensure_server_stopped()
    generated_points = map_data(sources)
    operation = uuid.uuid4().hex
    stage = ROOT / ".asset-updates" / ("stage-" + operation)
    backup = ROOT / ".asset-updates" / ("backup-" + operation)
    staged_assets = stage / "assets"
    staged_models = staged_assets / "models"
    for map_id in WORLDS:
        write_json(staged_assets / f"{map_id}-source.json", sources[map_id]["map"])
        write_json(staged_models / f"{map_id}-source.json", sources[map_id]["props"])
        write_json(staged_models / f"{map_id}-materials-source.json", sources[map_id]["materials"])
    subprocess.run([sys.executable, str(ROOT / "scripts" / "build_models.py"), "--output-dir", str(staged_models), "--cache-dir", str(ROOT / "assets" / "models" / "source"), "--texture-size", "1024"], check=True, cwd=ROOT)
    subprocess.run([sys.executable, str(ROOT / "scripts" / "build_terrain.py"), "--assets-dir", str(staged_assets), "--cache-dir", str(ROOT / "assets" / "terrain" / "source")], check=True, cwd=ROOT)
    build_scene(staged_assets, {map_id: source["landscape"] for map_id, source in sources.items()})
    (stage / "map-data.js").write_text(generated_points, encoding="utf-8")
    replacements = [(stage / "map-data.js", ROOT / "map-data.js")]
    for map_id in WORLDS:
        replacements.extend([(staged_models / map_id, ROOT / "assets" / "models" / map_id), (staged_assets / f"{map_id}-source.json", ROOT / "assets" / f"{map_id}-source.json")])
        for suffix in ["-source.json", "-materials-source.json"]:
            replacements.append((staged_models / (map_id + suffix), ROOT / "assets" / "models" / (map_id + suffix)))
    for filename in (staged_assets / "terrain").iterdir():
        if filename.is_file():
            replacements.append((filename, ROOT / "assets" / "terrain" / filename.name))
    replacements.extend([(staged_assets / "scene-manifest.json", ROOT / "assets/scene-manifest.json"), (staged_assets / "landscape", ROOT / "assets/landscape"), (staged_assets / "terrain/detail", ROOT / "assets/terrain/detail")])
    ensure_server_stopped()
    commit(replacements, backup)
    write_json(backup / "update-report.json", {"changes": changed, "baseMapVersion": "20260826", "backup": str(backup)})
    print(f"Update complete. Previous resources retained at {backup}", flush=True)


if __name__ == "__main__":
    main()
