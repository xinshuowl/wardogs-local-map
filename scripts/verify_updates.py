import contextlib
import hashlib
import io
import json
import pathlib
import shutil
import tempfile
import unittest
from unittest.mock import patch

import download_scene_detail as scene
import update_assets as updates

PROJECT = pathlib.Path(__file__).resolve().parents[1]


class SceneUpdateTests(unittest.TestCase):
    def setUp(self):
        validation = PROJECT / ".validation"
        validation.mkdir(exist_ok=True)
        self.root = pathlib.Path(tempfile.mkdtemp(prefix="scene-update-test-", dir=validation)).resolve()
        if not self.root.is_relative_to(validation.resolve()):
            raise RuntimeError("Unsafe test workspace")
        self.patches = [patch.object(scene, "ROOT", self.root), patch.object(updates, "ROOT", self.root)]
        for active in self.patches:
            active.start()
        self.native = {}
        self.sources = {}
        self.landscapes = {}
        self.previous = {}
        self.tile = bytes(range(50))
        self.image = b"RIFF\x04\x00\x00\x00WEBPfixture"
        for map_id, world in scene.MAPS.items():
            native = {"cols": 2, "rows": 2, "origin": [0, 0], "step": [800, 800], "sampleMetres": 8, "world": world, "heightOffset": 0, "heightScale": 1, "file": f"assets/terrain/{map_id}.bin"}
            detail = {"version": "11111111", "ratio": 4, "cols": 5, "rows": 5, "samples": 8, "tilesX": 1, "tilesY": 1, "count": 1} if map_id == "bakurani" else None
            landscape = {"world": world, "version": "22222222", "layers": ["Grass"], "channelsPerMask": 3, "files": ["mask0.webp"], "dir": f"landscape-masks/{world}/22222222"}
            self.native[map_id] = native
            self.sources[map_id] = {"terrain": {"world": world, "detail": detail}, "sky": {"world": world, "fixture": True}}
            self.landscapes[map_id] = landscape
            files = {}
            payloads = {f"assets/landscape/{map_id}/mask0.webp": self.image, f"assets/landscape/{map_id}/Grass.webp": self.image}
            if detail:
                payloads[f"assets/terrain/detail/{map_id}/0_0.bin"] = self.tile
            for filename, data in payloads.items():
                path = self.root / filename
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(data)
                files[filename] = {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
            self.previous[map_id] = {"detail": scene.detail_descriptor(detail, native, map_id), "landscape": {**landscape, "directory": f"assets/landscape/{map_id}"}, "sky": self.sources[map_id]["sky"], "files": files}
        self.write_inputs(self.root / "assets")
        (self.root / "assets/scene-manifest.json").write_text(json.dumps(self.previous), encoding="utf-8")

    def tearDown(self):
        for active in reversed(self.patches):
            active.stop()
        if not self.root.is_relative_to((PROJECT / ".validation").resolve()) or not self.root.name.startswith("scene-update-test-"):
            raise RuntimeError("Unsafe test cleanup")
        shutil.rmtree(self.root)

    def write_inputs(self, assets):
        (assets / "terrain").mkdir(parents=True, exist_ok=True)
        (assets / "terrain/manifest.json").write_text(json.dumps(self.native), encoding="utf-8")
        for map_id, source in self.sources.items():
            (assets / f"{map_id}-source.json").write_text(json.dumps(source), encoding="utf-8")

    def test_verified_cache_stages_all_scene_assets_without_network(self):
        assets = self.root / "stage/assets"
        self.write_inputs(assets)
        with patch.object(scene.urllib.request, "urlopen", side_effect=AssertionError("Unexpected network access")), contextlib.redirect_stdout(io.StringIO()):
            result = scene.build_scene(assets, self.landscapes)
        self.assertEqual(result, self.previous)
        self.assertEqual(result["bakurani"]["detail"]["sampleMetres"], 2)
        self.assertEqual((assets / "terrain/detail/bakurani/0_0.bin").read_bytes(), self.tile)
        self.assertEqual(result["ozeti"]["detail"], None)
        self.assertEqual(json.loads((assets / "scene-manifest.json").read_text(encoding="utf-8")), result)

    def test_new_versions_do_not_reuse_same_named_assets(self):
        self.sources["bakurani"]["terrain"]["detail"]["version"] = "33333333"
        landscape = self.landscapes["bakurani"]
        landscape["version"] = "44444444"
        landscape["dir"] = "landscape-masks/kavkazi/44444444"
        assets = self.root / "stage/assets"
        self.write_inputs(assets)
        replacement = bytes(reversed(self.tile))
        def response(request, **options):
            return io.BytesIO(replacement if request.full_url.endswith(".bin") else self.image)
        with patch.object(scene.urllib.request, "urlopen", side_effect=response) as requests, contextlib.redirect_stdout(io.StringIO()):
            result = scene.build_scene(assets, self.landscapes)
        self.assertEqual(requests.call_count, 3)
        self.assertEqual((assets / "terrain/detail/bakurani/0_0.bin").read_bytes(), replacement)
        self.assertEqual((self.root / "assets/terrain/detail/bakurani/0_0.bin").read_bytes(), self.tile)
        self.assertEqual(result["bakurani"]["detail"]["version"], "33333333")

    def test_corrupt_cache_is_repaired(self):
        broken = self.root / "assets/terrain/detail/bakurani/0_0.bin"
        broken.write_bytes(b"x" * len(self.tile))
        assets = self.root / "stage/assets"
        self.write_inputs(assets)
        with patch.object(scene.urllib.request, "urlopen", return_value=io.BytesIO(self.tile)) as requests, contextlib.redirect_stdout(io.StringIO()):
            scene.build_scene(assets, self.landscapes)
        self.assertEqual(requests.call_count, 1)
        self.assertEqual((assets / "terrain/detail/bakurani/0_0.bin").read_bytes(), self.tile)

    def test_untrusted_directories_and_dimensions_are_rejected(self):
        with self.assertRaises(ValueError):
            scene.validate_landscape({**self.landscapes["ozeti"], "dir": "../../escape"}, "europe")
        with self.assertRaises(ValueError):
            scene.detail_descriptor({**self.sources["bakurani"]["terrain"]["detail"], "count": 99}, self.native["bakurani"], "bakurani")
        with self.assertRaises(ValueError):
            scene.confined(self.root.parent / "outside")
        with self.assertRaises(ValueError):
            updates.confined(self.root.parent / "outside")

    def test_commit_failure_restores_files_and_directories(self):
        stage = self.root / "stage"
        stage.mkdir()
        previous = self.root / "assets"
        targets = [previous / "scene-manifest.json", previous / "landscape", previous / "terrain/detail"]
        sources = [stage / "scene-manifest.json", stage / "landscape", stage / "detail"]
        sources[0].write_text("new-scene", encoding="utf-8")
        for directory in sources[1:]:
            directory.mkdir()
            (directory / "new.bin").write_bytes(b"new")
        old_manifest = targets[0].read_bytes()
        original_replace = updates.os.replace
        def replace(source, target):
            if source == sources[2]:
                raise OSError("Simulated final scene replacement failure")
            return original_replace(source, target)
        with patch.object(updates.os, "replace", side_effect=replace), self.assertRaises(OSError):
            updates.commit(list(zip(sources, targets)), self.root / "backup")
        self.assertEqual(targets[0].read_bytes(), old_manifest)
        self.assertEqual((targets[1] / "bakurani/mask0.webp").read_bytes(), self.image)
        self.assertEqual((targets[2] / "bakurani/0_0.bin").read_bytes(), self.tile)
        self.assertEqual(sources[0].read_text(encoding="utf-8"), "new-scene")


if __name__ == "__main__":
    unittest.main(verbosity=2)
