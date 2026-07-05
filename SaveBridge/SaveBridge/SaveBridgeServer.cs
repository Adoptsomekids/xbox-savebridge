using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Text;
using System.Threading.Tasks;
using Windows.Gaming.XboxLive.Storage;
using Windows.System;

namespace SaveBridge
{
    /// <summary>
    /// HTTP bridge server running on Xbox, exposing Dead Island DE
    /// Connected Storage saves over the local network.
    ///
    /// Endpoints:
    ///   GET  /status
    ///   GET  /save/list
    ///   GET  /save/download?container=NAME&amp;blob=BLOBNAME
    ///   POST /save/upload?container=NAME&amp;blob=BLOBNAME   (body = raw bytes)
    /// </summary>
    public class SaveBridgeServer
    {
        private const string DEAD_ISLAND_SCID = "db860100-d780-4e17-8685-ad130052ea64";
        private const int PORT = 8765;

        private HttpListener? _listener;
        private GameSaveProvider? _provider;

        public async Task StartAsync()
        {
            var users = await User.FindAllAsync();
            if (users.Count == 0)
                throw new InvalidOperationException("No Xbox Live user signed in.");

            var user = users[0];
            Log("User: " + user.NonRoamableId);

            var result = await GameSaveProvider.GetForUserAsync(user, DEAD_ISLAND_SCID);
            if (result.Status != GameSaveErrorStatus.Ok)
                throw new InvalidOperationException("GetForUserAsync failed: " + result.Status);

            _provider = result.Value;
            Log("GameSaveProvider ready for SCID " + DEAD_ISLAND_SCID);

            _listener = new HttpListener();
            _listener.Prefixes.Add("http://*:" + PORT + "/");
            _listener.Start();
            Log("SaveBridge listening on port " + PORT);

            while (_listener.IsListening)
            {
                try
                {
                    var ctx = await _listener.GetContextAsync();
                    // fire and forget
                    var _ = HandleAsync(ctx);
                }
                catch (Exception ex) { Log("Listener error: " + ex.Message); }
            }
        }

        private async Task HandleAsync(HttpListenerContext ctx)
        {
            var req  = ctx.Request;
            var resp = ctx.Response;
            try
            {
                var path  = req.Url!.AbsolutePath.TrimEnd('/').ToLowerInvariant();
                var qs    = req.QueryString;
                Log(req.HttpMethod + " " + req.Url.PathAndQuery);

                if (path == "/status" && req.HttpMethod == "GET")
                {
                    await WriteJson(resp, 200,
                        "{\"status\":\"ok\",\"scid\":\"" + DEAD_ISLAND_SCID + "\",\"port\":" + PORT + "}");
                }
                else if (path == "/save/list" && req.HttpMethod == "GET")
                {
                    await HandleList(resp);
                }
                else if (path == "/save/download" && req.HttpMethod == "GET")
                {
                    string container = qs["container"] ?? "";
                    string blob      = qs["blob"]      ?? "";
                    if (container.Length == 0 || blob.Length == 0)
                        await WriteJson(resp, 400, "{\"error\":\"container and blob params required\"}");
                    else
                        await HandleDownload(resp, container, blob);
                }
                else if (path == "/save/upload" && req.HttpMethod == "POST")
                {
                    string container = qs["container"] ?? "";
                    string blob      = qs["blob"]      ?? "";
                    if (container.Length == 0 || blob.Length == 0)
                        await WriteJson(resp, 400, "{\"error\":\"container and blob params required\"}");
                    else
                        await HandleUpload(req, resp, container, blob);
                }
                else
                {
                    await WriteJson(resp, 404, "{\"error\":\"Not found\"}");
                }
            }
            catch (Exception ex)
            {
                Log("Request error: " + ex.Message);
                try { await WriteJson(resp, 500, "{\"error\":\"" + Escape(ex.Message) + "\"}"); }
                catch { }
            }
        }

