import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

const {
  DATAVERSE_ORG_URL: envDataverseUrl,
  AZURE_TENANT_ID,
  AZURE_CLIENT_ID,
  AZURE_CLIENT_SECRET,
  APPSHEET_USER,
  APPSHEET_PASS,
  WEBHOOK_ERROR,
  ENABLE_DEBUG_LOGS
} = process.env;

if (!envDataverseUrl || !AZURE_TENANT_ID || !AZURE_CLIENT_ID || !AZURE_CLIENT_SECRET || !APPSHEET_USER || !APPSHEET_PASS) {
  console.error("[System] FATAL: Missing required environment variables.");
  process.exit(1);
}

// Remove trailing slash if the user provided one
const DATAVERSE_ORG_URL = envDataverseUrl.replace(/\/$/, '');

// --- Webhook Error Reporter ---
const notifyError = async (context, errDetails) => {
  if (!WEBHOOK_ERROR) return;
  try {
    const payload = {
      text: `🚨 *OData Proxy Error*\n*Context:* ${context}\n*Details:* ${errDetails}`
    };
    await fetch(WEBHOOK_ERROR, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch (webhookErr) {
    console.error(`[Webhook] Failed to dispatch error alert: ${webhookErr.message}`);
  }
};

// Global error handlers to prevent silent crashes
process.on('uncaughtException', (err) => {
  console.error('[System] Uncaught Exception:', err);
  notifyError('uncaughtException', err.message);
});

process.on('unhandledRejection', (reason) => {
  console.error('[System] Unhandled Rejection:', reason);
  notifyError('unhandledRejection', reason instanceof Error ? reason.message : String(reason));
});

// --- Global Request Logger (DEBUG) ---
app.use((req, res, next) => {
  if (ENABLE_DEBUG_LOGS === 'true') {
    console.log(`[->] ${req.method} ${req.url}`);
  }
  next();
});

// --- Healthcheck ---
app.get('/health', (req, res) => res.status(200).json({ status: 'ok', ts: Date.now() }));

// --- Auth Middleware (AppSheet Basic Auth) ---
const basicAuth = (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Basic ')) {
      // The HTTP standard requires the WWW-Authenticate header so the client
      // knows it must send credentials (fixes missing auth on methods like DELETE)
      res.setHeader('WWW-Authenticate', 'Basic realm="OData Proxy"');
      return res.status(401).send('Unauthorized');
    }

    const base64 = authHeader.split(' ')[1];
    if (!base64) {
      res.setHeader('WWW-Authenticate', 'Basic realm="OData Proxy"');
      return res.status(401).send('Unauthorized');
    }

    const decoded = Buffer.from(base64, 'base64').toString('ascii');
    const [user, pass] = decoded.split(':');

    if (user !== APPSHEET_USER || pass !== APPSHEET_PASS) {
      res.setHeader('WWW-Authenticate', 'Basic realm="OData Proxy"');
      return res.status(401).send('Unauthorized');
    }

    next();
  } catch (err) {
    console.error('[Auth] Basic auth parsing error:', err.message);
    res.status(400).send('Bad Request');
  }
};

// --- Token Manager (Azure AD OAuth2) ---
const tokenState = {
  value: null,
  expiresAt: 0
};

const getAccessToken = async () => {
  const now = Date.now();
  // 2-minute buffer to avoid expiration during an in-flight request
  if (tokenState.value && tokenState.expiresAt > now + 120000) {
    return tokenState.value;
  }

  const endpoint = `https://login.microsoftonline.com/${AZURE_TENANT_ID}/oauth2/v2.0/token`;
  const params = new URLSearchParams({
    client_id: AZURE_CLIENT_ID,
    client_secret: AZURE_CLIENT_SECRET,
    grant_type: 'client_credentials',
    scope: `${DATAVERSE_ORG_URL}/.default`
  });

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`HTTP ${response.status} - ${errText}`);
    }

    const data = await response.json();
    tokenState.value = data.access_token;
    tokenState.expiresAt = now + (data.expires_in * 1000);

    return tokenState.value;
  } catch (err) {
    const errorMsg = err.name === 'AbortError' ? 'Token request timed out' : err.message;
    console.error('[OAuth] Token fetch failed:', errorMsg);
    notifyError('AzureAD_Token_Fetch', errorMsg);
    throw err;
  }
};

const injectBearer = async (req, res, next) => {
  try {
    req.dvToken = await getAccessToken();
    next();
  } catch (err) {
    res.status(500).json({ error: 'Internal Server Error', message: 'Failed to authenticate with downstream service' });
  }
};

// --- Proxy Core ---
const proxyMiddleware = createProxyMiddleware({
  target: DATAVERSE_ORG_URL,
  changeOrigin: true,
  pathRewrite: (path, req) => {
    // AppSheet sometimes sends the GUID with single quotes: ('uuid')
    // OData v4 and Dataverse require the GUID to be unquoted: (uuid)
    // If sent with quotes, Dataverse returns 400 Bad Request on PATCH.
    return path.replace(/\('([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})'\)/g, '($1)');
  },
  on: {
    proxyReq: (proxyReq, req) => {
      // Clean up headers and inject new auth
      proxyReq.removeHeader('Authorization');

      if (req.dvToken) {
        proxyReq.setHeader('Authorization', `Bearer ${req.dvToken}`);
      }

      // Enforce OData standards for Dataverse compatibility
      if (!proxyReq.getHeader('OData-MaxVersion')) proxyReq.setHeader('OData-MaxVersion', '4.0');
      if (!proxyReq.getHeader('OData-Version')) proxyReq.setHeader('OData-Version', '4.0');
      if (!proxyReq.getHeader('Accept')) proxyReq.setHeader('Accept', 'application/json;odata.metadata=minimal');
      if (!proxyReq.getHeader('Prefer')) proxyReq.setHeader('Prefer', 'odata.include-annotations="none"');

      // Egress optimization: Force Dataverse to return compressed data (Gzip/Brotli)
      // We removed the 'odata.include-annotations="none"' because AppSheet relies on some metadata to parse the feed.
      if (!proxyReq.getHeader('Accept-Encoding')) {
        proxyReq.setHeader('Accept-Encoding', 'gzip, deflate, br');
      }

      // Dataverse requires If-Match for PATCH operations (Update) to prevent conflicts.
      // Since AppSheet doesn't send it, we inject If-Match: * to force the update.
      if (req.method === 'PATCH' && !proxyReq.getHeader('If-Match')) {
        proxyReq.setHeader('If-Match', '*');
      }
    },
    error: (err, req, res) => {
      console.error(`[Proxy] Forwarding error on ${req.url}:`, err.message);
      notifyError('Proxy_Forwarding_Error', `${req.url} - ${err.message}`);

      if (!res.headersSent) {
        res.status(502).json({ error: 'Bad Gateway', details: err.message });
      }
    }
  }
});

// Setup pipeline
app.use('/', basicAuth, injectBearer, proxyMiddleware);

app.listen(PORT, () => {
  console.log(`[System] OData Proxy running on port ${PORT}`);
  console.log(`[System] Target: ${DATAVERSE_ORG_URL}`);
});
