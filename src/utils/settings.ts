declare const CRIBL_API_URL: string;

// ── KV key paths ──────────────────────────────────────────────────────────────
const KV_PROVIDER_PATH = 'aiProvider';

function kvUrl(path: string) {
  return `${CRIBL_API_URL}/kvstore/${path}`;
}

async function kvGet(path: string): Promise<string> {
  try {
    const r = await fetch(kvUrl(path));
    if (!r.ok) return '';
    return (await r.text()).trim();
  } catch {
    return '';
  }
}

async function kvPut(path: string, value: string): Promise<boolean> {
  try {
    const r = await fetch(kvUrl(path), {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain' },
      body: value,
    });
    return r.ok;
  } catch {
    return false;
  }
}

async function kvPutEncrypted(path: string, value: string): Promise<boolean> {
  try {
    const r = await fetch(kvUrl(path) + '?encrypted=true', {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain' },
      body: value,
    });
    return r.ok;
  } catch {
    return false;
  }
}

async function kvDelete(path: string): Promise<void> {
  try {
    await fetch(kvUrl(path), { method: 'DELETE' });
  } catch {
    // best-effort
  }
}

// ── AI Provider registry ──────────────────────────────────────────────────────
export type AIProvider = 'anthropic' | 'bedrock' | 'gemini';

/** One credential input for a provider, rendered generically by the Settings page. */
export interface ProviderField {
  /** KV key path the value is stored at. */
  key: string;
  label: string;
  /**
   * Encrypted on write (`?encrypted=true`) and never pre-filled in the UI.
   * The streaming layer still reads secrets back when it must sign requests
   * in-browser (Bedrock SigV4); every other provider has its secret injected
   * server-side by the platform proxy.
   */
  secret?: boolean;
  /** Renders a `<select>` instead of a text input. */
  options?: string[];
  placeholder?: string;
  defaultValue?: string;
  /** Not required before the provider counts as configured. */
  optional?: boolean;
  hint?: string;
}

export interface ModelOption {
  id: string;
  label: string;
}

export interface ProviderDef {
  id: AIProvider;
  label: string;
  /** Curated starting points. Users can always type an ID, and `canListModels` providers can refresh from the API. */
  models: ModelOption[];
  defaultModel: string;
  /** Label shown above the model input. */
  modelLabel: string;
  fields: ProviderField[];
  /** KV key holding `'true'` once the required secrets have been supplied. */
  sentinelKey: string;
  /** KV key holding the selected model. */
  modelKey: string;
  credsTitle: string;
  /** Provider supports listing models over the API (see `fetchModels`). */
  canListModels?: boolean;
  keyDocsUrl?: string;
  keyDocsLabel?: string;
  note?: string;
}

