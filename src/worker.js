/**
 * Sornix Express WiFi - Cloudflare Worker (free plan) + D1 (free plan)
 * Drop-in replacement for the old Google Apps Script backend.
 *
 * Public API (same contract as the Apps Script web app, so existing pages work unchanged):
 *   GET  /api?action=getSettings | getPlans | checkUsername&u= | getOrderStatus&order_id=
 *   POST /api  {action:createOrder|verifyPayment|sendOtp|verifyOtp| admin actions with token}
 * Router API:
 *   POST /router/sync?token=ROUTER_TOKEN   body = router report, response = RouterOS .rsc commands
 * Static:
 *   /admin.html, /verify.html served from Workers Assets
 */

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Max-Age": "86400" };
const VOUCHER_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const MAC_RE = /^([0-9a-fA-F]{2}[:\-]?){5}[0-9a-fA-F]{2}$/;
const USER_RE = /^[A-Za-z0-9._-]{3,32}$/;
const VALIDITY_RE = /^\d+[smhdw]$/;
const RATE_RE = /^\d+[kMG]?\/\d+[kMG]?$/;

// ---------------------------------------------------------------- utils
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json", ...CORS } });
const err = (e, status = 200) => json({ ok: false, error: e }, status);
const nowIso = () => new Date().toISOString();
const nowMs = () => Date.now();

function hex(buf) { return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join(""); }
async function sha256(s) { return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))); }
function randHex(n) { const b = crypto.getRandomValues(new Uint8Array(n)); return [...b].map(x => x.toString(16).padStart(2, "0")).join(""); }
function safeEq(a, b) { const ea = new TextEncoder().encode(a), eb = new TextEncoder().encode(b); if (ea.length !== eb.length) return false; let d = 0; for (let i = 0; i < ea.length; i++) d |= ea[i] ^ eb[i]; return d === 0; }
function normMac(s) { const t = String(s || "").replace(/[^0-9a-fA-F]/g, ""); return t.length === 12 ? t.toUpperCase().match(/.{2}/g).join(":") : null; }
function validitySec(v) { const m = /^(\d+)([smhdw])$/.exec(String(v || "")); if (!m) return 86400; const n = +m[1]; return n * { s: 1, m: 60, h: 3600, d: 86400, w: 604800 }[m[2]]; }
function addValidity(iso, v) { return new Date(new Date(iso).getTime() + validitySec(v) * 1000).toISOString(); }
function orderId() { return "SX-" + randHex(4).toUpperCase(); }
function voucherCode() { let s = ""; const a = crypto.getRandomValues(new Uint8Array(12)); for (let i = 0; i < 12; i++) s += VOUCHER_ALPHABET[a[i] % VOUCHER_ALPHABET.length]; return s.slice(0, 4) + "-" + s.slice(4, 8) + "-" + s.slice(8); }
function esc(s) { return String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"'); }
function profileName(planId) { return "sx_" + String(planId).replace(/[^A-Za-z0-9_]/g, "_"); }
function normPhoneNg(s) { const d = String(s || "").replace(/\D/g, ""); if (d.startsWith("234") && d.length === 13) return d; if (d.startsWith("0") && d.length === 11) return "234" + d.slice(1); if (d.length === 10 && /^[89]/.test(d)) return "234" + d; return null; }
const SMS_FEE_DEF = 10;

// Telegram is the default notification channel for ALL business activity
async function notify(env, text) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  try {
    await fetch("https://api.telegram.org/bot" + env.TELEGRAM_BOT_TOKEN + "/sendMessage", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: String(text).slice(0, 3800) }) });
  } catch (e) { /* never break the request for a notification */ }
}

// SmartSMS Solutions API-x (https://developer.smartsmssolutions.com/)
async function sendSms(db, env, to, message, tag) {
  const s = await getSettings(db);
  const token = String(s.sms_token || "").trim();
  if (!token) { await audit(db, "sms", "skipped", (tag || "") + " no sms_token configured"); return { ok: false, error: "sms_not_configured" }; }
  const phone = normPhoneNg(to);
  if (!phone) return { ok: false, error: "invalid_phone" };
  const fd = new FormData();
  fd.append("token", token);
  fd.append("sender", String(s.sms_sender || "").trim() || "Sornix");
  fd.append("to", phone);
  fd.append("message", String(message).slice(0, 800));
  fd.append("type", "0");       // plain text
  fd.append("routing", "3");    // basic route, DND numbers via corporate
  let r = null;
  try { r = await fetch("https://app.smartsmssolutions.com/io/api/client/v1/sms/", { method: "POST", body: fd }).then(x => x.json()); }
  catch (e) { await audit(db, "sms", "error", (tag || "") + " " + phone + " network"); return { ok: false, error: "sms_gateway_error" }; }
  const okc = !!r && (r.code === 1000 || r.code === "1000");
  await audit(db, "sms", okc ? "sent" : "failed", (tag || "") + " " + phone + " units=" + (r && r.units_used != null ? r.units_used : "?") + (okc ? "" : " code=" + (r && r.code) + " " + String((r && r.comment) || "").slice(0, 80)));
  return okc ? { ok: true, units: r.units_used } : { ok: false, error: "sms_gateway_error" };
}

async function smsFee(db) { const s = await getSettings(db); const n = Number(s.sms_fee); return Number.isFinite(n) && n > 0 ? n : SMS_FEE_DEF; }

// account passwords are encrypted at rest (plaintext only ever leaves towards the router over HTTPS sync)
async function encKey(env) { const raw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode((env.OTP_SALT || "dev") + "|acct-enc")); return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]); }
async function encPass(env, pw) { const iv = crypto.getRandomValues(new Uint8Array(12)); const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await encKey(env), new TextEncoder().encode(pw)); const out = new Uint8Array(12 + ct.byteLength); out.set(iv, 0); out.set(new Uint8Array(ct), 12); return btoa(String.fromCharCode(...out)); }
async function decPass(env, b64) { try { const bin = Uint8Array.from(atob(b64), c => c.charCodeAt(0)); const iv = bin.slice(0, 12), ct = bin.slice(12); const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, await encKey(env), ct); return new TextDecoder().decode(pt); } catch { return null; } }

// Africa/Lagos day boundaries (WAT = UTC+1, no DST)
function lagosBoundaries() {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const g = t => +parts.find(p => p.type === t).value;
  const y = g("year"), m = g("month"), d = g("day");
  const dayStart = Date.UTC(y, m - 1, d) - 3600e3;
  const dow = new Date(dayStart).getUTCDay(); // 0=Sun
  const weekStart = dayStart - ((dow + 6) % 7) * 86400e3;
  const monthStart = Date.UTC(y, m - 1, 1) - 3600e3;
  return { dayStart, weekStart, monthStart };
}

// ---------------------------------------------------------------- payment webhooks (live)
async function hmacHex(secret, data, hash) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return hex(sig);
}

// idempotent settle shared by client verify and live webhooks
async function markApproved(db, env, o, gwName, ref, amountMajor, tag) {
  if (!o) return { ok: false, reason: "unknown_order" };
  if (o.status !== "requested") return { ok: false, reason: "already_" + o.status, already: true };
  const dup = await one(db, "SELECT 1 x FROM orders WHERE reference=?1 AND order_id!=?2", ref, o.order_id);
  if (dup) return { ok: false, reason: "reference_already_used" };
  const plan = await one(db, "SELECT * FROM plans WHERE plan_id=?1", o.plan_id);
  const minAmount = (plan ? plan.price : 0) + (o.sms_notify ? await smsFee(db) : 0);
  if (!(amountMajor >= minAmount)) return { ok: false, reason: "amount_too_low" };
  await run(db, "UPDATE orders SET status='approved',paid_via=?1,reference=?2,amount_paid=?3,paid_at=?4,updated_at=?4 WHERE order_id=?5 AND status='requested'",
    gwName, ref, amountMajor, nowIso(), o.order_id);
  await audit(db, gwName, tag || "webhookApprove", o.order_id + " ref " + ref);
  notify(env, "\u{1F4B0} " + (tag === "autoApprove" ? "Paid" : "Webhook") + ": \u20A6" + amountMajor + " via " + gwName + " - " + o.order_id + " (" + o.identifier + ")");
  return { ok: true };
}

