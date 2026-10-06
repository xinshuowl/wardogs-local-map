import { TerrainView } from '/terrain-view.js';

const canvas = document.querySelector('#film');
const context = canvas.getContext('2d', { alpha: false });
const status = document.querySelector('#status');
const detail = document.querySelector('#detail');
const accent = '#d5ed79';
const white = '#f2f3e9';
const muted = '#c0c7b6';
const shots = [0, 6, 12, 20, 25, 30, 39, 47, 53, 60];
const names = ['出发之前', '三张战场', '3D 立体侦察', '飞行', '步行', '炮兵计算', '路线规划', '本地工具', '加入我们'];
let view;
let center;
let modelStatus;
let lastPrepared = -1;
const images = {};
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const ease = value => { const bounded = Math.max(0, Math.min(1, value)); return bounded * bounded * (3 - 2 * bounded); };
const mix = (start, end, amount) => start + (end - start) * amount;
const shotAt = time => Math.min(8, shots.findIndex((start, index) => time >= start && time < shots[index + 1]));

function text(value, horizontal, vertical, size = 28, color = white, weight = 400, family = 'Microsoft YaHei', align = 'left') {
  context.fillStyle = color;
  context.font = `${weight} ${size}px "${family}", sans-serif`;
  context.textAlign = align;
  context.textBaseline = 'alphabetic';
  context.fillText(value, horizontal, vertical);
}

function box(horizontal, vertical, width, height, fill, radius = 0) {
  context.fillStyle = fill;
  context.beginPath();
  context.roundRect(horizontal, vertical, width, height, radius);
  context.fill();
}

function line(points, color = accent, width = 2) {
  context.strokeStyle = color;
  context.lineWidth = width;
  context.beginPath();
  points.forEach((point, index) => index ? context.lineTo(...point) : context.moveTo(...point));
  context.stroke();
}

function cover(image, horizontal, vertical, width, height, scale = 1, offsetX = .5, offsetY = .5) {
  const factor = Math.max(width / image.width, height / image.height) * scale;
  context.save();
  context.beginPath(); context.rect(horizontal, vertical, width, height); context.clip();
  context.drawImage(image, horizontal - (image.width * factor - width) * offsetX, vertical - (image.height * factor - height) * offsetY, image.width * factor, image.height * factor);
  context.restore();
}

function shade(strength = .8, direction = 'left') {
  const gradient = context.createLinearGradient(0, direction === 'bottom' ? 1080 : 0, direction === 'bottom' ? 0 : 1920, direction === 'bottom' ? 120 : 0);
  gradient.addColorStop(0, `rgba(8,14,10,${strength})`);
  gradient.addColorStop(.55, `rgba(8,14,10,${strength * .38})`);
  gradient.addColorStop(1, 'rgba(8,14,10,0.04)');
  box(0, 0, 1920, 1080, gradient);
}

function furniture(index, time) {
  box(0, 0, 1920, 76, '#10170deb');
  text('WARDOGS', 70, 49, 28, white, 700, 'Bahnschrift');
  text('战狗 · 本地战术地图', 247, 47, 20, muted);
  text('FIELD NOTES  /  ' + String(index + 1).padStart(2, '0'), 1848, 47, 19, accent, 600, 'Bahnschrift', 'right');
  box(70, 1019, 1780, 2, '#ffffff22');
  box(70, 1019, 1780 * time / 60, 2, accent);
  text('非官方地图工具  /  地图数据与参考：MetaForge · WARDOGS', 70, 1055, 17, '#bbc4ad');
  text('TACTICAL ATLAS', 1850, 1055, 17, '#bbc4ad', 400, 'Bahnschrift', 'right');
}

function label(value, horizontal = 90, vertical = 180) {
  box(horizontal, vertical - 24, 5, 23, accent);
  text(value, horizontal + 20, vertical - 3, 21, accent, 600, 'Bahnschrift');
}

function subtitle(value, time, start) {
  const opacity = ease((time - start) / .45);
  context.save(); context.globalAlpha = opacity;
  context.font = '400 30px "Microsoft YaHei",sans-serif';
  const width = context.measureText(value).width + 56;
  box((1920 - width) / 2, 930, width, 62, '#07100dde', 7);
  text(value, 960, 972, 30, white, 400, 'Microsoft YaHei', 'center');
  context.restore();
}

function reticle(horizontal, vertical, size = 24) {
  line([[horizontal - size, vertical], [horizontal - 9, vertical]]);
  line([[horizontal + 9, vertical], [horizontal + size, vertical]]);
  line([[horizontal, vertical - size], [horizontal, vertical - 9]]);
  line([[horizontal, vertical + 9], [horizontal, vertical + size]]);
}

