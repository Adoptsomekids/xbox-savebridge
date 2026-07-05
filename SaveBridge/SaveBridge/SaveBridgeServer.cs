using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Runtime.Serialization.Json;
using System.Text;
using System.Threading.Tasks;
using Windows.Gaming.XboxLive.Storage;
using Windows.System;

namespace SaveBridge
{
    /// <summary>
    /// HTTP bridge server that runs on Xbox and exposes Dead Island DE
    /// Connected Storage saves over the local network.
    ///
    /// API:
    ///   GET  /status                        -> {"status":"ok","scid":"..."}
    ///   GET  /save/list                     -> {"containers":[{"name":"...","size":N},...]}
    ///   GET  /save/download?container=X&amp;blob=Y -> raw binary blob bytes
    ///   POST /save/upload?container=X&amp;blob=Y  -> body=raw bytes -> {"ok":true}
    /// </summary>
    public class SaveBridgeServer
    {
        private const string DEAD_ISLAND_SCID = "db860100-d780-4e17-8685-ad130052ea64";
        private const int PORT = 8765;

        private HttpListener _listener;
        private GameSaveProvider _provider;

        public async Task StartAsync()
        {
            // Get the first signed-in Xbox Live user
            var users = await User.FindAllAsync();
            if (users.Count == 0)
                throw new InvalidOperationException("No Xbox Live user signed in.");

            var user = users[0];
            Log($"User: {user.NonRoamableId}");

            // Open the GameSaveProvider for Dead Island DE
            var result = await GameSaveProvider.GetForUserAsync(user, DEAD_ISLAND_SCID);
            if (result.Status != GameSaveErrorStatus.Ok)
                throw new InvalidOperationException($"GetForUserAsync failed: {result.Status}");

            _provider = result.Value;
            Log($"GameSaveProvider ready for SCID {DEAD_ISLAND_SCID}");

            _listener = new HttpListener();
            _listener.Prefixes.Add($"http://*:{PORT}/");
            _listener.Start();
            Log($"SaveBridge listening on port {PORT}");

            while (_listener.IsListening)
            {
                try
                {
                    var ctx = await _listener.GetContextAsync();
                    _ = HandleAsync(ctx);
                }
                catch (Exception ex) { Log($"Listener error: {ex.Message}"); }
            }
        }

        private async Task HandleAsync(HttpListenerContext ctx)
        {
            var req  = ctx.Request;
            var resp = ctx.Response;
            try
            {
                var path  = req.Url.AbsolutePath.TrimEnd('/').ToLowerInvariant();
                var query = req.QueryString;
                Log($"{req.HttpMethod} {req.Url.PathAndQuery}");

                if (path == "/status" && req.HttpMethod == "GET")
                {
                    await Json(resp, 200, new { status = "ok", scid = DEAD_ISLAND_SCID,
                                               game = "Dead Island Definitive Edition", port = PORT });
                }
                else if (path == "/save/list" && req.HttpMethod == "GET")
                {
                    await HandleList(resp);
                }
                else if (path == "/save/download" && req.HttpMethod == "GET")
                {
                    string container = query["container"] ?? "";
                    string blob      = query["blob"] ?? "";
                    if (string.IsNullOrEmpty(container) || string.IsNullOrEmpty(blob))
                        await Json(resp, 400, new { error = "container and blob params required" });
                    else
                        await HandleDownload(resp, container, blob);
                }
                else if (path == "/save/upload" && req.HttpMethod == "POST")
                {
                    string container = query["container"] ?? "";
                    string blob      = query["blob"] ?? "";
                    if (string.IsNullOrEmpty(container) || string.IsNullOrEmpty(blob))
                        await Json(resp, 400, new { error = "container and blob params required" });
                    else
                        await HandleUpload(req, resp, container, blob);
                }
                else
                {
                    await Json(resp, 404, new { error = "Not found" });
                }
            }
            catch (Exception ex)
            {
                Log($"Request error: {ex.Message}");
                try { await Json(resp, 500, new { error = ex.Message }); } catch { }
            }
        }

