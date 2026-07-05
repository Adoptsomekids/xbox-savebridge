using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Threading.Tasks;
using Windows.Networking.Sockets;
using Windows.Storage.Streams;

namespace SaveBridge
{
    /// <summary>
    /// HTTP bridge server running on Xbox, exposing Dead Island DE
    /// WGS save files over the local network via StreamSocketListener.
    ///
    /// Endpoints:
    ///   GET  /status
    ///   GET  /wgs/list      — WGS filesystem enumeration
    ///   GET  /wgs/download?path=REL_PATH — raw WGS file download
    ///   POST /wgs/upload?path=REL_PATH   — write WGS file
    /// </summary>
    public sealed class SaveBridgeServer
    {
        private const int PORT = 8765;

        private StreamSocketListener _listener;
        private bool _running;

        public bool IsRunning => _running;
        public event Action<string> LogMessage;

        // ------------------------------------------------------------------ //
        //  Start / Stop
        // ------------------------------------------------------------------ //

        public async Task StartAsync()
        {
            if (_running) return;

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
                byte[] bodyBytes;
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
                    bodyBytes = new byte[0];
                    if (contentLength > 0)
                    {
                        await reader.LoadAsync(contentLength);
                        bodyBytes = new byte[contentLength];
                        reader.ReadBytes(bodyBytes);
                    }
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
                            "{\"status\":\"ok\",\"port\":" + PORT + ",\"build\":\"v8-wgsonly\"}");
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
                    else if (path == "/wgs/upload" && method == "POST")
                    {
                        string relPath = GetQuery(query, "path");
                        if (relPath == "" || bodyBytes.Length == 0)
                            await SendJson(outStream, 400, "{\"error\":\"path param and body required\"}");
                        else
                            await HandleWgsUpload(outStream, relPath, bodyBytes);
                    }
                    else
                    {
                        await SendJson(outStream, 404, "{\"error\":\"Not found\",\"path\":\"" + Escape(path) + "\"}");
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
        //  WGS filesystem handlers
        //
        //  On Xbox the WGS data lives at:
        //    %LOCALAPPDATA%\Packages\<PackageFamilyName>\SystemAppData\wgs\
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
                // LocalFolder is at: ...\Packages\<PFN>\LocalState
                // WGS is at:         ...\Packages\<PFN>\SystemAppData\wgs
                var localFolder = Windows.Storage.ApplicationData.Current.LocalFolder;
                string wgsPath = Path.GetFullPath(Path.Combine(localFolder.Path, "..", "SystemAppData", "wgs"));

                Log("WGS path: " + wgsPath);
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

        private async Task HandleWgsUpload(IOutputStream outStream, string relPath, byte[] bytes)
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

                // Ensure parent directory exists
                string dir = Path.GetDirectoryName(fullPath);
                if (!Directory.Exists(dir)) Directory.CreateDirectory(dir);

                await Task.Run(() => File.WriteAllBytes(fullPath, bytes));

                await SendJson(outStream, 200,
                    "{\"ok\":true,\"bytes\":" + bytes.Length + ",\"path\":\"" + Escape(relPath) + "\"}");
                Log("WGS upload: " + relPath + " (" + bytes.Length + " bytes)");
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
