'use strict';

const policy = require('./policy');
const DEFAULT = Object.freeze({ name: 'Rescova', persona: 'assistant', voice: 'male', language: 'de' });

function validate(input) {
    if (!input || typeof input!=='object' || Array.isArray(input) ||
        Object.keys(input).sort().join(',')!=='language,name,persona,voice' ||
        typeof input.name!=='string' || !/^[\p{L}][\p{L}\p{M} '\u2019-]{0,39}$/u.test(input.name.trim()) ||
        !['founder','assistant'].includes(input.persona) || !['male','female'].includes(input.voice) ||
        !['de','en'].includes(input.language)) throw policy.problem('invalid_agent_profile');
    return { name: input.name.trim(), persona: input.persona, voice: input.voice, language: input.language };
}

function forShop(shop) {
    const profile = validate(shop.agent_profile ?? DEFAULT);
    const owner = profile.persona==='founder';
    const greeting = profile.language==='de'
        ? `Hey, hier ist ${profile.name}, die KI-Assistenz ${owner ? 'vom Gründerteam von' : 'von'} ${shop.brand}. Du hattest etwas bei uns im Warenkorb. Ist noch eine Frage zu den Produkten offen, bei der ich helfen kann?`
        : `Hi, I'm ${profile.name}, the AI assistant ${owner ? 'from the founding team at' : 'for'} ${shop.brand}. You had something in your cart with us. Is there a product question I can help with?`;
    return { ...profile, greeting };
}

module.exports = { DEFAULT, validate, forShop };
