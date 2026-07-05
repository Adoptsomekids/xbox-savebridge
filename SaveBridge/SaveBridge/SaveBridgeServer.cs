using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Threading.Tasks;
using Windows.Gaming.XboxLive.Storage;
using Windows.Networking;
using Windows.Networking.Sockets;
using Windows.Storage.Streams;
using Windows.System;

namespace SaveBridge
{
    /// <summary>
    /// HTTP bridge server running on Xbox, exposing Dead Island DE
    /// Connected Storage saves over the local network via StreamSocketListener.
    ///
    /// Endpoints:
    ///   GET  /status
    ///   GET  /save/list
    ///   GET  /save/download?container=NAME&amp;blob=BLOBNAME
    ///   POST /save/upload?container=NAME&amp;blob=BLOBNAME   (body = raw bytes)
    ///   GET  /wgs/list      — WGS filesystem enumeration (fallback)
    ///   GET  /wgs/download?path=REL_PATH — raw WGS file download (fallback)
    /// </summary>
    public sealed class SaveBridgeServer
    {
        private const string DEAD_ISLAND_SCID = "db860100-d780-4e17-8685-ad130052ea64";
        private const int PORT = 8765;

        private StreamSocketListener _listener;
        private GameSaveProvider _provider;
        private bool _running;

        public bool IsRunning => _running;
        public event Action<string> LogMessage;

        // ------------------------------------------------------------------ //
        //  Start / Stop
        // ------------------------------------------------------------------ //

        public async Task StartAsync()
        {
            if (_running) return;

            Log("Acquiring Xbox Live user…");
            var users = await User.FindAllAsync();
            if (users.Count == 0)
                throw new InvalidOperationException("No Xbox Live user signed in.");

            var user = users[0];
            Log("User: " + user.NonRoamableId);

            Log("Opening GameSaveProvider for SCID " + DEAD_ISLAND_SCID + "…");
            var result = await GameSaveProvider.GetForUserAsync(user, DEAD_ISLAND_SCID);
            if (result.Status == GameSaveErrorStatus.Ok)
            {
                _provider = result.Value;
                Log("GameSaveProvider ready.");
            }
            else
            {
                Log("WARNING: GameSaveProvider failed (" + result.Status + ") — WGS filesystem fallback only.");
            }

            Log("Binding StreamSocketListener on port " + PORT + "…");
            _listener = new StreamSocketListener();
            _listener.ConnectionReceived += OnConnectionReceived;

            // Bind on all interfaces so the PC can reach us
            await _listener.BindServiceNameAsync(PORT.ToString());
            _running = true;
            Log("SaveBridge listening on port " + PORT + ".");
        }

        public void Stop()
        {
            if (!_running) return;
            _listener?.Dispose();
            _listener = null;
            _running = false;
            Log("Server stopped.");
        }

        // ------------------------------------------------------------------ //
        //  Connection handler — raw HTTP/1.1 over StreamSocket
        // ------------------------------------------------------------------ //

