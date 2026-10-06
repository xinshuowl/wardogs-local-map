import { integrateCannon, weaponById } from './artillery-ballistics.js';

const compass = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
export function compassDirection(bearing) { return compass[Math.round(bearing / 22.5) % 16]; }

export function sightRange(identifier, mils) {
  if (identifier === 'l52-cannon') return integrateCannon(mils).distance;
  const weapon = weaponById(identifier);
  const raw = mils - weapon.displayOffset;
  for (let index = 1; index < weapon.rangeTable.length; index++) {
    const previous = weapon.rangeTable[index - 1];
    const next = weapon.rangeTable[index];
    if (raw >= previous[0] && raw <= next[0]) return previous[1] + (next[1] - previous[1]) * (raw - previous[0]) / (next[0] - previous[0]);
  }
  return null;
}

export class ArtillerySight {
  constructor(element, onVisibilityChange) {
    this.element = element;
    this.container = element.parentElement;
    this.onVisibilityChange = onVisibilityChange;
    this.full = false;
    element.innerHTML = '<header><strong>GUNNER SIGHT</strong><span><button data-sight-expand aria-label="全尺寸瞄具">⤢</button><button data-sight-close aria-label="隐藏瞄具">×</button></span></header><svg viewBox="0 0 500 430" role="img" aria-label="动态炮兵瞄具"></svg>';
    element.querySelector('[data-sight-expand]').addEventListener('click', () => this.expand(!this.full));
    element.querySelector('[data-sight-close]').addEventListener('click', () => this.hide());
    document.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || this.element.hidden || document.querySelector('dialog[open]') || this.navigationActive && !this.full) return;
      event.preventDefault(); event.stopImmediatePropagation();
      if (this.full) this.expand(false); else this.hide();
    }, { capture: true });
  }
  show() { this.element.hidden = false; this.onVisibilityChange?.(); }
  hide() { this.element.hidden = true; this.expand(false); this.onVisibilityChange?.(); }
  expand(full) {
    this.full = full;
    (full ? document.body : this.container)?.append(this.element);
    this.element.classList.toggle('sight-full', full);
    this.element.querySelector('[data-sight-expand]').setAttribute('aria-label', full ? '缩小瞄具' : '全尺寸瞄具');
  }
  update(metadata) {
    if (!metadata) { const svg = this.element.querySelector('svg'); svg.innerHTML = '<rect width="500" height="430" fill="#020604"/><text x="250" y="215" text-anchor="middle" fill="#97d7a4" font-family="monospace" font-size="16">SET GUN &amp; TARGET · 设置炮位与目标</text>'; svg.setAttribute('aria-label', '瞄具：等待炮位与目标'); return; }
    const shot = metadata.selected;
    const mils = shot?.mils ?? 0;
    const bearing = metadata.bearing ?? 0;
    const svg = this.element.querySelector('svg');
    let drawing = '<rect width="500" height="430" fill="#020604"/><g fill="#97d7a4" stroke="#97d7a4" stroke-width=".7" font-family="monospace">';
    drawing += '<path d="M80 44H420 M250 48l-5 8h10z" fill="#97d7a4"/>';
    for (let offset = -45; offset <= 45; offset += 5) {
      const value = (Math.round(bearing / 5) * 5 + offset + 360) % 360;
      const position = 250 + (offset + Math.round(bearing / 5) * 5 - bearing) * 3.6;
      drawing += '<path d="M' + position + ' 44v-' + (value % 15 === 0 ? 12 : 6) + '"/>';
      if (value % 15 === 0) drawing += '<text x="' + position + '" y="25" text-anchor="middle" stroke="none" font-size="11">' + (value % 45 === 0 ? compassDirection(value) : value) + '</text>';
    }
    drawing += '<circle cx="250" cy="235" r="50" fill="none"/><circle cx="250" cy="235" r="5" fill="none"/><path d="M162 235h30 M308 235h30 M250 146v28 M250 296v28 M242 215h16 M242 255h16" fill="none"/><text x="27" y="26" font-size="10" stroke="none">RNG</text><text x="455" y="26" font-size="10" stroke="none">MIL</text>';
    const base = Math.round(mils / 10) * 10;
    for (let offset = -20; offset <= 20; offset += 5) {
      const value = base + offset;
      const position = 235 - (value - mils) * 3;
      drawing += '<path d="M69 ' + position + 'h20 M411 ' + position + 'h20" opacity=".65"/>';
      if (value % 10 === 0 && shot) {
        const range = sightRange(metadata.weapon, value);
        drawing += '<text x="59" y="' + (position + 4) + '" text-anchor="end" stroke="none" font-size="11">' + (range === null ? '—' : Math.round(range)) + '</text><text x="439" y="' + (position + 4) + '" stroke="none" font-size="11">' + value + '</text>';
      }
    }
    drawing += '<path d="M90 235h23 M387 235h23" stroke="#edc079" stroke-width="2"/></g>';
    const warning = metadata.blocked ? (metadata.obstruction?.reason === 'object' ? 'STRUCTURE IN ARC · 建筑拦截' : 'TERRAIN IN ARC · 地形拦截') : metadata.collisionStatus === 'pending' ? 'CHECKING ARC · 检查拦截中' : metadata.collisionStatus === 'error' ? 'OBSTRUCTION UNKNOWN · 检查失败' : !shot ? 'OUT OF RANGE · 不可达' : '';
    if (warning) drawing += '<rect x="90" y="337" width="320" height="31" fill="#190c08" stroke="#cb6550"/><text x="250" y="357" fill="#dd806b" text-anchor="middle" font-family="monospace" font-size="12">' + warning + '</text>';
    drawing += '<text x="250" y="393" fill="#a0e0b0" text-anchor="middle" font-family="monospace" font-size="22">' + Math.round(metadata.range) + ' M</text><text x="250" y="417" fill="#8fbe9d" text-anchor="middle" font-family="monospace" font-size="11">' + (shot ? Math.round(mils) + ' MIL' : 'NO SOLUTION') + ' · ' + bearing.toFixed(1) + '° ' + compassDirection(bearing) + ' · ' + (shot ? shot.time.toFixed(1) + ' S' : '—') + '</text>';
    svg.innerHTML = drawing;
    svg.setAttribute('aria-label', '瞄具：' + Math.round(metadata.range) + ' 米，' + Math.round(mils) + ' mils，方位 ' + bearing.toFixed(1) + ' 度' + (warning ? '，' + warning : ''));
  }
}
