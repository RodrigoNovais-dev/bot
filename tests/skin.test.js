/**
 * Suite de testes automatizados do comando !criarskin e seus módulos.
 * Executa com: npm test (node --test tests/skin.test.js)
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const AdmZip = require('adm-zip');
const sharp = require('sharp');

const config = require('../src/config');
const { SkinError } = require('../src/skin/errors');
const { getLayout, baseRegions, overlayRegions, figureLayout } = require('../src/skin/uvLayout');
const { buildTemplate, templateGeometry } = require('../src/skin/template');
const { mapOpenAIError, withModelFallback } = require('../src/skin/openaiClient');
const { analyzeRequest } = require('../src/skin/analyzer');
const { buildTextureFromConcept, buildProceduralTexture, renderPreview } = require('../src/skin/textureBuilder');
const { validateSkinPng, readIHDR } = require('../src/skin/validator');
const { buildMcpack } = require('../src/skin/mcpack');
const { safeSlug, skinFileName } = require('../src/skin/tempFiles');
const { SkinLimiter } = require('../src/skin/limiter');
const { RecentImageCache } = require('../src/skin/imageCache');
const { parseSkinCommandArgs, prepareReferenceImage, createSkin } = require('../src/skin/service');
const { handleSkinCommand, rememberUserImage } = require('../src/skin/command');
const { handleCommand } = require('../src/commands');

/** Cria um conceito sintético pintado sobre as regiões exatas do molde. */
async function createMockConceptImage(model = 'classic') {
    const geo = templateGeometry(model);
    const { width, height } = geo;
    const buf = Buffer.alloc(width * height * 4);

    // Fundo magenta (#FF00FF)
    for (let i = 0; i < width * height * 4; i += 4) {
        buf[i] = 255; buf[i + 1] = 0; buf[i + 2] = 255; buf[i + 3] = 255;
    }

    const paintRect = ([x, y, w, h], rgb) => {
        for (let yy = y; yy < y + h; yy++) {
            for (let xx = x; xx < x + w; xx++) {
                const idx = (yy * width + xx) * 4;
                buf[idx] = rgb[0]; buf[idx + 1] = rgb[1]; buf[idx + 2] = rgb[2]; buf[idx + 3] = 255;
            }
        }
    };

    const partPalette = {
        head: [30, 30, 38],
        body: [25, 25, 32],
        rightArm: [45, 30, 65],
        leftArm: [45, 30, 65],
        rightLeg: [20, 20, 28],
        leftLeg: [20, 20, 28]
    };

    for (const view of [geo.front, geo.back]) {
        for (const [name, rect] of Object.entries(view.parts)) {
            paintRect(rect, partPalette[name]);
        }
    }

    // Olhos vermelhos e detalhes roxos na cabeça frontal
    const [hx, hy, hw, hh] = geo.front.parts.head;
    paintRect([hx + Math.floor(hw * 0.15), hy + Math.floor(hh * 0.45), Math.floor(hw * 0.25), Math.floor(hh * 0.15)], [220, 30, 40]);
    paintRect([hx + Math.floor(hw * 0.6), hy + Math.floor(hh * 0.45), Math.floor(hw * 0.25), Math.floor(hh * 0.15)], [220, 30, 40]);
    paintRect([hx + Math.floor(hw * 0.2), hy + Math.floor(hh * 0.2), Math.floor(hw * 0.6), Math.floor(hh * 0.15)], [140, 50, 210]);

    return sharp(buf, { raw: { width, height, channels: 4 } }).png().toBuffer();
}

