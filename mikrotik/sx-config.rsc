# =============================================================
#  Sornix Express WiFi - router configuration (edit, then paste)
#  Winbox: System > Scripts > "+" name: sx-config  -> paste this
#  (or upload as sx-config.rsc and run:  /import file-name=sx-config.rsc)
# =============================================================

# Base URL of your Cloudflare Worker (no trailing slash)
:global sxApi "https://isp.sornix.com.ng"

# Must match the ROUTER_TOKEN secret on the Worker.
# Generate:  openssl rand -hex 24   (or any 32+ random characters)
:global sxTok "PASTE_ROUTER_TOKEN_HERE"

# sync loop state (used by sx-sync; v6-safe initialisation)
:global sxTick 0
:global sxBusy "0"
:global sxBusyTick 0
