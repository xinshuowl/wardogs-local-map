using System;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Collections.Generic;
using System.Globalization;
using System.Text.RegularExpressions;

public static class LocalMapServer {
    static readonly Dictionary<string, string> Types = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase) {
        {".html", "text/html; charset=utf-8"}, {".css", "text/css; charset=utf-8"}, {".js", "text/javascript; charset=utf-8"}, {".json", "application/json; charset=utf-8"}, {".webp", "image/webp"}, {".png", "image/png"}, {".svg", "image/svg+xml"}, {".woff2", "font/woff2"}, {".glb", "model/gltf-binary"}
    };
    static readonly SemaphoreSlim Clients = new SemaphoreSlim(16);
    static readonly object PlayerLock = new object();
    static readonly DateTime UnixEpoch = new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc);
    static long PlayerCount = -1;
    static long PlayerCheckedAt = 0;
    static long NextPlayerAttempt = 0;
    static string PlayerSource = "";
    static bool PlayerFailed = false;
    static readonly HttpClient PlayerClient = new HttpClient();

    static long NowMilliseconds() { return (long)(DateTime.UtcNow - UnixEpoch).TotalMilliseconds; }

    static string RequestPlayers(string url) {
        using (CancellationTokenSource timeout = new CancellationTokenSource(5000))
        using (HttpResponseMessage response = PlayerClient.GetAsync(url, HttpCompletionOption.ResponseHeadersRead, timeout.Token).GetAwaiter().GetResult()) {
            response.EnsureSuccessStatusCode();
            using (Stream stream = response.Content.ReadAsStreamAsync().GetAwaiter().GetResult())
            using (MemoryStream content = new MemoryStream()) {
                byte[] buffer = new byte[4096];
                int length;
                while ((length = stream.ReadAsync(buffer, 0, buffer.Length, timeout.Token).GetAwaiter().GetResult()) > 0) {
                    if (content.Length + length > 16384) throw new InvalidDataException("Player response too large");
                    content.Write(buffer, 0, length);
                }
                return Encoding.UTF8.GetString(content.ToArray());
            }
        }
    }

    static long PlayerNumber(string json, string key) {
        Match match = Regex.Match(json, "\"" + key + "\"\\s*:\\s*(0|[1-9][0-9]*)\\s*[,}]");
        long value;
        if (!match.Success || !long.TryParse(match.Groups[1].Value, NumberStyles.None, CultureInfo.InvariantCulture, out value) || value > 9007199254740991) throw new InvalidDataException("Invalid player response");
        return value;
    }

    static string SteamPlayers() {
        lock (PlayerLock) {
            if (NowMilliseconds() >= NextPlayerAttempt) {
                try {
                    long count;
                    long checkedAt;
                    string source;
                    try {
                        string json = RequestPlayers("https://metaforge.app/api/wardogs/server-status?summary=1");
                        count = PlayerNumber(json, "steam_players");
                        checkedAt = PlayerNumber(json, "steam_checked_at");
                        if (checkedAt <= 0 || checkedAt > NowMilliseconds() + 60000 || NowMilliseconds() - checkedAt > 150000) throw new InvalidDataException("Stale player response");
                        source = "MetaForge / Steam";
                    } catch {
                        string json = RequestPlayers("https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/?appid=1867240");
                        if (PlayerNumber(json, "result") != 1) throw new InvalidDataException("Steam count unavailable");
                        count = PlayerNumber(json, "player_count");
                        checkedAt = NowMilliseconds();
                        source = "Steam";
                    }
                    PlayerCount = count;
                    PlayerCheckedAt = checkedAt;
                    PlayerSource = source;
                    PlayerFailed = false;
                } catch { PlayerFailed = true; }
                NextPlayerAttempt = NowMilliseconds() + 60000;
            }
            long age = NowMilliseconds() - PlayerCheckedAt;
            bool available = PlayerCount >= 0 && age <= 900000;
            string countText = available ? PlayerCount.ToString(CultureInfo.InvariantCulture) : "null";
            string updatedAt = available ? "\"" + UnixEpoch.AddMilliseconds(PlayerCheckedAt).ToString("o", CultureInfo.InvariantCulture) + "\"" : "null";
            string sourceText = available ? "\"" + PlayerSource + "\"" : "null";
            string stale = available && (PlayerFailed || age > 150000) ? "true" : "false";
            return "{\"appId\":1867240,\"playerCount\":" + countText + ",\"updatedAt\":" + updatedAt + ",\"source\":" + sourceText + ",\"stale\":" + stale + ",\"refreshAfterMs\":60000}";
        }
    }

    static void Header(Stream stream, int status, string contentType, long length) {
        string message = status == 200 ? "OK" : status == 404 ? "Not Found" : status == 405 ? "Method Not Allowed" : "Forbidden";
        byte[] header = Encoding.ASCII.GetBytes("HTTP/1.1 " + status + " " + message + "\r\nContent-Type: " + contentType + "\r\nContent-Length: " + length + "\r\nCache-Control: no-cache\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n");
        stream.Write(header, 0, header.Length);
    }
    static void Serve(TcpClient client, string root) {
        try {
            client.ReceiveTimeout = 5000;
            client.SendTimeout = 30000;
            using (NetworkStream stream = client.GetStream()) {
                StringBuilder request = new StringBuilder();
                while (request.Length < 8192) { int next = stream.ReadByte(); if (next < 0) return; request.Append((char)next); if (request.ToString().EndsWith("\r\n\r\n")) break; }
                if (request.Length >= 8192) { Header(stream, 403, "text/plain", 0); return; }
                string[] firstLine = request.ToString().Split(new string[] {"\r\n"}, StringSplitOptions.None)[0].Split(' ');
                if (firstLine.Length != 3 || (firstLine[0] != "GET" && firstLine[0] != "HEAD")) { Header(stream, 405, "text/plain", 0); return; }
                string raw = firstLine[1].Split('?')[0];
                if (!raw.StartsWith("/") || raw.IndexOf('\\') >= 0) { Header(stream, 403, "text/plain", 0); return; }
                string path = Uri.UnescapeDataString(raw);
                if (path == "/api/steam/players") {
                    byte[] players = Encoding.UTF8.GetBytes(SteamPlayers());
                    Header(stream, 200, "application/json; charset=utf-8", players.Length);
                    if (firstLine[0] != "HEAD") stream.Write(players, 0, players.Length);
                    return;
                }
                if (path == "/api/local/health") {
                    byte[] health = Encoding.UTF8.GetBytes("{\"app\":\"wardogs-local-map\",\"version\":\"3.0\",\"backend\":\"windows\"}");
                    Header(stream, 200, "application/json", health.Length);
                    if (firstLine[0] != "HEAD") stream.Write(health, 0, health.Length);
                    return;
                }
                bool hiddenPath = false;
                foreach (string segment in path.Split(new char[] { '/', '\\' })) if (segment.StartsWith(".", StringComparison.Ordinal)) hiddenPath = true;
                if (hiddenPath) { Header(stream, 403, "text/plain", 0); return; }
                string filename = Path.GetFullPath(Path.Combine(root, path == "/" ? "index.html" : path.TrimStart('/')));
                if (!filename.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) || path.IndexOf('\0') >= 0) { Header(stream, 403, "text/plain", 0); return; }
                if (!File.Exists(filename)) { Header(stream, 404, "text/plain", 0); return; }
                using (FileStream file = new FileStream(filename, FileMode.Open, FileAccess.Read, FileShare.ReadWrite)) {
                    string type;
                    if (!Types.TryGetValue(Path.GetExtension(filename), out type)) type = "application/octet-stream";
                    Header(stream, 200, type, file.Length);
                    if (firstLine[0] != "HEAD") file.CopyTo(stream);
                }
            }
        } catch { }
        finally { client.Close(); Clients.Release(); }
    }
    public static void Run(string directory, int port, bool openPage = false) {
        string root = Path.GetFullPath(directory).TrimEnd(Path.DirectorySeparatorChar);
        TcpListener listener = new TcpListener(IPAddress.Loopback, port);
        listener.Start();
        if (openPage) System.Diagnostics.Process.Start("http://127.0.0.1:" + port);
        try {
            while (true) {
                Clients.Wait();
                TcpClient client;
                try { client = listener.AcceptTcpClient(); }
                catch { Clients.Release(); throw; }
                Task.Run(() => Serve(client, root));
            }
        } finally { listener.Stop(); }
    }
}
