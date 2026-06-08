import { db, auth, itemsRef, salesRef, shiftsRef, membersRef, auditLogsRef } from './firebase-config.js';
import { addDoc, doc, getDoc, setDoc, updateDoc, deleteDoc, onSnapshot, query, orderBy, increment, serverTimestamp, where, limit, collection } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { signInWithEmailAndPassword, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";

// ==========================================
// PENGATURAN VIP & VARIABEL GLOBAL
// ==========================================
let globalSettings = {
    namaToko: "TOKO NUR ALAM",
    alamatToko: "Jl. Pabentengan No.22",
    footerStruk: "TERIMA KASIH!",
    pinAdmin: "123456",
    batasStok: 5,
    kelipatanPoin: 10000,
    tema: "dark",
    showExport: true,
    printerSize: 32,
    payNonCash: true,
    payKasbon: true,
    showMember: true,
    showVoucher: true,
    showHoldBill: true,
	pajakPersen: 0,
    serviceChargePersen: 0,
    vouchers: {
        "PROMO20": { type: "percent", value: 20 },
        "POTONG10K": { type: "nominal", value: 10000 }
    }
};

window.itemAkanDihapus = null; 

let databaseBarang = [], riwayatPenjualan = [], dataPenjualanTerfilter = [], dataShiftAll = [], auditLogsData = [], memberDataAll = [];
let databasePemasok = []; 

let memberDataAllCached = JSON.parse(localStorage.getItem("pos_cached_members") || "[]");
memberDataAll = memberDataAllCached.length > 0 ? memberDataAllCached : [];

let chartInstance = null, unsubscribeItems = null, unsubscribeSales = null, unsubscribeMembers = null, unsubscribeActiveShift = null, unsubscribeShifts = null, unsubscribeAudit = null, unsubscribePemasok = null, unsubscribeSettings = null;
let filterKategoriAktif = "Semua", kataKunciPencarian = "", globalSubtotal = 0, globalDiskon = 0, globalGrandTotal = 0;
let currentUserRole = "kasir", activeShiftSession = null, currentUserId = null, isSyncingOffline = false;

let kasirItemLimit = 36;
let gudangItemLimit = 30;

let kataKunciGudang = "";
let sortGudangOrder = 'asc'; 

let selectedPaymentMethod = "Tunai"; 
let isSplitPayment = false;
let splitDetails = { method1: "Tunai", amount1: 0, method2: "QRIS", amount2: 0, kembalian: 0 };
let piutangAktifDipilih = null;

let appliedVoucher = null;
let bluetoothPrintCharacteristic = null;

let keranjang = JSON.parse(localStorage.getItem("pos_recovery_cart") || "[]");
let activeMember = JSON.parse(localStorage.getItem("pos_recovery_member") || "null");

const toRupiah = (angka) => "Rp " + new Intl.NumberFormat('id-ID').format(Math.round(angka) || 0);

const formatTanggal = (timestamp) => { 
    if(!timestamp) return '...'; 
    try {
        if(typeof timestamp === 'string') return new Date(timestamp).toLocaleString('id-ID', { dateStyle: 'short', timeStyle: 'short' });
        if(timestamp.seconds) return new Date(timestamp.seconds * 1000).toLocaleString('id-ID', { dateStyle: 'short', timeStyle: 'short' });
        if(timestamp instanceof Date) return timestamp.toLocaleString('id-ID', { dateStyle: 'short', timeStyle: 'short' });
        return '-';
    } catch(e) { return '-'; }
};
const escapeHTML = (str) => (str == null ? '' : String(str).replace(/[&<>'"]/g, match => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[match])));
const escapeJS = (str) => String(str).replace(/'/g, "\\'").replace(/"/g, '&quot;');

try {
    const cachedItems = localStorage.getItem("pos_cached_items"); if (cachedItems) databaseBarang = JSON.parse(cachedItems);
    const cachedShift = localStorage.getItem("pos_cached_shift"); if (cachedShift) activeShiftSession = JSON.parse(cachedShift);
} catch(e) {}


// ==========================================
// 💡 FUNGSI UTAMA RENDER UI (Di-*hoisting*)
// ==========================================

function renderKatalogKasir() {
    const categoriesSet = new Set(databaseBarang.map(i => i.kategori || 'Umum'));
    const catContainer = document.getElementById('kasir-categories');
    if(catContainer) {
        catContainer.innerHTML = `<button onclick="window.setFilterKategori('Semua')" class="px-4 py-2 rounded-lg text-xs font-medium shrink-0 whitespace-nowrap transition-colors ${filterKategoriAktif==='Semua'?'bg-mantine-blue text-white':'bg-dark-6 border border-dark-4 text-dark-1'}">Semua Kategori</button>` + 
        Array.from(categoriesSet).map(cat => `<button onclick="window.setFilterKategori('${escapeJS(cat)}')" class="px-4 py-2 rounded-lg text-xs font-medium shrink-0 whitespace-nowrap transition-colors ${filterKategoriAktif===cat?'bg-mantine-blue text-white':'bg-dark-6 border border-dark-4 text-dark-1'}">${escapeHTML(cat)}</button>`).join('');
    }

    const filtered = databaseBarang.filter(i => (filterKategoriAktif === 'Semua' || (i.kategori||'Umum') === filterKategoriAktif) && ((i.nama||'').toLowerCase().includes(kataKunciPencarian) || (i.barcode && i.barcode.toLowerCase().includes(kataKunciPencarian))));
    const katContainer = document.getElementById('kasir-katalog');
    if(!katContainer) return;

    if (filtered.length === 0) { katContainer.innerHTML = `<p class="text-xs text-dark-2 italic col-span-full text-center py-8">Produk tidak ditemukan.</p>`; return; }
    
    const toShow = filtered.slice(0, kasirItemLimit);
    
    katContainer.innerHTML = toShow.map(i => {
        const isLowStock = (i.stok||0) <= (globalSettings.batasStok || 5);
        const stockClass = isLowStock ? 'bg-red-900/30 text-red-400' : 'bg-dark-5 text-dark-2';
        
        return `
        <div onclick="window.tambahKeKeranjang('${i.id}')" class="bg-dark-6 p-4 rounded-xl border border-dark-4 hover:border-mantine-blue cursor-pointer select-none flex flex-col justify-between active:scale-[0.98] transition-all group shadow-sm">
            <div>
                <div class="flex justify-between items-start gap-2 mb-2">
                    <span class="text-[10px] font-bold text-mantine-blue uppercase truncate bg-mantine-blue/10 px-2 py-1 rounded-md">${escapeHTML(i.kategori||'Umum')}</span>
                    <span class="text-[10px] px-2 py-1 rounded-md font-bold ${stockClass}">Stok: ${formatInputRibuan(i.stok||0)}</span>
                </div>
                <h4 class="font-bold text-xs text-gray-100 leading-snug group-hover:text-mantine-blue transition-colors">${escapeHTML(i.nama||'Item')}</h4>
            </div>
            <p class="text-sm font-black text-green-400 mt-4">${toRupiah(i.harga)}</p>
        </div>`
    }).join('');
        
    if (filtered.length > kasirItemLimit) {
        katContainer.innerHTML += `
            <div class="col-span-full flex justify-center py-6">
                <button onclick="window.loadMoreKasir()" class="px-6 py-2.5 bg-dark-5 hover:bg-dark-4 text-white text-xs font-bold rounded-xl shadow transition-colors border border-dark-4">
                    Tampilkan Lebih Banyak (${filtered.length - kasirItemLimit})
                </button>
            </div>
        `;
    }
}

function renderGudangList() {
    const container = document.getElementById('gudang-list'); 
    const totalEl = document.getElementById('gudang-total-item');
    if(!container) return;
    
    let filtered = databaseBarang.filter(i => {
        const keyword = kataKunciGudang.toLowerCase();
        return (i.nama || '').toLowerCase().includes(keyword) || 
               (i.barcode || '').toLowerCase().includes(keyword) ||
               (i.kategori || '').toLowerCase().includes(keyword) ||
               (i.catatan || '').toLowerCase().includes(keyword);
    });

    filtered.sort((a, b) => {
        const nameA = (a.nama || '').toLowerCase();
        const nameB = (b.nama || '').toLowerCase();
        if (sortGudangOrder === 'asc') return nameA.localeCompare(nameB);
        return nameB.localeCompare(nameA);
    });

    if (totalEl) totalEl.textContent = formatInputRibuan(filtered.length);

    if(filtered.length === 0) { container.innerHTML = `<p class="text-[11px] text-dark-2 italic text-center py-4">Barang tidak ditemukan.</p>`; return; }
    
    const toShowGudang = filtered.slice(0, gudangItemLimit);

    container.innerHTML = toShowGudang.map(i => {
        let supName = "";
        if(i.supplierId) { const sup = databasePemasok.find(x => x.id === i.supplierId); if(sup) supName = sup.nama; }
        
        const isLowStock = (i.stok||0) <= (globalSettings.batasStok || 5);
        const stockClass = isLowStock ? '!bg-red-900/30 !text-red-400 border-red-900/50' : '';

        return `
        <div class="bg-dark-6 p-4 rounded-xl border border-dark-4 flex justify-between items-center gap-3 shadow-sm hover:border-dark-3 transition-colors">
            <div>
                <span class="text-[9px] font-bold text-dark-2 mb-1 block uppercase tracking-wider">
                    ${escapeHTML(i.barcode ? '📟 '+i.barcode : 'NO BARCODE')} 
                    <span class="text-amber-500"> | 🏷️ ${escapeHTML(i.kategori || 'Umum')}</span>
                    ${supName ? '<span class="text-mantine-blue"> | 🚚 '+escapeHTML(supName)+'</span>' : ''}
                </span>
                <h3 class="font-bold text-gray-100 text-sm">${escapeHTML(i.nama||'Item')}</h3>
                ${i.catatan ? `<p class="text-[10px] text-dark-3 mt-0.5 italic">📝 ${escapeHTML(i.catatan)}</p>` : ''}
                <div class="flex items-center gap-2 mt-1.5"><span class="text-xs font-black text-green-400">${toRupiah(i.harga)}</span> <span class="text-[10px] text-dark-2">| Modal: ${toRupiah(i.cost||0)}</span> <span class="text-[9px] font-bold ml-1 px-1.5 py-0.5 bg-dark-5 text-dark-0 rounded border border-dark-4 ${stockClass}">Stok: ${formatInputRibuan(i.stok||0)}</span></div>
            </div>
            <div class="flex gap-2">
                <button onclick="window.duplikatBarang('${i.id}')" class="px-3 py-2 bg-indigo-900/30 hover:bg-indigo-900/50 text-indigo-400 border border-indigo-900/50 text-xs font-bold rounded-lg transition-colors" title="Duplikat Barang">Copy</button>
                <button onclick="window.editBarang('${i.id}')" class="px-3 py-2 bg-dark-5 hover:bg-dark-4 text-xs font-bold rounded-lg transition-colors">Ubah</button>
                <button onclick="window.hapusBarang('${i.id}')" class="px-3 py-2 bg-red-950/20 hover:bg-red-950/40 text-red-400 border border-red-900/50 text-xs font-bold rounded-lg transition-colors">Hapus</button>
            </div>
        </div>`
    }).join('');

    if (filtered.length > gudangItemLimit) {
        container.innerHTML += `
            <div class="flex justify-center py-4">
                <button onclick="window.loadMoreGudang()" class="px-6 py-2.5 bg-dark-5 hover:bg-dark-4 text-white text-xs font-bold rounded-xl shadow transition-colors border border-dark-4">
                    Tampilkan Lebih Banyak (${filtered.length - gudangItemLimit} item lagi)
                </button>
            </div>
        `;
    }
}

function renderKeranjang() {
    const listEl = document.getElementById('cart-list');
    document.getElementById('cart-total-qty-badge').textContent = `${keranjang.reduce((a, b) => a + b.qty, 0)} Item`;
    if(keranjang.length === 0) {
        if(listEl) listEl.innerHTML = `<div class="flex flex-col items-center justify-center h-full text-dark-3 absolute inset-0"><p class="text-sm font-medium italic">Keranjang belanja kosong</p></div>`;
        document.getElementById('btn-checkout').disabled = true; 
        document.getElementById('cart-grand-total').textContent = "Rp 0";
        document.getElementById('pane1-grand-total').textContent = "Rp 0";
        appliedVoucher = null; 
        if(document.getElementById('voucher-code')) document.getElementById('voucher-code').value = "";
        return;
    }
    if(listEl) listEl.innerHTML = keranjang.map(k => `
        <div class="bg-dark-6 p-4 rounded-xl border border-dark-4 flex flex-col xl:flex-row xl:justify-between xl:items-center gap-4 shadow-sm hover:border-dark-3 transition-colors">
            <div class="flex-1">
                <h5 class="text-sm font-bold text-gray-100 leading-snug">${escapeHTML(k.nama)}</h5>
                <p class="text-xs text-dark-2 mt-1.5">${toRupiah(k.harga)} x <span class="font-bold text-gray-300">${k.qty}</span></p>
            </div>
            <div class="flex items-center gap-3 bg-dark-8 p-1.5 rounded-lg border border-dark-4 shrink-0 max-w-min">
                <button onclick="window.ubahQtyCart('${k.id}', -1)" class="w-8 h-8 bg-dark-5 hover:bg-dark-4 text-gray-100 rounded-md text-lg font-black flex items-center justify-center transition-colors">-</button>
                <span class="text-sm font-bold px-2 text-gray-200 min-w-[1.5rem] text-center">${k.qty}</span>
                <button onclick="window.ubahQtyCart('${k.id}', 1)" class="w-8 h-8 bg-dark-5 hover:bg-dark-4 text-gray-100 rounded-md text-lg font-black flex items-center justify-center transition-colors">+</button>
            </div>
        </div>`).join('');
    hitungUangKembalian();
}

function hitungUangKembalian() {
    if(isSplitPayment) {
        resetPaymentUI(); 
        selectedPaymentMethod = 'Tunai'; 
        const btnCash = document.getElementById('pay-method-cash');
        if (btnCash) btnCash.className = "py-2.5 text-[11px] font-bold bg-mantine-blue text-white rounded-md transition-all shadow"; 
        document.getElementById('cash-paid').classList.remove('hidden');
    }
    
    globalSubtotal = Math.round(keranjang.reduce((acc, i) => acc + ((i.harga||0) * i.qty), 0));
    let diskonOtomatisMember = activeMember ? Math.floor(globalSubtotal * 0.05) : 0;
    
    let diskonVoucher = 0;
    if (appliedVoucher) {
        if (appliedVoucher.type === "percent") { diskonVoucher = Math.floor(globalSubtotal * (appliedVoucher.value / 100)); } 
        else if (appliedVoucher.type === "nominal") { diskonVoucher = appliedVoucher.value; }
    }

    const rawDiskonManual = 0; 
    globalDiskon = Math.min(globalSubtotal, rawDiskonManual + diskonOtomatisMember + diskonVoucher);
    
    // --- INTEGRASI KALKULASI FITUR PAJAK & SERVICE CHARGE ---
    let totalSebelumPajak = Math.max(0, globalSubtotal - globalDiskon);
    let nominalPajak = Math.round(totalSebelumPajak * ((globalSettings.pajakPersen || 0) / 100));
    let nominalService = Math.round(totalSebelumPajak * ((globalSettings.serviceChargePersen || 0) / 100));
    
    // Menggabungkan total belanja setelah dikurangi diskon, ditambah beban biaya eksternal
    globalGrandTotal = Math.round(totalSebelumPajak + nominalPajak + nominalService);
    
    // Sinkronisasi teks nominal ke elemen antarmuka pengguna (UI)
    document.getElementById('cart-subtotal').textContent = toRupiah(globalSubtotal);
    document.getElementById('cart-grand-total').textContent = toRupiah(globalGrandTotal);
    document.getElementById('pane1-grand-total').textContent = toRupiah(globalGrandTotal);
    
    const btnCheckout = document.getElementById('btn-checkout');
    btnCheckout.textContent = "Selesaikan Bayar"; 
    if (selectedPaymentMethod === 'Tunai') {
        const cashInput = Math.max(0, parseInputRibuan(document.getElementById('cash-paid').value));
        btnCheckout.disabled = (cashInput < globalGrandTotal || keranjang.length === 0);
    } else {
        btnCheckout.disabled = (keranjang.length === 0);
    }
}

function renderPiutangList() {
    const listContainer = document.getElementById('piutang-list'); if(!listContainer) return;
    const memberBerhutang = memberDataAll.filter(m => (m.hutang || 0) > 0).sort((a,b) => b.hutang - a.hutang);
    
    if(memberBerhutang.length === 0) { listContainer.innerHTML = `<div class="col-span-full bg-dark-8 p-6 rounded-xl border border-dark-4 text-center"><p class="text-sm font-bold text-green-400">🎉 Bersih! Tidak ada pelanggan yang berhutang.</p></div>`; return; }

    listContainer.innerHTML = memberBerhutang.map(m => `
        <div class="bg-dark-8 p-5 rounded-xl border border-dark-4 flex flex-col gap-3 relative overflow-hidden shadow-sm">
            <div class="absolute top-0 left-0 w-1 h-full bg-amber-500"></div>
            <div><p class="text-sm font-black text-gray-100">${escapeHTML(m.nama)}</p><p class="text-[10px] text-dark-2">HP: ${escapeHTML(m.id)}</p></div>
            <div class="bg-dark-7 p-3 rounded-lg border border-dark-4"><p class="text-[10px] font-bold text-dark-2 uppercase tracking-wider">Total Hutang</p><p class="text-lg font-black text-red-400">${toRupiah(m.hutang)}</p></div>
            <button onclick="window.bukaModalBayarPiutang('${m.id}')" class="w-full py-2.5 bg-amber-600 hover:bg-amber-500 text-white text-xs font-bold rounded-lg transition-colors shadow">Lunasi Cicilan</button>
        </div>`).join('');
}

async function applyFiltersAndStats() {
    let totalOmset = 0; let totalProfit = 0; let totalTrx = 0; let totalItems = 0; let produkCounts = {};
    let allSales = [...riwayatPenjualan];
    const offlineSales = await loadOfflineTransactions();
    if (offlineSales && offlineSales.length > 0) { allSales = [...offlineSales.reverse(), ...allSales]; }

    dataPenjualanTerfilter = allSales.filter(sale => sale.tipe !== "pelunasan_piutang"); 

    dataPenjualanTerfilter.forEach(sale => { 
        totalOmset += Math.round(sale.totalAkhir || 0); totalProfit += Math.round(sale.profit || 0); totalTrx++;
        if (Array.isArray(sale.items)) { sale.items.forEach(i => { totalItems += i.qty || 0; produkCounts[i.nama||'Item'] = (produkCounts[i.nama||'Item'] || 0) + i.qty; }); } 
    });

    const omsetDOM = document.getElementById('dash-omset'); if(omsetDOM) omsetDOM.textContent = toRupiah(totalOmset);
    const profitDOM = document.getElementById('dash-profit'); if(profitDOM) profitDOM.textContent = toRupiah(totalProfit); 
    const trxDOM = document.getElementById('dash-transaksi'); if(trxDOM) trxDOM.textContent = totalTrx;
    const itemsDOM = document.getElementById('dash-items'); if(itemsDOM) itemsDOM.innerHTML = `${totalItems}`;
    
    const sortedProduk = Object.entries(produkCounts).sort((a,b) => b[1] - a[1]).slice(0,5); 
    renderChart(sortedProduk.map(p => p[0]), sortedProduk.map(p => p[1])); renderRiwayatTable();
}

function renderChart(labels, values) {
    if (typeof Chart === 'undefined') return; const ctx = document.getElementById('chartProdukTerlaris'); if(!ctx) return; if (chartInstance) chartInstance.destroy();
    if (labels.length === 0) { labels = ["Belum ada data"]; values = [0]; }
    chartInstance = new Chart(ctx, { type: 'bar', data: { labels: labels, datasets: [{ label: 'Qty Terjual', data: values, backgroundColor: '#1971c2', borderRadius: 6 }] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { grid: { display: false }, ticks: { color: '#909296', font: { family: 'Inter', size: 10 } } }, y: { grid: { color: '#373A40' }, ticks: { color: '#909296', font: { family: 'Inter', size: 10 }, precision: 0 } } } } });
}

function renderRiwayatTable() {
    const tbody = document.getElementById('riwayat-list'); if(!tbody) return;
    tbody.innerHTML = dataPenjualanTerfilter.map(trx => {
        const itemsStr = Array.isArray(trx.items) ? trx.items.map(i => `${escapeHTML(i.nama)} (${i.qty}x)`).join(', ') : '';
        return `
            <tr class="hover:bg-dark-5/40 border-b border-dark-4">
                <td class="px-6 py-4 text-xs">${formatTanggal(trx.waktu || trx.waktuLokal)} ${trx.isOfflinePending ? '⏳' : ''}</td>
                <td class="px-6 py-4 text-xs text-gray-200 max-w-[200px] truncate">${trx.tipe === 'pelunasan_piutang' ? '<i>Pembayaran Kasbon</i>' : itemsStr}</td>
                <td class="px-6 py-4 text-xs font-bold"><span class="px-2.5 py-1 bg-dark-5 rounded border border-dark-4">${escapeHTML(trx.metodePembayaran)}</span></td>
                <td class="px-6 py-4 text-sm text-green-400 font-black">${toRupiah(trx.totalAkhir)}</td>
                <td class="px-6 py-4 text-right"><button onclick="window.reprintTrx('${trx.id || trx.localId}')" class="px-3 py-1.5 bg-dark-5 hover:bg-dark-4 text-white text-xs rounded-lg font-bold shadow">🖨️ Struk</button></td>
            </tr>`;
    }).join('');
}

function renderShiftLogs() {
    const tbody = document.getElementById('shift-log-list'); if(!tbody) return;
    tbody.innerHTML = dataShiftAll.map(s => `
        <tr class="hover:bg-dark-5/40 border-b border-dark-4">
            <td class="px-5 py-3"><p class="font-bold text-xs text-gray-200">${escapeHTML((s.namaKasir||'Unknown').toUpperCase())}</p><p class="text-[10px] text-dark-2 mt-0.5">${formatTanggal(s.waktuBuka)}</p></td>
            <td class="px-5 py-3 text-xs text-dark-1">${toRupiah(s.modalAwal)}</td>
            <td class="px-5 py-3 text-xs text-green-400 font-bold">${toRupiah(s.totalPenjualan || 0)}</td>
            <td class="px-5 py-3 text-xs text-dark-1">${s.status==='buka'?'-':toRupiah(s.uangFisikAktual)}</td>
            <td class="px-5 py-3">${s.status==='buka'?'<span class="text-green-400 font-bold bg-green-950/30 px-2 py-0.5 rounded border border-green-900 text-[10px] animate-pulse">AKTIF</span>':((s.selisih||0)===0?'<span class="text-green-400 font-bold text-xs">Pas</span>':((s.selisih||0)>0?`<span class="text-blue-400 font-bold text-xs">+${toRupiah(s.selisih||0)}</span>`:`<span class="text-red-400 font-bold text-xs">${toRupiah(s.selisih||0)}</span>`))}</td>
        </tr>`).join('');
}

function renderAuditLogs() {
    const tbody = document.getElementById('audit-log-list'); if(!tbody) return;
    tbody.innerHTML = auditLogsData.map(log => `
        <tr class="hover:bg-dark-5/40 border-b border-dark-4">
            <td class="px-5 py-3">
                <div class="flex justify-between mb-1.5"><span class="font-bold text-[11px] text-mantine-blue uppercase">👤 ${escapeHTML(log.user||'Sistem')}</span><span class="text-[10px] text-dark-3">${formatTanggal(log.timestamp)}</span></div>
                <span class="inline-block px-1.5 py-0.5 bg-dark-5 text-[10px] font-bold rounded mb-1.5 text-gray-300 border border-dark-4">${escapeHTML(log.action||'-')}</span>
                <p class="text-xs text-dark-1 leading-snug">${escapeHTML(log.detail||'-')}</p>
            </td>
        </tr>`).join('');
}

function updateHoldCountBadge() { 
    const badge = document.getElementById('hold-count-badge'); if(!badge) return; 
    const counts = JSON.parse(localStorage.getItem('pos_held_bills') || '[]').length; 
    badge.textContent = counts; 
    if(counts > 0) badge.classList.remove('hidden'); else badge.classList.add('hidden'); 
}

function renderHoldModalList() {
    const listContainer = document.getElementById('hold-bills-list'); if(!listContainer) return;
    const heldBills = JSON.parse(localStorage.getItem('pos_held_bills') || '[]');
    if (heldBills.length === 0) { listContainer.innerHTML = `<p class="text-xs text-dark-2 italic text-center py-4">Kosong.</p>`; return; }
    listContainer.innerHTML = heldBills.map(bill => `<div class="bg-dark-8 p-4 rounded-xl border border-dark-4 flex justify-between items-center gap-3"><div class="flex-1 min-w-0"><div class="flex justify-between items-center mb-1"><span class="font-bold text-xs text-amber-400 truncate">${escapeHTML(bill.tag)}</span></div><p class="text-[10px] text-dark-1 truncate">${bill.items.map(i => `${escapeHTML(i.nama)} (${i.qty}x)`).join(', ')}</p></div><div class="flex gap-2 shrink-0"><button onclick="window.loadHeldBill('${bill.id}')" class="px-3 py-1.5 bg-mantine-blue text-white rounded-lg text-xs font-bold transition-all">Buka</button><button onclick="window.deleteHeldBill('${bill.id}')" class="px-3 py-1.5 bg-red-950/40 text-red-400 border border-red-900 rounded-lg text-xs font-bold transition-all">🗑️</button></div></div>`).join('');
}


// ==========================================
// MESIN PARSER KEBAL
// ==========================================
const formatInputRibuan = (val) => {
    if (val === null || val === undefined || val === '') return '';
    let str = val.toString().replace(/[^0-9,]/g, '');
    let parts = str.split(',');
    let intPart = parts[0].replace(/[^0-9]/g, '');
    let decPart = parts.length > 1 ? ',' + parts.slice(1).join('').replace(/[^0-9]/g, '') : '';
    if (intPart) {
        intPart = new Intl.NumberFormat('id-ID').format(parseInt(intPart, 10));
    }
    return intPart + decPart;
};

const parseInputRibuan = (val) => {
    if (val === undefined || val === null || val === '') return 0;
    let cleanStr = val.toString().replace(/\./g, '').replace(/,/g, '.');
    const parsed = parseFloat(cleanStr);
    return isNaN(parsed) ? 0 : parsed;
};

const parseExcelNum = (val) => {
    if (val === undefined || val === null || val === '') return 0;
    if (typeof val === 'number') return val;
    let cleanStr = val.toString().replace(/\./g, '').replace(/,/g, '.');
    const parsed = parseFloat(cleanStr);
    return isNaN(parsed) ? 0 : parsed;
};

document.addEventListener('input', (e) => {
    if (e.target && e.target.classList && e.target.classList.contains('input-ribuan')) {
        e.target.value = formatInputRibuan(e.target.value);
    }
});


window.switchCartTab = (tabName) => {
    const paneList = document.getElementById('cart-pane-list');
    const panePay = document.getElementById('cart-pane-pay');
    const btnList = document.getElementById('tab-cart-list-btn');
    const btnPay = document.getElementById('tab-cart-pay-btn');

    if(tabName === 'list') {
        paneList.classList.remove('hidden'); paneList.classList.add('flex');
        panePay.classList.add('hidden'); panePay.classList.remove('flex');
        
        btnList.className = "flex-1 py-2.5 text-[11px] uppercase tracking-wider font-bold text-mantine-blue border-b-2 border-mantine-blue transition-colors focus:outline-none";
        btnPay.className = "flex-1 py-2.5 text-[11px] uppercase tracking-wider font-bold text-dark-2 border-b-2 border-transparent hover:text-gray-200 transition-colors focus:outline-none";
    } else {
        panePay.classList.remove('hidden'); panePay.classList.add('flex');
        paneList.classList.add('hidden'); paneList.classList.remove('flex');
        
        btnPay.className = "flex-1 py-2.5 text-[11px] uppercase tracking-wider font-bold text-mantine-blue border-b-2 border-mantine-blue transition-colors focus:outline-none";
        btnList.className = "flex-1 py-2.5 text-[11px] uppercase tracking-wider font-bold text-dark-2 border-b-2 border-transparent hover:text-gray-200 transition-colors focus:outline-none";
        
        if(selectedPaymentMethod === 'Tunai') setTimeout(() => document.getElementById('cash-paid')?.focus(), 100);
    }
};

const OFFLINE_DB_NAME = "POS_Offline_Database", OFFLINE_STORE_NAME = "pending_transactions";
function initIndexedDB() { return new Promise((resolve, reject) => { const request = indexedDB.open(OFFLINE_DB_NAME, 1); request.onupgradeneeded = (e) => { const idb = e.target.result; if (!idb.objectStoreNames.contains(OFFLINE_STORE_NAME)) idb.createObjectStore(OFFLINE_STORE_NAME, { keyPath: "localId", autoIncrement: true }); }; request.onsuccess = (e) => resolve(e.target.result); request.onerror = (e) => reject(e.target.error); }); }
async function loadOfflineTransactions() { if (!window.indexedDB) return []; try { const idb = await initIndexedDB(); const req = idb.transaction(OFFLINE_STORE_NAME, "readonly").objectStore(OFFLINE_STORE_NAME).getAll(); return new Promise(resolve => { req.onsuccess = () => resolve(req.result || []); req.onerror = () => resolve([]); }); } catch(e) { return []; } }
async function saveTransactionOffline(saleData) { try { const idb = await initIndexedDB(); const tx = idb.transaction(OFFLINE_STORE_NAME, "readwrite"); tx.objectStore(OFFLINE_STORE_NAME).add(saleData); await tx.complete; return true; } catch (e) { return false; } }

async function syncOfflineTransactions() {
    if (!navigator.onLine || isSyncingOffline) return;
    const indicator = document.getElementById('offline-indicator'); if (indicator) indicator.classList.add('hidden');
    isSyncingOffline = true;

    try {
        const idb = await initIndexedDB();
        const request = idb.transaction(OFFLINE_STORE_NAME, "readonly").objectStore(OFFLINE_STORE_NAME).getAll();
        
        request.onsuccess = async () => {
            const pendingSales = request.result; let successCount = 0; let syncedIds = [];
            if (pendingSales.length > 0) {
                for (const sale of pendingSales) {
                    try {
                        const localId = sale.localId; delete sale.localId; delete sale.isOfflinePending;
                        const tunaiMasukLaci = sale.tunaiMasukLaci || 0; delete sale.tunaiMasukLaci;
                        
                        sale.waktu = sale.waktuLokal ? new Date(sale.waktuLokal) : serverTimestamp(); 
                        await addDoc(salesRef, sale); 
                        
                        if (sale.tipe === "pelunasan_piutang") {
                            await updateDoc(doc(db, "members", sale.memberId), { hutang: increment(-sale.totalAkhir) });
                            if (sale.shiftId) await updateDoc(doc(db, "shift", sale.shiftId), { totalTunai: increment(tunaiMasukLaci) });
                        } else {
                            for (const item of sale.items) { try { await updateDoc(doc(db, "barang", item.id), { stok: increment(-item.qty) }); } catch(e) {} }
                            if (sale.memberId && sale.metodePembayaran === "Kasbon") {
                                await updateDoc(doc(db, "members", sale.memberId), { hutang: increment(sale.totalAkhir) });
                            } else if (sale.memberId && sale.metodePembayaran !== "Kasbon") {
                                const addPoin = Math.floor(sale.totalAkhir / (globalSettings.kelipatanPoin || 10000)); 
                                if (addPoin > 0) await updateDoc(doc(db, "members", sale.memberId), { poin: increment(addPoin) }); 
                            }
                            if (sale.shiftId) await updateDoc(doc(db, "shift", sale.shiftId), { totalPenjualan: increment(sale.totalAkhir), totalTunai: increment(tunaiMasukLaci) });
                        }

                        syncedIds.push(localId); successCount++;
                    } catch (e) {}
                }
            }
            if (syncedIds.length > 0) { const deleteTx = idb.transaction(OFFLINE_STORE_NAME, "readwrite"); syncedIds.forEach(id => deleteTx.objectStore(OFFLINE_STORE_NAME).delete(id)); await deleteTx.complete; }
            const offlineLogs = JSON.parse(localStorage.getItem('pos_offline_logs') || '[]');
            if (offlineLogs.length > 0) { let failedLogs = []; for (const log of offlineLogs) { try { log.timestamp = log.timestamp ? new Date(log.timestamp) : serverTimestamp(); await addDoc(auditLogsRef, log); } catch(e) { failedLogs.push(log); } } if(failedLogs.length > 0) localStorage.setItem('pos_offline_logs', JSON.stringify(failedLogs)); else localStorage.removeItem('pos_offline_logs'); }
            if(successCount > 0) { await logActivity("SYNC_OFFLINE", `Sukses sinkron ${successCount} transaksi.`); alert(`Koneksi Stabil! ${successCount} data offline berhasil diunggah.`); }
            applyFiltersAndStats(); isSyncingOffline = false;
        };
        request.onerror = () => { isSyncingOffline = false; };
    } catch(e) { isSyncingOffline = false; }
}

window.addEventListener('online', syncOfflineTransactions);
window.addEventListener('offline', () => { const indicator = document.getElementById('offline-indicator'); if (indicator) indicator.classList.remove('hidden'); applyFiltersAndStats(); });

async function logActivity(actionType, actionDetails) {
    const userEmail = auth.currentUser ? auth.currentUser.email.split('@')[0] : "Sistem";
    const logObj = { user: userEmail, action: actionType, detail: actionDetails };
    if (!navigator.onLine) { logObj.timestamp = new Date().toISOString(); const offlineLogs = JSON.parse(localStorage.getItem('pos_offline_logs') || '[]'); offlineLogs.push(logObj); localStorage.setItem('pos_offline_logs', JSON.stringify(offlineLogs)); return; }
    try { logObj.timestamp = serverTimestamp(); await addDoc(auditLogsRef, logObj); } catch (e) {}
}

let barcodeBuffer = "", barcodeTimeout = null, isProcessingBarcode = false;
document.addEventListener("keydown", async (e) => {
    if (e.target.tagName === 'INPUT' && e.target.id !== 'kasir-search') return;
    if (e.key === 'Enter' && barcodeBuffer.length > 0) {
        e.preventDefault();
        if(isProcessingBarcode) return; isProcessingBarcode = true;
        
        const cleanBuffer = barcodeBuffer.trim().toLowerCase();
        const b = databaseBarang.find(x => (x.barcode || '').toLowerCase() === cleanBuffer || (x.id || '').toLowerCase() === cleanBuffer);
        if (b) { window.tambahKeKeranjang(b.id); const searchInput = document.getElementById('kasir-search'); if (searchInput) { searchInput.value = ""; kataKunciPencarian = ""; kasirItemLimit = 36; renderKatalogKasir(); } } 
        else if(e.target.id === 'kasir-search') { alert(`Produk dengan Barcode [${barcodeBuffer}] tidak ditemukan.`); const searchInput = document.getElementById('kasir-search'); if (searchInput) searchInput.value = ""; }
        barcodeBuffer = ""; setTimeout(() => { isProcessingBarcode = false; }, 100);
    } else { if (e.key.length === 1) { barcodeBuffer += e.key; clearTimeout(barcodeTimeout); barcodeTimeout = setTimeout(() => { barcodeBuffer = ""; }, 50); } }
});

document.getElementById('btn-connect-printer')?.addEventListener('click', async () => {
    try {
        const device = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: ['000018f0-0000-1000-8000-00805f9b34fb', 'e7810a71-73ae-499d-8c15-faa9aef0c3f2'] });
        const server = await device.gatt.connect(); alert(`Berhasil pairing: ${device.name}`);
        try {
            const service = await server.getPrimaryService('000018f0-0000-1000-8000-00805f9b34fb');
            bluetoothPrintCharacteristic = await service.getCharacteristic('00002af1-0000-1000-8000-00805f9b34fb');
            document.getElementById('btn-connect-printer').classList.replace('text-dark-1', 'text-green-400');
            document.getElementById('btn-connect-printer').innerHTML = "<span class='text-sm'>🖨️</span> BT Aktif";
        } catch(e) { console.log("Generic service gagal. Menggunakan Print HTML"); }
    } catch (e) { alert("Gagal koneksi Bluetooth."); }
});

async function printDirectBluetooth(text) {
    if (!bluetoothPrintCharacteristic) return false;
    try {
        const encoder = new TextEncoder(); 
        const data = encoder.encode("\x1B\x40" + text + "\n\n\n\n"); 
        const MAX_CHUNK = 100;
        for (let i = 0; i < data.length; i += MAX_CHUNK) { await bluetoothPrintCharacteristic.writeValue(data.slice(i, i + MAX_CHUNK)); }
        return true;
    } catch (e) { return false; }
}

onAuthStateChanged(auth, async (user) => {
    document.getElementById('auth-loading')?.classList.add('hidden');
    if (user) {
        currentUserId = user.uid; 
        document.getElementById('login-screen')?.classList.add('hidden'); document.getElementById('app-screen')?.classList.remove('hidden');
        renderKatalogKasir(); renderGudangList(); renderKeranjang(); 
        
        if (navigator.onLine) {
            try {
                const userDocSnap = await getDoc(doc(db, "pengguna", user.uid));
                if (userDocSnap.exists()) { currentUserRole = userDocSnap.data().role || "kasir"; localStorage.setItem("pos_user_role", currentUserRole); } 
                else { currentUserRole = "kasir"; await setDoc(doc(db, "pengguna", user.uid), { email: user.email, role: "kasir", nama: user.email.split('@')[0] }); }
            } catch(e) { currentUserRole = localStorage.getItem("pos_user_role") || "kasir"; }
        } else { currentUserRole = localStorage.getItem("pos_user_role") || "kasir"; }
        
        stopRealtimeListeners(); applyRoleAccess(); initRealtimeListeners(); checkActiveShift(user.uid); updateHoldCountBadge(); syncOfflineTransactions();
        if(activeMember) showActiveMemberUI();
        if(!navigator.onLine) renderPiutangList();
    } else { 
        document.getElementById('app-screen')?.classList.add('hidden'); document.getElementById('login-screen')?.classList.remove('hidden'); stopRealtimeListeners(); 
    }
});

document.getElementById('login-form')?.addEventListener('submit', async (e) => {
    e.preventDefault(); if (!navigator.onLine) return alert("Peringatan: Koneksi internet dibutuhkan untuk masuk!");
    try { await signInWithEmailAndPassword(auth, document.getElementById('login-email').value.trim(), document.getElementById('login-password').value); e.target.reset(); } 
    catch (e) { alert("Login Gagal!"); }
});

// ✨ FUNGSI UNTUK MENCEGAH MEMORY LEAK SAAT LOGOUT ✨
function matikanSemuaListener() {
    if (typeof unsubscribeItems === 'function') unsubscribeItems();
    if (typeof unsubscribeSales === 'function') unsubscribeSales();
    if (typeof unsubscribeMembers === 'function') unsubscribeMembers();
    if (typeof unsubscribeActiveShift === 'function') unsubscribeActiveShift();
    if (typeof unsubscribeShifts === 'function') unsubscribeShifts();
    if (typeof unsubscribeAudit === 'function') unsubscribeAudit();
    if (typeof unsubscribePemasok === 'function') unsubscribePemasok();
    if (typeof unsubscribeSettings === 'function') unsubscribeSettings();
}

document.getElementById('btn-logout')?.addEventListener('click', async () => { 
    if (activeShiftSession) return alert("Tutup shift kasir sebelum keluar!");
    if(confirm("Keluar dari sistem?")) { 
        matikanSemuaListener(); // Clear memori sebelum keluar
        try { await signOut(auth); } catch (e) {} 
        finally { 
            sessionStorage.removeItem('pos_admin_authorized');
            localStorage.clear(); location.reload(); 
        } 
    } 
});

const tabsBtns = document.querySelectorAll('.nav-tab'), contents = document.querySelectorAll('.tab-content');
function switchTab(id) {
    contents.forEach(c => c.classList.add('hidden')); 
    tabsBtns.forEach(t => { t.classList.remove('border-b-2', 'border-mantine-blue', 'text-mantine-blue'); t.classList.add('border-transparent', 'text-dark-1'); });
    document.getElementById(`tab-${id}`)?.classList.remove('hidden');
    const targetBtn = document.getElementById(`tab-${id}-btn`); 
    if(targetBtn) { targetBtn.classList.remove('border-transparent', 'text-dark-1'); targetBtn.classList.add('border-b-2', 'border-mantine-blue', 'text-mantine-blue'); }
    if(id === 'piutang') renderPiutangList();
    if(id === 'dashboard' && chartInstance) setTimeout(() => chartInstance.update(), 100);
}
tabsBtns.forEach(tab => { tab.addEventListener('click', () => { switchTab(tab.id.replace('tab-', '').replace('-btn', '')); }); });
window.switchTab = switchTab;

function applyRoleAccess() {
    ['tab-dashboard-btn', 'tab-gudang-btn', 'tab-pemasok-btn', 'tab-pengaturan-btn', 'admin-shift-log-section'].forEach(id => { 
        const el = document.getElementById(id); 
        if (el) el.classList.toggle('hidden', currentUserRole !== "admin"); 
    });
    switchTab(currentUserRole === "admin" ? 'dashboard' : 'kasir');
}

function checkActiveShift(uid) {
    if (unsubscribeActiveShift) { unsubscribeActiveShift(); unsubscribeActiveShift = null; }
    unsubscribeActiveShift = onSnapshot(query(shiftsRef, where("userId", "==", uid), where("status", "==", "buka"), limit(1)), (snapshot) => {
        if (!snapshot.empty) { snapshot.forEach(doc => { activeShiftSession = { id: doc.id, ...doc.data() }; }); localStorage.setItem("pos_cached_shift", JSON.stringify(activeShiftSession)); updateShiftUI(true); } 
        else if(navigator.onLine) { activeShiftSession = null; localStorage.removeItem("pos_cached_shift"); updateShiftUI(false); }
    });
}

function updateShiftUI(isActive) {
    const w = document.getElementById('shift-status-widget'); if (!w) return;
    if (isActive) {
        w.className = "bg-green-900/20 border border-green-800/50 p-5 rounded-xl flex flex-col sm:flex-row sm:items-center justify-between gap-4";
        w.innerHTML = `<div class="text-sm text-green-400"><p class="font-bold flex items-center gap-2"><div class="w-2.5 h-2.5 rounded-full bg-green-500 animate-pulse"></div> Sesi Aktif: ${escapeHTML(auth.currentUser?.email.split('@')[0].toUpperCase())}</p><p class="text-green-500/80 mt-1 text-xs font-medium">Laci: ${toRupiah((activeShiftSession.modalAwal||0) + (activeShiftSession.totalTunai||0))} | Omset Total: ${toRupiah(activeShiftSession.totalPenjualan || 0)}</p></div><button onclick="window.triggerTutupShift()" class="px-5 py-2.5 text-xs font-bold text-gray-100 bg-dark-5 hover:bg-red-500 hover:text-white transition-all rounded-xl border border-dark-4 hover:border-red-600 shadow">Tutup Sesi 🔒</button>`;
        document.getElementById('kasir-core-content')?.classList.remove('opacity-40', 'pointer-events-none'); document.getElementById('kasir-cart-content')?.classList.remove('opacity-40', 'pointer-events-none');
    } else {
        w.className = "bg-dark-8 border border-dark-4 p-5 rounded-xl flex flex-col sm:flex-row sm:items-center justify-between gap-4";
        w.innerHTML = `<div class="text-sm text-dark-0"><p class="font-bold flex items-center gap-2">🔒 Sesi Belum Dibuka</p><p class="text-dark-2 mt-1 text-xs">Buka shift terlebih dahulu untuk bertransaksi.</p></div><button onclick="window.triggerBukaShift()" class="px-5 py-2.5 text-xs font-bold text-white bg-mantine-blue hover:bg-mantine-hover rounded-xl shadow-lg shadow-mantine-blue/20 transition-all">Mulai Shift 🔑</button>`;
        document.getElementById('kasir-core-content')?.classList.add('opacity-40', 'pointer-events-none'); document.getElementById('kasir-cart-content')?.classList.add('opacity-40', 'pointer-events-none');
    }
}

window.triggerBukaShift = () => {
    document.getElementById('shift-modal-title').textContent = "Buka Shift Kasir"; document.getElementById('shift-input-label').textContent = "Uang Modal Fisik di Laci (Rp)"; document.getElementById('btn-close-shift-modal')?.classList.add('hidden'); document.getElementById('btn-shift-submit').textContent = "Buka Sesi";
    const form = document.getElementById('shift-form'); if(!form) return;
    form.onsubmit = async (e) => {
        e.preventDefault(); 
        if (!navigator.onLine) return alert("Peringatan: Koneksi internet dibutuhkan.");
        const btnSubmit = document.getElementById('btn-shift-submit'); if(btnSubmit) { btnSubmit.disabled = true; btnSubmit.textContent = "Menyimpan..."; }
        try {
            const val = Math.round(Math.max(0, parseInputRibuan(document.getElementById('shift-cash-input')?.value)));
            const docRef = await addDoc(shiftsRef, { userId: currentUserId, namaKasir: auth.currentUser?.email.split('@')[0], waktuBuka: serverTimestamp(), modalAwal: val, totalPenjualan: 0, totalTunai: 0, status: "buka" });
            activeShiftSession = { id: docRef.id, userId: currentUserId, namaKasir: auth.currentUser?.email.split('@')[0], modalAwal: val, totalPenjualan: 0, totalTunai: 0, status: "buka" };
            localStorage.setItem("pos_cached_shift", JSON.stringify(activeShiftSession));
            await logActivity("SHIFT_BUKA", `Modal ${toRupiah(val)}`);
            document.getElementById('shift-modal')?.classList.add('hidden'); updateShiftUI(true);
        } catch(e) { alert("Error: " + e.message); } finally { if(btnSubmit) { btnSubmit.disabled = false; btnSubmit.textContent = "Buka Sesi"; } form.reset(); }
    };
    document.getElementById('shift-modal')?.classList.remove('hidden');
};

window.triggerTutupShift = () => {
    document.getElementById('shift-modal-title').textContent = "Z-Report (Tutup Shift)"; document.getElementById('shift-input-label').textContent = "Uang Fisik Aktual di Laci (Rp)"; document.getElementById('btn-close-shift-modal')?.classList.remove('hidden'); document.getElementById('btn-shift-submit').textContent = "Tutup Shift";
    const btnClose = document.getElementById('btn-close-shift-modal'); if(btnClose) btnClose.onclick = () => document.getElementById('shift-modal')?.classList.add('hidden');
    const form = document.getElementById('shift-form'); if(!form) return;
    form.onsubmit = async (e) => {
        e.preventDefault(); 
        if (!navigator.onLine) return alert("Peringatan: Koneksi internet dibutuhkan.");
        const btnSubmit = document.getElementById('btn-shift-submit'); if(btnSubmit) { btnSubmit.disabled = true; btnSubmit.textContent = "Validasi..."; }
        try {
            const val = Math.round(Math.max(0, parseInputRibuan(document.getElementById('shift-cash-input')?.value)));
            const selisih = Math.round(val - (activeShiftSession.modalAwal + (activeShiftSession.totalTunai || 0)));
            await updateDoc(doc(db, "shift", activeShiftSession.id), { waktuTutup: serverTimestamp(), uangFisikAktual: val, selisih: selisih, status: "tutup" });
            await logActivity("SHIFT_TUTUP", `Tutup Shift. Selisih laci: ${toRupiah(selisih)}`);
            alert(`Shift Berhasil Ditutup. Selisih Laci: ${toRupiah(selisih)}`);
            
            sessionStorage.removeItem('pos_admin_authorized');
            
            document.getElementById('shift-modal')?.classList.add('hidden'); activeShiftSession = null; localStorage.removeItem("pos_cached_shift"); updateShiftUI(false);
        } catch(e) { alert("Error: " + e.message); } finally { if(btnSubmit) { btnSubmit.disabled = false; btnSubmit.textContent = "Tutup Shift"; } form.reset(); }
    };
    document.getElementById('shift-modal')?.classList.remove('hidden');
};

// ✨ VISIBILITY TOGGLES
function updateFiturVisibility() {
    const showMember = document.getElementById('switch-fitur-member')?.checked ?? true;
    const showVoucher = document.getElementById('switch-fitur-voucher')?.checked ?? true;
    const showHold = document.getElementById('switch-fitur-hold')?.checked ?? true;

    document.getElementById('section-kasir-member')?.classList.toggle('hidden', !showMember);
    document.getElementById('section-kasir-voucher')?.classList.toggle('hidden', !showVoucher);
    document.getElementById('container-hold-bill')?.classList.toggle('hidden', !showHold);
}

['switch-fitur-member', 'switch-fitur-voucher', 'switch-fitur-hold'].forEach(id => {
    const el = document.getElementById(id);
    if(el) {
        const saved = localStorage.getItem(`pos_fitur_${id}`);
        if (saved !== null) el.checked = saved === 'true';
        el.addEventListener('change', (e) => {
            localStorage.setItem(`pos_fitur_${id}`, e.target.checked);
            updateFiturVisibility();
        });
    }
});

function terapkanPengaturanLayar() {
    const themeStyle = document.getElementById('dynamic-theme');
    if (globalSettings.tema === 'light-blue') {
        themeStyle.innerHTML = `
            .bg-dark-7 { background-color: #f1f5f9 !important; }
            .bg-dark-8 { background-color: #ffffff !important; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
            .bg-dark-6 { background-color: #e2e8f0 !important; }
            .bg-dark-5 { background-color: #cbd5e1 !important; color: #0f172a !important; }
            .text-white, .text-gray-100, .text-gray-200, .text-gray-300 { color: #0f172a !important; }
            .text-dark-0, .text-dark-1, .text-dark-2, .text-dark-3 { color: #475569 !important; }
            .border-dark-4, .border-dark-5 { border-color: #cbd5e1 !important; }
            input, select { color: #0f172a !important; }
            ::placeholder { color: #94a3b8 !important; }
        `;
    } else { themeStyle.innerHTML = ''; }

    const btnExport = document.getElementById('btn-export-gudang');
    const btnImport = document.getElementById('btn-import-gudang');
    if (btnExport && btnImport) {
        const ctn = document.getElementById('gudang-export-container');
        if (ctn) ctn.classList.toggle('hidden', !globalSettings.showExport);
    }

    document.getElementById('pay-method-noncash')?.classList.toggle('hidden', !globalSettings.payNonCash);
    document.getElementById('pay-method-kasbon')?.classList.toggle('hidden', !globalSettings.payKasbon);

    if(document.getElementById('set-nama')) document.getElementById('set-nama').value = globalSettings.namaToko || "TOKO MODERN POS";
    if(document.getElementById('set-alamat')) document.getElementById('set-alamat').value = globalSettings.alamatToko || "Jl. Teknologi No.123";
    if(document.getElementById('set-footer')) document.getElementById('set-footer').value = globalSettings.footerStruk || "TERIMA KASIH!";
    if(document.getElementById('set-pin')) document.getElementById('set-pin').value = globalSettings.pinAdmin || "123456";
    if(document.getElementById('set-printer')) document.getElementById('set-printer').value = globalSettings.printerSize || 32;
    if(document.getElementById('set-stok')) document.getElementById('set-stok').value = globalSettings.batasStok || 5;
    if(document.getElementById('set-poin')) document.getElementById('set-poin').value = globalSettings.kelipatanPoin || 10000;
    if(document.getElementById('set-tema')) document.getElementById('set-tema').value = globalSettings.tema || "dark";
    if(document.getElementById('set-export')) document.getElementById('set-export').checked = globalSettings.showExport !== false;
    if(document.getElementById('set-noncash')) document.getElementById('set-noncash').checked = globalSettings.payNonCash !== false;
    if(document.getElementById('set-kasbon')) document.getElementById('set-kasbon').checked = globalSettings.payKasbon !== false;

    renderKatalogKasir();
    renderGudangList();
    updateFiturVisibility();
}

function initRealtimeListeners() {
    stopRealtimeListeners();
    
    unsubscribeSettings = onSnapshot(doc(db, "pengaturan", "global"), (docSnap) => {
        if (docSnap.exists()) {
            globalSettings = { ...globalSettings, ...docSnap.data() };
        }
        terapkanPengaturanLayar();
    });

    unsubscribeItems = onSnapshot(query(itemsRef, orderBy("nama", "asc")), (snapshot) => { 
        databaseBarang = []; snapshot.forEach(doc => databaseBarang.push({ id: doc.id, ...doc.data() })); localStorage.setItem("pos_cached_items", JSON.stringify(databaseBarang)); renderKatalogKasir(); renderGudangList();
    });
    unsubscribeSales = onSnapshot(query(salesRef, orderBy("waktu", "desc"), limit(100)), (snapshot) => { 
        riwayatPenjualan = []; snapshot.forEach(doc => riwayatPenjualan.push({ id: doc.id, ...doc.data() })); applyFiltersAndStats(); 
    });
    unsubscribeMembers = onSnapshot(membersRef, (snapshot) => {
        memberDataAll = []; snapshot.forEach(doc => memberDataAll.push({ id: doc.id, ...doc.data() })); 
        localStorage.setItem("pos_cached_members", JSON.stringify(memberDataAll));
        renderPiutangList();
    });
    
    if (currentUserRole === 'admin') {
        unsubscribePemasok = onSnapshot(query(collection(db, "pemasok"), orderBy("nama", "asc")), (snapshot) => {
            databasePemasok = []; snapshot.forEach(doc => databasePemasok.push({ id: doc.id, ...doc.data() }));
            renderPemasokList(); renderPemasokDropdown(); renderGudangList();
        });
        unsubscribeShifts = onSnapshot(query(shiftsRef, orderBy("waktuBuka", "desc"), limit(30)), (snapshot) => { 
            dataShiftAll = []; snapshot.forEach(doc => dataShiftAll.push({ id: doc.id, ...doc.data() })); renderShiftLogs(); 
        });
        unsubscribeAudit = onSnapshot(query(auditLogsRef, orderBy("timestamp", "desc"), limit(50)), (snapshot) => { 
            auditLogsData = []; snapshot.forEach(doc => auditLogsData.push({ id: doc.id, ...doc.data() })); renderAuditLogs(); 
        });
    }
}

function stopRealtimeListeners() { 
    if(unsubscribeItems) unsubscribeItems(); if(unsubscribeSales) unsubscribeSales(); if(unsubscribeMembers) unsubscribeMembers();
    if(unsubscribeShifts) unsubscribeShifts(); if(unsubscribeAudit) unsubscribeAudit(); if(unsubscribeActiveShift) unsubscribeActiveShift();
    if(unsubscribePemasok) unsubscribePemasok(); if(unsubscribeSettings) unsubscribeSettings();
}

document.getElementById('settings-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!navigator.onLine) return alert("Peringatan: Butuh internet untuk menyimpan pengaturan global.");
    
    const btn = document.getElementById('btn-save-settings');
    const origText = btn.textContent;
    btn.textContent = "Menyimpan ke Server..."; btn.disabled = true;

    const newData = {
        namaToko: document.getElementById('set-nama').value.trim() || "TOKO POS",
        alamatToko: document.getElementById('set-alamat').value.trim() || "Alamat Toko",
        footerStruk: document.getElementById('set-footer').value.trim() || "Terima Kasih",
        pinAdmin: document.getElementById('set-pin').value.trim() || "123456",
        printerSize: parseInt(document.getElementById('set-printer').value) || 32,
        batasStok: parseInt(document.getElementById('set-stok').value) || 5,
        kelipatanPoin: parseInt(document.getElementById('set-poin').value) || 10000,
        tema: document.getElementById('set-tema').value,
        showExport: document.getElementById('set-export').checked,
        payNonCash: document.getElementById('set-noncash').checked,
        payKasbon: document.getElementById('set-kasbon').checked
    };

    try {
        await setDoc(doc(db, "pengaturan", "global"), newData, { merge: true });
        alert("Pembaruan Sistem Berhasil Diterapkan!");
    } catch (err) {
        alert("Gagal menyimpan pengaturan: " + err.message);
    } finally {
        btn.textContent = origText; btn.disabled = false;
    }
});