export const PROVIDERS: ProviderDef[] = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    models: [
      { id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5 (Recommended)' },
      { id: 'claude-opus-4-5', label: 'Claude Opus 4.5 (Most capable)' },
      { id: 'claude-haiku-3-5', label: 'Claude Haiku 3.5 (Fastest)' },
    ],
    defaultModel: 'claude-sonnet-4-5',
    modelLabel: 'Claude Model',
    // Legacy key names — preserved so existing installs keep their saved key.
    sentinelKey: 'anthropicApiKeySet',
    modelKey: 'anthropicModel',
    credsTitle: 'Anthropic API Key',
    canListModels: true,
    keyDocsUrl: 'https://console.anthropic.com/settings/keys',
    keyDocsLabel: 'Get a key ↗',
    fields: [
      { key: 'anthropicApiKey', label: 'API Key', secret: true, placeholder: 'sk-ant-api03-…' },
    ],
  },
  {
    id: 'bedrock',
    label: 'AWS Bedrock',
    models: [
      { id: 'us.anthropic.claude-opus-4-6-v1', label: 'Claude Opus 4.6 (Bedrock)' },
      { id: 'us.anthropic.claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (Bedrock)' },
      { id: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0', label: 'Claude Sonnet 4.5 (Bedrock)' },
      { id: 'us.anthropic.claude-haiku-4-5-20251001-v1:0', label: 'Claude Haiku 4.5 (Bedrock)' },
    ],
    defaultModel: 'us.anthropic.claude-sonnet-4-6',
    modelLabel: 'Bedrock Model',
    sentinelKey: 'bedrockCredsSet',
    modelKey: 'bedrockModel',
    credsTitle: 'AWS Credentials',
    note: 'IAM user requires the bedrock:InvokeModelWithResponseStream permission.',
    fields: [
      {
        key: 'bedrockRegion',
        label: 'AWS Region',
        defaultValue: 'us-east-1',
        options: [
          'us-east-1',
          'us-west-2',
          'eu-west-1',
          'eu-central-1',
          'ap-northeast-1',
          'ap-southeast-1',
          'ap-southeast-2',
        ],
      },
      { key: 'bedrockAccessKeyId', label: 'Access Key ID', secret: true, placeholder: 'AKIA…' },
      { key: 'bedrockSecretAccessKey', label: 'Secret Access Key', secret: true, placeholder: '••••••••' },
    ],
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    models: [
      { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro (Recommended)' },
      { id: 'gemini-3-pro-preview', label: 'Gemini 3 Pro (Preview)' },
      { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash (Faster)' },
      { id: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash' },
    ],
    defaultModel: 'gemini-2.5-pro',
    modelLabel: 'Gemini Model',
    sentinelKey: 'geminiApiKeySet',
    modelKey: 'geminiModel',
    credsTitle: 'Google AI Studio API Key',
    canListModels: true,
    keyDocsUrl: 'https://aistudio.google.com/apikey',
    keyDocsLabel: 'Get a key ↗',
    fields: [
      { key: 'geminiApiKey', label: 'API Key', secret: true, placeholder: 'AIza…' },
    ],
  },
];

export function providerDef(id: AIProvider): ProviderDef {
  return PROVIDERS.find(p => p.id === id) ?? PROVIDERS[0];
}

export const DEFAULT_PROVIDER: AIProvider = 'anthropic';

/** Credential values keyed by KV path, as read from or written to the KV store. */
export type ProviderCreds = Record<string, string>;

export async function getStoredProvider(): Promise<AIProvider> {
  const text = await kvGet(KV_PROVIDER_PATH);
  return PROVIDERS.some(p => p.id === text) ? (text as AIProvider) : DEFAULT_PROVIDER;
}

export async function saveProvider(provider: AIProvider): Promise<void> {
  await kvPut(KV_PROVIDER_PATH, provider);
}

/**
 * Read every credential field for a provider, applying declared defaults.
 *
 * Secrets are included: Bedrock has to sign requests in the browser and needs
 * the real values. Callers that render the values (Settings) skip `secret`
 * fields so keys are never echoed back into the DOM.
 */
export async function getProviderCreds(id: AIProvider): Promise<ProviderCreds> {
  const def = providerDef(id);
  const entries = await Promise.all(
    def.fields.map(async f => [f.key, (await kvGet(f.key)) || f.defaultValue || ''] as const),
  );
  return Object.fromEntries(entries);
}

/**
 * Persist credential values. Blank secrets are left untouched so the user can
 * edit a non-secret field (region, API version) without re-entering their key.
 * The sentinel is only raised once every required secret has been supplied.
 */
export async function saveProviderCreds(id: AIProvider, values: ProviderCreds): Promise<void> {
  const def = providerDef(id);
  await Promise.all(
    def.fields.flatMap(f => {
      const value = (values[f.key] ?? '').trim();
      if (f.secret) return value ? [kvPutEncrypted(f.key, value)] : [];
      return [kvPut(f.key, value)];
    }),
  );

  const secretsSupplied = def.fields
    .filter(f => f.secret && !f.optional)
    .every(f => (values[f.key] ?? '').trim() !== '');
  if (secretsSupplied) await kvPut(def.sentinelKey, 'true');
}

export async function clearProviderCreds(id: AIProvider): Promise<void> {
  const def = providerDef(id);
  await Promise.all([
    ...def.fields.filter(f => f.secret).map(f => kvDelete(f.key)),
    kvDelete(def.sentinelKey),
  ]);
}

/**
 * A provider is usable once its secrets have been stored and every required
 * non-secret field has a value (Bedrock, for example, needs a region).
 */
export async function isProviderConfigured(id: AIProvider): Promise<boolean> {
  const def = providerDef(id);
  const [sentinel, creds] = await Promise.all([kvGet(def.sentinelKey), getProviderCreds(id)]);
  if (sentinel !== 'true') return false;
  return def.fields
    .filter(f => !f.secret && !f.optional)
    .every(f => (creds[f.key] ?? '').trim() !== '');
}

export async function getStoredModel(id: AIProvider): Promise<string> {
  const def = providerDef(id);
  const text = await kvGet(def.modelKey);
  // Normalize: early versions stored this value JSON-encoded ("claude-sonnet-4-5").
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === 'string' && parsed ? parsed : def.defaultModel;
  } catch {
    return text || def.defaultModel;
  }
}

export async function saveModel(id: AIProvider, model: string): Promise<void> {
  await kvPut(providerDef(id).modelKey, model.trim());
}
