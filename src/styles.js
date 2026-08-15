/**
 * 「备份」标签页的作用域样式。独立客户端 bundle 无法使用仓库内的 CSS
 * module 管线，样式以字符串随包分发、按 effect 生命周期注入
 * `<style data-dsh-backup>`；全部选择器收在 `[data-dsh-backup]` 之下，
 * 颜色只引用主题 token，同时适配两种配色。
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
[data-dsh-backup] .dsb-section {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
}
[data-dsh-backup] .dsb-status {
  color: var(--dsw-alias-label-secondary);
  margin: 0;
}
[data-dsh-backup] .dsb-failure {
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: flex-start;
}
[data-dsh-backup] .dsb-failure button {
  font: inherit;
  padding: 4px 12px;
  border-radius: 6px;
  cursor: pointer;
}
[data-dsh-backup] .dsb-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border: 1px solid var(--dsw-alias-border-default);
  border-radius: 10px;
}
[data-dsh-backup] .dsb-heading {
  margin: 0;
  font-size: 0.95em;
}
[data-dsh-backup] .dsb-kv {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 4px 12px;
  margin: 0;
  font-size: 0.9em;
}
[data-dsh-backup] .dsb-kv dt { color: var(--dsw-alias-label-secondary); }
[data-dsh-backup] .dsb-kv dd { margin: 0; word-break: break-all; }
[data-dsh-backup] .dsb-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
[data-dsh-backup] .dsb-row input {
  width: 9em;
  font: inherit;
  padding: 4px 8px;
  border: 1px solid var(--dsw-alias-border-default);
  border-radius: 6px;
  color: inherit;
  background: transparent;
}
[data-dsh-backup] .dsb-row button,
[data-dsh-backup] .dsb-cell button {
  font: inherit;
  font-size: 0.9em;
  padding: 4px 12px;
  border: 1px solid var(--dsw-alias-border-default);
  border-radius: 6px;
  cursor: pointer;
  color: inherit;
  background: transparent;
}
[data-dsh-backup] button:disabled { opacity: 0.55; cursor: default; }
[data-dsh-backup] .dsb-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.9em;
}
[data-dsh-backup] .dsb-table th,
[data-dsh-backup] .dsb-table td {
  text-align: left;
  padding: 6px 8px;
  border-bottom: 1px solid var(--dsw-alias-border-default);
}
[data-dsh-backup] .dsb-table td:first-child { word-break: break-all; }
[data-dsh-backup] .dsb-cell {
  display: flex;
  gap: 6px;
  justify-content: flex-end;
  align-items: center;
}
[data-dsh-backup] a.dsb-action {
  font-size: 0.9em;
  padding: 4px 12px;
  border: 1px solid var(--dsw-alias-border-default);
  border-radius: 6px;
  text-decoration: none;
  color: inherit;
  cursor: pointer;
}
[data-dsh-backup] .dsb-banner {
  margin: 0;
  padding: 10px 12px;
  border-radius: 8px;
  font-size: 0.9em;
  white-space: pre-wrap;
  word-break: break-all;
}
[data-dsh-backup] .dsb-banner[data-ok='true'] {
  border: 1px solid var(--dsw-alias-border-success, var(--dsw-alias-border-default));
}
[data-dsh-backup] .dsb-banner[data-ok='false'] {
  border: 1px solid var(--dsw-alias-border-danger, var(--dsw-alias-border-default));
}
[data-dsh-backup] .dsb-preview {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  border: 1px dashed var(--dsw-alias-border-default);
  border-radius: 8px;
  font-size: 0.9em;
}
[data-dsh-backup] .dsb-preview ul {
  margin: 0;
  padding-left: 1.2em;
  color: var(--dsw-alias-label-secondary);
  max-height: 10em;
  overflow: auto;
}
`;