/** Cria um cliente OpenAI simulado que retorna análise estruturada + imagem conceitual. */
function createFakeOpenAIClient(model = 'classic', overrides = {}) {
    const specPayload = {
        recusar: false,
        motivo_recusa: '',
        tema: 'Ninja sombrio',
        resumo: 'Ninja preto com olhos vermelhos, capuz e detalhes roxos.',
        descricao_frente_en: 'Black ninja hood and mask with glowing red eyes and purple chest emblem.',
        descricao_costas_en: 'Back of black ninja hood and dark tunic with purple belt.',
        paleta: {
            pele: '#D29B78',
            cabelo: '#181820',
            olhos: '#DC1E28',
            roupa_superior: '#1E1E26',
            roupa_inferior: '#14141C',
            calcados: '#101014',
            destaque: '#8C32D2',
            destaque_secundario: '#DC1E28'
        },
        cabelo_estilo: 'capuz',
        mascara_facial: true,
        modelo_sugerido: model,
        ...overrides.spec
    };

    return {
        calls: { responses: [], images: [] },
        responses: {
            async create(params) {
                this.calls?.push(params);
                if (overrides.onResponse) return overrides.onResponse(params);
                return {
                    status: 'completed',
                    output: [],
                    output_text: JSON.stringify(specPayload)
                };
            }
        },
        images: {
            async edit(params) {
                if (overrides.onImage) return overrides.onImage(params);
                const img = await createMockConceptImage(model);
                return { data: [{ b64_json: img.toString('base64') }] };
            }
        }
    };
}

describe('1. Mapeamento UV 128×128 (Classic e Slim)', () => {
    it('calcula regiões UV exatas e sem sobreposição para Classic e Slim em 128×128', () => {
        for (const model of ['classic', 'slim']) {
            const layout = getLayout(model, 128);
            assert.equal(layout.size, 128);
            assert.equal(layout.scale, 2);

            const expectedArmW = model === 'slim' ? 6 : 8; // 3*2=6 ou 4*2=8 em 128x128
            assert.equal(layout.parts.rightArm.dims.w, expectedArmW);
            assert.equal(layout.parts.leftArm.dims.w, expectedArmW);
            assert.equal(layout.parts.head.dims.w, 16);
            assert.equal(layout.parts.body.dims.h, 24);

            // Verifica que nenhuma região base ou overlay se sobrepõe nem sai do 128x128
            const grid = new Uint8Array(128 * 128);
            const allRects = [...baseRegions(layout), ...overlayRegions(layout)];
            for (const { part, face, rect: [x, y, w, h] } of allRects) {
                assert.ok(x >= 0 && y >= 0 && x + w <= 128 && y + h <= 128, `Fora do limite em ${part}.${face}`);
                for (let j = y; j < y + h; j++) {
                    for (let i = x; i < x + w; i++) {
                        const idx = j * 128 + i;
                        assert.equal(grid[idx], 0, `Sobreposição UV em (${i},${j}) para ${model} ${part}.${face}`);
                        grid[idx] = 1;
                    }
                }
            }
        }
    });
});

describe('2. Molde (Template) e Construção da Textura 128×128 + Validação PNG', () => {
    it('gera molde e máscara válidos para Classic e Slim', async () => {
        for (const model of ['classic', 'slim']) {
            const tpl = await buildTemplate(model);
            const metaT = await sharp(tpl.template).metadata();
            const metaM = await sharp(tpl.mask).metadata();
            assert.equal(metaT.width, tpl.geometry.width);
            assert.equal(metaT.height, tpl.geometry.height);
            assert.equal(metaM.width, tpl.geometry.width);
            assert.equal(metaM.height, tpl.geometry.height);
        }
    });

    it('constrói textura 128×128 válida a partir do conceito visual (Classic e Slim)', async () => {
        for (const model of ['classic', 'slim']) {
            const conceptPng = await createMockConceptImage(model);
            const built = await buildTextureFromConcept(conceptPng, { model, size: 128, paletteColors: 24 });

            const ihdr = readIHDR(built.png);
            assert.ok(ihdr);
            assert.equal(ihdr.width, 128);
            assert.equal(ihdr.height, 128);
            assert.equal(ihdr.bitDepth, 8);
            assert.equal(ihdr.colorType, 6); // RGBA

            const validation = await validateSkinPng(built.png, { model, size: 128 });
            assert.equal(validation.valid, true, `Erros: ${validation.errors.join(', ')}`);

            const preview = await renderPreview(built.png, model);
            const prevMeta = await sharp(preview).metadata();
            assert.ok(prevMeta.width > 100 && prevMeta.height > 100);
        }
    });

    it('rejeita texturas com resolução incorreta (ex.: 64×64) ou camada base transparente', async () => {
        const png64 = await sharp({
            create: { width: 64, height: 64, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } }
        }).png().toBuffer();
        const res64 = await validateSkinPng(png64, { model: 'classic', size: 128 });
        assert.equal(res64.valid, false);
        assert.ok(res64.errors.some(e => e.includes('64x64')));

        const empty128 = await sharp({
            create: { width: 128, height: 128, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } }
        }).png().toBuffer();
        const resEmpty = await validateSkinPng(empty128, { model: 'classic', size: 128 });
        assert.equal(resEmpty.valid, false);
        assert.ok(resEmpty.errors.some(e => e.includes('transparentes na camada base')));
    });
});

