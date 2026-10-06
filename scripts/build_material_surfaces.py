import math
from pathlib import Path

from PIL import Image, ImageChops, ImageFilter

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'assets' / 'material-surfaces'
LAYERS = ['Grass', 'Soil', 'Rock', 'Stones', 'Forest', 'Sand', 'Snow', 'Fields']


def grain(column, row):
    return ((column * 374761393 + row * 668265263) ^ (column * row * 1274126177)) % 101 / 100


def surface_image(kind):
    size = 128
    colors = {'concrete': (150, 147, 141), 'paint': (211, 208, 197), 'wood': (111, 88, 65), 'tiles': (175, 180, 170), 'wire': (145, 151, 152), 'net': (213, 208, 187), 'grate': (91, 98, 96), 'camo': (88, 103, 65), 'soil': (92, 92, 68), 'paper': (181, 178, 160), 'plaster': (171, 164, 145), 'label': (166, 165, 149), 'fabric': (96, 74, 61), 'brick': (145, 142, 132), 'wallpaper': (174, 170, 151), 'bark': (111, 104, 86), 'leaves': (110, 108, 57)}
    image = Image.new('RGBA', (size, size))
    pixels = image.load()
    for row in range(size):
        for column in range(size):
            shade = .91 + .18 * grain(column, row)
            alpha = 255
            if kind in ['tiles', 'brick']:
                offset = 32 if kind == 'brick' and row // 32 % 2 else 0
                if row % 32 < 2 or (column + offset) % 64 < 2:
                    shade *= .63
            if kind in ['wood', 'bark']:
                shade *= .88 + .12 * math.sin(column * .8 + math.sin(row * .04))
            if kind in ['fabric', 'wallpaper']:
                shade *= .88 + .12 * ((column + row) % 4 / 3)
            if kind in ['wire', 'net', 'grate', 'camo']:
                width = 2 if kind in ['wire', 'net'] else 5 if kind == 'grate' else 9
                first = (column + row) % 32 if kind in ['wire', 'camo'] else column % 32
                second = (column - row) % 32 if kind in ['wire', 'camo'] else row % 32
                alpha = 255 if min(first, second) < width else 0
            if kind == 'leaves':
                horizontal = (column % 32 - 16) / 11
                vertical = (row % 32 - 16) / 6
                alpha = 255 if horizontal * horizontal + vertical * vertical < 1 else 0
            pixels[column, row] = (*[round(min(255, component * shade)) for component in colors[kind]], alpha)
    return image


def ground_atlas():
    size = 256
    atlas = Image.new('RGBA', (size, size * len(LAYERS)))
    roughness = [.96, .94, .85, .89, .98, .92, .75, .95]
    for layer_index, layer in enumerate(LAYERS):
        color = Image.open(ROOT / 'assets' / 'landscape' / 'bakurani' / (layer + '.webp')).convert('L').resize((size, size)).filter(ImageFilter.GaussianBlur(.6))
        samples = color.load()
        image = Image.new('RGBA', (size, size))
        pixels = image.load()
        for row in range(size):
            for column in range(size):
                horizontal = (samples[(column + 1) % size, row] - samples[(column - 1) % size, row]) / 255 * .55
                vertical = (samples[column, (row - 1) % size] - samples[column, (row + 1) % size]) / 255 * .55
                length = math.sqrt(horizontal * horizontal + vertical * vertical + 1)
                pixels[column, row] = (round(127.5 - horizontal / length * 127.5), round(127.5 - vertical / length * 127.5), round(127.5 + 127.5 / length), round(255 * roughness[layer_index]))
        atlas.paste(image, (0, layer_index * size))
    atlas.save(OUTPUT / 'ground-surface.webp', lossless=True)


def decal_alpha():
    source = Image.open(ROOT / 'assets' / 'models' / 'zestafona' / 'textures' / '1109b479bf047d8e.webp').convert('RGB')
    background = Image.new('RGB', source.size, (187, 187, 187))
    difference = ImageChops.difference(source, background)
    channels = difference.split()
    distance = ImageChops.lighter(ImageChops.lighter(channels[0], channels[1]), channels[2])
    alpha = distance.point(lambda value: min(255, max(0, (value - 5) * 18)))
    source.putalpha(alpha)
    source.save(OUTPUT / 'dumpster-decals.webp', lossless=True)


if __name__ == '__main__':
    OUTPUT.mkdir(parents=True, exist_ok=True)
    for kind in ['concrete', 'paint', 'wood', 'tiles', 'wire', 'net', 'grate', 'camo', 'soil', 'paper', 'plaster', 'label', 'fabric', 'brick', 'wallpaper', 'bark', 'leaves']:
        surface_image(kind).save(OUTPUT / (kind + '.webp'), lossless=True)
    ground_atlas()
    decal_alpha()
    print('Built 19 deterministic local replacement and ground surface textures.')
