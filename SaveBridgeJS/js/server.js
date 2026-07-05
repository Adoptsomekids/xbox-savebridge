/// SaveBridge JS UWP — StreamSocketListener HTTP bridge, port 8765
/// Uses only native WinRT async (no WinJS dependency)
"use strict";

var PORT     = 8765;
var _listener = null;
var _running  = false;

// ── UI helpers ──────────────────────────────────────────────────────────────
function log(msg) {
    var el = document.getElementById("log");
    var ts  = new Date().toLocaleTimeString("en-US", {hour12:false});
    el.textContent += "[" + ts + "] " + msg + "\n";
    el.scrollTop = el.scrollHeight;
}
function setStatus(msg, col) {
    var el = document.getElementById("status");
    el.textContent   = "Status: " + msg;
    el.style.color   = col || "#81c784";
}
function setAddr(msg) { document.getElementById("addr").textContent = msg; }

// ── Auto-start on load ──────────────────────────────────────────────────────
window.addEventListener("load", function () {
    log("SaveBridge v10-js loaded, auto-starting server...");
    startServer();
});

// ── Server start / stop ─────────────────────────────────────────────────────
function startServer() {
    if (_running) return;
    document.getElementById("btnStart").disabled = true;
    setStatus("Starting…", "#ffb74d");
    log("Creating StreamSocketListener on port " + PORT + "...");

    try {
        _listener = new Windows.Networking.Sockets.StreamSocketListener();
        _listener.addEventListener("connectionreceived", onConnection);

        var bindOp = _listener.bindServiceNameAsync(String(PORT));
        bindOp.oncomplete = function () {
            _running = true;
            document.getElementById("btnStop").disabled = false;
            setStatus("Running — port " + PORT, "#81c784");
            setAddr("http://<xbox-ip>:" + PORT + "/status");
            log("SaveBridge listening on port " + PORT + "  ✓");
        };
        bindOp.onerror = function (ev) {
            var msg = ev.detail ? ev.detail.message : String(ev);
            log("ERROR binding: " + msg);
            setStatus("Bind error — see log", "#ef5350");
            document.getElementById("btnStart").disabled = false;
        };
    } catch (ex) {
        log("EXCEPTION in startServer: " + (ex.message || ex));
        setStatus("Exception — see log", "#ef5350");
        document.getElementById("btnStart").disabled = false;
    }
}

function stopServer() {
    if (!_running) return;
    _running = false;
    try { if (_listener) { _listener.close(); _listener = null; } } catch(e){}
    document.getElementById("btnStart").disabled = false;
    document.getElementById("btnStop").disabled  = true;
    setStatus("Stopped", "#90a4ae");
    setAddr("");
    log("Server stopped.");
}

// ── Connection handler ──────────────────────────────────────────────────────
function onConnection(ev) {
    var socket = ev.socket;
    var remote = "";
    try { remote = socket.information.remoteAddress.displayName; } catch(e){}

    var reader = new Windows.Storage.Streams.DataReader(socket.inputStream);
    reader.inputStreamOptions =
        Windows.Storage.Streams.InputStreamOptions.partial;

    var head = "";
    var contentLength = 0;

    function readNextByte() {
        var op = reader.loadAsync(1);
        op.oncomplete = function () {
            if (reader.unconsumedBufferLength === 0) {
                finishWithBody();
                return;
            }
            head += String.fromCharCode(reader.readByte());
            if (head.slice(-4) === "\r\n\r\n") {
                var m = head.match(/[Cc]ontent-[Ll]ength:\s*(\d+)/);
                if (m) contentLength = parseInt(m[1], 10);
                finishWithBody();
            } else {
                readNextByte();
            }
        };
        op.onerror = function (ev) {
            log("Read error from " + remote + ": " + (ev.detail ? ev.detail.message : ev));
            try { socket.close(); } catch(e){}
        };
    }

    function finishWithBody() {
        if (contentLength === 0) {
            dispatch(head, new Uint8Array(0), remote, socket);
            return;
        }
        var op2 = reader.loadAsync(contentLength);
        op2.oncomplete = function () {
            var bytes = new Uint8Array(contentLength);
            reader.readBytes(bytes);
            dispatch(head, bytes, remote, socket);
        };
        op2.onerror = function (ev) {
            log("Body read error: " + (ev.detail ? ev.detail.message : ev));
            try { socket.close(); } catch(e){}
        };
    }

    readNextByte();
}

