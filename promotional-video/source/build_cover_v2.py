from pathlib import Path
import argparse
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter, ImageEnhance, ImageOps

ROOT = Path(__file__).resolve().parents[1]
argument_parser = argparse.ArgumentParser()
argument_parser.add_argument('--aspect', choices=['16:9', '4:3'], default='16:9')
arguments = argument_parser.parse_args()
four_by_three = arguments.aspect == '4:3'
WIDTH, HEIGHT = (1600, 1200) if four_by_three else (1920, 1080)
SCALE = 2
SIZE = (WIDTH * SCALE, HEIGHT * SCALE)
BOLD = 'C:/Windows/Fonts/msyhbd.ttc'
REGULAR = 'C:/Windows/Fonts/msyh.ttc'
LATIN = 'C:/Windows/Fonts/ariblk.ttf'
LIME = '#deff62'
WHITE = '#f8f9f0'

source = Image.open(ROOT / 'review/frame-0480.jpg').convert('RGB')
source = source.crop((605, 190, 1920, 744))
background = ImageOps.fit(source, SIZE, Image.Resampling.LANCZOS, centering=(.65, .55))
background = ImageEnhance.Brightness(background).enhance(1.34)
background = ImageEnhance.Color(background).enhance(.88)
image = background.convert('RGBA')

horizontal = np.linspace(0, 1, SIZE[0])[None, :]
vertical = np.linspace(0, 1, SIZE[1])[:, None]
opacity = np.interp(horizontal, [0, .29, .47, .64, 1], [247, 231, 188, 76, 18])
opacity = np.clip(opacity + 46 * np.maximum(0, (vertical - .7) / .3), 0, 250)
overlay = np.zeros((SIZE[1], SIZE[0], 4), dtype=np.uint8)
overlay[:, :, :3] = [9, 18, 19]
overlay[:, :, 3] = opacity
image = Image.alpha_composite(image, Image.fromarray(overlay))


def font(size, filename=BOLD):
    return ImageFont.truetype(filename, round(size * SCALE))


def label(value, position, size, fill=WHITE, filename=BOLD, stroke=0, shadow=False):
    text_layer = Image.new('RGBA', SIZE)
    pen = ImageDraw.Draw(text_layer)
    location = tuple(round(coordinate * SCALE) for coordinate in position)
    if shadow:
        shadow_layer = Image.new('RGBA', SIZE)
        shadow_pen = ImageDraw.Draw(shadow_layer)
        shadow_pen.text((location[0] + 4 * SCALE, location[1] + 10 * SCALE), value, font=font(size, filename), fill=(0, 0, 0, 210), anchor='lt', stroke_width=round((stroke + 3) * SCALE))
        image.alpha_composite(shadow_layer.filter(ImageFilter.GaussianBlur(6 * SCALE)))
    pen.text(location, value, font=font(size, filename), fill=fill, anchor='lt', stroke_width=round(stroke * SCALE), stroke_fill='#0a1516')
    image.alpha_composite(text_layer)


def rectangle(bounds, fill, radius=0, outline=None, width=1):
    draw = ImageDraw.Draw(image)
    pixels = tuple(round(value * SCALE) for value in bounds)
    draw.rounded_rectangle(pixels, radius=round(radius * SCALE), fill=fill, outline=outline, width=round(width * SCALE))


draw = ImageDraw.Draw(image)
divider = [(920, 87), (830, 1095)] if four_by_three else [(1120, 87), (1019, 965)]
draw.line([(horizontal * SCALE, vertical * SCALE) for horizontal, vertical in divider], fill=(222, 255, 98, 60), width=2 * SCALE)
rectangle((70, 85, 79, 131) if four_by_three else (82, 85, 91, 131), LIME)
label('WARDOGS', (102, 85) if four_by_three else (113, 85), 47, filename=LATIN)
label('战狗', (66, 226) if four_by_three else (78, 196), 200 if four_by_three else 207, stroke=3, shadow=True)
label('3D 地图', (63, 468) if four_by_three else (75, 435), 183 if four_by_three else 203, fill=LIME, stroke=4, shadow=True)

rectangle((74, 734, 748, 842) if four_by_three else (87, 708, 768, 816), '#ffa95a', radius=12)
label('+ 炮兵计算', (106, 756) if four_by_three else (119, 730), 70, fill='#112023')
label('三张地图  ·  飞行 / 步行', (77, 885) if four_by_three else (91, 860), 38 if four_by_three else 42, fill='#e2e9dd')

