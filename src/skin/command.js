/**
 * Comando !criarskin para o bot de WhatsApp (Baileys).
 *
 * Modos de uso:
 *  1) Texto:  !criarskin [--modelo classic|slim] <descrição>
 *  2) Imagem com legenda: enviar foto com legenda !criarskin [--modelo classic|slim] [descrição]
 *  3) Imagem enviada antes + comando em seguida pelo MESMO usuário no mesmo chat
 *  4) Responder à própria imagem com !criarskin [--modelo classic|slim] [descrição]
 *
 * Nunca utiliza imagens de outros usuários como referência.
 */
const { downloadContentFromMessage } = require('@whiskeysockets/baileys');
const config = require('../config');
const { SkinError, toSkinError, USER_MESSAGES } = require('./errors');
const { SkinLimiter } = require('./limiter');
const { RecentImageCache, extractImage, getSenderId, normalizeJid } = require('./imageCache');
const { parseSkinCommandArgs, createSkin } = require('./service');
const { cleanupStale } = require('./tempFiles');

const defaultLimiter = new SkinLimiter();
const defaultImageCache = new RecentImageCache();
const pendingJobs = new Set();

// Limpeza periódica silenciosa de diretórios temporários órfãos
cleanupStale().catch(() => {});

/** Verifica se o texto da mensagem invoca o comando !criarskin. */
function isSkinCommand(messageText) {
    return /^!criarskin(?:\s|$)/i.test(String(messageText || '').trim());
}

/**
 * Registra a imagem enviada por um usuário para que ele possa digitar
 * !criarskin logo em seguida. Retorna true se a mensagem continha imagem.
 */
function rememberUserImage(msg, chatId, sock, cache = defaultImageCache) {
    const senderId = getSenderId(msg, sock);
    if (!chatId || !senderId) return false;
    return cache.remember(msg, chatId, senderId);
}

/** Texto de ajuda exibido quando o comando é enviado sem descrição e sem imagem. */
function buildHelpText() {
    return (
        `*🎨 Comando !criarskin — Criador de Skins 128×128 (Minecraft Bedrock)*\n\n` +
        `Crie uma skin personalizada por inteligência artificial de duas formas:\n\n` +
        `*1️⃣ Por texto:*\n` +
        `\`!criarskin um ninja preto com olhos vermelhos, capuz e detalhes roxos\`\n\n` +
        `*2️⃣ Por imagem de referência:*\n` +
        `• Envie uma foto com a legenda \`!criarskin\` (ou \`!criarskin <detalhes extras>\`);\n` +
        `• Ou envie a sua foto primeiro e mande \`!criarskin\` logo em seguida.\n\n` +
        `*🎮 Modelos disponíveis (padrão: Classic):*\n` +
        `• \`!criarskin --modelo classic ninja preto com olhos vermelhos\`\n` +
        `• \`!criarskin --modelo slim exploradora futurista\`\n\n` +
        `📐 *Saída:* PNG real de *128 × 128 pixels* (RGBA) + pacote *.mcpack* opcional.`
    );
}

/** Formata a legenda final da skin criada. */
function buildSuccessCaption(result) {
    const modelLabel = result.model === 'slim' ? 'Slim (braços 3px)' : 'Classic (braços 4px)';
    const geometryName = result.model === 'slim' ? 'geometry.humanoid.customSlim' : 'geometry.humanoid.custom';
    return (
        `✅ Skin criada!\n\n` +
        `🎮 Modelo: ${result.model === 'slim' ? 'Slim' : 'Classic'}\n` +
        `🎨 Tema: ${result.theme}\n` +
        `📐 Resolução: ${result.size} × ${result.size}\n` +
        `📁 Formato: PNG\n\n` +
        `Sua textura foi processada e validada.\n` +
        `Compatibilidade verificada com Minecraft Bedrock (${modelLabel} — \`${geometryName}\`, textura HD 128 × 128 RGBA).`
    );
}

/**
 * Localiza a imagem de referência pertencente EXCLUSIVAMENTE ao mesmo usuário.
 * Se o usuário respondeu à imagem de outra pessoa, lança erro explícito.
 */
