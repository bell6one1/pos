import { db, auth, itemsRef, salesRef, shiftsRef, membersRef, auditLogsRef } from './firebase-config.js';
import { addDoc, doc, getDoc, setDoc, updateDoc, deleteDoc, onSnapshot, query, orderBy, increment, serverTimestamp, where, limit } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { signInWithEmailAndPassword, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";

// ==========================================
// PENGATURAN VIP & VARIABEL GLOBAL
// ==========================================
const ADMIN_PIN = "123456"; 
window.itemAkanDihapus = null; 

let databaseBarang = [], riwayatPenjualan = [], dataPenjualanTerfilter = [], dataShiftAll = [], auditLogsData = [], memberDataAll = [];
let chartInstance = null, unsubscribeItems = null, unsubscribeSales = null, unsubscribeMembers = null, unsubscribeActiveShift = null, unsubscribeShifts = null, unsubscribeAudit = null;
let filterKategoriAktif = "Semua", kataKunciPencarian = "", globalSubtotal = 0, globalDiskon = 0, globalGrandTotal = 0;
let currentUserRole = "kasir", activeShiftSession = null, currentUserId = null, isSyncingOffline = false;

// Kontrol Split & Kasbon
let selectedPaymentMethod = "Tunai"; 
let isSplitPayment = false;
let splitDetails = { method1: "Tunai", amount1: 0, method2: "QRIS", amount2: 0 };
let piutangAktifDipilih = null;

// Mesin Promo / Voucher
const activePromos = { "PROMO20": { type: "percent", value: 20 }, "POTONG10K": { type: "nominal", value: 10000 } };
let appliedVoucher = null;

// Bluetooth Printer Device
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

// Barcode Scanner Event Listener
let barcodeBuffer = "", barcodeTimeout = null;
document.addEventListener("keydown", (e) => {
    if (e.target.tagName === 'INPUT' && e.target.id !== 'kasir-search') return;
    if (e.key === 'Enter' && barcodeBuffer.length > 0) {
        e.preventDefault();
        const cleanBuffer = barcodeBuffer.trim().toLowerCase();
        const b = databaseBarang.find(x => (x.barcode || '').toLowerCase() === cleanBuffer || (x.id || '').toLowerCase() === cleanBuffer);
        if (b) { 
            if ((b.stok||0) > 0) { window.tambahKeKeranjang(b.id); const searchInput = document.getElementById('kasir-search'); if (searchInput) { searchInput.value = ""; kataKunciPencarian = ""; renderKatalogKasir(); } } 
            else alert(`Stok produk [${b.nama}] habis!`);
        } else if(e.target.id === 'kasir-search') {
            alert(`Barcode tidak ditemukan.`);
            const searchInput = document.getElementById('kasir-search'); if (searchInput) searchInput.value = "";
        }
        barcodeBuffer = "";
    } else {
        if (e.key.length === 1) { barcodeBuffer += e.key; clearTimeout(barcodeTimeout); barcodeTimeout = setTimeout(() => { barcodeBuffer = ""; }, 50); }
    }
});

// Koneksi Web Bluetooth
document.getElementById('btn-connect-printer')?.addEventListener('click', async () => {
    try {
        const device = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: ['000018f0-0000-1000-8000-00805f9b34fb', 'e7810a71-73ae-499d-8c15-faa9aef0c3f2'] });
        const server = await device.gatt.connect();
        alert(`Berhasil pairing: ${device.name}`);
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
        const data = encoder.encode(text + "\n\n\n\n");
        const MAX_CHUNK = 100;
        for (let i = 0; i < data.length; i += MAX_CHUNK) { await bluetoothPrintCharacteristic.writeValue(data.slice(i, i + MAX_CHUNK)); }
        return true;
    } catch (e) { return false; }
}

