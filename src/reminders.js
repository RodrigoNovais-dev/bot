const fs = require('fs');
const { remindersPath: REMINDERS_FILE } = require('./config');

let activeSock = null;
let reminders = [];
let nextId = 1;
const timers = new Map();
const sending = new Set();

/**
 * Carrega os lembretes salvos em disco ao iniciar.
 */
function loadReminders() {
    try {
        if (fs.existsSync(REMINDERS_FILE)) {
            const raw = fs.readFileSync(REMINDERS_FILE, 'utf8');
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) {
                reminders = parsed;
                for (const r of reminders) {
                    if (r.id >= nextId) nextId = r.id + 1;
                }
            }
        }
    } catch (err) {
        console.error('Erro ao carregar lembretes:', err.message);
        reminders = [];
    }
}

/**
 * Salva os lembretes pendentes em disco.
 */
function saveReminders() {
    try {
        const tempFile = REMINDERS_FILE + '.tmp';
        fs.writeFileSync(tempFile, JSON.stringify(reminders, null, 2), 'utf8');
        fs.renameSync(tempFile, REMINDERS_FILE);
    } catch (err) {
        console.error('Erro ao salvar lembretes:', err.message);
    }
}

/**
 * Formata uma data para exibição amigável (DD/MM/YYYY às HH:MM:SS).
 */
