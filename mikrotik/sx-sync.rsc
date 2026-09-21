# =============================================================
#  Sornix Express WiFi - sync tick (RouterOS 7.x syntax)
#  Installed by the bootstrap; runs every 25 s via scheduler.
#
#  Each tick:
#   1. builds a report of sx-managed hotspot users, active
#      sessions and bypass bindings
#   2. POSTs it as http-data to the Worker /router/sync
#      and captures the reply (RouterOS commands) with output=user
#   3. writes the reply to sxcmd.rsc and /import s it
#      -> vouchers, approved orders, renewals, revokes and the
#         MAC whitelist are applied automatically
# =============================================================

:global sxBusy
:global sxTick
:global sxBusyTick
:set sxTick ($sxTick + 1)

:if ($sxBusy = "1") do={
  :if (($sxTick - $sxBusyTick) < 3) do={ :log info "sx-sync: previous run still active, skipping"; :return null }
  :log warning "sx-sync: clearing stale lock"
}
:set sxBusy "1"
:set sxBusyTick $sxTick

:local rep ""

# sx-managed hotspot users (comment="sx" marks ours; hand-made users untouched)
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

# POST the report (body via http-data, reply discarded), then DOWNLOAD the
# command file with a plain GET (proven shape) and import it
:local r [/tool fetch url=("$sxApi/router/sync?token=" . $sxTok) http-method=post http-data=$rep output=none as-value]
:if (($r->"status") = "finished") do={
  :local r2 [/tool fetch url=("$sxApi/router/commands?token=" . $sxTok) dst-path="sxcmd.rsc" as-value]
  :if (($r2->"status") = "finished") do={
    :if ([/file get [find where name="sxcmd.rsc"] size] > 0) do={
      :do { /import file-name="sxcmd.rsc" } on-error={ :log error "sx-sync: import failed" }
      :log info ("sx-sync: ok, sx users " . [:len [/ip hotspot user find where comment="sx"]])
    } else={
      :log warning "sx-sync: empty command file"
    }
  } else={
    :log warning ("sx-sync: commands fetch failed (" . ($r2->"status") . ")")
  }
} else={
  :log warning ("sx-sync: post failed (" . ($r->"status") . ") - check internet, DNS and TLS certificate store")
}

:set sxBusy "0"