const pemasokForm = document.getElementById('pemasok-form');
pemasokForm?.addEventListener('submit', async (e) => {
    e.preventDefault(); if (!navigator.onLine) return alert("Peringatan: Butuh internet untuk memodifikasi Pemasok.");
    const id = document.getElementById('pemasok-id').value;
    const data = { nama: document.getElementById('pemasok-nama').value.trim(), kontak: document.getElementById('pemasok-kontak').value.trim(), info: document.getElementById('pemasok-info').value.trim() };
    const btnSubmit = document.getElementById('btn-submit-pemasok'); let origText = btnSubmit.textContent; btnSubmit.disabled = true; btnSubmit.textContent = "Menyimpan...";
    try {
        if(id) { await updateDoc(doc(db, "pemasok", id), data); } 
        else { await addDoc(collection(db, "pemasok"), data); }
        pemasokForm.reset(); document.getElementById('pemasok-id').value = ""; document.getElementById('btn-cancel-pemasok').classList.add('hidden');
    } catch(err) { alert("Gagal menyimpan Pemasok."); } finally { btnSubmit.disabled = false; btnSubmit.textContent = origText; }
});

window.editPemasok = (id) => {
    const p = databasePemasok.find(x => x.id === id); if(!p) return;
    document.getElementById('pemasok-id').value = p.id; document.getElementById('pemasok-nama').value = p.nama;
    document.getElementById('pemasok-kontak').value = p.kontak || ""; document.getElementById('pemasok-info').value = p.info || "";
    document.getElementById('btn-cancel-pemasok').classList.remove('hidden');
};

