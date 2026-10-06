import hashlib
import json
from pathlib import Path

from PIL import Image, ImageStat

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'assets' / 'material-surfaces'
REPAIRS = {
    '833873520a0b6149.webp': ('steel-floor.webp', (150, 154, 153)),
    'ec54d508479b3b1a.webp': ('interior-wood.webp', (144, 119, 90)),
    'f6cefd2b258cf789.webp': ('interior-painted-wood.webp', (189, 184, 172)),
    '0b28d5b1c7645328.webp': ('industrial-girders.webp', (166, 169, 167)),
}


def repair_image(image, base):
    image = image.convert('RGB')
    repaired = Image.new('RGB', image.size)
    pixels = []
    for original in image.getdata():
        light = max(original)
        transition = min(1, max(0, (light - 20) / 44))
        weight = 1 - transition * transition * (3 - 2 * transition)
        pixels.append(tuple(round(component * (1 - weight) + fallback * weight) for component, fallback in zip(original, base)))
    repaired.putdata(pixels)
    return repaired


def build():
    OUTPUT.mkdir(parents=True, exist_ok=True)
    report = {}
    for filename, (destination, base) in REPAIRS.items():
        path = ROOT / 'assets' / 'models' / 'bakurani' / 'textures' / filename
        source = Image.open(path).convert('RGB')
        repaired = repair_image(source, base)
        repaired.save(OUTPUT / destination, lossless=True)
        report[filename] = {'replacement': destination, 'sourceSha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'baseSRGB': base, 'sourceMean': ImageStat.Stat(source).mean, 'repairedMean': ImageStat.Stat(repaired).mean, 'method': 'Approximate missing dark base regions; retain bright atlas details and original normal/UV.'}
    (OUTPUT / 'dark-surface-repairs.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf8')
    print('Reconstructed four known dark source surfaces; original files unchanged.')


if __name__ == '__main__':
    build()
