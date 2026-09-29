# Using a ChatGPT/Codex Subscription via an OAuth Gateway

This guide describes a deployment-level integration: how to use a paid
ChatGPT/Codex subscription (OAuth login) as a HappyClaw conversation
provider. It requires no code changes — HappyClaw only needs a provider
that speaks the Anthropic messages protocol, and a local OAuth gateway
supplies exactly that.

## How it works

HappyClaw's provider system is Anthropic-native. The gateway sits between
HappyClaw and OpenAI: it owns the Codex OAuth login and token refresh, and
exposes an Anthropic-compatible `/v1/messages` endpoint (including tool use
and SSE streaming) that the Claude Agent SDK can consume directly.

```text
HappyClaw (Claude Agent SDK)
        │  Anthropic /v1/messages
        ▼
OAuth gateway (CLIProxyAPI, local Docker)
        │  Codex OAuth (device-code login, auto token refresh)
        ▼
ChatGPT / Codex backend
```

Two properties make this setup practical:

- The gateway translates between the Anthropic wire format and the Codex
  backend, so HappyClaw sees an ordinary third-party Anthropic-compatible
  provider.
- OAuth access tokens are short-lived; the gateway refreshes them
  automatically using the stored refresh token and rewrites the credential
  file in place.

## Prerequisites

- A ChatGPT account with a paid subscription (Plus/Pro); free accounts
  cannot use Codex.
- In the ChatGPT web app, enable **Settings → Security → Device code
  login** for Codex on the account you plan to use. This is an
  account-level switch and must be enabled before the device-code flow
  below will succeed.
- Docker on the HappyClaw host.

## 1. Deploy the gateway

This guide uses [CLIProxyAPI](https://github.com/eceasy/cli-proxy-api)
(`eceasy/cli-proxy-api`), which supports Codex OAuth accounts and an
Anthropic-compatible endpoint.

Create a working directory and a `config.yaml`:

```yaml
host: ''
port: 8317
tls:
  enable: false
remote-management:
  allow-remote: false
  secret-key: ''
auth-dir: '/root/.cli-proxy-api'
api-keys:
  - 'hcw_YOUR_OWN_RANDOM_KEY'
debug: false
```

Generate the key yourself, for example with `openssl rand -hex 24`. This
key is what HappyClaw will present as the provider API key — pick a fresh
random value per gateway instance.

Start the container:

```bash
mkdir -p ~/cpa/auths
docker run -d --name cpa-server --restart always \
  -p 172.17.0.1:8317:8317 \
  -v ~/cpa/auths:/root/.cli-proxy-api \
  -v ~/cpa/config.yaml:/CLIProxyAPI/config.yaml:ro \
  eceasy/cli-proxy-api:latest
```

Port binding notes:

- `172.17.0.1` is the Docker bridge gateway. Binding there keeps the
  service unreachable from the public internet while still reachable from
  other containers — required when HappyClaw runs Agents in Docker
  (container execution mode) and reaches the host through the bridge.
- If HappyClaw runs Agents directly on the host (host execution mode),
  bind to `127.0.0.1` instead.

## 2. Log in with a device code

Run the device-code login inside the container:

```bash
docker exec -it cpa-server ./CLIProxyAPI -codex-device-login
```

It prints a code and a URL:

1. Open `https://auth.openai.com/codex/device`
2. Enter the printed device code
3. Sign in with the ChatGPT account you enabled device-code login for

On success the credential file (named after the account) appears in the
`auths/` directory, the gateway hot-reloads it without a restart, and the
account joins the serving pool.

## 3. Verify the gateway

```bash
# Model list
curl -s http://172.17.0.1:8317/v1/models \
  -H "Authorization: Bearer hcw_YOUR_OWN_RANDOM_KEY"

# Minimal Anthropic-compatible request
curl -s http://172.17.0.1:8317/v1/messages \
  -H "x-api-key: hcw_YOUR_OWN_RANDOM_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{"model":"gpt-5.6-sol","max_tokens":64,"messages":[{"role":"user","content":"Say OK"}]}'
```

The exact model names depend on what the gateway exposes for your account;
pick one from `/v1/models` (for example `gpt-5.6-sol`). Tool use and SSE
streaming on `/v1/messages` work as with any Anthropic-compatible
endpoint.

## 4. Add the provider in HappyClaw

In the web UI, go to **Provider setup** (`/setup/providers`), create a
third-party provider, and fill in:

| Field      | Value                                                       |
| ---------- | ----------------------------------------------------------- |
| Base URL   | `http://172.17.0.1:8317` (or `127.0.0.1:8317` in host mode) |
| API Key    | The `api-keys` value from the gateway config                |
| Model name | A model from `/v1/models`, e.g. `gpt-5.6-sol`               |

Enable the provider and switch the target workspace to it. No other
HappyClaw configuration changes are needed.

## 5. Multiple accounts

Two layouts are supported:

- **Single instance, account pool.** Log in with each account as in step
  2; every credential file in `auth-dir` joins one pool and requests
  rotate between accounts. Quotas remain per account.
- **One instance per account.** Run a second container with its own
  `auth-dir`, config file, API key and host port (for example `8318`).
  This gives hard account isolation — useful when different workspaces
  must be pinned to different accounts, since each HappyClaw provider
  points at exactly one instance.

Both layouts refresh tokens independently; keeping the container running
(`restart: always`) is what keeps refreshes happening.

## Security notes

- Never expose the gateway port publicly. Bind to the Docker bridge or
  loopback only, and keep `remote-management.allow-remote: false`.
- Credential files and gateway config contain OAuth tokens and API keys.
  Keep them outside any repository, and restrict directory permissions to
  the deploying user.
- The Anthropic-compatible endpoint is authenticated only by the shared
  API key, so treat anything that can reach the port as able to spend the
  linked subscription quota.
- Signing out of all sessions in the ChatGPT web app, changing the
  password, or revoking the authorization invalidates the refresh token;
  re-run the device-code login to recover.

## Troubleshooting

| Symptom                                                 | Likely cause / fix                                                                                      |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Device login rejected, asks to enable device code login | Enable the account-level switch (see Prerequisites) on the exact account being signed in, then retry    |
| HappyClaw suddenly reports 401/403                      | The stored refresh token was revoked — re-run device-code login; verify with the curl checks in step 3  |
| Model list works but requests fail                      | Confirm the model name exists in `/v1/models` for your account type                                     |
| Gateway unreachable from HappyClaw containers           | Check the port binding: containers reach the host via the Docker bridge (`172.17.0.1`), not `127.0.0.1` |
