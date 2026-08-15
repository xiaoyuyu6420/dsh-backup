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

  const reload = () => { setRequest(v => v + 1); };

  useEffect(() => {
    let current = true;
    setFailed(false);
    void Promise.all([panel.status(), panel.githubStatus()]).then(
      ([snapshot, gh]) => { if (current) { setSnap(snapshot); setGithub(gh); } },
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

  const previewRestore = (name) => {
    setPending(null);
    void run(`restore:${name}`, async () => {
      const r = await panel.restore(name, true);
      if (r.ok) setPending({ name, files: r.files, sample: r.sample || [] });
      return r;
    });
  };

  const confirmRestore = () => {
    const target = pending;
    setPending(null);
    void run(`restore:${target.name}`, () => panel.restore(target.name, false)).then(reload);
  };

  const downloadHref = (name) => (
    typeof window !== 'undefined' && window.location
      ? `${window.location.origin}/backup-download/${encodeURIComponent(name)}`
      : ''
  );

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
              <dt>{t('destination')}</dt>
              <dd>{snap.destination}</dd>
              <dt>{t('keepDefault')}</dt>
              <dd>{snap.keepDefault} {t('copies')}</dd>
              <dt>{t('lastAuto')}</dt>
              <dd>{snap.lastAuto ?? t('none')}</dd>
            </dl>
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
              {github.repo === null ? (
                <p className="dsb-status">{t('githubNotConfigured')}</p>
              ) : (
                <>
                  <dl className="dsb-kv">
                    <dt>{t('githubRepo')}</dt>
                    <dd>{github.repo}</dd>
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
                    <button type="button" className="dsb-btn-secondary" disabled={busy !== ''} onClick={syncNow}>
                      {busy === 'github-sync' ? t('githubBusy') : t('githubSyncNow')}
                    </button>
                  </div>
                </>
              )}
            </div>
          ) : null}

          {banner !== null ? (
            <p className="dsb-banner" role="status" data-ok={banner.ok ? 'true' : 'false'}>{banner.text}</p>
          ) : null}

          {pending !== null ? (
            <div className="dsb-preview">
              <strong>{t('restorePreviewTitle')} — {pending.name} · {t('restoreEntries').replace('{n}', String(pending.files))}</strong>
              <ul>{pending.sample.slice(0, 10).map((s) => <li key={s}>{s}</li>)}</ul>
              <p className="dsb-status">{t('restartHint')}</p>
              <div className="dsb-row">
                <button type="button" className="dsb-btn-danger" disabled={busy !== ''} onClick={confirmRestore}>
                  {t('confirmRestore')}
                </button>
                <button type="button" className="dsb-btn-secondary" disabled={busy !== ''} onClick={() => setPending(null)}>
                  {t('cancel')}
                </button>
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
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}
