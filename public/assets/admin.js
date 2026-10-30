(function () {
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return [].slice.call((r || document).querySelectorAll(s)); };

  // Copy buttons: <button data-copy="text"><span data-copy-label>Label</span></button>
  document.addEventListener("click", function (e) {
    var b = e.target.closest("[data-copy]");
    if (b && navigator.clipboard) {
      var l = b.querySelector("[data-copy-label]") || b;
      var old = l.textContent;
      navigator.clipboard.writeText(b.getAttribute("data-copy")).then(function () {
        l.textContent = "Copied";
        setTimeout(function () { l.textContent = old; }, 1400);
      });
      return;
    }
    $$("details.menu[open]").forEach(function (d) { if (!d.contains(e.target)) d.open = false; });
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") $$("details.menu[open]").forEach(function (d) { d.open = false; });
  });
  document.addEventListener("submit", function (e) {
    var m = e.target.getAttribute("data-confirm");
    if (m && !window.confirm(m)) e.preventDefault();
  });

  // Account filter
  var filter = $("#filter");
  if (filter) {
    filter.addEventListener("input", function () {
      var q = filter.value.trim().toLowerCase();
      var any = false;
      $$("[data-q]").forEach(function (i) {
        var hit = !q || i.getAttribute("data-q").indexOf(q) > -1;
        i.hidden = !hit;
        if (hit) any = true;
      });
      $$(".group").forEach(function (g) { g.hidden = !$("[data-q]:not([hidden])", g); });
      var none = $("#no-match");
      if (none) none.hidden = any;
    });
  }

  // Add-account form: one form, two modes (OAuth sign-in or pasted token)
  var form = $("#add-form");
  if (form) {
    var radios = $$("input[name=provider]", form);
    var sel = $("#credential", form);
    var submit = $("#add-submit", form);
    var sync = function () {
      var r = radios.filter(function (x) { return x.checked; })[0];
      if (!r) return;
      var kind = r.getAttribute("data-kind");
      var p = r.value;
      form.action = kind === "token" ? "/admin/token" : "/admin/connect";

      var hasApp = false;
      var first = null;
      [].slice.call(sel.options).forEach(function (o) {
        var ok = o.getAttribute("data-provider") === p;
        o.hidden = !ok; o.disabled = !ok;
        if (ok) { hasApp = true; if (!first) first = o; }
      });
      if (sel.selectedOptions[0] && sel.selectedOptions[0].disabled && first) sel.value = first.value;

      var token = kind === "token";
      $$("[data-show]", form).forEach(function (el) {
        var w = el.getAttribute("data-show");
        var on = w === kind || (w === "baseurl" && token && (p === "gitlab" || p === "atlassian")) || (w === "atlassian" && token && p === "atlassian") || (w === "noapp" && kind === "oauth" && !hasApp);
        el.hidden = !on;
        $$("input,select", el).forEach(function (c) { c.disabled = !on; });
      });
      $$("[data-hint]", form).forEach(function (el) { el.hidden = !(kind === "token" && el.getAttribute("data-hint") === p); });
      var base = $("#baseUrl", form);
      if (base) {
        var site = p === "atlassian";
        base.required = token && site;
        base.placeholder = site ? "https://acme.atlassian.net" : "https://gitlab.com";
        $("#baseurl-label", form).textContent = site ? "Site URL" : "GitLab base URL";
        $("#baseurl-hint", form).textContent = site ? "Your Atlassian Cloud address. Jira and Confluence share it." : "Leave empty for gitlab.com. Self-hosted instances must use https.";
      }
      var user = $("#username", form);
      if (user) user.required = token && p === "atlassian";
      var link = $("#noapp-link", form);
      if (link) link.href = "/admin/apps?service=" + encodeURIComponent(p);
      var name = $("#noapp-name", form);
      if (name) name.textContent = r.getAttribute("data-name");
      submit.textContent = kind === "token" ? "Add token" : "Connect account";
      submit.disabled = kind === "oauth" && !hasApp;
    };
    radios.forEach(function (r) { r.addEventListener("change", sync); });
    sync();
  }

  // File inputs that fill a textarea (backup restore)
  $$("input[data-fill]").forEach(function (f) {
    f.addEventListener("change", function () {
      var file = f.files && f.files[0];
      if (!file) return;
      var r = new FileReader();
      r.onload = function () { document.getElementById(f.getAttribute("data-fill")).value = String(r.result).trim(); };
      r.readAsText(file);
    });
  });
})();