onAuthStateChanged(auth, async (user) => {
    document.getElementById('auth-loading')?.classList.add('hidden');
    if (user) {
        currentUserId = user.uid; 
        document.getElementById('login-screen')?.classList.add('hidden'); 
        document.getElementById('app-screen')?.classList.remove('hidden');
        renderKatalogKasir(); renderGudangList(); renderKeranjang(); 
        
        if (navigator.onLine) {
            try {
                const userDocSnap = await getDoc(doc(db, "pengguna", user.uid));
                if (userDocSnap.exists()) { currentUserRole = userDocSnap.data().role || "kasir"; localStorage.setItem("pos_user_role", currentUserRole); } 
                else { currentUserRole = "kasir"; await setDoc(doc(db, "pengguna", user.uid), { email: user.email, role: "kasir", nama: user.email.split('@')[0] }); }
            } catch(e) { currentUserRole = localStorage.getItem("pos_user_role") || "kasir"; }
        } else { currentUserRole = localStorage.getItem("pos_user_role") || "kasir"; }
        
        stopRealtimeListeners(); applyRoleAccess(); initRealtimeListeners(); checkActiveShift(user.uid); updateHoldCountBadge(); 
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
    if (activeShiftSession) return alert("Tutup shift kasir sebelum keluar!");
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
    if(id === 'dashboard' && chartInstance) setTimeout(() => chartInstance.update(), 100);
}
tabsBtns.forEach(tab => { tab.addEventListener('click', () => { switchTab(tab.id.replace('tab-', '').replace('-btn', '')); }); });
window.switchTab = switchTab;

function applyRoleAccess() {
    ['tab-dashboard-btn', 'tab-gudang-btn', 'admin-shift-log-section'].forEach(id => { const el = document.getElementById(id); if (el) el.classList.toggle('hidden', currentUserRole !== "admin"); });
    switchTab(currentUserRole === "admin" ? 'dashboard' : 'kasir');
}

// ✨ BUG FIX 1 & 2: LOGIKA SHIFT DAN KALKULASI LACI
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
        w.innerHTML = `<div class="text-[11px] sm:text-xs text-green-400"><p class="font-bold flex items-center gap-1.5"><div class="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse"></div> Aktif: ${escapeHTML(auth.currentUser?.email.split('@')[0].toUpperCase())}</p><p class="text-green-500/80 mt-0.5 text-[10px] font-medium">Laci: ${toRupiah((activeShiftSession.modalAwal||0) + (activeShiftSession.totalTunai||0))} | Omset Total: ${toRupiah(activeShiftSession.totalPenjualan || 0)}</p></div><button onclick="window.triggerTutupShift()" class="px-4 py-2 text-[10px] font-bold text-gray-100 bg-dark-5 hover:bg-red-500 hover:text-white transition-all rounded-lg border border-dark-4 hover:border-red-600 shadow">Tutup Sesi 🔒</button>`;
        document.getElementById('kasir-core-content')?.classList.remove('opacity-40', 'pointer-events-none'); document.getElementById('kasir-cart-content')?.classList.remove('opacity-40', 'pointer-events-none');
    } else {
        w.innerHTML = `<div class="text-[11px] sm:text-xs text-dark-0"><p class="font-bold flex items-center gap-1.5 text-amber-500">🔒 Sesi Tutup</p><p class="text-dark-2 mt-0.5 text-[10px]">Buka shift dahulu untuk transaksi.</p></div><button onclick="window.triggerBukaShift()" class="px-5 py-2.5 text-[11px] font-bold text-white bg-mantine-blue hover:bg-mantine-hover rounded-lg shadow-lg shadow-mantine-blue/20 transition-all">Mulai Shift 🔑</button>`;
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
            const val = Math.round(Math.max(0, parseFloat(document.getElementById('shift-cash-input')?.value) || 0));
            // totalTunai melacak spesifik uang laci fisik
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
            const val = Math.round(Math.max(0, parseFloat(document.getElementById('shift-cash-input')?.value) || 0));
            // Bug Fix: Selisih laci hanya membandingkan Modal + Transaksi Tunai saja!
            const selisih = Math.round(val - (activeShiftSession.modalAwal + (activeShiftSession.totalTunai || 0)));
            await updateDoc(doc(db, "shift", activeShiftSession.id), { waktuTutup: serverTimestamp(), uangFisikAktual: val, selisih: selisih, status: "tutup" });
            await logActivity("SHIFT_TUTUP", `Tutup Shift. Selisih laci: ${toRupiah(selisih)}`);
            alert(`Shift Berhasil Ditutup. Selisih Laci: ${toRupiah(selisih)}`);
            document.getElementById('shift-modal')?.classList.add('hidden'); activeShiftSession = null; localStorage.removeItem("pos_cached_shift"); updateShiftUI(false);
        } catch(e) { alert("Error: " + e.message); } finally { if(btnSubmit) { btnSubmit.disabled = false; btnSubmit.textContent = "Tutup Shift"; } form.reset(); }
    };
    document.getElementById('shift-modal')?.classList.remove('hidden');
};

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
    if (currentUserRole === 'admin') {
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
    if(unsubscribeShifts) unsubscribeShifts(); if(unsubscribeAudit) unsubscribeAudit();
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

window.bukaModalBayarPiutang = (memberId) => {
    piutangAktifDipilih = memberDataAll.find(m => m.id === memberId);
    if(!piutangAktifDipilih) return;
    document.getElementById('piutang-member-name').textContent = piutangAktifDipilih.nama.toUpperCase();
    document.getElementById('piutang-sisa-hutang').textContent = toRupiah(piutangAktifDipilih.hutang);
    document.getElementById('piutang-bayar-input').value = "";
    document.getElementById('bayar-piutang-modal').classList.remove('hidden');
};

document.getElementById('btn-submit-piutang')?.addEventListener('click', async () => {
    if(!piutangAktifDipilih || !activeShiftSession) return alert("Peringatan: Sesi Shift harus aktif untuk menerima pembayaran.");
    const inputVal = parseFloat(document.getElementById('piutang-bayar-input').value) || 0;
    if(inputVal <= 0 || inputVal > piutangAktifDipilih.hutang) return alert("Nominal pelunasan tidak valid!");
    
    document.getElementById('btn-submit-piutang').textContent = "...";
    try {
        await updateDoc(doc(db, "members", piutangAktifDipilih.id), { hutang: increment(-inputVal) });
        await logActivity("PELUNASAN_KASBON", `Terima pelunasan Rp${inputVal} dari ${piutangAktifDipilih.nama}`);
        
        await addDoc(salesRef, { 
            waktu: serverTimestamp(), tipe: "pelunasan_piutang", totalAkhir: inputVal, profit: 0, 
            metodePembayaran: "Pelunasan Hutang (Tunai)", namaKasir: auth.currentUser?.email.split('@')[0], 
            memberId: piutangAktifDipilih.id, memberName: piutangAktifDipilih.nama 
        });

        // Rekam uang laci fisik bertambah
        await updateDoc(doc(db, "shift", activeShiftSession.id), { totalPenjualan: increment(inputVal), totalTunai: increment(inputVal) });

        alert("Pelunasan berhasil dicatat di Laci & Z-Report!");
        document.getElementById('bayar-piutang-modal').classList.add('hidden');
    } catch(e) { alert("Gagal memproses pelunasan."); }
    document.getElementById('btn-submit-piutang').textContent = "Lunasi";
});

async function applyFiltersAndStats() {
    let totalOmset = 0; let totalProfit = 0; let totalTrx = 0; let totalItems = 0; let produkCounts = {};
    dataPenjualanTerfilter = riwayatPenjualan.filter(sale => sale.tipe !== "pelunasan_piutang"); 

    dataPenjualanTerfilter.forEach(sale => { 
        totalOmset += Math.round(sale.totalAkhir || 0); 
        totalProfit += Math.round(sale.profit || 0); 
        totalTrx++;
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
    if (typeof Chart === 'undefined') return; 
    const ctx = document.getElementById('chartProdukTerlaris'); if(!ctx) return; if (chartInstance) chartInstance.destroy();
    if (labels.length === 0) { labels = ["Belum ada data"]; values = [0]; }
    chartInstance = new Chart(ctx, { type: 'bar', data: { labels: labels, datasets: [{ label: 'Qty Terjual', data: values, backgroundColor: '#1971c2', borderRadius: 6 }] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { grid: { display: false }, ticks: { color: '#909296', font: { family: 'Inter', size: 10 } } }, y: { grid: { color: '#373A40' }, ticks: { color: '#909296', font: { family: 'Inter', size: 10 }, precision: 0 } } } } });
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
        alert("❌ Kode Voucher tidak valid atau kadaluarsa.");
        appliedVoucher = null; document.getElementById('voucher-code').value = "";
        hitungUangKembalian();
    }
});


