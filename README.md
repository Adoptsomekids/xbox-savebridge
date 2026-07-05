# xbox-savebridge

> A universal Xbox Series X / Xbox One UWP companion app that runs **on your console** (via Developer Mode) and exposes Connected Storage game saves over a local HTTP server — so any save editor running on your Mac, Linux, or PC can download and upload saves wirelessly.

---

## Why This Exists

Xbox Series X stores saves in **Connected Storage** — a system tied to Xbox Live and the console hardware. Microsoft provides no external API to access it. The only way to read and write Connected Storage from outside the console is to run a small UWP app **on the console itself**, using the official `Windows.Gaming.XboxLive.Storage` API.

SaveBridge is that app. It takes ~10 minutes to set up once, and then you can transfer saves over WiFi from any machine on your network, forever.

---

## Architecture

```
┌─────────────────────────────────────────┐
│  Xbox Series X — SaveBridge UWP running │
│                                         │
│  Windows.Gaming.XboxLive.Storage API    │
│         ↕ reads/writes any title's      │
│           Connected Storage blobs       │
│                                         │
│  HTTP server  →  port 8765              │
└──────────────────┬──────────────────────┘
                   │ local WiFi (same network)
┌──────────────────┴──────────────────────┐
│  Your Mac / Linux / PC                  │
│                                         │
│  GET  /save/list                        │
│  GET  /save/download?name=slot/blob     │
│  POST /save/upload?name=slot/blob       │
└─────────────────────────────────────────┘
```

---

## Prerequisites

- Xbox Series X or Xbox One with **Developer Mode** active
  - Register at [dev.xbox.com](https://dev.xbox.com) (one-time setup)
  - Cost: free (Xbox Live Creators Program)
- The game you want to back up must be installed and have at least one save

---

## Installation

### Option A — Download pre-built APPX (no Windows needed)

1. Go to [Releases](https://github.com/Adoptsomekids/xbox-savebridge/releases)
2. Download `SaveBridge.appxbundle`
3. Deploy via Xbox Device Portal from your Mac:

```bash
# Find your Xbox IP: Settings → General → Network settings → Advanced settings
XBOX_IP=192.168.X.X

curl -k -u "DevToolsUser:YOUR_DEVICE_PORTAL_PASSWORD" \
  -X POST "https://${XBOX_IP}:11443/api/app/packagemanager/package" \
  -F "file=@SaveBridge.appxbundle"
```

4. Launch **SaveBridge** from the Dev Home app on your Xbox

### Option B — Build from source (requires Windows + Visual Studio 2022)

```powershell
# Open SaveBridge.sln in Visual Studio 2022
# Set target: Release | ARM64
# Build → Deploy to Xbox via Device Portal (VS handles this automatically)
```

---

## HTTP API

Once SaveBridge is running on your Xbox, it listens on port **8765**.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/status` | Health check — returns game info and SCID |
| `GET` | `/save/list` | List all Connected Storage containers and blobs |
| `GET` | `/save/download?name=container/blob` | Download a save blob (binary) |
| `POST` | `/save/upload?name=container/blob` | Upload/overwrite a save blob (binary body) |

### Example: Dead Island Definitive Edition

```bash
XBOX_IP=192.168.X.X

# List all saves
curl "http://${XBOX_IP}:8765/save/list"

# Download save slot 0
curl "http://${XBOX_IP}:8765/save/download?name=save0/data" -o save.bin

# Upload modified save
curl -X POST "http://${XBOX_IP}:8765/save/upload?name=save0/data" \
     --data-binary @save.edited.bin

# Verify status
curl "http://${XBOX_IP}:8765/status"
```

---

## Configuration

By default SaveBridge is configured for **Dead Island Definitive Edition**.
To use it with a different game, change the `SCID` constant in [`SaveBridgeServer.cs`](SaveBridge/SaveBridge/SaveBridgeServer.cs):

| Game | SCID |
|------|------|
| Dead Island: Definitive Edition | `db860100-d780-4e17-8685-ad130052ea64` |
| Dead Island: Riptide DE | `(TBD — open an issue to request)` |
| *(your game)* | Find it in the game's achievements API response |

---

## Usage with dead-island-definitive-save-editor

```bash
# In dead-island-definitive-save-editor/
npm run sync -- --download --xbox-ip 192.168.X.X
npm run dev  -- --input ./dead-island-save-*.sav --god-mode --max-level
npm run sync -- --upload --input ./dead-island-save-*.sav.edited --xbox-ip 192.168.X.X
```

---

## How to Find Any Game's SCID

```bash
# Authenticate with Xbox Live (one-time setup)
pip install xbox-webapi && xbox-authenticate

# Query your achievements to find the SCID for any game you've played
python3 -c "
import asyncio, json
from xbox.webapi.authentication.manager import AuthenticationManager
from xbox.webapi.authentication.models import OAuth2TokenResponse
from xbox.webapi.common.signed_session import SignedSession

async def main():
    async with SignedSession() as session:
        auth = AuthenticationManager(session, '000000004C12AE6F', '', '')
        with open('/Users/\$USER/Library/Application Support/xbox/tokens.json') as f:
            auth.oauth = OAuth2TokenResponse.model_validate_json(f.read())
        await auth.refresh_tokens()
        import httpx
        resp = httpx.get(
            f'https://achievements.xboxlive.com/users/xuid({auth.xsts_token.xuid})/achievements?titleId=YOUR_TITLE_ID',
            headers={'Authorization': auth.xsts_token.authorization_header_value, 'x-xbl-contract-version': '2'}
        )
        for a in resp.json().get('achievements', [])[:1]:
            print('SCID:', a.get('serviceConfigId'))
asyncio.run(main())
"
```

---

## Security

- SaveBridge only listens on the local network (LAN) — it is not exposed to the internet
- No authentication is required by default (local network is trusted)
- The Xbox Device Portal itself requires credentials to deploy the app
- Connected Storage is still protected by Xbox Live authentication on the console side

---

## Contributing

PRs welcome. To add support for a new game, open an issue with the game name and Title ID — we'll document the SCID.

---

## License

MIT — see [LICENSE](LICENSE)

---

## Acknowledgements

- Inspired by [Vantage](https://www.vantagemods.com) — the original Xbox One save modding platform
- [OpenXbox/xbox-webapi-python](https://github.com/OpenXbox/xbox-webapi-python) — Xbox Live authentication
- [dead-island-definitive-save-editor](https://github.com/Adoptsomekids/dead-island-definitive-save-editor) — the companion save editor

---
<p align="center"><sub>Made with ❤️ by Adoptsomekids</sub></p>