async function handlePaystackWebhook(db, env, req) {
  const raw = await req.text();
  const sig = req.headers.get("x-paystack-signature") || "";
  const gw = await one(db, "SELECT * FROM gateways WHERE gateway='paystack'");
  if (!gw || !gw.secret_key) return new Response("gateway not configured", { status: 400 });
  const calc = await hmacHex(gw.secret_key, raw, "SHA-512");
  if (!safeEq(calc, sig)) return new Response("bad signature", { status: 400 });
  let b = {}; try { b = JSON.parse(raw); } catch { return new Response("bad json", { status: 400 }); }
  if (b.event !== "charge.success") return json({ ok: true, ignored: b.event });
  const d = b.data || {};
  const ref = String(d.reference || "");
  const oid = String((d.metadata && d.metadata.order_id) || ref.slice(0, 11)).toUpperCase();
  const o = await one(db, "SELECT * FROM orders WHERE order_id=?1", oid);
  const r = await markApproved(db, env, o, "paystack", ref, (d.amount || 0) / 100);
  return json({ ok: true, result: r.reason || "approved" });
}

async function handleFlutterwaveWebhook(db, env, req) {
  const raw = await req.text();
  const hash = req.headers.get("verif-hash") || "";
  const s = await getSettings(db);
  const gw = await one(db, "SELECT * FROM gateways WHERE gateway='flutterwave'");
  const expected = String(s.flw_webhook_hash || "").trim() || (gw && gw.secret_key) || "";
  if (!expected || !safeEq(expected, hash)) return new Response("bad verif-hash", { status: 400 });
  let b = {}; try { b = JSON.parse(raw); } catch { return new Response("bad json", { status: 400 }); }
  if (b.event !== "charge.completed") return json({ ok: true, ignored: b.event });
  const d = b.data || {};
  if (d.status !== "successful") return json({ ok: true, ignored: d.status });
  const ref = String(d.tx_ref || "");
  const oid = String((d.meta && d.meta.order_id) || ref.slice(0, 11)).toUpperCase();
  let amount = Number(d.amount || 0);
  // re-verify with the live API before trusting the event
  if (gw && gw.secret_key && d.id) {
    try {
      const v = await fetch("https://api.flutterwave.com/v3/transactions/" + encodeURIComponent(d.id) + "/verify", { headers: { Authorization: "Bearer " + gw.secret_key } }).then(x => x.json());
      if (!v || v.status !== "success" || !v.data || v.data.status !== "successful") return json({ ok: true, result: "verify_failed" });
      if (v.data.tx_ref !== ref) return json({ ok: true, result: "ref_mismatch" });
      amount = Number(v.data.amount || amount);
    } catch (e) { return json({ ok: true, result: "verify_unreachable" }); }
  }
  const o = await one(db, "SELECT * FROM orders WHERE order_id=?1", oid);
  const r = await markApproved(db, env, o, "flutterwave", ref, amount);
  return json({ ok: true, result: r.reason || "approved" });
}

// ---------------------------------------------------------------- db helpers
const q = (db, sql, ...args) => db.prepare(sql).bind(...args).all().then(r => r.results);
const one = (db, sql, ...args) => db.prepare(sql).bind(...args).first();
const run = (db, sql, ...args) => db.prepare(sql).bind(...args).run();

async function seed(db) {
  const n = await one(db, "SELECT COUNT(*) c FROM settings");
  if (n && n.c > 0) return;
  const defs = {
    site_name: "Sornix Express WiFi",
    site_description: "Fast, fair neighbourhood WiFi",
    welcome_text: "Sign in or buy a plan to get online.",
    support_phone: "", whatsapp_phone: "",
    outlets: "", bank_details: "",
    bank_template: "I want to buy {plan} (NGN {price}) for {identifier}. Please send bank transfer details.",
    sms_sender: "Sornix", sms_fee: "10", sms_token: "",
    sms_bank_template: "{site} bank transfer details: {bank_details} Quote your order ID when paying. Support: {support}",
    sms_receipt_template: "{site}: payment of NGN {amount} received for {plan}. Login: {identifier}, valid {validity}. Order {order}. Support: {support}",
    sms_active_template: "{site}: your {plan} plan is ACTIVE. Login: {identifier}, valid {validity}. Order {order}. Support: {support}",
    logo_url: ""
  };
  const stmts = Object.entries(defs).map(([k, v]) => db.prepare("INSERT OR IGNORE INTO settings(key,value) VALUES(?1,?2)").bind(k, v));
  stmts.push(db.prepare("INSERT OR IGNORE INTO gateways(gateway,enabled,public_key,secret_key) VALUES('paystack',0,'','')"));
  stmts.push(db.prepare("INSERT OR IGNORE INTO gateways(gateway,enabled,public_key,secret_key) VALUES('flutterwave',0,'','')"));
  stmts.push(db.prepare("INSERT OR IGNORE INTO gateways(gateway,enabled,public_key,secret_key) VALUES('monnify',0,'','')"));
  await db.batch(stmts);
}

async function getSettings(db) {
  const rows = await q(db, "SELECT key,value FROM settings");
  const s = {}; rows.forEach(r => s[r.key] = r.value);
  return s;
}

async function audit(db, who, action, detail) {
  await run(db, "INSERT INTO audit(at,who,action,detail) VALUES(?1,?2,?3,?4)", nowIso(), who, action, String(detail || "").slice(0, 400));
}

// ---------------------------------------------------------------- public actions
async function actGetSettings(db) {
  const settings = await getSettings(db);
  delete settings.sms_token; // never expose the SMS API token to the public portal
  const grows = await q(db, "SELECT gateway,enabled,public_key FROM gateways");
  const gateways = {}; grows.forEach(g => gateways[g.gateway] = { enabled: !!g.enabled, public_key: g.public_key || "" });
  const banners = await q(db, "SELECT id,image_url,link_url,sort FROM banners ORDER BY sort,id");
  return json({ ok: true, settings, gateways, banners });
}

async function actGetPlans(db) {
  const plans = await q(db, "SELECT plan_id,name,price,validity,rate_limit,shared_users,is_featured_on_login,active FROM plans WHERE active=1 ORDER BY price");
  plans.forEach(p => p.is_featured_on_login = !!p.is_featured_on_login);
  return json({ ok: true, plans });
}

async function actCheckUsername(db, u) {
  u = String(u || "").trim();
  if (!USER_RE.test(u)) return err("invalid_username");
  const a = await one(db, "SELECT 1 x FROM accounts WHERE username=?1", u);
  const o = await one(db, "SELECT 1 x FROM orders WHERE identifier=?1 AND id_type!='mac' AND status IN ('approved','activated')", u);
  return json({ ok: true, available: !a && !o });
}

async function actOrderStatus(db, id) {
  const o = await one(db, "SELECT status FROM orders WHERE order_id=?1", String(id || "").toUpperCase());
  if (!o) return err("not_found");
  return json({ ok: true, status: o.status });
}

async function actCreateOrder(db, b) {
  const plan = await one(db, "SELECT * FROM plans WHERE plan_id=?1 AND active=1", String(b.plan_id || ""));
  if (!plan) return err("invalid_plan");
  const phone = String(b.phone || "").trim();
  if (phone && !/^\+?[0-9]{7,15}$/.test(phone)) return err("invalid_phone");

  let idType, identifier;
  if (b.account_user !== undefined || b.account_pass !== undefined) {
    const u = String(b.account_user || "").trim(), p = String(b.account_pass || "");
    if (!USER_RE.test(u)) return err("invalid_username");
    if (p.length < 4 || p.length > 32) return err("invalid_password");
    const taken = await one(db, "SELECT 1 x FROM accounts WHERE username=?1", u);
    const taken2 = await one(db, "SELECT 1 x FROM orders WHERE identifier=?1 AND id_type!='mac' AND status IN ('approved','activated')", u);
    if (taken || taken2) return err("username_taken");
    await run(db, "INSERT INTO accounts(username,pass_enc,created_at) VALUES(?1,?2,?3)", u, await encPass(this.env, p), nowIso());
    idType = "account"; identifier = u;
  } else {
    const raw = String(b.identifier || "").trim();
    const mac = normMac(raw);
    if (mac) { idType = "mac"; identifier = mac; }
    else if (USER_RE.test(raw)) {
      const acc = await one(db, "SELECT 1 x FROM accounts WHERE username=?1", raw);
      if (acc) { idType = "account"; identifier = raw; }   // renewal of an existing account
      else { idType = "device"; identifier = raw; }
    } else return err("invalid_identifier");
  }

  const id = orderId();
  const smsNotify = !!b.sms_notify;
  const smsPhone = smsNotify ? normPhoneNg(phone) : null;
  if (smsNotify && !smsPhone) return err("invalid_phone");
  const fee = smsNotify ? await smsFee(db) : 0;
  await run(db, "INSERT INTO orders(order_id,plan_id,id_type,identifier,phone,status,created_at,updated_at,sms_notify,sms_phone) VALUES(?1,?2,?3,?4,?5,'requested',?6,?7,?8,?9)",
    id, plan.plan_id, idType, identifier, phone, nowIso(), nowIso(), smsNotify ? 1 : 0, smsPhone || "");
  await audit(db, "customer", "createOrder", id + " " + plan.plan_id + " " + idType + ":" + identifier + (smsNotify ? " +SMS" : ""));
  notify(this.env, "\u{1F6D2} New order " + id + " - " + plan.name + " \u20A6" + plan.price + (fee ? " +\u20A6" + fee + " SMS" : "") + " (" + idType + ": " + identifier + ")" + (phone ? " tel " + phone : ""));
  return json({ ok: true, order_id: id, identifier, sms_fee: fee, total: plan.price + fee });
}

