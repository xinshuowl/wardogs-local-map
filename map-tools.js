const escapeText = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
export class MapTools {
  constructor(workspace, callbacks) {
    this.workspace = workspace; this.callbacks = callbacks;
    this.panel = document.createElement('section'); this.panel.className = 'workspace-filters';
    this.panel.innerHTML = '<h3>地点与筛选</h3><label class="setting-row"><span>隐藏已找到地点</span><input type="checkbox" data-hide-found></label><label class="setting-slider">标记大小 <span data-marker-size-value></span><input aria-label="标记大小" type="range" min="50" max="200" step="10" data-marker-size></label><p data-found-summary></p><details><summary>已隐藏的地点</summary><div data-hidden-list></div></details><div data-area-filters></div><h3>命名筛选预设</h3><form data-filter-form><input data-filter-name maxlength="64" required placeholder="例如：补给与车辆" aria-label="筛选预设名称"><button type="submit">保存</button></form><div data-filter-presets></div><button class="workspace-wide" data-workspace-share>⧉ 分享地图、绘图与筛选</button><h3>本地小队共享</h3><p>同一 Node 服务器内实时同步绘图。独立于 MetaForge 云账号，不上传到外站。</p><form data-room-form><input data-room-name placeholder="房间名，例如 alpha-1" pattern="[A-Za-z0-9-]{3,40}" minlength="3" maxlength="40" required aria-label="小队房间名"><button type="submit">加入</button></form><p data-room-status>未连接 · 仅保存在本机</p><div class="room-actions"><button data-room-seed disabled>共享本机绘图</button><button data-room-leave>离开</button></div>';
    document.getElementById('layers-panel').append(this.panel);
    const controls = document.createElement('div'); controls.className = 'workspace-buttons';
    controls.innerHTML = '<button data-open-drawing title="战术绘图" aria-label="打开战术绘图">✎<span>绘图</span></button><button data-open-share title="复制地图分享链接" aria-label="分享地图">⧉<span>分享</span></button>';
    callbacks.viewport.append(controls);
    controls.querySelector('[data-open-drawing]').addEventListener('click', () => workspace.drawing.open());
    controls.querySelector('[data-open-share]').addEventListener('click', () => workspace.share(callbacks.artillery()?.active ? callbacks.artillery().snapshot() : null));
    this.panel.querySelector('[data-hide-found]').checked = workspace.record.hideFound;
    this.panel.querySelector('[data-marker-size]').value = String(workspace.record.markerSize * 100);
    this.panel.addEventListener('change', event => {
      const field = event.target;
      if (field.hasAttribute('data-hide-found')) workspace.record.hideFound = field.checked;
      if (field.hasAttribute('data-area-layer')) { callbacks.state().settings.areaLayers ||= {}; callbacks.state().settings.areaLayers[field.dataset.areaLayer] = field.checked; callbacks.persist(); }
      workspace.save(false); this.refreshStatus();
    });
    this.panel.querySelector('[data-marker-size]').addEventListener('input', event => { workspace.record.markerSize = Number(event.target.value) / 100; workspace.save(false); this.refreshStatus(); });
    this.panel.querySelector('[data-filter-form]').addEventListener('submit', event => {
      event.preventDefault(); const field = this.panel.querySelector('[data-filter-name]'); const name = field.value.trim(); if (!name) return;
      if (workspace.record.presets.length >= 100) { callbacks.notify('最多保存 100 个筛选预设。'); return; }
      const state = callbacks.state(); workspace.record.presets.push({ id: createLocalId('filter'), name, layers: { ...state.layers }, areaLayers: { ...state.settings.areaLayers }, hideFound: workspace.record.hideFound });
      field.value = ''; workspace.save(false); this.renderPresets();
    });
    this.panel.addEventListener('click', event => {
      const button = event.target.closest('button'); if (!button) return;
      if (button.dataset.filterLoad) { const preset = workspace.record.presets.find(record => record.id === button.dataset.filterLoad); if (!preset) return; const state = callbacks.state(); for (const name of Object.keys(state.layers)) if (typeof preset.layers[name] === 'boolean') state.layers[name] = preset.layers[name]; state.settings.areaLayers = { ...preset.areaLayers }; workspace.record.hideFound = preset.hideFound === true; callbacks.persist(); callbacks.rebuildLayers(); workspace.save(false); this.refreshStatus(); }
      if (button.dataset.filterDelete) { workspace.record.presets = workspace.record.presets.filter(preset => preset.id !== button.dataset.filterDelete); workspace.save(false); this.renderPresets(); }
      if (button.dataset.restorePoint) { workspace.record.hidden = workspace.record.hidden.filter(key => key !== button.dataset.restorePoint); workspace.save(false); this.refreshStatus(); }
      if (button.hasAttribute('data-workspace-share')) workspace.share(callbacks.artillery()?.active ? callbacks.artillery().snapshot() : null);
      if (button.hasAttribute('data-room-leave')) workspace.leave();
      if (button.hasAttribute('data-room-seed')) workspace.seedRoom();
    });
    this.panel.querySelector('[data-room-form]').addEventListener('submit', async event => { event.preventDefault(); try { await workspace.join(this.panel.querySelector('[data-room-name]').value); } catch (error) { callbacks.notify(error.message); this.roomStatus('未连接 · ' + error.message); } });
    this.renderPresets(); this.refreshStatus();
  }
  refreshStatus() {
    const workspace = this.workspace;
    this.panel.querySelector('[data-marker-size]').value = String(workspace.record.markerSize * 100);
    this.panel.querySelector('[data-marker-size-value]').textContent = Math.round(workspace.record.markerSize * 100) + '%';
    this.panel.querySelector('[data-hide-found]').checked = workspace.record.hideFound;
    const map = this.callbacks.map();
    this.panel.querySelector('[data-found-summary]').textContent = '本地图已找到 ' + workspace.record.found.filter(key => key.startsWith(map.id + ':')).length + ' 个地点';
    this.panel.querySelector('[data-hidden-list]').innerHTML = workspace.record.hidden.filter(key => key.startsWith(map.id + ':')).map(key => { const point = map.points.find(point => key === map.id + ':' + point.id); return '<button class="workspace-wide" data-restore-point="' + key + '">' + escapeText(point?.name || key) + ' · 恢复显示</button>'; }).join('') || '<p>没有单独隐藏的地点</p>';
    const groups = [...new Set(map.zones.map(zone => zone.kind))];
    this.panel.querySelector('[data-area-filters]').innerHTML = '<h3>区域多边形 · 独立于地点标签</h3>' + groups.map(kind => '<label class="setting-row"><span>' + escapeText(this.callbacks.kinds[kind]?.name || kind) + '区域</span><input data-area-layer="' + kind + '" aria-label="' + escapeText(this.callbacks.kinds[kind]?.name || kind) + '区域" type="checkbox"' + (this.callbacks.state().settings.areaLayers?.[kind] !== false ? ' checked' : '') + '></label>').join('');
  }
  renderPresets() {
    this.panel.querySelector('[data-filter-presets]').innerHTML = this.workspace.record.presets.map(preset => '<div class="filter-preset"><button data-filter-load="' + preset.id + '">' + escapeText(preset.name) + '</button><button data-filter-delete="' + preset.id + '" aria-label="删除筛选预设 ' + escapeText(preset.name) + '">×</button></div>').join('') || '<p>尚未保存筛选预设</p>';
  }
  roomStatus(text) { this.panel.querySelector('[data-room-status]').textContent = text; this.panel.querySelector('[data-room-seed]').disabled = !this.workspace.connected; }
  showShare(url) {
    const dialog = document.createElement('dialog'); dialog.className = 'quick-guide-dialog'; dialog.innerHTML = '<h2>复制完整分享链接</h2><textarea aria-label="地图分享链接" readonly rows="5"></textarea><button>关闭</button>'; dialog.querySelector('textarea').value = url; dialog.querySelector('button').addEventListener('click', () => { dialog.close(); dialog.remove(); }); document.body.append(dialog); dialog.showModal(); dialog.querySelector('textarea').select();
  }
}
import { createLocalId } from './tactical-drawing.js';

