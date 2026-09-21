# =============================================================
#  Sornix Express WiFi - sync tick (runs every 25 s via scheduler)
#  Winbox: System > Scripts > "+" name: sx-sync  -> paste this
#
#  What it does each tick:
#   1. builds a small report of sx-managed hotspot users, active
#      sessions and bypass bindings
#   2. POSTs it to the Worker  /router/sync?token=...
#   3. saves the Worker reply (RouterOS commands) and /import s it
#      -> vouchers, approved orders, renewals, revokes and the
#         MAC whitelist are applied to the router automatically
# =============================================================

:global sxBusy
:global sxTick
:global sxBusyTick
:set sxTick ($sxTick + 1)

:if ($sxBusy = "1") do={
  :if (($sxTick - $sxBusyTick) < 3) do={ :log info "sx-sync: previous run still active, skipping"; :return }
  :log warning "sx-sync: clearing stale lock"
}
:set sxBusy "1"
:set sxBusyTick $sxTick

:local rep ""

# sx-managed hotspot users (comment="sx" marks ours; anything you add by hand is untouched)
:foreach u in=[/ip hotspot user find where comment="sx"] do={
  :set $rep ($rep . "U " . [/ip hotspot user get $u name] . "\n")
}
# currently logged-in sessions (used to mark vouchers as used)
:foreach a in=[/ip hotspot active find] do={
  :set $rep ($rep . "A " . [/ip hotspot active get $a user] . " " . [/ip hotspot active get $a mac-address] . "\n")
}
# sx-managed bypass bindings (MAC whitelist)
:foreach b in=[/ip hotspot ip-binding find where comment="sx"] do={
  :set $rep ($rep . "B " . [/ip hotspot ip-binding get $b mac-address] . "\n")
}
:set $rep ($rep . "V " . [/system resource get version] . " " . [/system identity get name] . "\n")

/file remove [find where name="sxrep.txt"]
/file add name="sxrep.txt" contents=$rep
/file remove [find where name="sxcmd.rsc"]

:local r [/tool fetch url=("$sxApi/router/sync?token=" . $sxTok) http-method=post upload=yes src-path="sxrep.txt" dst-path="sxcmd.rsc" as-value]
:if (($r->"status") = "finished") do={
  /import file-name="sxcmd.rsc"
  :log info "sx-sync: ok"
} else={
  :log warning ("sx-sync: fetch failed (" . ($r->"status") . ") - check internet, DNS and TLS certificate store")
}

:set sxBusy "0"
