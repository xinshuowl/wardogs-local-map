import { WEAPONS } from './artillery-data.js';
import { weaponById, validPosition, gameToMap, mapToGame, firingVector, solveWeapon, correctedTarget, createTrajectory, sampleTerrainHeight } from './artillery-ballistics.js';

import { MapCollision } from './map-collision.js';
import { ArtillerySight, compassDirection } from './artillery-sight.js';
import { QuickGuide } from './artillery-guide.js';
import { detailHeights } from './terrain-height-detail.js';
import { createLocalId } from './tactical-drawing.js';

const storagePrefix = 'wardogs-artillery:v2:';
const escapeText = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const signed = value => (value > 0 ? '+' : '') + Math.round(value);
const finiteHeight = value => value === null || Number.isFinite(value) && Math.abs(value) <= 100000;

export function validArtilleryState(record) {
  return record && typeof record === 'object' && WEAPONS.some(weapon => weapon.id === record.weapon) && ['low', 'high'].includes(record.arc) && Array.isArray(record.points) && record.points.length === 2 && record.points.every(point => point === null || validPosition(point)) && Array.isArray(record.overrides) && record.overrides.length === 2 && record.overrides.every(finiteHeight) && (record.arcPinned === undefined || typeof record.arcPinned === 'boolean') && (record.correction === undefined || validCorrection(record.correction)) && (record.step === undefined || [10, 25, 50, 100].includes(record.step));
}

function validCorrection(correction) {
  return correction && [correction.add, correction.right].every(value => Number.isFinite(value) && Math.abs(value) <= 10000);
}

