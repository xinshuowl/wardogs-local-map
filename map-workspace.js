import { TacticalDrawing, validShape, createLocalId } from './tactical-drawing.js';
import { MapTools } from './map-tools.js';
import { validArtilleryState } from './artillery.js';

const key = 'wardogs-map-workspace:v3';
const mapIds = ['bakurani', 'ozeti', 'zestafona'];
const copy = value => JSON.parse(JSON.stringify(value));
const validId = value => typeof value === 'string' && value.length < 160 && /^[a-z0-9:_.-]+$/i.test(value);
const validFilters = value => value && typeof value === 'object' && !Array.isArray(value) && Object.values(value).every(entry => typeof entry === 'boolean');
export function validateWorkspace(record) {
  if (!record || !Array.isArray(record.shapes) || record.shapes.length > 1000 || !record.shapes.every(validShape)) return false;
  if (!['found', 'hidden'].every(field => Array.isArray(record[field]) && record[field].length <= 10000 && record[field].every(validId))) return false;
  if (!Array.isArray(record.presets) || record.presets.length > 100 || !record.presets.every(preset => validId(preset.id) && typeof preset.name === 'string' && preset.name.trim() && preset.name.length <= 64 && validFilters(preset.layers) && (preset.areaLayers === undefined || validFilters(preset.areaLayers)) && (preset.hideFound === undefined || typeof preset.hideFound === 'boolean'))) return false;
  return Number.isFinite(record.markerSize) && record.markerSize >= .5 && record.markerSize <= 2 && typeof record.hideFound === 'boolean';
}

export function validBackupPreferences(record) {
  if (record.layers !== undefined && !validFilters(record.layers)) return false;
  const settings = record.settings;
  if (settings !== undefined) {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return false;
    if (['grid', 'labels', 'zones', 'shadows', 'collision'].some(field => settings[field] !== undefined && typeof settings[field] !== 'boolean')) return false;
    if (settings.brightness !== undefined && (!Number.isFinite(settings.brightness) || settings.brightness < 45 || settings.brightness > 115)) return false;
    if (settings.modelLoading !== undefined && !['stream', 'preload'].includes(settings.modelLoading)) return false;
    if (settings.view !== undefined && !['tactical', 'satellite'].includes(settings.view) || settings.quality !== undefined && !['auto', 'low', 'balanced', 'high'].includes(settings.quality)) return false;
    if (['models', 'areaLayers'].some(field => settings[field] !== undefined && !validFilters(settings[field]))) return false;
  }
  const view = record.viewState;
  return view === undefined || Boolean(view && mapIds.includes(view.mapId) && ['2d', '3d'].includes(view.dimension) && Number.isFinite(view.heightFactor) && view.heightFactor >= 1 && view.heightFactor <= 3 && Number.isInteger(view.faction) && view.faction >= 0 && view.faction <= 3 && Number.isInteger(view.control) && view.control >= 0 && view.control <= 100);
}

export function encodeShare(record) {
  const bytes = new TextEncoder().encode(JSON.stringify(record));
  if (bytes.length > 500000) throw new Error('分享内容过大，请改用 JSON 备份。');
  return btoa(Array.from(bytes, value => String.fromCharCode(value)).join('')).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function decodeShare(encoded) {
  if (typeof encoded !== 'string' || encoded.length > 700000 || !/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error('分享链接格式无效。');
  const record = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(encoded.replace(/-/g, '+').replace(/_/g, '/')), character => character.charCodeAt(0))));
  if (!mapIds.includes(record.map) || !validFilters(record.layers) || record.artillery && !validArtilleryState(record.artillery) || record.shapes && (!Array.isArray(record.shapes) || record.shapes.length > 500 || !record.shapes.every(validShape))) throw new Error('分享链接包含无效的地图、绘图或炮兵数据。');
  if (record.display && (!['found', 'hidden'].every(field => Array.isArray(record.display[field]) && record.display[field].length <= 10000 && record.display[field].every(validId)) || typeof record.display.hideFound !== 'boolean' || !Number.isFinite(record.display.markerSize) || record.display.markerSize < .5 || record.display.markerSize > 2)) throw new Error('分享链接的地点状态无效。');
  if (record.areaLayers !== undefined && !validFilters(record.areaLayers)) throw new Error('分享链接的区域图层无效。');
  if (record.dimension && !['2d', '3d'].includes(record.dimension) || record.faction !== undefined && (!Number.isInteger(record.faction) || record.faction < 0 || record.faction > 3) || record.control !== undefined && (!Number.isInteger(record.control) || record.control < 0 || record.control > 100) || record.settings && !validFilters(record.settings)) throw new Error('分享链接的显示状态无效。');
  return record;
}

