import { db, auth, itemsRef, salesRef, shiftsRef, membersRef, auditLogsRef } from './firebase-config.js';
import { addDoc, doc, getDoc, setDoc, updateDoc, deleteDoc, onSnapshot, query, orderBy, increment, serverTimestamp, where, limit } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { signInWithEmailAndPassword, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";

// ==========================================
// PENGATURAN VIP & VARIABEL GLOBAL
// ==========================================
const ADMIN_PIN = "123456"; 
window.itemAkanDihapus = null; 

let databaseBarang = [], riwayatPenjualan = [], dataPenjualanTerfilter = [], dataShiftAll = [], auditLogsData = [], memberDataAll = [];
let chartInstance = null, unsubscribeItems = null, unsubscribeSales = null, unsubscribeMembers = null;
let filterKategoriAktif = "Semua", kataKunciPencarian = "", globalSubtotal = 0, globalDiskon = 0, globalGrandTotal = 0;
let currentUserRole = "kasir", activeShiftSession = null, currentUserId = null, isSyncingOffline = false;

// Kontrol Split & Kasbon
let selectedPaymentMethod = "Tunai"; 
let isSplitPayment = false;
let splitDetails = { method1: "Tunai", amount1: 0, method2: "QRIS", amount2: 0 };
let piutangAktifDipilih = null;

// ✨ VIP FITUR: MESIN PROMO / VOUCHER
const activePromos = {
    "PROMO20": { type: "percent", value: 20 },     // Diskon 20%
    "POTONG10K": { type: "nominal", value: 10000 } // Potong Rp 10.000
};
let appliedVoucher = null;

// ✨ VIP FITUR: BLUETOOTH PRINTER DEVICE
let bluetoothPrintCharacteristic = null;

let keranjang = JSON.parse(localStorage.getItem("pos_recovery_cart") || "[]");
let activeMember = JSON.parse(localStorage.getItem("pos_recovery_member") || "null");

const toRupiah = (angka) => new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 }).format(Math.round(angka) || 0);
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

const OFFLINE_DB_NAME = "POS_Offline_Database", OFFLINE_STORE_NAME = "pending_transactions";
function initIndexedDB() { return new Promise((resolve, reject) => { const request = indexedDB.open(OFFLINE_DB_NAME, 1); request.onupgradeneeded = (e) => { const idb = e.target.result; if (!idb.objectStoreNames.contains(OFFLINE_STORE_NAME)) idb.createObjectStore(OFFLINE_STORE_NAME, { keyPath: "localId", autoIncrement: true }); }; request.onsuccess = (e) => resolve(e.target.result); request.onerror = (e) => reject(e.target.error); }); }
async function loadOfflineTransactions() { if (!window.indexedDB) return []; try { const idb = await initIndexedDB(); const req = idb.transaction(OFFLINE_STORE_NAME, "readonly").objectStore(OFFLINE_STORE_NAME).getAll(); return new Promise(resolve => { req.onsuccess = () => resolve(req.result || []); req.onerror = () => resolve([]); }); } catch(e) { return []; } }
async function saveTransactionOffline(saleData) { try { const idb = await initIndexedDB(); const tx = idb.transaction(OFFLINE_STORE_NAME, "readwrite"); tx.objectStore(OFFLINE_STORE_NAME).add(saleData); await tx.complete; return true; } catch (e) { return false; } }

async function logActivity(actionType, actionDetails) {
    const userEmail = auth.currentUser ? auth.currentUser.email.split('@')[0] : "Sistem";
    const logObj = { user: userEmail, action: actionType, detail: actionDetails };
    if (!navigator.onLine) return;
    try { logObj.timestamp = serverTimestamp(); await addDoc(auditLogsRef, logObj); } catch (e) {}
}

function playBeep() { /* Audio Beep */ }

// ✨ KONEKSI BLUETOOTH PRINTER ✨
document.getElementById('btn-connect-printer')?.addEventListener('click', async () => {
    try {
        const device = await navigator.bluetooth.requestDevice({
            // Accept any bluetooth device (Karena UUID tiap merk printer thermal beda-beda)
            acceptAllDevices: true,
            optionalServices: ['000018f0-0000-1000-8000-00805f9b34fb', 'e7810a71-73ae-499d-8c15-faa9aef0c3f2']
        });
        
        const server = await device.gatt.connect();
        alert(`Berhasil pairing dengan perangkat Bluetooth: ${device.name}\n\nCatatan: Tergantung model printer, web API mungkin memerlukan Service UUID yang spesifik.`);
        
        // Coba koneksi ke service printer generic. (Dalam production, butuh dokumentasi vendor printer Anda).
        try {
            const service = await server.getPrimaryService('000018f0-0000-1000-8000-00805f9b34fb');
            bluetoothPrintCharacteristic = await service.getCharacteristic('00002af1-0000-1000-8000-00805f9b34fb');
            document.getElementById('btn-connect-printer').classList.replace('text-dark-1', 'text-green-400');
            document.getElementById('btn-connect-printer').innerHTML = "<span>🖨️</span> BT Aktif";
        } catch(e) {
            console.log("Generic service UUID tidak ditemukan. Fallback mode.");
            // Bluetooth connect tapi Characteristic gagal, tetap bisa fallback ke HTML print
        }
    } catch (e) {
        console.error(e);
        alert("Gagal menghubungkan ke Bluetooth.\nPastikan perangkat mendukung Web Bluetooth API dan koneksi HTTPS aktif.");
    }
});

