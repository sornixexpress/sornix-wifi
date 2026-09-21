# =============================================================
#  Sornix Express WiFi - sync tick (RouterOS 7.x syntax)  [v12]
#  Installed by the bootstrap; runs every 25 s via scheduler.
#  v10: /tool fetch never overwrites an existing file on RouterOS -
#       every download now removes the old file first, and reports
#       on-flash portal file sizes so the Worker can verify them.
#  v11: reports its own version (S) and tick counter (T) so the Worker
#       only pushes a self-update when the script is actually outdated
#       (replacing the script source every tick was resetting globals).
#  NOTE: bump the S number below on EVERY change to this file, and set
#       the same number in worker.js (SX_VERSION), or routers will not
#       pick up the new version.
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
# W = associated wireless stations (on the WiFi, logged in or not)
:do {
  :foreach r in=[/interface wireless registration-table find] do={
    :set $rep ($rep . "W " . [/interface wireless registration-table get $r mac-address] . " " . [/interface wireless registration-table get $r signal-strength] . " " . [/interface wireless registration-table get $r uptime] . "\n")
  }
} on-error={ }
# L = bound DHCP leases (have an IP, logged in or not)
:do {
  :foreach l in=[/ip dhcp-server lease find where status="bound"] do={
    :set $rep ($rep . "L " . [/ip dhcp-server lease get $l mac-address] . " " . [/ip dhcp-server lease get $l address] . " " . [/ip dhcp-server lease get $l host-name] . "\n")
  }
} on-error={ }
# G = current WiFi identity (ssid, frequency, psk-set flag) - never the key itself
:do {
  :local wi [/interface wireless find where mode="ap-bridge" and disabled=no]
  :if ([:len $wi] > 0) do={
    :local w0 ($wi->0)
    :local sp [/interface wireless get $w0 security-profile]
    :set $rep ($rep . "G " . [/interface wireless get $w0 ssid] . " " . [/interface wireless get $w0 frequency] . " " . ([:len [/interface wireless security-profiles get [find where name=$sp] wpa2-pre-shared-key]] > 0) . "\n")
  }
} on-error={ }
:set $rep ($rep . "S 12\n")
:set $rep ($rep . "T " . $sxTick . "\n")
:set $rep ($rep . "V " . [/system resource get version] . " " . [/system identity get name] . "\n")
# N = total hotspot users + names of users NOT tagged comment=sx (orphan visibility)
:local nx ""
:foreach u2 in=[/ip hotspot user find where comment!="sx"] do={ :set $nx ($nx . [/ip hotspot user get $u2 name] . ",") }
:set $rep ($rep . "N " . [/ip hotspot user print count-only] . " " . $nx . "\n")

# POST the report (body via http-data, reply discarded), then DOWNLOAD the
# command file with a plain GET (proven shape) and import it
:local r [/tool fetch url=("$sxApi/router/sync?token=" . $sxTok) http-method=post http-data=$rep output=none as-value]
:if (($r->"status") = "finished") do={
  :do { /file remove [find where name="sxcmd.rsc"] } on-error={ }
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

# Portal page refresh is pushed BY THE WORKER (pending commands) whenever its
# PORTAL_GEN changes - this build of RouterOS does not persist script globals
# between scheduler runs, so a tick-counted refresh here always re-fired.
# Every download deletes the old file first (/tool fetch never overwrites).

:set sxBusy "0"
