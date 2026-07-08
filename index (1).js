require("dotenv").config();

// ─── FFMPEG PATH SETUP (must be before @discordjs/voice) ─────────────────────
const ffmpegPath = require("ffmpeg-static");
process.env.PATH = `${process.env.PATH}:${require("path").dirname(ffmpegPath)}`;

const {
  Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes,
  PermissionFlagsBits, EmbedBuilder, ChannelType,
  ButtonBuilder, ButtonStyle, ActionRowBuilder,
  StringSelectMenuBuilder, StringSelectMenuOptionBuilder
} = require("discord.js");
const {
  joinVoiceChannel, createAudioPlayer, createAudioResource,
  AudioPlayerStatus, VoiceConnectionStatus, StreamType
} = require("@discordjs/voice");
const ytdl = require("@distube/ytdl-core");
const YouTube = require("youtube-sr").default;
const http = require("http");
const fs = require("fs");
const path = require("path");

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const CONFIG_PATH = path.join(__dirname, "config.json");

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")); }
  catch { return { guideChannels: [], guideEnabled: false, customRanks: [], houses: [] }; }
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

// ─── KEEP-ALIVE SERVER ────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200);
  res.end("☀ Nevaris Order Bot is online.");
}).listen(PORT, () => console.log(`Keep-alive server running on port ${PORT}`));

// ─── RANK SYSTEM ──────────────────────────────────────────────────────────────
const DEFAULT_RANKS = [
  "Starling", "Dawnsworn", "Celestial Knight",
  "Horizon Warden", "Zenith Vanguard", "Dawnseer",
  "Astral Regent", "Luminary of Nevaris"
];

const DEFAULT_RANK_CATEGORIES = [
  { label: "🔱 High Ranks", ranks: ["Luminary of Nevaris", "Astral Regent", "Dawnseer", "⚡ Dawnborn"] },
  { label: "⚔️ Mid Ranks",  ranks: ["Zenith Vanguard", "Horizon Warden", "Celestial Knight"] },
  { label: "🌟 Low Ranks",  ranks: ["Dawnsworn", "Starling"] }
];

// Returns the live ranks array (defaults + custom ranks from config)
function getRanks() {
  const config = loadConfig();
  const custom = config.customRanks || [];
  if (!custom.length) return [...DEFAULT_RANKS];
  // Merge custom ranks into the base array preserving order
  return [...DEFAULT_RANKS, ...custom.filter(r => !DEFAULT_RANKS.includes(r))];
}

// Returns rank categories including any custom ranks placed in the correct tier
function getRankCategories() {
  const config = loadConfig();
  const custom = config.customRanks || [];
  if (!custom.length) return DEFAULT_RANK_CATEGORIES;

  const tierMap = config.customRankTiers || {};
  // tier values: "high" → index 0, "mid" → index 1, "low" → index 2
  const tierIndex = { high: 0, mid: 1, low: 2 };

  const cats = DEFAULT_RANK_CATEGORIES.map(c => ({ label: c.label, ranks: [...c.ranks] }));
  for (const r of custom) {
    const already = cats.some(c => c.ranks.includes(r));
    if (already) continue;
    const tier = tierMap[r] || "mid";
    const idx = tierIndex[tier] ?? 1;
    cats[idx].ranks.push(r);
  }
  return cats;
}

const SYMBOLS = {
  star:    { prefix: "✦・", label: "✦ Stars" },
  sun:     { prefix: "☀・", label: "☀ Suns" },
  moon:    { prefix: "🌙・", label: "🌙 Moons" },
  diamond: { prefix: "◈・", label: "◈ Diamonds" },
  dawn:    { prefix: "🌅・", label: "🌅 Dawn" }
};

// ─── MUSIC QUEUES (per guild) ─────────────────────────────────────────────────
const musicQueues = new Map();

function getQueue(guildId) {
  return musicQueues.get(guildId) || null;
}

async function playNext(guildId, textChannel) {
  const queue = musicQueues.get(guildId);
  if (!queue || queue.songs.length === 0) {
    if (queue?.connection) {
      try { queue.connection.destroy(); } catch {}
      musicQueues.delete(guildId);
    }
    return;
  }

  const song = queue.songs[0];

  // Guard against double-advance: track which song we're advancing from
  let advanced = false;
  function advance() {
    if (advanced) return;
    advanced = true;
    queue.songs.shift();
    playNext(guildId, textChannel);
  }

  try {
    const stream = ytdl(song.url, {
      filter: "audioonly",
      quality: "highestaudio",
      highWaterMark: 1 << 25
    });

    stream.once("error", (err) => {
      console.error("ytdl stream error:", err.message);
      textChannel.send("❌ Stream error, skipping track...").catch(() => {});
      advance();
    });

    const resource = createAudioResource(stream, { inputType: StreamType.Arbitrary });
    queue.player.play(resource);

    // Remove any previous idle listener before adding a new one
    queue.player.removeAllListeners(AudioPlayerStatus.Idle);
    queue.player.once(AudioPlayerStatus.Idle, () => advance());

    textChannel.send({ embeds: [
      new EmbedBuilder()
        .setColor(0xFFD700)
        .setTitle("🎵 Now Playing")
        .setDescription(`**[${song.title}](${song.url})**`)
        .setFooter({ text: `Requested by ${song.requestedBy}` })
    ]});
  } catch (err) {
    console.error("Music error:", err.message);
    textChannel.send("❌ Could not play that track. Skipping...").catch(() => {});
    advance();
  }
}

// ─── GIVEAWAY SYSTEM ─────────────────────────────────────────────────────────
const activeGiveaways = new Map();

function parseDuration(str) {
  const regex = /(\d+)\s*(s|m|h|d)/gi;
  let ms = 0, match;
  while ((match = regex.exec(str)) !== null) {
    const val = parseInt(match[1]);
    switch (match[2].toLowerCase()) {
      case "s": ms += val * 1000; break;
      case "m": ms += val * 60 * 1000; break;
      case "h": ms += val * 60 * 60 * 1000; break;
      case "d": ms += val * 24 * 60 * 60 * 1000; break;
    }
  }
  return ms;
}

function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

async function endGiveaway(client, giveawayId, force = false) {
  const giveaway = activeGiveaways.get(giveawayId);
  if (!giveaway) return;

  clearTimeout(giveaway.timeout);
  activeGiveaways.delete(giveawayId);

  try {
    const channel = await client.channels.fetch(giveaway.channelId);
    const message = await channel.messages.fetch(giveaway.messageId);

    const entries = giveaway.entries;
    const winnerCount = Math.min(giveaway.winnersCount, entries.length);

    const disabledRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`giveaway_enter_${giveawayId}`)
        .setLabel(`${entries.length} entries`)
        .setEmoji("🎉")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true)
    );

    if (entries.length === 0) {
      const endEmbed = new EmbedBuilder()
        .setColor(0x555555)
        .setTitle("🎉 GIVEAWAY ENDED")
        .setDescription(`**Prize:** ${giveaway.prize}\n\nNo one entered.`)
        .setFooter({ text: "No winners" })
        .setTimestamp();
      await message.edit({ embeds: [endEmbed], components: [disabledRow] });
      channel.send("🎉 The giveaway ended but no one entered.");
      return;
    }

    const shuffled = [...entries].sort(() => Math.random() - 0.5);
    const winners = shuffled.slice(0, winnerCount);
    const winnerMentions = winners.map(id => `<@${id}>`).join(", ");

    const endEmbed = new EmbedBuilder()
      .setColor(0xFFD700)
      .setTitle("🎉 GIVEAWAY ENDED")
      .setDescription(`**Prize:** ${giveaway.prize}\n\n🏆 **Winner${winners.length > 1 ? "s" : ""}:** ${winnerMentions}`)
      .addFields({ name: "Total Entries", value: `${entries.length}` })
      .setFooter({ text: "Use /greroll to reroll" })
      .setTimestamp();

    await message.edit({ embeds: [endEmbed], components: [disabledRow] });
    channel.send(`🎉 Congratulations ${winnerMentions}! You won **${giveaway.prize}**!`);

    giveaway.ended = true;
    giveaway.winners = winners;
    activeGiveaways.set(giveawayId + "_ended", giveaway);
  } catch (err) {
    console.error("Giveaway end error:", err);
  }
}

