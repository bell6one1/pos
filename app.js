// Import koneksi Database dan SDK pendukung Firebase
import { db, auth, itemsRef, salesRef, shiftsRef, membersRef, auditLogsRef } from './firebase-config.js';
import { addDoc, doc, getDoc, setDoc, updateDoc, deleteDoc, onSnapshot, query, orderBy, increment, serverTimestamp, where, limit } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { signInWithEmailAndPassword, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";

// ==========================================
// VARIABEL GLOBAL
// ==========================================
let databaseBarang = []; let riwayatPenjualan = []; let dataPenjualanTerfilter = []; let dataShiftAll = []; let auditLogsData = []; let keranjang = [];
let chartInstance = null; let unsubscribeItems = null; let unsubscribeSales = null; let unsubscribeShifts = null; let unsubscribeAudit = null;
let filterKategoriAktif = "Semua"; let kataKunciPencarian = ""; let globalSubtotal = 0; let globalDiskon = 0; let globalGrandTotal = 0;
let currentUserRole = "kasir"; let activeShiftSession = null; let currentUserId = null;
let selectedPaymentMethod = "Tunai"; let activeMember = null; 

// UTILITY FUNCTIONS
const toRupiah = (angka) => new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 }).format(angka || 0);
const formatTanggal = (timestamp) => { 
    if(!timestamp) return 'Pending...'; 
    try {
        if(typeof timestamp === 'string') return new Date(timestamp).toLocaleString('id-ID', { dateStyle: 'short', timeStyle: 'short' });
        if(timestamp.seconds) return new Date(timestamp.seconds * 1000).toLocaleString('id-ID', { dateStyle: 'short', timeStyle: 'short' });
        if(timestamp instanceof Date) return timestamp.toLocaleString('id-ID', { dateStyle: 'short', timeStyle: 'short' });
        return '-';
    } catch(e) { return '-'; }
};

// ==========================================
// LOAD CACHE (ANTI BLACKOUT SAAT OFFLINE)
// ==========================================
const cachedItems = localStorage.getItem("pos_cached_items");
if (cachedItems) { try { databaseBarang = JSON.parse(cachedItems); } catch(e){} }
const cachedShift = localStorage.getItem("pos_cached_shift");
if (cachedShift) { try { activeShiftSession = JSON.parse(cachedShift); } catch(e){} }

// ==========================================
// INDEXEDDB (TRUE OFFLINE ENGINE)
// ==========================================
const OFFLINE_DB_NAME = "POS_Offline_Database";
const OFFLINE_STORE_NAME = "pending_transactions";

function initIndexedDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(OFFLINE_DB_NAME, 1);
        request.onupgradeneeded = (e) => {
            const idb = e.target.result;
            if (!idb.objectStoreNames.contains(OFFLINE_STORE_NAME)) {
                idb.createObjectStore(OFFLINE_STORE_NAME, { keyPath: "localId", autoIncrement: true });
            }
        };
        request.onsuccess = (e) => resolve(e.target.result);
        request.onerror = (e) => reject(e.target.error);
    });
}

async function loadOfflineTransactions() {
    if (!window.indexedDB) return [];
    try {
        const idb = await initIndexedDB();
        const tx = idb.transaction(OFFLINE_STORE_NAME, "readonly");
        const store = tx.objectStore(OFFLINE_STORE_NAME);
        return new Promise(resolve => {
            const req = store.getAll();
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => resolve([]);
        });
    } catch(e) { return []; }
}

async function saveTransactionOffline(saleData) {
    try {
        const idb = await initIndexedDB();
        const tx = idb.transaction(OFFLINE_STORE_NAME, "readwrite");
        const store = tx.objectStore(OFFLINE_STORE_NAME);
        store.add(saleData);
        await tx.complete;
        return true;
    } catch (error) { return false; }
}

async function syncOfflineTransactions() {
    if (!navigator.onLine) return;
    document.getElementById('offline-indicator').classList.add('hidden');

    try {
        // 1. Sinkronisasi Data Penjualan Tertunda
        const idb = await initIndexedDB();
        const tx = idb.transaction(OFFLINE_STORE_NAME, "readwrite");
        const store = tx.objectStore(OFFLINE_STORE_NAME);
        const request = store.getAll();

        request.onsuccess = async () => {
            const pendingSales = request.result;
            let successCount = 0;
            
            if (pendingSales.length > 0) {
                console.log(`📡 Menghubungkan ulang server. Sinkronisasi ${pendingSales.length} data penjualan...`);
                for (const sale of pendingSales) {
                    try {
                        const localId = sale.localId;
                        delete sale.localId; delete sale.isOfflinePending;
                        sale.waktu = sale.waktuLokal ? new Date(sale.waktuLokal) : serverTimestamp(); 

                        await addDoc(salesRef, sale); 
                        for (const item of sale.items) { await updateDoc(doc(db, "barang", item.id), { stok: increment(-item.qty) }); }
                        if (sale.shiftId) { await updateDoc(doc(db, "shift", sale.shiftId), { totalPenjualan: increment(sale.totalAkhir) }); }
                        if (sale.memberId) { const addPoin = Math.floor(sale.totalAkhir / 10000); if (addPoin > 0) await updateDoc(doc(db, "members", sale.memberId), { poin: increment(addPoin) }); }

                        const deleteTx = idb.transaction(OFFLINE_STORE_NAME, "readwrite");
                        deleteTx.objectStore(OFFLINE_STORE_NAME).delete(localId);
                        successCount++;
                    } catch (errInner) {}
                }
            }

            // 2. Sinkronisasi Data Audit Log Tertunda (ANTI-FRAUD OFFLINE SYNC)
            const offlineLogs = JSON.parse(localStorage.getItem('pos_offline_logs') || '[]');
            if (offlineLogs.length > 0) {
                console.log(`📡 Sinkronisasi ${offlineLogs.length} audit logs...`);
                for (const log of offlineLogs) {
                    try {
                        log.timestamp = log.timestamp ? new Date(log.timestamp) : serverTimestamp();
                        await addDoc(auditLogsRef, log);
                    } catch(e) {}
                }
                localStorage.removeItem('pos_offline_logs');
            }

            if(successCount > 0) {
                await logActivity("SYNC_OFFLINE", `Sukses mengunggah ${successCount} transaksi offline.`);
                alert(`🎉 Koneksi Stabil! ${successCount} data penjualan offline berhasil diunggah.`);
            }
            applyFiltersAndStats();
        };
    } catch(e) {}
}

window.addEventListener('online', syncOfflineTransactions);
window.addEventListener('offline', () => { document.getElementById('offline-indicator').classList.remove('hidden'); applyFiltersAndStats(); });