        // List all save containers
        private async Task HandleList(HttpListenerResponse resp)
        {
            // CreateContainerInfoQuery() is the correct method name (official MS sample)
            GameSaveContainerInfoQuery query = _provider.CreateContainerInfoQuery();
            GameSaveContainerInfoGetResult infoResult = await query.GetContainerInfoAsync();

            if (infoResult.Status != GameSaveErrorStatus.Ok)
            {
                await WriteJson(resp, 500,
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
            await WriteJson(resp, 200, sb.ToString());
        }

        // Download: read a named blob from a container
        private async Task HandleDownload(HttpListenerResponse resp,
                                          string containerName, string blobName)
        {
            GameSaveContainer container = _provider.CreateContainer(containerName);

            // GetAsync allocates a new Dictionary to hold the retrieved data
            string[] blobsToRead = new string[] { blobName };
            GameSaveBlobGetResult getResult = await container.GetAsync(blobsToRead);

            if (getResult.Status != GameSaveErrorStatus.Ok)
            {
                await WriteJson(resp, 404,
                    "{\"error\":\"GetAsync failed: " + getResult.Status + "\"}");
                return;
            }

            Windows.Storage.Streams.IBuffer? buffer;
            if (!getResult.Value.TryGetValue(blobName, out buffer) || buffer == null)
            {
                await WriteJson(resp, 404,
                    "{\"error\":\"Blob not found in result\"}");
                return;
            }

            var bytes = new byte[buffer.Length];
            var dr = Windows.Storage.Streams.DataReader.FromBuffer(buffer);
            dr.ReadBytes(bytes);

            resp.StatusCode      = 200;
            resp.ContentType     = "application/octet-stream";
            resp.ContentLength64 = bytes.Length;
            resp.Headers.Add("Content-Disposition",
                "attachment; filename=\"" + blobName + "\"");
            await resp.OutputStream.WriteAsync(bytes, 0, bytes.Length);
            resp.OutputStream.Close();
            Log("Downloaded " + containerName + "/" + blobName + " (" + bytes.Length + " bytes)");
        }

        // Upload: write a blob into a container
        private async Task HandleUpload(HttpListenerRequest req, HttpListenerResponse resp,
                                        string containerName, string blobName)
        {
            byte[] bytes;
            using (var ms = new MemoryStream())
            {
                await req.InputStream.CopyToAsync(ms);
                bytes = ms.ToArray();
            }

            if (bytes.Length == 0)
            {
                await WriteJson(resp, 400, "{\"error\":\"Empty body\"}");
                return;
            }

            var writer = new Windows.Storage.Streams.DataWriter();
            writer.WriteBytes(bytes);
            var buffer = writer.DetachBuffer();

            GameSaveContainer container = _provider.CreateContainer(containerName);
            var updates = new Dictionary<string, Windows.Storage.Streams.IBuffer>
            {
                { blobName, buffer }
            };

            GameSaveOperationResult writeResult =
                await container.SubmitUpdatesAsync(updates, null, "SaveBridge");

            if (writeResult.Status != GameSaveErrorStatus.Ok)
            {
                await WriteJson(resp, 500,
                    "{\"error\":\"SubmitUpdatesAsync failed: " + writeResult.Status + "\"}");
                return;
            }

            await WriteJson(resp, 200,
                "{\"ok\":true,\"bytes\":" + bytes.Length
                + ",\"blob\":\"" + Escape(containerName + "/" + blobName) + "\"}");
            Log("Uploaded " + containerName + "/" + blobName + " (" + bytes.Length + " bytes)");
        }

        // Write a pre-built JSON string to the response
        private static async Task WriteJson(HttpListenerResponse resp, int code, string json)
        {
            var bytes = Encoding.UTF8.GetBytes(json);
            resp.StatusCode      = code;
            resp.ContentType     = "application/json";
            resp.ContentLength64 = bytes.Length;
            await resp.OutputStream.WriteAsync(bytes, 0, bytes.Length);
            resp.OutputStream.Close();
        }

        private static string Escape(string s)
        {
            return s == null ? "" : s.Replace("\\", "\\\\").Replace("\"", "\\\"");
        }

        private static void Log(string msg)
        {
            System.Diagnostics.Debug.WriteLine("[SaveBridge] " + msg);
        }

        public void Stop()
        {
            if (_listener != null) { _listener.Stop(); _listener.Close(); }
        }
    }
}