function resolveUserReferenceImage(msg, chatId, senderId, cache = defaultImageCache) {
    // 1. Imagem anexada na própria mensagem do comando
    const direct = extractImage(msg?.message);
    if (direct) {
        return { source: 'direct', ...direct };
    }

    // 2. Mensagem citada (reply)
    const contextInfo =
        msg?.message?.extendedTextMessage?.contextInfo ||
        msg?.message?.imageMessage?.contextInfo ||
        msg?.message?.documentMessage?.contextInfo;
    const quotedMessage = contextInfo?.quotedMessage;
    if (quotedMessage) {
        const quotedImage = extractImage(quotedMessage);
        if (quotedImage) {
            const quotedSender = normalizeJid(contextInfo.participant || '');
            const recentOwn = cache.get(chatId, senderId);
            const isOwnByParticipant = Boolean(quotedSender && quotedSender === senderId);
            const isOwnByRecentId = Boolean(contextInfo.stanzaId && recentOwn && recentOwn.messageId === contextInfo.stanzaId);

            if (!isOwnByParticipant && !isOwnByRecentId) {
                throw new SkinError('BAD_ARGS', `Tentativa de usar imagem de outro usuário (${quotedSender} != ${senderId})`, {
                    userMessage: '⚠️ Por segurança, nunca utilizo a imagem de outro usuário como referência. Envie a sua própria imagem com a legenda *!criarskin* (ou envie a imagem e digite *!criarskin* em seguida).'
                });
            }
            return { source: 'quoted', ...quotedImage };
        }
    }

    // 3. Imagem enviada recentemente pelo MESMO usuário neste mesmo chat
    const recent = cache.get(chatId, senderId);
    if (recent) {
        return { source: 'recent', ...recent };
    }

    return null;
}

/** Baixa a imagem do WhatsApp respeitando o limite máximo de bytes. */
async function downloadReferenceImage(imageInfo, downloadFn = downloadContentFromMessage) {
    const maxBytes = config.skin.maxImageBytes;
    const maxMb = Math.round(maxBytes / (1024 * 1024));

    if (imageInfo.size && imageInfo.size > maxBytes) {
        throw new SkinError('IMAGE_TOO_LARGE', `Arquivo com ${imageInfo.size} bytes no cabeçalho`, {
            userMessage: `📦 A imagem enviada é muito grande (limite de ${maxMb} MB). Envie uma imagem menor.`
        });
    }

    let stream;
    try {
        stream = await downloadFn(imageInfo.media, imageInfo.type);
    } catch (err) {
        throw new SkinError('IMAGE_DOWNLOAD_FAILED', `Erro ao baixar mídia do WhatsApp: ${err.message}`, { cause: err });
    }

    const chunks = [];
    let total = 0;
    try {
        for await (const chunk of stream) {
            total += chunk.length;
            if (total > maxBytes) {
                throw new SkinError('IMAGE_TOO_LARGE', `Download excedeu ${maxBytes} bytes`, {
                    userMessage: `📦 A imagem enviada ultrapassa o limite de ${maxMb} MB. Envie uma imagem menor.`
                });
            }
            chunks.push(chunk);
        }
    } catch (err) {
        if (err instanceof SkinError) throw err;
        throw new SkinError('IMAGE_DOWNLOAD_FAILED', `Falha durante leitura da mídia: ${err.message}`, { cause: err });
    }

    const buffer = Buffer.concat(chunks);
    if (!buffer.length) {
        throw new SkinError('INVALID_IMAGE', 'Mídia baixada está vazia');
    }
    return buffer;
}

function isUserAdmin(senderId) {
    const digits = String(senderId || '').split('@')[0].replace(/\D/g, '');
    return Boolean(digits && config.skin.adminNumbers.includes(digits));
}

/**
 * Executa o comando !criarskin.
 * Por padrão dispara o processamento pesado em segundo plano (não bloqueia outros comandos),
 * mas permite `options.awaitCompletion = true` para testes automatizados.
 */
