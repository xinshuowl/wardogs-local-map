import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import { test } from 'node:test';
import vm from 'node:vm';
import { MapWorkspace } from '../map-workspace.js';
import { ArtilleryTool } from '../artillery.js';
import { ArtillerySight } from '../artillery-sight.js';
import { TacticalDrawing, createLocalId } from '../tactical-drawing.js';

const artilleryCss = await readFile(new URL('../artillery.css', import.meta.url), 'utf8');
const enhancementsCss = await readFile(new URL('../enhancements.css', import.meta.url), 'utf8');

const appSource = await readFile(new URL('../app.js', import.meta.url), 'utf8');
const map = { id: 'bakurani', bounds: [0, 0, 1638400], center: [1024, 1024], control: [{}, {}, {}] };
const shape = identifier => ({ id: 'shape-' + identifier, mapId: map.id, type: 'line', color: '#d5ed79', width: 3, points: [[100, 200], [300, 400]], text: '' });
const artilleryState = () => ({ weapon: 'l81-mortar', arc: 'low', points: [[100, 100], [140, 100]], overrides: [null, null], presets: [], correction: { add: 0, right: 0 }, step: 25 });
const deferred = () => { let resolve; let reject; const promise = new Promise((accept, decline) => { resolve = accept; reject = decline; }); return { promise, resolve, reject }; };

function mockGlobal(context, name, value) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  context.after(() => { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; });
}

function memoryStorage(context) {
  const records = new Map();
  mockGlobal(context, 'localStorage', { getItem: key => records.get(key) ?? null, setItem: (key, value) => records.set(key, value) });
  return records;
}

function node() {
  const children = new Map();
  const classes = new Set();
  const attributes = new Map();
  const listeners = new Map();
  return {
    value: '', innerHTML: '', hidden: false, dataset: {}, style: {},
    classList: { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name), toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name) },
    querySelector(selector) { if (!children.has(selector)) children.set(selector, node()); return children.get(selector); },
    querySelectorAll: () => [], append() {}, insertAdjacentHTML() {}, setCustomValidity() {},
    setAttribute: (name, value) => attributes.set(name, String(value)), getAttribute: name => attributes.get(name) ?? null, removeAttribute: name => attributes.delete(name),
    addEventListener(name, listener, options = {}) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push({ listener, capture: options.capture === true }); },
    emit(name, event = {}) {
      let stopped = false;
      const dispatched = { preventDefault() {}, ...event, stopImmediatePropagation() { stopped = true; } };
      for (const entry of [...(listeners.get(name) || [])].sort((first, second) => Number(second.capture) - Number(first.capture))) { entry.listener(dispatched); if (stopped) break; }
    },
    replaceChildren() { this.innerHTML = ''; }
  };
}

function artilleryControls(context, dimension = '3d') {
  const panel = node();
  const viewbar = node();
  const sight = node(); sight.hidden = true;
  const viewButtons = Object.fromEntries(['orbit', 'fly', 'walk', 'gun', 'target', 'sight'].map(mode => [mode, Object.assign(node(), { dataset: { artView: mode } })]));
  const placementButtons = [0, 1].map(index => Object.assign(node(), { dataset: { artPoint: String(index) } }));
  viewbar.querySelectorAll = selector => selector === '[data-art-view]' ? Object.values(viewButtons) : [];
  panel.querySelectorAll = selector => selector === '[data-art-point]' ? placementButtons : [];
  const document = Object.assign(node(), { body: node(), getElementById: identifier => identifier === 'artillery-sight' ? sight : viewbar, createElement: () => node(), querySelector: () => null });
  mockGlobal(context, 'document', document);
  memoryStorage(context);
  const views = [];
  const tool = new ArtilleryTool(panel, { map: () => map, dimension: () => dimension, sceneReady: () => true, onView: mode => views.push(mode), onPick: () => tool.setView('orbit'), onTrajectory() {}, notify() {} });
  Object.assign(tool, artilleryState(), { mapId: map.id, metadata: { gun: [100, 100], target: [140, 100], originHeight: 0, targetHeight: 0, range: 320, bearing: 90 } });
  tool.loadHeights = () => {};
  tool.refresh = () => { tool.refreshPlacement(); tool.updateViewControls(); };
  const clickView = mode => viewbar.emit('click', { target: { closest: () => viewButtons[mode] } });
  const clickPlacement = index => panel.emit('click', { target: { closest: () => placementButtons[index] } });
  const pressed = (button, expected) => { assert.equal(button.getAttribute('aria-pressed'), String(expected)); assert.equal(button.classList.contains('active'), expected); };
  return { tool, document, sight, viewButtons, placementButtons, views, clickView, clickPlacement, pressed };
}