describe('3. Exportação para .mcpack (Minecraft Bedrock)', () => {
    it('cria pacote .mcpack estruturado com manifest.json, skins.json, texts e PNG 128×128 intacto', async () => {
        const conceptPng = await createMockConceptImage('slim');
        const { png } = await buildTextureFromConcept(conceptPng, { model: 'slim', size: 128 });

        const pack = buildMcpack({ png, model: 'slim', name: 'Exploradora Futurista' });
        assert.ok(Buffer.isBuffer(pack.buffer));

        // Confirma que é um arquivo ZIP real e contém todos os arquivos exigidos pelo Bedrock
        const zip = new AdmZip(pack.buffer);
        const entries = zip.getEntries().map(e => e.entryName);
        assert.ok(entries.includes('manifest.json'));
        assert.ok(entries.includes('skins.json'));
        assert.ok(entries.includes('skin.png'));
        assert.ok(entries.includes('texts/en_US.lang'));
        assert.ok(entries.includes('texts/pt_BR.lang'));
        assert.ok(entries.includes('texts/languages.json'));

        const manifest = JSON.parse(zip.readAsText('manifest.json'));
        assert.equal(manifest.format_version, 1);
        assert.equal(manifest.modules[0].type, 'skin_pack');

        const skinsJson = JSON.parse(zip.readAsText('skins.json'));
        assert.equal(skinsJson.skins[0].geometry, 'geometry.humanoid.customSlim');
        assert.equal(skinsJson.skins[0].texture, 'skin.png');

        // O PNG dentro do .mcpack deve ser exatamente o PNG 128×128 original
        const extractedPng = zip.readFile('skin.png');
        assert.ok(extractedPng.equals(png));
        assert.deepEqual(readIHDR(extractedPng), { width: 128, height: 128, bitDepth: 8, colorType: 6, interlace: 0 });
    });
});

describe('4. Interpretação de Argumentos, Tratamento de Erros da OpenAI e Fallback de Modelo', () => {
    it('interpreta flags --modelo classic e --modelo slim corretamente', () => {
        const p1 = parseSkinCommandArgs('!criarskin um ninja preto com olhos vermelhos');
        assert.equal(p1.model, 'classic');
        assert.equal(p1.prompt, 'um ninja preto com olhos vermelhos');

        const p2 = parseSkinCommandArgs('!criarskin --modelo slim exploradora futurista');
        assert.equal(p2.model, 'slim');
        assert.equal(p2.prompt, 'exploradora futurista');

        const p3 = parseSkinCommandArgs('!criarskin --modelo classic ninja preto com olhos vermelhos');
        assert.equal(p3.model, 'classic');
        assert.equal(p3.prompt, 'ninja preto com olhos vermelhos');

        assert.throws(() => parseSkinCommandArgs('!criarskin --modelo gigante teste'), (err) => {
            return err instanceof SkinError && err.code === 'BAD_ARGS';
        });
    });

    it('mapeia erros da OpenAI para mensagens claras em português e faz fallback de modelo indisponível', async () => {
        assert.equal(mapOpenAIError({ status: 401, message: 'Incorrect API key' }).code, 'INVALID_KEY');
        assert.equal(mapOpenAIError({ status: 429, message: 'You exceeded your current quota, insufficient_quota' }).code, 'QUOTA_EXCEEDED');
        assert.equal(mapOpenAIError({ status: 429, message: 'Rate limit reached' }).code, 'RATE_LIMITED');
        assert.equal(mapOpenAIError({ status: 400, message: 'Safety system rejected request (moderation)' }).code, 'CONTENT_BLOCKED');
        assert.equal(mapOpenAIError({ name: 'AbortError', message: 'The operation was aborted' }).code, 'TIMEOUT');

        const tried = [];
        const res = await withModelFallback(['modelo-inexistente', 'modelo-valido'], async (m) => {
            tried.push(m);
            if (m === 'modelo-inexistente') {
                const e = new Error('The model does not exist');
                e.status = 404;
                throw e;
            }
            return `ok:${m}`;
        });
        assert.equal(res, 'ok:modelo-valido');
        assert.deepEqual(tried, ['modelo-inexistente', 'modelo-valido']);
    });

    it('sanitiza nomes de arquivos contra caracteres especiais e path traversal', () => {
        assert.equal(safeSlug('Ninja Sombrio: Árvore & Fogo! ../etc'), 'ninja_sombrio_arvore_fogo_etc');
        assert.equal(skinFileName('Ninja sombrio', 'classic', 'png', 128), 'skin_ninja_sombrio_classic_128x128.png');
    });
});

