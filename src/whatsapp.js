const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, isJidBroadcast } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const config = require('./config');
const { handleCommand, handleStickerCreation } = require('./commands');
const { setReminderSocket } = require('./reminders');
const { useRedisAuthState } = require('./redisAuth');

async function connectToWhatsApp() {
    const {
        UPSTASH_REDIS_REST_URL: redisUrl,
        UPSTASH_REDIS_REST_TOKEN: redisToken,
        WA_SESSION_KEY: sessionKey
    } = process.env;
    const useRedis = redisUrl || redisToken || sessionKey;
    if (useRedis && !(redisUrl && redisToken && sessionKey)) {
        throw new Error('Configure UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN e WA_SESSION_KEY juntos.');
    }
    const { state, saveCreds } = useRedis
        ? await useRedisAuthState(redisUrl, redisToken, sessionKey)
        : await useMultiFileAuthState(config.sessionPath);

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }), // Suprime os logs exaustivos do Baileys
        syncFullHistory: false, // Não baixa mensagens antigas do histórico, evitando Bad MAC de mensagens passadas
        shouldSyncHistoryMessage: () => false, // Evita o bloqueio de 20s do buffer inicial no Baileys 6.7.24+
        retryRequestDelayMs: 100, // Acelera recuperação de sessão sem travar a fila
        placeholderResendCache: { get: () => true, set: () => {}, del: () => {} }, // Evita o delay de 5s por mensagem indisponível na fila offline
        shouldIgnoreJid: (jid) => isJidBroadcast(jid), // Ignora transmissões e status do WhatsApp
        getMessage: async () => undefined, // Permite ao Baileys solicitar reenvio automático em caso de falha de descriptografia
        markOnlineOnConnect: true,
    });

    // Registra os IDs das mensagens enviadas pelo próprio bot para evitar loops infinitos,
    // mas permitindo que o dono da conta também envie comandos pelo celular/WhatsApp Web
    const sentByBotIds = new Set();
    const originalSendMessage = sock.sendMessage.bind(sock);
    sock.sendMessage = async (jid, content, options) => {
        try {
            const sent = await originalSendMessage(jid, content, options);
            if (sent?.key?.id) {
                sentByBotIds.add(sent.key.id);
                setTimeout(() => sentByBotIds.delete(sent.key.id), 60000);
            }
            return sent;
        } catch (err) {
            console.error('Aviso ao enviar mensagem (conexão oscilou):', err.message);
            return null;
        }
    };

    // Salva as credenciais sempre que forem atualizadas
    sock.ev.on('creds.update', () => {
        saveCreds().catch(err => {
            console.error('Erro ao salvar a sessão do WhatsApp:', err.message);
            process.exit(1);
        });
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            setReminderSocket(null);
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            if (statusCode === DisconnectReason.connectionReplaced) {
                console.log('⚠️ Outra instância do bot foi aberta em outro terminal! Encerrando esta instância para evitar conflito.');
                return;
            }
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            console.log('Conexão fechada. Motivo:', lastDisconnect?.error?.message, 'Reconectando:', shouldReconnect);
            
            if (shouldReconnect) {
                setTimeout(() => {
                    connectToWhatsApp().catch(err => {
                        console.error('Erro ao reconectar:', err);
                        process.exit(1);
                    });
                }, 2000);
            } else {
                console.log('Você foi desconectado (Logout). Uma nova sessão será necessária.');
            }
        } else if (connection === 'open') {
            setReminderSocket(sock);
            console.log('Conexão aberta! O bot está pronto para receber mensagens.');
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        if (m.type !== 'notify' && m.type !== 'append') return;

        for (const msg of m.messages) {
            if (!msg.message) continue;

            // Ignora mensagens enviadas pelo próprio código do bot (evita loops infinitos)
            if (sentByBotIds.has(msg.key.id)) continue;

            // Ignora mensagens antigas da fila offline (mais de 2 minutos atrás)
            const msgTimestamp = typeof msg.messageTimestamp === 'number'
                ? msg.messageTimestamp
                : msg.messageTimestamp?.low || 0;
            if (msgTimestamp && (Date.now() / 1000 - msgTimestamp > 120)) continue;

            const from = msg.key.remoteJid;
            if (!from || isJidBroadcast(from)) continue;

            // Extraindo texto (de mensagem de texto, de mídia com legenda ou ExtendedTextMessage)
            const messageText = 
                msg.message.conversation || 
                msg.message.extendedTextMessage?.text || 
                msg.message.imageMessage?.caption || 
                msg.message.videoMessage?.caption || 
                msg.message.documentMessage?.caption || 
                '';

            const isCommandHandled = await handleCommand(sock, msg, from, messageText);
            if (isCommandHandled) continue;

            // Verifica se é uma resposta a outra mensagem contendo o comando !sticker
            if (messageText.trim().toLowerCase() === '!sticker') {
                const quotedMessage = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
                if (quotedMessage) {
                    // Tenta extrair a imagem, vídeo ou GIF da mensagem citada
                    await handleStickerCreation(sock, msg, from, quotedMessage, true);
                    continue;
                } else if (msg.message.imageMessage || msg.message.videoMessage || msg.message.documentMessage) {
                    await handleStickerCreation(sock, msg, from, msg.message, false);
                    continue;
                } else {
                    await sock.sendMessage(from, { text: 'Por favor, responda a uma imagem, vídeo ou GIF com o comando !sticker para convertê-lo.' }, { quoted: msg });
                    continue;
                }
            }

            // Se não foi comando, verifica se contém imagem/vídeo/documento direto (cria figurinha automática)
            if (msg.message.imageMessage || msg.message.videoMessage || msg.message.documentMessage) {
                await handleStickerCreation(sock, msg, from, msg.message, false);
            }
        }
    });
}

module.exports = {
    connectToWhatsApp
};