function workspace() {
  return Object.assign(Object.create(MapWorkspace.prototype), {
    record: { shapes: [shape('local')], found: [], hidden: [], presets: [], markerSize: 1, hideFound: false },
    client: 'client-audit', roomSession: 0, roomRevision: 0, receivedRoom: false, connected: false, sending: null,
    drawing: { resetHistory() {} }, tools: { roomStatus() {}, renderPresets() {} },
    callbacks: { refresh() {}, notify() {}, map: () => map, state: () => ({ dimension: '2d', layers: {}, settings: {} }) }
  });
}

function eventSources(context) {
  const streams = [];
  mockGlobal(context, 'EventSource', class {
    constructor(url) { this.url = url; streams.push(this); }
    addEventListener(name, callback) { this[name] = callback; }
    close() { this.closed = true; }
  });
  return streams;
}

function appFunction(name) {
  const start = appSource.search(new RegExp('^  (?:async )?function ' + name + '\\(', 'm'));
  assert.notEqual(start, -1);
  const end = appSource.indexOf('\n  }', start);
  assert.notEqual(end, -1);
  return appSource.slice(start, end + 4);
}

function appHarness() {
  const elements = new Map();
  const counters = { constructed: 0, persisted: 0 };
  const context = {
    state: { tool: null, tab: 'layers', mapId: map.id, dimension: '2d', drawing: [], layers: {}, faction: 0 },
    currentMap: map, artillery: null, artilleryModule: null, artilleryRequest: 0, terrainView: null, workspace: null, inspectedModel: null,
    location: { protocol: 'http:' }, history: { replaceState() {} }, viewport: node(), popup: node(),
    document: { body: node(), querySelector: () => node(), querySelectorAll: () => [] },
    element(identifier) { if (!elements.has(identifier)) elements.set(identifier, node()); return elements.get(identifier); },
    mapPosition() {}, terrainReady: () => false, fitArtillery() {}, scheduleRender() {}, closeSidebar() {}, openSidebar() {}, buildMarkers() {}, buildZones() {},
    setTab(tab) { context.state.tab = tab; }, persist() { counters.persisted++; },
    notifications: [], notify(message) { context.notifications.push(message); },
    allPoints: () => [], kinds: {}, icon: () => '', escape: String,
    factions: [{ name: 'neutral', color: '#fff' }, { name: 'blue', color: '#00f' }]
  };
  class FakeArtillery {
    constructor() { counters.constructed++; this.points = []; }
    open() { this.active = true; }
    close() { this.active = false; }
  }
  const functions = vm.runInNewContext(['clearDrawing', 'setTool', 'runAction', 'searchPoints'].map(appFunction).join('\n') + '\n({setTool,runAction,searchPoints})', context);
  return { context, functions, counters, module: { ArtilleryTool: FakeArtillery } };
}

await test('LAN identifiers work when randomUUID is unavailable', context => {
  mockGlobal(context, 'crypto', { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) });
  const identifiers = Array.from({ length: 200 }, () => createLocalId('client'));
  assert.equal(new Set(identifiers).size, identifiers.length);
  assert.ok(identifiers.every(identifier => /^client-[a-z0-9-]{1,60}$/i.test(identifier)));
  for (const prefix of ['shape', 'filter', 'preset']) assert.match(createLocalId(prefix), new RegExp('^' + prefix + '-[a-z0-9-]+$'));
});

