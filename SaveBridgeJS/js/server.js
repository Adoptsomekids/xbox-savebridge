/// <reference path="//Microsoft.WinJS.4.4/js/base.js" />
// SaveBridge JavaScript UWP — WGS filesystem HTTP bridge
// Runs under WWAHost.exe, no .NET runtime required.
// WinRT APIs accessed via Windows.* namespace directly.

"use strict";

var PORT = 8765;
var _listener = null;
var _running  = false;

// ---- UI helpers --------------------------------------------------------

function log(msg) {
    var el = document.getElementById("log");
    var ts = new Date().toLocaleTimeString();
    el.textContent += "[" + ts + "] " + msg + "\n";
    el.scrollTop = el.scrollHeight;
}

function setStatus(msg, color) {
    var el = document.getElementById("status");
    el.textContent = "Status: " + msg;
    el.style.color = color || "#81c784";
}

function setAddr(msg) {
    document.getElementById("addr").textContent = msg;
}

// ---- Server ------------------------------------------------------------

function startServer() {
    if (_running) return;
    document.getElementById("btnStart").disabled = true;
    document.getElementById("btnStop").disabled  = false;
    setStatus("Starting…", "#ffb74d");
    log("Binding StreamSocketListener on port " + PORT + "…");

    try {
        _listener = new Windows.Networking.Sockets.StreamSocketListener();
        _listener.addEventListener("connectionreceived", onConnection);
        _listener.bindServiceNameAsync(String(PORT)).then(function () {
            _running = true;
            setStatus("Running — port " + PORT, "#81c784");
            setAddr("http://<xbox-ip>:" + PORT + "/status");
            log("SaveBridge listening on port " + PORT + ".");
        }, function (err) {
            log("ERROR binding: " + err.message);
            setStatus("Error — see log", "#ef5350");
            document.getElementById("btnStart").disabled = false;
            document.getElementById("btnStop").disabled  = true;
        });
    } catch (ex) {
        log("EXCEPTION: " + ex.message);
        setStatus("Error — see log", "#ef5350");
        document.getElementById("btnStart").disabled = false;
        document.getElementById("btnStop").disabled  = true;
    }
}

function stopServer() {
    if (!_running) return;
    _running = false;
    if (_listener) { _listener.close(); _listener = null; }
    document.getElementById("btnStart").disabled = false;
    document.getElementById("btnStop").disabled  = true;
    setStatus("Stopped", "#90a4ae");
    setAddr("");
    log("Server stopped.");
}

// ---- Connection handler ------------------------------------------------

function onConnection(ev) {
    var socket = ev.socket;
    var remote = socket.information.remoteAddress.displayName || "?";

    var reader = new Windows.Storage.Streams.DataReader(socket.inputStream);
    reader.inputStreamOptions = Windows.Storage.Streams.InputStreamOptions.partial;

    readRequest(reader, remote, socket);
}

function readRequest(reader, remote, socket) {
    // Read HTTP request head byte-by-byte until \r\n\r\n
    var head = "";
    var contentLength = 0;

    function readByte() {
        return reader.loadAsync(1).then(function (loaded) {
            if (loaded === 0) return WinJS.Promise.wrap(null);
            var b = reader.readByte();
            head += String.fromCharCode(b);
            if (head.slice(-4) === "\r\n\r\n") {
                // Parse Content-Length
                var clMatch = head.match(/content-length:\s*(\d+)/i);
                if (clMatch) contentLength = parseInt(clMatch[1], 10);
                return finishRequest();
            }
            return readByte();
        });
    }

    function finishRequest() {
        if (contentLength === 0) return dispatch(head, new Uint8Array(0), remote, socket);
        return reader.loadAsync(contentLength).then(function () {
            var bodyBytes = new Uint8Array(contentLength);
            reader.readBytes(bodyBytes);
            return dispatch(head, bodyBytes, remote, socket);
        });
    }

    readByte().then(null, function (err) {
        log("Read error from " + remote + ": " + err.message);
        socket.close();
    });
}

// ---- Request dispatcher ------------------------------------------------

