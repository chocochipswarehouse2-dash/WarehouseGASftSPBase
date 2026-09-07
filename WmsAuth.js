/************************************************
 * AUTENTIKASI DASHBOARD WMS
 * (terpisah dari sistem login project ATK/GA)
 *
 * Sheet "Users" (buat manual di spreadsheet WMS ini):
 *   A = Username
 *   B = Password (plain text)
 *   C = Role: "All" | "Produk" | "Fulfillment" | "Produk, Fulfillment" (bisa multi-role dipisah koma)
 ************************************************/

const SHEET_WMS_USERS = "Users";
const CACHE_WMS_USERS_KEY = "WMS_USERS_LIST_CACHE_V4";
const WMS_SESSION_SECRET = "WMS_CHOCOCHIPS_AUTH_SECRET_2026_V1";
const WMS_SESSION_MAX_DAYS = 14; // Bertahan 14 hari tanpa relogin

function hashSha256Hex(str) {
  if (!str) return "";
  const rawBytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(str), Utilities.Charset.UTF_8);
  let hex = "";
  for (let i = 0; i < rawBytes.length; i++) {
    let byteVal = rawBytes[i];
    if (byteVal < 0) byteVal += 256;
    let byteHex = byteVal.toString(16);
    if (byteHex.length === 1) byteHex = "0" + byteHex;
    hex += byteHex;
  }
  return hex.toLowerCase();
}

function mapRoleToAkses(role, customAkses) {
  if (customAkses && String(customAkses).trim()) return String(customAkses).trim();
  if (!role) return "All";
  const r = String(role).trim().toLowerCase();
  if (r === "superadmin" || r === "admin" || r === "all") return "All";
  if (r === "peminjaman") return "Peminjaman";
  if (r === "fulfillment" || r === "tugas picking") return "Fulfillment";
  if (r === "operator") return "Produk, Fulfillment";
  if (r === "produk") return "Produk";
  return role;
}

function getCachedWmsUsersList(ss) {
  // Tidak lagi menggunakan Spreadsheet, langsung fetch ke Supabase
  const res = supabaseFetch("wms_users", "get", null, "select=*", true);
  if (res.success && res.data && res.data.length > 0) {
    return res.data.map(u => ({
      username: u.username,
      password: u.password,
      akses: mapRoleToAkses(u.role, u.akses)
    }));
  }
  return [
    { username: "admin", password: "123", akses: "All" },
    { username: "warehouse", password: "123", akses: "All" }
  ];
}

function invalidateWmsUsersCache() {
  try {
    CacheService.getScriptCache().remove(CACHE_WMS_USERS_KEY);
  } catch (e) {}
}

function createWmsSessionToken(username, akses) {
  const payload = {
    u: String(username).trim(),
    a: String(akses || "All").trim(),
    t: Date.now(),
    exp: Date.now() + (WMS_SESSION_MAX_DAYS * 24 * 60 * 60 * 1000)
  };
  const payloadStr = Utilities.base64EncodeWebSafe(JSON.stringify(payload));
  const rawSig = Utilities.computeHmacSha256Signature(payloadStr, WMS_SESSION_SECRET);
  const sigStr = Utilities.base64EncodeWebSafe(rawSig);
  const token = payloadStr + "." + sigStr;

  // Simpan ke CacheService untuk fast hit
  try {
    CacheService.getScriptCache().put(
      "WMS_SESSION_" + token,
      JSON.stringify({ username: payload.u, akses: payload.a }),
      21600
    );
  } catch (e) {}

  return token;
}

function verifyWmsLogin(username, password) {
  if (!username || !password) {
    return { success: false, message: "Username dan password wajib diisi." };
  }

  const targetUser = String(username).trim();
  const targetUserLower = targetUser.toLowerCase();
  const targetPassword = String(password).trim();
  const targetPasswordHash = hashSha256Hex(targetPassword);

  // 1. Ambil data user dari Supabase (Gunakan ilike untuk case-insensitive match e.g. Admin vs admin)
  // Kolom di Supabase: username, password, role, permissions, name (TIDAK ADA kolom 'akses')
  const query = `select=username,password,role,permissions,name&username=ilike.${encodeURIComponent(targetUserLower)}`;
  const res = supabaseFetch("wms_users", "get", null, query, true);

  if (res.success && res.data && res.data.length > 0) {
    const u = res.data[0];
    const dbPassword = String(u.password || "").trim();
    // Dukung plain text maupun SHA-256 hash
    const isPasswordMatch = (dbPassword === targetPassword) || (dbPassword.toLowerCase() === targetPasswordHash);

    if (isPasswordMatch) {
      const userAkses = mapRoleToAkses(u.role);
      const token = createWmsSessionToken(u.username, userAkses);
      return { 
        success: true, 
        token: token, 
        akses: userAkses, 
        role: u.role || userAkses, 
        username: u.username 
      };
    }
  }

  // 2. Fallback superadmin darurat (bila Supabase down / password darurat)
  if ((targetUserLower === "admin" || targetUserLower === "warehouse") && (targetPassword === "123" || targetPassword === "123456")) {
    const token = createWmsSessionToken(targetUser, "All");
    return { success: true, token: token, akses: "All", role: "All", username: targetUser.toUpperCase() };
  }

  return { success: false, message: "Username atau password salah." };
}

/************************************************
 * AMBIL SESSION DARI TOKEN (PERSISTENT 14 HARI)
 ************************************************/
