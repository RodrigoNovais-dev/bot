/**
 * Controle de uso do !criarskin:
 *  - uma geração ativa por usuário (pedidos repetidos são recusados);
 *  - intervalo mínimo (cooldown) entre gerações do mesmo usuário;
 *  - limite diário por usuário;
 *  - limite de gerações simultâneas com fila (não bloqueia o restante do bot);
 *  - deduplicação de mensagens entregues em duplicidade pelo WhatsApp.
 */
const config = require('../config');
const { SkinError } = require('./errors');

function today() {
    return new Date().toLocaleDateString('sv-SE'); // AAAA-MM-DD no fuso local
}

class SkinLimiter {
    constructor(options = {}) {
        this.opts = options; // valores fixos (testes) sobrepõem a config
        this.active = new Set();      // usuários com geração em andamento
        this.lastStart = new Map();   // usuário -> timestamp
        this.daily = new Map();       // usuário -> { day, count }
        this.running = 0;
        this.waiters = [];
        this.seen = new Map();        // id da mensagem -> expiração
    }

    get maxConcurrent() { return this.opts.maxConcurrent ?? config.skin.maxConcurrent; }
    get maxQueue() { return this.opts.maxQueue ?? config.skin.maxQueue; }
    get cooldownMs() { return (this.opts.cooldownSeconds ?? config.skin.cooldownSeconds) * 1000; }
    get dailyLimit() { return this.opts.dailyLimit ?? config.skin.dailyLimit; }

    /** true se a mensagem já foi processada recentemente (evita gerar duas vezes). */
    isDuplicate(messageId, ttlMs = 10 * 60 * 1000) {
        if (!messageId) return false;
        const now = Date.now();
        for (const [id, exp] of this.seen) if (exp < now) this.seen.delete(id);
        if (this.seen.has(messageId)) return true;
        this.seen.set(messageId, now + ttlMs);
        return false;
    }

    /**
     * Reserva uma geração para o usuário ou lança SkinError com o motivo.
     * @returns {{ position: number }} posição na fila (0 = começa imediatamente)
     */
    reserve(userId, { unlimited = false } = {}) {
        if (this.active.has(userId)) throw new SkinError('USER_BUSY', `Usuário ${userId} já tem geração ativa`);
        const now = Date.now();
        if (!unlimited) {
            const last = this.lastStart.get(userId) || 0;
            const wait = last + this.cooldownMs - now;
            if (wait > 0) {
                const secs = Math.ceil(wait / 1000);
                throw new SkinError('COOLDOWN', `Cooldown ${secs}s`, {
                    userMessage: `🕒 Aguarde ${secs} segundo(s) antes de criar outra skin.`
                });
            }
            const d = this.daily.get(userId);
            if (d && d.day === today() && d.count >= this.dailyLimit) {
                throw new SkinError('DAILY_LIMIT', `Limite diário ${this.dailyLimit}`, {
                    userMessage: `📅 Você atingiu o limite de ${this.dailyLimit} skin(s) por dia. Tente novamente amanhã.`
                });
            }
        }
        if (this.running >= this.maxConcurrent && this.waiters.length >= this.maxQueue) {
            throw new SkinError('QUEUE_FULL', 'Fila cheia');
        }
        this.active.add(userId);
        this.lastStart.set(userId, now);
        const d = this.daily.get(userId);
        if (!d || d.day !== today()) this.daily.set(userId, { day: today(), count: 1 });
        else d.count++;
        const position = this.running >= this.maxConcurrent ? this.waiters.length + 1 : 0;
        return { position };
    }

    /** Libera o usuário. Com refund=true a geração não conta no limite diário nem no cooldown. */
    release(userId, { refund = false } = {}) {
        this.active.delete(userId);
        if (refund) {
            const d = this.daily.get(userId);
            if (d && d.count > 0) d.count--;
            this.lastStart.delete(userId);
        }
    }

    /** Executa `fn` respeitando o limite de gerações simultâneas. */
    async run(fn) {
        if (this.running >= this.maxConcurrent) {
            await new Promise(resolve => this.waiters.push(resolve));
        } else {
            this.running++;
        }
        try {
            return await fn();
        } finally {
            const next = this.waiters.shift();
            if (next) next(); // passa a vaga diretamente para o próximo da fila
            else this.running--;
        }
    }
}

module.exports = { SkinLimiter };
