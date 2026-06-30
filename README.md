# 🌉 OData Reverse Proxy: AppSheet ➔ Microsoft Dataverse

> An ultra-fast and lightweight Node.js reverse proxy built to solve the biggest integration headache between Google AppSheet and Microsoft Dataverse: **Authentication blocking**.

---

## 📋 Table of Contents
1. [Why does this project exist?](#1-why-does-this-project-exist)
2. [How the Magic Happens (Architecture)](#2-how-the-magic-happens-architecture)
3. [Step 1: Creating the App in Azure Entra ID](#3-step-1-creating-the-app-in-azure-entra-id)
4. [Step 2: Granting Permissions in Dataverse](#4-step-2-granting-permissions-in-dataverse)
5. [Step 3: Running the Proxy & Environment Variables](#5-step-3-running-the-proxy--environment-variables)
6. [Step 4: AppSheet Configuration (Golden Tips)](#6-step-4-appsheet-configuration-golden-tips)

---

## 1. Why does this project exist?
If you've ever tried to connect AppSheet natively to Dataverse (Dynamics 365), you've probably hit a wall. 
AppSheet's standard OData connector only supports **Basic Authentication** (Username and Password), but Microsoft's API (Dataverse) is modern and strictly requires **OAuth 2.0 (Bearer Token)** for Server-to-Server (S2S) connections.

This project is the bridge connecting both worlds. It pretends to be Dataverse to AppSheet, and pretends to be AppSheet to Dataverse.

---

## 2. How the Magic Happens (Architecture)
The journey of a request (creating, reading, updating, or deleting data) goes like this:

1. **The AppSheet Call:** AppSheet fires an OData v4 request pointing to this Proxy's URL, sending a simple Basic Auth header (which you define).
2. **The Gatekeeper:** The Proxy holds the request and verifies if the username and password match your `.env` file. If it fails, it returns a friendly block asking for the correct credentials.
3. **The Token Quest:** If the password is correct, the Proxy checks its RAM. If it holds an active Microsoft token, it uses it. If the token doesn't exist or is about to expire, it silently goes to Azure AD, grabs a fresh token, and stores it in memory for future requests.
4. **Translation & Scrubbing:** 
   - The Proxy strips the Basic Auth header (Microsoft would reject it).
   - It injects the official Token (`Bearer`).
   - It normalizes legacy URL formats sent by AppSheet (removing quotes from GUIDs) and injects mandatory security headers for Updates (like `If-Match: *`).
5. **The Delivery:** The Proxy dispatches the perfectly crafted request to Microsoft. Dataverse processes it, returns the data, and the Proxy relays that exact response back to the user's screen in AppSheet.

---

## 3. Step 1: Creating the App in Azure Entra ID
For Microsoft to generate a Token and let our Proxy in, we need to create an "Identity" (App Registration) for it within Azure.

1. Go to the [Azure Portal](https://portal.azure.com/).
2. In the top search bar, look for and click on **Microsoft Entra ID** (formerly Azure Active Directory).
3. On the left menu, go to **App registrations** and click the **+ New registration** button.
4. Give it a name (e.g., `AppSheet Proxy Integrator`) and click **Register**.
5. **Save your IDs:** On the screen that opens, note down the **Application (client) ID** and the **Directory (tenant) ID**. We will need them for our environment variables.
6. **Creating the Secret:** On the left menu, click **Certificates & secrets**. Click **+ New client secret**. Give it a description, choose an expiration (e.g., 2 years) and click Add.
7. 🚨 **VERY IMPORTANT:** Copy the value from the **Value** column (not the Secret ID) immediately. It will be hidden forever once you leave the page. This is your `AZURE_CLIENT_SECRET`.

---

## 4. Step 2: Granting Permissions in Dataverse
Azure knows your Proxy exists, but the database (Dataverse) still won't let it read the tables. We need to invite this App into the CRM.

1. Go to the [Power Platform Admin Center](https://admin.powerplatform.microsoft.com/).
2. On the left menu, click **Environments** and select your environment's name.
3. On the top menu, click **Settings**.
4. Expand the **Users + permissions** section and click on **Application users**.
5. Click **+ New app user**.
6. Click **Add an app** and select the application you just created in Azure.
7. Select your **Business unit**.
8. Click the pencil icon on the **Security roles** tab and check the **System Administrator** permission (Or a custom role you've created to grant access to your tables).
9. Click **Save** and then **Create**. Done! The door is unlocked.

---

## 5. Step 3: Running the Proxy & Environment Variables

You can host this code on Render, Railway, AWS, Heroku, or your own machine. It's super lightweight (<40MB RAM).

### Required Environment Variables (`.env`)

Create a `.env` file in the root of the project, or place these keys in your server's dashboard (e.g., Render):

```env
# The port where the Proxy will run (Render injects this automatically)
PORT=3000

# Choose a username and password that AppSheet will use to hit the Proxy
APPSHEET_USER=my_secret_user
APPSHEET_PASS=my_password_123

# IDs you copied in Step 1 (Azure)
AZURE_TENANT_ID=00000000-0000-0000-0000-000000000000
AZURE_CLIENT_ID=00000000-0000-0000-0000-000000000000
AZURE_CLIENT_SECRET=value_of_the_client_secret

# The base URL of your Dataverse environment (no trailing slashes)
DATAVERSE_ORG_URL=https://orgXXXXXXXX.api.crm.dynamics.com

# Optional: If a critical error occurs, the proxy sends a POST to this webhook
WEBHOOK_ERROR=https://your-hook.make.com/xxx
# Optional: Set to 'true' to see all incoming requests in the terminal console
ENABLE_DEBUG_LOGS=false
```

### Running
```bash
npm install
npm start
```
*If you're deploying on Render's Free tier, remember to set up a free service like cron-job.org to "ping" the `https://your-url.onrender.com/health` route every 10 minutes, preventing the server from hibernating.*

---

## 6. Step 4: AppSheet Configuration (Golden Tips)

In the Google AppSheet dashboard, create the connection:
1. Go to **Data** -> **New Data Source** -> **OData**.
2. **Version:** `v4`
3. **URL:** `https://your-proxy-url-on-render.com/api/data/v9.2`
4. **Auth:** `Basic` (Enter the username and password you invented for `APPSHEET_USER`).

### 🥇 The Secret of the GUID (Primary Key)
Dataverse strictly requires the primary key column to be a **perfect 36-character GUID**. By default, AppSheet tries to send short 8-letter codes, and Microsoft returns a format error.
To fix this:
1. In your AppSheet table settings, find the primary ID column (e.g., `accountid`).
2. Check the **`Key?`** box and uncheck the **`Show?`** box (your user doesn't need to see this).
3. In the **`INITIAL VALUE`** field, enter exactly this formula:
   ```text
   UNIQUEID("UUID")
   ```
   *This forces AppSheet to generate an official GUID (e.g., `123e4567-e89b...`) that Microsoft accepts.*

### 🛡️ Hiding System Columns (Audit Fields)
Dataverse automatically generates columns like `createdby`, `modifiedby`, `versionnumber`, etc. AppSheet thinks they are mandatory and checks the `Require?` box. 
If AppSheet tries to send data to these columns, Dataverse will deny access because they are read-only.
**Solution:** Always uncheck the `Require?`, `Editable?`, and `Show?` boxes for all these native Microsoft audit columns. Let the database fill them in itself!