// ==========================================
// AUDIT LOGS & PERANGKAT KERAS (FIXED ANTI-FRAUD)
// ==========================================
async function logActivity(actionType, actionDetails) {
    const userEmail = auth.currentUser ? auth.currentUser.email.split('@')[0] : "Sistem";
    const logObj = { user: userEmail, action: actionType, detail: actionDetails };

    if (!navigator.onLine) {
        logObj.timestamp = new Date().toISOString();
        const offlineLogs = JSON.parse(localStorage.getItem('pos_offline_logs') || '[]');
        offlineLogs.push(logObj);
        localStorage.setItem('pos_offline_logs', JSON.stringify(offlineLogs));
        return; 
    }
    
    try {
        logObj.timestamp = serverTimestamp();
        await addDoc(auditLogsRef, logObj);
    } catch (error) {}
}

function playBeep() {
    try {
        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const oscillator = audioCtx.createOscillator(); const gainNode = audioCtx.createGain();
        oscillator.type = 'sine'; oscillator.frequency.setValueAtTime(880, audioCtx.currentTime); 
        gainNode.gain.setValueAtTime(0.1, audioCtx.currentTime);
        oscillator.connect(gainNode); gainNode.connect(audioCtx.destination);
        oscillator.start(); oscillator.stop(audioCtx.currentTime + 0.1); 
    } catch (error) {}
}

let barcodeBuffer = ""; let barcodeTimeout = null;
document.addEventListener("keydown", (e) => {
    if (e.target.tagName === 'INPUT' && e.target.id !== 'kasir-search' && e.target.id !== 'item-barcode') return;
    if (e.key === 'Enter' && barcodeBuffer.length > 0) {
        e.preventDefault();
        const b = databaseBarang.find(x => x.barcode === barcodeBuffer || x.id === barcodeBuffer);
        
        if (b) { 
            if ((b.stok||0) > 0) {
                window.tambahKeKeranjang(b.id); 
            } else {
                alert(`Stok produk [${b.nama}] habis!`);
            }
        }
        
        // BUG FIX: Selalu paksa kosongkan input jika asalnya dari pencarian agar UI tidak macet
        if (e.target.id === 'kasir-search') { 
            e.target.value = ""; 
            kataKunciPencarian = ""; 
            renderKatalogKasir(); 
        }
        barcodeBuffer = "";
    } else {
        if (e.key.length === 1) { 
            barcodeBuffer += e.key; 
            clearTimeout(barcodeTimeout); 
            barcodeTimeout = setTimeout(() => { barcodeBuffer = ""; }, 100); 
        }
    }
});

// ==========================================
// AUTHENTICATION & INITIALIZATION
// ==========================================
const authLoading = document.getElementById('auth-loading'); const loginScreen = document.getElementById('login-screen'); const appScreen = document.getElementById('app-screen');

onAuthStateChanged(auth, async (user) => {
    authLoading.classList.add('hidden');
    if (user) {
        currentUserId = user.uid; loginScreen.classList.add('hidden'); appScreen.classList.remove('hidden');
        renderKatalogKasir(); renderGudangList(); renderLowStock();
        if(activeShiftSession) updateShiftUI(true);

        if (navigator.onLine) {
            try {
                const userDocSnap = await getDoc(doc(db, "pengguna", user.uid));
                if (userDocSnap.exists()) { currentUserRole = userDocSnap.data().role || "kasir"; localStorage.setItem("pos_user_role", currentUserRole); } 
                else { currentUserRole = "kasir"; await setDoc(doc(db, "pengguna", user.uid), { email: user.email, role: "kasir", nama: user.email.split('@')[0] }); }
            } catch(e) { currentUserRole = localStorage.getItem("pos_user_role") || "kasir"; }
        } else {
            currentUserRole = localStorage.getItem("pos_user_role") || "kasir";
        }
        
        document.getElementById('user-display-name').textContent = user.email.split('@')[0];
        document.getElementById('user-display-role').textContent = currentUserRole === 'admin' ? 'Administrator' : 'Kasir Staff';
        applyRoleAccess(); initRealtimeListeners(); checkActiveShift(user.uid); updateHoldCountBadge(); syncOfflineTransactions();
    } else { appScreen.classList.add('hidden'); loginScreen.classList.remove('hidden'); stopRealtimeListeners(); activeShiftSession = null; currentUserId = null; }
});

document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault(); 
    if (!navigator.onLine) return alert("Peringatan: Anda membutuhkan koneksi internet untuk masuk (Login) ke dalam sistem!");
    const btnSubmit = document.getElementById('btn-login-submit'); btnSubmit.disabled = true; btnSubmit.textContent = "Memverifikasi...";
    try { await signInWithEmailAndPassword(auth, document.getElementById('login-email').value.trim(), document.getElementById('login-password').value); document.getElementById('login-form').reset(); } 
    catch (error) { alert("Login Gagal! Periksa kredensial."); } finally { btnSubmit.disabled = false; btnSubmit.textContent = "Masuk Aplikasi"; }
});

document.getElementById('btn-logout').addEventListener('click', async () => { 
    if (activeShiftSession) { alert("Tutup shift kasir sebelum keluar!"); switchTab('kasir'); return; }
    if(confirm("Keluar dari sistem?")) {
        try { await signOut(auth); } catch (e) {} finally {
            keranjang = []; localStorage.clear(); location.reload(); 
        }
    } 
});

// ==========================================
// TABS NAVIGATION 
// ==========================================
const tabsBtns = document.querySelectorAll('.nav-tab'); const contents = document.querySelectorAll('.tab-content');
function switchTab(id) {
    contents.forEach(c => c.classList.add('hidden')); 
    tabsBtns.forEach(t => { t.classList.remove('border-mantine-blue', 'text-mantine-blue'); t.classList.add('border-transparent', 'text-dark-1'); });
    const targetContent = document.getElementById(`tab-${id}`); if(targetContent) targetContent.classList.remove('hidden');
    const targetBtn = document.getElementById(`tab-${id}-btn`); if(targetBtn) { targetBtn.classList.remove('border-transparent', 'text-dark-1'); targetBtn.classList.add('border-mantine-blue', 'text-mantine-blue'); }
    if (id === 'dashboard' && chartInstance) setTimeout(() => chartInstance.update(), 100);
}

tabsBtns.forEach(tab => { 
    tab.addEventListener('click', () => {
        let cleanId = tab.id.replace('tab-', '').replace('-btn', '');
        switchTab(cleanId); 
    }); 
});

function applyRoleAccess() {
    const arr = ['tab-dashboard-btn', 'tab-gudang-btn', 'btn-export-excel', 'admin-shift-log-section'];
    arr.forEach(id => { const el = document.getElementById(id); if (el) { if (currentUserRole === "admin") el.classList.remove('hidden'); else el.classList.add('hidden'); } });
    switchTab(currentUserRole === "admin" ? 'dashboard' : 'kasir');
}

// ==========================================
// MANAJEMEN SHIFT
// ==========================================
function checkActiveShift(uid) {
    onSnapshot(query(shiftsRef, where("userId", "==", uid), where("status", "==", "buka"), limit(1)), (snapshot) => {
        if (!snapshot.empty) { snapshot.forEach(doc => { activeShiftSession = { id: doc.id, ...doc.data() }; }); localStorage.setItem("pos_cached_shift", JSON.stringify(activeShiftSession)); updateShiftUI(true); } 
        else if(navigator.onLine) { activeShiftSession = null; localStorage.removeItem("pos_cached_shift"); updateShiftUI(false); }
    });
}

