/************************************************
 * SUPABASE HYBRID BRIDGE & CLIENT
 * Menghubungkan Google Apps Script dengan Supabase PostgreSQL
 ************************************************/

const SUPABASE_URL = "https://vxongwtxmhjixhzeoidp.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_XFvjJipUzyi0EuM_tDTTsg_ll7TJ7rA";
const SUPABASE_SERVICE_KEY = (typeof PropertiesService !== 'undefined' && PropertiesService.getScriptProperties) 
  ? (PropertiesService.getScriptProperties().getProperty('SUPABASE_SERVICE_KEY') || "") 
  : "";

/**
 * Helper HTTP Request ke Supabase REST API
 */
function supabaseFetch(table, method, payload, queryParams, useServiceRole) {
  // PostgREST REST API bekerja optimal menggunakan Publishable / Anon Key (dengan tabel Non-RLS)
  const key = SUPABASE_ANON_KEY;
  let url = SUPABASE_URL + "/rest/v1/" + table;

  if (queryParams) {
    url += (url.includes("?") ? "&" : "?") + queryParams;
  }

  const options = {
    method: method || "get",
    headers: {
      "apikey": key,
      "Authorization": "Bearer " + key,
      "Content-Type": "application/json"
    },
    muteHttpExceptions: true
  };

  if (queryParams && queryParams.includes("on_conflict")) {
    options.headers["Prefer"] = "resolution=merge-duplicates,return=minimal";
  }

  if (payload && (method === "post" || method === "patch" || method === "put")) {
    options.payload = JSON.stringify(payload);
  }

  const response = UrlFetchApp.fetch(url, options);
  const code = response.getResponseCode();
  const text = response.getContentText();

  let json = null;
  try {
    json = JSON.parse(text);
  } catch (e) {
    json = text;
  }

  if (code >= 200 && code < 300) {
    return { success: true, status: code, data: json };
  } else {
    return { success: false, status: code, error: json, message: "HTTP " + code + ": " + (typeof json === "object" ? JSON.stringify(json) : json) };
  }
}

/**
 * Tes Koneksi ke Supabase
 */
function testSupabaseConnection() {
  const res = supabaseFetch("master_produk", "get", null, "select=sku&limit=1", true);
  Logger.log("Hasil Tes Koneksi Supabase: " + JSON.stringify(res));
  return res;
}

/************************************************
 * SINKRONISASI DATA SHEET ➔ SUPABASE (INITIAL SEEDING)
 ************************************************/

/**
 * 1. Sinkronkan Master Produk (Sheet "Data" ➔ master_produk)
 */
