/**
 * Cache das imagens recentes enviadas por cada usuário, para permitir:
 *   1) enviar a imagem e, em seguida, mandar "!criarskin";
 * sem NUNCA usar a imagem de outra pessoa. A chave é (chat + remetente).
 * Guarda apenas a referência da mensagem (não baixa a mídia até ser necessário).
 */
const config = require('../config');

const MAX_ENTRIES = 1000;

/** Normaliza um JID removendo o sufixo de dispositivo (ex.: 5511999:12@s.whatsapp.net). */
function normalizeJid(jid) {
    return String(jid || '').replace(/:\d+(?=@)/, '');
}

/** Identifica o autor real da mensagem (em grupos é o participante, não o grupo). */
function getSenderId(msg, sock) {
    if (msg?.key?.fromMe) return normalizeJid(sock?.user?.id || 'me');
    return normalizeJid(msg?.key?.participant || msg?.participant || msg?.key?.remoteJid);
}

/** Extrai { media, type, mimetype, size } de um conteúdo de mensagem que contenha imagem. */
function extractImage(content) {
    if (!content) return null;
    const inner = content.ephemeralMessage?.message || content.viewOnceMessageV2?.message || content.viewOnceMessage?.message;
    if (inner) return extractImage(inner);
    if (content.imageMessage) {
        const m = content.imageMessage;
        return { media: m, type: 'image', mimetype: m.mimetype || 'image/jpeg', size: Number(m.fileLength || 0) };
    }
    const doc = content.documentMessage || content.documentWithCaptionMessage?.message?.documentMessage;
    if (doc && /^image\/(png|jpe?g|webp)$/i.test(doc.mimetype || '')) {
        return { media: doc, type: 'document', mimetype: doc.mimetype, size: Number(doc.fileLength || 0) };
    }
    return null;
}

class RecentImageCache {
    constructor(ttlMs) {
        this.ttlOverride = ttlMs;
        this.entries = new Map();
    }

    get ttlMs() { return this.ttlOverride ?? config.skin.recentImageTtlMs; }

    key(chatId, senderId) { return `${normalizeJid(chatId)}|${normalizeJid(senderId)}`; }

    /** Registra a imagem da mensagem (se houver). Retorna true se registrou. */
    remember(msg, chatId, senderId) {
        const image = extractImage(msg?.message);
        if (!image) return false;
        this.prune();
        const k = this.key(chatId, senderId);
        this.entries.delete(k); // reinsere para manter ordem de recência
        this.entries.set(k, { ...image, messageId: msg.key?.id, at: Date.now() });
        while (this.entries.size > MAX_ENTRIES) this.entries.delete(this.entries.keys().next().value);
        return true;
    }

    /** Retorna a imagem recente DESTE usuário neste chat, ou null. */
    get(chatId, senderId) {
        const k = this.key(chatId, senderId);
        const e = this.entries.get(k);
        if (!e) return null;
        if (Date.now() - e.at > this.ttlMs) { this.entries.delete(k); return null; }
        return e;
    }

    /** Remove a imagem após o uso (evita reutilização acidental em pedidos futuros). */
    consume(chatId, senderId) { this.entries.delete(this.key(chatId, senderId)); }

    prune() {
        const now = Date.now();
        for (const [k, e] of this.entries) if (now - e.at > this.ttlMs) this.entries.delete(k);
    }
}

module.exports = { RecentImageCache, extractImage, getSenderId, normalizeJid };