function updateShiftUI(isActive) {
    const w = document.getElementById('shift-status-widget');
    if (isActive) {
        w.className = "bg-green-900/20 border border-green-800/50 p-5 rounded-xl flex flex-col sm:flex-row sm:items-center justify-between gap-4";
        w.innerHTML = `<div class="text-sm text-green-400"><p class="font-bold flex items-center gap-2"><div class="w-2.5 h-2.5 rounded-full bg-green-500 animate-pulse"></div> Sesi Aktif: ${auth.currentUser.email.split('@')[0].toUpperCase()}</p><p class="text-green-500/80 mt-1 text-xs font-medium">Modal Awal: ${toRupiah(activeShiftSession.modalAwal)} | Omset: ${toRupiah(activeShiftSession.totalPenjualan || 0)}</p></div><button onclick="window.triggerTutupShift()" class="px-5 py-2.5 text-xs font-bold text-gray-100 bg-dark-5 hover:bg-dark-4 rounded-xl">Tutup Sesi 🔒</button>`;
        document.getElementById('kasir-core-content').classList.remove('opacity-40', 'pointer-events-none'); document.getElementById('kasir-cart-content').classList.remove('opacity-40', 'pointer-events-none');
    } else {
        w.className = "bg-dark-8 border border-dark-4 p-5 rounded-xl flex flex-col sm:flex-row sm:items-center justify-between gap-4";
        w.innerHTML = `<div class="text-sm text-dark-0"><p class="font-bold flex items-center gap-2">🔒 Sesi Belum Dibuka</p><p class="text-dark-2 mt-1 text-xs">Buka shift terlebih dahulu.</p></div><button onclick="window.triggerBukaShift()" class="px-5 py-2.5 text-xs font-bold text-white bg-mantine-blue hover:bg-mantine-hover rounded-xl">Mulai Shift 🔑</button>`;
        document.getElementById('kasir-core-content').classList.add('opacity-40', 'pointer-events-none'); document.getElementById('kasir-cart-content').classList.add('opacity-40', 'pointer-events-none');
    }
}

window.triggerBukaShift = () => {
    document.getElementById('shift-modal-title').textContent = "Buka Shift"; document.getElementById('shift-input-label').textContent = "Modal Fisik (Rp)";
    document.getElementById('btn-close-shift-modal').classList.add('hidden'); document.getElementById('btn-shift-submit').textContent = "Buka";
    document.getElementById('shift-form').onsubmit = async (e) => {
        e.preventDefault(); 
        if (!navigator.onLine) return alert("Peringatan: Tidak dapat membuka shift. Koneksi internet dibutuhkan agar server dapat merekam laporan shift baru Anda.");
        
        const val = parseFloat(document.getElementById('shift-cash-input').value) || 0;
        const docRef = await addDoc(shiftsRef, { userId: currentUserId, namaKasir: auth.currentUser.email.split('@')[0], waktuBuka: serverTimestamp(), modalAwal: val, totalPenjualan: 0, status: "buka" });
        activeShiftSession = { id: docRef.id, userId: currentUserId, namaKasir: auth.currentUser.email.split('@')[0], modalAwal: val, totalPenjualan: 0, status: "buka" };
        localStorage.setItem("pos_cached_shift", JSON.stringify(activeShiftSession));
        await logActivity("SHIFT_BUKA", `Kasir membuka shift dengan modal ${toRupiah(val)}`);
        document.getElementById('shift-modal').classList.add('hidden'); updateShiftUI(true);
    };
    document.getElementById('shift-form').reset(); document.getElementById('shift-modal').classList.remove('hidden');
};

window.triggerTutupShift = () => {
    document.getElementById('shift-modal-title').textContent = "Z-Report Tutup Shift"; document.getElementById('shift-input-label').textContent = "Uang Aktual di Laci (Rp)";
    document.getElementById('btn-close-shift-modal').classList.remove('hidden'); document.getElementById('btn-shift-submit').textContent = "Tutup Shift";
    document.getElementById('btn-close-shift-modal').onclick = () => document.getElementById('shift-modal').classList.add('hidden');
    document.getElementById('shift-form').onsubmit = async (e) => {
        e.preventDefault(); 
        if (!navigator.onLine) return alert("Peringatan: Tidak dapat menutup shift. Koneksi internet dibutuhkan untuk validasi data Z-Report ke pusat.");
        
        const val = parseFloat(document.getElementById('shift-cash-input').value) || 0;
        const selisih = val - (activeShiftSession.modalAwal + (activeShiftSession.totalPenjualan || 0));
        await updateDoc(doc(db, "shift", activeShiftSession.id), { waktuTutup: serverTimestamp(), uangFisikAktual: val, selisih: selisih, status: "tutup" });
        await logActivity("SHIFT_TUTUP", `Kasir menutup shift. Selisih kas: ${toRupiah(selisih)}`);
        alert(`Shift Ditutup. Selisih: ${toRupiah(selisih)}`);
        document.getElementById('shift-modal').classList.add('hidden'); activeShiftSession = null; localStorage.removeItem("pos_cached_shift"); updateShiftUI(false);
    };
    document.getElementById('shift-form').reset(); document.getElementById('shift-modal').classList.remove('hidden');
};

// ==========================================
// REALTIME DATABASE LISTENERS
// ==========================================
function initRealtimeListeners() {
    unsubscribeItems = onSnapshot(query(itemsRef, orderBy("nama", "asc")), (snapshot) => { 
        databaseBarang = []; snapshot.forEach(doc => databaseBarang.push({ id: doc.id, ...doc.data() })); 
        localStorage.setItem("pos_cached_items", JSON.stringify(databaseBarang)); renderKatalogKasir(); renderGudangList(); renderLowStock(); 
    });
    unsubscribeSales = onSnapshot(query(salesRef, orderBy("waktu", "desc")), (snapshot) => { 
        riwayatPenjualan = []; snapshot.forEach(doc => riwayatPenjualan.push({ id: doc.id, ...doc.data() })); applyFiltersAndStats(); 
    });
    if (currentUserRole === 'admin') {
        unsubscribeShifts = onSnapshot(query(shiftsRef, orderBy("waktuBuka", "desc")), (snapshot) => { dataShiftAll = []; snapshot.forEach(doc => dataShiftAll.push({ id: doc.id, ...doc.data() })); renderShiftLogs(); });
        unsubscribeAudit = onSnapshot(query(auditLogsRef, orderBy("timestamp", "desc"), limit(50)), (snapshot) => { auditLogsData = []; snapshot.forEach(doc => auditLogsData.push({ id: doc.id, ...doc.data() })); renderAuditLogs(); });
    }
}
function stopRealtimeListeners() { if(unsubscribeItems) unsubscribeItems(); if(unsubscribeSales) unsubscribeSales(); if(unsubscribeShifts) unsubscribeShifts(); if(unsubscribeAudit) unsubscribeAudit(); }

