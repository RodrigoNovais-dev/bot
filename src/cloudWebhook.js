const { createHmac, timingSafeEqual } = require('node:crypto');
const { Readable } = require('node:stream');
const { handleCommand, handleStickerCreation } = require('./commands');
const { setReminderSocket } = require('./reminders');

const WEBHOOK_LIMIT = 1024 * 1024;
const MEDIA_TYPES = ['image', 'video', 'document'];

function equalSecret(received, expected) {
    const a = Buffer.from(received || '');
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
}

function createCloudWebhook(env) {
    const { WA_PHONE_NUMBER_ID, WA_ACCESS_TOKEN, WA_APP_SECRET, WA_VERIFY_TOKEN, WA_GRAPH_VERSION } = env;
    if (!/^\d+$/.test(WA_PHONE_NUMBER_ID || '') || !/^v\d+\.\d+$/.test(WA_GRAPH_VERSION || '')
        || !WA_ACCESS_TOKEN || !WA_APP_SECRET || !WA_VERIFY_TOKEN) {
        throw new Error('Preencha as cinco variáveis WA da Cloud API indicadas no README.');
    }

    const graph = `https://graph.facebook.com/${WA_GRAPH_VERSION}`;
    const recentMessages = new Map();

    async function graphRequest(url, options = {}) {
        const response = await fetch(url, {
            ...options,
            headers: { ...options.headers, Authorization: `Bearer ${WA_ACCESS_TOKEN}` },
            redirect: 'error',
            signal: AbortSignal.timeout(30000)
        });
        if (!response.ok) {
            const result = await response.json().catch(() => null);
            const code = result?.error?.code;
            const subcode = result?.error?.error_subcode;
            const details = [
                Number.isInteger(code) && `código ${code}`,
                Number.isInteger(subcode) && `subcódigo ${subcode}`
            ].filter(Boolean).join(', ');
            throw new Error(`API da Meta retornou HTTP ${response.status}${details ? ` (${details})` : ''}.`);
        }
        return response;
    }

    const socket = {
        async downloadMedia(media) {
            const metadata = await (await graphRequest(`${graph}/${encodeURIComponent(media.id)}`)).json();
            const url = new URL(metadata.url);
            if (url.protocol !== 'https:' || url.hostname !== 'lookaside.fbsbx.com') {
                throw new Error('Endereço de mídia inesperado na resposta da Meta.');
            }
            return Readable.fromWeb((await graphRequest(url)).body);
        },
        async sendMessage(to, content, options) {
            const payload = { messaging_product: 'whatsapp', to };
            if (options?.quoted?.key?.id) payload.context = { message_id: options.quoted.key.id };
            if (typeof content.text === 'string') {
                payload.type = 'text';
                payload.text = { body: content.text };
            } else {
                const type = ['sticker', 'audio', 'video', 'image', 'document'].find(name => content[name]);
                if (!type) throw new Error('Formato de mensagem incompatível com a Cloud API.');
                payload.type = type;
                const media = content[type];
                const mime = content.mimetype || { sticker: 'image/webp', image: 'image/png' }[type];
                const filename = content.fileName || `upload.${mime?.split('/')[1]?.split(';')[0] || 'bin'}`;
                if (Buffer.isBuffer(media)) {
                    const form = new FormData();
                    form.set('messaging_product', 'whatsapp');
                    form.set('file', new Blob([media], { type: mime }), filename);
                    const upload = await graphRequest(`${graph}/${WA_PHONE_NUMBER_ID}/media`, { method: 'POST', body: form });
                    payload[type] = { id: (await upload.json()).id };
                } else {
                    payload[type] = { link: media.url };
                }
                if (type === 'document') payload[type].filename = filename;
                if (content.caption && ['image', 'video', 'document'].includes(type)) {
                    payload[type].caption = content.caption;
                }
            }
            const response = await graphRequest(`${graph}/${WA_PHONE_NUMBER_ID}/messages`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const result = await response.json();
            console.info('WhatsApp Cloud: envio aceito pela Meta.');
            return { key: { id: result.messages[0].id } };
        }
    };
    setReminderSocket(socket);

    async function handleMessage(message, contacts) {
        const from = message.from;
        const text = message.text?.body || message[message.type]?.caption || '';
        const media = MEDIA_TYPES.includes(message.type) && message[message.type];
        const msg = {
            key: { id: message.id, remoteJid: from },
            pushName: contacts?.find(contact => contact.wa_id === from)?.profile?.name,
            message: media
                ? { [`${message.type}Message`]: { ...media, mimetype: media.mime_type } }
                : { conversation: text }
        };
        if (await handleCommand(socket, msg, from, text)) return;
        if (media) await handleStickerCreation(socket, msg, from, msg.message);
        else if (text.trim().toLowerCase() === '!sticker') {
            await socket.sendMessage(from, { text: 'Envie a imagem ou o vídeo diretamente para criar uma figurinha.' }, { quoted: msg });
        }
    }

    return async (req, res) => {
        const url = new URL(req.url, 'http://localhost');
        if (req.method === 'GET') {
            const challenge = url.searchParams.get('hub.challenge');
            if (challenge && url.searchParams.get('hub.mode') === 'subscribe'
                && equalSecret(url.searchParams.get('hub.verify_token'), WA_VERIFY_TOKEN)) {
                return res.writeHead(200, { 'Content-Type': 'text/plain' }).end(challenge);
            }
            return res.writeHead(403).end();
        }
        if (req.method !== 'POST') return res.writeHead(405).end();

        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
            size += chunk.length;
            if (size > WEBHOOK_LIMIT) {
                res.writeHead(413).end();
                return;
            }
            chunks.push(chunk);
        }
        const body = Buffer.concat(chunks);
        const signature = 'sha256=' + createHmac('sha256', WA_APP_SECRET).update(body).digest('hex');
        if (!equalSecret(req.headers['x-hub-signature-256'], signature)) {
            console.warn('WhatsApp Cloud: webhook rejeitado por assinatura inválida.');
            return res.writeHead(401).end();
        }

        let payload;
        try {
            payload = JSON.parse(body);
        } catch {
            return res.writeHead(400).end();
        }

        res.writeHead(200).end();
        if (payload?.object !== 'whatsapp_business_account') return;
        for (const entry of payload.entry || []) {
            for (const change of entry.changes || []) {
                const value = change.value;
                if (change.field !== 'messages') continue;
                if (value?.metadata?.phone_number_id !== WA_PHONE_NUMBER_ID) {
                    console.warn('WhatsApp Cloud: evento ignorado por ID de número diferente do configurado.');
                    continue;
                }
                for (const status of value.statuses || []) {
                    if (status.status !== 'failed') continue;
                    const codes = (status.errors || []).map(error => error.code).filter(Number.isInteger);
                    console.warn('WhatsApp Cloud: falha na entrega informada pela Meta.', codes);
                }
                for (const message of value.messages || []) {
                    if (!message.id || !message.from || recentMessages.has(message.id)) continue;
                    recentMessages.set(message.id, true);
                    if (recentMessages.size > 2048) recentMessages.delete(recentMessages.keys().next().value);
                    try {
                        console.info('WhatsApp Cloud: mensagem recebida no webhook.');
                        await handleMessage(message, value.contacts);
                    } catch (err) {
                        console.error('Falha ao processar mensagem da Meta:', err.message);
                    }
                }
            }
        }
    };
}

module.exports = { createCloudWebhook };
