const { downloadContentFromMessage } = require('@whiskeysockets/baileys');
const { convertToSticker } = require('./sticker');
const { handleReminderCommand } = require('./reminders');
const { handleRickCommand } = require('./rick');
const ytSearch = require('yt-search');
const youtubedl = require('youtube-dl-exec');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const axios = require('axios');
const googleTTS = require('google-tts-api');
const path = require('path');

ffmpeg.setFfmpegPath(ffmpegPath);

// Objeto para guardar o estado do jogo de adivinhação por chat
const jogosAdivinhacao = {};

async function handleYouTubeAudio(sock, msg, from, query) {
    try {
        await sock.sendMessage(from, { text: '🔍 Buscando a música, aguarde um momento...' }, { quoted: msg });
        
        // Busca o vídeo no YouTube
        const searchResult = await ytSearch(query);
        const video = searchResult.videos.length > 0 ? searchResult.videos[0] : null;

        if (!video) {
            await sock.sendMessage(from, { text: '❌ Não encontrei nenhum vídeo com esse nome.' }, { quoted: msg });
            return;
        }

        const videoUrl = video.url;
        await sock.sendMessage(from, { text: `🎧 Baixando o áudio de: *${video.title}*\n⏳ Isso pode levar alguns segundos...` }, { quoted: msg });

        // Baixa o formato padrão que tem menos bloqueios (webm)
        const subprocess = youtubedl.exec(videoUrl, {
            o: '-', 
            f: 'bestaudio',
            jsRuntimes: `node:${process.execPath}`,
            noWarnings: true
        });

        subprocess.catch((err) => {
            console.error('yt-dlp audio subprocess error:', err.message);
        });

        // Converte o fluxo WebM de áudio para OGG Opus (Formato nativo de Áudio/Mensagem de Voz do WhatsApp)
        const audioStream = ffmpeg(subprocess.stdout)
            .audioCodec('libopus')
            .format('ogg')
            .on('error', (err) => {
                console.error('Erro de conversão FFmpeg:', err);
            })
            .pipe();

        // Coleta o áudio convertido
        const chunks = [];
        audioStream.on('data', (chunk) => chunks.push(chunk));
        
        audioStream.on('end', async () => {
            const audioBuffer = Buffer.concat(chunks);
            
            // Envia o áudio como Áudio Nativo (Voice Note)
            // Isso burla o bug de metadados do Baileys garantindo que o player apareça em 100% dos celulares.
            await sock.sendMessage(from, { 
                audio: audioBuffer, 
                mimetype: 'audio/ogg; codecs=opus',
                ptt: true // true = Envia como "Mensagem de Voz", o que força o WhatsApp a habilitar o Play instantaneamente
            }, { quoted: msg });
        });

    } catch (error) {
        console.error('Erro ao processar YouTube:', error);
        await sock.sendMessage(from, { text: '❌ Ocorreu um erro ao tentar baixar essa música. Pode ser restrição de idade.' }, { quoted: msg });
    }
}