function dispatch(head, bodyBytes, remote, socket) {
    var firstLine = head.split("\r\n")[0];
    log(remote + " → " + firstLine);

    var parts  = firstLine.split(" ");
    var method = (parts[0] || "").toUpperCase();
    var rawUrl = parts[1] || "/";
    var qIdx   = rawUrl.indexOf("?");
    var path   = (qIdx >= 0 ? rawUrl.slice(0, qIdx) : rawUrl).toLowerCase().replace(/\/+$/, "");
    var qs     = qIdx >= 0 ? rawUrl.slice(qIdx + 1) : "";
    var query  = parseQuery(qs);

    var writer = new Windows.Storage.Streams.DataWriter(socket.outputStream);

    var p;
    if (path === "/status" && method === "GET") {
        p = sendJson(writer, 200, JSON.stringify({ status: "ok", port: PORT, build: "v10-js" }));
    } else if (path === "/wgs/list" && method === "GET") {
        p = handleWgsList(writer);
    } else if (path === "/wgs/download" && method === "GET") {
        var relPath = query["path"] || "";
        if (!relPath) {
            p = sendJson(writer, 400, JSON.stringify({ error: "path param required" }));
        } else {
            p = handleWgsDownload(writer, relPath);
        }
    } else if (path === "/wgs/upload" && method === "POST") {
        var relPath = query["path"] || "";
        if (!relPath || bodyBytes.length === 0) {
            p = sendJson(writer, 400, JSON.stringify({ error: "path and body required" }));
        } else {
            p = handleWgsUpload(writer, relPath, bodyBytes);
        }
    } else {
        p = sendJson(writer, 404, JSON.stringify({ error: "not found", path: path }));
    }

    p.then(function () {
        return writer.storeAsync();
    }).then(function () {
        writer.detachStream();
        socket.close();
    }, function (err) {
        log("Write error: " + err.message);
        socket.close();
    });
}

// ---- WGS handlers ------------------------------------------------------

function wgsBase() {
    // LocalFolder = ...\Packages\<PFN>\LocalState
    // WGS         = ...\Packages\<PFN>\SystemAppData\wgs
    var local = Windows.Storage.ApplicationData.current.localFolder.path;
    // Navigate up from LocalState to package root, then into SystemAppData\wgs
    var pkg   = local.replace(/\\LocalState$/, "").replace(/\/LocalState$/, "");
    return pkg + "\\SystemAppData\\wgs";
}

function handleWgsList(writer) {
    var base = wgsBase();
    log("WGS base: " + base);

    return Windows.Storage.StorageFolder.getFolderFromPathAsync(base).then(function (wgsFolder) {
        return enumerateWgs(wgsFolder, base);
    }).then(function (result) {
        return sendJson(writer, 200, JSON.stringify(result));
    }, function (err) {
        return sendJson(writer, 500, JSON.stringify({ error: err.message, wgsBase: base }));
    });
}

function enumerateWgs(wgsFolder, basePath) {
    var result = { wgsBase: basePath, users: [] };
    return wgsFolder.getFoldersAsync().then(function (userFolders) {
        var tasks = [];
        userFolders.forEach(function (uf) {
            var userObj = { xuid: uf.name, containers: [] };
            result.users.push(userObj);
            var t = uf.getFilesAsync().then(function (files) {
                userObj.files = files.map(function (f) { return f.name; });
            }).then(function () {
                return uf.getFoldersAsync();
            }).then(function (containerFolders) {
                var ct = [];
                containerFolders.forEach(function (cf) {
                    var c = { guid: cf.name, blobs: [] };
                    userObj.containers.push(c);
                    ct.push(cf.getFilesAsync().then(function (blobs) {
                        c.blobs = blobs.map(function (b) { return b.name; });
                    }));
                });
                return WinJS.Promise.join(ct);
            });
            tasks.push(t);
        });
        return WinJS.Promise.join(tasks);
    }).then(function () {
        return result;
    });
}