async function handleSkinCommand(sock, msg, from, messageText, options = {}) {
    if (!isSkinCommand(messageText)) return false;

    const limiter = options.limiter || defaultLimiter;
    const cache = options.imageCache || defaultImageCache;
    const downloadFn = options.downloadFn || downloadContentFromMessage;
    const createSkinFn = options.createSkinFn || createSkin;
    const client = options.client || null;
    const awaitCompletion = Boolean(options.awaitCompletion);

    const messageId = msg?.key?.id;
    if (limiter.isDuplicate(messageId)) return true;

    const senderId = getSenderId(msg, sock);

    let parsed;
    let imageInfo = null;
    try {
        parsed = parseSkinCommandArgs(messageText);
        if (!parsed || parsed.help) {
            await sock.sendMessage(from, { text: buildHelpText() }, { quoted: msg });
            return true;
        }

        // Busca imagem do próprio usuário (direta, citada do próprio usuário, ou recente do próprio usuário)
        imageInfo = resolveUserReferenceImage(msg, from, senderId, cache);

        // Sem texto e sem imagem -> exibe instruções de uso
        if (!parsed.prompt && !imageInfo) {
            await sock.sendMessage(from, { text: buildHelpText() }, { quoted: msg });
            return true;
        }

        // Verifica se a chave da OpenAI está configurada antes de iniciar
        if (!client && (!config.skin.openaiApiKey || config.skin.openaiApiKey === 'sua_chave_aqui')) {
            throw new SkinError('API_NOT_CONFIGURED', 'OPENAI_API_KEY não configurada');
        }
    } catch (err) {
        const skinErr = toSkinError(err, 'BAD_ARGS');
        await sock.sendMessage(from, { text: skinErr.userMessage }, { quoted: msg });
        return true;
    }

    // Reserva vaga no limitador por usuário
    let reservation;
    try {
        reservation = limiter.reserve(senderId, { unlimited: isUserAdmin(senderId) });
    } catch (err) {
        const skinErr = toSkinError(err);
        await sock.sendMessage(from, { text: skinErr.userMessage }, { quoted: msg });
        return true;
    }

    // Consome a imagem recente (já vinculada a esta geração)
    if (imageInfo?.source === 'recent') {
        cache.consume(from, senderId);
    }

    // Mensagem inicial obrigatória
    const startText = reservation.position > 0
        ? `⏳ Estou criando sua skin! Isso pode levar alguns instantes.\n_(Você está na posição ${reservation.position} da fila.)_`
        : '⏳ Estou criando sua skin! Isso pode levar alguns instantes.';
    await sock.sendMessage(from, { text: startText }, { quoted: msg });

    // Processamento assíncrono (não trava o loop de mensagens do bot)
    const jobPromise = limiter.run(async () => {
        let shouldRefund = false;
        try {
            let referenceImageBuffer = null;
            if (imageInfo) {
                referenceImageBuffer = await downloadReferenceImage(imageInfo, downloadFn);
            }

            const result = await createSkinFn({
                prompt: parsed.prompt,
                referenceImageBuffer,
                model: parsed.model,
                exportPack: parsed.exportPack,
                userId: senderId,
                client
            });

            const caption = buildSuccessCaption(result);

            // Envia o arquivo PNG 128 × 128 real como documento PNG (preserva transparência e resolução exata)
            const sentPng = await sock.sendMessage(from, {
                document: result.png,
                mimetype: 'image/png',
                fileName: result.pngFileName,
                caption
            }, { quoted: msg });

            if (sentPng === null) {
                throw new SkinError('SEND_FAILED', 'sock.sendMessage retornou null ao enviar o PNG');
            }

            // Envia opcionalmente o pacote .mcpack (sem afetar a entrega do PNG se falhar)
            if (result.mcpack && result.mcpackFileName) {
                try {
                    await sock.sendMessage(from, {
                        document: result.mcpack,
                        mimetype: 'application/octet-stream',
                        fileName: result.mcpackFileName,
                        caption: '📦 Pacote *.mcpack* opcional para importar direto no Minecraft Bedrock.'
                    }, { quoted: msg });
                } catch (packErr) {
                    console.warn('[criarskin] Aviso ao enviar .mcpack opcional:', packErr.message);
                }
            }
        } catch (err) {
            const skinErr = toSkinError(err, 'GENERATION_FAILED');
            shouldRefund = !skinErr.chargeable;
            console.error(`[criarskin] Erro (${skinErr.code}) para ${senderId}:`, skinErr.message);
            try {
                await sock.sendMessage(from, { text: skinErr.userMessage }, { quoted: msg });
            } catch (sendErr) {
                console.error('[criarskin] Falha ao enviar mensagem de erro:', sendErr.message);
            }
        } finally {
            limiter.release(senderId, { refund: shouldRefund });
        }
    });

    pendingJobs.add(jobPromise);
    jobPromise.finally(() => pendingJobs.delete(jobPromise));

    if (awaitCompletion) {
        await jobPromise;
    }
    return true;
}

/** Aguarda todas as gerações em andamento (útil em testes). */
async function waitForPendingJobs() {
    while (pendingJobs.size > 0) {
        await Promise.allSettled([...pendingJobs]);
    }
}

module.exports = {
    isSkinCommand,
    rememberUserImage,
    handleSkinCommand,
    resolveUserReferenceImage,
    downloadReferenceImage,
    buildHelpText,
    buildSuccessCaption,
    waitForPendingJobs,
    defaultLimiter,
    defaultImageCache
};
