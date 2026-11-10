// 訪問記録：ログインとFirestoreのやり取り
// 画面の組み立ては index.html の中。ここは「ログイン」「購読」「送信」だけを受け持つ
import { initializeApp } from "https://www.gstatic.com/firebasejs/13.1.0/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, onAuthStateChanged, signOut }
  from "https://www.gstatic.com/firebasejs/13.1.0/firebase-auth.js";
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager, collection, doc, query, where,
  onSnapshot, getDocs, getDocsFromServer, getDocFromServer, writeBatch, terminate, clearIndexedDbPersistence }
  from "https://www.gstatic.com/firebasejs/13.1.0/firebase-firestore.js";

// Firebaseの設定（秘密の値ではありません。ログインの入口の名前です）
const firebaseConfig = {
  apiKey: "AIzaSyBpe9xnDzVZtmE-PxL9rcixZoUFGGYO9Bs",
  authDomain: "houmon-app-abc54.firebaseapp.com",
  projectId: "houmon-app-abc54",
  appId: "1:239454118010:web:2f86a624e03cccb5039bc3",
};
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
// 永続キャッシュ：読んだデータと、まだ送れていない変更を端末（IndexedDB）に残す
const db = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });

const $ = id => document.getElementById(id);
const W = window;
let ready = false, started = false, loggingOut = false;
const unsubs = [];
const months = new Map();      // monthKey → 最初のデータが届いたら解決する Promise
const histories = new Map();     // 患者ID → 読み込みの Promise（true＝サーバーから全部読めた）
const histDone = new Set();       // 全記録を読み終えた患者ID

function setScreen(state, msg, { button = false, outButton = false, err = '' } = {}) {
  document.body.dataset.auth = state;
  if (state === 'in') return;
  $('loginMsg').textContent = msg;
  $('loginBtn').style.display = button ? '' : 'none';
  $('loginOutBtn').style.display = outButton ? '' : 'none';
  $('loginErr').textContent = err;
}

function onErr(e) {
  console.error(e);
  if (e.code === 'permission-denied') {
    ready = false;
    setScreen('out', `このアカウント（${auth.currentUser?.email || '不明'}）では使えません。`, { outButton: true });
  } else W.toast?.(`読み込みでエラー：${e.code || e.message}`);
}

function watchMonth(mk) {
  if (months.has(mk)) return months.get(mk);
  const p = new Promise(res => {
    unsubs.push(onSnapshot(query(collection(db, 'visits'), where('monthKey', '==', mk)), { includeMetadataChanges: true }, snap => {
      W.syncVisits(mk, snap.docChanges({ includeMetadataChanges: true }).map(ch => ({
        type: ch.type, id: ch.doc.id, data: ch.type === 'removed' ? null : ch.doc.data(), pending: ch.doc.metadata.hasPendingWrites,
      })));
      res();
    }, e => { onErr(e); res(); }));
  });
  months.set(mk, p);
  return p;
}

const timeout = (ms) => new Promise(res => setTimeout(res, ms));

async function startData() {
  if (started) return;
  started = true;
  setScreen('loading', 'データを読み込んでいます…');
  const first = [];
  first.push(new Promise(res => unsubs.push(onSnapshot(collection(db, 'patients'), { includeMetadataChanges: true }, snap => {
    W.syncPatients(snap.docs.map(d => ({ id: d.id, data: d.data(), pending: d.metadata.hasPendingWrites })));
    res();
  }, e => { onErr(e); res(); }))));
  first.push(new Promise(res => unsubs.push(onSnapshot(doc(db, 'master', 'main'), { includeMetadataChanges: true }, snap => {
    W.syncMaster(snap.exists(), snap.exists() ? snap.data() : null, snap.metadata.fromCache, snap.metadata.hasPendingWrites);
    res();
  }, e => { onErr(e); res(); }))));
  for (const mk of W.neededMonths()) first.push(watchMonth(mk));
  // 電波が弱い時に待ちすぎないよう、10秒で先へ進む（届いたら自動で画面が更新される）
  await Promise.race([Promise.all(first), timeout(10000)]);
  if (document.body.dataset.auth !== 'loading') return;   // 権限エラーなどで止まった
  W.ensureMaster();
  ready = true;
  setScreen('in');
  W.appStart();
}