rectangle((1177, 78, 1524, 145) if four_by_three else (1480, 78, 1827, 145), '#10201ddc', radius=8, outline='#d7f88c', width=2)
label('真实场景展示', (1207, 95) if four_by_three else (1510, 95), 34, fill=LIME)

target = Image.new('RGBA', SIZE)
pen = ImageDraw.Draw(target)
target_x, target_y = (1225 * SCALE, 358 * SCALE) if four_by_three else (1420 * SCALE, 345 * SCALE)
radius = 85 * SCALE
pen.arc((target_x - radius, target_y - radius, target_x + radius, target_y + radius), 18, 162, fill=(231, 255, 155, 210), width=3 * SCALE)
pen.arc((target_x - radius, target_y - radius, target_x + radius, target_y + radius), 198, 342, fill=(231, 255, 155, 210), width=3 * SCALE)
for offset_x, offset_y in [(-1, 0), (1, 0), (0, -1), (0, 1)]:
    pen.line((target_x + offset_x * 105 * SCALE, target_y + offset_y * 105 * SCALE, target_x + offset_x * 61 * SCALE, target_y + offset_y * 61 * SCALE), fill=LIME, width=4 * SCALE)
pen.ellipse((target_x - 5 * SCALE, target_y - 5 * SCALE, target_x + 5 * SCALE, target_y + 5 * SCALE), fill=LIME)
image.alpha_composite(target)

screen = Image.open(ROOT / 'assets/interface-artillery-3d.png').convert('RGB').crop((1519, 638, 1884, 953))
screen = ImageEnhance.Brightness(screen).enhance(1.6)
card_width, card_height = 565, 496
card = Image.new('RGBA', ((card_width + 48) * SCALE, (card_height + 48) * SCALE))
card_shadow = Image.new('RGBA', card.size)
pen = ImageDraw.Draw(card_shadow)
pen.rounded_rectangle((22 * SCALE, 26 * SCALE, (card_width + 26) * SCALE, (card_height + 30) * SCALE), radius=15 * SCALE, fill=(0, 0, 0, 190))
card.alpha_composite(card_shadow.filter(ImageFilter.GaussianBlur(12 * SCALE)))
pen = ImageDraw.Draw(card)
pen.rounded_rectangle((15 * SCALE, 12 * SCALE, (card_width + 15) * SCALE, (card_height + 12) * SCALE), radius=12 * SCALE, fill='#07130f', outline='#d4ed87', width=3 * SCALE)
pen.line((16 * SCALE, 80 * SCALE, (card_width + 14) * SCALE, 80 * SCALE), fill='#516740', width=2 * SCALE)
pen.text((40 * SCALE, 31 * SCALE), '炮兵瞄具', font=font(32), fill=LIME, anchor='lt')
pen.text((352 * SCALE, 37 * SCALE), 'GUNNER SIGHT', font=font(19, LATIN), fill='#bdd29f', anchor='lt')
screen = ImageOps.contain(screen, (519 * SCALE, 381 * SCALE), Image.Resampling.LANCZOS)
card.paste(screen, (38 * SCALE + (519 * SCALE - screen.width) // 2, 94 * SCALE + (381 * SCALE - screen.height) // 2))
card = card.rotate(4, resample=Image.Resampling.BICUBIC, expand=True)
image.alpha_composite(card, (920 * SCALE, 573 * SCALE) if four_by_three else (1237 * SCALE, 482 * SCALE))

rectangle((74, 1022, 382, 1070) if four_by_three else (83, 960, 391, 1008), '#e7eddb')
label('非官方本地工具', (94, 1032) if four_by_three else (103, 970), 29, fill='#17231a')
label('先看地图，再进战场', (78, 1110) if four_by_three else (425, 971), 29, fill='#c7d6be', filename=REGULAR)

image = image.resize((WIDTH, HEIGHT), Image.Resampling.LANCZOS).convert('RGB')
output_name = 'cover-4x3' if four_by_three else 'cover-v2'
image.save(ROOT / (output_name + '.jpg'), quality=95, subsampling=0, dpi=(96, 96))
image.save(ROOT / (output_name + '.png'), optimize=True)
thumbnail = image.resize((480, 360) if four_by_three else (480, 270), Image.Resampling.LANCZOS)
thumbnail.save(ROOT / 'review' / (output_name + '-thumbnail.jpg'), quality=93)
print(f'Created {output_name}.jpg and {output_name}.png at {WIDTH}x{HEIGHT}.')
