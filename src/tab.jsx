/**
 * Settings「备份」标签页：三 Tab 布局（备份 / 恢复 / 设置）。
 * - 备份：状态总览 + 主 CTA「立即备份」+ 自动备份开关 + 最近备份
 * - 恢复：先预览、逐项确认、可回滚的恢复中心（全量 + 分类型）
 * - 设置：备份目录/保留份数/排除模式、GitHub 同步、分类型备份、插件更新
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

/** 分类型备份的候选类型（key 与宿主 BACKUP_TYPES 对齐；标签走 locales）。 */
const TYPE_OPTIONS = [
  ['credentials', 'typeCredentials'],
  ['mcp', 'typeMcp'],
  ['skills', 'typeSkills'],
  ['sessions', 'typeSessions'],
  ['settings', 'typeSettings'],
  ['profiles', 'typeProfiles'],
];

/**
 * 降级标签页（#94 诉求 2）：remote 命名空间挂载失败时给出可见提示，替代
 * 静默消失——命令行（/backup）与定时备份不受影响，仅可视化面板不可用。
 */
export function BackupTabFallback({ panel, t }) {
  const detail = panel && panel.mountError
    ? String(panel.mountError && panel.mountError.message ? panel.mountError.message : panel.mountError)
    : '';
  return (
    <div data-dsh-backup="" className="dsb-card">
      <h3 className="dsb-heading"><span>{t('tab')}</span></h3>
      <p className="dsb-failure" role="alert">{t('fallbackTitle')}</p>
      <p className="dsb-hint">{t('fallbackBody')}</p>
      {detail ? <p className="dsb-hint">{t('fallbackDetail').replace('{detail}', detail)}</p> : null}
    </div>
  );
}

