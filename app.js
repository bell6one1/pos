import { db, auth, itemsRef, salesRef, shiftsRef, membersRef, auditLogsRef } from './firebase-config.js';
import { addDoc, doc, getDoc, setDoc, updateDoc, deleteDoc, onSnapshot, query, orderBy, increment, serverTimestamp, where, limit } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { signInWithEmailAndPassword, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";

let databaseBarang = []; 
let riwayatPenjualan = []; 
let dataPenjualanTerfilter = []; 
let dataShiftAll = []; 
let auditLogsData = []; 
let keranjang = JSON.parse(localStorage.getItem("pos_recovery_cart") || "[]");

let chartInstance = null; 
let unsubscribeItems = null; 
let unsubscribeSales = null; 
let unsubscribeShifts = null; 
let unsubscribeAudit = null; 
let unsubscribeActiveShift = null;

let filterKategoriAktif = "Semua"; 
let kataKunciPencarian = ""; 
let globalSubtotal = 0; 
let globalDiskon = 0; 
let globalGrandTotal = 0;
let currentUserRole = "kasir"; 
let activeShiftSession = null; 
let currentUserId = null;
let selectedPaymentMethod = "Tunai"; 
let activeMember = JSON.parse(localStorage.getItem("pos_recovery_member") || "null");
let isSyncingOffline = false;

const toRupiah = (angka) => new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 }).format(Math.round(angka) || 0);

const formatTanggal = (timestamp) => { 
    if(!timestamp) return 'Memproses...'; 
    try {
        if(typeof timestamp === 'string') return new Date(timestamp).toLocaleString('id-ID', { dateStyle: 'short', timeStyle: 'short' });
        if(timestamp.seconds) return new Date(timestamp.seconds * 1000).toLocaleString('id-ID', { dateStyle: 'short', timeStyle: 'short' });
        if(timestamp instanceof Date) return timestamp.toLocaleString('id-ID', { dateStyle: 'short', timeStyle: 'short' });
        return '-';
    } catch(e) { return '-'; }
};

const escapeHTML = (str) => {
    if (str === null || str === undefined) return '';
    return String(str).replace(/[&<>'"]/g, match => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[match]));
};

const escapeJS = (str) => String(str).replace(/'/g, "\\'").replace(/"/g, '&quot;');

try {
    const cachedItems = localStorage.getItem("pos_cached_items");
    if (cachedItems) databaseBarang = JSON.parse(cachedItems);
    const cachedShift = localStorage.getItem("pos_cached_shift");
    if (cachedShift) activeShiftSession = JSON.parse(cachedShift);
} catch(e) {}

function clearMemoryData() {
    databaseBarang = []; 
    riwayatPenjualan = []; 
    dataPenjualanTerfilter = []; 
    dataShiftAll = []; 
    auditLogsData = []; 
    keranjang = [];
    activeShiftSession = null; 
    currentUserId = null;
    activeMember = null;
    if (chartInstance) {
        chartInstance.destroy();
        chartInstance = null;
    }
}

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
        const req = tx.objectStore(OFFLINE_STORE_NAME).getAll();
        return new Promise(resolve => { 
            req.onsuccess = () => resolve(req.result || []); 
            req.onerror = () => resolve([]); 
        });
    } catch(e) { return []; }
}

async function saveTransactionOffline(saleData) {
    try {
        const idb = await initIndexedDB();
        const tx = idb.transaction(OFFLINE_STORE_NAME, "readwrite");
        tx.objectStore(OFFLINE_STORE_NAME).add(saleData);
        await tx.complete;
        return true;
    } catch (e) { return false; }
}

async function syncOfflineTransactions() {
    if (!navigator.onLine || isSyncingOffline) return;
    const indicator = document.getElementById('offline-indicator');
    if (indicator) indicator.classList.add('hidden');
    isSyncingOffline = true;

    try {
        const idb = await initIndexedDB();
        const request = idb.transaction(OFFLINE_STORE_NAME, "readonly").objectStore(OFFLINE_STORE_NAME).getAll();
        
        request.onsuccess = async () => {
            const pendingSales = request.result;
            let successCount = 0;
            let syncedIds = [];
            
            if (pendingSales.length > 0) {
                for (const sale of pendingSales) {
                    try {
                        const localId = sale.localId;
                        delete sale.localId; delete sale.isOfflinePending;
                        sale.waktu = sale.waktuLokal ? new Date(sale.waktuLokal) : serverTimestamp(); 
                        
                        await addDoc(salesRef, sale); 
                        
                        for (const item of sale.items) { 
                            try { await updateDoc(doc(db, "barang", item.id), { stok: increment(-item.qty) }); } catch(e) {}
                        }
                        
                        if (sale.shiftId) {
                            await updateDoc(doc(db, "shift", sale.shiftId), { totalPenjualan: increment(sale.totalAkhir) });
                        }
                        if (sale.memberId) {
                            const addPoin = Math.floor(sale.totalAkhir / 10000); 
                            if (addPoin > 0) await updateDoc(doc(db, "members", sale.memberId), { poin: increment(addPoin) }); 
                        }
                        
                        syncedIds.push(localId);
                        successCount++;
                    } catch (e) {}
                }
            }
            
            if (syncedIds.length > 0) {
                const deleteTx = idb.transaction(OFFLINE_STORE_NAME, "readwrite");
                const deleteStore = deleteTx.objectStore(OFFLINE_STORE_NAME);
                syncedIds.forEach(id => deleteStore.delete(id));
                await deleteTx.complete;
            }
            
            const offlineLogs = JSON.parse(localStorage.getItem('pos_offline_logs') || '[]');
            if (offlineLogs.length > 0) {
                let failedLogs = [];
                for (const log of offlineLogs) {
                    try { 
                        log.timestamp = log.timestamp ? new Date(log.timestamp) : serverTimestamp(); 
                        await addDoc(auditLogsRef, log); 
                    } catch(e) { failedLogs.push(log); }
                }
                if(failedLogs.length > 0) {
                    localStorage.setItem('pos_offline_logs', JSON.stringify(failedLogs));
                } else {
                    localStorage.removeItem('pos_offline_logs');
                }
            }
            
            if(successCount > 0) {
                await logActivity("SYNC_OFFLINE", `Sukses mengunggah ${successCount} transaksi offline.`);
                alert(`Koneksi Stabil! ${successCount} data penjualan offline berhasil disinkronisasi ke server.`);
            }
            applyFiltersAndStats();
            isSyncingOffline = false;
        };
        request.onerror = () => { isSyncingOffline = false; };
    } catch(e) { isSyncingOffline = false; }
}

window.addEventListener('online', syncOfflineTransactions);
window.addEventListener('offline', () => { 
    const indicator = document.getElementById('offline-indicator');
    if (indicator) indicator.classList.remove('hidden'); 
    applyFiltersAndStats(); 
});

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
    } catch (e) {}
}

let globalAudioCtx = null;
function playBeep() {
    try {
        if (!globalAudioCtx) globalAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
        if (globalAudioCtx.state === 'suspended') globalAudioCtx.resume();
        const oscillator = globalAudioCtx.createOscillator(); 
        const gainNode = globalAudioCtx.createGain();
        oscillator.type = 'sine'; 
        oscillator.frequency.setValueAtTime(880, globalAudioCtx.currentTime); 
        gainNode.gain.setValueAtTime(0.1, globalAudioCtx.currentTime);
        oscillator.connect(gainNode); 
        gainNode.connect(globalAudioCtx.destination);
        oscillator.start(); 
        oscillator.stop(globalAudioCtx.currentTime + 0.1); 
        oscillator.onended = () => { oscillator.disconnect(); gainNode.disconnect(); };
    } catch (e) {}
}