// Fungsi pembantu untuk cetak direct bluetooth (ESC/POS)
async function printDirectBluetooth(text) {
    if (!bluetoothPrintCharacteristic) return false;
    try {
        const encoder = new TextEncoder();
        const data = encoder.encode(text + "\n\n\n\n");
        // Karena BLE max 512 bytes per kirim, kita chunk:
        const MAX_CHUNK = 100;
        for (let i = 0; i < data.length; i += MAX_CHUNK) {
            await bluetoothPrintCharacteristic.writeValue(data.slice(i, i + MAX_CHUNK));
        }
        return true;
    } catch (e) {
        console.error("BT Print Error", e);
        return false;
    }
}


onAuthStateChanged(auth, async (user) => {
    document.getElementById('auth-loading')?.classList.add('hidden');
    if (user) {
        currentUserId = user.uid; 
        document.getElementById('login-screen')?.classList.add('hidden'); 
        document.getElementById('app-screen')?.classList.remove('hidden');
        renderKatalogKasir(); renderGudangList(); renderKeranjang(); 
        stopRealtimeListeners(); initRealtimeListeners(); 
        if(activeMember) showActiveMemberUI();
    } else { 
        document.getElementById('app-screen')?.classList.add('hidden'); document.getElementById('login-screen')?.classList.remove('hidden'); 
        stopRealtimeListeners(); 
    }
});

document.getElementById('login-form')?.addEventListener('submit', async (e) => {
    e.preventDefault(); 
    try { await signInWithEmailAndPassword(auth, document.getElementById('login-email').value.trim(), document.getElementById('login-password').value); e.target.reset(); } 
    catch (e) { alert("Login Gagal!"); }
});

document.getElementById('btn-logout')?.addEventListener('click', async () => { 
    if(confirm("Keluar dari sistem?")) { try { await signOut(auth); } catch (e) {} finally { localStorage.clear(); location.reload(); } } 
});

const tabsBtns = document.querySelectorAll('.nav-tab'), contents = document.querySelectorAll('.tab-content');
function switchTab(id) {
    contents.forEach(c => c.classList.add('hidden')); 
    tabsBtns.forEach(t => { t.classList.remove('border-b-2', 'border-mantine-blue', 'text-mantine-blue'); t.classList.add('border-transparent', 'text-dark-1'); });
    document.getElementById(`tab-${id}`)?.classList.remove('hidden');
    const targetBtn = document.getElementById(`tab-${id}-btn`); 
    if(targetBtn) { targetBtn.classList.remove('border-transparent', 'text-dark-1'); targetBtn.classList.add('border-b-2', 'border-mantine-blue', 'text-mantine-blue'); }
    if(id === 'piutang') renderPiutangList();
}
tabsBtns.forEach(tab => { tab.addEventListener('click', () => { switchTab(tab.id.replace('tab-', '').replace('-btn', '')); }); });
window.switchTab = switchTab;

function initRealtimeListeners() {
    stopRealtimeListeners();
    unsubscribeItems = onSnapshot(query(itemsRef, orderBy("nama", "asc")), (snapshot) => { 
        databaseBarang = []; snapshot.forEach(doc => databaseBarang.push({ id: doc.id, ...doc.data() })); renderKatalogKasir(); renderGudangList();
    });
    unsubscribeSales = onSnapshot(query(salesRef, orderBy("waktu", "desc"), limit(100)), (snapshot) => { 
        riwayatPenjualan = []; snapshot.forEach(doc => riwayatPenjualan.push({ id: doc.id, ...doc.data() })); applyFiltersAndStats(); 
    });
    unsubscribeMembers = onSnapshot(membersRef, (snapshot) => {
        memberDataAll = []; snapshot.forEach(doc => memberDataAll.push({ id: doc.id, ...doc.data() })); renderPiutangList();
    });
}

function stopRealtimeListeners() { 
    if(unsubscribeItems) unsubscribeItems(); 
    if(unsubscribeSales) unsubscribeSales(); 
    if(unsubscribeMembers) unsubscribeMembers();
}

