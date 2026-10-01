const dns = require('dns');
if (dns.setDefaultResultOrder) {
  dns.setDefaultResultOrder('ipv4first');
}

// sqlite3 and sqlite are loaded lazily below — only when no Supabase/PG credentials exist
const { Pool } = require('pg');
const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');

// Load environment variables from .env file if it exists
if (fs.existsSync(path.join(__dirname, '..', '.env'))) {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
}

let dbConnection = null;
let pgPool = null;

// Helper to convert SQLite SQL syntax & placeholders to PostgreSQL
function convertSqlForPg(sql) {
  let index = 1;
  // Replace ? placeholders with $1, $2, etc.
  let converted = sql.replace(/\?/g, () => `$${index++}`);
  
  // Replace SQLite specific INSERT OR IGNORE
  if (converted.toUpperCase().includes('INSERT OR IGNORE')) {
    converted = converted.replace(/INSERT OR IGNORE/gi, 'INSERT');
  }
  
  return converted;
}

// Safely escape and format SQL parameters for PostgREST RPC
// Single-pass replacement prevents bcrypt hashes (e.g. $2b$10$...) from being
// re-scanned and corrupted when later $N placeholders are substituted sequentially.
function fillParams(sql, params) {
  if (!params || params.length === 0) return sql;
  return sql.replace(/\$(\d+)\b/g, (match, numStr) => {
    const idx = parseInt(numStr, 10) - 1; // $1 → index 0
    if (idx < 0 || idx >= params.length) return match;
    const val = params[idx];
    if (val === null || val === undefined) return 'NULL';
    if (typeof val === 'number') return String(val);
    if (typeof val === 'boolean') return val ? 'TRUE' : 'FALSE';
    return `'${String(val).replace(/'/g, "''")}'`;
  });
}

function isTransactionCommand(sql) {
  if (typeof sql !== 'string') return false;
  const clean = sql.trim().toUpperCase();
  return clean === 'BEGIN' || 
         clean === 'BEGIN TRANSACTION' || 
         clean === 'START TRANSACTION' || 
         clean === 'COMMIT' || 
         clean === 'COMMIT TRANSACTION' || 
         clean === 'END' || 
         clean === 'ROLLBACK' || 
         clean === 'ROLLBACK TRANSACTION';
}

async function executeWithRetry(fn, retries = 3, delay = 200) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fn();
      if (res && res.error) {
        const errMsg = String(res.error.message || '');
        if (errMsg.includes('fetch failed') || errMsg.includes('fetch') || errMsg.includes('TypeError')) {
          console.warn(`[DB RETRY] Database query failed with transient network error (attempt ${i + 1}/${retries}): ${errMsg}`);
          await new Promise(resolve => setTimeout(resolve, delay * (i + 1)));
          continue;
        }
      }
      return res;
    } catch (err) {
      const errMsg = String(err.message || '');
      if (errMsg.includes('fetch failed') || errMsg.includes('fetch') || errMsg.includes('TypeError') || err instanceof TypeError) {
        console.warn(`[DB RETRY] Database query threw transient network error (attempt ${i + 1}/${retries}): ${errMsg}`);
        await new Promise(resolve => setTimeout(resolve, delay * (i + 1)));
        continue;
      }
      throw err;
    }
  }
  return fn(); // Last attempt
}

// In-memory cache for database settings queries to optimize performance and prevent Supabase rate limits
const settingsQueryCache = {};
const SETTINGS_CACHE_TTL = 10000; // 10 seconds

function wrapDbWithCache(db) {
  if (!db || db.__isCached) return db;
  
  const originalGet = db.get.bind(db);
  const originalAll = db.all.bind(db);
  const originalRun = db.run.bind(db);
  
  db.get = async function(sql, ...params) {
    if (typeof sql === 'string') {
      const sqlLower = sql.toLowerCase();
      if (sqlLower.includes('select') && (sqlLower.includes('settings') || sqlLower.includes('trade_options'))) {
        const cacheKey = JSON.stringify({ sql, params });
        const cached = settingsQueryCache[cacheKey];
        const now = Date.now();
        if (cached && (now - cached.timestamp < SETTINGS_CACHE_TTL)) {
          return cached.data;
        }
        const result = await originalGet(sql, ...params);
        settingsQueryCache[cacheKey] = {
          data: result,
          timestamp: Date.now()
        };
        return result;
      }
    }
    return originalGet(sql, ...params);
  };
  
  db.all = async function(sql, ...params) {
    if (typeof sql === 'string') {
      const sqlLower = sql.toLowerCase();
      if (sqlLower.includes('select') && (sqlLower.includes('settings') || sqlLower.includes('trade_options'))) {
        const cacheKey = JSON.stringify({ sql, params });
        const cached = settingsQueryCache[cacheKey];
        const now = Date.now();
        if (cached && (now - cached.timestamp < SETTINGS_CACHE_TTL)) {
          return cached.data;
        }
        const result = await originalAll(sql, ...params);
        settingsQueryCache[cacheKey] = {
          data: result,
          timestamp: Date.now()
        };
        return result;
      }
    }
    return originalAll(sql, ...params);
  };
  
  db.run = async function(sql, ...params) {
    const result = await originalRun(sql, ...params);
    if (typeof sql === 'string') {
      const sqlLower = sql.toLowerCase();
      if ((sqlLower.includes('insert') || sqlLower.includes('update') || sqlLower.includes('delete')) && (sqlLower.includes('settings') || sqlLower.includes('trade_options'))) {
        // Invalidate settings cache
        for (const key in settingsQueryCache) {
          delete settingsQueryCache[key];
        }
      }
    }
    return result;
  };
  
  db.__isCached = true;
  return db;
}

async function getDB() {
  if (dbConnection) return dbConnection;

  const dbUrl = process.env.DATABASE_URL;
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  // 1. Direct PG Pool connection if DATABASE_URL is set
  if (dbUrl) {
    console.log('Connecting to PostgreSQL/Supabase database directly...');
    try {
      const tempPool = new Pool({
        connectionString: dbUrl,
        ssl: { rejectUnauthorized: false },
        connectionTimeoutMillis: 4000,
        idleTimeoutMillis: 10000
      });
      
      // Test the pool connection with a quick query
      await tempPool.query('SELECT 1');
      console.log('Direct PostgreSQL/Supabase connection tested and verified.');
      pgPool = tempPool;

      const dbWrapper = {
        isPg: true,
        
        async get(sql, params = []) {
          if (typeof sql === 'string') sql = sql.trim();
          if (isTransactionCommand(sql)) return undefined;
          const pgSql = convertSqlForPg(sql);
          const res = await pgPool.query(pgSql, params);
          return res.rows[0];
        },

        async all(sql, params = []) {
          if (typeof sql === 'string') sql = sql.trim();
          if (isTransactionCommand(sql)) return [];
          const pgSql = convertSqlForPg(sql);
          const res = await pgPool.query(pgSql, params);
          return res.rows;
        },

        async run(sql, params = []) {
          if (typeof sql === 'string') sql = sql.trim();
          if (isTransactionCommand(sql)) {
            return { lastID: null, changes: 0 };
          }
          let pgSql = convertSqlForPg(sql);
          const isInsert = pgSql.trim().toUpperCase().startsWith('INSERT');
          if (isInsert && !pgSql.toUpperCase().includes('RETURNING')) {
            if (pgSql.toUpperCase().includes('INTO SETTINGS')) {
              pgSql += ' RETURNING key';
            } else if (pgSql.toUpperCase().includes('INTO PERMISSIONS')) {
              pgSql += ' RETURNING user_id';
            } else if (pgSql.toUpperCase().includes('INTO OTC_PAIRS')) {
              pgSql += ' RETURNING symbol';
            } else {
              pgSql += ' RETURNING id';
            }
          }
          const res = await pgPool.query(pgSql, params);
          return {
            lastID: res.rows && res.rows[0] ? (res.rows[0].id ? Number(res.rows[0].id) : res.rows[0].user_id || res.rows[0].key || res.rows[0].symbol || null) : null,
            changes: res.rowCount
          };
        },

        async exec(sql) {
          if (typeof sql === 'string') sql = sql.trim();
          const queries = sql.split(';').map(q => q.trim()).filter(q => q.length > 0);
          for (const query of queries) {
            if (isTransactionCommand(query)) continue;
            const pgSql = convertSqlForPg(query);
            await pgPool.query(pgSql);
          }
        }
      };

      dbConnection = wrapDbWithCache(dbWrapper);
      return dbConnection;
    } catch (pgError) {
      console.warn('[DB WARNING] Direct PostgreSQL connection test failed:', pgError.message);
      console.warn('Falling back to Supabase API Client connection...');
      pgPool = null;
      // Do not return here, fall through to the API connection (Step 2)
    }
  }

  // 2. Supabase API connection via Client RPC fallback
  if (supabaseUrl && supabaseServiceKey) {
    console.log('Connecting to Supabase via API Client (exec_sql RPC)...');
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const dbWrapper = {
      isPg: true,
      isSupabaseApi: true,
      
      async get(sql, params = []) {
        if (typeof sql === 'string') sql = sql.trim();
        if (isTransactionCommand(sql)) return undefined;
        const pgSql = convertSqlForPg(sql);
        const queryWithParams = fillParams(pgSql, params);
        const { data, error } = await executeWithRetry(() =>
          supabase.rpc('exec_sql', { query_text: queryWithParams })
        );
        if (error) {
          console.error('exec_sql RPC error:', error.message, 'SQL:', queryWithParams);
          throw new Error(error.message);
        }
        return data && data[0] ? data[0] : undefined;
      },

      async all(sql, params = []) {
        if (typeof sql === 'string') sql = sql.trim();
        if (isTransactionCommand(sql)) return [];
        const pgSql = convertSqlForPg(sql);
        const queryWithParams = fillParams(pgSql, params);
        const { data, error } = await executeWithRetry(() =>
          supabase.rpc('exec_sql', { query_text: queryWithParams })
        );
        if (error) {
          console.error('exec_sql RPC error:', error.message, 'SQL:', queryWithParams);
          throw new Error(error.message);
        }
        return data || [];
      },

      async run(sql, params = []) {
        if (typeof sql === 'string') sql = sql.trim();
        if (isTransactionCommand(sql)) {
          return { lastID: null, changes: 0 };
        }
        let pgSql = convertSqlForPg(sql);
        const isInsert = pgSql.trim().toUpperCase().startsWith('INSERT');
        if (isInsert && !pgSql.toUpperCase().includes('RETURNING')) {
          if (pgSql.toUpperCase().includes('INTO SETTINGS')) {
            pgSql += ' RETURNING key';
          } else if (pgSql.toUpperCase().includes('INTO PERMISSIONS')) {
            pgSql += ' RETURNING user_id';
          } else if (pgSql.toUpperCase().includes('INTO OTC_PAIRS')) {
            pgSql += ' RETURNING symbol';
          } else {
            pgSql += ' RETURNING id';
          }
        }
        const queryWithParams = fillParams(pgSql, params);
        const { data, error } = await executeWithRetry(() =>
          supabase.rpc('exec_sql', { query_text: queryWithParams })
        );
        if (error) {
          console.error('exec_sql RPC error:', error.message, 'SQL:', queryWithParams);
          throw new Error(error.message);
        }
        return {
          lastID: data && data[0] ? (data[0].id ? Number(data[0].id) : data[0].user_id || data[0].key || data[0].symbol || null) : null,
          changes: data ? data.length : 0
        };
      },

      async exec(sql) {
        if (typeof sql === 'string') sql = sql.trim();
        const queries = sql.split(';').map(q => q.trim()).filter(q => q.length > 0);
        for (const query of queries) {
          if (isTransactionCommand(query)) continue;
          const pgSql = convertSqlForPg(query);
          const { error } = await executeWithRetry(() =>
            supabase.rpc('exec_sql', { query_text: pgSql })
          );
          if (error) {
            console.error('exec_sql RPC error:', error.message, 'SQL:', pgSql);
            throw new Error(error.message);
          }
        }
      }
    };

    dbConnection = wrapDbWithCache(dbWrapper);
    return dbConnection;
  }

  // 3. Local SQLite Fallback (only used in local development without Supabase)
  console.log('No Supabase credentials set. Falling back to local SQLite...');
  let sqlite3, sqliteOpen;
  try {
    sqlite3 = require('sqlite3');
    sqliteOpen = require('sqlite').open;
  } catch (e) {
    throw new Error('No Supabase credentials found and sqlite3 is not installed. Please set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY environment variables.');
  }
  const dbFile = fs.existsSync('/data')
    ? '/data/database.sqlite'
    : path.join(__dirname, '..', 'database.sqlite');

  const db = await sqliteOpen({
    filename: dbFile,
    driver: sqlite3.Database
  });

  await db.run("PRAGMA busy_timeout = 10000");

  let currentTransaction = Promise.resolve();
  let resolveTransaction = null;
  let inTransaction = false;

  const originalRun = db.run.bind(db);
  db.run = async function(sql, ...params) {
    const sqlUpper = String(sql).trim().toUpperCase();
    if (sqlUpper.startsWith('BEGIN')) {
      await currentTransaction;
      inTransaction = true;
      currentTransaction = new Promise(resolve => {
        resolveTransaction = resolve;
      });
    }

    try {
      const result = await originalRun(sql, ...params);
      if (inTransaction && (sqlUpper === 'COMMIT' || sqlUpper === 'ROLLBACK')) {
        inTransaction = false;
        if (resolveTransaction) {
          resolveTransaction();
          resolveTransaction = null;
        }
      }
      return result;
    } catch (err) {
      if (inTransaction && (sqlUpper === 'COMMIT' || sqlUpper === 'ROLLBACK' || sqlUpper.startsWith('BEGIN'))) {
        inTransaction = false;
        if (resolveTransaction) {
          resolveTransaction();
          resolveTransaction = null;
        }
      }
      if (sqlUpper === 'ROLLBACK' && err.message.includes('cannot rollback')) {
        return; // Ignore safe rollback failures
      }
      throw err;
    }
  };

  dbConnection = wrapDbWithCache(db);
  return dbConnection;
}