let barcodeBuffer = ""; 
let barcodeTimeout = null;
document.addEventListener("keydown", (e) => {
    if (e.target.tagName === 'INPUT' && e.target.id !== 'kasir-search') return;
    
    if (e.key === 'Enter' && barcodeBuffer.length > 0) {
        e.preventDefault();
        const cleanBuffer = barcodeBuffer.trim().toLowerCase();
        const b = databaseBarang.find(x => (x.barcode || '').toLowerCase() === cleanBuffer || (x.id || '').toLowerCase() === cleanBuffer);
        
        if (b) { 
            if ((b.stok||0) > 0) {
                window.tambahKeKeranjang(b.id); 
                const searchInput = document.getElementById('kasir-search');
                if (searchInput) { searchInput.value = ""; kataKunciPencarian = ""; renderKatalogKasir(); }
            } else {
                alert(`Stok produk [${b.nama}] habis!`);
            }
        } else if(e.target.id === 'kasir-search') {
            alert(`Produk dengan Barcode [${barcodeBuffer}] tidak ditemukan.`);
            const searchInput = document.getElementById('kasir-search');
            if (searchInput) searchInput.value = "";
        }
        barcodeBuffer = "";
    } else {
        if (e.key.length === 1) { 
            barcodeBuffer += e.key; 
            clearTimeout(barcodeTimeout); 
            barcodeTimeout = setTimeout(() => { barcodeBuffer = ""; }, 50); 
        }
    }
});

onAuthStateChanged(auth, async (user) => {
    document.getElementById('auth-loading')?.classList.add('hidden');
    if (user) {
        currentUserId = user.uid; 
        document.getElementById('login-screen')?.classList.add('hidden'); 
        document.getElementById('app-screen')?.classList.remove('hidden');
        
        renderKatalogKasir(); 
        renderGudangList(); 
        renderLowStock(); 
        renderKeranjang(); 
        if(activeShiftSession) updateShiftUI(true);

        if (navigator.onLine) {
            try {
                const userDocSnap = await getDoc(doc(db, "pengguna", user.uid));
                if (userDocSnap.exists()) { 
                    currentUserRole = userDocSnap.data().role || "kasir"; 
                    localStorage.setItem("pos_user_role", currentUserRole); 
                } else { 
                    currentUserRole = "kasir"; 
                    await setDoc(doc(db, "pengguna", user.uid), { email: user.email, role: "kasir", nama: user.email.split('@')[0] }); 
                }
            } catch(e) { currentUserRole = localStorage.getItem("pos_user_role") || "kasir"; }
        } else {
            currentUserRole = localStorage.getItem("pos_user_role") || "kasir";
        }
        
        const nameEl = document.getElementById('user-display-name');
        const roleEl = document.getElementById('user-display-role');
        if (nameEl) nameEl.textContent = escapeHTML(user.email.split('@')[0]);
        if (roleEl) roleEl.textContent = currentUserRole === 'admin' ? 'Administrator' : 'Kasir Staff';
        
        stopRealtimeListeners(); 
        applyRoleAccess(); 
        initRealtimeListeners(); 
        checkActiveShift(user.uid); 
        updateHoldCountBadge(); 
        syncOfflineTransactions();
        if(activeMember) showActiveMemberUI();
    } else { 
        document.getElementById('app-screen')?.classList.add('hidden'); 
        document.getElementById('login-screen')?.classList.remove('hidden'); 
        stopRealtimeListeners(); 
        clearMemoryData(); 
    }
});

document.getElementById('login-form')?.addEventListener('submit', async (e) => {
    e.preventDefault(); 
    if (!navigator.onLine) return alert("Peringatan: Koneksi internet dibutuhkan untuk masuk ke dalam sistem!");
    const btnSubmit = document.getElementById('btn-login-submit'); 
    if (btnSubmit) { btnSubmit.disabled = true; btnSubmit.textContent = "Memverifikasi..."; }
    try { 
        await signInWithEmailAndPassword(auth, document.getElementById('login-email').value.trim(), document.getElementById('login-password').value); 
        e.target.reset(); 
    } catch (e) { 
        alert("Login Gagal! Periksa kredensial."); 
    } finally { 
        if (btnSubmit) { btnSubmit.disabled = false; btnSubmit.textContent = "Masuk Aplikasi"; } 
    }
});

document.getElementById('btn-logout')?.addEventListener('click', async () => { 
    if (activeShiftSession) return alert("Tutup shift kasir sebelum keluar!");
    if(confirm("Keluar dari sistem?")) {
        try { await signOut(auth); } catch (e) {} 
        finally { clearMemoryData(); localStorage.clear(); location.reload(); } 
    } 
});

// ==========================================
// TABS NAVIGATION 
// ==========================================
const tabsBtns = document.querySelectorAll('.nav-tab'); 
const contents = document.querySelectorAll('.tab-content');
function switchTab(id) {
    contents.forEach(c => c.classList.add('hidden')); 
    tabsBtns.forEach(t => { 
        t.classList.remove('border-mantine-blue', 'text-mantine-blue'); 
        t.classList.add('border-transparent', 'text-dark-1'); 
    });
    document.getElementById(`tab-${id}`)?.classList.remove('hidden');
    const targetBtn = document.getElementById(`tab-${id}-btn`); 
    if(targetBtn) { 
        targetBtn.classList.remove('border-transparent', 'text-dark-1'); 
        targetBtn.classList.add('border-mantine-blue', 'text-mantine-blue'); 
    }
    if (id === 'dashboard' && chartInstance) setTimeout(() => chartInstance.update(), 100);
}

tabsBtns.forEach(tab => { 
    tab.addEventListener('click', () => {
        let cleanId = tab.id.replace('tab-', '').replace('-btn', '');
        switchTab(cleanId); 
    }); 
});
window.switchTab = switchTab;

function applyRoleAccess() {
    ['tab-dashboard-btn', 'tab-gudang-btn', 'btn-export-excel', 'admin-shift-log-section'].forEach(id => { 
        const el = document.getElementById(id); 
        if (el) el.classList.toggle('hidden', currentUserRole !== "admin"); 
    });
    switchTab(currentUserRole === "admin" ? 'dashboard' : 'kasir');
}

function checkActiveShift(uid) {
    if (unsubscribeActiveShift) {
        unsubscribeActiveShift();
        unsubscribeActiveShift = null;
    }
    unsubscribeActiveShift = onSnapshot(query(shiftsRef, where("userId", "==", uid), where("status", "==", "buka"), limit(1)), (snapshot) => {
        if (!snapshot.empty) { 
            snapshot.forEach(doc => { activeShiftSession = { id: doc.id, ...doc.data() }; }); 
            localStorage.setItem("pos_cached_shift", JSON.stringify(activeShiftSession)); 
            updateShiftUI(true); 
        } else if(navigator.onLine) { 
            activeShiftSession = null; 
            localStorage.removeItem("pos_cached_shift"); 
            updateShiftUI(false); 
        }
    });
}

function updateShiftUI(isActive) {
    const w = document.getElementById('shift-status-widget');
    if (!w) return;
    if (isActive) {
        w.className = "bg-green-900/20 border border-green-800/50 p-5 rounded-xl flex flex-col sm:flex-row sm:items-center justify-between gap-4";
        w.innerHTML = `<div class="text-sm text-green-400"><p class="font-bold flex items-center gap-2"><div class="w-2.5 h-2.5 rounded-full bg-green-500 animate-pulse"></div> Sesi Aktif: ${escapeHTML(auth.currentUser?.email.split('@')[0].toUpperCase())}</p><p class="text-green-500/80 mt-1 text-xs font-medium">Modal Awal: ${toRupiah(activeShiftSession.modalAwal)} | Omset: ${toRupiah(activeShiftSession.totalPenjualan || 0)}</p></div><button onclick="window.triggerTutupShift()" class="px-5 py-2.5 text-xs font-bold text-gray-100 bg-dark-5 hover:bg-dark-4 rounded-xl">Tutup Sesi 🔒</button>`;
        document.getElementById('kasir-core-content')?.classList.remove('opacity-40', 'pointer-events-none'); 
        document.getElementById('kasir-cart-content')?.classList.remove('opacity-40', 'pointer-events-none');
    } else {
        w.className = "bg-dark-8 border border-dark-4 p-5 rounded-xl flex flex-col sm:flex-row sm:items-center justify-between gap-4";
        w.innerHTML = `<div class="text-sm text-dark-0"><p class="font-bold flex items-center gap-2">🔒 Sesi Belum Dibuka</p><p class="text-dark-2 mt-1 text-xs">Buka shift terlebih dahulu untuk bertransaksi.</p></div><button onclick="window.triggerBukaShift()" class="px-5 py-2.5 text-xs font-bold text-white bg-mantine-blue hover:bg-mantine-hover rounded-xl">Mulai Shift 🔑</button>`;
        document.getElementById('kasir-core-content')?.classList.add('opacity-40', 'pointer-events-none'); 
        document.getElementById('kasir-cart-content')?.classList.add('opacity-40', 'pointer-events-none');
    }
}

