const colors = ['#d5ed79', '#edc079', '#72b6e8', '#ef708d', '#ffffff'];
const types = ['freehand', 'circle', 'line', 'rectangle', 'area', 'text', 'icon'];
const icons = ['◎', '⚑', '⊕', '△', '□', '✚'];
const escapeText = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const copy = value => JSON.parse(JSON.stringify(value));
const validPoint = point => Array.isArray(point) && point.length === 2 && point.every(value => Number.isFinite(value) && value >= 0 && value <= 2048);

export function createLocalId(prefix) {
  const identifier = globalThis.crypto?.randomUUID?.() || (globalThis.crypto?.getRandomValues ? Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), value => value.toString(16).padStart(2, '0')).join('') : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2));
  return prefix + '-' + identifier;
}

export function validShape(shape) {
  if (!shape || typeof shape.id !== 'string' || !/^shape-[a-z0-9-]{1,100}$/i.test(shape.id) || !['bakurani', 'ozeti', 'zestafona'].includes(shape.mapId) || !types.includes(shape.type) || !colors.includes(shape.color) || ![1, 2, 3, 5, 8].includes(shape.width)) return false;
  if (!Array.isArray(shape.points) || shape.points.length < 1 || shape.points.length > 2048 || !shape.points.every(validPoint)) return false;
  if (['line', 'circle', 'rectangle'].includes(shape.type) && shape.points.length !== 2 || shape.type === 'area' && shape.points.length < 3 || shape.type === 'freehand' && shape.points.length < 2 || ['text', 'icon'].includes(shape.type) && shape.points.length !== 1) return false;
  return typeof shape.text === 'string' && shape.text.length <= 120 && (shape.type !== 'text' || shape.text.trim().length > 0) && (shape.type !== 'icon' || icons.includes(shape.text));
}

export function shapeVertices(shape) {
  if (shape.type === 'circle') {
    const [center, edge] = shape.points;
    const radius = Math.hypot(edge[0] - center[0], edge[1] - center[1]);
    return Array.from({ length: 73 }, (_, index) => [center[0] + Math.cos(index / 72 * Math.PI * 2) * radius, center[1] + Math.sin(index / 72 * Math.PI * 2) * radius]);
  }
  if (shape.type === 'rectangle') { const [start, end] = shape.points; return [start, [end[0], start[1]], end, [start[0], end[1]], start]; }
  if (shape.type === 'area') return [...shape.points, shape.points[0]];
  return shape.points;
}
function segmentDistance(point, start, end) {
  const delta = [end[0] - start[0], end[1] - start[1]];
  const ratio = Math.max(0, Math.min(1, ((point[0] - start[0]) * delta[0] + (point[1] - start[1]) * delta[1]) / (delta[0] ** 2 + delta[1] ** 2 || 1)));
  return Math.hypot(point[0] - start[0] - ratio * delta[0], point[1] - start[1] - ratio * delta[1]);
}