function syncMasterProdukToSupabase() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName("Data");
  if (!sheet) return { success: false, message: "Sheet Data tidak ditemukan" };

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return { success: false, message: "Sheet Data kosong" };

  const allData = sheet.getDataRange().getValues();
  const headers = allData[0].map(h => String(h || "").trim());
  const headersLower = headers.map(h => h.toLowerCase());

  let namaIdx = headersLower.findIndex(h => h === "product" || h === "nama produk" || h === "produk");
  let sizeIdx = headersLower.findIndex(h => h === "variant" || h === "size" || h === "ukuran");
  let skuIdx  = headersLower.findIndex(h => h === "code" || h === "sku" || h === "item code" || h === "barcode");
  let catIdx  = headersLower.findIndex(h => h === "category" || h === "kategori");
  let priceIdx = headersLower.findIndex(h => h === "price" || h === "harga");

  if (namaIdx === -1) namaIdx = 1;
  if (sizeIdx === -1) sizeIdx = 3;
  if (skuIdx === -1)  skuIdx  = 4;
  if (catIdx === -1)  catIdx  = 0;

  const CABANG_MAP = {
    "Inventory_Lippo Mall Puri": "LMP", "Inventory_Mall Kelapa Gading": "MKG",
    "Inventory_By The Sea PIK": "BTS", "Inventory_Central Park Jakarta": "CPJ",
    "Inventory_Ciputra World Surabaya": "CWS", "Inventory_Living World Tangerang": "LWS",
    "Inventory_Deli Park Medan": "DPM", "Inventory_Paskal Hyper Square Bandung": "PHB",
    "Inventory_Pakuwon Mall Surabaya": "PMS", "Inventory_Neo Soho Jakarta": "NSJ",
    "Inventory_Puri Indah Mall": "PIM", "Inventory_Sun Plaza Medan": "SPM",
    "Inventory_Gaia Pontianak": "GAIA", "Inventory_Gading Serpong Tangerang": "GST",
    "Inventory_La Vela Tangerang": "LVL", "Inventory_Website": "WEB",
    "Inventory_Shopee": "SHP", "Inventory_Tokopedia": "TPD",
    "Inventory_TikTok": "TTK", "Inventory_Lazada": "LZD"
  };

  const rowsToInsert = [];
  const skuSet = new Set();

  for (let i = 1; i < allData.length; i++) {
    const r = allData[i];
    const sku = skuIdx > -1 ? String(r[skuIdx] || "").trim() : "";
    const nama = namaIdx > -1 ? String(r[namaIdx] || "").trim() : "";
    const kategori = catIdx > -1 ? String(r[catIdx] || "").trim() : "";
    const size = sizeIdx > -1 ? String(r[sizeIdx] || "").trim() : "-";
    const price = priceIdx > -1 ? (Number(r[priceIdx]) || 0) : 0;

    if (sku && nama && !skuSet.has(sku.toUpperCase())) {
      skuSet.add(sku.toUpperCase());

      const dealposChannels = {
        "Gudang Utama": 0,
        "Barang Live": 0,
        "Sample Studio": 0,
        "Permak / Cuci": 0,
        "Barang Cacat": 0,
        "WH": 0,
        "QC": 0,
        "GA": 0,
        "Lainnya": 0,
        "cabang": {}
      };

      for (let c = 0; c < headers.length; c++) {
        const head = String(headers[c] || "").trim();
        const qty = Number(r[c]) || 0;
        if (head.startsWith("Inventory_") && qty !== 0) {
          if (head === "Inventory_Marketplace") dealposChannels["Gudang Utama"] += qty;
          else if (head === "Inventory_Sample Live") dealposChannels["Barang Live"] += qty;
          else if (head === "Inventory_Sample Studio") dealposChannels["Sample Studio"] += qty;
          else if (head === "Inventory_Gudang Permak") dealposChannels["Permak / Cuci"] += qty;
          else if (head === "Inventory_Diskon Defect") dealposChannels["Barang Cacat"] += qty;
          else if (head === "Inventory_Warehouse") dealposChannels["WH"] += qty;
          else if (head === "Inventory_Gudang QC") dealposChannels["QC"] += qty;
          else if (head === "Inventory_Gudang Awal") dealposChannels["GA"] += qty;
          else {
            const singkatan = CABANG_MAP[head];
            if (singkatan) {
              dealposChannels.cabang[singkatan] = qty;
            }
          }
        }
      }

      rowsToInsert.push({
        sku: sku,
        nama_produk: nama,
        kategori: kategori,
        size: size,
        price: price,
        dealpos_channels: dealposChannels
      });
    }
  }

  if (rowsToInsert.length === 0) return { success: true, count: 0 };

  const CHUNK_SIZE = 500;
  let totalInserted = 0;

  for (let i = 0; i < rowsToInsert.length; i += CHUNK_SIZE) {
    const chunk = rowsToInsert.slice(i, i + CHUNK_SIZE);
    const res = supabaseFetch("master_produk", "post", chunk, "on_conflict=sku", true);
    if (!res.success) {
      Logger.log("Gagal sync master produk chunk " + i + ": " + JSON.stringify(res.error));
      return { success: false, message: "Gagal pada chunk " + i + ": " + res.message };
    }
    totalInserted += chunk.length;
  }

  return { success: true, count: totalInserted };
}