async function actVerifyPayment(db, env, b) {
  const o = await one(db, "SELECT * FROM orders WHERE order_id=?1", String(b.order_id || "").toUpperCase());
  if (!o) return err("not_found");
  if (o.status !== "requested") return json({ ok: true, already: true, status: o.status });
  const gwName = String(b.gateway || "");
  const gw = await one(db, "SELECT * FROM gateways WHERE gateway=?1", gwName);
  if (!gw || !gw.enabled || !gw.secret_key) return err("gateway_disabled");
  const plan = await one(db, "SELECT * FROM plans WHERE plan_id=?1", o.plan_id);
  const minAmount = (plan ? plan.price : 0) + (o.sms_notify ? await smsFee(db) : 0);
  const ref = String(b.reference || "");
  if (!ref) return err("payment_not_verified");
  const dup = await one(db, "SELECT 1 x FROM orders WHERE reference=?1", ref);
  if (dup) return err("reference_already_used");
  let paidMajor = 0;

  if (gwName === "paystack") {
    let r; try { r = await fetch("https://api.paystack.co/transaction/verify/" + encodeURIComponent(ref), { headers: { Authorization: "Bearer " + gw.secret_key } }).then(x => x.json()); } catch { return err("payment_not_verified"); }
    if (!r || r.status !== true || !r.data) return err("payment_not_verified");
    if (r.data.status !== "success") return err("payment_not_verified");
    if (r.data.reference !== ref) return err("payment_not_verified");
    if ((r.data.amount || 0) < minAmount * 100) return err("amount_too_low");
    if (r.data.metadata && r.data.metadata.order_id && r.data.metadata.order_id !== o.order_id) return err("reference_already_used");
    paidMajor = (r.data.amount || 0) / 100;
  } else if (gwName === "flutterwave") {
    let r; try { r = await fetch("https://api.flutterwave.com/v3/transactions?tx_ref=" + encodeURIComponent(ref), { headers: { Authorization: "Bearer " + gw.secret_key } }).then(x => x.json()); } catch { return err("payment_not_verified"); }
    const tx = r && Array.isArray(r.data) && r.data[0];
    if (!tx || tx.status !== "successful") return err("payment_not_verified");
    if (tx.tx_ref !== ref) return err("payment_not_verified");
    if ((tx.amount || 0) < minAmount) return err("amount_too_low");
    paidMajor = Number(tx.amount || 0);
    const dup2 = await one(db, "SELECT 1 x FROM orders WHERE reference=?1", String(tx.id));
    if (dup2) return err("reference_already_used");
  } else return err("gateway_disabled");

  const res = await markApproved(db, env, o, gwName, ref, paidMajor, "autoApprove");
  if (!res.ok && !res.already) return err(res.reason || "payment_not_verified");
  return json({ ok: true, status: "approved" });
}

// ---------------------------------------------------------------- public SMS bank-details request
async function actRequestAccountSms(db, env, b) {
  const phone = normPhoneNg(b.phone);
  if (!phone) return err("invalid_phone");
  const key = "smsreq:" + phone;
  const row = await one(db, "SELECT * FROM otp WHERE email=?1", key);
  if (row && row.sends >= 5 && nowMs() - row.sent_at < 15 * 60e3) return err("too_many_attempts");
  const s = await getSettings(db);
  const bank = String(s.bank_details || "").trim().replace(/\s+/g, " ");
  if (!bank) return err("bank_not_set");
  const tpl = s.sms_bank_template || "{site} bank transfer details: {bank_details} Quote your order ID when paying. Support: {support}";
  const msg = tpl.replace(/\{bank_details\}/gi, bank).replace(/\{site\}/gi, s.site_name || "Sornix WiFi").replace(/\{support\}/gi, s.support_phone || s.site_name || "");
  const r = await sendSms(db, env, phone, msg, "bankreq");
  await run(db, "INSERT INTO otp(email,code_hash,expires_at,attempts,sends,sent_at) VALUES(?1,'',0,0,?2,?3) ON CONFLICT(email) DO UPDATE SET sends=sends+1,sent_at=?3", key, row ? row.sends + 1 : 1, nowMs());
  if (!r.ok) return err(r.error);
  return json({ ok: true });
}

// ---------------------------------------------------------------- admin auth
function adminEmails(env) { return String(env.ADMIN_EMAILS || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean); }

async function actSendOtp(db, env, b) {
  const email = String(b.email || "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ ok: true }); // do not leak the admin list
  const row = await one(db, "SELECT * FROM otp WHERE email=?1", email);
  if (row && row.sends >= 10 && nowMs() - row.sent_at < 15 * 60e3) return err("too_many_attempts");
  if (!adminEmails(env).includes(email)) return json({ ok: true });
  const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 10000).padStart(4, "0");
  await run(db, "INSERT INTO otp(email,code_hash,expires_at,attempts,sends,sent_at) VALUES(?1,?2,?3,0,?4,?5) ON CONFLICT(email) DO UPDATE SET code_hash=?2,expires_at=?3,attempts=0,sends=sends+1,sent_at=?5",
    email, await sha256(env.OTP_SALT + "|" + email + "|" + code), nowMs() + 5 * 60e3, row ? row.sends + 1 : 1, nowMs());
  await deliverOtp(env, email, code);
  return json({ ok: true });
}

async function deliverOtp(env, email, code) {
  const msg = "Sornix admin sign-in code: " + code + " (valid 5 minutes)";
  if (env.RESEND_API_KEY) {
    try {
      await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: "Bearer " + env.RESEND_API_KEY, "Content-Type": "application/json" }, body: JSON.stringify({ from: env.MAIL_FROM || "noreply@sornix.com.ng", to: [email], subject: "Sornix admin code " + code, text: msg }) });
      return;
    } catch (e) { /* fall through */ }
  }
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    try { await fetch("https://api.telegram.org/bot" + env.TELEGRAM_BOT_TOKEN + "/sendMessage", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: email + " - " + msg }) }); return; } catch (e) { /* fall through */ }
  }
  console.log("[OTP] " + email + " -> " + code); // bootstrap mode: read with `wrangler tail`
}

async function actVerifyOtp(db, env, b) {
  const email = String(b.email || "").trim().toLowerCase();
  const code = String(b.otp || "").trim();
  const row = await one(db, "SELECT * FROM otp WHERE email=?1", email);
  if (!row || row.expires_at < nowMs() || row.attempts >= 5) return err("unauthorized");
  if (!safeEq(row.code_hash, await sha256(env.OTP_SALT + "|" + email + "|" + code))) {
    await run(db, "UPDATE otp SET attempts=attempts+1 WHERE email=?1", email);
    return err("unauthorized");
  }
  await run(db, "DELETE FROM otp WHERE email=?1", email);
  const tok = randHex(32);
  await run(db, "INSERT INTO tokens(tok_hash,email,expires_at) VALUES(?1,?2,?3)", await sha256(env.OTP_SALT + "|tok|" + tok), email, nowMs() + 12 * 3600e3);
  await audit(db, email, "login", "otp verified");
  return json({ ok: true, token: tok });
}

async function authAdmin(db, env, token) {
  if (!token) return null;
  const row = await one(db, "SELECT email,expires_at FROM tokens WHERE tok_hash=?1", await sha256(env.OTP_SALT + "|tok|" + token));
  if (!row || row.expires_at < nowMs()) return null;
  return row.email;
}

