/************************************************
 * FILE STOCK OPNAME & ADJUSTMENT.GS
 *
 * Alur singkat:
 * 1. OPNAME: user (web ATAU WA) input hasil hitung fisik
 *    per SKU+Lokasi. Sistem bandingkan dengan qty di sheet
 *    STOCK. Kalau beda (selisih != 0), dibuat baris PENDING
 *    di sheet "Stock Opname" -- BELUM mengubah stok apapun.
 * 2. Setelah 1 sesi opname selesai disubmit, sistem kirim
 *    email rekap (CSV) berisi semua selisih ke
 *    EMAIL_REKAP_ADJUSTMENT.
 * 3. ADJUSTMENT MANUAL: user input SKU+Lokasi+qty(+/-)+alasan
 *    -- bisa 1 per 1 (bulk dengan 1 item) ATAU banyak sekaligus
 *    (bulk beneran / hasil import CSV) -- juga masuk ke
 *    antrian Pending yang sama.
 * 4. APPROVAL: admin (akses "All") buka halaman web, lihat
 *    semua baris Pending, klik Approve/Reject. Approve akan
 *    menulis baris ADJ_IN/ADJ_OUT ke sheet Log Product
 *    (dengan qty eksplisit di kolom K) lalu rebuildStock()
 *    dipanggil supaya sheet STOCK ikut ter-update.
 *
 * REVISI (SeqID): baris ADJ_IN/ADJ_OUT yang ditulis ke Log
 * Product saat approval sekarang JUGA diisi kolom L (SeqID) --
 * lihat prosesSatuChunkApproval_() di bagian bawah file ini.
 * Semua logika alur opname/adjustment/approval lainnya TIDAK
 * berubah.
 *
 * SHEET BARU YANG HARUS DIBUAT MANUAL: "Stock Opname"
 * Kolom (A-Q):
 *  A SesiID        B Tanggal        C SKU
 *  D NamaProduk    E Size           F Lokasi
 *  G Area          H QtySistem      I QtyFisik
 *  J Selisih       K Status         L Jenis (Opname/Manual)
 *  M Alasan        N Operator       O Invoice
 *  P TanggalApprove Q ApprovedBy
 ************************************************/

/************************************************
 * HAK AKSES: sama kayak Update Database, cuma "All"
 * (karena fitur ini bisa mengubah angka stok beneran)
 ************************************************/
function wmsBisaAksesStockOpname(akses) {
  if (!akses) return false;
  const roles = String(akses).split(',').map(function(r) { return r.trim().toLowerCase(); });
  return roles.includes("all") || roles.includes("superadmin") || roles.includes("stock opname");
}

/************************************************
 * RENDER HALAMAN
 ************************************************/