export class ArtilleryTool {
  constructor(panel, callbacks) {
    this.panel = panel;
    this.callbacks = callbacks;
    this.mapId = null;
    this.active = false;
    this.nextPoint = 1;
    this.cameraMode = 'orbit';
    this.collision = new MapCollision();
    this.collisionResults = new Map();
    this.arcPinned = false;
    this.heightCache = new Map();
    this.heightRequests = new Map();
    this.heightErrors = new Map();
    panel.innerHTML =       '<div class="artillery-heading"><div><span class="eyebrow">ARTILLERY TOOL</span><h2>炮兵计算工具</h2></div><button class="icon-button" data-action="cancel-tool" aria-label="关闭炮兵工具">×</button></div>' +
      '<button class="artillery-map-name" data-action="choose-map"><span id="artillery-map-name"></span><span>切换战场 ›</span></button>' +
      '<div class="artillery-scroll">' +
      '<section class="artillery-section"><div class="artillery-section-title"><h3>武器选择</h3><span>WEAPON</span></div><div class="artillery-weapons">' + WEAPONS.slice().reverse().map(weapon => '<button type="button" class="artillery-weapon" data-art-weapon="' + weapon.id + '" aria-pressed="false"><svg class="weapon-icon" viewBox="0 0 50 40" aria-hidden="true">' + (weapon.id === 'l81-mortar' ? '<ellipse cx="25" cy="31" rx="21" ry="7"/><path d="m21 29 8-23 4 1-8 22 M29 17l11 15 M13 32l10-12"/>' : '<path d="M5 24h22v10H5z M18 23l4-7 10 2-5 9 M31 20l17-5 M8 34h27 M8 29h22"/>') + '</svg><span><strong>' + weapon.name + '</strong><small>' + weapon.ammo + '</small></span><em>' + weapon.minRange + '–' + weapon.maxRange + ' m</em></button>').join('') + '</div></section>' +
      '<section class="artillery-section"><div class="artillery-section-title"><h3>炮位与目标</h3><button data-art="fit" class="artillery-link">缩放适配</button></div><div class="artillery-placement"><button data-art-point="0">⊕ 设置炮位</button><button data-art-point="1">◎ 设置目标</button></div>' +
      '<div class="artillery-coordinate-row"><span class="artillery-dot gun-dot"></span><strong>炮位</strong><label>X<input id="artillery-gun-x" type="number" min="0" step="0.01" aria-label="炮位 X 坐标"></label><label>Y<input id="artillery-gun-y" type="number" min="0" step="0.01" aria-label="炮位 Y 坐标"></label><button data-art-copy="0" aria-label="复制炮位坐标">⧉</button></div>' +
      '<div class="artillery-coordinate-row"><span class="artillery-dot target-dot"></span><strong>目标</strong><label>X<input id="artillery-target-x" type="number" min="0" step="0.01" aria-label="目标 X 坐标"></label><label>Y<input id="artillery-target-y" type="number" min="0" step="0.01" aria-label="目标 Y 坐标"></label><button data-art-copy="1" aria-label="复制目标坐标">⧉</button></div>' +
      '<p class="artillery-placement-status" id="artillery-placement-status" role="status"></p><button class="artillery-link" data-art="clear">清空炮位与目标</button></section>' +
      '<section class="artillery-section"><div class="artillery-section-title"><h3>保存目标预设</h3><span>本地图 · 本机</span></div><form id="artillery-presets-form"><input id="artillery-preset-name" aria-label="目标预设名称" maxlength="64" placeholder="预设名称，例如：山顶 → 仓库" required><button type="submit">＋ 保存</button></form><div id="artillery-presets"></div></section>' +
      '<section class="artillery-section"><div class="artillery-section-title"><h3>射击解算</h3><span id="artillery-apex"></span></div><div id="artillery-solution" aria-live="polite"></div><svg id="artillery-chart" viewBox="0 0 300 110" role="img" aria-label="弹道与地形剖面" hidden></svg><p id="artillery-terrain-note" class="artillery-note"></p></section>' +
      '<section class="artillery-section"><div class="artillery-section-title"><h3>观察员修正</h3><select id="artillery-step" aria-label="观察员修正步长"><option value="10">10 m</option><option value="25" selected>25 m</option><option value="50">50 m</option><option value="100">100 m</option></select></div><div class="artillery-correction-pad"><button data-art-correct="add">↑ 延伸 Add</button><button data-art-correct="left">← 左移 Left</button><span id="artillery-correction-total">0 / 0 m</span><button data-art-correct="right">右移 Right →</button><button data-art-correct="drop">↓ 缩短 Drop</button></div><p id="artillery-correction-target" class="artillery-note"></p><div class="artillery-placement"><button data-art="commit">应用到目标</button><button data-art="reset-correction">修正归零</button></div></section>' +
      '<details class="artillery-guide"><summary>快速使用指南与刻度说明</summary><ol><li>选择 L81 Mortar 或 L52 Cannon。</li><li>设置炮位与目标：点击按钮后在地图选点，或直接输入游戏 X/Y 坐标。</li><li>读取方位、游戏 mils 与飞行时间；加农炮可选择高、低弧线。</li><li>观察落点后用 Add / Drop / Left / Right 修正，确认后应用到目标。</li></ol><p>每个坐标单位 = 100 m；X 向东、Y 向北。方位 mils = 弧度 × 1000（90° = 1571 mils），不是 6400 制密位。迫击炮射表刻度偏移 +650。仅用于 WARDOGS 虚构游戏；算法与参考站对照，不代表游戏内实弹命中保证。</p></details>' +
      '</div>';
    this.solution = panel.querySelector('#artillery-solution');
    panel.querySelector('#artillery-terrain-note').insertAdjacentHTML('afterend', '<button class="artillery-link" data-art="retry-heights" hidden>重试高度加载</button>');
    this.coordinateInputs = [[panel.querySelector('#artillery-gun-x'), panel.querySelector('#artillery-gun-y')], [panel.querySelector('#artillery-target-x'), panel.querySelector('#artillery-target-y')]];
    this.sight = document.getElementById('artillery-sight');
    this.gunnerSight = new ArtillerySight(this.sight, () => this.syncPressedControls());
    this.guide = new QuickGuide(panel);
    if (callbacks.viewport) {
      callbacks.viewport.addEventListener('pointerdown', event => {
        const marker = event.target.closest('[data-art-marker]');
        if (!this.active || !marker || event.button !== 0) return;
        event.stopImmediatePropagation(); event.preventDefault();
        this.dragPoint = { index: Number(marker.dataset.artMarker), pointer: event.pointerId };
        this.setView('orbit'); callbacks.viewport.setPointerCapture(event.pointerId);
      }, { capture: true });
      callbacks.viewport.addEventListener('pointermove', event => {
        if (!this.dragPoint || this.dragPoint.pointer !== event.pointerId) return;
        event.stopImmediatePropagation();
        const position = callbacks.mapPosition(event.clientX, event.clientY);
        if (validPosition(position)) this.setPoint(this.dragPoint.index, position, callbacks.pickHeight?.() ?? null);
      }, { capture: true });
      for (const type of ['pointerup', 'pointercancel']) callbacks.viewport.addEventListener(type, event => {
        if (!this.dragPoint || this.dragPoint.pointer !== event.pointerId) return;
        event.stopImmediatePropagation(); this.dragPoint = null;
        if (callbacks.viewport.hasPointerCapture(event.pointerId)) callbacks.viewport.releasePointerCapture(event.pointerId);
      }, { capture: true });
    }
    this.viewbar = document.getElementById('artillery-viewbar');
    panel.addEventListener('click', event => this.handleClick(event));
    for (const [index, fields] of this.coordinateInputs.entries()) for (const field of fields) {
      field.addEventListener('input', () => this.editCoordinates(index));
      field.addEventListener('change', () => this.editCoordinates(index));
    }
    panel.querySelector('#artillery-step').addEventListener('change', event => { this.step = Number(event.target.value); this.persist(); });
    panel.querySelector('#artillery-presets-form').addEventListener('submit', event => { event.preventDefault(); this.savePreset(); });
    this.viewbar?.addEventListener('click', event => {
      const mode = event.target.closest('[data-art-view]')?.dataset.artView;
      if (mode === 'gun' || mode === 'target') { this.nextPoint = mode === 'gun' ? 0 : 1; this.refreshPlacement(); this.callbacks.onPick?.(); }
      else if (mode === 'sight') this.gunnerSight.element.hidden ? this.gunnerSight.show() : this.gunnerSight.hide();
      else if (mode) this.setView(mode);
    });
    this.panel.querySelector('.artillery-weapons').insertAdjacentHTML('afterend', '<div class="artillery-placement artillery-closeups"><button data-art="model-camera">炮位模型近景 · 3D</button><button data-art="target-camera">目标地形近景 · 3D</button></div>');
    this.panel.querySelector('.artillery-heading').insertAdjacentHTML('beforeend', '<button class="artillery-link" data-art="guide">快速指南</button>');
    this.panel.querySelector('#artillery-presets-form').insertAdjacentHTML('afterend', '<button class="artillery-link" data-art="share">⧉ 分享当前炮兵配置与筛选</button>');
    document.addEventListener('keydown', event => { if (event.key === 'Escape' && this.cameraMode !== 'orbit') this.setView('orbit'); });
  }