// ── Request dispatcher ──────────────────────────────────────────────────────
function dispatch(head, bodyBytes, remote, socket) {
    var firstLine = head.split("\r\n")[0];
    log(remote + " → " + firstLine);

    var parts  = firstLine.split(" ");
    var method = (parts[0] || "").toUpperCase();
    var rawUrl = parts[1] || "/";
    var qIdx   = rawUrl.indexOf("?");
    var path   = (qIdx >= 0 ? rawUrl.slice(0, qIdx) : rawUrl)
                   .toLowerCase().replace(/\/+$/, "") || "/";
    var qs     = qIdx >= 0 ? rawUrl.slice(qIdx + 1) : "";
    var query  = parseQuery(qs);

    var writer = new Windows.Storage.Streams.DataWriter(socket.outputStream);

    function done() {
        var storeOp = writer.storeAsync();
        storeOp.oncomplete = function () {
            writer.detachStream();
            try { socket.close(); } catch(e){}
        };
        storeOp.onerror = function () {
            try { socket.close(); } catch(e){}
        };
    }

    if (path === "/status" && method === "GET") {
        sendJson(writer, 200, {status:"ok", port:PORT, build:"v10-js"});
        done();
    } else if (path === "/wgs/list" && method === "GET") {
        handleWgsList(writer, done);
    } else if (path === "/wgs/download" && method === "GET") {
        var rp = query["path"] || "";
        if (!rp) { sendJson(writer, 400, {error:"path required"}); done(); }
        else      { handleWgsDownload(writer, rp, done); }
    } else if (path === "/wgs/upload" && method === "POST") {
        var rp = query["path"] || "";
        if (!rp || !bodyBytes.length) {
            sendJson(writer, 400, {error:"path + body required"}); done();
        } else {
            handleWgsUpload(writer, rp, bodyBytes, done);
        }
    } else {
        sendJson(writer, 404, {error:"not found", path:path});
        done();
    }
}

// ── WGS helpers ─────────────────────────────────────────────────────────────
function wgsBase() {
    var local = Windows.Storage.ApplicationData.current.localFolder.path;
    // LocalState → up one → SystemAppData\wgs
    var pkgRoot = local.replace(/\\LocalState$/i, "").replace(/\/LocalState$/i, "");
    return pkgRoot + "\\SystemAppData\\wgs";
}

function handleWgsList(writer, done) {
    var base = wgsBase();
    log("WGS base: " + base);
    var result = { wgsBase: base, users: [] };

    var op = Windows.Storage.StorageFolder.getFolderFromPathAsync(base);
    op.oncomplete = function (ev) {
        var wgsFolder = ev.target.result;
        var op2 = wgsFolder.getFoldersAsync();
        op2.oncomplete = function (ev2) {
            var userFolders = ev2.target.result;
            var pending = userFolders.size;
            if (pending === 0) { sendJson(writer, 200, result); done(); return; }

            userFolders.forEach(function (uf) {
                var userObj = { xuid: uf.name, files: [], containers: [] };
                result.users.push(userObj);

                var fop = uf.getFilesAsync();
                fop.oncomplete = function (fe) {
                    fe.target.result.forEach(function (f) { userObj.files.push(f.name); });

                    var cop = uf.getFoldersAsync();
                    cop.oncomplete = function (ce) {
                        var conFolders = ce.target.result;
                        var cpending   = conFolders.size;
                        if (cpending === 0) { if (--pending === 0) { sendJson(writer, 200, result); done(); } return; }

                        conFolders.forEach(function (cf) {
                            var cObj = { guid: cf.name, blobs: [] };
                            userObj.containers.push(cObj);
                            var bop = cf.getFilesAsync();
                            bop.oncomplete = function (be) {
                                be.target.result.forEach(function (b) { cObj.blobs.push(b.name); });
                                if (--cpending === 0 && --pending === 0) {
                                    sendJson(writer, 200, result);
                                    done();
                                }
                            };
                            bop.onerror = function () {
                                if (--cpending === 0 && --pending === 0) {
                                    sendJson(writer, 200, result);
                                    done();
                                }
                            };
                        });
                    };
                    cop.onerror = function () { if (--pending === 0) { sendJson(writer, 200, result); done(); } };
                };
                fop.onerror = function () { if (--pending === 0) { sendJson(writer, 200, result); done(); } };
            });
        };
        op2.onerror = function (e) {
            sendJson(writer, 500, {error: e.detail ? e.detail.message : "getFolders failed"});
            done();
        };
    };
    op.onerror = function (e) {
        var msg = e.detail ? e.detail.message : "folder not found";
        log("WGS folder error: " + msg);
        sendJson(writer, 500, {error: msg, wgsBase: base});
        done();
    };
}