// ==========================================
// DASHBOARD FILTER & STATS
// ==========================================
const dateStartInput = document.getElementById('filter-date-start'); const dateEndInput = document.getElementById('filter-date-end');
dateStartInput.addEventListener('change', applyFiltersAndStats); dateEndInput.addEventListener('change', applyFiltersAndStats);

window.setShortcutTanggal = (type) => {
    const today = new Date(); const endStr = today.toISOString().split('T')[0]; let startStr = "";
    if (type === 'hari-ini') { startStr = endStr; } else if (type === '7-hari') { const d = new Date(); d.setDate(d.getDate() - 7); startStr = d.toISOString().split('T')[0]; } else if (type === 'bulan-ini') { startStr = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2, '0')}-01`; } else { startStr = ""; dateEndInput.value = ""; dateStartInput.value = ""; applyFiltersAndStats(); return; }
    dateStartInput.value = startStr; dateEndInput.value = endStr; applyFiltersAndStats();
};

async function applyFiltersAndStats() {
    const startVal = dateStartInput.value; const endVal = dateEndInput.value;
    let startTs = startVal ? new Date(startVal + "T00:00:00").getTime() : 0; 
    let endTs = endVal ? new Date(endVal + "T23:59:59").getTime() : Infinity;
    
    let allSales = [...riwayatPenjualan];
    
    const offlineSales = await loadOfflineTransactions();
    if (offlineSales && offlineSales.length > 0) { 
        allSales = [...offlineSales.reverse(), ...allSales]; 
    }

    dataPenjualanTerfilter = allSales.filter(sale => {
        const w = sale.waktu || sale.waktuLokal; if (!w) return false;
        const ms = w.seconds ? w.seconds * 1000 : new Date(w).getTime();
        return ms >= startTs && ms <= endTs;
    });

    let totalOmset = 0; let totalTrx = dataPenjualanTerfilter.length; let totalItems = 0; let produkCounts = {};
    dataPenjualanTerfilter.forEach(sale => { 
        totalOmset += sale.totalAkhir || 0; 
        if (Array.isArray(sale.items)) { sale.items.forEach(i => { totalItems += i.qty || 0; produkCounts[i.nama||'Item'] = (produkCounts[i.nama||'Item'] || 0) + i.qty; }); } 
    });

    document.getElementById('dash-omset').textContent = toRupiah(totalOmset); document.getElementById('dash-transaksi').textContent = totalTrx; document.getElementById('dash-items').innerHTML = `${totalItems} <span class="text-lg font-medium text-dark-2">Item</span>`;
    const sortedProduk = Object.entries(produkCounts).sort((a,b) => b[1] - a[1]).slice(0,5); 
    renderChart(sortedProduk.map(p => p[0]), sortedProduk.map(p => p[1]));
    renderRiwayatTable();
}

function renderChart(labels, values) {
    if (typeof Chart === 'undefined') return; 
    const ctx = document.getElementById('chartProdukTerlaris'); if(!ctx) return; if (chartInstance) chartInstance.destroy();
    if (labels.length === 0) { labels = ["Belum ada data"]; values = [0]; }
    chartInstance = new Chart(ctx, { type: 'bar', data: { labels: labels, datasets: [{ label: 'Qty Terjual', data: values, backgroundColor: '#1971c2', borderRadius: 6 }] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { grid: { display: false }, ticks: { color: '#909296', font: { family: 'Inter', size: 11 } } }, y: { grid: { color: '#373A40' }, ticks: { color: '#909296', font: { family: 'Inter', size: 11 }, precision: 0 } } } } });
}

function renderLowStock() {
    const list = document.getElementById('dash-low-stock-list'); if(!list) return;
    const lowStockItems = databaseBarang.filter(i => (i.stok || 0) <= 5);
    if(lowStockItems.length === 0) { list.innerHTML = `<p class="text-xs text-dark-2 italic">Semua stok produk aman.</p>`; return; }
    list.innerHTML = lowStockItems.map(i => `<div class="flex justify-between items-center bg-dark-8 p-3 rounded-xl border border-dark-4"><span class="text-xs font-semibold text-gray-200">${i.nama}</span><span class="px-2.5 py-1 text-[10px] font-bold rounded-md ${i.stok===0?'bg-red-900/40 text-red-400 border border-red-900':'bg-amber-900/40 text-amber-400 border border-amber-900'}">Stok: ${i.stok||0}</span></div>`).join('');
}

// ==========================================
// KASIR & KERANJANG BELANJA
// ==========================================
const payMethods = { 'Tunai': document.getElementById('pay-method-cash'), 'QRIS': document.getElementById('pay-method-qris'), 'Debit': document.getElementById('pay-method-debit'), 'Transfer': document.getElementById('pay-method-tf') };
Object.entries(payMethods).forEach(([method, btn]) => {
    btn.addEventListener('click', () => {
        selectedPaymentMethod = method;
        Object.values(payMethods).forEach(b => b.className = "py-1 text-[10px] font-semibold text-dark-1 hover:text-gray-100 rounded-lg transition-all");
        btn.className = "py-1 text-[10px] font-semibold bg-mantine-blue text-white rounded-lg transition-all";
        if (method === 'Tunai') {
            document.getElementById('cash-payment-fields').classList.remove('hidden'); document.getElementById('non-cash-payment-fields').classList.add('hidden'); document.getElementById('cash-return-row').classList.remove('hidden'); document.getElementById('cash-paid').value = "";
        } else {
            document.getElementById('cash-payment-fields').classList.add('hidden'); document.getElementById('non-cash-payment-fields').classList.remove('hidden'); document.getElementById('cash-return-row').classList.add('hidden'); document.getElementById('non-cash-title').textContent = `Bayar via ${method}`; document.getElementById('payment-ref-code').value = "";
        }
        hitungUangKembalian();
    });
});

document.getElementById('btn-hold-bill').addEventListener('click', () => {
    if (keranjang.length === 0) return alert("Keranjang kosong!");
    let holdName = prompt("Nama Penanda (cth: Meja 5 / Bpk Andi):"); if (holdName === null) return;
    holdName = holdName.trim() || `Order #${Date.now().toString().slice(-4)}`;
    const heldBills = JSON.parse(localStorage.getItem('pos_held_bills') || '[]');
    heldBills.push({ id: Date.now().toString(), tag: holdName, waktu: new Date().toLocaleString('id-ID'), items: keranjang, diskon: parseFloat(document.getElementById('cart-discount').value) || 0, activeMember: activeMember });
    localStorage.setItem('pos_held_bills', JSON.stringify(heldBills));
    keranjang = []; activeMember = null; document.getElementById('cart-discount').value = ""; document.getElementById('btn-remove-member').click(); renderKeranjang(); updateHoldCountBadge(); alert("Pesanan disimpan.");
});

document.getElementById('btn-recall-bill').addEventListener('click', () => { renderHoldModalList(); document.getElementById('hold-modal').classList.remove('hidden'); });

function updateHoldCountBadge() { document.getElementById('hold-count-badge').textContent = JSON.parse(localStorage.getItem('pos_held_bills') || '[]').length; }