async function handleCommand(sock, msg, from, messageText) {
    const text = messageText.trim().toLowerCase();

    if (text === '!ping') {
        await sock.sendMessage(from, { text: 'Pong! Bot está funcionando corretamente. 🤖' }, { quoted: msg });
        return true;
    }

    if (text === '!menu') {
        const menu = `*🤖 Menu do Bot 🤖*\n\n` +
            `Comandos disponíveis:\n` +
            `*!ping* - Verifica se o bot está online.\n` +
            `*!menu* - Exibe esta lista de comandos.\n` +
            `*!sticker* - Envie ou responda a imagem, vídeo ou GIF para criar figurinha.\n` +
            `*!play <nome>* - Baixa o áudio de um vídeo do YouTube.\n` +
            `*!video <link>* - Baixa um vídeo do TikTok, Reels ou YouTube.\n` +
            `*!todos* - Marca todos os membros do grupo.\n` +
            `*!cep <numero>* - Busca o endereço completo.\n` +
            `*!cotacao* - Mostra o valor atual do Dólar, Euro e Bitcoin.\n` +
            `*!clima <cidade>* - Mostra a previsão do tempo.\n` +
            `*!tts <texto>* - O bot fala o que você escrever em áudio.\n` +
            `*!adivinhar* - Jogo interativo de descobrir o número secreto.\n` +
            `*!tales* - Zoação especial pro Tales lá do Piauí ☀️\n` +
            `*!lembrete <horário> <texto>* - Agenda um lembrete automático no horário escolhido.\n` +
            `*!lembretes* - Lista os lembretes agendados no chat.\n` +
            `*!dellembrete <id>* - Cancela um lembrete agendado.\n` +
            `*!bebado <texto>* - Converse com o Rick Sanchez bêbado (ou apenas fale "bêbado" em qualquer mensagem!).\n\n` +
            `_Dica: Enviar qualquer imagem, vídeo curto ou GIF também cria a figurinha automaticamente!_`;
        
        await sock.sendMessage(from, { text: menu }, { quoted: msg });
        return true;
    }

    if (text === '!todos') {
        if (!from.endsWith('@g.us')) {
            await sock.sendMessage(from, { text: '❌ Este comando só funciona em grupos!' }, { quoted: msg });
            return true;
        }
        try {
            const groupMetadata = await sock.groupMetadata(from);
            const participants = groupMetadata.participants;
            const mentions = participants.map(p => p.id);
            let texto = `*📢 ATENÇÃO TODOS 📢*\n\n`;
            for (let p of participants) {
                texto += `@${p.id.split('@')[0]} `;
            }
            await sock.sendMessage(from, { text: texto, mentions: mentions }, { quoted: msg });
        } catch (e) {
            await sock.sendMessage(from, { text: '❌ Erro ao buscar os membros do grupo.' }, { quoted: msg });
        }
        return true;
    }

    if (text.startsWith('!cep ')) {
        const cep = text.split(' ')[1].replace(/\D/g, '');
        if (cep.length !== 8) {
            await sock.sendMessage(from, { text: '❌ CEP inválido. Use 8 números.' }, { quoted: msg });
            return true;
        }
        try {
            const { data } = await axios.get(`https://viacep.com.br/ws/${cep}/json/`);
            if (data.erro) {
                await sock.sendMessage(from, { text: '❌ CEP não encontrado.' }, { quoted: msg });
            } else {
                const info = `*📍 Informações do CEP:*\n\n` +
                    `*Logradouro:* ${data.logradouro}\n` +
                    `*Bairro:* ${data.bairro}\n` +
                    `*Cidade/UF:* ${data.localidade} - ${data.uf}\n` +
                    `*DDD:* ${data.ddd}`;
                await sock.sendMessage(from, { text: info }, { quoted: msg });
            }
        } catch (e) {
            await sock.sendMessage(from, { text: '❌ Falha ao buscar CEP.' }, { quoted: msg });
        }
        return true;
    }

    if (text === '!cotacao') {
        try {
            const { data } = await axios.get('https://economia.awesomeapi.com.br/last/USD-BRL,EUR-BRL,BTC-BRL');
            const info = `*📈 Cotações Atuais:*\n\n` +
                `💵 *Dólar:* R$ ${parseFloat(data.USDBRL.bid).toFixed(2)}\n` +
                `💶 *Euro:* R$ ${parseFloat(data.EURBRL.bid).toFixed(2)}\n` +
                `🪙 *Bitcoin:* R$ ${parseFloat(data.BTCBRL.bid).toFixed(2)}`;
            await sock.sendMessage(from, { text: info }, { quoted: msg });
        } catch (e) {
            await sock.sendMessage(from, { text: '❌ Falha ao buscar cotações.' }, { quoted: msg });
        }
        return true;
    }

    if (text.startsWith('!clima ')) {
        const cidade = text.substring(7).trim();
        try {
            // Usa o wttr.in com o formato 3 (formato de texto curto)
            const url = `https://wttr.in/${encodeURIComponent(cidade)}?format=3&lang=pt`;
            const { data } = await axios.get(url);
            await sock.sendMessage(from, { text: `*🌤️ Clima em ${cidade}:*\n${data.trim()}` }, { quoted: msg });
        } catch (e) {
            await sock.sendMessage(from, { text: '❌ Não consegui achar o clima para essa cidade.' }, { quoted: msg });
        }
        return true;
    }

    if (text.startsWith('!tts ')) {
        const textoFalar = text.substring(5).trim();
        if (textoFalar.length > 200) {
            await sock.sendMessage(from, { text: '❌ O texto é muito longo para gerar o áudio (limite de 200 letras).' }, { quoted: msg });
            return true;
        }
        try {
            const url = googleTTS.getAudioUrl(textoFalar, { lang: 'pt-BR', slow: false, host: 'https://translate.google.com' });
            await sock.sendMessage(from, { 
                audio: { url: url }, 
                mimetype: 'audio/mp4', 
                ptt: true 
            }, { quoted: msg });
        } catch (e) {
            await sock.sendMessage(from, { text: '❌ Erro ao gerar a voz.' }, { quoted: msg });
        }
        return true;
    }

    if (text === '!adivinhar') {
        if (jogosAdivinhacao[from]) {
            await sock.sendMessage(from, { text: '⚠️ Já existe um jogo rolando neste chat! Use `!chute <numero>` para tentar adivinhar.' }, { quoted: msg });
            return true;
        }
        
        // Sorteia um número de 1 a 100
        const numeroSecreto = Math.floor(Math.random() * 100) + 1;
        jogosAdivinhacao[from] = {
            numero: numeroSecreto,
            tentativas: 0
        };

        const instrucoes = `🎮 *JOGO DA ADIVINHAÇÃO* 🎮\n\nEu pensei em um número entre *1 e 100*.\n\nTente adivinhar qual é enviando o comando:\n👉 *!chute <numero>*\n\nQuem acertar primeiro ganha!`;
        await sock.sendMessage(from, { text: instrucoes });
        return true;
    }

    if (text.startsWith('!chute ')) {
        const jogo = jogosAdivinhacao[from];
        if (!jogo) {
            await sock.sendMessage(from, { text: '❌ Nenhum jogo rolando no momento! Inicie um enviando *!adivinhar*' }, { quoted: msg });
            return true;
        }

        const palpite = parseInt(text.split(' ')[1]);
        if (isNaN(palpite) || palpite < 1 || palpite > 100) {
            await sock.sendMessage(from, { text: '⚠️ Envie um número válido de 1 a 100. Exemplo: `!chute 50`' }, { quoted: msg });
            return true;
        }

        jogo.tentativas++;

        if (palpite === jogo.numero) {
            const vencedor = msg.pushName || 'Você';
            await sock.sendMessage(from, { text: `🎉 *PARABÉNS, ${vencedor}!* 🎉\n\nVocê acertou o número secreto *${jogo.numero}* em ${jogo.tentativas} tentativa(s)!\nO jogo acabou. Para jogar de novo, envie *!adivinhar*.` }, { quoted: msg });
            delete jogosAdivinhacao[from]; // Encerra o jogo
        } else if (palpite < jogo.numero) {
            await sock.sendMessage(from, { text: `📈 O número secreto é *MAIOR* que ${palpite}!` }, { quoted: msg });
        } else {
            await sock.sendMessage(from, { text: `📉 O número secreto é *MENOR* que ${palpite}!` }, { quoted: msg });
        }
        return true;
    }

    if (text === '!tales') {
        const zoacoes = [
            `☀️ *ALERTA METEOROLÓGICO DO PIAUÍ:* O Tales acabou de abrir a geladeira só pra sentir como é ficar a menos de 45°C! Dizem que lá no Piauí tem 3 sóis pra cada habitante, e 2 deles ficam exclusivos em cima da casa do Tales! 🔥🥵`,
            `🍳 *ECONOMIA NO PIAUÍ:* O Tales nem gasta gás de cozinha! Ele só quebra o ovo no asfalto na frente de casa e em 10 segundos já tá frito. Se deixar 15 segundos, vira carvão! ☀️🔥`,
            `🧥 *PLANTÃO URGENTE:* Bateu 34°C lá no Piauí hoje e o Tales já tirou o casaco de lã e a touca do guarda-roupa dizendo que chegou a era glacial! 🥶🌴`,
            `📡 *CONEXÃO PIAUÍ:* Se o Tales demorar pra responder no grupo, tenham paciência... O pacote de dados da internet lá vem de jegue e às vezes evapora no meio do caminho por causa do calor! 🫏📶`,
            `🌵 *NOTÍCIA TRISTE:* O ventilador do Tales pediu demissão por justa causa hoje cedo. Disse que só tá soprando vento de airfryer na cara dele no B-R-O-Bró do Piauí! 🥵💨`,
            `🌋 *DIRETO DO PIAUÍ:* O Tales foi tomar banho frio pra refrescar, ligou o chuveiro no desligado e saiu água fervendo pronta pra passar café! Lá só existe água quente e lava vulcânica! ☕🔥`
        ];
        const escolhida = zoacoes[Math.floor(Math.random() * zoacoes.length)];
        await sock.sendMessage(from, { text: escolhida }, { quoted: msg });
        return true;
    }

    if (text.startsWith('!play ')) {
        const query = messageText.substring(6).trim();
        await handleYouTubeAudio(sock, msg, from, query);
        return true;
    }

    if (text.startsWith('!video')) {
        let url = messageText.substring(6).trim();
        // Se não foi passado link direto, verifica se o usuário respondeu a uma mensagem com link
        if (!url) {
            const quoted = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
            const quotedText = 
                quoted?.conversation || 
                quoted?.extendedTextMessage?.text || 
                quoted?.imageMessage?.caption || 
                quoted?.videoMessage?.caption || 
                quoted?.documentMessage?.caption || 
                '';
            const match = quotedText.match(/https?:\/\/[^\s]+/i);
            if (match) url = match[0];
        }

        const urlMatch = url.match(/https?:\/\/[^\s]+/i);
        if (!urlMatch) {
            await sock.sendMessage(from, { 
                text: '❌ Por favor, envie o link do vídeo junto com o comando ou responda a uma mensagem que tenha o link!\n\nExemplo: *!video https://...*' 
            }, { quoted: msg });
            return true;
        }

        await handleVideoDownload(sock, msg, from, urlMatch[0]);
        return true;
    }

    if (await handleReminderCommand(sock, msg, from, messageText)) {
        return true;
    }

    if (await handleRickCommand(sock, msg, from, messageText)) {
        return true;
    }

    return false; // Não foi um comando reconhecido
}

