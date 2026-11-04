/**
 * Orquestração completa da criação de uma skin 128 × 128 para Minecraft Bedrock.
 *
 * Fluxo:
 *  1. Interpreta os argumentos do comando (--modelo classic|slim + descrição).
 *  2. Valida e normaliza a imagem de referência do usuário (se houver).
 *  3. Gera o molde (manequim em blocos) correspondente ao modelo escolhido.
 *  4. Analisa o pedido (texto e/ou imagem) na OpenAI (Responses API + JSON Schema).
 *  5. Gera o conceito visual na OpenAI (Image API /images/edits sobre o molde).
 *  6. Constrói a textura UV 128 × 128 (amostragem por célula, paleta k-means, extrusão 3D).
 *  7. Valida tecnicamente o PNG 128 × 128 (IHDR, RGBA, opacidade da camada base, transparência).
 *  8. Gera opcionalmente o pacote .mcpack e limpa os arquivos temporários.
 */
const fs = require('fs/promises');
const path = require('path');
const sharp = require('sharp');
const config = require('../config');
const { SkinError, toSkinError } = require('./errors');
const { MODELS, normalizeModel } = require('./uvLayout');
const { buildTemplate } = require('./template');
const { analyzeRequest } = require('./analyzer');
const { generateConcept } = require('./conceptGenerator');
const { buildTextureFromConcept, buildProceduralTexture, renderPreview } = require('./textureBuilder');
const { validateSkinPng } = require('./validator');
const { buildMcpack } = require('./mcpack');
const { skinFileName, createJobDir, writeJobFile, removeDir } = require('./tempFiles');

/**
 * Interpreta o texto do comando !criarskin.
 * Aceita:
 *   !criarskin <descrição>
 *   !criarskin --modelo classic <descrição>
 *   !criarskin --modelo slim <descrição>
 *   !criarskin --modelo=slim <descrição>
 *   !criarskin -m slim <descrição>
 */
function parseSkinCommandArgs(rawText) {
    const text = String(rawText || '').trim();
    const matchCmd = text.match(/^!criarskin(?:\s+([\s\S]*))?$/i);
    if (!matchCmd) return null;

    let rest = (matchCmd[1] || '').trim();
    let model = 'classic';
    let modelExplicit = false;
    let exportPack = null; // null = usa padrão do config

    // Processa flags no início ou no meio do comando
    const tokens = rest ? rest.split(/\s+/) : [];
    const promptTokens = [];

    for (let i = 0; i < tokens.length; i++) {
        const tok = tokens[i];
        const lower = tok.toLowerCase();

        if (lower === '--ajuda' || lower === '--help' || lower === '-h') {
            return { help: true, model: 'classic', prompt: '' };
        }
        if (lower === '--mcpack') {
            exportPack = true;
            continue;
        }
        if (lower === '--sem-mcpack' || lower === '--no-mcpack') {
            exportPack = false;
            continue;
        }
        if (lower === '--modelo' || lower === '--model' || lower === '-m') {
            const val = (tokens[i + 1] || '').toLowerCase();
            if (!val || !MODELS.includes(val)) {
                throw new SkinError('BAD_ARGS', `Modelo inválido: ${val || '(vazio)'}`, {
                    userMessage: '❌ Modelo inválido. Escolha *classic* ou *slim*.\nExemplo: `!criarskin --modelo slim exploradora futurista`'
                });
            }
            model = val;
            modelExplicit = true;
            i++;
            continue;
        }
        const eqMatch = lower.match(/^(?:--modelo|--model|-m)=(.+)$/);
        if (eqMatch) {
            const val = eqMatch[1];
            if (!MODELS.includes(val)) {
                throw new SkinError('BAD_ARGS', `Modelo inválido: ${val}`, {
                    userMessage: '❌ Modelo inválido. Escolha *classic* ou *slim*.\nExemplo: `!criarskin --modelo classic ninja preto`'
                });
            }
            model = val;
            modelExplicit = true;
            continue;
        }
        promptTokens.push(tok);
    }

    const prompt = promptTokens.join(' ').trim();
    if (prompt.length > config.skin.maxPromptLength) {
        throw new SkinError('BAD_ARGS', `Descrição muito longa (${prompt.length} chars)`, {
            userMessage: `❌ A descrição é muito longa (máximo de ${config.skin.maxPromptLength} caracteres). Resuma os detalhes principais.`
        });
    }

    return {
        help: false,
        model: normalizeModel(model),
        modelExplicit,
        exportPack,
        prompt
    };
}

