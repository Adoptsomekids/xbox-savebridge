# Adding Support for a New Game

This guide explains how to configure SaveBridge for any Xbox One / Series X game.

## Step 1: Find the Game's SCID

The SCID (Service Configuration ID) is a GUID that identifies the game's Xbox Live service configuration. SaveBridge needs it to open the correct Connected Storage container.

### Method A — From Achievements API (easiest)

```bash
# Prerequisites: pip install xbox-webapi && xbox-authenticate

python3 << 'EOF'
import asyncio, json, sys
from xbox.webapi.authentication.manager import AuthenticationManager
from xbox.webapi.authentication.models import OAuth2TokenResponse
from xbox.webapi.common.signed_session import SignedSession

TOKEN_FILE = "~/Library/Application Support/xbox/tokens.json"

# Replace with your game's Title ID (decimal)
# Find it at: https://www.xbox.com/en-US/games or xenia-manager/x360db
TITLE_ID = 5433956  # Dead Island Definitive Edition

async def main():
    import os
    async with SignedSession() as session:
        auth = AuthenticationManager(session, "000000004C12AE6F", "", "")
        with open(os.path.expanduser(TOKEN_FILE)) as f:
            auth.oauth = OAuth2TokenResponse.model_validate_json(f.read())
        await auth.refresh_tokens()

        import httpx
        resp = httpx.get(
            f"https://achievements.xboxlive.com/users/xuid({auth.xsts_token.xuid})/achievements?titleId={TITLE_ID}",
            headers={
                "Authorization": auth.xsts_token.authorization_header_value,
                "x-xbl-contract-version": "2",
                "Accept-Language": "en-US",
            }
        )
        achievements = resp.json().get("achievements", [])
        if achievements:
            print(f"Title: {achievements[0]['titleAssociations'][0]['name']}")
            print(f"SCID:  {achievements[0]['serviceConfigId']}")
        else:
            print("No achievements found — make sure you have played the game and the Title ID is correct.")

asyncio.run(main())
EOF
```

### Method B — From TitleHub API

```bash
python3 << 'EOF'
import asyncio, json
from xbox.webapi.api.client import XboxLiveClient
from xbox.webapi.authentication.manager import AuthenticationManager
from xbox.webapi.authentication.models import OAuth2TokenResponse
from xbox.webapi.common.signed_session import SignedSession
import httpx, os

async def main():
    async with SignedSession() as session:
        auth = AuthenticationManager(session, "000000004C12AE6F", "", "")
        with open(os.path.expanduser("~/Library/Application Support/xbox/tokens.json")) as f:
            auth.oauth = OAuth2TokenResponse.model_validate_json(f.read())
        await auth.refresh_tokens()

        # Get title history (shows all games you've played)
        resp = httpx.get(
            f"https://titlehub.xboxlive.com/users/xuid({auth.xsts_token.xuid})/titles/titlehistory/decoration/detail",
            headers={
                "Authorization": auth.xsts_token.authorization_header_value,
                "x-xbl-contract-version": "2",
                "Accept-Language": "en-US",
            }
        )
        for title in resp.json().get("titles", []):
            print(f"TitleId: {title['titleId']:>12}  Name: {title['name']}")

asyncio.run(main())
EOF
```

## Step 2: Update SaveBridgeServer.cs

Open [`SaveBridgeServer.cs`](SaveBridge/SaveBridge/SaveBridgeServer.cs) and update the SCID constant:

```csharp
// Change this line:
private const string DEAD_ISLAND_SCID = "db860100-d780-4e17-8685-ad130052ea64";

// To your game's SCID:
private const string YOUR_GAME_SCID = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx";
```

## Step 3: Rebuild and Redeploy

Commit, push — GitHub Actions will compile a new APPX automatically. Download from the Actions artifacts tab and deploy to your Xbox via Device Portal.

## Step 4: Submit a PR

If you'd like this game to be supported officially, submit a PR adding it to the SCID table in the README. The more games documented, the more useful SaveBridge becomes for everyone.

## Known Game SCIDs

| Game | Title ID | SCID |
|------|----------|------|
| Dead Island: Definitive Edition | `5433956` | `db860100-d780-4e17-8685-ad130052ea64` |
| *(submit PR to add yours)* | | |