async function initDB() {
  const db = await getDB();

  if (db.isPg) {
    try {
      await db.get('SELECT 1');
      console.log('PostgreSQL database connection verified successfully.');

      // PostgreSQL Migration: Ensure full_name column exists in users table
      try {
        await db.run('ALTER TABLE users ADD COLUMN IF NOT EXISTS full_name VARCHAR(255)');
        console.log('PostgreSQL: full_name column verified/added successfully.');
      } catch (colErr) {
        console.error('PostgreSQL: Failed to ensure full_name column:', colErr.message);
      }

      // PostgreSQL Migration: Ensure is_test column exists in users table
      try {
        await db.run('ALTER TABLE users ADD COLUMN IF NOT EXISTS is_test BOOLEAN DEFAULT FALSE');
        console.log('PostgreSQL: is_test column verified/added successfully.');
      } catch (colErr) {
        console.error('PostgreSQL: Failed to ensure is_test column:', colErr.message);
      }

      // PostgreSQL Migration: Ensure google_id column exists in users table
      try {
        await db.run('ALTER TABLE users ADD COLUMN IF NOT EXISTS google_id VARCHAR(255) DEFAULT NULL UNIQUE');
        console.log('PostgreSQL: google_id column verified/added successfully.');
      } catch (colErr) {
        console.error('PostgreSQL: Failed to ensure google_id column:', colErr.message);
      }

      // PostgreSQL Migration: Ensure username_last_changed column exists in users table
      try {
        await db.run('ALTER TABLE users ADD COLUMN IF NOT EXISTS username_last_changed TIMESTAMP DEFAULT NULL');
        console.log('PostgreSQL: username_last_changed column verified/added successfully.');
      } catch (colErr) {
        console.error('PostgreSQL: Failed to ensure username_last_changed column:', colErr.message);
      }

      // PostgreSQL Migration: Ensure last_seen_at column exists in users table
      try {
        await db.run('ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMP DEFAULT NULL');
        console.log('PostgreSQL: last_seen_at column verified/added successfully.');
      } catch (colErr) {
        console.error('PostgreSQL: Failed to ensure last_seen_at column:', colErr.message);
      }

      // PostgreSQL Migration: Ensure withdrawal_otp columns exist in users table
      try {
        await db.run('ALTER TABLE users ADD COLUMN IF NOT EXISTS withdrawal_otp VARCHAR(20)');
        await db.run('ALTER TABLE users ADD COLUMN IF NOT EXISTS withdrawal_otp_expires_at TIMESTAMP DEFAULT NULL');
        console.log('PostgreSQL: withdrawal_otp columns verified/added successfully.');
      } catch (colErr) {
        console.error('PostgreSQL: Failed to ensure withdrawal_otp columns:', colErr.message);
      }

      // PostgreSQL Migration: Ensure last_ip and last_country columns exist in users table
      try {
        await db.run('ALTER TABLE users ADD COLUMN IF NOT EXISTS last_ip TEXT DEFAULT NULL');
        await db.run('ALTER TABLE users ADD COLUMN IF NOT EXISTS last_country TEXT DEFAULT NULL');
        await db.run('ALTER TABLE users ADD COLUMN IF NOT EXISTS demo_trading_enabled INTEGER DEFAULT 1');
        await db.run('ALTER TABLE users ADD COLUMN IF NOT EXISTS custom_total_trades INTEGER DEFAULT NULL');
        await db.run('ALTER TABLE users ADD COLUMN IF NOT EXISTS custom_win_rate NUMERIC DEFAULT NULL');
        await db.run('ALTER TABLE users ADD COLUMN IF NOT EXISTS custom_net_pnl NUMERIC DEFAULT NULL');
        await db.run('ALTER TABLE users ADD COLUMN IF NOT EXISTS demo_custom_total_trades INTEGER DEFAULT NULL');
        await db.run('ALTER TABLE users ADD COLUMN IF NOT EXISTS demo_custom_win_rate NUMERIC DEFAULT NULL');
        await db.run('ALTER TABLE users ADD COLUMN IF NOT EXISTS demo_custom_net_pnl NUMERIC DEFAULT NULL');
        console.log('PostgreSQL: last_ip, last_country, demo_trading_enabled, and custom dashboard stats columns verified/added successfully.');
      } catch (colErr) {
        console.error('PostgreSQL: Failed to ensure last_ip/last_country/demo_trading_enabled/custom_stats columns:', colErr.message);
      }

      // PostgreSQL Migration: Drop CHECK constraint on deposits.method
      try {
        // Drop standard constraint name
        await db.run('ALTER TABLE deposits DROP CONSTRAINT IF EXISTS deposits_method_check');
        // Drop via generic search if name is different
        const dropConstraintQuery = `
          DO $$
          DECLARE
              r RECORD;
          BEGIN
              FOR r IN
                  SELECT tc.constraint_name
                  FROM information_schema.table_constraints tc
                  JOIN information_schema.constraint_column_usage ccu
                    ON tc.constraint_name = ccu.constraint_name
                    AND tc.table_schema = ccu.table_schema
                  WHERE tc.constraint_type = 'CHECK'
                    AND tc.table_name = 'deposits'
                    AND ccu.column_name = 'method'
              LOOP
                  EXECUTE 'ALTER TABLE deposits DROP CONSTRAINT ' || quote_ident(r.constraint_name);
              END LOOP;
          END $$;
        `;
        await db.run(dropConstraintQuery);
        console.log('PostgreSQL: deposits.method check constraint dropped successfully.');
      } catch (constrErr) {
        console.error('PostgreSQL: Failed to drop deposits.method check constraint:', constrErr.message);
      }
      // PostgreSQL Migration: Ensure activation_code column exists in visa_cards table
      try {
        await db.run('ALTER TABLE visa_cards ADD COLUMN IF NOT EXISTS activation_code VARCHAR(50)');
        console.log('PostgreSQL: activation_code column verified/added successfully.');
      } catch (colErr) {
        console.error('PostgreSQL: Failed to ensure activation_code column:', colErr.message);
      }
      try {
        await db.run('ALTER TABLE visa_cards ADD COLUMN IF NOT EXISTS is_blocked BOOLEAN DEFAULT FALSE');
        console.log('PostgreSQL: is_blocked column verified/added successfully.');
      } catch (colErr) {
        console.error('PostgreSQL: Failed to ensure is_blocked column:', colErr.message);
      }
      try {
        await db.run('ALTER TABLE visa_cards ADD COLUMN IF NOT EXISTS daily_limit INTEGER DEFAULT 2500');
        console.log('PostgreSQL: daily_limit column verified/added successfully.');
      } catch (colErr) {
        console.error('PostgreSQL: Failed to ensure daily_limit column:', colErr.message);
      }

      // PostgreSQL Migration: Drop and recreate CHECK constraint on visa_cards.status
      try {
        await db.run('ALTER TABLE visa_cards DROP CONSTRAINT IF EXISTS visa_cards_status_check');
        await db.run("ALTER TABLE visa_cards ADD CONSTRAINT visa_cards_status_check CHECK(status IN ('pending', 'preparing', 'shipping', 'delivered', 'active'))");
        console.log('PostgreSQL: visa_cards status check constraint updated successfully.');
      } catch (constrErr) {
        console.error('PostgreSQL: Failed to update visa_cards.status check constraint:', constrErr.message);
      }

      // PostgreSQL Migration: Ensure amount_usd column exists in trades table
      try {
        await db.run('ALTER TABLE trades ADD COLUMN IF NOT EXISTS amount_usd NUMERIC(15,2) DEFAULT NULL');
        console.log('PostgreSQL: amount_usd column verified/added successfully to trades table.');
      } catch (colErr) {
        console.error('PostgreSQL: Failed to ensure amount_usd column on trades table:', colErr.message);
      }

      // PostgreSQL Verification: Ensure currency column exists in trades table
      try {
        await db.run("ALTER TABLE trades ADD COLUMN IF NOT EXISTS currency VARCHAR(10) DEFAULT 'USD'");
        console.log('PostgreSQL: currency column verified/added successfully to trades table.');
      } catch (colErr) {
        console.error('PostgreSQL: Failed to ensure currency column on trades table:', colErr.message);
      }

      // PostgreSQL Verification: Ensure referrer_commission column exists in trades table
      try {
        await db.run("ALTER TABLE trades ADD COLUMN IF NOT EXISTS referrer_commission NUMERIC(15,2) DEFAULT NULL");
        console.log('PostgreSQL: referrer_commission column verified/added successfully to trades table.');
      } catch (colErr) {
        console.error('PostgreSQL: Failed to ensure referrer_commission column on trades table:', colErr.message);
      }

      // PostgreSQL Verification: Ensure is_bot column exists in trades table
      try {
        await db.run("ALTER TABLE trades ADD COLUMN IF NOT EXISTS is_bot INTEGER DEFAULT 0");
        console.log('PostgreSQL: is_bot column verified/added successfully to trades table.');
      } catch (colErr) {
        console.error('PostgreSQL: Failed to ensure is_bot column on trades table:', colErr.message);
      }

      // PostgreSQL Migration: Retroactively fill currency values for older trades using the amount to amount_usd ratio
      try {
        await db.run(`
          UPDATE trades
          SET currency = CASE
            WHEN amount_usd IS NULL OR amount_usd = 0 THEN 'USD'
            WHEN ABS(amount / amount_usd - 1.0) < 0.05 THEN 'USD'
            WHEN ABS(amount / amount_usd - 278.0) < 15.0 THEN 'PKR'
            WHEN ABS(amount / amount_usd - 84.0) < 5.0 THEN 'INR'
            WHEN ABS(amount / amount_usd - 117.0) < 5.0 THEN 'BDT'
            WHEN ABS(amount / amount_usd - 133.0) < 5.0 THEN 'NPR'
            ELSE 'USD'
          END
          WHERE currency IS NULL OR currency IN ('USD', 'EUR', 'GBP')
        `);
        console.log('PostgreSQL: Retroactive trade currency correction applied successfully.');
      } catch (err) {
        console.error('PostgreSQL: Failed to apply retroactive trade currency correction:', err.message);
      }

      // PostgreSQL Migration: Ensure signup_verifications table exists
      try {
        await db.run(`
          CREATE TABLE IF NOT EXISTS signup_verifications (
            email VARCHAR(255) PRIMARY KEY,
            code VARCHAR(20) NOT NULL,
            expires_at TIMESTAMP NOT NULL
          )
        `);
        console.log('PostgreSQL: signup_verifications table verified/created successfully.');
      } catch (tableErr) {
        console.error('PostgreSQL: Failed to ensure signup_verifications table:', tableErr.message);
      }

      // PostgreSQL Migration: Ensure quick_chats table exists (live support canned responses)
      try {
        await db.run(`
          CREATE TABLE IF NOT EXISTS quick_chats (
            id SERIAL PRIMARY KEY,
            agent_id INTEGER,
            title VARCHAR(120) NOT NULL,
            content TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT NOW(),
            updated_at TIMESTAMP DEFAULT NOW()
          );
        `);
        console.log('PostgreSQL: quick_chats table verified/created successfully.');
      } catch (tableErr) {
        console.error('PostgreSQL: Failed to ensure quick_chats table:', tableErr.message);
      }

      // PostgreSQL Migration: Ensure otc_pairs table exists
      try {
        await db.run(`
          CREATE TABLE IF NOT EXISTS otc_pairs (
            symbol VARCHAR(50) PRIMARY KEY,
            enabled INTEGER DEFAULT 1,
            visible INTEGER DEFAULT 1,
            status VARCHAR(50) DEFAULT 'healthy',
            auto_mode INTEGER DEFAULT 1,
            direction_bias VARCHAR(20) DEFAULT 'neutral',
            trend_strength NUMERIC(5,4) DEFAULT 0.05,
            volatility VARCHAR(20) DEFAULT 'medium',
            speed VARCHAR(20) DEFAULT 'normal',
            price_offset NUMERIC(15,8) DEFAULT 0.0,
            spread NUMERIC(15,8) DEFAULT 0.0001,
            noise NUMERIC(15,8) DEFAULT 0.0002,
            base_price NUMERIC(15,4) DEFAULT 1.0,
            schedule_type VARCHAR(20) DEFAULT 'always',
            schedule_custom TEXT DEFAULT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
          )
        `);
        console.log('PostgreSQL: otc_pairs table verified/created successfully.');
      } catch (tableErr) {
        console.error('PostgreSQL: Failed to ensure otc_pairs table:', tableErr.message);
      }

      // PostgreSQL Migration: Ensure custom_leaderboard table exists
      try {
        await db.run(`
          CREATE TABLE IF NOT EXISTS custom_leaderboard (
            id SERIAL PRIMARY KEY,
            user_id INTEGER DEFAULT NULL,
            username VARCHAR(100) NOT NULL,
            full_name VARCHAR(150) DEFAULT NULL,
            country VARCHAR(10) DEFAULT 'US',
            net_profit NUMERIC(15,2) NOT NULL DEFAULT 0.0,
            won_trades INTEGER NOT NULL DEFAULT 10,
            lost_trades INTEGER NOT NULL DEFAULT 2,
            position INTEGER DEFAULT NULL,
            is_active INTEGER DEFAULT 1,
            avatar_url TEXT DEFAULT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
          )
        `);
        console.log('PostgreSQL: custom_leaderboard table verified/created successfully.');

        // Seed default 20 custom leaderboard entries in PostgreSQL
        try {
          const countRow = await db.get("SELECT COUNT(*) as count FROM custom_leaderboard");
          const count = countRow ? parseInt(countRow.count || countRow['COUNT(*)'] || 0) : 0;
          if (count < 20) {
            const defaultEntries = [
              { username: 'VipTraderAlex', full_name: 'Alex Johnson', country: 'US', net_profit: 24500.00, won_trades: 22, lost_trades: 1, position: 1 },
              { username: 'CryptoKing99', full_name: 'Marco Rossi', country: 'IT', net_profit: 21800.00, won_trades: 19, lost_trades: 2, position: 2 },
              { username: 'AlphaTrader_DE', full_name: 'Stefan Mueller', country: 'DE', net_profit: 19450.00, won_trades: 18, lost_trades: 3, position: 3 },
              { username: 'FX_Master_UK', full_name: 'James Wilson', country: 'GB', net_profit: 17900.00, won_trades: 16, lost_trades: 2, position: 4 },
              { username: 'Trader_Zhen', full_name: 'Li Wei Zhen', country: 'SG', net_profit: 16200.00, won_trades: 15, lost_trades: 1, position: 5 },
              { username: 'SultanFX', full_name: 'Tariq Al-Mansoor', country: 'AE', net_profit: 14850.00, won_trades: 14, lost_trades: 3, position: 6 },
              { username: 'NovaTrader', full_name: 'Elena Rostova', country: 'UA', net_profit: 13600.00, won_trades: 17, lost_trades: 4, position: 7 },
              { username: 'TokyoBull', full_name: 'Kenji Takahashi', country: 'JP', net_profit: 12400.00, won_trades: 13, lost_trades: 2, position: 8 },
              { username: 'RioScalper', full_name: 'Lucas Silva', country: 'BR', net_profit: 11250.00, won_trades: 15, lost_trades: 3, position: 9 },
              { username: 'VikingTrade', full_name: 'Henrik Lindqvist', country: 'SE', net_profit: 10100.00, won_trades: 12, lost_trades: 2, position: 10 },
              { username: 'AusProTrader', full_name: 'Liam O\'Connor', country: 'AU', net_profit: 9400.00, won_trades: 14, lost_trades: 4, position: 11 },
              { username: 'MapleInvestor', full_name: 'Noah Tremblay', country: 'CA', net_profit: 8750.00, won_trades: 11, lost_trades: 2, position: 12 },
              { username: 'DelhiWhale', full_name: 'Aarav Sharma', country: 'IN', net_profit: 8100.00, won_trades: 13, lost_trades: 3, position: 13 },
              { username: 'K-TraderPro', full_name: 'Min-Jun Kim', country: 'KR', net_profit: 7550.00, won_trades: 10, lost_trades: 1, position: 14 },
              { username: 'ZurichGains', full_name: 'Beat Oberholzer', country: 'CH', net_profit: 6900.00, won_trades: 12, lost_trades: 3, position: 15 },
              { username: 'IberianFX', full_name: 'Mateo Fernandez', country: 'ES', net_profit: 6350.00, won_trades: 9, lost_trades: 2, position: 16 },
              { username: 'AnkaraBull', full_name: 'Emre Yilmaz', country: 'TR', net_profit: 5800.00, won_trades: 11, lost_trades: 4, position: 17 },
              { username: 'OzTrader99', full_name: 'Chloe Bennett', country: 'NZ', net_profit: 5250.00, won_trades: 10, lost_trades: 2, position: 18 },
              { username: 'SGPronet', full_name: 'Marcus Tan', country: 'SG', net_profit: 4700.00, won_trades: 8, lost_trades: 1, position: 19 },
              { username: 'PakTrader', full_name: 'Hamza Malik', country: 'PK', net_profit: 4150.00, won_trades: 9, lost_trades: 3, position: 20 }
            ];

            for (const e of defaultEntries) {
              const exists = await db.get("SELECT id FROM custom_leaderboard WHERE username = ?", [e.username]);
              if (!exists) {
                await db.run(
                  "INSERT INTO custom_leaderboard (username, full_name, country, net_profit, won_trades, lost_trades, position, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, 1)",
                  [e.username, e.full_name, e.country, e.net_profit, e.won_trades, e.lost_trades, e.position]
                );
              }
            }
            console.log('PostgreSQL: default 20 leaderboard entries seeded successfully.');
          }
        } catch (seedLbErr) {
          console.error('PostgreSQL: Failed to seed default leaderboard entries:', seedLbErr.message);
        }
      } catch (tableErr) {
        console.error('PostgreSQL: Failed to ensure custom_leaderboard table:', tableErr.message);
      }

      // PostgreSQL Migration: Ensure ip_alerts table exists
      try {
        await db.run(`
          CREATE TABLE IF NOT EXISTS ip_alerts (
            id SERIAL PRIMARY KEY,
            username VARCHAR(255) NOT NULL,
            ip_address VARCHAR(255) NOT NULL,
            conflict_username VARCHAR(255) NOT NULL,
            acknowledged INTEGER DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
          )
        `);
        console.log('PostgreSQL: ip_alerts table verified/created successfully.');
      } catch (tableErr) {
        console.error('PostgreSQL: Failed to ensure ip_alerts table:', tableErr.message);
      }

      // Seed default OTC pairs in PostgreSQL
      try {
        const defaultOtcPairs = [
          { symbol: 'EUR/USD (OTC)', base_price: 1.08 },
          { symbol: 'GBP/USD (OTC)', base_price: 1.27 },
          { symbol: 'USD/JPY (OTC)', base_price: 158.0 },
          { symbol: 'AUD/USD (OTC)', base_price: 0.66 },
          { symbol: 'USD/CAD (OTC)', base_price: 1.37 },
          { symbol: 'EUR/JPY (OTC)', base_price: 171.0 },
          { symbol: 'EUR/GBP (OTC)', base_price: 0.85 },
          { symbol: 'GBP/JPY (OTC)', base_price: 201.0 },
          { symbol: 'BTC/USD (OTC)', base_price: 64000.0 },
          { symbol: 'ETH/USD (OTC)', base_price: 3400.0 },
          { symbol: 'SAR/CNY (OTC)', base_price: 1.93 },
          { symbol: 'OMR/CNY (OTC)', base_price: 18.84 },
          { symbol: 'AUD/CHF (OTC)', base_price: 0.60 },
          { symbol: 'AED/CNY (OTC)', base_price: 1.97 },
          { symbol: 'AED CNY (OTC)', base_price: 1.97 },
          { symbol: 'USD BRL (OTC)', base_price: 5.40 }
        ];
        for (const pair of defaultOtcPairs) {
          await db.run(
            `INSERT INTO otc_pairs (symbol, base_price) VALUES (?, ?) ON CONFLICT (symbol) DO NOTHING`,
            [pair.symbol, pair.base_price]
          );
        }
        console.log('PostgreSQL: default OTC pairs seeded successfully.');
      } catch (seedErr) {
        console.error('PostgreSQL: Failed to seed default OTC pairs:', seedErr.message);
      }

      // Ensure e_wallet_methods table exists in PostgreSQL
      try {
        await db.run(`
          CREATE TABLE IF NOT EXISTS e_wallet_methods (
            id SERIAL PRIMARY KEY,
            name VARCHAR(100) NOT NULL,
            account_name VARCHAR(150) NOT NULL,
            account_number VARCHAR(100) NOT NULL,
            iban VARCHAR(100),
            logo_url VARCHAR(255),
            country VARCHAR(100) DEFAULT 'Pakistan',
            enabled INTEGER DEFAULT 1,
            pkr_rate INTEGER DEFAULT 283,
            min_deposit REAL DEFAULT 10,
            max_deposit REAL DEFAULT 10000,
            min_withdrawal REAL DEFAULT 10,
            max_withdrawal REAL DEFAULT 10000,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
          )
        `);
        // Drop UNIQUE constraint if it exists
        try {
          await db.run(`ALTER TABLE e_wallet_methods DROP CONSTRAINT IF EXISTS e_wallet_methods_name_key`);
          console.log('PostgreSQL: e_wallet_methods unique constraint dropped successfully.');
        } catch (dropErr) {
          // Ignore
        }
        // Dynamically add country column if table already existed without it
        try {
          await db.run(`ALTER TABLE e_wallet_methods ADD COLUMN IF NOT EXISTS country VARCHAR(100) DEFAULT 'Pakistan'`);
          console.log('PostgreSQL: e_wallet_methods.country column verified/added successfully.');
        } catch (alterErr) {
          try {
            await db.run(`ALTER TABLE e_wallet_methods ADD COLUMN country VARCHAR(100) DEFAULT 'Pakistan'`);
          } catch (e) {}
        }
        // Dynamically add pkr_rate if table already existed without it
        try {
          await db.run(`ALTER TABLE e_wallet_methods ADD COLUMN pkr_rate INTEGER DEFAULT 283`);
          console.log('PostgreSQL: e_wallet_methods.pkr_rate column added successfully.');
        } catch (alterErr) {
          // Column already exists
        }
        // Dynamically add limit columns if table already existed without them
        try {
          await db.run(`ALTER TABLE e_wallet_methods ADD COLUMN min_deposit REAL DEFAULT 10`);
        } catch (e) {}
        try {
          await db.run(`ALTER TABLE e_wallet_methods ADD COLUMN max_deposit REAL DEFAULT 10000`);
        } catch (e) {}
        try {
          await db.run(`ALTER TABLE e_wallet_methods ADD COLUMN min_withdrawal REAL DEFAULT 10`);
        } catch (e) {}
        try {
          await db.run(`ALTER TABLE e_wallet_methods ADD COLUMN max_withdrawal REAL DEFAULT 10000`);
        } catch (e) {}
        const checkEmpty = await db.get("SELECT COUNT(*) as count FROM e_wallet_methods");
        if (checkEmpty && Number(checkEmpty.count) === 0) {
          await db.run(
            `INSERT INTO e_wallet_methods (name, account_name, account_number, iban, logo_url, country, pkr_rate) 
             VALUES ('SadaPay', 'Gain EX Admin', '03001234567', 'PK86SADA0000001234567890', 'https://lnwfglkcrrzxwnjqlxqv.supabase.co/storage/v1/object/public/gainex-uploads/sadapay.svg', 'Pakistan', 283)`
          );
          console.log('PostgreSQL: default e_wallet_methods seeded successfully.');
        }
      } catch (err) {
        console.error('PostgreSQL: Failed to initialize e_wallet_methods:', err.message);
      }

      // Dynamically add hidden_staff to deposits if table already existed without it
      try {
        await db.run(`ALTER TABLE deposits ADD COLUMN hidden_staff INTEGER DEFAULT 0`);
        console.log('PostgreSQL: deposits.hidden_staff column added successfully.');
      } catch (alterErr) {
        // Column already exists
      }

      try {
        await db.run(`ALTER TABLE deposits ADD COLUMN reject_reason TEXT`);
        console.log('PostgreSQL: deposits.reject_reason column added successfully.');
      } catch (e) {}

      try {
        await db.run(`ALTER TABLE withdrawals ADD COLUMN reject_reason TEXT`);
        console.log('PostgreSQL: withdrawals.reject_reason column added successfully.');
      } catch (e) {}

      console.log('Syncing default system settings into PostgreSQL...');
      const defaultSettings = [
        { key: 'usdt_deposit_address', value: '0x1234567890abcdef1234567890abcdef12345678' },
        { key: 'usdt_trc20_deposit_address', value: '0x1234567890abcdef1234567890abcdef12345678' },
        { key: 'usdt_erc20_deposit_address', value: '0xabcdef1234567890abcdef1234567890abcdef12' },
        { key: 'usdt_bep20_deposit_address', value: '0x7890abcdef1234567890abcdef1234567890abcd' },
        { key: 'usdt_ltc_deposit_address', value: 'LtcAddressPlaceholder1234567890' },
        { key: 'usdt_aptos_deposit_address', value: 'AptosAddressPlaceholder1234567890' },
        { key: 'usdc_deposit_address', value: '0xabcdef1234567890abcdef1234567890abcdef12' },
        { key: 'bank_deposit_details', value: 'Bank: Gain EX Global Bank\nAccount Number: 9876543210\nAccount Name: Gain EX INC\nIFSC/BIC Code: GAINEX999' },
        { key: 'deposit_usdt_enabled', value: 'true' },
        { key: 'deposit_usdc_enabled', value: 'true' },
        { key: 'deposit_bank_enabled', value: 'true' },
        { key: 'withdrawal_usdt_enabled', value: 'true' },
        { key: 'withdrawal_usdc_enabled', value: 'true' },
        { key: 'withdrawal_bank_enabled', value: 'true' },
        { key: 'withdrawal_jazzcash_enabled', value: 'true' },
        { key: 'withdrawal_easypaisa_enabled', value: 'true' },
        { key: 'withdrawal_nayapay_enabled', value: 'true' },
        { key: 'withdrawal_zindagi_enabled', value: 'true' },
        { key: 'withdrawal_sadapay_enabled', value: 'true' },
        { key: 'crypto_visible_coins', value: JSON.stringify(['BTC', 'ETH', 'SOL', 'BNB', 'DOGE', 'XRP', 'ADA', 'AVAX', 'MATIC', 'LINK', 'LTC', 'DOT', 'TRX', 'UNI', 'ATOM']) },
        { key: 'forex_visible_pairs', value: JSON.stringify(['EUR/USD', 'USD/CAD', 'GBP/USD', 'USD/JPY', 'AUD/USD', 'USD/CHF', 'NZD/USD', 'EUR/GBP', 'EUR/JPY', 'GBP/JPY', 'USD/INR', 'USD/PKR', 'USD/BDT', 'GBP/CHF']) },
        { key: 'combine_trades_control', value: 'false' },
        { key: 'combine_trades_outcome', value: 'none' },
        { key: 'currency_rate_INR', value: '84.0' },
        { key: 'currency_rate_PKR', value: '278.0' },
        { key: 'currency_rate_BDT', value: '117.0' },
        { key: 'currency_rate_NPR', value: '133.0' },
        { key: 'currency_rate_USD', value: '1.0' },
        { key: 'currency_rate_GBP', value: '0.78' },
        { key: 'currency_rate_BRL', value: '5.4' },
        { key: 'currency_rate_IDR', value: '16000.0' },
        { key: 'currency_rate_MYR', value: '4.7' },
        { key: 'currency_rate_KZT', value: '475.0' },
        { key: 'currency_rate_THB', value: '36.0' },
        { key: 'currency_rate_UAH', value: '41.0' },
        { key: 'currency_rate_VND', value: '25400.0' },
        { key: 'currency_rate_NGN', value: '1500.0' },
        { key: 'currency_rate_EGP', value: '48.0' },
        { key: 'currency_rate_MXN', value: '18.0' },
        { key: 'currency_rate_JPY', value: '160.0' },
        { key: 'currency_rate_PHP', value: '58.0' },
        { key: 'currency_rate_TRY', value: '32.5' },
        { key: 'currency_rate_KRW', value: '1380.0' },
        { key: 'currency_rate_USDT', value: '1.0' },
        { key: 'currency_rate_BNB', value: '600.0' },
        { key: 'currency_rate_BTC', value: '67000.0' },
        { key: 'currency_rate_ETH', value: '3500.0' },
        { key: 'currency_rate_SOL', value: '145.0' },
        { key: 'referral_commission_pct', value: '5.0' },
        { key: 'page_loader_delay_ms', value: '400' },
        { key: 'onboarding_slides', value: JSON.stringify([
          { title: 'Welcome to Gain EX 👋', description: 'The best app to invest in various crypto stocks in the world today!', image: '/images/onboarding1.png' },
          { title: 'Get Better Returns 🚀', description: 'Invest in the biggest crypto market & unlock amazing returns of investment.', image: '/images/onboarding2.png' },
          { title: 'Start with Just $1.00 💰', description: "You don't have to buy a whole share, you can buy a fraction.", image: '/images/onboarding3.png' },
          { title: 'Your Safety is First 🛡️', description: 'Your brokerage account is secured with advanced military-grade encryption.', image: '/images/onboarding4.png' },
          { title: 'No Commissions ⚡', description: 'No commissions ever, just trade and maximize your returns.', image: '/images/onboarding5.png' }
        ]) },
        { key: 'daily_bonus_criteria', value: JSON.stringify([
          { milestone: 1, days: 14, min_volume: 5, bonus: 10 },
          { milestone: 2, days: 21, min_volume: 10, bonus: 15 },
          { milestone: 3, days: 30, min_volume: 15, bonus: 50 }
        ]) },
        { key: 'binance_api_key', value: '' },
        { key: 'binance_secret_key', value: '' },
        { key: 'binance_deposit_address', value: '' },
        { key: 'binance_qr_url', value: '' },
        { key: 'binance_auto_enabled', value: 'false' },
        { key: 'binance_manual_enabled', value: 'false' }
      ];
      for (const s of defaultSettings) {
        // Always update pairs so they contain the full list
        if (s.key === 'crypto_visible_coins' || s.key === 'forex_visible_pairs') {
          await db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [s.key, s.value]);
        } else {
          await db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING', [s.key, s.value]);
        }
      }
    } catch (err) {
      console.error('PostgreSQL verification failed. Did you execute the schema in Supabase SQL Editor first?', err.message);
    }
    await syncTradeOptions(db);

    try {
      await db.exec(`
        CREATE TABLE IF NOT EXISTS profile_posts (
          id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
          user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
          media_url TEXT NOT NULL,
          media_type VARCHAR(50) NOT NULL,
          description TEXT,
          likes_count INTEGER DEFAULT 0,
          comments_count INTEGER DEFAULT 0,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS profile_post_likes (
          post_id BIGINT REFERENCES profile_posts(id) ON DELETE CASCADE,
          user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
          PRIMARY KEY (post_id, user_id)
        );

        CREATE TABLE IF NOT EXISTS profile_comments (
          id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
          post_id BIGINT REFERENCES profile_posts(id) ON DELETE CASCADE,
          user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
          text TEXT NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS friends (
          id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
          user_id1 BIGINT REFERENCES users(id) ON DELETE CASCADE,
          user_id2 BIGINT REFERENCES users(id) ON DELETE CASCADE,
          status VARCHAR(50) DEFAULT 'pending' CHECK(status IN ('pending', 'accepted')),
          sender_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(user_id1, user_id2)
        );

        CREATE TABLE IF NOT EXISTS visa_cards (
          id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
          user_id BIGINT REFERENCES users(id) ON DELETE CASCADE UNIQUE,
          first_name VARCHAR(255) NOT NULL,
          last_name VARCHAR(255) NOT NULL,
          nickname VARCHAR(255) NOT NULL,
          address TEXT NOT NULL,
          bank_statement_path TEXT NOT NULL,
          status VARCHAR(50) DEFAULT 'pending' CHECK(status IN ('pending', 'preparing', 'shipping', 'delivered', 'active')),
          card_number VARCHAR(50),
          card_cvv VARCHAR(10),
          card_expiry VARCHAR(20),
          activation_code VARCHAR(50),
          is_blocked BOOLEAN DEFAULT FALSE,
          daily_limit INTEGER DEFAULT 2500,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS bonus_claims (
          id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
          user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
          milestone INTEGER NOT NULL,
          days INTEGER NOT NULL,
          min_volume REAL NOT NULL,
          bonus REAL NOT NULL,
          status VARCHAR(50) DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected')),
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          resolved_at TIMESTAMP DEFAULT NULL,
          resolved_by_id BIGINT REFERENCES users(id) ON DELETE SET NULL
        );

        CREATE TABLE IF NOT EXISTS badge_bonus_claims (
          id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
          user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
          badge_key VARCHAR(100) NOT NULL,
          badge_name VARCHAR(255) NOT NULL,
          volume_threshold REAL NOT NULL,
          bonus_amount REAL NOT NULL,
          status VARCHAR(50) DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected')),
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          resolved_at TIMESTAMP DEFAULT NULL,
          resolved_by_id BIGINT REFERENCES users(id) ON DELETE SET NULL
        );

        CREATE TABLE IF NOT EXISTS aibot_keys (
          id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
          key_code VARCHAR(255) UNIQUE NOT NULL,
          is_used BOOLEAN DEFAULT FALSE,
          used_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          activated_at TIMESTAMP DEFAULT NULL,
          bot_timer INTEGER DEFAULT 60,
          investment_pct INTEGER DEFAULT 10,
          daily_limit INTEGER DEFAULT 100,
          is_revoked BOOLEAN DEFAULT FALSE,
          is_enabled BOOLEAN DEFAULT TRUE
        );
      `);
      console.log('PostgreSQL: Profile tables & aibot_keys verified/created successfully.');
    } catch (eSchema) {
      console.error('PostgreSQL: Failed to verify/create profile tables:', eSchema.message);
    }

    // PostgreSQL Migration: Add commission_pct to invite_codes (nullable = use global default)
    try {
      await db.run(`ALTER TABLE invite_codes ADD COLUMN IF NOT EXISTS commission_pct REAL DEFAULT NULL`);
      console.log('PostgreSQL: invite_codes.commission_pct column verified/added successfully.');
    } catch (icErr) {
      console.error('PostgreSQL: Failed to ensure invite_codes.commission_pct:', icErr.message);
    }

    // PostgreSQL Migration: Add dashboard permissions and live_support columns to permissions table
    try {
      await db.run(`ALTER TABLE permissions ADD COLUMN IF NOT EXISTS live_support INTEGER DEFAULT 0`);
      await db.run(`ALTER TABLE permissions ADD COLUMN IF NOT EXISTS dash_live_activity INTEGER DEFAULT 0`);
      await db.run(`ALTER TABLE permissions ADD COLUMN IF NOT EXISTS dash_global_settings INTEGER DEFAULT 0`);
      await db.run(`ALTER TABLE permissions ADD COLUMN IF NOT EXISTS dash_live_trades INTEGER DEFAULT 0`);
      await db.run(`ALTER TABLE permissions ADD COLUMN IF NOT EXISTS dash_kyc_list INTEGER DEFAULT 0`);
      await db.run(`ALTER TABLE permissions ADD COLUMN IF NOT EXISTS earnings_history INTEGER DEFAULT 1`);
      await db.run(`ALTER TABLE permissions ADD COLUMN IF NOT EXISTS withdrawal_limit NUMERIC(15,2) DEFAULT 1000.00`);
      console.log('PostgreSQL: permissions dashboard/live_support columns verified/added successfully.');
    } catch (pErr) {
      console.error('PostgreSQL: Failed to ensure permissions dashboard/live_support columns:', pErr.message);
    }

    // PostgreSQL Migration: Add auto-trade session columns to aibot_keys
    try {
      await db.run(`ALTER TABLE aibot_keys ADD COLUMN IF NOT EXISTS bot_linked_email VARCHAR(255) DEFAULT NULL`);
      await db.run(`ALTER TABLE aibot_keys ADD COLUMN IF NOT EXISTS bot_session_token VARCHAR(255) DEFAULT NULL`);
      await db.run(`ALTER TABLE aibot_keys ADD COLUMN IF NOT EXISTS bot_session_active BOOLEAN DEFAULT FALSE`);
      await db.run(`ALTER TABLE aibot_keys ADD COLUMN IF NOT EXISTS bot_timer INTEGER DEFAULT 60`);
      await db.run(`ALTER TABLE aibot_keys ADD COLUMN IF NOT EXISTS investment_pct INTEGER DEFAULT 10`);
      await db.run(`ALTER TABLE aibot_keys ADD COLUMN IF NOT EXISTS daily_limit INTEGER DEFAULT 100`);
      await db.run(`ALTER TABLE aibot_keys ADD COLUMN IF NOT EXISTS trade_sequence TEXT DEFAULT NULL`);
      await db.run(`ALTER TABLE aibot_keys ADD COLUMN IF NOT EXISTS min_balance NUMERIC DEFAULT NULL`);
      await db.run(`ALTER TABLE aibot_keys ADD COLUMN IF NOT EXISTS is_revoked BOOLEAN DEFAULT FALSE`);
      await db.run(`ALTER TABLE aibot_keys ADD COLUMN IF NOT EXISTS is_enabled BOOLEAN DEFAULT TRUE`);
      await db.run(`ALTER TABLE aibot_keys ADD COLUMN IF NOT EXISTS demo_trade_sequence TEXT DEFAULT NULL`);
      await db.run(`ALTER TABLE aibot_keys ADD COLUMN IF NOT EXISTS demo_sequence_type VARCHAR(50) DEFAULT 'random'`);
      await db.run(`ALTER TABLE aibot_keys ADD COLUMN IF NOT EXISTS notes TEXT DEFAULT NULL`);
      await db.run(`ALTER TABLE aibot_keys ADD COLUMN IF NOT EXISTS previous_key_code VARCHAR(255) DEFAULT NULL`);
      await db.run(`ALTER TABLE aibot_keys ADD COLUMN IF NOT EXISTS custom_error_enabled BOOLEAN DEFAULT FALSE`);
      await db.run(`ALTER TABLE aibot_keys ADD COLUMN IF NOT EXISTS custom_error_message TEXT DEFAULT NULL`);
      console.log('PostgreSQL: aibot_keys session & settings columns verified/added successfully.');
    } catch (abErr) {
      console.error('PostgreSQL: Failed to ensure aibot_keys session columns:', abErr.message);
    }

    // PostgreSQL Migration: Ensure bot_services table and offer timer columns exist
    try {
      await db.run(`
        CREATE TABLE IF NOT EXISTS bot_services (
          id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          service_key VARCHAR(100) UNIQUE,
          price VARCHAR(50) NOT NULL,
          actual_price VARCHAR(50) DEFAULT NULL,
          offer_ends_at VARCHAR(100) DEFAULT NULL,
          offer_timer_enabled BOOLEAN DEFAULT FALSE,
          logo_url TEXT DEFAULT '',
          icon VARCHAR(50) DEFAULT '🤖',
          badge VARCHAR(100) DEFAULT '',
          is_highlighted BOOLEAN DEFAULT FALSE,
          is_active BOOLEAN DEFAULT TRUE,
          sort_order INT DEFAULT 0,
          description TEXT DEFAULT '',
          features TEXT DEFAULT '[]',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await db.run(`ALTER TABLE bot_services ADD COLUMN IF NOT EXISTS actual_price VARCHAR(50) DEFAULT NULL`);
      await db.run(`ALTER TABLE bot_services ADD COLUMN IF NOT EXISTS offer_ends_at VARCHAR(100) DEFAULT NULL`);
      await db.run(`ALTER TABLE bot_services ADD COLUMN IF NOT EXISTS offer_timer_enabled BOOLEAN DEFAULT FALSE`);
      console.log('PostgreSQL: bot_services table and offer timer columns verified/added successfully.');
    } catch (bsErr) {
      console.error('PostgreSQL: Failed to ensure bot_services columns:', bsErr.message);
    }

    // PostgreSQL Migration: Ensure employee_withdrawals table exists
    try {
      await db.run(`
        CREATE TABLE IF NOT EXISTS employee_withdrawals (
          id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
          employee_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
          amount NUMERIC(15,2) NOT NULL,
          method VARCHAR(100) NOT NULL,
          account_details TEXT NOT NULL,
          status VARCHAR(50) DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected')),
          admin_notes TEXT DEFAULT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          resolved_at TIMESTAMP DEFAULT NULL,
          resolved_by_id BIGINT REFERENCES users(id) ON DELETE SET NULL
        )
      `);
      console.log('PostgreSQL: employee_withdrawals table verified/created successfully.');
    } catch (ewErr) {
      console.error('PostgreSQL: Failed to ensure employee_withdrawals table:', ewErr.message);
    }

    // PostgreSQL Migration: Ensure scheduled_emails table exists
    try {
      await db.run(`
        CREATE TABLE IF NOT EXISTS scheduled_emails (
          id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
          subject VARCHAR(255) NOT NULL,
          html_content TEXT NOT NULL,
          recipient_type VARCHAR(50) NOT NULL,
          recipient_ids TEXT DEFAULT NULL,
          schedule_times TEXT NOT NULL,
          schedule_days TEXT NOT NULL,
          last_sent TIMESTAMP DEFAULT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      console.log('PostgreSQL: scheduled_emails table verified/created successfully.');
    } catch (seErr) {
      console.error('PostgreSQL: Failed to ensure scheduled_emails table:', seErr.message);
    }

    // Ensure admin user exists in PostgreSQL
    let adminUser = await db.get("SELECT id FROM users WHERE username = 'admin' LIMIT 1");
    if (!adminUser) {
      const salt = await bcrypt.genSalt(10);
      const hash = await bcrypt.hash('admin123', salt);
      
      // Check if ADMIN777 invite code is already taken in the users table
      const inviteCodeTaken = await db.get("SELECT id FROM users WHERE invite_code = 'ADMIN777' LIMIT 1");
      const adminInviteCode = inviteCodeTaken ? null : 'ADMIN777';

      try {
        const result = await db.run(
          `INSERT INTO users (username, password_hash, role, invite_code) 
           VALUES ('admin', ?, 'admin', ?)`,
          [hash, adminInviteCode]
        );
        const adminId = result.lastID;

        // Seed permissions for admin
        await db.run(
          `INSERT INTO permissions (user_id, user_management, deposit_approval, withdrawal_approval, trade_monitoring, full_access)
           VALUES (?, 1, 1, 1, 1, 1)`,
          [adminId]
        );

        // Ensure ADMIN777 exists in invite_codes table (referencing either the new admin or the existing user who owns it)
        const creatorId = inviteCodeTaken ? inviteCodeTaken.id : adminId;
        const codeExists = await db.get("SELECT * FROM invite_codes WHERE code = 'ADMIN777'");
        if (!codeExists) {
          await db.run(
            `INSERT INTO invite_codes (code, created_by_id) VALUES (?, ?)`,
            ['ADMIN777', creatorId]
          );
        }

        console.log('Seeded default Admin in PostgreSQL: username="admin", password="admin123"');
      } catch (insertErr) {
        console.error('Failed to seed default admin in PostgreSQL:', insertErr.message);
      }
    } else {
      // Ensure ADMIN777 invite code exists in invite_codes table in PostgreSQL
      const codeExists = await db.get("SELECT * FROM invite_codes WHERE code = 'ADMIN777'");
      if (!codeExists) {
        await db.run(
          `INSERT INTO invite_codes (code, created_by_id) VALUES (?, ?)`,
          ['ADMIN777', adminUser.id]
        );
        console.log('Seeded ADMIN777 invite code for existing admin in PostgreSQL.');
      }
    }

    await fillRetroactiveReferrerCommissions(db);
    return;
  }

  // SQLite Schema Setup
  // SQLite Migration: Drop CHECK constraint on deposits.method by recreating table if constraint exists
  try {
    const tableSql = await db.get("SELECT sql FROM sqlite_master WHERE type='table' AND name='deposits'");
    if (tableSql && tableSql.sql && tableSql.sql.includes("CHECK(method IN ('USDT', 'USDC', 'BANK'))")) {
      console.log("Migrating SQLite deposits table to remove CHECK constraint on method...");
      await db.run("BEGIN TRANSACTION");
      try {
        await db.run("ALTER TABLE deposits RENAME TO deposits_old");
        await db.run(`
          CREATE TABLE deposits (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            method TEXT NOT NULL,
            amount REAL NOT NULL,
            details TEXT,
            proof_text TEXT,
            proof_file TEXT,
            status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected')),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            resolved_at TIMESTAMP,
            resolved_by_id INTEGER,
            FOREIGN KEY(user_id) REFERENCES users(id),
            FOREIGN KEY(resolved_by_id) REFERENCES users(id)
          )
        `);
        await db.run(`
          INSERT INTO deposits (id, user_id, method, amount, details, proof_text, proof_file, status, created_at, resolved_at, resolved_by_id)
          SELECT id, user_id, method, amount, details, proof_text, proof_file, status, created_at, resolved_at, resolved_by_id FROM deposits_old
        `);
        await db.run("DROP TABLE deposits_old");
        await db.run("COMMIT");
        console.log("SQLite deposits table migration completed successfully.");
      } catch (err) {
        await db.run("ROLLBACK");
        console.error("SQLite deposits table migration failed, rolled back:", err.message);
      }
    }
  } catch (migErr) {
    console.error("Failed to check SQLite deposits schema for migration:", migErr.message);
  }

  // SQLite Migration: Recreate visa_cards if it has the old CHECK constraint to support new statuses
  try {
    const vcTableSql = await db.get("SELECT sql FROM sqlite_master WHERE type='table' AND name='visa_cards'");
    if (vcTableSql && vcTableSql.sql && vcTableSql.sql.includes("CHECK(status IN ('pending', 'delivered', 'active'))")) {
      console.log("Migrating SQLite visa_cards table to remove old CHECK constraint and add activation_code...");
      await db.run("BEGIN TRANSACTION");
      try {
        await db.run("ALTER TABLE visa_cards RENAME TO visa_cards_old");
        await db.run(`
          CREATE TABLE visa_cards (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL UNIQUE,
            first_name TEXT NOT NULL,
            last_name TEXT NOT NULL,
            nickname TEXT NOT NULL,
            address TEXT NOT NULL,
            bank_statement_path TEXT NOT NULL,
            status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'preparing', 'shipping', 'delivered', 'active')),
            card_number TEXT,
            card_cvv TEXT,
            card_expiry TEXT,
            activation_code TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
          )
        `);
        await db.run(`
          INSERT INTO visa_cards (id, user_id, first_name, last_name, nickname, address, bank_statement_path, status, card_number, card_cvv, card_expiry, created_at)
          SELECT id, user_id, first_name, last_name, nickname, address, bank_statement_path, status, card_number, card_cvv, card_expiry, created_at FROM visa_cards_old
        `);
        await db.run("DROP TABLE visa_cards_old");
        await db.run("COMMIT");
        console.log("SQLite visa_cards table migration completed successfully.");
      } catch (err) {
        await db.run("ROLLBACK");
        console.error("SQLite visa_cards table migration failed, rolled back:", err.message);
      }
    }
  } catch (migErr) {
    console.error("Failed to check SQLite visa_cards schema for migration:", migErr.message);
  }

  // SQLite Migration: Ensure activation_code column exists in visa_cards table
  try {
    await db.run("ALTER TABLE visa_cards ADD COLUMN activation_code TEXT");
    console.log("SQLite: activation_code column added successfully to visa_cards table.");
  } catch (err) {
    // Column already exists, ignore
  }
  try {
    await db.run("ALTER TABLE visa_cards ADD COLUMN is_blocked INTEGER DEFAULT 0");
    console.log("SQLite: is_blocked column added successfully to visa_cards table.");
  } catch (err) {
    // Column already exists, ignore
  }
  try {
    await db.run("ALTER TABLE visa_cards ADD COLUMN daily_limit INTEGER DEFAULT 2500");
    console.log("SQLite: daily_limit column added successfully to visa_cards table.");
  } catch (err) {
    // Column already exists, ignore
  }

  // SQLite Migration: Ensure is_test column exists in users table
  try {
    await db.run("ALTER TABLE users ADD COLUMN is_test INTEGER DEFAULT 0");
    console.log("SQLite: is_test column added successfully to users table.");
  } catch (err) {
    // Column already exists, ignore
  }

  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE,
      google_id TEXT UNIQUE,
      phone_number TEXT,
      full_name TEXT,
      profile_pic TEXT,
      credit_score REAL DEFAULT 100.0,
      withdraw_enabled INTEGER DEFAULT 1 CHECK(withdraw_enabled IN (0, 1)),
      withdraw_limit REAL DEFAULT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin', 'employee', 'user')),
      balance REAL DEFAULT 0.0,
      status TEXT DEFAULT 'active' CHECK(status IN ('active', 'frozen', 'blocked')),
      invite_code TEXT UNIQUE,
      invited_by_id INTEGER,
      withdrawal_otp TEXT,
      withdrawal_otp_expires_at TEXT,
      is_test INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      username_last_changed TIMESTAMP DEFAULT NULL,
      last_seen_at TIMESTAMP DEFAULT NULL,
      FOREIGN KEY(invited_by_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS permissions (
      user_id INTEGER PRIMARY KEY,
      user_management INTEGER DEFAULT 0 CHECK(user_management IN (0, 1)),
      deposit_approval INTEGER DEFAULT 0 CHECK(deposit_approval IN (0, 1)),
      withdrawal_approval INTEGER DEFAULT 0 CHECK(withdrawal_approval IN (0, 1)),
      trade_monitoring INTEGER DEFAULT 0 CHECK(trade_monitoring IN (0, 1)),
      full_access INTEGER DEFAULT 0 CHECK(full_access IN (0, 1)),
      see_all_users INTEGER DEFAULT 0 CHECK(see_all_users IN (0, 1)),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS deposits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      method TEXT NOT NULL,
      amount REAL NOT NULL,
      details TEXT,
      proof_text TEXT,
      proof_file TEXT,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected')),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      resolved_at TIMESTAMP,
      resolved_by_id INTEGER,
      hidden_staff INTEGER DEFAULT 0,
      reject_reason TEXT,
      FOREIGN KEY(user_id) REFERENCES users(id),
      FOREIGN KEY(resolved_by_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS withdrawals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      method TEXT NOT NULL CHECK(method IN ('USDT', 'USDC', 'BANK')),
      amount REAL NOT NULL,
      payout_details TEXT NOT NULL,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected')),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      resolved_at TIMESTAMP,
      resolved_by_id INTEGER,
      reject_reason TEXT,
      FOREIGN KEY(user_id) REFERENCES users(id),
      FOREIGN KEY(resolved_by_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS invite_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE NOT NULL,
      created_by_id INTEGER NOT NULL,
      used_count INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(created_by_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS trade_options (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      duration INTEGER UNIQUE NOT NULL,
      commission_pct REAL NOT NULL
    );

    CREATE TABLE IF NOT EXISTS trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      coin TEXT NOT NULL,
      direction TEXT NOT NULL CHECK(direction IN ('UP', 'DOWN')),
      amount REAL NOT NULL,
      duration INTEGER NOT NULL,
      commission_pct REAL NOT NULL,
      open_price REAL NOT NULL,
      close_price REAL,
      status TEXT DEFAULT 'active' CHECK(status IN ('active', 'win', 'lose', 'refunded')),
      admin_control TEXT DEFAULT 'none' CHECK(admin_control IN ('none', 'win', 'lose')),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      expires_at TIMESTAMP NOT NULL,
      resolved_at TIMESTAMP,
      is_demo INTEGER DEFAULT 0,
      amount_usd REAL DEFAULT NULL,
      currency TEXT DEFAULT 'USD',
      FOREIGN KEY(user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('deposit', 'withdrawal', 'trade_win', 'trade_lose', 'admin_add', 'admin_subtract', 'referral_commission')),
      amount REAL NOT NULL,
      description TEXT,
      balance_after REAL NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS visa_cards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL UNIQUE,
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      nickname TEXT NOT NULL,
      address TEXT NOT NULL,
      bank_statement_path TEXT NOT NULL,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'preparing', 'shipping', 'delivered', 'active')),
      card_number TEXT,
      card_cvv TEXT,
      card_expiry TEXT,
      activation_code TEXT,
      is_blocked INTEGER DEFAULT 0,
      daily_limit INTEGER DEFAULT 2500,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS quick_chats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id INTEGER,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT UNIQUE PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS email_verifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('current_email', 'new_email')),
      email TEXT NOT NULL,
      code TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      verified INTEGER DEFAULT 0 CHECK(verified IN (0, 1)),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS signup_verifications (
      email TEXT PRIMARY KEY,
      code TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS profile_posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      media_url TEXT NOT NULL,
      media_type TEXT NOT NULL CHECK(media_type IN ('image', 'gif', 'video')),
      description TEXT,
      likes_count INTEGER DEFAULT 0,
      comments_count INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS profile_post_likes (
      post_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      PRIMARY KEY (post_id, user_id),
      FOREIGN KEY(post_id) REFERENCES profile_posts(id) ON DELETE CASCADE,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS profile_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      text TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(post_id) REFERENCES profile_posts(id) ON DELETE CASCADE,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS friends (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id1 INTEGER NOT NULL,
      user_id2 INTEGER NOT NULL,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'accepted')),
      sender_id INTEGER NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id1, user_id2),
      FOREIGN KEY(user_id1) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY(user_id2) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS bonus_claims (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      milestone INTEGER NOT NULL,
      days INTEGER NOT NULL,
      min_volume REAL NOT NULL,
      bonus REAL NOT NULL,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected')),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      resolved_at TIMESTAMP DEFAULT NULL,
      resolved_by_id INTEGER,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY(resolved_by_id) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS badge_bonus_claims (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      badge_key TEXT NOT NULL,
      badge_name TEXT NOT NULL,
      volume_threshold REAL NOT NULL,
      bonus_amount REAL NOT NULL,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected')),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      resolved_at TIMESTAMP DEFAULT NULL,
      resolved_by_id INTEGER,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY(resolved_by_id) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS otc_pairs (
      symbol TEXT PRIMARY KEY,
      enabled INTEGER DEFAULT 1,
      visible INTEGER DEFAULT 1,
      status TEXT DEFAULT 'healthy',
      auto_mode INTEGER DEFAULT 1,
      direction_bias TEXT DEFAULT 'neutral',
      trend_strength REAL DEFAULT 0.05,
      volatility TEXT DEFAULT 'medium',
      speed TEXT DEFAULT 'normal',
      price_offset REAL DEFAULT 0.0,
      spread REAL DEFAULT 0.0001,
      noise REAL DEFAULT 0.0002,
      base_price REAL DEFAULT 1.0,
      schedule_type TEXT DEFAULT 'always',
      schedule_custom TEXT DEFAULT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS aibot_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key_code TEXT UNIQUE NOT NULL,
      is_used BOOLEAN DEFAULT FALSE,
      used_by_user_id INTEGER,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      activated_at TIMESTAMP DEFAULT NULL,
      bot_timer INTEGER DEFAULT 60,
      investment_pct INTEGER DEFAULT 10,
      daily_limit INTEGER DEFAULT 100,
      is_revoked INTEGER DEFAULT 0,
      is_enabled INTEGER DEFAULT 1,
      FOREIGN KEY(used_by_user_id) REFERENCES users(id) ON DELETE SET NULL
    );
  `);

  const tableInfo = await db.all("PRAGMA table_info(users)");
  const cols = tableInfo.map(c => c.name);

  const migrations = [
    { name: 'full_name', type: 'TEXT' },
    { name: 'email', type: 'TEXT' },
    { name: 'phone_number', type: 'TEXT' },
    { name: 'profile_pic', type: 'TEXT' },
    { name: 'credit_score', type: 'REAL DEFAULT 100.0' },
    { name: 'withdraw_enabled', type: 'INTEGER DEFAULT 1' },
    { name: 'withdraw_limit', type: 'REAL DEFAULT NULL' },
    { name: 'currency', type: 'TEXT DEFAULT "USD"' },
    { name: 'demo_balance', type: 'REAL DEFAULT 10000.0' },
    { name: 'real_account_active', type: 'INTEGER DEFAULT 0 CHECK(real_account_active IN (0, 1))' },
    { name: 'kyc_status', type: 'TEXT DEFAULT "unverified"' },
    { name: 'kyc_country', type: 'TEXT' },
    { name: 'kyc_address', type: 'TEXT' },
    { name: 'kyc_document_front', type: 'TEXT' },
    { name: 'kyc_document_back', type: 'TEXT' },
    { name: 'kyc_selfie', type: 'TEXT' },
    { name: 'kyc_submitted_at', type: 'TEXT' },
    { name: 'kyc_rejected_reason', type: 'TEXT' },
    { name: 'username_last_changed', type: 'TIMESTAMP DEFAULT NULL' },
    { name: 'withdrawal_otp', type: 'TEXT' },
    { name: 'withdrawal_otp_expires_at', type: 'TEXT' },
    { name: 'last_seen_at', type: 'TIMESTAMP DEFAULT NULL' },
    { name: 'last_ip', type: 'TEXT DEFAULT NULL' },
    { name: 'last_country', type: 'TEXT DEFAULT NULL' },
    { name: 'demo_trading_enabled', type: 'INTEGER DEFAULT 1' }
  ];

  for (const m of migrations) {
    if (!cols.includes(m.name)) {
      try {
        await db.run(`ALTER TABLE users ADD COLUMN ${m.name} ${m.type}`);
        if (m.name === 'email') {
          await db.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email)");
        }
      } catch (e) {
        console.error(`SQLite migration warning for ${m.name}:`, e.message);
      }
    }
  }

  const tradesTableInfo = await db.all("PRAGMA table_info(trades)");
  const tradesCols = tradesTableInfo.map(c => c.name);
  if (!tradesCols.includes('is_demo')) {
    try { await db.run("ALTER TABLE trades ADD COLUMN is_demo INTEGER DEFAULT 0"); } catch(e) { console.error(e.message); }
  }
  if (!tradesCols.includes('amount_usd')) {
    try { await db.run("ALTER TABLE trades ADD COLUMN amount_usd REAL DEFAULT NULL"); } catch(e) { console.error(e.message); }
  }
  if (!tradesCols.includes('currency')) {
    try { await db.run("ALTER TABLE trades ADD COLUMN currency TEXT DEFAULT 'USD'"); } catch(e) { console.error(e.message); }
  }
  if (!tradesCols.includes('referrer_commission')) {
    try { await db.run("ALTER TABLE trades ADD COLUMN referrer_commission REAL DEFAULT NULL"); } catch(e) { console.error(e.message); }
  }
  if (!tradesCols.includes('is_bot')) {
    try { await db.run("ALTER TABLE trades ADD COLUMN is_bot INTEGER DEFAULT 0"); } catch(e) { console.error(e.message); }
  }

  // Retroactively fill currency values for older trades using the amount to amount_usd ratio
  try {
    await db.run(`
      UPDATE trades
      SET currency = CASE
        WHEN amount_usd IS NULL OR amount_usd = 0 THEN 'USD'
        WHEN ABS(amount / amount_usd - 1.0) < 0.05 THEN 'USD'
        WHEN ABS(amount / amount_usd - 278.0) < 15.0 THEN 'PKR'
        WHEN ABS(amount / amount_usd - 84.0) < 5.0 THEN 'INR'
        WHEN ABS(amount / amount_usd - 117.0) < 5.0 THEN 'BDT'
        WHEN ABS(amount / amount_usd - 133.0) < 5.0 THEN 'NPR'
        ELSE 'USD'
      END
      WHERE currency IS NULL OR currency IN ('USD', 'EUR', 'GBP')
    `);
    console.log('SQLite: Retroactive trade currency correction applied successfully.');
  } catch (err) {
    console.error('SQLite: Failed to apply retroactive trade currency correction:', err.message);
  }

  // Ensure aibot_keys columns exist in SQLite
  try {
    const aibotTableInfo = await db.all("PRAGMA table_info(aibot_keys)");
    const aibotCols = aibotTableInfo.map(c => c.name);
    if (!aibotCols.includes('bot_linked_email')) {
      await db.run("ALTER TABLE aibot_keys ADD COLUMN bot_linked_email TEXT DEFAULT NULL");
    }
    if (!aibotCols.includes('bot_session_token')) {
      await db.run("ALTER TABLE aibot_keys ADD COLUMN bot_session_token TEXT DEFAULT NULL");
    }
    if (!aibotCols.includes('bot_session_active')) {
      await db.run("ALTER TABLE aibot_keys ADD COLUMN bot_session_active INTEGER DEFAULT 0");
    }
    if (!aibotCols.includes('bot_timer')) {
      await db.run("ALTER TABLE aibot_keys ADD COLUMN bot_timer INTEGER DEFAULT 60");
    }
    if (!aibotCols.includes('investment_pct')) {
      await db.run("ALTER TABLE aibot_keys ADD COLUMN investment_pct INTEGER DEFAULT 10");
    }
    if (!aibotCols.includes('daily_limit')) {
      await db.run("ALTER TABLE aibot_keys ADD COLUMN daily_limit INTEGER DEFAULT 100");
    }
    if (!aibotCols.includes('trade_sequence')) {
      await db.run("ALTER TABLE aibot_keys ADD COLUMN trade_sequence TEXT DEFAULT NULL");
    }
    if (!aibotCols.includes('min_balance')) {
      await db.run("ALTER TABLE aibot_keys ADD COLUMN min_balance REAL DEFAULT NULL");
    }
    if (!aibotCols.includes('is_revoked')) {
      await db.run("ALTER TABLE aibot_keys ADD COLUMN is_revoked INTEGER DEFAULT 0");
    }
    if (!aibotCols.includes('is_enabled')) {
      await db.run("ALTER TABLE aibot_keys ADD COLUMN is_enabled INTEGER DEFAULT 1");
    }
    if (!aibotCols.includes('demo_trade_sequence')) {
      await db.run("ALTER TABLE aibot_keys ADD COLUMN demo_trade_sequence TEXT DEFAULT NULL");
    }
    if (!aibotCols.includes('demo_sequence_type')) {
      await db.run("ALTER TABLE aibot_keys ADD COLUMN demo_sequence_type TEXT DEFAULT 'random'");
    }
    if (!aibotCols.includes('notes')) {
      await db.run("ALTER TABLE aibot_keys ADD COLUMN notes TEXT DEFAULT NULL");
    }
    if (!aibotCols.includes('previous_key_code')) {
      await db.run("ALTER TABLE aibot_keys ADD COLUMN previous_key_code TEXT DEFAULT NULL");
    }
    if (!aibotCols.includes('custom_error_enabled')) {
      await db.run("ALTER TABLE aibot_keys ADD COLUMN custom_error_enabled INTEGER DEFAULT 0");
    }
    if (!aibotCols.includes('custom_error_message')) {
      await db.run("ALTER TABLE aibot_keys ADD COLUMN custom_error_message TEXT DEFAULT NULL");
    }
    console.log('SQLite: aibot_keys session & settings columns verified/added successfully.');
  } catch (err) {
    console.error('SQLite: Failed to run aibot_keys migrations:', err.message);
  }

  // SQLite Migration: Ensure bot_services table and offer timer columns exist
  try {
    await db.run(`
      CREATE TABLE IF NOT EXISTS bot_services (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        service_key TEXT UNIQUE,
        price TEXT NOT NULL,
        actual_price TEXT DEFAULT NULL,
        offer_ends_at TEXT DEFAULT NULL,
        offer_timer_enabled INTEGER DEFAULT 0,
        logo_url TEXT DEFAULT '',
        icon TEXT DEFAULT '🤖',
        badge TEXT DEFAULT '',
        is_highlighted INTEGER DEFAULT 0,
        is_active INTEGER DEFAULT 1,
        sort_order INTEGER DEFAULT 0,
        description TEXT DEFAULT '',
        features TEXT DEFAULT '[]',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    const bsCols = (await db.all("PRAGMA table_info(bot_services)")).map(c => c.name);
    if (!bsCols.includes('actual_price')) {
      await db.run("ALTER TABLE bot_services ADD COLUMN actual_price TEXT DEFAULT NULL");
    }
    if (!bsCols.includes('offer_ends_at')) {
      await db.run("ALTER TABLE bot_services ADD COLUMN offer_ends_at TEXT DEFAULT NULL");
    }
    if (!bsCols.includes('offer_timer_enabled')) {
      await db.run("ALTER TABLE bot_services ADD COLUMN offer_timer_enabled INTEGER DEFAULT 0");
    }
    console.log('SQLite: bot_services table and offer timer columns verified/added successfully.');
  } catch (bsErr) {
    console.error('SQLite: Failed to run bot_services migrations:', bsErr.message);
  }

  // Seed default OTC pairs in SQLite
  try {
    const defaultOtcPairs = [
      { symbol: 'EUR/USD (OTC)', base_price: 1.08 },
      { symbol: 'GBP/USD (OTC)', base_price: 1.27 },
      { symbol: 'USD/JPY (OTC)', base_price: 158.0 },
      { symbol: 'AUD/USD (OTC)', base_price: 0.66 },
      { symbol: 'USD/CAD (OTC)', base_price: 1.37 },
      { symbol: 'EUR/JPY (OTC)', base_price: 171.0 },
      { symbol: 'EUR/GBP (OTC)', base_price: 0.85 },
      { symbol: 'GBP/JPY (OTC)', base_price: 201.0 },
      { symbol: 'BTC/USD (OTC)', base_price: 64000.0 },
      { symbol: 'ETH/USD (OTC)', base_price: 3400.0 },
      { symbol: 'SAR/CNY (OTC)', base_price: 1.93 },
      { symbol: 'OMR/CNY (OTC)', base_price: 18.84 },
      { symbol: 'AUD/CHF (OTC)', base_price: 0.60 },
      { symbol: 'AED/CNY (OTC)', base_price: 1.97 },
      { symbol: 'AED CNY (OTC)', base_price: 1.97 },
      { symbol: 'USD BRL (OTC)', base_price: 5.40 }
    ];
    for (const pair of defaultOtcPairs) {
      await db.run(
        `INSERT OR IGNORE INTO otc_pairs (symbol, base_price) VALUES (?, ?)`,
        [pair.symbol, pair.base_price]
      );
    }
    console.log('SQLite: default OTC pairs seeded successfully.');
  } catch (seedErr) {
    console.error('SQLite: Failed to seed default OTC pairs:', seedErr.message);
  }

  // Ensure e_wallet_methods table exists in SQLite
  try {
    await db.run(`
      CREATE TABLE IF NOT EXISTS e_wallet_methods (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        account_name TEXT NOT NULL,
        account_number TEXT NOT NULL,
        iban TEXT,
        logo_url TEXT,
        enabled INTEGER DEFAULT 1,
        pkr_rate INTEGER DEFAULT 283,
        min_deposit REAL DEFAULT 10,
        max_deposit REAL DEFAULT 10000,
        min_withdrawal REAL DEFAULT 10,
        max_withdrawal REAL DEFAULT 10000,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    // Dynamically add pkr_rate if table already existed without it
    try {
      await db.run(`ALTER TABLE e_wallet_methods ADD COLUMN pkr_rate INTEGER DEFAULT 283`);
      console.log('SQLite: e_wallet_methods.pkr_rate column added successfully.');
    } catch (alterErr) {
      // Column already exists
    }
    // Dynamically add limit columns if table already existed without them
    try {
      await db.run(`ALTER TABLE e_wallet_methods ADD COLUMN min_deposit REAL DEFAULT 10`);
    } catch (e) {}
    try {
      await db.run(`ALTER TABLE e_wallet_methods ADD COLUMN max_deposit REAL DEFAULT 10000`);
    } catch (e) {}
    try {
      await db.run(`ALTER TABLE e_wallet_methods ADD COLUMN min_withdrawal REAL DEFAULT 10`);
    } catch (e) {}
    try {
      await db.run(`ALTER TABLE e_wallet_methods ADD COLUMN max_withdrawal REAL DEFAULT 10000`);
    } catch (e) {}
    const checkEmpty = await db.get("SELECT COUNT(*) as count FROM e_wallet_methods");
    if (checkEmpty && Number(checkEmpty.count) === 0) {
      await db.run(
        `INSERT INTO e_wallet_methods (name, account_name, account_number, iban, logo_url, pkr_rate) 
         VALUES ('SadaPay', 'Gain EX Admin', '03001234567', 'PK86SADA0000001234567890', 'https://lnwfglkcrrzxwnjqlxqv.supabase.co/storage/v1/object/public/gainex-uploads/sadapay.svg', 283)`
      );
      console.log('SQLite: default e_wallet_methods seeded successfully.');
    }
  } catch (err) {
    console.error('SQLite: Failed to initialize e_wallet_methods:', err.message);
  }

  // Dynamically add hidden_staff to deposits if table already existed without it
  try {
    await db.run(`ALTER TABLE deposits ADD COLUMN hidden_staff INTEGER DEFAULT 0`);
    console.log('SQLite: deposits.hidden_staff column added successfully.');
  } catch (alterErr) {
    // Column already exists
  }

  try {
    await db.run(`ALTER TABLE deposits ADD COLUMN reject_reason TEXT`);
    console.log('SQLite: deposits.reject_reason column added successfully.');
  } catch (e) {}

  try {
    await db.run(`ALTER TABLE withdrawals ADD COLUMN reject_reason TEXT`);
    console.log('SQLite: withdrawals.reject_reason column added successfully.');
  } catch (e) {}

  const adminExists = await db.get("SELECT * FROM users WHERE role = 'admin'");
  let adminId = null;
  if (!adminExists) {
    const salt = await bcrypt.genSalt(10);
    const hash = await bcrypt.hash('admin123', salt);
    const adminInviteCode = 'ADMIN777';
    const result = await db.run(
      `INSERT INTO users (username, password_hash, role, invite_code) 
       VALUES ('admin', ?, 'admin', ?)`,
      [hash, adminInviteCode]
    );
    adminId = result.lastID;

    await db.run(
      `INSERT INTO permissions (user_id, user_management, deposit_approval, withdrawal_approval, trade_monitoring, full_access)
       VALUES (?, 1, 1, 1, 1, 1)`,
      [adminId]
    );

    // Seed admin invite code in invite_codes table
    await db.run(
      `INSERT INTO invite_codes (code, created_by_id) VALUES (?, ?)`,
      [adminInviteCode, adminId]
    );

    console.log('Seeded default Admin: username="admin", password="admin123", invite_code="ADMIN777"');
  }

  // Ensure ADMIN777 invite code exists in invite_codes table
  const adminUser = await db.get("SELECT id FROM users WHERE username = 'admin' LIMIT 1");
  if (adminUser) {
    const codeExists = await db.get("SELECT * FROM invite_codes WHERE code = 'ADMIN777'");
    if (!codeExists) {
      await db.run(
        `INSERT INTO invite_codes (code, created_by_id) VALUES (?, ?)`,
        ['ADMIN777', adminUser.id]
      );
      console.log('Seeded ADMIN777 invite code for existing admin.');
    }
  }

  const defaultSettings = [
    { key: 'usdt_deposit_address', value: '0x1234567890abcdef1234567890abcdef12345678' },
    { key: 'usdt_trc20_deposit_address', value: '0x1234567890abcdef1234567890abcdef12345678' },
    { key: 'usdt_erc20_deposit_address', value: '0xabcdef1234567890abcdef1234567890abcdef12' },
    { key: 'usdt_bep20_deposit_address', value: '0x7890abcdef1234567890abcdef1234567890abcd' },
    { key: 'usdt_ltc_deposit_address', value: 'LtcAddressPlaceholder1234567890' },
    { key: 'usdt_aptos_deposit_address', value: 'AptosAddressPlaceholder1234567890' },
    { key: 'usdc_deposit_address', value: '0xabcdef1234567890abcdef1234567890abcdef12' },
    { key: 'bank_deposit_details', value: 'Bank: Gain EX Global Bank\nAccount Number: 9876543210\nAccount Name: Gain EX INC\nIFSC/BIC Code: GAINEX999' },
    { key: 'deposit_usdt_enabled', value: 'true' },
    { key: 'deposit_usdc_enabled', value: 'true' },
    { key: 'deposit_bank_enabled', value: 'true' },
    { key: 'withdrawal_usdt_enabled', value: 'true' },
    { key: 'withdrawal_usdc_enabled', value: 'true' },
    { key: 'withdrawal_bank_enabled', value: 'true' },
    { key: 'withdrawal_jazzcash_enabled', value: 'true' },
    { key: 'withdrawal_easypaisa_enabled', value: 'true' },
    { key: 'withdrawal_nayapay_enabled', value: 'true' },
    { key: 'withdrawal_zindagi_enabled', value: 'true' },
    { key: 'withdrawal_sadapay_enabled', value: 'true' },
    { key: 'crypto_visible_coins', value: JSON.stringify(['BTC', 'ETH', 'SOL', 'BNB', 'DOGE', 'XRP', 'ADA', 'AVAX', 'MATIC', 'LINK', 'LTC', 'DOT', 'TRX', 'UNI', 'ATOM']) },
    { key: 'forex_visible_pairs', value: JSON.stringify(['EUR/USD', 'USD/CAD', 'GBP/USD', 'USD/JPY', 'AUD/USD', 'USD/CHF', 'NZD/USD', 'EUR/GBP', 'EUR/JPY', 'GBP/JPY', 'USD/INR', 'USD/PKR', 'USD/BDT', 'GBP/CHF']) },
    { key: 'combine_trades_control', value: 'false' },
    { key: 'combine_trades_outcome', value: 'none' },
    { key: 'currency_rate_INR', value: '84.0' },
    { key: 'currency_rate_PKR', value: '278.0' },
    { key: 'currency_rate_BDT', value: '117.0' },
    { key: 'currency_rate_NPR', value: '133.0' },
    { key: 'currency_rate_USD', value: '1.0' },
    { key: 'currency_rate_GBP', value: '0.78' },
    { key: 'currency_rate_BRL', value: '5.4' },
    { key: 'currency_rate_IDR', value: '16000.0' },
    { key: 'currency_rate_MYR', value: '4.7' },
    { key: 'currency_rate_KZT', value: '475.0' },
    { key: 'currency_rate_THB', value: '36.0' },
    { key: 'currency_rate_UAH', value: '41.0' },
    { key: 'currency_rate_VND', value: '25400.0' },
    { key: 'currency_rate_NGN', value: '1500.0' },
    { key: 'currency_rate_EGP', value: '48.0' },
    { key: 'currency_rate_MXN', value: '18.0' },
    { key: 'currency_rate_JPY', value: '160.0' },
    { key: 'currency_rate_PHP', value: '58.0' },
    { key: 'currency_rate_TRY', value: '32.5' },
    { key: 'currency_rate_KRW', value: '1380.0' },
    { key: 'referral_commission_pct', value: '5.0' },
    { key: 'page_loader_delay_ms', value: '400' },
    { key: 'onboarding_slides', value: JSON.stringify([
      { title: 'Welcome to Gain EX 👋', description: 'The best app to invest in various crypto stocks in the world today!', image: '/images/onboarding1.png' },
      { title: 'Get Better Returns 🚀', description: 'Invest in the biggest crypto market & unlock amazing returns of investment.', image: '/images/onboarding2.png' },
      { title: 'Start with Just $1.00 💰', description: "You don't have to buy a whole share, you can buy a fraction.", image: '/images/onboarding3.png' },
      { title: 'Your Safety is First 🛡️', description: 'Your brokerage account is secured with advanced military-grade encryption.', image: '/images/onboarding4.png' },
      { title: 'No Commissions ⚡', description: 'No commissions ever, just trade and maximize your returns.', image: '/images/onboarding5.png' }
    ]) },
    { key: 'daily_bonus_criteria', value: JSON.stringify([
      { milestone: 1, days: 14, min_volume: 5, bonus: 10 },
      { milestone: 2, days: 21, min_volume: 10, bonus: 15 },
      { milestone: 3, days: 30, min_volume: 15, bonus: 50 }
    ]) },
    { key: 'refund_policy_description', value: '<h3>Return / Refund Policy</h3><p>At Gain EX, we strive to deliver premium investment and trading services. Since financial asset transactions are processed immediately, direct trade operations are non-refundable. However, wallet deposits that have not been used for trading can be requested for withdrawal/refund back to the original funding source under our compliance terms.</p>' },
    { key: 'shipping_policy_description', value: '<h3>Shipping & Service Policies</h3><p>Service Delivery: Trading services, platform access, and market data feeds are delivered digitally instantly upon account creation and successful verification. Physical items, such as customized GXM debit cards (if ordered), are shipped within 7-14 business days via global priority courier services.</p>' },
    { key: 'office_address', value: '156 A, opposite hospital center park housing scheme, lahore.' },
    { key: 'office_number', value: '+971503561361' },
    { key: 'leaderboard_custom_mode', value: 'hybrid' },
    { key: 'leaderboard_min_profit', value: '500' },
    { key: 'leaderboard_max_profit', value: '25000' },
    { key: 'leaderboard_auto_fluctuate', value: 'true' },
    { key: 'aibot_global_status', value: 'true' }
  ];

  for (const setting of defaultSettings) {
    // Force update pairs lists so they always contain the full set
    if (setting.key === 'crypto_visible_coins' || setting.key === 'forex_visible_pairs') {
      await db.run(
        `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        [setting.key, setting.value]
      );
    } else {
      await db.run(
        `INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`,
        [setting.key, setting.value]
      );
    }
  }

  await syncTradeOptions(db);

  // SQLite Migration: Add commission_pct to invite_codes (nullable = use global default)
  try {
    await db.run(`ALTER TABLE invite_codes ADD COLUMN commission_pct REAL DEFAULT NULL`);
    console.log('SQLite: invite_codes.commission_pct column added successfully.');
  } catch (e) {
    // Column likely already exists — that is fine
  }

  // SQLite Migration: Add dashboard permissions and live_support columns to permissions table
  try {
    await db.run(`ALTER TABLE permissions ADD COLUMN live_support INTEGER DEFAULT 0`);
  } catch (e) {}
  try {
    await db.run(`ALTER TABLE permissions ADD COLUMN dash_live_activity INTEGER DEFAULT 0`);
  } catch (e) {}
  try {
    await db.run(`ALTER TABLE permissions ADD COLUMN dash_global_settings INTEGER DEFAULT 0`);
  } catch (e) {}
  try {
    await db.run(`ALTER TABLE permissions ADD COLUMN dash_live_trades INTEGER DEFAULT 0`);
  } catch (e) {}
  try {
    await db.run(`ALTER TABLE permissions ADD COLUMN dash_kyc_list INTEGER DEFAULT 0`);
  } catch (e) {}
  try {
    await db.run(`ALTER TABLE permissions ADD COLUMN earnings_history INTEGER DEFAULT 1`);
  } catch (e) {}
  try {
    await db.run(`ALTER TABLE permissions ADD COLUMN withdrawal_limit REAL DEFAULT 1000.00`);
  } catch (e) {}

  try {
    await db.run(`
      CREATE TABLE IF NOT EXISTS employee_withdrawals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        employee_id INTEGER NOT NULL,
        amount REAL NOT NULL,
        method TEXT NOT NULL,
        account_details TEXT NOT NULL,
        status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected')),
        admin_notes TEXT DEFAULT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        resolved_at TIMESTAMP DEFAULT NULL,
        resolved_by_id INTEGER DEFAULT NULL,
        FOREIGN KEY(employee_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);
  } catch (e) {}

  try {
    await db.run(`
      CREATE TABLE IF NOT EXISTS custom_leaderboard (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER DEFAULT NULL,
        username TEXT NOT NULL,
        full_name TEXT DEFAULT NULL,
        country TEXT DEFAULT 'US',
        net_profit REAL NOT NULL DEFAULT 0.0,
        won_trades INTEGER NOT NULL DEFAULT 10,
        lost_trades INTEGER NOT NULL DEFAULT 2,
        position INTEGER DEFAULT NULL,
        is_active INTEGER DEFAULT 1,
        avatar_url TEXT DEFAULT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
  } catch (e) {}

  try {
    await db.run(`
      CREATE TABLE IF NOT EXISTS ip_alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL,
        ip_address TEXT NOT NULL,
        conflict_username TEXT NOT NULL,
        acknowledged INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
  } catch (e) {}

  try {
    await db.run(`
      CREATE TABLE IF NOT EXISTS scheduled_emails (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        subject TEXT NOT NULL,
        html_content TEXT NOT NULL,
        recipient_type TEXT NOT NULL,
        recipient_ids TEXT DEFAULT NULL,
        schedule_times TEXT NOT NULL,
        schedule_days TEXT NOT NULL,
        last_sent TEXT DEFAULT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
  } catch (e) {}

  // If running on PostgreSQL/Supabase, verify & enable Row Level Security on all public schema tables
  if (db.isPg && pgPool) {
    try {
      await pgPool.query(`
        DO $$
        DECLARE
          t text;
        BEGIN
          FOR t IN 
            SELECT table_name 
            FROM information_schema.tables 
            WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
          LOOP
            EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', t);
          END LOOP;
        END $$;
      `);
      console.log('PostgreSQL: Row Level Security (RLS) verified and enabled for all public tables.');
    } catch (rlsErr) {
      console.error('PostgreSQL: Non-fatal notice when enabling RLS:', rlsErr.message);
    }
  }

  await fillRetroactiveReferrerCommissions(db);
  console.log('Database initialized successfully.');
}

async function syncTradeOptions(db) {
  try {
    const desiredDurations = [10, 15, 30, 60, 120, 180, 300, 600, 900, 1800, 3600, 7200];
    const existingOpts = await db.all('SELECT duration FROM trade_options');
    const existingDurations = existingOpts.map(o => o.duration);

    const match = desiredDurations.length === existingDurations.length && desiredDurations.every(d => existingDurations.includes(d));
    if (!match) {
      console.log('Syncing trade options to: 10s, 15s, 30s, 1m, 2m, 3m, 5m, 10m, 15m, 30m, 1h, 2h...');
      await db.run('DELETE FROM trade_options WHERE 1=1');
      const defaultTradeOptions = [
        { duration: 10, commission_pct: 5.0 },
        { duration: 15, commission_pct: 5.0 },
        { duration: 30, commission_pct: 5.0 },
        { duration: 60, commission_pct: 5.0 },
        { duration: 120, commission_pct: 5.0 },
        { duration: 180, commission_pct: 5.0 },
        { duration: 300, commission_pct: 5.0 },
        { duration: 600, commission_pct: 5.0 },
        { duration: 900, commission_pct: 5.0 },
        { duration: 1800, commission_pct: 5.0 },
        { duration: 3600, commission_pct: 5.0 },
        { duration: 7200, commission_pct: 5.0 }
      ];
      for (const opt of defaultTradeOptions) {
        await db.run(
          `INSERT INTO trade_options (duration, commission_pct) VALUES (?, ?)`,
          [opt.duration, opt.commission_pct]
        );
      }
    }
  } catch (err) {
    console.error('Error syncing trade options:', err.message);
  }
}

async function fillRetroactiveReferrerCommissions(db) {
  try {
    // Fetch all resolved lost real trades of referred users where referrer_commission is null
    const trades = await db.all(`
      SELECT t.id, t.user_id, t.amount, u.invited_by_id
      FROM trades t
      JOIN users u ON t.user_id = u.id
      WHERE t.status = 'lose' 
        AND (t.is_demo = 0 OR t.is_demo IS NULL)
        AND u.invited_by_id IS NOT NULL
        AND t.referrer_commission IS NULL
    `);

    console.log(`[RETROACTIVE COMMISSION] Found ${trades.length} trades to verify for retroactive referral commission.`);

    for (const trade of trades) {
      const referrerId = Number(trade.invited_by_id);
      const referrer = await db.get("SELECT role FROM users WHERE id = ?", [referrerId]);
      if (referrer && referrer.role === 'employee') {
        let pct = 5.0;
        const inviteRow = await db.get('SELECT commission_pct FROM invite_codes WHERE created_by_id = ? AND commission_pct IS NOT NULL LIMIT 1', [referrerId]);
        if (inviteRow) {
          pct = parseFloat(inviteRow.commission_pct);
        } else {
          const pctRow = await db.get("SELECT value FROM settings WHERE key = 'referral_commission_pct'");
          pct = pctRow ? parseFloat(pctRow.value) : 5.0;
        }
        const comm = trade.amount * (pct / 100.0);
        await db.run("UPDATE trades SET referrer_commission = ? WHERE id = ?", [comm, trade.id]);
        console.log(`[RETROACTIVE COMMISSION] Set referrer_commission = ${comm} for trade #${trade.id} lost by user #${trade.user_id} (employee referrer #${referrerId})`);
      } else {
        await db.run("UPDATE trades SET referrer_commission = 0.0 WHERE id = ?", [trade.id]);
      }
    }
  } catch (err) {
    console.error('Failed retroactively filling referrer commissions:', err);
  }
}

module.exports = {
  getDB,
  initDB
};