window.hapusPemasok = async (id) => { 
    if (!navigator.onLine) return alert("Butuh internet."); 
    const p = databasePemasok.find(x => x.id === id); if(!p) return; 
    if(confirm(`Hapus pemasok ${p.nama} secara permanen?`)) { await deleteDoc(doc(db, "pemasok", id)); } 
};

document.getElementById('btn-cancel-pemasok')?.addEventListener('click', () => { 
    pemasokForm?.reset(); document.getElementById('pemasok-id').value = ""; document.getElementById('btn-cancel-pemasok').classList.add('hidden'); 
});

function renderPemasokList() {
    const container = document.getElementById('pemasok-list'); if(!container) return;
    if(databasePemasok.length === 0) { container.innerHTML = `<p class="col-span-full text-xs text-dark-2 italic text-center py-8">Belum ada data Pemasok. Silakan tambahkan.</p>`; return; }
    container.innerHTML = databasePemasok.map(p => `
        <div class="bg-dark-6 p-4 rounded-xl border border-dark-4 flex flex-col justify-between shadow-sm hover:border-dark-3 transition-colors">
            <div><h3 class="font-bold text-gray-100 text-sm mb-1">${escapeHTML(p.nama)}</h3>${p.kontak ? `<p class="text-xs text-dark-2 mt-1">📞 ${escapeHTML(p.kontak)}</p>` : ''}${p.info ? `<p class="text-[10px] text-dark-3 mt-1 italic">ℹ️ ${escapeHTML(p.info)}</p>` : ''}</div>
            <div class="flex gap-2 mt-4 pt-3 border-t border-dark-5"><button onclick="window.editPemasok('${p.id}')" class="flex-1 py-1.5 bg-dark-5 hover:bg-dark-4 text-[10px] font-bold rounded-lg transition-colors">Ubah</button><button onclick="window.hapusPemasok('${p.id}')" class="flex-1 py-1.5 bg-red-950/20 text-red-400 border border-red-900/50 hover:bg-red-900/40 text-[10px] font-bold rounded-lg transition-colors">Hapus</button></div>
        </div>`).join('');
}

