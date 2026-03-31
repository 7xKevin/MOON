const crypto = require("node:crypto");
const path = require("node:path");
const express = require("express");
const session = require("express-session");
const pgSession = require("connect-pg-simple");
const helmet = require("helmet");
const { PermissionsBitField } = require("discord.js");
const { createDefaultGuildSettings, normalizeGuildSettings, parseStringList } = require("./settingsStore");

const DISCORD_API_BASE = "https://discord.com/api/v10";
const ADMIN_MASK =
  PermissionsBitField.Flags.Administrator |
  PermissionsBitField.Flags.ManageGuild;

function avatarUrl(user) {
  if (!user?.avatar) {
    return null;
  }

  return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128`;
}

function hasGuildAccess(guild, config, sessionUser) {
  if (!guild) {
    return false;
  }

  if (config.DASHBOARD_SUPER_ADMIN_IDS.includes(sessionUser.id)) {
    return true;
  }

  const permissions = BigInt(guild.permissions ?? "0");
  return (permissions & ADMIN_MASK) !== 0n;
}

function buildBotInviteUrl(config, guildId) {
  if (!config.DISCORD_CLIENT_ID) {
    return null;
  }

  const params = new URLSearchParams({
    client_id: config.DISCORD_CLIENT_ID,
    scope: "bot applications.commands",
    permissions: String(
      Number(PermissionsBitField.Flags.ViewChannel) +
        Number(PermissionsBitField.Flags.Connect) +
        Number(PermissionsBitField.Flags.Speak) +
        Number(PermissionsBitField.Flags.MoveMembers) +
        Number(PermissionsBitField.Flags.MuteMembers) +
        Number(PermissionsBitField.Flags.ManageChannels)
    ),
  });

  if (guildId) {
    params.set("guild_id", guildId);
    params.set("disable_guild_select", "true");
  }

  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}

async function exchangeCodeForToken(config, code) {
  const body = new URLSearchParams({
    client_id: config.DISCORD_CLIENT_ID,
    client_secret: config.DISCORD_CLIENT_SECRET,
    grant_type: "authorization_code",
    code,
    redirect_uri: config.oauthRedirectUri,
  });

  const response = await fetch(`${DISCORD_API_BASE}/oauth2/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!response.ok) {
    throw new Error(`Discord OAuth token exchange failed with status ${response.status}.`);
  }

  return response.json();
}

async function refreshAccessToken(config, refreshToken) {
  const body = new URLSearchParams({
    client_id: config.DISCORD_CLIENT_ID,
    client_secret: config.DISCORD_CLIENT_SECRET,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });

  const response = await fetch(`${DISCORD_API_BASE}/oauth2/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!response.ok) {
    throw Object.assign(new Error("Your Discord session expired. Please log in again."), {
      userFacingMessage: "Your Discord session expired. Please log in again.",
    });
  }

  return response.json();
}

async function fetchDiscordResource(pathname, accessToken) {
  const response = await fetch(`${DISCORD_API_BASE}${pathname}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    const retryAfterHeader = response.headers.get("retry-after");
    const retryAfterSeconds = retryAfterHeader ? Number.parseFloat(retryAfterHeader) : null;
    const error = new Error(`Discord API request failed for ${pathname} with status ${response.status}.`);
    error.status = response.status;
    error.retryAfterSeconds = Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : null;
    throw error;
  }

  return response.json();
}

function requireAuth(req, res, next) {
  if (!req.session.user) {
    res.redirect("/");
    return;
  }

  next();
}

function parseBoolean(value) {
  return value === "on" || value === "true" || value === true;
}

function ensureCsrfToken(req) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(24).toString("hex");
  }

  return req.session.csrfToken;
}

function requireCsrf(req, res, next) {
  if (!req.session?.csrfToken || req.body.csrfToken !== req.session.csrfToken) {
    res.status(403).send("Invalid CSRF token.");
    return;
  }

  next();
}

