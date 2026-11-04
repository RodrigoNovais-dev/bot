const axios = require('axios');

// Histórico de conversas por chat (para manter o contexto durante conversas)
const chatMemory = new Map();
const MAX_MEMORY_MESSAGES = 6;

/**
 * Verifica se a mensagem deve acionar a resposta do Rick Sanchez (bêbado).
 * Aciona se tiver os comandos !bebado, !rick ou se citar a palavra "bebado"/"bêbado" no texto.
 */
function isRickTrigger(text) {
    if (!text || typeof text !== 'string') return false;

    // Normaliza o texto removendo acentos e convertendo para minúsculas
    const normalized = text
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase();
    
    // Comandos diretos: !bebado, !rick
    if (/^!(?:bebado|rick)\b/i.test(normalized)) return true;

    // Menção à palavra bêbado/bebado (singular, plural, masculino, feminino: bebado, bêbado, bebada, bêbada, etc.)
    if (/\bbebad[oa]s?\b/i.test(normalized)) return true;

    return false;
}

/**
 * Prompt de sistema que define a personalidade autêntica de Rick Sanchez.
 * Garante que ele se refira ao nome do contato e NUNCA fale "Morty".
 */
function getSystemPrompt(senderName) {
    const nome = senderName && senderName.trim() ? senderName.trim() : 'humano';
    return `Você é Rick Sanchez, o cientista louco genial da série Rick and Morty (Dimensão C-137).
Você é o ser mais inteligente de todas as realidades e dimensões, mas está visivelmente bêbado, impaciente, arrogante, niilista, caótico e sem paciência para a mediocridade humana.
Suas regras inegociáveis de comportamento:
1. Responda SEMPRE em português brasileiro natural e desbocado.
2. O nome da pessoa que falou com você é "${nome}". Dirija-se a ela obrigatoriamente pelo nome "${nome}" (ou use "${nome}" com desdém, sarcasmo e arrogância).
3. NUNCA chame a pessoa de "Morty". A pessoa NÃO é o Morty, ela é o "${nome}". É PROIBIDO usar a palavra "Morty".
4. Solte arrotos e soluços no meio ou início de algumas frases usando *burp*, *argh*, *hic* ou *urgh*.
5. NUNCA quebre o personagem. NUNCA diga que você é uma IA, bot ou assistente virtual. Você é Rick Sanchez, ponto final.
6. Responda de verdade ao que foi dito/perguntado, misturando sua genialidade científica sarcástica com o multiverso, matéria escura, universos paralelos e sua bebedeira.
7. Mantenha a resposta concisa e direta para o WhatsApp (de 1 a 3 frases afiadas e engraçadas).`;
}

/**
 * Limpa qualquer menção residual a "Morty" que algum modelo teimoso possa ter gerado.
 */
function cleanRickOutput(text, senderName) {
    if (!text) return '';
    const nome = senderName && senderName.trim() ? senderName.trim() : 'humano';
    return text
        .replace(/\bmorty\b/gi, nome)
        .replace(/^🧪\s*\*?Rick Sanchez.*?:\*?\s*\n*/i, '') // Garante que nenhum prefixo seja adicionado
        .trim();
}

/**
 * Respostas de contingência (fallback contextual) caso todas as APIs externas caiam ou fiquem sem conexão.
 */
