# WA2SimpleX

WA2SimpleX is a small self-hosted bridge between the official WhatsApp Cloud API and SimpleX Chat.

```text
WhatsApp user
     │
     ▼
Meta WhatsApp Cloud API
     │ HTTPS webhook
     ▼
WA2SimpleX ─────────────► SimpleX CLI WebSocket (localhost)
     ▲                              │
     └──────── WhatsApp reply ◄─────┘
```

## Current MVP

- Receives WhatsApp Cloud API webhooks.
- Verifies Meta's `X-Hub-Signature-256` before processing messages.
- Forwards WhatsApp text and a readable representation of common non-text message types to one private SimpleX chat.
- Lets you reply from SimpleX by replying/quoting the forwarded bridge message.
- Fallback command: `/wa +491701234567 message`.
- Ignores un-routed SimpleX messages so an accidental message is not sent to WhatsApp.
- Deduplicates WhatsApp webhook deliveries in memory.
- Optional automatic WhatsApp read receipts.
- Exposes `/health` for monitoring.
- Does not store a message history or phone-number database.

> Important: this is a bridge, not end-to-end encryption across both networks. The bridge process necessarily sees message plaintext while converting between WhatsApp and SimpleX.

## Requirements

- Linux VPS or server
- Node.js 20+
- SimpleX Chat CLI
- Meta app with WhatsApp Cloud API enabled
- A WhatsApp Business phone number / Phone Number ID
- HTTPS endpoint reachable by Meta, for example through Caddy, Nginx or a Plesk reverse proxy

## 1. Install SimpleX CLI

Use the current SimpleX CLI installation instructions, then start it as a local WebSocket server:

```bash
simplex-chat -p 5225
```

Keep port `5225` private. The SimpleX WebSocket API has no built-in authentication and is intended to stay local.

Create or use a SimpleX profile for the bridge and connect it to your personal SimpleX account. In the CLI, use `/contacts` to determine the numeric contact ID. If your own contact is ID `2`, set:

```dotenv
SIMPLEX_TARGET=@2
```

For a private SimpleX group with group ID `5`, use `#5` instead.

## 2. Install WA2SimpleX

```bash
git clone https://github.com/0xRech/WA2SIMPLEX.git
cd WA2SIMPLEX
npm install
cp .env.example .env
nano .env
npm start
```

Required values in `.env`:

```dotenv
WHATSAPP_VERIFY_TOKEN=a-long-random-value-you-choose
WHATSAPP_ACCESS_TOKEN=your-meta-access-token
WHATSAPP_PHONE_NUMBER_ID=your-phone-number-id
WHATSAPP_APP_SECRET=your-meta-app-secret
WHATSAPP_API_VERSION=v23.0

SIMPLEX_WS_URL=ws://127.0.0.1:5225
SIMPLEX_TARGET=@2
```

`WHATSAPP_API_VERSION` is deliberately configurable. Use a Graph API version currently supported by your Meta app.

## 3. Publish only the HTTP webhook

WA2SimpleX listens on port `3000` by default. Put it behind HTTPS and expose only the web application, not the SimpleX WebSocket port.

Example public callback URL:

```text
https://bridge.example.com/webhook
```

Health check:

```text
https://bridge.example.com/health
```

## 4. Configure Meta webhook

In the Meta app's WhatsApp webhook settings:

- Callback URL: `https://bridge.example.com/webhook`
- Verify token: exactly the value from `WHATSAPP_VERIFY_TOKEN`
- Subscribe to the `messages` webhook field

The GET verification request is checked with the verify token. Actual POST webhooks are additionally authenticated with the Meta app secret using `X-Hub-Signature-256`.

## Replying from SimpleX

Incoming WhatsApp:

```text
📲 WhatsApp · Max Mustermann
Von: +491701234567
⟦WA:491701234567⟧

Hallo, bist du da?

↩️ Antworte in SimpleX direkt auf diese Nachricht.
```

Reply to/quote that SimpleX message and write:

```text
Ja, bin da 👍
```

WA2SimpleX reads the route marker from the quoted content and sends your reply to the correct WhatsApp number.

Fallback without quoting:

```text
/wa +491701234567 Ja, bin da 👍
```

`/help` shows usage help inside SimpleX.

## Run with systemd

Example `/etc/systemd/system/wa2simplex.service`:

```ini
[Unit]
Description=WA2SimpleX bridge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/WA2SIMPLEX
EnvironmentFile=/opt/WA2SIMPLEX/.env
ExecStart=/usr/bin/node /opt/WA2SIMPLEX/src/index.js
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true

[Install]
WantedBy=multi-user.target
```

The SimpleX CLI should be run as a separate service/user on the same machine, with its WebSocket API bound to localhost.

## Docker

A `Dockerfile` is included. Because the SimpleX CLI WebSocket should remain on localhost, the easiest Linux deployment is to run WA2SimpleX with host networking while SimpleX runs directly on the same VPS:

```bash
docker build -t wa2simplex .
docker run --rm --network host --env-file .env wa2simplex
```

Do not publish port `5225` to the internet. Put the HTTP service behind your reverse proxy instead.

## Security notes

1. Never commit `.env` or Meta access tokens.
2. Never expose SimpleX port `5225` publicly.
3. Keep `SIMPLEX_RESTRICT_TO_TARGET=true`.
4. Use HTTPS in front of `/webhook`.
5. Keep the VPS patched and restrict inbound firewall ports to what is required.
6. A WhatsApp-to-SimpleX bridge terminates one encrypted session and creates another; it cannot preserve one continuous E2EE session from the WhatsApp sender to your SimpleX app.

## Limitations of v0.1.0

- Text replies are bidirectional.
- WhatsApp images/documents/audio/video are represented as notices/captions in SimpleX; binary media transfer is planned next.
- SimpleX file attachments are not yet uploaded back to WhatsApp.
- In-memory webhook deduplication resets after process restart. A persistent lightweight store can be added later.

## Development

```bash
npm run check
npm test
npm run dev
```

## License

Choose and add a license before making the repository public.
