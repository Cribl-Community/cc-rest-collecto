import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  PROVIDERS, providerDef, getStoredProvider, saveProvider,
  getProviderCreds, saveProviderCreds, clearProviderCreds, isProviderConfigured,
  getStoredModel, saveModel,
  type AIProvider, type ModelOption, type ProviderCreds, type ProviderField,
} from '../utils/settings';
import { fetchModels } from '../utils/aiStream';

/** Sentinel value for the "type your own model ID" option in the model dropdown. */
const CUSTOM_MODEL = '__custom__';

export function SettingsPage() {
  const navigate = useNavigate();

  const [provider, setProvider] = useState<AIProvider>('anthropic');
  const [values, setValues] = useState<ProviderCreds>({});
  const [configured, setConfigured] = useState<boolean | null>(null);
  /** Whether any credential field has been edited since it was loaded or saved. */
  const [dirty, setDirty] = useState(false);

  const [model, setModel] = useState('');
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([]);
  const [customModel, setCustomModel] = useState(false);
  const [loadingModels, setLoadingModels] = useState(false);

  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [saveMessage, setSaveMessage] = useState('');

  const def = providerDef(provider);

  /** Load everything for one provider: creds (non-secret only), model, configured state. */
  const loadProvider = useCallback(async (p: AIProvider) => {
    const d = providerDef(p);
    const [creds, storedModel, ok] = await Promise.all([
      getProviderCreds(p),
      getStoredModel(p),
      isProviderConfigured(p),
    ]);

    // Never pre-fill secrets back into the DOM — the sentinel badge shows they exist.
    const visible: ProviderCreds = {};
    for (const f of d.fields) {
      visible[f.key] = f.secret ? '' : creds[f.key] ?? '';
    }

    setValues(visible);
    setDirty(false);
    setConfigured(ok);
    setModel(storedModel);
    setModelOptions(d.models);
    setCustomModel(!d.models.some(m => m.id === storedModel));
  }, []);

  useEffect(() => {
    async function init() {
      const p = await getStoredProvider();
      setProvider(p);
      await loadProvider(p);
    }
    init();
  }, [loadProvider]);

  async function handleProviderChange(p: AIProvider) {
    if (p === provider) return;
    setProvider(p);
    setSaveStatus('idle');
    setConfigured(null);
    await Promise.all([saveProvider(p), loadProvider(p)]);
  }

  function setField(key: string, value: string) {
    setValues(prev => ({ ...prev, [key]: value }));
    setDirty(true);
    setSaveStatus('idle');
  }

  /** Required fields the user still has to fill before credentials can be saved. */
  function missingFields(): ProviderField[] {
    return def.fields.filter(f => {
      if (f.optional) return false;
      // An already-stored secret does not need to be re-entered.
      if (f.secret && configured) return false;
      return (values[f.key] ?? '').trim() === '';
    });
  }

  async function handleSaveCreds() {
    if (!dirty || missingFields().length > 0) return;
    setSaving(true);
    setSaveStatus('idle');
    try {
      await saveProviderCreds(provider, values);
      const ok = await isProviderConfigured(provider);
      setConfigured(ok);
      setDirty(false);
      // Clear the secret inputs — they are stored now.
      setValues(prev => {
        const next = { ...prev };
        for (const f of def.fields) if (f.secret) next[f.key] = '';
        return next;
      });
      setSaveStatus(ok ? 'success' : 'error');
      setSaveMessage(ok ? `${def.label} credentials saved.` : 'Saved, but some required fields are still missing.');
    } catch (e) {
      setSaveStatus('error');
      setSaveMessage((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function handleClearCreds() {
    setSaving(true);
    try {
      await clearProviderCreds(provider);
      setConfigured(false);
      setValues(prev => {
        const next = { ...prev };
        for (const f of def.fields) if (f.secret) next[f.key] = '';
        return next;
      });
      setSaveStatus('success');
      setSaveMessage(`${def.label} credentials removed.`);
    } catch {
      setSaveStatus('error');
      setSaveMessage('Failed to remove credentials.');
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveModel() {
    setSaving(true);
    try {
      await saveModel(provider, model);
      setSaveStatus('success');
      setSaveMessage('Model preference saved.');
    } catch {
      setSaveStatus('error');
      setSaveMessage('Failed to save model.');
    } finally {
      setSaving(false);
    }
  }

  /** Replace the curated list with what these credentials can actually reach. */
  async function handleRefreshModels() {
    setLoadingModels(true);
    setSaveStatus('idle');
    try {
      const ids = await fetchModels(provider);
      if (ids.length === 0) throw new Error('No models returned.');
      setModelOptions(ids.map(id => ({ id, label: id })));
      setCustomModel(!ids.includes(model));
      setSaveStatus('success');
      setSaveMessage(`Loaded ${ids.length} models from ${def.label}.`);
    } catch (e) {
      setSaveStatus('error');
      setSaveMessage((e as Error).message);
    } finally {
      setLoadingModels(false);
    }
  }

  function renderField(f: ProviderField) {
    const value = values[f.key] ?? '';
    const label = f.secret && configured ? `Replace ${f.label}` : f.label;

    return (
      <div className="form-field" key={f.key}>
        <label className="form-label">{label}</label>
        {f.options ? (
          <select
            className="form-control"
            value={value}
            onChange={e => setField(f.key, e.target.value)}
          >
            {f.options.map(o => (
              <option key={o} value={o}>{o}</option>
            ))}
          </select>
        ) : (
          <input
            type={f.secret ? 'password' : 'text'}
            className="form-control"
            placeholder={f.placeholder}
            value={value}
            onChange={e => setField(f.key, e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        )}
        {f.hint && <p className="form-hint">{f.hint}</p>}
      </div>
    );
  }

  const missing = missingFields();

  return (
    <div className="page settings-page">
      <div className="page-header">
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => navigate(-1)}>
          ← Back
        </button>
        <h2 className="page-title" style={{ marginTop: '0.75rem' }}>Settings</h2>
        <p className="page-subtitle">Configure your AI provider credentials for the AI Collector Builder.</p>
      </div>

      {/* Provider picker */}
      <div className="form-section">
        <h3 className="form-section-title">AI Provider</h3>
        <div className="provider-toggle">
          {PROVIDERS.map(p => (
            <button
              key={p.id}
              type="button"
              className={`provider-toggle-btn${provider === p.id ? ' provider-toggle-btn--active' : ''}`}
              onClick={() => handleProviderChange(p.id)}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {/* Credentials */}
      <div className="form-section">
        <h3 className="form-section-title">{def.credsTitle}</h3>
        <div className="key-status-row">
          <span className={`key-status-badge ${configured ? 'key-status-badge--set' : 'key-status-badge--unset'}`}>
            {configured === null ? 'Checking…' : configured ? 'Credentials configured ✓' : 'Not configured'}
          </span>
          {configured && (
            <button type="button" className="btn btn--ghost btn--sm" onClick={handleClearCreds} disabled={saving}>
              Remove credentials
            </button>
          )}
        </div>

        {def.fields.map(renderField)}

        <div className="url-fetch-row">
          <button
            type="button"
            className="btn btn--primary"
            onClick={handleSaveCreds}
            disabled={saving || !dirty || missing.length > 0}
            title={missing.length > 0 ? `Required: ${missing.map(f => f.label).join(', ')}` : undefined}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>

        <p className="form-hint">
          Stored in the Cribl KV store, encrypted. Keys are injected by the platform proxy — they never appear in
          browser requests.{' '}
          {def.keyDocsUrl && (
            <a href={def.keyDocsUrl} target="_blank" rel="noopener noreferrer" className="inline-link">
              {def.keyDocsLabel ?? 'Docs ↗'}
            </a>
          )}
        </p>
        {def.note && <p className="form-hint">{def.note}</p>}
      </div>

      {/* Model */}
      <div className="form-section">
        <h3 className="form-section-title">Model</h3>
        <div className="form-field">
          <label className="form-label">{def.modelLabel}</label>

          <select
            className="form-control"
            value={customModel ? CUSTOM_MODEL : model}
            onChange={e => {
              const v = e.target.value;
              if (v === CUSTOM_MODEL) {
                setCustomModel(true);
              } else {
                setCustomModel(false);
                setModel(v);
              }
              setSaveStatus('idle');
            }}
          >
            {modelOptions.map(m => (
              <option key={m.id} value={m.id}>{m.label}</option>
            ))}
            <option value={CUSTOM_MODEL}>Custom…</option>
          </select>

          {customModel && (
            <input
              type="text"
              className="form-control"
              placeholder="model-id"
              value={model}
              onChange={e => { setModel(e.target.value); setSaveStatus('idle'); }}
              autoComplete="off"
              spellCheck={false}
              style={{ marginTop: '0.5rem' }}
            />
          )}

          <div className="url-fetch-row" style={{ marginTop: '0.5rem' }}>
            <button
              type="button"
              className="btn btn--secondary"
              onClick={handleSaveModel}
              disabled={saving || !model.trim()}
            >
              Save
            </button>
            {def.canListModels && (
              <button
                type="button"
                className="btn btn--ghost"
                onClick={handleRefreshModels}
                disabled={loadingModels || !configured}
                title={configured ? 'List the models your credentials can reach' : 'Save credentials first'}
              >
                {loadingModels ? 'Loading…' : 'Refresh from provider'}
              </button>
            )}
          </div>

          <p className="form-hint">
            Model IDs change often. Use Refresh to list what your credentials can reach, or pick Custom… to enter an ID.
          </p>
        </div>
      </div>

      {saveStatus === 'success' && (
        <p className="push-result push-result--success">{saveMessage}</p>
      )}
      {saveStatus === 'error' && (
        <p className="push-result push-result--error">{saveMessage}</p>
      )}
    </div>
  );
}
