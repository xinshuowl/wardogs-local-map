import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';
import { createSteamPlayersService } from '../steam-players.mjs';

const initialTime = Date.UTC(2026, 9, 6, 9);
const response = data => ({ ok: true, json: async () => data });

await test('concurrent requests share one fetch and cache the Steam total for a minute', async () => {
  let clock = initialTime;
  let requests = 0;
  const getPlayers = createSteamPlayersService({ now: () => clock, fetcher: async url => {
    requests++;
    assert.equal(url, 'https://metaforge.app/api/wardogs/server-status?summary=1');
    return response({ steam_players: 83499, steam_checked_at: clock, totals: { players: 5 } });
  } });
  const results = await Promise.all([getPlayers(), getPlayers(), getPlayers()]);
  assert.equal(requests, 1);
  assert.ok(results.every(result => result.appId === 1867240 && result.playerCount === 83499 && !result.stale));
  clock += 59999;
  await getPlayers();
  assert.equal(requests, 1);
  clock++;
  await getPlayers();
  assert.equal(requests, 2);
});

await test('falls back to the correct Steam app and accepts a genuine zero', async () => {
  const urls = [];
  const getPlayers = createSteamPlayersService({ now: () => initialTime, fetcher: async url => {
    urls.push(url);
    if (urls.length === 1) throw new Error('Reference offline');
    return response({ response: { result: 1, player_count: 0 } });
  } });
  const result = await getPlayers();
  assert.match(urls[1], /GetNumberOfCurrentPlayers\/v1\/\?appid=1867240$/);
  assert.equal(result.playerCount, 0);
  assert.equal(result.source, 'Steam');
  assert.equal(result.stale, false);
});

await test('invalid, missing and old upstream counts are never presented as live', async () => {
  for (const data of [
    { steam_players: null, steam_checked_at: initialTime },
    { steam_players: -1, steam_checked_at: initialTime },
    { steam_players: '83499', steam_checked_at: initialTime },
    { steam_players: 83499, steam_checked_at: initialTime - 150001 },
    { steam_players: 83499, steam_checked_at: initialTime + 60001 },
    { steam_players: 83499 },
    {}
  ]) {
    const getPlayers = createSteamPlayersService({ now: () => initialTime, fetcher: async url => response(url.includes('metaforge') ? data : { response: { result: 42, player_count: 0 } }) });
    const result = await getPlayers();
    assert.equal(result.playerCount, null);
    assert.equal(result.updatedAt, null);
  }
});

await test('an outage retains a marked last count, backs off, expires and recovers', async () => {
  let clock = initialTime;
  let online = true;
  let requests = 0;
  const getPlayers = createSteamPlayersService({ now: () => clock, fetcher: async () => {
    requests++;
    if (!online) throw new Error('Offline');
    return response({ steam_players: 4567, steam_checked_at: clock });
  } });
  await getPlayers();
  online = false;
  clock += 60000;
  const stale = await getPlayers();
  assert.equal(stale.playerCount, 4567);
  assert.equal(stale.updatedAt, new Date(initialTime).toISOString());
  assert.equal(stale.stale, true);
  const attempts = requests;
  await getPlayers();
  assert.equal(requests, attempts);
  clock += 900001;
  assert.equal((await getPlayers()).playerCount, null);
  online = true;
  clock += 60000;
  assert.equal((await getPlayers()).stale, false);
});

const browserSource = await readFile(new URL('../steam-online.js', import.meta.url), 'utf8');

function browserHarness({ protocol = 'http:', playerCount = 83499, hidden = false } = {}) {
  let clock = initialTime;
  let fail = false;
  let requests = 0;
  const nodes = Object.fromEntries(['steam-online', 'steam-player-count', 'steam-player-state'].map(identifier => [identifier, { dataset: {}, textContent: '', title: '' }]));
  const events = new Map();
  const timers = new Map();
  let timerId = 0;
  const document = { hidden, getElementById: identifier => nodes[identifier], addEventListener: (name, handler) => events.set(name, handler) };
  const navigator = { onLine: true };
  class TestDate extends Date { static now() { return clock; } }
  vm.runInNewContext(browserSource, {
    Date: TestDate, document, navigator, location: { protocol }, AbortController,
    window: { addEventListener: (name, handler) => events.set(name, handler) },
    setTimeout: (callback, delay) => { timers.set(++timerId, { callback, delay }); return timerId; },
    clearTimeout: identifier => timers.delete(identifier),
    fetch: async url => {
      assert.equal(url, '/api/steam/players');
      requests++;
      if (fail) throw new Error('Offline');
      return response({ appId: 1867240, playerCount, updatedAt: new Date(clock).toISOString(), source: 'MetaForge / Steam', stale: false });
    }
  });
  return { nodes, events, document, navigator, timers, requests: () => requests, advance: delay => { clock += delay; }, fail: value => { fail = value; }, settle: () => new Promise(resolve => setImmediate(resolve)) };
}

await test('header formats the real count, suspends polling while hidden and resumes', async () => {
  const browser = browserHarness();
  await browser.settle();
  assert.equal(browser.nodes['steam-player-count'].textContent, '83,499');
  assert.equal(browser.nodes['steam-online'].dataset.state, 'live');
  assert.equal(browser.timers.size, 1);
  browser.document.hidden = true;
  browser.events.get('visibilitychange')();
  assert.equal(browser.timers.size, 0);
  browser.advance(120000);
  assert.equal(browser.requests(), 1);
  browser.document.hidden = false;
  browser.events.get('visibilitychange')();
  await browser.settle();
  assert.equal(browser.requests(), 2);
});

await test('header preserves outage state across visibility changes and reconnects', async () => {
  const browser = browserHarness({ playerCount: 0 });
  await browser.settle();
  assert.equal(browser.nodes['steam-player-count'].textContent, '0');
  browser.fail(true);
  browser.advance(60000);
  await [...browser.timers.values()][0].callback();
  assert.equal(browser.nodes['steam-online'].dataset.state, 'stale');
  browser.document.hidden = true;
  browser.events.get('visibilitychange')();
  browser.document.hidden = false;
  browser.events.get('visibilitychange')();
  assert.equal(browser.nodes['steam-online'].dataset.state, 'stale');
  browser.advance(900001);
  browser.events.get('offline')();
  assert.equal(browser.nodes['steam-player-count'].textContent, '—');
  browser.fail(false);
  browser.events.get('online')();
  await browser.settle();
  assert.equal(browser.nodes['steam-online'].dataset.state, 'live');
});

await test('file URLs and hidden pages do not start unusable requests', async () => {
  const local = browserHarness({ protocol: 'file:' });
  await local.settle();
  assert.equal(local.requests(), 0);
  assert.match(local.nodes['steam-online'].title, /启动地图/);
  const hidden = browserHarness({ hidden: true });
  await hidden.settle();
  assert.equal(hidden.requests(), 0);
});
