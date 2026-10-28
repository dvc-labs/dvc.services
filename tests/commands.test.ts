import assert from 'node:assert/strict';
import test from 'node:test';
import { ApplicationCommand, ApplicationCommandOptionType, ApplicationCommandType,
  ChannelType, Client, Collection, SlashCommandBuilder, type Guild } from 'discord.js';
import { commands, syncCommands } from '../src/commands.js';

function fixture() {
  const client = new Client({ intents: [] });
  // Exercise discord.js's actual received-option conversion without a connection.
  const existing = new Collection<string, ApplicationCommand>(commands.map((command, index) => {
    const definition = command.toJSON();
    const received = Reflect.construct(ApplicationCommand, [client, {
      ...JSON.parse(JSON.stringify(definition)), type: definition.type ?? ApplicationCommandType.ChatInput,
      id: String(index + 1), application_id: '222222222222222222', version: '1',
    }]) as ApplicationCommand;
    return [received.id, received];
  }));
  const writes: unknown[] = [];
  const guild = { commands: {
    fetch: async () => existing,
    set: async (definitions: unknown) => { writes.push(definitions); return existing; },
  } } as unknown as Guild;
  return { guild, existing, writes };
}

test('command sync ignores command ordering and skips unchanged definitions', async () => {
  const f = fixture();
  f.existing.reverse();
  assert.equal(await syncCommands(f.guild), false);
  assert.deepEqual(f.writes, []);
});

test('command sync updates changed permissions, descriptions, types, and missing or extra commands', async () => {
  for (const change of ['permissions', 'description', 'type', 'missing', 'extra']) {
    const f = fixture();
    const current = f.existing.find(command => command.name === 'verification')!;
    if (change === 'permissions') current.defaultMemberPermissions = null;
    if (change === 'description') current.description = 'Old description';
    if (change === 'type') current.type = ApplicationCommandType.User;
    if (change === 'missing') f.existing.delete(current.id);
    if (change === 'extra') f.existing.set('extra', current);
    assert.equal(await syncCommands(f.guild), true, change);
    assert.equal(f.writes.length, 1, change);
  }
});

test('nested option camelCase fields match API definitions and real changes still sync', async () => {
  const command = new SlashCommandBuilder().setName('configure').setDescription('Configure settings');
  command.addSubcommandGroup(group => group.setName('settings').setDescription('Settings')
    .addSubcommand(subcommand => subcommand.setName('set').setDescription('Set values')
      .addStringOption(option => option.setName('label').setDescription('Label')
        .setMinLength(1).setMaxLength(32).setNameLocalization('nl', 'naam')
        .addChoices({ name: 'One', name_localizations: { nl: 'Een' }, value: 'one' }))
      .addIntegerOption(option => option.setName('count').setDescription('Count').setMinValue(0).setMaxValue(10))
      .addChannelOption(option => option.setName('channel').setDescription('Channel').addChannelTypes(ChannelType.GuildText))));
  commands.push(command);
  try {
    const unchanged = fixture();
    assert.equal(await syncCommands(unchanged.guild), false);
    assert.deepEqual(unchanged.writes, []);
    for (const change of ['length', 'value', 'channels', 'localisation', 'choice', 'order']) {
      const f = fixture();
      const group = f.existing.find(existing => existing.name === 'configure')!.options[0]!;
      assert.equal(group.type, ApplicationCommandOptionType.SubcommandGroup);
      if (group.type !== ApplicationCommandOptionType.SubcommandGroup) assert.fail('Expected group');
      const subcommand = group.options![0]!;
      const options = subcommand.options!;
      const label = options[0]!;
      const count = options[1]!;
      const channel = options[2]!;
      if (label.type !== ApplicationCommandOptionType.String
        || count.type !== ApplicationCommandOptionType.Integer
        || channel.type !== ApplicationCommandOptionType.Channel) assert.fail('Expected typed options');
      if (change === 'length') label.maxLength = 64;
      if (change === 'value') count.minValue = 2;
      if (change === 'channels') channel.channelTypes = [ChannelType.GuildVoice];
      if (change === 'localisation') label.nameLocalizations = { nl: 'anders' };
      if (change === 'choice') {
        if (!('choices' in label)) assert.fail('Expected choices');
        label.choices![0]!.value = 'changed';
      }
      if (change === 'order') subcommand.options = [...options].reverse();
      assert.equal(await syncCommands(f.guild), true, change);
      assert.equal(f.writes.length, 1, change);
    }
  } finally { commands.pop(); }
});