// ---------------------------------------------------------------- admin actions
async function actAdminGetAll(db, env) {
  const settings = await getSettings(db);
  const plans = await q(db, "SELECT * FROM plans ORDER BY price");
  plans.forEach(p => { p.is_featured_on_login = !!p.is_featured_on_login; p.active = !!p.active; });
  const vouchers = await q(db, "SELECT * FROM vouchers ORDER BY created_at DESC LIMIT 500");
  const orders = await q(db, "SELECT * FROM orders ORDER BY created_at DESC LIMIT 500");
  const banners = await q(db, "SELECT * FROM banners ORDER BY sort,id");
  const whitelist = await q(db, "SELECT * FROM whitelist ORDER BY created_at DESC");
  const grows = await q(db, "SELECT gateway,enabled,public_key,secret_key FROM gateways ORDER BY gateway");
  const auditRows = await q(db, "SELECT at,who,action,detail FROM audit ORDER BY id DESC LIMIT 300");
  const rs = await one(db, "SELECT value FROM router_state WHERE key='last_seen'");
  const lastSeen = rs ? +rs.value : 0;
  let sessions = []; try { sessions = JSON.parse((await one(db, "SELECT value FROM router_state WHERE key='active_sessions'"))?.value || "[]"); } catch { sessions = []; }
  if (!Array.isArray(sessions)) sessions = [];
  let sms_balance = null; try { sms_balance = JSON.parse((await one(db, "SELECT value FROM router_state WHERE key='sms_balance'"))?.value || "null"); } catch { sms_balance = null; }
  const b = lagosBoundaries();
  const rev = async from => (await one(db, "SELECT COALESCE(SUM(COALESCE(o.amount_paid,p.price,0)),0) s FROM orders o LEFT JOIN plans p ON p.plan_id=o.plan_id WHERE o.paid_at IS NOT NULL AND o.paid_at>=?1", new Date(from).toISOString())).s;
  const stats = {
    pending: (await one(db, "SELECT COUNT(*) c FROM orders WHERE status='requested'")).c,
    awaiting_router: (await one(db, "SELECT COUNT(*) c FROM orders WHERE status='approved'")).c,
    active: (await one(db, "SELECT COUNT(*) c FROM orders WHERE status='activated'")).c,
    vouchers_unused: (await one(db, "SELECT COUNT(*) c FROM vouchers WHERE status='new'")).c,
    sessions: sessions.length,
    revenue_today: await rev(b.dayStart), revenue_week: await rev(b.weekStart), revenue_month: await rev(b.monthStart),
    router_online: lastSeen && nowMs() - lastSeen < 180e3,
    router_last_seen: lastSeen ? new Date(lastSeen).toISOString() : null,
    router_token_bad: !env.ROUTER_TOKEN || env.ROUTER_TOKEN.length < 16 || env.ROUTER_TOKEN.startsWith("AKfy"),
    salt_bad: !env.OTP_SALT || env.OTP_SALT.length < 8
  };
  return json({ ok: true, settings, plans, vouchers, orders, banners, whitelist, audit: auditRows, stats, sessions, sms_balance, gateways: grows.map(g => ({ gateway: g.gateway, enabled: !!g.enabled, public_key: g.public_key || "", secret_set: !!g.secret_key })) });
}

// live hotspot sessions + force logout (queued for the next router sync tick)
async function actAdminLogout(db, env, b, who) {
  const user = String(b.user || "").trim();
  if (!user || user.length > 64) return err("invalid_identifier");
  const cmd = '/ip hotspot active remove [find where user="' + esc(user) + '"]';
  const row = await one(db, "SELECT value FROM router_state WHERE key='pending_cmds'");
  let pc = []; try { pc = JSON.parse(row ? row.value : "[]"); } catch { pc = []; }
  if (!Array.isArray(pc)) pc = [];
  pc.push(cmd);
  await run(db, "INSERT INTO router_state(key,value) VALUES('pending_cmds',?1) ON CONFLICT(key) DO UPDATE SET value=?1", JSON.stringify(pc));
  await audit(db, who, "forceLogout", user);
  notify(env, "\u{1F44B} Force-logout queued for " + user + " by " + who);
  return json({ ok: true });
}

// SmartSMS wallet balance (units) - https://developer.smartsmssolutions.com/ (GET /balance/)
async function actAdminSmsBalance(db, env, b, who) {
  const s = await getSettings(db);
  const token = String(s.sms_token || "").trim();
  if (!token) return err("sms_not_configured");
  let bal = null;
  try { bal = await fetch("https://app.smartsmssolutions.com/io/api/client/v1/balance/?token=" + encodeURIComponent(token)).then(x => x.json()); }
  catch (e) { return err("sms_gateway_error"); }
  const n = Number(bal);
  if (!Number.isFinite(n)) return err("sms_gateway_error");
  await run(db, "INSERT INTO router_state(key,value) VALUES('sms_balance',?1) ON CONFLICT(key) DO UPDATE SET value=?1", JSON.stringify({ units: n, at: nowIso() }));
  await audit(db, who, "smsBalance", String(n));
  return json({ ok: true, units: n, at: nowIso() });
}

async function actAdminTestSms(db, env, b, who) {  const phone = String(b.phone || "");
  const s = await getSettings(db);
  const r = await sendSms(db, env, phone, (s.site_name || "Sornix WiFi") + ": test SMS - your SMS token works.", "test");
  await audit(db, who, "testSms", phone + " -> " + (r.ok ? "ok" : r.error));
  return r.ok ? json({ ok: true }) : err(r.error);
}

async function actUpdateOrder(db, env, b, who) {
  const o = await one(db, "SELECT * FROM orders WHERE order_id=?1", String(b.order_id || "").toUpperCase());
  if (!o) return err("not_found");
  const s = String(b.status || "");
  if (!["approved", "rejected"].includes(s)) return err("bad_status");
  if (o.status !== "requested") return err("bad_status");
  await run(db, "UPDATE orders SET status=?1,paid_at=COALESCE(paid_at,?2),updated_at=?2,paid_via=COALESCE(paid_via,'bank') WHERE order_id=?3", s, nowIso(), o.order_id);
  await audit(db, who, "updateOrder", o.order_id + " -> " + s);
  notify(env, (s === "approved" ? "\u2705 Approved " : "\u274C Rejected ") + o.order_id + " (" + o.identifier + ") by " + who);
  return json({ ok: true });
}

async function actBulkOrders(db, env, who) {
  const r = await run(db, "UPDATE orders SET status='approved',paid_via=COALESCE(paid_via,'bank'),paid_at=COALESCE(paid_at,?1),updated_at=?1 WHERE status='requested'", nowIso());
  const n = r.meta ? r.meta.changes : 0;
  await audit(db, who, "bulkApprove", n + " orders");
  notify(env, "\u2705 Bulk approved " + n + " orders by " + who);
  return json({ ok: true, count: n });
}

async function actRevoke(db, env, b, who) {
  const o = await one(db, "SELECT * FROM orders WHERE order_id=?1", String(b.order_id || "").toUpperCase());
  if (!o) return err("not_found");
  if (!["approved", "activated"].includes(o.status)) return err("bad_status");
  await run(db, "UPDATE orders SET status='revoking',updated_at=?1 WHERE order_id=?2", nowIso(), o.order_id);
  await audit(db, who, "revoke", o.order_id + " " + o.identifier);
  notify(env, "\u26D4 Revoke started " + o.order_id + " (" + o.identifier + ") by " + who);
  return json({ ok: true });
}

async function actMakeVouchers(db, env, b, who) {
  const plan = await one(db, "SELECT * FROM plans WHERE plan_id=?1 AND active=1", String(b.plan_id || ""));
  if (!plan) return err("invalid_plan");
  const count = Math.min(200, Math.max(1, Number(b.count) || 0));
  const batch = "B" + nowIso().slice(0, 10).replace(/-/g, "") + "-" + randHex(2).toUpperCase();
  const codes = [];
  for (let i = 0; i < count; i++) {
    let c = voucherCode(), guard = 0;
    while (await one(db, "SELECT 1 x FROM vouchers WHERE code=?1", c) && guard++ < 20) c = voucherCode();
    codes.push(c);
  }
  const stmts = codes.map(c => db.prepare("INSERT INTO vouchers(code,plan_id,status,batch,created_at) VALUES(?1,?2,'new',?3,?4)").bind(c, plan.plan_id, batch, nowIso()));
  await db.batch(stmts);
  await audit(db, who, "makeVouchers", count + " x " + plan.plan_id + " batch " + batch);
  notify(env, "\u{1F39F} " + codes.length + " vouchers created for " + plan.name + " (batch " + batch + ") by " + who);
  return json({ ok: true, codes, plan: plan.name, price: plan.price, batch, plan_id: plan.plan_id, validity: plan.validity, rate_limit: plan.rate_limit });
}

async function actUpdateVoucher(db, b, who) {
  if (String(b.op) !== "delete") return err("bad_op");
  const v = await one(db, "SELECT * FROM vouchers WHERE code=?1", String(b.code || "").toUpperCase());
  if (!v) return err("not_found");
  await run(db, "UPDATE vouchers SET status='deleted' WHERE code=?1", v.code);
  await audit(db, who, "deleteVoucher", v.code);
  return json({ ok: true });
}

