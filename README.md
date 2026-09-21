# Sornix Express WiFi — Cloudflare Workers + D1 + MikroTik Groove (all free tier)

This project replaces the old **Google Apps Script + Google Sheets** backend with a
**Cloudflare Worker (free) + D1 database (free)**, while the **MikroTik Groove router**
keeps doing what it is good at: captive portal, hotspot authentication, rate limiting,
session limits and MAC bypass. Nothing else is needed — no VPS, no paid service.

```
 Customer phone/laptop                MikroTik Groove (RouterOS)                 Cloudflare (free)
 ─────────────────────               ──────────────────────────────             ─────────────────────────────
  Wi‑Fi → captive portal     ──────►  hotspot: login.html / status.html …        Worker (this repo)
  login.html (on router)              │  ▲                                       ├─ /api  (plans, orders, OTP,
  │  loads plans, orders, pays ────────────────────── HTTPS ──────────────────► │        admin actions)   ──► D1
  │  (Paystack / Flutterwave /        │  │                                       ├─ /admin.html, /verify.html
  │   WhatsApp bank transfer)         │  │ every 25 s: POST report               ├─ /router/sync
  │  submits PIN / user / MAC ──────► │  └── GET commands (.rsc) ◄───────────────┤      (diff → RouterOS cmds)
  ▼                                   ▼  applies: hotspot users, profiles,     └─ secrets: ROUTER_TOKEN,
  internet ✔ (rate‑limited,           ip‑binding bypass, removals, resets           OTP_SALT, ADMIN_EMAILS …
  time‑limited per plan)
```

**Division of labour**

| Concern | Handled by |
|---|---|
| Captive portal pages, auth, sessions, speed limits, expiry kick | Groove router (`/ip hotspot`) |
| Voucher / account / MAC provisioning, revokes, renewals, whitelist | Worker computes → router applies via sync |
| Plans, orders, vouchers, payments verification, branding, banners, audit | Worker + **D1** |
| Admin dashboard & customer "check activation" page | Worker static assets (`/admin.html`, `/verify.html`) |
| Admin sign-in OTP email | Worker → Resend free tier (or Telegram, or log) |
| Payments | Paystack / Flutterwave inline JS, **verified server-side** by the Worker |

Free-tier headroom: Workers 100 k req/day (one router sync ≈ 4 k/day), D1 5 M reads +
100 k writes/day, 5 GB — far above a neighbourhood-WiFi workload.

---

## 1. Files in this folder

| Path | Purpose |
|---|---|
| `wrangler.toml` | Worker config (D1 binding, static assets, vars) |
| `schema.sql` | D1 tables |
| `src/worker.js` | The whole backend (single file, no build step) |
| `public/admin.html` | Admin dashboard (served by the Worker) |
| `public/verify.html` | Customer "check activation" page (served by the Worker) |
| `hotspot/*.html, sx.css` | Captive-portal pages → upload to the **router** hotspot folder |
| `mikrotik/sx-config.rsc` | Router globals: Worker URL + router token |
| `mikrotik/sx-sync.rsc` | Router sync tick (fetch → import) |
| `mikrotik/sx-setup.rsc` | One-time router setup (scripts, scheduler, walled garden) |
| `tools/export-old.gs` | One-time migration from the old Apps Script spreadsheet |
| `.dev.vars` | **local dev only** secrets (never deployed) |

## 2. Deploy the Cloudflare side (~10 minutes)

Prereq: `npm i -g wrangler` (or use `npx`), and the `sornix.com.ng` zone on a Cloudflare
account (free plan is fine). If the zone is still elsewhere, move nameservers first —
Cloudflare free includes DNS, CDN, TLS and the Worker.

```bash
cd sornix-wifi
npm i -D wrangler                      # already done if you received this folder as-is
wrangler login

# 1) database
wrangler d1 create sornix-wifi         # copy the printed database_id into wrangler.toml
wrangler d1 execute sornix-wifi --file=schema.sql --remote

# 2) secrets
wrangler secret put ROUTER_TOKEN       # paste: openssl rand -hex 32
wrangler secret put OTP_SALT           # paste: openssl rand -hex 16
wrangler secret put ADMIN_EMAILS       # paste: sornixglobal@gmail.com (comma-separate extras)
# optional OTP delivery (otherwise codes print to `wrangler tail`):
wrangler secret put RESEND_API_KEY     # resend.com free: 100 mails/day, verify sornix.com.ng
#   or: wrangler secret put TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID

# 3) deploy
wrangler deploy

# 4) custom domain: Cloudflare dashboard → Workers → sornix-wifi → Settings → Domains
#    add:  isp.sornix.com.ng     (this serves /api, /admin.html, /verify.html)
```

