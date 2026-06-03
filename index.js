require("dotenv").config();
const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  REST,
  Routes,
  PermissionFlagsBits,
  EmbedBuilder,
  ChannelType
} = require("discord.js");
const http = require("http");
const fs = require("fs");
const path = require("path");

// ─── CONFIG (persists across restarts) ───────────────────────────────────────
const CONFIG_PATH = path.join(__dirname, "config.json");

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return { guideChannels: [], guideEnabled: false };
  }
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

// ─── KEEP-ALIVE SERVER ────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200);
  res.end("☀ Nevaris Order Bot is online.");
}).listen(PORT, () => {
  console.log(`Keep-alive server running on port ${PORT}`);
});

// ─── RANK SYSTEM ──────────────────────────────────────────────────────────────
const rankCategories = [
  { label: "🔱 High Ranks", ranks: ["Luminary of Nevaris", "Astral Regent", "Dawnseer", "⚡ Dawnborn"] },
  { label: "⚔️ Mid Ranks",  ranks: ["Zenith Vanguard", "Horizon Warden", "Celestial Knight"] },
  { label: "🌟 Low Ranks",  ranks: ["Dawnsworn", "Starling"] }
];

const ranks = [
  "Starling",
  "Dawnsworn",
  "Celestial Knight",
  "Horizon Warden",
  "Zenith Vanguard",
  "Dawnseer",
  "Astral Regent",
  "Luminary of Nevaris"
];

// Special unit — separate from the main rank ladder
const specialUnits = [
  {
    label: "🗡️ Special Unit — Dawnborn",
    role: "⚡ Dawnborn",   // exact Discord role name (with symbol)
    description: [
      "An invitation-only division of the finest warriors in the Order.",
      "Members are hand-selected by the High Ranks after exceptional performance in trials and combat.",
      "Dawnborn carry the symbol ⚡ in their role and stand apart from the standard rank ladder.",
      "Holding this title does not replace a member's current rank — it is worn alongside it."
    ].join("\n")
  }
];

const SYMBOLS = {
  star:    { prefix: "✦・", label: "✦ Stars" },
  sun:     { prefix: "☀・", label: "☀ Suns" },
  moon:    { prefix: "🌙・", label: "🌙 Moons" },
  diamond: { prefix: "◈・", label: "◈ Diamonds" },
  dawn:    { prefix: "🌅・", label: "🌅 Dawn" }
};

// ─── SLASH COMMANDS ───────────────────────────────────────────────────────────
const commands = [
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

  new SlashCommandBuilder()
    .setName("archive")
    .setDescription("Show the full Nevaris Order clan archive"),

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

  // ── /setguide — configure welcome DM ────────────────────────────────────────
  new SlashCommandBuilder()
    .setName("setguide")
    .setDescription("Set which channels new members are directed to in their welcome DM")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addChannelOption(o => o.setName("channel1").setDescription("Channel 1 (required)").setRequired(true)
      .addChannelTypes(ChannelType.GuildText))
    .addChannelOption(o => o.setName("channel2").setDescription("Channel 2 (optional)")
      .addChannelTypes(ChannelType.GuildText))
    .addChannelOption(o => o.setName("channel3").setDescription("Channel 3 (optional)")
      .addChannelTypes(ChannelType.GuildText))
    .addChannelOption(o => o.setName("channel4").setDescription("Channel 4 (optional)")
      .addChannelTypes(ChannelType.GuildText))
    .addChannelOption(o => o.setName("channel5").setDescription("Channel 5 (optional)")
      .addChannelTypes(ChannelType.GuildText)),

  // ── /viewguide — preview the welcome DM ─────────────────────────────────────
  new SlashCommandBuilder()
    .setName("viewguide")
    .setDescription("Preview the welcome DM new members will receive")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  // ── /testguide — send yourself the welcome DM ────────────────────────────────
  new SlashCommandBuilder()
    .setName("testguide")
    .setDescription("Send yourself the welcome DM to see how it looks")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  // ── /roster — show live member list by rank ─────────────────────────────────
  new SlashCommandBuilder()
    .setName("roster")
    .setDescription("Show a live list of all members by rank tier"),

  // ── /setrank — directly set a member's rank ──────────────────────────────────
  new SlashCommandBuilder()
    .setName("setrank")
    .setDescription("Set a member's rank directly, removing any previous rank roles")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addUserOption(o =>
      o.setName("member").setDescription("The member to update").setRequired(true)
    )
    .addStringOption(o =>
      o.setName("rank").setDescription("The rank to assign").setRequired(true)
        .addChoices(
          { name: "Starling",            value: "Starling" },
          { name: "Dawnsworn",           value: "Dawnsworn" },
          { name: "Celestial Knight",    value: "Celestial Knight" },
          { name: "Horizon Warden",      value: "Horizon Warden" },
          { name: "Zenith Vanguard",     value: "Zenith Vanguard" },
          { name: "Dawnseer",            value: "Dawnseer" },
          { name: "Astral Regent",       value: "Astral Regent" },
          { name: "Luminary of Nevaris", value: "Luminary of Nevaris" }
        )
    ),

  // ── /setlog — configure the log channel ─────────────────────────────────────
  new SlashCommandBuilder()
    .setName("setlog")
    .setDescription("Set the channel where promotions and trial results are logged")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addChannelOption(o =>
      o.setName("channel").setDescription("The channel to post logs in").setRequired(true)
        .addChannelTypes(ChannelType.GuildText)
    ),

  // ── /settrial — set trial procedure shown in welcome DM ─────────────────────
  new SlashCommandBuilder()
    .setName("settrial")
    .setDescription("Set the exact trial steps shown in the welcome DM")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(o =>
      o.setName("steps")
        .setDescription("Your trial steps (tip: use \\n between steps, e.g. Step 1: Join vc\\nStep 2: Answer questions)")
        .setRequired(true)
    ),

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
    GatewayIntentBits.MessageContent
  ]
});

