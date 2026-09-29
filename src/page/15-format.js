// Clock and date formatting, including the session-list date range.
// Fragment of the in-page script - see README.md in this folder.

  var p2 = function(n){ return (n < 10 ? '0' : '') + n; };
  var fmt = function(ms){
    if (typeof ms !== 'number' || !isFinite(ms)) return '';
    var d = new Date(ms), now = new Date(), t = p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds());
    return d.toDateString() === now.toDateString() ? t : p2(d.getDate()) + '/' + p2(d.getMonth() + 1) + ' ' + t;
  };
  // Session list: absolute dates next to the compact relative time. On window because the call site
  // lives in the official component code, outside this closure. Pure ASCII source, no encoding risk.
  try {
    var MID = String.fromCharCode(183), ARROW = String.fromCharCode(8594);
    var ymd = function(ms){
      if (typeof ms !== 'number' || !isFinite(ms)) return null;
      var d = new Date(ms);
      return { y: d.getFullYear(), md: p2(d.getMonth() + 1) + '/' + p2(d.getDate()) };
    };
    window.__cceSpan = function(rel, last, created){
      var now = new Date().getFullYear();
      var e = ymd(last), s = ymd(created);
      // the year is written only when it is not the current one, and only once per range
      var one = function(v){ return v.y === now ? v.md : v.y + '/' + v.md; };
      if (!e) return rel;
      var body;
      if (s && (s.y !== e.y || s.md !== e.md)) {
        body = (s.y === e.y && s.y !== now) ? s.y + '/' + s.md + ARROW + e.md : one(s) + ARROW + one(e);
      } else {
        body = one(e);
      }
      return rel + ' ' + MID + ' ' + body;
    };
  } catch (e) {}