await test('leaving while a room join is pending cannot reconnect or replace drawings', async context => {
  memoryStorage(context);
  const streams = eventSources(context);
  const pending = deferred();
  mockGlobal(context, 'fetch', () => pending.promise);
  const current = workspace();
  const joining = current.join('audit-room');
  current.leave();
  pending.resolve({ ok: true, json: async () => ({ revision: 1, client: 'client-other', shapes: [shape('remote')] }) });
  await joining;
  assert.equal(streams.length, 0);
  assert.equal(current.record.shapes[0].id, 'shape-local');
  assert.equal(current.room, null);
});

await test('only the latest room join and its SSE callbacks update state', async context => {
  memoryStorage(context);
  const streams = eventSources(context);
  const pending = [deferred(), deferred()];
  let request = 0;
  mockGlobal(context, 'fetch', () => pending[request++].promise);
  const current = workspace();
  const first = current.join('room-one');
  const second = current.join('room-two');
  pending[1].resolve({ ok: true, json: async () => ({ revision: 1, shapes: [shape('two')] }) });
  await second;
  pending[0].resolve({ ok: true, json: async () => ({ revision: 99, shapes: [shape('one')] }) });
  await first;
  assert.equal(current.room, 'room-two');
  assert.equal(current.record.shapes[0].id, 'shape-two');
  assert.equal(streams.length, 1);
  current.leave();
  streams[0].onopen();
  streams[0].state({ data: JSON.stringify({ revision: 100, shapes: [shape('stale')] }) });
  assert.equal(current.connected, false);
  assert.equal(current.record.shapes.some(entry => entry.id === 'shape-stale'), false);
});

await test('failed room join restores local mode and clears its backup', async context => {
  memoryStorage(context);
  mockGlobal(context, 'fetch', async () => ({ ok: false }));
  const current = workspace();
  await assert.rejects(current.join('audit-room'), /Node/);
  assert.equal(current.room, null);
  assert.equal(current.roomBackup, null);
  assert.equal(current.record.shapes[0].id, 'shape-local');
});

await test('old room POST responses cannot overwrite a new session or block its save', async context => {
  memoryStorage(context);
  let pending; let request;
  mockGlobal(context, 'fetch', () => pending[request++].promise);
  for (const status of [200, 409]) {
    pending = [deferred(), deferred()];
    request = 0;
    const current = workspace();
    current.room = 'room-old'; current.connected = true; current.roomRevision = 7;
    const first = current.publish();
    current.leave();
    current.room = 'room-new'; current.connected = true;
    const second = current.publish();
    assert.equal(request, 2);
    pending[0].resolve({ ok: status === 200, status, json: async () => ({ revision: 8, client: 'client-other', shapes: [shape('stale')] }) });
    await first;
    assert.equal(current.roomRevision, 0);
    assert.equal(current.record.shapes[0].id, 'shape-local');
    pending[1].resolve({ ok: true, status: 200, json: async () => ({ revision: 1 }) });
    await second;
    assert.equal(current.roomRevision, 1);
    assert.equal(current.sending, null);
  }
});

await test('artillery import survives reopening and export after closing the panel', context => {
  const records = memoryStorage(context);
  mockGlobal(context, 'document', { body: node() });
  const tool = Object.assign(Object.create(ArtilleryTool.prototype), artilleryState(), {
    mapId: map.id, active: false, callbacks: { map: () => map, notify() {} }, panel: node(), coordinateInputs: [],
    coordinateUpdates: 0, updateCoordinates() { this.coordinateUpdates++; }, renderPresets() {}, refresh() {}, gunnerSight: { show() {} }, loadHeights() {}
  });
  const current = workspace(); current.callbacks.artillery = () => tool;
  const imported = { ...artilleryState(), points: [[500, 500], [540, 500]] };
  current.importArtillery({ bakurani: imported });
  assert.equal(tool.coordinateUpdates, 1);
  tool.open(); tool.persist();
  assert.deepEqual(JSON.parse(records.get('wardogs-artillery:v2:bakurani')).points, imported.points);
  tool.active = false;
  current.callbacks.map = () => ({ ...map, id: 'ozeti' });
  current.importArtillery({ bakurani: { ...imported, weapon: 'l52-cannon' } });
  tool.persist();
  assert.equal(tool.mapId, null);
  assert.equal(JSON.parse(records.get('wardogs-artillery:v2:bakurani')).weapon, 'l52-cannon');
});