function renderWmsStockOpnamePage(session, token) {
  const template = HtmlService.createTemplateFromFile("WmsStockOpnameView");
  template.token = token;
  template.username = session.username;
  template.akses = session.akses;
  template.execUrl = ScriptApp.getService().getUrl();

  return template.evaluate()
    .setTitle("Stock Opname & Adjustment - WMS Chocochips")
    .addMetaTag("viewport", "width=device-width, initial-scale=1")
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/************************************************
 * HELPER: cari qty sistem saat ini utk 1 SKU+Lokasi dari Supabase view_stok_realtime
 ************************************************/
function getQtySistemSkuLokasi(sku, lokasi) {
  sku = String(sku || "").trim().toUpperCase();
  lokasi = normalizeLokasi(lokasi);
  try {
    const url = SUPABASE_URL + "/rest/v1/view_stok_realtime?sku=eq." + encodeURIComponent(sku) + "&lokasi=eq." + encodeURIComponent(lokasi) + "&select=sisa_stok";
    const options = {
      method: "get",
      headers: { "apikey": SUPABASE_ANON_KEY, "Authorization": "Bearer " + SUPABASE_ANON_KEY },
      muteHttpExceptions: true
    };
    const res = UrlFetchApp.fetch(url, options);
    if (res.getResponseCode() === 200) {
      const data = JSON.parse(res.getContentText());
      if (data.length > 0) return Number(data[0].sisa_stok) || 0;
    }
  } catch(e) {}
  return 0;
}

/************************************************
 * HELPER: cari Nama Produk & Size dari Supabase master_produk
 ************************************************/
function getNamaSizeDariSku(sku) {
  sku = String(sku || "").trim().toUpperCase();
  try {
    const url = SUPABASE_URL + "/rest/v1/master_produk?sku=eq." + encodeURIComponent(sku) + "&select=produk,size";
    const options = {
      method: "get",
      headers: { "apikey": SUPABASE_ANON_KEY, "Authorization": "Bearer " + SUPABASE_ANON_KEY },
      muteHttpExceptions: true
    };
    const res = UrlFetchApp.fetch(url, options);
    if (res.getResponseCode() === 200) {
      const data = JSON.parse(res.getContentText());
      if (data.length > 0) {
        return { nama: String(data[0].produk || "").trim(), size: String(data[0].size || "").trim() };
      }
    }
  } catch(e) {}
  return { nama: "", size: "" };
}

/************************************************
 * DATA AWAL HALAMAN: daftar lokasi & produk utk autocomplete
 ************************************************/
function getWmsStockOpnameInitData(token) {
  try {
    const session = getWmsSessionFromToken(token);
    if (!session) return { success: false, message: "Sesi tidak valid, silakan login ulang." };
    if (!wmsBisaAksesStockOpname(session.akses)) return { success: false, message: "Akun kamu tidak punya akses ke fitur ini." };

    const cache = CacheService.getScriptCache();
    const cachedStr = cache.get("WMS_STOCK_OPNAME_INIT_SUPA_V1");
    if (cachedStr) {
      try {
        const parsed = JSON.parse(cachedStr);
        return { success: true, produkList: parsed.produkList, lokasiList: parsed.lokasiList };
      } catch (e) {}
    }

    // Ambil data produk & lokasi dari Supabase
    let produkList = [];
    let lokasiList = [];

    try {
      const urlProd = SUPABASE_URL + "/rest/v1/master_produk?select=sku,produk,size";
      const resProd = UrlFetchApp.fetch(urlProd, {
        headers: { "apikey": SUPABASE_ANON_KEY, "Authorization": "Bearer " + SUPABASE_ANON_KEY },
        muteHttpExceptions: true
      });
      if (resProd.getResponseCode() === 200) {
        produkList = JSON.parse(resProd.getContentText());
      }
    } catch(e) {}

    try {
      const urlLok = SUPABASE_URL + "/rest/v1/view_stok_realtime?select=lokasi";
      const resLok = UrlFetchApp.fetch(urlLok, {
        headers: { "apikey": SUPABASE_ANON_KEY, "Authorization": "Bearer " + SUPABASE_ANON_KEY },
        muteHttpExceptions: true
      });
      if (resLok.getResponseCode() === 200) {
        const rawLok = JSON.parse(resLok.getContentText());
        const lokSet = {};
        rawLok.forEach(r => { if (r.lokasi) lokSet[r.lokasi] = true; });
        lokasiList = Object.keys(lokSet).sort();
      }
    } catch(e) {}

    const resData = { success: true, produkList: produkList, lokasiList: lokasiList };
    try {
      cache.put("WMS_STOCK_OPNAME_INIT_SUPA_V1", JSON.stringify(resData), 3600);
    } catch (e) {}

    return resData;
  } catch (err) {
    return { success: false, message: "Terjadi error di server: " + err.message };
  }
}

/************************************************
 * AMBIL QTY SISTEM (ajax realtime)
 ************************************************/
function getWmsQtySistem(token, sku, lokasi) {
  try {
    const session = getWmsSessionFromToken(token);
    if (!session) return { success: false, message: "Sesi tidak valid, silakan login ulang." };
    if (!wmsBisaAksesStockOpname(session.akses)) return { success: false, message: "Akun kamu tidak punya akses." };

    return { success: true, qtySistem: getQtySistemSkuLokasi(sku, lokasi) };
  } catch (err) {
    return { success: false, message: "Terjadi error di server: " + err.message };
  }
}

/************************************************
 * EXPORT DATA STOK SAAT INI (CSV) DARI SUPABASE
 ************************************************/
function getWmsStockExportCsv(token) {
  try {
    const session = getWmsSessionFromToken(token);
    if (!session) return { success: false, message: "Sesi tidak valid, silakan login ulang." };
    if (!wmsBisaAksesStockOpname(session.akses)) return { success: false, message: "Akun kamu tidak punya akses ke fitur ini." };

    const url = SUPABASE_URL + "/rest/v1/view_stok_realtime?select=sku,lokasi,sisa_stok&sisa_stok=gt.0&order=lokasi.asc,sku.asc";
    const options = {
      method: "get",
      headers: { "apikey": SUPABASE_ANON_KEY, "Authorization": "Bearer " + SUPABASE_ANON_KEY },
      muteHttpExceptions: true
    };
    const res = UrlFetchApp.fetch(url, options);
    if (res.getResponseCode() !== 200) throw new Error("Gagal export stok dari Supabase");
    const list = JSON.parse(res.getContentText());

    let csv = "SKU,Lokasi,Qty Fisik\n";
    list.forEach(function(row) {
      csv += `"${row.sku}","${row.lokasi}",${row.sisa_stok}\n`;
    });

    return { success: true, csvData: csv };
  } catch (err) {
    return { success: false, message: "Terjadi error di server: " + err.message };
  }
}

/************************************************
 * SUBMIT SESI STOCK OPNAME (dari WEB, butuh token/session)
 ************************************************/
function submitSesiOpname(token, items) {
  const session = getWmsSessionFromToken(token);
  if (!session) return { success: false, message: "Sesi tidak valid, silakan login ulang." };
  if (!wmsBisaAksesStockOpname(session.akses)) return { success: false, message: "Akun kamu tidak punya akses ke fitur ini." };

  return simpanSesiOpnameInternal(items, session.username, false);
}

/************************************************
 * VERSI INTERNAL (kalkulasi & input langsung ke Supabase)
 ************************************************/
function simpanSesiOpnameInternal(items, operator, sertakanSkuTidakDisebut) {
  sertakanSkuTidakDisebut = (sertakanSkuTidakDisebut === true);
  try {
    if (!items || items.length === 0) {
      return { success: false, message: "Tidak ada item untuk disubmit." };
    }

    const sesiId = "SO-" + Date.now();
    const tanggal = Utilities.formatDate(new Date(), TIMEZONE, "yyyy-MM-dd HH:mm:ss");

    // Ambil data stok sistem dari Supabase view_stok_realtime
    const stockMap = {};
    const stockByLokasi = {};
    try {
      const url = SUPABASE_URL + "/rest/v1/view_stok_realtime?select=sku,lokasi,sisa_stok,area,nama_produk,size";
      const options = {
        method: "get",
        headers: { "apikey": SUPABASE_ANON_KEY, "Authorization": "Bearer " + SUPABASE_ANON_KEY },
        muteHttpExceptions: true
      };
      const res = UrlFetchApp.fetch(url, options);
      if (res.getResponseCode() === 200) {
        const stockData = JSON.parse(res.getContentText());
        stockData.forEach(row => {
          const lok = normalizeLokasi(row.lokasi);
          const sku = String(row.sku || "").trim().toUpperCase();
          if (lok && sku) {
            stockMap[lok + "_" + sku] = {
              qty: Number(row.sisa_stok) || 0,
              area: row.area || getArea(lok),
              nama: row.nama_produk || "",
              size: row.size || ""
            };
            if (!stockByLokasi[lok]) stockByLokasi[lok] = [];
            stockByLokasi[lok].push({ sku: sku, qty: Number(row.sisa_stok) || 0, area: row.area, nama: row.nama_produk, size: row.size });
          }
        });
      }
    } catch(e) {}

    const payloads = [];
    let jumlahDiproses = 0;
    let jumlahDilewati = 0;
    let jumlahTidakTerhitung = 0;
    const lokasiTersentuh = {};

    items.forEach(function (it) {
      const sku = String(it.sku || "").trim().toUpperCase();
      const lokasi = normalizeLokasi(it.lokasi);
      const qtyFisik = Number(it.qtyFisik);

      if (!sku || !lokasi || isNaN(qtyFisik)) {
        jumlahDilewati++;
        return;
      }

      if (!lokasiTersentuh[lokasi]) lokasiTersentuh[lokasi] = {};
      lokasiTersentuh[lokasi][sku] = true;

      const key = lokasi + "_" + sku;
      const sys = stockMap[key] || { qty: 0, area: getArea(lokasi), nama: it.namaProduk || sku, size: it.size || "" };
      const qtySistem = sys.qty;
      const selisih = qtyFisik - qtySistem;

      if (selisih === 0) {
        jumlahDilewati++;
        return;
      }

      payloads.push({
        sesi_id: sesiId,
        tanggal: tanggal,
        sku: sku,
        nama_produk: sys.nama || it.namaProduk || sku,
        size: sys.size || it.size || "",
        lokasi: lokasi,
        area: sys.area || getArea(lokasi),
        qty_sistem: qtySistem,
        qty_fisik: qtyFisik,
        selisih: selisih,
        status: "PENDING",
        jenis: "Opname",
        alasan: "Pending Adjustment (Opname Web)",
        operator: operator,
        invoice: sesiId
      });
      jumlahDiproses++;
    });

    if (sertakanSkuTidakDisebut) {
      Object.keys(lokasiTersentuh).forEach(function (lokasi) {
        const skuSudahDihitung = lokasiTersentuh[lokasi];
        const daftarSkuSistem = stockByLokasi[lokasi] || [];

        daftarSkuSistem.forEach(function (entrySistem) {
          const sku = entrySistem.sku;
          if (skuSudahDihitung[sku]) return;

          const qtySistem = entrySistem.qty;
          const qtyFisik = 0;
          const selisih = qtyFisik - qtySistem;

          if (selisih === 0) { jumlahDilewati++; return; }

          payloads.push({
            sesi_id: sesiId,
            tanggal: tanggal,
            sku: sku,
            nama_produk: entrySistem.nama || sku,
            size: entrySistem.size || "",
            lokasi: lokasi,
            area: entrySistem.area || getArea(lokasi),
            qty_sistem: qtySistem,
            qty_fisik: qtyFisik,
            selisih: selisih,
            status: "PENDING",
            jenis: "Opname",
            alasan: "Pending Adjustment (SKU tidak terhitung saat opname)",
            operator: operator,
            invoice: sesiId
          });
          jumlahDiproses++;
          jumlahTidakTerhitung++;
        });
      });
    }

    if (payloads.length === 0) {
      return { success: true, message: "Semua item cocok dengan stok sistem di Supabase, tidak ada adjustment yang perlu dibuat.", jumlahDiproses: 0, jumlahDilewati: jumlahDilewati };
    }

    // Insert ke Supabase stock_opname_queue
    const urlIns = SUPABASE_URL + "/rest/v1/stock_opname_queue";
    const optionsIns = {
      method: "post",
      headers: {
        "apikey": SUPABASE_ANON_KEY,
        "Authorization": "Bearer " + SUPABASE_ANON_KEY,
        "Content-Type": "application/json",
        "Prefer": "return=minimal"
      },
      payload: JSON.stringify(payloads),
      muteHttpExceptions: true
    };
    const resIns = UrlFetchApp.fetch(urlIns, optionsIns);
    if (resIns.getResponseCode() !== 201) {
      throw new Error("Gagal menyimpan antrean opname ke Supabase: " + resIns.getContentText());
    }

    return {
      success: true,
      message: "Sesi opname " + sesiId + " disimpan di Supabase. " + jumlahDiproses + " item punya selisih dan menunggu approval" +
               (jumlahTidakTerhitung > 0 ? " (termasuk " + jumlahTidakTerhitung + " SKU yang tidak disebut)" : "") +
               ", " + jumlahDilewati + " item cocok/dilewati.",
      sesiId: sesiId,
      jumlahDiproses: jumlahDiproses,
      jumlahDilewati: jumlahDilewati,
      jumlahTidakTerhitung: jumlahTidakTerhitung
    };
  } catch (err) {
    return { success: false, message: "Terjadi error di server: " + err.message };
  }
}

/************************************************
 * SUBMIT ADJUSTMENT MANUAL -- 1 ITEM
 ************************************************/
function submitAdjustmentManual(token, data) {
  return submitAdjustmentManualBulk(token, [data]);
}

/************************************************
 * SUBMIT ADJUSTMENT MANUAL BULK (Supabase Backend)
 ************************************************/
function submitAdjustmentManualBulk(token, items) {
  try {
    const session = getWmsSessionFromToken(token);
    if (!session) return { success: false, message: "Sesi tidak valid, silakan login ulang." };
    if (!wmsBisaAksesStockOpname(session.akses)) return { success: false, message: "Akun kamu tidak punya akses ke fitur ini." };

    if (!items || items.length === 0) {
      return { success: false, message: "Daftar adjustment kosong." };
    }

    const tanggal = Utilities.formatDate(new Date(), TIMEZONE, "yyyy-MM-dd HH:mm:ss");
    const operator = session.username;
    const sesiId = "ADJ-" + Date.now();

    // Fetch stock saat ini dari Supabase view_stok_realtime
    const stockMap = {};
    try {
      const url = SUPABASE_URL + "/rest/v1/view_stok_realtime?select=sku,lokasi,sisa_stok,area,nama_produk,size";
      const options = {
        method: "get",
        headers: { "apikey": SUPABASE_ANON_KEY, "Authorization": "Bearer " + SUPABASE_ANON_KEY },
        muteHttpExceptions: true
      };
      const res = UrlFetchApp.fetch(url, options);
      if (res.getResponseCode() === 200) {
        const stockData = JSON.parse(res.getContentText());
        stockData.forEach(row => {
          const lok = normalizeLokasi(row.lokasi);
          const sku = String(row.sku || "").trim().toUpperCase();
          if (lok && sku) {
            stockMap[lok + "_" + sku] = {
              qty: Number(row.sisa_stok) || 0,
              area: row.area || getArea(lok),
              nama: row.nama_produk || "",
              size: row.size || ""
            };
          }
        });
      }
    } catch(e) {}

    const payloads = [];
    let jumlahDilewati = 0;

    items.forEach(function (it) {
      const sku = String(it && it.sku || "").trim().toUpperCase();
      const lokasi = normalizeLokasi(it && it.lokasi);
      const deltaQty = Number(it && it.deltaQty);
      const alasan = String(it && it.alasan || "").trim();

      if (!sku || !lokasi || !deltaQty || isNaN(deltaQty) || !alasan) {
        jumlahDilewati++;
        return;
      }

      const key = lokasi + "_" + sku;
      const sys = stockMap[key] || { qty: 0, area: getArea(lokasi), nama: it.namaProduk || sku, size: it.size || "" };
      const qtySistem = sys.qty;
      const qtyFisik = qtySistem + deltaQty;

      payloads.push({
        sesi_id: sesiId,
        tanggal: tanggal,
        sku: sku,
        nama_produk: sys.nama || it.namaProduk || sku,
        size: sys.size || it.size || "",
        lokasi: lokasi,
        area: sys.area || getArea(lokasi),
        qty_sistem: qtySistem,
        qty_fisik: qtyFisik,
        selisih: deltaQty,
        status: "PENDING",
        jenis: "Manual",
        alasan: alasan,
        operator: operator,
        invoice: sesiId
      });
    });

    if (payloads.length === 0) {
      return {
        success: false,
        message: "Tidak ada item valid untuk disubmit. Pastikan SKU, Lokasi, dan Alasan terisi, dan Delta tidak boleh 0."
      };
    }

    const urlIns = SUPABASE_URL + "/rest/v1/stock_opname_queue";
    const optionsIns = {
      method: "post",
      headers: {
        "apikey": SUPABASE_ANON_KEY,
        "Authorization": "Bearer " + SUPABASE_ANON_KEY,
        "Content-Type": "application/json",
        "Prefer": "return=minimal"
      },
      payload: JSON.stringify(payloads),
      muteHttpExceptions: true
    };
    const resIns = UrlFetchApp.fetch(urlIns, optionsIns);
    if (resIns.getResponseCode() !== 201) {
      throw new Error("Gagal menyimpan adjustment ke Supabase: " + resIns.getContentText());
    }

    return {
      success: true,
      message: "Berhasil mengajukan " + payloads.length + " adjustment manual ke Supabase, menunggu approval." +
               (jumlahDilewati > 0 ? " (" + jumlahDilewati + " item dilewati karena data tidak lengkap / delta 0.)" : ""),
      jumlahDiproses: payloads.length,
      jumlahDilewati: jumlahDilewati
    };
  } catch (err) {
    return { success: false, message: "Terjadi error di server: " + err.message };
  }
}

/************************************************
 * EMAIL REKAP (CSV)
 ************************************************/
function kirimRekapAdjustmentEmail(sesiId, rows) {
  if (!rows || rows.length === 0) return;

  let csv = "Sesi/Invoice,Tanggal,SKU,Nama Produk,Size,Lokasi,Area,Qty Sistem,Qty Fisik,Selisih,Status,Jenis,Keterangan,Operator\n";
  rows.forEach(function (r) {
    const cols = [r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7], r[8], r[9], r[10], r[11], r[12], r[13]];
    csv += cols.map(function (c) {
      const s = String(c === undefined || c === null ? "" : c).replace(/"/g, '""');
      return '"' + s + '"';
    }).join(",") + "\n";
  });

  const blob = Utilities.newBlob(csv, "text/csv", "rekap-adjustment-" + sesiId + ".csv");
  const penerima = EMAIL_REKAP_ADJUSTMENT;

  MailApp.sendEmail({
    to: penerima,
    subject: "Rekap Selisih Stock Opname/Adjustment - " + sesiId,
    body: "Berikut rekap selisih stock opname/adjustment untuk sesi " + sesiId + " (" + rows.length + " item).\n\n" +
          "Semua item berstatus PENDING dan BELUM mengubah stok sistem sampai di-approve lewat halaman Stock Opname & Adjustment di dashboard WMS.\n\n" +
          "File CSV terlampir untuk detail lengkap.",
    attachments: [blob]
  });
}

/************************************************
 * AMBIL DAFTAR ADJUSTMENT PENDING (utk halaman approval)
 ************************************************/
function getWmsAdjustmentPendingList(token) {
  try {
    const session = getWmsSessionFromToken(token);
    if (!session) return { success: false, message: "Sesi tidak valid, silakan login ulang." };
    if (!wmsBisaAksesStockOpname(session.akses)) return { success: false, message: "Akun kamu tidak punya akses ke fitur ini." };

    const url = SUPABASE_URL + "/rest/v1/stock_opname_queue?status=eq.PENDING&order=tanggal.desc";
    const options = {
      method: "get",
      headers: {
        "apikey": SUPABASE_ANON_KEY,
        "Authorization": "Bearer " + SUPABASE_ANON_KEY,
        "Content-Type": "application/json"
      },
      muteHttpExceptions: true
    };
    
    const response = UrlFetchApp.fetch(url, options);
    if (response.getResponseCode() !== 200) {
      throw new Error(response.getContentText());
    }
    
    const json = JSON.parse(response.getContentText());
    const data = [];
    
    json.forEach(function(row) {
      data.push({
        rowIndex: row.id, // Gunakan UUID Supabase sebagai pengganti rowIndex
        sesiId: row.sesi_id || "",
        tanggal: formatTanggalAman(row.tanggal),
        sku: row.sku || "",
        namaProduk: row.nama_produk || "",
        size: row.size || "",
        lokasi: row.lokasi || "",
        area: row.area || "",
        qtySistem: row.qty_sistem,
        qtyFisik: row.qty_fisik,
        selisih: row.selisih,
        status: row.status,
        jenis: row.jenis || "",
        alasan: row.alasan || "",
        operator: row.operator || "",
        invoice: row.invoice || ""
      });
    });

    return { success: true, data: data };
  } catch (err) {
    return { success: false, message: "Terjadi error fetch Supabase: " + err.message };
  }
}

/************************************************
 * FORMAT TANGGAL AMAN
 ************************************************/
function formatTanggalAman(value) {
  if (value instanceof Date) {
    return Utilities.formatDate(value, TIMEZONE, "yyyy-MM-dd HH:mm");
  }
  return String(value || "");
}

/************************************************
 * APPROVE / REJECT
 ************************************************/
function approveAdjustment(token, rowIndex) {
  return prosesApprovalAdjustment(token, [rowIndex], true);
}

function rejectAdjustment(token, rowIndex) {
  return prosesApprovalAdjustment(token, [rowIndex], false);
}

function approveAdjustmentBulk(token, rowIndexList) {
  return prosesApprovalAdjustment(token, rowIndexList, true);
}

function rejectAdjustmentBulk(token, rowIndexList) {
  return prosesApprovalAdjustment(token, rowIndexList, false);
}

/************************************************
 * PROSES APPROVAL / REJECT MASSAL (DI-CHUNK)
 ************************************************/
function prosesApprovalAdjustment(token, idList, disetujui) {
  const session = getWmsSessionFromToken(token);
  if (!session) return { success: false, message: "Sesi tidak valid, silakan login ulang." };
  if (!wmsBisaAksesStockOpname(session.akses)) return { success: false, message: "Akun kamu tidak punya akses ke fitur ini." };

  if (!idList || idList.length === 0) {
    return { success: false, message: "Tidak ada baris yang dicentang." };
  }

  const approver = session.username;

  try {
    // 1. Fetch data dari Supabase untuk ID yang di-approve/reject (PostgREST syntax: id=in.(uuid1,uuid2))
    const cleanIds = idList.map(function(id) { return String(id).trim(); }).filter(Boolean);
    if (cleanIds.length === 0) {
      return { success: false, message: "Tidak ada ID valid yang dipilih." };
    }
    const idFilter = cleanIds.join(",");
    const urlGet = SUPABASE_URL + "/rest/v1/stock_opname_queue?id=in.(" + idFilter + ")&status=eq.PENDING";
    const optionsGet = {
      method: "get",
      headers: {
        "apikey": SUPABASE_ANON_KEY,
        "Authorization": "Bearer " + SUPABASE_ANON_KEY,
        "Content-Type": "application/json"
      },
      muteHttpExceptions: true
    };
    
    const resGet = UrlFetchApp.fetch(urlGet, optionsGet);
    if (resGet.getResponseCode() !== 200) {
      throw new Error("Gagal mengambil data dari Supabase: " + resGet.getContentText());
    }
    
    const items = JSON.parse(resGet.getContentText());
    if (items.length === 0) {
      return { success: false, message: "Item sudah tidak berstatus Pending atau tidak ditemukan." };
    }

    // 2. Jika disetujui, siapkan payload untuk log_produk
    if (disetujui) {
      const logsToInsert = [];
      items.forEach(function(item) {
        if (item.selisih !== 0) {
          const type = item.selisih > 0 ? "IN" : "OUT";
          const qtyAdj = Math.abs(item.selisih);
          const ket = item.alasan ? item.alasan : ("[" + (item.jenis || "ADJUSTMENT").toUpperCase() + "] Stock Opname");
          logsToInsert.push({
            sku: item.sku,
            lokasi: item.lokasi,
            invoice: item.invoice || item.sesi_id || ("ADJ-" + Date.now()),
            operator: approver,
            type: type,
            keterangan: ket,
            area: item.area || getArea(item.lokasi),
            qty: qtyAdj,
            size: item.size || "-",
            nama_produk: item.nama_produk || item.sku
          });
        }
      });
      
      if (logsToInsert.length > 0) {
        // 1. [SUPABASE] Insert log_produk
        const urlLog = SUPABASE_URL + "/rest/v1/log_produk";
        const optionsLog = {
          method: "post",
          headers: {
            "apikey": SUPABASE_ANON_KEY,
            "Authorization": "Bearer " + SUPABASE_ANON_KEY,
            "Content-Type": "application/json",
            "Prefer": "return=minimal"
          },
          payload: JSON.stringify(logsToInsert),
          muteHttpExceptions: true
        };
        const resLog = UrlFetchApp.fetch(urlLog, optionsLog);
        if (resLog.getResponseCode() !== 201) {
          throw new Error("Gagal insert log_produk: " + resLog.getContentText());
        }

        // 2. [GOOGLE SHEETS BACKUP] Tulis ke Sheet Log Product & Update STOCK (11 Kolom)
        try {
          const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
          const shLog = ss.getSheetByName(SHEET_NAME_LOG_PRODUCT || "Log Product");
          if (shLog) {
            const nowWib = Utilities.formatDate(new Date(), TIMEZONE, "yyyy-MM-dd HH:mm:ss");
            // Tulis 8 kolom (Kolom A-H): Kolom I (Nama Produk) & J (Size) otomatis dari ARRAYFORMULA
            const sheetRows = logsToInsert.map(function(l) {
              const typeAdj = l.type === "IN" ? "ADJ_IN" : "ADJ_OUT";
              return [
                nowWib,
                l.sku,
                l.lokasi,
                l.invoice,
                l.operator,
                typeAdj,
                l.keterangan,
                l.area
              ];
            });
            const startRow = typeof findNextRow === "function" ? findNextRow(shLog) : (shLog.getLastRow() + 1);
            shLog.getRange(startRow, 1, sheetRows.length, 8).setValues(sheetRows);

            if (typeof updateStockIncremental === "function") {
              updateStockIncremental(sheetRows);
            }
          }
        } catch (eSheet) {
          Logger.log("Gagal tulis approval ke sheet: " + eSheet.message);
        }
      }
    }

    // 3. Update status di stock_opname_queue menjadi APPROVED / REJECTED
    const newStatus = disetujui ? "APPROVED" : "REJECTED";
    const urlPatch = SUPABASE_URL + "/rest/v1/stock_opname_queue?id=in.(" + idFilter + ")";
    const optionsPatch = {
      method: "patch",
      headers: {
        "apikey": SUPABASE_ANON_KEY,
        "Authorization": "Bearer " + SUPABASE_ANON_KEY,
        "Content-Type": "application/json",
        "Prefer": "return=minimal"
      },
      payload: JSON.stringify({
        status: newStatus,
        tanggal_approve: new Date().toISOString(),
        approved_by: approver
      }),
      muteHttpExceptions: true
    };
    
    const resPatch = UrlFetchApp.fetch(urlPatch, optionsPatch);
    if (resPatch.getResponseCode() !== 204) {
      throw new Error("Gagal update status stock_opname_queue: " + resPatch.getContentText());
    }

    return {
      success: true,
      message: (disetujui ? "Approval" : "Reject") + " berhasil untuk " + items.length + " item."
    };

  } catch (err) {
    return { success: false, message: "Terjadi error: " + err.message };
  }
}