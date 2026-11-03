import { createAskHandlers } from './ask.js';
import { createBasicHandlers } from './basic.js';
import { createCatchupHandlers } from './catchup.js';
import { createShared } from './shared.js';
import { createSettingsHandlers } from './settings.js';
import { createStickerHandlers } from './stickers.js';

/**
 * Native Discord command handlers. Slash commands do not go through the shared text-command
 * router: they use Discord options, ephemeral replies, embeds, buttons and a select menu.
 * @param {{config: any, logger: import('../../../core/logger.js').Logger, platform: import('../../contract.js').Platform, runtime: any}} deps
 */
export function createCommandRuntime(deps) {
  const shared = createShared(deps);
  const ask = createAskHandlers(shared);
  const settings = createSettingsHandlers(shared);
  const stickers = createStickerHandlers(shared);
  const catchup = createCatchupHandlers(shared);
  const basic = createBasicHandlers(shared);

  /** @type {Record<string, (interaction: any) => Promise<unknown>>} */
  const handlers = {
    ...ask.handlers,
    ...settings.handlers,
    ...stickers.handlers,
    ...catchup.handlers,
    ...basic.handlers,
  };

  /** @param {any} interaction */
  async function handleCommand(interaction) {
    if (!interaction.isChatInputCommand() && !interaction.isMessageContextMenuCommand()) return;
    const handler = handlers[interaction.commandName];
    if (!handler) return;
    try {
      await handler(interaction);
    } catch (error) {
      await shared.reportError(interaction, error);
    }
  }

  return {
    handleCommand,
    handleAutocomplete: settings.handleAutocomplete,
    handleSelect: settings.handleSelect,
    handleButton: ask.handleButton,
    handleModal: ask.handleModal,
  };
}