await test('room imports reject oversize merges before altering existing shapes', () => {
  const current = workspace(); current.room = 'audit-room';
  const incoming = { ...current.record, shapes: Array.from({ length: 500 }, (_, index) => shape(index)) };
  assert.throws(() => current.import(incoming), /500/);
  assert.equal(current.record.shapes.length, 1);
});

await test('oversize shares fail visibly without creating unusable URLs', async () => {
  const current = workspace();
  const notifications = []; current.callbacks.notify = message => notifications.push(message);
  current.record.shapes = Array.from({ length: 501 }, (_, index) => shape(index));
  assert.equal(await current.share(), null);
  assert.match(notifications[0], /500/);
  current.record.shapes = Array.from({ length: 30 }, (_, index) => ({ ...shape(index), type: 'freehand', points: Array.from({ length: 2048 }, () => [123.123, 456.456]) }));
  assert.equal(await current.share(), null);
  assert.match(notifications[1], /JSON/);
});

await test('2D and 3D artillery markers have distinct, balanced drag groups', () => {
  const tool = Object.assign(Object.create(ArtilleryTool.prototype), artilleryState(), { active: true, callbacks: { map: () => map } });
  for (const dimension of ['2d', '3d']) {
    const overlay = {}; tool.renderOverlay(overlay, point => point, dimension, 1);
    const groups = []; const markers = [];
    for (const token of overlay.innerHTML.matchAll(/<g\b[^>]*>|<\/g>|<text\b[^>]*>([^<]*)<\/text>/g)) {
      if (token[0].startsWith('<g')) groups.push(token[0].match(/data-art-marker="([01])"/)?.[1]);
      else if (token[0] === '</g>') { assert.ok(groups.length); groups.pop(); }
      else markers.push({ title: token[1], index: groups.at(-1) });
    }
    assert.equal(groups.length, 0);
    assert.deepEqual(markers, [{ title: '炮位', index: '0' }, { title: '目标', index: '1' }]);
  }
});

await test('failed height manifest is retried and successful heights are cached', async context => {
  const tool = Object.assign(Object.create(ArtilleryTool.prototype), { heightCache: new Map(), heightRequests: new Map(), heightErrors: new Map(), active: false });
  let manifests = 0; let binaries = 0;
  mockGlobal(context, 'fetch', async url => {
    if (url.endsWith('manifest.json')) {
      if (++manifests === 1) throw new Error('synthetic failure');
      return { ok: true, json: async () => ({ bakurani: { file: 'synthetic.bin', cols: 2, rows: 2 } }) };
    }
    binaries++;
    return { ok: true, arrayBuffer: async () => new Uint16Array([32768, 32768, 32768, 32768]).buffer };
  });
  await tool.loadHeights(map);
  assert.equal(tool.heightErrors.get(map.id), 'synthetic failure');
  await tool.loadHeights(map);
  await tool.loadHeights(map);
  assert.equal(manifests, 2);
  assert.equal(binaries, 1);
  assert.equal(tool.heightErrors.has(map.id), false);
  assert.equal(tool.heightCache.get(map.id).heights.length, 4);
});

await test('pending collision sampling keeps the originating map after a switch', () => {
  const tool = Object.assign(Object.create(ArtilleryTool.prototype), {
    mapId: 'ozeti', callbacks: { map: () => ({ ...map, id: 'ozeti' }), heightAt: () => 999 },
    heightCache: new Map([[map.id, { descriptor: { cols: 2, rows: 2, origin: [0, 0], step: [1638400, 1638400], heightOffset: 12000, heightScale: 1 }, heights: new Uint16Array([32768, 32768, 32768, 32768]) }]])
  });
  assert.equal(tool.heightAt([100, 100], map), 120);
  assert.equal(tool.heightAt([100, 100]), 999);
});