        private async void OnConnectionReceived(StreamSocketListener sender,
            StreamSocketListenerConnectionReceivedEventArgs args)
        {
            string remote = args.Socket.Information.RemoteAddress?.DisplayName ?? "?";
            try
            {
                string requestLine;
                string body;
                using (var reader = new DataReader(args.Socket.InputStream))
                {
                    reader.InputStreamOptions = InputStreamOptions.Partial;

                    // Read until we have the full HTTP head (ends with \r\n\r\n)
                    var rawHead = new StringBuilder();
                    uint contentLength = 0;
                    while (true)
                    {
                        await reader.LoadAsync(1);
                        if (reader.UnconsumedBufferLength == 0) break;
                        rawHead.Append((char)reader.ReadByte());
                        string s = rawHead.ToString();
                        if (s.EndsWith("\r\n\r\n"))
                        {
                            // Parse Content-Length if present
                            foreach (var line in s.Split(new[] { "\r\n" }, StringSplitOptions.None))
                            {
                                if (line.StartsWith("Content-Length:", StringComparison.OrdinalIgnoreCase))
                                    uint.TryParse(line.Substring(15).Trim(), out contentLength);
                            }
                            break;
                        }
                    }

                    requestLine = rawHead.ToString().Split(new[] { "\r\n" }, StringSplitOptions.None)[0];

                    // Read body if any
                    byte[] bodyBytes = new byte[0];
                    if (contentLength > 0)
                    {
                        await reader.LoadAsync(contentLength);
                        bodyBytes = new byte[contentLength];
                        reader.ReadBytes(bodyBytes);
                    }
                    body = Encoding.UTF8.GetString(bodyBytes);
                    reader.DetachStream();
                }

                Log(remote + " → " + requestLine);

                // Parse request line: "GET /path?qs HTTP/1.1"
                var parts = requestLine.Split(' ');
                if (parts.Length < 2) return;
                string method = parts[0].ToUpperInvariant();
                string rawUrl = parts[1];
                int qIdx = rawUrl.IndexOf('?');
                string path = (qIdx >= 0 ? rawUrl.Substring(0, qIdx) : rawUrl).ToLowerInvariant().TrimEnd('/');
                string qs   = qIdx >= 0 ? rawUrl.Substring(qIdx + 1) : "";
                var query   = ParseQuery(qs);

                using (var outStream = args.Socket.OutputStream)
                {
                    if (path == "/status" && method == "GET")
                    {
                        await SendJson(outStream, 200,
                            "{\"status\":\"ok\",\"scid\":\"" + DEAD_ISLAND_SCID + "\",\"port\":" + PORT
                            + ",\"provider\":" + (_provider != null ? "true" : "false") + "}");
                    }
                    else if (path == "/save/list" && method == "GET")
                    {
                        await HandleList(outStream);
                    }
                    else if (path == "/save/download" && method == "GET")
                    {
                        string container = GetQuery(query, "container");
                        string blob      = GetQuery(query, "blob");
                        if (container == "" || blob == "")
                            await SendJson(outStream, 400, "{\"error\":\"container and blob params required\"}");
                        else
                            await HandleDownload(outStream, container, blob);
                    }
                    else if (path == "/save/upload" && method == "POST")
                    {
                        string container = GetQuery(query, "container");
                        string blob      = GetQuery(query, "blob");
                        var bodyArr      = Encoding.UTF8.GetBytes(body); // body already read as bytes above
                        if (container == "" || blob == "")
                            await SendJson(outStream, 400, "{\"error\":\"container and blob params required\"}");
                        else
                            await HandleUpload(outStream, container, blob, bodyArr);
                    }
                    else if (path == "/wgs/list" && method == "GET")
                    {
                        await HandleWgsList(outStream);
                    }
                    else if (path == "/wgs/download" && method == "GET")
                    {
                        string relPath = GetQuery(query, "path");
                        if (relPath == "")
                            await SendJson(outStream, 400, "{\"error\":\"path param required\"}");
                        else
                            await HandleWgsDownload(outStream, relPath);
                    }
                    else
                    {
                        await SendJson(outStream, 404, "{\"error\":\"Not found\"}");
                    }

                    await outStream.FlushAsync();
                }
            }
            catch (Exception ex)
            {
                Log("Connection error from " + remote + ": " + ex.Message);
            }
            finally
            {
                args.Socket.Dispose();
            }
        }

        // ------------------------------------------------------------------ //
        //  GameSaveProvider handlers
        // ------------------------------------------------------------------ //

        private async Task HandleList(IOutputStream outStream)
        {
            if (_provider == null)
            {
                await SendJson(outStream, 503, "{\"error\":\"GameSaveProvider not available, use /wgs/list\"}");
                return;
            }

            var query = _provider.CreateContainerInfoQuery();
            var infoResult = await query.GetContainerInfoAsync();
            if (infoResult.Status != GameSaveErrorStatus.Ok)
            {
                await SendJson(outStream, 500,
                    "{\"error\":\"GetContainerInfoAsync failed: " + infoResult.Status + "\"}");
                return;
            }

            var sb = new StringBuilder();
            sb.Append("{\"containers\":[");
            bool first = true;
            foreach (var info in infoResult.Value)
            {
                if (!first) sb.Append(",");
                first = false;
                sb.Append("{\"name\":\"" + Escape(info.Name) + "\""
                         + ",\"displayName\":\"" + Escape(info.DisplayName) + "\""
                         + ",\"totalSize\":" + info.TotalSize + "}");
            }
            sb.Append("]}");
            await SendJson(outStream, 200, sb.ToString());
        }

