/**
 * DSH Capability Guard — DSH Web 客户端半边（浏览器侧）。
 *
 * 作用：把「这个会话现在被临时放开了什么、还剩多久、到期会怎样、怎么提前收回」放进对话界面本身，
 * 用户不需要去找任何"全局中台"。两层：
 *
 *   ① 【一眼】对话内常驻提示条（`conversation.input.dock`，输入框上方）：不点击就能看到四个问题的答案，
 *      并直接「提前收回」。该槽位是 list + `replaceRisk: none`，只追加，不覆盖 DSH 自带的 todo/goal/queue。
 *   ② 【详情】会话内的「能力授权」tab（`conversation.view`，排在 对话 / 轨迹 之后）：
 *      整页展示本会话的每条授权、权限级别状态、到期后果、本会话审计与提前收回/回滚按钮。
 *
 * 两个入口都拿到宿主直接传入的 `sessionId`，因此**显示的一定是当前会话**，不存在串会话或"最近活动"推断。
 *
 * 约束（刻意遵守，避免把界面做成新的权限入口）：
 *   - 唯一的写操作是「提前收回 / 立即回滚档位」（纯收缩动作，POST /api/revoke），必须由用户点击触发；
 *   - 不做任何审批 / 签发 / 放宽动作（那些只走 DSH 原生流程）；
 *   - 不引入任何 DSH Client 包（primitives 等），只使用 React 与主题令牌；
 *   - 所有动态内容走 React 文本子节点（等价于 textContent），不触碰 document.body；
 *   - 治理接口不可达时保持安静（不弹错误、不干扰对话）。
 */
