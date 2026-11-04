import { MessageFlags } from 'discord.js';
import { isChannelAllowed } from './events.js';

/** @param {any} interaction */
function channelOfInteraction(interaction) {
  return interaction.channel ?? (interaction.channelId ? { id: interaction.channelId } : null);
}

/**
 * Apply `config.discord.allowedChannelIds` to a native interaction.
 * @param {any} config
 * @param {any} interaction
 */
async function allowedInteraction(config, interaction) {
  if (!interaction.guildId) return true;
  const channel = channelOfInteraction(interaction);
  if (channel) return isChannelAllowed(config, channel);
  // A guild command with no resolvable channel must not bypass an allow-list.
  return !(config.discord?.allowedChannelIds?.length ?? 0);
}

/**
 * Native Discord interaction routing: the allowed-channel gate, then the matching handler in
 * commands.js. Failures are logged instead of bubbling into the gateway listener.
 * @param {{config: any, logger?: import('../../core/logger.js').Logger, commands: any}} deps
 */
export function createInteractionRouter(deps) {
  const { config, logger, commands } = deps;

  /** @param {any} interaction */
  return async function handleInteraction(interaction) {
    if (!(await allowedInteraction(config, interaction))) {
      if (interaction.isAutocomplete()) {
        await interaction.respond([]).catch((error) => {
          logger?.debug('discord autocomplete reply failed', {
            error: String(/** @type {any} */ (error)?.message ?? error),
          });
        });
        return;
      }
      const payload = { content: 'This channel is not allowed.', flags: MessageFlags.Ephemeral };
      if (interaction.isRepliable()) {
        await interaction.reply(payload).catch((error) => {
          logger?.warn('discord blocked-channel reply failed', {
            error: String(/** @type {any} */ (error)?.message ?? error),
          });
        });
      }
      return;
    }
    try {
      if (interaction.isAutocomplete()) {
        await commands.handleAutocomplete(interaction);
        return;
      }
      if (interaction.isButton()) {
        await commands.handleButton(interaction);
        return;
      }
      if (interaction.isStringSelectMenu()) {
        await commands.handleSelect(interaction);
        return;
      }
      if (interaction.isModalSubmit()) {
        await commands.handleModal(interaction);
        return;
      }
      if (interaction.isChatInputCommand() || interaction.isMessageContextMenuCommand()) {
        await commands.handleCommand(interaction);
      }
    } catch (error) {
      logger?.error('discord interaction failed', {
        command: interaction.commandName || interaction.customId,
        error: String(/** @type {any} */ (error)?.message ?? error),
      });
    }
  };
}