function handleWgsDownload(writer, relPath) {
    var base    = wgsBase();
    var fullPath = base + "\\" + relPath.replace(/\//g, "\\");
    log("WGS download: " + fullPath);

    return Windows.Storage.StorageFile.getFileFromPathAsync(fullPath).then(function (file) {
        return Windows.Storage.FileIO.readBufferAsync(file);
    }).then(function (buf) {
        var bytes = new Uint8Array(buf.length);
        var dr = Windows.Storage.Streams.DataReader.fromBuffer(buf);
        dr.readBytes(bytes);
        return sendBinary(writer, bytes, relPath.split(/[\\/]/).pop());
    }, function (err) {
        return sendJson(writer, 500, JSON.stringify({ error: err.message }));
    });
}

function handleWgsUpload(writer, relPath, bodyBytes) {
    var base     = wgsBase();
    var fullPath = base + "\\" + relPath.replace(/\//g, "\\");
    var dir      = fullPath.substring(0, fullPath.lastIndexOf("\\"));
    var fname    = fullPath.substring(fullPath.lastIndexOf("\\") + 1);
    log("WGS upload: " + fullPath + " (" + bodyBytes.length + " bytes)");

    return Windows.Storage.StorageFolder.getFolderFromPathAsync(dir).then(null, function () {
        // Directory doesn't exist — try to create it
        var parent = dir.substring(0, dir.lastIndexOf("\\"));
        var child  = dir.substring(dir.lastIndexOf("\\") + 1);
        return Windows.Storage.StorageFolder.getFolderFromPathAsync(parent).then(function (pf) {
            return pf.createFolderAsync(child, Windows.Storage.CreationCollisionOption.openIfExists);
        });
    }).then(function (folder) {
        return folder.createFileAsync(fname, Windows.Storage.CreationCollisionOption.replaceExisting);
    }).then(function (file) {
        var dw = new Windows.Storage.Streams.DataWriter();
        dw.writeBytes(bodyBytes);
        var ibuf = dw.detachBuffer();
        return Windows.Storage.FileIO.writeBufferAsync(file, ibuf);
    }).then(function () {
        return sendJson(writer, 200, JSON.stringify({ ok: true, bytes: bodyBytes.length, path: relPath }));
    }, function (err) {
        return sendJson(writer, 500, JSON.stringify({ error: err.message }));
    });
}

// ---- HTTP helpers ------------------------------------------------------

function sendJson(writer, code, json) {
    var body = encodeUtf8(json);
    var head = httpHead(code, "application/json", body.length);
    writer.writeBytes(encodeUtf8(head));
    writer.writeBytes(body);
    return WinJS.Promise.wrap();
}

function sendBinary(writer, bytes, filename) {
    var head = "HTTP/1.1 200 OK\r\n" +
               "Content-Type: application/octet-stream\r\n" +
               "Content-Disposition: attachment; filename=\"" + filename + "\"\r\n" +
               "Content-Length: " + bytes.length + "\r\n" +
               "Access-Control-Allow-Origin: *\r\n" +
               "Connection: close\r\n\r\n";
    writer.writeBytes(encodeUtf8(head));
    writer.writeBytes(bytes);
    return WinJS.Promise.wrap();
}

function httpHead(code, ct, len) {
    var texts = { 200: "OK", 400: "Bad Request", 403: "Forbidden",
                  404: "Not Found", 500: "Internal Server Error" };
    return "HTTP/1.1 " + code + " " + (texts[code] || "Unknown") + "\r\n" +
           "Content-Type: " + ct + "\r\n" +
           "Content-Length: " + len + "\r\n" +
           "Access-Control-Allow-Origin: *\r\n" +
           "Connection: close\r\n\r\n";
}

// ---- Utilities ---------------------------------------------------------

function parseQuery(qs) {
    var q = {};
    if (!qs) return q;
    qs.split("&").forEach(function (pair) {
        var eq = pair.indexOf("=");
        if (eq > 0) {
            q[decodeURIComponent(pair.slice(0, eq)).toLowerCase()] =
              decodeURIComponent(pair.slice(eq + 1));
        }
    });
    return q;
}

function encodeUtf8(str) {
    var bytes = [];
    for (var i = 0; i < str.length; i++) {
        var c = str.charCodeAt(i);
        if (c < 0x80) {
            bytes.push(c);
        } else if (c < 0x800) {
            bytes.push(0xC0 | (c >> 6), 0x80 | (c & 0x3F));
        } else {
            bytes.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F));
        }
    }
    return new Uint8Array(bytes);
}
