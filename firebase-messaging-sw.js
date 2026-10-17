importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyCTKpx5ozSXtln0TmjNbzLrCYCoxRn8RnI",
  authDomain: "the-pub---gc.firebaseapp.com",
  projectId: "the-pub---gc",
  storageBucket: "the-pub---gc.firebasestorage.app",
  messagingSenderId: "862303550078",
  appId: "1:862303550078:web:54a2f29a3cf5ab5d56f62f"
});
const messaging = firebase.messaging();

// Shows the notification when the app is closed or in the background
messaging.onBackgroundMessage(payload => {
  const d = payload.data || {};
  const isCall = d.type === 'call';
  return self.registration.showNotification(d.title || 'Study Study', {
    body: d.body || '',
    tag: d.tag || 'msg',
    renotify: true,
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    vibrate: isCall ? [500, 250, 500, 250, 500, 250, 500] : [120],
    requireInteraction: isCall,
    actions: isCall
      ? [{ action: 'answer', title: '📞 Answer' }, { action: 'decline', title: '✕ Decline' }]
      : [{ action: 'reply', title: 'Reply' }],
    data: { fid: d.fid || '', callId: d.callId || '', type: d.type || '' }
  });
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const { fid = '', callId = '', type = '' } = e.notification.data || {};
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    // Decline: tell the app (if it is open) so the caller is told straight away
    if (e.action === 'decline') {
      for (const c of list) c.postMessage({ declineCall: { fid, callId } });
      return;
    }
    // Answer: open the app and pick up the call
    if (e.action === 'answer' && fid && callId) {
      for (const c of list) { if ('focus' in c) { c.postMessage({ answerCall: { fid, callId } }); return c.focus(); } }
      return clients.openWindow('./?answer=' + fid + '~' + callId);
    }
    // Plain tap / Reply: open the chat
    for (const c of list) { if ('focus' in c) { if (fid) c.postMessage({ openChat: fid }); return c.focus(); } }
    return clients.openWindow('./' + (fid ? '?chat=' + fid : ''));
  }));
});