function renderPemasokDropdown() {
    const select = document.getElementById('item-supplier'); if(!select) return;
    const currentVal = select.value;
    select.innerHTML = `<option value="">-- Tanpa Pemasok --</option>` + databasePemasok.map(p => `<option value="${p.id}">${escapeHTML(p.nama)}</option>`).join('');
    if(currentVal) select.value = currentVal;
}

document.getElementById('btn-apply-voucher')?.addEventListener('click', () => {
    const code = document.getElementById('voucher-code').value.trim().toUpperCase(); if (!code) return;
    const activeVouchers = globalSettings.vouchers || {};
    
    if (activeVouchers[code]) { 
        appliedVoucher = activeVouchers[code]; 
        alert(`✅ Voucher ${code} berhasil diklaim!`); 
        hitungUangKembalian(); 
    } else { 
        alert("❌ Kode Voucher tidak valid atau kadaluarsa."); 
        appliedVoucher = null; 
        document.getElementById('voucher-code').value = ""; 
        hitungUangKembalian(); 
    }
});

// EVENT LISTENER BUTTON EXPORT IMPORT (FIXED - NO ERROR)
document.getElementById('btn-export-gudang')?.addEventListener('click', () => {
    if (databaseBarang.length === 0) return alert("Gudang kosong.");
    const dataExcel = databaseBarang.map(i => ({
        'Barcode': i.barcode || '',
        'Nama Barang': i.nama || '',
        'Kategori': i.kategori || 'Umum',
        'Harga Modal': i.cost || 0,
        'Harga Jual': i.harga || 0,
        'Stok': i.stok || 0,
        'Catatan': i.catatan || ''
    }));
    if (typeof XLSX !== 'undefined') {
        const worksheet = XLSX.utils.json_to_sheet(dataExcel);
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, "Data_Gudang");
        XLSX.writeFile(workbook, `Data_Gudang_${new Date().toISOString().split('T')[0]}.xlsx`);
    } else { alert("Pustaka Excel belum termuat."); }
});