/** 渲染「备份」标签页。 */
export function BackupTab({ panel, t }) {
  const [snap, setSnap] = useState(null);
  const [github, setGithub] = useState(null);
  const [failed, setFailed] = useState(false);
  const [request, setRequest] = useState(0);
  const [busy, setBusy] = useState('');
  const [banner, setBanner] = useState(null);
  const [hoursInput, setHoursInput] = useState('12');
  const [pending, setPending] = useState(null);
  const [repoInput, setRepoInput] = useState('');
  const [tokenInput, setTokenInput] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(null);
  // 分类型备份：本次勾选的类型（空集 = 全量备份）
  const [typeSel, setTypeSel] = useState(() => new Set());
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
  const [updateCheckInput, setUpdateCheckInput] = useState(false);
  // 更新感知（A）：checkUpdate 的结构化结果（null=尚未检查）
  const [update, setUpdate] = useState(null);
  const [settingsDirty, setSettingsDirty] = useState(false);
  const [settingsStatus, setSettingsStatus] = useState(''); // '' | 'saving' | 'saved' | 'error'
  const [settingsMsg, setSettingsMsg] = useState('');
  // 当前 Tab：backup | restore | settings
  const [tab, setTab] = useState('backup');
  // P2：加密口令（仅内存态，绝不落盘）+ 导出/导入
  const [encryptPassword, setEncryptPassword] = useState('');
  const [importPath, setImportPath] = useState('');
  const [importPassword, setImportPassword] = useState('');
  const [importPlan, setImportPlan] = useState(null);
  const [exportResult, setExportResult] = useState(null);
  const [disk, setDisk] = useState(null);
  const [about, setAbout] = useState(null);
  const [profiles, setProfiles] = useState(null);
  const [profileName, setProfileName] = useState('');
  const [profileConfirmDelete, setProfileConfirmDelete] = useState(null);
  const [marketUrlInput, setMarketUrlInput] = useState('');
  const [marketEntries, setMarketEntries] = useState(null);
  const [marketQuery, setMarketQuery] = useState('');
  const [marketPreview, setMarketPreview] = useState(null);
  const [marketBusyId, setMarketBusyId] = useState('');
  const [foreignSources, setForeignSources] = useState(null);
  const [foreignPlan, setForeignPlan] = useState(null);
  const [foreignBusyId, setForeignBusyId] = useState('');
  const [rewindSessions, setRewindSessions] = useState(null);
  const [rewindPlan, setRewindPlan] = useState(null);
  const [chatSessions, setChatSessions] = useState(null);
  const [chatPlan, setChatPlan] = useState(null);
  const [chatBusyId, setChatBusyId] = useState('');
  const [rewindSeq, setRewindSeq] = useState('');
  const [rewindBusyId, setRewindBusyId] = useState('');

  const reload = () => { setRequest(v => v + 1); };

  // 将服务端返回的 settings 数据同步到所有输入状态
  const applySettings = (data) => {
    setSettings(data);
    setSettingsRevision(data.revision);
    setHasOverrides(!!data.hasOverrides);
    setDestInput(data.destination || '');
    setKeepInput(data.keep > 0 ? String(data.keep) : '');
    setExcludeInput(Array.isArray(data.exclude) ? data.exclude.join(', ') : '');
    setUpdateCheckInput(data.updateCheck === true);
    setMarketUrlInput(data.marketUrl || '');
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

  // About 环境信息（非致命：老宿主没有 about() 时静默跳过）
  useEffect(() => {
    let current = true;
    panel.about().then((a) => { if (current) setAbout(a); }).catch(() => { /* 静默 */ });
    return () => { current = false; };
  }, [panel]);

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

  const backupNow = () => { const pwd = encryptPassword.trim() || undefined; void run('backup', () => panel.backup(undefined, undefined, pwd)).then(() => { setEncryptPassword(''); reload(); }); };
  const backupTypedNow = () => { void run('backup-typed', () => panel.backup(undefined, [...typeSel])).then(reload); };
  const verifyAll = () => { void run('verify-all', () => panel.verify('all')).then(reload); };
  const verifyOne = (name) => { void run(`verify:${name}`, () => panel.verify(name)); };
  const setAuto = (hours) => { void run('auto', () => panel.setAuto(hours)).then(reload); };
  const syncNow = () => { void run('github-sync', () => panel.githubSyncNow()).then(reload); };
  const pullNow = () => { void run('github-pull', () => panel.githubPull()).then(reload); };
  const saveRepo = (value) => {
    setConfirmDelete(null);
    void run('github-repo', () => panel.setGithubRepo(value)).then(reload);
  };
  const saveToken = (value) => {
    setConfirmDelete(null);
    void run('github-token', () => panel.setGithubToken(value)).then(() => { setTokenInput(''); return reload(); });
  };
  const deleteOne = (name) => {
    setConfirmDelete(null);
    void run(`delete:${name}`, () => panel.removeEntry(name)).then(reload);
  };
  const toggleType = (key) => setTypeSel((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  const copyPath = () => {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        void navigator.clipboard.writeText(snap?.destination || '');
        setBanner({ ok: true, text: t('pathCopied') });
      } else {
        setBanner({ ok: false, text: t('copyUnsupported') });
      }
    } catch {
      setBanner({ ok: false, text: t('copyUnsupported') });
    }
  };

  // P2：导出配置（单文件 ZIP，默认脱敏）
  const doExport = async () => {
    setBusy('export');
    try {
      const r = await panel.exportConfig({});
      setBanner({ ok: r.ok !== false, text: r.summary || '' });
      if (r.ok !== false) setExportResult(r);
    } catch (err) {
      setBanner({ ok: false, text: String(err && err.message ? err.message : err) });
    } finally {
      setBusy('');
    }
  };

  // P2：导入预览（只读，dry-run 计划）
  const doImportPreview = async () => {
    const path = importPath.trim();
    if (!path) return;
    setBusy('import-preview');
    setImportPlan(null);
    try {
      const opts = { sourcePath: path };
      if (importPassword.trim()) opts.password = importPassword.trim();
      const r = await panel.importPreview(opts);
      setBanner({ ok: r.ok !== false, text: r.summary || '' });
      if (r.ok !== false) setImportPlan(r);
    } catch (err) {
      setBanner({ ok: false, text: String(err && err.message ? err.message : err) });
    } finally {
      setBusy('');
    }
  };

  // P2：导入应用（先自动快照，冲突默认保留现有，失败自动回滚）
  const doImportApply = async () => {
    const path = importPath.trim();
    if (!path) return;
    setBusy('import-apply');
    try {
      const opts = { sourcePath: path, decisions: {} };
      if (importPassword.trim()) opts.password = importPassword.trim();
      const r = await panel.importApply(opts);
      setBanner({ ok: r.ok !== false, text: r.summary || '' });
      setImportPlan(null);
      setImportPassword('');
    } catch (err) {
      setBanner({ ok: false, text: String(err && err.message ? err.message : err) });
    } finally {
      setBusy('');
    }
  };

  // P3：磁盘占用报告 + 分级清理
  const loadDisk = async () => {
    setBusy('disk');
    try {
      const r = await panel.diskUsage();
      setBanner({ ok: r.ok !== false, text: r.summary || '' });
      if (r.ok !== false) setDisk(r);
    } catch (err) {
      setBanner({ ok: false, text: String(err && err.message ? err.message : err) });
    } finally {
      setBusy('');
    }
  };
  const doCleanup = (scope) => { void run(`cleanup-${scope}`, () => panel.cleanup(scope)).then(reload); };

  // P4b-1：Profiles 管理
  const loadProfiles = async () => {
    setBusy('profiles');
    try {
      const r = await panel.profilesList();
      setBanner({ ok: r.ok !== false, text: r.summary || '' });
      if (r.ok !== false) setProfiles(r);
    } catch (err) {
      setBanner({ ok: false, text: String(err && err.message ? err.message : err) });
    } finally {
      setBusy('');
    }
  };
  const doProfileCreate = () => {
    const n = profileName.trim();
    if (!n) return;
    void run('profile-create', () => panel.profileCreate(n)).then(() => { setProfileName(''); return loadProfiles(); });
  };
  const doProfileLaunch = (name) => { void run(`profile-launch:${name}`, () => panel.profileLaunch(name)).then(loadProfiles); };
  const doProfileStop = (name) => { void run(`profile-stop:${name}`, () => panel.profileStop(name)).then(loadProfiles); };
  const doProfileDelete = (name) => { setProfileConfirmDelete(null); void run(`profile-delete:${name}`, () => panel.profileDelete(name)).then(loadProfiles); };

  // P4b-2：配置市场（索引只读；安装走 importPreview/importApply，默认 dry-run）
  const loadMarket = async (q) => {
    setBusy('market');
    try {
      const r = q ? await panel.marketSearch(q) : await panel.marketList();
      setBanner({ ok: r.ok !== false, text: r.summary || '' });
      if (r.ok !== false) setMarketEntries(r.entries || []);
    } catch (err) {
      setBanner({ ok: false, text: String(err && err.message ? err.message : err) });
    } finally {
      setBusy('');
    }
  };
  const previewMarketInstall = async (id) => {
    setMarketBusyId(`preview:${id}`);
    setMarketPreview(null);
    try {
      const r = await panel.marketInstall({ id });
      setBanner({ ok: r.ok !== false, text: r.summary || '' });
      if (r.ok !== false) setMarketPreview({ id, ...r });
    } catch (err) {
      setBanner({ ok: false, text: String(err && err.message ? err.message : err) });
    } finally {
      setMarketBusyId('');
    }
  };
  const confirmMarketInstall = async (id) => {
    setMarketBusyId(`install:${id}`);
    try {
      const r = await panel.marketInstall({ id, confirm: true });
      setBanner({ ok: r.ok !== false, text: r.summary || '' });
      setMarketPreview(null);
    } catch (err) {
      setBanner({ ok: false, text: String(err && err.message ? err.message : err) });
    } finally {
      setMarketBusyId('');
    }
  };

  // P4b-3：从其它 AI agent 导入（检测 → 预览 → 确认导入）
  const loadForeign = async () => {
    setBusy('foreign');
    try {
      const r = await panel.foreignSources();
      setBanner({ ok: r.ok !== false, text: r.summary || '' });
      if (r.ok !== false) setForeignSources(r.sources || []);
    } catch (err) {
      setBanner({ ok: false, text: String(err && err.message ? err.message : err) });
    } finally {
      setBusy('');
    }
  };
  const previewForeign = async (source) => {
    setForeignBusyId(`preview:${source}`);
    setForeignPlan(null);
    try {
      const r = await panel.foreignPreview({ source });
      setBanner({ ok: r.ok !== false, text: r.summary || '' });
      if (r.ok !== false) setForeignPlan({ id: source, ...r });
    } catch (err) {
      setBanner({ ok: false, text: String(err && err.message ? err.message : err) });
    } finally {
      setForeignBusyId('');
    }
  };
  const confirmForeign = async (source) => {
    setForeignBusyId(`import:${source}`);
    try {
      const r = await panel.foreignImport({ source, confirm: true });
      setBanner({ ok: r.ok !== false, text: r.summary || '' });
      setForeignPlan(null);
    } catch (err) {
      setBanner({ ok: false, text: String(err && err.message ? err.message : err) });
    } finally {
      setForeignBusyId('');
    }
  };

  // P4b-3b：会话 Rewind（分叉；原会话不改）
  const rewindSeqValue = () => {
    const n = Number(rewindSeq.trim());
    return rewindSeq.trim() !== '' && Number.isInteger(n) ? n : undefined;
  };
  const loadRewind = async () => {
    setBusy('rewind');
    try {
      const r = await panel.sessionRewindList();
      setBanner({ ok: r.ok !== false, text: r.summary || '' });
      if (r.ok !== false) setRewindSessions(r.sessions || []);
    } catch (err) {
      setBanner({ ok: false, text: String(err && err.message ? err.message : err) });
    } finally {
      setBusy('');
    }
  };
  const previewRewind = async (id) => {
    setRewindBusyId(`preview:${id}`);
    setRewindPlan(null);
    try {
      const r = await panel.sessionRewindPreview(id, rewindSeqValue());
      setBanner({ ok: r.ok !== false, text: r.summary || '' });
      if (r.ok !== false) setRewindPlan({ id, ...r });
    } catch (err) {
      setBanner({ ok: false, text: String(err && err.message ? err.message : err) });
    } finally {
      setRewindBusyId('');
    }
  };
  const confirmRewind = async (id) => {
    setRewindBusyId(`apply:${id}`);
    try {
      const r = await panel.sessionRewindApply({ session: id, seq: rewindSeqValue(), confirm: true });
      setBanner({ ok: r.ok !== false, text: r.summary || '' });
      setRewindPlan(null);
    } catch (err) {
      setBanner({ ok: false, text: String(err && err.message ? err.message : err) });
    } finally {
      setRewindBusyId('');
    }
  };

  // P4c: external chat-history import (scan -> preview -> confirm as a new session)
  const loadChat = async () => {
    setBusy('chat');
    try {
      const r = await panel.chatSources();
      setBanner({ ok: r.ok !== false, text: r.summary || '' });
      if (r.ok !== false) setChatSessions(r.sessions || []);
    } catch (err) {
      setBanner({ ok: false, text: String(err && err.message ? err.message : err) });
    } finally {
      setBusy('');
    }
  };
  const previewChat = async (id) => {
    setChatBusyId(`preview:${id}`);
    setChatPlan(null);
    try {
      const r = await panel.chatPreview({ session: id });
      setBanner({ ok: r.ok !== false, text: r.summary || '' });
      if (r.ok !== false) setChatPlan({ session: id, ...r });
    } catch (err) {
      setBanner({ ok: false, text: String(err && err.message ? err.message : err) });
    } finally {
      setChatBusyId('');
    }
  };
  const confirmChat = async (id) => {
    setChatBusyId(`import:${id}`);
    try {
      const r = await panel.chatApply({ session: id, confirm: true });
      setBanner({ ok: r.ok !== false, text: r.summary || '' });
      setChatPlan(null);
    } catch (err) {
      setBanner({ ok: false, text: String(err && err.message ? err.message : err) });
    } finally {
      setChatBusyId('');
    }
  };

  // 更新感知（A）：结构化结果落卡（检查/更新按钮态），结果文案落横幅
  const checkForUpdate = async () => {
    setBusy('update-check');
    try {
      const u = await panel.checkUpdate();
      setUpdate(u);
      setBanner({ ok: u.ok !== false, text: u.summary || '' });
    } catch (err) {
      setBanner({ ok: false, text: String(err && err.message ? err.message : err) });
    } finally {
      setBusy('');
    }
  };
  const updateNow = async () => {
    setBusy('update');
    try {
      const r = await panel.update();
      setBanner({ ok: r.ok !== false, text: r.summary || '' });
      setUpdate((prev) => (r.ok && r.updated ? { ...(prev || {}), current: r.current, latest: r.latest, update: false } : prev));
    } catch (err) {
      setBanner({ ok: false, text: String(err && err.message ? err.message : err) });
    } finally {
      setBusy('');
    }
  };

  // 开启「自动检查」时：面板加载后静默查一次；有新版本只更新卡状态，不弹打扰
  useEffect(() => {
    if (settings?.updateCheck !== true || update !== null) return undefined;
    let current = true;
    void panel.checkUpdate()
      .then((u) => { if (current) setUpdate(u); })
      .catch(() => { /* 静默：检查失败不打扰，卡上有手动按钮 */ });
    return () => { current = false; };
  }, [settings, update, panel]);

  // 预览刻意不走 run()：dry-run 的 summary 已由弹窗承载，再落横幅会重复。
  const previewRestore = async (name, types) => {
    setPending(null);
    // 勾选状态在每次打开预览时重置——取消/Esc/背板退出不会走到 confirmRestore，
    // 残留的勾选会让下一次恢复"默认重装依赖"（review P1-2）
    setSyncDeps(false);
    setBusy(`restore:${name}`);
    try {
      const r = await panel.restore(name, true, types);
      if (r.ok) {
        setBanner(null);
        setPending({
          name,
          files: r.files,
          sample: r.sample || [],
          preflight: r.preflight ?? [],
          targetExists: r.targetExists,
          merge: Boolean(r.merge),
          types: r.merge ? r.types ?? [] : [],
          willOverwrite: r.willOverwrite ?? [],
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
    void run(`restore:${target.name}`, () => panel.restore(target.name, false, target.merge ? target.types : undefined, withDeps)).then(reload);
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
          updateCheck: updateCheckInput === true,
          marketUrl: marketUrlInput.trim(),
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
    else if (field === 'updateCheck') setUpdateCheckInput(value === true);
    else if (field === 'marketUrl') setMarketUrlInput(value);
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

  const latest = snap?.backups?.[0];
  const lastBackupLabel = latest ? (stampOf(latest.name) ?? latest.name) : (snap?.lastAuto ?? t('none'));

  const backupRow = (b) => (
    <li className="dsb-item" key={b.name}>
      <span className="dsb-item-name" title={b.name}>{stampOf(b.name) ?? b.name}</span>
      <span className="dsb-item-meta">{mb(b.size, t)}</span>
      <span className="dsb-item-actions">
        <a href={downloadHref(b.name)} download={b.name}>{t('download')}</a>
        <button type="button" className="dsb-btn-secondary" disabled={busy !== ''} onClick={() => verifyOne(b.name)}>
          {busy === `verify:${b.name}` ? t('busy') : t('verify')}
        </button>
        <button type="button" className="dsb-btn-primary" disabled={busy !== ''} onClick={() => previewRestore(b.name)}>
          {busy === `restore:${b.name}` ? t('busy') : t('restore')}
        </button>
        {confirmDelete === b.name ? (
          <button type="button" className="dsb-btn-danger" disabled={busy !== ''} onClick={() => deleteOne(b.name)}
            title={t('confirmDeleteName').replace('{name}', b.name)}
            aria-label={t('confirmDeleteName').replace('{name}', b.name)}>
            {busy === `delete:${b.name}` ? t('busy') : t('confirmDelete')}
          </button>
        ) : (
          <button type="button" className="dsb-btn-danger" disabled={busy !== ''} onClick={() => setConfirmDelete(b.name)}
            title={t('confirmDeleteName').replace('{name}', b.name)}>
            {t('delete')}
          </button>
        )}
      </span>
    </li>
  );

  const typedRow = (b) => (
    <li className="dsb-item" key={b.name}>
      <span className="dsb-item-name" title={b.name}>{stampOf(b.name) ?? b.name}</span>
      <span className="dsb-badge">{(b.types ?? []).join(', ') || '?'}</span>
      <span className="dsb-item-meta">{mb(b.size, t)}</span>
      <span className="dsb-item-actions">
        <a href={downloadHref(b.name)} download={b.name}>{t('download')}</a>
        <button type="button" className="dsb-btn-primary" disabled={busy !== ''} onClick={() => previewRestore(b.name, b.types ?? [])}>
          {busy === `restore:${b.name}` ? t('busy') : t('restoreTyped')}
        </button>
        {confirmDelete === b.name ? (
          <button type="button" className="dsb-btn-danger" disabled={busy !== ''} onClick={() => deleteOne(b.name)}
            title={t('confirmDeleteName').replace('{name}', b.name)}
            aria-label={t('confirmDeleteName').replace('{name}', b.name)}>
            {busy === `delete:${b.name}` ? t('busy') : t('confirmDelete')}
          </button>
        ) : (
          <button type="button" className="dsb-btn-danger" disabled={busy !== ''} onClick={() => setConfirmDelete(b.name)}
            title={t('confirmDeleteName').replace('{name}', b.name)}>
            {t('delete')}
          </button>
        )}
      </span>
    </li>
  );

  const encryptField = (
    <div className="dsb-row" style={{ marginTop: '8px' }}>
      <label>
        <span className="dsb-item-meta">{t('encryptLabel')}</span>
        <input type="password" autoComplete="new-password" placeholder={t('encryptPlaceholder')} value={encryptPassword} onChange={(e) => setEncryptPassword(e.target.value)} />
      </label>
      <span className="dsb-hint">{t('encryptHint')}</span>
    </div>
  );

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
          <nav className="dsb-tabs" role="tablist" aria-label={t('tab')}>
            <button type="button" role="tab" aria-selected={tab === 'backup'} className={tab === 'backup' ? 'active' : ''} onClick={() => setTab('backup')}>{t('tabBackup')}</button>
            <button type="button" role="tab" aria-selected={tab === 'restore'} className={tab === 'restore' ? 'active' : ''} onClick={() => setTab('restore')}>{t('tabRestore')}</button>
            <button type="button" role="tab" aria-selected={tab === 'settings'} className={tab === 'settings' ? 'active' : ''} onClick={() => setTab('settings')}>{t('tabSettings')}</button>
          </nav>

          {banner !== null ? (
            <p className="dsb-banner" role="status" data-ok={banner.ok ? 'true' : 'false'}>{banner.text}</p>
          ) : null}

          {tab === 'backup' ? (
            <>
              {snap.backups.length === 0 ? (
                <div className="dsb-card dsb-hero">
                  <h3 className="dsb-heading"><span>{t('backupHeroTitle')}</span></h3>
                  <p className="dsb-hint" style={{ fontSize: '13px', lineHeight: 1.7 }}>{t('backupHeroDesc')}</p>
                  <div className="dsb-row" style={{ marginTop: '16px' }}>
                    <button type="button" className="dsb-btn-primary dsb-btn-big" disabled={busy !== ''} onClick={backupNow}>
                      {busy === 'backup' ? t('busy') : t('backupNow')}
                    </button>
                  </div>
                  <p className="dsb-hint">{t('backupHeroSafe')}</p>
                  {encryptField}
                  <div className="dsb-steps">
                    <div className="dsb-step"><b>1 · {t('backupOnce')}</b><span>{t('backupOnceHint')}</span></div>
                    <div className="dsb-step"><b>2 · {t('learnRestore')}</b><span>{t('learnRestoreHint')}</span></div>
                    <div className="dsb-step"><b>3 · {t('enableAutoStep')}</b><span>{t('enableAutoStepHint')}</span></div>
                  </div>
                </div>
              ) : (
                <div className="dsb-card dsb-hero">
                  <h3 className="dsb-heading">
                    <span>{t('backupStatusTitle')}</span>
                    <span className="dsb-badge" data-tone={snap.autoHours > 0 ? 'ok' : undefined}>
                      {snap.autoHours > 0 ? t('autoOnEvery').replace('{n}', String(snap.autoHours)) : t('autoOff')}
                    </span>
                  </h3>
                  <dl className="dsb-kv">
                    <dt>{t('lastBackup')}</dt>
                    <dd>{lastBackupLabel}{latest && typeof latest.size === 'number' ? ` · ${mb(latest.size, t)}` : ''}</dd>
                    <dt>{t('destination')}</dt>
                    <dd className="dsb-mono">{snap.destination} <button type="button" className="dsb-btn-small-ghost" onClick={copyPath}>{t('copyPath')}</button></dd>
                  </dl>
                  <div className="dsb-row" style={{ marginTop: '16px' }}>
                    <button type="button" className="dsb-btn-primary dsb-btn-big" disabled={busy !== ''} onClick={backupNow}>
                      {busy === 'backup' ? t('busy') : t('backupNow')}
                    </button>
                    <button type="button" className="dsb-btn-secondary dsb-btn-big" disabled={busy !== ''} onClick={() => setTab('restore')}>
                      {t('restoreLatest')}
                    </button>
                  </div>
                  {encryptField}
                </div>
              )}

              <div className="dsb-card">
                <h3 className="dsb-heading">
                  <span>{t('autoTitle')}</span>
                  <span className="dsb-badge" data-tone={snap.autoHours > 0 ? 'ok' : undefined}>
                    {snap.autoHours > 0 ? t('autoOnEvery').replace('{n}', String(snap.autoHours)) : t('autoOff')}
                  </span>
                </h3>
                {snap.autoHours > 0 ? (
                  <div className="dsb-row">
                    <span className="dsb-muted">{t('autoOnEvery').replace('{n}', String(snap.autoHours))}</span>
                    <button type="button" className="dsb-btn-secondary" disabled={busy !== ''} onClick={() => setAuto(0)}>
                      {t('disable')}
                    </button>
                  </div>
                ) : (
                  <>
                    <div className="dsb-row">
                      <label>{t('everyLabel')}
                        <input type="number" min="1" max="720" value={hoursInput} onChange={(e) => setHoursInput(e.target.value)} />
                      </label>
                      <button
                        type="button" className="dsb-btn-primary"
                        disabled={busy !== '' || !(Number(hoursInput) >= 1 && Number(hoursInput) <= 720)}
                        onClick={() => setAuto(Math.floor(Number(hoursInput)))}
                      >
                        {t('enable')}
                      </button>
                    </div>
                    <p className="dsb-hint">{t('autoRecommended')}</p>
                  </>
                )}
              </div>

              <div className="dsb-card">
                <h3 className="dsb-heading">
                  <span>{t('backupsTitle')}</span>
                  <span className="dsb-badge">{snap.backups.length}</span>
                  <span className="dsb-heading-right">
                    <button type="button" className="dsb-btn-small" disabled={busy !== ''} onClick={verifyAll}>
                      {busy === 'verify-all' ? t('busy') : t('verifyAll')}
                    </button>
                    <button type="button" className="dsb-btn-small-ghost" onClick={() => setTab('restore')}>{t('goRestore')}</button>
                  </span>
                </h3>
                {snap.backups.length === 0 ? (
                  <p className="dsb-empty">{t('noBackups')}</p>
                ) : (
                  <ul className="dsb-list">{snap.backups.slice(0, 3).map(backupRow)}</ul>
                )}
              </div>
            </>
          ) : null}

          {tab === 'restore' ? (
            <>
              <div className="dsb-card dsb-info">
                <p className="dsb-info-text">{t('restoreExplainBody')}</p>
              </div>
              <div className="dsb-card">
                <h3 className="dsb-heading">
                  <span>{t('backupsTitle')}</span>
                  <span className="dsb-badge">{snap.backups.length}</span>
                </h3>
                {snap.backups.length === 0 ? (
                  <p className="dsb-empty">{t('restoreEmpty')}</p>
                ) : (
                  <ul className="dsb-list">{snap.backups.map(backupRow)}</ul>
                )}
              </div>
              {(snap.typedBackups ?? []).length ? (
                <div className="dsb-card">
                  <h3 className="dsb-heading">
                    <span>{t('typedTitle')}</span>
                    <span className="dsb-badge">{snap.typedBackups.length}</span>
                  </h3>
                  <ul className="dsb-list">{snap.typedBackups.map(typedRow)}</ul>
                  <p className="dsb-status">{t('typedHint')}</p>
                </div>
              ) : null}
            </>
          ) : null}

          {tab === 'settings' ? (
            <>
              <div className="dsb-card">
                <h3 className="dsb-heading"><span>{t('settingsTitle')}</span></h3>
                <p className="dsb-hint">{t('settingsIntro')}</p>
                {settings !== null ? (
                  <>
                    <dl className="dsb-kv">
                      <dt>{t('settingsDestLabel')}</dt>
                      <dd>
                        <input type="text" className="dsb-input" value={destInput}
                          onChange={(e) => onSettingsFieldChange('destination', e.target.value)}
                          placeholder="~/Desktop/DSH Backups" />
                      </dd>
                      <dt>{t('settingsKeepLabel')}</dt>
                      <dd>
                        <input type="number" className="dsb-input" min="1" max="999" aria-label={t('keepAria')}
                          placeholder="7" value={keepInput} onChange={(e) => onSettingsFieldChange('keep', e.target.value)} />
                        <span className="dsb-hint">{t('keepHint')}</span>
                      </dd>
                      <dt>{t('settingsExcludeLabel')}</dt>
                      <dd>
                        <input type="text" className="dsb-input" value={excludeInput}
                          onChange={(e) => onSettingsFieldChange('exclude', e.target.value)}
                          placeholder="*cache*, *.tmp" />
                        <span className="dsb-hint">{t('settingsExcludeHint')}</span>
                      </dd>
                      <dt>{t('marketUrlLabel')}</dt>
                      <dd>
                        <input type="text" className="dsb-input" value={marketUrlInput}
                          onChange={(e) => onSettingsFieldChange('marketUrl', e.target.value)}
                          placeholder="https://example.com/market.json" />
                        <span className="dsb-hint">{t('marketUrlHint')}</span>
                      </dd>
                      <dt>{t('updateAutoLabel')}</dt>
                      <dd>
                        <input type="checkbox" checked={updateCheckInput}
                          onChange={(e) => onSettingsFieldChange('updateCheck', e.target.checked)} />
                      </dd>
                    </dl>
                    <div className="dsb-row" style={{ marginTop: '8px' }}>
                      <button type="button" className="dsb-btn-primary" disabled={!settingsDirty || settingsInvalid || settingsStatus === 'saving'} onClick={saveSettings}>
                        {settingsStatus === 'saving' ? t('busy') : t('save')}
                      </button>
                      <button type="button" className="dsb-btn-secondary" disabled={!hasOverrides || settingsStatus === 'saving'} onClick={resetSettings}>
                        {t('reset')}
                      </button>
                      {settingsStatus === 'saved' ? <span className="dsb-status-ok">{t('settingsSaved')}{settingsMsg ? ` ${settingsMsg}` : ''}</span> : null}
                      {settingsStatus === 'error' ? <span className="dsb-status-error">{settingsMsg}</span> : null}
                    </div>
                    {settingsInvalid ? (
                      <ul className="dsb-settings-errors" role="alert">
                        {settingsErrors.map((s) => <li key={s}>{s}</li>)}
                      </ul>
                    ) : null}
                  </>
                ) : null}
              </div>

              {github !== null ? (
                <div className="dsb-card">
                  <h3 className="dsb-heading">
                    <span>{t('githubTitle')}</span>
                    <span className="dsb-badge" data-tone={githubTone}>
                      {github.repo === null ? t('githubOff') : (github.tokenSet ? t('githubTokenSet') : t('githubTokenMissing'))}
                    </span>
                  </h3>
                  {github.repo === null ? (
                    <p className="dsb-hint">{t('githubNotConfigured')}</p>
                  ) : (
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
                  )}
                  <div className="dsb-row">
                    <label>{t('githubRepoLabel')}
                      <input type="text" placeholder="owner/repo" value={repoInput} onChange={(e) => setRepoInput(e.target.value)} style={{ width: '18em' }} />
                    </label>
                    <button type="button" className="dsb-btn-secondary" disabled={busy !== '' || repoInput.trim() === ''} onClick={() => saveRepo(repoInput.trim())}>
                      {t('save')}
                    </button>
                    <button type="button" className="dsb-btn-secondary" disabled={busy !== '' || repoInput.trim() === ''} onClick={() => { setRepoInput(''); saveRepo(''); }}>
                      {t('clear')}
                    </button>
                  </div>
                  {github.repo !== null ? (
                    <div className="dsb-row" style={{ marginTop: '10px' }}>
                      <button type="button" className="dsb-btn-secondary" disabled={busy !== ''} onClick={syncNow}>
                        {busy === 'github-sync' ? t('githubBusy') : t('githubSyncNow')}
                      </button>
                      <button type="button" className="dsb-btn-secondary" disabled={busy !== ''} onClick={pullNow}>
                        {busy === 'github-pull' ? t('githubPullBusy') : t('githubPull')}
                      </button>
                    </div>
                  ) : null}
                  <div className="dsb-row" style={{ marginTop: '10px' }}>
                    <label>{t('githubTokenLabel')}
                      <input type="password" autoComplete="off" placeholder={t('githubTokenPlaceholder')} value={tokenInput} onChange={(e) => setTokenInput(e.target.value)} style={{ width: '18em' }} />
                    </label>
                    <button type="button" className="dsb-btn-secondary" disabled={busy !== '' || tokenInput.trim() === ''} onClick={() => saveToken(tokenInput.trim())}>
                      {t('save')}
                    </button>
                    <button type="button" className="dsb-btn-secondary" disabled={busy !== ''} onClick={() => saveToken('off')}>
                      {t('clear')}
                    </button>
                    <span className="dsb-item-meta">{t('githubTokenNote')}</span>
                  </div>
                  <p className="dsb-hint">{t('syncChannelsHint')}</p>
                </div>
              ) : null}

              <div className="dsb-card">
                <h3 className="dsb-heading"><span>{t('typedTitle')}</span><span className="dsb-badge">{t('advanced')}</span></h3>
                <p className="dsb-hint">{t('typesIntro')}</p>
                <div className="dsb-chips">
                  {TYPE_OPTIONS.map(([key, label]) => (
                    <button key={key} type="button" className={`dsb-chip ${typeSel.has(key) ? 'on' : ''}`} aria-pressed={typeSel.has(key)} onClick={() => toggleType(key)}>
                      {t(label)}
                    </button>
                  ))}
                </div>
                {typeSel.has('credentials') ? <p className="dsb-hint">{t('credWarn')}</p> : null}
                <div className="dsb-row" style={{ marginTop: '10px' }}>
                  <button type="button" className="dsb-btn-primary" disabled={busy !== '' || !typeSel.size} onClick={backupTypedNow}>
                    {busy === 'backup-typed' ? t('busy') : t('backupTyped')}
                  </button>
                </div>
              </div>

              <div className="dsb-card">
                <h3 className="dsb-heading"><span>{t('exportTitle')}</span></h3>
                <p className="dsb-hint">{t('exportIntro')}</p>
                <div className="dsb-row">
                  <button type="button" className="dsb-btn-secondary" disabled={busy !== ''} onClick={doExport}>
                    {busy === 'export' ? t('busy') : t('exportNow')}
                  </button>
                  {exportResult && exportResult.name ? (
                    <a className="dsb-btn-secondary" href={downloadHref(exportResult.name)} download={exportResult.name}>{t('download')}</a>
                  ) : null}
                </div>
                <div className="dsb-divider" />
                <div className="dsb-row">
                  <label>
                    <span className="dsb-item-meta">{t('importPathLabel')}</span>
                    <input type="text" placeholder="/path/to/dsh-config-xxx.zip" value={importPath} onChange={(e) => setImportPath(e.target.value)} style={{ width: '22em' }} />
                  </label>
                </div>
                <div className="dsb-row" style={{ marginTop: '8px' }}>
                  <label>
                    <span className="dsb-item-meta">{t('encryptLabel')}</span>
                    <input type="password" autoComplete="new-password" placeholder={t('encryptPlaceholder')} value={importPassword} onChange={(e) => setImportPassword(e.target.value)} style={{ width: '16em' }} />
                  </label>
                  <button type="button" className="dsb-btn-secondary" disabled={busy !== '' || !importPath.trim()} onClick={doImportPreview}>
                    {busy === 'import-preview' ? t('busy') : t('importPreview')}
                  </button>
                </div>
                {importPlan ? (
                  <div className="dsb-import-plan">
                    <p className="dsb-status">{t('importSectionsTitle').replace('{n}', String(importPlan.sections?.length ?? 0))}</p>
                    <ul className="dsb-list">
                      {(importPlan.sections ?? []).map((s) => (
                        <li className="dsb-item" key={s.key}>
                          <span className="dsb-item-name">{s.label ?? s.key}</span>
                          <span className="dsb-item-meta">{s.files ?? 0} 项</span>
                          <span className="dsb-item-meta">{s.conflicts && s.conflicts.length ? t('importConflicts').replace('{n}', String(s.conflicts.length)) : ''}</span>
                        </li>
                      ))}
                    </ul>
                    {importPlan.compatibility && importPlan.compatibility.score ? <p className="dsb-hint">{t('compatScore')}: {importPlan.compatibility.score}</p> : null}
                    <p className="dsb-hint">{t('importKeepHint')}</p>
                    <div className="dsb-row">
                      <button type="button" className="dsb-btn-primary" disabled={busy !== ''} onClick={doImportApply}>
                        {busy === 'import-apply' ? t('busy') : t('importApply')}
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>

              <div className="dsb-card">
                <h3 className="dsb-heading"><span>{t('foreignTitle')}</span></h3>
                <p className="dsb-hint">{t('foreignHint')}</p>
                <div className="dsb-row">
                  <button type="button" className="dsb-btn-secondary" disabled={busy !== ''} onClick={loadForeign}>
                    {busy === 'foreign' ? t('busy') : t('foreignRefresh')}
                  </button>
                </div>
                {foreignSources && foreignSources.length ? (
                  <ul className="dsb-list">
                    {foreignSources.map((s) => (
                      <li className="dsb-item" key={s.id}>
                        <span className="dsb-item-name">{s.label ?? s.id}</span>
                        <span className="dsb-item-meta">{s.detected ? `${t('foreignDetected')} · ${s.skills ?? 0} skills · MCP ${(s.mcpServers ?? []).length}` : t('foreignNotDetected')}</span>
                        <span className="dsb-item-actions">
                          <button type="button" className="dsb-btn-secondary" disabled={busy !== '' || !s.detected || foreignBusyId !== ''} onClick={() => previewForeign(s.id)}>
                            {foreignBusyId === `preview:${s.id}` ? t('busy') : t('foreignPreview')}
                          </button>
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="dsb-empty">{t('foreignEmpty')}</p>
                )}
                {foreignPlan ? (
                  <div className="dsb-import-plan">
                    <p className="dsb-status">{foreignPlan.summary}</p>
                    <div className="dsb-row">
                      <button type="button" className="dsb-btn-primary" disabled={foreignBusyId !== ''} onClick={() => confirmForeign(foreignPlan.id)}>
                        {t('foreignConfirmImport')}
                      </button>
                      <button type="button" className="dsb-btn-secondary" disabled={foreignBusyId !== ''} onClick={() => setForeignPlan(null)}>
                        {t('cancel')}
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>

              <div className="dsb-card">
                <h3 className="dsb-heading"><span>{t('rewindTitle')}</span></h3>
                <p className="dsb-hint">{t('rewindHint')}</p>
                <div className="dsb-row">
                  <button type="button" className="dsb-btn-secondary" disabled={busy !== ''} onClick={loadRewind}>
                    {busy === 'rewind' ? t('busy') : t('rewindRefresh')}
                  </button>
                  <label>
                    <input type="text" placeholder={t('rewindSeqPlaceholder')} value={rewindSeq} onChange={(e) => setRewindSeq(e.target.value)} />
                  </label>
                </div>
                {rewindSessions && rewindSessions.length ? (
                  <ul className="dsb-list">
                    {rewindSessions.map((s) => (
                      <li className="dsb-item" key={s.id}>
                        <span className="dsb-item-name">{s.id}</span>
                        <span className="dsb-item-meta">{s.cwd ?? ''}</span>
                        <span className="dsb-item-actions">
                          <button type="button" className="dsb-btn-secondary" disabled={busy !== '' || rewindBusyId !== ''} onClick={() => previewRewind(s.id)}>
                            {rewindBusyId === `preview:${s.id}` ? t('busy') : t('rewindPreview')}
                          </button>
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="dsb-empty">{t('rewindEmpty')}</p>
                )}
                {rewindPlan ? (
                  <div className="dsb-import-plan">
                    <p className="dsb-status">{rewindPlan.summary}</p>
                    <div className="dsb-row">
                      <button type="button" className="dsb-btn-primary" disabled={rewindBusyId !== ''} onClick={() => confirmRewind(rewindPlan.session)}>
                        {t('rewindConfirm')}
                      </button>
                      <button type="button" className="dsb-btn-secondary" disabled={rewindBusyId !== ''} onClick={() => setRewindPlan(null)}>
                        {t('cancel')}
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>

              <div className="dsb-card">
                <h3 className="dsb-heading"><span>{t('chatTitle')}</span></h3>
                <p className="dsb-hint">{t('chatHint')}</p>
                <div className="dsb-row">
                  <button type="button" className="dsb-btn-secondary" disabled={busy !== ''} onClick={loadChat}>
                    {busy === 'chat' ? t('busy') : t('chatRefresh')}
                  </button>
                </div>
                {chatSessions && chatSessions.length ? (
                  <ul className="dsb-list">
                    {chatSessions.map((s) => (
                      <li className="dsb-item" key={s.id}>
                        <span className="dsb-item-name">{s.title || s.file || s.id}</span>
                        <span className="dsb-item-meta">{`${s.messages ?? 0} ${t('chatMessages')}${s.project ? ` · ${s.project}` : ''}`}</span>
                        <span className="dsb-item-actions">
                          <button type="button" className="dsb-btn-secondary" disabled={busy !== '' || chatBusyId !== ''} onClick={() => previewChat(s.id)}>
                            {chatBusyId === `preview:${s.id}` ? t('busy') : t('chatPreview')}
                          </button>
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="dsb-empty">{t('chatEmpty')}</p>
                )}
                {chatPlan ? (
                  <div className="dsb-import-plan">
                    <p className="dsb-status">{chatPlan.summary}</p>
                    {(chatPlan.warnings || []).map((w) => <p className="dsb-hint" key={w}>{w}</p>)}
                    <div className="dsb-row">
                      <button type="button" className="dsb-btn-primary" disabled={chatBusyId !== ''} onClick={() => confirmChat(chatPlan.session)}>
                        {t('chatConfirmImport')}
                      </button>
                      <button type="button" className="dsb-btn-secondary" disabled={chatBusyId !== ''} onClick={() => setChatPlan(null)}>
                        {t('cancel')}
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>


              <div className="dsb-card">
                <h3 className="dsb-heading">
                  <span>{t('marketTitle')}</span>
                  {marketEntries ? <span className="dsb-badge">{marketEntries.length}</span> : null}
                </h3>
                <div className="dsb-row">
                  <button type="button" className="dsb-btn-secondary" disabled={busy !== ''} onClick={() => loadMarket()}>
                    {busy === 'market' ? t('busy') : t('marketRefresh')}
                  </button>
                  <label>
                    <input type="text" placeholder={t('marketSearchPlaceholder')} value={marketQuery} onChange={(e) => setMarketQuery(e.target.value)} />
                  </label>
                  <button type="button" className="dsb-btn-secondary" disabled={busy !== '' || !marketQuery.trim()} onClick={() => loadMarket(marketQuery.trim())}>
                    {t('marketSearch')}
                  </button>
                </div>
                {marketEntries && marketEntries.length ? (
                  <ul className="dsb-list">
                    {marketEntries.map((e) => (
                      <li className="dsb-item" key={e.id}>
                        <span className="dsb-item-name">{e.name}{e.risk === 'high' ? ` · ${t('marketRiskHigh')}` : ''}</span>
                        <span className="dsb-item-meta">{e.desc ?? ''}</span>
                        <span className="dsb-item-actions">
                          <button type="button" className="dsb-btn-secondary" disabled={busy !== '' || marketBusyId !== ''} onClick={() => previewMarketInstall(e.id)}>
                            {marketBusyId === `preview:${e.id}` ? t('busy') : t('marketPreview')}
                          </button>
                          <button type="button" className="dsb-btn-primary" disabled={busy !== '' || marketBusyId !== ''} onClick={() => confirmMarketInstall(e.id)}>
                            {marketBusyId === `install:${e.id}` ? t('busy') : t('marketInstall')}
                          </button>
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="dsb-empty">{t('marketEmpty')}</p>
                )}
                {marketPreview ? (
                  <div className="dsb-import-plan">
                    <p className="dsb-status">{marketPreview.summary}</p>
                    {marketPreview.supplyChain && marketPreview.supplyChain.length ? (
                      <ul className="dsb-list">
                        {marketPreview.supplyChain.map((s) => (
                          <li className="dsb-item" key={s}><span className="dsb-item-name">{s}</span></li>
                        ))}
                      </ul>
                    ) : null}
                    <div className="dsb-row">
                      <button type="button" className="dsb-btn-primary" disabled={marketBusyId !== ''} onClick={() => confirmMarketInstall(marketPreview.id)}>
                        {t('marketConfirmInstall')}
                      </button>
                      <button type="button" className="dsb-btn-secondary" disabled={marketBusyId !== ''} onClick={() => setMarketPreview(null)}>
                        {t('cancel')}
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>

              <div className="dsb-card">
                <h3 className="dsb-heading">
                  <span>{t('diskTitle')}</span>
                  {disk && disk.totalText ? <span className="dsb-badge">{disk.totalText}</span> : null}
                </h3>
                <div className="dsb-row">
                  <button type="button" className="dsb-btn-secondary" disabled={busy !== ''} onClick={loadDisk}>
                    {busy === 'disk' ? t('busy') : t('diskView')}
                  </button>
                  <button type="button" className="dsb-btn-secondary" disabled={busy !== ''} onClick={() => doCleanup('cache')}>
                    {busy === 'cleanup-cache' ? t('busy') : t('diskCleanCache')}
                  </button>
                  <button type="button" className="dsb-btn-secondary" disabled={busy !== ''} onClick={() => doCleanup('expired')}>
                    {busy === 'cleanup-expired' ? t('busy') : t('diskCleanExpired')}
                  </button>
                </div>
                {disk && disk.categories ? (
                  <ul className="dsb-list">
                    {disk.categories.map((c) => (
                      <li className="dsb-item" key={c.key}>
                        <span className="dsb-item-name">{c.label ?? c.key}</span>
                        <span className="dsb-item-meta">{c.files ?? 0} 个</span>
                        <span className="dsb-item-meta">{mb(c.bytes, t)}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>

              <div className="dsb-card">
                <h3 className="dsb-heading">
                  <span>{t('updateTitle')}</span>
                  {update ? <span className="dsb-badge">{update.current}</span> : null}
                </h3>
                <p className="dsb-hint">{t('updateHint')}</p>
                <div className="dsb-row">
                  <button type="button" className="dsb-btn-secondary" disabled={busy !== ''} onClick={() => void checkForUpdate()}>
                    {busy === 'update-check' ? t('busy') : t('updateCheck')}
                  </button>
                  {update && update.ok && update.update ? (
                    <button type="button" className="dsb-btn-primary" disabled={busy !== ''} onClick={() => void updateNow()}>
                      {busy === 'update' ? t('busy') : t('updateNow').replace('{latest}', update.latest || '')}
                    </button>
                  ) : null}
                </div>
              </div>

              <div className="dsb-card">
                <h3 className="dsb-heading">
                  <span>{t('profilesTitle')}</span>
                  {profiles ? <span className="dsb-badge">{profiles.profiles?.length ?? 0}</span> : null}
                </h3>
                <div className="dsb-row">
                  <button type="button" className="dsb-btn-secondary" disabled={busy !== ''} onClick={loadProfiles}>
                    {busy === 'profiles' ? t('busy') : t('profilesView')}
                  </button>
                  <label>
                    <input type="text" placeholder={t('profilesCreatePlaceholder')} value={profileName} onChange={(e) => setProfileName(e.target.value)} />
                  </label>
                  <button type="button" className="dsb-btn-secondary" disabled={busy !== '' || !profileName.trim()} onClick={doProfileCreate}>
                    {t('profilesCreate')}
                  </button>
                </div>
                {profiles && profiles.profiles ? (
                  <ul className="dsb-list">
                    {profiles.profiles.map((p) => (
                      <li className="dsb-item" key={p.name}>
                        <span className="dsb-item-name">{p.name}</span>
                        <span className="dsb-item-meta">{p.running ? `${t('profilesRunning')} · ` : ''}{p.readonly ? t('profilesAppOwned') : ''}</span>
                        <span className="dsb-item-actions">
                          {!p.readonly ? (
                            <>
                              {p.running ? (
                                <button type="button" className="dsb-btn-secondary" disabled={busy !== ''} onClick={() => doProfileStop(p.name)}>{t('profilesStop')}</button>
                              ) : (
                                <button type="button" className="dsb-btn-secondary" disabled={busy !== ''} onClick={() => doProfileLaunch(p.name)}>{t('profilesLaunch')}</button>
                              )}
                              {profileConfirmDelete === p.name ? (
                                <button type="button" className="dsb-btn-danger" disabled={busy !== ''} onClick={() => doProfileDelete(p.name)}>{t('confirmDelete')}</button>
                              ) : (
                                <button type="button" className="dsb-btn-danger" disabled={busy !== ''} onClick={() => setProfileConfirmDelete(p.name)}>{t('profilesDelete')}</button>
                              )}
                            </>
                          ) : null}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>

              <div className="dsb-card">
                <h3 className="dsb-heading">
                  <span>{t('aboutTitle')}</span>
                  {about && about.version ? <span className="dsb-badge">v{about.version}</span> : null}
                </h3>
                {about ? (
                  <dl className="dsb-kv">
                    <dt>{t('aboutDsh')}</dt><dd>{about.dshVersion ?? t('none')}</dd>
                    <dt>{t('aboutPlatform')}</dt><dd>{about.platform} · Node {about.node}</dd>
                    <dt>{t('aboutProfile')}</dt><dd>{about.profile}</dd>
                    <dt>{t('aboutPluginDir')}</dt><dd className="dsb-mono">{about.pluginDir}</dd>
                  </dl>
                ) : null}
                <div className="dsb-row">
                  <button
                    type="button"
                    className="dsb-btn-secondary"
                    onClick={() => {
                      const lines = about
                        ? `dsh-backup ${about.version} · dsh ${about.dshVersion} · ${about.platform} · node ${about.node} · profile ${about.profile}`
                        : '';
                      try { if (navigator.clipboard && navigator.clipboard.writeText) void navigator.clipboard.writeText(lines); } catch { /* ignore */ }
                    }}
                  >
                    {t('aboutCopy')}
                  </button>
                </div>
              </div>

              <details className="dsb-adv">
                <summary>{t('helpTitle')}<span className="chev">▶</span></summary>
                <div className="body">
                  <p className="dsb-hint"><b>{t('helpQ1')}</b><br />{t('helpA1')}</p>
                  <p className="dsb-hint"><b>{t('helpQ2')}</b><br />{t('helpA2')}</p>
                  <p className="dsb-hint"><b>{t('helpQ3')}</b><br />{t('helpA3')}</p>
                  <p className="dsb-hint"><b>{t('helpQ4')}</b><br />{t('helpA4')}</p>
                  <p className="dsb-hint"><b>{t('helpQ5')}</b><br />{t('helpA5')}</p>
                </div>
              </details>

              <p className="dsb-feedback">
                {t('feedbackHint')}{' '}
                <a href="https://github.com/xiaoyuyu6420/dsh-backup/discussions/32" target="_blank" rel="noreferrer">{t('feedbackLink')}</a>
                {' · '}
                <a href="https://github.com/xiaoyuyu6420/dsh-backup" target="_blank" rel="noreferrer">{t('starLink')}</a>
              </p>
            </>
          ) : null}

          {pending !== null ? (
            <div className="dsb-modal-backdrop" role="presentation" onClick={() => { if (busy === '') setPending(null); }}>
              <div className="dsb-modal" role="alertdialog" aria-modal="true" aria-label={t('restoreConfirmTitle')} onClick={(e) => e.stopPropagation()}>
                <strong className="dsb-modal-title">{t('restoreConfirmTitle')}</strong>
                <p className="dsb-modal-sub">{pending.name}{pending.merge && pending.types.length ? ` · ${pending.types.join(', ')}` : ''} · {t('restoreEntries').replace('{n}', String(pending.files))}</p>
                <div className="dsb-warn">
                  <p>{t('restoreWarnTitle')}</p>
                  <ul>
                    {(pending.merge
                      ? [t('mergeWhatWrite').replace('{n}', String(pending.willOverwrite.length)), t('mergeWhatKeep')]
                      : (pending.targetExists === false
                        ? [t('restoreWhatFresh')]
                        : [t('restoreWhatMove'), t('restoreWhatSnapshot'), t('restoreWhatWrite')]
                      )
                    ).map((s) => <li key={s}>{s}</li>)}
                  </ul>
                </div>
                {pending.preflight.length > 0 ? (
                  <ul className="dsb-preflight">
                    {pending.preflight.map((s) => <li key={s}>{s}</li>)}
                  </ul>
                ) : null}
                <label className="dsb-syncdeps">
                  <input type="checkbox" checked={syncDeps} disabled={busy !== ''} onChange={(e) => setSyncDeps(e.target.checked)} />
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
        </>
      ) : null}
    </div>
  );
}