Open `https://isp.sornix.com.ng/admin.html` → sign in with the email OTP → create your
plans, branding, bank details, gateway keys. Run **Dashboard → Run full check**.

> The old `wifi.sornix.com.ng` captive-portal hostname stays exactly as it is today
> (it points at the router, not at Cloudflare).

## 3. Deploy the router side

1. **Captive-portal pages** — Winbox → Files → `hotspot` folder: replace `login.html`,
   `alogin.html`, `error.html`, `logout.html`, `redirect.html`, `status.html`, `sx.css`
   with the files from `hotspot/` here. If your Worker domain is not
   `isp.sornix.com.ng`, edit the `API=` constant at the top of the `<script>` in
   `login.html` and `error.html` (and `VERIFY=` in `login.html`) first.
2. **Scripts** — upload `mikrotik/sx-config.rsc`, `sx-sync.rsc`, `sx-setup.rsc` to the
   router file root; edit `sx-config.rsc` (Worker URL + the same ROUTER_TOKEN secret).
3. Terminal: `/import file-name=sx-setup.rsc`
   → installs system scripts `sx-config` / `sx-sync`, a 25 s scheduler, and walled-garden
   entries for `isp.sornix.com.ng`, Paystack, Flutterwave and `wa.me`.
4. Watch `/log` for `sx-sync: ok`, and the admin dashboard **Router link** turning green
   within a minute.

RouterOS TLS note: the sync uses HTTPS to your Worker (valid public cert). On old
RouterOS v6 with an outdated certificate store, `/tool fetch` may fail with a certificate
error — either upgrade RouterOS / update the cert bundle, or as a last resort add
`check-certificate=no` to the fetch line in `sx-sync.rsc` (token in URL still protects it).

## 4. How the sync works (why the router stays in charge)

Every 25 s `sx-sync` on the Groove:
1. writes a report (`U` = sx hotspot users, `A` = active sessions, `B` = bypass MACs, `V` = version),
2. POSTs it to `/router/sync?token=…`,
3. `/import`s the reply, which contains **idempotent** RouterOS commands:
   profile upserts per plan (`rate-limit`, `shared-users`, `login-by=cookie,mac,http-pap`),
   guarded user adds (`limit-uptime` = plan validity), removals for revoked/deleted/expired
   entries, `ip-binding type=bypassed` for the MAC whitelist, and a remove+re-add pair
   ("renewal reset") when a **new order** supersedes the provisioned one.

Consequences you can rely on:
* voucher PIN / username+password / MAC logins are authenticated **locally on the router** —
  the cloud is never in the login path, so the portal works even mid-sync;
* a voucher flips to `used` (with the MAC) the first time a session appears;
* router credentials per identifier type: voucher → PIN/PIN, MAC → MAC/MAC (plus
  `mac-address` so it auto-logs-in), account → username/chosen password, plain
  device username → username/username (keep such names unguessable or prefer accounts);
* an order flips `approved → activated` when its user appears on the router, and
  `revoking → revoked` when it disappears;
* anything you create by hand on the router (no `comment="sx"`) is never touched.

## 5. Migrating the old data (one time)

1. Sign in to the new admin, browser console → `sessionStorage.getItem("sxt")` → copy.
2. In the **old** Apps Script project paste `tools/export-old.gs`, set `ADMIN_TOKEN`, run
   `exportAll()`. It maps sheets by name (settings/plans/orders/vouchers/whitelist/banners)
   and POSTs everything to `importData` (idempotent — safe to re-run).
3. Re-generate any *unused printed vouchers* you still hold stock of, or import them via
   the same dump (they keep working once synced).
4. When happy: remove the old scheduler/walled-garden entries for `script.google.com`
   from the router and retire the Apps Script project.

## 6. Operations cheatsheet

* New vouchers: admin → Vouchers → Generate → print/copy (live on router ≤ 25 s).
* Bank transfer: customer orders → WhatsApp template → admin **Approve** → auto-activates.
* Online payment: verifies against Paystack/Flutterwave server-side, auto-approves.
* Renewal: customer re-orders with the same username/MAC on the login page; the sync
   resets their `limit-uptime` on activation.
* Ban a device: admin → Whitelist is the *allow* list; to ban, revoke the order or delete
   the voucher (router removal follows within 25 s).
