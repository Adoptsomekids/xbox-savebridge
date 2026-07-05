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
    ///   GET  /status             → {"status":"ok","xuid":"..."}
    ///   GET  /save/list          → {"blobs":["save0","save1",...]}
    ///   GET  /save/download?name=save0  → raw binary blob
    ///   POST /save/upload?name=save0    → body=raw binary blob → {"ok":true}
    /// </summary>
    public class SaveBridgeServer
    {
        // Dead Island Definitive Edition SCID
        private const string DEAD_ISLAND_SCID = "db860100-d780-4e17-8685-ad130052ea64";
        private const int PORT = 8765;

        private HttpListener _listener;
        private GameSaveProvider _provider;
        private User _user;

        public async Task StartAsync()
        {
            // Get the first signed-in Xbox Live user
            var users = await User.FindAllAsync();
            if (users.Count == 0)
                throw new InvalidOperationException("No Xbox Live user signed in.");

            _user = users[0];
            LogMessage($"User: {_user.NonRoamableId}");

            // Open the game save provider for Dead Island DE
            var result = await GameSaveProvider.GetForUserAsync(_user, DEAD_ISLAND_SCID);
            if (result.Status != GameSaveErrorStatus.Ok)
                throw new InvalidOperationException($"Failed to open GameSaveProvider: {result.Status}");

            _provider = result.Value;
            LogMessage($"GameSaveProvider opened for SCID {DEAD_ISLAND_SCID}");

            // Start HTTP listener
            _listener = new HttpListener();
            _listener.Prefixes.Add($"http://*:{PORT}/");
            _listener.Start();
            LogMessage($"SaveBridge HTTP server running on port {PORT}");

            // Accept requests
            while (_listener.IsListening)
            {
                try
                {
                    var context = await _listener.GetContextAsync();
                    _ = HandleRequestAsync(context); // fire-and-forget
                }
                catch (Exception ex)
                {
                    LogMessage($"Listener error: {ex.Message}");
                }
            }
        }

        private async Task HandleRequestAsync(HttpListenerContext context)
        {
            var req  = context.Request;
            var resp = context.Response;

            try
            {
                var path = req.Url.AbsolutePath.TrimEnd('/').ToLowerInvariant();
                var query = req.QueryString;

                LogMessage($"{req.HttpMethod} {req.Url.PathAndQuery}");

                if (path == "/status" && req.HttpMethod == "GET")
                {
                    await WriteJsonAsync(resp, 200, new
                    {
                        status = "ok",
                        scid   = DEAD_ISLAND_SCID,
                        game   = "Dead Island Definitive Edition",
                        port   = PORT
                    });
                }
                else if (path == "/save/list" && req.HttpMethod == "GET")
                {
                    await HandleListAsync(resp);
                }
                else if (path == "/save/download" && req.HttpMethod == "GET")
                {
                    string blobName = query["name"] ?? "save0";
                    await HandleDownloadAsync(resp, blobName);
                }
                else if (path == "/save/upload" && req.HttpMethod == "POST")
                {
                    string blobName = query["name"] ?? "save0";
                    await HandleUploadAsync(req, resp, blobName);
                }
                else
                {
                    await WriteJsonAsync(resp, 404, new { error = "Not found" });
                }
            }
            catch (Exception ex)
            {
                LogMessage($"Request error: {ex.Message}");
                try { await WriteJsonAsync(resp, 500, new { error = ex.Message }); } catch { }
            }
        }

        private async Task HandleListAsync(HttpListenerResponse resp)
        {
            // List all game save containers (save slots)
            var query = _provider.CreateContainerQuery();
            var containers = await query.GetContainersAsync();

            var names = new List<string>();
            foreach (var container in containers.Value)
            {
                // Each container holds blobs — list them
                var blobQuery = container.CreateBlobQuery();
                var blobs     = await blobQuery.GetBlobsAsync();
                foreach (var blob in blobs.Value)
                    names.Add($"{container.Name}/{blob.Name}");
            }

            await WriteJsonAsync(resp, 200, new { blobs = names, count = names.Count });
        }

        private async Task HandleDownloadAsync(HttpListenerResponse resp, string blobPath)
        {
            // blobPath = "containerName/blobName"
            var parts = blobPath.Split('/', 2);
            if (parts.Length < 2)
            {
                await WriteJsonAsync(resp, 400, new { error = "name must be containerName/blobName" });
                return;
            }

            var container = _provider.CreateContainer(parts[0]);
            var readResult = await container.ReadAsync(new Dictionary<string, object>
            {
                [parts[1]] = (object)(uint)0  // placeholder — actual size set by API
            });

            if (readResult.Status != GameSaveErrorStatus.Ok)
            {
                await WriteJsonAsync(resp, 404, new { error = $"Blob not found: {readResult.Status}" });
                return;
            }

            var buffer = readResult.Value[parts[1]] as Windows.Storage.Streams.IBuffer;
            if (buffer == null)
            {
                await WriteJsonAsync(resp, 500, new { error = "Null buffer returned" });
                return;
            }

            var bytes = new byte[buffer.Length];
            using var dr = Windows.Storage.Streams.DataReader.FromBuffer(buffer);
            dr.ReadBytes(bytes);

            resp.StatusCode    = 200;
            resp.ContentType   = "application/octet-stream";
            resp.ContentLength64 = bytes.Length;
            resp.Headers.Add("Content-Disposition", $"attachment; filename=\"{parts[1]}\"");
            await resp.OutputStream.WriteAsync(bytes, 0, bytes.Length);
            resp.OutputStream.Close();

            LogMessage($"Downloaded blob {blobPath} ({bytes.Length} bytes)");
        }

        private async Task HandleUploadAsync(HttpListenerRequest req, HttpListenerResponse resp, string blobPath)
        {
            var parts = blobPath.Split('/', 2);
            if (parts.Length < 2)
            {
                await WriteJsonAsync(resp, 400, new { error = "name must be containerName/blobName" });
                return;
            }

            // Read body
            using var ms = new MemoryStream();
            await req.InputStream.CopyToAsync(ms);
            var bytes = ms.ToArray();

            if (bytes.Length == 0)
            {
                await WriteJsonAsync(resp, 400, new { error = "Empty body" });
                return;
            }

            var container  = _provider.CreateContainer(parts[0]);
            var dataWriter = new Windows.Storage.Streams.DataWriter();
            dataWriter.WriteBytes(bytes);
            var buffer = dataWriter.DetachBuffer();

            var writeResult = await container.SubmitUpdatesAsync(
                new Dictionary<string, Windows.Storage.Streams.IBuffer> { [parts[1]] = buffer },
                null,
                $"SaveBridge upload {DateTime.UtcNow:o}"
            );

            if (writeResult.Status != GameSaveErrorStatus.Ok)
            {
                await WriteJsonAsync(resp, 500, new { error = $"Write failed: {writeResult.Status}" });
                return;
            }

            await WriteJsonAsync(resp, 200, new { ok = true, bytes = bytes.Length, blob = blobPath });
            LogMessage($"Uploaded blob {blobPath} ({bytes.Length} bytes)");
        }

        private static async Task WriteJsonAsync(HttpListenerResponse resp, int statusCode, object data)
        {
            var json  = SimpleJsonSerialize(data);
            var bytes = Encoding.UTF8.GetBytes(json);
            resp.StatusCode      = statusCode;
            resp.ContentType     = "application/json";
            resp.ContentLength64 = bytes.Length;
            await resp.OutputStream.WriteAsync(bytes, 0, bytes.Length);
            resp.OutputStream.Close();
        }

        private static string SimpleJsonSerialize(object obj)
        {
            // Simple JSON serializer for anonymous objects
            using var ms     = new MemoryStream();
            var serializer   = new DataContractJsonSerializer(obj.GetType());
            serializer.WriteObject(ms, obj);
            return Encoding.UTF8.GetString(ms.ToArray());
        }

        private static void LogMessage(string msg)
        {
            System.Diagnostics.Debug.WriteLine($"[SaveBridge] {msg}");
        }

        public void Stop()
        {
            _listener?.Stop();
            _listener?.Close();
        }
    }
}
