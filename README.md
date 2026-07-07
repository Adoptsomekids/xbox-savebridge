# xbox-savebridge

> A sideloaded UWP/Win32 app for **Xbox Series X** that bridges Dead Island DE  
> Connected Storage saves to a local HTTP API on your LAN.

**⚠️ NOTE: SaveBridge is the LEGACY approach. The preferred method is now `--cs-pull` / `--cs-push` in [dead-island-definitive-save-editor](https://github.com/Adoptsomekids/dead-island-definitive-save-editor), which uses the Xbox Live REST API directly and requires NO Xbox sideloading.**

---

## What Is SaveBridge?

SaveBridge is a Win32 app packaged as an APPX/MSIX that runs on Xbox Series X in Developer Mode. It hosts an HTTP server on port **8765** that exposes Dead Island DE's Connected Storage blobs over the local network.

It was the original method for extracting saves before the direct Xbox Live REST API approach was implemented.

### Architecture

```
Xbox Series X (Dev Mode)
  └── SaveBridge.exe  (UWP Win32 FullTrust, port 8765)
          │
          │  HTTP over LAN
          ▼
  save-sync.ts --bridge / --cs-download
```

---

## Current Status

| Feature | Status |
|---------|--------|
| APPX builds on GitHub Actions | ✅ |
| Install & launch on Xbox Series X | ✅ |
| `/status` endpoint | ✅ |
| `/cs/list` — list Connected Storage blobs | ✅ |
| `/cs/atom-file` — download atom by GUID | ✅ |
| `/cs/atom-http` — download atom via HTTPS proxy | ✅ |
| Direct Xbox Live REST API (no Xbox needed) | ✅ **Preferred method** |

---

## Preferred Alternative (No Dev Mode Needed)

You **do NOT need SaveBridge** if you use the direct Xbox Live API:

```bash
cd dead-island-definitive-save-editor

# One-time login (uses your Xbox/Microsoft account)
npx ts-node tools/save-sync.ts --login
npx ts-node tools/save-sync.ts --login-legacy

# Download saves directly from Xbox Live
npx ts-node tools/save-sync.ts --cs-pull --out ./saves --full

# Push edited save back
npx ts-node tools/save-sync.ts --cs-push --input saves/save_1.sav_dec_edited.bin
```

This works from **any OS** (macOS, Linux, Windows) with **no Xbox Dev Mode** and **no app installation**.

---

## SaveBridge Setup (Dev Mode Required)

If you still want to use SaveBridge (e.g., for testing or offline use):

### Step 1 — Enable Developer Mode on Xbox

1. Xbox **Settings → System → Developer settings → Developer Mode**
2. Follow prompts — Xbox will install the Dev Mode activation app
3. Note your Xbox IP: **Settings → General → Network → Advanced settings**
4. Open Device Portal: `https://<XBOX_IP>:11443` (accept the self-signed certificate)
5. Set a username + password in Device Portal

### Step 2 — Install the Certificate

Before installing SaveBridge, install the signing certificate:

1. In Device Portal → **Home → Security → Install certificate**
2. Upload `SaveBridge-DevCert.cer` from the `dist/` folder
3. OR put the `.cer` file on a USB drive and install it via Settings on the Xbox

### Step 3 — Install SaveBridge

1. In Device Portal → **Apps → Install app**
2. Select `SaveBridge_1.0.0.0_ARM64.msixbundle` from `dist/`
3. Click **Install**

### Step 4 — Launch SaveBridge

1. On Xbox: **My games & apps → Apps → SaveBridge**
2. Launch it — the screen will show the IP address and port (8765)
3. The HTTP server starts automatically and runs in the background

### Step 5 — Use from Mac/PC

```bash
# Check SaveBridge is running
curl http://192.168.100.27:8765/status

# List Connected Storage blobs
npx ts-node tools/save-sync.ts --bridge --xbox-ip 192.168.100.27

# Download saves via SaveBridge
npx ts-node tools/save-sync.ts --cs-download --xbox-ip 192.168.100.27 --out ./saves
```

---

## HTTP API Endpoints (port 8765)

```
GET  /status
     → { version: "27", xbox: true, ip: "192.168.100.27" }

GET  /cs/list
GET  /cs/list?scid=db860100-d780-4e17-8685-ad130052ea64
     → [{ blobName, size, ... }]

GET  /cs/atom-file?scid=...&atom=<GUID>&size=<N>
     → binary atom data (gzip-compressed save)

GET  /cs/atom-http?scid=...&atom=<GUID>&size=<N>
     → downloads atom via HTTPS proxy from titlestorage.xboxlive.com
```

---

## Dead Island DE Identifiers

| Field | Value |
|-------|-------|
| Title ID | `5433956` (0x0052EA64) |
| SCID | `db860100-d780-4e17-8685-ad130052ea64` |
| PFN | `DeepSilver.DeadIslandDefinitiveEdition_hmv7qcest37me` |
| Sandbox | `RETAIL` |
| SaveBridge port | `8765` |

---

## Build

Builds run automatically on GitHub Actions on every push to `main`.

### Download pre-built APPX

Check the `dist/` folder for:
- `SaveBridge_1.0.0.0_ARM64.msixbundle` — install on Xbox Series X
- `SaveBridge-DevCert.cer` — signing certificate

### Local Build (Windows only)

```powershell
# Requires Visual Studio + Windows SDK
cd SaveBridgeJS
npm install
npm run build  # bundles JS
# Then package with makeappx / signtool
```

---

## Do I Need Dev Mode?

**For save editing: NO.**

The `--cs-pull` / `--cs-push` commands in `dead-island-definitive-save-editor` use Microsoft's official Xbox Live Connected Storage REST API and work with any Xbox account from any machine — no Dev Mode, no Xbox app running, nothing special.

**You only need Dev Mode + SaveBridge if:**
- You want to access saves offline (no internet)
- You want to explore raw Connected Storage internals
- You want to experiment with the Xbox device APIs

---

*Part of the [dead-island-definitive-save-editor](https://github.com/Adoptsomekids/dead-island-definitive-save-editor) project.*