        private async Task HandleDownload(IOutputStream outStream, string containerName, string blobName)
        {
            if (_provider == null)
            {
                await SendJson(outStream, 503, "{\"error\":\"GameSaveProvider not available, use /wgs/download\"}");
                return;
            }

            var container = _provider.CreateContainer(containerName);
            var getResult = await container.GetAsync(new[] { blobName });
            if (getResult.Status != GameSaveErrorStatus.Ok)
            {
                await SendJson(outStream, 404,
                    "{\"error\":\"GetAsync failed: " + getResult.Status + "\"}");
                return;
            }

            IBuffer buffer;
            if (!getResult.Value.TryGetValue(blobName, out buffer) || buffer == null)
            {
                await SendJson(outStream, 404, "{\"error\":\"Blob not found in result\"}");
                return;
            }

            var bytes = new byte[buffer.Length];
            var dr = DataReader.FromBuffer(buffer);
            dr.ReadBytes(bytes);

            await SendBinary(outStream, bytes, blobName);
            Log("Downloaded " + containerName + "/" + blobName + " (" + bytes.Length + " bytes)");
        }

        private async Task HandleUpload(IOutputStream outStream, string containerName, string blobName, byte[] bytes)
        {
            if (_provider == null)
            {
                await SendJson(outStream, 503, "{\"error\":\"GameSaveProvider not available\"}");
                return;
            }
            if (bytes.Length == 0)
            {
                await SendJson(outStream, 400, "{\"error\":\"Empty body\"}");
                return;
            }

            var writer = new DataWriter();
            writer.WriteBytes(bytes);
            var buffer = writer.DetachBuffer();

            var container = _provider.CreateContainer(containerName);
            var updates = new Dictionary<string, IBuffer> { { blobName, buffer } };
            var writeResult = await container.SubmitUpdatesAsync(updates, null, "SaveBridge");

            if (writeResult.Status != GameSaveErrorStatus.Ok)
            {
                await SendJson(outStream, 500,
                    "{\"error\":\"SubmitUpdatesAsync failed: " + writeResult.Status + "\"}");
                return;
            }

            await SendJson(outStream, 200,
                "{\"ok\":true,\"bytes\":" + bytes.Length
                + ",\"blob\":\"" + Escape(containerName + "/" + blobName) + "\"}");
            Log("Uploaded " + containerName + "/" + blobName + " (" + bytes.Length + " bytes)");
        }

        // ------------------------------------------------------------------ //
        //  WGS filesystem fallback handlers
        //
        //  On Xbox the WGS data lives at:
        //    %LOCALAPPDATA%\Packages\<PackageFamilyName>\SystemAppData\wgs\
        //  Xbox Live Save Exporter uses broadFileSystemAccess to read these
        //  directly. On Xbox as the game itself, we can read our own
        //  LocalAppData through Windows.Storage.ApplicationData.
        //
        //  Structure:
        //    wgs\
        //      <XUID_hex>\            — one folder per user
        //        containers.index     — binary file listing containers
        //        <GUID>\              — one folder per container
        //          container.<N>      — binary file listing blobs
        //          <BLOB_GUID>        — raw blob data
        // ------------------------------------------------------------------ //

        private async Task HandleWgsList(IOutputStream outStream)
        {
            try
            {
                var appData = Windows.Storage.ApplicationData.Current;
                var localFolder = appData.LocalFolder;

                // Traverse SystemAppData\wgs (accessible from within our own package)
                var wgsFolder = await localFolder.GetParentAsync()
                    .ContinueWith(t => t.Result) as Windows.Storage.StorageFolder;

                // Try direct path relative to our package LocalState
                string wgsPath = Path.Combine(localFolder.Path, "..", "SystemAppData", "wgs");
                wgsPath = Path.GetFullPath(wgsPath);

                var result = await WgsReader.EnumerateAsync(wgsPath);
                await SendJson(outStream, 200, result);
            }
            catch (Exception ex)
            {
                await SendJson(outStream, 500, "{\"error\":\"" + Escape(ex.Message) + "\"}");
            }
        }