function renderPiutangList() {
    const listContainer = document.getElementById('piutang-list'); if(!listContainer) return;
    const memberBerhutang = memberDataAll.filter(m => (m.hutang || 0) > 0).sort((a,b) => b.hutang - a.hutang);
    
    if(memberBerhutang.length === 0) { listContainer.innerHTML = `<div class="col-span-full bg-dark-8 p-6 rounded-xl border border-dark-4 text-center"><p class="text-sm font-bold text-green-400">🎉 Bersih! Tidak ada pelanggan yang berhutang.</p></div>`; return; }

    listContainer.innerHTML = memberBerhutang.map(m => `
        <div class="bg-dark-8 p-5 rounded-xl border border-dark-4 flex flex-col gap-3 relative overflow-hidden">
            <div class="absolute top-0 left-0 w-1 h-full bg-amber-500"></div>
            <div><p class="text-sm font-black text-gray-100">${escapeHTML(m.nama)}</p><p class="text-[10px] text-dark-2">HP: ${escapeHTML(m.id)}</p></div>
            <div class="bg-dark-7 p-3 rounded-lg border border-dark-4"><p class="text-[10px] font-bold text-dark-2 uppercase">Total Hutang</p><p class="text-lg font-black text-red-400">${toRupiah(m.hutang)}</p></div>
            <button onclick="window.bukaModalBayarPiutang('${m.id}')" class="w-full py-2 bg-amber-600 hover:bg-amber-500 text-white text-xs font-bold rounded-lg transition-colors">Lunasi Cicilan</button>
        </div>`).join('');
}

window.bukaModalBayarPiutang = (memberId) => {
    piutangAktifDipilih = memberDataAll.find(m => m.id === memberId);
    if(!piutangAktifDipilih) return;
    document.getElementById('piutang-member-name').textContent = piutangAktifDipilih.nama.toUpperCase();
    document.getElementById('piutang-sisa-hutang').textContent = toRupiah(piutangAktifDipilih.hutang);
    document.getElementById('piutang-bayar-input').value = "";
    document.getElementById('bayar-piutang-modal').classList.remove('hidden');
};

document.getElementById('btn-submit-piutang')?.addEventListener('click', async () => {
    if(!piutangAktifDipilih) return;
    const inputVal = parseFloat(document.getElementById('piutang-bayar-input').value) || 0;
    if(inputVal <= 0 || inputVal > piutangAktifDipilih.hutang) return alert("Nominal pelunasan tidak valid!");
    
    document.getElementById('btn-submit-piutang').textContent = "...";
    try {
        await updateDoc(doc(db, "members", piutangAktifDipilih.id), { hutang: increment(-inputVal) });
        await logActivity("PELUNASAN_KASBON", `Terima pelunasan Rp${inputVal} dari ${piutangAktifDipilih.nama}`);
        
        await addDoc(salesRef, { 
            waktu: serverTimestamp(), tipe: "pelunasan_piutang", totalAkhir: inputVal, profit: 0, 
            metodePembayaran: "Pelunasan Hutang", namaKasir: auth.currentUser?.email.split('@')[0], 
            memberId: piutangAktifDipilih.id, memberName: piutangAktifDipilih.nama 
        });

        alert("Pelunasan berhasil dicatat!");
        document.getElementById('bayar-piutang-modal').classList.add('hidden');
    } catch(e) { alert("Gagal memproses pelunasan."); }
    document.getElementById('btn-submit-piutang').textContent = "Lunasi";
});

async function applyFiltersAndStats() {
    let totalOmset = 0; let totalProfit = 0; let totalTrx = 0;
    dataPenjualanTerfilter = riwayatPenjualan.filter(sale => sale.tipe !== "pelunasan_piutang"); 

    dataPenjualanTerfilter.forEach(sale => { 
        totalOmset += Math.round(sale.totalAkhir || 0); 
        totalProfit += Math.round(sale.profit || 0); 
        totalTrx++;
    });

    const omsetDOM = document.getElementById('dash-omset'); if(omsetDOM) omsetDOM.textContent = toRupiah(totalOmset);
    const profitDOM = document.getElementById('dash-profit'); if(profitDOM) profitDOM.textContent = toRupiah(totalProfit); 
    const trxDOM = document.getElementById('dash-transaksi'); if(trxDOM) trxDOM.textContent = totalTrx;
    renderRiwayatTable();
}

// ✨ KONTROL PROMO VOUCHER ENGINE ✨
document.getElementById('btn-apply-voucher')?.addEventListener('click', () => {
    const code = document.getElementById('voucher-code').value.trim().toUpperCase();
    if (!code) return;
    
    if (activePromos[code]) {
        appliedVoucher = activePromos[code];
        alert(`✅ Voucher ${code} berhasil diklaim!`);
        hitungUangKembalian();
    } else {
        alert("❌ Kode Voucher tidak valid atau sudah kadaluarsa.");
        appliedVoucher = null;
        document.getElementById('voucher-code').value = "";
        hitungUangKembalian();
    }
});