const crypto = require('crypto');
const fs = require('fs');

async function downloadTikTokViaTikWM(url, rawFile) {
    try {
        const res = await axios.get(`https://www.tikwm.com/api/?url=${encodeURIComponent(url)}`, {
            timeout: 15000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36'
            }
        });
        if (res.data?.code === 0 && (res.data?.data?.play || res.data?.data?.hdplay)) {
            const videoUrl = res.data.data.play || res.data.data.hdplay;
            const title = res.data.data.title || 'Vídeo do TikTok';
            const streamRes = await axios.get(videoUrl, {
                responseType: 'stream',
                timeout: 30000,
                headers: { 'User-Agent': 'Mozilla/5.0' }
            });
            const writer = fs.createWriteStream(rawFile);
            streamRes.data.pipe(writer);
            await new Promise((resolve, reject) => {
                writer.on('finish', resolve);
                writer.on('error', reject);
            });
            if (fs.existsSync(rawFile) && fs.statSync(rawFile).size > 0) {
                return { success: true, title };
            }
        }
    } catch (err) {
        console.warn('TikWM falhou, tentando fallback com yt-dlp:', err.message);
    }
    return { success: false };
}

async function convertToWhatsAppVideo(inputPath, outputPath) {
    return new Promise((resolve, reject) => {
        ffmpeg(inputPath)
            .outputOptions([
                '-c:v libx264',
                '-pix_fmt yuv420p',
                '-profile:v baseline',
                '-level 3.0',
                '-c:a aac',
                '-b:a 128k',
                '-ar 44100',
                '-movflags +faststart',
                '-preset ultrafast'
            ])
            .output(outputPath)
            .on('end', () => resolve(outputPath))
            .on('error', (err) => reject(err))
            .run();
    });
}