window.triggerBukaShift = () => {
    document.getElementById('shift-modal-title').textContent = "Buka Shift"; 
    document.getElementById('shift-input-label').textContent = "Modal Fisik Laci (Rp)";
    document.getElementById('btn-close-shift-modal')?.classList.add('hidden'); 
    document.getElementById('btn-shift-submit').textContent = "Buka Sesi";
    
    const form = document.getElementById('shift-form');
    if(!form) return;

    form.onsubmit = async (e) => {
        e.preventDefault(); 
        if (!navigator.onLine) return alert("Peringatan: Koneksi internet dibutuhkan untuk membuka shift.");
        
        const btnSubmit = document.getElementById('btn-shift-submit');
        if(btnSubmit) { btnSubmit.disabled = true; btnSubmit.textContent = "Menyimpan..."; }
        
        try {
            const val = Math.round(Math.max(0, parseFloat(document.getElementById('shift-cash-input')?.value) || 0));
            const docRef = await addDoc(shiftsRef, { userId: currentUserId, namaKasir: auth.currentUser?.email.split('@')[0], waktuBuka: serverTimestamp(), modalAwal: val, totalPenjualan: 0, status: "buka" });
            activeShiftSession = { id: docRef.id, userId: currentUserId, namaKasir: auth.currentUser?.email.split('@')[0], modalAwal: val, totalPenjualan: 0, status: "buka" };
            localStorage.setItem("pos_cached_shift", JSON.stringify(activeShiftSession));
            await logActivity("SHIFT_BUKA", `Kasir membuka shift dengan modal ${toRupiah(val)}`);
            document.getElementById('shift-modal')?.classList.add('hidden'); 
            updateShiftUI(true);
        } catch(e) { 
            alert("Error: " + e.message); 
        } finally { 
            if(btnSubmit) { btnSubmit.disabled = false; btnSubmit.textContent = "Buka Sesi"; } 
            form.reset(); 
        }
    };
    document.getElementById('shift-modal')?.classList.remove('hidden');
};

window.triggerTutupShift = () => {
    document.getElementById('shift-modal-title').textContent = "Z-Report Tutup Shift"; 
    document.getElementById('shift-input-label').textContent = "Uang Aktual di Laci (Rp)";
    document.getElementById('btn-close-shift-modal')?.classList.remove('hidden'); 
    document.getElementById('btn-shift-submit').textContent = "Tutup Shift";
    
    const btnClose = document.getElementById('btn-close-shift-modal');
    if(btnClose) btnClose.onclick = () => document.getElementById('shift-modal')?.classList.add('hidden');
    
    const form = document.getElementById('shift-form');
    if(!form) return;

    form.onsubmit = async (e) => {
        e.preventDefault(); 
        if (!navigator.onLine) return alert("Peringatan: Koneksi internet dibutuhkan untuk validasi shift.");
        
        const btnSubmit = document.getElementById('btn-shift-submit');
        if(btnSubmit) { btnSubmit.disabled = true; btnSubmit.textContent = "Validasi..."; }

        try {
            const val = Math.round(Math.max(0, parseFloat(document.getElementById('shift-cash-input')?.value) || 0));
            const selisih = Math.round(val - (activeShiftSession.modalAwal + (activeShiftSession.totalPenjualan || 0)));
            
            await updateDoc(doc(db, "shift", activeShiftSession.id), { waktuTutup: serverTimestamp(), uangFisikAktual: val, selisih: selisih, status: "tutup" });
            await logActivity("SHIFT_TUTUP", `Kasir menutup shift. Selisih kas: ${toRupiah(selisih)}`);
            alert(`Shift Berhasil Ditutup. Selisih Laci: ${toRupiah(selisih)}`);
            document.getElementById('shift-modal')?.classList.add('hidden'); 
            activeShiftSession = null; 
            localStorage.removeItem("pos_cached_shift"); 
            updateShiftUI(false);
        } catch(e) { 
            alert("Error: " + e.message); 
        } finally { 
            if(btnSubmit) { btnSubmit.disabled = false; btnSubmit.textContent = "Tutup Shift"; } 
            form.reset(); 
        }
    };
    document.getElementById('shift-modal')?.classList.remove('hidden');
};

function initRealtimeListeners() {
    stopRealtimeListeners();
    unsubscribeItems = onSnapshot(query(itemsRef, orderBy("nama", "asc")), (snapshot) => { 
        databaseBarang = []; 
        snapshot.forEach(doc => databaseBarang.push({ id: doc.id, ...doc.data() })); 
        localStorage.setItem("pos_cached_items", JSON.stringify(databaseBarang)); 
        renderKatalogKasir(); renderGudangList(); renderLowStock(); 
    });
    
    unsubscribeSales = onSnapshot(query(salesRef, orderBy("waktu", "desc"), limit(100)), (snapshot) => { 
        riwayatPenjualan = []; 
        snapshot.forEach(doc => riwayatPenjualan.push({ id: doc.id, ...doc.data() })); 
        applyFiltersAndStats(); 
    });
    
    if (currentUserRole === 'admin') {
        unsubscribeShifts = onSnapshot(query(shiftsRef, orderBy("waktuBuka", "desc"), limit(30)), (snapshot) => { 
            dataShiftAll = []; 
            snapshot.forEach(doc => dataShiftAll.push({ id: doc.id, ...doc.data() })); 
            renderShiftLogs(); 
        });
        unsubscribeAudit = onSnapshot(query(auditLogsRef, orderBy("timestamp", "desc"), limit(50)), (snapshot) => { 
            auditLogsData = []; 
            snapshot.forEach(doc => auditLogsData.push({ id: doc.id, ...doc.data() })); 
            renderAuditLogs(); 
        });
    }
}

function stopRealtimeListeners() { 
    if(unsubscribeItems) { unsubscribeItems(); unsubscribeItems = null; }
    if(unsubscribeSales) { unsubscribeSales(); unsubscribeSales = null; }
    if(unsubscribeShifts) { unsubscribeShifts(); unsubscribeShifts = null; }
    if(unsubscribeAudit) { unsubscribeAudit(); unsubscribeAudit = null; }
    if(unsubscribeActiveShift) { unsubscribeActiveShift(); unsubscribeActiveShift = null; }
}

document.getElementById('filter-date-start')?.addEventListener('change', applyFiltersAndStats); 
document.getElementById('filter-date-end')?.addEventListener('change', applyFiltersAndStats);

