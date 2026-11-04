/**
 * Per-chat settings commands: reasoning mode, split mode and tone. They share the same
 * admin gate and persist through `store.touch`, so they live together instead of growing
 * the main command switch.
 *
 * @param {{canManage: (ctx: any) => boolean, config: any, store: any, logger?: any, platform: any}} input
 */
export function createSettingsCommands({ canManage, config, store, logger, platform }) {
  /** @param {any} ctx @param {string} args */
  function think(ctx, args) {
    if (!canManage(ctx)) {
      return { kind: 'text', text: 'Only group admins can change the reasoning mode.' };
    }
    if (!ctx.record.meta) ctx.record.meta = { thinking: null };
    const value = args.toLowerCase();
    const persist = () => {
      try {
        store.touch?.(ctx.chatId);
      } catch (error) {
        logger?.debug('persist thinking mode failed', { error: String(error) });
      }
    };
    if (!value) {
      return {
        kind: 'text',
        text: `Current reasoning mode: ${ctx.record.meta.thinking ?? 'per config'}. Use \`/think off|low|high\`.`,
      };
    }
    if (['off', 'none'].includes(value)) {
      ctx.record.meta.thinking = 'off';
      persist();
      return { kind: 'text', text: 'Reasoning is now off for this chat (faster replies).' };
    }
    if (['on', 'low'].includes(value)) {
      ctx.record.meta.thinking = 'low';
      persist();
      return { kind: 'text', text: 'Reasoning is now on at low level for this chat.' };
    }
    if (['medium', 'high'].includes(value)) {
      ctx.record.meta.thinking = value;
      persist();
      return { kind: 'text', text: `Reasoning is now set to ${value} level for this chat.` };
    }
    if (['auto', 'default'].includes(value)) {
      ctx.record.meta.thinking = null;
      persist();
      return { kind: 'text', text: 'Back to the reasoning mode from the config.' };
    }
    return { kind: 'text', text: 'Invalid value. Use `/think off|low|high|auto`.' };
  }

  /** @param {any} ctx @param {string} args */
  function split(ctx, args) {
    if (!canManage(ctx)) {
      return { kind: 'text', text: 'Only group admins can change the split mode.' };
    }
    if (!ctx.record.meta) ctx.record.meta = { thinking: null };
    const value = args.toLowerCase();
    const current = ctx.record.meta.split ?? 'per config';
    const persist = () => {
      try {
        store.touch?.(ctx.chatId);
      } catch (error) {
        logger?.debug('persist split mode failed', { error: String(error) });
      }
    };
    if (!value) {
      return {
        kind: 'text',
        text: `Split mode for this chat: **${current}** (global config: ${config.progressive}).\nUse \`/split off\` to merge replies into one message, \`/split on\` to split early, \`/split auto\` to follow the config.`,
      };
    }
    if (['off', 'tat', 't\u1EAFt', 'gop', 'g\u1ED9p'].includes(value)) {
      ctx.record.meta.split = 'off';
      persist();
      return {
        kind: 'text',
        text: `Split replies disabled: the bot merges replies into one message. Messages that are too long (over ${platform.limits.text} characters) still have to be split because of ${platform.label}'s limit.`,
      };
    }
    if (['on', 'bat', 'b\u1EADt'].includes(value)) {
      ctx.record.meta.split = 'on';
      persist();
      return {
        kind: 'text',
        text: 'Split replies enabled: the bot sends the first part as soon as a complete sentence is ready, so you wait less.',
      };
    }
    if (['auto', 'default', 'reset'].includes(value)) {
      ctx.record.meta.split = null;
      persist();
      return { kind: 'text', text: `Back to the split mode from the config (${config.progressive}).` };
    }
    return { kind: 'text', text: 'Invalid value. Use `/split off|on|auto`.' };
  }

  /** @param {any} ctx @param {string} args */
  function tone(ctx, args) {
    if (!canManage(ctx)) {
      return { kind: 'text', text: 'Only group admins can change the tone.' };
    }
    if (!ctx.record.meta) ctx.record.meta = { thinking: null };
    const value = args.toLowerCase();
    const persist = () => {
      try {
        store.touch?.(ctx.chatId);
      } catch (error) {
        logger?.debug('persist tone failed', { error: String(error) });
      }
    };
    // The chat history is anchored very strongly to the old tone. Insert a bot message as a
    // "tone switch marker" so the next turn does not imitate the old tone.
    const markTone = (text) => {
      try {
        if (Array.isArray(ctx.record.messages)) {
          ctx.record.messages.push({ role: 'assistant', text, ts: Date.now() });
        }
      } catch (error) {
        logger?.debug('mark tone failed', { error: String(error) });
      }
      persist();
    };
    if (!value) {
      return {
        kind: 'text',
        text: `Tone for this chat: **${ctx.record.meta.tone ?? config.tone}** (global config: ${config.tone}).\nUse \`/tone roast\` (snarky, playful roasting), \`/tone shy\` (soft, flustered) or \`/tone friendly\` (polite); \`/tone default\` to follow the config.`,
      };
    }
    if (['max', 'extreme', 'cuc', 'c\u1EF1c', 'sieu-nang', 'si\u00EAu n\u1EB7ng', 'g\u1EAFt', 'gat'].includes(value)) {
      ctx.record.meta.tone = 'roast-extreme';
      markTone('Ok, from now on I roast without holding back.');
      return {
        kind: 'text',
        text: '**Extreme roast** tone enabled for this chat 🔥🔥 (still no: family, discrimination, threats).',
      };
    }
    if (['hard', 'roast-hard', 'nang', 'n\u1EB7ng', 'manh', 'm\u1EA1nh'].includes(value)) {
      ctx.record.meta.tone = 'roast-hard';
      markTone('Ok, from now on I roast bluntly and harshly.');
      return {
        kind: 'text',
        text: '**Hard roast** tone enabled for this chat 🔥 (still no: discrimination, insults about family, threats).',
      };
    }
    if (['roast', 'cay', 'cakhia', 'c\u00E0 kh\u1ECBa', 'th\u00F4', 'tho'].includes(value)) {
      ctx.record.meta.tone = 'roast';
      markTone('Ok, from now on I tease you again 😈');
      return {
        kind: 'text',
        text: '**Roast** tone enabled for this chat 😈 (still limited: no discrimination, no insults about family).',
      };
    }
    if (['friendly', 'normal', 'thuong', 'th\u01B0\u1EDDng', 'l\u1ECBch s\u1EF1', 'lich su'].includes(value)) {
      ctx.record.meta.tone = 'friendly';
      markTone('Ok, from now on I talk politely and drop the roasting completely.');
      return { kind: 'text', text: 'Back to the polite tone for this chat.' };
    }
    if (['shy', 'cute', 'timid', 'ngai', 'ng\u1EA1i'].includes(value)) {
      ctx.record.meta.tone = 'shy';
      markTone('Um... okay... from now on I will speak softly and get a little shy... please be gentle with me...');
      return { kind: 'text', text: '**Shy** tone enabled for this chat 🌸 (soft, flustered, no swearing).' };
    }
    if (['default', 'auto', 'reset'].includes(value)) {
      ctx.record.meta.tone = null;
      markTone('Ok, from now on I use the tone from the bot config.');
      return { kind: 'text', text: `Back to the tone from the config (${config.tone}).` };
    }
    return { kind: 'text', text: 'Invalid value. Use `/tone roast` or `/tone friendly`.' };
  }

  return { think, split, tone };
}