const btnCash = document.getElementById('pay-method-cash');
const btnNonCash = document.getElementById('pay-method-noncash');
const btnKasbon = document.getElementById('pay-method-kasbon');
const btnSplit = document.getElementById('pay-method-split');

function resetPaymentUI() {
    [btnCash, btnNonCash, btnKasbon].forEach(b => { if(b) b.className = "py-2 text-[11px] font-semibold text-dark-1 hover:text-gray-100 rounded-lg transition-all"; });
    if(btnSplit) btnSplit.className = "w-full py-2 mb-3 text-[11px] font-bold text-mantine-blue bg-mantine-blue/10 hover:bg-mantine-blue/20 border border-mantine-blue/30 rounded-lg transition-all";
    document.getElementById('cash-paid').classList.add('hidden');
    document.getElementById('noncash-ref').classList.add('hidden');
    isSplitPayment = false;
}

btnCash?.addEventListener('click', () => { resetPaymentUI(); selectedPaymentMethod = 'Tunai'; btnCash.className = "py-2 text-[11px] font-semibold bg-mantine-blue text-white rounded-lg transition-all"; document.getElementById('cash-paid').classList.remove('hidden'); hitungUangKembalian(); });
btnNonCash?.addEventListener('click', () => { resetPaymentUI(); selectedPaymentMethod = 'Non-Tunai'; btnNonCash.className = "py-2 text-[11px] font-semibold bg-mantine-blue text-white rounded-lg transition-all"; document.getElementById('noncash-ref').classList.remove('hidden'); hitungUangKembalian(); });
btnKasbon?.addEventListener('click', () => { if(!activeMember) { alert("Pilih Pelanggan / Member terlebih dahulu untuk melakukan Kasbon!"); return; } resetPaymentUI(); selectedPaymentMethod = 'Kasbon'; btnKasbon.className = "py-2 text-[11px] font-semibold bg-amber-500 text-white rounded-lg transition-all"; hitungUangKembalian(); });

btnSplit?.addEventListener('click', () => {
    if(keranjang.length === 0) return alert("Keranjang masih kosong!");
    resetPaymentUI(); isSplitPayment = true;
    btnSplit.className = "w-full py-2 mb-3 text-[11px] font-bold text-white bg-mantine-blue rounded-lg shadow-lg shadow-mantine-blue/30 transition-all";
    document.getElementById('split-total-tagihan').textContent = toRupiah(globalGrandTotal);
    document.getElementById('split-amount-1').value = ""; document.getElementById('split-amount-2').value = globalGrandTotal;
    document.getElementById('split-modal').classList.remove('hidden');
});

window.batalSplitPayment = () => { document.getElementById('split-modal').classList.add('hidden'); btnCash?.click(); };

document.getElementById('split-amount-1')?.addEventListener('input', (e) => {
    const val1 = parseFloat(e.target.value) || 0;
    const sisa = Math.max(0, globalGrandTotal - val1);
    document.getElementById('split-amount-2').value = sisa;
    if(val1 > globalGrandTotal) document.getElementById('split-warning').classList.remove('hidden'); else document.getElementById('split-warning').classList.add('hidden');
});

document.getElementById('btn-save-split')?.addEventListener('click', () => {
    const v1 = parseFloat(document.getElementById('split-amount-1').value) || 0;
    const v2 = parseFloat(document.getElementById('split-amount-2').value) || 0;
    if((v1 + v2) < globalGrandTotal) return alert("Total split kurang dari jumlah tagihan!");
    
    splitDetails = { method1: document.getElementById('split-method-1').value, amount1: v1, method2: document.getElementById('split-method-2').value, amount2: v2 };
    document.getElementById('split-modal').classList.add('hidden');
    document.getElementById('btn-checkout').disabled = false;
    document.getElementById('btn-checkout').textContent = `BAYAR (SPLIT)`;
});

document.getElementById('btn-check-member')?.addEventListener('click', async () => {
    const phone = document.getElementById('member-search-input')?.value.trim(); if (!phone) return;
    const btnCheck = document.getElementById('btn-check-member'); if(btnCheck) { btnCheck.disabled = true; btnCheck.textContent = "..."; }
    try {
        const docSnap = await getDoc(doc(db, "members", phone));
        if (docSnap.exists()) { activeMember = { id: phone, ...docSnap.data() }; localStorage.setItem("pos_recovery_member", JSON.stringify(activeMember)); showActiveMemberUI(); } 
        else { alert("Member tidak ditemukan!"); }
    } catch(e) {} finally { if(btnCheck) { btnCheck.disabled = false; btnCheck.textContent = "Cari"; } }
});
document.getElementById('btn-remove-member')?.addEventListener('click', () => { activeMember = null; localStorage.removeItem("pos_recovery_member"); document.getElementById('member-select-zone')?.classList.remove('hidden'); document.getElementById('member-active-zone')?.classList.add('hidden'); document.getElementById('btn-remove-member')?.classList.add('hidden'); renderKeranjang(); btnCash?.click(); });
function showActiveMemberUI() { document.getElementById('member-select-zone')?.classList.add('hidden'); document.getElementById('member-active-zone')?.classList.remove('hidden'); document.getElementById('btn-remove-member')?.classList.remove('hidden'); document.getElementById('member-active-name').textContent = `⭐ ${escapeHTML(activeMember.nama).toUpperCase()}`; document.getElementById('member-active-points').textContent = `Poin: ${activeMember.poin || 0} | Hutang: ${toRupiah(activeMember.hutang||0)}`; renderKeranjang(); }