document.getElementById('file-import-gudang')?.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (!navigator.onLine) {
        alert("Membutuhkan koneksi internet untuk Import Data.");
        e.target.value = "";
        return;
    }

    const btn = document.getElementById('btn-import-gudang');
    const origText = btn ? btn.innerHTML : '';
    if(btn) btn.innerHTML = "⏳ Memproses...";

    const reader = new FileReader();
    reader.onload = async (evt) => {
        try {
            const data = new Uint8Array(evt.target.result);
            const workbook = XLSX.read(data, {type: 'array'});
            const sheet = workbook.Sheets[workbook.SheetNames[0]];
            const jsonData = XLSX.utils.sheet_to_json(sheet);

            if (jsonData.length === 0) throw new Error("File Excel kosong.");

            let successCount = 0;
            let updateCount = 0;

            for (let row of jsonData) {
                const barcode = (row['Barcode'] || row['barcode'] || '').toString().trim();
                const nama = row['Nama Barang'] || row['nama'] || row['Nama'] || '';
                if (!nama) continue;

                const hrgModal = parseExcelNum(row['Harga Modal'] || row['cost'] || row['Cost']);
                const hrgJual = parseExcelNum(row['Harga Jual'] || row['harga'] || row['Harga']);
                const stok = parseExcelNum(row['Stok'] || row['stok'] || row['Qty']);
                
                const kategori = row['Kategori'] || row['kategori'] || 'Umum';
                const catatan = row['Catatan'] || row['catatan'] || '';

                const dataObj = { barcode, nama, kategori, catatan, cost: hrgModal, harga: hrgJual, stok, supplierId: "" };

                let existingItem = null;
                if (barcode) {
                    existingItem = databaseBarang.find(x => x.barcode === barcode);
                } else {
                    existingItem = databaseBarang.find(x => x.nama.toLowerCase() === nama.toLowerCase());
                }

                if (existingItem) {
                    await updateDoc(doc(db, "barang", existingItem.id), dataObj);
                    updateCount++;
                } else {
                    await addDoc(itemsRef, dataObj);
                    successCount++;
                }
            }
            alert(`Import Selesai!\n✅ ${successCount} Barang Baru ditambahkan.\n🔄 ${updateCount} Barang lama diperbarui.`);
        } catch (err) {
            alert("Gagal memproses file: " + err.message);
        } finally {
            if(btn) btn.innerHTML = origText;
            e.target.value = "";
        }
    };
    reader.readAsArrayBuffer(file);
});

