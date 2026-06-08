import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager, collection } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

// Konfigurasi Database Anda
const firebaseConfig = {
    apiKey: "AIzaSyAsLKh24L8KxN8vqUgLQujmrfeVzc0F9YM",
    authDomain: "pos-system-ef6ee.firebaseapp.com",
    projectId: "pos-system-ef6ee",
    storageBucket: "pos-system-ef6ee.firebasestorage.app",
    messagingSenderId: "1090528334356",
    appId: "1:1090528334356:web:ef7bddb8fe623427538d01"
};

// Inisialisasi Firebase Core
export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);

// Inisialisasi Firestore dengan Cache Offline Modern (Pencegah Error Offline)
export const db = initializeFirestore(app, {
    localCache: persistentLocalCache({
        tabManager: persistentMultipleTabManager()
    })
});

// Inisialisasi Koleksi Tabel
export const itemsRef = collection(db, "barang");
export const salesRef = collection(db, "penjualan");
export const shiftsRef = collection(db, "shift");
export const membersRef = collection(db, "members");
export const auditLogsRef = collection(db, "audit_logs");