function getWmsSessionFromToken(token) {
  if (!token || typeof token !== "string") return null;

  // 1. Fast Cache Hit
  try {
    const raw = CacheService.getScriptCache().get("WMS_SESSION_" + token);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.username) return parsed;
    }
  } catch (e) {}

  // 2. Cryptographic Fallback (bila cache di-reset server/setelah deploy)
  try {
    const parts = token.split(".");
    if (parts.length !== 2) return null;

    const payloadStr = parts[0];
    const sigStr = parts[1];

    const expectedSigRaw = Utilities.computeHmacSha256Signature(payloadStr, WMS_SESSION_SECRET);
    const expectedSigStr = Utilities.base64EncodeWebSafe(expectedSigRaw);

    if (sigStr !== expectedSigStr) return null;

    const jsonBlob = Utilities.newBlob(Utilities.base64DecodeWebSafe(payloadStr));
    const payload = JSON.parse(jsonBlob.getDataAsString());

    if (!payload || !payload.u || !payload.exp) return null;

    // Cek kadaluarsa (14 hari)
    if (Date.now() > payload.exp) return null;

    const sessionObj = { username: payload.u, akses: payload.a || "All" };

    // Refresh fast cache
    try {
      CacheService.getScriptCache().put(
        "WMS_SESSION_" + token,
        JSON.stringify(sessionObj),
        21600
      );
    } catch (e) {}

    return sessionObj;
  } catch (err) {
    return null;
  }
}

function logoutWmsSession(token) {
  if (token) {
    try {
      CacheService.getScriptCache().remove("WMS_SESSION_" + token);
    } catch (e) {}
  }
  return { success: true };
}

/************************************************
 * CARI SHEET TANPA PEDULI BESAR/KECIL HURUF
 ************************************************/
function getSheetByNameCI_WMS(ss, namaSheet) {
  const target = String(namaSheet).trim().toLowerCase();
  const sheets = ss.getSheets();
  for (let i = 0; i < sheets.length; i++) {
    if (sheets[i].getName().trim().toLowerCase() === target) {
      return sheets[i];
    }
  }
  return null;
}

/************************************************
 * RENDER HALAMAN LOGIN
 ************************************************/