window.setShortcutTanggal = (type) => {
    const today = new Date(); 
    const endStr = today.toISOString().split('T')[0]; 
    let startStr = "";
    if (type === 'hari-ini') startStr = endStr; 
    else if (type === '7-hari') { const d = new Date(); d.setDate(d.getDate() - 7); startStr = d.toISOString().split('T')[0]; } 
    else if (type === 'bulan-ini') startStr = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2, '0')}-01`; 
    else { 
        const ds = document.getElementById('filter-date-start'); if(ds) ds.value = "";
        const de = document.getElementById('filter-date-end'); if(de) de.value = "";
        applyFiltersAndStats(); return; 
    }
    
    const dStart = document.getElementById('filter-date-start'); if(dStart) dStart.value = startStr;
    const dEnd = document.getElementById('filter-date-end'); if(dEnd) dEnd.value = endStr;
    applyFiltersAndStats();
};

async function applyFiltersAndStats() {
    const dStart = document.getElementById('filter-date-start');
    const dEnd = document.getElementById('filter-date-end');
    const startVal = dStart ? dStart.value : ""; 
    const endVal = dEnd ? dEnd.value : "";
    
    let startTs = startVal ? new Date(startVal + "T00:00:00").getTime() : 0; 
    let endTs = endVal ? new Date(endVal + "T23:59:59").getTime() : Infinity;
    
    let allSales = [...riwayatPenjualan];
    const offlineSales = await loadOfflineTransactions();
    if (offlineSales && offlineSales.length > 0) { allSales = [...offlineSales.reverse(), ...allSales]; }

    dataPenjualanTerfilter = allSales.filter(sale => {
        const w = sale.waktu || sale.waktuLokal; 
        if (!w) return false;
        const ms = w.seconds ? w.seconds * 1000 : new Date(w).getTime();
        return ms >= startTs && ms <= endTs;
    });

    let totalOmset = 0; let totalTrx = dataPenjualanTerfilter.length; let totalItems = 0; let produkCounts = {};
    
    dataPenjualanTerfilter.forEach(sale => { 
        totalOmset += Math.round(sale.totalAkhir || 0); 
        if (Array.isArray(sale.items)) { 
            sale.items.forEach(i => { 
                totalItems += i.qty || 0; 
                produkCounts[i.nama||'Item'] = (produkCounts[i.nama||'Item'] || 0) + i.qty; 
            }); 
        } 
    });

    const omsetDOM = document.getElementById('dash-omset'); if(omsetDOM) omsetDOM.textContent = toRupiah(totalOmset);
    const trxDOM = document.getElementById('dash-transaksi'); if(trxDOM) trxDOM.textContent = totalTrx;
    const itemsDOM = document.getElementById('dash-items'); if(itemsDOM) itemsDOM.innerHTML = `${totalItems} <span class="text-lg font-medium text-dark-2">Item</span>`;
    
    const sortedProduk = Object.entries(produkCounts).sort((a,b) => b[1] - a[1]).slice(0,5); 
    renderChart(sortedProduk.map(p => p[0]), sortedProduk.map(p => p[1]));
    renderRiwayatTable();
}

function renderChart(labels, values) {
    if (typeof Chart === 'undefined') return; 
    const ctx = document.getElementById('chartProdukTerlaris'); 
    if(!ctx) return; 
    if (chartInstance) chartInstance.destroy();
    if (labels.length === 0) { labels = ["Belum ada data"]; values = [0]; }
    
    chartInstance = new Chart(ctx, { 
        type: 'bar', 
        data: { labels: labels, datasets: [{ label: 'Qty Terjual', data: values, backgroundColor: '#1971c2', borderRadius: 6 }] }, 
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { grid: { display: false }, ticks: { color: '#909296', font: { family: 'Inter', size: 11 } } }, y: { grid: { color: '#373A40' }, ticks: { color: '#909296', font: { family: 'Inter', size: 11 }, precision: 0 } } } } 
    });
}

function renderLowStock() {
    const list = document.getElementById('dash-low-stock-list'); 
    if(!list) return;
    const lowStockItems = databaseBarang.filter(i => (i.stok || 0) <= 5);
    if(lowStockItems.length === 0) { list.innerHTML = `<p class="text-xs text-dark-2 italic">Semua stok produk aman.</p>`; return; }
    list.innerHTML = lowStockItems.map(i => `<div class="flex justify-between items-center bg-dark-8 p-3 rounded-xl border border-dark-4"><span class="text-xs font-semibold text-gray-200">${escapeHTML(i.nama)}</span><span class="px-2.5 py-1 text-[10px] font-bold rounded-md ${i.stok===0?'bg-red-900/40 text-red-400 border border-red-900':'bg-amber-900/40 text-amber-400 border border-amber-900'}">Stok: ${i.stok||0}</span></div>`).join('');
}

const payMethods = { 'Tunai': document.getElementById('pay-method-cash'), 'QRIS': document.getElementById('pay-method-qris'), 'Debit': document.getElementById('pay-method-debit'), 'Transfer': document.getElementById('pay-method-tf') };
Object.entries(payMethods).forEach(([method, btn]) => {
    if(btn) {
        btn.addEventListener('click', () => {
            selectedPaymentMethod = method;
            Object.values(payMethods).forEach(b => { if(b) b.className = "py-1 text-[10px] font-semibold text-dark-1 hover:text-gray-100 rounded-lg transition-all"; });
            btn.className = "py-1 text-[10px] font-semibold bg-mantine-blue text-white rounded-lg transition-all";
            
            const cFields = document.getElementById('cash-payment-fields');
            const ncFields = document.getElementById('non-cash-payment-fields');
            const cRow = document.getElementById('cash-return-row');
            
            if (method === 'Tunai') {
                cFields?.classList.remove('hidden'); ncFields?.classList.add('hidden'); cRow?.classList.remove('hidden'); 
                const cp = document.getElementById('cash-paid'); if(cp) cp.value = "";
            } else {
                cFields?.classList.add('hidden'); ncFields?.classList.remove('hidden'); cRow?.classList.add('hidden'); 
                const nct = document.getElementById('non-cash-title'); if(nct) nct.textContent = `Bayar via ${method}`; 
                const prc = document.getElementById('payment-ref-code'); if(prc) prc.value = "";
            }
            hitungUangKembalian();
        });
    }
});

document.getElementById('btn-hold-bill')?.addEventListener('click', () => {
    if (keranjang.length === 0) return alert("Keranjang kosong!");
    let holdName = prompt("Nama Penanda Orderan (cth: Meja 5 / Bpk Andi):"); 
    if (holdName === null) return;
    holdName = holdName.trim() || `Order #${Date.now().toString().slice(-4)}`;
    
    const heldBills = JSON.parse(localStorage.getItem('pos_held_bills') || '[]');
    const discVal = document.getElementById('cart-discount') ? Math.round(parseFloat(document.getElementById('cart-discount').value)) : 0;
    
    heldBills.push({ id: Date.now().toString(), tag: holdName, waktu: new Date().toLocaleString('id-ID'), items: keranjang, diskon: discVal || 0, activeMember: activeMember });
    localStorage.setItem('pos_held_bills', JSON.stringify(heldBills));
    
    keranjang = []; 
    localStorage.removeItem("pos_recovery_cart");
    activeMember = null; 
    localStorage.removeItem("pos_recovery_member");
    
    const cd = document.getElementById('cart-discount'); if(cd) cd.value = ""; 
    document.getElementById('btn-remove-member')?.click(); 
    
    renderKeranjang(); updateHoldCountBadge(); 
    alert("Pesanan berhasil ditangguhkan.");
});

document.getElementById('btn-recall-bill')?.addEventListener('click', () => { 
    renderHoldModalList(); 
    document.getElementById('hold-modal')?.classList.remove('hidden'); 
});

function updateHoldCountBadge() { 
    const badge = document.getElementById('hold-count-badge');
    if(badge) badge.textContent = JSON.parse(localStorage.getItem('pos_held_bills') || '[]').length; 
}

function renderHoldModalList() {
    const listContainer = document.getElementById('hold-bills-list'); 
    if(!listContainer) return;
    const heldBills = JSON.parse(localStorage.getItem('pos_held_bills') || '[]');
    if (heldBills.length === 0) { listContainer.innerHTML = `<p class="text-xs text-dark-2 italic text-center py-4">Tidak ada pesanan.</p>`; return; }
    listContainer.innerHTML = heldBills.map(bill => `
        <div class="bg-dark-8 p-3 rounded-xl border border-dark-4 flex justify-between items-center gap-3">
            <div class="flex-1 min-w-0"><div class="flex justify-between items-center mb-1"><span class="font-bold text-xs text-amber-400 truncate">${escapeHTML(bill.tag)}</span></div><p class="text-[11px] text-dark-1 truncate">${bill.items.map(i => `${escapeHTML(i.nama)} (${i.qty}x)`).join(', ')}</p></div>
            <div class="flex gap-1 shrink-0"><button onclick="window.loadHeldBill('${bill.id}')" class="px-2.5 py-1 bg-mantine-blue text-white rounded text-xs font-semibold">Buka</button><button onclick="window.deleteHeldBill('${bill.id}')" class="px-2.5 py-1 bg-red-950/40 text-red-400 border border-red-900 rounded text-xs font-semibold">🗑️</button></div>
        </div>`).join('');
}