describe('5. Segurança, Isolamento de Imagens por Usuário, Limites e Fluxo no WhatsApp', () => {
    it('nunca utiliza a imagem de outro usuário (nem por cache recente, nem por reply)', async () => {
        const cache = new RecentImageCache(60_000);
        const limiter = new SkinLimiter({ cooldownSeconds: 0, dailyLimit: 20, maxConcurrent: 2 });
        const sentMessages = [];
        const sock = {
            user: { id: '551100000000@s.whatsapp.net' },
            async sendMessage(jid, content) {
                sentMessages.push({ jid, content });
                return { key: { id: `sent_${sentMessages.length}` } };
            }
        };

        const chat = '120363000000@g.us';
        const userA = '5511999991111@s.whatsapp.net';
        const userB = '5511999992222@s.whatsapp.net';

        // Usuário A envia uma imagem no grupo
        const msgImageUserA = {
            key: { id: 'img_a_1', remoteJid: chat, participant: userA },
            message: { imageMessage: { mimetype: 'image/png', fileLength: 1024 } }
        };
        rememberUserImage(msgImageUserA, chat, sock, cache);

        // Usuário B tenta executar !criarskin sem imagem e sem texto -> NÃO pode pegar a imagem de A (mostra ajuda)
        const msgCmdUserB = {
            key: { id: 'cmd_b_1', remoteJid: chat, participant: userB },
            message: { conversation: '!criarskin' }
        };
        await handleSkinCommand(sock, msgCmdUserB, chat, '!criarskin', {
            imageCache: cache,
            limiter,
            client: createFakeOpenAIClient(),
            awaitCompletion: true
        });
        assert.equal(sentMessages.length, 1);
        assert.ok(sentMessages[0].content.text.includes('Comando !criarskin'));
        // A imagem de A continua intacta para A
        assert.ok(cache.get(chat, userA));

        // Usuário B tenta responder (citar) a imagem de A com !criarskin -> deve ser bloqueado!
        sentMessages.length = 0;
        const msgReplyUserB = {
            key: { id: 'cmd_b_2', remoteJid: chat, participant: userB },
            message: {
                extendedTextMessage: {
                    text: '!criarskin',
                    contextInfo: {
                        stanzaId: 'img_a_1',
                        participant: userA,
                        quotedMessage: { imageMessage: { mimetype: 'image/png', fileLength: 1024 } }
                    }
                }
            }
        };
        await handleSkinCommand(sock, msgReplyUserB, chat, '!criarskin', {
            imageCache: cache,
            limiter,
            client: createFakeOpenAIClient(),
            awaitCompletion: true
        });
        assert.equal(sentMessages.length, 1);
        assert.ok(sentMessages[0].content.text.includes('nunca utilizo a imagem de outro usuário'));
    });

    it('executa o fluxo completo no WhatsApp (por texto e por imagem do próprio usuário) e preserva comandos antigos', async () => {
        const cache = new RecentImageCache(60_000);
        const limiter = new SkinLimiter({ cooldownSeconds: 0, dailyLimit: 20, maxConcurrent: 2 });
        const sentMessages = [];
        const sock = {
            user: { id: '551100000000@s.whatsapp.net' },
            async sendMessage(jid, content) {
                sentMessages.push({ jid, content });
                return { key: { id: `sent_${sentMessages.length}` } };
            }
        };

        const chat = '5511988887777@s.whatsapp.net';

        // 1. Comando antigo !ping continua funcionando normalmente
        const handledPing = await handleCommand(sock, { key: { id: 'p1', remoteJid: chat } }, chat, '!ping');
        assert.equal(handledPing, true);
        assert.ok(sentMessages[0].content.text.includes('Pong!'));
        sentMessages.length = 0;

        // 2. Criação de skin por texto + modelo slim
        const msgText = {
            key: { id: 'skin_txt_1', remoteJid: chat },
            message: { conversation: '!criarskin --modelo slim exploradora futurista' }
        };
        await handleSkinCommand(sock, msgText, chat, msgText.message.conversation, {
            imageCache: cache,
            limiter,
            client: createFakeOpenAIClient('slim'),
            awaitCompletion: true
        });

        assert.equal(sentMessages[0].content.text, '⏳ Estou criando sua skin! Isso pode levar alguns instantes.');
        const pngMsg = sentMessages.find(m => m.content.document && m.content.mimetype === 'image/png');
        assert.ok(pngMsg, 'Deve enviar o documento PNG real');
        assert.ok(pngMsg.content.caption.includes('✅ Skin criada!'));
        assert.ok(pngMsg.content.caption.includes('🎮 Modelo: Slim'));
        assert.ok(pngMsg.content.caption.includes('📐 Resolução: 128 × 128'));

        const validCheck = await validateSkinPng(pngMsg.content.document, { model: 'slim', size: 128 });
        assert.equal(validCheck.valid, true);

        const packMsg = sentMessages.find(m => m.content.fileName?.endsWith('.mcpack'));
        assert.ok(packMsg, 'Deve enviar o pacote .mcpack opcional');

        // 3. Criação de skin enviando imagem primeiro e !criarskin em seguida pelo mesmo usuário
        sentMessages.length = 0;
        const sampleRefPng = await sharp({
            create: { width: 64, height: 64, channels: 4, background: { r: 40, g: 80, b: 160, alpha: 1 } }
        }).png().toBuffer();

        const msgImg = {
            key: { id: 'img_own_1', remoteJid: chat },
            message: { imageMessage: { mimetype: 'image/png', fileLength: sampleRefPng.length } }
        };
        rememberUserImage(msgImg, chat, sock, cache);

        const msgFollowUp = {
            key: { id: 'skin_img_2', remoteJid: chat },
            message: { conversation: '!criarskin' }
        };
        await handleSkinCommand(sock, msgFollowUp, chat, '!criarskin', {
            imageCache: cache,
            limiter,
            client: createFakeOpenAIClient('classic'),
            downloadFn: async () => (async function* () { yield sampleRefPng; })(),
            awaitCompletion: true
        });

        assert.equal(sentMessages[0].content.text, '⏳ Estou criando sua skin! Isso pode levar alguns instantes.');
        const pngMsg2 = sentMessages.find(m => m.content.document && m.content.mimetype === 'image/png');
        assert.ok(pngMsg2);
        assert.equal(cache.get(chat, chat), null, 'Imagem recente deve ser consumida após o uso');
    });

    it('informa como configurar a chave quando OPENAI_API_KEY não está definida', async () => {
        const previousKey = process.env.OPENAI_API_KEY;
        const previousNoReload = process.env.SKIN_DISABLE_ENV_AUTORELOAD;
        delete process.env.OPENAI_API_KEY;
        process.env.SKIN_DISABLE_ENV_AUTORELOAD = '1';
        try {
            const sent = [];
            const sock = {
                async sendMessage(jid, content) { sent.push(content); return { key: { id: '1' } }; }
            };
            const msg = { key: { id: 'no_key_1', remoteJid: '5511999@s.whatsapp.net' }, message: { conversation: '!criarskin ninja' } };
            await handleSkinCommand(sock, msg, '5511999@s.whatsapp.net', '!criarskin ninja', { awaitCompletion: true });
            assert.equal(sent.length, 1);
            assert.ok(sent[0].text.includes('OPENAI_API_KEY'));
            assert.ok(sent[0].text.includes('https://platform.openai.com/'));
        } finally {
            if (previousKey !== undefined) process.env.OPENAI_API_KEY = previousKey;
            if (previousNoReload !== undefined) process.env.SKIN_DISABLE_ENV_AUTORELOAD = previousNoReload;
            else delete process.env.SKIN_DISABLE_ENV_AUTORELOAD;
        }
    });
});