// ✨ FUNGSI EXPORT RIWAYAT EXCEL DENGAN PENANGANAN ERROR ✨
document.getElementById('btn-export-excel')?.addEventListener('click', () => {
    if (!dataPenjualanTerfilter || dataPenjualanTerfilter.length === 0) {
        return alert("Data transaksi kosong atau belum dimuat.");
    }
    
    try {
        const fileNameDate = new Date().toISOString().split('T')[0];
        
        const dataExcel = dataPenjualanTerfilter.map(trx => { 
            const itemsStr = Array.isArray(trx.items) ? trx.items.map(i => `${i.nama||'Item'} (${i.qty}x)`).join(', ') : '';
            const waktuStr = trx.waktu && trx.waktu.seconds 
                ? new Date(trx.waktu.seconds * 1000).toLocaleString('id-ID') 
                : (trx.waktuLokal ? new Date(trx.waktuLokal).toLocaleString('id-ID') : '-');
                
            return { 
                'Waktu Transaksi': waktuStr, 
                'Kasir': trx.namaKasir || '-', 
                'Daftar Barang': itemsStr, 
                'Metode Pembayaran': trx.metodePembayaran || 'Tunai', 
                'Subtotal (Rp)': trx.subtotal || 0, 
                'Diskon (Rp)': trx.diskon || 0, 
                'Grand Total/Omset (Rp)': trx.totalAkhir || 0, 
                'Laba Bersih/Profit (Rp)': trx.profit || 0, 
                'Uang Diterima (Rp)': trx.uangBayar || 0, 
                'Kembalian (Rp)': trx.kembalian || 0 
            }; 
        });
        
        if (typeof XLSX !== 'undefined') {
            const worksheet = XLSX.utils.json_to_sheet(dataExcel);
            
            // Merapikan lebar kolom (Auto-fit sederhana)
            const maxCols = Object.keys(dataExcel[0] || {}).length;
            worksheet['!cols'] = Array(maxCols).fill({ wch: 20 }); 

            const workbook = XLSX.utils.book_new(); 
            XLSX.utils.book_append_sheet(workbook, worksheet, "Laporan Penjualan");
            XLSX.writeFile(workbook, `Laporan_Penjualan_${fileNameDate}.xlsx`);
        } else { 
            alert("Pustaka Excel belum termuat. Pastikan Anda online."); 
        }
    } catch (error) {
        console.error("Gagal mengekstrak data ke Excel:", error);
        alert("Terjadi kesalahan saat membuat file Excel.");
    }
});

