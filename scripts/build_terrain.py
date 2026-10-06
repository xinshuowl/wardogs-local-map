import array
import argparse
import json
import re
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "assets"
TARGET = ASSETS / "terrain"
CACHE = TARGET / "source"
CDN = "https://static.metaforge.app/wardogs/terrain"
MAPS = ["bakurani", "ozeti", "zestafona"]


def download_tile(job):
    descriptor, column, row = job
    world = descriptor["world"]
    tiles = descriptor["tiles"]
    width = min(tiles["samples"], descriptor["grid"]["cols"] - column * tiles["samples"])
    height = min(tiles["samples"], descriptor["grid"]["rows"] - row * tiles["samples"])
    expected = width * height * 2
    destination = CACHE / world / tiles["version"] / f"{column}_{row}.bin"
    if not destination.exists() or destination.stat().st_size != expected:
        destination.parent.mkdir(parents=True, exist_ok=True)
        url = f"{CDN}/{world}/{tiles['version']}/{column}_{row}.bin"
        for attempt in range(3):
            try:
                request = urllib.request.Request(url, headers={"User-Agent": "WardogsLocalAtlas/1.1", "Accept-Encoding": "identity"})
                with urllib.request.urlopen(request, timeout=45) as response:
                    data = response.read()
                if len(data) != expected:
                    raise ValueError(f"{url}: {len(data)} bytes, expected {expected}")
                destination.write_bytes(data)
                break
            except Exception:
                if attempt == 2:
                    raise
                time.sleep(attempt + 1)
    values = array.array("H", destination.read_bytes())
    if sys.byteorder != "little":
        values.byteswap()
    return column, row, width, height, values


def build():
    TARGET.mkdir(parents=True, exist_ok=True)
    manifest = {}
    for map_id in MAPS:
        descriptor = json.loads((ASSETS / f"{map_id}-source.json").read_text(encoding="utf-8"))["terrain"]
        grid = descriptor["grid"]
        tiles = descriptor["tiles"]
        expected_world = {"bakurani": "kavkazi", "ozeti": "europe", "zestafona": "northamerica"}[map_id]
        if descriptor["world"] != expected_world or not re.fullmatch(r"[a-f0-9]{8}", tiles["version"]):
            raise ValueError("Unexpected terrain world or source version")
        if any(type(grid[key]) is not int or not 2 <= grid[key] <= 4096 for key in ["cols", "rows"]):
            raise ValueError("Unsupported terrain grid dimensions")
        full = array.array("H", [0]) * (grid["cols"] * grid["rows"])
        jobs = [(descriptor, column, row) for row in range(tiles["tilesY"]) for column in range(tiles["tilesX"])]
        with ThreadPoolExecutor(max_workers=8) as executor:
            for completed in as_completed(executor.submit(download_tile, job) for job in jobs):
                column, row, width, height, values = completed.result()
                for offset in range(height):
                    start = (row * tiles["samples"] + offset) * grid["cols"] + column * tiles["samples"]
                    full[start:start + width] = values[offset * width:(offset + 1) * width]
        actual_minimum, actual_maximum = min(full), max(full)
        if {"min": actual_minimum, "max": actual_maximum} != descriptor["height16"]:
            raise ValueError(f"{map_id}: height range does not match the versioned descriptor")
        stride = 1
        reduced = array.array("H", (full[row * grid["cols"] + column] for row in range(0, grid["rows"], stride) for column in range(0, grid["cols"], stride)))
        if sys.byteorder != "little":
            reduced.byteswap()
        filename = f"{map_id}-height-native.bin"
        (TARGET / filename).write_bytes(reduced.tobytes())
        origin_x = descriptor["location"]["x"] + grid["quadOriginX"] * descriptor["scale"]["x"]
        origin_y = descriptor["location"]["y"] + grid["quadOriginY"] * descriptor["scale"]["y"]
        manifest[map_id] = {
            "file": f"assets/terrain/{filename}", "cols": (grid["cols"] - 1) // stride + 1, "rows": (grid["rows"] - 1) // stride + 1,
            "origin": [origin_x, origin_y], "step": [grid["stepQuads"] * stride * descriptor["scale"]["x"], grid["stepQuads"] * stride * descriptor["scale"]["y"]],
            "heightOffset": descriptor["location"]["z"], "heightScale": descriptor["scale"]["z"] / 128,
            "minimumMetres": round((descriptor["location"]["z"] + (actual_minimum - 32768) / 128 * descriptor["scale"]["z"]) / 100, 3),
            "maximumMetres": round((descriptor["location"]["z"] + (actual_maximum - 32768) / 128 * descriptor["scale"]["z"]) / 100, 3),
            "world": descriptor["world"], "sourceVersion": tiles["version"], "sourceGrid": [grid["cols"], grid["rows"]], "sampleMetres": grid["stepQuads"] * stride * descriptor["scale"]["x"] / 100,
        }
        print(f"{map_id}: {manifest[map_id]['cols']} x {manifest[map_id]['rows']}, {len(reduced) * 2:,} bytes, {actual_minimum}..{actual_maximum}", flush=True)
    (TARGET / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Build versioned offline terrain")
    parser.add_argument("--assets-dir", type=Path)
    parser.add_argument("--cache-dir", type=Path)
    arguments = parser.parse_args()
    if arguments.assets_dir:
        ASSETS = arguments.assets_dir.resolve()
        TARGET = ASSETS / "terrain"
    if arguments.cache_dir:
        CACHE = arguments.cache_dir.resolve()
    if not ASSETS.resolve().is_relative_to(ROOT) or not CACHE.resolve().is_relative_to(ROOT):
        parser.error("Asset and cache directories must remain inside this project")
    build()
