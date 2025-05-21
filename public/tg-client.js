// tg-client.js

async function sendNotificationToServer(message) {
  try {
    await fetch('/api/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message })
    });
  } catch (e) {
    // En prod on ne loggue plus
    console.error('Notification error:', e);
  }
}

window.sendNotificationToServer = sendNotificationToServer;