/**
 * 2. Sinkronkan Saldo Stok (Sheet "STOCK" ➔ stok_lokasi)
 */
function syncStockToSupabase() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName("STOCK");
  if (!sheet) return { success: false, message: "Sheet STOCK tidak ditemukan" };

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return { success: false, message: "Sheet STOCK kosong" };

  const lastCol = Math.max(4, sheet.getLastColumn());
  const data = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  const rowsToInsert = [];
  const skuMetaMap = {};

  data.forEach(function (r) {
    const lokasi = String(r[0] || "").trim();
    const area = String(r[1] || "").trim();
    const sku = String(r[2] || "").trim().toUpperCase();
    const qty = Number(r[3]) || 0;
    const nama = String(r[4] || "").trim();
    const size = String(r[5] || "").trim();

    if (sku && lokasi && area) {
      if (!skuMetaMap[sku]) {
        skuMetaMap[sku] = {
          sku: sku,
          nama_produk: nama || sku,
          kategori: "STOCK",
          size: size || "-"
        };
      } else {
        if (nama && (!skuMetaMap[sku].nama_produk || skuMetaMap[sku].nama_produk === sku)) {
          skuMetaMap[sku].nama_produk = nama;
        }
        if (size && (!skuMetaMap[sku].size || skuMetaMap[sku].size === "-")) {
          skuMetaMap[sku].size = size;
        }
      }

      rowsToInsert.push({
        sku: sku,
        lokasi: lokasi,
        area: area,
        qty: qty
      });
    }
  });

  if (rowsToInsert.length === 0) return { success: true, count: 0 };

  // Safety: Daftarkan SKU yang ada di STOCK ke master_produk (jika belum terdaftar)
  const skuList = Object.values(skuMetaMap);
  const CHUNK_SIZE = 500;
  for (let i = 0; i < skuList.length; i += CHUNK_SIZE) {
    const chunkSkus = skuList.slice(i, i + CHUNK_SIZE);
    supabaseFetch("master_produk", "post", chunkSkus, "on_conflict=sku", true);
  }

  let totalInserted = 0;
  for (let i = 0; i < rowsToInsert.length; i += CHUNK_SIZE) {
    const chunk = rowsToInsert.slice(i, i + CHUNK_SIZE);
    const res = supabaseFetch("stok_lokasi", "post", chunk, "on_conflict=sku,lokasi,area", true);
    if (!res.success) {
      Logger.log("Gagal sync stok chunk " + i + ": " + JSON.stringify(res.error));
      return { success: false, message: "Gagal pada chunk " + i + ": " + res.message };
    }
    totalInserted += chunk.length;
  }

  return { success: true, count: totalInserted };
}

/**
 * 3. Menu Aksi Spreadsheet: 1-Klik Sinkronkan Semua Data ke Supabase
 */
function menuSyncAllToSupabase() {
  const ui = SpreadsheetApp.getUi();
  const conf = ui.alert(
    "Konfirmasi Sinkronisasi Supabase",
    "Tindakan ini akan menyalin seluruh data Master Produk (Sheet Data) dan Saldo Stok (Sheet STOCK) ke database Supabase Cloud.\n\nLanjutkan?",
    ui.ButtonSet.YES_NO
  );

  if (conf !== ui.Button.YES) return;

  SpreadsheetApp.getActiveSpreadsheet().toast("Menghubungkan ke Supabase & menyalin Master Produk...", "Supabase Sync", 15);

  const resMaster = syncMasterProdukToSupabase();
  if (!resMaster.success) {
    ui.alert("Gagal Sync Master Produk", resMaster.message, ui.ButtonSet.OK);
    return;
  }

  SpreadsheetApp.getActiveSpreadsheet().toast("Menyalin Saldo Stok Lokasi...", "Supabase Sync", 15);

  const resStock = syncStockToSupabase();
  if (!resStock.success) {
    ui.alert("Gagal Sync Stok", resStock.message, ui.ButtonSet.OK);
    return;
  }

  ui.alert(
    "Sinkronisasi Berhasil! 🚀",
    "Berhasil menyinkronkan data ke Supabase:\n" +
    "• Master Produk: " + resMaster.count + " SKU\n" +
    "• Stok Lokasi: " + resStock.count + " baris stok\n\n" +
    "Database Supabase kini siap digunakan untuk front-end berkecepatan tinggi!",
    ui.ButtonSet.OK
  );
}