/**
 * Valida a imagem de referência enviada pelo usuário (tamanho, formato, dimensões)
 * e retorna um PNG normalizado (máx. 1024 × 1024) seguro para enviar à OpenAI.
 */
async function prepareReferenceImage(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
        throw new SkinError('INVALID_IMAGE', 'Buffer de imagem vazio', { chargeable: false });
    }
    if (buffer.length > config.skin.maxImageBytes) {
        const maxMb = Math.round(config.skin.maxImageBytes / (1024 * 1024));
        throw new SkinError('IMAGE_TOO_LARGE', `Imagem com ${buffer.length} bytes`, {
            userMessage: `📦 A imagem enviada é muito grande (limite de ${maxMb} MB). Envie uma imagem menor.`
        });
    }

    let meta;
    try {
        meta = await sharp(buffer, { limitInputPixels: 64_000_000 }).metadata();
    } catch (err) {
        throw new SkinError('INVALID_IMAGE', `Falha ao ler metadados da imagem: ${err.message}`, { cause: err });
    }

    const allowedFormats = ['jpeg', 'png', 'webp', 'gif', 'avif'];
    if (!meta || !meta.width || !meta.height || !allowedFormats.includes(meta.format)) {
        throw new SkinError('INVALID_IMAGE', `Formato de imagem não suportado: ${meta?.format}`);
    }
    if (meta.width > config.skin.maxImageDimension || meta.height > config.skin.maxImageDimension) {
        throw new SkinError('IMAGE_TOO_LARGE', `Dimensões ${meta.width}x${meta.height} excedem limite`, {
            userMessage: `📦 A resolução da imagem (${meta.width}×${meta.height}) é muito alta. Envie uma imagem de até ${config.skin.maxImageDimension}×${config.skin.maxImageDimension} pixels.`
        });
    }

    try {
        return await sharp(buffer)
            .rotate() // respeita orientação EXIF de fotos de celular
            .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
            .png()
            .toBuffer();
    } catch (err) {
        throw new SkinError('INVALID_IMAGE', `Falha ao normalizar imagem: ${err.message}`, { cause: err });
    }
}