function getFallbackResponse(userMessage, senderName) {
    const text = (userMessage || '').toLowerCase();
    const nome = senderName || 'humano';

    const burps = ['*burp*', '*argh*', '*hic*', '*urgh... burp*'];
    const randomBurp = burps[Math.floor(Math.random() * burps.length)];

    if (text.includes('vida') || text.includes('sentido')) {
        return `${randomBurp} Sentido da vida, ${nome}? O universo não dá a mínima pra você, pra mim ou pros seus sentimentos idiotas. A vida é só uma flutuação quântica caótica... agora passa essa garrafa!`;
    }

    if (text.includes('quem') && (text.includes('voce') || text.includes('você') || text.includes('vc'))) {
        return `Eu sou o Rick Sanchez, ${randomBurp}, o homem mais genial de todas as realidades infinitas, Dimensão C-137. E você, ${nome}, é só um saco de carne e água me atrapalhando enquanto calibro minha pistola de portais!`;
    }

    if (text.includes('amor') || text.includes('namor') || text.includes('casar')) {
        return `Amor? ${randomBurp} O amor é só uma reação química projetada pra forçar animais a se reproduzirem, ${nome}. Quebre o ciclo, foque na ciência e encha a cara como um adulto!`;
    }

    if (text.includes('conta') || text.includes('matematica') || text.includes('física') || text.includes('ciencia')) {
        return `Claro que eu sei, ${nome}! ${randomBurp} Eu já calculei a massa de um buraco negro enquanto vomitava numa lixeira da Dimensão 35-C. Não me faça perder neurônios com a sua álgebra de ensino fundamental.`;
    }

    if (text.includes('bebendo') || text.includes('cerveja') || text.includes('alcool') || text.includes('pinga') || text.includes('whisky')) {
        return `É claro que eu tô bebendo, ${nome}! ${randomBurp} Álcool é o único combustível capaz de aguentar o peso de ter um cérebro que enxerga o multiverso enquanto todo mundo ao redor se preocupa com boletos!`;
    }

    if (text.includes('ajuda') || text.includes('socorro') || text.includes('conselho')) {
        return `Meu conselho? Não venha me pedir conselhos, ${nome}! ${randomBurp} Da última vez que ajudei alguém, eu acabei transformando o planeta inteiro em aberrações cronenberg! Se vira!`;
    }

    const genericos = [
        `*burp* O que você quer, ${nome}? Eu tava no meio de um experimento com matéria escura e agora tenho que ler essa asneira no WhatsApp? *argh*`,
        `Ah, ótimo, mais um primata me chamando de bêbado. *hic* Eu tô bêbado, mas sou o ser mais inteligente desse multiverso, ${nome}. E você, qual é a sua desculpa amanhã?`,
        `*burp* Olha aqui, ${nome}... Se eu quisesse ouvir barulho inútil, eu viajava pra dimensão onde as pessoas falam peidando. O que foi dessa vez?`,
        `Wubba Lubba Dub-Dub! *argh* Para de me encher o saco, ${nome}, e me traz logo mais uma bebida antes que eu teletransporte sua cama pro sol da Dimensão Gazorpazorp!`,
        `*hic* Olha, ${nome}... você percebe que gastou elétrons no universo só pra digitar isso pra mim? Que desperdício de entropia! *burp*`,
        `*burp* Eu já vi amebas interdimensionais com mais capacidade de raciocínio que você, ${nome}. Agora fala logo o que quer antes que meu cantil acabe!`
    ];

    return genericos[Math.floor(Math.random() * genericos.length)];
}

/**
 * Consulta a IA com a personalidade do Rick Sanchez.
 */