document.getElementById('kasir-search')?.addEventListener('input', (e) => { kataKunciPencarian = e.target.value.toLowerCase(); renderKatalogKasir(); });

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
    
    katContainer.innerHTML = filtered.map(i => `
        <div onclick="window.tambahKeKeranjang('${i.id}')" class="bg-dark-6 p-4 rounded-xl border border-dark-4 hover:border-mantine-blue cursor-pointer select-none flex flex-col justify-between active:scale-[0.98] transition-all group">
            <div>
                <div class="flex justify-between items-start gap-2 mb-2">
                    <span class="text-[10px] font-bold text-mantine-blue uppercase truncate bg-mantine-blue/10 px-2 py-1 rounded-md">${escapeHTML(i.kategori||'Umum')}</span>
                    <span class="text-[10px] px-2 py-1 rounded-md font-bold ${(i.stok||0)<=3?'bg-red-900/30 text-red-400':'bg-dark-5 text-dark-2'}">Stok: ${i.stok||0}</span>
                </div>
                <h4 class="font-bold text-xs text-gray-100 leading-snug group-hover:text-mantine-blue transition-colors">${escapeHTML(i.nama||'Item')}</h4>
            </div>
            <p class="text-sm font-black text-green-400 mt-4">${toRupiah(i.harga)}</p>
        </div>`).join('');
}

window.setFilterKategori = (cat) => { filterKategoriAktif = cat; renderKatalogKasir(); };

window.tambahKeKeranjang = (id) => {
    const item = databaseBarang.find(i => i.id === id); if(!item || (item.stok||0) <= 0) return;
    const existing = keranjang.find(k => k.id === id);
    if (existing) { if(existing.qty >= item.stok) return; existing.qty++; } 
    else { keranjang.push({ id: item.id, nama: item.nama, harga: item.harga||0, cost: item.cost||0, qty: 1 }); } 
    localStorage.setItem("pos_recovery_cart", JSON.stringify(keranjang)); renderKeranjang();
};

window.ubahQtyCart = (id, delta) => {
    const index = keranjang.findIndex(k => k.id === id); if(index === -1) return;
    if (keranjang[index].qty + delta <= 0) {
        window.itemAkanDihapus = id;
        document.getElementById('pin-modal').classList.remove('hidden');
        setTimeout(() => document.getElementById('auth-pin-input').focus(), 100); return; 
    }
    keranjang[index].qty += delta; localStorage.setItem("pos_recovery_cart", JSON.stringify(keranjang)); renderKeranjang();
};

document.getElementById('btn-verify-pin')?.addEventListener('click', () => {
    const inputPin = document.getElementById('auth-pin-input').value;
    if (inputPin === ADMIN_PIN) {
        if (window.itemAkanDihapus) {
            const index = keranjang.findIndex(k => k.id === window.itemAkanDihapus);
            if (index > -1) { keranjang.splice(index, 1); localStorage.setItem("pos_recovery_cart", JSON.stringify(keranjang)); renderKeranjang(); }
        }
        document.getElementById('pin-modal').classList.add('hidden'); window.itemAkanDihapus = null;
    } else { alert("PIN SALAH!"); document.getElementById('auth-pin-input').value = ""; }
});

function renderKeranjang() {
    const listEl = document.getElementById('cart-list');
    document.getElementById('cart-total-qty-badge').textContent = `${keranjang.reduce((a, b) => a + b.qty, 0)} Item`;
    if(keranjang.length === 0) {
        if(listEl) listEl.innerHTML = `<p class="text-xs italic text-center text-dark-3 py-10">Keranjang kosong</p>`;
        document.getElementById('btn-checkout').disabled = true; document.getElementById('cart-grand-total').textContent = "Rp 0";
        // Reset Voucher if empty
        appliedVoucher = null; document.getElementById('voucher-code').value = "";
        return;
    }
    if(listEl) listEl.innerHTML = keranjang.map(k => `
        <div class="bg-dark-6 p-4 rounded-xl border border-dark-4 flex justify-between items-center gap-3">
            <div class="flex-1"><h5 class="text-xs font-bold text-gray-100">${escapeHTML(k.nama)}</h5><p class="text-[11px] text-dark-2">${toRupiah(k.harga)} x ${k.qty}</p></div>
            <div class="flex items-center gap-2"><button onclick="window.ubahQtyCart('${k.id}', -1)" class="w-7 h-7 bg-dark-5 text-white rounded font-black">-</button><span class="text-xs font-bold px-1">${k.qty}</span><button onclick="window.ubahQtyCart('${k.id}', 1)" class="w-7 h-7 bg-dark-5 text-white rounded font-black">+</button></div>
        </div>`).join('');
    hitungUangKembalian();
}