function cameraFor(index, fraction) {
  const smooth = ease(fraction);
  const base = view.surfacePoint(center);
  view.artilleryCameraMode = index === 3 ? 'fly' : index === 4 ? 'walk' : 'orbit';
  view.camera.fov = index === 4 ? 66 : 48;
  view.camera.near = .015;
  view.camera.updateProjectionMatrix();
  if (index === 4) {
    const position = [center[0] - 7 + smooth * 1.5, center[1] + 7 - smooth * 1.2];
    const ground = view.surfacePoint(position);
    view.camera.position.copy(ground); view.camera.position.y += 1.7 * view.metresToWorld;
    view.controls.target.set(base.x + 4, view.camera.position.y + .08, base.z - 2);
  } else if (index === 3) {
    view.camera.position.set(base.x - 28 + smooth * 18, base.y + 13 - smooth * 4, base.z + 35 - smooth * 18);
    view.controls.target.set(base.x + 4, base.y + 1, base.z - 2);
  } else {
    const angle = (index === 0 ? -.72 : -.2) + smooth * .36;
    const radius = index === 0 ? mix(118, 95, smooth) : mix(43, 33, smooth);
    view.camera.position.set(base.x + Math.sin(angle) * radius, base.y + radius * .58, base.z + Math.cos(angle) * radius);
    view.controls.target.set(base.x, base.y + 1, base.z);
  }
  view.camera.lookAt(view.controls.target);
  view.camera.updateMatrixWorld();
}

function tickScene() {
  view.environment.update();
  view.detail.update(false, performance.now() + 6);
  view.props.update(performance.now() + 7);
  view.performance.updateShadows(performance.now());
  view.renderer.render(view.scene, view.camera);
}

async function prepare(index) {
  if (lastPrepared === index || ![0, 2, 3, 4].includes(index)) return;
  status.textContent = '准备镜头：' + names[index];
  for (const fraction of [0, .5, 1, 0]) {
    cameraFor(index, fraction);
    view.props.wake();
    const started = performance.now();
    let readyFrames = 0;
    while (performance.now() - started < 45000) {
      tickScene();
      detail.textContent = JSON.stringify({ shot: names[index], models: modelStatus?.instances, pending: modelStatus?.pending, state: modelStatus?.state });
      const ready = modelStatus?.state === 'ready' && !view.props.work && !view.props.textureUploads.length && !view.props.shaderWarmup.pending && performance.now() - started > 900;
      readyFrames = ready ? readyFrames + 1 : 0;
      if (readyFrames > 8) break;
      await pause(20);
    }
  }
  lastPrepared = index;
}

function shotImage(image, fraction, horizontal = 650, vertical = 190, width = 1210, height = 680) {
  context.save();
  context.shadowColor = '#000000'; context.shadowBlur = 55; context.shadowOffsetY = 18;
  box(horizontal - 2, vertical - 2, width + 4, height + 4, '#6d7d51', 9);
  context.shadowBlur = 0; context.shadowOffsetY = 0;
  cover(image, horizontal, vertical, width, height, 1 + fraction * .015);
  context.restore();
}