/** Executa uma promessa com timeout e AbortController. */
async function withTimeout(fn, timeoutMs) {
    const controller = new AbortController();
    let timer = null;
    const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => {
            controller.abort();
            reject(new SkinError('TIMEOUT', `Operação excedeu ${timeoutMs}ms`));
        }, timeoutMs);
    });
    try {
        return await Promise.race([fn(controller.signal), timeoutPromise]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

/**
 * Executa o fluxo completo de criação da skin.
 *
 * @param {object} params
 * @param {string} params.prompt Descrição textual (pode ser vazia se houver referenceImageBuffer).
 * @param {Buffer} [params.referenceImageBuffer] Imagem enviada pelo usuário (se houver).
 * @param {'classic'|'slim'} [params.model='classic']
 * @param {boolean} [params.exportPack] Se deve gerar .mcpack (padrão = config.skin.exportMcpack).
 * @param {string} [params.userId] Identificador do usuário (para safety_identifier da OpenAI).
 * @param {object} [params.client] Cliente OpenAI (opcional, usado nos testes).
 */
async function createSkin({
    prompt = '',
    referenceImageBuffer = null,
    model = 'classic',
    exportPack = null,
    userId = '',
    client = null
} = {}) {
    model = normalizeModel(model);
    const size = config.skin.textureSize; // 128
    const shouldExportMcpack = exportPack === null ? config.skin.exportMcpack : Boolean(exportPack);

    if (!prompt && !referenceImageBuffer) {
        throw new SkinError('BAD_ARGS', 'Sem descrição e sem imagem');
    }

    const jobDir = await createJobDir();
    try {
        return await withTimeout(async (signal) => {
            // 1. Prepara imagem de referência (se enviada)
            let referenceImage = null;
            if (referenceImageBuffer) {
                referenceImage = await prepareReferenceImage(referenceImageBuffer);
                await writeJobFile(jobDir, 'referencia.png', referenceImage);
            }

            // 2. Constrói o molde do modelo selecionado
            const template = await buildTemplate(model);
            await writeJobFile(jobDir, 'molde.png', template.template);

            // 3. Analisa o pedido (texto + imagem de referência)
            const spec = await analyzeRequest({
                prompt,
                referenceImage,
                model,
                userId,
                signal,
                client
            });

            // 4. Gera o conceito visual e constrói a textura UV 128 × 128
            const maxAttempts = spec._localFallback ? 0 : Math.max(1, config.skin.conceptAttempts);
            let built = null;
            let lastConceptError = null;
            let imageModelUsed = null;

            for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                try {
                    const concept = await generateConcept({
                        spec,
                        template,
                        referenceImage,
                        model,
                        userId,
                        signal,
                        client
                    });
                    imageModelUsed = concept.imageModel;
                    await writeJobFile(jobDir, `conceito_${attempt}.png`, concept.image);

                    const candidate = await buildTextureFromConcept(concept.image, {
                        model,
                        size,
                        paletteColors: config.skin.paletteColors,
                        specPalette: spec.paleta
                    });

                    // Se vazou muito fundo (> 35%) e ainda há tentativa, tenta mais uma vez
                    if (candidate.stats.backgroundLeakRatio > 0.35 && attempt < maxAttempts) {
                        lastConceptError = new Error(`Alto vazamento de fundo (${Math.round(candidate.stats.backgroundLeakRatio * 100)}%)`);
                        continue;
                    }
                    built = candidate;
                    break;
                } catch (err) {
                    lastConceptError = err;
                    // Erros de autenticação/bloqueio de conteúdo/timeout não devem ser repetidos
                    if (err instanceof SkinError && ['API_NOT_CONFIGURED', 'INVALID_KEY', 'CONTENT_BLOCKED', 'TIMEOUT'].includes(err.code)) {
                        throw err;
                    }
                    // Se a conta da OpenAI está sem créditos (QUOTA_EXCEEDED), não repete tentativa na API e vai direto para o gerador local HD
                    if (err instanceof SkinError && ['QUOTA_EXCEEDED', 'RATE_LIMITED'].includes(err.code)) {
                        break;
                    }
                    if (attempt < maxAttempts) {
                        console.warn(`[criarskin] Tentativa ${attempt}/${maxAttempts} de conceito falhou (${err.message}). Tentando novamente...`);
                    }
                }
            }

            // Contingência procedural (somente se habilitada e se o conceito falhou por erro de modelo/alinhamento)
            if (!built) {
                if (config.skin.allowProceduralFallback && spec) {
                    console.warn(`[criarskin] Usando construção procedural de contingência após falha no conceito: ${lastConceptError?.message}`);
                    built = await buildProceduralTexture(spec, { model, size });
                } else {
                    throw toSkinError(lastConceptError, 'GENERATION_FAILED');
                }
            }

            // 5. Valida tecnicamente o PNG 128 × 128
            let validation = await validateSkinPng(built.png, { model, size });
            if (!validation.valid && built.stats.source === 'concept' && config.skin.allowProceduralFallback) {
                console.warn(`[criarskin] Textura do conceito reprovada na validação (${validation.errors.join('; ')}). Recorrendo à construção procedural.`);
                built = await buildProceduralTexture(spec, { model, size });
                validation = await validateSkinPng(built.png, { model, size });
            }
            if (!validation.valid) {
                throw new SkinError('INVALID_TEXTURE', `Textura inválida: ${validation.errors.join('; ')}`);
            }

            const pngFileName = skinFileName(spec.tema, model, 'png', size);
            await writeJobFile(jobDir, pngFileName, built.png);

            // 6. Pré-visualização e pacote .mcpack opcional
            const preview = await renderPreview(built.png, model);
            await writeJobFile(jobDir, 'preview.png', preview);

            let mcpack = null;
            let mcpackFileName = null;
            if (shouldExportMcpack) {
                mcpack = buildMcpack({ png: built.png, model, name: spec.tema });
                mcpackFileName = skinFileName(spec.tema, model, 'mcpack', size);
                await writeJobFile(jobDir, mcpackFileName, mcpack.buffer);
            }

            // Cópia opcional em output/skins quando SKIN_KEEP_FILES=true
            if (config.skin.keepFiles) {
                await fs.mkdir(config.skin.outputDir, { recursive: true });
                await fs.writeFile(path.join(config.skin.outputDir, pngFileName), built.png);
                if (mcpack && mcpackFileName) {
                    await fs.writeFile(path.join(config.skin.outputDir, mcpackFileName), mcpack.buffer);
                }
            }

            return {
                png: built.png,
                pngFileName,
                preview,
                mcpack: mcpack ? mcpack.buffer : null,
                mcpackFileName,
                mcpackFiles: mcpack ? mcpack.files : [],
                model,
                size,
                theme: spec.tema,
                summary: spec.resumo,
                spec,
                validation,
                stats: {
                    ...built.stats,
                    imageModel: imageModelUsed
                }
            };
        }, config.skin.jobTimeoutMs);
    } finally {
        await removeDir(jobDir);
    }
}

module.exports = {
    parseSkinCommandArgs,
    prepareReferenceImage,
    createSkin
};
