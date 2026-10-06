from pathlib import Path
import json
import re
import subprocess
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
REVIEW = ROOT / 'review'
normalization = subprocess.run(['ffmpeg', '-hide_banner', '-i', str(ROOT / 'original-music.wav'), '-af', 'loudnorm=I=-16:TP=-1.5:LRA=9:print_format=json', '-f', 'null', '-'], capture_output=True, text=True, check=True)
measurement = json.loads(re.findall(r'\{\s*"input_i"[\s\S]*?\}', normalization.stderr)[-1])
filter_text = 'loudnorm=I=-16:TP=-1.5:LRA=9:linear=true:' + ':'.join(f'{target}={measurement[source]}' for target, source in [('measured_I', 'input_i'), ('measured_TP', 'input_tp'), ('measured_LRA', 'input_lra'), ('measured_thresh', 'input_thresh'), ('offset', 'target_offset')])
subprocess.run(['ffmpeg', '-hide_banner', '-y', '-i', str(ROOT / 'video-only.mp4'), '-i', str(ROOT / 'original-music.wav'), '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-af', filter_text, '-c:a', 'aac', '-b:a', '256k', '-ar', '48000', '-t', '60', '-movflags', '+faststart', '-metadata', 'title=WARDOGS 战狗 · 本地战术地图', '-metadata', 'comment=Unofficial fan-made local map tool. Map assets/reference: MetaForge / WARDOGS. Original procedural score.', str(ROOT / 'wardogs-promo-1080p.mp4')], check=True)

regular = 'C:/Windows/Fonts/msyh.ttc'
bold = 'C:/Windows/Fonts/msyhbd.ttc'
latin = 'C:/Windows/Fonts/bahnschrift.ttf'
source = Image.open(REVIEW / 'cover-background.jpg').convert('RGB')
image = source.convert('RGBA')
gradient = Image.new('RGBA', image.size)
draw = ImageDraw.Draw(gradient)
for horizontal in range(1920):
    opacity = round(230 * (1 - horizontal / 2400))
    draw.line((horizontal, 0, horizontal, 1080), fill=(7, 14, 10, opacity))
image = Image.alpha_composite(image, gradient)
draw = ImageDraw.Draw(image)
draw.rounded_rectangle((82, 76, 480, 132), radius=7, fill='#d5ed79')
draw.text((104, 83), 'WARDOGS  /  战狗', font=ImageFont.truetype(bold, 29), fill='#162012')
draw.text((81, 206), '出发前', font=ImageFont.truetype(bold, 116), fill='#f4f5eb')
draw.text((73, 350), '先看清战场', font=ImageFont.truetype(bold, 162), fill='#d5ed79', stroke_width=1)
draw.text((87, 583), '3D 地图  ×  炮兵计算', font=ImageFont.truetype(bold, 67), fill='#f4f5eb')
draw.text((91, 709), '三张战场 · 飞行 / 步行 · 路线规划', font=ImageFont.truetype(regular, 40), fill='#d1d9c5')
draw.line((88, 881, 1824, 881), fill='#a2b371', width=2)
draw.text((90, 929), '非官方本地战术地图', font=ImageFont.truetype(regular, 32), fill='#d8dfcc')
draw.text((1275, 920), 'QQ群 290101314', font=ImageFont.truetype(bold, 41), fill='#d5ed79')
image.convert('RGB').save(ROOT / 'cover.jpg', quality=96)

frames = sorted(REVIEW.glob('frame-*.jpg'))
contact = Image.new('RGB', (1440, 3 * 304), '#10160d')
draw = ImageDraw.Draw(contact)
for order, filename in enumerate(frames):
    thumbnail = Image.open(filename).resize((480, 270), Image.Resampling.LANCZOS)
    horizontal = order % 3 * 480
    vertical = order // 3 * 304
    contact.paste(thumbnail, (horizontal, vertical))
    seconds = int(filename.stem.split('-')[-1]) / 30
    draw.text((horizontal + 12, vertical + 274), f'{seconds:.1f}s', font=ImageFont.truetype(latin, 19), fill='#d5ed79')
contact.save(REVIEW / 'contact-sheet.jpg', quality=93)
metadata = subprocess.run(['ffprobe', '-v', 'error', '-show_streams', '-show_format', '-of', 'json', str(ROOT / 'wardogs-promo-1080p.mp4')], capture_output=True, text=True, encoding='utf-8', check=True)
(REVIEW / 'media-info.json').write_text(metadata.stdout, encoding='utf-8')
print('Final MP4, cover, contact sheet and metadata ready.')
