# Meta Ads Mod

Manage Meta (Facebook/Instagram) ad campaigns, experiments, and a marketing knowledge base through MCP tools and a sidebar panel.

## Setup

1. Enable the mod in the DeepSteve mods panel
2. Open the Meta Ads sidebar panel
3. Enter your access token and ad account ID, then click Save

## Credential Storage

- **Access Token** — stored in the **macOS Keychain** (service: `deepsteve-meta-ads`, account: `access-token`). Never written to disk as plaintext.
- **Ad Account ID** — stored in `~/.deepsteve/meta-ads.json` (not a secret).

You can inspect or delete the stored token via Keychain Access.app or the CLI:

```bash
# View
security find-generic-password -s "deepsteve-meta-ads" -a "access-token" -w

# Delete
security delete-generic-password -s "deepsteve-meta-ads" -a "access-token"
```

If upgrading from a previous version that stored the token in `meta-ads.json`, the token is automatically migrated to Keychain on first load and removed from the JSON file.

## Token Refresh

The access token expires every ~60 days. When it expires, you'll see "Session has expired" errors from the MCP tools.

To refresh:

1. Go to [Graph API Explorer](https://developers.facebook.com/tools/explorer/)
2. Select the **Mukbang Marketing** app, add `ads_read` + `ads_management` permissions
3. Click **Generate Access Token** — this gives a short-lived token (~1-2 hours)
4. Exchange for a long-lived token (~60 days):

```bash
curl -s "https://graph.facebook.com/v21.0/oauth/access_token?grant_type=fb_exchange_token&client_id=1060273682636783&client_secret=APP_SECRET&fb_exchange_token=SHORT_LIVED_TOKEN"
```

5. Get the app secret from [App Settings](https://developers.facebook.com/apps/1060273682636783/settings/basic/?business_id=636869372422462)
6. Paste the long-lived token into the Meta Ads sidebar panel and click Save

## Ad Accounts

- `act_3596328883931292` — primary (currently in use)
- `act_1728088954605437` — secondary

## Files

| File | Purpose |
|------|---------|
| `mod.json` | Mod metadata and tool list |
| `index.html` | Sidebar panel UI |
| `tools.js` | MCP tool handlers, config routes, Keychain integration |