async function handleVideoDownload(sock, msg, from, rawUrl) {
    const rawFile = `temp-raw-${crypto.randomBytes(4).toString('hex')}.mp4`;
    const finalFile = `temp-final-${crypto.randomBytes(4).toString('hex')}.mp4`;

    try {
        await sock.sendMessage(from, { text: '🎬 Baixando o vídeo, aguarde um momento...' }, { quoted: msg });

        const url = rawUrl.trim();
        const isTikTok = /tiktok\.com/i.test(url);
        const isInstagram = /instagram\.com/i.test(url);
        let videoTitle = 'Aqui está o seu vídeo!';
        let downloaded = false;

        // 1. Se for TikTok, tenta via TikWM primeiro (rápido, limpo e sem marca d'água)
        if (isTikTok) {
            const tikwmResult = await downloadTikTokViaTikWM(url, rawFile);
            if (tikwmResult.success) {
                downloaded = true;
                if (tikwmResult.title) videoTitle = tikwmResult.title;
            }
        }

        // 2. Se não baixou via TikWM (YouTube, Instagram ou fallback do TikTok)
        if (!downloaded) {
            const cookiesPath = path.join(__dirname, '..', 'cookies.txt');
            const ytOptions = {
                format: 'bv*[height<=720]+ba/b[height<=720]/bv*+ba/b',
                mergeOutputFormat: 'mp4',
                ffmpegLocation: ffmpegPath,
                jsRuntimes: `node:${process.execPath}`,
                output: rawFile,
                noWarnings: true
            };

            if (fs.existsSync(cookiesPath)) {
                ytOptions.cookies = cookiesPath;
            }

            try {
                await youtubedl(url, ytOptions);
                if (fs.existsSync(rawFile) && fs.statSync(rawFile).size > 0) {
                    downloaded = true;
                }
            } catch (err) {
                console.error('Erro no yt-dlp:', err.message);
                if (isInstagram && err.message.includes('Instagram sent an empty media response')) {
                    await sock.sendMessage(from, { 
                        text: '❌ O Instagram bloqueou o download anônimo deste vídeo (exige login).\n\n💡 *Dica:* Para liberar o download do Instagram no bot, coloque o arquivo `cookies.txt` (exportado do seu navegador com sua conta do Instagram) na pasta do bot!\n\n_Vídeos do YouTube e TikTok continuam funcionando normalmente sem login._' 
                    }, { quoted: msg });
                    return;
                }
                throw err;
            }
        }

        if (!downloaded || !fs.existsSync(rawFile)) {
            await sock.sendMessage(from, { text: '❌ Não foi possível baixar o vídeo. Verifique se o link está correto e se o vídeo é público.' }, { quoted: msg });
            return;
        }

        // 3. Converte para o padrão nativo do WhatsApp (H.264 Baseline, YUV420P, AAC, FastStart)
        // Isso resolve o bug da tela preta e garante vídeo e áudio perfeitos no reprodutor de qualquer celular
        await convertToWhatsAppVideo(rawFile, finalFile);

        if (!fs.existsSync(finalFile)) {
            await sock.sendMessage(from, { text: '❌ Erro ao processar o vídeo para o formato do WhatsApp.' }, { quoted: msg });
            return;
        }

        const stats = fs.statSync(finalFile);
        const MAX_VIDEO_SIZE = 64 * 1024 * 1024; // 64 MB (limite seguro do player nativo do WhatsApp)

        if (stats.size > MAX_VIDEO_SIZE) {
            // Se ultrapassar 64MB, envia como documento para preservar a mídia
            await sock.sendMessage(from, { 
                document: fs.readFileSync(finalFile),
                mimetype: 'video/mp4',
                fileName: `video_${Date.now()}.mp4`,
                caption: `🎬 *${videoTitle}*\n\n⚠️ O vídeo ultrapassa 64MB, enviado como documento para não perder qualidade.`
            }, { quoted: msg });
        } else {
            // Envia como VÍDEO NATIVO (com capa, player direto e som no WhatsApp)
            await sock.sendMessage(from, { 
                video: fs.readFileSync(finalFile),
                mimetype: 'video/mp4',
                caption: `🎬 *${videoTitle}*`
            }, { quoted: msg });
        }

    } catch (error) {
        console.error('Erro ao processar download de vídeo:', error);
        await sock.sendMessage(from, { text: '❌ Ocorreu um erro ao baixar ou processar o vídeo. Certifique-se de que o link é público e válido.' }, { quoted: msg });
    } finally {
        // Limpeza dos arquivos temporários
        if (fs.existsSync(rawFile)) fs.unlinkSync(rawFile);
        if (fs.existsSync(finalFile)) fs.unlinkSync(finalFile);
    }
}