await test('drawing cancellation restores geometry, history and pointer capture', () => {
  for (const ending of ['outside', 'close', 'pointercancel']) {
    let saved = 0; let captured = null;
    const state = { tool: 'drawing' };
    const drawing = Object.assign(Object.create(TacticalDrawing.prototype), {
      workspace: { record: { shapes: [shape('edit')] }, save() { saved++; } }, mode: 'move', svg: {}, toolbar: {}, updateControls() {},
      callbacks: { state: () => state, map: () => map, activate: tool => { state.tool = tool; }, project: point => point, mapPosition: (horizontal, vertical) => [horizontal, vertical], viewport: { getBoundingClientRect: () => ({ left: 0, top: 0 }), setPointerCapture: identifier => { captured = identifier; }, hasPointerCapture: identifier => captured === identifier, releasePointerCapture: () => { captured = null; } } }
    });
    drawing.resetHistory();
    const pointer = (name, horizontal, vertical, pointerId = 7) => drawing.pointer(name, { target: { closest: () => null }, button: 0, pointerId, clientX: horizontal, clientY: vertical, stopImmediatePropagation() {} });
    pointer('pointerdown', 200, 300);
    pointer('pointermove', 220, 310);
    const moved = structuredClone(drawing.workspace.record.shapes[0]);
    pointer('pointermove', 800, 800, 9);
    assert.deepEqual(drawing.workspace.record.shapes[0], moved);
    if (ending === 'close') drawing.close();
    else pointer(ending === 'outside' ? 'pointerup' : 'pointercancel', -1, -1);
    assert.deepEqual(drawing.workspace.record.shapes[0], shape('edit'));
    assert.equal(saved, 0);
    assert.equal(drawing.history.length, 1);
    assert.equal(captured, null);
  }
});

await test('artillery lazy activation constructs once and respects later tool choices', async () => {
  const first = appHarness(); const pending = deferred(); first.context.artilleryModule = pending.promise;
  const earlier = first.functions.runAction('artillery');
  const later = first.functions.runAction('artillery');
  pending.resolve(first.module);
  assert.deepEqual(await Promise.all([earlier, later]), [false, true]);
  assert.equal(first.counters.constructed, 1);
  const second = appHarness(); const cancelled = deferred(); second.context.artilleryModule = cancelled.promise;
  const opening = second.functions.runAction('artillery');
  await second.functions.runAction('measure');
  cancelled.resolve(second.module);
  assert.equal(await opening, false);
  assert.equal(second.context.state.tool, 'measure');
  assert.equal(second.counters.constructed, 0);
});

await test('artillery module failure is reported and a later activation succeeds', async () => {
  const current = appHarness(); current.context.artilleryModule = Promise.reject(new Error('synthetic module error'));
  assert.equal(await current.functions.runAction('artillery'), false);
  assert.equal(current.context.artilleryModule, null);
  assert.match(current.context.notifications[0], /synthetic module error/);
  current.context.artilleryModule = Promise.resolve(current.module);
  assert.equal(await current.functions.runAction('artillery'), true);
});

await test('saved navigation exits artillery and faction changes persist immediately', async () => {
  const current = appHarness(); current.context.artilleryModule = Promise.resolve(current.module);
  await current.functions.runAction('artillery');
  await current.functions.runAction('saved');
  assert.equal(current.context.artillery.active, false);
  assert.equal(current.context.state.tool, null);
  assert.equal(current.context.state.tab, 'saved');
  await current.functions.runAction('faction');
  assert.equal(current.context.state.faction, 1);
  assert.equal(current.counters.persisted, 1);
});

await test('clearing search removes stale results before Enter can locate them', () => {
  const current = appHarness();
  current.context.element('search-results').innerHTML = '<button data-locate="stale">stale</button>';
  current.context.element('search').value = '  ';
  current.functions.searchPoints();
  assert.equal(current.context.element('search-results').innerHTML, '');
  assert.equal(current.context.element('search-results').hidden, true);
});