// ─── READY ────────────────────────────────────────────────────────────────────
client.on("clientReady", async () => {
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

// ─── BUILD WELCOME DM EMBED ───────────────────────────────────────────────────
function buildWelcomeDM(member, channelIds, guild, config = {}) {
  const channelLines = channelIds
    .map(id => {
      const ch = guild.channels.cache.get(id);
      return ch ? `• <#${id}> — ${ch.name.replace(/^[^a-zA-Z0-9]+/, "").replace(/-/g, " ")}` : null;
    })
    .filter(Boolean);

  const embed = new EmbedBuilder()
    .setColor(0xFFD700)
    .setTitle(`☀ Welcome to the Nevaris Order, ${member.user.username}! ☀`)
    .setDescription(
      `*"From the First Dawn, We Rise."*\n\nYou have taken your first step into the Order. You begin your journey as a **Starling** — the first light before the dawn.`
    )
    .addFields(
      {
        name: "📋 Your Rank Path",
        value: "Starling → Dawnsworn → Celestial Knight → Horizon Warden → and beyond...\n\nUse `/ranks` in the server to see the full ladder."
      }
    );

  if (channelLines.length > 0) {
    embed.addFields({
      name: "📌 Start Here — Check These Channels",
      value: channelLines.join("\n")
    });
  }

  embed.addFields(
    {
      name: "⚔️ How to Rise",
      value: "• Attend trainings and events\n• Complete the Trial of Dawn\n• Speak with a Horizon Warden to begin your trial"
    },
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
    ...(config.trialProcedure ? [{
      name: "📜 Trial Procedure",
      value: config.trialProcedure.replace(/\\n/g, "\n")
    }] : []),
    {
      name: "🗡️ Dawnborn — Special Unit",
      value: "The Order's elite division. Members are hand-picked by High Ranks for exceptional skill and dedication. There is no application — you are chosen. Look for the ⚡ role."
    },
    {
      name: "📖 Learn More",
      value: "Use `/archive` in the server to read the full clan history, rank descriptions, lore of the Order, and how the trial and special unit systems work."
    },
    {
      name: "❓ Questions?",
      value: "Reach out to any Mid or High Rank member — they are here to guide you."
    }
  )
  .setFooter({ text: `${guild.name} • The Order watches over you.` })
  .setTimestamp();

  return embed;
}

// ─── POST TO LOG CHANNEL ─────────────────────────────────────────────────────
async function postLog(guild, embed) {
  const config = loadConfig();
  if (!config.logChannelId) return;
  const ch = guild.channels.cache.get(config.logChannelId);
  if (ch) ch.send({ embeds: [embed] });
}

// ─── WELCOME NEW MEMBERS ──────────────────────────────────────────────────────
client.on("guildMemberAdd", async (member) => {
  // Post in welcome channel
  const welcomeChannel = member.guild.channels.cache.find(
    c => c.name.toLowerCase().includes("welcome") && c.type === ChannelType.GuildText
  );
  if (welcomeChannel) {
    const serverEmbed = new EmbedBuilder()
      .setColor(0xFFD700)
      .setTitle("☀ A New Warrior Joins the Dawn ☀")
      .setDescription(
        `Welcome ${member} to the **Nevaris Order**!\n\n*"From the First Dawn, We Rise."*\n\nYou begin your journey as a **Starling**. Check your DMs for your guide.`
      )
      .setFooter({ text: "⚔ Your path to greatness begins now." });
    welcomeChannel.send({ embeds: [serverEmbed] });
  }

  // Send welcome DM
  const config = loadConfig();
  if (!config.guideEnabled || !config.guideChannels?.length) return;

  try {
    const dmEmbed = buildWelcomeDM(member, config.guideChannels, member.guild, config);
    await member.send({ embeds: [dmEmbed] });
    console.log(`📨 Welcome DM sent to ${member.user.tag}`);
  } catch {
    console.log(`⚠️ Could not DM ${member.user.tag} (DMs may be closed)`);
  }
});

// ─── SLASH COMMAND HANDLER ────────────────────────────────────────────────────
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const { commandName } = interaction;

  // /promote
  if (commandName === "promote") {
    await interaction.deferReply();
    try {
      // Fetch fresh member data so role cache is up to date
      const target = await interaction.guild.members.fetch(interaction.options.getUser("member").id);
      if (!target) return interaction.editReply("❌ Member not found.");

      const currentIdx = ranks.findIndex(r => target.roles.cache.some(role => role.name === r));
      // If no rank yet, give them Starling (index 0) as their first rank
      const nextRank = currentIdx === -1 ? ranks[0] : ranks[currentIdx + 1];

      if (!nextRank) return interaction.editReply("⚠️ This warrior has already reached the highest rank.");

      const role = interaction.guild.roles.cache.find(r => r.name === nextRank);
      if (!role) return interaction.editReply(
        `❌ Role **${nextRank}** not found on the server.\n\nMake sure:\n• The role exists with that exact name\n• The bot's role is **above** all clan ranks in Server Settings → Roles`
      );

      // Add new role
      await target.roles.add(role);

      // Remove old rank role if they had one
      const oldRankName = currentIdx >= 0 ? ranks[currentIdx] : null;
      if (oldRankName) {
        const oldRole = interaction.guild.roles.cache.find(r => r.name === oldRankName);
        if (oldRole && target.roles.cache.has(oldRole.id)) await target.roles.remove(oldRole);
      }

      // Tier transition message
      const prevTier = rankCategories.find(c => c.ranks.includes(oldRankName))?.label ?? "";
      const newTier  = rankCategories.find(c => c.ranks.includes(nextRank))?.label ?? "";
      const tierMsg  = prevTier && newTier && prevTier !== newTier
        ? `\n\n✦ *Tier advancement: ${prevTier} → ${newTier}*` : "";

      const promoteEmbed = new EmbedBuilder().setColor(0xFFD700).setTitle("⭐ PROMOTION COMPLETE ⭐")
        .setDescription(`${target} has ascended to **${nextRank}**\n\n☀ *"The Dawn acknowledges your growth."*${tierMsg}`);
      interaction.editReply({ embeds: [promoteEmbed] });

      await postLog(interaction.guild, new EmbedBuilder()
        .setColor(0xFFD700).setTitle("⭐ Promotion Logged")
        .addFields(
          { name: "Member", value: `${target} (${target.user.tag})`, inline: true },
          { name: "New Rank", value: nextRank, inline: true },
          { name: "Promoted By", value: interaction.user.tag, inline: true }
        ).setTimestamp()
      );
    } catch (err) {
      console.error("Promote error:", err);
      interaction.editReply(
        `❌ Promotion failed: **${err.message}**\n\nCommon fixes:\n• Go to Server Settings → Roles and drag the bot's role **above** all clan rank roles\n• Make sure the bot has the **Manage Roles** permission`
      );
    }
  }

  // /trial
  else if (commandName === "trial") {
    await interaction.deferReply();
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
      // Log pass
      await postLog(interaction.guild, new EmbedBuilder()
        .setColor(0x00FF88)
        .setTitle("✅ Trial Passed")
        .addFields(
          { name: "Member", value: `${target} (${target.user.tag})`, inline: true },
          { name: "New Rank", value: nextRank, inline: true },
          { name: "Judge", value: `${interaction.user.tag}`, inline: true }
        )
        .setTimestamp()
      );
    } else {
      interaction.editReply({ embeds: [
        new EmbedBuilder().setColor(0x8B0000).setTitle("🌑 TRIAL FAILED")
          .setDescription(`${target} must train further before attempting ascension again.\n\n*"Even the brightest stars must endure darkness to grow."*`)
      ]});
      // Log fail
      await postLog(interaction.guild, new EmbedBuilder()
        .setColor(0x8B0000)
        .setTitle("❌ Trial Failed")
        .addFields(
          { name: "Member", value: `${target} (${target.user.tag})`, inline: true },
          { name: "Judge", value: `${interaction.user.tag}`, inline: true }
        )
        .setTimestamp()
      );
    }
  }

  // /ranks
  else if (commandName === "ranks") {
    const embed = new EmbedBuilder().setColor(0xFFD700).setTitle("🌠 NEVARIS ORDER — RANK LADDER")
      .setFooter({ text: '"From the First Dawn, We Rise."' });
    for (const cat of rankCategories) {
      embed.addFields({
        name: cat.label,
        value: cat.ranks.map(r =>
          r === "⚡ Dawnborn"
            ? `• ${r} — *Special Unit, invitation only*`
            : `• ${r}`
        ).join("\n")
      });
    }
    interaction.reply({ embeds: [embed] });
  }

  // /addrole
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

  // /removerole
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

  // /archive
  else if (commandName === "archive") {
    interaction.reply({ embeds: [
      new EmbedBuilder().setColor(0x4169E1).setTitle("📜 NEVARIS ORDER — CLAN ARCHIVE")
        .setDescription('*"From the First Dawn, We Rise."*\n\nFounded in the light of the First Dawn, the Nevaris Order stands as a brotherhood of warriors, seers, and guardians. Bound by oath, forged through trial, and guided by the stars — every member walks a path from Starling to Luminary.')
        .addFields(
          {
            name: "🔱 High Ranks",
            value: [
              "**Luminary of Nevaris** — The supreme voice of the Order. Bearer of the First Light and final authority in all matters.",
              "**Astral Regent** — Commander of the High Council. Entrusted with the Order's direction and long-term vision.",
              "**Dawnseer** — Keeper of lore, oaths, and the Order's history. Advisors to the Regent and voice of wisdom in council.",
              "**⚡ Dawnborn** — Elite special unit, ranked directly beneath the Dawnseer. Invitation only — selected by High Ranks for exceptional service."
            ].join("\n")
          },
          {
            name: "⚔️ Mid Ranks",
            value: [
              "**Zenith Vanguard** — Elite warriors proven across multiple trials. The blade of the Order.",
              "**Horizon Warden** — Seasoned members who oversee trials and mentor rising warriors.",
              "**Celestial Knight** — Fully initiated members who have proven their worth and sworn the deep oath."
            ].join("\n")
          },
          {
            name: "🌟 Low Ranks",
            value: [
              "**Dawnsworn** — Warriors who have passed their first trial and spoken the oath of the Order.",
              "**Starling** — New recruits stepping into the light for the first time."
            ].join("\n")
          },
          {
            name: "🌠 Lore of the Order",
            value: [
              "Long before the first wars, a group of wanderers saw a light on the horizon — not of sun or moon, but of something older.",
              "They called it the First Dawn. They built their order around it: a belief that greatness is not given, but earned through trial, discipline, and brotherhood.",
              "Every rank is a chapter in that story. Every trial is a step toward the light.",
              '*"We do not fight for glory. We fight so the Dawn never fades."*'
            ].join("\n\n")
          },
          {
            name: "🗡️ Special Unit — ⚡ Dawnborn",
            value: [
              "An invitation-only division reserved for the most distinguished warriors of the Order.",
              "Members are hand-selected by the High Ranks after outstanding performance in trials and service.",
              "• The role **⚡ Dawnborn** is worn *alongside* a member's current rank — not instead of it.",
              "• Dawnborn members are held to the highest standard of conduct and skill.",
              "• Selection is at the sole discretion of the Astral Regent and Luminary.",
              "• There is no command to request entry — you are chosen."
            ].join("\n")
          },
          { name: "⚔️ Trial System", value: "• Administered by Horizon Wardens and above\n• Pass → advance one rank automatically, old rank role removed\n• Fail → further training, then re-trial\n• Command: `/trial @member pass/fail`\n• Dawnborn members may face advanced trials at High Rank discretion" },
          { name: "⬆️ Promotion System", value: "• Granted by Administrators only\n• Command: `/promote @member` — removes old rank role, adds new one automatically\n• Tier changes (Low→Mid, Mid→High) are handled automatically\n• Use `/addrole ⚡ Dawnborn @member` to induct into the Special Unit" },
          { name: "📋 Commands", value: "`/promote` `/trial` `/ranks` `/addrole` `/removerole` `/decorate` `/setguide` `/settrial` `/setlog` `/archive` `/help`" }
        )
        .setFooter({ text: "Nevaris Order Bot • Always watching." })
    ]});
  }

  // /decorate
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

  // /setguide
  else if (commandName === "setguide") {
    const channels = [1,2,3,4,5]
      .map(n => interaction.options.getChannel(`channel${n}`))
      .filter(Boolean);

    const config = loadConfig();
    config.guideChannels = channels.map(c => c.id);
    config.guideEnabled = true;
    saveConfig(config);

    const list = channels.map(c => `• <#${c.id}>`).join("\n");
    interaction.reply({ embeds: [
      new EmbedBuilder().setColor(0x00FF88).setTitle("✅ Welcome Guide Set Up!")
        .setDescription(`New members will receive a DM directing them to:\n\n${list}\n\nUse \`/testguide\` to send yourself a preview.`)
    ], ephemeral: true });
  }

  // /viewguide
  else if (commandName === "viewguide") {
    const config = loadConfig();
    if (!config.guideEnabled || !config.guideChannels?.length) {
      return interaction.reply({ content: "⚠️ No guide set up yet. Use `/setguide` to configure it.", ephemeral: true });
    }
    const list = config.guideChannels.map(id => {
      const ch = interaction.guild.channels.cache.get(id);
      return ch ? `• <#${id}>` : `• (deleted channel: ${id})`;
    }).join("\n");

    interaction.reply({ embeds: [
      new EmbedBuilder().setColor(0x4169E1).setTitle("📋 Current Welcome Guide Channels")
        .setDescription(`New members are directed to:\n\n${list}\n\nUse \`/setguide\` to change, \`/testguide\` to preview.`)
    ], ephemeral: true });
  }

  // /testguide
  else if (commandName === "testguide") {
    const config = loadConfig();
    if (!config.guideEnabled || !config.guideChannels?.length) {
      return interaction.reply({ content: "⚠️ No guide set up yet. Use `/setguide` first.", ephemeral: true });
    }
    try {
      const embed = buildWelcomeDM(interaction.member, config.guideChannels, interaction.guild, config);
      await interaction.user.send({ embeds: [embed] });
      interaction.reply({ content: "✅ Check your DMs — the welcome message was just sent to you!", ephemeral: true });
    } catch {
      interaction.reply({ content: "❌ Couldn't send you a DM. Make sure your DMs are open for this server.", ephemeral: true });
    }
  }

  // /roster
  else if (commandName === "roster") {
    await interaction.deferReply();
    await interaction.guild.members.fetch();

    const embed = new EmbedBuilder()
      .setColor(0x4169E1)
      .setTitle("📋 NEVARIS ORDER — LIVE ROSTER")
      .setFooter({ text: `Last updated • ${new Date().toUTCString()}` });

    // Standard rank tiers
    for (const cat of rankCategories) {
      const lines = [];
      for (const rankName of cat.ranks) {
        if (rankName === "⚡ Dawnborn") continue; // handled separately
        const role = interaction.guild.roles.cache.find(r => r.name === rankName);
        if (!role) { lines.push(`*${rankName} — role not found on server*`); continue; }
        const members = role.members.map(m => m.toString());
        if (members.length === 0) {
          lines.push(`**${rankName}** — *vacant*`);
        } else {
          lines.push(`**${rankName}** (${members.length})\n${members.join(", ")}`);
        }
      }
      if (lines.length) embed.addFields({ name: cat.label, value: lines.join("\n") });
    }

    // Dawnborn special unit
    const dbRole = interaction.guild.roles.cache.find(r => r.name === "⚡ Dawnborn");
    if (dbRole) {
      const dbMembers = dbRole.members.map(m => m.toString());
      embed.addFields({
        name: "🗡️ Special Unit — ⚡ Dawnborn",
        value: dbMembers.length > 0
          ? `${dbMembers.join(", ")}`
          : "*No members currently inducted*"
      });
    } else {
      embed.addFields({
        name: "🗡️ Special Unit — ⚡ Dawnborn",
        value: "*Role not found on server — create a role named `⚡ Dawnborn`*"
      });
    }

    interaction.editReply({ embeds: [embed] });
  }

  // /setrank
  else if (commandName === "setrank") {
    await interaction.deferReply();
    const target = interaction.options.getMember("member");
    const newRank = interaction.options.getString("rank");
    if (!target) return interaction.editReply("❌ Member not found.");

    const newRole = interaction.guild.roles.cache.find(r => r.name === newRank);
    if (!newRole) return interaction.editReply(`❌ Role **${newRank}** not found. Make sure it exists on the server.`);

    // Remove all existing rank roles, then add the new one
    const toRemove = target.roles.cache.filter(r => ranks.includes(r.name));
    for (const [, r] of toRemove) await target.roles.remove(r);
    await target.roles.add(newRole);

    const tier = rankCategories.find(c => c.ranks.includes(newRank))?.label ?? "";
    const embed = new EmbedBuilder()
      .setColor(0x00BFFF)
      .setTitle("🔄 Rank Updated")
      .setDescription(`${target} has been set to **${newRank}**${tier ? ` *(${tier})*` : ""}\n\nAll previous rank roles have been removed.`);
    interaction.editReply({ embeds: [embed] });

    await postLog(interaction.guild, new EmbedBuilder()
      .setColor(0x00BFFF)
      .setTitle("🔄 Rank Set Manually")
      .addFields(
        { name: "Member", value: `${target} (${target.user.tag})`, inline: true },
        { name: "New Rank", value: newRank, inline: true },
        { name: "Set By", value: interaction.user.tag, inline: true }
      )
      .setTimestamp()
    );
  }

  // /setlog
  else if (commandName === "setlog") {
    const channel = interaction.options.getChannel("channel");
    const config = loadConfig();
    config.logChannelId = channel.id;
    saveConfig(config);
    interaction.reply({ embeds: [
      new EmbedBuilder().setColor(0x00FF88).setTitle("✅ Log Channel Set!")
        .setDescription(`All promotions and trial results will now be logged in <#${channel.id}>.\n\nRun \`/promote\` or \`/trial\` to see it in action.`)
    ], ephemeral: true });
  }

  // /settrial
  else if (commandName === "settrial") {
    const steps = interaction.options.getString("steps");
    const config = loadConfig();
    config.trialProcedure = steps;
    saveConfig(config);
    interaction.reply({ embeds: [
      new EmbedBuilder().setColor(0x00FF88).setTitle("✅ Trial Procedure Set!")
        .setDescription(`New members will now see this in their welcome DM under **📜 Trial Procedure**:\n\n${steps.replace(/\\n/g, "\n")}\n\nUse \`/testguide\` to preview the full DM.`)
    ], ephemeral: true });
  }

  // /help
  else if (commandName === "help") {
    interaction.reply({ embeds: [
      new EmbedBuilder().setColor(0xFFD700).setTitle("☀ Nevaris Order Bot — Commands")
        .addFields(
          { name: "🔱 Rank Commands", value: "`/promote` `/trial` `/ranks` `/archive`" },
          { name: "👥 Role Commands", value: "`/addrole` `/removerole`" },
          { name: "✉️ Welcome DM Setup", value: "`/setguide` — pick channels to feature\n`/settrial` — set trial steps shown in DM\n`/viewguide` — see current setup\n`/testguide` — send yourself a preview" },
          { name: "📋 Roster & Ranks", value: "`/roster` — live member list by rank tier\n`/setrank @member rank` — set a rank directly, clears old ones" },
          { name: "📋 Logging", value: "`/setlog #channel` — set where promotions & trials are logged" },
          { name: "✨ Server", value: "`/decorate` — add symbols to channel names" },
          { name: "❓ Help", value: "`/help` — this message" }
        )
        .setFooter({ text: '"From the First Dawn, We Rise."' })
    ], ephemeral: true });
  }
});

// ─── LOGIN ────────────────────────────────────────────────────────────────────
client.login(process.env.DISCORD_TOKEN);
