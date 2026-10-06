import argparse
import concurrent.futures
import hashlib
import json
import math
import pathlib
import re
import shutil
import time
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
BASE = "https://static.metaforge.app/wardogs"
MAPS = {"bakurani": "kavkazi", "ozeti": "europe", "zestafona": "northamerica"}


def confined(path):
    resolved = path.resolve()
    if not resolved.is_relative_to(ROOT.resolve()) or resolved == ROOT.resolve():
        raise ValueError("Scene asset paths must remain inside this project")
    return resolved


def read_json(url):
    request = urllib.request.Request(url, headers={"User-Agent": "WardogsLocalMap/3.0", "Accept": "application/json"})
    with urllib.request.urlopen(request, timeout=45) as response:
        data = response.read(32 * 1024 * 1024 + 1)
    if len(data) > 32 * 1024 * 1024:
        raise ValueError("Scene manifest is too large")
    return json.loads(data)


def public_landscape(landscape):
    return {name: value for name, value in landscape.items() if name != "directory"}


def validate_landscape(landscape, world):
    if not isinstance(landscape, dict) or landscape.get("world") != world:
        raise ValueError("Unexpected landscape world")
    version = landscape.get("version")
    if not isinstance(version, str) or not re.fullmatch(r"[a-f0-9]{8}", version):
        raise ValueError("Unexpected landscape version")
    layers = landscape.get("layers")
    if not isinstance(layers, list) or not 1 <= len(layers) <= 8 or len(set(layers)) != len(layers) or not all(isinstance(layer, str) and re.fullmatch(r"[A-Za-z][A-Za-z0-9_-]{0,40}", layer) for layer in layers):
        raise ValueError("Unsupported landscape layers")
    if landscape.get("channelsPerMask") != 3 or landscape.get("files") != [f"mask{index}.webp" for index in range(math.ceil(len(layers) / 3))]:
        raise ValueError("Unsupported landscape mask layout")
    if landscape.get("dir") != f"landscape-masks/{world}/{version}":
        raise ValueError("Unexpected landscape directory")


def detail_descriptor(detail, native, map_id):
    if not detail:
        return None
    if not isinstance(detail, dict) or not isinstance(detail.get("version"), str) or not re.fullmatch(r"[a-f0-9]{8}", detail["version"]):
        raise ValueError("Unexpected detail terrain version")
    for field in ["ratio", "cols", "rows", "samples", "tilesX", "tilesY", "count"]:
        if type(detail.get(field)) is not int or detail[field] <= 0:
            raise ValueError("Invalid detail terrain dimensions")
    if detail["ratio"] > 8 or detail["samples"] > 512 or detail["cols"] != (native["cols"] - 1) * detail["ratio"] + 1 or detail["rows"] != (native["rows"] - 1) * detail["ratio"] + 1:
        raise ValueError("Unsupported detail terrain grid")
    if detail["tilesX"] != math.ceil(detail["cols"] / detail["samples"]) or detail["tilesY"] != math.ceil(detail["rows"] / detail["samples"]) or detail["count"] != detail["tilesX"] * detail["tilesY"]:
        raise ValueError("Invalid detail terrain tile count")
    return {**native, **detail, "origin": native["origin"], "step": [value / detail["ratio"] for value in native["step"]], "sampleMetres": native["sampleMetres"] / detail["ratio"], "directory": f"assets/terrain/detail/{map_id}"}


def download(job):
    path = confined(job["path"])
    cached = job.get("cached")
    candidate = confined(ROOT / job["filename"])
    if cached and candidate.is_file() and candidate.stat().st_size == cached["bytes"]:
        digest = hashlib.sha256(candidate.read_bytes()).hexdigest()
        if digest == cached["sha256"] and (job["expected"] is None or cached["bytes"] == job["expected"]):
            if path != candidate:
                path.parent.mkdir(parents=True, exist_ok=True)
                temporary = path.with_suffix(path.suffix + ".part")
                shutil.copyfile(candidate, temporary)
                temporary.replace(path)
            return job["filename"], cached["bytes"], digest
    path.parent.mkdir(parents=True, exist_ok=True)
    for attempt in range(4):
        try:
            request = urllib.request.Request(job["url"], headers={"User-Agent": "WardogsLocalMap/3.0"})
            limit = job["expected"] or 32 * 1024 * 1024
            with urllib.request.urlopen(request, timeout=60) as response:
                data = response.read(limit + 1)
            if len(data) > limit or job["expected"] is not None and len(data) != job["expected"]:
                raise ValueError("Unexpected scene asset size")
            if path.suffix == ".webp" and (data[:4] != b"RIFF" or data[8:12] != b"WEBP"):
                raise ValueError("Scene image is not a WebP asset")
            temporary = path.with_suffix(path.suffix + ".part")
            temporary.write_bytes(data)
            temporary.replace(path)
            return job["filename"], len(data), hashlib.sha256(data).hexdigest()
        except Exception:
            if attempt == 3:
                raise
            time.sleep(1 + attempt * 2)