await test('completed routes stay visible until another map tool is activated', () => {
  const current = appHarness();
  current.context.state.tool = 'route';
  current.context.state.drawing = [[100, 100], [150, 120], [170, 170]];
  current.functions.setTool(null);
  assert.equal(current.context.state.drawing.length, 3);
  assert.equal(current.context.element('measurement-card').hidden, false);
  current.functions.setTool('drawing');
  assert.equal(current.context.state.drawing.length, 0);
  assert.equal(current.context.element('measurement-card').hidden, true);
  assert.equal(current.context.element('minimap').hidden, false);
});

await test('startup restores control selection and starts 3D before optional workspace import', () => {
  const start = appSource.indexOf('  const hashState =');
  const end = appSource.indexOf("  if (location.protocol !== 'file:')", start);
  for (const dimension of ['2d', '3d']) {
    const state = { mapId: map.id, dimension: '2d', control: 0 };
    let persisted;
    const context = {
      URLSearchParams, location: { hash: '' }, state, maps: { bakurani: map }, currentMap: map,
      stored: { mapId: map.id, control: 2 }, startupDimension: dimension,
      buildGrid() {}, switchMap() { state.control = 0; context.persist(); },
      persist() { persisted = { ...state }; }, updateSettings() {}, updateDimensionControls() {},
      viewport: {}, resizeObserver: { observe() {} }, setDimension(value) { state.dimension = value; }
    };
    vm.runInNewContext(appSource.slice(start, end), context);
    assert.equal(state.control, 2);
    assert.equal(persisted.control, 2);
    assert.equal(state.dimension, dimension);
  }
});

await test('Sight pressed state follows toggle, own close, Esc and reopening', context => {
  const current = artilleryControls(context);
  const check = expected => { assert.equal(current.sight.hidden, !expected); current.pressed(current.viewButtons.sight, expected); };
  current.tool.open(); check(true);
  current.clickView('sight'); check(false);
  current.clickView('sight'); check(true);
  assert.equal(current.tool.cameraMode, 'orbit');
  assert.deepEqual(current.views, []);
  current.sight.querySelector('[data-sight-close]').emit('click'); check(false);
  current.clickView('sight');
  current.sight.querySelector('[data-sight-expand]').emit('click');
  assert.equal(current.tool.gunnerSight.full, true);
  current.document.emit('keydown', { key: 'Escape' }); check(true);
  assert.equal(current.tool.gunnerSight.full, false);
  current.document.emit('keydown', { key: 'Escape' }); check(false);
  current.tool.close(); check(false);
  current.tool.open(); check(true);
  current.tool.close(); check(false);
  current.tool.open(); check(true);
});

await test('Gun and Target pressed states follow placement in both toolbars, independently of closeup cameras', context => {
  const current = artilleryControls(context);
  const check = index => {
    assert.equal(current.tool.nextPoint, index);
    current.pressed(current.viewButtons.gun, index === 0);
    current.pressed(current.viewButtons.target, index === 1);
    current.placementButtons.forEach((button, candidate) => current.pressed(button, candidate === index));
  };
  current.tool.open(); check(1);
  current.clickView('gun'); check(0);
  assert.equal(current.tool.cameraMode, 'orbit');
  current.clickPlacement(1); check(1);
  assert.equal(current.tool.cameraMode, 'orbit');
  current.clickPlacement(0); check(0);
  current.clickView('target'); check(1);
  assert.ok(current.views.every(mode => mode === 'orbit'));
  current.tool.setView('gun'); check(1);
  current.tool.updateViewControls(); check(1);
  current.clickView('gun');
  current.tool.setView('target'); check(0);
  current.tool.setPoint(0, [110, 110]); check(1);
  current.tool.handleClick({ target: { closest: () => ({ dataset: { art: 'clear' } }) } }); check(0);
  current.tool.close(); current.tool.open(); check(0);
});

