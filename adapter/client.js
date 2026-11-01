/**
 * DSH Capability Guard — DSH Web 客户端半边（浏览器侧）。
 *
 * 作用：把「这个会话现在被临时放开了什么、还剩多久、到期会怎样、怎么提前收回」放进对话界面本身，
 * 用户不需要去找任何"全局中台"。三个入口（其中 ② 目前不渲染，保留备用）：
 *
 *   ① 【挡位】输入框工具栏里的授权挡位控件（`conversation.input.left`，紧挨 DSH 原生沙箱档位）：
 *      28px 按钮 + 原生 Menu，切换 授权关闭 / 短期授权 / 免打扰；免打扰窗口内显示倒计时。
 *   ② 【一眼】对话内提示条（`conversation.input.dock`）：目前不渲染（文案判定与样式保留备用）。
 *   ③ 【详情】会话内的「能力授权」tab（`conversation.view`，排在 对话 / 轨迹 之后）：
 *      展示本会话的指标、两档时长设置与逐条审计（一行一条）。
 *
 * 三个入口都拿到宿主直接传入的 `sessionId`，因此**显示的一定是当前会话**，不存在串会话或"最近活动"推断。
 *
 * 约束（刻意遵守，避免把界面做成新的权限入口）：
 *   - 写操作只允许两个方向，且都必须由用户点击触发：① 用户切换挡位（PATCH /api/config；
 *     免打扰还会 POST /api/dnd 开一个有界窗口）；② 用户点「收回」（纯收缩的 POST /api/revoke）。
 *     任何写操作都不得由状态变化自动发起；
 *   - 不做任何「替用户批准某一次具体调用」的动作（审批本身只走 DSH 原生流程）；
 *   - 输入框挡位控件复用 DSH Client 原生的 Menu 与图标（与旁边沙箱档位控件**完全同一套**），
 *     不再自己画下拉框——原生控件就在同一个工具行里，任何自绘样式都会显得割裂；
 *   - 所有动态内容走 React 文本子节点（等价于 textContent），不触碰 document.body；
 *   - 治理接口不可达时保持安静（不弹错误、不干扰对话）。
 */