// ─── SLASH COMMANDS ───────────────────────────────────────────────────────────
const commands = [
  // ── Rank management ────────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName("promote")
    .setDescription("Promote a member to the next rank")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addUserOption(o => o.setName("member").setDescription("The member to promote").setRequired(true)),

  new SlashCommandBuilder()
    .setName("trial")
    .setDescription("Log a trial result for a member")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addUserOption(o => o.setName("member").setDescription("The member being trialled").setRequired(true))
    .addStringOption(o =>
      o.setName("result").setDescription("Trial outcome").setRequired(true)
        .addChoices({ name: "✅ Pass", value: "pass" }, { name: "❌ Fail", value: "fail" })
    ),

  new SlashCommandBuilder()
    .setName("ranks")
    .setDescription("Show the Nevaris Order rank ladder"),

  new SlashCommandBuilder()
    .setName("rank")
    .setDescription("Show your current rank (or another member's rank)")
    .addUserOption(o => o.setName("member").setDescription("Member to check (leave empty for yourself)")),

  new SlashCommandBuilder()
    .setName("setrank")
    .setDescription("Set a member's rank directly (type the rank name)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addUserOption(o => o.setName("member").setDescription("The member to update").setRequired(true))
    .addStringOption(o => o.setName("rank").setDescription("The exact rank name to assign").setRequired(true)),

  new SlashCommandBuilder()
    .setName("addrank")
    .setDescription("Add a new custom rank to the Nevaris Order rank system")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(o => o.setName("name").setDescription("Name of the new rank").setRequired(true))
    .addStringOption(o =>
      o.setName("tier").setDescription("Which tier to place this rank in").setRequired(true)
        .addChoices(
          { name: "🔱 High Ranks", value: "high" },
          { name: "⚔️ Mid Ranks",  value: "mid" },
          { name: "🌟 Low Ranks",  value: "low" }
        )
    )
    .addStringOption(o => o.setName("color").setDescription("Role color (hex, e.g. #FF8800)").setRequired(false)),

  new SlashCommandBuilder()
    .setName("removerank")
    .setDescription("Remove a custom rank from the system")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(o => o.setName("name").setDescription("Exact name of the rank to remove").setRequired(true)),

  new SlashCommandBuilder()
    .setName("roster")
    .setDescription("Show a live list of all members by rank tier"),

  new SlashCommandBuilder()
    .setName("setup-roles")
    .setDescription("Automatically create all Nevaris Order rank roles on this server")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  // ── Archive forum ───────────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName("setup-archive")
    .setDescription("Create a clan archive Forum channel with all clan info in separate posts")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName("archive")
    .setDescription("Show a summary of the Nevaris Order clan archive"),

  // ── House system ────────────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName("addhouse")
    .setDescription("Add a new house that members can join")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(o => o.setName("name").setDescription("House name (e.g. House of Dawn)").setRequired(true))
    .addStringOption(o => o.setName("description").setDescription("Short description of the house").setRequired(false))
    .addStringOption(o => o.setName("color").setDescription("Role color hex (e.g. #FFD700)").setRequired(false)),

  new SlashCommandBuilder()
    .setName("removeallhouses")
    .setDescription("Remove all houses from the system (does not delete Discord roles)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName("listhouses")
    .setDescription("List all available houses"),

  new SlashCommandBuilder()
    .setName("house")
    .setDescription("Choose your house in the Nevaris Order"),

  // ── Role tools ──────────────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName("addrole")
    .setDescription("Add a role to one or more members at once")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(o => o.setName("role").setDescription("Exact role name to add").setRequired(true))
    .addUserOption(o => o.setName("member1").setDescription("Member 1").setRequired(true))
    .addUserOption(o => o.setName("member2").setDescription("Member 2 (optional)"))
    .addUserOption(o => o.setName("member3").setDescription("Member 3 (optional)"))
    .addUserOption(o => o.setName("member4").setDescription("Member 4 (optional)"))
    .addUserOption(o => o.setName("member5").setDescription("Member 5 (optional)")),

  new SlashCommandBuilder()
    .setName("removerole")
    .setDescription("Remove a role from one or more members at once")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(o => o.setName("role").setDescription("Exact role name to remove").setRequired(true))
    .addUserOption(o => o.setName("member1").setDescription("Member 1").setRequired(true))
    .addUserOption(o => o.setName("member2").setDescription("Member 2 (optional)"))
    .addUserOption(o => o.setName("member3").setDescription("Member 3 (optional)"))
    .addUserOption(o => o.setName("member4").setDescription("Member 4 (optional)"))
    .addUserOption(o => o.setName("member5").setDescription("Member 5 (optional)")),

  // ── Welcome / guide setup ───────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName("setguide")
    .setDescription("Set which channels new members are directed to in their welcome DM")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addChannelOption(o => o.setName("channel1").setDescription("Channel 1 (required)").setRequired(true).addChannelTypes(ChannelType.GuildText))
    .addChannelOption(o => o.setName("channel2").setDescription("Channel 2 (optional)").addChannelTypes(ChannelType.GuildText))
    .addChannelOption(o => o.setName("channel3").setDescription("Channel 3 (optional)").addChannelTypes(ChannelType.GuildText))
    .addChannelOption(o => o.setName("channel4").setDescription("Channel 4 (optional)").addChannelTypes(ChannelType.GuildText))
    .addChannelOption(o => o.setName("channel5").setDescription("Channel 5 (optional)").addChannelTypes(ChannelType.GuildText)),

  new SlashCommandBuilder()
    .setName("viewguide")
    .setDescription("Preview the welcome DM new members will receive")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName("testguide")
    .setDescription("Send yourself the welcome DM to see how it looks")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName("setlog")
    .setDescription("Set the channel where promotions and trial results are logged")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addChannelOption(o =>
      o.setName("channel").setDescription("The channel to post logs in").setRequired(true)
        .addChannelTypes(ChannelType.GuildText)
    ),

  new SlashCommandBuilder()
    .setName("settrial")
    .setDescription("Set the exact trial steps shown in the welcome DM")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(o =>
      o.setName("steps")
        .setDescription("Your trial steps (use \\n between steps)")
        .setRequired(true)
    ),

  // ── Events ──────────────────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName("event")
    .setDescription("Announce a server event")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(o => o.setName("name").setDescription("Event name").setRequired(true))
    .addUserOption(o => o.setName("host").setDescription("Who is hosting the event").setRequired(true))
    .addStringOption(o => o.setName("description").setDescription("What the event is about").setRequired(false))
    .addStringOption(o => o.setName("time").setDescription("When the event starts (e.g. Friday 8PM EST)").setRequired(false))
    .addStringOption(o => o.setName("type").setDescription("Event type").setRequired(false)
      .addChoices(
        { name: "⚔️ Training",    value: "Training" },
        { name: "🏆 Tournament",  value: "Tournament" },
        { name: "🎉 Social",      value: "Social" },
        { name: "🌅 Ceremony",    value: "Ceremony" },
        { name: "🗡️ Raid",        value: "Raid" },
        { name: "📋 Meeting",     value: "Meeting" },
        { name: "🎵 Music Night", value: "Music Night" },
        { name: "🎁 Giveaway",    value: "Giveaway" },
        { name: "📖 Other",       value: "Other" }
      )
    ),

  // ── Server decoration ───────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName("decorate")
    .setDescription("Add symbols to all channel names")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(o =>
      o.setName("symbol").setDescription("Symbol style to use").setRequired(true)
        .addChoices(
          { name: "✦ Stars",    value: "star" },
          { name: "☀ Suns",     value: "sun" },
          { name: "🌙 Moons",   value: "moon" },
          { name: "◈ Diamonds", value: "diamond" },
          { name: "🌅 Dawn",    value: "dawn" }
        )
    ),

  // ── Music ───────────────────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName("play")
    .setDescription("Play a song in your voice channel")
    .addStringOption(o => o.setName("query").setDescription("Song name or YouTube URL").setRequired(true)),

  new SlashCommandBuilder()
    .setName("stop")
    .setDescription("Stop music and disconnect the bot from voice"),

  new SlashCommandBuilder()
    .setName("skip")
    .setDescription("Skip the current song"),

  new SlashCommandBuilder()
    .setName("queue")
    .setDescription("Show the current music queue"),

  new SlashCommandBuilder()
    .setName("pause")
    .setDescription("Pause the current song"),

  new SlashCommandBuilder()
    .setName("resume")
    .setDescription("Resume the paused song"),

  new SlashCommandBuilder()
    .setName("nowplaying")
    .setDescription("Show what song is currently playing"),

  // ── Giveaways ───────────────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName("giveaway")
    .setDescription("Start a giveaway")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(o => o.setName("prize").setDescription("What are you giving away?").setRequired(true))
    .addStringOption(o => o.setName("duration").setDescription("How long? (e.g. 1h, 30m, 1d)").setRequired(true))
    .addIntegerOption(o => o.setName("winners").setDescription("How many winners? (default: 1)").setMinValue(1).setMaxValue(10)),

  new SlashCommandBuilder()
    .setName("gend")
    .setDescription("End a giveaway early")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(o => o.setName("message_id").setDescription("The giveaway message ID").setRequired(true)),

  new SlashCommandBuilder()
    .setName("greroll")
    .setDescription("Reroll a giveaway winner")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(o => o.setName("message_id").setDescription("The giveaway message ID").setRequired(true)),

  // ── Help ────────────────────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName("help")
    .setDescription("Show all available bot commands")

].map(cmd => cmd.toJSON());

// ─── CLIENT ───────────────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates
  ]
});

// ─── READY ────────────────────────────────────────────────────────────────────
client.once("ready", async () => {
  console.log(`☀ Nevaris Order Bot Online as ${client.user.tag}`);
  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
  for (const guild of client.guilds.cache.values()) {
    try {
      await rest.put(Routes.applicationGuildCommands(client.user.id, guild.id), { body: commands });
      console.log(`✅ Slash commands registered in: ${guild.name}`);
    } catch (err) {
      console.error(`❌ Failed in ${guild.name}:`, err.message);
    }
  }
});

