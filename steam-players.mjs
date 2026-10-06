export const STEAM_APP_ID = 1867240;
export const PLAYER_REFRESH_MS = 60000;
const freshAge = 150000;
const maximumAge = 15 * 60000;
const referenceUrl = 'https://metaforge.app/api/wardogs/server-status?summary=1';
const steamUrl = 'https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/?appid=' + STEAM_APP_ID;

export function createSteamPlayersService({ fetcher = fetch, now = Date.now } = {}) {
  let cached = null;
  let nextAttempt = 0;
  let pending = null;
  let failed = false;

  async function request(url) {
    const response = await fetcher(url, { signal: AbortSignal.timeout(5000), headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error('Player count unavailable');
    return response.json();
  }

  function record(playerCount, checkedAt, source) {
    if (!Number.isSafeInteger(playerCount) || playerCount < 0 || !Number.isSafeInteger(checkedAt) || checkedAt <= 0 || checkedAt > now() + 60000 || now() - checkedAt > freshAge) throw new Error('Invalid player count');
    return { playerCount, updatedAt: new Date(checkedAt).toISOString(), source };
  }

  async function refresh() {
    try {
      try {
        const data = await request(referenceUrl);
        cached = record(data.steam_players, data.steam_checked_at, 'MetaForge / Steam');
      } catch {
        const data = await request(steamUrl);
        if (data.response?.result !== 1) throw new Error('Steam count unavailable');
        cached = record(data.response.player_count, now(), 'Steam');
      }
      failed = false;
    } catch {
      failed = true;
    } finally {
      nextAttempt = now() + PLAYER_REFRESH_MS;
      pending = null;
    }
  }

  return async function getPlayers() {
    if (!pending && now() >= nextAttempt) pending = refresh();
    if (pending) await pending;
    const age = cached ? now() - Date.parse(cached.updatedAt) : Infinity;
    const available = cached && age <= maximumAge;
    return {
      appId: STEAM_APP_ID,
      playerCount: available ? cached.playerCount : null,
      updatedAt: available ? cached.updatedAt : null,
      source: available ? cached.source : null,
      stale: Boolean(available && (failed || age > freshAge)),
      refreshAfterMs: PLAYER_REFRESH_MS
    };
  };
}
