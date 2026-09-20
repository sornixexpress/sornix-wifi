# Prompt for Cloudflare AI (dashboard assistant) — deploy this repo

Copy everything between the lines below and paste it to the Cloudflare AI assistant
(Dashboard → Workers & Pages → AI / or the repo's "Deploy with AI" flow) with the
GitHub repo `sornixexpress/sornix-wifi` connected. Everything stays on the FREE plan.

--------------------------------------------------------------------------------

Deploy the production backend of my WiFi ISP project from my connected GitHub repo
`sornixexpress/sornix-wifi`, branch `main`. Use ONLY free-plan resources (Workers free
tier, D1 free tier). Do not create KV, R2, Queues, Cron Triggers, or any paid add-on.
Follow these steps exactly, in order:

1. DATABASE — Create a D1 database named `sornix-wifi` (skip if it already exists).
   Then execute against it the full SQL contained in the repo file `schema.sql`
   (it is idempotent: CREATE TABLE IF NOT EXISTS). Afterwards run
   `SELECT name FROM sqlite_master WHERE type='table'` and confirm these 12 tables
   exist: settings, plans, accounts, orders, vouchers, whitelist, banners, gateways,
   audit, otp, tokens, router_state.

2. WORKER — Create (or update) a Worker named `sornix-wifi` with:
   - entrypoint: `src/worker.js` — plain ES module, NO build/bundle step needed;
   - compatibility_date: `2025-09-01` or newer;
   - Workers Assets: serve the repo directory `public/` with binding name `ASSETS`
     and html_handling = "none" (the exact URLs /admin.html and /verify.html must
     stay directly addressable, no clean-URL redirects);
   - D1 binding: database `sornix-wifi` bound as `DB`;
   - plain vars: PUBLIC_ORIGIN="https://isp.sornix.com.ng",
     TIMEZONE="Africa/Lagos", MAIL_FROM="Sornix WiFi <noreply@sornix.com.ng>".

3. SECRETS — set these Worker secrets (never print them except where instructed):
   - ROUTER_TOKEN: generate 64 random hex characters yourself. Show it ONCE in the
     final report — I must paste it into my MikroTik router config;
   - OTP_SALT: generate 32 random hex characters;
   - ADMIN_EMAILS: sornixglobal@gmail.com
   - Do NOT set RESEND_API_KEY, TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID (leave unset;
     admin OTP codes will print to Worker logs, which is intended for now).

4. DOMAIN — If the zone `sornix.com.ng` exists in this Cloudflare account, add the
   custom domain `isp.sornix.com.ng` to the Worker (SSL enabled). If the zone is not
   here, skip this step and report the workers.dev route instead.

5. VERIFY LIVE — after deploy, run these checks and report each result:
   - GET /healthz  → expect {"ok":true,...}
   - GET /api?action=getSettings → expect JSON ok:true with settings.site_name
   - GET /api?action=getPlans → expect JSON ok:true with plans array
   - GET /admin.html → HTTP 200, content-type text/html
   - GET /verify.html → HTTP 200
   - POST /api with body {"action":"sendOtp","email":"sornixglobal@gmail.com"}
     (Content-Type: text/plain) → expect {"ok":true}; then read the 4-digit code from
     the Worker logs (line starting with "[OTP]") and include it in the report so I
     can sign in to the admin dashboard for the first time.

6. DO NOT — modify anything router/MikroTik related, do not enable Workers Builds/CI
   yet, and do not edit repo files. The wrangler.toml in the repo is for local
   development; your API-level configuration is the source of truth for now.

7. FINAL REPORT — give me: (a) the Worker route URL(s) and custom domain status,
   (b) the D1 database_id (I need it to update wrangler.toml for future CI deploys),
   (c) the ROUTER_TOKEN value from step 3, (d) the OTP code from step 5,
   (e) a pass/fail line for each check in steps 1, 4 and 5.

--------------------------------------------------------------------------------

## After the AI finishes

1. Paste the reported **database_id** into `wrangler.toml`
   (`database_id = "..."`) and push — then Workers Builds/CI can take over.
2. Paste the reported **ROUTER_TOKEN** into `mikrotik/sx-config.rsc` on the Groove
   router, then `/import file-name=sx-setup.rsc` (see README §3).
3. Sign in at `https://isp.sornix.com.ng/admin.html` with the emailed/logged OTP code.