function formatDateTime(timestamp) {
    const d = new Date(timestamp);
    const pad = (n) => String(n).padStart(2, '0');
    const hoje = new Date();
    const amanha = new Date();
    amanha.setDate(hoje.getDate() + 1);

    const isHoje =
        d.getDate() === hoje.getDate() &&
        d.getMonth() === hoje.getMonth() &&
        d.getFullYear() === hoje.getFullYear();

    const isAmanha =
        d.getDate() === amanha.getDate() &&
        d.getMonth() === amanha.getMonth() &&
        d.getFullYear() === amanha.getFullYear();

    const horaStr = `${pad(d.getHours())}:${pad(d.getMinutes())}${d.getSeconds() > 0 ? ':' + pad(d.getSeconds()) : ''}`;

    if (isHoje) return `Hoje às ${horaStr}`;
    if (isAmanha) return `Amanhã às ${horaStr}`;
    return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} às ${horaStr}`;
}

/**
 * Dispara o envio de um lembrete no WhatsApp.
 */
async function triggerReminder(reminder) {
    if (!activeSock) return false;

    try {
        const senderNumber = (reminder.senderPn || reminder.senderJid || '').split('@')[0].split(':')[0];
        const mentionJids = [];
        if (reminder.senderJid) mentionJids.push(reminder.senderJid);
        if (reminder.senderPn && reminder.senderPn !== reminder.senderJid) mentionJids.push(reminder.senderPn);

        const horaFormatada = formatDateTime(reminder.targetTime);
        const mencaoTexto = senderNumber ? `@${senderNumber}` : (reminder.pushName || 'Você');

        const texto =
            `⏰ *HORA DO SEU LEMBRETE!* ⏰\n\n` +
            `📌 *Lembrete:* ${reminder.text}\n` +
            `🕒 *Agendado para:* ${horaFormatada}\n` +
            `👤 *Pedido por:* ${mencaoTexto}`;

        const sent = await activeSock.sendMessage(reminder.chatJid, {
            text: texto,
            mentions: mentionJids
        });
        return Boolean(sent);
    } catch (err) {
        console.error('Erro ao disparar lembrete:', err.message);
        return false;
    }
}

async function deliverReminder(reminder) {
    if (sending.has(reminder.id) || !reminders.includes(reminder)) return;

    sending.add(reminder.id);
    try {
        if (await triggerReminder(reminder)) {
            const index = reminders.indexOf(reminder);
            if (index !== -1) {
                reminders.splice(index, 1);
                saveReminders();
            }
        }
    } finally {
        sending.delete(reminder.id);
    }
}

/**
 * Agenda o timer exato em memória para um lembrete.
 */
function scheduleTimer(reminder) {
    if (timers.has(reminder.id)) {
        clearTimeout(timers.get(reminder.id));
    }

    const delayMs = Math.max(0, reminder.targetTime - Date.now());
    // Limite máximo de setTimeout no Node.js (24.8 dias)
    if (delayMs > 2147483647) return;

    const timer = setTimeout(async () => {
        timers.delete(reminder.id);
        await deliverReminder(reminder);
    }, delayMs);

    timers.set(reminder.id, timer);
}

/**
 * Loop de segurança a cada 1 segundo para garantir disparo pontual
 * mesmo após reconexões ou timeouts longos.
 */
setInterval(async () => {
    if (!activeSock || reminders.length === 0) return;
    const now = Date.now();
    const due = reminders.filter((r) => r.targetTime <= now);

    for (const r of due) {
        if (timers.has(r.id)) {
            clearTimeout(timers.get(r.id));
            timers.delete(r.id);
        }
        await deliverReminder(r);
    }
}, 1000);

/**
 * Define o socket ativo do WhatsApp e agenda os lembretes pendentes.
 */
function setReminderSocket(sock) {
    activeSock = sock;
    for (const r of reminders) {
        if (!timers.has(r.id)) {
            scheduleTimer(r);
        }
    }
}

/**
 * Constrói um Date a partir de dia/mês/ano opcionais e hora:minuto:segundo.
 */
function buildTargetTime({ dayRef, day, month, year, hours, minutes, seconds }) {
    const h = parseInt(hours, 10);
    const m = minutes !== undefined && minutes !== null && minutes !== '' ? parseInt(minutes, 10) : 0;
    const s = seconds !== undefined && seconds !== null && seconds !== '' ? parseInt(seconds, 10) : 0;

    if (isNaN(h) || h < 0 || h > 23 || isNaN(m) || m < 0 || m > 59 || isNaN(s) || s < 0 || s > 59) {
        return null;
    }

    const now = new Date();
    const target = new Date(now.getTime());
    target.setHours(h, m, s, 0);

    if (day && month) {
        const d = parseInt(day, 10);
        const mo = parseInt(month, 10) - 1;
        let y = year ? parseInt(year, 10) : now.getFullYear();
        if (y < 100) y += 2000;
        target.setFullYear(y, mo, d);
        if (!year && target.getTime() <= now.getTime()) {
            target.setFullYear(y + 1);
        }
    } else if (dayRef && /^amanh[ãa]$/i.test(dayRef)) {
        target.setDate(target.getDate() + 1);
    } else if (dayRef && /^hoje$/i.test(dayRef)) {
        // Mantém hoje
    } else {
        // Se o horário já passou hoje, agenda para amanhã automaticamente
        if (target.getTime() <= now.getTime()) {
            target.setDate(target.getDate() + 1);
        }
    }

    return target.getTime();
}

/**
 * Analisa o texto do usuário para extrair o horário (relativo ou absoluto) e a mensagem do lembrete.
 */
function parseReminderInput(rawInput) {
    const input = rawInput.trim();
    if (!input) return null;

    // 1. Tempo relativo no início: ex: "daqui a 10 minutos comprar pão", "10m comprar pão", "1h30m estudar", "2h beber água"
    const relStartRegex = /^(?:(daqui\s+a|daqui|em)\s+)?(?:(\d+)\s*(horas?|hrs?|h)(?=\s|\d|$))?\s*(?:e\s*)?(?:(\d+)\s*(?:minutos?|mins?|m)(?=\s|\d|$))?\s*(?:e\s*)?(?:(\d+)\s*(?:segundos?|segs?|s)(?=\s|$))?(?:\s*(?:para|pra|de|-|:))?\s+(.+)$/i;
    const relStartMatch = input.match(relStartRegex);
    if (relStartMatch && (relStartMatch[2] || relStartMatch[4] || relStartMatch[5])) {
        const prefix = relStartMatch[1];
        const rawH = relStartMatch[2];
        const unitH = relStartMatch[3];
        const rawM = relStartMatch[4];
        const rawS = relStartMatch[5];
        const h = parseInt(rawH || '0', 10);
        const m = parseInt(rawM || '0', 10);
        const s = parseInt(rawS || '0', 10);

        // Se a pessoa digitou apenas "19h jantar" ou "08h reunião" (sem "daqui a", sem minutos e com "h" curto),
        // trata como horário do relógio (19:00 / 08:00) em vez de duração relativa.
        const isBareClockHour = !prefix && rawH && /^h$/i.test(unitH) && !rawM && !rawS && (rawH.startsWith('0') || h >= 6);
        if (!isBareClockHour) {
            const totalMs = ((h * 3600) + (m * 60) + s) * 1000;
            const reminderText = relStartMatch[6].trim();
            if (totalMs > 0 && reminderText) {
                return { targetTime: Date.now() + totalMs, text: reminderText };
            }
        }
    }

    // 2. Tempo relativo no final: ex: "olhar o forno daqui a 15 minutos", "tomar água em 30m", "estudar daqui 1h30m"
    const relEndRegex = /^(.+?)\s+(?:daqui\s+a\s+|daqui\s+|em\s+)(?:(\d+)\s*(?:horas?|hrs?|h)(?=\s|\d|$))?\s*(?:e\s*)?(?:(\d+)\s*(?:minutos?|mins?|m)(?=\s|\d|$))?\s*(?:e\s*)?(?:(\d+)\s*(?:segundos?|segs?|s)(?=\s|$))?$/i;
    const relEndMatch = input.match(relEndRegex);
    if (relEndMatch && (relEndMatch[2] || relEndMatch[3] || relEndMatch[4])) {
        const h = parseInt(relEndMatch[2] || '0', 10);
        const m = parseInt(relEndMatch[3] || '0', 10);
        const s = parseInt(relEndMatch[4] || '0', 10);
        const totalMs = ((h * 3600) + (m * 60) + s) * 1000;
        const reminderText = relEndMatch[1].replace(/\s+(?:para|pra|de|-|:)$/i, '').trim();
        if (totalMs > 0 && reminderText) {
            return { targetTime: Date.now() + totalMs, text: reminderText };
        }
    }

    // 3. Horário exato no início:
    // Ex: "19:30 tomar remédio", "às 19:30 tomar remédio", "amanhã às 08h30 reunião", "30/10 às 14:00 consulta"
    const absStartRegex = /^(?:(hoje|amanh[ãa])\s+|(?:no\s+dia\s+|dia\s+|em\s+)?(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\s+)?(?:[àa]s\s+|as\s+)?(?:(\d{1,2}):(\d{2})(?::(\d{2}))?|(\d{1,2})\s*h(?:oras?)?\s*(?:(\d{2})\s*(?:m|min|minutos?)?)?)(?:\s*(?:h|hrs|horas))?(?:\s+de\s+(hoje|amanh[ãa]))?(?:\s*(?:-|:|para|pra|de))?\s+(.+)$/i;
    const absStartMatch = input.match(absStartRegex);
    if (absStartMatch) {
        const [, dayRef1, day, month, year, hhColon, mmColon, ssColon, hhH, mmH, dayRef2, reminderText] = absStartMatch;
        const dayRef = dayRef1 || dayRef2;
        const hours = hhColon !== undefined ? hhColon : hhH;
        const minutes = hhColon !== undefined ? mmColon : (mmH || '0');
        const seconds = ssColon || '0';
        const targetTime = buildTargetTime({ dayRef, day, month, year, hours, minutes, seconds });
        if (targetTime && reminderText.trim()) {
            return { targetTime, text: reminderText.trim() };
        }
    }

    // 4. Horário exato no final da frase:
    // Ex: "tomar remédio às 19:30", "comprar pão hoje as 18h", "pagar conta amanhã às 10:00", "ir na academia 19:30"
    const absEndRegex = /^(.+?)\s+(?:(hoje|amanh[ãa])\s+|(?:no\s+dia\s+|dia\s+|em\s+)?(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\s+)?(?:(?:[àa]s|as)\s+)?(?:(\d{1,2}):(\d{2})(?::(\d{2}))?|(\d{1,2})\s*h(?:oras?)?\s*(?:(\d{2})\s*(?:m|min|minutos?)?)?)(?:\s*(?:h|hrs|horas))?(?:\s+de\s+(hoje|amanh[ãa]))?$/i;
    const absEndMatch = input.match(absEndRegex);
    if (absEndMatch) {
        const [, rawText, dayRef1, day, month, year, hhColon, mmColon, ssColon, hhH, mmH, dayRef2] = absEndMatch;
        const dayRef = dayRef1 || dayRef2;
        const hours = hhColon !== undefined ? hhColon : hhH;
        const minutes = hhColon !== undefined ? mmColon : (mmH || '0');
        const seconds = ssColon || '0';
        const targetTime = buildTargetTime({ dayRef, day, month, year, hours, minutes, seconds });
        const cleanText = rawText.replace(/\s+(?:para|pra|de|hoje|amanh[ãa]|[àa]s|as|-|:)+$/i, '').trim();
        if (targetTime && cleanText) {
            return { targetTime, text: cleanText };
        }
    }

    return null;
}

/**
 * Trata os comandos !lembrete, !lembrar, !lembretes e !dellembrete.
 */
async function handleReminderCommand(sock, msg, from, messageText) {
    const trimmed = messageText.trim();
    const lower = trimmed.toLowerCase();

    // Listar lembretes ativos do chat
    if (lower === '!lembretes' || lower === '!meuslembretes') {
        const chatReminders = reminders.filter((r) => r.chatJid === from);
        if (chatReminders.length === 0) {
            await sock.sendMessage(from, {
                text: '📭 Não há nenhum lembrete agendado neste chat no momento.\n\nUse *!lembrete <horário> <mensagem>* para criar um!'
            }, { quoted: msg });
            return true;
        }

        let lista = `⏰ *LEMBRETES AGENDADOS NESTE CHAT:*\n\n`;
        for (const r of chatReminders) {
            lista += `🔹 *ID #${r.id}* - ${formatDateTime(r.targetTime)}\n   📝 _${r.text}_\n\n`;
        }
        lista += `Para cancelar um lembrete, envie: *!dellembrete <ID>*`;
        await sock.sendMessage(from, { text: lista }, { quoted: msg });
        return true;
    }

    // Cancelar/deletar um lembrete
    if (lower.startsWith('!dellembrete ') || lower.startsWith('!cancelarlembrete ')) {
        const arg = trimmed.split(/\s+/)[1]?.toLowerCase();
        if (arg === 'todos') {
            const toRemove = reminders.filter((r) => r.chatJid === from);
            for (const r of toRemove) {
                if (timers.has(r.id)) {
                    clearTimeout(timers.get(r.id));
                    timers.delete(r.id);
                }
            }
            reminders = reminders.filter((r) => r.chatJid !== from);
            saveReminders();
            await sock.sendMessage(from, { text: `🗑️ Todos os lembretes deste chat (${toRemove.length}) foram cancelados!` }, { quoted: msg });
            return true;
        }

        const id = parseInt(arg, 10);
        const idx = reminders.findIndex((r) => r.id === id && r.chatJid === from);
        if (isNaN(id) || idx === -1) {
            await sock.sendMessage(from, { text: '❌ Lembrete não encontrado. Use *!lembretes* para ver os IDs ativos.' }, { quoted: msg });
            return true;
        }

        const [removed] = reminders.splice(idx, 1);
        if (timers.has(removed.id)) {
            clearTimeout(timers.get(removed.id));
            timers.delete(removed.id);
        }
        saveReminders();
        await sock.sendMessage(from, { text: `✅ Lembrete *#${removed.id}* (_"${removed.text}"_) foi cancelado com sucesso!` }, { quoted: msg });
        return true;
    }

    // Criar lembrete (!lembrete ou !lembrar)
    const matchCmd = trimmed.match(/^!(?:lembrete|lembrar)(?:\s+([\s\S]+))?$/i);
    if (!matchCmd) return false;

    const body = matchCmd[1]?.trim() || '';
    if (!body) {
        const ajuda =
            `⏰ *COMO USAR O LEMBRETE* ⏰\n\n` +
            `Você pode escrever o horário do jeito que preferir:\n\n` +
            `👉 *Por horário exato:*\n` +
            `• \`!lembrete 19:30 tomar remédio\`\n` +
            `• \`!lembrete comprar pão às 18:00\`\n` +
            `• \`!lembrete amanhã às 08h30 reunião\`\n` +
            `• \`!lembrete 30/10 14:00 consulta médica\`\n\n` +
            `👉 *Por tempo restante:*\n` +
            `• \`!lembrete daqui a 15 minutos olhar o forno\`\n` +
            `• \`!lembrete 10m desligar o fogo\`\n` +
            `• \`!lembrete 2h beber água\`\n\n` +
            `📋 *Outros comandos:*\n` +
            `• \`!lembretes\` - Lista os lembretes agendados\n` +
            `• \`!dellembrete <ID>\` - Cancela um lembrete`;
        await sock.sendMessage(from, { text: ajuda }, { quoted: msg });
        return true;
    }

    const parsed = parseReminderInput(body);
    if (!parsed) {
        await sock.sendMessage(from, {
            text:
                `❌ Não consegui identificar o horário e a mensagem do lembrete.\n\n` +
                `*Exemplos válidos:*\n` +
                `• \`!lembrete 20:30 tomar remédio\`\n` +
                `• \`!lembrete estudar às 19h\`\n` +
                `• \`!lembrete daqui a 10 minutos olhar a panela\``
        }, { quoted: msg });
        return true;
    }

    if (parsed.targetTime <= Date.now()) {
        await sock.sendMessage(from, { text: '❌ O horário informado já passou! Informe um horário futuro.' }, { quoted: msg });
        return true;
    }

    const senderJid = msg.key.participant || msg.key.remoteJid;
    const senderPn = msg.key.participantPn || msg.key.senderPn || (senderJid?.endsWith('@s.whatsapp.net') ? senderJid : null);

    const reminder = {
        id: nextId++,
        chatJid: from,
        senderJid,
        senderPn,
        pushName: msg.pushName || 'Usuário',
        text: parsed.text,
        targetTime: parsed.targetTime,
        createdAt: Date.now()
    };

    reminders.push(reminder);
    saveReminders();
    scheduleTimer(reminder);

    const confirmacao =
        `✅ *LEMBRETE AGENDADO!* ⏰\n\n` +
        `🆔 *ID:* #${reminder.id}\n` +
        `📌 *Mensagem:* ${reminder.text}\n` +
        `🕒 *Data/Horário:* ${formatDateTime(reminder.targetTime)}\n\n` +
        `_Eu vou te avisar automaticamente aqui no chat exatamente nesse horário!_`;

    await sock.sendMessage(from, { text: confirmacao }, { quoted: msg });
    return true;
}

// Inicializa carregando lembretes salvos
loadReminders();

module.exports = {
    handleReminderCommand,
    setReminderSocket,
    parseReminderInput
};
