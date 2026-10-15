// 作用：Governance Console 的前端资源（规格第 24 节 Phase 4）——把「授权剩余时间 / 审计 / 范围挡位」
// 三个视图收敛成**一份**框架无关的前端代码，同时供两处使用：
//   ① 独立只读页面 GET /（浏览器直接打开 Console 端口）；
//   ② DSH Web GUI 里的 Guard 面板（client.js 在 DSH 模块加载器里复用同一份脚本与同一套 HTTP API）。
// 这样两个入口不会出现两套视图逻辑漂移。
//
// 【安全约束】脚本内所有动态内容一律经 textContent 写入（杜绝注入）；不读取 document.body；
// 不做任何写操作，唯一写接口是 PATCH /api/config（挡位/TTL），且仅由用户点击按钮触发。
export const CONSOLE_CLIENT_JS = String.raw`(function (root, factory) {
  if (typeof module === "object" && module.exports) { module.exports = factory(); }
  else { root.DshGuardConsole = factory(); }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  var DECISIONS = ["PASSTHROUGH_ALLOW", "PASSTHROUGH_DENY", "ASK", "LEASE_REUSED", "LEASE_ISSUED", "APPROVAL_REJECTED", "TOOL_SUCCESS", "TOOL_ERROR", "SANDBOX_MODE_RAISED", "SANDBOX_MODE_RESTORED", "SANDBOX_MODE_SKIPPED_USER_OVERRIDE"];
  var DECISION_LABELS = {
    ASK: "已询问",
    LEASE_ISSUED: "已签发授权",
    LEASE_REUSED: "复用授权",
    APPROVAL_REJECTED: "已拒绝",
    PASSTHROUGH_ALLOW: "原生放行",
    PASSTHROUGH_DENY: "原生拒绝",
    TOOL_SUCCESS: "执行成功",
    TOOL_ERROR: "执行失败",
    SANDBOX_MODE_RAISED: "沙箱档位提升",
    SANDBOX_MODE_RESTORED: "沙箱档位回滚",
    SANDBOX_MODE_SKIPPED_USER_OVERRIDE: "跳过回滚（用户已改动）"
  };
  var STATUS_LABELS = { ACTIVE: "生效中", EXPIRED: "已过期", REVOKED: "已撤销" };
  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }
  function fmtTime(ts) { return ts ? new Date(ts).toLocaleString() : "-"; }
  function short(value, n) {
    var text = value === undefined || value === null ? "" : String(value);
    return text.length > n ? text.slice(0, n) + "…" : text;
  }
  function fmtDuration(ms) {
    if (!(ms > 0)) return "0s";
    var total = Math.floor(ms / 1000);
    var h = Math.floor(total / 3600);
    var m = Math.floor((total % 3600) / 60);
    var s = total % 60;
    if (h > 0) return h + "h" + (m < 10 ? "0" : "") + m + "m";
    if (m > 0) return m + "m" + (s < 10 ? "0" : "") + s + "s";
    return s + "s";
  }
  function injectStyles(doc) {
    if (doc.getElementById("dsh-guard-console-style")) return;
    var style = doc.createElement("style");
    style.id = "dsh-guard-console-style";
    style.textContent = [
      ".dgc{--bg:var(--dsw-alias-bg-base,#f6f7f9);--surface:var(--dsw-alias-bg-layer-1,#ffffff);--surface2:var(--dsw-alias-bg-layer-2,#f6f7f9);--line:var(--dsw-alias-border-l1,#d8dee4);--line2:var(--dsw-alias-border-l2,#c2ccd6);--fg:var(--dsw-alias-label-primary,#1f2328);--fg2:var(--dsw-alias-label-secondary,#59636e);--brand:var(--dsw-alias-brand-primary,#0969da);--ok:var(--dsw-alias-state-success-primary,#1a7f37);--bad:var(--dsw-alias-state-error-primary,#cf222e);--warn:var(--dsw-alias-state-warn-primary,#9a6700);--idle:var(--dsw-alias-state-idle-primary,#8c959f);color:var(--fg);background:var(--bg);font-family:inherit;font-size:13px;line-height:1.5;height:100%;overflow:auto;box-sizing:border-box;padding:20px 24px}",
      ".dgc *{box-sizing:border-box}",
      ".dgc-head{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:14px}",
      ".dgc-head h1{font-size:18px;margin:0;font-weight:600}",
      ".dgc-head .dgc-sub{color:var(--fg2);font-size:12px}",
      ".dgc-cards{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:16px}",
      ".dgc-card{background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:8px 14px;min-width:104px}",
      ".dgc-card b{display:block;font-size:18px;font-weight:600}",
      ".dgc-card span{font-size:12px;color:var(--fg2)}",
      ".dgc-tabs{display:flex;gap:6px;border-bottom:1px solid var(--line);margin-bottom:14px;flex-wrap:wrap}",
      ".dgc-tab{background:none;border:1px solid transparent;border-bottom:none;border-radius:6px 6px 0 0;padding:6px 12px;font:inherit;color:var(--fg2);cursor:pointer}",
      ".dgc-tab[aria-selected=true]{color:var(--fg);background:var(--surface);border-color:var(--line);font-weight:600}",
      ".dgc-panel[hidden]{display:none}",
      ".dgc-table{width:100%;border-collapse:collapse;background:var(--surface);border:1px solid var(--line);border-radius:8px;font-size:12.5px}",
      ".dgc-table th,.dgc-table td{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top;max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dgc-table th{background:var(--surface2);font-weight:600;position:sticky;top:0}",
      ".dgc-table tr:last-child td{border-bottom:none}",
      ".dgc-empty{color:var(--fg2);padding:14px;background:var(--surface);border:1px dashed var(--line);border-radius:8px}",
      ".dgc-status{font-weight:600}.dgc-ACTIVE{color:var(--ok)}.dgc-EXPIRED{color:var(--bad)}.dgc-REVOKED{color:var(--idle)}",
      ".dgc-remaining{font-variant-numeric:tabular-nums}",
      ".dgc-bar{height:4px;background:var(--line);border-radius:2px;overflow:hidden;margin-top:4px;min-width:60px}",
      ".dgc-bar i{display:block;height:100%;background:var(--ok)}",
      ".dgc-bar.dgc-warn i{background:var(--warn)}",
      ".dgc-form{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px;align-items:center}",
      ".dgc-form input,.dgc-form select,.dgc-select{font:inherit;font-size:12.5px;padding:4px 8px;border:1px solid var(--line2);border-radius:6px;background:var(--surface);color:var(--fg)}",
      ".dgc-btn{font:inherit;font-size:12.5px;padding:5px 12px;border-radius:6px;border:1px solid var(--brand);background:var(--brand);color:#fff;cursor:pointer}",
      ".dgc-btn.dgc-ghost{background:var(--surface);color:var(--fg);border-color:var(--line2)}",
      ".dgc-btn[disabled]{opacity:.5;cursor:not-allowed}",
      ".dgc-note{color:var(--fg2);font-size:12px;margin:8px 0}",
      ".dgc-scope{display:flex;flex-direction:column;gap:10px;max-width:760px}",
      ".dgc-scope-row{background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:12px 14px}",
      ".dgc-scope-row h3{margin:0 0 4px;font-size:13.5px;font-weight:600}",
      ".dgc-scope-row p{margin:0 0 8px;color:var(--fg2);font-size:12px}",
      ".dgc-scope-row .dgc-controls{display:flex;gap:8px;align-items:center;flex-wrap:wrap}",
      ".dgc-badge{font-size:11px;padding:1px 6px;border-radius:999px;border:1px solid var(--line2);color:var(--fg2)}",
      ".dgc-badge.dgc-risky{border-color:var(--warn);color:var(--warn)}",
      ".dgc-msg{margin-top:8px;font-size:12px;min-height:16px}",
      ".dgc-msg.dgc-ok{color:var(--ok)}.dgc-msg.dgc-err{color:var(--bad)}",
      ".dgc-code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px}",
      ".dgc-err{padding:12px;border:1px solid var(--bad);border-radius:8px;color:var(--bad);background:var(--surface)}"
    ].join("");
    (doc.head || doc.documentElement).appendChild(style);
  }
  function fetchJson(host, path, init) {
    var options = init || {};
    options.headers = options.headers || {};
    options.headers["accept"] = "application/json";
    return fetch(host + path, options).then(function (res) {
      return res.text().then(function (text) {
        var body = null;
        try { body = text ? JSON.parse(text) : null; } catch (err) { body = null; }
        if (!res.ok) {
          var message = body && body.message ? body.message : (body && body.error ? body.error : "HTTP " + res.status);
          var error = new Error(message);
          error.status = res.status;
          error.body = body;
          throw error;
        }
        return body;
      });
    });
  }
  function mount(options) {
    var host = String(options.host || "").replace(/\/+$/, "");
    var doc = options.document || document;
    var container = options.container;
    injectStyles(doc);
    container.classList.add("dgc");
    container.textContent = "";
    var state = { snapshot: null, config: null, audit: [], auditLoading: false, error: null, pollMs: options.pollMs || 2000, tab: "leases" };

    var head = el("div", "dgc-head");
    var title = el("h1", null, "DSH Capability Guard");
    var subtitle = el("span", "dgc-sub", "短期授权治理台（只读 + 授权范围挡位）");
    head.appendChild(title);
    head.appendChild(subtitle);
    container.appendChild(head);

    var errorBox = el("div", "dgc-err");
    errorBox.hidden = true;
    container.appendChild(errorBox);

    var cards = el("div", "dgc-cards");
    container.appendChild(cards);

    var tabs = el("div", "dgc-tabs");
    tabs.setAttribute("role", "tablist");
    var tabDefs = [["leases", "授权与剩余时间"], ["audit", "审计"], ["scope", "范围挡位与 TTL"]];
    var panels = {};
    tabDefs.forEach(function (def) {
      var button = el("button", "dgc-tab", def[1]);
      button.type = "button";
      button.setAttribute("role", "tab");
      button.addEventListener("click", function () { state.tab = def[0]; renderTabs(); });
      tabs.appendChild(button);
      button.dataset.tab = def[0];
      var panel = el("div", "dgc-panel");
      panel.dataset.tab = def[0];
      panels[def[0]] = panel;
      container.appendChild(panel);
    });
    container.insertBefore(tabs, container.children[2]);

    // ---- 授权（Leases）视图 ----
    var leaseNote = el("p", "dgc-note", "剩余时间按本机时钟实时计算；状态判定始终以 Guard 的 LeaseManager 为准，页面仅做展示投影。");
    panels.leases.appendChild(leaseNote);
    var leaseTable = el("table", "dgc-table");
    var leaseHead = el("thead");
    var leaseHeadRow = el("tr");
    ["授权 ID", "类型", "会话", "工具", "范围", "状态", "剩余时间", "到期时间"].forEach(function (label) {
      leaseHeadRow.appendChild(el("th", null, label));
    });
    leaseHead.appendChild(leaseHeadRow);
    leaseTable.appendChild(leaseHead);
    var leaseBody = el("tbody");
    leaseTable.appendChild(leaseBody);
    panels.leases.appendChild(leaseTable);
    var leaseEmpty = el("div", "dgc-empty", "当前没有任何授权（Lease）。当某个工具调用被批准一次后，这里会出现它的短期授权。");
    panels.leases.appendChild(leaseEmpty);

    // ---- 审计（Audit）视图 ----
    var auditForm = el("form", "dgc-form");
    function field(name, placeholder, tag) {
      var node = el(tag || "input");
      node.name = name;
      if (tag === "select") {
        var all = el("option", null, "全部");
        all.value = "";
        node.appendChild(all);
        DECISIONS.forEach(function (decision) {
          var option = el("option", null, DECISION_LABELS[decision] ? DECISION_LABELS[decision] + " (" + decision + ")" : decision);
          option.value = decision;
          node.appendChild(option);
        });
      } else {
        node.placeholder = placeholder;
        node.autocomplete = "off";
      }
      node.className = "dgc-select";
      return node;
    }
    var auditSession = field("sessionId", "会话 ID");
    var auditTool = field("toolName", "工具名");
    var auditDecision = field("decision", "", "select");
    var auditLimit = field("limit", "条数");
    auditLimit.value = "100";
    var auditSubmit = el("button", "dgc-btn", "查询");
    auditSubmit.type = "submit";
    var auditReset = el("button", "dgc-btn dgc-ghost", "重置");
    auditReset.type = "button";
    [auditSession, auditTool, auditDecision, auditLimit, auditSubmit, auditReset].forEach(function (node) { auditForm.appendChild(node); });
    auditForm.addEventListener("submit", function (event) {
      event.preventDefault();
      void loadAudit();
    });
    auditReset.addEventListener("click", function () {
      auditForm.reset();
      auditLimit.value = "100";
      void loadAudit();
    });
    panels.audit.appendChild(auditForm);
    var auditNote = el("p", "dgc-note", "审计事件不含任何参数原文与凭证：只有会话、工具、范围哈希/脱敏展示、授权 ID 与决策。");
    panels.audit.appendChild(auditNote);
    var auditTable = el("table", "dgc-table");
    var auditHead = el("thead");
    var auditHeadRow = el("tr");
    ["时间", "决策", "工具", "会话", "范围", "授权 ID"].forEach(function (label) {
      auditHeadRow.appendChild(el("th", null, label));
    });
    auditHead.appendChild(auditHeadRow);
    auditTable.appendChild(auditHead);
    var auditBody = el("tbody");
    auditTable.appendChild(auditBody);
    panels.audit.appendChild(auditTable);
    var auditEmpty = el("div", "dgc-empty", "暂无审计事件。");
    panels.audit.appendChild(auditEmpty);

    // ---- 范围挡位与 TTL 视图 ----
    var scopeWrap = el("div", "dgc-scope");
    var scopeNote = el("p", "dgc-note", "范围挡位决定「一次批准可以在多大范围内被复用」。挡位切换即时生效，只影响之后新签发的授权，不会扩大已签发授权。");
    scopeWrap.appendChild(scopeNote);
    var scopeRow = el("div", "dgc-scope-row");
    var scopeTitle = el("h3", null, "默认范围挡位（defaultScope）");
    scopeRow.appendChild(scopeTitle);
    var scopeDesc = el("p", null, "");
    scopeRow.appendChild(scopeDesc);
    var scopeControls = el("div", "dgc-controls");
    var scopeSelect = el("select", "dgc-select");
    scopeControls.appendChild(scopeSelect);
    var scopeApply = el("button", "dgc-btn", "应用挡位");
    scopeApply.type = "button";
    scopeControls.appendChild(scopeApply);
    var scopeBadge = el("span", "dgc-badge", "");
    scopeControls.appendChild(scopeBadge);
    scopeRow.appendChild(scopeControls);
    var scopeMsg = el("div", "dgc-msg", "");
    scopeRow.appendChild(scopeMsg);
    scopeWrap.appendChild(scopeRow);

    var ttlRow = el("div", "dgc-scope-row");
    ttlRow.appendChild(el("h3", null, "授权有效期 TTL"));
    ttlRow.appendChild(el("p", null, "默认 TTL 用于新签发的授权；上限 maxTtlSeconds 是任何规则都不得越过的硬边界。"));
    var ttlControls = el("div", "dgc-controls");
    var ttlDefault = el("input", "dgc-select");
    ttlDefault.type = "number";
    ttlDefault.min = "1";
    ttlDefault.setAttribute("aria-label", "defaultTtlSeconds");
    var ttlMax = el("input", "dgc-select");
    ttlMax.type = "number";
    ttlMax.min = "1";
    ttlMax.setAttribute("aria-label", "maxTtlSeconds");
    var ttlApply = el("button", "dgc-btn", "应用 TTL");
    ttlApply.type = "button";
    ttlControls.appendChild(el("span", null, "默认(秒)"));
    ttlControls.appendChild(ttlDefault);
    ttlControls.appendChild(el("span", null, "上限(秒)"));
    ttlControls.appendChild(ttlMax);
    ttlControls.appendChild(ttlApply);
    ttlRow.appendChild(ttlControls);
    var ttlMsg = el("div", "dgc-msg", "");
    ttlRow.appendChild(ttlMsg);
    scopeWrap.appendChild(ttlRow);
    var rulesRow = el("div", "dgc-scope-row");
    rulesRow.appendChild(el("h3", null, "部署配置（只读）"));
    rulesRow.appendChild(el("p", null, "enabled 与 rules 属于 profile patch 中的部署配置，治理页面刻意不可修改：页面不能关闭 Guard，也不能新增授权规则。"));
    var rulesTable = el("table", "dgc-table");
    var rulesHead = el("thead");
    var rulesHeadRow = el("tr");
    ["匹配工具", "启用", "TTL(秒)", "挡位"].forEach(function (label) { rulesHeadRow.appendChild(el("th", null, label)); });
    rulesHead.appendChild(rulesHeadRow);
    rulesTable.appendChild(rulesHead);
    var rulesBody = el("tbody");
    rulesTable.appendChild(rulesBody);
    rulesRow.appendChild(rulesTable);
    scopeWrap.appendChild(rulesRow);
    panels.scope.appendChild(scopeWrap);

    scopeSelect.addEventListener("change", function () { renderScopeMeta(); });
    scopeApply.addEventListener("click", function () {
      void applyPatch({ defaultScope: scopeSelect.value }, scopeMsg, scopeApply);
    });
    ttlApply.addEventListener("click", function () {
      var payload = {};
      var d = Number(ttlDefault.value);
      var m = Number(ttlMax.value);
      if (Number.isInteger(d) && d > 0) payload.defaultTtlSeconds = d;
      if (Number.isInteger(m) && m > 0) payload.maxTtlSeconds = m;
      if (payload.defaultTtlSeconds === undefined && payload.maxTtlSeconds === undefined) {
        setMsg(ttlMsg, "请输入正整数秒数", true);
        return;
      }
      void applyPatch(payload, ttlMsg, ttlApply);
    });

    function setMsg(node, text, isError) {
      node.textContent = text || "";
      node.className = "dgc-msg" + (isError ? " dgc-err" : " dgc-ok");
    }
    function applyPatch(payload, msgNode, button) {
      button.disabled = true;
      setMsg(msgNode, "提交中…", false);
      return fetchJson(host, "/api/config", {
        method: "PATCH",
        headers: { "content-type": "application/json", "x-dsh-guard": "1" },
        body: JSON.stringify(payload)
      }).then(function (body) {
        state.config = body;
        setMsg(msgNode, "已生效（revision " + (body.policy ? body.policy.revision : "?") + "）", false);
        renderConfig();
        return refresh();
      }).catch(function (err) {
        setMsg(msgNode, "未应用：" + (err && err.message ? err.message : String(err)), true);
      }).then(function () {
        button.disabled = false;
      });
    }
    function renderTabs() {
      tabs.childNodes.forEach(function (node) {
        if (!node.dataset || !node.dataset.tab) return;
        node.setAttribute("aria-selected", node.dataset.tab === state.tab ? "true" : "false");
      });
      Object.keys(panels).forEach(function (key) { panels[key].hidden = key !== state.tab; });
    }
    function renderCards() {
      cards.textContent = "";
      var summary = state.snapshot ? state.snapshot.summary : null;
      var items = summary ? [
        ["授权总数", summary.leasesTotal],
        ["生效中", summary.leasesActive],
        ["已过期", summary.leasesExpired],
        ["已撤销", summary.leasesRevoked],
        ["审计事件", summary.auditedEvents]
      ] : [["授权总数", "-"], ["生效中", "-"], ["已过期", "-"], ["已撤销", "-"], ["审计事件", "-"]];
      items.forEach(function (item) {
        var card = el("div", "dgc-card");
        card.appendChild(el("b", null, item[1]));
        card.appendChild(el("span", null, item[0]));
        cards.appendChild(card);
      });
    }
    function renderLeases() {
      var leases = state.snapshot ? state.snapshot.leases : [];
      var now = Date.now();
      leaseBody.textContent = "";
      leases.forEach(function (lease) {
        var row = el("tr");
        row.appendChild(el("td", "dgc-code", short(lease.id, 10)));
        row.appendChild(el("td", null, lease.kind));
        row.appendChild(el("td", "dgc-code", short(lease.sessionId, 12)));
        row.appendChild(el("td", null, lease.toolName));
        row.appendChild(el("td", null, lease.scopeKind + "： " + short(lease.scopeDisplay, 60)));
        var statusCell = el("td", "dgc-status dgc-" + lease.status, STATUS_LABELS[lease.status] || lease.status);
        row.appendChild(statusCell);
        var remaining = Math.max(0, lease.expiresAt - now);
        var remainCell = el("td", "dgc-remaining", lease.status === "ACTIVE" ? fmtDuration(remaining) : "-");
        if (lease.status === "ACTIVE") {
          var total = Math.max(1, lease.expiresAt - lease.issuedAt);
          var ratio = Math.max(0, Math.min(1, remaining / total));
          var bar = el("div", "dgc-bar" + (ratio <= 0.25 ? " dgc-warn" : ""));
          var fill = el("i");
          fill.style.width = Math.round(ratio * 100) + "%";
          bar.appendChild(fill);
          remainCell.appendChild(bar);
        }
        row.appendChild(remainCell);
        row.appendChild(el("td", null, fmtTime(lease.expiresAt)));
        leaseBody.appendChild(row);
      });
      var empty = leases.length === 0;
      leaseTable.hidden = empty;
      leaseEmpty.hidden = !empty;
    }
    function renderAudit() {
      auditBody.textContent = "";
      state.audit.forEach(function (event) {
        var row = el("tr");
        row.appendChild(el("td", null, fmtTime(event.timestamp)));
        row.appendChild(el("td", null, (DECISION_LABELS[event.decision] || event.decision) + " (" + event.decision + ")"));
        row.appendChild(el("td", null, event.toolName || "-"));
        row.appendChild(el("td", "dgc-code", short(event.sessionId, 12)));
        row.appendChild(el("td", null, short(event.scopeDisplay, 60)));
        row.appendChild(el("td", "dgc-code", short(event.leaseId, 10)));
        auditBody.appendChild(row);
      });
      var empty = state.audit.length === 0;
      auditTable.hidden = empty;
      auditEmpty.hidden = !empty;
      auditEmpty.textContent = state.auditLoading ? "加载中…" : "暂无审计事件。";
    }
    function renderScopeMeta() {
      var modes = state.config && state.config.modes ? state.config.modes : [];
      var current = null;
      modes.forEach(function (mode) { if (mode.id === scopeSelect.value) current = mode; });
      if (!current) { scopeDesc.textContent = ""; scopeBadge.textContent = ""; return; }
      scopeDesc.textContent = current.summary + (current.defaultPaths ? "（未显式配置字段时使用兜底字段：" + current.defaultPaths.join("、") + "）" : "");
      scopeBadge.textContent = current.risk === "wide" ? "范围最宽" : current.risk === "escalation" ? "沙箱升级链路" : "范围受限";
      scopeBadge.className = "dgc-badge" + (current.risk === "wide" || current.risk === "escalation" ? " dgc-risky" : "");
    }
    function renderConfig() {
      var document_ = state.config;
      var policy = document_ && document_.policy ? document_.policy : null;
      var modes = document_ && document_.modes ? document_.modes : [];
      scopeSelect.textContent = "";
      modes.forEach(function (mode) {
        var option = el("option", null, mode.label + (mode.defaultable ? "" : "（不可作为默认值）"));
        option.value = mode.id;
        option.disabled = !mode.defaultable;
        scopeSelect.appendChild(option);
      });
      if (policy) {
        scopeSelect.value = policy.defaultScope;
        ttlDefault.value = String(policy.defaultTtlSeconds);
        ttlMax.value = String(policy.maxTtlSeconds);
        subtitle.textContent = "短期授权治理台 · 配置来源 " + policy.source + " · revision " + policy.revision;
      }
      renderScopeMeta();
      rulesBody.textContent = "";
      var rules = policy ? policy.rules : [];
      if (rules.length === 0) {
        var row = el("tr");
        var cell = el("td", null, "（无工具级规则：所有工具都使用上面的默认挡位与 TTL）");
        cell.colSpan = 4;
        row.appendChild(cell);
        rulesBody.appendChild(row);
      }
      rules.forEach(function (rule) {
        var row = el("tr");
        row.appendChild(el("td", null, rule.match));
        row.appendChild(el("td", null, rule.enabled ? "是" : "否"));
        row.appendChild(el("td", null, rule.ttlSeconds));
        row.appendChild(el("td", null, rule.scopeMode));
        rulesBody.appendChild(row);
      });
    }
    function loadAudit() {
      state.auditLoading = true;
      renderAudit();
      var params = [];
      if (auditSession.value) params.push("sessionId=" + encodeURIComponent(auditSession.value));
      if (auditTool.value) params.push("toolName=" + encodeURIComponent(auditTool.value));
      if (auditDecision.value) params.push("decision=" + encodeURIComponent(auditDecision.value));
      if (auditLimit.value) params.push("limit=" + encodeURIComponent(auditLimit.value));
      var path = "/api/audit" + (params.length ? "?" + params.join("&") : "");
      return fetchJson(host, path).then(function (rows) {
        state.audit = Array.isArray(rows) ? rows : [];
        state.auditLoading = false;
        renderAudit();
      }).catch(function (err) {
        state.auditLoading = false;
        state.audit = [];
        renderAudit();
        showError(err);
      });
    }
    function showError(err) {
      state.error = err;
      errorBox.hidden = false;
      errorBox.textContent = "无法连接 Guard 治理接口（" + host + "）：" + (err && err.message ? err.message : String(err)) + "。请确认该端口未被占用，或插件配置里的 console.port 是否被改动。";
    }
    function refresh() {
      return fetchJson(host, "/api/snapshot").then(function (snapshot) {
        state.snapshot = snapshot;
        errorBox.hidden = true;
        renderCards();
        renderLeases();
        return null;
      }).catch(function (err) {
        showError(err);
        return null;
      });
    }
    function loadConfig() {
      return fetchJson(host, "/api/config").then(function (body) {
        state.config = body;
        renderConfig();
        return null;
      }).catch(function (err) {
        showError(err);
        return null;
      });
    }
    renderTabs();
    renderCards();
    var timer = null;
    if (options.autoRefresh !== false) {
      timer = setInterval(function () {
        void refresh();
        if (state.tab === "leases") renderLeases();
      }, state.pollMs);
    }
    void loadConfig().then(function () { return refresh(); }).then(function () { return loadAudit(); });
    return {
      refresh: refresh,
      loadAudit: loadAudit,
      dispose: function () {
        if (timer) clearInterval(timer);
        timer = null;
        container.textContent = "";
        container.classList.remove("dgc");
      }
    };
  }
  return { mount: mount };
});
`;
export const CONSOLE_CLIENT_PATH = "/console.js";
// 作用：独立只读页面外壳——只负责加载 /console.js 并挂载；样式令牌带兜底值，
// 因此在浏览器直接打开时也有完整外观，在 DSH 面板内则自动继承宿主主题。
export const CONSOLE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DSH Capability Guard Console</title>
<style>html,body{margin:0;height:100%}body{background:#f6f7f9}#dsh-guard-root{height:100%}</style>
</head>
<body>
<div id="dsh-guard-root"></div>
<script src="${CONSOLE_CLIENT_PATH}"></script>
<script>
window.DshGuardConsole.mount({ host: "", container: document.getElementById("dsh-guard-root"), pollMs: 2000 });
</script>
</body>
</html>
`;
