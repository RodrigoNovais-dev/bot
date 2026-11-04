/**
 * Integração com a API oficial da OpenAI (SDK "openai").
 * - Criação preguiçosa do cliente a partir de OPENAI_API_KEY (nunca registrada em log).
 * - Conversão dos erros da API em SkinError com mensagens em português.
 * - Tentativa automática de modelos alternativos quando o modelo configurado não existe na conta.
 */
const crypto = require('crypto');
const config = require('../config');
const { SkinError } = require('./errors');

let cachedClient = null;
let cachedKeyHash = null;

/** Retorna um cliente OpenAI configurado ou lança API_NOT_CONFIGURED. */
function getOpenAIClient() {
    const key = config.skin.openaiApiKey;
    if (!key || key === 'sua_chave_aqui') {
        throw new SkinError('API_NOT_CONFIGURED', 'OPENAI_API_KEY ausente');
    }
    const keyHash = crypto.createHash('sha256').update(key).digest('hex');
    if (!cachedClient || cachedKeyHash !== keyHash) {
        const { OpenAI } = require('openai');
        cachedClient = new OpenAI({
            apiKey: key,
            timeout: config.skin.requestTimeoutMs,
            maxRetries: 1
        });
        cachedKeyHash = keyHash;
    }
    return cachedClient;
}

/** Identificador anônimo do usuário final (hash) para o monitoramento de segurança da OpenAI. */
function safetyIdentifier(userId) {
    if (!userId) return undefined;
    return crypto.createHash('sha256').update(`skinbot:${userId}`).digest('hex').slice(0, 32);
}

function errorText(err) {
    return [err?.code, err?.type, err?.error?.code, err?.error?.message, err?.message]
        .filter(Boolean).join(' | ').toLowerCase();
}

/** Converte erros do SDK/API em SkinError. */
function mapOpenAIError(err) {
    if (err instanceof SkinError) return err;
    const status = err?.status;
    const text = errorText(err);
    const name = err?.constructor?.name || err?.name || '';

    if (name === 'APIUserAbortError' || err?.name === 'AbortError' || text.includes('aborted')) {
        return new SkinError('TIMEOUT', `Requisição abortada: ${err?.message}`, { cause: err });
    }
    if (name === 'APIConnectionTimeoutError' || text.includes('timed out') || text.includes('timeout')) {
        return new SkinError('TIMEOUT', err?.message, { cause: err });
    }
    if (name === 'APIConnectionError' || (!status && /econn|enotfound|network|fetch failed|socket/.test(text))) {
        return new SkinError('NETWORK', err?.message, { cause: err });
    }
    if (status === 401) return new SkinError('INVALID_KEY', err?.message, { cause: err });
    if (status === 403) {
        if (text.includes('verif')) {
            return new SkinError('PERMISSION_DENIED', err?.message, {
                cause: err,
                userMessage: '🔒 A organização da OpenAI precisa ser verificada para usar o modelo de imagens configurado. Avise o administrador do bot.'
            });
        }
        return new SkinError('PERMISSION_DENIED', err?.message, { cause: err });
    }
    if (status === 404 || text.includes('model_not_found') || text.includes('does not exist')) {
        return new SkinError('MODEL_UNAVAILABLE', err?.message, { cause: err });
    }
    if (status === 429) {
        if (text.includes('insufficient_quota') || text.includes('billing') || text.includes('quota')) {
            return new SkinError('QUOTA_EXCEEDED', err?.message, { cause: err });
        }
        return new SkinError('RATE_LIMITED', err?.message, { cause: err });
    }
    if (text.includes('moderation') || text.includes('safety') || text.includes('content_policy') || text.includes('content policy')) {
        return new SkinError('CONTENT_BLOCKED', err?.message, { cause: err, chargeable: true });
    }
    if (status === 400 && /invalid[_ ]image|image_parse_error|unsupported image|could not process image|invalid image file/.test(text)) {
        return new SkinError('INVALID_IMAGE', err?.message, { cause: err, chargeable: true });
    }
    return new SkinError('GENERATION_FAILED', err?.message || String(err), { cause: err });
}

/** O erro indica que vale a pena tentar outro modelo? */
function isModelError(skinErr) {
    return skinErr.code === 'MODEL_UNAVAILABLE' || skinErr.code === 'PERMISSION_DENIED';
}

/**
 * Executa `fn(model)` com o modelo principal e, se ele não estiver disponível,
 * com os modelos alternativos configurados.
 */
async function withModelFallback(models, fn) {
    const list = [...new Set(models.filter(Boolean))];
    let lastErr = null;
    for (const model of list) {
        try {
            return await fn(model);
        } catch (err) {
            const mapped = mapOpenAIError(err);
            lastErr = mapped;
            if (!isModelError(mapped)) throw mapped;
            console.warn(`[criarskin] Modelo "${model}" indisponível (${mapped.message}). Tentando o próximo...`);
        }
    }
    throw lastErr || new SkinError('MODEL_UNAVAILABLE', 'Nenhum modelo configurado');
}

module.exports = { getOpenAIClient, mapOpenAIError, withModelFallback, safetyIdentifier };
