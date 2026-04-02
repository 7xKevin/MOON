const crypto = require("node:crypto");
const path = require("node:path");
const express = require("express");
const session = require("express-session");
const pgSession = require("connect-pg-simple");
const helmet = require("helmet");

const DISCORD_API_BASE = "https://discord.com/api/v10";

function avatarUrl(user) {
  if (!user?.avatar) {
    return null;
  }

  return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128`;
}

function isSuperAdmin(config, user) {
  return Boolean(user && config.DASHBOARD_SUPER_ADMIN_IDS.includes(user.id));
}

function ensureCsrfToken(req) {
  if (!req.session) {
    return "";
  }

  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(24).toString("hex");
  }

  return req.session.csrfToken;
}

function requireAuth(req, res, next) {
  if (!req.session?.user) {
    res.redirect("/");
    return;
  }

  next();
}

function requireSuperAdmin(req, res, next) {
  if (!isSuperAdmin(req.app.locals.config, req.session?.user)) {
    res.status(403).render("admin-home", {
      title: "MOON ADMIN",
      loggedIn: Boolean(req.session?.user),
      error: "Only configured MOON super admins can access MOON ADMIN.",
    });
    return;
  }

  next();
}

function requireCsrf(req, res, next) {
  if (!req.session?.csrfToken || req.body?.csrfToken !== req.session.csrfToken) {
    res.status(403).send("Invalid CSRF token.");
    return;
  }

  next();
}

function parseBoolean(value) {
  return value === "on" || value === "true" || value === true;
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

async function fetchDiscordResource(pathname, accessToken) {
  const response = await fetch(`${DISCORD_API_BASE}${pathname}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Discord API request failed for ${pathname} with status ${response.status}.`);
  }

  return response.json();
}

function mapAdminForm(req, existingSettings) {
  return {
    ...existingSettings,
    globalBotEnabled: parseBoolean(req.body.globalBotEnabled),
    userDashboardEnabled: parseBoolean(req.body.userDashboardEnabled),
    preferredSttProvider: req.body.preferredSttProvider,
    groqSttModel: req.body.groqSttModel,
    deepgramSttModel: req.body.deepgramSttModel,
    defaultWakeWord: req.body.defaultWakeWord,
    defaultRequireWakeWord: parseBoolean(req.body.defaultRequireWakeWord),
    defaultTranscriptionSilenceMs: req.body.defaultTranscriptionSilenceMs,
    defaultCommandCooldownMs: req.body.defaultCommandCooldownMs,
  };
}

function formatAdminError(error) {
  if (error?.userFacingMessage) {
    return error.userFacingMessage;
  }

  return "Something went wrong in MOON ADMIN. Please try again.";
}

function createAdminApp({ config, store }) {
  const app = express();
  app.locals.config = config;

  const PgSessionStore = pgSession(session);
  const sessionStore = config.DATABASE_URL
    ? new PgSessionStore({
        conObject: {
          connectionString: config.DATABASE_URL,
          ssl: config.isProduction ? { rejectUnauthorized: false } : false,
        },
        createTableIfMissing: true,
        tableName: "admin_sessions",
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
      name: "moon.admin.sid",
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
    res.locals.csrfToken = ensureCsrfToken(req);
    res.locals.adminAppBaseUrl = config.appBaseUrl;
    res.locals.userDashboardUrl = config.USER_DASHBOARD_URL ?? null;
    next();
  });

  app.get("/healthz", (req, res) => {
    res.status(200).json({ ok: true, mode: "admin" });
  });

  app.get("/", (req, res) => {
    if (isSuperAdmin(config, req.session.user)) {
      res.redirect("/dashboard");
      return;
    }

    res.render("admin-home", {
      title: "MOON ADMIN",
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
      scope: "identify",
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
      const user = await fetchDiscordResource("/users/@me", tokenResponse.access_token);

      req.session.user = {
        id: user.id,
        username: user.username,
        globalName: user.global_name,
        avatar: user.avatar,
        avatarUrl: avatarUrl(user),
      };
      delete req.session.oauthState;

      if (!isSuperAdmin(config, req.session.user)) {
        res.status(403).render("admin-home", {
          title: "MOON ADMIN",
          loggedIn: Boolean(req.session.user),
          error: "This Discord account is not configured as a MOON super admin.",
        });
        return;
      }

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

  app.get("/dashboard", requireAuth, requireSuperAdmin, async (req, res, next) => {
    try {
      const globalSettings = await store.getGlobalAdminSettings();

      res.render("admin-dashboard", {
        title: "MOON ADMIN",
        saved: req.query.saved === "1",
        settings: globalSettings,
        systemStatus: {
          hasGroqStt: config.hasGroqStt,
          hasDeepgramStt: config.hasDeepgramStt,
          hasLocalWhisper: config.hasLocalWhisper,
          currentGroqModel: config.GROQ_STT_MODEL,
          currentDeepgramModel: config.DEEPGRAM_STT_MODEL,
        },
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/dashboard", requireAuth, requireSuperAdmin, requireCsrf, async (req, res, next) => {
    try {
      const current = await store.getGlobalAdminSettings();
      await store.saveGlobalAdminSettings(mapAdminForm(req, current));

      if (req.get("x-requested-with") === "fetch" || req.accepts("json") === "json") {
        res.json({ ok: true, message: "Admin settings saved." });
        return;
      }

      res.redirect("/dashboard?saved=1");
    } catch (error) {
      next(error);
    }
  });

  app.use((error, req, res, next) => {
    console.error("[MOON ADMIN] Dashboard error", error);

    if (req.get("x-requested-with") === "fetch" || req.accepts("json") === "json") {
      res.status(500).json({ ok: false, error: formatAdminError(error) });
      return;
    }

    res.status(500).render("admin-home", {
      title: "MOON ADMIN",
      loggedIn: Boolean(req.session?.user),
      error: formatAdminError(error),
    });
  });

  return {
    async start() {
      return new Promise((resolve) => {
        const server = app.listen(config.PORT, config.HOST, () => {
          console.log(`[MOON ADMIN] Dashboard listening on ${config.HOST}:${config.PORT}`);
          resolve(server);
        });
      });
    },
  };
}

module.exports = {
  createAdminApp,
};