function renderHoldModalList() {
    const listContainer = document.getElementById('hold-bills-list'); const heldBills = JSON.parse(localStorage.getItem('pos_held_bills') || '[]');
    if (heldBills.length === 0) { listContainer.innerHTML = `<p class="text-xs text-dark-2 italic text-center py-4">Kosong.</p>`; return; }
    listContainer.innerHTML = heldBills.map(bill => `
        <div class="bg-dark-8 p-3 rounded-xl border border-dark-4 flex justify-between items-center gap-3">
            <div class="flex-1 min-w-0"><div class="flex justify-between items-center mb-1"><span class="font-bold text-xs text-amber-400 truncate">${bill.tag}</span></div><p class="text-[11px] text-dark-1 truncate">${bill.items.map(i => `${i.nama} (${i.qty}x)`).join(', ')}</p></div>
            <div class="flex gap-1 shrink-0"><button onclick="window.loadHeldBill('${bill.id}')" class="px-2.5 py-1 bg-mantine-blue text-white rounded text-xs font-semibold">Buka</button><button onclick="window.deleteHeldBill('${bill.id}')" class="px-2.5 py-1 bg-red-950/40 text-red-400 border border-red-900 rounded text-xs font-semibold">🗑️</button></div>
        </div>`).join('');
}

window.loadHeldBill = (id) => {
    if (keranjang.length > 0 && !confirm("Gantikan keranjang aktif dengan orderan ini?")) return;
    const heldBills = JSON.parse(localStorage.getItem('pos_held_bills') || '[]'); const idx = heldBills.findIndex(b => b.id === id);
    if (idx > -1) {
        const bill = heldBills[idx]; keranjang = bill.items; document.getElementById('cart-discount').value = bill.diskon || "";
        activeMember = bill.activeMember || null; if (activeMember) showActiveMemberUI(); else document.getElementById('btn-remove-member').click();
        heldBills.splice(idx, 1); localStorage.setItem('pos_held_bills', JSON.stringify(heldBills));
        document.getElementById('hold-modal').classList.add('hidden'); renderKeranjang(); updateHoldCountBadge();
    }
};

window.deleteHeldBill = (id) => { const heldBills = JSON.parse(localStorage.getItem('pos_held_bills') || '[]'); localStorage.setItem('pos_held_bills', JSON.stringify(heldBills.filter(b => b.id !== id))); renderHoldModalList(); updateHoldCountBadge(); };

document.getElementById('btn-check-member').addEventListener('click', async () => {
    const phone = document.getElementById('member-search-input').value.trim(); if (!phone) return;
    if (!navigator.onLine) { alert("Peringatan: Fitur pengecekan member membutuhkan internet."); return; }
    
    document.getElementById('btn-check-member').disabled = true; document.getElementById('btn-check-member').textContent = "...";
    try {
        const docSnap = await getDoc(doc(db, "members", phone));
        if (docSnap.exists()) { activeMember = { id: phone, ...docSnap.data() }; showActiveMemberUI(); } 
        else { if (confirm(`Member ${phone} belum terdaftar. Daftarkan sekarang?`)) { document.getElementById('member-reg-phone').value = phone; document.getElementById('member-reg-name').value = ""; document.getElementById('member-modal').classList.remove('hidden'); } }
    } catch(e) { } finally { document.getElementById('btn-check-member').disabled = false; document.getElementById('btn-check-member').textContent = "Cari"; }
});

document.getElementById('member-form').addEventListener('submit', async (e) => {
    e.preventDefault(); 
    if (!navigator.onLine) return alert("Peringatan: Tidak bisa mendaftarkan member baru saat offline.");
    const phone = document.getElementById('member-reg-phone').value.trim(); const name = document.getElementById('member-reg-name').value.trim();
    await setDoc(doc(db, "members", phone), { nama: name, poin: 0 }); activeMember = { id: phone, nama: name, poin: 0 }; showActiveMemberUI(); document.getElementById('member-modal').classList.add('hidden');
});

document.getElementById('btn-remove-member').addEventListener('click', () => { activeMember = null; document.getElementById('member-select-zone').classList.remove('hidden'); document.getElementById('member-active-zone').classList.add('hidden'); document.getElementById('btn-remove-member').classList.add('hidden'); document.getElementById('member-search-input').value = ""; });

function showActiveMemberUI() { document.getElementById('member-select-zone').classList.add('hidden'); document.getElementById('member-active-zone').classList.remove('hidden'); document.getElementById('btn-remove-member').classList.remove('hidden'); document.getElementById('member-active-name').textContent = `⭐ ${activeMember.nama.toUpperCase()}`; document.getElementById('member-active-points').textContent = `Poin: ${activeMember.poin || 0}`; }

document.getElementById('kasir-search').addEventListener('input', (e) => { kataKunciPencarian = e.target.value.toLowerCase(); renderKatalogKasir(); });

function renderKatalogKasir() {
    const categoriesSet = new Set(databaseBarang.map(i => i.kategori || 'Umum'));
    document.getElementById('kasir-categories').innerHTML = `<button onclick="window.setFilterKategori('Semua')" class="px-3 py-1.5 rounded-lg text-xs font-medium shrink-0 ${filterKategoriAktif==='Semua'?'bg-mantine-blue text-white':'bg-dark-5 text-dark-1'}">Semua</button>` + 
        Array.from(categoriesSet).map(cat => `<button onclick="window.setFilterKategori('${cat}')" class="px-3 py-1.5 rounded-lg text-xs font-medium shrink-0 ${filterKategoriAktif===cat?'bg-mantine-blue text-white':'bg-dark-5 text-dark-1'}">${cat}</button>`).join('');

    const filtered = databaseBarang.filter(i => (filterKategoriAktif === 'Semua' || (i.kategori||'Umum') === filterKategoriAktif) && ((i.nama||'').toLowerCase().includes(kataKunciPencarian) || (i.barcode && i.barcode.toLowerCase().includes(kataKunciPencarian))));
    if (filtered.length === 0) { document.getElementById('kasir-katalog').innerHTML = `<p class="text-xs text-dark-2 italic col-span-full text-center py-8">Kosong.</p>`; return; }
    document.getElementById('kasir-katalog').innerHTML = filtered.map(i => `
        <div onclick="window.tambahKeKeranjang('${i.id}')" class="bg-dark-6 p-4 rounded-xl border border-dark-4 hover:border-mantine-blue cursor-pointer select-none flex flex-col justify-between active:scale-[0.98]">
            <div><div class="flex justify-between items-start gap-1"><span class="text-[10px] font-bold text-dark-2 uppercase truncate max-w-[80px]">${i.kategori||'Umum'}</span><span class="text-[10px] px-1.5 py-0.5 rounded font-bold ${(i.stok||0)<=3?'bg-red-900/30 text-red-400':'bg-dark-5 text-dark-2'}">Stok: ${i.stok||0}</span></div><h4 class="font-bold text-xs text-gray-100 mt-1.5 leading-snug">${i.nama||'Item'}</h4></div>
            <p class="text-sm font-extrabold text-gray-300 mt-3">${toRupiah(i.harga)}</p>
        </div>`).join('');
}

