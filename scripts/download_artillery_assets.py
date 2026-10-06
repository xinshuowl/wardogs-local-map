import hashlib
import json
from pathlib import Path
from urllib.request import Request, urlopen

root = Path(__file__).resolve().parent.parent
asset_root = root / "assets" / "artillery"
manifest_path = asset_root / "manifest.json"
manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
filenames = sorted({part["url"] for parts in manifest["weapons"].values() for part in parts})
resources = {}
for filename in filenames:
    if Path(filename).name != filename or not filename.endswith(".glb"):
        raise ValueError("Invalid model filename")
    destination = asset_root / filename
    if destination.is_file():
        data = destination.read_bytes()
    else:
        request = Request(manifest["cdn"] + "/" + filename, headers={"User-Agent": "WARDOGS-Local-Map/2.0"})
        with urlopen(request, timeout=60) as response:
            data = response.read(20 * 1024 * 1024 + 1)
        if len(data) > 20 * 1024 * 1024 or data[:4] != b"glTF" or int.from_bytes(data[8:12], "little") != len(data):
            raise ValueError("Invalid GLB: " + filename)
        destination.write_bytes(data)
    resources[filename] = {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
    print(filename, len(data), flush=True)
print(json.dumps({"files": len(resources), "bytes": sum(record["bytes"] for record in resources.values()), "resources": resources}, ensure_ascii=False))

