import argparse
import array
import hashlib
import io
import json
import math
import re
import struct
import shutil
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
TARGET = ROOT / "assets" / "models"
CACHE = TARGET / "source"
CDN = "https://static.metaforge.app"
WORLDS = {"bakurani": "kavkazi", "ozeti": "europe", "zestafona": "northamerica"}
CENTRES = {"bakurani": [-8300.53, -11200.89], "ozeti": [-6376.36, -6110.97], "zestafona": [-1296, -2176]}


def fetch(url, destination, expected=None):
    if destination.exists() and (expected is None or destination.stat().st_size == expected):
        return destination.read_bytes()
    destination.parent.mkdir(parents=True, exist_ok=True)
    for attempt in range(4):
        try:
            request = urllib.request.Request(url, headers={"User-Agent": "WardogsLocalAtlas/1.2", "Accept-Encoding": "identity"})
            with urllib.request.urlopen(request, timeout=60) as response:
                data = response.read()
            if expected is not None and len(data) != expected:
                raise ValueError(f"{url}: expected {expected} bytes, got {len(data)}")
            destination.write_bytes(data)
            return data
        except Exception:
            if attempt == 3:
                raise
            time.sleep(attempt + 1)


def category(path, bounds):
    if not path or not bounds:
        return None
    if re.search(r"(?:Collision|Invisible|Decal|SkySphere|Fog|/Landscape/)", path, re.I):
        return None
    extent = [bounds[index + 3] - bounds[index] for index in range(3)]
    if max(extent) < 0.35:
        return None
    if "/Architecture/" in path or re.search(r"(?:Bridge|Tunnel|Railway|Walls_and_Fences|Bunker|Tower)", path, re.I):
        return "buildings"
    if "/Foliage/" in path:
        return "trees" if max(extent) >= 0.65 else None
    return "props"


def validate_asset_name(filename):
    if not isinstance(filename, str) or not re.fullmatch(r"[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(?:glb|webp)", filename):
        raise ValueError("Unsafe model asset filename")
    return filename


def glb_json(data):
    magic, version, length = struct.unpack_from("<III", data)
    if magic != 0x46546C67 or version != 2 or length != len(data):
        raise ValueError("Invalid GLB header")
    size, chunk_type = struct.unpack_from("<II", data, 12)
    if chunk_type != 0x4E4F534A:
        raise ValueError("Missing GLB JSON chunk")
    descriptor = json.loads(data[20:20 + size])
    if any(buffer.get("uri") for buffer in descriptor.get("buffers", [])) or descriptor.get("images"):
        raise ValueError("Unexpected external or embedded texture dependency")
    return descriptor


def build_tile(job):
    map_id, source, selected, column, row = job
    world = WORLDS[map_id]
    key = f"{column}_{row}"
    cache = CACHE / world / source["version"] / f"{key}.bin"
    data = fetch(f"{CDN}/wardogs/props/{world}/{source['version']}/{key}.bin", cache)
    if len(data) < 4:
        raise ValueError(f"{map_id}/{key}: incomplete tile")
    group_count = struct.unpack_from("<I", data)[0]
    offset = (1 + group_count * 2) * 4
    if offset > len(data):
        raise ValueError(f"{map_id}/{key}: incomplete header")
    groups = []
    records = []
    counts = {"buildings": 0, "trees": 0, "props": 0}
    original = 0
    building_x = []
    building_z = []
    for group_index in range(group_count):
        mesh_index, count = struct.unpack_from("<II", data, 4 + group_index * 8)
        if mesh_index >= len(source["meshFiles"]):
            raise ValueError(f"{map_id}/{key}: invalid mesh index")
        end = offset + count * 44
        if end > len(data):
            raise ValueError(f"{map_id}/{key}: incomplete instance records")
        original += count
        info = selected.get(mesh_index)
        if info and count:
            values = array.array("f", data[offset:end])
            if sys.byteorder != "little":
                values.byteswap()
            if not all(math.isfinite(value) for value in values):
                raise ValueError(f"{map_id}/{key}: non-finite instance transform")
            for instance in range(count):
                start = instance * 11
                quaternion_length = sum(values[start + component] ** 2 for component in range(3, 7))
                if not 0.98 <= quaternion_length <= 1.02:
                    raise ValueError(f"{map_id}/{key}: invalid quaternion")
                if info["type"] == "buildings":
                    building_x.append(values[start])
                    building_z.append(values[start + 2])
            counts[info["type"]] += count
            groups.append((mesh_index, count))
            records.append(data[offset:end])
        offset = end
    if offset != len(data):
        raise ValueError(f"{map_id}/{key}: unexpected trailing bytes")
    output = struct.pack("<I", len(groups)) + b"".join(struct.pack("<II", *group) for group in groups) + b"".join(records)
    destination = TARGET / map_id / "tiles" / f"{key}.bin"
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(output)
    centre = [sum(building_x) / len(building_x), sum(building_z) / len(building_z)] if building_x else None
    return {"key": key, "x": column, "z": row, "file": f"tiles/{key}.bin", "bytes": len(output), "sourceInstances": original, "counts": counts, "centre": centre, "sha256": hashlib.sha256(output).hexdigest()}