function hitungUangKembalian() {
    if(isSplitPayment) return; 
    
    globalSubtotal = Math.round(keranjang.reduce((acc, i) => acc + ((i.harga||0) * i.qty), 0));
    
    // ✨ LOGIKA DISKON MESIN VOUCHER & MEMBER ✨
    let diskonOtomatisMember = activeMember ? Math.floor(globalSubtotal * 0.05) : 0;
    
    let diskonVoucher = 0;
    if (appliedVoucher) {
        if (appliedVoucher.type === "percent") {
            diskonVoucher = Math.floor(globalSubtotal * (appliedVoucher.value / 100));
        } else if (appliedVoucher.type === "nominal") {
            diskonVoucher = appliedVoucher.value;
        }
    }

    const rawDiskonManual = Math.round(Math.max(0, parseFloat(document.getElementById('cart-discount').value) || 0));
    
    // Total Penggabungan Diskon
    globalDiskon = Math.min(globalSubtotal, rawDiskonManual + diskonOtomatisMember + diskonVoucher);
    globalGrandTotal = Math.round(Math.max(0, globalSubtotal - globalDiskon));
    
    document.getElementById('cart-subtotal').textContent = toRupiah(globalSubtotal); 
    document.getElementById('cart-grand-total').textContent = toRupiah(globalGrandTotal);
    
    const btnCheckout = document.getElementById('btn-checkout');
    btnCheckout.textContent = "Selesaikan Transaksi";
    
    if (selectedPaymentMethod === 'Tunai') {
        const cashInput = parseFloat(document.getElementById('cash-paid').value) || 0;
        document.getElementById('cash-return').textContent = toRupiah(Math.max(0, cashInput - globalGrandTotal));
        btnCheckout.disabled = (cashInput < globalGrandTotal || keranjang.length === 0);
    } else {
        btnCheckout.disabled = (keranjang.length === 0);
    }
}

// ✨ CHECKOUT ENGINE & BLUETOOTH PRINT TRIGGER ✨
document.getElementById('btn-checkout')?.addEventListener('click', async (e) => {
    const btnCheckout = e.currentTarget;
    if(btnCheckout.disabled || keranjang.length === 0) return;
    btnCheckout.disabled = true; btnCheckout.textContent = "MEMPROSES...";

    let totalModalHPP = 0;
    keranjang.forEach(item => { totalModalHPP += ((item.cost || 0) * item.qty); });
    const totalProfit = globalGrandTotal - totalModalHPP;

    const trxData = { 
        id: "TRX-" + Date.now().toString().slice(-6),
        items: [...keranjang], subtotal: globalSubtotal, diskon: globalDiskon, totalAkhir: globalGrandTotal, totalModal: totalModalHPP, profit: totalProfit,
        namaKasir: (auth.currentUser ? auth.currentUser.email.split('@')[0] : 'Sistem'), 
        memberId: activeMember ? activeMember.id : null, memberName: activeMember ? activeMember.nama : null,
        voucherDigunakan: appliedVoucher ? document.getElementById('voucher-code').value.toUpperCase() : null
    };

    if (isSplitPayment) {
        trxData.metodePembayaran = `Split (${splitDetails.method1} & ${splitDetails.method2})`;
        trxData.uangBayar = globalGrandTotal; trxData.kembalian = 0; trxData.splitDetails = splitDetails;
    } else if (selectedPaymentMethod === 'Kasbon') {
        trxData.metodePembayaran = "Kasbon"; trxData.uangBayar = 0; trxData.kembalian = 0;
    } else if (selectedPaymentMethod === 'Tunai') {
        trxData.metodePembayaran = "Tunai"; trxData.uangBayar = parseFloat(document.getElementById('cash-paid').value) || 0; trxData.kembalian = trxData.uangBayar - globalGrandTotal;
    } else {
        trxData.metodePembayaran = selectedPaymentMethod; trxData.uangBayar = globalGrandTotal; trxData.kembalian = 0;
    }

    try {
        trxData.waktu = serverTimestamp(); trxData.waktuLokal = new Date().toISOString(); 
        await addDoc(salesRef, trxData);
        for (const item of trxData.items) { try { await updateDoc(doc(db, "barang", item.id), { stok: increment(-item.qty) }); } catch(e) {} }
        
        if (selectedPaymentMethod === 'Kasbon' && activeMember) {
            await updateDoc(doc(db, "members", activeMember.id), { hutang: increment(globalGrandTotal) });
        }

        // Eksekusi Cetak Struk
        const isBluetoothPrinted = await printDirectBluetooth(formatStrukBT(trxData));
        if (!isBluetoothPrinted) {
            // Jika Bluetooth tidak terkonek atau gagal, gunakan Fallback cetak HTML biasa
            cetakStrukThermal(trxData);
        }

        keranjang = []; localStorage.removeItem("pos_recovery_cart");
        appliedVoucher = null; document.getElementById('voucher-code').value = "";
        btnCash?.click(); renderKeranjang(); 
        
    } catch(e) { alert("GAGAL: " + e.message); } 
    finally { btnCheckout.disabled = false; btnCheckout.textContent = "Selesaikan Transaksi"; }
});