window.loadHeldBill = (id) => {
    if (keranjang.length > 0 && !confirm("Ganti keranjang aktif dengan orderan ini?")) return;
    const heldBills = JSON.parse(localStorage.getItem('pos_held_bills') || '[]'); 
    const idx = heldBills.findIndex(b => b.id === id);
    if (idx > -1) {
        const bill = heldBills[idx]; 
        let validatedItems = []; let hasChanges = false;
        
        for (let item of bill.items) {
            const dbItem = databaseBarang.find(i => i.id === item.id);
            if (!dbItem || (dbItem.stok || 0) <= 0) { hasChanges = true; continue; }
            if (item.qty > dbItem.stok) { item.qty = dbItem.stok; hasChanges = true; }
            if (item.harga !== dbItem.harga) { item.harga = dbItem.harga; hasChanges = true; }
            validatedItems.push(item);
        }

        if (validatedItems.length === 0) {
            alert("Semua produk di orderan ini telah habis atau dihapus dari Master Data!");
            heldBills.splice(idx, 1); localStorage.setItem('pos_held_bills', JSON.stringify(heldBills)); 
            renderHoldModalList(); updateHoldCountBadge(); return;
        }

        if (hasChanges) alert("Penyesuaian otomatis dilakukan karena perubahan stok/harga Gudang terbaru.");
        
        keranjang = validatedItems; 
        localStorage.setItem("pos_recovery_cart", JSON.stringify(keranjang));
        
        const cd = document.getElementById('cart-discount'); if(cd) cd.value = bill.diskon || "";
        
        activeMember = bill.activeMember || null; 
        if (activeMember) { 
            localStorage.setItem("pos_recovery_member", JSON.stringify(activeMember)); 
            showActiveMemberUI(); 
        } else { 
            document.getElementById('btn-remove-member')?.click(); 
        }
        
        heldBills.splice(idx, 1); 
        localStorage.setItem('pos_held_bills', JSON.stringify(heldBills));
        document.getElementById('hold-modal')?.classList.add('hidden'); 
        renderKeranjang(); 
        updateHoldCountBadge();
    }
};

window.deleteHeldBill = (id) => { 
    const heldBills = JSON.parse(localStorage.getItem('pos_held_bills') || '[]'); 
    localStorage.setItem('pos_held_bills', JSON.stringify(heldBills.filter(b => b.id !== id))); 
    renderHoldModalList(); updateHoldCountBadge(); 
};

document.getElementById('btn-check-member')?.addEventListener('click', async () => {
    const searchInput = document.getElementById('member-search-input');
    if(!searchInput) return;
    const phone = searchInput.value.trim(); if (!phone) return;
    if (!navigator.onLine) return alert("Fitur pencarian member butuh internet.");
    
    const btnCheck = document.getElementById('btn-check-member'); 
    if(btnCheck) { btnCheck.disabled = true; btnCheck.textContent = "..."; }
    
    try {
        const docSnap = await getDoc(doc(db, "members", phone));
        if (docSnap.exists()) { 
            activeMember = { id: phone, ...docSnap.data() }; 
            localStorage.setItem("pos_recovery_member", JSON.stringify(activeMember)); 
            showActiveMemberUI(); 
        } else { 
            if (confirm(`Member dengan HP ${phone} belum terdaftar. Daftarkan sekarang?`)) { 
                const mp = document.getElementById('member-reg-phone'); if(mp) mp.value = phone; 
                const mn = document.getElementById('member-reg-name'); if(mn) mn.value = ""; 
                document.getElementById('member-modal')?.classList.remove('hidden'); 
            } 
        }
    } catch(e) {} 
    finally { if(btnCheck) { btnCheck.disabled = false; btnCheck.textContent = "Cari"; } }
});

document.getElementById('member-form')?.addEventListener('submit', async (e) => {
    e.preventDefault(); 
    if (!navigator.onLine) return alert("Pendaftaran member butuh internet.");
    
    const btnSubmit = e.target.querySelector('button[type="submit"]'); 
    let origText = "";
    if(btnSubmit) { origText = btnSubmit.textContent; btnSubmit.disabled = true; btnSubmit.textContent = "Memproses..."; }
    
    try {
        const phone = document.getElementById('member-reg-phone')?.value.trim() || ''; 
        const name = document.getElementById('member-reg-name')?.value.trim() || '';
        
        const checkSnap = await getDoc(doc(db, "members", phone));
        if(checkSnap.exists()) return alert("Nomor HP ini sudah dipakai!");
        
        await setDoc(doc(db, "members", phone), { nama: name, poin: 0 }); 
        activeMember = { id: phone, nama: name, poin: 0 }; 
        localStorage.setItem("pos_recovery_member", JSON.stringify(activeMember)); 
        showActiveMemberUI(); 
        document.getElementById('member-modal')?.classList.add('hidden');
    } catch(e) {} 
    finally { if(btnSubmit) { btnSubmit.disabled = false; btnSubmit.textContent = origText; } }
});

document.getElementById('btn-remove-member')?.addEventListener('click', () => { 
    activeMember = null; 
    localStorage.removeItem("pos_recovery_member"); 
    document.getElementById('member-select-zone')?.classList.remove('hidden'); 
    document.getElementById('member-active-zone')?.classList.add('hidden'); 
    document.getElementById('btn-remove-member')?.classList.add('hidden'); 
    const msi = document.getElementById('member-search-input'); if(msi) msi.value = ""; 
});

function showActiveMemberUI() { 
    document.getElementById('member-select-zone')?.classList.add('hidden'); 
    document.getElementById('member-active-zone')?.classList.remove('hidden'); 
    document.getElementById('btn-remove-member')?.classList.remove('hidden'); 
    const man = document.getElementById('member-active-name'); if(man) man.textContent = `⭐ ${escapeHTML(activeMember.nama).toUpperCase()}`; 
    const map = document.getElementById('member-active-points'); if(map) map.textContent = `Poin: ${activeMember.poin || 0}`; 
}

document.getElementById('kasir-search')?.addEventListener('input', (e) => { 
    kataKunciPencarian = e.target.value.toLowerCase(); 
    renderKatalogKasir(); 
});

function renderKatalogKasir() {
    const categoriesSet = new Set(databaseBarang.map(i => i.kategori || 'Umum'));
    const catContainer = document.getElementById('kasir-categories');
    if(catContainer) {
        catContainer.innerHTML = `<button onclick="window.setFilterKategori('Semua')" class="px-3 py-1.5 rounded-lg text-xs font-medium shrink-0 ${filterKategoriAktif==='Semua'?'bg-mantine-blue text-white':'bg-dark-5 text-dark-1'}">Semua</button>` + 
        Array.from(categoriesSet).map(cat => `<button onclick="window.setFilterKategori('${escapeJS(cat)}')" class="px-3 py-1.5 rounded-lg text-xs font-medium shrink-0 ${filterKategoriAktif===cat?'bg-mantine-blue text-white':'bg-dark-5 text-dark-1'}">${escapeHTML(cat)}</button>`).join('');
    }

    const filtered = databaseBarang.filter(i => (filterKategoriAktif === 'Semua' || (i.kategori||'Umum') === filterKategoriAktif) && ((i.nama||'').toLowerCase().includes(kataKunciPencarian) || (i.barcode && i.barcode.toLowerCase().includes(kataKunciPencarian))));
    const katContainer = document.getElementById('kasir-katalog');
    if(!katContainer) return;

    if (filtered.length === 0) { 
        katContainer.innerHTML = `<p class="text-xs text-dark-2 italic col-span-full text-center py-8">Kosong.</p>`; 
        return; 
    }
    
    katContainer.innerHTML = filtered.map(i => `
        <div onclick="window.tambahKeKeranjang('${i.id}')" class="bg-dark-6 p-4 rounded-xl border border-dark-4 hover:border-mantine-blue cursor-pointer select-none flex flex-col justify-between active:scale-[0.98]">
            <div><div class="flex justify-between items-start gap-1"><span class="text-[10px] font-bold text-dark-2 uppercase truncate max-w-[80px]">${escapeHTML(i.kategori||'Umum')}</span><span class="text-[10px] px-1.5 py-0.5 rounded font-bold ${(i.stok||0)<=3?'bg-red-900/30 text-red-400':'bg-dark-5 text-dark-2'}">Stok: ${i.stok||0}</span></div><h4 class="font-bold text-xs text-gray-100 mt-1.5 leading-snug">${escapeHTML(i.nama||'Item')}</h4></div>
            <p class="text-sm font-extrabold text-gray-300 mt-3">${toRupiah(i.harga)}</p>
        </div>`).join('');
}

