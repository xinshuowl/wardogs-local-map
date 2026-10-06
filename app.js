(async () => {
  'use strict';

  const maps = window.WARDOGS_MAPS;
  const element = identifier => document.getElementById(identifier);
  const icon = name => '<svg class="icon" aria-hidden="true"><use href="#i-' + name + '"/></svg>';
  const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
  const storageKey = 'wardogs-local-atlas:v1';
  const pinColors = ['#d5ed79', '#72b6e8', '#edc079'];
  const kinds = {
    towers: { name: '控制塔', icon: 'tower', color: '#d5ed79', description: '可争夺的控制塔。与当前控制战区是否相交，请以游戏内任务状态为准。' },
    inactive: { name: '废弃控制塔', icon: 'tower', color: '#a3ab99', description: '非活跃控制塔，不是当前可占领的塔目标。' },
    control: { name: '控制战区', icon: 'target', color: '#d5ed79' },
    spawn: { name: '阵营出生点', icon: 'pin', color: '#82b4cc', description: '阵营出生位置。此地图不包含实时玩家信息。' },
    'safe-zone': { name: '安全区', icon: 'shield', color: '#8cbbc5', description: '基地安全区域的位置。' },
    vendor: { name: '车库商人', icon: 'garage', color: '#ddbb7d', description: '车库商人位置，可用于规划载具补给。' },
    'vehicle-board': { name: '载具部署', icon: 'car', color: '#b3a5c7', description: '载具部署面板位置。' },
    fuel: { name: '燃油补给', icon: 'fuel', color: '#dab883', description: '燃油补给设施。' },
    ladder: { name: '梯子', icon: 'ladder', color: '#a8b298', description: '可攀爬梯子的位置，协助识别垂直通行路线。' },
    'barbed-wire': { name: '铁丝网', icon: 'wire', color: '#acac96', description: '铁丝网障碍的位置，规划通行路线时可作为参考。' },
    settlements: { name: '城镇与村庄', icon: 'town', color: '#c8d0b8', description: '游戏中的聚落区域。地点名称保留原文，便于小队沟通。' },
    industry: { name: '工业与基础设施', icon: 'factory', color: '#c6b98b', description: '工业与基础设施区域。地点名称保留游戏原文。' },
    terrain: { name: '地形与地标', icon: 'mountain', color: '#9cad84', description: '地形与地标区域，可作为方向参照。' },
    boundaries: { name: '区域边界', icon: 'layers', color: '#9fae87' },
    personal: { name: '个人标记', icon: 'pin', color: '#c5adce' }
  };
  const layerGroups = [
    { name: '作战目标', keys: ['towers', 'inactive', 'control'] },
    { name: '战场设施', keys: ['spawn', 'safe-zone', 'vehicle-board', 'vendor', 'fuel', 'ladder', 'barbed-wire'] },
    { name: '地域与地貌', keys: ['settlements', 'industry', 'terrain', 'boundaries'] },
    { name: '个人情报', keys: ['personal'] }
  ];
  const defaultLayers = { towers: true, inactive: false, control: true, spawn: true, 'safe-zone': false, 'vehicle-board': true, vendor: false, fuel: false, ladder: false, 'barbed-wire': false, settlements: true, industry: true, terrain: false, boundaries: true, personal: true };
  const factions = [{ name: '中立视图', color: '#d5ed79' }, { name: 'Lonestar', color: '#72b6e8' }, { name: 'Valkyra', color: '#eb806c' }, { name: 'Manticore', color: '#7bbe8c' }];
  const viewport = element('map-viewport');
  const world = element('map-world');
  const markerContainer = element('map-markers');
  const popup = element('point-popup');
  let toastTimer;
  let backupUrl;

  function notify(message) {
    clearTimeout(toastTimer);
    element('toast').textContent = message;
    element('toast').hidden = false;
    toastTimer = setTimeout(() => { element('toast').hidden = true; }, 3000);
  }

  if (!maps || !Object.keys(maps).length) {
    element('map-loading').hidden = true;
    element('map-error').hidden = false;
    return;
  }

  function validPin(pin) {
    return pin && typeof pin.id === 'string' && /^pin-[a-z0-9-]+$/i.test(pin.id) && pin.id.length < 100 && Object.hasOwn(maps, pin.mapId) && typeof pin.name === 'string' && pin.name.trim().length > 0 && pin.name.length <= 64 && Array.isArray(pin.position) && pin.position.length === 2 && pin.position.every(coordinate => Number.isFinite(coordinate) && coordinate >= 0 && coordinate <= 2048) && pinColors.includes(pin.color) && (pin.note === undefined || typeof pin.note === 'string' && pin.note.length <= 300);
  }

  function validBookmark(key) {
    if (typeof key !== 'string') return false;
    return Object.values(maps).some(map => map.points.some(point => key === map.id + ':' + point.id));
  }

  let stored = {};
  try {
    const parsed = JSON.parse(localStorage.getItem(storageKey) || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) stored = parsed;
  } catch {
    stored = {};
  }
  const storedLayers = Object.fromEntries(Object.keys(defaultLayers).map(key => [key, typeof stored.layers?.[key] === 'boolean' ? stored.layers[key] : defaultLayers[key]]));
  const settings = { grid: stored.settings?.grid !== false, labels: stored.settings?.labels !== false, zones: stored.settings?.zones !== false, brightness: Number.isFinite(stored.settings?.brightness) ? clamp(stored.settings.brightness, 45, 115) : 60, view: stored.settings?.view === 'satellite' ? 'satellite' : 'tactical' };
  settings.quality = ['auto', 'low', 'balanced', 'high'].includes(stored.settings?.quality) ? stored.settings.quality : 'auto';
  settings.modelLoading = stored.settings?.modelLoading === 'preload' ? 'preload' : 'stream';
  settings.areaLayers = Object.fromEntries(Object.keys(defaultLayers).map(kind => [kind, stored.settings?.areaLayers?.[kind] !== false]));
  settings.shadows = stored.settings?.shadows !== false;
  settings.collision = stored.settings?.collision !== false;
  settings.models = Object.fromEntries(['buildings', 'trees', 'props'].map(category => [category, stored.settings?.models?.[category] !== false]));
  const startupDimension = location.protocol === 'file:' || stored.dimension === '2d' ? '2d' : '3d';
  const state = { dimension: '2d', heightFactor: Number.isFinite(stored.heightFactor) ? clamp(stored.heightFactor, 1, 3) : 1, mapId: 'bakurani', layers: storedLayers, settings, pins: Array.isArray(stored.pins) ? stored.pins.filter(validPin).slice(0, 500) : [], bookmarks: new Set(Array.isArray(stored.bookmarks) ? stored.bookmarks.filter(validBookmark) : []), tab: 'layers', tool: null, drawing: [], drawingMode: 'measure', hover: null, selected: null, faction: Number.isInteger(stored.faction) && stored.faction >= 0 && stored.faction < 4 ? stored.faction : 0, control: 0, scale: 3.4, pan: [0, 0], width: viewport.clientWidth, height: viewport.clientHeight };
  if (Object.values(settings.models).some(Boolean)) state.heightFactor = 1;
  let currentMap;
  let terrainView = null;
  let terrainModulePromise = null;
  let terrainRequest = 0;
  let pendingTerrainFocus = null;
  let markerEntries = [];
  let renderQueued = false;
  let pendingPin = null;
  let editingPin = null;
  let inspectedModel = null;
  let artillery = null;
  let workspace = null;
  let workspaceModule = null;
  let artilleryModule = null;
  let artilleryRequest = 0;
  let sharedRequest = 0;
  const performanceReports = [];
  let activePointer = null;
  let pinch = null;
  const pointers = new Map();

  function persist() {
    try {
      localStorage.setItem(storageKey, JSON.stringify({ version: 1, mapId: state.mapId, dimension: state.dimension, heightFactor: state.heightFactor, layers: state.layers, settings: state.settings, pins: state.pins, bookmarks: [...state.bookmarks], faction: state.faction, control: state.control }));
    } catch {
      notify('浏览器未允许保存记录，请导出备份以免丢失。');
    }
  }

  function allPoints() {
    return currentMap.points.concat(state.pins.filter(pin => pin.mapId === state.mapId).map(pin => ({ ...pin, kind: 'personal', label: false })));
  }

  function pointCoordinates(position) {
    const span = currentMap.bounds[2];
    return { x: position[0] / 2048 * span / 10000, y: (2048 - position[1]) / 2048 * span / 10000 };
  }

  function coordinatesText(position) {
    const coordinates = pointCoordinates(position);
    return 'X ' + coordinates.x.toFixed(2) + ' · Y ' + coordinates.y.toFixed(2);
  }

  function screenPosition(position) {
    if (state.dimension === '3d') return terrainReady() ? terrainView.project(position) : [-100000, -100000];
    return [state.pan[0] + position[0] * state.scale, state.pan[1] + position[1] * state.scale];
  }

  function mapPosition(clientX, clientY) {
    if (state.dimension === '3d') return terrainReady() ? terrainView.pick(clientX, clientY) || [-1, -1] : [-1, -1];
    const rectangle = viewport.getBoundingClientRect();
    return [(clientX - rectangle.left - state.pan[0]) / state.scale, (clientY - rectangle.top - state.pan[1]) / state.scale];
  }

  function clampPan() {
    const size = 2048 * state.scale;
    state.pan[0] = size < state.width ? (state.width - size) / 2 : clamp(state.pan[0], state.width - size, 0);
    state.pan[1] = size < state.height ? (state.height - size) / 2 : clamp(state.pan[1], state.height - size, 0);
  }

  function fitArtillery(points, trajectory) {
    if (!points.length) return;
    artillery?.setView('orbit');
    if (state.dimension === '3d') {
      if (terrainReady()) terrainView.fitArtillery(points, trajectory);
      else pendingTerrainFocus = [...points[0]];
      return;
    }
    const horizontal = points.map(point => point[0]);
    const vertical = points.map(point => point[1]);
    const width = Math.max(...horizontal) - Math.min(...horizontal);
    const height = Math.max(...vertical) - Math.min(...vertical);
    const scale = clamp(Math.min((state.width - 110) / Math.max(40, width * 1.4), (state.height - 170) / Math.max(40, height * 1.4)), .08, 8);
    centerOn([(Math.min(...horizontal) + Math.max(...horizontal)) / 2, (Math.min(...vertical) + Math.max(...vertical)) / 2], scale);
  }

  function centerOn(position, scale = state.scale) {
    if (state.dimension === '3d') {
      pendingTerrainFocus = [...position];
      if (terrainReady()) { terrainView.focus(position); pendingTerrainFocus = null; }
      scheduleRender();
      return;
    }
    state.scale = scale;
    state.pan = [state.width / 2 - position[0] * scale, state.height / 2 - position[1] * scale];
    clampPan();
    scheduleRender();
  }

  function zoom(factor, anchor = [state.width / 2, state.height / 2]) {
    if (state.dimension === '3d') { if (terrainReady()) terrainView.zoom(factor); return; }
    const nextScale = clamp(state.scale * factor, Math.min(state.width, state.height) / 2048 * .6, 8);
    const position = [(anchor[0] - state.pan[0]) / state.scale, (anchor[1] - state.pan[1]) / state.scale];
    state.scale = nextScale;
    state.pan = [anchor[0] - position[0] * nextScale, anchor[1] - position[1] * nextScale];
    clampPan();
    scheduleRender();
  }

  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; render(); });
  }

  function terrainReady() {
    return Boolean(terrainView?.ready && terrainView.map?.id === state.mapId);
  }

  function updateModelControls() {
    const enabled = Object.values(state.settings.models).some(Boolean);
    if (enabled && state.heightFactor !== 1) { state.heightFactor = 1; terrainView?.setHeightFactor(1); }
    for (const [category, visible] of Object.entries(state.settings.models)) element('models-' + category).checked = visible;
    element('height-factor').disabled = enabled;
    element('height-factor').value = state.heightFactor;
    element('height-factor-value').textContent = state.heightFactor + '× · ' + (state.heightFactor === 1 ? '实际比例' : '显示放大');
    element('height-note').textContent = enabled ? '模型使用实际比例；关闭模型可放大起伏' : '仅地形模式 · 可调整起伏显示比例';
    document.querySelector('[data-action="model-closeup"]').disabled = !enabled;
  }

  function updateDimensionControls() {
    const threeDimensional = state.dimension === '3d';
    viewport.dataset.dimension = state.dimension;
    viewport.setAttribute('aria-label', threeDimensional ? '可交互真实三维地形，拖动旋转，右键或双指平移，滚轮缩放' : '可交互战术地图，拖动平移，滚轮缩放，方向键移动');
    element('terrain-view').hidden = !threeDimensional;
    element('terrain-tools').hidden = !threeDimensional;
    element('dimension-badge').textContent = threeDimensional ? '3D MAP' : '2D MAP';
    element('gesture-hint').textContent = threeDimensional ? '拖动旋转 · 右键平移 · 滚轮缩放' : '拖动平移 · 滚轮缩放';
    document.querySelectorAll('[data-dimension]').forEach(button => {
      if (button.tagName !== 'BUTTON') return;
      const active = button.dataset.dimension === state.dimension;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    element('height-factor').value = state.heightFactor;
    element('height-factor-value').textContent = state.heightFactor + '× · ' + (state.heightFactor === 1 ? '实际比例' : '显示放大');
    updateModelControls();
    terrainView?.setActive(threeDimensional);
    if (!threeDimensional) artillery?.setView('orbit');
    artillery?.updateViewControls();
    if (!threeDimensional && artillery?.active) requestAnimationFrame(() => { if (state.dimension === '2d' && artillery?.active) fitArtillery(artillery.metadata ? [artillery.metadata.gun, artillery.metadata.target] : artillery.points.filter(Boolean), null); });
    if (!threeDimensional) {
      element('model-inspector').hidden = true;
      element('benchmark-button').disabled = false;
      element('benchmark-button').textContent = '测量 10 秒';
      if (terrainView) terrainView.performance.benchmark = null;
    }
    if (!threeDimensional) {
      element('terrain-loading').hidden = true;
      document.querySelector('.compass').style.transform = '';
    }
  }

  async function loadTerrain(map) {
    const request = ++terrainRequest;
    element('terrain-loading').hidden = false;
    try {
      if (!terrainView) {
        terrainModulePromise ||= import('./terrain-view.js');
        const { TerrainView } = await terrainModulePromise;
        if (request !== terrainRequest || state.dimension !== '3d') return;
        terrainView = new TerrainView(element('terrain-view'), {
          onChange: () => { if (state.dimension === '3d') scheduleRender(); },
          onClick: (position, shiftKey) => handleMapClick(position, shiftKey),
          onHover: (position, height) => {
            if (state.dimension !== '3d') return;
            state.hover = position;
            if (position) {
              element('coordinates').textContent = coordinatesText(position);
              element('terrain-elevation').textContent = '地面高程 ' + height.toFixed(1) + ' m · 游戏高度';
            }
            if (state.tool === 'measure' || state.tool === 'route') scheduleRender();
          },
          isToolActive: () => Boolean(state.tool),
          isArtilleryActive: () => state.tool === 'artillery',
          onModels: status => {
            if (state.dimension !== '3d') return;
            const display = element('model-status');
            display.dataset.state = status.state;
            const count = status.instances.toLocaleString('zh-CN');
            display.textContent = status.state === 'error' ? '模型资源未加载 · 地形仍可用' : status.state === 'off' ? '独立模型已关闭' : status.state === 'overview' ? '全图概览 · 拉近查看模型' : status.state === 'partial' ? '部分模型资源缺失 · ' + count + ' 个部件' : status.state === 'loading' ? '正在加载模型 · ' + count + ' 个部件' : '3D 场景常驻 · ' + count + ' 个模型部件';
            display.title = status.error || '建筑 ' + status.counts.buildings + ' · 植被 ' + status.counts.trees + ' · 道具 ' + status.counts.props + '（已显示模型留在场景，远处保留简模）';
            element('retry-models').hidden = !['partial', 'error'].includes(status.state) && status.preload?.state !== 'partial';
            const preload = status.preload;
            const loadingText = status.loading !== 'preload' ? '按需加载 · ' + status.tiles + ' 个区块已缓存 · 已显示模型常驻 3D 场景' : preload?.state === 'ready' ? (status.preparing ? '整图资源已缓存 · 画面准备中 ' + status.preparing + ' 项' : '整图预载完成 · ' + status.tiles + ' 个区块 · 已显示模型常驻 3D 场景') : preload?.state === 'partial' ? '整图预载部分失败 · 可重试模型加载' : '整图预载 ' + (preload?.completed || 0) + ' / ' + (preload?.total || 0) + ' · 当前视野优先';
            for (const identifier of ['model-preload-status', 'navigation-model-status']) element(identifier).textContent = loadingText;
          },
          onInspect: info => {
            inspectedModel = info;
            element('model-inspector').hidden = !info;
            if (!info) return;
            popup.hidden = true;
            element('inspected-model-name').textContent = info.name;
            element('inspected-model-detail').textContent = 'LOD' + info.lod + ' · 表面高程 ' + info.height.toFixed(2) + ' m · 离地 ' + (info.height - info.ground).toFixed(2) + ' m';
          },
          onPerformance: report => {
            element('navigation-statistics').textContent = ({ low: '流畅', balanced: '均衡', high: '高清' })[report.quality] + ' · ' + (report.fps ? report.fps.toFixed(1) + ' FPS' : '等待采样') + ' · ' + report.draws + ' 次绘制';
            element('navigation-benchmark-button').disabled = report.benchmarking;
            element('navigation-benchmark-button').textContent = report.benchmarking ? '测量中…' : '测量导航 10 秒';
            element('scene-statistics').textContent = ({ low: '流畅', balanced: '均衡', high: '高清' })[report.quality] + ' · 交互 ' + (report.fps ? report.fps.toFixed(1) + ' FPS' : '等待采样') + ' · ' + Math.round(report.triangles / 1000).toLocaleString() + 'k 三角形 · ' + report.draws + ' 次绘制 · ' + report.textures + ' 纹理';
          },
          onBenchmark: report => {
            performanceReports.push(report);
            if (performanceReports.length > 20) performanceReports.shift();
            element('benchmark-button').disabled = false;
            element('benchmark-button').textContent = '测量 10 秒';
            element('benchmark-result').textContent = '上次测量：' + report.map + ' / ' + report.quality + ' · ' + report.fps + ' FPS · P95 ' + report.p95FrameMs + ' ms';
            element('navigation-benchmark-button').disabled = false;
            element('navigation-benchmark-button').textContent = '测量导航 10 秒';
            element('navigation-benchmark-result').textContent = report.mode + ' · ' + report.fps + ' FPS · P95 ' + report.p95FrameMs + ' ms · CPU ' + (report.cpuMs.total || 0).toFixed(1) + ' ms/帧';
            element('navigation-benchmark-result').dataset.report = JSON.stringify(report);
            notify('本机测量：' + report.fps + ' FPS · P95 ' + report.p95FrameMs + ' ms');
          },
          onHeightDetail: () => { if (artillery?.active) artillery.refresh(); },
          onArtilleryError: notify,
          onContextLost: () => { element('terrain-loading').hidden = false; element('terrain-loading').querySelector('div').firstChild.textContent = '正在恢复三维图形'; notify('显卡上下文已丢失，正在自动恢复 3D 场景。'); },
          onContextRestored: () => { element('terrain-loading').hidden = true; notify('3D 场景已恢复，地图位置与炮兵数据已保留。'); scheduleRender(); },
          onError: message => { setDimension('2d'); notify(message); }
        });
      }
      terrainView.setActive(true);
      if (!terrainReady() && !await terrainView.loadMap(map)) return;
      if (request !== terrainRequest || state.dimension !== '3d' || state.mapId !== map.id) return;
      terrainView.setHeightFactor(state.heightFactor);
      terrainView.setSettings(state.settings);
      if (pendingTerrainFocus) { terrainView.focus(pendingTerrainFocus, 100, true); pendingTerrainFocus = null; }
      buildZones();
      element('terrain-elevation').textContent = terrainView.descriptor.sampleMetres + ' m 全图高度' + (currentMap.id === 'bakurani' ? ' · 2 m 近景流式细节' : ' · 真实起伏');
      element('terrain-loading').hidden = true;
      terrainView.resize();
      if (artillery?.active) { artillery.refresh(); fitArtillery(artillery.points.filter(Boolean), artillery.trajectory); }
      scheduleRender();
      persist();
    } catch (error) {
      if (request !== terrainRequest || state.dimension !== '3d') return;
      terrainModulePromise = null;
      setDimension('2d');
      notify('3D 未能启动：' + (error.message.includes('WebGL') ? '浏览器需支持 WebGL 2，并启用硬件加速。' : error.message));
    }
  }

  function setDimension(dimension) {
    if (!['2d', '3d'].includes(dimension) || dimension === state.dimension) return;
    if (dimension === '3d' && location.protocol === 'file:') { notify('3D 需要本地服务。请双击「启动地图.cmd」后打开地图。'); return; }
    const focus = state.dimension === '3d' && terrainReady() ? terrainView.metrics().target : [clamp((state.width / 2 - state.pan[0]) / state.scale, 0, 2048), clamp((state.height / 2 - state.pan[1]) / state.scale, 0, 2048)];
    state.dimension = dimension;
    state.hover = null;
    activePointer = null;
    pinch = null;
    pointers.clear();
    viewport.classList.remove('dragging');
    updateDimensionControls();
    if (dimension === '3d') { pendingTerrainFocus = focus; loadTerrain(currentMap); }
    else { terrainRequest++; pendingTerrainFocus = null; centerOn(focus); }
    scheduleRender();
    persist();
  }

  function render() {
    const terrainMetrics = state.dimension === '3d' && terrainReady() ? terrainView.metrics() : null;
    const labelScale = terrainMetrics ? terrainMetrics.scale : state.scale;
    world.style.setProperty('--map-scale', state.scale);
    world.style.transform = 'translate(' + state.pan[0] + 'px,' + state.pan[1] + 'px) scale(' + state.scale + ')';
    const occupied = [];
    const entries = markerEntries;
    for (const entry of entries) {
      const point = entry.point;
      const [horizontal, vertical] = screenPosition(point.position);
      let visible = (!workspace || workspace.visible(point)) && Boolean(state.layers[point.kind]) && horizontal > -120 && horizontal < state.width + 120 && vertical > -80 && vertical < state.height + 80;
      if (point.label) {
        const width = Math.min(205, point.name.length * 8 + 15);
        visible = visible && state.settings.labels && labelScale >= 1.2 && horizontal > width / 2 + 12 && horizontal < state.width - width / 2 - 12 && vertical > 58 && vertical < state.height - 90;
        const box = [horizontal - width / 2, vertical - 22, horizontal + width / 2, vertical + 22];
        if (visible && occupied.some(other => box[0] < other[2] && box[2] > other[0] && box[1] < other[3] && box[3] > other[1])) visible = point.id === state.selected?.id;
        if (visible) occupied.push(box);
      } else if (visible) {
        occupied.push([horizontal - 32, vertical - 28, horizontal + 32, vertical + 48]);
      }
      entry.button.hidden = !visible;
      entry.button.classList.toggle('found', Boolean(workspace?.isFound(point)));
      entry.button.style.setProperty('--marker-size', workspace?.record.markerSize || 1);
      entry.button.style.transform = 'translate(' + horizontal.toFixed(1) + 'px,' + vertical.toFixed(1) + 'px) translate(-50%,' + (point.label ? '-50%' : '-16px') + ')';
      entry.button.classList.toggle('selected', point.id === state.selected?.id);
      entry.button.style.zIndex = point.id === state.selected?.id ? '5' : point.label ? '0' : '1';
      const text = entry.button.querySelector('.marker-label');
      if (text) text.hidden = (!state.settings.labels || state.dimension === '3d' && labelScale < .6) && point.id !== state.selected?.id;
    }
    element('grid-overlay').hidden = !state.settings.grid;
    element('zoom-value').textContent = Math.round(state.scale / 3.4 * 100) + '%';
    const metresPerScreenPixel = currentMap.bounds[2] / 100 / 2048 / state.scale;
    const options = [25, 50, 100, 250, 500, 1000, 2000, 5000];
    const distance = options.find(value => value / metresPerScreenPixel >= 60) || 5000;
    element('scale-line').style.width = Math.round(distance / metresPerScreenPixel) + 'px';
    element('scale-value').textContent = distance >= 1000 ? distance / 1000 + ' km' : distance + ' m';
    const miniRectangle = element('minimap-rect');
    miniRectangle.style.left = -state.pan[0] / state.scale / 2048 * 100 + '%';
    miniRectangle.style.top = -state.pan[1] / state.scale / 2048 * 100 + '%';
    miniRectangle.style.width = state.width / state.scale / 2048 * 100 + '%';
    miniRectangle.style.height = state.height / state.scale / 2048 * 100 + '%';
    if (terrainMetrics) {
      element('zoom-value').textContent = Math.round(terrainMetrics.zoom) + '%';
      miniRectangle.style.left = terrainMetrics.target[0] / 2048 * 100 + '%';
      miniRectangle.style.top = terrainMetrics.target[1] / 2048 * 100 + '%';
      element('minimap').setAttribute('aria-label', '点击总览移动三维焦点，圆点表示当前焦点');
      document.querySelector('.compass').style.transform = 'rotate(' + -terrainMetrics.heading + 'deg)';
    } else if (state.dimension === '2d') element('minimap').setAttribute('aria-label', '点击战区总览定位');
    renderDrawing();
    artillery?.renderOverlay(element('artillery-map-overlay'), screenPosition, state.dimension, state.scale);
    workspace?.render();
    placePopup();
  }

  function buildGrid() {
    let markup = '<g stroke="#d1dfb6" stroke-opacity=".13" stroke-width=".7">';
    for (let index = 0; index <= 16; index++) {
      const offset = index * 128;
      markup += '<path vector-effect="non-scaling-stroke" d="M' + offset + ' 0V2048 M0 ' + offset + 'H2048"/>';
    }
    markup += '</g><g fill="#d7e5b7" fill-opacity=".29" font-family="Atlas,sans-serif" font-size="5">';
    for (let column = 0; column < 16; column++) {
      for (let row = 0; row < 16; row++) markup += '<text x="' + (column * 128 + 5) + '" y="' + (row * 128 + 8) + '">' + String.fromCharCode(65 + column) + (row + 1) + '</text>';
    }
    element('grid-overlay').innerHTML = markup + '</g>';
  }

  function buildMarkers() {
    markerContainer.replaceChildren();
    markerEntries = allPoints().map(point => {
      const info = kinds[point.kind];
      const button = document.createElement('button');
      button.className = 'map-marker' + (point.label ? ' region-label' : '') + (['towers', 'inactive'].includes(point.kind) ? ' tower' : '') + (point.kind === 'inactive' ? ' inactive' : '') + (point.kind === 'personal' ? ' personal' : '');
      button.dataset.point = point.id;
      button.setAttribute('aria-label', point.name + ' · ' + info.name);
      button.title = point.name + ' · ' + info.name;
      button.style.setProperty('--marker-color', point.color || (point.kind === 'towers' ? factions[state.faction].color : info.color));
      button.innerHTML = point.label ? '<span class="region-name">' + escape(point.name) + '</span><span class="region-type">' + info.name + '</span>' : '<span class="marker-symbol">' + icon(info.icon) + '</span><span class="marker-label">' + escape(point.name) + '</span>';
      markerContainer.append(button);
      return { point, button };
    }).sort((first, second) => Number(first.point.label) - Number(second.point.label));
    scheduleRender();
  }

  function buildZones() {
    const color = factions[state.faction].color;
    const shapes = currentMap.zones.filter(zone => state.settings.zones && state.layers.boundaries && state.settings.areaLayers?.[zone.kind] !== false).map(zone => '<polygon class="zone-polygon" points="' + zone.polygon.map(position => position.join(',')).join(' ') + '" stroke="' + (zone.kind === 'towers' ? color : kinds[zone.kind].color) + '" stroke-opacity=".48" fill="' + (zone.kind === 'towers' ? color : kinds[zone.kind].color) + '" fill-opacity=".055"/>');
    const selectedControl = currentMap.control[state.control];
    if (selectedControl && state.layers.control) {
      const [horizontal, vertical] = selectedControl.position;
      shapes.push('<circle class="control-circle" cx="' + horizontal + '" cy="' + vertical + '" r="' + selectedControl.radius + '" stroke="' + color + '" fill="' + color + '" fill-opacity=".075"/><text x="' + horizontal + '" y="' + (vertical - selectedControl.radius + 8) + '" text-anchor="middle" fill="' + color + '" font-family="Atlas,sans-serif" font-size="3.1" letter-spacing=".6">CONTROL ZONE / ' + escape(selectedControl.name) + '</text>');
    }
    element('zone-overlay').innerHTML = shapes.join('');
    if (state.dimension === '3d' && terrainReady()) {
      const zones = currentMap.zones.filter(zone => state.settings.zones && state.layers.boundaries && state.settings.areaLayers?.[zone.kind] !== false).map(zone => ({ ...zone, color: zone.kind === 'towers' ? color : kinds[zone.kind].color }));
      terrainView.setOverlays(zones, state.layers.control ? selectedControl : null, color);
    }
  }

  function layerCount(key) {
    if (key === 'control') return currentMap.control.length;
    if (key === 'boundaries') return currentMap.zones.length;
    return allPoints().filter(point => point.kind === key).length;
  }

  function buildLayers() {
    let total = 0;
    element('layer-groups').innerHTML = layerGroups.map(group => {
      const rows = group.keys.filter(key => layerCount(key) > 0 || key === 'personal').map(key => {
        total++;
        const info = kinds[key];
        return '<label class="layer-row" style="--layer-color:' + info.color + '"><span class="layer-row-icon">' + icon(info.icon) + '</span><span class="layer-name">' + info.name + '</span><span class="layer-count">' + layerCount(key) + '</span><input type="checkbox" data-layer="' + key + '" aria-label="' + info.name + '"' + (state.layers[key] ? ' checked' : '') + '></label>';
      }).join('');
      return rows ? '<section class="layer-group"><h3 class="layer-group-heading"><span>' + group.name + '</span>' + icon('chevron') + '</h3>' + rows + '</section>' : '';
    }).join('');
    element('layer-total').textContent = total;
    updateVisibleCount();
  }

  function updateVisibleCount() {
    element('visible-count').textContent = allPoints().filter(point => state.layers[point.kind] && (!point.label || state.settings.labels) && (!workspace || workspace.visible(point))).length;
  }

  function updateSettings() {
    element('faction-name').textContent = factions[state.faction].name;
    document.querySelector('.faction-dot').style.backgroundColor = factions[state.faction].color;
    element('control-select').value = String(state.control);
    document.documentElement.style.setProperty('--map-brightness', state.settings.brightness / 100);
    viewport.classList.toggle('satellite', state.settings.view === 'satellite');
    element('scene-quality').value = state.settings.quality;
    for (const identifier of ['scene-model-loading', 'navigation-model-loading']) element(identifier).value = state.settings.modelLoading;
    element('scene-shadows').checked = state.settings.shadows;
    element('scene-collision').checked = state.settings.collision;
    for (const name of ['grid', 'labels', 'zones']) element('setting-' + name).checked = state.settings[name];
    element('setting-brightness').value = state.settings.brightness;
    element('brightness-value').textContent = state.settings.brightness + '%';
    element('grid-button').classList.toggle('active', state.settings.grid);
    element('grid-button').setAttribute('aria-pressed', String(state.settings.grid));
    document.querySelectorAll('[data-view]').forEach(button => { const active = button.dataset.view === state.settings.view; button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active)); });
    terrainView?.setSettings(state.settings);
    buildZones();
    updateVisibleCount();
    scheduleRender();
  }

  function switchMap(mapId, preserveSidebar = false) {
    if (!Object.hasOwn(maps, mapId)) return;
    const keepArtillery = state.tool === 'artillery';
    state.mapId = mapId;
    currentMap = maps[mapId];
    state.selected = null;
    state.control = 0;
    popup.hidden = true;
    clearDrawing();
    element('benchmark-button').disabled = false;
    element('benchmark-button').textContent = '测量 10 秒';
    setTool(null);
    element('map-loading').hidden = false;
    element('map-error').hidden = true;
    const mapImage = element('map-image');
    mapImage.onload = () => { element('map-loading').hidden = true; };
    mapImage.onerror = () => { element('map-loading').hidden = true; element('map-error').hidden = false; };
    mapImage.src = currentMap.image;
    mapImage.alt = currentMap.name + ' 真实游戏卫星底图';
    if (mapImage.complete && mapImage.naturalWidth) element('map-loading').hidden = true;
    const detailImage = element('map-detail-image');
    detailImage.src = currentMap.detailImage;
    detailImage.style.left = currentMap.detail.x + 'px';
    detailImage.style.top = currentMap.detail.y + 'px';
    element('minimap-image').src = currentMap.image;
    element('map-card-image').src = currentMap.detailImage;
    element('map-card-name').textContent = currentMap.name.toUpperCase();
    element('map-card-region').textContent = currentMap.zh + ' · ' + currentMap.region.split(' · ')[0];
    document.querySelector('.map-card-kicker > span').textContent = '0' + (Object.keys(maps).indexOf(mapId) + 1) + ' / 03';
    element('breadcrumb-name').textContent = currentMap.name;
    element('map-title').innerHTML = escape(currentMap.zh) + '<span class="map-title-en">' + escape(currentMap.name.toUpperCase()) + '</span>';
    element('status-map-name').textContent = currentMap.name.toUpperCase();
    element('point-total').textContent = currentMap.points.length + ' 个地图地点';
    document.title = 'WARDOGS · ' + currentMap.name + ' 战术地图';
    element('control-select').innerHTML = currentMap.control.map((control, index) => '<option value="' + index + '">' + escape(control.name) + '</option>').join('');
    element('control-select').hidden = !currentMap.control.length;
    buildLayers();
    buildMarkers();
    buildZones();
    buildSaved();
    searchPoints();
    centerOn(currentMap.center, state.width < 650 ? 2.7 : 3.4);
    if (state.dimension === '3d') { pendingTerrainFocus = [...currentMap.center]; loadTerrain(currentMap); }
    element('coordinates').textContent = coordinatesText(currentMap.center);
    if (!preserveSidebar) closeSidebar();
    workspace?.tools.refreshStatus();
    if (keepArtillery && artillery) { artillery.open(); setTool('artillery'); }
    try { history.replaceState(null, '', '#map=' + mapId + (state.tool === 'artillery' ? '&tool=artillery' : '')); } catch { }
    persist();
  }
  function setTab(tab) {
    state.tab = tab;
    element('search').value = '';
    searchPoints();
    for (const name of ['layers', 'saved']) {
      element(name + '-tab').classList.toggle('active', tab === name);
      element(name + '-tab').setAttribute('aria-selected', String(tab === name));
    }
    document.querySelectorAll('.nav-link[data-action],.rail-button[data-action="map"],.rail-button[data-action="saved"]').forEach(button => button.classList.toggle('active', button.dataset.action === (tab === 'saved' ? 'saved' : 'map')));
    if (tab === 'saved') buildSaved();
  }

  function closeSidebar() {
    document.body.classList.remove('sidebar-open');
    element('sidebar-backdrop').hidden = true;
    element('sidebar').inert = matchMedia('(max-width:900px)').matches;
  }

  function openSidebar() {
    if (!matchMedia('(max-width:900px)').matches) return;
    document.body.classList.add('sidebar-open');
    element('sidebar-backdrop').hidden = false;
    element('sidebar').inert = false;
  }

  function searchPoints() {
    const query = element('search').value.trim().toLocaleLowerCase();
    element('search-results').hidden = !query;
    element('layers-panel').hidden = Boolean(query) || state.tab !== 'layers';
    element('saved-panel').hidden = Boolean(query) || state.tab !== 'saved';
    if (!query) { element('search-results').replaceChildren(); return; }
    const words = query.split(/\s+/);
    const rank = point => { const name = point.name.toLocaleLowerCase(); return name === query ? 0 : name.startsWith(query) ? 1 : name.includes(query) ? 2 : 3; };
    const matches = allPoints().filter(point => words.every(word => (point.name + ' ' + kinds[point.kind].name + ' ' + (point.note || '')).toLocaleLowerCase().includes(word))).sort((first, second) => rank(first) - rank(second));
    const heading = '<div class="results-title"><span>搜索结果</span><span>' + matches.length + ' 个地点</span></div>';
    const markup = matches.slice(0, 50).map(point => '<button class="search-item" data-locate="' + escape(point.id) + '" style="--item-color:' + (point.color || kinds[point.kind].color) + '">' + icon(kinds[point.kind].icon) + '<span><strong>' + escape(point.name) + '</strong><small>' + kinds[point.kind].name + '</small></span>' + icon('arrow') + '</button>').join('');
    element('search-results').innerHTML = heading + (markup || '<div class="empty-state">' + icon('search') + '<h3>没有找到这个地点</h3><p>试试 Tower、Factory，或搜索图层名称。<br>目前只搜索当前战场。</p></div>') + (matches.length > 50 ? '<p class="dialog-intro">仅显示前 50 个结果，请添加关键词缩小范围。</p>' : '');
  }

  function savedEntries() {
    const entries = state.pins.map(pin => ({ ...pin, kind: 'personal' }));
    for (const map of Object.values(maps)) {
      for (const point of map.points) if (state.bookmarks.has(map.id + ':' + point.id)) entries.push({ ...point, mapId: map.id });
    }
    return entries;
  }

  function buildSaved() {
    const entries = savedEntries();
    element('saved-count').textContent = entries.length;
    element('header-saved-count').textContent = entries.length;
    element('saved-list').innerHTML = entries.length ? entries.map(point => '<button class="saved-item" data-locate="' + escape(point.id) + '" data-map-id="' + point.mapId + '" style="--item-color:' + (point.color || kinds[point.kind].color) + '">' + icon(point.kind === 'personal' ? 'pin' : 'bookmark') + '<span><strong>' + escape(point.name) + '</strong><small>' + maps[point.mapId].name + ' · ' + kinds[point.kind].name + '</small></span>' + icon('arrow') + '</button>').join('') : '<div class="empty-state">' + icon('bookmark') + '<h3>情报从一个标记开始</h3><p>收藏重要地点，或留下小队集合点。<br>你的战术笔记，只属于你。</p></div>';
  }

  function locatePoint(pointId, mapId = state.mapId) {
    if (mapId !== state.mapId) switchMap(mapId, true);
    const point = allPoints().find(candidate => candidate.id === pointId);
    if (!point) return;
    state.layers[point.kind] = true;
    if (point.label) state.settings.labels = true;
    buildLayers();
    updateSettings();
    centerOn(point.position, Math.max(state.scale, 3.4));
    showPopup(point);
    closeSidebar();
    persist();
  }

  function showPopup(point) {
    if (state.tool === 'measure' || state.tool === 'route') {
      addDrawingPoint(point.position);
      return;
    }
    if (state.tool === 'pin') {
      openPinDialog(point.position);
      return;
    }
    state.selected = point;
    const saved = state.bookmarks.has(state.mapId + ':' + point.id);
    const coordinates = pointCoordinates(point.position);
    const personal = point.kind === 'personal';
    popup.innerHTML = '<div class="popup-heading"><div><span class="eyebrow">' + kinds[point.kind].name + ' / ' + escape(currentMap.name.toUpperCase()) + '</span><h3>' + escape(point.name) + '</h3></div><button class="icon-button" data-action="close-popup" aria-label="关闭地点详情">' + icon('close') + '</button></div><div class="popup-coordinates"><span>X ' + coordinates.x.toFixed(2) + '</span><span>Y ' + coordinates.y.toFixed(2) + '</span><button class="text-button" data-action="copy-coordinates">复制</button></div><p class="popup-description">' + escape(personal ? point.note || '尚未添加备注。可编辑此标记，记录你的行动计划。' : kinds[point.kind].description) + '</p><div class="popup-actions">' + (personal ? '<button class="secondary-button" data-action="edit-pin">' + icon('pin') + '编辑标记</button><button class="text-button danger" data-action="delete-pin">' + icon('trash') + '删除</button>' : '<button class="secondary-button" data-action="bookmark">' + icon(saved ? 'check' : 'bookmark') + (saved ? '已收藏' : '收藏地点') + '</button><button class="text-button" data-action="measure-from">从这里测量' + icon('ruler') + '</button>') + '</div>';
    if (workspace && !personal) {
      const actions = document.createElement('div'); actions.className = 'popup-actions';
      const found = document.createElement('button'); found.className = 'secondary-button'; found.dataset.action = 'toggle-found'; found.textContent = workspace.isFound(point) ? '✓ 已找到 · 取消' : '✓ 标为已找到';
      const hidden = document.createElement('button'); hidden.className = 'text-button'; hidden.dataset.action = 'hide-point'; hidden.textContent = '隐藏此地点';
      actions.append(found, hidden); popup.append(actions);
    }
    if (state.dimension === '3d' && terrainReady()) popup.querySelector('.popup-coordinates').insertAdjacentHTML('afterend', '<p class="popup-height">地面高程 ' + terrainView.heightAt(point.position).toFixed(1) + ' m · 游戏高度</p>');
    popup.hidden = false;
    scheduleRender();
  }

  function placePopup() {
    if (popup.hidden || !state.selected) return;
    if (state.dimension === '3d' && !terrainReady()) return;
    const [horizontal, vertical] = screenPosition(state.selected.position);
    if (horizontal < -50 || horizontal > state.width + 50 || vertical < -50 || vertical > state.height + 50) {
      popup.hidden = true;
      state.selected = null;
      return;
    }
    const width = popup.offsetWidth || 265;
    const height = popup.offsetHeight || 210;
    const left = horizontal + width + 30 < state.width ? horizontal + 25 : horizontal - width - 25;
    popup.style.left = clamp(left, 12, Math.max(12, state.width - width - 12)) + 'px';
    popup.style.top = clamp(vertical - 45, 60, Math.max(60, state.height - height - 15)) + 'px';
  }

  function setTool(tool) {
    if (tool !== 'artillery') artilleryRequest++;
    const changed = state.tool !== tool;
    state.tool = tool;
    if (changed) { try { history.replaceState(null, '', '#map=' + state.mapId + (tool === 'artillery' ? '&tool=artillery' : '')); } catch {} }
    if (tool !== 'artillery') artillery?.close();
    if (tool !== 'drawing') workspace?.drawing.close();
    if (changed && tool && !['measure', 'route'].includes(tool)) clearDrawing();
    viewport.dataset.tool = tool || '';
    if (tool) {
      state.selected = null;
      popup.hidden = true;
      if (tool === 'artillery') openSidebar(); else closeSidebar();
      element('settings-panel').hidden = true;
    }
    if (changed && (tool === 'measure' || tool === 'route')) {
      state.drawing = [];
      state.drawingMode = tool;
      state.hover = null;
    }
    element('map-instruction').hidden = !tool;
    element('instruction-text').textContent = tool === 'drawing' ? '战术绘图 · 使用绘图面板选择工具 · Esc 退出' : tool === 'pin' ? '点击地图放置标记 · Esc 取消' : tool === 'route' ? '依次点击添加路点 · 点击「完成」结束' : tool === 'artillery' ? '在侧栏选择炮位或目标，再点击地图 · Esc 退出' : '依次选择起点和终点 · Esc 退出';
    document.querySelectorAll('[data-action="measure"],[data-action="route"],[data-action="pin"],[data-action="artillery"]').forEach(button => button.classList.toggle('active', button.dataset.action === tool));
    if (tool === 'measure' || tool === 'route') element('measurement-card').hidden = false;
    else element('measurement-card').hidden = state.drawing.length < 2;
    element('minimap').hidden = !element('measurement-card').hidden;
    scheduleRender();
  }

  function clearDrawing() {
    state.drawing = [];
    state.hover = null;
    element('drawing-overlay').replaceChildren();
    element('measurement-card').hidden = true;
    element('minimap').hidden = false;
    scheduleRender();
  }

  function addDrawingPoint(position) {
    if (state.tool === 'measure' && state.drawing.length >= 2) state.drawing = [];
    if (state.drawing.length >= 100) { notify('最多支持 100 个路点。'); return; }
    state.drawing.push([...position]);
    state.hover = null;
    scheduleRender();
  }

  function renderDrawing() {
    const drawing = [...state.drawing];
    const preview = state.hover && (state.tool === 'route' && drawing.length > 0 || state.tool === 'measure' && drawing.length === 1);
    if (preview) drawing.push(state.hover);
    const points = drawing.map(screenPosition);
    if (state.dimension === '3d' && terrainReady()) terrainView.setDrawing(drawing);
    let markup = points.length > 1 && state.dimension === '2d' ? '<polyline points="' + points.map(position => position.join(',')).join(' ') + '" fill="none" stroke="#e2efaa" stroke-width="2" stroke-dasharray="5 4"/>' : '';
    for (let index = 0; index < state.drawing.length; index++) {
      const [horizontal, vertical] = points[index];
      markup += '<circle cx="' + horizontal + '" cy="' + vertical + '" r="6" fill="#d5ed79" stroke="#263318" stroke-width="2"/><text x="' + (horizontal + 10) + '" y="' + (vertical - 11) + '" fill="#e6f0c9" font-family="Atlas,sans-serif" font-size="11" style="paint-order:stroke;stroke:#23341a;stroke-width:3">' + (index + 1) + '</text>';
    }
    element('drawing-overlay').innerHTML = markup;
    let distance = 0;
    for (let index = 1; index < drawing.length; index++) distance += Math.hypot(drawing[index][0] - drawing[index - 1][0], drawing[index][1] - drawing[index - 1][1]) * currentMap.bounds[2] / 2048 / 100;
    element('measurement-title').textContent = state.drawingMode === 'route' ? 'ROUTE / 路线规划' : 'DISTANCE / 距离测量';
    element('measurement-distance').textContent = distance >= 1000 ? (distance / 1000).toFixed(2) + ' km' : Math.round(distance) + ' m';
    if (drawing.length > 1) {
      const start = drawing[0];
      const end = drawing.at(-1);
      const bearing = (Math.atan2(end[0] - start[0], start[1] - end[1]) * 180 / Math.PI + 360) % 360;
      element('measurement-bearing').textContent = state.drawingMode === 'route' ? state.drawing.length + ' 个路点 · 水平路径总长' : '方位角 ' + bearing.toFixed(1) + '° · 水平距离';
    } else element('measurement-bearing').textContent = state.drawing.length ? '选择下一处位置' : '点击地图设置起点';
  }

  function openPinDialog(position, existing = null) {
    pendingPin = [...position];
    editingPin = existing;
    element('pin-form').reset();
    element('pin-name').value = existing?.name || '';
    element('pin-note').value = existing?.note || '';
    element('pin-dialog-title').textContent = existing ? '编辑你的战术标记' : '留下你的战术标记';
    if (existing) document.querySelector('#pin-form input[value="' + existing.color + '"]').checked = true;
    element('pin-dialog').showModal();
    element('pin-name').focus();
  }

  function savePin(event) {
    event.preventDefault();
    const name = element('pin-name').value.trim();
    if (!name) { element('pin-name').setCustomValidity('请输入标记名称，不能只包含空格。'); element('pin-name').reportValidity(); return; }
    if (!editingPin && state.pins.length >= 500) { notify('已达到 500 个标记上限，请先导出并整理。'); return; }
    const values = new FormData(element('pin-form'));
    const pin = { id: editingPin?.id || 'pin-' + (globalThis.crypto?.randomUUID?.() || Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)), mapId: state.mapId, position: pendingPin, name, note: element('pin-note').value.trim(), color: values.get('color'), createdAt: editingPin?.createdAt || new Date().toISOString() };
    if (!validPin(pin)) { notify('标记数据无效，请重新选择地图位置。'); return; }
    if (editingPin) state.pins = state.pins.map(existing => existing.id === pin.id ? pin : existing);
    else state.pins.push(pin);
    state.layers.personal = true;
    element('pin-dialog').close();
    setTool(null);
    buildMarkers();
    buildLayers();
    buildSaved();
    searchPoints();
    persist();
    showPopup({ ...pin, kind: 'personal', label: false });
    notify(editingPin ? '标记已更新，只保存在本机。' : '战术标记已保存。');
    editingPin = null;
  }

  function exportData() {
    artillery?.persist();
    const data = { version: workspace ? 3 : 1, exportedAt: new Date().toISOString(), pins: state.pins, bookmarks: [...state.bookmarks], workspace: workspace?.snapshot(), artilleryByMap: workspace?.artilleryBackup(), layers: state.layers, settings: state.settings, viewState: { mapId: state.mapId, dimension: state.dimension, heightFactor: state.heightFactor, faction: state.faction, control: state.control } };
    const content = JSON.stringify(data, null, 2);
    if (backupUrl) URL.revokeObjectURL(backupUrl);
    const url = URL.createObjectURL(new Blob([content], { type: 'application/json;charset=utf-8' }));
    backupUrl = url;
    element('backup-json').value = content;
    element('backup-summary').textContent = data.pins.length + ' 个个人标记 · ' + data.bookmarks.length + ' 个收藏 · ' + (data.workspace?.shapes.length || 0) + ' 条绘图 · ' + Object.keys(data.artilleryByMap || {}).length + ' 张地图的炮兵记录。包含地点状态、筛选及显示偏好。';
    element('backup-download').href = url;
    element('backup-download').download = 'wardogs-atlas-backup-' + new Date().toISOString().slice(0, 10) + '.json';
    const link = document.createElement('a');
    link.href = url;
    link.download = 'wardogs-atlas-backup-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.append(link);
    link.click();
    link.remove();
    if (!element('backup-dialog').open) element('backup-dialog').showModal();
    notify('备份已生成；若未自动下载，可再次下载或复制 JSON 保存。');
  }

  async function importData(event) {
    const file = event.target.files[0];
    if (!file) return;
    try {
      if (file.size > 128000000) throw new Error('备份文件不能超过 128 MB。');
      const data = JSON.parse(await file.text());
      if (!data || ![1, 3].includes(data.version) || !Array.isArray(data.pins) || !Array.isArray(data.bookmarks) || data.pins.length > 500 || data.bookmarks.length > 2000) throw new Error('请选择此地图工具导出的有效 JSON 备份。');
      if (!data.pins.every(validPin) || !data.bookmarks.every(validBookmark)) throw new Error('备份包含无效地图、坐标或标记，请检查文件。');
      if (data.version === 3 && (!workspace || !workspace.validate(data.workspace) || !workspace.validArtilleryBackup(data.artilleryByMap) || !workspaceModule.validBackupPreferences(data))) throw new Error('备份的绘图或炮兵数据无效。');
      const merged = new Map(state.pins.map(pin => [pin.id, pin]));
      for (const pin of data.pins) if (!merged.has(pin.id)) merged.set(pin.id, { id: pin.id, mapId: pin.mapId, name: pin.name, note: pin.note || '', position: [...pin.position], color: pin.color, createdAt: pin.createdAt });
      if (merged.size > 500) throw new Error('合并后超过 500 个标记，无法导入。');
      const mergedBookmarks = new Set([...state.bookmarks, ...data.bookmarks]);
      if (mergedBookmarks.size > 2000) throw new Error('合并后收藏超过 2000 条。');
      const artilleryRecords = data.version === 3 ? workspace.prepareArtilleryImport(data.artilleryByMap) : null;
      if (data.version === 3) {
        workspace.import(data.workspace);
        if (data.viewState && data.viewState.mapId !== state.mapId) switchMap(data.viewState.mapId);
        workspace.importArtillery(artilleryRecords);
        for (const name of Object.keys(state.layers)) if (typeof data.layers?.[name] === 'boolean') state.layers[name] = data.layers[name];
        for (const name of ['grid', 'labels', 'zones', 'shadows', 'collision']) if (typeof data.settings?.[name] === 'boolean') state.settings[name] = data.settings[name];
        for (const name of ['brightness', 'view', 'quality', 'modelLoading']) if (data.settings?.[name] !== undefined) state.settings[name] = data.settings[name];
        for (const category of ['buildings', 'trees', 'props']) if (typeof data.settings?.models?.[category] === 'boolean') state.settings.models[category] = data.settings.models[category];
        if (data.viewState) {
          state.heightFactor = data.viewState.heightFactor;
          state.faction = data.viewState.faction;
          element('faction-name').textContent = factions[state.faction].name;
          document.querySelector('.faction-dot').style.backgroundColor = factions[state.faction].color;
          state.control = data.viewState.control < currentMap.control.length ? data.viewState.control : 0;
          element('control-select').value = String(state.control);
          setDimension(data.viewState.dimension);
        }
        updateModelControls(); terrainView?.setHeightFactor(state.heightFactor);
        state.settings.areaLayers = Object.fromEntries(Object.keys(defaultLayers).map(kind => [kind, data.settings?.areaLayers?.[kind] !== false]));
        updateSettings(); buildZones(); workspace.tools.refreshStatus();
      }
      state.pins = [...merged.values()];
      state.bookmarks = mergedBookmarks;
      buildMarkers();
      buildLayers();
      buildSaved();
      searchPoints();
      persist();
      notify('备份已合并导入，已有标记不会被覆盖。');
    } catch (error) { notify(error instanceof SyntaxError ? '文件不是有效 JSON，请选择地图备份。' : error.message); }
    event.target.value = '';
  }

  function chooseMap() {
    element('map-options').innerHTML = Object.values(maps).map((map, index) => '<button class="map-option' + (map.id === state.mapId ? ' selected' : '') + '" data-choose-map="' + map.id + '"><img src="' + map.detailImage + '" alt="' + escape(map.name) + ' 地图预览"><span class="map-option-content"><span class="map-option-kicker">BATTLEGROUND / 0' + (index + 1) + (map.id === state.mapId ? icon('check') : '') + '</span><strong>' + escape(map.name.toUpperCase()) + '</strong><small>' + escape(map.zh + ' · ' + map.region.split(' · ')[0]) + '</small><span class="map-option-description">' + escape(map.description) + '</span><span class="map-option-bottom">' + map.points.length + ' 个真实地点' + icon('arrow') + '</span></span></button>').join('');
    element('map-dialog').showModal();
  }
  async function runAction(action) {
    if (action === 'map' || action === 'layers') { setTab('layers'); setTool(null); openSidebar(); }
    else if (action === 'saved') { setTool(null); setTab('saved'); openSidebar(); }
    else if (action === 'choose-map') chooseMap();
    else if (action === 'help') element('help-dialog').showModal();
    else if (action === 'sidebar') document.body.classList.contains('sidebar-open') ? closeSidebar() : openSidebar();
    else if (action === 'zoom-in') zoom(1.25);
    else if (action === 'zoom-out') zoom(.8);
    else if (action === 'reset-view') { if (state.dimension === '3d' && terrainReady()) terrainView.focus(currentMap.center, 100, true); else centerOn(currentMap.center, state.width < 650 ? 2.7 : 3.4); }
    else if (action === 'overview') { state.selected = null; popup.hidden = true; if (state.dimension === '3d' && terrainReady()) terrainView.overview(); else centerOn([1024, 1024], Math.min(state.width, state.height) / 2048 * .94); }
    else if (action === 'top-view') { if (terrainReady()) terrainView.topView(); }
    else if (action === 'model-closeup') { if (terrainReady()) terrainView.focus(terrainView.props.showcase(), 45, true); }
    else if (action === 'clear-inspection') { terrainView.performance.selection.visible = false; terrainView.invalidate(); inspectedModel = null; element('model-inspector').hidden = true; scheduleRender(); }
    else if (action === 'benchmark') { if (terrainReady() && !terrainView.performance.benchmark) { element('benchmark-button').disabled = true; element('benchmark-button').textContent = '测量中…'; terrainView.performance.measure(); } }
    else if (action === 'export-performance') {
      if (!performanceReports.length) { notify('请先运行一次 10 秒测量。'); return; }
      const url = URL.createObjectURL(new Blob([JSON.stringify(performanceReports, null, 2)], { type: 'application/json' }));
      const download = document.createElement('a'); download.href = url; download.download = 'wardogs-performance.json'; download.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    else if (action === 'artillery' || action === 'artillery-origin' || action === 'artillery-target') {
      if (location.protocol === 'file:') { notify('炮兵工具请通过启动地图脚本打开。'); return; }
      const request = ++artilleryRequest;
      if (!artillery) {
        try {
          artilleryModule ||= import('./artillery.js');
          const { ArtilleryTool } = await artilleryModule;
          if (request !== artilleryRequest) return false;
          artillery = new ArtilleryTool(element('artillery-panel'), {
            viewport, mapPosition, pickHeight: () => state.dimension === '3d' ? terrainView?.lastPickHeight : null,
            map: () => currentMap,
            dimension: () => state.dimension,
            sceneReady: terrainReady,
            heightAt: position => terrainReady() ? terrainView.heightAt(position) : null,
            onTrajectory: (points, metadata) => { if (terrainReady()) terrainView.setArtillery(points, metadata); scheduleRender(); },
            onView: mode => { viewport.dataset.artilleryView = mode; if (mode === 'orbit' || terrainReady()) terrainView?.setArtilleryView(mode); if (mode !== 'orbit') closeSidebar(); },
            onFit: fitArtillery,
            onPick: () => { artillery.setView('orbit'); closeSidebar(); },
            onShare: record => workspace?.share(record),
            notify
          });
        } catch (error) {
          if (request !== artilleryRequest) return false;
          artilleryModule = null;
          notify('炮兵工具加载失败：' + error.message + '，请重试。');
          return false;
        }
      }
      artillery.open(); setTool('artillery');
      fitArtillery(artillery.points.filter(Boolean), artillery.trajectory);
      if (inspectedModel && action !== 'artillery') artillery.setPoint(action === 'artillery-origin' ? 0 : 1, inspectedModel.position, inspectedModel.height);
      return true;
    }
    else if (action === 'retry-models') { if (terrainReady()) terrainView.props.retryFailures(); }
    else if (['measure', 'route', 'pin'].includes(action)) setTool(state.tool === action ? null : action);
    else if (action === 'cancel-tool') { if (!state.tool) clearDrawing(); setTool(null); }
    else if (action === 'clear-drawing') { const mode = state.drawingMode; clearDrawing(); setTool(mode); }
    else if (action === 'grid') { state.settings.grid = !state.settings.grid; updateSettings(); persist(); }
    else if (action === 'settings') { const panel = element('settings-panel'); panel.hidden = !panel.hidden; closeSidebar(); }
    else if (action === 'restore-settings') { Object.assign(state.settings, { grid: true, labels: true, zones: true, brightness: 60, view: 'tactical', quality: 'auto', modelLoading: 'stream', shadows: true, collision: true, models: { buildings: true, trees: true, props: true } }); updateModelControls(); updateSettings(); persist(); notify('地图偏好已恢复默认。'); }
    else if (action === 'show-all' || action === 'hide-all') { for (const key of Object.keys(state.layers)) state.layers[key] = action === 'show-all'; state.selected = null; popup.hidden = true; buildLayers(); buildZones(); scheduleRender(); persist(); }
    else if (action === 'faction') { state.faction = (state.faction + 1) % factions.length; element('faction-name').textContent = factions[state.faction].name; document.querySelector('.faction-dot').style.backgroundColor = factions[state.faction].color; buildMarkers(); buildZones(); persist(); notify('阵营配色预览：' + factions[state.faction].name + '，非实时占领状态。'); }
    else if (action === 'close-popup') { state.selected = null; popup.hidden = true; scheduleRender(); }
    else if (action === 'bookmark' && state.selected) {
      const key = state.mapId + ':' + state.selected.id;
      if (state.bookmarks.has(key)) state.bookmarks.delete(key); else state.bookmarks.add(key);
      buildSaved();
      showPopup(state.selected);
      persist();
    }
    else if (action === 'toggle-found' && state.selected && workspace) { const selected = state.selected; workspace.toggleFound(selected); workspace.tools.refreshStatus(); if (workspace.visible(selected)) showPopup(selected); else { state.selected = null; popup.hidden = true; } }
    else if (action === 'hide-point' && state.selected && workspace) { workspace.toggle('hidden', state.selected); state.selected = null; popup.hidden = true; workspace.tools.refreshStatus(); }
    else if (action === 'measure-from' && state.selected) { const position = [...state.selected.position]; setTool('measure'); addDrawingPoint(position); }
    else if (action === 'edit-pin' && state.selected) openPinDialog(state.selected.position, state.selected);
    else if (action === 'delete-pin' && state.selected?.kind === 'personal') {
      state.pins = state.pins.filter(pin => pin.id !== state.selected.id);
      state.selected = null;
      popup.hidden = true;
      buildMarkers(); buildLayers(); buildSaved(); searchPoints(); persist();
      notify('个人标记已删除。');
    }
    else if (action === 'export') exportData();
    else if (action === 'copy-backup') {
      try { await navigator.clipboard.writeText(element('backup-json').value); notify('完整备份 JSON 已复制，可粘贴到文本文件并保存为 .json。'); }
      catch { element('backup-json').closest('details').open = true; element('backup-json').select(); notify('请按 Ctrl+C 复制已选中的备份 JSON。'); }
    }
    else if (action === 'copy-qq-group') {
      const groupNumber = element('qq-group-number');
      element('qq-group-feedback').textContent = '正在复制群号…';
      try {
        await navigator.clipboard.writeText(groupNumber.value);
        element('qq-group-feedback').textContent = '群号已复制，在 QQ 中搜索群聊即可申请加入。';
      } catch {
        groupNumber.focus();
        groupNumber.select();
        element('qq-group-feedback').textContent = '群号已选中，请按 Ctrl+C 或长按复制。';
      }
    }
    else if (action === 'import') element('import-file').click();
    else if (action === 'copy-coordinates' && state.selected) {
      const text = currentMap.name + ' · ' + state.selected.name + ' · ' + coordinatesText(state.selected.position);
      try { await navigator.clipboard.writeText(text); notify('游戏坐标已复制。'); }
      catch { notify('当前浏览器不允许复制，请手动记录详情中的坐标。'); }
    }
    else if (action === 'fullscreen') {
      if (document.fullscreenElement) { await document.exitFullscreen(); document.body.classList.remove('map-expanded'); }
      else if (document.body.classList.contains('map-expanded')) document.body.classList.remove('map-expanded');
      else { document.body.classList.add('map-expanded'); closeSidebar(); try { await document.documentElement.requestFullscreen(); } catch { notify('已展开地图视图，按 F 恢复。'); } }
    }
  }

  element('qq-group-join').addEventListener('click', () => {
    element('qq-group-feedback').textContent = '';
    element('qq-group-dialog').showModal();
  });

  document.addEventListener('click', event => {
    const target = event.target.closest('button');
    if (!target) return;
    if (target.hasAttribute('data-close-dialog')) target.closest('dialog').close();
    else if (target.dataset.dimension) setDimension(target.dataset.dimension);
    else if (target.dataset.chooseMap) { element('map-dialog').close(); element('search').value = ''; switchMap(target.dataset.chooseMap); }
    else if (target.dataset.locate) locatePoint(target.dataset.locate, target.dataset.mapId || state.mapId);
    else if (target.dataset.point) { const point = allPoints().find(candidate => candidate.id === target.dataset.point); if (point) showPopup(point); }
    else if (target.dataset.action) runAction(target.dataset.action);
  });

  document.addEventListener('change', event => {
    const key = event.target.dataset.layer;
    if (key) {
      state.layers[key] = event.target.checked;
      if (state.selected?.kind === key && !state.layers[key]) { state.selected = null; popup.hidden = true; }
      buildZones(); updateVisibleCount(); scheduleRender(); persist();
    }
  });

  element('search').addEventListener('input', searchPoints);
  element('search').addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); element('search').value = ''; searchPoints(); element('search').blur(); }
    if (event.key === 'Enter') { event.preventDefault(); const firstResult = element('search-results').querySelector('[data-locate]'); if (firstResult) locatePoint(firstResult.dataset.locate); }
  });
  element('pin-form').addEventListener('submit', savePin);
  element('pin-name').addEventListener('input', () => element('pin-name').setCustomValidity(''));
  element('pin-dialog').addEventListener('close', () => { pendingPin = null; editingPin = null; if (state.tool === 'pin') setTool(null); });
  element('import-file').addEventListener('change', importData);
  element('backup-dialog').addEventListener('close', () => { if (backupUrl) { URL.revokeObjectURL(backupUrl); backupUrl = null; } });
  element('sidebar-backdrop').addEventListener('click', closeSidebar);
  for (const name of ['grid', 'labels', 'zones']) element('setting-' + name).addEventListener('change', event => { state.settings[name] = event.target.checked; updateSettings(); persist(); });
  element('setting-brightness').addEventListener('input', event => { state.settings.brightness = Number(event.target.value); updateSettings(); persist(); });
  document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => { state.settings.view = button.dataset.view; updateSettings(); persist(); }));
  element('height-factor').addEventListener('input', event => {
    state.heightFactor = clamp(Number(event.target.value), 1, 3);
    terrainView?.setHeightFactor(state.heightFactor);
    element('height-factor-value').textContent = state.heightFactor + '× · ' + (state.heightFactor === 1 ? '实际比例' : '显示放大');
    scheduleRender();
    persist();
  });
  for (const category of ['buildings', 'trees', 'props']) element('models-' + category).addEventListener('change', event => {
    state.settings.models[category] = event.target.checked;
    updateModelControls();
    updateSettings();
    persist();
  });
  element('control-select').addEventListener('change', event => { state.control = Number(event.target.value); buildZones(); centerOn(currentMap.control[state.control].position); persist(); });
  for (const [identifier, setting] of [['scene-quality', 'quality'], ['scene-shadows', 'shadows'], ['scene-collision', 'collision']]) {
    const control = element(identifier);
    if (setting === 'quality') control.value = state.settings.quality;
    else control.checked = state.settings[setting];
    control.addEventListener('change', () => { state.settings[setting] = setting === 'quality' ? control.value : control.checked; terrainView?.setSettings(state.settings); persist(); });
  }
  for (const identifier of ['scene-model-loading', 'navigation-model-loading']) {
    const control = element(identifier);
    control.value = state.settings.modelLoading;
    control.addEventListener('change', () => {
      state.settings.modelLoading = control.value === 'preload' ? 'preload' : 'stream';
      for (const other of ['scene-model-loading', 'navigation-model-loading']) element(other).value = state.settings.modelLoading;
      terrainView?.setSettings(state.settings);
      persist();
      if (state.settings.modelLoading === 'preload') notify('预载当前整张地图：全部位置、LOD 和贴图。内存占用较高，仍按视野绘制。');
    });
  }
  document.addEventListener('pointerdown', event => { if (!event.target.closest('#settings-panel,[data-action="settings"]')) element('settings-panel').hidden = true; });
  for (const dialog of document.querySelectorAll('dialog')) dialog.addEventListener('click', event => {
    const rectangle = dialog.getBoundingClientRect();
    if (event.target === dialog && (event.clientX < rectangle.left || event.clientX > rectangle.right || event.clientY < rectangle.top || event.clientY > rectangle.bottom)) dialog.close();
  });

  function handleMapClick(position, shiftKey) {
    if (position.some(coordinate => coordinate < 0 || coordinate > 2048)) return;
    if (shiftKey || state.tool === 'pin') openPinDialog(position);
    else if (state.tool === 'artillery') artillery?.addPoint(position, state.dimension === '3d' ? terrainView?.lastPickHeight : null);
    else if (state.tool === 'measure' || state.tool === 'route') addDrawingPoint(position);
    else { state.selected = null; popup.hidden = true; scheduleRender(); }
  }

  function isMapControl(target) {
    return Boolean(target.closest('button:not(.map-marker),a,input,select,textarea,summary,.point-popup,.model-inspector,.artillery-sight,.workspace-toolbar,.measurement-card,.map-controls,.map-top-options,.workspace-buttons,.terrain-tools,.artillery-navigation'));
  }

  viewport.addEventListener('pointerdown', event => {
    if (state.dimension === '3d') return;
    const mapMarker = event.target.closest('.map-marker');
    if (event.button !== 0 || isMapControl(event.target)) return;
    viewport.focus({ preventScroll: true });
    viewport.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, [event.clientX, event.clientY]);
    if (pointers.size === 1) activePointer = { id: event.pointerId, x: event.clientX, y: event.clientY, pan: [...state.pan], moved: false, pointId: mapMarker?.dataset.point };
    else if (pointers.size === 2) {
      const positions = [...pointers.values()];
      const middle = [(positions[0][0] + positions[1][0]) / 2, (positions[0][1] + positions[1][1]) / 2];
      pinch = { distance: Math.hypot(positions[1][0] - positions[0][0], positions[1][1] - positions[0][1]), scale: state.scale, anchor: mapPosition(...middle) };
      if (activePointer) activePointer.moved = true;
    }
  });

  viewport.addEventListener('pointermove', event => {
    if (state.dimension === '3d') return;
    const position = mapPosition(event.clientX, event.clientY);
    if (position.every(coordinate => coordinate >= 0 && coordinate <= 2048)) element('coordinates').textContent = coordinatesText(position);
    state.hover = position;
    if (pointers.has(event.pointerId)) pointers.set(event.pointerId, [event.clientX, event.clientY]);
    if (pinch && pointers.size >= 2) {
      const positions = [...pointers.values()];
      const distance = Math.hypot(positions[1][0] - positions[0][0], positions[1][1] - positions[0][1]);
      const rectangle = viewport.getBoundingClientRect();
      const middle = [(positions[0][0] + positions[1][0]) / 2 - rectangle.left, (positions[0][1] + positions[1][1]) / 2 - rectangle.top];
      state.scale = clamp(pinch.scale * distance / Math.max(1, pinch.distance), Math.min(state.width, state.height) / 2048 * .6, 8);
      state.pan = [middle[0] - pinch.anchor[0] * state.scale, middle[1] - pinch.anchor[1] * state.scale];
      clampPan();
      scheduleRender();
    } else if (activePointer?.id === event.pointerId) {
      const horizontal = event.clientX - activePointer.x;
      const vertical = event.clientY - activePointer.y;
      if (Math.hypot(horizontal, vertical) > 4) activePointer.moved = true;
      if (activePointer.moved) {
        viewport.classList.add('dragging');
        state.pan = [activePointer.pan[0] + horizontal, activePointer.pan[1] + vertical];
        clampPan();
        scheduleRender();
      }
    } else if (state.tool === 'measure' || state.tool === 'route') scheduleRender();
  });

  function endPointer(event) {
    if (state.dimension === '3d') return;
    if (!pointers.has(event.pointerId)) return;
    const wasPinching = Boolean(pinch);
    const shouldClick = !wasPinching && activePointer?.id === event.pointerId && !activePointer.moved && event.type === 'pointerup';
    const point = shouldClick && activePointer.pointId ? allPoints().find(candidate => candidate.id === activePointer.pointId) : null;
    pointers.delete(event.pointerId);
    if (wasPinching && pointers.size === 1) {
      const [identifier, position] = [...pointers.entries()][0];
      activePointer = { id: identifier, x: position[0], y: position[1], pan: [...state.pan], moved: true };
    } else activePointer = null;
    pinch = null;
    viewport.classList.remove('dragging');
    if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
    if (shouldClick) {
      if (point && !event.shiftKey && state.tool !== 'artillery') showPopup(point);
      else handleMapClick(point?.position || mapPosition(event.clientX, event.clientY), event.shiftKey);
    }
  }

  viewport.addEventListener('pointerup', endPointer);
  viewport.addEventListener('pointercancel', endPointer);
  viewport.addEventListener('lostpointercapture', endPointer);
  viewport.addEventListener('pointerleave', () => { if (!activePointer) { state.hover = null; scheduleRender(); } });
  viewport.addEventListener('wheel', event => {
    if (state.dimension === '3d') return;
    if (isMapControl(event.target)) return;
    event.preventDefault();
    const rectangle = viewport.getBoundingClientRect();
    const delta = event.deltaY * (event.deltaMode === 1 ? 18 : event.deltaMode === 2 ? state.height : 1);
    zoom(Math.exp(clamp(-delta * .002, -.5, .5)), [event.clientX - rectangle.left, event.clientY - rectangle.top]);
  }, { passive: false });
  viewport.addEventListener('dblclick', event => { if (state.dimension === '2d' && !state.tool && !isMapControl(event.target) && !event.target.closest('.map-marker')) { const rectangle = viewport.getBoundingClientRect(); zoom(1.5, [event.clientX - rectangle.left, event.clientY - rectangle.top]); } });
  element('minimap').addEventListener('click', event => { const rectangle = element('minimap').getBoundingClientRect(); centerOn([(event.clientX - rectangle.left) / rectangle.width * 2048, (event.clientY - rectangle.top) / rectangle.height * 2048]); });

  document.addEventListener('keydown', event => {
    if (event.target.closest('input,textarea,select') || document.querySelector('dialog[open]')) return;
    if (event.key === 'Escape' && artillery?.active && artillery.cameraMode !== 'orbit') { artillery.setView('orbit'); return; }
    if (artillery?.active && ['fly', 'walk'].includes(artillery.cameraMode) && ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.code)) { event.preventDefault(); return; }
    if (event.key === 'Escape') {
      closeSidebar(); element('settings-panel').hidden = true; state.selected = null; popup.hidden = true; clearDrawing(); setTool(null); document.body.classList.remove('map-expanded');
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z' && state.tool) { event.preventDefault(); state.drawing.pop(); scheduleRender(); return; }
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const actions = { m: 'measure', r: 'route', p: 'pin', g: 'grid', f: 'fullscreen', '0': 'reset-view', '?': 'help', '+': 'zoom-in', '=': 'zoom-in', '-': 'zoom-out' };
    if (event.key === '/') { event.preventDefault(); if (state.tool === 'artillery') setTool(null); openSidebar(); element('search').focus(); }
    else if (actions[event.key.toLowerCase()]) { event.preventDefault(); runAction(actions[event.key.toLowerCase()]); }
    else if (document.activeElement === viewport && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) {
      event.preventDefault();
      if (state.dimension === '3d') { if (terrainReady()) terrainView.pan(event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0, event.key === 'ArrowUp' ? 1 : event.key === 'ArrowDown' ? -1 : 0); return; }
      if (event.key === 'ArrowUp') state.pan[1] += 65;
      if (event.key === 'ArrowDown') state.pan[1] -= 65;
      if (event.key === 'ArrowLeft') state.pan[0] += 65;
      if (event.key === 'ArrowRight') state.pan[0] -= 65;
      clampPan(); scheduleRender();
    }
  });

  document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement) document.body.classList.remove('map-expanded'); });
  const resizeObserver = new ResizeObserver(() => {
    const width = viewport.clientWidth;
    const height = viewport.clientHeight;
    state.pan[0] += (width - state.width) / 2;
    state.pan[1] += (height - state.height) / 2;
    state.width = width;
    state.height = height;
    terrainView?.resize();
    clampPan();
    if (!matchMedia('(max-width:900px)').matches) closeSidebar();
    else element('sidebar').inert = !document.body.classList.contains('sidebar-open');
    scheduleRender();
  });
  const hashState = new URLSearchParams(location.hash.slice(1));
  const hashMap = hashState.get('map');
  buildGrid();
  switchMap(Object.hasOwn(maps, hashMap) ? hashMap : Object.hasOwn(maps, stored.mapId) ? stored.mapId : 'bakurani');
  if (state.mapId === stored.mapId && Number.isInteger(stored.control) && stored.control >= 0 && stored.control < currentMap.control.length) { state.control = stored.control; persist(); }
  updateSettings();
  resizeObserver.observe(viewport);
  updateDimensionControls();
  if (!hashState.has('share') && startupDimension === '3d') setDimension('3d');
  if (location.protocol !== 'file:') {
    try {
      workspaceModule = await import('./map-workspace.js');
      workspace = new workspaceModule.MapWorkspace({ viewport, map: () => currentMap, state: () => state, project: screenPosition, mapPosition, kinds, artillery: () => artillery, notify, persist, activate: setTool, rebuildLayers: buildLayers, refresh: () => { if (state.selected && workspace && !workspace.visible(state.selected)) { state.selected = null; popup.hidden = true; } updateVisibleCount(); buildZones(); scheduleRender(); } });
      viewport.dataset.workspace = 'ready';
    } catch (error) { notify('战术扩展加载失败：' + error.message); viewport.dataset.workspace = 'error'; }
  }
  async function applyShared(record) {
    const request = ++sharedRequest;
    const mergedShapes = workspace && record.shapes ? new Map([...workspace.record.shapes, ...record.shapes].map(shape => [shape.id, shape])) : null;
    const mergedFound = workspace && record.display ? [...new Set([...workspace.record.found, ...record.display.found])] : null;
    const mergedHidden = workspace && record.display ? [...new Set([...workspace.record.hidden, ...record.display.hidden])] : null;
    const shapeLimit = workspace?.room ? 500 : 1000;
    if (mergedShapes && mergedShapes.size > shapeLimit) throw new Error('合并分享绘图后超过 ' + shapeLimit + ' 条。');
    if (mergedFound && (mergedFound.length > 10000 || mergedHidden.length > 10000)) throw new Error('合并后地点状态超过容量。');
    if (record.map !== state.mapId) switchMap(record.map);
    for (const name of Object.keys(state.layers)) if (typeof record.layers[name] === 'boolean') state.layers[name] = record.layers[name];
    for (const name of ['grid', 'labels', 'zones']) if (typeof record.settings?.[name] === 'boolean') state.settings[name] = record.settings[name];
    state.settings.areaLayers = Object.fromEntries(Object.keys(defaultLayers).map(kind => [kind, record.areaLayers?.[kind] !== false]));
    if (Number.isInteger(record.faction)) { state.faction = record.faction; element('faction-name').textContent = factions[state.faction].name; document.querySelector('.faction-dot').style.backgroundColor = factions[state.faction].color; }
    if (record.control < currentMap.control.length) { state.control = record.control; element('control-select').value = String(record.control); }
    if (record.display && workspace) { workspace.record.found = mergedFound; workspace.record.hidden = mergedHidden; workspace.record.hideFound = record.display.hideFound; workspace.record.markerSize = record.display.markerSize; workspace.save(false); }
    if (mergedShapes) { workspace.record.shapes = [...mergedShapes.values()]; workspace.drawing.resetHistory(); workspace.save(false); }
    if (record.dimension === '3d') setDimension('3d'); else if (record.dimension === '2d') setDimension('2d');
    buildLayers(); buildMarkers(); buildZones(); updateSettings(); persist(); workspace?.tools.refreshStatus();
    if (record.artillery) { const opened = await runAction('artillery'); if (!opened || request !== sharedRequest || state.mapId !== record.map) return false; artillery.applyState(record.artillery); fitArtillery(artillery.points.filter(Boolean), artillery.trajectory); }
    return true;
  }
  const encoded = hashState.get('share');
  if (encoded && workspaceModule) { try { if (await applyShared(workspaceModule.decodeShare(encoded))) { history.replaceState(null, '', '#' + hashState); notify('已恢复分享的地图、筛选、绘图与炮兵配置。'); } } catch (error) { notify(error.message); } }
  else { if (encoded && startupDimension === '3d') setDimension('3d'); if (hashState.get('tool') === 'artillery') await runAction('artillery'); }
  window.addEventListener('hashchange', async () => { const hash = new URLSearchParams(location.hash.slice(1)); if (hash.has('share') && workspaceModule) { try { const record = workspaceModule.decodeShare(hash.get('share')); if (await applyShared(record)) history.replaceState(null, '', '#' + hash); } catch (error) { notify(error.message); } } });
  scheduleRender();
})();