window.setFilterKategori = (cat) => { filterKategoriAktif = cat; renderKatalogKasir(); };

window.tambahKeKeranjang = (id) => {
    const item = databaseBarang.find(i => i.id === id); if(!item || (item.stok||0) <= 0) return alert("Stok habis!");
    const existing = keranjang.find(k => k.id === id);
    if (existing) { if(existing.qty >= item.stok) return alert("Melebihi stok!"); existing.qty++; } else { keranjang.push({ id: item.id, nama: item.nama, harga: item.harga||0, qty: 1 }); }
    playBeep(); renderKeranjang();
};

window.ubahQtyCart = async (id, delta) => {
    const index = keranjang.findIndex(k => k.id === id); if(index === -1) return;
    const itemDb = databaseBarang.find(i => i.id === id);
    keranjang[index].qty += delta;
    if (keranjang[index].qty <= 0) { 
        const removedItem = keranjang[index]; keranjang.splice(index, 1); 
        await logActivity("CART_HAPUS_ITEM", `Kasir membuang [${removedItem.nama}] dari keranjang belanja.`); 
    } 
    else if (keranjang[index].qty > (itemDb.stok||0)) { keranjang[index].qty = itemDb.stok||0; }
    playBeep(); renderKeranjang();
};

document.getElementById('cart-discount').addEventListener('input', hitungUangKembalian); document.getElementById('cash-paid').addEventListener('input', hitungUangKembalian);

function renderKeranjang() {
    document.getElementById('cart-total-qty-badge').textContent = `${keranjang.reduce((a, b) => a + b.qty, 0)} Item`;
    if(keranjang.length === 0) {
        document.getElementById('cart-list').innerHTML = `<div class="flex flex-col items-center text-dark-3 py-12"><p class="text-xs italic">Keranjang kosong</p></div>`;
        document.getElementById('cart-subtotal').textContent = "Rp 0"; document.getElementById('cart-grand-total').textContent = "Rp 0"; document.getElementById('btn-checkout').disabled = true; document.getElementById('btn-checkout').className = "w-full py-3 bg-dark-5 text-dark-3 font-bold rounded-xl cursor-not-allowed text-xs uppercase"; return;
    }
    document.getElementById('cart-list').innerHTML = keranjang.map(k => `
        <div class="bg-dark-6 p-3 rounded-xl border border-dark-4 flex justify-between items-center gap-3">
            <div class="flex-1 min-w-0"><h5 class="text-xs font-bold text-gray-200 truncate">${k.nama}</h5><p class="text-[11px] text-dark-2 mt-0.5">${toRupiah(k.harga)} x ${k.qty}</p></div>
            <div class="flex items-center gap-2 bg-dark-8 p-1 rounded-lg border border-dark-4 shrink-0"><button onclick="window.ubahQtyCart('${k.id}', -1)" class="w-6 h-6 bg-dark-5 text-gray-100 rounded font-bold">-</button><span class="text-xs font-bold px-1 text-gray-200">${k.qty}</span><button onclick="window.ubahQtyCart('${k.id}', 1)" class="w-6 h-6 bg-dark-5 text-gray-100 rounded font-bold">+</button></div>
        </div>`).join('');
    hitungUangKembalian();
}

function hitungUangKembalian() {
    globalSubtotal = keranjang.reduce((acc, i) => acc + ((i.harga||0) * i.qty), 0);
    globalDiskon = parseFloat(document.getElementById('cart-discount').value) || 0;
    globalGrandTotal = Math.max(0, globalSubtotal - globalDiskon);
    document.getElementById('cart-subtotal').textContent = toRupiah(globalSubtotal); document.getElementById('cart-grand-total').textContent = toRupiah(globalGrandTotal);

    const btnCheckout = document.getElementById('btn-checkout');
    if (selectedPaymentMethod === 'Tunai') {
        const cashPaidVal = parseFloat(document.getElementById('cash-paid').value) || 0;
        document.getElementById('cash-return').textContent = toRupiah(Math.max(0, cashPaidVal - globalGrandTotal));
        if (cashPaidVal >= globalGrandTotal && keranjang.length > 0) { btnCheckout.disabled = false; btnCheckout.className = "w-full py-3 bg-mantine-blue text-white font-bold rounded-xl text-xs uppercase cursor-pointer"; } else { btnCheckout.disabled = true; btnCheckout.className = "w-full py-3 bg-dark-5 text-dark-3 font-bold rounded-xl cursor-not-allowed text-xs uppercase"; }
    } else {
        document.getElementById('cash-return').textContent = "Rp 0";
        if(keranjang.length > 0) { btnCheckout.disabled = false; btnCheckout.className = "w-full py-3 bg-mantine-blue text-white font-bold rounded-xl text-xs uppercase cursor-pointer"; } else { btnCheckout.disabled = true; btnCheckout.className = "w-full py-3 bg-dark-5 text-dark-3 font-bold rounded-xl cursor-not-allowed text-xs uppercase"; }
    }
}

// CHECKOUT LOGIC
document.getElementById('btn-checkout').addEventListener('click', async () => {
    if(keranjang.length === 0 || !activeShiftSession) return;
    const btnCheckout = document.getElementById('btn-checkout'); btnCheckout.disabled = true; btnCheckout.textContent = "MEMPROSES...";
    
    const cashPaidVal = selectedPaymentMethod === 'Tunai' ? (parseFloat(document.getElementById('cash-paid').value) || 0) : globalGrandTotal;
    const refCode = document.getElementById('payment-ref-code') ? document.getElementById('payment-ref-code').value.trim() : '';

    const trxData = {
        items: keranjang, subtotal: globalSubtotal, diskon: globalDiskon, totalAkhir: globalGrandTotal, uangBayar: cashPaidVal, kembalian: Math.max(0, cashPaidVal - globalGrandTotal), metodePembayaran: selectedPaymentMethod, refCode: refCode, namaKasir: (auth.currentUser ? auth.currentUser.email.split('@')[0] : 'Sistem'), shiftId: activeShiftSession.id, memberId: activeMember ? activeMember.id : null, memberName: activeMember ? activeMember.nama : null
    };

    try {
        if (navigator.onLine) {
            trxData.waktu = serverTimestamp();
            await addDoc(salesRef, trxData);
            for (const item of keranjang) { await updateDoc(doc(db, "barang", item.id), { stok: increment(-item.qty) }); }
            await updateDoc(doc(db, "shift", activeShiftSession.id), { totalPenjualan: increment(globalGrandTotal) });
            if (activeMember) { const addPoin = Math.floor(globalGrandTotal / 10000); if (addPoin > 0) await updateDoc(doc(db, "members", activeMember.id), { poin: increment(addPoin) }); }
            await logActivity("CHECKOUT_ONLINE", `Penjualan Rp ${toRupiah(globalGrandTotal)} diproses.`); 
        } else {
            trxData.waktuLokal = new Date().toISOString();
            trxData.isOfflinePending = true;
            await saveTransactionOffline(trxData);
            
            for (const item of keranjang) {
                const found = databaseBarang.find(x => x.id === item.id);
                if (found) found.stok = Math.max(0, (found.stok||0) - item.qty);
            }
            localStorage.setItem("pos_cached_items", JSON.stringify(databaseBarang));

            activeShiftSession.totalPenjualan = (activeShiftSession.totalPenjualan || 0) + globalGrandTotal;
            localStorage.setItem("pos_cached_shift", JSON.stringify(activeShiftSession));
            
            updateShiftUI(true); renderKatalogKasir(); renderGudangList(); renderLowStock();
            alert("⚠️ KONEKSI TERPUTUS! Transaksi dicetak & diamankan di browser.");
        }

        cetakStrukThermal({...trxData, waktu: { seconds: Date.now()/1000 }}); 
        keranjang = []; document.getElementById('cart-discount').value = ""; document.getElementById('cash-paid').value = ""; document.getElementById('btn-remove-member').click(); renderKeranjang();
        applyFiltersAndStats(); 
    } catch(err) { alert("Error: " + err.message); } finally { btnCheckout.disabled = false; btnCheckout.textContent = "Selesaikan Transaksi"; hitungUangKembalian(); }
});