function mapGuildForm(req, config, existingSettings = {}) {
  return normalizeGuildSettings({
    ...existingSettings,
    guildId: req.params.guildId,
    guildName: req.body.guildName,
    botEnabled: parseBoolean(req.body.botEnabled),
    adminUserIds: parseStringList(req.body.adminUserIds),
    commandUserIds: parseStringList(req.body.commandUserIds),
    allowedRoleIds: parseStringList(req.body.allowedRoleIds),
    preferredTextChannelId: req.body.preferredTextChannelId,
    preferredVoiceChannelId: req.body.preferredVoiceChannelId,
    debugTranscripts: parseBoolean(req.body.debugTranscripts),
    transcriptionEnabled: parseBoolean(req.body.transcriptionEnabled),
    wakeWord: req.body.wakeWord,
    requireWakeWord: parseBoolean(req.body.requireWakeWord),
    transcriptionSilenceMs: req.body.transcriptionSilenceMs,
    commandCooldownMs: req.body.commandCooldownMs,
    commandDragEnabled: parseBoolean(req.body.commandDragEnabled),
    commandMuteEnabled: parseBoolean(req.body.commandMuteEnabled),
    commandKickEnabled: parseBoolean(req.body.commandKickEnabled),
    commandLockEnabled: parseBoolean(req.body.commandLockEnabled),
  }, {
    wakeWord: config.WAKE_WORD,
    requireWakeWord: config.REQUIRE_WAKE_WORD,
    transcriptionSilenceMs: config.TRANSCRIPTION_SILENCE_MS,
    commandCooldownMs: config.COMMAND_COOLDOWN_MS,
  });
}