async function actUpdatePlan(db, b, who) {
  const p = b.plan || {}, op = String(b.op);
  if (op === "delete") { await run(db, "DELETE FROM plans WHERE plan_id=?1", String(p.plan_id || "")); await audit(db, who, "deletePlan", p.plan_id); return json({ ok: true }); }
  if (op !== "save") return err("bad_op");
  const id = String(p.plan_id || "").trim();
  if (!/^[A-Za-z0-9_]{1,24}$/.test(id)) return err("invalid_plan");
  if (!String(p.name || "").trim()) return err("invalid_plan");
  if (!VALIDITY_RE.test(String(p.validity || ""))) return err("invalid_plan");
  if (!RATE_RE.test(String(p.rate_limit || ""))) return err("invalid_plan");
  await run(db, "INSERT INTO plans(plan_id,name,price,validity,rate_limit,shared_users,is_featured_on_login,active) VALUES(?1,?2,?3,?4,?5,?6,?7,?8) ON CONFLICT(plan_id) DO UPDATE SET name=?2,price=?3,validity=?4,rate_limit=?5,shared_users=?6,is_featured_on_login=?7,active=?8",
    id, String(p.name).trim(), Math.max(0, Math.round(Number(p.price) || 0)), String(p.validity), String(p.rate_limit), Math.max(1, Math.min(10, Number(p.shared_users) || 1)), p.is_featured_on_login ? 1 : 0, p.active ? 1 : 0);
  await audit(db, who, "savePlan", id);
  return json({ ok: true });
}

async function actSaveGateways(db, b, who) {
  const g = b.gateways || {};
  for (const name of ["paystack", "flutterwave", "monnify"]) {
    const x = g[name]; if (!x) continue;
    const cur = await one(db, "SELECT * FROM gateways WHERE gateway=?1", name);
    const sk = String(x.secret_key || "").trim();
    await run(db, "INSERT INTO gateways(gateway,enabled,public_key,secret_key) VALUES(?1,?2,?3,?4) ON CONFLICT(gateway) DO UPDATE SET enabled=?2,public_key=?3,secret_key=CASE WHEN ?4='' THEN secret_key ELSE ?4 END",
      name, x.enabled ? 1 : 0, String(x.public_key || "").trim(), sk);
    if (cur) { /* keep secret when blank handled in SQL */ }
  }
  await audit(db, who, "saveGateways", Object.keys(g).join(","));
  return json({ ok: true });
}

async function actSaveSettings(db, b, who) {
  const s = b.settings || {};
  const stmts = Object.entries(s).filter(([k]) => /^[a-z_]{2,40}$/.test(k)).map(([k, v]) => db.prepare("INSERT INTO settings(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=?2").bind(k, String(v ?? "")));
  if (stmts.length) await db.batch(stmts);
  await audit(db, who, "saveSettings", stmts.length + " keys");
  return json({ ok: true });
}

async function actBanners(db, b, who) {
  const x = b.banner || {}, op = String(b.op);
  if (op === "delete") { await run(db, "DELETE FROM banners WHERE id=?1", String(x.id || "")); await audit(db, who, "deleteBanner", x.id); return json({ ok: true }); }
  if (op !== "save") return err("bad_op");
  if (!/^https:\/\/./.test(String(x.image_url || ""))) return err("invalid_banner");
  const id = String(x.id || "") || randHex(4);
  await run(db, "INSERT INTO banners(id,image_url,link_url,sort) VALUES(?1,?2,?3,?4) ON CONFLICT(id) DO UPDATE SET image_url=?2,link_url=?3,sort=?4",
    id, String(x.image_url), String(x.link_url || ""), Number(x.sort) || 0);
  await audit(db, who, "saveBanner", id);
  return json({ ok: true });
}

async function actWhitelist(db, b, who) {
  const mac = normMac(b.mac);
  if (!mac) return err("invalid_identifier");
  if (String(b.op) === "remove") { await run(db, "DELETE FROM whitelist WHERE mac=?1", mac); await audit(db, who, "whitelistRemove", mac); return json({ ok: true }); }
  await run(db, "INSERT INTO whitelist(mac,note,created_at) VALUES(?1,?2,?3) ON CONFLICT(mac) DO UPDATE SET note=?2", mac, String(b.note || ""), nowIso());
  await audit(db, who, "whitelistAdd", mac);
  return json({ ok: true });
}