def build_texture(job):
    map_id, world, version, filename, maximum = job
    validate_asset_name(filename)
    cache = CACHE / world / "textures" / version / filename
    data = fetch(f"{CDN}/wardogs/prop-textures/{world}/{filename}?v={version}", cache)
    with Image.open(io.BytesIO(data)) as source_image:
        source_image.load()
        image = source_image.convert("RGBA" if "A" in source_image.getbands() else "RGB")
        image.thumbnail((maximum, maximum), Image.Resampling.LANCZOS)
        destination = TARGET / map_id / "textures" / filename
        destination.parent.mkdir(parents=True, exist_ok=True)
        image.save(destination, "WEBP", quality=88, method=4, exact=True)
    return filename, {"width": image.width, "height": image.height, "bytes": destination.stat().st_size, "sourceSha256": hashlib.sha256(data).hexdigest()}


def parallel(jobs, worker, workers, label):
    results = []
    with ThreadPoolExecutor(max_workers=workers) as executor:
        futures = [executor.submit(worker, job) for job in jobs]
        for completed in as_completed(futures):
            results.append(completed.result())
            if len(results) % 50 == 0 or len(results) == len(jobs):
                print(f"{label}: {len(results)}/{len(jobs)}", flush=True)
    return results


def build(map_id, workers, texture_size):
    world = WORLDS[map_id]
    source_file = TARGET / f"{map_id}-source.json"
    materials_file = TARGET / f"{map_id}-materials-source.json"
    source = json.loads(fetch(f"https://metaforge.app/api/wardogs/map/{world}/props", source_file))
    material_source = json.loads(fetch(f"https://metaforge.app/api/wardogs/map/{world}/prop-materials", materials_file))
    if source["floatsPerInstance"] != 11 or material_source["world"] != world:
        raise ValueError("Unsupported model manifest")
    bundle_source = source["bundles"]
    if any(not isinstance(version, str) or not re.fullmatch(r"[a-f0-9]{8}", version) for version in [source["version"], bundle_source["version"], material_source["version"]]):
        raise ValueError("Invalid asset version")
    if any(len(tile) != 2 or any(type(coordinate) is not int for coordinate in tile) for tile in source["tiles"]):
        raise ValueError("Invalid tile coordinates")
    bundles = [bundle_source["sharedHead"], *bundle_source["sharedRest"], *bundle_source["sectors"]]
    selected = {}
    available = {mesh_index for bundle in bundles for mesh_index in bundle["meshes"]}
    for mesh_index in available:
        path = source["meshFiles"][mesh_index]
        bounds = source["meshBounds"][mesh_index]
        kind = category(path, bounds)
        if kind:
            selected[mesh_index] = {"name": Path(path).stem, "type": kind, "bounds": bounds, "solid": bool(source.get("meshSolid", [False] * len(source["meshFiles"]))[mesh_index])}
    tile_jobs = [(map_id, source, selected, column, row) for column, row in source["tiles"]]
    tiles = parallel(tile_jobs, build_tile, workers, f"{map_id} tiles")
    total_original = sum(tile["sourceInstances"] for tile in tiles)
    expected = sum(source["meshInstanceCounts"])
    if total_original != expected:
        raise ValueError(f"{map_id}: instance count {total_original} differs from manifest {expected}")
    live_path = ROOT / "assets" / "models" / map_id / "manifest.json"
    live_manifest = json.loads(live_path.read_text(encoding="utf-8")) if live_path.exists() else {}
    live_files = {Path(level["file"]).name: level for item in live_manifest.get("bundles", []) for level in item.get("lods", {"2": item}).values()} if live_manifest.get("bundleVersion") == bundle_source["version"] else {}
    materials_needed = set()
    bundle_manifest = []
    for bundle in bundles:
        chosen = set(bundle["meshes"]) & selected.keys()
        if not chosen:
            continue
        index = len(bundle_manifest)
        levels = {}
        for lod in [2, 1, 0]:
            resource = bundle["files"].get(str(lod))
            if resource is None:
                continue
            filename = validate_asset_name(resource["file"])
            cache = CACHE / world / "bundles" / bundle_source["version"] / filename
            live_file = ROOT / "assets" / "models" / map_id / "bundles" / filename
            known = live_files.get(filename)
            if not cache.exists() and known and live_file.exists() and hashlib.sha256(live_file.read_bytes()).hexdigest() == known.get("sha256"):
                cache.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(live_file, cache)
            data = fetch(f"{CDN}/{bundle_source['dir']}/{filename}?v={bundle_source['version']}", cache, resource["bytes"])
            destination = TARGET / map_id / "bundles" / filename
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(data)
            descriptor = glb_json(data)
            found = set()
            for mesh in descriptor.get("meshes", []):
                match = re.fullmatch(r"m(\d+)", mesh.get("name", ""))
                if not match or int(match[1]) not in chosen:
                    continue
                mesh_index = int(match[1])
                found.add(mesh_index)
                selected[mesh_index]["bundle"] = index
                for primitive in mesh["primitives"]:
                    material_index = primitive.get("material")
                    if material_index is not None:
                        materials_needed.add(descriptor["materials"][material_index].get("name", ""))
            if found != chosen:
                raise ValueError(f"{filename}: missing {len(chosen - found)} selected meshes")
            levels[str(lod)] = {"file": f"bundles/{filename}", "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
        bundle_manifest.append({**levels["2"], "meshes": sorted(chosen), "lods": levels})
        print(f"{map_id} geometry: {index + 1} bundles with LOD0/1/2", flush=True)
    materials = {name: material_source["materials"].get(name, {}) for name in sorted(materials_needed)}
    texture_names = {description[field] for description in materials.values() for field in ["baseColor", "normal"] if description.get(field)}
    texture_jobs = [(map_id, world, material_source["version"], filename, texture_size) for filename in sorted(texture_names)]
    textures = dict(parallel(texture_jobs, build_texture, workers, f"{map_id} textures"))
    centre = CENTRES[map_id]
    candidates = [tile for tile in tiles if tile["centre"]]
    showcase = max(candidates, key=lambda tile: tile["counts"]["buildings"] / (1 + math.hypot(tile["centre"][0] - centre[0], tile["centre"][1] - centre[1]) / 700) ** 3)["centre"] if candidates else centre
    manifest = {
        "map": map_id, "world": world, "version": "2.0", "sourceVersion": source["version"], "bundleVersion": bundle_source["version"],
        "materialVersion": material_source["version"], "lod": 2, "floatsPerInstance": 11, "tileSizeMetres": source["tileSize"] / 100,
        "originMetres": [source["origin"]["x"] / 100, source["origin"]["y"] / 100], "coverage": "full-map",
        "sourceInstances": total_original, "counts": {kind: sum(tile["counts"][kind] for tile in tiles) for kind in ["buildings", "trees", "props"]},
        "policy": "Original LOD0/1/2 meshes and transforms with interior props and foliage details. Omit collision helpers, decals and sub-0.35m details. Runtime progressive LOD and distance culling.",
        "maximumTextureSize": texture_size, "showcaseMetres": showcase,
        "meshes": selected, "bundles": bundle_manifest, "materials": materials, "textures": textures,
        "tiles": [{key: value for key, value in tile.items() if key != "centre"} for tile in sorted(tiles, key=lambda entry: (entry["z"], entry["x"]))],
        "source": f"https://metaforge.app/wardogs/map/{map_id}/3d",
    }
    destination = TARGET / map_id / "manifest.json"
    destination.write_text(json.dumps(manifest, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"{map_id}: {len(tiles)} tiles, {len(selected)} meshes, {sum(manifest['counts'].values()):,} retained components, {len(textures)} textures", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Build genuine offline WARDOGS model packs from the public, versioned MetaForge resources.")
    parser.add_argument("--maps", nargs="+", choices=list(WORLDS), default=list(WORLDS))
    parser.add_argument("--workers", type=int, default=10)
    parser.add_argument("--texture-size", type=int, default=1024)
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--cache-dir", type=Path)
    arguments = parser.parse_args()
    if arguments.output_dir:
        TARGET = arguments.output_dir.resolve()
    if arguments.cache_dir:
        CACHE = arguments.cache_dir.resolve()
    if not TARGET.resolve().is_relative_to(ROOT) or not CACHE.resolve().is_relative_to(ROOT):
        parser.error("Output and cache directories must remain inside this project")
    if not 1 <= arguments.workers <= 16 or arguments.texture_size not in [256, 512, 1024, 2048]:
        parser.error("workers must be 1..16 and texture-size must be 256, 512, 1024 or 2048")
    for identifier in arguments.maps:
        build(identifier, arguments.workers, arguments.texture_size)