onAuthStateChanged(auth, user => {
  if (loggingOut) return;
  if (user) { startData(); return; }
  if (started) { location.reload(); return; }   // 途中でログインが切れた：画面のデータを残さない
  setScreen('out', 'ログインしてください', { button: true });
});

W.DB = {
  ready: () => ready,
  email: () => auth.currentUser?.email || '',
  async login() {
    $('loginErr').textContent = '';
    try { await signInWithPopup(auth, new GoogleAuthProvider()); }
    catch (e) {
      if (e.code === 'auth/popup-closed-by-user' || e.code === 'auth/cancelled-popup-request') return;
      $('loginErr').textContent = `ログインできませんでした。この画面を写真に撮って送ってください。\n${e.code || ''} ${e.message || e}`;
    }
  },
  // ログアウト：この端末に残したデータも消す（未送信があれば止める）
  async logout() {
    if (ready && W.pendingCount()) {
      alert('まだ送れていない変更があります。\n電波のある所で、上の印が「✓ 送信済み」になってからログアウトしてください。');
      return;
    }
    if (!confirm('ログアウトしますか？\nこの端末に残したデータも消します（送信済みのデータはFirebaseに残ります）。')) return;
    loggingOut = true;
    unsubs.forEach(u => u());
    try { await terminate(db); await clearIndexedDbPersistence(db); }
    catch (e) { console.warn('cache clear', e); }
    try { await signOut(auth); } catch (e) { console.warn(e); }
    location.reload();
  },
  ensureMonths(list) { return Promise.all(list.map(watchMonth)); },
  histLoaded: pid => histDone.has(pid),
  // その患者の全記録を読む（1回の起動で1度だけ）。サーバーから全部読めたら true
  loadHistory(pid) {
    if (histories.has(pid)) return histories.get(pid);
    const p = getDocs(query(collection(db, 'visits'), where('pid', '==', pid))).then(snap => {
      W.syncHistory(snap.docs.map(d => ({ id: d.id, data: d.data() })));
      if (snap.metadata.fromCache) histories.delete(pid);   // 電波なし：次に開いた時に読み直す
      else histDone.add(pid);
      W.scheduleRender();
      return !snap.metadata.fromCache;
    }, e => { console.warn(e); histories.delete(pid); return false; });
    histories.set(pid, p);
    return p;
  },
  // 送信：まとめて1回で（450件ずつ）。電波がなければ端末に残り、つながったら送られる
  write(ops) {
    for (let i = 0; i < ops.length; i += 450) {
      const chunk = ops.slice(i, i + 450), b = writeBatch(db);
      for (const o of chunk) { const r = doc(db, o.col, o.id); if (o.del) b.delete(r); else b.set(r, o.data); }
      const keys = chunk.map(o => `${o.col}/${o.id}`);
      W.markInflight(keys, 1);
      b.commit().catch(e => {
        console.error(e);
        alert(`送信できませんでした（${e.code || e.message}）。\nこの画面を写真に撮って送ってください。`);
      }).finally(() => { W.markInflight(keys, -1); W.scheduleRender(); });
    }
  },
  // テストデータ（患者IDが9で始まる）を探す。サーバーに聞くので電波が要る
  async findTest() {
    const [ps, vs] = await Promise.all([
      getDocsFromServer(query(collection(db, 'patients'), where('id', '>=', '9'), where('id', '<', ':'))),
      getDocsFromServer(query(collection(db, 'visits'), where('pid', '>=', '9'), where('pid', '<', ':'))),
    ]);
    return { patients: ps.docs.map(d => d.id), visits: vs.docs.map(d => d.id) };
  },
  // バックアップ用：全データをサーバーから読む
  async fetchAll() {
    const [ps, vs, m] = await Promise.all([
      getDocsFromServer(collection(db, 'patients')),
      getDocsFromServer(collection(db, 'visits')),
      getDocFromServer(doc(db, 'master', 'main')),
    ]);
    const visits = {};
    for (const d of vs.docs) visits[d.id] = W.cleanObj(d.data());
    return { patients: ps.docs.map(d => W.cleanObj(d.data())), visits, master: m.exists() ? W.cleanObj(m.data()) : W.defaultMaster() };
  },
};
