<div align="center">

# WA2SimpleX

### WhatsApp conversations in SimpleX — one chat per contact, now with media.

[![Status](https://img.shields.io/badge/status-public%20alpha-orange)](https://github.com/0xRech/WA2SIMPLEX)
[![Version](https://img.shields.io/badge/version-0.3.0--alpha.1-blue)](https://github.com/0xRech/WA2SIMPLEX)
[![CI](https://github.com/0xRech/WA2SIMPLEX/actions/workflows/ci.yml/badge.svg)](https://github.com/0xRech/WA2SIMPLEX/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/Node.js-22.13%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

**Self-hosted · official WhatsApp Cloud API · SimpleX CLI · bidirectional media · no message-history database**

> **Public Alpha** — experimental software. Expect breaking changes and rough edges. Do not treat the current release as production-ready.

</div>

---

## What is WA2SimpleX?

WA2SimpleX is a self-hosted bridge between the **official WhatsApp Cloud API** and **SimpleX Chat**.

Each WhatsApp contact gets a dedicated private SimpleX group. Text and supported attachments can be routed in both directions, so normal use feels much closer to a messenger than to a command-driven gateway.

```text
WhatsApp                         WA2SimpleX                         SimpleX

Max ───────────────┐        ┌─────────────────────┐         ┌── WA · Max · 4567
  text / media     │        │ Contact Router      │         │   text / files
                   ├───────►│ Media Bridge        │─────────┤
Leonie ────────────┤        │ SQLite mappings     │         ├── WA · Leonie · 9012
                   │◄───────│ Webhook verification│◄────────┤
Kunde ─────────────┘        └─────────────────────┘         └── WA · Kunde · 1337
                                      │
                                      └────────────► WA2SimpleX Control
```

## v0.3 highlights

- **One SimpleX chat per WhatsApp contact.**
- Bidirectional text routing without phone-number commands or route markers.
- **WhatsApp → SimpleX binary transfer** for images, documents, audio/voice, video and stickers.
- **SimpleX → WhatsApp file transfer** with automatic MIME-based mapping to image, video, audio or document.
- Media size guard (`MEDIA_MAX_MB`) designed to protect small VPS instances.
- Temporary media directory with stale-transfer cleanup.
- WA2SimpleX deletes only files it created itself; SimpleX-owned files are never removed by the bridge.
- Dedicated **WA2SimpleX Control** chat with `/status`, `/contacts`, `/new`, `/archive`, `/unarchive`, `/repair` and `/wa`.
- Persistent SQLite contact mappings and WhatsApp webhook deduplication.
- Mapping recovery from SimpleX group custom data when possible.
- Meta `X-Hub-Signature-256` webhook verification.
- `/health` endpoint includes media-bridge status.

## How contact chats work

When WA2SimpleX sees a WhatsApp number for the first time it creates a private SimpleX group such as:

```text
WA · Max Mustermann · 4567
```

The bridge profile and your configured SimpleX contact are the group members. You accept the group invitation once; after that, normal messages and attachments in that group are routed to that WhatsApp contact.

Until you accept a newly created group, incoming WhatsApp content is additionally mirrored to the Control chat so the first messages are not missed.

## Media flow

### WhatsApp → SimpleX

```text
WhatsApp Media ID
      ↓
authenticated Meta download
      ↓
temporary file under data/media/whatsapp-in
      ↓
SimpleX XFTP attachment
      ↓
temporary bridge file removed after SimpleX reports completion
```

### SimpleX → WhatsApp

```text
SimpleX attachment
      ↓
WA2SimpleX receives/locates the file
      ↓
WhatsApp media upload
      ↓
WhatsApp image / video / audio / document message
      ↓
WA2SimpleX-owned temporary file removed
```

The current alpha sends WhatsApp media to SimpleX as a **generic SimpleX file attachment**. The binary content is transferred, but image/video/voice-specific SimpleX rendering is a future UX improvement.

## Privacy model

WA2SimpleX is a bridge, not one continuous end-to-end encrypted session:

```text
WhatsApp / Cloud API
        ↓
   WA2SimpleX VPS
        ↓
     SimpleX
```

The VPS is therefore a trusted endpoint and necessarily sees plaintext while translating between the networks.

WA2SimpleX does **not** maintain a message-history database. SQLite stores routing and operational metadata only:

- WhatsApp phone number
- display name
- associated SimpleX group ID
- ready/archive state
- timestamps
- processed WhatsApp message IDs for deduplication

Media is held temporarily during transfer. Interrupted transfers are cleaned according to `MEDIA_RETENTION_MINUTES`.

## Requirements

- Linux VPS/server
- **Node.js 22.13+**
- SimpleX Chat CLI with local WebSocket API
- Meta app with WhatsApp Cloud API enabled
- WhatsApp Business phone number / Phone Number ID
- public HTTPS endpoint for Meta webhooks

Keep the SimpleX WebSocket private on localhost.

## Quick start

### 1. Install SimpleX CLI

Official Linux/macOS install command:

```bash
curl -o- https://raw.githubusercontent.com/simplex-chat/simplex-chat/stable/install.sh | bash
```

Start SimpleX and create/configure the bridge profile, then connect that profile to the SimpleX account you want to use as the human side of WA2SimpleX.

Start the local bot/WebSocket API:

```bash
simplex-chat -p 5225
```

Do **not** expose port `5225` to the internet.

Determine the direct contact ID of your personal SimpleX account from the bridge profile. If it is contact `2`, the WA2SimpleX target is:

```dotenv
SIMPLEX_CONTROL_TARGET=@2
```

### 2. Install WA2SimpleX

```bash
git clone https://github.com/0xRech/WA2SIMPLEX.git
cd WA2SIMPLEX
npm install
cp .env.example .env
nano .env
```

Minimal configuration:

```dotenv
PORT=3000

WHATSAPP_VERIFY_TOKEN=choose-a-long-random-value
WHATSAPP_ACCESS_TOKEN=your-meta-access-token
WHATSAPP_PHONE_NUMBER_ID=your-phone-number-id
WHATSAPP_APP_SECRET=your-meta-app-secret
WHATSAPP_API_VERSION=v23.0
WHATSAPP_MARK_READ=true

SIMPLEX_WS_URL=ws://127.0.0.1:5225
SIMPLEX_CONTROL_TARGET=@2
SIMPLEX_GROUP_PREFIX=WA

DB_PATH=./data/wa2simplex.db

MEDIA_ENABLED=true
MEDIA_DIR=./data/media
MEDIA_MAX_MB=32
MEDIA_RETENTION_MINUTES=60
```

Then start:

```bash
npm start
```

### 3. Configure HTTPS / reverse proxy

Expose only WA2SimpleX's HTTP service. Example:

```text
https://bridge.example.com/webhook
```

Do not reverse-proxy the SimpleX WebSocket port.

### 4. Configure the Meta webhook

In your Meta app's WhatsApp webhook configuration set:

- Callback URL: `https://bridge.example.com/webhook`
- Verify token: exactly your `WHATSAPP_VERIFY_TOKEN`
- Subscribe to the `messages` field

WA2SimpleX verifies POST requests with your Meta app secret and `X-Hub-Signature-256`.

### 5. Check health

```bash
curl https://bridge.example.com/health
```

Expected shape:

```json
{
  "ok": true,
  "service": "WA2SimpleX",
  "version": "0.3.0-alpha.1",
  "simplexConnected": true,
  "mediaBridge": true
}
```

## Everyday use

First message from a new WhatsApp contact:

```text
WhatsApp: Max Mustermann
        ↓
WA2SimpleX creates:
WA · Max Mustermann · 4567
```

Accept the SimpleX group invitation once. Afterwards simply use that chat:

```text
WA · Max Mustermann · 4567

Max: Hallo 👋
You: Bin gleich da.
Max: [photo.jpg]
You: [rechnung.pdf]
```

## Control chat

```text
/status
/contacts
/new +491701234567 Max
/archive +491701234567
/unarchive +491701234567
/repair +491701234567
/wa +491701234567 Hallo 👋
/help
```

Files intentionally do **not** route from the Control chat. Send an attachment from the matching contact chat so the destination is unambiguous.

## Contact-chat commands

```text
/info
/rename Max Arbeit
/archive
/help
```

Messages beginning with `/` are local WA2SimpleX commands and are not forwarded to WhatsApp.

## Media configuration

`MEDIA_MAX_MB` is a WA2SimpleX safety ceiling, not a promise that every WhatsApp media type accepts that exact size. Meta can enforce additional per-type format and size limits.

For a small VPS, the default `32` MB is intentionally conservative because v0.3 currently buffers WhatsApp media in process memory during Cloud API download/upload.

Disable all media bridging with:

```dotenv
MEDIA_ENABLED=false
```

## systemd example

```ini
[Unit]
Description=WA2SimpleX bridge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/WA2SIMPLEX
EnvironmentFile=/opt/WA2SIMPLEX/.env
Environment=DB_PATH=/var/lib/wa2simplex/wa2simplex.db
Environment=MEDIA_DIR=/var/lib/wa2simplex/media
ExecStart=/usr/bin/node /opt/WA2SIMPLEX/src/index.js
Restart=on-failure
RestartSec=5
StateDirectory=wa2simplex
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true

[Install]
WantedBy=multi-user.target
```

Run SimpleX CLI as a separate service/user on the same host.

## Docker

```bash
docker build -t wa2simplex .
docker run -d \
  --name wa2simplex \
  --restart unless-stopped \
  --network host \
  --env-file .env \
  -v wa2simplex-data:/app/data \
  wa2simplex
```

Host networking lets the container reach a SimpleX CLI listening on host localhost. The persistent volume keeps SQLite routing data and the temporary media workspace outside the container lifecycle.

## Security notes

1. Never commit `.env`, Meta access tokens or app secrets.
2. Never expose SimpleX port `5225` publicly.
3. Put `/webhook` behind HTTPS.
4. Keep the VPS, Node.js and SimpleX CLI patched.
5. Protect the `data`/state directory from other OS users; media exists there in plaintext while a transfer is active.
6. Keep `MEDIA_MAX_MB` appropriate for available RAM.
7. Back up the SQLite routing DB if preserving contact mappings matters to you.
8. See [SECURITY.md](SECURITY.md) for vulnerability reporting.

## Current limitations

- A newly generated SimpleX contact group still requires one-time invitation acceptance.
- WhatsApp → SimpleX media currently arrives as a generic SimpleX file attachment rather than a native SimpleX image/video/voice presentation.
- Sticker semantics are not preserved end-to-end; the binary file is bridged.
- MIME detection for SimpleX → WhatsApp is currently filename-extension based.
- WhatsApp Business Platform conversation/template restrictions still apply to outbound traffic.
- Media is currently buffered in memory, so this alpha is intentionally capped by `MEDIA_MAX_MB`.
- v0.3 has not been load-tested at large scale.

## Roadmap

- [x] WhatsApp ↔ SimpleX text
- [x] One SimpleX chat per WhatsApp contact
- [x] Persistent SQLite routing
- [x] Control chat
- [x] Persistent webhook deduplication
- [x] WhatsApp → SimpleX binary attachments
- [x] SimpleX → WhatsApp images/documents/audio/video
- [ ] Native SimpleX image/video/voice rendering
- [ ] Stream media instead of buffering it in memory
- [ ] Better delivery/read-state synchronization
- [ ] Multi-number / multi-user routing

## Development

```bash
npm run check
npm test
npm run dev
```

## Disclaimer

WA2SimpleX is an independent open-source project and is **not affiliated with, endorsed by, or sponsored by Meta, WhatsApp or SimpleX Chat**. WhatsApp and SimpleX are trademarks of their respective owners.

Use of the WhatsApp Business Platform is subject to Meta's applicable terms and policies.

## License

MIT — see [LICENSE](LICENSE).
