import { streamBedrock } from './bedrock';
import { providerDef, type AIProvider, type ProviderCreds } from './settings';

export type ChatChunk =
  | { type: 'text'; text: string }
  | { type: 'done' }
  | { type: 'error'; error: string };

export interface AiMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface StreamArgs {
  provider: AIProvider;
  model: string;
  messages: AiMessage[];
  system: string;
  creds: ProviderCreds;
  signal?: AbortSignal;
}

/**
 * Yield complete SSE lines from a response body.
 *
 * Buffers across reads: a `data:` line can be split over two network chunks,
 * and splitting each chunk independently would corrupt those events.
 */
async function* sseLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        yield buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
      }
    }
    if (buf.trim()) yield buf.trim();
  } finally {
    reader.releaseLock();
  }
}

/** Pull the most useful message out of an error body — every provider here nests it under `error`. */
async function errorMessage(resp: Response, label: string): Promise<string> {
  const raw = await resp.text().catch(() => '');
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: string } | string; message?: string };
    const err = parsed.error;
    const msg = typeof err === 'string' ? err : err?.message ?? parsed.message;
    if (msg) return `${label} error ${resp.status}: ${msg}`;
  } catch {
    // fall through to the raw body
  }
  const detail = raw.trim().slice(0, 300) || resp.statusText;
  return `${label} error ${resp.status}: ${detail}`;
}

// ── Anthropic ─────────────────────────────────────────────────────────────────

async function* streamAnthropic(args: StreamArgs): AsyncGenerator<ChatChunk> {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: args.model,
      max_tokens: 8192,
      stream: true,
      system: args.system,
      messages: args.messages,
    }),
    signal: args.signal,
  });

  if (!resp.ok || !resp.body) {
    yield { type: 'error', error: await errorMessage(resp, 'Anthropic') };
    return;
  }

  for await (const line of sseLines(resp.body)) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    try {
      const evt = JSON.parse(data) as {
        type: string;
        delta?: { type?: string; text?: string };
        error?: { message?: string };
      };
      if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
        yield { type: 'text', text: evt.delta.text ?? '' };
      } else if (evt.type === 'error') {
        yield { type: 'error', error: `Anthropic stream error: ${evt.error?.message ?? 'unknown'}` };
        return;
      }
    } catch {
      // skip malformed events
    }
  }

  yield { type: 'done' };
}

// ── Google Gemini ─────────────────────────────────────────────────────────────

/** Finish reasons that mean the model completed normally. */
const GEMINI_OK_FINISH = new Set(['STOP', 'MAX_TOKENS', 'FINISH_REASON_UNSPECIFIED']);

/** Gemini names the assistant role `model` and carries the system prompt separately. */
async function* streamGemini(args: StreamArgs): AsyncGenerator<ChatChunk> {
  const endpoint =
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(args.model)}` +
    ':streamGenerateContent?alt=sse';

  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: args.system }] },
      contents: args.messages.map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      })),
    }),
    signal: args.signal,
  });

  if (!resp.ok || !resp.body) {
    yield { type: 'error', error: await errorMessage(resp, 'Gemini') };
    return;
  }

  let gotText = false;
  let finishReason: string | undefined;
  let blockReason: string | undefined;

  for await (const line of sseLines(resp.body)) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    try {
      const evt = JSON.parse(data) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
        promptFeedback?: { blockReason?: string };
        error?: { message?: string };
      };
      if (evt.error?.message) {
        yield { type: 'error', error: `Gemini stream error: ${evt.error.message}` };
        return;
      }
      if (evt.promptFeedback?.blockReason) blockReason = evt.promptFeedback.blockReason;
      const candidate = evt.candidates?.[0];
      if (candidate?.finishReason) finishReason = candidate.finishReason;
      for (const part of candidate?.content?.parts ?? []) {
        if (part.text) {
          gotText = true;
          yield { type: 'text', text: part.text };
        }
      }
    } catch {
      // skip malformed events
    }
  }

  // A blocked prompt or response (SAFETY, RECITATION, PROHIBITED_CONTENT, …)
  // ends the stream with no usable text — surface why instead of a blank reply.
  if (blockReason) {
    yield { type: 'error', error: `Gemini blocked the prompt (${blockReason}).` };
    return;
  }
  if (finishReason && !GEMINI_OK_FINISH.has(finishReason)) {
    yield { type: 'error', error: `Gemini blocked the response (${finishReason}).` };
    return;
  }
  if (!gotText) {
    yield { type: 'error', error: 'Gemini returned an empty response.' };
    return;
  }

  yield { type: 'done' };
}

// ── Dispatcher ────────────────────────────────────────────────────────────────

/**
 * Stream a completion from the configured provider.
 *
 * API keys are injected server-side by the platform proxy from the KV store
 * (see `config/proxies.yml`) and never travel through the browser — the one
 * exception is Bedrock, which must be SigV4-signed locally.
 */
export async function* streamChat(args: StreamArgs): AsyncGenerator<ChatChunk> {
  switch (args.provider) {
    case 'anthropic':
      yield* streamAnthropic(args);
      return;

    case 'bedrock':
      yield* streamBedrock(
        args.messages,
        args.model,
        args.creds.bedrockRegion || 'us-east-1',
        args.creds.bedrockAccessKeyId ?? '',
        args.creds.bedrockSecretAccessKey ?? '',
        args.system,
        args.signal,
      );
      return;

    case 'gemini':
      yield* streamGemini(args);
      return;
  }
}

// ── Model discovery ───────────────────────────────────────────────────────────

/**
 * List the models the configured credentials can actually reach.
 *
 * Model IDs churn faster than a packaged app can, so the curated lists in
 * `settings.ts` are only starting points. Bedrock is excluded: listing its
 * models is a separate SigV4-signed control-plane service.
 */
export async function fetchModels(provider: AIProvider): Promise<string[]> {
  const def = providerDef(provider);
  if (!def.canListModels) {
    throw new Error(`${def.label} does not support listing models — enter the ID manually.`);
  }

  const url =
    provider === 'anthropic'
      ? 'https://api.anthropic.com/v1/models?limit=100'
      : 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=200';

  const resp = await fetch(url);
  if (!resp.ok) throw new Error(await errorMessage(resp, def.label));

  const json = (await resp.json()) as {
    data?: Array<{ id?: string }>;
    models?: Array<{ name?: string; supportedGenerationMethods?: string[] }>;
  };

  if (provider === 'gemini') {
    return (json.models ?? [])
      .filter(m => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes('generateContent'))
      .map(m => (m.name ?? '').replace(/^models\//, ''))
      .filter(Boolean)
      .sort();
  }

  return (json.data ?? [])
    .map(m => m.id ?? '')
    .filter(Boolean)
    .sort();
}