window.setFilterKategori = (cat) => { filterKategoriAktif = cat; renderKatalogKasir(); };

window.tambahKeKeranjang = (id) => {
    const item = databaseBarang.find(i => i.id === id); 
    if(!item || (item.stok||0) <= 0) return alert("Stok habis!");
    
    const existing = keranjang.find(k => k.id === id);
    if (existing) { 
        if(existing.qty >= item.stok) return alert("Melebihi batas stok gudang!"); 
        existing.qty++; 
    } else { 
        keranjang.push({ id: item.id, nama: item.nama, harga: item.harga||0, qty: 1 }); 
    }
    
    localStorage.setItem("pos_recovery_cart", JSON.stringify(keranjang));
    playBeep(); 
    renderKeranjang();
};

window.ubahQtyCart = (id, delta) => {
    const index = keranjang.findIndex(k => k.id === id); 
    if(index === -1) return;
    
    const itemDb = databaseBarang.find(i => i.id === id);
    if (delta > 0 && !itemDb) return alert("Produk ini telah dihapus oleh Admin!");
    
    keranjang[index].qty += delta;
    
    if (keranjang[index].qty <= 0) { 
        const removedItem = keranjang[index]; 
        keranjang.splice(index, 1); 
        logActivity("CART_HAPUS_ITEM", `Kasir membuang [${removedItem.nama}]`); 
    } else if (itemDb && keranjang[index].qty > (itemDb.stok||0)) { 
        keranjang[index].qty = itemDb.stok||0; 
        alert(`Stok produk terbatas!`); 
    }
    
    localStorage.setItem("pos_recovery_cart", JSON.stringify(keranjang));
    playBeep(); 
    renderKeranjang();
};

document.getElementById('cart-discount')?.addEventListener('input', hitungUangKembalian); 
document.getElementById('cash-paid')?.addEventListener('input', hitungUangKembalian);

function renderKeranjang() {
    const badge = document.getElementById('cart-total-qty-badge');
    if(badge) badge.textContent = `${keranjang.reduce((a, b) => a + b.qty, 0)} Item`;
    
    const listEl = document.getElementById('cart-list');
    const btnCheckout = document.getElementById('btn-checkout');
    
    if(keranjang.length === 0) {
        if(activeMember) document.getElementById('btn-remove-member')?.click(); 
        if(listEl) listEl.innerHTML = `<div class="flex flex-col items-center text-dark-3 py-12"><p class="text-xs italic">Keranjang kosong</p></div>`;
        const cSub = document.getElementById('cart-subtotal'); if(cSub) cSub.textContent = "Rp 0"; 
        const cGrand = document.getElementById('cart-grand-total'); if(cGrand) cGrand.textContent = "Rp 0"; 
        
        if(btnCheckout) { 
            btnCheckout.disabled = true; 
            btnCheckout.className = "w-full py-3 bg-dark-5 text-dark-3 font-bold rounded-xl cursor-not-allowed text-xs uppercase"; 
        }
        localStorage.removeItem("pos_recovery_cart");
        return;
    }
    
    if(listEl) listEl.innerHTML = keranjang.map(k => `
        <div class="bg-dark-6 p-3 rounded-xl border border-dark-4 flex justify-between items-center gap-3">
            <div class="flex-1 min-w-0"><h5 class="text-xs font-bold text-gray-200 truncate">${escapeHTML(k.nama)}</h5><p class="text-[11px] text-dark-2 mt-0.5">${toRupiah(k.harga)} x ${k.qty}</p></div>
            <div class="flex items-center gap-2 bg-dark-8 p-1 rounded-lg border border-dark-4 shrink-0"><button onclick="window.ubahQtyCart('${k.id}', -1)" class="w-6 h-6 bg-dark-5 text-gray-100 rounded font-bold">-</button><span class="text-xs font-bold px-1 text-gray-200">${k.qty}</span><button onclick="window.ubahQtyCart('${k.id}', 1)" class="w-6 h-6 bg-dark-5 text-gray-100 rounded font-bold">+</button></div>
        </div>`).join('');
    
    hitungUangKembalian();
}

function hitungUangKembalian() {
    globalSubtotal = Math.round(keranjang.reduce((acc, i) => acc + ((i.harga||0) * i.qty), 0));
    
    const discInput = document.getElementById('cart-discount');
    const rawDisc = parseFloat(discInput ? discInput.value : 0) || 0;
    
    let rawDiskon = Math.round(Math.max(0, rawDisc));
    globalDiskon = Math.min(globalSubtotal, rawDiskon);
    globalGrandTotal = Math.round(Math.max(0, globalSubtotal - globalDiskon));
    
    const cSub = document.getElementById('cart-subtotal'); if(cSub) cSub.textContent = toRupiah(globalSubtotal); 
    const cGrand = document.getElementById('cart-grand-total'); if(cGrand) cGrand.textContent = toRupiah(globalGrandTotal);
    
    const btnCheckout = document.getElementById('btn-checkout');
    
    if (selectedPaymentMethod === 'Tunai') {
        const cashInput = document.getElementById('cash-paid');
        const rawCash = parseFloat(cashInput ? cashInput.value : 0) || 0;
        const cashPaidVal = Math.round(Math.max(0, rawCash));
        
        const cRet = document.getElementById('cash-return'); 
        if(cRet) cRet.textContent = toRupiah(Math.max(0, cashPaidVal - globalGrandTotal));
        
        if(btnCheckout) {
            if (cashPaidVal >= globalGrandTotal && keranjang.length > 0) { 
                btnCheckout.disabled = false; btnCheckout.className = "w-full py-3 bg-mantine-blue text-white font-bold rounded-xl text-xs uppercase cursor-pointer"; 
            } else { 
                btnCheckout.disabled = true; btnCheckout.className = "w-full py-3 bg-dark-5 text-dark-3 font-bold rounded-xl cursor-not-allowed text-xs uppercase"; 
            }
        }
    } else {
        const cRet = document.getElementById('cash-return'); if(cRet) cRet.textContent = "Rp 0";
        if(btnCheckout) {
            if(keranjang.length > 0) { 
                btnCheckout.disabled = false; btnCheckout.className = "w-full py-3 bg-mantine-blue text-white font-bold rounded-xl text-xs uppercase cursor-pointer"; 
            } else { 
                btnCheckout.disabled = true; btnCheckout.className = "w-full py-3 bg-dark-5 text-dark-3 font-bold rounded-xl cursor-not-allowed text-xs uppercase"; 
            }
        }
    }
}

