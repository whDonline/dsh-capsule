// 作用：Governance Console 的前端资源（规格第 24 节 Phase 4 + 2026-10-31 可用性改造）——把
// 「当前会话的临时授权 / 还剩多久 / 到期会怎样 / 怎么提前收回」收敛成**一份**框架无关的前端代码，
// 同时供两处使用：
//   ① 独立只读页面 GET /（浏览器直接打开 Console 端口）；
//   ② DSH Web GUI 里的 Guard 面板（client.js 在 DSH 模块加载器里复用同一份脚本与同一套 HTTP API）。
// 这样两个入口不会出现两套视图逻辑漂移。
//
// 【信息分层】首屏只出现人话（会话名 / 放开了什么 / 还剩多久 / 档位收回没有），原始 ID、Scope 哈希、
// 完整 Scope 串一律收进「技术详情」展开区；审计单独一个 tab，不占首屏。
// 【两个状态分离】「授权是否还有效」与「沙箱档位是否已恢复」是两条独立状态：
//   - 倒计时只属于授权；
//   - 档位状态只用状态词（已提升 / 待回滚 / 已恢复 / 无法确认），且必须等下一次快照确认，
//     绝不因为倒计时归零就显示「已恢复」。
// 【安全约束】脚本内所有动态内容一律经 textContent 写入（杜绝注入）；不读取 document.body；
// 唯一的写操作是 PATCH /api/config（挡位/TTL）与 POST /api/revoke（收缩型动作），且仅在用户点击后触发。
export const CONSOLE_CLIENT_JS = String.raw`(function (root, factory) {
  if (typeof module === "object" && module.exports) { module.exports = factory(); }
  else { root.DshGuardConsole = factory(); }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  var DECISIONS = ["PASSTHROUGH_ALLOW", "PASSTHROUGH_DENY", "ASK", "LEASE_REUSED", "LEASE_ISSUED", "LEASE_REVOKED", "APPROVAL_REJECTED", "TOOL_SUCCESS", "TOOL_ERROR", "SANDBOX_MODE_RAISED", "SANDBOX_MODE_RESTORED", "SANDBOX_MODE_SKIPPED_USER_OVERRIDE"];
  var DECISION_LABELS = {
    ASK: "已询问",
    LEASE_ISSUED: "已签发授权",
    LEASE_REUSED: "复用授权",
    LEASE_REVOKED: "已收回授权",
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
  var MODE_LABELS = { "read-only": "只读", "workspace-write": "工作区可写", "danger-full-access": "完全访问" };
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
  function modeLabel(mode) { return mode ? (MODE_LABELS[mode] || mode) : "未知"; }
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
      ".dgc-tabs{display:flex;gap:6px;border-bottom:1px solid var(--line);margin-bottom:14px;flex-wrap:wrap}",
      ".dgc-tab{background:none;border:1px solid transparent;border-bottom:none;border-radius:6px 6px 0 0;padding:6px 12px;font:inherit;color:var(--fg2);cursor:pointer}",
      ".dgc-tab[aria-selected=true]{color:var(--fg);background:var(--surface);border-color:var(--line);font-weight:600}",
      ".dgc-panel[hidden]{display:none}",
      ".dgc-session-card{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:16px 18px;max-width:860px}",
      ".dgc-session-head{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:14px}",
      ".dgc-session-label{font-size:16px;font-weight:600;margin:0}",
      ".dgc-session-cwd{color:var(--fg2);font-size:12px}",
      ".dgc-status-row{display:grid;grid-template-columns:64px 116px 1fr auto;gap:10px;align-items:center;padding:9px 0;border-bottom:1px dashed var(--line)}",
      ".dgc-status-row:last-of-type{border-bottom:none}",
      ".dgc-status-key{color:var(--fg2);font-size:12px}",
      ".dgc-status-main{font-weight:600}",
      ".dgc-status-side{font-variant-numeric:tabular-nums;color:var(--fg2);text-align:right}",
      ".dgc-pill{display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px;font-weight:600;border:1px solid var(--line2);color:var(--fg2);white-space:nowrap}",
      ".dgc-pill.dgc-ok{color:var(--ok);border-color:var(--ok)}",
      ".dgc-pill.dgc-warn{color:var(--warn);border-color:var(--warn)}",
      ".dgc-pill.dgc-bad{color:var(--bad);border-color:var(--bad)}",
      ".dgc-pill.dgc-idle{color:var(--idle);border-color:var(--line2)}",
      ".dgc-bar{height:4px;background:var(--line);border-radius:2px;overflow:hidden;margin-top:6px;max-width:320px}",
      ".dgc-bar i{display:block;height:100%;background:var(--ok)}",
      ".dgc-bar.dgc-warn i{background:var(--warn)}",
      ".dgc-facts{margin-top:14px}",
      ".dgc-fact{display:grid;grid-template-columns:72px 1fr;gap:10px;padding:5px 0;font-size:12.5px}",
      ".dgc-fact .dgc-fact-key{color:var(--fg2)}",
      ".dgc-fact .dgc-fact-value{color:var(--fg)}",
      ".dgc-banner{margin-top:12px;padding:10px 12px;border-radius:8px;border:1px solid var(--line2);background:var(--surface2);font-size:12.5px}",
      ".dgc-banner.dgc-warn{border-color:var(--warn);color:var(--warn)}",
      ".dgc-banner.dgc-bad{border-color:var(--bad);color:var(--bad)}",
      ".dgc-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}",
      ".dgc-btn{font:inherit;font-size:12.5px;padding:5px 12px;border-radius:6px;border:1px solid var(--brand);background:var(--brand);color:#fff;cursor:pointer}",
      ".dgc-btn.dgc-ghost{background:var(--surface);color:var(--fg);border-color:var(--line2)}",
      ".dgc-btn.dgc-danger{background:var(--surface);color:var(--bad);border-color:var(--bad)}",
      ".dgc-btn[disabled]{opacity:.5;cursor:not-allowed}",
      ".dgc-details{margin-top:12px}",
      ".dgc-details-toggle{background:none;border:none;color:var(--brand);font:inherit;font-size:12.5px;cursor:pointer;padding:0}",
      ".dgc-details-body{margin-top:8px;border-top:1px solid var(--line);padding-top:10px}",
      ".dgc-kv{display:grid;grid-template-columns:120px 1fr;gap:6px 10px;font-size:12px;color:var(--fg2)}",
      ".dgc-kv b{color:var(--fg);font-weight:600}",
      ".dgc-table{width:100%;border-collapse:collapse;background:var(--surface);border:1px solid var(--line);border-radius:8px;font-size:12.5px}",
      ".dgc-table th,.dgc-table td{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top;max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dgc-table th{background:var(--surface2);font-weight:600;position:sticky;top:0}",
      ".dgc-table tr:last-child td{border-bottom:none}",
      ".dgc-empty{color:var(--fg2);padding:14px;background:var(--surface);border:1px dashed var(--line);border-radius:8px}",
      ".dgc-remaining{font-variant-numeric:tabular-nums}",
      ".dgc-form{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px;align-items:center}",
      ".dgc-form input,.dgc-form select,.dgc-select{font:inherit;font-size:12.5px;padding:4px 8px;border:1px solid var(--line2);border-radius:6px;background:var(--surface);color:var(--fg)}",
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
      ".dgc-err{padding:12px;border:1px solid var(--bad);border-radius:8px;color:var(--bad);background:var(--surface);margin-bottom:10px}",
      ".dgc-link{color:var(--brand);cursor:pointer}"
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
    var state = {
      snapshot: null,
      config: null,
      audit: [],
      auditLoading: false,
      tab: "session",
      focus: options.sessionId || null,
      detailsOpen: false,
      error: null,
      view: null,
      pollMs: options.pollMs || 2000
    };

    var head = el("div", "dgc-head");
    head.appendChild(el("h1", null, "临时授权"));
    head.appendChild(el("span", "dgc-sub", "本会话的短期放宽与恢复状态"));
    container.appendChild(head);

    var errorBox = el("div", "dgc-err");
    errorBox.hidden = true;
    container.appendChild(errorBox);

    var tabs = el("div", "dgc-tabs");
    tabs.setAttribute("role", "tablist");
    var tabDefs = [["session", "当前会话"], ["others", "全部会话"], ["audit", "审计"], ["scope", "设置"]];
    var panels = {};
    tabDefs.forEach(function (def) {
      var button = el("button", "dgc-tab", def[1]);
      button.type = "button";
      button.setAttribute("role", "tab");
      button.dataset.tab = def[0];
      button.addEventListener("click", function () { state.tab = def[0]; renderTabs(); });
      tabs.appendChild(button);
    });
    container.appendChild(tabs);
    tabDefs.forEach(function (def) {
      var panel = el("div", "dgc-panel");
      panel.dataset.tab = def[0];
      panels[def[0]] = panel;
      container.appendChild(panel);
    });

    // ---------------- 当前会话 ----------------
    var card = el("div", "dgc-session-card");
    panels.session.appendChild(card);
    var sessionHead = el("div", "dgc-session-head");
    var sessionLabel = el("h2", "dgc-session-label", "（暂无会话）");
    var sessionSource = el("span", "dgc-badge", "");
    var sessionCwd = el("span", "dgc-session-cwd", "");
    sessionHead.appendChild(sessionLabel);
    sessionHead.appendChild(sessionSource);
    sessionHead.appendChild(sessionCwd);
    card.appendChild(sessionHead);

    function statusRow(keyText) {
      var row = el("div", "dgc-status-row");
      var key = el("div", "dgc-status-key", keyText);
      var pill = el("span", "dgc-pill", "-");
      var main = el("div", "dgc-status-main", "");
      var side = el("div", "dgc-status-side", "");
      row.appendChild(key);
      row.appendChild(pill);
      row.appendChild(main);
      row.appendChild(side);
      return { row: row, pill: pill, main: main, side: side };
    }
    var authRow = statusRow("授权状态");
    card.appendChild(authRow.row);
    var authBar = el("div", "dgc-bar");
    var authFill = el("i");
    authBar.appendChild(authFill);
    card.appendChild(authBar);
    var sandboxRow = statusRow("沙箱档位");
    card.appendChild(sandboxRow.row);

    var banner = el("div", "dgc-banner");
    banner.hidden = true;
    card.appendChild(banner);

    var facts = el("div", "dgc-facts");
    function factRow(keyText) {
      var row = el("div", "dgc-fact");
      var key = el("div", "dgc-fact-key", keyText);
      var value = el("div", "dgc-fact-value", "");
      row.appendChild(key);
      row.appendChild(value);
      return { row: row, value: value };
    }
    var capabilityFact = factRow("放开了什么");
    var reasonFact = factRow("为什么");
    var consequenceFact = factRow("到期后");
    facts.appendChild(capabilityFact.row);
    facts.appendChild(reasonFact.row);
    facts.appendChild(consequenceFact.row);
    card.appendChild(facts);

    var actions = el("div", "dgc-actions");
    var revokeBtn = el("button", "dgc-btn dgc-danger", "立即收回");
    revokeBtn.type = "button";
    revokeBtn.hidden = true;
    revokeBtn.addEventListener("click", function () { void runAction("revoke", revokeBtn); });
    var restoreBtn = el("button", "dgc-btn dgc-ghost", "立即回滚档位");
    restoreBtn.type = "button";
    restoreBtn.hidden = true;
    restoreBtn.addEventListener("click", function () { void runAction("restore-sandbox", restoreBtn); });
    var actionMsg = el("span", "dgc-msg", "");
    actions.appendChild(revokeBtn);
    actions.appendChild(restoreBtn);
    actions.appendChild(actionMsg);
    card.appendChild(actions);

    var details = el("div", "dgc-details");
    var detailsToggle = el("button", "dgc-details-toggle", "技术详情 ▾");
    detailsToggle.type = "button";
    detailsToggle.addEventListener("click", function () {
      state.detailsOpen = !state.detailsOpen;
      renderDetails();
    });
    var detailsBody = el("div", "dgc-details-body");
    detailsBody.hidden = true;
    details.appendChild(detailsToggle);
    details.appendChild(detailsBody);
    card.appendChild(details);

    // ---------------- 全部会话 ----------------
    var othersNote = el("p", "dgc-note", "这里列出本进程内出现过的授权会话；点会话名可以切到该会话查看详情（只影响本页面显示）。");
    panels.others.appendChild(othersNote);
    var othersTable = el("table", "dgc-table");
    var othersHead = el("thead");
    var othersHeadRow = el("tr");
    ["会话", "授权", "沙箱档位", "最近活动"].forEach(function (label) { othersHeadRow.appendChild(el("th", null, label)); });
    othersHead.appendChild(othersHeadRow);
    othersTable.appendChild(othersHead);
    var othersBody = el("tbody");
    othersTable.appendChild(othersBody);
    panels.others.appendChild(othersTable);
    var othersEmpty = el("div", "dgc-empty", "还没有任何会话产生过临时授权。");
    panels.others.appendChild(othersEmpty);

    // ---------------- 审计 ----------------
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
    panels.audit.appendChild(el("p", "dgc-note", "审计事件不含任何参数原文与凭证：只有会话、工具、范围哈希/脱敏展示、授权 ID 与决策。"));
    var auditTable = el("table", "dgc-table");
    var auditHead = el("thead");
    var auditHeadRow = el("tr");
    ["时间", "决策", "工具", "会话", "范围", "授权 ID"].forEach(function (label) { auditHeadRow.appendChild(el("th", null, label)); });
    auditHead.appendChild(auditHeadRow);
    auditTable.appendChild(auditHead);
    var auditBody = el("tbody");
    auditTable.appendChild(auditBody);
    panels.audit.appendChild(auditTable);
    var auditEmpty = el("div", "dgc-empty", "暂无审计事件。");
    panels.audit.appendChild(auditEmpty);

    // ---------------- 设置 ----------------
    var scopeWrap = el("div", "dgc-scope");
    scopeWrap.appendChild(el("p", "dgc-note", "范围挡位决定「一次批准可以在多大范围内被复用」。挡位切换即时生效，只影响之后新签发的授权，不会扩大已签发授权。"));
    var scopeRow = el("div", "dgc-scope-row");
    scopeRow.appendChild(el("h3", null, "默认范围挡位（defaultScope）"));
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
    var metaRow = el("div", "dgc-scope-row");
    metaRow.appendChild(el("h3", null, "运行信息"));
    var metaBody = el("div", "dgc-kv");
    metaRow.appendChild(metaBody);
    scopeWrap.appendChild(metaRow);
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
    function actionsEnabled(name) {
      var cfg = state.config;
      return !!(cfg && cfg.actions && cfg.actions[name]);
    }
    function runAction(action, button) {
      var view = state.view;
      if (!view) return Promise.resolve(null);
      var label = action === "revoke" ? "立即收回本会话的全部临时授权？这会同时把沙箱档位收回。" : "立即把沙箱档位收回到原值？这只影响档位，不会动仍然有效的授权。";
      if (typeof confirm === "function" && !confirm(label)) return Promise.resolve(null);
      button.disabled = true;
      setMsg(actionMsg, "执行中…", false);
      return fetchJson(host, "/api/revoke", {
        method: "POST",
        headers: { "content-type": "application/json", "x-dsh-guard": "1" },
        body: JSON.stringify({ sessionId: view.sessionId, action: action })
      }).then(function (body) {
        var restored = body && body.results ? body.results.length : 0;
        var revoked = body && typeof body.revoked === "number" ? body.revoked : 0;
        setMsg(actionMsg, action === "revoke" ? ("已收回 " + revoked + " 条授权，档位处理 " + restored + " 项") : ("档位处理 " + restored + " 项"), false);
        return refresh();
      }).catch(function (err) {
        setMsg(actionMsg, "未执行：" + (err && err.message ? err.message : String(err)), true);
        return null;
      }).then(function () {
        button.disabled = false;
        return null;
      });
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
    function focusedView() {
      var snapshot = state.snapshot;
      if (!snapshot || !snapshot.sessions) return null;
      var id = snapshot.focus && snapshot.focus.sessionId ? snapshot.focus.sessionId : state.focus;
      if (id) {
        for (var i = 0; i < snapshot.sessions.length; i += 1) {
          if (snapshot.sessions[i].sessionId === id) return snapshot.sessions[i];
        }
      }
      return snapshot.sessions.length > 0 ? snapshot.sessions[0] : null;
    }
    function authText(auth) {
      if (!auth) return "没有授权";
      if (auth.state === "active") return "生效中";
      if (auth.state === "expiring") return "即将到期";
      if (auth.state === "expired") return "已到期";
      if (auth.state === "revoked") return "已撤销";
      return "没有授权";
    }
    function authPillClass(auth) {
      if (!auth) return "dgc-pill dgc-idle";
      if (auth.state === "active") return "dgc-pill dgc-ok";
      if (auth.state === "expiring") return "dgc-pill dgc-warn";
      if (auth.state === "expired" || auth.state === "revoked") return "dgc-pill dgc-idle";
      return "dgc-pill dgc-idle";
    }
    function sandboxText(sandbox) {
      if (!sandbox) return "不涉及沙箱档位";
      if (sandbox.state === "raised") return "已提升：" + modeLabel(sandbox.currentMode);
      if (sandbox.state === "unchanged") return "未改动（本来就够宽）：" + modeLabel(sandbox.currentMode);
      if (sandbox.state === "user-override") return "由你设定：" + modeLabel(sandbox.currentMode);
      if (sandbox.state === "pending-restore") return "待回滚：仍为 " + modeLabel(sandbox.currentMode);
      if (sandbox.state === "restored") return "已恢复：" + modeLabel(sandbox.currentMode);
      if (sandbox.state === "unknown") return "无法确认";
      return "不涉及沙箱档位";
    }
    function sandboxPillClass(sandbox) {
      if (!sandbox) return "dgc-pill dgc-idle";
      if (sandbox.state === "raised") return "dgc-pill dgc-ok";
      if (sandbox.state === "unchanged") return "dgc-pill dgc-idle";
      if (sandbox.state === "pending-restore") return "dgc-pill dgc-warn";
      if (sandbox.state === "user-override") return "dgc-pill dgc-idle";
      if (sandbox.state === "restored") return "dgc-pill dgc-idle";
      if (sandbox.state === "unknown") return "dgc-pill dgc-idle";
      return "dgc-pill dgc-idle";
    }
    function activeGrants(view) {
      var out = [];
      if (!view || !view.auth || !view.auth.grants) return out;
      view.auth.grants.forEach(function (grant) { if (grant.expiresAt > Date.now()) out.push(grant); });
      return out;
    }
    function consequenceText(view) {
      if (!view) return "";
      var sandbox = view.sandbox;
      if (sandbox && sandbox.state === "pending-restore") {
        return "授权已经失效，但档位还停在 " + modeLabel(sandbox.currentMode) + "；点「立即回滚档位」可以马上收回。";
      }
      if (view.auth.state === "active" || view.auth.state === "expiring") {
        if (sandbox && (sandbox.state === "raised" || sandbox.state === "unchanged")) {
          var seconds = state.config && state.config.sweep && state.config.sweep.intervalMs > 0 ? Math.round(state.config.sweep.intervalMs / 1000) : 0;
          var tail = seconds > 0 ? "（最多 " + seconds + " 秒内自动回滚）" : "（会在你下次调用工具时回滚）";
          return "到期后：同类请求会重新询问；沙箱档位会回滚到 " + modeLabel(sandbox.baselineMode) + tail + "。";
        }
        return "到期后：同类请求会重新询问。";
      }
      if (sandbox && sandbox.state === "restored") return "授权已失效，档位已恢复到 " + modeLabel(sandbox.currentMode) + "。";
      if (view.auth.state === "revoked") return "授权已被收回；同类请求会重新询问。";
      if (view.auth.state === "expired") return "授权已到期；同类请求会重新询问。";
      return "本会话当前没有任何临时授权。";
    }
    function renderSession() {
      var view = focusedView();
      state.view = view;
      var snapshot = state.snapshot;
      var source = snapshot && snapshot.focus ? snapshot.focus.source : "none";
      if (!view) {
        sessionLabel.textContent = "（暂无会话）";
        sessionSource.textContent = "";
        sessionCwd.textContent = "";
        authRow.pill.textContent = "-";
        authRow.pill.className = "dgc-pill dgc-idle";
        authRow.main.textContent = "没有可显示的会话";
        authRow.side.textContent = "";
        sandboxRow.pill.textContent = "-";
        sandboxRow.pill.className = "dgc-pill dgc-idle";
        sandboxRow.main.textContent = "不涉及沙箱档位";
        sandboxRow.side.textContent = "";
        capabilityFact.value.textContent = "还没有任何临时授权。";
        reasonFact.value.textContent = "工具调用会照常询问你，你批准后才会出现在这里。";
        consequenceFact.value.textContent = "";
        banner.hidden = true;
        revokeBtn.hidden = true;
        restoreBtn.hidden = true;
        authBar.hidden = true;
        renderDetails();
        return;
      }
      sessionLabel.textContent = view.label;
      // 只有「页面确实带着当前会话参数进来」时才敢写「当前会话」；用户在页面里点了别的会话，
      // 只能说「你选择的会话」（治理台不知道 DSH 真正的当前会话是哪个）。
      var fromOptions = state.focus && view.sessionId === state.focus;
      sessionSource.textContent = source === "explicit" && fromOptions ? "当前会话" : (source === "recent-activity" ? "最近有授权的会话" : "你选择的会话");
      sessionCwd.textContent = view.cwd ? view.cwd : (view.labelSource === "id" ? "" : "");
      authRow.pill.textContent = authText(view.auth);
      authRow.pill.className = authPillClass(view.auth);
      var sandbox = view.sandbox || null;
      sandboxRow.pill.textContent = sandboxText(sandbox);
      sandboxRow.pill.className = sandboxPillClass(sandbox);
      sandboxRow.main.textContent = sandbox && sandbox.baselineMode ? ("你的默认档位是 " + modeLabel(sandbox.baselineMode)) : "";
      sandboxRow.side.textContent = sandbox && sandbox.checkedAt ? "核对于 " + new Date(sandbox.checkedAt).toLocaleTimeString() : "";
      var grants = view.auth && view.auth.grants ? view.auth.grants : [];
      if (grants.length === 0) {
        capabilityFact.value.textContent = "还没有任何临时授权。";
        reasonFact.value.textContent = "";
      } else {
        capabilityFact.value.textContent = "";
        grants.forEach(function (grant) {
          var line = el("div", null, grant.capabilityText);
          capabilityFact.value.appendChild(line);
        });
        reasonFact.value.textContent = grants[0].reasonText + (grants.length > 1 ? "（共 " + grants.length + " 条授权）" : "");
      }
      consequenceFact.value.textContent = consequenceText(view);
      var showBanner = sandbox && (sandbox.state === "pending-restore" || sandbox.state === "unknown" || sandbox.state === "user-override");
      banner.hidden = !showBanner;
      banner.className = "dgc-banner" + (sandbox && sandbox.state === "pending-restore" ? " dgc-warn" : "");
      banner.textContent = showBanner && sandbox && sandbox.note ? sandbox.note : "";
      var canRevoke = !!(view.actions && view.actions.canRevoke) && actionsEnabled("revoke");
      var canRestore = !!(view.actions && view.actions.canRestoreSandbox) && actionsEnabled("restoreSandbox");
      revokeBtn.hidden = !canRevoke;
      restoreBtn.hidden = !canRestore;
      renderRemaining();
      renderDetails();
    }
    function renderRemaining() {
      var view = state.view;
      if (!view || !view.auth || view.auth.activeCount === 0 || !view.auth.nextExpiresAt) {
        authRow.side.textContent = "";
        authBar.hidden = true;
        authRow.main.textContent = view ? (view.auth.state === "none" ? "本会话没有临时授权" : "") : "";
        return;
      }
      var remain = view.auth.nextExpiresAt - Date.now();
      if (remain <= 0) {
        // 倒计时归零只代表「授权到期」——档位状态必须等下一次快照确认，绝不在这里推断为已恢复
        authRow.side.textContent = "到期，正在核对…";
        authRow.pill.textContent = "已到期";
        authRow.pill.className = "dgc-pill dgc-idle";
        authBar.hidden = true;
        return;
      }
      authRow.side.textContent = fmtDuration(remain);
      authBar.hidden = false;
      var starts = activeGrants(view).map(function (grant) { return grant.issuedAt; });
      var issuedAt = starts.length > 0 ? Math.min.apply(null, starts) : view.auth.nextExpiresAt - 60000;
      var total = Math.max(1, view.auth.nextExpiresAt - issuedAt);
      var ratio = Math.max(0, Math.min(1, remain / total));
      authBar.className = "dgc-bar" + (ratio <= 0.25 ? " dgc-warn" : "");
      authFill.style.width = Math.round(ratio * 100) + "%";
      authRow.main.textContent = view.auth.activeCount > 1 ? ("本会话有 " + view.auth.activeCount + " 条有效授权") : "";
    }
    function renderDetails() {
      detailsBody.hidden = !state.detailsOpen;
      detailsToggle.textContent = state.detailsOpen ? "技术详情 ▴" : "技术详情 ▾";
      var view = state.view;
      detailsBody.textContent = "";
      if (!view) return;
      var kv = el("div", "dgc-kv");
      function line(key, value) {
        kv.appendChild(el("span", null, key));
        var node = el("b", "dgc-code", value);
        kv.appendChild(node);
      }
      line("会话 ID", view.sessionId);
      var grants = view.auth && view.auth.grants ? view.auth.grants : [];
      if (grants.length === 0) {
        kv.appendChild(el("span", null, "授权"));
        kv.appendChild(el("b", null, "（无）"));
      }
      grants.forEach(function (grant) {
        kv.appendChild(el("span", null, "授权 ID"));
        kv.appendChild(el("b", "dgc-code", grant.id));
        kv.appendChild(el("span", null, "范围"));
        kv.appendChild(el("b", "dgc-code", grant.scopeKind + " " + grant.scopeKeyShort + "…"));
        kv.appendChild(el("span", null, "批准说明"));
        kv.appendChild(el("b", null, grant.scopeDisplay));
        kv.appendChild(el("span", null, "签发 / 到期"));
        kv.appendChild(el("b", null, fmtTime(grant.issuedAt) + " → " + fmtTime(grant.expiresAt)));
      });
      detailsBody.appendChild(kv);
    }
    function renderOthers() {
      othersBody.textContent = "";
      var snapshot = state.snapshot;
      var sessions = snapshot && snapshot.sessions ? snapshot.sessions : [];
      sessions.forEach(function (view) {
        var row = el("tr");
        var nameCell = el("td");
        var link = el("span", "dgc-link", view.label);
        link.addEventListener("click", function () {
          state.focus = view.sessionId;
          void refresh();
        });
        nameCell.appendChild(link);
        row.appendChild(nameCell);
        row.appendChild(el("td", null, view.auth.activeCount > 0 ? ("生效中 " + view.auth.activeCount) : authText(view.auth)));
        row.appendChild(el("td", null, sandboxText(view.sandbox)));
        row.appendChild(el("td", null, view.auth.nextExpiresAt ? fmtTime(view.auth.nextExpiresAt) : "-"));
        othersBody.appendChild(row);
      });
      var empty = sessions.length === 0;
      othersTable.hidden = empty;
      othersEmpty.hidden = !empty;
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
      metaBody.textContent = "";
      function metaLine(key, value) {
        metaBody.appendChild(el("span", null, key));
        metaBody.appendChild(el("b", null, value));
      }
      metaLine("配置来源", policy ? policy.source : "-");
      metaLine("revision", policy ? String(policy.revision) : "-");
      metaLine("档位/TTL 可写", document_ && document_.writable ? document_.writable.join("、") : "-");
      metaLine("部署配置（只读）", document_ && document_.immutable ? document_.immutable.join("、") : "-");
      var sweep = document_ && document_.sweep ? document_.sweep : null;
      metaLine("档位自动回滚", sweep && sweep.intervalMs > 0 ? ("每 " + Math.round(sweep.intervalMs / 1000) + " 秒检查一次") : "已关闭（只在下次工具调用或手动操作时回滚）");
      var routes = document_ && document_.routes ? document_.routes : null;
      if (routes) metaLine("同源路由", routes.registered ? "已就绪" : "未就绪（面板会回落到独立端口）");
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
      var path = "/api/snapshot" + (state.focus ? "?session=" + encodeURIComponent(state.focus) : "");
      return fetchJson(host, path).then(function (snapshot) {
        state.snapshot = snapshot;
        errorBox.hidden = true;
        renderSession();
        renderOthers();
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
    var timer = null;
    var ticker = null;
    if (options.autoRefresh !== false) {
      timer = setInterval(function () { void refresh(); }, state.pollMs);
      ticker = setInterval(function () { renderRemaining(); }, 1000);
    }
    void loadConfig().then(function () { return refresh(); }).then(function () { return loadAudit(); });
    return {
      refresh: refresh,
      loadAudit: loadAudit,
      dispose: function () {
        if (timer) clearInterval(timer);
        if (ticker) clearInterval(ticker);
        timer = null;
        ticker = null;
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
// 支持 ?session=<id> 直接聚焦某个会话（面板与外部链接都可用同一种方式指定「当前会话」）。
export const CONSOLE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>临时授权 · DSH Capability Guard</title>
<style>html,body{margin:0;height:100%}body{background:#f6f7f9}#dsh-guard-root{height:100%}</style>
</head>
<body>
<div id="dsh-guard-root"></div>
<script src="${CONSOLE_CLIENT_PATH}"></script>
<script>
(function () {
  var params = new URLSearchParams(window.location.search);
  window.DshGuardConsole.mount({ host: "", container: document.getElementById("dsh-guard-root"), pollMs: 2000, sessionId: params.get("session") || null });
})();
</script>
</body>
</html>
`;