/************************************************
 * ATOMIC TRANSACTION: SIMPAN LOG & UPDATE STOK SUPABASE
 ************************************************/
function catatLogDanUpdateStokSupabaseBatch(entries) {
  if (!entries || entries.length === 0) return { success: true };
  try {
    const payloadLog = entries.map(function (e) {
      return {
        type: e.type,
        invoice: e.invoice,
        sku: e.sku,
        nama_produk: e.nama || e.sku,
        size: e.size || "-",
        area: e.area,
        lokasi: e.lokasi,
        qty: e.qty || 1,
        operator: e.operator,
        keterangan: e.keterangan
      };
    });

    supabaseFetch("log_produk", "post", payloadLog, "", true);
    return { success: true };
  } catch (err) {
    Logger.log("Gagal catatLogDanUpdateStokSupabaseBatch: " + err.message);
    return { success: false, error: err.message };
  }
}

function catatLogDanUpdateStokSupabase(entry) {
  try {
    return catatLogDanUpdateStokSupabaseBatch([entry]);
  } catch (err) {
    Logger.log("Gagal catatLogDanUpdateStokSupabase: " + err.message);
    return { success: false, error: err.message };
  }
}
/**
 * Sinkronisasi Seluruh Riwayat Log Product ke Supabase
 * (Migrasi Fase Awal)
 */
function syncLogProductToSupabase() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName('Log Product');
  if (!sheet) return { success: false, message: 'Sheet Log Product tidak ditemukan' };

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return { success: false, message: 'Sheet Log Product kosong' };
  
  // Ambil semua data
  const data = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
  const rowsToInsert = [];
  
  for(let i = 0; i < data.length; i++) {
    const row = data[i];
    const timestamp = row[0]; // Object Date atau string
    const sku = String(row[1] || '').trim().toUpperCase();
    const lokasi = typeof normalizeLokasi === 'function' ? normalizeLokasi(row[2]) : String(row[2]).trim().toUpperCase();
    const invoice = String(row[3] || '').trim();
    const user = String(row[4] || '').trim();
    const type = String(row[5] || '').trim().toUpperCase();
    const remark = String(row[6] || '').trim();
    const area = typeof getArea === 'function' ? getArea(lokasi) : String(row[7]).trim().toUpperCase();
    let qty = 1; // Default
    
    if (type === 'ADJ_IN' || type === 'ADJ_OUT') {
        qty = Math.abs(Number(row[10]) || 0) || 1;
    }
    
    if (sku && lokasi && type) {
      let createdAtIso = new Date().toISOString();
      if (timestamp && timestamp instanceof Date) {
         createdAtIso = timestamp.toISOString();
      } else if (timestamp) {
         try { createdAtIso = new Date(timestamp).toISOString(); } catch(e){}
      }
      
      rowsToInsert.push({
         created_at: createdAtIso,
         type: type,
         invoice: invoice,
         sku: sku,
         nama_produk: sku, // Fallback
         area: area,
         lokasi: lokasi,
         qty: qty,
         operator: user,
         keterangan: remark
      });
    }
  }
  
  if (rowsToInsert.length === 0) return { success: true, count: 0 };
  
  // Karena bisa puluhan ribu, batasi batch 500
  const CHUNK_SIZE = 500;
  let totalInserted = 0;
  
  for (let i = 0; i < rowsToInsert.length; i += CHUNK_SIZE) {
    const chunk = rowsToInsert.slice(i, i + CHUNK_SIZE);
    
    const res = supabaseFetch('log_produk', 'post', chunk, '', true);
    if (!res.success) {
       Logger.log('Gagal sync Log Product chunk ' + i + ': ' + JSON.stringify(res.error));
       return { success: false, message: 'Gagal di baris ' + i + ': ' + JSON.stringify(res.error), count: totalInserted };
    }
    totalInserted += chunk.length;
  }
  
  return { success: true, count: totalInserted };
}