// ─── BUILD WELCOME DM ─────────────────────────────────────────────────────────
function buildWelcomeDM(member, channelIds, guild, config = {}) {
  const channelLines = channelIds
    .map(id => {
      const ch = guild.channels.cache.get(id);
      return ch ? `• <#${id}> — ${ch.name.replace(/^[^a-zA-Z0-9]+/, "").replace(/-/g, " ")}` : null;
    }).filter(Boolean);

  const embed = new EmbedBuilder()
    .setColor(0xFFD700)
    .setTitle(`☀ Welcome to the Nevaris Order, ${member.user.username}! ☀`)
    .setDescription(`*"From the First Dawn, We Rise."*\n\nYou have taken your first step into the Order. You begin your journey as a **Starling** — the first light before the dawn.`)
    .addFields({ name: "📋 Your Rank Path", value: "Starling → Dawnsworn → Celestial Knight → Horizon Warden → and beyond...\n\nUse `/ranks` in the server to see the full ladder." });

  if (channelLines.length > 0)
    embed.addFields({ name: "📌 Start Here — Check These Channels", value: channelLines.join("\n") });

  embed.addFields(
    { name: "⚔️ How to Rise", value: "• Attend trainings and events\n• Complete the Trial of Dawn\n• Speak with a Horizon Warden to begin your trial" },
    {
      name: "📋 Trial System — How It Works",
      value: [
        "Trials are how you advance through the ranks of the Order.",
        "",
        "**1.** Request a trial from a **Horizon Warden** or above.",
        "**2.** Complete the trial they set for you.",
        "**3.** Your judge will log the result using the trial command.",
        "",
        "If you **pass** → you are promoted to the next rank automatically.",
        "If you **fail** → train harder and request a re-trial when ready.",
        "",
        "*(Trial judges use `/trial @you pass` or `/trial @you fail` to record the result.)*"
      ].join("\n")
    },
    ...(config.trialProcedure ? [{ name: "📜 Trial Procedure", value: config.trialProcedure.replace(/\\n/g, "\n") }] : []),
    { name: "🗡️ Dawnborn — Special Unit", value: "The Order's elite division. Members are hand-picked by High Ranks for exceptional skill and dedication. There is no application — you are chosen. Look for the ⚡ role." },
    { name: "📖 Learn More", value: "Use `/archive` in the server to read the full clan history, rank descriptions, lore of the Order, and how the trial and special unit systems work." },
    { name: "❓ Questions?", value: "Reach out to any Mid or High Rank member — they are here to guide you." }
  )
  .setFooter({ text: `${guild.name} • The Order watches over you.` })
  .setTimestamp();

  return embed;
}

// ─── LOG HELPER ───────────────────────────────────────────────────────────────
async function postLog(guild, embed) {
  const config = loadConfig();
  if (!config.logChannelId) return;
  const ch = guild.channels.cache.get(config.logChannelId);
  if (ch) ch.send({ embeds: [embed] });
}

// ─── WELCOME NEW MEMBERS ──────────────────────────────────────────────────────
client.on("guildMemberAdd", async (member) => {
  const welcomeChannel = member.guild.channels.cache.find(
    c => c.name.toLowerCase().includes("welcome") && c.type === ChannelType.GuildText
  );
  if (welcomeChannel) {
    welcomeChannel.send({ embeds: [
      new EmbedBuilder()
        .setColor(0xFFD700)
        .setTitle("☀ A New Warrior Joins the Dawn ☀")
        .setDescription(`Welcome ${member} to the **Nevaris Order**!\n\n*"From the First Dawn, We Rise."*\n\nYou begin your journey as a **Starling**. Check your DMs for your guide.`)
        .setFooter({ text: "⚔ Your path to greatness begins now." })
    ]});
  }

  const config = loadConfig();
  if (!config.guideEnabled || !config.guideChannels?.length) return;
  try {
    const dmEmbed = buildWelcomeDM(member, config.guideChannels, member.guild, config);
    await member.send({ embeds: [dmEmbed] });
    console.log(`📨 Welcome DM sent to ${member.user.tag}`);
  } catch {
    console.log(`⚠️ Could not DM ${member.user.tag}`);
  }
});

// ─── ARCHIVE POSTS CONTENT ────────────────────────────────────────────────────
const ARCHIVE_POSTS = [
  {
    name: "📜 The Origin — Lore of the Order",
    content: [
      "# 📜 The Origin — Lore of the Nevaris Order",
      "",
      "*\"From the First Dawn, We Rise.\"*",
      "",
      "Long before the first wars, a group of wanderers saw a light on the horizon — not of sun or moon, but of something older. They called it the **First Dawn**.",
      "",
      "Those who witnessed it did not speak of power or conquest. They spoke of **purpose**. They bound themselves together under a single oath:",
      "",
      "> *\"We do not fight for glory. We fight so the Dawn never fades.\"*",
      "",
      "From that oath, the **Nevaris Order** was born.",
      "",
      "The Order has endured countless trials since its founding. Warriors have risen and fallen. Alliances have been forged and tested. But the oath has never broken.",
      "",
      "Every Starling who joins today walks the same path those first wanderers walked — from the first light of dawn to the full blaze of the sun."
    ].join("\n")
  },
  {
    name: "🏅 Rank Descriptions",
    content: [
      "# 🏅 Rank Descriptions — Nevaris Order",
      "",
      "## 🔱 High Ranks",
      "",
      "**Luminary of Nevaris**",
      "The supreme voice of the Order. Commands all others. Chosen through deeds, not appointment.",
      "",
      "**Astral Regent**",
      "Commander of the High Council. Governs the Order in times of war and ceremony.",
      "",
      "**Dawnseer**",
      "Keeper of lore, oaths, and the Order's history. Remembers what others forget.",
      "",
      "**⚡ Dawnborn** *(Special Unit)*",
      "The Order's elite division. Invitation only. Members are hand-picked for exceptional skill and dedication. There is no application.",
      "",
      "## ⚔️ Mid Ranks",
      "",
      "**Zenith Vanguard**",
      "Elite warriors proven across multiple trials. Trusted with leadership in the field.",
      "",
      "**Horizon Warden**",
      "Seasoned members who oversee trials. The backbone of the Order's authority.",
      "",
      "**Celestial Knight**",
      "Fully initiated members who have sworn the deep oath. Respected by all.",
      "",
      "## 🌟 Low Ranks",
      "",
      "**Dawnsworn**",
      "Warriors who have passed their first trial. The oath has been spoken.",
      "",
      "**Starling**",
      "New recruits stepping into the light. Every Luminary was once a Starling."
    ].join("\n")
  },
  {
    name: "⚔️ Trial System",
    content: [
      "# ⚔️ Trial System — How It Works",
      "",
      "Trials are how warriors of the Nevaris Order prove themselves and advance through the ranks.",
      "",
      "## How to Take a Trial",
      "",
      "1. **Request a trial** from a **Horizon Warden** or above.",
      "2. **Complete the trial** they set for you.",
      "3. Your judge will log the result using `/trial`.",
      "",
      "## Outcomes",
      "",
      "- **Pass** → You are promoted to the next rank. Old rank role is removed automatically.",
      "- **Fail** → Train harder. Re-trials may be requested after improvement.",
      "",
      "## Commands (Admin Only)",
      "",
      "```",
      "/trial @member pass  — promotes member to next rank",
      "/trial @member fail  — logs a failed trial",
      "```",
      "",
      "## Rules",
      "",
      "- Only Horizon Wardens and above may judge trials.",
      "- Trials must be fair and consistent with the Order's standards.",
      "- Re-trials are at the judge's discretion.",
      "- Results are logged to the designated log channel."
    ].join("\n")
  },
  {
    name: "⬆️ Promotion System",
    content: [
      "# ⬆️ Promotion System",
      "",
      "Promotions in the Nevaris Order are granted by Administrators and reflect a member's growth, dedication, and merit.",
      "",
      "## Commands",
      "",
      "```",
      "/promote @member      — promotes to the next rank (removes old rank role)",
      "/setrank @member rank  — sets a rank directly, removes all previous rank roles",
      "/addrank name tier    — adds a new custom rank to the system",
      "```",
      "",
      "## Process",
      "",
      "1. The administrator uses `/promote` or `/setrank`.",
      "2. The bot removes the member's previous rank role.",
      "3. The bot assigns the new rank role.",
      "4. The action is logged to the log channel.",
      "",
      "## Notes",
      "",
      "- The bot's role **must be placed above all rank roles** in Server Settings → Roles.",
      "- If a role is missing, run `/setup-roles` to create all default roles.",
      "- Custom ranks can be added with `/addrank` and removed with `/removerank`."
    ].join("\n")
  },
  {
    name: "🗡️ Dawnborn — Special Unit",
    content: [
      "# 🗡️ Dawnborn — Special Unit",
      "",
      "The **⚡ Dawnborn** are the Order's elite division.",
      "",
      "## What is the Dawnborn?",
      "",
      "The Dawnborn are not a rank — they are a designation. Members of any rank may be inducted if they demonstrate exceptional skill, loyalty, and dedication to the Order.",
      "",
      "## How Are Members Chosen?",
      "",
      "There is **no application process**. Dawnborn are hand-picked by High Ranks.",
      "",
      "Being selected means you have been watched. Your actions spoke before your name.",
      "",
      "## Responsibilities",
      "",
      "- Represent the Order at the highest standard.",
      "- Assist in training sessions and events.",
      "- Act as a model for lower-ranked members.",
      "",
      "## Recognition",
      "",
      "Dawnborn members receive the **⚡ Dawnborn** role and are listed separately in `/roster`.",
      "",
      "*\"Not all who are strong are chosen. Not all who are chosen are strong. The Dawnborn are both.\"*"
    ].join("\n")
  },
  {
    name: "🏠 House System",
    content: [
      "# 🏠 House System",
      "",
      "The House System allows members to belong to a house within the Nevaris Order.",
      "",
      "## Choosing Your House",
      "",
      "Use `/house` to see all available houses and select one from the dropdown menu.",
      "",
      "Your house role will be assigned automatically.",
      "",
      "## For Admins",
      "",
      "```",
      "/addhouse name [description] [color]  — create a new house",
      "/removeallhouses                       — clear all houses from the system",
      "/listhouses                            — see all configured houses",
      "```",
      "",
      "## Notes",
      "",
      "- Members can switch houses at any time using `/house`.",
      "- Switching removes the old house role before assigning the new one.",
      "- Houses are configured per-bot, not per-server (config.json)."
    ].join("\n")
  },
  {
    name: "📋 Bot Commands Reference",
    content: [
      "# 📋 Bot Commands Reference",
      "",
      "## 🏅 Rank Commands",
      "| Command | Description |",
      "|---|---|",
      "| `/promote @member` | Promote a member to the next rank |",
      "| `/trial @member pass/fail` | Log a trial result |",
      "| `/setrank @member rank` | Set a rank directly |",
      "| `/addrank name tier` | Add a new custom rank |",
      "| `/removerank name` | Remove a custom rank |",
      "| `/ranks` | Show the full rank ladder |",
      "| `/rank [@member]` | Show a member's current rank |",
      "| `/roster` | Live list of all members by rank |",
      "| `/setup-roles` | Create all rank roles on the server |",
      "",
      "## 🏠 House Commands",
      "| Command | Description |",
      "|---|---|",
      "| `/house` | Choose your house |",
      "| `/addhouse name` | Add a new house (admin) |",
      "| `/listhouses` | List all houses |",
      "| `/removeallhouses` | Remove all houses (admin) |",
      "",
      "## 👥 Role Commands",
      "| Command | Description |",
      "|---|---|",
      "| `/addrole role @member1...` | Add a role to up to 5 members |",
      "| `/removerole role @member1...` | Remove a role from up to 5 members |",
      "",
      "## 🎵 Music Commands",
      "| Command | Description |",
      "|---|---|",
      "| `/play query` | Play a song by name or YouTube URL |",
      "| `/stop` | Stop and disconnect |",
      "| `/skip` | Skip current song |",
      "| `/queue` | Show the queue |",
      "| `/pause` | Pause playback |",
      "| `/resume` | Resume playback |",
      "| `/nowplaying` | Show current song |",
      "",
      "## 🎉 Giveaway Commands",
      "| Command | Description |",
      "|---|---|",
      "| `/giveaway prize duration [winners]` | Start a giveaway |",
      "| `/gend message_id` | End a giveaway early |",
      "| `/greroll message_id` | Reroll a winner |",
      "",
      "## 📣 Event & Server",
      "| Command | Description |",
      "|---|---|",
      "| `/event name host [...]` | Announce a server event |",
      "| `/decorate symbol` | Add symbols to channel names |",
      "| `/setup-archive` | Create the archive Forum channel |",
      "",
      "## ✉️ Welcome & Setup",
      "| Command | Description |",
      "|---|---|",
      "| `/setguide #ch1 ...` | Set welcome DM guide channels |",
      "| `/settrial steps` | Set trial procedure text |",
      "| `/testguide` | Send yourself the welcome DM |",
      "| `/viewguide` | Preview current guide config |",
      "| `/setlog #channel` | Set the log channel |"
    ].join("\n")
  }
];