function renderFrame(time) {
  const index = shotAt(time);
  const local = time - shots[index];
  const fraction = local / (shots[index + 1] - shots[index]);
  box(0, 0, 1920, 1080, '#11170f');
  if ([0, 2, 3, 4].includes(index)) {
    cameraFor(index, fraction); tickScene();
    context.drawImage(view.renderer.domElement, 0, 0, 1920, 1080);
  }
  if (index === 0) {
    shade(.86);
    label('PLAN BEFORE YOU DROP', 90, 260);
    text('出发之前', 88, 408, 100, white, 700);
    context.save(); context.globalAlpha = ease((local - .65) / .6);
    text('先看清战场。', 85, 551, 128, accent, 700);
    context.restore();
    text('WARDOGS 战狗  /  本地战术地图', 93, 638, 34, white);
    text('2D 地图   ·   3D 场景   ·   炮兵计算', 94, 697, 26, muted);
    subtitle('找路、踩点、规划，一张地图提前准备。', time, 1.7);
  } else if (index === 1) {
    label('01 / THREE BATTLEGROUNDS', 82, 155);
    text('三张地图，一个作战工作区。', 82, 245, 64, white, 700);
    const mapNames = [['bakurani','BAKURANI','河谷 · 林地 · 城镇'],['ozeti','OZETI','海岸 · 山脊 · 聚落'],['zestafona','ZESTAFONA','铁路 · 工业 · 街区']];
    mapNames.forEach(([identifier, title, caption], order) => {
      const horizontal = 82 + order * 594;
      const lift = (1 - ease((local - order * .14) / .7)) * 35;
      cover(images[identifier], horizontal, 302 + lift, 568, 485, 1.07 + fraction * .1);
      box(horizontal, 655 + lift, 568, 132, '#0a100bdf');
      text(title, horizontal + 28, 717 + lift, 38, white, 600, 'Bahnschrift');
      text(caption, horizontal + 28, 761 + lift, 22, muted);
    });
    text('545', 82, 882, 72, accent, 600, 'Bahnschrift');
    text('个地点  /  搜索 · 筛选 · 定位', 238, 872, 30, white);
    subtitle('Bakurani、Ozeti、Zestafona，重要地点快速定位。', time, 6);
  } else if (index === 2) {
    shade(.45, 'bottom');
    label('02 / REAL 3D SCENE', 88, 170);
    text('把地图，立起来。', 88, 835, 84, white, 700);
    text('真实地形  /  建筑  /  植被  /  道具', 94, 897, 29, accent);
    subtitle('从全局到近景，看清高差、建筑和地形关系。', time, 12);
  } else if (index === 3 || index === 4) {
    shade(.34, 'bottom');
    label(index === 3 ? '03 / FLY MODE' : '03 / WALK MODE', 88, 170);
    text(index === 3 ? '飞行侦察' : '步行探路', 88, 838, 86, white, 700);
    text(index === 3 ? '拉高视野，提前观察路线。' : '回到地面，换个角度看战场。', 94, 894, 31, accent);
    reticle(960, 480, 22);
    subtitle(index === 3 ? '飞行与步行，两种方式自由探索。' : '先熟悉环境，再和队友出发。', time, shots[index]);
  } else if (index === 5) {
    cover(images.bakurani, 0, 0, 1920, 1080, 1.7);
    box(0, 0, 1920, 1080, '#0b130de9');
    label('04 / ARTILLERY TOOL', 84, 170);
    text('炮兵计算', 80, 310, 84, white, 700);
    text('从选点，到解算。', 86, 378, 39, accent, 600);
    for (const [order, copy] of ['L81 Mortar / L52 Cannon', '距离 · 方位 · 高低弧线', '观察员修正 · 独立瞄具'].entries()) {
      box(90, 484 + order * 82, 7, 7, accent);
      text(copy, 114, 499 + order * 82, order === 0 ? 25 : 29, white);
    }
    shotImage(local < 4.5 ? images.artillery : images.artillery3d, fraction, 652, 212, 1200, 675);
    text('工具界面实景  /  游戏射表与地形预检', 654, 190, 19, muted);
    subtitle('计算辅助以游戏实测为准，轨迹预览不保证命中。', time, 30);
  } else if (index === 6) {
    label('05 / PLAN TOGETHER', 84, 167);
    text('让出击', 83, 307, 79, white, 700);
    text('更有计划。', 81, 407, 86, accent, 700);
    text('搜索目标', 90, 529, 32, white);
    text('测量距离与方位', 90, 600, 32, white);
    text('规划路线 · 收藏标记', 90, 671, 32, white);
    shotImage(images.map2d, fraction, 652, 205, 1200, 675);
    subtitle('把关键位置留在地图里，把行动路线讲清楚。', time, 39);
  } else if (index === 7) {
    cover(images.interface3d, 0, 0, 1920, 1080, 1.015 + fraction * .025);
    box(0, 0, 1920, 1080, '#081008d9');
    label('06 / YOUR LOCAL WORKSPACE', 90, 213);
    text('打开网页，就能准备。', 88, 386, 86, white, 700);
    const items = [['中文操作','更直观'],['本地地图资源','日常浏览无需联网'],['个人工作区','标记 · 收藏 · 备份']];
    items.forEach(([title, caption], order) => {
      const horizontal = 94 + order * 605;
      line([[horizontal,493],[horizontal+475,493]], '#788760', 1);
      text('0' + (order + 1), horizontal, 561, 28, accent, 600, 'Bahnschrift');
      text(title, horizontal, 634, 39, white, 600);
      text(caption, horizontal, 688, 26, muted);
    });
    subtitle('地图在本机，在线人数与加群入口需要联网。', time, 47);
  } else {
    cover(images.bakurani, 0, 0, 1920, 1080, 1.8 + fraction * .08);
    box(0, 0, 1920, 1080, '#08110de8');
    label('READY FOR THE NEXT OPERATION', 90, 212);
    text('地图准备好了。', 86, 354, 91, white, 700);
    text('下一场，一起开黑。', 84, 480, 102, accent, 700);
    text('B友开黑交流群', 94, 599, 38, white, 600);
    text('QQ群', 94, 689, 26, muted);
    text('290101314', 92, 791, 101, white, 600, 'Bahnschrift');
    box(1397, 309, 337, 337, '#eef3e5', 14);
    context.drawImage(images.qr, 1421, 333, 289, 289);
    text('扫码查看官方群邀请', 1565, 704, 25, white, 400, 'Microsoft YaHei', 'center');
    text('关注后续更新  /  欢迎反馈', 1565, 750, 21, muted, 400, 'Microsoft YaHei', 'center');
    subtitle('WARDOGS 战狗 · 非官方本地战术地图', time, 53);
  }
  furniture(index, time);
  const intro = index === 0 ? 1 - ease(local / .45) : 0;
  const transition = index > 0 ? (1 - ease(local / .22)) * .9 : 0;
  if (intro + transition > 0) box(0, 0, 1920, 1080, `rgba(6,10,6,${Math.min(1, intro + transition)})`);
}

