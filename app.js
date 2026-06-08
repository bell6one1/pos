import { db, auth, itemsRef, salesRef, shiftsRef, membersRef, auditLogsRef } from './firebase-config.js';
import { addDoc, doc, getDoc, setDoc, updateDoc, deleteDoc, onSnapshot, query, orderBy, increment, serverTimestamp, where, limit, collection } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { signInWithEmailAndPassword, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";

// ==========================================
// 1. VARIABEL GLOBAL & STATE APLIKASI
// ==========================================
let globalSettings = {
    namaToko: "TOKO MODERN POS", alamatToko: "Jl. Teknologi No.123", footerStruk: "TERIMA KASIH!",
    pinAdmin: "123456", batasStok: 5, kelipatanPoin: 10000, tema: "dark", showExport: true,
    printerSize: 32, payNonCash: true, payKasbon: true, showMember: true, showVoucher: true,
    showHoldBill: true, pajakPersen: 0, serviceChargePersen: 0,
    vouchers: { "PROMO20": { type: "percent", value: 20 }, "POTONG10K": { type: "nominal", value: 10000 } }
};

window.itemAkanDihapus = null; 
let databaseBarang = [], riwayatPenjualan = [], dataPenjualanTerfilter = [], dataShiftAll = [], auditLogsData = [], databasePemasok = [];
let memberDataAllCached = JSON.parse(localStorage.getItem("pos_cached_members") || "[]");
let memberDataAll = memberDataAllCached.length > 0 ? memberDataAllCached : [];

let chartInstance = null, unsubscribeItems = null, unsubscribeSales = null, unsubscribeMembers = null, unsubscribeActiveShift = null, unsubscribeShifts = null, unsubscribeAudit = null, unsubscribePemasok = null, unsubscribeSettings = null;
let filterKategoriAktif = "Semua", kataKunciPencarian = "", globalSubtotal = 0, globalDiskon = 0, globalGrandTotal = 0, globalTaxAmount = 0, globalServiceAmount = 0;
let currentUserRole = "kasir", activeShiftSession = null, currentUserId = null, isSyncingOffline = false;
let kasirItemLimit = 36, gudangItemLimit = 30, kataKunciGudang = "", sortGudangOrder = 'asc'; 
let selectedPaymentMethod = "Tunai", isSplitPayment = false, splitDetails = { method1: "Tunai", amount1: 0, method2: "QRIS", amount2: 0, kembalian: 0 }, piutangAktifDipilih = null, appliedVoucher = null, bluetoothPrintCharacteristic = null;

let keranjang = JSON.parse(localStorage.getItem("pos_recovery_cart") || "[]");
let activeMember = JSON.parse(localStorage.getItem("pos_recovery_member") || "null");

try {
    const cachedItems = localStorage.getItem("pos_cached_items"); if (cachedItems) databaseBarang = JSON.parse(cachedItems);
    const cachedShift = localStorage.getItem("pos_cached_shift"); if (cachedShift) activeShiftSession = JSON.parse(cachedShift);
} catch(e) {}

// ==========================================
// 2. FUNGSI HELPER & FORMATTER
// ==========================================
const toRupiah = (angka) => "Rp " + new Intl.NumberFormat('id-ID').format(Math.round(angka) || 0);

function formatTanggal(timestamp) { 
    if(!timestamp) return '...'; 
    try {
        if(typeof timestamp === 'string') return new Date(timestamp).toLocaleString('id-ID', { dateStyle: 'short', timeStyle: 'short' });
        if(timestamp.seconds) return new Date(timestamp.seconds * 1000).toLocaleString('id-ID', { dateStyle: 'short', timeStyle: 'short' });
        if(timestamp instanceof Date) return timestamp.toLocaleString('id-ID', { dateStyle: 'short', timeStyle: 'short' });
        return '-';
    } catch(e) { return '-'; }
}

const escapeHTML = (str) => (str == null ? '' : String(str).replace(/[&<>'"]/g, match => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[match])));
const escapeJS = (str) => String(str).replace(/'/g, "\\'").replace(/"/g, '&quot;');

const formatInputRibuan = (val) => {
    if (val === null || val === undefined || val === '') return '';
    let str = val.toString().replace(/[^0-9,]/g, '');
    let parts = str.split(',');
    let intPart = parts[0].replace(/[^0-9]/g, '');
    let decPart = parts.length > 1 ? ',' + parts.slice(1).join('').replace(/[^0-9]/g, '') : '';
    if (intPart) intPart = new Intl.NumberFormat('id-ID').format(parseInt(intPart, 10));
    return intPart + decPart;
};

const parseInputRibuan = (val) => { 
    if (val === undefined || val === null || val === '') return 0; 
    let cleanStr = val.toString().replace(/\./g, '').replace(/,/g, '.'); 
    const parsed = parseFloat(cleanStr); return isNaN(parsed) ? 0 : parsed; 
};

const parseExcelNum = (val) => { 
    if (val === undefined || val === null || val === '') return 0; 
    if (typeof val === 'number') return val; 
    let cleanStr = val.toString().replace(/\./g, '').replace(/,/g, '.'); 
    const parsed = parseFloat(cleanStr); return isNaN(parsed) ? 0 : parsed; 
};

document.addEventListener('input', (e) => { 
    if (e.target && e.target.classList && e.target.classList.contains('input-ribuan')) {
        e.target.value = formatInputRibuan(e.target.value); 
    }
});

// ==========================================
// 3. ENGINE ANTARMUKA (RENDER UI)
// ==========================================
function updateFiturVisibility() {
    const showMember = document.getElementById('switch-fitur-member')?.checked ?? true; 
    const showVoucher = document.getElementById('switch-fitur-voucher')?.checked ?? true; 
    const showHold = document.getElementById('switch-fitur-hold')?.checked ?? true;
    
    document.getElementById('section-kasir-member')?.classList.toggle('hidden', !showMember); 
    document.getElementById('section-kasir-voucher')?.classList.toggle('hidden', !showVoucher); 
    document.getElementById('container-hold-bill')?.classList.toggle('hidden', !showHold);
}

function terapkanPengaturanLayar() {
    const themeStyle = document.getElementById('dynamic-theme');
    if (globalSettings.tema === 'light-blue') {
        themeStyle.innerHTML = `.bg-dark-7 { background-color: #f1f5f9 !important; } .bg-dark-8 { background-color: #ffffff !important; box-shadow: 0 1px 3px rgba(0,0,0,0.1); } .bg-dark-6 { background-color: #e2e8f0 !important; } .bg-dark-5 { background-color: #cbd5e1 !important; color: #0f172a !important; } .text-white, .text-gray-100, .text-gray-200, .text-gray-300 { color: #0f172a !important; } .text-dark-0, .text-dark-1, .text-dark-2, .text-dark-3 { color: #475569 !important; } .border-dark-4, .border-dark-5 { border-color: #cbd5e1 !important; } input, select { color: #0f172a !important; } ::placeholder { color: #94a3b8 !important; }`;
    } else { themeStyle.innerHTML = ''; }
    
    document.getElementById('gudang-export-container')?.classList.toggle('hidden', !globalSettings.showExport);
    document.getElementById('pay-method-noncash')?.classList.toggle('hidden', !globalSettings.payNonCash); 
    document.getElementById('pay-method-kasbon')?.classList.toggle('hidden', !globalSettings.payKasbon);
    
    if(document.getElementById('set-nama-toko')) {
        document.getElementById('set-nama-toko').value = globalSettings.namaToko || ""; 
        document.getElementById('set-alamat-toko').value = globalSettings.alamatToko || "";
        document.getElementById('set-footer-toko').value = globalSettings.footerStruk || ""; 
        document.getElementById('set-pin').value = globalSettings.pinAdmin || "123456";
        document.getElementById('set-printer').value = globalSettings.printerSize || 32; 
        document.getElementById('set-stok').value = globalSettings.batasStok || 5;
        document.getElementById('set-poin').value = globalSettings.kelipatanPoin || 10000; 
        document.getElementById('set-tema').value = globalSettings.tema || "dark";
        document.getElementById('set-export').checked = globalSettings.showExport !== false; 
        document.getElementById('set-noncash').checked = globalSettings.payNonCash !== false; 
        document.getElementById('set-kasbon').checked = globalSettings.payKasbon !== false;
        document.getElementById('set-pajak').value = globalSettings.pajakPersen || 0; 
        document.getElementById('set-service').value = globalSettings.serviceChargePersen || 0;
    }
    
    renderAdminVouchers(); renderKatalogKasir(); renderGudangList(); updateFiturVisibility(); hitungUangKembalian(); 
}

function renderKatalogKasir() {
    const categoriesSet = new Set(databaseBarang.map(i => i.kategori || 'Umum')); 
    const catContainer = document.getElementById('kasir-categories');
    
    if(catContainer) { 
        catContainer.innerHTML = `<button onclick="window.setFilterKategori('Semua')" class="px-4 py-2 rounded-lg text-xs font-medium shrink-0 whitespace-nowrap transition-colors ${filterKategoriAktif==='Semua'?'bg-mantine-blue text-white':'bg-dark-6 border border-dark-4 text-dark-1'}">Semua Kategori</button>` + 
        Array.from(categoriesSet).map(cat => `<button onclick="window.setFilterKategori('${escapeJS(cat)}')" class="px-4 py-2 rounded-lg text-xs font-medium shrink-0 whitespace-nowrap transition-colors ${filterKategoriAktif===cat?'bg-mantine-blue text-white':'bg-dark-6 border border-dark-4 text-dark-1'}">${escapeHTML(cat)}</button>`).join(''); 
    }
    
    const filtered = databaseBarang.filter(i => (filterKategoriAktif === 'Semua' || (i.kategori||'Umum') === filterKategoriAktif) && ((i.nama||'').toLowerCase().includes(kataKunciPencarian) || (i.barcode && i.barcode.toLowerCase().includes(kataKunciPencarian))));
    const katContainer = document.getElementById('kasir-katalog'); if(!katContainer) return;
    
    if (filtered.length === 0) { katContainer.innerHTML = `<p class="text-xs text-dark-2 italic col-span-full text-center py-8">Produk tidak ditemukan.</p>`; return; }
    
    katContainer.innerHTML = filtered.slice(0, kasirItemLimit).map(i => {
        const isLowStock = (i.stok||0) <= (globalSettings.batasStok || 5); const stockClass = isLowStock ? 'bg-red-900/30 text-red-400' : 'bg-dark-5 text-dark-2';
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
        </div>`;
    }).join('');
    
    if (filtered.length > kasirItemLimit) {
        katContainer.innerHTML += `<div class="col-span-full flex justify-center py-6"><button onclick="window.loadMoreKasir()" class="px-6 py-2.5 bg-dark-5 hover:bg-dark-4 text-white text-xs font-bold rounded-xl shadow transition-colors border border-dark-4">Tampilkan Lebih Banyak (${filtered.length - kasirItemLimit})</button></div>`;
    }
}

function renderGudangList() {
    const container = document.getElementById('gudang-list'), totalEl = document.getElementById('gudang-total-item'); if(!container) return;
    let filtered = databaseBarang.filter(i => { const keyword = kataKunciGudang.toLowerCase(); return (i.nama || '').toLowerCase().includes(keyword) || (i.barcode || '').toLowerCase().includes(keyword) || (i.kategori || '').toLowerCase().includes(keyword) || (i.catatan || '').toLowerCase().includes(keyword); });
    filtered.sort((a, b) => { const nameA = (a.nama || '').toLowerCase(), nameB = (b.nama || '').toLowerCase(); return sortGudangOrder === 'asc' ? nameA.localeCompare(nameB) : nameB.localeCompare(nameA); });
    
    if (totalEl) totalEl.textContent = formatInputRibuan(filtered.length);
    if(filtered.length === 0) { container.innerHTML = `<p class="text-[11px] text-dark-2 italic text-center py-4">Barang tidak ditemukan.</p>`; return; }
    
    container.innerHTML = filtered.slice(0, gudangItemLimit).map(i => {
        let supName = ""; if(i.supplierId) { const sup = databasePemasok.find(x => x.id === i.supplierId); if(sup) supName = sup.nama; }
        const isLowStock = (i.stok||0) <= (globalSettings.batasStok || 5), stockClass = isLowStock ? '!bg-red-900/30 !text-red-400 border-red-900/50' : '';
        return `
        <div class="bg-dark-6 p-4 rounded-xl border border-dark-4 flex justify-between items-center gap-3 shadow-sm hover:border-dark-3 transition-colors">
            <div>
                <span class="text-[9px] font-bold text-dark-2 mb-1 block uppercase tracking-wider">${escapeHTML(i.barcode ? '📟 '+i.barcode : 'NO BARCODE')} <span class="text-amber-500"> | 🏷️ ${escapeHTML(i.kategori || 'Umum')}</span>${supName ? '<span class="text-mantine-blue"> | 🚚 '+escapeHTML(supName)+'</span>' : ''}</span>
                <h3 class="font-bold text-gray-100 text-sm">${escapeHTML(i.nama||'Item')}</h3>
                ${i.catatan ? `<p class="text-[10px] text-dark-3 mt-0.5 italic">📝 ${escapeHTML(i.catatan)}</p>` : ''}
                <div class="flex items-center gap-2 mt-1.5"><span class="text-xs font-black text-green-400">${toRupiah(i.harga)}</span> <span class="text-[10px] text-dark-2">| Modal: ${toRupiah(i.cost||0)}</span> <span class="text-[9px] font-bold ml-1 px-1.5 py-0.5 bg-dark-5 text-dark-0 rounded border border-dark-4 ${stockClass}">Stok: ${formatInputRibuan(i.stok||0)}</span></div>
            </div>
            <div class="flex gap-2">
                <button onclick="window.duplikatBarang('${i.id}')" class="px-3 py-2 bg-indigo-900/30 hover:bg-indigo-900/50 text-indigo-400 border border-indigo-900/50 text-xs font-bold rounded-lg transition-colors">Copy</button>
                <button onclick="window.editBarang('${i.id}')" class="px-3 py-2 bg-dark-5 hover:bg-dark-4 text-xs font-bold rounded-lg transition-colors">Ubah</button>
                <button onclick="window.hapusBarang('${i.id}')" class="px-3 py-2 bg-red-950/20 hover:bg-red-950/40 text-red-400 border border-red-900/50 text-xs font-bold rounded-lg transition-colors">Hapus</button>
            </div>
        </div>`;
    }).join('');
    
    if (filtered.length > gudangItemLimit) {
        container.innerHTML += `<div class="flex justify-center py-4"><button onclick="window.loadMoreGudang()" class="px-6 py-2.5 bg-dark-5 hover:bg-dark-4 text-white text-xs font-bold rounded-xl shadow transition-colors border border-dark-4">Tampilkan Lebih Banyak (${filtered.length - gudangItemLimit} item lagi)</button></div>`;
    }
}

function renderKeranjang() {
    const listEl = document.getElementById('cart-list'); 
    if(document.getElementById('cart-total-qty-badge')) document.getElementById('cart-total-qty-badge').textContent = `${keranjang.reduce((a, b) => a + b.qty, 0)} Item`;
    
    if(keranjang.length === 0) {
        if(listEl) listEl.innerHTML = `<div class="flex flex-col items-center justify-center h-full text-dark-3 absolute inset-0"><p class="text-sm font-medium italic">Keranjang belanja kosong</p></div>`;
        if(document.getElementById('btn-checkout')) document.getElementById('btn-checkout').disabled = true; 
        if(document.getElementById('cart-grand-total')) document.getElementById('cart-grand-total').textContent = "Rp 0";
        if(document.getElementById('pane1-grand-total')) document.getElementById('pane1-grand-total').textContent = "Rp 0";
        
        appliedVoucher = null; 
        if(document.getElementById('voucher-code')) document.getElementById('voucher-code').value = "";
        document.getElementById('kembalian-info')?.classList.add('hidden');
        document.getElementById('cart-tax-zone')?.classList.add('hidden');
        document.getElementById('cart-service-zone')?.classList.add('hidden');
        return;
    }
    
    if(listEl) {
        listEl.innerHTML = keranjang.map(k => `
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
    }
    hitungUangKembalian();
}

function hitungUangKembalian() {
    if(isSplitPayment) { 
        resetPaymentUI(); selectedPaymentMethod = 'Tunai'; 
        const btnCash = document.getElementById('pay-method-cash'); if (btnCash) btnCash.className = "py-2.5 text-[11px] font-bold bg-mantine-blue text-white rounded-md transition-all shadow"; 
        document.getElementById('cash-paid')?.classList.remove('hidden'); document.getElementById('quick-cash-zone')?.classList.remove('hidden'); 
    }
    
    globalSubtotal = Math.round(keranjang.reduce((acc, i) => acc + ((i.harga||0) * i.qty), 0));
    let diskonOtomatisMember = activeMember ? Math.floor(globalSubtotal * 0.05) : 0;
    let diskonVoucher = 0;
    
    if (appliedVoucher) { 
        if (appliedVoucher.type === "percent") { diskonVoucher = Math.floor(globalSubtotal * (appliedVoucher.value / 100)); } 
        else if (appliedVoucher.type === "nominal") { diskonVoucher = appliedVoucher.value; } 
    }
    
    globalDiskon = Math.min(globalSubtotal, diskonOtomatisMember + diskonVoucher);
    let totalSebelumPajak = Math.max(0, globalSubtotal - globalDiskon);
    
    const taxRate = parseFloat(globalSettings.pajakPersen) || 0; 
    const serviceRate = parseFloat(globalSettings.serviceChargePersen) || 0;
    
    globalTaxAmount = Math.round(totalSebelumPajak * (taxRate / 100)); 
    globalServiceAmount = Math.round(totalSebelumPajak * (serviceRate / 100));
    globalGrandTotal = totalSebelumPajak + globalTaxAmount + globalServiceAmount;
    
    if(document.getElementById('cart-subtotal')) document.getElementById('cart-subtotal').textContent = toRupiah(globalSubtotal); 
    if(document.getElementById('cart-grand-total')) document.getElementById('cart-grand-total').textContent = toRupiah(globalGrandTotal);
    if(document.getElementById('pane1-grand-total')) document.getElementById('pane1-grand-total').textContent = toRupiah(globalGrandTotal);
    
    const taxZone = document.getElementById('cart-tax-zone');
    if(taxZone) { 
        if (taxRate > 0) { taxZone.classList.remove('hidden'); document.getElementById('cart-tax-rate-display').textContent = taxRate; document.getElementById('cart-tax-amount').textContent = "+" + toRupiah(globalTaxAmount); } 
        else { taxZone.classList.add('hidden'); } 
    }
    const serviceZone = document.getElementById('cart-service-zone');
    if(serviceZone) { 
        if (serviceRate > 0) { serviceZone.classList.remove('hidden'); document.getElementById('cart-service-rate-display').textContent = serviceRate; document.getElementById('cart-service-amount').textContent = "+" + toRupiah(globalServiceAmount); } 
        else { serviceZone.classList.add('hidden'); } 
    }
    
    const btnCheckout = document.getElementById('btn-checkout'); if(btnCheckout) btnCheckout.textContent = "Selesaikan Bayar";
    const kembalianInfo = document.getElementById('kembalian-info'), kembalianNilai = document.getElementById('kembalian-nilai');
    
    if (selectedPaymentMethod === 'Tunai') {
        const cashInputVal = Math.max(0, parseInputRibuan(document.getElementById('cash-paid')?.value || "0")); 
        const kembalian = cashInputVal - globalGrandTotal;
        
        if (kembalianInfo) kembalianInfo.classList.remove('hidden');
        if (kembalianNilai) {
            if (document.getElementById('cash-paid')?.value === "") { kembalianNilai.textContent = "Rp 0"; kembalianNilai.className = "text-lg font-black text-dark-2"; } 
            else if (kembalian < 0) { kembalianNilai.textContent = "Kurang: " + toRupiah(Math.abs(kembalian)); kembalianNilai.className = "text-lg font-black text-red-400"; } 
            else { kembalianNilai.textContent = "Kembali: " + toRupiah(kembalian); kembalianNilai.className = "text-lg font-black text-green-400"; }
        }
        if(btnCheckout) btnCheckout.disabled = (cashInputVal < globalGrandTotal || keranjang.length === 0);
    } else {
        if(kembalianInfo) kembalianInfo.classList.add('hidden');
        if(btnCheckout) btnCheckout.disabled = (keranjang.length === 0);
    }
}

function resetPaymentUI() {
    ['pay-method-cash', 'pay-method-noncash', 'pay-method-kasbon'].forEach(id => { const b = document.getElementById(id); if(b) b.className = "py-2.5 text-[11px] font-bold text-dark-1 hover:text-gray-100 rounded-md transition-all"; });
    const btnSplit = document.getElementById('pay-method-split'); if(btnSplit) btnSplit.className = "w-full py-2.5 mb-4 text-[11px] font-bold text-mantine-blue bg-mantine-blue/10 hover:bg-mantine-blue/20 border border-mantine-blue/30 rounded-lg transition-all";
    document.getElementById('cash-paid')?.classList.add('hidden'); document.getElementById('noncash-ref')?.classList.add('hidden'); document.getElementById('quick-cash-zone')?.classList.add('hidden'); document.getElementById('kembalian-info')?.classList.add('hidden');
    isSplitPayment = false;
}

// ==========================================
// 4. STATISTIK, LOG & DAFTAR
// ==========================================
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
    
    if(document.getElementById('dash-omset')) document.getElementById('dash-omset').textContent = toRupiah(totalOmset);
    if(document.getElementById('dash-profit')) document.getElementById('dash-profit').textContent = toRupiah(totalProfit); 
    if(document.getElementById('dash-transaksi')) document.getElementById('dash-transaksi').textContent = totalTrx;
    if(document.getElementById('dash-items')) document.getElementById('dash-items').innerHTML = `${totalItems}`;
    
    const sortedProduk = Object.entries(produkCounts).sort((a,b) => b[1] - a[1]).slice(0,5); 
    renderChart(sortedProduk.map(p => p[0]), sortedProduk.map(p => p[1])); 
    renderRiwayatTable();
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
            <td class="px-5 py-3">
                <p class="font-bold text-xs text-gray-200">${escapeHTML((s.namaKasir||'Unknown').toUpperCase())}</p>
                <p class="text-[10px] text-dark-2 mt-0.5">${formatTanggal(s.waktuBuka)}</p>
            </td>
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
                <div class="flex justify-between mb-1.5">
                    <span class="font-bold text-[11px] text-mantine-blue uppercase">👤 ${escapeHTML(log.user||'Sistem')}</span>
                    <span class="text-[10px] text-dark-3">${formatTanggal(log.timestamp)}</span>
                </div>
                <span class="inline-block px-1.5 py-0.5 bg-dark-5 text-[10px] font-bold rounded mb-1.5 text-gray-300 border border-dark-4">${escapeHTML(log.action||'-')}</span>
                <p class="text-xs text-dark-1 leading-snug">${escapeHTML(log.detail||'-')}</p>
            </td>
        </tr>`).join('');
}

function updateHoldCountBadge() { 
    const badge = document.getElementById('hold-count-badge'); if(!badge) return; 
    const counts = JSON.parse(localStorage.getItem('pos_held_bills') || '[]').length; 
    badge.textContent = counts; if(counts > 0) badge.classList.remove('hidden'); else badge.classList.add('hidden'); 
}

function renderHoldModalList() {
    const listContainer = document.getElementById('hold-bills-list'); if(!listContainer) return; 
    const heldBills = JSON.parse(localStorage.getItem('pos_held_bills') || '[]');
    if (heldBills.length === 0) { listContainer.innerHTML = `<p class="text-xs text-dark-2 italic text-center py-4">Kosong.</p>`; return; }
    
    listContainer.innerHTML = heldBills.map(bill => `
        <div class="bg-dark-8 p-4 rounded-xl border border-dark-4 flex justify-between items-center gap-3">
            <div class="flex-1 min-w-0">
                <div class="flex justify-between items-center mb-1"><span class="font-bold text-xs text-amber-400 truncate">${escapeHTML(bill.tag)}</span></div>
                <p class="text-[10px] text-dark-1 truncate">${bill.items.map(i => `${escapeHTML(i.nama)} (${i.qty}x)`).join(', ')}</p>
            </div>
            <div class="flex gap-2 shrink-0">
                <button onclick="window.loadHeldBill('${bill.id}')" class="px-3 py-1.5 bg-mantine-blue text-white rounded-lg text-xs font-bold transition-all">Buka</button>
                <button onclick="window.deleteHeldBill('${bill.id}')" class="px-3 py-1.5 bg-red-950/40 text-red-400 border border-red-900 rounded-lg text-xs font-bold transition-all">🗑️</button>
            </div>
        </div>`).join('');
}

function renderPemasokList() {
    const container = document.getElementById('pemasok-list'); if(!container) return;
    if(databasePemasok.length === 0) { container.innerHTML = `<p class="col-span-full text-xs text-dark-2 italic text-center py-8">Belum ada data Pemasok. Silakan tambahkan.</p>`; return; }
    container.innerHTML = databasePemasok.map(p => `
        <div class="bg-dark-6 p-4 rounded-xl border border-dark-4 flex flex-col justify-between shadow-sm hover:border-dark-3 transition-colors">
            <div>
                <h3 class="font-bold text-gray-100 text-sm mb-1">${escapeHTML(p.nama)}</h3>
                ${p.kontak ? `<p class="text-xs text-dark-2 mt-1">📞 ${escapeHTML(p.kontak)}</p>` : ''}
                ${p.info ? `<p class="text-[10px] text-dark-3 mt-1 italic">ℹ️ ${escapeHTML(p.info)}</p>` : ''}
            </div>
            <div class="flex gap-2 mt-4 pt-3 border-t border-dark-5">
                <button onclick="window.editPemasok('${p.id}')" class="flex-1 py-1.5 bg-dark-5 hover:bg-dark-4 text-[10px] font-bold rounded-lg transition-colors">Ubah</button>
                <button onclick="window.hapusPemasok('${p.id}')" class="flex-1 py-1.5 bg-red-950/20 text-red-400 border border-red-900/50 hover:bg-red-900/40 text-[10px] font-bold rounded-lg transition-colors">Hapus</button>
            </div>
        </div>`).join('');
}

function renderPemasokDropdown() { 
    const select = document.getElementById('item-supplier'); if(!select) return; 
    const currentVal = select.value; 
    select.innerHTML = `<option value="">-- Tanpa Pemasok --</option>` + databasePemasok.map(p => `<option value="${p.id}">${escapeHTML(p.nama)}</option>`).join(''); 
    if(currentVal) select.value = currentVal; 
}

function renderAdminVouchers() {
    const tbody = document.getElementById('admin-voucher-list'); if(!tbody) return; 
    const vouchers = globalSettings.vouchers || {}; const keys = Object.keys(vouchers);
    if(keys.length === 0) { tbody.innerHTML = `<tr><td colspan="4" class="text-center py-4 text-dark-2 italic">Belum ada voucher aktif.</td></tr>`; return; }
    tbody.innerHTML = keys.map(k => { 
        const v = vouchers[k]; const label = v.type === 'percent' ? `${v.value}%` : toRupiah(v.value); 
        return `
        <tr class="hover:bg-dark-7 border-b border-dark-5 transition-colors">
            <td class="py-3 px-4 font-bold text-pink-400">${escapeHTML(k)}</td>
            <td class="py-3 px-4 text-dark-1 uppercase text-[10px] font-bold">${v.type}</td>
            <td class="py-3 px-4 font-black text-gray-100">${label}</td>
            <td class="py-3 px-4 text-right">
                <button type="button" onclick="window.hapusVoucherAdmin('${k}')" class="px-3 py-1.5 bg-red-900/30 text-red-400 font-bold rounded-lg hover:bg-red-900/50 text-xs transition-colors">Hapus</button>
            </td>
        </tr>`; 
    }).join('');
}

function showActiveMemberUI() { 
    document.getElementById('member-select-zone')?.classList.add('hidden'); 
    document.getElementById('member-active-zone')?.classList.remove('hidden'); 
    document.getElementById('btn-remove-member')?.classList.remove('hidden'); 
    if(document.getElementById('member-active-name')) document.getElementById('member-active-name').textContent = `⭐ ${escapeHTML(activeMember.nama).toUpperCase()}`; 
    if(document.getElementById('member-active-points')) document.getElementById('member-active-points').textContent = `Poin: ${activeMember.poin || 0} | Hutang: ${toRupiah(activeMember.hutang||0)}`; 
    renderKeranjang(); 
}

window.switchCartTab = (tabName) => {
    const paneList = document.getElementById('cart-pane-list'), panePay = document.getElementById('cart-pane-pay');
    const btnList = document.getElementById('tab-cart-list-btn'), btnPay = document.getElementById('tab-cart-pay-btn');
    if(tabName === 'list') {
        paneList?.classList.remove('hidden'); paneList?.classList.add('flex'); panePay?.classList.add('hidden'); panePay?.classList.remove('flex');
        if(btnList) btnList.className = "flex-1 py-2.5 text-[11px] uppercase tracking-wider font-bold text-mantine-blue border-b-2 border-mantine-blue transition-colors focus:outline-none"; 
        if(btnPay) btnPay.className = "flex-1 py-2.5 text-[11px] uppercase tracking-wider font-bold text-dark-2 border-b-2 border-transparent hover:text-gray-200 transition-colors focus:outline-none";
    } else {
        panePay?.classList.remove('hidden'); panePay?.classList.add('flex'); paneList?.classList.add('hidden'); paneList?.classList.remove('flex');
        if(btnPay) btnPay.className = "flex-1 py-2.5 text-[11px] uppercase tracking-wider font-bold text-mantine-blue border-b-2 border-mantine-blue transition-colors focus:outline-none"; 
        if(btnList) btnList.className = "flex-1 py-2.5 text-[11px] uppercase tracking-wider font-bold text-dark-2 border-b-2 border-transparent hover:text-gray-200 transition-colors focus:outline-none";
        if(selectedPaymentMethod === 'Tunai') setTimeout(() => document.getElementById('cash-paid')?.focus(), 100);
    }
};

// ==========================================
// 5. OFFLINE SYNC (INDEXED DB)
// ==========================================
const OFFLINE_DB_NAME = "POS_Offline_Database", OFFLINE_STORE_NAME = "pending_transactions";

function initIndexedDB() { 
    return new Promise((resolve, reject) => { 
        const request = indexedDB.open(OFFLINE_DB_NAME, 1); 
        request.onupgradeneeded = (e) => { 
            const idb = e.target.result; 
            if (!idb.objectStoreNames.contains(OFFLINE_STORE_NAME)) { idb.createObjectStore(OFFLINE_STORE_NAME, { keyPath: "localId", autoIncrement: true }); }
        }; 
        request.onsuccess = (e) => resolve(e.target.result); 
        request.onerror = (e) => reject(e.target.error); 
    }); 
}

async function loadOfflineTransactions() { 
    if (!window.indexedDB) return []; 
    try { 
        const idb = await initIndexedDB(); 
        const req = idb.transaction(OFFLINE_STORE_NAME, "readonly").objectStore(OFFLINE_STORE_NAME).getAll(); 
        return new Promise(resolve => { req.onsuccess = () => resolve(req.result || []); req.onerror = () => resolve([]); }); 
    } catch(e) { return []; } 
}

async function saveTransactionOffline(saleData) { 
    try { 
        const idb = await initIndexedDB(); const tx = idb.transaction(OFFLINE_STORE_NAME, "readwrite"); 
        tx.objectStore(OFFLINE_STORE_NAME).add(saleData); await tx.complete; return true; 
    } catch (e) { return false; } 
}

async function syncOfflineTransactions() {
    if (!navigator.onLine || isSyncingOffline) return;
    const indicator = document.getElementById('offline-indicator'); if (indicator) indicator.classList.add('hidden');
    isSyncingOffline = true;
    try {
        const idb = await initIndexedDB(); 
        const request = idb.transaction(OFFLINE_STORE_NAME, "readonly").objectStore(OFFLINE_STORE_NAME).getAll();
        request.onsuccess = async () => {
            const pendingSales = request.result; let successCount = 0; let syncedIds = [];
            if (pendingSales && pendingSales.length > 0) {
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
                    } catch (e) { console.error(e); }
                }
            }
            if (syncedIds.length > 0) { 
                const deleteTx = idb.transaction(OFFLINE_STORE_NAME, "readwrite"); 
                syncedIds.forEach(id => deleteTx.objectStore(OFFLINE_STORE_NAME).delete(id)); 
                await deleteTx.complete; 
            }
            const offlineLogs = JSON.parse(localStorage.getItem('pos_offline_logs') || '[]');
            if (offlineLogs.length > 0) { 
                let failedLogs = []; 
                for (const log of offlineLogs) { 
                    try { log.timestamp = log.timestamp ? new Date(log.timestamp) : serverTimestamp(); await addDoc(auditLogsRef, log); } 
                    catch(e) { failedLogs.push(log); } 
                } 
                if(failedLogs.length > 0) localStorage.setItem('pos_offline_logs', JSON.stringify(failedLogs)); else localStorage.removeItem('pos_offline_logs'); 
            }
            if(successCount > 0) { await logActivity("SYNC_OFFLINE", `Sukses sinkron ${successCount} transaksi.`); alert(`Koneksi Stabil! ${successCount} data offline berhasil diunggah.`); }
            applyFiltersAndStats(); isSyncingOffline = false;
        }; 
        request.onerror = () => { isSyncingOffline = false; };
    } catch(e) { isSyncingOffline = false; }
}

window.addEventListener('online', syncOfflineTransactions);
window.addEventListener('offline', () => { const indicator = document.getElementById('offline-indicator'); if (indicator) indicator.classList.remove('hidden'); applyFiltersAndStats(); });

// ==========================================
// 6. EVENT LISTENER & TRANSAKSI
// ==========================================
async function logActivity(actionType, actionDetails) {
    const userEmail = auth.currentUser ? auth.currentUser.email.split('@')[0] : "Sistem"; const logObj = { user: userEmail, action: actionType, detail: actionDetails };
    if (!navigator.onLine) { logObj.timestamp = new Date().toISOString(); const offlineLogs = JSON.parse(localStorage.getItem('pos_offline_logs') || '[]'); offlineLogs.push(logObj); localStorage.setItem('pos_offline_logs', JSON.stringify(offlineLogs)); return; }
    try { logObj.timestamp = serverTimestamp(); await addDoc(auditLogsRef, logObj); } catch (e) {}
}

let barcodeBuffer = "", barcodeTimeout = null, isProcessingBarcode = false;
document.addEventListener("keydown", async (e) => {
    if (e.target.tagName === 'INPUT' && e.target.id !== 'kasir-search') return;
    if (e.key === 'Enter' && barcodeBuffer.length > 0) {
        e.preventDefault(); if(isProcessingBarcode) return; isProcessingBarcode = true;
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
            const service = await server.getPrimaryService('000018f0-0000-1000-8000-00805f9b34fb'); bluetoothPrintCharacteristic = await service.getCharacteristic('00002af1-0000-1000-8000-00805f9b34fb');
            document.getElementById('btn-connect-printer').classList.replace('text-dark-1', 'text-green-400'); document.getElementById('btn-connect-printer').innerHTML = "<span class='text-sm'>🖨️</span> BT Aktif";
        } catch(e) { console.log("Generic service gagal. Menggunakan Print HTML"); }
    } catch (e) { alert("Gagal koneksi Bluetooth."); }
});

async function printDirectBluetooth(text) {
    if (!bluetoothPrintCharacteristic) return false;
    try { const encoder = new TextEncoder(); const data = encoder.encode("\x1B\x40" + text + "\n\n\n\n"); const MAX_CHUNK = 100; for (let i = 0; i < data.length; i += MAX_CHUNK) { await bluetoothPrintCharacteristic.writeValue(data.slice(i, i + MAX_CHUNK)); } return true; } catch (e) { return false; }
}

onAuthStateChanged(auth, async (user) => {
    document.getElementById('auth-loading')?.classList.add('hidden');
    if (user) {
        currentUserId = user.uid; document.getElementById('login-screen')?.classList.add('hidden'); document.getElementById('app-screen')?.classList.remove('hidden');
        renderKatalogKasir(); renderGudangList(); renderKeranjang(); 
        if (navigator.onLine) {
            try { const userDocSnap = await getDoc(doc(db, "pengguna", user.uid)); if (userDocSnap.exists()) { currentUserRole = userDocSnap.data().role || "kasir"; localStorage.setItem("pos_user_role", currentUserRole); } else { currentUserRole = "kasir"; await setDoc(doc(db, "pengguna", user.uid), { email: user.email, role: "kasir", nama: user.email.split('@')[0] }); } } catch(e) { currentUserRole = localStorage.getItem("pos_user_role") || "kasir"; }
        } else { currentUserRole = localStorage.getItem("pos_user_role") || "kasir"; }
        stopRealtimeListeners(); applyRoleAccess(); initRealtimeListeners(); checkActiveShift(user.uid); updateHoldCountBadge(); syncOfflineTransactions();
        if(activeMember) showActiveMemberUI(); if(!navigator.onLine) renderPiutangList();
    } else { 
        document.getElementById('app-screen')?.classList.add('hidden'); document.getElementById('login-screen')?.classList.remove('hidden'); stopRealtimeListeners(); 
    }
});

document.getElementById('login-form')?.addEventListener('submit', async (e) => {
    e.preventDefault(); if (!navigator.onLine) return alert("Peringatan: Koneksi internet dibutuhkan untuk masuk!");
    try { await signInWithEmailAndPassword(auth, document.getElementById('login-email').value.trim(), document.getElementById('login-password').value); e.target.reset(); } catch (e) { alert("Login Gagal!"); }
});

function matikanSemuaListener() {
    if (typeof unsubscribeItems === 'function') unsubscribeItems(); if (typeof unsubscribeSales === 'function') unsubscribeSales();
    if (typeof unsubscribeMembers === 'function') unsubscribeMembers(); if (typeof unsubscribeActiveShift === 'function') unsubscribeActiveShift();
    if (typeof unsubscribeShifts === 'function') unsubscribeShifts(); if (typeof unsubscribeAudit === 'function') unsubscribeAudit();
    if (typeof unsubscribePemasok === 'function') unsubscribePemasok(); if (typeof unsubscribeSettings === 'function') unsubscribeSettings();
}

document.getElementById('btn-logout')?.addEventListener('click', async () => { 
    if (activeShiftSession) return alert("Tutup shift kasir sebelum keluar!");
    if(confirm("Keluar dari sistem?")) { matikanSemuaListener(); try { await signOut(auth); } catch (e) {} finally { sessionStorage.removeItem('pos_admin_authorized'); localStorage.clear(); location.reload(); } } 
});

['tab-dashboard-btn', 'tab-kasir-btn', 'tab-gudang-btn', 'tab-pemasok-btn', 'tab-piutang-btn', 'tab-riwayat-btn', 'tab-pengaturan-btn'].forEach(btnId => {
    document.getElementById(btnId)?.addEventListener('click', () => { switchTab(btnId.replace('tab-', '').replace('-btn', '')); });
});

function switchTab(id) {
    const tabsBtns = document.querySelectorAll('.nav-tab'); const contents = document.querySelectorAll('.tab-content');
    contents.forEach(c => c.classList.add('hidden')); tabsBtns.forEach(t => { t.classList.remove('border-b-2', 'border-mantine-blue', 'text-mantine-blue'); t.classList.add('border-transparent', 'text-dark-1'); });
    document.getElementById(`tab-${id}`)?.classList.remove('hidden');
    const targetBtn = document.getElementById(`tab-${id}-btn`); if(targetBtn) { targetBtn.classList.remove('border-transparent', 'text-dark-1'); targetBtn.classList.add('border-b-2', 'border-mantine-blue', 'text-mantine-blue'); }
    if(id === 'piutang') renderPiutangList(); if(id === 'dashboard' && chartInstance) setTimeout(() => chartInstance.update(), 100);
}

function applyRoleAccess() {
    ['tab-dashboard-btn', 'tab-gudang-btn', 'tab-pemasok-btn', 'tab-pengaturan-btn', 'admin-shift-log-section'].forEach(id => { const el = document.getElementById(id); if (el) el.classList.toggle('hidden', currentUserRole !== "admin"); });
    switchTab(currentUserRole === "admin" ? 'dashboard' : 'kasir');
}

function checkActiveShift(uid) {
    if (unsubscribeActiveShift) { unsubscribeActiveShift(); unsubscribeActiveShift = null; }
    unsubscribeActiveShift = onSnapshot(query(shiftsRef, where("userId", "==", uid), where("status", "==", "buka"), limit(1)), (snapshot) => {
        if (!snapshot.empty) { snapshot.forEach(doc => { activeShiftSession = { id: doc.id, ...doc.data() }; }); localStorage.setItem("pos_cached_shift", JSON.stringify(activeShiftSession)); updateShiftUI(true); } else if(navigator.onLine) { activeShiftSession = null; localStorage.removeItem("pos_cached_shift"); updateShiftUI(false); }
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
        e.preventDefault(); if (!navigator.onLine) return alert("Peringatan: Koneksi internet dibutuhkan.");
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
        e.preventDefault(); if (!navigator.onLine) return alert("Peringatan: Koneksi internet dibutuhkan.");
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

window.tambahVoucherAdmin = async () => {
    const code = document.getElementById('new-voucher-code')?.value.trim().toUpperCase(); const type = document.getElementById('new-voucher-type')?.value; const val = parseInputRibuan(document.getElementById('new-voucher-value')?.value);
    if(!code || isNaN(val) || val <= 0) return alert("Data voucher tidak valid!");
    let currentVouchers = globalSettings.vouchers || {}; currentVouchers[code] = { type: type, value: val };
    try { await setDoc(doc(db, "pengaturan", "global"), { vouchers: currentVouchers }, { merge: true }); if(document.getElementById('new-voucher-code')) document.getElementById('new-voucher-code').value = ""; if(document.getElementById('new-voucher-value')) document.getElementById('new-voucher-value').value = ""; alert("Voucher berhasil ditambahkan!"); } catch(e) { alert("Gagal menyimpan voucher."); }
};

window.hapusVoucherAdmin = async (code) => {
    if(!confirm(`Hapus voucher ${code}?`)) return; let currentVouchers = globalSettings.vouchers || {}; delete currentVouchers[code];
    try { await setDoc(doc(db, "pengaturan", "global"), { vouchers: currentVouchers }, { merge: true }); } catch(e) { alert("Gagal menghapus voucher."); }
};

window.setQuickCash = (amount) => {
    const cashInput = document.getElementById('cash-paid'); if (!cashInput) return;
    if (amount === 'pas') { cashInput.value = formatInputRibuan(globalGrandTotal); } else if (amount === 'clear') { cashInput.value = ""; } else { cashInput.value = formatInputRibuan(amount); }
    hitungUangKembalian();
};

document.getElementById('btn-checkout')?.addEventListener('click', async (e) => {
    const btnCheckout = e.currentTarget; if(btnCheckout.disabled || keranjang.length === 0 || !activeShiftSession) return;
    btnCheckout.disabled = true; btnCheckout.textContent = "MEMPROSES...";

    let totalModalHPP = 0; keranjang.forEach(item => { totalModalHPP += ((item.cost || 0) * item.qty); });
    const totalProfit = (globalGrandTotal - globalTaxAmount - globalServiceAmount) - totalModalHPP; 
    let tunaiMasukLaci = 0;

    const trxData = { 
        id: "TRX-" + Date.now().toString().slice(-6), items: [...keranjang], subtotal: globalSubtotal, diskon: globalDiskon, pajak: globalTaxAmount, serviceCharge: globalServiceAmount, totalAkhir: globalGrandTotal, totalModal: totalModalHPP, profit: totalProfit,
        namaKasir: (auth.currentUser ? auth.currentUser.email.split('@')[0] : 'Sistem'), memberId: activeMember ? activeMember.id : null, memberName: activeMember ? activeMember.nama : null, voucherDigunakan: appliedVoucher ? document.getElementById('voucher-code')?.value.toUpperCase() : null, shiftId: activeShiftSession.id
    };

    if (isSplitPayment) {
        trxData.metodePembayaran = `Split (${splitDetails.method1} & ${splitDetails.method2})`; trxData.uangBayar = splitDetails.amount1 + splitDetails.amount2; trxData.kembalian = splitDetails.kembalian; trxData.splitDetails = splitDetails;
        let masukLaciSplit = 0; if(splitDetails.method1 === 'Tunai') masukLaciSplit += splitDetails.amount1; if(splitDetails.method2 === 'Tunai') masukLaciSplit += splitDetails.amount2;
        if (trxData.kembalian > 0 && masukLaciSplit > 0) masukLaciSplit -= trxData.kembalian; tunaiMasukLaci = Math.max(0, masukLaciSplit);
    } else if (selectedPaymentMethod === 'Kasbon') {
        trxData.metodePembayaran = "Kasbon"; trxData.uangBayar = 0; trxData.kembalian = 0;
    } else if (selectedPaymentMethod === 'Tunai') {
        trxData.metodePembayaran = "Tunai"; trxData.uangBayar = Math.max(0, parseInputRibuan(document.getElementById('cash-paid')?.value)); trxData.kembalian = trxData.uangBayar - globalGrandTotal; tunaiMasukLaci = globalGrandTotal;
    } else {
        trxData.metodePembayaran = selectedPaymentMethod; trxData.uangBayar = globalGrandTotal; trxData.kembalian = 0;
    }

    let isOnlineSuccess = false;
    try {
        if (navigator.onLine) {
            try {
                trxData.waktu = serverTimestamp(); trxData.waktuLokal = new Date().toISOString(); await addDoc(salesRef, trxData);
                for (const item of trxData.items) { try { await updateDoc(doc(db, "barang", item.id), { stok: increment(-item.qty) }); } catch(e) {} }
                if (selectedPaymentMethod === 'Kasbon' && activeMember) { await updateDoc(doc(db, "members", activeMember.id), { hutang: increment(globalGrandTotal) }); } 
                else if (activeMember && selectedPaymentMethod !== 'Kasbon') { const addPoin = Math.floor(globalGrandTotal / (globalSettings.kelipatanPoin || 10000)); if (addPoin > 0) await updateDoc(doc(db, "members", activeMember.id), { poin: increment(addPoin) }); }
                await updateDoc(doc(db, "shift", activeShiftSession.id), { totalPenjualan: increment(globalGrandTotal), totalTunai: increment(tunaiMasukLaci) }); isOnlineSuccess = true;
            } catch(e) { console.error(e); }
        }

        if (!isOnlineSuccess) {
            trxData.waktuLokal = new Date().toISOString(); trxData.isOfflinePending = true; trxData.tunaiMasukLaci = tunaiMasukLaci;
            const isSaved = await saveTransactionOffline(trxData); if (!isSaved) throw new Error("Memori Penuh.");
            for (const item of trxData.items) { const found = databaseBarang.find(x => x.id === item.id); if (found) found.stok = Math.max(0, (found.stok||0) - item.qty); } localStorage.setItem("pos_cached_items", JSON.stringify(databaseBarang));
            if (selectedPaymentMethod === 'Kasbon' && activeMember) { const mIdx = memberDataAll.findIndex(m => m.id === activeMember.id); if(mIdx > -1) { memberDataAll[mIdx].hutang = (memberDataAll[mIdx].hutang||0) + globalGrandTotal; localStorage.setItem("pos_cached_members", JSON.stringify(memberDataAll)); } } 
            else if (activeMember && selectedPaymentMethod !== 'Kasbon') { const mIdx = memberDataAll.findIndex(m => m.id === activeMember.id); const addPoin = Math.floor(globalGrandTotal / (globalSettings.kelipatanPoin || 10000)); if(mIdx > -1 && addPoin > 0) { memberDataAll[mIdx].poin = (memberDataAll[mIdx].poin||0) + addPoin; localStorage.setItem("pos_cached_members", JSON.stringify(memberDataAll)); } }
            activeShiftSession.totalPenjualan += globalGrandTotal; activeShiftSession.totalTunai += tunaiMasukLaci; localStorage.setItem("pos_cached_shift", JSON.stringify(activeShiftSession)); updateShiftUI(true); renderKatalogKasir();
        }

        const isBluetoothPrinted = await printDirectBluetooth(formatStrukBT(trxData)); if (!isBluetoothPrinted) { cetakStrukThermal(trxData); }
        keranjang = []; localStorage.removeItem("pos_recovery_cart"); appliedVoucher = null; if(document.getElementById('voucher-code')) document.getElementById('voucher-code').value = ""; if(document.getElementById('cash-paid')) document.getElementById('cash-paid').value = "";
        document.getElementById('pay-method-cash')?.click(); document.getElementById('btn-remove-member')?.click(); renderKeranjang(); applyFiltersAndStats(); window.switchCartTab('list');
        
    } catch(e) { alert("GAGAL MEMPROSES TRANSAKSI: " + e.message); } finally { btnCheckout.disabled = false; btnCheckout.textContent = "Selesaikan Bayar"; }
});

function padCenter(str, len) { if(str.length >= len) return str; const left = Math.floor((len - str.length) / 2); const right = len - str.length - left; return " ".repeat(left) + str + " ".repeat(right); }

function formatStrukBT(data) {
    const lineLen = globalSettings.printerSize || 32; const lineChar = "-".repeat(lineLen); const eqChar = "=".repeat(lineLen);
    let struk = eqChar + "\n" + padCenter(globalSettings.namaToko, lineLen) + "\n" + padCenter(globalSettings.alamatToko, lineLen) + "\n" + lineChar + "\n";
    struk += `ID   : ${data.id}\nWaktu: ${new Date().toLocaleString('id-ID')}\nKasir: ${data.namaKasir.toUpperCase()}\n` + lineChar + "\n";
    data.items.forEach(i => { struk += `${i.nama}\n${i.qty} x ${toRupiah(i.harga)} = ${toRupiah(i.qty * i.harga)}\n`; });
    struk += lineChar + "\n" + `Subtotal : ${toRupiah(data.subtotal)}\nDiskon   : -${toRupiah(data.diskon)}\n`;
    if ((data.pajak || 0) > 0) struk += `Pajak    : +${toRupiah(data.pajak)}\n`;
    if ((data.serviceCharge || 0) > 0) struk += `Service  : +${toRupiah(data.serviceCharge)}\n`;
    struk += `TOTAL    : ${toRupiah(data.totalAkhir)}\nBayar    : ${toRupiah(data.uangBayar)}\nKembali  : ${toRupiah(data.kembalian)}\n`;
    if(data.memberName) struk += `\nMember   : ${data.memberName.toUpperCase()}\n`;
    struk += lineChar + "\n" + padCenter(globalSettings.footerStruk, lineLen) + "\n\n\n\n";
    return struk;
}

function cetakStrukThermal(data) {
    const printArea = document.getElementById('print-area'); if(!printArea) return; const tglStruk = data.waktuLokal ? new Date(data.waktuLokal) : new Date();
    printArea.innerHTML = `<div style="font-family:monospace; color:black; max-width:300px; margin:0 auto; padding:10px;"><div style="text-align:center; margin-bottom:10px;"><h3 style="margin:0; font-size:16px; font-weight:bold;">${escapeHTML(globalSettings.namaToko)}</h3><p style="margin:2px 0; font-size:10px;">${escapeHTML(globalSettings.alamatToko)}</p></div><div style="border-top:1px dashed black; margin:8px 0;"></div><div style="font-size:10px; margin-bottom:8px;"><div style="display:flex; justify-content:space-between;"><span>Trx ID:</span> <span>${data.id || 'OFFLINE'}</span></div><div style="display:flex; justify-content:space-between;"><span>Waktu:</span> <span>${tglStruk.toLocaleString('id-ID')}</span></div><div style="display:flex; justify-content:space-between;"><span>Kasir:</span> <span>${escapeHTML(data.namaKasir ? data.namaKasir.toUpperCase() : 'SISTEM')}</span></div></div><div style="border-top:1px dashed black; margin:8px 0;"></div><div style="margin-bottom:8px;">${(data.items||[]).map(i => `<div style="margin-bottom:4px;"><div style="font-size:10px; font-weight:bold;">${escapeHTML(i.nama||'Item')}</div><div style="display:flex; justify-content:space-between; font-size:10px;"><span>${i.qty} x ${toRupiah(i.harga)}</span><span>${toRupiah((i.harga||0) * i.qty)}</span></div></div>`).join('')}</div><div style="border-top:1px dashed black; margin:8px 0;"></div><div style="font-size:10px;"><div style="display:flex; justify-content:space-between; margin-bottom:2px;"><span>Subtotal:</span><span>${toRupiah(data.subtotal)}</span></div><div style="display:flex; justify-content:space-between; margin-bottom:2px;"><span>Diskon:</span><span>-${toRupiah(data.diskon)}</span></div>${(data.pajak || 0) > 0 ? `<div style="display:flex; justify-content:space-between; margin-bottom:2px;"><span>Pajak:</span><span>+${toRupiah(data.pajak)}</span></div>` : ''}${(data.serviceCharge || 0) > 0 ? `<div style="display:flex; justify-content:space-between; margin-bottom:2px;"><span>Service:</span><span>+${toRupiah(data.serviceCharge)}</span></div>` : ''}<div style="display:flex; justify-content:space-between; font-weight:bold; font-size:12px; margin-top:4px; margin-bottom:4px;"><span>Total:</span><span>${toRupiah(data.totalAkhir)}</span></div><div style="border-top:1px dashed black; margin:6px 0;"></div><div style="display:flex; justify-content:space-between; margin-bottom:2px;"><span>Bayar (${escapeHTML(data.metodePembayaran||'Tunai')}):</span><span>${toRupiah(data.uangBayar)}</span></div><div style="display:flex; justify-content:space-between;"><span>Kembali:</span><span>${toRupiah(data.kembalian)}</span></div></div>${data.memberName ? `<div style="border-top:1px dashed black; margin:8px 0;"></div><div style="font-size:10px; text-align:center;"><p style="margin:2px 0;">Member: <strong>${escapeHTML(data.memberName.toUpperCase())}</strong></p></div>` : ''}<div style="border-top:1px dashed black; margin:8px 0;"></div><div style="text-align:center; font-size:10px; margin-top:10px;"><p style="margin:0; font-weight:bold;">${escapeHTML(globalSettings.footerStruk)}</p></div></div>`;
    printArea.classList.remove('hidden'); window.print(); printArea.classList.add('hidden');
}

const itemForm = document.getElementById('item-form');
itemForm?.addEventListener('submit', async (e) => {
    e.preventDefault(); if (!navigator.onLine) return alert("Peringatan: Butuh internet.");
    const idInput = document.getElementById('item-id'); const barcodeInputEl = document.getElementById('item-barcode');
    const id = idInput ? idInput.value : ''; const barcodeInput = barcodeInputEl ? barcodeInputEl.value.trim() : '';
    if (barcodeInput !== "") { const isDuplicate = databaseBarang.find(x => (x.barcode || '').toLowerCase() === barcodeInput.toLowerCase() && x.id !== id); if (isDuplicate) return alert(`Barcode sudah dipakai: ${isDuplicate.nama}`); }
    const btnSubmit = document.getElementById('btn-submit'); let origText = ""; if(btnSubmit) { origText = btnSubmit.textContent; btnSubmit.disabled = true; btnSubmit.textContent = "Menyimpan..."; }
    try {
        const rawCost = Math.max(0, parseInputRibuan(document.getElementById('item-cost')?.value)); const rawHrg = Math.max(0, parseInputRibuan(document.getElementById('item-price')?.value)); const rawStk = Math.max(0, parseInputRibuan(document.getElementById('item-stock')?.value));
        const nName = document.getElementById('item-name')?.value.trim() || 'Barang Baru'; const nCat = document.getElementById('item-category')?.value.trim() || 'Umum'; const supId = document.getElementById('item-supplier')?.value || ""; const nNotes = document.getElementById('item-notes')?.value.trim() || '';
        const data = { barcode: barcodeInput, nama: nName, kategori: nCat, catatan: nNotes, cost: Math.round(rawCost), harga: Math.round(rawHrg), stok: rawStk, supplierId: supId };
        if(id) { await updateDoc(doc(db, "barang", id), data); } else { await addDoc(itemsRef, data); }
        document.getElementById('item-form')?.reset(); if(document.getElementById('item-id')) document.getElementById('item-id').value = ""; document.getElementById('btn-cancel')?.classList.add('hidden');
    } catch(err) {} finally { if(btnSubmit) { btnSubmit.disabled = false; btnSubmit.textContent = origText; } }
});

window.duplikatBarang = (id) => {
    const item = databaseBarang.find(x => x.id === id); if (!item) return;
    if(document.getElementById('item-id')) document.getElementById('item-id').value = ""; 
    if(document.getElementById('item-barcode')) document.getElementById('item-barcode').value = ""; 
    if(document.getElementById('item-name')) document.getElementById('item-name').value = item.nama + " (Copy)"; 
    if(document.getElementById('item-category')) document.getElementById('item-category').value = item.kategori || "Umum"; 
    if(document.getElementById('item-notes')) document.getElementById('item-notes').value = item.catatan || ""; 
    if(document.getElementById('item-cost')) document.getElementById('item-cost').value = formatInputRibuan(item.cost); 
    if(document.getElementById('item-price')) document.getElementById('item-price').value = formatInputRibuan(item.harga); 
    if(document.getElementById('item-stock')) document.getElementById('item-stock').value = formatInputRibuan(item.stok);
    const supSelect = document.getElementById('item-supplier'); if (supSelect) supSelect.value = item.supplierId || "";
    document.getElementById('btn-cancel')?.classList.remove('hidden'); window.scrollTo({ top: 0, behavior: 'smooth' }); setTimeout(() => { const nameInput = document.getElementById('item-name'); if(nameInput) { nameInput.focus(); nameInput.select(); } }, 100);
};

window.editBarang = (id) => {
    const item = databaseBarang.find(x => x.id === id); if (!item) return;
    if(document.getElementById('item-id')) document.getElementById('item-id').value = item.id; 
    if(document.getElementById('item-barcode')) document.getElementById('item-barcode').value = item.barcode || ""; 
    if(document.getElementById('item-name')) document.getElementById('item-name').value = item.nama; 
    if(document.getElementById('item-category')) document.getElementById('item-category').value = item.kategori || "Umum"; 
    if(document.getElementById('item-notes')) document.getElementById('item-notes').value = item.catatan || ""; 
    if(document.getElementById('item-cost')) document.getElementById('item-cost').value = formatInputRibuan(item.cost); 
    if(document.getElementById('item-price')) document.getElementById('item-price').value = formatInputRibuan(item.harga); 
    if(document.getElementById('item-stock')) document.getElementById('item-stock').value = formatInputRibuan(item.stok);
    const supSelect = document.getElementById('item-supplier'); if (supSelect) supSelect.value = item.supplierId || "";
    document.getElementById('btn-cancel')?.classList.remove('hidden'); window.scrollTo({ top: 0, behavior: 'smooth' });
};

window.hapusBarang = async (id) => { if (!navigator.onLine) return alert("Butuh internet."); const item = databaseBarang.find(x => x.id === id); if(!item) return; if(confirm(`Hapus permanen ${item.nama}?`)) { await deleteDoc(doc(db, "barang", id)); } };

document.getElementById('btn-cancel')?.addEventListener('click', () => { document.getElementById('item-form')?.reset(); if(document.getElementById('item-id')) document.getElementById('item-id').value = ""; document.getElementById('btn-cancel')?.classList.add('hidden'); });

window.tambahKeKeranjang = (id) => {
    const item = databaseBarang.find(i => i.id === id); if(!item || (item.stok||0) <= 0) return alert("Stok habis!");
    const existing = keranjang.find(k => k.id === id);
    if (existing) { if(existing.qty >= item.stok) return alert("Melebihi stok gudang maksimal!"); existing.qty++; } else { keranjang.push({ id: item.id, nama: item.nama, harga: item.harga||0, cost: item.cost||0, qty: 1 }); } 
    localStorage.setItem("pos_recovery_cart", JSON.stringify(keranjang)); renderKeranjang();
};

window.ubahQtyCart = (id, delta) => {
    const index = keranjang.findIndex(k => k.id === id); if(index === -1) return;
    if (keranjang[index].qty + delta <= 0) {
        if (sessionStorage.getItem("pos_admin_authorized") === "true") { keranjang.splice(index, 1); localStorage.setItem("pos_recovery_cart", JSON.stringify(keranjang)); renderKeranjang(); } 
        else { window.itemAkanDihapus = id; document.getElementById('pin-modal')?.classList.remove('hidden'); setTimeout(() => document.getElementById('auth-pin-input')?.focus(), 100); } return; 
    }
    const itemDb = databaseBarang.find(i => i.id === id); if (delta > 0 && itemDb && keranjang[index].qty >= (itemDb.stok||0)) return alert("Melebihi stok gudang maksimal!");
    keranjang[index].qty += delta; localStorage.setItem("pos_recovery_cart", JSON.stringify(keranjang)); renderKeranjang();
};

document.getElementById('btn-verify-pin')?.addEventListener('click', () => {
    const inputPin = document.getElementById('auth-pin-input')?.value;
    if (inputPin === (globalSettings.pinAdmin || "123456")) {
        sessionStorage.setItem("pos_admin_authorized", "true");
        if (window.itemAkanDihapus) { const index = keranjang.findIndex(k => k.id === window.itemAkanDihapus); if (index > -1) { keranjang.splice(index, 1); localStorage.setItem("pos_recovery_cart", JSON.stringify(keranjang)); renderKeranjang(); } }
        document.getElementById('pin-modal')?.classList.add('hidden'); window.itemAkanDihapus = null;
    } else { alert("PIN SALAH!"); if(document.getElementById('auth-pin-input')) document.getElementById('auth-pin-input').value = ""; }
});

document.getElementById('btn-apply-voucher')?.addEventListener('click', () => {
    const code = document.getElementById('voucher-code')?.value.trim().toUpperCase(); if (!code) return;
    const activeVouchers = globalSettings.vouchers || {};
    if (activeVouchers[code]) { appliedVoucher = activeVouchers[code]; alert(`✅ Voucher ${code} berhasil diklaim!`); hitungUangKembalian(); } 
    else { alert("❌ Kode Voucher tidak valid atau kadaluarsa."); appliedVoucher = null; document.getElementById('voucher-code').value = ""; hitungUangKembalian(); }
});

document.getElementById('btn-submit-piutang')?.addEventListener('click', async () => {
    if(!piutangAktifDipilih || !activeShiftSession) return alert("Peringatan: Sesi Shift harus aktif untuk menerima pembayaran.");
    const inputVal = Math.max(0, parseInputRibuan(document.getElementById('piutang-bayar-input')?.value));
    if(inputVal <= 0 || inputVal > piutangAktifDipilih.hutang) return alert("Nominal pelunasan tidak valid!");
    const btnSubmit = document.getElementById('btn-submit-piutang'); if(btnSubmit) btnSubmit.textContent = "...";

    if (!navigator.onLine) {
        try {
            const trxData = { waktuLokal: new Date().toISOString(), tipe: "pelunasan_piutang", totalAkhir: inputVal, profit: 0, metodePembayaran: "Pelunasan Hutang (Tunai)", namaKasir: auth.currentUser?.email.split('@')[0], memberId: piutangAktifDipilih.id, memberName: piutangAktifDipilih.nama, tunaiMasukLaci: inputVal, shiftId: activeShiftSession.id, isOfflinePending: true };
            const isSaved = await saveTransactionOffline(trxData); if (!isSaved) throw new Error("Memori Penuh.");
            const memberIndex = memberDataAll.findIndex(m => m.id === piutangAktifDipilih.id); if(memberIndex > -1) { memberDataAll[memberIndex].hutang -= inputVal; localStorage.setItem("pos_cached_members", JSON.stringify(memberDataAll)); }
            activeShiftSession.totalTunai += inputVal; localStorage.setItem("pos_cached_shift", JSON.stringify(activeShiftSession));
            alert("OFFLINE: Pelunasan dicatat lokal. Akan diunggah otomatis saat online!"); document.getElementById('bayar-piutang-modal')?.classList.add('hidden'); renderPiutangList(); updateShiftUI(true);
        } catch(e) { alert("Gagal memproses pelunasan offline."); }
        if(btnSubmit) btnSubmit.textContent = "Lunasi"; return;
    }

    try {
        await updateDoc(doc(db, "members", piutangAktifDipilih.id), { hutang: increment(-inputVal) }); await logActivity("PELUNASAN_KASBON", `Terima pelunasan Rp${inputVal} dari ${piutangAktifDipilih.nama}`); await addDoc(salesRef, { waktu: serverTimestamp(), tipe: "pelunasan_piutang", totalAkhir: inputVal, profit: 0, metodePembayaran: "Pelunasan Hutang (Tunai)", namaKasir: auth.currentUser?.email.split('@')[0], memberId: piutangAktifDipilih.id, memberName: piutangAktifDipilih.nama }); await updateDoc(doc(db, "shift", activeShiftSession.id), { totalTunai: increment(inputVal) });
        alert("Pelunasan berhasil dicatat di Laci & Z-Report!"); document.getElementById('bayar-piutang-modal')?.classList.add('hidden');
    } catch(e) { alert("Gagal memproses pelunasan."); }
    if(btnSubmit) btnSubmit.textContent = "Lunasi";
});

document.getElementById('btn-export-gudang')?.addEventListener('click', () => {
    if (databaseBarang.length === 0) return alert("Gudang kosong.");
    const dataExcel = databaseBarang.map(i => ({ 'Barcode': i.barcode || '', 'Nama Barang': i.nama || '', 'Kategori': i.kategori || 'Umum', 'Harga Modal': i.cost || 0, 'Harga Jual': i.harga || 0, 'Stok': i.stok || 0, 'Catatan': i.catatan || '' }));
    if (typeof XLSX !== 'undefined') { const worksheet = XLSX.utils.json_to_sheet(dataExcel); const workbook = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(workbook, worksheet, "Data_Gudang"); XLSX.writeFile(workbook, `Data_Gudang_${new Date().toISOString().split('T')[0]}.xlsx`); } else { alert("Pustaka Excel belum termuat."); }
});

document.getElementById('file-import-gudang')?.addEventListener('change', async (e) => {
    const file = e.target.files[0]; if (!file) return;
    if (!navigator.onLine) { alert("Membutuhkan koneksi internet untuk Import Data."); e.target.value = ""; return; }
    const btn = document.getElementById('btn-import-gudang'); const origText = btn ? btn.innerHTML : ''; if(btn) btn.innerHTML = "⏳ Memproses...";
    const reader = new FileReader();
    reader.onload = async (evt) => {
        try {
            const data = new Uint8Array(evt.target.result); const workbook = XLSX.read(data, {type: 'array'}); const sheet = workbook.Sheets[workbook.SheetNames[0]]; const jsonData = XLSX.utils.sheet_to_json(sheet);
            if (jsonData.length === 0) throw new Error("File Excel kosong.");
            let successCount = 0; let updateCount = 0;
            for (let row of jsonData) {
                const barcode = (row['Barcode'] || row['barcode'] || '').toString().trim(); const nama = row['Nama Barang'] || row['nama'] || row['Nama'] || ''; if (!nama) continue;
                const hrgModal = parseExcelNum(row['Harga Modal'] || row['cost'] || row['Cost']); const hrgJual = parseExcelNum(row['Harga Jual'] || row['harga'] || row['Harga']); const stok = parseExcelNum(row['Stok'] || row['stok'] || row['Qty']); const kategori = row['Kategori'] || row['kategori'] || 'Umum'; const catatan = row['Catatan'] || row['catatan'] || '';
                const dataObj = { barcode, nama, kategori, catatan, cost: hrgModal, harga: hrgJual, stok, supplierId: "" };
                let existingItem = null; if (barcode) { existingItem = databaseBarang.find(x => x.barcode === barcode); } else { existingItem = databaseBarang.find(x => x.nama.toLowerCase() === nama.toLowerCase()); }
                if (existingItem) { await updateDoc(doc(db, "barang", existingItem.id), dataObj); updateCount++; } else { await addDoc(itemsRef, dataObj); successCount++; }
            }
            alert(`Import Selesai!\n✅ ${successCount} Barang Baru ditambahkan.\n🔄 ${updateCount} Barang lama diperbarui.`);
        } catch (err) { alert("Gagal memproses file: " + err.message); } finally { if(btn) btn.innerHTML = origText; e.target.value = ""; }
    }; reader.readAsArrayBuffer(file);
});

document.getElementById('btn-export-excel')?.addEventListener('click', () => {
    if (!dataPenjualanTerfilter || dataPenjualanTerfilter.length === 0) return alert("Data transaksi kosong.");
    try {
        const fileNameDate = new Date().toISOString().split('T')[0];
        const dataExcel = dataPenjualanTerfilter.map(trx => { 
            const itemsStr = Array.isArray(trx.items) ? trx.items.map(i => `${i.nama||'Item'} (${i.qty}x)`).join(', ') : '';
            const waktuStr = trx.waktu && trx.waktu.seconds ? new Date(trx.waktu.seconds * 1000).toLocaleString('id-ID') : (trx.waktuLokal ? new Date(trx.waktuLokal).toLocaleString('id-ID') : '-');
            return { 'Waktu Transaksi': waktuStr, 'Kasir': trx.namaKasir || '-', 'Daftar Barang': itemsStr, 'Metode Pembayaran': trx.metodePembayaran || 'Tunai', 'Subtotal (Rp)': trx.subtotal || 0, 'Diskon (Rp)': trx.diskon || 0, 'Pajak/PPN (Rp)': trx.pajak || 0, 'Grand Total/Omset (Rp)': trx.totalAkhir || 0, 'Laba Bersih/Profit (Rp)': trx.profit || 0, 'Uang Diterima (Rp)': trx.uangBayar || 0, 'Kembalian (Rp)': trx.kembalian || 0 }; 
        });
        if (typeof XLSX !== 'undefined') { const worksheet = XLSX.utils.json_to_sheet(dataExcel); const maxCols = Object.keys(dataExcel[0] || {}).length; worksheet['!cols'] = Array(maxCols).fill({ wch: 20 }); const workbook = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(workbook, worksheet, "Laporan Penjualan"); XLSX.writeFile(workbook, `Laporan_Penjualan_${fileNameDate}.xlsx`); } else { alert("Pustaka Excel belum termuat."); }
    } catch (error) { alert("Terjadi kesalahan saat membuat file Excel."); }
});

document.getElementById('btn-backup-data')?.addEventListener('click', () => {
    try {
        if (!databaseBarang || databaseBarang.length === 0) return alert("Database barang kosong.");
        const bundlingData = { identitasSistem: "POS_ENTERPRISE_BACKUP", waktuEkspor: new Date().toISOString(), pengaturan: globalSettings, daftarBarang: databaseBarang };
        const formatDataString = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(bundlingData, null, 2)); const triggerDownload = document.createElement('a'); const tanggalSkarang = new Date().toISOString().split('T')[0];
        triggerDownload.setAttribute("href", formatDataString); triggerDownload.setAttribute("download", `CADANGAN_DATABASE_POS_${tanggalSkarang}.json`); document.body.appendChild(triggerDownload); triggerDownload.click(); triggerDownload.remove();
        alert("🎉 File cadangan JSON berhasil diunduh.");
    } catch (err) { alert("Terjadi kesalahan backup: " + err.message); }
});

document.getElementById('btn-restore-data')?.addEventListener('click', () => {
    const komponenFile = document.getElementById('input-restore-file'); if (!komponenFile?.files || komponenFile.files.length === 0) return alert("Pilih file cadangan (.json).");
    const berkas = komponenFile.files[0]; const readerBerkas = new FileReader();
    readerBerkas.onload = async (e) => {
        try {
            const hasilParse = JSON.parse(e.target.result); if (!hasilParse.daftarBarang || !Array.isArray(hasilParse.daftarBarang)) throw new Error("Format file salah.");
            if (!confirm("⚠️ PERINGATAN: Aksi ini akan menulis ulang data ke Firebase. Lanjutkan?")) return;
            alert("Memulai sinkronisasi data ke Firebase. Mohon jangan tutup halaman...");
            for (const item of hasilParse.daftarBarang) { const docId = item.id || "GEN_" + Date.now().toString() + Math.random().toString(36).substr(2, 5); await setDoc(doc(db, "barang", docId), item); }
            alert("🔄 Restorasi sukses! Sistem akan memuat ulang halaman."); window.location.reload();
        } catch (err) { alert("Gagal proses file restorasi: " + err.message); }
    }; readerBerkas.readAsText(berkas);
});

// Listener inisialisasi Realtime 
function initRealtimeListeners() {
    stopRealtimeListeners();
    unsubscribeSettings = onSnapshot(doc(db, "pengaturan", "global"), (docSnap) => {
        if (docSnap.exists()) { globalSettings = { ...globalSettings, ...docSnap.data() }; }
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
        localStorage.setItem("pos_cached_members", JSON.stringify(memberDataAll)); renderPiutangList();
    });
    if (currentUserRole === 'admin') {
        unsubscribePemasok = onSnapshot(query(collection(db, "pemasok"), orderBy("nama", "asc")), (snapshot) => {
            databasePemasok = []; snapshot.forEach(doc => databasePemasok.push({ id: doc.id, ...doc.data() })); renderPemasokList(); renderPemasokDropdown(); renderGudangList();
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
    e.preventDefault(); if (!navigator.onLine) return alert("Peringatan: Butuh internet untuk menyimpan pengaturan global.");
    const btn = document.getElementById('btn-save-settings'); const origText = btn.textContent; btn.textContent = "Menyimpan..."; btn.disabled = true;
    const newData = {
        namaToko: document.getElementById('set-nama-toko')?.value.trim() || "TOKO POS", alamatToko: document.getElementById('set-alamat-toko')?.value.trim() || "Alamat Toko",
        footerStruk: document.getElementById('set-footer-toko')?.value.trim() || "Terima Kasih", pinAdmin: document.getElementById('set-pin')?.value.trim() || "123456",
        printerSize: parseInt(document.getElementById('set-printer')?.value) || 32, batasStok: parseInt(document.getElementById('set-stok')?.value) || 5,
        kelipatanPoin: parseInt(document.getElementById('set-poin')?.value) || 10000, pajakPersen: parseFloat(document.getElementById('set-pajak')?.value) || 0,
        serviceChargePersen: parseFloat(document.getElementById('set-service')?.value) || 0, tema: document.getElementById('set-tema')?.value || "dark",
        showExport: document.getElementById('set-export')?.checked ?? true, payNonCash: document.getElementById('set-noncash')?.checked ?? true,
        payKasbon: document.getElementById('set-kasbon')?.checked ?? true
    };
    try { await setDoc(doc(db, "pengaturan", "global"), newData, { merge: true }); alert("Pembaruan Sistem Berhasil Diterapkan!"); } 
    catch (err) { alert("Gagal menyimpan pengaturan: " + err.message); } 
    finally { btn.textContent = origText; btn.disabled = false; }
});