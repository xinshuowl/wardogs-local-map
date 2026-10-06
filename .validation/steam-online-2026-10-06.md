# 顶部 Steam 在线人数 · 2026-10-06

- Steam 商店搜索核实 WARDOGS App ID 为 `1867240`。
- 参考站人数栏调用 `/api/wardogs/server-status?summary=1`，使用 `steam_players` 和 `steam_checked_at`，并非服务器列表人数之和。
- 本地新增 `/api/steam/players`，优先读取参考站同一公开接口，备用 Steam 官方 `ISteamUserStats/GetNumberOfCurrentPlayers/v1/`；不需要登录或密钥。
- Node 与 Windows PowerShell / .NET 两种服务均实测返回 `84,751`，`stale:false`；数值仅为验收时数据，不写死于界面。
- 当前网络下 Steam 官方接口单独探测超时；其备用解析与合法 0 人响应通过模拟回归测试。
- 客户端每分钟刷新、页面隐藏暂停定时查询；服务端合并并发、成功和失败均缓存一分钟。异常时保留至多 15 分钟的上次数据并明确标记，过期或首次失败显示暂不可用。
- `npm run verify:players` 7/7，`node scripts/verify_ui_state.mjs` 31/31，`node scripts/verify_replica.mjs` 通过；新前端脚本和 Node 服务语法检查通过。
- PowerShell 7 编译通过，Windows PowerShell 备用服务在独立端口启动并实测接口通过。
- 浏览器实测正常人数、绿色状态点、悬停来源与更新时间；1280、1000、901、768、390、320 CSS 像素宽度下无横向溢出，人数不遮挡设置按钮；控制台无 error / warning。
- 功能联网请求与地图渲染独立，未修改地图拖动或模型加载逻辑。
