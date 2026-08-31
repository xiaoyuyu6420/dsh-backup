/**
 * Settings「备份」标签页：总览卡（目录/自动备份开关/立即备份/校验）、
 * GitHub 同步卡、备份列表（逐份校验/下载/恢复，恢复先 dry-run 预览再确认）。
 * 全部动作经注入的 panel API 走 `backupPanel` Remote，组件自身只持有视图状态。
 */

import { useEffect, useState } from 'react';

/** 从归档名解析展示时间：dsh-YYYYMMDD-HHMMSSmmm → YYYY-MM-DD HH:MM:SS。 */
function stampOf(name) {
  const m = /^dsh-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(name);
  if (m === null) return null;
  return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}`;
}

function mb(size, t) {
  if (typeof size !== 'number') return t('sizeUnknown');
  return size >= 1048576 ? `${(size / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(size / 1024))} KB`;
}

/** 渲染「备份」标签页。 */
export function BackupTab({ panel, t }) {
  const [snap, setSnap] = useState(null);
  const [github, setGithub] = useState(null);
  const [failed, setFailed] = useState(false);
  const [request, setRequest] = useState(0);
  const [busy, setBusy] = useState('');
  const [banner, setBanner] = useState(null);
  const [hoursInput, setHoursInput] = useState('');
  const [pending, setPending] = useState(null);
  const [repoInput, setRepoInput] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [syncDeps, setSyncDeps] = useState(false);

  // 删除两段式确认的自动复位：误触后不响应也不点确认时，6 秒后回到普通按钮，
  // 避免"要么删、要么关弹窗"的死角（UX 审查 P1-9）。
  useEffect(() => {
    if (confirmDelete === null) return undefined;
    const timer = setTimeout(() => setConfirmDelete(null), 6000);
    const onKey = (e) => { if (e.key === 'Escape') setConfirmDelete(null); };
    window.addEventListener('keydown', onKey);
    return () => { clearTimeout(timer); window.removeEventListener('keydown', onKey); };
  }, [confirmDelete]);

  // Settings state (from /dsh-backup/settings)
  const [settings, setSettings] = useState(null);
  const [settingsRevision, setSettingsRevision] = useState(undefined);
  const [hasOverrides, setHasOverrides] = useState(false);
  const [destInput, setDestInput] = useState('');
  const [keepInput, setKeepInput] = useState('');
  const [excludeInput, setExcludeInput] = useState('');
  const [settingsDirty, setSettingsDirty] = useState(false);
  const [settingsStatus, setSettingsStatus] = useState(''); // '' | 'saving' | 'saved' | 'error'
  const [settingsMsg, setSettingsMsg] = useState('');

  const reload = () => { setRequest(v => v + 1); };

  // 将服务端返回的 settings 数据同步到所有输入状态
  const applySettings = (data) => {
    setSettings(data);
    setSettingsRevision(data.revision);
    setHasOverrides(!!data.hasOverrides);
    setDestInput(data.destination || '');
    setKeepInput(data.keep > 0 ? String(data.keep) : '');
    setExcludeInput(Array.isArray(data.exclude) ? data.exclude.join(', ') : '');
    setSettingsDirty(false);
  };

  // 拉取 settings（挂载 + reload 时均调用，确保 409 后 revision 刷新）
  useEffect(() => {
    let cancelled = false;
    fetch('/dsh-backup/settings', { cache: 'no-store' })
      .then((res) => res.json())
      .then((data) => {
        if (cancelled || !data || data.error) return;
        applySettings(data);
      })
      .catch(() => { /* settings service unavailable */ });
    return () => { cancelled = true; };
  }, [request]);

  useEffect(() => {
    let current = true;
    setFailed(false);
    void Promise.all([panel.status(), panel.githubStatus()]).then(
      ([snapshot, gh]) => {
        if (current) {
          setSnap(snapshot);
          setGithub(gh);
          if (gh.repoRaw !== null) setRepoInput(gh.repoRaw);
        }
      },
      () => { if (current) { setFailed(true); setSnap(null); } },
    );
    return () => { current = false; };
  }, [panel, request]);

  const run = async (id, fn) => {
    setBusy(id);
    try {
      const r = await fn();
      setBanner({ ok: r.ok !== false, text: r.summary || '' });
    } catch (err) {
      setBanner({ ok: false, text: String(err && err.message ? err.message : err) });
    } finally {
      setBusy('');
    }
  };

  const backupNow = () => { void run('backup', () => panel.backup()).then(reload); };
  const verifyAll = () => { void run('verify-all', () => panel.verify('all')).then(reload); };
  const verifyOne = (name) => { void run(`verify:${name}`, () => panel.verify(name)); };
  const setAuto = (hours) => { void run('auto', () => panel.setAuto(hours)).then(reload); };
  const syncNow = () => { void run('github-sync', () => panel.githubSyncNow()).then(reload); };
  const pullNow = () => { void run('github-pull', () => panel.githubPull()).then(reload); };
  const saveRepo = (value) => {
    setConfirmDelete(null);
    void run('github-repo', () => panel.setGithubRepo(value)).then(reload);
  };
  const deleteOne = (name) => {
    setConfirmDelete(null);
    void run(`delete:${name}`, () => panel.removeEntry(name)).then(reload);
  };

  // 预览刻意不走 run()：dry-run 的 summary 已由弹窗承载，再落横幅会重复。
  const previewRestore = async (name) => {
    setPending(null);
    setBusy(`restore:${name}`);
    try {
      const r = await panel.restore(name, true);
      if (r.ok) {
        setBanner(null);
        setPending({
          name,
          files: r.files,
          sample: r.sample || [],
          preflight: r.preflight ?? [],
          targetExists: r.targetExists,
        });
      } else {
        setBanner({ ok: false, text: r.summary || t('error') });
      }
    } catch (err) {
      setBanner({ ok: false, text: String(err && err.message ? err.message : err) });
    } finally {
      setBusy('');
    }
  };

  const confirmRestore = () => {
    const target = pending;
    const withDeps = syncDeps;
    setPending(null);
    setSyncDeps(false);
    void run(`restore:${target.name}`, () => panel.restore(target.name, false, withDeps)).then(reload);
  };

  // 确认弹窗打开时 Esc 取消；恢复执行中（busy）不响应，避免误关丢反馈。
  useEffect(() => {
    if (pending === null) return undefined;
    const onKey = (e) => { if (e.key === 'Escape' && busy === '') setPending(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pending, busy]);

  const downloadHref = (name) => (
    typeof window !== 'undefined' && window.location
      ? `${window.location.origin}/backup-download/${encodeURIComponent(name)}`
      : ''
  );

  // Settings save/reset
  const saveSettings = async () => {
    if (!settings || settingsInvalid) return;
    setSettingsStatus('saving');
    setSettingsMsg('');
    const prevDestination = settings.destination || '';
    const keep = Number(keepInput);
    const exclude = excludeInput.split(',').map((s) => s.trim()).filter(Boolean);
    try {
      const res = await fetch('/dsh-backup/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          destination: destInput.trim(),
          keep: Number.isFinite(keep) && keep >= 1 ? Math.floor(keep) : 0,
          exclude,
          revision: settingsRevision,
        }),
      });
      const data = await res.json();
      if (res.status === 409) {
        // 冲突：reload 会触发 useEffect 重新 fetch settings，更新 revision + inputs
        setSettingsStatus('error');
        setSettingsMsg(t('settingsConflict'));
        reload();
        return;
      }
      if (!res.ok || data.error) {
        setSettingsStatus('error');
        // 宿主会返回 invalid-field + fields 名单——原样渲染字段名，别让"以下字段"空着
        setSettingsMsg(data.error === 'invalid-field'
          ? (Array.isArray(data.fields) && data.fields.length
            ? t('settingsInvalidFields').replace('{fields}', data.fields.join(', '))
            : t('settingsInvalid'))
          : String(data.error));
        return;
      }
      applySettings(data);
      setSettingsStatus('saved');
      setSettingsMsg(prevDestination !== destInput.trim() ? t('settingsMovedHint') : '');
      setTimeout(() => setSettingsStatus(''), 4000);
    } catch {
      setSettingsStatus('error');
      setSettingsMsg(t('settingsSaveError'));
    }
  };

  const resetSettings = async () => {
    if (!settings) return;
    setSettingsStatus('saving');
    setSettingsMsg('');
    try {
      const res = await fetch('/dsh-backup/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reset: true, revision: settingsRevision }),
      });
      const data = await res.json();
      if (res.status === 409) {
        setSettingsStatus('error');
        setSettingsMsg(t('settingsConflict'));
        reload();
        return;
      }
      if (!res.ok || data.error) {
        setSettingsStatus('error');
        setSettingsMsg(String(data.error));
        return;
      }
      applySettings(data);
      setSettingsStatus('saved');
      setSettingsMsg('');
      setTimeout(() => setSettingsStatus(''), 2000);
    } catch {
      setSettingsStatus('error');
      setSettingsMsg(t('settingsSaveError'));
    }
  };

  const onSettingsFieldChange = (field, value) => {
    setSettingsDirty(true);
    setSettingsStatus('');
    setSettingsMsg('');
    if (field === 'destination') setDestInput(value);
    else if (field === 'keep') setKeepInput(value);
    else if (field === 'exclude') setExcludeInput(value);
  };

  // 保存前客户端校验：给出 inline 原因，而不是静默禁用保存按钮
  // （UX 审查 P1-8：按钮变灰无提示，同屏还挂着旧的"已保存"）。
  const settingsErrors = [];
  if (settingsDirty && destInput.trim() && /[<>"|?\u0000-\u001f]/.test(destInput)) {
    settingsErrors.push(t('settingsDestInvalid'));
  }
  if (settingsDirty && keepInput !== '' && (!/^\d+$/.test(keepInput) || Number(keepInput) < 1 || Number(keepInput) > 999)) {
    settingsErrors.push(t('settingsKeepInvalid'));
  }
  const settingsInvalid = settingsErrors.length > 0;

  const githubTone = github === null || github.repo === null
    ? undefined
    : (github.tokenSet ? 'ok' : 'warn');

  return (
    <div data-dsh-backup="" aria-busy={busy !== ''}>
      {snap === null && !failed ? <p className="dsb-status">{t('loading')}</p> : null}
      {failed ? (
        <div className="dsb-failure">
          <p role="alert">{t('error')}</p>
          <button type="button" className="dsb-btn-secondary" onClick={reload}>{t('retry')}</button>
        </div>
      ) : null}
      {snap !== null ? (
        <>
          <div className="dsb-card">
            <h3 className="dsb-heading">
              <span>{t('overview')}</span>
              <span className="dsb-badge" data-tone={snap.autoHours > 0 ? 'ok' : undefined}>
                {snap.autoHours > 0
                  ? t('autoOnEvery').replace('{n}', String(snap.autoHours))
                  : t('autoOff')}
              </span>
            </h3>
            <dl className="dsb-kv">
              <dt>{t('dshHome')}</dt>
              <dd>{snap.dshHome}</dd>
              <dt>{t('lastAuto')}</dt>
              <dd>{snap.lastAuto ?? t('none')}</dd>
            </dl>
            {/* Editable settings fields */}
            {settings !== null ? (
              <>
                <div className="dsb-divider" />
                <dl className="dsb-kv">
                  <dt>{t('settingsDestLabel')}</dt>
                  <dd>
                    <input
                      type="text"
                      className="dsb-input"
                      value={destInput}
                      onChange={(e) => onSettingsFieldChange('destination', e.target.value)}
                      placeholder="~/Desktop/dsh-backups"
                    />
                  </dd>
                  <dt>{t('settingsKeepLabel')}</dt>
                  <dd>
                    <input
                      type="number"
                      className="dsb-input"
                      min="1"
                      max="999"
                      aria-label={t('keepAria')}
                      value={keepInput}
                      onChange={(e) => onSettingsFieldChange('keep', e.target.value)}
                    />
                  </dd>
                  <dt>{t('settingsExcludeLabel')}</dt>
                  <dd>
                    <input
                      type="text"
                      className="dsb-input"
                      value={excludeInput}
                      onChange={(e) => onSettingsFieldChange('exclude', e.target.value)}
                      placeholder="*cache*, *.tmp"
                    />
                    <span className="dsb-hint">{t('settingsExcludeHint')}</span>
                  </dd>
                </dl>
                <div className="dsb-row" style={{ marginTop: '8px' }}>
                  <button
                    type="button"
                    className="dsb-btn-primary"
                    disabled={!settingsDirty || settingsInvalid || settingsStatus === 'saving'}
                    onClick={saveSettings}
                  >
                    {settingsStatus === 'saving' ? t('busy') : t('save')}
                  </button>
                  <button
                    type="button"
                    className="dsb-btn-secondary"
                    disabled={!hasOverrides || settingsStatus === 'saving'}
                    onClick={resetSettings}
                  >
                    {t('reset')}
                  </button>
                  {settingsStatus === 'saved' ? (
                    <span className="dsb-status-ok">{t('settingsSaved')}</span>
                  ) : null}
                  {settingsStatus === 'error' ? (
                    <span className="dsb-status-error">{settingsMsg}</span>
                  ) : null}
                </div>
                {settingsInvalid ? (
                  <ul className="dsb-settings-errors" role="alert">
                    {settingsErrors.map((s) => <li key={s}>{s}</li>)}
                  </ul>
                ) : null}
                <p className="dsb-hint" style={{ marginTop: '6px' }}>{t('settingsSourceHint')}</p>
              </>
            ) : null}
            <div className="dsb-divider" />
            <div className="dsb-row">
              {snap.autoHours > 0 ? (
                <button type="button" className="dsb-btn-secondary" disabled={busy !== ''} onClick={() => setAuto(0)}>
                  {t('disable')}
                </button>
              ) : (
                <>
                  <label>
                    {t('autoHoursLabel')}
                    <input
                      type="number" min="1" max="720" value={hoursInput}
                      onChange={(e) => setHoursInput(e.target.value)}
                    />
                  </label>
                  <button
                    type="button" className="dsb-btn-secondary"
                    disabled={busy !== '' || !(Number(hoursInput) >= 1 && Number(hoursInput) <= 720)}
                    onClick={() => setAuto(Math.floor(Number(hoursInput)))}
                  >
                    {t('enable')}
                  </button>
                </>
              )}
              <button type="button" className="dsb-btn-secondary" disabled={busy !== ''} onClick={verifyAll}>
                {busy === 'verify-all' ? t('busy') : t('verifyAll')}
              </button>
              <button type="button" className="dsb-btn-primary" disabled={busy !== ''} onClick={backupNow}>
                {busy === 'backup' ? t('busy') : t('backupNow')}
              </button>
            </div>
          </div>

          {github !== null ? (
            <div className="dsb-card">
              <h3 className="dsb-heading">
                <span>{t('githubTitle')}</span>
                {github.repo !== null ? (
                  <span className="dsb-badge" data-tone={githubTone}>
                    {github.tokenSet ? t('githubTokenSet') : t('githubTokenMissing')}
                  </span>
                ) : null}
              </h3>
              {github.repo === null && repoInput === '' ? (
                <p className="dsb-status">{t('githubNotConfigured')}</p>
              ) : null}
              <dl className="dsb-kv">
                <dt>{t('githubRepo')}</dt>
                <dd>{github.repo ?? t('none')}</dd>
                <dt>{t('githubLastPush')}</dt>
                <dd>{github.lastPush ?? t('none')}</dd>
                {github.lastError !== null ? (
                  <>
                    <dt>{t('githubError')}</dt>
                    <dd>{github.lastError}</dd>
                  </>
                ) : null}
              </dl>
              <div className="dsb-row">
                <label>
                  {t('githubRepoLabel')}
                  <input
                    type="text" placeholder="owner/repo" value={repoInput}
                    onChange={(e) => setRepoInput(e.target.value)}
                    style={{ width: '18em' }}
                  />
                </label>
                <button
                  type="button" className="dsb-btn-secondary"
                  disabled={busy !== '' || repoInput.trim() === ''}
                  onClick={() => saveRepo(repoInput.trim())}
                >
                  {t('save')}
                </button>
                <button
                  type="button" className="dsb-btn-secondary"
                  disabled={busy !== '' || repoInput.trim() === ''}
                  onClick={() => { setRepoInput(''); saveRepo(''); }}
                >
                  {t('clear')}
                </button>
                <button type="button" className="dsb-btn-secondary" disabled={busy !== ''} onClick={syncNow}>
                  {busy === 'github-sync' ? t('githubBusy') : t('githubSyncNow')}
                </button>
                <button type="button" className="dsb-btn-secondary" disabled={busy !== ''} onClick={pullNow}>
                  {busy === 'github-pull' ? t('githubPullBusy') : t('githubPull')}
                </button>
              </div>
            </div>
          ) : null}

          {banner !== null ? (
            <p className="dsb-banner" role="status" data-ok={banner.ok ? 'true' : 'false'}>{banner.text}</p>
          ) : null}

          {pending !== null ? (
            <div className="dsb-modal-backdrop" role="presentation" onClick={() => { if (busy === '') setPending(null); }}>
              <div
                className="dsb-modal"
                role="alertdialog"
                aria-modal="true"
                aria-label={t('restoreConfirmTitle')}
                onClick={(e) => e.stopPropagation()}
              >
                <strong className="dsb-modal-title">{t('restoreConfirmTitle')}</strong>
                <p className="dsb-modal-sub">{pending.name} · {t('restoreEntries').replace('{n}', String(pending.files))}</p>
                <div className="dsb-warn">
                  <p>{t('restoreWarnTitle')}</p>
                  <ul>
                    {(pending.targetExists === false
                      ? [t('restoreWhatFresh')]
                      : [t('restoreWhatMove'), t('restoreWhatSnapshot'), t('restoreWhatWrite')]
                    ).map((s) => <li key={s}>{s}</li>)}
                  </ul>
                </div>
                {pending.preflight.length > 0 ? (
                  <ul className="dsb-preflight">
                    {pending.preflight.map((s) => <li key={s}>{s}</li>)}
                  </ul>
                ) : null}
                <label className="dsb-syncdeps">
                  <input
                    type="checkbox"
                    checked={syncDeps}
                    disabled={busy !== ''}
                    onChange={(e) => setSyncDeps(e.target.checked)}
                  />
                  {t('syncDepsLabel')}
                </label>
                <p className="dsb-status">{syncDeps ? t('restartHintDeps') : t('restartHint')}</p>
                <div className="dsb-row dsb-modal-actions">
                  <button type="button" className="dsb-btn-secondary" disabled={busy !== ''} onClick={() => setPending(null)}>
                    {t('cancel')}
                  </button>
                  <button type="button" className="dsb-btn-danger-solid" disabled={busy !== ''} onClick={confirmRestore}>
                    {busy === `restore:${pending.name}` ? t('busy') : t('confirmRestore')}
                  </button>
                </div>
              </div>
            </div>
          ) : null}

          <div className="dsb-card">
            <h3 className="dsb-heading">
              <span>{t('backupsTitle')}</span>
              <span className="dsb-badge">{snap.backups.length}</span>
            </h3>
            {snap.backups.length === 0 ? (
              <p className="dsb-empty">{t('noBackups')}</p>
            ) : (
              <ul className="dsb-list">
                {snap.backups.map((b) => (
                  <li className="dsb-item" key={b.name}>
                    <span className="dsb-item-name" title={b.name}>{b.name}</span>
                    <span className="dsb-item-meta">{stampOf(b.name) ?? t('sizeUnknown')}</span>
                    <span className="dsb-item-meta">{mb(b.size, t)}</span>
                    <span className="dsb-item-actions">
                      <a href={downloadHref(b.name)} download={b.name}>{t('download')}</a>
                      <button
                        type="button" className="dsb-btn-secondary"
                        disabled={busy !== ''} onClick={() => verifyOne(b.name)}
                      >
                        {busy === `verify:${b.name}` ? t('busy') : t('verify')}
                      </button>
                      <button
                        type="button" className="dsb-btn-secondary"
                        disabled={busy !== ''} onClick={() => previewRestore(b.name)}
                      >
                        {busy === `restore:${b.name}` ? t('busy') : t('restore')}
                      </button>
                      {confirmDelete === b.name ? (
                        <button
                          type="button" className="dsb-btn-danger"
                          disabled={busy !== ''} onClick={() => deleteOne(b.name)}
                          title={t('confirmDeleteName').replace('{name}', b.name)}
                          aria-label={t('confirmDeleteName').replace('{name}', b.name)}
                        >
                          {busy === `delete:${b.name}` ? t('busy') : t('confirmDelete')}
                        </button>
                      ) : (
                        <button
                          type="button" className="dsb-btn-danger"
                          disabled={busy !== ''} onClick={() => setConfirmDelete(b.name)}
                          title={t('confirmDeleteName').replace('{name}', b.name)}
                        >
                          {t('delete')}
                        </button>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <p className="dsb-feedback">
            {t('feedbackHint')}{' '}
            <a
              href="https://github.com/xiaoyuyu6420/dsh-backup/discussions/32"
              target="_blank"
              rel="noreferrer"
            >
              {t('feedbackLink')}
            </a>
          </p>
        </>
      ) : null}
    </div>
  );
}