async function handleStickerCreation(sock, msg, from, mediaContainer, isReply = false) {
    try {
        let mediaMsg = null;
        let downloadType = null;
        let isAnimated = false;

        // Identifica o tipo de mídia no container (seja ele a mensagem direta ou citada)
        if (mediaContainer.videoMessage) {
            mediaMsg = mediaContainer.videoMessage;
            downloadType = 'video';
            isAnimated = true;
        } else if (mediaContainer.imageMessage) {
            mediaMsg = mediaContainer.imageMessage;
            downloadType = 'image';
            isAnimated = false;
        } else if (mediaContainer.documentMessage) {
            mediaMsg = mediaContainer.documentMessage;
            downloadType = 'document';
            const mimetype = mediaMsg.mimetype || '';
            if (mimetype.startsWith('video/') || mimetype === 'image/gif') {
                isAnimated = true;
            } else if (mimetype.startsWith('image/')) {
                isAnimated = false;
            } else {
                if (isReply) await sock.sendMessage(from, { text: '❌ O documento enviado não é uma imagem, vídeo ou GIF válido.' }, { quoted: msg });
                return;
            }
        } else {
            // Caso as chaves estejam diretamente no objeto (ex: objeto com chave única)
            const type = Object.keys(mediaContainer).find(k => k === 'imageMessage' || k === 'videoMessage' || k === 'documentMessage');
            if (type) {
                mediaMsg = mediaContainer[type];
                if (type === 'videoMessage') {
                    downloadType = 'video';
                    isAnimated = true;
                } else if (type === 'imageMessage') {
                    downloadType = 'image';
                    isAnimated = false;
                } else {
                    downloadType = 'document';
                    const mimetype = mediaMsg.mimetype || '';
                    isAnimated = mimetype.startsWith('video/') || mimetype === 'image/gif';
                }
            }
        }

        if (!mediaMsg) {
            if (isReply) await sock.sendMessage(from, { text: '❌ Por favor, envie ou responda a uma imagem, vídeo ou GIF.' }, { quoted: msg });
            return;
        }

        if (isAnimated) {
            await sock.sendMessage(from, { text: '⏳ Criando sua figurinha animada, aguarde alguns segundos...' }, { quoted: msg });
        }

        // Baixa o conteúdo da mensagem
        const stream = await downloadContentFromMessage(mediaMsg, downloadType);
        let buffer = Buffer.from([]);
        for await (const chunk of stream) {
            buffer = Buffer.concat([buffer, chunk]);
        }

        // Converte para figurinha (estática ou animada)
        const stickerBuffer = await convertToSticker(buffer, isAnimated);

        // Envia o sticker no WhatsApp
        await sock.sendMessage(from, { sticker: stickerBuffer }, { quoted: msg });

    } catch (error) {
        console.error('Erro ao processar criação de figurinha:', error);
        await sock.sendMessage(from, { text: '❌ Ocorreu um erro ao criar a figurinha. Certifique-se de que o arquivo é válido.' }, { quoted: msg });
    }
}

module.exports = {
    handleCommand,
    handleStickerCreation
};