document.getElementById('btn-checkout')?.addEventListener('click', async (e) => {
    const btnCheckout = e.currentTarget;
    if(btnCheckout.disabled || keranjang.length === 0 || !activeShiftSession) return;
    
    const cashInput = document.getElementById('cash-paid');
    const rawCash = parseFloat(cashInput ? cashInput.value : 0) || 0;
    const cashPaidVal = selectedPaymentMethod === 'Tunai' ? Math.round(Math.max(0, rawCash)) : globalGrandTotal;
    
    if (selectedPaymentMethod === 'Tunai' && cashPaidVal < globalGrandTotal) return alert("Tolak: Uang tidak cukup!");
    
    btnCheckout.disabled = true; btnCheckout.textContent = "MEMPROSES...";
    
    const refCodeInput = document.getElementById('payment-ref-code');
    const refCode = refCodeInput ? refCodeInput.value.trim() : '';

    const trxData = { 
        items: [...keranjang], 
        subtotal: globalSubtotal, 
        diskon: globalDiskon, 
        totalAkhir: globalGrandTotal, 
        uangBayar: cashPaidVal, 
        kembalian: Math.round(Math.max(0, cashPaidVal - globalGrandTotal)), 
        metodePembayaran: selectedPaymentMethod, 
        refCode: refCode, 
        namaKasir: (auth.currentUser ? auth.currentUser.email.split('@')[0] : 'Sistem'), 
        shiftId: activeShiftSession.id, 
        memberId: activeMember ? activeMember.id : null, 
        memberName: activeMember ? activeMember.nama : null 
    };

    let isOnlineSuccess = false;
    try {
        if (navigator.onLine) {
            try {
                trxData.waktu = serverTimestamp();
                trxData.waktuLokal = new Date().toISOString(); 
                await addDoc(salesRef, trxData);
                isOnlineSuccess = true;
            } catch(e) {}
        }
        
        if (isOnlineSuccess) {
            keranjang = []; 
            localStorage.removeItem("pos_recovery_cart"); 
            localStorage.removeItem("pos_recovery_member");
            
            for (const item of trxData.items) { 
                try { await updateDoc(doc(db, "barang", item.id), { stok: increment(-item.qty) }); } catch(e) { } 
            }
            await updateDoc(doc(db, "shift", activeShiftSession.id), { totalPenjualan: increment(globalGrandTotal) });
            
            if (trxData.memberId) { 
                const addPoin = Math.floor(globalGrandTotal / 10000); 
                if (addPoin > 0) await updateDoc(doc(db, "members", trxData.memberId), { poin: increment(addPoin) }); 
            }
            logActivity("CHECKOUT_ONLINE", `Penjualan sukses senilai ${toRupiah(globalGrandTotal)}`); 
        } else {
            trxData.waktuLokal = new Date().toISOString();
            trxData.isOfflinePending = true;
            
            const isSavedLocally = await saveTransactionOffline(trxData);
            if (!isSavedLocally) throw new Error("Gagal merekam data ke perangkat.");
            
            keranjang = []; 
            localStorage.removeItem("pos_recovery_cart"); 
            localStorage.removeItem("pos_recovery_member");
            
            for (const item of trxData.items) {
                const found = databaseBarang.find(x => x.id === item.id);
                if (found) found.stok = Math.max(0, (found.stok||0) - item.qty);
            }
            localStorage.setItem("pos_cached_items", JSON.stringify(databaseBarang));

            activeShiftSession.totalPenjualan = Math.round((activeShiftSession.totalPenjualan || 0) + globalGrandTotal);
            localStorage.setItem("pos_cached_shift", JSON.stringify(activeShiftSession));
            
            updateShiftUI(true); renderKatalogKasir(); renderGudangList(); renderLowStock();
            alert("Disimpan ke brankas offline!");
        }

        cetakStrukThermal({...trxData, waktu: { seconds: Date.now()/1000 }}); 
        
        const cd = document.getElementById('cart-discount'); if(cd) cd.value = ""; 
        const cp = document.getElementById('cash-paid'); if(cp) cp.value = ""; 
        document.getElementById('btn-remove-member')?.click(); 
        
        renderKeranjang(); applyFiltersAndStats(); 
    } catch(e) { 
        alert("TRANSAKSI GAGAL: " + e.message); 
    } finally { 
        btnCheckout.disabled = false; btnCheckout.textContent = "Selesaikan Transaksi"; hitungUangKembalian(); 
    }
});

function cetakStrukThermal(data) {
    const printArea = document.getElementById('print-area');
    if(!printArea) return;
    
    const tglStruk = data.waktuLokal ? new Date(data.waktuLokal) : (data.waktu && data.waktu.seconds ? new Date(data.waktu.seconds * 1000) : new Date());
    
    printArea.innerHTML = `
        <div style="text-align:center; margin-bottom:10px; font-family:monospace; color:black;">
            <h3 style="margin:0; font-size:16px;">⚡ TOKO MODERN PRO ⚡</h3><p style="margin:2px 0; font-size:10px;">Kasir: ${escapeHTML(data.namaKasir ? data.namaKasir.toUpperCase() : 'SISTEM')}</p><p style="margin:2px 0; font-size:10px;">${tglStruk.toLocaleString('id-ID')}</p>
        </div><hr style="border-top:1px dashed black; margin:5px 0;">
        <div style="margin-bottom:10px; font-family:monospace; color:black;">${(data.items||[]).map(i => `<div style="display:flex; justify-content:space-between; font-size:12px; margin-bottom:2px;"><span>${escapeHTML(i.nama||'Item')} (x${i.qty})</span><span>${toRupiah((i.harga||0) * i.qty)}</span></div>`).join('')}</div>
        <hr style="border-top:1px dashed black; margin:5px 0;">
        <div style="font-family:monospace; font-size:12px; color:black; display:flex; flex-direction:column;">
            <div style="display:flex; justify-content:space-between;"><span>Subtotal:</span><span>${toRupiah(data.subtotal)}</span></div>
            <div style="display:flex; justify-content:space-between;"><span>Diskon:</span><span>-${toRupiah(data.diskon)}</span></div>
            <div style="display:flex; justify-content:space-between; font-weight:bold;"><span>Total Tagihan:</span><span>${toRupiah(data.totalAkhir)}</span></div>
            <div style="display:flex; justify-content:space-between; font-size:11px; margin-top:4px;"><span>Metode:</span><span>${escapeHTML(data.metodePembayaran||'Tunai')}</span></div>
            ${data.memberName ? `<div style="display:flex; justify-content:space-between; font-size:11px;"><span>Member:</span><span>${escapeHTML(data.memberName.toUpperCase())}</span></div>` : ''}
            <hr style="border-top:1px dashed black; margin:5px 0;">
            <div style="display:flex; justify-content:space-between;"><span>Bayar:</span><span>${toRupiah(data.uangBayar)}</span></div><div style="display:flex; justify-content:space-between;"><span>Kembali:</span><span>${toRupiah(data.kembalian)}</span></div>
        </div><div style="text-align:center; margin-top:15px; font-size:10px; font-family:monospace; color:black;"><p style="margin:0;">Terima Kasih Atas Kunjungan Anda!</p></div>`;
    window.print();
}

const itemForm = document.getElementById('item-form');
itemForm?.addEventListener('submit', async (e) => {
    e.preventDefault(); 
    if (!navigator.onLine) return alert("Peringatan: Butuh internet untuk memodifikasi gudang.");
    
    const idInput = document.getElementById('item-id');
    const barcodeInputEl = document.getElementById('item-barcode');
    
    const id = idInput ? idInput.value : '';
    const barcodeInput = barcodeInputEl ? barcodeInputEl.value.trim() : '';
    
    if (barcodeInput !== "") {
        const isDuplicate = databaseBarang.find(x => (x.barcode || '').toLowerCase() === barcodeInput.toLowerCase() && x.id !== id);
        if (isDuplicate) return alert(`Barcode sudah dipakai produk: ${isDuplicate.nama}`);
    }
    
    const btnSubmit = document.getElementById('btn-submit'); 
    let origText = "";
    if(btnSubmit) { origText = btnSubmit.textContent; btnSubmit.disabled = true; btnSubmit.textContent = "Menyimpan..."; }
    
    try {
        const rawHrg = parseFloat(document.getElementById('item-price')?.value) || 0;
        const rawStk = parseInt(document.getElementById('item-stock')?.value) || 0;
        const nCat = document.getElementById('item-category')?.value.trim() || 'Umum';
        const nName = document.getElementById('item-name')?.value.trim() || 'Barang Baru';

        const data = { barcode: barcodeInput, nama: nName, kategori: nCat, harga: Math.round(Math.max(0, rawHrg)), stok: Math.max(0, rawStk) };
        if(id) { 
            await updateDoc(doc(db, "barang", id), data); 
            logActivity("GUDANG_UBAH", `Memperbarui [${data.nama}]. Stok: ${data.stok}`); 
        } else { 
            await addDoc(itemsRef, data); 
            logActivity("GUDANG_TAMBAH", `Produk baru [${data.nama}] qty: ${data.stok}`); 
        }
        window.resetForm();
    } catch(err) {} 
    finally { if(btnSubmit) { btnSubmit.disabled = false; btnSubmit.textContent = origText; } }
});