await test('camera refresh and navigation Esc preserve independent Sight and placement state', context => {
  const current = artilleryControls(context);
  current.tool.open();
  current.tool.setView('fly');
  current.tool.updateViewControls();
  current.pressed(current.viewButtons.fly, true);
  current.pressed(current.viewButtons.target, true);
  current.pressed(current.viewButtons.sight, true);
  const viewCount = current.views.length;
  current.clickView('sight');
  current.pressed(current.viewButtons.sight, false);
  assert.equal(current.tool.cameraMode, 'fly');
  assert.equal(current.views.length, viewCount);
  current.clickView('sight');
  current.document.emit('keydown', { key: 'Escape' });
  current.pressed(current.viewButtons.orbit, true);
  current.pressed(current.viewButtons.fly, false);
  current.pressed(current.viewButtons.sight, true);
  current.document.emit('keydown', { key: 'Escape' });
  current.pressed(current.viewButtons.sight, false);
  current.pressed(current.viewButtons.target, true);
});

await test('2D view refresh keeps Sight visibility and selected placement pressed', context => {
  const current = artilleryControls(context, '2d');
  current.tool.open();
  current.clickView('gun');
  current.tool.updateViewControls();
  current.pressed(current.viewButtons.gun, true);
  current.pressed(current.viewButtons.target, false);
  current.pressed(current.viewButtons.orbit, true);
  current.pressed(current.viewButtons.sight, true);
  current.clickView('sight');
  current.tool.updateViewControls();
  current.pressed(current.viewButtons.sight, false);
  current.pressed(current.viewButtons.gun, true);
});

function mapPointerHarness() {
  const viewport = node();
  const captures = new Set();
  Object.assign(viewport, {
    focus() {}, getBoundingClientRect: () => ({ left: 0, top: 0 }),
    setPointerCapture: identifier => captures.add(identifier),
    hasPointerCapture: identifier => captures.has(identifier),
    releasePointerCapture(identifier) { captures.delete(identifier); viewport.emit('lostpointercapture', { pointerId: identifier, type: 'lostpointercapture' }); }
  });
  const point = { id: 'tower-1', position: [20, 30] };
  const marker = { dataset: { point: point.id } };
  const target = { closest: selector => selector === '.map-marker' ? marker : null };
  const calls = [];
  const context = {
    state: { dimension: '2d', scale: 2, pan: [0, 0], width: 600, height: 400, tool: null },
    viewport, activePointer: null, pinch: null, pointers: new Map(), captures,
    allPoints: () => [point], showPopup: value => calls.push({ type: 'marker', point: value }),
    handleMapClick: (position, shiftKey) => calls.push({ type: 'map', position, shiftKey }),
    clamp: (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value)),
    mapPosition: (horizontal, vertical) => [horizontal / 2, vertical / 2],
    clampPan() {}, scheduleRender() {}, element: () => node(), coordinatesText: () => '', zoom: () => calls.push({ type: 'zoom' })
  };
  const start = appSource.indexOf("  viewport.addEventListener('pointerdown'");
  const end = appSource.indexOf("  element('minimap').addEventListener", start);
  vm.runInNewContext(appFunction('isMapControl') + '\n' + appSource.slice(start, end), context);
  const emit = (type, options = {}) => viewport.emit(type, { type, pointerId: 1, clientX: 40, clientY: 60, button: 0, target, ...options });
  return { context, point, calls, emit };
}

await test('2D marker taps open details exactly once after pointer capture is released', () => {
  const current = mapPointerHarness();
  current.emit('pointerdown'); current.emit('pointerup');
  assert.deepEqual(current.calls, [{ type: 'marker', point: current.point }]);
  assert.equal(current.context.captures.size, 0);
  assert.equal(current.context.pointers.size, 0);
  assert.equal(current.context.activePointer, null);
});

await test('2D marker drags pan without opening a popup or placing a point', () => {
  const current = mapPointerHarness();
  current.emit('pointerdown'); current.emit('pointermove', { clientX: 140, clientY: 110 }); current.emit('pointerup');
  assert.deepEqual(Array.from(current.context.state.pan), [100, 50]);
  assert.equal(current.calls.length, 0);
  assert.equal(current.context.viewport.classList.contains('dragging'), false);
});

await test('2D marker Shift-click and artillery placement use the marker coordinate', () => {
  const current = mapPointerHarness();
  current.emit('pointerdown'); current.emit('pointerup', { shiftKey: true });
  assert.deepEqual(current.calls[0], { type: 'map', position: current.point.position, shiftKey: true });
  current.context.state.tool = 'artillery';
  current.emit('pointerdown'); current.emit('pointerup');
  assert.deepEqual(current.calls[1].position, current.point.position);
  assert.equal(current.calls[1].type, 'map');
});