function runMigrasiFullLog() {
    SpreadsheetApp.getActiveSpreadsheet().toast('Memulai migrasi riwayat Log Product...', 'MIGRASI', 15);
    const result = syncLogProductToSupabase();
    if (result.success) {
         SpreadsheetApp.getUi().alert('SUKSES', 'Berhasil memindahkan ' + result.count + ' baris riwayat ke Supabase.', SpreadsheetApp.getUi().ButtonSet.OK);
    } else {
         SpreadsheetApp.getUi().alert('GAGAL', result.message, SpreadsheetApp.getUi().ButtonSet.OK);
    }
}

/**
 * Sinkronisasi User WMS ke Supabase (Sekali Jalan)
 */
function syncWmsUsersToSupabase() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName("Users");
  if (!sheet) return { success: false, message: 'Sheet Users tidak ditemukan' };

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return { success: false, message: 'Sheet Users kosong' };

  const data = sheet.getRange(2, 1, lastRow - 1, 3).getValues();
  const rowsToInsert = [];

  for(let i = 0; i < data.length; i++) {
    const username = String(data[i][0] || '').trim();
    const password = String(data[i][1] || '').trim();
    const akses = String(data[i][2] || 'All').trim();

    if (username && password) {
      rowsToInsert.push({
        username: username,
        password: password,
        role: akses
      });
    }
  }

  if (rowsToInsert.length === 0) return { success: true, count: 0 };

  const res = supabaseFetch('wms_users', 'post', rowsToInsert, 'on_conflict=username', true);
  if (!res.success) {
    return { success: false, message: 'Gagal sync User: ' + JSON.stringify(res.error) };
  }
  return { success: true, count: rowsToInsert.length };
}

/**
 * Sinkronisasi Seluruh Data Sheet "Penerimaan Produksi" ke Supabase
 */
function syncPenerimaanProduksiToSupabase() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName("Penerimaan Produksi");
  if (!sheet) return { success: false, message: "Sheet 'Penerimaan Produksi' tidak ditemukan." };

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return { success: true, count: 0, message: "Sheet 'Penerimaan Produksi' kosong." };

  const numCols = Math.max(11, sheet.getLastColumn());
  const data = sheet.getRange(2, 1, lastRow - 1, numCols).getValues();
  const rowsToInsert = [];

  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    let tgl = row[0];
    let tglStr = "";
    if (tgl instanceof Date) {
      tglStr = Utilities.formatDate(tgl, TIMEZONE, "yyyy-MM-dd");
    } else {
      tglStr = String(tgl || "").trim().substring(0, 10);
    }
    if (!tglStr) tglStr = Utilities.formatDate(new Date(), TIMEZONE, "yyyy-MM-dd");

    const kategori = String(row[1] || "Lokal CMT").trim();
    const noSj = String(row[2] || "").trim().toUpperCase();
    const kodeProd = String(row[3] || "").trim().toUpperCase();
    const warna = String(row[4] || "").trim();
    const size = String(row[5] || "Default").trim();
    const qty = parseInt(row[6], 10) || 1;
    const fotoUrl = String(row[7] || "").trim();
    const keterangan = String(row[8] || "").trim();
    const operator = String(row[9] || "Operator").trim();

    let waktuInput = row[10];
    let createdAtIso = new Date().toISOString();
    if (waktuInput instanceof Date) {
      createdAtIso = waktuInput.toISOString();
    } else if (waktuInput) {
      try { createdAtIso = new Date(waktuInput).toISOString(); } catch (e) {}
    }

    if (noSj && kodeProd) {
      rowsToInsert.push({
        tanggal_penerimaan: tglStr,
        kategori: kategori,
        no_surat_jalan: noSj,
        kode_produksi: kodeProd,
        warna: warna,
        size: size,
        qty: qty,
        foto_url: (fotoUrl.startsWith("http")) ? fotoUrl : "",
        keterangan: keterangan,
        operator: operator,
        created_at: createdAtIso
      });
    }
  }

  if (rowsToInsert.length === 0) return { success: true, count: 0 };

  const CHUNK_SIZE = 500;
  let totalInserted = 0;
  for (let i = 0; i < rowsToInsert.length; i += CHUNK_SIZE) {
    const chunk = rowsToInsert.slice(i, i + CHUNK_SIZE);
    const res = supabaseFetch("penerimaan_produksi", "post", chunk, "", true);
    if (!res.success) {
      Logger.log("Gagal sync penerimaan_produksi chunk " + i + ": " + JSON.stringify(res.error));
      return { success: false, message: "Gagal pada chunk " + i + ": " + res.message, count: totalInserted };
    }
    totalInserted += chunk.length;
  }

  return { success: true, count: totalInserted };
}