async function actImport(db, b, who) {
  // one-time migration helper: accepts the normalised dump produced by tools/export-old.gs
  const d = b.data || {}; const counts = {};
  const stmts = [];
  for (const [k, v] of Object.entries(d.settings || {})) stmts.push(db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES(?1,?2)").bind(k, String(v ?? "")));
  for (const p of d.plans || []) stmts.push(db.prepare("INSERT OR REPLACE INTO plans(plan_id,name,price,validity,rate_limit,shared_users,is_featured_on_login,active) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)")
    .bind(p.plan_id, p.name, Number(p.price) || 0, p.validity || "1d", p.rate_limit || "2M/5M", Number(p.shared_users) || 1, p.is_featured_on_login ? 1 : 0, p.active === false || p.active === 0 ? 0 : 1));
  for (const v of d.vouchers || []) stmts.push(db.prepare("INSERT OR IGNORE INTO vouchers(code,plan_id,status,used_by,batch,created_at,used_at,expires_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)")
    .bind(v.code, v.plan_id, v.status || "new", v.used_by || null, v.batch || null, v.created_at || nowIso(), v.used_at || null, v.expires_at || null));
  for (const o of d.orders || []) stmts.push(db.prepare("INSERT OR IGNORE INTO orders(order_id,plan_id,id_type,identifier,phone,status,paid_via,reference,amount_paid,created_at,updated_at,paid_at,activated_at,expires_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)")
    .bind(o.order_id, o.plan_id, o.id_type || "device", o.identifier, o.phone || "", o.status || "requested", o.paid_via || null, o.reference || null, o.amount_paid || null, o.created_at || nowIso(), o.updated_at || nowIso(), o.paid_at || null, o.activated_at || null, o.expires_at || null));
  for (const w of d.whitelist || []) stmts.push(db.prepare("INSERT OR IGNORE INTO whitelist(mac,note,created_at) VALUES(?1,?2,?3)").bind(w.mac, w.note || "", w.created_at || nowIso()));
  for (const x of d.banners || []) stmts.push(db.prepare("INSERT OR IGNORE INTO banners(id,image_url,link_url,sort) VALUES(?1,?2,?3,?4)").bind(x.id || randHex(4), x.image_url, x.link_url || "", Number(x.sort) || 0));
  for (let i = 0; i < stmts.length; i += 80) await db.batch(stmts.slice(i, i + 80));
  counts.statements = stmts.length;
  await audit(db, who, "importData", stmts.length + " rows");
  return json({ ok: true, counts });
}

async function actDiag(db, env) {
  const checks = [];
  try { await one(db, "SELECT 1 x"); checks.push({ name: "D1 database reachable", ok: true }); } catch (e) { checks.push({ name: "D1 database reachable", ok: false, note: String(e) }); }
  const s = await getSettings(db);
  checks.push({ name: "Settings seeded", ok: !!s.site_name });
  checks.push({ name: "OTP_SALT strong", ok: !!(env.OTP_SALT && env.OTP_SALT.length >= 8), note: "set a longer secret" });
  checks.push({ name: "ROUTER_TOKEN strong", ok: !!(env.ROUTER_TOKEN && env.ROUTER_TOKEN.length >= 16 && !env.ROUTER_TOKEN.startsWith("AKfy")), note: "generate 32+ random chars" });
  checks.push({ name: "Admin emails configured", ok: adminEmails(env).length > 0 });
  const rs = await one(db, "SELECT value FROM router_state WHERE key='last_seen'");
  const seen = rs ? +rs.value : 0;
  checks.push({ name: "Router syncing", ok: seen && nowMs() - seen < 180e3, note: seen ? "last seen " + new Date(seen).toISOString() : "never synced - install sx-sync on the Groove" });
  const gws = await q(db, "SELECT gateway,enabled,secret_key FROM gateways WHERE enabled=1");
  gws.forEach(g => checks.push({ name: g.gateway + " secret key saved", ok: !!g.secret_key }));
  checks.push({ name: "OTP delivery configured", ok: !!(env.RESEND_API_KEY || env.TELEGRAM_BOT_TOKEN), note: "until then codes print to wrangler tail / Logs" });
  checks.push({ name: "Telegram activity notifications", ok: !!(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID), note: "set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID secrets" });
  checks.push({ name: "SMS token configured", ok: !!String(s.sms_token || "").trim(), note: "admin > Payments > SMS section (SmartSMS Solutions API-x token)" });
  checks.push({ name: "Bank details for SMS requests", ok: !!String(s.bank_details || "").trim(), note: "admin > Branding and bank" });
  return json({ ok: true, checks });
}

// ---------------------------------------------------------------- router sync
function parseReport(text) {
  const users = [], active = [], bypass = []; let version = "", nline = "";
  String(text || "").split("\n").forEach(line => {
    const p = line.trim().split(/\s+/);
    if (p[0] === "U" && p[1]) users.push(p[1]);
    else if (p[0] === "A" && p[1]) active.push({ user: p[1], mac: normMac(p[2]) || p[2] });
    else if (p[0] === "B" && p[1]) bypass.push(normMac(p[1]) || p[1]);
    else if (p[0] === "V") version = p.slice(1).join(" ");
    else if (p[0] === "N") nline = p.slice(1).join(" ");
  });
  return { users, active, bypass, version, nline };
}

async function routerSync(db, env, req) {
  const url = new URL(req.url);
  const tok = url.searchParams.get("token") || req.headers.get("X-Router-Token") || "";
  if (!env.ROUTER_TOKEN || !safeEq(tok, env.ROUTER_TOKEN)) return new Response("# bad token\n", { status: 403, headers: { "Content-Type": "text/plain" } });
  const rep = parseReport(await req.text());
  const t = nowIso();
  await run(db, "INSERT INTO router_state(key,value) VALUES('last_seen',?1) ON CONFLICT(key) DO UPDATE SET value=?1", String(nowMs()));
  await run(db, "INSERT INTO router_state(key,value) VALUES('version',?1) ON CONFLICT(key) DO UPDATE SET value=?1", rep.version || "unknown");
  await run(db, "INSERT INTO router_state(key,value) VALUES('active_sessions',?1) ON CONFLICT(key) DO UPDATE SET value=?1", JSON.stringify(rep.active.map(a => ({ user: a.user, mac: a.mac, at: t }))));

  const haveU = new Set(rep.users), haveB = new Set(rep.bypass);

  // 1. voucher first-login detection (active session seen) -> used
  for (const a of rep.active) {
    const v = await one(db, "SELECT * FROM vouchers WHERE code=?1 AND status='new'", a.user);
    if (v) {
      const plan = await one(db, "SELECT validity FROM plans WHERE plan_id=?1", v.plan_id);
      await run(db, "UPDATE vouchers SET status='used',used_by=?1,used_at=?2,expires_at=?3 WHERE code=?4", a.mac, t, addValidity(t, plan ? plan.validity : "1d"), v.code);
      await audit(db, "router", "voucherUsed", v.code + " by " + a.mac);
      notify(env, "\u{1F39F} Voucher " + v.code + " just logged in (" + a.mac + ")");
    }
  }
  // 2. approved orders present on router -> activated
  for (const name of rep.users) {
    const o = await one(db, "SELECT * FROM orders WHERE identifier=?1 AND status='approved'", name);
    if (o) {
      const plan = await one(db, "SELECT validity FROM plans WHERE plan_id=?1", o.plan_id);
      await run(db, "UPDATE orders SET status='activated',activated_at=?1,expires_at=?2,updated_at=?1 WHERE order_id=?3", t, addValidity(t, plan ? plan.validity : "1d"), o.order_id);
      await audit(db, "router", "activated", o.order_id + " " + name);
      notify(env, "\u{1F7E2} Live on router: " + o.order_id + " (" + name + ")");
    }
  }
  // revoking orders whose router user is gone -> revoked
  for (const o of await q(db, "SELECT * FROM orders WHERE status='revoking'")) {
    if (!haveU.has(o.identifier)) { await run(db, "UPDATE orders SET status='revoked',updated_at=?1 WHERE order_id=?2", t, o.order_id); await audit(db, "router", "revoked", o.order_id); notify(env, "\u26D4 Revoked on router: " + o.order_id + " (" + o.identifier + ")"); }
  }

  // 3. desired state
  const desired = new Map(); // name -> {pw, plan, expires, mac}
  const plans = await q(db, "SELECT * FROM plans");
  const planById = {}; plans.forEach(p => planById[p.plan_id] = p);

  for (const v of await q(db, "SELECT * FROM vouchers WHERE status='new'")) {
    desired.set(v.code, { pw: v.code, plan: v.plan_id, expires: "", mac: null, src: "v:" + v.code });
  }
  for (const v of await q(db, "SELECT * FROM vouchers WHERE status='used'")) {
    if (haveU.has(v.code) && (!v.expires_at || v.expires_at > t)) desired.set(v.code, { pw: v.code, plan: v.plan_id, expires: v.expires_at || "", mac: null, src: "v:" + v.code });
  }
  for (const o of await q(db, "SELECT * FROM orders WHERE status IN ('approved','activated') ORDER BY created_at")) {
    if (o.expires_at && o.expires_at <= t) continue;
    let pw = o.identifier;
    if (o.id_type === "account") {
      const acc = await one(db, "SELECT pass_enc FROM accounts WHERE username=?1", o.identifier);
      if (!acc) continue;
      pw = await decPass(env, acc.pass_enc); if (pw == null) continue;
    }
    const expires = o.status === "approved" ? addValidity(t, planById[o.plan_id] ? planById[o.plan_id].validity : "1d") : (o.expires_at || "");
    desired.set(o.identifier, { pw, plan: o.plan_id, expires, mac: o.id_type === "mac" ? o.identifier : null, src: o.order_id });
  }

  const provRow = await one(db, "SELECT value FROM router_state WHERE key='prov'");
  let provRaw = {}; try { provRaw = JSON.parse(provRow ? provRow.value : "{}"); } catch { provRaw = {}; }
  const prov = {}; for (const [k, v] of Object.entries(provRaw)) prov[k] = (v && typeof v === "object") ? v : { c: null, e: String(v || "") };
  const newProv = {};

  // 4. build RSC
  const missingEarly = [...desired.keys()].filter(n => !haveU.has(n));
  const apiBase = env.PUBLIC_ORIGIN || "https://isp.sornix.com.ng";
  const out = ["# Sornix sync generated " + t + " (router " + (rep.version || "?") + ") - do not edit",
    "# self-update: keep the on-router sync script identical to the repo copy",
    '/file remove [find where name="sx-sync-new.rsc"]',
    ':do { /tool fetch url="' + apiBase + '/router/files/sx-sync.rsc?token=' + env.ROUTER_TOKEN + '" dst-path="sx-sync-new.rsc" as-value } on-error={ :log warning "sx-sync: self-update fetch failed" }',
    ':do { /system script set [find where name="sx-sync"] source=[/file get [find where name="sx-sync-new.rsc"] contents] } on-error={ :log warning "sx-sync: self-update skipped" }'];
  const beaconRaw = (m) => '/tool fetch url="' + apiBase + '/router/diag?token=' + env.ROUTER_TOKEN + '&m=' + m + '" http-method=post http-data="b" output=none as-value';
  const beacon = (m) => ':do { ' + beaconRaw(m) + ' } on-error={ }';
  const guarded = (cmd, tag) => ':do { ' + cmd + '; ' + beaconRaw("OK-" + tag) + ' } on-error={ ' + beaconRaw("ERR-" + tag) + ' }';
  const beaconRawDyn = (expr) => '/tool fetch url=("' + apiBase + '/router/diag?token=' + env.ROUTER_TOKEN + '&m=" . (' + expr + ')) http-method=post http-data="b" output=none as-value';
  const beaconRawBody = (expr) => '/tool fetch url="' + apiBase + '/router/diag?token=' + env.ROUTER_TOKEN + '" http-method=post http-data=(' + expr + ') output=none as-value';
  const dynEarly = (expr) => ':do { ' + beaconRawDyn(expr) + ' } on-error={ }';
  out.push(beacon("ck-selfupdate"));
  if (missingEarly.length) {
    // state + license read-back FIRST, before anything can abort the import
    out.push(':do { ' + beaconRawDyn('"lic-" . [/system license get level] . " board-" . [/system resource get board-name] . " nusers-" . [/ip hotspot user print count-only] . " nprof-" . [/ip hotspot user profile print count-only]') + ' } on-error={ }');
    out.push(':local la ""');
    out.push(':foreach i in=[/log find] do={ :if ([:len $la] < 700) do={ :set $la (([/log get $i topics] . ": " . [/log get $i message] . " << ") . $la) } }');
    out.push(':do { ' + beaconRawBody('"LOGTAIL: " . $la') + ' } on-error={ }');
  }
  // queued one-shot admin commands (force logouts etc.)
  const pcRow = await one(db, "SELECT value FROM router_state WHERE key='pending_cmds'");
  let pc = []; try { pc = JSON.parse(pcRow ? pcRow.value : "[]"); } catch { pc = []; }
  if (Array.isArray(pc) && pc.length) {
    out.push("# queued admin commands");
    pc.forEach(c => out.push(':do { ' + c + ' } on-error={ }'));
    await run(db, "DELETE FROM router_state WHERE key='pending_cmds'");
  }
  const neededProfiles = new Set();
  desired.forEach(d => neededProfiles.add(d.plan));
  for (const pid of neededProfiles) {
    const p = planById[pid]; if (!p) continue;
    const pn = profileName(pid);
    // NOTE: this RouterOS build rejects some properties on profile add (comment= hard-errors, verified by
    // probes) - so: minimal add, then per-property fault-tolerant sets; unsupported ones are skipped silently
    out.push(':do { /ip hotspot user profile add name="' + pn + '" } on-error={ }');
    out.push(':do { /ip hotspot user profile set [find where name="' + pn + '"] rate-limit="' + esc(p.rate_limit) + '" } on-error={ }');
    out.push(':do { /ip hotspot user profile set [find where name="' + pn + '"] shared-users=' + (p.shared_users || 1) + " } on-error={ }");
    out.push(':do { /ip hotspot user profile set [find where name="' + pn + '"] login-by=cookie,mac,http-pap } on-error={ }');
    out.push(dynEarly('"profexists-' + pn + '-" . [:len [/ip hotspot user profile find where name="' + pn + '"]]'));
  }
  out.push(beacon("ck-profiles"));
  for (const [name, d] of desired) {
    const pn = profileName(d.plan);
    const p = planById[d.plan];
    const lim = p ? p.validity : "1d";
    const reset = haveU.has(name) && prov[name] && prov[name].c !== d.src;
    // NOTE: menu commands inside :if/:foreach do={ } are silently dropped by this firmware's
    // import parser (verified by probes) - only bare commands inside :do/on-error execute.
    if (reset) out.push(':do { /ip hotspot user remove [find where name="' + esc(name) + '"] } on-error={ }  # renewal reset');
    if (!haveU.has(name) || reset) {
      // adopt same-name users that lack the sx tag (invisible to the report otherwise)
      out.push(':do { /ip hotspot user set [find where name="' + esc(name) + '" and comment!="sx"] comment="sx" profile="' + pn + '" limit-uptime=' + lim + (d.mac ? ' mac-address="' + esc(d.mac) + '"' : "") + ' password="' + esc(d.pw) + '" } on-error={ }');
      out.push(':do { /ip hotspot user add name="' + esc(name) + '" password="' + esc(d.pw) + '" profile="' + pn + '" limit-uptime=' + lim + (d.mac ? ' mac-address="' + esc(d.mac) + '"' : "") + ' comment="sx" } on-error={ ' + beaconRaw("ERR-uadd-" + encodeURIComponent(name)) + ' }');
    }
    newProv[name] = { c: d.src, e: d.expires || "" };
    if (reset && prov[name]) prov[name] = newProv[name];
  }
  out.push(beacon("ck-users"));
  for (const name of rep.users) {
    if (!desired.has(name) && !name.startsWith("DIAG")) out.push(':do { /ip hotspot user remove [find where name="' + esc(name) + '"] } on-error={ }');
  }
  // whitelist -> hotspot ip-binding bypassed
  const wl = await q(db, "SELECT mac FROM whitelist");
  const wantB = new Set(wl.map(w => w.mac));
  for (const mac of wantB) if (!haveB.has(mac)) out.push(':do { /ip hotspot ip-binding add mac-address="' + mac + '" type=bypassed comment="sx" } on-error={ }');
  for (const mac of rep.bypass) if (!wantB.has(mac)) out.push(':do { /ip hotspot ip-binding remove [find where comment="sx" and mac-address="' + mac + '"] } on-error={ }');

  // state read-back probes while any desired user is missing on the router
  const missing = missingEarly;
  if (missing.length) {
    const dyn = (expr) => ':do { ' + beaconRawDyn(expr) + ' } on-error={ }';
    out.push(':local pn2 ""');
    out.push(':foreach i in=[/ip hotspot user profile find] do={ :set $pn2 ($pn2 . [/ip hotspot user profile get $i name] . ",") }');
    out.push(dyn('"profs-" . $pn2'));
    out.push(dyn('"usercount-" . [/ip hotspot user print count-only]'));
  } else {
    // healthy: clean up every diagnostic artifact
    for (const name of rep.users) if (name.startsWith("DIAG")) out.push(':do { /ip hotspot user remove [find where name="' + esc(name) + '"] } on-error={ }');
    out.push(':do { /ip hotspot user profile remove [find where name~"sx_p"] } on-error={ }');
    out.push(':do { /ip hotspot user profile remove [find where name="sx_diag"] } on-error={ }');
    out.push(':do { /ip hotspot user profile remove [find where name~"sx_t"] } on-error={ }');
  }
  out.push(beacon("ck-end"));

  await run(db, "INSERT INTO router_state(key,value) VALUES('prov',?1) ON CONFLICT(key) DO UPDATE SET value=?1", JSON.stringify(newProv));
  await run(db, "INSERT INTO router_state(key,value) VALUES('lastU',?1) ON CONFLICT(key) DO UPDATE SET value=?1", JSON.stringify(rep.users));
  await run(db, "INSERT INTO router_state(key,value) VALUES('allU',?1) ON CONFLICT(key) DO UPDATE SET value=?1", rep.nline || "");
  const rscText = out.join("\n") + "\n";
  await run(db, "INSERT INTO router_state(key,value) VALUES('pending_rsc',?1) ON CONFLICT(key) DO UPDATE SET value=?1", rscText);
  await run(db, "INSERT INTO router_state(key,value) VALUES('counts',?1) ON CONFLICT(key) DO UPDATE SET value=?1", JSON.stringify({ users: rep.users.length, active: rep.active.length, want: desired.size, at: t }));
  return new Response(rscText, { headers: { "Content-Type": "text/plain", ...CORS } });
}

// ---------------------------------------------------------------- router
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const path = url.pathname.replace(/\/+$/, "") || "/";

    try {
      if (path === "/webhooks/paystack" && req.method === "POST") return await handlePaystackWebhook(env.DB, env, req);
      if (path === "/webhooks/flutterwave" && req.method === "POST") return await handleFlutterwaveWebhook(env.DB, env, req);
      if (path === "/router/files/" || path.startsWith("/router/files/")) {
        // token-gated file delivery THROUGH the worker (immune to edge asset propagation lag)
        const tok = url.searchParams.get("token") || "";
        if (!env.ROUTER_TOKEN || !safeEq(tok, env.ROUTER_TOKEN)) return new Response("bad token\n", { status: 403, headers: { "Content-Type": "text/plain" } });
        const name = decodeURIComponent(path.split("/").slice(3).join("/") || url.searchParams.get("name") || "");
        const map = {
          "login.html": "/hotspot/login.html", "alogin.html": "/hotspot/alogin.html", "error.html": "/hotspot/error.html",
          "logout.html": "/hotspot/logout.html", "redirect.html": "/hotspot/redirect.html", "status.html": "/hotspot/status.html",
          "sx.css": "/hotspot/sx.css", "sx-sync.rsc": "/mikrotik/sx-sync.rsc"
        };
        const ap = map[name];
        if (!ap) return new Response("unknown file\n", { status: 404, headers: { "Content-Type": "text/plain" } });
        const r = await env.ASSETS.fetch(new Request("https://assets.internal" + ap));
        if (!r.ok) return new Response("asset missing\n", { status: 404, headers: { "Content-Type": "text/plain" } });
        // octet-stream: stops Cloudflare edge from injecting the analytics beacon script into text/html,
        // which corrupted the router's on-flash copies (+367 bytes per page)
        return new Response(r.body, { headers: { "Content-Type": "application/octet-stream", "Cache-Control": "no-store", ...CORS } });
      }
      if (path === "/router/diag") {
        // checkpoint beacons from the imported RSC on the router
        const tok = url.searchParams.get("token") || "";
        if (!env.ROUTER_TOKEN || !safeEq(tok, env.ROUTER_TOKEN)) return new Response("bad token", { status: 403 });
        const m = (url.searchParams.get("m") || "").slice(0, 900) || ((await req.text()) || "?").slice(0, 900);
        const prevRow = await one(env.DB, "SELECT value FROM router_state WHERE key='rdiag'");
        let arr = []; try { arr = JSON.parse(prevRow ? prevRow.value : "[]"); } catch { arr = []; }
        if (!Array.isArray(arr)) arr = [];
        arr.push({ m, at: new Date().toISOString().slice(11, 19) });
        if (arr.length > 40) arr = arr.slice(-40);
        await run(env.DB, "INSERT INTO router_state(key,value) VALUES('rdiag',?1) ON CONFLICT(key) DO UPDATE SET value=?1", JSON.stringify(arr));
        return new Response("ok");
      }
      if (path === "/router/commands") {
        // download channel: returns the RSC computed for the last received report
        const tok = url.searchParams.get("token") || "";
        if (!env.ROUTER_TOKEN || !safeEq(tok, env.ROUTER_TOKEN)) return new Response("# bad token\n", { status: 403, headers: { "Content-Type": "text/plain" } });
        const row = await one(env.DB, "SELECT value FROM router_state WHERE key='pending_rsc'");
        return new Response(row ? row.value : "# no commands yet\n", { headers: { "Content-Type": "text/plain", "Cache-Control": "no-store", ...CORS } });
      }
      if (path === "/router/bootstrap") {
        // one-time installer: token-gated RSC that pulls pages + sync script from this Worker
        const tok = url.searchParams.get("token") || "";
        if (!env.ROUTER_TOKEN || !safeEq(tok, env.ROUTER_TOKEN)) return new Response("# bad token\n", { status: 403, headers: { "Content-Type": "text/plain" } });
        const api = env.PUBLIC_ORIGIN || "https://isp.sornix.com.ng";
        const host = new URL(api).host;
        const rsc = [
          "# Sornix clean-slate installer v3 - generated " + nowIso(),
          "# 1) remove every trace of old + broken sornix/sx objects",
          '/system scheduler remove [find where on-event~"sornix"]',
          '/system scheduler remove [find where name="sx-sync"]',
          '/system script remove [find where name="sornix"]',
          '/system script remove [find where name="sx-config"]',
          '/system script remove [find where name="sx-sync"]',
          '/ip hotspot walled-garden remove [find where comment="sx"]',
          ':foreach f in={sxboot.rsc;sxcmd.rsc;sxrep.txt;sx-sync.rsc;sx-sync-new.rsc;t1.txt;t2.txt;t3.txt;t4.txt;t5.txt;t6.txt;hotspot/t6.html} do={ /file remove [find where name=$f] }',
          "# 2) globals",
          ':global sxApi "' + api + '"',
          ':global sxTok "' + env.ROUTER_TOKEN + '"',
          ':global sxTick 0',
          ':global sxBusy "0"',
          ':global sxBusyTick 0',
          "# 3) sx-config script",
          '/system script add name="sx-config" source=":global sxApi \\"' + api + '\\"\\n:global sxTok \\"' + env.ROUTER_TOKEN + '\\"\\n:global sxTick 0\\n:global sxBusy \\"0\\"\\n:global sxBusyTick 0"',
          "# 4) fresh sync script (v7 fetch semantics)",
          ':do { /tool fetch url="' + api + '/router/files/sx-sync.rsc?token=' + env.ROUTER_TOKEN + '" dst-path="sx-sync-new.rsc" as-value; :log info "sx-bootstrap: got sx-sync" } on-error={ :log error "sx-bootstrap: FAILED sx-sync.rsc" }',
          '/system script add name="sx-sync" source=[/file get [find where name="sx-sync-new.rsc"] contents]',
          "# 5) scheduler",
          '/system scheduler add name="sx-sync" interval=25s start-time=startup on-event="/system script run sx-config\\n/system script run sx-sync"',
          "# 6) walled garden (deduped)",
          '/ip hotspot walled-garden add dst-host="' + host + '" comment="sx"',
          '/ip hotspot walled-garden add dst-host="js.paystack.co" comment="sx"',
          '/ip hotspot walled-garden add dst-host="api.paystack.co" comment="sx"',
          '/ip hotspot walled-garden add dst-host="checkout.flutterwave.com" comment="sx"',
          '/ip hotspot walled-garden add dst-host="api.flutterwave.com" comment="sx"',
          '/ip hotspot walled-garden add dst-host="wa.me" comment="sx"',
          "# 7) captive-portal pages (literal lines, no loops)",
          ':do { /tool fetch url="' + api + '/router/files/login.html?token=' + env.ROUTER_TOKEN + '" dst-path="hotspot/login.html" as-value; :log info "sx-bootstrap: got login.html" } on-error={ :log error "sx-bootstrap: FAILED login.html" }',
          ':do { /tool fetch url="' + api + '/router/files/alogin.html?token=' + env.ROUTER_TOKEN + '" dst-path="hotspot/alogin.html" as-value; :log info "sx-bootstrap: got alogin.html" } on-error={ :log error "sx-bootstrap: FAILED alogin.html" }',
          ':do { /tool fetch url="' + api + '/router/files/error.html?token=' + env.ROUTER_TOKEN + '" dst-path="hotspot/error.html" as-value; :log info "sx-bootstrap: got error.html" } on-error={ :log error "sx-bootstrap: FAILED error.html" }',
          ':do { /tool fetch url="' + api + '/router/files/logout.html?token=' + env.ROUTER_TOKEN + '" dst-path="hotspot/logout.html" as-value; :log info "sx-bootstrap: got logout.html" } on-error={ :log error "sx-bootstrap: FAILED logout.html" }',
          ':do { /tool fetch url="' + api + '/router/files/redirect.html?token=' + env.ROUTER_TOKEN + '" dst-path="hotspot/redirect.html" as-value; :log info "sx-bootstrap: got redirect.html" } on-error={ :log error "sx-bootstrap: FAILED redirect.html" }',
          ':do { /tool fetch url="' + api + '/router/files/status.html?token=' + env.ROUTER_TOKEN + '" dst-path="hotspot/status.html" as-value; :log info "sx-bootstrap: got status.html" } on-error={ :log error "sx-bootstrap: FAILED status.html" }',
          ':do { /tool fetch url="' + api + '/router/files/sx.css?token=' + env.ROUTER_TOKEN + '" dst-path="hotspot/sx.css" as-value; :log info "sx-bootstrap: got sx.css" } on-error={ :log error "sx-bootstrap: FAILED sx.css" }',
          "# 8) first run",
          "/system script run sx-config",
          "/system script run sx-sync",
          ':log info "sx-bootstrap: done"',
          ""
        ].join("\n");
        return new Response(rsc, { headers: { "Content-Type": "text/plain", ...CORS } });
      }
      if (path === "/router/sync" && req.method === "POST") return await routerSync(env.DB, env, req);
      if (path === "/healthz") return json({ ok: true, ts: nowIso() });

      const isApi = path === "/api" || path === "/";
      if (isApi) {
        await seed(env.DB);
        if (req.method === "POST") {
          let b = {}; try { b = JSON.parse(await req.text() || "{}"); } catch { return err("bad_json"); }
          const action = String(b.action || "");
          // public
          if (action === "createOrder") return await actCreateOrder.call({ env }, env.DB, b);
          if (action === "verifyPayment") return await actVerifyPayment(env.DB, env, b);
          if (action === "requestAccountSms") return await actRequestAccountSms(env.DB, env, b);
          if (action === "sendOtp") return await actSendOtp(env.DB, env, b);
          if (action === "verifyOtp") return await actVerifyOtp(env.DB, env, b);
          // admin
          if (/^admin|^update|^bulk|^revoke|^make|^save/.test(action)) {
            const who = await authAdmin(env.DB, env, b.token);
            if (!who) return err("unauthorized", 200);
            switch (action) {
              case "adminGetAll": return await actAdminGetAll(env.DB, env);
              case "adminDiag": return await actDiag(env.DB, env);
              case "updateOrder": return await actUpdateOrder(env.DB, env, b, who);
              case "bulkOrders": return await actBulkOrders(env.DB, env, who);
              case "revokeAccess": return await actRevoke(env.DB, env, b, who);
              case "makeVouchers": return await actMakeVouchers(env.DB, env, b, who);
              case "adminLogout": return await actAdminLogout(env.DB, env, b, who);
              case "adminTestSms": return await actAdminTestSms(env.DB, env, b, who);
              case "adminSmsBalance": return await actAdminSmsBalance(env.DB, env, b, who);
              case "updateVoucher": return await actUpdateVoucher(env.DB, b, who);
              case "updatePlan": return await actUpdatePlan(env.DB, b, who);
              case "saveGatewayKeys": return await actSaveGateways(env.DB, b, who);
              case "saveSettings": return await actSaveSettings(env.DB, b, who);
              case "updateBanners": return await actBanners(env.DB, b, who);
              case "updateWhitelist": return await actWhitelist(env.DB, b, who);
              case "importData": return await actImport(env.DB, b, who);
            }
            return err("unknown_action");
          }
          return err("unknown_action");
        }
        // GET
        const action = url.searchParams.get("action");
        if (!action && path === "/") return new Response(null, { status: 302, headers: { Location: "/admin.html", ...CORS } });
        if (!action) return err("unknown_action");
        if (action === "getSettings") return await actGetSettings(env.DB);
        if (action === "getPlans") return await actGetPlans(env.DB);
        if (action === "checkUsername") return await actCheckUsername(env.DB, url.searchParams.get("u"));
        if (action === "getOrderStatus") return await actOrderStatus(env.DB, url.searchParams.get("order_id"));
        return err("unknown_action");
      }
      // static assets (admin.html, verify.html)
      return await env.ASSETS.fetch(req);
    } catch (e) {
      console.error("worker error", e && e.stack || e);
      return err("internal_error", 500);
    }
  }
};