// =======================================================================
// HANDLER PENGATURAN TOKO, PAJAK, DAN ENGINE BACKUP-RESTORE DATABASE JSON
// =======================================================================

function isiDataSettingKeForm() {
    if (document.getElementById('set-nama-toko')) {
        document.getElementById('set-nama-toko').value = globalSettings.namaToko || '';
        document.getElementById('set-alamat-toko').value = globalSettings.alamatToko || '';
        document.getElementById('set-footer-toko').value = globalSettings.footerStruk || '';
        document.getElementById('set-pajak').value = globalSettings.pajakPersen || 0;
        document.getElementById('set-service').value = globalSettings.serviceChargePersen || 0;
    }
}

// Menangkap event klik simpan untuk memperbarui variabel lokal runtime
document.getElementById('btn-save-settings')?.addEventListener('click', () => {
    if (document.getElementById('set-nama-toko')) {
        globalSettings.namaToko = document.getElementById('set-nama-toko').value;
        globalSettings.alamatToko = document.getElementById('set-alamat-toko').value;
        globalSettings.footerStruk = document.getElementById('set-footer-toko').value;
        globalSettings.pajakPersen = parseFloat(document.getElementById('set-pajak').value) || 0;
        globalSettings.serviceChargePersen = parseFloat(document.getElementById('set-service').value) || 0;
        
        // Cadangan lokal agar persisten saat halaman dimuat ulang sebelum sinkronisasi cloud penuh
        localStorage.setItem("pos_saved_global_settings", JSON.stringify(globalSettings));
    }
});