function cetakStrukThermal(data) {
    const printArea = document.getElementById('print-area');
    const tglStruk = data.waktuLokal ? new Date(data.waktuLokal) : (data.waktu && data.waktu.seconds ? new Date(data.waktu.seconds * 1000) : new Date());
    printArea.innerHTML = `
        <div style="text-align:center; margin-bottom:10px; font-family:monospace; color:black;">
            <h3 style="margin:0; font-size:16px;">⚡ TOKO MODERN PRO ⚡</h3><p style="margin:2px 0; font-size:10px;">Kasir: ${data.namaKasir ? data.namaKasir.toUpperCase() : 'SISTEM'}</p><p style="margin:2px 0; font-size:10px;">${tglStruk.toLocaleString('id-ID')}</p>
        </div><hr style="border-top:1px dashed black; margin:5px 0;">
        <div style="margin-bottom:10px; font-family:monospace; color:black;">${(data.items||[]).map(i => `<div style="display:flex; justify-content:space-between; font-size:12px; margin-bottom:2px;"><span>${i.nama||'Item'} (x${i.qty})</span><span>${toRupiah((i.harga||0) * i.qty)}</span></div>`).join('')}</div>
        <hr style="border-top:1px dashed black; margin:5px 0;">
        <div style="font-family:monospace; font-size:12px; color:black; display:flex; flex-direction:column;">
            <div style="display:flex; justify-content:space-between;"><span>Subtotal:</span><span>${toRupiah(data.subtotal)}</span></div>
            <div style="display:flex; justify-content:space-between;"><span>Diskon:</span><span>-${toRupiah(data.diskon)}</span></div>
            <div style="display:flex; justify-content:space-between; font-weight:bold;"><span>Total:</span><span>${toRupiah(data.totalAkhir)}</span></div>
            <div style="display:flex; justify-content:space-between; font-size:11px; margin-top:4px;"><span>Metode:</span><span>${data.metodePembayaran||'Tunai'}</span></div>
            ${data.memberName ? `<div style="display:flex; justify-content:space-between; font-size:11px;"><span>Member:</span><span>${data.memberName.toUpperCase()}</span></div>` : ''}
            <hr style="border-top:1px dashed black; margin:5px 0;">
            <div style="display:flex; justify-content:space-between;"><span>Bayar:</span><span>${toRupiah(data.uangBayar)}</span></div><div style="display:flex; justify-content:space-between;"><span>Kembali:</span><span>${toRupiah(data.kembalian)}</span></div>
        </div><div style="text-align:center; margin-top:15px; font-size:10px; font-family:monospace; color:black;"><p style="margin:0;">Terima Kasih!</p></div>`;
    window.print();
}

// ==========================================
// MANAJEMEN GUDANG
// ==========================================
const itemForm = document.getElementById('item-form');
itemForm.addEventListener('submit', async (e) => {
    e.preventDefault(); 
    if (!navigator.onLine) return alert("Peringatan: Anda membutuhkan koneksi internet untuk menambah atau mengubah master barang.");
    
    const id = document.getElementById('item-id').value;
    const data = { barcode: document.getElementById('item-barcode').value.trim(), nama: document.getElementById('item-name').value.trim(), kategori: document.getElementById('item-category').value.trim() || 'Umum', harga: parseFloat(document.getElementById('item-price').value)||0, stok: parseInt(document.getElementById('item-stock').value)||0 };
    if(id) { 
        await updateDoc(doc(db, "barang", id), data); 
        await logActivity("GUDANG_UBAH", `Memperbarui produk [${data.nama}]. Stok: ${data.stok}, Harga: ${toRupiah(data.harga)}`); 
    } else { 
        await addDoc(itemsRef, data); 
        await logActivity("GUDANG_TAMBAH", `Memasukkan produk baru [${data.nama}] qty: ${data.stok}`); 
    }
    window.resetForm();
});

window.editBarang = (id) => {
    const item = databaseBarang.find(x => x.id === id); if (!item) return;
    document.getElementById('form-title').textContent = "Ubah Data Barang"; document.getElementById('item-id').value = item.id; document.getElementById('item-barcode').value = item.barcode || ""; document.getElementById('item-name').value = item.nama; document.getElementById('item-category').value = item.kategori || 'Umum'; document.getElementById('item-price').value = item.harga || 0; document.getElementById('item-stock').value = item.stok || 0; document.getElementById('btn-cancel').classList.remove('hidden');
};

window.hapusBarang = async (id) => { 
    if (!navigator.onLine) return alert("Peringatan: Anda membutuhkan koneksi internet untuk menghapus data master barang.");
    const item = databaseBarang.find(x => x.id === id); if(!item) return;
    if(confirm(`Hapus produk ${item.nama} secara permanen?`)) { await logActivity("GUDANG_HAPUS", `Menghapus produk [${item.nama}] dari master data.`); await deleteDoc(doc(db, "barang", id)); } 
};

window.resetForm = () => { document.getElementById('form-title').textContent = "Tambah Barang Baru"; itemForm.reset(); document.getElementById('item-id').value = ""; document.getElementById('btn-cancel').classList.add('hidden'); };
document.getElementById('btn-cancel').addEventListener('click', window.resetForm);