function handleWgsDownload(writer, relPath, done) {
    var base     = wgsBase();
    var fullPath = base + "\\" + relPath.replace(/\//g, "\\");
    log("WGS download: " + fullPath);

    var op = Windows.Storage.StorageFile.getFileFromPathAsync(fullPath);
    op.oncomplete = function (ev) {
        var file = ev.target.result;
        var rop  = Windows.Storage.FileIO.readBufferAsync(file);
        rop.oncomplete = function (re) {
            var buf   = re.target.result;
            var bytes = new Uint8Array(buf.length);
            var dr    = Windows.Storage.Streams.DataReader.fromBuffer(buf);
            dr.readBytes(bytes);
            sendBinary(writer, bytes, relPath.split(/[\\/]/).pop());
            done();
            log("  → " + bytes.length + " bytes sent");
        };
        rop.onerror = function (e) {
            sendJson(writer, 500, {error: e.detail ? e.detail.message : "readBuffer failed"});
            done();
        };
    };
    op.onerror = function (e) {
        sendJson(writer, 404, {error: e.detail ? e.detail.message : "file not found", path: fullPath});
        done();
    };
}

function handleWgsUpload(writer, relPath, bodyBytes, done) {
    var base     = wgsBase();
    var fullPath = base + "\\" + relPath.replace(/\//g, "\\");
    var dir      = fullPath.substring(0, fullPath.lastIndexOf("\\"));
    var fname    = fullPath.substring(fullPath.lastIndexOf("\\") + 1);
    log("WGS upload: " + fullPath + " (" + bodyBytes.length + " bytes)");

    var op = Windows.Storage.StorageFolder.getFolderFromPathAsync(dir);
    op.oncomplete = function (ev) { writeFile(ev.target.result); };
    op.onerror    = function ()   {
        // Try creating parent folder
        var parent = dir.substring(0, dir.lastIndexOf("\\"));
        var child  = dir.substring(dir.lastIndexOf("\\") + 1);
        var pop = Windows.Storage.StorageFolder.getFolderFromPathAsync(parent);
        pop.oncomplete = function (pe) {
            var cop = pe.target.result.createFolderAsync(child,
                Windows.Storage.CreationCollisionOption.openIfExists);
            cop.oncomplete = function (ce) { writeFile(ce.target.result); };
            cop.onerror    = function (e)  { sendJson(writer, 500, {error: "mkdir: " + (e.detail||{}).message}); done(); };
        };
        pop.onerror = function (e) { sendJson(writer, 500, {error: "parent: " + (e.detail||{}).message}); done(); };
    };

    function writeFile(folder) {
        var cfop = folder.createFileAsync(fname,
            Windows.Storage.CreationCollisionOption.replaceExisting);
        cfop.oncomplete = function (ce) {
            var file = ce.target.result;
            var dw   = new Windows.Storage.Streams.DataWriter();
            dw.writeBytes(bodyBytes);
            var ibuf = dw.detachBuffer();
            var wop  = Windows.Storage.FileIO.writeBufferAsync(file, ibuf);
            wop.oncomplete = function () {
                sendJson(writer, 200, {ok:true, bytes:bodyBytes.length, path:relPath});
                done();
            };
            wop.onerror = function (e) { sendJson(writer, 500, {error: (e.detail||{}).message}); done(); };
        };
        cfop.onerror = function (e) { sendJson(writer, 500, {error: (e.detail||{}).message}); done(); };
    }
}

// ── HTTP response helpers ────────────────────────────────────────────────────
function sendJson(writer, code, obj) {
    var json  = JSON.stringify(obj);
    var body  = encodeUtf8(json);
    var head  = "HTTP/1.1 " + code + " " + statusText(code) + "\r\n" +
                "Content-Type: application/json\r\n" +
                "Content-Length: " + body.length + "\r\n" +
                "Access-Control-Allow-Origin: *\r\n" +
                "Connection: close\r\n\r\n";
    writer.writeBytes(encodeUtf8(head));
    writer.writeBytes(body);
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
}

function statusText(c) {
    return ({200:"OK",400:"Bad Request",403:"Forbidden",
             404:"Not Found",500:"Internal Server Error"})[c] || "Unknown";
}

// ── Utilities ────────────────────────────────────────────────────────────────
function parseQuery(qs) {
    var q = {};
    if (!qs) return q;
    qs.split("&").forEach(function (pair) {
        var eq = pair.indexOf("=");
        if (eq > 0)
            q[decodeURIComponent(pair.slice(0, eq)).toLowerCase()] =
              decodeURIComponent(pair.slice(eq + 1));
    });
    return q;
}

function encodeUtf8(str) {
    var out = [], c;
    for (var i = 0; i < str.length; i++) {
        c = str.charCodeAt(i);
        if (c < 0x80)       out.push(c);
        else if (c < 0x800) out.push(0xC0|(c>>6), 0x80|(c&0x3F));
        else                 out.push(0xE0|(c>>12), 0x80|((c>>6)&0x3F), 0x80|(c&0x3F));
    }
    return new Uint8Array(out);
}