        // -------------------------------------------------------------------
        // List: return all containers and their blob names
        // -------------------------------------------------------------------
        private async Task HandleList(HttpListenerResponse resp)
        {
            // GetContainerInfoQuery() returns a query object (sync)
            var infoQuery = _provider.GetContainerInfoQuery();
            var infoResult = await infoQuery.GetContainerInfoAsync();
            if (infoResult.Status != GameSaveErrorStatus.Ok)
            {
                await Json(resp, 500, new { error = $"GetContainerInfoAsync failed: {infoResult.Status}" });
                return;
            }

            var list = new System.Collections.Generic.List<object>();
            foreach (var info in infoResult.Value)
            {
                // For each container get its blob names
                var container  = _provider.CreateContainer(info.Name);
                var blobQuery  = container.GetBlobInfoQuery();
                var blobResult = await blobQuery.GetBlobInfoAsync();
                var blobs      = new System.Collections.Generic.List<string>();
                if (blobResult.Status == GameSaveErrorStatus.Ok)
                    foreach (var b in blobResult.Value)
                        blobs.Add(b.Name);

                list.Add(new { name = info.Name, size = info.TotalSize, blobs = blobs.ToArray() });
            }

            await Json(resp, 200, new { containers = list.ToArray(), count = list.Count });
        }

        // -------------------------------------------------------------------
        // Download: read a single blob from a container
        // -------------------------------------------------------------------
        private async Task HandleDownload(HttpListenerResponse resp, string containerName, string blobName)
        {
            var container = _provider.CreateContainer(containerName);

            // GetAsync reads named blobs; returns GameSaveBlobGetResult
            var getResult = await container.GetAsync(new[] { blobName });
            if (getResult.Status != GameSaveErrorStatus.Ok)
            {
                await Json(resp, 404, new { error = $"GetAsync failed: {getResult.Status}" });
                return;
            }

            if (!getResult.Value.ContainsKey(blobName))
            {
                await Json(resp, 404, new { error = $"Blob '{blobName}' not in result" });
                return;
            }

            var buffer = getResult.Value[blobName];
            var bytes  = new byte[buffer.Length];
            using (var dr = Windows.Storage.Streams.DataReader.FromBuffer(buffer))
                dr.ReadBytes(bytes);

            resp.StatusCode      = 200;
            resp.ContentType     = "application/octet-stream";
            resp.ContentLength64 = bytes.Length;
            resp.Headers.Add("Content-Disposition", $"attachment; filename=\"{blobName}\"");
            await resp.OutputStream.WriteAsync(bytes, 0, bytes.Length);
            resp.OutputStream.Close();
            Log($"Downloaded {containerName}/{blobName} ({bytes.Length} bytes)");
        }

        // -------------------------------------------------------------------
        // Upload: write a single blob to a container via SubmitUpdatesAsync
        // -------------------------------------------------------------------
        private async Task HandleUpload(HttpListenerRequest req, HttpListenerResponse resp,
                                        string containerName, string blobName)
        {
            using (var ms = new MemoryStream())
            {
                await req.InputStream.CopyToAsync(ms);
                var bytes = ms.ToArray();
                if (bytes.Length == 0) { await Json(resp, 400, new { error = "Empty body" }); return; }

                var writer = new Windows.Storage.Streams.DataWriter();
                writer.WriteBytes(bytes);
                var buffer = writer.DetachBuffer();

                var container   = _provider.CreateContainer(containerName);
                var writeResult = await container.SubmitUpdatesAsync(
                    new Dictionary<string, Windows.Storage.Streams.IBuffer> { [blobName] = buffer },
                    null,
                    $"SaveBridge {DateTime.UtcNow:o}");

                if (writeResult.Status != GameSaveErrorStatus.Ok)
                {
                    await Json(resp, 500, new { error = $"SubmitUpdatesAsync failed: {writeResult.Status}" });
                    return;
                }

                await Json(resp, 200, new { ok = true, bytes = bytes.Length, blob = $"{containerName}/{blobName}" });
                Log($"Uploaded {containerName}/{blobName} ({bytes.Length} bytes)");
            }
        }

        // -------------------------------------------------------------------
        // Helpers
        // -------------------------------------------------------------------
        private static async Task Json(HttpListenerResponse resp, int code, object data)
        {
            var json  = Serialize(data);
            var bytes = Encoding.UTF8.GetBytes(json);
            resp.StatusCode      = code;
            resp.ContentType     = "application/json";
            resp.ContentLength64 = bytes.Length;
            await resp.OutputStream.WriteAsync(bytes, 0, bytes.Length);
            resp.OutputStream.Close();
        }

        private static string Serialize(object obj)
        {
            using (var ms = new MemoryStream())
            {
                new DataContractJsonSerializer(obj.GetType()).WriteObject(ms, obj);
                return Encoding.UTF8.GetString(ms.ToArray());
            }
        }

        private static void Log(string msg) =>
            System.Diagnostics.Debug.WriteLine($"[SaveBridge] {msg}");

        public void Stop() { _listener?.Stop(); _listener?.Close(); }
    }
}
