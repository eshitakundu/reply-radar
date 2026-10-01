/* Runs inside x.com as a bookmarklet (via Function#toString), so it must be fully self-contained.
   Reads only tweet permalink + tweet text + display name. Never reads counts or navigation. */
function rrRun(doc, loc, nav) {
  var toast = function (msg, bad) {
    try {
      var old = doc.querySelectorAll("[data-rr-toast]");
      for (var k = 0; k < old.length; k++) old[k].parentNode.removeChild(old[k]);
      var d = doc.createElement("div");
      d.textContent = "Reply Radar: " + msg;
      d.setAttribute("data-rr-toast", "1");
      d.style.cssText = "position:fixed;z-index:2147483647;right:16px;bottom:16px;max-width:340px;padding:12px 16px;font:14px/1.4 system-ui,sans-serif;color:#fff;border-radius:8px;background:" + (bad ? "#b91c1c" : "#111");
      doc.body.appendChild(d);
      setTimeout(function () { if (d.parentNode) d.parentNode.removeChild(d); }, 6000);
    } catch (e) { /* ignore */ }
  };
  var copy = function (s) {
    try { if (nav.clipboard && nav.clipboard.writeText) return nav.clipboard.writeText(s).catch(function () { return legacy(s); }); } catch (e) { /* fall through */ }
    return legacy(s);
  };
  var legacy = function (s) {
    var t = doc.createElement("textarea");
    t.value = s; t.style.cssText = "position:fixed;opacity:0";
    doc.body.appendChild(t); t.select();
    var ok = doc.execCommand("copy");
    doc.body.removeChild(t);
    return ok ? Promise.resolve() : Promise.reject(new Error("copy blocked"));
  };

  var arts = doc.querySelectorAll('article[data-testid="tweet"]');
  var pageM = loc.pathname.match(/^\/(\w{1,15})\/status\/(\d+)/);
  var posts = [], seen = {}, failed = 0, ads = 0, pageAuthor = null;

  for (var i = 0; i < arts.length; i++) {
    var a = arts[i], m = null;
    var links = a.querySelectorAll('a[href*="/status/"]');
    for (var j = 0; j < links.length && !m; j++) {
      if (links[j].querySelector("time")) {
        var href = links[j].getAttribute("href") || "";
        m = href.replace(/^https?:\/\/[^/]+/, "").match(/^\/(\w{1,15})\/status\/(\d+)/);
      }
    }
    if (!m) { failed++; continue; }
    if (a.querySelector('[data-testid="placementTracking"]')) { ads++; continue; }
    if (pageM && m[2] === pageM[2]) { pageAuthor = m[1]; continue; } // the post the thread page is about
    if (seen[m[2]]) continue;
    var te = a.querySelector('[data-testid="tweetText"]');
    var text = te ? (te.innerText || te.textContent || "") : "";
    if (!text.trim()) { failed++; continue; }
    seen[m[2]] = 1;
    var un = a.querySelector('[data-testid="User-Name"]');
    var na = un ? un.querySelector('a[href$="/' + m[1] + '"]') : null; // the display-name link, not "@handle · 2h"
    var name = na ? (na.innerText || "").split("\n")[0] : un ? (un.innerText || "").split("\n")[0] : "";
    posts.push({ id: m[2], handle: m[1], name: name, text: text });
  }

  var payload = {
    rr: 1, page: pageM ? "status" : "search", pageAuthor: pageAuthor, pageStatusId: pageM ? pageM[2] : null,
    stats: { articles: arts.length, extracted: posts.length, failed: failed, ads: ads }, posts: posts,
  };
  var result = { ok: posts.length > 0, count: posts.length, payload: payload };

  if (!posts.length) {
    result.message = arts.length
      ? "saw " + arts.length + " tweets but could not read them. X may have changed its layout."
      : "no posts on this page yet. Scroll down so posts load, then click again.";
    toast(result.message, true);
    return result; // clipboard is left untouched so garbage is never imported
  }
  result.text = "RR1\n" + JSON.stringify(payload);
  result.copied = copy(result.text).then(
    function () { toast("copied " + posts.length + " posts. Now click Import in Reply Radar."); return true; },
    function () { toast("could not write to the clipboard. Click the page once and try again.", true); return false; }
  );
  return result;
}