// Format Text Murni untuk Printer Bluetooth (ESC/POS Style)
function formatStrukBT(data) {
    let struk = "====== TOKO MODERN POS ======\n";
    struk += "Jl. Teknologi No.123\n";
    struk += "------------------------------\n";
    struk += `ID   : ${data.id}\n`;
    struk += `Waktu: ${new Date().toLocaleString('id-ID')}\n`;
    struk += `Kasir: ${data.namaKasir.toUpperCase()}\n`;
    struk += "------------------------------\n";
    data.items.forEach(i => {
        struk += `${i.nama}\n`;
        struk += `${i.qty} x ${i.harga} = ${i.qty * i.harga}\n`;
    });
    struk += "------------------------------\n";
    struk += `Subtotal : Rp ${data.subtotal}\n`;
    struk += `Diskon   : Rp -${data.diskon}\n`;
    struk += `TOTAL    : Rp ${data.totalAkhir}\n`;
    struk += `Bayar    : Rp ${data.uangBayar}\n`;
    struk += `Kembali  : Rp ${data.kembalian}\n`;
    if(data.memberName) struk += `\nMember   : ${data.memberName.toUpperCase()}\n`;
    struk += "------------------------------\n";
    struk += "       TERIMA KASIH!          \n";
    return struk;
}

