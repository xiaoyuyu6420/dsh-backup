/**
 * 「备份」标签页的作用域样式。独立客户端 bundle 无法使用仓库内的 CSS
 * module 管线，样式以字符串随包分发、按 effect 生命周期注入
 * `<style data-dsh-backup>`；全部选择器收在 `[data-dsh-backup]` 之下，
 * 只引用 dsh web 的主题 token（--dsw-alias-*），自动适配深浅色。
 */

export function installPanelStyles() {
  const existing = document.querySelector('style[data-dsh-backup]');
  if (existing !== null) return () => {};
  const element = document.createElement('style');
  element.dataset.dshBackup = '';
  element.textContent = PANEL_CSS;
  document.head.append(element);
  return () => { element.remove(); };
}

const PANEL_CSS = `
[data-dsh-backup] {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-width: 760px;
  min-width: 0;
  color: var(--dsw-alias-label-primary);
}
[data-dsh-backup] .dsb-status {
  margin: 0;
  font-size: 13px;
  color: var(--dsw-alias-label-tertiary);
}
[data-dsh-backup] .dsb-failure {
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: flex-start;
}

/* ── 卡片 ─────────────────────────────────────────────── */
[data-dsh-backup] .dsb-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px 16px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-3);
  transition: border-color .16s, background .16s;
}
[data-dsh-backup] .dsb-card:hover {
  border-color: var(--dsw-alias-label-dimmed);
}
[data-dsh-backup] .dsb-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  line-height: 1.4;
}
[data-dsh-backup] .dsb-kv {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 6px 14px;
  margin: 0;
  font-size: 13px;
}
[data-dsh-backup] .dsb-kv dt {
  color: var(--dsw-alias-label-tertiary);
}
[data-dsh-backup] .dsb-kv dd {
  margin: 0;
  min-width: 0;
  word-break: break-all;
  color: var(--dsw-alias-label-secondary);
}
[data-dsh-backup] .dsb-divider {
  height: 1px;
  background: var(--dsw-alias-border-l2);
}

/* ── 徽章 ─────────────────────────────────────────────── */
[data-dsh-backup] .dsb-badge {
  flex: none;
  border-radius: 999px;
  padding: 1px 9px;
  font-size: 11px;
  line-height: 18px;
  font-weight: 500;
  white-space: nowrap;
  background: var(--dsw-alias-bg-module-platform);
  color: var(--dsw-alias-label-secondary);
}
[data-dsh-backup] .dsb-badge[data-tone='ok'] {
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 14%, transparent);
  color: var(--dsw-alias-state-business-primary);
}
[data-dsh-backup] .dsb-badge[data-tone='warn'] {
  background: color-mix(in srgb, var(--dsw-alias-label-error, var(--dsw-static-red-500, #ef4444)) 12%, transparent);
  color: var(--dsw-alias-label-error, var(--dsw-static-red-500, #ef4444));
}

/* ── 按钮 ─────────────────────────────────────────────── */
[data-dsh-backup] button {
  appearance: none;
  border: 1px solid transparent;
  border-radius: 8px;
  padding: 5px 14px;
  font: inherit;
  font-size: 13px;
  line-height: 1.5;
  cursor: pointer;
}
[data-dsh-backup] .dsb-btn-secondary {
  border-color: var(--dsw-alias-border-l2);
  background: none;
  color: var(--dsw-alias-label-secondary);
}
[data-dsh-backup] .dsb-btn-secondary:hover:not(:disabled) {
  color: var(--dsw-alias-label-primary);
  border-color: var(--dsw-alias-label-dimmed);
}
[data-dsh-backup] .dsb-btn-primary {
  background: var(--dsw-alias-label-primary);
  color: var(--dsw-alias-bg-layer-3);
}
[data-dsh-backup] .dsb-btn-danger {
  /* 宿主 theme 未定义 --dsw-alias-label-error（P0 实测：白字白底隐形），
     fallback 链落到宿主确实定义的 static-red，再兜底手写红 */
  border-color: color-mix(in srgb, var(--dsw-alias-label-error, var(--dsw-static-red-500, #ef4444)) 45%, transparent);
  background: none;
  color: var(--dsw-alias-label-error, var(--dsw-static-red-500, #ef4444));
}
[data-dsh-backup] button:disabled {
  opacity: 0.4;
  cursor: default;
}
[data-dsh-backup] button:focus-visible,
[data-dsh-backup] a:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 1px;
}

/* ── 操作行 ───────────────────────────────────────────── */
[data-dsh-backup] .dsb-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
[data-dsh-backup] .dsb-row input {
  width: 8em;
  font: inherit;
  font-size: 13px;
  padding: 4px 10px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  color: inherit;
  background: var(--dsw-alias-bg-layer-2);
}
[data-dsh-backup] .dsb-row input:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 1px;
}
[data-dsh-backup] .dsb-row label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--dsw-alias-label-secondary);
}

/* ── 备份列表（卡片行，非表格） ─────────────────────────── */
[data-dsh-backup] .dsb-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
}
[data-dsh-backup] .dsb-item {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto auto;
  align-items: center;
  gap: 14px;
  padding: 10px 2px;
  border-top: 1px solid var(--dsw-alias-border-l2);
}
[data-dsh-backup] .dsb-item:first-child {
  border-top: 0;
}
[data-dsh-backup] .dsb-item:hover {
  background: color-mix(in srgb, var(--dsw-alias-label-primary) 4%, transparent);
  margin: 0 -8px;
  padding-left: 10px;
  padding-right: 10px;
  border-radius: 8px;
}
[data-dsh-backup] .dsb-item-name {
  min-width: 0;
  font-size: 13px;
  font-family: ui-monospace, 'Cascadia Mono', Consolas, monospace;
  word-break: break-all;
  color: var(--dsw-alias-label-primary);
}
[data-dsh-backup] .dsb-item-meta {
  font-size: 12px;
  white-space: nowrap;
  color: var(--dsw-alias-label-tertiary);
}
[data-dsh-backup] .dsb-item-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}
[data-dsh-backup] .dsb-item-actions button,
[data-dsh-backup] .dsb-item-actions a {
  padding: 3px 10px;
  font-size: 12px;
}
[data-dsh-backup] .dsb-item-actions a {
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  text-decoration: none;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
  line-height: 1.5;
}
[data-dsh-backup] .dsb-item-actions a:hover {
  color: var(--dsw-alias-label-primary);
  border-color: var(--dsw-alias-label-dimmed);
}
[data-dsh-backup] .dsb-empty {
  margin: 0;
  padding: 12px 0 4px;
  font-size: 13px;
  color: var(--dsw-alias-label-tertiary);
}

/* ── 反馈入口 ─────────────────────────────────────────── */
[data-dsh-backup] .dsb-feedback {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--dsw-alias-label-tertiary);
}
[data-dsh-backup] .dsb-feedback a {
  color: var(--dsh-backup-accent, var(--dsw-alias-label-primary));
}

/* ── 结果横幅 ─────────────────────────────────────────── */
[data-dsh-backup] .dsb-banner {
  margin: 0;
  padding: 10px 14px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-3);
  font-size: 13px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-all;
}
[data-dsh-backup] .dsb-banner[data-ok='true'] {
  border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary) 40%, transparent);
  color: var(--dsw-alias-label-primary);
}
[data-dsh-backup] .dsb-banner[data-ok='false'] {
  border-color: color-mix(in srgb, var(--dsw-alias-label-error, var(--dsw-static-red-500, #ef4444)) 45%, transparent);
  color: var(--dsw-alias-label-error, var(--dsw-static-red-500, #ef4444));
}

/* ── 恢复确认弹窗 ─────────────────────────────────────── */
[data-dsh-backup] .dsb-modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  background: color-mix(in srgb, var(--dsw-alias-label-primary) 30%, transparent);
}
[data-dsh-backup] .dsb-modal {
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: min(500px, 100%);
  max-height: 85vh;
  overflow: auto;
  padding: 18px 20px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 14px;
  background: var(--dsw-alias-bg-layer-2);
  box-shadow: 0 18px 48px rgb(0 0 0 / 28%);
  font-size: 13px;
}
[data-dsh-backup] .dsb-modal-title {
  font-size: 15px;
  font-weight: 600;
}
[data-dsh-backup] .dsb-modal-sub {
  margin: 0;
  font-family: ui-monospace, 'Cascadia Mono', Consolas, monospace;
  font-size: 12px;
  word-break: break-all;
  color: var(--dsw-alias-label-tertiary);
}
[data-dsh-backup] .dsb-warn {
  margin: 0;
  padding: 10px 12px;
  border: 1px dashed color-mix(in srgb, var(--dsw-alias-label-error, var(--dsw-static-red-500, #ef4444)) 45%, transparent);
  border-radius: 10px;
}
[data-dsh-backup] .dsb-warn p {
  margin: 0 0 6px;
  font-weight: 600;
  color: var(--dsw-alias-label-error, var(--dsw-static-red-500, #ef4444));
}
[data-dsh-backup] .dsb-warn ul {
  margin: 0;
  padding-left: 1.2em;
  display: flex;
  flex-direction: column;
  gap: 4px;
  color: var(--dsw-alias-label-primary);
}
[data-dsh-backup] .dsb-preflight {
  margin: 0;
  padding-left: 1.2em;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-label-secondary);
}
[data-dsh-backup] .dsb-modal-actions {
  justify-content: flex-end;
  margin-top: 4px;
}
[data-dsh-backup] .dsb-btn-danger-solid {
  /* 同 dsb-btn-danger：宿主缺 --dsw-alias-label-error，必须有 fallback 否则按钮隐形 */
  background: var(--dsw-alias-label-error, var(--dsw-static-red-600, #ec1313));
  color: #fff;
}
[data-dsh-backup] .dsb-btn-danger-solid:hover:not(:disabled) {
  filter: brightness(1.06);
}

/* ── 设置输入框 ────────────────────────────────────────── */
[data-dsh-backup] .dsb-input {
  width: 100%;
  max-width: 320px;
  font: inherit;
  font-size: 13px;
  padding: 5px 10px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-1, #fff);
  box-sizing: border-box;
}
[data-dsh-backup] .dsb-input:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 1px;
}
[data-dsh-backup] .dsb-hint {
  display: block;
  margin-top: 2px;
  font-size: 12px;
  color: var(--dsw-alias-label-tertiary);
  line-height: 1.4;
}
[data-dsh-backup] .dsb-settings-errors {
  margin: 6px 0 0;
  padding-left: 1.2em;
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-label-error, var(--dsw-static-red-500, #ef4444));
}
[data-dsh-backup] .dsb-syncdeps {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 8px 0 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-label-secondary, inherit);
}
[data-dsh-backup] .dsb-syncdeps input {
  accent-color: var(--dsw-alias-brand-primary, #4176e6);
}
[data-dsh-backup] .dsb-status-ok {
  font-size: 12px;
  color: var(--dsw-alias-state-success-primary, #2f9e44);
  line-height: 1.5;
}
[data-dsh-backup] .dsb-status-error {
  font-size: 12px;
  color: var(--dsw-alias-state-error-primary, #e53e3e);
  line-height: 1.5;
}

/* ── 三 Tab 导航 ─────────────────────────────────────── */
[data-dsh-backup] .dsb-tabs {
  display: flex;
  gap: 2px;
  border-bottom: 1px solid var(--dsw-alias-border-l2);
  margin-bottom: 2px;
}
[data-dsh-backup] .dsb-tabs button {
  border: 0;
  border-bottom: 2px solid transparent;
  background: none;
  color: var(--dsw-alias-label-tertiary);
  padding: 8px 14px;
  margin-bottom: -1px;
  font-weight: 500;
}
[data-dsh-backup] .dsb-tabs button:hover:not(:disabled) {
  color: var(--dsw-alias-label-secondary);
}
[data-dsh-backup] .dsb-tabs button.active {
  color: var(--dsw-alias-label-primary);
  border-bottom-color: var(--dsw-alias-brand-primary, #4176e6);
  font-weight: 600;
}

/* ── 主 CTA / 信息条 ─────────────────────────────────── */
[data-dsh-backup] .dsb-hero { padding: 18px 18px; }
[data-dsh-backup] .dsb-btn-big { padding: 11px 20px; font-size: 14px; border-radius: 10px; }
[data-dsh-backup] .dsb-btn-small { padding: 3px 10px; font-size: 12px; }
[data-dsh-backup] .dsb-btn-small-ghost {
  padding: 2px 6px; font-size: 12px; color: var(--dsw-alias-label-tertiary);
}
[data-dsh-backup] .dsb-btn-small-ghost:hover:not(:disabled) { color: var(--dsw-alias-label-primary); }
[data-dsh-backup] .dsb-heading-right { margin-left: auto; display: flex; gap: 6px; align-items: center; }
[data-dsh-backup] .dsb-mono { font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace; font-size: 12px; }
[data-dsh-backup] .dsb-muted { color: var(--dsw-alias-label-tertiary); }
[data-dsh-backup] .dsb-info {
  background: color-mix(in srgb, var(--dsw-alias-brand-primary, #4176e6) 8%, transparent);
  border-color: color-mix(in srgb, var(--dsw-alias-brand-primary, #4176e6) 24%, transparent);
}
[data-dsh-backup] .dsb-info-text { margin: 0; font-size: 13px; line-height: 1.7; color: var(--dsw-alias-label-secondary); }

/* ── 首次引导步骤 ─────────────────────────────────────── */
[data-dsh-backup] .dsb-steps {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 8px;
  margin-top: 14px;
}
[data-dsh-backup] .dsb-step {
  display: flex; flex-direction: column; gap: 3px;
  padding: 10px 12px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 10px;
  background: var(--dsw-alias-bg-module-platform);
  font-size: 12px;
  color: var(--dsw-alias-label-tertiary);
}
[data-dsh-backup] .dsb-step b { color: var(--dsw-alias-label-primary); font-weight: 600; font-size: 13px; }

/* ── 分类型 chips ─────────────────────────────────────── */
[data-dsh-backup] .dsb-chips { display: flex; flex-wrap: wrap; gap: 8px; }
[data-dsh-backup] .dsb-chip {
  border: 1px solid var(--dsw-alias-border-l2);
  background: none;
  border-radius: 999px;
  padding: 5px 12px;
  font-size: 12px;
  color: var(--dsw-alias-label-secondary);
}
[data-dsh-backup] .dsb-chip:hover:not(:disabled) { border-color: var(--dsw-alias-label-dimmed); }
[data-dsh-backup] .dsb-chip.on {
  border-color: var(--dsw-alias-brand-primary, #4176e6);
  background: color-mix(in srgb, var(--dsw-alias-brand-primary, #4176e6) 14%, transparent);
  color: var(--dsw-alias-label-primary);
}

/* ── 导入预览计划 ─────────────────────────────────────── */
[data-dsh-backup] .dsb-import-plan {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 10px;
  background: var(--dsw-alias-bg-module-platform);
}

/* ── 列表改 flex，主操作「恢复」用 primary，避免动作平分 ── */
[data-dsh-backup] .dsb-item {
  display: flex;
  align-items: center;
  gap: 12px;
}
[data-dsh-backup] .dsb-item-name { flex: 1 1 auto; min-width: 0; }
[data-dsh-backup] .dsb-item-actions .dsb-btn-primary { font-size: 12px; padding: 3px 12px; }

@media (max-width: 640px) {
  [data-dsh-backup] .dsb-item { flex-wrap: wrap; }
  [data-dsh-backup] .dsb-item-actions { flex-wrap: wrap; }
  [data-dsh-backup] .dsb-kv { grid-template-columns: 1fr; }
}
`;
