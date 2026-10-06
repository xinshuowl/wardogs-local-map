(() => {
  'use strict';

  const badge = document.getElementById('steam-online');
  if (!badge) return;
  const count = document.getElementById('steam-player-count');
  const status = document.getElementById('steam-player-state');
  const refreshInterval = 60000;
  const maximumAge = 15 * 60000;
  let latest = null;
  let timer = null;
  let controller = null;
  let lastAttempt = 0;
  let failed = false;

  function render(unavailable = failed) {
    const age = latest ? Date.now() - Date.parse(latest.updatedAt) : Infinity;
    const available = latest && age <= maximumAge;
    const stale = available && (unavailable || latest.stale || age > 150000);
    badge.dataset.state = available ? stale ? 'stale' : 'live' : 'unavailable';
    count.textContent = available ? latest.playerCount.toLocaleString('en-US') : '—';
    status.textContent = available ? stale ? '· 上次更新' : '' : '· 暂不可用';
    badge.title = available
      ? 'WARDOGS Steam 同时在线玩家 · 来源：' + latest.source + '\n更新于 ' + new Date(latest.updatedAt).toLocaleString('zh-CN') + (stale ? '\n暂未取得最新人数，当前显示上次数据。' : '\n每分钟自动刷新。')
      : location.protocol === 'file:' ? '实时人数需要本地服务，请通过「启动地图.cmd」打开。' : '暂时无法取得在线人数，网络恢复后自动重试。';
  }

  async function refresh() {
    clearTimeout(timer);
    if (document.hidden || controller || location.protocol === 'file:') return;
    if (!navigator.onLine) { render(true); return; }
    if (Date.now() - lastAttempt < refreshInterval) {
      timer = setTimeout(refresh, refreshInterval - (Date.now() - lastAttempt));
      return;
    }
    controller = new AbortController();
    lastAttempt = Date.now();
    const timeout = setTimeout(() => controller?.abort(), 12000);
    try {
      const response = await fetch('/api/steam/players', { cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw new Error('Player count unavailable');
      const data = await response.json();
      const checkedAt = Date.parse(data.updatedAt);
      if (data.appId !== 1867240 || !Number.isSafeInteger(data.playerCount) || data.playerCount < 0 || !Number.isFinite(checkedAt) || checkedAt > Date.now() + 60000 || Date.now() - checkedAt > maximumAge || !['MetaForge / Steam', 'Steam'].includes(data.source)) throw new Error('Invalid player count');
      latest = data;
      failed = false;
      render();
    } catch {
      failed = true;
      render(true);
    } finally {
      clearTimeout(timeout);
      controller = null;
      if (!document.hidden && navigator.onLine) timer = setTimeout(refresh, refreshInterval);
    }
  }

  document.addEventListener('visibilitychange', () => {
    clearTimeout(timer);
    if (!document.hidden) { render(); refresh(); }
  });
  window.addEventListener('offline', () => { clearTimeout(timer); controller?.abort(); failed = true; render(true); });
  window.addEventListener('online', () => { lastAttempt = 0; refresh(); });
  if (location.protocol === 'file:') render(true);
  else refresh();
})();
