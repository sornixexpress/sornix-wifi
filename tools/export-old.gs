/**
 * ONE-TIME migration: run inside the OLD Google Apps Script project.
 * Reads the old spreadsheet (whatever the sheet/tab names are) and pushes a
 * normalised dump into the new Cloudflare Worker (D1) via admin action importData.
 *
 * Steps:
 *  1. Deploy the Worker, open https://isp.sornix.com.ng/admin.html, sign in with OTP.
 *  2. In the browser console copy your session token:  sessionStorage.getItem("sxt")
 *  3. Paste it into ADMIN_TOKEN below, run exportAll() from the Apps Script editor.
 *  4. Check counts in the new admin dashboard. Re-running is safe (INSERT OR IGNORE).
 */
var NEW_API = "https://isp.sornix.com.ng/api";
var ADMIN_TOKEN = "PASTE_ADMIN_TOKEN";

function rows_(sh) {
  var v = sh.getDataRange().getValues();
  if (v.length < 2) return [];
  var head = v[0].map(function (h) { return String(h).toLowerCase().replace(/[^a-z_]/g, ""); });
  return v.slice(1).filter(function (r) { return r.some(function (c) { return String(c).trim() !== ""; }); })
    .map(function (r) { var o = {}; head.forEach(function (h, i) { o[h] = r[i]; }); return o; });
}
function find_(ss, want) {
  var shs = ss.getSheets();
  for (var i = 0; i < shs.length; i++) {
    var n = shs[i].getName().toLowerCase().replace(/[^a-z]/g, "");
    if (n.indexOf(want) >= 0) return shs[i];
  }
  return null;
}
function bool_(x) { return x === true || x === "TRUE" || x === 1 || x === "1" || x === "yes"; }

function exportAll() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var data = { settings: {}, plans: [], vouchers: [], orders: [], whitelist: [], banners: [] };

  var sh = find_(ss, "setting");
  if (sh) rows_(sh).forEach(function (r) { if (r.key) data.settings[String(r.key)] = String(r.value == null ? "" : r.value); });

  sh = find_(ss, "plan");
  if (sh) rows_(sh).forEach(function (r) {
    if (!r.plan_id) return;
    data.plans.push({ plan_id: String(r.plan_id), name: String(r.name || r.plan_id), price: Number(r.price) || 0, validity: String(r.validity || "1d"), rate_limit: String(r.rate_limit || r.ratelimit || "2M/5M"), shared_users: Number(r.shared_users) || 1, is_featured_on_login: bool_(r.is_featured_on_login == null ? r.featured : r.is_featured_on_login), active: r.active == null ? true : bool_(r.active) });
  });

  sh = find_(ss, "voucher");
  if (sh) rows_(sh).forEach(function (r) {
    if (!r.code) return;
    data.vouchers.push({ code: String(r.code).toUpperCase(), plan_id: String(r.plan_id || ""), status: String(r.status || "new"), used_by: r.used_by ? String(r.used_by) : null, batch: r.batch ? String(r.batch) : null, created_at: r.created_at ? new Date(r.created_at).toISOString() : null, used_at: r.used_at ? new Date(r.used_at).toISOString() : null, expires_at: r.expires_at ? new Date(r.expires_at).toISOString() : null });
  });

  sh = find_(ss, "order");
  if (sh) rows_(sh).forEach(function (r) {
    if (!r.order_id) return;
    data.orders.push({ order_id: String(r.order_id).toUpperCase(), plan_id: String(r.plan_id || ""), id_type: String(r.id_type || "device"), identifier: String(r.identifier || ""), phone: String(r.phone || ""), status: String(r.status || "requested"), paid_via: r.paid_via ? String(r.paid_via) : null, reference: r.reference ? String(r.reference) : null, amount_paid: r.amount_paid ? Number(r.amount_paid) : null, created_at: r.created_at ? new Date(r.created_at).toISOString() : null, paid_at: r.paid_at ? new Date(r.paid_at).toISOString() : null, activated_at: r.activated_at ? new Date(r.activated_at).toISOString() : null, expires_at: r.expires_at ? new Date(r.expires_at).toISOString() : null });
  });

  sh = find_(ss, "white");
  if (sh) rows_(sh).forEach(function (r) { if (r.mac) data.whitelist.push({ mac: String(r.mac), note: String(r.note || "") }); });

  sh = find_(ss, "banner");
  if (sh) rows_(sh).forEach(function (r) { if (r.image_url) data.banners.push({ id: r.id ? String(r.id) : "", image_url: String(r.image_url), link_url: String(r.link_url || ""), sort: Number(r.sort) || 0 }); });

  var payload = JSON.stringify({ action: "importData", token: ADMIN_TOKEN, data: data });
  var res = UrlFetchApp.fetch(NEW_API, { method: "post", contentType: "text/plain", payload: payload, muteHttpExceptions: true });
  Logger.log("HTTP " + res.getResponseCode() + " " + res.getContentText());
  Logger.log("sent: " + data.plans.length + " plans, " + data.orders.length + " orders, " + data.vouchers.length + " vouchers, " + data.whitelist.length + " macs, " + data.banners.length + " banners, " + Object.keys(data.settings).length + " settings");
}
