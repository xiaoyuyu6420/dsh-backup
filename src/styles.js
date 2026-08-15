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
  background: color-mix(in srgb, var(--dsw-alias-label-error) 12%, transparent);
  color: var(--dsw-alias-label-error);
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
  border-color: color-mix(in srgb, var(--dsw-alias-label-error) 45%, transparent);
  background: none;
  color: var(--dsw-alias-label-error);
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
  border-color: color-mix(in srgb, var(--dsw-alias-label-error) 45%, transparent);
  color: var(--dsw-alias-label-error);
}

/* ── 恢复预览 ─────────────────────────────────────────── */
[data-dsh-backup] .dsb-preview {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px;
  border: 1px dashed var(--dsw-alias-border-l2);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-2);
  font-size: 13px;
}
[data-dsh-backup] .dsb-preview strong {
  font-weight: 600;
}
[data-dsh-backup] .dsb-preview ul {
  margin: 0;
  padding-left: 1.2em;
  color: var(--dsw-alias-label-secondary);
  font-family: ui-monospace, 'Cascadia Mono', Consolas, monospace;
  font-size: 12px;
  max-height: 10em;
  overflow: auto;
}
`;