const btnCash = document.getElementById('pay-method-cash');
const btnNonCash = document.getElementById('pay-method-noncash');
const btnKasbon = document.getElementById('pay-method-kasbon');
const btnSplit = document.getElementById('pay-method-split');

function resetPaymentUI() {
    [btnCash, btnNonCash, btnKasbon].forEach(b => { if(b) b.className = "py-2.5 text-[11px] font-semibold text-dark-1 hover:text-gray-100 rounded-lg transition-all"; });
    if(btnSplit) btnSplit.className = "w-full py-2.5 mb-3 text-[11px] font-bold text-mantine-blue bg-mantine-blue/10 hover:bg-mantine-blue/20 border border-mantine-blue/30 rounded-lg transition-all";
    document.getElementById('cash-paid').classList.add('hidden'); document.getElementById('noncash-ref').classList.add('hidden');
    isSplitPayment = false;
}

btnCash?.addEventListener('click', () => { resetPaymentUI(); selectedPaymentMethod = 'Tunai'; btnCash.className = "py-2.5 text-[11px] font-semibold bg-mantine-blue text-white rounded-lg transition-all shadow"; document.getElementById('cash-paid').classList.remove('hidden'); hitungUangKembalian(); });
btnNonCash?.addEventListener('click', () => { resetPaymentUI(); selectedPaymentMethod = 'Non-Tunai'; btnNonCash.className = "py-2.5 text-[11px] font-semibold bg-mantine-blue text-white rounded-lg transition-all shadow"; document.getElementById('noncash-ref').classList.remove('hidden'); hitungUangKembalian(); });
btnKasbon?.addEventListener('click', () => { if(!activeMember) { alert("Pilih Pelanggan / Member terlebih dahulu untuk melakukan Kasbon!"); return; } resetPaymentUI(); selectedPaymentMethod = 'Kasbon'; btnKasbon.className = "py-2.5 text-[11px] font-semibold bg-amber-500 text-white rounded-lg transition-all shadow"; hitungUangKembalian(); });

