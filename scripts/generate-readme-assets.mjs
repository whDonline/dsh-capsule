// 作用：生成 README 中英双语 SVG；仅使用 Node 内置模块，插图为结构示意而非产品截图。
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const output = new URL('../assets/readme/', import.meta.url);
mkdirSync(output, { recursive: true });
const c = { ink: '#172c36', muted: '#536b76', green: '#147d68', mint: '#e6f5ef', line: '#d2dfe3', paper: '#f6f9fa', white: '#ffffff', gold: '#9a691c', sand: '#fbf2df' };
const esc = (s) => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const rect = (x, y, w, h, fill = c.white, stroke = c.line, r = 16) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" stroke="${stroke}"/>`;
const text = (x, y, value, size = 20, fill = c.ink, weight = 400) => `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" font-weight="${weight}">${esc(value)}</text>`;
const lines = (x, y, values, size = 19, fill = c.muted, step = 30) => values.map((s, i) => text(x, y + i * step, s, size, fill)).join('');
const path = (d, stroke = c.green, arrow = true) => `<path d="${d}" fill="none" stroke="${stroke}" stroke-width="2.5"${arrow ? ' marker-end="url(#arrow)"' : ''}/>`;
function frame(title, description, height, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="${height}" viewBox="0 0 1200 ${height}" role="img" aria-labelledby="title desc">
<title id="title">${esc(title)}</title><desc id="desc">${esc(description)}</desc>
<defs><marker id="arrow" markerWidth="9" markerHeight="9" refX="7" refY="4" orient="auto"><path d="M0 0L8 4L0 8" fill="none" stroke="${c.green}" stroke-width="1.5"/></marker></defs>
<g font-family="Segoe UI, Microsoft YaHei, Noto Sans CJK SC, Arial, sans-serif">
${rect(1, 1, 1198, height - 2, c.paper, c.line, 22)}${body}</g></svg>\n`;
}
function heading(kicker, title, subtitle) {
  return text(40, 43, kicker, 15, c.green, 700) + text(40, 84, title, 30, c.ink, 700) + text(40, 116, subtitle, 18, c.muted);
}
function card(x, y, w, h, title, details, tone = c.white) {
  return rect(x, y, w, h, tone) + text(x + 22, y + 38, title, 22, c.ink, 600) + lines(x + 22, y + 72, details);
}
function hero(en) {
  let b = rect(1, 1, 1198, 418, c.ink, c.ink, 22);
  b += text(48, 53, 'DEEPSEEK HARNESS / CAPABILITY GUARD', 16, '#93d8c5', 600);
  b += text(48, 122, 'DSH Capsule', 58, c.white, 700);
  b += lines(48, 178, en ? ['Less interruption.', 'Authorization with an expiry.'] : ['少一点重复审批。', '每一份授权，都有期限。'], 32, c.white, 46);
  b += text(48, 281, en ? 'Short-lived leases · DND windows · Local decision history' : '短期授权 · 免打扰窗口 · 本地决策记录', 20, '#bed3da');
  b += path('M48 311H734', '#46616c', false);
  b += text(48, 351, en ? 'Your sandbox mode stays under native DSH control.' : '沙箱档位始终由你与 DSH 决定。', 20, '#93d8c5');
  b += text(48, 385, 'TypeScript  /  Windows · macOS · Linux  /  MIT', 16, '#bed3da');
  b += `<circle cx="979" cy="191" r="111" fill="none" stroke="#36525e" stroke-width="16"/><circle cx="979" cy="191" r="111" fill="none" stroke="#79d7b9" stroke-width="16" stroke-dasharray="520 178" transform="rotate(-90 979 191)"/>`;
  b += path('M979 120V191L1020 218', '#79d7b9', false);
  b += `<circle cx="979" cy="191" r="7" fill="#79d7b9"/>`;
  b += text(891, 348, 'SCOPE + TTL', 24, c.white, 600);
  return frame('DSH Capsule / Capability Guard', en ? 'Short-lived authorization and DND windows without changing session sandbox mode.' : '短期授权与免打扰窗口；Guard 不改写会话沙箱档位。', 420, b);
}
function architecture(en) {
  let b = heading('03 / ARCHITECTURE', en ? 'Four hooks. One approval layer.' : '四个 hook，一层审批增强。', en ? 'DSH owns execution and isolation; Guard manages reuse and visibility.' : 'DSH 负责执行与隔离；Guard 负责授权复用、窗口与可追溯性。');
  b += rect(40, 150, 1120, 70, c.ink, c.ink);
  b += text(64, 193, 'DeepSeek Harness', 24, c.white, 600);
  b += text(360, 192, 'Tool Pipeline  /  Approval  /  Sandbox  /  Credentials', 21, '#bed3da');
  const titles = ['pre-execute', 'execute', 'approval/request', 'result'];
  const desc = en ? [['Observe downstream', 'Preserve allow / deny'], ['Capture arguments', 'Record by callId'], ['Delegate or reuse', 'Issue after approval'], ['Clear pending state', 'Record tool outcome']] : [['观察下游决策', '保留 allow / deny'], ['工具体前捕获参数', '按 callId 关联操作'], ['委派审批或复用', '人工批准后签发'], ['清理待处理上下文', '记录执行结果']];
  titles.forEach((t, i) => {
    const x = 40 + i * 286;
    b += path(`M${x + 131} 220V254`);
    b += card(x, 264, 262, 134, t, desc[i]);
  });
  b += text(42, 437, en ? 'GUARD SERVICES' : 'GUARD 内部服务', 15, c.green, 700);
  b += card(40, 456, 356, 132, 'LeaseManager', en ? ['Scope + TTL + revocation', 'Operation-family reuse'] : ['Scope、TTL 与撤销', '操作族复用'], c.mint);
  b += card(422, 456, 356, 132, 'DndManager', en ? ['Explicit, bounded windows', 'Independent of Leases'] : ['用户显式开启的限时窗口', '状态独立于 Lease'], c.mint);
  b += card(804, 456, 356, 132, 'Audit + Journal', en ? ['Decision records', 'Local NDJSON persistence'] : ['面向人的授权决策记录', '本机 NDJSON 追加日志'], c.mint);
  b += path('M600 398V420', c.green, false);
  b += path('M218 588V621', c.green, false) + path('M600 588V621', c.green, false) + path('M982 588V621', c.green, false) + path('M218 621H982', c.green, false) + path('M600 621V650');
  b += rect(40, 660, 1120, 74);
  b += text(64, 705, en ? 'In-session UI' : '会话内界面', 24, c.ink, 600);
  b += text(300, 704, en ? 'Input chip  /  Authorization tab  /  Local diagnostic API' : '输入框模式 chip  /  能力授权 tab  /  本地排障接口', 21, c.muted);
  b += text(40, 774, en ? 'Read-only host sandbox mode. No sandbox or approval-policy writes.' : '宿主沙箱档位只读；Guard 不写沙箱档位或审批策略。', 19, c.green, 600);
  return frame(en ? 'Guard architecture' : 'Guard 架构', en ? 'Four hooks connect DSH to Lease, DND and audit services and the session UI.' : '四个 hook 接入原生管线，连接 Lease、免打扰、审计与会话内界面。', 806, b);
}
function lifecycle(en) {
  let b = heading('02 / LIFECYCLE', en ? 'Two lifecycles. Separate state.' : '两条生命周期，状态彼此独立。', en ? 'Revocation and window expiry affect future approvals, not running calls.' : '撤销与窗口结束影响后续审批，不中断已开始的调用。');
  b += text(40, 164, en ? 'A / SHORT-LIVED AUTHORIZATION' : 'A / 短期授权', 17, c.green, 700);
  const xs = [40, 328, 616, 904];
  const lease = en ? [['Human approval', 'allowed-once'], ['Issue Lease', 'Scope + TTL'], ['Reuse', 'Valid matching grant'], ['End', 'Expiry / revocation']] : [['人工批准', 'allowed-once'], ['签发 Lease', '明确 Scope + TTL'], ['复用授权', '匹配且仍有效'], ['授权结束', '到期 / 主动撤销']];
  lease.forEach(([t, s], i) => { b += card(xs[i], 188, 256, 112, t, [s], i === 2 ? c.mint : c.white); if (i < 3) b += path(`M${xs[i] + 256} 244H${xs[i + 1] - 9}`); });
  b += text(40, 336, en ? 'Miss, expired or revoked → delegate to native approval.' : '未命中、到期或被撤销 → 交回原生审批。', 19, c.muted);
  b += path('M40 365H1160', c.line, false);
  b += text(40, 410, en ? 'B / DO-NOT-DISTURB WINDOW' : 'B / 免打扰窗口', 17, c.gold, 700);
  const dnd = en ? [['Explicitly open', 'User chooses duration'], ['Window active', 'Recorded escalations'], ['Auto-approve', 'allowed-once; no Lease'], ['Window ends', 'Native approval resumes']] : [['显式开启', '由用户选择时长'], ['窗口生效', '仅已记录的沙箱升级'], ['自动批准', 'allowed-once，不签 Lease'], ['窗口结束', '恢复原生审批']];
  dnd.forEach(([t, s], i) => { b += card(xs[i], 434, 256, 112, t, [s], i === 2 ? c.sand : c.white); if (i < 3) b += path(`M${xs[i] + 256} 490H${xs[i + 1] - 9}`); });
  b += lines(40, 583, en ? ['Ends on expiry, stop, detected native mode change or plugin disposal.', 'Extensions are bounded by the maximum total window duration.'] : ['到期、手动结束、检测到原生档位变化或卸载插件，窗口失效。', '可以延长，但总时长不能超过上限。'], 19, c.muted, 29);
  b += rect(40, 650, 1120, 66, c.ink, c.ink);
  b += text(64, 691, en ? 'HOST SANDBOX MODE' : '宿主沙箱档位', 20, '#93d8c5', 600);
  b += text(390, 691, en ? 'Read-only in both flows. Controlled by you and DSH.' : '两条链路都只读；始终由你与 DSH 决定。', 20, c.white);
  return frame(en ? 'Lease and DND lifecycle' : '短期授权与免打扰生命周期', en ? 'Human approval issues Leases. DND auto-approves eligible escalations without issuing Leases. Neither writes sandbox mode.' : '人工批准签发 Lease；免打扰仅自动批准符合条件的升级；两者都不写沙箱档位。', 750, b);
}
function workspace(en) {
  let b = heading('01 / SESSION EXPERIENCE', en ? 'Controls where the work happens.' : '授权状态，就在当前会话。', en ? 'Conceptual layout — not a product screenshot. Labels are translated for this illustration.' : '结构示意，非产品截图；用于说明入口与状态关系。');
  b += rect(40, 151, 720, 497);
  b += text(64, 190, en ? 'Current conversation' : '当前会话', 23, c.ink, 600);
  b += path('M40 214H760', c.line, false);
  b += text(64, 249, en ? 'Chat      Trajectory' : '对话          轨迹', 20, c.muted);
  b += rect(391, 223, 340, 43, c.mint, c.mint, 9);
  b += text(414, 251, en ? 'Authorization' : '能力授权', 20, c.green, 600);
  b += text(64, 306, en ? 'THREE INDEPENDENT STATES' : '三种独立状态', 15, c.green, 700);
  const rows = en ? [['Lease', 'Scope / remaining TTL / revoke'], ['DND window', 'Countdown / stop / extend'], ['Host sandbox mode', 'Read-only / unknown if unavailable']] : [['短期授权', '范围 / 剩余时间 / 撤销'], ['免打扰窗口', '倒计时 / 结束 / 延长'], ['宿主沙箱档位', '只读读数 / 不可用时 unknown']];
  rows.forEach(([a, d], i) => { const y = 326 + i * 63; b += rect(63, y, 674, 51, c.paper, c.line, 9); b += text(80, y + 32, a, 19, c.ink, 600); b += text(en ? 292 : 273, y + 32, d, 18, c.muted); });
  b += text(64, 553, en ? 'Decision records + duration settings' : '授权决策记录 + 时长设置', 20, c.muted);
  b += rect(63, 581, 674, 46, c.ink, c.ink, 9);
  b += text(80, 611, en ? 'Input chip: reuse / DND countdown / quick actions' : '输入框 chip：短期授权 / 免打扰倒计时 / 快捷操作', 18, c.white);
  b += card(792, 151, 368, 145, en ? 'Session-scoped' : '会话作用域', en ? ['Uses the host sessionId.', 'No global activity guessing.'] : ['直接使用宿主 sessionId', '不以最近活动推断当前会话'], c.mint);
  b += card(792, 319, 368, 145, en ? 'Full-access mode' : '完全访问档位', en ? ['Chip is hidden.', 'Settings return on mode change.'] : ['隐藏 chip，无需授权', '切回其他档位恢复入口与设置']);
  b += card(792, 487, 368, 161, en ? 'Decision history' : '面向人的决策记录', en ? ['What was approved?', 'How often was it reused?', 'How did it end?'] : ['批准了什么？', '复用了几次？', '如何结束？']);
  b += text(40, 691, en ? 'DND is a user action, not a persistent mode setting.' : '免打扰是显式动作开启的窗口，不是持久化模式设置。', 20, c.green, 600);
  return frame(en ? 'In-session authorization experience' : '会话内授权体验', en ? 'Input chip and third conversation tab, with separate Lease, DND and host mode states. Conceptual illustration.' : '输入框 chip 与第三个会话 tab；授权、免打扰、宿主档位分别展示。结构示意。', 724, b);
}
for (const lang of ['zh', 'en']) {
  for (const [name, generate] of Object.entries({ hero, architecture, lifecycle, workspace })) {
    writeFileSync(new URL(`${name}-${lang}.svg`, output), generate(lang === 'en'), 'utf8');
  }
}
console.log(`Generated 8 SVG illustrations in ${fileURLToPath(output)}`);