* Forgot what changed: admin → Activity log (every admin + automatic action).
* Health: admin → Dashboard → Run full check (D1, secrets, router heartbeat, gateway keys,
   OTP channel).

## 7. Local development / testing

```bash
npx wrangler d1 execute sornix-wifi --file=schema.sql --local
npx wrangler dev                       # reads .dev.vars; http://127.0.0.1:8787
# admin OTP codes print to the dev log; simulate a router:
curl -X POST --data "U TEST-CODE" "http://127.0.0.1:8787/router/sync?token=devtoken-…"
```

## 8. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Login page: "Could not load plans" | Walled garden missing the Worker domain — `sx-setup.rsc` adds it; or Worker not deployed / domain wrong |
| Dashboard: router offline | token mismatch, scheduler stopped, or TLS/cert-store issue on old ROS — check `/log` for `sx-sync:` lines |
| Approved order never activates | router offline (above); order stuck >10 min is flagged on the dashboard |
| Payment window never opens | walled garden missing `js.paystack.co` / `checkout.flutterwave.com` |
| OTP never arrives | no mail provider configured → code is in `wrangler tail` / Cloudflare Logs; add Resend or Telegram secret |
| Voucher "invalid" right after generate | wait one sync tick (≤25 s) |

## 9. SMS, Telegram activity alerts and live sessions (SmartSMS Solutions)

- **SMS provider:** SmartSMS Solutions API-x (`https://app.smartsmssolutions.com/io/api/client/v1/`).
  The API-x token and Sender ID are stored in D1 `settings` (`sms_token`, `sms_sender`) and edited in
  **admin → Payments → SMS notifications**. The token is never returned by the public `getSettings` action.
  - Send: `POST /sms/` (form-data: token, sender, to, message, type=0, routing=3).
  - Balance: `GET /balance/?token=…` — shown on **admin → Dashboard → SMS wallet** card (cached in
    `router_state.sms_balance`, refresh button re-queries; low warning under 50 units).
- **Customer SMS features (login page):**
  - "Request bank details by SMS (₦10 fee)" replaces the old WhatsApp bank-details request
    (`requestAccountSms`, rate-limited 5 per phone per 15 min, uses `settings.bank_details`).
    Requesting it marks the order `sms_notify`, which adds `settings.sms_fee` to the order total
    (enforced in `verifyPayment`/webhooks minimum-amount checks).
  - No receipt or activation SMS are sent; Telegram carries all business activity instead.
  - Template: `sms_bank_template` (admin-editable).
- **Telegram is the default channel for ALL activity:** new orders, payments, approvals, rejections,
  bulk approvals, router activations, voucher first-use, voucher batches, revokes and force-logouts are
  pushed to `TELEGRAM_CHAT_ID` via `TELEGRAM_BOT_TOKEN` (same secrets as admin OTP).
- **Live sessions + force logout:** the router reports logged-in hotspot sessions every sync tick
  (`router_state.active_sessions`); **admin → Active users** lists them and queues
  `/ip hotspot active remove` commands in `router_state.pending_cmds`, drained into the next sync RSC.

## 10. Live payment webhooks (Paystack + Flutterwave V3)

Online payments approve themselves twice over: the portal calls `verifyPayment` after checkout, and the
gateways also POST to live webhooks, so a payment still lands if the customer closes the payment window
or loses the captive-portal page mid-checkout.

- `POST /webhooks/paystack` — verifies `x-paystack-signature` (HMAC-SHA512 of the raw body with the
  Paystack **secret key** saved in admin → Payments). Handles `charge.success`.
- `POST /webhooks/flutterwave` — verifies the `verif-hash` header against `settings.flw_webhook_hash`
  (admin → Payments → "Live payment webhooks"; falls back to the Flutterwave secret key if the hash is
  blank), then **re-verifies the transaction against the live V3 API** before approving.
  Handles `charge.completed` with `data.status = "successful"`.
- Both funnels into one idempotent settle path (`markApproved`): state check, unique-reference check,
  minimum-amount check (plan price + SMS fee when opted in), then approve + Telegram alert + receipt SMS.
- Dashboard setup: Paystack → Settings → Webhooks → `https://isp.sornix.com.ng/webhooks/paystack`.
  Flutterwave → Settings → Webhooks → `https://isp.sornix.com.ng/webhooks/flutterwave`, and copy the
  secret hash you choose into admin → Payments.
- NOTE: online verification (client and webhook) requires the gateway SECRET keys saved in admin →
  Payments. With an empty secret key the portal hides "Pay online now" and webhooks answer 400.