// ─── INTERACTION HANDLER ──────────────────────────────────────────────────────
client.on("interactionCreate", async (interaction) => {

  // ── Giveaway button ────────────────────────────────────────────────────────
  if (interaction.isButton() && interaction.customId.startsWith("giveaway_enter_")) {
    const giveawayId = interaction.customId.replace("giveaway_enter_", "");
    const giveaway = activeGiveaways.get(giveawayId);
    if (!giveaway) return interaction.reply({ content: "This giveaway has ended.", ephemeral: true });

    if (giveaway.entries.includes(interaction.user.id)) {
      return interaction.reply({ content: "You have already entered this giveaway!", ephemeral: true });
    }

    giveaway.entries.push(interaction.user.id);
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`giveaway_enter_${giveawayId}`)
        .setLabel(`${giveaway.entries.length} entries`)
        .setEmoji("🎉")
        .setStyle(ButtonStyle.Success)
    );
    await interaction.update({ components: [row] });
    return;
  }

  // ── House select menu ──────────────────────────────────────────────────────
  if (interaction.isStringSelectMenu() && interaction.customId === "house_select") {
    await interaction.deferReply({ ephemeral: true });
    const selected = interaction.values[0]; // house name
    const config = loadConfig();
    const house = config.houses?.find(h => h.name === selected);
    if (!house) return interaction.editReply("❌ That house no longer exists. Use `/listhouses` to see current options.");

    const member = interaction.member;

    // Remove any other house roles
    for (const h of config.houses) {
      if (h.name !== selected && h.roleId) {
        const oldRole = interaction.guild.roles.cache.get(h.roleId);
        if (oldRole && member.roles.cache.has(oldRole.id)) {
          try { await member.roles.remove(oldRole); } catch {}
        }
      }
    }

    // Assign new house role
    let houseRole = house.roleId ? interaction.guild.roles.cache.get(house.roleId) : null;
    if (!houseRole) {
      houseRole = interaction.guild.roles.cache.find(r => r.name === house.name);
    }

    if (!houseRole) {
      return interaction.editReply(`❌ The role for **${house.name}** could not be found. Ask an admin to run \`/addhouse\` again.`);
    }

    try {
      await member.roles.add(houseRole);
      interaction.editReply({ embeds: [
        new EmbedBuilder()
          .setColor(house.color ? parseInt(house.color.replace("#",""), 16) : 0xFFD700)
          .setTitle(`🏠 Welcome to ${house.name}!`)
          .setDescription(house.description ? `*${house.description}*\n\nYour house role has been assigned.` : "Your house role has been assigned.")
          .setFooter({ text: "You can change your house at any time with /house" })
      ]});
    } catch (err) {
      interaction.editReply(`❌ Could not assign the role: ${err.message}`);
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;
  const { commandName } = interaction;

  // ── /promote ───────────────────────────────────────────────────────────────
  if (commandName === "promote") {
    await interaction.deferReply();
    try {
      const ranks = getRanks();
      const target = await interaction.guild.members.fetch(interaction.options.getUser("member").id);
      if (!target) return interaction.editReply("❌ Member not found.");

      const currentIdx = ranks.findIndex(r => target.roles.cache.some(role => role.name === r));
      const nextRank = currentIdx === -1 ? ranks[0] : ranks[currentIdx + 1];
      if (!nextRank) return interaction.editReply("⚠️ This warrior has already reached the highest rank.");

      const role = interaction.guild.roles.cache.find(r => r.name === nextRank);
      if (!role) return interaction.editReply(`❌ Role **${nextRank}** not found.\n\n• Make sure the role exists with that exact name\n• Drag the bot's role **above** all clan ranks in Server Settings → Roles`);

      await target.roles.add(role);
      const oldRankName = currentIdx >= 0 ? ranks[currentIdx] : null;
      if (oldRankName) {
        const oldRole = interaction.guild.roles.cache.find(r => r.name === oldRankName);
        if (oldRole && target.roles.cache.has(oldRole.id)) await target.roles.remove(oldRole);
      }

      const rankCategories = getRankCategories();
      const prevTier = rankCategories.find(c => c.ranks.includes(oldRankName))?.label ?? "";
      const newTier  = rankCategories.find(c => c.ranks.includes(nextRank))?.label ?? "";
      const tierMsg  = prevTier && newTier && prevTier !== newTier ? `\n\n✦ *Tier advancement: ${prevTier} → ${newTier}*` : "";

      interaction.editReply({ embeds: [
        new EmbedBuilder().setColor(0xFFD700).setTitle("⭐ PROMOTION COMPLETE ⭐")
          .setDescription(`${target} has ascended to **${nextRank}**\n\n☀ *"The Dawn acknowledges your growth."*${tierMsg}`)
      ]});

      await postLog(interaction.guild, new EmbedBuilder().setColor(0xFFD700).setTitle("⭐ Promotion Logged")
        .addFields(
          { name: "Member", value: `${target} (${target.user.tag})`, inline: true },
          { name: "New Rank", value: nextRank, inline: true },
          { name: "Promoted By", value: interaction.user.tag, inline: true }
        ).setTimestamp()
      );
    } catch (err) {
      console.error("Promote error:", err);
      interaction.editReply(`❌ Promotion failed: **${err.message}**\n\n• Go to Server Settings → Roles and drag the bot's role **above** all clan rank roles\n• Make sure the bot has the **Manage Roles** permission`);
    }
  }

  // ── /trial ─────────────────────────────────────────────────────────────────
  else if (commandName === "trial") {
    await interaction.deferReply();
    const ranks = getRanks();
    const target = interaction.options.getMember("member");
    const result = interaction.options.getString("result");
    if (!target) return interaction.editReply("❌ Member not found.");

    if (result === "pass") {
      let idx = ranks.findIndex(r => target.roles.cache.some(role => role.name === r));
      if (idx === -1) idx = 0;
      const nextRank = ranks[idx + 1];
      if (!nextRank) return interaction.editReply("⚠️ This warrior has reached the final rank.");
      const role = interaction.guild.roles.cache.find(r => r.name === nextRank);
      if (!role) return interaction.editReply(`❌ Role **${nextRank}** not found on this server.`);
      await target.roles.add(role);
      interaction.editReply({ embeds: [
        new EmbedBuilder().setColor(0x00FF88).setTitle("☀ TRIAL COMPLETE — PASSED ☀")
          .setDescription(`${target} has **PASSED** their trial and advanced to **${nextRank}**\n\n*"The stars have judged you worthy."*`)
      ]});
      await postLog(interaction.guild, new EmbedBuilder().setColor(0x00FF88).setTitle("✅ Trial Passed")
        .addFields(
          { name: "Member", value: `${target} (${target.user.tag})`, inline: true },
          { name: "New Rank", value: nextRank, inline: true },
          { name: "Judge", value: interaction.user.tag, inline: true }
        ).setTimestamp()
      );
    } else {
      interaction.editReply({ embeds: [
        new EmbedBuilder().setColor(0x8B0000).setTitle("🌑 TRIAL FAILED")
          .setDescription(`${target} must train further before attempting ascension again.\n\n*"Even the brightest stars must endure darkness to grow."*`)
      ]});
      await postLog(interaction.guild, new EmbedBuilder().setColor(0x8B0000).setTitle("❌ Trial Failed")
        .addFields(
          { name: "Member", value: `${target} (${target.user.tag})`, inline: true },
          { name: "Judge", value: interaction.user.tag, inline: true }
        ).setTimestamp()
      );
    }
  }

  // ── /ranks ────────────────────────────────────────────────────────────────
  else if (commandName === "ranks") {
    const rankCategories = getRankCategories();
    const embed = new EmbedBuilder().setColor(0xFFD700).setTitle("🌠 NEVARIS ORDER — RANK LADDER")
      .setFooter({ text: '"From the First Dawn, We Rise."' });
    for (const cat of rankCategories) {
      embed.addFields({ name: cat.label, value: cat.ranks.map(r =>
        r === "⚡ Dawnborn" ? `• ${r} — *Special Unit, invitation only*` : `• ${r}`
      ).join("\n") });
    }
    interaction.reply({ embeds: [embed] });
  }

  // ── /rank ─────────────────────────────────────────────────────────────────
  else if (commandName === "rank") {
    await interaction.deferReply();
    const ranks = getRanks();
    const rankCategories = getRankCategories();
    const targetUser = interaction.options.getUser("member") || interaction.user;
    const member = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
    if (!member) return interaction.editReply("❌ Member not found.");

    const currentRank = ranks.find(r => member.roles.cache.some(role => role.name === r));
    const hasDawnborn  = member.roles.cache.some(r => r.name === "⚡ Dawnborn");
    const tier         = rankCategories.find(c => c.ranks.includes(currentRank))?.label ?? "";

    const embed = new EmbedBuilder()
      .setColor(0xFFD700)
      .setTitle(`☀ ${targetUser.username}'s Rank`)
      .setThumbnail(targetUser.displayAvatarURL({ dynamic: true }));

    if (!currentRank) {
      embed.setDescription(`${member} has no rank role yet.\n\nAn admin can use \`/promote\` or \`/setrank\` to assign one.`);
    } else {
      const rankIdx  = ranks.indexOf(currentRank);
      const nextRank = ranks[rankIdx + 1];
      const prevRank = ranks[rankIdx - 1];
      embed.setDescription(`${member} is currently ranked as **${currentRank}**${hasDawnborn ? "\n\n🗡️ Also a member of the **⚡ Dawnborn** special unit." : ""}`)
        .addFields(
          { name: "🏅 Current Rank", value: currentRank, inline: true },
          { name: "📊 Tier",         value: tier || "—", inline: true },
          { name: "📈 Progress",     value: nextRank ? `${currentRank} → **${nextRank}**` : "🔱 *Maximum rank reached*", inline: true }
        );
      if (prevRank) embed.addFields({ name: "⬇️ Previous Rank", value: prevRank, inline: true });
    }
    embed.setFooter({ text: "Nevaris Order • From the First Dawn, We Rise." }).setTimestamp();
    interaction.editReply({ embeds: [embed] });
  }

  // ── /setrank ───────────────────────────────────────────────────────────────
  else if (commandName === "setrank") {
    await interaction.deferReply();
    const ranks = getRanks();
    const rankCategories = getRankCategories();
    const target = interaction.options.getMember("member");
    const newRank = interaction.options.getString("rank");
    if (!target) return interaction.editReply("❌ Member not found.");

    // Accept any known rank (default or custom)
    const allKnownRanks = [...ranks, "⚡ Dawnborn"];
    const matched = allKnownRanks.find(r => r.toLowerCase() === newRank.toLowerCase());
    if (!matched) return interaction.editReply(`❌ Rank **${newRank}** not found.\n\nAvailable ranks: ${ranks.join(", ")}\n\nUse \`/addrank\` to create a new rank first.`);

    const newRole = interaction.guild.roles.cache.find(r => r.name === matched);
    if (!newRole) return interaction.editReply(`❌ Discord role **${matched}** not found. Run \`/setup-roles\` first.`);

    const toRemove = target.roles.cache.filter(r => ranks.includes(r.name));
    for (const [, r] of toRemove) await target.roles.remove(r);
    await target.roles.add(newRole);

    const tier = rankCategories.find(c => c.ranks.includes(matched))?.label ?? "";
    interaction.editReply({ embeds: [
      new EmbedBuilder().setColor(0x00BFFF).setTitle("🔄 Rank Updated")
        .setDescription(`${target} has been set to **${matched}**${tier ? ` *(${tier})*` : ""}\n\nAll previous rank roles have been removed.`)
    ]});
    await postLog(interaction.guild, new EmbedBuilder().setColor(0x00BFFF).setTitle("🔄 Rank Set Manually")
      .addFields(
        { name: "Member", value: `${target} (${target.user.tag})`, inline: true },
        { name: "New Rank", value: matched, inline: true },
        { name: "Set By", value: interaction.user.tag, inline: true }
      ).setTimestamp()
    );
  }

  // ── /addrank ───────────────────────────────────────────────────────────────
  else if (commandName === "addrank") {
    await interaction.deferReply({ ephemeral: true });
    const rankName = interaction.options.getString("name").trim();
    const tier = interaction.options.getString("tier");
    const colorHex = interaction.options.getString("color") || null;

    const config = loadConfig();
    config.customRanks = config.customRanks || [];

    const allRanks = [...DEFAULT_RANKS, ...config.customRanks];
    if (allRanks.some(r => r.toLowerCase() === rankName.toLowerCase())) {
      return interaction.editReply(`❌ A rank named **${rankName}** already exists.`);
    }

    // Determine color
    let roleColor = 0x99aabb;
    if (colorHex) {
      const parsed = parseInt(colorHex.replace("#",""), 16);
      if (!isNaN(parsed)) roleColor = parsed;
    }

    // Create the Discord role
    let createdRole = null;
    try {
      createdRole = await interaction.guild.roles.create({
        name: rankName,
        color: roleColor,
        reason: `Nevaris Order — /addrank by ${interaction.user.tag}`
      });
    } catch (err) {
      return interaction.editReply(`❌ Could not create the role: ${err.message}\n\nMake sure the bot has **Manage Roles** permission.`);
    }

    // Save to config with tier info
    config.customRanks.push(rankName);
    // Store tier mapping
    config.customRankTiers = config.customRankTiers || {};
    config.customRankTiers[rankName] = tier;
    saveConfig(config);

    const tierLabel = { high: "🔱 High Ranks", mid: "⚔️ Mid Ranks", low: "🌟 Low Ranks" }[tier];
    interaction.editReply({ embeds: [
      new EmbedBuilder().setColor(roleColor).setTitle("✅ Rank Added!")
        .addFields(
          { name: "Rank Name", value: rankName, inline: true },
          { name: "Tier",      value: tierLabel, inline: true },
          { name: "Role",      value: `<@&${createdRole.id}>`, inline: true }
        )
        .setDescription("The rank has been added to the system and the role has been created.\n\nUse `/ranks` to see the updated ladder.")
    ]});
  }

  // ── /removerank ────────────────────────────────────────────────────────────
  else if (commandName === "removerank") {
    await interaction.deferReply({ ephemeral: true });
    const rankName = interaction.options.getString("name").trim();

    if (DEFAULT_RANKS.includes(rankName)) {
      return interaction.editReply(`❌ **${rankName}** is a default rank and cannot be removed.`);
    }

    const config = loadConfig();
    config.customRanks = config.customRanks || [];
    const idx = config.customRanks.findIndex(r => r.toLowerCase() === rankName.toLowerCase());
    if (idx === -1) return interaction.editReply(`❌ Custom rank **${rankName}** not found.\n\nOnly custom ranks can be removed. Default ranks are permanent.`);

    const actualName = config.customRanks[idx];
    config.customRanks.splice(idx, 1);
    if (config.customRankTiers) delete config.customRankTiers[actualName];
    saveConfig(config);

    interaction.editReply({ embeds: [
      new EmbedBuilder().setColor(0xFF6B6B).setTitle("🗑️ Rank Removed")
        .setDescription(`**${actualName}** has been removed from the rank system.\n\nNote: The Discord role was **not** deleted. You can remove it manually if needed.`)
    ]});
  }

  // ── /roster ────────────────────────────────────────────────────────────────
  else if (commandName === "roster") {
    await interaction.deferReply();
    const rankCategories = getRankCategories();
    await interaction.guild.members.fetch();
    const embed = new EmbedBuilder().setColor(0x4169E1).setTitle("📋 NEVARIS ORDER — LIVE ROSTER")
      .setFooter({ text: `Last updated • ${new Date().toUTCString()}` });
    for (const cat of rankCategories) {
      const lines = [];
      for (const rankName of cat.ranks) {
        if (rankName === "⚡ Dawnborn") continue;
        const role = interaction.guild.roles.cache.find(r => r.name === rankName);
        if (!role) { lines.push(`*${rankName} — role not found*`); continue; }
        const members = role.members.map(m => m.toString());
        lines.push(members.length === 0 ? `**${rankName}** — *vacant*` : `**${rankName}** (${members.length})\n${members.join(", ")}`);
      }
      if (lines.length) embed.addFields({ name: cat.label, value: lines.join("\n") });
    }
    const dbRole = interaction.guild.roles.cache.find(r => r.name === "⚡ Dawnborn");
    embed.addFields({
      name: "🗡️ Special Unit — ⚡ Dawnborn",
      value: dbRole ? (dbRole.members.size > 0 ? dbRole.members.map(m => m.toString()).join(", ") : "*No members currently inducted*") : "*Role not found — create a role named `⚡ Dawnborn`*"
    });
    interaction.editReply({ embeds: [embed] });
  }

  // ── /setup-roles ───────────────────────────────────────────────────────────
  else if (commandName === "setup-roles") {
    await interaction.deferReply({ ephemeral: true });
    const ranks = getRanks();

    const roleColors = {
      "Starling":            0xaaaaaa,
      "Dawnsworn":           0x88aaff,
      "Celestial Knight":    0x5599ff,
      "Horizon Warden":      0x22ccaa,
      "Zenith Vanguard":     0x44ddff,
      "Dawnseer":            0xffcc00,
      "Astral Regent":       0xff8800,
      "Luminary of Nevaris": 0xff4444,
      "⚡ Dawnborn":         0xffd700
    };

    const allRoles = [...ranks, "⚡ Dawnborn"];
    const created = [], existing = [], failed = [];

    for (const rankName of allRoles) {
      const exists = interaction.guild.roles.cache.find(r => r.name === rankName);
      if (exists) { existing.push(rankName); continue; }
      try {
        await interaction.guild.roles.create({
          name: rankName,
          color: roleColors[rankName] || 0x99aabb,
          reason: "Nevaris Order — /setup-roles"
        });
        created.push(rankName);
        await new Promise(r => setTimeout(r, 500));
      } catch (err) {
        failed.push(`${rankName} (${err.message})`);
      }
    }

    const lines = [];
    if (created.length)  lines.push(`✅ **Created (${created.length}):**\n${created.map(r => `• ${r}`).join("\n")}`);
    if (existing.length) lines.push(`⏭️ **Already existed (${existing.length}):**\n${existing.map(r => `• ${r}`).join("\n")}`);
    if (failed.length)   lines.push(`❌ **Failed (${failed.length}):**\n${failed.map(r => `• ${r}`).join("\n")}`);

    interaction.editReply({ embeds: [
      new EmbedBuilder()
        .setColor(created.length ? 0x00FF88 : 0x555555)
        .setTitle("⚙️ Role Setup Complete")
        .setDescription(lines.join("\n\n") || "Nothing to do.")
        .setFooter({ text: "Drag the bot's role ABOVE all rank roles in Server Settings → Roles so it can assign them." })
    ]});
  }

  // ── /setup-archive ─────────────────────────────────────────────────────────
  else if (commandName === "setup-archive") {
    await interaction.deferReply({ ephemeral: true });
    try {
      // Create the forum channel
      const forumChannel = await interaction.guild.channels.create({
        name: "📜clan-archive",
        type: ChannelType.GuildForum,
        topic: "The complete Nevaris Order clan archive — lore, ranks, rules, and history.",
        reason: "Nevaris Order — /setup-archive"
      });

      await interaction.editReply(`⏳ Creating archive forum channel and posting all ${ARCHIVE_POSTS.length} threads...`);

      const created = [];
      for (const post of ARCHIVE_POSTS) {
        try {
          // Discord forum posts (threads) have a 2000 char limit per message
          // Split into chunks if needed
          const chunks = [];
          let remaining = post.content;
          while (remaining.length > 0) {
            chunks.push(remaining.slice(0, 1900));
            remaining = remaining.slice(1900);
          }

          const thread = await forumChannel.threads.create({
            name: post.name,
            message: { content: chunks[0] }
          });

          // Post additional chunks as follow-up messages in the thread
          for (let i = 1; i < chunks.length; i++) {
            await thread.send(chunks[i]);
          }

          created.push(`✅ ${post.name}`);
          await new Promise(r => setTimeout(r, 1000)); // rate limit safety
        } catch (err) {
          created.push(`❌ ${post.name} (${err.message})`);
        }
      }

      interaction.editReply({ embeds: [
        new EmbedBuilder()
          .setColor(0x4169E1)
          .setTitle("📜 Archive Forum Created!")
          .setDescription(`<#${forumChannel.id}> has been set up with the following posts:\n\n${created.join("\n")}`)
          .setFooter({ text: "You can edit any thread to customise the content." })
      ]});
    } catch (err) {
      console.error("setup-archive error:", err);
      interaction.editReply(`❌ Failed to create the archive forum: **${err.message}**\n\nMake sure the bot has **Manage Channels** permission.`);
    }
  }

  // ── /archive ───────────────────────────────────────────────────────────────
  else if (commandName === "archive") {
    interaction.reply({ embeds: [
      new EmbedBuilder().setColor(0x4169E1).setTitle("📜 NEVARIS ORDER — CLAN ARCHIVE")
        .setDescription('*"From the First Dawn, We Rise."*\n\nFounded in the light of the First Dawn, the Nevaris Order stands as a brotherhood of warriors, seers, and guardians. Bound by oath, forged through trial, and guided by the stars — every member walks a path from Starling to Luminary.\n\nFor the full archive, ask an admin to run `/setup-archive` to create the clan archive forum channel.')
        .addFields(
          { name: "🔱 High Ranks", value: "**Luminary of Nevaris** — Supreme voice.\n**Astral Regent** — Commander of the High Council.\n**Dawnseer** — Keeper of lore.\n**⚡ Dawnborn** — Elite special unit, invitation only." },
          { name: "⚔️ Mid Ranks", value: "**Zenith Vanguard** — Elite proven warriors.\n**Horizon Warden** — Seasoned trial overseers.\n**Celestial Knight** — Fully initiated members." },
          { name: "🌟 Low Ranks", value: "**Dawnsworn** — Warriors who have passed their first trial.\n**Starling** — New recruits stepping into the light." },
          { name: "📋 Key Commands", value: "`/ranks` `/rank` `/roster` `/house` `/archive` `/help`" }
        )
        .setFooter({ text: "Nevaris Order Bot • Always watching." })
    ]});
  }

  // ── /addhouse ──────────────────────────────────────────────────────────────
  else if (commandName === "addhouse") {
    await interaction.deferReply({ ephemeral: true });
    const houseName = interaction.options.getString("name").trim();
    const description = interaction.options.getString("description") || "";
    const colorHex = interaction.options.getString("color") || null;

    const config = loadConfig();
    config.houses = config.houses || [];

    if (config.houses.some(h => h.name.toLowerCase() === houseName.toLowerCase())) {
      return interaction.editReply(`❌ A house named **${houseName}** already exists.`);
    }

    let roleColor = 0x99aabb;
    if (colorHex) {
      const parsed = parseInt(colorHex.replace("#",""), 16);
      if (!isNaN(parsed)) roleColor = parsed;
    }

    // Create role for the house
    let createdRole = null;
    try {
      createdRole = await interaction.guild.roles.create({
        name: houseName,
        color: roleColor,
        reason: `Nevaris Order — House created by ${interaction.user.tag}`
      });
    } catch (err) {
      return interaction.editReply(`❌ Could not create the role: ${err.message}`);
    }

    config.houses.push({
      name: houseName,
      description,
      color: colorHex || null,
      roleId: createdRole.id
    });
    saveConfig(config);

    interaction.editReply({ embeds: [
      new EmbedBuilder().setColor(roleColor).setTitle("🏠 House Created!")
        .addFields(
          { name: "House Name",  value: houseName,          inline: true },
          { name: "Role",        value: `<@&${createdRole.id}>`, inline: true }
        )
        .setDescription(`${description ? `*${description}*\n\n` : ""}Members can now join this house with \`/house\`.`)
    ]});
  }

  // ── /removeallhouses ───────────────────────────────────────────────────────
  else if (commandName === "removeallhouses") {
    const config = loadConfig();
    const count = config.houses?.length || 0;
    config.houses = [];
    saveConfig(config);
    interaction.reply({ embeds: [
      new EmbedBuilder().setColor(0xFF6B6B).setTitle("🗑️ Houses Cleared")
        .setDescription(`All **${count}** house(s) have been removed from the system.\n\nNote: Discord roles were **not** deleted — remove them manually if needed.`)
    ], ephemeral: true });
  }

  // ── /listhouses ────────────────────────────────────────────────────────────
  else if (commandName === "listhouses") {
    const config = loadConfig();
    const houses = config.houses || [];
    if (!houses.length) {
      return interaction.reply({ content: "⚠️ No houses have been set up yet. Use `/addhouse` to create one.", ephemeral: true });
    }
    const embed = new EmbedBuilder().setColor(0xFFD700).setTitle("🏠 Nevaris Order — Houses")
      .setDescription(houses.map(h => {
        const role = h.roleId ? interaction.guild.roles.cache.get(h.roleId) : null;
        return `**${h.name}**${h.description ? ` — ${h.description}` : ""}${role ? ` • <@&${role.id}>` : ""}`;
      }).join("\n"))
      .setFooter({ text: "Use /house to join one" });
    interaction.reply({ embeds: [embed] });
  }

  // ── /house ─────────────────────────────────────────────────────────────────
  else if (commandName === "house") {
    const config = loadConfig();
    const houses = config.houses || [];

    if (!houses.length) {
      return interaction.reply({ content: "⚠️ No houses have been set up yet. Ask an admin to use `/addhouse` to create some.", ephemeral: true });
    }

    const options = houses.map(h =>
      new StringSelectMenuOptionBuilder()
        .setLabel(h.name)
        .setValue(h.name)
        .setDescription(h.description ? h.description.slice(0, 100) : "Choose this house")
    );

    const select = new StringSelectMenuBuilder()
      .setCustomId("house_select")
      .setPlaceholder("Choose your house...")
      .addOptions(options);

    const row = new ActionRowBuilder().addComponents(select);

    interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(0xFFD700)
          .setTitle("🏠 Choose Your House")
          .setDescription("Select a house from the dropdown below.\nYour house role will be assigned and any previous house role removed.")
          .addFields({ name: "Available Houses", value: houses.map(h => `• **${h.name}**${h.description ? ` — ${h.description}` : ""}`).join("\n") })
          .setFooter({ text: "You can change your house at any time." })
      ],
      components: [row],
      ephemeral: true
    });
  }

  // ── /addrole ───────────────────────────────────────────────────────────────
  else if (commandName === "addrole") {
    await interaction.deferReply();
    const roleName = interaction.options.getString("role");
    const role = interaction.guild.roles.cache.find(r => r.name === roleName);
    if (!role) return interaction.editReply(`❌ Role **${roleName}** not found. Check the exact name.`);
    const members = [1,2,3,4,5].map(n => interaction.options.getMember(`member${n}`)).filter(Boolean);
    const results = [];
    for (const m of members) {
      try { await m.roles.add(role); results.push(`✅ ${m}`); }
      catch { results.push(`❌ ${m} (failed)`); }
    }
    interaction.editReply({ embeds: [
      new EmbedBuilder().setColor(0x00FF88).setTitle(`✦ Role Added: ${roleName}`).setDescription(results.join("\n"))
    ]});
  }

  // ── /removerole ────────────────────────────────────────────────────────────
  else if (commandName === "removerole") {
    await interaction.deferReply();
    const roleName = interaction.options.getString("role");
    const role = interaction.guild.roles.cache.find(r => r.name === roleName);
    if (!role) return interaction.editReply(`❌ Role **${roleName}** not found. Check the exact name.`);
    const members = [1,2,3,4,5].map(n => interaction.options.getMember(`member${n}`)).filter(Boolean);
    const results = [];
    for (const m of members) {
      try { await m.roles.remove(role); results.push(`✅ ${m}`); }
      catch { results.push(`❌ ${m} (failed)`); }
    }
    interaction.editReply({ embeds: [
      new EmbedBuilder().setColor(0xFF6B6B).setTitle(`✦ Role Removed: ${roleName}`).setDescription(results.join("\n"))
    ]});
  }

  // ── /decorate ──────────────────────────────────────────────────────────────
  else if (commandName === "decorate") {
    await interaction.deferReply();
    const symbolKey = interaction.options.getString("symbol");
    const { prefix, label } = SYMBOLS[symbolKey];
    const channels = interaction.guild.channels.cache.filter(
      c => c.type === ChannelType.GuildText || c.type === ChannelType.GuildVoice
    );
    let decorated = 0, skipped = 0;
    for (const [, channel] of channels) {
      let cleanName = channel.name;
      for (const s of Object.values(SYMBOLS)) {
        const sym = s.prefix.replace("・", "");
        if (cleanName.startsWith(sym)) cleanName = cleanName.slice(sym.length).replace(/^[-\s・]+/, "");
      }
      try {
        await channel.setName(`${prefix}${cleanName}`);
        decorated++;
        await new Promise(r => setTimeout(r, 1500));
      } catch { skipped++; }
    }
    interaction.editReply({ embeds: [
      new EmbedBuilder().setColor(0xFFD700).setTitle(`${label} Channels Decorated!`)
        .setDescription(`✅ **${decorated}** channels updated\n⚠️ **${skipped}** skipped\n\n*If some were skipped, run the command again in a few minutes.*`)
    ]});
  }

  // ── /setguide ──────────────────────────────────────────────────────────────
  else if (commandName === "setguide") {
    const channels = [1,2,3,4,5].map(n => interaction.options.getChannel(`channel${n}`)).filter(Boolean);
    const config = loadConfig();
    config.guideChannels = channels.map(c => c.id);
    config.guideEnabled = true;
    saveConfig(config);
    interaction.reply({ embeds: [
      new EmbedBuilder().setColor(0x00FF88).setTitle("✅ Welcome Guide Set Up!")
        .setDescription(`New members will receive a DM directing them to:\n\n${channels.map(c => `• <#${c.id}>`).join("\n")}\n\nUse \`/testguide\` to send yourself a preview.`)
    ], ephemeral: true });
  }

  // ── /viewguide ─────────────────────────────────────────────────────────────
  else if (commandName === "viewguide") {
    const config = loadConfig();
    if (!config.guideEnabled || !config.guideChannels?.length)
      return interaction.reply({ content: "⚠️ No guide set up yet. Use `/setguide` to configure it.", ephemeral: true });
    const list = config.guideChannels.map(id => {
      const ch = interaction.guild.channels.cache.get(id);
      return ch ? `• <#${id}>` : `• (deleted: ${id})`;
    }).join("\n");
    interaction.reply({ embeds: [
      new EmbedBuilder().setColor(0x4169E1).setTitle("📋 Current Welcome Guide Channels")
        .setDescription(`New members are directed to:\n\n${list}\n\nUse \`/setguide\` to change, \`/testguide\` to preview.`)
    ], ephemeral: true });
  }

  // ── /testguide ─────────────────────────────────────────────────────────────
  else if (commandName === "testguide") {
    const config = loadConfig();
    if (!config.guideEnabled || !config.guideChannels?.length)
      return interaction.reply({ content: "⚠️ No guide set up yet. Use `/setguide` first.", ephemeral: true });
    try {
      await interaction.user.send({ embeds: [buildWelcomeDM(interaction.member, config.guideChannels, interaction.guild, config)] });
      interaction.reply({ content: "✅ Check your DMs!", ephemeral: true });
    } catch {
      interaction.reply({ content: "❌ Couldn't send you a DM. Make sure your DMs are open.", ephemeral: true });
    }
  }

  // ── /setlog ────────────────────────────────────────────────────────────────
  else if (commandName === "setlog") {
    const channel = interaction.options.getChannel("channel");
    const config = loadConfig();
    config.logChannelId = channel.id;
    saveConfig(config);
    interaction.reply({ embeds: [
      new EmbedBuilder().setColor(0x00FF88).setTitle("✅ Log Channel Set!")
        .setDescription(`All promotions and trial results will now be logged in <#${channel.id}>.`)
    ], ephemeral: true });
  }

  // ── /settrial ──────────────────────────────────────────────────────────────
  else if (commandName === "settrial") {
    const steps = interaction.options.getString("steps");
    const config = loadConfig();
    config.trialProcedure = steps;
    saveConfig(config);
    interaction.reply({ embeds: [
      new EmbedBuilder().setColor(0x00FF88).setTitle("✅ Trial Procedure Set!")
        .setDescription(`New members will now see this in their welcome DM:\n\n${steps.replace(/\\n/g, "\n")}\n\nUse \`/testguide\` to preview the full DM.`)
    ], ephemeral: true });
  }

  // ── /event ─────────────────────────────────────────────────────────────────
  else if (commandName === "event") {
    const name        = interaction.options.getString("name");
    const host        = interaction.options.getUser("host");
    const description = interaction.options.getString("description");
    const time        = interaction.options.getString("time");
    const type        = interaction.options.getString("type") || "Other";

    const typeEmojis = {
      Training: "⚔️", Tournament: "🏆", Social: "🎉", Ceremony: "🌅",
      Raid: "🗡️", Meeting: "📋", "Music Night": "🎵", Giveaway: "🎁", Other: "📖"
    };
    const emoji = typeEmojis[type] || "📖";

    const embed = new EmbedBuilder()
      .setColor(0xFFD700)
      .setTitle(`${emoji} EVENT ANNOUNCEMENT — ${name.toUpperCase()}`)
      .addFields(
        { name: "🎖️ Event Type", value: `${emoji} ${type}`, inline: true },
        { name: "👑 Hosted By",  value: `<@${host.id}>`,    inline: true }
      );

    if (time) embed.addFields({ name: "⏰ Time", value: time, inline: true });
    if (description) embed.addFields({ name: "📋 Details", value: description });

    embed
      .addFields({ name: "📣 How to Attend", value: "React to this message or check the relevant channel for details. All members are encouraged to participate!" })
      .setFooter({ text: `Announced by ${interaction.user.tag} • Nevaris Order` })
      .setTimestamp();

    await interaction.reply({ embeds: [embed] });

    await postLog(interaction.guild, new EmbedBuilder().setColor(0xFFD700).setTitle("📣 Event Announced")
      .addFields(
        { name: "Event", value: name,      inline: true },
        { name: "Host",  value: host.tag,  inline: true },
        { name: "Type",  value: type,      inline: true }
      ).setTimestamp()
    );
  }

  // ── /play ──────────────────────────────────────────────────────────────────
  else if (commandName === "play") {
    await interaction.deferReply();
    const query = interaction.options.getString("query");
    const voiceChannel = interaction.member.voice.channel;
    if (!voiceChannel) return interaction.editReply("❌ You need to be in a voice channel first!");

    try {
      let songUrl, songTitle;

      // Check if it's a YouTube URL
      const isUrl = /^https?:\/\/(www\.)?(youtube\.com|youtu\.be)/.test(query);

      if (isUrl) {
        // Validate and get info for the URL
        if (!ytdl.validateURL(query)) return interaction.editReply("❌ That doesn't look like a valid YouTube URL.");
        const info = await ytdl.getInfo(query);
        songUrl   = query;
        songTitle = info.videoDetails.title;
      } else {
        // Search YouTube
        const results = await YouTube.search(query, { limit: 1, type: "video" });
        if (!results.length) return interaction.editReply("❌ No results found for that search.");
        songUrl   = results[0].url;
        songTitle = results[0].title;
      }

      const songInfo = { title: songTitle, url: songUrl, requestedBy: interaction.user.tag };
      const guildId  = interaction.guild.id;
      let queue      = musicQueues.get(guildId);

      if (!queue) {
        const connection = joinVoiceChannel({
          channelId: voiceChannel.id,
          guildId: guildId,
          adapterCreator: interaction.guild.voiceAdapterCreator
        });
        const player = createAudioPlayer();
        connection.subscribe(player);
        queue = { connection, player, songs: [], textChannel: interaction.channel };
        musicQueues.set(guildId, queue);

        connection.on(VoiceConnectionStatus.Disconnected, () => {
          try { connection.destroy(); } catch {}
          musicQueues.delete(guildId);
        });

        player.on("error", (err) => {
          console.error("Player error:", err.message);
          queue.songs.shift();
          playNext(guildId, interaction.channel);
        });
      }

      queue.songs.push(songInfo);

      if (queue.songs.length === 1) {
        interaction.editReply({ embeds: [
          new EmbedBuilder().setColor(0xFFD700).setTitle("🎵 Now Playing")
            .setDescription(`**[${songInfo.title}](${songInfo.url})**`)
            .setFooter({ text: `Requested by ${songInfo.requestedBy}` })
        ]});
        playNext(guildId, interaction.channel);
      } else {
        interaction.editReply({ embeds: [
          new EmbedBuilder().setColor(0x00FF88).setTitle("✅ Added to Queue")
            .setDescription(`**[${songInfo.title}](${songInfo.url})**`)
            .addFields({ name: "Position", value: `#${queue.songs.length}`, inline: true })
            .setFooter({ text: `Requested by ${songInfo.requestedBy}` })
        ]});
      }
    } catch (err) {
      console.error("Play error:", err);
      interaction.editReply(`❌ Could not play that. Error: ${err.message}`);
    }
  }

  // ── /stop ──────────────────────────────────────────────────────────────────
  else if (commandName === "stop") {
    const queue = getQueue(interaction.guild.id);
    if (!queue) return interaction.reply("❌ Nothing is playing right now.");
    queue.songs = [];
    queue.player.stop();
    try { queue.connection.destroy(); } catch {}
    musicQueues.delete(interaction.guild.id);
    interaction.reply({ embeds: [
      new EmbedBuilder().setColor(0xFF6B6B).setTitle("⏹️ Music Stopped")
        .setDescription("The queue has been cleared and the bot has left the voice channel.")
    ]});
  }

  // ── /skip ──────────────────────────────────────────────────────────────────
  else if (commandName === "skip") {
    const queue = getQueue(interaction.guild.id);
    if (!queue || queue.songs.length === 0) return interaction.reply("❌ Nothing is playing right now.");
    const skipped = queue.songs[0].title;
    queue.player.stop();
    interaction.reply({ embeds: [
      new EmbedBuilder().setColor(0xFFD700).setTitle("⏭️ Skipped")
        .setDescription(`Skipped **${skipped}**`)
    ]});
  }

  // ── /queue ─────────────────────────────────────────────────────────────────
  else if (commandName === "queue") {
    const queue = getQueue(interaction.guild.id);
    if (!queue || queue.songs.length === 0)
      return interaction.reply({ embeds: [
        new EmbedBuilder().setColor(0x555555).setTitle("🎵 Queue").setDescription("The queue is empty.")
      ]});

    const list = queue.songs.map((s, i) =>
      i === 0 ? `▶️ **[${s.title}](${s.url})** *(now playing)*` : `${i}. [${s.title}](${s.url})`
    ).join("\n");

    interaction.reply({ embeds: [
      new EmbedBuilder().setColor(0x4169E1).setTitle(`🎵 Queue — ${queue.songs.length} song${queue.songs.length !== 1 ? "s" : ""}`)
        .setDescription(list.length > 4000 ? list.slice(0, 3997) + "..." : list)
    ]});
  }

  // ── /pause ─────────────────────────────────────────────────────────────────
  else if (commandName === "pause") {
    const queue = getQueue(interaction.guild.id);
    if (!queue) return interaction.reply("❌ Nothing is playing right now.");
    queue.player.pause();
    interaction.reply({ embeds: [new EmbedBuilder().setColor(0xFFD700).setTitle("⏸️ Paused").setDescription("Use `/resume` to continue.")] });
  }

  // ── /resume ────────────────────────────────────────────────────────────────
  else if (commandName === "resume") {
    const queue = getQueue(interaction.guild.id);
    if (!queue) return interaction.reply("❌ Nothing is playing right now.");
    queue.player.unpause();
    interaction.reply({ embeds: [new EmbedBuilder().setColor(0x00FF88).setTitle("▶️ Resumed")] });
  }

  // ── /nowplaying ────────────────────────────────────────────────────────────
  else if (commandName === "nowplaying") {
    const queue = getQueue(interaction.guild.id);
    if (!queue || queue.songs.length === 0)
      return interaction.reply("❌ Nothing is playing right now.");
    const song = queue.songs[0];
    interaction.reply({ embeds: [
      new EmbedBuilder().setColor(0xFFD700).setTitle("🎵 Now Playing")
        .setDescription(`**[${song.title}](${song.url})**`)
        .setFooter({ text: `Requested by ${song.requestedBy}` })
    ]});
  }

  // ── /giveaway ──────────────────────────────────────────────────────────────
  else if (commandName === "giveaway") {
    const prize        = interaction.options.getString("prize");
    const durationStr  = interaction.options.getString("duration");
    const winnersCount = interaction.options.getInteger("winners") || 1;
    const ms = parseDuration(durationStr);

    if (ms < 5000) return interaction.reply({ content: "❌ Duration must be at least 5 seconds.", ephemeral: true });

    const endTime    = new Date(Date.now() + ms);
    const giveawayId = Date.now().toString();

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`giveaway_enter_${giveawayId}`)
        .setLabel("0 entries")
        .setEmoji("🎉")
        .setStyle(ButtonStyle.Success)
    );

    const embed = new EmbedBuilder()
      .setColor(0xFFD700)
      .setTitle("🎉 GIVEAWAY")
      .setDescription(`**${prize}**\n\nClick the button below to enter!`)
      .addFields(
        { name: "🏆 Winners", value: `${winnersCount}`, inline: true },
        { name: "⏰ Ends",    value: `<t:${Math.floor(endTime.getTime() / 1000)}:R>`, inline: true },
        { name: "🎟️ Host",   value: `<@${interaction.user.id}>`, inline: true }
      )
      .setFooter({ text: `Giveaway ID: ${giveawayId}` })
      .setTimestamp(endTime);

    await interaction.reply({ embeds: [embed], components: [row] });
    const message = await interaction.fetchReply();

    const giveawayData = {
      messageId: message.id,
      channelId: interaction.channel.id,
      prize,
      winnersCount,
      endTime,
      entries: [],
      timeout: null
    };

    giveawayData.timeout = setTimeout(() => endGiveaway(client, giveawayId), ms);
    activeGiveaways.set(giveawayId, giveawayData);
  }

  // ── /gend ──────────────────────────────────────────────────────────────────
  else if (commandName === "gend") {
    const msgId = interaction.options.getString("message_id");
    let found = null;
    for (const [id, g] of activeGiveaways.entries()) {
      if (g.messageId === msgId) { found = id; break; }
    }
    if (!found) return interaction.reply({ content: "❌ No active giveaway found with that message ID.", ephemeral: true });
    await interaction.reply({ content: "✅ Ending giveaway now...", ephemeral: true });
    await endGiveaway(client, found, true);
  }

  // ── /greroll ───────────────────────────────────────────────────────────────
  else if (commandName === "greroll") {
    const msgId = interaction.options.getString("message_id");
    let found = null;
    for (const [id, g] of activeGiveaways.entries()) {
      if (g.messageId === msgId && g.ended) { found = { id, g }; break; }
    }
    if (!found) return interaction.reply({ content: "❌ No ended giveaway found with that message ID.", ephemeral: true });

    const { g } = found;
    if (!g.entries.length) return interaction.reply({ content: "❌ No entries to reroll.", ephemeral: true });

    const winner = g.entries[Math.floor(Math.random() * g.entries.length)];
    interaction.reply({ embeds: [
      new EmbedBuilder().setColor(0xFFD700).setTitle("🎲 Giveaway Rerolled!")
        .setDescription(`New winner: <@${winner}>\n\nCongratulations on winning **${g.prize}**!`)
    ]});
  }

  // ── /help ──────────────────────────────────────────────────────────────────
  else if (commandName === "help") {
    interaction.reply({ embeds: [
      new EmbedBuilder().setColor(0xFFD700).setTitle("☀ Nevaris Order Bot — Commands")
        .addFields(
          { name: "🏅 Rank Commands",    value: "`/promote` `/trial` `/setrank` `/addrank` `/removerank` `/ranks` `/rank` `/roster` `/setup-roles`" },
          { name: "🏠 House Commands",   value: "`/house` — choose your house\n`/addhouse` `/listhouses` `/removeallhouses` — admin setup" },
          { name: "👥 Role Commands",    value: "`/addrole` `/removerole`" },
          { name: "📣 Events",           value: "`/event` — announce an event with name, host, type, time, and description" },
          { name: "🎵 Music",            value: "`/play` `/stop` `/skip` `/queue` `/pause` `/resume` `/nowplaying`" },
          { name: "🎉 Giveaways",        value: "`/giveaway` — start a giveaway\n`/gend <message_id>` — end early\n`/greroll <message_id>` — reroll winner" },
          { name: "✉️ Welcome DM",       value: "`/setguide` `/settrial` `/viewguide` `/testguide`" },
          { name: "📜 Archive",          value: "`/archive` — quick summary\n`/setup-archive` — create full forum channel (admin)" },
          { name: "⚙️ Server & Logging", value: "`/decorate` `/setlog`" }
        )
        .setFooter({ text: '"From the First Dawn, We Rise."' })
    ], ephemeral: true });
  }
});

// ─── LOGIN ────────────────────────────────────────────────────────────────────
client.login(process.env.DISCORD_TOKEN);