export class MapWorkspace {
  constructor(callbacks) {
    this.callbacks = callbacks;
    this.record = { shapes: [], found: [], hidden: [], presets: [], markerSize: 1, hideFound: false };
    try { const stored = JSON.parse(localStorage.getItem(key) || 'null'); if (validateWorkspace(stored)) this.record = stored; } catch {}
    this.drawing = new TacticalDrawing(this, callbacks);
    this.tools = new MapTools(this, callbacks);
    this.client = createLocalId('client');
    this.roomSession = 0;
    this.sending = null;
    this.roomRevision = 0;
    this.receivedRoom = false;
    this.connected = false;
  }
  save(publish = true) {
    const saved = this.roomBackup ? { ...this.record, shapes: [...new Map([...this.roomBackup, ...this.record.shapes].map(shape => [shape.id, shape])).values()] } : this.record;
    try { localStorage.setItem(key, JSON.stringify(saved)); } catch { this.callbacks.notify('战术数据未能保存，请导出备份。'); }
    this.callbacks.refresh();
    if (publish && this.connected) this.publish();
  }
  visible(point) { const pointKey = this.callbacks.map().id + ':' + point.id; return !this.record.hidden.includes(pointKey) && (!this.record.hideFound || !this.record.found.includes(pointKey)); }
  isFound(point) { return this.record.found.includes(this.callbacks.map().id + ':' + point.id); }
  toggleFound(point) { this.toggle('found', point); }
  toggle(field, point) {
    const pointKey = this.callbacks.map().id + ':' + point.id;
    const items = new Set(this.record[field]);
    if (items.has(pointKey)) items.delete(pointKey); else items.add(pointKey);
    this.record[field] = [...items]; this.save(false);
  }
  render() { this.drawing.render(); }
  snapshot() { const record = copy(this.record); if (this.roomBackup) record.shapes = [...new Map([...this.roomBackup, ...record.shapes].map(shape => [shape.id, shape])).values()]; return record; }
  validate(record) { return validateWorkspace(record); }
  import(record) {
    if (!validateWorkspace(record)) throw new Error('战术绘图或地点状态格式无效。');
    const shapes = new Map(this.record.shapes.map(shape => [shape.id, shape]));
    record.shapes.forEach(shape => { if (!shapes.has(shape.id)) shapes.set(shape.id, shape); });
    if (shapes.size > 1000) throw new Error('导入后绘图超过 1000 条。');
    if (this.room && shapes.size > 500) throw new Error('共享房间最多容纳 500 条绘图，请先离开房间再导入。');
    if (new Set([...this.record.found, ...record.found]).size > 10000 || new Set([...this.record.hidden, ...record.hidden]).size > 10000 || new Set([...this.record.presets, ...record.presets].map(preset => preset.id)).size > 100) throw new Error('合并后地点状态或筛选预设超过容量。');
    this.record = { ...record, shapes: [...shapes.values()], found: [...new Set([...this.record.found, ...record.found])], hidden: [...new Set([...this.record.hidden, ...record.hidden])], presets: [...new Map([...this.record.presets, ...record.presets].map(preset => [preset.id, preset])).values()] };
    this.drawing.resetHistory(); this.save(); this.tools.renderPresets();
  }
  artilleryBackup() {
    const records = {};
    for (const mapId of mapIds) { try { const record = JSON.parse(localStorage.getItem('wardogs-artillery:v2:' + mapId) || 'null'); if (validArtilleryState(record)) records[mapId] = record; } catch {} }
    return records;
  }
  validArtilleryBackup(records) { return records && typeof records === 'object' && !Array.isArray(records) && Object.entries(records).every(([mapId, record]) => mapIds.includes(mapId) && validArtilleryState(record) && Array.isArray(record.presets) && record.presets.length <= 100 && record.presets.every(preset => validArtilleryState(preset) && preset.points.every(Boolean) && typeof preset.name === 'string' && preset.name.trim() && preset.name.length <= 64 && typeof preset.id === 'string' && /^preset-[a-z0-9-]{1,100}$/i.test(preset.id))); }
  prepareArtilleryImport(records) {
    if (!this.validArtilleryBackup(records)) throw new Error('炮兵备份无效。');
    const current = this.artilleryBackup();
    return Object.fromEntries(Object.entries(records).map(([mapId, record]) => {
      const presets = [...new Map([...(current[mapId]?.presets || []), ...record.presets].map(preset => [preset.id, preset])).values()];
      if (presets.length > 100) throw new Error('合并后炮兵预设超过 100 条，请先备份并减少预设。');
      return [mapId, { ...record, presets }];
    }));
  }
  importArtillery(records) {
    const merged = this.prepareArtilleryImport(records);
    for (const [mapId, record] of Object.entries(merged)) localStorage.setItem('wardogs-artillery:v2:' + mapId, JSON.stringify(record));
    const artillery = this.callbacks.artillery();
    if (artillery?.mapId && Object.hasOwn(merged, artillery.mapId)) {
      if (artillery.mapId === this.callbacks.map().id) { artillery.restore(this.callbacks.map()); artillery.updateCoordinates(); artillery.renderPresets(); artillery.refresh(); }
      else artillery.mapId = null;
    }
  }
  async share(artillery) {
    const state = this.callbacks.state();
    const record = { map: this.callbacks.map().id, dimension: state.dimension, layers: state.layers, settings: { grid: state.settings.grid, labels: state.settings.labels, zones: state.settings.zones }, areaLayers: state.settings.areaLayers, faction: state.faction, control: state.control, display: { found: this.record.found.filter(key => key.startsWith(this.callbacks.map().id + ':')), hidden: this.record.hidden.filter(key => key.startsWith(this.callbacks.map().id + ':')), hideFound: this.record.hideFound, markerSize: this.record.markerSize }, artillery: artillery || undefined, shapes: this.record.shapes.filter(shape => shape.mapId === this.callbacks.map().id) };
    if (record.shapes.length > 500) { this.callbacks.notify('分享链接最多包含 500 条绘图，请改用 JSON 备份。'); return null; }
    let encoded;
    try { encoded = encodeShare(record); } catch (error) { this.callbacks.notify(error.message); return null; }
    const hash = '#map=' + record.map + (artillery ? '&tool=artillery' : '') + '&share=' + encoded;
    const url = location.origin + location.pathname + hash;
    history.replaceState(null, '', hash);
    try { await navigator.clipboard.writeText(url); this.callbacks.notify('已复制完整配置链接；另一台电脑需运行同一份本地地图。'); }
    catch { this.tools.showShare(url); }
    return url;
  }
  async join(room) {
    if (!/^[a-z0-9-]{3,40}$/i.test(room)) throw new Error('房间名需要 3–40 位英文字母、数字或横线。');
    this.leave(); if (this.record.shapes.length > 500) throw new Error('请将本机绘图减少到 500 条以内，再加入共享房间。'); this.room = room.toLowerCase();
    const session = this.roomSession;
    const roomName = this.room;
    this.roomBackup = copy(this.record.shapes);
    try {
      const response = await fetch('/api/local/rooms/' + roomName);
      if (session !== this.roomSession) return;
      if (!response.ok) throw new Error('本地实时共享服务不可用。请使用 Node 启动器。');
      const record = await response.json();
      if (session !== this.roomSession) return;
      this.applyRoom(record);
      this.events = new EventSource('/api/local/rooms/' + roomName + '/events');
      this.events.addEventListener('state', event => { if (session !== this.roomSession) return; try { this.applyRoom(JSON.parse(event.data)); } catch { this.callbacks.notify('收到无效共享数据，已忽略。'); } });
      this.events.onopen = () => { if (session !== this.roomSession) return; this.connected = true; this.tools.roomStatus('已连接 · ' + roomName); };
      this.events.onerror = () => { if (session !== this.roomSession) return; this.connected = false; this.tools.roomStatus('连接中断 · 自动重连'); };
      this.tools.roomStatus('正在连接 · ' + roomName);
    } catch (error) { if (session !== this.roomSession) return; this.leave(); throw error; }
  }
  applyRoom(data) {
    if (!Number.isInteger(data.revision) || !Array.isArray(data.shapes) || !data.shapes.every(validShape) || data.shapes.length > 500 || (data.revision < this.roomRevision || data.revision === this.roomRevision && this.receivedRoom)) return;
    this.receivedRoom = true;
    this.roomRevision = data.revision;
    if (data.client !== this.client) { this.record.shapes = copy(data.shapes); this.drawing.resetHistory(); this.save(false); }
  }
  async publish() {
    const session = this.roomSession;
    const room = this.room;
    this.sendPending = true;
    if (this.sending === session) return;
    this.sending = session;
    try {
      while (this.sendPending && this.connected && session === this.roomSession) {
        this.sendPending = false;
        const shapes = copy(this.record.shapes);
        const response = await fetch('/api/local/rooms/' + room, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: this.roomRevision, client: this.client, shapes }) });
        const record = await response.json();
        if (session !== this.roomSession) return;
        if (response.status === 409) { this.applyRoom(record); this.callbacks.notify('另一位队员同时编辑，已加载最新绘图；请重新操作。'); }
        else if (!response.ok) throw new Error('共享保存失败');
        else this.roomRevision = Math.max(this.roomRevision, record.revision);
      }
    } catch { if (session === this.roomSession) this.callbacks.notify('绘图已保存在本机，但未同步到房间。'); }
    finally { if (this.sending === session) this.sending = null; }
  }
  seedRoom() { if (!this.connected) return; const merged = new Map([...(this.roomBackup || []), ...this.record.shapes].map(shape => [shape.id, shape])); if (merged.size > 500) { this.callbacks.notify('房间最多容纳 500 条绘图，请减少本机绘图后再共享。'); return; } this.record.shapes = [...new Map([...(this.roomBackup || []), ...this.record.shapes].map(shape => [shape.id, shape])).values()]; this.save(); }
  leave() {
    this.roomSession = (this.roomSession || 0) + 1; this.room = null; this.sendPending = false;
    this.events?.close(); this.events = null; this.connected = false; this.roomRevision = 0; this.receivedRoom = false;
    if (this.roomBackup) { this.record.shapes = [...new Map([...this.roomBackup, ...this.record.shapes].map(shape => [shape.id, shape])).values()]; this.roomBackup = null; this.drawing.resetHistory(); this.save(false); }
    this.tools?.roomStatus('未连接 · 仅保存在本机');
  }
}