export class TacticalDrawing {
  constructor(workspace, callbacks) {
    this.workspace = workspace; this.callbacks = callbacks; this.mode = 'freehand'; this.color = colors[0]; this.width = 3; this.text = ''; this.symbol = icons[0];
    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.svg.classList.add('tactical-overlay'); this.svg.setAttribute('aria-label', '战术绘图'); callbacks.viewport.append(this.svg);
    this.toolbar = document.createElement('section'); this.toolbar.className = 'workspace-toolbar'; this.toolbar.hidden = true;
    this.toolbar.innerHTML = '<header><strong>战术绘图</strong><button data-draw-close aria-label="关闭绘图工具">×</button></header><div class="drawing-modes">' + [['freehand', '手绘'], ['circle', '圆形'], ['line', '直线'], ['rectangle', '矩形'], ['area', '区域'], ['text', '文字'], ['icon', '图标'], ['move', '移动/改形'], ['erase', '橡皮擦']].map(([mode, label]) => '<button data-draw-mode="' + mode + '" aria-pressed="false">' + label + '</button>').join('') + '</div><div class="drawing-options"><label>颜色<select data-draw-color>' + colors.map(color => '<option value="' + color + '">' + ({ '#d5ed79': '战术绿', '#edc079': '警示橙', '#72b6e8': '情报蓝', '#ef708d': '目标红', '#ffffff': '白色' })[color] + '</option>').join('') + '</select></label><label>线宽<select data-draw-width>' + [1, 2, 3, 5, 8].map(width => '<option ' + (width === 3 ? 'selected' : '') + '>' + width + '</option>').join('') + '</select></label></div><label class="draw-text-label">文字<input data-draw-text maxlength="120" placeholder="输入文字后点击地图"></label><label class="draw-icon-label">图标<select data-draw-icon>' + icons.map(symbol => '<option>' + symbol + '</option>').join('') + '</select></label><footer><button data-draw-undo>撤销</button><button data-draw-redo>重做</button><button data-draw-finish>完成区域</button></footer><p data-draw-note></p>';
    callbacks.viewport.append(this.toolbar);
    this.toolbar.addEventListener('click', event => {
      const button = event.target.closest('button'); if (!button) return;
      if (button.dataset.drawMode) { this.finishArea(); this.mode = button.dataset.drawMode; this.selected = null; this.updateControls(); this.render(); }
      if (button.hasAttribute('data-draw-close')) this.close();
      if (button.hasAttribute('data-draw-undo')) this.undo();
      if (button.hasAttribute('data-draw-redo')) this.redo();
      if (button.hasAttribute('data-draw-finish')) this.finishArea();
    });
    this.toolbar.querySelector('[data-draw-color]').addEventListener('change', event => { this.color = event.target.value; });
    this.toolbar.querySelector('[data-draw-width]').addEventListener('change', event => { this.width = Number(event.target.value); });
    this.toolbar.querySelector('[data-draw-text]').addEventListener('input', event => { this.text = event.target.value; });
    this.toolbar.querySelector('[data-draw-icon]').addEventListener('change', event => { this.symbol = event.target.value; });
    for (const name of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) callbacks.viewport.addEventListener(name, event => this.pointer(name, event), { capture: true });
    document.addEventListener('keydown', event => {
      if (!this.active || event.target.closest('input,textarea,select') || document.querySelector('dialog[open]')) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); this.draft = null; this.close(); }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); event.stopImmediatePropagation(); event.shiftKey ? this.redo() : this.undo(); }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') { event.preventDefault(); event.stopImmediatePropagation(); this.redo(); }
      if (event.key === 'Enter') this.finishArea();
      if (event.key === 'Delete' && this.selected) this.remove(this.selected);
    }, { capture: true });
    this.resetHistory(); this.updateControls();
  }
  get active() { return this.callbacks.state().tool === 'drawing'; }
  resetHistory() { this.cancelGesture(); this.selected = null; this.history = [copy(this.workspace.record.shapes)]; this.historyIndex = 0; this.updateControls(); }
  open() { this.callbacks.activate('drawing'); this.toolbar.hidden = false; this.updateControls(); }
  close() { this.cancelGesture(); this.selected = null; this.toolbar.hidden = true; if (this.active) this.callbacks.activate(null); this.render(); }
  releasePointer() { if (this.pointerId != null && this.callbacks.viewport.hasPointerCapture(this.pointerId)) this.callbacks.viewport.releasePointerCapture(this.pointerId); this.pointerId = null; }
  cancelGesture() { if (this.gesture?.original) Object.assign(this.gesture.shape, this.gesture.original); this.gesture = null; this.draft = null; this.releasePointer(); }
  updateControls() {
    if (!this.toolbar) return;
    this.toolbar.querySelector('[data-draw-undo]').disabled = this.historyIndex <= 0;
    this.toolbar.querySelector('[data-draw-redo]').disabled = this.historyIndex >= this.history.length - 1;
    this.toolbar.querySelector('[data-draw-finish]').hidden = this.mode !== 'area';
    this.toolbar.querySelector('.draw-text-label').hidden = this.mode !== 'text';
    this.toolbar.querySelector('.draw-icon-label').hidden = this.mode !== 'icon';
    for (const button of this.toolbar.querySelectorAll('[data-draw-mode]')) button.setAttribute('aria-pressed', String(button.dataset.drawMode === this.mode));
    this.toolbar.querySelector('[data-draw-note]').textContent = this.mode === 'area' ? '点击添加顶点 · Enter 完成 · Esc 退出' : this.mode === 'move' ? '拖动图形移动；选中后拖动节点改形 · Delete 删除' : this.mode === 'text' || this.mode === 'icon' ? '点击地图放置 · Ctrl+Z 撤销' : '在地图按住并拖动 · Ctrl+Z 撤销';
  }
  commit() {
    this.history.splice(this.historyIndex + 1); this.history.push(copy(this.workspace.record.shapes));
    if (this.history.length > 40) this.history.shift(); this.historyIndex = this.history.length - 1;
    this.workspace.save(); this.updateControls();
  }
  undo() { if (this.historyIndex > 0) { this.workspace.record.shapes = copy(this.history[--this.historyIndex]); this.selected = null; this.workspace.save(); this.updateControls(); } }
  redo() { if (this.historyIndex < this.history.length - 1) { this.workspace.record.shapes = copy(this.history[++this.historyIndex]); this.workspace.save(); this.updateControls(); } }
  remove(identifier) { this.workspace.record.shapes = this.workspace.record.shapes.filter(shape => shape.id !== identifier); this.selected = null; this.commit(); }
  create(point) { return { id: createLocalId('shape'), mapId: this.callbacks.map().id, type: this.mode, color: this.color, width: this.width, points: [point], text: this.mode === 'text' ? this.text.trim() : this.mode === 'icon' ? this.symbol : '' }; }
  add(shape) { if (this.workspace.record.shapes.length >= 500) { this.callbacks.notify('最多保存 500 条战术绘图。'); return; } if (validShape(shape)) { this.workspace.record.shapes.push(shape); this.commit(); } }
  finishArea() { if (this.draft?.type === 'area') { this.add(this.draft); this.draft = null; this.render(); } }
  hit(point) {
    const candidates = this.workspace.record.shapes.filter(shape => shape.mapId === this.callbacks.map().id).reverse();
    for (const shape of candidates) {
      const points = shapeVertices(shape).map(this.callbacks.project);
      if (points.length === 1 && Math.hypot(point[0] - points[0][0], point[1] - points[0][1]) < 30) return shape;
      for (let index = 1; index < points.length; index++) if (segmentDistance(point, points[index - 1], points[index]) < 12) return shape;
    }
    return null;
  }
  pointer(name, event) {
    const control = event.target.closest('button');
    if (!this.active || control && !control.classList.contains('map-marker') || event.target.closest('input,select,textarea,.workspace-toolbar,.point-popup,.model-inspector,.artillery-sight')) return;
    if (name === 'pointerdown' && event.button !== 0) return;
    event.stopImmediatePropagation();
    if (this.pointerId != null && this.pointerId !== event.pointerId) return;
    if (name === 'pointercancel') { this.cancelGesture(); this.render(); return; }
    const point = this.callbacks.mapPosition(event.clientX, event.clientY);
    if (!point || !validPoint(point)) { if (name === 'pointerup') { this.cancelGesture(); this.render(); } return; }
    if (name === 'pointerdown') {
      this.pointerId = event.pointerId;
      this.callbacks.viewport.setPointerCapture(event.pointerId);
      if (this.mode === 'move' || this.mode === 'erase') {
        const rectangle = this.callbacks.viewport.getBoundingClientRect(); const screen = [event.clientX - rectangle.left, event.clientY - rectangle.top];
        const current = this.workspace.record.shapes.find(shape => shape.id === this.selected);
        const vertex = current?.points.findIndex(position => { const projected = this.callbacks.project(position); return Math.hypot(screen[0] - projected[0], screen[1] - projected[1]) < 12; });
        const shape = vertex >= 0 ? current : this.hit(screen);
        this.selected = shape?.id || null;
        if (shape && this.mode === 'erase') this.remove(shape.id);
        else if (shape) this.gesture = { shape, original: copy(shape), start: point, vertex: vertex >= 0 ? vertex : -1 };
      } else if (this.mode === 'area') { if (!this.draft) this.draft = this.create(point); else if (this.draft.points.length < 2048) this.draft.points.push(point); }
      else if (this.mode === 'text' || this.mode === 'icon') { const shape = this.create(point); if (!validShape(shape)) this.callbacks.notify('请先输入文字。'); else this.add(shape); }
      else { this.draft = this.create(point); this.draft.points.push([...point]); this.gesture = { start: point }; }
      this.render();
    } else if (name === 'pointermove' && this.gesture) {
      if (this.gesture.shape) {
        const { shape, original, start, vertex } = this.gesture;
        if (vertex >= 0) shape.points[vertex] = point;
        else {
          const minimum = [0, 1].map(axis => Math.min(...original.points.map(position => position[axis])));
          const maximum = [0, 1].map(axis => Math.max(...original.points.map(position => position[axis])));
          const delta = point.map((value, axis) => Math.max(-minimum[axis], Math.min(2048 - maximum[axis], value - start[axis])));
          shape.points = original.points.map(position => position.map((value, axis) => value + delta[axis]));
        }
      } else if (this.draft) {
        if (this.mode === 'freehand') { if (this.draft.points.length < 2048 && Math.hypot(...point.map((value, axis) => value - this.draft.points.at(-1)[axis])) > .5) this.draft.points.push(point); }
        else this.draft.points[1] = point;
      }
      this.render();
    } else if (name === 'pointerup') {
      if (this.gesture?.shape) this.commit();
      else if (this.gesture && this.draft) { if (Math.hypot(...point.map((value, axis) => value - this.gesture.start[axis])) > .2) this.add(this.draft); this.draft = null; }
      this.gesture = null; this.render();
      this.releasePointer();
    }
  }
  render() {
    const mapId = this.callbacks.map().id;
    const shapes = this.workspace.record.shapes.filter(shape => shape.mapId === mapId).concat(this.draft ? [this.draft] : []);
    const markup = shapes.map(shape => {
      const points = shapeVertices(shape).map(this.callbacks.project);
      const selected = shape.id === this.selected;
      let result = '<g data-shape="' + shape.id + '" stroke="' + shape.color + '" stroke-width="' + shape.width + '" stroke-linecap="round" stroke-linejoin="round">';
      if (shape.type === 'text' || shape.type === 'icon') result += '<text x="' + points[0][0] + '" y="' + points[0][1] + '" fill="' + shape.color + '" font-size="' + (shape.type === 'icon' ? 28 : 16) + '" stroke="#141911" stroke-width="3" paint-order="stroke" text-anchor="middle">' + escapeText(shape.text) + '</text>';
      else result += '<path d="' + points.map((position, index) => (index ? 'L' : 'M') + position.map(value => value.toFixed(1)).join(' ')).join(' ') + '" fill="' + (['area', 'rectangle', 'circle'].includes(shape.type) ? shape.color : 'none') + '" fill-opacity=".12"/>';
      if (selected && this.active && this.mode === 'move') result += shape.points.map(position => { const projected = this.callbacks.project(position); return '<circle cx="' + projected[0] + '" cy="' + projected[1] + '" r="6" fill="#20271c" stroke="#fff" stroke-width="2"/>'; }).join('');
      return result + '</g>';
    }).join('');
    if (this.signature !== markup) { this.svg.innerHTML = markup; this.signature = markup; }
    this.toolbar.hidden = !this.active;
  }
}