function normalizeGuildList(guilds, config, sessionUser) {
  return guilds
    .filter((guild) => hasGuildAccess(guild, config, sessionUser))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function formatDashboardError(error) {
  if (error?.userFacingMessage) {
    return error.userFacingMessage;
  }

  return "Something went wrong. Please try again.";
}

async function getDiscordAccessToken(req, config) {
  const oauth = req.session.oauth;
  if (!oauth?.accessToken) {
    return null;
  }

  const expiresAt = oauth.expiresAt ?? 0;
  if (expiresAt > Date.now() + 60_000) {
    return oauth.accessToken;
  }

  if (!oauth.refreshToken) {
    throw Object.assign(new Error("Your Discord session expired. Please log in again."), {
      userFacingMessage: "Your Discord session expired. Please log in again.",
    });
  }

  const refreshed = await refreshAccessToken(config, oauth.refreshToken);
  req.session.oauth = {
    accessToken: refreshed.access_token,
    refreshToken: refreshed.refresh_token ?? oauth.refreshToken,
    expiresAt: Date.now() + (refreshed.expires_in ?? 0) * 1000,
  };

  return req.session.oauth.accessToken;
}

async function loadSessionGuilds(req, config) {
  const cachedGuilds = req.session.guilds ?? [];
  const lastFetchedAt = req.session.guildsFetchedAt ?? 0;
  const cacheAgeMs = Date.now() - lastFetchedAt;

  if (cachedGuilds.length > 0 && cacheAgeMs >= 0 && cacheAgeMs < config.DASHBOARD_GUILD_CACHE_MS) {
    return cachedGuilds;
  }

  const accessToken = await getDiscordAccessToken(req, config);
  if (!accessToken) {
    return cachedGuilds;
  }

  try {
    const guilds = await fetchDiscordResource("/users/@me/guilds", accessToken);
    req.session.guilds = guilds;
    req.session.guildsFetchedAt = Date.now();
    return guilds;
  } catch (error) {
    if (error?.status === 429 && cachedGuilds.length > 0) {
      console.warn(
        `[MOON] Discord guild refresh hit rate limit; reusing cached guilds for ${Math.max(
          0,
          Math.ceil(error.retryAfterSeconds ?? 0)
        )}s.`
      );
      return cachedGuilds;
    }

    throw error;
  }
}

function createWebApp({ config, store }) {
  const app = express();
  const PgSessionStore = pgSession(session);
  const sessionStore = config.DATABASE_URL
    ? new PgSessionStore({
        conObject: {
          connectionString: config.DATABASE_URL,
          ssl: config.isProduction ? { rejectUnauthorized: false } : false,
        },
        createTableIfMissing: true,
        tableName: "web_sessions",
      })
    : undefined;

  app.set("view engine", "ejs");
  app.set("views", path.join(process.cwd(), "views"));
  app.set("trust proxy", 1);

  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
    })
  );
  app.use("/static", express.static(path.join(process.cwd(), "public")));
  app.use(express.urlencoded({ extended: false }));
  app.use(
    session({
      name: "moon.sid",
      secret: config.SESSION_SECRET,
      store: sessionStore,
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        sameSite: "lax",
        secure: config.isProduction,
        maxAge: 1000 * 60 * 60 * 12,
      },
    })
  );

  app.use((req, res, next) => {
    res.locals.currentUser = req.session.user ?? null;
    res.locals.appBaseUrl = config.appBaseUrl;
    res.locals.botInviteUrl = buildBotInviteUrl(config);
    res.locals.csrfToken = ensureCsrfToken(req);
    next();
  });

  app.get("/healthz", (req, res) => {
    res.status(200).json({ ok: true });
  });

  app.get("/", (req, res) => {
    res.render("home", {
      title: "MOON Control",
      loggedIn: Boolean(req.session.user),
    });
  });

  app.get("/login", (req, res) => {
    const state = crypto.randomBytes(16).toString("hex");
    req.session.oauthState = state;

    const params = new URLSearchParams({
      client_id: config.DISCORD_CLIENT_ID,
      response_type: "code",
      redirect_uri: config.oauthRedirectUri,
      scope: "identify guilds",
      prompt: "consent",
      state,
    });

    res.redirect(`https://discord.com/oauth2/authorize?${params.toString()}`);
  });

  app.get("/auth/discord/callback", async (req, res, next) => {
    try {
      if (!req.query.code || !req.query.state || req.query.state !== req.session.oauthState) {
        res.status(400).send("Invalid OAuth state.");
        return;
      }

      const tokenResponse = await exchangeCodeForToken(config, req.query.code);
      const [user, guilds] = await Promise.all([
        fetchDiscordResource("/users/@me", tokenResponse.access_token),
        fetchDiscordResource("/users/@me/guilds", tokenResponse.access_token),
      ]);

      req.session.user = {
        id: user.id,
        username: user.username,
        globalName: user.global_name,
        avatar: user.avatar,
        avatarUrl: avatarUrl(user),
      };
      req.session.guilds = guilds;
      req.session.oauth = {
        accessToken: tokenResponse.access_token,
        refreshToken: tokenResponse.refresh_token,
        expiresAt: Date.now() + (tokenResponse.expires_in ?? 0) * 1000,
      };
      delete req.session.oauthState;

      res.redirect("/dashboard");
    } catch (error) {
      next(error);
    }
  });

  app.get("/logout", (req, res) => {
    req.session.destroy(() => {
      res.redirect("/");
    });
  });

  app.get("/dashboard", requireAuth, async (req, res, next) => {
    try {
      const sessionGuilds = await loadSessionGuilds(req, config);
      const accessibleGuilds = normalizeGuildList(sessionGuilds, config, req.session.user);
      const guilds = await Promise.all(
        accessibleGuilds.map(async (guild) => ({
          ...guild,
          inviteUrl: buildBotInviteUrl(config, guild.id),
          settings: await store.getGuildSettings(guild.id, guild.name, req.session.user.id),
        }))
      );

      res.render("dashboard", {
        title: "Dashboard",
        guilds,
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/guilds/:guildId", requireAuth, async (req, res, next) => {
    try {
      const sessionGuilds = await loadSessionGuilds(req, config);
      const guild = sessionGuilds.find((entry) => entry.id === req.params.guildId);
      if (!hasGuildAccess(guild, config, req.session.user)) {
        res.status(403).send("You do not have admin access to this server.");
        return;
      }

      const settings = await store.getGuildSettings(guild.id, guild.name, req.session.user.id);

      res.render("guild", {
        title: `${guild.name} Settings`,
        guild,
        inviteUrl: buildBotInviteUrl(config, guild.id),
        saved: req.query.saved === "1",
        settings,
        defaultSettings: createDefaultGuildSettings(guild.id, guild.name),
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/guilds/:guildId", requireAuth, requireCsrf, async (req, res, next) => {
    try {
      const sessionGuilds = await loadSessionGuilds(req, config);
      const guild = sessionGuilds.find((entry) => entry.id === req.params.guildId);
      if (!hasGuildAccess(guild, config, req.session.user)) {
        res.status(403).send("You do not have admin access to this server.");
        return;
      }

      const currentSettings = await store.getGuildSettings(guild.id, guild.name, req.session.user.id);
      const nextSettings = mapGuildForm(req, config, currentSettings);
      nextSettings.guildName = guild.name;
      await store.saveGuildSettings(nextSettings, req.session.user.id);

      res.redirect(`/guilds/${guild.id}?saved=1`);
    } catch (error) {
      next(error);
    }
  });

  app.use((error, req, res, next) => {
    console.error("[MOON] Dashboard error", error);

    res.status(500).render("home", {
      title: "MOON Control",
      loggedIn: Boolean(req.session.user),
      error: formatDashboardError(error),
    });
  });

  return {
    async start() {
      return new Promise((resolve) => {
        const server = app.listen(config.PORT, config.HOST, () => {
          console.log(`[MOON] Dashboard listening on ${config.HOST}:${config.PORT}`);
          resolve(server);
        });
      });
    },
  };
}

module.exports = {
  createWebApp,
};