await test('2D cancellation and lost capture cannot place points or leave dragging stuck', () => {
  for (const type of ['pointercancel', 'lostpointercapture']) {
    const current = mapPointerHarness();
    current.emit('pointerdown'); current.emit(type);
    current.emit('pointermove', { clientX: 180 }); current.emit('pointerup');
    assert.equal(current.calls.length, 0);
    assert.equal(current.context.activePointer, null);
    assert.equal(current.context.pointers.size, 0);
    assert.deepEqual(current.context.state.pan, [0, 0]);
  }
});

await test('2D pinch followed by single-finger movement never becomes a marker tap', () => {
  const current = mapPointerHarness();
  current.emit('pointerdown'); current.emit('pointerdown', { pointerId: 2, clientX: 100 });
  current.emit('pointermove', { pointerId: 2, clientX: 160 });
  assert.equal(current.context.state.scale, 4);
  current.emit('pointerup', { pointerId: 2 }); current.emit('pointermove', { clientX: 80 }); current.emit('pointerup');
  assert.equal(current.calls.length, 0);
  assert.equal(current.context.pointers.size, 0);
});

await test('2D panel interactions do not pan, zoom or place map points', () => {
  const current = mapPointerHarness();
  const target = { closest: selector => selector.includes('.artillery-sight') ? {} : null };
  current.emit('pointerdown', { target }); current.emit('pointerup', { target });
  current.emit('wheel', { target, deltaY: 100 }); current.emit('dblclick', { target });
  assert.equal(current.calls.length, 0);
  assert.equal(current.context.captures.size, 0);
});

await test('artillery range rings never enlarge the draggable gun or target hit areas', () => {
  const tool = Object.assign(Object.create(ArtilleryTool.prototype), artilleryState(), { active: true, callbacks: { map: () => map } });
  const overlay = node();
  tool.renderOverlay(overlay, position => position, '2d', 2);
  const handles = [...overlay.innerHTML.matchAll(/<g\b[^>]*data-art-marker="([01])"[^>]*>([\s\S]*?)<\/g>/g)];
  assert.deepEqual(handles.map(match => match[1]), ['0', '1']);
  for (const handle of handles) {
    const radii = [...handle[2].matchAll(/<circle\b[^>]*\sr="([\d.]+)"/g)].map(match => Number(match[1]));
    assert.deepEqual(radii, [10, 3]);
    assert.doesNotMatch(handle[2], /stroke-dasharray/);
  }
  const passiveMarkup = overlay.innerHTML.replace(/<g\b[^>]*>[\s\S]*?<\/g>/g, '');
  assert.equal([...passiveMarkup.matchAll(/<circle\b/g)].length, 2);
});

await test('collapsed navigation diagnostics hide their controls until opened', () => {
  assert.match(artilleryCss, /\.navigation-diagnostics:not\(\[open\]\)\s*>\s*\.navigation-performance\s*\{\s*display:\s*none;/);
  assert.match(artilleryCss, /\.artillery-navigation\s*\{[^}]*z-index:\s*24;/);
  assert.match(enhancementsCss, /\.scene-quality:not\(\[open\]\)\s*>\s*:not\(summary\)\s*\{\s*display:\s*none/);
});

await test('expanded Sight leaves the clipped map container and restores it on collapse or close', context => {
  const container = { append(child) { child.parentElement = this; } };
  const body = { append(child) { child.parentElement = this; } };
  mockGlobal(context, 'document', { ...node(), body });
  const element = node();
  container.append(element);
  const sight = new ArtillerySight(element);
  sight.show(); sight.expand(true);
  assert.equal(element.parentElement, body);
  sight.expand(false);
  assert.equal(element.parentElement, container);
  assert.equal(element.hidden, false);
  sight.expand(true); sight.hide();
  assert.equal(element.parentElement, container);
  assert.equal(element.hidden, true);
  assert.equal(sight.full, false);
});
