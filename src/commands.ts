import {
  ChannelType, InteractionContextType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder,
  type ChatInputCommandInteraction, type Guild, type VoiceChannel,
} from 'discord.js';
import { DiscordReceiver } from './receiver.js';
import { SessionManager } from './session.js';

export const recordCommand = new SlashCommandBuilder()
  .setName('record').setDescription('開発チームの参加者別にテスト録音する技術検証PoC').setContexts(InteractionContextType.Guild)
  .addSubcommand((command) => command.setName('start').setDescription('参加中VCへ通知し、テスト録音を開始する'))
  .addSubcommand((command) => command.setName('stop').setDescription('録音を停止し音声ファイルを確定する'))
  .addSubcommand((command) => command.setName('status').setDescription('録音状態・参加人数・受信件数を表示する'));

export function humanParticipants(channel: VoiceChannel): string[] {
  return [...channel.members.values()].filter((member) => !member.user.bot).map((member) => member.id);
}
export function recordingChannel(guild: Guild, channelId: string): VoiceChannel | undefined {
  const channel = guild.channels.cache.get(channelId);
  return channel?.type === ChannelType.GuildVoice ? channel : undefined;
}
export async function handleCommand(interaction: ChatInputCommandInteraction, manager: SessionManager): Promise<void> {
  if (interaction.commandName !== 'record') return;
  if (!interaction.inCachedGuild()) {
    await interaction.reply({ content: 'サーバー内で実行してください。', flags: MessageFlags.Ephemeral }); return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const subcommand = interaction.options.getSubcommand();
    const existing = manager.get(interaction.guildId);
    if (subcommand === 'status') {
      await interaction.editReply(existing?.status() ?? '録音セッションはありません。'); return;
    }
    const member = await interaction.guild.members.fetch(interaction.user.id);
    if (subcommand === 'stop') {
      if (!existing?.active) throw new Error('処理中の録音セッションはありません。');
      if (interaction.user.id !== existing.metadata.ownerId && member.voice.channelId !== existing.metadata.channelId &&
        !member.permissions.has(PermissionFlagsBits.ManageGuild)) throw new Error('対象VCの参加者・開始者・サーバー管理者が停止できます。');
      // 混合出力が長くてもinteractionの期限を超えないよう、停止処理中であることを先に返す。
      const stop = existing.stop();
      await interaction.editReply('受信を停止しました。ファイルの確定と混合出力が完了すると公開通知します。');
      await stop; return;
    }
    if (subcommand !== 'start') throw new Error('このサブコマンドは利用できません。管理者が pnpm register でコマンドを再登録してください。');
    const channel = member.voice.channel;
    if (channel?.type !== ChannelType.GuildVoice) throw new Error('通常のボイスチャンネルへ参加してから実行してください（Stageは対象外）。');
    const botMember = await interaction.guild.members.fetchMe();
    if (!channel.permissionsFor(botMember).has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect])) throw new Error('BotにVCの表示・接続権限が必要です。');
    // 公開通知はVCのテキストチャットへ送る。個別DMや音声内容の転送は行わない。
    if (!channel.permissionsFor(botMember).has(PermissionFlagsBits.SendMessages)) throw new Error('VCのテキストチャットへ通知できるようBotのメッセージ送信権限を設定してください。');
    const session = await manager.start({
      guildId: interaction.guildId, channelId: channel.id, ownerId: interaction.user.id,
      participants: humanParticipants(channel),
      voice: new DiscordReceiver(interaction.guildId, channel.id, interaction.guild.voiceAdapterCreator, { diagnostics: manager.diagnosticsEnabled }),
      notify: async (message) => { await channel.send({ content: message, allowedMentions: { parse: [] } }); },
    });
    await interaction.editReply(session.status());
  } catch (error) {
    // 実装内のユーザー向けエラーのみ。外部例外の内容（URL/トークン等）は返さない。
    const message = error instanceof Error && /^[ぁ-んァ-ヶ一-龠]/.test(error.message)
      ? error.message : '処理に失敗しました。Botの権限・設定・保存先を確認してください。';
    await interaction.editReply(message);
  }
}