window.editBarang = (id) => {
    const item = databaseBarang.find(x => x.id === id); if (!item) return;
    const ft = document.getElementById('form-title'); if(ft) ft.textContent = "Ubah Data Barang"; 
    const iId = document.getElementById('item-id'); if(iId) iId.value = item.id; 
    const ib = document.getElementById('item-barcode'); if(ib) ib.value = item.barcode || ""; 
    const inM = document.getElementById('item-name'); if(inM) inM.value = item.nama; 
    const ic = document.getElementById('item-category'); if(ic) ic.value = item.kategori || 'Umum'; 
    const ip = document.getElementById('item-price'); if(ip) ip.value = item.harga || 0; 
    const is = document.getElementById('item-stock'); if(is) is.value = item.stok || 0; 
    document.getElementById('btn-cancel')?.classList.remove('hidden');
};

window.hapusBarang = async (id) => { 
    if (!navigator.onLine) return alert("Peringatan: Butuh internet.");
    const item = databaseBarang.find(x => x.id === id); if(!item) return;
    if(confirm(`Hapus permanen ${item.nama}?`)) { 
        logActivity("GUDANG_HAPUS", `Menghapus produk [${item.nama}].`); 
        await deleteDoc(doc(db, "barang", id)); 
    } 
};

window.resetForm = () => { 
    const ft = document.getElementById('form-title'); if(ft) ft.textContent = "Tambah Barang Baru"; 
    document.getElementById('item-form')?.reset(); 
    const iId = document.getElementById('item-id'); if(iId) iId.value = ""; 
    document.getElementById('btn-cancel')?.classList.add('hidden'); 
};
document.getElementById('btn-cancel')?.addEventListener('click', window.resetForm);

function renderGudangList() {
    const container = document.getElementById('gudang-list'); if(!container) return;
    if(databaseBarang.length === 0) { container.innerHTML = `<p class="text-xs text-dark-2 italic text-center py-6">Gudang kosong.</p>`; return; }
    container.innerHTML = databaseBarang.map(i => `
        <div class="bg-dark-6 p-4 rounded-xl border border-dark-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div><span class="text-[9px] font-bold text-dark-2 mb-0.5 block">${escapeHTML(i.barcode ? '📟 '+i.barcode : (i.kategori||'Umum'))}</span><h3 class="font-bold text-gray-100 text-sm">${escapeHTML(i.nama||'Item')}</h3><div class="flex items-center gap-3 mt-1.5"><span class="text-sm font-extrabold text-mantine-blue">${toRupiah(i.harga)}</span><span class="text-[10px] font-bold uppercase tracking-wider px-2 py-1 bg-dark-5 text-dark-0 rounded-md border border-dark-4 ${(i.stok||0)<=5?'!bg-red-900/30 !text-red-400':''}">Stok: ${i.stok||0}</span></div></div>
            <div class="flex gap-2"><button onclick="window.editBarang('${i.id}')" class="px-3 py-2 bg-dark-5 hover:bg-dark-4 text-xs font-bold rounded-xl">Ubah</button><button onclick="window.hapusBarang('${i.id}')" class="px-3 py-2 bg-red-950/20 text-red-400 border border-red-950 text-xs font-bold rounded-xl">Hapus</button></div>
        </div>`).join('');
}

function renderRiwayatTable() {
    const tbody = document.getElementById('riwayat-list'); if(!tbody) return;
    if(dataPenjualanTerfilter.length === 0) { tbody.innerHTML = `<tr><td colspan="5" class="px-6 py-8 text-center text-xs text-dark-2 italic">Belum ada transaksi.</td></tr>`; return; }
    tbody.innerHTML = dataPenjualanTerfilter.map(trx => {
        const itemsStr = Array.isArray(trx.items) ? trx.items.map(i => `${escapeHTML(i.nama||'Item')} (${i.qty}x)`).join(', ') : '';
        return `
            <tr class="hover:bg-dark-5/40">
                <td class="px-6 py-4 whitespace-nowrap text-xs text-dark-1 font-medium">${formatTanggal(trx.waktu || trx.waktuLokal)} ${trx.isOfflinePending ? '<span class="text-amber-500 font-bold ml-1">(Offline)</span>' : ''}</td>
                <td class="px-6 py-4 text-xs text-gray-200 max-w-xs truncate font-medium" title="${itemsStr}">${itemsStr}</td>
                <td class="px-6 py-4 whitespace-nowrap text-xs text-dark-1 font-medium"><span class="px-2 py-0.5 bg-dark-5 rounded text-gray-300 font-semibold text-[11px]">${escapeHTML(trx.metodePembayaran || 'Tunai')}</span></td>
                <td class="px-6 py-4 whitespace-nowrap text-xs text-gray-100 font-bold">${toRupiah(trx.totalAkhir)}</td>
                <td class="px-6 py-4 whitespace-nowrap text-right text-xs"><button onclick="window.reprintTrx('${trx.id || trx.localId}')" class="px-2.5 py-1.5 bg-dark-5 hover:bg-dark-4 text-dark-0 rounded-md font-medium">Struk 🖨️</button></td>
            </tr>`;
    }).join('');
}

window.reprintTrx = async (id) => { 
    const offlineTrx = dataPenjualanTerfilter.find(t => t.localId == id || t.id == id);
    if (offlineTrx) { cetakStrukThermal(offlineTrx); } 
    else { 
        if (!navigator.onLine) return alert("Peringatan: Tarik data dari server butuh internet.");
        const docSnap = await getDoc(doc(db, "penjualan", id)); if(docSnap.exists()) { cetakStrukThermal(docSnap.data()); } 
    }
};

function renderShiftLogs() {
    const tbody = document.getElementById('shift-log-list'); if(!tbody) return;
    tbody.innerHTML = dataShiftAll.map(s => `
        <tr class="hover:bg-dark-5/40 border-b border-dark-4">
            <td class="px-4 py-3"><p class="font-bold text-gray-200">${escapeHTML((s.namaKasir||'Unknown').toUpperCase())}</p><p class="text-[10px] text-dark-2 mt-0.5">Buka: ${formatTanggal(s.waktuBuka)}</p></td>
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
                    <span class="font-bold text-[10px] text-mantine-blue uppercase">${escapeHTML(log.user||'Sistem')}</span>
                    <span class="text-[9px] text-dark-3">${formatTanggal(log.timestamp)}</span>
                </div>
                <span class="inline-block px-1.5 py-0.5 bg-dark-5 text-[9px] font-bold rounded mb-1 text-gray-300 border border-dark-4">${escapeHTML(log.action||'-')}</span>
                <p class="text-[11px] text-dark-1 leading-snug">${escapeHTML(log.detail||'-')}</p>
            </td>
        </tr>`).join('');
}

document.getElementById('btn-export-excel')?.addEventListener('click', () => {
    if (dataPenjualanTerfilter.length === 0) return alert("Data kosong.");
    const dStart = document.getElementById('filter-date-start');
    const fileNameDate = dStart ? (dStart.value || 'Semua') : 'Semua';
    const dataExcel = dataPenjualanTerfilter.map(trx => { 
        const itemsStr = Array.isArray(trx.items) ? trx.items.map(i => `${i.nama||'Item'} (${i.qty}x)`).join(', ') : '';
        const waktuStr = trx.waktu && trx.waktu.seconds ? new Date(trx.waktu.seconds * 1000).toLocaleString('id-ID') : (trx.waktuLokal ? new Date(trx.waktuLokal).toLocaleString('id-ID') : '-');
        return { 'Waktu Transaksi': waktuStr, 'Daftar Barang': itemsStr, 'Metode Pembayaran': trx.metodePembayaran || 'Tunai', 'Subtotal': trx.subtotal || 0, 'Diskon': trx.diskon || 0, 'Grand Total': trx.totalAkhir || 0, 'Uang Masuk/Bayar': trx.uangBayar || 0, 'Kembalian': trx.kembalian || 0 }; 
    });
    const worksheet = XLSX.utils.json_to_sheet(dataExcel); const workbook = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(workbook, worksheet, "Laporan Omset");
    XLSX.writeFile(workbook, `Laporan_POS_${fileNameDate}.xlsx`);
});