        private async Task HandleWgsDownload(IOutputStream outStream, string relPath)
        {
            try
            {
                var localFolder = Windows.Storage.ApplicationData.Current.LocalFolder;
                string wgsBase = Path.GetFullPath(Path.Combine(localFolder.Path, "..", "SystemAppData", "wgs"));
                string fullPath = Path.GetFullPath(Path.Combine(wgsBase, relPath));

                // Safety: must stay inside wgs folder
                if (!fullPath.StartsWith(wgsBase, StringComparison.OrdinalIgnoreCase))
                {
                    await SendJson(outStream, 403, "{\"error\":\"Path traversal denied\"}");
                    return;
                }

                var file = await Windows.Storage.StorageFile.GetFileFromPathAsync(fullPath);
                var buf = await Windows.Storage.FileIO.ReadBufferAsync(file);
                var bytes = new byte[buf.Length];
                DataReader.FromBuffer(buf).ReadBytes(bytes);

                await SendBinary(outStream, bytes, Path.GetFileName(fullPath));
                Log("WGS download: " + relPath + " (" + bytes.Length + " bytes)");
            }
            catch (Exception ex)
            {
                await SendJson(outStream, 500, "{\"error\":\"" + Escape(ex.Message) + "\"}");
            }
        }

        // ------------------------------------------------------------------ //
        //  HTTP response helpers
        // ------------------------------------------------------------------ //

        private static async Task SendJson(IOutputStream stream, int code, string json)
        {
            var body = Encoding.UTF8.GetBytes(json);
            var head = "HTTP/1.1 " + code + " " + StatusText(code) + "\r\n"
                     + "Content-Type: application/json\r\n"
                     + "Content-Length: " + body.Length + "\r\n"
                     + "Access-Control-Allow-Origin: *\r\n"
                     + "Connection: close\r\n\r\n";
            var headBytes = Encoding.UTF8.GetBytes(head);

            using (var writer = new DataWriter(stream))
            {
                writer.WriteBytes(headBytes);
                writer.WriteBytes(body);
                await writer.StoreAsync();
                writer.DetachStream();
            }
        }

        private static async Task SendBinary(IOutputStream stream, byte[] bytes, string filename)
        {
            var head = "HTTP/1.1 200 OK\r\n"
                     + "Content-Type: application/octet-stream\r\n"
                     + "Content-Disposition: attachment; filename=\"" + filename + "\"\r\n"
                     + "Content-Length: " + bytes.Length + "\r\n"
                     + "Access-Control-Allow-Origin: *\r\n"
                     + "Connection: close\r\n\r\n";
            var headBytes = Encoding.UTF8.GetBytes(head);

            using (var writer = new DataWriter(stream))
            {
                writer.WriteBytes(headBytes);
                writer.WriteBytes(bytes);
                await writer.StoreAsync();
                writer.DetachStream();
            }
        }

        private static string StatusText(int code)
        {
            switch (code)
            {
                case 200: return "OK";
                case 400: return "Bad Request";
                case 403: return "Forbidden";
                case 404: return "Not Found";
                case 500: return "Internal Server Error";
                case 503: return "Service Unavailable";
                default:  return "Unknown";
            }
        }

        // ------------------------------------------------------------------ //
        //  Utilities
        // ------------------------------------------------------------------ //

        private static Dictionary<string, string> ParseQuery(string qs)
        {
            var dict = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            if (string.IsNullOrEmpty(qs)) return dict;
            foreach (var pair in qs.Split('&'))
            {
                int eq = pair.IndexOf('=');
                if (eq > 0)
                    dict[Uri.UnescapeDataString(pair.Substring(0, eq))]
                        = Uri.UnescapeDataString(pair.Substring(eq + 1));
            }
            return dict;
        }

        private static string GetQuery(Dictionary<string, string> q, string key)
        {
            string v;
            return q.TryGetValue(key, out v) ? v : "";
        }

        private static string Escape(string s)
        {
            if (s == null) return "";
            return s.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", "").Replace("\n", "\\n");
        }

        private void Log(string msg)
        {
            System.Diagnostics.Debug.WriteLine("[SaveBridge] " + msg);
            LogMessage?.Invoke(msg);
        }
    }
}