async function jpeg() { return new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', .94)); }
async function post(path, body = '') { const response = await fetch(path, { method: 'POST', body }); if (!response.ok) throw new Error(await response.text()); return response.json(); }

async function preview() {
  const time = Number(document.querySelector('#shot').value);
  await prepare(shotAt(time));
  renderFrame(time);
  if (time === 27) {
    tickScene();
    const background = document.createElement('canvas');
    background.width = 1920; background.height = 1080;
    background.getContext('2d').drawImage(view.renderer.domElement, 0, 0);
    const blob = await new Promise(resolve => background.toBlob(resolve, 'image/jpeg', .96));
    await post('/capture/still?name=cover-background', blob);
  }
  await post('/capture/still?name=preview-' + String(time).replace('.', '-'), await jpeg());
  status.textContent = '预览完成：' + names[shotAt(time)];
}

document.querySelector('#preview').onclick = () => preview().catch(showError);
document.querySelector('#render').onclick = async () => {
  document.querySelector('#render').disabled = true;
  document.querySelector('#preview').disabled = true;
  try {
    await post('/capture/start');
    for (let frame = 0; frame < 1800; frame++) {
      const time = frame / 30;
      const index = shotAt(time);
      await prepare(index);
      renderFrame(time);
      await post('/capture/frame?index=' + frame, await jpeg());
      if (frame % 15 === 0) status.textContent = `导出 ${Math.round(frame / 18)}% · ${names[index]} · ${frame}/1800`;
    }
    await post('/capture/finish');
    status.textContent = '60秒画面导出完成';
    detail.textContent = 'video-only.mp4 / 1920×1080 / 30 fps / 1800 frames';
  } catch (error) { showError(error); }
  document.querySelector('#render').disabled = false;
  document.querySelector('#preview').disabled = false;
};

function showError(error) { status.textContent = '失败：' + error.message; detail.textContent = error.stack; }

async function initialize() {
  const files = { bakurani: '/assets/bakurani-detail.webp', ozeti: '/assets/ozeti-detail.webp', zestafona: '/assets/zestafona-detail.webp', map2d: '/promotional-video/assets/interface-2d.png', artillery: '/promotional-video/assets/interface-artillery.png', artillery3d: '/promotional-video/assets/interface-artillery-3d.png', interface3d: '/promotional-video/assets/interface-3d.png', qr: '/promotional-video/assets/qq-qr.png' };
  await Promise.all(Object.entries(files).map(async ([key, filename]) => { const image = new Image(); image.src = filename; await image.decode(); images[key] = image; }));
  view = new TerrainView(document.querySelector('#terrain'), { onChange() {}, onHover() {}, onClick() {}, isToolActive: () => false, isArtilleryActive: () => false, onModels: value => { modelStatus = value; } });
  view.invalidate = () => {};
  view.active = true;
  view.controls.enabled = false;
  view.controls.enableDamping = false;
  view.setSettings({ brightness: 70, view: 'satellite', grid: false, quality: 'high', shadows: true, collision: false, models: { buildings: true, trees: true, props: true }, modelLoading: 'stream' });
  view.renderer.setPixelRatio(1);
  view.renderer.setSize(1920, 1080, false);
  await view.loadMap(window.WARDOGS_MAPS.bakurani);
  while (!view.props.manifest || !view.renderer.domElement.dataset.groundLayers) { tickScene(); await pause(30); }
  center = view.props.showcase();
  await preview();
  document.querySelector('#preview').disabled = false;
  document.querySelector('#render').disabled = false;
}

initialize().catch(showError);