window.__ModuleLoader__.load({
  id: '@dsh-capsule/adapter',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    // 原生组件的唯一来源：DSH Web 的静态模块表（web boot 的 staticModules）里就包含
    // @deepseek-ai/dsh-client-ui-primitives。旁边的沙箱档位控件（dsh-client-ui-permission-presets）
    // 也是 require 同一个包，所以这里不存在"多引入一个依赖"的问题；反之若它缺失，整个工具行
    // （含原生档位控件）都无法渲染。
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives');
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

    /** 作用：注入插件自有样式（只注入一次；带令牌兜底，脱离主题也能读）。
     *  挡位按钮的几何与配色逐项对齐 DSH 原生沙箱档位控件（dsh-client-ui-permission-presets）：
     *  高 28px、13px/500、label-secondary、radius-sm、14px 图标 + 14px 箭头、hover 用交互底色、
     *  focus-visible 用原生焦点环。这样两个控件并排时不会出现"高矮胖瘦不一样"的割裂感。 */
    function injectGuardStyles(doc) {
      if (!doc || !doc.head || doc.getElementById('dsh-guard-style')) return;
      const style = doc.createElement('style');
      style.id = 'dsh-guard-style';
      style.textContent = [
        // 对话内提示条（目前不渲染；样式保留，避免将来恢复时找不到）
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
        // 输入框挡位控件（与原生沙箱档位按钮同尺寸）
        '.dsh-guard-mode-trigger{border-radius:var(--dsw-radius-sm,6px);min-width:0;max-width:220px;height:28px;color:var(--dsw-alias-label-secondary,#59636e);cursor:pointer;background:0 0;border:none;outline:none;align-items:center;gap:4px;padding:0 4px 0 8px;font-size:13px;font-weight:500;line-height:20px;display:inline-flex;font-family:inherit}',
        '.dsh-guard-mode-trigger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}',
        '.dsh-guard-mode-trigger:focus-visible{box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#0969da))}',
        '.dsh-guard-mode-trigger:disabled{color:var(--dsw-alias-label-dimmed,#8c959f);cursor:default}',
        '.dsh-guard-mode-icon{flex:none;display:inline-flex}',
        '.dsh-guard-mode-icon svg{width:14px;height:14px}',
        '.dsh-guard-mode-label{text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden}',
        '.dsh-guard-mode-time{flex:none;margin-left:2px;font-size:12px;color:var(--dsw-alias-label-tertiary,#8b949e);font-variant-numeric:tabular-nums}',
        '.dsh-guard-mode-chevron{flex:none;display:inline-flex;color:var(--dsw-alias-label-caption,#8b949e);transition:transform .12s}',
        '.dsh-guard-mode-chevron svg{width:14px;height:14px}',
        '.dsh-guard-mode-chevron[data-open=true]{transform:rotate(180deg)}',
        // 与原生沙箱档位控件同一套窄屏规则：工具行放不下时只留图标（容器查询由 composer 行提供）
        '@container (max-width:460px){.dsh-guard-mode-trigger:has(.dsh-guard-mode-icon) .dsh-guard-mode-label{display:none}}',
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
          injectGuardStyles(typeof document !== 'undefined' ? document : undefined);
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
      settingRow: { display: 'flex', alignItems: 'center', gap: '12px', padding: '9px 0', borderBottom: '1px dashed ' + COLORS.line },
      settingMain: { flex: '1 1 auto', minWidth: 0 },
      rowTitle: { fontWeight: 600 },
      rowDesc: { color: COLORS.fg2, fontSize: '12px' },
      settingControl: { display: 'flex', alignItems: 'center', gap: '6px', flex: '0 0 auto' },
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
    const TIME_UNITS = [
      { id: 's', label: '秒', factor: 1 },
      { id: 'm', label: '分', factor: 60 },
      { id: 'h', label: '时', factor: 3600 },
    ];
    /** 作用：秒数最适合的显示单位——整小时用小时，整分用分钟，其余用秒（只影响显示，落库永远是秒）。 */
    function autoTimeUnit(seconds) {
      if (!(seconds > 0)) return 's';
      if (seconds % 3600 === 0) return 'h';
      if (seconds % 60 === 0) return 'm';
      return 's';
    }
    function timeFactor(unit) {
      for (const item of TIME_UNITS) {
        if (item.id === unit) return item.factor;
      }
      return 1;
    }
    /** 作用：把秒数换算成该单位下的精确数值串（90 秒 → "1.5" 分），避免四舍五入造成"看一眼就变值"。 */
    function timeAmount(seconds, unit) {
      const value = (seconds || 0) / timeFactor(unit);
      return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
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
          { label: '精确 / 族 / 沙箱', value: reuse.exact + ' / ' + reuse.family + ' / ' + reuse.window, unit: '次' },
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
      /** /api/config：用户设置（复用时长 / 免打扰时长）与运行期上限；未注入时设置卡片整块不渲染。 */
      const [config, setConfig] = React.useState(null);
      const [host, setHost] = React.useState(null);
      const [settingsMessage, setSettingsMessage] = React.useState('');
      /** 免打扰卡片上的按钮在请求中时禁用（不阻塞整页轮询） */
      const [dndBusy, setDndBusy] = React.useState(false);
      /** 时长输入框的单位：null = 按保存值自动挑（整小时→时、整分→分、其余→秒）。 */
      const [unitPick, setUnitPick] = React.useState({ reuse: null, dnd: null });
      /** 保存失败时递增：让不受控输入框按 key 重挂载，回到服务端的真实值（不留下没保存的假数字）。 */
      const [resetTick, setResetTick] = React.useState(0);
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
              const [snap, decisionBody, cfg] = await Promise.all([
                fetchJson(base, '/api/snapshot?session=' + encodeURIComponent(sessionId)),
                fetchJson(base, '/api/decisions?sessionId=' + encodeURIComponent(sessionId) + '&limit=' + AUDIT_LIMIT),
                fetchJson(base, '/api/config'),
              ]);
              if (!alive) return;
              setSnapshot(snap);
              setDecisions(decisionBody);
              setConfig(cfg);
              setHost(base);
              setMessage('');
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
      const nowMs = Date.now();
      const settings = config && config.settings ? config.settings : null;

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

      // ---- 免打扰卡片（仅窗口存在时出现）：状态 / 剩余 / 已放行记录 / 结束与延长 ----
      const dndView = view.dnd;
      const dndMinutes = Math.max(1, Math.round(((settings && settings.dndDurationSeconds) || 900) / 60));
      const actDnd = async function (path, body) {
        if (!host || dndBusy) return;
        setDndBusy(true);
        try {
          await fetchJson(host, path, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-dsh-guard': '1' },
            body: JSON.stringify(body),
          });
          const snap = await fetchJson(host, '/api/snapshot?session=' + encodeURIComponent(sessionId));
          setSnapshot(snap);
        } catch (err) {
          // 静默：下一轮轮询会恢复真实状态
        } finally {
          setDndBusy(false);
        }
      };
      const dndRemaining = dndView ? Math.max(0, dndView.expiresAt - nowMs) : 0;
      const dndCard = dndView
        ? h(
            'div',
            { style: S.card },
            h(
              'div',
              { style: { display: 'flex', alignItems: 'baseline', gap: '10px' } },
              h('div', { style: S.title }, '免打扰（限时完全访问）'),
              h(
                'div',
                { style: { marginLeft: 'auto', fontSize: '12px', color: dndRemaining > 0 ? COLORS.warn : COLORS.fg2, fontVariantNumeric: 'tabular-nums' } },
                dndRemaining > 0 ? '还剩 ' + fmtCn(dndRemaining) : '已到期，等待结算',
              ),
            ),
            h('div', { style: Object.assign({}, S.rowDesc, { marginTop: '4px' }) }, '窗口内自动批准沙箱升级；不改原生挡位，结束、到期或你手动切换挡位后立即恢复逐次询问。'),
            h('div', { style: { marginTop: '8px', fontSize: '12px', color: COLORS.fg2 } }, '已自动放行 ' + dndView.allowedCount + ' 次'),
            dndView.recent && dndView.recent.length > 0
              ? h(
                  'div',
                  { style: { marginTop: '6px', display: 'flex', flexDirection: 'column', gap: '3px' } },
                  dndView.recent.slice(0, 5).map(function (record) {
                    return h(
                      'div',
                      { key: record.callId + '-' + record.at, style: { fontSize: '12px', color: COLORS.fg2 } },
                      fmtTime(record.at) + ' · ' + record.toolName + ' → ' + record.requestedModeText + ' · ' + String(record.display || '').slice(0, 60),
                    );
                  }),
                )
              : null,
            h(
              'div',
              { style: { display: 'flex', gap: '8px', marginTop: '10px' } },
              h(
                'button',
                { type: 'button', style: S.btn, disabled: dndBusy || !host, onClick: function () { void actDnd('/api/dnd/stop', { sessionId: sessionId }); } },
                dndBusy ? '处理中…' : '结束免打扰',
              ),
              h(
                'button',
                {
                  type: 'button',
                  style: S.btn,
                  disabled: dndBusy || !host,
                  onClick: function () { void actDnd('/api/dnd/extend', { sessionId: sessionId, addSeconds: (settings && settings.dndDurationSeconds) || 900 }); },
                },
                '延长 ' + dndMinutes + ' 分钟',
              ),
            ),
          )
        : null;

      // ---- 设置区：只放两档时长（挡位本身在输入框左侧的控件里切换，见 GuardModeChip）----
      const maxTtlSeconds = config && config.policy && Number.isInteger(config.policy.maxTtlSeconds) ? config.policy.maxTtlSeconds : 0;
      const patchSettings = async function (patch) {
        if (!host) return false;
        try {
          await fetchJson(host, '/api/config', {
            method: 'PATCH',
            headers: { 'content-type': 'application/json', 'x-dsh-guard': '1' },
            body: JSON.stringify({ settings: patch }),
          });
          const cfg = await fetchJson(host, '/api/config');
          if (cfg) setConfig(cfg);
          setSettingsMessage('');
          return true;
        } catch (err) {
          const raw = err && err.message ? String(err.message).replace(/^GUARD_SETTINGS_INVALID:\s*/, '') : '未知错误';
          setSettingsMessage('没有保存：' + (/maxTtlSeconds/.test(raw) ? '超过运行期上限' : raw));
          setResetTick(function (value) {
            return value + 1;
          });
          return false;
        }
      };
      /** 作用：一行「时长」设置（数字 + 单位）；失焦或回车才保存，值没变就不写接口。 */
      const durationRow = function (field, title, desc) {
        const seconds = field === 'reuse' ? settings.reuseTtlSeconds : settings.dndDurationSeconds;
        if (!(seconds > 0)) return null; // 服务端没下发这一项时不渲染，绝不显示一个假数字
        const unit = unitPick[field] || autoTimeUnit(seconds);
        const commit = function (event) {
          const amount = Number(event.target.value);
          if (!(amount > 0)) {
            setResetTick(function (value) {
              return value + 1;
            });
            return;
          }
          const next = Math.round(amount * timeFactor(unit));
          if (!Number.isInteger(next) || next <= 0 || next === seconds) return;
          void patchSettings(field === 'reuse' ? { reuseTtlSeconds: next } : { dndDurationSeconds: next });
        };
        return h(
          'div',
          { key: field, style: S.settingRow },
          h('div', { style: S.settingMain }, h('div', { style: S.rowTitle }, title), h('div', { style: S.rowDesc }, desc)),
          h(
            'div',
            { style: S.settingControl },
            h('input', {
              key: field + '-' + unit + '-' + seconds + '-' + resetTick,
              type: 'number',
              min: '0.01',
              step: 'any',
              defaultValue: timeAmount(seconds, unit),
              disabled: !host,
              'aria-label': title,
              onKeyDown: function (event) {
                if (event.key === 'Enter') event.currentTarget.blur();
              },
              onBlur: commit,
              style: Object.assign({}, S.input, { width: '72px' }),
            }),
            h(
              'select',
              {
                value: unit,
                disabled: !host,
                'aria-label': title + '单位',
                onChange: function (event) {
                  const value = event.target.value;
                  setUnitPick(function (prev) {
                    const nextPick = Object.assign({}, prev);
                    nextPick[field] = value;
                    return nextPick;
                  });
                },
                style: Object.assign({}, S.select, { width: 'auto' }),
              },
              TIME_UNITS.map(function (item) {
                return h('option', { key: item.id, value: item.id }, item.label);
              }),
            ),
          ),
        );
      };
      const settingsCard = settings
        ? h(
            'div',
            { style: S.card },
            h('div', { style: S.title }, '设置'),
            h('div', { style: S.note }, '切换挡位用输入框左侧的控件；这里只调时长，改动立即生效，不写配置文件。'),
            h(
              'div',
              { style: { marginTop: '6px' } },
              durationRow('reuse', '复用时长', '一次批准之后，同类操作在这段时间内不再询问'),
              durationRow('dnd', '免打扰时长', '点「免打扰模式」后，本会话的审批自动放行多久'),
            ),
            settingsMessage ? h('div', { style: { marginTop: '8px', fontSize: '12px', color: COLORS.bad } }, settingsMessage) : null,
            maxTtlSeconds > 0
              ? h('div', { style: { marginTop: '6px', fontSize: '12px', color: COLORS.fg2 } }, '运行期上限：' + fmtCn(maxTtlSeconds * 1000) + '（超过会被拒绝，不做静默裁剪）')
              : null,
          )
        : null;

      // ---- 审计区：一行一条 ----
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
                    const modeText = record.kind === 'sandbox-mode' ? '沙箱授权' : '短期授权';
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

      return h('div', { style: S.page }, h('div', { style: S.wrap }, metricsCard, dndCard, settingsCard, auditCard));
    }

    // ---------------- 输入框工具栏的「能力授权」挡位控件 ----------------
    /** 作用：挡位对应的原生图标（关闭=暂停、短期授权=已批准、免打扰=定时窗口）。
     *  全部取自 DSH Client 原生图标集，与旁边沙箱档位控件的图标同一套笔画与尺寸（14px）。 */
    const GUARD_MODE_ICONS = {
      off: primitives.IconPauseOutlineRegular,
      'same-operation': primitives.IconCheckCircleOutlineRegular,
      'do-not-disturb': primitives.IconAlarmClockOutlineRegular,
    };
    /** 作用：取某个挡位的图标元素；图标组件缺失时返回 null（沿用原生的降级方式：没有图标就不占位）。 */
    function guardModeGlyph(id) {
      const Icon = GUARD_MODE_ICONS[id];
      return Icon ? h(Icon, {}) : null;
    }

    /** 作用：输入框工具栏里的授权挡位控件（conversation.input.left）——与原生沙箱档位控件**长得一样**：
     *  28px 无边框按钮（14px 图标 + 当前挡位 + 14px 箭头），点开是原生 Menu 弹层（向上展开，选中打勾）。
     *  刻意不占用 conversation.input.permission 槽位：那是 DSH 自己的控件，替换它会遮蔽原生档位选择。
     *  免打扰 = 限时完全访问的审批放行窗口：窗口内自动批准沙箱升级；开启前有风险确认，结束立即恢复询问。 */
    function GuardModeChip(props) {
      const sessionId = props && props.sessionId ? String(props.sessionId) : '';
      const [settings, setSettings] = React.useState(null);
      const [modes, setModes] = React.useState([]);
      const [features, setFeatures] = React.useState(null);
      const [dnd, setDnd] = React.useState(null);
      const [sandboxMode, setSandboxMode] = React.useState('');
      const [host, setHost] = React.useState(null);
      const [reachable, setReachable] = React.useState(true);
      const [open, setOpen] = React.useState(false);
      const [busy, setBusy] = React.useState(false);
      /** 风险确认弹窗（免打扰 = 限时完全访问，必须显式确认） */
      const [confirming, setConfirming] = React.useState(false);
      const [acknowledged, setAcknowledged] = React.useState(false);
      const [now, setNow] = React.useState(0);
      React.useEffect(function () {
        injectGuardStyles(typeof document !== 'undefined' ? document : undefined);
      }, []);
      React.useEffect(function () {
        const timer = setInterval(function () {
          setNow(Date.now());
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
              const next = cfg && cfg.settings ? cfg.settings : null;
              setHost(base);
              setSettings(next);
              setModes(cfg && cfg.catalog && Array.isArray(cfg.catalog.guardModes) ? cfg.catalog.guardModes : []);
              setFeatures(cfg && cfg.features ? cfg.features : null);
              setReachable(true);
              if (!sessionId) {
                setDnd(null);
                return;
              }
              const snap = await fetchJson(base, '/api/snapshot?session=' + encodeURIComponent(sessionId));
              if (!alive) return;
              const view = viewOf(snap, sessionId);
              setDnd(view && view.dnd ? view.dnd : null);
              setSandboxMode(view && view.sandbox && view.sandbox.currentMode ? view.sandbox.currentMode : '');
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
      if (!reachable || !settings) return null;
      // 宿主端尚未更新（旧 dist）：不要用新 UI 去调旧接口——显示为"重启后生效"，避免点击静默无效。
      if (!features || features.dndWindow !== true) {
        return h(
          'span',
          {
            className: 'dsh-guard-mode-trigger',
            'data-legacy': 'true',
            title: '宿主端代码已更新：重启 DSH 后启用新的免打扰窗口',
            'aria-label': '能力授权（重启 DSH 后生效）',
            style: { cursor: 'default', opacity: 0.6 },
          },
          guardModeGlyph('off') ? h('span', { className: 'dsh-guard-mode-icon', 'aria-hidden': true }, guardModeGlyph('off')) : null,
          h('span', { className: 'dsh-guard-mode-label' }, '能力授权（重启后生效）'),
        );
      }
      const off = settings.enabled === false;
      const active = dnd && typeof dnd.expiresAt === 'number' && dnd.expiresAt > now;
      const remaining = active ? Math.max(0, dnd.expiresAt - now) : 0;
      const current = off ? 'off' : active ? 'do-not-disturb' : 'same-operation';
      const list =
        Array.isArray(modes) && modes.length > 0
          ? modes
          : [
              { id: 'off', label: '授权关闭', summary: '插件完全不介入，审批恢复 DSH 原生行为' },
              { id: 'same-operation', label: '短期授权', summary: '同一操作 / 同类操作在时限内不再询问' },
              { id: 'do-not-disturb', label: '免打扰', summary: '限时完全访问：窗口内自动批准沙箱升级' },
            ];
      let currentItem;
      for (const item of list) {
        if (item && item.id === current) currentItem = item;
      }
      const label = active ? '免打扰' : currentItem && currentItem.label ? currentItem.label : off ? '授权关闭' : '短期授权';
      const summary = active
        ? '免打扰（限时完全访问）：窗口内自动批准沙箱升级；结束或切换挡位后立即恢复询问'
        : currentItem && currentItem.summary
          ? currentItem.summary
          : '';
      const minutes = Math.max(1, Math.round((settings.dndDurationSeconds || 900) / 60));
      const fullAccess = sandboxMode === 'danger-full-access';
      const withIcon = function (item, iconId) {
        const glyph = guardModeGlyph(iconId);
        return glyph ? Object.assign({}, item, { icon: glyph }) : item;
      };
      const items = [
        withIcon({ id: 'off', label: (list.find(function (item) { return item.id === 'off'; }) || {}).label || '授权关闭' }, 'off'),
        withIcon({ id: 'same-operation', label: (list.find(function (item) { return item.id === 'same-operation'; }) || {}).label || '短期授权' }, 'same-operation'),
      ];
      if (active) {
        items.push(withIcon({ id: 'do-not-disturb', label: '免打扰（进行中 · 限时完全访问）', disabled: true }, 'do-not-disturb'));
        items.push({ id: 'dnd-stop', label: '结束免打扰（还剩 ' + clockText(remaining) + '）' });
        items.push({ id: 'dnd-extend', label: '延长 ' + minutes + ' 分钟' });
      } else if (fullAccess) {
        items.push(withIcon({ id: 'dnd-start', label: '免打扰（当前完全访问，不适用）', disabled: true }, 'do-not-disturb'));
      } else {
        items.push(withIcon({ id: 'dnd-start', label: '免打扰 ' + minutes + ' 分钟（限时完全访问）' }, 'do-not-disturb'));
      }
      const write = function (method, path, body) {
        return fetchJson(host, path, {
          method: method,
          headers: { 'content-type': 'application/json', 'x-dsh-guard': '1' },
          body: JSON.stringify(body),
        });
      };
      const refresh = async function () {
        if (!host) return;
        const cfg = await fetchJson(host, '/api/config');
        if (cfg && cfg.settings) setSettings(cfg.settings);
        if (!sessionId) return;
        const snap = await fetchJson(host, '/api/snapshot?session=' + encodeURIComponent(sessionId));
        const view = viewOf(snap, sessionId);
        setDnd(view && view.dnd ? view.dnd : null);
        setSandboxMode(view && view.sandbox && view.sandbox.currentMode ? view.sandbox.currentMode : '');
      };
      const save = async function (patch) {
        if (!host || busy) return;
        setBusy(true);
        try {
          await write('PATCH', '/api/config', { settings: patch });
          await refresh();
        } catch (err) {
          // 静默：下一轮轮询会拉回真实状态（失败时绝不假装已切换）
        } finally {
          setBusy(false);
        }
      };
      const startWindow = async function () {
        if (!host || !sessionId || busy) return;
        setBusy(true);
        try {
          // 免打扰窗口内自动批准沙箱升级；不改原生档位。关闭状态下先重新启用 Guard。
          if (off) await write('PATCH', '/api/config', { settings: { enabled: true } });
          await write('POST', '/api/dnd', { sessionId: sessionId, ttlSeconds: settings.dndDurationSeconds || 900 });
          await refresh();
        } catch (err) {
          // 失败保持原状：下一轮轮询会恢复真实状态
        } finally {
          setBusy(false);
        }
      };
      const stopWindow = async function () {
        if (!host || !sessionId || busy) return;
        setBusy(true);
        try {
          await write('POST', '/api/dnd/stop', { sessionId: sessionId });
          await refresh();
        } catch (err) {
          // 静默
        } finally {
          setBusy(false);
        }
      };
      const extendWindow = async function () {
        if (!host || !sessionId || busy) return;
        setBusy(true);
        try {
          await write('POST', '/api/dnd/extend', { sessionId: sessionId, addSeconds: settings.dndDurationSeconds || 900 });
          await refresh();
        } catch (err) {
          // 静默
        } finally {
          setBusy(false);
        }
      };
      const choose = function (id) {
        setOpen(false);
        if (busy) return;
        if (id === 'off') {
          void (async function () {
            if (active) await stopWindow();
            if (!off) await save({ enabled: false });
          })();
          return;
        }
        if (id === 'same-operation') {
          void (async function () {
            if (active) await stopWindow();
            if (off) await save({ enabled: true });
          })();
          return;
        }
        if (id === 'dnd-start') {
          // 原生风险确认组件缺失时退回浏览器确认，绝不无确认直接开窗
          if (!primitives.RiskConfirmation) {
            const ok =
              typeof window !== 'undefined' &&
              typeof window.confirm === 'function' &&
              window.confirm('开启免打扰（限时完全访问）？期间本会话的沙箱升级会自动批准；不改原生挡位，结束或切换挡位后恢复询问。');
            if (ok) void startWindow();
            return;
          }
          setAcknowledged(false);
          setConfirming(true);
          return;
        }
        if (id === 'dnd-stop') {
          void stopWindow();
          return;
        }
        if (id === 'dnd-extend') {
          void extendWindow();
        }
      };
      const glyph = guardModeGlyph(active ? 'do-not-disturb' : current);
      const Chevron = primitives.IconChevronDownOutlineRegular;
      const Risk = primitives.RiskConfirmation;
      const menu = h(primitives.Menu, {
        open: open,
        items: items,
        selectedId: current,
        onSelect: choose,
        onClose: function () {
          setOpen(false);
        },
        side: 'top',
        portal: true,
        anchor: h(
          'button',
          {
            type: 'button',
            className: 'dsh-guard-mode-trigger',
            'aria-label': active ? '能力授权模式，当前：免打扰（限时完全访问），还剩 ' + clockText(remaining) : '能力授权模式，当前：' + label,
            title: summary,
            disabled: busy || !host,
            onClick: function () {
              setOpen(!open);
            },
          },
          glyph ? h('span', { key: 'icon', className: 'dsh-guard-mode-icon', 'aria-hidden': true }, glyph) : null,
          h('span', { key: 'label', className: 'dsh-guard-mode-label' }, label),
          remaining > 0 ? h('span', { key: 'time', className: 'dsh-guard-mode-time' }, clockText(remaining)) : null,
          Chevron
            ? h(
                'span',
                { key: 'chevron', className: 'dsh-guard-mode-chevron', 'data-open': open ? 'true' : 'false', 'aria-hidden': true },
                h(Chevron, {}),
              )
            : null,
        ),
      });
      const confirmation = Risk
        ? h(Risk, {
            open: confirming,
            title: '开启免打扰（限时完全访问）？',
            description:
              '接下来 ' +
              minutes +
              ' 分钟内，本会话的沙箱升级会自动批准——期间 AI 可以越出工作区执行操作。它不会改变原生沙箱挡位；窗口结束、你手动结束或切换挡位后，会立即恢复逐次询问。',
            acknowledgeLabel: '我已了解，并愿意继续',
            cancelLabel: '取消',
            closeLabel: '关闭',
            confirmLabel: '开启免打扰',
            acknowledged: acknowledged,
            disabled: busy || !host,
            onAcknowledgedChange: setAcknowledged,
            onCancel: function () {
              setAcknowledged(false);
              setConfirming(false);
            },
            onConfirm: function () {
              setAcknowledged(false);
              setConfirming(false);
              void startWindow();
            },
          })
        : null;
      return h(React.Fragment, null, menu, confirmation);
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