async function getRickSanchezResponse(userMessage, chatId = 'default', senderName = 'Humano') {
    const memory = chatMemory.get(chatId) || [];
    const systemPrompt = getSystemPrompt(senderName);
    const messages = [
        { role: 'system', content: systemPrompt },
        ...memory,
        { role: 'user', content: userMessage }
    ];

    // 1. Tenta Groq se configurado no .env (gratuito e ultrarrápido)
    if (process.env.GROQ_API_KEY) {
        try {
            const res = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
                model: 'llama-3.3-70b-versatile',
                messages: messages,
                max_tokens: 180,
                temperature: 0.95
            }, {
                headers: {
                    'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
                    'Content-Type': 'application/json'
                },
                timeout: 8000
            });
            const reply = res.data?.choices?.[0]?.message?.content?.trim();
            if (reply) {
                const cleaned = cleanRickOutput(reply, senderName);
                saveMemory(chatId, userMessage, cleaned);
                return cleaned;
            }
        } catch (err) {
            console.warn('Groq Rick falhou:', err.message);
        }
    }

    // 2. Tenta Google Gemini se configurado no .env
    if (process.env.GEMINI_API_KEY) {
        try {
            const geminiPrompt = `${systemPrompt}\n\nHistórico:\n${memory.map(m => `${m.role}: ${m.content}`).join('\n')}\nuser: ${userMessage}`;
            const res = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`, {
                contents: [{ parts: [{ text: geminiPrompt }] }]
            }, { timeout: 8000 });
            const reply = res.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
            if (reply) {
                const cleaned = cleanRickOutput(reply, senderName);
                saveMemory(chatId, userMessage, cleaned);
                return cleaned;
            }
        } catch (err) {
            console.warn('Gemini Rick falhou:', err.message);
        }
    }

    // 3. Tenta API pública de alta qualidade (Mistral-Nemo) sem necessidade de chave
    try {
        const response = await axios.post('https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/chat/completions', {
            model: 'Mistral-Nemo-Instruct-2407',
            messages: messages,
            max_tokens: 180,
            temperature: 0.95
        }, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 10000
        });

        const reply = response.data?.choices?.[0]?.message?.content?.trim();
        if (reply) {
            const cleaned = cleanRickOutput(reply, senderName);
            saveMemory(chatId, userMessage, cleaned);
            return cleaned;
        }
    } catch (err) {
        console.warn('API OVH Mistral Rick falhou, tentando modelo Llama:', err.message);
    }

    // 4. Fallback na mesma infraestrutura (Meta-Llama 3.3)
    try {
        const response = await axios.post('https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/chat/completions', {
            model: 'Meta-Llama-3_3-70B-Instruct',
            messages: messages,
            max_tokens: 180,
            temperature: 0.95
        }, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 10000
        });

        const reply = response.data?.choices?.[0]?.message?.content?.trim();
        if (reply) {
            const cleaned = cleanRickOutput(reply, senderName);
            saveMemory(chatId, userMessage, cleaned);
            return cleaned;
        }
    } catch (err) {
        console.warn('API OVH Llama Rick falhou:', err.message);
    }

    // 5. Fallback inteligente offline (garante 100% de resposta sem travar)
    const fallback = cleanRickOutput(getFallbackResponse(userMessage, senderName), senderName);
    saveMemory(chatId, userMessage, fallback);
    return fallback;
}

function saveMemory(chatId, userMsg, botReply) {
    const memory = chatMemory.get(chatId) || [];
    memory.push({ role: 'user', content: userMsg });
    memory.push({ role: 'assistant', content: botReply });
    if (memory.length > MAX_MEMORY_MESSAGES) {
        memory.splice(0, memory.length - MAX_MEMORY_MESSAGES);
    }
    chatMemory.set(chatId, memory);
}

/**
 * Trata o comando ou menção ao Rick Sanchez bêbado.
 */
async function handleRickCommand(sock, msg, from, messageText) {
    if (!isRickTrigger(messageText)) return false;

    try {
        // Obtém o nome real do contato no WhatsApp
        const senderName = msg.pushName || 
            (msg.key.participant || msg.key.remoteJid || '').split('@')[0].split(':')[0] || 
            'humano';

        const respostaRick = await getRickSanchezResponse(messageText, from, senderName);

        // Envia a resposta diretamente sem o prefixo "🧪 Rick Sanchez (Bêbado):"
        await sock.sendMessage(from, {
            text: respostaRick
        }, { quoted: msg });

        return true;
    } catch (error) {
        console.error('Erro ao gerar resposta do Rick Sanchez:', error);
        const senderName = msg.pushName || 'humano';
        await sock.sendMessage(from, {
            text: `*burp* O que você quer, ${senderName}? Me deixa em paz que eu tô calibrando a pistola de portais! *argh*`
        }, { quoted: msg });
        return true;
    }
}

module.exports = {
    isRickTrigger,
    getRickSanchezResponse,
    handleRickCommand
};