window.__ModuleLoader__.load({
  id: '@dsh-capsule/adapter',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const GUARD_ID = 'guard';
    const SAME_ORIGIN_BASE = '/guard';
    const DEFAULT_CONSOLE_PORT = 8787;
    const PORT_PROBE_RANGE = 4;
    const DOCK_POLL_MS = 2000;
    const DOCK_ORDER = 5;
    const VIEW_ORDER = 20;
    const SETTINGS_ORDER = 25;
    const DONE_VISIBLE_MS = 15000;
    const AUDIT_LIMIT = 20;
    const probeCache = { host: null };

    /** 作用：探测治理接口——优先同源 /guard（由插件挂到 DSH Web 服务器上），
     *  回落到 127.0.0.1 的候选端口（独立 Console 端口）。返回可作为 fetch 前缀的基地址。 */
    async function probeConsoleHost() {
      if (probeCache.host) return probeCache.host;
      const candidates = [SAME_ORIGIN_BASE];
      for (let offset = 0; offset < PORT_PROBE_RANGE; offset += 1) {
        candidates.push('http://127.0.0.1:' + (DEFAULT_CONSOLE_PORT + offset));
      }
      for (const host of candidates) {
        try {
          const res = await fetch(host + '/api/config', { headers: { accept: 'application/json' } });
          if (res.ok) {
            probeCache.host = host;
            return host;
          }
        } catch (err) {
          // 该入口不可用：继续探测下一个候选
        }
      }
      return null;
    }

    function fetchJson(host, path, init) {
      const options = init || {};
      options.headers = options.headers || {};
      options.headers.accept = 'application/json';
      return fetch(host + path, options).then(function (res) {
        return res.text().then(function (text) {
          let body = null;
          try {
            body = text ? JSON.parse(text) : null;
          } catch (err) {
            body = null;
          }
          if (!res.ok) {
            const error = new Error((body && (body.message || body.error)) || 'HTTP ' + res.status);
            error.status = res.status;
            throw error;
          }
          return body;
        });
      });
    }

    /** 档位的中文说法——界面里绝不出现 read-only / danger-full-access 这类内部标识。 */
    const MODE_TEXT = { 'read-only': '只读', 'workspace-write': '工作区可写', 'danger-full-access': '完全访问' };
    function modeText(mode) {
      return MODE_TEXT[mode] || '未知';
    }
    /** 作用：把剩余毫秒说成人话（4 分 12 秒 / 1 小时 5 分 / 8 秒）。 */
    function fmtCn(ms) {
      if (!(ms > 0)) return '0 秒';
      const total = Math.floor(ms / 1000);
      const hours = Math.floor(total / 3600);
      const minutes = Math.floor((total % 3600) / 60);
      const seconds = total % 60;
      if (hours > 0) return hours + ' 小时 ' + minutes + ' 分';
      if (minutes > 0) return minutes + ' 分 ' + (seconds < 10 ? '0' : '') + seconds + ' 秒';
      return seconds + ' 秒';
    }
    function fmtTime(ts) {
      if (!ts) return '-';
      const date = new Date(ts);
      const pad = function (n) {
        return n < 10 ? '0' + n : String(n);
      };
      return pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds());
    }
    /** 审计决策的中文标签（与治理台保持一致）。 */
    const DECISION_LABELS = {
      ASK: '已询问',
      LEASE_ISSUED: '已签发临时授权',
      LEASE_REUSED: '复用临时授权',
      LEASE_REVOKED: '已提前收回',
      APPROVAL_REJECTED: '你拒绝了',
      PASSTHROUGH_ALLOW: '原生放行',
      PASSTHROUGH_DENY: '原生拒绝',
      TOOL_SUCCESS: '执行成功',
      TOOL_ERROR: '执行失败',
      SANDBOX_MODE_RAISED: '权限级别提升',
      SANDBOX_MODE_RESTORED: '权限级别恢复',
      SANDBOX_MODE_SKIPPED_USER_OVERRIDE: '跳过恢复（你手动改过）',
    };

    /** 作用：注入提示条样式（只注入一次；带令牌兜底，脱离主题也能读）。 */
    function injectDockStyles(doc) {
      if (!doc || !doc.head || doc.getElementById('dsh-guard-dock-style')) return;
      const style = doc.createElement('style');
      style.id = 'dsh-guard-dock-style';
      style.textContent = [
        '.dsh-guard-dock{display:flex;gap:10px;align-items:flex-start;box-sizing:border-box;margin:0 0 8px;padding:8px 12px;border:1px solid var(--dsw-alias-border-l1,#d8dee4);border-radius:10px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f2328);font-size:12.5px;line-height:1.5}',
        '.dsh-guard-dock[data-tone=warn]{border-color:var(--dsw-alias-state-warn-primary,#9a6700)}',
        '.dsh-guard-dock[data-tone=done]{border-style:dashed}',
        '.dsh-guard-dock[data-tone=idle]{border-style:dashed;background:transparent;opacity:.9}',
        '.dsh-guard-dock[data-tone=idle] .dsh-guard-dock-title{font-weight:500;color:var(--dsw-alias-label-secondary,#59636e)}',
        '.dsh-guard-dock .dsh-guard-dock-dot{flex:0 0 auto;font-size:12px;line-height:1.6}',
        '.dsh-guard-dock .dsh-guard-dock-body{flex:1 1 auto;min-width:0}',
        '.dsh-guard-dock .dsh-guard-dock-title{font-weight:600}',
        '.dsh-guard-dock .dsh-guard-dock-sub{margin-top:2px;color:var(--dsw-alias-label-secondary,#59636e)}',
        '.dsh-guard-dock .dsh-guard-dock-list{margin-top:4px;color:var(--dsw-alias-label-secondary,#59636e)}',
        '.dsh-guard-dock button{flex:0 0 auto;font:inherit;font-size:12.5px;padding:3px 10px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,#c2ccd6);background:transparent;color:inherit;cursor:pointer}',
        '.dsh-guard-dock button[data-kind=stop]{border-color:var(--dsw-alias-state-error-primary,#cf222e);color:var(--dsw-alias-state-error-primary,#cf222e)}',
        '.dsh-guard-dock button[disabled]{opacity:.5;cursor:not-allowed}',
        '.dsh-guard-dock .dsh-guard-dock-more{background:none;border:none;padding:0;color:var(--dsw-alias-brand-primary,#0969da);cursor:pointer;font:inherit;font-size:12px}',
      ].join('');
      doc.head.appendChild(style);
    }

    /** 作用：从快照里取出「本会话」的视图——永远只看自己的会话，绝不复用「最近活动」推断。 */
    function viewOf(snapshot, sessionId) {
      if (!snapshot || !Array.isArray(snapshot.sessions)) return null;
      for (const view of snapshot.sessions) {
        if (view && view.sessionId === sessionId) return view;
      }
      return null;
    }

    /** 作用：把会话视图翻译成提示条文案——返回 null 表示连一行都不占（连会话数据都没有）。 */
    function describe(view, now) {
      if (!view) return null;
      const auth = view.auth || { state: 'none', activeCount: 0, grants: [] };
      const sandbox = view.sandbox || { state: 'not-involved' };
      const grants = Array.isArray(auth.grants) ? auth.grants : [];
      const remaining = auth.activeCount > 0 && auth.nextExpiresAt ? auth.nextExpiresAt - now : 0;
      const first = grants[0];
      if (sandbox.state === 'pending-restore') {
        return {
          tone: 'warn',
          dot: '⚠',
          title: '临时授权已经到期，但权限还停在「' + modeText(sandbox.currentMode) + '」，没有收回。',
          sub: '点「现在收回」可以立刻恢复；不点的话，下次执行命令时也会自动收回。',
          action: { kind: 'stop', label: '现在收回', mode: 'restore-sandbox' },
        };
      }
      if (auth.activeCount > 0) {
        const title = first
          ? (grants.length > 1 ? '本会话临时放开了 ' + grants.length + ' 项：' : '本会话临时放开：') + first.capabilityText
          : '本会话有 ' + auth.activeCount + ' 项临时授权';
        const after =
          sandbox.state === 'raised' || sandbox.state === 'unchanged'
            ? '到期后会自动收回，之后同类操作会再问你一次。'
            : sandbox.state === 'user-override'
              ? '到期后不会改动你自己设置的权限。'
              : '到期后同类操作会再问你一次。';
        const expired = remaining <= 0;
        return {
          tone: expired ? 'warn' : 'active',
          dot: expired ? '⏳' : '●',
          title: title,
          sub: expired ? '正在核对是否已经收回…' : '还剩 ' + fmtCn(remaining) + ' · ' + after,
          extra: grants.slice(1).map(function (grant) {
            return grant.capabilityText;
          }),
          action: { kind: 'stop', label: '提前收回', mode: 'revoke' },
        };
      }
      if (sandbox.state === 'restored' && sandbox.lastOutcomeAt && now - sandbox.lastOutcomeAt < DONE_VISIBLE_MS) {
        return {
          tone: 'done',
          dot: '✓',
          title: '已收回：本会话的临时授权结束了，权限已回到「' + modeText(sandbox.currentMode) + '」。',
          sub: '之后的同类操作会重新征求你的同意。',
        };
      }
      if (sandbox.state === 'restored') return null;
      if (sandbox.state === 'unknown') {
        return { tone: 'done', dot: '?', title: '无法确认当前权限级别，请到 DSH 的设置里看一眼。', sub: '临时授权本身已经结束。' };
      }
      if (sandbox.state === 'user-override') {
        return {
          tone: 'done',
          dot: '·',
          title: '你手动把权限改成了「' + modeText(sandbox.currentMode) + '」，临时授权不会覆盖你的设置。',
          sub: '之后的同类操作会重新征求你的同意。',
        };
      }
      if (auth.state === 'expired' || auth.state === 'revoked') {
        return { tone: 'idle', dot: '○', title: '本会话的临时授权已经结束。', sub: '之后的同类操作会重新征求你的同意。' };
      }
      // 没有任何临时授权时也显示一行——否则用户根本不知道这个功能存在（2026-10-31 实测反馈）。
      return { tone: 'idle', dot: '○', title: '本会话没有临时放开的操作。', sub: '需要时会先征求你的同意。' };
    }

    /** 作用：对话内常驻提示条——挂在输入框上方（conversation.input.dock）。
     * 该槽位是 session 作用域，props.sessionId 就是用户此刻打开的会话。 */
    function GuardDock(props) {
      const sessionId = props && props.sessionId
        ? String(props.sessionId)
        : props && props.session && props.session.id
          ? String(props.session.id)
          : '';
      const [snapshot, setSnapshot] = React.useState(null);
      const [host, setHost] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [expanded, setExpanded] = React.useState(false);
      const [nowTick, setNowTick] = React.useState(0);
      const [message, setMessage] = React.useState('');

      React.useEffect(
        function () {
          if (!sessionId) return undefined;
          let alive = true;
          if (typeof console !== 'undefined' && typeof console.info === 'function') {
            console.info('[dsh-guard] dock mounted for session', sessionId);
          }
          injectDockStyles(typeof document !== 'undefined' ? document : undefined);
          const load = async function () {
            try {
              const base = await probeConsoleHost();
              if (!alive || !base) return;
              const body = await fetchJson(base, '/api/snapshot?session=' + encodeURIComponent(sessionId));
              if (!alive) return;
              setHost(base);
              setSnapshot(body);
            } catch (err) {
              // 治理接口暂时不可达：静默（不打扰对话），下一轮再试
            }
          };
          void load();
          const timer = setInterval(function () {
            void load();
          }, DOCK_POLL_MS);
          return function () {
            alive = false;
            clearInterval(timer);
          };
        },
        [sessionId],
      );

      // 每秒重算剩余时间：归零只把文案切成「正在核对」，绝不在这里断言「已收回」
      React.useEffect(function () {
        const timer = setInterval(function () {
          setNowTick(function (value) {
            return value + 1;
          });
        }, 1000);
        return function () {
          clearInterval(timer);
        };
      }, []);

      const view = viewOf(snapshot, sessionId);
      const info = describe(view, Date.now());
      if (!view || !info) return null;

      const onAction = async function () {
        if (busy || !host) return;
        const label =
          info.action.mode === 'restore-sandbox'
            ? '现在把权限收回去？（只影响权限级别，不动仍然有效的授权）'
            : '现在收回本会话的全部临时授权，并恢复权限级别？';
        if (typeof window !== 'undefined' && typeof window.confirm === 'function' && !window.confirm(label)) return;
        setBusy(true);
        setMessage('');
        try {
          await fetchJson(host, '/api/revoke', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-dsh-guard': '1' },
            body: JSON.stringify({ sessionId: sessionId, action: info.action.mode }),
          });
          const body = await fetchJson(host, '/api/snapshot?session=' + encodeURIComponent(sessionId));
          setSnapshot(body);
          setMessage('已收回');
        } catch (err) {
          setMessage('收回失败，请稍后再试');
        } finally {
          setBusy(false);
        }
      };

      const children = [
        h('span', { key: 'dot', className: 'dsh-guard-dock-dot' }, info.dot),
        h(
          'div',
          { key: 'body', className: 'dsh-guard-dock-body' },
          h('div', { className: 'dsh-guard-dock-title' }, info.title),
          info.sub ? h('div', { className: 'dsh-guard-dock-sub' }, info.sub) : null,
          message ? h('div', { className: 'dsh-guard-dock-sub' }, message) : null,
          info.extra && info.extra.length > 0
            ? h(
                'div',
                { className: 'dsh-guard-dock-list' },
                expanded
                  ? info.extra.map(function (text, index) {
                      return h('div', { key: 'extra-' + index }, '· ' + text);
                    })
                  : h(
                      'button',
                      {
                        type: 'button',
                        className: 'dsh-guard-dock-more',
                        onClick: function () {
                          setExpanded(true);
                        },
                      },
                      '还有 ' + info.extra.length + ' 项，展开看',
                    ),
              )
            : null,
        ),
      ];
      if (info.action) {
        children.push(
          h(
            'button',
            {
              key: 'action',
              type: 'button',
              'data-kind': info.action.kind,
              disabled: busy,
              onClick: function () {
                void onAction();
              },
            },
            busy ? '正在收回…' : info.action.label,
          ),
        );
      }
      return h('div', { className: 'dsh-guard-dock', 'data-tone': info.tone, 'data-tick': String(nowTick) }, children);
    }
    // 作用：把文案判定挂成静态方法，便于 Node 单测四种状态，不必伪造 React 渲染。运行时无影响。
    GuardDock.describe = describe;

    // ---------------- 会话内的「能力授权」详情页 ----------------
    const COLORS = {
      ok: 'var(--dsw-alias-state-success-primary,#1a7f37)',
      warn: 'var(--dsw-alias-state-warn-primary,#9a6700)',
      bad: 'var(--dsw-alias-state-error-primary,#cf222e)',
      idle: 'var(--dsw-alias-label-secondary,#59636e)',
      line: 'var(--dsw-alias-border-l1,#d8dee4)',
      line2: 'var(--dsw-alias-border-l2,#c2ccd6)',
      fg: 'var(--dsw-alias-label-primary,#1f2328)',
      fg2: 'var(--dsw-alias-label-secondary,#59636e)',
      surface: 'var(--dsw-alias-bg-layer-1,#fff)',
      brand: 'var(--dsw-alias-brand-primary,#0969da)',
    };
    const S = {
      page: { height: '100%', overflow: 'auto', boxSizing: 'border-box', padding: '20px 24px', color: COLORS.fg, fontSize: '13px', lineHeight: 1.6 },
      wrap: { maxWidth: '780px', display: 'flex', flexDirection: 'column', gap: '12px' },
      card: { border: '1px solid ' + COLORS.line, borderRadius: '10px', padding: '16px 18px', background: COLORS.surface },
      title: { fontSize: '15px', fontWeight: 600, margin: '0 0 10px' },
      row: { display: 'grid', gridTemplateColumns: '76px 104px 1fr auto', gap: '10px', alignItems: 'center', padding: '9px 0', borderBottom: '1px dashed ' + COLORS.line },
      key: { color: COLORS.fg2, fontSize: '12px' },
      main: { fontWeight: 600 },
      side: { color: COLORS.fg2, textAlign: 'right', fontVariantNumeric: 'tabular-nums' },
      fact: { display: 'grid', gridTemplateColumns: '80px 1fr', gap: '10px', padding: '4px 0' },
      btn: { font: 'inherit', fontSize: '12.5px', padding: '5px 12px', borderRadius: '6px', border: '1px solid ' + COLORS.line2, background: 'transparent', color: COLORS.fg, cursor: 'pointer' },
      input: { font: 'inherit', fontSize: '12.5px', padding: '5px 8px', borderRadius: '6px', border: '1px solid ' + COLORS.line2, background: 'transparent', color: COLORS.fg, width: '96px' },
      btnStop: { font: 'inherit', fontSize: '12.5px', padding: '5px 12px', borderRadius: '6px', border: '1px solid ' + COLORS.bad, background: 'transparent', color: COLORS.bad, cursor: 'pointer' },
      note: { color: COLORS.fg2, fontSize: '12px' },
      grant: { borderTop: '1px solid ' + COLORS.line, paddingTop: '10px', marginTop: '10px' },
      grantTitle: { fontWeight: 600 },
      code: { fontFamily: 'ui-monospace,SFMono-Regular,Consolas,monospace', fontSize: '11.5px', wordBreak: 'break-all' },
      auditRow: { display: 'grid', gridTemplateColumns: '78px 150px 1fr', gap: '8px', padding: '3px 0', fontSize: '12px', color: COLORS.fg2 },
      empty: { border: '1px dashed ' + COLORS.line, borderRadius: '8px', padding: '14px', color: COLORS.fg2 },
    };
    function pill(text, tone) {
      const color = tone === 'ok' ? COLORS.ok : tone === 'warn' ? COLORS.warn : tone === 'bad' ? COLORS.bad : COLORS.idle;
      return h('span', { style: { border: '1px solid ' + color, color: color, borderRadius: '999px', padding: '1px 8px', fontSize: '12px', fontWeight: 600, whiteSpace: 'nowrap' } }, text);
    }
    function authPill(auth) {
      if (!auth || auth.state === 'none') return pill('没有授权', 'idle');
      if (auth.state === 'active') return pill('生效中', 'ok');
      if (auth.state === 'expiring') return pill('即将到期', 'warn');
      if (auth.state === 'expired') return pill('已到期', 'idle');
      return pill('已撤销', 'idle');
    }
    function sandboxPill(sandbox) {
      const state = sandbox ? sandbox.state : 'not-involved';
      if (state === 'raised') return pill('已提升：' + modeText(sandbox.currentMode), 'ok');
      if (state === 'unchanged') return pill('未改动（本来就够宽）', 'idle');
      if (state === 'user-override') return pill('由你设定：' + modeText(sandbox.currentMode), 'idle');
      if (state === 'pending-restore') return pill('待回滚：仍为 ' + modeText(sandbox.currentMode), 'warn');
      if (state === 'restored') return pill('已恢复：' + modeText(sandbox.currentMode), 'idle');
      if (state === 'unknown') return pill('无法确认', 'idle');
      return pill('不涉及', 'idle');
    }
    function consequence(view) {
      const sandbox = view.sandbox || { state: 'not-involved' };
      const auth = view.auth || { state: 'none', activeCount: 0 };
      if (sandbox.state === 'pending-restore') {
        return '授权已经失效，但权限还停在「' + modeText(sandbox.currentMode) + '」。点「立即回滚档位」可以马上恢复；否则会在下次执行命令时自动收回。';
      }
      if (auth.activeCount > 0) {
        if (sandbox.state === 'raised' || sandbox.state === 'unchanged') {
          return '到期后会自动收回，权限回到「' + modeText(sandbox.baselineMode) + '」，之后的同类操作会重新征求你的同意。';
        }
        if (sandbox.state === 'user-override') return '到期后不会改动你自己设置的权限；之后的同类操作会重新征求你的同意。';
        return '到期后同类操作会重新征求你的同意。';
      }
      if (sandbox.state === 'restored') return '授权已结束，权限已恢复到「' + modeText(sandbox.currentMode) + '」。';
      if (sandbox.state === 'user-override') return '你自己设置的权限不会被改动。';
      if (sandbox.state === 'unknown') return '当前无法读取权限级别；授权本身已经结束。';
      return '本会话当前没有临时授权；工具调用会照常征求你的同意。';
    }

    /** 作用：会话内的「能力授权」详情页（conversation.view，排在 对话 / 轨迹 之后）。
     * 数据来自 GET /api/snapshot?session=<id> 与 /api/audit?sessionId=<id>，都只读。 */
    function GuardSessionView(props) {
      const sessionId = props && props.sessionId
        ? String(props.sessionId)
        : props && props.session && props.session.id
          ? String(props.session.id)
          : '';
      const [snapshot, setSnapshot] = React.useState(null);
      const [audit, setAudit] = React.useState([]);
      const [host, setHost] = React.useState(null);
      const [busy, setBusy] = React.useState('');
      const [message, setMessage] = React.useState('');
      const [detailsOpen, setDetailsOpen] = React.useState(false);
      const [nowTick, setNowTick] = React.useState(0);

      React.useEffect(
        function () {
          if (!sessionId) return undefined;
          let alive = true;
          const load = async function () {
            try {
              const base = await probeConsoleHost();
              if (!alive || !base) return;
              const [snap, events] = await Promise.all([
                fetchJson(base, '/api/snapshot?session=' + encodeURIComponent(sessionId)),
                fetchJson(base, '/api/audit?sessionId=' + encodeURIComponent(sessionId) + '&limit=' + AUDIT_LIMIT),
              ]);
              if (!alive) return;
              setHost(base);
              setSnapshot(snap);
              setAudit(Array.isArray(events) ? events : []);
            } catch (err) {
              if (alive) setMessage('治理接口暂时不可达，稍后自动重试');
            }
          };
          void load();
          const timer = setInterval(function () {
            void load();
          }, DOCK_POLL_MS);
          return function () {
            alive = false;
            clearInterval(timer);
          };
        },
        [sessionId],
      );
      React.useEffect(function () {
        const timer = setInterval(function () {
          setNowTick(function (value) {
            return value + 1;
          });
        }, 1000);
        return function () {
          clearInterval(timer);
        };
      }, []);

      const view = viewOf(snapshot, sessionId);
      const run = async function (mode, confirmText) {
        if (busy || !host) return;
        if (typeof window !== 'undefined' && typeof window.confirm === 'function' && !window.confirm(confirmText)) return;
        setBusy(mode);
        setMessage('');
        try {
          await fetchJson(host, '/api/revoke', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-dsh-guard': '1' },
            body: JSON.stringify({ sessionId: sessionId, action: mode }),
          });
          const snap = await fetchJson(host, '/api/snapshot?session=' + encodeURIComponent(sessionId));
          setSnapshot(snap);
          const events = await fetchJson(host, '/api/audit?sessionId=' + encodeURIComponent(sessionId) + '&limit=' + AUDIT_LIMIT);
          setAudit(Array.isArray(events) ? events : []);
          setMessage(mode === 'restore-sandbox' ? '权限已回滚' : '已收回本会话的临时授权');
        } catch (err) {
          setMessage('操作失败，请稍后再试');
        } finally {
          setBusy('');
        }
      };

      if (!view) {
        return h('div', { style: S.page }, h('div', { style: S.wrap }, h('div', { style: S.empty }, message || '正在读取本会话的授权状态…')));
      }
      const auth = view.auth || { state: 'none', activeCount: 0, grants: [] };
      const sandbox = view.sandbox || { state: 'not-involved' };
      const grants = Array.isArray(auth.grants) ? auth.grants : [];
      const remaining = auth.activeCount > 0 && auth.nextExpiresAt ? Math.max(0, auth.nextExpiresAt - Date.now()) : 0;

      const header = h(
        'div',
        { style: S.card },
        h('div', { style: S.title }, '本会话的临时授权'),
        h(
          'div',
          { style: S.row },
          h('div', { style: S.key }, '授权状态'),
          h('div', null, authPill(auth)),
          h('div', { style: S.main }, auth.activeCount > 0 ? '本会话有 ' + auth.activeCount + ' 条可复用的临时授权' : ''),
          h('div', { style: S.side }, auth.activeCount > 0 ? (remaining > 0 ? '还剩 ' + fmtCn(remaining) : '到期，正在核对…') : ''),
        ),
        h(
          'div',
          { style: Object.assign({}, S.row, { borderBottom: 'none' }) },
          h('div', { style: S.key }, '权限级别'),
          h('div', null, sandboxPill(sandbox)),
          h('div', { style: S.main }, sandbox.baselineMode ? '你的默认是「' + modeText(sandbox.baselineMode) + '」' : ''),
          h('div', { style: S.side }, sandbox.checkedAt ? '核对时间 ' + fmtTime(sandbox.checkedAt) : ''),
        ),
      );

      const granted = h(
        'div',
        { style: S.card },
        h('div', { style: S.title }, '放开了什么'),
        grants.length === 0 ? h('div', { style: S.empty }, '还没有临时授权。你在审批弹窗里点「允许一次」之后，这里会出现对应的条目。') : null,
        grants.map(function (grant) {
          const left = grant.expiresAt - Date.now();
          return h(
            'div',
            { key: grant.id, style: S.grant },
            h('div', { style: S.grantTitle }, grant.capabilityText),
            h('div', { style: S.note }, grant.reasonText + (grant.expiresAt > Date.now() ? ' · 还剩 ' + fmtCn(left) : ' · 已到期')),
            h('div', { style: S.note }, '范围：' + grant.scopeKind + '；到期时间 ' + fmtTime(grant.expiresAt)),
          );
        }),
        h('div', { style: Object.assign({}, S.fact, { marginTop: '12px' }) }, h('div', { style: S.key }, '到期会怎样'), h('div', null, consequence(view))),
      );

      const actions = h(
        'div',
        { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' } },
        view.actions && view.actions.canRevoke
          ? h(
              'button',
              { type: 'button', style: S.btnStop, disabled: busy !== '', onClick: function () { void run('revoke', '现在收回本会话的全部临时授权，并恢复权限级别？'); } },
              busy === 'revoke' ? '正在收回…' : '提前收回',
            )
          : null,
        view.actions && view.actions.canRestoreSandbox
          ? h(
              'button',
              { type: 'button', style: S.btnStop, disabled: busy !== '', onClick: function () { void run('restore-sandbox', '现在把权限收回去？（只影响权限级别，不动仍然有效的授权）'); } },
              busy === 'restore-sandbox' ? '正在回滚…' : '立即回滚档位',
            )
          : null,
        message ? h('span', { style: S.note }, message) : null,
      );

      const detailRows = grants.map(function (grant) {
        return h(
          'div',
          { key: 'd-' + grant.id, style: { padding: '6px 0', borderTop: '1px solid ' + COLORS.line } },
          h('div', { style: S.code }, '授权 ID ' + grant.id),
          h('div', { style: S.code }, '范围哈希 ' + grant.scopeKeyShort + '…（' + grant.scopeKind + '）'),
          h('div', { style: S.code }, '签发 ' + fmtTime(grant.issuedAt) + ' → 到期 ' + fmtTime(grant.expiresAt)),
        );
      });
      const details = h(
        'div',
        { style: S.card },
        h(
          'button',
          { type: 'button', style: Object.assign({}, S.btn, { border: 'none', padding: 0, color: COLORS.brand }), onClick: function () { setDetailsOpen(!detailsOpen); } },
          detailsOpen ? '收起技术详情 ▴' : '技术详情 ▾',
        ),
        detailsOpen
          ? h(
              'div',
              { style: { marginTop: '10px' } },
              h('div', { style: S.code }, '会话 ID ' + view.sessionId),
              detailRows.length > 0 ? detailRows : h('div', { style: S.note }, '（没有授权）'),
            )
          : null,
      );

      const auditCard = h(
        'div',
        { style: S.card },
        h('div', { style: S.title }, '本会话的最近记录'),
        audit.length === 0
          ? h('div', { style: S.empty }, '还没有记录。')
          : audit.map(function (event) {
              return h(
                'div',
                { key: event.id, style: S.auditRow },
                h('span', null, fmtTime(event.timestamp)),
                h('span', null, DECISION_LABELS[event.decision] || event.decision),
                h('span', { style: S.code }, (event.toolName || '') + (event.leaseId ? ' · ' + String(event.leaseId).slice(0, 8) : '')),
              );
            }),
      );

      return h('div', { style: S.page }, h('div', { style: S.wrap }, header, granted, h('div', null, actions), details, auditCard));
    }

    // ---------------- 设置页：范围挡位与 TTL（全局策略） ----------------
    /** 作用：DSH 设置 →「能力授权」页。这里放的是**全局**策略（默认范围挡位、TTL 上下限），
     * 不放进会话 tab——同一个值影响所有会话，放进某个会话里会误导成"只对这个会话生效"。
     * 只能改三项：defaultScope / defaultTtlSeconds / maxTtlSeconds（与 PATCH /api/config 完全一致）；
     * enabled、rules、defaultScopePaths、sweepIntervalMs 属部署配置，页面只读展示并说明去哪改。 */
    function GuardSettingsSection() {
      const [config, setConfig] = React.useState(null);
      const [host, setHost] = React.useState(null);
      const [scope, setScope] = React.useState('');
      const [ttlDefault, setTtlDefault] = React.useState('');
      const [ttlMax, setTtlMax] = React.useState('');
      const [saving, setSaving] = React.useState('');
      const [message, setMessage] = React.useState('');

      const apply = function (body) {
        setConfig(body);
        const policy = body && body.policy ? body.policy : null;
        if (policy) {
          setScope(policy.defaultScope);
          setTtlDefault(String(policy.defaultTtlSeconds));
          setTtlMax(String(policy.maxTtlSeconds));
        }
      };

      React.useEffect(function () {
        let alive = true;
        const load = async function () {
          try {
            const base = await probeConsoleHost();
            if (!alive || !base) return;
            const body = await fetchJson(base, '/api/config');
            if (!alive) return;
            setHost(base);
            apply(body);
          } catch (err) {
            if (alive) setMessage('治理接口暂时不可达');
          }
        };
        void load();
        return function () {
          alive = false;
        };
      }, []);

      const patch = async function (payload, key) {
        if (saving || !host) return;
        setSaving(key);
        setMessage('');
        try {
          const body = await fetchJson(host, '/api/config', {
            method: 'PATCH',
            headers: { 'content-type': 'application/json', 'x-dsh-guard': '1' },
            body: JSON.stringify(payload),
          });
          apply(body);
          setMessage('已生效（修订号 ' + (body.policy ? body.policy.revision : '?') + '）');
        } catch (err) {
          setMessage('未应用：' + (err && err.message ? err.message : String(err)));
        } finally {
          setSaving('');
        }
      };

      if (!config) {
        return h('div', { style: S.page }, h('div', { style: S.wrap }, h('div', { style: S.empty }, message || '正在读取配置…')));
      }
      const policy = config.policy || null;
      const modes = Array.isArray(config.modes) ? config.modes : [];
      const rules = policy && Array.isArray(policy.rules) ? policy.rules : [];
      const current = modes.find(function (mode) {
        return mode.id === scope;
      });
      const ttlNumber = function (value) {
        const parsed = Number(value);
        return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
      };

      const scopeCard = h(
        'div',
        { style: S.card },
        h('div', { style: S.title }, '默认范围挡位'),
        h('div', { style: S.note }, '决定「你批准一次」之后，同一个工具在多大范围内可以不用再问。只影响之后新签发的授权，不会扩大已经存在的授权。'),
        h(
          'div',
          { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', marginTop: '10px' } },
          h(
            'select',
            {
              value: scope,
              onChange: function (event) {
                setScope(event.target.value);
              },
              style: { font: 'inherit', fontSize: '12.5px', padding: '5px 8px', borderRadius: '6px', border: '1px solid ' + COLORS.line2, background: 'transparent', color: COLORS.fg },
            },
            modes.map(function (mode) {
              return h('option', { key: mode.id, value: mode.id, disabled: !mode.defaultable }, mode.label + (mode.defaultable ? '' : '（不能作为默认值）'));
            }),
          ),
          h(
            'button',
            { type: 'button', style: S.btn, disabled: saving !== '', onClick: function () { void patch({ defaultScope: scope }, 'scope'); } },
            saving === 'scope' ? '应用中…' : '应用挡位',
          ),
        ),
        current
          ? h(
              'div',
              { style: { marginTop: '8px', fontSize: '12px', color: COLORS.fg2 } },
              current.summary + (current.risk === 'wide' || current.risk === 'escalation' ? '（范围较宽，请谨慎）' : ''),
            )
          : null,
      );

      const ttlCard = h(
        'div',
        { style: S.card },
        h('div', { style: S.title }, '授权有效期'),
        h('div', { style: S.note }, '默认 TTL 用于新签发的授权；上限是任何规则都不得越过的硬边界。'),
        h(
          'div',
          { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', marginTop: '10px' } },
          h('span', { style: S.note }, '默认（秒）'),
          h('input', { value: ttlDefault, onChange: function (e) { setTtlDefault(e.target.value); }, type: 'number', min: '1', style: Object.assign({}, S.input) }),
          h('span', { style: S.note }, '上限（秒）'),
          h('input', { value: ttlMax, onChange: function (e) { setTtlMax(e.target.value); }, type: 'number', min: '1', style: Object.assign({}, S.input) }),
          h(
            'button',
            {
              type: 'button',
              style: S.btn,
              disabled: saving !== '',
              onClick: function () {
                const payload = {};
                const d = ttlNumber(ttlDefault);
                const m = ttlNumber(ttlMax);
                if (d !== null) payload.defaultTtlSeconds = d;
                if (m !== null) payload.maxTtlSeconds = m;
                if (payload.defaultTtlSeconds === undefined && payload.maxTtlSeconds === undefined) {
                  setMessage('请输入正整数秒数');
                  return;
                }
                void patch(payload, 'ttl');
              },
            },
            saving === 'ttl' ? '应用中…' : '应用有效期',
          ),
        ),
      );

      const readOnlyCard = h(
        'div',
        { style: S.card },
        h('div', { style: S.title }, '部署配置（只读）'),
        h('div', { style: S.note }, '这些项属于插件配置（profile 的 cordis.patch.yml），页面刻意不能改：页面不能关掉 Guard，也不能凭空给某个工具造一条授权规则。'),
        h(
          'div',
          { style: { marginTop: '8px', fontSize: '12px' } },
          h('div', null, '总开关：' + (policy && policy.enabled ? '已启用' : '已关闭（页面不可修改）')),
          h('div', null, '档位自动回滚：' + (config.sweep && config.sweep.intervalMs > 0 ? '每 ' + Math.round(config.sweep.intervalMs / 1000) + ' 秒检查一次' : '已关闭（只在下次工具调用或手动收回时回滚）')),
          h('div', null, '配置来源：' + (policy ? policy.source : '-') + ' · 修订号 ' + (policy ? policy.revision : '-')),
        ),
        rules.length === 0
          ? h('div', { style: { marginTop: '8px', fontSize: '12px', color: COLORS.fg2 } }, '没有工具级规则：所有工具都使用上面的默认挡位与有效期。')
          : h(
              'div',
              { style: { marginTop: '10px' } },
              rules.map(function (rule) {
                return h(
                  'div',
                  { key: rule.match + rule.scopeMode, style: { fontSize: '12px', padding: '3px 0', borderTop: '1px solid ' + COLORS.line } },
                  rule.match + ' · ' + rule.scopeMode + ' · ' + rule.ttlSeconds + ' 秒' + (rule.enabled ? '' : '（已停用）'),
                );
              }),
            ),
      );

      return h(
        'div',
        { style: S.page },
        h(
          'div',
          { style: S.wrap },
          h('div', { style: { fontSize: '15px', fontWeight: 600 } }, '能力授权'),
          h('div', { style: S.note }, '这里的改动立即生效，但不会写进配置文件（重启后回到插件配置的值）。'),
          scopeCard,
          ttlCard,
          readOnlyCard,
          message ? h('div', { style: S.note }, message) : null,
        ),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // ① 对话内提示条（一眼可见，不需要点开）
        ctx.slots.inject('conversation.input.dock', () =>
          ctx.slots.register({ name: 'conversation.input.dock', id: GUARD_ID, order: DOCK_ORDER, label: '能力授权' }, GuardDock),
        );
        // ② 会话内的「能力授权」tab（详情页，排在 对话 / 轨迹 之后）
        ctx.slots.inject('conversation.view', () =>
          ctx.slots.register({ name: 'conversation.view', id: GUARD_ID, order: VIEW_ORDER, label: '能力授权' }, GuardSessionView),
        );
        // ③ 设置页：范围挡位与 TTL（全局策略，跟具体会话无关，所以放设置而不是会话 tab）
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register({ name: 'settings.section', id: GUARD_ID, order: SETTINGS_ORDER, label: '能力授权' }, GuardSettingsSection),
        );
      },
    };
  },
});