def build_scene(assets, landscape_sources=None):
    assets = confined(assets)
    native = json.loads((assets / "terrain/manifest.json").read_text(encoding="utf-8-sig"))
    previous_file = ROOT / "assets/scene-manifest.json"
    previous = json.loads(previous_file.read_text(encoding="utf-8-sig")) if previous_file.is_file() else {}
    (assets / "terrain/detail").mkdir(parents=True, exist_ok=True)
    (assets / "landscape").mkdir(parents=True, exist_ok=True)
    scenes = {}
    for map_id, world in MAPS.items():
        source = json.loads((assets / f"{map_id}-source.json").read_text(encoding="utf-8-sig"))
        if source["terrain"]["world"] != world or native[map_id]["world"] != world:
            raise ValueError("Unexpected terrain world")
        detail = source["terrain"].get("detail")
        landscape = landscape_sources[map_id] if landscape_sources is not None else read_json(f"https://metaforge.app/api/wardogs/map/{world}/landscape")
        validate_landscape(landscape, world)
        descriptor = detail_descriptor(detail, native[map_id], map_id)
        old = previous.get(map_id, {})
        jobs = []

        def enqueue(url, relative, expected, reusable):
            filename = "assets/" + relative
            cached = old.get("files", {}).get(filename) if reusable else None
            jobs.append({"url": url, "path": assets / relative, "filename": filename, "expected": expected, "cached": cached})

        for row in range(detail["tilesY"] if detail else 0):
            for column in range(detail["tilesX"]):
                width = min(detail["samples"], detail["cols"] - column * detail["samples"])
                height = min(detail["samples"], detail["rows"] - row * detail["samples"])
                filename = f"{column}_{row}.bin"
                reusable = bool(old.get("detail") and old["detail"]["version"] == detail["version"])
                enqueue(f"{BASE}/terrain/{world}/detail/{detail['version']}/{filename}", f"terrain/detail/{map_id}/{filename}", width * height * 2, reusable)
        reusable = bool(old.get("landscape") and public_landscape(old["landscape"]) == public_landscape(landscape))
        for filename in landscape["files"]:
            enqueue(f"{BASE}/{landscape['dir']}/{filename}", f"landscape/{map_id}/{filename}", None, reusable)
        for layer in landscape["layers"]:
            enqueue(f"{BASE}/landscape-layers/{world}/{layer}.webp", f"landscape/{map_id}/{layer}.webp", None, reusable)
        files = {}
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as executor:
            for index, result in enumerate(executor.map(download, jobs), 1):
                filename, size, digest = result
                files[filename] = {"bytes": size, "sha256": digest}
                if index % 128 == 0 or index == len(jobs):
                    print(f"{map_id}: {index}/{len(jobs)}", flush=True)
        scenes[map_id] = {"detail": descriptor, "landscape": {**public_landscape(landscape), "directory": f"assets/landscape/{map_id}"}, "sky": source.get("sky"), "files": files}
        print(f"{map_id}: complete", flush=True)
    destination = assets / "scene-manifest.json"
    temporary = destination.with_suffix(".json.part")
    temporary.write_text(json.dumps(scenes, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    temporary.replace(destination)
    return scenes


def main():
    parser = argparse.ArgumentParser(description="Build versioned offline detail heights, landscape masks and sky metadata")
    parser.add_argument("--assets-dir", type=pathlib.Path, default=ROOT / "assets")
    parser.add_argument("--landscape-source", type=pathlib.Path)
    arguments = parser.parse_args()
    landscapes = json.loads(confined(arguments.landscape_source).read_text(encoding="utf-8-sig")) if arguments.landscape_source else None
    build_scene(arguments.assets_dir, landscapes)


if __name__ == "__main__":
    main()