// Fallback jika Bluetooth tidak ada
function cetakStrukThermal(data) {
    const printArea = document.getElementById('print-area');
    if(!printArea) return;
    const tglStruk = data.waktuLokal ? new Date(data.waktuLokal) : new Date();
    printArea.innerHTML = `
        <div style="font-family:monospace; color:black; max-width:300px; margin:0 auto; padding:10px;">
            <div style="text-align:center; margin-bottom:10px;"><h3 style="margin:0; font-size:16px; font-weight:bold;">Toko Modern POS</h3><p style="margin:2px 0; font-size:10px;">Jl. Teknologi No.123</p></div>
            <div style="border-top:1px dashed black; margin:8px 0;"></div>
            <div style="font-size:10px; margin-bottom:8px;"><div style="display:flex; justify-content:space-between;"><span>Trx ID:</span> <span>${data.id || 'OFFLINE'}</span></div><div style="display:flex; justify-content:space-between;"><span>Waktu:</span> <span>${tglStruk.toLocaleString('id-ID')}</span></div><div style="display:flex; justify-content:space-between;"><span>Kasir:</span> <span>${escapeHTML(data.namaKasir ? data.namaKasir.toUpperCase() : 'SISTEM')}</span></div></div>
            <div style="border-top:1px dashed black; margin:8px 0;"></div>
            <div style="margin-bottom:8px;">
                ${(data.items||[]).map(i => `<div style="margin-bottom:4px;"><div style=\"font-size:10px; font-weight:bold;\">${escapeHTML(i.nama||'Item')}</div><div style=\"display:flex; justify-content:space-between; font-size:10px;\"><span>${i.qty} x ${toRupiah(i.harga)}</span><span>${toRupiah((i.harga||0) * i.qty)}</span></div></div>`).join('')}
            </div>
            <div style="border-top:1px dashed black; margin:8px 0;"></div>
            <div style="font-size:10px;">
                <div style="display:flex; justify-content:space-between; margin-bottom:2px;"><span>Subtotal:</span><span>${toRupiah(data.subtotal)}</span></div>
                <div style="display:flex; justify-content:space-between; margin-bottom:2px;"><span>Diskon:</span><span>-${toRupiah(data.diskon)}</span></div>
                <div style="display:flex; justify-content:space-between; font-weight:bold; font-size:12px; margin-top:4px; margin-bottom:4px;"><span>Total:</span><span>${toRupiah(data.totalAkhir)}</span></div>
                <div style="border-top:1px dashed black; margin:6px 0;"></div>
                <div style="display:flex; justify-content:space-between; margin-bottom:2px;"><span>Bayar (${escapeHTML(data.metodePembayaran||'Tunai')}):</span><span>${toRupiah(data.uangBayar)}</span></div>
                <div style="display:flex; justify-content:space-between;"><span>Kembali:</span><span>${toRupiah(data.kembalian)}</span></div>
            </div>
            ${data.memberName ? `<div style=\"border-top:1px dashed black; margin:8px 0;\"></div><div style=\"font-size:10px; text-align:center;\"><p style=\"margin:2px 0;\">Member: <strong>${escapeHTML(data.memberName.toUpperCase())}</strong></p></div>` : ''}
            <div style="border-top:1px dashed black; margin:8px 0;"></div>
            <div style="text-align:center; font-size:10px; margin-top:10px;"><p style="margin:0; font-weight:bold;">Terima Kasih!</p></div>
        </div>`;
    printArea.classList.remove('hidden'); window.print(); printArea.classList.add('hidden');
}

function renderRiwayatTable() {
    const tbody = document.getElementById('riwayat-list'); if(!tbody) return;
    tbody.innerHTML = dataPenjualanTerfilter.map(trx => {
        const itemsStr = Array.isArray(trx.items) ? trx.items.map(i => `${escapeHTML(i.nama)} (${i.qty}x)`).join(', ') : '';
        return `
            <tr class="hover:bg-dark-5/40 border-b border-dark-4">
                <td class="px-6 py-4 text-xs">${formatTanggal(trx.waktu)}</td>
                <td class="px-6 py-4 text-xs text-gray-200 max-w-[200px] truncate">${trx.tipe === 'pelunasan_piutang' ? '<i>Pembayaran Kasbon</i>' : itemsStr}</td>
                <td class="px-6 py-4 text-xs font-bold"><span class="px-2 py-1 bg-dark-5 rounded border border-dark-4">${escapeHTML(trx.metodePembayaran)}</span></td>
                <td class="px-6 py-4 text-sm text-green-400 font-black">${toRupiah(trx.totalAkhir)}</td>
            </tr>`;
    }).join('');
}

// Master Gudang
const itemForm = document.getElementById('item-form');
itemForm?.addEventListener('submit', async (e) => {
    e.preventDefault(); 
    if (!navigator.onLine) return alert("Peringatan: Butuh internet untuk modifikasi gudang.");
    const idInput = document.getElementById('item-id'); const id = idInput ? idInput.value : ''; 
    const btnSubmit = document.getElementById('btn-submit'); let origText = ""; if(btnSubmit) { origText = btnSubmit.textContent; btnSubmit.disabled = true; btnSubmit.textContent = "Menyimpan..."; }
    try {
        const rawCost = parseFloat(document.getElementById('item-cost')?.value) || 0; 
        const rawHrg = parseFloat(document.getElementById('item-price')?.value) || 0; 
        const rawStk = parseInt(document.getElementById('item-stock')?.value) || 0;
        const nName = document.getElementById('item-name')?.value.trim() || 'Barang Baru';
        const data = { nama: nName, cost: Math.round(Math.max(0, rawCost)), harga: Math.round(Math.max(0, rawHrg)), stok: Math.max(0, rawStk) };
        if(id) { await updateDoc(doc(db, "barang", id), data); } else { await addDoc(itemsRef, data); }
        document.getElementById('item-form')?.reset(); document.getElementById('item-id').value = "";
    } catch(err) {} finally { if(btnSubmit) { btnSubmit.disabled = false; btnSubmit.textContent = origText; } }
});

function renderGudangList() {
    const container = document.getElementById('gudang-list'); if(!container) return;
    if(databaseBarang.length === 0) { container.innerHTML = `<p class="text-[11px] text-dark-2 italic text-center py-4">Kosong.</p>`; return; }
    container.innerHTML = databaseBarang.map(i => `
        <div class="bg-dark-6 p-4 rounded-xl border border-dark-4 flex justify-between items-center gap-3 shadow-sm hover:border-dark-3 transition-colors">
            <div><h3 class="font-bold text-gray-100 text-sm">${escapeHTML(i.nama||'Item')}</h3><div class="flex items-center gap-2 mt-1.5"><span class="text-xs font-black text-green-400">${toRupiah(i.harga)}</span> <span class="text-[10px] text-dark-2">| Modal: ${toRupiah(i.cost||0)}</span> <span class="text-[9px] font-bold ml-1 px-1.5 py-0.5 bg-dark-5 text-dark-0 rounded border border-dark-4 ${(i.stok||0)<=5?'!bg-red-900/30 !text-red-400':''}">Stok: ${i.stok||0}</span></div></div>
            <div class="flex gap-2"><button onclick="document.getElementById('item-id').value='${i.id}'; document.getElementById('item-name').value='${escapeJS(i.nama)}'; document.getElementById('item-cost').value='${i.cost||0}'; document.getElementById('item-price').value='${i.harga||0}'; document.getElementById('item-stock').value='${i.stok||0}';" class="px-3 py-2 bg-dark-5 hover:bg-dark-4 text-xs font-bold rounded-lg transition-colors">Ubah</button></div>
        </div>`).join('');
}