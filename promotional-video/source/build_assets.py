from pathlib import Path
import json
import wave
import numpy as np
from PIL import Image, ImageDraw, ImageFont
from reportlab.graphics.barcode.qrencoder import QRCode

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / 'assets'
ASSETS.mkdir(exist_ok=True)
SAMPLE_RATE = 48000
DURATION = 60
random = np.random.default_rng(290101314)
audio = np.zeros((SAMPLE_RATE * DURATION, 2), dtype=np.float64)


def add_sound(sound, start, gain=1, pan=0):
    offset = round(start * SAMPLE_RATE)
    if offset < 0 or offset >= len(audio):
        return
    sound = sound[:len(audio) - offset] * gain
    audio[offset:offset + len(sound), 0] += sound * np.sqrt((1 - pan) / 2)
    audio[offset:offset + len(sound), 1] += sound * np.sqrt((1 + pan) / 2)


def frequency(note):
    return 440 * 2 ** ((note - 69) / 12)


def tone(note, duration, kind='pluck'):
    time = np.arange(round(duration * SAMPLE_RATE)) / SAMPLE_RATE
    pitch = frequency(note)
    if kind == 'pad':
        envelope = np.minimum(time / .7, 1) * np.minimum((duration - time) / 1.2, 1)
        signal = np.sin(2 * np.pi * pitch * time + .08 * np.sin(time * 1.8))
        signal += .26 * np.sin(2 * np.pi * pitch * 2.001 * time)
        return signal * envelope
    if kind == 'bass':
        envelope = (1 - np.exp(-time * 150)) * np.exp(-time * 5)
        return (np.sin(2 * np.pi * pitch * time) + .22 * np.sin(2 * np.pi * pitch * 2 * time)) * envelope
    envelope = (1 - np.exp(-time * 180)) * np.exp(-time * 6.5)
    return (np.sin(2 * np.pi * pitch * time) + .3 * np.sin(2 * np.pi * pitch * 2 * time)) * envelope


beat = .6
chords = [[50, 53, 57, 62], [46, 50, 53, 58], [48, 53, 57, 60], [48, 52, 55, 60]]
for block in range(13):
    start = block * 4.8
    chord = chords[block % 4]
    for order, note in enumerate(chord):
        add_sound(tone(note, 6, 'pad'), start, .046, (order - 1.5) * .38)

for step in range(200):
    start = step * beat / 2
    chord = chords[int(start / 4.8) % 4]
    intensity = .65 if start < 6 or start >= 53 else 1
    if step % 2 == 0:
        time = np.arange(round(.42 * SAMPLE_RATE)) / SAMPLE_RATE
        kick = np.sin(2 * np.pi * (47 * time + 3.5 * (1 - np.exp(-time * 28)))) * np.exp(-time * 12)
        add_sound(kick, start, .32 * intensity)
        add_sound(tone(chord[0] - 12, .5, 'bass'), start, .14 * intensity)
    if step % 8 in [2, 6] and 6 <= start < 53:
        time = np.arange(round(.2 * SAMPLE_RATE)) / SAMPLE_RATE
        noise = random.normal(0, 1, len(time))
        snare = (noise * .5 + np.sin(2 * np.pi * 180 * time) * .4) * np.exp(-time * 28)
        add_sound(snare, start, .095, .06)
    if 10 <= start < 53:
        time = np.arange(round(.08 * SAMPLE_RATE)) / SAMPLE_RATE
        noise = random.normal(0, 1, len(time))
        hat = np.diff(noise, prepend=0) * np.exp(-time * 65)
        add_sound(hat, start, .016 if step % 2 else .022, .35 if step % 2 else -.35)
    if step % 2 == 0 or 20 <= start < 39:
        note = chord[[0, 2, 1, 3, 2, 1, 3, 2][step % 8]] + 12
        pluck = tone(note, 1.2)
        add_sound(pluck, start, .067 * intensity, -.2)
        add_sound(pluck, start + .225, .022 * intensity, .55)

for cut in [6, 12, 20, 25, 30, 39, 47, 53]:
    time = np.arange(round(.9 * SAMPLE_RATE)) / SAMPLE_RATE
    noise = random.normal(0, 1, len(time))
    filtered = np.convolve(noise, np.ones(55) / 55, mode='same')
    whoosh = filtered * np.sin(np.pi * time / .9) ** 2
    add_sound(whoosh, cut - .45, .11, -.3)
    impact = tone(38, 1.7, 'bass')
    add_sound(impact, cut, .19)

time = np.arange(len(audio)) / SAMPLE_RATE
fade = np.minimum(time / 1.2, 1) * np.minimum((60 - time) / 2.2, 1)
audio *= fade[:, None]
audio = np.tanh(audio * 1.5)
audio *= .85 / max(.001, np.max(np.abs(audio)))
with wave.open(str(ROOT / 'original-music.wav'), 'wb') as output:
    output.setnchannels(2)
    output.setsampwidth(2)
    output.setframerate(SAMPLE_RATE)
    output.writeframes((audio * 32767).astype('<i2').tobytes())

qr = QRCode(3, 1)
qr.addData('https://qm.qq.com/q/HxtbGL9cke')
qr.make()
modules = qr.getModuleCount()
image = Image.new('RGB', ((modules + 8) * 12, (modules + 8) * 12), '#eef3e5')
draw = ImageDraw.Draw(image)
for row in range(modules):
    for column in range(modules):
        if qr.isDark(row, column):
            draw.rectangle(((column + 4) * 12, (row + 4) * 12, (column + 5) * 12 - 1, (row + 5) * 12 - 1), fill='#132010')
image.save(ASSETS / 'qq-qr.png')

captions = [
    (1.7, 5.9, '找路、踩点、规划，一张地图提前准备。'),
    (6, 11.9, 'Bakurani、Ozeti、Zestafona，重要地点快速定位。'),
    (12, 19.9, '从全局到近景，看清高差、建筑和地形关系。'),
    (20, 24.9, '飞行与步行，两种方式自由探索。'),
    (25, 29.9, '先熟悉环境，再和队友出发。'),
    (30, 38.9, '计算辅助以游戏实测为准，轨迹预览不保证命中。'),
    (39, 46.9, '把关键位置留在地图里，把行动路线讲清楚。'),
    (47, 52.9, '地图在本机，在线人数与加群入口需要联网。'),
    (53, 59.9, 'WARDOGS 战狗 · 非官方本地战术地图'),
]


def timestamp(seconds):
    milliseconds = round(seconds * 1000)
    return f'{milliseconds // 3600000:02}:{milliseconds // 60000 % 60:02}:{milliseconds // 1000 % 60:02},{milliseconds % 1000:03}'

(ROOT / 'captions.srt').write_text('\n\n'.join(f'{order + 1}\n{timestamp(start)} --> {timestamp(end)}\n{caption}' for order, (start, end, caption) in enumerate(captions)) + '\n', encoding='utf-8-sig')
(ROOT / 'source' / 'cue-sheet.json').write_text(json.dumps(captions, ensure_ascii=False, indent=2), encoding='utf-8')
print('Created original stereo music, official invitation QR and timed captions.')
