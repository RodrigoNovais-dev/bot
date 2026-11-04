const { BufferJSON, initAuthCreds, proto } = require('@whiskeysockets/baileys');
const { createCipheriv, createDecipheriv, randomBytes } = require('node:crypto');

async function useRedisAuthState(endpoint, token, secret) {
    const url = new URL(endpoint);
    const key = Buffer.from(secret, 'hex');
    if (url.protocol !== 'https:' || !/^[a-f0-9]{64}$/i.test(secret)) {
        throw new Error('Configure uma URL HTTPS do Redis e uma WA_SESSION_KEY de 64 dígitos hexadecimais.');
    }

    const hash = 'whatsapp-sticker-bot:auth:v1';
    let syncToken;
    let pendingWrite = Promise.resolve();

    function encode(value) {
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', key, iv);
        const encrypted = Buffer.concat([
            cipher.update(JSON.stringify(value, BufferJSON.replacer), 'utf8'),
            cipher.final()
        ]);
        return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
    }

    function decode(value) {
        if (value === null) return null;
        const bytes = Buffer.from(value, 'base64');
        const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
        decipher.setAuthTag(bytes.subarray(12, 28));
        const decoded = Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]);
        return JSON.parse(decoded.toString('utf8'), BufferJSON.reviver);
    }

    async function request(body, transaction = false) {
        const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
        if (syncToken) headers['upstash-sync-token'] = syncToken;
        const response = await fetch(new URL(transaction ? '/multi-exec' : '/', url), {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            redirect: 'error',
            signal: AbortSignal.timeout(10000)
        });
        if (!response.ok) throw new Error(`Falha no Redis da sessão (HTTP ${response.status}).`);
        const payload = await response.json();
        const results = transaction ? payload : [payload];
        if (!Array.isArray(results) || results.some(item => !item || !Object.hasOwn(item, 'result'))) {
            throw new Error('O Redis recusou a operação da sessão.');
        }
        syncToken = response.headers.get('upstash-sync-token') || syncToken;
        return transaction ? results : payload.result;
    }

    function write(commands) {
        const operation = pendingWrite.then(() => request(commands, true));
        pendingWrite = operation.catch(() => {});
        return operation;
    }

    const creds = decode(await request(['HGET', hash, 'creds'])) || initAuthCreds();
    return {
        state: {
            creds,
            keys: {
                async get(type, ids) {
                    if (ids.length === 0) return {};
                    await pendingWrite;
                    const values = await request(['HMGET', hash, ...ids.map(id => JSON.stringify([type, id]))]);
                    return Object.fromEntries(ids.map((id, index) => {
                        const value = decode(values[index]);
                        return [id, type === 'app-state-sync-key' && value
                            ? proto.Message.AppStateSyncKeyData.fromObject(value)
                            : value];
                    }));
                },
                async set(data) {
                    const updates = [];
                    const removals = [];
                    for (const [type, entries] of Object.entries(data)) {
                        for (const [id, value] of Object.entries(entries)) {
                            const field = JSON.stringify([type, id]);
                            if (value == null) removals.push(field);
                            else updates.push(field, encode(value));
                        }
                    }
                    const commands = [];
                    if (updates.length) commands.push(['HSET', hash, ...updates]);
                    if (removals.length) commands.push(['HDEL', hash, ...removals]);
                    if (commands.length) await write(commands);
                }
            }
        },
        saveCreds: () => write([['HSET', hash, 'creds', encode(creds)]])
    };
}

module.exports = { useRedisAuthState };