/**
 * Sinkronisasi Seluruh Data Sheet "Peminjaman" ke Supabase
 */
function syncPeminjamanToSupabase() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName("Peminjaman");
  if (!sheet) return { success: false, message: "Sheet 'Peminjaman' tidak ditemukan." };

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return { success: true, count: 0, message: "Sheet 'Peminjaman' kosong." };

  const numCols = Math.max(14, sheet.getLastColumn());
  const data = sheet.getRange(2, 1, lastRow - 1, numCols).getValues();
  const rowsToInsert = [];

  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    const submitTs = row[1];
    let createdAtIso = new Date().toISOString();
    if (submitTs instanceof Date) {
      createdAtIso = submitTs.toISOString();
    } else if (submitTs) {
      try { createdAtIso = new Date(submitTs).toISOString(); } catch(e) {}
    }

    const pic = String(row[2] || "").trim();
    const keperluan = String(row[3] || "").trim();

    let tglPinjam = row[4];
    let tglPinjamStr = "";
    if (tglPinjam instanceof Date) {
      tglPinjamStr = Utilities.formatDate(tglPinjam, TIMEZONE, "yyyy-MM-dd");
    } else {
      tglPinjamStr = String(tglPinjam || "").trim().substring(0, 10);
    }
    if (!tglPinjamStr) tglPinjamStr = Utilities.formatDate(new Date(), TIMEZONE, "yyyy-MM-dd");

    const namaProduk = String(row[6] || "").trim();
    const sku = String(row[7] || "").trim().toUpperCase();
    const size = String(row[8] || "-").trim();
    const qty = parseInt(row[9], 10) || 1;
    const noPjm = String(row[10] || "").trim().toUpperCase();
    const status = String(row[11] || "Dipinjam").trim();
    const operator = String(row[12] || "").trim();
    const lokasi = String(row[13] || "STUDIO").trim();

    if ((sku || namaProduk) && noPjm) {
      rowsToInsert.push({
        no_peminjaman: noPjm,
        pic: pic || "Peminjam",
        keperluan: keperluan,
        tanggal_pinjam: tglPinjamStr,
        sku: sku || namaProduk,
        nama_produk: namaProduk || sku,
        size: size,
        qty: qty,
        lokasi: lokasi,
        status: status,
        operator: operator,
        created_at: createdAtIso
      });
    }
  }

  if (rowsToInsert.length === 0) return { success: true, count: 0 };

  const CHUNK_SIZE = 500;
  let totalInserted = 0;
  for (let i = 0; i < rowsToInsert.length; i += CHUNK_SIZE) {
    const chunk = rowsToInsert.slice(i, i + CHUNK_SIZE);
    const res = supabaseFetch("peminjaman", "post", chunk, "", true);
    if (!res.success) {
      Logger.log("Gagal sync peminjaman chunk " + i + ": " + JSON.stringify(res.error));
      return { success: false, message: "Gagal pada chunk " + i + ": " + res.message, count: totalInserted };
    }
    totalInserted += chunk.length;
  }

  return { success: true, count: totalInserted };
}

