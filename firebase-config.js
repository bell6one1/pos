import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getFirestore, collection, enableIndexedDbPersistence } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";

const firebaseConfig = {
    apiKey: "AIzaSyAsLKh24L8KxN8vqUgLQujmrfeVzc0F9YM",
    authDomain: "pos-system-ef6ee.firebaseapp.com",
    projectId: "pos-system-ef6ee",
    storageBucket: "pos-system-ef6ee.firebasestorage.app",
    messagingSenderId: "1090528334356",
    appId: "1:1090528334356:web:ef7bddb8fe623427538d01"
};

export const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);

enableIndexedDbPersistence(db).catch((err) => {
    if (err.code == 'failed-precondition') {
        console.warn("Persistence gagal: Beberapa tab terbuka sekaligus.");
    } else if (err.code == 'unimplemented') {
        console.warn("Browser tidak mendukung offline persistence.");
    }
});

export const itemsRef = collection(db, "barang");
export const salesRef = collection(db, "penjualan");
export const shiftsRef = collection(db, "shift");
export const membersRef = collection(db, "members");
export const auditLogsRef = collection(db, "audit_logs");