// Engine pembuat file unduhan backup .json
document.getElementById('btn-backup-data')?.addEventListener('click', () => {
    try {
        if (!databaseBarang || databaseBarang.length === 0) {
            return alert("Gagal Ekspor: Database barang Anda saat ini kosong.");
        }

        const paketCadangan = {
            metadata: "POS_MODERN_PRO_BACKUP",
            tanggalPembuatan: new Date().toISOString(),
            pengaturanSistem: globalSettings,
            dataProduk: databaseBarang
        };

        const stringifikasi = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(paketCadangan, null, 2));
        const tautanUnduhan = document.createElement('a');
        const tanggalHariIni = new Date().toISOString().split('T')[0];
        
        tautanUnduhan.setAttribute("href", stringifikasi);
        tautanUnduhan.setAttribute("download", `BACKUP_POS_ITEMS_${tanggalHariIni}.json`);
        document.body.appendChild(tautanUnduhan);
        tautanUnduhan.click();
        tautanUnduhan.remove();
        
        alert("🎉 Sukses! File database JSON berhasil diekspor ke folder unduhan perangkat Anda.");
    } catch (gagal) {
        alert("Gagal melakukan enkapsulasi data: " + gagal.message);
    }
});

// Engine pembaca file restorasi (.json) untuk dimasukkan ke Firebase Firestore secara sekuensial
document.getElementById('btn-restore-data')?.addEventListener('click', () => {
    const komponenFile = document.getElementById('input-restore-file');
    if (!komponenFile.files || komponenFile.files.length === 0) {
        return alert("Pilih file cadangan (.json) terlebih dahulu sebelum eksekusi.");
    }

    const berkas = komponenFile.files[0];
    const readerBerkas = new FileReader();

    readerBerkas.onload = async (e) => {
        try {
            const hasilParse = JSON.parse(e.target.result);
            
            if (!hasilParse.dataProduk || !Array.isArray(hasilParse.dataProduk)) {
                throw new Error("Struktur file tidak dikenali sebagai skema pencadangan resmi.");
            }

            const validasiTindakan = confirm("⚠️ PERINGATAN: Aksi ini akan menulis ulang data langsung ke Firebase Firestore Anda. Lanjutkan restorasi?");
            if (!validasiTindakan) return;

            alert("Proses injeksi data dimulai. Mohon tunggu dan jangan muat ulang halaman...");

            // Iterasi sekuensial mengunggah item ke referensi tabel barang (itemsRef) bawaan Anda
            for (const item dari hasilParse.dataProduk) {
                const docId = item.id || "GEN_" + Date.now().toString() + Math.random().toString(36).substr(2, 5);
                await setDoc(doc(db, "barang", docId), item);
            }

            alert("🔄 Basis data sukses dipulihkan ke cloud Firestore! Sistem akan memuat ulang halaman.");
            window.location.reload();

        } catch (err) {
            alert("Terjadi kegagalan baca data: " + err.message);
        }
    };
    readerBerkas.readAsText(berkas);
});

// Menjalankan sinkronisasi pengisian input form setelah inisialisasi awal aplikasi selesai
setTimeout(isiDataSettingKeForm, 1500);