  defaultState(map) {
    const points = map.id === 'bakurani' ? [gameToMap(map, { x: 77.09, y: 69.95 }), gameToMap(map, { x: 80.28, y: 69.51 })] : [[...map.center], [Math.min(2048, map.center[0] + 340 / (map.bounds[2] / 100 / 2048)), map.center[1]]];
    return { weapon: 'l81-mortar', arc: 'low', points, overrides: [null, null] };
  }

  restore(map) {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(storagePrefix + map.id) || 'null'); } catch {}
    const record = validArtilleryState(saved) ? saved : this.defaultState(map);
    this.arcPinned = saved?.arcPinned === true || saved?.arcPinned === undefined && record.arc === 'high';
    this.weapon = record.weapon;
    this.arc = record.arc;
    this.points = record.points.map(point => point && [...point]);
    this.overrides = [...record.overrides];
    this.correction = validCorrection(saved?.correction) ? { ...saved.correction } : { add: 0, right: 0 };
    this.step = [10, 25, 50, 100].includes(saved?.step) ? saved.step : 25;
    this.presets = Array.isArray(saved?.presets) ? saved.presets.filter(preset => validArtilleryState(preset) && preset.points.every(Boolean) && typeof preset.name === 'string' && preset.name.trim() && preset.name.length <= 64 && typeof preset.id === 'string' && /^preset-[a-z0-9-]{1,100}$/i.test(preset.id)).slice(0, 100) : [];
    if (this.points.every(Boolean)) {
      try { correctedTarget(map, ...this.points, this.correction.add, this.correction.right); } catch { this.correction = { add: 0, right: 0 }; }
    }
    this.nextPoint = this.points[0] ? 1 : 0;
    this.panel.querySelector('#artillery-step').value = String(this.step);
  }

  persist() {
    if (!this.mapId) return;
    try {
      localStorage.setItem(storagePrefix + this.mapId, JSON.stringify({ version: 2, weapon: this.weapon, arc: this.arc, arcPinned: this.arcPinned, points: this.points, overrides: this.overrides, correction: this.correction, step: this.step, presets: this.presets }));
    } catch { this.callbacks.notify('浏览器无法保存炮兵预设，请检查本地存储权限。'); }
  }

  open() {
    const map = this.callbacks.map();
    if (this.mapId !== map.id) { this.mapId = map.id; this.restore(map); }
    this.active = true;
    this.panel.hidden = false;
    document.body.classList.add('artillery-open');
    this.panel.querySelector('#artillery-map-name').textContent = map.name;
    for (const fields of this.coordinateInputs) for (const field of fields) field.max = String(map.bounds[2] / 10000);
    this.updateCoordinates();
    this.renderPresets();
    this.refresh();
    this.gunnerSight.show();
    this.loadHeights(map);
  }

  close() {
    if (!this.active) return;
    this.active = false;
    this.panel.hidden = true;
    document.body.classList.remove('artillery-open');
    this.setView('orbit');
    this.gunnerSight.hide();
    this.guide.close();
    if (this.viewbar) this.viewbar.hidden = true;
    this.callbacks.onTrajectory(null, null);
  }

  async loadHeights(map) {
    if (this.heightCache.has(map.id)) return;
    if (this.heightErrors.delete(map.id) && this.active && this.mapId === map.id) this.refresh();
    if (!this.heightRequests.has(map.id)) {
      const request = (async () => {
        this.manifestPromise ||= fetch('./assets/terrain/manifest.json').then(response => { if (!response.ok) throw new Error('高度清单缺失'); return response.json(); }).catch(error => { this.manifestPromise = null; throw error; });
        const descriptor = (await this.manifestPromise)[map.id];
        if (!descriptor) throw new Error('当前地图没有高度数据');
        const response = await fetch('./' + descriptor.file);
        if (!response.ok) throw new Error('高度文件缺失');
        const buffer = await response.arrayBuffer();
        if (buffer.byteLength !== descriptor.cols * descriptor.rows * 2) throw new Error('高度文件不完整');
        const view = new DataView(buffer);
        const heights = new Uint16Array(descriptor.cols * descriptor.rows);
        for (let index = 0; index < heights.length; index++) heights[index] = view.getUint16(index * 2, true);
        this.heightCache.set(map.id, { descriptor, heights });
      })();
      this.heightRequests.set(map.id, request);
    }
    try {
      await this.heightRequests.get(map.id);
      if (this.active && this.mapId === map.id) { this.refresh(); this.callbacks.onFit(this.points.filter(Boolean), this.trajectory); }
    } catch (error) {
      this.heightRequests.delete(map.id);
      this.heightErrors.set(map.id, error.message);
      if (this.active && this.mapId === map.id) this.refresh();
    }
  }

  heightAt(position, map = this.callbacks.map()) {
    const precise = detailHeights.sample(map, position);
    if (Number.isFinite(precise)) return precise;
    const live = this.callbacks.map().id === map.id ? this.callbacks.heightAt(position) : null;
    if (Number.isFinite(live)) return live;
    const cached = this.heightCache.get(map.id);
    return cached ? sampleTerrainHeight(map, cached.descriptor, cached.heights, position) : null;
  }

  updateCoordinates() {
    const map = this.callbacks.map();
    for (const [index, fields] of this.coordinateInputs.entries()) {
      const coordinates = this.points[index] ? mapToGame(map, this.points[index]) : null;
      fields[0].value = coordinates ? coordinates.x.toFixed(2) : '';
      fields[1].value = coordinates ? coordinates.y.toFixed(2) : '';
      for (const field of fields) { field.setCustomValidity(''); field.removeAttribute('aria-invalid'); }
    }
  }

  editCoordinates(index) {
    const fields = this.coordinateInputs[index];
    try {
      if (fields.some(field => field.value.trim() === '')) throw new Error('请填写完整的 X / Y 坐标。');
      const position = gameToMap(this.callbacks.map(), { x: fields[0].valueAsNumber, y: fields[1].valueAsNumber });
      for (const field of fields) { field.setCustomValidity(''); field.removeAttribute('aria-invalid'); }
      this.points[index] = position;
      this.overrides[index] = null;
      this.correction = { add: 0, right: 0 };
      this.persist();
      this.refresh();
    } catch (error) {
      for (const field of fields) { field.setCustomValidity(error.message); field.setAttribute('aria-invalid', 'true'); }
      this.panel.querySelector('#artillery-placement-status').textContent = error.message + ' 当前保留上次有效解算。';
    }
  }

  addPoint(position, height = null) { this.setPoint(this.nextPoint, position, height); }

  setPoint(index, position, height = null) {
    if (![0, 1].includes(index) || !validPosition(position) || !finiteHeight(height)) { this.callbacks.notify('炮位或目标坐标无效。'); return; }
    this.points[index] = [...position];
    this.overrides[index] = height;
    this.correction = { add: 0, right: 0 };
    this.nextPoint = 1;
    this.updateCoordinates();
    this.persist();
    this.refresh();
  }

  handleClick(event) {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.dataset.artWeapon) {
      this.weapon = button.dataset.artWeapon;
      this.arc = 'low';
      this.arcPinned = false;
      this.persist();
      this.refresh();
    } else if (button.dataset.artPoint !== undefined) {
      this.nextPoint = Number(button.dataset.artPoint);
      this.refreshPlacement();
      this.callbacks.onPick?.();
    } else if (button.dataset.artCopy !== undefined) this.copyCoordinates(Number(button.dataset.artCopy));
    else if (button.dataset.artArc) { this.arc = button.dataset.artArc; this.arcPinned = true; this.persist(); this.refresh(); }
    else if (button.dataset.art === 'guide') this.guide.open();
    else if (button.dataset.art === 'retry-heights') this.loadHeights(this.callbacks.map());
    else if (button.dataset.art === 'model-camera' || button.dataset.art === 'target-camera') { this.gunnerSight.hide(); this.setView(button.dataset.art === 'model-camera' ? 'gun' : 'target'); }
    else if (button.dataset.art === 'share') this.callbacks.onShare?.(this.snapshot());
    else if (button.dataset.artCorrect) this.adjustCorrection(button.dataset.artCorrect);
    else if (button.dataset.artPreset) this.loadPreset(button.dataset.artPreset);
    else if (button.dataset.artDelete) {
      this.presets = this.presets.filter(preset => preset.id !== button.dataset.artDelete);
      this.persist(); this.renderPresets();
    } else if (button.dataset.art === 'fit') this.callbacks.onFit(this.metadata ? [this.metadata.gun, this.metadata.target] : this.points.filter(Boolean), this.trajectory);
    else if (button.dataset.art === 'clear') {
      this.points = [null, null]; this.overrides = [null, null]; this.correction = { add: 0, right: 0 }; this.nextPoint = 0;
      this.setView('orbit'); this.updateCoordinates(); this.persist(); this.refresh();
    } else if (button.dataset.art === 'reset-correction') { this.correction = { add: 0, right: 0 }; this.persist(); this.refresh(); }
    else if (button.dataset.art === 'commit' && this.points.every(Boolean)) {
      try {
        const target = correctedTarget(this.callbacks.map(), ...this.points, this.correction.add, this.correction.right);
        this.setPoint(1, target);
        this.callbacks.notify('观察员修正已应用到目标。');
      } catch (error) { this.callbacks.notify(error.message); }
    }
  }

  async copyCoordinates(index) {
    if (!this.points[index]) return;
    const coordinates = mapToGame(this.callbacks.map(), this.points[index]);
    const text = 'X ' + coordinates.x.toFixed(2) + ', Y ' + coordinates.y.toFixed(2);
    try { await navigator.clipboard.writeText(text); this.callbacks.notify('已复制：' + text); }
    catch { this.callbacks.notify('坐标：' + text + '（浏览器未允许复制）'); }
  }

  adjustCorrection(direction) {
    if (!this.points.every(Boolean)) return;
    const correction = { ...this.correction };
    if (direction === 'add') correction.add += this.step;
    if (direction === 'drop') correction.add -= this.step;
    if (direction === 'right') correction.right += this.step;
    if (direction === 'left') correction.right -= this.step;
    try {
      correctedTarget(this.callbacks.map(), ...this.points, correction.add, correction.right);
      if (!validCorrection(correction)) throw new Error('累计修正超过允许范围。');
      this.correction = correction;
      this.persist(); this.refresh();
    } catch (error) { this.callbacks.notify(error.message); }
  }

  savePreset() {
    if (!this.points.every(Boolean)) { this.callbacks.notify('请先设置炮位与目标。'); return; }
    const nameInput = this.panel.querySelector('#artillery-preset-name');
    const name = nameInput.value.trim().slice(0, 64);
    if (!name) { nameInput.focus(); return; }
    const target = correctedTarget(this.callbacks.map(), ...this.points, this.correction.add, this.correction.right);
    const record = { id: createLocalId('preset'), name, weapon: this.weapon, arc: this.arc, arcPinned: this.arcPinned, points: [[...this.points[0]], target], overrides: [this.overrides[0], this.correction.add || this.correction.right ? null : this.overrides[1]] };
    const existing = this.presets.findIndex(preset => preset.name === name);
    if (existing >= 0) { record.id = this.presets[existing].id; this.presets[existing] = record; }
    else if (this.presets.length < 100) this.presets.push(record);
    else { this.callbacks.notify('每张地图最多保存 100 个预设。'); return; }
    nameInput.value = '';
    this.persist(); this.renderPresets();
    this.callbacks.notify('已保存预设：' + name);
  }

  loadPreset(identifier) {
    const preset = this.presets.find(entry => entry.id === identifier);
    if (!preset) return;
    this.weapon = preset.weapon; this.arc = preset.arc; this.arcPinned = preset.arcPinned === true || preset.arcPinned === undefined && preset.arc === 'high';
    this.points = preset.points.map(point => [...point]); this.overrides = [...preset.overrides];
    this.correction = { add: 0, right: 0 };
    this.updateCoordinates(); this.persist(); this.refresh();
    this.callbacks.onFit(this.points, this.trajectory);
    this.callbacks.notify('已恢复预设：' + preset.name);
  }

  renderPresets() {
    const list = this.panel.querySelector('#artillery-presets');
    list.innerHTML = this.presets.length ? this.presets.map(preset => '<div class="artillery-preset"><button data-art-preset="' + escapeText(preset.id) + '"><strong>' + escapeText(preset.name) + '</strong><small>' + weaponById(preset.weapon).name + '</small></button><button data-art-delete="' + escapeText(preset.id) + '" aria-label="删除预设 ' + escapeText(preset.name) + '">×</button></div>').join('') : '<p class="artillery-note">此地图暂无预设。保存炮位与目标，下次直接恢复。</p>';
  }

  refreshPlacement() {
    this.syncPressedControls();
    this.panel.querySelector('#artillery-placement-status').textContent = (this.nextPoint === 0 ? '点击地图设置炮位' : '点击地图设置目标') + ' · 或编辑坐标 · X 东 / Y 北';
  }

  refresh() {
    if (!this.active) return;
    this.refreshPlacement();
    this.panel.querySelector('[data-art="retry-heights"]').hidden = !this.heightErrors.has(this.mapId);
    for (const button of this.panel.querySelectorAll('[data-art-weapon]')) {
      const active = button.dataset.artWeapon === this.weapon;
      button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active));
    }
    const complete = this.points.every(Boolean);
    for (const button of this.panel.querySelectorAll('[data-art-correct], [data-art="commit"], [data-art="fit"], [data-art-copy]')) button.disabled = !complete;
    for (const button of this.panel.querySelectorAll('[data-art-copy]')) button.disabled = !this.points[Number(button.dataset.artCopy)];
    this.panel.querySelector('#artillery-presets-form button').disabled = !complete;
    const hasCorrection = this.correction.add !== 0 || this.correction.right !== 0;
    this.panel.querySelector('[data-art="commit"]').disabled = !complete || !hasCorrection;
    this.panel.querySelector('[data-art="reset-correction"]').disabled = !hasCorrection;
    this.panel.querySelector('#artillery-correction-total').textContent = signed(this.correction.add) + ' / ' + signed(this.correction.right) + ' m';
    this.panel.querySelector('#artillery-correction-target').textContent = '延伸 / 右移 · 相对于炮位 → 原目标方向';
    this.trajectory = null;
    this.metadata = null;
    this.collisionKey = null;
    this.panel.querySelector('#artillery-chart').hidden = true;
    this.panel.querySelector('#artillery-apex').textContent = '';
    if (!complete) {
      this.solution.innerHTML = '<p class="artillery-note">设置炮位与目标后自动解算，无需输入初速或重力。</p>';
      this.panel.querySelector('#artillery-terrain-note').textContent = '';
      const point = this.points[0] || this.points[1];
      const metadata = point ? { weapon: this.weapon, gun: this.points[0], target: this.points[1], originHeight: this.points[0] ? this.overrides[0] ?? this.heightAt(this.points[0]) : null, targetHeight: this.points[1] ? this.overrides[1] ?? this.heightAt(this.points[1]) : null } : null;
      this.callbacks.onTrajectory(null, metadata);
      this.updateViewControls(); this.updateSight();
      return;
    }
    const map = this.callbacks.map();
    const target = correctedTarget(map, ...this.points, this.correction.add, this.correction.right);
    const vector = firingVector(map, this.points[0], target);
    const originHeight = this.overrides[0] ?? this.heightAt(this.points[0]);
    const targetHeight = this.correction.add || this.correction.right ? this.heightAt(target) : this.overrides[1] ?? this.heightAt(target);
    const hasHeights = [originHeight, targetHeight].every(Number.isFinite);
    let result = solveWeapon(this.weapon, vector.range, hasHeights ? originHeight - targetHeight : 0, this.arc);
    const collisionKey = JSON.stringify([map.id, this.weapon, this.points[0], target, originHeight, targetHeight, detailHeights.version(map.id)]);
    this.collisionKey = collisionKey;
    let collision = this.collisionResults.get(collisionKey);
    if (hasHeights && result.shots.length && !collision) {
      collision = { status: 'pending', arcs: {} };
      this.collisionResults.set(collisionKey, collision);
      const paths = result.shots.map(shot => ({ arc: shot.arc, points: createTrajectory(this.weapon, shot, this.points[0], target, originHeight, targetHeight) }));
      const precisionVersion = detailHeights.version(map.id);
      detailHeights.ensure(map, paths.flatMap(path => path.points)).then(() => {
        if (detailHeights.version(map.id) !== precisionVersion) { if (this.active && this.collisionKey === collisionKey) this.refresh(); return null; }
        return this.collision.check(map, paths, position => this.heightAt(position.slice(0, 2), map));
      }).then(arcs => {
        if (!arcs) return;
        this.collisionResults.set(collisionKey, { status: 'ready', arcs });
        if (this.active && this.collisionKey === collisionKey) this.refresh();
      }).catch(error => {
        this.collisionResults.set(collisionKey, { status: 'error', arcs: {}, error: error.message });
        if (this.active && this.collisionKey === collisionKey) this.refresh();
      });
      if (this.collisionResults.size > 100) this.collisionResults.delete(this.collisionResults.keys().next().value);
    }
    if (!this.arcPinned && collision?.status === 'ready') {
      const preferred = result.shots.find(shot => !collision.arcs[shot.arc]?.blocked);
      if (preferred && preferred.arc !== result.selected?.arc) result = solveWeapon(this.weapon, vector.range, hasHeights ? originHeight - targetHeight : 0, preferred.arc);
    }
    const obstruction = collision?.arcs[result.selected?.arc] || null;
    if (result.selected) this.arc = result.selected.arc;
    this.solution.innerHTML = '<div class="artillery-metrics"><div><span>方位角 AZIMUTH</span><strong>' + vector.bearing.toFixed(1) + '°</strong><small>' + Math.round(vector.bearingMils) + ' mils</small></div><div><span>水平射程 RANGE</span><strong>' + Math.round(vector.range).toLocaleString() + '<em> m</em></strong><small>' + (hasHeights ? '高差 ' + signed(result.drop) + ' m' : '地形高度加载中') + '</small></div></div><div class="artillery-range-status ' + (result.status === 'in-range' ? 'ready' : 'unreachable') + '">' + (result.status === 'in-range' ? '● 在射程内' : result.status === 'too-close' ? '● 目标过近 · 最小射程 ' + result.weapon.minRange + ' m' : vector.range <= result.weapon.maxRange ? '● 当前距离无法获得有效解 · 数值射程限制' : '● 目标过远 · 最大射程 ' + result.weapon.maxRange + ' m') + '</div>' +
      '<div class="artillery-arcs">' + result.shots.map(shot => '<button data-art-arc="' + shot.arc + '" class="artillery-arc-card ' + (shot.arc === this.arc ? 'active' : '') + '" aria-pressed="' + (shot.arc === this.arc) + '"><span>' + (this.weapon === 'l81-mortar' ? '迫击炮射表' : shot.arc === 'low' ? '低弧线 LOW' : '高弧线 HIGH') + '</span><strong>' + Math.round(shot.mils) + '<em> mils</em></strong><small>飞行时间 ' + shot.time.toFixed(1) + ' s</small></button>').join('') + '</div>' +
      (result.correctionNeeded ? '<div class="artillery-terrain-correction">地形修正 TERRAIN CORRECTED<strong>' + (result.corrected ? Math.round(result.corrected.mils) + ' mils <small>(' + signed(result.corrected.mils - result.selected.mils) + ')</small>' : '该弧线在此高差下不可达') + '</strong></div>' : '');
    if (this.correction.add || this.correction.right) {
      const effective = mapToGame(map, target);
      this.panel.querySelector('#artillery-correction-target').textContent = '修正目标 X ' + effective.x.toFixed(2) + ' · Y ' + effective.y.toFixed(2) + '（尚未应用）';
    }
    const collisionText = collision?.status === 'pending' ? '正在检查地形与建筑…' : collision?.status === 'error' ? '拦截检查失败：' + collision.error : obstruction?.blocked ? (obstruction.reason === 'object' ? '⚠ 建筑 / 物体拦截' : '⚠ 地形拦截') : collision?.status === 'ready' ? '当前弧线未检测到拦截' : '';
    for (const card of this.solution.querySelectorAll('[data-art-arc]')) {
      const arcObstruction = collision?.arcs[card.dataset.artArc];
      const status = document.createElement('small');
      status.className = arcObstruction?.blocked ? 'arc-blocked' : 'arc-clear';
      status.textContent = arcObstruction?.blocked ? (arcObstruction.reason === 'object' ? '建筑拦截 · Blocked by structure' : '地形拦截 · Blocked by terrain') : collision?.status === 'ready' ? '弧线无遮挡 · Clear arc' : collisionText;
      card.append(status);
    }
    if (hasHeights && result.selected && !result.correctionUnreachable) {
      this.trajectory = createTrajectory(this.weapon, result.selected, this.points[0], target, originHeight, targetHeight);
      const apex = Math.max(...this.trajectory.map((point, index) => point[2] - originHeight - (targetHeight - originHeight) * index / (this.trajectory.length - 1)));
      this.panel.querySelector('#artillery-apex').textContent = '顶点 ' + Math.round(apex) + ' m';
      this.renderChart(originHeight);
    }
    this.panel.querySelector('#artillery-terrain-note').textContent = !hasHeights ? (this.heightErrors.has(this.mapId) ? '高度加载失败：' + this.heightErrors.get(this.mapId) + '。可重试加载；当前仅提供同高程刻度。' : '正在读取本地游戏高度…') : '炮位 ' + originHeight.toFixed(1) + ' m / 目标 ' + targetHeight.toFixed(1) + ' m。' + (collisionText ? collisionText + '。' : '') + '轨迹可视化不能替代游戏实弹校准。';
    this.metadata = { ...vector, weapon: this.weapon, gun: this.points[0], target, originHeight, targetHeight, selected: result.selected, corrected: result.corrected, status: result.status, blocked: Boolean(obstruction?.blocked), obstruction, collisionStatus: collision?.status, radii: { min: result.weapon.minRange, max: result.weapon.maxRange, effective: result.weapon.effectiveRadius, blast: result.weapon.explosionRadius } };
    const details = document.createElement('p');
    details.className = 'artillery-note';
    details.textContent = compassDirection(vector.bearing) + ' · ' + (vector.range / 1000).toFixed(2) + ' km · 东/西 ' + signed(vector.east) + ' m · 北/南 ' + signed(vector.north) + ' m' + (vector.range > result.weapon.maxRange ? ' · 超出最大射程 ' + Math.round(vector.range - result.weapon.maxRange) + ' m' : vector.range < result.weapon.minRange ? ' · 距最小射程还差 ' + Math.round(result.weapon.minRange - vector.range) + ' m' : '');
    this.solution.append(details);
    this.callbacks.onTrajectory(this.trajectory, this.metadata);
    this.updateViewControls();
    this.updateSight();
  }

  renderChart(originHeight) {
    const chart = this.panel.querySelector('#artillery-chart');
    const ground = this.trajectory.map(point => this.heightAt(point.slice(0, 2)) ?? originHeight);
    const minimum = Math.min(...ground, ...this.trajectory.map(point => point[2]));
    const maximum = Math.max(minimum + 1, ...ground, ...this.trajectory.map(point => point[2]));
    const heightPixel = height => 96 - (height - minimum) / (maximum - minimum) * 80;
    const path = heights => heights.map((height, index) => (index ? 'L' : 'M') + (12 + index / (heights.length - 1) * 276).toFixed(2) + ' ' + heightPixel(height).toFixed(2)).join(' ');
    chart.innerHTML = '<path d="' + path(ground) + ' L288 100 L12 100 Z" fill="#54643d" opacity=".45"/><path d="' + path(ground) + '" fill="none" stroke="#82985b"/><path d="' + path(this.trajectory.map(point => point[2])) + '" fill="none" stroke="#edc079" stroke-width="2"/><text x="12" y="108" fill="#96a183" font-size="8">炮位</text><text x="271" y="108" fill="#96a183" font-size="8">目标</text>';
    chart.hidden = false;
  }

  syncPressedControls() {
    for (const button of this.panel.querySelectorAll('[data-art-point]')) {
      const active = Number(button.dataset.artPoint) === this.nextPoint;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    }
    for (const button of this.viewbar?.querySelectorAll('[data-art-view]') || []) {
      const mode = button.dataset.artView;
      const active = mode === 'sight' ? !this.gunnerSight.element.hidden : mode === 'gun' ? this.nextPoint === 0 : mode === 'target' ? this.nextPoint === 1 : mode === this.cameraMode;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    }
  }

  updateViewControls() {
    const threeDimensional = this.callbacks.dimension() === '3d';
    if (this.viewbar) this.viewbar.hidden = !this.active;
    const usable = Boolean((this.callbacks.sceneReady?.() ?? true) && this.metadata?.gun && this.metadata?.target && Number.isFinite(this.metadata.originHeight) && Number.isFinite(this.metadata.targetHeight));
    for (const button of this.viewbar?.querySelectorAll('[data-art-view]') || []) {
      button.disabled = ['fly', 'walk'].includes(button.dataset.artView) && (!threeDimensional || !(this.callbacks.sceneReady?.() ?? true));
    }
    for (const button of this.panel.querySelectorAll('.artillery-closeups button')) button.disabled = !threeDimensional || !usable;
    if (!threeDimensional) this.setView('orbit');
    this.syncPressedControls();
  }

  setView(mode) {
    if (!['orbit', 'fly', 'walk', 'gun', 'target', 'sight'].includes(mode)) return;
    if (['fly', 'walk'].includes(mode) && !(this.callbacks.sceneReady?.() ?? true)) return;
    if (['gun', 'target'].includes(mode) && (!(this.callbacks.sceneReady?.() ?? true) || this.callbacks.dimension() !== '3d')) return;
    if (['gun', 'target', 'sight'].includes(mode) && !this.metadata?.gun) return;
    this.cameraMode = mode;
    this.gunnerSight.navigationActive = ['fly', 'walk'].includes(mode);
    if (mode === 'sight') this.gunnerSight.show();
    this.syncPressedControls();
    this.callbacks.onView(mode, this.metadata);
    this.updateSight();
  }

  snapshot() { return { weapon: this.weapon, arc: this.arc, arcPinned: this.arcPinned, points: this.points, overrides: this.overrides, correction: this.correction, step: this.step }; }

  applyState(record) {
    if (!validArtilleryState(record)) return false;
    this.weapon = record.weapon; this.arc = record.arc; this.arcPinned = record.arcPinned === true || record.arcPinned === undefined && record.arc === 'high';
    this.points = record.points.map(point => point && [...point]); this.overrides = [...record.overrides];
    this.correction = validCorrection(record.correction) ? { ...record.correction } : { add: 0, right: 0 };
    this.step = [10, 25, 50, 100].includes(record.step) ? record.step : 25;
    this.panel.querySelector('#artillery-step').value = String(this.step);
    this.updateCoordinates(); this.persist(); this.refresh();
    return true;
  }

  updateSight() { this.gunnerSight.update(this.metadata); }

  renderOverlay(overlay, project, dimension, scale) {
    if (!this.active) { overlay.replaceChildren(); this.overlaySignature = ''; return; }
    const metadata = this.metadata;
    const gun = metadata?.gun || this.points[0];
    const target = metadata?.target || this.points[1];
    const markers = [];
    const weapon = weaponById(this.weapon);
    for (const [position, color, title] of [[gun, '#edc079', '炮位'], [target, '#ef708d', '目标']]) {
      if (!position) continue;
      const [horizontal, vertical] = project(position);
      if (!Number.isFinite(horizontal) || !Number.isFinite(vertical) || horizontal < -5000 || vertical < -5000) continue;
      if (position === gun && dimension === '2d') for (const radius of [weapon.minRange, weapon.maxRange]) {
        const screenRadius = radius / (this.callbacks.map().bounds[2] / 100 / 2048) * scale;
        markers.push('<circle cx="' + horizontal + '" cy="' + vertical + '" r="' + screenRadius + '" fill="none" stroke="#edc079" opacity=".26" stroke-dasharray="5 6"/>');
      }
      markers.push('<g class="artillery-draggable" data-art-marker="' + (position === gun ? 0 : 1) + '">');
      markers.push('<circle cx="' + horizontal + '" cy="' + vertical + '" r="10" fill="#161b14" stroke="' + color + '" stroke-width="2"/><circle cx="' + horizontal + '" cy="' + vertical + '" r="3" fill="' + color + '"/><text x="' + (horizontal + 15) + '" y="' + (vertical - 12) + '" fill="' + color + '" font-size="12" stroke="#161b14" stroke-width="3" paint-order="stroke">' + title + '</text></g>');
    }
    if (gun && target && dimension === '2d') {
      const first = project(gun); const second = project(target);
      markers.unshift('<path d="M' + first.join(' ') + ' L' + second.join(' ') + '" fill="none" stroke="' + (metadata?.status === 'in-range' ? '#edc079' : '#ef708d') + '" stroke-width="2" stroke-dasharray="6 5"/>');
    }
    const signature = markers.join('');
    if (signature !== this.overlaySignature) { overlay.innerHTML = signature; this.overlaySignature = signature; }
  }
}
