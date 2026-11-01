/**
 * DSH Capability Guard — DSH Web 客户端半边（浏览器侧）。
 *
 * 作用：把「这个会话现在被临时放开了什么、还剩多久、到期会怎样、怎么提前收回」放进对话界面本身，
 * 用户不需要去找任何"全局中台"。两层：
 *
 *   ① 【一眼】对话内常驻提示条（`conversation.input.dock`，输入框上方）：不点击就能看到四个问题的答案，
 *      并直接「提前收回」。该槽位是 list + `replaceRisk: none`，只追加，不覆盖 DSH 自带的 todo/goal/queue。
 *   ② 【详情】会话内的「能力授权」tab（`conversation.view`，排在 对话 / 轨迹 之后）：
 *      展示本会话的指标与逐条审计（一行一条）；收回 / 回滚动作只在提示条上。
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
    /** 作用：取档位中文名——宿主已在快照里下发 currentModeText / baselineModeText，
     * 前端刻意不再维护「只读 / 工作区可写 / 完全访问」的映射表；缺失时退回机器值。 */
    function sandboxModeName(sandbox, field) {
      if (!sandbox) return '未知';
      if (field === 'baseline') return sandbox.baselineModeText || sandbox.baselineMode || '未知';
      return sandbox.currentModeText || sandbox.currentMode || '未知';
    }

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
          title: '临时授权已经到期，但权限还停在「' + sandboxModeName(sandbox) + '」，没有收回。',
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
        const saved = view.stats && view.stats.savedApprovals ? view.stats.savedApprovals : 0;
        return {
          tone: expired ? 'warn' : 'active',
          dot: expired ? '⏳' : '●',
          title: title,
          sub: expired ? '正在核对是否已经收回…' : '还剩 ' + fmtCn(remaining) + ' · ' + after + (saved > 0 ? ' · 已少点 ' + saved + ' 次批准' : ''),
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
          title: '已收回：本会话的临时授权结束了，权限已回到「' + sandboxModeName(sandbox) + '」。',
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
          title: '你手动把权限改成了「' + sandboxModeName(sandbox) + '」，临时授权不会覆盖你的设置。',
          sub: '之后的同类操作会重新征求你的同意。',
        };
      }
      if (auth.state === 'expired' || auth.state === 'revoked') {
        // 授权刚结束：没有可操作的东西，审计里能看到记录 → 不占用输入框上方空间
        return null;
      }
      // 没有任何临时授权时【不再显示占位行】（2026-10-31 改定）：输入框左侧的模式 chip 已经
      // 常驻显示"能力授权存在且当前是哪一档"，这里再写一句"没有临时放开的操作"纯属噪声。
      return null;
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

      // 2026-10-31 项目所有者要求：移除对话内提示条。
      // 信息已由「输入框左侧模式 chip（同操作/同族/免打扰·倒计时）」与「能力授权 tab」承担，
      // 这里不再渲染任何内容（下一步会连同槽位注册一起删除）。
      return null;
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
    // 测试用接口：面板模型是纯函数（防止"漏声明变量 → 整页空白"那类渲染期错误）
    GuardSessionView.buildModel = buildPanelModel;

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
      select: { font: 'inherit', fontSize: '12.5px', padding: '5px 8px', borderRadius: '6px', border: '1px solid ' + COLORS.line2, background: 'transparent', color: COLORS.fg, width: 'auto' },
      btnStop: { font: 'inherit', fontSize: '12.5px', padding: '5px 12px', borderRadius: '6px', border: '1px solid ' + COLORS.bad, background: 'transparent', color: COLORS.bad, cursor: 'pointer' },
      note: { color: COLORS.fg2, fontSize: '12px' },
      grant: { borderTop: '1px solid ' + COLORS.line, paddingTop: '10px', marginTop: '10px' },
      grantTitle: { fontWeight: 600 },
      code: { fontFamily: 'ui-monospace,SFMono-Regular,Consolas,monospace', fontSize: '11.5px', wordBreak: 'break-all' },
      auditRow: { display: 'grid', gridTemplateColumns: '78px 150px 1fr', gap: '8px', padding: '3px 0', fontSize: '12px', color: COLORS.fg2 },
      empty: { border: '1px dashed ' + COLORS.line, borderRadius: '8px', padding: '14px', color: COLORS.fg2 },
    };

    /** 作用：紧凑倒计时（3:07 / 1:02:33）——用于 chip，不参与任何判定。 */
    function clockText(ms) {
      const total = Math.max(0, Math.floor(ms / 1000));
      const h = Math.floor(total / 3600);
      const m = Math.floor((total % 3600) / 60);
      const s = total % 60;
      const pad = function (n) {
        return n < 10 ? '0' + n : String(n);
      };
      return h > 0 ? h + ':' + pad(m) + ':' + pad(s) : m + ':' + pad(s);
    }
    /**
     * 作用：把「授权决策记录」折算成面板要展示的模型（纯函数，便于单测）。
     * 之前这段逻辑直接写在组件里，漏声明一个状态变量就会让整个 tab 渲成空白（2026-10-31 实测）。
     * @param records 决策记录（/api/decisions 的 records）
     * @param rangeDays 时间范围（天），0 = 全部
     * @param now 当前时间戳
     */
    function buildPanelModel(records, rangeDays, now) {
      const list = Array.isArray(records) ? records : [];
      const cutoff = rangeDays > 0 ? now - rangeDays * 86_400_000 : 0;
      const rows = list.filter(function (record) { return record.grantedAt >= cutoff; });
      const reuse = { exact: 0, family: 0, window: 0 };
      let saved = 0;
      let longestWindowMs = 0;
      let activeCount = 0;
      const familyCounts = new Map();
      for (const record of rows) {
        saved += record.uses || 0;
        longestWindowMs = Math.max(longestWindowMs, record.windowMs || 0);
        if (record.outcome === 'active') activeCount += 1;
        if (record.uses > 0) {
          if (record.kind === 'sandbox-mode') reuse.window += record.uses;
          else if (record.familyLabel) {
            reuse.family += record.uses;
            familyCounts.set(record.familyLabel, (familyCounts.get(record.familyLabel) || 0) + record.uses);
          } else reuse.exact += record.uses;
        }
      }
      const total = rows.length;
      const reuseRate = total + saved > 0 ? Math.round((saved / (total + saved)) * 100) : 0;
      const topFamilies = [...familyCounts.entries()].sort(function (a, b) { return b[1] - a[1]; }).slice(0, 3);
      return {
        rows,
        topFamilies,
        metrics: [
          { label: '人工批准', value: String(total), unit: '次' },
          { label: '命中复用', value: String(saved), unit: '次' },
          { label: '复用率', value: String(reuseRate), unit: '%' },
          { label: '生效中', value: String(activeCount), unit: '条' },
          { label: '精确 / 族 / 免打扰', value: reuse.exact + ' / ' + reuse.family + ' / ' + reuse.window, unit: '次' },
          { label: '最长放开', value: longestWindowMs > 0 ? fmtCn(longestWindowMs) : '-', unit: '' },
          { label: '最常命中族', value: topFamilies.length > 0 ? topFamilies.map(function (f) { return f[0] + '×' + f[1]; }).join('，') : '-', unit: '' },
        ],
      };
    }
    /** 作用：会话内的「能力授权」详情页（conversation.view，排在 对话 / 轨迹 之后）。
     * 数据来自 GET /api/snapshot?session=<id>（实时状态）与 GET /api/decisions?sessionId=<id>
     * （授权决策日志：一条授权一份记录）。都只读。 */
    function GuardSessionView(props) {
      const sessionId = props && props.sessionId
        ? String(props.sessionId)
        : props && props.session && props.session.id
          ? String(props.session.id)
          : '';
      const [snapshot, setSnapshot] = React.useState(null);
      const [decisions, setDecisions] = React.useState(null);
      /** 指标与审计的时间范围（天）：0 = 全部。默认近 30 天，避免历史测试数据污染指标。 */
      const [rangeDays, setRangeDays] = React.useState(30);
      const [message, setMessage] = React.useState('');
      /** 每秒强制刷新一次，让审计表里的「剩余」实时走秒（状态值本身不参与渲染）。 */
      const [, setNowTick] = React.useState(0);

      React.useEffect(
        function () {
          if (!sessionId) return undefined;
          let alive = true;
          const load = async function () {
            try {
              const base = await probeConsoleHost();
              if (!alive || !base) return;
              const [snap, decisionBody] = await Promise.all([
                fetchJson(base, '/api/snapshot?session=' + encodeURIComponent(sessionId)),
                fetchJson(base, '/api/decisions?sessionId=' + encodeURIComponent(sessionId) + '&limit=' + AUDIT_LIMIT),
              ]);
              if (!alive) return;
              setHost(base);
              setSnapshot(snap);
              setDecisions(decisionBody);
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
      if (!view) {
        return h('div', { style: S.page }, h('div', { style: S.wrap }, h('div', { style: S.empty }, message || '正在读取本会话的授权状态…')));
      }

      // ---- 授权决策日志（一条授权一份记录）----
      const records = decisions && Array.isArray(decisions.records) ? decisions.records : [];

      // ---- 指标区（自进化用）：纯函数算模型，便于单测（见 GuardSessionView.buildModel）----
      const model = buildPanelModel(records, rangeDays, Date.now());
      const rows = model.rows;
      const metricCards = model.metrics.map(function (item) { return [item.label, item.value, item.unit]; });
      const metricsCard = h(
        'div',
        { style: S.card },
        h('div', { style: S.title }, '指标'),
        h(
          'div',
          { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '10px', marginTop: '8px' } },
          metricCards.map(function (item) {
            return h(
              'div',
              { key: item[0], style: { padding: '10px', borderRadius: '8px', border: '1px solid ' + COLORS.line } },
              h('div', { style: S.note }, item[0]),
              h('div', { style: { fontSize: '16px', fontWeight: '600', marginTop: '2px' } }, item[1] + (item[2] ? ' ' + item[2] : '')),
            );
          }),
        ),
      );

      // ---- 审计区：一行一条 ----
      const nowMs = Date.now();
      const cell = { padding: '6px 8px', fontSize: '12px', borderBottom: '1px solid ' + COLORS.line, verticalAlign: 'top' };
      const headCell = Object.assign({}, cell, { color: COLORS.fg2, fontWeight: '600' });
      const columns = ['时间', '命令', '模式', '命中方式', '审批方式', '剩余'];
      const auditCard = h(
        'div',
        { style: S.card },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
          h('div', { style: S.title }, '审计'),
          h(
            'select',
            { value: String(rangeDays), onChange: function (event) { setRangeDays(Number(event.target.value)); }, style: Object.assign({}, S.select, { width: '110px', marginLeft: 'auto' }) },
            h('option', { value: '7' }, '近 7 天'),
            h('option', { value: '30' }, '近 30 天'),
            h('option', { value: '90' }, '近 90 天'),
            h('option', { value: '0' }, '全部'),
          ),
        ),
        rows.length === 0
          ? h('div', { style: S.empty }, '所选时间范围内还没有记录。你批准一次之后，这里会出现一条。')
          : h(
              'div',
              { style: { overflowX: 'auto', marginTop: '8px' } },
              h(
                'table',
                { style: { borderCollapse: 'collapse', width: '100%' } },
                h('thead', null, h('tr', null, columns.map(function (name) { return h('th', { key: name, style: Object.assign({}, headCell, { textAlign: 'left' }) }, name); }))),
                h(
                  'tbody',
                  null,
                  rows.map(function (record) {
                    const remaining = record.outcome === 'active' ? Math.max(0, record.expiresAt - nowMs) : 0;
                    const modeText = record.kind === 'sandbox-mode' ? '免打扰' : '短期授权';
                    const hitText = record.familyLabel ? '族：' + record.familyLabel : '精确';
                    const approvalText = '人工' + (record.uses > 0 ? ' + 复用 ' + record.uses + ' 次' : '');
                    const leftText = record.outcome === 'active' ? fmtCn(remaining) : record.outcome === 'revoked' ? '已收回' : '已过期';
                    // 完整命令保留在 title 里（悬停/长按可看全文）；列表内只显示单行摘要
                    const fullCommand = String(record.reason || record.capability || '');
                    const command = fullCommand.replace(/\s+/g, ' ').slice(0, 90);
                    return h(
                      'tr',
                      { key: record.leaseId, style: record.outcome === 'active' ? null : { opacity: 0.6 } },
                      h('td', { style: cell }, fmtTime(record.grantedAt)),
                      h('td', { style: Object.assign({}, cell, { maxWidth: '360px', fontFamily: 'ui-monospace, monospace', cursor: 'help' }), title: fullCommand }, command),
                      h('td', { style: cell }, modeText),
                      h('td', { style: cell }, hitText),
                      h('td', { style: cell }, approvalText),
                      h('td', { style: cell }, leftText),
                    );
                  }),
                ),
              ),
            ),
      );

      return h('div', { style: S.page }, h('div', { style: S.wrap }, metricsCard, auditCard));
    }

    /** 作用：输入框工具栏左侧的授权模式控件（conversation.input.left）——**可直接操作**：
     * 下拉三选一（授权关闭 / 短期授权 / 免打扰）+ 时长输入；免打扰选中即开始，不需要额外的「开始」按钮。
     * 不抢占原生沙箱档位控件（conversation.input.permission），避免遮蔽 DSH 自带 UI。 */
    function GuardModeChip(props) {
      const sessionId = props && props.sessionId ? String(props.sessionId) : '';
      const [settings, setSettings] = React.useState(null);
      const [reachable, setReachable] = React.useState(true);
      const [host, setHost] = React.useState(null);
      const [guardModes, setGuardModes] = React.useState([]);
      /** 时间单位：秒 / 分 / 时（只影响输入框显示，落库统一用秒） */
      const [unit, setUnit] = React.useState('m');
      const [busy, setBusy] = React.useState(false);
      // 免打扰：从会话快照里取窗口授权还剩多久（到期后自动回落到短期授权语义）
      const [dndRemaining, setDndRemaining] = React.useState(0);
      React.useEffect(function () {
        const timer = setInterval(function () {
          setDndRemaining(function (value) {
            return value > 0 ? Math.max(0, value - 1000) : 0;
          });
        }, 1000);
        return function () {
          clearInterval(timer);
        };
      }, []);
      React.useEffect(
        function () {
          let alive = true;
          const load = async function () {
            try {
              const base = await probeConsoleHost();
              if (!alive) return;
              if (!base) {
                setReachable(false);
                return;
              }
              const cfg = await fetchJson(base, '/api/config');
              if (!alive) return;
              setSettings(cfg && cfg.settings ? cfg.settings : null);
              setHost(base);
              setGuardModes(cfg && cfg.catalog && Array.isArray(cfg.catalog.guardModes) ? cfg.catalog.guardModes : []);
              setReachable(true);
              const isDnd = cfg && cfg.settings && cfg.settings.mode === 'do-not-disturb';
              if (isDnd && sessionId) {
                const snap = await fetchJson(base, '/api/snapshot?session=' + encodeURIComponent(sessionId));
                if (!alive) return;
                const view = viewOf(snap, sessionId);
                const nextExpiresAt = view && view.auth ? view.auth.nextExpiresAt : undefined;
                setDndRemaining(typeof nextExpiresAt === 'number' ? Math.max(0, nextExpiresAt - Date.now()) : 0);
              } else {
                setDndRemaining(0);
              }
            } catch (err) {
              if (alive) setReachable(false);
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
      if (!reachable) return null;
      if (!settings) return null;
      const mode = settings.mode || 'same-operation';
      const off = settings.enabled === false;
      const current = off ? 'off' : mode;
      const tone = off ? COLORS.idle : mode === 'do-not-disturb' ? COLORS.warn : COLORS.ok;
      const seconds = mode === 'do-not-disturb' ? settings.dndDurationSeconds : settings.reuseTtlSeconds;
      const FACTOR = { s: 1, m: 60, h: 3600 };
      const amount = Math.max(1, Math.round(seconds / FACTOR[unit]));
      const save = async function (patch) {
        if (!host || busy) return;
        setBusy(true);
        try {
          await fetchJson(host, '/api/config', {
            method: 'PATCH',
            headers: { 'content-type': 'application/json', 'x-dsh-guard': '1' },
            body: JSON.stringify({ settings: patch }),
          });
          const cfg = await fetchJson(host, '/api/config');
          setSettings(cfg && cfg.settings ? cfg.settings : null);
        } catch (err) {
          // 静默：下一次轮询会恢复真实状态
        } finally {
          setBusy(false);
        }
      };
      const startWindow = async function () {
        if (!host || busy || !sessionId) return;
        setBusy(true);
        try {
          // 只开时间窗，不修改沙箱档位（档位保持 DSH 原生控件里用户设定的值）
          await fetchJson(host, '/api/dnd', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-dsh-guard': '1' },
            body: JSON.stringify({ sessionId: sessionId, ttlSeconds: settings.dndDurationSeconds }),
          });
          const cfg = await fetchJson(host, '/api/config');
          setSettings(cfg && cfg.settings ? cfg.settings : null);
        } catch (err) {
          // 静默：失败时保持原状态，下一次轮询会拉回真实值
        } finally {
          setBusy(false);
        }
      };
      const onModeChange = function (event) {
        const value = event.target.value;
        if (value === 'off') return void save({ enabled: false });
        if (value === 'do-not-disturb') {
          void save({ enabled: true, mode: 'do-not-disturb' }).then(startWindow);
          return;
        }
        void save({ enabled: true, mode: 'same-operation' });
      };
      const onAmountChange = function (event) {
        const value = Number(event.target.value);
        if (!Number.isInteger(value) || value <= 0) return;
        const target = value * FACTOR[unit];
        void save(mode === 'do-not-disturb' ? { dndDurationSeconds: target } : { reuseTtlSeconds: target });
      };
      const selectStyle = { fontSize: '12px', padding: '2px 4px', borderRadius: '6px', border: '1px solid ' + COLORS.line, background: 'transparent', color: tone, cursor: 'pointer' };
      const inputStyle = { width: '48px', fontSize: '12px', padding: '2px 4px', borderRadius: '6px', border: '1px solid ' + COLORS.line, background: 'transparent', color: COLORS.fg2 };
      return h(
        'span',
        { style: { display: 'inline-flex', alignItems: 'center', gap: '6px', whiteSpace: 'nowrap' } },
        h('span', { style: { width: '6px', height: '6px', borderRadius: '3px', background: tone } }),
        h(
          'select',
          { value: current, onChange: onModeChange, disabled: busy, style: selectStyle, title: settings.modeSummary || '' },
          (Array.isArray(guardModes) && guardModes.length > 0 ? guardModes : [{ id: 'same-operation', label: settings.modeLabel || '短期授权' }]).map(function (item) {
            return h('option', { key: item.id, value: item.id }, item.label);
          }),
        ),
        off
          ? null
          : h('input', { type: 'number', min: '1', defaultValue: String(amount), onBlur: onAmountChange, style: inputStyle, title: mode === 'do-not-disturb' ? '免打扰时长' : '复用时长' }),
        off
          ? null
          : h(
              'select',
              { value: unit, onChange: function (event) { setUnit(event.target.value); }, disabled: busy, style: selectStyle, title: '时间单位' },
              h('option', { key: 's', value: 's' }, '秒'),
              h('option', { key: 'm', value: 'm' }, '分'),
              h('option', { key: 'h', value: 'h' }, '时'),
            ),
        !off && mode === 'do-not-disturb'
          ? h('span', { style: { fontSize: '11px', color: dndRemaining > 0 ? COLORS.warn : COLORS.idle } }, dndRemaining > 0 ? clockText(dndRemaining) : '已结束')
          : null,
      );
    }


    return {
      inject: ['slots'],
      apply(ctx) {
        // ① 对话内提示条（一眼可见，不需要点开）
        ctx.slots.inject('conversation.input.dock', () =>
          ctx.slots.register({ name: 'conversation.input.dock', id: GUARD_ID, order: DOCK_ORDER, label: '能力授权' }, GuardDock),
        );
        // ② 输入框工具栏左侧的模式 chip（紧挨原生档位控件，不抢占它）
        ctx.slots.inject('conversation.input.left', () =>
          ctx.slots.register({ name: 'conversation.input.left', id: GUARD_ID + '-mode', order: 0, label: '能力授权模式' }, GuardModeChip),
        );
        // ③ 会话内的「能力授权」tab（配置 + 状态 + 审计 + 统计，唯一的用户入口）
        ctx.slots.inject('conversation.view', () =>
          ctx.slots.register({ name: 'conversation.view', id: GUARD_ID, order: VIEW_ORDER, label: '能力授权' }, GuardSessionView),
        );
        // 设置页不再注册：配置已全部搬到会话内「能力授权」（2026-10-31 产品决定）
      },
    };
  },
});
