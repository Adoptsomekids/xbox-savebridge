# Device Portal Deployment Guide

Step-by-step instructions for deploying SaveBridge to your Xbox Series X from macOS.

## Prerequisites

- Xbox Series X with Developer Mode active
- SaveBridge `.appxbundle` downloaded from [Releases](https://github.com/Adoptsomekids/xbox-savebridge/releases)
  or from the [GitHub Actions artifacts](https://github.com/Adoptsomekids/xbox-savebridge/actions)
- Your Xbox IP address (Settings → General → Network settings → Advanced settings)
- Device Portal credentials (set during Developer Mode activation)

## Deploy from macOS (curl)

```bash
XBOX_IP=192.168.X.X
WDP_USER=DevToolsUser
WDP_PASS=your-device-portal-password
APPX=SaveBridge.appxbundle

# Upload and install
curl -k \
  -u "${WDP_USER}:${WDP_PASS}" \
  -X POST "https://${XBOX_IP}:11443/api/app/packagemanager/package" \
  -F "file=@${APPX}"

# Verify installation
curl -sk \
  -u "${WDP_USER}:${WDP_PASS}" \
  "https://${XBOX_IP}:11443/api/app/packagemanager/packages" \
  | python3 -c "import sys,json; pkgs=json.load(sys.stdin).get('InstalledPackages',[]); [print(p['Name']) for p in pkgs if 'SaveBridge' in p.get('Name','') or 'SaveBridge' in p.get('PackageFullName','')]"
```

## Launch SaveBridge on Xbox

After deployment, launch SaveBridge from the **Dev Home** app on your Xbox:

1. On Xbox: open **Dev Home** (appears in My Games & Apps → Apps)
2. Go to **My Games & Apps** → select **SaveBridge**
3. The app will show the HTTP server address on screen

## Verify it's working (from Mac)

```bash
XBOX_IP=192.168.X.X
curl "http://${XBOX_IP}:8765/status"
# Expected: {"status":"ok","game":"Dead Island Definitive Edition",...}

curl "http://${XBOX_IP}:8765/save/list"
# Expected: {"blobs":[...],"count":N}
```

## Troubleshooting

**"Cannot reach SaveBridge"**
- Make sure SaveBridge is running on the Xbox (not minimized)
- Confirm Mac and Xbox are on the same WiFi network
- Check Xbox firewall: in Dev Home → Settings, ensure local network access is allowed

**"No blobs found"**
- Open Dead Island DE on Xbox, save the game, close it, then re-open SaveBridge
- The save must exist before it can be listed

**"Deployment failed"**
- Check that Developer Mode is active (Settings → System → Developer settings)
- Try uninstalling any previous SaveBridge version first via Device Portal
