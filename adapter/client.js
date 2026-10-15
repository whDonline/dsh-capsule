/**
 * DSH Capability Guard — DSH Web 客户端半边（浏览器侧）。
 *
 * 作用：在 DSH Web GUI 里提供 Guard 治理面板（授权与剩余时间 / 审计 / 范围挡位与 TTL）。
 * 数据来自宿主半边启动的 loopback 治理接口（默认 http://127.0.0.1:8787/api/*），因此：
 *   - 面板本身不持有任何授权状态，只是治理接口的视图（Guard 的 LeaseManager 始终是唯一判据）；
 *   - 端口可能在配置中被改动，或因为被占用而回退，因此这里按候选端口逐个探测，
 *     并且只把探测结果缓存在内存里（下一次挂载会重新探测）。
 *
 * 约束（本次实现刻意遵守，避免把面板做成新的权限入口）：
 *   - 唯一写操作是 PATCH /api/config（默认范围挡位与 TTL），且必须由用户点击按钮触发；
 *   - 不在面板里做任何 approval / revoke / 授权签发动作（那些必须走 DSH 原生审批与 API）；
 *   - 不引入任何 DSH Client 包（primitives 等），只使用 React 与主题令牌；
 *   - 所有动态内容经 textContent 写入，不写 DOM 到面板容器之外，也不触碰 document.body。
 */
window.__ModuleLoader__.load({
  id: '@dsh-capsule/adapter',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const PANEL_ID = 'guard';
    const PANEL_LABEL = '能力授权';
    const SAME_ORIGIN_BASE = '/guard';
    const DEFAULT_CONSOLE_PORT = 8787;
    const PORT_PROBE_RANGE = 4;
    const MONITOR_INTERVAL_MS = 5000;
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
          // 该入口不可用：继续探测下一个候选（全部失败时返回 null，面板显示连接提示）
        }
      }
      return null;
    }

    /** 作用：挂载治理面板——把共享的 Console UI 渲染进本组件自己的 DOM 节点。 */
    function GuardPanel() {
      const containerRef = React.useRef(null);
      const [status, setStatus] = React.useState({ state: 'connecting', detail: '' });
      React.useEffect(() => {
        let disposed = false;
        let handle = null;
        const container = containerRef.current;
        if (!container) return undefined;
        const boot = async () => {
          const host = await probeConsoleHost();
          if (disposed) return;
          if (!host) {
            setStatus({ state: 'unreachable', detail: '未发现本机治理接口（默认端口 ' + DEFAULT_CONSOLE_PORT + ' 起）' });
            return;
          }
          try {
            await new Promise((resolve, reject) => {
              if (window.DshGuardConsole && typeof window.DshGuardConsole.mount === 'function') {
                resolve();
                return;
              }
              const script = document.createElement('script');
              script.src = host + '/console.js';
              script.async = true;
              script.onload = () => resolve();
              script.onerror = () => reject(new Error('console.js 加载失败'));
              document.head.appendChild(script);
            });
            if (disposed) return;
            handle = window.DshGuardConsole.mount({ host: host, container: container, pollMs: 2000 });
            setStatus({ state: 'ready', detail: host });
          } catch (err) {
            if (!disposed) setStatus({ state: 'error', detail: String((err && err.message) || err) });
          }
        };
        void boot();
        return () => {
          disposed = true;
          if (handle && typeof handle.dispose === 'function') handle.dispose();
          handle = null;
        };
      }, []);
      return h(
        'div',
        { style: { height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column' } },
        h('div', { ref: containerRef, style: { flex: '1 1 auto', minHeight: 0, overflow: 'auto' } }),
        status.state === 'connecting' || status.state === 'ready'
          ? null
          : h(
              'div',
              {
                style: {
                  padding: '24px',
                  color: 'var(--dsw-alias-label-secondary)',
                  fontSize: '13px',
                  lineHeight: 1.7,
                },
              },
              h('div', { style: { fontWeight: 600, color: 'var(--dsw-alias-label-primary)', marginBottom: '6px' } }, '尚未连接到 Capability Guard 治理接口'),
              h('div', null, status.detail),
              h(
                'div',
                { style: { marginTop: '10px' } },
                '排障：确认 @dsh-capsule/adapter 已启用，或直接在浏览器打开治理接口端口查看独立页面（默认 8787）。',
              ),
            ),
      );
    }

    /** 作用：侧栏面板图标——用纯 SVG 画一个"盾牌 + 时钟"，不依赖任何图标包。 */
    function GuardIcon(props) {
      const size = (props && props.size) || 16;
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 16 16', 'aria-hidden': 'true', focusable: 'false' },
        h('path', {
          d: 'M8 1.2 13.4 3v4.3c0 3.4-2.2 6.4-5.4 7.5-3.2-1.1-5.4-4.1-5.4-7.5V3L8 1.2Z',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: '1.3',
          strokeLinejoin: 'round',
        }),
        h('path', { d: 'M8 4.6v3.1l2.1 1.3', fill: 'none', stroke: 'currentColor', strokeWidth: '1.3', strokeLinecap: 'round' }),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // 作用：注册治理面板（主面板 + 侧栏入口）。两处注册都挂在插件 fiber 上，
        // 插件卸载（或 profile patch 关闭该行）时随之移除。
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, GuardPanel));
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 20, label: PANEL_LABEL }, GuardIcon),
        );
        // 作用：低频重探治理接口——首次探测失败（例如 DSH 重启顺序导致端口还没起来）时，
        // 面板不会永久停留在"未连接"状态；探测本身只发 loopback GET，不做任何写操作。
        if (typeof ctx.effect === 'function') {
          ctx.effect(() => {
            const timer = setInterval(() => {
              probeCache.host = null;
              void probeConsoleHost();
            }, MONITOR_INTERVAL_MS * 6);
            return () => clearInterval(timer);
          });
        }
      },
    };
  },
});
