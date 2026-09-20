# =============================================================
#  Sornix Express WiFi - one-time router setup
#  1. upload sx-config.rsc, sx-sync.rsc and this file to the router
#     (Winbox: Files, drag & drop into the root folder)
#  2. edit sx-config.rsc on the router (API url + token)
#  3. terminal:  /import file-name=sx-setup.rsc
#
#  Creates: system scripts sx-config / sx-sync, a 25 s scheduler,
#  and the hotspot walled-garden entries the captive portal needs
#  (Worker API, Paystack, Flutterwave, WhatsApp).
# =============================================================

# ---- install the two scripts from the uploaded files ----
/system script remove [find where name="sx-config"]
/system script remove [find where name="sx-sync"]
/system script add name="sx-config" source=[/file get [find where name="sx-config.rsc"] contents]
/system script add name="sx-sync"   source=[/file get [find where name="sx-sync.rsc"] contents]

# ---- scheduler: pull sync every 25 seconds, also after reboot ----
/system scheduler remove [find where name="sx-sync"]
/system scheduler add name="sx-sync" interval=25s start-time=startup \
  on-event="/system script run sx-config\n/system script run sx-sync"

# ---- walled garden: reachable BEFORE login ----
/ip hotspot walled-garden remove [find where comment="sx"]
/ip hotspot walled-garden add dst-host="isp.sornix.com.ng"        comment="sx"
/ip hotspot walled-garden add dst-host="js.paystack.co"           comment="sx"
/ip hotspot walled-garden add dst-host="api.paystack.co"          comment="sx"
/ip hotspot walled-garden add dst-host="checkout.flutterwave.com" comment="sx"
/ip hotspot walled-garden add dst-host="api.flutterwave.com"      comment="sx"
/ip hotspot walled-garden add dst-host="wa.me"                    comment="sx"

# ---- run once now so the router appears online immediately ----
/system script run sx-config
/system script run sx-sync

:log info "sx-setup: done - check /log and the admin dashboard Router link"