btnSplit?.addEventListener('click', () => {
    if(keranjang.length === 0) return alert("Keranjang kosong!");
    resetPaymentUI(); isSplitPayment = true;
    btnSplit.className = "w-full py-2.5 mb-3 text-[11px] font-bold text-white bg-mantine-blue rounded-lg shadow-lg shadow-mantine-blue/30 transition-all";
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

// Fitur Hold & Pendaftaran Member
document.getElementById('btn-hold-bill')?.addEventListener('click', () => {
    if (keranjang.length === 0) return alert("Keranjang kosong!");
    let holdName = prompt("Nama Penanda (cth: Meja 5 / Bpk Andi):"); if (holdName === null) return;
    holdName = holdName.trim() || `Order #${Date.now().toString().slice(-4)}`;
    const heldBills = JSON.parse(localStorage.getItem('pos_held_bills') || '[]');
    const discVal = document.getElementById('cart-discount') ? Math.round(parseFloat(document.getElementById('cart-discount').value)) : 0;
    heldBills.push({ id: Date.now().toString(), tag: holdName, waktu: new Date().toLocaleString('id-ID'), items: keranjang, diskon: discVal || 0, activeMember: activeMember });
    localStorage.setItem('pos_held_bills', JSON.stringify(heldBills));
    keranjang = []; localStorage.removeItem("pos_recovery_cart"); activeMember = null; localStorage.removeItem("pos_recovery_member");
    const cd = document.getElementById('cart-discount'); if(cd) cd.value = ""; document.getElementById('btn-remove-member')?.click(); 
    renderKeranjang(); updateHoldCountBadge(); alert("Pesanan ditangguhkan.");
});

document.getElementById('btn-recall-bill')?.addEventListener('click', () => { renderHoldModalList(); document.getElementById('hold-modal')?.classList.remove('hidden'); });

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
            <div class="flex-1 min-w-0"><div class="flex justify-between items-center mb-1"><span class="font-bold text-xs text-amber-400 truncate">${escapeHTML(bill.tag)}</span></div><p class="text-[10px] text-dark-1 truncate">${bill.items.map(i => `${escapeHTML(i.nama)} (${i.qty}x)`).join(', ')}</p></div>
            <div class="flex gap-2 shrink-0"><button onclick="window.loadHeldBill('${bill.id}')" class="px-3 py-1.5 bg-mantine-blue text-white rounded-lg text-xs font-bold transition-all">Buka</button><button onclick="window.deleteHeldBill('${bill.id}')" class="px-3 py-1.5 bg-red-950/40 text-red-400 border border-red-900 rounded-lg text-xs font-bold transition-all">🗑️</button></div>
        </div>`).join('');
}

window.loadHeldBill = (id) => {
    if (keranjang.length > 0 && !confirm("Ganti keranjang dengan orderan ini?")) return;
    const heldBills = JSON.parse(localStorage.getItem('pos_held_bills') || '[]'); const idx = heldBills.findIndex(b => b.id === id);
    if (idx > -1) {
        const bill = heldBills[idx]; let validatedItems = []; let hasChanges = false;
        for (let item of bill.items) {
            const dbItem = databaseBarang.find(i => i.id === item.id);
            if (!dbItem || (dbItem.stok || 0) <= 0) { hasChanges = true; continue; }
            if (item.qty > dbItem.stok) { item.qty = dbItem.stok; hasChanges = true; }
            if (item.harga !== dbItem.harga) { item.harga = dbItem.harga; hasChanges = true; }
            if (item.cost !== dbItem.cost) { item.cost = dbItem.cost || 0; hasChanges = true; } 
            validatedItems.push(item);
        }
        if (validatedItems.length === 0) { alert("Semua produk di orderan ini telah habis."); heldBills.splice(idx, 1); localStorage.setItem('pos_held_bills', JSON.stringify(heldBills)); renderHoldModalList(); updateHoldCountBadge(); return; }
        if (hasChanges) alert("Penyesuaian stok/harga dilakukan berdasarkan Master Data Gudang.");
        keranjang = validatedItems; localStorage.setItem("pos_recovery_cart", JSON.stringify(keranjang));
        const cd = document.getElementById('cart-discount'); if(cd) cd.value = bill.diskon || "";
        activeMember = bill.activeMember || null; 
        if (activeMember) { localStorage.setItem("pos_recovery_member", JSON.stringify(activeMember)); showActiveMemberUI(); } 
        else { document.getElementById('btn-remove-member')?.click(); }
        heldBills.splice(idx, 1); localStorage.setItem('pos_held_bills', JSON.stringify(heldBills));
        document.getElementById('hold-modal')?.classList.add('hidden'); renderKeranjang(); updateHoldCountBadge();
    }
};

window.deleteHeldBill = (id) => { const heldBills = JSON.parse(localStorage.getItem('pos_held_bills') || '[]'); localStorage.setItem('pos_held_bills', JSON.stringify(heldBills.filter(b => b.id !== id))); renderHoldModalList(); updateHoldCountBadge(); };

document.getElementById('btn-check-member')?.addEventListener('click', async () => {
    const phone = document.getElementById('member-search-input')?.value.trim(); if (!phone) return;
    const btnCheck = document.getElementById('btn-check-member'); if(btnCheck) { btnCheck.disabled = true; btnCheck.textContent = "..."; }
    try {
        const docSnap = await getDoc(doc(db, "members", phone));
        if (docSnap.exists()) { activeMember = { id: phone, ...docSnap.data() }; localStorage.setItem("pos_recovery_member", JSON.stringify(activeMember)); showActiveMemberUI(); } 
        else { if (confirm(`Member ${phone} belum terdaftar. Daftarkan?`)) { document.getElementById('member-reg-phone').value = phone; document.getElementById('member-reg-name').value = ""; document.getElementById('member-modal').classList.remove('hidden'); } }
    } catch(e) {} finally { if(btnCheck) { btnCheck.disabled = false; btnCheck.textContent = "Cari"; } }
});

document.getElementById('member-form')?.addEventListener('submit', async (e) => {
    e.preventDefault(); 
    if (!navigator.onLine) return alert("Butuh internet.");
    const btnSubmit = e.target.querySelector('button[type="submit"]'); let origText = ""; if(btnSubmit) { origText = btnSubmit.textContent; btnSubmit.disabled = true; btnSubmit.textContent = "Memproses..."; }
    try {
        const phone = document.getElementById('member-reg-phone')?.value.trim() || ''; const name = document.getElementById('member-reg-name')?.value.trim() || '';
        const checkSnap = await getDoc(doc(db, "members", phone));
        if(checkSnap.exists()) return alert("Nomor ini sudah terdaftar!");
        await setDoc(doc(db, "members", phone), { nama: name, poin: 0 }); 
        activeMember = { id: phone, nama: name, poin: 0 }; localStorage.setItem("pos_recovery_member", JSON.stringify(activeMember)); showActiveMemberUI(); document.getElementById('member-modal')?.classList.add('hidden');
    } catch(e) {} finally { if(btnSubmit) { btnSubmit.disabled = false; btnSubmit.textContent = origText; } }
});

document.getElementById('btn-remove-member')?.addEventListener('click', () => { activeMember = null; localStorage.removeItem("pos_recovery_member"); document.getElementById('member-select-zone')?.classList.remove('hidden'); document.getElementById('member-active-zone')?.classList.add('hidden'); document.getElementById('btn-remove-member')?.classList.add('hidden'); document.getElementById('member-search-input').value = ""; renderKeranjang(); btnCash?.click(); });
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
        <div onclick="window.tambahKeKeranjang('${i.id}')" class="bg-dark-6 p-4 rounded-xl border border-dark-4 hover:border-mantine-blue cursor-pointer select-none flex flex-col justify-between active:scale-[0.98] transition-all group shadow-sm">
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
        if(listEl) listEl.innerHTML = `<div class="flex flex-col items-center justify-center h-full text-dark-3"><p class="text-xs italic">Keranjang kosong</p></div>`;
        document.getElementById('btn-checkout').disabled = true; document.getElementById('cart-grand-total').textContent = "Rp 0";
        appliedVoucher = null; document.getElementById('voucher-code').value = "";
        return;
    }
    if(listEl) listEl.innerHTML = keranjang.map(k => `
        <div class="bg-dark-6 p-4 rounded-xl border border-dark-4 flex justify-between items-center gap-3 shadow-sm hover:border-dark-3 transition-colors">
            <div class="flex-1 min-w-0"><h5 class="text-xs font-bold text-gray-100 truncate">${escapeHTML(k.nama)}</h5><p class="text-[11px] text-dark-2 mt-1">${toRupiah(k.harga)} x <span class="font-bold text-gray-300">${k.qty}</span></p></div>
            <div class="flex items-center gap-2 bg-dark-8 p-1.5 rounded-lg border border-dark-4 shrink-0"><button onclick="window.ubahQtyCart('${k.id}', -1)" class="w-7 h-7 bg-dark-5 text-gray-100 rounded text-sm font-black flex items-center justify-center">-</button><span class="text-xs font-bold px-1.5 text-gray-200">${k.qty}</span><button onclick="window.ubahQtyCart('${k.id}', 1)" class="w-7 h-7 bg-dark-5 text-gray-100 rounded text-sm font-black flex items-center justify-center">+</button></div>
        </div>`).join('');
    hitungUangKembalian();
}

function hitungUangKembalian() {
    if(isSplitPayment) return; 
    
    globalSubtotal = Math.round(keranjang.reduce((acc, i) => acc + ((i.harga||0) * i.qty), 0));
    let diskonOtomatisMember = activeMember ? Math.floor(globalSubtotal * 0.05) : 0;
    
    let diskonVoucher = 0;
    if (appliedVoucher) {
        if (appliedVoucher.type === "percent") { diskonVoucher = Math.floor(globalSubtotal * (appliedVoucher.value / 100)); } 
        else if (appliedVoucher.type === "nominal") { diskonVoucher = appliedVoucher.value; }
    }

    const rawDiskonManual = Math.round(Math.max(0, parseFloat(document.getElementById('cart-discount').value) || 0));
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

// ✨ BUG FIX 4: CHECKOUT ENGINE DENGAN LOGIKA UANG LACI & POIN MEMBER
document.getElementById('btn-checkout')?.addEventListener('click', async (e) => {
    const btnCheckout = e.currentTarget;
    if(btnCheckout.disabled || keranjang.length === 0 || !activeShiftSession) return;
    btnCheckout.disabled = true; btnCheckout.textContent = "MEMPROSES...";

    let totalModalHPP = 0;
    keranjang.forEach(item => { totalModalHPP += ((item.cost || 0) * item.qty); });
    const totalProfit = globalGrandTotal - totalModalHPP;

    let tunaiMasukLaci = 0;

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
        if(splitDetails.method1 === 'Tunai') tunaiMasukLaci += splitDetails.amount1;
        if(splitDetails.method2 === 'Tunai') tunaiMasukLaci += splitDetails.amount2;
    } else if (selectedPaymentMethod === 'Kasbon') {
        trxData.metodePembayaran = "Kasbon"; trxData.uangBayar = 0; trxData.kembalian = 0;
    } else if (selectedPaymentMethod === 'Tunai') {
        trxData.metodePembayaran = "Tunai"; trxData.uangBayar = parseFloat(document.getElementById('cash-paid').value) || 0; trxData.kembalian = trxData.uangBayar - globalGrandTotal;
        tunaiMasukLaci = globalGrandTotal;
    } else {
        trxData.metodePembayaran = selectedPaymentMethod; trxData.uangBayar = globalGrandTotal; trxData.kembalian = 0;
    }

    try {
        trxData.waktu = serverTimestamp(); trxData.waktuLokal = new Date().toISOString(); 
        await addDoc(salesRef, trxData);
        for (const item of trxData.items) { try { await updateDoc(doc(db, "barang", item.id), { stok: increment(-item.qty) }); } catch(e) {} }
        
        if (selectedPaymentMethod === 'Kasbon' && activeMember) {
            await updateDoc(doc(db, "members", activeMember.id), { hutang: increment(globalGrandTotal) });
        } else if (activeMember && selectedPaymentMethod !== 'Kasbon') {
            const addPoin = Math.floor(globalGrandTotal / 10000);
            if (addPoin > 0) await updateDoc(doc(db, "members", activeMember.id), { poin: increment(addPoin) });
        }

        // Perekaman Laci Shift
        await updateDoc(doc(db, "shift", activeShiftSession.id), { 
            totalPenjualan: increment(globalGrandTotal), 
            totalTunai: increment(tunaiMasukLaci) 
        });

        const isBluetoothPrinted = await printDirectBluetooth(formatStrukBT(trxData));
        if (!isBluetoothPrinted) { cetakStrukThermal(trxData); }

        keranjang = []; localStorage.removeItem("pos_recovery_cart");
        appliedVoucher = null; document.getElementById('voucher-code').value = ""; document.getElementById('cart-discount').value = ""; document.getElementById('cash-paid').value = "";
        btnCash?.click(); document.getElementById('btn-remove-member')?.click(); renderKeranjang(); 
        
    } catch(e) { alert("GAGAL: " + e.message); } 
    finally { btnCheckout.disabled = false; btnCheckout.textContent = "Selesaikan Transaksi"; }
});

function formatStrukBT(data) {
    let struk = "====== TOKO MODERN POS ======\nJl. Teknologi No.123\n------------------------------\n";
    struk += `ID   : ${data.id}\nWaktu: ${new Date().toLocaleString('id-ID')}\nKasir: ${data.namaKasir.toUpperCase()}\n------------------------------\n`;
    data.items.forEach(i => { struk += `${i.nama}\n${i.qty} x ${i.harga} = ${i.qty * i.harga}\n`; });
    struk += `------------------------------\nSubtotal : Rp ${data.subtotal}\nDiskon   : Rp -${data.diskon}\nTOTAL    : Rp ${data.totalAkhir}\nBayar    : Rp ${data.uangBayar}\nKembali  : Rp ${data.kembalian}\n`;
    if(data.memberName) struk += `\nMember   : ${data.memberName.toUpperCase()}\n`;
    struk += "------------------------------\n       TERIMA KASIH!          \n";
    return struk;
}

function cetakStrukThermal(data) {
    const printArea = document.getElementById('print-area'); if(!printArea) return;
    const tglStruk = data.waktuLokal ? new Date(data.waktuLokal) : new Date();
    printArea.innerHTML = `
        <div style="font-family:monospace; color:black; max-width:300px; margin:0 auto; padding:10px;">
            <div style="text-align:center; margin-bottom:10px;"><h3 style="margin:0; font-size:16px; font-weight:bold;">Toko Modern POS</h3><p style="margin:2px 0; font-size:10px;">Jl. Teknologi No.123</p></div>
            <div style="border-top:1px dashed black; margin:8px 0;"></div>
            <div style="font-size:10px; margin-bottom:8px;"><div style="display:flex; justify-content:space-between;"><span>Trx ID:</span> <span>${data.id || 'OFFLINE'}</span></div><div style="display:flex; justify-content:space-between;"><span>Waktu:</span> <span>${tglStruk.toLocaleString('id-ID')}</span></div><div style="display:flex; justify-content:space-between;"><span>Kasir:</span> <span>${escapeHTML(data.namaKasir ? data.namaKasir.toUpperCase() : 'SISTEM')}</span></div></div>
            <div style="border-top:1px dashed black; margin:8px 0;"></div>
            <div style="margin-bottom:8px;">${(data.items||[]).map(i => `<div style="margin-bottom:4px;"><div style="font-size:10px; font-weight:bold;">${escapeHTML(i.nama||'Item')}</div><div style="display:flex; justify-content:space-between; font-size:10px;"><span>${i.qty} x ${toRupiah(i.harga)}</span><span>${toRupiah((i.harga||0) * i.qty)}</span></div></div>`).join('')}</div>
            <div style="border-top:1px dashed black; margin:8px 0;"></div>
            <div style="font-size:10px;">
                <div style="display:flex; justify-content:space-between; margin-bottom:2px;"><span>Subtotal:</span><span>${toRupiah(data.subtotal)}</span></div>
                <div style="display:flex; justify-content:space-between; margin-bottom:2px;"><span>Diskon:</span><span>-${toRupiah(data.diskon)}</span></div>
                <div style="display:flex; justify-content:space-between; font-weight:bold; font-size:12px; margin-top:4px; margin-bottom:4px;"><span>Total:</span><span>${toRupiah(data.totalAkhir)}</span></div>
                <div style="border-top:1px dashed black; margin:6px 0;"></div>
                <div style="display:flex; justify-content:space-between; margin-bottom:2px;"><span>Bayar (${escapeHTML(data.metodePembayaran||'Tunai')}):</span><span>${toRupiah(data.uangBayar)}</span></div>
                <div style="display:flex; justify-content:space-between;"><span>Kembali:</span><span>${toRupiah(data.kembalian)}</span></div>
            </div>
            ${data.memberName ? `<div style="border-top:1px dashed black; margin:8px 0;"></div><div style="font-size:10px; text-align:center;"><p style="margin:2px 0;">Member: <strong>${escapeHTML(data.memberName.toUpperCase())}</strong></p></div>` : ''}
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
                <td class="px-6 py-4 text-xs font-bold"><span class="px-2.5 py-1 bg-dark-5 rounded border border-dark-4">${escapeHTML(trx.metodePembayaran)}</span></td>
                <td class="px-6 py-4 text-sm text-green-400 font-black">${toRupiah(trx.totalAkhir)}</td>
                <td class="px-6 py-4 text-right"><button onclick="window.reprintTrx('${trx.id || trx.localId}')" class="px-3 py-1.5 bg-dark-5 hover:bg-dark-4 text-white text-xs rounded-lg font-bold shadow">🖨️ Struk</button></td>
            </tr>`;
    }).join('');
}

window.reprintTrx = async (id) => { 
    const offlineTrx = dataPenjualanTerfilter.find(t => t.localId == id || t.id == id);
    if (offlineTrx) { cetakStrukThermal(offlineTrx); } 
    else { 
        if (!navigator.onLine) return alert("Peringatan: Butuh internet.");
        try { const docSnap = await getDoc(doc(db, "penjualan", id)); if(docSnap.exists()) { cetakStrukThermal(docSnap.data()); } } catch(e) { alert("Data tidak ditemukan."); }
    }
};

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

// Master Gudang
const itemForm = document.getElementById('item-form');
itemForm?.addEventListener('submit', async (e) => {
    e.preventDefault(); 
    if (!navigator.onLine) return alert("Peringatan: Butuh internet.");
    const idInput = document.getElementById('item-id'); const barcodeInputEl = document.getElementById('item-barcode');
    const id = idInput ? idInput.value : ''; const barcodeInput = barcodeInputEl ? barcodeInputEl.value.trim() : '';
    if (barcodeInput !== "") { const isDuplicate = databaseBarang.find(x => (x.barcode || '').toLowerCase() === barcodeInput.toLowerCase() && x.id !== id); if (isDuplicate) return alert(`Barcode sudah dipakai: ${isDuplicate.nama}`); }
    
    const btnSubmit = document.getElementById('btn-submit'); let origText = ""; if(btnSubmit) { origText = btnSubmit.textContent; btnSubmit.disabled = true; btnSubmit.textContent = "Menyimpan..."; }
    try {
        const rawCost = parseFloat(document.getElementById('item-cost')?.value) || 0; const rawHrg = parseFloat(document.getElementById('item-price')?.value) || 0; const rawStk = parseInt(document.getElementById('item-stock')?.value) || 0;
        const nName = document.getElementById('item-name')?.value.trim() || 'Barang Baru';
        const data = { barcode: barcodeInput, nama: nName, cost: Math.round(Math.max(0, rawCost)), harga: Math.round(Math.max(0, rawHrg)), stok: Math.max(0, rawStk) };
        if(id) { await updateDoc(doc(db, "barang", id), data); } else { await addDoc(itemsRef, data); }
        document.getElementById('item-form')?.reset(); document.getElementById('item-id').value = ""; document.getElementById('btn-cancel')?.classList.add('hidden');
    } catch(err) {} finally { if(btnSubmit) { btnSubmit.disabled = false; btnSubmit.textContent = origText; } }
});

window.editBarang = (id) => {
    const item = databaseBarang.find(x => x.id === id); if (!item) return;
    document.getElementById('item-id').value = item.id; document.getElementById('item-barcode').value = item.barcode || ""; 
    document.getElementById('item-name').value = item.nama; document.getElementById('item-cost').value = item.cost || 0; 
    document.getElementById('item-price').value = item.harga || 0; document.getElementById('item-stock').value = item.stok || 0; 
    document.getElementById('btn-cancel')?.classList.remove('hidden');
};
window.hapusBarang = async (id) => { if (!navigator.onLine) return alert("Butuh internet."); const item = databaseBarang.find(x => x.id === id); if(!item) return; if(confirm(`Hapus permanen ${item.nama}?`)) { await deleteDoc(doc(db, "barang", id)); } };
document.getElementById('btn-cancel')?.addEventListener('click', () => { document.getElementById('item-form')?.reset(); document.getElementById('item-id').value = ""; document.getElementById('btn-cancel')?.classList.add('hidden'); });

function renderGudangList() {
    const container = document.getElementById('gudang-list'); if(!container) return;
    if(databaseBarang.length === 0) { container.innerHTML = `<p class="text-[11px] text-dark-2 italic text-center py-4">Kosong.</p>`; return; }
    container.innerHTML = databaseBarang.map(i => `
        <div class="bg-dark-6 p-4 rounded-xl border border-dark-4 flex justify-between items-center gap-3 shadow-sm hover:border-dark-3 transition-colors">
            <div><span class="text-[9px] font-bold text-dark-2 mb-1 block">${escapeHTML(i.barcode ? '📟 '+i.barcode : 'NO BARCODE')}</span><h3 class="font-bold text-gray-100 text-sm">${escapeHTML(i.nama||'Item')}</h3><div class="flex items-center gap-2 mt-1.5"><span class="text-xs font-black text-green-400">${toRupiah(i.harga)}</span> <span class="text-[10px] text-dark-2">| Modal: ${toRupiah(i.cost||0)}</span> <span class="text-[9px] font-bold ml-1 px-1.5 py-0.5 bg-dark-5 text-dark-0 rounded border border-dark-4 ${(i.stok||0)<=5?'!bg-red-900/30 !text-red-400':''}">Stok: ${i.stok||0}</span></div></div>
            <div class="flex gap-2"><button onclick="window.editBarang('${i.id}')" class="px-3 py-2 bg-dark-5 hover:bg-dark-4 text-xs font-bold rounded-lg transition-colors">Ubah</button><button onclick="window.hapusBarang('${i.id}')" class="px-3 py-2 bg-red-950/20 hover:bg-red-950/40 text-red-400 border border-red-900/50 text-xs font-bold rounded-lg transition-colors">Hapus</button></div>
        </div>`).join('');
}

document.getElementById('btn-export-excel')?.addEventListener('click', () => {
    if (dataPenjualanTerfilter.length === 0) return alert("Data kosong.");
    const fileNameDate = new Date().toISOString().split('T')[0];
    const dataExcel = dataPenjualanTerfilter.map(trx => { 
        const itemsStr = Array.isArray(trx.items) ? trx.items.map(i => `${i.nama||'Item'} (${i.qty}x)`).join(', ') : '';
        const waktuStr = trx.waktu && trx.waktu.seconds ? new Date(trx.waktu.seconds * 1000).toLocaleString('id-ID') : (trx.waktuLokal ? new Date(trx.waktuLokal).toLocaleString('id-ID') : '-');
        return { 'Waktu Transaksi': waktuStr, 'Kasir': trx.namaKasir||'-', 'Daftar Barang': itemsStr, 'Metode Pembayaran': trx.metodePembayaran || 'Tunai', 'Subtotal (Rp)': trx.subtotal || 0, 'Diskon (Rp)': trx.diskon || 0, 'Grand Total/Omset (Rp)': trx.totalAkhir || 0, 'Laba Bersih/Profit (Rp)': trx.profit || 0, 'Uang Diterima (Rp)': trx.uangBayar || 0, 'Kembalian (Rp)': trx.kembalian || 0 }; 
    });
    if (typeof XLSX !== 'undefined') {
        const worksheet = XLSX.utils.json_to_sheet(dataExcel); const workbook = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(workbook, worksheet, "Laporan Penjualan");
        XLSX.writeFile(workbook, `Laporan_POS_${fileNameDate}.xlsx`);
    } else { alert("Pustaka Excel belum termuat."); }
});