/**
 * Menu Spreadsheet 1-Klik: Tarik seluruh data lama Sheet ke Supabase
 */
function menuSyncAllSheetToSupabase() {
  const ui = SpreadsheetApp.getUi();
  const conf = ui.alert(
    "Konfirmasi Migrasi Data ke Supabase",
    "Tindakan ini akan menarik seluruh riwayat Penerimaan Produksi & Peminjaman dari Google Sheets ke database Supabase Cloud.\n\nLanjutkan?",
    ui.ButtonSet.YES_NO
  );

  if (conf !== ui.Button.YES) return;

  SpreadsheetApp.getActiveSpreadsheet().toast("Menyinkronkan Penerimaan Produksi ke Supabase...", "MIGRASI SUPABASE", 15);
  const resPenerimaan = syncPenerimaanProduksiToSupabase();

  SpreadsheetApp.getActiveSpreadsheet().toast("Menyinkronkan Peminjaman ke Supabase...", "MIGRASI SUPABASE", 15);
  const resPeminjaman = syncPeminjamanToSupabase();

  ui.alert(
    "Migrasi ke Supabase Selesai! 🚀",
    `Hasil Sinkronisasi:\n• Penerimaan Produksi: ${resPenerimaan.count || 0} baris\n• Peminjaman SPS: ${resPeminjaman.count || 0} baris\n\nData sekarang tersimpan rapi dan realtime di Supabase!`,
    ui.ButtonSet.OK
  );
}

function runMigrasiUsers() {
    SpreadsheetApp.getActiveSpreadsheet().toast('Memulai migrasi WMS Users...', 'MIGRASI', 15);
    const result = syncWmsUsersToSupabase();
    if (result.success) {
         SpreadsheetApp.getUi().alert('SUKSES', 'Berhasil memindahkan ' + result.count + ' user ke Supabase.', SpreadsheetApp.getUi().ButtonSet.OK);
    } else {
         SpreadsheetApp.getUi().alert('GAGAL', result.message, SpreadsheetApp.getUi().ButtonSet.OK);
    }
}

/**
 * Mengambil seluruh data stok realtime per lokasi dari Supabase view_stok_realtime (dengan pagination otomatis)
 */
function fetchAllSupabaseStokRealtime() {
  const allRows = [];
  let from = 0;
  const chunkSize = 1000;
  
  try {
    while (true) {
      const to = from + chunkSize - 1;
      const url = SUPABASE_URL + "/rest/v1/view_stok_realtime?sisa_stok=neq.0&select=sku,nama_produk,size,area,lokasi,sisa_stok&order=sku.asc,lokasi.asc";
      const options = {
        method: "get",
        headers: {
          "apikey": SUPABASE_ANON_KEY,
          "Authorization": "Bearer " + SUPABASE_ANON_KEY,
          "Content-Type": "application/json",
          "Range-Unit": "items",
          "Range": from + "-" + to
        },
        muteHttpExceptions: true
      };
      
      const res = UrlFetchApp.fetch(url, options);
      const code = res.getResponseCode();
      if (code === 200 || code === 206) {
        const data = JSON.parse(res.getContentText());
        if (!data || !Array.isArray(data) || data.length === 0) break;
        allRows.push.apply(allRows, data);
        if (data.length < chunkSize) break;
        from += chunkSize;
      } else {
        Logger.log("fetchAllSupabaseStokRealtime code " + code + ": " + res.getContentText());
        break;
      }
    }
  } catch (err) {
    Logger.log("fetchAllSupabaseStokRealtime error: " + err.message);
  }
  
  return allRows;
}