function renderGudangList() {
    const container = document.getElementById('gudang-list'); if(!container) return;
    if(databaseBarang.length === 0) { container.innerHTML = `<p class="text-xs text-dark-2 italic text-center py-6">Gudang kosong.</p>`; return; }
    container.innerHTML = databaseBarang.map(i => `
        <div class="bg-dark-6 p-4 rounded-xl border border-dark-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div><span class="text-[9px] font-bold text-dark-2 mb-0.5 block">${i.barcode ? '📟 '+i.barcode : (i.kategori||'Umum')}</span><h3 class="font-bold text-gray-100 text-sm">${i.nama||'Item'}</h3><div class="flex items-center gap-3 mt-1.5"><span class="text-sm font-extrabold text-mantine-blue">${toRupiah(i.harga)}</span><span class="text-[10px] font-bold uppercase tracking-wider px-2 py-1 bg-dark-5 text-dark-0 rounded-md border border-dark-4 ${(i.stok||0)<=5?'!bg-red-900/30 !text-red-400':''}">Stok: ${i.stok||0}</span></div></div>
            <div class="flex gap-2"><button onclick="window.editBarang('${i.id}')" class="px-3 py-2 bg-dark-5 hover:bg-dark-4 text-xs font-bold rounded-xl">Ubah</button><button onclick="window.hapusBarang('${i.id}')" class="px-3 py-2 bg-red-950/20 text-red-400 border border-red-950 text-xs font-bold rounded-xl">Hapus</button></div>
        </div>`).join('');
}

// ==========================================
// RIWAYAT, REKONSILIASI, EKSPOR EXCEL
// ==========================================
function renderRiwayatTable() {
    const tbody = document.getElementById('riwayat-list'); if(!tbody) return;
    if(dataPenjualanTerfilter.length === 0) { tbody.innerHTML = `<tr><td colspan="5" class="px-6 py-8 text-center text-xs text-dark-2 italic">Belum ada transaksi terdaftar.</td></tr>`; return; }
    tbody.innerHTML = dataPenjualanTerfilter.map(trx => {
        const itemsStr = Array.isArray(trx.items) ? trx.items.map(i => `${i.nama||'Item'} (${i.qty}x)`).join(', ') : '';
        return `
            <tr class="hover:bg-dark-5/40">
                <td class="px-6 py-4 whitespace-nowrap text-xs text-dark-1 font-medium">${formatTanggal(trx.waktu || trx.waktuLokal)} ${trx.isOfflinePending ? '<span class="text-amber-500 font-bold ml-1">(Offline)</span>' : ''}</td>
                <td class="px-6 py-4 text-xs text-gray-200 max-w-xs truncate font-medium" title="${itemsStr}">${itemsStr}</td>
                <td class="px-6 py-4 whitespace-nowrap text-xs text-dark-1 font-medium"><span class="px-2 py-0.5 bg-dark-5 rounded text-gray-300 font-semibold text-[11px]">${trx.metodePembayaran || 'Tunai'}</span></td>
                <td class="px-6 py-4 whitespace-nowrap text-xs text-gray-100 font-bold">${toRupiah(trx.totalAkhir)}</td>
                <td class="px-6 py-4 whitespace-nowrap text-right text-xs"><button onclick="window.reprintTrx('${trx.id || trx.localId}')" class="px-2.5 py-1.5 bg-dark-5 hover:bg-dark-4 text-dark-0 rounded-md font-medium">Struk 🖨️</button></td>
            </tr>`;
    }).join('');
}

window.reprintTrx = async (id) => { 
    const offlineTrx = dataPenjualanTerfilter.find(t => t.localId == id || t.id == id);
    if (offlineTrx) { 
        cetakStrukThermal(offlineTrx); 
    } else { 
        if (!navigator.onLine) return alert("Peringatan: Fitur cetak struk dari database lama membutuhkan internet.");
        const docSnap = await getDoc(doc(db, "penjualan", id)); 
        if(docSnap.exists()) { cetakStrukThermal(docSnap.data()); } 
    }
};

function renderShiftLogs() {
    const tbody = document.getElementById('shift-log-list'); if(!tbody) return;
    tbody.innerHTML = dataShiftAll.map(s => `
        <tr class="hover:bg-dark-5/40 border-b border-dark-4">
            <td class="px-4 py-3"><p class="font-bold text-gray-200">${(s.namaKasir||'Unknown').toUpperCase()}</p><p class="text-[10px] text-dark-2 mt-0.5">Buka: ${formatTanggal(s.waktuBuka)}</p></td>
            <td class="px-4 py-3 text-dark-1">${toRupiah(s.modalAwal)}</td>
            <td class="px-4 py-3 text-dark-1">${toRupiah(s.totalPenjualan || 0)}</td>
            <td class="px-4 py-3 text-dark-1">${s.status==='buka'?'-':toRupiah(s.uangFisikAktual)}</td>
            <td class="px-4 py-3">${s.status==='buka'?'<span class="text-green-400 font-bold bg-green-950/30 px-2 py-0.5 rounded border border-green-900 text-[10px]">AKTIF</span>':((s.selisih||0)===0?'<span class="text-green-400 font-bold">Pas</span>':((s.selisih||0)>0?`<span class="text-blue-400 font-bold">+${toRupiah(s.selisih||0)}</span>`:`<span class="text-red-400 font-bold">${toRupiah(s.selisih||0)}</span>`))}</td>
        </tr>`).join('');
}

function renderAuditLogs() {
    const tbody = document.getElementById('audit-log-list'); if(!tbody) return;
    tbody.innerHTML = auditLogsData.map(log => `
        <tr class="hover:bg-dark-5/40 border-b border-dark-4">
            <td class="px-4 py-3">
                <div class="flex justify-between mb-1">
                    <span class="font-bold text-[10px] text-mantine-blue uppercase">${log.user||'Sistem'}</span>
                    <span class="text-[9px] text-dark-3">${formatTanggal(log.timestamp)}</span>
                </div>
                <span class="inline-block px-1.5 py-0.5 bg-dark-5 text-[9px] font-bold rounded mb-1 text-gray-300 border border-dark-4">${log.action||'-'}</span>
                <p class="text-[11px] text-dark-1 leading-snug">${log.detail||'-'}</p>
            </td>
        </tr>`).join('');
}

document.getElementById('btn-export-excel').addEventListener('click', () => {
    if (dataPenjualanTerfilter.length === 0) return alert("Data kosong.");
    const startInputDOM = document.getElementById('filter-date-start');
    const fileNameDate = startInputDOM ? (startInputDOM.value || 'Semua') : 'Semua';
    const dataExcel = dataPenjualanTerfilter.map(trx => { 
        const itemsStr = Array.isArray(trx.items) ? trx.items.map(i => `${i.nama||'Item'} (${i.qty}x)`).join(', ') : '';
        return { 'Waktu': trx.waktu && trx.waktu.seconds ? new Date(trx.waktu.seconds * 1000).toLocaleString('id-ID') : (trx.waktuLokal || '-'), 'Daftar Barang': itemsStr, 'Metode Pembayaran': trx.metodePembayaran || 'Tunai', 'Subtotal': trx.subtotal || 0, 'Diskon': trx.diskon || 0, 'Grand Total': trx.totalAkhir || 0, 'Uang Masuk/Bayar': trx.uangBayar || 0, 'Kembalian': trx.kembalian || 0 }; 
    });
    const worksheet = XLSX.utils.json_to_sheet(dataExcel); const workbook = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(workbook, worksheet, "Laporan Omset");
    XLSX.writeFile(workbook, `Laporan_POS_${fileNameDate}.xlsx`);
});