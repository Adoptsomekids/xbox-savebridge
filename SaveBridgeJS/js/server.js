/// SaveBridge JS UWP — StreamSocketListener HTTP bridge, port 8765
/// Uses only native WinRT async (no WinJS dependency)
/// v16: /di/wgs with known DI PFN; GameSaveProvider with timeout fallback
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
    log("SaveBridge v16-js loaded. Auto-starting...");
    setTimeout(startServer, 500);
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

        // Use .then() — available on WinRT IAsyncAction natively in WWAHost
        _listener.bindServiceNameAsync(String(PORT)).then(
            function () {
                _running = true;
                document.getElementById("btnStop").disabled = false;
                setStatus("Running — port " + PORT, "#81c784");
                setAddr("http://<xbox-ip>:" + PORT + "/status");
                log("SaveBridge v16 listening on port " + PORT + "  ✓");
            },
            function (err) {
                var msg = err && err.message ? err.message : String(err);
                log("ERROR binding port " + PORT + ": " + msg);
                setStatus("Bind error — see log", "#ef5350");
                document.getElementById("btnStart").disabled = false;
            }
        );
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

    // Use .then() for WinRT async in WWAHost
    function readNextByte() {
        reader.loadAsync(1).then(function (loaded) {
            if (loaded === 0) { finishWithBody(); return; }
            head += String.fromCharCode(reader.readByte());
            if (head.slice(-4) === "\r\n\r\n") {
                var m = head.match(/[Cc]ontent-[Ll]ength:\s*(\d+)/);
                if (m) contentLength = parseInt(m[1], 10);
                finishWithBody();
            } else {
                readNextByte();
            }
        }, function (err) {
            log("Read error from " + remote + ": " + (err && err.message ? err.message : err));
            try { socket.close(); } catch(e){}
        });
    }

    function finishWithBody() {
        if (contentLength === 0) { dispatch(head, new Uint8Array(0), remote, socket); return; }
        reader.loadAsync(contentLength).then(function () {
            var bytes = new Uint8Array(contentLength);
            reader.readBytes(bytes);
            dispatch(head, bytes, remote, socket);
        }, function (err) {
            log("Body read error: " + (err && err.message ? err.message : err));
            try { socket.close(); } catch(e){}
        });
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
        writer.storeAsync().then(function () {
            writer.detachStream();
            try { socket.close(); } catch(e){}
        }, function () {
            try { socket.close(); } catch(e){}
        });
    }

    if (path === "/status" && method === "GET") {
        sendJson(writer, 200, {status:"ok", port:PORT, build:"v16-js"});
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
    } else if (path === "/browse" && method === "GET") {
        var abspath = query["path"] || "";
        if (!abspath) { sendJson(writer, 400, {error:"path required"}); done(); }
        else { handleBrowse(writer, abspath, done); }
    } else if (path === "/di/list" && method === "GET") {
        handleDiList(writer, done);
    } else if (path === "/di/download" && method === "GET") {
        var rp = query["path"] || "";
        if (!rp) { sendJson(writer, 400, {error:"path required"}); done(); }
        else { handleDiDownload(writer, rp, done); }
    } else if (path === "/cs/list" && method === "GET") {
        // Connected Storage (GameSaveProvider) — requires Xbox Live; may fail with 0x80832003
        handleCsList(writer, done);
    } else if (path === "/cs/download" && method === "GET") {
        var container = query["container"] || "";
        var blob      = query["blob"] || "";
        if (!container || !blob) { sendJson(writer, 400, {error:"container+blob required"}); done(); }
        else { handleCsDownload(writer, container, blob, done); }
    } else if (path === "/di/wgs" && method === "GET") {
        // Direct filesystem read of DI WGS using known PFN across partition candidates
        handleDiWgs(writer, done);
    } else if (path === "/di/wgs/download" && method === "GET") {
        var wgsPath = query["path"] || "";
        if (!wgsPath) { sendJson(writer, 400, {error:"path required"}); done(); }
        else { handleDiWgsDownload(writer, wgsPath, done); }
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
    var base   = wgsBase();
    var result = { wgsBase: base, users: [] };
    log("WGS base: " + base);

    Windows.Storage.StorageFolder.getFolderFromPathAsync(base).then(function (wgsFolder) {
        return wgsFolder.getFoldersAsync();
    }).then(function (userFolders) {
        var pending = userFolders.size;
        if (pending === 0) { sendJson(writer, 200, result); done(); return; }

        userFolders.forEach(function (uf) {
            var userObj = { xuid: uf.name, files: [], containers: [] };
            result.users.push(userObj);

            uf.getFilesAsync().then(function (files) {
                files.forEach(function (f) { userObj.files.push(f.name); });
                return uf.getFoldersAsync();
            }).then(function (conFolders) {
                var cpending = conFolders.size;
                if (cpending === 0) { if (--pending === 0) { sendJson(writer, 200, result); done(); } return; }
                conFolders.forEach(function (cf) {
                    var cObj = { guid: cf.name, blobs: [] };
                    userObj.containers.push(cObj);
                    cf.getFilesAsync().then(function (blobs) {
                        blobs.forEach(function (b) { cObj.blobs.push(b.name); });
                    }).then(null, function(){}).then(function () {
                        if (--cpending === 0 && --pending === 0) { sendJson(writer, 200, result); done(); }
                    });
                });
            }, function () {
                if (--pending === 0) { sendJson(writer, 200, result); done(); }
            });
        });
    }, function (e) {
        log("WGS base not found: " + (e && e.message ? e.message : e));
        sendJson(writer, 500, { error: "wgs folder not found", wgsBase: base });
        done();
    });
}

