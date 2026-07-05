# xbox-savebridge

A sideloaded **packaged Win32** app for Xbox Series X that exposes Dead Island Definitive Edition Connected Storage saves over the local network via HTTP.

> **Architecture**: `Windows.FullTrustApplication` + `runFullTrust` + `connectedStorageAccess`  
> The app runs as a self-contained .NET 6 process (no external runtime dependencies) and hosts an HTTP server on port **8765**.

---

## How It Works

1. Install the signed APPX sideload on your Xbox Series X via [Windows Device Portal](https://docs.microsoft.com/windows/uwp/debug-test-perf/device-portal-xbox) (port 11443).
2. Launch **SaveBridge** from *My games & apps → Apps*.
3. From your Mac/PC on the same LAN, use [`save-sync.ts`](../dead-island-definitive-save-editor/tools/save-sync.ts) to pull/push saves.

```
GET  http://<XBOX_IP>:8765/status
GET  http://<XBOX_IP>:8765/save/list
GET  http://<XBOX_IP>:8765/save/download?container=NAME&blob=BLOBNAME
POST http://<XBOX_IP>:8765/save/upload?container=NAME&blob=BLOBNAME   (body = raw bytes)
```

---

## Build

Builds run automatically on GitHub Actions (`.github/workflows/build.yml`) on every push to `main`.  
Download the signed APPX bundle + `SaveBridge-DevCert.cer` from the **Actions → SaveBridge-APPX** artifact.

### Local build (Windows only)

```powershell
dotnet restore SaveBridge\SaveBridge\SaveBridge.csproj -r win10-x64
msbuild SaveBridge\SaveBridge\SaveBridge.csproj `
  /p:Configuration=Release /p:Platform=x64 `
  /p:RuntimeIdentifier=win10-x64 /p:SelfContained=true `
  /p:AppxBundle=Always /p:UapAppxPackageBuildMode=SideloadOnly
```

---

## Deploy to Xbox

### 1. Enable Developer Mode on Xbox
- **Settings → System → Console info** — note your Xbox IP address.
- **Settings → Developer Settings → Developer Mode** → Enable.
- Open Device Portal: `https://<XBOX_IP>:11443` (accept the self-signed cert).

### 2. Install the developer certificate
Before installing the APPX, install `SaveBridge-DevCert.cer` via Device Portal:  
`Home → Security → Device Security → Install certificate`  
OR via Settings on the Xbox itself (navigate to the `.cer` file on a USB drive).

### 3. Upload & install the APPX
In Device Portal → **Apps** → **Install app**, upload the `.appxbundle` file.

### 4. Launch
Go to **My games & apps → Apps** and launch **SaveBridge**.  
The app starts the HTTP server on port 8765 and keeps running in the background.

---

## Dead Island DE — Identifiers

| Field | Value |
|-------|-------|
| Title ID | `5433956` (0x0052EA64) |
| SCID | `db860100-d780-4e17-8685-ad130052ea64` |
| Sandbox | `RETAIL` |

---

## Alternative: Xbox Live Connected Storage REST API

Microsoft's official `ConnectedStorage` class (from [xbox-live-developer-tools](https://github.com/microsoft/xbox-live-developer-tools)) shows the REST endpoints:

```
GET  https://titlestorage.xboxlive.com/connectedstorage/users/gt({gamertag})/scids/{scid}/{path}
GET  https://titlestorage.xboxlive.com/connectedstorage/users/gt({gamertag})/scids/{scid}/{path},binary
```

Authentication requires an **XSTS token** obtained by:
1. MSA login → XASU token (`https://user.auth.xboxlive.com/user/authenticate`)
2. XASU → XSTS token (`https://xsts.auth.xboxlive.com/xsts/authorize`, `RelyingParty=http://xboxlive.com`)
3. Add header: `Authorization: XBL3.0 x={userHash};{xstsToken}`

This REST path works from any machine (no Xbox sideloading needed) but requires the Xbox account's Microsoft credentials. The SaveBridge approach is simpler for personal use.

---

## Project Status

| Step | Status |
|------|--------|
| APPX builds on GitHub Actions | ✅ |
| Self-contained .NET 6, no framework deps | ✅ |
| `Windows.FullTrustApplication` + `runFullTrust` | ✅ |
| Deploy & test on Xbox | ⏳ |
| Pull Dead Island DE saves | ⏳ |

---

*Part of the [dead-island-definitive-save-editor](https://github.com/Adoptsomekids/dead-island-definitive-save-editor) project.*