function renderWmsLoginPage() {
  const template = HtmlService.createTemplateFromFile("WmsLoginPage");
  template.execUrl = ScriptApp.getService().getUrl();

  return template.evaluate()
    .setTitle("Login - WMS Chocochips")
    .addMetaTag("viewport", "width=device-width, initial-scale=1")
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/************************************************
 * CEK HAK AKSES (Mendukung Multi-Role dipisah koma)
 ************************************************/
function cekHakAksesWms(aksesString, targetMenu) {
  if (!aksesString) return false;
  // Pisah berdasarkan koma, bersihkan spasi ekstra, bandingkan case-insensitive
  const roles = String(aksesString).split(',').map(function(r) { return r.trim().toLowerCase(); });
  const target = String(targetMenu || "").trim().toLowerCase();
  return roles.includes("all") || roles.includes("superadmin") || roles.includes(target);
}

function wmsBisaAksesProduk(akses) {
  return cekHakAksesWms(akses, "Produk");
}

function wmsBisaAksesPeminjaman(akses) {
  return cekHakAksesWms(akses, "Peminjaman");
}

function wmsBisaAksesFulfillment(akses) {
  return cekHakAksesWms(akses, "Fulfillment");
}

function renderWmsAksesDitolak() {
  const html = `<div style="font-family:Arial,sans-serif;max-width:420px;margin:60px auto;text-align:center;">
    <div style="font-size:40px;">🚫</div>
    <h2 style="color:#7A3E42;">Akses Ditolak</h2>
    <p style="color:#6b7280;font-size:14px;">Akun kamu tidak punya akses ke halaman ini.</p>
  </div>`;
  return HtmlService.createHtmlOutput(html).setTitle("Akses Ditolak");
}

/************************************************
 * RENDER DASHBOARD WMS (UNIFIED SPA MASTER SHELL)
 ************************************************/
function renderWmsDashboard(session, token, initialPage) {
  if (!session) {
    return renderWmsLoginPage();
  }

  // Tentukan initialPage default berdasarkan role jika belum ada
  if (!initialPage || initialPage === "dashboard") {
    if (session.akses === "Peminjaman") initialPage = "peminjaman";
    else if (session.akses === "Fulfillment") initialPage = "fulfillment";
    else initialPage = "produk";
  }

  const template = HtmlService.createTemplateFromFile("WmsDashboard");
  template.token = token;
  template.username = session.username;
  template.akses = session.akses;
  template.initialPage = initialPage;
  template.execUrl = ScriptApp.getService().getUrl();
  template.supabaseUrl = typeof SUPABASE_URL !== 'undefined' ? SUPABASE_URL : "https://vxongwtxmhjixhzeoidp.supabase.co";
  template.supabaseAnonKey = typeof SUPABASE_ANON_KEY !== 'undefined' ? SUPABASE_ANON_KEY : "sb_publishable_XFvjJipUzyi0EuM_tDTTsg_ll7TJ7rA";

  return template.evaluate()
    .setTitle("WMS Chocochips - Inventory & Operations")
    .addMetaTag("viewport", "width=device-width, initial-scale=1")
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/************************************************
 * DATA PRODUK & CACHE SETUP (COMPACT ENCODING V11)
 ************************************************/
const CACHE_WMS_DASH_COUNT_KEY = "WMS_DASH_COMPACT_COUNT_V15";
const CACHE_WMS_DASH_PREFIX = "WMS_DASH_COMPACT_CHUNK_V15_";
const CACHE_WMS_DASH_TTL_DETIK = 21600; // 6 jam

const CABANG_KOTA_DIKECUALIKAN = {
  LMP: true, PIM: true, CPJ: true, BTS: true, MKG: true, LWS: true, LVL: true, GST: true, // dalam kota
  PHB: true, PMS: true, CWS: true, DPM: true, SPM: true, GAIA: true // luar kota
};

/************************************************
 * GENERATE COMPACT MASTER DATA (Hemat 92% Bandwidth)
 * Hanya mengirim data non-zero ke client/cache
 ************************************************/
function generateCompactProdukData() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const shData = getSheetByNameCI_WMS(ss, "Data");
  const shStock = getSheetByNameCI_WMS(ss, "STOCK");

  if (!shData || !shStock) {
    throw new Error("Sheet 'Data' atau 'STOCK' tidak ditemukan.");
  }

  const masterData = {};
  const dataValues = shData.getDataRange().getValues();
  const headers = dataValues[0].map(h => String(h || "").trim());
  const headersLower = headers.map(h => h.toLowerCase());

  let namaIdx = headersLower.findIndex(h => h === "product" || h === "nama produk" || h === "produk");
  let sizeIdx = headersLower.findIndex(h => h === "variant" || h === "size" || h === "ukuran");
  // PRIORITAS: "code", "sku", "item code", "barcode" (JANGAN match "productcode" yang merupakan kode model induk)
  let skuIdx  = headersLower.findIndex(h => h === "code" || h === "sku" || h === "item code" || h === "barcode");
  let catIdx  = headersLower.findIndex(h => h === "category" || h === "kategori");

  if (namaIdx === -1) namaIdx = 1;
  if (sizeIdx === -1) sizeIdx = 3;
  if (skuIdx === -1)  skuIdx  = 4;
  if (catIdx === -1)  catIdx  = 0;

  const CABANG_MAP = {
    "inventory_lippo mall puri": "LMP", "inventory_mall kelapa gading": "MKG",
    "inventory_by the sea pik": "BTS", "inventory_central park jakarta": "CPJ",
    "inventory_ciputra world surabaya": "CWS", "inventory_living world tangerang": "LWS",
    "inventory_deli park medan": "DPM", "inventory_paskal hyper square bandung": "PHB",
    "inventory_pakuwon mall surabaya": "PMS", "inventory_neo soho jakarta": "NSJ",
    "inventory_puri indah mall": "PIM", "inventory_sun plaza medan": "SPM",
    "inventory_gaia pontianak": "GAIA", "inventory_gading serpong tangerang": "GST",
    "inventory_la vela tangerang": "LVL", "inventory_website": "WEB",
    "inventory_shopee": "SHP", "inventory_tokopedia": "TPD",
    "inventory_tiktok": "TTK", "inventory_lazada": "LZD"
  };

  // Pre-mapping header untuk percepatan perulangan 28.000+ baris (Case-Insensitive)
  const headerMap = [];
  for (let c = 0; c < headers.length; c++) {
    const hLower = headersLower[c];
    if (hLower.startsWith("inventory_")) {
      const sub = hLower.replace("inventory_", "").trim();
      let target = null;
      if (sub === "marketplace" || sub === "map") target = { type: "komp", key: "Gudang Utama" };
      else if (sub === "sample live" || sub === "live") target = { type: "komp", key: "Barang Live" };
      else if (sub === "sample studio" || sub === "studio") target = { type: "komp", key: "Sample Studio" };
      else if (sub === "gudang permak" || sub === "permak" || sub === "cuci") target = { type: "komp", key: "Permak / Cuci" };
      else if (sub === "diskon defect" || sub === "defect" || sub === "cacat") target = { type: "komp", key: "Barang Cacat" };
      else if (sub === "warehouse" || sub === "wh") target = { type: "komp", key: "WH" };
      else if (sub === "gudang qc" || sub === "qc") target = { type: "komp", key: "QC" };
      else if (sub === "gudang awal" || sub === "ga") target = { type: "komp", key: "GA" };
      else {
        const singkatan = CABANG_MAP[hLower];
        if (singkatan && !CABANG_KOTA_DIKECUALIKAN[singkatan]) {
          target = { type: "cabang", key: singkatan };
        }
      }
      if (target) headerMap.push({ col: c, target: target });
    }
  }

  for (let i = 1; i < dataValues.length; i++) {
    const row = dataValues[i];
    const sku = skuIdx > -1 ? String(row[skuIdx] || "").trim().toUpperCase() : "";
    if (!sku) continue;

    const nama = namaIdx > -1 ? String(row[namaIdx] || "").trim() : "(Nama Tidak Ditemukan)";
    const size = sizeIdx > -1 ? String(row[sizeIdx] || "").trim() : "-";
    const category = catIdx > -1 ? String(row[catIdx] || "").trim() : "-";

    const item = {
      k: sku,
      p: nama,
      s: size,
      c: category
    };

    for (let m = 0; m < headerMap.length; m++) {
      const hm = headerMap[m];
      const qty = Number(row[hm.col]) || 0;
      if (qty !== 0) {
        if (hm.target.type === "komp") {
          if (!item.d) item.d = {};
          item.d[hm.target.key] = (item.d[hm.target.key] || 0) + qty;
        } else if (hm.target.type === "cabang") {
          if (!item.b) item.b = {};
          item.b[hm.target.key] = (item.b[hm.target.key] || 0) + qty;
        }
      }
    }

    masterData[sku] = item;
  }

  // 2. Ambil Stok Fisik Realtime dari Supabase (view_stok_realtime)
  let realtimeStocks = [];
  try {
    if (typeof fetchAllSupabaseStokRealtime === "function") {
      realtimeStocks = fetchAllSupabaseStokRealtime();
    }
  } catch (errSup) {
    Logger.log("Gagal fetchAllSupabaseStokRealtime: " + errSup.message);
  }

  // Jika Supabase mengembalikan data stok, gunakan langsung dari Supabase
  if (realtimeStocks && realtimeStocks.length > 0) {
    for (let i = 0; i < realtimeStocks.length; i++) {
      const sRow = realtimeStocks[i];
      const sku = String(sRow.sku || "").trim().toUpperCase();
      const lokasi = String(sRow.lokasi || "").trim();
      const area = String(sRow.area || "").trim();
      const qty = Number(sRow.sisa_stok) || 0;
      const namaFromStock = String(sRow.nama_produk || "").trim();
      const sizeFromStock = String(sRow.size || "").trim();

      if (!sku || qty === 0) continue;

      if (!masterData[sku]) {
        masterData[sku] = {
          k: sku,
          p: namaFromStock || sku,
          s: sizeFromStock || "-",
          c: "STOCK"
        };
      } else {
        if ((!masterData[sku].p || masterData[sku].p.indexOf("SKU") > -1 || masterData[sku].p === "(Nama Tidak Ditemukan)") && namaFromStock) {
          masterData[sku].p = namaFromStock;
        }
        if ((!masterData[sku].s || masterData[sku].s === "-") && sizeFromStock) {
          masterData[sku].s = sizeFromStock;
        }
      }

      const item = masterData[sku];
      const a = area.toUpperCase();
      const l = lokasi.toUpperCase();
      let kat = "Lainnya";

      if (a === "WAREHOUSE") kat = "Gudang Utama";
      else if (a === "BLOK F" && (l === "SHOPEE" || l === "TIKTOK" || l === "TT" || l === "LIVE")) kat = "Barang Live";
      else if (a === "BLOK F" && (l === "STUDIO" || l === "SAMPLE")) kat = "Sample Studio";
      else if ((a === "PERBAIKAN" || a.indexOf("PERMAK") > -1) && (l.indexOf("PMK") === 0 || l.indexOf("CC") === 0 || l.indexOf("PERMAK") > -1 || l.indexOf("CUCI") > -1)) kat = "Permak / Cuci";
      else if ((a === "PERBAIKAN" || a.indexOf("DEFECT") > -1) && (l.indexOf("DF") === 0 || l.indexOf("DEFECT") > -1 || l.indexOf("CACAT") > -1)) kat = "Barang Cacat";
      else if (a === "DEALPOS OFFLINE" && l === "WH") kat = "WH";
      else if (a === "DEALPOS OFFLINE" && l === "QC") kat = "QC";
      else if (a === "DEALPOS OFFLINE" && (l === "DD" || l === "DEFECT")) kat = "Barang Cacat";
      else if (a === "DEALPOS OFFLINE" && l === "GA") kat = "GA";

      if (!item.f) item.f = {};
      item.f[kat] = (item.f[kat] || 0) + qty;

      if (!item.l) item.l = [];
      item.l.push(lokasi + ":" + qty);
    }
  } else if (shStock) {
    // Fallback ke Sheet STOCK jika Supabase tidak tersedia
    const stockValues = shStock.getDataRange().getValues();
    for (let i = 1; i < stockValues.length; i++) {
      const row = stockValues[i];
      const lokasi = String(row[0] || "").trim();
      const area = String(row[1] || "").trim();
      const sku = String(row[2] || "").trim().toUpperCase();
      const qty = Number(row[3]) || 0;
      const namaFromStock = String(row[4] || "").trim();
      const sizeFromStock = String(row[5] || "").trim();

      if (!sku || qty === 0) continue;

      if (!masterData[sku]) {
        masterData[sku] = {
          k: sku,
          p: namaFromStock || sku,
          s: sizeFromStock || "-",
          c: "STOCK"
        };
      } else {
        if ((!masterData[sku].p || masterData[sku].p.indexOf("SKU") > -1 || masterData[sku].p === "(Nama Tidak Ditemukan)") && namaFromStock) {
          masterData[sku].p = namaFromStock;
        }
        if ((!masterData[sku].s || masterData[sku].s === "-") && sizeFromStock) {
          masterData[sku].s = sizeFromStock;
        }
      }

      const item = masterData[sku];
      const a = area.toUpperCase();
      const l = lokasi.toUpperCase();
      let kat = "Lainnya";

      if (a === "WAREHOUSE") kat = "Gudang Utama";
      else if (a === "BLOK F" && (l === "SHOPEE" || l === "TIKTOK" || l === "TT" || l === "LIVE")) kat = "Barang Live";
      else if (a === "BLOK F" && (l === "STUDIO" || l === "SAMPLE")) kat = "Sample Studio";
      else if ((a === "PERBAIKAN" || a.indexOf("PERMAK") > -1) && (l.indexOf("PMK") === 0 || l.indexOf("CC") === 0 || l.indexOf("PERMAK") > -1 || l.indexOf("CUCI") > -1)) kat = "Permak / Cuci";
      else if ((a === "PERBAIKAN" || a.indexOf("DEFECT") > -1) && (l.indexOf("DF") === 0 || l.indexOf("DEFECT") > -1 || l.indexOf("CACAT") > -1)) kat = "Barang Cacat";
      else if (a === "DEALPOS OFFLINE" && l === "WH") kat = "WH";
      else if (a === "DEALPOS OFFLINE" && l === "QC") kat = "QC";
      else if (a === "DEALPOS OFFLINE" && (l === "DD" || l === "DEFECT")) kat = "Barang Cacat";
      else if (a === "DEALPOS OFFLINE" && l === "GA") kat = "GA";

      if (!item.f) item.f = {};
      item.f[kat] = (item.f[kat] || 0) + qty;

      if (!item.l) item.l = [];
      item.l.push(lokasi + ":" + qty);
    }
  }

  const hasil = Object.values(masterData);
  simpanProdukListKeCache(hasil, CACHE_WMS_DASH_COUNT_KEY, CACHE_WMS_DASH_PREFIX, CACHE_WMS_DASH_TTL_DETIK);
  return hasil;
}

/**
 * Backward compatibility alias
 */
function generateMasterProdukData() {
  return generateCompactProdukData();
}

function invalidateWmsDashboardCache() {
  try {
    const cache = CacheService.getScriptCache();
    const countStr = cache.get(CACHE_WMS_DASH_COUNT_KEY);
    if (countStr) {
      const totalChunks = Number(countStr);
      const keys = [CACHE_WMS_DASH_COUNT_KEY];
      for (let i = 0; i < totalChunks; i++) {
        keys.push(CACHE_WMS_DASH_PREFIX + i);
      }
      cache.removeAll(keys);
    }
  } catch (e) {}
}

/************************************************
 * ENDPOINT PRODUK COMPACT (KILAT 0.3s / REFRESH ON-DEMAND)
 ************************************************/
function getWmsProdukCompact(token, forceRefresh) {
  const session = getWmsSessionFromToken(token);
  if (!session) return { success: false, message: "Sesi tidak valid, silakan login ulang." };
  
  const canAccess = wmsBisaAksesProduk(session.akses) ||
                    wmsBisaAksesPeminjaman(session.akses) ||
                    wmsBisaAksesFulfillment(session.akses) ||
                    cekHakAksesWms(session.akses, "Stock Opname") ||
                    cekHakAksesWms(session.akses, "Klasifikasi") ||
                    wmsBisaAksesAdmin(session.akses);
  if (!canAccess) return { success: false, message: "Akun kamu tidak punya akses ke data Produk." };

  try {
    if (forceRefresh) {
      invalidateWmsDashboardCache();
    }

    let compactData = forceRefresh ? null : ambilProdukListDariCache(CACHE_WMS_DASH_COUNT_KEY, CACHE_WMS_DASH_PREFIX);
    if (!compactData) {
      compactData = generateCompactProdukData();
    }

    return {
      success: true,
      data: compactData,
      count: compactData.length
    };
  } catch (err) {
    return { success: false, message: "Terjadi kesalahan server: " + err.message };
  }
}

function syncWmsDataInventory(token) {
  return getWmsProdukCompact(token, true);
}

/************************************************
 * ENDPOINT LIVE SEARCH & EXPORT (Server-side Filter)
 ************************************************/
function getWmsProdukSearch(token, keyword, areaFilter, limit) {
  const session = getWmsSessionFromToken(token);
  if (!session) return { success: false, message: "Sesi tidak valid, silakan login ulang." };
  
  const canAccess = wmsBisaAksesProduk(session.akses) ||
                    wmsBisaAksesPeminjaman(session.akses) ||
                    wmsBisaAksesFulfillment(session.akses) ||
                    cekHakAksesWms(session.akses, "Stock Opname") ||
                    cekHakAksesWms(session.akses, "Klasifikasi") ||
                    wmsBisaAksesAdmin(session.akses);
  if (!canAccess) return { success: false, message: "Akun kamu tidak punya akses ke data Produk." };

  try {
    const kw = String(keyword || "").trim().toLowerCase();
    const kataKunci = kw.split(/\s+/).filter(Boolean);
    const lokasiFilter = String(areaFilter || "").trim();
    const limitRows = parseInt(limit) || 50;

    let compactData = ambilProdukListDariCache(CACHE_WMS_DASH_COUNT_KEY, CACHE_WMS_DASH_PREFIX);
    if (!compactData) {
      compactData = generateCompactProdukData();
    }

    const filtered = compactData.filter(function (d) {
      if (!d) return false;

      if (lokasiFilter) {
        let adaStokDiArea = false;
        const f = d.f || {};
        if (lokasiFilter === "Warehouse" && f["Gudang Utama"] && f["Gudang Utama"] > 0) adaStokDiArea = true;
        if (lokasiFilter === "Blok F" && ((f["Barang Live"] && f["Barang Live"] > 0) || (f["Sample Studio"] && f["Sample Studio"] > 0))) adaStokDiArea = true;
        if (lokasiFilter === "Perbaikan" && ((f["Permak / Cuci"] && f["Permak / Cuci"] > 0) || (f["Barang Cacat"] && f["Barang Cacat"] > 0))) adaStokDiArea = true;
        if (!adaStokDiArea) return false;
      }

      const teksGabungan = (d.p + ' ' + d.k).toLowerCase();
      return kataKunci.length === 0 || kataKunci.every(function (kwItem) { return teksGabungan.indexOf(kwItem) > -1; });
    });

    const slicedData = (limitRows === -1) ? filtered : filtered.slice(0, limitRows);

    return {
      success: true,
      data: slicedData,
      totalFound: filtered.length
    };

  } catch (err) {
    return { success: false, message: "Terjadi kesalahan server: " + err.message };
  }
}

/************************************************
 * KIRIM EMAIL RANGKUMAN SELISIH STOK
 ************************************************/
function WmsEmailStockDifference() {
  try {
    const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    const shData = getSheetByNameCI_WMS(ss, "Data");
    const shStock = getSheetByNameCI_WMS(ss, "STOCK");

    if (!shData || !shStock) return;

    const dataValues = shData.getDataRange().getValues();
    const headers = dataValues[0];
    const namaIdx = headers.indexOf("Product");
    const sizeIdx = headers.indexOf("Variant");
    const skuIdx  = headers.indexOf("Code");
    const catIdx  = headers.indexOf("Category");

    const headerLocMap = {};
    for (let c = 0; c < headers.length; c++) {
      const head = String(headers[c]).trim();
      if (head.startsWith("Inventory_")) {
        const sub = head.replace("Inventory_", "").toUpperCase();
        if (sub.includes("MARKETPLACE") || sub === "MAP") headerLocMap[c] = "MAP";
        else if (sub.includes("SAMPLE LIVE") || sub === "LIVE") headerLocMap[c] = "LIVE";
        else if (sub.includes("SAMPLE STUDIO") || sub === "STUDIO") headerLocMap[c] = "STD";
        else if (sub.includes("PERMAK") || sub === "GUDANG PERMAK") headerLocMap[c] = "PMK";
        else if (sub.includes("DEFECT") || sub.includes("DEFEK") || sub === "DD") headerLocMap[c] = "DD";
        else if (sub.includes("SHOPEE") || sub === "SHP") headerLocMap[c] = "SHP";
        else if (sub.includes("TOKOPEDIA") || sub === "TPD") headerLocMap[c] = "TPD";
        else if (sub.includes("TIKTOK") || sub === "TTK" || sub === "TT") headerLocMap[c] = "TTK";
        else if (sub === "WH" || sub.includes("WAREHOUSE")) headerLocMap[c] = "WH";
        else if (sub === "QC") headerLocMap[c] = "QC";
        else if (sub === "LND" || sub.includes("LAND")) headerLocMap[c] = "LND";
        else if (sub === "RET" || sub.includes("RETUR")) headerLocMap[c] = "RET";
      }
    }

    const masterData = {};
    for (let i = 1; i < dataValues.length; i++) {
      const row = dataValues[i];
      const sku = skuIdx > -1 ? String(row[skuIdx]).trim().toUpperCase() : "";
      if (!sku) continue;

      const nama = namaIdx > -1 ? String(row[namaIdx]).trim() : "(Nama Tidak Ditemukan)";
      const size = sizeIdx > -1 ? String(row[sizeIdx]).trim() : "-";
      const category = catIdx > -1 ? String(row[catIdx]).trim() : "-";
      const locQtys = { WH: 0, QC: 0, PMK: 0, DD: 0, LND: 0, SHP: 0, TPD: 0, TTK: 0, RET: 0, MAP: 0, LIVE: 0, STD: 0 };

      for (let c = 0; c < headers.length; c++) {
        const qty = Number(row[c]) || 0;
        if (headerLocMap[c]) {
          locQtys[headerLocMap[c]] += qty;
        }
      }

      masterData[sku] = {
        produk: nama,
        size: size,
        sku: sku,
        category: category,
        dealposLocs: locQtys,
        komparasi: {
          "MAP": { fisik: 0, sistemKey: "MAP" },
          "DEFECT": { fisik: 0, sistemKey: "DD" },
          "PERMAK": { fisik: 0, sistemKey: "PMK" },
          "LIVE": { fisik: 0, sistemKey: "LIVE" },
          "STUDIO": { fisik: 0, sistemKey: "STD" }
        }
      };
    }

    const stockValues = shStock.getDataRange().getValues();
    for (let i = 1; i < stockValues.length; i++) {
      const row = stockValues[i];
      const lokasi = String(row[0] || "").trim();
      const area = String(row[1] || "").trim();
      const sku = String(row[2] || "").trim().toUpperCase();
      const qty = Number(row[3]) || 0;

      if (!sku || qty === 0 || !masterData[sku]) continue;

      const a = area.toUpperCase();
      const l = lokasi.toUpperCase();
      let katKey = "";

      if (a === "WAREHOUSE") katKey = "MAP";
      else if (a === "BLOK F" && (l === "SHOPEE" || l === "TIKTOK" || l === "TT")) katKey = "LIVE";
      else if (a === "BLOK F" && l === "STUDIO") katKey = "STUDIO";
      else if (a === "PERBAIKAN" && (l.indexOf("PMK") === 0 || l.indexOf("CC") === 0)) katKey = "PERMAK";
      else if (a === "PERBAIKAN" && l.indexOf("DF") === 0) katKey = "DEFECT";

      if (katKey && masterData[sku].komparasi[katKey]) {
        masterData[sku].komparasi[katKey].fisik += qty;
      }
    }

    const tanggalStr = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd_HHmm");
    const tempSs = SpreadsheetApp.create("WMS_Temp_Excel_" + tanggalStr);

    const categoriesList = [
      { key: "MAP", excludeKey: "MAP" },
      { key: "DEFECT", excludeKey: "DD" },
      { key: "PERMAK", excludeKey: "PMK" },
      { key: "LIVE", excludeKey: "LIVE" },
      { key: "STUDIO", excludeKey: "STD" }
    ];

    const allLocKeys = ["WH", "QC", "PMK", "DD", "LND", "SHP", "TPD", "TTK", "RET", "MAP", "LIVE", "STD"];

    categoriesList.forEach((catObj, index) => {
      const catKey = catObj.key;
      const excludeKey = catObj.excludeKey;
      const activeLocKeys = allLocKeys.filter(k => k !== excludeKey);

      let sheet;
      if (index === 0) {
        sheet = tempSs.getSheets()[0];
        sheet.setName(catKey);
      } else {
        sheet = tempSs.insertSheet(catKey);
      }

      const headerRow = ["Category", "Nama", "Size", "SKU", "Fisik", "Dealpos", "Selisih"].concat(activeLocKeys);
      const rows = [headerRow];

      for (const sku in masterData) {
        const item = masterData[sku];
        const comp = item.komparasi[catKey];
        if (!comp) continue;

        const f = comp.fisik;
        const s = item.dealposLocs[comp.sistemKey] || 0;
        const selisih = f - s;

        if (f > 0 || s > 0 || selisih !== 0) {
          let rowData = [item.category, item.produk, item.size, sku, f, s, selisih];
          activeLocKeys.forEach(k => {
            rowData.push(item.dealposLocs[k] || 0);
          });
          rows.push(rowData);
        }
      }

      if (rows.length > 1) {
        sheet.getRange(1, 1, rows.length, rows[0].length).setValues(rows);
      }
    });

    SpreadsheetApp.flush();

    const fileId = tempSs.getId();
    const url = `https://docs.google.com/spreadsheets/d/${fileId}/export?exportFormat=xlsx&format=xlsx`;
    const options = {
      headers: { "Authorization": "Bearer " + ScriptApp.getOAuthToken() },
      muteHttpExceptions: true
    };

    const response = UrlFetchApp.fetch(url, options);
    if (response.getResponseCode() !== 200) {
      throw new Error("Gagal mengonversi file ke format Excel.");
    }

    const excelBlob = response.getBlob().setName(`Laporan_Selisih_Stok_${tanggalStr}.xlsx`);
    DriveApp.getFileById(fileId).setTrashed(true);

    const recipient = "chocochips.warehouse2@gmail.com";
    const subject = "Rangkuman Selisih Stok WMS vs Dealpos (Excel Multi-Sheet) - " + tanggalStr;
    const body = "Halo Tim Warehouse,\n\nBerikut terlampir 1 file Excel (.xlsx) lengkap berisi beberapa sheet terpisah.\n\nSistem WMS Chocochips";

    MailApp.sendEmail({
      to: recipient,
      subject: subject,
      body: body,
      attachments: [excelBlob]
    });

  } catch (err) {
    console.error("Gagal mengirim email excel selisih stok: " + err.message);
  }
}

/************************************************
 * REFRESH STOK
 ************************************************/
function refreshWmsStockAndData(token) {
  const session = getWmsSessionFromToken(token);
  if (!session) return { success: false, message: "Sesi tidak valid, silakan login ulang." };
  if (!wmsBisaAksesProduk(session.akses)) return { success: false, message: "Akun kamu tidak punya akses ke menu Produk." };

  try {
    if (typeof rebuildStock === 'function') rebuildStock();
    // WmsEmailStockDifference();// -> Email dinonaktifkan sesuai permintaan

    const cache = CacheService.getScriptCache();
    cache.remove(CACHE_WMS_DASH_COUNT_KEY);
    
    generateMasterProdukData();
    
    return { success: true };
  } catch (err) {
    return { success: false, message: "Gagal memperbarui stok: " + err.message };
  }
}

function simpanProdukListKeCache(listData, countKey, prefixKey, ttlDetik) {
  try {
    const cache = CacheService.getScriptCache();
    const jsonStr = JSON.stringify(listData);

    const CHUNK_SIZE = 80000;
    const totalChunks = Math.ceil(jsonStr.length / CHUNK_SIZE);

    const entries = {};
    entries[countKey] = String(totalChunks);
    for (let i = 0; i < totalChunks; i++) {
      entries[prefixKey + i] = jsonStr.substring(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
    }
    cache.putAll(entries, ttlDetik);
  } catch (err) {
    console.warn("Gagal simpan cache: " + err.message);
  }
}

function ambilProdukListDariCache(countKey, prefixKey) {
  try {
    const cache = CacheService.getScriptCache();
    const countStr = cache.get(countKey);
    if (!countStr) return null;

    const totalChunks = Number(countStr);
    const keys = [];
    for (let i = 0; i < totalChunks; i++) {
      keys.push(prefixKey + i);
    }
    const chunks = cache.getAll(keys);
    let jsonStr = "";
    for (let i = 0; i < totalChunks; i++) {
      const chunk = chunks[prefixKey + i];
      if (!chunk) return null;
      jsonStr += chunk;
    }
    return JSON.parse(jsonStr);
  } catch (err) {
    return null;
  }
}

/************************************************
 * RENDER HALAMAN FULFILLMENT
 ************************************************/
function renderFulfillmentPage(session, token) {
  // Penjaga pintu tetap ada (Aman)
  if (!wmsBisaAksesFulfillment(session.akses)) {
    return renderWmsAksesDitolak();
  }

  const template = HtmlService.createTemplateFromFile("FulfillmentPage");
  template.token = token;
  template.username = session.username;
  template.akses = session.akses;
  template.execUrl = ScriptApp.getService().getUrl();

  return template.evaluate()
    .setTitle("Fulfillment - WMS Chocochips")
    .addMetaTag("viewport", "width=device-width, initial-scale=1")
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/************************************************
 * MANAJEMEN USER & PENGATURAN (PAGE SETTING)
 * Khusus untuk role Admin / All
 ************************************************/
function wmsBisaAksesAdmin(akses) {
  if (!akses) return false;
  const roles = String(akses).split(',').map(r => r.trim().toLowerCase());
  return roles.includes("all") || roles.includes("admin") || roles.includes("superadmin");
}

function getWmsUsersList(token) {
  const session = getWmsSessionFromToken(token);
  if (!session) return { success: false, message: "Sesi login tidak valid / kadaluarsa." };
  if (!wmsBisaAksesAdmin(session.akses)) return { success: false, message: "Hanya akun Administrator yang dapat mengelola pengguna." };

  const res = supabaseFetch("wms_users", "get", null, "select=*", true);
  if (res.success && res.data) {
    const users = res.data.map(function(u, idx) {
      return {
        row: idx + 2,
        username: u.username,
        password: u.password,
        role: u.role || u.akses || "All"
      };
    });
    return { success: true, users: users, currentUser: session.username };
  }

  // Fallback
  return {
    success: true,
    users: [
      { row: 2, username: "admin", password: "123", role: "All" },
      { row: 3, username: "warehouse", password: "123", role: "All" }
    ],
    currentUser: session.username
  };
}

function saveWmsUser(token, userData) {
  const session = getWmsSessionFromToken(token);
  if (!session) return { success: false, message: "Sesi login tidak valid / kadaluarsa." };
  if (!wmsBisaAksesAdmin(session.akses)) return { success: false, message: "Hanya akun Administrator yang dapat mengelola pengguna." };

  if (!userData || !userData.username || !String(userData.username).trim()) {
    return { success: false, message: "Username wajib diisi." };
  }
  if (!userData.password || !String(userData.password).trim()) {
    return { success: false, message: "Password wajib diisi." };
  }

  const usernameBaru = String(userData.username).trim();
  const passwordBaru = String(userData.password).trim();
  const roleBaru = String(userData.role || "All").trim();
  const isEdit = Boolean(userData.isEdit);
  const oldUsername = String(userData.oldUsername || "").trim().toLowerCase();

  // Jika edit dan username berubah, hapus yang lama dulu
  if (isEdit && oldUsername && oldUsername !== usernameBaru.toLowerCase()) {
    const delRes = supabaseFetch("wms_users", "delete", null, `username=eq.${encodeURIComponent(oldUsername)}`, true);
    if (!delRes.success) return { success: false, message: "Gagal update (hapus username lama)." };
  } else if (!isEdit) {
    const checkRes = supabaseFetch("wms_users", "get", null, `select=username&username=eq.${encodeURIComponent(usernameBaru)}`, true);
    if (checkRes.success && checkRes.data && checkRes.data.length > 0) {
      return { success: false, message: `Username "${usernameBaru}" sudah terdaftar.` };
    }
  }

  // Hash password dengan SHA-256 jika belum berformat hex hash 64 char
  const finalPassword = (passwordBaru.length === 64 && /^[0-9a-fA-F]+$/.test(passwordBaru))
    ? passwordBaru.toLowerCase()
    : hashSha256Hex(passwordBaru);

  const payload = [{ 
    username: usernameBaru, 
    password: finalPassword, 
    role: roleBaru,
    updated_at: new Date().toISOString()
  }];
  const res = supabaseFetch("wms_users", "post", payload, "on_conflict=username", true);

  if (res.success) {
    invalidateWmsUsersCache();
    return { success: true, message: `User "${usernameBaru}" berhasil ${isEdit ? 'diperbarui' : 'ditambahkan'}!` };
  } else {
    return { success: false, message: "Gagal menyimpan user ke database Supabase: " + (res.message || "") };
  }
}

function deleteWmsUser(token, targetUsername) {
  const session = getWmsSessionFromToken(token);
  if (!session) return { success: false, message: "Sesi login tidak valid / kadaluarsa." };
  if (!wmsBisaAksesAdmin(session.akses)) return { success: false, message: "Hanya akun Administrator yang dapat mengelola pengguna." };

  const target = String(targetUsername || "").trim();
  if (!target) return { success: false, message: "Target username kosong." };

  if (target.toLowerCase() === String(session.username).toLowerCase()) {
    return { success: false, message: "Anda tidak dapat menghapus akun Anda sendiri yang sedang aktif." };
  }

  const res = supabaseFetch("wms_users", "delete", null, `username=eq.${encodeURIComponent(target)}`, true);
  if (res.success) {
    invalidateWmsUsersCache();
    return { success: true, message: `User "${target}" berhasil dihapus.` };
  }

  return { success: false, message: `Gagal menghapus user "${target}".` };
}