function handleWgsDownload(writer, relPath, done) {
    var base     = wgsBase();
    var fullPath = base + "\\" + relPath.replace(/\//g, "\\");
    log("WGS download: " + fullPath);

    Windows.Storage.StorageFile.getFileFromPathAsync(fullPath).then(function (file) {
        return Windows.Storage.FileIO.readBufferAsync(file);
    }).then(function (buf) {
        var bytes = new Uint8Array(buf.length);
        Windows.Storage.Streams.DataReader.fromBuffer(buf).readBytes(bytes);
        sendBinary(writer, bytes, relPath.split(/[\\/]/).pop());
        done();
        log("  → " + bytes.length + " bytes");
    }, function (e) {
        sendJson(writer, 500, { error: e && e.message ? e.message : "read error" });
        done();
    });
}

function handleWgsUpload(writer, relPath, bodyBytes, done) {
    var base     = wgsBase();
    var fullPath = base + "\\" + relPath.replace(/\//g, "\\");
    var dir      = fullPath.substring(0, fullPath.lastIndexOf("\\"));
    var fname    = fullPath.substring(fullPath.lastIndexOf("\\") + 1);
    log("WGS upload: " + fullPath + " (" + bodyBytes.length + " bytes)");

    function writeToFolder(folder) {
        folder.createFileAsync(fname, Windows.Storage.CreationCollisionOption.replaceExisting)
        .then(function (file) {
            var dw = new Windows.Storage.Streams.DataWriter();
            dw.writeBytes(bodyBytes);
            return Windows.Storage.FileIO.writeBufferAsync(file, dw.detachBuffer());
        }).then(function () {
            sendJson(writer, 200, { ok: true, bytes: bodyBytes.length, path: relPath });
            done();
        }, function (e) {
            sendJson(writer, 500, { error: e && e.message ? e.message : "write error" });
            done();
        });
    }

    Windows.Storage.StorageFolder.getFolderFromPathAsync(dir).then(function (f) {
        writeToFolder(f);
    }, function () {
        var parent = dir.substring(0, dir.lastIndexOf("\\"));
        var child  = dir.substring(dir.lastIndexOf("\\") + 1);
        Windows.Storage.StorageFolder.getFolderFromPathAsync(parent).then(function (pf) {
            return pf.createFolderAsync(child, Windows.Storage.CreationCollisionOption.openIfExists);
        }).then(function (f) {
            writeToFolder(f);
        }, function (e) {
            sendJson(writer, 500, { error: e && e.message ? e.message : "mkdir error" });
            done();
        });
    });
}

// ── Connected Storage (GameSaveProvider) handlers ───────────────────────────
// Dead Island DE SCID: db860100-d780-4e17-8685-ad130052ea64
var DI_SCID = "db860100-d780-4e17-8685-ad130052ea64";
var _csProvider = null;

function getOrOpenProvider(callback) {
    if (_csProvider) { callback(null, _csProvider); return; }

    // Timeout: GameSaveProvider hangs when Xbox Live is offline (0x80832003)
    var timedOut = false;
    var timer = setTimeout(function () {
        timedOut = true;
        callback("GameSaveProvider timed out — Xbox Live may be offline (check 0x80832003)");
    }, 8000);

    Windows.System.User.findAllAsync().then(function (users) {
        var user = users.size > 0 ? users.getAt(0) : null;
        if (!user) { if (!timedOut) { clearTimeout(timer); callback("No Xbox user found"); } return; }

        Windows.Gaming.XboxLive.Storage.GameSaveProvider.getForUserAsync(user, DI_SCID)
        .then(function (result) {
            if (timedOut) return;
            clearTimeout(timer);
            if (result.status === Windows.Gaming.XboxLive.Storage.GameSaveErrorStatus.ok) {
                _csProvider = result.value;
                callback(null, _csProvider);
            } else {
                callback("GameSaveProvider status: " + result.status);
            }
        }, function (e) {
            if (timedOut) return;
            clearTimeout(timer);
            callback(e && e.message ? e.message : String(e));
        });
    }, function (e) {
        if (timedOut) return;
        clearTimeout(timer);
        callback(e && e.message ? e.message : String(e));
    });
}

// GET /cs/list — list all containers + blobs via GameSaveProvider
function handleCsList(writer, done) {
    getOrOpenProvider(function (err, provider) {
        if (err) {
            sendJson(writer, 500, { error: err, scid: DI_SCID });
            done(); return;
        }
        var query = provider.createContainerInfoQuery();
        query.getContainerInfoAsync().then(function (result) {
            if (result.status !== Windows.Gaming.XboxLive.Storage.GameSaveErrorStatus.ok) {
                sendJson(writer, 500, { error: "getContainerInfo: " + result.status });
                done(); return;
            }
            var containers = [];
            result.value.forEach(function (c) {
                containers.push({ name: c.name, displayName: c.displayName, totalSize: c.totalSize });
            });
            sendJson(writer, 200, { scid: DI_SCID, containers: containers });
            done();
        }, function (e) { sendJson(writer, 500, { error: e.message }); done(); });
    });
}

// GET /cs/download?container=NAME&blob=BLOB — download blob via GameSaveProvider
function handleCsDownload(writer, containerName, blobName, done) {
    getOrOpenProvider(function (err, provider) {
        if (err) { sendJson(writer, 500, { error: err }); done(); return; }

        var container = provider.createContainer(containerName);
        var names = new Windows.Foundation.Collections.PropertySet();
        // Read names is a Windows.Foundation.Collections.IIterable<String>
        container.getAsync([blobName]).then(function (result) {
            if (result.status !== Windows.Gaming.XboxLive.Storage.GameSaveErrorStatus.ok) {
                sendJson(writer, 500, { error: "getAsync: " + result.status });
                done(); return;
            }
            var buf = result.value.lookup(blobName);
            if (!buf) { sendJson(writer, 404, { error: "blob not found" }); done(); return; }
            var bytes = new Uint8Array(buf.length);
            Windows.Storage.Streams.DataReader.fromBuffer(buf).readBytes(bytes);
            sendBinary(writer, bytes, blobName);
            done();
        }, function (e) { sendJson(writer, 500, { error: e.message }); done(); });
    });
}

// ── Browse / Dead Island helpers ─────────────────────────────────────────────

// GET /browse?path=Q:\Users\... — list a directory by absolute path
function handleBrowse(writer, abspath, done) {
    log("Browse: " + abspath);
    Windows.Storage.StorageFolder.getFolderFromPathAsync(abspath).then(function (folder) {
        var tasks = [folder.getFilesAsync(), folder.getFoldersAsync()];
        tasks[0].then(function (files) {
            tasks[1].then(function (dirs) {
                var result = {
                    path: abspath,
                    dirs:  dirs.map  ? dirs.map(function(d){return d.name;})  : toArray(dirs).map(function(d){return d.name;}),
                    files: files.map ? files.map(function(f){return f.name;}) : toArray(files).map(function(f){return f.name;})
                };
                sendJson(writer, 200, result);
                done();
            }, function(e){ sendJson(writer, 500, {error:e.message, step:"dirs"}); done(); });
        }, function(e){ sendJson(writer, 500, {error:e.message, step:"files"}); done(); });
    }, function(e){
        sendJson(writer, 404, {error:e.message||"not found", path:abspath});
        done();
    });
}

function toArray(winrtVector) {
    var a = [];
    if (!winrtVector) return a;
    for (var i = 0; i < winrtVector.size; i++) a.push(winrtVector.getAt(i));
    return a;
}

// Derive Dead Island DE packages folder from our own path
// Our path: Q:\Users\UserMgr2\AppData\Local\Packages\Adoptsomekids.SaveBridge_...\LocalState
// DI path:  Q:\Users\UserMgr2\AppData\Local\Packages\<DI_PFN>\SystemAppData\wgs
function diPackagesRoot() {
    var local = Windows.Storage.ApplicationData.current.localFolder.path;
    // Go up: LocalState → SaveBridge pkg → Packages
    return local.replace(/\\[^\\]+\\LocalState$/i, "");
}

// GET /di/list — enumerate all Packages to find Dead Island DE, then list wgs
function handleDiList(writer, done) {
    var pkgRoot = diPackagesRoot();
    log("Packages root: " + pkgRoot);

    Windows.Storage.StorageFolder.getFolderFromPathAsync(pkgRoot).then(function (pkgsFolder) {
        return pkgsFolder.getFoldersAsync();
    }).then(function (folders) {
        // Look for Dead Island (TitleId 5433956 = 0x0052EA64, or name contains "island"/"52ea64")
        var diFolder = null;
        var allNames = [];
        folders.forEach(function (f) {
            allNames.push(f.name);
            var n = f.name.toLowerCase();
            if (n.indexOf("island") >= 0 || n.indexOf("52ea64") >= 0 ||
                n.indexOf("5433956") >= 0 || n.indexOf("deadisland") >= 0 ||
                n.indexOf("dead_island") >= 0) {
                diFolder = f;
            }
        });

        if (!diFolder) {
            sendJson(writer, 200, {
                found: false,
                packagesRoot: pkgRoot,
                hint: "Dead Island DE package not found — listing all packages",
                allPackages: allNames
            });
            done();
            return;
        }

        // Found — enumerate wgs
        var wgsPath = diFolder.path + "\\SystemAppData\\wgs";
        log("DI wgs path: " + wgsPath);

        var result = { found: true, packageFolder: diFolder.name, wgsPath: wgsPath, users: [] };
        Windows.Storage.StorageFolder.getFolderFromPathAsync(wgsPath).then(function (wgsFolder) {
            return wgsFolder.getFoldersAsync();
        }).then(function (userFolders) {
            var pending = userFolders.size;
            if (pending === 0) { sendJson(writer, 200, result); done(); return; }
            userFolders.forEach(function (uf) {
                var userObj = { xuid: uf.name, files: [], containers: [] };
                result.users.push(userObj);
                uf.getFilesAsync().then(function (files) {
                    files.forEach(function (f) { userObj.files.push(f.name); });
                    return uf.getFoldersAsync();
                }).then(function (conFolders) {
                    var cpending = conFolders.size;
                    if (cpending === 0) { if (--pending === 0) { sendJson(writer, 200, result); done(); } return; }
                    conFolders.forEach(function (cf) {
                        var cObj = { guid: cf.name, blobs: [] };
                        userObj.containers.push(cObj);
                        cf.getFilesAsync().then(function (blobs) {
                            blobs.forEach(function (b) { cObj.blobs.push(b.name); });
                        }).then(null, function(){}).then(function () {
                            if (--cpending === 0 && --pending === 0) { sendJson(writer, 200, result); done(); }
                        });
                    });
                }, function () { if (--pending === 0) { sendJson(writer, 200, result); done(); } });
            });
        }, function (e) {
            result.wgsError = e && e.message ? e.message : "wgs not found";
            sendJson(writer, 200, result);
            done();
        });
    }, function (e) {
        sendJson(writer, 500, { error: e && e.message ? e.message : "packages not found", pkgRoot: pkgRoot });
        done();
    });
}

// GET /di/download?path=REL — download file relative to DI wgs folder
function handleDiDownload(writer, relPath, done) {
    var pkgRoot = diPackagesRoot();
    log("DI download: " + relPath);

    Windows.Storage.StorageFolder.getFolderFromPathAsync(pkgRoot).then(function (pkgsFolder) {
        return pkgsFolder.getFoldersAsync();
    }).then(function (folders) {
        var diFolder = null;
        folders.forEach(function (f) {
            var n = f.name.toLowerCase();
            if (n.indexOf("island") >= 0 || n.indexOf("52ea64") >= 0) diFolder = f;
        });
        if (!diFolder) { sendJson(writer, 404, {error:"Dead Island package not found"}); done(); return; }

        var fullPath = diFolder.path + "\\SystemAppData\\wgs\\" + relPath.replace(/\//g, "\\");
        Windows.Storage.StorageFile.getFileFromPathAsync(fullPath).then(function (file) {
            return Windows.Storage.FileIO.readBufferAsync(file);
        }).then(function (buf) {
            var bytes = new Uint8Array(buf.length);
            Windows.Storage.Streams.DataReader.fromBuffer(buf).readBytes(bytes);
            sendBinary(writer, bytes, relPath.split(/[\\/]/).pop());
            done();
        }, function (e) { sendJson(writer, 500, {error:e.message}); done(); });
    }, function (e) { sendJson(writer, 500, {error:e.message}); done(); });
}

// ── /di/wgs — direct filesystem read of DI WGS using known PFN ───────────────
// Dead Island DE PFN: DeepSilver.DeadIslandDefinitiveEdition_hmv7qcest37me
// Try C:\, D:\, Q:\ — retail game lives on C:\ or D:\
var DI_PFN = "DeepSilver.DeadIslandDefinitiveEdition_hmv7qcest37me";
var DI_PARTITION_CANDIDATES = ["C", "D", "E", "Q"];

function findDiWgsFolder(callback) {
    var tried = 0;
    var found = false;
    DI_PARTITION_CANDIDATES.forEach(function (drive) {
        var wgsPath = drive + ":\\Users\\UserMgr2\\AppData\\Local\\Packages\\" + DI_PFN + "\\SystemAppData\\wgs";
        Windows.Storage.StorageFolder.getFolderFromPathAsync(wgsPath).then(function (folder) {
            if (!found) {
                found = true;
                callback(null, folder, wgsPath);
            }
        }, function () {
            tried++;
            if (tried === DI_PARTITION_CANDIDATES.length && !found) {
                // Also try without UserMgr2 (DefaultAccount)
                var tried2 = 0;
                var users = ["UserMgr2", "DefaultAccount", "DefaultUser0"];
                DI_PARTITION_CANDIDATES.forEach(function (drive2) {
                    users.forEach(function (u) {
                        var p = drive2 + ":\\Users\\" + u + "\\AppData\\Local\\Packages\\" + DI_PFN + "\\SystemAppData\\wgs";
                        Windows.Storage.StorageFolder.getFolderFromPathAsync(p).then(function (folder) {
                            if (!found) { found = true; callback(null, folder, p); }
                        }, function () {
                            tried2++;
                            if (tried2 === DI_PARTITION_CANDIDATES.length * users.length && !found) {
                                callback("DI WGS not found on any partition. PFN=" + DI_PFN);
                            }
                        });
                    });
                });
            }
        });
    });
}

// GET /di/wgs — list containers in DI WGS folder
function handleDiWgs(writer, done) {
    log("DI WGS: searching for " + DI_PFN);
    findDiWgsFolder(function (err, wgsFolder, wgsPath) {
        if (err) {
            sendJson(writer, 404, { error: err, pfn: DI_PFN, tried: DI_PARTITION_CANDIDATES });
            done(); return;
        }
        log("DI WGS found: " + wgsPath);
        var result = { wgsPath: wgsPath, users: [] };
        wgsFolder.getFoldersAsync().then(function (userFolders) {
            var pending = userFolders.size;
            if (pending === 0) { sendJson(writer, 200, result); done(); return; }
            toArray(userFolders).forEach(function (uf) {
                var userObj = { xuid: uf.name, containers: [] };
                result.users.push(userObj);
                uf.getFoldersAsync().then(function (conFolders) {
                    var cp = conFolders.size;
                    if (cp === 0) { if (--pending === 0) { sendJson(writer, 200, result); done(); } return; }
                    toArray(conFolders).forEach(function (cf) {
                        var cObj = { guid: cf.name, blobs: [] };
                        userObj.containers.push(cObj);
                        cf.getFilesAsync().then(function (blobs) {
                            toArray(blobs).forEach(function (b) { cObj.blobs.push(b.name); });
                            if (--cp === 0 && --pending === 0) { sendJson(writer, 200, result); done(); }
                        }, function () { if (--cp === 0 && --pending === 0) { sendJson(writer, 200, result); done(); } });
                    });
                }, function () { if (--pending === 0) { sendJson(writer, 200, result); done(); } });
            });
        }, function (e) {
            sendJson(writer, 500, { error: e && e.message ? e.message : "getFolders failed", wgsPath: wgsPath });
            done();
        });
    });
}

// GET /di/wgs/download?path=XUID\CONTAINER_GUID\BLOB_FILE
function handleDiWgsDownload(writer, relPath, done) {
    log("DI WGS download: " + relPath);
    findDiWgsFolder(function (err, wgsFolder, wgsPath) {
        if (err) { sendJson(writer, 404, { error: err }); done(); return; }
        var fullPath = wgsPath + "\\" + relPath.replace(/\//g, "\\");
        Windows.Storage.StorageFile.getFileFromPathAsync(fullPath).then(function (file) {
            return Windows.Storage.FileIO.readBufferAsync(file);
        }).then(function (buf) {
            var bytes = new Uint8Array(buf.length);
            Windows.Storage.Streams.DataReader.fromBuffer(buf).readBytes(bytes);
            sendBinary(writer, bytes, relPath.split(/[\\/]/).pop());
            done();
        }, function (e) { sendJson(writer, 500, { error: e && e.message ? e.message : "read error", path: fullPath }); done(); });
    });
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
