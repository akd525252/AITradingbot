# Gain EX — Hostinger Deployment Guide

This package contains the pre-configured deployment assets for **Gain EX**. It is set up to connect directly to **Supabase** for all database storage and functions.

---

## 📦 Deployment Instructions

### 1. Upload & Extract
1. Upload the `gainexmarket-deploy.zip` archive to your Hostinger server (using Hostinger's **Node.js App Dashboard** or **File Manager / FTP** if using VPS).
2. Extract the contents into your application's root directory (e.g., `/home/username/public_html` or `/var/www/gainexmarket`).

### 2. Install Dependencies
Connect to your server via SSH, navigate to the application folder, and run:
```bash
npm install
```
> [!IMPORTANT]
> Do **NOT** copy or upload `node_modules` from your local machine. Hostinger servers run on Linux, and dependencies containing binary bindings (like `bcryptjs` or `sqlite3`) must be built specifically for Linux. Running `npm install` on the server ensures compatibility.

### 3. Environment Configuration
1. Copy the `.env.example` file to create a `.env` file:
   ```bash
   cp .env.example .env
   ```
2. Open `.env` and fill in your actual credentials:
   - **SUPABASE_URL**: Your Supabase project URL (e.g., `https://xxxx.supabase.co`).
   - **SUPABASE_ANON_KEY**: Your Supabase anonymous client API key.
   - **SUPABASE_SERVICE_ROLE_KEY**: Your Supabase service role key (crucial for bypassing RLS to perform admin functions).
   - **JWT_SECRET**: Set a secure, random cryptographic string to sign user auth tokens.
   - **SMTP Configuration**: Configure Gmail/SMTP keys to allow sending email verification codes.

### 4. Database Setup (Supabase)
If setting up a new Supabase database instance:
1. Go to your **Supabase Dashboard** -> **SQL Editor**.
2. Click **New query**.
3. Open the `supabase_schema.sql` file included in this deployment package.
4. Copy the entire contents of `supabase_schema.sql` and paste it into the Supabase SQL editor.
5. Click **Run** to create the tables, indexes, and the critical helper database function `exec_sql`.

### 5. Launching the App
Depending on your Hostinger hosting plan:

#### Option A: Hostinger Node.js Application Panel (Shared/Cloud Node.js Hosting)
1. Go to the **Node.js App** management panel in hPanel.
2. Set the **Application startup file** to: `server/index.js`.
3. Set the **Node.js version** (v18+ recommended).
4. Click **Start** or **Restart** to boot the application.

#### Option B: Hostinger VPS (Virtual Private Server)
If using a VPS with SSH access, use **PM2** to run the app in the background permanently:
1. Install PM2 globally:
   ```bash
   npm install -g pm2
   ```
2. Start the application:
   ```bash
   pm2 start server/index.js --name "gainexmarket"
   ```
3. Save the PM2 process list and configure it to run on system boot:
   ```bash
   pm2 save
   pm2 startup
   ```

---

## 🛠️ Verification
Once deployed and started:
- Access your domain to verify the website loads.
- Test user registration (ensure SMTP sends verification codes).
- Access the admin panel at `http://yourdomain.com/staff/` using your seeded administrator credentials to verify admin actions and database querying functions.
