/// SaveBridge JS UWP — StreamSocketListener HTTP bridge, port 8765
/// Uses only native WinRT async (no WinJS dependency)
/// v23: broadFileSystemAccess + UserDataPaths for DI WGS; /di/userdata endpoint
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
    log("SaveBridge v23-js loaded. Auto-starting...");
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
                log("SaveBridge v23 listening on port " + PORT + "  ✓");
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
        sendJson(writer, 200, {status:"ok", port:PORT, build:"v23-js"});
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
        handleDiWgs(writer, done);
    } else if (path === "/di/wgs/download" && method === "GET") {
        var wgsPath = query["path"] || "";
        if (!wgsPath) { sendJson(writer, 400, {error:"path required"}); done(); }
        else { handleDiWgsDownload(writer, wgsPath, done); }
    } else if (path === "/wdp/cs/list" && method === "GET") {
        // Proxy WDP /ext/xblgamesave/containers — WDP runs privileged, can reach retail saves
        handleWdpCsList(writer, done);
    } else if (path === "/wdp/cs/download" && method === "GET") {
        var wdpContainer = query["container"] || "";
        var wdpBlob      = query["blob"] || "";
        if (!wdpContainer || !wdpBlob) { sendJson(writer, 400, {error:"container+blob required"}); done(); }
        else { handleWdpCsDownload(writer, wdpContainer, wdpBlob, done); }
    } else if (path === "/exec" && method === "POST") {
        // Execute a command via WScript/Shell — requires broadFileSystemAccess
        var execCmd = query["cmd"] || "";
        if (!execCmd) { sendJson(writer, 400, {error:"cmd required"}); done(); }
        else { handleExec(writer, decodeURIComponent(execCmd), done); }
    } else if (path === "/di/userdata" && method === "GET") {
        // Use UserDataPaths to find the real LocalAppData for the current user
        handleDiUserData(writer, done);
    } else if (path === "/di/userdata/download" && method === "GET") {
        var udPath = query["path"] || "";
        if (!udPath) { sendJson(writer, 400, {error:"path required"}); done(); }
        else { handleDiUserDataDownload(writer, udPath, done); }
    } else if (path === "/cs/diag" && method === "GET") {
        // Quick user/sandbox diagnostic — no GameSaveProvider call, returns immediately
        handleCsDiag(writer, done);
    } else if (path === "/probe" && method === "GET") {
        // Connectivity probe: /probe?host=127.0.0.1&port=11443
        var probeHost = query["host"] || "127.0.0.1";
        var probePort = query["port"] || "11443";
        handleProbe(writer, probeHost, probePort, done);
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

// GET /cs/diag — returns user enumeration info immediately (no GameSaveProvider)
function handleCsDiag(writer, done) {
    Windows.System.User.findAllAsync().then(function (users) {
        var userList = [];
        for (var i = 0; i < users.size; i++) {
            var u = users.getAt(i);
            userList.push({
                index: i,
                type: u.type,
                authenticationStatus: u.authenticationStatus,
                nonRoamableId: (function(){ try { return u.nonRoamableId; } catch(e){ return null; } })()
            });
        }
        sendJson(writer, 200, {
            build: "v22-js",
            scid: DI_SCID,
            userCount: users.size,
            users: userList,
            note: "type 1=LocalUser 2=RemoteUser(XBL) 3=LocalGuest 4=RemoteGuest; authStatus 0=Unauthenticated 1=LocallyAuthenticated 2=RemotelyAuthenticated"
        });
        done();
    }, function (e) {
        sendJson(writer, 500, { error: e && e.message ? e.message : String(e) });
        done();
    });
}

// GameSaveProvider — both APIs require an active Xbox Live token even in Dev Mode.
// We wrap both calls with a shared timeout so /cs/list never hangs.
// On 0x80832003 (Dev Mode sandbox can't auth as retail user), we return a clear
// diagnostic so the caller can try the WDP /ext/xblgamesave path instead.
function getOrOpenProvider(callback) {
    if (_csProvider) { callback(null, _csProvider); return; }

    var called = false;
    function once(err, val) {
        if (called) return;
        called = true;
        clearTimeout(masterTimer);
        callback(err, val);
    }

    // 30-second master timeout — RETAIL sandbox needs time to authenticate with Xbox Live servers
    var masterTimer = setTimeout(function () {
        once("GameSaveProvider timed out (30s) — Xbox Live auth is taking too long or unavailable");
    }, 30000);

    // Enumerate all users and log them for diagnostics
    Windows.System.User.findAllAsync().then(function (users) {
        var allUsers = [];
        for (var i = 0; i < users.size; i++) {
            var u = users.getAt(i);
            allUsers.push({ type: u.type, authStatus: u.authenticationStatus });
        }
        log("findAllAsync: " + users.size + " user(s): " + JSON.stringify(allUsers));

        // Pick the first authenticated (Xbox Live) user, fall back to first user
        var user = null;
        for (var j = 0; j < users.size; j++) {
            var candidate = users.getAt(j);
            // type 1 = LocalUser, type 4 = RemoteUser (Xbox Live)
            if (candidate.type === 4 || candidate.authenticationStatus === 1) {
                user = candidate; break;
            }
        }
        if (!user && users.size > 0) user = users.getAt(0);
        if (!user) { once("No Xbox user found"); return; }
        log("Using user type=" + user.type + " authStatus=" + user.authenticationStatus);

        var GSP      = Windows.Gaming.XboxLive.Storage.GameSaveProvider;
        var StatusOk = Windows.Gaming.XboxLive.Storage.GameSaveErrorStatus.ok;

        // Try SyncOnDemand first, then getForUserAsync
        GSP.getSyncOnDemandForUserAsync(user, DI_SCID).then(function (result) {
            log("SyncOnDemand result status: " + result.status);
            if (result.status === StatusOk) {
                _csProvider = result.value;
                once(null, _csProvider);
            } else {
                log("SyncOnDemand status " + result.status + " — trying getForUserAsync");
                GSP.getForUserAsync(user, DI_SCID).then(function (r2) {
                    log("getForUserAsync result status: " + r2.status);
                    if (r2.status === StatusOk) {
                        _csProvider = r2.value;
                        once(null, _csProvider);
                    } else {
                        once("GameSaveProvider both failed — SyncOnDemand:" + result.status + " getForUser:" + r2.status);
                    }
                }, function (e2) { once("getForUserAsync threw: " + (e2 && e2.message ? e2.message : String(e2))); });
            }
        }, function (e) {
            log("SyncOnDemand threw: " + (e && e.message ? e.message : String(e)));
            GSP.getForUserAsync(user, DI_SCID).then(function (r2) {
                log("getForUserAsync result status: " + r2.status);
                if (r2.status === StatusOk) {
                    _csProvider = r2.value;
                    once(null, _csProvider);
                } else {
                    once("getForUserAsync status: " + r2.status);
                }
            }, function (e2) { once("getForUserAsync threw: " + (e2 && e2.message ? e2.message : String(e2))); });
        });

    }, function (e) { once("findAllAsync threw: " + (e && e.message ? e.message : String(e))); });
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

// ── /di/userdata — UserDataPaths-based DI WGS access ────────────────────────
// Uses Windows.Storage.UserDataPaths.GetDefault().localAppData to find the
// actual user's LocalAppData, then navigates to DI's WGS folder from there.
// broadFileSystemAccess capability required.

var DI_PFN_FULL = "DeepSilver.DeadIslandDefinitiveEdition_hmv7qcest37me";

function handleDiUserData(writer, done) {
    // Method 1: UserDataPaths (gets the currently signed-in user's LocalAppData)
    var localAppData;
    try {
        localAppData = Windows.Storage.UserDataPaths.getDefault().localAppData;
    } catch (e) {
        localAppData = null;
        log("UserDataPaths.getDefault() error: " + (e && e.message ? e.message : String(e)));
    }

    // Method 2: our own app path → up to Packages → sibling DI package
    var ownLocalState = Windows.Storage.ApplicationData.current.localFolder.path;
    var packagesPath  = ownLocalState.replace(/\\[^\\]+\\LocalState$/i, "");
    var diWgsFromOwn  = packagesPath + "\\" + DI_PFN_FULL + "\\SystemAppData\\wgs";

    var diWgsFromUDP  = localAppData
        ? localAppData + "\\Packages\\" + DI_PFN_FULL + "\\SystemAppData\\wgs"
        : null;

    log("UserDataPaths.localAppData: " + (localAppData || "(unavailable)"));
    log("Own packages path: " + packagesPath);
    log("DI WGS (UDP):  " + diWgsFromUDP);
    log("DI WGS (own):  " + diWgsFromOwn);

    var results = {
        userDataPathsLocalAppData: localAppData || null,
        ownLocalState: ownLocalState,
        packagesPath: packagesPath,
        diPfn: DI_PFN_FULL,
        diWgsPaths: {},
        wgsContents: null
    };

    // Try to open the DI WGS folder using each candidate path
    var candidates = [];
    if (diWgsFromUDP) candidates.push({ label: "UDP", path: diWgsFromUDP });
    candidates.push({ label: "own", path: diWgsFromOwn });

    // Also try broadFileSystemAccess to navigate DI's own LocalAppData
    var diLocalAppData = localAppData
        ? localAppData + "\\Packages\\" + DI_PFN_FULL + "\\LocalState"
        : null;
    if (diLocalAppData) candidates.push({ label: "diLocalState", path: diLocalAppData });

    var remaining = candidates.length;
    var found = false;

    function tryCandidate(c) {
        Windows.Storage.StorageFolder.getFolderFromPathAsync(c.path).then(function (folder) {
            results.diWgsPaths[c.label] = { path: c.path, accessible: true };
            if (!found) {
                found = true;
                // Enumerate its contents
                folder.getFoldersAsync().then(function (subFolders) {
                    results.wgsContents = { path: c.path, label: c.label, subFolders: [] };
                    toArray(subFolders).forEach(function(sf) {
                        results.wgsContents.subFolders.push(sf.name);
                    });
                    if (--remaining === 0) { sendJson(writer, 200, results); done(); }
                }, function() { if (--remaining === 0) { sendJson(writer, 200, results); done(); } });
            } else {
                if (--remaining === 0) { sendJson(writer, 200, results); done(); }
            }
        }, function (e) {
            results.diWgsPaths[c.label] = { path: c.path, accessible: false, error: e && e.message ? e.message : String(e) };
            if (--remaining === 0) { sendJson(writer, 200, results); done(); }
        });
    }

    candidates.forEach(tryCandidate);
}

function handleDiUserDataDownload(writer, relPath, done) {
    // relPath is relative to the accessible DI WGS path
    var localAppData;
    try { localAppData = Windows.Storage.UserDataPaths.getDefault().localAppData; } catch(e) { localAppData = null; }
    var packagesPath = Windows.Storage.ApplicationData.current.localFolder.path
                        .replace(/\\[^\\]+\\LocalState$/i, "");

    var paths = [];
    if (localAppData) paths.push(localAppData + "\\Packages\\" + DI_PFN_FULL + "\\SystemAppData\\wgs\\" + relPath.replace(/\//g,"\\"));
    paths.push(packagesPath + "\\" + DI_PFN_FULL + "\\SystemAppData\\wgs\\" + relPath.replace(/\//g,"\\"));

    var tried = 0;
    function tryPath(p) {
        Windows.Storage.StorageFile.getFileFromPathAsync(p).then(function(file) {
            return Windows.Storage.FileIO.readBufferAsync(file);
        }).then(function(buf) {
            var bytes = new Uint8Array(buf.length);
            Windows.Storage.Streams.DataReader.fromBuffer(buf).readBytes(bytes);
            sendBinary(writer, bytes, relPath.split(/[\\/]/).pop()); done();
        }, function(e) {
            tried++;
            if (tried < paths.length) { tryPath(paths[tried]); return; }
            sendJson(writer, 500, { error: e && e.message ? e.message : String(e), tried: paths }); done();
        });
    }
    tryPath(paths[0]);
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

// ── Connectivity probe ────────────────────────────────────────────────────────
// GET /probe?host=127.0.0.1&port=11443
// Tests whether this UWP can make outbound TCP connections to the given endpoint.
function handleProbe(writer, host, port, done) {
    log("Probe: connecting to " + host + ":" + port);
    var socket = new Windows.Networking.Sockets.StreamSocket();
    var hostname = new Windows.Networking.HostName(host);
    var timer = setTimeout(function () {
        try { socket.close(); } catch(e) {}
        sendJson(writer, 200, { host: host, port: port, reachable: false, error: "timeout (5s)" });
        done();
    }, 5000);

    socket.connectAsync(hostname, String(port)).then(function () {
        clearTimeout(timer);
        try { socket.close(); } catch(e) {}
        sendJson(writer, 200, { host: host, port: port, reachable: true });
        done();
    }, function (e) {
        clearTimeout(timer);
        try { socket.close(); } catch(e2) {}
        sendJson(writer, 200, { host: host, port: port, reachable: false, error: e && e.message ? e.message : String(e) });
        done();
    });
}

// ── WDP proxy handlers — /wdp/cs/list and /wdp/cs/download ──────────────────
// WDP (Windows Device Portal) runs as a privileged OS service on port 11443.
// Its /ext/xblgamesave endpoint can access retail game saves across partitions.
// We call it via XMLHttpRequest from within the UWP (same machine = localhost).
// WDP uses HTTPS with self-signed cert; we use the HTTP port 11080 if available,
// or bypass SSL errors via the WinRT HttpClient with NoCredentialProtection.

// WDP has HTTP on 11080 (no auth needed in guest mode) and HTTPS on 11443.
// Try HTTP first (no SSL to bypass), fall back to HTTPS with cert ignore.
var WDP_HOSTS   = ["http://localhost:11080", "https://localhost:11443"];
var DI_SCID_WDP = "db860100-d780-4e17-8685-ad130052ea64";

function makeWdpClient() {
    var filters = new Windows.Web.Http.Filters.HttpBaseProtocolFilter();
    try {
        filters.ignorableServerCertificateErrors.append(
            Windows.Security.Cryptography.Certificates.ChainValidationResult.untrusted);
        filters.ignorableServerCertificateErrors.append(
            Windows.Security.Cryptography.Certificates.ChainValidationResult.invalidName);
        filters.ignorableServerCertificateErrors.append(
            Windows.Security.Cryptography.Certificates.ChainValidationResult.expired);
    } catch(e) { /* cert ignore not available — proceed anyway */ }
    return new Windows.Web.Http.HttpClient(filters);
}

function wdpGetOnHost(host, urlPath, callback) {
    var client = makeWdpClient();
    var uri = new Windows.Foundation.Uri(host + urlPath);
    client.getStringAsync(uri).then(function (body) {
        callback(null, body);
    }, function (e) {
        callback(e && e.message ? e.message : String(e));
    });
}

function wdpGet(urlPath, callback) {
    // Try HTTP:11080 first, fall back to HTTPS:11443
    wdpGetOnHost(WDP_HOSTS[0], urlPath, function (err, body) {
        if (!err) { callback(null, body); return; }
        log("WDP HTTP:11080 failed: " + err + " — trying HTTPS:11443");
        wdpGetOnHost(WDP_HOSTS[1], urlPath, callback);
    });
}

// GET /wdp/cs/list — proxy WDP /ext/xblgamesave/containers for DI SCID
function handleWdpCsList(writer, done) {
    log("WDP CS list — calling " + WDP_HOSTS[0] + "/ext/xblgamesave/containers");

    // First try type=1 (ConnectedStorage), then type=0 (XblGameSave)
    var triedTypes = [];
    var results = {};

    function tryType(t, next) {
        var path = "/ext/xblgamesave/containers?scid=" + DI_SCID_WDP + "&type=" + t;
        wdpGet(path, function (err, body) {
            if (err) {
                results["type" + t] = { error: err };
            } else {
                try { results["type" + t] = JSON.parse(body); }
                catch (pe) { results["type" + t] = { raw: body.slice(0, 500) }; }
            }
            next();
        });
    }

    tryType(0, function () {
        tryType(1, function () {
            // Also probe without type param
            wdpGet("/ext/xblgamesave/containers?scid=" + DI_SCID_WDP, function (err, body) {
                var noType = err ? { error: err } : (function () { try { return JSON.parse(body); } catch(e) { return {raw:body.slice(0,500)}; } })();
                sendJson(writer, 200, {
                    wdpHost: WDP_HOST,
                    scid: DI_SCID_WDP,
                    type0: results["type0"],
                    type1: results["type1"],
                    noType: noType
                });
                done();
            });
        });
    });
}

// GET /wdp/cs/download?container=NAME&blob=BLOB — proxy WDP blob download
function handleWdpCsDownload(writer, containerName, blobName, done) {
    var urlPath = "/ext/xblgamesave/blobs?scid=" + DI_SCID_WDP +
                  "&containerName=" + encodeURIComponent(containerName) +
                  "&blobName=" + encodeURIComponent(blobName);
    log("WDP CS download: " + urlPath);

    function tryGetBuffer(host, cb) {
        var client = makeWdpClient();
        var uri = new Windows.Foundation.Uri(host + urlPath);
        client.getBufferAsync(uri).then(function (buf) {
            cb(null, buf);
        }, function (e) { cb(e && e.message ? e.message : String(e)); });
    }

    tryGetBuffer(WDP_HOSTS[0], function (err, buf) {
        if (err) {
            log("WDP buffer HTTP:11080 failed: " + err + " — trying HTTPS:11443");
            tryGetBuffer(WDP_HOSTS[1], function (err2, buf2) {
                if (err2) { sendJson(writer, 500, { error: err2, path: urlPath }); done(); return; }
                var bytes = new Uint8Array(buf2.length);
                Windows.Storage.Streams.DataReader.fromBuffer(buf2).readBytes(bytes);
                sendBinary(writer, bytes, blobName); done();
            });
            return;
        }
        var bytes = new Uint8Array(buf.length);
        Windows.Storage.Streams.DataReader.fromBuffer(buf).readBytes(bytes);
        sendBinary(writer, bytes, blobName); done();
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
